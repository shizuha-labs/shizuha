/**
 * PLAT-1112: structured queue-drain outcome telemetry for heartbeat turns.
 *
 * This module is intentionally independent from manager.ts so both the daemon
 * dashboard and the gateway runtime can share the same in-memory outcome model
 * without introducing a manager↔gateway import cycle.
 */

import { PULSE_MCP_TOOL } from '../platform/lean-conversational.js';

export type HeartbeatQueueDrainOutcome =
  | 'queue_empty'
  | 'all_blocked'
  | 'future_due'
  | 'worked_task'
  | 'forwarded'
  | 'ready_no_progress'
  | 'needs_help'
  | 'not_observed';

export interface HeartbeatQueueDrainInput {
  readyTaskCount: number;
  blockedTaskCount?: number;
  futureDueCount?: number;
  progressEventCount?: number;
  forwardedEventCount?: number;
  pulseGetMyTasksOnly?: boolean;
  pulseGetMyAlertsObserved?: boolean;
  pulseAlertTaskOrderValid?: boolean;
  consecutiveReadyNoProgressHeartbeats?: number;
  needsHelpAfter?: number;
}

export interface HeartbeatQueueDrainRecord extends Required<Omit<HeartbeatQueueDrainInput, 'needsHelpAfter'>> {
  agentId: string;
  outcome: HeartbeatQueueDrainOutcome;
  observedAt: string;
  needsHelpAfter: number;
  reason: string;
  /** A rejected model turn must not trigger destruction of useful history. */
  incompleteReason?: 'required_tool_not_called' | 'progress_only' | 'reasoning_only' | 'degenerate_generation' | 'semantic_compaction_failed';
}

export interface HeartbeatQueueDrainTurnToolCall {
  name?: string;
  input?: unknown;
}

export interface HeartbeatQueueDrainTurnToolResult {
  content?: unknown;
  isError?: boolean;
}

export interface HeartbeatQueueDrainTurn {
  toolCalls: HeartbeatQueueDrainTurnToolCall[];
  toolResults: HeartbeatQueueDrainTurnToolResult[];
  incompleteReason?: HeartbeatQueueDrainRecord['incompleteReason'];
}

/** Sato 2026-08-18: bash then a fake "pulse_get_my_alerts → none" summary. */
export function isPulseGetMyAlertsToolName(name?: string): boolean {
  return /pulse_get_my_alerts/i.test(String(name ?? ''));
}

export function isPulseGetMyWorkToolName(name?: string): boolean {
  return /pulse_get_my_work/i.test(String(name ?? ''));
}

export function isPulseGetMyTasksToolName(name?: string): boolean {
  return /pulse_get_my_tasks/i.test(String(name ?? ''));
}

/** Combined inbox or the task half — either one is a Pulse queue snapshot. */
export function heartbeatSawTaskInbox(name?: string): boolean {
  return isPulseGetMyWorkToolName(name) || isPulseGetMyTasksToolName(name);
}

/** Listing tools the prefetch already satisfied — not get_task / transition. */
export function isPulseInboxListingToolName(name?: string): boolean {
  return heartbeatSawTaskInbox(name) || isPulseGetMyAlertsToolName(name);
}

/**
 * Ryo 2026-09-11 gen34: after prefetch, GLM still called pulse_get_my_work
 * with `{}` vs `{limit:40}` until context hit 170k. That is a legal call
 * (no tool_choice), but executing it again re-fetches Pulse and appends
 * another snapshot. Answer with a stub instead — the model stays free to
 * call get_task / transition / comment.
 */
export const HEARTBEAT_INBOX_ALREADY_FETCHED =
  'Combined inbox is already in this turn. Do not fetch alerts/tasks again. '
  + `If the listing shows ready/movable items, advance one (${PULSE_MCP_TOOL.getTask}, `
  + `${PULSE_MCP_TOOL.executeTransition}, or ${PULSE_MCP_TOOL.addComment}). `
  + 'Do not write a queue-status line.';

/**
 * Ryo/Hiro/Ichi 2026-09-11 gen36: listing-loop break used the get_task ABAB
 * copy ("Do not pulse_get_task the same keys again"), so GLM narrated the
 * stub then sat. The looping tool is get_my_work — tell it to OPEN a ticket.
 */
export const HEARTBEAT_LISTING_LOOP_BREAK =
  'You are stuck in a loop fetching the Pulse inbox you already have. Stopping execution. '
  + `Do not call ${PULSE_MCP_TOOL.getMyWork}, ${PULSE_MCP_TOOL.getMyTasks}, or ${PULSE_MCP_TOOL.getMyAlerts} again. `
  + `If the listing shows ready/movable items, call ${PULSE_MCP_TOOL.getTask}, ${PULSE_MCP_TOOL.executeTransition}, or ${PULSE_MCP_TOOL.addComment} on one of them. `
  + 'Do not write a queue-status line.';

export const HEARTBEAT_GET_TASK_LOOP_BREAK =
  'You are stuck in a loop (same tool, or alternating between two arguments). Stopping execution. '
  + `Do not call ${PULSE_MCP_TOOL.getTask} with the same keys again. Take a different action on work you already fetched, `
  + 'or pick a different task.';

export function heartbeatLoopBreakMessage(toolName?: string): string {
  return isPulseInboxListingToolName(toolName)
    ? HEARTBEAT_LISTING_LOOP_BREAK
    : HEARTBEAT_GET_TASK_LOOP_BREAK;
}

