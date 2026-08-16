import * as fs from 'node:fs/promises';

const ENTRY_DELIMITER = '\n§\n';
const CHAR_LIMIT = 3000;

/**
 * Load agent memory from the MEMORY.md file for system prompt injection.
 * Returns a formatted string suitable for appending to the system prompt,
 * or empty string if no memory exists.
 *
 * This is a frozen snapshot — the system prompt gets the memory state at
 * session start. The memory tool can modify the file during the session,
 * but the system prompt won't reflect those changes until next session.
 */
export async function loadAgentMemory(memoryFilePath: string): Promise<string> {
  try {
    const raw = await fs.readFile(memoryFilePath, 'utf-8');
    if (!raw.trim()) return '';

    const entries = raw.split(ENTRY_DELIMITER).filter((e) => e.trim());
    if (entries.length === 0) return '';

    const totalChars = raw.length;
    const pct = Math.round((totalChars / CHAR_LIMIT) * 100);

    return (
      `# Agent Memory [${pct}% — ${totalChars}/${CHAR_LIMIT} chars]\n\n` +
      entries.map((e, i) => `${i + 1}. ${e}`).join('\n')
    );
  } catch {
    return ''; // File doesn't exist yet
  }
}
