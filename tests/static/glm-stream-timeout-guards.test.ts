/**
 * GLM interactive tool turns must not false-timeout as first-token ETIMEDOUT.
 * 2026-07-25: non-stream + thinking + 120s budget → infinite stall retries.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(__dirname, '../../src/provider/vllm.ts'), 'utf8');

describe('GLM interactive stream/timeout guards', () => {
  it('streams tools when GLM thinking is on (avoids non-stream full-body wait)', () => {
    expect(src).toContain('glmThinkingOn');
    expect(src).toMatch(/!isGlmModel \|\| glmThinkingOn/);
  });

  it('gives slow thinking models multi-minute first-token budgets that scale with prompt size', () => {
    expect(src).toContain('isSlowThinkingModel');
    // Floor first-token wait for thinking models (interactive)
    expect(src).toMatch(/isSlowThinkingModel \? 600_000/);
    // Cap allows ~30 min cold prefill for 70k+ (not compact-as-workaround)
    expect(src).toMatch(/isSlowThinkingModel \? 1_800_000/);
    // Conservative prefill floor so 70k is not timed out as if it were 150 tok/s
    expect(src).toMatch(/isRemoteCodex \|\| isSlowThinkingModel \? 25/);
  });

  it('clamps interactive thinking model max_tokens so one turn cannot monopolize the backend', () => {
    expect(src).toContain('INTERACTIVE_THINKING_MAX_OUT');
    expect(src).toContain('clamped max_tokens for interactive thinking model');
  });
});
