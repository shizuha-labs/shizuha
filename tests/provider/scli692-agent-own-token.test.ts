/**
 * SCLI-692 — `shizuha exec` one-shot broken on agent seats.
 *
 * Finding 1: the Gemini-style API rejects `additionalProperties` in function
 * declarations (400 "Unknown name ... Cannot find field" for every tool) —
 * the Google provider must strip the unsupported keyword recursively before
 * sending internal tool schemas.
 *
 * Finding 2: the pod-level CORTEX_API_KEY lives in the runtime's (PID 1)
 * environment and is NOT propagated to tool subprocesses, so an exec one-shot
 * spawned from an agent tool context went out unauthenticated (vLLM 401).
 * `resolveCortexAuthToken` must fall back to the seat's OWN agent identity
 * token file (`~/.shizuha/auth/token-<username>.json`) — never the human's
 * auth.json (the agent-cortex-auth-precedence directive).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readAgentOwnToken, resolveCortexAuthToken } from '../../src/provider/registry.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_HOME = process.env['HOME'];

beforeEach(() => {
  delete process.env['CORTEX_API_KEY'];
  delete process.env['CORTEX_API_KEY_SHARED_FALLBACK'];
  delete process.env['CORTEX_OAUTH_TOKEN'];
  delete process.env['SHIZUHA_AGENT_USERNAME'];
  delete process.env['SHIZUHA_AGENT_ID'];
  delete process.env['SHIZUHA_K8S_PRIMARY_MODEL'];
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  if (ORIGINAL_HOME) process.env['HOME'] = ORIGINAL_HOME;
});

describe('SCLI-692 Finding 2 — agent own-token fallback', () => {
  it('reads the seat own token file when CORTEX_API_KEY is absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli692-auth-'));
    process.env['HOME'] = dir;
    process.env['SHIZUHA_AGENT_USERNAME'] = 'nagi';
    const future = new Date(Date.now() + 3600_000).toISOString();
    fs.mkdirSync(path.join(dir, '.shizuha', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.shizuha', 'auth', 'token-nagi.json'),
      JSON.stringify({ accessToken: 'eyJ-agent-own-token', expiresAt: future }),
    );
    expect(readAgentOwnToken()).toBe('eyJ-agent-own-token');
    // And the agent runtime path resolves through it.
    process.env['SHIZUHA_AGENT_ID'] = '669b';
    expect(resolveCortexAuthToken()).toBe('eyJ-agent-own-token');
  });

  it('falls back to legacy token-agent.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli692-auth-'));
    process.env['HOME'] = dir;
    const future = new Date(Date.now() + 3600_000).toISOString();
    fs.mkdirSync(path.join(dir, '.shizuha', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.shizuha', 'auth', 'token-agent.json'),
      JSON.stringify({ accessToken: 'legacy-agent-token', expiresAt: future }),
    );
    expect(readAgentOwnToken()).toBe('legacy-agent-token');
  });

  it('never returns an expired token', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli692-auth-'));
    process.env['HOME'] = dir;
    const past = new Date(Date.now() - 60_000).toISOString();
    fs.mkdirSync(path.join(dir, '.shizuha', 'auth'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.shizuha', 'auth', 'token-agent.json'),
      JSON.stringify({ accessToken: 'stale-token', expiresAt: past }),
    );
    expect(readAgentOwnToken()).toBeUndefined();
  });

  it('never borrows the human auth.json (agent precedence directive)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scli692-auth-'));
    process.env['HOME'] = dir;
    const future = new Date(Date.now() + 3600_000).toISOString();
    fs.mkdirSync(path.join(dir, '.shizuha', 'auth'), { recursive: true });
    // The human's auth.json sits at ~/.shizuha/auth.json — NOT in auth/.
    fs.writeFileSync(
      path.join(dir, '.shizuha', 'auth.json'),
      JSON.stringify({ accessToken: 'human-jwt', refreshToken: 'r', username: 'operator' }),
    );
    // No agent token file present.
    expect(readAgentOwnToken()).toBeUndefined();
    process.env['SHIZUHA_AGENT_ID'] = '669b';
    expect(resolveCortexAuthToken()).toBeUndefined();
  });
});
