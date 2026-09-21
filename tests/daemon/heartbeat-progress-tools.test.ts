/**
 * "Needs help" must mean STUCK, not "your harness names its tools differently".
 *
 * Operator 2026-08-05, on shion — Shizuha CLI, Deputy Chief of Staff, 2 tasks in
 * progress, last active less than a minute ago — showing "Agent needs help":
 *
 *     this needs help in Shion makes no sense given that Shion is doing its best
 *     maybe .. and is active as per its activity logs .. note that a single task
 *     can take upto an hour sometimes .. if a task is quite involved
 *
 * `isProgressTool` only ever recognised Codex-bridge tool names (`exec_command`,
 * `apply_patch`) plus a few Pulse/GitHub ones. A Shizuha CLI agent works through
 * `bash`, `edit`, `write` and `notebook`, so a full turn of real work counted as
 * ZERO progress events. Two consecutive such heartbeats with any ready task and
 * the agent was escalated to `needs_help` — permanently, for as long as it kept
 * working. The Pulse entries could not rescue it either: a genuinely involved
 * task produces no transition or comment for many heartbeats.
 *
 * The detector's real subject — an agent with ready work that is doing nothing
 * about it — is preserved in the last block.
 */
import { describe, expect, it } from 'vitest';

import { evaluateHeartbeatQueueDrainOutcome } from '../../src/daemon/heartbeat-outcome.js';
import { recordHeartbeatQueueDrainTurn } from '../../src/daemon/heartbeat-outcome.js';

/** A turn shaped like the recorder expects: parallel toolCalls/toolResults. */
function turn(names: string[], { failed = false } = {}) {
  return {
    toolCalls: names.map((name) => ({ name })),
    toolResults: names.map(() => ({ isError: failed, content: '' })),
  };
}

describe('SCLI work tools count as progress', () => {
  for (const tool of ['edit', 'write', 'notebook', 'apply_patch', 'task']) {
    it(`counts ${tool} as a progress event`, () => {
      const record = recordHeartbeatQueueDrainTurn(`agent-${tool}`, turn([tool]) as never);
      expect(
        record.progressEventCount,
        `${tool} is how a Shizuha CLI agent does work; it must reset the `
          + 'needs-help counter',
      ).toBeGreaterThan(0);
    });
  }

  it('counts bash as progress only when the same drain also mutated something', () => {
    const record = recordHeartbeatQueueDrainTurn(
      'agent-bash-with-edit',
      turn(['bash', 'edit']) as never,
    );
    expect(record.progressEventCount).toBeGreaterThan(0);
    expect(record.outcome).toBe('worked_task');
  });

  it('a working SCLI turn is worked_task, not needs_help', () => {
    // shion's shape: ready work AND real tool use, several heartbeats deep.
    const outcome = evaluateHeartbeatQueueDrainOutcome({
      readyTaskCount: 2,
      progressEventCount: 5,
      consecutiveReadyNoProgressHeartbeats: 9,
      needsHelpAfter: 2,
    });
    expect(outcome.outcome).toBe('worked_task');
  });
});

describe('bash-only completed heartbeats are not progress (Sato 2026-08-17)', () => {
  it('does not count a bash-only drain as progress', () => {
    const record = recordHeartbeatQueueDrainTurn(
      'agent-sato-reread',
      turn(['bash', 'bash']) as never,
    );
    expect(record.progressEventCount).toBe(0);
  });

  it('does not count exec_command-only as progress', () => {
    const record = recordHeartbeatQueueDrainTurn(
      'agent-exec-only',
      turn(['exec_command']) as never,
    );
    expect(record.progressEventCount).toBe(0);
  });

  it('escalates a ready seat that only shells on consecutive heartbeats', () => {
    const id = `sato-spin-${Math.abs(Date.now() % 100000)}`;
    const first = recordHeartbeatQueueDrainTurn(id, turn(['bash']) as never);
    expect(first.outcome).not.toBe('worked_task');
    const second = recordHeartbeatQueueDrainTurn(id, turn(['bash', 'bash']) as never);
    expect(second.outcome).toBe('needs_help');
  });

  it('Pulse-observed bash-only heartbeats do not count as worked_task', () => {
    const id = `sato-pulse-bash-${Math.abs((Date.now() + 7) % 100000)}`;
    const drain = {
      toolCalls: [
        { name: 'mcp__shizuha-pulse__pulse_get_my_alerts' },
        { name: 'mcp__shizuha-pulse__pulse_get_my_tasks' },
        { name: 'bash' },
      ],
      toolResults: [
        { isError: false, content: 'No firing alerts' },
        { isError: false, content: 'Found 3 task(s) — 3 actionable.\n\n- **BKSK-5**: x\n  Status: in_progress | Priority: urgent\n' },
        { isError: false, content: 'ok' },
      ],
    };
    const first = recordHeartbeatQueueDrainTurn(id, drain as never);
    expect(first.progressEventCount).toBe(0);
    expect(first.readyTaskCount).toBeGreaterThan(0);
    expect(first.outcome).toBe('ready_no_progress');
    const second = recordHeartbeatQueueDrainTurn(id, drain as never);
    expect(second.outcome).toBe('needs_help');
  });
});

