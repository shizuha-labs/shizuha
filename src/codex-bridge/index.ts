/**
 * Codex Bridge — persistent `codex --app-server` process bridged to the gateway protocol.
 *
 * Architecture:
 *   1. Spawns a persistent `codex --app-server` process (stdio JSON-RPC)
 *   2. Performs initialize handshake → thread/start to create a session
 *   3. For each user message, sends `turn/start` with the message
 *   4. Streams server notifications (content, tool events) → dashboard WS protocol
 *
 * The app-server maintains conversation history internally — no need to inject
 * <conversation_history> or spawn fresh processes per message.
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCodexAccounts } from '../config/credentials.js';
import type { CodexAccountEntry } from '../config/credentials.js';
import { fetchBrokerModelToken, reportBrokerModelTokenStatus, brokerExpected, type BrokerModelToken } from '../auth/broker-token.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
// @ts-ignore — ws has no declaration file
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { StateStore } from '../state/store.js';
import { buildSyncHistoryMessages } from '../state/sync-history.js';
import { writeBaseInstructions } from '../agent-base-instructions.js';
import { assertWorkspaceDir } from '../utils/fs.js';
import { BROWSER_MCP_TOKEN_ENV, resolveBrowserMcpServer } from '../browser-mcp.js';
import { shouldEscalateEmptyTurnAsProviderFailure } from '../shared/connect-inject.js';
import {
  formatHeartbeatQueueDrainOutcomeLogLine,
  heartbeatQueueDrainTelemetry,
  recordHeartbeatQueueDrainOutcome,
  recordHeartbeatQueueDrainTurn,
} from '../shared/heartbeat-outcome.js';
import type {
  HeartbeatQueueDrainRecord,
  HeartbeatQueueDrainTurnToolCall,
  HeartbeatQueueDrainTurnToolResult,
} from '../shared/heartbeat-outcome.js';
import {
  getTurnStallReason,
  isCurrentBridgeChild,
  isLatchStuck,
  runSerializedStuckRecovery,
  type TurnStallReason,
} from '../shared/stuck-latch-recovery.js';
import {
  ActivityPhaseTracker,
  buildActivityTelemetry,
  createTelemetryFlusher,
} from '../telemetry/activity-phase.js';
import {
  isLoopbackRuntimeRollCaller,
  RuntimeRollDrainLease,
  type RuntimeRollDrainRequest,
} from '../shared/runtime-roll-drain.js';
import { PLATFORM_UNIVERSAL_SKILLS } from '../prompt/bridge-identity.js';
import { readSkillFrontmatter } from '../skills/frontmatter.js';
import { skillMatchesAudience } from '../skills/registry.js';
export { getTurnStallReason, isLatchStuck } from '../shared/stuck-latch-recovery.js';

const DEFAULT_CONTAINER_AGENT_UID = 1000;
const DEFAULT_CONTAINER_AGENT_GID = 1000;
const DEFAULT_CODEX_CORTEX_OPENAI_BASE_URL = 'http://cortex.shizuha-cortex.svc.cluster.local:8040/v1';
export const CODEX_PLATFORM_MCP_TOKEN_ENV = 'SHIZUHA_PLATFORM_MCP_TOKEN';
export const CODEX_PROVIDER_UNAVAILABLE_MARKER_ENV = 'SHIZUHA_CODEX_PROVIDER_UNAVAILABLE_MARKER';
export const CODEX_PROVIDER_RECOVERY_PROBE_MIN_AGE_ENV =
  'SHIZUHA_CODEX_PROVIDER_RECOVERY_PROBE_MIN_AGE_MS';
const DEFAULT_CODEX_PROVIDER_RECOVERY_PROBE_MIN_AGE_MS = 15 * 60 * 1000;

function readProviderUnavailableMarker(): string | null {
  const marker = process.env[CODEX_PROVIDER_UNAVAILABLE_MARKER_ENV]?.trim();
  if (!marker || !fs.existsSync(marker)) return null;
  try {
    return fs.readFileSync(marker, 'utf8').trim()
      || 'provider unavailable; supervisor backoff retry in progress';
  } catch {
    return 'provider unavailable; supervisor backoff retry in progress';
  }
}

function writeProviderUnavailableMarker(reason: string): void {
  const marker = process.env[CODEX_PROVIDER_UNAVAILABLE_MARKER_ENV]?.trim();
  if (!marker) return;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, reason, { mode: 0o600 });
  } catch { /* telemetry remains authoritative for the current process */ }
}

function clearProviderUnavailableMarker(): void {
  const marker = process.env[CODEX_PROVIDER_UNAVAILABLE_MARKER_ENV]?.trim();
  if (!marker) return;
  try { fs.unlinkSync(marker); } catch { /* missing/unwritable is best-effort */ }
}

/**
 * Sticky provider-unavailable is for **real** outages only (rate limit, auth,
 * pool exhausted). Empty-turn heuristics are flaky model/agent silence — treat
 * the agent like a human who went quiet, not a dead provider. Never persist or
 * re-arm empty-turn reasons as sticky unavailability.
 */
export function isStickyProviderOutageReason(reason: string | null | undefined): boolean {
  if (!reason?.trim()) return false;
  const r = reason.trim();
  if (/^empty-turn exhausted on\b/i.test(r)) return false;
  return /rate[_\s-]?limit|usage[_\s-]?limit|token[_\s-]?pool|pool-exhausted|quota|\b429\b|\b401\b|\b403\b|provider unavailable|supervisor backoff retry in progress/i.test(r);
}

/**
 * Legacy empty-turn sticky markers may still exist on disk from older images.
 * They are no longer authoritative outages — clear and allow work.
 */
export function shouldClearLegacyEmptyTurnMarker(reason: string | null | undefined): boolean {
  return Boolean(reason && /^empty-turn exhausted on\b/i.test(reason.trim()));
}

/**
 * A persisted **explicit** provider outage marker must remain fail-closed across
 * fast supervisor retries, but empty-turn markers are never sticky (cleared on
 * boot). For remaining sticky reasons, permit one bounded recovery heartbeat
 * only after the marker has aged through a full normal heartbeat interval.
 */
export function shouldProbePersistedProviderUnavailable(
  reason: string | null,
  markerPath = process.env[CODEX_PROVIDER_UNAVAILABLE_MARKER_ENV]?.trim() ?? '',
  nowMs = Date.now(),
  minAgeRaw = process.env[CODEX_PROVIDER_RECOVERY_PROBE_MIN_AGE_ENV],
): boolean {
  // Empty-turn markers are cleared on boot; do not probe-schedule them.
  if (!reason || shouldClearLegacyEmptyTurnMarker(reason) || !isStickyProviderOutageReason(reason)) {
    return false;
  }
  if (!markerPath) return false;
  const parsedMinAge = Number(minAgeRaw ?? DEFAULT_CODEX_PROVIDER_RECOVERY_PROBE_MIN_AGE_MS);
  const minAgeMs = Number.isFinite(parsedMinAge) && parsedMinAge >= 60_000
    ? parsedMinAge
    : DEFAULT_CODEX_PROVIDER_RECOVERY_PROBE_MIN_AGE_MS;
  try {
    return nowMs - fs.statSync(markerPath).mtimeMs >= minAgeMs;
  } catch {
    return false;
  }
}
/** Scheduler turns run inside Codex app-server, where configured MCP servers
 * are native tools. Do not prescribe the coordinator-only `functions.exec`
 * wrapper: app-server does not expose it, so the model will try to execute the
 * sample as shell/Node code and never reach Pulse. */
export const CODEX_HEARTBEAT_TRIGGER =
  '[HEARTBEAT] Automatic sync. Call the native MCP tool `mcp__shizuha-pulse__pulse_get_my_alerts` directly first, then call `mcp__shizuha-pulse__pulse_get_my_tasks` ' +
  '(do NOT invoke it through shell/Node/`functions.exec`; do NOT call `list_mcp_resources`, inspect files/env, probe HTTP, or search docs). ' +
  'This ordered alert-then-task pair is MANDATORY on every heartbeat: prior conversation context never proves the current inboxes, and ZERO output is forbidden until both unfiltered Pulse results are returned. ' +
  'This is a BOUNDED scheduler turn: after both results, work/forward the highest-priority ready item across alerts and tasks completely; alerts win ties but never preempt higher-priority task WIP. Then STOP without fetching a second item. ' +
  'The runtime immediately starts a fresh successor turn while ready work remains, so do not drain multiple task contexts here. ' +
  'If nothing is movable, stop immediately with ZERO output.';

export const CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER =
  '[HEARTBEAT RETRY] The preceding scheduler turn failed because it ended before observing Pulse. ' +
  'Call `mcp__shizuha-pulse__pulse_get_my_alerts` as your FIRST action now, then call `mcp__shizuha-pulse__pulse_get_my_tasks`. This ordered pair is mandatory even if prior context suggests an alert is resolved, a task is blocked, or CI is pending. ' +
  'After both unfiltered results: work/forward only the highest-priority ready item across alerts and tasks; alerts win ties but never preempt higher-priority task WIP. Produce ZERO output if and only if both inboxes prove nothing is movable.';

export const MAX_CODEX_HEARTBEAT_OBSERVATION_RETRIES = 1;

type PulseHeartbeatPreflightItem = {
  status?: unknown;
  due_date?: unknown;
};

type PulseHeartbeatPreflightPage = {
  count: number;
  results: PulseHeartbeatPreflightItem[];
};

type PulseHeartbeatPreflightResponse = {
  decision: unknown;
  reason: unknown;
  alert_count: unknown;
  ready_task_count: unknown;
  backlog_count: unknown;
  blocked_task_count: unknown;
  future_due_count: unknown;
  counts_are_presence_markers: unknown;
};

export type PulseHeartbeatPreflightDecision =
  | { kind: 'run'; reason: string }
  | {
      kind: 'skip';
      reason: string;
      readyTaskCount: 0;
      blockedTaskCount: number;
      futureDueCount: number;
    };

const HEARTBEAT_HOLDING_STATUSES = new Set([
  'scheduled',
  'deferred',
  'future_due',
  'not_yet_due',
]);

/**
 * Validate Pulse's dedicated bounded preflight response. Suppressing a model
 * heartbeat is a fail-closed decision: every field and reason/count invariant
 * must be readable before the bridge may return `skip`.
 */
export function parsePulseHeartbeatPreflightResponse(
  payload: unknown,
): PulseHeartbeatPreflightDecision {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Pulse heartbeat preflight returned a non-object payload');
  }
  const response = payload as PulseHeartbeatPreflightResponse;
  const decision = response.decision;
  const reason = response.reason;
  if ((decision !== 'run' && decision !== 'skip') || typeof reason !== 'string') {
    throw new Error('Pulse heartbeat preflight returned an invalid decision or reason');
  }
  if (response.counts_are_presence_markers !== true) {
    throw new Error('Pulse heartbeat preflight did not identify bounded presence markers');
  }

  const rawCounts = {
    alert: response.alert_count,
    ready: response.ready_task_count,
    backlog: response.backlog_count,
    blocked: response.blocked_task_count,
    future: response.future_due_count,
  };
  for (const [name, count] of Object.entries(rawCounts)) {
    if (count !== 0 && count !== 1) {
      throw new Error(`Pulse heartbeat preflight returned invalid ${name} presence marker`);
    }
  }
  const counts = rawCounts as Record<keyof typeof rawCounts, 0 | 1>;

  if (decision === 'run') {
    const validRun = (
      (reason === 'active_alert' && counts.alert === 1)
      || (reason === 'ready_task' && counts.ready === 1)
      || (reason === 'backlog_pull' && counts.backlog === 1)
    );
    if (!validRun) {
      throw new Error('Pulse heartbeat preflight returned an inconsistent run decision');
    }
    if (reason === 'active_alert') return { kind: 'run', reason: 'active Pulse alert' };
    if (reason === 'ready_task') return { kind: 'run', reason: 'ready Pulse task' };
    return { kind: 'run', reason: 'backlog pull item' };
  }

  if (counts.alert || counts.ready || counts.backlog) {
    throw new Error('Pulse heartbeat preflight attempted to skip runnable work');
  }
  if (reason === 'all_blocked' && counts.blocked === 1) {
    return {
      kind: 'skip',
      reason: 'blocked tasks only; no alerts, ready work, or backlog pull',
      readyTaskCount: 0,
      blockedTaskCount: 1,
      futureDueCount: counts.future,
    };
  }
  if (reason === 'future_due' && counts.future === 1 && counts.blocked === 0) {
    return {
      kind: 'skip',
      reason: 'future/holding tasks only; no alerts, ready work, or backlog pull',
      readyTaskCount: 0,
      blockedTaskCount: 0,
      futureDueCount: 1,
    };
  }
  if (reason === 'queue_empty' && counts.blocked === 0 && counts.future === 0) {
    return {
      kind: 'skip',
      reason: 'Pulse alerts, active queue, and backlog pull lane are empty',
      readyTaskCount: 0,
      blockedTaskCount: 0,
      futureDueCount: 0,
    };
  }
  throw new Error('Pulse heartbeat preflight returned an inconsistent skip decision');
}

/**
 * Decide whether a periodic heartbeat needs an LLM turn from the canonical
 * ordered Pulse preflight. Pulse's queue_order=true contract puts movable work
 * before blocked/future rows, so the first active item is sufficient to prove
 * whether any ready work exists. Backlog is a separate pull lane and therefore
 * deliberately wakes the agent when the active queue has no movable row.
 */
export function classifyPulseHeartbeatPreflight(
  alertCount: number,
  activePage: PulseHeartbeatPreflightPage,
  backlogCount: number,
  nowMs = Date.now(),
): PulseHeartbeatPreflightDecision {
  if (alertCount > 0) {
    return { kind: 'run', reason: `${alertCount} active alert(s)` };
  }

  const first = activePage.results[0];
  if (activePage.count > 0 && !first) {
    return { kind: 'run', reason: 'Pulse active queue count had no readable first item' };
  }

  if (first) {
    const status = typeof first.status === 'string'
      ? first.status.trim().toLowerCase().replace(/[\s-]+/g, '_')
      : '';
    if (!status) {
      return { kind: 'run', reason: 'Pulse active queue item had no readable status' };
    }

    const dueAt = typeof first.due_date === 'string'
      ? Date.parse(first.due_date)
      : Number.NaN;
    const futureDue = Number.isFinite(dueAt) && dueAt > nowMs;
    if (status !== 'blocked' && !HEARTBEAT_HOLDING_STATUSES.has(status) && !futureDue) {
      return { kind: 'run', reason: `ready Pulse task at status=${status}` };
    }

    if (backlogCount > 0) {
      return { kind: 'run', reason: `${backlogCount} backlog pull item(s)` };
    }

    if (status === 'blocked') {
      return {
        kind: 'skip',
        reason: `${activePage.count} blocked task(s), no alerts, ready work, or backlog pull`,
        readyTaskCount: 0,
        blockedTaskCount: activePage.count,
        futureDueCount: 0,
      };
    }

    return {
      kind: 'skip',
      reason: `${activePage.count} future/holding task(s), no alerts, ready work, or backlog pull`,
      readyTaskCount: 0,
      blockedTaskCount: 0,
      futureDueCount: activePage.count,
    };
  }

  if (backlogCount > 0) {
    return { kind: 'run', reason: `${backlogCount} backlog pull item(s)` };
  }

  return {
    kind: 'skip',
    reason: 'Pulse alerts, active queue, and backlog pull lane are empty',
    readyTaskCount: 0,
    blockedTaskCount: 0,
    futureDueCount: 0,
  };
}

/** Decide whether a completed scheduler turn deserves an immediate clean-thread
 * successor. The first ready_no_progress turn is retried once; the classifier
 * promotes the next consecutive miss to needs_help, which deliberately stops
 * the chain instead of hot-looping. */
export function shouldScheduleHeartbeatDrainFollowup(
  outcome: Pick<HeartbeatQueueDrainRecord, 'outcome' | 'readyTaskCount'>,
): boolean {
  return outcome.readyTaskCount > 0
    && (
      outcome.outcome === 'worked_task'
      || outcome.outcome === 'forwarded'
      || outcome.outcome === 'ready_no_progress'
    );
}

/** Select only skills that belong in Codex's native always-visible catalog.
 * The full canonical tree stays available at /opt/skills for explicit search,
 * while configured/universal/starred skills get native auto-discovery. This
 * avoids injecting descriptions for the entire fleet catalog into every
 * thread regardless of the agent's role. */
export function selectCodexNativeSkillNames(
  catalogDir: string,
  configuredSkillsRaw = '',
  role?: string,
  team?: string,
): string[] {
  const configured = new Set(
    configuredSkillsRaw.split(',').map((name) => name.trim()).filter(Boolean),
  );
  const universal = new Set<string>(PLATFORM_UNIVERSAL_SKILLS);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(catalogDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const selected: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(catalogDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const meta = readSkillFrontmatter(skillFile);
    if (meta && !skillMatchesAudience(meta, role, team)) continue;
    if (configured.has(entry.name) || universal.has(entry.name) || meta?.starred || meta?.critical) {
      selected.push(entry.name);
    }
  }
  return selected;
}

function isJwtStale(token: string, bufferMs = 6 * 60 * 60 * 1000): boolean {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return true;
    let payload = parts[1]!;
    payload += '='.repeat((4 - (payload.length % 4)) % 4);
    const exp = JSON.parse(Buffer.from(payload, 'base64url').toString()).exp;
    if (!exp) return true;
    return Date.now() >= exp * 1000 - bufferMs;
  } catch {
    return true;
  }
}

export function normalizeOpenAiBaseUrl(rawUrl?: string, fallback = DEFAULT_CODEX_CORTEX_OPENAI_BASE_URL): string {
  const candidate = rawUrl?.trim() || fallback;
  const withoutTrailingSlashes = candidate.trim().replace(/\/+$/, '');
  const withoutTrailingV1Segments = withoutTrailingSlashes.replace(/(?:\/v1)+$/i, '');
  return `${withoutTrailingV1Segments}/v1`;
}

/** A step of the daemon-provided model-failover chain (SHIZUHA_MODEL_FALLBACKS). */
export type FailbackChainStep = { method?: string; model?: string };

/**
 * PLAT-2946: Given the daemon-provided failover chain JSON (SHIZUHA_MODEL_FALLBACKS)
 * and the model currently running, return the first chain step whose model differs
 * from the current one — the model we should fail over TO when the current backend is
 * wedged. Returns null when the env is missing, malformed, not an array, or every
 * configured step is the current (wedged) model — in which case failing over would
 * just churn the same limited backend. Pure/side-effect-free for unit testing.
 */
/**
 * PLAT-4205: gpt-* codex agents must use the HTTP-only ChatGPT backend, not the
 * WS transport that wedges the model-catalog/turn path (openai/codex#22634). We
 * (a) pin a static, gpt-filtered model catalog so the live catalog refresh can't
 * wedge, and (b) define a custom `chatgpt-http` provider ENTIRELY via `-c` launch
 * args. Defining the provider inline at launch means it is always fully specified
 * (never selecting an undefined provider on a stale/failure path — the deprecated
 * bridge's P1) and there is no config.toml TOML-placement to get wrong (its P2).
 * The corrected endpoint is `https://chatgpt.com/backend-api/codex` (revi-verified;
 * NOT `api.openai.com`). Ported from deprecated#3 + sara2574/deprecated#1 to the
 * canonical shizuha-beta codex-bridge.
 */
export function isGptCodexModel(model: string | undefined): boolean {
  return /^gpt-/i.test(model ?? '');
}

/**
 * Generate a static, gpt-filtered model catalog from `codex debug models
 * --bundled` and write it ATOMICALLY (tmp + rename). Returns the catalog path, or
 * `null` when the model isn't gpt-*, generation failed, or no gpt-* models exist —
 * degrading to the live catalog rather than pinning a broken file. Never throws.
 */
export function ensureGptStaticCatalog(
  model: string | undefined,
  codexHome: string,
  codexPath: string,
): string | null {
  if (!isGptCodexModel(model)) return null;
  const catalogPath = path.join(codexHome, 'model-catalog.json');
  try {
    const raw = execSync(`${codexPath} debug models --bundled`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, CODEX_HOME: codexHome } as Record<string, string>,
    });
    const bundled = JSON.parse(raw) as { models?: Array<Record<string, unknown>> };
    const models = (bundled.models ?? []).filter((m) =>
      String(m['slug'] ?? '').startsWith('gpt-'),
    );
    if (models.length === 0) {
      console.warn('[codex-bridge] PLAT-4205: no gpt-* models in bundled catalog; not pinning');
      return null;
    }
    fs.mkdirSync(codexHome, { recursive: true });
    const tmp = `${catalogPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ models }, null, 2), { mode: 0o644 });
    fs.renameSync(tmp, catalogPath);
    console.log(
      `[codex-bridge] PLAT-4205: pinned static model catalog (${models.length} gpt models) at ${catalogPath}`,
    );
    return catalogPath;
  } catch (e) {
    console.error(
      `[codex-bridge] PLAT-4205: static catalog generation failed, degrading to live catalog: ${(e as Error).message}`,
    );
    return null;
  }
}

/**
 * The `-c` app-server args that pin a gpt-* agent to the HTTP-only `chatgpt-http`
 * provider. Empty for non-gpt models. `catalogPath` (from `ensureGptStaticCatalog`)
 * is included only when a static catalog was written. The provider is fully defined
 * here so it can never be selected while undefined.
 */
export function resolveChatGptHttpBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  // Prefer agent-gateway when present so internal JWT is never sent to chatgpt.com.
  const candidates = [env['OPENAI_BASE_URL'], env['CODEX_BASE_URL'], env['OPENAI_API_BASE']];
  for (const c of candidates) {
    if (!c) continue;
    const base = c.trim();
    if (!base) continue;
    if (base.includes('agent-gateway') || base.replace(/\/+$/, '').endsWith('/codex')) {
      return base;
    }
  }
  return 'https://chatgpt.com/backend-api/codex';
}

export function buildGptCodexProviderArgs(
  model: string | undefined,
  catalogPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!isGptCodexModel(model)) return [];
  const args: string[] = [];
  if (catalogPath) {
    args.push('-c', `model_catalog_json=${JSON.stringify(catalogPath)}`);
  }
  const baseUrl = resolveChatGptHttpBaseUrl(env);
  args.push(
    '-c', 'model_provider=chatgpt-http',
    '-c', 'model_providers.chatgpt-http.name=chatgpt-http',
    '-c', `model_providers.chatgpt-http.base_url=${baseUrl}`,
    '-c', 'model_providers.chatgpt-http.wire_api=responses',
    '-c', 'model_providers.chatgpt-http.requires_openai_auth=true',
    '-c', 'model_providers.chatgpt-http.supports_websockets=false',
  );
  return args;
}

/** Parse a millisecond interval override to a finite value at/above `minMs`, else
 *  `fallbackMs`. Guards the watchdog timer against 0/negative/NaN/tiny values that
 *  Node collapses to a ~1ms hot loop (rei P2, PLAT-4179). */
export function parseIntervalMs(raw: unknown, fallbackMs: number, minMs: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < minMs) return fallbackMs;
  return n;
}

/** Idle-heartbeat cadence for the codex bridge. Honors the fleet-wide
 *  SHIZUHA_IDLE_HEARTBEAT_MS knob (the same env the gateway reads and the k8s
 *  backend renders into every agent pod); default 30m, floor 60s. */
export function resolveIdleHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  return parseIntervalMs(env['SHIZUHA_IDLE_HEARTBEAT_MS'], 30 * 60 * 1000, 60_000);
}

export function firstDistinctFallbackStep(
  fallbacksJson: string | undefined | null,
  currentModel: string | undefined | null,
): FailbackChainStep | null {
  if (!fallbacksJson) return null;
  let chain: unknown;
  try {
    chain = JSON.parse(fallbacksJson);
  } catch {
    return null;
  }
  if (!Array.isArray(chain)) return null;
  const current = (currentModel ?? '').toLowerCase();
  for (const step of chain as FailbackChainStep[]) {
    const stepModel = (step?.model ?? '').toLowerCase();
    // PLAT-2946 (P2-4): "distinct" = first step on a DIFFERENT model, matched by
    // MODEL not method. If the chain lists another codex model before the claude
    // fallback, we advance there first — that peer may share the same usage-limited
    // org, but its own subsequent exhaustion re-fires this path and advances again
    // (bounded by the chain length; the daemon's advanceFailoverStep walks each
    // step in order). Callers surface which target was chosen so an intra-provider
    // re-advance is observable in telemetry, not silent.
    if (stepModel && stepModel !== current) return step;
  }
  return null;
}

/** The action to take when codex is empty-turn-exhausted and account rotation is a NOOP. */
export type EmptyTurnExhaustionAction =
  | { kind: 'failover'; step: FailbackChainStep }
  | { kind: 'stay-alive' };

export type EmptyTurnHistoryEntry = { ts: number; empty: boolean };

export type EmptyTurnTriggerConfig = {
  consecutiveThreshold: number;
  windowMs: number;
  windowMinTurns: number;
  windowMinEmptyTurns: number;
  windowFractionThreshold: number;
};

export type EmptyTurnFailoverTrigger =
  | { kind: 'consecutive'; consecutiveEmptyTurns: number; threshold: number }
  | {
      kind: 'window';
      windowMs: number;
      totalTurns: number;
      emptyTurns: number;
      emptyFraction: number;
      threshold: number;
      minTurns: number;
      minEmptyTurns: number;
    };

/**
 * PLAT-2946: Decide what to do when a codex agent is empty-turn-exhausted and no
 * alternate codex account can rotate in.
 *
 * - distinct fallback in chain → `failover` (exit 42, advance model chain)
 * - otherwise `stay-alive` — soft-reset and keep serving (human model: quiet is
 *   not "provider dead"; do NOT write sticky unavailable / exit 43)
 *
 * Pure/side-effect-free for unit testing.
 */
export function decideEmptyTurnExhaustionAction(
  fallbacksJson: string | undefined | null,
  currentModel: string | undefined | null,
): EmptyTurnExhaustionAction {
  const step = firstDistinctFallbackStep(fallbacksJson, currentModel);
  return step ? { kind: 'failover', step } : { kind: 'stay-alive' };
}

/**
 * PLAT-4033: Consecutive-empty thresholds miss flapping providers because one
 * productive turn resets the streak. Evaluate both the old hard-streak trigger
 * and a rolling-window fraction trigger so sustained degraded Codex auth/quota
 * failures fail over even when the provider occasionally succeeds.
 */
export function evaluateEmptyTurnFailoverTrigger(
  history: EmptyTurnHistoryEntry[],
  now: number,
  consecutiveEmptyTurns: number,
  config: EmptyTurnTriggerConfig,
): EmptyTurnFailoverTrigger | null {
  if (consecutiveEmptyTurns >= config.consecutiveThreshold) {
    return {
      kind: 'consecutive',
      consecutiveEmptyTurns,
      threshold: config.consecutiveThreshold,
    };
  }

  const windowStart = now - config.windowMs;
  const recent = history.filter((entry) => entry.ts >= windowStart);
  const totalTurns = recent.length;
  if (totalTurns < config.windowMinTurns) return null;

  const emptyTurns = recent.filter((entry) => entry.empty).length;
  if (emptyTurns < config.windowMinEmptyTurns) return null;

  const emptyFraction = emptyTurns / totalTurns;
  if (emptyFraction >= config.windowFractionThreshold) {
    return {
      kind: 'window',
      windowMs: config.windowMs,
      totalTurns,
      emptyTurns,
      emptyFraction,
      threshold: config.windowFractionThreshold,
      minTurns: config.windowMinTurns,
      minEmptyTurns: config.windowMinEmptyTurns,
    };
  }

  return null;
}

export function isHeartbeatTurnContent(content: string | null | undefined): boolean {
  // Retry/rescue turns are scheduler turns too. The previous exact `]` match
  // silently classified `[HEARTBEAT RETRY]` as user traffic, so its MCP calls
  // were not observed and a failed retry could never trigger bounded rescue.
  return typeof content === 'string' && /^\s*\[HEARTBEAT(?:\s+RETRY)?\]/i.test(content);
}

export function buildHeartbeatToolObservationFromCodexMcpItem(item: Record<string, unknown>): {
  toolCall: HeartbeatQueueDrainTurnToolCall;
  toolResult: HeartbeatQueueDrainTurnToolResult;
} {
  return {
    toolCall: {
      name: `mcp__${String(item['server'] ?? 'mcp').replace(/-/g, '_')}__${String(item['tool'] ?? 'tool')}`,
    },
    toolResult: {
      content: item['result'] ?? item['output'] ?? item['content'] ?? item['text'] ?? item['error'] ?? '',
      isError: item['status'] === 'failed' || Boolean(item['error']),
    },
  };
}

export function parseConnectSenderUsername(content: string): string | null {
  const match = content.match(/^\[([^\]\s]+)\]\s+/);
  const username = match?.[1]?.trim();
  return username || null;
}

export function isConnectSystemSenderUsername(sender: string | null): boolean {
  return (sender ?? '').trim().toLowerCase() === 'system';
}

export function connectReplyTrackedSenderUsername(content: string): string | null {
  const sender = parseConnectSenderUsername(content);
  return isConnectSystemSenderUsername(sender) ? null : sender;
}

export function buildConnectDmTurnPrompt(
  content: string,
  conversationType: 'direct' | 'group' | 'unknown' = 'unknown',
  replyObligation: 'optional' | 'required' = 'optional',
): string {
  const sender = parseConnectSenderUsername(content);
  if (!sender || isConnectSystemSenderUsername(sender)) return content;
  if (conversationType === 'direct' && replyObligation === 'optional') {
    return `${content}\n\n[Connect DM delivery note]\nThis turn came from a Connect direct message from [${sender}]. Natural turn text is private. Call message_user only if a response is warranted; silence is valid.`;
  }
  if (conversationType === 'unknown') {
    return `${content}\n\n[Connect delivery note]\nConversation provenance is missing or invalid. Natural turn text is private. Call message_user only if a response is warranted; silence is valid.`;
  }
  return `${content}

