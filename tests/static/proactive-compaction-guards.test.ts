/**
 * Static + behavioral guards: context overflow must never reach the provider.
 *
 * Operator 2026-07-24: "ideally we should never even have an overflow that we
 * ever need to recover from". The 2026-07-24 shizuha1 incident was:
 *   needsCompaction(true via real prompt_tokens) → compactMessages(force=false)
 *   → tiktoken under-count → compacted=false → provider context_length_exceeded
 *   → overflow-recovery.
 *
 * These checks fail CI if that class of bug is re-introduced. Model windows
 * come from Cortex /v1/models (max_model_len / context_length) — defaults are
 * only a planning floor; the proactive path must trust served truth and still
 * leave enough headroom that a tool-round cannot walk past the hard limit.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compactionThresholdFor,
  effectiveContextTokens,
  largeWindowHeadroomTokens,
  needsCompaction,
} from '../../src/prompt/context.js';
import {
  resolveEffectiveContextWindow,
  resolveModelContextWindow,
} from '../../src/provider/context-window.js';
import { isTransientProviderFailure } from '../../src/provider/transient-errors.js';
import type { Message } from '../../src/agent/types.js';

const repoRoot = resolve(__dirname, '../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

/** Entry points where an explicit/manual path may still call the provider. */
const REMOTE_COMPACTION_CALL_SITES = [
  'src/tui/session.ts',
] as const;

/** Copied automatic loops must compact semantically at both sides of every subturn. */
const AUTOMATIC_COMPACTION_ENTRYPOINTS = [
  'src/index.ts',
  'src/server.ts',
  'src/android-entry.ts',
] as const;

/**
 * Find each real `compactMessages(` *call* and return the following ~350 chars
 * (covers the options object). Uses indexOf — no catastrophic-backtracking regex.
 * Skips: type-parameter names, comments, and the function definition.
 */
