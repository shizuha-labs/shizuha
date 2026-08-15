import type { ToolDefinition } from '../tools/types.js';
import { computePrefixFingerprint, PrefixFingerprintTracker } from './prefix-fingerprint.js';

export interface BenchPrefixCellInput {
  runId?: string;
  agentName: string;
  taskId: string;
  cellId: string;
  systemPrompt: string;
  tools: ToolDefinition[];
  model?: string;
  profile?: string;
  mode?: string;
}

export interface BenchPrefixDebugEvent extends Record<string, unknown> {
  event: 'bench_prefix_fingerprint';
  key: string;
  cellId: string;
  prefixHash: string;
  systemPromptHash: string;
  toolSchemaHash: string;
  toolCount: number;
  systemPromptChars: number;
}

export function shouldEmitBenchPrefixDebug(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SHIZUHA_DEBUG_PREFIX'] === '1' || env['SHIZUHA_BENCH_DEBUG_PREFIX'] === '1';
}

export class BenchPrefixDebugTracker {
  private readonly tracker = new PrefixFingerprintTracker();

  observe(input: BenchPrefixCellInput): BenchPrefixDebugEvent {
    const key = [input.runId || 'bench', input.agentName, input.taskId, input.model || 'unknown-model'].join(':');
    const current = computePrefixFingerprint({
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      model: input.model,
      profile: input.profile,
      mode: input.mode ?? 'bench-cell',
    });
    const comparison = this.tracker.observe(key, current);
    return {
      event: 'bench_prefix_fingerprint',
      key,
      cellId: input.cellId,
      prefixHash: current.hash,
      systemPromptHash: current.systemPromptHash,
      toolSchemaHash: current.toolSchemaHash,
      toolCount: current.toolCount,
      systemPromptChars: current.systemPromptChars,
      ...comparison,
      current,
    };
  }
}