/** Every successful tool in the turn was a Pulse inbox listing (including stubs). */
export function heartbeatTurnWasPulseListingOnly(turn: HeartbeatQueueDrainTurn): boolean {
  if (turn.toolCalls.length === 0) return false;
  return turn.toolCalls.every((call, i) => {
    if (turn.toolResults[i]?.isError) return false;
    return isPulseInboxListingToolName(call.name);
  });
}

export function heartbeatInboxReplayContent(toolName: string, alreadyFetched: boolean): string | null {
  if (!alreadyFetched) return null;
  if (!isPulseInboxListingToolName(toolName)) return null;
  return HEARTBEAT_INBOX_ALREADY_FETCHED;
}

/**
 * Kumo 2026-09-12: GLM observation-drop salvage re-samples a *different*
 * `pulse_get_my_work` after prefetch already put the snapshot in the turn.
 * That dispatch is harness forcing; it feeds the "inbox already in this turn"
 * loop. Discard the recovered listing name instead of executing it. The agent
 * still may call get-work itself when prefetch did not run.
 */
export function shouldDiscardSalvagedInboxListing(
  toolName: string,
  inboxAlreadyInTurn: boolean,
): boolean {
  return inboxAlreadyInTurn === true && isPulseInboxListingToolName(toolName);
}

export function isHeartbeatInboxReplayContent(content: unknown): boolean {
  const text = typeof content === 'string' ? content : String(content ?? '');
  return text.startsWith('Combined inbox is already in this turn');
}

export function isPulseGetTaskToolName(name?: string): boolean {
  return /pulse_get_task(?!s)/i.test(String(name ?? ''));
}

/**
 * Saki 2026-08-18: a heartbeat that already has alerts re-calls
 * pulse_get_my_alerts until the loop detector aborts the turn, so
 * pulse_get_my_tasks never runs and Hive shows "no Pulse queue snapshot".
 * After the first alerts snapshot, another alerts-only tool batch means
 * the runtime must take the task snapshot itself.
 *
 * Aoi 2026-09-10: more often she calls alerts **once** and then narrates
 * ("I'm ready to help" / "I don't have any pending tasks") with zero tools.
 * That empty current batch is handled by
 * {@link heartbeatShouldInjectQueueToolsAfterNarration}, not this function —
 * treating empty current here also fired during progress-only recovery.
 */
export function heartbeatShouldForceTaskSnapshot(
  _isHeartbeat: boolean,
  _priorCalls: Array<{ name?: string }>,
  _currentCalls: Array<{ name?: string }>,
): boolean {
  // 2026-09-14: harness no longer injects Pulse. Model stops → turn ends.
  return false;
}

/**
 * Aoi 2026-09-10 gen32: GLM still calls alerts then memory/narration; the
 * reactive inject races the next 90s heartbeat. Prefetch the combined inbox
 * once at heartbeat start. The model stays free to choose the next action
 * (no Cortex tool_choice). This is the harness fallback. Do not open a ticket.
 */
export function heartbeatShouldPrefetchCombinedInbox(_input: {
  isHeartbeat: boolean;
  permissionMode?: string;
  talkSeat?: boolean;
}): boolean {
  // 2026-09-14: prefetch + fence user-message is what kept GLM circling
  // (Kumo/Ren). Codex / Claude Code / Grok Build do not fetch tools for the
  // model. The agent calls pulse_get_my_work itself, or stops.
  return false;
}

/** Heartbeat ended in narration after alerts (or tasks) without the next Pulse tool. */
export function heartbeatShouldInjectQueueToolsAfterNarration(
  _isHeartbeat: boolean,
  _priorCalls: Array<{ name?: string }>,
): { tasks: boolean; firstReady: boolean } {
  // 2026-09-14: narration / wrap-up / reasoning_only is a stop, not a cue
  // to inject pulse_get_my_work and continue.
  return { tasks: false, firstReady: false };
}

/**
 * Saki 2026-08-18: after the queue snapshot exists, the model re-calls
 * pulse_get_my_tasks until loop-break aborts. Hive then shows ready_no_progress
 * with 4–8 ready items and she never opens a ticket. Another tasks-only batch
 * means the runtime must open the first ready item itself.
 */
export function heartbeatShouldForceFirstReadyTask(
  _isHeartbeat: boolean,
  _priorCalls: Array<{ name?: string }>,
  _currentCalls: Array<{ name?: string }>,
): boolean {
  // Combined inbox is the backstop. Do not open a specific ticket for the model.
  return false;
}

/** Task half of a combined `pulse_get_my_work` snapshot, or the whole
 *  `pulse_get_my_tasks` payload when there is no `## Tasks` heading. */
export function pulseTasksTextFromSnapshot(raw: string): string {
  const text = String(raw ?? '');
  const parts = text.split(/^## Tasks\s*$/m);
  if (parts.length > 1) return parts.slice(1).join('\n');
  return text;
}

export function lastSuccessfulPulseTasksContent(
  calls: Array<{ name?: string }>,
  results: Array<{ content?: unknown; isError?: boolean }>,
): string | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (!heartbeatSawTaskInbox(calls[i]?.name)) continue;
    if (results[i]?.isError) continue;
    if (isHeartbeatInboxReplayContent(results[i]?.content)) continue;
    const content = results[i]?.content;
    if (content == null) continue;
    const raw = typeof content === 'string' ? content : JSON.stringify(content);
    return pulseTasksTextFromSnapshot(raw);
  }
  return null;
}

