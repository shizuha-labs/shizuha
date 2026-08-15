/**
 * Every queued message must reach the agent at the NEXT turn — not one per turn.
 *
 * Operator 2026-08-05, watching the TUI show "+2 more queued" survive turn after
 * turn while the agent kept working:
 *
 *     this is really bad .. is it that the harness is queueing messages until
 *     the next turn but skipping a lot of turns? .. ideally it should send all
 *     queued messages at the next turn at once
 *
 * `drainQueuedInput` used `.shift()`, so N queued messages needed N turn
 * boundaries. Any turn that ended through a path which did not drain left the
 * remainder sitting there indefinitely — the operator queued OTPs that the agent
 * never saw, while it went on hypothesising about the wrong thing.
 *
 * A queued message also carried `images`, and the drain built a text-only
 * message from `prompt` alone, so a queued screenshot silently became nothing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { StateStore } from '../../src/state/store.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-queue-'));
});
afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best effort */ }
});

/**
 * Drive the REAL `AgentSession.drainQueuedInput`.
 *
 * An earlier version of this file re-implemented the drain here. That is the
 * trap this repo has already been bitten by: a test that mirrors the code
 * passes happily while the shipped code drifts, and a guard written against the
 * implementation defends the bug instead of catching it. Build the object on
 * the real prototype and call the real (private) method, so any change to
 * session.ts is what these assertions actually measure.
 */
import { AgentSession } from '../../src/tui/session.js';

function makeSession() {
  const store = new StateStore(path.join(tmpHome, 'state.db'));
  const session = store.createSession('test-model', tmpHome);
  const injected: string[] = [];

  const self = Object.create(AgentSession.prototype) as Record<string, unknown>;
  self['pendingInputQueue'] = [];
  self['messages'] = [];
  self['store'] = store;
  self['sessionId'] = session.id;
  self['_turnPromptExcerpt'] = '';
  self['promptExcerpt'] = (p: string) => p.slice(0, 40);
  self['emit'] = (_name: string, ev: { prompt: string }) => { injected.push(ev.prompt); };

  return {
    raw: self,
    injected,
    store,
    sessionId: session.id,
    get pendingInputQueue() {
      return self['pendingInputQueue'] as Array<{
        prompt: string;
        images?: Array<{ base64: string; mediaType: string }>;
      }>;
    },
    get messages() {
      return self['messages'] as Array<{ role: string; content: unknown }>;
    },
    get turnExcerpt() { return self['_turnPromptExcerpt'] as string; },
    drain(): boolean {
      return (self['drainQueuedInput'] as () => boolean).call(self);
    },
  };
}

describe('queued input drains completely at one turn boundary', () => {
  it('delivers ALL queued messages, not one per turn', () => {
    const s = makeSession();
    s.pendingInputQueue.push({ prompt: '641985 is the latest otp just now' });
    s.pendingInputQueue.push({ prompt: 'you can DM Shion about this otp' });
    s.pendingInputQueue.push({ prompt: '328754 is the newest OTP' });

    expect(s.drain()).toBe(true);

    expect(
      s.messages.map((m) => m.content),
      'all three must land in the SAME turn — the operator queued OTPs the '
        + 'agent never saw while it kept hypothesising',
    ).toEqual([
      '641985 is the latest otp just now',
      'you can DM Shion about this otp',
      '328754 is the newest OTP',
    ]);
    expect(s.pendingInputQueue, 'the queue must be empty afterwards').toHaveLength(0);
  });

  it('preserves the order they were typed', () => {
    const s = makeSession();
    for (const p of ['first', 'second', 'third', 'fourth']) s.pendingInputQueue.push({ prompt: p });
    s.drain();
    expect(s.messages.map((m) => m.content)).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('emits one input_injected event per queued message', () => {
    const s = makeSession();
    s.pendingInputQueue.push({ prompt: 'a' });
    s.pendingInputQueue.push({ prompt: 'b' });
    s.drain();
    expect(s.injected).toEqual(['a', 'b']);
  });

  it('keeps images attached to a queued message', () => {
    const s = makeSession();
    s.pendingInputQueue.push({
      prompt: 'look at this',
      images: [{ base64: 'AAAA', mediaType: 'image/png' }],
    });
    s.drain();
    const content = s.messages[0]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content), 'a queued screenshot must not become text-only').toBe(true);
    expect(content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', data: 'AAAA', media_type: 'image/png' },
    });
    expect(content[1]).toMatchObject({ type: 'text', text: 'look at this' });
  });

  it('persists every drained message to the store', () => {
    const s = makeSession();
    s.pendingInputQueue.push({ prompt: 'one' });
    s.pendingInputQueue.push({ prompt: 'two' });
    s.drain();
    const persisted = s.store.loadTranscriptMessages(s.sessionId);
    expect(
      persisted.filter((m) => m.role === 'user').length,
      'a resumed session must not lose queued turns',
    ).toBe(2);
  });

  it('returns false and does nothing on an empty queue', () => {
    const s = makeSession();
    expect(s.drain()).toBe(false);
    expect(s.messages).toHaveLength(0);
  });

  it('sets the turn excerpt from the whole batch', () => {
    const s = makeSession();
    s.pendingInputQueue.push({ prompt: 'alpha' });
    s.pendingInputQueue.push({ prompt: 'beta' });
    s.drain();
    expect(s.turnExcerpt).toContain('alpha');
  });
});
