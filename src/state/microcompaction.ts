/**
 * Microcompaction — truncate oversized tool results inline to prevent context bloat.
 *
 * When a tool result exceeds a token threshold, replace it with a truncated preview
 * (first + last N chars) and save the full content to disk for reference.
 * This defers full compaction while keeping useful context in the conversation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Message, ContentBlock, ToolResultContent } from '../agent/types.js';
import { countTokens } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

/** Token threshold above which a tool result gets microcompacted (Claude Code: 40000) */
const MICROCOMPACT_THRESHOLD = 40000;

/** Minimum total token savings to trigger microcompaction (Claude Code: 20000) */
const MICROCOMPACT_MIN_SAVINGS = 20000;

/** Keep the last N tool results uncompacted regardless of size (Claude Code: 3) */
const KEEP_RECENT_UNCOMPACTED = 3;

/** Characters to keep from start and end of truncated content */
const PREVIEW_CHARS = 200;

/** Directory for storing full tool result content */
let spillDir: string | null = null;

function getSpillDir(): string {
  if (!spillDir) {
    spillDir = path.join(os.tmpdir(), 'shizuha-microcompact');
    fs.mkdirSync(spillDir, { recursive: true });
  }
  return spillDir;
}

/**
 * Microcompact a single message in-place if it contains oversized tool results.
 * Returns the number of blocks that were truncated.
 */
export function microcompactMessage(message: Message): number {
  if (typeof message.content === 'string') return 0;

  const blocks = message.content as ContentBlock[];
  let truncated = 0;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    if (block.type !== 'tool_result') continue;

    const tr = block as ToolResultContent;
    const tokens = countTokens(tr.content);
    if (tokens < MICROCOMPACT_THRESHOLD) continue;

    // Save full content to disk
    const spillPath = path.join(getSpillDir(), `${tr.toolUseId}.txt`);
    try {
      fs.writeFileSync(spillPath, tr.content, 'utf-8');
    } catch {
      // Non-fatal — continue with truncation even if spill fails
    }

    // Replace with preview
    const contentLen = tr.content.length;
    const head = tr.content.slice(0, PREVIEW_CHARS);
    const tail = tr.content.slice(contentLen - PREVIEW_CHARS);
    tr.content = `${head}\n\n[... truncated ${tokens} tokens — full output saved to ${spillPath} ...]\n\n${tail}`;
    truncated++;

    logger.debug({ toolUseId: tr.toolUseId, originalTokens: tokens, spillPath }, 'Microcompacted tool result');
  }

  return truncated;
}

/**
 * Apply microcompaction across all messages, keeping the last N tool results uncompacted.
 * Only compact if total savings >= MICROCOMPACT_MIN_SAVINGS,
 * and always keep the most recent KEEP_RECENT_UNCOMPACTED tool results intact.
 *
 * Called after each tool execution in the agent loop.
 */
export function microcompactLatest(messages: Message[]): void {
  if (messages.length === 0) return;

  // Collect all tool_result blocks across all messages, with their locations
  type TRRef = { msgIdx: number; blockIdx: number; tokens: number };
  const allToolResults: TRRef[] = [];

  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]!;
    if (typeof msg.content === 'string') continue;
    const blocks = msg.content as ContentBlock[];
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi]!;
      if (block.type !== 'tool_result') continue;
      const tr = block as ToolResultContent;
      // Skip already-compacted results
      if (tr.content.includes('[... truncated')) continue;
      const tokens = countTokens(tr.content);
      if (tokens >= MICROCOMPACT_THRESHOLD) {
        allToolResults.push({ msgIdx: mi, blockIdx: bi, tokens });
      }
    }
  }

  // Keep the last N uncompacted
  const toCompact = allToolResults.slice(0, Math.max(0, allToolResults.length - KEEP_RECENT_UNCOMPACTED));
  if (toCompact.length === 0) return;

  // Check minimum savings threshold
  const totalSavings = toCompact.reduce((sum, ref) => sum + ref.tokens, 0);
  if (totalSavings < MICROCOMPACT_MIN_SAVINGS) return;

  // Compact eligible tool results
  for (const ref of toCompact) {
    const msg = messages[ref.msgIdx]!;
    const blocks = msg.content as ContentBlock[];
    const block = blocks[ref.blockIdx]! as ToolResultContent;

    // Save full content to disk
    const spillPath = path.join(getSpillDir(), `${block.toolUseId}.txt`);
    try {
      fs.writeFileSync(spillPath, block.content, 'utf-8');
    } catch {
      // Non-fatal
    }

    // Replace with preview
    const contentLen = block.content.length;
    const head = block.content.slice(0, PREVIEW_CHARS);
    const tail = block.content.slice(contentLen - PREVIEW_CHARS);
    block.content = `${head}\n\n[... truncated ${ref.tokens} tokens — full output saved to ${spillPath} ...]\n\n${tail}`;

    logger.debug({ toolUseId: block.toolUseId, originalTokens: ref.tokens, spillPath }, 'Microcompacted tool result');
  }

  logger.info({ compacted: toCompact.length, tokensSaved: totalSavings }, 'Microcompaction applied');
}
