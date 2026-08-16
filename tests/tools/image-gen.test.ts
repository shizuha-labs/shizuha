import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ToolContext } from '../../src/tools/types.js';

// Mock the openai module
const mockGenerate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    images: {
      generate: mockGenerate,
    },
  })),
}));

const { imageGenTool } = await import('../../src/tools/builtin/image-gen.js');

const dummyContext: ToolContext = {
  cwd: '/tmp',
  sessionId: 'test-session',
};

describe('imageGenTool', () => {
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env['OPENAI_API_KEY'];
    mockGenerate.mockReset();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env['OPENAI_API_KEY'] = originalApiKey;
    } else {
      delete process.env['OPENAI_API_KEY'];
    }
  });

  describe('metadata', () => {
    it('has the correct name', () => {
      expect(imageGenTool.name).toBe('image_generate');
    });

    it('is read-only and low risk', () => {
      expect(imageGenTool.readOnly).toBe(true);
      expect(imageGenTool.riskLevel).toBe('low');
    });
  });

  describe('parameter validation', () => {
    it('requires prompt parameter', () => {
      const result = imageGenTool.parameters.safeParse({});
      expect(result.success).toBe(false);
    });

    it('accepts valid prompt', () => {
      const result = imageGenTool.parameters.safeParse({ prompt: 'A cat' });
      expect(result.success).toBe(true);
    });

    it('rejects prompt longer than 4000 chars', () => {
      const result = imageGenTool.parameters.safeParse({ prompt: 'A'.repeat(4001) });
      expect(result.success).toBe(false);
    });

    it('accepts valid size values', () => {
      for (const size of ['1024x1024', '1024x1792', '1792x1024']) {
        const result = imageGenTool.parameters.safeParse({ prompt: 'test', size });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid size values', () => {
      const result = imageGenTool.parameters.safeParse({ prompt: 'test', size: '512x512' });
      expect(result.success).toBe(false);
    });

    it('accepts valid quality values', () => {
      for (const quality of ['standard', 'hd']) {
        const result = imageGenTool.parameters.safeParse({ prompt: 'test', quality });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid quality values', () => {
      const result = imageGenTool.parameters.safeParse({ prompt: 'test', quality: 'ultra' });
      expect(result.success).toBe(false);
    });

    it('size and quality are optional', () => {
      const result = imageGenTool.parameters.safeParse({ prompt: 'test' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ prompt: 'test' });
    });
  });

  describe('execute', () => {
    it('returns error when OPENAI_API_KEY is not set', async () => {
      delete process.env['OPENAI_API_KEY'];
      const result = await imageGenTool.execute({ prompt: 'A cat' }, dummyContext);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('OPENAI_API_KEY');
      expect(mockGenerate).not.toHaveBeenCalled();
    });

    it('calls OpenAI images.generate with correct defaults', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: 'aGVsbG8=', revised_prompt: null }],
      });

      await imageGenTool.execute({ prompt: 'A beautiful sunset' }, dummyContext);
      expect(mockGenerate).toHaveBeenCalledWith({
        model: 'dall-e-3',
        prompt: 'A beautiful sunset',
        n: 1,
        size: '1024x1024',
        quality: 'standard',
        response_format: 'b64_json',
      });
    });

    it('passes custom size and quality to API', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: 'aGVsbG8=', revised_prompt: null }],
      });

      await imageGenTool.execute(
        { prompt: 'A cat', size: '1792x1024', quality: 'hd' },
        dummyContext,
      );
      expect(mockGenerate).toHaveBeenCalledWith(
        expect.objectContaining({
          size: '1792x1024',
          quality: 'hd',
        }),
      );
    });

    it('returns image data on successful generation', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: 'iVBORw0KGgo=', revised_prompt: null }],
      });

      const result = await imageGenTool.execute({ prompt: 'A cat' }, dummyContext);
      expect(result.isError).toBeUndefined();
      expect(result.image).toBeDefined();
      expect(result.image!.base64).toBe('iVBORw0KGgo=');
      expect(result.image!.mediaType).toBe('image/png');
    });

    it('includes revised prompt in response when available', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockResolvedValue({
        data: [{
          b64_json: 'aGVsbG8=',
          revised_prompt: 'A photorealistic orange tabby cat sitting on a windowsill',
        }],
      });

      const result = await imageGenTool.execute({ prompt: 'A cat' }, dummyContext);
      expect(result.content).toContain('revised prompt');
      expect(result.content).toContain('photorealistic orange tabby cat');
    });

    it('uses original prompt in response when no revised prompt', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: 'aGVsbG8=', revised_prompt: undefined }],
      });

      const result = await imageGenTool.execute({ prompt: 'A cat in space' }, dummyContext);
      expect(result.content).toContain('A cat in space');
    });

    it('truncates long prompt in fallback message to 100 chars', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      const longPrompt = 'A'.repeat(200);
      mockGenerate.mockResolvedValue({
        data: [{ b64_json: 'aGVsbG8=', revised_prompt: undefined }],
      });

      const result = await imageGenTool.execute({ prompt: longPrompt }, dummyContext);
      // The content should contain at most 100 chars of the prompt
      expect(result.content).toContain('A'.repeat(100));
      expect(result.content).not.toContain('A'.repeat(101));
    });

    it('returns error when API returns no data', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockResolvedValue({ data: [{}] });

      const result = await imageGenTool.execute({ prompt: 'A cat' }, dummyContext);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('no data');
    });

    it('returns error when API returns empty data array', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockResolvedValue({ data: [] });

      const result = await imageGenTool.execute({ prompt: 'A cat' }, dummyContext);
      expect(result.isError).toBe(true);
    });

    it('returns error on API failure', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockRejectedValue(new Error('Content policy violation'));

      const result = await imageGenTool.execute({ prompt: 'A cat' }, dummyContext);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Content policy violation');
    });

    it('returns error on network failure', async () => {
      process.env['OPENAI_API_KEY'] = 'test-key';
      mockGenerate.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await imageGenTool.execute({ prompt: 'A cat' }, dummyContext);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('ECONNREFUSED');
    });
  });
});
