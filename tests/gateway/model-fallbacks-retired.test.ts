/**
 * One agent, one model — fallback chains are retired.
 *
 * Operator 2026-08-06: "let's completely remove the concept of model fallbacks
 * to avoid future confusions. only one agent-model is allowed and no fallbacks
 * for any agents". A live pod (kumo) kept a stale
 * MODEL_FALLBACKS=[grok-4.5, DeepSeek-V4-Flash] env long after Hive's SoT said
 * `[]`, because k8s strategic-merge patches cannot delete an env key — the
 * runtime then prewarmed and served BOTH models while the Agents page showed
 * one. The runtime is now inert to any surviving value.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { modelFallbacksEnv } from '../../src/gateway/agent-process.js';

afterEach(() => {
  delete process.env['MODEL_FALLBACKS'];
  delete process.env['SHIZUHA_MODEL_FALLBACKS'];
});

describe('model fallback chains are retired', () => {
  const STALE = JSON.stringify([
    { model: 'cortex/grok-4.5', method: 'grok_build' },
    { model: 'cortex/DeepSeek-V4-Flash', method: 'shizuha' },
  ]);

  it('ignores a stale MODEL_FALLBACKS env (the kumo template)', () => {
    process.env['MODEL_FALLBACKS'] = STALE;
    expect(modelFallbacksEnv()).toBeUndefined();
  });

  it('ignores SHIZUHA_MODEL_FALLBACKS too', () => {
    process.env['SHIZUHA_MODEL_FALLBACKS'] = STALE;
    expect(modelFallbacksEnv()).toBeUndefined();
  });

  it('ignores an explicitly injected env object', () => {
    expect(modelFallbacksEnv({ MODEL_FALLBACKS: STALE } as NodeJS.ProcessEnv)).toBeUndefined();
  });

  it('is undefined when nothing is set at all', () => {
    expect(modelFallbacksEnv()).toBeUndefined();
  });
});
