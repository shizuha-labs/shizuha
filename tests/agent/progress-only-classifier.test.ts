/**
 * A turn that ends by announcing an action it never took is a stall — at ANY
 * length.
 *
 * Live case, 2026-08-05 (tmux shizuha1). Operator:
 *
 *   it doesn't show the buffering animation so likely not doing anything ..
 *   most likely it died in the midst of doing something but doesn't even seem
 *   to be retrying at all .. this needs serious investigation
 *
 * The session had not died. The model produced a 2,720-char think-aloud turn —
 * "Let me reconsider the two-repo flow… Let me write the workflow file… Let me
 * first check: … Let me check for a crates mirror / cargo config in the
 * cluster." — and ended it with ZERO tool calls. The TUI's progress-only
 * recovery already existed for exactly this, but the classifier hard-capped at
 * 700 chars (`if (normalized.length > 700) return false`), so the longer and
 * more elaborate the stall, the more certainly it was ignored. The session sat
 * idle ~55 minutes until a human noticed.
 *
 * Length is not the signal; the ENDING is.
 */
import { describe, expect, it } from 'vitest';

import { isProgressOnlyAssistantText } from '../../src/agent/content.js';

// Abbreviated but shape-faithful excerpt of the real 2,720-char message,
// including its actual final sentence.
const LONG_STALL = `The cleanest solution: provide our own Dockerfile in the fork that uses the same multi-stage Rust build but is kaniko-compatible (build on native arch, cross-compile via the --target flag which the upstream already does). ${'For kaniko on an amd64 node building the arm64 image: kaniko runs on amd64 and the Dockerfile cross-compiles. '.repeat(6)} Let me write the deploy.yml workflow for the stalwart fork, adapting the id pattern but simplified. Let me first check: does the build job need the awk Dockerfile cache-wiring step (for npm/pip)? Stalwart doesn't need npm/pip caches, so I can skip that. But the Rust build pulls crates from crates.io — kaniko's build needs network for that. Let me check for a crates mirror / cargo config in the cluster.`;

describe('long stalls are still stalls', () => {
  it('classifies the real shizuha1 stall as progress-only', () => {
    expect(LONG_STALL.length).toBeGreaterThan(700); // the old cliff
    expect(
      isProgressOnlyAssistantText(LONG_STALL),
      'a turn ending "Let me check for a crates mirror…" with no tool call '
        + 'left the operator\'s session idle for ~55 minutes',
    ).toBe(true);
  });

  it('still classifies short intent as progress-only', () => {
    expect(isProgressOnlyAssistantText('Let me check the service configuration.')).toBe(true);
  });

  it('classifies "Let me trace …" as progress-only (shizuha1 2026-08-13)', () => {
    // "trace" was missing from the action-verb list, so this exact closer
    // ended a long think-aloud turn with zero tool calls and the TUI went idle.
    const closer = 'Let me trace the actual routing (resolve, headers, and what fronts the LB IP).';
    expect(isProgressOnlyAssistantText(closer)).toBe(true);
    const long = `${'Gateway redeployed with prefix-stripping; ingress is now a clean /deployer Prefix. '.repeat(12)}${closer}`;
    expect(long.length).toBeGreaterThan(700);
    expect(isProgressOnlyAssistantText(long)).toBe(true);
  });

  it('classifies DeepSeek gerund narration that promises action now', () => {
    expect(
      isProgressOnlyAssistantText('Creating the teaching module now — rich lessons, examples, and exercises.'),
    ).toBe(true);
  });

  it('does not classify a substantive gerund-led explanation', () => {
    expect(isProgressOnlyAssistantText('Creating indexes reduces lookup latency for large tables.')).toBe(false);
  });
});

describe('completed answers are never nudged', () => {
  it('a long substantive answer ending with a conclusion is not a stall', () => {
    const answer = `${'The migration completed successfully and all 14 services report healthy. '.repeat(12)} In summary, the rollout is complete and verified on the running system.`;
    expect(answer.length).toBeGreaterThan(700);
    expect(isProgressOnlyAssistantText(answer)).toBe(false);
  });

  it('"let me know" is a closer, not intent — short form', () => {
    expect(
      isProgressOnlyAssistantText('The fix is deployed and verified. Let me know if you want me to check the logs.'),
    ).toBe(false);
  });

  it('"let me know" is a closer, not intent — long form', () => {
    const answer = `${'Everything is deployed and green across the fleet. '.repeat(20)} Let me know if you want me to check anything else.`;
    expect(answer.length).toBeGreaterThan(700);
    expect(isProgressOnlyAssistantText(answer)).toBe(false);
  });

  it('a long answer that MENTIONS earlier intent mid-text but concludes is fine', () => {
    const answer = `I said I'll check the config, and I did — here are the results. ${'The values are consistent with the deployed manifests. '.repeat(15)} All checks passed; nothing further is required.`;
    expect(answer.length).toBeGreaterThan(700);
    expect(isProgressOnlyAssistantText(answer)).toBe(false);
  });

  it('empty text is not a stall (handled by the empty-response path)', () => {
    expect(isProgressOnlyAssistantText('')).toBe(false);
  });
});
