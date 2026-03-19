import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Cross-session memory — reads CLAUDE.md and .shizuha/memory.md files
 * to provide persistent context across conversations.
 */
export async function loadMemory(cwd: string): Promise<string> {
  const files = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, '.shizuha', 'memory.md'),
  ];

  const sections: string[] = [];
  for (const file of files) {
    try {
      const content = await fs.readFile(file, 'utf-8');
      if (content.trim()) {
        sections.push(`# Memory: ${path.basename(file)}\n\n${content.trim()}`);
      }
    } catch {
      // File doesn't exist, skip
    }
  }

  return sections.join('\n\n---\n\n');
}

/** Save memory content to .shizuha/memory.md */
export async function saveMemory(cwd: string, content: string): Promise<void> {
  const dir = path.join(cwd, '.shizuha');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'memory.md'), content, 'utf-8');
  logger.debug('Memory saved');
}
