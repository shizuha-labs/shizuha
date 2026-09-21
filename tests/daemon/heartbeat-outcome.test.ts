import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearHeartbeatQueueDrainOutcomesForTests,
  evaluateHeartbeatQueueDrainOutcome,
  formatHeartbeatQueueDrainOutcomeLogLine,
  getHeartbeatQueueDrainOutcome,
  heartbeatDrainSawPulseAlerts,
  heartbeatQueueDrainTelemetry,
  heartbeatShouldForceTaskSnapshot,
  heartbeatShouldInjectQueueToolsAfterNarration,
  heartbeatShouldPrefetchCombinedInbox,
  heartbeatShouldForceFirstReadyTask,
  heartbeatInboxReplayContent,
  shouldDiscardSalvagedInboxListing,
  heartbeatLoopBreakMessage,
  heartbeatTurnWasPulseListingOnly,
  HEARTBEAT_INBOX_ALREADY_FETCHED,
  HEARTBEAT_LISTING_LOOP_BREAK,
  HEARTBEAT_GET_TASK_LOOP_BREAK,
  lastSuccessfulPulseTasksContent,
  firstReadyPulseTaskKeyFromSnapshot,
  isPulseGetTaskToolName,
  ingestHeartbeatQueueDrainOutcomeLogLine,
  isPulseGetMyAlertsToolName,
  parsePulseGetMyTasksResult,
  recordHeartbeatQueueDrainOutcome,
  recordHeartbeatQueueDrainTurn,
  recordObservedEmptyPulseQueue,
  recordObservedWorkProgress,
  clearFruitlessConsecutiveAfterSessionRotate,
} from '../../src/daemon/heartbeat-outcome.js';

const ownerAwarenessMcpFixture = `Found 1 task(s) — 1 active (0 ready/movable, 0 blocked/waiting, 1 awareness-only), 0 terminal.

- **PLS-1227**: Answered ask retained for awareness
  ID: 34910
  Status: resolved_elsewhere | Priority: urgent
  Owner action: awareness-only (retained ownership; no action required in this workflow state)
  Workflow: simple (status: ?)
  Assignee: rui@shizuha.com

`;

