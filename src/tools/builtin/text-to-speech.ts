import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

export const textToSpeechTool: ToolHandler = {
  name: 'text_to_speech',
  description:
    'Convert text to speech audio. The generated audio will be sent to the user as a voice message ' +
    'on their messaging platform (Telegram, WhatsApp, etc.). Use this when the user asks you to ' +
    '"say something", "read aloud", or when a voice response would be more appropriate than text.\n\n' +
    'Available voices: alloy, echo, fable, onyx, nova, shimmer',
  parameters: z.object({
    text: z.string().max(4096).describe('The text to convert to speech (max 4096 chars)'),
    voice: z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']).optional()
      .describe('Voice to use (default: alloy)'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    const { text, voice } = this.parameters.parse(params);
    const { textToSpeech } = await import('../../utils/tts.js');

    const result = await textToSpeech(text, { voice });
    if (!result) {
      return { toolUseId: '', content: 'TTS generation failed (no API key or service error)', isError: true };
    }

    // Return the audio as base64 in the result metadata — channels will detect and send as voice
    return {
      toolUseId: '',
      content: `Generated ${result.format} audio (${result.audioBuffer.length} bytes) for: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}"`,
      metadata: {
        audio: {
          base64: result.audioBuffer.toString('base64'),
          format: result.format,
          mimeType: result.format === 'opus' ? 'audio/ogg' : `audio/${result.format}`,
        },
      },
    };
  },
};