describe('reads alone are still not progress', () => {
  for (const tool of ['read', 'glob', 'grep']) {
    it(`does not count ${tool}`, () => {
      const record = recordHeartbeatQueueDrainTurn(`agent-ro-${tool}`, turn([tool]) as never);
      expect(
        record.progressEventCount,
        'an agent that only looks around for several heartbeats really may be stuck',
      ).toBe(0);
    });
  }
});

describe('failed tool calls are not progress', () => {
  it('ignores an errored bash call', () => {
    const record = recordHeartbeatQueueDrainTurn(
      'agent-failed', turn(['bash'], { failed: true }) as never,
    );
    expect(
      record.progressEventCount,
      'a failed shell guess masked total Pulse MCP unavailability once already',
    ).toBe(0);
  });
});

describe('the detector still catches a genuinely stuck agent', () => {
  it('escalates ready work with no progress at all', () => {
    const outcome = evaluateHeartbeatQueueDrainOutcome({
      readyTaskCount: 3,
      progressEventCount: 0,
      forwardedEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 2,
      needsHelpAfter: 2,
    });
    expect(outcome.outcome).toBe('needs_help');
  });

  it('does not escalate before the threshold', () => {
    const outcome = evaluateHeartbeatQueueDrainOutcome({
      readyTaskCount: 3,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 1,
      needsHelpAfter: 2,
    });
    expect(outcome.outcome).toBe('ready_no_progress');
  });

  it('never escalates when there is no ready work', () => {
    const outcome = evaluateHeartbeatQueueDrainOutcome({
      readyTaskCount: 0,
      progressEventCount: 0,
      consecutiveReadyNoProgressHeartbeats: 9,
      needsHelpAfter: 2,
    });
    expect(outcome.outcome).not.toBe('needs_help');
  });
});

describe('a busy agent is not "queue-blind"', () => {
  // Operator 2026-08-05, on shion showing
  //   "2 known ready task(s) and 139 consecutive heartbeat(s) exposed no Pulse
  //    queue snapshot"
  // while it had 2 tasks in progress and was active seconds earlier.
  //
  // The queue-blind guard exists to catch a poisoned/empty session that does
  // NOTHING (saki after a pod restart). A turn full of real tool work is the
  // opposite: it skipped the queue check because it was busy. An involved task
  // occupies many heartbeats, so the counter ran to 139 while the agent worked.
  const record = recordHeartbeatQueueDrainTurn;

  function busyTurn(agentId: string) {
    // No pulse_get_my_alerts / pulse_get_my_tasks at all — the queue-blind shape.
    return record(agentId, {
      toolCalls: [{ name: 'bash' }, { name: 'edit' }, { name: 'read' }],
      toolResults: [{ isError: false, content: '' }, { isError: false, content: '' },
        { isError: false, content: '' }],
    } as never);
  }

  function inertTurn(agentId: string) {
    return record(agentId, {
      toolCalls: [{ name: 'read' }],
      toolResults: [{ isError: false, content: '' }],
    } as never);
  }

  it('does not escalate an agent that is doing real work', () => {
    const id = `busy-${Math.abs(Date.now() % 100000)}`;
    for (let i = 0; i < 10; i++) {
      const rec = busyTurn(id);
      expect(
        rec.outcome,
        `heartbeat ${i + 1}: a working agent must never be flagged needs_help `
          + 'for skipping the queue check while working',
      ).not.toBe('needs_help');
    }
  });

  it('keeps the consecutive counter at zero while work continues', () => {
    const id = `busy2-${Math.abs((Date.now() + 1) % 100000)}`;
    busyTurn(id);
    const rec = busyTurn(id);
    expect(rec.consecutiveReadyNoProgressHeartbeats).toBe(0);
  });

  it('STILL escalates a genuinely inert queue-blind session', () => {
    // The saki case this guard was built for must keep working.
    const id = `inert-${Math.abs((Date.now() + 2) % 100000)}`;
    inertTurn(id);
    const rec = inertTurn(id);
    expect(
      rec.outcome,
      'a session that exposes no queue snapshot AND does no work is the '
        + 'poisoned-session case the guard exists for',
    ).toBe('needs_help');
  });

  it('a working turn clears a counter built up while inert', () => {
    const id = `mixed-${Math.abs((Date.now() + 3) % 100000)}`;
    inertTurn(id);
    inertTurn(id);
    const recovered = busyTurn(id);
    expect(recovered.consecutiveReadyNoProgressHeartbeats).toBe(0);
    expect(recovered.outcome).not.toBe('needs_help');
  });
});
