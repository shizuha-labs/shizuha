/**
 * SCLI-99 / SCLI-101 — CodexProvider broker mode.
 *
 * When CODEX_BROKER_URL is set, the provider must NOT do local OAuth refresh:
 * it resolves a single "broker" account that holds NO refresh token and fetches
 * the current access token from the daemon/Hive broker endpoint instead.
 *
 * These tests exercise the broker path without a live codex lane (the fleet
 * codex/OpenAI agents are disabled pending SCLI-615), so they are the unit-level
 * half of SCLI-612's acceptance evidence.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Capture the apiKey each OpenAI client is constructed with so we can observe
// which token the account pool applies (empty at broker-account creation, the
// broker-fetched token after refreshExpiredTokens / 401 recovery).
const { capturedApiKeys } = vi.hoisted(() => ({ capturedApiKeys: [] as string[] }));

vi.mock('openai', () => {
  class MockAPIError extends Error {
    status?: number;
    headers?: Record<string, string>;
  }
  class MockOpenAI {
    static APIError = MockAPIError;
    responses = { create: vi.fn() };
    constructor(opts: unknown) {
      capturedApiKeys.push((opts as { apiKey?: string }).apiKey ?? '');
    }
  }
  return { default: MockOpenAI };
});

import { CodexProvider } from '../../src/provider/codex.js';

const BROKER_URL = 'http://daemon:8080/v1/codex/token';

describe('CodexProvider broker mode (SCLI-101 / SCLI-99)', () => {
  const originalBrokerUrl = process.env['CODEX_BROKER_URL'];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    capturedApiKeys.length = 0;
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (originalBrokerUrl === undefined) delete process.env['CODEX_BROKER_URL'];
    else process.env['CODEX_BROKER_URL'] = originalBrokerUrl;
  });

  it('resolves a single broker account holding no refresh token when CODEX_BROKER_URL is set', () => {
    process.env['CODEX_BROKER_URL'] = BROKER_URL;

    expect(CodexProvider.isAvailable()).toBe(true);
    const provider = CodexProvider.create();
    expect(provider).not.toBeNull();
    // The broker account starts with an EMPTY access token — it must never hold
    // a refresh token locally (agents fetch the access token over the endpoint).
    expect(capturedApiKeys[0]).toBe('');
  });

  it('proactive refresh fetches a fresh token from the broker and applies it to the pool client', async () => {
    process.env['CODEX_BROKER_URL'] = BROKER_URL;
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ accessToken: 'fresh-broker-token' }),
    });

    const provider = CodexProvider.create()!;
    await provider.refreshExpiredTokens();

    // The broker endpoint is the ONLY source of the token — no local OAuth refresh.
    expect(fetchMock).toHaveBeenCalledWith(BROKER_URL, expect.anything());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // refreshClient rebuilt the OpenAI client with the broker-fetched token.
    expect(capturedApiKeys).toContain('fresh-broker-token');
  });

  it('a failed broker fetch degrades gracefully (no throw; retried on next 401)', async () => {
    process.env['CODEX_BROKER_URL'] = BROKER_URL;
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const provider = CodexProvider.create()!;
    await expect(provider.refreshExpiredTokens()).resolves.toBeUndefined();
    // No token was applied; the account stays on its empty token until a 401.
    expect(capturedApiKeys).not.toContain('fresh-broker-token');
    expect(capturedApiKeys).toEqual(['']);
  });

  it('is unavailable when CODEX_BROKER_URL is unset and no local codex accounts exist', () => {
    delete process.env['CODEX_BROKER_URL'];
    delete process.env['CODEX_API_KEY'];
    // Hermetic per SCLI-601: isolate HOME so a real ~/.shizuha/credentials.json
    // or ~/.codex on the runner cannot leak accounts into this assertion.
    const originalHome = process.env['HOME'];
    const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-broker-test-'));
    process.env['HOME'] = isolatedHome;
    try {
      expect(CodexProvider.isAvailable()).toBe(false);
    } finally {
      fs.rmSync(isolatedHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = originalHome;
    }
  });
});
