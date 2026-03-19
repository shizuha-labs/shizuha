import { z } from 'zod';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

const ENTRY_DELIMITER = '\n§\n';
const CHAR_LIMIT = 3000;

/** Shared memory file path — set by AgentProcess or TUI session during init */
let memoryFilePath: string | null = null;

/** Called by AgentProcess / TUI session to set the memory file path */
export function setMemoryFilePath(filePath: string): void {
  memoryFilePath = filePath;
}

/** Get the current memory file path */
export function getMemoryFilePath(): string | null {
  return memoryFilePath;
}

async function readEntries(): Promise<string[]> {
  if (!memoryFilePath) return [];
  try {
    const raw = await fs.readFile(memoryFilePath, 'utf-8');
    if (!raw.trim()) return [];
    return raw.split(ENTRY_DELIMITER).filter((e) => e.trim());
  } catch {
    return []; // File doesn't exist yet
  }
}

async function writeEntries(entries: string[]): Promise<void> {
  if (!memoryFilePath) return;
  const dir = path.dirname(memoryFilePath);
  await fs.mkdir(dir, { recursive: true });
  const content = entries.join(ENTRY_DELIMITER);
  // Atomic write via tmp + rename
  const tmpPath = memoryFilePath + '.tmp';
  await fs.writeFile(tmpPath, content, 'utf-8');
  await fs.rename(tmpPath, memoryFilePath);
}

function usageInfo(entries: string[]): string {
  const totalChars = entries.join(ENTRY_DELIMITER).length;
  const pct = CHAR_LIMIT > 0 ? Math.round((totalChars / CHAR_LIMIT) * 100) : 0;
  return `${pct}% — ${totalChars.toLocaleString()}/${CHAR_LIMIT.toLocaleString()} chars`;
}

export const memoryTool: ToolHandler = {
  name: 'memory',
  description:
    'Manage persistent memory notes that survive across sessions. Use this to remember important ' +
    'facts, user preferences, project conventions, and anything worth recalling later.\n\n' +
    'Actions:\n' +
    '  add — Store a new memory entry\n' +
    '  remove — Remove an entry by matching text\n' +
    '  search — Search entries by keyword\n' +
    '  list — Show all current entries\n\n' +
    'Memory is injected into your system prompt at session start. Keep entries concise and high-value. ' +
    'Consolidate related entries when capacity is high (>80%).',
  parameters: z.object({
    action: z.enum(['add', 'remove', 'search', 'list']).describe('What to do'),
    content: z.string().optional().describe('Entry content (for add) or search query (for search)'),
    old_text: z.string().optional().describe('Text to match for removal (substring match)'),
  }),
  readOnly: false,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!memoryFilePath) {
      return { toolUseId: '', content: 'Memory system not initialized — no memory file path set.', isError: true };
    }

    const { action, content, old_text } = this.parameters.parse(params);
    const entries = await readEntries();

    switch (action) {
      case 'add': {
        if (!content?.trim()) {
          return { toolUseId: '', content: 'content is required for add action', isError: true };
        }
        const trimmed = content.trim();

        // Check for duplicates
        if (entries.some((e) => e === trimmed)) {
          return { toolUseId: '', content: `Entry already exists. [${usageInfo(entries)}]` };
        }

        // Check capacity
        const newEntries = [...entries, trimmed];
        const newTotal = newEntries.join(ENTRY_DELIMITER).length;
        if (newTotal > CHAR_LIMIT) {
          return {
            toolUseId: '',
            content:
              `Not enough space. Entry is ${trimmed.length} chars, would bring total to ${newTotal}/${CHAR_LIMIT}. ` +
              `Current usage: [${usageInfo(entries)}]. Consider removing or consolidating existing entries first.`,
            isError: true,
          };
        }

        await writeEntries(newEntries);
        return { toolUseId: '', content: `Added. [${usageInfo(newEntries)}]` };
      }

      case 'remove': {
        if (!old_text?.trim()) {
          return { toolUseId: '', content: 'old_text is required for remove action', isError: true };
        }
        const query = old_text.trim();
        const matches = entries.filter((e) => e.includes(query));

        if (matches.length === 0) {
          return { toolUseId: '', content: `No entry matching "${query}" found.`, isError: true };
        }
        if (matches.length > 1) {
          return {
            toolUseId: '',
            content:
              `Ambiguous: ${matches.length} entries match "${query}". Be more specific.\n\nMatches:\n` +
              matches.map((m, i) => `  ${i + 1}. ${m.slice(0, 80)}${m.length > 80 ? '...' : ''}`).join('\n'),
            isError: true,
          };
        }

        const newEntries = entries.filter((e) => e !== matches[0]);
        await writeEntries(newEntries);
        return { toolUseId: '', content: `Removed. [${usageInfo(newEntries)}]` };
      }

      case 'search': {
        if (!content?.trim()) {
          return { toolUseId: '', content: 'content (search query) is required', isError: true };
        }
        const queryWords = content.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 1);
        if (queryWords.length === 0) {
          return { toolUseId: '', content: 'Search query too short.' };
        }

        // Ranked search: score by word match count + position bonus
        const scored = entries.map((entry, idx) => {
          const text = entry.toLowerCase();
          let score = 0;
          for (const word of queryWords) {
            const pos = text.indexOf(word);
            if (pos >= 0) {
              score += 10 + Math.max(0, 5 - Math.floor(pos / 100));
              // Bonus for multiple occurrences (capped)
              let count = 0;
              let from = 0;
              while (count < 3) {
                const p = text.indexOf(word, from);
                if (p < 0) break;
                count++;
                from = p + word.length;
              }
              if (count > 1) score += (count - 1) * 3;
            }
          }
          return { entry, score, idx };
        }).filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 10);

        if (scored.length === 0) {
          return { toolUseId: '', content: `No entries matching "${content.trim()}".` };
        }

        return {
          toolUseId: '',
          content:
            `Found ${scored.length} matching ${scored.length === 1 ? 'entry' : 'entries'}:\n\n` +
            scored.map((s, i) => `${i + 1}. ${s.entry}`).join('\n§\n'),
        };
      }

      case 'list': {
        if (entries.length === 0) {
          return { toolUseId: '', content: 'Memory is empty.' };
        }
        return {
          toolUseId: '',
          content:
            `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} [${usageInfo(entries)}]:\n\n` +
            entries.map((e, i) => `${i + 1}. ${e}`).join('\n§\n'),
        };
      }

      default:
        return { toolUseId: '', content: `Unknown action: ${action}`, isError: true };
    }
  },
};
