import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
  memoryTool,
  setMemoryFilePath,
  getMemoryFilePath,
} from '../../src/tools/builtin/memory.js';
import { loadAgentMemory } from '../../src/state/agent-memory.js';
import type { ToolContext } from '../../src/tools/types.js';

// ── Helpers ──

function tmpMemoryDir(): string {
  return path.join(os.tmpdir(), `shizuha-memory-test-${crypto.randomUUID()}`);
}

function ctx(): ToolContext {
  return { cwd: '/tmp', sessionId: 'test-session' };
}

const ENTRY_DELIMITER = '\n§\n';

describe('Memory Tool', () => {
  let memDir: string;
  let memFile: string;

  beforeEach(async () => {
    memDir = tmpMemoryDir();
    await fs.mkdir(memDir, { recursive: true });
    memFile = path.join(memDir, 'MEMORY.md');
    setMemoryFilePath(memFile);
  });

  afterEach(async () => {
    setMemoryFilePath(null as any); // Reset
    await fs.rm(memDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('setMemoryFilePath / getMemoryFilePath', () => {
    it('sets and gets the memory file path', () => {
      setMemoryFilePath('/some/path/MEMORY.md');
      expect(getMemoryFilePath()).toBe('/some/path/MEMORY.md');
      setMemoryFilePath(memFile); // restore for other tests
    });
  });

  describe('uninitialized state', () => {
    it('returns error when memory file path is not set', async () => {
      setMemoryFilePath(null as any);
      const result = await memoryTool.execute({ action: 'list' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('not initialized');
    });
  });

  describe('add action', () => {
    it('adds an entry to memory', async () => {
      const result = await memoryTool.execute({ action: 'add', content: 'Remember this fact' }, ctx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Added');

      // Verify it's on disk
      const raw = await fs.readFile(memFile, 'utf-8');
      expect(raw).toBe('Remember this fact');
    });

    it('adds multiple entries separated by delimiter', async () => {
      await memoryTool.execute({ action: 'add', content: 'Fact A' }, ctx());
      await memoryTool.execute({ action: 'add', content: 'Fact B' }, ctx());

      const raw = await fs.readFile(memFile, 'utf-8');
      const entries = raw.split(ENTRY_DELIMITER);
      expect(entries).toHaveLength(2);
      expect(entries[0]).toBe('Fact A');
      expect(entries[1]).toBe('Fact B');
    });

    it('trims whitespace from content', async () => {
      await memoryTool.execute({ action: 'add', content: '  trimmed entry  ' }, ctx());
      const raw = await fs.readFile(memFile, 'utf-8');
      expect(raw).toBe('trimmed entry');
    });

    it('detects duplicate entries', async () => {
      await memoryTool.execute({ action: 'add', content: 'Unique fact' }, ctx());
      const result = await memoryTool.execute({ action: 'add', content: 'Unique fact' }, ctx());
      expect(result.content).toContain('already exists');
      // Should still only have 1 entry
      const raw = await fs.readFile(memFile, 'utf-8');
      expect(raw.split(ENTRY_DELIMITER)).toHaveLength(1);
    });

    it('returns error when content is empty', async () => {
      const result = await memoryTool.execute({ action: 'add', content: '' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('required');
    });

    it('returns error when content is missing', async () => {
      const result = await memoryTool.execute({ action: 'add' }, ctx());
      expect(result.isError).toBe(true);
    });

    it('returns error when content is whitespace-only', async () => {
      const result = await memoryTool.execute({ action: 'add', content: '   ' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('required');
    });

    it('shows usage info in response', async () => {
      await memoryTool.execute({ action: 'add', content: 'Short note' }, ctx());
      // The response should include percentage and char count
      const result = await memoryTool.execute({ action: 'add', content: 'Another note' }, ctx());
      expect(result.content).toMatch(/\d+%/);
      expect(result.content).toMatch(/\/3,000 chars/);
    });
  });

  describe('3000 char limit enforcement', () => {
    it('rejects entry that would exceed the limit', async () => {
      // Fill up close to the limit
      const bigEntry = 'X'.repeat(2900);
      await memoryTool.execute({ action: 'add', content: bigEntry }, ctx());

      // Try to add another entry that would exceed
      const overflow = 'Y'.repeat(200);
      const result = await memoryTool.execute({ action: 'add', content: overflow }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Not enough space');
      expect(result.content).toContain('3000');
    });

    it('allows entry that fits within the limit', async () => {
      const entry = 'Z'.repeat(2999);
      const result = await memoryTool.execute({ action: 'add', content: entry }, ctx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Added');
    });
  });

  describe('remove action', () => {
    it('removes an entry by matching text', async () => {
      await memoryTool.execute({ action: 'add', content: 'Keep this' }, ctx());
      await memoryTool.execute({ action: 'add', content: 'Remove this' }, ctx());

      const result = await memoryTool.execute({ action: 'remove', old_text: 'Remove this' }, ctx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Removed');

      // Verify only 'Keep this' remains
      const raw = await fs.readFile(memFile, 'utf-8');
      expect(raw).toBe('Keep this');
    });

    it('removes by substring match', async () => {
      await memoryTool.execute({ action: 'add', content: 'The project uses TypeScript' }, ctx());
      await memoryTool.execute({ action: 'add', content: 'The database is PostgreSQL' }, ctx());

      const result = await memoryTool.execute({ action: 'remove', old_text: 'TypeScript' }, ctx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Removed');

      const raw = await fs.readFile(memFile, 'utf-8');
      expect(raw).toBe('The database is PostgreSQL');
    });

    it('returns error when no match is found', async () => {
      await memoryTool.execute({ action: 'add', content: 'Something' }, ctx());
      const result = await memoryTool.execute({ action: 'remove', old_text: 'nothing' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('No entry matching');
    });

    it('returns error when multiple entries match (ambiguous)', async () => {
      await memoryTool.execute({ action: 'add', content: 'Config: port=8080' }, ctx());
      await memoryTool.execute({ action: 'add', content: 'Config: host=localhost' }, ctx());

      const result = await memoryTool.execute({ action: 'remove', old_text: 'Config' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('Ambiguous');
      expect(result.content).toContain('2 entries match');
    });

    it('returns error when old_text is empty', async () => {
      const result = await memoryTool.execute({ action: 'remove', old_text: '' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('required');
    });

    it('returns error when old_text is missing', async () => {
      const result = await memoryTool.execute({ action: 'remove' }, ctx());
      expect(result.isError).toBe(true);
    });
  });

  describe('search action', () => {
    beforeEach(async () => {
      await memoryTool.execute({ action: 'add', content: 'Python is used for ML pipelines' }, ctx());
      await memoryTool.execute({ action: 'add', content: 'TypeScript is used for the frontend' }, ctx());
      await memoryTool.execute({ action: 'add', content: 'Docker Compose runs the stack' }, ctx());
    });

    it('finds entries by keyword', async () => {
      const result = await memoryTool.execute({ action: 'search', content: 'TypeScript' }, ctx());
      expect(result.isError).toBeUndefined();
      expect(result.content).toContain('Found 1');
      expect(result.content).toContain('TypeScript is used');
    });

    it('search is case-insensitive', async () => {
      const result = await memoryTool.execute({ action: 'search', content: 'python' }, ctx());
      expect(result.content).toContain('Found 1');
      expect(result.content).toContain('Python is used');
    });

    it('returns multiple matches', async () => {
      const result = await memoryTool.execute({ action: 'search', content: 'is used' }, ctx());
      expect(result.content).toContain('Found 2');
    });

    it('returns message when no matches found', async () => {
      const result = await memoryTool.execute({ action: 'search', content: 'Rust' }, ctx());
      expect(result.content).toContain('No entries matching');
    });

    it('returns error when query is empty', async () => {
      const result = await memoryTool.execute({ action: 'search', content: '' }, ctx());
      expect(result.isError).toBe(true);
      expect(result.content).toContain('required');
    });
  });

  describe('list action', () => {
    it('returns "empty" message when no entries', async () => {
      const result = await memoryTool.execute({ action: 'list' }, ctx());
      expect(result.content).toBe('Memory is empty.');
    });

    it('lists all entries with index numbers', async () => {
      await memoryTool.execute({ action: 'add', content: 'First entry' }, ctx());
      await memoryTool.execute({ action: 'add', content: 'Second entry' }, ctx());

      const result = await memoryTool.execute({ action: 'list' }, ctx());
      expect(result.content).toContain('2 entries');
      expect(result.content).toContain('1. First entry');
      expect(result.content).toContain('2. Second entry');
    });

    it('shows singular "entry" for one item', async () => {
      await memoryTool.execute({ action: 'add', content: 'Solo' }, ctx());
      const result = await memoryTool.execute({ action: 'list' }, ctx());
      expect(result.content).toContain('1 entry');
    });

    it('shows usage info', async () => {
      await memoryTool.execute({ action: 'add', content: 'Some data' }, ctx());
      const result = await memoryTool.execute({ action: 'list' }, ctx());
      expect(result.content).toMatch(/\d+%/);
    });
  });

  describe('file persistence', () => {
    it('atomic write uses tmp + rename', async () => {
      await memoryTool.execute({ action: 'add', content: 'Atomic check' }, ctx());

      // Verify the memory file exists
      const stat = await fs.stat(memFile);
      expect(stat.isFile()).toBe(true);

      // Verify no .tmp leftover
      const tmpExists = await fs.stat(memFile + '.tmp').catch(() => null);
      expect(tmpExists).toBeNull();
    });

    it('creates parent directory if it does not exist', async () => {
      const deepDir = path.join(memDir, 'deep', 'nested');
      const deepFile = path.join(deepDir, 'MEMORY.md');
      setMemoryFilePath(deepFile);

      await memoryTool.execute({ action: 'add', content: 'Deep entry' }, ctx());

      const stat = await fs.stat(deepFile);
      expect(stat.isFile()).toBe(true);
    });

    it('handles missing file on read (returns empty)', async () => {
      // memFile doesn't exist yet — list should be empty
      const result = await memoryTool.execute({ action: 'list' }, ctx());
      expect(result.content).toBe('Memory is empty.');
    });
  });
});

// ── loadAgentMemory ──

describe('loadAgentMemory', () => {
  let memDir: string;
  let memFile: string;

  beforeEach(async () => {
    memDir = tmpMemoryDir();
    await fs.mkdir(memDir, { recursive: true });
    memFile = path.join(memDir, 'MEMORY.md');
  });

  afterEach(async () => {
    await fs.rm(memDir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns empty string for missing file', async () => {
    const result = await loadAgentMemory('/nonexistent/path/MEMORY.md');
    expect(result).toBe('');
  });

  it('returns empty string for empty file', async () => {
    await fs.writeFile(memFile, '', 'utf-8');
    const result = await loadAgentMemory(memFile);
    expect(result).toBe('');
  });

  it('returns empty string for whitespace-only file', async () => {
    await fs.writeFile(memFile, '   \n  \n  ', 'utf-8');
    const result = await loadAgentMemory(memFile);
    expect(result).toBe('');
  });

  it('formats single entry for system prompt', async () => {
    await fs.writeFile(memFile, 'Remember this fact', 'utf-8');
    const result = await loadAgentMemory(memFile);
    expect(result).toContain('# Agent Memory');
    expect(result).toContain('1. Remember this fact');
  });

  it('formats multiple entries with numbered list', async () => {
    const content = ['Fact A', 'Fact B', 'Fact C'].join(ENTRY_DELIMITER);
    await fs.writeFile(memFile, content, 'utf-8');
    const result = await loadAgentMemory(memFile);
    expect(result).toContain('1. Fact A');
    expect(result).toContain('2. Fact B');
    expect(result).toContain('3. Fact C');
  });

  it('includes usage percentage in header', async () => {
    const content = 'Some stored data';
    await fs.writeFile(memFile, content, 'utf-8');
    const result = await loadAgentMemory(memFile);
    // Percentage is based on raw file length vs 3000 char limit
    const expectedPct = Math.round((content.length / 3000) * 100);
    expect(result).toContain(`${expectedPct}%`);
    expect(result).toContain(`${content.length}/3000 chars`);
  });

  it('includes total char count in header', async () => {
    const entry = 'X'.repeat(500);
    await fs.writeFile(memFile, entry, 'utf-8');
    const result = await loadAgentMemory(memFile);
    expect(result).toContain('500/3000 chars');
  });

  it('skips empty entries after split', async () => {
    // Content with empty segments
    const content = `Fact A${ENTRY_DELIMITER}${ENTRY_DELIMITER}Fact B`;
    await fs.writeFile(memFile, content, 'utf-8');
    const result = await loadAgentMemory(memFile);
    expect(result).toContain('1. Fact A');
    expect(result).toContain('2. Fact B');
    // Should not have a "3." since the empty segment is filtered
    expect(result).not.toContain('3.');
  });
});
