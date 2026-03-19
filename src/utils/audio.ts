/**
 * Audio utilities — download and transcribe audio for the agent pipeline.
 *
 * Used by channels to:
 *   1. Download inbound voice messages from platform APIs (WhatsApp, Telegram)
 *   2. Transcribe audio to text via OpenAI Whisper API
 */

import { logger } from './logger.js';

export interface TranscriptionResult {
  text: string;
  durationMs?: number;
}

const MAX_AUDIO_SIZE = 25 * 1024 * 1024; // 25MB (Whisper limit)

/**
 * Download audio from a URL and return as Buffer.
 */
export async function downloadAudio(
  url: string,
  headers?: Record<string, string>,
): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(60_000), // 60s for audio
    });
    if (!res.ok) {
      logger.warn({ url: url.slice(0, 80), status: res.status }, 'Audio download failed');
      return null;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_AUDIO_SIZE) {
      logger.warn({ size: buffer.length }, 'Audio too large for transcription');
      return null;
    }
    return buffer;
  } catch (err) {
    logger.debug({ err, url: url.slice(0, 80) }, 'Audio download error');
    return null;
  }
}

/**
 * Transcribe audio buffer using OpenAI Whisper API.
 * Requires OPENAI_API_KEY in environment.
 * Returns null if transcription fails or no API key.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  options?: { fileName?: string; language?: string },
): Promise<TranscriptionResult | null> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    logger.debug('No OPENAI_API_KEY — skipping Whisper transcription');
    return null;
  }

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey });

    // Whisper needs a File-like object
    const fileName = options?.fileName ?? 'audio.ogg';
    const file = new File([audioBuffer], fileName, { type: 'audio/ogg' });

    const transcription = await client.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      ...(options?.language ? { language: options.language } : {}),
    });

    const text = transcription.text?.trim();
    if (!text) return null;

    logger.info({ chars: text.length }, 'Audio transcribed via Whisper');
    return { text };
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'Whisper transcription failed');
    return null;
  }
}
