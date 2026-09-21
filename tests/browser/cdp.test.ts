import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import {
  getCdpTargets,
  isCdpUsable,
  waitForCdpUsable,
} from '../../src/browser/cdp.js';

/**
 * BRW-37 regression tests for the human-mode CDP readiness gate.
 *
 * Behaviour locked:
 *   - listener absent (nothing on :port)  -> targets [], isCdpUsable=false,
 *     waitForCdpUsable=false (fast, never throws) — the "fails loudly at the
 *     gate" half of the contract (the session then throws an actionable error,
 *     not a bare ECONNREFUSED surfacing mid-tool-call).
 *   - listener present with a real page target -> isCdpUsable=true,
 *     waitForCdpUsable=true — the "launch/connect successfully" half.
 *   - listener present but wedged (no page target) -> NOT reusable; the caller
 *     must reclaim + relaunch instead of reusing it.
 */

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** A fake CDP /json responder that yields the given target list. */
function fakeCdpServer(targets: unknown[]): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(targets));
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ port, close: () => srv.close() });
    });
  });
}

describe('cdp readiness gate (BRW-37)', () => {
  it('listener absent -> empty targets, not usable, fast and non-throwing', async () => {
    const port = await freePort();
    const t0 = Date.now();
    await expect(getCdpTargets(port)).resolves.toEqual([]);
    await expect(isCdpUsable(port)).resolves.toBe(false);
    // Short timeout: the gate must fail FAST, not hang for minutes.
    await expect(waitForCdpUsable(port, 1200)).resolves.toBe(false);
    expect(Date.now() - t0).toBeLessThan(8000);
  });

  it('listener with a page target -> usable, waitForCdpUsable true', async () => {
    const fake = await fakeCdpServer([
      { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:1/devtools/page/1' },
    ]);
    try {
      await expect(isCdpUsable(fake.port)).resolves.toBe(true);
      await expect(waitForCdpUsable(fake.port, 2000)).resolves.toBe(true);
    } finally {
      fake.close();
    }
  });

  it('wedged responder (no page target) -> NOT reusable (must be reclaimed, not reused)', async () => {
    const fake = await fakeCdpServer([{ type: 'browser' }]);
    try {
      await expect(isCdpUsable(fake.port)).resolves.toBe(false);
    } finally {
      fake.close();
    }
  });

  it('malformed /json response -> treated as absent, non-throwing', async () => {
    const fake = await fakeCdpServer('not-json');
    try {
      await expect(isCdpUsable(fake.port)).resolves.toBe(false);
    } finally {
      fake.close();
    }
  });
});