describe('heartbeat queue-drain outcome telemetry', () => {
  beforeEach(() => {
    clearHeartbeatQueueDrainOutcomesForTests();
  });

  it('honors the actual Pulse owner-awareness formatter in queue telemetry', () => {
    expect(parsePulseGetMyTasksResult(ownerAwarenessMcpFixture)).toEqual({
      readyTaskCount: 0, blockedTaskCount: 0, futureDueCount: 0,
    });
    expect(firstReadyPulseTaskKeyFromSnapshot(ownerAwarenessMcpFixture)).toBeNull();
    expect(ownerAwarenessMcpFixture).toContain('Status: resolved_elsewhere');
  });

  it('does not re-escalate repeated actual awareness-only inbox snapshots', () => {
    const calls = [{ name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
      { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' }];
    const results = [{ content: 'No active alerts assigned to rui@shizuha.com.' },
      { content: ownerAwarenessMcpFixture }];
    for (let turn = 0; turn < 3; turn++) {
      recordHeartbeatQueueDrainTurn('rui-awareness', { toolCalls: calls, toolResults: results });
      expect(heartbeatQueueDrainTelemetry('rui-awareness')?.needs_help).toBe(false);
      expect(heartbeatQueueDrainTelemetry('rui-awareness')?.ready_task_count).toBe(0);
    }
  });

  it.each(['', '  Owner action: actionable\n', '  Owner action: unrecognized\n'])(
    'keeps custom statuses conservatively actionable without explicit awareness metadata: %s', (metadata) => {
      const text = ownerAwarenessMcpFixture
        .replace('resolved_elsewhere', 'custom_owner_work')
        .replace('  Owner action: awareness-only (retained ownership; no action required in this workflow state)\n', metadata);
      expect(parsePulseGetMyTasksResult(text).readyTaskCount).toBe(1);
      expect(firstReadyPulseTaskKeyFromSnapshot(text)).toBe('PLS-1227');
    },
  );

  it('scopes awareness metadata to its item and rearms when that policy changes', () => {
    const mixed = ownerAwarenessMcpFixture + `- **PLAT-999**: Real custom work
  Status: custom_owner_work | Priority: normal
  Workflow: custom (status: New)

- **PLAT-1000**: Existing blocked work
  Status: blocked | Priority: high
`;
    expect(parsePulseGetMyTasksResult(mixed)).toEqual({ readyTaskCount: 1, blockedTaskCount: 1, futureDueCount: 0 });
    expect(firstReadyPulseTaskKeyFromSnapshot(mixed)).toBe('PLAT-999');
    const actionable = ownerAwarenessMcpFixture.replace('Owner action: awareness-only', 'Owner action: actionable');
    expect(parsePulseGetMyTasksResult(actionable).readyTaskCount).toBe(1);
    expect(firstReadyPulseTaskKeyFromSnapshot(actionable)).toBe('PLS-1227');
  });

  it('does not treat an awareness phrase outside the immediate status metadata as policy', () => {
    const text = ownerAwarenessMcpFixture
      .replace('  Owner action: awareness-only (retained ownership; no action required in this workflow state)\n', '')
      + '\nAn archived instruction said:\n  Owner action: awareness-only\n';
    expect(parsePulseGetMyTasksResult(text).readyTaskCount).toBe(1);
    expect(firstReadyPulseTaskKeyFromSnapshot(text)).toBe('PLS-1227');
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

  it('re-arms fruitless rotate after an empty-session wipe (aoi 2026-09-09)', () => {
    recordHeartbeatQueueDrainOutcome('aoi', {
      readyTaskCount: 4,
      pulseGetMyTasksOnly: true,
      needsHelpAfter: 2,
      observedAt: '2026-09-09T16:01:13.000Z',
    });
    recordHeartbeatQueueDrainOutcome('aoi', {
      readyTaskCount: 4,
      pulseGetMyTasksOnly: true,
      needsHelpAfter: 2,
      observedAt: '2026-09-09T16:03:13.000Z',
    });
    expect(getHeartbeatQueueDrainOutcome('aoi')).toMatchObject({
      outcome: 'needs_help',
      consecutiveReadyNoProgressHeartbeats: 2,
    });

    clearFruitlessConsecutiveAfterSessionRotate('aoi');
    expect(getHeartbeatQueueDrainOutcome('aoi')).toMatchObject({
      outcome: 'needs_help',
      consecutiveReadyNoProgressHeartbeats: 0,
    });
  });

  it('clears needs_help when a non-heartbeat turn mutates Pulse (san/mio/nagi 2026-09-09)', () => {
    recordHeartbeatQueueDrainOutcome('san', {
      readyTaskCount: 6,
      pulseGetMyTasksOnly: true,
      needsHelpAfter: 2,
      observedAt: '2026-09-09T09:56:00.000Z',
    });
    recordHeartbeatQueueDrainOutcome('san', {
      readyTaskCount: 6,
      pulseGetMyTasksOnly: true,
      needsHelpAfter: 2,
      observedAt: '2026-09-09T09:56:25.000Z',
    });
    expect(getHeartbeatQueueDrainOutcome('san')?.outcome).toBe('needs_help');

    const cleared = recordObservedWorkProgress('san', {
      toolCalls: [{ name: 'mcp__shizuha-pulse__pulse_add_comment' }],
      toolResults: [{ content: 'Comment added (ID: 682078)', isError: false }],
    }, '2026-09-09T16:07:17.000Z');
    expect(cleared?.outcome).toBe('worked_task');
    expect(heartbeatQueueDrainTelemetry('san')).toMatchObject({
      outcome: 'worked_task',
      needs_help: false,
      consecutive_ready_no_progress_heartbeats: 0,
      observed_at: '2026-09-09T16:07:17.000Z',
    });
  });

  it('does not clear needs_help on bash-only non-heartbeat turns (Sato idle-shell)', () => {
    recordHeartbeatQueueDrainOutcome('aoi', {
      readyTaskCount: 4,
      needsHelpAfter: 1,
      observedAt: '2026-09-09T16:03:13.000Z',
    });
    expect(recordObservedWorkProgress('aoi', {
      toolCalls: [{ name: 'bash' }],
      toolResults: [{ content: '200', isError: false }],
    })).toBeNull();
    expect(getHeartbeatQueueDrainOutcome('aoi')?.outcome).toBe('needs_help');
  });

  it('counts pulse_create_task as mutating progress', () => {
    const cleared = recordObservedWorkProgress('ichi', {
      toolCalls: [{ name: 'mcp__shizuha-pulse__pulse_create_task' }],
      toolResults: [{ content: 'Created PLAT-8856', isError: false }],
    });
    expect(cleared?.outcome).toBe('worked_task');
  });

  it('counts pulse_update_task as mutating progress', () => {
    const cleared = recordObservedWorkProgress('nagi', {
      toolCalls: [{ name: 'mcp__shizuha-pulse__pulse_update_task' }],
      toolResults: [{ content: 'Updated: [PLAT-8348]', isError: false }],
    });
    expect(cleared?.outcome).toBe('worked_task');
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

  it('does not count awaiting_deploy as ready (Shion HIVE-1888 2026-09-15)', () => {
    const parsed = parsePulseGetMyTasksResult(`Tasks for shion@agents.shizuha.io:

Found 2 task(s) — 2 active (2 ready/movable, 0 blocked/waiting), 0 terminal.

- **HIVE-1888**: Restore EndpointSlice visibility
  ID: 27971
  Status: awaiting_deploy | Priority: urgent
  Workflow: Autonomous Bug (status: Awaiting Deploy)

- **PLS-1165**: Execute PLS-1154 roster fix
  ID: 33162
  Status: in_progress | Priority: urgent
  Workflow: simple (status: In Progress)
`);
    expect(parsed).toEqual({ readyTaskCount: 1, blockedTaskCount: 0, futureDueCount: 1 });
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

  it('treats a task-only heartbeat as an observed queue, not queue-blind', () => {
    const toolCalls = [{ name: 'mcp__shizuha-pulse__pulse_get_my_tasks' }];
    const toolResults = [{ content: `Tasks for nagi@shizuha.com:
Found 1 task(s) — 1 actionable.

- **PLAT-1108**: ready work
  Status: open | Priority: high
` }];

    const first = recordHeartbeatQueueDrainTurn('codex-regression', { toolCalls, toolResults }, '2026-06-30T01:00:00.000Z');

    expect(first).toMatchObject({
      outcome: 'ready_no_progress',
      readyTaskCount: 1,
      pulseGetMyTasksOnly: true,
      pulseGetMyAlertsObserved: false,
      pulseAlertTaskOrderValid: true,
    });
  });

  it('does not require alerts-before-tasks order', () => {
    const first = recordHeartbeatQueueDrainTurn('any-order', {
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
      outcome: 'queue_empty',
      pulseGetMyAlertsObserved: true,
      pulseAlertTaskOrderValid: true,
    });
  });

  it('treats pulse_get_my_work as both inboxes and parses only the Tasks half', () => {
    const outcome = recordHeartbeatQueueDrainTurn('combined-inbox', {
      toolCalls: [{ name: 'mcp__shizuha-pulse__pulse_get_my_work' }],
      toolResults: [{
        content: [
          'Your Pulse work (alerts + tasks, one snapshot). You choose what to advance.',
          '',
          '## Alerts',
          'Active alerts for aoi@shizuha.com:',
          '',
          '- **PLAT-41**: Origin CI failed',
          '  Status: firing | Priority: high',
          '',
          '## Tasks',
          'Tasks for aoi@shizuha.com (showing 1 of 1 active, queue-ordered; limit=5):',
          '',
          '- **PLAT-7824**: tls-sync VAP',
          '  Status: awaiting_deploy | Priority: urgent',
        ].join('\n'),
      }],
    });

    expect(outcome).toMatchObject({
      outcome: 'future_due',
      readyTaskCount: 0,
      blockedTaskCount: 0,
      futureDueCount: 1,
      pulseGetMyAlertsObserved: true,
      pulseAlertTaskOrderValid: true,
    });
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
        { name: 'edit' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      ],
      toolResults: [
        { content: 'No active assigned alerts.' },
        { content: first },
        { content: 'applied the failing test fix' },
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
      pulseGetMyTasksOnly: true,
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

  it('Sato-class bash-only heartbeat did not observe Pulse alerts', () => {
    expect(isPulseGetMyAlertsToolName('mcp__shizuha-pulse__pulse_get_my_alerts')).toBe(true);
    expect(isPulseGetMyAlertsToolName('bash')).toBe(false);
    expect(heartbeatDrainSawPulseAlerts([{ name: 'bash' }, { name: 'bash' }])).toBe(false);
    expect(heartbeatDrainSawPulseAlerts([
      { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
    ])).toBe(true);
  });

  it('never injects or prefetches Pulse — the model stops when it stops', () => {
    const alerts = [{ name: 'mcp__shizuha-pulse__pulse_get_my_alerts' }];
    const tasks = [{ name: 'mcp__shizuha-pulse__pulse_get_my_tasks' }];
    const work = [{ name: 'mcp__shizuha-pulse__pulse_get_my_work' }];
    expect(heartbeatShouldForceTaskSnapshot(true, alerts, alerts)).toBe(false);
    expect(heartbeatShouldForceTaskSnapshot(true, [], alerts)).toBe(false);
    expect(heartbeatShouldPrefetchCombinedInbox({ isHeartbeat: true })).toBe(false);
    expect(heartbeatShouldPrefetchCombinedInbox({
      isHeartbeat: true,
      permissionMode: 'default',
      talkSeat: false,
    })).toBe(false);
    expect(heartbeatShouldInjectQueueToolsAfterNarration(true, [])).toEqual({ tasks: false, firstReady: false });
    expect(heartbeatShouldInjectQueueToolsAfterNarration(true, alerts)).toEqual({ tasks: false, firstReady: false });
    expect(heartbeatShouldInjectQueueToolsAfterNarration(true, work)).toEqual({ tasks: false, firstReady: false });
    expect(heartbeatShouldInjectQueueToolsAfterNarration(true, tasks)).toEqual({ tasks: false, firstReady: false });
  });

  it('stubs inbox listing tools after prefetch without touching get_task', () => {
    expect(heartbeatInboxReplayContent('mcp__shizuha-pulse__pulse_get_my_work', false)).toBeNull();
    expect(heartbeatInboxReplayContent('mcp__shizuha-pulse__pulse_get_my_work', true)).toBe(HEARTBEAT_INBOX_ALREADY_FETCHED);
    expect(heartbeatInboxReplayContent('mcp__shizuha-pulse__pulse_get_my_alerts', true)).toBe(HEARTBEAT_INBOX_ALREADY_FETCHED);
    expect(heartbeatInboxReplayContent('mcp__shizuha-pulse__pulse_get_my_tasks', true)).toBe(HEARTBEAT_INBOX_ALREADY_FETCHED);
    expect(heartbeatInboxReplayContent('mcp__shizuha-pulse__pulse_get_task', true)).toBeNull();
    expect(heartbeatInboxReplayContent('mcp__shizuha-pulse__pulse_execute_transition', true)).toBeNull();
  });

  it('discards salvaged pulse_get_my_work only when the inbox is already in the turn', () => {
    expect(shouldDiscardSalvagedInboxListing('mcp__shizuha-pulse__pulse_get_my_work', true)).toBe(true);
    expect(shouldDiscardSalvagedInboxListing('mcp__shizuha-pulse__pulse_get_my_alerts', true)).toBe(true);
    expect(shouldDiscardSalvagedInboxListing('mcp__shizuha-pulse__pulse_get_my_work', false)).toBe(false);
    expect(shouldDiscardSalvagedInboxListing('mcp__shizuha-pulse__pulse_get_task', true)).toBe(false);
    expect(shouldDiscardSalvagedInboxListing('mcp__shizuha-hive__hive_list_fleet_agents', true)).toBe(false);
  });

  it('keeps the prefetch snapshot when a later get_my_work is the inbox stub (Ryo ping-pong)', () => {
    const snapshot = [
      'Your Pulse work (alerts + tasks, one snapshot). You choose what to advance.',
      '',
      '## Alerts',
      'No active alerts assigned to ryo@agents.shizuha.io.',
      '',
      '## Tasks',
      '- **PLAT-1**: ready work',
      '  Status: open | Priority: high',
    ].join('\n');
    expect(lastSuccessfulPulseTasksContent(
      [
        { name: 'mcp__shizuha-pulse__pulse_get_my_work' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_work' },
      ],
      [{ content: snapshot }, { content: HEARTBEAT_INBOX_ALREADY_FETCHED }],
    )).toContain('PLAT-1');
    recordHeartbeatQueueDrainOutcome('ryo-stub', { readyTaskCount: 5 });
    recordHeartbeatQueueDrainOutcome('ryo-stub', { readyTaskCount: 5 });
    const outcome = recordHeartbeatQueueDrainTurn('ryo-stub', {
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_work' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_work' },
      ],
      toolResults: [
        { content: snapshot },
        { content: HEARTBEAT_INBOX_ALREADY_FETCHED },
      ],
      incompleteReason: 'progress_only',
    });
    expect(outcome).toMatchObject({
      outcome: 'needs_help',
      readyTaskCount: 1,
      consecutiveReadyNoProgressHeartbeats: 3,
      incompleteReason: 'progress_only',
      pulseGetMyTasksOnly: true,
    });
  });

  it('treats alerts+tasks and prefetch+stub as listing-only (fruitless-rotate skip)', () => {
    expect(heartbeatTurnWasPulseListingOnly({
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
      ],
      toolResults: [{ content: 'none' }, { content: 'Tasks' }],
    })).toBe(true);
    expect(heartbeatTurnWasPulseListingOnly({
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_work' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_work' },
      ],
      toolResults: [{ content: 'snapshot' }, { content: HEARTBEAT_INBOX_ALREADY_FETCHED }],
    })).toBe(true);
    expect(heartbeatTurnWasPulseListingOnly({
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_work' },
        { name: 'mcp__shizuha-pulse__pulse_get_task' },
      ],
      toolResults: [{ content: 'snapshot' }, { content: 'opened' }],
    })).toBe(false);
    expect(heartbeatLoopBreakMessage('mcp__shizuha-pulse__pulse_get_my_work')).toBe(HEARTBEAT_LISTING_LOOP_BREAK);
    expect(heartbeatLoopBreakMessage('mcp__shizuha-pulse__pulse_get_my_alerts')).toBe(HEARTBEAT_LISTING_LOOP_BREAK);
    expect(heartbeatLoopBreakMessage('mcp__shizuha-pulse__pulse_get_task')).toBe(HEARTBEAT_GET_TASK_LOOP_BREAK);
    expect(HEARTBEAT_LISTING_LOOP_BREAK).not.toContain('Do not pulse_get_task');
    expect(HEARTBEAT_LISTING_LOOP_BREAK).not.toContain('Call pulse_get_task');
    expect(HEARTBEAT_LISTING_LOOP_BREAK).toContain('mcp__shizuha-pulse__pulse_get_task');
    expect(HEARTBEAT_LISTING_LOOP_BREAK).toContain('mcp__shizuha-pulse__pulse_add_comment');
    expect(HEARTBEAT_LISTING_LOOP_BREAK).toContain('mcp__shizuha-pulse__pulse_execute_transition');
    expect(HEARTBEAT_INBOX_ALREADY_FETCHED).toContain('mcp__shizuha-pulse__pulse_add_comment');
    expect(HEARTBEAT_INBOX_ALREADY_FETCHED).not.toContain(' or pulse_add_comment');
    expect(HEARTBEAT_INBOX_ALREADY_FETCHED).not.toMatch(/stay silent|end silent|Standing by/i);
    expect(HEARTBEAT_LISTING_LOOP_BREAK).not.toMatch(/stay silent|end silent|Standing by/i);
    expect(HEARTBEAT_GET_TASK_LOOP_BREAK).toContain('mcp__shizuha-pulse__pulse_get_task');
    expect(HEARTBEAT_GET_TASK_LOOP_BREAK).not.toContain('Do not pulse_get_task');
  });

  it('never opens a specific ticket for the model', () => {
    const tasks = [{ name: 'mcp__shizuha-pulse__pulse_get_my_tasks' }];
    const alerts = [{ name: 'mcp__shizuha-pulse__pulse_get_my_alerts' }];
    expect(isPulseGetTaskToolName('mcp__shizuha-pulse__pulse_get_task')).toBe(true);
    expect(isPulseGetTaskToolName('mcp__shizuha-pulse__pulse_get_my_tasks')).toBe(false);
    expect(heartbeatShouldForceFirstReadyTask(false, tasks, tasks)).toBe(false);
    expect(heartbeatShouldForceFirstReadyTask(true, alerts, tasks)).toBe(false);
    expect(heartbeatShouldForceFirstReadyTask(true, tasks, tasks)).toBe(false);
    expect(heartbeatShouldForceFirstReadyTask(
      true,
      [...tasks, { name: 'mcp__shizuha-pulse__pulse_get_task' }],
      tasks,
    )).toBe(false);
    expect(heartbeatShouldForceFirstReadyTask(true, tasks, [{ name: 'bash' }])).toBe(false);
    expect(heartbeatShouldForceFirstReadyTask(true, tasks, [])).toBe(false);
  });

  it('picks the first ready Pulse key and skips blocked items', () => {
    const snapshot = [
      'Tasks for saki@shizuha.com (showing top 5 of 8 active, queue-ordered; limit=5).',
      '',
      '- **PLAT-6226**: frozen Origin PR',
      '  Status: blocked | Priority: urgent',
      '',
      '- **SCLI-401**: mcp-multiplexer accepts invalid service entries',
      '  Status: open | Priority: high',
      '',
      '- **SCLI-404**: auth login EOF',
      '  Status: open | Priority: high',
    ].join('\n');
    expect(firstReadyPulseTaskKeyFromSnapshot(snapshot)).toBe('SCLI-401');
    expect(firstReadyPulseTaskKeyFromSnapshot('No active assigned tasks.')).toBe(null);
  });

  it('skips SCHEMA REPAIR todos when another ready item exists', () => {
    const snapshot = [
      'Tasks for revi@shizuha.com (showing top 5 of 18 active, queue-ordered; limit=5).',
      '',
      '- **HIVE-1953**: [SCHEMA REPAIR: missing_evidence_schema] [BLOCKER] HIVE-1952: Raise to Admin Ops',
      '  Status: todo | Priority: urgent',
      '',
      '- **PLS-986**: Security exact-version verdict on PLS-695 contract',
      '  Status: todo | Priority: urgent',
    ].join('\n');
    expect(firstReadyPulseTaskKeyFromSnapshot(snapshot)).toBe('PLS-986');
  });

  it('opens SCHEMA REPAIR when it is the only ready item', () => {
    const snapshot = [
      '- **HIVE-1953**: [SCHEMA REPAIR: missing_evidence_schema] retry typed evidence',
      '  Status: todo | Priority: urgent',
    ].join('\n');
    expect(firstReadyPulseTaskKeyFromSnapshot(snapshot)).toBe('HIVE-1953');
  });

});
