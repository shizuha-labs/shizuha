/**
 * SCLI-33: Auto-file a deduped Pulse bug when the struggle analyzer (SCLI-32) fires.
 *
 * Triggered by StruggleEvent — heuristic-only path, no LLM involved.
 * Files directly via the Pulse REST API (not MCP tools) so it works in any
 * runtime context (loop, gateway, exec) without an active agent turn.
 *
 * Dedup key: title prefix `[Struggle/KIND] run:XXXX` (first 8 chars of runId).
 * If an open task with that prefix already exists, filing is skipped.
 */

import type { StruggleEvent } from '../events/types.js';
import { logger } from '../utils/logger.js';

export interface AutoFilerConfig {
  /**
   * Pulse internal base URL. Defaults to PULSE_INTERNAL_URL env var,
   * then falls back to http://shizuha-pulse:8002.
   */
  pulseBaseUrl?: string;
  /** Bearer token for Pulse REST API. Defaults to PULSE_SERVICE_TOKEN env var. */
  serviceToken?: string;
  /** Workflow slug to file under. Default: 'autonomous-bug'. */
  workflow?: string;
  /**
   * Project key used in dedup-search title prefixes and display only.
   * NOT sent to the REST API — the API expects a numeric FK PK (`projectId`).
   * Default: 'SCLI'.
   */
  projectKey?: string;
  /**
   * Numeric project PK for the Pulse REST API `project` ForeignKey field.
   * Defaults to PULSE_PROJECT_ID env var (parsed as int).
   * When absent the `project` field is omitted from the POST body entirely.
   */
  projectId?: number;
}

interface ResolvedConfig {
  pulseBaseUrl: string;
  serviceToken: string;
  workflow: string;
  projectKey: string;
  projectId: number | undefined;
}

function resolveConfig(cfg: AutoFilerConfig): ResolvedConfig {
  const rawId = cfg.projectId ?? parseInt(process.env['PULSE_PROJECT_ID'] ?? '', 10);
  return {
    pulseBaseUrl:
      cfg.pulseBaseUrl ??
      process.env['PULSE_INTERNAL_URL'] ??
      'http://shizuha-pulse:8002',
    serviceToken: cfg.serviceToken ?? process.env['PULSE_SERVICE_TOKEN'] ?? '',
    workflow: cfg.workflow ?? 'autonomous-bug',
    projectKey: cfg.projectKey ?? process.env['PULSE_PROJECT_KEY'] ?? 'SCLI',
    projectId: Number.isFinite(rawId) && rawId > 0 ? rawId : undefined,
  };
}

/** Maps struggle kind to Pulse priority. */
const KIND_PRIORITY: Record<StruggleEvent['kind'], string> = {
  STALL: 'high',
  THRASH: 'high',
  ERROR_DENSITY: 'normal',
  LONG_RUN: 'normal',
};

function dedupTitle(event: StruggleEvent): string {
  // Telemetry runIds are `<session.id>#<per-run-suffix>`; the suffix is what
  // differs across separate runs RESUMED in the same session. Keying the dedup
  // prefix off the whole id's first 8 chars grabbed the shared session prefix and
  // collapsed those distinct runs into one bug (review P2-5). Use the run-unique
  // suffix (after the last '#'); plain runIds with no '#' fall back to the whole.
  const runId = event.runId || '';
  const hash = runId.lastIndexOf('#');
  const runKey = hash >= 0 ? runId.slice(hash + 1) : runId;
  return `[Struggle/${event.kind}] run:${runKey}`;
}

function buildDescription(event: StruggleEvent): string {
  const { windowSummary: w } = event;
  return [
    `**Auto-filed by SCLI-33 struggle auto-filer** (heuristic, no LLM).`,
    ``,
    `- **Run ID**: \`${event.runId}\``,
    event.agent ? `- **Agent**: ${event.agent}` : null,
    `- **Kind**: ${event.kind}`,
    `- **Detected at**: ${new Date(event.timestamp).toISOString()}`,
    ``,
    `**Diagnosis**: ${event.diagnosis}`,
    ``,
    `**Window summary** (${w.turnsAnalyzed} turns):`,
    `- Error rate: ${(w.errorRate * 100).toFixed(1)}%`,
    `- No-op rate: ${(w.noOpRate * 100).toFixed(1)}%`,
    `- Avg turn duration: ${w.avgTurnMs.toFixed(0)} ms`,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Search Pulse for open tasks whose title contains the dedup prefix.
 * Returns true if a duplicate already exists.
 */
async function isDuplicate(
  prefix: string,
  cfg: ResolvedConfig,
): Promise<boolean> {
  const url = `${cfg.pulseBaseUrl}/api/items/?search=${encodeURIComponent(prefix)}&page_size=5`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.serviceToken}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return false;
    const data = (await resp.json()) as { results?: Array<{ title: string; status?: string }> };
    const results = data.results ?? [];
    const TERMINAL = new Set(['completed', 'cancelled', 'done', 'resolved', 'rejected', 'duplicate', 'wont_fix']);
    return results.some(
      (t) => t.title.includes(prefix) && !TERMINAL.has(t.status ?? ''),
    );
  } catch {
    return false;
  }
}

