import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../../src/tui/session.js';

/**
 * Typing while the agent works must QUEUE, not interrupt (operator 2026-08-04).
 *
 * `queueInput()` used to abort the live LLM stream so the message landed
 * "ASAP". That silently truncated the agent's turn mid-answer — discarding
 * partial reasoning and any in-flight tool round — and made the input box's own
 * "press Enter to queue" affordance a lie. Esc remains the explicit interrupt.
 */
function sessionWithAbortSpy() {
  const session = new AgentSession() as unknown as {
    pendingInputQueue: Array<{ prompt: string }>;
    abortController: AbortController | null;
    queueInput: AgentSession['queueInput'];
    interrupt: AgentSession['interrupt'];
  };
  const controller = new AbortController();
  const abort = vi.spyOn(controller, 'abort');
  session.abortController = controller;
  return { session, abort };
}

describe('AgentSession input queueing', () => {
  it('queues without aborting the running turn', () => {
    const { session, abort } = sessionWithAbortSpy();
    session.queueInput('second thought');
    expect(session.pendingInputQueue).toHaveLength(1);
    expect(session.pendingInputQueue[0]!.prompt).toBe('second thought');
    expect(abort).not.toHaveBeenCalled();
  });

  it('preserves submission order across several queued messages', () => {
    const { session, abort } = sessionWithAbortSpy();
    session.queueInput('first');
    session.queueInput('second');
    session.queueInput('third');
    expect(session.pendingInputQueue.map((p) => p.prompt)).toEqual(['first', 'second', 'third']);
    expect(abort).not.toHaveBeenCalled();
  });

  it('still cuts the stream when a caller explicitly asks to interrupt', () => {
    const { session, abort } = sessionWithAbortSpy();
    session.queueInput('urgent', undefined, { interrupt: true });
    expect(abort).toHaveBeenCalledTimes(1);
    expect(session.pendingInputQueue).toHaveLength(1);
  });

  it('honours the SHIZUHA_TUI_INTERRUPT_ON_SUBMIT escape hatch', () => {
    const prior = process.env['SHIZUHA_TUI_INTERRUPT_ON_SUBMIT'];
    try {
      process.env['SHIZUHA_TUI_INTERRUPT_ON_SUBMIT'] = '1';
      const { session, abort } = sessionWithAbortSpy();
      session.queueInput('old behaviour please');
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      if (prior === undefined) delete process.env['SHIZUHA_TUI_INTERRUPT_ON_SUBMIT'];
      else process.env['SHIZUHA_TUI_INTERRUPT_ON_SUBMIT'] = prior;
    }
  });

  it('interrupt() still aborts and discards the queue', () => {
    const { session, abort } = sessionWithAbortSpy();
    session.queueInput('will be dropped');
    session.interrupt();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(session.pendingInputQueue).toHaveLength(0);
  });

  it('keeps images attached to the queued message', () => {
    const { session } = sessionWithAbortSpy();
    const images = [{ base64: 'aGk=', mediaType: 'image/png' }];
    session.queueInput('look at this', images);
    expect((session.pendingInputQueue[0] as { images?: unknown }).images).toEqual(images);
  });
});