[Connect DM delivery requirement]
This turn came from a Connect direct message from [${sender}]. Natural turn text in the Codex bridge is private and is NOT visible to Connect users. Before ending this turn, you MUST call the Connect DM reply tool (message_user / mcp__shizuha-connect__message_user) with recipient_username="${sender}" and content that answers the DM. If the sender requested an exact reply, send exactly that requested reply via the tool. Do not only write a final answer.`;
}


export interface BridgeQueuedMessage {
  clientId: string;
  content: string;
  messageId?: string;
  conversationType?: 'direct' | 'group' | 'unknown';
  replyObligation?: 'optional' | 'required';
  /** Number of clean-thread attempts made after a provider-empty Connect turn. */
  emptyTurnReplayCount?: number;
}

/**
 * Connect DMs are inject-once user turns (same mental model as chat): the bridge
 * delivers the message into the agent; whether the agent replies via message_user
 * is agent choice. Silence is valid and MUST NOT re-queue, backoff, or mark the
 * provider unavailable.
 *
 * The only legitimate re-inject is a **transient transport / provider failure**
 * before the model could run a completed turn (network blip). Completed turns —
 * including reasoning-only / empty final answer / no tools — are never replayed.
 *
 * @param allowReplay - set only for transient_provider structured failures.
 */
export function buildEmptyConnectDmReplay(
  message: BridgeQueuedMessage | null,
  turnWasProviderEmpty: boolean,
  messageUserCalled: boolean,
  allowReplay = false,
): BridgeQueuedMessage | null {
  if (
    !allowReplay
    || !message
    || !message.clientId.startsWith('connect:')
    || isLowPriorityConnectSystemMessage(message)
    || isConnectSystemSenderUsername(parseConnectSenderUsername(message.content))
    || !turnWasProviderEmpty
    || messageUserCalled
  ) return null;
  return {
    ...message,
    emptyTurnReplayCount: (message.emptyTurnReplayCount ?? 0) + 1,
  };
}

/** True when this turn was a Connect inject (not a heartbeat / dashboard turn). */
export function isConnectInjectTurn(message: BridgeQueuedMessage | null | undefined): boolean {
  return Boolean(message?.clientId.startsWith('connect:'));
}

export function isExplicitConnectReplyRequest(message: BridgeQueuedMessage): boolean {
  if (!message.clientId.startsWith('connect:')) return false;
  const text = message.content.trim();
  if (/^\[system\]\s/i.test(text)) return false;
  return /\bplease\s+reply\b[\s\S]{0,160}\bexactly\b\s*:?/i.test(text)
    || /\breply\s+exactly\b\s*:?/i.test(text)
    || /\breply\s+(?:with\s+)?(?:the\s+)?(?:word|phrase|text)\b[\s\S]{0,80}/i.test(text);
}

export function isLowPriorityConnectSystemMessage(message: BridgeQueuedMessage): boolean {
  if (!message.clientId.startsWith('connect:')) return false;
  // Only routine Pulse scheduling notices are wake hints. Alerts, incidents,
  // ownership revocations, and other control-plane messages from [system] keep
  // direct-message priority and must never be hidden behind a heartbeat.
  return /^\[system\]\s+(?:\[Task (?:Assigned|Update)\]|\[(?:Review Seat Starvation|Routability Hold)\])/i.test(
    message.content.trim(),
  );
}

/** Control-plane incidents/revocations remain interrupt-class messages. Ordinary
 * human/agent DMs do not: once Pulse has emitted a scheduling wake, the bounded
 * canonical queue refresh must run first so urgent WIP cannot sit behind chat. */
export function isPriorityConnectControlMessage(message: BridgeQueuedMessage): boolean {
  return message.clientId.startsWith('connect:')
    && !isLowPriorityConnectSystemMessage(message)
    && isConnectSystemSenderUsername(parseConnectSenderUsername(message.content));
}

export type BridgeQueueAction =
  | { kind: 'message'; index: number }
  | { kind: 'heartbeat' }
  | { kind: 'wait'; delayMs: number }
  | { kind: 'idle' };

/** Choose the next bridge action at a safe turn boundary.
 *
 * Explicit control-plane incidents stay first. Once Pulse has emitted a task
 * scheduling wake, its bounded canonical checkpoint runs before ordinary DMs;
 * otherwise chat can hide newly assigned urgent WIP for an entire DM backlog.
 * Future checkpoints hold ordinary/routine messages until their short settle
 * delay expires instead of starting a potentially long model turn. */
export function selectBridgeQueueAction(
  queue: BridgeQueuedMessage[],
  heartbeatCheckpointDueAt: number | null,
  now = Date.now(),
): BridgeQueueAction {
  const controlMessageIndex = queue.findIndex(isPriorityConnectControlMessage);
  if (controlMessageIndex >= 0) return { kind: 'message', index: controlMessageIndex };

  if (heartbeatCheckpointDueAt !== null) {
    if (heartbeatCheckpointDueAt <= now) return { kind: 'heartbeat' };
    return { kind: 'wait', delayMs: heartbeatCheckpointDueAt - now };
  }

  const directMessageIndex = queue.findIndex((message) => !isLowPriorityConnectSystemMessage(message));
  if (directMessageIndex >= 0) return { kind: 'message', index: directMessageIndex };

  if (queue.length > 0) return { kind: 'message', index: 0 };
  return { kind: 'idle' };
}

export function enqueueBridgeMessage(
  queue: BridgeQueuedMessage[],
  message: BridgeQueuedMessage,
): number {
  if (isExplicitConnectReplyRequest(message)) {
    const firstNonExplicitReply = queue.findIndex((queued) => !isExplicitConnectReplyRequest(queued));
    if (firstNonExplicitReply >= 0) {
      queue.splice(firstNonExplicitReply, 0, message);
      return firstNonExplicitReply;
    }
  }

  if (message.clientId.startsWith('connect:') && !isLowPriorityConnectSystemMessage(message)) {
    const firstLowPriority = queue.findIndex(isLowPriorityConnectSystemMessage);
    if (firstLowPriority >= 0) {
      queue.splice(firstLowPriority, 0, message);
      return firstLowPriority;
    }
  }
  queue.push(message);
  return queue.length - 1;
}

export function isMessageUserToolCall(server: unknown, tool: unknown): boolean {
  const haystack = `${String(server ?? '')} ${String(tool ?? '')}`.toLowerCase().replace(/-/g, '_');
  return /(^|[^a-z0-9])message_user([^a-z0-9]|$)/.test(haystack)
    || haystack.includes('shizuha_connect') && haystack.includes('message');
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(stringValue).join('');
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const key of ['delta', 'text', 'content', 'output', 'stdout', 'stderr']) {
      const text = stringValue(obj[key]);
      if (text) return text;
    }
    return '';
  }
  return String(value);
}

function compactText(value: unknown, max = 4000): string {
  const text = stringValue(value);
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`;
}

function extractCommandString(item: Record<string, unknown>): string {
  const command = item['command'];
  if (typeof command === 'string') return command;
  if (Array.isArray(command)) return command.map(part => String(part)).join(' ');
  const actions = item['commandActions'];
  if (Array.isArray(actions)) {
    const run = actions.find(action => typeof action === 'object' && action && 'cmd' in action) as Record<string, unknown> | undefined;
    if (run) return stringValue(run['cmd']);
  }
  return '';
}

function parseContainerAgentId(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function chownForContainerAgent(targetPath: string, recursive = true): void {
  const uid = parseContainerAgentId('SHIZUHA_CONTAINER_AGENT_UID', DEFAULT_CONTAINER_AGENT_UID);
  const gid = parseContainerAgentId('SHIZUHA_CONTAINER_AGENT_GID', DEFAULT_CONTAINER_AGENT_GID);
  const args = recursive ? ['-R', `${uid}:${gid}`, targetPath] : [`${uid}:${gid}`, targetPath];
  try { execFileSync('chown', args, { stdio: 'ignore' }); } catch { /* */ }
}

export function buildCodexPlatformMcpToml(
  name: string,
  cfg: { url: string; headers?: Record<string, string> },
  tokenEnvVar = CODEX_PLATFORM_MCP_TOKEN_ENV,
): string {
  const esc = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `
[mcp_servers.${name}]
url = "${esc(cfg.url)}"
bearer_token_env_var = "${esc(tokenEnvVar)}"
`;
}

export interface BrokerCodexAuthPayload {
  email: string;
  accessToken: string;
  accountId: string;
  chatgptPlanType?: string;
}

export function parseBrokerCodexPayload(raw: string): BrokerCodexAuthPayload | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const firstString = (...values: unknown[]): string =>
      values.find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? '';
    const accessToken = firstString(parsed.access_token, parsed.accessToken);
    const accountId = firstString(parsed.account_id, parsed.accountId);
    const chatgptPlanType = firstString(
      parsed.chatgpt_plan_type,
      parsed.chatgptPlanType,
      parsed.plan_type,
      parsed.planType,
    );
    const email = firstString(parsed.email) || 'broker';
    if (!accessToken || !accountId) return null;
    return {
      email,
      accessToken,
      accountId,
      ...(chatgptPlanType ? { chatgptPlanType } : {}),
    };
  } catch {
    return null;
  }
}

/** Build the access-only compatibility auth file loaded before app-server's
 * external-auth RPC is installed. The canonical rotating refresh token never
 * enters an agent filesystem. */
