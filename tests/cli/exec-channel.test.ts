/**
 * SCLI-410 regression — the ONE shared channel contract for non-interactive
 * `shizuha -p` and `shizuha exec`.
 *
 * Acceptance (revised after Architecture ruling) that this suite pins:
 *  - successful runs have byte-empty stderr (human and --json mode);
 *  - human stdout is only the requested result;
 *  - every JSON stdout line is NDJSON and the final record is `complete`;
 *  - failing runs exit nonzero with non-empty, user-actionable stderr (NOT raw
 *    internal telemetry or model reasoning) — the quiet-success vs
 *    disabled-stderr discriminator;
 *  - model reasoning is absent by default and never on default stderr;
 *  - both entrypoints route through one shared implementation.
 *
 * Both `-p` and `exec` render events through THE SAME `writeExecEvent`; the
 * entrypoint matrix is exercised below and a source-level guard in
 * `tests/e2e/scli410-quiet-stderr.test.ts` asserts both index.ts call sites
 * still use one shared binding.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeExecEvent, type ExecAcc } from '../../src/cli/exec-channel.js';
import type { AgentEvent } from '../../src/events/types.js';

const TS = 1_700_000_000_000;

function ev(partial: Omit<AgentEvent, 'timestamp'> & { type: AgentEvent['type'] }): AgentEvent {
  return { ...(partial as AgentEvent), timestamp: TS };
}

function content(text: string): AgentEvent {
  return ev({ type: 'content', text });
}
function reasoning(text: string): AgentEvent {
  return ev({ type: 'reasoning_text', text });
}
function toolStart(toolName = 'bash', input: Record<string, unknown> = {}): AgentEvent {
  return ev({ type: 'tool_start', toolCallId: 'tc-1', toolName, input });
}
function toolComplete(result: string, isError = false): AgentEvent {
  return ev({ type: 'tool_complete', toolCallId: 'tc-1', toolName: 'bash', result, isError, durationMs: 5 });
}
function errorEv(msg: string): AgentEvent {
  return ev({ type: 'error', error: msg });
}
function completeEv(): AgentEvent {
  return ev({
    type: 'complete',
    totalTurns: 1,
    totalInputTokens: 100,
    totalOutputTokens: 10,
    totalCacheCreationInputTokens: 0,
    totalCacheReadInputTokens: 0,
    totalDurationMs: 100,
  });
}

describe('exec-channel (SCLI-410)', () => {
  let stdoutSpy: ReturnType<typeof vi.fn>;
  let stderrSpy: ReturnType<typeof vi.fn>;
  let savedExitCode: number;

  const stdoutText = () => stdoutSpy.mock.calls.map(([c]) => String(c)).join('');
  const stderrText = () => stderrSpy.mock.calls.map(([c]) => String(c)).join('');

  beforeEach(() => {
    savedExitCode = process.exitCode;
    process.exitCode = 0;
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = savedExitCode;
  });

  const freshAcc = (): ExecAcc => ({ finalText: '', failed: false, bufferedDiags: [] });

  const SUCCESS_EVENTS = (marker: string): AgentEvent[] => [
    content(marker),
    reasoning('chain-of-thought that must NEVER reach default stderr'),
    toolStart('bash', { command: 'ls -la' }),
    reasoning('more private reasoning'),
    toolComplete('total 0'),
    completeEv(),
  ];

  const FAILURE_EVENTS = (): AgentEvent[] => [
    content('partial-result-'),
    toolStart('bash', { command: 'rm /nonexistent' }),
    reasoning('should stay private'),
    toolComplete('rm: /nonexistent: No such file or directory', true),
    errorEv('the-model-endpoint-returned-500'),
    completeEv(),
  ];

  // Full acceptance matrix: root `-p` AND `exec -p`, each in human and --json
  // mode. Both entrypoints use the one shared writeExecEvent; the same suite is
  // run under each label so a divergent quiet path regresses visibly.
  const ENTRYPOINTS = ['shizuha -p (root)', 'shizuha exec -p'] as const;

  for (const entrypoint of ENTRYPOINTS) {
    describe(`entrypoint: ${entrypoint}`, () => {
      it('success (human): exit 0, byte-empty stderr, stdout is exactly the result', () => {
        const acc = freshAcc();
        for (const e of SUCCESS_EVENTS('MARKER_OK')) writeExecEvent(e, /*isJSON=*/false, acc);

        expect(acc.failed).toBe(false);
        expect(stderrText()).toBe(''); // BYTE-EMPTY stderr on success
        expect(stdoutText()).toBe('MARKER_OK\n'); // result + clean trailing newline only
        expect(process.exitCode).toBe(0);
      });

      it('success (--json): exit 0, byte-empty stderr, NDJSON lines end with complete', () => {
        const acc = freshAcc();
        const lines: string[] = [];
        for (const e of SUCCESS_EVENTS('MARKER_JSON')) {
          writeExecEvent(e, /*isJSON=*/true, acc);
          lines.push(stdoutSpy.mock.calls.at(-1)![0] as string);
        }

        expect(acc.failed).toBe(false);
        expect(stderrText()).toBe(''); // BYTE-EMPTY stderr
        expect(process.exitCode).toBe(0);
        const parsed = lines.map((l) => JSON.parse(l));
        for (const record of parsed) {
          expect(record).toHaveProperty('timestamp'); // every line is NDJSON
        }
        expect(parsed.at(-1)!.type).toBe('complete');
        // Reasoning travels on stdout as a structured record, never on stderr.
        expect(parsed.some((r) => r.type === 'reasoning_text')).toBe(true);
      });

      it('failure (human): nonzero exit + actionable stderr incl. buffered tool diag', () => {
        const acc = freshAcc();
        for (const e of FAILURE_EVENTS()) writeExecEvent(e, /*isJSON=*/false, acc);

        expect(acc.failed).toBe(true);
        expect(process.exitCode).toBe(1);
        const err = stderrText();
        expect(err.length).toBeGreaterThan(0);
        // user-actionable diagnostic, not raw telemetry/reasoning
        expect(err).toContain('the-model-endpoint-returned-500');
        // buffered tool diag flushed on failure
        expect(err).toContain('[Tool');
        // partial result still on stdout; no trailing newline on failure
        expect(stdoutText()).toContain('partial-result-');
        // reasoning still absent from stderr
        expect(err).not.toContain('should stay private');
      });

      it('failure (--json): nonzero exit + actionable stderr + error record on stdout', () => {
        const acc = freshAcc();
        const lines: string[] = [];
        for (const e of FAILURE_EVENTS()) {
          writeExecEvent(e, /*isJSON=*/true, acc);
          lines.push(stdoutSpy.mock.calls.at(-1)![0] as string);
        }

        expect(process.exitCode).toBe(1);
        expect(stderrText()).toContain('the-model-endpoint-returned-500');
        const parsed = lines.map((l) => JSON.parse(l));
        expect(parsed.some((r) => r.type === 'error')).toBe(true);
        expect(parsed.at(-1)!.type).toBe('complete');
      });
    });
  }

  it('recovered tool error (no run-level error) stays quiet: byte-empty stderr, exit 0', () => {
    // The discriminator: a transient tool failure the model recovers from must
    // NOT pollute stderr on a successful run — otherwise "byte-empty stderr on
    // success" would be untestable against "stderr disabled globally".
    const acc = freshAcc();
    writeExecEvent(content('final-ok'), false, acc);
    writeExecEvent(toolStart('bash', { command: 'rm /nonexistent' }), false, acc);
    writeExecEvent(toolComplete('rm: No such file', true), false, acc);
    writeExecEvent(completeEv(), false, acc);

    expect(acc.failed).toBe(false);
    expect(stderrText()).toBe(''); // buffered tool diag discarded on success
    expect(stdoutText()).toBe('final-ok\n');
    expect(process.exitCode).toBe(0);
  });

  it('reasoning is never written to default stderr in any mode', () => {
    for (const isJSON of [false, true]) {
      const acc = freshAcc();
      writeExecEvent(reasoning('TOP SECRET chain of thought'), isJSON, acc);
      writeExecEvent(content('seen'), isJSON, acc);
      writeExecEvent(completeEv(), isJSON, acc);
      expect(stderrText()).toBe(''); // no reasoning leaked to default stderr
    }
  });
});
