/**
 * Claude Bridge — bridges a persistent `claude -p` process to the gateway HTTP/WS protocol.
 *
 * When the execution method is `claude_code_server`, the daemon spawns this instead of
 * `shizuha.js gateway`. It:
 *   1. Starts an HTTP/WS server on the same port the dashboard expects
 *   2. Spawns `claude -p --input-format stream-json --output-format stream-json`
 *   3. Translates WS messages ↔ Claude Code NDJSON protocol
 *
 * The dashboard/mobile app connect to this bridge using the exact same protocol
 * they'd use for the Shizuha gateway — no client changes needed.
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { spawn, execSync, execFileSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
// @ts-ignore — ws has no declaration file
import { WebSocketServer, WebSocket } from 'ws';
import { HEARTBEAT_TRIGGER, writeBaseInstructions } from '../agent-base-instructions.js';
import { resolveBrowserMcpServer } from '../browser-mcp.js';
import { readAgentCredential } from '../auth/credential-resolver.js';
import type { IncomingMessage } from 'node:http';
import { StateStore } from '../state/store.js';
import { isCurrentBridgeChild, isLatchStuck, runSerializedStuckRecovery } from '../shared/stuck-latch-recovery.js';
import {
  formatHeartbeatQueueDrainOutcomeLogLine,
  heartbeatQueueDrainTelemetry,
  recordHeartbeatQueueDrainTurn,
} from '../shared/heartbeat-outcome.js';
import type {
  HeartbeatQueueDrainTurnToolCall,
  HeartbeatQueueDrainTurnToolResult,
} from '../shared/heartbeat-outcome.js';
import {
  isLoopbackRuntimeRollCaller,
  RuntimeRollDrainLease,
  type RuntimeRollDrainRequest,
} from '../shared/runtime-roll-drain.js';
import {
  ActivityPhaseTracker,
  applyAgentEventToPhase,
  buildActivityTelemetry,
  createTelemetryFlusher,
} from '../telemetry/activity-phase.js';

const DEFAULT_CONTAINER_AGENT_UID = 1000;
const DEFAULT_CONTAINER_AGENT_GID = 1000;

function parseContainerAgentId(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function containerAgentUid(): number {
  return parseContainerAgentId('SHIZUHA_CONTAINER_AGENT_UID', DEFAULT_CONTAINER_AGENT_UID);
}

function containerAgentGid(): number {
  return parseContainerAgentId('SHIZUHA_CONTAINER_AGENT_GID', DEFAULT_CONTAINER_AGENT_GID);
}

function chownForContainerAgent(targetPath: string, recursive = true): void {
  const args = recursive
    ? ['-R', `${containerAgentUid()}:${containerAgentGid()}`, targetPath]
    : [`${containerAgentUid()}:${containerAgentGid()}`, targetPath];
  try { execFileSync('chown', args, { stdio: 'ignore' }); } catch { /* */ }
}

// ── Types ──

interface ClaudeBridgeOptions {
  port: number;
  host: string;
  model: string;
  agentId?: string;
  agentName?: string;
  agentUsername?: string;
  thinkingLevel?: string;
  reasoningEffort?: string;
  contextPrompt?: string;
  permissionMode?: string;
  cwd?: string;
}

interface WsClient {
  ws: WebSocket;
  userId: string;
  /** Active execution threadId (only one at a time per client) */
  activeThreadId: string | null;
}

// ── SCLI-61: poisoned-session (wedge) detection ──
//
// ryo (claude-bridge) was hard-wedged ~12h on 2026-06-10: something in the
// PERSISTED eternal session repeatedly tripped the policy classifier, every
// turn failed with "…appears to violate our Usage Policy" (~1 retry/10min,
// ~60 API_ERRORs, zero successful turns), and the bridge resumed the same
// poisoned context forever. A plain restart does NOT recover this class of
// wedge — resumption re-loads the poisoned context — so recovery must rotate
// the session (archive the stored session pointer, start fresh), which is
// exactly the manual mitigation that fixed ryo.
//
// Policy refusals are deterministic-on-context (a poisoned session refuses
// forever) → rotate after a short consecutive run. Generic API errors are
// usually transient (provider blips) → require a longer consecutive run
// before concluding the session is dead. Any successful turn resets the run.
const POLICY_REFUSAL_RE = /violat\w+ (?:our|the) Usage Policy|unable to respond to this request/i;
// SCLI-61 (operator scope-expansion 2026-06-10): the SECOND confirmed wedge
// class (shizuha+ichi, recurring every cycle). When the persisted session
// grows past ~200K tokens, Claude Code requests the 1M-context model variant
// the subscription doesn't cover → every turn fails "Usage credits required
// for 1M context" until the session shrinks. Like policy-refusal it's
// DETERMINISTIC-ON-CONTEXT (a too-large session fails forever; resuming
// re-loads it), so it shares the cure (rotate → fresh, smaller session) and a
// fast consecutive threshold.
const CONTEXT_CREDIT_RE = /credits?\s+required\s+for\b[\w\s]{0,16}\b1M\s+context|1M\s+context\b[\w\s]{0,40}\bcredit|exceeds?\s+the\s+200K/i;
const POLICY_ROTATE_AFTER = parseInt(process.env['BRIDGE_POLICY_ROTATE_AFTER'] ?? '3', 10);
const CONTEXT_ROTATE_AFTER = parseInt(process.env['BRIDGE_CONTEXT_ROTATE_AFTER'] ?? '3', 10);
const ERROR_ROTATE_AFTER = parseInt(process.env['BRIDGE_ERROR_ROTATE_AFTER'] ?? '10', 10);
// If a FRESH session wedges again inside the cooldown, the failure follows the
// inbound work — not the persisted context — and rotating again only destroys
// more context. Stay up, keep counting, stay visible via /health telemetry.
const ROTATE_COOLDOWN_MS = parseInt(process.env['BRIDGE_ROTATE_COOLDOWN_MS'] ?? String(6 * 3600_000), 10);

// ── Claude NDJSON Protocol ──

/** Send a user message to claude -p via stdin (stream-json format). */
function buildUserMessage(content: string, sessionId: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: sessionId,
    message: { role: 'user', content },
    parent_tool_use_id: null,
  });
}

/**
 * True if a JWT is expired or within `bufferMs` of expiry (default 6h), or
 * un-decodable. Used to decide whether the spawn-time AGENT_ACCESS_TOKEN can be
 * trusted or must be re-minted. Conservative: anything we cannot parse is stale.
 */
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTokenLimitError(message: string): boolean {
  if (CONTEXT_CREDIT_RE.test(message)) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes('429') || lower.includes('rate limit') || lower.includes('rate-limit') ||
    lower.includes('hit your limit') || lower.includes('weekly limit') || lower.includes('resets') ||
    (lower.includes('reached your') && lower.includes(' limit')) ||
    lower.includes('usage limit') || lower.includes('quota') ||
    lower.includes('credit balance') || lower.includes('out of credits') ||
    lower.includes('usage credits') || lower.includes('exhaust')
  );
}

// ── NDJSON Parser ──

interface ParsedEvent {
  type: 'content' | 'reasoning' | 'tool_start' | 'tool_complete' | 'complete' | 'error' | 'message_ack' | 'skip';
  data?: Record<string, unknown>;
}

function isBridgePromptDebugEnabled(): boolean {
  return process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS'] === '1';
}

function summarizePromptForLog(prompt: string | null | undefined): Record<string, unknown> {
  const trimmed = prompt?.trim() ?? '';
  return {
    present: trimmed.length > 0,
    length: trimmed.length,
    hasIdentityHeader: trimmed.includes('## Shizuha Agent Identity'),
    firstLine: trimmed.split('\n')[0] ?? '',
  };
}

/**
 * HIVE-125: decide which Claude model token to spawn with, given a (possibly-null)
 * broker-delivered token and the env fallback. FAIL-CLOSED (throws) when a broker is
 * configured AND the broker-token requirement is enforced but no broker token was
 * obtained — never spawn Claude with a stale baked env token in that case (ren P1).
 * The env token is returned as a fallback ONLY when no broker is configured, or when
 * the broker-token requirement is not yet enforced (pre-cutover). Exported for tests.
 */
export function resolveModelTokenPolicy(opts: {
  brokerConfigured: boolean;
  requireBrokerToken: boolean;
  brokerToken: string | null;
  envToken: string;
  hostPoolToken?: string;
}): string {
  if (opts.brokerToken) return opts.brokerToken;
  if (opts.brokerConfigured && opts.requireBrokerToken) {
    throw new Error(
      '[claude-bridge] broker required to serve /model-token but none available after retries; ' +
      'refusing to fall back to a baked CLAUDE_CODE_OAUTH_TOKEN (fail-closed)',
    );
  }
  return opts.envToken || opts.hostPoolToken || '';
}

/**
 * PLAT-879: should the bridge enter the empty-token-pool BACKOFF (stay supervised
 * + retry) instead of crash-looping? True only when a broker is configured AND its
 * model token is REQUIRED AND no token was served. In every other case (no broker,
 * requirement not enforced, or a token present) the normal policy / env fallback
 * applies and we must NOT block. Exported for tests.
 */
export interface ClaudeRuntimeFailoverStep {
  method: string;
  model: string;
  reasoningEffort?: string;
  thinkingLevel?: string;
  maxTokenRetries?: number;
}

export function shouldEnterTokenPoolBackoff(opts: {
  brokerConfigured: boolean;
  requireBrokerToken: boolean;
  brokerToken: string | null;
}): boolean {
  return opts.brokerConfigured && opts.requireBrokerToken && !opts.brokerToken;
}

export function nextNonClaudeFallbackStep(
  failoverChain: ClaudeRuntimeFailoverStep[],
  currentModel: string,
): ClaudeRuntimeFailoverStep | null {
  const currentIdx = failoverChain.findIndex((step) =>
    step.method === 'claude_code_server' && step.model === currentModel,
  );
  const searchFrom = currentIdx >= 0 ? currentIdx + 1 : 0;
  return failoverChain.slice(searchFrom).find((step) => step.method !== 'claude_code_server') ?? null;
}

export function shouldCrossMethodFailoverOnRequiredBrokerMiss(opts: {
  brokerConfigured: boolean;
  requireBrokerToken: boolean;
  brokerToken: string | null;
  failoverChain: ClaudeRuntimeFailoverStep[];
  currentModel: string;
}): boolean {
  return shouldEnterTokenPoolBackoff(opts)
    && !!nextNonClaudeFallbackStep(opts.failoverChain, opts.currentModel);
}

/** PLAT-879/HIVE-206: bounded exponential backoff for empty-pool retries.
 * Start at heartbeat scale and cap at 10m so a depleted shared provider pool
 * does not make every Claude agent poll the coordinator every minute forever. */
export const CLAUDE_TOKEN_POOL_UNAVAILABLE_REASON = 'claude-token-pool-exhausted';
export const CLAUDE_PROVIDER_UNAVAILABLE_MARKER_ENV = 'SHIZUHA_CLAUDE_PROVIDER_UNAVAILABLE_MARKER';

export function readClaudeProviderUnavailableMarker(
  marker = process.env[CLAUDE_PROVIDER_UNAVAILABLE_MARKER_ENV]?.trim(),
): string | null {
  if (!marker || !fs.existsSync(marker)) return null;
  try {
    return fs.readFileSync(marker, 'utf8').trim()
      || 'provider unavailable; supervisor backoff retry in progress';
  } catch {
    return 'provider unavailable; supervisor backoff retry in progress';
  }
}

export function writeClaudeProviderUnavailableMarker(
  reason: string,
  marker = process.env[CLAUDE_PROVIDER_UNAVAILABLE_MARKER_ENV]?.trim(),
): void {
  if (!marker) return;
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, reason, { mode: 0o600 });
  } catch { /* current-process telemetry still reports the outage */ }
}

export function clearClaudeProviderUnavailableMarker(
  marker = process.env[CLAUDE_PROVIDER_UNAVAILABLE_MARKER_ENV]?.trim(),
): void {
  if (!marker) return;
  try { fs.unlinkSync(marker); } catch { /* missing/unwritable is best-effort */ }
}

export function nextTokenPoolBackoffMs(
  prevMs: number,
  capMs = Number(process.env['CLAUDE_BRIDGE_TOKEN_POOL_BACKOFF_MAX_MS'] ?? 10 * 60_000),
  floorMs = Number(process.env['CLAUDE_BRIDGE_TOKEN_POOL_BACKOFF_INITIAL_MS'] ?? 60_000),
): number {
  const saneFloor = Number.isFinite(floorMs) && floorMs > 0 ? floorMs : 60_000;
  const saneCap = Math.max(saneFloor, Number.isFinite(capMs) && capMs > 0 ? capMs : 10 * 60_000);
  const base = prevMs && prevMs > 0 ? prevMs * 2 : saneFloor;
  return Math.min(base, saneCap);
}

export function jitteredDelayMs(ms: number, ratio = 0.3): number {
  const spread = Math.max(0, ms * ratio);
  return Math.round(ms + Math.random() * spread);
}

export function isHeartbeatTrigger(content: string): boolean {
  const trimmed = content.trim();
  return trimmed === HEARTBEAT_TRIGGER.trim()
    || trimmed === CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER.trim();
}

export const CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER =
  '[HEARTBEAT RETRY] The preceding scheduler turn ended before successfully observing Pulse. ' +
  'Call `mcp__shizuha-pulse__pulse_get_my_alerts` as your FIRST action now, then call `mcp__shizuha-pulse__pulse_get_my_tasks`. This exact ordered native MCP pair is mandatory; ' +
  'do not infer either inbox from prior conversation, call a status-filtered substitute, or act on remembered work first. ' +
  'After both unfiltered results: work/forward the highest-priority ready item across alerts and tasks; alerts win ties but never preempt higher-priority task WIP. Continue per the heartbeat protocol, ' +
  'or produce ZERO output only if both inboxes prove nothing is movable.';

function toolResultHasContent(content: unknown): boolean {
  if (typeof content === 'string') return content.trim().length > 0;
  if (Array.isArray(content)) return content.some(toolResultHasContent);
  return content !== null && content !== undefined;
}

const CLAUDE_HEARTBEAT_ALERT_TOOL =
  'mcp__shizuha-pulse__pulse_get_my_alerts';
const CLAUDE_HEARTBEAT_TASK_TOOL =
  'mcp__shizuha-pulse__pulse_get_my_tasks';
const CLAUDE_HEARTBEAT_GATE_MARKER =
  '.heartbeat-pulse-observation-required';
const CLAUDE_HEARTBEAT_HOOK_SCRIPT =
  '.claude-heartbeat-observation-hook.cjs';

/**
 * Install a deterministic Claude Code PreToolUse gate. Prompt text alone did
 * not stop resumed sessions from executing a remembered task before observing
 * Pulse. Both the bridge and Claude's own UserPromptSubmit boundary create a
 * marker, so process/injection races cannot leave a heartbeat unarmed. The
 * PreToolUse hook blocks every other tool before execution. The marker is a
 * two-stage state machine: alerts must succeed before tasks; a successful
 * unfiltered task read then removes it.
 */
export function installClaudeHeartbeatObservationHooks(
  settings: Record<string, unknown>,
  workDir: string,
): { markerPath: string; scriptPath: string } {
  const markerPath = path.join(workDir, CLAUDE_HEARTBEAT_GATE_MARKER);
  const scriptPath = path.join(workDir, CLAUDE_HEARTBEAT_HOOK_SCRIPT);
  const script = `'use strict';
const fs = require('node:fs');
const mode = process.argv[2] || '';
const marker = process.argv[3] || '';
const alertTool = process.argv[4] || '';
const taskTool = process.argv[5] || '';
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let event = {};
  try { event = JSON.parse(raw || '{}'); } catch {}
  const toolName = String(event.tool_name || '');
  if (mode === 'prompt' && marker) {
    const prompt = String(event.prompt || '').trimStart();
    if (/^\\[HEARTBEAT(?: RETRY)?\\]/i.test(prompt)) {
      try { fs.writeFileSync(marker, 'alerts', { mode: 0o600 }); } catch {}
    }
    return;
  }
  let stage = '';
  if (marker && fs.existsSync(marker)) {
    try { stage = fs.readFileSync(marker, 'utf8').trim(); } catch {}
  }
  const requiredTool = stage === 'tasks' ? taskTool : alertTool;
  if (mode === 'pre' && stage && toolName !== requiredTool) {
    process.stderr.write(
      'Heartbeat inbox observation required: call ' + requiredTool +
      ' successfully before any other tool. Required order is alerts then tasks; prior conversation is not current state.\\n'
    );
    process.exitCode = 2;
    return;
  }
  if (mode === 'post' && stage === 'alerts' && toolName === alertTool) {
    try { fs.writeFileSync(marker, 'tasks', { mode: 0o600 }); } catch {}
    return;
  }
  if (mode === 'post' && stage === 'tasks' && toolName === taskTool) {
    try { fs.unlinkSync(marker); } catch {}
  }
});
`;
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(scriptPath, script, { mode: 0o644 });
  if (process.getuid?.() === 0) chownForContainerAgent(scriptPath, false);

  const hooks = (
    settings.hooks && typeof settings.hooks === 'object'
      ? settings.hooks
      : {}
  ) as Record<string, unknown>;
  settings.hooks = hooks;

  // Replace this bridge-owned hook family on upgrade instead of accumulating
  // stale shell-form handlers in the persistent Claude settings file.
  for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse'] as const) {
    if (!Array.isArray(hooks[event])) continue;
    for (const group of hooks[event] as Array<Record<string, unknown>>) {
      if (!Array.isArray(group.hooks)) continue;
      group.hooks = (group.hooks as Array<Record<string, unknown>>).filter(
        (handler) => {
          const command = typeof handler.command === 'string' ? handler.command : '';
          const args = Array.isArray(handler.args)
            ? handler.args.filter((arg): arg is string => typeof arg === 'string')
            : [];
          return !command.includes(scriptPath) && !args.includes(scriptPath);
        },
      );
    }
    hooks[event] = (hooks[event] as Array<Record<string, unknown>>).filter(
      (group) => Array.isArray(group.hooks) && group.hooks.length > 0,
    );
  }

  const upsert = (
    event: 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse',
    matcher: string | undefined,
    args: string[],
  ) => {
    const groups = Array.isArray(hooks[event])
      ? hooks[event] as Array<Record<string, unknown>>
      : [];
    hooks[event] = groups;
    let group = groups.find((candidate) =>
      matcher === undefined
        ? candidate.matcher === undefined
        : candidate.matcher === matcher,
    );
    if (!group) {
      group = matcher === undefined
        ? { hooks: [] }
        : { matcher, hooks: [] };
      groups.push(group);
    }
    const handlers = Array.isArray(group.hooks)
      ? group.hooks as Array<Record<string, unknown>>
      : [];
    group.hooks = handlers;
    if (!handlers.some((handler) =>
      handler.type === 'command'
      && handler.command === 'node'
      && JSON.stringify(handler.args) === JSON.stringify(args),
    )) {
      handlers.push({ type: 'command', command: 'node', args, timeout: 5 });
    }
  };

  upsert(
    'UserPromptSubmit',
    undefined,
    [
      scriptPath,
      'prompt',
      markerPath,
      CLAUDE_HEARTBEAT_ALERT_TOOL,
      CLAUDE_HEARTBEAT_TASK_TOOL,
    ],
  );
  upsert(
    'PreToolUse',
    '*',
    [
      scriptPath,
      'pre',
      markerPath,
      CLAUDE_HEARTBEAT_ALERT_TOOL,
      CLAUDE_HEARTBEAT_TASK_TOOL,
    ],
  );
  upsert(
    'PostToolUse',
    CLAUDE_HEARTBEAT_ALERT_TOOL,
    [
      scriptPath,
      'post',
      markerPath,
      CLAUDE_HEARTBEAT_ALERT_TOOL,
      CLAUDE_HEARTBEAT_TASK_TOOL,
    ],
  );
  upsert(
    'PostToolUse',
    CLAUDE_HEARTBEAT_TASK_TOOL,
    [
      scriptPath,
      'post',
      markerPath,
      CLAUDE_HEARTBEAT_ALERT_TOOL,
      CLAUDE_HEARTBEAT_TASK_TOOL,
    ],
  );
  return { markerPath, scriptPath };
}

export function maxClaudeBridgeQueueDepth(): number {
  const configured = Number(process.env['CLAUDE_BRIDGE_MAX_QUEUE_DEPTH'] ?? 100);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 100;
}


export interface OriMcpEntry {
  type: 'http';
  url: string;
}

export function buildOriMcpEntry(oriHost: string, oriPort: string): OriMcpEntry {
  return {
    type: 'http',
    url: `http://${oriHost}:${oriPort}/mcp`,
  };
}

export function buildOriMcpProbeCommand(oriHost: string, oriPort: string): string {
  return `curl -sf http://${oriHost}:${oriPort}/mcp -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' --max-time 3`;
}

export function shouldDropQueuedMessage(
  queue: Array<{ content: string }>,
  content: string,
  maxDepth = maxClaudeBridgeQueueDepth(),
): { drop: boolean; reason: string } {
  if (isHeartbeatTrigger(content) && queue.some((item) => isHeartbeatTrigger(item.content))) {
    return { drop: true, reason: 'duplicate-heartbeat' };
  }
  if (queue.length >= maxDepth && isHeartbeatTrigger(content)) {
    return { drop: true, reason: 'queue-full-heartbeat' };
  }
  if (queue.length >= maxDepth) {
    return { drop: true, reason: 'queue-full' };
  }
  return { drop: false, reason: '' };
}

export interface ClaudeBridgeQueuedMessage {
  clientId: string;
  content: string;
  messageId?: string;
}

export function isRoutineClaudeConnectTaskMessage(message: ClaudeBridgeQueuedMessage): boolean {
  if (!message.clientId.startsWith('connect:')) return false;
  return /^\[system\]\s+(?:\[Task (?:Assigned|Update)\]|\[(?:Review Seat Starvation|Routability Hold)\])/i.test(
    message.content.trim(),
  );
}

/** System incidents/revocations remain ahead of Pulse scheduling. Ordinary
 * agent/human chat does not outrank a pending canonical task refresh. */
export function isPriorityClaudeConnectControlMessage(
  message: ClaudeBridgeQueuedMessage,
): boolean {
  return message.clientId.startsWith('connect:')
    && !isRoutineClaudeConnectTaskMessage(message)
    && /^\[system\]\s/i.test(message.content.trim());
}

export type ClaudeBridgeQueueAction =
  | { kind: 'retry' }
  | { kind: 'message'; index: number }
  | { kind: 'heartbeat' }
  | { kind: 'idle' };

/** Stable turn-boundary priority: preserve a failed turn first, then explicit
 * control-plane incidents, then a pending canonical Pulse checkpoint. Ordinary
 * agent/human DMs cannot hide urgent WIP behind a chat backlog. */
export function selectClaudeBridgeQueueAction(
  queue: ClaudeBridgeQueuedMessage[],
  pendingRetry: boolean,
  heartbeatPending: boolean,
): ClaudeBridgeQueueAction {
  if (pendingRetry) return { kind: 'retry' };
  const controlMessageIndex = queue.findIndex(isPriorityClaudeConnectControlMessage);
  if (controlMessageIndex >= 0) return { kind: 'message', index: controlMessageIndex };
  if (heartbeatPending) return { kind: 'heartbeat' };
  const directMessageIndex = queue.findIndex((message) => !isRoutineClaudeConnectTaskMessage(message));
  if (directMessageIndex >= 0) return { kind: 'message', index: directMessageIndex };
  if (queue.length > 0) return { kind: 'message', index: 0 };
  return { kind: 'idle' };
}

