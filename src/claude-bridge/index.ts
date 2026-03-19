/**
 * Claude Bridge — bridges a persistent `claude -p` process to the gateway HTTP/WS protocol.
 *
 * When the execution method is `claude_code_server`, the daemon spawns this instead of
 * `shizuha.js gateway`. It:
 *   1. Starts an HTTP/WS server on the same port the dashboard expects
 *   2. Spawns `claude -p --input-format stream-json --output-format stream-json`
 *   3. Translates WS messages ↔ Claude Code NDJSON protocol
 *
 * The dashboard/mobile app connect to this bridge using the exact same protocol
 * they'd use for the Shizuha gateway — no client changes needed.
 */

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
// @ts-ignore — ws has no declaration file
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';

// ── Types ──

interface ClaudeBridgeOptions {
  port: number;
  host: string;
  model: string;
  agentId?: string;
  agentName?: string;
  agentUsername?: string;
  thinkingLevel?: string;
  reasoningEffort?: string;
  contextPrompt?: string;
  permissionMode?: string;
  cwd?: string;
}

interface WsClient {
  ws: WebSocket;
  userId: string;
  /** Active execution threadId (only one at a time per client) */
  activeThreadId: string | null;
}

// ── Claude NDJSON Protocol ──

/** Send a user message to claude -p via stdin (stream-json format). */
function buildUserMessage(content: string, sessionId: string): string {
  return JSON.stringify({
    type: 'user',
    session_id: sessionId,
    message: { role: 'user', content },
    parent_tool_use_id: null,
  });
}

// ── NDJSON Parser ──

interface ParsedEvent {
  type: 'content' | 'reasoning' | 'tool_start' | 'tool_complete' | 'complete' | 'error' | 'message_ack' | 'skip';
  data?: Record<string, unknown>;
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

export function buildClaudeSpawnArgs(params: {
  model: string;
  storedSessionId?: string | null;
  mcpNewlyConfigured?: boolean;
  contextPrompt?: string;
}): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', params.model,
    '--dangerously-skip-permissions',
    '--include-partial-messages',
  ];

  if (params.storedSessionId && !params.mcpNewlyConfigured) {
    args.push('--resume', params.storedSessionId);
  }

  args.push('--disallowedTools', 'EnterPlanMode,ExitPlanMode,AskUserQuestion');

  if (params.contextPrompt) {
    args.push('--append-system-prompt', params.contextPrompt);
  }

  return args;
}

