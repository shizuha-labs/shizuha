import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(__dirname, '../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('SCLI context-budget guard call sites', () => {
  it('keeps the final pre-provider budget gate on non-TUI SCLI loops', () => {
    for (const path of ['src/agent/loop.ts', 'src/index.ts']) {
      const source = readRepoFile(path);
      expect(source, `${path} must use provider-backed semantic compaction at the provider boundary`)
        .toContain('compactMessagesRequired');
      expect(source, `${path} must fail closed when semantic compaction cannot restore headroom`)
        .toContain('Semantic context compaction did not restore provider-call headroom');
      expect(source, `${path} must not retain deterministic compaction code`)
        .not.toMatch(/compactMessagesExtractively|buildExtractiveFallbackSummary/);
      expect(source, `${path} must not fall through to destructive context trimming`)
        .not.toContain('fitMessagesToContextBudget');
      expect(source, `${path} must not use the old fixed 8k context guard`)
        .not.toContain('const guardTokens = 8192');
    }
  });

  it('keeps TUI overflow recovery semantic-only with the shared adaptive guard', () => {
    const source = readRepoFile('src/tui/session.ts');
    expect(source).toContain('enforceRequiredCompaction');
    expect(source).not.toContain('resetToLastUserPrompt');
    expect(source).not.toContain('trimMessagesToFitDetailed');
    expect(source).toContain('resolveContextPreflightGuardTokens');
    expect(source).toContain('resolveInteractivePreflightCeilingTokens');
    expect(source).not.toContain('const guardTokens = 8192');
    expect(source).not.toContain('const preflightCeiling = maxContextTokens - preflightOutputReserve - preflightGuardTokens;');
  });

  it('does not trim TUI history just because the responsive latency budget is exceeded', () => {
    const source = readRepoFile('src/tui/session.ts');
    const responsiveWarningIndex = source.indexOf('responsive latency budget but still preserving append-only context');
    const hardTrimIndex = source.indexOf('promptBudget.promptTokenEstimate > contextWindowCeiling');

    expect(responsiveWarningIndex).toBeGreaterThan(0);
    expect(hardTrimIndex).toBeGreaterThan(0);
    expect(source).toContain('promptBudget.promptTokenEstimate > preflightCeiling');
    expect(source).toContain('promptBudget.promptTokenEstimate <= contextWindowCeiling');
    expect(source).toContain('preserving full append-only context for KV continuity');
    expect(source).not.toContain('Interactive context exceeded the responsive budget');
  });

  it('keeps resume trim gated by the backend fit ceiling, not the responsive target', () => {
    const source = readRepoFile('src/tui/session.ts');
    const resumeTrimStart = source.indexOf('prepareResumeTranscriptForUse');
    const resumeTrimSource = source.slice(resumeTrimStart);

    expect(resumeTrimStart).toBeGreaterThan(0);
    expect(resumeTrimSource).toContain('contextWindowCeiling');
    expect(resumeTrimSource).toContain('promptBudget.promptTokenEstimate <= contextWindowCeiling');
    expect(resumeTrimSource).toContain('TUI resume transcript exceeds responsive budget but fits backend window — preserving full context');
    expect(resumeTrimSource).toContain('The resumed session exceeded the backend fit budget');
    expect(resumeTrimSource).not.toContain('the session context exceeded the interactive responsive budget on resume');
  });

  it('emits the fallback final vLLM input estimate on both SSE completion paths', () => {
    const source = readRepoFile('src/provider/vllm.ts');
    expect(source.match(/type: 'usage'/g)).toHaveLength(3);
    expect(source.match(/inputTokens: finalInputTokens/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/cacheReadInputTokens/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).not.toContain('inputTokens: promptTokens, outputTokens: completionTokens, providerPromptEstimate');
  });

  it('reports resume compaction as provider-backed semantic work', () => {
    const source = readRepoFile('src/tui/hooks/useAgentSession.ts');
    expect(source).toContain('summarized via the model provider before the session became ready');
    expect(source).not.toContain('compacted locally');
  });

  it('does not retain deterministic heartbeat or tail compaction paths', () => {
    const heartbeat = readRepoFile('src/agent/heartbeat-hygiene.ts');
    const gateway = readRepoFile('src/gateway/agent-process.ts');
    const forbidden = [
      'compactNoopHeartbeatExchange',
      'compactUnproductiveHeartbeatExchange',
      'compactTrailingHeartbeatExchanges',
      'maybeCompactHeartbeatExchanges',
      'heartbeatPersistTrimGate',
      'heartbeatPersistTrimTarget',
    ];
    for (const marker of forbidden) {
      expect(heartbeat, `heartbeat hygiene must not implement deterministic rewrite ${marker}`)
        .not.toContain(marker);
      expect(gateway, `gateway must not call deterministic rewrite ${marker}`)
        .not.toContain(marker);
    }
    expect(heartbeat).not.toMatch(/'microcompact'|'session_reset'/);
  });
});

describe('SCLI TUI exit ergonomics', () => {
  it('keeps idle Ctrl+C as a single-press quit and prints the short resume command', () => {
    const source = readRepoFile('src/tui/App.tsx');
    expect(source).toContain('shizuha resume');
    expect(source).toContain('exitTui(exit)');
    expect(source).not.toContain('Press Ctrl+C again to quit');
    expect(source).not.toContain('--resume');
  });
});
