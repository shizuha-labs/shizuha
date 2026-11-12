/**
 * PLAT-4649 — undici multi-advisory pin (GHSA-2mjp / 35p6 / 4992 / f269 /
 * g8m3 / p88m / v9p9 / vrm6 / vxpw)
 *
 * Consumer-boundary regression (verify-before-push): real consumers are
 * @vercel/blob (via javascript-obfuscator → undici 6.x) and jsdom (dev →
 * undici 7.x). Coverage crosses those packages' public require graphs
 * rather than only importing the leaf, asserts both major lines stay on
 * their patched floors (6.27.0+ / 7.28.0+), and exercises the real
 * request/fragmentation paths with deterministic local-server fixtures.
 */
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

function parseSemver(version: string): [number, number, number] {
  const [major, minor, patch] = version.split('.').map((part) => Number(part));
  return [major, minor, patch];
}

function gte(version: string, minimum: string): boolean {
  const [aMaj, aMin, aPat] = parseSemver(version);
  const [bMaj, bMin, bPat] = parseSemver(minimum);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat >= bPat;
}

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

describe('undici security regression (PLAT-4649)', () => {
  it('pins patched undici lines for named consumers', () => {
    // Named consumers that pull undici transitively.
    // @vercel/blob blocks package.json via exports — resolve the entry instead.
    const blobEntry = require.resolve('@vercel/blob');
    const jsdomEntry = require.resolve('jsdom');
    expect(blobEntry).toBeTruthy();
    expect(jsdomEntry).toBeTruthy();

    // Resolved installs under each consumer's require paths.
    const blobUndici = require(
      require.resolve('undici/package.json', { paths: [blobEntry] }),
    ) as { version: string };
    const jsdomUndici = require(
      require.resolve('undici/package.json', { paths: [jsdomEntry] }),
    ) as { version: string };

    expect(gte(blobUndici.version, '6.27.0')).toBe(true);
    expect(blobUndici.version.startsWith('6.')).toBe(true);
    expect(gte(jsdomUndici.version, '7.28.0')).toBe(true);
    expect(jsdomUndici.version.startsWith('7.')).toBe(true);
  });

  it('@vercel/blob public API loads through patched undici 6.x', async () => {
    // Consumer boundary: javascript-obfuscator → @vercel/blob → undici.
    const blob = await import('@vercel/blob');
    expect(typeof blob.put).toBe('function');
    expect(typeof blob.list).toBe('function');
    // Happy-path identity: package exports remain callable functions.
    expect(blob.put.name).toBeTruthy();
  });

  it('jsdom public API loads through patched undici 7.x', async () => {
    // Consumer boundary: jsdom (test DOM) → undici for resource loading.
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><p>plat-4649</p>', {
      url: 'https://example.test/',
    });
    expect(dom.window.document.querySelector('p')?.textContent).toBe('plat-4649');
  });

  it('@vercel/blob-resolved undici 6.x performs a real HTTP round-trip and rejects header-smuggling payloads', async () => {
    // Consumer boundary: @vercel/blob's own require graph → undici 6.x client.
    const blobEntry = require.resolve('@vercel/blob');
    const undici6 = require(
      require.resolve('undici', { paths: [blobEntry] }),
    ) as {
      request: (url: string, opts?: object) => Promise<{ statusCode: number; body: { text: () => Promise<string> } }>;
    };

    const seenPaths: string[] = [];
    const server = createServer((req, res) => {
      seenPaths.push(req.url ?? '');
      res.end('ok-plat-4649');
    });
    const port = await listen(server);
    try {
      // Normal case: a real request/response round-trip through undici 6.x.
      const res = await undici6.request(`http://127.0.0.1:${port}/blob-boundary`);
      expect(res.statusCode).toBe(200);
      expect(await res.body.text()).toBe('ok-plat-4649');

      // Malformed case: CRLF in a header value is the request-smuggling edge —
      // undici must reject it client-side; the server must never see it.
      let rejected = false;
      try {
        await undici6.request(`http://127.0.0.1:${port}/smuggle`, {
          headers: { 'x-inject': 'a\r\nX-Evil: 1' },
        });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(seenPaths).toEqual(['/blob-boundary']);
    } finally {
      server.close();
    }
  });

  it('jsdom loads a real resource from a local server through its patched undici 7.x', async () => {
    // Consumer boundary: jsdom resource loading fetches an external script over
    // HTTP and executes it — the exact path jsdom routes through undici 7.x.
    const jsdomEntry = require.resolve('jsdom');
    const jsdomUndici = require(
      require.resolve('undici/package.json', { paths: [jsdomEntry] }),
    ) as { version: string };
    expect(gte(jsdomUndici.version, '7.28.0')).toBe(true);

    const server = createServer((req, res) => {
      res.setHeader('content-type', 'text/javascript');
      res.end('window.__plat4649 = "loaded";');
    });
    const port = await listen(server);
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM('<!doctype html><script src="/inject.js"></script>', {
      url: `http://127.0.0.1:${port}/`,
      resources: 'usable',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
    });
    try {
      const flag = await new Promise<unknown>((resolve, reject) => {
        const started = Date.now();
        const timer = setInterval(() => {
          const value = (dom.window as unknown as Record<string, unknown>)['__plat4649'];
          if (value !== undefined) {
            clearInterval(timer);
            resolve(value);
          } else if (Date.now() - started > 5000) {
            clearInterval(timer);
            reject(new Error('jsdom resource load did not complete within 5s'));
          }
        }, 50);
      });
      expect(flag).toBe('loaded');
    } finally {
      dom.window.close();
      server.close();
    }
  });

  it('undici 7 WebSocket (jsdom resolve) reassembles fragmented server frames', async () => {
    // Consumer boundary: undici 7.x WebSocket as resolved from jsdom's require
    // graph. A raw deterministic server delivers one text message split across
    // a FIN=0 text frame and a FIN=1 continuation frame — the fragmentation
    // regression class from the pinned advisories.
    const jsdomEntry = require.resolve('jsdom');
    const undici7 = require(
      require.resolve('undici', { paths: [jsdomEntry] }),
    ) as { WebSocket: new (url: string) => WebSocketLike };

    const payload = 'fragmented-plat-4649-payload';
    const server = createServer();
    server.on('upgrade', (req, socket) => {
      const key = String(req.headers['sec-websocket-key'] ?? '');
      const accept = createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const mid = Buffer.from(payload.slice(0, 10), 'utf8');
      const rest = Buffer.from(payload.slice(10), 'utf8');
      // Fragment 1: FIN=0, opcode 1 (text), unmasked server frame.
      socket.write(Buffer.concat([Buffer.from([0x01, mid.length]), mid]));
      // Fragment 2: FIN=1, opcode 0 (continuation).
      socket.write(Buffer.concat([Buffer.from([0x80, rest.length]), rest]));
    });
    const port = await listen(server);
    try {
      const ws = new undici7.WebSocket(`ws://127.0.0.1:${port}/`);
      const received = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('fragmented message timeout')), 5000);
        ws.onmessage = (ev: { data: unknown }) => {
          clearTimeout(timer);
          resolve(String(ev.data));
        };
        ws.onerror = () => {
          clearTimeout(timer);
          reject(new Error('websocket error before fragmented frame delivery'));
        };
      });
      expect(received).toBe(payload);
      ws.close();
    } finally {
      server.close();
    }
  });
});
