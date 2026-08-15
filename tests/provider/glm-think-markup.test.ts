import { describe, expect, it } from 'vitest';
import {
  splitThinkMarkup,
  extractGlmToolCalls,
  consumeThinkStreamDelta,
} from '../../src/provider/vllm.js';

describe('splitThinkMarkup', () => {
  it('extracts well-formed think blocks', () => {
    const r = splitThinkMarkup('<think>plan</think>answer');
    expect(r.reasoning).toBe('plan');
    expect(r.content).toBe('answer');
  });

  it('handles orphan close prefix (GLM non-stream tool turns)', () => {
    const r = splitThinkMarkup('The user wants a bash command.</think>\n\nglm-tool-ok');
    expect(r.reasoning).toContain('bash command');
    expect(r.content).toBe('glm-tool-ok');
  });

  it('strips bare close-only tags', () => {
    const r = splitThinkMarkup('</think>glm-tool-ok');
    expect(r.content).toBe('glm-tool-ok');
    expect(r.reasoning).toBe('');
  });

  it('strips the exact TUI leak shape </think>pong', () => {
    const r = splitThinkMarkup('</think>pong');
    expect(r.content).toBe('pong');
    expect(r.reasoning).toBe('');
  });

  it('does not drop normal text', () => {
    expect(splitThinkMarkup('hello world')).toEqual({ reasoning: '', content: 'hello world' });
  });
});

describe('consumeThinkStreamDelta', () => {
  it('strips orphan </think> prefix mid-stream (GLM stream leak)', () => {
    const r = consumeThinkStreamDelta('</think>pong', false);
    expect(r.text.join('')).toBe('pong');
    expect(r.reasoning.join('')).toBe('');
    expect(r.inThinkBlock).toBe(false);
  });

  it('handles well-formed think across one delta', () => {
    const r = consumeThinkStreamDelta('<think>plan</think>answer', false);
    expect(r.reasoning.join('')).toBe('plan');
    expect(r.text.join('')).toBe('answer');
  });

  it('holds partial close tag across chunks', () => {
    const a = consumeThinkStreamDelta('</thi', false);
    expect(a.carry).toBe('</thi');
    expect(a.text.join('')).toBe('');
    const b = consumeThinkStreamDelta('nk>pong', false, a.carry);
    expect(b.text.join('')).toBe('pong');
    expect(b.carry).toBe('');
  });
});

describe('extractGlmToolCalls + think', () => {
  it('still recovers tool_call markup after think strip order is independent', () => {
    const raw = '<think>x</think><tool_call>bash<arg_key>command</arg_key><arg_value>echo hi</arg_value></tool_call>';
    const { clean, calls } = extractGlmToolCalls(raw);
    const split = splitThinkMarkup(clean);
    expect(calls[0]?.name).toBe('bash');
    expect(split.content).not.toContain('tool_call');
  });
});
