import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as nodePath from 'node:path';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { resolveSafePath } from '../../utils/fs.js';

// ── Patch Format Types ──

interface AddFileHunk { type: 'add'; path: string; contents: string }
interface DeleteFileHunk { type: 'delete'; path: string }
interface UpdateFileChunk {
  changeContext: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}
interface UpdateFileHunk {
  type: 'update';
  path: string;
  movePath?: string;
  chunks: UpdateFileChunk[];
}
type PatchHunk = AddFileHunk | DeleteFileHunk | UpdateFileHunk;

// ── Markers ──

const BEGIN_PATCH = '*** Begin Patch';
const END_PATCH = '*** End Patch';
const ADD_FILE = '*** Add File: ';
const DELETE_FILE = '*** Delete File: ';
const UPDATE_FILE = '*** Update File: ';
const MOVE_TO = '*** Move to: ';
const EOF_MARKER = '*** End of File';
const CHANGE_CONTEXT = '@@ ';
const EMPTY_CONTEXT = '@@';

// ── Parser ──

function parsePatch(patchText: string): PatchHunk[] {
  let lines = patchText.trim().split('\n');

  // Check boundaries (lenient: strip heredoc wrapper if present)
  const firstLine = lines[0] ?? '';
  if (firstLine.trim() !== BEGIN_PATCH) {
    const first = firstLine.trim();
    const lastLine = lines[lines.length - 1] ?? '';
    if ((first === '<<EOF' || first === "<<'EOF'" || first === '<<"EOF"') &&
        lastLine.trim().endsWith('EOF') && lines.length >= 4) {
      lines = lines.slice(1, -1);
    }
    if ((lines[0] ?? '').trim() !== BEGIN_PATCH) {
      throw new Error(`Invalid patch: first line must be '${BEGIN_PATCH}'`);
    }
  }
  if ((lines[lines.length - 1] ?? '').trim() !== END_PATCH) {
    throw new Error(`Invalid patch: last line must be '${END_PATCH}'`);
  }

  // Parse hunks between markers
  const hunks: PatchHunk[] = [];
  let remaining = lines.slice(1, -1);
  let lineNumber = 2;

  while (remaining.length > 0) {
    const result = parseOneHunk(remaining, lineNumber);
    hunks.push(result[0]);
    remaining = remaining.slice(result[1]);
    lineNumber += result[1];
  }

  return hunks;
}

function parseOneHunk(lines: string[], lineNumber: number): [PatchHunk, number] {
  const firstLine = lines[0];
  if (!firstLine) {
    throw new Error(`Unexpected end of patch at line ${lineNumber}`);
  }
  const first = firstLine.trim();

  // *** Add File: <path>
  if (first.startsWith(ADD_FILE)) {
    const filePath = first.slice(ADD_FILE.length);
    let contents = '';
    let parsed = 1;
    for (const line of lines.slice(1)) {
      if (line.startsWith('+')) {
        contents += line.slice(1) + '\n';
        parsed++;
      } else {
        break;
      }
    }
    return [{ type: 'add', path: filePath, contents }, parsed];
  }

  // *** Delete File: <path>
  if (first.startsWith(DELETE_FILE)) {
    const filePath = first.slice(DELETE_FILE.length);
    return [{ type: 'delete', path: filePath }, 1];
  }

  // *** Update File: <path>
  if (first.startsWith(UPDATE_FILE)) {
    const filePath = first.slice(UPDATE_FILE.length);
    let remaining = lines.slice(1);
    let parsed = 1;

    // Optional: *** Move to: <path>
    let movePath: string | undefined;
    const moveCandidate = remaining[0];
    if (moveCandidate && moveCandidate.startsWith(MOVE_TO)) {
      movePath = moveCandidate.slice(MOVE_TO.length);
      remaining = remaining.slice(1);
      parsed++;
    }

    const chunks: UpdateFileChunk[] = [];
    while (remaining.length > 0) {
      const currentLine = remaining[0];
      if (!currentLine) break;
      // Skip blank lines between chunks
      if (currentLine.trim() === '') {
        remaining = remaining.slice(1);
        parsed++;
        continue;
      }
      // Stop at next hunk marker
      if (currentLine.startsWith('***')) break;

      const chunkResult = parseUpdateChunk(remaining, lineNumber + parsed, chunks.length === 0);
      chunks.push(chunkResult[0]);
      parsed += chunkResult[1];
      remaining = remaining.slice(chunkResult[1]);
    }

    if (chunks.length === 0) {
      throw new Error(`Update file hunk for '${filePath}' is empty (line ${lineNumber})`);
    }

    return [{ type: 'update', path: filePath, movePath, chunks }, parsed];
  }

  throw new Error(
    `Invalid hunk header at line ${lineNumber}: '${first}'. ` +
    `Expected '*** Add File:', '*** Delete File:', or '*** Update File:'`
  );
}

