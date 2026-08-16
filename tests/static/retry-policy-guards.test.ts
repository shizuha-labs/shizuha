/**
 * Static guards for session-level provider retry policy.
 *
 * Operator 2026-07-23: transient upstream failures (server_error, stream stall,
 * intermittent OAuth 401) must NEVER end a turn with a fixed attempt budget.
 * Agents shipping SCLI changes have repeatedly re-introduced SESSION_MAX_RETRIES=3
 * and fatal 401 handling — this suite fails CI before that lands.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isTransientProviderFailure,
  TRANSIENT_RETRY_MAX_DELAY_MS,
  transientRetryDelayMs,
} from '../../src/provider/transient-errors.js';

const repoRoot = resolve(__dirname, '../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

const SESSION_RETRY_SITES = [
  'src/tui/session.ts',
  'src/agent/loop.ts',
  'src/index.ts',
  'src/android-entry.ts',
] as const;

describe('SCLI session-level retry policy guards', () => {
  it('does not re-introduce a fixed SESSION_MAX_RETRIES attempt budget', () => {
    for (const path of SESSION_RETRY_SITES) {
      const source = readRepoFile(path);
      expect(source, `${path} must not cap session retries`).not.toMatch(
        /SESSION_MAX_RETRIES\s*=\s*\d+/,
      );
      // No "attempt N/M" counter — only indefinite attempt N messaging.
      expect(source, `${path} must not show N/maxAttempts in session retry copy`).not.toMatch(
        /retrying[^\n]{0,80}\$\{[^}]+\} \/ \$\{[^}]*MAX/i,
      );
      expect(source, `${path} must not throw on retryAttempt >= max`).not.toMatch(
        /retryAttempt\s*>=\s*(SESSION_MAX_RETRIES|maxRetries)/,
      );
    }
  });

  it('uses shared indefinite backoff helpers at every session retry site', () => {
    for (const path of SESSION_RETRY_SITES) {
      const source = readRepoFile(path);
      expect(source, `${path} must use transientRetryDelayMs`).toContain('transientRetryDelayMs');
      expect(source, `${path} must use sleepMs or await sleep for abort-aware backoff`)
        .toMatch(/sleepMs|await new Promise/);
      // The retry copy is now built by the shared formatRetryNotice() helper, so
      // a site satisfies this either by carrying the literal itself or by
      // delegating. Delegation is checked for real below — asserting the shared
      // builder's OUTPUT beats grepping four files for a word in a comment.
      expect(source, `${path} must advertise indefinite retries (literal or via formatRetryNotice)`)
        .toMatch(/indefinite|formatRetryNotice/i);
    }
  });

  it('has the shared retry-notice builder advertise indefinite retries', async () => {
    const { formatRetryNotice } = await import('../../src/provider/transient-errors.js');
    const notice = formatRetryNotice({
      label: 'API error',
      status: 503,
      message: 'latency tail guard: no safe cold-prefill lane',
      attempt: 4,
      elapsedMs: 120_000,
      delayMs: 8_000,
    });
    expect(notice).toMatch(/indefinite/i);
    // Never render a bounded "attempt 4 / 10" budget.
    expect(notice).not.toMatch(/attempt\s*\d+\s*\/\s*\d+/i);
    // The operator must be able to see the cause and how long it has been stuck.
    expect(notice).toContain('latency tail guard');
    expect(notice).toMatch(/stalled 2m/);
  });

  it('keeps OpenAI server_error / stalls transient and 401 non-transient', () => {
    expect(isTransientProviderFailure({
      message: 'An error occurred while processing your request. help.openai.com',
      code: 'server_error',
    })).toBe(true);

    expect(isTransientProviderFailure({
      message: 'vLLM no first chunk: no events for 120s',
      code: 'ETIMEDOUT',
    })).toBe(true);

    // 401 is never infinite-retried (operator 2026-07-23).
    expect(isTransientProviderFailure({
      message: 'vLLM error 401: {"error":{"message":"Unauthorized"}}',
      status: 401,
    })).toBe(false);

    expect(isTransientProviderFailure({
      message: 'Your input exceeds the context window of this model.',
      code: 'context_length_exceeded',
    })).toBe(false);

    expect(isTransientProviderFailure({
      message: 'Cannot connect to vLLM after one configured attempt: fetch failed',
      code: 'provider_endpoint_unavailable',
      retryable: false,
    })).toBe(false);

    // SCLI-384: invalid model/provider must never enter indefinite backoff —
    // even when a caller mis-sets retryable:true.
    expect(isTransientProviderFailure({
      message: 'Model not found: definitely-not-a-real-provider/SCLI178-MISSING-MODEL',
      code: 'model_not_found',
      status: 404,
      retryable: true,
    })).toBe(false);
    expect(isTransientProviderFailure({
      message: 'Unknown provider "definitely-not-a-real-provider"',
      status: 400,
    })).toBe(false);
    expect(isTransientProviderFailure({
      message: 'OpenRouter error 404: model does not exist',
      status: 404,
    })).toBe(false);
  });

  it('caps exponential backoff (never linear/unbounded delay growth)', () => {
    const mid = () => 0.5;
    expect(transientRetryDelayMs(0, mid)).toBe(1_000);
    expect(transientRetryDelayMs(1, mid)).toBe(2_000);
    expect(transientRetryDelayMs(20, mid)).toBe(TRANSIENT_RETRY_MAX_DELAY_MS);
    expect(TRANSIENT_RETRY_MAX_DELAY_MS).toBeLessThanOrEqual(120_000);
  });

  it('TUI friendly copy no longer claims retries are exhausted for transient classes', () => {
    const source = readRepoFile('src/tui/session.ts');
    expect(source).not.toMatch(/retries exhausted/i);
    expect(source).toMatch(/retries indefinitely with backoff/i);
  });
});
