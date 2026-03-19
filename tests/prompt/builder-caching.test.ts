import { describe, it, expect, vi } from 'vitest';
import { DYNAMIC_BOUNDARY_MARKER, buildSystemPrompt } from '../../src/prompt/builder.js';

// Mock all async dependencies so buildSystemPrompt runs synchronously-ish
vi.mock('../../src/state/memory.js', () => ({
  loadMemory: vi.fn().mockResolvedValue('Some memory content'),
}));
vi.mock('../../src/utils/git.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getGitBranch: vi.fn().mockResolvedValue('main'),
  getGitStatus: vi.fn().mockResolvedValue('M src/index.ts'),
}));

describe('DYNAMIC_BOUNDARY_MARKER in system prompt', () => {
  it('is a non-empty string constant', () => {
    expect(DYNAMIC_BOUNDARY_MARKER).toBe('__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__');
    expect(DYNAMIC_BOUNDARY_MARKER.length).toBeGreaterThan(0);
  });

  it('prompt contains marker between static and dynamic sections', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }],
    });

    expect(prompt).toContain(DYNAMIC_BOUNDARY_MARKER);
  });

  it('marker appears exactly once', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: {} } }],
    });

    const count = prompt.split(DYNAMIC_BOUNDARY_MARKER).length - 1;
    expect(count).toBe(1);
  });

  it('static sections (base prompt) appear before marker', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [],
    });

    const markerIdx = prompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
    if (markerIdx >= 0) {
      const before = prompt.slice(0, markerIdx);
      // Base prompt should be in static section
      expect(before).toContain('Shizuha');
    }
  });

  it('dynamic sections (git, memory, tools) appear after marker', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [{ name: 'bash', description: 'Run command', inputSchema: { type: 'object', properties: {} } }],
    });

    const markerIdx = prompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
    expect(markerIdx).toBeGreaterThan(0);
    const after = prompt.slice(markerIdx + DYNAMIC_BOUNDARY_MARKER.length);
    expect(after).toContain('Git Context');
    expect(after).toContain('Project Memory');
    expect(after).toContain('Available Tools');
  });

  it('prompt with no dynamic sections omits marker', async () => {
    // Mock git + memory to return nothing
    const gitMod = await import('../../src/utils/git.js');
    const memMod = await import('../../src/state/memory.js');
    vi.mocked(gitMod.isGitRepo).mockResolvedValueOnce(false);
    vi.mocked(memMod.loadMemory).mockResolvedValueOnce(null as any);

    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [],
    });

    // No dynamic content → no marker
    expect(prompt).not.toContain(DYNAMIC_BOUNDARY_MARKER);
  });
});