function parseUpdateChunk(
  lines: string[], lineNumber: number, allowMissingContext: boolean,
): [UpdateFileChunk, number] {
  const firstLine = lines[0] ?? '';

  // Parse optional @@ context
  let changeContext: string | null = null;
  let startIndex = 0;

  if (firstLine === EMPTY_CONTEXT) {
    startIndex = 1;
  } else if (firstLine.startsWith(CHANGE_CONTEXT)) {
    changeContext = firstLine.slice(CHANGE_CONTEXT.length);
    startIndex = 1;
  } else if (!allowMissingContext) {
    throw new Error(`Expected @@ context marker at line ${lineNumber}, got: '${firstLine}'`);
  }

  const chunk: UpdateFileChunk = {
    changeContext,
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };

  let parsed = 0;
  for (const line of lines.slice(startIndex)) {
    if (line === EOF_MARKER) {
      if (parsed === 0) {
        throw new Error(`Update hunk has no lines (line ${lineNumber})`);
      }
      chunk.isEndOfFile = true;
      parsed++;
      break;
    }

    const firstChar = line.charAt(0);
    if (firstChar === ' ') {
      chunk.oldLines.push(line.slice(1));
      chunk.newLines.push(line.slice(1));
    } else if (firstChar === '+') {
      chunk.newLines.push(line.slice(1));
    } else if (firstChar === '-') {
      chunk.oldLines.push(line.slice(1));
    } else if (line === '') {
      // Empty line = context
      chunk.oldLines.push('');
      chunk.newLines.push('');
    } else {
      if (parsed === 0) {
        throw new Error(
          `Unexpected line in update hunk at line ${lineNumber + startIndex}: '${line}'. ` +
          `Lines must start with ' ', '+', or '-'`
        );
      }
      // Start of next hunk
      break;
    }
    parsed++;
  }

  return [chunk, parsed + startIndex];
}

// ── Sequence Matching (4-pass: exact, rstrip, trim, unicode-normalize) ──