export function buildClaudeSpawnArgs(params: {
  model: string;
  storedSessionId?: string | null;
  mcpNewlyConfigured?: boolean;
  contextPrompt?: string;
  contextPromptFile?: string;
}): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', params.model,
    '--dangerously-skip-permissions',
    '--include-partial-messages',
  ];

  if (params.storedSessionId && !params.mcpNewlyConfigured) {
    args.push('--resume', params.storedSessionId);
  }

  args.push('--disallowedTools', 'EnterPlanMode,ExitPlanMode,AskUserQuestion');

  if (params.contextPromptFile) {
    // The combined bridge prompt can exceed the OS single-arg limit
    // (MAX_ARG_STRLEN ~128KB) → spawn E2BIG (2026-07-03: Nova/Aoi at ~130KB
    // could not start). Pass it by path; claude >=2.1.x reads
    // --append-system-prompt-file.
    args.push('--append-system-prompt-file', params.contextPromptFile);
  } else if (params.contextPrompt) {
    args.push('--append-system-prompt', params.contextPrompt);
  }

  return args;
}

const CLAUDE_REMOTE_CONTROL_ENV_KEYS = new Set([
  // Claude Code treats these as managed/remote-control contexts. Fleet agents use
  // inference-only setup-token OAuth, so never inherit remote-control mode.
  'CLAUDE_CODE_REMOTE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
]);

export function buildClaudeSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  params: { homeDir: string; user: string; oauthToken: string },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (CLAUDE_REMOTE_CONTROL_ENV_KEYS.has(key) || key.startsWith('CLAUDE_CODE_REMOTE_')) {
      delete env[key];
    }
  }
  env.HOME = params.homeDir;
  env.USER = params.user;
  env.CLAUDE_CODE_OAUTH_TOKEN = params.oauthToken;
  return env;
}

function parseStreamJsonLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const msgType = msg.type as string;

  // ── system init ──
  if (msgType === 'system') {
    // system/init — claude is ready. Extract session_id for persistence.
    const sessionId = msg.session_id as string | undefined;
    return { type: 'message_ack', data: sessionId ? { session_id: sessionId } : undefined };
  }

  // ── stream_event (Anthropic SDK passthrough) ──
  if (msgType === 'stream_event') {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return null;
    const eventType = event.type as string;

    // content_block_start → tool_use
    if (eventType === 'content_block_start') {
      const cb = event.content_block as Record<string, unknown> | undefined;
      if (cb?.type === 'tool_use') {
        return {
          type: 'tool_start',
          data: {
            tool: cb.name as string || 'tool',
            input: cb.input || {},
            tool_call_id: cb.id as string || '',
          },
        };
      }
      return null;
    }

    // content_block_delta → text or thinking
    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return null;
      if (delta.type === 'text_delta') {
        const text = delta.text as string;
        if (text) return { type: 'content', data: { delta: text } };
      }
      if (delta.type === 'thinking_delta') {
        const thinking = delta.thinking as string;
        if (thinking) return { type: 'reasoning', data: { summaries: [thinking] } };
      }
      if (delta.type === 'summary_text_delta') {
        const text = delta.text as string;
        if (text) return { type: 'reasoning', data: { summaries: [text] } };
      }
      return null;
    }

    // message_start → usage tracking
    if (eventType === 'message_start') {
      const usage = (event.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown>;
      if (usage) {
        return { type: 'skip', data: { _usage_start: usage } };
      }
      return null;
    }

    // message_delta → final usage
    if (eventType === 'message_delta') {
      const usage = event.usage as Record<string, unknown>;
      if (usage) {
        return { type: 'skip', data: { _usage_delta: usage } };
      }
      return null;
    }

    return null;
  }

  // ── Legacy/direct event types ──

  if (msgType === 'content') {
    const payload = msg.data as Record<string, unknown> | undefined;
    const delta = (payload?.delta ?? payload?.text) as string | undefined;
    if (delta) return { type: 'content', data: { delta } };
    return null;
  }

  if (msgType === 'tool_start') {
    const payload = msg.data as Record<string, unknown> | undefined;
    return {
      type: 'tool_start',
      data: {
        tool: (payload?.tool ?? payload?.name ?? 'tool') as string,
        input: payload?.input || {},
        tool_call_id: (payload?.tool_call_id ?? '') as string,
      },
    };
  }

  if (msgType === 'tool_complete') {
    const payload = msg.data as Record<string, unknown> | undefined;
    return {
      type: 'tool_complete',
      data: {
        tool: (payload?.tool ?? payload?.name ?? 'tool') as string,
        tool_call_id: (payload?.tool_call_id ?? '') as string,
        output: payload?.output ?? payload?.content ?? '',
        duration_ms: (payload?.duration_ms ?? 0) as number,
        is_error: (payload?.is_error ?? false) as boolean,
      },
    };
  }

  if (msgType === 'reasoning') {
    const payload = msg.data as Record<string, unknown> | undefined;
    const summaries = payload?.summaries;
    if (Array.isArray(summaries) && summaries.length > 0) {
      return { type: 'reasoning', data: { summaries } };
    }
    return null;
  }

  if (msgType === 'error') {
    const payload = msg.data as Record<string, unknown> | undefined;
    const message = (payload?.message ?? msg.error ?? 'Unknown error') as string;
    return { type: 'error', data: { message } };
  }

  if (msgType === 'result') {
    // Final result — signals turn completion. The Agent SDK emits result
    // subtype 'success' | 'error_during_execution' | 'error_max_turns', and also
    // sets is_error=true with subtype='success' for auth failures / rate limits.
    // SCLI-61: treat ANY non-success result as a failed turn so it feeds the
    // rotation counter (gating on subtype==='error' alone swallowed the
    // error_during_execution / error_max_turns variants → they'd reset the
    // counter as if successful). Only (subtype==='success' && !is_error) is a
    // real successful turn.
    const resultText = msg.result as string | undefined;
    const subtype = msg.subtype as string | undefined;
    const isErrorResult = msg.is_error === true || (subtype !== undefined && subtype !== 'success');
    if (isErrorResult) {
      const message = (resultText || msg.error || `result ${subtype ?? 'error'}`) as string;
      return { type: 'error', data: { message } };
    }
    return {
      type: 'complete',
      data: {
        result: resultText || '',
        duration_seconds: (msg.duration_seconds ?? 0) as number,
        input_tokens: (msg.input_tokens ?? 0) as number,
        output_tokens: (msg.output_tokens ?? 0) as number,
      },
    };
  }

  // Claude Code emits successful/failed MCP results as a live `user` message
  // containing a tool_result block. Preserve that result so heartbeat
  // enforcement can distinguish an actual Pulse queue snapshot from a mere
  // attempted tool call. Resumed-history messages were already filtered by
  // handleStdoutChunk's isReplay guard.
  if (msgType === 'user') {
    const message = msg.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (Array.isArray(content)) {
      const result = content.find((block) => (
        block && typeof block === 'object'
        && (block as Record<string, unknown>).type === 'tool_result'
      )) as Record<string, unknown> | undefined;
      if (result) {
        return {
          type: 'tool_complete',
          data: {
            tool: '',
            tool_call_id: (result.tool_use_id ?? '') as string,
            output: result.content ?? '',
            is_error: result.is_error === true,
          },
        };
      }
    }
    return null;
  }

  // Skip: assistant, keep_alive, system
  if (msgType === 'assistant' || msgType === 'keep_alive') {
    return null;
  }

  return null;
}

// ── API error classification ──

export interface ClaudeApiErrorClass {
  /** Auth/expired-token (401). Needs a token refresh (restart), NOT a rate-limit cooldown. */
  is401: boolean;
  /** Rate/usage/quota/credit limit (429-class). Routes to token rotation + cooldown. */
  is429: boolean;
  /** Transient server overload (529). Retried in place. */
  is529: boolean;
  /**
   * Permanently dead credential (non-refreshable): the Anthropic org disabled
   * Claude Code subscription access, or the OAuth grant was revoked. Refresh
   * still SUCCEEDS for these (the hive refresh-based health check cannot see
   * them — cl2-primary 2026-07-11), so the pool keeps re-leasing the corpse
   * unless serving-time detection deactivates it. Routes to broker
   * `deactivate` (pool-wide auth_failed, same-fingerprint peers included) +
   * immediate token rotation.
   */
  isTokenDead: boolean;
}

/**
 * Classify a Claude/Anthropic API error message into the buckets the bridge reacts to.
 *
 * HIVE-143: an auth-`401` (expired/invalid OAuth token) MUST be distinct from a
 * `429` (rate/usage/quota). They previously collapsed together, so an expired
 * token mid-session was parked in the 6h rate-limit cooldown — wrongly removing a
 * merely-expired (refreshable) token from the pool and wedging the agent. A 401
 * instead needs a restart so the startup token-refresh path issues a fresh token.
 * `is401` therefore takes PRECEDENCE: a message is never both 401 and 429.
 */
export function classifyClaudeApiError(message: unknown): ClaudeApiErrorClass {
  const lower = typeof message === 'string' ? message.toLowerCase() : '';
  if (!lower) return { is401: false, is429: false, is529: false, isTokenDead: false };
  const is529 = lower.includes('529') || lower.includes('overloaded');
  // Dead credential (non-refreshable; takes precedence over 401/429): the
  // account's Anthropic org disabled Claude Code, or the grant was revoked.
  // A restart-time refresh does NOT cure these — the same credential comes
  // back and fails identically, so they must deactivate the pool entry.
  const isTokenDead = (
    lower.includes('disabled claude subscription access') ||
    lower.includes('organization has disabled claude') ||
    lower.includes('oauth token has been revoked') ||
    lower.includes('token has been revoked') ||
    lower.includes('oauth account has been disabled')
  );
  // Auth/expired-token — Anthropic surfaces these as 401 authentication_error /
  // invalid bearer token / expired OAuth token. This is NOT a rate limit.
  const is401 = !isTokenDead && (
    lower.includes('401') || lower.includes('unauthorized') ||
    lower.includes('authentication_error') || lower.includes('authentication error') ||
    lower.includes('invalid bearer token') || lower.includes('invalid x-api-key') ||
    lower.includes('oauth token has expired') || lower.includes('token has expired') ||
    lower.includes('token expired') ||
    // "Failed to authenticate. API Error: 403 ..." — an auth-time 403 is a
    // credential problem, not a rate limit; rotate rather than counting it
    // toward the generic poisoned-session threshold (nova 2026-07-11).
    (lower.includes('403') && lower.includes('failed to authenticate')) ||
    lower.includes('not logged in') || lower.includes('please run /login') ||
    lower.includes('please run login')
  );
  // Quota/limit class — but ONLY when it is not an auth-401 (mutual exclusivity).
  const is429 = !is401 && !isTokenDead && (
    lower.includes('429') || lower.includes('rate limit') || lower.includes('rate-limit') ||
    lower.includes('hit your limit') || lower.includes('weekly limit') || lower.includes('resets') ||
    (lower.includes('reached your') && lower.includes(' limit')) ||
    lower.includes('usage limit') || lower.includes('quota') ||
    lower.includes('credit balance') || lower.includes('out of credits') ||
    lower.includes('usage credits') || lower.includes('exhaust')
  );
  return { is401, is429, is529, isTokenDead };
}

export function providerUnavailableFromRecentErrors(
  tokenPoolUnavailable: boolean,
  recentErrors: Array<{ ts: number; msg: string }>,
  lastSuccessfulTurnAt: number,
): boolean {
  if (tokenPoolUnavailable) return true;
  return recentErrors.some((err) => {
    if (err.ts <= lastSuccessfulTurnAt) return false;
    const cls = classifyClaudeApiError(err.msg);
    return cls.is401 || cls.is429;
  });
}

// ── Bridge ──

export class ClaudeBridge {
  private app: FastifyInstance | null = null;
  private wss: WebSocketServer | null = null;
  private claudeProcess: ChildProcess | null = null;
  private clients = new Map<string, WsClient>();
  private lineBuffer = '';
  private accumulatedContent = '';
  private sessionId = '';
  private store: StateStore;
  private claudeSessionId = ''; // Real session ID from Claude Code
  private initialized = false;
  private startTime = Date.now();
  private isReplaying = true; // True during startup replay of resumed session

  // Token tracking (accumulated across turns)
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalOutputChars = 0;
  private retryCount529 = 0;
  private turnCount = 0;
  // Telemetry (reported to the platform over Connect — see buildTelemetry()).
  private lastTurnInputTokens = 0;       // context size of the most recent turn (input tokens)
  private lastTurnOutputTokens = 0;      // output tokens produced by the last turn
  private lastTurnDurationMs = 0;        // wall time of the last turn (for tok/s)
  private outputAtLastComplete = 0;      // totalOutputTokens snapshot at previous turn end
  private lastCompleteAt = Date.now();   // timestamp of previous turn end
  private lastActivityAt = Date.now();   // last turn start/end (idle detection)
  private recentErrors: Array<{ ts: number; level: string; msg: string }> = [];
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private activeMessageId: string | null = null;
  /** Labels of tokens that have been rate-limited in this session */
  private rateLimitedTokens = new Set<string>();
  /** Label of the currently active token */
  private currentTokenLabel: string | null = null;
  /** Broker lease metadata for the currently active token, when broker-mode selected it. */
  private currentBrokerModelToken: { entryId: string; leaseId: string } | null = null;
  /** Current user turn content; retained so token rotation can retry the same turn. */
  private activeTurnContent: string | null = null;
  /** Current user-turn client id; null for synthetic/proactive turns. */
  /** Token labels already tried for the active user turn. */
  private activeTurnRateLimitedTokens = new Set<string>();
  /** Suppress one specific old child exit while intentionally respawning Claude for token rotation. */
  private suppressedClaudeExitProc: ChildProcess | null = null;

  /**
   * Kill the ENTIRE claude process tree, not just the top process.
   *
   * `this.claudeProcess` is the `runuser` leader (we spawn `runuser -p -u agent --
   * claude …` as root); `runuser` does NOT forward signals to `claude`, and
   * `claude`'s stdio `mcp-proxy` children are separate processes. So a bare
   * `proc.kill()` signals runuser only and ORPHANS claude + every mcp-proxy →
   * they linger as zombies (observed: two `mcp-proxy --name pulse` in one
   * container, one stuck on an expired token → recurring "MCP requires
   * re-authorization"). Because we spawn `detached`, the child leads its own
   * process group, so a negative-PID signal reaps the whole group (runuser +
   * claude + all proxies). Falls back to a direct kill if the group send fails.
   */
  private killClaudeTree(proc: ChildProcess | null, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (!proc || proc.exitCode !== null || proc.killed) return;
    if (proc.pid == null) {
      try { proc.kill(signal); } catch { /* already gone */ }
      return;
    }
    try {
      process.kill(-proc.pid, signal); // negative pid = whole process group
    } catch {
      try { proc.kill(signal); } catch { /* already gone */ }
    }
  }
  /** Guard against duplicate 429/error records starting overlapping in-turn rotations. */
  private claudeActiveTurnRotationInFlight = false;
  /** Synchronously claimed active-turn rotation promise; closes caller-side race windows. */
  private claudeActiveTurnRotationPromise: Promise<void> | null = null;
  /** In-process mirror of daemon-reported Claude token cooldowns. */
  private claudeTokenUnavailableUntil = new Map<string, number>();
  /** Parsed failover chain from SHIZUHA_MODEL_FALLBACKS */
  private failoverChain: ClaudeRuntimeFailoverStep[] = [];
  /** Current index in the failover chain (within same method) */
  private failoverChainIndex = 0;

  // Replay history — collected during startup for sync responses
  private replayHistory: Array<{ id?: string; role: string; content: string; createdAt: string }> = [];

  // The threadId of the current active execution (claude -p is single-threaded)
  private activeThreadId: string | null = null;
  private readonly activityPhase = new ActivityPhaseTracker({
    onChange: () => this.telemetryFlusher?.soon(),
  });
  private readonly telemetryFlusher = createTelemetryFlusher(() => this.emitTelemetry());
  // Heartbeat watchdog: when activeThreadId (the "busy" latch) was last set, and
  // the max time it may stay set before fireHeartbeat treats the turn as dead and
  // force-clears it. A turn that dies mid-flight without hitting a clear path
  // (e.g. Connect/platform churn) would otherwise leave the latch stuck and skip
  // EVERY heartbeat forever — silently parking the agent until a manual restart.
  private activeThreadStartedAt: number | null = null;
  /** Last parsed live child event for the active execution. The watchdog must
   * fence no-progress wedges, not healthy long-running turns. */
  private activeTurnLastProgressAt: number | null = null;
  private heartbeatStuckMs = 20 * 60 * 1000;

  // Message queue — direct/control traffic stays FIFO ahead of routine task
  // notification hints; the turn-boundary arbiter owns final dispatch order.
  private messageQueue: ClaudeBridgeQueuedMessage[] = [];
  private activeConnectMessageId: string | null = null;
  /** A cadence tick observed while busy. It is coalesced and runs at the next
   * safe boundary after genuine direct/control traffic but before routine task
   * notifications. */
  private heartbeatPending = false;
  /** Controller-owned, bounded fence that stops autonomous successor turns at
   * a safe boundary before replacing this runtime pod. */
  private runtimeRollDrain = new RuntimeRollDrainLease(() => {
    if (this.runtimeRollConnectStopped) {
      this.runtimeRollConnectStopped = false;
      void this.connectClient?.start();
    }
    this.processQueue();
  });
  private runtimeRollConnectStopped = false;
  private activeTurnIsHeartbeat = false;
  /** A queue-blind heartbeat gets at most two immediate, explicit observation
   * retries. This is runtime enforcement, not prompt-only guidance. */
  private heartbeatObservationRetryPending = false;
  private heartbeatObservationRetryCount = 0;
  private heartbeatPulseAlertsObserved = false;
  private heartbeatPulseQueueObserved = false;
  private heartbeatToolCalls: HeartbeatQueueDrainTurnToolCall[] = [];
  private heartbeatToolResults: HeartbeatQueueDrainTurnToolResult[] = [];

  // PLAT-297: a 529-retry inject that found the bridge busy and is being deferred
  // (re-armed on a short re-check timer) rather than dropped. Carries the retry
  // prompt + a bounded re-check counter so a permanently-busy bridge can't spin.
  private pendingRetryInject: { content: string; attempts: number } | null = null;
  // Timer handle for the re-check setTimeout in injectMessage's defer path.
  // Cleared before any inject so stale timers can't fire a double-inject.
  private retryInjectTimer: ReturnType<typeof setTimeout> | null = null;

  // Track pending tools that got tool_start but no tool_complete
  // (Claude Code's NDJSON doesn't emit tool_complete — we synthesize them)
  private pendingTools: Array<{
    tool: string;
    toolCallId: string;
    startedAt: number;
    heartbeatIndex?: number;
  }> = [];

  // SCLI-61: poisoned-session detection — consecutive failed turns (any
  // successful turn resets), plus cumulative counters surfaced on /health so
  // the agent-health exporter / fleet alerting can see a wedged bridge.
  private consecutiveErrorTurns = 0;
  private errorTurnsTotal = 0;
  private policyRefusalsTotal = 0;
  private contextCreditErrorsTotal = 0;
  private rotationAttemptedThisRun = false;

  /** Shared Connect client for unified messaging */
  private connectClient: import('../connect-client/index.js').ConnectClient | null = null;
  private activityLog?: import('../shared/bridge-activity-log.js').BridgeActivityLog;

  constructor(private opts: ClaudeBridgeOptions) {
    this.sessionId = `claude-bridge-${opts.agentId ?? 'default'}`;
    this.store = new StateStore(path.join(opts.cwd ?? '/workspace', '.claude-state.db'));
  }

  private heartbeatObservationMarkerPath(): string {
    return path.join(
      this.opts.cwd ?? process.cwd(),
      CLAUDE_HEARTBEAT_GATE_MARKER,
    );
  }

  private armHeartbeatObservationGate(): void {
    const markerPath = this.heartbeatObservationMarkerPath();
    try {
      fs.writeFileSync(markerPath, 'alerts', { mode: 0o600 });
      if (process.getuid?.() === 0) chownForContainerAgent(markerPath, false);
    } catch (err) {
      console.error(
        `[claude-bridge] Failed to arm mandatory heartbeat tool gate: ${(err as Error).message}`,
      );
    }
  }

  private clearHeartbeatObservationGate(): void {
    try { fs.unlinkSync(this.heartbeatObservationMarkerPath()); } catch { /* absent is normal */ }
  }

  async start(): Promise<void> {
    // Parse failover chain from env
    try {
      const chainJson = process.env['SHIZUHA_MODEL_FALLBACKS'];
      if (chainJson) {
        this.failoverChain = JSON.parse(chainJson);
        console.log(`[claude-bridge] Failover chain: ${this.failoverChain.map(s => `${s.method}/${s.model}`).join(' → ')}`);
      }
    } catch { /* ignore parse errors */ }

    // HIVE-195 Phase 3: a Hive config push persisted a model override here; apply it
    // on boot so a full container restart keeps the pushed config (env is the default).
    try {
      const home = process.env['HOME'] ?? (process.getuid?.() === 0 ? '/home/agent' : '/root');
      const ovRaw = fs.readFileSync(`${home}/.shizuha/config-override.json`, 'utf8');
      const ov = JSON.parse(ovRaw) as Record<string, unknown>;
      const m = (ov['model'] as string | undefined)
        || ((ov['model_overrides'] as Record<string, string> | undefined)?.['claude_code_server']);
      if (m && typeof m === 'string') {
        this.opts.model = m;
        console.log(`[claude-bridge] config-override.json applied on boot: model=${m}`);
      }
    } catch { /* no override — normal */ }

    // 0a. Start Connect client (unified messaging — agents as first-class participants)
    await this.startConnectClient();

    // 0b. Link bundled skills into Claude Code's native skill roots.
    this.setupSkills();

    // 0. Setup cron MCP server for Claude Code to use
    await this.setupCronMcp();
    // A prior process may have died mid-heartbeat. Do not carry its turn-scoped
    // gate into unrelated traffic after restart; the startup heartbeat re-arms
    // it immediately before its own first tool.
    this.clearHeartbeatObservationGate();

    // 1. Start HTTP/WS server before Claude token resolution/spawn.
    // PLAT-1350: when the required broker token path is in capacity backoff
    // (including coordinator HTTP 404 -> no token), spawnClaude() can wait
    // indefinitely by design. The process must still expose /health so k8s,
    // exporters, and operators see supervised capacity-unavailable instead of a
    // dead/crash-looping bridge.
    await this.startServer();

    // 2. Spawn claude -p
    await this.spawnClaude();

    // Proactive delivery: cron MCP server POSTs to /v1/proactive (no file watcher needed)

    console.log(`Claude Code bridge listening on ${this.opts.host}:${this.opts.port}`);
    console.log(JSON.stringify({
      level: 30,
      time: Date.now(),
      pid: process.pid,
      hostname: os.hostname(),
      model: this.opts.model,
      sessionId: this.sessionId,
      msg: 'Claude Code bridge initialized',
    }));

    // ── Persistent operating instructions (AGENTS.md + CLAUDE.md) ──
    // The heartbeat routine + other always-on rules live here (prompt-cached,
    // not compacted), so the hourly heartbeat is just a one-line trigger.
    writeBaseInstructions(this.opts.cwd ?? process.cwd());

    // ── Heartbeat — the agent's autonomous pulse ──
    // One-line trigger every hour; the routine itself is in CLAUDE.md.
    this.startHeartbeat();
    this.startTelemetry();

    // ── Agent availability — preserve the last proven provider state ──
    // A supervisor retry is process liveness, not evidence that Anthropic
    // recovered. Keep a serving-time quota outage unavailable until a real
    // model turn succeeds; otherwise every retry briefly lies active in Hive.
    const persistedProviderOutage = readClaudeProviderUnavailableMarker();
    void this.markAgentAvailability(
      !persistedProviderOutage,
      persistedProviderOutage ?? '',
    );

    // ── MCP token auto-refresh ──
    // shizuha-id JWTs expire. Once a day, ask AgentTokenManager for a fresh
    // token (it refreshes against shizuha-id automatically) and rewrite
    // .mcp.json. Claude Code re-reads .mcp.json on each MCP reconnect, so
    // the new token takes effect without restarting the bridge.
    this.startTokenRefresh();
  }

