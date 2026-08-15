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

  it('cwd is a per-agent dynamic section — past the marker, out of the static head', async () => {
    // 2026-07-15: cwd moved OUT of BASE_SYSTEM_PROMPT into the dynamic tail so
    // the static head stays byte-identical across agents (cross-agent prefix
    // cache). Even with git + memory empty, cwd is always a dynamic section.
    const gitMod = await import('../../src/utils/git.js');
    const memMod = await import('../../src/state/memory.js');
    vi.mocked(gitMod.isGitRepo).mockResolvedValueOnce(false);
    vi.mocked(memMod.loadMemory).mockResolvedValueOnce(null as any);

    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [],
    });

    const markerIdx = prompt.indexOf(DYNAMIC_BOUNDARY_MARKER);
    expect(markerIdx).toBeGreaterThan(-1);
    // cwd is AFTER the marker (dynamic), NOT in the static head
    expect(prompt.slice(0, markerIdx)).not.toContain('/tmp/test');
    expect(prompt.slice(markerIdx)).toContain('/tmp/test');
  });

  it('uses the full project memory prompt for DeepSeek-V4-Flash', async () => {
    const memMod = await import('../../src/state/memory.js');
    const memory = 'skill catalog noise\n'.repeat(1000);
    vi.mocked(memMod.loadMemory).mockResolvedValueOnce(memory);

    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [{ name: 'bash', description: 'Run command', inputSchema: { type: 'object', properties: {} } }],
      model: 'DeepSeek-V4-Flash',
    });

    expect(prompt).toContain(DYNAMIC_BOUNDARY_MARKER);
    expect(prompt).toContain(memory.trim());
    expect(prompt).not.toContain('[Project memory truncated');
    expect(prompt).not.toContain('[Project context truncated');
    expect(prompt).not.toContain('- **bash**: Run command');
  });

  it('DeepSeek-V4-Flash uses a lean base with no tutorial few-shots', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [{ name: 'bash', description: 'Run command', inputSchema: { type: 'object', properties: {} } }],
      model: 'DeepSeek-V4-Flash',
      skillCatalog: '## Available Skills\n- wiki-lifecycle',
    });

    expect(prompt).toContain('You are Shizuha');
    expect(prompt).toContain('Prefer acting over describing');
    expect(prompt).not.toContain('Let me start working');
    expect(prompt).not.toContain('Let me first use the todo_write tool');
    expect(prompt).not.toContain('File-write discipline (critical on smaller-context models)');
    expect(prompt).not.toContain('Plan your approach, then implement it using tools');
    // Fleet/interactive still get operational tail — not a Qwen-style empty prompt.
    expect(prompt).toContain('Agent Policy');
    expect(prompt).toContain('Project Memory');
    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain(DYNAMIC_BOUNDARY_MARKER);
  });

  it('non-DeepSeek models still get the full smaller-context base', async () => {
    const prompt = await buildSystemPrompt({
      cwd: '/tmp/test',
      tools: [],
      model: 'gpt-4',
    });

    expect(prompt).toContain('File-write discipline (critical on smaller-context models)');
    expect(prompt).toContain('Plan your approach, then implement it using tools');
  });
});