function compactMessagesOptionSnippets(source: string): string[] {
  const snippets: string[] = [];
  let from = 0;
  while (true) {
    const idx = source.indexOf('compactMessages(', from);
    if (idx < 0) break;
    // Look back far enough to catch full-line comments containing "compactMessages("
    const lineStart = source.lastIndexOf('\n', idx - 1) + 1;
    const linePrefix = source.slice(lineStart, idx);
    const before = source.slice(Math.max(0, idx - 80), idx);
    // Skip definition, type positions, and comments mentioning compactMessages(
    if (
      /function\s+$/.test(before)
      || /:\s*$/.test(before) // e.g. compactMessagesFn: (
      || /^\s*\/\//.test(linePrefix)
      || /^\s*\*/.test(linePrefix)
      || linePrefix.includes('//')
    ) {
      from = idx + 16;
      continue;
    }
    snippets.push(source.slice(idx, idx + 350));
    from = idx + 16;
  }
  // runCompactionWithHeartbeat(compactMessages, …) — only call sites, not the method def
  from = 0;
  while (true) {
    const idx = source.indexOf('runCompactionWithHeartbeat(', from);
    if (idx < 0) break;
    const before = source.slice(Math.max(0, idx - 40), idx);
    if (/private\s+$/.test(before) || /async\s+$/.test(before) || /function\s+$/.test(before)) {
      from = idx + 20;
      continue;
    }
    // Method definition: `private async runCompactionWithHeartbeat(`
    if (/runCompactionWithHeartbeat\s*\(/.test(source.slice(idx, idx + 30)) && /:\s*Promise/.test(source.slice(idx, idx + 600))) {
      // Heuristic: definition has return type Promise on the signature
      const sig = source.slice(idx, idx + 800);
      if (sig.includes('phase: \'pre-turn\'') && sig.includes('Promise<{')) {
        from = idx + 20;
        continue;
      }
    }
    snippets.push(source.slice(idx, idx + 450));
    from = idx + 20;
  }
  return snippets;
}

describe('proactive compaction — static force:true invariant', () => {
  it('has no deterministic summary fallback or destructive recent-tail deletion', () => {
    const source = readRepoFile('src/state/compaction.ts');
    expect(source).toContain('selectSemanticPrefix');
    expect(source).toContain('messages.slice(suffixStart)');
    expect(source).toContain('CompactionQualityError');
    expect(source).not.toMatch(/compactMessagesExtractively|buildExtractiveFallbackSummary/);
    expect(source).not.toContain('compacted.length = 2');
    expect(source).not.toContain('middle context omitted');
  });

  it('every compactMessages call site under production entrypoints forces compaction', () => {
    const missing: string[] = [];
    let total = 0;
    for (const path of REMOTE_COMPACTION_CALL_SITES) {
      const source = readRepoFile(path);
      const snippets = compactMessagesOptionSnippets(source);
      expect(snippets.length, `${path} must call compactMessages`).toBeGreaterThan(0);
      for (const snippet of snippets) {
        total += 1;
        if (!/\bforce\s*:\s*true\b/.test(snippet)) {
          missing.push(`${path}: ${snippet.replace(/\s+/g, ' ').slice(0, 200)}`);
        }
      }
    }
    expect(total).toBeGreaterThanOrEqual(1);
    expect(missing, missing.join('\n')).toEqual([]);
  });

  it('automatic copied loops use provider-backed semantic compaction before calls and after every subturn', () => {
    for (const path of AUTOMATIC_COMPACTION_ENTRYPOINTS) {
      const source = readRepoFile(path);
      expect(source, path).toMatch(/applyRequiredCompactionOrThrow|compactMessagesRequired/);
      expect(source, `${path} must not retain deterministic compaction`)
        .not.toMatch(/compactMessagesExtractively|buildExtractiveFallbackSummary/);
      expect(source, `${path} must not destructively trim after automatic compaction`)
        .not.toContain('fitMessagesToContextBudget');
      expect(source, `${path} must not destructively reset heartbeat history`)
        .not.toContain('trimMessagesForHeartbeatBudget');

      const loopStart = source.indexOf('while (!maxTurns || turnIndex < maxTurns)');
      const providerCall = source.indexOf('executeTurn(', loopStart);
      const preCallGate = source.indexOf('compactAutomaticallyIfNeeded(', loopStart);
      expect(loopStart, `${path} loop`).toBeGreaterThan(-1);
      expect(preCallGate, `${path} pre-call gate`).toBeGreaterThan(loopStart);
      expect(preCallGate, `${path} pre-call gate must precede executeTurn`).toBeLessThan(providerCall);

      const persistedUsage = source.indexOf('store.updateTokens(', providerCall);
      const postTurnGate = source.indexOf('compactAutomaticallyIfNeeded(', persistedUsage);
      const continuation = source.indexOf('// Continuation logic', persistedUsage);
      expect(persistedUsage, `${path} completed-subturn boundary`).toBeGreaterThan(providerCall);
      expect(postTurnGate, `${path} post-turn gate`).toBeGreaterThan(persistedUsage);
      expect(postTurnGate, `${path} text-only exits must happen after compaction`).toBeLessThan(continuation);
    }
  });

  it('manual TUI remote compaction remains bound to the active session', () => {
    const source = readRepoFile('src/tui/session.ts');
    const wrapper = source.slice(
      source.indexOf('private async runCompactionWithHeartbeat'),
      source.indexOf('/** Submit a user prompt', source.indexOf('private async runCompactionWithHeartbeat')),
    );
    expect(wrapper).toContain('sessionId: options?.sessionId ?? this.sessionId ?? undefined');
    const manualCall = source.slice(
      source.indexOf("const { compactMessages } = await import('../state/compaction.js')"),
      source.indexOf("'manual',", source.indexOf("const { compactMessages } = await import('../state/compaction.js')")) + 20,
    );
    expect(manualCall).toContain('runCompactionWithHeartbeat');
  });

  it('TUI automatic phases and manual requests both use semantic provider compaction', () => {
    const source = readRepoFile('src/tui/session.ts');
    for (const phase of ['pre-turn', 'post-turn', 'overflow-recovery', 'resume'] as const) {
      const marker = `'${phase}',`;
      const phaseAt = source.indexOf(marker, source.indexOf('enforceRequiredCompaction('));
      expect(phaseAt, `${phase} must use enforceRequiredCompaction`).toBeGreaterThan(-1);
    }
    const manualAt = source.lastIndexOf("'manual',");
    expect(manualAt, 'manual compaction must keep the explicit remote path').toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, manualAt - 500), manualAt)).toContain('force: true');
  });

  it('treats overflow-recovery as a logged failure of the proactive path (not normal ops)', () => {
    const source = readRepoFile('src/tui/session.ts');
    expect(source).toContain('proactive compaction failed');
    expect(source).toContain('Context overflow reached provider');
    // Must not re-introduce the fixed 0.90-only post-turn gate (diverges from pre-turn).
    expect(source).not.toMatch(/_lastApiInputTokens\s*>\s*maxContextTokens\s*\*\s*0\.90/);
  });

  it('does not re-introduce the 24K large-window headroom that allowed overflow', () => {
    const source = readRepoFile('src/prompt/context.ts');
    expect(source).not.toContain('maxTokens - 24_000');
    expect(source).not.toContain('maxTokens - 24000');
    expect(source).toContain('LARGE_WINDOW_HEADROOM_TOKENS');
    expect(source).toContain('largeWindowHeadroomTokens');
  });

  it('every non-manual automatic loop uses required semantic compaction', () => {
    for (const path of [
      'src/agent/loop.ts',
      'src/index.ts',
      'src/server.ts',
      'src/android-entry.ts',
      'src/gateway/agent-process.ts',
    ] as const) {
      const source = readRepoFile(path);
      expect(source, path).toContain('needsCompaction');
      expect(source, path).toMatch(/applyRequiredCompactionOrThrow|compactMessagesRequired/);
      expect(source, `${path} must not retain deterministic compaction`)
        .not.toMatch(/compactMessagesExtractively|buildExtractiveFallbackSummary/);
    }
  });

  it('has no local tool-result microcompactor', () => {
    expect(existsSync(resolve(repoRoot, 'src/state/microcompaction.ts'))).toBe(false);
    for (const path of [
      'src/agent/loop.ts',
      'src/index.ts',
      'src/server.ts',
      'src/android-entry.ts',
      'src/gateway/agent-process.ts',
    ] as const) {
      expect(readRepoFile(path), path).not.toMatch(/microcompactMessage|microcompactLatest/);
    }
  });
});

