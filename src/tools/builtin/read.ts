import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolHandler, ToolContext, ToolResult, ImageData } from '../types.js';
import { readFileSafe, resolveSafePath } from '../../utils/fs.js';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const EXT_TO_MEDIA_TYPE: Record<string, ImageData['mediaType']> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20 MB

export const readTool: ToolHandler = {
  name: 'read',
  description:
    'Read a file from the filesystem. Returns file contents with line numbers. ' +
    'For image files (PNG, JPG, GIF, WebP), returns the image for visual analysis. ' +
    'Can optionally read a specific range of lines using offset and limit.',
  parameters: z.object({
    file_path: z.string().describe('Absolute or relative path to the file to read'),
    offset: z.number().int().min(0).optional().describe('Line number to start reading from (0-indexed)'),
    limit: z.number().int().min(1).optional().describe('Maximum number of lines to read'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { file_path, offset, limit } = this.parameters.parse(params);
    const resolved = resolveSafePath(file_path, context.cwd);

    try {
      // Check if image file
      const ext = path.extname(resolved).toLowerCase().slice(1);
      if (IMAGE_EXTENSIONS.has(ext)) {
        const stat = await fs.stat(resolved);
        if (stat.size > MAX_IMAGE_SIZE) {
          return { toolUseId: '', content: `Image too large: ${stat.size} bytes (max ${MAX_IMAGE_SIZE})`, isError: true };
        }
        const buffer = await fs.readFile(resolved);
        const base64 = buffer.toString('base64');
        const mediaType = EXT_TO_MEDIA_TYPE[ext] ?? 'image/png';
        return {
          toolUseId: '',
          content: `[Image: ${path.basename(resolved)} (${stat.size} bytes, ${mediaType})]`,
          image: { base64, mediaType },
        };
      }

      const { content, totalLines } = await readFileSafe(resolved, { offset, limit });
      const header = `File: ${resolved} (${totalLines} lines)`;
      return { toolUseId: '', content: `${header}\n${content}` };
    } catch (err) {
      return { toolUseId: '', content: `Error reading file: ${(err as Error).message}`, isError: true };
    }
  },
};
