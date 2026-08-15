/**
 * Mock LLM Provider for testing the agent loop, turn execution, and compaction.
 *
 * Implements the LLMProvider interface with scripted responses.
 * Use ResponseBuilder to construct StreamChunk sequences, then queue them
 * on MockProvider before calling the function under test.
 */

import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk } from '../../src/provider/types.js';

// ── Response Builders ──

export const ResponseBuilder = {
  /** Text-only response (no tool calls) */
  textOnly(text: string, tokens?: { input: number; output: number }): StreamChunk[] {
    return [
      { type: 'text', text },
      { type: 'usage', inputTokens: tokens?.input ?? 100, outputTokens: tokens?.output ?? 50 },
      { type: 'stop_reason', reason: 'end_turn' },
      { type: 'done' },
    ];
  },

  /** Response with tool calls */
  withToolCalls(
    text: string,
    toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
    tokens?: { input: number; output: number },
  ): StreamChunk[] {
    const chunks: StreamChunk[] = [];
    if (text) chunks.push({ type: 'text', text });
    for (const tc of toolCalls) {
      chunks.push({ type: 'tool_use_start', id: tc.id, name: tc.name });
      chunks.push({ type: 'tool_use_delta', id: tc.id, input: JSON.stringify(tc.input) });
      chunks.push({ type: 'tool_use_end', id: tc.id, input: tc.input });
    }
    chunks.push({ type: 'usage', inputTokens: tokens?.input ?? 200, outputTokens: tokens?.output ?? 100 });
    chunks.push({ type: 'done' });
    return chunks;
  },

  /** Truncated response (max_tokens stop reason) */
  truncated(text: string, tokens?: { input: number; output: number }): StreamChunk[] {
    return [
      { type: 'text', text },
      { type: 'usage', inputTokens: tokens?.input ?? 100, outputTokens: tokens?.output ?? 16384 },
      { type: 'stop_reason', reason: 'max_tokens' },
      { type: 'done' },
    ];
  },

  /** Empty response (no text, no tools) */
  empty(): StreamChunk[] {
    return [
      { type: 'usage', inputTokens: 10, outputTokens: 0 },
      { type: 'stop_reason', reason: 'end_turn' },
      { type: 'done' },
    ];
  },
};

// ── Mock Provider ──

export class MockProvider implements LLMProvider {
  name = 'mock';
  supportsTools = true;
  maxContextWindow = 200000;

  private responses: StreamChunk[][] = [];
  private callIndex = 0;

  /** Messages sent to each chat() call, in order */
  public capturedMessages: ChatMessage[][] = [];
  /** Options sent to each chat() call, in order */
  public capturedOptions: ChatOptions[] = [];

  /** Queue one or more response sequences. Each array represents one chat() call. */
  queueResponse(...responses: StreamChunk[][]): void {
    this.responses.push(...responses);
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    this.capturedMessages.push([...messages]);
    this.capturedOptions.push({ ...options });

    const response = this.responses[this.callIndex++];
    if (!response) {
      throw new Error(`MockProvider: no response queued for call #${this.callIndex - 1}`);
    }
    for (const chunk of response) {
      yield chunk;
    }
  }

  // ── Assertion Helpers ──

  /** Assert exactly N chat() calls were made */
  assertCallCount(n: number): void {
    if (this.callIndex !== n) {
      throw new Error(`Expected ${n} calls, got ${this.callIndex}`);
    }
  }

  /** Assert the last prompt (all messages concatenated) contains text */
  assertLastPromptContains(text: string): void {
    const last = this.capturedMessages[this.capturedMessages.length - 1];
    if (!last) throw new Error('No calls captured');
    const joined = last.map((m) => {
      if (typeof m.content === 'string') return m.content;
      return JSON.stringify(m.content);
    }).join('\n');
    if (!joined.includes(text)) {
      throw new Error(`Last prompt does not contain "${text}". Got:\n${joined.slice(0, 500)}`);
    }
  }

  /** Get the number of chat() calls made so far */
  get callCount(): number {
    return this.callIndex;
  }

  /** Reset all state */
  reset(): void {
    this.responses = [];
    this.callIndex = 0;
    this.capturedMessages = [];
    this.capturedOptions = [];
  }
}