function parseStreamJsonLine(line: string): ParsedEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const msgType = msg.type as string;

  // ── system init ──
  if (msgType === 'system') {
    // system/init — claude is ready. Extract session_id for persistence.
    const sessionId = msg.session_id as string | undefined;
    return { type: 'message_ack', data: sessionId ? { session_id: sessionId } : undefined };
  }

  // ── stream_event (Anthropic SDK passthrough) ──
  if (msgType === 'stream_event') {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return null;
    const eventType = event.type as string;

    // content_block_start → tool_use
    if (eventType === 'content_block_start') {
      const cb = event.content_block as Record<string, unknown> | undefined;
      if (cb?.type === 'tool_use') {
        return {
          type: 'tool_start',
          data: {
            tool: cb.name as string || 'tool',
            input: cb.input || {},
            tool_call_id: cb.id as string || '',
          },
        };
      }
      return null;
    }

    // content_block_delta → text or thinking
    if (eventType === 'content_block_delta') {
      const delta = event.delta as Record<string, unknown> | undefined;
      if (!delta) return null;
      if (delta.type === 'text_delta') {
        const text = delta.text as string;
        if (text) return { type: 'content', data: { delta: text } };
      }
      if (delta.type === 'thinking_delta') {
        const thinking = delta.thinking as string;
        if (thinking) return { type: 'reasoning', data: { summaries: [thinking] } };
      }
      if (delta.type === 'summary_text_delta') {
        const text = delta.text as string;
        if (text) return { type: 'reasoning', data: { summaries: [text] } };
      }
      return null;
    }

    // message_start → usage tracking
    if (eventType === 'message_start') {
      const usage = (event.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown>;
      if (usage) {
        return { type: 'skip', data: { _usage_start: usage } };
      }
      return null;
    }

    // message_delta → final usage
    if (eventType === 'message_delta') {
      const usage = event.usage as Record<string, unknown>;
      if (usage) {
        return { type: 'skip', data: { _usage_delta: usage } };
      }
      return null;
    }

    return null;
  }

  // ── Legacy/direct event types ──

  if (msgType === 'content') {
    const payload = msg.data as Record<string, unknown> | undefined;
    const delta = (payload?.delta ?? payload?.text) as string | undefined;
    if (delta) return { type: 'content', data: { delta } };
    return null;
  }

  if (msgType === 'tool_start') {
    const payload = msg.data as Record<string, unknown> | undefined;
    return {
      type: 'tool_start',
      data: {
        tool: (payload?.tool ?? payload?.name ?? 'tool') as string,
        input: payload?.input || {},
        tool_call_id: (payload?.tool_call_id ?? '') as string,
      },
    };
  }

  if (msgType === 'tool_complete') {
    const payload = msg.data as Record<string, unknown> | undefined;
    return {
      type: 'tool_complete',
      data: {
        tool: (payload?.tool ?? payload?.name ?? 'tool') as string,
        duration_ms: (payload?.duration_ms ?? 0) as number,
        is_error: (payload?.is_error ?? false) as boolean,
      },
    };
  }

  if (msgType === 'reasoning') {
    const payload = msg.data as Record<string, unknown> | undefined;
    const summaries = payload?.summaries;
    if (Array.isArray(summaries) && summaries.length > 0) {
      return { type: 'reasoning', data: { summaries } };
    }
    return null;
  }

  if (msgType === 'error') {
    const payload = msg.data as Record<string, unknown> | undefined;
    const message = (payload?.message ?? msg.error ?? 'Unknown error') as string;
    return { type: 'error', data: { message } };
  }

  if (msgType === 'result') {
    // Final result — signals turn completion
    if (msg.subtype === 'error') {
      return { type: 'error', data: { message: (msg.error ?? 'Unknown error') as string } };
    }
    const resultText = msg.result as string | undefined;
    return {
      type: 'complete',
      data: {
        result: resultText || '',
        duration_seconds: (msg.duration_seconds ?? 0) as number,
        input_tokens: (msg.input_tokens ?? 0) as number,
        output_tokens: (msg.output_tokens ?? 0) as number,
      },
    };
  }

  // Skip: user, assistant, keep_alive, system
  if (msgType === 'user' || msgType === 'assistant' || msgType === 'keep_alive') {
    return null;
  }

  return null;
}

// ── Bridge ──

export class ClaudeBridge {
  private app: FastifyInstance | null = null;
  private wss: WebSocketServer | null = null;
  private claudeProcess: ChildProcess | null = null;
  private clients = new Map<string, WsClient>();
  private lineBuffer = '';
  private sessionId = '';
  private claudeSessionId = ''; // Real session ID from Claude Code
  private initialized = false;
  private startTime = Date.now();
  private isReplaying = true; // True during startup replay of resumed session

  // Token tracking (accumulated across turns)
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private turnCount = 0;
  private activeMessageId: string | null = null;

  // Replay history — collected during startup for sync responses
  private replayHistory: Array<{ id?: string; role: string; content: string; createdAt: string }> = [];

  // The threadId of the current active execution (claude -p is single-threaded)
  private activeThreadId: string | null = null;

  // Message queue — messages received during active execution are queued and processed in order
  private messageQueue: Array<{ clientId: string; content: string }> = [];

  // Track pending tools that got tool_start but no tool_complete
  // (Claude Code's NDJSON doesn't emit tool_complete — we synthesize them)
  private pendingTools: Array<{ tool: string; startedAt: number }> = [];

