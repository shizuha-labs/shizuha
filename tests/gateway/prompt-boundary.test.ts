import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HttpChannel } from '../../src/gateway/channels/http.js';
import type { Inbox, InboundMessage } from '../../src/gateway/types.js';
import { isValidPrompt } from '../../src/utils/prompt-validation.js';

/**
 * SCLI-413 consumer-boundary regression: /v1/query/stream must reject blank /
 * non-string `prompt` with HTTP 400 BEFORE any session/inbox/provider work,
 * while preserving the valid-string SSE contract.
 */

// Pick an ephemeral port.
const PORT = 18713 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

class RecordingInbox implements Inbox {
  pushed: InboundMessage[] = [];
  readonly depth = 0;
  readonly busy = false;
  push(msg: InboundMessage): void {
    this.pushed.push(msg);
  }
  async next(): Promise<InboundMessage> {
    throw new Error('not used in this harness');
  }
}

let channel: HttpChannel | null = null;
let inbox: RecordingInbox | null = null;

async function postQueryStream(body: unknown, timeoutMs = 8000): Promise<{ status: number; bodyText: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/v1/query/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: controller.signal,
    });
    const bodyText = await res.text();
    return { status: res.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

describe('isValidPrompt', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty string', ''],
    ['whitespace-only', '   \t'],
    ['newline-only', '\n\n'],
    ['number', 123],
    ['zero', 0],
    ['boolean true', true],
    ['boolean false', false],
    ['object', {}],
    ['array', ['hello']],
  ])('rejects %s', (_label, value) => {
    expect(isValidPrompt(value)).toBe(false);
  });

  it.each([
    ['normal', 'hello world'],
    ['trimmed edges', '  hello  '],
    ['multiline', 'line1\nline2'],
    ['unicode', 'नमस्ते'],
  ])('accepts %s', (_label, value) => {
    expect(isValidPrompt(value)).toBe(true);
  });
});

describe('HttpChannel /v1/query/stream prompt boundary', () => {
  beforeAll(async () => {
    inbox = new RecordingInbox();
    channel = new HttpChannel({ port: PORT, host: '127.0.0.1' });
    await channel.start(inbox);
  });

  afterEach(() => {
    inbox!.pushed = [];
  });

  afterAll(async () => {
    await channel?.stop();
  });

  it.each([
    ['missing field', '{}', '{}'],
    ['empty prompt', '{"prompt":""}', '{"prompt":""}'],
    ['whitespace-only', '{"prompt":"   \\t"}', '{"prompt":"   \\t"}'],
    ['newline-only', '{"prompt":"\\n"}', '{"prompt":"\\n"}'],
    ['number', '{"prompt":123}', '{"prompt":123}'],
    ['boolean', '{"prompt":true}', '{"prompt":true}'],
    ['object', '{"prompt":{}}', '{"prompt":{}}'],
    ['array', '{"prompt":["x"]}', '{"prompt":["x"]}'],
    ['null prompt', '{"prompt":null}', '{"prompt":null}'],
  ])('rejects %s with HTTP 400 and no inbox message', async (_label, _rawLabel, raw) => {
    const { status, bodyText } = await postQueryStream(raw);
    expect(status).toBe(400);
    expect(bodyText.toLowerCase()).toContain('prompt');
    // Must not have crossed the inbox / agent boundary.
    expect(inbox!.pushed.length).toBe(0);
  });

  it('rejects malformed JSON with HTTP 400', async () => {
    const { status } = await postQueryStream('{not json', 4000);
    expect(status).toBe(400);
    expect(inbox!.pushed.length).toBe(0);
  });

  it('accepts a valid non-empty string prompt and pushes it to the inbox (positive control)', async () => {
    // The valid request is the one that legitimately crosses the boundary.
    // The SSE body stays open (the stub inbox never completes the turn), so we
    // observe the boundary effect (inbox push) rather than a terminal body.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      await fetch(`${BASE}/v1/query/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"prompt":"hello"}',
        signal: controller.signal,
      });
    } catch {
      // Abort expected — the streaming turn never completes in this harness.
    } finally {
      clearTimeout(timer);
    }
    expect(inbox!.pushed.length).toBe(1);
    expect(inbox!.pushed[0]!.content).toBe('hello');
  });
});
