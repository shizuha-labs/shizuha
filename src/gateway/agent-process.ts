/**
 * Agent Process — the core runtime loop.
 *
 * Models the agent as a persistent entity with one eternal session.
 * Messages arrive from channels via the inbox, are processed sequentially,
 * and responses stream back to the originating channel.
 *
 * Like a human:
 * - One brain (session) with continuous memory
 * - Messages from many sources (channels)
 * - Processed one at a time
 * - Responds on the same medium the message arrived on
 * - Remembers everything (with compaction as forgetting)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentEvent } from '../events/types.js';
import type { Message, ContentBlock, MCPServerConfig } from '../agent/types.js';
import type { ToolDefinition } from '../tools/types.js';
import type { PermissionMode } from '../permissions/types.js';
import type { LLMProvider } from '../provider/types.js';
import type { Channel, ChannelType, InboundMessage, GatewayConfig } from './types.js';
import { DEFAULT_FAN_OUT } from './types.js';
import { Inbox } from './inbox.js';
import { DeliveryQueue } from './delivery-queue.js';
import { MaintenanceReaper } from './reaper.js';
import { BackgroundTaskRegistry } from '../tasks/registry.js';
import { isCortexModelId } from '../provider/registry.js';
import {
  HIVE_XAI_GROK_MODEL,
  hiveDirectXaiUpstreamModel,
  isHiveDirectXaiGrokModel,
  leaseHiveXaiAccess,
  type HiveXaiLease,
} from '../auth/xai-broker.js';
import { isTransientProviderFailure } from '../provider/transient-errors.js';
import type { HookEngine } from '../hooks/engine.js';
import { CronStore } from '../cron/store.js';
import { CronScheduler } from '../cron/scheduler.js';
import { setCronStore, setCronDelivery } from '../tools/builtin/cron.js';
import { SkillSearchEngine } from '../skills/search-engine.js';
import { setSkillSearchEngine } from '../tools/builtin/skill-search.js';
import { MemoryIndex, openAiEmbeddingKeyFromEnv } from '../memory/index.js';
import { setMemoryIndex } from '../tools/builtin/memory-index.js';
import { LoopDetector } from '../agent/loop-detector.js';
import {
  ExpensiveTurnGuard,
  expensiveTurnGuardConfigFromEnv,
  expensiveTurnGuardNotifyUsername,
  type ExpensiveTurnGuardDecision,
} from '../agent/expensive-turn-guard.js';
import { RateLimiter } from './rate-limiter.js';
import { UsageTracker } from './usage-tracker.js';
import { setUsageTracker } from '../tools/builtin/usage.js';
import { AutoReplyEngine } from './auto-reply.js';
import { logger } from '../utils/logger.js';
import { AuditLogger } from '../security/audit.js';
import { loadOrCreateAgentKeypair, type Keypair } from '../crypto/identity.js';
import { setAuditLogger } from '../tools/builtin/audit-log.js';
import { SpanTracker } from '../telemetry/spans.js';
import { sendConnectDm } from '../platform/connect-dm.js';
import { TurnTelemetryWindow, recordTurnTelemetry } from '../telemetry/turn-telemetry.js';
import {
  ActivityPhaseTracker,
  applyAgentEventToPhase,
  buildActivityTelemetry,
  createTelemetryFlusher,
} from '../telemetry/activity-phase.js';
import {
  formatHeartbeatQueueDrainOutcomeLogLine,
  getHeartbeatQueueDrainOutcome,
  heartbeatQueueDrainTelemetry,
  recordHeartbeatQueueDrainTurn,
  recordObservedEmptyPulseQueue,
  type HeartbeatQueueDrainOutcome,
} from '../shared/heartbeat-outcome.js';
import { setActiveTelemetryWindow, createTurnTelemetrySink } from '../agent/loop.js';
import { incompleteTurnError } from '../agent/incomplete-turn.js';
import {
  estimateOverheadTokens,
  estimateTokens,
  getSafetyFactor,
  effectiveContextTokens,
} from '../prompt/context.js';
import { countTokens } from '../utils/tokens.js';
import { modelSupportsAppendOnlyToolActivation } from '../tools/tool-search.js';
import {
  DEFAULT_FIRST_HEARTBEAT_MS,
  LEAN_FIRST_HEARTBEAT_MS,
  DEFAULT_HEARTBEAT_DEBOUNCE_MS,
  DEFAULT_IDLE_HEARTBEAT_MS,
  LEAN_CONVERSATIONAL_MCP_TOOL_NAMES,
  isLeanConversationalEnv,
  leanConversationalSkillNames,
  talkSeatSuppressesTools,
  talkSeatTurnTimeoutMs,
} from '../platform/lean-conversational.js';
import { estimatePromptTokenBudget, heartbeatBudgetConfig } from '../agent/heartbeat-hygiene.js';
import {
  buildProviderPrefixSnapshot,
  compareProviderPrefixSnapshots,
  diffSystemPromptSections,
  hashSystemPromptSections,
  providerPrefixContinuityLogFields,
  providerPrefixContinuityLogMessage,
  type ProviderPrefixContinuity,
  type ProviderPrefixSnapshot,
} from '../telemetry/provider-prefix-continuity.js';
import type {
  DeferredRecoveryMessage,
  ExpensiveTurnRecoveryCounters,
  ExpensiveTurnRecoveryState,
} from '../state/store.js';
import {
  RuntimeRollDrainLease,
  type RuntimeRollDrainRequest,
  type RuntimeRollDrainSnapshot,
} from '../shared/runtime-roll-drain.js';

const AGENT_SESSION_PREFIX = 'agent-session-';

type PrefixPrewarmReason = 'restart' | 'ready_work' | 'post_compaction' | 'soft_drain_rehome';

interface PrefixPrewarmOptions {
  reason?: PrefixPrewarmReason;
  /** Ask Cortex to move the exact full prefix away from a warm-only soft-drain
   *  source. Accepted only on a maintenance warmup. */
  rehomeIntent?: boolean;
}

/** Idle-heartbeat nudge (SCLI-49). Module-level so setup can pre-activate the
 *  MCP tools it names (PLAT-4189 follow-up: activating a deferred MCP tool
 *  mid-session rewrites the prompt head and busts the vLLM prefix cache). */
const IDLE_HEARTBEAT_NUDGE = '[HEARTBEAT] You have been idle. Call mcp__shizuha-pulse__pulse_get_my_alerts FIRST, then '
  + 'mcp__shizuha-pulse__pulse_get_my_tasks. After both results, WORK THROUGH ALL ready items in priority order across alerts and tasks; alerts win ties but never preempt higher-priority task WIP. Take the selected item to a real outcome '
  + '(alert recovery, task result, transition, or PR), then re-check mcp__shizuha-pulse__pulse_get_my_alerts before calling mcp__shizuha-pulse__pulse_get_my_tasks AGAIN and pick '
  + 'up the next ready task. Repeat until no ready non-blocked task remains. Never stop while you '
  + 'still have a ready task assigned. If a task is invalid (false-positive, duplicate, '
  + 'nonsensical), reject/close it with a reason. '
  // Operator 2026-08-05, on banto sitting at "needs help" for 49 heartbeats:
  //   our workflows clearly tell agents to transition/assign the tasks to
  //   relevant team if they aren't on them .. or create blocker tasks and block
  //   current task but don't have the task open to them if they really can't do
  //   anything with such tasks .. if banto would have only blocked tasks then
  //   hive would immediately see it and hibernate it, freeing the slot
  // The nudge covered INVALID tasks but said nothing about a VALID task the
  // agent cannot action itself (banto's are requests for operator/CA-held tax
  // evidence). So it re-read the same two tasks every 60s, forever, doing
  // nothing — and a ready-but-untouched queue is exactly what the needs-help
  // detector is built to flag. A ready task you cannot act on must not stay
  // ready.
  + 'If a task is VALID but you cannot action it yourself — it needs another '
  + "team's access, a decision, or something only a human holds — do NOT leave "
  + 'it ready and do NOT stall on it: either reassign/transition it to the team '
  + 'or owner who can act, or create a blocker task and block this one behind '
  + 'it. Leaving work ready that you will never progress strands the task and '
  + 'holds your seat open for nothing. '
  // Live proof of the cost, 2026-08-05: rei (WIP cap 1) held one in_review
  // item whose sign-off it had already posted; the resolver denied every new
  // assignment (`wip_capacity_denied load=1 cap=1`) and the review team's
  // ~60-task queue could not distribute AT ALL. ren reasoned the same way
  // ("my part is done, it awaits the architect — routed correctly") and kept
  // the task parked. Correct reasoning, wrong conclusion: done-your-part means
  // hand it off, not hold it.
  + 'The same applies when YOUR part is done but the task still sits on your '
  + 'queue awaiting another role (a review you have signed off, an approval '
  + 'another lane must fire): reassign it to that role or team NOW. A '
  + 'finished-your-part task parked on you occupies your WIP slot and starves '
  + "your team's queue. "
  + 'If mcp__shizuha-pulse__pulse_get_my_tasks returns no ready tasks, END THE '
  + 'TURN IMMEDIATELY — never call it a second time in the same turn without completing a task in '
  + 'between. Only when nothing is ready: do nothing and stay silent.';
const IDLE_HEARTBEAT_TERMINAL_STATUSES = new Set([
  'completed', 'cancelled', 'closed', 'done', 'resolved', 'rejected',
  'duplicate', 'wont_fix', 'merged', 'failed', 'expired', 'deferred',
]);
const IDLE_HEARTBEAT_WAITING_STATUSES = new Set(['blocked', 'scheduled', 'backlog']);

/**
 * Apply the effective platform-service allow-list to gateway MCP configs.
 *
 * PLAT-3119 represents every platform MCP behind one `shizuha-mcp` stdio
 * multiplexer.  Treating that aggregate name like a normal `shizuha-{service}`
 * entry turns it into logical service `mcp`, so PLAT-1092 drops the whole
 * server and leaves Shizuha/Grok gateway agents with no Pulse heartbeat tools.
 * Scope the embedded service manifest instead.  A malformed aggregate fails
 * closed because retaining it would bypass Hive's authoritative allow-list.
 */
export function scopeGatewayPlatformMcpConfigs(
  configs: MCPServerConfig[],
  allowed: Set<string>,
): { configs: MCPServerConfig[]; dropped: string[] } {
  const scoped: MCPServerConfig[] = [];
  const dropped: string[] = [];

  for (const config of configs) {
    if (config.name === 'shizuha-mcp') {
      const args = [...(config.args ?? [])];
      const servicesArg = args.indexOf('--services');
      if (servicesArg < 0 || servicesArg + 1 >= args.length) {
        dropped.push('shizuha-mcp(malformed-services)');
        continue;
      }
      try {
        const services = JSON.parse(args[servicesArg + 1]!) as unknown;
        if (!Array.isArray(services)) throw new Error('services is not an array');
        const permitted = services.filter((service): service is Record<string, unknown> => (
          !!service
          && typeof service === 'object'
          && typeof (service as Record<string, unknown>).name === 'string'
          && allowed.has((service as Record<string, unknown>).name as string)
        ));
        for (const service of services) {
          const name = service && typeof service === 'object'
            ? (service as Record<string, unknown>).name
            : undefined;
          if (typeof name === 'string' && !allowed.has(name)) dropped.push(`shizuha-${name}`);
        }
        if (permitted.length === 0) {
          dropped.push('shizuha-mcp(empty-after-scope)');
          continue;
        }
        args[servicesArg + 1] = JSON.stringify(permitted);
        scoped.push({ ...config, args });
      } catch {
        dropped.push('shizuha-mcp(malformed-services)');
      }
      continue;
    }
    if (!config.name.startsWith('shizuha-')) {
      scoped.push(config);
      continue;
    }
    const logicalName = config.name.slice('shizuha-'.length);
    if (allowed.has(logicalName)) scoped.push(config);
    else dropped.push(config.name);
  }

  return { configs: scoped, dropped };
}

/** User-facing copy for a failed provider turn; raw diagnostics stay in logs/hooks. */
export function userVisibleProviderFailure(errorMessage: string): string {
  const normalized = errorMessage.toLowerCase();
  if (/context window|context[_ -]?(too large|length|limit)|prompt is too long/.test(normalized)) {
    return 'I could not complete that response because this conversation is too long. Start a new conversation or retry after compacting it.';
  }
  return 'I could not complete that response because the AI service is temporarily unavailable. Please retry.';
}

export function providerFailureTerminalMessage(errorMessage: string): string {
  const normalized = errorMessage.toLowerCase();
  const reason = /context window|context[_ -]?(too large|length|limit)|prompt is too long/.test(normalized)
    ? 'conversation context is too large even after bounded recovery'
    : 'provider/runtime unavailable after bounded fallback attempts';
  return `🔴 ANDON: ${reason}. Stopping this turn terminally; not retrying, redispatching, or sending repeated generic fallback messages.`;
}

export function providerFailureDedupeKey(msg: Pick<InboundMessage, 'channelId' | 'threadId' | 'userName'>, errorMessage: string): string {
  const normalized = errorMessage.toLowerCase().replace(/\s+/g, ' ').slice(0, 500);
  const digest = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return [msg.channelId || 'unknown-channel', msg.threadId || 'unknown-thread', msg.userName || 'unknown-user', digest].join(':');
}

/**
 * A gateway error ring is cleared only after a successful LLM turn.  Therefore
 * any remaining entry is a current consecutive turn failure, not historical
 * noise.  Export this as unhealthy so Connect/Pulse can stop routing work to a
 * process that is alive but cannot complete inference (for example a pod-local
 * ECONNREFUSED path to Cortex).
 */
export function gatewayHealthFromRecentErrors(recentErrors: readonly string[]): {
  ok: boolean;
  provider_unavailable: boolean;
  consecutive_error_turns: number;
} {
  const consecutiveErrorTurns = recentErrors.length;
  const providerUnavailable = recentErrors.some((message) => {
    const normalized = message.toLowerCase();
    return /cannot connect to (?:vllm|cortex|the (?:ai|model) provider)/.test(normalized)
      || /(?:vllm|cortex|model provider|ai service).*(?:econnrefused|enetunreach|ehostunreach|timed? ?out)/.test(normalized)
      || /(?:econnrefused|enetunreach|ehostunreach|timed? ?out).*(?:vllm|cortex|model provider|ai service)/.test(normalized)
      || /(?:model |ai )?provider.*(?:unavailable|unreachable|offline|down)/.test(normalized)
      || /(?:token pool|rate limit|usage limit|quota).*(?:unavailable|exhausted|exceeded|reached)/.test(normalized);
  });
  return {
    ok: consecutiveErrorTurns === 0,
    provider_unavailable: providerUnavailable,
    consecutive_error_turns: consecutiveErrorTurns,
  };
}

export function resolvePulseBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['PULSE_INTERNAL_URL'] || env['SHIZUHA_PULSE_URL'] || env['PULSE_API_URL'];
  if (explicit) return explicit.replace(/\/+$/, '');
  const platform = (env['SHIZUHA_PLATFORM_URL'] || env['BACKEND_URL'] || '').replace(/\/+$/, '');
  if (platform) return platform;
  return 'http://shizuha-pulse.shizuha.svc.cluster.local:8002';
}

export function resolvePulseToken(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env['PULSE_SERVICE_TOKEN']
    || env['SHIZUHA_AGENT_TOKEN']
    || env['AGENT_ACCESS_TOKEN']
    || env['MCP_UPSTREAM_BEARER'];
  if (direct) return direct;
  const file = env['MCP_UPSTREAM_BEARER_FILE'] || '/home/agent/.shizuha/.mcp-upstream-token';
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token) return token;
  } catch { /* no bearer file */ }
  return '';
}

function pulseBaseUrl(): string {
  return resolvePulseBaseUrl();
}

function pulseToken(): string {
  return resolvePulseToken();
}

export function idleHeartbeatAgentPulseEmails(username?: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const emails = new Set<string>();
  const envEmail = env['AGENT_EMAIL']?.trim();
  if (envEmail) emails.add(envEmail.toLowerCase());
  const name = (username ?? env['AGENT_USERNAME'] ?? '').trim();
  if (name) {
    emails.add(`${name}@shizuha.com`.toLowerCase());
    emails.add(`${name}@agents.shizuha.io`.toLowerCase());
  }
  return [...emails];
}

function itemRows(payload: unknown): any[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object' && Array.isArray((payload as any).results)) return (payload as any).results;
  return [];
}

export function isReadyPulseItemForIdleHeartbeat(row: any): boolean {
  const status = String(row?.status ?? '').toLowerCase();
  if (!status) return true;
  if (IDLE_HEARTBEAT_TERMINAL_STATUSES.has(status)) return false;
  if (IDLE_HEARTBEAT_WAITING_STATUSES.has(status)) return false;
  return true;
}

export function idleHeartbeatHasReadyPulseRows(payload: unknown): boolean {
  return itemRows(payload).some(isReadyPulseItemForIdleHeartbeat);
}

/**
 * Whether a completed heartbeat should fast-re-arm the next idle tick (~60s)
 * instead of waiting the full idleHeartbeatMs cadence.
 *
 * Protocol-compliant empty-queue heartbeats always call alerts + tasks (≥2 tools)
 * and must NOT re-arm — that spun agents every minute into repeated context
 * intermittent needs_help (Nova / GLM lane, 2026-07-28).
 */
/**
 * Stop fast re-arming once an agent has proven it is not progressing its queue.
 *
 * banto, 2026-08-05: 2 ready tasks it could not action (they ask for
 * operator/CA-held tax evidence), 49 consecutive heartbeats with
 * progressEventCount 0 — and because `ready > 0` it re-armed every ~60s the
 * whole time, against a configured cadence of 900s. Each of those turns was a
 * real model call (TTFT measured at 162.6s), so a permanently stuck agent burned
 * roughly a turn a minute, indefinitely, to re-read a queue it never touched.
 *
 * The drain-the-queue safety net is for an agent that IS working through items.
 * After this many fruitless cycles it has stopped being a safety net and become
 * a spin loop; fall back to the normal cadence and let needs_help surface it.
 */
export const FAST_REARM_NO_PROGRESS_LIMIT = 3;

export function shouldFastRearmIdleHeartbeat(input: {
  sawLoopBreak: boolean;
  readyTaskCount?: number;
  progressEventCount?: number;
  forwardedEventCount?: number;
  consecutiveReadyNoProgressHeartbeats?: number;
}): boolean {
  if (input.sawLoopBreak) return false;
  const ready = Math.max(0, input.readyTaskCount ?? 0);
  const progress = Math.max(0, input.progressEventCount ?? 0)
    + Math.max(0, input.forwardedEventCount ?? 0);
  // Real progress always re-arms: that is an agent draining its queue.
  if (progress > 0) return true;
  const fruitless = Math.max(0, input.consecutiveReadyNoProgressHeartbeats ?? 0);
  if (fruitless >= FAST_REARM_NO_PROGRESS_LIMIT) return false;
  return ready > 0;
}

const MCP_TOOL_NAME_RE = /\bmcp__[A-Za-z0-9_-]+(?:__[A-Za-z0-9_-]+)+\b/g;

export function extractMentionedMcpToolNames(content: unknown): string[] {
  const names = new Set<string>();
  const scan = (text: string): void => {
    for (const match of text.matchAll(MCP_TOOL_NAME_RE)) {
      names.add(match[0]);
    }
  };

  if (typeof content === 'string') {
    scan(content);
  } else if (content != null) {
    scan(JSON.stringify(content));
  }

  return [...names];
}

export function addExplicitlyMentionedMcpTools<T extends { name: string }>(
  activeDefs: T[],
  allDefs: T[],
  mentionedNames: Iterable<string>,
): { toolDefs: T[]; added: string[] } {
  const activeNames = new Set(activeDefs.map((d) => d.name));
  const allByName = new Map(allDefs.map((d) => [d.name, d]));
  const next = [...activeDefs];
  const added: string[] = [];

  for (const name of mentionedNames) {
    if (!name.startsWith('mcp__') || activeNames.has(name)) continue;
    const def = allByName.get(name);
    if (!def) continue;
    next.push(def);
    activeNames.add(name);
    added.push(name);
  }

  return { toolDefs: next, added };
}

/**
 * Resolve schemas named directly by an inbound message without needlessly
 * rewriting the provider's tool head. DeepSeek V4 Flash can emit structured
 * calls for MCP schemas carried in conversation history, so its deferred head
 * must remain byte-stable. Hosted/unsupported models retain declared-schema
 * activation for API compatibility.
 */
export function activateExplicitlyMentionedMcpToolsForModel<T extends { name: string }>(
  activeDefs: T[],
  allDefs: T[],
  mentionedNames: Iterable<string>,
  model: string,
): { toolDefs: T[]; added: string[]; availableAppendOnly: T[] } {
  const mentioned = [...mentionedNames];
  if (modelSupportsAppendOnlyToolActivation(model)) {
    const allNames = new Set(allDefs.map((definition) => definition.name));
    const activeNames = new Set(activeDefs.map((definition) => definition.name));
    return {
      toolDefs: activeDefs,
      added: [],
      availableAppendOnly: mentioned
        .filter((name) => name.startsWith('mcp__') && !activeNames.has(name) && allNames.has(name))
        .map((name) => allDefs.find((definition) => definition.name === name)!),
    };
  }

  const activated = addExplicitlyMentionedMcpTools(activeDefs, allDefs, mentioned);
  return { ...activated, availableAppendOnly: [] };
}

export function appendInlineMcpSchemasToMessage(
  message: Pick<Message, 'content'>,
  definitions: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): void {
  if (definitions.length === 0) return;
  const schemaSection = '\n\nDeferred MCP tool schemas requested by this message; call these tools directly by exact name:\n'
    + definitions.map((definition) => JSON.stringify({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    })).join('\n\n');
  if (typeof message.content === 'string') {
    message.content += schemaSection;
  } else {
    message.content.push({ type: 'text', text: schemaSection });
  }
}

export interface ClassifiedRecoveryFeed {
  deferred: Array<{ message: InboundMessage; messageClass: string }>;
  counters: ExpensiveTurnRecoveryCounters;
  unresolvedHumanMessageIds: string[];
}

/** Admission guard for the intrinsic scheduler heartbeat.
 *
 * A heartbeat that is already executing is no longer present in Inbox.queue,
 * so queue-only coalescing cannot see it. Fast re-arm then used to enqueue a
 * new heartbeat every scheduler tick while the current one was still busy,
 * growing Nagi's queue to eight duplicate beats and its prompt past 250K.
 * Keep the due timestamp unchanged while busy: the first idle scheduler tick
 * runs the checkpoint, with no lost durable work and at most one heartbeat.
 */
export function idleHeartbeatAdmissionAllowed(input: {
  running: boolean;
  busy: boolean;
  pendingHeartbeat: boolean;
  now: number;
  nextDueAt: number;
  lastActivityAt?: number;
  minIdleMs?: number;
}): boolean {
  if (!input.running || input.busy || input.pendingHeartbeat || input.now < input.nextDueAt) {
    return false;
  }
  const minIdleMs = input.minIdleMs ?? 0;
  const lastActivityAt = input.lastActivityAt ?? 0;
  if (minIdleMs > 0 && lastActivityAt > 0 && (input.now - lastActivityAt) < minIdleMs) {
    return false;
  }
  return true;
}

/** Canonical daemon env wins, while legacy Hive-rendered pods remain usable
 * during an idle-safe rollout. Remove the alias only after Hive has reconciled
 * every deployment to SHIZUHA_MODEL_FALLBACKS and the live drift gate proves
 * MODEL_FALLBACKS absent fleet-wide. */
/**
 * Model fallback chains are RETIRED — one agent, one model.
 *
 * Operator 2026-08-06: "let's completely remove the concept of model fallbacks
 * to avoid future confusions. only one agent-model is allowed and no fallbacks
 * for any agents". Hive's data layer already normalizes `model_fallbacks` to
 * `[]` (directive 2026-08-04), but a LIVE pod kept a stale
 * `MODEL_FALLBACKS=[grok-4.5, DeepSeek-V4-Flash]` env for months because
 * Kubernetes strategic-merge patches cannot delete an env key — so kumo
 * prewarmed and served two models while the Agents page said one.
 *
 * This reads the env and always returns undefined: the runtime is now inert to
 * any surviving value, so no stale template, cached spec, or hand-edited
 * Deployment can reintroduce multi-model behaviour behind Hive's back. The
 * downstream chain machinery stays in place but is permanently empty — an
 * agent runs the model in MODEL and nothing else. What a failing model needs
 * is to be VISIBLE (the Hive hibernate-on-unserviceable path), not silently
 * swapped for another.
 */
export function modelFallbacksEnv(
  _env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return undefined;
}

/**
 * Typed feed policy for SCLI-347.  Only duplicate heartbeat/system artifacts
 * are coalesced; prose is never used to guess that a human or Connect item is
 * disposable.
 */
export function classifyRecoveryFeed(
  messages: readonly InboundMessage[],
  admissionCoalescedHeartbeats = 0,
): ClassifiedRecoveryFeed {
  const deferred: Array<{ message: InboundMessage; messageClass: string }> = [];
  const unresolvedHumanMessageIds: string[] = [];
  const systemKeys = new Set<string>();
  let coalesced = admissionCoalescedHeartbeats;

  for (const message of messages) {
    const human = message.source == null || message.source === 'user';
    const actionableConnect = message.channelType === 'connect' && message.source === 'inter-agent';
    if (human || actionableConnect) {
      deferred.push({ message, messageClass: human ? 'human' : 'connect_actionable' });
      unresolvedHumanMessageIds.push(message.id);
      continue;
    }

    if (message.source === 'heartbeat') {
      const key = stableRecoveryFeedKey(message);
      if (systemKeys.has(key)) {
        coalesced += 1;
        continue;
      }
      systemKeys.add(key);
      deferred.push({ message, messageClass: 'system_heartbeat' });
      continue;
    }

    // Cron and other typed system inputs are preserved: the recovery contract
    // permits dropping only known duplicate artifacts, not unknown work.
    deferred.push({ message, messageClass: `system_${message.source ?? 'unknown'}` });
  }

  return {
    deferred,
    unresolvedHumanMessageIds,
    counters: {
      preserved: deferred.length,
      coalesced,
      dropped: 0,
      deferred: deferred.length,
      replayed: 0,
    },
  };
}

function stableRecoveryFeedKey(message: InboundMessage): string {
  const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  return crypto.createHash('sha256').update(JSON.stringify({
    source: message.source,
    channelType: message.channelType,
    channelId: message.channelId,
    content,
  })).digest('hex');
}

