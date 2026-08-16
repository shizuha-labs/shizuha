import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  PersistedRuntimeRollDeferral,
  PersistedRuntimeRollDeferrals,
} from './runtime-roll-deferral.js';

export interface HarnessRollState {
  desiredImage: string;
  lastRollAt: number;
  inFlightAgentIds: string[];
  driftSince: Record<string, number>;
  deferrals: PersistedRuntimeRollDeferrals;
}

const DEFERRAL_REASONS = new Set(['bridge-busy', 'probe-failed']);
const DEFERRAL_PROTOCOLS = new Set(['drain-v1', 'legacy-health', 'unknown']);

function validDeferral(value: unknown): value is PersistedRuntimeRollDeferral {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedRuntimeRollDeferral>;
  return Number.isFinite(candidate.since)
    && typeof candidate.agent === 'string'
    && candidate.agent.length > 0
    && DEFERRAL_REASONS.has(candidate.reason ?? '')
    && DEFERRAL_PROTOCOLS.has(candidate.protocol ?? '')
    && typeof candidate.alerted === 'boolean';
}

export function harnessRollStatePath(): string | null {
  const explicit = process.env['SHIZUHA_HARNESS_ROLL_STATE_FILE']?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === 'test') return null;
  return path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'harness-roll-state.json');
}

export function readHarnessRollState(
  statePath: string | null,
  desiredImage: string,
): HarnessRollState | undefined {
  if (!statePath) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<HarnessRollState>;
    const previousDesiredImage = typeof parsed.desiredImage === 'string'
      ? parsed.desiredImage
      : '';
    if (!previousDesiredImage) return undefined;
    const targetChanged = previousDesiredImage !== desiredImage;
    const previousTargetSuffix = `\0${previousDesiredImage}`;
    const driftSince = Object.fromEntries(
      Object.entries(parsed.driftSince ?? {}).flatMap(([key, value]) => {
        if (!key.endsWith(previousTargetSuffix) || !Number.isFinite(value)) return [];
        if (!targetChanged) return [[key, value]];
        const agentId = key.slice(0, -previousTargetSuffix.length);
        return agentId ? [[`${agentId}\0${desiredImage}`, value]] : [];
      }),
    );
    const deferrals = Object.fromEntries(
      Object.entries(parsed.deferrals ?? {}).flatMap(([key, value]) => {
        if (!key.endsWith(previousTargetSuffix) || !validDeferral(value)) return [];
        if (!targetChanged) return [[key, value]];
        const agentId = key.slice(0, -previousTargetSuffix.length);
        return agentId ? [[`${agentId}\0${desiredImage}`, value]] : [];
      }),
    );
    return {
      desiredImage,
      lastRollAt: Number.isFinite(parsed.lastRollAt) ? Math.max(0, parsed.lastRollAt ?? 0) : 0,
      // A bridge drain is fenced to its exact target image. Never restore that
      // reservation after Hive advances the target; the controller must obtain
      // a fresh live bridge proof for the successor.
      inFlightAgentIds: !targetChanged && Array.isArray(parsed.inFlightAgentIds)
        ? parsed.inFlightAgentIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [],
      // A still-drifted tail does not become young merely because a newer safe
      // image supersedes the previous target. Carry its first-observed time to
      // the new target so active agents remain eligible for live bridge probes.
      driftSince,
      // A superseding image must not buy a continuously deferred tail a fresh
      // silent window. The next live probe refreshes the bounded labels.
      deferrals,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[daemon][runtime-roll] could not read roll state: ${(error as Error).message}`);
    }
    return undefined;
  }
}

export function writeHarnessRollState(
  statePath: string | null,
  state: HarnessRollState,
): void {
  if (!statePath) return;
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, statePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    console.warn(`[daemon][runtime-roll] could not persist roll state: ${(error as Error).message}`);
  }
}
