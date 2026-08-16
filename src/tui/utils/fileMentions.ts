import * as fs from 'node:fs';
import * as path from 'node:path';

/** Per-file cap for TUI @mention inlining (chars). Oversize files are truncated. */
export function maxInlineFileChars(): number {
  const raw = parseInt(process.env['SHIZUHA_TUI_MAX_INLINE_FILE_CHARS'] || '120000', 10);
  return Number.isFinite(raw) && raw > 1024 ? raw : 120_000;
}

/** Total cap across all @mentions in one prompt (chars). */
export function maxTotalInlineFileChars(): number {
  const raw = parseInt(process.env['SHIZUHA_TUI_MAX_TOTAL_INLINE_CHARS'] || '200000', 10);
  return Number.isFinite(raw) && raw > 2048 ? raw : 200_000;
}

export interface InlineFileLoad {
  path: string;
  /** Content wrapped for the model (may be truncated). */
  block: string;
  originalChars: number;
  truncated: boolean;
  skipped: boolean;
  reason?: string;
}

/**
 * Load a file for @mention inlining with hard size bounds (SCLI-389).
 * Unbounded full-file inlining of multi-MB attachments forces pre-turn
 * compaction into a multi-minute "reading conversation" prefill with no
 * recovery path.
 */
export function loadInlineFileForMention(resolvedPath: string, remainingBudget: number): InlineFileLoad {
  const maxPerFile = maxInlineFileChars();
  try {
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      return {
        path: resolvedPath,
        block: '',
        originalChars: 0,
        truncated: false,
        skipped: true,
        reason: 'not a regular file',
      };
    }
    // Refuse pathological binaries / multi-MB blobs before reading into memory.
    const hardByteCap = Math.max(maxPerFile * 4, 512_000);
    if (stat.size > hardByteCap) {
      const notice =
        `<file path="${resolvedPath}">\n`
        + `[SCLI-389] File is ${stat.size} bytes — too large to inline via @mention `
        + `(limit ${hardByteCap} bytes). Use the read tool on a path/range instead.\n`
        + `</file>`;
      return {
        path: resolvedPath,
        block: notice,
        originalChars: stat.size,
        truncated: true,
        skipped: false,
        reason: 'file exceeds hard byte cap',
      };
    }

    let content = fs.readFileSync(resolvedPath, 'utf-8');
    const originalChars = content.length;
    const budget = Math.max(0, Math.min(maxPerFile, remainingBudget));
    if (budget <= 0) {
      const notice =
        `<file path="${resolvedPath}">\n`
        + `[SCLI-389] Skipped — total @mention budget exhausted. `
        + `Use the read tool for this file.\n`
        + `</file>`;
      return {
        path: resolvedPath,
        block: notice,
        originalChars,
        truncated: true,
        skipped: true,
        reason: 'total inline budget exhausted',
      };
    }

    let truncated = false;
    if (content.length > budget) {
      truncated = true;
      const headLen = Math.floor(budget * 0.65);
      const tailLen = Math.max(0, budget - headLen - 200);
      const head = content.slice(0, headLen);
      const tail = tailLen > 0 ? content.slice(-tailLen) : '';
      const omitted = content.length - head.length - tail.length;
      content =
        `${head}\n\n`
        + `...[truncated ${omitted} of ${originalChars} chars; @mention inline cap `
        + `${budget} chars — use the read tool for the full file]...\n\n`
        + tail;
    }

    return {
      path: resolvedPath,
      block: `<file path="${resolvedPath}">\n${content}\n</file>`,
      originalChars,
      truncated,
      skipped: false,
    };
  } catch (err) {
    return {
      path: resolvedPath,
      block: '',
      originalChars: 0,
      truncated: false,
      skipped: true,
      reason: (err as Error).message,
    };
  }
}

/** Extract @file mentions from text and return resolved file paths */
export function extractFileMentions(text: string, cwd: string): string[] {
  const mentions: string[] = [];
  // Match @path patterns (alphanumeric, dots, slashes, hyphens, underscores)
  const regex = /@([\w.\/\-]+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1]!;
    const resolved = path.resolve(cwd, filePath);
    try {
      fs.accessSync(resolved, fs.constants.R_OK);
      mentions.push(resolved);
    } catch {
      // Not a valid file path — ignore
    }
  }
  return [...new Set(mentions)];
}

/** Get file suggestions for a partial path */
export function getFileSuggestions(partial: string, cwd: string, limit = 10): string[] {
  const dir = path.dirname(path.resolve(cwd, partial));
  const base = path.basename(partial).toLowerCase();
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.name.toLowerCase().startsWith(base))
      .slice(0, limit)
      .map((e) => {
        const rel = path.relative(cwd, path.join(dir, e.name));
        return e.isDirectory() ? rel + '/' : rel;
      });
  } catch {
    return [];
  }
}