export class AgentProcess {
  private inbox = new Inbox();
  private channels = new Map<string, Channel>();
  // Intrinsic inactivity heartbeat (SCLI-49). The bridge-driven heartbeat only
  // covers claude/codex bridges; shizuha-runtime (gateway) agents had NONE, so
  // they only acted on a pushed message and went idle forever on ready work.
  // This self-wakes the agent after a period of inactivity to finish assigned tasks.
  private lastActivityAt = Date.now();
  private readonly bootAt = this.lastActivityAt;
  private lastHeartbeatAt = 0;
  private idleHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private readonly idleHeartbeatMs = Number(process.env['SHIZUHA_IDLE_HEARTBEAT_MS'] ?? DEFAULT_IDLE_HEARTBEAT_MS);
  private readonly heartbeatDebounceMs = Number(process.env['SHIZUHA_HEARTBEAT_DEBOUNCE_MS'] ?? DEFAULT_HEARTBEAT_DEBOUNCE_MS);
  // Lean talk seats fire one silent prefix-warm ~8s after boot (empty Pulse
  // still hits the model so the system prefix is resident). After that the
  // idle cadence is 30m and a just-talked seat is never injected.
  private readonly firstHeartbeatMs = Math.min(
    Number(process.env['SHIZUHA_FIRST_HEARTBEAT_MS'] ?? (
      isLeanConversationalEnv() ? LEAN_FIRST_HEARTBEAT_MS : DEFAULT_FIRST_HEARTBEAT_MS
    )),
    this.idleHeartbeatMs,
  );
  private firstHeartbeatPending = true;
  private firstWarmTimer: ReturnType<typeof setTimeout> | null = null;
  private nextHeartbeatDueAt = Date.now() + this.firstHeartbeatMs;
  private readonly expensiveTurnGuard = new ExpensiveTurnGuard(expensiveTurnGuardConfigFromEnv());
  // SCLI-415: single-row deferred-replay pump. At most one row is `releasing`
  // at a time and the next is only considered after the previous is durably
  // acknowledged, so a verified episode cannot burst the deferred FIFO into
  // the guard window.
  private deferredReplayEpisodeId: string | null = null;
  private deferredReplayTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredReplayInFlight = false;
  private lastDeferredReleaseAt = 0;
  // SCLI-415 (reika P1): the guard records one sample per provider TURN, not
  // per row, so a replay row that makes tool calls contributes several. Reserve
  // that much budget before dispatching, so admission is denominated in the
  // same unit the guard counts.
  //
  // (reika P2) The reserve starts UNKNOWN rather than at an assumed 2. An
  // optimistic seed let the first row of a process be admitted against a
  // window foreground had already filled -- e.g. 5 live samples + a seed of 2
  // passes a budget of 7, then a 3-turn row reaches 8 and trips. Until a row
  // has actually been measured the reserve is the whole budget, so only the
  // empty-window floor admits; the floor guarantees that cannot deadlock.
  private deferredReplayTurnsPerRow: number | null = null;
  private deferredReplayTotalSamplesAtDispatch = 0;
  // SCLI-182 / PLAT-4189 follow-up: last provider-reported prompt_tokens — the
  // ground-truth anchor for every context gate (semantic compaction and
  // provider-fit assertions). Instance-level (not per-exchange) so turn-0
  // requests of a new exchange keep the anchor from the previous exchange;
  // reset to 0 whenever session history is REWRITTEN (compaction/digest)
  // because the measurement no longer corresponds to the current messages.
  private lastReportedPromptTokens = 0;
  // Paired uninflated baseline: raw token estimate of the EXACT request that
  // produced lastReportedPromptTokens. With the pair, context growth is
  // measured differentially (anchor + raw delta) instead of re-estimating the
  // whole history, so the raw estimator's systematic overcount of old content
  // can never read as phantom context. Only meaningful while
  // lastReportedPromptTokens > 0; persisted via session_context_token_anchors
  // and restored on resume (agent-ryo 2026-08-08: losing the anchor across a
  // harness roll made the first resumed turn fall back to the ×safety cold
  // estimate and attempt an unnecessary compaction of a 324K/62% session).
  private lastReportedRawEstimateTokens = 0;
  // PLAT-4189 follow-up: persisted set of explicitly-activated deferred MCP
  // tools, so restarts re-activate the same schemas at setup (byte-stable
  // prompt head) instead of re-mutating the head on first mention.
  private activatedMcpToolsPath: string | null = null;
  // PLAT-4189 follow-up: previous provider-payload prefix snapshot for the
  // append-only continuity check (fleet-gateway equivalent of loop.ts's).
  private lastProviderPrefixSnapshot: ProviderPrefixSnapshot | null = null;
  /** Fresh prompt/tool composition held back by the resume pin; adopted at the
   *  next compaction, where the prefix cache breaks anyway (PLAT-4189). */
  private pendingPromptRefresh: { systemPrompt: string; toolDefs: ToolDefinition[] } | null = null;
  /** Frozen provider-wire payload prefix — the exact ChatMessage[] last sent
   *  (operator 2026-08-08: provably identical re-serialization across
   *  restart). Next payload = this prefix ++ convert(new tail); invalidated
   *  by every history rewrite via store.replaceMessages. */
  private providerWirePrefix: { sourceCount: number; messages: import('../provider/types.js').ChatMessage[] } | null = null;
  // A restart prewarm is evidence about a volatile vLLM APC entry, not a
  // permanent promise. Keep the first real turn fenced until it consumes a
  // fresh-enough warmup; otherwise a rollout can warm at startup, sit behind
  // readiness/work scheduling for minutes, then charge the already-evicted
  // prefix to interactive TTFT (Scout 2026-08-02: 164s gap, 17.4s TTFT).
  private cortexFirstTurnPrewarmPending = false;
  private lastCortexPrewarmAt = 0;
  // Cross-provider fallback may use a large local Cortex prefix only when this
  // exact process has successfully warmed/served an append-compatible payload
  // for that model. A model name alone is not proof after compaction/tool-head
  // changes.
  private readonly cortexWarmPrefixProofs = new Map<string, ProviderPrefixSnapshot>();
  private running = false;
  private readonly startTime = Date.now();
  private telemetryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly activityPhase = new ActivityPhaseTracker({
    onChange: () => this.telemetryFlusher?.soon(),
  });
  private readonly telemetryFlusher = createTelemetryFlusher(() => this.emitTelemetry());
  private readonly recentErrors: string[] = [];
  private readonly providerFailureNotices = new Map<string, number>();
  private sessionId: string | null = null;
  /** Transcript generation currently allowed to emit/persist output. */
  private sessionGeneration = 0;

  // Core dependencies — lazily initialized
  private store: any = null;
  private providerReg: any = null;
  private provider: any = null;
  /** Access-only Hive xAI lease. Refresh grant stays in Hive TokenPool. */
  private hiveXaiLease: HiveXaiLease | null = null;
  private toolRegistry: any = null;
  private permissions: any = null;
  private emitter: any = null;
  private mcpManager: any = null;
  private taskRegistry = new BackgroundTaskRegistry();
  private deliveryQueue: DeliveryQueue | null = null;
  private reaper: MaintenanceReaper | null = null;
  private hookEngine: HookEngine | null = null;
  private cronStore: CronStore | null = null;
  private pluginLoader: import('../plugins/loader.js').PluginLoader | null = null;
  private cronScheduler: CronScheduler | null = null;
  private rateLimiter: RateLimiter | null = null;
  private usageTracker: UsageTracker | null = null;
  private autoReplyEngine: AutoReplyEngine | null = null;
  private auditLogger: AuditLogger | null = null;
  private spanTracker: SpanTracker | null = null;
  private agentKeypair: (Keypair & { x25519Public: string; x25519Private: string }) | null = null;
  private readonly gatewayTelemetryWindow = new TurnTelemetryWindow();
  private readonly gatewayTelemetrySink = createTurnTelemetrySink();
  private systemPrompt = '';
  private toolDefs: any[] = [];
  private messages: Message[] = [];

  // Config
  private model: string;
  private cwd: string;
  private maxContextTokens = 0;
  private maxOutputTokens = 0;
  private temperature = 0;
  private permissionMode: string;
  private thinkingLevel?: string;
  private reasoningEffort?: string;
  private loopDetectorConfig?: Partial<import('../agent/loop-detector.js').LoopDetectorConfig>;
  private sandboxConfig?: import('../sandbox/types.js').SandboxConfig;

  // Model fallback chain — ordered list of (method, model) pairs with optional per-entry settings.
  // When the active model fails, we try the next one in the chain.
  private modelFallbacks: Array<{ method: string; model: string; reasoningEffort?: string; thinkingLevel?: string }> = [];
  /** Index into modelFallbacks for the currently pinned model (0 = primary). */
  private pinnedFallbackIndex = 0;
  /** Wall clock for bounded primary re-probes; a transient fallback must never become permanent. */
  private pinnedFallbackAt = 0;

  /** Bridge-local fence used by the runtime roller to stop at a durable turn boundary. */
  private runtimeRollDrainWaiter: (() => void) | null = null;
  private runtimeRollDrain = new RuntimeRollDrainLease(() => {
    this.inbox.unsealIngress();
    for (const channel of this.channels.values()) channel.resumeRuntimeRollIngress?.();
    const release = this.runtimeRollDrainWaiter;
    this.runtimeRollDrainWaiter = null;
    release?.();
  });
  /** True from inbox dequeue until that exact admitted row has settled/requeued. */
  private inboxMessageAdmitted = false;

  /** Resolved fan-out settings (merged with defaults). */
  private fanOut: Record<ChannelType, boolean>;

  constructor(private config: GatewayConfig) {
    this.model = config.model ?? 'codex-mini-latest';
    this.cwd = config.cwd ?? process.cwd();
    this.permissionMode = config.permissionMode ?? 'autonomous';
    this.fanOut = { ...DEFAULT_FAN_OUT, ...config.fanOut };
  }

  /** Check if fan-out is enabled for a channel type. */
  isFanOutEnabled(channelType: ChannelType): boolean {
    return this.fanOut[channelType] ?? false;
  }

  /** Update fan-out settings at runtime (e.g., from dashboard API). */
  setFanOut(channelType: ChannelType, enabled: boolean): void {
    this.fanOut[channelType] = enabled;
    logger.info({ channelType, enabled }, 'Fan-out updated');
  }

  /** Get current fan-out settings. */
  getFanOutSettings(): Record<ChannelType, boolean> {
    return { ...this.fanOut };
  }

  /** Fail-closed non-secret readiness consumed by the daemon RuntimeLane probe. */
  getRuntimeHealth(): Record<string, unknown> {
    const health = gatewayHealthFromRecentErrors(this.recentErrors);
    const issue = this.recentErrors[this.recentErrors.length - 1] ?? '';
    const quotaUnavailable = /\b429\b|rate.?limit|usage limit|quota|too many requests|exhausted/i.test(issue);
    const providerHealthy = this.running && health.ok && !health.provider_unavailable;
    return {
      status: providerHealthy ? 'ok' : 'degraded',
      bridge: 'shizuha-gateway',
      model: this.model,
      initialized: this.running,
      authenticated: this.running,
      providerHealthy,
      provider_available: providerHealthy,
      quota_ok: !quotaUnavailable,
      in_backoff: quotaUnavailable,
    };
  }