describe('proactive compaction — behavioral invariants', () => {
  it('large-window headroom is ≥48K and ≥15% of the window', () => {
    for (const window of [200_000, 262_144, 272_000, 512_000, 1_000_000]) {
      const headroom = largeWindowHeadroomTokens(window);
      expect(headroom).toBeGreaterThanOrEqual(48_000);
      expect(headroom).toBeGreaterThanOrEqual(Math.floor(window * 0.15));
      const trigger = window * compactionThresholdFor(window, 'gpt-5.5');
      expect(window - trigger).toBeGreaterThanOrEqual(headroom - 1);
      expect(window - trigger).toBeGreaterThanOrEqual(32_000);
    }
  });

  it('Spark / Codex windows leave proactive headroom under Cortex 272k catalog', () => {
    const sparkWindow = resolveModelContextWindow('cortex/gpt-5.3-codex-spark');
    expect(sparkWindow).toBe(272_000);
    const trigger = sparkWindow * compactionThresholdFor(sparkWindow, 'cortex/gpt-5.3-codex-spark');
    expect(sparkWindow - trigger).toBeGreaterThanOrEqual(48_000);
    const messages: Message[] = [{ role: 'user', content: 'hi' }];
    expect(needsCompaction(messages, sparkWindow, 'cortex/gpt-5.3-codex-spark', 0, 0, Math.floor(trigger + 100))).toBe(true);
    expect(needsCompaction(messages, sparkWindow, 'cortex/gpt-5.3-codex-spark', 0, 0, Math.floor(trigger - 5_000))).toBe(false);
  });

  it('served Cortex max_model_len wins over config that tries to raise the window', () => {
    // Non-generic served rung (not the 131k constructor floor) must be trusted,
    // and config must not raise above it.
    const served = { maxContextWindow: 98_304, contextWindowFor: () => 98_304 };
    expect(resolveEffectiveContextWindow('cortex/DeepSeek-V4-Flash', served, 1_000_000)).toBe(98_304);
    expect(resolveEffectiveContextWindow('cortex/DeepSeek-V4-Flash', served, 50_000)).toBe(50_000);
  });

  it('growth since last reported prompt is padded (not whole-history re-inflated)', () => {
    const messages: Message[] = [{ role: 'user', content: 'word '.repeat(20_000) }];
    const rawish = effectiveContextTokens(messages, 'gpt-5.5', 0, 0); // factor 1.0 ≈ raw
    const reported = Math.floor(rawish * 0.5);
    const grown = effectiveContextTokens(messages, 'gpt-5.5', 0, reported);
    expect(grown).toBeGreaterThan(reported);
    expect(grown).toBe(reported + Math.ceil((rawish - reported) * 1.10));
    // Must NOT apply 1.45× to the entire history (SCLI-182 regression).
    const coldLocal = effectiveContextTokens(messages, 'cortex/DeepSeek-V4-Flash', 0, 0);
    expect(grown).toBeLessThan(coldLocal);
  });

  it('grows provider truth from the matching raw request baseline', () => {
    const atReport: Message[] = [{ role: 'user', content: 'word '.repeat(10_000) }];
    const afterReport: Message[] = [
      ...atReport,
      { role: 'assistant', content: 'new output '.repeat(2_000) },
    ];
    const rawAtReport = effectiveContextTokens(atReport, 'gpt-5.5');
    const rawAfterReport = effectiveContextTokens(afterReport, 'gpt-5.5');
    const reported = 40_000;

    expect(effectiveContextTokens(
      afterReport,
      'cortex/GLM-5.2',
      0,
      reported,
      rawAtReport,
    )).toBe(reported + Math.ceil((rawAfterReport - rawAtReport) * 1.10));
  });

  it('never leaves a compaction-to-hard-fit inversion across large windows', () => {
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    for (const window of [200_000, 262_144, 320_000, 512_000, 1_000_000]) {
      const guard = Math.max(1_024, Math.min(65_536, Math.ceil(window * 0.125)));
      const output = 16_384;
      const hardFitCeiling = window - guard - output;
      expect(window * compactionThresholdFor(window, 'cortex/GLM-5.2'))
        .toBeLessThanOrEqual(hardFitCeiling);
      expect(needsCompaction(
        messages,
        window,
        'cortex/GLM-5.2',
        0,
        output,
        hardFitCeiling + 1,
        0,
        guard,
      )).toBe(true);
    }
  });

  it('output budget alone forces compaction before input+output would overflow the window', () => {
    const messages: Message[] = [{ role: 'user', content: 'short' }];
    // Input alone under the 0.70 threshold (30k < 35k), but input+output overflows.
    expect(needsCompaction(messages, 50_000, 'gpt-5.5', 0, 25_000, 30_000)).toBe(true);
    // Input + small output still fits.
    expect(needsCompaction(messages, 50_000, 'gpt-5.5', 0, 5_000, 30_000)).toBe(false);
  });
});

