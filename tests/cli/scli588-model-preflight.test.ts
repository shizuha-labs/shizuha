/**
 * SCLI-588: root -p --model must reject malformed/unqualified/stable selectors
 * locally and finitely BEFORE any session creation, provider dispatch, or
 * durable state mutation — never hang trying to pull a garbage selector or
 * create state.db for it.
 *
 * Two layers:
 *  - option-preflight rejects empty/whitespace/control/newline --model values
 *    (OptionPreflightError, code invalid_option);
 *  - the provider resolver rejects the reserved `stable` selector (and
 *    `cortex/stable`) with model_not_found instead of falling through to the
 *    Ollama default (which would hang trying to pull it).
 */
import { describe, expect, it } from 'vitest';
import {
  OptionPreflightError,
  validateCommonAgentOptions,
} from '../../src/cli/option-preflight.js';
import {
  ProviderRegistry,
  RESERVED_INVALID_MODELS,
} from '../../src/provider/registry.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

const emptyConfig = {
  providers: {},
  agent: { defaultModel: 'auto' },
  permissions: { mode: 'supervised' },
} as unknown as ShizuhaConfig;

describe('SCLI-588 model selector preflight', () => {
  it('rejects empty --model before any provider/session work', () => {
    expect(() => validateCommonAgentOptions({ model: '' }))
      .toThrow(OptionPreflightError);
    expect(() => validateCommonAgentOptions({ model: '   ' }))
      .toThrow(/Invalid --model/);
  });

  it('rejects Unicode whitespace and embedded newline/control selectors', () => {
    expect(() => validateCommonAgentOptions({ model: '\u00a0\u2003' }))
      .toThrow(/Invalid --model/);
    expect(() => validateCommonAgentOptions({ model: 'cortex\nDeepSeek' }))
      .toThrow(/Invalid --model/);
    expect(() => validateCommonAgentOptions({ model: 'cortex\u0000DeepSeek' }))
      .toThrow(/Invalid --model/);
  });

  it('accepts a valid canonical model selector', () => {
    const pf = validateCommonAgentOptions({ model: 'cortex/DeepSeek-V4-Flash' });
    expect(pf.model).toBe('cortex/DeepSeek-V4-Flash');
  });

  it('resolves stable to model_not_found, not the Ollama default', () => {
    const registry = new ProviderRegistry(emptyConfig);
    expect(() => registry.resolveWithModel('stable')).toThrow(/model_not_found/);
    expect(() => registry.resolveWithModel('cortex/stable')).toThrow(/model_not_found/);
  });

  it('still resolves plausible unknown models to Ollama (bare-tag contract)', () => {
    const config = {
      providers: { ollama: { baseUrl: 'http://localhost:11434' } },
      agent: { defaultModel: 'auto' },
      permissions: { mode: 'supervised' },
    } as unknown as ShizuhaConfig;
    const registry = new ProviderRegistry(config);
    expect(registry.resolve('my-custom-model').name).toBe('ollama');
  });

  it('RESERVED_INVALID_MODELS contains stable', () => {
    expect(RESERVED_INVALID_MODELS.has('stable')).toBe(true);
  });
});