  /**
   * Resolve the base URL for shizuha-id auth calls (login / refresh / api-token
   * / admin set-password). MUST be the real platform (SHIZUHA_PLATFORM_URL,
   * e.g. http://shizuha.com), NOT the daemon's BACKEND_URL (:8016) —
   * the daemon shadows /id/api/auth/login/ with its own handler that 401s on
   * agent credentials. Falls back to daemon-host resolution only when
   * SHIZUHA_PLATFORM_URL is missing/loopback (broken inside containers).
   */
  private resolvePlatformBase(): string {
    let platformBase = process.env['SHIZUHA_PLATFORM_URL'] || '';
    if (platformBase.includes('127.0.0.1') || platformBase === 'http://localhost' || !platformBase) {
      const daemonHost = process.env['DAEMON_HOST'] || 'host.docker.internal';
      try {
        const resp = execSync(
          `curl -sf http://${daemonHost}:${process.env['DAEMON_PORT'] || '8016'}/v1/config --max-time 3 2>/dev/null`,
          { timeout: 5000, encoding: 'utf-8' },
        );
        const resolvedUrl = JSON.parse(resp).platformUrl;
        if (resolvedUrl && !resolvedUrl.includes('127.0.0.1') && !resolvedUrl.includes('localhost')) {
          platformBase = resolvedUrl;
        }
      } catch { /* ignore */ }
      if (!platformBase || platformBase.includes('127.0.0.1')) {
        try {
          const hostname = execSync('hostname -f 2>/dev/null || hostname', { timeout: 2000, encoding: 'utf-8' }).trim();
          platformBase = `http://${hostname}`;
        } catch {
          platformBase = `http://${daemonHost}`;
        }
      }
    }
    return platformBase.replace(/\/+$/, '');
  }

  /** SCLI-92: PATCH /pulse/api/agent-availability/self/ with the caller's JWT.
   * Fire-and-forget — errors are logged but never throw so the caller is unaffected.
   */
  private readMcpConfiguredBearer(workDir?: string): string | undefined {
    const dir = workDir ?? this.opts.cwd ?? process.cwd();
    const tokenFile = this.mcpUpstreamTokenFile(dir);
    try {
      const tok = fs.readFileSync(tokenFile, 'utf-8').trim();
      if (tok) return tok;
    } catch { /* best-effort */ }
    try {
      const mcpJsonPath = path.join(dir, '.mcp.json');
      if (!fs.existsSync(mcpJsonPath)) return undefined;
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      const servers = mcpJson.mcpServers ?? {};
      const readTok = (s: any): string | undefined => {
        const env = s?.env?.MCP_UPSTREAM_BEARER;
        if (typeof env === 'string' && env) return env;
        const hdr = s?.headers?.Authorization;
        if (typeof hdr === 'string' && hdr.startsWith('Bearer ')) return hdr.slice(7);
        return undefined;
      };
      return Object.values(servers).map(readTok).find(Boolean) as string | undefined;
    } catch {
      return undefined;
    }
  }

  private async resolveAvailabilityToken(platformBase: string): Promise<string> {
    const workDir = this.opts.cwd ?? process.cwd();
    let token = this.readMcpConfiguredBearer(workDir);
    if (token && !isJwtStale(token)) return token;

    if (token) {
      await this.refreshMcpTokenOnce(platformBase, true);
      token = this.readMcpConfiguredBearer(workDir);
      if (token && !isJwtStale(token)) return token;
    }

    token = process.env['AGENT_ACCESS_TOKEN'] || '';
    if (token && !isJwtStale(token)) return token;

    try {
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const tm = new AgentTokenManager({
        agentUsername: this.opts.agentUsername ?? 'agent',
        agentEmail: process.env['AGENT_EMAIL'] || undefined,
        platformUrl: platformBase,
      });
      const freshToken = await tm.getToken();
      if (freshToken) {
        try { fs.writeFileSync(this.mcpUpstreamTokenFile(workDir), freshToken, { mode: 0o600 }); } catch { /* best-effort */ }
        return freshToken;
      }
    } catch (err) {
      console.warn(`[claude-bridge] AgentAvailability token refresh failed: ${(err as Error).message}`);
    }
    return '';
  }

