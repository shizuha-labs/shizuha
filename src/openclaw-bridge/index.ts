/**
 * OpenClaw Bridge — runs the full OpenClaw gateway inside the container and
 * bridges its streaming WS protocol to the Shizuha dashboard WS protocol.
 *
 * Architecture:
 *   1. Starts `openclaw gateway` as a background process (port 18789, auth=none)
 *   2. Connects to the gateway via its WS protocol (challenge → connect → hello)
 *   3. For each dashboard message, sends an `agent` request to the gateway
 *   4. Streams gateway events (assistant text, tool calls, lifecycle) → dashboard
 *
 * This gives us: real-time streaming, cron/reminders, skills, memory, and the
 * full OpenClaw agent runtime — all self-contained inside the container.
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCodexAccounts } from '../config/credentials.js';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
// @ts-ignore — ws has no declaration file
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import { StateStore } from '../state/store.js';
import { buildSyncHistoryMessages } from '../state/sync-history.js';

// ── Types ──

interface OpenClawBridgeOptions {
  port: number;
  host: string;
  model: string;
  agentId?: string;
  agentName?: string;
  agentUsername?: string;
  reasoningEffort?: string;
  thinkingLevel?: string;
  contextPrompt?: string;
  cwd?: string;
}

interface WsClient {
  ws: WebSocket;
  userId: string;
  activeThreadId: string | null;
}

function isBridgePromptDebugEnabled(): boolean {
  return process.env['SHIZUHA_DEBUG_BRIDGE_PROMPTS'] === '1';
}

function summarizePromptForLog(prompt: string | null | undefined): Record<string, unknown> {
  const trimmed = prompt?.trim() ?? '';
  return {
    present: trimmed.length > 0,
    length: trimmed.length,
    hasIdentityHeader: trimmed.includes('## Shizuha Agent Identity'),
    firstLine: trimmed.split('\n')[0] ?? '',
  };
}

export function buildOpenClawAgentParams(params: {
  message: string;
  threadId: string;
  thinkingLevel?: string;
  contextPrompt?: string;
}): Record<string, unknown> {
  const request: Record<string, unknown> = {
    message: params.message,
    idempotencyKey: params.threadId,
    sessionKey: 'agent:main:main',
    timeout: 600_000,
  };
  if (params.thinkingLevel) request['thinking'] = params.thinkingLevel;
  const extraSystemPrompt = params.contextPrompt?.trim();
  if (extraSystemPrompt) request['extraSystemPrompt'] = extraSystemPrompt;
  return request;
}

const GATEWAY_PORT = 18789;
const GATEWAY_PASSWORD = 'shizuha-bridge-internal';

// ── Device identity for gateway handshake ──
// The gateway requires a signed device identity to grant scopes (operator.write).
// Generate a stable Ed25519 key pair once per bridge instance.
function generateDeviceIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519' as any);
  const publicKeyPem = (publicKey as any).export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = (privateKey as any).export({ type: 'pkcs8', format: 'pem' }).toString();
  // Raw public key: strip 12-byte Ed25519 SPKI prefix from DER encoding
  const spkiDer = (publicKey as any).export({ type: 'spki', format: 'der' }) as Buffer;
  const rawKey = spkiDer.subarray(12);
  // Device ID: sha256 hex of raw public key bytes
  const deviceId = crypto.createHash('sha256').update(rawKey).digest('hex');
  return { deviceId, publicKeyPem, privateKeyPem };
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  const key = crypto.createPublicKey(publicKeyPem);
  const spkiDer = key.export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = spkiDer.subarray(12);
  return raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

// ── Bridge ──

export class OpenClawBridge {
  private app: FastifyInstance | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WsClient>();
  private sessionId = '';
  private startTime = Date.now();

  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private turnCount = 0;

  private activeThreadId: string | null = null;
  private activeRunId: string | null = null;
  private activeMessageId: string | null = null;
  private openclawPath = '';

  private messageQueue: Array<{ clientId: string; content: string }> = [];

  private store: StateStore;
  private accumulatedContent = '';
  private lastStreamedContent = ''; // Tracks last streamed response to dedup chat:final echoes

  // Gateway process + WS connection
  private gatewayProcess: ChildProcess | null = null;
  private gatewayWs: WebSocket | null = null;
  private gatewayConnected = false;
  private pendingRequests = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private deviceIdentity: ReturnType<typeof generateDeviceIdentity>;

  constructor(private opts: OpenClawBridgeOptions) {
    this.sessionId = `openclaw-bridge-${opts.agentId ?? 'default'}`;
    const workDir = opts.cwd ?? '/workspace';
    this.store = new StateStore(path.join(workDir, '.openclaw-state.db'));

    // Load or generate persistent device identity (survives container restarts
    // via mounted workspace volume, avoids "device identity mismatch" errors)
    const identityPath = path.join(workDir, '.openclaw-device-identity.json');
    try {
      if (fs.existsSync(identityPath)) {
        this.deviceIdentity = JSON.parse(fs.readFileSync(identityPath, 'utf-8'));
      } else {
        this.deviceIdentity = generateDeviceIdentity();
        fs.writeFileSync(identityPath, JSON.stringify(this.deviceIdentity, null, 2), { mode: 0o600 });
      }
    } catch {
      this.deviceIdentity = generateDeviceIdentity();
      try { fs.writeFileSync(identityPath, JSON.stringify(this.deviceIdentity, null, 2), { mode: 0o600 }); } catch { /* */ }
    }

    const existing = this.store.loadSession(this.sessionId);
    if (existing) {
      this.totalInputTokens = existing.totalInputTokens;
      this.totalOutputTokens = existing.totalOutputTokens;
      this.turnCount = existing.turnCount;
      console.log(`[openclaw-bridge] Resumed session: ${existing.messages.length} messages, ${this.turnCount} turns`);
    } else {
      this.store.createSessionWithId(this.sessionId, opts.model, workDir);
      console.log(`[openclaw-bridge] Created new session: ${this.sessionId}`);
    }
  }

  async start(): Promise<void> {
    this.openclawPath = await this.findOpenClawCli();
    console.log(`[openclaw-bridge] Found openclaw CLI at: ${this.openclawPath}`);

    await this.ensureAuth();
    await this.startGateway();
    await this.connectToGateway();
    await this.startServer();
    // Proactive delivery: OpenClaw channel plugin POSTs to /v1/proactive (no file watcher needed)

    console.log(`OpenClaw bridge listening on ${this.opts.host}:${this.opts.port}`);
    console.log(JSON.stringify({
      level: 30,
      time: Date.now(),
      pid: process.pid,
      hostname: os.hostname(),
      model: this.opts.model,
      sessionId: this.sessionId,
      msg: 'OpenClaw bridge initialized',
    }));
  }

  // ── Gateway lifecycle ──

  private async startGateway(): Promise<void> {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');

    const env = {
      ...process.env,
      HOME: homeDir,
      USER: isRoot ? 'agent' : (process.env['USER'] ?? 'agent'),
      OPENCLAW_STATE_DIR: path.join(homeDir, '.openclaw'),
      // Newer OpenClaw builds require an auth token for extension relay traffic
      // even when the gateway itself is started in password mode.
      OPENCLAW_GATEWAY_TOKEN: GATEWAY_PASSWORD,
      // Clear proxy — gateway makes direct API calls
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      https_proxy: '',
      http_proxy: '',
      no_proxy: '*',
    };

    const args = [
      'gateway',
      '--auth', 'password',
      '--password', GATEWAY_PASSWORD,
      '--port', String(GATEWAY_PORT),
      '--bind', 'loopback',
      '--allow-unconfigured',
    ];

    const spawnCmd = isRoot ? 'runuser' : this.openclawPath;
    const spawnArgs = isRoot ? ['-u', 'agent', '--', this.openclawPath, ...args] : args;

    // Clear old device pairings to avoid "device identity mismatch" errors.
    const openclawDir = path.join(homeDir, '.openclaw');
    const deviceStorePath = path.join(openclawDir, 'devices.json');
    try { if (fs.existsSync(deviceStorePath)) fs.unlinkSync(deviceStorePath); } catch { /* */ }

    // Install shizuha-dashboard channel plugin so cron/heartbeat messages
    // get delivered to our bridge via the outbox file.
    const pluginDir = path.join(openclawDir, 'extensions', 'shizuha-dashboard');
    if (!fs.existsSync(pluginDir)) {
      fs.mkdirSync(pluginDir, { recursive: true });
      // Minimal channel plugin — writes outbound messages to JSONL file
      fs.writeFileSync(path.join(pluginDir, 'openclaw.plugin.json'), JSON.stringify({
        id: 'shizuha-dashboard',
        channels: ['shizuha-dashboard'],
        configSchema: { type: 'object', additionalProperties: false, properties: {} },
      }));
      fs.writeFileSync(path.join(pluginDir, 'package.json'), JSON.stringify({
        name: '@openclaw/plugin-shizuha-dashboard',
        version: '0.1.0',
        type: 'module',
        main: 'index.js',
      }));
      // The plugin POSTs to the bridge's /v1/proactive endpoint for instant delivery
      const bridgePort = this.opts.port;
      fs.writeFileSync(path.join(pluginDir, 'index.js'), `
import * as http from "node:http";
const BRIDGE_PORT = ${bridgePort};
function postToBridge(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ text, type: "cron" });
    const req = http.request({
      hostname: "127.0.0.1", port: BRIDGE_PORT, path: "/v1/proactive",
      method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      timeout: 5000,
    }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on("error", () => resolve(false));
    req.end(body);
  });
}
const plugin = {
  id: "shizuha-dashboard",
  name: "Shizuha Dashboard",
  description: "Delivers proactive messages to Shizuha dashboard",
  configSchema: { schema: {} },
  register(api) {
    api.registerChannel({
      plugin: {
        id: "shizuha-dashboard",
        meta: { id: "shizuha-dashboard", label: "Shizuha Dashboard", selectionLabel: "Shizuha", docsPath: "/" },
        capabilities: { chatTypes: ["dm"] },
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({ id: "default", channel: "shizuha-dashboard", enabled: true, configured: true }),
          defaultAccountId: () => "default",
          isEnabled: () => true,
          isConfigured: () => true,
        },
        outbound: {
          deliveryMode: "direct",
          sendText: async (ctx) => {
            const ok = await postToBridge(ctx.text);
            return ok ? { ok: true } : { ok: false, error: new Error("bridge delivery failed") };
          },
        },
      },
    });
  },
};
export default plugin;
`);
      if (isRoot) try { execSync(`chown -R 1000:1000 ${pluginDir}`, { stdio: 'ignore' }); } catch { /* */ }
      console.log('[openclaw-bridge] Installed shizuha-dashboard channel plugin');
    }

    console.log(`[openclaw-bridge] Starting OpenClaw gateway on port ${GATEWAY_PORT}...`);

    this.gatewayProcess = spawn(spawnCmd, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      detached: true,
    });

    this.gatewayProcess.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      for (const line of text.split('\n')) {
        // Strip ANSI codes for clean logging
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean) console.log(`[openclaw-gw] ${clean}`);
      }
    });

    this.gatewayProcess.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      for (const line of text.split('\n')) {
        const clean = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
        if (clean && clean.length < 500) console.error(`[openclaw-gw] ${clean}`);
      }
    });

    this.gatewayProcess.on('exit', (code, signal) => {
      console.error(`[openclaw-bridge] Gateway exited (code=${code}, signal=${signal})`);
      this.gatewayConnected = false;
      // Gateway crashed — exit the bridge so daemon can restart the container
      process.exit(1);
    });

    // Wait for gateway to be ready
    const ready = await this.waitForGateway(30_000);
    if (!ready) {
      throw new Error('OpenClaw gateway failed to start within 30s');
    }
    console.log('[openclaw-bridge] Gateway is ready');
  }

  private async waitForGateway(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        // Try TCP connection to gateway port
        await new Promise<void>((resolve, reject) => {
          const net = require('node:net');
          const sock = net.createConnection({ port: GATEWAY_PORT, host: '127.0.0.1' }, () => {
            sock.destroy();
            resolve();
          });
          sock.on('error', reject);
          sock.setTimeout(1000, () => { sock.destroy(); reject(new Error('timeout')); });
        });
        return true;
      } catch {
        await new Promise(r => setTimeout(r, 500));
      }
    }
    return false;
  }

  // ── Gateway WS connection ──

  private async connectToGateway(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${GATEWAY_PORT}`);
      this.gatewayWs = ws;

      let handshakeComplete = false;

      ws.on('open', () => {
        console.log('[openclaw-bridge] WS connected to gateway');
      });

      ws.on('message', (rawData: Buffer | string) => {
        const msg = JSON.parse(rawData.toString());
        const type = msg.type as string;
        const event = msg.event as string | undefined;

        // ── Handshake: connect.challenge → connect → hello ──
        if (type === 'event' && event === 'connect.challenge') {
          const nonce = msg.payload?.nonce as string;
          if (!nonce) {
            reject(new Error('Gateway connect challenge missing nonce'));
            return;
          }
          // Send connect request (auth=none — no auth field)
          const connectId = crypto.randomUUID();
          const role = 'operator';
          const scopes = ['operator.admin'];
          const signedAtMs = Date.now();
          // Build v3 device auth payload for signing
          const payloadStr = [
            'v3',
            this.deviceIdentity.deviceId,
            'gateway-client',      // clientId
            'backend',             // clientMode
            role,
            scopes.join(','),
            String(signedAtMs),
            '',                    // token (password auth — no token)
            nonce,
            process.platform,      // platform
            '',                    // deviceFamily
          ].join('|');
          const signature = signPayload(this.deviceIdentity.privateKeyPem, payloadStr);

          ws.send(JSON.stringify({
            type: 'req',
            id: connectId,
            method: 'connect',
            params: {
              minProtocol: 1,
              maxProtocol: 3,
              client: {
                id: 'gateway-client',
                version: '1.0.0',
                platform: process.platform,
                mode: 'backend',
              },
              auth: { password: GATEWAY_PASSWORD },
              role,
              scopes,
              caps: ['tool-events'],
              device: {
                id: this.deviceIdentity.deviceId,
                publicKey: publicKeyRawBase64Url(this.deviceIdentity.publicKeyPem),
                signature,
                signedAt: signedAtMs,
                nonce,
              },
            },
          }));
          return;
        }

        // ── Hello response ──
        if (type === 'res' && msg.ok && !handshakeComplete) {
          handshakeComplete = true;
          this.gatewayConnected = true;
          console.log('[openclaw-bridge] Gateway handshake complete');
          resolve();
          return;
        }

        // ── Error response ──
        if (type === 'res' && !msg.ok) {
          const reqId = msg.id as string;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            this.pendingRequests.delete(reqId);
            pending.reject(new Error(msg.error?.message ?? 'Unknown gateway error'));
          } else if (!handshakeComplete) {
            reject(new Error(msg.error?.message ?? 'Gateway handshake failed'));
          }
          return;
        }

        // ── Success response to our request ──
        if (type === 'res' && msg.ok) {
          const reqId = msg.id as string;
          const pending = this.pendingRequests.get(reqId);
          if (pending) {
            this.pendingRequests.delete(reqId);
            pending.resolve(msg.payload);
          }
          return;
        }

        // ── Agent streaming events ──
        if (type === 'event' && event === 'agent') {
          this.handleAgentEvent(msg.payload);
          return;
        }

        // ── Chat events (proactive messages from cron, heartbeat, etc.) ──
        // Skip chat events that are just echoes of the active execution —
        // the streaming events already delivered the content to all clients.
        if (type === 'event' && event === 'chat') {
          const payload = msg.payload as Record<string, unknown> | undefined;
          const state = payload?.state as string; // 'delta' | 'final' | 'error'
          const message = payload?.message as Record<string, unknown> | undefined;
          if (message?.role === 'assistant' && state === 'final') {
            // Skip if there's an active execution — streaming handles delivery
            if (this.activeThreadId) {
              return;
            }
            // Skip if the streaming path already delivered this response.
            // The chat:final arrives AFTER lifecycle:end clears activeThreadId,
            // but the content was already sent via broadcastToThread deltas.
            // Use lastStreamedContent to detect duplicates.
            const content2 = message.content as Array<{ type: string; text?: string }> | string | undefined;
            let finalText = '';
            if (typeof content2 === 'string') finalText = content2;
            else if (Array.isArray(content2)) finalText = content2.filter(c => c.type === 'text').map(c => c.text || '').join('');
            if (finalText && this.lastStreamedContent && finalText === this.lastStreamedContent) {
              this.lastStreamedContent = '';
              return; // Already delivered via streaming
            }
            const content = message.content as Array<{ type: string; text?: string }> | string | undefined;
            let text = '';
            if (typeof content === 'string') {
              text = content;
            } else if (Array.isArray(content)) {
              text = content.filter(c => c.type === 'text').map(c => c.text || '').join('');
            }
            if (text) {
              // Genuine proactive message — broadcast to ONE client only
              // (the dashboard WS relay), not all clients to avoid duplication.
              const threadId = crypto.randomUUID();
              const firstClient = this.clients.values().next().value;
              if (firstClient) {
                firstClient.activeThreadId = threadId;
                this.sendWs(firstClient.ws, { type: 'content', execution_id: threadId, data: { delta: text } });
                this.sendWs(firstClient.ws, { type: 'complete', execution_id: threadId, data: { result: { proactive: true } } });
                firstClient.activeThreadId = null;
              }
              // Persist
              this.store.appendMessage(this.sessionId, {
                id: crypto.randomUUID(),
                executionId: threadId,
                role: 'assistant',
                content: text,
                timestamp: Date.now(),
              });
              console.log(`[openclaw-bridge] Proactive chat message: "${text.slice(0, 80)}"`);
            }
          }
          return;
        }

        // ── Tick (keepalive from gateway) — ignore ──
        if (type === 'event' && event === 'tick') return;
      });

      ws.on('error', (err: Error) => {
        console.error(`[openclaw-bridge] Gateway WS error: ${err.message}`);
        if (!handshakeComplete) reject(err);
      });

      ws.on('close', () => {
        console.warn('[openclaw-bridge] Gateway WS closed');
        this.gatewayConnected = false;
        // Reconnect after 3s
        setTimeout(() => {
          if (!this.gatewayConnected) {
            this.connectToGateway().catch(e =>
              console.error(`[openclaw-bridge] Reconnect failed: ${(e as Error).message}`));
          }
        }, 3000);
      });

      // Timeout handshake
      setTimeout(() => {
        if (!handshakeComplete) reject(new Error('Gateway WS handshake timeout'));
      }, 10_000);
    });
  }

  /** Send a request to the gateway and wait for response */
  private gatewayRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.gatewayWs || this.gatewayWs.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway WS not connected'));
        return;
      }
      const id = crypto.randomUUID();
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Gateway request ${method} timeout`));
      }, 600_000); // 10 min timeout for agent calls
      this.pendingRequests.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
      this.gatewayWs.send(JSON.stringify({ type: 'req', id, method, params }));
    });
  }

  /** Handle streaming agent events from the gateway */
  private handleAgentEvent(payload: Record<string, unknown>): void {
    const runId = payload.runId as string;
    const stream = payload.stream as string;
    const data = payload.data as Record<string, unknown> | undefined;
    let threadId = this.activeThreadId;

    // Proactive message (cron, heartbeat) — no active thread means the gateway
    // initiated this agent run itself. Create a thread so it reaches the dashboard.
    if (!threadId && runId) {
      threadId = crypto.randomUUID();
      this.activeThreadId = threadId;
      this.activeRunId = runId;
      this.accumulatedContent = '';
      // Assign to all connected clients so they see it
      for (const [, client] of this.clients) {
        client.activeThreadId = threadId;
      }
      console.log(`[openclaw-bridge] Proactive agent event (cron/heartbeat) — threadId=${threadId.slice(0, 8)}`);
    }

    if (!threadId) return;
    // Only process events for our active run
    if (this.activeRunId && runId !== this.activeRunId) return;
    // Track the runId from the first event
    if (!this.activeRunId && runId) this.activeRunId = runId;

    if (stream === 'assistant') {
      // Streaming text content
      const delta = (data?.delta ?? data?.text ?? '') as string;
      if (delta) {
        this.accumulatedContent += delta;
        this.broadcastToThread(threadId, {
          type: 'content',
          execution_id: threadId,
          data: { delta },
        });
      }
      return;
    }

    if (stream === 'tool') {
      const phase = data?.phase as string;
      const toolName = (data?.name ?? 'unknown') as string;
      if (phase === 'start') {
        this.broadcastToThread(threadId, {
          type: 'tool_start',
          execution_id: threadId,
          data: {
            tool: toolName,
            input: data?.input ?? {},
            tool_call_id: crypto.randomUUID(),
          },
        });
      } else if (phase === 'end') {
        this.broadcastToThread(threadId, {
          type: 'tool_complete',
          execution_id: threadId,
          data: {
            tool: toolName,
            is_error: !!data?.error,
            duration_ms: 0,
          },
        });
      }
      return;
    }

    if (stream === 'lifecycle') {
      const phase = data?.phase as string;
      if (phase === 'end' || phase === 'error') {
        // Agent run complete — save content for dedup against chat:final echo
        this.lastStreamedContent = this.accumulatedContent;
        if (this.accumulatedContent) {
          this.store.appendMessage(this.sessionId, {
            ...(this.activeMessageId ? { id: this.activeMessageId, executionId: threadId } : {}),
            role: 'assistant',
            content: this.accumulatedContent,
            timestamp: Date.now(),
          });
        }

        this.turnCount++;
        if (phase === 'error') {
          this.broadcastToThread(threadId, {
            type: 'error',
            execution_id: threadId,
            data: { message: (data?.error as Record<string, unknown>)?.message ?? 'Agent error' },
          });
        }
        this.broadcastToThread(threadId, {
          type: 'complete',
          execution_id: threadId,
          data: {
            result: {
              total_turns: this.turnCount,
              input_tokens: this.totalInputTokens,
              output_tokens: this.totalOutputTokens,
            },
          },
        });
        this.activeThreadId = null;
        this.activeRunId = null;
        this.activeMessageId = null;
        this.accumulatedContent = '';
        this.processQueue();
      }
      return;
    }
  }

  // ── CLI discovery ──

  // Proactive delivery is now via /v1/proactive HTTP endpoint (no file watcher needed)

  private async findOpenClawCli(): Promise<string> {
    const candidates = [
      '/usr/local/bin/openclaw',
      '/usr/bin/openclaw',
      path.join(process.env['HOME'] ?? '/root', '.local', 'bin', 'openclaw'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const result = execSync('which openclaw', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch { /* not found */ }

    console.log('[openclaw-bridge] OpenClaw CLI not found — installing...');
    try {
      execSync('npm install -g openclaw', {
        encoding: 'utf-8', timeout: 180_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const p of candidates) { if (fs.existsSync(p)) return p; }
      const result = execSync('which openclaw', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch (err) {
      console.error('[openclaw-bridge] Auto-install failed: ' + (err as Error).message);
    }
    throw new Error('OpenClaw CLI not found. Install manually: npm install -g openclaw');
  }

  // ── Auth ──

  private hasAuth = false;

  /**
   * Ensure OpenClaw has valid auth.
   *
   * Auth strategy (in priority order):
   * 1. Existing auth-profiles.json (OpenClaw's own OAuth session from device auth)
   * 2. OPENAI_API_KEY env var → write as api_key profile
   * 3. Seed from Shizuha Codex credentials (one-time bootstrap only)
   *
   * OpenAI OAuth refresh tokens are single-use. Sharing them between agents
   * (Codex CLI, OpenClaw, Shizuha runtime) causes "refresh_token_reused" errors.
   * Each agent MUST have its own OAuth session. The Shizuha credential seed is
   * only for initial bootstrap — after that, OpenClaw manages its own refresh.
   */
  private async ensureAuth(): Promise<void> {
    const isRoot = process.getuid?.() === 0;
    const agentHome = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const openclawDir = path.join(agentHome, '.openclaw');
    const agentDir = path.join(openclawDir, 'agents', 'main', 'agent');
    const authProfilesPath = path.join(agentDir, 'auth-profiles.json');

    // 1. OpenClaw already has its own auth (from prior device auth or previous seed)
    if (fs.existsSync(authProfilesPath)) {
      try {
        const store = JSON.parse(fs.readFileSync(authProfilesPath, 'utf-8'));
        const profiles = store?.profiles ?? {};
        const hasOAuth = Object.values(profiles).some((p: any) => p.type === 'oauth' && p.access);
        const hasApiKey = Object.values(profiles).some((p: any) => p.type === 'api_key' && p.key);
        if (hasOAuth || hasApiKey) {
          console.log(`[openclaw-bridge] Using existing auth profiles (${Object.keys(profiles).join(', ')})`);
          this.hasAuth = true;
          return;
        }
      } catch { /* corrupted — fall through to re-seed */ }
    }

    // 2. OPENAI_API_KEY env var
    if (process.env['OPENAI_API_KEY']) {
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(authProfilesPath, JSON.stringify({
        version: 1,
        profiles: { 'openai:api_key': { type: 'api_key', provider: 'openai', key: process.env['OPENAI_API_KEY'] } },
      }, null, 2));
      if (isRoot) try { execSync(`chown -R 1000:1000 ${openclawDir}`, { stdio: 'ignore' }); } catch { /* */ }
      console.log('[openclaw-bridge] Wrote OpenAI API key auth profile');
      this.hasAuth = true;
      return;
    }

    // 3. One-time seed from Shizuha Codex credentials
    //    OpenClaw's gateway will manage refresh from here using its own OAuth provider.
    //    The refresh token is consumed by OpenClaw — no other agent should use it.
    try {
      const accounts = readCodexAccounts();
      if (accounts.length > 0 && accounts[0].accessToken) {
        const account = accounts[0];

        // Decode JWT exp for accurate expiry
        let expires = Date.now() + 3600_000;
        try {
          const payload = account.accessToken.split('.')[1];
          const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
          if (decoded.exp) expires = decoded.exp * 1000;
        } catch { /* use default */ }

        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(authProfilesPath, JSON.stringify({
          version: 1,
          profiles: {
            'openai-codex:oauth': {
              type: 'oauth', provider: 'openai-codex',
              access: account.accessToken, refresh: account.refreshToken || '',
              expires, email: account.email || '',
              clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
            },
          },
        }, null, 2));
        const configPath = path.join(openclawDir, 'openclaw.json');
        // Always write config to ensure gateway password is set for internal tools (cron, sessions)
        const existingConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
        const mergedConfig = {
          ...existingConfig,
          agents: { ...existingConfig.agents, defaults: { ...existingConfig.agents?.defaults, model: { primary: `openai-codex/${this.opts.model}` } } },
          gateway: {
            ...existingConfig.gateway,
            auth: {
              mode: 'password',
              password: GATEWAY_PASSWORD,
              token: GATEWAY_PASSWORD,
            },
          },
          // Route cron/proactive messages to the shizuha-dashboard channel
          channels: {
            ...existingConfig.channels,
            'shizuha-dashboard': { enabled: true, defaultTo: 'dashboard' },
          },
        };
        fs.writeFileSync(configPath, JSON.stringify(mergedConfig, null, 2));
        if (isRoot) try { execSync(`chown -R 1000:1000 ${openclawDir}`, { stdio: 'ignore' }); } catch { /* */ }
        console.log(`[openclaw-bridge] Seeded OpenAI Codex OAuth (${account.email || 'unknown'}, expires ${new Date(expires).toISOString()})`);
        console.log('[openclaw-bridge] OpenClaw will manage its own token refresh from here.');
        this.hasAuth = true;
        return;
      }
    } catch (err) {
      console.error('[openclaw-bridge] Failed to read Codex credentials: ' + (err as Error).message);
    }
    console.warn('[openclaw-bridge] No auth configured — run `openclaw models auth login --provider openai-codex` inside the container');
  }

  // ── Dashboard-facing HTTP/WS server ──

  private async startServer(): Promise<void> {
    this.app = Fastify({ logger: false });
    await this.app.register(cors, { origin: true });

    this.app.get('/health', async () => ({
      status: 'ok',
      bridge: 'openclaw',
      model: this.opts.model,
      gatewayConnected: this.gatewayConnected,
      busy: this.activeThreadId !== null,
      queueDepth: this.messageQueue.length,
      uptime: Date.now() - this.startTime,
    }));

    // Proactive message injection — cron/outbox POSTs here
    this.app.post<{ Body: { text: string; type?: string } }>('/v1/proactive', async (request) => {
      const { text } = request.body ?? {};
      if (!text) return { ok: false, error: 'text required' };
      const threadId = crypto.randomUUID();
      for (const [, client] of this.clients) {
        client.activeThreadId = threadId;
        this.sendWs(client.ws, { type: 'content', execution_id: threadId, data: { delta: text } });
        this.sendWs(client.ws, { type: 'complete', execution_id: threadId, data: { result: { proactive: true } } });
        client.activeThreadId = null;
      }
      this.store.appendMessage(this.sessionId, {
        id: crypto.randomUUID(),
        executionId: threadId,
        role: 'assistant',
        content: text,
        timestamp: Date.now(),
      });
      console.log(`[openclaw-bridge] Proactive delivery: "${text.slice(0, 80)}"`);
      return { ok: true };
    });

    await this.app.listen({ port: this.opts.port, host: this.opts.host });

    const server = this.app.server;
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/ws/chat' || url.pathname === '/ws/chat/') {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = crypto.randomUUID();
      const client: WsClient = { ws, userId: 'localhost', activeThreadId: null };
      this.clients.set(clientId, client);

      console.log(JSON.stringify({
        level: 30, time: Date.now(), pid: process.pid,
        hostname: os.hostname(), userId: 'localhost',
        msg: 'WebSocket client connected',
      }));

      this.sendWs(ws, { type: 'transport_status', connected: true });

      ws.on('message', async (rawData: Buffer | string) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(rawData.toString()); } catch { return; }
        await this.handleClientMessage(clientId, msg);
      });

      ws.on('close', () => { this.clients.delete(clientId); });
      ws.on('error', () => { this.clients.delete(clientId); });

      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
        else clearInterval(pingInterval);
      }, 30_000);
      ws.on('close', () => clearInterval(pingInterval));
    });
  }

  private sendWs(ws: WebSocket, data: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }

  private async handleClientMessage(clientId: string, msg: Record<string, unknown>): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;
    const type = msg.type as string;

    switch (type) {
      case 'ping':
        this.sendWs(client.ws, { type: 'pong' });
        break;

      case 'subscribe':
        this.sendWs(client.ws, { type: 'subscribed', agent_id: msg.agent_id });
        break;

      case 'message': {
        const content = ((msg.content as string) || '').trim();
        if (!content) {
          this.sendWs(client.ws, { type: 'error', data: { message: 'content is required' } });
          break;
        }
        if (this.activeThreadId) {
          this.messageQueue.push({ clientId, content });
          this.sendWs(client.ws, { type: 'message_ack', data: { queued: true, session_id: this.sessionId } });
          break;
        }
        await this.startExecution(clientId, content);
        break;
      }

      case 'create_session':
        this.sendWs(client.ws, {
          type: 'session_created', session_id: this.sessionId,
          agent: { name: this.opts.agentName ?? 'Claw', id: this.opts.agentId ?? '' },
        });
        break;

      case 'sync': {
        const messages = buildSyncHistoryMessages(this.store.loadSession(this.sessionId)?.messages ?? []);
        this.sendWs(client.ws, {
          type: 'sync_history', session_id: this.sessionId,
          messages,
        });
        break;
      }

      case 'cancel':
        // TODO: send cancel to gateway
        break;
    }
  }

  private async startExecution(clientId: string, content: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    const threadId = crypto.randomUUID();
    // Set activeThreadId on ALL connected clients (not just sender) so
    // broadcastToThread reaches the dashboard bridge's WS connection too.
    // Without this, the daemon's connectLocalAgent() WS never receives
    // streaming events because its activeThreadId stays null.
    for (const [, c] of this.clients) {
      c.activeThreadId = threadId;
    }
    this.activeThreadId = threadId;
    this.activeRunId = null;
    this.activeMessageId = crypto.randomUUID();
    this.accumulatedContent = '';

    this.sendWs(client.ws, {
      type: 'message_ack',
      data: { thread_id: threadId, session_id: this.sessionId },
    });
    this.broadcastToThread(threadId, {
      type: 'session_start',
      execution_id: threadId,
      data: {
        session_id: this.sessionId,
        model: this.opts.model,
        message_id: this.activeMessageId,
      },
    });

    // Persist user message
    this.store.appendMessage(this.sessionId, {
      id: crypto.randomUUID(),
      executionId: threadId,
      role: 'user',
      content,
      timestamp: Date.now(),
    });

    console.log(`[openclaw-bridge] Sending to gateway: ${content.slice(0, 80)}...`);

    // Send agent request to gateway — response comes as streamed events
    // handled by handleAgentEvent. The gateway call resolves when the agent
    // produces a final response, but we don't wait for it here — streaming
    // events arrive via the WS message handler above.
    const params = buildOpenClawAgentParams({
      message: content,
      threadId,
      thinkingLevel: this.opts.thinkingLevel,
      contextPrompt: this.opts.contextPrompt,
    });

    this.gatewayRequest('agent', params).catch((err) => {
      console.error(`[openclaw-bridge] Gateway agent error: ${(err as Error).message}`);
      // If the streaming events haven't already completed this thread...
      if (this.activeThreadId === threadId) {
        this.broadcastToThread(threadId, {
          type: 'error', execution_id: threadId,
          data: { message: (err as Error).message },
        });
        this.broadcastToThread(threadId, {
          type: 'complete', execution_id: threadId,
          data: { result: { total_turns: this.turnCount, input_tokens: 0, output_tokens: 0 } },
        });
        this.activeThreadId = null;
        this.activeRunId = null;
        this.activeMessageId = null;
        this.processQueue();
      }
    });
  }

  private processQueue(): void {
    if (this.activeThreadId || this.messageQueue.length === 0) return;
    const next = this.messageQueue.shift()!;
    const client = this.clients.get(next.clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      this.processQueue();
      return;
    }
    this.startExecution(next.clientId, next.content);
  }

  private broadcastToThread(threadId: string, msg: Record<string, unknown>): void {
    for (const [_, client] of this.clients) {
      if (client.activeThreadId === threadId) {
        this.sendWs(client.ws, msg);
      }
    }
  }
}

// ── Entry point ──

export async function startOpenClawBridge(opts: OpenClawBridgeOptions): Promise<void> {
  console.log(
    `[openclaw-bridge] Startup summary: ${JSON.stringify({
      agentId: opts.agentId,
      agentUsername: opts.agentUsername,
      model: opts.model,
      contextPrompt: summarizePromptForLog(opts.contextPrompt),
    })}`,
  );
  if (isBridgePromptDebugEnabled() && opts.contextPrompt?.trim()) {
    console.log(`[openclaw-bridge] Context prompt begin\n${opts.contextPrompt}\n[openclaw-bridge] Context prompt end`);
  }

  const bridge = new OpenClawBridge(opts);

  process.on('SIGTERM', () => {
    console.log('[openclaw-bridge] Received SIGTERM, shutting down...');
    process.exit(0);
  });
  process.on('SIGINT', () => { process.exit(0); });

  await bridge.start();
}