function normalizeUnicode(s: string): string {
  return s.trim().replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

function seekSequence(
  lines: string[], pattern: string[], start: number, eof: boolean,
): number | null {
  if (pattern.length === 0) return start;
  if (pattern.length > lines.length) return null;

  const searchStart = eof && lines.length >= pattern.length
    ? lines.length - pattern.length
    : start;

  const maxStart = lines.length - pattern.length;

  // Pass 1: exact
  for (let i = searchStart; i <= maxStart; i++) {
    if (pattern.every((p, j) => lines[i + j] === p)) return i;
  }
  // Pass 2: rstrip
  for (let i = searchStart; i <= maxStart; i++) {
    if (pattern.every((p, j) => (lines[i + j] ?? '').trimEnd() === p.trimEnd())) return i;
  }
  // Pass 3: trim both
  for (let i = searchStart; i <= maxStart; i++) {
    if (pattern.every((p, j) => (lines[i + j] ?? '').trim() === p.trim())) return i;
  }
  // Pass 4: unicode normalized
  for (let i = searchStart; i <= maxStart; i++) {
    if (pattern.every((p, j) => normalizeUnicode(lines[i + j] ?? '') === normalizeUnicode(p))) return i;
  }

  return null;
}

// ── Apply Logic ──

function computeReplacements(
  originalLines: string[], filePath: string, chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    // Find context line if present
    if (chunk.changeContext !== null) {
      const idx = seekSequence(originalLines, [chunk.changeContext], lineIndex, false);
      if (idx === null) {
        throw new Error(`Failed to find context '${chunk.changeContext}' in ${filePath}`);
      }
      lineIndex = idx + 1;
    }

    if (chunk.oldLines.length === 0) {
      // Pure addition at end of file
      const lastLine = originalLines[originalLines.length - 1];
      const insertionIdx = lastLine === '' ? originalLines.length - 1 : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.newLines]);
      continue;
    }

    // Find old_lines in file
    let pattern: string[] = chunk.oldLines;
    let newSlice: string[] = chunk.newLines;
    let found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);

    // Retry without trailing empty line
    if (found === null && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(originalLines, pattern, lineIndex, chunk.isEndOfFile);
    }

    if (found !== null) {
      replacements.push([found, pattern.length, newSlice]);
      lineIndex = found + pattern.length;
    } else {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.oldLines.join('\n')}`
      );
    }
  }

  replacements.sort((a, b) => a[0] - b[0]);
  return replacements;
}

function applyReplacements(lines: string[], replacements: Array<[number, number, string[]]>): string[] {
  const result = [...lines];
  // Apply in reverse order so indices stay valid
  for (let i = replacements.length - 1; i >= 0; i--) {
    const entry = replacements[i];
    if (!entry) continue;
    const [startIdx, oldLen, newSegment] = entry;
    result.splice(startIdx, oldLen, ...newSegment);
  }
  return result;
}

// ── Tool Definition ──

export const applyPatchTool: ToolHandler = {
  name: 'apply_patch',
  description:
    'Apply a patch to create, update, or delete files. Accepts a patch string that can modify ' +
    'multiple files in a single operation. Format:\n' +
    '*** Begin Patch\n' +
    '*** Add File: path/to/new.py\n' +
    '+line1\n+line2\n' +
    '*** Update File: path/to/existing.py\n' +
    '@@ context_line\n' +
    ' unchanged\n-old_line\n+new_line\n' +
    '*** Delete File: path/to/remove.py\n' +
    '*** End Patch\n\n' +
    'Rules: context lines start with " ", additions with "+", removals with "-". ' +
    '@@ lines narrow down the position. Paths must be relative.',
  parameters: z.object({
    patch: z.string().describe('The patch content starting with "*** Begin Patch" and ending with "*** End Patch"'),
  }),
  readOnly: false,
  riskLevel: 'medium',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { patch } = this.parameters.parse(params);

    try {
      const hunks = parsePatch(patch);
      if (hunks.length === 0) {
        return { toolUseId: '', content: 'Patch is empty — no files modified.', isError: true };
      }

      const added: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];

      for (const hunk of hunks) {
        const resolved = resolveSafePath(hunk.path, context.cwd);

        if (hunk.type === 'add') {
          await fs.mkdir(nodePath.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, hunk.contents, 'utf-8');
          added.push(hunk.path);
        } else if (hunk.type === 'delete') {
          await fs.unlink(resolved);
          deleted.push(hunk.path);
        } else {
          // Update file
          const content = await fs.readFile(resolved, 'utf-8');
          const originalLines = content.split('\n');
          // Drop trailing empty element from final newline
          if (originalLines.length > 0 && originalLines[originalLines.length - 1] === '') {
            originalLines.pop();
          }

          const replacements = computeReplacements(originalLines, hunk.path, hunk.chunks);
          const newLines = applyReplacements(originalLines, replacements);

          // Ensure trailing newline
          if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
            newLines.push('');
          }
          const newContent = newLines.join('\n');

          if (hunk.movePath) {
            const destResolved = resolveSafePath(hunk.movePath, context.cwd);
            await fs.mkdir(nodePath.dirname(destResolved), { recursive: true });
            await fs.writeFile(destResolved, newContent, 'utf-8');
            await fs.unlink(resolved);
            modified.push(hunk.movePath);
          } else {
            await fs.writeFile(resolved, newContent, 'utf-8');
            modified.push(hunk.path);
          }
        }
      }

      // Build summary
      const parts: string[] = [];
      for (const p of added) parts.push(`A ${p}`);
      for (const p of modified) parts.push(`M ${p}`);
      for (const p of deleted) parts.push(`D ${p}`);

      return {
        toolUseId: '',
        content: `Applied patch successfully:\n${parts.join('\n')}`,
        metadata: { added, modified, deleted },
      };
    } catch (err) {
      return {
        toolUseId: '',
        content: `Error applying patch: ${(err as Error).message}`,
        isError: true,
      };
    }
  },
};
