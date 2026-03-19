/**
 * Image utilities — download, compress, and convert images for the agent pipeline.
 *
 * Used by channels to:
 *   1. Download inbound images from platform APIs (WhatsApp, Telegram, Discord)
 *   2. Compress images before sending to LLMs (saves tokens)
 *   3. Convert between formats
 */

import { logger } from './logger.js';

export interface ImageData {
  base64: string;
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

const MIME_TO_MEDIA_TYPE: Record<string, ImageData['mediaType']> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

/**
 * Download an image from a URL and return as base64.
 * Returns null if download fails or image is too large.
 */
export async function downloadImage(
  url: string,
  headers?: Record<string, string>,
): Promise<ImageData | null> {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000), // 30s timeout
    });

    if (!res.ok) {
      logger.warn({ url: url.slice(0, 80), status: res.status }, 'Image download failed');
      return null;
    }

    const contentType = res.headers.get('content-type') ?? '';
    const mediaType = MIME_TO_MEDIA_TYPE[contentType.split(';')[0]!.trim()];
    if (!mediaType) {
      logger.debug({ contentType }, 'Unsupported image content type');
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_IMAGE_SIZE) {
      logger.warn({ size: buffer.length }, 'Image too large, skipping');
      return null;
    }

    return {
      base64: buffer.toString('base64'),
      mediaType,
    };
  } catch (err) {
    logger.debug({ err, url: url.slice(0, 80) }, 'Image download error');
    return null;
  }
}

/**
 * Build a multimodal content array (Anthropic-style) for a user message with an image.
 * Returns content blocks suitable for passing as Message.content.
 */
export function buildImageContent(
  text: string,
  image: ImageData,
): Array<{ type: string; [key: string]: unknown }> {
  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.base64,
      },
    },
    { type: 'text', text: text || 'What is in this image?' },
  ];
}
