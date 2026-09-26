import { describe, expect, it } from 'vitest';
import { capVisionImagesPerPrompt, toVLlmMessages, VLLM_MAX_IMAGES_PER_PROMPT } from '../../src/provider/vllm.js';
import { getModelProfile } from '../../src/provider/model-profile.js';
import type { ChatMessage } from '../../src/provider/types.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function toolImageTurn(n = 0): ChatMessage {
  return {
    role: 'user',
    content: [{
      type: 'tool_result',
      toolUseId: n === 0 ? 'toolu_shot' : `toolu_shot_${n}`,
      content: 'Screenshot captured.',
      image: { base64: TINY_PNG, mediaType: 'image/png' },
    }],
  };
}

function pastedImageTurn(): ChatMessage {
  return {
    role: 'user',
    content: [
      {
        type: 'image',
        source: { type: 'base64', data: TINY_PNG, media_type: 'image/png' },
      },
      { type: 'text', text: 'What is in this screenshot?' },
    ],
  };
}

describe('vLLM vision wire (SCLI-63 / GLM-5.3-Flash)', () => {
  it('opts GLM-5.3-Flash into vision and keeps GLM-4.7 / GLM-5.2 text-only', () => {
    expect(getModelProfile('cortex/GLM-5.3-Flash').supportsVision).toBe(true);
    expect(getModelProfile('vllm/GLM-5.3-Flash').supportsVision).toBe(true);
    expect(getModelProfile('GLM-5.3-Flash-EXL3').supportsVision).toBe(true);
    expect(getModelProfile('vllm/GLM-5.2-QuantTrio-256K').supportsVision).toBeFalsy();
    expect(getModelProfile('vllm/GLM-4.7').supportsVision).toBeFalsy();
    expect(getModelProfile('cortex/GLM-5').supportsVision).toBeFalsy();
  });

  it('sends browser/tool screenshots as image_url for GLM-5.3-Flash', () => {
    const out = toVLlmMessages([toolImageTurn()], undefined, getModelProfile('cortex/GLM-5.3-Flash'));
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('tool');
    expect(out[0]!.tool_call_id).toBe('toolu_shot');
    const content = out[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content.some((p) => p.type === 'text' && p.text === 'Screenshot captured.')).toBe(true);
    const image = content.find((p) => p.type === 'image_url');
    expect(image?.image_url?.url).toBe(`data:image/png;base64,${TINY_PNG}`);
    expect(JSON.stringify(out)).not.toContain('Image not sent');
  });

  it('keeps the SCLI-63 placeholder for text-only GLM-4.7', () => {
    const out = toVLlmMessages([toolImageTurn()], undefined, getModelProfile('vllm/GLM-4.7'));
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('tool');
    expect(typeof out[0]!.content).toBe('string');
    expect(String(out[0]!.content)).toContain('Image not sent');
    expect(String(out[0]!.content)).toContain('text-only');
    expect(JSON.stringify(out)).not.toContain('image_url');
    expect(JSON.stringify(out)).not.toContain(TINY_PNG);
  });

  it('sends TUI-pasted user image blocks as image_url for GLM-5.3-Flash', () => {
    const out = toVLlmMessages([pastedImageTurn()], undefined, getModelProfile('cortex/GLM-5.3-Flash'));
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
    const content = out[0]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content[0]).toEqual({
      type: 'image_url',
      image_url: { url: `data:image/png;base64,${TINY_PNG}` },
    });
    expect(content[1]).toEqual({ type: 'text', text: 'What is in this screenshot?' });
  });

  it('omits pasted image bytes for a text-only profile instead of dropping the turn', () => {
    const out = toVLlmMessages([pastedImageTurn()], undefined, getModelProfile('vllm/GLM-4.7'));
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
    expect(typeof out[0]!.content).toBe('string');
    expect(String(out[0]!.content)).toContain('What is in this screenshot?');
    expect(String(out[0]!.content)).toContain('Image not sent');
    expect(JSON.stringify(out)).not.toContain(TINY_PNG);
  });

  it('keeps only the newest 4 images in one GLM prompt', () => {
    const turns = Array.from({ length: 6 }, (_, i) => toolImageTurn(i));
    const wired = toVLlmMessages(turns, undefined, getModelProfile('cortex/GLM-5.3-Flash'));
    const capped = capVisionImagesPerPrompt(wired);
    expect(VLLM_MAX_IMAGES_PER_PROMPT).toBe(4);
    expect(capped.dropped).toBe(2);
    const urls = capped.messages.flatMap((message) => {
      if (!Array.isArray(message.content)) return [];
      return message.content
        .filter((part) => part.type === 'image_url')
        .map((part) => (part as { image_url: { url: string } }).image_url.url);
    });
    expect(urls).toHaveLength(4);
    expect(urls.every((url) => url.includes(TINY_PNG))).toBe(true);
    const notes = capped.messages.flatMap((message) => {
      if (!Array.isArray(message.content)) return [];
      return message.content
        .filter((part) => part.type === 'text' && String(part.text).includes('at most 4 images'))
        .map((part) => part.text);
    });
    expect(notes).toHaveLength(2);
  });
});