  private async markAgentAvailability(active: boolean, reason: string): Promise<void> {
    const platformBase = this.resolvePlatformBase();
    if (!platformBase) return;
    let token = await this.resolveAvailabilityJwt(platformBase);
    if (!token) return;
    const url = `${platformBase}/pulse/api/agent-availability/self/`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${token}`,
            'X-Shizuha-Execution-Method': 'claude_code_server',
          },
          body: JSON.stringify({
            active,
            reason,
            execution_method: 'claude_code_server',
          }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          console.log(`[claude-bridge] AgentAvailability set active=${active} (SCLI-92)`);
          return;
        }
        if ((res.status === 401 || res.status === 403) && attempt === 0) {
          const fresh = await this.resolveAvailabilityJwt(platformBase, true);
          if (fresh && fresh !== token) {
            token = fresh;
            console.warn(`[claude-bridge] AgentAvailability PATCH returned ${res.status}; refreshed JWT and retrying`);
            continue;
          }
        }
        console.warn(`[claude-bridge] AgentAvailability PATCH returned ${res.status} (attempt ${attempt + 1}/3)`);
      } catch (err) {
        console.warn(`[claude-bridge] AgentAvailability PATCH failed (attempt ${attempt + 1}/3): ${(err as Error).message}`);
      }
    }
  }

  private async resolveAvailabilityJwt(platformBase: string, force = false): Promise<string> {
    let token = process.env['AGENT_ACCESS_TOKEN'] || '';
    if (token && (force || isJwtStale(token))) token = '';
    if (token) return token;
    try {
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const tm = new AgentTokenManager({
        agentUsername: this.opts.agentUsername ?? 'agent',
        agentEmail: process.env['AGENT_EMAIL'] || undefined,
        platformUrl: platformBase,
        ignoreEnvToken: force,
      });
      const fresh = await tm.getToken();
      return fresh || '';
    } catch (err) {
      console.warn(`[claude-bridge] AgentAvailability token refresh failed: ${(err as Error).message}`);
      return '';
    }
  }

  private startTokenRefresh(): void {
    const platformBase = this.resolvePlatformBase();
    if (!platformBase) return;
    // Run once shortly after start (covers a container that booted with a stale
    // .mcp.json token), then every 30min. The actual shizuha-id call is gated by
    // isJwtStale (within 6h of expiry), so most ticks are a cheap no-op; the
    // tight cadence guarantees the bearer FILE is rewritten well before expiry so
    // the long-lived proxy never serves an expired token. (24h-token-cliff fix.)
    setTimeout(() => { void this.refreshMcpTokenOnce(platformBase); }, 60_000);
    setInterval(() => { void this.refreshMcpTokenOnce(platformBase); }, 30 * 60 * 1000);
    // SCLI-70 follow-up: force-refresh on a 401 that ISN'T expiry-driven. The proxy's
    // auth-retry only re-reads the bearer FILE — which heals an EXPIRED token (the 30min
    // tick rewrote it), but NOT a token the server invalidated while still time-valid
    // (e.g. after a shizuha-id/broker restart or key rotation): isJwtStale is false, so
    // the tick is a no-op and the file keeps the same rejected token → the 401 flap that
    // hand-stopgapping chased all session. On a 401 the proxy drops a sentinel; this fast
    // tick force-mints a genuinely-fresh token (bypassing the stale gate) so the proxy's
    // next re-read self-heals within ~30s instead of erroring until restart.
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

  /** Absolute path to the fresh-bearer file the stdio mcp-proxy reads on each
   *  (re)connect. Single file per agent — all platform services share the JWT. */
  private mcpUpstreamTokenFile(workDir?: string): string {
    return path.join(workDir ?? this.opts.cwd ?? process.cwd(), '.mcp-upstream-token');
  }

  private async refreshMcpTokenOnce(platformBase: string, force = false): Promise<void> {
    const workDir = this.opts.cwd ?? process.cwd();
    const mcpJsonPath = path.join(workDir, '.mcp.json');
    try {
      if (!fs.existsSync(mcpJsonPath)) return;
      const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
      const servers = mcpJson.mcpServers ?? {};
      // The live token lives in EITHER the stdio-proxy env (current format:
      // env.MCP_UPSTREAM_BEARER) OR a static http header (legacy format:
      // headers.Authorization). The old code only checked the header form, so
      // for the now-default proxy format it found nothing and silently
      // early-returned — the refresh was DEAD and tokens aged out to the 24h
      // cliff. Read the current token from whichever form is present.
      const readTok = (s: any): string | undefined => {
        const env = s?.env?.MCP_UPSTREAM_BEARER;
        if (typeof env === 'string' && env) return env;
        const hdr = s?.headers?.Authorization;
        if (typeof hdr === 'string' && hdr.startsWith('Bearer ')) return hdr.slice(7);
        return undefined;
      };
      const configToken = Object.values(servers).map(readTok).find(Boolean) as string | undefined;
      const tokenFile = this.mcpUpstreamTokenFile(workDir);
      let fileToken: string | undefined;
      try { fileToken = fs.readFileSync(tokenFile, 'utf-8').trim() || undefined; } catch { /* missing/unreadable -> config seed */ }
      // The running stdio mcp-proxy prefers .mcp-upstream-token over its spawn-time
      // env seed. Therefore freshness MUST be judged from the file first: if the
      // file is stale but .mcp.json/env is fresh, the proxy still sends the stale
      // bearer and every Pulse call fails until restart. (PLAT-882)
      const currentToken = fileToken ?? configToken;
      if (!currentToken) return;
      // Only refresh when the live token is expired or within 6h of expiry —
      // UNLESS force=true (a proxy 401 on a not-yet-stale token: the server
      // rejected it, so mint a fresh one regardless of the expiry window).
      if (!force && !isJwtStale(currentToken)) return;

      console.log(`[claude-bridge] MCP token ${force ? 'force-refresh (proxy 401)' : (fileToken ? 'file-expired/near-expiry' : 'expired/near-expiry')} — refreshing via shizuha-id`);
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const { PLATFORM_MCP_SERVICES } = await import('../platform/mcp-services.js');
      const tm = new AgentTokenManager({
        agentUsername: this.opts.agentUsername ?? 'agent',
        agentEmail: process.env['AGENT_EMAIL'] || undefined,
        platformUrl: platformBase,
        ignoreEnvToken: force,
      });
      const freshToken = await tm.getToken();
      if (!freshToken) {
        console.warn(`[claude-bridge] Token refresh: shizuha-id login failed — keeping old token`);
        return;
      }
      // 1) Rewrite the bearer FILE FIRST — this is what the RUNNING proxy reads
      //    fresh on its next (re)connect, so MCP self-heals in-process without an
      //    agent restart. Then update .mcp.json so a future spawn also seeds fresh.
      try { fs.writeFileSync(this.mcpUpstreamTokenFile(workDir), freshToken, { mode: 0o600 }); } catch { /* env seed remains */ }
      for (const svc of PLATFORM_MCP_SERVICES) {
        const key = `shizuha-${svc.name}`;
        const entry = mcpJson.mcpServers[key];
        if (!entry) continue;
        // Stdio-proxy form: refresh the env seed (proxy reads the FILE anyway).
        if (entry.env?.MCP_UPSTREAM_BEARER) {
          entry.env.MCP_UPSTREAM_BEARER = freshToken;
        }
        // Legacy static-header form: refresh the header. OAuth-migrated services
        // have headers:{} and let Claude Code's native OAuth provider own the
        // token — don't re-add a header there (it would defeat that path).
        if (entry.headers?.Authorization?.startsWith('Bearer ')) {
          entry.headers = { ...entry.headers, Authorization: `Bearer ${freshToken}` };
        }
      }
      fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));
      console.log(`[claude-bridge] MCP tokens refreshed via shizuha-id (file + .mcp.json)`);
    } catch (err) {
      console.error(`[claude-bridge] Token refresh error: ${(err as Error).message}`);
    }
  }

  /** Approximate model context-window size (tokens) for the context% gauge. */
  private modelMaxTokens(): number {
    const m = (this.opts.model || '').toLowerCase();
    if (m.includes('1m') || m.includes('-1m')) return 1_000_000;
    // Opus 4.6+/5, Sonnet 4.x/5 unlock 1M context (long-context beta / Claude Code
    // 1M variant). Matches the anthropic provider's beta gate + model-profile.ts.
    if (/claude-opus-4-[6-9]/.test(m) || /claude-opus-[5-9]/.test(m)
      || /claude-sonnet-[45]/.test(m)) return 1_000_000;
    if (m.startsWith('claude')) return 200_000; // haiku / older claude
    if (m.startsWith('gpt-5') || m.startsWith('o3') || m.startsWith('o4')) return 272_000;
    if (m.startsWith('gemini')) return 1_000_000;
    return 200_000;
  }

  /** Assemble the full telemetry snapshot reported to the platform via Connect.
   * Open-ended on purpose — surface as much useful runtime state as we have. */
  private buildTelemetry(): Record<string, unknown> {
    const maxTok = this.modelMaxTokens();
    const ctxUsed = this.lastTurnInputTokens;
    const tps = this.lastTurnDurationMs > 0
      ? Number((this.lastTurnOutputTokens / (this.lastTurnDurationMs / 1000)).toFixed(1))
      : 0;
    return {
      v: 1,
      ts: Date.now(),
      agent_username: this.opts.agentUsername ?? null,
      agent_id: this.opts.agentId ?? null,
      runtime: {
        harness: 'claude-bridge',
        model: this.opts.model,
        provider: 'anthropic',
        version: process.env['SHIZUHA_RUNTIME_VERSION'] ?? null,
        host: os.hostname(),
        pid: process.pid,
        uptime_ms: Date.now() - this.startTime,
      },
      context: {
        used_tokens: ctxUsed,
        max_tokens: maxTok,
        pct: maxTok ? Number(((ctxUsed / maxTok) * 100).toFixed(1)) : null,
      },
      usage: {
        total_input_tokens: this.totalInputTokens,
        total_output_tokens: this.totalOutputTokens,
        total_output_chars: this.totalOutputChars,
        turns: this.turnCount,
        tokens_per_sec: tps,
        retries_529: this.retryCount529,
        active_token_label: this.currentTokenLabel,
      },
      activity: buildActivityTelemetry(this.activityPhase, {
        busy: this.activeThreadId !== null,
        queueDepth: this.messageQueue.length,
        lastActivityAt: this.lastActivityAt,
      }),
      health: {
        ok: this.consecutiveErrorTurns === 0 && !this.tokenPoolUnavailable,
        error_turns_total: this.errorTurnsTotal,
        consecutive_error_turns: this.consecutiveErrorTurns,
        policy_refusals_total: this.policyRefusalsTotal,
        context_credit_errors_total: this.contextCreditErrorsTotal,
        recent_errors: this.recentErrors.slice(-10),
        // PLAT-879: distinguishes a supervised-but-idle empty-token-pool wait from
        // a crashed process. process_up stays 1; this reason explains the idleness.
        token_pool_unavailable: this.tokenPoolUnavailable,
        token_pool_unavailable_since: this.tokenPoolUnavailable ? this.tokenPoolUnavailableSince : null,
        // Keep recent_errors as a diagnostic ring, but do not let an old auth or
        // quota failure latch the operator-facing provider state forever. A
        // successful Claude turn is authoritative proof that the provider has
        // recovered; only 401/429 errors after that turn may mark it unavailable.
        provider_unavailable: providerUnavailableFromRecentErrors(
          this.tokenPoolUnavailable,
          this.recentErrors,
          this.lastCompleteAt,
        ),
      },
      heartbeat: heartbeatQueueDrainTelemetry(
        this.opts.agentId ?? this.opts.agentUsername ?? 'unknown-claude-agent',
      ),
    };
  }

  /** Health payload consumed by k8s/exporters. Keep process-up even while
   * Anthropic capacity is unavailable; expose the degraded reason explicitly. */
  private buildHealthResponse(): Record<string, unknown> {
    const capacityUnavailable = this.tokenPoolUnavailable;
    const providerHealthy = !capacityUnavailable && this.consecutiveErrorTurns === 0;
    const lastProviderIssue = capacityUnavailable
      ? 'capacity_unavailable'
      : (this.recentErrors.length > 0 ? this.recentErrors[this.recentErrors.length - 1]?.msg ?? null : null);

    return {
      status: providerHealthy ? 'ok' : 'degraded',
      healthStatus: providerHealthy ? 'ok' : 'degraded',
      bridge: 'claude-code',
      model: this.opts.model,
      initialized: this.initialized,
      authenticated: this.initialized && !/\b401\b|\b403\b|auth|token/i.test(String(lastProviderIssue ?? '')),
      busy: this.activeThreadId !== null,
      queueDepth: this.messageQueue.length,
      uptime: Date.now() - this.startTime,
      providerHealthy,
      provider_available: providerHealthy,
      quota_ok: !capacityUnavailable,
      in_backoff: capacityUnavailable,
      capacityUnavailable,
      tokenPoolUnavailable: capacityUnavailable,
      token_pool_unavailable: capacityUnavailable,
      tokenPoolUnavailableSince: capacityUnavailable ? this.tokenPoolUnavailableSince : null,
      token_pool_unavailable_since: capacityUnavailable ? this.tokenPoolUnavailableSince : null,
      lastProviderIssue,
      // Cumulative token/char/turn counters — same field names as codex-bridge so
      // the agent-health exporter's /health scrape works uniformly across backends
      // (Grafana rate()s them into tok/min, tok/hour, chars/min per agent).
      turns: this.turnCount,
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      outputChars: this.totalOutputChars,
      // SCLI-61 wedge telemetry: sustained errorTurns/policyRefusals growth
      // with no turns growth = wedged bridge (feeds exporter/fleet alerting).
      errorTurns: this.errorTurnsTotal,
      consecutiveErrorTurns: this.consecutiveErrorTurns,
      policyRefusals: this.policyRefusalsTotal,
      contextCreditErrors: this.contextCreditErrorsTotal,
    };
  }

  /** Fire-and-forget a telemetry snapshot over Connect (no-op if socket down). */
  private emitTelemetry(): void {
    try { this.connectClient?.sendTelemetry(this.buildTelemetry()); } catch { /* ignore */ }
  }

  /** Periodic telemetry pulse (in addition to on-turn-end + on-error sends). */
  private startTelemetry(): void {
    const ms = Number(process.env['SHIZUHA_TELEMETRY_INTERVAL_MS'] ?? 30_000);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = setInterval(() => this.emitTelemetry(), ms);
    if (this.telemetryTimer.unref) this.telemetryTimer.unref();
    this.emitTelemetry();
    console.log(`[claude-bridge] Telemetry enabled (every ${Math.round(ms / 1000)}s -> Connect)`);
  }

  // PLAT-879: true while the bridge is supervised-but-idle waiting on an empty/
  // cooling Anthropic token pool (instead of crash-looping). Surfaced in telemetry
  // so the exporter shows process_up=1 + a clear reason, not enabled=1/process_up=0.
  private tokenPoolUnavailable = false;
  private tokenPoolUnavailableSince = 0;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // PLAT-4179: dedicated stuck-latch watchdog, run frequently and decoupled from the
  // heartbeat cadence so a wedged turn's leaked latch is force-cleared within one tick.
  private stuckLatchTimer: ReturnType<typeof setInterval> | null = null;
  private stuckLatchCheckMs = 60 * 1000;
  private stuckLatchRecoveryPromise: Promise<boolean> | null = null;

  /** Fence and replace Claude before releasing an over-age busy latch. A leaked
   *  latch would park the agent forever, while clear-only recovery lets late output
   *  corrupt the next turn. Returns true iff it recovered a stuck turn. Called by the
   *  heartbeat tick AND a dedicated ~60s watchdog timer so the bound is enforced
   *  within one watchdog tick, not up to ~2× the heartbeat interval. */
  private recoverStuckLatchIfDead(): Promise<boolean> {
    if (this.stuckLatchRecoveryPromise) return this.stuckLatchRecoveryPromise;
    const stuckThreadId = this.activeThreadId;
    const stuckStartedAt = this.activeThreadStartedAt;
    if (!isLatchStuck(
      stuckThreadId,
      stuckStartedAt,
      this.heartbeatStuckMs,
      Date.now(),
      this.activeTurnLastProgressAt,
    )) {
      return Promise.resolve(false);
    }
    const busyMs = Date.now() - stuckStartedAt!;
    console.warn(
      `[claude-bridge] Stuck-latch watchdog: fencing STUCK execution ` +
      `(busy ${Math.round(busyMs / 60000)}m > ${Math.round(this.heartbeatStuckMs / 60000)}m) before queue release`,
    );
    const recovery = runSerializedStuckRecovery({
      isStuck: () => this.activeThreadId === stuckThreadId &&
        isLatchStuck(
          this.activeThreadId,
          this.activeThreadStartedAt,
          this.heartbeatStuckMs,
          Date.now(),
          this.activeTurnLastProgressAt,
        ),
      fenceAndRestart: async () => {
        const oldProc = this.claudeProcess;
        this.initialized = false;
        if (oldProc && oldProc.exitCode === null) this.suppressedClaudeExitProc = oldProc;
        // Fence old stdout before signalling the tree. Late completion from this
        // child cannot be parsed against a replacement turn.
        this.claudeProcess = null;
        if (oldProc && oldProc.exitCode === null) {
          this.killClaudeTree(oldProc, 'SIGTERM');
          await Promise.race([
            new Promise<void>((resolve) => oldProc.once('exit', () => resolve())),
            sleep(5000),
          ]);
          if (oldProc.exitCode === null && oldProc.pid != null) {
            try { process.kill(-oldProc.pid, 'SIGKILL'); } catch { /* already gone */ }
            await Promise.race([
              new Promise<void>((resolve) => oldProc.once('exit', () => resolve())),
              sleep(1000),
            ]);
          }
        }
        this.lineBuffer = '';
        this.accumulatedContent = '';
        this.pendingTools = [];
        this.isReplaying = true;
        await this.spawnClaude();
      },
      releaseLatch: () => {
        this.activeThreadId = null;
        this.activeThreadStartedAt = null;
        this.activeTurnLastProgressAt = null;
        this.activeMessageId = null;
        this.activeTurnContent = null;
        this.activeTurnRateLimitedTokens.clear();
        for (const [, client] of this.clients) client.activeThreadId = null;
      },
      drainQueue: () => this.processQueue(),
    });
    this.stuckLatchRecoveryPromise = recovery.finally(() => {
      this.stuckLatchRecoveryPromise = null;
    });
    return this.stuckLatchRecoveryPromise;
  }

  private startHeartbeat(): void {
    // 10 min (was 1h): the hourly cadence left Claude agents idle on assigned
    // work for up to an hour between queue checks, forcing manual coordinator
    // nudges. The trigger is a one-line hint and the routine ends with zero
    // output when the queue is empty, so a tight cadence is cheap. Override
    // via SHIZUHA_CLAUDE_HEARTBEAT_MS.
    const intervalMs = Number(process.env['SHIZUHA_CLAUDE_HEARTBEAT_MS'] ?? 10 * 60 * 1000);
    // Watchdog threshold: if the "busy" latch stays set longer than this, the turn
    // is presumed dead and fireHeartbeat force-clears it so heartbeats resume.
    // Must exceed the longest legitimate turn (tool-heavy turns run several
    // minutes); default 20m (≥2 heartbeat cycles). Env-overridable.
    this.heartbeatStuckMs = Number(process.env['SHIZUHA_HEARTBEAT_STUCK_MS'] ?? Math.max(intervalMs * 2, 20 * 60 * 1000));
    const initialDelayMs = Number(process.env['SHIZUHA_HEARTBEAT_INITIAL_DELAY_MS'] ?? 15_000);
    console.log(`[claude-bridge] Heartbeat enabled (initial ${Math.round(initialDelayMs / 1000)}s, then every ${Math.round(intervalMs / 60000)}m, one-line trigger; stuck-latch watchdog ${Math.round(this.heartbeatStuckMs / 60000)}m)`);

    // First catch-up heartbeat shortly after startup/restart, then on cadence.
    setTimeout(() => {
      this.fireHeartbeat();
      this.heartbeatTimer = setInterval(() => this.fireHeartbeat(), intervalMs);
    }, initialDelayMs);
    // PLAT-4179: run the stuck-latch force-clear on a dedicated frequent timer,
    // decoupled from the heartbeat cadence, so a wedged turn's leaked latch clears
    // within ~stuckLatchCheckMs and queued work resumes — not up to ~2× the heartbeat
    // interval (codex-bridge's 60m interval vs 45m threshold left agents dark ~82m).
    // Validate the interval (rei P2): reject 0/negative/NaN/tiny values that Node
    // collapses to a ~1ms hot loop; fall back loudly to 60s.
    const _rawCheckMs = process.env['SHIZUHA_STUCK_LATCH_CHECK_MS'];
    const _parsedCheckMs = Number(_rawCheckMs);
    this.stuckLatchCheckMs = (Number.isFinite(_parsedCheckMs) && _parsedCheckMs >= 5_000) ? _parsedCheckMs : 60_000;
    if (_rawCheckMs !== undefined && _parsedCheckMs !== this.stuckLatchCheckMs) {
      console.warn(`[claude-bridge] Ignoring invalid SHIZUHA_STUCK_LATCH_CHECK_MS="${_rawCheckMs}" — using ${this.stuckLatchCheckMs}ms`);
    }
    console.log(`[claude-bridge] Stuck-latch watchdog timer every ${Math.round(this.stuckLatchCheckMs / 1000)}s`);
    this.stuckLatchTimer = setInterval(() => {
      try {
        void this.recoverStuckLatchIfDead().catch((e) => {
          console.error(`[claude-bridge] stuck-latch watchdog error: ${(e as Error).message}`);
        });
      } catch (e) {
        console.error(`[claude-bridge] stuck-latch watchdog error: ${(e as Error).message}`);
      }
    }, this.stuckLatchCheckMs);
    if (this.stuckLatchTimer.unref) this.stuckLatchTimer.unref();
  }

  private async fireHeartbeat(): Promise<void> {
    try {
      // Busy cadence ticks become scheduler state rather than disappearing.
      // A tick during the heartbeat itself is already satisfied; otherwise the
      // turn-boundary arbiter will run it before routine task-notification DMs.
      if (this.activeThreadId) {
        if (!isLatchStuck(
          this.activeThreadId,
          this.activeThreadStartedAt,
          this.heartbeatStuckMs,
          Date.now(),
          this.activeTurnLastProgressAt,
        )) {
          if (this.activeTurnIsHeartbeat) {
            console.log('[claude-bridge] Heartbeat coalesced — an autonomous checkpoint is already active');
            return;
          }
          this.heartbeatPending = true;
          console.log(`[claude-bridge] Heartbeat checkpoint pending — agent is busy (queue depth ${this.messageQueue.length})`);
          return;
        }
        await this.recoverStuckLatchIfDead();
        if (this.activeThreadId) {
          this.heartbeatPending = true;
          return;
        }
      }
      this.heartbeatPending = true;
      this.processQueue();
    } catch (err) {
      console.error(`[claude-bridge] Heartbeat error: ${(err as Error).message}`);
    }
  }

  /** Whether we already retried without --resume after a session failure */
  private resumeRetried = false;

  private async spawnClaude(): Promise<void> {
    const claudePath = await this.findClaudeCli();

    // Auto-restore .claude.json from backup if missing
    const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(
      (process.getuid?.() === 0 ? '/home/agent' : (process.env['HOME'] ?? '/root')), '.claude'
    );
    const claudeJsonPath = path.join(claudeDir, '.claude.json');
    if (!fs.existsSync(claudeJsonPath)) {
      const backupDir = path.join(claudeDir, 'backups');
      try {
        const backups = fs.readdirSync(backupDir)
          .filter((f: string) => f.startsWith('.claude.json.backup.'))
          .sort()
          .reverse();
        if (backups.length > 0) {
          fs.copyFileSync(path.join(backupDir, backups[0]!), claudeJsonPath);
          console.log(`[claude-bridge] Restored .claude.json from backup: ${backups[0]}`);
        }
      } catch { /* no backups available */ }
    }

    // Check if a previous session exists for this agent's working directory
    const sessionIdFile = this.getSessionIdFile();
    if (!this.storedSessionId) {
      this.storedSessionId = this.loadStoredSessionId(sessionIdFile);
    }
    // Guard against a degenerate session: resuming a session whose transcript has
    // grown to tens of MB is slow (an 83MB resume hung >110s in testing) and the
    // first replayed turn can blow the account's remaining rate-limit budget.
    // Above a hard cap, start fresh rather than resume. Normal sessions are far
    // smaller; this only trips on pathological bloat. Fail-safe: if we can't stat
    // the transcript, resume as before.
    if (this.storedSessionId) {
      const MAX_RESUME_BYTES = 64 * 1024 * 1024; // 64MB
      try {
        const wd = this.opts.cwd ?? process.cwd();
        const proj = wd.replace(/\//g, '-');
        const candidates = [
          path.join('/home/agent/.claude/projects', proj, `${this.storedSessionId}.jsonl`),
          path.join(process.env['HOME'] ?? '/root', '.claude', 'projects', proj, `${this.storedSessionId}.jsonl`),
        ];
        for (const f of candidates) {
          if (fs.existsSync(f)) {
            const sz = fs.statSync(f).size;
            if (sz > MAX_RESUME_BYTES) {
              console.warn(
                `[claude-bridge] Stored session ${this.storedSessionId} is ` +
                `${(sz / 1048576).toFixed(0)}MB (> ${MAX_RESUME_BYTES / 1048576}MB cap) — ` +
                `starting FRESH to avoid a degenerate resume`,
              );
              this.storedSessionId = '';
            }
            break;
          }
        }
      } catch { /* can't stat — fall through and resume as before */ }
    }
    const storedSessionId = this.storedSessionId;

    // Resume previous session if one exists — unless MCP was newly configured
    // (Claude Code discovers MCP servers at session init, not on resume).
    // If no stored session ID exists, start a fresh session. This makes
    // `.claude-session-id` the explicit source of truth for continuation and
    // allows operators to reset a bridge session by clearing that file.
    if (storedSessionId && !this.mcpNewlyConfigured) {
      console.log(`[claude-bridge] Resuming session: ${storedSessionId}`);
    } else if (!this.mcpNewlyConfigured) {
      console.log('[claude-bridge] No stored session ID — starting fresh session');
    } else {
      console.log('[claude-bridge] Starting fresh session (MCP tools newly added)');
    }
    // Determine if we need to drop privileges (running as root inside Docker)
    const isRoot = process.getuid?.() === 0;
    const targetUid = containerAgentUid();
    const targetGid = containerAgentGid();
    const homeDir = isRoot ? `/home/agent` : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? process.cwd();

    // Write the (possibly >128KB) system-prompt appendix to a file at every
    // spawn — this.opts.contextPrompt may have grown since startup (cred
    // section) and a fresh write keeps the file authoritative. Passing it as
    // an argv string dies with E2BIG past MAX_ARG_STRLEN (~128KB).
    let contextPromptFile: string | undefined;
    if (this.opts.contextPrompt) {
      try {
        const promptPath = path.join(workDir, '.claude-append-system-prompt');
        fs.writeFileSync(promptPath, this.opts.contextPrompt, { mode: 0o600 });
        if (isRoot) {
          try { fs.chownSync(promptPath, targetUid, targetGid); } catch { /* chown best-effort; claude may still read as root-dropped uid via mode */ }
        }
        contextPromptFile = promptPath;
      } catch (err) {
        console.warn(`[claude-bridge] context-prompt file write failed, falling back to argv (E2BIG risk >128KB): ${(err as Error).message}`);
      }
    }

    const args = buildClaudeSpawnArgs({
      model: this.opts.model,
      storedSessionId,
      mcpNewlyConfigured: this.mcpNewlyConfigured,
      contextPrompt: this.opts.contextPrompt,
      contextPromptFile,
    });

    console.log(`[claude-bridge] Spawning: ${claudePath} ${args.join(' ')}`);

    // Ensure agent user home and workspace exist with correct permissions
    if (isRoot) {
      try {
        // Create agent user home directory
        fs.mkdirSync(homeDir, { recursive: true });
        fs.chownSync(homeDir, targetUid, targetGid);
        // Ensure workspace is writable
        fs.mkdirSync(workDir, { recursive: true });
        fs.chownSync(workDir, targetUid, targetGid);
        // Copy .claude credentials if they exist in /root
        const rootClaudeDir = '/root/.claude';
        const agentClaudeDir = path.join(homeDir, '.claude');
        if (fs.existsSync(rootClaudeDir) && !fs.existsSync(agentClaudeDir)) {
          fs.cpSync(rootClaudeDir, agentClaudeDir, { recursive: true });
          chownForContainerAgent(agentClaudeDir);
        }
      } catch (e) {
        console.error(`[claude-bridge] Warning: failed to set up agent home: ${(e as Error).message}`);
      }
    }

    // When running as root, drop to the 'agent' user.
    // Use runuser with --preserve-environment (-p) to forward env vars like
    // CLAUDE_CODE_OAUTH_TOKEN. Without -p, runuser resets the environment and
    // Claude Code can't find its auth tokens.
    const spawnCmd = isRoot ? 'runuser' : claudePath;
    const spawnArgs = isRoot ? ['-p', '-u', 'agent', '--', claudePath, ...args] : args;

    // HIVE-125: source the Claude model token from the broker UDS at runtime instead
    // of the baked CLAUDE_CODE_OAUTH_TOKEN env. Token bytes are never logged. Because
    // spawnClaude() runs on every (re)spawn — including the 401/rate-limit rotation
    // path — the broker token is re-fetched fresh per spawn = "re-fetch on 401 WITHOUT
    // pod recreate" (restart the process with a new token, never the container).
    //
    // Token-source policy (ren security review):
    //   - No broker configured (brokerExpected()=false) -> headless dev: env token.
    //   - Broker configured + serves a token -> use it.
    //   - Broker configured but no token (503/404/malformed/timeout): if
    //     CLAUDE_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN=1 (set once the broker actually
    //     SERVES /model-token) -> retry the boot-race window, then FAIL CLOSED rather
    //     than spawn Claude with a stale/baked token. Until that flag is enabled (the
    //     broker /model-token server is not deployed yet) the env token stays the
    //     fallback so agents keep running — flipping it on is the cutover with the
    //     broker-side (see the linked follow-up). The env token is therefore used as a
    //     fallback ONLY when no broker is configured OR the broker-token requirement
    //     is not yet enforced.
    const requireBrokerToken = process.env['CLAUDE_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN'] === '1';
    let modelToken = '';
    let brokerToken = '';
    let brokerLabel = '';
    let brokerLease: { entryId: string; leaseId: string } | null = null;
    let brokerConfigured = false;
    try {
      const { brokerExpected, fetchBrokerModelToken } = require('../auth/broker-token.js');
      brokerConfigured = brokerExpected();
      if (brokerConfigured) {
        let bt = await fetchBrokerModelToken('anthropic');
        // Retry the broker boot-race window before deciding it has no token (only
        // worth waiting when the broker token is required — else fall back fast).
        for (let attempt = 0; attempt < 4 && !bt?.token && requireBrokerToken; attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
          bt = await fetchBrokerModelToken('anthropic');
        }
        if (bt?.token) {
          brokerToken = bt.token;
          brokerLabel = bt.label || 'broker';
          brokerLease = { entryId: bt.entryId, leaseId: bt.leaseId };
        }
      }
    } catch { /* handled by the fail-closed / fallback policy below */ }

    // PLAT-879: an empty/cooling Anthropic token pool must NOT crash-loop the
    // bridge. When the broker is required but served no token, the old path let
    // resolveModelTokenPolicy throw → caller process.exit(1) → the container
    // crash-looped (the PLAT-836/866 fleet-wide event: many Claude agents at
    // enabled=1/process_up=0). Instead, stay SUPERVISED and retry with bounded
    // exponential backoff + jitter until the pool recovers. We still NEVER fall
    // back to a baked env token in the required case (HIVE-125 fail-closed) — this
    // only changes the empty-pool *process* behaviour from crash to backoff. The
    // token_pool_unavailable telemetry flag lets the exporter show process_up=1
    // with a clear reason. Restart-safe: a fresh spawn re-enters the same loop.
    if (shouldCrossMethodFailoverOnRequiredBrokerMiss({
      brokerConfigured,
      requireBrokerToken,
      brokerToken: brokerToken || null,
      failoverChain: this.failoverChain,
      currentModel: this.opts.model,
    })) {
      const nextStep = nextNonClaudeFallbackStep(this.failoverChain, this.opts.model);
      this.tokenPoolUnavailable = true;
      this.tokenPoolUnavailableSince = Date.now();
      void this.markAgentAvailability(false, CLAUDE_TOKEN_POOL_UNAVAILABLE_REASON);
      this.emitTelemetry();
      console.error(
        `[claude-bridge] Broker required but Anthropic token pool unavailable for ${this.opts.model}; ` +
        `explicit non-Claude fallback ${nextStep?.method}/${nextStep?.model} exists — requesting cross-method failover (exit 42)`,
      );
      setTimeout(() => process.exit(42), 1000);
      await new Promise<never>(() => { /* wait for exit so spawnClaude never falls through to env-token policy */ });
    }

    if (shouldEnterTokenPoolBackoff({ brokerConfigured, requireBrokerToken, brokerToken: brokerToken || null })) {
      let waitMs = nextTokenPoolBackoffMs(0);
      while (!brokerToken) {
        if (!this.tokenPoolUnavailable) {
          this.tokenPoolUnavailable = true;
          this.tokenPoolUnavailableSince = Date.now();
          // PLAT-1150: stay supervised, but do not advertise this agent as
          // routable while Claude capacity is exhausted. Startup marks active
          // before model-token resolution (SCLI-92); the empty/cooling-pool
          // wait must explicitly flip Pulse availability to capacity-limited.
          void this.markAgentAvailability(false, CLAUDE_TOKEN_POOL_UNAVAILABLE_REASON);
        }
        const delayMs = jitteredDelayMs(waitMs);
        console.warn(
          `[claude-bridge] PLAT-879: broker required but Anthropic token pool empty/cooling — ` +
          `staying supervised, retrying in ${Math.round(delayMs / 1000)}s ` +
          `(no baked-token fallback, no crash-loop)`,
        );
        this.emitTelemetry(); // surface token_pool_unavailable=true to the exporter
        await new Promise((r) => setTimeout(r, delayMs));
        waitMs = nextTokenPoolBackoffMs(waitMs);
        try {
          const { fetchBrokerModelToken } = require('../auth/broker-token.js');
          const bt = await fetchBrokerModelToken('anthropic');
          if (bt?.token) {
            brokerToken = bt.token;
            brokerLabel = bt.label || 'broker';
            brokerLease = { entryId: bt.entryId, leaseId: bt.leaseId };
          }
        } catch { /* broker/daemon transiently unreachable — keep retrying */ }
      }
    }
    if (this.tokenPoolUnavailable) {
      console.log(
        `[claude-bridge] PLAT-879: Anthropic token pool recovered after ` +
        `${Math.round((Date.now() - this.tokenPoolUnavailableSince) / 1000)}s — resuming spawn`,
      );
      this.tokenPoolUnavailable = false;
      this.tokenPoolUnavailableSince = 0;
      // A newly leased token is not proof that the configured model accepts a
      // turn. Preserve any serving-time outage marker until a turn succeeds.
      if (!readClaudeProviderUnavailableMarker()) {
        void this.markAgentAvailability(true, '');
      }
    }

    // Self-heal across the broker/daemon token-pool split: the broker serves from
    // the hive coordinator pool, which does NOT see real-traffic 429s — only the
    // daemon host pool does (the bridge reports there via report-rate-limit). So a
    // broker token we already cooled in the host pool would be re-served forever,
    // defeating rotation (the 2026-06-24 fleet-wide weekly-limit crash loop). If
    // the broker's token label is on cooldown in the host pool, VETO it and fall
    // back to the daemon's fresh least-loaded pick. No-op unless the token is
    // actually cooled, so normal operation is unchanged. (credentials.json is a
    // live read-only mount, so the daemon's cooldown writes are visible here.)
    if (brokerToken && brokerLabel) {
      try {
        const { isClaudeTokenLabelOnCooldown, getActiveClaudeToken } = require('../config/credentials.js');
        if (isClaudeTokenLabelOnCooldown(brokerLabel)) {
          const fresh = getActiveClaudeToken(brokerLabel);
          if (fresh?.token && fresh.label !== brokerLabel) {
            console.log(`[claude-bridge] Broker token "${brokerLabel}" is on host-pool cooldown — vetoing, using fresh host-pool token "${fresh.label}"`);
            brokerToken = '';
            brokerLabel = '';
            brokerLease = null;
            process.env['CLAUDE_CODE_OAUTH_TOKEN'] = fresh.token;
          }
        }
      } catch { /* fall through to normal policy on any error */ }
    }

    // K8s-native pre-cutover compatibility: the model-token broker endpoint is
    // not deployed everywhere yet, while those pods mount the shared host token
    // pool at ~/.shizuha/credentials.json instead of baking
    // CLAUDE_CODE_OAUTH_TOKEN into env. When the broker token is NOT required
    // (pre-cutover/headless mode) and no env token is present, draw one active
    // token from that mounted pool. Keep the fail-closed required-broker case
    // unchanged: a mounted host pool must not bypass
    // CLAUDE_BRIDGE_REQUIRE_BROKER_MODEL_TOKEN=1.
    let hostPoolToken = '';
    if (!brokerToken && !process.env['CLAUDE_CODE_OAUTH_TOKEN'] && !(brokerConfigured && requireBrokerToken)) {
      try {
        const { getActiveClaudeToken } = require('../config/credentials.js');
        const picked = getActiveClaudeToken();
        if (picked?.token) {
          hostPoolToken = picked.token;
          console.log(
            `[claude-bridge] Broker /model-token unavailable and no env token; ` +
            `using mounted host-pool token "${picked.label ?? 'unknown'}" (pre-cutover fallback)`,
          );
        }
      } catch (err) {
        console.warn(
          `[claude-bridge] Host-pool token fallback unavailable: ${(err as Error).message}`,
        );
      }
    }

    // Apply the token-source policy (fail-closed when the broker token is required
    // but absent; env/host-pool fallback only when no broker / requirement not yet enforced).
    modelToken = resolveModelTokenPolicy({
      brokerConfigured,
      requireBrokerToken,
      brokerToken: brokerToken || null,
      envToken: process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? '',
      hostPoolToken,
    });

    // Track which token we're using (for rotation reporting). The label MUST match
    // the token ACTUALLY passed to Claude — not merely whether the broker offered
    // one. When the broker is present but policy falls back to the env/host-pool
    // token (broker requirement not enforced), labelling it with the broker label
    // makes rate-limit reports target the wrong label: the daemon host-pool
    // report-rate-limit 404s, the real token never cools, and the daemon
    // re-injects the same dead token forever (the 2026-06-24 fleet-wide
    // weekly-limit crash loop). So derive the label from the RESOLVED token.
    if (brokerLabel && modelToken === brokerToken) {
      // Broker token actually selected — its label is authoritative and may
      // change between spawns (e.g. after a 401 rotation), so refresh it each spawn.
      this.currentTokenLabel = brokerLabel;
      this.currentBrokerModelToken = brokerLease;
      console.log(`[claude-bridge] Using broker OAuth token label: ${this.currentTokenLabel}`);
    } else {
      this.currentBrokerModelToken = null;
      // env/host-pool token in use — match it against the pool for the real label
      // so rotation reports cool the correct host-pool entry.
      try {
        const { readCredentials } = require('../config/credentials.js');
        const store = readCredentials();
        const match = (store.anthropic?.tokens ?? []).find((t: any) => t.token === modelToken);
        this.currentTokenLabel = match?.label ?? 'unknown';
      } catch { this.currentTokenLabel = 'unknown'; }
      console.log(`[claude-bridge] Using OAuth token label: ${this.currentTokenLabel}`);
    }

    this.claudeProcess = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      // detached → the child (runuser → claude → mcp-proxy children) leads its OWN
      // process group, so killClaudeTree() can group-kill the WHOLE tree on respawn.
      // Without this, killing only the runuser leader orphans claude + its MCP
      // proxies → two pulse proxies pile up in one container, one stuck on an
      // expired token (the zombie-proxy / "MCP requires re-authorization" recur).
      detached: true,
      env: buildClaudeSpawnEnv(process.env, {
        homeDir,
        user: isRoot ? 'agent' : (process.env['USER'] ?? 'agent'),
        // HIVE-125: deliver the resolved (broker-preferred) model token to Claude
        // Code (runuser -p forwards it); overrides any baked env value.
        oauthToken: modelToken,
      }),
    });

    const thisProc = this.claudeProcess;

    // Handle stdout (NDJSON lines)
    thisProc.stdout!.on('data', (chunk: Buffer) => {
      // PLAT-423: in-turn token rotation can leave the superseded Claude child
      // alive long enough to flush late stdout. Never parse old-child output
      // against the replacement process' active turn state.
      if (!isCurrentBridgeChild(thisProc, this.claudeProcess)) return;
      this.handleStdoutChunk(chunk);
    });

    // Log stderr
    thisProc.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        // Only log meaningful lines (skip long minified source)
        for (const line of text.split('\n')) {
          if (line.length < 500) {
            console.error(`[claude-bridge] stderr: ${line}`);
          }
        }
      }
    });

    thisProc.on('exit', (code, signal) => {
      console.error(`[claude-bridge] claude process exited: code=${code} signal=${signal}`);

      if (this.suppressedClaudeExitProc === thisProc) {
        this.suppressedClaudeExitProc = null;
        if (this.claudeProcess === thisProc) this.claudeProcess = null;
        console.log('[claude-bridge] Claude process exit was expected for token rotation; bridge stays alive');
        return;
      }

      // PLAT-423: a previous rotation can overwrite the single suppression
      // pointer before an earlier child finally exits. If this child is no
      // longer current, it is superseded; ignore the late exit instead of
      // notifying clients or killing the bridge.
      if (!isCurrentBridgeChild(thisProc, this.claudeProcess)) {
        console.log('[claude-bridge] Ignoring exit from superseded Claude process');
        return;
      }

      this.claudeProcess = null;

      // If we were resuming a session and it failed, retry without --resume.
      // This handles stale sessions from bare_metal→container migration, corrupted sessions, etc.
      if (code === 1 && this.storedSessionId && !this.resumeRetried) {
        console.log('[claude-bridge] Session resume failed — retrying with fresh session');
        this.resumeRetried = true;
        this.storedSessionId = null;
        try {
          const sessionIdPath = path.join(this.opts.cwd ?? process.cwd(), '.claude-session-id');
          fs.unlinkSync(sessionIdPath);
        } catch { /* ignore */ }
        this.spawnClaude().catch((err) => {
          console.error(`[claude-bridge] Retry failed: ${err}`);
          process.exit(1);
        });
        return; // Don't exit — we're retrying
      }

      // Notify all clients
      for (const [_, client] of this.clients) {
        this.sendWs(client.ws, {
          type: 'error',
          data: { message: `Claude Code process exited (code ${code})` },
        });
      }
      // Exit the bridge — daemon will restart us
      process.exit(code ?? 1);
    });

    // Wait for process to be alive
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    if (this.claudeProcess.exitCode !== null) {
      // If we were resuming a session and it failed, retry without --resume (fresh session).
      // This handles: session file from bare_metal not found in container, corrupted session, etc.
      if (this.storedSessionId && !this.resumeRetried) {
        console.log('[claude-bridge] Session resume failed — retrying with fresh session');
        this.resumeRetried = true;
        this.storedSessionId = null;
        // Clear the stored session ID file so future restarts also start fresh
        try {
          const sessionIdPath = path.join(this.opts.cwd ?? process.cwd(), '.claude-session-id');
          fs.unlinkSync(sessionIdPath);
        } catch { /* ignore */ }
        return this.spawnClaude(); // Retry without --resume
      }
      throw new Error(`Claude process exited immediately with code ${this.claudeProcess.exitCode}`);
    }

    this.initialized = true;
  }

  /** Whether MCP config was newly created (session needs reset to discover tools) */
  private mcpNewlyConfigured = false;
  private storedSessionId: string | null = null;

  private enqueueMessage(clientId: string, content: string, messageId?: string): { queued: boolean; reason?: string } {
    if (this.runtimeRollDrain.ready) {
      return { queued: false, reason: 'runtime-roll-draining' };
    }
    const message = { clientId, content, ...(messageId ? { messageId } : {}) };
    if (isRoutineClaudeConnectTaskMessage(message)) {
      if (
        !(this.activeThreadId && this.activeTurnIsHeartbeat)
        && !this.heartbeatPending
      ) {
        this.heartbeatPending = true;
        console.log(
          `[claude-bridge] [Connect] Converted routine scheduling notice to one canonical Pulse checkpoint ` +
          `(queue depth: ${this.messageQueue.length})`,
        );
      }
      return { queued: false, reason: 'routine-pulse-wake' };
    }
    const decision = shouldDropQueuedMessage(this.messageQueue, content);
    if (decision.drop) {
      console.warn(
        `[claude-bridge] [Connect] Dropped queued message (${decision.reason}; ` +
        `queue depth: ${this.messageQueue.length}; len=${content.length})`,
      );
      return { queued: false, reason: decision.reason };
    }
    this.messageQueue.push(message);
    console.log(`[claude-bridge] [Connect] Queued (queue depth: ${this.messageQueue.length})`);
    return { queued: true };
  }

  /** Configure cron MCP server so Claude Code can schedule jobs */
  private async startConnectClient(): Promise<void> {
    try {
      const { ConnectClient } = await import('../connect-client/index.js');
      this.connectClient = new ConnectClient({
        onOpen: () => this.emitTelemetry(),
        onMessage: (convId, content, senderId, senderName, messageId) => {
          if (this.runtimeRollDrain.ready) {
            console.log(
              `[claude-bridge] [Connect] Holding unread message from ${senderName} during runtime rollout`,
            );
            return;
          }
          const connectClientId = `connect:${convId}`;
          if (messageId && this.store.inboundProcessingCompleted(this.sessionId, messageId)) {
            this.connectClient?.ackMessageProcessed(messageId);
            return;
          }
          if (messageId) this.store.markInboundProcessingAdmitted(this.sessionId, messageId, 'connect');
          console.log(`[claude-bridge] [Connect] Message from ${senderName} (${senderId}) in conv ${convId.substring(0, 8)}… len=${content.length} busy=${!!this.activeThreadId}`);
          const result = this.enqueueMessage(connectClientId, content, messageId);
          if (result.reason === 'routine-pulse-wake' && messageId) {
            this.store.markInboundProcessingCompleted(this.sessionId, messageId);
            this.connectClient?.ackMessageProcessed(messageId);
          }
          this.processQueue();
          if (result.queued) {
            if (this.activeThreadId === convId) {
              console.log(`[claude-bridge] [Connect] Execution started, threadId=${convId.substring(0, 8)}…`);
            }
          }
        },
        onConfigUpdate: (cfg) => { try { this.applyConfigUpdate(cfg); } catch (e) { console.error(`[claude-bridge] applyConfigUpdate failed: ${(e as Error).message}`); } },
      });
      await this.connectClient.start();
    } catch (err) {
      console.error(`[connect-client] Failed to start: ${(err as Error).message}`);
      // Non-fatal — bridge still works without Connect
    }
  }

  /**
   * HIVE-195 Phase 3: apply a config update pushed from Hive over the Connect WS.
   * BYO/containerized agents have no daemon control-proxy, so this is how
   * top-down config reaches them. We apply the model live (set opts.model +
   * restart the claude subprocess, reusing the failover swap path) and persist
   * the override to ~/.shizuha/config-override.json so it also survives a full
   * container restart. Other fields are persisted for the next spawn to pick up.
   */
  private applyConfigUpdate(cfg: Record<string, unknown>): void {
    if (!cfg || typeof cfg !== 'object') return;
    // Normalize: accept either a flat `model` or a model_overrides map.
    const ov = (cfg['model_overrides'] as Record<string, string> | undefined) || undefined;
    const newModel = (cfg['model'] as string | undefined)
      || (ov ? (ov['claude_code_server']) : undefined);
    console.log(`[claude-bridge] [config] update received: ${JSON.stringify(cfg).slice(0, 200)}`);
    // Persist override (best-effort) for restart-durability.
    try {
      const home = process.env['HOME'] ?? (process.getuid?.() === 0 ? '/home/agent' : '/root');
      const dir = `${home}/.shizuha`;
      fs.mkdirSync(dir, { recursive: true });
      const path = `${dir}/config-override.json`;
      let prev: Record<string, unknown> = {};
      try { prev = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { /* none */ }
      fs.writeFileSync(path, JSON.stringify({ ...prev, ...cfg, _updated_at: Date.now() }, null, 2));
    } catch (e) { console.error(`[claude-bridge] [config] persist failed: ${(e as Error).message}`); }
    // Apply model live: swap + restart the claude subprocess (it respawns with the new model).
    if (newModel && newModel !== this.opts.model) {
      console.log(`[claude-bridge] [config] model ${this.opts.model} -> ${newModel} (restarting session)`);
      this.opts.model = newModel;
      this.rateLimitedTokens.clear();
      if (this.claudeProcess && this.claudeProcess.exitCode === null) {
        this.killClaudeTree(this.claudeProcess, 'SIGTERM'); // respawns with new model
      }
    }
    try { this.connectClient?.sendTelemetry(this.buildTelemetry()); } catch { /* ignore */ }
  }

  /** Link bundled /opt/skills into Claude Code's native skill roots. Claude
   *  discovers SKILL.md from ~/.claude/skills and CLAUDE_CONFIG_DIR/skills. */
  private setupSkills(): void {
    try {
      const isRoot = process.getuid?.() === 0;
      const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
      const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir, '.claude');
      const src = '/opt/skills';
      if (!fs.existsSync(src)) { console.log('[claude-bridge] No /opt/skills to link'); return; }
      const names = fs.readdirSync(src).filter((name) => {
        try { return fs.statSync(path.join(src, name)).isDirectory() && fs.existsSync(path.join(src, name, 'SKILL.md')); }
        catch { return false; }
      });
      const dests = [...new Set([path.join(claudeDir, 'skills'), path.join(homeDir, '.claude', 'skills')])];
      for (const dest of dests) {
        fs.mkdirSync(dest, { recursive: true });
        for (const name of names) {
          const link = path.join(dest, name);
          try { fs.rmSync(link, { recursive: true, force: true }); } catch { /* best-effort */ }
          try { fs.symlinkSync(path.join(src, name), link, 'dir'); }
          catch (err) { console.error(`[claude-bridge] skill link failed for ${name}: ${(err as Error).message}`); }
        }
      }
      if (isRoot) chownForContainerAgent(claudeDir);
      console.log(`[claude-bridge] Linked ${names.length} skills from /opt/skills into Claude skill roots (${dests.join(', ')})`);
    } catch (err) {
      console.error(`[claude-bridge] setupSkills error: ${(err as Error).message}`);
    }
  }

  private async setupCronMcp(): Promise<void> {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? process.cwd();
    // Use CLAUDE_CONFIG_DIR if set (bare metal agents), otherwise default to ~/.claude/
    const claudeDir = process.env['CLAUDE_CONFIG_DIR'] ?? path.join(homeDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // ── MCP config: write to .mcp.json in CWD (Claude Code reads MCP from .mcp.json, not settings.json) ──
    const mcpJsonPath = path.join(workDir, '.mcp.json');
    let mcpJson: Record<string, unknown> = {};
    try {
      if (fs.existsSync(mcpJsonPath)) mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8'));
    } catch { /* start fresh */ }
    const existingMcp = (mcpJson.mcpServers as Record<string, unknown>) ?? {};
    const hadLegacyCronMcp = !!existingMcp['shizuha-cron'];
    const browserMcp = resolveBrowserMcpServer(this.opts.contextPrompt);

    // Check if platform is connected
    // Resolve platform URL — reject localhost/loopback (broken inside containers).
    // Containers can reach the host via Tailscale DNS (shizuha.com) which
    // works across machines. HTTP is fine on Tailscale (encrypted tunnel).
    // Resolve platform URL — reject localhost/loopback (broken inside containers).
    // Containers reach the host via Tailscale DNS (shizuha.com).
    const platformBase = this.resolvePlatformBase();
    if (platformBase !== (process.env['SHIZUHA_PLATFORM_URL'] || '')) {
      console.log(`[${this.opts.agentName}] Platform URL corrected: ${process.env['SHIZUHA_PLATFORM_URL']} → ${platformBase}`);
    }
    const platformPulseConnected = !!platformBase;

    const nextMcpServers = { ...existingMcp };
    delete nextMcpServers['shizuha-cron'];
    if (browserMcp) {
      nextMcpServers[browserMcp.name] = browserMcp.entry;
    } else {
      delete nextMcpServers['browser'];
    }
    mcpJson.mcpServers = nextMcpServers;

    // ── Platform MCP servers: wiki, pulse, notes, drive, etc. ──
    // ── Agent Authentication via shizuha-id ──
    // Each agent authenticates as itself (AGENT_USERNAME / AGENT_PASSWORD) and
    // uses the resulting shizuha-id JWT for all platform MCP calls. shizuha-id
    // is the only signer — no local HMAC minting anywhere.
    //
    // Token sources, in order:
    //   1. AGENT_ACCESS_TOKEN  — provisioned by the daemon at container spawn
    //      (daemon already logged in for us via ensureAgentAccount)
    //   2. AgentTokenManager   — falls back to a fresh login if the daemon
    //      didn't pre-provision one (e.g. headless dev runs)
    const agentEmail = process.env['AGENT_EMAIL'] || `${this.opts.agentUsername}@agents.shizuha.io`;
    let jwtToken = process.env['AGENT_ACCESS_TOKEN'] || '';
    // The env token is provisioned once at container spawn and is NOT refreshed
    // by a bare `docker restart`. Trusting it blindly means a restarted (or
    // long-lived) container boots with an expired JWT and every platform MCP
    // call 401s. So only keep the env token if it is still comfortably valid;
    // otherwise mint a fresh one via AgentTokenManager (which self-heals the
    // password and upgrades to a 365-day API token).
    if (jwtToken && isJwtStale(jwtToken)) {
      console.log(`[${this.opts.agentName}] AGENT_ACCESS_TOKEN expired/near-expiry — obtaining a fresh token`);
      jwtToken = '';
    }
    if (!jwtToken && platformBase) {
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const tm = new AgentTokenManager({
        agentUsername: this.opts.agentUsername ?? 'agent',
        agentEmail,
        platformUrl: platformBase,
      });
      try {
        // Retry with exponential backoff so a transient shizuha-id outage
        // (e.g. the post-reboot stale-DB-pool window) never wedges the agent
        // into running unauthenticated — it waits and self-heals once
        // shizuha-id is back instead of giving up after a single attempt.
        // Bounded so a transient mint failure (e.g. a brief shizuha-id/edge blip)
        // can NEVER wedge the agent: previously a 10-min retry here blocked start()
        // BEFORE connect/telemetry/spawn, silently parking the agent (the taki
        // incident). 45s is enough to ride out a normal restart; if it still fails
        // we proceed with whatever token we have and the +60s/6h refreshMcpTokenOnce
        // timer self-heals MCP once shizuha-id is reachable.
        jwtToken = (await tm.getTokenWithRetry({ maxWaitMs: 45_000 })) ?? '';
        if (jwtToken) {
          console.log(`[${this.opts.agentName}] Agent token: obtained via shizuha-id login`);
        }
      } catch (err) {
        console.warn(`[${this.opts.agentName}] shizuha-id login failed:`, (err as Error).message);
      }
    }

    // ── Platform MCP servers (all HTTP) ──
    if (platformBase && jwtToken) {
      const { getPlatformMcpConfigs, PLATFORM_MCP_SERVICES, stripPlatformManagedMcpEntries } = await import('../platform/mcp-services.js');
      // Durable token-staleness fix: the stdio mcp-proxy reads the bearer FRESH
      // from this file on every (re)connect, so a token the refresh timer
      // rewrites here takes effect IN-PROCESS — no agent restart, no 24h cliff.
      // Seed it with the current token before claude-code spawns the proxy.
      const tokenFile = this.mcpUpstreamTokenFile(workDir);
      try { fs.writeFileSync(tokenFile, jwtToken, { mode: 0o600 }); } catch { /* proxy falls back to env seed */ }
      const platformConfigs = getPlatformMcpConfigs({
        bearerToken: jwtToken,
        bearerTokenFile: tokenFile,
        platformUrl: platformBase,
      });
      // PLAT-4023: the platform MCP block is authoritatively regenerated from
      // getPlatformMcpConfigs (either the per-service proxies OR the single
      // shizuha-mcp multiplexer entry, never both). Strip any platform-managed
      // entries carried over from a prior boot's persistent .mcp.json BEFORE
      // merging, so toggling SHIZUHA_MCP_MULTIPLEXER on/off is idempotent +
      // reversible — no per-service proxies left running alongside shizuha-mcp,
      // and no stale shizuha-mcp when the flag is removed. Custom entries are
      // preserved.
      mcpJson.mcpServers = stripPlatformManagedMcpEntries(mcpJson.mcpServers as Record<string, unknown>);
      Object.assign(mcpJson.mcpServers as Record<string, unknown>, platformConfigs);

      // ── MCP OAuth migration (generic in-session token-refresh fix) ──
      // For services in SHIZUHA_MCP_OAUTH_SERVICES (comma list or `*`), strip
      // the static Authorization header and seed Claude Code's native OAuth
      // store (mcpOAuth) so CC refreshes the token itself on a server 401.
      // This requires the corresponding MCP server to enforce bearer auth
      // (SHIZUHA_MCP_OAUTH_ENFORCE=true). Services NOT listed keep the static
      // header (legacy behaviour). See src/platform/mcp-oauth-seed.ts.
      try {
        const { seedMcpOAuthCredentials, oauthServiceMatcher } = await import('../platform/mcp-oauth-seed.js');
        const isOAuthService = oauthServiceMatcher(process.env['SHIZUHA_MCP_OAUTH_SERVICES']);
        const oauthHomeDir = (process.getuid?.() === 0 ? '/home/agent' : (process.env['HOME'] ?? '/root'));
        const { seeded } = await seedMcpOAuthCredentials({
          mcpServers: mcpJson.mcpServers as Record<string, import('../platform/mcp-oauth-seed.js').McpEntry>,
          homeDir: oauthHomeDir,
          agentUsername: this.opts.agentUsername ?? 'agent',
          agentPassword: readAgentCredential('AGENT_PASSWORD') ?? '',
          platformBase,
          isOAuthService,
        });
        if (seeded.length > 0) {
          console.log(`[${this.opts.agentName}] Platform MCP: ${seeded.length} services migrated to native OAuth refresh [${seeded.join(', ')}]`);
        }
      } catch (err) {
        console.warn(`[${this.opts.agentName}] MCP OAuth seeding failed (keeping static headers):`, (err as Error).message);
      }

      console.log(`[${this.opts.agentName}] Platform MCP: ${PLATFORM_MCP_SERVICES.length} services configured (shizuha-id JWT)`);
    } else if (platformBase) {
      console.warn(`[${this.opts.agentName}] Platform MCP: no JWT — skipping platform MCP servers (agent will lose access to Pulse/Connect/etc.)`);
    }

    // ── Ori MCP server (messaging multiplexer) ──
    // Ori exposes the modern streamable-HTTP MCP transport at /mcp. The legacy
    // /mcp/sse endpoint can return HTTP 200 while streaming no endpoint event,
    // which wedges clients until their 90s MCP connect timeout (ORIG-65).
    // Probe the actual transport before adding it to Claude's MCP config.
    {
      const oriHost = process.env['DAEMON_HOST'] || 'host.docker.internal';
      const oriPort = process.env['ORI_PORT'] || '9500';
      const oriMcp = buildOriMcpEntry(oriHost, oriPort);
      try {
        const { execSync } = require('node:child_process');
        execSync(buildOriMcpProbeCommand(oriHost, oriPort), { timeout: 5000, stdio: 'ignore' });
        (mcpJson.mcpServers as Record<string, unknown>)['ori'] = oriMcp;
        console.log(`[${this.opts.agentName}] Ori MCP: streamable-http at ${oriMcp.url}`);
      } catch {
        // Ori not available — skip silently
      }
    }

    // ── Google Drive MCP server (read-only file access) ──
    // workspace-mcp fork running on host, streamable-http transport.
    // Probe synchronously to check if it's running before adding.
    {
      const driveHost = process.env['DAEMON_HOST'] || 'host.docker.internal';
      const drivePort = process.env['GDRIVE_MCP_PORT'] || '9600';
      const driveUrl = `http://${driveHost}:${drivePort}/mcp`;
      try {
        const { execSync } = require('node:child_process');
        execSync(`curl -sf http://${driveHost}:${drivePort}/mcp -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1.0"}}}' --max-time 3`, { timeout: 5000, stdio: 'ignore' });
        (mcpJson.mcpServers as Record<string, unknown>)['google-drive'] = {
          type: 'http',
          url: driveUrl,
        };
        console.log(`[${this.opts.agentName}] Google Drive MCP: streamable-http at ${driveUrl}`);
      } catch {
        // Google Drive MCP not available — skip silently
      }
    }

