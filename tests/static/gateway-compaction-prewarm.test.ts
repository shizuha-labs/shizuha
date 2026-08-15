import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/gateway/agent-process.ts'),
  'utf8',
);

function between(start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing end marker: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('gateway cache-breaking history rewrite contract', () => {
  it('uses one provider-backed semantic projection for every automatic rewrite', () => {
    const block = between(
      'const applySemanticCompaction = async (',
      'const compactPostTurnBoundaryIfNeeded = async (',
    );

    expect(block).toContain('compactMessagesRequired(');
    expect(block).toContain('this.store.replaceMessages(this.sessionId, compacted)');
    expect(block).toContain('this.lastReportedPromptTokens = 0');
    expect(block).toContain('await prepareRewrittenHistory()');
    expect(block).not.toMatch(/extractive/i);
    expect(block).not.toContain('setTimeout');
    expect(block).not.toContain('Promise.race');
  });

  it('enforces semantic compaction before provider calls without count-based truncation', () => {
    const block = between(
      '// Pre-turn compaction check',
      '// Semantic compaction is the only legal history rewrite',
    );

    expect(block).toContain('needsCompaction(');
    expect(block).toContain("await applySemanticCompaction('pre-turn', systemOverheadTokens)");
    expect(block).not.toContain('EMERGENCY_THRESHOLD');
    expect(block).not.toContain('KEEP_RECENT');
    expect(block).not.toContain('compactMessages(');
  });

  it('runs the semantic boundary before every exit, including text-only completion', () => {
    const boundary = between(
      '// Context maintenance belongs to the completed model/tool sub-turn',
      '// Continuation logic — incomplete streams are terminal and never replay',
    );
    expect(boundary).toContain('await compactPostTurnBoundaryIfNeeded(turnMaxOutputTokens)');
    expect(boundary.indexOf('await compactPostTurnBoundaryIfNeeded')).toBeLessThan(
      boundary.indexOf('checkpointRuntimeRollAfterTurn'),
    );
  });

  it('uses LLM compaction for expensive-turn recovery too', () => {
    const recovery = between(
      "const { compactMessagesRequired } = await import('../state/compaction.js');",
      '// Messages can arrive between the generation fence and successor commit.',
    );
    expect(recovery).toContain('compactMessagesRequired(');
    expect(recovery).toContain("'semantic_compaction_succeeded'");
    expect(recovery).not.toMatch(/extractive/i);
    expect(recovery).not.toContain('recoveryProvider');
    expect(recovery).not.toContain('setTimeout');
    expect(recovery).not.toContain('Promise.race');
  });

  it('resumes a crash-fenced recovery semantically instead of committing a capsule-only reset', () => {
    const recovery = between(
      'private async resumeExpensiveTurnRecoveryAtStartup()',
      'private async pauseForExpensiveTurnGuardIfNeeded',
    );
    expect(recovery).toContain('compactMessagesRequired(');
    expect(recovery).toContain('targetFinalTokens');
    expect(recovery).toContain('persisted history was preserved');
    expect(recovery).not.toContain("'clean_successor_created_after_restart'");
    expect(recovery).not.toContain('commitExpensiveTurnSuccessor(\n        this.sessionId,\n        recovery.episodeId,\n        [capsule],');
  });

  it('tags exactly the successor turn when maintenance prewarm fails', () => {
    expect(source).toContain("{ reason: 'post_compaction' },");
    expect(source).toContain(": 'post_compaction';");
    expect(source).toContain('postCompactionRequestKind,\n          () => { cortexRehomeRequired = true; },');
    expect(source).toContain('postCompactionRequestKind = undefined;');
  });

  it('includes system and tool overhead when deciding whether a rewritten payload needs prewarm', () => {
    const block = between(
      "const minTokens = Number.parseInt(process.env['SHIZUHA_PREWARM_MIN_TOKENS']",
      "const { messagesToChat, toolDefinitionsForProvider } = await import('../agent/turn.js');",
    );

    expect(block).toContain('const messageTokens = estimateTokens(this.messages, model);');
    expect(block).toContain(
      'const overheadTokens = estimateOverheadTokens(this.systemPrompt, this.toolDefs, model);',
    );
    expect(block).toContain('const estimatedPromptTokens = messageTokens + overheadTokens;');
    expect(block).toContain("reason !== 'post_compaction'");
    expect(block).toContain('estimatedPromptTokens < Math.max(1_000, minTokens)');
    expect(block).not.toMatch(/if\s*\([^)]*messageTokens\s*</);
  });

  it('filters warmup to the Cortex provider and bypasses the generic floor after compaction', () => {
    const block = between(
      'private async runPrewarmPrefixCache(',
      "const { messagesToChat, toolDefinitionsForProvider } = await import('../agent/turn.js');",
    );

    expect(block).toContain("if (provider?.name !== 'cortex') return true;");
    expect(block).toContain("reason !== 'post_compaction'");
    expect(block).toContain("reason !== 'soft_drain_rehome'");
  });

  it('seeds first-real continuity from the exact provider-visible warmup payload', () => {
    const block = between(
      "const { messagesToChat, toolDefinitionsForProvider } = await import('../agent/turn.js');",
      "logger.info({ reason, ms: Date.now() - started }, 'Cortex prefix cache pre-warm complete');",
    );

    expect(block).toContain('const providerToolDefs = toolDefinitionsForProvider(this.toolDefs, provider);');
    expect(block).toContain('const prewarmPrefixSnapshot = buildProviderPrefixSnapshot({');
    expect(block).toContain('tools: providerToolDefs,');
    expect(block).toContain('tools: providerToolDefs.length > 0 ? providerToolDefs : undefined,');
    expect(block).toContain('this.lastProviderPrefixSnapshot = prewarmPrefixSnapshot;');
    expect(block.indexOf('this.lastProviderPrefixSnapshot = prewarmPrefixSnapshot;')).toBeGreaterThan(
      block.indexOf('for await (const _chunk of provider.chat'),
    );
  });

  it('serially converges DeepSeek hybrid APC before declaring the prefix warm', () => {
    const block = between(
      "const warmupPasses = lower.includes('deepseek-v4-flash') ? 2 : 1;",
      '// Seed continuity from the payload that actually completed prefill.',
    );

    expect(block).toContain('for (let pass = 1; pass <= warmupPasses; pass += 1)');
    expect(block).toContain('for await (const _chunk of provider.chat(chatMessages');
  });

  it('serializes a soft-drain rehome after the successful turn is in current history', () => {
    const turn = between(
      'let cortexRehomeRequired = false;',
      '// SCLI-74: record per-turn metrics for the /metrics Prometheus scrape',
    );

    expect(turn).toContain('() => { cortexRehomeRequired = true; }');
    expect(source).toContain('if (rehomeRequiredForAttempt) onCortexRehomeRequired?.();');
    expect(turn).toContain('this.messages.push(result.assistantMessage);');
    expect(turn).toContain("reason: 'soft_drain_rehome'");
    expect(turn).toContain('rehomeIntent: true');
    expect(turn.indexOf("reason: 'soft_drain_rehome'")).toBeGreaterThan(
      turn.indexOf('this.messages.push(result.assistantMessage);'),
    );
    expect(turn.indexOf('checkpointRuntimeRollAfterTurn')).toBeGreaterThan(
      turn.indexOf("reason: 'soft_drain_rehome'"),
    );
  });
});

describe('gateway context-anchor persistence (agent-ryo 2026-08-08)', () => {
  // The provider-truth anchor and its paired raw baseline must survive
  // harness rolls. A process-local anchor dies with the pod; the first
  // resumed turn is then cold-estimated at ×safety and can unnecessarily
  // compact a session with real headroom (ryo: 324K/62% → 6 messages).
  const source = fs.readFileSync(
    path.resolve('src/gateway/agent-process.ts'),
    'utf-8',
  );

  it('restores the persisted anchor pair on eternal-session resume', () => {
    expect(source).toContain('loadContextTokenAnchor?.(existing.id, this.model, this.messages)');
    expect(source).toContain('this.lastReportedRawEstimateTokens = anchor.rawPromptTokens');
  });

  it('persists the anchor pair for the exact request payload each turn', () => {
    expect(source).toContain('saveContextTokenAnchor?.(this.sessionId');
    // Baseline must be captured BEFORE the assistant response is appended.
    const captureIdx = source.indexOf('this.lastReportedRawEstimateTokens = estimateTokens(this.messages, activeModel)');
    const appendIdx = source.indexOf('this.messages.push(result.assistantMessage)');
    expect(captureIdx).toBeGreaterThan(0);
    expect(appendIdx).toBeGreaterThan(captureIdx);
  });

  it('passes the paired baseline into both needsCompaction gates', () => {
    const occurrences = source.split('this.lastReportedRawEstimateTokens, // paired baseline').length - 1;
    expect(occurrences).toBe(2);
  });
});
