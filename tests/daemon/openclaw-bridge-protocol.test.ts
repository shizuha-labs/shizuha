/**
 * Regression tests for SCLI-420: the SCLI embedded OpenClaw gateway client must
 * negotiate the current gateway protocol (v4) — the previous maxProtocol=3 was
 * rejected by the packaged v4 gateway with a raw stack and no bridge listener.
 *
 * Covers:
 *  - the client protocol constant (the core compatibility fix),
 *  - protocol-mismatch detection + the concise actionable diagnostic,
 *  - the actual `connect` frame sent by the bridge (min/maxProtocol = 4),
 *  - the startup error path (concise diagnostic, no raw stack, clean exit).
 *
 * The gateway protocol version is a hard contract between the embedded bridge
 * client and the packaged OpenClaw gateway: bumping GATEWAY_PROTOCOL_VERSION
 * here must stay in lockstep with the gateway binary shipped in the runtime
 * image, or the handshake is rejected and the bridge runs without a listener.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Mock `ws` BEFORE importing the bridge module ──
// vi.mock factories are hoisted above imports, so the mock class and the
// instance registry must be created via vi.hoisted.
const { MockWebSocket, wsInstances } = vi.hoisted(() => {
  type WsHandler = (data: unknown) => void;
  class MockWebSocket {
    static OPEN = 1;
    readyState = 1;
    private handlers: Record<string, WsHandler[]> = {};
    sent: string[] = [];
    constructor(public url: string) {
      wsInstances.push(this);
    }
    on(event: string, cb: WsHandler): this {
      (this.handlers[event] ??= []).push(cb);
      return this;
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {}
    emit(event: string, data: unknown): void {
      for (const cb of this.handlers[event] ?? []) cb(data);
    }
  }
  const wsInstances: MockWebSocket[] = [];
  return { MockWebSocket, wsInstances };
});

vi.mock('ws', () => ({
  WebSocket: MockWebSocket,
  WebSocketServer: class {},
}));

import {
  OpenClawBridge,
  GATEWAY_PROTOCOL_VERSION,
  isProtocolMismatchError,
  buildProtocolMismatchDiagnostic,
  startOpenClawBridge,
} from '../../src/openclaw-bridge/index.js';

function makeTempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scli420-bridge-'));
}

describe('SCLI-420 openclaw-bridge protocol compatibility', () => {
  afterEach(() => {
    wsInstances.length = 0;
    vi.restoreAllMocks();
  });

  it('negotiates the current gateway protocol (v4) as an operator/backend client', () => {
    expect(GATEWAY_PROTOCOL_VERSION).toBe(4);
  });

  it('detects protocol-mismatch error messages', () => {
    expect(isProtocolMismatchError('protocol mismatch: client=gateway-client min=1 max=3 expected=4')).toBe(true);
    expect(isProtocolMismatchError('protocol mismatch ... min=1 max=3 expected=4')).toBe(true);
    expect(isProtocolMismatchError('expected=4')).toBe(true);
    expect(isProtocolMismatchError('unknown gateway error')).toBe(false);
    expect(isProtocolMismatchError(null)).toBe(false);
    expect(isProtocolMismatchError(undefined)).toBe(false);
  });

  it('builds a concise actionable diagnostic naming client and gateway ranges', () => {
    const diag = buildProtocolMismatchDiagnostic(
      'protocol mismatch: client=gateway-client min=1 max=3 expected=4',
    );
    expect(diag).toContain('client 1–3');
    expect(diag).toContain('gateway requires 4');
    expect(diag).toContain('GATEWAY_PROTOCOL_VERSION=4');
    // One concise line — no raw stack / bundle path.
    expect(diag.split('\n').length).toBe(1);
    expect(diag).not.toMatch(/shizuha\.js:\d+/);
    expect(diag).not.toMatch(/at \w+ \(/);
  });

  it('sends a connect frame with min/maxProtocol = 4 (the core SCLI-420 fix)', async () => {
    const cwd = makeTempCwd();
    const bridge = new OpenClawBridge({ port: 8021, host: '127.0.0.1', model: 'gpt-5.5', cwd });

    const connectPromise = (bridge as unknown as { connectToGateway(): Promise<void> }).connectToGateway();

    const ws = wsInstances[0];
    expect(ws).toBeDefined();
    ws.emit('open', undefined);

    // Gateway sends the pre-connect challenge → bridge replies with connect.
    ws.emit('message', JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'test-nonce', ts: Date.now() },
    }));

    const connectFrame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.method === 'connect');
    expect(connectFrame).toBeDefined();
    expect(connectFrame.params.minProtocol).toBe(4);
    expect(connectFrame.params.maxProtocol).toBe(4);
    expect(connectFrame.params.client.id).toBe('gateway-client');
    expect(connectFrame.params.client.mode).toBe('backend');

    // Complete the handshake so the promise settles.
    ws.emit('message', JSON.stringify({
      type: 'res',
      id: connectFrame.id,
      ok: true,
      payload: { type: 'hello-ok', protocol: 4 },
    }));

    await expect(connectPromise).resolves.toBeUndefined();
  });

  it('rejects the handshake with a concise diagnostic on protocol mismatch (no raw stack)', async () => {
    const cwd = makeTempCwd();
    const bridge = new OpenClawBridge({ port: 8021, host: '127.0.0.1', model: 'gpt-5.5', cwd });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const connectPromise = (bridge as unknown as { connectToGateway(): Promise<void> }).connectToGateway();
    const ws = wsInstances[0];
    ws.emit('open', undefined);
    ws.emit('message', JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'test-nonce', ts: Date.now() },
    }));

    const connectFrame = ws.sent.map((s) => JSON.parse(s)).find((f) => f.method === 'connect');
    ws.emit('message', JSON.stringify({
      type: 'res',
      id: connectFrame.id,
      ok: false,
      error: { code: 'PROTOCOL_MISMATCH', message: 'protocol mismatch: client=gateway-client min=1 max=3 expected=4' },
    }));

    await expect(connectPromise).rejects.toThrow(/OpenClaw protocol mismatch/);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('OpenClaw protocol mismatch');
    expect(logged).toContain('gateway requires 4');
  });

  it('startOpenClawBridge emits a concise diagnostic and exits non-zero on protocol mismatch', async () => {
    const cwd = makeTempCwd();
    vi.spyOn(OpenClawBridge.prototype, 'start').mockRejectedValue(
      new Error('protocol mismatch: client=gateway-client min=1 max=3 expected=4'),
    );
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(
      startOpenClawBridge({ port: 8021, host: '127.0.0.1', model: 'gpt-5.5', cwd }),
    ).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(logged).toContain('OpenClaw protocol mismatch');
    expect(logged).toContain('gateway requires 4');
    // No raw stack / bundle path in the emitted diagnostic.
    expect(logged).not.toMatch(/shizuha\.js:\d+/);
  });
});
