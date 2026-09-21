/**
 * Container memory watchdog (SCS-139 class).
 *
 * The kernel OOM-kills the agent container with zero in-process trail when the
 * cgroup working set reaches the limit. The pod is deleted on rollout, so the
 * memory timeline is unrecoverable after the fact (verified 2026-08-31: two
 * agent-kai OOMKills at the 8Gi agent-container limit, no data on what grew —
 * every in-process accumulator audited bounded: session 90KB post-compaction,
 * foreground bash output 30K chars, background task output 100KB, mcp-proxies
 * fixed-count with no accumulation).
 *
 * This watchdog samples the container's cgroup memory every interval and:
 *   - logs an escalating trail (warn at 80%, error at 90%) so the next
 *     incident leaves a data trail instead of a deleted pod;
 *   - when usage stays ≥ the exit watermark across consecutive samples
 *     (transient spikes like a large `docker cp` do not trigger it), exits
 *     cleanly so the supervisor restarts the pod at a chosen point — with the
 *     eternal session safely persisted in SQLite — instead of the kernel
 *     killing the process mid-write.
 *
 * Disable with SHIZUHA_MEMORY_WATCHDOG=0. Tune with
 * SHIZUHA_MEMORY_WATCHDOG_INTERVAL_MS / _WARN_AT / _EXIT_AT / _EXIT_SAMPLES.
 */

import { readFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';

const CGROUP_V2_CURRENT = '/sys/fs/cgroup/memory.current';
const CGROUP_V2_MAX = '/sys/fs/cgroup/memory.max';
const CGROUP_V1_CURRENT = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
const CGROUP_V1_MAX = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_WARN_AT = 0.8;
const DEFAULT_EXIT_AT = 0.9;
const DEFAULT_EXIT_SAMPLES = 3;

function readNum(file: string): number | null {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    if (raw === 'max' || raw === '') return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Current cgroup memory usage/limit in bytes, trying cgroup v2 then v1. */
export function readCgroupMemory(): { current: number; limit: number } | null {
  // cgroup v2 (unified hierarchy)
  const v2Current = readNum(CGROUP_V2_CURRENT);
  if (v2Current !== null) {
    const v2Max = readNum(CGROUP_V2_MAX);
    if (v2Max !== null) return { current: v2Current, limit: v2Max };
  }
  // cgroup v1 fallback
  const v1Current = readNum(CGROUP_V1_CURRENT);
  const v1Max = readNum(CGROUP_V1_MAX);
  if (v1Current !== null && v1Max !== null && v1Max < Number.MAX_SAFE_INTEGER) {
    return { current: v1Current, limit: v1Max };
  }
  return null;
}

export interface MemoryWatchdogHandle {
  stop(): void;
}

export function startMemoryWatchdog(): MemoryWatchdogHandle | null {
  if (process.env['SHIZUHA_MEMORY_WATCHDOG'] === '0') return null;

  const intervalMs = Number(process.env['SHIZUHA_MEMORY_WATCHDOG_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const warnAt = Number(process.env['SHIZUHA_MEMORY_WATCHDOG_WARN_AT'] ?? DEFAULT_WARN_AT);
  const exitAt = Number(process.env['SHIZUHA_MEMORY_WATCHDOG_EXIT_AT'] ?? DEFAULT_EXIT_AT);
  const exitSamples = Number(process.env['SHIZUHA_MEMORY_WATCHDOG_EXIT_SAMPLES'] ?? DEFAULT_EXIT_SAMPLES) || DEFAULT_EXIT_SAMPLES;

  let criticalStreak = 0;
  let lastWarnRatio = 0;

  const sample = (): void => {
    const cgroup = readCgroupMemory();
    if (!cgroup) return; // not cgroup-limited (dev machine) — nothing to watch
    const ratio = cgroup.current / cgroup.limit;
    const heap = process.memoryUsage();

    if (ratio >= exitAt) {
      criticalStreak += 1;
      logger.error(
        {
          cgroupCurrentBytes: cgroup.current,
          cgroupLimitBytes: cgroup.limit,
          ratio: Number(ratio.toFixed(3)),
          criticalStreak,
          rssBytes: heap.rss,
          heapUsedBytes: heap.heapUsed,
          externalBytes: heap.external,
          arrayBuffersBytes: heap.arrayBuffers,
        },
        `[memory-watchdog] cgroup memory critical (${(ratio * 100).toFixed(1)}% of limit, streak ${criticalStreak}/${exitSamples})`,
      );
      if (criticalStreak >= exitSamples) {
        logger.error(
          { cgroupCurrentBytes: cgroup.current, cgroupLimitBytes: cgroup.limit, ratio: Number(ratio.toFixed(3)) },
          '[memory-watchdog] sustained critical memory — exiting cleanly so the supervisor restarts the pod before the kernel OOM-kills us mid-write (eternal session is persisted in SQLite and will resume)',
        );
        // Give the logger a tick to flush, then exit. The container restart
        // policy brings the pod back; the eternal session reloads from SQLite.
        setTimeout(() => process.exit(0), 100).unref();
      }
      return;
    }

    criticalStreak = 0;
    if (ratio >= warnAt) {
      // Log each new 5% band climbed (80, 85, 90…) rather than every sample,
      // so the trail is readable without spamming at steady high usage.
      const band = Math.floor(ratio * 20) / 20;
      if (band > lastWarnRatio) {
        lastWarnRatio = band;
        logger.warn(
          {
            cgroupCurrentBytes: cgroup.current,
            cgroupLimitBytes: cgroup.limit,
            ratio: Number(ratio.toFixed(3)),
            rssBytes: heap.rss,
            heapUsedBytes: heap.heapUsed,
          },
          `[memory-watchdog] cgroup memory at ${(ratio * 100).toFixed(1)}% of limit`,
        );
      }
    } else {
      lastWarnRatio = 0;
    }
  };

  const timer = setInterval(sample, intervalMs);
  if (timer.unref) timer.unref();
  // First sample immediately so a restarted pod logs its baseline.
  sample();
  logger.info({ intervalMs, warnAt, exitAt, exitSamples }, 'Memory watchdog enabled');
  return { stop: () => clearInterval(timer) };
}
