import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface PersistedRuntimeLaneFence {
  generation: number;
  digest: string;
  changeId: string;
}

export function runtimeLaneFenceStatePath(): string | null {
  const explicit = process.env['SHIZUHA_RUNTIME_LANE_FENCE_STATE_FILE']?.trim();
  if (explicit) return explicit;
  if (process.env.NODE_ENV === 'test') return null;
  return path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'runtime-lane-fences.json');
}

export function readRuntimeLaneFences(
  statePath: string | null,
): Map<string, PersistedRuntimeLaneFence> {
  const fences = new Map<string, PersistedRuntimeLaneFence>();
  if (!statePath) return fences;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    for (const [agentId, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const value = raw as Record<string, unknown>;
      const generation = Number(value.generation);
      const digest = String(value.digest ?? '').toLowerCase();
      if (!agentId || !Number.isInteger(generation) || generation <= 0 || !/^[a-f0-9]{64}$/.test(digest)) continue;
      fences.set(agentId, {
        generation,
        digest,
        changeId: String(value.changeId ?? ''),
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`runtime_lane_fence_state_read_failed: ${(error as Error).message}`);
    }
  }
  return fences;
}

export function writeRuntimeLaneFences(
  statePath: string | null,
  fences: ReadonlyMap<string, PersistedRuntimeLaneFence>,
): void {
  if (!statePath) return;
  const temporary = `${statePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    const payload = Object.fromEntries(
      [...fences.entries()].sort(([a], [b]) => a.localeCompare(b)),
    );
    fs.writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, statePath);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
    throw new Error(`runtime_lane_fence_state_write_failed: ${(error as Error).message}`);
  }
}
