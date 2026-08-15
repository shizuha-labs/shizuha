import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getActiveClaudeToken, readCredentials, writeCredentials } from '../../src/config/credentials.js';

function iso(ms: number): string { return new Date(Date.now() + ms).toISOString(); }

describe('Claude stale cooldown self-recovery (PLAT-1193)', () => {
  let tmp: string;
  let oldHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cooldown-'));
    oldHome = process.env['HOME'];
    process.env['HOME'] = tmp;
    fs.mkdirSync(path.join(tmp, '.shizuha'), { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (oldHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('probes stale cooled tokens when the usable pool is down to one and clears on 200', async () => {
    const staleStamp = iso(-20 * 60_000);
    writeCredentials({ anthropic: { tokens: [
      { label: 'token_6', token: 'fresh-token', addedAt: iso(-60_000), priority: 2 },
      { label: 'token_1', token: 'cooled-token', addedAt: iso(-60_000), priority: 1, cooldownUntil: iso(24 * 60 * 60_000), lastRateLimitAt: staleStamp },
    ] } });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const picked = getActiveClaudeToken();
    expect(picked?.label).toBe('token_6'); // current call is non-blocking; next call sees recovered token.

    await vi.waitFor(() => {
      const cooled = readCredentials().anthropic?.tokens.find(t => t.label === 'token_1');
      expect(cooled?.cooldownUntil).toBeUndefined();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(fetchMock.mock.calls[0]?.[1])).toContain('max_tokens');
  });

  it('does not probe fresh cooldowns', () => {
    writeCredentials({ anthropic: { tokens: [
      { label: 'token_6', token: 'fresh-token', addedAt: iso(-60_000), priority: 2 },
      { label: 'token_1', token: 'cooled-token', addedAt: iso(-60_000), priority: 1, cooldownUntil: iso(24 * 60 * 60_000), lastRateLimitAt: iso(-5 * 60_000) },
    ] } });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(getActiveClaudeToken()?.label).toBe('token_6');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readCredentials().anthropic?.tokens.find(t => t.label === 'token_1')?.cooldownUntil).toBeTruthy();
  });

  it('caps stale cooldown probes to once per token per 30 minutes', () => {
    writeCredentials({ anthropic: { tokens: [
      { label: 'token_6', token: 'fresh-token', addedAt: iso(-60_000), priority: 2 },
      { label: 'token_1', token: 'cooled-token', addedAt: iso(-60_000), priority: 1, cooldownUntil: iso(24 * 60 * 60_000), lastRateLimitAt: iso(-20 * 60_000), lastCooldownProbeAt: iso(-10 * 60_000) },
    ] } });
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    expect(getActiveClaudeToken()?.label).toBe('token_6');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