  constructor(private opts: ClaudeBridgeOptions) {
    this.sessionId = `claude-bridge-${opts.agentId ?? 'default'}`;
  }

  async start(): Promise<void> {
    // 0. Setup cron MCP server for Claude Code to use
    this.setupCronMcp();

    // 1. Spawn claude -p
    await this.spawnClaude();

    // 2. Start HTTP/WS server
    await this.startServer();

    // Proactive delivery: cron MCP server POSTs to /v1/proactive (no file watcher needed)

    console.log(`Claude Code bridge listening on ${this.opts.host}:${this.opts.port}`);
    console.log(JSON.stringify({
      level: 30,
      time: Date.now(),
      pid: process.pid,
      hostname: os.hostname(),
      model: this.opts.model,
      sessionId: this.sessionId,
      msg: 'Claude Code bridge initialized',
    }));
  }

  private async spawnClaude(): Promise<void> {
    const claudePath = await this.findClaudeCli();

    // Check if a previous session exists for this agent's working directory
    const sessionIdFile = this.getSessionIdFile();
    const storedSessionId = this.loadStoredSessionId(sessionIdFile);

    // Resume previous session if one exists — unless MCP was newly configured
    // (Claude Code discovers MCP servers at session init, not on resume).
    // If no stored session ID exists, start a fresh session. This makes
    // `.claude-session-id` the explicit source of truth for continuation and
    // allows operators to reset a bridge session by clearing that file.
    if (storedSessionId && !this.mcpNewlyConfigured) {
      console.log(`[claude-bridge] Resuming session: ${storedSessionId}`);
    } else if (!this.mcpNewlyConfigured) {
      console.log('[claude-bridge] No stored session ID — starting fresh session');
    } else {
      console.log('[claude-bridge] Starting fresh session (MCP tools newly added)');
    }
    const args = buildClaudeSpawnArgs({
      model: this.opts.model,
      storedSessionId,
      mcpNewlyConfigured: this.mcpNewlyConfigured,
      contextPrompt: this.opts.contextPrompt,
    });

    // Determine if we need to drop privileges (running as root inside Docker)
    const isRoot = process.getuid?.() === 0;
    const targetUid = 1000;
    const targetGid = 1000;
    const homeDir = isRoot ? `/home/agent` : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? process.cwd();

    console.log(`[claude-bridge] Spawning: ${claudePath} ${args.join(' ')}`);

    // Ensure agent user home and workspace exist with correct permissions
    if (isRoot) {
      try {
        // Create agent user home directory
        fs.mkdirSync(homeDir, { recursive: true });
        fs.chownSync(homeDir, targetUid, targetGid);
        // Ensure workspace is writable
        fs.mkdirSync(workDir, { recursive: true });
        fs.chownSync(workDir, targetUid, targetGid);
        // Copy .claude credentials if they exist in /root
        const rootClaudeDir = '/root/.claude';
        const agentClaudeDir = path.join(homeDir, '.claude');
        if (fs.existsSync(rootClaudeDir) && !fs.existsSync(agentClaudeDir)) {
          const { execSync } = await import('node:child_process');
          execSync(`cp -r ${rootClaudeDir} ${agentClaudeDir} && chown -R ${targetUid}:${targetGid} ${agentClaudeDir}`, { stdio: 'ignore' });
        }
      } catch (e) {
        console.error(`[claude-bridge] Warning: failed to set up agent home: ${(e as Error).message}`);
      }
    }

    // When running as root, drop to the 'agent' user.
    // Use runuser with --preserve-environment (-p) to forward env vars like
    // CLAUDE_CODE_OAUTH_TOKEN. Without -p, runuser resets the environment and
    // Claude Code can't find its auth tokens.
    const spawnCmd = isRoot ? 'runuser' : claudePath;
    const spawnArgs = isRoot ? ['-p', '-u', 'agent', '--', claudePath, ...args] : args;

    this.claudeProcess = spawn(spawnCmd, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: workDir,
      env: {
        ...process.env,
        HOME: homeDir,
        USER: isRoot ? 'agent' : (process.env['USER'] ?? 'agent'),
      },
    });