  /** Register a channel with the gateway. */
  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
    logger.info({ channelId: channel.id, type: channel.type }, 'Channel registered');
  }

  /** Unregister a channel. */
  unregisterChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  /** Get the inbox (for channels that need to push on start). */
  getInbox(): Inbox {
    return this.inbox;
  }

  /** Get all registered channels. */
  getChannels(): Channel[] {
    return Array.from(this.channels.values());
  }

  /** Whether the agent is currently processing a message. */
  isBusy(): boolean {
    return this.inbox.busy || this.inboxMessageAdmitted;
  }

  /** Reserve the next persisted model/tool-turn boundary for an image rollout. */
  armRuntimeRollDrain(request: RuntimeRollDrainRequest): RuntimeRollDrainSnapshot {
    this.runtimeRollDrain.arm(request);
    if (!this.isBusy()) this.markRuntimeRollReadyIfIdle();
    return this.runtimeRollDrainSnapshot()!;
  }

  runtimeRollDrainSnapshot(): RuntimeRollDrainSnapshot | null {
    const snapshot = this.runtimeRollDrain.snapshot(this.isBusy(), this.inbox.depth);
    if (!snapshot || !this.inbox.ingressFenced) return snapshot;
    return {
      ...snapshot,
      protocol: 2,
      ingressFenced: true,
      admissionVersion: this.inbox.admissionVersion,
    };
  }

  /**
   * Persisted tool results are a checkpoint: the exact admitted row can be
   * replayed against that history without re-running completed tools. Requeue
   * it before advertising ready so a failed controller resumes locally, while
   * a pod replacement leaves the upstream execution uncompleted for redelivery.
   */
  private checkpointRuntimeRollAfterTurn(msg: InboundMessage, continuing: boolean): boolean {
    if (!continuing || !this.runtimeRollDrain.active) return false;
    this.inbox.pushFront([msg]);
    logger.info({
      requestId: msg.requestId,
      messageId: msg.id,
      queueDepth: this.inbox.depth,
    }, 'Runtime rollout drain reached persisted model/tool-turn boundary; exact inbox row retained');
    return true;
  }

  /** Promote draining -> ready only after the admitted-row stack has unwound. */
  private markRuntimeRollReadyIfIdle(): boolean {
    if (!this.runtimeRollDrain.active || this.isBusy()) return false;
    const channels = Array.from(this.channels.values());
    if (channels.length > 0 && channels.every((channel) => (
      typeof channel.fenceRuntimeRollIngress === 'function'
      && typeof channel.resumeRuntimeRollIngress === 'function'
    ))) {
      for (const channel of channels) channel.fenceRuntimeRollIngress!();
      this.inbox.sealIngress();
    }
    this.runtimeRollDrain.markReady();
    return true;
  }

  private async waitForRuntimeRollDrainRelease(): Promise<void> {
    if (!this.runtimeRollDrain.active) return;
    this.markRuntimeRollReadyIfIdle();
    await new Promise<void>((resolve) => {
      this.runtimeRollDrainWaiter = resolve;
      // The lease may have expired between the first check and waiter install.
      if (!this.runtimeRollDrain.active) {
        this.runtimeRollDrainWaiter = null;
        resolve();
      }
    });
  }

  /** Number of messages waiting in the inbox. */
  queueDepth(): number {
    return this.inbox.depth;
  }

  /** The agent's session ID. */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /** The current messages (for web UI to read). */
  getMessages(): readonly Message[] {
    return this.messages;
  }

  /**
   * Initialize the agent — load config, connect to providers, set up tools.
   * Must be called before start().
   */
  async initialize(): Promise<void> {
    const { ToolRegistry } = await import('../tools/registry.js');
    const { registerBuiltinTools } = await import('../tools/builtin/index.js');
    const { PermissionEngine } = await import('../permissions/engine.js');
    const { ProviderRegistry, normalizeModelName } = await import('../provider/registry.js');
    const { StateStore } = await import('../state/store.js');
    const { loadConfig, loadAgentConfig, loadAgentClaudeMd } = await import('../config/loader.js');
    const { buildSystemPrompt } = await import('../prompt/builder.js');
    const { resolveEffectiveContextWindow } = await import('../provider/context-window.js');
    const { AgentEventEmitter } = await import('../events/emitter.js');
    const { MCPManager } = await import('../tools/mcp/manager.js');
    const { registerMCPTools } = await import('../tools/mcp/bridge.js');

    const cfg = await loadConfig(this.cwd);

    // Compose AGENTS.md = universal core + capability skill-directives
    // (agents_md: true). Selection: assigned skill env lists + tags matching
    // AGENT_EFFECTIVE_CAPABILITIES. Prompt-cached; not skill-load dependent.
    try {
      const { writeBaseInstructions } = await import('../agent-base-instructions.js');
      const written = writeBaseInstructions(this.cwd);
      logger.info(
        { directives: written.directives, bytes: written.bytes, path: written.path },
        'Composed AGENTS.md from universal core + agents_md directives',
      );
    } catch (err) {
      logger.warn({ err }, 'AGENTS.md compose failed — continuing without rewrite');
    }

    // Load per-agent config: ~/.shizuha/agents/{username}/agent.toml + CLAUDE.md
    const agentUsername = this.config.agentUsername;
    const agentCfg = agentUsername ? await loadAgentConfig(agentUsername) : null;
    const agentClaudeMd = agentUsername ? await loadAgentClaudeMd(agentUsername) : null;

    // Priority: per-agent TOML > CLI flag > global config > defaults
    this.model = normalizeModelName(agentCfg?.model ?? this.config.model ?? cfg.agent.defaultModel);
    this.temperature = agentCfg?.temperature ?? cfg.agent.temperature;
    this.maxOutputTokens = agentCfg?.maxOutputTokens ?? cfg.agent.maxOutputTokens;
    this.permissionMode = agentCfg?.permissionMode ?? this.config.permissionMode ?? cfg.permissions.mode;
    this.thinkingLevel = agentCfg?.thinkingLevel ?? this.config.thinkingLevel;
    this.reasoningEffort = agentCfg?.reasoningEffort ?? this.config.reasoningEffort;
    this.loopDetectorConfig = cfg.loopDetector;  // SCLI-20(c): TOML-tunable thresholds
    this.sandboxConfig = cfg.sandbox?.mode !== 'unrestricted' ? cfg.sandbox : undefined;

    if (isHiveDirectXaiGrokModel(this.model)) {
      const leased = await leaseHiveXaiAccess({
        stickyKey: `agent:${this.config.agentUsername || this.config.agentId || 'gateway'}`,
      });
      if (!leased) {
        throw new Error(
          'Hive xAI TokenPool lease failed: Grok Build direct (xai:grok-*) needs '
          + 'an access-only coordinator lease. Refresh tokens stay in Hive.',
        );
      }
      this.hiveXaiLease = leased;
      logger.info(
        { email: leased.payload.email, label: leased.token.label, model: hiveDirectXaiUpstreamModel(this.model) },
        'Leased Hive xAI access token for Grok Build (refresh token not served)',
      );
    }

    this.providerReg = new ProviderRegistry(cfg);
    if (this.model === 'auto') {
      this.model = this.providerReg.resolveAutoModel();
    }
    // Keep the original model name (with provider prefix) for re-resolution after plugin merge
    const originalModelName = this.model;
    const resolved = this.hiveXaiLease
      ? { provider: this.hiveXaiLease.provider, resolvedModel: hiveDirectXaiUpstreamModel(this.model) }
      : this.providerReg.resolveWithModel(this.model);
    this.provider = resolved.provider;
    this.model = resolved.resolvedModel;

    // Load model fallback chain from env (set by daemon manager)
    let hasExplicitProviderOverride = false;
    const fallbacksEnv = modelFallbacksEnv();
    if (fallbacksEnv) {
      try {
        const parsed = JSON.parse(fallbacksEnv) as Array<{ method: string; model: string; provider?: string; reasoningEffort?: string; thinkingLevel?: string }>;
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.modelFallbacks = parsed;
          // Apply primary entry's provider override if set
          const primary = parsed[0]!;
          if (primary.provider) {
            const overrideProvider = this.providerReg.get(primary.provider);
            if (overrideProvider) {
              this.provider = overrideProvider;
              hasExplicitProviderOverride = true;
              logger.info({ provider: primary.provider, model: primary.model }, 'Primary provider override applied');
            }
          }
          logger.info({
            chain: parsed.map((f) => `${f.model}${f.provider ? ` (${f.provider})` : ''}`),
            primary: primary.model,
          }, 'Model fallback chain configured');
        }
      } catch {
        logger.warn('Invalid SHIZUHA_MODEL_FALLBACKS env, ignoring');
      }
    }

    // Pre-warm provider discovery so maxContextWindow reflects the SERVED limit (e.g. vLLM /v1/models max_model_len)
    {
      const provAny = this.provider as unknown as { getServedModel?: (preferredModel?: string) => Promise<string | undefined> };
      if (typeof provAny.getServedModel === 'function') {
        // Pass the agent's model so a multi-model endpoint resolves THIS model's max_model_len
        try { await provAny.getServedModel(this.model); } catch { /* ignore */ }
      }
    }
    this.maxContextTokens = resolveEffectiveContextWindow(
      this.model,
      this.provider,
      agentCfg?.maxContextTokens ?? cfg.agent.maxContextTokens,
    );

    this.toolRegistry = new ToolRegistry();
    registerBuiltinTools(this.toolRegistry);
    if (this.provider.supportsNativeWebSearch) {
      this.toolRegistry.unregister('web_search');
    }

    // Build network policy from sandbox config
    const networkPolicy = cfg.sandbox?.mode !== 'unrestricted' ? {
      networkAccess: cfg.sandbox?.networkAccess ?? false,
      allowedHosts: cfg.sandbox?.allowedHosts ?? [],
    } : undefined;
    this.permissions = new PermissionEngine(this.permissionMode as PermissionMode, cfg.permissions.rules, { networkPolicy });
    this.emitter = new AgentEventEmitter();
    // Store state.db in the working directory (mounted volume in containers)
    // so sessions survive container restarts.
    this.store = new StateStore(path.join(this.cwd, '.shizuha-state.db'));
    // Wire-prefix invariant (operator 2026-08-08): every history REWRITE goes
    // through replaceMessages — the single choke-point — so wrapping it here
    // guarantees the in-process frozen prefix can never outlive a rewrite.
    // (The store method itself clears the persisted row.)
    {
      const _origReplaceMessages = this.store.replaceMessages.bind(this.store);
      this.store.replaceMessages = (sessionId: string, msgs: Message[]) => {
        if (sessionId === this.sessionId) this.providerWirePrefix = null;
        return _origReplaceMessages(sessionId, msgs);
      };
    }

    // Inject store into session search tool
    const { setSearchStore } = await import('../tools/builtin/session-search.js');
    setSearchStore(this.store);

    // Initialize per-user rate limiting and usage tracking
    this.rateLimiter = new RateLimiter();
    this.usageTracker = new UsageTracker(this.store);
    setUsageTracker(this.usageTracker);

    // Initialize auto-reply engine from config
    if (cfg.autoReply?.enabled && cfg.autoReply.rules.length > 0) {
      this.autoReplyEngine = new AutoReplyEngine(cfg.autoReply.rules);
    }

    // Connect MCP servers (merge per-agent servers with global)
    this.mcpManager = new MCPManager();
    let mcpConfigs = cfg.mcp.servers ?? [];
    if (agentCfg?.mcp?.servers?.length) {
      const existingNames = new Set(mcpConfigs.map((s) => s.name));
      const agentServers = agentCfg.mcp.servers.filter((s) => !existingNames.has(s.name));
      mcpConfigs = [...mcpConfigs, ...agentServers];
    }

    // PLAT-3195: k8s-native fleet pods have no provisioned ~/.mcp.json (that
    // file is written by `provision-agent` on the docker/host path only), so a
    // gateway that only reads config files boots with ZERO platform MCP
    // servers — no Pulse queue, no Wiki, no Connect — and the agent idles
    // forever while its team queue backs up. The bridges already self-derive
    // their MCP config from SHIZUHA_PLATFORM_URL + the broker JWT; do the same
    // here when nothing else supplied a shizuha-* server. Direct HTTP entries
    // (stdio proxy off): this runtime's own MCP client handles reconnects and
    // on-401 broker token refresh (PLAT-223).
    if (!mcpConfigs.some((s) => s.name.startsWith('shizuha-')) && process.env['SHIZUHA_PLATFORM_URL']) {
      try {
        const { getPlatformMcpConfigs } = await import('../platform/mcp-services.js');
        const { fetchBrokerToken } = await import('../auth/broker-token.js');
        const bearerToken = (await fetchBrokerToken())?.accessToken
          || process.env['AGENT_ACCESS_TOKEN'] || '';
        if (bearerToken) {
          const derived = getPlatformMcpConfigs({ bearerToken, stdioProxy: 'off' });
          const derivedConfigs = Object.entries(derived).flatMap(([name, entry]) =>
            ('url' in entry ? [{
              name,
              transport: 'streamable-http' as const,
              url: entry.url,
              headers: { ...entry.headers },
              platformManaged: true,
            }] : []));
          if (derivedConfigs.length > 0) {
            mcpConfigs = [...mcpConfigs, ...derivedConfigs];
            logger.info({ servers: derivedConfigs.map((s) => s.name) },
              '[PLAT-3195] Derived platform MCP servers from env (no provisioned MCP config found)');
          }
        } else {
          logger.warn('[PLAT-3195] No provisioned MCP config and no broker/env token — platform MCP unavailable');
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, '[PLAT-3195] Platform MCP env derivation failed');
      }
    }

    // SCLI-44: apply role→MCP server access-matrix filter BEFORE connecting.
    // Platform servers are named `shizuha-{service}` — strip the prefix to get
    // the logical name and check against resolveAllowedServers. Non-platform
    // servers (stdio tools, custom http) are always passed through.
    {
      const { resolveAllowedServers } = await import('../platform/mcp-access-matrix.js');
      const { parseAgentEffectiveMcpServicesFromEnv } = await import('../platform/effective-capabilities.js');
      const agentRole = process.env['AGENT_ROLE'];
      const agentUsername = process.env['AGENT_USERNAME'];
      // Capability tags (skills[]) unioned with role (operator 2026-06-24).
      const agentSkills = (process.env['AGENT_SKILLS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const hiveAllowList = parseAgentEffectiveMcpServicesFromEnv();
      const allowed = hiveAllowList ? new Set(hiveAllowList) : resolveAllowedServers(agentRole, agentUsername, agentSkills);
      // SCLI-64: SHIZUHA_MCP_SERVICES is an optional further-narrowing lever.
      // When both the role matrix and the env var are set, intersect them so
      // the operator lever always wins (role = ceiling, env = narrowing).
      const envSvcs = (process.env['SHIZUHA_MCP_SERVICES'] ?? '').trim();
      if (envSvcs) {
        const envSet = new Set(envSvcs.split(',').map((s) => s.trim()).filter(Boolean));
        for (const s of [...allowed]) {
          if (!envSet.has(s)) allowed.delete(s);
        }
      }
      const scoped = scopeGatewayPlatformMcpConfigs(mcpConfigs, allowed);
      mcpConfigs = scoped.configs;
      const dropped = scoped.dropped;
      if (dropped.length > 0) {
        logger.info({ dropped, role: agentRole ?? '(unset)', hiveEffective: !!hiveAllowList, allowed: [...allowed] }, hiveAllowList ? '[PLAT-1092] MCP servers dropped by Hive effective capabilities' : '[SCLI-44] MCP servers dropped by role matrix');
      }
    }

    // CTX-4xx / gateway-mcp-outage: route platform (shizuha-*) MCP servers through
    // the local stdio `mcp-proxy` subprocess instead of the gateway's IN-PROCESS
    // streamable-http client. Root cause (verified live): the in-process
    // StreamableHTTPClientTransport to the nginx-fronted platform MCP endpoints
    // HANGS to the 90s connect timeout for every platform server, while a stdio
    // MCP server in the SAME process (e.g. shizuha-drive) connects instantly and
    // a subprocess mcp-proxy to the exact same URL connects in <1s. The stdio
    // proxy owns the HTTP/SSE I/O in its own event loop, immune to whatever
    // in-process interaction wedges the direct client — the same reason the
    // stdio proxy is the DEFAULT for bridges (it's the proven-reliable path).
    // Non-platform stdio/http servers are left untouched.
    {
      const { resolveProxyLauncher } = await import('../platform/mcp-services.js');
      const launcher = resolveProxyLauncher();
      const bearerFile = process.env['MCP_UPSTREAM_BEARER_FILE']?.trim();
      mcpConfigs = mcpConfigs.map((s) => {
        if (!s.name.startsWith('shizuha-')) return s;
        if (s.transport === 'stdio') return s; // already proxied / local stdio
        if (!s.url) return s;
        const svcName = s.name.slice('shizuha-'.length);
        // Seed bearer from the config's Authorization header; the proxy re-reads
        // it FRESH from the broker/file on each (re)connect so it self-heals the
        // 24h token cliff without a restart.
        let seedBearer = '';
        for (const [k, v] of Object.entries(s.headers ?? {})) {
          if (k.toLowerCase() === 'authorization' && typeof v === 'string') {
            seedBearer = v.replace(/^Bearer\s+/i, '').trim();
            break;
          }
        }
        return {
          name: s.name,
          transport: 'stdio' as const,
          command: launcher.command,
          args: [...launcher.prefixArgs, 'mcp-proxy', '--name', svcName, '--upstream-url', s.url],
          env: {
            ...(seedBearer ? { MCP_UPSTREAM_BEARER: seedBearer } : {}),
            ...(bearerFile ? { MCP_UPSTREAM_BEARER_FILE: bearerFile } : {}),
          },
          platformManaged: true,
        };
      });
      const proxied = mcpConfigs.filter((s) => s.name.startsWith('shizuha-') && s.transport === 'stdio' && s.args?.includes('mcp-proxy')).map((s) => s.name);
      if (proxied.length > 0) {
        logger.info({ servers: proxied }, '[gateway-mcp] routed platform MCP servers through local stdio mcp-proxy');
      }
    }

    if (mcpConfigs.length > 0) {
      await this.mcpManager.connectAll(mcpConfigs);
      await registerMCPTools(this.mcpManager, (h: any) => this.toolRegistry.register(h));
    }
    // Give the manager our tool registry so eviction/refresh can (un)register tools —
    // MCPManager.evictServer's `if (this.toolRegistry)` needs it, else dead tools stay
    // registered (and the deferred-catalog rebuild re-reads them). SCLI-42.
    // MUST be wired AFTER the initial registerMCPTools (Codex L284): wiring it before
    // connectAll let a startup `tools/list_changed` → refreshToolsForServer upsert race
    // the initial `register` into a dup-throw that aborts gateway init. Eviction/refresh
    // only fire at runtime (post-init), so this ordering is correct (and matches the
    // agent/loop, index, and TUI call-sites + the order the registry-eviction stack test
    // validated).
    this.mcpManager.setToolRegistry(this.toolRegistry);

    // Load skills
    const { loadSkills } = await import('../skills/loader.js');
    const { SkillRegistry } = await import('../skills/registry.js');
    const { createSkillTool } = await import('../tools/builtin/skill.js');
    const skillRegistry = new SkillRegistry();
    skillRegistry.registerAll(loadSkills(this.cwd, { trustProjectSkills: cfg.skills.trustProjectSkills }));
    if (skillRegistry.size > 0) {
      this.toolRegistry.register(createSkillTool(skillRegistry));
      logger.info({ skillCount: skillRegistry.size }, 'Skills loaded');
    }

    // Initialize skill search engine for search_skills/use_skill tools
    // Skills are SKILL.md files in ~/.shizuha/skills/ or /opt/shizuha/skills/
    const skillsDirs = [
      path.join(process.env['HOME'] ?? '/root', '.shizuha', 'skills'),
      '/opt/skills',
      path.join(this.cwd, '.shizuha', 'skills'),
    ];
    const skillsDir = skillsDirs.find(d => fs.existsSync(d));
    if (skillsDir) {
      const skillEngine = new SkillSearchEngine(skillsDir);
      skillEngine.load();
      setSkillSearchEngine(skillEngine);
      if (skillEngine.count > 0) {
        logger.info({ skillCount: skillEngine.count }, 'Skills loaded');
      }
    }

    // Initialize memory index (FTS5 + optional vector embeddings)
    try {
      const embeddingApiKey = openAiEmbeddingKeyFromEnv();
      const vectorEnabled = !!embeddingApiKey;
      const memoryIndex = new MemoryIndex(this.cwd, {
        vectorEnabled,
        embeddingApiKey,
        temporalDecay: true,
        halfLifeDays: 30,
      });
      setMemoryIndex(memoryIndex);
      const stats = await memoryIndex.sync();
      if (stats.indexed > 0 || stats.embedded > 0) {
        logger.info({ indexed: stats.indexed, embedded: stats.embedded, files: memoryIndex.stats().files }, 'Memory index synced');
      }
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Memory index init failed (non-fatal)');
    }

    // GAP C: Initialize audit logger
    this.auditLogger = new AuditLogger(this.cwd);
    setAuditLogger(this.auditLogger);
    logger.info('Audit logger initialized');

    // GAP F: Initialize telemetry span tracker
    this.spanTracker = new SpanTracker(this.cwd);
    logger.info('Telemetry span tracker initialized');

    // Initialize agent cryptographic identity (Ed25519 + X25519)
    try {
      this.agentKeypair = loadOrCreateAgentKeypair(this.cwd, this.config.agentUsername);
      logger.info({ publicKey: this.agentKeypair.publicKey.slice(0, 16) + '...' }, 'Agent keypair loaded');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Agent keypair init failed (non-fatal)');
    }

    // Load plugins (tools, channels, hooks, services)
    const { PluginLoader } = await import('../plugins/loader.js');
    const pluginAllowList = (agentCfg as any)?.plugins?.allow ?? (cfg as any).plugins?.allow ?? ['*'];
    this.pluginLoader = new PluginLoader({
      workspaceDir: this.cwd,
      toolRegistry: this.toolRegistry,
      inbox: this.inbox,
      onRegisterChannel: (ch) => this.registerChannel(ch),
      allowList: pluginAllowList,
      trustProjectPlugins: cfg.skills?.trustProjectSkills ?? false,
      pluginConfigs: (agentCfg as any)?.plugins?.config ?? {},
    });
    const pluginEntries = await this.pluginLoader.loadAll();
    if (pluginEntries.length > 0) {
      const loaded = pluginEntries.filter(e => e.status === 'loaded');
      if (loaded.length > 0) {
        logger.info({ plugins: loaded.map(e => e.manifest.id) }, 'Plugins registered');
      }
    }

    // Merge LLM providers registered by plugins (overrides built-ins)
    const pluginProviders = this.pluginLoader.getProviders();
    if (pluginProviders.size > 0) {
      this.providerReg.mergePluginProviders(pluginProviders);
      // Re-resolve the active provider in case a plugin overrode it.
      // Use the original model name (with provider prefix like "vllm/Qwen3.5-27B-FP8")
      // so that prefix-based routing still works. Skip if the provider was explicitly
      // set from modelFallbacks (the user chose a specific provider).
      if (!hasExplicitProviderOverride && !this.hiveXaiLease) {
        this.provider = this.providerReg.resolve(originalModelName);
      }
      logger.info({ providers: [...pluginProviders.keys()] }, 'Plugin providers merged');
    }

    // Apply toolset filter — restrict available tools based on named toolset.
    // Priority: per-agent config > GatewayConfig > global config > default ('full')
    const toolsetName = (agentCfg as any)?.toolset ?? this.config.toolset ?? cfg.agent.toolset ?? 'full';
    let toolsetManager: any = null;
    // Re-apply the toolset allow-list to the live registry (unregister any tool not allowed).
    // Run at startup AND on every MCP tool-set refresh (SCLI-42 L298): a reconnect/refresh
    // re-upserts a server's tools into the registry, which would otherwise re-enable tools the
    // toolset filtered out — silently widening a restrictive (safe/none/custom) role's surface
    // and undermining the per-role allow-list. No-op for 'full'.
    const reapplyToolsetFilter = () => {
      if (!toolsetManager || toolsetName === 'full') return;
      const names = this.toolRegistry.list().map((t: any) => t.name);
      const allowed = new Set(toolsetManager.filterTools(toolsetName, names));
      for (const name of names) {
        // Never strip the synthetic discovery tool. ToolSearch is registered AFTER the
        // startup filter on purpose (so even restrictive toolsets that exclude it — e.g.
        // `architect` — can still load deferred MCP schemas). The startup reapply runs
        // before ToolSearch is registered, so this exemption only bites on the refresh
        // reapply: without it, a refresh would unregister ToolSearch while toolDefs still
        // advertises it → an uncallable discovery tool → deferred MCP unusable for the
        // session. Mirrors the startup add-after-filter ordering. (Codex L411 regression.)
        if (name === 'ToolSearch') continue;
        if (!allowed.has(name)) this.toolRegistry.unregister(name);
      }
    };
    if (toolsetName !== 'full') {
      const { ToolsetManager } = await import('../tools/toolsets.js');
      toolsetManager = new ToolsetManager();
      const total = this.toolRegistry.list().length;
      reapplyToolsetFilter();
      logger.info({ toolset: toolsetName, total, active: this.toolRegistry.list().length }, 'Toolset applied');
    }

    // Tool deferral is the default for every MCP-enabled gateway. `auto` keeps
    // the historical 10%-of-window threshold as an explicit compatibility
    // mode; `off` is the opt-out. A 524K model window must not silently disable
    // deferral for a still-expensive 40K schema catalog.
    const allDefs = this.toolRegistry.definitions();
    const contextThreshold = Math.floor(this.maxContextTokens * 0.10); // 10% of context
    const mcpDefs = allDefs.filter((d: any) => d.name.startsWith('mcp__'));
    const estimatedMcpTokens = mcpDefs
      .reduce((sum: number, d: any) => sum + Math.ceil(JSON.stringify(d).length / 2.5), 0); // ~2.5 chars per token
    const toolSearchConfig = cfg.mcp.toolSearch;
    const deferMcpTools = mcpDefs.length > 0 && (
      toolSearchConfig.mode === 'on'
      || (toolSearchConfig.mode === 'auto' && estimatedMcpTokens > contextThreshold)
    );

    if (deferMcpTools) {
      // Defer MCP tools — keep only built-in tools + ToolSearch
      const { setDeferredTools, toolSearchTool, setOnToolResolved } = await import('../tools/builtin/tool-search.js');

      const builtinDefs = allDefs.filter((d: any) => !d.name.startsWith('mcp__'));

      // Store deferred tools for ToolSearch to access
      const deferredMap = new Map<string, any>();
      const deferredSchemas = new Map<string, Record<string, unknown>>();
      for (const d of mcpDefs) {
        deferredMap.set(d.name, d);
        deferredSchemas.set(d.name, { description: d.description, inputSchema: d.inputSchema });
      }
      setDeferredTools(deferredMap, deferredSchemas);

      // Register ToolSearch tool
      this.toolRegistry.register(toolSearchTool);

      // Use only built-in tools + ToolSearch as active definitions initially.
      // All MCP tools stay registered for execution. Their schemas are activated
      // either through ToolSearch or, generically, when a turn explicitly names
      // an exact mcp__server__tool.
      this.toolDefs = [
        ...builtinDefs,
        this.toolRegistry.definitions().find((d: any) => d.name === 'ToolSearch')!,
      ].filter(Boolean);

      // When ToolSearch resolves a deferred tool, add it to active toolDefs
      // so the LLM can call it on subsequent turns (OpenAI-compatible APIs
      // require tools to be in the `tools` array to be callable)
      // 2026-07-14 APPEND-ONLY ACTIVATION (Claude Code's tool_reference pattern,
      // operator-directed after vendor-source study + DSV4 micro-bench 8/8 PASS
      // on both channels — cli/benchmark/append-only-tool-activation-bench.py):
      // a mid-session push into toolDefs rewrites the tools block at the prompt
      // HEAD and busts the vLLM prefix cache (full 30-70s re-prefill of the
      // conversation at fleet context sizes). Instead, the ToolSearch RESULT
      // already carries the full JSON schema in-message (append-only, cache-
      // safe) and vLLM's DSV4 parser emits STRUCTURED tool_calls even for
      // tools absent from the declared array — verified 8/8 with exact args.
      // Execution works because ALL MCP tools stay registered in the registry.
      // DeepSeek V4 Flash keeps this minimal head across restarts too: resolved
      // schemas stay in append-only conversation history and are not persisted
      // back into the next boot's tool head. Hosted APIs retain the compatible
      // declared-schema append path because they reject undeclared functions.
      // Kill-switch: SHIZUHA_APPEND_ONLY_TOOL_ACTIVATION=0 restores live push.
      const { modelSupportsAppendOnlyToolActivation } = await import('../tools/tool-search.js');
      const useAppendOnlyActivation = (): boolean =>
        process.env['SHIZUHA_APPEND_ONLY_TOOL_ACTIVATION'] !== '0'
        && modelSupportsAppendOnlyToolActivation(this.model);
      setOnToolResolved((toolDef: any) => {
        if (this.toolDefs.find(d => d.name === toolDef.name)) return;
        if (useAppendOnlyActivation()) {
          logger.info({ tool: toolDef.name }, 'Deferred tool activated append-only (schema in-message; tool head remains fixed)');
          return;
        }
        // Compatibility schemas are persisted so their declared head is stable
        // from the first request after a hosted-provider restart.
        this.persistActivatedMcpTools([toolDef.name]);
        this.toolDefs.push(toolDef);
        logger.info({ tool: toolDef.name, activeTools: this.toolDefs.length }, 'Activated deferred tool');
      });

      // SCLI-42 #4: when the MCP tool set changes (a server is EVICTED, or tools are
      // added/removed on reconnect), rebuild the deferred catalog from the live registry so
      // ToolSearch stops offering — and stops RESOLVING — tools from a dead/evicted server.
      // MCPManager.evictServer unregisters the dead tools from the registry BEFORE firing this,
      // so the registry is the source of truth. (The static deferred-names prompt section can
      // still list an evicted name until the next prompt rebuild, but the catalog rebuild makes
      // it unresolvable via ToolSearch, so it can no longer be activated or called.)
      this.mcpManager.onToolsRefreshed = () => {
        reapplyToolsetFilter(); // re-strip toolset-filtered tools a refresh re-added (SCLI-42 L298)
        const liveDefs = this.toolRegistry.definitions();
        const liveMcp = liveDefs.filter((d: any) => d.name.startsWith('mcp__'));
        const dMap = new Map<string, any>();
        const dSchemas = new Map<string, Record<string, unknown>>();
        for (const d of liveMcp) {
          dMap.set(d.name, d);
          dSchemas.set(d.name, { description: d.description, inputSchema: d.inputSchema });
        }
        setDeferredTools(dMap, dSchemas);
        // Drop any already-activated deferred MCP tools that no longer exist (evicted).
        const liveNames = new Set(liveDefs.map((d: any) => d.name));
        const before = this.toolDefs.length;
        this.toolDefs = this.toolDefs.filter((d: any) => !d.name.startsWith('mcp__') || liveNames.has(d.name));
        if (this.toolDefs.length !== before) {
          logger.info({ removed: before - this.toolDefs.length, deferred: liveMcp.length }, 'Rebuilt deferred catalog after MCP tool-set change');
        }
      };

      // Never enumerate every deferred name in the system prompt. The configured
      // server catalog is small, deterministic, and independent of live connect
      // counts; exact schemas arrive later in append-only ToolSearch results.
      const { buildConfiguredServerSummaries } = await import('../tools/tool-search.js');
      const serverCatalog = buildConfiguredServerSummaries(mcpConfigs)
        .map((server) => `- **${server.name}**: ${server.description}`)
        .join('\n');
      const deferredSection = `\n\n## More Tools (via ToolSearch)\n` +
        `Additional MCP tools are available but withheld here to keep your context lean. ` +
        `Use ToolSearch with a keyword query (e.g. "wiki create page", "pulse transition") ` +
        `or "select:<exact_tool_name>" to find and load the tool you need before calling it.` +
        (serverCatalog ? `\n\nAvailable sources:\n${serverCatalog}` : '');

      logger.info({
        total: allDefs.length,
        deferred: mcpDefs.length,
        active: this.toolDefs.length,
        estimatedMcpTokens,
        contextThreshold,
      }, 'Tool deferral: MCP tools deferred to save context');

      const skillCatalog = skillRegistry.size > 0
        ? skillRegistry.buildCatalog(
          process.env['AGENT_ROLE'],
          process.env['AGENT_TEAM'],
          isLeanConversationalEnv() ? leanConversationalSkillNames() : undefined,
        )
        : undefined;
      const customPrompt = (agentClaudeMd ?? this.config.contextPrompt ?? '') + deferredSection;
      this.systemPrompt = await buildSystemPrompt({ cwd: this.cwd, tools: this.toolDefs, skillCatalog, customPrompt, model: this.model, contextWindow: this.maxContextTokens, role: process.env['AGENT_ROLE'] });
    } else {
      // No deferral needed — all tools fit in context
      this.toolDefs = allDefs;
      // SCLI-42: refresh the active toolDefs from the live registry on any MCP tool-set
      // change (incl. eviction) so evicted tools stop being offered in the non-deferred
      // path too — otherwise toolDefs stays a static snapshot and still advertises them.
      this.mcpManager.onToolsRefreshed = () => {
        reapplyToolsetFilter(); // re-strip toolset-filtered tools a refresh re-added (SCLI-42 L298)
        this.toolDefs = this.toolRegistry.definitions();
      };
      const skillCatalog = skillRegistry.size > 0
        ? skillRegistry.buildCatalog(
          process.env['AGENT_ROLE'],
          process.env['AGENT_TEAM'],
          isLeanConversationalEnv() ? leanConversationalSkillNames() : undefined,
        )
        : undefined;
      const customPrompt = agentClaudeMd ?? this.config.contextPrompt ?? undefined;
      this.systemPrompt = await buildSystemPrompt({ cwd: this.cwd, tools: this.toolDefs, skillCatalog, customPrompt, model: this.model, contextWindow: this.maxContextTokens, role: process.env['AGENT_ROLE'] });
    }

    // Initialize disk-backed delivery queue for crash-safe outbound delivery
    const stateDir = this.config.agentUsername
      ? path.join(process.env['HOME'] ?? '~', '.shizuha', 'agents', this.config.agentUsername)
      : path.join(process.env['HOME'] ?? '~', '.shizuha');
    this.deliveryQueue = new DeliveryQueue(stateDir);
    await this.deliveryQueue.init();

    // Hosted-provider compatibility path: pre-activate schemas referenced by
    // static prompts or explicitly selected in prior runs. Deterministic sorted
    // order keeps that declared head stable across restarts. DeepSeek V4 Flash
    // skips this block entirely and retains the minimal ToolSearch-only head.
    this.activatedMcpToolsPath = path.join(stateDir, 'activated-mcp-tools.json');
    const { modelSupportsAppendOnlyToolActivation } = await import('../tools/tool-search.js');
    const keepMinimalDeferredHead = deferMcpTools
      && process.env['SHIZUHA_APPEND_ONLY_TOOL_ACTIVATION'] !== '0'
      && modelSupportsAppendOnlyToolActivation(this.model);
    if (!keepMinimalDeferredHead && !talkSeatSuppressesTools()) {
      try {
        const mentioned = new Set<string>();
        if (isLeanConversationalEnv()) {
          // Fixed conversational head — do NOT scrape HEARTBEAT_TRIGGER /
          // IDLE_HEARTBEAT_NUDGE (those named ~20 Pulse tools and busted SuperGrok cache).
          for (const name of LEAN_CONVERSATIONAL_MCP_TOOL_NAMES) mentioned.add(name);
        } else {
          const { HEARTBEAT_TRIGGER } = await import('../agent-base-instructions.js');
          for (const name of extractMentionedMcpToolNames(this.systemPrompt)) mentioned.add(name);
          for (const name of extractMentionedMcpToolNames(HEARTBEAT_TRIGGER)) mentioned.add(name);
          for (const name of extractMentionedMcpToolNames(IDLE_HEARTBEAT_NUDGE)) mentioned.add(name);
          try {
            const persisted = JSON.parse(fs.readFileSync(this.activatedMcpToolsPath, 'utf-8')) as unknown;
            if (Array.isArray(persisted)) {
              for (const name of persisted) if (typeof name === 'string') mentioned.add(name);
            }
          } catch { /* first run or unreadable — fine */ }
        }
        const preactivated = addExplicitlyMentionedMcpTools(
          this.toolDefs,
          this.toolRegistry.definitions(),
          [...mentioned].sort(),
        );
        if (preactivated.added.length > 0) {
          this.toolDefs = preactivated.toolDefs;
          this.persistActivatedMcpTools(preactivated.added);
          logger.info({ tools: preactivated.added, activeTools: this.toolDefs.length },
            'Pre-activated prompt-referenced MCP tools at setup (prefix-stable head)');
        }
      } catch { /* diagnostics-only compatibility optimization — never block setup */ }
    }

    // Talk seats reply via Connect auto-reply. Advertising Pulse/wiki tools
    // starts a multi-round tool loop that holds the single-task inbox and
    // looks like a dead turn to the next human DM.
    if (talkSeatSuppressesTools()) {
      this.toolDefs = [];
      logger.info('Talk seat: empty tools[] (one-shot auto-reply; no Pulse/wiki loops)');
    }

    // Initialize persistent agent memory
    // Use writable workspace (not stateDir which may be read-only in containers)
    const { setMemoryFilePath } = await import('../tools/builtin/memory.js');
    const { loadAgentMemory } = await import('../state/agent-memory.js');
    const memoryPath = path.join(this.cwd, 'MEMORY.md');
    setMemoryFilePath(memoryPath);
    const agentMemory = await loadAgentMemory(memoryPath);
    if (agentMemory) {
      this.systemPrompt += '\n\n' + agentMemory;
    }

    // Inject delivery queue into channels that support it
    for (const channel of this.channels.values()) {
      channel.setDeliveryQueue?.(this.deliveryQueue);
    }

    // Initialize lifecycle hook engine (includes plugin hooks)
    const { HookEngine: HookEngineCls } = await import('../hooks/engine.js');
    const allHooks = cfg.hooks?.hooks ?? [];
    if (agentCfg && (agentCfg as any).hooks?.hooks?.length) {
      allHooks.push(...(agentCfg as any).hooks.hooks);
    }
    // Merge hooks registered by plugins
    if (this.pluginLoader) {
      allHooks.push(...this.pluginLoader.getHooks());
    }
    this.hookEngine = new HookEngineCls(allHooks);

    // Initialize maintenance reaper
    this.reaper = new MaintenanceReaper(undefined, {
      store: this.store,
      failedDir: path.join(stateDir, 'delivery-queue', 'failed'),
      queueDir: path.join(stateDir, 'delivery-queue'),
    });

    // Initialize cron store for scheduled jobs
    // Use cwd (workspace) for cron storage — it's on a mounted volume that survives
    // container restarts. The stateDir is container-local and gets wiped on restart.
    this.cronStore = new CronStore(this.cwd);
    await this.cronStore.load();
    setCronStore(this.cronStore);

    // Load or create the agent's eternal session
    this.loadEternalSession();

    // PLAT-4189 resume pin: a restart must not change the provider prefix head.
    // Re-adopt the exact system prompt + tool defs the previous process last
    // sent whenever only volatile composition inputs (git status, memory,
    // skill catalog, descriptions) drifted — otherwise a harness roll
    // cold-rebuilds every warm multi-100K KV cache in the fleet.
    this.applyResumePromptPin();

    logger.info({
      model: this.model,
      sessionId: this.sessionId,
      messageCount: this.messages.length,
      channels: this.channels.size,
    }, 'Agent process initialized');
  }

  /**
   * Start the agent process — begins listening on all channels and
   * processing messages from the inbox. This method runs forever.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start all channels — they begin pushing messages to the inbox.
    // SCLI-400: a required HTTP channel failure is process-fatal. Do not arm
    // cron/heartbeat/reaper after the serving channel failed to bind.
    for (const channel of this.channels.values()) {
      try {
        await channel.start(this.inbox);
        logger.info({ channelId: channel.id, type: channel.type }, 'Channel started');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Bounded diagnostic — no stack / absolute bundle path.
        logger.error(
          { channelId: channel.id, type: channel.type, error: message },
          'Failed to start channel',
        );
        if (channel.type === 'http') {
          this.running = false;
          console.error(
            `Error: required HTTP channel failed to start (${message}). ` +
              'Gateway will not continue without a listening channel.',
          );
          process.exit(1);
        }
      }
    }

    // A crash after the durable generation fence but before successor commit
    // must never prewarm/sample the poisoned tail.  Finish that episode first.
    await this.resumeExpensiveTurnRecoveryAtStartup();

    // Recover pending deliveries from previous run and start retry loop
    if (this.deliveryQueue) {
      const recovery = await this.deliveryQueue.recoverPending();
      if (recovery.recovered > 0 || recovery.failed > 0 || recovery.deferred > 0) {
        logger.info(recovery, 'Delivery queue recovery complete');
      }
      this.deliveryQueue.startRetryLoop();
    }

    // Start maintenance reaper (cleans spill files, failed deliveries, stale temps)
    if (this.reaper) {
      this.reaper.start();
    }

    // Start rate limiter cleanup (prunes stale user buckets every 5 minutes)
    this.rateLimiter?.startCleanup();

    // Start cron scheduler for scheduled jobs.
    // Cron jobs are submitted to the inbox (not executed directly) so they
    // are serialized with user turns — prevents SSE stream interleaving.
    //
    // On platform-linked runtimes we deliberately skip starting it: agents
    // route all recurring work through Platform Pulse (pulse_create_task
    // with is_recurring=true), and heartbeat is driven operator-side by the
    // bridge reading HEARTBEAT.md. Any local jobs.json entries left on disk
    // from before this gate was in place are therefore inert — the file
    // persists for audit / restore, but nothing fires.
    const platformLinked = process.env['PLATFORM_PULSE_CONNECTED'] === '1';
    if (this.cronStore && !platformLinked) {
      this.cronScheduler = new CronScheduler({
        store: this.cronStore,
        submitToInbox: (msg) => this.inbox.push(msg),
      });
      this.cronScheduler.start();
    } else if (platformLinked) {
      logger.info('Platform-linked runtime — local cron scheduler disabled (use Pulse recurring tasks)');
    }

    // Fire SessionStart lifecycle hook
    if (this.hookEngine?.hasHooks('SessionStart')) {
      const hookEnv: Record<string, string> = {
        SESSION_ID: this.sessionId ?? '',
        MODEL: this.model,
        CWD: this.cwd,
      };
      await this.hookEngine.runHooks('SessionStart', hookEnv);
    }

    // Start plugin services (background tasks)
    if (this.pluginLoader) {
      await this.pluginLoader.startServices();
    }

    // Publish this gateway's telemetry window so renderMetrics() can read it
    setActiveTelemetryWindow(this.gatewayTelemetryWindow);

    logger.info('Agent process started — waiting for messages');
    // Clear stale capacity latches from other harnesses (e.g. leftover
    // self:claude-token-pool-exhausted while this seat runs Cortex/shizuha).
    // Hive is SoT for identity; self-availability is only a capacity signal.
    void import('../platform/pulse-self-availability.js').then(({ markPulseSelfAvailability }) =>
      markPulseSelfAvailability({
        active: true,
        reason: 'gateway startup — seat live',
        executionMethod: process.env['EXECUTION_METHOD'] || 'shizuha',
        logPrefix: 'gateway',
      }),
    ).catch(() => { /* best-effort */ });
    this.startTelemetry();
    this.startIdleHeartbeat();

    // P99<=5s invariant (operator 2026-07-14): pre-warm the prefix cache before
    // processing any work. After a restart (harness roll, env re-render, crash)
    // the first REAL turn used to pay the full cold prefill of the restored
    // context (~30-70s at 60-160k tokens on GB10 prefill) — a p99-destroying
    // event on every fleet roll. Pay it here instead, tagged
    // requestKind='warmup' so Cortex routes it to the session's warm home
    // (that's the point) and meters it under bulk_ttft, invisible to the
    // interactive SLO. Inbox messages accumulate during the warm-up and are
    // processed immediately after. Fail-open: any error just proceeds cold.
    await this.prewarmPrefixCache();
    await this.prewarmManagedGrokFallbackPrefix(this.model, 'restart');

    // Main loop — runs forever
    while (this.running) {
      try {
        if (this.runtimeRollDrain.active) {
          await this.waitForRuntimeRollDrainRelease();
          continue;
        }
        const msg = await this.inbox.next();
        this.inboxMessageAdmitted = true;
        // Close the dequeue/arm race: a drain armed while next() resolved must
        // retain the row, not start a new turn after the controller saw idle.
        if (this.runtimeRollDrain.active) {
          this.inbox.pushFront([msg]);
          this.inboxMessageAdmitted = false;
          this.markRuntimeRollReadyIfIdle();
          await this.waitForRuntimeRollDrainRelease();
          continue;
        }
        try {
          await this.processInboxMessage(msg);
        } finally {
          this.inboxMessageAdmitted = false;
        }
      } catch (err) {
        this.inboxMessageAdmitted = false;
        if (!this.running) break; // Shutdown
        this.recordRecentError(err);
        logger.error({ err }, 'Error in agent main loop');
        this.emitTelemetry();
      }
    }
  }

  /** P99<=5s invariant (2026-07-14): re-prefill the restored session on the
   *  provider BEFORE serving turns, so restart cold-prefills never land in
   *  interactive TTFT. Mirrors the REAL turn payload (same systemPrompt,
   *  toolDefs, thinkingLevel, messages via messagesToChat) — a byte-divergent
   *  warm-up would prefill the wrong prefix and warm nothing. Cortex-tier
   *  models only (they carry the prefill cost); small contexts skip (their
   *  cold prefill is already under the SLO). */
  /** In-process single-flight for prewarm (pair with Cortex session supersede). */
  private prewarmInFlight: Promise<boolean> | null = null;

  private async prewarmPrefixCache(
    model = this.model,
    provider = this.provider,
    options: PrefixPrewarmOptions = {},
  ): Promise<boolean> {
    // Coalesce concurrent prewarms in this process (rapid restart races).
    if (this.prewarmInFlight) {
      logger.info('Prefix pre-warm already in flight — coalescing');
      return this.prewarmInFlight;
    }
    this.prewarmInFlight = this.runPrewarmPrefixCache(model, provider, options).finally(() => {
      this.prewarmInFlight = null;
    });
    return this.prewarmInFlight;
  }

  private async runPrewarmPrefixCache(
    model: string,
    provider: LLMProvider,
    options: PrefixPrewarmOptions,
  ): Promise<boolean> {
    const reason = options.reason ?? 'restart';
    // Warmups RETIRED fleet-wide (operator 2026-08-07): a warmup racing the
    // real turn re-prefilled the OLD home for 190s before being superseded
    // (agent-sato), and under the router's rehome/no-spill-rebind model the
    // gateway's view of "home" can lag Cortex's — so a warmup can rebuild the
    // wrong lane entirely. Cold prefills now land in the real turn's TTFT
    // (client patience is 30 min); with eviction storms fixed those events are
    // rare. Escape hatch: SHIZUHA_PREWARM_ENABLE=1 restores the old behavior.
    if (process.env['SHIZUHA_PREWARM_ENABLE'] !== '1') {
      logger.debug({ reason }, 'Prefix pre-warm skipped — warmups retired (SHIZUHA_PREWARM_ENABLE!=1)');
      return true;
    }
    try {
      // Prewarm benefits models served by LOCAL vLLM with server-side prefix
      // caching. The old guard checked only the LEGACY `cortex/` prefix — but
      // the fleet migrated to clean model IDs (e.g. `DeepSeek-V4-Flash`, no
      // prefix), so this silently no-op'd on every DeepSeek agent (zero warmup
      // telemetry over 24h; the #1 residual p99 breach cause 2026-07-14).
      // isCortexModelId() matches both the legacy prefix AND clean family IDs.
      // Managed passthroughs (xAI/grok) have no local prefix cache to warm.
      const m = model || '';
      if (!isCortexModelId(m)) return true;
      const lower = m.toLowerCase();
      if (lower.startsWith('xai/') || lower.includes('grok')) return true;
      // Prefix warming is a Cortex routing/cache contract, not a portable
      // provider operation. Provider-filter exactly so fallback providers do
      // not receive a duplicate one-token completion after compaction.
      if (provider?.name !== 'cortex') return true;
      if (!provider || this.messages.length === 0) return true;
      const minTokens = Number.parseInt(process.env['SHIZUHA_PREWARM_MIN_TOKENS'] ?? '20000', 10);
      // Eligibility must measure the payload we actually send below. After a
      // compaction/fallback, the retained messages can be tiny while the
      // system prompt and tool schemas still make the request a 40-60K-token
      // cold prefill. Counting messages alone made that path report a
      // successful no-op prewarm, so the real successor remained interactive
      // and paid the rebuild in its TTFT.
      const messageTokens = estimateTokens(this.messages, model);
      const overheadTokens = estimateOverheadTokens(this.systemPrompt, this.toolDefs, model);
      const estimatedPromptTokens = messageTokens + overheadTokens;
      if (!Number.isFinite(estimatedPromptTokens)) return true;
      // A rewritten prefix is cold by definition, irrespective of its token
      // count. Nami's 18,246-token post-compaction payload fell below the
      // generic 20K restart floor and charged a 7.8s rebuild to the immediate
      // interactive request. Always prewarm post-compaction payloads exactly;
      // retain the floor only for restart/idle maintenance economics.
      if (
        reason !== 'post_compaction'
        && reason !== 'soft_drain_rehome'
        && estimatedPromptTokens < Math.max(1_000, minTokens)
      ) return true;
      const { messagesToChat, toolDefinitionsForProvider } = await import('../agent/turn.js');
      const chatMessages = messagesToChat(this.messages);
      const providerToolDefs = toolDefinitionsForProvider(this.toolDefs, provider);
      const prewarmPrefixSnapshot = buildProviderPrefixSnapshot({
        model,
        contextWindow: this.maxContextTokens,
        systemPrompt: this.systemPrompt,
        tools: providerToolDefs,
        chatMessages,
      });
      const timeoutMs = Number.parseInt(process.env['SHIZUHA_PREWARM_TIMEOUT_MS'] ?? '180000', 10);
      // DeepSeek-V4's hybrid APC can acknowledge the first maintenance prefill
      // before every cache group is reusable by the immediate successor. The
      // observed post-compaction sequence was 7.2s warmup, then a still-slow
      // identical 5.0s request, then a 286ms append. Two byte-identical serial
      // passes make that convergence maintenance work instead of user TTFT.
      const warmupPasses = lower.includes('deepseek-v4-flash') ? 2 : 1;
      const started = Date.now();
      logger.info({
        reason,
        rehomeIntent: options.rehomeIntent === true,
        estimatedPromptTokens,
        messageTokens,
        overheadTokens,
        timeoutMs,
        warmupPasses,
      }, 'Pre-warming Cortex prefix cache (requestKind=warmup)');
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), Math.max(10_000, timeoutMs));
      try {
        for (let pass = 1; pass <= warmupPasses; pass += 1) {
          for await (const _chunk of provider.chat(chatMessages, {
            model,
            systemPrompt: this.systemPrompt,
            tools: providerToolDefs.length > 0 ? providerToolDefs : undefined,
            maxTokens: 1,
            ...(this.thinkingLevel ? { thinkingLevel: this.thinkingLevel } : {}),
            requestKind: 'warmup',
            ...(options.rehomeIntent ? { cortexRehome: 'soft-drain' as const } : {}),
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            abortSignal: ac.signal,
          })) {
            void _chunk; // discard — the prefill side-effect is the product
          }
        }
      } finally {
        clearTimeout(timer);
      }
      // Seed continuity from the payload that actually completed prefill. The
      // first real request must be compared with this maintenance request, not
      // treated as an unobservable first sample. Rewritten-history prewarms
      // likewise establish the new known-warm baseline.
      this.lastProviderPrefixSnapshot = prewarmPrefixSnapshot;
      this.cortexWarmPrefixProofs.set(model, prewarmPrefixSnapshot);
      this.lastCortexPrewarmAt = Date.now();
      if (reason === 'restart' || reason === 'ready_work') {
        this.cortexFirstTurnPrewarmPending = true;
      }
      logger.info({ reason, ms: Date.now() - started }, 'Cortex prefix cache pre-warm complete');
      return true;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const healthError = new Error(`cortex_prefix_prewarm_failed reason=${reason}: ${detail}`);
      this.recordRecentError(healthError);
      this.emitTelemetry();
      logger.warn({
        code: 'cortex_prefix_prewarm_failed',
        reason,
        err: detail,
      }, 'Cortex prefix pre-warm failed — continuing cold');
      return false;
    }
  }

  /**
   * Managed Grok capacity can disappear between turns when every eligible xAI
   * subscription is cooling or quota-exhausted. A large restored session may
   * only cross over to its configured local Cortex fallback after we have
   * proved that exact fallback prefix warm; otherwise the cold-fallback fence
   * correctly blocks a user-visible multi-minute prefill. Warm at most the
   * first eligible local fallback, using the same bounded maintenance path as
   * restart/post-compaction prewarms.
   */
  private async prewarmManagedGrokFallbackPrefix(
    activeModel: string,
    reason: PrefixPrewarmReason,
  ): Promise<boolean> {
    const activeLower = (activeModel || '').toLowerCase();
    if (!(activeLower.startsWith('xai/') || activeLower.includes('grok'))) return true;

    const { normalizeModelName } = await import('../provider/registry.js');
    for (const fallback of this.modelFallbacks) {
      const fallbackModel = normalizeModelName(fallback.model);
      if (fallbackModel === activeModel) continue;

      let fallbackProvider: LLMProvider;
      try {
        fallbackProvider = this.providerReg.resolve(fallbackModel);
      } catch {
        continue;
      }
      const fallbackLower = fallbackModel.toLowerCase();
      if (
        fallbackProvider?.name !== 'cortex'
        || !isCortexModelId(fallbackModel)
        || fallbackLower.startsWith('xai/')
        || fallbackLower.includes('grok')
      ) continue;

      logger.info({
        activeModel,
        fallbackModel,
        reason,
      }, 'Pre-warming managed-Grok local fallback prefix');
      return this.prewarmPrefixCache(fallbackModel, fallbackProvider, { reason });
    }
    return true;
  }

  /** Refresh a rollout/startup warmup when scheduling delayed the first work
   * beyond the APC freshness lease. Event-driven: runs only on that first inbox
   * item, never as a fleet sweep or idle timer. */
  private async refreshStaleFirstTurnPrewarmBeforeWork(): Promise<boolean> {
    if (!this.cortexFirstTurnPrewarmPending || this.lastCortexPrewarmAt <= 0) return true;
    const configured = Number.parseInt(
      process.env['SHIZUHA_PREWARM_FRESHNESS_MS'] ?? '60000',
      10,
    );
    const freshnessMs = Number.isFinite(configured)
      ? Math.max(5_000, configured)
      : 60_000;
    const ageMs = Math.max(0, Date.now() - this.lastCortexPrewarmAt);
    if (ageMs <= freshnessMs) return true;
    logger.info({ ageMs, freshnessMs }, 'First work exceeded Cortex prewarm freshness — refreshing exact prefix');
    return this.prewarmPrefixCache(this.model, this.provider, { reason: 'ready_work' });
  }

  private modelMaxTokens(): number {
    if (this.maxContextTokens > 0) return this.maxContextTokens;
    const m = (this.model || '').toLowerCase();
    if (m.includes('1m') || m.includes('-1m')) return 1_000_000;
    if (m.includes('262') || m.includes('256k')) return 262_144;
    if (m.includes('128k')) return 131_072;
    if (m.startsWith('claude')) return 200_000;
    if (m.startsWith('gpt-5') || m.startsWith('o3') || m.startsWith('o4')) return 272_000;
    if (m.startsWith('gemini')) return 1_000_000;
    return 272_000;
  }

  private maxOutputTokensForMessage(msg: InboundMessage, turnIndex = 0): number {
    if (msg.source !== 'heartbeat') return this.maxOutputTokens;
    // The heartbeat cap exists to keep IDLE heartbeats cheap (check alerts,
    // check queue, end the turn). It must NOT starve real work: the message
    // source stays 'heartbeat' for the whole processing loop, so capping every
    // turn held working agents at 4096 output tokens per turn — and thinking
    // models spend from the SAME budget (DeepSeek at effort=max can burn most
    // of it in reasoning before the tool-call JSON starts), truncating large
    // Write turns mid-JSON as incomplete 'max_tokens' turns (2026-08-09).
    // After the first turn the agent has demonstrably found work — later turns
    // get the normal budget.
    if (turnIndex > 0) return this.maxOutputTokens;
    const parsed = Number.parseInt(process.env['SHIZUHA_HEARTBEAT_MAX_OUTPUT_TOKENS'] ?? '', 10);
    const heartbeatCap = Number.isFinite(parsed) && parsed > 0 ? parsed : 4096;
    return Math.max(512, Math.min(this.maxOutputTokens, heartbeatCap));
  }

  private recordRecentError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg) return;
    this.recentErrors.push(msg.slice(0, 500));
    if (this.recentErrors.length > 10) this.recentErrors.splice(0, this.recentErrors.length - 10);
  }

  private buildTelemetry(): Record<string, unknown> {
    const records = this.gatewayTelemetryWindow.query();
    const latest = records[records.length - 1];
    const totalInput = records.reduce((sum, r) => sum + (r.inputTokens || 0), 0);
    const totalOutput = records.reduce((sum, r) => sum + (r.outputTokens || 0), 0);
    const latestInput = latest?.inputTokens ?? 0;
    const maxTok = this.modelMaxTokens();
    const decodeTps = latest?.decodeTokensPerSec;
    const fallbackTps = latest && latest.timeOnTurnMs > 0
      ? Number(((latest.outputTokens || 0) / (latest.timeOnTurnMs / 1000)).toFixed(1))
      : 0;

    const recentErrors = this.recentErrors.slice(-10);
    const health = gatewayHealthFromRecentErrors(recentErrors);
    const agentId = this.config.agentId ?? process.env['AGENT_ID'] ?? null;

    return {
      v: 1,
      ts: Date.now(),
      agent_username: this.config.agentUsername ?? process.env['AGENT_USERNAME'] ?? null,
      agent_id: agentId,
      runtime: {
        harness: 'shizuha-gateway',
        model: this.model,
        provider: latest?.provider || (this.provider as { name?: string } | null)?.name || 'unknown',
        version: process.env['SHIZUHA_RUNTIME_VERSION'] ?? null,
        host: os.hostname(),
        pid: process.pid,
        uptime_ms: Date.now() - this.startTime,
      },
      context: {
        used_tokens: latestInput,
        max_tokens: maxTok,
        pct: maxTok && latestInput ? Number(((latestInput / maxTok) * 100).toFixed(1)) : null,
      },
      usage: {
        total_input_tokens: totalInput,
        total_output_tokens: totalOutput,
        total_output_chars: null,
        turns: records.length,
        tokens_per_sec: typeof decodeTps === 'number' ? decodeTps : fallbackTps,
      },
      activity: buildActivityTelemetry(this.activityPhase, {
        busy: this.inbox.busy || this.inboxMessageAdmitted,
        queueDepth: this.inbox.depth,
        lastActivityAt: this.lastActivityAt,
      }),
      health: {
        ...health,
        recent_errors: recentErrors,
      },
      heartbeat: agentId ? heartbeatQueueDrainTelemetry(agentId) : null,
    };
  }

  private emitTelemetry(): void {
    const payload = this.buildTelemetry();
    for (const channel of this.channels.values()) {
      try { channel.sendTelemetry?.(payload); } catch { /* telemetry is best-effort */ }
    }
  }

  private startTelemetry(): void {
    const ms = Number(process.env['SHIZUHA_TELEMETRY_INTERVAL_MS'] ?? 30_000);
    if (this.telemetryTimer) clearInterval(this.telemetryTimer);
    this.telemetryTimer = setInterval(() => this.emitTelemetry(), ms);
    if (this.telemetryTimer.unref) this.telemetryTimer.unref();
    this.emitTelemetry();
    logger.info({ intervalMs: ms }, 'Gateway telemetry enabled');
  }

  /** Intrinsic scheduler heartbeat (SCLI-49). Native to the gateway so every
   *  shizuha-runtime agent periodically returns to Pulse's canonical queue.
   *  Cadence is independent of routine Connect task hints: if a turn is busy,
   *  one checkpoint is queued for the next safe boundary. Direct/control
   *  traffic stays ahead of it, and routine notifications stay behind it.
   *  Direct Pulse preflight keeps empty checkpoints model-free. */
  private startIdleHeartbeat(): void {
    if (process.env['SHIZUHA_IDLE_HEARTBEAT_DISABLED'] === '1') return;
    const NUDGE = IDLE_HEARTBEAT_NUDGE;
    logger.info({ idleHeartbeatMs: this.idleHeartbeatMs, firstHeartbeatMs: this.firstHeartbeatMs, heartbeatDebounceMs: this.heartbeatDebounceMs }, 'Idle-heartbeat armed (SCLI-49 + SCLI-71 early first beat)');
    const tickIdleHeartbeat = async () => {
      try {
        const now = Date.now();
        const talkedSinceBoot = this.lastActivityAt > this.bootAt;
        const prefixWarm = this.firstHeartbeatPending
          && isLeanConversationalEnv()
          && now >= this.nextHeartbeatDueAt
          && !talkedSinceBoot
          && !this.inbox.busy;
        if (!prefixWarm && !idleHeartbeatAdmissionAllowed({
          running: this.running,
          busy: this.inbox.busy,
          pendingHeartbeat: this.inbox.hasClass('heartbeat'),
          now,
          nextDueAt: this.nextHeartbeatDueAt,
          lastActivityAt: this.lastActivityAt,
          minIdleMs: this.idleHeartbeatMs,
        })) {
          // Recently active: park the next due at the real idle threshold so
          // a just-talked seat never gets a heartbeat injected.
          if (
            this.running
            && !this.inbox.busy
            && !this.inbox.hasClass('heartbeat')
            && this.lastActivityAt > 0
            && (now - this.lastActivityAt) < this.idleHeartbeatMs
          ) {
            this.nextHeartbeatDueAt = this.lastActivityAt + this.idleHeartbeatMs;
          }
          return;
        }
        const ch = [...this.channels.values()][0];
        if (!ch) return;                                                    // no channel to run a turn on
        this.lastHeartbeatAt = now;
        this.firstHeartbeatPending = false;
        this.nextHeartbeatDueAt = now + Math.max(this.idleHeartbeatMs, this.heartbeatDebounceMs);
        const readyWork = prefixWarm ? null : await this.hasReadyPulseWorkForIdleHeartbeat();
        if (readyWork === false && !prefixWarm) {
          const agentId = this.config.agentId ?? this.config.agentName ?? 'unknown-agent';
          try {
            const empty = recordObservedEmptyPulseQueue(agentId);
            console.log(formatHeartbeatQueueDrainOutcomeLogLine(empty));
            this.emitTelemetry();
          } catch (err) {
            logger.warn({ err, agentId }, 'Failed to record empty-queue idle heartbeat');
          }
          logger.info({
            idleMs: now - this.lastActivityAt,
            skippedModel: true,
            pulseReadyWork: false,
          }, 'idle_tick skipped model: inbox empty and direct Pulse queue empty');
          return;
        }
        if (prefixWarm) {
          logger.info({ firstHeartbeatMs: this.firstHeartbeatMs }, 'lean prefix-warm heartbeat queued');
        }
        this.inbox.push({
          id: crypto.randomUUID(),
          channelId: ch.id,
          channelType: ch.type,
          threadId: `heartbeat-${this.config.agentId}`,
          userId: 'system',
          userName: 'heartbeat',
          content: NUDGE,
          timestamp: now,
          source: 'heartbeat',
          metadata: {
            // Event-driven cache residency: only a positive Pulse preflight
            // proves that this idle beat will do real work. The serialized
            // inbox consumer prewarms immediately before that turn; empty
            // queues still make zero model calls.
            idleHeartbeatReadyWork: readyWork === true,
          },
        });
        logger.info({
          cadenceMs: this.idleHeartbeatMs,
          busy: this.inbox.busy,
          queueDepth: this.inbox.depth,
        }, 'Intrinsic scheduler heartbeat queued (SCLI-49)');
      } catch (err) {
        this.recordRecentError(err);
        logger.error({ err }, 'Idle heartbeat error');
        this.emitTelemetry();
      }
    };
    this.idleHeartbeatTimer = setInterval(() => { void tickIdleHeartbeat(); }, 60 * 1000);
    if (isLeanConversationalEnv() && this.firstHeartbeatMs < 60_000) {
      this.firstWarmTimer = setTimeout(() => { void tickIdleHeartbeat(); }, this.firstHeartbeatMs);
    }
  }

  /** Stop the agent process gracefully. */
  async stop(): Promise<void> {
    this.running = false;
    this.runtimeRollDrain.dispose();
    if (this.idleHeartbeatTimer) { clearInterval(this.idleHeartbeatTimer); this.idleHeartbeatTimer = null; }
    if (this.firstWarmTimer) { clearTimeout(this.firstWarmTimer); this.firstWarmTimer = null; }
    if (this.telemetryTimer) { clearInterval(this.telemetryTimer); this.telemetryTimer = null; }
    this.telemetryFlusher.stop();
    // SCLI-415: a pending single-row replay timer must not outlive the process.
    // Firing it after teardown reaches a closed StateStore and throws from a
    // timer callback (uncaught). Undispatched rows are still `deferred`, so the
    // successor drains them cleanly — dropping the timer loses nothing durable.
    if (this.deferredReplayTimer) { clearTimeout(this.deferredReplayTimer); this.deferredReplayTimer = null; }
    this.deferredReplayEpisodeId = null;
    this.inbox.clear();

    // Fire SessionStop lifecycle hook before teardown
    if (this.hookEngine?.hasHooks('SessionStop')) {
      const hookEnv: Record<string, string> = {
        SESSION_ID: this.sessionId ?? '',
        MODEL: this.model,
        CWD: this.cwd,
      };
      await this.hookEngine.runHooks('SessionStop', hookEnv).catch(() => {}); // best-effort on shutdown
    }

    // Shutdown plugin services
    if (this.pluginLoader) {
      await this.pluginLoader.shutdown();
    }

    // Stop cron scheduler
    if (this.cronScheduler) {
      this.cronScheduler.stop();
    }

    // Stop rate limiter cleanup
    this.rateLimiter?.stopCleanup();

    // Stop maintenance reaper and delivery retry loop before tearing down channels
    if (this.reaper) {
      this.reaper.stop();
    }
    if (this.deliveryQueue) {
      this.deliveryQueue.stopRetryLoop();
    }

    for (const channel of this.channels.values()) {
      try {
        await channel.stop();
      } catch (err) {
        logger.error({ channelId: channel.id, err }, 'Error stopping channel');
      }
    }

    if (this.mcpManager) {
      await this.mcpManager.disconnectAll();
    }
    if (this.store) {
      this.store.close();
    }
  }

  // ── Private ──

  /**
   * Keep the fallback pin aligned when an external failover path changes the
   * active runtime model without rebuilding modelFallbacks. The daemon can
   * restart an agent directly on a later cross-method step (for example
   * DeepSeek) while the fallback chain's first entry is still Codex. In that
   * state the pin must follow the healthy active model; otherwise every loop
   * re-probes the stale Codex entry and can trip same-error auto-andons.
   */
  private alignPinnedFallbackIndexWithActiveModel(
    activeModel: string,
    normalizeModelName: (model: string) => string,
  ): boolean {
    if (this.modelFallbacks.length === 0) return false;
    const normalizedActiveModel = normalizeModelName(activeModel);
    const matchingIndex = this.modelFallbacks.findIndex((fallback) =>
      normalizeModelName(fallback.model) === normalizedActiveModel);
    if (matchingIndex < 0 || matchingIndex === this.pinnedFallbackIndex) return false;

    const previousPinned = this.modelFallbacks[this.pinnedFallbackIndex];
    logger.info({
      activeModel: normalizedActiveModel,
      previousPinnedModel: previousPinned ? normalizeModelName(previousPinned.model) : undefined,
      previousPinnedFallbackIndex: this.pinnedFallbackIndex,
      pinnedFallbackIndex: matchingIndex,
    }, 'Aligning pinned fallback index with active model');
    this.pinnedFallbackIndex = matchingIndex;
    this.pinnedFallbackAt = matchingIndex > 0 ? Date.now() : 0;
    return true;
  }

  /** Re-enter configured-primary policy after a bounded fallback cooldown. */
  private retryConfiguredPrimaryIfDue(
    normalizeModelName: (model: string) => string,
    now = Date.now(),
  ): boolean {
    if (this.modelFallbacks.length < 2 || this.pinnedFallbackIndex <= 0) return false;
    const configured = Number.parseInt(process.env['SHIZUHA_FALLBACK_PRIMARY_RETRY_MS'] ?? '300000', 10);
    const retryAfterMs = Number.isFinite(configured) ? Math.max(30_000, configured) : 300_000;
    if (this.pinnedFallbackAt > 0 && now - this.pinnedFallbackAt < retryAfterMs) return false;

    const primary = this.modelFallbacks[0]!;
    const primaryModel = normalizeModelName(primary.model);
    const primaryProviderName = (primary as { provider?: string }).provider;
    const primaryProvider = primaryProviderName
      ? this.providerReg.get(primaryProviderName) ?? this.providerReg.resolve(primaryModel)
      : this.providerReg.resolve(primaryModel);
    logger.info({
      fromModel: this.modelFallbacks[this.pinnedFallbackIndex]?.model,
      toModel: primaryModel,
      pinnedForMs: this.pinnedFallbackAt > 0 ? now - this.pinnedFallbackAt : null,
    }, 'Fallback cooldown elapsed — retrying configured primary');
    this.pinnedFallbackIndex = 0;
    this.pinnedFallbackAt = 0;
    this.model = primaryModel;
    this.provider = primaryProvider;
    return true;
  }

  /**
   * Execute a turn with model fallback support.
   * Tries the active model first, then each fallback in order on eligible errors.
   * Pins to whichever model succeeds so subsequent turns use it directly.
   */
  private async executeTurnWithFallback(
    executeTurn: typeof import('../agent/turn.js').executeTurn,
    activeModel: string,
    activeProvider: any,
    useFallbackChain: boolean,
    toolContext: any,
    msg: InboundMessage,
    channel: Channel,
    forceHeartbeatQueueTool = false,
    requestKind?: string,
    onCortexRehomeRequired?: () => void,
    turnIndex = 0,
  ): Promise<any> {
    const isManagedGrokModel = (model: string): boolean => {
      const lower = model.toLowerCase();
      return lower.startsWith('xai/') || lower.includes('grok');
    };
    const isLocalCortexModel = (provider: any, model: string): boolean =>
      provider?.name === 'cortex' && isCortexModelId(model) && !isManagedGrokModel(model);
    const transientFailure = (err: unknown): boolean => {
      const typed = err as Error & {
        code?: string | number;
        type?: string;
        retryable?: boolean;
        status?: number;
      };
      return isTransientProviderFailure({
        message: typed?.message,
        code: typed?.code,
        type: typed?.type,
        retryable: typed?.retryable,
        status: typed?.status,
      });
    };
    const hasWarmFallbackProof = async (model: string, provider: any): Promise<boolean> => {
      const proof = this.cortexWarmPrefixProofs.get(model);
      if (!proof) return false;
      const configured = Number.parseInt(
        process.env['SHIZUHA_FALLBACK_WARM_PROOF_MAX_AGE_MS'] ?? '300000',
        10,
      );
      const maxAgeMs = Number.isFinite(configured) ? Math.max(5_000, configured) : 300_000;
      if (Date.now() - proof.createdAt > maxAgeMs) return false;
      const { messagesToChat, toolDefinitionsForProvider } = await import('../agent/turn.js');
      const snapshot = buildProviderPrefixSnapshot({
        model,
        contextWindow: this.maxContextTokens,
        systemPrompt: this.systemPrompt,
        tools: toolDefinitionsForProvider(this.toolDefs, provider),
        chatMessages: messagesToChat(this.messages),
      });
      return !compareProviderPrefixSnapshots(proof, snapshot).cacheBreaking;
    };
    const coldFallbackTokenLimitRaw = Number.parseInt(
      // At the observed ~2K cold-prefill tok/s, 65K permits a ~30s miss. Keep
      // the unproven path below the operator's 5s ceiling; append-compatible
      // warm proof bypasses this cold-only fence.
      process.env['SHIZUHA_COLD_FALLBACK_MAX_PROMPT_TOKENS'] ?? '8192',
      10,
    );
    const coldFallbackTokenLimit = Number.isFinite(coldFallbackTokenLimitRaw)
      ? Math.max(1_000, coldFallbackTokenLimitRaw)
      : 8_192;

    // Resolve per-entry effort/thinking for the active model (pinned or primary)
    const resolveEntrySettings = (index: number) => {
      const entry = this.modelFallbacks[index];
      return {
        thinking: entry?.thinkingLevel ?? this.thinkingLevel,
        effort: entry?.reasoningEffort ?? this.reasoningEffort,
      };
    };

    const maxOutputTokens = this.maxOutputTokensForMessage(msg, turnIndex);
    const doTurn = async (provider: any, model: string, thinking?: string, effort?: string) => {
      const heartbeatQueueTool = !talkSeatSuppressesTools()
        && forceHeartbeatQueueTool
        && provider?.name === 'cortex'
        ? this.toolDefs.find((tool) => tool.name.endsWith('__pulse_get_my_alerts'))
        : undefined;
      let rehomeRequiredForAttempt = false;
      if (isLocalCortexModel(provider, model)) {
        // This exact real attempt consumes the startup freshness fence. A
        // failed maintenance warmup remains visible in health telemetry, but
        // must not cause every later inbox item to issue another hidden fill.
        this.cortexFirstTurnPrewarmPending = false;
      }
      const result = await executeTurn(
        this.messages, provider, model, this.systemPrompt, this.toolDefs,
        this.toolRegistry, this.permissions, this.emitter, toolContext,
        maxOutputTokens, this.temperature,
        undefined, // onPermissionAsk
        this.hookEngine ?? undefined,
        thinking ?? this.thinkingLevel,
        (() => {
          const ms = talkSeatTurnTimeoutMs();
          return ms ? AbortSignal.timeout(ms) : undefined;
        })(),
        effort ?? this.reasoningEffort,
        undefined, // fastMode
        undefined, // paramCoercion
        undefined, // toolRetry
        {
          // PLAT-4189 follow-up: fleet-gateway append-only payload check (was
          // undefined — fleet agents had no client-side prefix observability).
          contextWindow: this.maxContextTokens,
          observe: (snapshot) => this.observeProviderPrefixContinuity(snapshot),
          // Frozen wire prefix (operator 2026-08-08): payload_n+1 =
          // stored_payload_n ++ convert(new tail) — identity, not
          // re-derivation, so restarts cannot change the serialization.
          ...(this.providerWirePrefix ? { wirePrefix: this.providerWirePrefix } : {}),
          captureWirePayload: (chatMessages, internalCount) =>
            this.captureProviderWirePayload(chatMessages, internalCount),
          ...(requestKind ? { requestKind } : {}),
          ...(onCortexRehomeRequired
            ? { onCortexRehomeRequired: () => { rehomeRequiredForAttempt = true; } }
            : {}),
        },
        talkSeatSuppressesTools()
          ? 'none'
          : heartbeatQueueTool ? {
              type: 'function',
              function: { name: heartbeatQueueTool.name },
            } : undefined,
      );
      // A `required` header belongs to this exact provider attempt. Surface it
      // only if that same attempt completed successfully; an errored stream
      // followed by a healthy fallback must not rehome the fallback's session.
      if (rehomeRequiredForAttempt) onCortexRehomeRequired?.();
      if (
        isLocalCortexModel(provider, model)
        && this.lastProviderPrefixSnapshot?.model === model
      ) {
        // Only a completed provider attempt is durable warm-prefix evidence.
        // The observer runs before streaming; recording in the observer would
        // incorrectly bless a request whose upstream stream then failed.
        this.cortexWarmPrefixProofs.set(model, this.lastProviderPrefixSnapshot);
      }
      return result;
    };

    // Try active model first (use per-entry settings from the pinned/primary entry)
    const activeSettings = resolveEntrySettings(this.pinnedFallbackIndex);
    try {
      return await doTurn(activeProvider, activeModel, activeSettings.thinking, activeSettings.effort);
    } catch (primaryErr) {
      const primaryStatus = Number((primaryErr as { status?: number })?.status || 0);
      if (this.hiveXaiLease && (primaryStatus === 401 || /401|unauthorized|invalid_grant/i.test(String((primaryErr as Error)?.message || '')))) {
        const rotated = await leaseHiveXaiAccess({
          stickyKey: `agent:${this.config.agentUsername || this.config.agentId || 'gateway'}`,
          preferredEntryId: this.hiveXaiLease.token.entryId,
          forceRefresh: true,
        });
        if (rotated) {
          this.hiveXaiLease = rotated;
          this.provider = rotated.provider;
          logger.warn({ label: rotated.token.label }, 'Hive xAI lease 401 — rotated access token via coordinator');
          return await doTurn(rotated.provider, hiveDirectXaiUpstreamModel(this.model || HIVE_XAI_GROK_MODEL), activeSettings.thinking, activeSettings.effort);
        }
      }
      if (!useFallbackChain || !AgentProcess.isFallbackEligible(primaryErr)) {
        throw primaryErr;
      }

      let primaryFailure = primaryErr;
      const primaryIsManagedGrok = isManagedGrokModel(activeModel);
      const primaryIsTransient = transientFailure(primaryFailure);

      // A transient managed-provider stream failure must not turn a 245K Grok
      // session into a 159s cold DeepSeek prefill. Retry the selected provider
      // once after its own route-level retries before evaluating a cross-family
      // fallback; the guard below still permits a proven-warm fallback.
      if (primaryIsManagedGrok && primaryIsTransient) {
        const retriesRaw = Number.parseInt(process.env['SHIZUHA_TRANSIENT_PRIMARY_RETRIES'] ?? '1', 10);
        const retries = Number.isFinite(retriesRaw) ? Math.min(2, Math.max(0, retriesRaw)) : 1;
        for (let attempt = 0; attempt < retries; attempt++) {
          logger.warn({ model: activeModel, attempt: attempt + 1 }, 'Transient managed-provider failure — retrying same provider before fallback');
          try {
            return await doTurn(activeProvider, activeModel, activeSettings.thinking, activeSettings.effort);
          } catch (retryErr) {
            primaryFailure = retryErr;
            if (!transientFailure(retryErr)) throw retryErr;
          }
        }
      }

      logger.warn(
        { model: activeModel, error: (primaryFailure as Error).message },
        'Primary model failed, trying fallback chain',
      );

      // Try each model in the fallback chain (skip the one that just failed)
      const { normalizeModelName } = await import('../provider/registry.js');
      for (let i = 0; i < this.modelFallbacks.length; i++) {
        if (i === this.pinnedFallbackIndex) continue; // skip the one that just failed

        const fb = this.modelFallbacks[i]!;
        const fbModel = normalizeModelName(fb.model);

        let fbProvider: any;
        try {
          // Use explicit provider override if specified, otherwise auto-resolve
          const fbProviderName = (fb as { provider?: string }).provider;
          if (fbProviderName) {
            fbProvider = this.providerReg.get(fbProviderName);
            if (!fbProvider) throw new Error(`Provider '${fbProviderName}' not configured`);
          } else {
            fbProvider = this.providerReg.resolve(fbModel);
          }
        } catch {
          logger.warn({ model: fbModel, provider: (fb as { provider?: string }).provider }, 'Fallback model provider not available, skipping');
          continue;
        }

        if (
          primaryIsManagedGrok
          && transientFailure(primaryFailure)
          && isLocalCortexModel(fbProvider, fbModel)
        ) {
          const estimatedPromptTokens = AgentProcess.providerWireTokenEstimate(
            this.messages,
            fbModel,
            this.systemPrompt,
            this.toolDefs,
          );
          let warmProof = await hasWarmFallbackProof(fbModel, fbProvider);
          if (estimatedPromptTokens > coldFallbackTokenLimit && !warmProof) {
            // A previously warm fallback proof can age out while an agent is
            // pinned or idle. Re-establish the exact prefix as bounded,
            // maintenance-class work before deciding whether failover is safe.
            // The real fallback remains forbidden unless the completed warmup
            // produced a fresh append-compatible proof.
            await this.prewarmPrefixCache(fbModel, fbProvider, { reason: 'ready_work' });
            warmProof = await hasWarmFallbackProof(fbModel, fbProvider);
          }
          if (estimatedPromptTokens > coldFallbackTokenLimit && !warmProof) {
            logger.error({
              code: 'cold_cross_provider_fallback_blocked',
              fromModel: activeModel,
              toModel: fbModel,
              estimatedPromptTokens,
              coldFallbackTokenLimit,
            }, 'Blocked unproven cold cross-provider fallback for large session');
            continue;
          }
        }

        // Notify channel about the fallback
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'model_fallback',
            fromModel: activeModel,
            toModel: fbModel,
            reason: (primaryFailure as Error).message?.slice(0, 200) ?? 'unknown error',
            fallbackIndex: i,
            chainLength: this.modelFallbacks.length,
            timestamp: Date.now(),
          } as any);
        } catch { /* swallow send errors */ }

        try {
          const fbSettings = resolveEntrySettings(i);
          const result = await doTurn(fbProvider, fbModel, fbSettings.thinking, fbSettings.effort);
          // Success — pin this model for future turns
          this.pinnedFallbackIndex = i;
          this.pinnedFallbackAt = i > 0 ? Date.now() : 0;
          this.model = fbModel;
          this.provider = fbProvider;
          logger.info(
            { fromModel: activeModel, toModel: fbModel, fallbackIndex: i },
            'Model fallback succeeded — pinned',
          );
          return result;
        } catch (fbErr) {
          logger.warn(
            { model: fbModel, error: (fbErr as Error).message },
            'Fallback model also failed, trying next',
          );
          continue;
        }
      }

      // All fallbacks exhausted — throw the original error
      throw primaryFailure;
    }
  }

  /** PLAT-4189 follow-up: merge newly-activated MCP tool names into the
   *  per-agent persistence file so restarts pre-activate the same set at setup
   *  (byte-stable prompt head). Sorted + deduped; fail-open. */
  private persistActivatedMcpTools(added: string[]): void {
    if (!this.activatedMcpToolsPath || added.length === 0) return;
    try {
      let names: string[] = [];
      try {
        const current = JSON.parse(fs.readFileSync(this.activatedMcpToolsPath, 'utf-8')) as unknown;
        if (Array.isArray(current)) names = current.filter((n): n is string => typeof n === 'string');
      } catch { /* first write */ }
      const merged = [...new Set([...names, ...added])].sort();
      fs.writeFileSync(this.activatedMcpToolsPath, JSON.stringify(merged, null, 2));
    } catch { /* diagnostics-only persistence — never break a turn */ }
  }

  /** PLAT-4189 follow-up: gateway append-only continuity check over the
   *  canonical provider payload (system prompt + tool schema + messages).
   *  Mirrors the loop.ts observer the fleet gateway never had — every fleet
   *  agent's prefix behaviour was previously invisible client-side. Returns the
   *  continuity so executeTurn can emit a provider_status prefix_cache_break
   *  event; WARNs with the first mismatching message index on any
   *  non-append-only payload. Fail-open; disable: SHIZUHA_PREFIX_CONTINUITY=0. */
  private observeProviderPrefixContinuity(snapshot: ProviderPrefixSnapshot): ProviderPrefixContinuity | undefined {
    const raw = (process.env['SHIZUHA_PREFIX_CONTINUITY'] ?? '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') return undefined;
    try {
      const continuity = compareProviderPrefixSnapshots(this.lastProviderPrefixSnapshot, snapshot);
      this.lastProviderPrefixSnapshot = snapshot;
      // PLAT-4189: persist every observation so the NEXT process resume can
      // diff against what this one actually sent (cross-restart forensics).
      try { this.store.saveProviderPrefixSnapshot?.(this.sessionId, snapshot); } catch { /* diagnostics-only */ }
      if (continuity.cacheBreaking) {
        logger.warn(
          { agent: this.config.agentName ?? this.config.agentId, ...providerPrefixContinuityLogFields(continuity) },
          providerPrefixContinuityLogMessage(continuity),
        );
        // Keep the persisted head aligned with what this process now actually
        // sends, so a later restart pins to current reality (PLAT-4189).
        try {
          this.store.saveProviderPrefixHead?.(this.sessionId, {
            createdAt: Date.now(), model: snapshot.model,
            systemPrompt: this.systemPrompt, toolDefs: JSON.stringify(this.toolDefs),
          });
        } catch { /* head persistence is best-effort */ }
      } else {
        logger.debug(
          { agent: this.config.agentName ?? this.config.agentId, ...providerPrefixContinuityLogFields(continuity) },
          providerPrefixContinuityLogMessage(continuity),
        );
      }
      return continuity;
    } catch {
      return undefined;
    }
  }

  /** Check if an error from executeTurn is eligible for model fallback. */
  private static isFallbackEligible(err: unknown): boolean {
    if (!(err instanceof Error)) return true;
    const msg = err.message.toLowerCase();
    // Abort/cancel — user-initiated, don't fallback
    if (msg.includes('abort') || msg.includes('cancel') || msg.includes('interrupted')) return false;
    // Content policy — model understood but refused, switching model won't help
    if (msg.includes('content policy') || msg.includes('safety filter')) return false;
    // Everything else (rate limit, server error, auth, connection, provider config) — try fallback
    return true;
  }

  private static providerWireTokenEstimateRaw(
    messages: Message[],
    model: string,
    systemPrompt: string,
    toolDefs: ToolDefinition[],
  ): number {
    // Match the vLLM preflight guard's conservative shape closely enough for
    // gateway trimming: JSON-wire serialization is the thing that counts old
    // persisted image payloads. The cheaper semantic estimator deliberately
    // charges images as ~1600 tokens, but Qwen vision profiles send image_url
    // data URLs; a single retained screenshot can become hundreds of thousands
    // of prompt tokens. Counting JSON here makes the pre-provider gate see the
    // same class of bloat before vLLM throws CONTEXT_WINDOW_TOO_SMALL.
    return countTokens(systemPrompt, model)
      + countTokens(JSON.stringify(messages), model)
      + (toolDefs.length > 0 ? countTokens(JSON.stringify(toolDefs), model) : 0);
  }

  private static providerWireTokenEstimate(
    messages: Message[],
    model: string,
    systemPrompt: string,
    toolDefs: ToolDefinition[],
  ): number {
    return Math.ceil(
      AgentProcess.providerWireTokenEstimateRaw(messages, model, systemPrompt, toolDefs) * getSafetyFactor(model),
    );
  }

  /**
   * Read-only provider-fit assertion. It deliberately returns no rewritten
   * messages: an oversized gateway prompt must go through semantic compaction or
   * fail closed with the exact active projection intact.
   */
  private static inspectContextBudget(
    messages: Message[],
    model: string,
    maxContextTokens: number,
    systemPrompt: string,
    toolDefs: ToolDefinition[],
    outputBudget: number,
    reportedPromptTokens = 0,
  ): { exceeded: boolean; promptTokens: number; targetTokens: number } {
    // Provider truth calibrates the conservative JSON-wire estimate. It may
    // reduce false positives, but can never authorize a context rewrite.
    let wireFactor = getSafetyFactor(model);
    if (reportedPromptTokens > 0) {
      const rawFull = AgentProcess.providerWireTokenEstimateRaw(messages, model, systemPrompt, toolDefs);
      if (rawFull > 0) {
        const calibrated = (reportedPromptTokens / rawFull) * 1.10;
        wireFactor = Math.min(Math.max(calibrated, 0.25), wireFactor);
      }
    }
    const guardTokens = 1024;
    const targetTokens = Math.max(
      4096,
      maxContextTokens - Math.max(outputBudget, 512) - guardTokens,
    );
    const promptTokens = Math.ceil(
      AgentProcess.providerWireTokenEstimateRaw(messages, model, systemPrompt, toolDefs) * wireFactor,
    );
    return { exceeded: promptTokens > targetTokens, promptTokens, targetTokens };
  }

  private static isContextWindowTooSmallError(err: unknown): boolean {
    const e = err as (Error & { code?: string }) | undefined;
    const msg = e?.message ?? String(err);
    return e?.code === 'CONTEXT_WINDOW_TOO_SMALL'
      || /context window exhausted|context.*too.small|CONTEXT_WINDOW_TOO_SMALL/i.test(msg);
  }

  /**
   * Pre-compaction memory flush — extract key facts from recent conversation
   * and persist them to the memory store before context compaction destroys them.
   *
   * Scans recent assistant messages for patterns that indicate memorable content:
   * decisions, user preferences, task outcomes, names/dates, and important findings.
   * Writes them to the workspace memory store so they survive compaction.
   */
  private async flushPreCompactionMemory(): Promise<void> {
    const memDir = path.join(this.cwd, 'memory');
    fs.mkdirSync(memDir, { recursive: true });

    // Collect recent assistant messages (the ones about to be compacted)
    const recentAssistant: string[] = [];
    for (let i = Math.max(0, this.messages.length - 20); i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg?.role !== 'assistant') continue;
      const text = Array.isArray(msg.content)
        ? msg.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof msg.content === 'string' ? msg.content : '';
      if (text.length > 50) recentAssistant.push(text.slice(0, 2000));
    }
    if (recentAssistant.length === 0) return;

    // Extract sentences that look like facts, decisions, or outcomes
    const factPatterns = [
      /(?:decided|chose|agreed|concluded|determined|found|discovered|confirmed|verified|noted)\s+(?:to|that)\s+.{10,200}/gi,
      /(?:the user|user prefers?|preference|important|remember|critical|key finding|takeaway)[:\s]+.{10,200}/gi,
      /(?:deployed|fixed|resolved|completed|implemented|created|updated|configured)\s+.{10,150}/gi,
    ];

    const extracted = new Set<string>();
    for (const text of recentAssistant) {
      for (const pattern of factPatterns) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
          const fact = match[0].trim().replace(/\s+/g, ' ');
          if (fact.length > 20 && fact.length < 300) extracted.add(fact);
        }
      }
    }

    if (extracted.size === 0) return;

    // Append to workspace memory with timestamp
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const sessionLog = path.join(memDir, 'session-log.md');
    const lines = [`\n## Auto-saved before compaction (${now})\n`];
    for (const fact of extracted) {
      lines.push(`- ${fact}`);
    }
    lines.push('');

    fs.appendFileSync(sessionLog, lines.join('\n'));
    logger.info({ count: extracted.size }, 'Pre-compaction memory flush');
  }

  /**
   * GAP E: Validate compacted messages — ensure they form a valid conversation.
   * Returns false if the compacted output is invalid (empty, roles don't alternate, etc.)
   */
  /** Longest run of consecutive user/assistant same-role messages. */
  private static maxConsecutiveSameRole(messages: Message[]): number {
    let lastRole = '';
    let run = 0;
    let maxRun = 0;
    for (const msg of messages) {
      if (msg.role === lastRole && (msg.role === 'user' || msg.role === 'assistant')) {
        run++;
        if (run > maxRun) maxRun = run;
      } else {
        run = 0;
      }
      lastRole = msg.role;
    }
    return maxRun;
  }

  private validateCompactedMessages(messages: Message[], sourceMessages?: Message[]): boolean {
    // Must have at least one message
    if (!messages || messages.length === 0) {
      logger.warn('Compaction produced empty message list');
      return false;
    }

    // Every message must have non-empty content
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      if (!msg.role) {
        logger.warn({ index: i }, 'Compacted message missing role');
        return false;
      }
      // Content can be string or array of blocks — must not be completely empty
      if (msg.content === undefined || msg.content === null) {
        logger.warn({ index: i, role: msg.role }, 'Compacted message has null/undefined content');
        return false;
      }
      if (typeof msg.content === 'string' && msg.content.length === 0 && msg.role === 'assistant') {
        logger.warn({ index: i }, 'Compacted assistant message has empty string content');
        return false;
      }
    }

    // Check role alternation — user/assistant should roughly alternate
    // (tool results may follow assistant, system messages can appear anywhere).
    // 2026-08-09 agent-kai incident: the flat >3 threshold PERMANENTLY doomed
    // compaction for any session whose preserved suffix legitimately contains
    // a longer same-role run (queued inbox user messages, tool-result
    // batches). Every cycle: 299K cold summarization (~3-6min of fleet
    // prefill), 'Compaction complete', validator reject, retry next turn —
    // forever — while also monopolizing the fleet-wide compaction serializer
    // against interactive resumes. A shape that already exists in the SOURCE
    // history is not evidence of a broken compaction: the tolerated run is
    // max(3, longest run in the source).
    const allowedRun = Math.max(
      3,
      sourceMessages ? AgentProcess.maxConsecutiveSameRole(sourceMessages) : 3,
    );
    let lastRole = '';
    let consecutiveSameRole = 0;
    for (const msg of messages) {
      if (msg.role === lastRole && (msg.role === 'user' || msg.role === 'assistant')) {
        consecutiveSameRole++;
        if (consecutiveSameRole > allowedRun) {
          logger.warn({ role: msg.role, count: consecutiveSameRole, allowedRun }, 'Compaction produced too many consecutive same-role messages');
          return false;
        }
      } else {
        consecutiveSameRole = 0;
      }
      lastRole = msg.role;
    }

    return true;
  }

  /** Load or create the agent's single eternal session. */
  private loadEternalSession(): void {
    const agentSessionId = this.config.agentId
      ? `${AGENT_SESSION_PREFIX}${this.config.agentId}`
      : `${AGENT_SESSION_PREFIX}default`;

    const existing = this.store.loadSession(agentSessionId);
    if (existing) {
      this.sessionId = existing.id;
      this.messages = [...existing.messages];
      const recovery = this.store.loadExpensiveTurnRecovery?.(existing.id) as ExpensiveTurnRecoveryState | null;
      this.sessionGeneration = recovery?.activeGeneration ?? 0;
      // PLAT-4189: seed the continuity observer with the last persisted
      // snapshot so the FIRST post-restart turn produces a real attribution
      // diff (which section/tool/message diverged) instead of a blind
      // "first-observation". Restart is exactly where prefix divergence
      // happens; without this the instrument resets exactly when it matters.
      try {
        this.lastProviderPrefixSnapshot = this.store.loadProviderPrefixSnapshot?.(existing.id) ?? null;
      } catch { this.lastProviderPrefixSnapshot = null; }
      // Frozen wire prefix: replay the exact payload bytes the previous
      // process last sent (hatch: SHIZUHA_WIRE_PREFIX_RESUME=0).
      if (process.env['SHIZUHA_WIRE_PREFIX_RESUME'] !== '0') {
        try {
          const wp = this.store.loadWirePrefix?.(existing.id);
          if (wp && wp.sourceCount > 0 && wp.sourceCount <= this.messages.length) {
            const parsed = JSON.parse(wp.messagesJson) as unknown;
            if (Array.isArray(parsed) && parsed.length > 0) {
              this.providerWirePrefix = {
                sourceCount: wp.sourceCount,
                messages: parsed as import('../provider/types.js').ChatMessage[],
              };
              logger.info({
                sessionId: this.sessionId,
                wireSourceCount: wp.sourceCount,
                wireMessages: parsed.length,
              }, 'Wire-prefix resume: replaying the exact previously-sent payload prefix');
            }
          }
        } catch { this.providerWirePrefix = null; }
      }
      // Provider-tokenizer truth must survive the restart with the payload.
      // The loader hash-validates that the current messages are an append-only
      // continuation of the exact request that produced the anchor, so a
      // compaction/trim between save and resume invalidates it automatically.
      try {
        const anchor = this.store.loadContextTokenAnchor?.(existing.id, this.model, this.messages);
        if (anchor) {
          this.lastReportedPromptTokens = anchor.providerInputTokens > 0
            ? anchor.providerInputTokens
            : anchor.providerPromptEstimate;
          this.lastReportedRawEstimateTokens = anchor.rawPromptTokens;
          logger.info({
            sessionId: this.sessionId,
            anchorMessageCount: anchor.messageCount,
            currentMessageCount: this.messages.length,
            providerInputTokens: anchor.providerInputTokens,
            rawPromptTokens: anchor.rawPromptTokens,
          }, 'Resume restored provider-tokenizer context anchor');
        }
      } catch { /* anchor restore is best-effort; cold estimate still works */ }
      logger.info({
        sessionId: this.sessionId,
        messageCount: this.messages.length,
        sessionGeneration: this.sessionGeneration,
        hasPersistedPrefixSnapshot: this.lastProviderPrefixSnapshot != null,
      }, 'Resumed eternal session');
    } else {
      // Create with a deterministic ID so it's always the same
      this.store.createSessionWithId(agentSessionId, this.model, this.cwd);
      this.sessionId = agentSessionId;
      this.messages = [];
      this.sessionGeneration = 0;
      logger.info({ sessionId: this.sessionId }, 'Created new eternal session');
    }
  }

  /** PLAT-4189 resume pin. Compares the freshly composed prompt head against
   *  the byte-exact head the previous process last sent. Identical → no-op.
   *  Same tool NAME set but drifted bytes (git context, memory, skill catalog,
   *  tool descriptions) → adopt the persisted serialization verbatim and defer
   *  the fresh composition to the next compaction, where the prefix cache
   *  breaks anyway. Different tool name set → real capability change: adopt
   *  fresh (one-time rebuild) and log exactly what changed.
   *  Disable: SHIZUHA_RESUME_PROMPT_PIN=0. Fail-open. */
  private applyResumePromptPin(): void {
    const raw = (process.env['SHIZUHA_RESUME_PROMPT_PIN'] ?? '').trim().toLowerCase();
    if (raw === '0' || raw === 'false' || raw === 'off') return;
    try {
      if (typeof this.store.loadProviderPrefixHead !== 'function'
        || typeof this.store.saveProviderPrefixHead !== 'function') return;
      const freshToolDefsJson = JSON.stringify(this.toolDefs);
      const persisted = this.store.loadProviderPrefixHead(this.sessionId);
      if (!persisted || persisted.model !== this.model) {
        this.store.saveProviderPrefixHead(this.sessionId, {
          createdAt: Date.now(), model: this.model,
          systemPrompt: this.systemPrompt, toolDefs: freshToolDefsJson,
        });
        return;
      }
      const samePrompt = persisted.systemPrompt === this.systemPrompt;
      if (samePrompt && persisted.toolDefs === freshToolDefsJson) return; // byte-stable resume — the invariant held
      let persistedDefs: ToolDefinition[] = [];
      try {
        const parsed = JSON.parse(persisted.toolDefs) as unknown;
        if (Array.isArray(parsed)) persistedDefs = parsed as ToolDefinition[];
      } catch { /* corrupt head — fall through to fresh adoption */ }
      const freshNames = this.toolDefs.map((t) => t.name).sort();
      const persistedNames = persistedDefs.map((t) => t.name).sort();
      const sameNameSet = persistedDefs.length > 0
        && freshNames.length === persistedNames.length
        && freshNames.every((name, i) => name === persistedNames[i]);
      if (sameNameSet && persisted.systemPrompt.length > 0) {
        this.pendingPromptRefresh = { systemPrompt: this.systemPrompt, toolDefs: this.toolDefs };
        const changedSections = diffSystemPromptSections(
          hashSystemPromptSections(persisted.systemPrompt),
          hashSystemPromptSections(this.systemPrompt),
        );
        this.systemPrompt = persisted.systemPrompt;
        this.toolDefs = persistedDefs;
        logger.warn({
          agent: this.config.agentName ?? this.config.agentId,
          samePrompt,
          changedSections,
          pinnedPromptChars: persisted.systemPrompt.length,
          freshPromptChars: this.pendingPromptRefresh.systemPrompt.length,
        }, 'PLAT-4189 resume pin: adopted previous process prompt head verbatim; fresh composition deferred to next compaction');
      } else {
        const added = freshNames.filter((n) => !persistedNames.includes(n));
        const removed = persistedNames.filter((n) => !freshNames.includes(n));
        this.store.saveProviderPrefixHead(this.sessionId, {
          createdAt: Date.now(), model: this.model,
          systemPrompt: this.systemPrompt, toolDefs: freshToolDefsJson,
        });
        logger.warn({
          agent: this.config.agentName ?? this.config.agentId,
          addedTools: added, removedTools: removed,
        }, 'PLAT-4189 resume pin: tool set changed across restart — adopting fresh head (one-time full prefix rebuild)');
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'PLAT-4189 resume pin failed open — using fresh composition');
    }
  }

  /** Adopt the composition held back by the resume pin. Called when history is
   *  rewritten (compaction) — the prefix cache is broken at that point anyway,
   *  so the head refresh is free. */
  private adoptPendingPromptRefresh(reason: string): void {
    if (!this.pendingPromptRefresh) return;
    const refresh = this.pendingPromptRefresh;
    this.pendingPromptRefresh = null;
    this.systemPrompt = refresh.systemPrompt;
    this.toolDefs = refresh.toolDefs;
    try {
      this.store.saveProviderPrefixHead?.(this.sessionId, {
        createdAt: Date.now(), model: this.model,
        systemPrompt: this.systemPrompt, toolDefs: JSON.stringify(this.toolDefs),
      });
    } catch { /* head persistence is best-effort */ }
    logger.info({ agent: this.config.agentName ?? this.config.agentId, reason },
      'PLAT-4189 resume pin: pending prompt refresh adopted');
  }

  /** Persist the exact provider payload just sent as the frozen wire prefix
   *  for the NEXT payload (operator 2026-08-08: provably identical
   *  re-serialization). Runs on every provider call; the store row is the
   *  cross-restart truth, the field the in-process copy. */
  private captureProviderWirePayload(
    chatMessages: import('../provider/types.js').ChatMessage[],
    internalCount: number,
  ): void {
    if (process.env['SHIZUHA_WIRE_PREFIX_RESUME'] === '0') return;
    try {
      this.providerWirePrefix = { sourceCount: internalCount, messages: chatMessages };
      this.store.saveWirePrefix?.(this.sessionId, internalCount, JSON.stringify(chatMessages));
    } catch { /* forensic/continuity machinery must never break a turn */ }
  }

  /** Mark agent activity — resets the SCLI-49 idle-heartbeat timer so the
   *  intrinsic idle nudge doesn't fire while the agent is actively processing
   *  inbound messages. */
  private touchActivity(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * SCLI-347 production guard branch (message-feed loop).
   * Order: log → notify → generation fence → drain → bounded successor.
   * Tests must call this (or runExpensiveTurnGuardProductionSequence) rather
   * than recoverSessionAfterExpensiveTurnGuard alone.
   */
  private async applyExpensiveTurnPauseBranch(
    decision: Exclude<ExpensiveTurnGuardDecision, { action: 'ok' }>,
    activeModel: string,
    currentMessage?: InboundMessage,
  ): Promise<void> {
    logger.warn({
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      ...decision,
    }, 'SCLI-195 expensive-turn guard breaking message-feed loop');
    void this.notifyExpensiveTurnGuard(decision, activeModel).catch((err) => {
      logger.warn({ err }, 'SCLI-195 expensive-turn guard notification failed');
    });
    await this.recoverSessionAfterExpensiveTurnGuard(
      decision,
      activeModel,
      currentMessage,
    );
  }

  /**
   * @internal SCLI-345 test hook — production sequence:
   * ExpensiveTurnGuard.record samples → pause branch → recover → store rewrite.
   * Do not call recoverSessionAfterExpensiveTurnGuard alone in regressions.
   */
  async runExpensiveTurnGuardProductionSequence(
    samples: Array<{
      now: number;
      inputTokens: number;
      outputTokens: number;
      toolCallCount?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      prefixCacheBusted?: boolean;
      ttftMs?: number | null;
      source?: string;
      channelType?: string;
    }>,
    activeModel: string,
  ): Promise<ExpensiveTurnGuardDecision> {
    let decision: ExpensiveTurnGuardDecision = { action: 'ok' };
    for (const sample of samples) {
      decision = this.expensiveTurnGuard.record({
        now: sample.now,
        inputTokens: sample.inputTokens,
        outputTokens: sample.outputTokens,
        toolCallCount: sample.toolCallCount,
        cacheReadTokens: sample.cacheReadTokens,
        cacheCreationTokens: sample.cacheCreationTokens,
        prefixCacheBusted: sample.prefixCacheBusted,
        ttftMs: sample.ttftMs,
        source: (sample.source as any) ?? 'heartbeat',
        channelType: sample.channelType,
      });
    }
    if (decision.action === 'pause') {
      await this.applyExpensiveTurnPauseBranch(decision, activeModel);
    }
    return decision;
  }

  private async recoverSessionAfterExpensiveTurnGuard(
    decision: Exclude<ExpensiveTurnGuardDecision, { action: 'ok' }>,
    activeModel: string,
    currentMessage?: InboundMessage,
  ): Promise<void> {
    if (!this.sessionId) return;
    const beforeCount = this.messages.length;
    const sourceSnapshot = this.messages.map((message) => ({ ...message }));
    const beforeBudget = estimatePromptTokenBudget({
      messages: sourceSnapshot,
      systemPrompt: this.systemPrompt || '',
      toolDefs: this.toolDefs || [],
      model: activeModel,
    });
    const maxCtx = this.maxContextTokens > 0 ? this.maxContextTokens : 128_000;
    const recoveryTarget = Math.max(8_000, Math.floor(maxCtx * 0.5));
    const firstInboxDrain = this.drainInboxForRecovery();
    // The current message is already admitted: executeTurnWithFallback has
    // completed all of its tool calls before the guard decision is recorded.
    // Its id is captured as lastAcknowledgedMessageId in the recovery capsule,
    // but it must never enter the deferred replay ledger and execute twice.
    const firstFeed = classifyRecoveryFeed(
      firstInboxDrain.messages,
      firstInboxDrain.coalescedHeartbeats,
    );
    const episodeId = crypto.randomUUID();
    let recovery = this.store.beginExpensiveTurnRecovery(
      this.sessionId,
      episodeId,
      beforeCount,
      beforeBudget.promptTokenEstimate,
      this.serializeDeferredRecoveryMessages(firstFeed),
      firstFeed.counters,
    ) as ExpensiveTurnRecoveryState;
    // Fence is durable now; no callback from the source generation may emit.
    this.sessionGeneration = recovery.targetGeneration;

    // Idempotent re-entry: an existing episode remains authoritative.
    if (recovery.episodeId !== episodeId && recovery.state === 'recovery_pending') {
      this.sessionGeneration = recovery.activeGeneration;
      this.enqueueExpensiveTurnRecoveryBootstrap(recovery);
      return;
    }

    const { compactMessagesRequired } = await import('../state/compaction.js');
    const semanticTarget = Math.max(4_000, recoveryTarget - 4_096);
    let compactionOutcome = 'exact_context_preserved_under_target';
    let compactedCandidate = sourceSnapshot;
    if (beforeBudget.promptTokenEstimate > semanticTarget) {
      const compacted = await compactMessagesRequired(
        sourceSnapshot,
        this.provider,
        activeModel,
        maxCtx,
        {
          overheadTokens: beforeBudget.systemOverheadTokens + beforeBudget.toolDefinitionTokens,
          targetFinalTokens: semanticTarget,
          force: true,
        },
      );
      compactedCandidate = compacted.messages;
      compactionOutcome = 'semantic_compaction_succeeded';
    }
    if (!this.validateCompactedMessages(compactedCandidate, this.messages)) {
      throw new Error('Semantic expensive-turn compaction produced an invalid transcript; history was preserved');
    }

    // Messages can arrive between the generation fence and successor commit.
    // Detach and persist that suffix before the successor becomes authoritative.
    const lateInboxDrain = this.drainInboxForRecovery();
    const lateFeed = classifyRecoveryFeed(
      lateInboxDrain.messages,
      lateInboxDrain.coalescedHeartbeats,
    );
    if (lateFeed.deferred.length > 0 || lateFeed.counters.coalesced > 0) {
      recovery = this.store.appendExpensiveTurnRecoveryDeferred(
        this.sessionId,
        recovery.episodeId,
        this.serializeDeferredRecoveryMessages(lateFeed),
        lateFeed.counters,
      ) as ExpensiveTurnRecoveryState;
    }
    const unresolvedHumanMessageIds = [
      ...firstFeed.unresolvedHumanMessageIds,
      ...lateFeed.unresolvedHumanMessageIds,
    ];
    const capsule = this.buildExpensiveTurnRecoveryCapsule(
      recovery,
      currentMessage?.id,
      unresolvedHumanMessageIds,
    );
    let successor = [capsule, ...compactedCandidate];
    let successorEstimate = estimatePromptTokenBudget({
      messages: successor,
      systemPrompt: this.systemPrompt || '',
      toolDefs: this.toolDefs || [],
      model: activeModel,
    }).promptTokenEstimate;
    if (successorEstimate > recoveryTarget) {
      const capsuleTokens = Math.ceil(estimateTokens([capsule], activeModel) * getSafetyFactor(activeModel));
      const tighter = await compactMessagesRequired(
        compactedCandidate,
        this.provider,
        activeModel,
        maxCtx,
        {
          overheadTokens: beforeBudget.systemOverheadTokens + beforeBudget.toolDefinitionTokens,
          targetFinalTokens: Math.max(1_000, recoveryTarget - capsuleTokens),
          force: true,
        },
      );
      compactedCandidate = tighter.messages;
      compactionOutcome = 'semantic_compaction_succeeded';
      if (!this.validateCompactedMessages(compactedCandidate, this.messages)) {
        throw new Error('Tighter semantic expensive-turn compaction produced an invalid transcript; history was preserved');
      }
      successor = [capsule, ...compactedCandidate];
      successorEstimate = estimatePromptTokenBudget({
        messages: successor,
        systemPrompt: this.systemPrompt || '',
        toolDefs: this.toolDefs || [],
        model: activeModel,
      }).promptTokenEstimate;
      if (successorEstimate > recoveryTarget) {
        throw new Error(
          `Semantic expensive-turn compaction could not meet its recovery target (${successorEstimate}/${recoveryTarget} tokens); history was preserved`,
        );
      }
    }

    recovery = this.store.commitExpensiveTurnSuccessor(
      this.sessionId,
      recovery.episodeId,
      successor,
      compactionOutcome,
    ) as ExpensiveTurnRecoveryState;
    this.messages.length = 0;
    this.messages.push(...successor);
    this.sessionGeneration = recovery.activeGeneration;
    this.lastReportedPromptTokens = 0;
    this.enqueueExpensiveTurnRecoveryBootstrap(recovery);
    const afterEstimate = estimatePromptTokenBudget({
      messages: successor,
      systemPrompt: this.systemPrompt || '',
      toolDefs: this.toolDefs || [],
      model: activeModel,
    }).promptTokenEstimate;
    logger.warn({
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      episodeId: recovery.episodeId,
      sourceGeneration: recovery.fencedGeneration,
      targetGeneration: recovery.targetGeneration,
      beforeCount,
      afterCount: this.messages.length,
      beforeEstimate: beforeBudget.promptTokenEstimate,
      afterEstimate,
      recoveryTarget,
      maxContextTokens: maxCtx,
      outcome: compactionOutcome,
      counters: recovery.counters,
      inputTokens: decision.inputTokens,
      prefillTokens: decision.prefillTokens,
      systemTokens: beforeBudget.systemOverheadTokens,
      toolTokens: beforeBudget.toolDefinitionTokens,
      messageTokens: beforeBudget.messageTokens,
    }, 'SCLI-347 expensive-turn recovery successor committed');
    await this.notifyExpensiveTurnRecoveryOutcome(recovery, compactionOutcome);
  }

  private serializeDeferredRecoveryMessages(feed: ClassifiedRecoveryFeed): DeferredRecoveryMessage[] {
    return feed.deferred.map(({ message, messageClass }) => ({
      messageId: message.id,
      messageClass,
      payload: JSON.stringify(message),
    }));
  }

  private drainInboxForRecovery(): { messages: InboundMessage[]; coalescedHeartbeats: number } {
    const inbox = this.inbox as Inbox & {
      drain?: () => InboundMessage[];
      drainForRecovery?: () => { messages: InboundMessage[]; coalescedHeartbeats: number };
      clear?: () => void;
    };
    if (typeof inbox.drainForRecovery === 'function') return inbox.drainForRecovery();
    if (typeof inbox.drain === 'function') {
      return { messages: inbox.drain(), coalescedHeartbeats: 0 };
    }
    const queued = [...(inbox.queued?.() ?? [])];
    inbox.clear?.();
    return { messages: queued, coalescedHeartbeats: 0 };
  }

  private buildExpensiveTurnRecoveryCapsule(
    recovery: ExpensiveTurnRecoveryState,
    lastAcknowledgedMessageId?: string,
    unresolvedHumanMessageIds: readonly string[] = [],
  ): Message {
    const toolPolicyGeneration = crypto.createHash('sha256').update(JSON.stringify({
      systemPrompt: crypto.createHash('sha256').update(this.systemPrompt || '').digest('hex'),
      tools: (this.toolDefs || []).map((tool) => tool.name).sort(),
    })).digest('hex');
    return {
      role: 'user',
      content: `[System: SCLI-195 expensive-turn guard tripped] [System Recovery Capsule] ${JSON.stringify({
        type: 'expensive_turn_recovery',
        episodeId: recovery.episodeId,
        sourceSessionId: this.sessionId,
        sourceGeneration: recovery.fencedGeneration,
        targetGeneration: recovery.targetGeneration,
        taskSnapshotReference: 'pulse://queue/current',
        lastAcknowledgedMessageId: lastAcknowledgedMessageId ?? null,
        unresolvedHumanMessageIds,
        toolPolicyGeneration,
        counters: recovery.counters,
      })}`,
      timestamp: Date.now(),
    };
  }

  private recoveryBootstrapMessage(recovery: ExpensiveTurnRecoveryState): InboundMessage | null {
    const channel = [...this.channels.values()][0];
    if (!channel) return null;
    return {
      id: `recovery-${recovery.episodeId}-${recovery.attempts + 1}`,
      channelId: channel.id,
      channelType: channel.type,
      threadId: `expensive-turn-recovery-${recovery.episodeId}`,
      userId: 'system',
      userName: 'recovery',
      content: '[HEARTBEAT RECOVERY] The prior transcript generation is fenced. Call mcp__shizuha-pulse__pulse_get_my_alerts directly first, then mcp__shizuha-pulse__pulse_get_my_tasks. After both results, completely work or forward the highest-priority ready item across alerts and tasks; alerts win ties but never preempt higher-priority task WIP. Do not replay deferred feed first. If both inboxes are empty or blocked, report only that verified snapshot.',
      timestamp: Date.now(),
      source: 'heartbeat',
      metadata: { expensiveTurnRecoveryEpisodeId: recovery.episodeId },
    };
  }

  private enqueueExpensiveTurnRecoveryBootstrap(recovery: ExpensiveTurnRecoveryState): void {
    if (recovery.state !== 'recovery_pending' || recovery.attempts >= 2) return;
    const bootstrap = this.recoveryBootstrapMessage(recovery);
    if (!bootstrap) return;
    const inbox = this.inbox as Inbox & { pushFront?: (messages: readonly InboundMessage[]) => void };
    if (typeof inbox.pushFront === 'function') inbox.pushFront([bootstrap]);
    else if (typeof inbox.push === 'function') inbox.push(bootstrap);
  }

  /**
   * Release durable, unacknowledged rows into the live inbox. Rows move to
   * `releasing` before enqueue and remain there until processInboxMessage
   * acknowledges them, so both verified-before-enqueue and enqueue-before-ack
   * crashes replay safely on startup.
   */
  private releaseDeferredRecoveryMessages(recovery: ExpensiveTurnRecoveryState): number {
    if (!this.sessionId) return 0;
    const pending = (this.store.listDeferredRecoveryMessages(
      this.sessionId,
      recovery.episodeId,
    ) as DeferredRecoveryMessage[]).length;
    // SCLI-415: arm the per-row pump instead of releasing the whole FIFO.
    // Marking every row `releasing` and bulk pushFront-ing them is what let a
    // single verified episode place >= minTurns high-prompt turns inside one
    // guard window and re-trip SCLI-195, ratcheting `releasing` far past
    // `replayed` (live: releasing=65 vs replayed=8).
    this.deferredReplayEpisodeId = recovery.episodeId;
    this.pumpDeferredReplay();
    return pending;
  }

  /** SCLI-415: schedule the next single-row release, never more than one timer. */
  private scheduleDeferredReplay(delayMs: number): void {
    if (this.deferredReplayTimer) return;
    this.deferredReplayTimer = setTimeout(() => {
      this.deferredReplayTimer = null;
      this.pumpDeferredReplay();
    }, Math.max(0, delayMs));
    this.deferredReplayTimer.unref?.();
  }

  /**
   * SCLI-415: hand EXACTLY ONE deferred row to the inbox, then stop.
   *
   * The next row is only considered once this one is durably acknowledged
   * (`processInboxMessage` -> markDeferredRecoveryMessageReplayed), so at most
   * one row is ever in `releasing`. Rows this pump has not dispatched stay
   * `deferred`, which is what makes a mid-drain fence re-drainable instead of
   * leaving a bulk `releasing` block in the successor generation.
   */
  private pumpDeferredReplay(): void {
    try {
      this.pumpDeferredReplayInner();
    } catch (err) {
      // SCLI-415: this runs from a timer, so an escaping throw is an UNCAUGHT
      // exception, not a failed release. Teardown races (closed StateStore) are
      // the common case. Stop the pump and leave rows `deferred` — startup
      // re-drains them, so failing quiet here is safe-at-least-once.
      this.deferredReplayEpisodeId = null;
      logger.warn({ err: (err as Error).message }, 'SCLI-415 deferred replay pump stopped');
    }
  }

  private pumpDeferredReplayInner(): void {
    const episodeId = this.deferredReplayEpisodeId;
    if (!this.sessionId || !episodeId) return;
    if (!this.running) return;
    if (this.deferredReplayInFlight || this.deferredReplayTimer) return;

    // Guard is paused (foreground already tripped it): wait it out, never add to it.
    const pauseMs = this.expensiveTurnGuard.remainingPauseMs();
    if (pauseMs > 0) { this.scheduleDeferredReplay(pauseMs); return; }

    // Foreground owns the shared budget — yield while real traffic is queued.
    if (this.inbox.depth > 0) {
      this.scheduleDeferredReplay(this.expensiveTurnGuard.replayPacing().minSpacingMs);
      return;
    }

    // Pace from the LIVE guard thresholds so replay alone cannot satisfy them.
    const { minSpacingMs, perWindowBudget } = this.expensiveTurnGuard.replayPacing();
    const sinceLast = Date.now() - this.lastDeferredReleaseAt;
    if (this.lastDeferredReleaseAt > 0 && sinceLast < minSpacingMs) {
      this.scheduleDeferredReplay(minSpacingMs - sinceLast);
      return;
    }

    // SCLI-415 (reika P1): spacing bounds ROWS per window, but the guard counts
    // TURNS -- one row with a tool call is 2+ samples, so row spacing alone
    // delivers `turnsPerRow x (minTurns - 1)` and replay can still self-trip
    // mid-drain. Admit only while the row's worst observed turn cost still fits
    // under the budget, measured in the guard's own unit.
    const samplesNow = this.expensiveTurnGuard.expensiveSamplesInWindow();
    // Unmeasured rows reserve the entire budget: the cost is unknown, so the
    // only safe admission is an empty window (handled by the floor below).
    const reserve = this.deferredReplayTurnsPerRow ?? perWindowBudget;
    if (samplesNow > 0 && samplesNow + reserve > perWindowBudget) {
      this.scheduleDeferredReplay(this.expensiveTurnGuard.msUntilExpensiveSampleExpiry());
      return;
    }

    const deferred = this.store.listDeferredRecoveryMessages(
      this.sessionId,
      episodeId,
    ) as DeferredRecoveryMessage[];

    for (const item of deferred) {
      let message: InboundMessage;
      try {
        const parsed = JSON.parse(item.payload) as unknown;
        if (!parsed || typeof parsed !== 'object' || (parsed as InboundMessage).id !== item.messageId) {
          throw new Error('payload/message id mismatch');
        }
        message = parsed as InboundMessage;
      } catch (err) {
        // Invalid rows stay unacknowledged and operator-visible; skip to the next.
        logger.warn({
          episodeId,
          messageId: item.messageId,
          err: (err as Error).message,
        }, 'SCLI-347 deferred recovery message payload was invalid; leaving it unacknowledged');
        continue;
      }
      if (!this.store.markDeferredRecoveryMessageReleasing(
        this.sessionId,
        episodeId,
        item.messageId,
      )) continue;
      const metadata = message.metadata && typeof message.metadata === 'object'
        ? message.metadata
        : {};
      const replayed: InboundMessage = {
        ...message,
        metadata: {
          ...metadata,
          expensiveTurnDeferredEpisodeId: episodeId,
          expensiveTurnDeferredMessageId: item.messageId,
        },
      };
      this.deferredReplayInFlight = true;
      this.lastDeferredReleaseAt = Date.now();
      this.deferredReplayTotalSamplesAtDispatch =
        this.expensiveTurnGuard.totalExpensiveSampleCount();
      const inbox = this.inbox as Inbox & { pushFront?: (messages: readonly InboundMessage[]) => void };
      if (typeof inbox.pushFront === 'function') inbox.pushFront([replayed]);
      else inbox.push(replayed);
      return; // exactly one row per pump
    }

    // Nothing dispatchable left (all replayed, or only invalid rows remain).
    this.deferredReplayEpisodeId = null;
  }

  /** SCLI-415: per-state ledger counts, so a ratchet is distinguishable from a slow drain. */
  deferredReplayLedger(episodeId?: string): { deferred: number; releasing: number; replayed: number } | null {
    const id = episodeId ?? this.deferredReplayEpisodeId;
    if (!this.sessionId || !id) return null;
    const counts = this.store.countDeferredRecoveryMessagesByState?.(this.sessionId, id);
    return counts ?? null;
  }

  private async resumeExpensiveTurnRecoveryAtStartup(): Promise<void> {
    if (!this.sessionId) return;
    let recovery = this.store.loadExpensiveTurnRecovery?.(this.sessionId) as ExpensiveTurnRecoveryState | null;
    if (!recovery) return;
    if (recovery.state === 'verified') {
      this.releaseDeferredRecoveryMessages(recovery);
      return;
    }
    if (recovery.state === 'exhausted') return;
    if (recovery.state === 'guard_tripped') {
      const sourceSnapshot = this.messages.map((message) => ({ ...message }));
      const unresolvedHumanMessageIds = (this.store.listDeferredRecoveryMessages(
        this.sessionId,
        recovery.episodeId,
      ) as DeferredRecoveryMessage[])
        .filter((item) => item.messageClass === 'human' || item.messageClass === 'connect_actionable')
        .map((item) => item.messageId);
      const capsule = this.buildExpensiveTurnRecoveryCapsule(
        recovery,
        undefined,
        unresolvedHumanMessageIds,
      );
      const activeModel = this.model;
      const maxCtx = this.maxContextTokens > 0 ? this.maxContextTokens : 128_000;
      const recoveryTarget = Math.max(8_000, Math.floor(maxCtx * 0.5));
      const beforeBudget = estimatePromptTokenBudget({
        messages: sourceSnapshot,
        systemPrompt: this.systemPrompt || '',
        toolDefs: this.toolDefs || [],
        model: activeModel,
      });
      let successorBody = sourceSnapshot;
      let compactionOutcome = 'exact_context_preserved_under_target_after_restart';
      let successorEstimate = estimatePromptTokenBudget({
        messages: [capsule, ...successorBody],
        systemPrompt: this.systemPrompt || '',
        toolDefs: this.toolDefs || [],
        model: activeModel,
      }).promptTokenEstimate;
      if (successorEstimate > recoveryTarget) {
        const capsuleTokens = Math.ceil(estimateTokens([capsule], activeModel) * getSafetyFactor(activeModel));
        const { compactMessagesRequired } = await import('../state/compaction.js');
        const compacted = await compactMessagesRequired(
          sourceSnapshot,
          this.provider,
          activeModel,
          maxCtx,
          {
            overheadTokens: beforeBudget.systemOverheadTokens + beforeBudget.toolDefinitionTokens,
            targetFinalTokens: Math.max(1_000, recoveryTarget - capsuleTokens),
            force: true,
          },
        );
        successorBody = compacted.messages;
        if (!this.validateCompactedMessages(successorBody, this.messages)) {
          throw new Error('Restart recovery semantic compaction produced an invalid transcript; persisted history was preserved');
        }
        compactionOutcome = 'semantic_compaction_succeeded_after_restart';
        successorEstimate = estimatePromptTokenBudget({
          messages: [capsule, ...successorBody],
          systemPrompt: this.systemPrompt || '',
          toolDefs: this.toolDefs || [],
          model: activeModel,
        }).promptTokenEstimate;
      }
      if (successorEstimate > recoveryTarget) {
        throw new Error(
          `Restart recovery semantic compaction could not meet its target (${successorEstimate}/${recoveryTarget} tokens); persisted history was preserved`,
        );
      }
      recovery = this.store.commitExpensiveTurnSuccessor(
        this.sessionId,
        recovery.episodeId,
        [capsule, ...successorBody],
        compactionOutcome,
      ) as ExpensiveTurnRecoveryState;
      this.messages.length = 0;
      this.messages.push(capsule, ...successorBody);
      this.sessionGeneration = recovery.activeGeneration;
      this.lastReportedPromptTokens = 0;
      logger.warn({
        episodeId: recovery.episodeId,
        sourceGeneration: recovery.fencedGeneration,
        targetGeneration: recovery.targetGeneration,
        counters: recovery.counters,
        compactionOutcome,
      }, 'SCLI-347 completed interrupted recovery with a provider-safe successor');
    }
    this.enqueueExpensiveTurnRecoveryBootstrap(recovery);
  }

  private async pauseForExpensiveTurnGuardIfNeeded(msg: InboundMessage): Promise<void> {
    const delayMs = this.expensiveTurnGuard.remainingPauseMs();
    if (delayMs <= 0) return;
    this.inbox.busy = true;
    logger.warn({
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      delayMs,
      source: msg.source ?? 'user',
      channelType: msg.channelType,
    }, 'SCLI-195 expensive-turn guard pausing inbox before next message');
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.inbox.busy = false;
  }

  private async notifyExpensiveTurnGuard(decision: Exclude<ExpensiveTurnGuardDecision, { action: 'ok' }>, model: string): Promise<void> {
    if (!decision.notify) return;
    const recipientUsername = expensiveTurnGuardNotifyUsername();
    if (!recipientUsername) {
      logger.warn({
        agentId: this.config.agentId,
        agentName: this.config.agentName,
        team: process.env['AGENT_TEAM'],
      }, 'SCLI-195 expensive-turn guard tripped but no lead username was configured');
      return;
    }
    const agent = this.config.agentName ?? this.config.agentId ?? process.env['AGENT_USERNAME'] ?? 'unknown-agent';
    const content = [
      `🔴 SCLI-195 expensive-turn guard tripped for ${agent}.`,
      `Model: ${model}.`,
      `Observed ${decision.turnCount} sterile high-prefill turns in ${Math.round(decision.windowMs / 1000)}s `
        + `(${decision.callsPerMinute.toFixed(1)} calls/min; toolCalls=${decision.toolCallCount}), `
        + `~${decision.prefillTokens} prefill tokens `
        + `(${decision.inputTokens} reported prompt tokens) / `
        + `${decision.outputTokens} text tokens. `
        + `Tool-calling turns are not counted as sterile.`,
      `Paused inbox for ${Math.round(decision.backoffMs / 1000)}s to break the message-feed loop.`,
    ].join(' ');
    const result = await sendConnectDm({
      recipientUsername,
      content,
      clientMessageId: `scli-195-${agent}-${decision.pauseUntil}`,
      sender: { username: process.env['AGENT_USERNAME'] || undefined, agentId: this.config.agentId },
    });
    if (!result.ok) {
      logger.warn({
        recipientUsername,
        status: result.status,
        error: result.error,
      }, 'SCLI-195 expensive-turn guard lead notification failed');
    }
  }

  private async notifyExpensiveTurnRecoveryOutcome(
    recovery: ExpensiveTurnRecoveryState,
    outcome: string,
  ): Promise<void> {
    const recipientUsername = expensiveTurnGuardNotifyUsername();
    if (!recipientUsername) return;
    const agent = this.config.agentName ?? this.config.agentId ?? process.env['AGENT_USERNAME'] ?? 'unknown-agent';
    try {
      const result = await sendConnectDm({
        recipientUsername,
        content: [
          `SCLI-347 expensive-turn recovery ${outcome} for ${agent}.`,
          `Generation ${recovery.fencedGeneration} → ${recovery.targetGeneration}; episode ${recovery.episodeId}.`,
          `Feed counters: preserved=${recovery.counters.preserved}, coalesced=${recovery.counters.coalesced}, dropped=${recovery.counters.dropped}, deferred=${recovery.counters.deferred}, replayed=${recovery.counters.replayed}.`,
        ].join(' '),
        clientMessageId: `scli-347-${recovery.episodeId}-${outcome}`,
        sender: { username: process.env['AGENT_USERNAME'] || undefined, agentId: this.config.agentId },
      });
      if (!result.ok) {
        logger.warn({ recipientUsername, status: result.status, error: result.error }, 'SCLI-347 recovery outcome notification failed');
      }
    } catch (err) {
      logger.warn({ recipientUsername, err }, 'SCLI-347 recovery outcome notification threw');
    }
  }

  private async finishExpensiveTurnRecoveryBootstrap(
    episodeId: string,
    forcedOutcome?: HeartbeatQueueDrainOutcome,
  ): Promise<void> {
    if (!this.sessionId) return;
    let recovery = this.store.loadExpensiveTurnRecovery(this.sessionId) as ExpensiveTurnRecoveryState | null;
    if (!recovery || recovery.episodeId !== episodeId || recovery.state !== 'recovery_pending') return;
    const agentId = this.config.agentId ?? this.config.agentName ?? 'unknown-agent';
    const observed = getHeartbeatQueueDrainOutcome(agentId);
    const outcome: HeartbeatQueueDrainOutcome = forcedOutcome ?? observed?.outcome ?? 'not_observed';
    const verified = outcome === 'worked_task'
      || outcome === 'forwarded'
      || outcome === 'queue_empty'
      || outcome === 'all_blocked'
      || outcome === 'future_due';
    const nextAttempt = recovery.attempts + 1;
    const exhausted = !verified && nextAttempt >= 2;
    recovery = this.store.recordExpensiveTurnRecoveryAttempt(
      this.sessionId,
      episodeId,
      outcome,
      verified ? 'verified' : exhausted ? 'exhausted' : null,
    ) as ExpensiveTurnRecoveryState;

    if (verified) {
      const released = this.releaseDeferredRecoveryMessages(recovery);
      logger.warn({
        episodeId,
        outcome,
        attempts: recovery.attempts,
        released,
        sourceGeneration: recovery.fencedGeneration,
        targetGeneration: recovery.targetGeneration,
        counters: recovery.counters,
      }, 'SCLI-347 expensive-turn recovery verified; deferred feed released');
      await this.notifyExpensiveTurnRecoveryOutcome(recovery, 'verified');
      return;
    }

    if (exhausted) {
      logger.error({
        episodeId,
        outcome,
        attempts: recovery.attempts,
        sourceGeneration: recovery.fencedGeneration,
        targetGeneration: recovery.targetGeneration,
        counters: recovery.counters,
      }, 'SCLI-347 expensive-turn recovery exhausted after two bounded attempts');
      await this.notifyExpensiveTurnRecoveryOutcome(recovery, 'exhausted');
      return;
    }

    logger.warn({ episodeId, outcome, attempts: recovery.attempts }, 'SCLI-347 recovery made no useful Pulse progress; scheduling final bounded attempt');
    this.enqueueExpensiveTurnRecoveryBootstrap(recovery);
  }

  /**
   * Process one admitted inbox row, then durably acknowledge a recovery replay.
   * If the process dies before this method returns, the row remains `releasing`
   * and startup re-enqueues it; a completed row increments the forensic counter
   * exactly once.
   */
  private async processInboxMessage(msg: InboundMessage): Promise<void> {
    const channel = this.channels.get(msg.channelId);
    const processingAck = channel?.type === 'connect'
      && Boolean(msg.id)
      && Boolean(this.sessionId)
      && msg.metadata?.['syntheticDigest'] !== true;
    if (processingAck && this.store.inboundProcessingCompleted(this.sessionId!, msg.id)) {
      await channel?.ackProcessed?.(msg.id);
      logger.info({ messageId: msg.id }, 'Acknowledged already-completed Connect replay without re-execution');
      return;
    }
    if (processingAck) {
      this.store.markInboundProcessingAdmitted(this.sessionId!, msg.id, channel!.type);
    }
    const outcome = await this.processMessage(msg);
    if (outcome === false) return;
    if (processingAck) {
      this.store.markInboundProcessingCompleted(this.sessionId!, msg.id);
      const acknowledged = await channel?.ackProcessed?.(msg.id);
      if (!acknowledged) {
        logger.warn({ messageId: msg.id }, 'Connect processing ack was not sent; durable replay will retry it');
      }
    }
    if (!this.sessionId) return;
    const episodeId = msg.metadata?.['expensiveTurnDeferredEpisodeId'];
    const messageId = msg.metadata?.['expensiveTurnDeferredMessageId'];
    if (typeof episodeId !== 'string' || typeof messageId !== 'string') return;
    this.store.markDeferredRecoveryMessageReplayed(this.sessionId, episodeId, messageId);
    // SCLI-415: this row is durably acknowledged, so the pump may consider the
    // next one. Advancing ONLY here is what bounds `releasing` to a single row
    // and keeps the drain converging instead of ratcheting.
    if (this.deferredReplayEpisodeId === episodeId) {
      // SCLI-415: learn this row's ACTUAL turn cost rather than assuming one.
      // A row that fanned out into several tool turns raises the reserve for
      // every subsequent admission, so the bound adapts to real traffic.
      // Monotonic, so samples ageing out mid-row cannot mask this row's real
      // turn count (an in-window delta measured a 3-turn row as 1 and left the
      // reserve permanently stale).
      const consumed = this.expensiveTurnGuard.totalExpensiveSampleCount()
        - this.deferredReplayTotalSamplesAtDispatch;
      if (this.deferredReplayTurnsPerRow === null || consumed > this.deferredReplayTurnsPerRow) {
        this.deferredReplayTurnsPerRow = Math.max(1, consumed);
      }
      this.deferredReplayInFlight = false;
      this.pumpDeferredReplay();
    }
  }

  private async hasReadyPulseWorkForIdleHeartbeat(): Promise<boolean | undefined> {
    const token = pulseToken();
    const emails = idleHeartbeatAgentPulseEmails(this.config.agentUsername);
    const platform = pulseBaseUrl();
    if (!token || emails.length === 0) {
      logger.warn(
        { hasToken: Boolean(token), emails },
        'Idle heartbeat Pulse preflight lacks token or email — failing open',
      );
      return undefined;
    }

    try {
      for (const email of emails) {
        const url = new URL('/pulse/api/items/heartbeat-preflight/', platform.endsWith('/pulse')
          ? platform.replace(/\/pulse$/, '')
          : platform);
        url.searchParams.set('assignee_email', email);
        const response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) {
          logger.warn({ status: response.status, email }, 'Idle heartbeat Pulse preflight HTTP failed open');
          return undefined;
        }
        const payload = await response.json() as { decision?: string };
        if (payload.decision === 'run') return true;
        if (payload.decision === 'skip') return false;
      }
      return false;
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'Idle heartbeat Pulse preflight failed open');
      return undefined;
    }
  }

  /** Process a single inbound message through the agent loop. */
  private async processMessage(msg: InboundMessage): Promise<void | false> {
    await this.pauseForExpensiveTurnGuardIfNeeded(msg);
    this.touchActivity();

    // Operator 2026-08-08: ALL cron jobs enter the normal agent path — tools,
    // session context, inbox serialization, session-affine routing. The old
    // "plain cron" standalone LLM call (no session, no tools) was the
    // runtime's ONLY sessionless inference call, could not do real agent work
    // (tool-less), and surfaced as unattributable admission ghost rows
    // (agent-sato 11:50Z). ScheduleWakeup loop jobs still carry their loop
    // config via metadata.selfInvocation/loop.
    const isSelfWakeup = msg.source === 'cron';
    // SCLI-93/SCLI-50: the intrinsic idle-heartbeat self-nudge is pushed with
    // source:'heartbeat' (see startIdleHeartbeat). Detect it so the auto-reply
    // engine is skipped for idle beats (a catch-all rule must not fire a canned
    // reply every idle interval).
    const isHeartbeat = msg.source === 'heartbeat';
    const recoveryEpisodeId = typeof msg.metadata?.['expensiveTurnRecoveryEpisodeId'] === 'string'
      ? msg.metadata['expensiveTurnRecoveryEpisodeId']
      : undefined;
    let recoveryAttemptRecorded = false;
    let runtimeRollDeferred = false;

    const channel = this.channels.get(msg.channelId);
    if (!channel) {
      logger.warn({ channelId: msg.channelId }, 'Message from unknown channel, dropping');
      if (isSelfWakeup && msg.cronJobId && this.cronStore) {
        await this.cronStore.markJobRun(msg.cronJobId, 'error', `Unknown wakeup channel: ${msg.channelId}`);
      }
      return;
    }

    this.inbox.busy = true;
    this.lastActivityAt = Date.now();

    logger.info({
      agentId: this.config.agentId,
      agentName: this.config.agentName,
      pathway: 'gateway_inbox',
      source: msg.source ?? 'user',
      channelId: msg.channelId,
      channelType: msg.channelType,
      threadId: msg.threadId,
      userId: msg.userId,
      userName: msg.userName,
      requestId: msg.requestId,
      executionId: msg.executionId,
      platformSessionId: msg.platformSessionId,
      contentPreview: typeof msg.content === 'string'
        ? (msg.content.length > 180 ? `${msg.content.slice(0, 180)}...` : msg.content)
        : JSON.stringify(msg.content).slice(0, 180),
    }, 'Gateway inbox message');

    // A ready-work heartbeat commonly follows several idle minutes—long enough
    // for another bounded session on the same vLLM home to evict this prefix.
    // Prewarm here, inside the serialized inbox path, so the maintenance prefill
    // completes before the real heartbeat turn and cannot race a user message.
    // The direct Pulse preflight marks only real work; noop idle ticks remain
    // model-free and this never becomes a periodic fleet-wide cache sweep.
    let prewarmReady: boolean;
    if (
      isHeartbeat
      && msg.metadata?.['idleHeartbeatReadyWork'] === true
    ) {
      logger.info('Ready-work idle heartbeat — pre-warming prefix before interactive turn');
      prewarmReady = await this.prewarmPrefixCache(this.model, this.provider, { reason: 'ready_work' });
    } else {
      prewarmReady = await this.refreshStaleFirstTurnPrewarmBeforeWork();
    }
    if (!prewarmReady) {
      // Never charge a failed maintenance fill to the real request. Put the
      // exact admitted row back at the head before releasing busy state; the
      // next serialized attempt will retry the freshness fence. This preserves
      // direct input and recovery acknowledgements without a timer-owned row
      // that could disappear on process exit.
      const retryRaw = msg.metadata?.['cortexPrewarmDeferredAttempt'];
      const retryAttempt = typeof retryRaw === 'number' && Number.isFinite(retryRaw)
        ? Math.max(0, Math.floor(retryRaw)) + 1
        : 1;
      msg.metadata = { ...msg.metadata, cortexPrewarmDeferredAttempt: retryAttempt };
      const delayMs = Math.min(30_000, 1_000 * Math.pow(2, Math.min(5, retryAttempt - 1)));
      logger.error({
        code: 'cortex_first_turn_prewarm_not_ready',
        retryAttempt,
        delayMs,
        requestId: msg.requestId,
      }, 'Cortex first-turn freshness fence failed — deferring exact inbox row');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      this.inbox.pushFront([msg]);
      this.inbox.busy = false;
      return false;
    }

    // Verify cryptographic signature if present
    if (msg.senderPublicKey && msg.signature) {
      try {
        const { verifySignature } = await import('../crypto/identity.js');
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        const verified = verifySignature(content, msg.timestamp, msg.senderPublicKey, msg.signature);
        if (verified) {
          // Upgrade userName to include verified badge
          msg.userName = `${msg.userName ?? msg.senderPublicKey.slice(0, 8)} ✓`;
        } else {
          logger.warn({ userId: msg.userId }, 'Message signature verification FAILED');
          msg.userName = `${msg.userName ?? 'unknown'} ⚠️ unverified`;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'Signature verification error');
      }
    }

    // Fire MessageReceived hook
    if (this.hookEngine?.hasHooks('MessageReceived')) {
      await this.hookEngine.runHooks('MessageReceived', {
        SESSION_ID: this.sessionId ?? '',
        MESSAGE_CONTENT: String(msg.content ?? '').slice(0, 1000),
        CHANNEL_ID: msg.channelId,
        CHANNEL_TYPE: channel.type,
        USER_ID: msg.userId || '',
        CWD: this.cwd,
      }).catch(() => {});
    }

    // Rate limit check
    if (this.rateLimiter && !isSelfWakeup) {
      const check = this.rateLimiter.check(msg.userId);
      if (!check.allowed) {
        logger.warn({ userId: msg.userId, retryAfterMs: check.retryAfterMs }, 'Rate limited');
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'error',
            error: `Rate limited. Please wait ${Math.ceil(check.retryAfterMs / 1000)} seconds.`,
            timestamp: Date.now(),
          });
        } catch { /* swallow */ }
        this.inbox.busy = false;
        channel.sendComplete(msg.threadId);
        return;
      }
    }

    // Auto-reply check — intercept before LLM processing. SCLI-50: skip for idle
    // heartbeats — a broad/catch-all auto-reply rule would otherwise fire a canned
    // reply (and skip the actual queue check) every idle interval.
    if (!isHeartbeat && !isSelfWakeup && this.autoReplyEngine) {
      const autoResponse = this.autoReplyEngine.check(msg);
      if (autoResponse !== null) {
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'content',
            text: autoResponse,
            timestamp: Date.now(),
          });
          await channel.sendEvent(msg.threadId, {
            type: 'complete',
            totalTurns: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheCreationInputTokens: 0,
            totalCacheReadInputTokens: 0,
            totalDurationMs: 0,
            timestamp: Date.now(),
          });
        } catch { /* swallow send errors */ }
        this.inbox.busy = false;
        channel.sendComplete(msg.threadId);
        return;
      }
    }

    // Set cron delivery context so schedule_job knows where to deliver results
    setCronDelivery({
      channelId: msg.channelId,
      threadId: msg.threadId,
      channelType: msg.channelType,
    });

    let selfWakeupError: string | undefined;

    // Notify queued messages that we're busy
    const queued = this.inbox.queued();
    for (let i = 0; i < queued.length; i++) {
      const queuedMsg = queued[i]!;
      const queuedCh = this.channels.get(queuedMsg.channelId);
      queuedCh?.notifyBusy?.(queuedMsg.threadId, i + 1);
    }

    try {
      // Build user message with channel context prefix
      const prefix = formatChannelPrefix(msg);
      // Content can be string, ContentBlock[], or provider-specific multimodal blocks (image + text)
      let content: Message['content'];
      if (typeof msg.content === 'string') {
        content = prefix ? `${prefix} ${msg.content}` : msg.content;
      } else if (Array.isArray(msg.content)) {
        // Multimodal content (image + text blocks from channels)
        // Prepend channel prefix to the first text block
        const blocks = [...(msg.content as ContentBlock[])];
        if (prefix) {
          const textBlock = blocks.find((b): b is ContentBlock & { type: 'text'; text: string } => b.type === 'text' && 'text' in b);
          if (textBlock) {
            textBlock.text = `${prefix} ${textBlock.text}`;
          } else {
            blocks.unshift({ type: 'text', text: prefix } as ContentBlock);
          }
        }
        content = blocks;
      } else {
        content = String(msg.content);
      }

      // Add user message to eternal session
      // Platform redelivery and runtime-roll replay reuse the exact message id.
      // Its prior model/tool turns are already durable; appending the user row
      // again would duplicate work and break prefix continuity.
      const userMessageAlreadyPersisted = Boolean(
        msg.id && this.messages.some((message) => message.role === 'user' && message.id === msg.id),
      );
      if (!userMessageAlreadyPersisted) {
        const userMessage: Message = {
          id: msg.id,
          executionId: msg.threadId,
          role: 'user',
          content,
          timestamp: msg.timestamp,
        };
        this.messages.push(userMessage);
        this.store.appendMessage(this.sessionId, userMessage);
      } else {
        logger.info({ messageId: msg.id, threadId: msg.threadId }, 'Resuming exact replay from durable session checkpoint');
      }

      // Fan-out user_message to ALL channels (including originator) so
      // cross-device clients see what the user typed. The originating
      // socket may get a duplicate, but client-side dedup (content + 60s
      // window) handles that. We broadcast to the originator too because
      // the HTTP channel may have multiple WS clients (e.g., mobile app
      // + a temporary API socket on the same channel).
      // Fan-out user_message to OTHER channel TYPES (Telegram, Discord, etc.)
      // so those platforms see what the user typed. Skip the originating channel
      // TYPE — the dashboard bridge already handles cross-client sync within
      // the same channel (it broadcasts to all subscribers except the sender).
      // Without this skip, the agent echoes the user_message back to the HTTP
      // channel → dashboard logs it again → browser gets a duplicate.
      const userMsgEvent = {
        type: 'user_message' as const,
        content: typeof content === 'string' ? content : JSON.stringify(content),
        userName: msg.userName,
        messageId: msg.id,
        timestamp: msg.timestamp,
      };
      for (const [, otherChannel] of this.channels) {
        if (userMessageAlreadyPersisted) break;
        if (otherChannel.type === channel.type) continue; // Same channel type handles its own sync
        if (!this.fanOut[otherChannel.type]) continue;
        if (!otherChannel.broadcastEvent) continue;
        try {
          await otherChannel.broadcastEvent(userMsgEvent as any, channel.id, msg.threadId);
        } catch { /* fan-out target unavailable */ }
      }

      // Execute agent turns
      runtimeRollDeferred = await this.executeTurns(msg, channel);
      if (runtimeRollDeferred) return false;
      if (recoveryEpisodeId) {
        await this.finishExpensiveTurnRecoveryBootstrap(recoveryEpisodeId);
        recoveryAttemptRecorded = true;
      }

    } catch (err) {
      const errorMsg = (err as Error).message || 'Internal error';
      const userError = userVisibleProviderFailure(errorMsg);
      selfWakeupError = errorMsg;
      this.recordRecentError(err);
      logger.error({ err, channelId: msg.channelId, threadId: msg.threadId }, 'Error processing message');
      this.emitTelemetry();

      // Fire AgentError hook
      if (this.hookEngine?.hasHooks('AgentError')) {
        await this.hookEngine.runHooks('AgentError', {
          SESSION_ID: this.sessionId ?? '',
          ERROR_MESSAGE: errorMsg.slice(0, 500),
          CHANNEL_ID: msg.channelId,
          CWD: this.cwd,
        }).catch(() => {});
      }

      const terminalError = providerFailureTerminalMessage(errorMsg);
      // PLAT-4616: provider/runtime failures must end in one typed terminal
      // ANDON outcome, not repeated generic Connect fallback DMs that can
      // re-trigger the failed agent/session. Dedupe per sender/thread/error
      // signature with a bounded in-memory TTL; a later healthy invocation is
      // unaffected because this only gates error notices.
      const dedupeKey = providerFailureDedupeKey(msg, errorMsg);
      const now = Date.now();
      for (const [key, ts] of this.providerFailureNotices) {
        if (now - ts > 60 * 60 * 1000) this.providerFailureNotices.delete(key);
      }
      // The session history is the durable idempotency boundary. Unlike the
      // in-memory TTL map it survives a process restart, so a replay of the
      // same thread cannot append or emit a second terminal outcome.
      const alreadyPersisted = this.messages.some((message) =>
        message.role === 'assistant'
        && message.executionId === msg.threadId
        && message.content === terminalError,
      );
      const alreadyNotified = alreadyPersisted || this.providerFailureNotices.has(dedupeKey);
      if (!alreadyNotified) this.providerFailureNotices.set(dedupeKey, now);

      if (!alreadyNotified) {
        const terminalMsg: Message = {
          role: 'assistant',
          content: terminalError,
          timestamp: Date.now(),
          executionId: msg.threadId,
        };
        this.messages.push(terminalMsg);
        this.store.appendMessage(this.sessionId, terminalMsg);
      }

      if (channel.type === 'connect' && msg.userName) {
        if (!alreadyNotified) {
          try {
            await sendConnectDm({
              recipientUsername: msg.userName,
              content: terminalError,
              clientMessageId: `provider-failure-${dedupeKey}`,
            });
          } catch { /* best-effort */ }
        } else {
          logger.warn({ channelId: msg.channelId, threadId: msg.threadId }, 'Suppressing duplicate provider failure Connect DM');
        }
      } else if (!alreadyNotified) {
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'content',
            text: terminalError,
            timestamp: Date.now(),
          });
        } catch { /* swallow */ }
      }
      if (!alreadyNotified) {
        try {
          await channel.sendEvent(msg.threadId, {
            type: 'error',
            error: terminalError,
            userError,
            terminal: true,
            duplicateSuppressed: false,
            timestamp: Date.now(),
          } as any);
        } catch { /* swallow send errors */ }
      }
    } finally {
      if (!runtimeRollDeferred && recoveryEpisodeId && !recoveryAttemptRecorded) {
        await this.finishExpensiveTurnRecoveryBootstrap(recoveryEpisodeId, 'not_observed').catch((err) => {
          logger.error({ err, recoveryEpisodeId }, 'Failed to record SCLI-347 recovery attempt');
        });
      }
      // Fire MessageSent hook (agent finished responding)
      if (!runtimeRollDeferred && this.hookEngine?.hasHooks('MessageSent')) {
        await this.hookEngine.runHooks('MessageSent', {
          SESSION_ID: this.sessionId ?? '',
          CHANNEL_ID: msg.channelId,
          CHANNEL_TYPE: channel.type,
          MESSAGE_COUNT: String(this.messages.length),
          CWD: this.cwd,
        }).catch(() => {});
      }

      if (!runtimeRollDeferred && isSelfWakeup && msg.cronJobId && this.cronStore) {
        await this.cronStore.markJobRun(msg.cronJobId, selfWakeupError ? 'error' : 'ok', selfWakeupError);
      }

      this.inbox.busy = false;
      // No execution_complete/ack on a rollout checkpoint. The exact row is
      // still queued locally and remains replayable upstream after replacement.
      if (!runtimeRollDeferred) channel.sendComplete(msg.threadId);
    }
  }

  /** Run agent turns until the model stops (no tool calls, max turns, etc.). */
  private async executeTurns(msg: InboundMessage, channel: Channel): Promise<boolean> {
    const { executeTurn } = await import('../agent/turn.js');
    const { needsCompaction, estimateOverheadTokens } = await import('../prompt/context.js');

    const { normalizeModelName } = await import('../provider/registry.js');
    const hasPerMessageModel = !!msg.model;
    const useFallbackChain = !hasPerMessageModel && this.modelFallbacks.length > 1;

    // A successful fallback is a temporary availability decision, never a
    // permanent model-policy mutation. Re-probe the configured primary at a
    // bounded safe turn boundary; one old Grok stream error otherwise pinned
    // Nagi to DeepSeek indefinitely while it remained continuously active.
    if (useFallbackChain) this.retryConfiguredPrimaryIfDue(normalizeModelName);

    // Resolve active model + provider (respects pinning from previous fallbacks)
    let activeModel = normalizeModelName(msg.model ?? this.model);
    let activeProvider = this.provider;

    if (useFallbackChain) {
      this.alignPinnedFallbackIndexWithActiveModel(activeModel, normalizeModelName);
    }

    if (useFallbackChain && this.pinnedFallbackIndex > 0) {
      const pinned = this.modelFallbacks[this.pinnedFallbackIndex];
      if (pinned) {
        try {
          const pinnedModel = normalizeModelName(pinned.model);
          const pinnedProviderName = (pinned as { provider?: string }).provider;
          if (pinnedProviderName) {
            activeProvider = this.providerReg.get(pinnedProviderName) ?? this.providerReg.resolve(pinnedModel);
          } else {
            activeProvider = this.providerReg.resolve(pinnedModel);
          }
          activeModel = pinnedModel;
        } catch {
          // Pinned model's provider no longer available — reset to primary
          this.pinnedFallbackIndex = 0;
          const primary = this.modelFallbacks[0]!;
          activeModel = normalizeModelName(primary.model);
          const primaryProviderName = (primary as { provider?: string }).provider;
          if (primaryProviderName) {
            activeProvider = this.providerReg.get(primaryProviderName) ?? this.providerReg.resolve(activeModel);
          } else {
            activeProvider = this.providerReg.resolve(activeModel);
          }
        }
      }
    }

    const toolContext = { cwd: this.cwd, sessionId: this.sessionId!, taskRegistry: this.taskRegistry, sandbox: this.sandboxConfig };
    const startTime = Date.now();
    let turnIndex = 0;
    let totalInputTokens = 0;
    // SCLI-182 anchor now lives on the instance (this.lastReportedPromptTokens)
    // so turn-0 gates of a NEW exchange keep the previous exchange's real
    // measurement instead of falling back to the inflated tiktoken estimate.
    let totalOutputTokens = 0;
    let totalToolCalls = 0;
    let sawLoopBreak = false;  // SCLI-60: suppress fast re-arm after loop-guard breaks
    const heartbeatToolCalls: Array<{ name?: string; input?: unknown }> = [];
    const heartbeatToolResults: Array<{ content?: unknown; isError?: boolean }> = [];
    const assistantMessageId = crypto.randomUUID();

    // SCLI-32 (review P2-1): wire StruggleAnalyzer into the gateway/fleet execution
    // path. Fleet agents run this loop — NOT runAgent() or the exec path in index.ts —
    // so without wiring here the live fleet had no struggle signal at all.
    const { TurnTelemetryWindow, recordTurnTelemetry } = await import('../telemetry/turn-telemetry.js');
    const { StruggleAnalyzer } = await import('../agent/struggle-analyzer.js');
    const { setupStrugglePulseAutoFiler } = await import('../telemetry/struggle-auto-filer.js');
    const gatewayTelemetryWindow = new TurnTelemetryWindow();
    const gatewayRunId = `${this.sessionId ?? 'gw'}#${crypto.randomUUID().slice(0, 8)}`;
    const gatewayStruggle = new StruggleAnalyzer(this.emitter, gatewayTelemetryWindow, {
      runId: gatewayRunId,
      agent: this.config.agentName ?? this.config.agentId ?? undefined,
    });
    const { unsub: gatewayAutoFilerUnsub } = setupStrugglePulseAutoFiler(
      this.emitter as unknown as Parameters<typeof setupStrugglePulseAutoFiler>[0],
    );

    // Emit session start
    const sessionStartEvent: AgentEvent = {
      type: 'session_start',
      sessionId: this.sessionId!,
      model: activeModel,
      messageId: assistantMessageId,
      timestamp: Date.now(),
    };
    // SCLI-32: try/finally starts before the first awaited channel send so
    // StruggleAnalyzer/auto-filer listeners installed above are torn down even
    // if session_start send throws (previously the try started after this await,
    // leaving stale listeners on early failure paths).
    try {
    await channel.sendEvent(msg.threadId, sessionStartEvent);
    // Fan out session start
    for (const [, otherChannel] of this.channels) {
      if (otherChannel === channel || !this.fanOut[otherChannel.type] || !otherChannel.broadcastEvent) continue;
      try { await otherChannel.broadcastEvent(sessionStartEvent, channel.id, msg.threadId); } catch { /* ignore */ }
    }


    // Loop detection — catches the agent calling the same tool repeatedly.
    // Thresholds are TOML-tunable via [loopDetector] (SCLI-20c).
    const loopDetector = new LoopDetector(this.loopDetectorConfig);

    // Deferred MCP tools are all treated uniformly: if a turn explicitly names
    // an exact mcp__server__tool, make that tool schema active for this turn
    // while keeping MCP execution itself routed through the normal registry.
    const mentionedMcpTools = new Set([
      ...extractMentionedMcpToolNames(msg.content),
      ...extractMentionedMcpToolNames(this.messages.at(-1)?.content),
    ]);
    // Lean seats already declare the Pulse work head. Do not grow tools[]
    // from heartbeat/user text — that rewrite is the SuperGrok cache break.
    // Talk one-shot seats keep tools[] empty for the whole session.
    if (talkSeatSuppressesTools()) {
      mentionedMcpTools.clear();
    } else if (isLeanConversationalEnv()) {
      const allowed = new Set<string>(LEAN_CONVERSATIONAL_MCP_TOOL_NAMES);
      for (const name of [...mentionedMcpTools]) {
        if (!allowed.has(name)) mentionedMcpTools.delete(name);
      }
    }
    if (mentionedMcpTools.size > 0) {
      const activated = activateExplicitlyMentionedMcpToolsForModel(
        this.toolDefs,
        this.toolRegistry.definitions(),
        mentionedMcpTools,
        activeModel,
      );
      this.toolDefs = activated.toolDefs;
      if (activated.availableAppendOnly.length > 0) {
        // Match ToolSearch's inline-schema contract: the schema arrives in the
        // newly appended user message, after the known-warm prefix. This gives
        // the open-model parser exact argument definitions without changing
        // the provider-static tools block. The in-memory enrichment need not
        // rewrite persisted history: a future restart prewarms the persisted
        // form as its own exact baseline before serving another append.
        const latestMessage = this.messages.at(-1);
        if (latestMessage) appendInlineMcpSchemasToMessage(latestMessage, activated.availableAppendOnly);
        logger.info({
          tools: activated.availableAppendOnly.map((definition) => definition.name),
          activeTools: this.toolDefs.length,
        }, 'Explicitly mentioned deferred tools available append-only (tool head unchanged)');
      }
      if (activated.added.length > 0) {
        // PLAT-4189 follow-up: this activation rewrites the prompt head (one
        // unavoidable cold prefill — the model needs the schema NOW). Persist
        // the name so every future restart pre-activates it at setup instead
        // of re-mutating the head on first mention.
        this.persistActivatedMcpTools(activated.added);
        logger.info({ tools: activated.added, activeTools: this.toolDefs.length }, 'Activated explicitly mentioned MCP tools');
      }
    }

    let contextWindowRecoveryAttempted = false;
    // A history rewrite must never silently charge its cold rebuild to the
    // interactive SLO. Prewarm the exact rewritten payload first; if that
    // maintenance request fails, tag the one real successor turn so Cortex
    // attributes the unavoidable miss as post-compaction rather than an
    // unexplained interactive prefix mutation.
    let postCompactionRequestKind: 'post_compaction' | undefined;
    const prepareRewrittenHistory = async (): Promise<void> => {
      postCompactionRequestKind = await this.prewarmPrefixCache(
        activeModel,
        activeProvider,
        { reason: 'post_compaction' },
      )
        ? undefined
        : 'post_compaction';
      await this.prewarmManagedGrokFallbackPrefix(activeModel, 'post_compaction');
    };
    const applySemanticCompaction = async (
      phase: 'pre-turn' | 'post-turn',
      overheadTokens: number,
    ): Promise<void> => {
      const before = this.messages.length;
      try { await this.flushPreCompactionMemory(); } catch { /* non-fatal */ }
      const { compactMessagesRequired } = await import('../state/compaction.js');
      const { messages: compacted } = await compactMessagesRequired(
        this.messages,
        activeProvider,
        activeModel,
        this.maxContextTokens,
        // CTX-650 (agent-kei 2026-08-11): thread the SESSION identity. Without
        // it the compaction request reaches Cortex under a prompt-hash
        // affinity — a homeless 292K cold request that placement sends
        // OFF-HOME (288.7s prefill on tp8 for content 99% warm on i7-a).
        // With the session key it hits the session's own warm prefix in ~2s.
        // Same bug class as the 2026-07-13 TUI-side fix; the gateway path
        // was never threaded.
        {
          overheadTokens,
          force: true,
          ...(this.sessionId ? { sessionId: this.sessionId } : {}),
        },
      );
      if (!this.validateCompactedMessages(compacted, this.messages)) {
        throw new Error(`Semantic ${phase} compaction produced an invalid transcript`);
      }
      this.messages.length = 0;
      this.messages.push(...compacted);
      this.adoptPendingPromptRefresh(`${phase.replace('-', '_')}_semantic_compaction`);
      this.store.replaceMessages(this.sessionId, compacted);
      // Provider truth describes the old prefix. The compacted successor has a
      // new semantic prefix and must establish its own fresh measurement.
      this.lastReportedPromptTokens = 0;
      logger.info(
        { phase, before, after: compacted.length, sessionId: this.sessionId },
        'Gateway provider-backed semantic compaction complete',
      );
      // The rewrite keeps the same session affinity. Warm exactly this bounded
      // successor before an interactive append, or tag the successor as cold if
      // the affinity-preserving warmup is unavailable.
      await prepareRewrittenHistory();
    };
    const compactPostTurnBoundaryIfNeeded = async (maxOutputTokens: number): Promise<boolean> => {
      const overheadTokens = estimateOverheadTokens(this.systemPrompt, this.toolDefs, activeModel);
      if (!needsCompaction(
        this.messages,
        this.maxContextTokens,
        activeModel,
        overheadTokens,
        maxOutputTokens,
        this.lastReportedPromptTokens,
        this.lastReportedRawEstimateTokens, // paired baseline — differential growth, no raw-floor overcount
      )) return false;

      if (this.hookEngine?.hasHooks('PreCompact')) {
        await this.hookEngine.runHooks('PreCompact', {
          SESSION_ID: this.sessionId ?? '',
          MESSAGE_COUNT: String(this.messages.length),
          CWD: this.cwd,
        });
      }
      await applySemanticCompaction('post-turn', overheadTokens);
      if (this.hookEngine?.hasHooks('PostCompact')) {
        await this.hookEngine.runHooks('PostCompact', {
          SESSION_ID: this.sessionId ?? '',
          MESSAGE_COUNT: String(this.messages.length),
          DID_COMPACT: 'true',
          RECOVERED: 'false',
          CWD: this.cwd,
        });
      }
      return true;
    };
    while (true) {
      const turnMaxOutputTokens = this.maxOutputTokensForMessage(msg, turnIndex);
      const systemOverheadTokens = estimateOverheadTokens(this.systemPrompt, this.toolDefs, activeModel);

      // Fleet heartbeats must honor the pod's heartbeat budget. The 80k/100k
      // pins were already on Saki's Deployment, but only the TUI loop read
      // them — gateway ticks sent a 294k poisoned session and the model
      // returned empty in ~7s without ever calling Pulse.
      if (msg.source === 'heartbeat') {
        const hbBudget = heartbeatBudgetConfig(this.maxContextTokens);
        const hbEstimate = estimatePromptTokenBudget({
          messages: this.messages,
          systemPrompt: this.systemPrompt,
          toolDefs: this.toolDefs,
          model: activeModel,
          sourceKind: 'heartbeat',
          reportedPromptTokens: this.lastReportedPromptTokens,
          reportedRawEstimateTokens: this.lastReportedRawEstimateTokens,
        });
        if (hbEstimate.promptTokenEstimate > hbBudget.hardBudgetTokens) {
          logger.warn(
            {
              promptTokenEstimate: hbEstimate.promptTokenEstimate,
              hardBudgetTokens: hbBudget.hardBudgetTokens,
              messageCount: this.messages.length,
            },
            'Heartbeat skipped: session exceeds heartbeat hard budget (reset required)',
          );
          break;
        }
      }

      // Pre-turn compaction check — prevents context overflow when the session
      // has accumulated too many messages (eternal sessions can grow indefinitely).
      if (needsCompaction(
        this.messages,
        this.maxContextTokens,
        activeModel,
        systemOverheadTokens,
        turnMaxOutputTokens,
        this.lastReportedPromptTokens, // SCLI-182: gate on real prompt_tokens when available
        this.lastReportedRawEstimateTokens, // paired baseline — differential growth, no raw-floor overcount
      )) {
        logger.info(
          { messageCount: this.messages.length, maxContextTokens: this.maxContextTokens },
          'Pre-turn semantic compaction triggered',
        );
        await applySemanticCompaction('pre-turn', systemOverheadTokens);
      }

      // Semantic compaction is the only legal history rewrite. This estimator
      // is now a fail-closed assertion; it must never authorize a local trim.

      const budgetCheck = AgentProcess.inspectContextBudget(
        this.messages,
        activeModel,
        this.maxContextTokens,
        this.systemPrompt,
        this.toolDefs,
        turnMaxOutputTokens,
        this.lastReportedPromptTokens, // PLAT-4189: anchor to real usage — never trim a session with real headroom
      );
      if (budgetCheck.exceeded) {
        throw new Error(
          `Semantic compaction invariant failed before gateway provider call (${budgetCheck.promptTokens}/${budgetCheck.targetTokens} tokens); history was preserved`,
        );
      }

      const turnStart = Date.now();
      const turnGeneration = this.sessionGeneration;
      // SCLI-32: arm the STALL idle timer before the provider call.
      try { gatewayStruggle.onTurnStart(); } catch { /* best-effort */ }

      // Forward emitter events to the channel in real-time + fan out
      const unsub = this.emitter.on('*', async (event: AgentEvent) => {
        if (turnGeneration !== this.sessionGeneration) {
          logger.warn({ turnGeneration, activeGeneration: this.sessionGeneration }, 'Rejected late event from fenced session generation');
          return;
        }
        applyAgentEventToPhase(this.activityPhase, event);
        // 1. Send to originating channel (always)
        try {
          await channel.sendEvent(msg.threadId, event);
        } catch { /* client disconnected */ }

        // 2. Fan out to other channels that have it enabled
        for (const [, otherChannel] of this.channels) {
          if (otherChannel === channel) continue; // skip originator
          if (!this.fanOut[otherChannel.type]) continue; // fan-out disabled for this type
          if (!otherChannel.broadcastEvent) continue; // channel doesn't support fan-out
          try {
            await otherChannel.broadcastEvent(event, channel.id, msg.threadId);
          } catch { /* fan-out target unavailable */ }
        }
      });

      // GAP F: Start telemetry span for this turn
      const turnSpanId = this.spanTracker?.startSpan('llm-turn', {
        model: activeModel,
        turn: turnIndex,
        agent: this.config.agentName ?? this.config.agentId ?? 'unknown',
      });

      let result: any;
      let expensiveTurnDecision: ExpensiveTurnGuardDecision = { action: 'ok' };
      let cortexRehomeRequired = false;
      try {
        const pinnedFallbackIndexBeforeTurn = this.pinnedFallbackIndex;
        result = await this.executeTurnWithFallback(
          executeTurn, activeModel, activeProvider, useFallbackChain,
          toolContext, msg, channel,
          msg.source === 'heartbeat' && turnIndex === 0,
          postCompactionRequestKind,
          () => { cortexRehomeRequired = true; },
          turnIndex,
        );
        postCompactionRequestKind = undefined;
        // Update active model/provider if fallback changed them
        if (useFallbackChain && this.pinnedFallbackIndex !== pinnedFallbackIndexBeforeTurn && this.pinnedFallbackIndex < this.modelFallbacks.length) {
          const pinned = this.modelFallbacks[this.pinnedFallbackIndex]!;
          const pinnedModel = normalizeModelName(pinned.model);
          if (pinnedModel !== activeModel) {
            // A pinned entry whose provider is unavailable (e.g. a stale env
            // chain naming an unauthenticated claude model) must not throw and
            // kill the WHOLE message turn — un-pin and keep the working active
            // model instead (yuki's heartbeat/task-assign turns died this way
            // when a stale k8s-env chain pinned claude-sonnet).
            try {
              activeProvider = this.providerReg.resolve(pinnedModel);
              activeModel = pinnedModel;
            } catch (pinErr) {
              logger.warn({ pinnedModel, activeModel, err: (pinErr as Error).message },
                'Pinned fallback model unavailable — keeping current model and resetting pin');
              this.pinnedFallbackIndex = 0;
              this.pinnedFallbackAt = 0;
            }
          }
        } else if (useFallbackChain) {
          this.alignPinnedFallbackIndexWithActiveModel(activeModel, normalizeModelName);
        }

        // GAP F: End turn span
        if (turnSpanId) {
          // Operator 2026-08-05, on the Hive Live-activity feed showing only
          // "59008 input tokens, 49 output tokens, 0 tool calls":
          //
          //   i don't see the actual output tokens here in activity logs and i
          //   need to see those because without them we can't infer what the
          //   agent is thinking and doing .. rather than just looking at this
          //   summary which is useless
          //
          // Carry a bounded excerpt of what the turn actually SAID and DID —
          // the assistant's text plus the tool names it called — so the feed
          // reads as behaviour, not accounting. Bounded so .telemetry.jsonl
          // stays a tail-able log rather than a transcript mirror.
          const assistantText = (() => {
            const content = result.assistantMessage?.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) {
              return content
                .filter((b: { type?: string }) => b?.type === 'text')
                .map((b: { text?: string }) => b.text ?? '')
                .join(' ');
            }
            return '';
          })().replace(/\s+/g, ' ').trim();
          this.spanTracker?.endSpan(turnSpanId, {
            toolCalls: result.toolCalls.length,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            toolNames: result.toolCalls.slice(0, 8).map((c: { name?: string }) => c?.name ?? '?'),
            assistantExcerpt: assistantText.slice(0, 500),
          });
        }
        expensiveTurnDecision = this.expensiveTurnGuard.record({
          now: Date.now(),
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          toolCallCount: result.toolCalls?.length ?? 0,
          cacheReadTokens: result.cacheReadInputTokens,
          cacheCreationTokens: result.cacheCreationInputTokens,
          ttftMs: result.ttftMs,
          source: msg.source ?? 'user',
          channelType: msg.channelType,
        });

        // SCLI-32 (review P2-1): record telemetry BEFORE the finally-unsub so struggle
        // events emitted by onTurnRecorded() reach the per-turn '*' channel forwarder.
        // unsub() in finally tears down that forwarder — calling onTurnRecorded() after it
        // means THRASH/ERROR_DENSITY/LONG_RUN events are dropped and never reach consumers.
        try {
          recordTurnTelemetry({
            window: gatewayTelemetryWindow,
            result,
            providerName: activeProvider.name ?? activeModel,
            runId: gatewayRunId,
            turnIndex,
            model: activeModel,
            turnDurationMs: Date.now() - turnStart,
            loopGuardHit: expensiveTurnDecision.action === 'pause',
          });
          const continuing = result.toolCalls.length > 0;
          gatewayStruggle.onTurnRecorded(continuing);
        } catch { /* best-effort */ }
      } catch (err) {
        if (turnSpanId) {
          this.spanTracker?.endSpan(turnSpanId, { error: (err as Error).message }, 'error');
        }
        if (AgentProcess.isContextWindowTooSmallError(err)) {
          if (!contextWindowRecoveryAttempted) {
            contextWindowRecoveryAttempted = true;
            const overheadTokens = estimateOverheadTokens(this.systemPrompt, this.toolDefs, activeModel);
            await applySemanticCompaction('pre-turn', overheadTokens);
            logger.warn(
              { maxContextTokens: this.maxContextTokens, messageCount: this.messages.length },
              'Recovered CONTEXT_WINDOW_TOO_SMALL through semantic prefix compaction; retrying turn once',
            );
            continue;
          }

          const terminalText = `🔴 ANDON: context window is still too small after semantic compaction (max_context=${this.maxContextTokens}). Stopping this turn with history preserved.`;
          const terminalMsg: Message = { role: 'assistant', content: terminalText, timestamp: Date.now() };
          this.messages.push(terminalMsg);
          this.store.appendMessage(this.sessionId, terminalMsg);
          try {
            await channel.sendEvent(msg.threadId, {
              type: 'error',
              error: terminalText,
              timestamp: Date.now(),
            } as any);
          } catch { /* channel may already be gone */ }
          logger.error({
            err: (err as Error).message,
            maxContextTokens: this.maxContextTokens,
          }, 'CONTEXT_WINDOW_TOO_SMALL remained after semantic compaction; ending turn terminally');
          sawLoopBreak = true;
          break;
        }
        throw err;
      } finally {
        unsub();
      }

      // Tool calls have already executed by the time the expensive-turn guard
      // can fence this generation. Preserve their durable audit evidence before
      // recovery replaces the transcript, including on the pause path below.
      const agentName = this.config.agentName ?? this.config.agentId ?? 'unknown';
      if (this.auditLogger && result.toolCalls) {
        for (let ti = 0; ti < result.toolCalls.length; ti++) {
          const tc = result.toolCalls[ti];
          const tr = result.toolResults[ti];
          const auditId = this.auditLogger.logBefore(agentName, tc.name, tc.input);
          if (tr?.isError) {
            this.auditLogger.logError(auditId, agentName, tc.name, tr.content ?? 'unknown error', 0);
          } else {
            this.auditLogger.logAfter(auditId, agentName, tc.name, tr?.content ?? '', 0);
          }
        }
      }

      // The guard decision fences this generation before its terminal output is
      // persisted.  Any late async emitter delivery is rejected by the
      // generation check above; the clean successor owns all subsequent work.
      if (expensiveTurnDecision.action === 'pause') {
        sawLoopBreak = true;
        await this.applyExpensiveTurnPauseBranch(expensiveTurnDecision, activeModel, msg);
        turnIndex++;
        break;
      }

      // Capture the paired uninflated baseline for the EXACT request that
      // produced result.inputTokens — this.messages has not yet received the
      // assistant response/tool results here, so it is the request payload.
      // Persisted so the anchor pair survives harness rolls (agent-ryo
      // 2026-08-08: the process-local anchor died with the pod and the first
      // resumed turn was cold-estimated at ×safety, firing a destructive
      // unnecessary compaction on a session with 200K of true headroom).
      if ((result.inputTokens ?? 0) > 0 || (result.providerPromptEstimate ?? 0) > 0) {
        this.lastReportedRawEstimateTokens = estimateTokens(this.messages, activeModel) + systemOverheadTokens;
        try {
          this.store.saveContextTokenAnchor?.(this.sessionId, {
            model: activeModel,
            providerInputTokens: result.inputTokens ?? 0,
            providerPromptEstimate: result.providerPromptEstimate ?? 0,
            rawPromptTokens: this.lastReportedRawEstimateTokens,
          }, this.messages);
        } catch { /* durable anchor is best-effort */ }
      }

      // Persist assistant message
      result.assistantMessage.id = assistantMessageId;
      result.assistantMessage.executionId = msg.threadId;
      this.messages.push(result.assistantMessage);
      this.store.appendMessage(this.sessionId, result.assistantMessage);

      if (result.toolResults.length > 0) {
        // Oversized-image ingest cap: a full-quality screenshot (200KB+ base64)
        // persisted into the eternal session poisons every later turn — the
        // context estimator charges the base64 forever and compaction keeps
        // recent tool results, wedging the agent at the model's window (mika
        // 358k / scout 272k vs 262k served, 2026-07-05). The CURRENT turn
        // already saw the image; persist only a placeholder past ~96KB raw.
        const IMAGE_PERSIST_MAX_B64 = 128 * 1024;
        const trMsg: Message = {
          role: 'user',
          content: result.toolResults.map((tr: any) => {
            const oversized = tr.image?.base64 && tr.image.base64.length > IMAGE_PERSIST_MAX_B64;
            if (!oversized) {
              return {
                type: 'tool_result' as const,
                toolUseId: tr.toolUseId,
                content: tr.content,
                isError: tr.isError,
                image: tr.image,
              };
            }
            logger.warn({ toolUseId: tr.toolUseId, b64KB: Math.round(tr.image.base64.length / 1024) },
              'Oversized tool-result image not persisted to session (placeholder kept)');
            return {
              type: 'tool_result' as const,
              toolUseId: tr.toolUseId,
              content: `${tr.content ?? ''}\n[Image omitted from session history: ${Math.round(tr.image.base64.length * 0.75 / 1024)}KB exceeds the persistence cap. Re-capture if needed.]`,
              isError: tr.isError,
            };
          }),
          timestamp: Date.now(),
        };
        // Persist tool results exactly. If they push the projection across the
        // context invariant, the post-turn semantic prefix compactor handles
        // it; no local preview rewrite may replace their content.
        this.messages.push(trMsg);
        this.store.appendMessage(this.sessionId, trMsg);
      }

      totalInputTokens += result.inputTokens;
      if (result.inputTokens > 0) this.lastReportedPromptTokens = result.inputTokens; // SCLI-182
      totalOutputTokens += result.outputTokens;
      totalToolCalls += result.toolCalls.length;
      // A long-running inbox row can contain dozens of productive model/tool
      // turns.  Treat each completed turn as live activity; stamping only at
      // processMessage admission made Connect/Hive report an agent as inactive
      // for the full age of the row even while it was actively producing work.
      // Do this after the provider + tool execution succeeds so a genuinely
      // wedged in-flight turn still ages and remains diagnosable.
      this.touchActivity();
      if (msg.source === 'heartbeat') {
        for (let i = 0; i < result.toolCalls.length; i++) {
          const call = result.toolCalls[i];
          const toolResult = result.toolResults[i];
          heartbeatToolCalls.push({ name: call?.name, input: call?.input });
          heartbeatToolResults.push({ content: toolResult?.content, isError: toolResult?.isError });
        }
      }
      this.store.updateTokens(this.sessionId, result.inputTokens, result.outputTokens);

      await channel.sendEvent(msg.threadId, {
        type: 'turn_complete',
        turnIndex,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        durationMs: Date.now() - turnStart,
        timestamp: Date.now(),
      });

      // Cortex may keep an exact warm session route on a source that has just
      // entered warm-only soft drain. Once the successful turn is durably in
      // history, warm its FULL successor prefix on an ordinary sibling before
      // another interactive call can run. The rehome request carries the same
      // canonical model/session identity; Cortex ignores client backend hints,
      // excludes the draining source, and promotes only after successful stream
      // completion under its existing generation CAS.
      if (cortexRehomeRequired && activeProvider?.name === 'cortex') {
        logger.info({ sessionId: this.sessionId }, 'Cortex soft-drain rehome required — warming full current prefix');
        await this.prewarmPrefixCache(activeModel, activeProvider, {
          reason: 'soft_drain_rehome',
          rehomeIntent: true,
        });
      }

      // Context maintenance belongs to the completed model/tool sub-turn, not
      // the next inbox row. Run it before every exit/continue/checkpoint path so
      // a text-only final answer cannot leave the next user waiting on cleanup.
      await compactPostTurnBoundaryIfNeeded(turnMaxOutputTokens);

      // Tool results and the assistant call are now persisted and turn_complete
      // is visible, but the execution itself is deliberately not complete. A
      // continuously working agent therefore cannot starve a rollout: it yields
      // after one bounded model/tool turn and resumes the exact row afterward.
      // The Cortex rehome contract above must run first: the response header is
      // singleflight-fenced, so returning here first would consume the signal
      // without warming/promoting its safe successor home.
      if (this.checkpointRuntimeRollAfterTurn(msg, result.toolCalls.length > 0)) {
        return true;
      }

      // SCLI-74: record per-turn metrics for the /metrics Prometheus scrape
      try {
        recordTurnTelemetry({
          window: this.gatewayTelemetryWindow,
          sink: this.gatewayTelemetrySink,
          result,
          providerName: activeProvider.name ?? 'unknown',
          runId: assistantMessageId,
          agentLabel: this.config.agentName,
          turnIndex,
          model: activeModel,
          turnDurationMs: Date.now() - turnStart,
          loopGuardHit: false, // pause decisions exit before this persisted-turn telemetry path
        });
        this.recentErrors.length = 0;
        this.emitTelemetry();
      } catch { /* best-effort: telemetry must never break a turn */ }

      turnIndex++;

      // Continuation logic — incomplete streams are terminal and never replay
      // after partial output because the upstream cancellation may still be in flight.
      if (talkSeatSuppressesTools()) {
        const { visibleTextFromContent, reasoningTextFromContent } = await import('../agent/content.js');
        const text = visibleTextFromContent(result.assistantMessage.content)
          .replace(/<think>[\s\S]*?<\/think>/g, '')
          .trim();
        const reasoning = reasoningTextFromContent(result.assistantMessage.content).trim();
        if (!text && reasoning) {
          await channel.sendEvent(msg.threadId, {
            type: 'content',
            text: reasoning,
            timestamp: Date.now(),
          });
        }
        break;
      }
      if (result.toolCalls.length === 0) {
        const incompleteError = incompleteTurnError(result.stopReason);
        if (incompleteError) {
          sawLoopBreak = true;
          await channel.sendEvent(msg.threadId, {
            type: 'error',
            error: incompleteError,
            timestamp: Date.now(),
          });
          break;
        }
        break; // Text-only — done
      }

      // Loop detection — check if the agent is stuck calling the same tool(s)
      type LoopStatus = 'ok' | 'warning' | 'probe-warning' | 'break';
      const RANK: Record<LoopStatus, number> = { ok: 0, warning: 1, 'probe-warning': 1, break: 2 };
      let worstLoopStatus: LoopStatus = 'ok';
      for (const tc of result.toolCalls) {
        const status = loopDetector.record(tc.name, tc.input);
        if (RANK[status] > RANK[worstLoopStatus]) worstLoopStatus = status;
        if (status === 'break') break;
      }
      if (worstLoopStatus === 'break') {
        sawLoopBreak = true;  // SCLI-60
        const breakMsg: Message = {
          role: 'user',
          content: 'You are stuck in a loop. Stopping execution. Please try a completely different approach.',
          timestamp: Date.now(),
        };
        this.messages.push(breakMsg);
        this.store.appendMessage(this.sessionId, breakMsg);
        break;
      }
      if (worstLoopStatus === 'probe-warning') {
        const probeMsg: Message = {
          role: 'user',
          content:
            "You've run several inline probe commands (python3 -c, node -e) without editing any file. " +
            'State your hypothesis in one sentence, then use write/edit to apply the fix. ' +
            'If a previous edit was wrong, re-read the affected file before rewriting.',
          timestamp: Date.now(),
        };
        this.messages.push(probeMsg);
        this.store.appendMessage(this.sessionId, probeMsg);
      } else if (worstLoopStatus === 'warning') {
        const warnMsg: Message = {
          role: 'user',
          content: 'You appear to be calling the same tool repeatedly with the same arguments. This may indicate you are stuck in a loop. Try a different approach.',
          timestamp: Date.now(),
        };
        this.messages.push(warnMsg);
        this.store.appendMessage(this.sessionId, warnMsg);
      }

    }

    } finally {
      // SCLI-32: teardown — runs on both normal exit and error throw. Fire-and-forget:
      // fleet agents have no forced process.exit so pending Pulse requests complete
      // naturally; blocking here would delay the `complete` event below.
      try { void gatewayAutoFilerUnsub(); gatewayStruggle.destroy(); } catch { /* best-effort */ }
    }

    // Emit completion
    await channel.sendEvent(msg.threadId, {
      type: 'complete',
      totalTurns: turnIndex,
      totalInputTokens,
      totalOutputTokens,
      totalCacheCreationInputTokens: 0,
      totalCacheReadInputTokens: 0,
      totalDurationMs: Date.now() - startTime,
      timestamp: Date.now(),
    });

    // Heartbeat drain outcome must be in outer scope so the re-arm gate can
    // distinguish protocol-only empty checks (alerts+tasks) from real work.
    let heartbeatDrainOutcome: ReturnType<typeof recordHeartbeatQueueDrainTurn> | null = null;
    if (msg.source === 'heartbeat') {
      try {
        heartbeatDrainOutcome = recordHeartbeatQueueDrainTurn(
          this.config.agentId ?? this.config.agentName ?? 'unknown-agent',
          {
            toolCalls: heartbeatToolCalls,
            toolResults: heartbeatToolResults,
          },
          new Date().toISOString(),
          { pulseQueueObligated: !isLeanConversationalEnv() },
        );
        console.log(formatHeartbeatQueueDrainOutcomeLogLine(heartbeatDrainOutcome));
        // Heartbeat exchanges remain append-only like every other turn. The
        // shared provider-backed compactor is the only mechanism allowed to
        // rewrite working context; no-op/queue-only classification is telemetry,
        // never permission for a deterministic tail rewrite.
      } catch (err) {
        logger.warn({ err, agentId: this.config.agentId ?? this.config.agentName }, 'Failed to record heartbeat queue-drain outcome');
      }
    }

    // Drain-the-queue safety net — see shouldFastRearmIdleHeartbeat.
    if (msg.source === 'heartbeat' && shouldFastRearmIdleHeartbeat({
      sawLoopBreak,
      readyTaskCount: heartbeatDrainOutcome?.readyTaskCount,
      progressEventCount: heartbeatDrainOutcome?.progressEventCount,
      forwardedEventCount: heartbeatDrainOutcome?.forwardedEventCount,
      consecutiveReadyNoProgressHeartbeats:
        heartbeatDrainOutcome?.consecutiveReadyNoProgressHeartbeats,
    })) {
      this.lastActivityAt = Date.now() - this.idleHeartbeatMs;
      this.lastHeartbeatAt = Date.now() - this.heartbeatDebounceMs;
      this.nextHeartbeatDueAt = Date.now();
    }

    // Track usage
    if (this.usageTracker) {
      try {
        this.usageTracker.recordMessage(msg.userId, msg.channelType, totalInputTokens, totalOutputTokens, totalToolCalls);
      } catch (err) {
        logger.warn({ err, userId: msg.userId }, 'Failed to record usage stats');
      }
    }
    return false;
  }
}

