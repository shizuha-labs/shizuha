import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computePrefixFingerprint, comparePrefixFingerprints, stableJson, PrefixFingerprintTracker } from '../src/telemetry/prefix-fingerprint.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { BenchPrefixDebugTracker, shouldEmitBenchPrefixDebug } from '../benchmark/prefix-debug.js';

function tool(name: string) {
  return { name, description: `${name} desc`, parameters: z.object({ q: z.string().optional() }), execute: async () => ({ content: 'ok' }) };
}

describe('prefix fingerprint stability', () => {
  it('stableJson sorts object keys recursively', () => {
    expect(stableJson({ b: 1, a: { z: 2, y: 3 } })).toBe(stableJson({ a: { y: 3, z: 2 }, b: 1 }));
  });

  it('ToolRegistry definitions are deterministic by tool name despite insertion order', () => {
    const a = new ToolRegistry();
    a.register(tool('zeta'));
    a.register(tool('alpha'));
    const b = new ToolRegistry();
    b.register(tool('alpha'));
    b.register(tool('zeta'));
    expect(a.definitions().map((d) => d.name)).toEqual(['alpha', 'zeta']);
    expect(a.definitions()).toEqual(b.definitions());
  });

  it('prefix hash is stable for same prompt and tools', () => {
    const registry = new ToolRegistry();
    registry.register(tool('read'));
    registry.register(tool('write'));
    const one = computePrefixFingerprint({ systemPrompt: 'stable system', tools: registry.definitions(), model: 'm' });
    const two = computePrefixFingerprint({ systemPrompt: 'stable system', tools: registry.definitions(), model: 'm' });
    expect(two.hash).toBe(one.hash);
    expect(comparePrefixFingerprints(one, two)).toMatchObject({ changed: false });
  });

  it('detects tool schema and system prompt changes separately', () => {
    const base = computePrefixFingerprint({ systemPrompt: 'stable system', tools: [tool('read') as any] });
    const promptChanged = computePrefixFingerprint({ systemPrompt: 'changed system', tools: [tool('read') as any] });
    const toolChanged = computePrefixFingerprint({ systemPrompt: 'stable system', tools: [tool('read') as any, tool('write') as any] });
    expect(comparePrefixFingerprints(base, promptChanged)).toMatchObject({ changed: true, systemPromptChanged: true, toolSchemaChanged: false });
    expect(comparePrefixFingerprints(base, toolChanged)).toMatchObject({ changed: true, systemPromptChanged: false, toolSchemaChanged: true, addedTools: ['write'] });
  });

  it('tracker compares consecutive bench/SCLI cells by key', () => {
    const tracker = new PrefixFingerprintTracker();
    const fp = computePrefixFingerprint({ systemPrompt: 'bench prefix', tools: [] });
    expect(tracker.observe('cell-a', fp)).toMatchObject({ changed: false, reason: 'first-observation' });
    expect(tracker.observe('cell-a', fp)).toMatchObject({ changed: false });
  });

  it('benchmark prefix debug emits comparable cell fingerprints', () => {
    const tracker = new BenchPrefixDebugTracker();
    const first = tracker.observe({
      runId: 'run-1',
      agentName: 'scli',
      taskId: 'bench-cell',
      cellId: 'cell-1',
      systemPrompt: 'bench prefix',
      tools: [tool('read') as any],
      model: 'GLM-4.7',
      profile: 'cortex',
    });
    const second = tracker.observe({
      runId: 'run-1',
      agentName: 'scli',
      taskId: 'bench-cell',
      cellId: 'cell-2',
      systemPrompt: 'bench prefix',
      tools: [tool('read') as any],
      model: 'GLM-4.7',
      profile: 'cortex',
    });

    expect(first).toMatchObject({ event: 'bench_prefix_fingerprint', changed: false, reason: 'first-observation' });
    expect(second).toMatchObject({ event: 'bench_prefix_fingerprint', changed: false, previousHash: first.prefixHash });
    expect(shouldEmitBenchPrefixDebug({ SHIZUHA_BENCH_DEBUG_PREFIX: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });
});
