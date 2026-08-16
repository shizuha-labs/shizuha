/**
 * PLAT-1112: structured queue-drain outcome telemetry for heartbeat turns.
 *
 * This module is intentionally independent from manager.ts so both the daemon
 * dashboard and the gateway runtime can share the same in-memory outcome model
 * without introducing a manager↔gateway import cycle.
 */

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
  const pulseQueueObligated = policy.pulseQueueObligated !== false;
  const pulseResults: string[] = [];
  let progressEventCount = 0;
  let forwardedEventCount = 0;
  let pulseGetMyTasksCallCount = 0;
  let pulseGetMyAlertsCallCount = 0;
  let firstPulseGetMyAlertsCallIndex = -1;
  let firstPulseGetMyTasksCallIndex = -1;

  for (let i = 0; i < turn.toolCalls.length; i++) {
    const toolName = normalizeToolName(turn.toolCalls[i]?.name ?? '');
    // A failed tool attempt is evidence of a broken/queue-blind heartbeat, not
    // progress. Counting failed shell guesses as work masked total Pulse MCP
    // unavailability and reset the needs-help detector on every heartbeat.
    if (turn.toolResults[i]?.isError) {
      continue;
    }
    if (isPulseGetMyAlertsTool(toolName)) {
      pulseGetMyAlertsCallCount += 1;
      if (firstPulseGetMyAlertsCallIndex < 0) firstPulseGetMyAlertsCallIndex = i;
      continue;
    }
    if (isPulseGetMyTasksTool(toolName)) {
      pulseGetMyTasksCallCount += 1;
      if (firstPulseGetMyTasksCallIndex < 0) firstPulseGetMyTasksCallIndex = i;
      pulseResults.push(contentToText(turn.toolResults[i]?.content));
      continue;
    }
    if (isForwardingTool(toolName)) {
      forwardedEventCount += 1;
      continue;
    }
    if (isProgressTool(toolName)) {
      progressEventCount += 1;
    }
  }

  const pulseAlertTaskOrderValid = pulseGetMyAlertsCallCount > 0
    && pulseGetMyTasksCallCount > 0
    && firstPulseGetMyAlertsCallIndex < firstPulseGetMyTasksCallIndex;
  if (!pulseAlertTaskOrderValid) {
    const previous = latestHeartbeatOutcomes.get(agentId);
    const reason = pulseGetMyAlertsCallCount === 0
      ? 'heartbeat did not reconcile assigned alerts before the task queue'
      : pulseGetMyTasksCallCount === 0
        ? 'heartbeat reconciled alerts but did not expose a Pulse task queue snapshot'
        : 'heartbeat observed Pulse inboxes out of order; alerts must precede tasks';
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
      pulseGetMyTasksOnly: pulseGetMyTasksCallCount > 0
        && pulseGetMyTasksCallCount === turn.toolCalls.length,
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
      pulseGetMyTasksOnly: pulseGetMyTasksCallCount === turn.toolCalls.length,
      pulseGetMyAlertsObserved: true,
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
    pulseGetMyTasksOnly: pulseGetMyTasksCallCount === turn.toolCalls.length,
    pulseGetMyAlertsObserved: true,
    pulseAlertTaskOrderValid: true,
    observedAt,
  });
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
  const statusMatches = [...text.matchAll(/^\s*Status:\s*([a-z_ -]+)/gim)]
    .map(match => match[1]?.trim().toLowerCase().replace(/\s+/g, '_') ?? '')
    .filter(Boolean);
  if (statusMatches.length > 0) {
    const blockedTaskCount = statusMatches.filter(status => status === 'blocked').length;
    // `backlog` is a Pulse *pull lane* ("pull ONE highest-priority item… do not
    // churn the whole backlog"), not actionable-now work. Backlog EPICs/standing
    // items are surfaced by pulse_get_my_tasks in a separate section but must NOT
    // count toward the "ready tasks that must show progress" total — otherwise an
    // agent sitting on a pile of backlog EPICs (e.g. aoi's Architecture backlog)
    // is falsely flagged needs_help every heartbeat. Treat them as holding items
    // alongside scheduled/deferred (non-actionable → never trips ready_no_progress).
    const holdingStatuses = ['scheduled', 'deferred', 'future_due', 'not_yet_due', 'backlog'];
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
 */
function isProgressTool(name: string): boolean {
  // Shizuha CLI write tools (tools/toolsets.ts WRITE_TOOLS).
  if (
    name === 'bash'
    || name === 'edit'
    || name === 'write'
    || name === 'notebook'
    || name === 'apply_patch'
    || name === 'task'          // spawning a sub-agent is work being done
  ) {
    return true;
  }
  return name === 'exec_command'
    || name.endsWith('exec_command')
    || name.endsWith('apply_patch')
    || name.endsWith('pulse_add_comment')
    || name.endsWith('pulse_execute_transition')
    || name.endsWith('pulse_link_pr')
    || name.includes('github');
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
