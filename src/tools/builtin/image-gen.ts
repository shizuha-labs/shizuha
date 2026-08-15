import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const imageGenTool: ToolHandler = {
  name: 'image_generate',
  description:
    'Generate an image from a text description using DALL-E. The generated image will be sent ' +
    'to the user on their messaging platform. Use when the user asks you to create, draw, or ' +
    'generate an image or picture.',
  parameters: z.object({
    prompt: z.string().max(4000).describe('Detailed description of the image to generate'),
    size: z.enum(['1024x1024', '1024x1792', '1792x1024']).optional()
      .describe('Image size (default: 1024x1024). Use 1024x1792 for portrait, 1792x1024 for landscape'),
    quality: z.enum(['standard', 'hd']).optional()
      .describe('Image quality (default: standard)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { prompt, size, quality } = this.parameters.parse(params);

    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      return { toolUseId: '', content: 'Image generation requires OPENAI_API_KEY', isError: true };
    }

    try {
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({ apiKey });

      const response = await client.images.generate({
        model: 'dall-e-3',
        prompt,
        n: 1,
        size: size ?? '1024x1024',
        quality: quality ?? 'standard',
        response_format: 'b64_json',
      });

      const imageData = response.data?.[0];
      if (!imageData?.b64_json) {
        return { toolUseId: '', content: 'Image generation returned no data', isError: true };
      }

      const revisedPrompt = imageData.revised_prompt;

      return {
        toolUseId: '',
        content: revisedPrompt
          ? `Generated image. DALL-E revised prompt: "${revisedPrompt}"`
          : `Generated image for: "${prompt.slice(0, 100)}"`,
        image: {
          base64: imageData.b64_json,
          mediaType: 'image/png',
        },
      };
    } catch (err) {
      return { toolUseId: '', content: `Image generation failed: ${(err as Error).message}`, isError: true };
    }
  },
};
