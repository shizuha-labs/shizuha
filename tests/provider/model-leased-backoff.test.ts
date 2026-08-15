/**
 * Cortex model_leased 503 must long-backoff, not enter the 5xx storm.
 */
import { describe, expect, it } from 'vitest';
import {
  isModelLeasedBody,
  modelLeasedRetryMs,
} from '../../src/provider/vllm.js';
import { isTransientProviderFailure } from '../../src/provider/transient-errors.js';

describe('isModelLeasedBody', () => {
  it('detects cortex error shape', () => {
    const body = {
      error: {
        message: 'Model GLM is currently leased to another agent (agent-nova).',
        type: 'model_leased',
        code: 'model_leased_to_other',
      },
    };
    expect(isModelLeasedBody(body, JSON.stringify(body))).toBe(true);
  });

  it('rejects unrelated 503 bodies', () => {
    expect(isModelLeasedBody({ error: { type: 'maintenance' } }, '{}')).toBe(false);
    expect(isModelLeasedBody(undefined, 'backend overloaded')).toBe(false);
  });
});

describe('modelLeasedRetryMs', () => {
  it('floors at 60s and honors Retry-After when larger', () => {
    const h = new Headers({ 'retry-after': '60' });
    const ms = modelLeasedRetryMs(h, 0, () => 0.5);
    expect(ms).toBeGreaterThanOrEqual(60_000);
    expect(ms).toBeLessThanOrEqual(900_000);
  });

  it('grows with attempt but caps at 15min', () => {
    const h = new Headers();
    const early = modelLeasedRetryMs(h, 0, () => 0.5);
    const late = modelLeasedRetryMs(h, 8, () => 0.5);
    expect(late).toBeGreaterThanOrEqual(early);
    expect(late).toBeLessThanOrEqual(900_000);
  });
});

describe('isTransientProviderFailure for model_leased', () => {
  it('is NOT short-retry transient', () => {
    expect(
      isTransientProviderFailure({
        status: 503,
        message: 'model_leased: Model X is currently leased to another agent',
        code: 'model_leased_to_other',
      }),
    ).toBe(false);
  });
});
