/**
 * Codex Bridge — persistent `codex --app-server` process bridged to the gateway protocol.
 *
 * Architecture:
 *   1. Spawns a persistent `codex --app-server` process (stdio JSON-RPC)
 *   2. Performs initialize handshake → thread/start to create a session
 *   3. For each user message, sends `turn/start` with the message
 *   4. Streams server notifications (content, tool events) → dashboard WS protocol
 *
 * The app-server maintains conversation history internally — no need to inject
 * <conversation_history> or spawn fresh processes per message.
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

interface CodexBridgeOptions {
  port: number;
  host: string;
  model: string;
  agentId?: string;
  agentName?: string;
  agentUsername?: string;
  reasoningEffort?: string;
  contextPrompt?: string;
  cwd?: string;
}

interface WsClient {
  ws: WebSocket;
  userId: string;
  activeThreadId: string | null;
}

// ── JSON-RPC ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcMessage = {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// ── Bridge ──

export class CodexBridge {
  private app: FastifyInstance | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WsClient>();
  private sessionId = '';
  private startTime = Date.now();

  // Token tracking
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private turnCount = 0;

  // Persistent app-server process
  private serverProcess: ChildProcess | null = null;
  private serverReady = false;
  private codexThreadId: string | null = null; // Codex's internal thread ID
  private activeThreadId: string | null = null; // Dashboard's execution thread ID
  private activeMessageId: string | null = null;
  private codexPath = '';
  private activeTurnResolve: (() => void) | null = null;

  // Message queue — messages sent during a turn are queued
  private messageQueue: Array<{ clientId: string; content: string }> = [];

  // JSON-RPC request tracking
  private nextRpcId = 1;
  private pendingRequests = new Map<string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>();

  // Session persistence
  private store: StateStore;
  private accumulatedContent = '';
  private lastStreamedContent = '';

  constructor(private opts: CodexBridgeOptions) {
    this.sessionId = `codex-bridge-${opts.agentId ?? 'default'}`;
    const workDir = opts.cwd ?? '/workspace';
    this.store = new StateStore(path.join(workDir, '.codex-state.db'));
    const existing = this.store.loadSession(this.sessionId);
    if (existing) {
      this.totalInputTokens = existing.totalInputTokens;
      this.totalOutputTokens = existing.totalOutputTokens;
      this.turnCount = existing.turnCount;
      console.log(`[codex-bridge] Resumed session: ${existing.messages.length} messages, ${this.turnCount} turns`);
    } else {
      this.store.createSessionWithId(this.sessionId, opts.model, workDir);
      console.log(`[codex-bridge] Created new session: ${this.sessionId}`);
    }
  }

  async start(): Promise<void> {
    this.codexPath = await this.findCodexCli();
    console.log(`[codex-bridge] Found codex CLI at: ${this.codexPath}`);

    await this.ensureAuth();
    this.setupCronMcp();

    // Set up dirs once at startup (not per-message)
    this.setupDirs();

    // Start the persistent app-server process
    await this.startAppServer();

    // Start HTTP/WS server
    await this.startServer();

    console.log(`Codex bridge listening on ${this.opts.host}:${this.opts.port}`);
    console.log(JSON.stringify({
      level: 30, time: Date.now(), pid: process.pid, hostname: os.hostname(),
      model: this.opts.model, sessionId: this.sessionId,
      msg: 'Codex bridge initialized',
    }));
  }

  // ── App Server Lifecycle ──

  private async startAppServer(): Promise<void> {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? '/workspace';

    const spawnEnv: Record<string, string> = {
      ...process.env as Record<string, string>,
      HOME: homeDir,
      USER: isRoot ? 'agent' : (process.env['USER'] ?? 'agent'),
      CODEX_HOME: path.join(homeDir, '.codex'),
    };

    if (this.authToken && !this.authViaFile) {
      spawnEnv['OPENAI_AUTH_TOKEN'] = this.authToken;
    }

    const spawnCmd = isRoot ? 'runuser' : this.codexPath;
    const serverArgs = ['app-server', '--listen', 'stdio://'];
    const spawnArgs = isRoot
      ? ['-u', 'agent', '--', this.codexPath, ...serverArgs]
      : serverArgs;

    console.log(`[codex-bridge] Starting persistent app-server: ${spawnCmd} ${spawnArgs.join(' ')}`);

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: spawnEnv,
    });

    this.serverProcess = child;

    // Line-buffered NDJSON parsing for stdout (JSON-RPC messages)
    let lineBuffer = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) this.handleServerMessage(line.trim());
      }
    });

    child.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        for (const line of text.split('\n')) {
          if (line.length < 500) console.error(`[codex-server] ${line}`);
        }
      }
    });

    child.on('exit', (code, signal) => {
      console.error(`[codex-bridge] App-server exited (code=${code}, signal=${signal})`);
      this.serverReady = false;
      this.serverProcess = null;
      // Reject any pending requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('App-server process exited'));
      }
      this.pendingRequests.clear();
      // Complete any active turn
      if (this.activeTurnResolve) {
        this.activeTurnResolve();
        this.activeTurnResolve = null;
      }
    });

    // Wait for process to be ready — poll until stdin is writable
    for (let i = 0; i < 30; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      if (!this.serverProcess || this.serverProcess.exitCode !== null) {
        throw new Error('App-server process exited during startup');
      }
      if (this.serverProcess.stdin?.writable) break;
    }

    if (!this.serverProcess?.stdin?.writable) {
      throw new Error('App-server stdin not writable after 15s');
    }

    // Send initialize request
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const result = await this.rpcRequest('initialize', {
      clientInfo: { name: 'shizuha-codex-bridge', version: '1.0.0' },
      capabilities: {
        experimental: {
          'thread/start.dynamicTools': true,
        },
      },
    }) as Record<string, unknown>;

    console.log(`[codex-bridge] Initialize response: capabilities received`);
    this.serverReady = true;

    // Send initialized notification
    this.rpcNotify('initialized', {});
  }

  /** Create a Codex thread with model/instructions config. */
  private async createThread(): Promise<string> {
    const params: Record<string, unknown> = {
      model: this.opts.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    };
    if (this.opts.contextPrompt) {
      params.baseInstructions = this.opts.contextPrompt;
    }

    const result = await this.rpcRequest('thread/start', params) as Record<string, unknown>;
    const thread = result.thread as Record<string, unknown> | undefined;
    const threadId = (thread?.id ?? result.threadId ?? '') as string;
    if (!threadId) {
      throw new Error('thread/start did not return a thread ID');
    }
    console.log(`[codex-bridge] Thread created: ${threadId}`);
    return threadId;
  }

  /** Send a user message as a new turn. */
  private async sendTurn(message: string): Promise<void> {
    if (!this.codexThreadId) {
      this.codexThreadId = await this.createThread();
    }

    const params: Record<string, unknown> = {
      threadId: this.codexThreadId,
      input: [{ type: 'text', text: message }],
    };

    if (this.opts.reasoningEffort) {
      params.effort = this.opts.reasoningEffort;
    }

    // turn/start returns immediately, events come as notifications
    await this.rpcRequest('turn/start', params);
  }

  // ── JSON-RPC Transport ──

  private sendToServer(msg: string): void {
    if (this.serverProcess?.stdin?.writable) {
      this.serverProcess.stdin.write(msg + '\n');
    }
  }

  private rpcRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = String(this.nextRpcId++);
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }, 120_000);

      this.pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      const msg: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.sendToServer(JSON.stringify(msg));
    });
  }

  private rpcNotify(method: string, params?: Record<string, unknown>): void {
    const msg: JsonRpcNotification = { jsonrpc: '2.0', method, params };
    this.sendToServer(JSON.stringify(msg));
  }

  /** Handle a JSON-RPC message from the app-server stdout. */
  private handleServerMessage(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Skip non-JSON lines (e.g., tracing output)
    }

    // Response to a pending request
    if (msg.id !== undefined && !msg.method) {
      const id = String(msg.id);
      const pending = this.pendingRequests.get(id);
      if (pending) {
        this.pendingRequests.delete(id);
        if (msg.error) {
          pending.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    // Server request (needs response from us — e.g., approval requests)
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg);
      return;
    }

    // Server notification (no id)
    if (msg.method) {
      // Debug: log notifications with item data
      if (msg.method?.includes('item')) {
        const item = (msg.params as any)?.item;
        console.log(`[codex-rpc] ${msg.method} item.type=${item?.type} text=${(item?.text ?? '').slice(0, 50)} keys=${Object.keys(item ?? {}).join(',')}`);
      } else if (msg.method?.includes('turn')) {
        console.log(`[codex-rpc] ${msg.method} params_keys=${Object.keys(msg.params ?? {}).join(',')}`);
      }
      this.handleServerNotification(msg);
    }
  }

  /** Handle server requests (approval prompts, etc.) */
  private handleServerRequest(msg: JsonRpcMessage): void {
    const method = msg.method!;

    // Auto-approve everything (dangerously-bypass-approvals mode)
    if (method === 'codex/approvalRequest' || method === 'approval/request') {
      // Respond with approval
      this.sendToServer(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { approved: true, decision: 'approve' },
      }));
      return;
    }

    // Default: approve unknown server requests
    this.sendToServer(JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: {},
    }));
  }

  /** Handle server notifications (events streamed during turn execution). */
  private handleServerNotification(msg: JsonRpcMessage): void {
    const method = msg.method!;
    const params = msg.params ?? {};

    // Strip codex/event/ prefix if present
    const eventName = method.startsWith('codex/event/')
      ? method.slice('codex/event/'.length)
      : method;

    const threadId = this.activeThreadId;
    if (!threadId) return; // No active execution to forward to

    switch (eventName) {
      case 'thread/started':
        // Thread created notification — already handled in createThread
        break;

      case 'turn/started':
        // Turn beginning — emit session_start equivalent
        this.broadcastToThread(threadId, {
          type: 'session_start',
          execution_id: threadId,
          data: {
            session_id: this.sessionId,
            model: this.opts.model,
            ...(this.activeMessageId ? { message_id: this.activeMessageId } : {}),
          },
        });
        break;

      case 'agent_message_delta': {
        // Streaming text content
        const delta = (params.delta ?? '') as string;
        if (delta) {
          this.accumulatedContent += delta;
          this.broadcastToThread(threadId, {
            type: 'content',
            execution_id: threadId,
            data: { delta },
          });
        }
        break;
      }

      // Item-level events (v2 protocol)
      case 'item/started': {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;
        if (itemType === 'command_execution' || itemType === 'commandExecution') {
          this.broadcastToThread(threadId, {
            type: 'tool_start',
            execution_id: threadId,
            data: { tool: 'shell', input: { command: item.command ?? '' }, tool_call_id: item.id },
          });
        } else if (itemType === 'file_change' || itemType === 'fileChange') {
          this.broadcastToThread(threadId, {
            type: 'tool_start',
            execution_id: threadId,
            data: { tool: 'file_change', input: { path: item.path ?? '' }, tool_call_id: item.id },
          });
        }
        break;
      }

      // Streaming text deltas from agent messages
      case 'item/agentMessage/delta': {
        const delta = (params.delta ?? params.text ?? '') as string;
        if (delta) {
          this.accumulatedContent += delta;
          this.broadcastToThread(threadId, {
            type: 'content',
            execution_id: threadId,
            data: { delta },
          });
        }
        break;
      }

      case 'item/completed': {
        const item = params.item as Record<string, unknown> | undefined;
        if (!item) break;
        const itemType = item.type as string;

        // agentMessage (camelCase — Codex app-server protocol)
        if (itemType === 'agentMessage' || itemType === 'agent_message') {
          const text = (item.text as string) ?? '';
          // Only emit full text if we haven't already streamed it via deltas
          if (text && !this.accumulatedContent) {
            this.accumulatedContent = text;
            this.broadcastToThread(threadId, {
              type: 'content',
              execution_id: threadId,
              data: { delta: text },
            });
          }
        } else if (itemType === 'command_execution' || itemType === 'commandExecution') {
          this.broadcastToThread(threadId, {
            type: 'tool_complete',
            execution_id: threadId,
            data: { tool: 'shell', is_error: (item.exit_code ?? 0) !== 0, exit_code: item.exit_code ?? 0 },
          });
        } else if (itemType === 'file_change') {
          this.broadcastToThread(threadId, {
            type: 'tool_complete',
            execution_id: threadId,
            data: { tool: 'file_change', is_error: false, path: item.path ?? '' },
          });
        }
        break;
      }

      case 'turn/completed':
      case 'turn_completed':
      case 'task_complete': {
        // Turn finished — update token counts
        const usage = (params.usage ?? {}) as Record<string, number>;
        const turnIn = usage.input_tokens ?? 0;
        const turnOut = usage.output_tokens ?? 0;
        this.turnCount++;
        this.totalInputTokens += turnIn;
        this.totalOutputTokens += turnOut;
        this.store.updateTokens(this.sessionId, turnIn, turnOut);

        // Persist assistant message
        if (this.accumulatedContent) {
          this.store.appendMessage(this.sessionId, {
            ...(this.activeMessageId ? { id: this.activeMessageId, executionId: threadId } : {}),
            role: 'assistant',
            content: this.accumulatedContent,
            timestamp: Date.now(),
          });
          this.lastStreamedContent = this.accumulatedContent;
          this.accumulatedContent = '';
        }

        // Emit complete to dashboard
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
        this.activeMessageId = null;
        if (this.activeTurnResolve) {
          this.activeTurnResolve();
          this.activeTurnResolve = null;
        }

        // Process next queued message
        this.processQueue();
        break;
      }

      case 'turn/failed':
      case 'turn_aborted': {
        const errMsg = ((params.error as Record<string, unknown>)?.message ?? params.message ?? 'Turn failed') as string;
        this.broadcastToThread(threadId, {
          type: 'error',
          execution_id: threadId,
          data: { message: errMsg },
        });
        this.broadcastToThread(threadId, {
          type: 'complete',
          execution_id: threadId,
          data: { result: { total_turns: this.turnCount, input_tokens: this.totalInputTokens, output_tokens: this.totalOutputTokens } },
        });
        this.activeThreadId = null;
        this.activeMessageId = null;
        if (this.activeTurnResolve) {
          this.activeTurnResolve();
          this.activeTurnResolve = null;
        }
        this.processQueue();
        break;
      }

      default:
        // Unknown notification — ignore
        break;
    }
  }

  // ── Message Execution ──

  private async executeMessage(content: string, threadId: string): Promise<void> {
    this.store.appendMessage(this.sessionId, {
      id: crypto.randomUUID(),
      executionId: threadId,
      role: 'user',
      content,
      timestamp: Date.now(),
    });
    this.accumulatedContent = '';

    if (!this.hasAuth) {
      await this.ensureAuth();
    }
    if (!this.hasAuth) {
      this.broadcastToThread(threadId, {
        type: 'error', execution_id: threadId,
        data: { message: 'Codex not authenticated. Sign in with your ChatGPT account to use this agent.' },
      });
      this.broadcastToThread(threadId, {
        type: 'complete', execution_id: threadId,
        data: { result: { total_turns: 0, input_tokens: 0, output_tokens: 0 } },
      });
      this.activeThreadId = null;
      this.activeMessageId = null;
      this.processQueue();
      return;
    }

    // Restart app-server if it died
    if (!this.serverProcess || this.serverProcess.exitCode !== null) {
      console.log('[codex-bridge] App-server not running, restarting...');
      try {
        await this.startAppServer();
      } catch (e) {
        this.broadcastToThread(threadId, {
          type: 'error', execution_id: threadId,
          data: { message: `Failed to start app-server: ${(e as Error).message}` },
        });
        this.broadcastToThread(threadId, {
          type: 'complete', execution_id: threadId,
          data: { result: { total_turns: 0, input_tokens: 0, output_tokens: 0 } },
        });
        this.activeThreadId = null;
        this.activeMessageId = null;
        this.processQueue();
        return;
      }
    }

    console.log(`[codex-bridge] Sending turn: ${content.slice(0, 80)}...`);

    try {
      // Wait for turn to complete (resolved by handleServerNotification)
      await new Promise<void>((resolve, reject) => {
        this.activeTurnResolve = resolve;
        this.sendTurn(content).catch(reject);
      });
    } catch (e) {
      console.error(`[codex-bridge] Turn error: ${(e as Error).message}`);
      if (this.activeThreadId === threadId) {
        this.broadcastToThread(threadId, {
          type: 'error', execution_id: threadId,
          data: { message: (e as Error).message },
        });
        this.broadcastToThread(threadId, {
          type: 'complete', execution_id: threadId,
          data: { result: { total_turns: this.turnCount, input_tokens: this.totalInputTokens, output_tokens: this.totalOutputTokens } },
        });
        this.activeThreadId = null;
        this.activeMessageId = null;
        this.processQueue();
      }
    }
  }

  private broadcastToThread(threadId: string, msg: Record<string, unknown>): void {
    for (const [, client] of this.clients) {
      if (client.activeThreadId === threadId) {
        this.sendWs(client.ws, msg);
      }
    }
  }

  private async startExecution(clientId: string, content: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    const threadId = crypto.randomUUID();
    client.activeThreadId = threadId;
    this.activeThreadId = threadId;
    this.activeMessageId = crypto.randomUUID();

    this.sendWs(client.ws, {
      type: 'message_ack',
      data: { thread_id: threadId, session_id: this.sessionId },
    });

    await this.executeMessage(content, threadId);
  }

  private async processQueue(): Promise<void> {
    if (this.activeThreadId || this.messageQueue.length === 0) return;

    const next = this.messageQueue.shift()!;
    const client = this.clients.get(next.clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      await this.processQueue();
      return;
    }

    await this.startExecution(next.clientId, next.content);
  }

  private sendWs(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  // ── Setup ──

  private setupDirs(): void {
    const isRoot = process.getuid?.() === 0;
    if (!isRoot) return;

    const homeDir = '/home/agent';
    const codexHome = path.join(homeDir, '.codex');
    const workDir = this.opts.cwd ?? '/workspace';

    try {
      fs.mkdirSync(homeDir, { recursive: true });
      fs.mkdirSync(codexHome, { recursive: true });
      fs.mkdirSync(workDir, { recursive: true });
      execSync(`chown 1000:1000 ${homeDir} ${codexHome} ${workDir}`, { stdio: 'ignore' });
    } catch (e) {
      console.error(`[codex-bridge] Warning: failed to set up dirs: ${(e as Error).message}`);
    }
  }

  /** Configure cron MCP server so Codex CLI can schedule jobs */
  private setupCronMcp(): void {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? '/workspace';
    const codexDir = path.join(homeDir, '.codex');
    const shizuhaJs = process.argv[1] ?? '';

    const configPath = path.join(codexDir, 'config.toml');
    fs.mkdirSync(codexDir, { recursive: true });

    let existing = '';
    try { existing = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : ''; } catch { /* */ }

    if (!existing.includes('[mcp_servers.shizuha-cron]')) {
      const mcpConfig = `
[mcp_servers.shizuha-cron]
command = "node"
args = [${JSON.stringify(shizuhaJs)}, "cron-mcp", "--workspace", ${JSON.stringify(workDir)}, "--bridge-port", ${JSON.stringify(String(this.opts.port))}]

[mcp_servers.shizuha-cron.env]
AGENT_USERNAME = "${this.opts.agentUsername ?? 'codex'}"
DAEMON_HOST = "host.docker.internal"
DAEMON_PORT = "8015"
SHIZUHA_AGENT_TOKEN = "${process.env['SHIZUHA_AGENT_TOKEN'] ?? ''}"
`;
      fs.appendFileSync(configPath, mcpConfig);
      console.log('[codex-bridge] Added shizuha-cron MCP server to config.toml');
    } else {
      console.log('[codex-bridge] shizuha-cron MCP server already in config.toml');
    }

    if (isRoot) {
      try { execSync(`chown -R 1000:1000 ${codexDir}`, { stdio: 'ignore' }); } catch { /* */ }
    }
  }

  private async findCodexCli(): Promise<string> {
    const candidates = [
      '/usr/local/bin/codex',
      '/usr/bin/codex',
      path.join(process.env['HOME'] ?? '/root', '.local', 'bin', 'codex'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const result = execSync('which codex', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch { /* not found */ }

    console.log('[codex-bridge] Codex CLI not found — installing @openai/codex...');
    try {
      execSync('npm install -g @openai/codex', {
        encoding: 'utf-8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log('[codex-bridge] Codex CLI installed successfully');
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
      const result = execSync('which codex', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch (installErr) {
      console.error('[codex-bridge] Auto-install failed: ' + (installErr as Error).message);
    }

    throw new Error('Codex CLI not found and auto-install failed. Install manually: npm install -g @openai/codex');
  }

  // ── Auth ──

  private authToken = '';
  private hasAuth = false;
  private authViaFile = false;

  private async ensureAuth(): Promise<void> {
    if (process.env['OPENAI_AUTH_TOKEN']) {
      this.authToken = process.env['OPENAI_AUTH_TOKEN'];
      this.hasAuth = true;
      console.log(`[codex-bridge] Using OPENAI_AUTH_TOKEN from env`);
      return;
    }

    const isRoot = process.getuid?.() === 0;
    const agentHome = '/home/agent';
    const agentCodexDir = path.join(agentHome, '.codex');
    const agentAuthFile = path.join(agentCodexDir, 'auth.json');

    const sources = [
      agentAuthFile,
      '/root/.codex/auth.json',
    ];

    for (const src of sources) {
      if (!fs.existsSync(src)) continue;

      if (isRoot && src !== agentAuthFile) {
        fs.mkdirSync(agentCodexDir, { recursive: true });
        fs.copyFileSync(src, agentAuthFile);
        console.log(`[codex-bridge] Copied auth from ${src} to ${agentAuthFile}`);
      } else {
        console.log(`[codex-bridge] Auth file found at ${src}`);
      }

      if (isRoot) {
        try { execSync(`chown -R 1000:1000 ${agentCodexDir}`, { stdio: 'ignore' }); } catch { /* */ }
      }

      // Proactively refresh stale tokens (>6 hours old)
      try {
        const authData = JSON.parse(fs.readFileSync(agentAuthFile, 'utf-8'));
        const lastRefresh = authData.last_refresh ? new Date(authData.last_refresh).getTime() : 0;
        const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
        if (Date.now() - lastRefresh > TOKEN_MAX_AGE_MS) {
          const refreshToken = authData.tokens?.refresh_token;
          if (refreshToken) {
            console.log(`[codex-bridge] Tokens are stale (last refresh: ${authData.last_refresh}), refreshing...`);
            const refreshed = await this.refreshForIdToken(refreshToken);
            if (refreshed) {
              authData.tokens.access_token = refreshed.access_token || authData.tokens.access_token;
              authData.tokens.refresh_token = refreshed.refresh_token || authData.tokens.refresh_token;
              if (refreshed.id_token) authData.tokens.id_token = refreshed.id_token;
              authData.last_refresh = new Date().toISOString();
              fs.writeFileSync(agentAuthFile, JSON.stringify(authData, null, 2), { mode: 0o600 });
              if (isRoot) {
                try { execSync(`chown 1000:1000 ${agentAuthFile}`, { stdio: 'ignore' }); } catch { /* */ }
              }
              console.log(`[codex-bridge] Token refreshed successfully`);
            } else {
              console.warn(`[codex-bridge] Token refresh failed`);
            }
          }
        }
      } catch (e) {
        console.warn(`[codex-bridge] Stale token check failed: ${(e as Error).message}`);
      }

      this.hasAuth = true;
      return;
    }

    // Fallback: Shizuha credentials.json
    try {
      const accounts = readCodexAccounts();
      if (accounts.length > 0) {
        const account = accounts[0];
        if (account.accessToken) {
          let accessToken = account.accessToken;
          let refreshToken = account.refreshToken;
          let idToken: string | undefined;

          if (account.refreshToken) {
            const refreshed = await this.refreshForIdToken(account.refreshToken);
            if (refreshed) {
              accessToken = refreshed.access_token || accessToken;
              refreshToken = refreshed.refresh_token || refreshToken;
              idToken = refreshed.id_token;
              try {
                const { updateCodexTokens } = await import('../config/credentials.js');
                updateCodexTokens(account.email, accessToken, refreshToken, idToken);
              } catch { /* */ }
            }
          }

          if (!idToken && account.idToken) idToken = account.idToken;
          if (!idToken) {
            console.warn(`[codex-bridge] No id_token available. Re-auth needed.`);
            this.hasAuth = false;
            return;
          }

          let accountId = account.accountId || '';
          if (!accountId && accessToken) {
            try {
              const parts = accessToken.split('.');
              if (parts.length >= 2) {
                const raw = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
                const padLen = (4 - (raw.length % 4)) % 4;
                const jwt = JSON.parse(Buffer.from(raw + '='.repeat(padLen), 'base64').toString('utf-8'));
                const authClaim = jwt?.['https://api.openai.com/auth'] as Record<string, string> | undefined;
                accountId = jwt?.account_id ?? authClaim?.chatgpt_account_id ?? authClaim?.account_id ?? '';
              }
            } catch { /* */ }
          }

          const tokens: Record<string, string> = { access_token: accessToken, refresh_token: refreshToken, id_token: idToken };
          if (accountId) tokens.account_id = accountId;

          const authJson = { auth_mode: 'chatgpt', tokens, last_refresh: new Date().toISOString() };
          fs.mkdirSync(agentCodexDir, { recursive: true });
          fs.writeFileSync(agentAuthFile, JSON.stringify(authJson, null, 2), { mode: 0o600 });
          if (isRoot) { execSync(`chown -R 1000:1000 ${agentHome}`, { stdio: 'ignore' }); }

          this.hasAuth = true;
          this.authViaFile = true;
          console.log(`[codex-bridge] Wrote auth.json from Shizuha credentials (${account.email})`);
          return;
        }
      }
    } catch (e) {
      console.warn(`[codex-bridge] Failed to read Shizuha credentials: ${(e as Error).message}`);
    }

    const apiKey = process.env['CODEX_API_KEY'] || process.env['OPENAI_API_KEY'];
    if (apiKey) {
      this.authToken = apiKey;
      this.hasAuth = true;
      console.log(`[codex-bridge] Using API key from env`);
      return;
    }

    this.hasAuth = false;
    console.warn(`[codex-bridge] No auth found. Codex CLI may fail.`);
  }

  private async refreshForIdToken(refreshToken: string): Promise<{
    access_token: string; refresh_token?: string; id_token?: string;
  } | null> {
    const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
    const TOKEN_URL = 'https://auth.openai.com/oauth/token';
    try {
      const resp = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.error(`[codex-bridge] Token refresh failed: ${resp.status} ${text.slice(0, 200)}`);
        return null;
      }
      const data = await resp.json() as Record<string, string>;
      return { access_token: data.access_token ?? '', refresh_token: data.refresh_token, id_token: data.id_token };
    } catch (e) {
      console.error(`[codex-bridge] Token refresh error: ${(e as Error).message}`);
      return null;
    }
  }

  // ── HTTP/WS Server ──

  private async startServer(): Promise<void> {
    this.app = Fastify({ logger: false });
    await this.app.register(cors, { origin: true });

    this.app.get('/health', async () => ({
      status: 'ok', bridge: 'codex-app-server', model: this.opts.model,
      busy: this.activeThreadId !== null, queueDepth: this.messageQueue.length,
      serverReady: this.serverReady, uptime: Date.now() - this.startTime,
    }));

    this.app.post<{ Body: { text: string; type?: string; jobName?: string } }>('/v1/proactive', async (request) => {
      const { text } = request.body ?? {};
      if (!text) return { ok: false, error: 'text required' };
      const threadId = crypto.randomUUID();
      for (const [, client] of this.clients) {
        client.activeThreadId = threadId;
        this.sendWs(client.ws, { type: 'content', execution_id: threadId, data: { delta: text } });
        this.sendWs(client.ws, { type: 'complete', execution_id: threadId, data: { result: { proactive: true } } });
        client.activeThreadId = null;
      }
      return { ok: true };
    });

    await this.app.listen({ port: this.opts.port, host: this.opts.host });

    const server = this.app.server;
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req: IncomingMessage, socket: any, head: Buffer) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/ws/chat' || url.pathname === '/ws/chat/') {
        this.wss!.handleUpgrade(req, socket, head, (ws) => { this.wss!.emit('connection', ws, req); });
      } else {
        socket.destroy();
      }
    });

    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = crypto.randomUUID();
      const client: WsClient = { ws, userId: 'localhost', activeThreadId: null };
      this.clients.set(clientId, client);

      console.log(JSON.stringify({
        level: 30, time: Date.now(), pid: process.pid, hostname: os.hostname(),
        userId: 'localhost', msg: 'WebSocket client connected',
      }));

      ws.on('message', (data: any) => {
        try { this.handleWsMessage(clientId, JSON.parse(data.toString())); }
        catch { /* ignore */ }
      });
      ws.on('close', () => { this.clients.delete(clientId); });
      ws.on('error', () => { this.clients.delete(clientId); });

      this.sendWs(ws, { type: 'transport_status', connected: true });
    });

    setInterval(() => {
      for (const [, client] of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try { client.ws.ping(); } catch { /* */ }
        }
      }
    }, 30_000);
  }

  private async handleWsMessage(clientId: string, msg: Record<string, unknown>): Promise<void> {
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

      case 'sync': {
        const session = this.store.loadSession(this.sessionId);
        const storedMsgs = buildSyncHistoryMessages(session?.messages ?? []);
        this.sendWs(client.ws, {
          type: 'sync_history', session_id: this.sessionId,
          messages: storedMsgs,
        });
        break;
      }

      case 'create_session':
        this.sendWs(client.ws, {
          type: 'session_created', session_id: this.sessionId,
          agent: { name: this.opts.agentName ?? 'Codex', id: this.opts.agentId ?? 'codex-bridge' },
        });
        break;

      case 'cancel':
        if (this.activeTurnResolve) {
          // Send turn/interrupt to the app-server
          this.rpcNotify('turn/interrupt', { threadId: this.codexThreadId ?? '' });
        }
        break;
    }
  }

  async stop(): Promise<void> {
    if (this.serverProcess && this.serverProcess.exitCode === null) {
      // Graceful shutdown: send exit notification then SIGTERM
      try { this.rpcNotify('exit', {}); } catch { /* */ }
      setTimeout(() => {
        if (this.serverProcess && this.serverProcess.exitCode === null) {
          this.serverProcess.kill('SIGTERM');
        }
      }, 3000);
    }
    if (this.wss) this.wss.close();
    if (this.app) await this.app.close();
  }
}

/** Entry point — called from CLI command. */
export async function startCodexBridge(opts: CodexBridgeOptions): Promise<void> {
  const bridge = new CodexBridge(opts);

  process.on('SIGTERM', async () => {
    console.log('[codex-bridge] Received SIGTERM, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[codex-bridge] Received SIGINT, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  await bridge.start();
  await new Promise<void>(() => {}); // Keep alive
}