// ── Helpers ──

/**
 * Format a natural language prefix for the user message.
 * e.g. "[Telegram · Hritik]" or "[Discord · Sara · #general]"
 */
function formatChannelPrefix(msg: InboundMessage): string {
  // HTTP channel from localhost — no prefix needed (direct interaction)
  if (msg.channelType === 'http' && !msg.userName) return '';

  const parts: string[] = [];

  // Channel type (skip for HTTP — it's the default)
  if (msg.channelType !== 'http') {
    const channelLabel = CHANNEL_LABELS[msg.channelType] ?? msg.channelType;
    parts.push(channelLabel);
  }

  // User name
  if (msg.userName) {
    parts.push(msg.userName);
  } else if (msg.userId && msg.channelType !== 'http') {
    parts.push(msg.userId);
  }

  // Platform-specific context (channel name, thread, etc.)
  if (msg.metadata?.channelName) {
    parts.push(`#${msg.metadata.channelName}`);
  }

  if (parts.length === 0) return '';
  return `[${parts.join(' · ')}]`;
}

const CHANNEL_LABELS: Record<string, string> = {
  'http': 'Web',
  'shizuha-ws': 'Shizuha',
  'telegram': 'Telegram',
  'discord': 'Discord',
  'whatsapp': 'WhatsApp',
  'slack': 'Slack',
  'signal': 'Signal',
  'line': 'LINE',
  'imessage': 'iMessage',
  'cli': 'CLI',
};