    // SCLI-44/SCLI-64: prune platform shizuha-* entries not in the role-derived
    // allow-list (SCLI-44) or SHIZUHA_MCP_SERVICES override (SCLI-64). We MERGE
    // into any pre-existing .mcp.json so a server trimmed from the allow-list
    // would otherwise linger across restarts.
    try {
      const { prunePlatformMcpKeys } = await import('../platform/mcp-services.js');
      const { resolveAllowedServers } = await import('../platform/mcp-access-matrix.js');
      const { parseAgentEffectiveMcpServicesFromEnv } = await import('../platform/effective-capabilities.js');
      const agentRole = process.env['AGENT_ROLE'];
      const agentUsername = this.opts.agentUsername ?? process.env['AGENT_USERNAME'];
      // Capability tags (skills[]) are unioned with role to drive the allow-list
      // (operator 2026-06-24): a multi-capability agent gets the union of its sets.
      const agentSkills = (process.env['AGENT_SKILLS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      // SCLI-44/SCLI-64: role matrix = ceiling; SHIZUHA_MCP_SERVICES = optional
      // further narrowing. Pass the role-derived set as explicit; resolveMcpAllowList
      // (inside prunePlatformMcpKeys) intersects it with the env var when both are
      // present, so the operator lever always wins.
      const hiveAllowList = parseAgentEffectiveMcpServicesFromEnv();
      const roleAllowed = hiveAllowList ? new Set(hiveAllowList) : resolveAllowedServers(agentRole, agentUsername, agentSkills);
      const roleAllowList = [...roleAllowed];
      mcpJson.mcpServers = prunePlatformMcpKeys(
        mcpJson.mcpServers as Record<string, unknown>,
        roleAllowList,
      );
      if (hiveAllowList) {
        console.log(`[${this.opts.agentName}] MCP scope pinned by Hive effective capabilities: ${roleAllowList.join(', ')}`);
      } else if (agentRole) {
        console.log(`[${this.opts.agentName}] MCP scope pinned by role matrix (${agentRole}): ${roleAllowList.join(', ')}`);
      }
    } catch { /* prune is best-effort; never block bridge startup */ }

    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpJson, null, 2));

