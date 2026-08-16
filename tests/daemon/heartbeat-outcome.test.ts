import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearHeartbeatQueueDrainOutcomesForTests,
  evaluateHeartbeatQueueDrainOutcome,
  formatHeartbeatQueueDrainOutcomeLogLine,
  getHeartbeatQueueDrainOutcome,
  heartbeatQueueDrainTelemetry,
  ingestHeartbeatQueueDrainOutcomeLogLine,
  parsePulseGetMyTasksResult,
  recordHeartbeatQueueDrainOutcome,
  recordHeartbeatQueueDrainTurn,
  recordObservedEmptyPulseQueue,
} from '../../src/daemon/heartbeat-outcome.js';

describe('heartbeat queue-drain outcome telemetry', () => {
  beforeEach(() => {
    clearHeartbeatQueueDrainOutcomesForTests();
  });

  it('classifies empty, blocked, future-due, worked, and forwarded outcomes', () => {
    expect(evaluateHeartbeatQueueDrainOutcome({ readyTaskCount: 0 }).outcome).toBe('queue_empty');
    expect(evaluateHeartbeatQueueDrainOutcome({ readyTaskCount: 0, blockedTaskCount: 2 }).outcome).toBe('all_blocked');
    expect(evaluateHeartbeatQueueDrainOutcome({ readyTaskCount: 0, futureDueCount: 1 }).outcome).toBe('future_due');
    expect(evaluateHeartbeatQueueDrainOutcome({ readyTaskCount: 3, progressEventCount: 1 }).outcome).toBe('worked_task');
    expect(evaluateHeartbeatQueueDrainOutcome({ readyTaskCount: 3, forwardedEventCount: 1 }).outcome).toBe('forwarded');
  });

  it('escalates repeated ready-work/no-progress heartbeat checks to needs_help', () => {
    const first = recordHeartbeatQueueDrainOutcome('codex-idle', {
      readyTaskCount: 1,
      pulseGetMyTasksOnly: true,
      needsHelpAfter: 2,
      observedAt: '2026-06-30T00:00:00.000Z',
    });
    expect(first.outcome).toBe('ready_no_progress');

    const second = recordHeartbeatQueueDrainOutcome('codex-idle', {
      readyTaskCount: 1,
      pulseGetMyTasksOnly: true,
      needsHelpAfter: 2,
      observedAt: '2026-06-30T00:05:00.000Z',
    });
    expect(second.outcome).toBe('needs_help');
    expect(getHeartbeatQueueDrainOutcome('codex-idle')).toMatchObject({
      outcome: 'needs_help',
      consecutiveReadyNoProgressHeartbeats: 2,
    });
    expect(heartbeatQueueDrainTelemetry('codex-idle')).toMatchObject({
      outcome: 'needs_help',
      needs_help: true,
      observed_at: '2026-06-30T00:05:00.000Z',
      ready_task_count: 1,
      consecutive_ready_no_progress_heartbeats: 2,
    });
  });

  it('serializes a later healthy outcome so consumers can clear needs_help', () => {
    recordHeartbeatQueueDrainOutcome('recovered', {
      readyTaskCount: 1,
      needsHelpAfter: 1,
    });
    recordHeartbeatQueueDrainOutcome('recovered', {
      readyTaskCount: 0,
      blockedTaskCount: 2,
      observedAt: '2026-07-16T22:40:00.000Z',
    });

    expect(heartbeatQueueDrainTelemetry('recovered')).toEqual({
      outcome: 'all_blocked',
      reason: '2 blocked task(s), no ready tasks',
      observed_at: '2026-07-16T22:40:00.000Z',
      needs_help: false,
      ready_task_count: 0,
      blocked_task_count: 2,
      future_due_count: 0,
      progress_event_count: 0,
      forwarded_event_count: 0,
      pulse_get_my_tasks_only: false,
      pulse_get_my_alerts_observed: true,
      pulse_alert_task_order_valid: true,
      consecutive_ready_no_progress_heartbeats: 0,
      needs_help_after: 2,
    });
  });

  it('parses Pulse get-my-tasks output into ready/blocked/future counts', () => {
    const parsed = parsePulseGetMyTasksResult(`Tasks for nagi@shizuha.com:
Found 3 task(s) — 3 actionable (+1 not yet due (>30d out), hidden by default).

- **PLAT-1**: ready
  Status: open | Priority: high
- **PLAT-2**: waiting
  Status: blocked | Priority: high
- **PLAT-3**: doing
  Status: in_progress | Priority: normal
`);

    expect(parsed).toEqual({ readyTaskCount: 2, blockedTaskCount: 1, futureDueCount: 1 });
  });

  it('does not double-count the workflow (status: ...) decoration — shion 2->4', () => {
    // The LIVE snapshot renders every task's status twice:
    //   Status: in_progress | Priority: urgent
    //   Workflow: simple (status: In Progress)
    // A case-insensitive unanchored match counted both, doubling every number:
    // shion held exactly 2 tasks and its chip said "4 ready task(s)"; ren's 3
    // became 6; hiro's 2 ready + 2 blocked became 4 + 4 (2026-08-05, operator:
    // "the card here seems to be lying"). The earlier tests missed it because
    // their fixtures omitted the Workflow line the real tool result carries.
    const parsed = parsePulseGetMyTasksResult(`Tasks for shion@shizuha.com (showing 2 of 2 active, queue-ordered; limit=5):

Found 2 task(s) — 2 actionable, 0 terminal.

- **MAIL-85**: [BLOCKER] Ganesh to run the auth test from his own session and return the evidence tuple — unblocks MAIL-82
  ID: 22014
  Status: in_progress | Priority: urgent
  Workflow: simple (status: In Progress)
  Assignee: shion@shizuha.com

- **PLAT-5521**: Upgrade Jaipur Jio Fiber (Villa 16-A) to Jio Business — static IP + high-data plan
  ID: 23796
  Status: in_progress | Priority: high
  Workflow: simple (status: In Progress)
  Team: admin-ops
  Assignee: shion@shizuha.com
`);

    expect(parsed).toEqual({ readyTaskCount: 2, blockedTaskCount: 0, futureDueCount: 0 });
  });

  it('does not double-count blocked either — hiro 2+2 -> 4+4', () => {
    const parsed = parsePulseGetMyTasksResult(`Tasks for hiro@shizuha.com:
Found 4 task(s) — 4 actionable.

- **CTX-598**: design revision
  Status: todo | Priority: high
  Workflow: autonomous-dev (status: To Do)
- **PLAT-4242**: pricing RFC
  Status: rfc_design | Priority: high
  Workflow: feature-request-rfc (status: Design / RFC)
- **PLS-776**: regression
  Status: blocked | Priority: high
  Workflow: autonomous-bug (status: Blocked)
- **ORIG-235**: deploy CI deadlock
  Status: blocked | Priority: urgent
  Workflow: autonomous-bug (status: Blocked)
`);

    expect(parsed).toEqual({ readyTaskCount: 2, blockedTaskCount: 2, futureDueCount: 0 });
  });

  it('does not count backlog pull-lane items as ready work (aoi false-positive needs_help)', () => {
    // Pulse renders backlog items in a separate "Backlog pull lane" section:
    // pull ONE, do not churn. They must NOT inflate readyTaskCount and trip
    // needs_help — an agent sitting on backlog EPICs is not "not progressing".
    const parsed = parsePulseGetMyTasksResult(`Tasks for aoi@shizuha.com:
Found 2 task(s) — 2 actionable.

- **PLAT-9**: real work
  Status: open | Priority: high
- **PLAT-10**: applied work awaiting review
  Status: in_progress | Priority: normal

**Backlog pull lane**: 8 parked backlog item(s) are assigned to you. Pull ONE highest-priority item; do not churn the whole backlog.

- **EVOL-1**: Architecture owns the EVOL backlog
  Status: backlog | Priority: normal
- **MAIL-3**: Mail epic
  Status: backlog | Priority: normal
- **SRCH-2**: Search epic
  Status: backlog | Priority: normal
`);

    // 2 actionable (open + in_progress); the 3 backlog EPICs are holding items.
    expect(parsed.readyTaskCount).toBe(2);
    expect(parsed.blockedTaskCount).toBe(0);
    expect(parsed.futureDueCount).toBe(3);
  });

  it('treats a backlog-only queue as future_due, never needs_help', () => {
    const parsed = parsePulseGetMyTasksResult(`Tasks for aoi@shizuha.com:
No actionable tasks found.

**Backlog pull lane**: 2 parked backlog item(s) are assigned to you.

- **BKS-4**: Books epic
  Status: backlog | Priority: normal
- **FIN-3**: Finance epic
  Status: backlog | Priority: normal
`);
    // "No actionable tasks found" short-circuits to 0/0/0 — either way no ready work.
    expect(parsed.readyTaskCount).toBe(0);
  });

  it('rejects a task-only Codex heartbeat that skipped assigned alerts', () => {
    const toolCalls = [{ name: 'mcp__shizuha-pulse__pulse_get_my_tasks' }];
    const toolResults = [{ content: `Tasks for nagi@shizuha.com:
Found 1 task(s) — 1 actionable.

- **PLAT-1108**: ready work
  Status: open | Priority: high
` }];

    const first = recordHeartbeatQueueDrainTurn('codex-regression', { toolCalls, toolResults }, '2026-06-30T01:00:00.000Z');
    const second = recordHeartbeatQueueDrainTurn('codex-regression', { toolCalls, toolResults }, '2026-06-30T01:05:00.000Z');

    expect(first).toMatchObject({
      outcome: 'not_observed',
      readyTaskCount: 0,
      pulseGetMyTasksOnly: true,
      pulseGetMyAlertsObserved: false,
      pulseAlertTaskOrderValid: false,
    });
    expect(second).toMatchObject({
      outcome: 'needs_help',
      readyTaskCount: 0,
      pulseGetMyTasksOnly: true,
      consecutiveReadyNoProgressHeartbeats: 2,
    });
  });

  it('rejects a heartbeat that reads tasks before alerts', () => {
    const first = recordHeartbeatQueueDrainTurn('wrong-order', {
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
      ],
      toolResults: [
        { content: 'No actionable tasks found' },
        { content: 'No active assigned alerts.' },
      ],
    });

    expect(first).toMatchObject({
      outcome: 'not_observed',
      pulseGetMyAlertsObserved: true,
      pulseAlertTaskOrderValid: false,
      consecutiveReadyNoProgressHeartbeats: 1,
    });
    expect(first.reason).toContain('out of order');
  });

  it('uses the final queue snapshot when a heartbeat checks Pulse more than once', () => {
    const first = `Tasks for jun@shizuha.com:
Found 3 task(s) — 3 actionable.

- **PLAT-1**: first
  Status: open | Priority: urgent
- **PLAT-2**: second
  Status: open | Priority: high
- **PLAT-3**: third
  Status: in_progress | Priority: high
`;
    const final = `Tasks for jun@shizuha.com:
Found 2 task(s) — 2 actionable.

- **PLAT-2**: second
  Status: open | Priority: high
- **PLAT-3**: third
  Status: in_progress | Priority: high
`;
    const outcome = recordHeartbeatQueueDrainTurn('jun', {
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
        { name: 'exec_command' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      ],
      toolResults: [
        { content: 'No active assigned alerts.' },
        { content: first },
        { content: 'tests passed' },
        { content: final },
      ],
    });

    expect(outcome).toMatchObject({
      outcome: 'worked_task',
      readyTaskCount: 2,
      progressEventCount: 1,
      pulseGetMyTasksOnly: false,
    });
  });

  it('ingests child bridge heartbeat outcome log lines into daemon-visible state', () => {
    const childRecord = recordHeartbeatQueueDrainOutcome('child-process-agent', {
      readyTaskCount: 1,
      pulseGetMyTasksOnly: true,
      observedAt: '2026-06-30T01:10:00.000Z',
    });
    const line = `  [Nagi] ${formatHeartbeatQueueDrainOutcomeLogLine(childRecord)}`;

    clearHeartbeatQueueDrainOutcomesForTests();
    const ingested = ingestHeartbeatQueueDrainOutcomeLogLine(line, 'daemon-agent-id');

    expect(ingested).toMatchObject({
      agentId: 'daemon-agent-id',
      outcome: 'ready_no_progress',
      readyTaskCount: 1,
      pulseGetMyTasksOnly: true,
    });
    expect(getHeartbeatQueueDrainOutcome('daemon-agent-id')).toMatchObject({
      outcome: 'ready_no_progress',
      readyTaskCount: 1,
    });
    expect(getHeartbeatQueueDrainOutcome('child-process-agent')).toBeUndefined();
  });

  it('makes ordered Codex alert/task heartbeat results daemon-visible through stdout ingestion', () => {
    const toolCalls = [
      { name: 'mcp__shizuha_pulse__pulse_get_my_alerts' },
      { name: 'mcp__shizuha_pulse__pulse_get_my_tasks' },
    ];
    const toolResults = [
      { content: 'No active assigned alerts.' },
      { content: `Tasks for nagi@shizuha.com:
Found 1 task(s) — 1 actionable.

- **PLAT-1108**: ready work
  Status: open | Priority: high
` },
    ];

    const childOutcome = recordHeartbeatQueueDrainTurn('codex-child', { toolCalls, toolResults }, '2026-06-30T01:15:00.000Z');
    const line = `  [Codex] ${formatHeartbeatQueueDrainOutcomeLogLine(childOutcome)}`;

    clearHeartbeatQueueDrainOutcomesForTests();
    ingestHeartbeatQueueDrainOutcomeLogLine(line, 'daemon-codex-agent');

    expect(getHeartbeatQueueDrainOutcome('daemon-codex-agent')).toMatchObject({
      outcome: 'ready_no_progress',
      readyTaskCount: 1,
      pulseGetMyTasksOnly: false,
      pulseGetMyAlertsObserved: true,
      pulseAlertTaskOrderValid: true,
    });
  });

  it('PLAT-4172: queue-blind heartbeats (no pulse_get_my_tasks) accrue and escalate to needs_help', () => {
    // saki repro: post-restart session emits ZERO tool calls per heartbeat.
    const blindTurn = { toolCalls: [], toolResults: [] };
    const first = recordHeartbeatQueueDrainTurn('saki', blindTurn, '2026-07-11T00:00:00.000Z');
    const second = recordHeartbeatQueueDrainTurn('saki', blindTurn, '2026-07-11T00:15:00.000Z');

    expect(first).toMatchObject({ outcome: 'not_observed', consecutiveReadyNoProgressHeartbeats: 1 });
    // needsHelpAfter defaults to 2 -> the second consecutive blind turn escalates.
    expect(second).toMatchObject({ outcome: 'needs_help', consecutiveReadyNoProgressHeartbeats: 2 });
  });

  it('PLAT-4172: a single queue-blind heartbeat does not escalate', () => {
    const only = recordHeartbeatQueueDrainTurn('once', { toolCalls: [], toolResults: [] }, '2026-07-11T00:00:00.000Z');
    expect(only.outcome).toBe('not_observed');
    expect(only.consecutiveReadyNoProgressHeartbeats).toBe(1);
  });

  it('PLAT-4172: an observed heartbeat between blind turns resets the counter (healthy agent never trips)', () => {
    const blindTurn = { toolCalls: [], toolResults: [] };
    const observedTurn = {
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      ],
      toolResults: [
        { content: 'No active assigned alerts.' },
        { content: 'Tasks for x@shizuha.com:\nFound 0 task(s) — 0 actionable.\n' },
      ],
    };
    recordHeartbeatQueueDrainTurn('healthy', blindTurn, '2026-07-11T00:00:00.000Z');
    const observed = recordHeartbeatQueueDrainTurn('healthy', observedTurn, '2026-07-11T00:15:00.000Z');
    expect(observed.consecutiveReadyNoProgressHeartbeats).toBe(0);
    const afterReset = recordHeartbeatQueueDrainTurn('healthy', blindTurn, '2026-07-11T00:30:00.000Z');
    // counter restarts from the reset, so one blind turn is still just not_observed.
    expect(afterReset).toMatchObject({ outcome: 'not_observed', consecutiveReadyNoProgressHeartbeats: 1 });
  });

  it('PLAT-4172: names the known ready count in the escalation reason when available', () => {
    const observedReady = {
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      ],
      toolResults: [
        { content: 'No active assigned alerts.' },
        { content: 'Tasks for saki@shizuha.com:\nFound 1 task(s) — 1 actionable.\n\n- **PLAT-1**: work\n  Status: in_progress | Priority: high\n' },
      ],
    };
    const blindTurn = { toolCalls: [], toolResults: [] };
    recordHeartbeatQueueDrainTurn('saki2', observedReady, '2026-07-11T00:00:00.000Z'); // ready seen = 1, counter 0
    recordHeartbeatQueueDrainTurn('saki2', blindTurn, '2026-07-11T00:15:00.000Z'); // blind 1
    const escalated = recordHeartbeatQueueDrainTurn('saki2', blindTurn, '2026-07-11T00:30:00.000Z'); // blind 2 -> needs_help
    expect(escalated.outcome).toBe('needs_help');
    expect(escalated.reason).toContain('1 known ready task');
  });

  it('does not let forwarding mask a heartbeat that skipped both Pulse inboxes', () => {
    const forwardTurn = {
      toolCalls: [{ name: 'mcp__shizuha-pulse__pulse_assign_task' }],
      toolResults: [{ content: 'Assigned' }],
    };
    recordHeartbeatQueueDrainTurn('router', { toolCalls: [], toolResults: [] }, '2026-07-11T00:00:00.000Z'); // blind 1
    const forwarded = recordHeartbeatQueueDrainTurn('router', forwardTurn, '2026-07-11T00:15:00.000Z');
    expect(forwarded.outcome).toBe('needs_help');
    expect(forwarded.consecutiveReadyNoProgressHeartbeats).toBe(2);
  });

  it('does not count failed shell guesses as heartbeat progress', () => {
    const failedTurn = {
      toolCalls: [{ name: 'exec_command' }, { name: 'exec_command' }, { name: 'exec_command' }],
      toolResults: [
        { content: 'tools is not defined', isError: true },
        { content: 'command not found', isError: true },
        { content: 'command not found', isError: true },
      ],
    };

    const first = recordHeartbeatQueueDrainTurn('jun-failed-shell', failedTurn, '2026-07-16T12:35:56.000Z');
    const second = recordHeartbeatQueueDrainTurn('jun-failed-shell', failedTurn, '2026-07-16T12:50:56.000Z');

    expect(first).toMatchObject({
      outcome: 'not_observed',
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 1,
    });
    expect(second).toMatchObject({
      outcome: 'needs_help',
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 2,
    });
  });

  it('does not treat a failed Pulse call as an observed queue snapshot', () => {
    const outcome = recordHeartbeatQueueDrainTurn('pulse-down', {
      toolCalls: [{ name: 'mcp__shizuha-pulse__pulse_get_my_tasks' }],
      toolResults: [{ content: 'transport unavailable', isError: true }],
    });

    expect(outcome).toMatchObject({
      outcome: 'not_observed',
      progressEventCount: 0,
      pulseGetMyTasksOnly: false,
    });
  });

  it('records a gateway idle-preflight empty queue as queue_empty so needs_help can clear', () => {
    recordHeartbeatQueueDrainTurn('hina', { toolCalls: [], toolResults: [] }, '2026-08-15T09:00:00.000Z');
    recordHeartbeatQueueDrainTurn('hina', { toolCalls: [], toolResults: [] }, '2026-08-15T09:30:00.000Z');
    expect(getHeartbeatQueueDrainOutcome('hina')?.outcome).toBe('needs_help');

    const cleared = recordObservedEmptyPulseQueue('hina', '2026-08-15T09:31:00.000Z');
    expect(cleared).toMatchObject({
      outcome: 'queue_empty',
      readyTaskCount: 0,
      consecutiveReadyNoProgressHeartbeats: 0,
    });
    expect(heartbeatQueueDrainTelemetry('hina')).toMatchObject({
      outcome: 'queue_empty',
      needs_help: false,
    });
  });

  it('does not escalate queue-blind heartbeats on a seat that is not Pulse-queue-obligated', () => {
    const blindTurn = { toolCalls: [], toolResults: [] };
    const first = recordHeartbeatQueueDrainTurn(
      'aya',
      blindTurn,
      '2026-08-15T09:00:00.000Z',
      { pulseQueueObligated: false },
    );
    const second = recordHeartbeatQueueDrainTurn(
      'aya',
      blindTurn,
      '2026-08-15T09:30:00.000Z',
      { pulseQueueObligated: false },
    );

    expect(first).toMatchObject({
      outcome: 'queue_empty',
      consecutiveReadyNoProgressHeartbeats: 0,
    });
    expect(second).toMatchObject({
      outcome: 'queue_empty',
      consecutiveReadyNoProgressHeartbeats: 0,
    });
    expect(second.reason).toContain('no ready work assigned');
    expect(heartbeatQueueDrainTelemetry('aya')).toMatchObject({
      outcome: 'queue_empty',
      needs_help: false,
    });
  });

  it('still escalates a non-obligated seat that already had ready work and then went blind', () => {
    const observedReady = {
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      ],
      toolResults: [
        { content: 'No active assigned alerts.' },
        { content: 'Tasks for aya@shizuha.com:\nFound 1 task(s) — 1 actionable.\n\n- **CEO-1**: work\n  Status: in_progress | Priority: high\n' },
      ],
    };
    const blindTurn = { toolCalls: [], toolResults: [] };
    recordHeartbeatQueueDrainTurn('aya-ready', observedReady, '2026-08-15T09:00:00.000Z', { pulseQueueObligated: false });
    recordHeartbeatQueueDrainTurn('aya-ready', blindTurn, '2026-08-15T09:30:00.000Z', { pulseQueueObligated: false });
    const escalated = recordHeartbeatQueueDrainTurn('aya-ready', blindTurn, '2026-08-15T10:00:00.000Z', { pulseQueueObligated: false });
    expect(escalated.outcome).toBe('needs_help');
    expect(escalated.reason).toContain('1 known ready task');
  });

});