    // Handle stdout (NDJSON lines)
    this.claudeProcess.stdout!.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    // Log stderr
    this.claudeProcess.stderr!.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        // Only log meaningful lines (skip long minified source)
        for (const line of text.split('\n')) {
          if (line.length < 500) {
            console.error(`[claude-bridge] stderr: ${line}`);
          }
        }
      }
    });

    this.claudeProcess.on('exit', (code, signal) => {
      console.error(`[claude-bridge] claude process exited: code=${code} signal=${signal}`);
      // Notify all clients
      for (const [_, client] of this.clients) {
        this.sendWs(client.ws, {
          type: 'error',
          data: { message: `Claude Code process exited (code ${code})` },
        });
      }
      // Exit the bridge — daemon will restart us
      process.exit(code ?? 1);
    });

    // Wait for process to be alive
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    if (this.claudeProcess.exitCode !== null) {
      throw new Error(`Claude process exited immediately with code ${this.claudeProcess.exitCode}`);
    }

    this.initialized = true;
  }

  /** Whether MCP config was newly created (session needs reset to discover tools) */
  private mcpNewlyConfigured = false;

  /** Configure cron MCP server so Claude Code can schedule jobs */
  private setupCronMcp(): void {
    const isRoot = process.getuid?.() === 0;
    const homeDir = isRoot ? '/home/agent' : (process.env['HOME'] ?? '/root');
    const workDir = this.opts.cwd ?? process.cwd();
    const claudeDir = path.join(homeDir, '.claude');
    const shizuhaJs = process.argv[1] ?? '';

    const settingsPath = path.join(claudeDir, 'settings.json');
    fs.mkdirSync(claudeDir, { recursive: true });

    let settings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch { /* start fresh */ }

    // Check if MCP was already configured in a previous run
    const existingMcp = (settings.mcpServers as Record<string, unknown> ?? {});
    const hadCronMcp = !!existingMcp['shizuha-cron'];

    settings.mcpServers = {
      ...existingMcp,
      'shizuha-cron': {
        command: 'node',
        args: [shizuhaJs, 'cron-mcp', '--workspace', workDir, '--bridge-port', String(this.opts.port)],
        env: {
          AGENT_USERNAME: this.opts.agentUsername ?? 'claude',
          DAEMON_HOST: 'host.docker.internal',
          DAEMON_PORT: '8015',
        },
      },
    };

    const perms = (settings.permissions ?? {}) as Record<string, unknown>;
    const allow = (perms.allow ?? []) as string[];
    for (const tool of [
      'mcp__shizuha-cron__schedule_job', 'mcp__shizuha-cron__list_jobs', 'mcp__shizuha-cron__remove_job',
      'mcp__shizuha-cron__configure_heartbeat',
      'mcp__shizuha-cron__memory_store', 'mcp__shizuha-cron__memory_search', 'mcp__shizuha-cron__memory_list', 'mcp__shizuha-cron__memory_forget',
      'mcp__shizuha-cron__browser_navigate', 'mcp__shizuha-cron__browser', 'mcp__shizuha-cron__text_to_speech', 'mcp__shizuha-cron__generate_image',
      'mcp__shizuha-cron__canvas_render', 'mcp__shizuha-cron__remote_exec', 'mcp__shizuha-cron__integration_guide',
      'mcp__shizuha-cron__message_agent', 'mcp__shizuha-cron__list_agents',
      'mcp__shizuha-cron__search_skills', 'mcp__shizuha-cron__use_skill',
      'mcp__shizuha-cron__memory_index_search',
      'mcp__shizuha-cron__interactive_reply',
      'mcp__shizuha-cron__audit_log',
      'mcp__shizuha-cron__pause_agent', 'mcp__shizuha-cron__resume_agent',
    ]) {
      if (!allow.includes(tool)) allow.push(tool);
    }
    perms.allow = allow;
    settings.permissions = perms;

    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    if (isRoot) {
      try { execSync(`chown -R 1000:1000 ${claudeDir}`, { stdio: 'ignore' }); } catch { /* */ }
    }

    if (!hadCronMcp) {
      // MCP newly added — Claude Code needs a fresh session to discover it.
      // Clear the stored session ID so spawnClaude uses --continue instead of --resume.
      this.mcpNewlyConfigured = true;
      console.log('[claude-bridge] Cron MCP server newly configured — will start fresh session');
    } else {
      console.log('[claude-bridge] Cron MCP server already configured');
    }
  }

  private async findClaudeCli(): Promise<string> {
    // Check common locations
    const candidates = [
      '/usr/local/bin/claude',
      '/usr/bin/claude',
      path.join(process.env['HOME'] ?? '/root', '.claude', 'local', 'claude'),
      path.join(process.env['HOME'] ?? '/root', '.local', 'bin', 'claude'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    // Try PATH
    try {
      const { execSync } = await import('node:child_process');
      const result = execSync('which claude', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch { /* not found */ }

    // Auto-install Claude CLI
    console.log('[claude-bridge] Claude CLI not found — installing @anthropic-ai/claude-code...');
    try {
      const { execSync: execSyncImport } = await import('node:child_process');
      execSyncImport('npm install -g @anthropic-ai/claude-code', {
        encoding: 'utf-8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      console.log('[claude-bridge] Claude CLI installed successfully');
      // Re-check after install
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
      const result = execSyncImport('which claude', { encoding: 'utf-8', timeout: 5000 }).trim();
      if (result) return result;
    } catch (installErr) {
      console.error('[claude-bridge] Auto-install failed: ' + (installErr as Error).message);
    }

    throw new Error(
      'Claude CLI not found and auto-install failed. Install manually:\n'
      + '  npm install -g @anthropic-ai/claude-code\n'
      + '  Or: curl -fsSL https://claude.ai/install.sh | bash',
    );
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.lineBuffer += chunk.toString();

    // Process complete lines
    const lines = this.lineBuffer.split('\n');
    this.lineBuffer = lines.pop() || ''; // Last element is incomplete (or empty)

    for (const line of lines) {
      // Check for replay events (from --resume/--continue) before parsing
      const rawMsg = this.tryParseJson(line);
      if (rawMsg?.isReplay) {
        // Collect replay messages for sync responses but don't broadcast
        if (rawMsg.type === 'user' && rawMsg.message?.content) {
          this.replayHistory.push({
            role: 'user',
            content: typeof rawMsg.message.content === 'string' ? rawMsg.message.content : JSON.stringify(rawMsg.message.content),
            createdAt: new Date().toISOString(),
          });
        } else if (rawMsg.type === 'assistant' && rawMsg.message?.content) {
          const content = Array.isArray(rawMsg.message.content)
            ? rawMsg.message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
            : typeof rawMsg.message.content === 'string' ? rawMsg.message.content : '';
          if (content) {
            this.replayHistory.push({ role: 'assistant', content, createdAt: new Date().toISOString() });
          }
        }
        continue; // Skip — don't forward replay events to clients
      }

      // First non-replay message means replay is done
      if (this.isReplaying && rawMsg && !rawMsg.isReplay) {
        this.isReplaying = false;
        if (this.replayHistory.length > 0) {
          console.log(`[claude-bridge] Session replay complete: ${this.replayHistory.length} messages recovered`);
        }
      }

      const parsed = parseStreamJsonLine(line);
      if (!parsed) continue;

      if (parsed.type === 'message_ack') {
        // system/init — capture real session ID and persist it
        const realSessionId = parsed.data?.session_id as string | undefined;
        if (realSessionId) {
          this.claudeSessionId = realSessionId;
          this.saveSessionId(realSessionId);
          console.log(`[claude-bridge] Claude session ID: ${realSessionId}`);
        }
        continue;
      }

      if (parsed.type === 'skip') {
        // Usage tracking
        if (parsed.data?._usage_start) {
          const u = parsed.data._usage_start as Record<string, number>;
          this.totalInputTokens += u.input_tokens ?? 0;
        }
        if (parsed.data?._usage_delta) {
          const u = parsed.data._usage_delta as Record<string, number>;
          this.totalOutputTokens += u.output_tokens ?? 0;
        }
        continue;
      }

      if (parsed.type === 'complete') {
        this.turnCount++;
        // Merge token info from result
        if (parsed.data?.input_tokens) {
          this.totalInputTokens += parsed.data.input_tokens as number;
        }
        if (parsed.data?.output_tokens) {
          this.totalOutputTokens += parsed.data.output_tokens as number;
        }

        // Flush all pending tools — they must have completed before the turn ended
        this.flushPendingTools();

        if (this.activeThreadId) {
          if (this.accumulatedContent) {
            this.replayHistory.push({
              id: this.activeMessageId ?? crypto.randomUUID(),
              role: 'assistant',
              content: this.accumulatedContent,
              createdAt: new Date().toISOString(),
            });
          }
          this.broadcastToThread(this.activeThreadId, {
            type: 'complete',
            execution_id: this.activeThreadId,
            data: {
              result: {
                total_turns: this.turnCount,
                input_tokens: this.totalInputTokens,
                output_tokens: this.totalOutputTokens,
              },
              duration_seconds: parsed.data?.duration_seconds ?? 0,
            },
          });
          this.activeThreadId = null;
          this.activeMessageId = null;
          this.processQueue();
        }
        continue;
      }

      if (parsed.type === 'error') {
        this.flushPendingTools();
        if (this.activeThreadId) {
          this.broadcastToThread(this.activeThreadId, {
            type: 'error',
            execution_id: this.activeThreadId,
            data: parsed.data,
          });
          this.activeThreadId = null;
          this.activeMessageId = null;
          this.processQueue();
        }
        continue;
      }

      // Proactive events (cron, etc.) — create a thread when events arrive
      // with no active user thread. This handles Claude Code's built-in CronCreate.
      if (!this.activeThreadId && (parsed.type === 'content' || parsed.type === 'tool_start' || parsed.type === 'complete')) {
        this.activeThreadId = crypto.randomUUID();
        for (const [, client] of this.clients) {
          client.activeThreadId = this.activeThreadId;
        }
        console.log(`[claude-bridge] Proactive event — created thread ${this.activeThreadId.slice(0, 8)}`);
      }

      // content, reasoning, tool_start, tool_complete — forward to active thread
      if (parsed.type === 'tool_start') {
        // When content arrives between tool_starts, pending tools have completed
        // (Claude Code runs tools then produces content)
        const toolName = (parsed.data?.tool ?? 'tool') as string;
        this.pendingTools.push({ tool: toolName, startedAt: Date.now() });
      } else if (parsed.type === 'tool_complete') {
        // Explicit tool_complete from legacy protocol — remove from pending
        const toolName = (parsed.data?.tool ?? '') as string;
        const idx = this.pendingTools.findIndex((t) => t.tool === toolName);
        if (idx >= 0) this.pendingTools.splice(idx, 1);
      } else if (parsed.type === 'content' && this.pendingTools.length > 0) {
        // Content after tool_start(s) means all pending tools have finished
        this.flushPendingTools();
      }

      if (this.activeThreadId) {
        this.broadcastToThread(this.activeThreadId, {
          type: parsed.type,
          execution_id: this.activeThreadId,
          data: parsed.data,
        });
      }
    }
  }

  /** Emit synthetic tool_complete for all pending tools. */
  private flushPendingTools(): void {
    if (this.pendingTools.length === 0 || !this.activeThreadId) return;
    const now = Date.now();
    for (const pt of this.pendingTools) {
      this.broadcastToThread(this.activeThreadId, {
        type: 'tool_complete',
        execution_id: this.activeThreadId,
        data: {
          tool: pt.tool,
          duration_ms: now - pt.startedAt,
          is_error: false,
        },
      });
    }
    this.pendingTools = [];
  }

  /** Start a Claude execution — creates thread, acks, and writes to stdin. */
  private startClaudeExecution(clientId: string, content: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const threadId = crypto.randomUUID();
    const messageId = crypto.randomUUID();
    client.activeThreadId = threadId;
    this.activeThreadId = threadId;
    this.activeMessageId = messageId;

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
        message_id: messageId,
      },
    });
    this.replayHistory.push({
      id: crypto.randomUUID(),
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
    });

    const ndjsonMsg = buildUserMessage(content, this.sessionId);
    this.claudeProcess!.stdin!.write(ndjsonMsg + '\n');
  }

  /** Process the next queued message after current execution completes. */
  private processQueue(): void {
    if (this.activeThreadId || this.messageQueue.length === 0) return;

    const next = this.messageQueue.shift()!;
    const client = this.clients.get(next.clientId);
    if (!client || client.ws.readyState !== WebSocket.OPEN) {
      // Client disconnected — skip and try next
      this.processQueue();
      return;
    }

    this.startClaudeExecution(next.clientId, next.content);
  }

  private broadcastToThread(threadId: string, msg: Record<string, unknown>): void {
    for (const [_, client] of this.clients) {
      if (client.activeThreadId === threadId) {
        this.sendWs(client.ws, msg);
      }
    }
  }

  private sendWs(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ }
    }
  }

  private async startServer(): Promise<void> {
    this.app = Fastify({ logger: false });
    await this.app.register(cors, { origin: true });

    // Health endpoint
    this.app.get('/health', async () => ({
      status: 'ok',
      bridge: 'claude-code',
      model: this.opts.model,
      initialized: this.initialized,
      busy: this.activeThreadId !== null,
      queueDepth: this.messageQueue.length,
      uptime: Date.now() - this.startTime,
    }));

    // Proactive message injection — cron MCP server POSTs here to deliver messages
    this.app.post<{ Body: { text: string; type?: string; jobName?: string } }>('/v1/proactive', async (request) => {
      const { text, jobName } = request.body ?? {};
      if (!text) return { ok: false, error: 'text required' };
      const threadId = crypto.randomUUID();
      for (const [, client] of this.clients) {
        client.activeThreadId = threadId;
        this.sendWs(client.ws, { type: 'content', execution_id: threadId, data: { delta: text } });
        this.sendWs(client.ws, { type: 'complete', execution_id: threadId, data: { result: { proactive: true } } });
        client.activeThreadId = null;
      }
      console.log(`[claude-bridge] Proactive delivery: "${text.slice(0, 80)}"`);
      return { ok: true };
    });

    await this.app.listen({ port: this.opts.port, host: this.opts.host });

    // WebSocket server on /ws/chat/ (same path as gateway)
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
        level: 30,
        time: Date.now(),
        pid: process.pid,
        hostname: os.hostname(),
        userId: 'localhost',
        msg: 'WebSocket client connected',
      }));

      ws.on('message', (data: any) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleWsMessage(clientId, msg);
        } catch { /* ignore malformed */ }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
      });

      ws.on('error', () => {
        this.clients.delete(clientId);
      });

      // Send connected status
      this.sendWs(ws, { type: 'transport_status', connected: true });
    });

    // Ping interval
    setInterval(() => {
      for (const [_, client] of this.clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try { client.ws.ping(); } catch { /* ignore */ }
        }
      }
    }, 30_000);
  }

  private handleWsMessage(clientId: string, msg: Record<string, unknown>): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    const type = msg.type as string;

    switch (type) {
      case 'ping':
        this.sendWs(client.ws, { type: 'pong' });
        break;

      case 'subscribe':
        // Just acknowledge — single agent bridge
        this.sendWs(client.ws, { type: 'subscribed', agent_id: msg.agent_id });
        break;

      case 'message': {
        const content = ((msg.content as string) || '').trim();
        if (!content) {
          this.sendWs(client.ws, { type: 'error', data: { message: 'content is required' } });
          break;
        }

        if (!this.initialized || !this.claudeProcess?.stdin?.writable) {
          this.sendWs(client.ws, { type: 'error', data: { message: 'Claude process not ready' } });
          break;
        }

        // If already executing, queue the message — it'll be processed when the current one completes.
        if (this.activeThreadId) {
          this.messageQueue.push({ clientId, content });
          this.sendWs(client.ws, { type: 'message_ack', data: { queued: true, session_id: this.sessionId } });
          break;
        }

        this.startClaudeExecution(clientId, content);
        break;
      }

      case 'sync':
        // Return replay history from resumed session
        this.sendWs(client.ws, {
          type: 'sync_history',
          session_id: this.sessionId,
          messages: this.replayHistory.map((m, i) => ({
            id: m.id ?? `replay-${i}`,
            role: m.role,
            content: m.content,
            created_at: m.createdAt,
          })),
        });
        break;

      case 'create_session':
        this.sendWs(client.ws, {
          type: 'session_created',
          session_id: this.sessionId,
          agent: {
            name: this.opts.agentName ?? 'Claude Code',
            id: this.opts.agentId ?? 'claude-bridge',
          },
        });
        break;

      case 'stream_ack':
      case 'cancel':
        break;
    }
  }

  // ── Session persistence helpers ──

  private tryParseJson(line: string): Record<string, unknown> | null {
    try {
      const trimmed = line.trim();
      if (!trimmed) return null;
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private getSessionIdFile(): string {
    // Store in workspace dir (persistently mounted) — not home dir (ephemeral in containers)
    const workDir = this.opts.cwd ?? process.cwd();
    return path.join(workDir, '.claude-session-id');
  }

  private loadStoredSessionId(filePath: string): string | null {
    try {
      if (fs.existsSync(filePath)) {
        const id = fs.readFileSync(filePath, 'utf-8').trim();
        // Validate UUID format
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id)) {
          return id;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private saveSessionId(sessionId: string): void {
    try {
      const filePath = this.getSessionIdFile();
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, sessionId);
    } catch (e) {
      console.error(`[claude-bridge] Failed to save session ID: ${(e as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.claudeProcess && !this.claudeProcess.killed) {
      this.claudeProcess.kill('SIGTERM');
    }
    if (this.wss) {
      this.wss.close();
    }
    if (this.app) {
      await this.app.close();
    }
  }
}

/** Entry point — called from CLI command. */
export async function startClaudeBridge(opts: ClaudeBridgeOptions): Promise<void> {
  console.log(
    `[claude-bridge] Startup summary: ${JSON.stringify({
      agentId: opts.agentId,
      agentUsername: opts.agentUsername,
      model: opts.model,
      contextPrompt: summarizePromptForLog(opts.contextPrompt),
    })}`,
  );
  if (isBridgePromptDebugEnabled() && opts.contextPrompt?.trim()) {
    console.log(`[claude-bridge] Context prompt begin\n${opts.contextPrompt}\n[claude-bridge] Context prompt end`);
  }

  const bridge = new ClaudeBridge(opts);

  process.on('SIGTERM', async () => {
    console.log('[claude-bridge] Received SIGTERM, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    console.log('[claude-bridge] Received SIGINT, shutting down...');
    await bridge.stop();
    process.exit(0);
  });

  await bridge.start();

  // Keep alive
  await new Promise<void>(() => {});
}
