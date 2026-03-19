/**
 * Text-to-Speech utility — generate audio from text via OpenAI TTS API.
 *
 * Used by the text_to_speech built-in tool and channels to send voice
 * messages on messaging platforms (Telegram, WhatsApp, etc.).
 */

import { logger } from './logger.js';

export interface TTSResult {
  audioBuffer: Buffer;
  format: 'mp3' | 'opus' | 'aac';
  durationMs?: number;
}

/**
 * Generate speech audio from text using OpenAI TTS API.
 * Requires OPENAI_API_KEY in environment.
 * Returns null if TTS fails or no API key.
 */
export async function textToSpeech(
  text: string,
  options?: { voice?: string; speed?: number },
): Promise<TTSResult | null> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    logger.debug('No OPENAI_API_KEY — skipping TTS');
    return null;
  }

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });

    const response = await client.audio.speech.create({
      model: 'tts-1',
      voice: (options?.voice ?? 'alloy') as any,
      input: text.slice(0, 4096), // OpenAI TTS limit
      response_format: 'opus', // Small file size, good for messaging
      speed: options?.speed ?? 1.0,
    });

    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    logger.info({ chars: text.length, bytes: audioBuffer.length }, 'TTS audio generated');
    return { audioBuffer, format: 'opus' };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'TTS generation failed');
    return null;
  }
}