/**
 * File a new Pulse bug for the struggle event.
 * Returns the created task key on success, null on failure.
 */
async function fileBug(event: StruggleEvent, cfg: ResolvedConfig): Promise<string | null> {
  const title = `${dedupTitle(event)} — ${event.diagnosis.slice(0, 80)}`;
  // `project` is a ForeignKey (PrimaryKeyRelatedField) — must be a numeric PK.
  // Sending a string key (e.g. 'SCLI') returns 400 "Expected pk value, received str".
  const body: Record<string, unknown> = {
    title,
    description: buildDescription(event),
    priority: KIND_PRIORITY[event.kind],
    workflow_name: cfg.workflow,
    source: 'scli-33-struggle-auto-filer',
    source_id: `struggle:${event.runId}:${event.kind}:${event.timestamp}`,
  };
  if (cfg.projectId !== undefined) {
    body['project'] = cfg.projectId;
  }

  try {
    const resp = await fetch(`${cfg.pulseBaseUrl}/api/tasks/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.serviceToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.warn({ status: resp.status, body: text.slice(0, 200) }, 'SCLI-33: Pulse filing failed');
      return null;
    }
    const data = (await resp.json()) as { item_key?: string };
    return data.item_key ?? null;
  } catch (err) {
    logger.warn({ err }, 'SCLI-33: Pulse filing error (non-fatal)');
    return null;
  }
}

/**
 * Handle a StruggleEvent: dedup-check then file a Pulse bug.
 * Best-effort — never throws; caller must not await in the hot path.
 */
export async function handleStruggleEvent(
  event: StruggleEvent,
  config: AutoFilerConfig = {},
): Promise<void> {
  const cfg = resolveConfig(config);
  if (!cfg.serviceToken) {
    logger.debug('SCLI-33: PULSE_SERVICE_TOKEN not set — skipping auto-file');
    return;
  }

  const prefix = dedupTitle(event);

  try {
    const alreadyFiled = await isDuplicate(prefix, cfg);
    if (alreadyFiled) {
      logger.debug({ prefix }, 'SCLI-33: duplicate found — skipping');
      return;
    }

    const key = await fileBug(event, cfg);
    if (key) {
      logger.info({ key, kind: event.kind, runId: event.runId }, 'SCLI-33: struggle bug filed');
    }
  } catch (err) {
    logger.warn({ err }, 'SCLI-33: unexpected error in handleStruggleEvent (non-fatal)');
  }
}

/**
 * Wire the auto-filer to an AgentEventEmitter.
 * The emitter must support `.on(eventType, handler)`.
 * Call once per agent-process setup — returns an unsubscribe function.
 *
 * Usage (called by the loop/exec consumers — SCLI-32):
 *   const { unsub, flush } = setupStrugglePulseAutoFiler(emitter, { workflow: 'autonomous-bug' });
 *   // ... at run teardown, before process.exit in -p/exec mode ...
 *   await flush();   // drain in-flight filings so a final-turn bug isn't lost
 *   unsub();
 *
 * Filing stays fire-and-forget in the hot path (never awaited per turn); `flush`
 * exposes the in-flight set so a caller that is about to exit can drain them.
 */
export function setupStrugglePulseAutoFiler(
  emitter: { on: (event: string, handler: (e: unknown) => void) => () => void },
  config: AutoFilerConfig = {},
): { unsub: () => void; flush: () => Promise<void> } {
  const pending = new Set<Promise<void>>();
  const unsub = emitter.on('struggle', (event: unknown) => {
    const ev = event as StruggleEvent;
    const p = handleStruggleEvent(ev, config).catch(() => {/* best-effort */});
    pending.add(p);
    void p.finally(() => pending.delete(p));
  });
  return {
    unsub,
    flush: async () => { await Promise.allSettled([...pending]); },
  };
}
