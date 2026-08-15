/**
 * Cortex requests must say WHICH PROGRAM made them.
 *
 * Operator 2026-08-06: a 24h / 471-request session ran under their own JWT
 * ("i don't remember doing any request related to this") and attributing it to
 * a process required walking /proc on the host. Cortex knew the principal and
 * the conversation; nothing identified the client.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  cortexClientHeaders,
  resetCortexClientHeadersCache,
} from '../../src/provider/cortex-client-identity.js';

beforeEach(() => {
  resetCortexClientHeadersCache();
  delete process.env['SHIZUHA_CLIENT_KIND'];
  delete process.env['TMUX_PANE'];
  delete process.env['SHIZUHA_AGENT_USERNAME'];
});

describe('cortexClientHeaders', () => {
  it('always identifies the process (kind, host, pid)', () => {
    const h = cortexClientHeaders();
    expect(h['X-Cortex-Client']).toBeTruthy();
    expect(h['X-Cortex-Client']).toContain(`pid=${process.pid}`);
    expect(h['X-Cortex-Client-Pid']).toBe(String(process.pid));
    expect(h['X-Cortex-Client-Host']).toBeTruthy();
    expect(h['X-Cortex-Client-Kind']).toBeTruthy();
  });

  it('carries the tmux pane so a human can find the terminal', () => {
    process.env['TMUX_PANE'] = '%42';
    resetCortexClientHeadersCache();
    expect(cortexClientHeaders()['X-Cortex-Client']).toContain('tmux=%42');
  });

  it('carries the agent username for fleet gateways', () => {
    process.env['SHIZUHA_AGENT_USERNAME'] = 'ren';
    resetCortexClientHeadersCache();
    expect(cortexClientHeaders()['X-Cortex-Client']).toContain('agent=ren');
  });

  it('honours an explicit kind override', () => {
    process.env['SHIZUHA_CLIENT_KIND'] = 'bench-harness';
    resetCortexClientHeadersCache();
    expect(cortexClientHeaders()['X-Cortex-Client-Kind']).toBe('bench-harness');
  });

  it('never emits header-breaking characters', () => {
    process.env['SHIZUHA_CLIENT_KIND'] = 'evil\r\nX-Injected: 1';
    resetCortexClientHeadersCache();
    const h = cortexClientHeaders();
    for (const value of Object.values(h)) {
      expect(value).not.toMatch(/[\r\n]/);
      expect(value.length).toBeLessThanOrEqual(200);
    }
  });

  it('gives two processes distinct instance ids', () => {
    const a = cortexClientHeaders()['X-Cortex-Client-Instance'];
    expect(a).toContain(String(process.pid));
  });
});

describe('vllm provider wiring', () => {
  it('sends the client headers on every Cortex request', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/provider/vllm.ts', import.meta.url), 'utf8');
    // Pinned as source structure: the headers object is built once per request
    // loop, so a refactor that drops this line silently un-attributes traffic.
    expect(src).toContain('Object.assign(headers, cortexClientHeaders())');
  });
});
