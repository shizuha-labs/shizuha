/**
 * SCLI-522: the ollama chat-completions lane must emit the same header-wait
 * keepalive contract as the vLLM lane.
 *
 * QA reconfirmation (mika, 2026-09-14, evidence /tmp/scli522/evidence3/): with
 * the PR #213 TUI-side fix code present in the bundle, all four SCLI-522
 * acceptance criteria still FAILED on the ollama lane — the keepalive
 * generator existed only in the TUI consumer, and nothing on this wire path
 * emitted `request_wait`, so the no-header wait stayed a passive spinner.
 *
 * Pinned here at the source level: OllamaProvider.chat() yields request_start
 * plus periodic request_wait (waitPhase=headers, growing elapsedMs) and
 * escalates to warning level with the recovery affordance past the soft
 * threshold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INTERACTIVE_SOFT_STALL_MS, OllamaProvider } from '../../src/provider/ollama.js';
import type { StreamChunk } from '../../src/provider/types.js';

const ENV_KEYS = [
  'SHIZUHA_INTERACTIVE_TUI',
  'OLLAMA_SOFT_STALL_MS',
  'OLLAMA_REQUEST_STATUS_INTERVAL_MS',
] as const;

describe('ollama interactive no-header keepalive contract (SCLI-522)', () => {
  const savedEnv: Record<string, string | undefined> = {};
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.restoreAllMocks();
  });

  function mockNoHeaderChat(): void {
    globalThis.fetch = vi.fn(async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.endsWith('/api/chat')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(init.signal?.reason ?? new Error('aborted'));
          });
        });
      }
      throw new Error(`unexpected URL ${requestUrl}`);
    }) as typeof globalThis.fetch;
  }

  it('emits request_start + periodic request_wait keepalives with growing elapsedMs', async () => {
    process.env['SHIZUHA_INTERACTIVE_TUI'] = '1';
    process.env['OLLAMA_REQUEST_STATUS_INTERVAL_MS'] = '20';
    process.env['OLLAMA_SOFT_STALL_MS'] = '60';
    mockNoHeaderChat();

    const provider = new OllamaProvider('http://ollama.test');
    const statuses: Extract<StreamChunk, { type: 'status' }>[] = [];
    // Ollama has no internal first-token timeout — the no-header generator
    // would keep yielding forever. Bound the pull once we have enough frames.
    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'qa-loopback-model', maxTokens: 8 },
    )) {
      if (chunk.type === 'status') {
        statuses.push(chunk);
        if (statuses.filter((s) => s.code === 'request_wait').length >= 4) break;
      }
    }

    const start = statuses.find((status) => status.code === 'request_start');
    expect(start, 'chat() must open with a request_start status').toBeDefined();
    expect(start!.waitPhase).toBe('headers');
    expect(start!.elapsedMs).toBe(0);

    const waits = statuses.filter((status) => status.code === 'request_wait');
    expect(waits.length, 'periodic request_wait keepalives during the no-header wait').toBeGreaterThan(1);
    expect(waits.every((w) => w.waitPhase === 'headers')).toBe(true);
    expect(waits.every((w) => typeof w.elapsedMs === 'number')).toBe(true);
    // elapsedMs must grow monotonically — the TUI keys the budget card off it
    for (let i = 1; i < waits.length; i++) {
      expect(waits[i]!.elapsedMs!).toBeGreaterThanOrEqual(waits[i - 1]!.elapsedMs!);
    }
  });

  it('escalates request_wait to warning with recovery affordance past the soft threshold', async () => {
    process.env['SHIZUHA_INTERACTIVE_TUI'] = '1';
    process.env['OLLAMA_REQUEST_STATUS_INTERVAL_MS'] = '20';
    process.env['OLLAMA_SOFT_STALL_MS'] = '50';
    mockNoHeaderChat();

    const provider = new OllamaProvider('http://ollama.test');
    const waits: Extract<StreamChunk, { type: 'status' }>[] = [];
    // Bound the pull at the first warning-level keepalive (past the threshold).
    for await (const chunk of provider.chat(
      [{ role: 'user', content: 'hi' }],
      { model: 'qa-loopback-model', maxTokens: 8 },
    )) {
      if (chunk.type === 'status' && chunk.code === 'request_wait') {
        waits.push(chunk);
        if (waits[waits.length - 1]!.level === 'warning') break;
      }
    }

    const soft = waits.find((w) => (w.elapsedMs ?? 0) >= 50);
    expect(soft, 'a keepalive at/after the soft threshold must arrive').toBeDefined();
    expect(soft!.level).toBe('warning');
    expect(soft!.message).toMatch(/Esc to cancel/);
    expect(soft!.message).toMatch(/\/model/);
    // Below the threshold the keepalive stays informational and quiet.
    const pre = waits.find((w) => (w.elapsedMs ?? 0) < 50);
    if (pre) {
      expect(pre.level).toBe('info');
      expect(pre.message).not.toMatch(/Esc to cancel/);
    }
  });

  it('SCLI-522: default interactive soft-stall threshold stays bounded at 30s', () => {
    expect(DEFAULT_INTERACTIVE_SOFT_STALL_MS).toBe(30_000);
  });
});
