import { describe, expect, it } from 'vitest';

import { assembleWireChatMessages, messagesToChat } from '../../src/agent/turn.js';
import type { Message } from '../../src/agent/types.js';

// Operator 2026-08-08: "mathematically provable same re-serialization — as if
// the restart/resume never happened". The mechanism is IDENTITY, not
// re-derivation: payload_{n+1} = stored_payload_n ++ convert(new_tail). These
// contracts assert byte-identity of the prefix region.

const internal = (n: number): Message[] =>
  Array.from({ length: n }, (_, i) => ({
    role: (i % 2 === 0 ? 'user' : 'assistant') as Message['role'],
    content: i % 3 === 0
      ? [{ type: 'text' as const, text: `structured-${i}` }]
      : `plain-${i}`,
    timestamp: 1_000 + i,
  }));

describe('wire-prefix payload assembly (provable resume identity)', () => {
  it('prefix region is the stored payload BYTE-FOR-BYTE, tail is converted fresh', () => {
    const messages = internal(6);
    const sent = messagesToChat(messages.slice(0, 4));
    const stored = JSON.parse(JSON.stringify(sent)); // simulate DB round-trip

    const { chatMessages, usedWirePrefix } = assembleWireChatMessages(
      messages, { sourceCount: 4, messages: stored },
    );
    expect(usedWirePrefix).toBe(true);
    expect(JSON.stringify(chatMessages.slice(0, stored.length)))
      .toBe(JSON.stringify(stored));
    expect(JSON.stringify(chatMessages.slice(stored.length)))
      .toBe(JSON.stringify(messagesToChat(messages.slice(4))));
  });

  it('THE RESTART PROOF: a lossy internal round-trip cannot change the sent prefix', () => {
    // Old process: internal messages with structured content; payload sent.
    const preRestart = internal(5);
    const sentPayload = messagesToChat(preRestart);

    // Restart: the DB round-trip DAMAGES internal form (structured content
    // collapsed to strings — the exact class that produced nami's 1.1% and
    // hiro's mismatch-at-207). Re-deriving from this diverges...
    const damaged: Message[] = preRestart.map((m) => ({
      ...m,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
    expect(JSON.stringify(messagesToChat(damaged)))
      .not.toBe(JSON.stringify(sentPayload));

    // ...but the wire prefix replays the SENT bytes verbatim regardless.
    const { chatMessages, usedWirePrefix } = assembleWireChatMessages(
      damaged, { sourceCount: 5, messages: JSON.parse(JSON.stringify(sentPayload)) },
    );
    expect(usedWirePrefix).toBe(true);
    expect(JSON.stringify(chatMessages.slice(0, sentPayload.length)))
      .toBe(JSON.stringify(sentPayload));
  });

  it('append-only recurrence: capture of payload_n feeds payload_{n+1} as an exact extension', () => {
    const messages = internal(4);
    const first = assembleWireChatMessages(messages, undefined);
    // capture(first.chatMessages, 4); two new internal messages arrive:
    messages.push(
      { role: 'assistant', content: 'reply', timestamp: 2_000 },
      { role: 'user', content: 'next', timestamp: 2_001 },
    );
    const second = assembleWireChatMessages(
      messages, { sourceCount: 4, messages: first.chatMessages },
    );
    expect(second.usedWirePrefix).toBe(true);
    // payload_{n+1} starts with payload_n byte-for-byte — append-only forever.
    expect(JSON.stringify(second.chatMessages.slice(0, first.chatMessages.length)))
      .toBe(JSON.stringify(first.chatMessages));
  });

  it('falls back to full conversion when the prefix is absent or stale', () => {
    const messages = internal(3);
    expect(assembleWireChatMessages(messages, undefined).usedWirePrefix).toBe(false);
    expect(assembleWireChatMessages(
      messages, { sourceCount: 9, messages: messagesToChat(messages) },
    ).usedWirePrefix).toBe(false);
    expect(assembleWireChatMessages(
      messages, { sourceCount: 0, messages: [] },
    ).usedWirePrefix).toBe(false);
  });

  it('overflow safety valve drops the prefix instead of blowing the window', () => {
    const messages = internal(4);
    const huge = messagesToChat(messages.slice(0, 2)).map((m) => ({
      ...m, content: 'x'.repeat(500_000),
    }));
    const { usedWirePrefix } = assembleWireChatMessages(
      messages, { sourceCount: 2, messages: huge }, 1_000,
    );
    expect(usedWirePrefix).toBe(false);
  });
});
