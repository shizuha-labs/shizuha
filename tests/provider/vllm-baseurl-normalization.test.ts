import { describe, expect, it } from 'vitest';
import { VLlmProvider } from '../../src/provider/vllm.js';

/**
 * SCLI-112: a VLLM_BASE_URL that already ends in /v1 (e.g. the public Cortex
 * URL `https://cortex.shizuha.com/v1`) must be normalized so the provider — which
 * appends `/v1/models` and `/v1/chat/completions` itself — does not double-path
 * to `/v1/v1/...` → HTML 404.
 */
describe('VLlmProvider baseUrl normalization (SCLI-112)', () => {
  const baseOf = (p: VLlmProvider) => (p as unknown as { baseUrl: string }).baseUrl;

  it('strips a trailing /v1', () => {
    expect(baseOf(new VLlmProvider('https://cortex.shizuha.com/v1')))
      .toBe('https://cortex.shizuha.com');
  });

  it('strips a trailing /v1 with a trailing slash', () => {
    expect(baseOf(new VLlmProvider('https://cortex.shizuha.com/v1/')))
      .toBe('https://cortex.shizuha.com');
  });

  it('leaves a base without a trailing /v1 unchanged', () => {
    expect(baseOf(new VLlmProvider('http://10.43.26.250:8040')))
      .toBe('http://10.43.26.250:8040');
  });

  it('does not strip a /v1 that is not at the end of the path', () => {
    expect(baseOf(new VLlmProvider('https://host/api/v1/proxy')))
      .toBe('https://host/api/v1/proxy');
  });
});
