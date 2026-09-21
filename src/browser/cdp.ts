/**
 * Minimal CDP (Chrome DevTools Protocol) readiness helpers for the
 * human-mode browser session.
 *
 * BRW-37 regression: `HumanBrowserSession.start()` waited a *fixed* 3000ms
 * after spawning Chrome and then connected mouse/keyboard to
 * `127.0.0.1:9222` unconditionally. When Chrome had not bound CDP in that
 * window (cold start, first-profile creation, Xvfb contention, a wedged
 * leftover occupying the fixed port), the raw `net.createConnection` threw
 * `connect ECONNREFUSED 127.0.0.1:9222` and the whole human-mode tool call
 * failed with no retry, no relaunch, and no actionable ownership evidence.
 *
 * These helpers make the launch contract robust:
 *   - `waitForCdpUsable` polls until a real page target with a
 *     `webSocketDebuggerUrl` is reachable (instead of a blind sleep).
 *   - `reclaimCdpPort` clears a stale/wedged Chrome bound to our profile+port
 *     and its profile singletons so a fresh launch can bind the fixed port.
 *   - failures surface loudly (the caller throws with ownership evidence)
 *     rather than a bare Node ECONNREFUSED.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

export interface CdpTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

export const CDP_READY_TIMEOUT_MS = 20_000;
export const CDP_POLL_INTERVAL_MS = 500;
export const CDP_REQUEST_TIMEOUT_MS = 1_500;
export const PORT_RELEASE_WAIT_MS = 2_000;

/**
 * GET http://127.0.0.1:<port>/json and return the target list.
 * Never throws: a port with no listener (or a half-open/wedged responder)
 * yields `[]` so callers can distinguish "not ready" from a hard error.
 */
export async function getCdpTargets(cdpPort: number): Promise<CdpTarget[]> {
  const http = await import('node:http');
  return new Promise<CdpTarget[]>((resolve) => {
    const req = http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data) as unknown;
          resolve(Array.isArray(parsed) ? (parsed as CdpTarget[]) : []);
        } catch {
          resolve([]);
        }
      });
    });
    req.on('error', () => resolve([]));
    req.setTimeout(CDP_REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      resolve([]);
    });
  });
}

/** True when at least one page target exposes a usable WebSocket debug URL. */
export async function isCdpUsable(cdpPort: number): Promise<boolean> {
  const targets = await getCdpTargets(cdpPort);
  return targets.some((t) => t.type === 'page' && !!t.webSocketDebuggerUrl);
}

/**
 * Poll until a usable page target is reachable on cdpPort or the deadline
 * passes. Returns true only when Chrome's CDP is genuinely usable — this is
 * the gate that replaces the old fixed-sleep before CDP is connected.
 */
export async function waitForCdpUsable(
  cdpPort: number,
  timeoutMs: number = CDP_READY_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpUsable(cdpPort)) return true;
    await new Promise((r) => setTimeout(r, CDP_POLL_INTERVAL_MS));
  }
  return isCdpUsable(cdpPort);
}

/**
 * Clear anything currently bound to our profile+port so a fresh Chrome launch
 * can bind the fixed CDP port. Only matches Chrome processes whose
 * `--user-data-dir` equals `profileDir` and whose `--remote-debugging-port`
 * equals `cdpPort` — a Chrome started by the agent with a different profile is
 * left alone. Profile singleton locks are then cleared (Chrome refuses to
 * start otherwise when the previous owner was killed hard).
 */
export async function reclaimCdpPort(
  profileDir: string,
  cdpPort: number,
): Promise<void> {
  const marker = `--remote-debugging-port=${cdpPort} --remote-debugging-address=127.0.0.1 --user-data-dir=${profileDir}`;
  try {
    execSync(`pkill -9 -f ${JSON.stringify(marker)} 2>/dev/null || true`, {
      stdio: 'ignore',
    });
  } catch {
    /* none matched — fine */
  }
  for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try {
      fs.unlinkSync(path.join(profileDir, lock));
    } catch {
      /* absent or already gone */
    }
  }
  // Give the port a moment to actually release before a fresh bind.
  await new Promise((r) => setTimeout(r, PORT_RELEASE_WAIT_MS));
}
