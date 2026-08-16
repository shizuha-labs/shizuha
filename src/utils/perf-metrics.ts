/**
 * Per-turn performance metrics (SCLI-21): TTFT, decode rate, token + cache
 * accounting. The foundational measurement primitive consumed by the
 * SCLI-2.2 watchdog, the SCLI-3.3 perf gate, and SCLI-4 benches.
 *
 * Measured at the stream CONSUMER (agent/turn.ts) so every provider is
 * covered by one instrumentation point; providers only contribute their
 * usage fields (cache tokens where supported).
 */

export interface TurnPerfMetrics {
  provider: string;
  model: string;
  /** ms from request start to the first content/tool/reasoning chunk; null if no chunk arrived. */
  ttftMs: number | null;
  /** output tokens per second over the decode window (first chunk → stream end); null when unmeasurable. */
  decodeTokensPerSec: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  /** cacheRead / (cacheRead + cacheCreation + uncached input); null when the provider reports no cache fields. */
  cacheHitRate?: number | null;
  totalDurationMs: number;
}

/** Default TTFT warn threshold; override with SHIZUHA_TTFT_WARN_MS. */
export const DEFAULT_TTFT_WARN_MS = 30_000;

export function ttftWarnThresholdMs(): number {
  const raw = process.env['SHIZUHA_TTFT_WARN_MS'];
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTFT_WARN_MS;
}

export interface PerfTimerSnapshot {
  startedAt: number;
  firstChunkAt: number | null;
  endedAt: number | null;
}

/** Minimal turn timer: start → markFirstChunk (idempotent) → finish(usage). */
export class PerfTimer {
  private startedAt: number;
  private firstChunkAt: number | null = null;
  private endedAt: number | null = null;

  constructor(now: number = Date.now()) {
    this.startedAt = now;
  }

  markFirstChunk(now: number = Date.now()): void {
    if (this.firstChunkAt === null) this.firstChunkAt = now;
  }

  finish(
    info: {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens?: number;
      cacheReadTokens?: number;
    },
    now: number = Date.now(),
  ): TurnPerfMetrics {
    this.endedAt = now;
    const ttftMs = this.firstChunkAt !== null ? this.firstChunkAt - this.startedAt : null;
    let decodeTokensPerSec: number | null = null;
    if (this.firstChunkAt !== null && info.outputTokens > 0) {
      const decodeMs = this.endedAt - this.firstChunkAt;
      // Sub-100ms decode windows produce absurd rates from rounding; treat
      // the whole stream as the window in that case.
      const windowMs = decodeMs >= 100 ? decodeMs : this.endedAt - this.startedAt;
      if (windowMs > 0) decodeTokensPerSec = Math.round((info.outputTokens / windowMs) * 1000);
    }
    let cacheHitRate: number | null = null;
    if (info.cacheReadTokens != null || info.cacheCreationTokens != null) {
      const read = info.cacheReadTokens ?? 0;
      // P2: include cache WRITES in the denominator. Providers forward
      // cacheCreationTokens separately from inputTokens, so on a turn that both
      // reads from and writes to the prompt cache the newly-created tokens are
      // neither hits nor counted as misses — omitting them overstates the rate.
      // Denominator = total prompt tokens = reads + creates + regular input.
      const creation = info.cacheCreationTokens ?? 0;
      const denominator = read + creation + Math.max(info.inputTokens, 0);
      cacheHitRate = denominator > 0 ? Math.round((read / denominator) * 1000) / 1000 : null;
    }
    return {
      provider: info.provider,
      model: info.model,
      ttftMs,
      decodeTokensPerSec,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      ...(info.cacheCreationTokens != null ? { cacheCreationTokens: info.cacheCreationTokens } : {}),
      ...(info.cacheReadTokens != null ? { cacheReadTokens: info.cacheReadTokens } : {}),
      cacheHitRate,
      totalDurationMs: this.endedAt - this.startedAt,
    };
  }

  snapshot(): PerfTimerSnapshot {
    return { startedAt: this.startedAt, firstChunkAt: this.firstChunkAt, endedAt: this.endedAt };
  }
}

/** `TTFT 1.2s · 38 tok/s` — the status-line fragment (empty when unmeasured). */
export function formatPerfStatus(m: TurnPerfMetrics): string {
  const parts: string[] = [];
  if (m.ttftMs !== null) parts.push(`TTFT ${(m.ttftMs / 1000).toFixed(1)}s`);
  if (m.decodeTokensPerSec !== null) parts.push(`${m.decodeTokensPerSec} tok/s`);
  if (m.cacheHitRate != null) parts.push(`cache ${(m.cacheHitRate * 100).toFixed(0)}%`);
  return parts.join(' · ');
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${Math.max(0, Math.round(tokens))}`;
}

/** Live status-line fragment: `in ~3.4k · out ~210 · 14 tok/s`. */
export function formatTokenProgressStatus(info: {
  inputTokens: number;
  outputTokens: number;
  outputTokensPerSec: number | null;
  estimated: boolean;
}): string {
  const prefix = info.estimated ? '~' : '';
  const parts = [
    `in ${prefix}${formatTokenCount(info.inputTokens)}`,
    `out ${prefix}${formatTokenCount(info.outputTokens)}`,
  ];
  if (info.outputTokensPerSec !== null) parts.push(`${info.outputTokensPerSec} tok/s`);
  return parts.join(' · ');
}