/** Prefetch (or a later real listing) showed at least one ready Pulse item. */
export function heartbeatSnapshotHasReadyWork(
  calls: Array<{ name?: string }>,
  results: Array<{ content?: unknown; isError?: boolean }>,
): boolean {
  const text = lastSuccessfulPulseTasksContent(calls, results);
  if (!text) return false;
  return parsePulseGetMyTasksResult(text).readyTaskCount > 0;
}

/** First queue-ordered ready Pulse key from a get_my_tasks markdown snapshot. */
export function firstReadyPulseTaskKeyFromSnapshot(content: string | null | undefined): string | null {
  const text = String(content ?? '');
  if (!text.trim()) return null;
  const ready: { key: string; schemaRepair: boolean }[] = [];
  const blocks = text.split(/(?=^- \*\*)/m);
  for (const block of blocks) {
    const key = block.match(/^- \*\*([A-Z][A-Z0-9]*-\d+)\*\*/)?.[1];
    if (!key) continue;
    if (/\bStatus:\s*blocked\b/i.test(block)) continue;
    if (pulseTaskStatusRows(block).some(row => row.ownerAwareness)) continue;
    ready.push({
      key,
      schemaRepair: /\[SCHEMA REPAIR:/i.test(block),
    });
  }
  // SCHEMA REPAIR todos are agent-doable form retries, but they rank urgent
  // and trap weak/looping seats into re-fetching the parent hold. Prefer a
  // real ready item when one exists; only open the repair if it is the
  // remaining work.
  return ready.find((row) => !row.schemaRepair)?.key ?? ready[0]?.key ?? null;
}

export function heartbeatDrainSawPulseAlerts(
  toolCalls: Array<{ name?: string }> | undefined,
): boolean {
  return (toolCalls ?? []).some((call) =>
    isPulseGetMyAlertsToolName(call.name) || isPulseGetMyWorkToolName(call.name));
}

/**
 * Queue-blind policy for a heartbeat turn.
 *
 * Pulse-driven seats (default) must expose a queue snapshot; two blind ticks
 * escalate to needs_help (PLAT-4172 / saki). Lean conversational seats are
 * not Pulse-queue-obligated — an empty assigned queue is the intended idle
 * state, and they do not even declare pulse_get_my_tasks.
 */
export interface HeartbeatQueueBlindPolicy {
  pulseQueueObligated?: boolean;
}

const DEFAULT_NEEDS_HELP_AFTER = Math.max(
  1,
  Number.parseInt(process.env['SHIZUHA_HEARTBEAT_NEEDS_HELP_AFTER'] ?? '2', 10) || 2,
);

export const HEARTBEAT_OUTCOME_LOG_PREFIX = '[heartbeat-outcome]';

const latestHeartbeatOutcomes = new Map<string, HeartbeatQueueDrainRecord>();

function needsHelpAfterValue(value?: number): number {
  return Math.max(1, value ?? DEFAULT_NEEDS_HELP_AFTER);
}

export function evaluateHeartbeatQueueDrainOutcome(input: HeartbeatQueueDrainInput): { outcome: HeartbeatQueueDrainOutcome; reason: string } {
  const readyTaskCount = Math.max(0, input.readyTaskCount);
  const blockedTaskCount = Math.max(0, input.blockedTaskCount ?? 0);
  const futureDueCount = Math.max(0, input.futureDueCount ?? 0);
  const progressEventCount = Math.max(0, input.progressEventCount ?? 0);
  const forwardedEventCount = Math.max(0, input.forwardedEventCount ?? 0);
  const consecutiveReadyNoProgressHeartbeats = Math.max(0, input.consecutiveReadyNoProgressHeartbeats ?? 0);
  const needsHelpAfter = needsHelpAfterValue(input.needsHelpAfter);

  if (forwardedEventCount > 0) {
    return { outcome: 'forwarded', reason: `${forwardedEventCount} forwarding event(s) recorded` };
  }
  if (progressEventCount > 0) {
    return { outcome: 'worked_task', reason: `${progressEventCount} progress event(s) recorded` };
  }
  if (readyTaskCount > 0 && consecutiveReadyNoProgressHeartbeats >= needsHelpAfter) {
    return {
      outcome: 'needs_help',
      reason: `${readyTaskCount} ready task(s) with no progress for ${consecutiveReadyNoProgressHeartbeats} heartbeat(s)`,
    };
  }
  if (readyTaskCount > 0) {
    return {
      outcome: 'ready_no_progress',
      reason: input.pulseGetMyTasksOnly
        ? `${readyTaskCount} ready task(s); heartbeat only checked Pulse queue`
        : `${readyTaskCount} ready task(s); no progress event recorded`,
    };
  }
  if (blockedTaskCount > 0) {
    return { outcome: 'all_blocked', reason: `${blockedTaskCount} blocked task(s), no ready tasks` };
  }
  if (futureDueCount > 0) {
    return { outcome: 'future_due', reason: `${futureDueCount} future/not-yet-due task(s), no ready tasks` };
  }
  return { outcome: 'queue_empty', reason: 'no actionable ready, blocked, or future tasks observed' };
}

/** Gateway idle-preflight proved the Pulse queue is empty. Record that as a
 *  healthy observation so a prior queue-blind needs_help cannot stick. */
export function recordObservedEmptyPulseQueue(
  agentId: string,
  observedAt = new Date().toISOString(),
): HeartbeatQueueDrainRecord {
  return recordHeartbeatQueueDrainOutcome(agentId, {
    readyTaskCount: 0,
    blockedTaskCount: 0,
    futureDueCount: 0,
    observedAt,
  });
}

/**
 * Pulse/file mutation on a non-heartbeat turn is the same producer evidence
 * as a worked heartbeat. Hive's needs_help flag is owned by this map; if we
 * only write it from source=heartbeat, a busy seat that never goes idle keeps
 * painting Needs help while audit shows comments/transitions (san/mio/nagi
 * 2026-09-09). Bash-only turns do not clear — that is Sato's idle-shell trap.
 */
export function recordObservedWorkProgress(
  agentId: string,
  turn: Pick<HeartbeatQueueDrainTurn, 'toolCalls' | 'toolResults'>,
  observedAt = new Date().toISOString(),
): HeartbeatQueueDrainRecord | null {
  const progressEventCount = countMutatingProgressEvents(turn);
  if (progressEventCount <= 0) return null;
  const previous = latestHeartbeatOutcomes.get(agentId);
  return recordHeartbeatQueueDrainOutcome(agentId, {
    readyTaskCount: previous?.readyTaskCount ?? 0,
    blockedTaskCount: previous?.blockedTaskCount ?? 0,
    futureDueCount: previous?.futureDueCount ?? 0,
    progressEventCount,
    observedAt,
  });
}

export function recordHeartbeatQueueDrainOutcome(
  agentId: string,
  input: Omit<HeartbeatQueueDrainInput, 'consecutiveReadyNoProgressHeartbeats'> & { observedAt?: string },
): HeartbeatQueueDrainRecord {
  const previous = latestHeartbeatOutcomes.get(agentId);
  const noProgressWithReady = Math.max(0, input.readyTaskCount) > 0
    && Math.max(0, input.progressEventCount ?? 0) === 0
    && Math.max(0, input.forwardedEventCount ?? 0) === 0;
  const consecutiveReadyNoProgressHeartbeats = noProgressWithReady
    ? (previous?.consecutiveReadyNoProgressHeartbeats ?? 0) + 1
    : 0;

  const evaluated = evaluateHeartbeatQueueDrainOutcome({
    ...input,
    consecutiveReadyNoProgressHeartbeats,
  });
  const record: HeartbeatQueueDrainRecord = {
    agentId,
    outcome: evaluated.outcome,
    reason: evaluated.reason,
    observedAt: input.observedAt ?? new Date().toISOString(),
    readyTaskCount: Math.max(0, input.readyTaskCount),
    blockedTaskCount: Math.max(0, input.blockedTaskCount ?? 0),
    futureDueCount: Math.max(0, input.futureDueCount ?? 0),
    progressEventCount: Math.max(0, input.progressEventCount ?? 0),
    forwardedEventCount: Math.max(0, input.forwardedEventCount ?? 0),
    pulseGetMyTasksOnly: Boolean(input.pulseGetMyTasksOnly),
    pulseGetMyAlertsObserved: input.pulseGetMyAlertsObserved ?? true,
    pulseAlertTaskOrderValid: input.pulseAlertTaskOrderValid ?? true,
    consecutiveReadyNoProgressHeartbeats,
    needsHelpAfter: needsHelpAfterValue(input.needsHelpAfter),
  };
  latestHeartbeatOutcomes.set(agentId, record);
  return record;
}

export function getHeartbeatQueueDrainOutcome(agentId: string): HeartbeatQueueDrainRecord | undefined {
  return latestHeartbeatOutcomes.get(agentId);
}

/**
 * After a fruitless-session rotate, consecutive no-progress must restart.
 * Aoi 2026-09-09: consecutive=5 survived a wipe, so the next heartbeat
 * rotated an already-empty session two minutes later (messageCount=0).
 * needs_help stays until a later producer event with progress; only the
 * rotate trigger is re-armed.
 */
export function clearFruitlessConsecutiveAfterSessionRotate(agentId: string): void {
  const previous = latestHeartbeatOutcomes.get(agentId);
  if (!previous) return;
  latestHeartbeatOutcomes.set(agentId, {
    ...previous,
    consecutiveReadyNoProgressHeartbeats: 0,
  });
}

/**
 * Project the latest queue-drain result into the bridge telemetry envelope.
 *
 * Daemon-managed agents already publish this state through daemon-link frames,
 * but native k3s agents have no daemon-link.  Their authenticated Connect
 * telemetry is the common event-driven path to Hive, so keep the wire shape
 * explicit and stable here instead of duplicating it in every bridge.
 */
export function heartbeatQueueDrainTelemetry(agentId: string): Record<string, unknown> | null {
  const record = getHeartbeatQueueDrainOutcome(agentId);
  if (!record) return null;
  return {
    outcome: record.outcome,
    reason: record.reason,
    observed_at: record.observedAt,
    needs_help: record.outcome === 'needs_help',
    ready_task_count: record.readyTaskCount,
    blocked_task_count: record.blockedTaskCount,
    future_due_count: record.futureDueCount,
    progress_event_count: record.progressEventCount,
    forwarded_event_count: record.forwardedEventCount,
    pulse_get_my_tasks_only: record.pulseGetMyTasksOnly,
    pulse_get_my_alerts_observed: record.pulseGetMyAlertsObserved,
    pulse_alert_task_order_valid: record.pulseAlertTaskOrderValid,
    consecutive_ready_no_progress_heartbeats: record.consecutiveReadyNoProgressHeartbeats,
    needs_help_after: record.needsHelpAfter,
    ...(record.incompleteReason ? { incomplete_reason: record.incompleteReason } : {}),
  };
}

export function listHeartbeatQueueDrainOutcomes(): HeartbeatQueueDrainRecord[] {
  return [...latestHeartbeatOutcomes.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
}

export function clearHeartbeatQueueDrainOutcomesForTests(): void {
  latestHeartbeatOutcomes.clear();
}

export function formatHeartbeatQueueDrainOutcomeLogLine(record: HeartbeatQueueDrainRecord): string {
  return `${HEARTBEAT_OUTCOME_LOG_PREFIX} ${JSON.stringify(record)}`;
}

export function ingestHeartbeatQueueDrainOutcomeLogLine(line: string, agentIdOverride?: string): HeartbeatQueueDrainRecord | undefined {
  const index = line.indexOf(HEARTBEAT_OUTCOME_LOG_PREFIX);
  if (index < 0) return undefined;
  const jsonText = line.slice(index + HEARTBEAT_OUTCOME_LOG_PREFIX.length).trim();
  if (!jsonText) return undefined;
  try {
    const parsed = JSON.parse(jsonText) as HeartbeatQueueDrainRecord;
    const agentId = agentIdOverride ?? parsed?.agentId;
    if (!agentId || !parsed?.outcome) return undefined;
    const record: HeartbeatQueueDrainRecord = { ...parsed, agentId };
    latestHeartbeatOutcomes.set(agentId, record);
    return record;
  } catch {
    return undefined;
  }
}

/**
 * PLAT-4172: resolve the outcome for a heartbeat that exposed NO fresh Pulse
 * queue snapshot and did no progress/forwarding ("queue-blind"). A Pulse-driven
 * agent calls pulse_get_my_tasks on every heartbeat even when idle (heartbeat
 * protocol), so a run of turns that expose no snapshot at all is pathological
 * (poisoned/empty session, e.g. saki after a pod restart) rather than healthy
 * idleness. After a restart the daemon's in-memory last-known ready count is 0,
 * so we cannot gate on it — EVERY queue-blind turn accrues
 * consecutiveReadyNoProgressHeartbeats, and once it reaches needsHelpAfter the
 * agent flips to needs_help so the fleet watcher / Hive Agents page surfaces it.
 * Any *observed* heartbeat (recordHeartbeatQueueDrainOutcome) resets the counter,
 * so a healthy agent that exposes a snapshot each heartbeat never trips.
 */
function resolveQueueBlindOutcome(
  previous: HeartbeatQueueDrainRecord | undefined,
  notObservedReason: string,
  workDoneThisTurn = 0,
  pulseQueueObligated = true,
): { outcome: HeartbeatQueueDrainOutcome; reason: string; consecutiveReadyNoProgressHeartbeats: number } {
  // A turn that DID work is not a queue-blind pathology. The case this guard
  // exists for is a poisoned/empty session that does nothing at all (saki after
  // a pod restart); an agent running commands and editing files is the exact
  // opposite, and it skipped the queue check because it was busy working.
  //
  // Operator 2026-08-05 on shion — Shizuha CLI, 2 tasks in progress, active less
  // than a minute ago, flagged with "139 consecutive heartbeat(s) exposed no
  // Pulse queue snapshot":
  //
  //     this needs help in Shion makes no sense given that Shion is doing its
  //     best maybe .. and is active as per its activity logs .. note that a
  //     single task can take upto an hour sometimes
  //
  // An involved task occupies many heartbeats without a queue check, so the
  // counter ran to 139 while the agent was working the whole time. Reset it:
  // evidence of work is evidence the session is alive.
  if (workDoneThisTurn > 0) {
    return {
      outcome: 'worked_task',
      reason: `${workDoneThisTurn} progress event(s) recorded; queue snapshot skipped while working`,
      consecutiveReadyNoProgressHeartbeats: 0,
    };
  }
  const priorReady = Math.max(0, previous?.readyTaskCount ?? 0);
  // Talkable / lean seats sit idle with no assigned Pulse work by design.
  // They do not declare pulse_get_my_tasks, so every model heartbeat is
  // "queue-blind". That is not a poisoned session — do not escalate.
  if (!pulseQueueObligated && priorReady <= 0) {
    return {
      outcome: 'queue_empty',
      reason: 'no Pulse queue snapshot required; no ready work assigned',
      consecutiveReadyNoProgressHeartbeats: 0,
    };
  }
  const consecutive = Math.max(0, previous?.consecutiveReadyNoProgressHeartbeats ?? 0) + 1;
  const needsHelpAfter = needsHelpAfterValue(previous?.needsHelpAfter);
  if (consecutive >= needsHelpAfter) {
    return {
      outcome: 'needs_help',
      reason: priorReady > 0
        ? `${priorReady} known ready task(s) and ${consecutive} consecutive heartbeat(s) exposed no Pulse queue snapshot`
        : `${consecutive} consecutive heartbeat(s) exposed no Pulse queue snapshot`,
      consecutiveReadyNoProgressHeartbeats: consecutive,
    };
  }
  return { outcome: 'not_observed', reason: notObservedReason, consecutiveReadyNoProgressHeartbeats: consecutive };
}

export function recordHeartbeatQueueDrainTurn(
  agentId: string,
  turn: HeartbeatQueueDrainTurn,
  observedAt = new Date().toISOString(),
  policy: HeartbeatQueueBlindPolicy = {},
): HeartbeatQueueDrainRecord {
  const record = evaluateHeartbeatQueueDrainTurn(agentId, turn, observedAt, policy);
  if (turn.incompleteReason) record.incompleteReason = turn.incompleteReason;
  if (turn.incompleteReason === 'semantic_compaction_failed') {
    record.outcome = 'needs_help';
    record.reason = 'Semantic compaction failed; active conversation preserved for a later attempt';
  }
  return record;
}

function evaluateHeartbeatQueueDrainTurn(
  agentId: string,
  turn: HeartbeatQueueDrainTurn,
  observedAt = new Date().toISOString(),
  policy: HeartbeatQueueBlindPolicy = {},
): HeartbeatQueueDrainRecord {
  const pulseQueueObligated = policy.pulseQueueObligated !== false;
  const pulseResults: string[] = [];
  let mutatingProgressEventCount = 0;
  let shellProgressEventCount = 0;
  let forwardedEventCount = 0;
  let pulseGetMyTasksCallCount = 0;
  let pulseGetMyAlertsCallCount = 0;

  for (let i = 0; i < turn.toolCalls.length; i++) {
    const toolName = normalizeToolName(turn.toolCalls[i]?.name ?? '');
    // A failed tool attempt is evidence of a broken/queue-blind heartbeat, not
    // progress. Counting failed shell guesses as work masked total Pulse MCP
    // unavailability and reset the needs-help detector on every heartbeat.
    if (turn.toolResults[i]?.isError) {
      continue;
    }
    if (isHeartbeatInboxReplayContent(turn.toolResults[i]?.content)) {
      continue;
    }
    if (isPulseGetMyWorkTool(toolName)) {
      pulseGetMyAlertsCallCount += 1;
      pulseGetMyTasksCallCount += 1;
      pulseResults.push(pulseTasksTextFromSnapshot(contentToText(turn.toolResults[i]?.content)));
      continue;
    }
    if (isPulseGetMyAlertsTool(toolName)) {
      pulseGetMyAlertsCallCount += 1;
      continue;
    }
    if (isPulseGetMyTasksTool(toolName)) {
      pulseGetMyTasksCallCount += 1;
      pulseResults.push(contentToText(turn.toolResults[i]?.content));
      continue;
    }
    if (isForwardingTool(toolName)) {
      forwardedEventCount += 1;
      continue;
    }
    if (isMutatingProgressTool(toolName)) {
      mutatingProgressEventCount += 1;
      continue;
    }
    if (isShellProgressTool(toolName)) {
      shellProgressEventCount += 1;
    }
  }
  // Sato 2026-08-17: a completed idle heartbeat whose only "work" is bash
  // (`check comments again` / `queue unchanged`) was scored worked_task and
  // fast-rearmed every 60s at 330k tokens. Shell is real progress only when
  // the same drain also mutated something (edit/write/Pulse/GitHub).
  const progressEventCount = mutatingProgressEventCount > 0
    ? mutatingProgressEventCount + shellProgressEventCount
    : 0;

  const sawTaskInbox = pulseGetMyTasksCallCount > 0;
  // Prefetch + later listing stubs used to fail `count === toolCalls.length`
  // (stubs are skipped above so they do not overwrite the snapshot). Alerts +
  // tasks is also listing-only. Fruitless rotate must see that flag.
  const pulseGetMyTasksOnly = heartbeatTurnWasPulseListingOnly(turn) && pulseGetMyTasksCallCount > 0;
  if (!sawTaskInbox) {
    const previous = latestHeartbeatOutcomes.get(agentId);
    const reason = pulseGetMyAlertsCallCount === 0
      ? 'heartbeat did not expose a Pulse queue snapshot'
      : 'heartbeat reconciled alerts but did not expose a Pulse task queue snapshot';
    // Only real progress counts, NOT forwarding: a router that reassigns work
    // while never checking its own inboxes is still queue-blind, which is a
    // separate deliberate rule ('does not let forwarding mask a heartbeat that
    // skipped both Pulse inboxes').
    const resolved = resolveQueueBlindOutcome(previous, reason, progressEventCount, pulseQueueObligated);
    const record: HeartbeatQueueDrainRecord = {
      agentId,
      outcome: resolved.outcome,
      reason: resolved.reason,
      observedAt,
      readyTaskCount: previous?.readyTaskCount ?? 0,
      blockedTaskCount: previous?.blockedTaskCount ?? 0,
      futureDueCount: previous?.futureDueCount ?? 0,
      progressEventCount,
      forwardedEventCount,
      pulseGetMyTasksOnly,
      pulseGetMyAlertsObserved: pulseGetMyAlertsCallCount > 0,
      pulseAlertTaskOrderValid: false,
      consecutiveReadyNoProgressHeartbeats: resolved.consecutiveReadyNoProgressHeartbeats,
      needsHelpAfter: DEFAULT_NEEDS_HELP_AFTER,
    };
    latestHeartbeatOutcomes.set(agentId, record);
    return record;
  }

  // A diligent heartbeat may re-read the queue after doing work. Concatenating
  // snapshots made the parser count every task once per read (Jun reported 160
  // ready tasks for two identical 80-task snapshots). The final non-empty read
  // is the authoritative post-work queue state.
  const pulseText = [...pulseResults].reverse().find(result => result.trim())?.trim() ?? '';
  if (!pulseText) {
    const previous = latestHeartbeatOutcomes.get(agentId);
    // pulse_get_my_tasks was called but returned no queue snapshot content. If
    // the turn still made progress/forwarding, classify via evaluate and reset;
    // otherwise it is queue-blind and must accrue toward needs_help (PLAT-4172).
    const madeProgress = progressEventCount > 0 || forwardedEventCount > 0;
    const resolved = madeProgress
      ? {
          outcome: evaluateHeartbeatQueueDrainOutcome({
            readyTaskCount: previous?.readyTaskCount ?? 0,
            progressEventCount,
            forwardedEventCount,
          }).outcome,
          reason: 'heartbeat had progress/forwarding events but no Pulse queue snapshot content',
          consecutiveReadyNoProgressHeartbeats: 0,
        }
      : resolveQueueBlindOutcome(
        previous,
        'heartbeat called pulse_get_my_tasks but no queue snapshot content was available',
        progressEventCount,
        pulseQueueObligated,
      );
    const record: HeartbeatQueueDrainRecord = {
      agentId,
      outcome: resolved.outcome,
      reason: resolved.reason,
      observedAt,
      readyTaskCount: previous?.readyTaskCount ?? 0,
      blockedTaskCount: previous?.blockedTaskCount ?? 0,
      futureDueCount: previous?.futureDueCount ?? 0,
      progressEventCount,
      forwardedEventCount,
      pulseGetMyTasksOnly,
      pulseGetMyAlertsObserved: pulseGetMyAlertsCallCount > 0,
      pulseAlertTaskOrderValid: true,
      consecutiveReadyNoProgressHeartbeats: resolved.consecutiveReadyNoProgressHeartbeats,
      needsHelpAfter: DEFAULT_NEEDS_HELP_AFTER,
    };
    latestHeartbeatOutcomes.set(agentId, record);
    return record;
  }

  const snapshot = parsePulseGetMyTasksResult(pulseText);
  return recordHeartbeatQueueDrainOutcome(agentId, {
    ...snapshot,
    progressEventCount,
    forwardedEventCount,
    pulseGetMyTasksOnly,
    pulseGetMyAlertsObserved: pulseGetMyAlertsCallCount > 0,
    pulseAlertTaskOrderValid: true,
    observedAt,
  });
}

function pulseTaskStatusRows(text: string): Array<{ status: string; ownerAwareness: boolean }> {
  return [...text.matchAll(/^[ \t]*Status:[ \t]*([a-z_ -]+)[^\r\n]*(?:\r?\n[ \t]+Owner action:[ \t]*([a-z-]+)(?=[ \t(]|$))?/gim)]
    .map(match => ({
      status: match[1]?.trim().toLowerCase().replace(/\s+/g, '_') ?? '',
      ownerAwareness: match[2]?.toLowerCase() === 'awareness-only',
    }))
    .filter(row => Boolean(row.status));
}

export function parsePulseGetMyTasksResult(raw: string): Pick<HeartbeatQueueDrainInput, 'readyTaskCount' | 'blockedTaskCount' | 'futureDueCount'> {
  const text = raw.trim();
  if (!text || /No actionable tasks found/i.test(text)) {
    return { readyTaskCount: 0, blockedTaskCount: 0, futureDueCount: parseFutureDueCount(text) };
  }

  // Line-anchored on purpose. Every task in the snapshot renders its status
  // TWICE:
  //
  //   Status: in_progress | Priority: urgent
  //   Workflow: simple (status: In Progress)
  //
  // and the previous case-insensitive, unanchored match counted BOTH, doubling
  // every number this parser emits. Observed live 2026-08-05: shion held
  // exactly 2 tasks ("Found 2 task(s) — 2 actionable") and its needs_help chip
  // said "4 ready task(s)"; ren's 3 became 6, hiro's 2 ready + 2 blocked became
  // 4 + 4 — the operator read the cards as lying, and they were. Only the
  // line-leading `Status:` field is the task's status; the parenthesised
  // `(status: ...)` is workflow decoration on another line's tail.
  const statusRows = pulseTaskStatusRows(text);
  const statusMatches = statusRows.filter(row => !row.ownerAwareness).map(row => row.status);
  if (statusRows.length > 0) {
    const blockedTaskCount = statusMatches.filter(status => status === 'blocked').length;
    // `backlog` is a Pulse *pull lane* ("pull ONE highest-priority item… do not
    // churn the whole backlog"), not actionable-now work. Backlog EPICs/standing
    // items are surfaced by pulse_get_my_tasks in a separate section but must NOT
    // count toward the "ready tasks that must show progress" total — otherwise an
    // agent sitting on a pile of backlog EPICs (e.g. aoi's Architecture backlog)
    // is falsely flagged needs_help every heartbeat. Treat them as holding items
    // alongside scheduled/deferred (non-actionable → never trips ready_no_progress).
    const holdingStatuses = [
      'scheduled', 'deferred', 'future_due', 'not_yet_due', 'backlog',
      'awaiting_deploy', 'awaiting_merge', 'awaiting_verification',
      'verification', 'deploying', 'applying',
    ];
    const futureStatusCount = statusMatches.filter(status => holdingStatuses.includes(status)).length;
    const futureDueCount = futureStatusCount + parseFutureDueCount(text);
    const readyTaskCount = statusMatches.length - blockedTaskCount - futureStatusCount;
    return {
      readyTaskCount: Math.max(0, readyTaskCount),
      blockedTaskCount,
      futureDueCount: Math.max(0, futureDueCount),
    };
  }

  const found = text.match(/Found\s+(\d+)\s+task\(s\)/i)?.[1];
  const total = found ? Number.parseInt(found, 10) : 0;
  const blocked = (text.match(/\bblocked\b/gi) ?? []).length;
  const futureDueCount = parseFutureDueCount(text);
  return {
    readyTaskCount: Math.max(0, total - blocked - futureDueCount),
    blockedTaskCount: Math.max(0, blocked),
    futureDueCount,
  };
}

function normalizeToolName(name: string): string {
  return name.replace(/^functions\./, '').replace(/^mcp__/, '').replace(/-/g, '_');
}

function isPulseGetMyWorkTool(name: string): boolean {
  return name.endsWith('pulse_get_my_work') || name === 'pulse_get_my_work';
}

function isPulseGetMyTasksTool(name: string): boolean {
  return name.endsWith('pulse_get_my_tasks') || name === 'pulse_get_my_tasks';
}

function isPulseGetMyAlertsTool(name: string): boolean {
  return name.endsWith('pulse_get_my_alerts') || name === 'pulse_get_my_alerts';
}

function isForwardingTool(name: string): boolean {
  return name.endsWith('pulse_assign_task') || name === 'pulse_assign_task';
}

/**
 * Tools whose successful use is evidence the agent DID something this turn.
 *
 * 2026-08-05: this list only ever named Codex-bridge tools (`exec_command`,
 * `apply_patch`) plus a few Pulse/GitHub ones. A Shizuha CLI agent does its work
 * through `bash`, `edit`, `write` and `notebook` — none of which were here — so
 * an SCLI agent editing files and running commands all turn recorded ZERO
 * progress events. Two such heartbeats in a row and it was escalated to
 * `needs_help`.
 *
 * Operator, on shion (Shizuha CLI, 2 tasks in progress, last active <1 min ago,
 * flagged "Agent needs help"):
 *
 *     this needs help in Shion makes no sense given that Shion is doing its
 *     best maybe .. and is active as per its activity logs .. note that a single
 *     task can take upto an hour sometimes .. if a task is quite involved
 *
 * That is the failure exactly: the detector was built to catch an agent that is
 * STUCK, and instead caught every agent whose harness names its tools
 * differently from Codex. A long, involved task produces no Pulse transition for
 * many heartbeats, so the Pulse-only entries could not save it either.
 *
 * Keep in sync with `tools/toolsets.ts` WRITE_TOOLS — those are the tools that
 * change something, which is the definition of progress here. Reads (`read`,
 * `glob`, `grep`) are deliberately NOT progress: an agent that only looks around
 * for several heartbeats really may be stuck.
 *
 * 2026-08-17 Sato: bash ALONE is not enough. A completed idle heartbeat that
 * only shells (`check comments again`) was scored worked_task and fast-rearmed
 * every 60s at ~330k tokens. Shell still counts when the same drain also
 * mutated a file / Pulse / GitHub — that is the shion "involved task" shape.
 */
function isMutatingProgressTool(name: string): boolean {
  if (
    name === 'edit'
    || name === 'write'
    || name === 'notebook'
    || name === 'apply_patch'
    || name === 'task'
  ) {
    return true;
  }
  return name.endsWith('apply_patch')
    || name.endsWith('pulse_add_comment')
    || name.endsWith('pulse_execute_transition')
    || name.endsWith('pulse_create_task')
    || name.endsWith('pulse_link_pr')
    || name.endsWith('pulse_update_task')
    || name.includes('github');
}

export function countMutatingProgressEvents(
  turn: Pick<HeartbeatQueueDrainTurn, 'toolCalls' | 'toolResults'>,
): number {
  let mutating = 0;
  let shell = 0;
  for (let i = 0; i < turn.toolCalls.length; i++) {
    if (turn.toolResults[i]?.isError) continue;
    const toolName = normalizeToolName(turn.toolCalls[i]?.name ?? '');
    if (isMutatingProgressTool(toolName)) mutating += 1;
    else if (isShellProgressTool(toolName)) shell += 1;
  }
  return mutating > 0 ? mutating + shell : 0;
}

function isShellProgressTool(name: string): boolean {
  return name === 'bash'
    || name === 'exec_command'
    || name.endsWith('exec_command');
}

function parseFutureDueCount(text: string): number {
  const explicit = text.match(/\+(\d+)\s+not yet due/i)?.[1];
  if (explicit) return Number.parseInt(explicit, 10) || 0;
  return /not yet due|future due/i.test(text) ? 1 : 0;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentToText).join('\n');
  if (content && typeof content === 'object') {
    const record = content as Record<string, unknown>;
    if (typeof record['text'] === 'string') return record['text'];
    if (typeof record['content'] === 'string') return record['content'];
    if (typeof record['result'] === 'string') return record['result'];
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  return content == null ? '' : String(content);
}