describe('proactive compaction — Cortex model-param contract (static)', () => {
  it('VLlmProvider prefers max_model_len / context_length from /v1/models over constructor floors', () => {
    const source = readRepoFile('src/provider/vllm.ts');
    expect(source).toContain('max_model_len');
    expect(source).toContain('context_length');
    expect(source).toMatch(/max_model_len is ground truth|served value used|served max_model_len/i);
  });

  it('compaction window resolution never lets config exceed the live provider window', () => {
    const source = readRepoFile('src/provider/context-window.ts');
    expect(source).toContain('Math.min(configured, effectiveProvider)');
    expect(source).toMatch(/must never raise the usable window above the provider/i);
  });

  it('context_length_exceeded is non-transient (no infinite retry of an oversized prompt)', () => {
    const source = readRepoFile('src/provider/transient-errors.ts');
    expect(source).toMatch(/context_length|context window/i);
    expect(isTransientProviderFailure({
      message: 'Your input exceeds the context window of this model.',
      code: 'context_length_exceeded',
    })).toBe(false);
  });
});

describe('resume compaction — semantic only with immutable suffix (2026-08-09)', () => {
  it('TUI resume has no destructive trim/reset fallthrough', () => {
    const source = readRepoFile('src/tui/session.ts');
    const methodStart = source.indexOf('prepareResumeTranscriptForUse');
    const method = source.slice(methodStart, source.indexOf('discoverResumeContextWindow', methodStart));
    expect(method).toContain('enforceRequiredCompaction');
    expect(method).not.toContain('trimMessagesToFitDetailed');
    expect(method).not.toContain('resetToLastUserPrompt');
    expect(method).not.toContain('truncateOversizedToolResultsInMessages');
  });

  it('deletes every deterministic context trim/reset implementation', () => {
    const source = readRepoFile('src/agent/heartbeat-hygiene.ts');
    expect(source).not.toMatch(
      /fitMessagesToContextBudget|trimMessagesForHeartbeatBudget|trimMessagesToFit|resetToLastUserPrompt|truncateOversizedToolResultsInMessages/,
    );
  });

  it('does not clip assistant output or task anchors before semantic maintenance', () => {
    const loop = readRepoFile('src/agent/loop.ts');
    const compaction = readRepoFile('src/state/compaction.ts');
    expect(loop).not.toMatch(/MAX_MESSAGE_CHARS|output truncated to prevent context overflow/);
    expect(compaction).not.toMatch(/TASK_ANCHOR_MAX_CHARS|function truncateMiddle/);
  });
});