    // Also write to Claude Code project dir (Claude reads from ~/.claude/projects/<hash>/.mcp.json)
    const projectDir = path.join(claudeDir, 'projects', `-${path.basename(workDir)}`);
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.writeFileSync(path.join(projectDir, '.mcp.json'), JSON.stringify(mcpJson, null, 2));
    } catch { /* non-fatal */ }

    // ── Permissions: write to settings.json in CLAUDE_CONFIG_DIR ──
    const settingsPath = path.join(claudeDir, 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }

    const perms = (settings.permissions ?? {}) as Record<string, unknown>;
    const allow = (perms.allow ?? []) as string[];
    for (const tool of [
      ...(browserMcp ? [
        'mcp__browser__browser',
        'mcp__browser__mouse',
        'mcp__browser__keyboard',
        'mcp__browser__browser_command',
        'mcp__browser__browser_egress',
      ] : []),
      // Platform Pulse MCP tools (when connected to platform)
      'mcp__shizuha-pulse__pulse_list_tasks', 'mcp__shizuha-pulse__pulse_create_task',
      'mcp__shizuha-pulse__pulse_get_task', 'mcp__shizuha-pulse__pulse_update_task',
      'mcp__shizuha-pulse__pulse_complete_task', 'mcp__shizuha-pulse__pulse_assign_task',
      'mcp__shizuha-pulse__pulse_search_tasks', 'mcp__shizuha-pulse__pulse_add_comment',
      'mcp__shizuha-pulse__pulse_get_my_alerts', 'mcp__shizuha-pulse__pulse_get_my_tasks',
      'mcp__shizuha-pulse__pulse_get_statistics',
      'mcp__shizuha-pulse__pulse_list_projects', 'mcp__shizuha-pulse__pulse_get_project',
      'mcp__shizuha-pulse__pulse_list_workflows', 'mcp__shizuha-pulse__pulse_get_available_transitions',
      'mcp__shizuha-pulse__pulse_link_issues', 'mcp__shizuha-pulse__pulse_list_comments',
      'mcp__shizuha-pulse__pulse_get_my_identity', 'mcp__shizuha-pulse__pulse_bulk_operation',
      // Wiki MCP tools (platform service)
      'mcp__shizuha-wiki__wiki_list_spaces', 'mcp__shizuha-wiki__wiki_create_page',
      'mcp__shizuha-wiki__wiki_get_page', 'mcp__shizuha-wiki__wiki_update_page',
      'mcp__shizuha-wiki__wiki_delete_page', 'mcp__shizuha-wiki__wiki_list_pages',
      'mcp__shizuha-wiki__wiki_get_space', 'mcp__shizuha-wiki__wiki_get_space_tree',
      // Hive MCP owns platform agent lifecycle + credential metadata.
      'mcp__shizuha-hive__hive_list_fleet_agents', 'mcp__shizuha-hive__hive_get_agent_roster',
      'mcp__shizuha-hive__hive_create_fleet_agent', 'mcp__shizuha-hive__hive_update_fleet_agent',
      'mcp__shizuha-hive__hive_delete_fleet_agent', 'mcp__shizuha-hive__hive_enable_fleet_agent',
      'mcp__shizuha-hive__hive_disable_fleet_agent', 'mcp__shizuha-hive__hive_restart_fleet_agent',
      'mcp__shizuha-hive__hive_reset_agent_runtime_session',
      'mcp__shizuha-hive__hive_list_credentials', 'mcp__shizuha-hive__hive_create_credential',
      'mcp__shizuha-hive__hive_get_credential', 'mcp__shizuha-hive__hive_update_credential',
      'mcp__shizuha-hive__hive_revoke_credential', 'mcp__shizuha-hive__hive_get_credential_audit',
      'mcp__shizuha-wiki__wiki_search_pages', 'mcp__shizuha-wiki__wiki_list_labels',
      'mcp__shizuha-wiki__wiki_create_label', 'mcp__shizuha-wiki__wiki_get_my_identity',
      'mcp__shizuha-wiki__wiki_list_templates', 'mcp__shizuha-wiki__wiki_create_space',
      // Ori MCP tools (messaging multiplexer)
      'mcp__ori__ori_get_channels', 'mcp__ori__ori_get_messages', 'mcp__ori__ori_send_message',
      'mcp__ori__ori_mark_processed', 'mcp__ori__ori_get_channel_status',
      'mcp__ori__ori_check_sender', 'mcp__ori__ori_start_verification', 'mcp__ori__ori_list_verified_senders',
      // Google Drive MCP tools (read-only file access)
      'mcp__google-drive__search_drive_files', 'mcp__google-drive__get_drive_file_content',
      'mcp__google-drive__get_drive_file_download_url', 'mcp__google-drive__get_drive_shareable_link',
    ]) {
      if (!allow.includes(tool)) allow.push(tool);
    }
    perms.allow = allow;
    settings.permissions = perms;
    // Remove stale MCP config from settings.json (was wrong location)
    delete (settings as any).mcpServers;
    installClaudeHeartbeatObservationHooks(settings, workDir);

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    if (isRoot) {
      chownForContainerAgent(claudeDir);
    }

    if (hadLegacyCronMcp) {
      this.mcpNewlyConfigured = true;
      console.log('[claude-bridge] Legacy shizuha-cron MCP removed — will start fresh session');
    }

    // ── Credential awareness: tell the agent what env vars are available ──
    // Auto-discovered from the process environment. The agent doesn't need to know
    // the values — just the names, so it knows what tools/CLIs it can use.
    // Skills (SKILL.md files) provide the "how to use" instructions.
    const knownCredentialEnvVars: Array<{ name: string; hint: string }> = [
      { name: 'GITHUB_TOKEN', hint: 'GitHub API / gh CLI authentication' },
      { name: 'GITLAB_TOKEN', hint: 'GitLab API authentication' },
      { name: 'ANTHROPIC_API_KEY', hint: 'Anthropic Claude API' },
      { name: 'OPENAI_API_KEY', hint: 'OpenAI API' },
      { name: 'GOOGLE_API_KEY', hint: 'Google AI API' },
      { name: 'SHIZUHA_USERNAME', hint: 'Shizuha platform login (username)' },
      { name: 'SHIZUHA_PASSWORD', hint: 'Shizuha platform login (password)' },
      { name: 'AWS_ACCESS_KEY_ID', hint: 'AWS authentication' },
      { name: 'AWS_SECRET_ACCESS_KEY', hint: 'AWS authentication' },
      { name: 'NPM_TOKEN', hint: 'npm registry authentication' },
      { name: 'DOCKER_USERNAME', hint: 'Docker Hub authentication' },
      { name: 'DOCKER_PASSWORD', hint: 'Docker Hub authentication' },
    ];
    const available = knownCredentialEnvVars.filter(c => !!process.env[c.name]);
    if (available.length > 0) {
      const credSection = [
        '',
        '## Available Credentials',
        'The following credentials are injected as environment variables:',
        ...available.map(c => `- \`${c.name}\` — ${c.hint}`),
        '',
        'Use the corresponding CLI tools or SDKs that read these env vars. Check your native skills for usage patterns.',
      ].join('\n');
      this.opts.contextPrompt = (this.opts.contextPrompt ?? '') + credSection;
    }
  }

  private async findClaudeCli(): Promise<string> {
    // Check common locations
    const candidates = [
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      path.join(process.env['HOME'] ?? '/root', '.claude', 'local', 'claude'),
      path.join(process.env['HOME'] ?? '/root', '.local', 'bin', 'claude'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    // Try PATH
    try {
      const { execSync } = await import('node:child_process');
      const result = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch { /* not found */ }

    // Auto-install Claude CLI — try multiple methods
    console.log('[claude-bridge] Claude CLI not found — installing...');
    const { execSync: execSyncImport } = await import('node:child_process');
    const localPrefix = path.join(process.env['HOME'] ?? '/root', '.local');

    const installMethods = [
      { name: 'npm global', cmd: 'npm install -g @anthropic-ai/claude-code', timeout: 120_000 },
      { name: 'npm user-local', cmd: `npm install -g --prefix ${localPrefix} @anthropic-ai/claude-code`, timeout: 120_000 },
      { name: 'official installer', cmd: 'curl -fsSL https://claude.ai/install.sh | bash', timeout: 120_000 },
    ];

    for (const method of installMethods) {
      try {
        execSyncImport(method.cmd, {
          encoding: 'utf-8', timeout: method.timeout,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, NONINTERACTIVE: '1' },
        });
        console.log(`[claude-bridge] Claude CLI installed via ${method.name}`);
        for (const p of candidates) { if (fs.existsSync(p)) return p; }
        try {
          const result = execSyncImport('which claude', { encoding: 'utf-8', timeout: 5000 }).trim();
          if (result) return result;
        } catch { /* continue checking */ }
      } catch (e) {
        const msg = (e as Error).message;
        if (msg.includes('EACCES') && method.name === 'npm global') {
          console.log('[claude-bridge] Global install failed (EACCES), trying next method...');
          continue;
        }
        console.warn(`[claude-bridge] ${method.name} install failed: ${msg.slice(0, 100)}`);
      }
    }

    throw new Error(
      'Claude CLI not found and auto-install failed. Install manually:\n'
      + '  curl -fsSL https://claude.ai/install.sh | bash',
    );
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.lineBuffer += chunk.toString();

    // Process complete lines
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() || ''; // Last element is incomplete (or empty)

    for (const line of lines) {
      // Check for replay events (from --resume/--continue) before parsing
      const rawMsg = this.tryParseJson(line) as (Record<string, any> | null);
      if (rawMsg?.isReplay) {
        // Collect replay messages for sync responses but don't broadcast
        if (rawMsg.type === 'user' && rawMsg.message?.content) {
          this.replayHistory.push({
            role: 'user',
            content: typeof rawMsg.message.content === 'string' ? rawMsg.message.content : JSON.stringify(rawMsg.message.content),
            createdAt: new Date().toISOString(),
          });
        } else if (rawMsg.type === 'assistant' && rawMsg.message?.content) {
          const content = Array.isArray(rawMsg.message.content)
            ? rawMsg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
            : typeof rawMsg.message.content === 'string' ? rawMsg.message.content : '';
          if (content) {
            this.replayHistory.push({ role: 'assistant', content, createdAt: new Date().toISOString() });
          }
        }
        continue; // Skip — don't forward replay events to clients
      }

      // First non-replay message means replay is done
      if (this.isReplaying && rawMsg && !rawMsg.isReplay) {
        this.isReplaying = false;
        if (this.replayHistory.length > 0) {
          console.log(`[claude-bridge] Session replay complete: ${this.replayHistory.length} messages recovered`);
        }
      }

      const parsed = parseStreamJsonLine(line);
      if (!parsed) continue;
      // Any non-replay NDJSON event from the live child proves forward progress,
      // including usage-only events and streaming output from a long-running tool.
      if (this.activeThreadId && this.activeThreadStartedAt !== null) {
        this.activeTurnLastProgressAt = Date.now();
      }

      // ── Telemetry: log tool calls and turns for latency profiling ──
      if (parsed.type === 'tool_start') {
        const toolName = (parsed.data as any)?.tool ?? '';
        console.log(`[claude-bridge] [telemetry] tool_start: ${toolName} at=${new Date().toISOString()}`);
        applyAgentEventToPhase(this.activityPhase, { type: 'tool_start', toolName });
      }
      if (parsed.type === 'tool_complete') {
        const toolName = (parsed.data as any)?.tool ?? '';
        console.log(`[claude-bridge] [telemetry] tool_complete: ${toolName} at=${new Date().toISOString()}`);
        applyAgentEventToPhase(this.activityPhase, { type: 'tool_complete' });
      }
      if (parsed.type === 'content') {
        applyAgentEventToPhase(this.activityPhase, { type: 'content' });
      }
      if (parsed.type === 'reasoning') {
        applyAgentEventToPhase(this.activityPhase, { type: 'thinking' });
      }

      if (parsed.type === 'message_ack') {
        // system/init — capture real session ID and persist it
        const realSessionId = parsed.data?.session_id as string | undefined;
        if (realSessionId) {
          this.claudeSessionId = realSessionId;
          this.saveSessionId(realSessionId);
          console.log(`[claude-bridge] Claude session ID: ${realSessionId}`);
        }
        continue;
      }

      if (parsed.type === 'skip') {
        // Usage tracking
        if (parsed.data?._usage_start) {
          const u = parsed.data._usage_start as Record<string, number>;
          this.totalInputTokens += u.input_tokens ?? 0;
          // input_tokens of the latest request = current context window occupancy.
          if (u.input_tokens) this.lastTurnInputTokens = u.input_tokens;
        }
        if (parsed.data?._usage_delta) {
          const u = parsed.data._usage_delta as Record<string, number>;
          this.totalOutputTokens += u.output_tokens ?? 0;
        }
        continue;
      }

      if (parsed.type === 'complete') {
        this.turnCount++;
        this.consecutiveErrorTurns = 0; // SCLI-61: a successful turn ends any error run
        this.retryCount529 = 0; // Reset on successful turn
        if (readClaudeProviderUnavailableMarker()) {
          clearClaudeProviderUnavailableMarker();
          void this.markAgentAvailability(true, '');
        }
        console.log(`[claude-bridge] [telemetry] turn_complete: turn=${this.turnCount} at=${new Date().toISOString()}`);
        // Merge token info from result
        if (parsed.data?.input_tokens) {
          this.totalInputTokens += parsed.data.input_tokens as number;
        }
        if (parsed.data?.output_tokens) {
          this.totalOutputTokens += parsed.data.output_tokens as number;
        }

        // Telemetry: capture this turn's output volume + wall time (for tok/s) and
        // push a fresh snapshot to the platform immediately on turn end.
        {
          const _now = Date.now();
          this.lastTurnDurationMs = Math.max(1, _now - this.lastCompleteAt);
          this.lastTurnOutputTokens = Math.max(0, this.totalOutputTokens - this.outputAtLastComplete);
          this.outputAtLastComplete = this.totalOutputTokens;
          this.lastCompleteAt = _now;
          this.lastActivityAt = _now;
          this.emitTelemetry();
        }

        // Flush all pending tools — they must have completed before the turn ended
        this.flushPendingTools();

        let retryHeartbeatObservation = false;
        if (this.activeTurnIsHeartbeat) {
          const outcome = recordHeartbeatQueueDrainTurn(
            this.opts.agentId ?? this.opts.agentUsername ?? 'unknown-claude-agent',
            {
              toolCalls: this.heartbeatToolCalls,
              toolResults: this.heartbeatToolResults,
            },
          );
          console.log(formatHeartbeatQueueDrainOutcomeLogLine(outcome));
          if (!this.heartbeatPulseQueueObserved && this.heartbeatObservationRetryCount < 2) {
            this.heartbeatObservationRetryCount++;
            retryHeartbeatObservation = true;
            console.warn(
              `[claude-bridge] Heartbeat ended without a successful Pulse queue observation — ` +
              `scheduling bounded mandatory-tool retry ${this.heartbeatObservationRetryCount}/2`,
            );
          } else {
            // A successful observation, or exhaustion of both bounded retries,
            // gives the next normal cadence a fresh retry allowance.
            this.heartbeatObservationRetryCount = 0;
          }
        }

        // Tally output chars from the final result text (uniform load metric;
        // claude-bridge streams deltas straight to the WS and never fills
        // accumulatedContent, so use the complete-result text).
        const _resultText = String((parsed.data as Record<string, unknown> | undefined)?.result ?? '');
        if (_resultText) this.totalOutputChars += _resultText.length;
        if (this.activeThreadId) {
          if (this.accumulatedContent) {
            this.replayHistory.push({
              id: this.activeMessageId ?? crypto.randomUUID(),
              role: 'assistant',
              content: this.accumulatedContent,
              createdAt: new Date().toISOString(),
            });
          }
          this.broadcastToThread(this.activeThreadId, {
            type: 'complete',
            execution_id: this.activeThreadId,
            data: {
              result: {
                total_turns: this.turnCount,
                input_tokens: this.totalInputTokens,
                output_tokens: this.totalOutputTokens,
              },
              duration_seconds: parsed.data?.duration_seconds ?? 0,
            },
          });
          // Inject-once: always ack Connect DMs when the turn completes, whether
          // or not the model called message_user. Silence is agent choice.
          if (this.activeConnectMessageId) {
            this.store.markInboundProcessingCompleted(this.sessionId, this.activeConnectMessageId);
            this.connectClient?.ackMessageProcessed(this.activeConnectMessageId);
          }
          this.activeConnectMessageId = null;
          this.activeThreadId = null;
          this.activeThreadStartedAt = null;
          this.activeMessageId = null;
          this.activeTurnContent = null;
          this.activeTurnIsHeartbeat = false;
          this.activeTurnRateLimitedTokens.clear();
          this.heartbeatPulseAlertsObserved = false;
          this.heartbeatPulseQueueObserved = false;
          this.heartbeatToolCalls = [];
          this.heartbeatToolResults = [];
          if (retryHeartbeatObservation) {
            this.heartbeatObservationRetryPending = true;
            this.heartbeatPending = true;
          } else {
            this.clearHeartbeatObservationGate();
          }
          // Publish the queue-drain verdict after the latch and per-turn state
          // are final, then let the boundary arbiter run any mandatory retry.
          this.emitTelemetry();
          this.processQueue();
        }
        continue;
      }

      if (parsed.type === 'error') {
        const errorMsg = (parsed.data as any)?.message ?? 'unknown error';
        // HIVE-143: classify into is401 (auth/expired token) / is429 (rate/quota) /
        // is529 (transient overload). 401 is distinct from 429 — see
        // classifyClaudeApiError. 529 is retried in place; 429 routes to token
        // rotation + cooldown (SCLI-73); 401 routes to rotation WITHOUT cooldown
        // (the expired token just needs a restart-time refresh, not a 6h park).
        const { is401, is429, is529, isTokenDead } = classifyClaudeApiError(errorMsg);
        // CONTEXT_CREDIT_RE matches the very specific 1M-context credit-wall error —
        // distinct from generic is429 (rate-limit/quota). Routes to session rotation,
        // not token rotation.
        const isContextCredit = CONTEXT_CREDIT_RE.test(String(errorMsg));

        if ((is429 && !isContextCredit) || isTokenDead) {
          const providerOutageReason = String(errorMsg || CLAUDE_TOKEN_POOL_UNAVAILABLE_REASON);
          writeClaudeProviderUnavailableMarker(providerOutageReason);
          void this.markAgentAvailability(false, providerOutageReason);
        }

        // ALWAYS log errors — critical for observability
        console.error(`[claude-bridge] [telemetry] API_ERROR: ${errorMsg} at=${new Date().toISOString()}`);

        if (isContextCredit && this.activeThreadId) {
          this.flushPendingTools();
          this.broadcastToThread(this.activeThreadId, {
            type: 'error',
            execution_id: this.activeThreadId,
            data: parsed.data,
          });
          if (!this.isReplaying) this.recordTurnError(String(errorMsg), false);
          this.activeThreadId = null;
          this.activeThreadStartedAt = null;
          this.activeMessageId = null;
          this.activeTurnContent = null;
          this.processQueue();
          continue;
        }

        // PLAT-423: token/account limits are not user-visible turn failures until
        // every configured token has been tried. Do not emit an error/complete or
        // let the daemon mark the agent provider_down while a functional token may
        // still exist; rotate the token, respawn Claude, and replay this exact turn.
        if ((is429 || isTokenDead) && this.activeThreadId && this.activeTurnContent && !this.isReplaying) {
          if (this.claudeActiveTurnRotationInFlight || this.claudeActiveTurnRotationPromise) {
            console.warn('[claude-bridge] RATE_LIMIT_ROTATION_ALREADY_IN_FLIGHT: suppressing duplicate rotation request for active turn');
          } else {
            this.claudeActiveTurnRotationPromise = this.rotateClaudeTokenAndRetryActiveTurn(String(errorMsg), { tokenDead: isTokenDead })
              .finally(() => { this.claudeActiveTurnRotationPromise = null; });
            void this.claudeActiveTurnRotationPromise;
          }
          continue;
        }

        this.flushPendingTools();
        if (this.activeThreadId) {
          this.broadcastToThread(this.activeThreadId, {
            type: 'error',
            execution_id: this.activeThreadId,
            data: parsed.data,
          });
        }

        // SCLI-61: record the failed turn — and possibly rotate, which calls
        // process.exit(1) — BEFORE dispatching the next queued message. A
        // processQueue() ahead of this would hand the next message to a process
        // about to die, losing it. Replay errors are session history, not live
        // turns: never count them toward rotation.
        if (!this.isReplaying) {
          this.recordTurnError(String((parsed.data as Record<string, unknown> | undefined)?.message ?? ''), is529);
        }

        // SCLI-73: a token-quota/429 can arrive with NO active thread — e.g. the
        // injected token is already quota-exhausted at session-start/auth time,
        // so the failure surfaces before any turn opens a thread. The in-thread
        // handler below only requests token rotation when `activeThreadId` is set,
        // so without this the dead token is never cooled and the daemon re-injects
        // it on every container restart (the 2026-06-11 fleet crash-loop). Cool +
        // rotate here too. requestTokenRotation() persists the cooldown and kills
        // the sub-process (one-shot — the process exits), so there's no storm.
        if (isTokenDead && !this.activeThreadId && !this.isReplaying) {
          // Dead credential at startup/auth-time (e.g. injected token's org has
          // Claude Code disabled). Deactivate pool-wide BEFORE rotating so the
          // broker cannot re-lease the same corpse to the restarted container.
          console.error('[claude-bridge] [telemetry] TOKEN_DEAD: dead credential with no active thread (startup/auth-time) — deactivating + rotating');
          void this.reportCurrentClaudeTokenDead(String(errorMsg)).finally(() => {
            this.requestTokenRotation({ persistCooldown: false });
          });
        } else if (is429 && !this.activeThreadId && !this.isReplaying) {
          console.error('[claude-bridge] [telemetry] RATE_LIMITED: 429 with no active thread (startup/auth-time) — requesting token rotation');
          this.requestTokenRotation({ errorMsg: String(errorMsg) });
        } else if (is401 && !this.activeThreadId && !this.isReplaying) {
          // HIVE-143: auth-401 at startup/auth-time (e.g. injected token already
          // expired). Rotate WITHOUT the rate-limit cooldown — the restart's
          // token-refresh path reissues a fresh token; parking it 6h is wrong.
          console.error('[claude-bridge] [telemetry] AUTH_401: expired/invalid token with no active thread (startup/auth-time) — requesting rotation without cooldown');
          this.requestTokenRotation({ persistCooldown: false });
        }

        // Rotation did not fire (or this was a replay) — handle dispatch normally.
        if (this.activeThreadId) {
          // 529 (server overloaded): retry with exponential backoff, max 3 attempts.
          // 429 (rate limit): NEVER auto-retry — API says stop.
          if (is529) {
            this.retryCount529 = (this.retryCount529 ?? 0) + 1;
            const maxRetries = 3;
            if (this.retryCount529 > maxRetries) {
              console.error(`[claude-bridge] [telemetry] 529_EXHAUSTED: ${this.retryCount529} retries failed. Giving up. Message stays unprocessed.`);
              this.retryCount529 = 0;
              this.activeThreadId = null;
              this.activeThreadStartedAt = null;
              this.activeMessageId = null;
              this.activeTurnContent = null;
              this.processQueue();
            } else {
              // Exponential backoff: 60s, 120s, 240s
              const retryDelay = 60000 * Math.pow(2, this.retryCount529 - 1);
              console.log(`[claude-bridge] [telemetry] RETRY_SCHEDULED: 529_overloaded attempt=${this.retryCount529}/${maxRetries} retry_in=${retryDelay}ms`);
              this.activeThreadId = null;
              this.activeThreadStartedAt = null;
              this.activeMessageId = null;
              this.activeTurnContent = null;
              setTimeout(() => {
                console.log(`[claude-bridge] [telemetry] RETRY_EXECUTING: 529 attempt=${this.retryCount529}/${maxRetries}`);
                this.injectMessage('Your previous action failed due to a temporary API overload (529). Please retry the last action now.', { deferIfBusy: true });
              }, retryDelay);
            }
          } else if (isTokenDead) {
            // Dead credential mid-session with no replayable turn content:
            // deactivate pool-wide, then rotate without a cooldown park.
            console.error(`[claude-bridge] [telemetry] TOKEN_DEAD: dead credential mid-session — deactivating + rotating`);
            this.activeThreadId = null;
            this.activeThreadStartedAt = null;
            this.activeMessageId = null;
            void this.reportCurrentClaudeTokenDead(String(errorMsg)).finally(() => {
              this.requestTokenRotation({ persistCooldown: false });
            });
            this.processQueue();
          } else if (is401) {
            // HIVE-143: auth-401 (expired/invalid token) mid-session. Distinct
            // from 429: rotate to refresh the token via restart, but do NOT park
            // it in the 6h rate-limit cooldown — it isn't rate-limited, and the
            // 6h park would wedge the agent + drain the pool of a refreshable token.
            console.error(`[claude-bridge] [telemetry] AUTH_401: expired/invalid token — requesting rotation without cooldown`);
            this.activeThreadId = null;
            this.activeThreadStartedAt = null;
            this.activeMessageId = null;
            this.requestTokenRotation({ persistCooldown: false });
            this.processQueue();
          } else if (is429) {
            console.error(`[claude-bridge] [telemetry] RATE_LIMITED: 429 — requesting token rotation`);
            this.activeThreadId = null;
            this.activeThreadStartedAt = null;
            this.activeMessageId = null;
            this.activeTurnContent = null;
            // Request daemon to restart us with a different OAuth token
            this.requestTokenRotation({ errorMsg: String(errorMsg) });
            this.processQueue();
          } else {
            this.activeThreadId = null;
            this.activeThreadStartedAt = null;
            this.activeMessageId = null;
            this.activeTurnContent = null;
            this.processQueue();
          }
        }
        continue;
      }

      // Proactive events (cron, etc.) — create a thread when events arrive
      // with no active user thread. This handles Claude Code's built-in CronCreate.
      if (!this.activeThreadId && (parsed.type === 'content' || parsed.type === 'tool_start')) {
        this.activeThreadId = crypto.randomUUID();
        this.activeThreadStartedAt = Date.now();
        this.activeTurnLastProgressAt = this.activeThreadStartedAt;
        for (const [, client] of this.clients) {
          client.activeThreadId = this.activeThreadId;
        }
        console.log(`[claude-bridge] Proactive event — created thread ${this.activeThreadId.slice(0, 8)}`);
      }

      // content, reasoning, tool_start, tool_complete — forward to active thread
      if (parsed.type === 'tool_start') {
        // When content arrives between tool_starts, pending tools have completed
        // (Claude Code runs tools then produces content)
        const toolName = (parsed.data?.tool ?? 'tool') as string;
        const toolCallId = (parsed.data?.tool_call_id ?? '') as string;
        let heartbeatIndex: number | undefined;
        if (this.activeTurnIsHeartbeat) {
          heartbeatIndex = this.heartbeatToolCalls.length;
          this.heartbeatToolCalls.push({
            name: toolName,
            input: parsed.data?.input,
          });
          // Keep call/result indices aligned even when Claude omits an explicit
          // result event; empty content is classified as queue-blind.
          this.heartbeatToolResults.push({ content: '', isError: false });
        }
        this.pendingTools.push({
          tool: toolName,
          toolCallId,
          startedAt: Date.now(),
          ...(heartbeatIndex === undefined ? {} : { heartbeatIndex }),
        });
        console.log(`[claude-bridge] [telemetry] tool_exec: ${toolName} at=${new Date().toISOString()}`);
      } else if (parsed.type === 'tool_complete') {
        const toolCallId = (parsed.data?.tool_call_id ?? '') as string;
        const reportedToolName = (parsed.data?.tool ?? '') as string;
        const pendingIndex = toolCallId
          ? this.pendingTools.findIndex((t) => t.toolCallId === toolCallId)
          : this.pendingTools.findIndex((t) => t.tool === reportedToolName);
        const pending = pendingIndex >= 0 ? this.pendingTools[pendingIndex] : undefined;
        const toolCompleteName = pending?.tool || reportedToolName || 'tool';
        const elapsed = pending ? Date.now() - pending.startedAt : 0;
        console.log(`[claude-bridge] [telemetry] tool_done: ${toolCompleteName} elapsed=${elapsed}ms at=${new Date().toISOString()}`);
        if (pending?.heartbeatIndex !== undefined) {
          const output = parsed.data?.output ?? '';
          const isError = parsed.data?.is_error === true;
          this.heartbeatToolResults[pending.heartbeatIndex] = {
            content: output,
            isError,
          };
          if (
            !isError
            && toolCompleteName.endsWith('pulse_get_my_alerts')
            && toolResultHasContent(output)
          ) {
            this.heartbeatPulseAlertsObserved = true;
          }
          if (
            !isError
            && toolCompleteName.endsWith('pulse_get_my_tasks')
            && toolResultHasContent(output)
            && this.heartbeatPulseAlertsObserved
          ) {
            this.heartbeatPulseQueueObserved = true;
          }
        }
        if (pendingIndex >= 0) this.pendingTools.splice(pendingIndex, 1);
        // Tool output stays in the heartbeat classifier only. The legacy bridge
        // never broadcast raw tool-result bodies, so preserve that privacy and
        // activity-log contract while still forwarding completion metadata.
        if (parsed.data) {
          parsed.data.tool = toolCompleteName;
          delete parsed.data.output;
        }
      } else if (parsed.type === 'content' && this.pendingTools.length > 0) {
        // Content after tool_start(s) means all pending tools have finished
        this.flushPendingTools();
      }

      if (this.activeThreadId) {
        this.broadcastToThread(this.activeThreadId, {
          type: parsed.type,
          execution_id: this.activeThreadId,
          data: parsed.data,
        });
      }
    }
  }

  /** Emit synthetic tool_complete for all pending tools. */
  private flushPendingTools(): void {
    if (this.pendingTools.length === 0 || !this.activeThreadId) return;
    const now = Date.now();
    for (const pt of this.pendingTools) {
      this.broadcastToThread(this.activeThreadId, {
        type: 'tool_complete',
        execution_id: this.activeThreadId,
        data: {
          tool: pt.tool,
          duration_ms: now - pt.startedAt,
          is_error: false,
        },
      });
    }
    this.pendingTools = [];
  }

  /** Start a Claude execution — creates thread, acks, and writes to stdin. */
  private startClaudeExecution(clientId: string, content: string, sourceMessageId?: string): void {
    const isConnect = clientId.startsWith('connect:');
    const client = this.clients.get(clientId);
    if (!client && !isConnect) return;

    const threadId = isConnect ? clientId.replace('connect:', '') : crypto.randomUUID();
    const messageId = crypto.randomUUID();
    // Set activeThreadId on ALL connected WS clients so broadcastToThread
    // reaches the daemon's relay WS too (not just the sender).
    for (const [, c] of this.clients) {
      c.activeThreadId = threadId;
    }
    this.activeThreadId = threadId;
    this.activeThreadStartedAt = Date.now();
    this.activeTurnLastProgressAt = this.activeThreadStartedAt;
    this.activeMessageId = messageId;
    this.activeConnectMessageId = isConnect ? (sourceMessageId ?? null) : null;
    this.activeTurnContent = content;
    this.activeTurnIsHeartbeat = false;
    // Direct/control traffic is not governed by a prior heartbeat's
    // turn-scoped queue gate. Any subsequent heartbeat re-arms it on inject.
    this.clearHeartbeatObservationGate();
    this.heartbeatPulseAlertsObserved = false;
    this.heartbeatPulseQueueObserved = false;
    this.heartbeatToolCalls = [];
    this.heartbeatToolResults = [];
    this.activeTurnRateLimitedTokens.clear();

    if (client) {
      this.sendWs(client.ws, {
        type: 'message_ack',
        data: { thread_id: threadId, session_id: this.sessionId },
      });
    }
    this.broadcastToThread(threadId, {
      type: 'session_start',
      execution_id: threadId,
      data: {
        session_id: this.sessionId,
        model: this.opts.model,
        message_id: messageId,
      },
    });
    this.replayHistory.push({
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });

    const ndjsonMsg = buildUserMessage(content, this.sessionId);
    this.claudeProcess!.stdin!.write(ndjsonMsg + '\n');
  }

  /** Select a configured Claude OAuth token that has not failed this active turn. */
  private async pickNextClaudeTokenForActiveTurn(): Promise<{ label: string; token: string } | null> {
    try {
      const { readCredentials } = await import('../config/credentials.js');
      const store = readCredentials();
      const now = Date.now();
      const candidates = (store.anthropic?.tokens ?? [])
        .filter((t: any) => t.active !== false)
        .filter((t: any) => t.token && t.label && !this.activeTurnRateLimitedTokens.has(t.label))
        .filter((t: any) => {
          const inProcessUntil = this.claudeTokenUnavailableUntil.get(t.label) ?? 0;
          if (inProcessUntil > now) return false;
          if (inProcessUntil > 0) this.claudeTokenUnavailableUntil.delete(t.label);
          if (!t.cooldownUntil) return true;
          const until = Date.parse(t.cooldownUntil);
          return !Number.isFinite(until) || until <= now;
        })
        .sort((a: any, b: any) => {
          const tier = (a.priority ?? 1) - (b.priority ?? 1);
          if (tier !== 0) return tier;
          const ar = a.lastRateLimitAt ? Date.parse(a.lastRateLimitAt) : 0;
          const br = b.lastRateLimitAt ? Date.parse(b.lastRateLimitAt) : 0;
          return ar - br;
        });
      const picked = candidates[0];
      return picked ? { label: picked.label, token: picked.token } : null;
    } catch (err) {
      console.error(`[claude-bridge] Failed to select next Claude token: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Report the active Claude token as DEAD (non-refreshable: org disabled
   * Claude Code / grant revoked) so the coordinator deactivates the pool entry
   * (auth_failed, same-fingerprint peers included) and stops leasing it to any
   * agent. Refresh-based health cannot detect this class — serving-time
   * detection here is the only signal (cl2-primary 2026-07-11).
   */
  private async reportCurrentClaudeTokenDead(errorMsg?: string): Promise<void> {
    const label = this.currentTokenLabel;
    if (label) {
      // Keep the local pool from re-picking it this session regardless of
      // whether the broker report lands.
      this.activeTurnRateLimitedTokens.add(label);
      this.claudeTokenUnavailableUntil.set(label, Date.now() + 24 * 3600_000);
    }
    if (!this.currentBrokerModelToken) return;
    try {
      const { reportBrokerModelTokenStatus } = await import('../auth/broker-token.js');
      const ok = await reportBrokerModelTokenStatus(this.currentBrokerModelToken, { action: 'deactivate' }, 5000);
      if (ok) {
        console.error(`[claude-bridge] [telemetry] TOKEN_DEAD: broker deactivated "${label ?? 'unknown'}" pool-wide (${String(errorMsg ?? '').slice(0, 120)})`);
      } else {
        console.error(`[claude-bridge] TOKEN_DEAD report failed for "${label ?? 'unknown'}" — entry stays active in the pool; coordinator health cannot see this failure class`);
      }
    } catch (err) {
      console.error(`[claude-bridge] TOKEN_DEAD report errored for "${label ?? 'unknown'}": ${(err as Error).message}`);
    }
  }

  /** Persist/report the active Claude token cooldown without exiting the bridge. */
  private async reportCurrentClaudeTokenRateLimited(errorMsg?: string): Promise<void> {
    const label = this.currentTokenLabel;
    if (!label) return;
    this.activeTurnRateLimitedTokens.add(label);
    const baseCooldownMs = parseInt(process.env['CLAUDE_BRIDGE_TOKEN_COOLDOWN_MS'] ?? String(60 * 60_000), 10);
    // SCLI-73 follow-up (hana/nao 2026-06-23): a WEEKLY/explicit-reset limit must park
    // the token until its ACTUAL reset, not a flat 1h — else it re-enters rotation while
    // still weekly-exhausted and the pool churns through weekly-dead tokens. Parse the
    // reset clause ("...resets Jun 27, 5pm (UTC)"); for a weekly limit with no parseable
    // time, floor to 12h instead of 1h. retryAfterSeconds (when longer than the base) is
    // sent to BOTH the local cooldown and the daemon (authoritative host pool) report.
    let cooldownMs = Math.max(1, baseCooldownMs);
    let retryAfterSeconds: number | undefined;
    try {
      const { parseQuotaResetMs } = await import('../config/credentials.js');
      const resetMs = parseQuotaResetMs(errorMsg ?? '');
      const isWeekly = typeof errorMsg === 'string' && /weekly limit/i.test(errorMsg);
      if (typeof resetMs === 'number' && resetMs > cooldownMs) cooldownMs = resetMs;
      else if (isWeekly) cooldownMs = Math.max(cooldownMs, 12 * 60 * 60_000);
      if (cooldownMs > baseCooldownMs) retryAfterSeconds = Math.round(cooldownMs / 1000);
    } catch { /* parse helper unavailable — fall back to the flat cooldown */ }
    this.claudeTokenUnavailableUntil.set(label, Date.now() + cooldownMs);

    let brokerReported = false;
    if (this.currentBrokerModelToken) {
      try {
        const { reportBrokerModelTokenStatus } = await import('../auth/broker-token.js');
        brokerReported = await reportBrokerModelTokenStatus(
          this.currentBrokerModelToken,
          { action: 'cool', cooldownSeconds: retryAfterSeconds ?? Math.round(cooldownMs / 1000) },
          5000,
        );
        if (brokerReported) {
          console.log(`[claude-bridge] Broker acknowledged rate-limit report for "${label}" (coordinator cooldown stamped)`);
        } else {
          console.error(`[claude-bridge] Broker rate-limit report failed for "${label}" — falling back to daemon host-pool report`);
        }
      } catch (err) {
        console.error(`[claude-bridge] Broker rate-limit report errored for "${label}": ${(err as Error).message}`);
      }
    }

    try {
      const { reportTokenRateLimited } = await import('../config/credentials.js');
      reportTokenRateLimited(label, retryAfterSeconds);
    } catch (err) {
      console.error(`[claude-bridge] Local cooldown persist failed (${(err as Error).message}) — reporting to daemon`);
    }

    const daemonHost = process.env['DAEMON_HOST'] || 'host.docker.internal';
    const daemonPort = process.env['DAEMON_PORT'] || '8016';
    const url = `http://${daemonHost}:${daemonPort}/v1/providers/anthropic/tokens/${encodeURIComponent(label)}/report-rate-limit`;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source: `agent:${process.env['AGENT_USERNAME'] ?? 'unknown'}`, retryAfterSeconds }),
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`daemon reported ${res.status}`);
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < 3) await sleep(250 * attempt);
      }
    }
    if (!brokerReported) {
      console.error(`[claude-bridge] Daemon rate-limit report failed during in-turn rotation after 3 attempts: ${(lastErr as Error | null)?.message ?? 'unknown error'}`);
    }
  }

  /** PLAT-423: retry the same active turn with every configured Claude token before failing. */
  private async rotateClaudeTokenAndRetryActiveTurn(errorMsg: string, opts: { tokenDead?: boolean } = {}): Promise<void> {
    if (this.claudeActiveTurnRotationInFlight) {
      console.warn('[claude-bridge] RATE_LIMIT_ROTATION_ALREADY_IN_FLIGHT: suppressing duplicate rotation request for active turn');
      return;
    }
    this.claudeActiveTurnRotationInFlight = true;
    const threadId = this.activeThreadId;
    const content = this.activeTurnContent;
    const originalProc = this.claudeProcess;

    try {
      if (!threadId || !content) {
        this.requestTokenRotation({ errorMsg });
        return;
      }

      this.flushPendingTools();
      // Capture the current child before any awaited cooldown-reporting work.
      // Claude may emit both an error line and an error result, or exit while the
      // daemon report is in-flight; that expected old-child exit must not take
      // down the bridge before we can replay with the next token.
      if (originalProc && originalProc.exitCode === null) {
        this.suppressedClaudeExitProc = originalProc;
      }
      if (opts.tokenDead) {
        // Dead credential (org disabled / revoked): deactivate the pool entry
        // instead of stamping a rate-limit cooldown a later recovery would lift.
        await this.reportCurrentClaudeTokenDead(errorMsg);
      } else {
        await this.reportCurrentClaudeTokenRateLimited(errorMsg);
      }

      while (true) {
        const next = await this.pickNextClaudeTokenForActiveTurn();
        if (!next) break;

        console.log(`[claude-bridge] RATE_LIMIT_ROTATE_RETRY: ${this.currentTokenLabel ?? 'unknown'} -> ${next.label}; replaying active turn`);
        process.env['CLAUDE_CODE_OAUTH_TOKEN'] = next.token;
        this.currentTokenLabel = next.label;
        this.initialized = false;
        this.lineBuffer = '';
        this.accumulatedContent = '';
        const oldProc = this.claudeProcess;
        if (oldProc && oldProc.exitCode === null) {
          this.suppressedClaudeExitProc = oldProc;
          this.killClaudeTree(oldProc, 'SIGTERM');
          await Promise.race([
            new Promise<void>((resolve) => oldProc.once('exit', () => resolve())),
            sleep(5000),
          ]);
        }

        try {
          await this.spawnClaude();
          if (!this.claudeProcess?.stdin?.writable) throw new Error('Claude process stdin not writable after token rotation');
          this.claudeProcess.stdin.write(buildUserMessage(content, this.sessionId) + '\n');
          console.log(`[claude-bridge] RATE_LIMIT_RETRY_SENT: token=${next.label} thread=${threadId.slice(0, 8)}`);
          return;
        } catch (err) {
          const msg = (err as Error).message;
          console.error(`[claude-bridge] RATE_LIMIT_RETRY_FAILED: token=${next.label}: ${msg}`);
          // Treat a failed replacement spawn as this token unavailable for this
          // active turn and keep exhausting the remaining pool. A revoked/stale
          // replacement credential must not fail the user while a later token is
          // still healthy.
          this.activeTurnRateLimitedTokens.add(next.label);
          errorMsg = `${errorMsg}; retry with ${next.label} failed: ${msg}`;
          const failedProc = this.claudeProcess;
          if (failedProc && failedProc.exitCode === null) {
            this.suppressedClaudeExitProc = failedProc;
            this.killClaudeTree(failedProc, 'SIGTERM');
          }
          this.claudeProcess = null;
        }
      }

      console.error('[claude-bridge] RATE_LIMIT_EXHAUSTED: all configured Claude tokens failed this turn');
      this.broadcastToThread(threadId, {
        type: 'error', execution_id: threadId,
        data: { message: `All configured Claude tokens are rate-limited or unavailable. Last error: ${errorMsg}` },
      });
      this.broadcastToThread(threadId, {
        type: 'complete', execution_id: threadId,
        data: { result: { total_turns: this.turnCount, input_tokens: this.totalInputTokens, output_tokens: this.totalOutputTokens } },
      });
      this.activeThreadId = null;
      this.activeThreadStartedAt = null;
      this.activeMessageId = null;
      this.activeTurnContent = null;
      this.activeTurnRateLimitedTokens.clear();
      const exhaustedProc = this.claudeProcess;
      if (exhaustedProc && exhaustedProc.exitCode === null) {
        this.suppressedClaudeExitProc = exhaustedProc;
        this.killClaudeTree(exhaustedProc, 'SIGTERM');
      }
      this.claudeProcess = null;
      // B1 fix: do not stay alive with claudeProcess=null and initialized=true —
      // that leaves the bridge permanently wedged (no queue drain, no recovery path).
      // Exit so the daemon restarts this container. The daemon's getActiveClaudeToken()
      // respects cooldowns written via reportCurrentClaudeTokenRateLimited, so the
      // fresh container picks a non-cooled token or marks agent provider_down if all
      // tokens are still in their cooldown window.
      console.error('[claude-bridge] RATE_LIMIT_EXHAUSTED: all tokens exhausted — exiting for daemon restart');
      process.exit(1);
    } finally {
      this.claudeActiveTurnRotationInFlight = false;
    }
  }

  /**
   * Rotate off the current OAuth token by restarting the container.
   *
   * @param opts.persistCooldown When true (default), the 429 path: persist this
   *   token's rate-limit cooldown locally + on the host pool so future spawns skip
   *   it. When false (HIVE-143 auth-401 path), skip the cooldown entirely — the
   *   token is expired, not rate-limited, so it must NOT be parked for 6h; the
   *   restart's token-refresh reissues it. Either way the sub-process is killed so
   *   the daemon respawns the container with a freshly-picked/refreshed token.
   */
  private requestTokenRotation(opts: { persistCooldown?: boolean; errorMsg?: string } = {}): void {
    const persistCooldown = opts.persistCooldown !== false;
    // SCLI-73 follow-up (hana/nao 2026-06-23): derive a reset-aware cooldown so a
    // WEEKLY-exhausted token is parked until its real reset, not a flat 1h (which would
    // re-expose it on the next restart and churn the pool). Mirrors the active-turn path.
    let retryAfterSeconds: number | undefined;
    try {
      const { parseQuotaResetMs } = require('../config/credentials.js');
      const resetMs = parseQuotaResetMs(opts.errorMsg ?? '');
      const isWeekly = typeof opts.errorMsg === 'string' && /weekly limit/i.test(opts.errorMsg);
      if (typeof resetMs === 'number' && resetMs > 60 * 60_000) retryAfterSeconds = Math.round(resetMs / 1000);
      else if (isWeekly) retryAfterSeconds = 12 * 60 * 60; // 12h floor when reset clause is unparseable
    } catch { /* fall back to the default cooldown */ }
    // What actually happens on 429 (persistCooldown=true):
    //   1. Persist this token's cooldown so future spawns (this container
    //      AND sibling agents) skip it until the window expires.
    //   2. Probe which token the pool would pick next (log-only — we do
    //      not swap in-place; see step 3).
    //   3. Kill the Claude Code sub-process. That propagates to our exit
    //      handler (line 590) which calls `process.exit(1)`. The daemon
    //      sees a non-zero, non-42 exit and restarts the container in 5s.
    //      The fresh container gets the freshly-picked token from
    //      `manager.ts:getActiveClaudeToken()` — same picker, cooldown-
    //      aware, so cl1_alt is guaranteed skipped.
    //
    // We do not try to swap `process.env['CLAUDE_CODE_OAUTH_TOKEN']` and
    // respawn Claude Code in-process: Claude Code was forked with the old
    // env at startup, and the parent env mutation wouldn't reach it
    // anyway. Container-level respawn is the only mechanism that works.
    if (!this.currentTokenLabel) {
      // Unknown current token — can't persist cooldown, but we can still
      // let the daemon cycle the container for a fresh pick.
      console.error('[claude-bridge] Rate-limited but current token label unknown — forcing container restart');
      if (this.claudeProcess && this.claudeProcess.exitCode === null) {
        this.killClaudeTree(this.claudeProcess, 'SIGTERM');
      }
      return;
    }

    // HIVE-143/HIVE-122: auth-401 path (persistCooldown=false) — the token is
    // auth-invalid (bad key or expired), not rate-limited. Do NOT add it to the
    // cooldown set or persist a local rate-limit cooldown. Instead, mark it dead
    // (active=false) in the host pool via report-invalid so the daemon never
    // re-injects it on the next restart. Then restart; a fresh token is picked.
    if (!persistCooldown) {
      console.log(`[claude-bridge] Auth-401 rotation for "${this.currentTokenLabel}" — marking token invalid in host pool, then restarting`);
      // Mark dead in the host pool (HIVE-122). Fire-and-forget with 3 retries;
      // the kill-and-restart below is not gated on this succeeding.
      void (async () => {
        const daemonHost = process.env['DAEMON_HOST'] || 'host.docker.internal';
        const daemonPort = process.env['DAEMON_PORT'] || '8016';
        const url = `http://${daemonHost}:${daemonPort}/v1/providers/anthropic/tokens/${encodeURIComponent(this.currentTokenLabel!)}/report-invalid`;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ source: `agent:${process.env['AGENT_USERNAME'] ?? 'unknown'}` }),
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              console.log(`[claude-bridge] Daemon marked "${this.currentTokenLabel}" auth-invalid (active=false in host pool)`);
              return;
            }
            console.error(`[claude-bridge] Daemon report-invalid HTTP ${res.status} (attempt ${attempt + 1}/3)`);
          } catch (err) {
            console.error(`[claude-bridge] Daemon report-invalid failed (attempt ${attempt + 1}/3): ${(err as Error).message}`);
          }
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      })();
    } else {
      this.rateLimitedTokens.add(this.currentTokenLabel);
      let nextLabel = 'unknown';
      let persisted = false;
      try {
        const { reportTokenRateLimited, getActiveClaudeToken, getClaudeTokenPoolSummary } = require('../config/credentials.js');
        persisted = reportTokenRateLimited(this.currentTokenLabel, retryAfterSeconds);
        const next = getActiveClaudeToken(this.currentTokenLabel);
        nextLabel = next?.label ?? '(pool empty)';
        const poolSummary = getClaudeTokenPoolSummary(this.currentTokenLabel);
        console.log(`[claude-bridge] Token pool at rotation: total=${poolSummary.total} enabled=${poolSummary.enabled} fresh=${poolSummary.fresh} onCooldown=${poolSummary.onCooldown} nextPick=${poolSummary.nextLabel ?? 'none'}`);
      } catch (err) {
        // Expected inside agent containers: credentials.json is a READ-ONLY
        // mount, so the local write throws EROFS. The daemon owns the host
        // pool — report through its API below (SCLI-73).
        console.error(`[claude-bridge] Local cooldown persist failed (${(err as Error).message}) — reporting to daemon`);
      }
      if (this.currentBrokerModelToken) {
        const brokerLease = this.currentBrokerModelToken;
        const label = this.currentTokenLabel;
        void (async () => {
          try {
            const { reportBrokerModelTokenStatus } = await import('../auth/broker-token.js');
            const ok = await reportBrokerModelTokenStatus(
              brokerLease,
              { action: 'cool', cooldownSeconds: retryAfterSeconds ?? 60 * 60 },
              5000,
            );
            if (ok) {
              console.log(`[claude-bridge] Broker acknowledged rate-limit report for "${label}" (coordinator cooldown stamped)`);
            } else {
              console.error(`[claude-bridge] Broker rate-limit report failed for "${label}" — daemon host-pool report will be attempted`);
            }
          } catch (err) {
            console.error(`[claude-bridge] Broker rate-limit report errored for "${label}": ${(err as Error).message}`);
          }
        })();
      }
      // Report to the daemon so the cooldown lands in the HOST token pool —
      // the one manager.ts actually picks from on container restart. Without
      // this, the daemon re-injects the same dead token forever (the cl3
      // fleet-wide crash loop of 2026-06-11). Fire both paths; the daemon
      // endpoint is the one that matters in container mode.
      void (async () => {
        const daemonHost = process.env['DAEMON_HOST'] || 'host.docker.internal';
        const daemonPort = process.env['DAEMON_PORT'] || '8016';
        const url = `http://${daemonHost}:${daemonPort}/v1/providers/anthropic/tokens/${encodeURIComponent(this.currentTokenLabel!)}/report-rate-limit`;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ source: `agent:${process.env['AGENT_USERNAME'] ?? 'unknown'}`, retryAfterSeconds }),
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              console.log(`[claude-bridge] Daemon acknowledged rate-limit report for "${this.currentTokenLabel}" (host pool cooldown stamped)`);
              return;
            }
            console.error(`[claude-bridge] Daemon rate-limit report HTTP ${res.status} (attempt ${attempt + 1}/3)`);
          } catch (err) {
            console.error(`[claude-bridge] Daemon rate-limit report failed (attempt ${attempt + 1}/3): ${(err as Error).message}`);
          }
          await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        }
      })();
      console.log(
        `[claude-bridge] Token "${this.currentTokenLabel}" rate-limited ` +
        `(local persist=${persisted}); next container restart will pick "${nextLabel}"`,
      );
    }

    if (this.claudeProcess && this.claudeProcess.exitCode === null) {
      this.killClaudeTree(this.claudeProcess, 'SIGTERM');
      return;
    }

    // Step 2: All tokens exhausted — try next claude model in failover chain
    const claudeSteps = this.failoverChain.filter(s =>
      s.method === 'claude_code_server' && s.model !== this.opts.model
    );
    const nextClaude = claudeSteps[this.failoverChainIndex];
    if (nextClaude) {
      this.failoverChainIndex++;
      console.log(`[claude-bridge] All tokens exhausted for ${this.opts.model}. Switching to ${nextClaude.model}`);
      this.opts.model = nextClaude.model;
      this.rateLimitedTokens.clear(); // Reset tokens for new model
      if (this.claudeProcess && this.claudeProcess.exitCode === null) {
        this.killClaudeTree(this.claudeProcess, 'SIGTERM');
      }
      return;
    }

    // Step 3: All claude models + tokens exhausted — signal daemon for cross-method failover.
    // Re-check the pool one last time: tokens may have cooled down since we started
    // the daemon report loop (up to ~7s elapsed). If a fresh token is now available,
    // kill the sub-process instead so the daemon restarts with it.
    try {
      const { getActiveClaudeToken } = require('../config/credentials.js');
      const freshNow = getActiveClaudeToken(this.currentTokenLabel ?? undefined);
      if (freshNow && !this.rateLimitedTokens.has(freshNow.label)) {
        console.log(`[claude-bridge] Pool re-check: fresh token "${freshNow.label}" available — restarting container instead of exit 42`);
        if (this.claudeProcess && this.claudeProcess.exitCode === null) {
          this.killClaudeTree(this.claudeProcess, 'SIGTERM');
        } else {
          setTimeout(() => process.exit(1), 500);
        }
        return;
      }
    } catch { /* ignore — proceed to exit 42 */ }
    console.error('[claude-bridge] ALL claude models and tokens exhausted. Requesting cross-method failover (exit 42).');
    // Mark agent unavailable in Pulse before exiting so the availability sweep
    // does not race against the process exit (SCLI-92). Fire-and-forget; the
    // 1s delay before exit gives this call time to land.
    void this.markAgentAvailability(false, 'claude-token-pool-exhausted');
    // Give time for cleanup, then exit with failover code
    setTimeout(() => process.exit(42), 1000);
  }

  private injectMessage(content: string, opts?: { deferIfBusy?: boolean }): void {
    // PLAT-297: defense-in-depth guard — never overwrite an active turn's state.
    // fireHeartbeat already guards, but the 529-retry setTimeout path can fire
    // after a new Connect/WS message has already claimed activeThreadId.
    // Injecting over an active turn corrupts response routing.
    if (this.activeThreadId) {
      if (opts?.deferIfBusy) {
        // 529-retry path: a new message claimed the turn during the backoff
        // window. The retry MUST NOT be silently dropped (that loses the failed
        // user turn). Defer it: re-arm a short re-check timer and inject once
        // activeThreadId clears. Bounded so a permanently-busy bridge can't spin
        // forever — on exhaustion we log loudly rather than fail silently.
        const attempts = (this.pendingRetryInject?.attempts ?? 0) + 1;
        const maxDeferChecks = 60; // 60 × 5s ≈ 5 min ceiling
        if (attempts > maxDeferChecks) {
          // PLAT-385: don't silently drop — leave pendingRetryInject set so
          // processQueue() delivers it on the next natural turn-completion.
          // The content is preserved; attempts resets to 0 for a clean re-check
          // window in the (unlikely) event activeThreadId is still held.
          console.error(`[claude-bridge] [telemetry] 529_RETRY_DEFER_EXHAUSTED: turn stayed active for ${maxDeferChecks} re-checks (~5min); will inject on next turn-completion`);
          this.pendingRetryInject = { content, attempts: 0 };
          return;
        }
        this.pendingRetryInject = { content, attempts };
        console.log(`[claude-bridge] injectMessage deferred — turn in progress, re-arming 529 retry re-check (attempt=${attempts}/${maxDeferChecks})`);
        this.retryInjectTimer = setTimeout(() => this.injectMessage(content, opts), 5000);
        return;
      }
      // Heartbeat / non-retry path: plain skip — a fresh trigger will follow.
      console.log(`[claude-bridge] injectMessage skipped — turn in progress (thread=${this.activeThreadId.slice(0, 8)}…)`);
      return;
    }

    if (!this.claudeProcess?.stdin?.writable) {
      console.error('[claude-bridge] Cannot inject message — Claude process stdin not writable');
      return;
    }

    // We're injecting now — cancel any outstanding re-check timer and clear the
    // deferred-retry state so a stale timer can't fire a double-inject (P1 fix).
    if (this.retryInjectTimer !== null) {
      clearTimeout(this.retryInjectTimer);
      this.retryInjectTimer = null;
    }
    this.pendingRetryInject = null;

    const threadId = `retry-${Date.now()}`;
    this.activeThreadId = threadId;
    this.activeThreadStartedAt = Date.now();
    this.activeTurnLastProgressAt = this.activeThreadStartedAt;
    this.activeMessageId = crypto.randomUUID();
    this.activeTurnIsHeartbeat = isHeartbeatTrigger(content);
    if (this.activeTurnIsHeartbeat) {
      if (content.trim() === HEARTBEAT_TRIGGER.trim()) {
        this.heartbeatObservationRetryCount = 0;
      }
      this.armHeartbeatObservationGate();
      this.heartbeatPulseAlertsObserved = false;
      this.heartbeatPulseQueueObserved = false;
      this.heartbeatToolCalls = [];
      this.heartbeatToolResults = [];
    }

    const ndjsonMsg = buildUserMessage(content, this.sessionId);
    this.claudeProcess.stdin.write(ndjsonMsg + '\n');
    console.log(`[claude-bridge] [telemetry] MESSAGE_INJECTED: thread=${threadId} len=${content.length}`);
  }

  /** Process the next queued message after current execution completes. */
  private processQueue(): void {
    if (this.activeThreadId) return;
    if (this.runtimeRollDrain.ready) return;

    const runtimeRollDraining = this.runtimeRollDrain.active;
    const action = selectClaudeBridgeQueueAction(
      this.messageQueue,
      this.pendingRetryInject !== null,
      runtimeRollDraining ? false : this.heartbeatPending,
    );
    if (action.kind === 'idle') {
      if (runtimeRollDraining) {
        this.connectClient?.stop();
        this.runtimeRollConnectStopped = true;
        this.runtimeRollDrain.markReady();
      }
      return;
    }
    if (action.kind === 'retry') {
      // PLAT-385: a failed user turn remains the absolute first boundary
      // action, ahead of new direct traffic and autonomous scheduling.
      const retry = this.pendingRetryInject;
      if (!retry) return;
      this.injectMessage(retry.content, { deferIfBusy: true });
      return;
    }
    if (action.kind === 'heartbeat') {
      if (!this.claudeProcess?.stdin?.writable) return;
      const prompt = this.heartbeatObservationRetryPending
        ? CLAUDE_HEARTBEAT_OBSERVATION_RETRY_TRIGGER
        : HEARTBEAT_TRIGGER;
      this.heartbeatPending = false;
      this.heartbeatObservationRetryPending = false;
      this.injectMessage(prompt);
      console.log(`[claude-bridge] [telemetry] heartbeat at=${new Date().toISOString()}`);
      return;
    }

    const [next] = this.messageQueue.splice(action.index, 1);
    if (!next) return;
    const isConnect = next.clientId.startsWith('connect:');
    if (!isConnect) {
      const client = this.clients.get(next.clientId);
      if (!client || client.ws.readyState !== WebSocket.OPEN) {
        // Client disconnected — skip and try next
        this.processQueue();
        return;
      }
    }

    if (next.messageId) this.startClaudeExecution(next.clientId, next.content, next.messageId);
    else this.startClaudeExecution(next.clientId, next.content);
  }

  private broadcastToThread(threadId: string, msg: Record<string, unknown>): void {
    // HIVE-609: mirror tool events to .shizuha/.audit-log.jsonl (Hive's activity feed).
    this.recordActivity(msg);
    // Send to WS clients (dashboard/mobile)
    for (const [_, client] of this.clients) {
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
      const tool = String(data.tool ?? data.name ?? '');
      const callId = String(data.tool_call_id ?? '');
      if (msg.type === 'tool_start' && tool) {
        this.activityLog.toolCall(tool, data.input ?? '');
      } else if (msg.type === 'tool_complete' && tool) {
        this.activityLog.toolResult(callId, tool, data.output ?? (data.is_error ? 'error' : 'ok'), Boolean(data.is_error), data.duration_ms as number | undefined);
      }
    } catch { /* best-effort */ }
  }

  private sendWs(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  private async startServer(): Promise<void> {
    this.app = Fastify({ logger: false });
    await this.app.register(cors, { origin: true });

    // Health endpoint
    this.app.get('/health', async () => ({
      ...this.buildHealthResponse(),
      runtimeRollDrain: this.runtimeRollDrain.snapshot(
        this.activeThreadId !== null,
        this.messageQueue.length + (this.pendingRetryInject ? 1 : 0),
      ),
    }));

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
        this.processQueue();
        return this.runtimeRollDrain.snapshot(
          this.activeThreadId !== null,
          this.messageQueue.length + (this.pendingRetryInject ? 1 : 0),
        );
      },
    );

    // Proactive message injection — cron MCP server POSTs here to deliver messages
    this.app.post<{ Body: { text: string; type?: string; jobName?: string } }>('/v1/proactive', async (request) => {
      if (this.runtimeRollDrain.ready) {
        return { ok: false, retryable: true, error: 'runtime_roll_draining' };
      }
      const { text, jobName } = request.body ?? {};
      if (!text) return { ok: false, error: 'text required' };
      const threadId = crypto.randomUUID();
      for (const [, client] of this.clients) {
        client.activeThreadId = threadId;
        this.sendWs(client.ws, { type: 'content', execution_id: threadId, data: { delta: text } });
        this.sendWs(client.ws, { type: 'complete', execution_id: threadId, data: { result: { proactive: true } } });
        client.activeThreadId = null;
      }
      console.log(`[claude-bridge] Proactive delivery: "${text.slice(0, 80)}"`);
      return { ok: true };
    });

    await this.app.listen({ port: this.opts.port, host: this.opts.host });

    // WebSocket server on /ws/chat/ (same path as gateway)
    const server = this.app.server;
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/ws/chat' || url.pathname === '/ws/chat/') {
        this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
          this.wss!.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = crypto.randomUUID();
      const client: WsClient = { ws, userId: 'localhost', activeThreadId: null };
      this.clients.set(clientId, client);

      console.log(JSON.stringify({
        level: 30,
        time: Date.now(),
        pid: process.pid,
        hostname: os.hostname(),
        userId: 'localhost',
        msg: 'WebSocket client connected',
      }));

      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWsMessage(clientId, msg);
        } catch { /* ignore malformed */ }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });

      ws.on('error', () => {
        this.clients.delete(clientId);
      });

      // Send connected status
      this.sendWs(ws, { type: 'transport_status', connected: true });
    });

    // Ping interval
    setInterval(() => {
      for (const [_, client] of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try { client.ws.ping(); } catch { /* ignore */ }
        }
      }
    }, 30_000);
  }

  private handleWsMessage(clientId: string, msg: Record<string, unknown>): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const type = msg.type as string;

    switch (type) {
      case 'ping':
        this.sendWs(client.ws, { type: 'pong' });
        break;

      case 'subscribe':
        // Just acknowledge — single agent bridge
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

        if (!this.initialized || !this.claudeProcess?.stdin?.writable) {
          this.sendWs(client.ws, { type: 'error', data: { message: 'Claude process not ready' } });
          break;
        }

        // If already executing, queue the message — it'll be processed when the current one completes.
        if (this.activeThreadId) {
          const result = this.enqueueMessage(clientId, content);
          this.sendWs(client.ws, {
            type: result.queued ? 'message_ack' : 'error',
            data: result.queued
              ? { queued: true, session_id: this.sessionId }
              : { message: `Bridge queue is not accepting this message (${result.reason ?? 'queue-full'})` },
          });
          break;
        }

        this.startClaudeExecution(clientId, content);
        break;
      }

      case 'sync':
        // Return replay history from resumed session
        this.sendWs(client.ws, {
          type: 'sync_history',
          session_id: this.sessionId,
          messages: this.replayHistory.map((m, i) => ({
            id: m.id ?? `replay-${i}`,
            role: m.role,
            content: m.content,
            created_at: m.createdAt,
          })),
        });
        break;

      case 'create_session':
        this.sendWs(client.ws, {
          type: 'session_created',
          session_id: this.sessionId,
          agent: {
            name: this.opts.agentName ?? 'Claude Code',
            id: this.opts.agentId ?? 'claude-bridge',
          },
        });
        break;

      case 'stream_ack':
      case 'cancel':
        break;
    }
  }

  // ── Session persistence helpers ──

  private tryParseJson(line: string): Record<string, unknown> | null {
    try {
      const trimmed = line.trim();
      if (!trimmed) return null;
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private getSessionIdFile(): string {
    // Store in workspace dir (persistently mounted) — not home dir (ephemeral in containers)
    const workDir = this.opts.cwd ?? process.cwd();
    return path.join(workDir, '.claude-session-id');
  }

  /** SCLI-61: record a failed live turn; rotate the session when a consecutive
   * run crosses the threshold for its error class (see POLICY_REFUSAL_RE). */
  private recordTurnError(message: string, transientOverload = false): void {
    this.errorTurnsTotal++;
    // Telemetry: keep a bounded ring of recent errors + push a snapshot now so the
    // platform sees issues proactively (transient 529s included, flagged below).
    this.recentErrors.push({
      ts: Date.now(),
      level: transientOverload ? 'warn' : 'error',
      msg: String(message).slice(0, 300),
    });
    if (this.recentErrors.length > 20) this.recentErrors.shift();
    this.emitTelemetry();
    // SCLI-61 (architect review): a 529 "overloaded" is a transient PROVIDER
    // outage, not a context-poisoned session — it's explicitly NOT
    // deterministic-on-context, and the bounded 529 retry path already handles
    // it (re-injecting the same prompt up to 3×). Counting it toward the
    // consecutive rotation counter would let a single overloaded prompt add ~4
    // errors, so ~3 overloaded prompts could hit ERROR_ROTATE_AFTER and archive
    // a HEALTHY session — rotation can't fix a provider outage, it only burns
    // working memory and the 6h cooldown then masks a real wedge. Track it in
    // the cumulative telemetry total but never the consecutive/rotation counter.
    if (transientOverload) return;
    this.consecutiveErrorTurns++;
    // SCLI-61: classify into the two deterministic-on-context wedge classes
    // (policy-refusal, 1M-context-credit — both cured by rotating to a fresh
    // session, fast threshold) vs generic transient API errors (slow threshold).
    const isPolicyRefusal = POLICY_REFUSAL_RE.test(message);
    const isContextCredit = !isPolicyRefusal && CONTEXT_CREDIT_RE.test(message);
    if (isPolicyRefusal) this.policyRefusalsTotal++;
    if (isContextCredit) this.contextCreditErrorsTotal++;
    let kind: string, threshold: number;
    if (isPolicyRefusal) { kind = 'policy-refusal'; threshold = POLICY_ROTATE_AFTER; }
    else if (isContextCredit) { kind = 'context-credit-1M'; threshold = CONTEXT_ROTATE_AFTER; }
    else { kind = 'api-error'; threshold = ERROR_ROTATE_AFTER; }
    console.error(
      `[claude-bridge] turn error (${this.consecutiveErrorTurns} consecutive, ` +
      `${kind}, rotate at ${threshold}): ${message.slice(0, 200)}`,
    );
    if (this.consecutiveErrorTurns >= threshold) {
      const reason = isPolicyRefusal ? 'policy-refusal'
        : isContextCredit ? 'context-credit-1M' : 'persistent-api-error';
      this.rotateWedgedSession(reason, message);
    }
  }

  /** SCLI-61: the persisted session is poisoned — every turn fails and resuming
   * it can never recover (restart alone re-loads the same context; recovery for
   * ryo on 2026-06-10 required archiving the session). Archive the stored
   * session pointer (transcripts stay on disk as evidence) and exit non-zero:
   * the daemon supervisor restarts the bridge in ~5s, and with no stored
   * session id it starts a FRESH session — the manual mitigation, automated. */
  private rotateWedgedSession(reason: string, lastMessage: string): void {
    if (this.rotationAttemptedThisRun) return;
    const sessionFile = this.getSessionIdFile();
    const markerFile = `${sessionFile}.rotated-at`;
    // Cooldown guard: a fresh session that wedges again means the failure
    // follows the inbound work, not the persisted context — rotating again
    // only destroys more context in a loop. Stay up (visible via /health
    // errorTurns/policyRefusals) and leave the session for an operator.
    // NOTE: the rotationAttemptedThisRun flag is set only AFTER this guard
    // passes — an early cooldown return must NOT permanently disable rotation
    // for the rest of this process's life (the window can expire while we run).
    try {
      const last = parseInt(fs.readFileSync(markerFile, 'utf-8').trim(), 10);
      if (Number.isFinite(last) && Date.now() - last < ROTATE_COOLDOWN_MS) {
        console.error(
          `[claude-bridge] SESSION-WEDGED-AGAIN within cooldown (${reason}) — NOT rotating; ` +
          `a fresh session also fails, needs operator attention. last error: ${lastMessage.slice(0, 300)}`,
        );
        return;
      }
    } catch { /* no marker — first rotation, proceed */ }
    // Cooldown passed (or first ever rotation) — commit to rotating exactly once
    // this run; we exit(1) below so the daemon respawns with a fresh session.
    this.rotationAttemptedThisRun = true;
    console.error(
      `[claude-bridge] SESSION-ROTATED: ${this.consecutiveErrorTurns} consecutive failed turns (${reason}); ` +
      `archiving session pointer and restarting fresh (SCLI-61). last error: ${lastMessage.slice(0, 300)}`,
    );
    try {
      if (fs.existsSync(sessionFile)) {
        // Archive the POINTER — breaking resumption is what un-wedges the
        // bridge; the transcript files stay on disk untouched as evidence.
        fs.renameSync(sessionFile, `${sessionFile}.wedged-bak-${Date.now()}`);
      }
      fs.writeFileSync(markerFile, String(Date.now()));
    } catch (e) {
      console.error(`[claude-bridge] session rotation: failed to archive pointer: ${(e as Error).message}`);
    }
    process.exit(1);
  }

  private loadStoredSessionId(filePath: string): string | null {
    try {
      if (fs.existsSync(filePath)) {
        const id = fs.readFileSync(filePath, 'utf-8').trim();
        // Validate UUID format
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)) {
          return id;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private saveSessionId(sessionId: string): void {
    try {
      const filePath = this.getSessionIdFile();
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, sessionId);
    } catch (e) {
      console.error(`[claude-bridge] Failed to save session ID: ${(e as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.runtimeRollDrain.dispose();
    if (this.claudeProcess && !this.claudeProcess.killed) {
      this.killClaudeTree(this.claudeProcess, 'SIGTERM');
    }
    if (this.wss) {
      this.wss.close();
    }
    if (this.app) {
      await this.app.close();
    }
  }
}

/** Entry point — called from CLI command. */
export async function startClaudeBridge(opts: ClaudeBridgeOptions): Promise<void> {
  console.log(
    `[claude-bridge] Startup summary: ${JSON.stringify({
      agentId: opts.agentId,
      agentUsername: opts.agentUsername,
      model: opts.model,
      contextPrompt: summarizePromptForLog(opts.contextPrompt),
    })}`,
  );
  if (isBridgePromptDebugEnabled() && opts.contextPrompt?.trim()) {
    console.log(`[claude-bridge] Context prompt begin\n${opts.contextPrompt}\n[claude-bridge] Context prompt end`);
  }


  // Tee stdout/stderr to a persistent log file outside the --rm container,
  // so bridge logs survive restarts. CLAUDE_BRIDGE_LOG_FILE is injected by
  // manager.ts as /var/log/shizuha/bridges/bridge-<username>.log.
  const bridgeLogFile = process.env['CLAUDE_BRIDGE_LOG_FILE'];
  if (bridgeLogFile) {
    let logFd: number | undefined;
    try {
      const fs = await import('fs');
      const path = await import('path');
      fs.mkdirSync(path.dirname(bridgeLogFile), { recursive: true, mode: 0o700 });
      logFd = fs.openSync(bridgeLogFile, 'a', 0o600);
      const orig = { write: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
      const tee = (chunk: unknown, _enc?: unknown, cb?: unknown) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        try { fs.writeSync(logFd!, buf); } catch { /* ignore write errors */ }
        return true;
      };
      process.stdout.write = (chunk, enc?, cb?) => { tee(chunk); return orig.write(chunk, enc as BufferEncoding, cb as () => void); };
      process.stderr.write = (chunk, enc?, cb?) => { tee(chunk); return orig.err(chunk, enc as BufferEncoding, cb as () => void); };
    } catch (e) {
      console.error(`[claude-bridge] Failed to open bridge log file ${bridgeLogFile}: ${(e as Error).message}`);
    }
  }

  const bridge = new ClaudeBridge(opts);

  process.on('SIGTERM', async () => {
    console.log('[claude-bridge] Received SIGTERM, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[claude-bridge] Received SIGINT, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  await bridge.start();

  // Keep alive
  await new Promise<void>(() => {});
}
