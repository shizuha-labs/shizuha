/**
 * SCLI-384: invalid provider/model must fail-fast with /model guidance,
 * never enter the indefinite session retry loop.
 */
import { describe, expect, it } from 'vitest';
import {
  formatInvalidModelError,
  isInvalidModelOrProviderFailure,
  isTransientProviderFailure,
} from '../../src/provider/transient-errors.js';
import { ProviderRegistry } from '../../src/provider/registry.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

const emptyConfig = {
  providers: {},
  agent: { defaultModel: 'auto' },
  permissions: { mode: 'supervised' },
} as unknown as ShizuhaConfig;

describe('SCLI-384 invalid model fail-fast', () => {
  it('classifies model_not_found / 404 as non-transient even if retryable=true', () => {
    expect(isInvalidModelOrProviderFailure({
      message: 'model not found',
      code: 'model_not_found',
      status: 404,
    })).toBe(true);
    expect(isTransientProviderFailure({
      message: 'model not found',
      code: 'model_not_found',
      status: 404,
      retryable: true,
    })).toBe(false);
  });

  it('formatInvalidModelError names the model and points at /model', () => {
    const msg = formatInvalidModelError(
      'definitely-not-a-real-provider/SCLI178-MISSING-MODEL',
      'upstream 404',
    );
    expect(msg).toContain('definitely-not-a-real-provider/SCLI178-MISSING-MODEL');
    expect(msg).toMatch(/\/model/);
    expect(msg).toMatch(/--model/);
  });

  it('resolveWithModel rejects the QA fake provider prefix without OpenRouter fallback', () => {
    const registry = new ProviderRegistry(emptyConfig);
    expect(() =>
      registry.resolveWithModel('definitely-not-a-real-provider/SCLI178-MISSING-MODEL'),
    ).toThrow(/Unknown provider|Use \/model/i);
  });

  it('still routes vendor org/model ids to OpenRouter when configured (not fail-closed)', () => {
    const config = {
      providers: {
        openrouter: { apiKey: 'sk-or-test' },
      },
      agent: { defaultModel: 'auto' },
      permissions: { mode: 'supervised' },
    } as unknown as ShizuhaConfig;
    const registry = new ProviderRegistry(config);
    expect(registry.resolveWithModel('anthropic/claude-opus-4-6').provider.name).toBe('openrouter');
    expect(registry.resolveWithModel('deepseek/deepseek-chat').provider.name).toBe('openrouter');
  });
});