export function buildBrokerCodexAuthFile(
  account: BrokerCodexAuthPayload,
  refreshedAt = new Date(),
): Record<string, unknown> {
  return {
    auth_mode: 'chatgptAuthTokens',
    tokens: {
      // Codex's external-token auth shape parses identity claims from the access
      // JWT and deliberately stores an empty, non-refreshable refresh token.
      id_token: account.accessToken,
      access_token: account.accessToken,
      refresh_token: '',
      account_id: account.accountId,
    },
    last_refresh: refreshedAt.toISOString(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isCodexLimitError(message: string): boolean {
  const lower = message.toLowerCase();
  if (/\b429\b|rate.?limit|usage limit|quota|too many requests/i.test(lower)) return true;
  if (/(?:rate|usage|quota|account|credit|token)[^.\n]{0,60}exhaust|exhaust[^.\n]{0,60}(?:rate|usage|quota|account|credit|token)/i.test(lower)) return true;
  // Generic outage wording is not account-scoped by itself; only treat it as a
  // cooldown signal when it is paired with an explicit limit/quota marker.
  if (/(temporarily unavailable|try again later)/i.test(lower)) {
    return /\b429\b|rate|limit|quota|usage|too many requests/i.test(lower);
  }
  return false;
}

function isCodexAuthFailure(message: string): boolean {
  return /no id_token|missing id_token|invalid[_ -]?grant|invalid refresh|revoked|expired refresh|unauthorized|\b401\b|\b403\b|not authenticated|authentication required|sign in|login required/i.test(message);
}

function isCodexAuthInvalidationSignal(message: string): boolean {
  return /token_invalidated|refresh_token_invalidated|invalid[_ -]?grant|invalid refresh|revoked|session has ended|please log in again|please try signing in again/i.test(message);
}

export type CodexTurnFailureCategory =
  | 'none'
  | 'auth'
  | 'rate_limit'
  | 'transient_provider'
  | 'deterministic'
  | 'interrupted'
  | 'unknown';

export interface CodexTurnCompletionClassification {
  status: string;
  category: CodexTurnFailureCategory;
  errorCode: string | null;
  httpStatus: number | null;
  message: string;
}

/** Keep provider diagnostics useful without ever copying bearer/access/refresh
 * credentials into pod logs or Hive's recent-error ring. */
export function sanitizeCodexProviderError(message: unknown): string {
  return String(message ?? '')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]{10,}){1,2}\b/g, '[redacted-jwt]')
    .replace(/\b(?:sk|sess|rt|at)-[A-Za-z0-9_-]{16,}\b/gi, '[redacted-token]')
    .replace(
      /((?:access|refresh|id)[_-]?token|api[_-]?key|authorization)(\s*["']?\s*[:=]\s*["']?)[^"',}\s]+/gi,
      '$1$2[redacted]',
    )
    .replace(/([?&](?:token|key|access_token|refresh_token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function codexErrorInfoCode(info: unknown): string | null {
  if (typeof info === 'string' && info.trim()) return info.trim();
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  return Object.keys(info as Record<string, unknown>)[0] ?? null;
}

function codexErrorInfoHttpStatus(info: unknown): number | null {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  for (const value of Object.values(info as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const status = (value as Record<string, unknown>)['httpStatusCode'];
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  return null;
}

export function classifyCodexTurnCompletion(
  params: Record<string, unknown>,
): CodexTurnCompletionClassification {
  const turn = (
    params['turn'] && typeof params['turn'] === 'object' && !Array.isArray(params['turn'])
      ? params['turn']
      : {}
  ) as Record<string, unknown>;
  const error = (
    turn['error'] && typeof turn['error'] === 'object' && !Array.isArray(turn['error'])
      ? turn['error']
      : params['error'] && typeof params['error'] === 'object' && !Array.isArray(params['error'])
        ? params['error']
        : {}
  ) as Record<string, unknown>;
  const status = typeof turn['status'] === 'string' ? turn['status'] : 'completed';
  const errorInfo = error['codexErrorInfo'] ?? error['codex_error_info'];
  const errorCode = codexErrorInfoCode(errorInfo);
  const httpStatus = codexErrorInfoHttpStatus(errorInfo);
  const message = sanitizeCodexProviderError(error['message'] ?? params['message'] ?? '');
  const signal = `${errorCode ?? ''} ${httpStatus ?? ''} ${message}`;

  let category: CodexTurnFailureCategory = 'unknown';
  if (status === 'completed' && !message && !errorCode) category = 'none';
  else if (status === 'interrupted') category = 'interrupted';
  else if (
    errorCode === 'usageLimitExceeded'
    || httpStatus === 429
    || isCodexLimitError(signal)
  ) category = 'rate_limit';
  else if (
    errorCode === 'unauthorized'
    || httpStatus === 401
    || (httpStatus === 403 && !isCodexLimitError(signal))
    || isCodexAuthFailure(signal)
  ) category = 'auth';
  else if (
    ['serverOverloaded', 'internalServerError', 'httpConnectionFailed',
      'responseStreamConnectionFailed', 'responseStreamDisconnected',
      'responseTooManyFailedAttempts'].includes(errorCode ?? '')
    || (httpStatus !== null && (httpStatus === 408 || httpStatus >= 500))
    || /\b(connection (?:failed|reset|closed)|network error|timed? ?out|timeout|temporar(?:y|ily) unavailable|upstream disconnected|stream disconnected)\b/i.test(signal)
  ) category = 'transient_provider';
  else if (
    ['contextWindowExceeded', 'sessionBudgetExceeded', 'cyberPolicy', 'badRequest',
      'threadRollbackFailed', 'sandboxError', 'activeTurnNotSteerable'].includes(errorCode ?? '')
    || (httpStatus !== null && httpStatus >= 400 && httpStatus < 500)
  ) category = 'deterministic';

  return { status, category, errorCode, httpStatus, message };
}

/**
 * HIVE-586: coordinator-backed recovery must never inspect the host Codex pool.
 * Keeping this decision at the read boundary makes the fail-closed guarantee
 * testable even when the broker socket is configured but not yet available.
 */
export function codexBrokerAuthorityRequired(): boolean {
  return process.env['CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'] === '1' || brokerExpected();
}

export function loadLocalCodexRateLimitRecoveryAccounts(): CodexAccountEntry[] {
  if (codexBrokerAuthorityRequired()) return [];
  return readCodexAccounts();
}

export function isSilentSystemUpdateTurn(message: string | null): boolean {
  const text = (message ?? '').trim();
  // Connect's reserved [system] sender delivers platform notifications (task
  // updates, review requests, lifecycle notices). Silence is valid for all of
  // them and must not look like provider exhaustion.
  return /^\[system\]\s/i.test(text);
}

function parseRetryDelayMs(message: string): number | null {
  const sec = message.match(/(?:retry|try again|reset)[^0-9]{0,40}(\d{1,5})\s*(?:s|sec|second)/i);
  if (sec) return Number(sec[1]) * 1000;
  const min = message.match(/(?:retry|try again|reset)[^0-9]{0,40}(\d{1,4})\s*(?:m|min|minute)/i);
  if (min) return Number(min[1]) * 60_000;
  return null;
}

function jwtClaim(token: string | undefined, claim: string): string | undefined {
  if (!token) return undefined;
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const json = Buffer.from(part, 'base64url').toString('utf8');
    const value = (JSON.parse(json) as Record<string, unknown>)[claim];
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

// ── Types ──

/** Codex app-server ReasoningEffort enum accepts none|minimal|low|medium|high|xhigh.
 *  'ultra'/'max' are gpt-5.6-sol ChatGPT-backend levels (auto task delegation)
 *  that the app-server rejects — clamp them to the highest supported level, the
 *  same normalization the Responses-API path applies (provider/codex.ts). */
export function normalizeCodexEffort(effort: string | null | undefined): string | undefined {
  const level = String(effort ?? '').toLowerCase();
  if (level === 'ultra' || level === 'max' || level === 'xhigh') return 'xhigh';
  if (level === 'low' || level === 'medium' || level === 'high' || level === 'minimal' || level === 'none') {
    return level;
  }
  return undefined;
}

interface CodexBridgeOptions {
  port: number;
  host: string;
  model: string;
  agentId?: string;
  agentName?: string;
  agentUsername?: string;
  reasoningEffort?: string;
  contextPrompt?: string;
  cwd?: string;
}

interface WsClient {
  ws: WebSocket;
  userId: string;
  activeThreadId: string | null;
}

// ── JSON-RPC ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ── Bridge ──

export class CodexBridge {
  private app: FastifyInstance | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WsClient>();
  private sessionId = '';
  private startTime = Date.now();

  // Token tracking
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  /** App-server tokenUsage.total is cumulative only within the current Codex
   *  thread. Keep that cursor separate from persisted lifetime totals. */
  private currentCodexThreadInputTokens = 0;
  private currentCodexThreadOutputTokens = 0;
  /** Latest model request occupancy from tokenUsage.last. Unlike total, this is
   *  bounded by the model context window and is the value Hive should display. */
  private activeTurnContextInputTokens: number | null = null;
  private activeTurnCachedInputTokens: number | null = null;
  private activeTurnModelContextWindow: number | null = null;
  private totalOutputChars = 0;
  private turnCount = 0;
  // Telemetry (reported to the platform over Connect — mirrors claude-bridge).
  private lastTurnInputTokens = 0;
  private lastTurnBilledInputTokens = 0;
  private lastTurnCachedInputTokens = 0;
  private lastTurnModelContextWindow: number | null = null;
  private lastTurnOutputTokens = 0;
  private lastTurnDurationMs = 0;
  private lastTurnTtftMs: number | null = null;
  private lastTurnToolCalls = 0;
  private lastTurnToolFailures = 0;
  private lastTurnOutputBytes = 0;
  private inputAtLastComplete = 0;
  private outputAtLastComplete = 0;
  private lastActivityAt = Date.now();
  private recentErrors: Array<{ ts: number; level: string; msg: string }> = [];
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;

  // PLAT-394: Empty-turn detection.
  // An "empty turn" is turn/started → userMessage → turn/completed with zero assistant
  // content or tool items. This is the silent-death pattern from a bad/rate-limited model
  // (HTTP 400 / usage-limit swallowed by the Codex backend, no error surfaced to us).
  // A sustained streak is still the fastest hard-wedge signal, but PLAT-4033 showed
  // flapping gpt-5.5 auth/quota failures can produce occasional good turns that reset
  // the streak while the agent is still mostly non-productive. Track a rolling window
  // too, and let either trigger attempt account rotation / model failover.
  private static readonly EMPTY_TURN_THRESHOLD = 3;
  private static readonly EMPTY_TURN_WINDOW_MS = 10 * 60 * 1000;
  private static readonly EMPTY_TURN_WINDOW_MIN_TURNS = 4;
  private static readonly EMPTY_TURN_WINDOW_MIN_EMPTY_TURNS = 3;
  private static readonly EMPTY_TURN_WINDOW_FRACTION_THRESHOLD = 0.5;
  private currentTurnHasOutput = false;
  private consecutiveEmptyTurns = 0;
  private emptyTurnHistory: EmptyTurnHistoryEntry[] = [];

  // Persistent app-server process
  private serverProcess: ChildProcess | null = null;
  private serverReady = false;
  private codexThreadId: string | null = null; // Codex's internal thread ID
  /** Serializes app-server thread unloads before a replacement thread starts.
   * Each loaded Codex thread owns a full MCP process set. Dropping the ID
   * without thread/unsubscribe leaves that set resident until app-server exit. */
  private codexThreadCleanupPromise: Promise<void> = Promise.resolve();
  private activeThreadId: string | null = null; // Dashboard's execution thread ID
  // Heartbeat watchdog (see claude-bridge): a turn that dies mid-flight without
  // clearing activeThreadId would skip EVERY heartbeat forever and park the agent.
  // Timestamp the latch so fireHeartbeat can force-clear a presumed-dead turn.
  private activeThreadStartedAt: number | null = null;
  /** First model-originated event for the active turn. User-message echo and
   *  turn/started do not count; this is the real end-to-end TTFT signal. */
  private activeTurnFirstModelEventAt: number | null = null;
  /** Last reasoning/content/tool activity. Lets Hive distinguish a live long
   *  command from an app-server turn that has stopped making progress. */
  private activeTurnLastProgressAt: number | null = null;
  private activeTurnToolCalls = 0;
  private readonly activityPhase = new ActivityPhaseTracker({
    onChange: () => this.telemetryFlusher?.soon(),
  });
  private readonly telemetryFlusher = createTelemetryFlusher(() => this.emitTelemetry());
  private activeTurnToolFailures = 0;
  private activeTurnOutputBytes = 0;
  private activeTurnStallAlerted = false;
  private heartbeatStuckMs = 45 * 60 * 1000;
  private activeMessageId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatFollowupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Controller-owned, bounded fence that stops autonomous successor turns at
   * a safe boundary before replacing this runtime pod. */
  private runtimeRollDrain = new RuntimeRollDrainLease(() => {
    if (this.runtimeRollConnectStopped) {
      this.runtimeRollConnectStopped = false;
      void this.connectClient?.start();
    }
    void this.processQueue();
  });
  private runtimeRollConnectStopped = false;
  /** Coalesced autonomous checkpoint waiting for the next safe turn boundary.
   * Direct/user messages may run first; routine Connect task notifications
   * may not. This is scheduler state, not another model prompt queue. */
  private pendingHeartbeatCheckpoint: {
    observationRetry: boolean;
    resetThread: boolean;
    dueAt: number;
    reason: string;
  } | null = null;
  /** Number of mandatory observation retries used by the current heartbeat.
   * Retry #1 keeps the warm thread; retry #2 uses a clean thread to escape a
   * context-local empty-turn attractor. Two is a hard bound so prompt
   * non-compliance cannot hot-loop. */
  private heartbeatObservationRetryCount = 0;
  // PLAT-4179: dedicated stuck-latch watchdog, run frequently and decoupled from the
  // hourly heartbeat so a wedged turn's leaked latch is force-cleared within one tick.
  private stuckLatchTimer: ReturnType<typeof setInterval> | null = null;
  private stuckLatchCheckMs = 60 * 1000;
  private stuckLatchRecoveryPromise: Promise<boolean> | null = null;
  /** Incremented when watchdog recovery supersedes an in-flight execution.
   *  The old executeMessage catch must not release the latch/queue owned by the
   *  serialized recovery after its pending RPC is rejected. */
  private executionGeneration = 0;
  private codexPath = '';
  private activeTurnResolve: (() => void) | null = null;
  /** Current user turn content; retained so account rotation/backoff can replay it. */
  private activeTurnContent: string | null = null;
  /** A no-progress app-server turn may be replayed once after the child is
   *  fenced. A second silent attempt fails loud instead of restart-looping. */
  private activeTurnNoProgressReplayCount = 0;
  private activeTurnIsHeartbeat = false;
  private heartbeatToolCalls: Array<{ name?: string; input?: unknown }> = [];
  private heartbeatToolResults: Array<{ content?: unknown; isError?: boolean }> = [];
  /** Accounts temporarily unavailable for the active turn and the time they may become usable again. */
  private codexAccountUnavailableUntil = new Map<string, number>();
  /** Accounts that failed credential/auth preparation and must not re-enter rotation after a cooldown. */
  private codexAccountPermanentFailures = new Map<string, string>();
  /** First rate/usage-limit failure timestamp for this active turn; caps cumulative backoff. */
  private codexActiveLimitFirstFailedAt: number | null = null;
  /** Single in-flight retry controller for the active user turn. */
  private codexActiveTurnRetryPromise: Promise<void> | null = null;
  /** Currently selected Codex account when using the Shizuha credential store. */
  private codexActiveAccountEmail: string | null = null;
  /** Prevent a stderr auth storm from repeatedly reporting the same leased token. */
  private codexAuthInvalidReportInFlight = false;
  /** Suppress active-turn resolution while intentionally restarting app-server for auth rotation. */
  private restartingAppServerForAuthRotation = false;
  /** Old app-server child whose exit is expected during account rotation. */
  private suppressedCodexExitProc: ChildProcess | null = null;
  private platformJwtToken = '';

  // Message queue — messages sent during a turn are queued
  private messageQueue: BridgeQueuedMessage[] = [];

  // JSON-RPC request tracking
  private nextRpcId = 1;
  private pendingRequests = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();

  // Session persistence
  private store: StateStore;
  private accumulatedContent = '';
  private lastStreamedContent = '';
  /** True once the current Codex attempt has streamed text/tool/reasoning state to clients. */
  private codexActiveTurnStreamedState = false;
  /** B3/L1406: conversation recap injected into the next createThread call after an account rotation. */
  private rotationConversationContext: string | null = null;

  /** Shared Connect client for unified messaging */
  private connectClient: import('../connect-client/index.js').ConnectClient | null = null;
  private activityLog?: import('../shared/bridge-activity-log.js').BridgeActivityLog;
  private activeConnectSenderUsername: string | null = null;
  private activeConnectMessageUserCalled = false;
  /** Original Connect payload for the active turn (before delivery-note augmentation). */
  private activeQueuedMessage: BridgeQueuedMessage | null = null;
  /** Failed DM retained while a provider/account recovery is in progress. */
  private pendingEmptyConnectReplay: BridgeQueuedMessage | null = null;
  /** Replay metadata handed across processQueue without widening startExecution's API. */
  private nextEmptyTurnReplayCount = 0;

  constructor(private opts: CodexBridgeOptions) {
    this.sessionId = `codex-bridge-${opts.agentId ?? 'default'}`;
    const providerUnavailableReason = readProviderUnavailableMarker();
    if (providerUnavailableReason) {
      if (shouldClearLegacyEmptyTurnMarker(providerUnavailableReason)
        || !isStickyProviderOutageReason(providerUnavailableReason)) {
        // Empty-turn / non-outage markers must not keep the agent offline across
        // restarts (DRV-104 class). Real rate-limit/auth markers still stick.
        clearProviderUnavailableMarker();
        console.warn(
          `[codex-bridge] Cleared non-sticky provider marker on boot: ${providerUnavailableReason}`,
        );
      } else {
        this.providerUnavailable = true;
        this.providerUnavailableReason = providerUnavailableReason;
        console.warn(
          `[codex-bridge] Preserving provider-unavailable health across supervisor retry: ${providerUnavailableReason}`,
        );
      }
    }
    const workDir = opts.cwd ?? '/workspace';
    this.store = new StateStore(path.join(workDir, '.codex-state.db'));
    const existing = this.store.loadSession(this.sessionId);
    if (existing) {
      this.totalInputTokens = existing.totalInputTokens;
      this.totalOutputTokens = existing.totalOutputTokens;
      this.inputAtLastComplete = existing.totalInputTokens;
      this.outputAtLastComplete = existing.totalOutputTokens;
      this.turnCount = existing.turnCount;
      console.log(`[codex-bridge] Resumed session: ${existing.messages.length} messages, ${this.turnCount} turns`);
    } else {
      this.store.createSessionWithId(this.sessionId, opts.model, workDir);
      console.log(`[codex-bridge] Created new session: ${this.sessionId}`);
    }
  }

  /** Signal the entire detached app-server tree (runuser + codex), not only runuser. */
  private signalCodexTree(proc: ChildProcess | null, signal: NodeJS.Signals): void {
    if (!proc || proc.exitCode !== null) return;
    if (proc.pid != null) {
      try {
        process.kill(-proc.pid, signal);
        return;
      } catch { /* fall back to the direct child */ }
    }
    try { proc.kill(signal); } catch { /* already gone */ }
  }

  async start(): Promise<void> {
    // Start Connect client (unified messaging)
    try {
      const { ConnectClient } = await import('../connect-client/index.js');
      this.connectClient = new ConnectClient({
        onOpen: () => this.emitTelemetry(),
        onMessage: (convId, content, senderId, senderName, messageId, conversationType, replyObligation) => {
          if (this.runtimeRollDrain.ready) {
            console.log(
              `[codex-bridge] [Connect] Holding unread message from ${senderName} during runtime rollout`,
            );
            return;
          }
          const connectClientId = `connect:${convId}`;
          console.log(`[codex-bridge] [Connect] Message from ${senderName} in conv ${convId.substring(0, 8)}… len=${content.length} busy=${!!this.activeThreadId}`);
          if (messageId && this.store.inboundProcessingCompleted(this.sessionId, messageId)) {
            this.connectClient?.ackMessageProcessed(messageId);
            console.log(`[codex-bridge] [Connect] Acknowledged completed replay ${messageId}`);
            return;
          }
          const queuedMessage = { clientId: connectClientId, content, messageId, conversationType, replyObligation };
          if (messageId) this.store.markInboundProcessingAdmitted(this.sessionId, messageId, 'connect');
          if (this.convertRoutineConnectMessageToHeartbeat(queuedMessage)) {
            if (messageId) {
              this.store.markInboundProcessingCompleted(this.sessionId, messageId);
              this.connectClient?.ackMessageProcessed(messageId);
            }
            return;
          }
          if (!this.serverReady) {
            const queuePosition = enqueueBridgeMessage(this.messageQueue, queuedMessage);
            console.log(`[codex-bridge] [Connect] Queued message until app-server init from ${senderName} in conv ${convId.substring(0, 8)}… position=${queuePosition + 1} depth=${this.messageQueue.length}`);
          } else {
            const queuePosition = enqueueBridgeMessage(this.messageQueue, queuedMessage);
            console.log(`[codex-bridge] [Connect] Queued message from ${senderName} in conv ${convId.substring(0, 8)}… position=${queuePosition + 1} depth=${this.messageQueue.length}`);
            if (this.activeThreadId && isExplicitConnectReplyRequest(queuedMessage)) {
              this.interruptActiveTurnForPriority('explicit Connect reply request');
            }
            void this.processQueue();
          }
        },
        onConfigUpdate: (cfg) => {
          console.log(`[codex-bridge] agent_config_update received: keys=${Object.keys(cfg).join(',')}`);
          if (typeof cfg['contextPrompt'] === 'string') {
            this.opts.contextPrompt = cfg['contextPrompt'];
            console.log(`[codex-bridge] contextPrompt updated (${cfg['contextPrompt'].length} chars)`);
          }
          // Log any unrecognised keys so verification can confirm receipt
          const unhandled = Object.keys(cfg).filter(k => k !== 'contextPrompt');
          if (unhandled.length) {
            console.log(`[codex-bridge] agent_config_update: keys noted (no live-apply): ${unhandled.join(',')}`);
          }
        },
      });
      await this.connectClient.start();
    } catch (err) {
      console.error(`[connect-client] Failed to start: ${(err as Error).message}`);
    }

    // Warm the platform JWT now, while the event loop is free (the same window
    // the ConnectClient authenticates in successfully). Caches it for
    // setupCronMcp (platform MCP) + Cortex inference routing, avoiding the
    // init-time event-loop starvation that timed out the single later mint.
    await this.resolvePlatformJwt();

    this.codexPath = await this.findCodexCli();
    console.log(`[codex-bridge] Found codex CLI at: ${this.codexPath}`);

    // Codex OAuth (auth.json) is only needed when inference does NOT go through
    // Cortex — i.e. gpt-* models (OpenAI-only), or no platform JWT. Local models
    // on the JWT+Cortex path skip the fragile/expiring codex token refresh.
    const skipCodexOAuth = !!this.platformJwtToken && !/^gpt/i.test(this.opts.model ?? '');
    if (skipCodexOAuth) {
      console.log(`[codex-bridge] Model '${this.opts.model ?? ''}' on Cortex+JWT — skipping codex OAuth`);
    } else {
      // Defensive: a startup auth failure must NEVER crash the process (that is how
      // exhausted codex agents restart-loop). ensureAuth() degrades gracefully on a
      // dry broker; this catch covers any other unexpected auth error the same way —
      // come up with hasAuth=false and let the per-turn path re-attempt + recover.
      try {
        await this.ensureAuth();
      } catch (e) {
        console.warn(`[codex-bridge] ensureAuth failed at startup — starting DEGRADED (on-break, no crash-loop): ${(e as Error).message}`);
        this.hasAuth = false;
      }
    }
    await this.setupCronMcp();
    this.setupSkills();
    writeBaseInstructions(this.opts.cwd ?? '/workspace');

    // Set up dirs once at startup (not per-message)
    this.setupDirs();

    // Start the persistent app-server process
    await this.startAppServer();

    // Start HTTP/WS server
    await this.startServer();

    console.log(`Codex bridge listening on ${this.opts.host}:${this.opts.port}`);

    // Autonomous pulse — codex agents had NO heartbeat (only claude-bridge did),
    // so they never ran the pulse_get_my_tasks catch-up / escalation routine.
    this.startHeartbeat();
    this.startTelemetry();
    this.startTokenRefresh();
    console.log(JSON.stringify({
      level: 30, time: Date.now(), pid: process.pid, hostname: os.hostname(),
      model: this.opts.model, sessionId: this.sessionId,
      msg: 'Codex bridge initialized',
    }));
  }

  // ── App Server Lifecycle ──

  private async startAppServer(): Promise<void> {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? '/workspace';

    const spawnEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      HOME: homeDir,
      USER: isRoot ? 'agent' : (process.env['USER'] ?? 'agent'),
      CODEX_HOME: this.getAgentCodexHome(),
    };
    if (this.platformJwtToken) {
      spawnEnv[CODEX_PLATFORM_MCP_TOKEN_ENV] = this.platformJwtToken;
    }

    // Inference backend by model: gpt-* are OpenAI-only (NOT served by Cortex —
    // routing them there yields model_not_found), so they keep using codex
    // OAuth. Local/gateway models (Qwen/GLM/…) route through Cortex with the
    // platform JWT — one credential, self-hosted, no codex OAuth to maintain.
    const inferenceModel = this.opts.model ?? '';
    const useCortexInference = !!this.platformJwtToken && !/^gpt/i.test(inferenceModel);
    if (useCortexInference) {
      const cortexBaseUrl = normalizeOpenAiBaseUrl(
        process.env['OPENAI_BASE_URL'] ?? process.env['CORTEX_BASE_URL'],
      );
      spawnEnv['OPENAI_BASE_URL'] = cortexBaseUrl;
      spawnEnv['OPENAI_API_KEY'] = this.platformJwtToken;
      delete spawnEnv['OPENAI_AUTH_TOKEN'];
      console.log(`[codex-bridge] Model '${inferenceModel}' routed through Cortex gateway (${cortexBaseUrl})`);
    } else if (this.authViaFile) {
      delete spawnEnv['OPENAI_AUTH_TOKEN'];
      delete spawnEnv['CODEX_API_KEY'];
      delete spawnEnv['OPENAI_API_KEY'];
    } else if (this.authToken) {
      spawnEnv['OPENAI_AUTH_TOKEN'] = this.authToken;
    }

    // When running as root, drop to the 'agent' user but preserve the
    // bridge-computed environment. Without -p, runuser resets CODEX_HOME and
    // provider routing vars such as OPENAI_BASE_URL/OPENAI_API_KEY, so Cortex
    // models fall back to Codex's default OpenAI endpoint.
    const spawnCmd = isRoot ? 'runuser' : this.codexPath;
    const serverArgs = ['app-server', '--listen', 'stdio://'];
    // PLAT-4205: pin gpt-* agents to the HTTP-only chatgpt-http provider + a static
    // model catalog (openai/codex#22634 WS-wedge). No-op for non-gpt / Cortex-routed
    // models, which keep the default provider/catalog.
    if (isGptCodexModel(this.opts.model)) {
      const staticCatalogPath = ensureGptStaticCatalog(
        this.opts.model, this.getAgentCodexHome(), this.codexPath);
      serverArgs.push(...buildGptCodexProviderArgs(this.opts.model, staticCatalogPath));
    }
    const spawnArgs = isRoot
      ? ['-p', '-u', 'agent', '--', this.codexPath, ...serverArgs]
      : serverArgs;

    console.log(`[codex-bridge] Starting persistent app-server: ${spawnCmd} ${spawnArgs.join(' ')}`);

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: spawnEnv,
      detached: true,
    });

    this.serverProcess = child;

    // Line-buffered NDJSON parsing for stdout (JSON-RPC messages)
    let lineBuffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      // PLAT-423: after account rotation, the old app-server may still flush
      // late notifications. Ignore superseded-process output so stale deltas or
      // failures cannot corrupt the active turn owned by the replacement server.
      if (!isCurrentBridgeChild(child, this.serverProcess)) return;
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) this.handleServerMessage(line.trim());
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => this.handleServerStderrChunk(child, chunk));

    child.on('exit', (code, signal) => {
      console.error(`[codex-bridge] App-server exited (code=${code}, signal=${signal})`);
      if (this.suppressedCodexExitProc === child) {
        this.suppressedCodexExitProc = null;
        console.log('[codex-bridge] App-server exit was expected for account rotation; active turn remains pending');
        return;
      }
      if (!isCurrentBridgeChild(child, this.serverProcess)) {
        console.log('[codex-bridge] Ignoring exit from superseded app-server process');
        return;
      }
      this.serverReady = false;
      this.serverProcess = null;
      // Reject any pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('App-server process exited'));
      }
      this.pendingRequests.clear();
      // Complete any active turn, except for intentional auth/account rotation.
      if (this.activeTurnResolve) {
        this.activeTurnResolve();
        this.activeTurnResolve = null;
      }
    });

    // Wait for process to be ready — poll until stdin is writable
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (!this.serverProcess || this.serverProcess.exitCode !== null) {
        throw new Error('App-server process exited during startup');
      }
      if (this.serverProcess.stdin?.writable) break;
    }

    if (!this.serverProcess?.stdin?.writable) {
      throw new Error('App-server stdin not writable after 15s');
    }

    // Send initialize request
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const result = await this.rpcRequest('initialize', {
      clientInfo: { name: 'shizuha-codex-bridge', version: '1.0.0' },
      capabilities: {
        // Codex 0.144.x gates externally managed ChatGPT access tokens behind
        // the experimental API capability. This mode is specifically designed
        // for a client-owned refresh authority and never receives a refresh token.
        experimentalApi: true,
        experimental: {
          'thread/start.dynamicTools': true,
        },
      },
    }) as Record<string, unknown>;

    console.log(`[codex-bridge] Initialize response: capabilities received`);

    // Send initialized notification
    this.rpcNotify('initialized', {});
    if (this.brokerCodexAuth) {
      await this.installExternalBrokerAuth(this.brokerCodexAuth);
    }
    this.serverReady = true;
    void this.processQueue();
  }

  private async installExternalBrokerAuth(account: BrokerCodexAuthPayload): Promise<void> {
    const result = await this.rpcRequest('account/login/start', {
      type: 'chatgptAuthTokens',
      accessToken: account.accessToken,
      chatgptAccountId: account.accountId,
      ...(account.chatgptPlanType ? { chatgptPlanType: account.chatgptPlanType } : {}),
    }) as Record<string, unknown>;
    if (result?.type !== 'chatgptAuthTokens') {
      throw new Error('Codex app-server rejected external ChatGPT auth');
    }
    console.log(`[codex-bridge] Installed Hive-managed external ChatGPT auth (${account.email})`);
  }

  /** Create a Codex thread with model/instructions config. */
  private async createThread(): Promise<string> {
    // A clean-context retry must not race thread/start ahead of the previous
    // thread's unload. In production each thread owns several large MCP proxy
    // processes, so that race becomes unbounded RSS growth.
    await this.codexThreadCleanupPromise;
    const params: Record<string, unknown> = {
      model: this.opts.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    };
    // B3/L1406: if we just rotated accounts, inject the prior conversation as context
    // so the new thread is not blank mid-session. rotationConversationContext is a
    // best-effort recap; it supplements (not replaces) the agent's full system prompt.
    const rotCtx = this.rotationConversationContext;
    this.rotationConversationContext = null;
    const baseInstructions = rotCtx
      ? (this.opts.contextPrompt ? `${this.opts.contextPrompt}\n\n${rotCtx}` : rotCtx)
      : this.opts.contextPrompt;
    if (baseInstructions) {
      params.baseInstructions = baseInstructions;
    }

    const result = await this.rpcRequest('thread/start', params) as Record<string, unknown>;
    const thread = result.thread as Record<string, unknown> | undefined;
    const threadId = (thread?.id ?? result.threadId ?? '') as string;
    if (!threadId) {
      throw new Error('thread/start did not return a thread ID');
    }
    this.currentCodexThreadInputTokens = 0;
    this.currentCodexThreadOutputTokens = 0;
    console.log(`[codex-bridge] Thread created: ${threadId}`);
    return threadId;
  }

  /** Stop retaining a loaded Codex thread and its per-thread MCP process set.
   *
   * `thread/archive` only moves persisted history. `thread/unsubscribe` is the
   * app-server lifecycle operation that unloads a thread once this bridge is
   * its final subscriber. The cleanup is serialized with createThread(), while
   * an app-server replacement safely makes the old cleanup unnecessary because
   * process exit reaps the whole old tree.
   */
  private retireCodexThread(reason: string): void {
    const threadId = this.codexThreadId;
    this.codexThreadId = null;
    if (!threadId) return;

    const ownerProcess = this.serverProcess;
    if (!this.serverReady || !ownerProcess || ownerProcess.exitCode !== null) {
      return;
    }

    const priorCleanup = this.codexThreadCleanupPromise;
    this.codexThreadCleanupPromise = priorCleanup
      .catch(() => undefined)
      .then(async () => {
        if (
          this.serverProcess !== ownerProcess
          || !this.serverReady
          || ownerProcess.exitCode !== null
        ) {
          return;
        }
        try {
          const result = await this.rpcRequest('thread/unsubscribe', { threadId }) as Record<string, unknown>;
          console.log(
            `[codex-bridge] Thread unloaded: ${threadId} ` +
            `(status=${String(result['status'] ?? 'unknown')}, reason=${reason})`,
          );
        } catch (err) {
          // A replacement app-server reaps its predecessor's child tree. An
          // unsubscribe failure on the still-current server is visible, but it
          // must not wedge the queue forever.
          console.warn(
            `[codex-bridge] Failed to unload thread ${threadId} ` +
            `(reason=${reason}): ${(err as Error).message}`,
          );
        }
        // Codex 0.144.x acknowledges thread/unsubscribe but leaves the
        // thread's five MCP proxy children resident under app-server. A busy
        // ready queue therefore adds roughly 1 GiB per clean heartbeat thread
        // until the 8 GiB container is OOM-killed. Replacing the idle
        // app-server tree is the only lifecycle boundary that deterministically
        // reaps those descendants. This remains serialized with createThread()
        // through codexThreadCleanupPromise, so direct work can queue but can
        // never race onto the retiring process.
        if (/heartbeat/i.test(reason)) {
          await this.recycleCodexAppServerAfterAutonomousThread(ownerProcess, reason);
        }
      });
  }

  private async recycleCodexAppServerAfterAutonomousThread(
    ownerProcess: ChildProcess,
    reason: string,
  ): Promise<void> {
    if (
      this.serverProcess !== ownerProcess
      || !this.serverReady
      || ownerProcess.exitCode !== null
    ) {
      return;
    }

    console.log(`[codex-bridge] Recycling idle app-server tree after ${reason}`);
    this.serverReady = false;
    this.suppressedCodexExitProc = ownerProcess;
    // Fence old stdout before signalling the process group. The next thread is
    // created only after startAppServer() completes below.
    this.serverProcess = null;
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('App-server recycled after autonomous heartbeat'));
    }
    this.pendingRequests.clear();

    const gracefulExit = new Promise<void>((resolve) => ownerProcess.once('exit', () => resolve()));
    this.signalCodexTree(ownerProcess, 'SIGTERM');
    await Promise.race([
      gracefulExit,
      sleep(5000),
    ]);
    if (ownerProcess.exitCode === null) {
      const forcedExit = new Promise<void>((resolve) => ownerProcess.once('exit', () => resolve()));
      this.signalCodexTree(ownerProcess, 'SIGKILL');
      await Promise.race([
        forcedExit,
        sleep(1000),
      ]);
    }

    this.codexThreadId = null;
    await this.startAppServer();
    console.log(`[codex-bridge] Idle app-server recycle complete after ${reason}`);
  }

  /** Send a user message as a new turn. */
  private async sendTurn(message: string): Promise<void> {
    if (!this.codexThreadId) {
      this.codexThreadId = await this.createThread();
    }

    const params: Record<string, unknown> = {
      threadId: this.codexThreadId,
      input: [{ type: 'text', text: message }],
    };

    if (this.opts.reasoningEffort) {
      const effort = normalizeCodexEffort(this.opts.reasoningEffort);
      if (effort) {
        params.effort = effort;
      }
      if (effort !== String(this.opts.reasoningEffort).toLowerCase()) {
        console.log(
          `[codex-bridge] reasoning effort ${JSON.stringify(this.opts.reasoningEffort)} normalized to ${JSON.stringify(effort)} for app-server compatibility`,
        );
      }
    }

    // turn/start returns immediately, events come as notifications
    await this.rpcRequest('turn/start', params);
  }

  // ── JSON-RPC Transport ──

  private sendToServer(msg: string): void {
    if (this.serverProcess?.stdin?.writable) {
      this.serverProcess.stdin.write(msg + '\n');
    }
  }

  private rpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = String(this.nextRpcId++);
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 120_000);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.sendToServer(JSON.stringify(msg));
    });
  }

  private rpcNotify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.sendToServer(JSON.stringify(msg));
  }

  /** Handle a JSON-RPC message from the app-server stdout. */
  private handleServerMessage(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Skip non-JSON lines (e.g., tracing output)
    }

    // Response to a pending request
    if (msg.id !== undefined && !msg.method) {
      const id = String(msg.id);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (msg.error) {
          pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server request (needs response from us — e.g., approval requests)
    if (msg.id !== undefined && msg.method) {
      void this.handleServerRequest(msg);
      return;
    }

    // Server notification (no id)
    if (msg.method) {
      // Debug: log notifications with item data
      if (msg.method?.includes('item')) {
        const item = (msg.params as any)?.item;
        const commandDelta = msg.method.includes('commandExecution/outputDelta')
          || msg.method.includes('command_execution/output_delta');
        if (commandDelta) {
          // A test/build can emit tens of thousands of deltas. Logging the first
          // 500 bytes of EVERY chunk flooded pod logs and hid the useful lifecycle
          // events. The bridge still forwards every byte and now reports aggregate
          // byte counts in turn telemetry; raw deltas remain an explicit break-glass
          // option for a single pod.
          if (process.env['SHIZUHA_CODEX_LOG_OUTPUT_DELTAS'] === '1') {
            const delta = stringValue((msg.params as any)?.delta).slice(0, 500);
            const stream = (msg.params as any)?.stream ?? (msg.params as any)?.channel ?? 'stdout';
            console.log(`[codex-rpc] ${msg.method} item.type=commandExecution output=${JSON.stringify(delta)} stream=${stream}`);
          }
          this.handleServerNotification(msg);
          return;
        }
        // For MCP tool calls, surface server/tool/status/error (no args — may be
        // sensitive) so tool failures are visible in ops logs.
        let extra = '';
        if (item?.type === 'mcpToolCall') {
          extra = ` server=${item.server} tool=${item.tool} status=${item.status}${item.error ? ` err=${JSON.stringify(item.error).slice(0, 200)}` : ''}`;
        } else if (item?.type === 'commandExecution' || item?.type === 'command_execution') {
          const command = extractCommandString(item).slice(0, 300);
          extra = ` command=${JSON.stringify(command)} status=${item.status ?? ''}`;
        }
        console.log(`[codex-rpc] ${msg.method} item.type=${item?.type} text=${(item?.text ?? '').slice(0, 50)} keys=${Object.keys(item ?? {}).join(',')}${extra}`);
      } else if (msg.method?.includes('turn')) {
        console.log(`[codex-rpc] ${msg.method} params_keys=${Object.keys(msg.params ?? {}).join(',')}`);
      }
      this.handleServerNotification(msg);
    }
  }

  /** Handle server requests (approval prompts, etc.) */
  private async handleServerRequest(msg: JsonRpcMessage): Promise<void> {
    const method = msg.method!;

    if (method === 'account/chatgptAuthTokens/refresh') {
      try {
        const previousEntryId = this.activeBrokerModelToken?.entryId ?? '';
        const brokerToken = await fetchBrokerModelToken(
          'openai',
          8000,
          {
            forceRefresh: true,
            preferredEntryId: previousEntryId,
            stickyKey: this.brokerStickyKey(),
          },
        );
        const brokerPayload = brokerToken ? parseBrokerCodexPayload(brokerToken.token) : null;
        if (!brokerToken || !brokerPayload) {
          throw new Error('broker returned no usable access token');
        }

        this.activeBrokerModelToken = brokerToken;
        this.brokerCodexAuth = brokerPayload;
        this.codexActiveAccountEmail = brokerPayload.email;
        this.hasAuth = true;
        const isRoot = process.getuid?.() === 0;
        const agentCodexDir = this.getAgentCodexHome();
        await this.writeBrokerCodexAuth(
          brokerPayload,
          agentCodexDir,
          path.join(agentCodexDir, 'auth.json'),
          isRoot,
        );
        this.sendToServer(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            accessToken: brokerPayload.accessToken,
            chatgptAccountId: brokerPayload.accountId,
            chatgptPlanType: brokerPayload.chatgptPlanType ?? null,
          },
        }));
        console.log(`[codex-bridge] Refreshed external ChatGPT auth through Hive (${brokerPayload.email}, label=${brokerToken.label})`);
      } catch (err) {
        this.sendToServer(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32002,
            message: 'Hive could not refresh external ChatGPT auth',
          },
        }));
        console.warn(`[codex-bridge] Hive external ChatGPT auth refresh failed: ${(err as Error).message}`);
      }
      return;
    }

    // Auto-approve everything (dangerously-bypass-approvals mode)
    if (method === 'codex/approvalRequest' || method === 'approval/request') {
      // Respond with approval
      this.sendToServer(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { approved: true, decision: 'approve' },
      }));
      return;
    }

    // Default: approve unknown server requests
    this.sendToServer(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {},
    }));
  }

  /** Handle server notifications (events streamed during turn execution). */
  private handleServerNotification(msg: JsonRpcMessage): void {
    const method = msg.method!;
    const params = msg.params ?? {};

    // Strip codex/event/ prefix if present
    const eventName = method.startsWith('codex/event/')
      ? method.slice('codex/event/'.length)
      : method;

    const threadId = this.activeThreadId;
    if (!threadId) return; // No active execution to forward to

    const markModelProgress = (): void => {
      const now = Date.now();
      this.activeTurnFirstModelEventAt ??= now;
      this.activeTurnLastProgressAt = now;
      this.activeTurnStallAlerted = false;
      this.lastActivityAt = now;
    };

    switch (eventName) {
      case 'thread/started':
        // Thread created notification — already handled in createThread
        break;

      case 'turn/started':
        // Turn beginning — reset per-turn output tracker and emit session_start equivalent
        this.currentTurnHasOutput = false;
        this.activityPhase.markThinking();
        this.activeTurnFirstModelEventAt = null;
        this.activeTurnLastProgressAt = null;
        this.activeTurnToolCalls = 0;
        this.activeTurnToolFailures = 0;
        this.activeTurnOutputBytes = 0;
        this.activeTurnContextInputTokens = null;
        this.activeTurnCachedInputTokens = null;
        this.activeTurnModelContextWindow = null;
        this.activeTurnStallAlerted = false;
        this.broadcastToThread(threadId, {
          type: 'session_start',
          execution_id: threadId,
          data: {
            session_id: this.sessionId,
            model: this.opts.model,
            ...(this.activeMessageId ? { message_id: this.activeMessageId } : {}),
          },
        });
        break;

      case 'agent_message_delta': {
        // Streaming text content
        const delta = (params.delta ?? '') as string;
        if (delta) {
          markModelProgress();
          this.currentTurnHasOutput = true;
          this.accumulatedContent += delta;
          this.codexActiveTurnStreamedState = true;
          this.broadcastToThread(threadId, {
            type: 'content',
            execution_id: threadId,
            data: { delta },
          });
          this.activityPhase.markResponding();
        }
        break;
      }

      // Item-level events (v2 protocol)
      case 'item/started': {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;
        if (itemType !== 'userMessage' && itemType !== 'user_message') {
          markModelProgress();
        }
        if (itemType === 'command_execution' || itemType === 'commandExecution') {
          this.activeTurnToolCalls++;
          this.codexActiveTurnStreamedState = true;
          this.activityPhase.markTool('shell');
          this.broadcastToThread(threadId, {
            type: 'tool_start',
            execution_id: threadId,
            data: { tool: 'shell', input: { command: extractCommandString(item) }, tool_call_id: item.id },
          });
        } else if (itemType === 'file_change' || itemType === 'fileChange') {
          this.activeTurnToolCalls++;
          this.codexActiveTurnStreamedState = true;
          this.activityPhase.markTool('file_change');
          this.broadcastToThread(threadId, {
            type: 'tool_start',
            execution_id: threadId,
            data: { tool: 'file_change', input: { path: item.path ?? '' }, tool_call_id: item.id },
          });
        } else if (itemType === 'mcpToolCall' || itemType === 'mcp_tool_call') {
          this.activeTurnToolCalls++;
          this.codexActiveTurnStreamedState = true;
          this.activityPhase.markTool(`mcp:${String(item.server ?? '?')}/${String(item.tool ?? '?')}`);
          this.broadcastToThread(threadId, {
            type: 'tool_start',
            execution_id: threadId,
            data: {
              tool: `mcp:${String(item.server ?? '?')}/${String(item.tool ?? '?')}`,
              tool_call_id: item.id,
            },
          });
        }
        break;
      }

      case 'item/commandExecution/outputDelta':
      case 'item/command_execution/output_delta': {
        const delta = stringValue(params.delta);
        if (delta) {
          markModelProgress();
          this.activeTurnOutputBytes += Buffer.byteLength(delta);
          this.currentTurnHasOutput = true;
          this.codexActiveTurnStreamedState = true;
          this.broadcastToThread(threadId, {
            type: 'tool_output',
            execution_id: threadId,
            data: {
              tool: 'shell',
              output: delta,
              stream: params.stream ?? params.channel ?? 'stdout',
              tool_call_id: params.itemId ?? params.item_id,
            },
          });
        }
        break;
      }

      case 'item/commandExecution/terminalInteraction':
      case 'item/command_execution/terminal_interaction':
        // Codex emits this while it remains attached to a long-running command
        // even when the command has no new stdout. It is explicit child/tool
        // liveness and must renew the no-progress lease.
        markModelProgress();
        break;

      // Streaming text deltas from agent messages
      case 'item/agentMessage/delta': {
        const delta = (params.delta ?? params.text ?? '') as string;
        if (delta) {
          markModelProgress();
          this.currentTurnHasOutput = true;
          this.accumulatedContent += delta;
          this.codexActiveTurnStreamedState = true;
          this.activityPhase.markResponding();
          this.broadcastToThread(threadId, {
            type: 'content',
            execution_id: threadId,
            data: { delta },
          });
        }
        break;
      }

      case 'item/completed': {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;
        if (itemType !== 'userMessage' && itemType !== 'user_message') {
          markModelProgress();
        }

        // agentMessage (camelCase — Codex app-server protocol)
        if (itemType === 'agentMessage' || itemType === 'agent_message') {
          const text = (item.text as string) ?? '';
          // Only count as real output when there is non-empty text. An empty
          // agentMessage from a rate-limited/invalid backend must NOT set this flag —
          // it would reset the empty-turn streak and hide exactly the PLAT-392 failure
          // this detector exists to catch. Delta events (agent_message_delta) already
          // set the flag when content arrives incrementally.
          if (text) {
            this.currentTurnHasOutput = true;
            this.codexActiveTurnStreamedState = true;
            // Emit full text only if we haven't already streamed it via deltas
            if (!this.accumulatedContent) {
              this.accumulatedContent = text;
              this.broadcastToThread(threadId, {
                type: 'content',
                execution_id: threadId,
                data: { delta: text },
              });
            }
          }
        } else if (itemType === 'command_execution' || itemType === 'commandExecution') {
          // Tool calls are real output.
          this.currentTurnHasOutput = true;
          this.codexActiveTurnStreamedState = true;
          const exitCode = item.exitCode ?? item.exit_code ?? 0;
          const commandFailed = exitCode !== 0 || item.status === 'failed';
          if (commandFailed) this.activeTurnToolFailures++;
          if (this.activeTurnIsHeartbeat) {
            this.heartbeatToolCalls.push({ name: 'exec_command' });
            this.heartbeatToolResults.push({
              content: compactText(item.aggregatedOutput ?? item.output ?? ''),
              isError: commandFailed,
            });
          }
          this.broadcastToThread(threadId, {
            type: 'tool_complete',
            execution_id: threadId,
            data: {
              tool: 'shell',
              is_error: commandFailed,
              exit_code: exitCode,
              duration_ms: item.durationMs ?? item.duration_ms,
              output: compactText(item.aggregatedOutput ?? item.output ?? ''),
              tool_call_id: item.id,
            },
          });
          this.activityPhase.endTool();
        } else if (itemType === 'file_change' || itemType === 'fileChange') {
          // Both snake_case (Codex REST protocol) and camelCase (app-server protocol)
          // variants count as real tool output. Missing fileChange here would cause
          // successful file-edit turns to be counted as empty (PLAT-394 P2).
          this.currentTurnHasOutput = true;
          this.codexActiveTurnStreamedState = true;
          if (this.activeTurnIsHeartbeat) {
            this.heartbeatToolCalls.push({ name: 'apply_patch' });
            this.heartbeatToolResults.push({ content: item.path ?? '', isError: false });
          }
          this.broadcastToThread(threadId, {
            type: 'tool_complete',
            execution_id: threadId,
            data: { tool: 'file_change', is_error: false, path: item.path ?? '' },
          });
          this.activityPhase.endTool();
        } else if (itemType === 'mcpToolCall' || itemType === 'mcp_tool_call') {
          if (this.activeTurnIsHeartbeat) {
            const observation = buildHeartbeatToolObservationFromCodexMcpItem(item);
            this.heartbeatToolCalls.push(observation.toolCall);
            this.heartbeatToolResults.push(observation.toolResult);
          }
          if (isMessageUserToolCall(item.server, item.tool)) {
            this.activeConnectMessageUserCalled = true;
          }
          // An MCP tool call IS real model output — the model invoked a tool, so the
          // turn is not empty (counted even if the tool itself errored, exactly like
          // command_execution above). Without this, MCP-only heartbeats/actions —
          // whose turns contain only mcpToolCall items — are mis-counted as empty and
          // trip the PLAT-392 exit-42 path, killing a working agent (kei review #5).
          this.currentTurnHasOutput = true;
          if ((item.status as string) === 'failed' || Boolean(item.error)) {
            this.activeTurnToolFailures++;
          }
          this.broadcastToThread(threadId, {
            type: 'tool_complete',
            execution_id: threadId,
            data: {
              tool: `mcp:${(item.server as string) ?? '?'}/${(item.tool as string) ?? '?'}`,
              is_error: (item.status as string) === 'failed' || Boolean(item.error),
            },
          });
          this.activityPhase.endTool();
        }
        // userMessage / user_message completions intentionally do NOT set
        // currentTurnHasOutput — they are the user's input, not assistant output.
        break;
      }

      case 'thread/tokenUsage/updated':
      case 'thread/token_usage/updated': {
        // A fresh model-usage frame also proves that the app-server turn is
        // advancing, even when no user-visible content delta accompanies it.
        markModelProgress();
        // The app-server reports token usage HERE (not on turn/completed, whose
        // params are just {threadId, turn}). params.tokenUsage.total is cumulative
        // for the current Codex thread. Convert monotonic thread totals to deltas
        // before adding them to the bridge's persisted lifetime totals.
        const tu = (params['tokenUsage'] ?? {}) as Record<string, unknown>;
        const total = (tu['total'] ?? {}) as Record<string, number>;
        const last = (tu['last'] ?? {}) as Record<string, number>;
        if (typeof total['inputTokens'] === 'number') {
          const next = Math.max(this.currentCodexThreadInputTokens, total['inputTokens']);
          this.totalInputTokens += next - this.currentCodexThreadInputTokens;
          this.currentCodexThreadInputTokens = next;
        }
        if (typeof total['outputTokens'] === 'number') {
          const next = Math.max(this.currentCodexThreadOutputTokens, total['outputTokens']);
          this.totalOutputTokens += next - this.currentCodexThreadOutputTokens;
          this.currentCodexThreadOutputTokens = next;
        }
        // Codex 0.144+ explicitly separates cumulative billable usage (`total`)
        // from the latest model request (`last`). A tool-heavy turn can bill tens
        // of millions of repeated input tokens while occupying only ~100k of the
        // context window. Never report the cumulative delta as context pressure.
        if (typeof last['inputTokens'] === 'number') {
          this.activeTurnContextInputTokens = Math.max(0, last['inputTokens']);
        }
        if (typeof last['cachedInputTokens'] === 'number') {
          this.activeTurnCachedInputTokens = Math.max(0, last['cachedInputTokens']);
        }
        if (typeof tu['modelContextWindow'] === 'number' && tu['modelContextWindow'] > 0) {
          this.activeTurnModelContextWindow = tu['modelContextWindow'];
        }
        break;
      }

      case 'turn/completed':
      case 'turn_completed':
      case 'task_complete': {
        // Codex app-server v2 reports every terminal status through
        // turn/completed. A failed turn therefore used to enter the empty-turn
        // path, discard turn.status/turn.error, and schedule mandatory Pulse
        // observation retries against the same deterministic provider failure.
        // Classify the structured terminal result before any empty-turn logic.
        const completion = classifyCodexTurnCompletion(params);
        if (completion.status !== 'completed' || completion.category !== 'none') {
          this.handleCodexTurnFailure(threadId, completion);
          break;
        }
        // PLAT-394: detect empty turns (silent model failure — bad/rate-limited model).
        // Must happen before resetting currentTurnHasOutput so we capture the full turn.
        // Only escalate when the provider produced *nothing* (no reasoning/tools/text).
        // Connect silence + model-only (reasoning/empty final) turns are not usage-limit.
        const connectInjectTurn = isConnectInjectTurn(this.activeQueuedMessage);
        const modelProducedEvents = this.activeTurnFirstModelEventAt !== null
          || this.activeTurnToolCalls > 0
          || this.currentTurnHasOutput;
        const escalateEmptyAsProvider = shouldEscalateEmptyTurnAsProviderFailure({
          isConnectInject: connectInjectTurn,
          modelProducedEvents,
          isSilentSystemUpdate: isSilentSystemUpdateTurn(this.activeTurnContent),
        });
        let emptyTurnTrigger: EmptyTurnFailoverTrigger | null = null;
        if (!this.currentTurnHasOutput && isSilentSystemUpdateTurn(this.activeTurnContent)) {
          // Task-update DMs can be informational echoes of work the agent just
          // performed. A silent no-op is valid here and must not look like the
          // Codex backend empty-turn/rate-limit failure pattern.
          if (this.consecutiveEmptyTurns > 0) {
            console.log(`[codex-bridge] Silent system task-update turn — resetting empty-turn streak (was ${this.consecutiveEmptyTurns})`);
          }
          this.consecutiveEmptyTurns = 0;
          this.recordEmptyTurnOutcome(false);
        } else if (!this.currentTurnHasOutput && !escalateEmptyAsProvider) {
          // Connect inject silence, or model reasoned/streamed without tools —
          // not provider death. Do not count toward empty-turn exhaustion.
          if (connectInjectTurn) {
            if (this.consecutiveEmptyTurns > 0) {
              console.log(
                `[codex-bridge] Silent Connect DM inject turn — not counting as provider-empty ` +
                `(streak was ${this.consecutiveEmptyTurns})`,
              );
            }
          } else if (modelProducedEvents) {
            console.log(
              `[codex-bridge] Model-only turn (no tools/visible text) — not counting as empty-turn exhaustion`,
            );
          }
          this.recordEmptyTurnOutcome(false);
        } else if (!this.currentTurnHasOutput) {
          this.consecutiveEmptyTurns++;
          console.warn(
            `[codex-bridge] Empty turn #${this.consecutiveEmptyTurns} (model=${this.opts.model}) — ` +
            `no model events, assistant content, or tool calls produced. Likely HTTP 400 or usage-limit from Codex backend.`,
          );
          emptyTurnTrigger = this.recordEmptyTurnOutcome(true);
          if (emptyTurnTrigger) {
            console.error(
              `[codex-bridge] Empty-turn failover trigger on model "${this.opts.model}": ` +
              `${this.describeEmptyTurnTrigger(emptyTurnTrigger)} — attempting broker rotation/model failover.`,
            );
            // PLAT-907/PLAT-1136: a sustained empty-turn streak is only a weak
            // usage-limit signal. Try a broker refetch/restart, but do not cool the
            // shared token pool unless Codex emits an explicit provider-limit error.
            void this.rotateCodexAccountOnExhaustion();
          }
        } else {
          if (this.consecutiveEmptyTurns > 0) {
            console.log(`[codex-bridge] Turn produced output — resetting empty-turn streak (was ${this.consecutiveEmptyTurns})`);
          }
          this.consecutiveEmptyTurns = 0;
          this.codexEmptyTurnExhaustedEntryIds.clear();
          this.recordEmptyTurnOutcome(false);
          if (this.providerUnavailable) {
            this.providerUnavailable = false;
            this.providerUnavailableReason = null;
            clearProviderUnavailableMarker();
          }
          // Process-up only proves that the bridge booted. Restore durable
          // routing availability only after the provider has produced a real
          // assistant/tool event; otherwise every CrashLoop restart briefly
          // re-enables an exhausted agent and attracts work it cannot execute.
          if (!this.availabilityConfirmedHealthy) {
            this.availabilityConfirmedHealthy = true;
            void this.markAgentAvailability(true, '');
          }
        }
        this.currentTurnHasOutput = false;

        // Turn finished. Token totals are maintained by the thread/tokenUsage/updated
        // handler (turn/completed carries no usage); here we just count the turn and
        // persist a snapshot of the latest totals.
        this.turnCount++;
        // Telemetry: capture this turn's output volume + wall time + push a fresh
        // snapshot to the platform on turn end (mirrors claude-bridge).
        {
          const _now = Date.now();
          // Duration starts when THIS execution acquired the latch. The old
          // calculation used the previous completion timestamp and therefore
          // charged all idle time to the next turn (15m idle + 1m work looked
          // like a 16m turn and rounded healthy throughput down to 0 tok/s).
          const turnStartedAt = this.activeThreadStartedAt ?? _now;
          this.lastTurnDurationMs = Math.max(1, _now - turnStartedAt);
          this.lastTurnTtftMs = this.activeTurnFirstModelEventAt === null
            ? null
            : Math.max(0, this.activeTurnFirstModelEventAt - turnStartedAt);
          const billedInputTokens = Math.max(0, this.totalInputTokens - this.inputAtLastComplete);
          this.lastTurnBilledInputTokens = billedInputTokens;
          this.lastTurnInputTokens = this.activeTurnContextInputTokens ?? billedInputTokens;
          this.lastTurnCachedInputTokens = this.activeTurnCachedInputTokens ?? 0;
          this.lastTurnModelContextWindow = this.activeTurnModelContextWindow;
          this.lastTurnOutputTokens = Math.max(0, this.totalOutputTokens - this.outputAtLastComplete);
          this.lastTurnToolCalls = this.activeTurnToolCalls;
          this.lastTurnToolFailures = this.activeTurnToolFailures;
          this.lastTurnOutputBytes = this.activeTurnOutputBytes;
          this.inputAtLastComplete = this.totalInputTokens;
          this.outputAtLastComplete = this.totalOutputTokens;
          this.lastActivityAt = _now;
          console.log(`[codex-turn] ${JSON.stringify({
            outcome: 'completed',
            duration_ms: this.lastTurnDurationMs,
            ttft_ms: this.lastTurnTtftMs,
            input_tokens: this.lastTurnInputTokens,
            billed_input_tokens: this.lastTurnBilledInputTokens,
            cached_input_tokens: this.lastTurnCachedInputTokens,
            context_window_tokens: this.lastTurnModelContextWindow,
            output_tokens: this.lastTurnOutputTokens,
            tool_calls: this.lastTurnToolCalls,
            tool_failures: this.lastTurnToolFailures,
            command_output_bytes: this.lastTurnOutputBytes,
            heartbeat: this.activeTurnIsHeartbeat,
            queue_depth: this.messageQueue.length,
          })}`);
        }
        // Persist this turn's deltas and bump turn_count. App-server usage is
        // thread-cumulative, while StateStore is lifetime-incremental.
        this.store.updateTokens(this.sessionId, this.lastTurnBilledInputTokens, this.lastTurnOutputTokens);

        const completedHeartbeat = this.activeTurnIsHeartbeat;
        let continueHeartbeatDrain = false;
        let retryHeartbeatObservation = false;
        if (completedHeartbeat) {
          try {
            const outcome = recordHeartbeatQueueDrainTurn(process.env['AGENT_ID'] ?? process.env['AGENT_USERNAME'] ?? 'unknown-codex-agent', {
              toolCalls: this.heartbeatToolCalls,
              toolResults: this.heartbeatToolResults,
            });
            console.log(formatHeartbeatQueueDrainOutcomeLogLine(outcome));
            continueHeartbeatDrain = shouldScheduleHeartbeatDrainFollowup(outcome);
            // After repeated blind turns the classifier escalates not_observed
            // to needs_help. Allow at most one clean-thread rescue while still
            // not_observed; once needs_help is raised (especially with ready=0),
            // further full-model retries only burn tokens (2026-07-26 audit:
            // sara/san queue-blind storms until rate-limit).
            const pulseQueueMissing = outcome.outcome === 'not_observed'
              || (
                outcome.outcome !== 'needs_help'
                && /no Pulse queue snapshot/i.test(outcome.reason)
              );
            const shouldRetryObservation = pulseQueueMissing
              && outcome.outcome !== 'needs_help'
              && this.prepareHeartbeatObservationRetry();
            if (shouldRetryObservation) {
              retryHeartbeatObservation = true;
              console.warn('[codex-bridge] Heartbeat ended without a Pulse queue observation — scheduling one fresh-thread mandatory-tool retry');
            } else {
              // Success, needs_help, or the bounded retry was non-observing.
              this.heartbeatObservationRetryCount = 0;
            }
          } catch (err) {
            console.warn(`[codex-bridge] failed to record heartbeat queue-drain outcome: ${(err as Error).message}`);
          }
        }

        // Persist assistant message + tally output chars (uniform load metric —
        // codex token usage isn't on turn/completed, so chars is the cross-backend
        // signal the exporter scrapes and Grafana rate()s into chars/min, chars/hour).
        if (this.accumulatedContent) {
          this.totalOutputChars += this.accumulatedContent.length;
          this.store.appendMessage(this.sessionId, {
            ...(this.activeMessageId ? { id: this.activeMessageId, executionId: threadId } : {}),
            role: 'assistant',
            content: this.accumulatedContent,
            timestamp: Date.now(),
          });
          this.lastStreamedContent = this.accumulatedContent;
          this.accumulatedContent = '';
        }

        this.codexActiveTurnStreamedState = false;

        // Completed turns always consume the Connect inject. Never retain/replay
        // for silence / empty final answer / missing message_user — that death
        // spiral (DRV-104 class) marked healthy accounts provider-unavailable.
        this.pendingEmptyConnectReplay = null;
        if (this.activeQueuedMessage?.messageId) {
          this.store.markInboundProcessingCompleted(this.sessionId, this.activeQueuedMessage.messageId);
          this.connectClient?.ackMessageProcessed(this.activeQueuedMessage.messageId);
        }

        // Optional hygiene log only when a platform probe explicitly required a reply.
        if (
          this.activeConnectSenderUsername
          && !this.activeConnectMessageUserCalled
          && this.activeQueuedMessage
          && (this.activeQueuedMessage.replyObligation === 'required'
            || isExplicitConnectReplyRequest(this.activeQueuedMessage))
        ) {
          const msg = `Connect DM turn from ${this.activeConnectSenderUsername} completed without a message_user call`;
          console.warn(`[codex-bridge] ${msg}`);
          this.recentErrors.push({ ts: Date.now(), level: 'warn', msg });
          this.recentErrors = this.recentErrors.slice(-20);
        }

        // Emit complete to dashboard
        this.broadcastToThread(threadId, {
          type: 'complete',
          execution_id: threadId,
          data: {
            result: {
              total_turns: this.turnCount,
              input_tokens: this.totalInputTokens,
              output_tokens: this.totalOutputTokens,
            },
          },
        });

        this.activeThreadId = null;
        this.activeThreadStartedAt = null;
        this.activeTurnFirstModelEventAt = null;
        this.activeTurnLastProgressAt = null;
        this.activeTurnToolCalls = 0;
        this.activeTurnToolFailures = 0;
        this.activeTurnOutputBytes = 0;
        this.activeTurnStallAlerted = false;
        this.activeMessageId = null;
        this.activeTurnContent = null;
        this.activeTurnNoProgressReplayCount = 0;
        this.activeTurnIsHeartbeat = false;
        this.heartbeatToolCalls = [];
        this.heartbeatToolResults = [];
        this.activeConnectSenderUsername = null;
        this.activeConnectMessageUserCalled = false;
        this.activeQueuedMessage = null;
        this.codexActiveLimitFirstFailedAt = null;
        // Pulse is the durable autonomous state. Keeping a completed heartbeat
        // thread loaded both carries stale queue context into the next cadence
        // and retains one full MCP proxy set. A later heartbeat starts clean.
        if (completedHeartbeat) {
          this.retireCodexThread('autonomous heartbeat completed');
        }
        if (this.codexActiveAccountEmail) {
          this.codexAccountUnavailableUntil.delete(this.codexActiveAccountEmail);
        }
        if (this.activeTurnResolve) {
          this.activeTurnResolve();
          this.activeTurnResolve = null;
        }

        // Emit after releasing the latch so Hive sees `idle` (or the queued
        // successor on the next periodic sample), not a stale `working` state
        // for an already-completed turn.
        this.emitTelemetry();

        // Register autonomous follow-ups before releasing the next queued
        // low-priority notification. processQueue() arbitrates direct/user
        // traffic first, then the Pulse checkpoint, then system task notices.
        if (retryHeartbeatObservation) this.scheduleHeartbeatObservationRetry();
        else if (continueHeartbeatDrain) this.scheduleHeartbeatDrainFollowup();
        void this.processQueue();
        break;
      }

      case 'turn/failed':
      case 'turn_aborted': {
        const turn = (
          params['turn'] && typeof params['turn'] === 'object' && !Array.isArray(params['turn'])
            ? params['turn']
            : {}
        ) as Record<string, unknown>;
        this.handleCodexTurnFailure(threadId, classifyCodexTurnCompletion({
          ...params,
          turn: {
            ...turn,
            status: eventName === 'turn_aborted' ? 'interrupted' : 'failed',
          },
        }));
        break;
      }

      default:
        // Unknown notification — ignore
        break;
    }
  }

  private handleCodexTurnFailure(
    threadId: string,
    failure: CodexTurnCompletionClassification,
  ): void {
    const errorMessage = failure.message || `Codex turn ${failure.status}`;
    const failedHeartbeat = this.activeTurnIsHeartbeat;
    // A prior empty-turn exhaustion marker is intentionally sticky across
    // supervisor retries until the provider produces real assistant/tool
    // output.  A deterministic terminal error (for example cyberPolicy after
    // several successful tool calls) does not erase that proof of provider
    // health.  Clear only stale empty-turn unavailability here; auth, capacity,
    // and transport failures remain fail-closed.
    if (failure.category === 'deterministic' && this.currentTurnHasOutput) {
      this.consecutiveEmptyTurns = 0;
      this.codexEmptyTurnExhaustedEntryIds.clear();
      this.recordEmptyTurnOutcome(false);
      if (this.providerUnavailable) {
        this.providerUnavailable = false;
        this.providerUnavailableReason = null;
        clearProviderUnavailableMarker();
      }
      if (!this.availabilityConfirmedHealthy) {
        this.availabilityConfirmedHealthy = true;
        void this.markAgentAvailability(true, '');
      }
    }
    // Only re-inject on true transport/provider failure — never after a completed
    // silent turn (allowReplay=true here is intentional and narrow).
    const transientConnectReplay = failure.category === 'transient_provider'
      ? buildEmptyConnectDmReplay(
        this.activeQueuedMessage,
        true,
        this.activeConnectMessageUserCalled,
        true,
      )
      : null;
    let retryHeartbeatObservation = false;
    if (failedHeartbeat && failure.category === 'transient_provider') {
      if (this.prepareHeartbeatObservationRetry()) {
        retryHeartbeatObservation = true;
      } else {
        // The ordinary heartbeat cadence remains the eventual retry path after
        // the bounded immediate attempt; never hot-loop a network outage.
        this.heartbeatObservationRetryCount = 0;
      }
    }
    console.error(`[codex-turn-failure] ${JSON.stringify({
      status: failure.status,
      category: failure.category,
      error_code: failure.errorCode,
      http_status: failure.httpStatus,
      message: errorMessage,
      heartbeat: failedHeartbeat,
    })}`);
    this.recentErrors.push({
      ts: Date.now(),
      level: failure.category === 'interrupted' ? 'warn' : 'error',
      msg: `${failure.category}: ${errorMessage}`,
    });
    this.recentErrors = this.recentErrors.slice(-20);

    // Explicit rate/usage limits: surface provider_unavailable so Hive on-demand
    // can hibernate the seat (rest-until-workable) instead of counting it as
    // warm capacity while paid retries burn. Account rotation still runs below.
    if (failure.category === 'rate_limit') {
      this.providerUnavailable = true;
      this.providerUnavailableReason = errorMessage || 'rate_limit';
      this.emitTelemetry();
    }
    // Explicit rate/usage limits retain the bounded account-rotation path.
    // Every other structured failure terminates this attempt without scheduling
    // mandatory heartbeat retries: retrying an auth/bad-request/policy failure
    // with the same state only burns another full prompt.
    if (failure.category === 'rate_limit' && this.activeTurnContent) {
      void this.ensureCodexActiveTurnLimitRetry(errorMessage);
      return;
    }
    if (failedHeartbeat) {
      this.retireCodexThread(`autonomous heartbeat ${failure.category}`);
    }

    this.broadcastToThread(threadId, {
      type: 'error',
      execution_id: threadId,
      data: { message: errorMessage },
    });
    this.broadcastToThread(threadId, {
      type: 'complete',
      execution_id: threadId,
      data: { result: { total_turns: this.turnCount, input_tokens: this.totalInputTokens, output_tokens: this.totalOutputTokens } },
    });
    this.activeThreadId = null;
    this.activeThreadStartedAt = null;
    this.activeTurnFirstModelEventAt = null;
    this.activeTurnLastProgressAt = null;
    this.activeTurnToolCalls = 0;
    this.activeTurnToolFailures = 0;
    this.activeTurnOutputBytes = 0;
    this.activeTurnStallAlerted = false;
    this.activeMessageId = null;
    this.activeTurnContent = null;
    this.activeTurnNoProgressReplayCount = 0;
    this.activeTurnIsHeartbeat = false;
    this.heartbeatToolCalls = [];
    this.heartbeatToolResults = [];
    this.activeConnectSenderUsername = null;
    this.activeConnectMessageUserCalled = false;
    this.activeQueuedMessage = null;
    this.codexActiveLimitFirstFailedAt = null;
    // Preserve account cooldowns/permanent failures across non-limit failures.
    if (this.activeTurnResolve) {
      this.activeTurnResolve();
      this.activeTurnResolve = null;
    }
    if (
      transientConnectReplay
      && (transientConnectReplay.emptyTurnReplayCount ?? 1) <= 2
    ) {
      // Direct work is durable in Hive, but replay it locally as well so a
      // short connection failure does not wait for the delivery lease timeout.
      this.retireCodexThread('transient Connect retry');
      enqueueBridgeMessage(this.messageQueue, transientConnectReplay);
    }
    this.emitTelemetry();
    if (retryHeartbeatObservation) this.scheduleHeartbeatObservationRetry();
    void this.processQueue();
  }

  // ── Message Execution ──

  private async executeMessage(content: string, threadId: string, replay = false): Promise<void> {
    const executionGeneration = this.executionGeneration;
    if (!replay) {
      this.activeTurnNoProgressReplayCount = 0;
      this.store.appendMessage(this.sessionId, {
        id: crypto.randomUUID(),
        executionId: threadId,
        role: 'user',
        content,
        timestamp: Date.now(),
      });
    }
    this.accumulatedContent = '';
    this.activeTurnContent = content;
    this.activeTurnIsHeartbeat = isHeartbeatTurnContent(content);
    this.heartbeatToolCalls = [];
    this.heartbeatToolResults = [];
    this.codexActiveLimitFirstFailedAt = null;

    if (!this.hasAuth) {
      await this.ensureAuth();
      if (this.hasAuth && this.brokerCodexAuth && this.serverReady && this.serverProcess?.exitCode === null) {
        await this.installExternalBrokerAuth(this.brokerCodexAuth);
      }
    }
    if (!this.hasAuth) {
      this.broadcastToThread(threadId, {
        type: 'error', execution_id: threadId,
        data: { message: 'Codex not authenticated. Sign in with your ChatGPT account to use this agent.' },
      });
      this.broadcastToThread(threadId, {
        type: 'complete', execution_id: threadId,
        data: { result: { total_turns: 0, input_tokens: 0, output_tokens: 0 } },
      });
      this.activeThreadId = null;
      this.activeThreadStartedAt = null;
      this.activeMessageId = null;
      this.activeTurnContent = null;
      this.activeTurnNoProgressReplayCount = 0;
      this.activeTurnIsHeartbeat = false;
      this.heartbeatToolCalls = [];
      this.heartbeatToolResults = [];
      this.activeConnectSenderUsername = null;
      this.activeConnectMessageUserCalled = false;
      this.activeQueuedMessage = null;
      this.codexActiveLimitFirstFailedAt = null;
      this.processQueue();
      return;
    }

    // Restart app-server if it died
    if (!this.serverProcess || this.serverProcess.exitCode !== null) {
      console.log('[codex-bridge] App-server not running, restarting...');
      try {
        await this.startAppServer();
      } catch (e) {
        this.broadcastToThread(threadId, {
          type: 'error', execution_id: threadId,
          data: { message: `Failed to start app-server: ${(e as Error).message}` },
        });
        this.broadcastToThread(threadId, {
          type: 'complete', execution_id: threadId,
          data: { result: { total_turns: 0, input_tokens: 0, output_tokens: 0 } },
        });
        this.activeThreadId = null;
        this.activeThreadStartedAt = null;
        this.activeMessageId = null;
        this.activeTurnContent = null;
        this.activeTurnNoProgressReplayCount = 0;
        this.activeTurnIsHeartbeat = false;
        this.heartbeatToolCalls = [];
        this.heartbeatToolResults = [];
        this.activeConnectSenderUsername = null;
        this.activeConnectMessageUserCalled = false;
        this.activeQueuedMessage = null;
        this.codexActiveLimitFirstFailedAt = null;
        // Preserve per-account cooldowns/permanent failures; startup failure of one turn
        // must not make a still-cooling account immediately eligible.
        this.processQueue();
        return;
      }
    }

    console.log(`[codex-bridge] Sending turn: ${content.slice(0, 80)}...`);

    try {
      // Wait for turn to complete (resolved by handleServerNotification)
      await new Promise<void>((resolve, reject) => {
        this.activeTurnResolve = resolve;
        this.sendTurn(content).catch(reject);
      });
    } catch (e) {
      // A stuck-latch recovery rejects every old-child RPC to release its timers.
      // That rejection belongs to the superseded execution, not to normal turn
      // cleanup: only the serialized recovery may release the latch and drain
      // after replacement readiness. This generation fence closes that race.
      if (executionGeneration !== this.executionGeneration) {
        console.log(`[codex-bridge] Ignoring cleanup from superseded execution ${threadId}`);
        return;
      }
      const errMsg = (e as Error).message;
      console.error(`[codex-bridge] Turn error: ${errMsg}`);
      if (isCodexLimitError(errMsg) && this.activeThreadId === threadId && this.activeTurnContent) {
        this.activeTurnResolve = null;
        await this.ensureCodexActiveTurnLimitRetry(errMsg);
        return;
      }
      if (this.activeThreadId === threadId) {
        const erroredHeartbeat = this.activeTurnIsHeartbeat;
        this.broadcastToThread(threadId, {
          type: 'error', execution_id: threadId,
          data: { message: (e as Error).message },
        });
        this.broadcastToThread(threadId, {
          type: 'complete', execution_id: threadId,
          data: { result: { total_turns: this.turnCount, input_tokens: this.totalInputTokens, output_tokens: this.totalOutputTokens } },
        });
        this.activeThreadId = null;
        this.activeThreadStartedAt = null;
        this.activeMessageId = null;
        this.activeTurnContent = null;
        this.activeTurnNoProgressReplayCount = 0;
        this.activeTurnIsHeartbeat = false;
        this.heartbeatToolCalls = [];
        this.heartbeatToolResults = [];
        this.activeConnectSenderUsername = null;
        this.activeConnectMessageUserCalled = false;
        this.activeQueuedMessage = null;
        this.codexActiveLimitFirstFailedAt = null;
        if (erroredHeartbeat) {
          this.retireCodexThread('autonomous heartbeat send failure');
        }
        // Preserve per-account cooldowns/permanent failures across non-limit send failures.
        this.processQueue();
      }
    }
  }

  private broadcastToThread(threadId: string, msg: Record<string, unknown>): void {
    // HIVE-609: mirror tool events to .shizuha/.audit-log.jsonl (Hive's activity feed).
    this.recordActivity(msg);
    for (const [, client] of this.clients) {
      if (client.activeThreadId === threadId) {
        this.sendWs(client.ws, msg);
      }
    }

    // Forward to Connect (unified messaging)
    this.connectClient?.forwardBridgeEvent(threadId, msg);
  }

  private recordActivity(msg: Record<string, unknown>): void {
    try {
      if (!this.activityLog) {
        const { BridgeActivityLog, shizuhaHomeDir } = require('../shared/bridge-activity-log.js') as typeof import('../shared/bridge-activity-log.js');
        this.activityLog = new BridgeActivityLog(shizuhaHomeDir(), this.opts.agentName ?? this.opts.agentUsername ?? 'agent');
      }
      const data = (msg.data ?? {}) as Record<string, unknown>;
      const type = msg.type;
      const tool = String(data.tool ?? '');
      const callId = String(data.tool_call_id ?? '');
      if (type === 'tool_start' && tool) {
        this.activityLog.toolCall(tool, data.input ?? data.command ?? '');
      } else if (type === 'tool_complete' && tool) {
        this.activityLog.toolResult(callId, tool, data.output ?? (data.is_error ? 'error' : 'ok'), Boolean(data.is_error), data.duration_ms as number | undefined);
      }
    } catch { /* best-effort */ }
  }

  private async startExecution(
    clientId: string,
    content: string,
    conversationType: 'direct' | 'group' | 'unknown' = 'unknown',
    replyObligation: 'optional' | 'required' = 'optional',
    messageId?: string,
  ): Promise<void> {
    const isConnect = clientId.startsWith('connect:');
    const client = this.clients.get(clientId);
    if (!client && !isConnect) return;

    const threadId = isConnect ? clientId.replace('connect:', '') : crypto.randomUUID();
    // Set activeThreadId on ALL connected WS clients so broadcastToThread
    // reaches the daemon's relay WS too (not just the sender).
    for (const [, c] of this.clients) {
      c.activeThreadId = threadId;
    }
    this.activeThreadId = threadId;
    this.activeThreadStartedAt = Date.now();
    this.activeMessageId = crypto.randomUUID();
    this.activeConnectSenderUsername = isConnect ? connectReplyTrackedSenderUsername(content) : null;
    this.activeConnectMessageUserCalled = false;
    const emptyTurnReplayCount = this.nextEmptyTurnReplayCount;
    this.nextEmptyTurnReplayCount = 0;
    this.activeQueuedMessage = {
      clientId,
      content,
      ...(messageId ? { messageId } : {}),
      conversationType,
      replyObligation,
      ...(emptyTurnReplayCount > 0 ? { emptyTurnReplayCount } : {}),
    };
    const turnContent = isConnect ? buildConnectDmTurnPrompt(content, conversationType, replyObligation) : content;

    if (client) {
      this.sendWs(client.ws, {
        type: 'message_ack',
        data: { thread_id: threadId, session_id: this.sessionId },
      });
    }

    await this.executeMessage(turnContent, threadId);
  }

  private interruptActiveTurnForPriority(reason: string): void {
    if (!this.activeThreadId || !this.activeTurnResolve) return;
    const activeForMs = this.activeThreadStartedAt ? Date.now() - this.activeThreadStartedAt : 0;
    console.warn(
      `[codex-bridge] Interrupting active turn for ${reason} ` +
      `(active ${Math.round(activeForMs / 1000)}s, queue depth ${this.messageQueue.length})`,
    );
    this.rpcNotify('turn/interrupt', { threadId: this.codexThreadId ?? '' });
  }

  /** Routine Pulse notifications are edge-triggered wake hints, not work
   * payloads. Pulse remains the canonical queue, so one coalesced heartbeat
   * observes the current state and supersedes any number of stale notices. */
  private convertRoutineConnectMessageToHeartbeat(
    message: BridgeQueuedMessage,
  ): boolean {
    if (!isLowPriorityConnectSystemMessage(message)) return false;
    if (
      (this.activeThreadId && this.activeTurnIsHeartbeat)
      || this.pendingHeartbeatCheckpoint !== null
    ) return true;
    console.log(
      `[codex-bridge] [Connect] Converted routine scheduling notice to one canonical Pulse checkpoint ` +
      `(queue depth=${this.messageQueue.length})`,
    );
    this.requestHeartbeatCheckpoint({
      reason: 'routine Connect scheduling wake',
    });
    return true;
  }
  private requestHeartbeatCheckpoint(options: {
    observationRetry?: boolean;
    resetThread?: boolean;
    delayMs?: number;
    reason: string;
  }): void {
    const dueAt = Date.now() + Math.max(0, options.delayMs ?? 0);
    const existing = this.pendingHeartbeatCheckpoint;
    if (existing) {
      const incomingObservationRetry = Boolean(options.observationRetry);
      const incomingResetThread = Boolean(options.resetThread);
      const existingIsSpecial = existing.observationRetry || existing.resetThread;
      const incomingIsSpecial = incomingObservationRetry || incomingResetThread;
      const reasons = new Set(existing.reason.split('; '));
      reasons.add(options.reason);
      this.pendingHeartbeatCheckpoint = {
        observationRetry: existing.observationRetry || incomingObservationRetry,
        resetThread: existing.resetThread || incomingResetThread,
        // A plain cadence tick must not accelerate the deliberate settle delay
        // of an observation retry/fresh-thread drain. Conversely, a newly
        // scheduled special checkpoint replaces an older plain tick's timing.
        dueAt: existingIsSpecial && !incomingIsSpecial
          ? existing.dueAt
          : !existingIsSpecial && incomingIsSpecial
            ? dueAt
            : Math.min(existing.dueAt, dueAt),
        reason: [...reasons].join('; '),
      };
    } else {
      this.pendingHeartbeatCheckpoint = {
        observationRetry: Boolean(options.observationRetry),
        resetThread: Boolean(options.resetThread),
        dueAt,
        reason: options.reason,
      };
    }

    const delayMs = Math.max(0, this.pendingHeartbeatCheckpoint.dueAt - Date.now());
    console.log(
      `[codex-bridge] Heartbeat checkpoint pending ` +
      `(reason=${this.pendingHeartbeatCheckpoint.reason}, due in ${delayMs}ms, queue depth ${this.messageQueue.length})`,
    );
    this.armHeartbeatCheckpointWakeup(delayMs);
    void this.processQueue();
  }

  private armHeartbeatCheckpointWakeup(delayMs: number): void {
    if (this.heartbeatFollowupTimer) clearTimeout(this.heartbeatFollowupTimer);
    this.heartbeatFollowupTimer = setTimeout(() => {
      this.heartbeatFollowupTimer = null;
      void this.processQueue();
    }, Math.max(0, delayMs));
    this.heartbeatFollowupTimer.unref?.();
  }

  private async processQueue(): Promise<void> {
    if (!this.serverReady) return;
    if (this.activeThreadId) return;
    if (this.runtimeRollDrain.ready) return;

    const runtimeRollDraining = this.runtimeRollDrain.active;
    const action = selectBridgeQueueAction(
      this.messageQueue,
      runtimeRollDraining ? null : this.pendingHeartbeatCheckpoint?.dueAt ?? null,
    );
    if (action.kind === 'idle') {
      if (runtimeRollDraining) {
        this.connectClient?.stop();
        this.runtimeRollConnectStopped = true;
        this.runtimeRollDrain.markReady();
      }
      return;
    }
    if (action.kind === 'wait') {
      this.armHeartbeatCheckpointWakeup(action.delayMs);
      return;
    }
    if (action.kind === 'heartbeat') {
      const checkpoint = this.pendingHeartbeatCheckpoint!;
      this.pendingHeartbeatCheckpoint = null;
      if (this.heartbeatFollowupTimer) {
        clearTimeout(this.heartbeatFollowupTimer);
        this.heartbeatFollowupTimer = null;
      }
      if (checkpoint.resetThread) {
        this.retireCodexThread('bounded autonomous queue drain');
      }
      console.log(
        `[codex-bridge] Running pending heartbeat checkpoint before low-priority Connect notifications ` +
        `(reason=${checkpoint.reason}, queue depth ${this.messageQueue.length})`,
      );
      await this.fireHeartbeat(checkpoint.observationRetry);
      return;
    }

    const [next] = this.messageQueue.splice(action.index, 1);
    if (!next) return;
    const isConnect = next.clientId.startsWith('connect:');
    if (!isConnect) {
      const client = this.clients.get(next.clientId);
      if (!client || client.ws.readyState !== WebSocket.OPEN) {
        await this.processQueue();
        return;
      }
    }

    this.nextEmptyTurnReplayCount = next.emptyTurnReplayCount ?? 0;
    if (next.messageId) {
      await this.startExecution(
        next.clientId,
        next.content,
        next.conversationType,
        next.replyObligation,
        next.messageId,
      );
    } else {
      await this.startExecution(next.clientId, next.content, next.conversationType, next.replyObligation);
    }
  }

  private sendWs(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  // ── Setup ──

  // B2/L1386 fix: use an agent-specific CODEX_HOME derived from AGENT_USERNAME so
  // that one agent's auth.json rotation does not overwrite another agent's auth when
  // /home/agent/.codex is mounted as a shared volume across all codex containers.
  //
  // PLAT-1156 fix: path must NOT be under $HOME/.codex/agents/ — that is the directory
  // the Codex binary scans for agent role definitions. Placing per-agent CODEX_HOMEs
  // there causes Codex to scan every agent's .tmp/plugins/ cache, logging thousands of
  // "Ignoring malformed agent role definition" errors at startup. Use .codex-home/ as the
  // sibling root so the role scanner at $HOME/.codex/agents/ finds nothing.
  private getAgentCodexHome(): string {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const agentUsername = process.env['AGENT_USERNAME'] || 'default';
    return path.join(homeDir, '.codex-home', agentUsername);
  }

  private setupDirs(): void {
    const isRoot = process.getuid?.() === 0;
    if (!isRoot) return;

    const homeDir = '/home/agent';
    const codexHome = this.getAgentCodexHome();
    const workDir = this.opts.cwd ?? '/workspace';
    const agentUsername = process.env['AGENT_USERNAME'] || 'default';

    try {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(codexHome, { recursive: true });
      fs.mkdirSync(workDir, { recursive: true });
      chownForContainerAgent(homeDir, false);
      chownForContainerAgent(codexHome, false);
      chownForContainerAgent(workDir, false);

      // PLAT-1156: migrate auth.json from old path (.codex/agents/<u>) to new path
      // (.codex-home/<u>) so agents using Codex OAuth don't need to re-authenticate.
      const oldCodexHome = path.join(homeDir, '.codex', 'agents', agentUsername);
      const oldAuthFile = path.join(oldCodexHome, 'auth.json');
      const newAuthFile = path.join(codexHome, 'auth.json');
      if (!codexBrokerAuthorityRequired() && fs.existsSync(oldAuthFile) && !fs.existsSync(newAuthFile)) {
        try {
          fs.copyFileSync(oldAuthFile, newAuthFile);
          chownForContainerAgent(newAuthFile, false);
          console.log(`[codex-bridge] Migrated auth.json from ${oldAuthFile} to ${newAuthFile} (PLAT-1156)`);
        } catch (e) {
          console.warn(`[codex-bridge] Could not migrate auth.json: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.error(`[codex-bridge] Warning: failed to set up dirs: ${(e as Error).message}`);
    }
  }

  /** Autonomous pulse — mirrors claude-bridge. Reads HEARTBEAT.md and injects a
   *  `[Heartbeat]` turn every hour (first after 2 min) so codex agents run their
   *  pulse catch-up / escalation routine. Skipped while a turn is in flight. */

  /** Approximate model context-window size (tokens) for the context% gauge. */
  private modelMaxTokens(): number {
    const m = (this.opts.model || '').toLowerCase();
    if (m.includes('1m') || m.includes('-1m')) return 1_000_000;
    if (m.startsWith('claude')) return 200_000;
    if (m.startsWith('gpt-5') || m.startsWith('o3') || m.startsWith('o4')) return 272_000;
    if (m.startsWith('gemini')) return 1_000_000;
    return 272_000;
  }

  private static positiveNumberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  private static boundedFractionEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
  }

  private emptyTurnTriggerConfig(): EmptyTurnTriggerConfig {
    return {
      consecutiveThreshold: Math.ceil(CodexBridge.positiveNumberEnv(
        'SHIZUHA_CODEX_EMPTY_TURN_CONSECUTIVE_THRESHOLD',
        CodexBridge.EMPTY_TURN_THRESHOLD,
      )),
      windowMs: Math.ceil(CodexBridge.positiveNumberEnv(
        'SHIZUHA_CODEX_EMPTY_TURN_WINDOW_MS',
        CodexBridge.EMPTY_TURN_WINDOW_MS,
      )),
      windowMinTurns: Math.ceil(CodexBridge.positiveNumberEnv(
        'SHIZUHA_CODEX_EMPTY_TURN_WINDOW_MIN_TURNS',
        CodexBridge.EMPTY_TURN_WINDOW_MIN_TURNS,
      )),
      windowMinEmptyTurns: Math.ceil(CodexBridge.positiveNumberEnv(
        'SHIZUHA_CODEX_EMPTY_TURN_WINDOW_MIN_EMPTY_TURNS',
        CodexBridge.EMPTY_TURN_WINDOW_MIN_EMPTY_TURNS,
      )),
      windowFractionThreshold: CodexBridge.boundedFractionEnv(
        'SHIZUHA_CODEX_EMPTY_TURN_WINDOW_FRACTION',
        CodexBridge.EMPTY_TURN_WINDOW_FRACTION_THRESHOLD,
      ),
    };
  }

  private recordEmptyTurnOutcome(empty: boolean, now = Date.now()): EmptyTurnFailoverTrigger | null {
    const config = this.emptyTurnTriggerConfig();
    const pruneBefore = now - config.windowMs;
    this.emptyTurnHistory = this.emptyTurnHistory.filter((entry) => entry.ts >= pruneBefore);
    this.emptyTurnHistory.push({ ts: now, empty });
    return evaluateEmptyTurnFailoverTrigger(this.emptyTurnHistory, now, this.consecutiveEmptyTurns, config);
  }

  private emptyTurnWindowSnapshot(now = Date.now()): Record<string, unknown> {
    const config = this.emptyTurnTriggerConfig();
    const recent = this.emptyTurnHistory.filter((entry) => entry.ts >= now - config.windowMs);
    const emptyTurns = recent.filter((entry) => entry.empty).length;
    return {
      window_ms: config.windowMs,
      total_turns: recent.length,
      empty_turns: emptyTurns,
      empty_fraction: recent.length > 0 ? Number((emptyTurns / recent.length).toFixed(3)) : 0,
      threshold_fraction: config.windowFractionThreshold,
      min_turns: config.windowMinTurns,
      min_empty_turns: config.windowMinEmptyTurns,
    };
  }

  private describeEmptyTurnTrigger(trigger: EmptyTurnFailoverTrigger): string {
    if (trigger.kind === 'consecutive') {
      return `${trigger.consecutiveEmptyTurns} consecutive empty turns (threshold=${trigger.threshold})`;
    }
    return `${trigger.emptyTurns}/${trigger.totalTurns} empty turns over ${Math.round(trigger.windowMs / 1000)}s ` +
      `(fraction=${trigger.emptyFraction.toFixed(2)}, threshold=${trigger.threshold})`;
  }

  private turnStallThresholds(): {
    firstEventTimeoutMs: number;
    progressTimeoutMs: number;
    hardAgeTimeoutMs: number;
  } {
    return {
      firstEventTimeoutMs: CodexBridge.positiveNumberEnv(
        'SHIZUHA_CODEX_FIRST_EVENT_WARN_MS',
        120_000,
      ),
      progressTimeoutMs: CodexBridge.positiveNumberEnv(
        'SHIZUHA_CODEX_PROGRESS_STALL_WARN_MS',
        15 * 60_000,
      ),
      hardAgeTimeoutMs: this.heartbeatStuckMs,
    };
  }

  private currentTurnStallReason(now = Date.now()): TurnStallReason | null {
    const thresholds = this.turnStallThresholds();
    return getTurnStallReason({
      activeThreadId: this.activeThreadId,
      activeThreadStartedAt: this.activeThreadStartedAt,
      firstModelEventAt: this.activeTurnFirstModelEventAt,
      lastProgressAt: this.activeTurnLastProgressAt,
      ...thresholds,
      now,
    });
  }

  /** Telemetry snapshot reported to the platform over Connect (mirrors claude-bridge). */
  private buildTelemetry(): Record<string, unknown> {
    const now = Date.now();
    const ctxUsed = this.activeThreadId !== null
      ? (this.activeTurnContextInputTokens ?? this.lastTurnInputTokens)
      : this.lastTurnInputTokens;
    const ctxCached = this.activeThreadId !== null
      ? (this.activeTurnCachedInputTokens ?? this.lastTurnCachedInputTokens)
      : this.lastTurnCachedInputTokens;
    const maxTok = (this.activeThreadId !== null
      ? this.activeTurnModelContextWindow
      : this.lastTurnModelContextWindow) ?? this.modelMaxTokens();
    const tps = this.lastTurnDurationMs > 0
      ? Number((this.lastTurnOutputTokens / (this.lastTurnDurationMs / 1000)).toFixed(1))
      : 0;
    const activeForMs = this.activeThreadId !== null && this.activeThreadStartedAt !== null
      ? Math.max(0, now - this.activeThreadStartedAt)
      : 0;
    const noProgressForMs = this.activeThreadId === null
      ? 0
      : Math.max(0, now - (this.activeTurnLastProgressAt ?? this.activeThreadStartedAt ?? now));
    const {
      firstEventTimeoutMs: firstEventWarnMs,
      progressTimeoutMs: progressWarnMs,
    } = this.turnStallThresholds();
    const waitingForFirstEvent = this.activeThreadId !== null && this.activeTurnFirstModelEventAt === null;
    const stallReason = this.currentTurnStallReason(now);
    const turnStalled = stallReason !== null;
    const turnPhase = this.activeThreadId === null
      ? 'idle'
      : waitingForFirstEvent ? 'waiting_first_model_event' : 'running';
    const agentId = this.opts.agentId ?? process.env['AGENT_ID'] ?? null;
    return {
      v: 1,
      ts: Date.now(),
      agent_username: this.opts.agentUsername ?? null,
      agent_id: agentId,
      runtime: {
        harness: 'codex-bridge',
        model: this.opts.model,
        provider: 'openai',
        version: process.env['SHIZUHA_RUNTIME_VERSION'] ?? null,
        host: os.hostname(),
        pid: process.pid,
        uptime_ms: Date.now() - this.startTime,
      },
      context: {
        used_tokens: ctxUsed,
        cached_input_tokens: ctxCached,
        cache_pct: ctxUsed > 0 ? Number(((ctxCached / ctxUsed) * 100).toFixed(1)) : null,
        max_tokens: maxTok,
        pct: maxTok && ctxUsed ? Number(((ctxUsed / maxTok) * 100).toFixed(1)) : null,
      },
      usage: {
        total_input_tokens: this.totalInputTokens,
        total_output_tokens: this.totalOutputTokens,
        total_output_chars: this.totalOutputChars,
        turns: this.turnCount,
        tokens_per_sec: tps,
      },
      performance: {
        last_turn_duration_ms: this.lastTurnDurationMs || null,
        last_turn_ttft_ms: this.lastTurnTtftMs,
        last_turn_input_tokens: this.lastTurnInputTokens,
        last_turn_billed_input_tokens: this.lastTurnBilledInputTokens,
        last_turn_cached_input_tokens: this.lastTurnCachedInputTokens,
        last_turn_output_tokens: this.lastTurnOutputTokens,
        last_turn_tool_calls: this.lastTurnToolCalls,
        last_turn_tool_failures: this.lastTurnToolFailures,
        last_turn_command_output_bytes: this.lastTurnOutputBytes,
      },
      activity: {
        ...buildActivityTelemetry(this.activityPhase, {
          busy: this.activeThreadId !== null,
          queueDepth: this.messageQueue.length,
          lastActivityAt: this.lastActivityAt,
          extra: {
            // Preserve the older Codex-specific wait/run distinction for stall
            // diagnostics; the operator-facing phase above is thinking/responding/tool.
            turn_phase: turnPhase,
          },
        }),
        active_for_ms: activeForMs,
        no_progress_for_ms: noProgressForMs,
        first_model_event_ms: this.activeTurnFirstModelEventAt === null || this.activeThreadStartedAt === null
          ? null
          : Math.max(0, this.activeTurnFirstModelEventAt - this.activeThreadStartedAt),
        tool_calls: this.activeTurnToolCalls,
        tool_failures: this.activeTurnToolFailures,
        command_output_bytes: this.activeTurnOutputBytes,
        last_activity_ms_ago: now - this.lastActivityAt,
      },
      health: {
        // A single transient empty turn (rate-limit/usage-limit swallow) is normal
        // for usage-limited codex; only a sustained streak (the EMPTY_TURN_THRESHOLD=3
        // failover trigger) is genuinely unhealthy. Don't false-flag on streak 1-2.
        ok: this.consecutiveEmptyTurns < CodexBridge.EMPTY_TURN_THRESHOLD
          && !turnStalled
          && !this.providerUnavailable,
        turn_stalled: turnStalled,
        stall_reason: stallReason,
        first_event_warn_ms: firstEventWarnMs,
        progress_stall_warn_ms: progressWarnMs,
        empty_turn_streak: this.consecutiveEmptyTurns,
        empty_turn_window: this.emptyTurnWindowSnapshot(),
        token_pool_unavailable: this.providerUnavailable,
        provider_unavailable: this.providerUnavailable,
        provider_unavailable_reason: this.providerUnavailableReason,
        recent_errors: this.recentErrors.slice(-10),
      },
      heartbeat: agentId ? heartbeatQueueDrainTelemetry(agentId) : null,
    };
  }

  private emitTelemetry(): void {
    try {
      const telemetry = this.buildTelemetry();
      const health = telemetry['health'] as Record<string, unknown>;
      const activity = telemetry['activity'] as Record<string, unknown>;
      if (health['turn_stalled'] === true && !this.activeTurnStallAlerted) {
        this.activeTurnStallAlerted = true;
        const msg = `Codex turn stalled: ${String(health['stall_reason'])} ` +
          `(active_ms=${String(activity['active_for_ms'])}, no_progress_ms=${String(activity['no_progress_for_ms'])})`;
        console.warn(`[codex-bridge] ${msg}`);
        this.recentErrors.push({ ts: Date.now(), level: 'warn', msg });
        this.recentErrors = this.recentErrors.slice(-20);
      }
      this.connectClient?.sendTelemetry(telemetry);
    } catch { /* ignore */ }
  }

  private startTelemetry(): void {
    const ms = Number(process.env['SHIZUHA_TELEMETRY_INTERVAL_MS'] ?? 30_000);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = setInterval(() => this.emitTelemetry(), ms);
    if (this.telemetryTimer.unref) this.telemetryTimer.unref();
    this.emitTelemetry();
    console.log(`[codex-bridge] Telemetry enabled (every ${Math.round(ms / 1000)}s -> Connect)`);
  }

  private startHeartbeat(): void {
    // Honor the fleet idle-heartbeat knob — the same env the gateway reads and
    // the k8s backend renders into every agent pod (SHIZUHA_IDLE_HEARTBEAT_MS,
    // currently 15m fleet-wide). This was hardcoded to 1h, silently ignoring
    // the knob: codex agents with READY queues did ~1 minute of work per HOUR
    // (mio: 8 ready tasks stuck ready_no_progress for hours) while pods
    // advertised a 15m cadence. claude-bridge fixed this exact starvation
    // earlier ("10 min (was 1h)"). The trigger is a one-line hint and the
    // AGENTS.md routine ends with ZERO output on an empty queue, so a tight
    // cadence is cheap; floor 60s guards 0/NaN/tiny values.
    const intervalMs = resolveIdleHeartbeatMs();
    // Heartbeat is always on — the routine lives in AGENTS.md (persistent context),
    // so the periodic fire is just CODEX_HEARTBEAT_TRIGGER (one operative hint).
    // Watchdog: force-clear the busy latch if a turn has been "active" longer than
    // this (presumed dead) so heartbeats resume without a restart. Env-overridable.
    this.heartbeatStuckMs = Number(process.env['SHIZUHA_HEARTBEAT_STUCK_MS'] ?? 45 * 60 * 1000);
    const initialDelayMs = Number(process.env['SHIZUHA_HEARTBEAT_INITIAL_DELAY_MS'] ?? 15_000);
    console.log(`[codex-bridge] Heartbeat enabled (initial ${Math.round(initialDelayMs / 1000)}s, then every ${Math.round(intervalMs / 60000)}m, one-line trigger; stuck-latch watchdog ${Math.round(this.heartbeatStuckMs / 60000)}m)`);
    setTimeout(() => {
      this.fireHeartbeat();
      this.heartbeatTimer = setInterval(() => this.fireHeartbeat(), intervalMs);
    }, initialDelayMs);
    // PLAT-4179: the stuck-latch force-clear used to run ONLY on the hourly heartbeat
    // tick. With a 60m interval and a 45m threshold, a wedge starting mid-cycle was
    // missed by the first tick (busy<45m → "skipped — busy") and cleared only by the
    // second ~60m later — up to ~105m dark (observed 82m). Run the watchdog on a
    // dedicated frequent timer so a stuck latch clears within ~stuckLatchCheckMs and
    // queued work resumes immediately instead of waiting for the next hourly heartbeat.
    const _rawCheckMs = process.env['SHIZUHA_STUCK_LATCH_CHECK_MS'];
    this.stuckLatchCheckMs = parseIntervalMs(_rawCheckMs, 60_000, 5_000);
    if (_rawCheckMs !== undefined && Number(_rawCheckMs) !== this.stuckLatchCheckMs) {
      console.warn(`[codex-bridge] Ignoring invalid SHIZUHA_STUCK_LATCH_CHECK_MS="${_rawCheckMs}" — using ${this.stuckLatchCheckMs}ms`);
    }
    console.log(`[codex-bridge] Stuck-latch watchdog timer every ${Math.round(this.stuckLatchCheckMs / 1000)}s`);
    this.stuckLatchTimer = setInterval(() => {
      try {
        void this.recoverStuckLatchIfDead().catch((e) => {
          console.error(`[codex-bridge] stuck-latch watchdog error: ${(e as Error).message}`);
        });
      } catch (e) {
        console.error(`[codex-bridge] stuck-latch watchdog error: ${(e as Error).message}`);
      }
    }, this.stuckLatchCheckMs);
    if (this.stuckLatchTimer.unref) this.stuckLatchTimer.unref();
  }

  /** Fence and replace the app-server before releasing an over-age busy latch.
   *  A leaked latch would park the agent forever, while a clear-only recovery lets
   *  late events corrupt the next turn. Returns true iff it recovered a stuck turn.
   *  PLAT-4179: called both from the hourly
   *  fireHeartbeat AND the dedicated ~60s stuck-latch watchdog, so the bound is
   *  enforced within one watchdog tick instead of up to ~2× the hourly heartbeat. */
  private recoverStuckLatchIfDead(): Promise<boolean> {
    if (this.stuckLatchRecoveryPromise) return this.stuckLatchRecoveryPromise;
    const stuckThreadId = this.activeThreadId;
    const stuckStartedAt = this.activeThreadStartedAt;
    const stuckReason = this.currentTurnStallReason();
    if (stuckReason === null) {
      return Promise.resolve(false);
    }
    const stuckContent = this.activeTurnContent;
    const stuckMessageId = this.activeMessageId;
    const stuckWasHeartbeat = this.activeTurnIsHeartbeat;
    const safeNoProgressReplay = stuckReason === 'first_model_event_timeout'
      && this.activeTurnFirstModelEventAt === null
      && this.activeTurnLastProgressAt === null
      && !this.codexActiveTurnStreamedState
      && this.activeTurnToolCalls === 0
      && !this.activeConnectMessageUserCalled
      && Boolean(stuckContent)
      && this.activeTurnNoProgressReplayCount < 1;

    const busyMs = Date.now() - stuckStartedAt!;
    console.warn(
      `[codex-bridge] Stuck-latch watchdog: fencing STUCK execution ` +
      `(reason=${stuckReason}, busy=${Math.round(busyMs / 1000)}s) before queue release`,
    );
    const recovery = runSerializedStuckRecovery({
      isStuck: () => this.activeThreadId === stuckThreadId &&
        this.currentTurnStallReason() !== null,
      fenceAndRestart: async () => {
        const oldProc = this.serverProcess;
        this.serverReady = false;
        if (oldProc && oldProc.exitCode === null) this.suppressedCodexExitProc = oldProc;
        // Fence stdout immediately. Any late old-child notification now fails the
        // process-identity guard before the queue can acquire a new turn.
        this.serverProcess = null;
        // Fence executeMessage cleanup before rejecting its outstanding RPC.
        // Otherwise the rejection catch can clear activeThreadId/processQueue
        // while this recovery is still waiting for child exit/replacement ready.
        this.executionGeneration += 1;
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error('App-server superseded by stuck-latch watchdog'));
        }
        this.pendingRequests.clear();
        const deadTurnResolve = this.activeTurnResolve;
        this.activeTurnResolve = null;
        if (oldProc && oldProc.exitCode === null) {
          this.signalCodexTree(oldProc, 'SIGTERM');
          await Promise.race([
            new Promise<void>((resolve) => oldProc.once('exit', () => resolve())),
            sleep(5000),
          ]);
          if (oldProc.exitCode === null) {
            this.signalCodexTree(oldProc, 'SIGKILL');
            await Promise.race([
              new Promise<void>((resolve) => oldProc.once('exit', () => resolve())),
              sleep(1000),
            ]);
          }
        }
        deadTurnResolve?.();
        this.codexThreadId = null;
        this.accumulatedContent = '';
        this.lastStreamedContent = '';
        this.codexActiveTurnStreamedState = false;
        await this.startAppServer();
      },
      releaseLatch: () => {
        if (safeNoProgressReplay) {
          this.activeTurnNoProgressReplayCount += 1;
          this.activeThreadId = stuckThreadId;
          this.activeThreadStartedAt = Date.now();
          this.activeTurnFirstModelEventAt = null;
          this.activeTurnLastProgressAt = null;
          this.activeTurnToolCalls = 0;
          this.activeTurnToolFailures = 0;
          this.activeTurnOutputBytes = 0;
          this.activeTurnStallAlerted = false;
          this.activeMessageId = stuckMessageId;
          this.activeTurnContent = stuckContent;
          this.activeTurnIsHeartbeat = stuckWasHeartbeat;
          this.heartbeatToolCalls = [];
          this.heartbeatToolResults = [];
          for (const [, client] of this.clients) client.activeThreadId = stuckThreadId;
          console.warn(
            `[codex-bridge] Replaying no-progress execution ${stuckThreadId} once on a fresh app-server child`,
          );
          void this.executeMessage(stuckContent!, stuckThreadId!, true).catch((err) => {
            console.error(`[codex-bridge] no-progress replay failed: ${(err as Error).message}`);
          });
          return;
        }

        const terminalMessage = stuckReason === 'first_model_event_timeout'
          ? 'Codex produced no model progress and the single safe replay also stalled; the turn was aborted.'
          : 'Codex stopped making progress after model/tool activity; the turn was fenced without replay to avoid duplicate side effects.';
        this.broadcastToThread(stuckThreadId!, {
          type: 'error',
          execution_id: stuckThreadId,
          data: { message: terminalMessage },
        });
        this.broadcastToThread(stuckThreadId!, {
          type: 'complete',
          execution_id: stuckThreadId,
          data: {
            result: {
              total_turns: this.turnCount,
              input_tokens: this.totalInputTokens,
              output_tokens: this.totalOutputTokens,
            },
          },
        });
        this.activeThreadId = null;
        this.activeThreadStartedAt = null;
        this.activeTurnFirstModelEventAt = null;
        this.activeTurnLastProgressAt = null;
        this.activeTurnToolCalls = 0;
        this.activeTurnToolFailures = 0;
        this.activeTurnOutputBytes = 0;
        this.activeTurnStallAlerted = false;
        this.activeMessageId = null;
        this.activeTurnContent = null;
        this.activeTurnNoProgressReplayCount = 0;
        this.activeTurnIsHeartbeat = false;
        this.heartbeatToolCalls = [];
        this.heartbeatToolResults = [];
        this.activeConnectSenderUsername = null;
        this.activeConnectMessageUserCalled = false;
        this.activeQueuedMessage = null;
        for (const [, client] of this.clients) client.activeThreadId = null;
        // Restored (reika, PLAT-4205 review): master re-arms the heartbeat
        // checkpoint here after a stuck-latch recovery of a heartbeat turn.
        // My conflict resolution dropped it. Without this, a stalled heartbeat
        // releases the latch and then never re-requests its checkpoint, so the
        // agent recovers the latch and goes quiet -- the failure this recovery
        // path exists to prevent. It is NOT dead-variable cleanup:
        // stuckWasHeartbeat is still read by the replay path below.
        if (stuckWasHeartbeat) {
          this.requestHeartbeatCheckpoint({
            reason: `stalled heartbeat recovery (${stuckReason})`,
          });
        }
      },
      drainQueue: () => this.processQueue(),
    });
    this.stuckLatchRecoveryPromise = recovery.finally(() => {
      this.stuckLatchRecoveryPromise = null;
    });
    return this.stuckLatchRecoveryPromise;
  }

  private async fireHeartbeat(observationRetry = false): Promise<void> {
    try {
      // A cadence tick during a real heartbeat is already satisfied by that
      // checkpoint. All other busy ticks become pending scheduler state instead
      // of being discarded; the turn-boundary arbiter runs them before one-way
      // Connect system notifications.
      if (this.activeThreadId) {
        if (this.currentTurnStallReason() === null) {
          if (!observationRetry && this.activeTurnIsHeartbeat) {
            console.log('[codex-bridge] Heartbeat coalesced — an autonomous checkpoint is already active');
            return;
          }
          this.requestHeartbeatCheckpoint({
            observationRetry,
            reason: observationRetry
              ? 'observation retry became due while busy'
              : 'regular heartbeat fired while busy',
          });
          return;
        }
        await this.recoverStuckLatchIfDead();
        if (this.activeThreadId) {
          this.requestHeartbeatCheckpoint({ observationRetry, reason: 'heartbeat waiting for stuck-latch recovery drain' });
          return;
        }
      }

      // processQueue() is the sole safe-boundary arbiter. If it selected this
      // checkpoint, do not re-check the queue here: doing so can contradict the
      // selector's Pulse-before-ordinary-DM policy and synchronously re-enter
      // requestHeartbeatCheckpoint() until the stack overflows. Control-plane
      // messages already win in selectBridgeQueueAction(); ordinary queued DMs
      // remain preserved for the next terminal boundary.
      if (!observationRetry) this.heartbeatObservationRetryCount = 0;
      if (!observationRetry) {
        const preflight = await this.runPulseHeartbeatPreflight();
        // Direct work may have arrived while the bounded Pulse reads were in
        // flight. Preserve it and re-arm the checkpoint instead of racing a
        // heartbeat turn onto the same bridge.
        if (this.activeThreadId) {
          this.requestHeartbeatCheckpoint({
            reason: 'regular heartbeat preflight completed while direct work was active',
          });
          return;
        }
        const providerRecoveryProbe = this.providerUnavailable
          && !this.providerRecoveryProbeAttempted
          && shouldProbePersistedProviderUnavailable(this.providerUnavailableReason);
        if (providerRecoveryProbe) {
          // Consume this process's one-shot before launching the model turn. If
          // the provider is still empty/unavailable, the durable marker remains
          // and this process will not probe again.
          this.providerRecoveryProbeAttempted = true;
          console.log(
            '[codex-bridge] Heartbeat preflight launching one aged provider-recovery probe',
          );
        }
        if (preflight.kind === 'skip' && !providerRecoveryProbe) {
          const agentId = process.env['AGENT_ID'] ?? process.env['AGENT_USERNAME'] ?? 'unknown-codex-agent';
          const outcome = recordHeartbeatQueueDrainOutcome(agentId, {
            readyTaskCount: preflight.readyTaskCount,
            blockedTaskCount: preflight.blockedTaskCount,
            futureDueCount: preflight.futureDueCount,
            progressEventCount: 0,
            forwardedEventCount: 0,
            pulseGetMyTasksOnly: false,
            pulseGetMyAlertsObserved: true,
            pulseAlertTaskOrderValid: true,
          });
          console.log(formatHeartbeatQueueDrainOutcomeLogLine(outcome));
          console.log(
            `[codex-bridge] Heartbeat preflight skipped Codex turn — ${preflight.reason} (model_tokens=0)`,
          );
          this.emitTelemetry();
          return;
        }
        console.log(`[codex-bridge] Heartbeat preflight requires Codex turn — ${preflight.reason}`);
      }
      const prompt = observationRetry
        ? CODEX_HEARTBEAT_OBSERVATION_RETRY_TRIGGER
        : CODEX_HEARTBEAT_TRIGGER;
      // Never let an autonomous checkpoint inherit a prior direct/task thread.
      // The queue snapshot is re-read from Pulse and the unloaded predecessor's
      // MCP process set is reaped before createThread starts a fresh session.
      this.retireCodexThread('autonomous heartbeat boundary');
      // Drive a FULL turn (reasoning + MCP tools + completion) exactly like an
      // inbound message via executeMessage — NOT bare sendTurn, which fires an
      // empty isolated turn that the agent never actually acts on.
      const threadId = crypto.randomUUID();
      this.activeThreadId = threadId;
      this.activeThreadStartedAt = Date.now();
      this.activeMessageId = crypto.randomUUID();
      this.executeMessage(prompt, threadId).catch((e) => {
        console.error(`[codex-bridge] heartbeat executeMessage error: ${(e as Error).message}`);
        if (this.activeThreadId === threadId) this.activeThreadId = null;
      });
      console.log(`[codex-bridge] [telemetry] heartbeat at=${new Date().toISOString()}`);
    } catch (err) {
      console.error(`[codex-bridge] Heartbeat error: ${(err as Error).message}`);
    }
  }

  private async fetchPulseHeartbeatPage(
    platformBase: string,
    token: string,
    params: Record<string, string>,
  ): Promise<PulseHeartbeatPreflightPage> {
    const url = new URL('/pulse/api/items/', platformBase);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const rawTimeoutMs = Number(process.env['SHIZUHA_HEARTBEAT_PREFLIGHT_TIMEOUT_MS'] ?? 5_000);
    const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs >= 500
      ? rawTimeoutMs
      : 5_000;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Pulse heartbeat preflight returned HTTP ${response.status}`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const count = typeof payload['count'] === 'number' && payload['count'] >= 0
      ? payload['count']
      : Number.NaN;
    const results = Array.isArray(payload['results'])
      ? payload['results'].filter(
        (item): item is PulseHeartbeatPreflightItem => Boolean(item) && typeof item === 'object',
      )
      : [];
    if (!Number.isFinite(count)) {
      throw new Error('Pulse heartbeat preflight returned no numeric count');
    }
    return { count, results };
  }

  private async fetchPulseHeartbeatDecision(
    platformBase: string,
    token: string,
    email: string,
  ): Promise<PulseHeartbeatPreflightDecision | null> {
    const url = new URL('/pulse/api/items/heartbeat-preflight/', platformBase);
    url.searchParams.set('assignee_email', email);
    const rawTimeoutMs = Number(process.env['SHIZUHA_HEARTBEAT_PREFLIGHT_TIMEOUT_MS'] ?? 5_000);
    const timeoutMs = Number.isFinite(rawTimeoutMs) && rawTimeoutMs >= 500
      ? rawTimeoutMs
      : 5_000;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // During a rolling Pulse deployment, an old pod may not have the action
    // route yet. Preserve the already-deployed three-call preflight only for
    // that explicit compatibility case.
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Pulse heartbeat preflight returned HTTP ${response.status}`);
    }
    return parsePulseHeartbeatPreflightResponse(await response.json());
  }

  /**
   * Zero-token heartbeat gate. Any auth/transport/schema uncertainty fails open
   * to the existing model-driven heartbeat; only a complete ordered Pulse read
   * may suppress Codex.
   */
  private async runPulseHeartbeatPreflight(): Promise<PulseHeartbeatPreflightDecision> {
    const configured = (process.env['SHIZUHA_CODEX_HEARTBEAT_PREFLIGHT'] ?? '1')
      .trim().toLowerCase();
    if (['0', 'false', 'off', 'no'].includes(configured)) {
      return { kind: 'run', reason: 'zero-token heartbeat preflight disabled' };
    }

    try {
      const platformBase = this.resolvePlatformBase();
      const agentUsername = (this.opts.agentUsername ?? process.env['AGENT_USERNAME'] ?? '').trim();
      const email = (process.env['AGENT_EMAIL'] ?? (agentUsername ? `${agentUsername}@shizuha.com` : '')).trim();
      const token = await this.resolvePlatformJwt();
      if (!platformBase || !email || !token) {
        return { kind: 'run', reason: 'Pulse heartbeat preflight lacks platform URL, email, or JWT' };
      }

      let heartbeatToken = token;
      let boundedDecision: PulseHeartbeatPreflightDecision | null;
      try {
        boundedDecision = await this.fetchPulseHeartbeatDecision(
          platformBase,
          heartbeatToken,
          email,
        );
      } catch (error) {
        // Expiry can race the request even after the local JWT check. Recover
        // exactly once on the explicit authentication response; all other
        // uncertainty keeps the existing fail-open safety contract. A single
        // bounded transport retry absorbs the transient five-second Pulse tail
        // observed during fleet rollout without ever suppressing work from an
        // incomplete response.
        const reason = (error as Error).message || String(error);
        if (reason.includes('Pulse heartbeat preflight returned HTTP 401')) {
          this.platformJwtToken = '';
          const freshToken = await this.resolvePlatformJwt();
          if (!freshToken || freshToken === heartbeatToken) throw error;
          console.warn('[codex-bridge] Pulse heartbeat preflight returned HTTP 401; refreshed platform JWT and retrying once');
          heartbeatToken = freshToken;
          boundedDecision = await this.fetchPulseHeartbeatDecision(
            platformBase,
            heartbeatToken,
            email,
          );
        } else {
          const errorName = error instanceof Error ? error.name : '';
          const retryableTransportFailure = (
            errorName === 'TimeoutError'
            || errorName === 'AbortError'
            || /fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|HTTP (?:429|502|503|504)\b/i.test(reason)
          );
          if (!retryableTransportFailure) throw error;
          console.warn(`[codex-bridge] Pulse heartbeat preflight transient failure; retrying once: ${reason}`);
          boundedDecision = await this.fetchPulseHeartbeatDecision(
            platformBase,
            heartbeatToken,
            email,
          );
        }
      }
      if (boundedDecision) return boundedDecision;

      // Alerts are the first inbox by contract. A firing alert immediately
      // requires the full heartbeat; the model will then perform the canonical
      // alert -> task MCP pair before acting.
      const alerts = await this.fetchPulseHeartbeatPage(platformBase, heartbeatToken, {
        mode: 'alert',
        assignee_email: email,
        status: 'firing,acknowledged',
        page_size: '1',
      });
      if (alerts.count > 0) {
        return classifyPulseHeartbeatPreflight(alerts.count, { count: 0, results: [] }, 0);
      }

      const active = await this.fetchPulseHeartbeatPage(platformBase, heartbeatToken, {
        mode: 'task',
        assignee_email: email,
        is_active: 'true',
        queue_order: 'true',
        permission_hint: 'false',
        page_size: '1',
      });

      const first = active.results[0];
      const status = typeof first?.status === 'string'
        ? first.status.trim().toLowerCase().replace(/[\s-]+/g, '_')
        : '';
      const dueAt = typeof first?.due_date === 'string'
        ? Date.parse(first.due_date)
        : Number.NaN;
      const firstIsReady = Boolean(first)
        && status !== 'blocked'
        && !HEARTBEAT_HOLDING_STATUSES.has(status)
        && !(Number.isFinite(dueAt) && dueAt > Date.now());

      // Backlog is Pulse's explicit pull lane. Avoid a third request when the
      // ready-first active queue already proves the model has work.
      let backlogCount = 0;
      if (!firstIsReady) {
        const backlog = await this.fetchPulseHeartbeatPage(platformBase, heartbeatToken, {
          mode: 'task',
          assignee_email: email,
          status: 'backlog',
          queue_order: 'true',
          permission_hint: 'false',
          page_size: '1',
        });
        backlogCount = backlog.count;
      }

      return classifyPulseHeartbeatPreflight(0, active, backlogCount);
    } catch (err) {
      const reason = (err as Error).message || String(err);
      console.warn(`[codex-bridge] Pulse heartbeat preflight failed open: ${reason}`);
      return { kind: 'run', reason: `Pulse preflight unavailable: ${reason}` };
    }
  }

  private scheduleHeartbeatObservationRetry(): void {
    this.requestHeartbeatCheckpoint({
      observationRetry: true,
      delayMs: 1_000,
      reason: 'mandatory Pulse observation retry',
    });
  }

  /** A queue-blind heartbeat gets one clean-context rescue. Retrying the warm
   * thread first repeats the same full context and can burn another ~30k input
   * tokens before the fresh-thread attempt that actually restores tool use. */
  private prepareHeartbeatObservationRetry(): boolean {
    if (this.heartbeatObservationRetryCount >= MAX_CODEX_HEARTBEAT_OBSERVATION_RETRIES) {
      return false;
    }
    this.heartbeatObservationRetryCount++;
    this.retireCodexThread('mandatory heartbeat observation retry');
    return true;
  }

  /** Continue a non-empty autonomous queue without keeping unrelated tasks in
   * one 245k-token turn. User/Connect messages always win the boundary. */
  private scheduleHeartbeatDrainFollowup(): void {
    const rawDelay = Number(process.env['SHIZUHA_HEARTBEAT_FOLLOWUP_DELAY_MS'] ?? 1_000);
    const delayMs = Number.isFinite(rawDelay) && rawDelay >= 250 ? rawDelay : 1_000;
    this.requestHeartbeatCheckpoint({
      resetThread: true,
      delayMs,
      reason: 'bounded autonomous queue drain follow-up',
    });
  }

  /** Link bundled /opt/skills into codex's native skill roots so Codex loads them
   *  (heartbeat-protocol, pulse-workflows, …) the same way Claude does — with native
   *  skill metadata + implicit invocation — not only as inline baseInstructions.
   *  Codex scans $CODEX_HOME/skills and $HOME/.agents/skills for user-scope skills
   *  (each a dir containing SKILL.md). Our /opt/skills SKILL.md frontmatter
   *  (name/description) is already in codex's expected format. */
  private setupSkills(): void {
    try {
      const isRoot = process.getuid?.() === 0;
      const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
      const src = '/opt/skills';
      if (!fs.existsSync(src)) { console.log('[codex-bridge] No /opt/skills to link'); return; }
      const dests = [path.join(this.getAgentCodexHome(), 'skills'), path.join(homeDir, '.agents', 'skills')];
      const names = selectCodexNativeSkillNames(
        src,
        process.env['AGENT_SKILLS'] ?? '',
        process.env['AGENT_ROLE'],
        process.env['AGENT_TEAM'],
      );
      for (const dest of dests) {
        fs.mkdirSync(dest, { recursive: true });
        const selected = new Set(names);
        // Reconcile only links previously owned by this bridge. Preserve any
        // user-authored skill directory or unrelated symlink in the durable
        // Codex home while removing canonical links no longer selected by the
        // agent's current Hive role/config.
        for (const existingName of fs.readdirSync(dest)) {
          if (selected.has(existingName)) continue;
          const existing = path.join(dest, existingName);
          try {
            if (!fs.lstatSync(existing).isSymbolicLink()) continue;
            const target = path.resolve(dest, fs.readlinkSync(existing));
            if (target.startsWith(`${src}${path.sep}`)) fs.unlinkSync(existing);
          } catch { /* a concurrent/native refresh may have moved it */ }
        }
        for (const name of names) {
          const link = path.join(dest, name);
          try {
            const existing = fs.lstatSync(link);
            if (!existing.isSymbolicLink()) continue;
            const target = path.resolve(dest, fs.readlinkSync(link));
            if (!target.startsWith(`${src}${path.sep}`)) continue;
            fs.unlinkSync(link);
          } catch { /* missing or concurrently removed */ }
          try { fs.symlinkSync(path.join(src, name), link, 'dir'); }
          catch (e) { console.error(`[codex-bridge] skill link failed for ${name}: ${(e as Error).message}`); }
        }
      }
      console.log(`[codex-bridge] Linked ${names.length} relevant skills from /opt/skills into codex skill roots (${dests.join(', ')})`);
    } catch (err) {
      console.error(`[codex-bridge] setupSkills error: ${(err as Error).message}`);
    }
  }

  /** Resolve the platform base URL (Tailscale DNS, never loopback). */
  private resolvePlatformBase(): string {
    const url = process.env['SHIZUHA_PLATFORM_URL'] || '';
    if (!url || url.includes('127.0.0.1') || url.includes('localhost')) return '';
    return url.replace(/\/+$/, '');
  }

  /** Obtain and cache the agent's shizuha-id JWT for platform services. */
  private async resolvePlatformJwt(): Promise<string> {
    // The bridge is long-lived, while agent platform JWTs expire. Returning the
    // in-memory token forever made a blocked-only heartbeat fail open to Codex
    // after the token expired (Sora, 2026-07-26). Use a slightly smaller buffer
    // than AgentTokenManager's five-minute refresh window so clearing this
    // cache guarantees the manager will actually refresh rather than hand the
    // same near-expiry token back.
    if (this.platformJwtToken) {
      if (!isJwtStale(this.platformJwtToken, 4 * 60_000)) return this.platformJwtToken;
      console.log('[codex-bridge] Cached platform JWT expired/near-expiry — obtaining a fresh platform JWT');
      this.platformJwtToken = '';
    }

    const platformBase = this.resolvePlatformBase();
    let jwtToken = process.env['AGENT_ACCESS_TOKEN'] || '';
    if (jwtToken && isJwtStale(jwtToken)) {
      console.log('[codex-bridge] AGENT_ACCESS_TOKEN expired/near-expiry — obtaining a fresh platform JWT');
      jwtToken = '';
    }
    if (!jwtToken && platformBase) {
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const tm = new AgentTokenManager({
        agentUsername: this.opts.agentUsername ?? 'agent',
        agentEmail: process.env['AGENT_EMAIL'] || `${this.opts.agentUsername}@shizuha.com`,
        platformUrl: platformBase,
      });
      // Retry with exponential backoff so a transient shizuha-id outage never
      // permanently wedges the agent into running unauthenticated. Two failure
      // modes this covers: (1) the first mint losing its race to event-loop
      // starvation during codex app-server init (the fetch's abort timer fires
      // before the loop services the otherwise-fast response); (2) shizuha-id
      // being briefly down/stale after a cluster reboot (the post-recovery
      // stale-DB-pool window) — the old 4×2s (~8s) loop gave up long before
      // shizuha-id recovered, leaving codex agents stuck until a manual restart.
      // getTokenWithRetry rides it out and self-heals.
      try {
        jwtToken = (await tm.getTokenWithRetry({ maxWaitMs: 10 * 60_000 })) ?? '';
        if (jwtToken) console.log('[codex-bridge] Platform JWT obtained via shizuha-id login');
        else console.error('[codex-bridge] Platform JWT mint failed after backoff retries — will retry on next resolve');
      } catch (err) {
        console.warn(`[codex-bridge] shizuha-id login failed: ${(err as Error).message}`);
      }
    }

    // Only cache a real token — caching '' would pin the failure and block the
    // early warm-up from being retried later in setupCronMcp.
    if (jwtToken) this.platformJwtToken = jwtToken;
    return jwtToken;
  }

  private async markAgentAvailability(active: boolean, reason: string): Promise<void> {
    const platformBase = this.resolvePlatformBase();
    if (!platformBase) return;
    let token = await this.resolvePlatformJwt();
    if (!token) return;
    const url = `${platformBase}/pulse/api/agent-availability/self/`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            'X-Shizuha-Execution-Method': 'codex_app_server',
          },
          body: JSON.stringify({
            active,
            reason,
            execution_method: 'codex_app_server',
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          console.log(`[codex-bridge] AgentAvailability set active=${active}`);
          return;
        }
        if ((res.status === 401 || res.status === 403) && attempt === 0) {
          this.platformJwtToken = '';
          const fresh = await this.resolvePlatformJwt();
          if (fresh && fresh !== token) {
            token = fresh;
            console.warn(`[codex-bridge] AgentAvailability PATCH returned ${res.status}; refreshed JWT and retrying`);
            continue;
          }
        }
        console.warn(`[codex-bridge] AgentAvailability PATCH returned ${res.status} (attempt ${attempt + 1}/3)`);
      } catch (err) {
        console.warn(`[codex-bridge] AgentAvailability PATCH failed (attempt ${attempt + 1}/3): ${(err as Error).message}`);
      }
    }
  }

  private startTokenRefresh(): void {
    const platformBase = this.resolvePlatformBase();
    if (!platformBase) return;
    setTimeout(() => { void this.refreshMcpTokenOnce(platformBase); }, 60_000);
    setInterval(() => { void this.refreshMcpTokenOnce(platformBase); }, 30 * 60 * 1000);
    setInterval(() => {
      try {
        const sentinel = path.join(this.opts.cwd ?? process.cwd(), '.mcp-force-refresh');
        if (fs.existsSync(sentinel)) {
          try { fs.unlinkSync(sentinel); } catch { /* best-effort */ }
          void this.refreshMcpTokenOnce(platformBase, true);
        }
      } catch { /* best-effort */ }
    }, 5 * 1000);
  }

  private mcpUpstreamTokenFile(workDir?: string): string {
    return path.join(workDir ?? this.opts.cwd ?? process.cwd(), '.mcp-upstream-token');
  }

  private readConfigTomlBearer(configPath: string): string | undefined {
    try {
      const text = fs.readFileSync(configPath, 'utf-8');
      const headerMatch = text.match(/^\s*Authorization\s*=\s*"Bearer\s+([^"]+)"/m);
      if (headerMatch?.[1]) return headerMatch[1];
      const envMatch = text.match(/^\s*MCP_UPSTREAM_BEARER\s*=\s*"([^"]+)"/m);
      return envMatch?.[1];
    } catch {
      return undefined;
    }
  }

  private async refreshMcpTokenOnce(platformBase: string, force = false): Promise<void> {
    const workDir = this.opts.cwd ?? '/workspace';
    const codexDir = this.getAgentCodexHome();
    const configPath = path.join(codexDir, 'config.toml');
    const mcpJsonPath = path.join(workDir, '.mcp.json');
    try {
      const readJsonToken = (): string | undefined => {
        if (!fs.existsSync(mcpJsonPath)) return undefined;
        const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        const servers = mcpJson.mcpServers ?? {};
        const readTok = (s: any): string | undefined => {
          const env = s?.env?.MCP_UPSTREAM_BEARER;
          if (typeof env === 'string' && env) return env;
          const hdr = s?.headers?.Authorization ?? s?.http_headers?.Authorization;
          if (typeof hdr === 'string' && hdr.startsWith('Bearer ')) return hdr.slice(7);
          return undefined;
        };
        return Object.values(servers).map(readTok).find(Boolean) as string | undefined;
      };
      const configToken = readJsonToken() ?? this.readConfigTomlBearer(configPath);
      const tokenFile = this.mcpUpstreamTokenFile(workDir);
      let fileToken: string | undefined;
      try { fileToken = fs.readFileSync(tokenFile, 'utf-8').trim() || undefined; } catch { /* missing/unreadable -> config seed */ }
      // The token-file proxy reads .mcp-upstream-token before the config/env seed.
      // If that file is stale while config.toml/.mcp.json is fresh, judging only
      // the config token falsely reports healthy and leaves the running proxy on
      // the expired bearer. Use file first so the bridge repairs PLAT-882 in place.
      const currentToken = fileToken ?? configToken;
      if (!currentToken) return;
      if (!force && !isJwtStale(currentToken)) return;

      console.log(`[codex-bridge] MCP token ${force ? 'force-refresh (proxy 401)' : (fileToken ? 'file-expired/near-expiry' : 'expired/near-expiry')} — refreshing via shizuha-id`);
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const tm = new AgentTokenManager({
        agentUsername: this.opts.agentUsername ?? 'agent',
        agentEmail: process.env['AGENT_EMAIL'] || undefined,
        platformUrl: platformBase,
      });
      const freshToken = await tm.getToken();
      if (!freshToken) {
        console.warn('[codex-bridge] Token refresh: shizuha-id login failed — keeping old token');
        return;
      }

      this.platformJwtToken = freshToken;
      process.env[CODEX_PLATFORM_MCP_TOKEN_ENV] = freshToken;
      try { fs.writeFileSync(this.mcpUpstreamTokenFile(workDir), freshToken, { mode: 0o600 }); } catch { /* best-effort */ }

      if (fs.existsSync(mcpJsonPath)) {
        const { PLATFORM_MCP_SERVICES } = await import('../platform/mcp-services.js');
        const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        const servers = mcpJson.mcpServers ?? {};
        for (const svc of PLATFORM_MCP_SERVICES) {
          const entry = servers[`shizuha-${svc.name}`];
          if (!entry) continue;
          if (entry.env?.MCP_UPSTREAM_BEARER) {
            entry.env.MCP_UPSTREAM_BEARER = freshToken;
            entry.env.MCP_UPSTREAM_BEARER_FILE = this.mcpUpstreamTokenFile(workDir);
          }
          if (entry.headers?.Authorization?.startsWith('Bearer ')) {
            entry.headers = { ...entry.headers, Authorization: `Bearer ${freshToken}` };
          }
        }
        mcpJson.mcpServers = servers;
        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));
      }

      if (fs.existsSync(configPath)) {
        const text = fs.readFileSync(configPath, 'utf-8');
        const next = text
          .replace(/^(\s*Authorization\s*=\s*")Bearer\s+[^"]+(")/gm, `$1Bearer ${freshToken}$2`)
          .replace(/^(\s*MCP_UPSTREAM_BEARER\s*=\s*")[^"]+(")/gm, `$1${freshToken}$2`);
        if (next !== text) fs.writeFileSync(configPath, next);
      }
      console.log('[codex-bridge] MCP tokens refreshed via shizuha-id (file + MCP configs)');
    } catch (err) {
      console.error(`[codex-bridge] Token refresh error: ${(err as Error).message}`);
    }
  }

  /** Configure codex's MCP servers in config.toml:
   *   - the platform HTTP MCP servers (pulse, wiki, drive, …): the SAME remote
   *     streamable-HTTP endpoints Claude uses, authenticated with the agent's
   *     shizuha-id JWT via codex `http_headers`. Codex defers large tool sets to
   *     tool_search (model-driven), so the agent loads what it needs on demand. */
  private async setupCronMcp(): Promise<void> {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? '/workspace';
    const codexDir = this.getAgentCodexHome();

    const configPath = path.join(codexDir, 'config.toml');
    fs.mkdirSync(codexDir, { recursive: true });

    let existing = '';
    try { existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''; } catch { /* */ }

    // ── Platform MCP: obtain the agent's shizuha-id JWT (mint via username/
    // password — codex containers carry AGENT_PASSWORD, not AGENT_ACCESS_TOKEN). ──
    const platformBase = this.resolvePlatformBase();
    const jwtToken = await this.resolvePlatformJwt();
    const platformConnected = !!(platformBase && jwtToken);
    if (platformConnected) {
      // Codex streamable-HTTP MCP config reads bearer tokens from the app-server
      // environment via bearer_token_env_var. Keep the cached shizuha-id JWT in
      // the bridge env before spawning codex --app-server; stdio-proxy configs
      // still use the token file for live refresh.
      process.env[CODEX_PLATFORM_MCP_TOKEN_ENV] = jwtToken;
    }

    const browserMcp = resolveBrowserMcpServer(this.opts.contextPrompt);
    if (browserMcp && browserMcp.token) {
      process.env[BROWSER_MCP_TOKEN_ENV] = browserMcp.token;
    }
    try {
      const mcpJsonPath = path.join(workDir, '.mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
        if (mcpJson?.mcpServers?.['shizuha-cron']) {
          delete mcpJson.mcpServers['shizuha-cron'];
        }
        if (browserMcp) mcpJson.mcpServers = { ...(mcpJson.mcpServers ?? {}), [browserMcp.name]: browserMcp.entry };
        else if (mcpJson?.mcpServers?.['browser']) delete mcpJson.mcpServers['browser'];
        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));
      }
    } catch { /* best-effort stale cron cleanup */ }
    let mcpConfig = '';
    // PLAT-5106: browser MCP may be HTTP (sidecar) OR stdio (in-process
    // browser-mcp command). Codex TOML differs per transport — reuse the same
    // branch shape as platform proxy entries below.
    if (browserMcp) {
      if (browserMcp.transport === 'http' && 'url' in browserMcp.entry) {
        mcpConfig += buildCodexPlatformMcpToml(browserMcp.name, browserMcp.entry, BROWSER_MCP_TOKEN_ENV);
      } else if ('command' in browserMcp.entry) {
        const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const envLines = Object.entries(browserMcp.entry.env)
          .map(([k, v]) => `${k} = "${esc(v)}"`).join('\n');
        mcpConfig += `
[mcp_servers.${browserMcp.name}]
command = "${esc(browserMcp.entry.command)}"
args = [${browserMcp.entry.args.map((arg) => JSON.stringify(arg)).join(', ')}]
${envLines ? `\n[mcp_servers.${browserMcp.name}.env]\n${envLines}\n` : ''}
`;
      }
    }

    // Remote platform MCP servers (pulse/wiki/drive/…) use the same reconnecting
    // stdio proxy as Claude. The proxy reads a fresh token file on each
    // reconnect, so a running agent does not depend on static headers aging out.
    if (platformConnected) {
      const { getPlatformMcpConfigs, prunePlatformMcpKeys } = await import('../platform/mcp-services.js');
      const { resolveAllowedServers } = await import('../platform/mcp-access-matrix.js');
      const { parseAgentEffectiveMcpServicesFromEnv } = await import('../platform/effective-capabilities.js');
      // SCLI-44: default-deny MCP filter — apply the SAME role→server access-matrix
      // the claude-bridge + gateway enforce. Without this, codex-bridge agents
      // connect EVERY platform server, silently bypassing the default-deny boundary.
      // Role matrix = ceiling; SHIZUHA_MCP_SERVICES (inside prunePlatformMcpKeys)
      // narrows further; unknown/unset role fails closed to base (pulse+connect+wiki).
      const agentRole = process.env['AGENT_ROLE'];
      // Capability tags (skills[]) unioned with role (operator 2026-06-24).
      const agentSkills = (process.env['AGENT_SKILLS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const hiveAllowList = parseAgentEffectiveMcpServicesFromEnv();
      const roleAllowList = hiveAllowList ?? [...resolveAllowedServers(agentRole, this.opts.agentUsername ?? process.env['AGENT_USERNAME'], agentSkills)];
      const tokenFile = this.mcpUpstreamTokenFile(workDir);
      try { fs.writeFileSync(tokenFile, jwtToken, { mode: 0o600 }); } catch { /* stdio proxy falls back to env seed */ }
      const proxyPlatformConfigs = prunePlatformMcpKeys(
        getPlatformMcpConfigs({
          bearerToken: jwtToken,
          bearerTokenFile: tokenFile,
          platformUrl: platformBase,
        }),
        roleAllowList,
      );
      try {
        const mcpJsonPath = path.join(workDir, '.mcp.json');
        let mcpJson: Record<string, any> = {};
        if (fs.existsSync(mcpJsonPath)) {
          try { mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')); } catch { mcpJson = {}; }
        }
        const existingServers = (mcpJson.mcpServers as Record<string, unknown>) ?? {};
        for (const key of Object.keys(existingServers)) {
          if (key === 'shizuha-cron') delete existingServers[key];
          else if (key === 'browser' && !browserMcp) delete existingServers[key];
          else if (key.startsWith('shizuha-') && key !== 'shizuha-cron') delete existingServers[key];
        }
        mcpJson.mcpServers = {
          ...existingServers,
          ...(browserMcp ? { [browserMcp.name]: browserMcp.entry } : {}),
          ...proxyPlatformConfigs,
        };
        fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));
      } catch (err) {
        console.warn(`[codex-bridge] Failed to refresh workspace .mcp.json: ${(err as Error).message}`);
      }
      if (hiveAllowList) {
        console.log(`[codex-bridge] MCP scope pinned by Hive effective capabilities: ${roleAllowList.join(', ')}`);
      } else if (agentRole) {
        console.log(`[codex-bridge] MCP scope pinned by role matrix (${agentRole}): ${roleAllowList.join(', ')}`);
      }
      const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      let written = 0;
      for (const [name, cfg] of Object.entries(proxyPlatformConfigs)) {
        if ('url' in cfg) {
          // Codex app-server ignores the Claude-style [*.http_headers] auth block
          // for streamable-HTTP MCP. Use Codex's native env indirection instead.
          mcpConfig += buildCodexPlatformMcpToml(name, cfg, CODEX_PLATFORM_MCP_TOKEN_ENV);
        } else {
          const envLines = Object.entries(cfg.env)
            .map(([k, v]) => `${k} = "${esc(v)}"`).join('\n');
          mcpConfig += `
[mcp_servers.${name}]
command = "${esc(cfg.command)}"
args = [${cfg.args.map((arg) => JSON.stringify(arg)).join(', ')}]

[mcp_servers.${name}.env]
${envLines}
`;
        }
        written++;
      }
      if (written === 0) {
        console.error(
          '[codex-bridge] PLATFORM_PULSE_CONNECTED requested but zero platform MCP servers were written; ' +
          'platform tool access will be unavailable until MCP config generation is fixed',
        );
        mcpConfig = mcpConfig.replace('PLATFORM_PULSE_CONNECTED = \"1\"', 'PLATFORM_PULSE_CONNECTED = \"\"');
      }
      const requiredBase = ['shizuha-pulse', 'shizuha-connect', 'shizuha-wiki'];
      const missingBase = requiredBase.filter((name) => !(name in proxyPlatformConfigs));
      if (missingBase.length) {
        console.error(`[codex-bridge] Platform MCP base servers missing from Codex config: ${missingBase.join(', ')}`);
      }
      console.log(`[codex-bridge] Wired ${written}/${Object.keys(proxyPlatformConfigs).length} platform MCP servers (token-file proxy)`);
    } else {
      console.warn('[codex-bridge] No platform JWT/base — platform MCP servers NOT configured');
    }

    // Rebuild: strip ALL existing [mcp_servers.*] blocks, then append the fresh set.
    const cleaned = existing
      .replace(/\n?\[mcp_servers\.[^\]]+\][\s\S]*?(?=\n\[[^\]]+\]|$)/g, '\n')
      .trimEnd();
    const nextConfig = `${cleaned ? `${cleaned}\n` : ''}${mcpConfig}`.trimStart();
    fs.writeFileSync(configPath, nextConfig);

    if (platformConnected) {
      const writtenConfig = fs.readFileSync(configPath, 'utf-8');
      const hasPlatformServer = /\[mcp_servers\.shizuha-(pulse|connect|wiki)\]/.test(writtenConfig);
      const hasCodexHttpBearer = writtenConfig.includes(`bearer_token_env_var = "${CODEX_PLATFORM_MCP_TOKEN_ENV}"`);
      const hasProxyBearer = writtenConfig.includes('MCP_UPSTREAM_BEARER') || writtenConfig.includes('MCP_UPSTREAM_BEARER_FILE');
      if (!hasPlatformServer || (!hasCodexHttpBearer && !hasProxyBearer)) {
        console.error(
          '[codex-bridge] PLATFORM_PULSE_CONNECTED=1 but written Codex config lacks usable platform MCP auth/server entries; ' +
          'platform tool access will remain unavailable until this is fixed',
        );
      }
    }

    if (isRoot) {
      chownForContainerAgent(codexDir);
    }
  }

  private async findCodexCli(): Promise<string> {
    const candidates = [
      '/usr/local/bin/codex',
      '/usr/bin/codex',
      path.join(process.env['HOME'] ?? '/root', '.local', 'bin', 'codex'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const result = execSync('which codex', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch { /* not found */ }

    console.log('[codex-bridge] Codex CLI not found — installing @openai/codex...');
    const localPrefix = path.join(process.env['HOME'] ?? '/root', '.local');
    const installCommands = [
      'npm install -g @openai/codex',
      `npm install -g --prefix ${localPrefix} @openai/codex`,
    ];
    for (const cmd of installCommands) {
      try {
        execSync(cmd, { encoding: 'utf-8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
        console.log('[codex-bridge] Codex CLI installed successfully');
        for (const p of candidates) { if (fs.existsSync(p)) return p; }
        const result = execSync('which codex', { encoding: 'utf-8', timeout: 5000 }).trim();
        if (result) return result;
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('EACCES') && cmd === installCommands[0]) {
          console.log('[codex-bridge] Global install failed (EACCES), trying user-local...');
          continue;
        }
        console.error('[codex-bridge] Auto-install failed: ' + msg);
      }
    }

    throw new Error('Codex CLI not found and auto-install failed. Install manually: npm install -g @openai/codex');
  }

  // ── Auth ──

  private authToken = '';
  private hasAuth = false;
  private authViaFile = false;
  private activeBrokerModelToken: BrokerModelToken | null = null;
  private brokerCodexAuth: BrokerCodexAuthPayload | null = null;

  private brokerStickyKey(): string {
    return `agent:${process.env['AGENT_USERNAME'] || this.opts.agentUsername || 'default'}`;
  }

  private clearBrokerCodexAuthCache(agentAuthFile: string): void {
    try {
      if (fs.existsSync(agentAuthFile)) {
        fs.unlinkSync(agentAuthFile);
        console.log('[codex-bridge] Removed stale broker auth cache while Hive token pool is unavailable');
      }
    } catch (err) {
      console.warn(`[codex-bridge] Could not remove stale broker auth cache: ${(err as Error).message}`);
    }
  }

  private async ensureAuth(): Promise<void> {
    const isRoot = process.getuid?.() === 0;
    const userHome = process.env['HOME'] ?? '/root';
    const agentHome = isRoot ? '/home/agent' : userHome;
    const agentCodexDir = this.getAgentCodexHome();
    const agentAuthFile = path.join(agentCodexDir, 'auth.json');
    const requireBrokerModelToken = process.env['CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'] === '1';

    if (requireBrokerModelToken || brokerExpected()) {
      const brokerToken = await fetchBrokerModelToken(
        'openai',
        5000,
        { stickyKey: this.brokerStickyKey() },
      );
      const brokerPayload = brokerToken ? parseBrokerCodexPayload(brokerToken.token) : null;
      if (brokerPayload) {
        await this.writeBrokerCodexAuth(brokerPayload, agentCodexDir, agentAuthFile, isRoot);
        this.codexActiveAccountEmail = brokerPayload.email;
        this.activeBrokerModelToken = brokerToken ?? null;
        this.brokerCodexAuth = brokerPayload;
        this.hasAuth = true;
        this.authViaFile = true;
        this.authToken = '';
        console.log(`[codex-bridge] Prepared access-only external auth from coordinator broker (${brokerPayload.email}, label=${brokerToken?.label ?? ''})`);
        return;
      }
      // 2026-06-29 refresh-token ROTATION RACE (digital codex refresh_token
      // revoked → coordinator 401): when the broker is EXPECTED, it must be the
      // SOLE refresher of the OpenAI OAuth token. The local fallbacks below
      // (activateCodexAccount / stale-auth.json refresh / credentials.json) each
      // call refreshForIdToken(), and OpenAI ROTATES the refresh_token on every
      // refresh — so an agent that falls through here on a *transient* broker
      // dry-out rotates the shared account's refresh_token out-of-band and
      // PERMANENTLY revokes the coordinator's stored copy (next coordinator
      // refresh → invalid_grant/401). That turned a momentary pool-dry into a
      // dead account. The coordinator is the common credential authority; a
      // broker-expected agent must NEVER refresh locally. So gate the
      // retry-then-degrade path on brokerExpected() too (not just the explicit
      // CODEX_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN env): retry the broker, then
      // start DEGRADED (on-break) and auto-recover when a token frees — never
      // fall through to a local rotation.
      if (requireBrokerModelToken || brokerExpected()) {
        // 2026-06-27 fleet outage (24->6): a transient broker-token blip — e.g.
        // all org codex tokens briefly in (stale/short) cooldown — used to throw
        // here, fail-closing the ENTIRE codex fleet into a crash-loop (exit 1 in
        // ~3s, respawn, repeat). Cooldowns lapse and other accounts free up within
        // seconds, so retry with bounded backoff before fail-closing. Only a
        // genuine sustained outage (no token after ~48s of retries) still throws.
        const RETRY_MS = [3000, 5000, 8000, 12000, 20000];
        for (const delay of RETRY_MS) {
          await new Promise((r) => setTimeout(r, delay));
          const retryToken = await fetchBrokerModelToken(
            'openai',
            5000,
            { stickyKey: this.brokerStickyKey() },
          );
          const retryPayload = retryToken ? parseBrokerCodexPayload(retryToken.token) : null;
          if (retryPayload) {
            await this.writeBrokerCodexAuth(retryPayload, agentCodexDir, agentAuthFile, isRoot);
            this.codexActiveAccountEmail = retryPayload.email;
            this.activeBrokerModelToken = retryToken ?? null;
            this.brokerCodexAuth = retryPayload;
            this.hasAuth = true;
            this.authViaFile = true;
            this.authToken = '';
            console.log(`[codex-bridge] Prepared access-only external auth from coordinator broker after retry (${retryPayload.email}, label=${retryToken?.label ?? ''})`);
            return;
          }
          console.warn('[codex-bridge] broker model token unavailable — retrying before degrade...');
        }
        // 2026-06-27 (operator directive: "ensure agents are not stuck in a restart
        // loop"). Throwing here crashed the process at startup -> daemon recreated
        // the container -> RESTART-LOOP whenever ALL org codex tokens were
        // simultaneously cooled (ordinary codex exhaustion lasts ~1h). Do NOT throw:
        // START AND DEGRADE. Return with hasAuth=false so the process stays UP and
        // idle (on-break). The per-turn path (handleTurn) re-calls ensureAuth()
        // before each turn and emits a clean empty turn while still dry, then
        // AUTO-RECOVERS the instant a token frees — with NO restart and NO forced
        // token refetch. Token acquisition now happens only on a deliberate restart
        // (e.g. agent-image upgrade), never as a forced reaction to exhaustion.
        console.warn('[codex-bridge] broker model token unavailable after retries — starting DEGRADED (on-break); no crash-loop, will auto-recover when a token frees');
        this.clearBrokerCodexAuthCache(agentAuthFile);
        this.activeBrokerModelToken = null;
        this.brokerCodexAuth = null;
        this.hasAuth = false;
        return;
      }
    }

    if (process.env['OPENAI_AUTH_TOKEN']) {
      this.authToken = process.env['OPENAI_AUTH_TOKEN'];
      this.activeBrokerModelToken = null;
      this.brokerCodexAuth = null;
      this.hasAuth = true;
      console.log(`[codex-bridge] Using OPENAI_AUTH_TOKEN from env`);
      return;
    }

    // PLAT-423: prefer the Shizuha credential-store account pool for bridge
    // auth. A single static ~/.codex/auth.json cannot rotate; writing the
    // selected account into CODEX_HOME lets us exhaustively try all configured
    // accounts before surfacing provider_down.
    let accounts: CodexAccountEntry[] = [];
    try {
      accounts = readCodexAccounts();
    } catch (e) {
      console.warn(`[codex-bridge] Failed to read Shizuha Codex credentials: ${(e as Error).message}`);
    }
    if (accounts.length > 0) {
      const preferred = this.pickAvailableCodexAccount(accounts);
      const orderedAccounts = [
        ...(preferred ? [preferred] : []),
        ...accounts.filter((account) => account.email !== preferred?.email),
      ];
      const errors: string[] = [];
      for (const account of orderedAccounts) {
        try {
          await this.activateCodexAccount(account, agentCodexDir, agentAuthFile, isRoot);
          console.log(`[codex-bridge] Wrote auth.json from Shizuha credentials (${account.email})`);
          return;
        } catch (e) {
          const msg = (e as Error).message;
          errors.push(`${account.email}: ${msg}`);
          console.warn(`[codex-bridge] Failed to prepare Shizuha Codex credentials for ${account.email}: ${msg}`);
        }
      }
      console.warn(`[codex-bridge] Exhausted Shizuha Codex credential-store accounts at startup: ${errors.join('; ')}`);
    }

    const sources = [
      agentAuthFile,
      // In containers: root's auth may be mounted from host
      ...(isRoot ? ['/root/.codex/auth.json'] : []),
      // Bare-metal: check user's home (may differ from agentHome for root)
      ...(userHome !== agentHome ? [path.join(userHome, '.codex', 'auth.json')] : []),
    ];

    for (const src of sources) {
      if (!fs.existsSync(src)) continue;

      if (isRoot && src !== agentAuthFile) {
        fs.mkdirSync(agentCodexDir, { recursive: true });
        fs.copyFileSync(src, agentAuthFile);
        console.log(`[codex-bridge] Copied auth from ${src} to ${agentAuthFile}`);
      } else {
        console.log(`[codex-bridge] Auth file found at ${src}`);
      }

      if (isRoot) {
        chownForContainerAgent(agentCodexDir);
      }

      // Proactively refresh stale tokens (>6 hours old)
      try {
        const authData = JSON.parse(fs.readFileSync(agentAuthFile, 'utf-8'));
        const lastRefresh = authData.last_refresh ? new Date(authData.last_refresh).getTime() : 0;
        const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
        if (Date.now() - lastRefresh > TOKEN_MAX_AGE_MS) {
          const refreshToken = authData.tokens?.refresh_token;
          if (refreshToken) {
            console.log(`[codex-bridge] Tokens are stale (last refresh: ${authData.last_refresh}), refreshing...`);
            const refreshed = await this.refreshForIdToken(refreshToken);
            if (refreshed) {
              authData.tokens.access_token = refreshed.access_token || authData.tokens.access_token;
              authData.tokens.refresh_token = refreshed.refresh_token || authData.tokens.refresh_token;
              if (refreshed.id_token) authData.tokens.id_token = refreshed.id_token;
              authData.last_refresh = new Date().toISOString();
              fs.writeFileSync(agentAuthFile, JSON.stringify(authData, null, 2), { mode: 0o600 });
              if (isRoot) {
                chownForContainerAgent(agentAuthFile);
              }
              console.log(`[codex-bridge] Token refreshed successfully`);
            } else {
              console.warn(`[codex-bridge] Token refresh failed`);
            }
          }
        }
      } catch (e) {
        console.warn(`[codex-bridge] Stale token check failed: ${(e as Error).message}`);
      }

      this.hasAuth = true;
      return;
    }

    // Fallback: Shizuha credentials.json
    try {
      const accounts = readCodexAccounts();
      if (accounts.length > 0) {
        const account = accounts[0]!;
        if (account.accessToken) {
          let accessToken = account.accessToken;
          let refreshToken = account.refreshToken;
          let idToken: string | undefined;

          if (account.refreshToken) {
            const refreshed = await this.refreshForIdToken(account.refreshToken);
            if (refreshed) {
              accessToken = refreshed.access_token || accessToken;
              refreshToken = refreshed.refresh_token || refreshToken;
              idToken = refreshed.id_token;
              try {
                const { updateCodexTokens } = await import('../config/credentials.js');
                updateCodexTokens(account.email, accessToken, refreshToken, idToken);
              } catch { /* */ }
            }
          }

          if (!idToken && account.idToken) idToken = account.idToken;
          if (!idToken) {
            console.warn(`[codex-bridge] No id_token available. Re-auth needed.`);
            this.hasAuth = false;
            return;
          }

          let accountId = account.accountId || '';
          if (!accountId && accessToken) {
            try {
              const parts = accessToken.split('.');
              if (parts.length >= 2) {
                const raw = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
                const padLen = (4 - (raw.length % 4)) % 4;
                const jwt = JSON.parse(Buffer.from(raw + '='.repeat(padLen), 'base64').toString('utf-8'));
                const authClaim = jwt?.['https://api.openai.com/auth'] as Record<string, string> | undefined;
                accountId = jwt?.account_id ?? authClaim?.chatgpt_account_id ?? authClaim?.account_id ?? '';
              }
            } catch { /* */ }
          }

          const tokens: Record<string, string> = { access_token: accessToken, refresh_token: refreshToken, id_token: idToken };
          if (accountId) tokens.account_id = accountId;

          const authJson = { auth_mode: 'chatgpt', tokens, last_refresh: new Date().toISOString() };
          fs.mkdirSync(agentCodexDir, { recursive: true });
          fs.writeFileSync(agentAuthFile, JSON.stringify(authJson, null, 2), { mode: 0o600 });
          if (isRoot) { chownForContainerAgent(agentHome); }

          this.hasAuth = true;
          this.authViaFile = true;
          this.brokerCodexAuth = null;
          console.log(`[codex-bridge] Wrote auth.json from Shizuha credentials (${account.email})`);
          return;
        }
      }
    } catch (e) {
      console.warn(`[codex-bridge] Failed to read Shizuha credentials: ${(e as Error).message}`);
    }

    const platformJwt = await this.resolvePlatformJwt();
    if (platformJwt) {
      this.brokerCodexAuth = null;
      this.hasAuth = true;
      console.log(`[codex-bridge] Using platform JWT for Cortex gateway auth`);
      return;
    }

    const apiKey = process.env['CODEX_API_KEY'] || process.env['OPENAI_API_KEY'];
    if (apiKey) {
      this.authToken = apiKey;
      this.brokerCodexAuth = null;
      this.hasAuth = true;
      console.log(`[codex-bridge] Using API key from env`);
      return;
    }

    this.brokerCodexAuth = null;
    this.hasAuth = false;
    console.warn(`[codex-bridge] No auth found. Codex CLI may fail.`);
  }

  private pickAvailableCodexAccount(accounts: CodexAccountEntry[]): CodexAccountEntry | null {
    const now = Date.now();
    for (const account of accounts) {
      if (this.codexAccountPermanentFailures.has(account.email)) continue;
      const unavailableUntil = this.codexAccountUnavailableUntil.get(account.email) ?? 0;
      if (unavailableUntil <= now) return account;
    }
    return null;
  }

  private markCodexAccountPermanentFailure(email: string, reason: string): void {
    const compactReason = reason.replace(/\s+/g, ' ').slice(0, 300);
    this.codexAccountPermanentFailures.set(email, compactReason);
    this.codexAccountUnavailableUntil.delete(email);
    console.warn(`[codex-bridge] CODEX_ACCOUNT_AUTH_FAILED_PERMANENT: ${email}: ${compactReason}`);
  }

  private async handleCodexServerStderrLine(line: string): Promise<void> {
    if (!isCodexAuthInvalidationSignal(line)) return;
    if (!this.activeBrokerModelToken || !brokerExpected()) return;
    if (this.codexAuthInvalidReportInFlight) return;

    this.codexAuthInvalidReportInFlight = true;
    const previous = this.codexActiveAccountEmail ?? this.activeBrokerModelToken.label ?? '(broker)';
    try {
      const reported = await reportBrokerModelTokenStatus(
        this.activeBrokerModelToken,
        { action: 'deactivate' },
      );
      if (reported) {
        console.warn(`[codex-bridge] CODEX_BROKER_TOKEN_AUTH_INVALID: deactivated ${previous}; refetching broker token`);
      } else {
        console.warn(`[codex-bridge] CODEX_BROKER_TOKEN_AUTH_INVALID_REPORT_FAILED: ${previous}`);
      }

      this.activeBrokerModelToken = null;
      this.brokerCodexAuth = null;
      this.codexActiveAccountEmail = null;
      this.hasAuth = false;
      const isRoot = process.getuid?.() === 0;
      const agentCodexDir = this.getAgentCodexHome();
      const agentAuthFile = path.join(agentCodexDir, 'auth.json');
      const rotated = await this.activateBrokerCodexAccount(agentCodexDir, agentAuthFile, isRoot);
      if (rotated) {
        await this.restartAppServerForAuthRotation();
        this.clearCodexPartialTurnStateForRetry();
        console.warn(`[codex-bridge] CODEX_BROKER_TOKEN_AUTH_INVALID_RECOVERED: ${previous} -> ${this.codexActiveAccountEmail ?? '(broker)'}`);
      }
    } catch (err) {
      console.warn(`[codex-bridge] CODEX_BROKER_TOKEN_AUTH_INVALID_RECOVERY_FAILED: ${previous}: ${(err as Error).message}`);
    } finally {
      this.codexAuthInvalidReportInFlight = false;
    }
  }

  /** Process stderr only from the current app-server child. Late auth-invalid
   *  diagnostics from a superseded child must not deactivate the replacement's
   *  broker token or trigger another restart. */
  private handleServerStderrChunk(child: ChildProcess, chunk: Buffer): void {
    if (!isCurrentBridgeChild(child, this.serverProcess)) return;
    const text = chunk.toString().trim();
    if (!text) return;
    for (const line of text.split('\n')) {
      if (line.length < 500) console.error(`[codex-server] ${line}`);
      void this.handleCodexServerStderrLine(line);
    }
  }

  private async activateCodexAccount(
    account: CodexAccountEntry,
    agentCodexDir: string,
    agentAuthFile: string,
    isRoot: boolean,
  ): Promise<void> {
    await this.writeCodexAccountAuth(account, agentCodexDir, agentAuthFile, isRoot);
    this.codexActiveAccountEmail = account.email;
    this.activeBrokerModelToken = null;
    this.brokerCodexAuth = null;
    this.hasAuth = true;
    this.authViaFile = true;
    this.authToken = '';
  }

  private async activateBrokerCodexAccount(
    agentCodexDir: string,
    agentAuthFile: string,
    isRoot: boolean,
    excludeEntryId = '',
  ): Promise<boolean> {
    if (!brokerExpected()) return false;
    const brokerToken = await fetchBrokerModelToken(
      'openai',
      5000,
      {
        stickyKey: this.brokerStickyKey(),
        ...(excludeEntryId ? { excludeEntryId } : {}),
      },
    );
    const brokerPayload = brokerToken ? parseBrokerCodexPayload(brokerToken.token) : null;
    if (!brokerPayload) return false;
    await this.writeBrokerCodexAuth(brokerPayload, agentCodexDir, agentAuthFile, isRoot);
    this.codexActiveAccountEmail = brokerPayload.email;
    this.activeBrokerModelToken = brokerToken;
    this.brokerCodexAuth = brokerPayload;
    this.hasAuth = true;
    this.authViaFile = true;
    this.authToken = '';
    console.log(`[codex-bridge] Prepared access-only external auth from coordinator broker (${brokerPayload.email}, label=${brokerToken?.label ?? ''})`);
    return true;
  }

  private async writeBrokerCodexAuth(
    account: BrokerCodexAuthPayload,
    agentCodexDir: string,
    agentAuthFile: string,
    isRoot: boolean,
  ): Promise<void> {
    fs.mkdirSync(agentCodexDir, { recursive: true });
    fs.writeFileSync(
      agentAuthFile,
      JSON.stringify(buildBrokerCodexAuthFile(account), null, 2),
      { mode: 0o600 },
    );
    if (isRoot) chownForContainerAgent(agentCodexDir);
  }

  private async writeCodexAccountAuth(
    account: CodexAccountEntry,
    agentCodexDir: string,
    agentAuthFile: string,
    isRoot: boolean,
  ): Promise<void> {
    let accessToken = account.accessToken;
    let refreshToken = account.refreshToken;
    let idToken: string | undefined = account.idToken;

    if (account.refreshToken) {
      const refreshed = await this.refreshForIdToken(account.refreshToken);
      if (refreshed) {
        accessToken = refreshed.access_token || accessToken;
        refreshToken = refreshed.refresh_token || refreshToken;
        idToken = refreshed.id_token || idToken;
        try {
          const { updateCodexTokens } = await import('../config/credentials.js');
          updateCodexTokens(account.email, accessToken, refreshToken, idToken);
        } catch (e) {
          // B2/L1377: log prominently — a silent swallow here means the new refresh token
          // is never persisted to credentials.json. On the next container restart the
          // stale (possibly expired) refresh token is re-used and auth fails silently.
          console.warn(`[codex-bridge] Could not persist refreshed tokens for ${account.email} — credentials.json may be read-only (mounted from host). Refresh token rotation will not survive a container restart: ${(e as Error).message}`);
        }
      }
    }

    if (!idToken) throw new Error(`No id_token available for Codex account ${account.email}`);
    const tokens: Record<string, string> = { access_token: accessToken, refresh_token: refreshToken, id_token: idToken };
    const accountId = account.accountId || jwtClaim(idToken, 'account_id') || jwtClaim(idToken, 'https://api.openai.com/auth/account_id');
    if (accountId) tokens.account_id = accountId;
    fs.mkdirSync(agentCodexDir, { recursive: true });
    fs.writeFileSync(agentAuthFile, JSON.stringify({ auth_mode: 'chatgpt', tokens, last_refresh: new Date().toISOString() }, null, 2), { mode: 0o600 });
    if (isRoot) chownForContainerAgent(agentCodexDir);
  }

  private async restartAppServerForAuthRotation(): Promise<void> {
    const oldProc = this.serverProcess;
    const suppressOldExit = !!oldProc && oldProc.exitCode === null;
    if (suppressOldExit) {
      this.restartingAppServerForAuthRotation = true;
      this.suppressedCodexExitProc = oldProc;
    }
    try {
      if (oldProc && oldProc.exitCode === null) {
        this.signalCodexTree(oldProc, 'SIGTERM');
        await Promise.race([
          new Promise<void>((resolve) => oldProc.once('exit', () => resolve())),
          sleep(5000),
        ]);
      }
      this.serverReady = false;
      // B3/L1406: the new app-server gets a blank thread (old thread IDs are not
      // portable across server restarts). Capture the last few persisted turns so
      // createThread can seed baseInstructions with context, preserving mid-session
      // conversation continuity across account rotations.
      try {
        const session = this.store.loadSession(this.sessionId);
        const msgs = session?.messages ?? [];
        if (msgs.length > 0) {
          const recap = (msgs as Array<{ role: string; content: unknown }>).slice(-6).map((m) =>
            `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content ?? '').slice(0, 600)}`
          ).join('\n\n');
          this.rotationConversationContext = `[Account rotated mid-session. Recent conversation context for continuity:\n${recap}\n]`;
        }
      } catch { /* non-fatal — proceed without context seeding */ }
      this.codexThreadId = null;
      await this.startAppServer();
    } finally {
      if (suppressOldExit) this.restartingAppServerForAuthRotation = false;
    }
  }

  private clearCodexPartialTurnStateForRetry(): void {
    // A rate-limited attempt may have emitted agent_message_delta events before
    // the app-server reported the limit. Clear every partial-output buffer before
    // replaying so the next account's answer is stored as a fresh assistant turn.
    // Also retract/reset already-streamed dashboard deltas for this execution;
    // otherwise clients would see partial failed output followed by the full replay.
    // B3/L1546: always broadcast content_reset even when codexActiveTurnStreamedState
    // is false. On a second+ retry of the same turn, lastStreamedContent was cleared
    // in the first retry call, so the old conditional missed retries where the second
    // failed attempt had streamed deltas before failing — those stale deltas would
    // then concatenate with the eventual successful retry's output on the client.
    if (this.activeThreadId) {
      const reset = { reason: 'codex_rate_limit_retry' };
      this.broadcastToThread(this.activeThreadId, {
        type: 'content_reset',
        execution_id: this.activeThreadId,
        data: reset,
      });
      // Backward-compatible reset marker for clients that only process `content`
      // stream events: an empty delta with reset=true means replace current
      // assistant content with the empty string before replay deltas arrive.
      this.broadcastToThread(this.activeThreadId, {
        type: 'content',
        execution_id: this.activeThreadId,
        data: { ...reset, reset: true, delta: '', content: '' },
      });
      this.broadcastToThread(this.activeThreadId, {
        type: 'content_retract',
        execution_id: this.activeThreadId,
        data: reset,
      });
    }
    this.accumulatedContent = '';
    this.lastStreamedContent = '';
    this.codexActiveTurnStreamedState = false;
  }


  // Empty Codex app-server turns are ambiguous: they can be quota exhaustion, but
  // also model mismatch, app-server regressions, or bridge visibility gaps. Never
  // cool a shared coordinator token on this signal alone; doing so can poison the
  // org pool and starve unrelated agents. Explicit provider limit errors still use
  // the normal report-status cooldown path below.
  private codexExhaustionRotateInFlight = false;
  /** Sticky for the remainder of this process once every Codex account is
   * exhausted and no distinct model fallback exists. Emit this before exit so
   * Hive cannot remain green after Pulse has made the agent unavailable. */
  private providerUnavailable = false;
  private providerUnavailableReason: string | null = null;
  private providerRecoveryProbeAttempted = false;
  private availabilityConfirmedHealthy = false;
  /** Broker entries already observed empty during the current exhaustion
   * episode. The coordinator exclusion contract is intentionally one entry at
   * a time, so the bridge must detect when rotation circles back to a tried
   * account instead of traversing the same exhausted pool forever. A
   * productive turn clears the episode above. */
  private codexEmptyTurnExhaustedEntryIds = new Set<string>();
  private failoverExitInitiated = false;

  /**
   * PLAT-2946: Last resort when empty-turn compound trigger fires and account
   * rotation is a NOOP.
   *
   * - Distinct fallback model → exit(42) so the daemon advances the chain
   *   (real recovery path).
   * - No fallback → **soft stay-alive** (human model): reset empty-turn streak,
   *   keep the process up, continue the queue. Do NOT write sticky
   *   provider-unavailable or exit 43 — that path caused false "provider down"
   *   outages when the model was merely quiet (DRV-104 / Sora class).
   *   Real rate-limit/auth still mark unavailable via handleCodexTurnFailure.
   */
  private failoverToConfiguredFallbackOnExhaustion(): void {
    if (this.failoverExitInitiated) return;
    const action = decideEmptyTurnExhaustionAction(process.env['SHIZUHA_MODEL_FALLBACKS'], this.opts.model);
    if (action.kind === 'stay-alive') {
      // Soft recovery — stay online like a human who had a blank moment.
      this.consecutiveEmptyTurns = 0;
      this.emptyTurnHistory = [];
      this.codexEmptyTurnExhaustedEntryIds.clear();
      this.pendingEmptyConnectReplay = null;
      this.providerUnavailable = false;
      this.providerUnavailableReason = null;
      clearProviderUnavailableMarker();
      console.warn(
        `[codex-bridge] EMPTY_TURN_SOFT_RESET: model "${this.opts.model}" had a quiet streak ` +
        `with no alternate account/fallback — staying alive (no sticky unavailable, no exit 43). ` +
        `Silence is not a provider outage.`,
      );
      this.emitTelemetry();
      // Prefer availability true if we had previously been marked down by a
      // legacy empty-turn path; do not force false.
      void this.markAgentAvailability(true, '');
      this.requestHeartbeatCheckpoint({
        resetThread: true,
        delayMs: 30_000,
        reason: 'empty-turn soft stay-alive recovery',
      });
      return;
    }
    this.failoverExitInitiated = true;
    // PLAT-2946 (P2-4): make the failover target observable — distinguish a
    // cross-method failover (e.g. → claude_code_server, the intended recovery)
    // from an intra-provider RE-ADVANCE to another codex model (same method,
    // possibly the same usage-limited org), so a chain that walks codex→codex
    // before reaching claude is visible in telemetry rather than looking identical.
    const currentMethod = 'codex_app_server';
    const kind = (action.step.method && action.step.method !== currentMethod)
      ? 'cross-method' : 'intra-provider-readvance';
    console.error(
      `[codex-bridge] EMPTY_TURN_EXHAUSTION_FAILOVER (${kind}): model "${this.opts.model}" wedged and no alternate codex account — exiting 42 to fail over to ${action.step.method ?? '?'}/${action.step.model ?? '?'} via daemon failover chain.`,
    );
    // Give stdio a tick to flush the log line before the daemon sees the exit.
    setTimeout(() => process.exit(42), 250);
  }

  private async rotateCodexAccountOnExhaustion(): Promise<void> {
    if (this.codexExhaustionRotateInFlight) return;
    // Only broker-served codex can rotate via the coordinator pool here.
    if (!this.activeBrokerModelToken || !brokerExpected()) {
      // No broker rotation possible at all — still try the configured model failover.
      this.failoverToConfiguredFallbackOnExhaustion();
      return;
    }
    this.codexExhaustionRotateInFlight = true;
    try {
      const previous = this.codexActiveAccountEmail ?? (this.activeBrokerModelToken.label || '(broker)');
      const isRoot = process.getuid?.() === 0;
      const agentCodexDir = this.getAgentCodexHome();
      const agentAuthFile = path.join(agentCodexDir, 'auth.json');
      const exhaustedEntryId = this.activeBrokerModelToken.entryId;
      if (exhaustedEntryId) this.codexEmptyTurnExhaustedEntryIds.add(exhaustedEntryId);
      const rotated = await this.activateBrokerCodexAccount(
        agentCodexDir,
        agentAuthFile,
        isRoot,
        exhaustedEntryId,
      );
      const nextEntryId = this.activeBrokerModelToken?.entryId ?? '';
      const cycledToExhaustedEntry = Boolean(
        nextEntryId && this.codexEmptyTurnExhaustedEntryIds.has(nextEntryId),
      );
      if (
        rotated
        && this.codexActiveAccountEmail
        && this.codexActiveAccountEmail !== previous
        && !cycledToExhaustedEntry
      ) {
        console.log(`[codex-bridge] EMPTY_TURN_EXHAUSTION_ROTATE: ${previous} -> ${this.codexActiveAccountEmail}; restarting app-server and resuming retained direct work`);
        await this.restartAppServerForAuthRotation();
        this.consecutiveEmptyTurns = 0; // give the rotated account a fresh streak
        const retainedConnectReplay = this.pendingEmptyConnectReplay;
        this.pendingEmptyConnectReplay = null;
        if (retainedConnectReplay) {
          this.codexThreadId = null;
          enqueueBridgeMessage(this.messageQueue, retainedConnectReplay);
          console.log(
            `[codex-bridge] Resuming retained Connect DM after account rotation ` +
            `(empty attempts=${retainedConnectReplay.emptyTurnReplayCount ?? 0})`,
          );
          void this.processQueue();
        } else {
          // No direct work was lost; re-enter through the canonical scheduler.
          this.requestHeartbeatCheckpoint({
            resetThread: true,
            delayMs: 1_000,
            reason: 'empty-turn account rotation recovery',
          });
        }
      } else {
        const detail = cycledToExhaustedEntry
          ? `cycled to already-tried entry ${nextEntryId}`
          : 'same/none';
        console.warn(`[codex-bridge] EMPTY_TURN_EXHAUSTION_ROTATE_NOOP: broker returned ${this.codexActiveAccountEmail ?? '(none)'} (${detail}) — no healthy alternate codex account available`);
        // PLAT-2946: rotation is a no-op (org-wide usage limit). Fail over to the
        // configured non-codex fallback (claude-sonnet-4-6) instead of wedging.
        this.failoverToConfiguredFallbackOnExhaustion();
      }
    } catch (e) {
      console.warn(`[codex-bridge] EMPTY_TURN_EXHAUSTION_ROTATE_FAILED: ${(e as Error).message}`);
      // Rotation errored — the configured model failover is still worth attempting.
      this.failoverToConfiguredFallbackOnExhaustion();
    } finally {
      this.codexExhaustionRotateInFlight = false;
    }
  }

  private ensureCodexActiveTurnLimitRetry(errorMsg: string): Promise<void> {
    if (this.codexActiveTurnRetryPromise) {
      console.warn('[codex-bridge] RATE_LIMIT_RETRY_ALREADY_IN_FLIGHT: suppressing duplicate retry request for active turn');
      return this.codexActiveTurnRetryPromise;
    }
    this.codexActiveTurnRetryPromise = this.retryCodexActiveTurnAfterLimit(errorMsg)
      .finally(() => { this.codexActiveTurnRetryPromise = null; });
    return this.codexActiveTurnRetryPromise;
  }

  private async retryCodexActiveTurnAfterLimit(errorMsg: string): Promise<void> {
    const threadId = this.activeThreadId;
    const content = this.activeTurnContent;
    if (!threadId || !content) return;
    this.clearCodexPartialTurnStateForRetry();

    const now = Date.now();
    if (this.codexActiveLimitFirstFailedAt === null) this.codexActiveLimitFirstFailedAt = now;
    const configuredMaxWaitMs = parseInt(process.env['CODEX_BRIDGE_MAX_RATE_LIMIT_WAIT_MS'] ?? String(60 * 60_000), 10);
    const parsedRetryDelay = parseRetryDelayMs(errorMsg);
    // Daily/usage-cap messages often have no parseable reset timestamp. Do not
    // hold the active turn for the generic 60s fallback forever; cap unparsed
    // waits tightly and then surface EXHAUSTED so the agent stays observable.
    const maxUnparsedWaitMs = parseInt(process.env['CODEX_BRIDGE_UNPARSED_LIMIT_MAX_WAIT_MS'] ?? String(5 * 60_000), 10);
    const maxWaitMs = parsedRetryDelay === null ? Math.min(configuredMaxWaitMs, maxUnparsedWaitMs) : configuredMaxWaitMs;
    const elapsedLimitWaitMs = now - this.codexActiveLimitFirstFailedAt;
    const retryDelay = parsedRetryDelay ?? Math.min(60_000, maxWaitMs);
    if (this.codexActiveAccountEmail) {
      this.codexAccountUnavailableUntil.set(this.codexActiveAccountEmail, now + retryDelay);
    }

    const isRoot = process.getuid?.() === 0;
    const agentCodexDir = this.getAgentCodexHome();
    const agentAuthFile = path.join(agentCodexDir, 'auth.json');
    const brokerRequired = codexBrokerAuthorityRequired();
    let accounts: CodexAccountEntry[] = [];
    if (!brokerRequired) {
      try {
        accounts = loadLocalCodexRateLimitRecoveryAccounts();
      } catch (err) {
        errorMsg = `${errorMsg}; failed to read Codex account pool: ${(err as Error).message}`;
      }
    }

    const waitAndRetryCurrentAuth = async (reason: string): Promise<boolean> => {
      const waitNow = Date.now();
      const elapsedNowMs = waitNow - (this.codexActiveLimitFirstFailedAt ?? waitNow);
      const waitMs = Math.min(retryDelay, Math.max(0, maxWaitMs - elapsedNowMs));
      if (elapsedNowMs >= maxWaitMs || waitMs <= 0) return false;
      console.log(`[codex-bridge] ${reason}; waiting ${Math.round(waitMs / 1000)}s before replaying active turn (elapsed=${Math.round(elapsedNowMs / 1000)}s max=${Math.round(maxWaitMs / 1000)}s)`);
      await sleep(waitMs + 1000);
      this.clearCodexPartialTurnStateForRetry();
      try {
        await this.sendTurn(content);
        return true;
      } catch (err) {
        const msg = (err as Error).message;
        if (!isCodexLimitError(msg)) throw err;
        errorMsg = msg;
        if (this.codexActiveLimitFirstFailedAt !== null && Date.now() - this.codexActiveLimitFirstFailedAt < maxWaitMs) {
          await this.retryCodexActiveTurnAfterLimit(msg);
          return true;
        }
        return false;
      }
    };

    try {
      if (brokerRequired) {
        if (!this.activeBrokerModelToken) {
          throw new Error(`${errorMsg}; Hive broker is required but no active lease is available`);
        }
        const previous = this.codexActiveAccountEmail ?? (this.activeBrokerModelToken.label || '(broker)');
        const previousEntryId = this.activeBrokerModelToken.entryId ?? '';
        const cooldownSeconds = Math.max(300, Math.ceil(retryDelay / 1000));
        const reported = await reportBrokerModelTokenStatus(
          this.activeBrokerModelToken,
          { action: 'cool', cooldownSeconds },
        );
        if (!reported) {
          console.warn(`[codex-bridge] RATE_LIMIT_BROKER_REPORT_FAILED: ${previous}; continuing with broker refetch`);
        }
        const rotated = await this.activateBrokerCodexAccount(
          agentCodexDir,
          agentAuthFile,
          isRoot,
          previousEntryId,
        );
        if (rotated) {
          const next = this.codexActiveAccountEmail ?? '(broker)';
          if (previousEntryId && this.activeBrokerModelToken?.entryId === previousEntryId) {
            throw new Error(
              `${errorMsg}; broker returned the same rate-limited entry ${previousEntryId}; refusing deterministic replay`,
            );
          }
          console.log(`[codex-bridge] RATE_LIMIT_BROKER_ROTATE_RETRY: ${previous} -> ${next}; replaying active turn`);
          try {
            await this.restartAppServerForAuthRotation();
            this.clearCodexPartialTurnStateForRetry();
            this.accumulatedContent = '';
            this.lastStreamedContent = '';
            await this.sendTurn(content);
            return;
          } catch (err) {
            const retryMsg = (err as Error).message;
            if (isCodexLimitError(retryMsg)) {
              errorMsg = retryMsg;
              console.warn(`[codex-bridge] RATE_LIMIT_BROKER_ROTATE_RETRY_LIMITED: ${next}: ${retryMsg}`);
            } else if (isCodexAuthFailure(retryMsg)) {
              this.markCodexAccountPermanentFailure(next, retryMsg);
              errorMsg = `${errorMsg}; broker retry with ${next} auth failed: ${retryMsg}`;
            } else {
              errorMsg = `${errorMsg}; broker retry with ${next} failed: ${retryMsg}`;
            }
            this.clearCodexPartialTurnStateForRetry();
          }
        } else {
          errorMsg = `${errorMsg}; broker did not return another Codex account`;
        }
        // Hive is the sole authority in broker mode. Exhausting broker recovery
        // must fail closed; never continue into the host credentials loop.
        throw new Error(`${errorMsg}; Hive broker recovery exhausted`);
      }

      if (accounts.length === 0) {
        // No credential-store pool exists to rotate through. Fast-fail cleanly;
        // do not recurse/sleep for the full rate-limit window with no accounts.
        errorMsg = `${errorMsg}; no Codex credential-store accounts available for rotation`;
        throw new Error(errorMsg);
      }

      while (accounts.length > 0) {
        const next = this.pickAvailableCodexAccount(accounts);
        if (!next) break;

        const previous = this.codexActiveAccountEmail ?? '(auth-file)';
        try {
          await this.activateCodexAccount(next, agentCodexDir, agentAuthFile, isRoot);
        } catch (err) {
          const authMsg = (err as Error).message;
          if (isCodexAuthFailure(authMsg)) {
            this.markCodexAccountPermanentFailure(next.email, authMsg);
          } else {
            this.codexAccountUnavailableUntil.set(next.email, Date.now() + retryDelay);
          }
          errorMsg = `${errorMsg}; auth rotation to ${next.email} failed: ${authMsg}`;
          continue;
        }

        console.log(`[codex-bridge] RATE_LIMIT_ROTATE_RETRY: ${previous} -> ${next.email}; replaying active turn`);
        try {
          await this.restartAppServerForAuthRotation();
          // A limited retry attempt may have streamed partial deltas before failing;
          // discard them before every replay so the successful account's output
          // cannot be concatenated with stale content from a failed account.
          this.clearCodexPartialTurnStateForRetry();
          this.accumulatedContent = '';
          this.lastStreamedContent = '';
          await this.sendTurn(content);
          return;
        } catch (err) {
          const retryMsg = (err as Error).message;
          if (isCodexLimitError(retryMsg)) {
            const unavailableMs = parseRetryDelayMs(retryMsg) ?? retryDelay;
            this.codexAccountUnavailableUntil.set(next.email, Date.now() + unavailableMs);
            this.clearCodexPartialTurnStateForRetry();
            console.warn(`[codex-bridge] RATE_LIMIT_ROTATE_RETRY_LIMITED: ${next.email}: ${retryMsg}`);
            errorMsg = retryMsg;
            continue;
          }
          if (isCodexAuthFailure(retryMsg)) {
            this.markCodexAccountPermanentFailure(next.email, retryMsg);
          } else {
            // Startup/initialize failures can be account-specific (stale auth file,
            // revoked session, app-server rejecting the selected profile). Keep
            // exhausting the remaining pool before failing the user turn.
            this.codexAccountUnavailableUntil.set(next.email, Date.now() + retryDelay);
          }
          this.clearCodexPartialTurnStateForRetry();
          console.warn(`[codex-bridge] RATE_LIMIT_ROTATE_RETRY_STARTUP_FAILED: ${next.email}: ${retryMsg}`);
          errorMsg = `${errorMsg}; retry with ${next.email} failed: ${retryMsg}`;
        }
      }

      const waitNow = Date.now();
      const elapsedNowMs = waitNow - (this.codexActiveLimitFirstFailedAt ?? waitNow);
      const waits = [...this.codexAccountUnavailableUntil.values()].filter((ts) => ts > waitNow).map((ts) => ts - waitNow);
      if (waits.length === 0) {
        errorMsg = `${errorMsg}; no Codex accounts currently eligible for retry`;
        throw new Error(errorMsg);
      }
      const waitMs = Math.min(Math.min(...waits), Math.max(0, maxWaitMs - elapsedNowMs));
      if (elapsedNowMs < maxWaitMs && waitMs > 0) {
        console.log(`[codex-bridge] All non-permanent Codex accounts unavailable; waiting ${Math.round(waitMs / 1000)}s before replaying active turn (elapsed=${Math.round(elapsedLimitWaitMs / 1000)}s max=${Math.round(maxWaitMs / 1000)}s)`);
        await sleep(waitMs + 1000);
        const afterWait = Date.now();
        for (const [email, until] of this.codexAccountUnavailableUntil.entries()) {
          if (until <= afterWait) this.codexAccountUnavailableUntil.delete(email);
        }
        // Re-enter the full rotation path after cooldown expiry. If the first
        // waking account is still limited, the normal per-account catch marks it
        // unavailable and keeps trying the remaining pool instead of falling
        // straight to RATE_LIMIT_EXHAUSTED.
        await this.retryCodexActiveTurnAfterLimit(errorMsg);
        return;
      }
    } catch (err) {
      errorMsg = `${errorMsg}; retry failed: ${(err as Error).message}`;
    }

    // Do not let partial output from the final failed attempt leak into later turns.
    this.clearCodexPartialTurnStateForRetry();
    console.error(`[codex-bridge] RATE_LIMIT_EXHAUSTED: ${errorMsg}`);
    this.broadcastToThread(threadId, {
      type: 'error', execution_id: threadId,
      data: { message: `All configured Codex accounts are rate-limited or unavailable. Last error: ${errorMsg}` },
    });
    this.broadcastToThread(threadId, {
      type: 'complete', execution_id: threadId,
      data: { result: { total_turns: this.turnCount, input_tokens: this.totalInputTokens, output_tokens: this.totalOutputTokens } },
    });
    this.activeThreadId = null;
    this.activeThreadStartedAt = null;
    this.activeMessageId = null;
    this.activeTurnContent = null;
    this.activeTurnNoProgressReplayCount = 0;
    this.activeTurnIsHeartbeat = false;
    this.heartbeatToolCalls = [];
    this.heartbeatToolResults = [];
    this.activeConnectSenderUsername = null;
    this.activeConnectMessageUserCalled = false;
    this.activeQueuedMessage = null;
    this.codexActiveLimitFirstFailedAt = null;
    // Keep cooldown/permanent-failure maps after exhaustion so the next turn
    // does not immediately retry known unavailable accounts.
    if (this.activeTurnResolve) {
      this.activeTurnResolve();
      this.activeTurnResolve = null;
    }
    this.processQueue();
  }

  private async refreshForIdToken(refreshToken: string): Promise<{
    access_token: string; refresh_token?: string; id_token?: string;
  } | null> {
    const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
    const TOKEN_URL = 'https://auth.openai.com/oauth/token';
    try {
      const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.error(`[codex-bridge] Token refresh failed: ${resp.status} ${text.slice(0, 200)}`);
        return null;
      }
      const data = await resp.json() as Record<string, string>;
      return { access_token: data.access_token ?? '', refresh_token: data.refresh_token, id_token: data.id_token };
    } catch (e) {
      console.error(`[codex-bridge] Token refresh error: ${(e as Error).message}`);
      return null;
    }
  }

  // ── HTTP/WS Server ──

  private async startServer(): Promise<void> {
    this.app = Fastify({ logger: false });
    await this.app.register(cors, { origin: true });

    this.app.get('/health', async () => {
      const quotaUnavailable = this.providerUnavailable
        && isCodexLimitError(this.providerUnavailableReason ?? '');
      const providerHealthy = this.serverReady && this.hasAuth && !this.providerUnavailable;
      const runtimeRollDrain = this.runtimeRollDrain.snapshot(
        this.activeThreadId !== null,
        this.messageQueue.length,
      );
      return {
        status: providerHealthy ? 'ok' : 'degraded', bridge: 'codex-app-server', model: this.opts.model,
        busy: this.activeThreadId !== null, queueDepth: this.messageQueue.length,
        serverReady: this.serverReady, initialized: this.serverReady,
        authenticated: this.hasAuth,
        providerHealthy,
        provider_available: providerHealthy,
        quota_ok: !quotaUnavailable,
        in_backoff: this.providerUnavailable,
        uptime: Date.now() - this.startTime,
        // Cumulative token/turn counters (load metric — exporter scrapes these and
        // Grafana rate()s them into tok/min, tok/hour per agent).
        outputTokens: this.totalOutputTokens, inputTokens: this.totalInputTokens, turns: this.turnCount,
        outputChars: this.totalOutputChars,
        emptyTurnStreak: this.consecutiveEmptyTurns,
        runtimeRollDrain,
      };
    });

    this.app.post<{ Body: RuntimeRollDrainRequest }>(
      '/v1/runtime/rollout-drain',
      async (request, reply) => {
        if (!isLoopbackRuntimeRollCaller(request.ip)) {
          return reply.code(403).send({ ok: false, error: 'loopback_only' });
        }
        try {
          this.runtimeRollDrain.arm(request.body ?? {} as RuntimeRollDrainRequest);
        } catch (error) {
          return reply.code(400).send({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        await this.processQueue();
        return this.runtimeRollDrain.snapshot(
          this.activeThreadId !== null,
          this.messageQueue.length,
        );
      },
    );

    this.app.post<{ Body: { text: string; type?: string; jobName?: string } }>('/v1/proactive', async (request) => {
      if (this.runtimeRollDrain.ready) {
        return { ok: false, retryable: true, error: 'runtime_roll_draining' };
      }
      const { text } = request.body ?? {};
      if (!text) return { ok: false, error: 'text required' };
      const threadId = crypto.randomUUID();
      for (const [, client] of this.clients) {
        client.activeThreadId = threadId;
        this.sendWs(client.ws, { type: 'content', execution_id: threadId, data: { delta: text } });
        this.sendWs(client.ws, { type: 'complete', execution_id: threadId, data: { result: { proactive: true } } });
        client.activeThreadId = null;
      }
      return { ok: true };
    });

    await this.app.listen({ port: this.opts.port, host: this.opts.host });

    const server = this.app.server;
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/ws/chat' || url.pathname === '/ws/chat/') {
        this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => { this.wss!.emit('connection', ws, req); });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = crypto.randomUUID();
      const client: WsClient = { ws, userId: 'localhost', activeThreadId: null };
      this.clients.set(clientId, client);

      console.log(JSON.stringify({
        level: 30, time: Date.now(), pid: process.pid, hostname: os.hostname(),
        userId: 'localhost', msg: 'WebSocket client connected',
      }));

      ws.on('message', (data: any) => {
        try { this.handleWsMessage(clientId, JSON.parse(data.toString())); }
        catch { /* ignore */ }
      });
      ws.on('close', () => { this.clients.delete(clientId); });
      ws.on('error', () => { this.clients.delete(clientId); });

      this.sendWs(ws, { type: 'transport_status', connected: true });
    });

    setInterval(() => {
      for (const [, client] of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try { client.ws.ping(); } catch { /* */ }
        }
      }
    }, 30_000);
  }

  private async handleWsMessage(clientId: string, msg: Record<string, unknown>): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    const type = msg.type as string;

    switch (type) {
      case 'ping':
        this.sendWs(client.ws, { type: 'pong' });
        break;

      case 'subscribe':
        this.sendWs(client.ws, { type: 'subscribed', agent_id: msg.agent_id });
        break;

      case 'message': {
        const content = ((msg.content as string) || '').trim();
        if (!content) {
          this.sendWs(client.ws, { type: 'error', data: { message: 'content is required' } });
          break;
        }
        if (this.runtimeRollDrain.ready) {
          this.sendWs(client.ws, {
            type: 'error',
            data: { message: 'Runtime rollout in progress; retry this message on the replacement runtime' },
          });
          break;
        }

        if (this.activeThreadId) {
          enqueueBridgeMessage(this.messageQueue, { clientId, content });
          this.sendWs(client.ws, { type: 'message_ack', data: { queued: true, session_id: this.sessionId } });
          break;
        }

        await this.startExecution(clientId, content);
        break;
      }

      case 'sync': {
        const session = this.store.loadSession(this.sessionId);
        const storedMsgs = buildSyncHistoryMessages(session?.messages ?? []);
        this.sendWs(client.ws, {
          type: 'sync_history', session_id: this.sessionId,
          messages: storedMsgs,
        });
        break;
      }

      case 'create_session':
        this.sendWs(client.ws, {
          type: 'session_created', session_id: this.sessionId,
          agent: { name: this.opts.agentName ?? 'Codex', id: this.opts.agentId ?? 'codex-bridge' },
        });
        break;

      case 'cancel':
        if (this.activeTurnResolve) {
          // Send turn/interrupt to the app-server
          this.rpcNotify('turn/interrupt', { threadId: this.codexThreadId ?? '' });
        }
        break;
    }
  }

  async stop(): Promise<void> {
    if (this.heartbeatFollowupTimer) clearTimeout(this.heartbeatFollowupTimer);
    this.runtimeRollDrain.dispose();
    if (this.serverProcess && this.serverProcess.exitCode === null) {
      // Graceful shutdown: send exit notification then SIGTERM
      try { this.rpcNotify('exit', {}); } catch { /* */ }
      setTimeout(() => {
        if (this.serverProcess && this.serverProcess.exitCode === null) {
          this.signalCodexTree(this.serverProcess, 'SIGTERM');
        }
      }, 3000);
    }
    if (this.wss) this.wss.close();
    if (this.app) await this.app.close();
  }
}

/** Entry point — called from CLI command. */
export async function startCodexBridge(opts: CodexBridgeOptions): Promise<void> {
  // The constructor creates persistent state, so cwd validation must happen at
  // this exported boundary before construction or any signal/listener setup.
  const bridge = new CodexBridge({
    ...opts,
    cwd: assertWorkspaceDir(opts.cwd ?? '/workspace'),
  });

  process.on('SIGTERM', async () => {
    console.log('[codex-bridge] Received SIGTERM, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[codex-bridge] Received SIGINT, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  await bridge.start();
  await new Promise<void>(() => {}); // Keep alive
}
