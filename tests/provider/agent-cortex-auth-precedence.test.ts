/**
 * An AGENT must never bill Cortex to the human's identity.
 *
 * Operator 2026-08-06: an unattributable `uid:3 — standard` row on the Usage
 * page ("i haven't touched the tmux session for hours .. so i don't think
 * that's me"). It was a fleet agent's gateway respawning on the operator's
 * host: resolveCortexAuthToken prefers the signed-in JWT from
 * ~/.shizuha/auth.json, which a host-run gateway reads too — so its 220K-token
 * prewarms billed to uid 3 instead of the agent's own sk-cortex key. Same
 * directive as the shared fleet-key fix: every agent uses its OWN account.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCortexAuthToken } from '../../src/provider/registry.js';

const ORIGINAL_ARGV = process.argv;

beforeEach(() => {
  process.env['CORTEX_API_KEY'] = 'sk-cortex-agent-own';
  delete process.env['CORTEX_OAUTH_TOKEN'];
  delete process.env['SHIZUHA_AGENT_USERNAME'];
  delete process.env['SHIZUHA_CORTEX_AUTH_MODE'];
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  delete process.env['CORTEX_API_KEY'];
  delete process.env['SHIZUHA_AGENT_USERNAME'];
});

describe('agent runtimes use their own Cortex key', () => {
  it('a gateway launched with --agent-id uses the agent key', () => {
    process.argv = ['node', '/opt/shizuha/dist/shizuha.js', 'gateway', '--agent-id', 'abc', '--agent-name', 'Fumi'];
    expect(resolveCortexAuthToken()).toBe('sk-cortex-agent-own');
  });

  it('the bare `gateway` subcommand also counts as an agent runtime', () => {
    process.argv = ['node', 'shizuha.js', 'gateway'];
    expect(resolveCortexAuthToken()).toBe('sk-cortex-agent-own');
  });

  it('--agent-id=value form is detected too', () => {
    process.argv = ['node', 'shizuha.js', 'gateway', '--agent-id=abc'];
    expect(resolveCortexAuthToken()).toBe('sk-cortex-agent-own');
  });

  it('agent env markers work when argv is unavailable', () => {
    process.argv = ['node', 'shizuha.js'];
    process.env['SHIZUHA_AGENT_USERNAME'] = 'fumi';
    expect(resolveCortexAuthToken()).toBe('sk-cortex-agent-own');
  });

  it('an interactive TUI is NOT treated as an agent runtime', () => {
    // The human path must keep preferring the signed-in identity, so this
    // only asserts the agent short-circuit did not fire (no key forced).
    process.argv = ['node', 'shizuha.js'];
    process.env['CORTEX_OAUTH_TOKEN'] = 'jwt-human';
    expect(resolveCortexAuthToken()).toBe('jwt-human');
  });
});
