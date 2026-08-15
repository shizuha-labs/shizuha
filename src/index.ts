import * as crypto from 'node:crypto';
import { Command } from 'commander';
import { runAgent, createTurnTelemetrySink, setActiveTelemetryWindow } from './agent/loop.js';
import { TurnTelemetryWindow, recordTurnTelemetry } from './telemetry/turn-telemetry.js';
import {
  classifyPromptSource,
  estimatePromptTokenBudget,
  heartbeatBudgetConfig,
  type HeartbeatCompactionAction,
} from './agent/heartbeat-hygiene.js';
import { StruggleAnalyzer } from './agent/struggle-analyzer.js';
import { setupStrugglePulseAutoFiler } from './telemetry/struggle-auto-filer.js';
import { toNDJSON } from './events/stream.js';
import { writeExecEvent, type ExecAcc } from './cli/exec-channel.js';
import { loadConfig } from './config/loader.js';
import { redactConfigForOutput } from './config/redaction.js';
import { launchTUI } from './tui/App.js';
import { StateStore } from './state/store.js';
import type { AgentConfig, MCPServerConfig } from './agent/types.js';
import type { PermissionMode } from './permissions/types.js';
import { logger } from './utils/logger.js';
import { inert, isInert } from './utils/display.js';
import {
  BackgroundTaskWaitController,
  decideBackgroundTaskContinuation,
  isBackgroundTaskWaitContentIntent,
} from './agent/background-task-wait.js';
import {
  exitOnOptionPreflightError,
  preflightOrExit,
  requireOptionalNonEmpty,
} from './cli/option-preflight.js';
import {
  AUTONOMOUS_MAX_TOKENS_CONTINUE_PROMPT,
  incompleteTurnError,
  MAX_THINKING_ONLY_RECOVERY,
  shouldContinueAutonomousMaxTokens,
} from './agent/incomplete-turn.js';
import { reasoningTextFromContent } from './agent/content.js';

// Keep CLI output clean from Node runtime deprecation warnings.
process.noDeprecation = true;


const program = new Command();

function truncateInline(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function summarizeToolInput(input: Record<string, unknown>, maxKeys = 4): string {
  const entries = Object.entries(input);
  if (entries.length === 0) return '';
  const shown = entries.slice(0, maxKeys).map(([key, value]) => {
    if (typeof value === 'string') return [key, truncateInline(value, 80)];
    if (typeof value === 'number' || typeof value === 'boolean' || value == null) return [key, value];
    if (Array.isArray(value)) return [key, `[${value.length} items]`];
    return [key, '[object]'];
  });
  const payload = Object.fromEntries(shown);
  const json = JSON.stringify(payload);
  const suffix = entries.length > maxKeys ? ' ...' : '';
  return `${truncateInline(json, 220)}${suffix}`;
}

function formatToolInvocation(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'bash') {
    const command = typeof input.command === 'string' ? input.command : '';
    if (!command) return 'bash';
    return `/bin/bash -lc ${shellQuoteSingle(truncateInline(command, 260))}`;
  }
  const summarized = summarizeToolInput(input);
  return summarized ? `${toolName} ${summarized}` : toolName;
}

program
  .name('shizuha')
  .description('Shizuha universal coding agent')
  .version('0.1.0')
  .enablePositionalOptions()
  .option('-p, --prompt <text>', 'Run a prompt non-interactively (like exec)')
  .option('--model <model>', 'Model to use')
  .option('--cwd <dir>', 'Working directory')
  .option('--mode <mode>', 'Permission mode (plan/supervised/autonomous)')
  .option('--resume <session-id>', 'Resume an existing session by ID')
  .option('--json', 'Output NDJSON events (with -p)')
  .action(async (opts) => {
    // SCLI-400/PLAT-5893/SCLI-492: the root action exposes --mode/--resume and
    // -p. Validate the shared option domains BEFORE any provider/session/TUI
    // work — an invalid/case-mismatched/empty/whitespace --mode must never
    // silently enter a run or create state.
    const pf = preflightOrExit({
      mode: opts.mode,
      thinking: opts.thinking,
      effort: opts.effort,
      maxTurns: opts.maxTurns,
      temperature: opts.temperature,
      sandbox: opts.sandbox,
    });

    // If -p is given, run in exec mode (non-interactive)
    if (opts.prompt) {
      const config: AgentConfig = {
        model: opts.model,
        cwd: opts.cwd as string,
        maxTurns: 0,
        permissionMode: (pf.mode ?? 'autonomous') as AgentConfig['permissionMode'],
        mcpServers: [],
        temperature: 0,
      };

      const isJSON = opts.json as boolean;
      let hadFatalError = false;
      let completeSeen = false;
      const acc: ExecAcc = { finalText: '', failed: false, bufferedDiags: [] };

      for await (const event of runAgentWithPrompt(config, opts.prompt as string, opts.resume as string | undefined)) {
        if (event.type === 'error') {
          hadFatalError = true;
        } else if (event.type === 'turn_complete') {
          hadFatalError = false;
        } else if (event.type === 'complete') {
          completeSeen = true;
        }
        writeExecEvent(event, isJSON, acc);
      }
      // Match the exec subcommand: top-level -p is also a one-shot path, and
      // provider keep-alive pools can otherwise keep the event loop alive.
      process.exit(hadFatalError || !completeSeen ? 1 : 0);
    }

    // NO first-run sign-in gate. The CLI must be usable WITHOUT signing in —
    // Shizuha ID is OPTIONAL (operator directive 2026-06-23). Auth is LAZY: the TUI
    // launches freely and only surfaces a (non-blocking) "configure a provider" hint
    // when none is set (see session.ts first-run detection), and only errors/prompts
    // for credentials when the user actually invokes a provider that needs them
    // (e.g. cortex). Sign-in is available on demand via `shizuha auth cortex` /
    // `shizuha login`, never forced at launch.

    // Default: launch interactive TUI
    launchTUI({
      cwd: opts.cwd as string,
      model: opts.model as string | undefined,
      mode: pf.mode as PermissionMode | undefined,
      resumeSessionId: opts.resume as string | undefined,
    });
  });

program
  .command('resume <session-id>')
  .description('Resume an existing interactive session')
  .option('--cwd <dir>', 'Override the stored session working directory')
  .option('--model <model>', 'Override the stored session model')
  .option('--mode <mode>', 'Permission mode (plan/supervised/autonomous)')
  .action((sessionId: string, opts) => {
    // PLAT-5893/SCLI-178: resume exposes --mode like the root/exec/gateway
    // actions. Run the same shared option-domain preflight BEFORE any session
    // load / TUI launch — an invalid/case-mismatched/empty/whitespace --mode
    // must reject pre-init instead of entering the full resume path and
    // rendering a blank permission-mode footer.
    const pf = preflightOrExit({
      mode: opts.mode,
    });

    if (!isInert(sessionId)) {
      console.error(`Invalid session id: ${inert(sessionId)}`);
      process.exitCode = 1;
      return;
    }
    const store = new StateStore();
    const session = store.loadSession(sessionId);
    store.close();
    if (!session) {
      console.error(`Session not found: ${inert(sessionId)}`);
      process.exitCode = 1;
      return;
    }

    launchTUI({
      cwd: (opts.cwd as string | undefined) ?? session.cwd,
      model: opts.model as string | undefined,
      mode: pf.mode as PermissionMode | undefined,
      resumeSessionId: sessionId,
    });
  });

program
  .command('exec')
  .description('Execute a prompt and return results')
  .requiredOption('-p, --prompt <text>', 'The prompt to execute')
  .option('-m, --model <model>', 'Model to use')
  .option('--cwd <dir>', 'Working directory')
  .option('--max-turns <n>', 'Maximum turns', '0')
  .option('--mode <mode>', 'Permission mode (plan/supervised/autonomous)', 'autonomous')
  .option('--json', 'Output NDJSON events')
  .option('--mcp-server <cmd>', 'MCP server command (can be repeated)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--temperature <n>', 'Temperature')
  .option('--thinking <level>', 'Claude extended thinking (off/on)')
  .option('--effort <level>', 'Codex reasoning effort (low/medium/high/xhigh/ultra/max)')
  .option('--sandbox <mode>', 'OS-level sandbox (unrestricted/read-only/workspace-write/external)')
  .option('--toolset <name>', 'Tool profile (full/safe/local/developer/architect/engineer/qa_engineer/...)')
  .option('--resume <session-id>', 'Resume an existing session by ID')
  .action(async (opts) => {
    // SCLI-400: semantic preflight before auth/provider/MCP/runtime work.
    const pf = preflightOrExit({
      mode: opts.mode,
      thinking: opts.thinking,
      effort: opts.effort,
      maxTurns: opts.maxTurns,
      temperature: opts.temperature,
      sandbox: opts.sandbox,
      toolset: opts.toolset,
    });

    const mcpServers: MCPServerConfig[] = (opts.mcpServer as string[]).map((cmd, i) => ({
      name: `mcp_${i}`,
      transport: 'stdio' as const,
      command: cmd.split(' ')[0]!,
      args: cmd.split(' ').slice(1),
    }));

    const config: AgentConfig = {
      model: opts.model,
      cwd: opts.cwd as string,
      maxTurns: pf.maxTurns ?? 0,
      permissionMode: (pf.mode ?? 'autonomous') as AgentConfig['permissionMode'],
      mcpServers,
      temperature: pf.temperature,
      thinkingLevel: pf.thinking,
      reasoningEffort: pf.effort,
      sandboxMode: pf.sandbox as AgentConfig['sandboxMode'],
      toolset: pf.toolset,
    };

    // Add user prompt as initial message — the loop needs to know the user request
    // We pass it through systemPrompt augmentation + messages
    const isJSON = opts.json as boolean;

    // Run agent with user prompt injected
    const agentConfig = {
      ...config,
      systemPrompt: undefined, // Use default
    };

    // Create a patched runAgent that injects the user message
    let hadFatalError = false;
    let completeSeen = false;
    const acc: ExecAcc = { finalText: '', failed: false, bufferedDiags: [] };

    for await (const event of runAgentWithPrompt(agentConfig, opts.prompt as string, opts.resume as string | undefined)) {
      if (event.type === 'error') {
        hadFatalError = true;
      } else if (event.type === 'turn_complete') {
        hadFatalError = false;
      } else if (event.type === 'complete') {
        completeSeen = true;
      }
      writeExecEvent(event, isJSON, acc);
    }
    // Force exit — provider HTTP keep-alive pools (e.g. undici Agent in vllm provider
    // with 60s keepAliveTimeout) keep the event loop alive otherwise, hanging the CLI
    // after the final "complete" event for up to 10 min. exec is by definition a
    // one-shot; the OS reaps any lingering sockets.
    process.exit(hadFatalError || !completeSeen ? 1 : 0);
  });

program
  .command('pipe')
  .description('Persistent stdin/stdout NDJSON pipe for warm pool integration')
  .option('-m, --model <model>', 'Model to use')
  .option('--mode <mode>', 'Permission mode', 'autonomous')
  .option('--system-prompt <text>', 'System prompt override')
  .option('--max-turns <n>', 'Maximum turns per message', '0')
  .option('--mcp-server <spec>', 'MCP server as name:jsonconfig (repeatable)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--thinking <level>', 'Claude extended thinking (off/on)')
  .option('--effort <level>', 'Codex reasoning effort (low/medium/high/xhigh/ultra/max)')
  .action(async (opts) => {
    // SCLI-400: reject invalid mode/thinking/effort/max-turns before stdin/runtime.
    const pf = preflightOrExit({
      mode: opts.mode,
      thinking: opts.thinking,
      effort: opts.effort,
      maxTurns: opts.maxTurns,
    });

    const { createInterface } = await import('readline');

    // Parse MCP servers from name:{jsonconfig} format (from chatbot_service)
    const mcpServers: MCPServerConfig[] = (opts.mcpServer as string[]).map((spec) => {
      const colonIdx = spec.indexOf(':');
      if (colonIdx === -1) return { name: spec, transport: 'stdio' as const };
      const name = spec.slice(0, colonIdx);
      try {
        const cfg = JSON.parse(spec.slice(colonIdx + 1));
        // Resolve transport from explicit type field (DB MCPServer.get_config()),
        // falling back to URL-based detection for backwards compatibility.
        const TYPE_MAP: Record<string, MCPServerConfig['transport']> = {
          sse: 'sse', http: 'streamable-http', ws: 'websocket',
          'streamable-http': 'streamable-http', websocket: 'websocket', stdio: 'stdio',
        };
        const transport: MCPServerConfig['transport'] =
          TYPE_MAP[cfg.type ?? cfg.transport ?? ''] ??
          (cfg.url ? 'streamable-http' : 'stdio');
        return {
          name,
          transport,
          command: cfg.command,
          args: cfg.args,
          url: cfg.url,
          env: cfg.env,
          headers: cfg.headers,
        };
      } catch {
        return { name, transport: 'stdio' as const, command: spec.slice(colonIdx + 1) };
      }
    });

    const rl = createInterface({ input: process.stdin, terminal: false });

    /** Write a CCS-compatible NDJSON line to stdout. */
    function emitCCS(obj: Record<string, unknown>): void {
      process.stdout.write(JSON.stringify(obj) + '\n');
    }

    // Map upstream runtime session id -> local shizuha session id.
    // If upstream omits session_id, keep a stable default for this pipe process.
    const pipeSessionMap = new Map<string, string>();
    const DEFAULT_PIPE_SESSION_KEY = '__default__';

    // SCLI-399: validate every decoded NDJSON value before field access so
    // null/arrays/scalars/malformed lines cannot crash the warm-pool process.
    const { classifyPipeLine, invalidRecordEvent } = await import('./pipe/ndjson-record.js');
    let lineNumber = 0;

    for await (const line of rl) {
      lineNumber += 1;
      let classified;
      try {
        classified = classifyPipeLine(line);
      } catch {
        // Defense in depth — classifier must never throw, but never kill the pool.
        emitCCS(invalidRecordEvent({
          ok: false,
          kind: 'malformed_json',
          error: 'NDJSON record could not be classified',
        }, lineNumber));
        continue;
      }
      if (classified === null) {
        // blank / whitespace-only — silent skip (empty EOF contract)
        continue;
      }
      if (!classified.ok) {
        emitCCS(invalidRecordEvent(classified, lineNumber));
        continue;
      }
      const { userContent, incomingSessionId } = classified;
      const sessionKey = incomingSessionId.trim() || DEFAULT_PIPE_SESSION_KEY;
      const resumeSessionId = pipeSessionMap.get(sessionKey);

      const config: AgentConfig = {
        model: opts.model as string,
        cwd: process.cwd(),
        maxTurns: pf.maxTurns ?? 0,
        permissionMode: (pf.mode ?? 'autonomous') as AgentConfig['permissionMode'],
        mcpServers,
        systemPrompt: opts.systemPrompt as string | undefined,
        thinkingLevel: pf.thinking,
        reasoningEffort: pf.effort,
      };

      let contentAccum = '';

      try {
        for await (const event of runAgentWithPrompt(config, userContent, resumeSessionId)) {
          switch (event.type) {
            case 'session_start':
              pipeSessionMap.set(sessionKey, event.sessionId);
              break;
            case 'content':
              contentAccum += event.text;
              emitCCS({
                type: 'stream_event',
                event: {
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: event.text },
                },
              });
              break;
            case 'tool_start':
              {
                const commandPreview = formatToolInvocation(event.toolName, event.input);
                emitCCS({
                  type: 'stream_event',
                  event: {
                    type: 'content_block_start',
                    content_block: {
                      type: 'tool_use',
                      id: event.toolCallId,
                      name: event.toolName,
                      input: event.input,
                      command_preview: commandPreview,
                    },
                  },
                });
              }
              break;
            case 'tool_complete':
              {
                const rawResult = typeof event.result === 'string' ? event.result : '';
                const normalizedResult = rawResult.replace(/\s+/g, ' ').trim();
                const resultTail = normalizedResult.length > 240
                  ? `${normalizedResult.slice(0, 237)}...`
                  : normalizedResult;
                const metadata = event.metadata && typeof event.metadata === 'object'
                  ? event.metadata as Record<string, unknown>
                  : undefined;
                const exitCode = metadata && Number.isFinite(Number(metadata.exitCode))
                  ? Number(metadata.exitCode)
                  : undefined;
                const isFailure = event.isError === true
                  || (typeof exitCode === 'number' && exitCode !== 0);
                emitCCS({
                  type: 'stream_event',
                  event: {
                    type: 'content_block_stop',
                    tool: event.toolName,
                    duration_ms: event.durationMs,
                    ...(isFailure ? { status: 'error', is_error: true } : {}),
                    ...(isFailure && typeof exitCode === 'number' ? { exit_code: exitCode } : {}),
                    ...(isFailure && resultTail ? { result_tail: resultTail } : {}),
                  },
                });
              }
              break;
            case 'reasoning':
              if (event.summaries.length > 0) {
                emitCCS({
                  type: 'stream_event',
                  event: {
                    type: 'reasoning',
                    summaries: event.summaries,
                  },
                });
              }
              break;
            case 'error':
              emitCCS({
                type: 'result',
                subtype: 'error',
                error: event.error,
              });
              break;
            case 'complete':
              emitCCS({
                type: 'result',
                result: contentAccum,
                usage: {
                  input_tokens: event.totalInputTokens,
                  output_tokens: event.totalOutputTokens,
                },
                cost_usd: 0,
              });
              break;
            // session_start, turn_start, turn_complete, thinking,
            // tool_progress, input_injected — skip (internal)
          }
        }
      } catch (err) {
        emitCCS({
          type: 'result',
          subtype: 'error',
          error: (err as Error).message,
        });
      }

      // Reset for next message
      contentAccum = '';
    }
  });

program
  .command('serve')
  .description('Start the HTTP API server (legacy — prefer "gateway")')
  .option('-p, --port <n>', 'Port number', '8015')
  .option('-h, --host <addr>', 'Host address', '0.0.0.0')
  .action(async (opts) => {
    // PLAT-5893: legacy serve shares the SCLI-400 port preflight. Invalid ports
    // reject pre-start with a bounded diagnostic — never a raw ERR_SOCKET_BAD_PORT.
    const pf = preflightOrExit({
      port: opts.port,
      requirePortField: true,
    });
    const { startServer } = await import('./server.js');
    await startServer(pf.port!, opts.host as string);
  });

program
  .command('gateway')
  .description('Start the agent as a persistent gateway process')
  .option('-p, --port <n>', 'HTTP port', '8015')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Default model')
  .option('--cwd <dir>', 'Working directory')
  .option('--mode <mode>', 'Permission mode (plan/supervised/autonomous)', 'autonomous')
  .option('--agent-id <id>', 'Agent identity (for eternal session)')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username (for per-agent config from ~/.shizuha/agents/{username}/)')
  .option('--thinking <level>', 'Thinking level (off/on/low/medium/high)')
  .option('--effort <level>', 'Reasoning effort (low/medium/high/xhigh/ultra/max)')
  .option('--context-prompt <prompt>', 'Platform context prompt (fallback if no per-agent CLAUDE.md)')
  .option('--context-prompt-file <path>', 'Platform context prompt read from a file (avoids the OS argv size limit)')
  .option('--connect <url>', 'Connect to shizuha-agent WebSocket (ws://host:port/ws/chat/)')
  .option('--connect-token <jwt>', 'JWT token for shizuha-agent connection')
  .option('--telegram-token <token>', 'Telegram Bot API token (or TELEGRAM_BOT_TOKEN env)')
  .option('--telegram-chat-ids <ids>', 'Comma-separated allowed Telegram chat IDs')
  .option('--discord-token <token>', 'Discord Bot token (or DISCORD_BOT_TOKEN env)')
  .option('--discord-guild-ids <ids>', 'Comma-separated allowed Discord guild IDs')
  .option('--discord-mode <mode>', 'Discord respond mode: mention, dm, all', 'mention')
  .option('--whatsapp-token <token>', 'WhatsApp Business API access token (or WHATSAPP_ACCESS_TOKEN env)')
  .option('--whatsapp-phone-id <id>', 'WhatsApp phone number ID (or WHATSAPP_PHONE_NUMBER_ID env)')
  .option('--whatsapp-verify-token <token>', 'WhatsApp webhook verify token (or WHATSAPP_VERIFY_TOKEN env)')
  .option('--whatsapp-webhook-port <n>', 'WhatsApp webhook port', '8016')
  .option('--whatsapp-numbers <nums>', 'Comma-separated allowed WhatsApp numbers')
  .option('--whatsapp-app-secret <secret>', 'Meta app secret for signature verification')
  .option('--slack-bot-token <token>', 'Slack Bot token xoxb-... (or SLACK_BOT_TOKEN env)')
  .option('--slack-app-token <token>', 'Slack App token xapp-... for Socket Mode (or SLACK_APP_TOKEN env)')
  .option('--slack-channel-ids <ids>', 'Comma-separated allowed Slack channel IDs')
  .option('--slack-mode <mode>', 'Slack respond mode: mention, dm, all', 'mention')
  .option('--signal-api-url <url>', 'Signal CLI REST API URL (or SIGNAL_API_URL env)')
  .option('--signal-phone <phone>', 'Registered Signal phone number (or SIGNAL_PHONE_NUMBER env)')
  .option('--signal-numbers <nums>', 'Comma-separated allowed Signal phone numbers')
  .option('--line-token <token>', 'LINE channel access token (or LINE_CHANNEL_ACCESS_TOKEN env)')
  .option('--line-secret <secret>', 'LINE channel secret (or LINE_CHANNEL_SECRET env)')
  .option('--line-webhook-port <n>', 'LINE webhook port', '8018')
  .option('--imessage-url <url>', 'BlueBubbles server URL (or BLUEBUBBLES_SERVER_URL env)')
  .option('--imessage-password <pw>', 'BlueBubbles server password (or BLUEBUBBLES_PASSWORD env)')
  .option('--imessage-webhook-port <n>', 'iMessage webhook port', '8019')
  .option('--imessage-handles <handles>', 'Comma-separated allowed iMessage handles')
  .action(async (opts) => {
    // SCLI-400/PLAT-5893: validate mode/thinking/effort/port/channel-modes/
    // webhook-ports before any runtime init. Explicit-empty/whitespace/case-
    // mismatch must fail closed with a bounded diagnostic, never reach a bind
    // or provider lookup.
    const pf = preflightOrExit({
      mode: opts.mode,
      thinking: opts.thinking,
      effort: opts.effort,
      port: opts.port,
      requirePortField: true,
      discordMode: opts.discordMode,
      slackMode: opts.slackMode,
      lineWebhookPort: opts.lineWebhookPort,
      whatsappWebhookPort: opts.whatsappWebhookPort,
      imessageWebhookPort: opts.imessageWebhookPort,
      host: opts.host,
      contextPromptFile: opts.contextPromptFile,
    });

    const { AgentProcess } = await import('./gateway/agent-process.js');
    const { HttpChannel } = await import('./gateway/channels/http.js');
    let contextPrompt = opts.contextPrompt as string | undefined;
    if (pf.contextPromptFile) {
      try {
        const fsmod = await import('node:fs');
        contextPrompt = fsmod.readFileSync(pf.contextPromptFile, 'utf-8');
      } catch (err) {
        // Fatal: unreadable context file must not continue into session/provider work.
        console.error(
          `Error: Invalid --context-prompt-file ${JSON.stringify(String(pf.contextPromptFile))}; ${(err as Error).message}`,
        );
        process.exit(1);
      }
    }

    const agent = new AgentProcess({
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      model: opts.model as string | undefined,
      cwd: opts.cwd as string,
      permissionMode: (pf.mode ?? 'autonomous') as 'plan' | 'supervised' | 'autonomous',
      thinkingLevel: pf.thinking,
      reasoningEffort: pf.effort,
      contextPrompt,
      channels: [], // Channels registered below
    });

    // HTTP channel (always enabled)
    const httpPort = pf.port!;
    const httpChannel = new HttpChannel({
      port: httpPort,
      host: (pf.host ?? '0.0.0.0') as string,
      getMessages: () => agent.getMessages(),
      getSessionId: () => agent.getSessionId(),
      getFanOutSettings: () => agent.getFanOutSettings(),
      setFanOut: (type, enabled) => agent.setFanOut(type as any, enabled),
      getRuntimeHealth: () => agent.getRuntimeHealth(),
      armRuntimeRollDrain: (request) => agent.armRuntimeRollDrain(request),
      getRuntimeRollDrain: () => agent.runtimeRollDrainSnapshot(),
    });
    agent.registerChannel(httpChannel);

    // Prometheus metrics server on :9103 (SCLI-74). Avoid colliding with the
    // gateway HTTP port — if they match, bump metrics to httpPort + 1.
    const rawMetricsPort = parseInt(process.env['SHIZUHA_METRICS_PORT'] ?? '9103', 10);
    const metricsPort = rawMetricsPort === httpPort ? rawMetricsPort + 1 : rawMetricsPort;
    const { startMetricsServer } = await import('./metrics/server.js');
    startMetricsServer(metricsPort);

    // ShizuhaWS channel (if --connect provided)
    if (opts.connect) {
      const token = (opts.connectToken as string)
        ?? process.env['SHIZUHA_AGENT_TOKEN']
        ?? '';
      if (!token) {
        console.error('Error: --connect-token or SHIZUHA_AGENT_TOKEN env required for WS connection');
        process.exit(1);
      }
      const { ShizuhaWSChannel } = await import('./gateway/channels/shizuha-ws.js');
      const { EventLog } = await import('./shared/event-log.js');
      const eventLog = new EventLog();
      const wsChannel = new ShizuhaWSChannel({
        type: 'shizuha-ws',
        url: opts.connect as string,
        token,
        agentId: opts.agentId as string | undefined,
        reconnect: true,
        eventLog,
        onAuthPending: async (info) => {
          // WhatsApp "Use Here" model: auto-evict when starting a new runner.
          // The user explicitly started this process, so they want it running here.
          const names = info.existingRunners.map((r) => r.agent_name).join(', ');
          console.log(`[gateway] Another runner is connected (${names}). Taking over...`);
          return 'evict';
        },
        onEvicted: (reason) => {
          console.log(`[gateway] Evicted by another runner: ${reason}`);
          console.log('[gateway] Shutting down — another instance has taken over.');
          // Allow the close handler to run (it won't reconnect due to eviction flag)
        },
      });
      agent.registerChannel(wsChannel);
    }

    // Connect channel — unified messaging through shizuha-connect.
    // Auto-constructs the WS URL from SHIZUHA_PLATFORM_URL (injected by daemon).
    // Each agent maintains a persistent WS to Connect's AgentChatConsumer.
    // The agent self-authenticates using AGENT_USERNAME + AGENT_PASSWORD.
    {
      const connectWsUrl = process.env['CONNECT_WS_URL']  // Explicit override
        ?? (() => {
          const platformUrl = process.env['SHIZUHA_PLATFORM_URL'];
          if (!platformUrl) return null;
          const wsScheme = platformUrl.startsWith('https') ? 'wss' : 'ws';
          const host = platformUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
          return `${wsScheme}://${host}/connect/ws/connect/agent/`;
        })();
      if (connectWsUrl) {
        const { ConnectChannel } = await import('./gateway/channels/connect.js');
        const connectChannel = new ConnectChannel({
          type: 'connect',
          url: connectWsUrl,
          token: '',  // Empty — ConnectChannel.selfAuthenticate() will login
          agentId: opts.agentId as string | undefined,
          reconnect: true,
        });
        agent.registerChannel(connectChannel);
      }
    }

    // Telegram channel (if --telegram-token or TELEGRAM_BOT_TOKEN provided)
    const telegramToken = (opts.telegramToken as string | undefined)
      ?? process.env['TELEGRAM_BOT_TOKEN'];
    if (telegramToken) {
      const { TelegramChannel } = await import('./gateway/channels/telegram.js');
      const chatIdStr = (opts.telegramChatIds as string | undefined)
        ?? process.env['TELEGRAM_ALLOWED_CHAT_IDS']
        ?? '';
      const allowedChatIds = chatIdStr
        ? chatIdStr.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
        : undefined;
      const telegramChannel = new TelegramChannel({
        type: 'telegram',
        botToken: telegramToken,
        allowedChatIds,
      });
      agent.registerChannel(telegramChannel);
    }

    // Discord channel (if --discord-token or DISCORD_BOT_TOKEN provided)
    const discordToken = (opts.discordToken as string | undefined)
      ?? process.env['DISCORD_BOT_TOKEN'];
    if (discordToken) {
      const { DiscordChannel } = await import('./gateway/channels/discord.js');
      const guildIdStr = (opts.discordGuildIds as string | undefined)
        ?? process.env['DISCORD_ALLOWED_GUILD_IDS']
        ?? '';
      const allowedGuildIds = guildIdStr
        ? guildIdStr.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const discordChannel = new DiscordChannel({
        type: 'discord',
        botToken: discordToken,
        allowedGuildIds,
        respondMode: (pf.discordMode ?? 'mention') as 'mention' | 'dm' | 'all',
      });
      agent.registerChannel(discordChannel);
    }

    // WhatsApp channel (if --whatsapp-token or WHATSAPP_ACCESS_TOKEN provided)
    const waToken = (opts.whatsappToken as string | undefined)
      ?? process.env['WHATSAPP_ACCESS_TOKEN'];
    const waPhoneId = (opts.whatsappPhoneId as string | undefined)
      ?? process.env['WHATSAPP_PHONE_NUMBER_ID'];
    if (waToken && waPhoneId) {
      const {
        WhatsAppChannel,
        resolveWhatsAppVerifyToken,
        whatsappWebhookReadyMessage,
      } = await import('./gateway/channels/whatsapp.js');
      const verifyToken = resolveWhatsAppVerifyToken(
        opts.whatsappVerifyToken as string | undefined,
        process.env['WHATSAPP_VERIFY_TOKEN'],
      );
      if (!verifyToken) {
        console.error('Error: --whatsapp-verify-token or WHATSAPP_VERIFY_TOKEN env required for WhatsApp');
        process.exit(1);
      }
      const numbersStr = (opts.whatsappNumbers as string | undefined)
        ?? process.env['WHATSAPP_ALLOWED_NUMBERS']
        ?? '';
      const allowedNumbers = numbersStr
        ? numbersStr.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const waChannel = new WhatsAppChannel({
        type: 'whatsapp',
        accessToken: waToken,
        phoneNumberId: waPhoneId,
        verifyToken,
        webhookPort: pf.whatsappWebhookPort ?? 8016,
        allowedNumbers,
        appSecret: (opts.whatsappAppSecret as string | undefined)
          ?? process.env['WHATSAPP_APP_SECRET'],
      });
      agent.registerChannel(waChannel);
      console.log(whatsappWebhookReadyMessage(pf.whatsappWebhookPort ?? 8016));
    }

    // Slack channel (if --slack-bot-token or SLACK_BOT_TOKEN provided)
    const slackBotToken = (opts.slackBotToken as string | undefined)
      ?? process.env['SLACK_BOT_TOKEN'];
    const slackAppToken = (opts.slackAppToken as string | undefined)
      ?? process.env['SLACK_APP_TOKEN'];
    if (slackBotToken && slackAppToken) {
      const { SlackChannel } = await import('./gateway/channels/slack.js');
      const chanIdStr = (opts.slackChannelIds as string | undefined)
        ?? process.env['SLACK_ALLOWED_CHANNEL_IDS']
        ?? '';
      const allowedChannelIds = chanIdStr
        ? chanIdStr.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const slackChannel = new SlackChannel({
        type: 'slack',
        botToken: slackBotToken,
        appToken: slackAppToken,
        allowedChannelIds,
        respondMode: (pf.slackMode ?? 'mention') as 'mention' | 'dm' | 'all',
      });
      agent.registerChannel(slackChannel);
    }

    // Signal channel (if --signal-api-url or SIGNAL_API_URL provided)
    const signalApiUrl = (opts.signalApiUrl as string | undefined)
      ?? process.env['SIGNAL_API_URL'];
    const signalPhone = (opts.signalPhone as string | undefined)
      ?? process.env['SIGNAL_PHONE_NUMBER'];
    if (signalApiUrl && signalPhone) {
      const { SignalChannel } = await import('./gateway/channels/signal.js');
      const signalNumsStr = (opts.signalNumbers as string | undefined)
        ?? process.env['SIGNAL_ALLOWED_NUMBERS']
        ?? '';
      const allowedNumbers = signalNumsStr
        ? signalNumsStr.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const signalChannel = new SignalChannel({
        type: 'signal',
        apiUrl: signalApiUrl,
        phoneNumber: signalPhone,
        allowedNumbers,
      });
      agent.registerChannel(signalChannel);
    }

    // LINE channel (if --line-token or LINE_CHANNEL_ACCESS_TOKEN provided)
    const lineToken = (opts.lineToken as string | undefined)
      ?? process.env['LINE_CHANNEL_ACCESS_TOKEN'];
    const lineSecret = (opts.lineSecret as string | undefined)
      ?? process.env['LINE_CHANNEL_SECRET'];
    if (lineToken && lineSecret) {
      const { LineChannel } = await import('./gateway/channels/line.js');
      const lineChannel = new LineChannel({
        type: 'line',
        channelAccessToken: lineToken,
        channelSecret: lineSecret,
        webhookPort: pf.lineWebhookPort ?? 8018,
      });
      agent.registerChannel(lineChannel);
    }

    // iMessage channel (if --imessage-url or BLUEBUBBLES_SERVER_URL provided)
    const imessageUrl = (opts.imessageUrl as string | undefined)
      ?? process.env['BLUEBUBBLES_SERVER_URL'];
    const imessagePassword = (opts.imessagePassword as string | undefined)
      ?? process.env['BLUEBUBBLES_PASSWORD'];
    if (imessageUrl && imessagePassword) {
      const { IMessageChannel } = await import('./gateway/channels/imessage.js');
      const handlesStr = (opts.imessageHandles as string | undefined)
        ?? process.env['IMESSAGE_ALLOWED_HANDLES']
        ?? '';
      const allowedHandles = handlesStr
        ? handlesStr.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const imessageChannel = new IMessageChannel({
        type: 'imessage',
        serverUrl: imessageUrl,
        password: imessagePassword,
        webhookPort: parseInt(opts.imessageWebhookPort as string, 10),
        allowedHandles,
      });
      agent.registerChannel(imessageChannel);
    }

    // Initialize (load config, connect providers, MCP, etc.)
    await agent.initialize();

    // Start — runs forever
    await agent.start();
  });

program
  .command('claude-bridge')
  .description('Bridge a persistent Claude Code CLI process to the gateway HTTP/WS protocol')
  .option('-p, --port <n>', 'HTTP port', '8019')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Claude model', 'claude-opus-4-7')
  .option('--cwd <dir>', 'Working directory')
  .option('--agent-id <id>', 'Agent identity')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username')
  .option('--thinking <level>', 'Thinking level (off/on/low/medium/high)')
  .option('--effort <level>', 'Reasoning effort')
  .option('--context-prompt <prompt>', 'System prompt appendix')
  .option('--context-prompt-file <path>', 'System prompt appendix read from a file (avoids the OS argv size limit)')
  .action(async (opts) => {
    // SCLI-400: semantic preflight before bridge bootstrap.
    const pf = preflightOrExit({
      thinking: opts.thinking,
      effort: opts.effort,
      port: opts.port,
      requirePortField: true,
      host: opts.host,
      contextPromptFile: opts.contextPromptFile,
    });
    const { startClaudeBridge } = await import('./claude-bridge/index.js');
    if (pf.contextPromptFile) {
      try {
        const fsmod = await import('node:fs');
        opts.contextPrompt = fsmod.readFileSync(pf.contextPromptFile, 'utf-8');
      } catch (err) {
        console.error(`Error: Invalid --context-prompt-file ${JSON.stringify(String(pf.contextPromptFile))}; ${(err as Error).message}`);
        process.exit(1);
      }
    }
    await startClaudeBridge({
      port: pf.port!,
      host: (pf.host ?? '0.0.0.0') as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      thinkingLevel: pf.thinking,
      reasoningEffort: pf.effort,
      contextPrompt: opts.contextPrompt as string | undefined,
      cwd: opts.cwd as string,
    });
  });

program
  .command('antigravity-bridge')
  .description('Bridge a persistent Antigravity CLI process to the gateway HTTP/WS protocol')
  .option('-p, --port <n>', 'HTTP port', '8021')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Antigravity/Gemini model', 'gemini-3.6-flash-high')
  .option('--effort <level>', 'Reasoning effort (low/medium/high/xhigh/ultra/max)')
  .option('--thinking <mode>', 'Thinking mode (on/off)')
  .option('--cwd <dir>', 'Working directory')
  .option('--agent-id <id>', 'Agent identity')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username')
  .option('--context-prompt <prompt>', 'System prompt appendix')
  .action(async (opts) => {
    // SCLI-400: semantic preflight before bridge bootstrap.
    const pf = preflightOrExit({
      thinking: opts.thinking,
      effort: opts.effort,
      port: opts.port,
      requirePortField: true,
      host: opts.host,
    });
    const { startAntigravityBridge } = await import('./antigravity-bridge/index.js');
    await startAntigravityBridge({
      port: pf.port!,
      host: (pf.host ?? '0.0.0.0') as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      contextPrompt: opts.contextPrompt as string | undefined,
      cwd: opts.cwd as string,
    });
  });

// Gemini CLI has been permanently replaced by Antigravity CLI. Refuse the old
// command so misconfigured deploys fail loud instead of spawning gemini-cli.
program
  .command('gemini-bridge')
  .description('(REMOVED) Use antigravity-bridge — Gemini CLI is no longer supported')
  .allowUnknownOption(true)
  .action(async () => {
    console.error(
      'FATAL: gemini-bridge has been removed. Gemini CLI is permanently replaced by '
      + 'Antigravity CLI. Use execution_method=antigravity_server and the '
      + 'antigravity-bridge command.',
    );
    process.exit(2);
  });

program
  .command('codex-bridge')
  .description('Bridge Codex CLI (codex exec --json) to the gateway HTTP/WS protocol')
  .option('-p, --port <n>', 'HTTP port', '8020')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Codex model', 'gpt-5.5')
  .option('--cwd <dir>', 'Working directory')
  .option('--agent-id <id>', 'Agent identity')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username')
  .option('--effort <level>', 'Reasoning effort')
  .option('--context-prompt <prompt>', 'System prompt appendix')
  .option('--context-prompt-file <path>', 'System prompt appendix read from a file (avoids the OS argv size limit)')
  .action(async (opts) => {
    // SCLI-400: semantic preflight before bridge bootstrap.
    const pf = preflightOrExit({
      thinking: opts.thinking,
      effort: opts.effort,
      port: opts.port,
      requirePortField: true,
      host: opts.host,
      contextPromptFile: opts.contextPromptFile,
      cwd: (opts.cwd as string | undefined) ?? '/workspace',
    });
    const { startCodexBridge } = await import('./codex-bridge/index.js');
    // Prometheus metrics server on :9103 (SCLI-74). The codex-bridge HTTP port
    // defaults to 8020 (not the gateway's 8080), so 9103 does not collide by
    // default, but keep the same collision handling as the gateway path in case
    // an operator runs codex-bridge on 9103 via --port. (CON-225)
    const rawMetricsPort = parseInt(process.env['SHIZUHA_METRICS_PORT'] ?? '9103', 10);
    const metricsPort = rawMetricsPort === pf.port! ? rawMetricsPort + 1 : rawMetricsPort;
    const { startMetricsServer } = await import('./metrics/server.js');
    startMetricsServer(metricsPort);
    let contextPrompt = opts.contextPrompt as string | undefined;
    if (pf.contextPromptFile) {
      try {
        const fsmod = await import('node:fs');
        contextPrompt = fsmod.readFileSync(pf.contextPromptFile, 'utf-8');
      } catch (err) {
        console.error(`Error: Invalid --context-prompt-file ${JSON.stringify(String(pf.contextPromptFile))}; ${(err as Error).message}`);
        process.exit(1);
      }
    }
    await startCodexBridge({
      port: pf.port!,
      host: (pf.host ?? '0.0.0.0') as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      reasoningEffort: pf.effort,
      contextPrompt,
      cwd: pf.cwd,
    });
  });

program
  .command('openclaw-bridge')
  .description('Bridge OpenClaw (openclaw agent --local --json) to the gateway HTTP/WS protocol')
  .option('-p, --port <n>', 'HTTP port', '8021')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Model to use', 'gpt-5.5')
  .option('--cwd <dir>', 'Working directory')
  .option('--agent-id <id>', 'Agent identity')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username')
  .option('--effort <level>', 'Reasoning effort')
  .option('--thinking <level>', 'Thinking level')
  .option('--context-prompt <prompt>', 'System prompt appendix')
  .option('--context-prompt-file <path>', 'System prompt appendix read from a file (avoids the OS argv size limit)')
  .action(async (opts) => {
    // SCLI-400: semantic preflight before bridge bootstrap.
    const pf = preflightOrExit({
      thinking: opts.thinking,
      effort: opts.effort,
      port: opts.port,
      requirePortField: true,
      host: opts.host,
      contextPromptFile: opts.contextPromptFile,
      cwd: (opts.cwd as string | undefined) ?? '/workspace',
    });
    const { startOpenClawBridge } = await import('./openclaw-bridge/index.js');
    let contextPrompt = opts.contextPrompt as string | undefined;
    if (pf.contextPromptFile) {
      try {
        const fsmod = await import('node:fs');
        contextPrompt = fsmod.readFileSync(pf.contextPromptFile, 'utf-8');
      } catch (err) {
        console.error(`Error: Invalid --context-prompt-file ${JSON.stringify(String(pf.contextPromptFile))}; ${(err as Error).message}`);
        process.exit(1);
      }
    }
    await startOpenClawBridge({
      port: pf.port!,
      host: (pf.host ?? '0.0.0.0') as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      reasoningEffort: pf.effort,
      thinkingLevel: pf.thinking,
      contextPrompt,
      cwd: pf.cwd,
    });
  });

program
  .command('browser-mcp')
  .description(
    'Run a local stdio MCP server exposing native browser/mouse/keyboard tools ' +
    '(PLAT-5106). Used by Claude/Codex/Gemini bridges after cron-mcp decommission; ' +
    'no HTTP sidecar required. Prefer SHIZUHA_BROWSER_MCP_URL when a pod-local ' +
    'HTTP browser sidecar is present instead.',
  )
  .allowUnknownOption(true)
  .action(async () => {
    const { runBrowserMcpServer } = await import('./browser-mcp/server.js');
    await runBrowserMcpServer();
  });

program
  .command('mcp-proxy')
  .description(
    'Run a local stdio MCP server that transparently proxies (with auto-reconnect) ' +
    'to a remote streamable-HTTP MCP server. Keeps claude-code\'s tools registered ' +
    'across backend restarts (PLAT-504/PLAT-427).',
  )
  .option('--name <service>', 'Logical service name (log label), e.g. pulse')
  .option('--upstream-url <url>', 'Remote streamable-HTTP MCP URL, e.g. http://host/mcp/pulse/mcp')
  .option(
    '--header <header>',
    'Extra upstream header "Key: Value" (repeatable). Bearer token comes from MCP_UPSTREAM_BEARER env.',
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .allowUnknownOption(true)
  .action(async (opts) => {
    const { resolveProxyConfig, runMcpProxy } = await import('./mcp-proxy/server.js');
    const config = resolveProxyConfig(
      {
        name: opts.name as string | undefined,
        upstreamUrl: opts.upstreamUrl as string | undefined,
        header: opts.header as string[] | undefined,
      },
      process.env,
    );
    await runMcpProxy(config);
  });

program
  .command('mcp-multiplexer')
  .description(
    'Run a single per-agent stdio MCP server that multiplexes multiple upstream ' +
    'MCP services into one process. Replaces N separate mcp-proxy processes with ' +
    'one, reducing CPU and process count (PLAT-3119).',
  )
  .option('--services <json>', 'JSON array of upstream service configs [{name,url,headers}]')
  .option('--liveness-interval <ms>', 'Liveness probe interval in ms', '30000')
  .allowUnknownOption(true)
  .action(async (opts) => {
    const { runMcpMultiplexer } = await import('./mcp-multiplexer/server.js');
    const servicesJson = (opts.services as string) || process.env['MCP_MUX_SERVICES'] || '[]';
    let services: Array<{ name: string; url: string; headers: Record<string, string> }>;
    try {
      services = JSON.parse(servicesJson) as Array<{ name: string; url: string; headers: Record<string, string> }>;
    } catch {
      console.error('mcp-multiplexer: --services must be valid JSON array');
      process.exit(1);
    }
    if (!Array.isArray(services) || services.length === 0) {
      console.error('mcp-multiplexer: at least one upstream service is required');
      process.exit(1);
    }
    await runMcpMultiplexer({
      services,
      livenessIntervalMs: parseInt(opts.livenessInterval as string, 10) || 30000,
    });
  });

program
  .command('config')
  .description('Show resolved configuration')
  .option('--cwd <dir>', 'Working directory')
  .action(async (opts) => {
    const config = await loadConfig(opts.cwd as string);
    console.log(JSON.stringify(redactConfigForOutput(config), null, 2));
  });

// ── Device pairing CLI commands ──

const devicesCmd = program
  .command('devices')
  .description('Manage paired devices');

devicesCmd
  .command('list')
  .description('List all paired devices')
  .action(async () => {
    const { listDevices: ld } = await import('./devices/store.js');
    const devices = ld();
    if (devices.length === 0) {
      console.log('No paired devices.');
      return;
    }
    console.log(`${devices.length} paired device(s):\n`);
    for (const d of devices) {
      const lastSeen = new Date(d.lastSeenAt).toLocaleString();
      const created = new Date(d.createdAt).toLocaleString();
      console.log(`  ${inert(d.deviceName)} (${inert(d.platform)})`);
      console.log(`    ID: ${inert(d.deviceId)}`);
      console.log(`    IP: ${inert(d.remoteIp)}`);
      console.log(`    Created: ${created}`);
      console.log(`    Last seen: ${lastSeen}`);
      console.log('');
    }
  });

devicesCmd
  .command('revoke <deviceId>')
  .description('Revoke a paired device')
  .action(async (deviceId: string) => {
    if (!isInert(deviceId)) {
      console.error(`Invalid device id: ${inert(deviceId)}`);
      process.exitCode = 1;
      return;
    }
    const { removeDevice: rd } = await import('./devices/store.js');
    const ok = rd(deviceId);
    if (ok) {
      console.log(`Device ${inert(deviceId)} revoked.`);
    } else {
      console.error(`Device ${inert(deviceId)} not found.`);
      process.exitCode = 1;
    }
  });

program
  .command('pair')
  .description('Generate a pairing code for remote device access')
  .option('--show-code', 'Display the pairing code and exit')
  .action(async (opts) => {
    const { generatePairingCode: gpc, formatCode: fc, CODE_TTL_MS: ttl } = await import('./devices/pairing.js');
    const { addPendingCode: apc } = await import('./devices/store.js');

    const code = gpc();
    const now = Date.now();
    apc({ code, createdAt: now, expiresAt: now + ttl });

    const formatted = fc(code);
    console.log(`\nPairing code: ${formatted}`);
    console.log(`Expires in ${ttl / 60000} minutes.\n`);
    console.log('Enter this code in the web UI to pair your device.');

    if (opts.showCode) return;

    // Keep process alive for the TTL duration so the code remains valid
    console.log('Waiting for device to pair... (Ctrl+C to cancel)\n');
    const { listDevices: ld } = await import('./devices/store.js');
    const startLen = ld().length;

    const checkInterval = setInterval(() => {
      const current = ld();
      if (current.length > startLen) {
        const newest = current[current.length - 1]!;
        console.log(`Device paired: ${inert(newest.deviceName)} (${inert(newest.platform)}) from ${inert(newest.remoteIp)}`);
        clearInterval(checkInterval);
        process.exit(0);
      }
    }, 1000);

    setTimeout(() => {
      clearInterval(checkInterval);
      console.log('Pairing code expired.');
      process.exit(0);
    }, ttl);
  });

// ── Auth CLI commands ──

const authCmd = program
  .command('auth')
  .description('Manage provider authentication');

authCmd
  .command('claude [token]')
  .description('Save a Claude API key or OAuth token')
  .action(async (token?: string) => {
    const { addAnthropicToken, setAnthropicApiKey, readCredentials } = await import('./config/credentials.js');

    if (!token) {
      // Interactive prompt
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      token = await new Promise<string>((resolve) => {
        rl.question('  Paste your Claude API key or OAuth token: ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    }

    if (!token) {
      console.error('  No token provided.');
      process.exitCode = 1;
      return;
    }

    const isApiKey = token.startsWith('sk-ant-api') || (token.startsWith('sk-') && !token.startsWith('sk-ant-oat'));
    const creds = readCredentials();

    if (isApiKey) {
      // API key — store for AnthropicProvider (shizuha exec, direct API calls)
      if (creds.anthropic?.apiKey === token) {
        console.log('\n  API key already saved.');
        return;
      }
      setAnthropicApiKey(token);
      console.log('\n  API key saved to ~/.shizuha/credentials.json');
      console.log('  Works with: shizuha exec -p "hello" --model claude-opus-4-7');
      console.log('');
      console.log('  Note: The dashboard Claude agent needs an OAuth token, not an API key.');
      console.log('  Run: claude setup-token');
    } else {
      // OAuth token — store for Claude Code bridge (dashboard agent)
      const existing = creds.anthropic?.tokens?.find((t) => t.token === token);
      if (existing) {
        console.log(`\n  Token already saved (label: ${existing.label}).`);
        return;
      }
      addAnthropicToken(token, `cli-${new Date().toISOString().slice(0, 10)}`);
      console.log('\n  OAuth token saved to ~/.shizuha/credentials.json');
    }

    // Check if daemon is running — guide user accordingly
    const { isDaemonRunning } = await import('./daemon/state.js');
    if (isDaemonRunning()) {
      console.log('  Restart daemon to pick up changes: shizuha down && shizuha up');
    } else {
      console.log('  Start the daemon: shizuha up');
    }
  });

authCmd
  .command('cortex [key]')
  .description('Save your Cortex inference API key (sk-cortex-…) for cortex/<model> runs')
  .action(async (key?: string) => {
    const { setCortexApiKey, readCredentials } = await import('./config/credentials.js');

    if (!key) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      key = await new Promise<string>((resolve) => {
        rl.question('  Paste your Cortex API key (sk-cortex-…): ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    }

    if (!key) {
      console.error('  No key provided.');
      process.exitCode = 1;
      return;
    }

    if (!key.startsWith('sk-cortex-')) {
      console.log('  Warning: a Cortex key normally starts with "sk-cortex-". Saving anyway.');
    }

    if (readCredentials().cortex?.apiKey === key) {
      console.log('\n  Cortex key already saved.');
      return;
    }
    setCortexApiKey(key);
    console.log('\n  Cortex key saved to ~/.shizuha/credentials.json');
    console.log('  Use it: shizuha exec -p "hello" --model cortex/DeepSeek-V4-Flash');
    console.log('  Or just run: shizuha');
  });

authCmd
  .command('codex')
  .description('Authenticate with OpenAI Codex via device code flow (free with ChatGPT)')
  .action(async () => {
    const { codexDeviceAuth } = await import('./auth/codex-device-auth.js');

    console.log('\n  Authenticating with ChatGPT (Codex)...');
    console.log('  Free with any ChatGPT account — uses gpt-5.5\n');

    try {
      const email = await codexDeviceAuth({
        onUserCode: (code, url) => {
          console.log(`  1. Open this link in your browser:`);
          console.log(`     ${url}\n`);
          console.log(`  2. Enter this code: ${code}\n`);
          console.log('  Waiting for authorization...');
        },
        onPolling: () => {
          process.stdout.write('.');
        },
        onSuccess: (email) => {
          console.log(`\n\n  Authenticated as ${email}`);
          console.log('  Credentials saved to ~/.shizuha/credentials.json\n');
          console.log('  You\'re ready! Run: shizuha');
        },
        onError: (error) => {
          console.error(`\n  Error: ${error}`);
        },
      });
    } catch (err) {
      console.error(`\n  Authentication failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

authCmd
  .command('status')
  .description('Show authentication status for all providers')
  .action(async () => {
    const { readCredentialsStrict, readCodexAccounts } = await import('./config/credentials.js');
    const { getShizuhaAuthStatus } = await import('./config/shizuhaAuth.js');

    // SCLI-425: distinguish a corrupt store from an absent one BEFORE rendering
    // any status line. Failure is atomic: stdout stays empty and exactly one
    // concise diagnostic goes to stderr.
    const credsResult = readCredentialsStrict();
    if (!credsResult.ok) {
      process.stderr.write(
        `shizuha: could not read credential store at ${process.env['HOME'] ?? '~'}/.shizuha/credentials.json — ${credsResult.error}.\n`,
      );
      process.stderr.write(
        'Recovery: fix that file or remove it (e.g. `rm -f ~/.shizuha/credentials.json`) to start clean.\n',
      );
      process.exitCode = 1;
      return;
    }
    const creds = credsResult.store;
    const shizuhaStatus = getShizuhaAuthStatus();

    console.log('Authentication Status\n');

    // Shizuha ID
    if (shizuhaStatus.loggedIn) {
      console.log(`  Shizuha ID: ${shizuhaStatus.username} (logged in)`);
    } else {
      console.log('  Shizuha ID: not logged in');
    }

    // Anthropic
    const anthropicCount = creds.anthropic?.tokens?.length ?? 0;
    const hasApiKey = !!(creds.anthropic?.apiKey || process.env['ANTHROPIC_API_KEY']);
    const parts: string[] = [];
    if (hasApiKey) parts.push('API key');
    if (anthropicCount > 0) parts.push(`${anthropicCount} OAuth token(s)`);
    if (parts.length > 0) {
      console.log(`  Anthropic: ${parts.join(' + ')}`);
    } else {
      console.log('  Anthropic: not configured');
    }

    // OpenAI
    if (creds.openai?.apiKey || process.env['OPENAI_API_KEY']) {
      console.log('  OpenAI: API key configured');
    } else {
      console.log('  OpenAI: not configured');
    }

    // Codex
    const codexAccounts = readCodexAccounts();
    if (codexAccounts.length > 0) {
      console.log(`  Codex: ${codexAccounts.length} account(s) — ${codexAccounts.map((a) => a.email).join(', ')}`);
    } else {
      console.log('  Codex: not authenticated (run "shizuha auth codex")');
    }

    // Google
    if (creds.google?.apiKey || process.env['GOOGLE_API_KEY']) {
      console.log('  Google: API key configured');
    } else {
      console.log('  Google: not configured');
    }

    // Cortex (SCLI-86)
    if (process.env['CORTEX_API_KEY'] || process.env['CORTEX_OAUTH_TOKEN'] || creds.cortex?.apiKey) {
      const src = (process.env['CORTEX_API_KEY'] || process.env['CORTEX_OAUTH_TOKEN']) ? 'env' : 'stored key';
      console.log(`  Cortex: API key configured (${src})`);
    } else {
      console.log('  Cortex: not configured (run "shizuha auth cortex")');
    }

    // OpenAI-compatible providers
    const compatProviders: Array<[string, string]> = [
      ['OPENROUTER_API_KEY', 'OpenRouter'],
      ['DEEPSEEK_API_KEY', 'DeepSeek'],
      ['MISTRAL_API_KEY', 'Mistral'],
      ['XAI_API_KEY', 'xAI'],
      ['GROQ_API_KEY', 'Groq'],
      ['TOGETHER_API_KEY', 'Together'],
    ];
    for (const [envVar, name] of compatProviders) {
      if (process.env[envVar]) {
        console.log(`  ${name}: API key (env)`);
      }
    }

    // Ollama
    console.log('  Ollama: available (local)');

    console.log('');
  });


authCmd
  .command('whoami')
  .description('Show the current Shizuha platform identity')
  .option('--json', 'Output JSON')
  .option('--live', 'Verify against Shizuha ID before printing')
  .action(async (opts) => {
    const { readShizuhaAuth, verifyShizuhaAuthIdentity } = await import('./config/shizuhaAuth.js');
    const auth = readShizuhaAuth();
    if (!auth) {
      const message = 'Not logged in. Run: shizuha login';
      if (opts.json) console.log(JSON.stringify({ loggedIn: false, error: message }, null, 2));
      else console.error(message);
      process.exitCode = 1;
      return;
    }

    let liveUsername: string | undefined;
    if (opts.live) {
      try {
        liveUsername = (await verifyShizuhaAuthIdentity()).username;
      } catch (err) {
        if (opts.json) {
          console.log(JSON.stringify({
            loggedIn: true,
            username: auth.username,
            userId: auth.userId,
            idApiBaseUrl: auth.idApiBaseUrl,
            liveVerified: false,
            error: (err as Error).message,
          }, null, 2));
        } else {
          console.log(`Username: ${auth.username}`);
          if (auth.userId != null) console.log(`User ID: ${auth.userId}`);
          if (auth.idApiBaseUrl) console.log(`Platform: ${auth.idApiBaseUrl}`);
          console.log(`Live verification: failed (${(err as Error).message})`);
        }
        process.exitCode = 1;
        return;
      }
    }

    const payload = {
      loggedIn: true,
      username: liveUsername ?? auth.username,
      userId: auth.userId,
      idApiBaseUrl: auth.idApiBaseUrl,
      accessTokenExpiresAt: auth.accessTokenExpiresAt,
      refreshTokenExpiresAt: auth.refreshTokenExpiresAt,
      liveVerified: opts.live ? true : undefined,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Username: ${payload.username}`);
    if (payload.userId != null) console.log(`User ID: ${payload.userId}`);
    if (payload.idApiBaseUrl) console.log(`Platform: ${payload.idApiBaseUrl}`);
    if (payload.accessTokenExpiresAt) console.log(`Access token expires: ${payload.accessTokenExpiresAt}`);
    if (payload.refreshTokenExpiresAt) console.log(`Refresh token expires: ${payload.refreshTokenExpiresAt}`);
    if (opts.live) console.log('Live verification: ok');
  });

// ── Pulse CLI commands ──

const pulseCmd = program
  .command('pulse')
  .description('Inspect Pulse tasks through the local Shizuha daemon');

pulseCmd
  .command('list')
  .description('List Pulse tasks')
  .option('--status <status>', 'Filter by status')
  .option('--assignee <user>', 'Filter by assignee username/email')
  .option('--priority <priority>', 'Filter by priority')
  .option('-n, --limit <n>', 'Maximum tasks to show', '20')
  .option('--json', 'Output JSON')
  .action(async (opts) => {
    const { detectBackend, listTasks } = await import('./pulse/backend.js');

    // SCLI-446: validate every option domain locally BEFORE any daemon/project
    // request. An invalid filter must never silently drop/coerce and render a
    // success-shaped empty result — that makes bad input indistinguishable from
    // a genuinely empty queue.
    const validatePulseListOptions = (): { limit: number } | null => {
      const fail = (message: string): null => {
        const out = opts.json
          ? JSON.stringify({ error: message }, null, 2)
          : `Error: ${message}`;
        if (opts.json) console.log(out);
        else console.error(out);
        return null;
      };

      // --limit: canonical positive base-10 integer in 1..100 (documented clamp).
      const rawLimit = (opts.limit as string | undefined) ?? '20';
      if (rawLimit.trim() === '') {
        return fail(`Invalid --limit ${JSON.stringify('')}; expected a positive integer 1-100`);
      }
      const limitStr = rawLimit.trim();
      if (!/^[0-9]+$/.test(limitStr)) {
        return fail(`Invalid --limit ${JSON.stringify(rawLimit)}; expected a positive integer 1-100`);
      }
      if (limitStr.length > 1 && limitStr.startsWith('0')) {
        return fail(`Invalid --limit ${JSON.stringify(rawLimit)}; expected a positive integer 1-100`);
      }
      const limitNum = Number(limitStr);
      if (!Number.isSafeInteger(limitNum) || limitNum < 1 || limitNum > 100) {
        return fail(`Invalid --limit ${JSON.stringify(rawLimit)}; expected a positive integer 1-100`);
      }

      // --status: non-empty, no whitespace/control characters, lowercase domain.
      const statusRaw = opts.status as string | undefined;
      if (statusRaw !== undefined) {
        if (statusRaw.trim() === '' || /[\s\u0000-\u001f]/.test(statusRaw)) {
          return fail(`Invalid --status ${JSON.stringify(statusRaw)}; expected a non-empty status with no whitespace/control characters`);
        }
      }

      // --assignee: non-empty, no whitespace/control characters (username/email).
      const assigneeRaw = opts.assignee as string | undefined;
      if (assigneeRaw !== undefined) {
        if (assigneeRaw.trim() === '' || /[\s\u0000-\u001f]/.test(assigneeRaw)) {
          return fail(`Invalid --assignee ${JSON.stringify(assigneeRaw)}; expected a non-empty username/email with no whitespace/control characters`);
        }
      }

      // --priority: non-empty, no whitespace/control, lowercase finite domain.
      const priorityRaw = opts.priority as string | undefined;
      if (priorityRaw !== undefined) {
        const validPriorities = new Set(['urgent', 'high', 'normal', 'medium', 'low']);
        if (
          priorityRaw.trim() === '' ||
          /[\s\u0000-\u001f]/.test(priorityRaw) ||
          !validPriorities.has(priorityRaw)
        ) {
          return fail(`Invalid --priority ${JSON.stringify(priorityRaw)}; expected one of: urgent, high, normal, medium, low`);
        }
      }

      return { limit: limitNum };
    };

    const v = validatePulseListOptions();
    if (v === null) {
      process.exitCode = 1;
      return;
    }

    try {
      const backend = await detectBackend();
      const tasks = await listTasks({
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.assignee ? { assignee: opts.assignee } : {}),
        ...(opts.priority ? { priority: opts.priority } : {}),
        limit: v.limit,
      });
      const shown = tasks.slice(0, v.limit);
      if (opts.json) {
        console.log(JSON.stringify({ backend, count: shown.length, tasks: shown }, null, 2));
        return;
      }
      if (shown.length === 0) {
        console.log(`No Pulse tasks found (${backend} backend).`);
        return;
      }
      console.log(`Pulse tasks (${backend} backend):`);
      for (const task of shown) {
        const key = task.item_key || task.id;
        const assignee = task.assignee ? ` @${inert(task.assignee)}` : '';
        const project = task.project_key ? ` [${inert(task.project_key)}]` : '';
        console.log(`- ${inert(key)}${project}: ${inert(task.title)}`);
        console.log(`  status=${inert(task.status)} priority=${inert(task.priority)}${assignee}`);
      }
    } catch (err) {
      const message = `Unable to list Pulse tasks via daemon: ${(err as Error).message}. Is shizuha up running?`;
      if (opts.json) console.log(JSON.stringify({ error: message }, null, 2));
      else console.error(message);
      process.exitCode = 1;
    }
  });

// ── Daemon commands: up / down / status ──

program
  .command('up')
  .description('Start agent runtimes (like tailscale up)')
  .option('--agent <name>', 'Start specific agent(s) (comma-separated)', '')
  .option('--platform <url>', 'Platform URL (default: from login)')
  .option('--bare-metal', 'Run agents as local processes instead of containers')
  .option('--image <image>', 'Docker image for containers', 'shizuha-agent-runtime:latest')
  .option('--foreground', 'Run in foreground instead of daemonizing')
  .option('--no-service', 'Skip service installation (run in foreground only)')
  .action(async (opts) => {
    const { readShizuhaAuth, getValidShizuhaAccessToken } = await import('./config/shizuhaAuth.js');
    const { startDaemon } = await import('./daemon/manager.js');
    const { isDaemonRunning } = await import('./daemon/state.js');
    const { detectInitSystem, initSystemName, installAndStartService, isServiceRunning, statusHints } = await import('./daemon/service.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    // Host-local fleet daemon retirement (k3s cutover): refuse accidental
    // `shizuha up` on hosts that still carry ~/.shizuha/agents.json for the
    // rt-fleet control plane. The only supported fleet control plane is the
    // rt-fleet pod with SHIZUHA_DAEMON_RUNTIME=k8s. Break-glass:
    // SHIZUHA_ALLOW_LOCAL_DAEMON=1.
    const homeDir = process.env['HOME'] || os.homedir();
    const retiredMarker = path.join(homeDir, '.shizuha', 'LEGACY_LOCAL_DAEMON_RETIRED');
    const isK8sFleetDaemon =
      process.env['SHIZUHA_DAEMON_RUNTIME'] === 'k8s'
      || process.env['SHIZUHA_RUNTIME_BACKEND'] === 'k8s';
    const allowLocalDaemon = process.env['SHIZUHA_ALLOW_LOCAL_DAEMON'] === '1';
    if (fs.existsSync(retiredMarker) && !isK8sFleetDaemon && !allowLocalDaemon) {
      console.error('Host-local `shizuha up` is retired on this host.');
      console.error('Fleet agents run only as k3s pods (rt-fleet / shizuha-fleet).');
      console.error(`See: ${retiredMarker}`);
      console.error('Break-glass only: SHIZUHA_ALLOW_LOCAL_DAEMON=1 (do not use for fleet).');
      process.exit(2);
    }
    if (opts.bareMetal && fs.existsSync(retiredMarker) && !allowLocalDaemon) {
      console.error('`--bare-metal` is forbidden on this host (legacy local daemon retired).');
      process.exit(2);
    }

    // Authenticate — optional. Works without login (local mode).
    let accessToken = process.env['SHIZUHA_ACCESS_TOKEN'] || '';
    const auth = (await import('./config/shizuhaAuth.js')).readShizuhaAuth();

    if (!accessToken && auth) {
      accessToken = (await getValidShizuhaAccessToken().catch(() => '')) || '';
    }

    const isDaemonReentry = process.env['SHIZUHA_DAEMON'] === '1';
    const isForeground = opts.foreground || isDaemonReentry;
    const useService = !opts.noService && !isForeground && !isDaemonReentry;

    const identity = auth?.username ?? (accessToken ? 'authenticated' : 'local');

    // ── systemd service path (default on Linux) ──
    if (useService) {
      console.log('Shizuha Runtime v0.1.0');
      console.log(`Mode: ${accessToken ? `platform (${identity})` : 'local'}`);
      console.log('');

      // Build extra args to bake into the service file
      const extraArgs: string[] = [];
      if (opts.platform) extraArgs.push('--platform', opts.platform as string);
      if (opts.agent) extraArgs.push('--agent', opts.agent as string);
      if (opts.bareMetal) extraArgs.push('--bare-metal');
      if (opts.image && opts.image !== 'shizuha-agent-runtime:latest') {
        extraArgs.push('--image', opts.image as string);
      }

      // Stop any legacy (non-systemd) daemon that might be running
      if (isDaemonRunning()) {
        const { stopDaemon } = await import('./daemon/manager.js');
        console.log('Stopping legacy daemon...');
        stopDaemon();
        await new Promise((r) => setTimeout(r, 1000));
      }

      const initName = initSystemName();
      console.log(`Installing ${initName}...`);
      installAndStartService({ extraArgs });

      const hints = statusHints();
      console.log('');
      console.log(`Shizuha is running (${initName}).`);
      console.log(`  Status:   ${hints.status}`);
      console.log(`  Logs:     ${hints.logs}`);
      console.log(`  Stop:     ${hints.stop}`);
      console.log('  Restart:  shizuha up');
      console.log('');
      if (detectInitSystem() !== 'nohup') {
        console.log('The service will auto-start on boot and restart on crash.');
      } else {
        console.log('The daemon is running in the background.');
      }
      return;
    }

    // ── Legacy fork / foreground path ──

    // If already running, stop the old daemon first
    if (!isDaemonReentry && isDaemonRunning()) {
      const { stopDaemon } = await import('./daemon/manager.js');
      console.log('Stopping existing daemon...');
      stopDaemon();
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Determine platform URL
    const platformUrl = (opts.platform as string)
      || auth?.idApiBaseUrl
      || process.env['SHIZUHA_PLATFORM_URL']
      || 'http://localhost';

    // Derive WS URL from platform URL
    const wsProto = platformUrl.startsWith('https') ? 'wss' : 'ws';
    const wsHost = platformUrl.replace(/^https?:\/\//, '');
    const wsUrl = `${wsProto}://${wsHost}/agent/ws/runner/`;

    // Parse agent filter
    const agentFilter = (opts.agent as string)
      ? (opts.agent as string).split(',').map((s: string) => s.trim()).filter(Boolean)
      : [];

    if (!isDaemonReentry) {
      console.log('Shizuha Runtime v0.1.0');
      console.log(`Mode: ${accessToken ? `platform (${identity})` : 'local'}`);
      console.log('');
    }

    // CTX-157: Start Prometheus metrics server in daemon foreground path so
    // cortex_provider_timeout_total is scrapeable at :9103 on the host.
    if (isForeground) {
      const { startMetricsServer: startDaemonMetricsServer } = await import("./metrics/server.js");
      const daemonMetricsPort = parseInt(process.env["SHIZUHA_METRICS_PORT"] ?? "9103", 10);
      startDaemonMetricsServer(daemonMetricsPort);
    }

    await startDaemon(
      {
        platformUrl,
        wsUrl,
        containerMode: !opts.bareMetal,
        image: opts.image as string,
        agentFilter,
        foreground: isForeground,
      },
      accessToken,
    );

    // Keep the process alive — the daemon runs forever via HTTP server + intervals
    await new Promise(() => {});
  });

program
  .command('down')
  .description('Stop all agent runtimes')
  .option('--disable', 'Also disable auto-start on boot')
  .option('--uninstall', 'Remove the service entirely')
  .action(async (opts) => {
    const { stopDaemon } = await import('./daemon/manager.js');
    const { detectInitSystem, isServiceInstalled, isServiceRunning, stopService, uninstallService } = await import('./daemon/service.js');

    let stopped = false;

    // Stop managed service if it exists
    if (isServiceInstalled()) {
      if (opts.uninstall) {
        uninstallService();
        console.log('Shizuha service uninstalled.');
        stopped = true;
      } else if (opts.disable && detectInitSystem() === 'systemd') {
        try {
          const { execSync } = await import('node:child_process');
          execSync('systemctl --user disable shizuha', { stdio: 'ignore' });
        } catch { /* ignore */ }
        stopService();
        console.log('Shizuha stopped and disabled (will not start on boot).');
        stopped = true;
      } else {
        if (isServiceRunning()) {
          stopService();
          if (detectInitSystem() !== 'nohup') {
            console.log('Shizuha stopped (service remains enabled — will start on next boot).');
            console.log('Use "shizuha down --disable" to prevent auto-start.');
          } else {
            console.log('Shizuha stopped.');
          }
          stopped = true;
        }
      }
    }

    // Also stop any legacy daemon
    if (stopDaemon()) {
      stopped = true;
    }

    if (!stopped) {
      console.log('Shizuha is not running.');
    }
  });

program
  .command('status')
  .description('Show running agent runtimes')
  .action(async () => {
    const { showStatus } = await import('./daemon/manager.js');
    const { readShizuhaAuth, getValidShizuhaAccessToken } = await import('./config/shizuhaAuth.js');

    const auth = readShizuhaAuth();
    let accessToken: string | null = null;
    let platformUrl: string | undefined;

    if (auth) {
      accessToken = await getValidShizuhaAccessToken().catch(() => null);
      platformUrl = auth.idApiBaseUrl || undefined;
    }

    await showStatus(platformUrl, accessToken ?? undefined);
  });

program
  .command('login')
  .description('Authenticate with the Shizuha platform')
  .option('-u, --username <username>', 'Username')
  .option('-p, --password <password>', 'Password')
  .action(async (opts) => {
    // SCLI-178/SCLI-492: reject explicit-empty and whitespace-only --username /
    // --password BEFORE any prompt, state, or network work. Absent/undefined
    // stays optional and falls through to the interactive prompt below; a
    // present-but-empty/whitespace value must not silently cross into the
    // downstream auth path (blank terminal wait / whitespace credential).
    try {
      requireOptionalNonEmpty('username', opts.username);
      requireOptionalNonEmpty('password', opts.password);
    } catch (err) {
      exitOnOptionPreflightError(err);
    }

    const { loginToShizuhaId } = await import('./config/shizuhaAuth.js');
    const readline = await import('node:readline');

    let username = opts.username as string | undefined;
    let password = opts.password as string | undefined;

    if (!username || !password) {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      const ask = (q: string): Promise<string> =>
        new Promise((resolve) => rl.question(q, resolve));

      if (!username) username = await ask('Username: ');
      if (!password) password = await ask('Password: ');

      rl.close();
    }

    try {
      const result = await loginToShizuhaId(username!, password!);
      console.log(`Logged in as ${result.username}`);
      console.log('Credentials saved to ~/.shizuha/auth.json');

      // SCLI-86: offer to store a Cortex inference key (sk-cortex-…) so the CLI
      // can run inference with the user's own key. Identity stays in auth.json;
      // the provider secret goes to credentials.json (0600). Only prompt on a
      // TTY and when no key is stored, so scripted `login -u -p` stays
      // non-blocking. Get one at the Hive "Inference Key" page.
      // Auto-provision a personal Cortex key from the login JWT — runs ALWAYS
      // (interactive sign-in OR scripted `login -u -p`), no paste, no env vars.
      {
        const { setCortexApiKey, readCredentials } = await import('./config/credentials.js');
        const { readShizuhaAuth } = await import('./config/shizuhaAuth.js');
        const accessToken = readShizuhaAuth()?.accessToken;
        if (!readCredentials().cortex?.apiKey && accessToken) {
          try {
            const { mintCortexKey } = await import('./auth/shizuha-login.js');
            const osmod = await import('node:os');
            const host = (() => { try { return osmod.hostname() || 'cli'; } catch { return 'cli'; } })();
            const key = await mintCortexKey(
              accessToken,
              `shizuha-cli ${host} ${new Date().toISOString().slice(0, 10)}`,
            );
            setCortexApiKey(key);
            console.log('Cortex inference key provisioned automatically — cortex/<model> is ready.');
          } catch (e) {
            console.log(`(Could not auto-provision a Cortex key: ${(e as Error).message})`);
            console.log('Add one later with: shizuha auth cortex');
          }
        }
      }
    } catch (err) {
      console.error(`Login failed: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Clear stored authentication')
  .action(async () => {
    const { clearShizuhaAuth } = await import('./config/shizuhaAuth.js');
    const { stopDaemon } = await import('./daemon/manager.js');

    // Stop daemon if running
    stopDaemon();

    // Clear auth
    clearShizuhaAuth();
    console.log('Logged out. Authentication cleared.');
  });

program
  .command('update')
  .description('Update the installed Shizuha runtime to the latest release (tailscale-style self-update)')
  .option('--check', 'only check whether an update is available (exit 10 = available)')
  .option('--force', 'run the installer even if already current / from a source checkout')
  .action(async (opts) => {
    const { updateCommand } = await import('./commands/update.js');
    process.exitCode = await updateCommand({ check: !!opts.check, force: !!opts.force });
  });

program
  .command('doctor')
  .description('Check system health and diagnose issues')
  .option('-m, --model <model>', 'Selected model to probe for live reachability')
  .action(async (opts: { model?: string }) => {
    const { runDoctor, printChecks } = await import('./commands/doctor.js');
    const checks = await runDoctor(process.cwd(), {
      selectedModel: opts.model || process.env['SHIZUHA_MODEL'] || undefined,
    });
    printChecks(checks);
    const failed = checks.filter(c => c.status === 'fail').length;
    if (failed > 0) process.exitCode = 1;
  });

program
  .command('provision-agent <username>')
  .description('Provision a new agent: create shizuha-id account, write scoped .mcp.json, seed OAuth credentials')
  .option('--role <role>', 'Agent role (reviewer|architect|engineer|qa|security|docs|analytics|devops|social)', 'engineer')
  .option('--home <path>', 'Agent home directory (default: /home/<username>)')
  .option('--platform-url <url>', 'Platform base URL (overrides SHIZUHA_PLATFORM_URL)')
  .option('--admin-token <token>', 'Admin token for account approval (overrides SHIZUHA_ADMIN_TOKEN)')
  .option('--oauth-services <list>', 'Comma-separated MCP services to seed OAuth for, or \'*\' (overrides SHIZUHA_MCP_OAUTH_SERVICES)')
  .option('--first-name <name>', 'Agent display first name')
  .option('--last-name <name>', 'Agent display last name')
  .action(async (username: string, opts) => {
    const { runProvisionAgent, printProvisionResult } = await import('./commands/provision-agent.js');
    try {
      const result = await runProvisionAgent(username, opts);
      printProvisionResult(result);
    } catch (err) {
      console.error(`[provision-agent] Error: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command('reseed-heartbeat')
  .description('Rewrite HEARTBEAT.md in every agent workspace from the canonical template (force overwrite)')
  .option('-a, --agent <username>', 'Only reseed this agent (default: all)')
  .option('-n, --dry-run', 'Show which files would be written without touching them')
  .action(async (opts) => {
    const { reseedHeartbeatTemplate, inspectHeartbeatTarget } = await import('./daemon/heartbeat-template.js');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const workspacesRoot = path.join(process.env['HOME'] ?? os.homedir(), '.shizuha', 'workspaces');
    if (!fs.existsSync(workspacesRoot)) {
      console.error(`No workspaces directory at ${workspacesRoot} — nothing to reseed.`);
      process.exitCode = 1;
      return;
    }
    const all = fs.readdirSync(workspacesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
    const targets = opts.agent ? all.filter(n => n === opts.agent) : all;
    if (targets.length === 0) {
      console.error(opts.agent
        ? `No workspace found for agent '${inert(opts.agent)}' under ${workspacesRoot}`
        : `No agent workspaces under ${workspacesRoot}`);
      process.exitCode = 1;
      return;
    }
    // SCLI-435: dry-run must predict the EXACT bytes and per-workspace action of
    // the real run. Byte count = template-length in UTF-8 (Buffer.byteLength),
    // never the JS string's UTF-16 code-unit length. Each target is validated
    // (no-follow, containment) so a symlink/FIFO/outside destination is reported
    // as REJECTED rather than promised-written.
    if (opts.dryRun) {
      let ok = 0;
      let failed = 0;
      for (const name of targets) {
        const dir = path.join(workspacesRoot, name);
        const info = inspectHeartbeatTarget(dir, workspacesRoot);
        if (!info.ok) {
          console.error(`  \u2717 ${inert(name)}: ${inert(info.reason)}`);
          failed++;
          continue;
        }
        console.log(`  - ${info.target} (${info.bytes} bytes)`);
        ok++;
      }
      console.log(`[dry-run] Would rewrite HEARTBEAT.md in ${ok}/${targets.length} workspace(s)${failed ? ` (${failed} rejected)` : ''}`);
      if (failed > 0) process.exitCode = 1;
      return;
    }
    let ok = 0;
    let failed = 0;
    for (const name of targets) {
      const dir = path.join(workspacesRoot, name);
      const result = reseedHeartbeatTemplate(dir, { root: workspacesRoot });
      if (result.written) {
        console.log(`  \u2713 ${inert(name)}`);
        ok++;
      } else {
        console.error(`  \u2717 ${inert(name)}: ${inert(result.reason ?? 'unknown error')}`);
        failed++;
      }
    }
    console.log(`Reseeded ${ok}/${targets.length} workspace(s)${failed ? ` (${failed} failed)` : ''}`);
    if (failed > 0) process.exitCode = 1;
  });

program.parse();

// Helper: run agent with an initial user prompt
import type { AgentEvent } from './events/types.js';
import type { Message } from './agent/types.js';

async function* runAgentWithPrompt(
  config: AgentConfig,
  prompt: string,
  resumeSessionId?: string,
): AsyncGenerator<AgentEvent> {
  // We need to inject the user message into the conversation.
  // The cleanest way: wrap runAgent and inject messages into the store.
  // For now, we modify the system prompt to include the task and use a simple initial message approach.

  // Actually, the agent loop reads from session messages. We need to pre-populate.
  // The simplest approach: create a modified loop that accepts initial messages.
  // For Phase 1, we'll use a slightly different approach — patch the prompt into systemPrompt.

  const { AgentEventEmitter } = await import('./events/emitter.js');
  const { ToolRegistry } = await import('./tools/registry.js');
  const { registerBuiltinTools } = await import('./tools/builtin/index.js');
  const { PermissionEngine } = await import('./permissions/engine.js');
  const { ProviderRegistry } = await import('./provider/registry.js');
  const { StateStore } = await import('./state/store.js');
  const { loadConfig: lc } = await import('./config/loader.js');
  const { buildSystemPrompt } = await import('./prompt/builder.js');
  const {
    needsCompaction,
    estimateOverheadTokens,
    providerPromptTokensOrEstimate,
  } = await import('./prompt/context.js');
  const { resolveEffectiveContextWindow } = await import('./provider/context-window.js');
  const { MCPManager } = await import('./tools/mcp/manager.js');
  const { registerMCPTools, createMCPResourceReadTool } = await import('./tools/mcp/bridge.js');
  const {
    ToolSearchState,
    createToolSearchTool,
    buildConfiguredServerSummaries,
    buildDeferredToolDefinitions,
    buildToolCatalog,
    buildAwarenessPrompt,
    modelNeedsInlineToolSchemas,
    modelSupportsAppendOnlyToolActivation,
  } = await import('./tools/tool-search.js');
  const { executeTurn } = await import('./agent/turn.js');
  const { compareProviderPrefixSnapshots, providerPrefixContinuityLogFields, providerPrefixContinuityLogMessage } = await import('./telemetry/provider-prefix-continuity.js');

  const cfg = await lc(config.cwd);
  let model = config.model ?? cfg.agent.defaultModel;
  const cwd = config.cwd ?? cfg.agent.cwd;
  const maxTurns = config.maxTurns ?? cfg.agent.maxTurns;
  // Load model profile early — needed for temperature, toolset, etc.
  const { getModelProfile } = await import('./provider/model-profile.js');
  const modelProfile = getModelProfile(model);
  // Temperature: explicit CLI > model profile > file config.
  // null from profile = explicitly omit (let model use its trained default).
  const temperature = config.temperature ?? (modelProfile.defaultTemperature === null ? undefined : (modelProfile.defaultTemperature ?? cfg.agent.temperature));
  // Max output tokens: explicit CLI > model profile > file config
  const maxOutputTokens = config.maxOutputTokens ?? modelProfile.recommendedMaxOutputTokens ?? cfg.agent.maxOutputTokens;
  const permissionMode = config.permissionMode ?? cfg.permissions.mode;
  const thinkingLevel = config.thinkingLevel;
  const reasoningEffort = config.reasoningEffort;

  const providerReg = new ProviderRegistry(cfg);

  // Resolve 'auto' model to best available provider
  if (model === 'auto') {
    model = providerReg.resolveAutoModel();
  }

  let provider;
  try {
    provider = providerReg.resolve(model);
  } catch (err) {
    const msg = (err as Error).message;
    // If the error already contains setup instructions (e.g. from codex auth check),
    // show it directly. Otherwise, show a general provider setup guide.
    if (msg.includes('shizuha auth') || msg.includes('ANTHROPIC_API_KEY')) {
      process.stderr.write(`\n  ${msg}\n\n`);
    } else {
      const hint = [
        `Error: ${msg}`,
        '',
        'Quick start (free with any ChatGPT account):',
        '  shizuha auth codex',
        '',
        'Other providers:',
        '  export ANTHROPIC_API_KEY=sk-ant-...     # Claude',
        '  export OPENAI_API_KEY=sk-...            # GPT / OpenAI',
        '  export GOOGLE_API_KEY=...               # Gemini',
        '  ollama pull qwen3-coder-next            # Local (Ollama)',
        '',
      ].join('\n');
      process.stderr.write(hint + '\n');
    }
    return;
  }
  // Pre-warm provider discovery so maxContextWindow reflects the SERVED limit (e.g. vLLM /v1/models max_model_len)
  {
    const provAny = provider as unknown as { getServedModel?: (preferredModel?: string) => Promise<string | undefined> };
    if (typeof provAny.getServedModel === 'function') {
      try { await provAny.getServedModel(model); } catch { /* ignore */ }
    }
  }
  const maxContextTokens = resolveEffectiveContextWindow(
    model,
    provider,
    config.maxContextTokens ?? cfg.agent.maxContextTokens,
  );
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  // Unregister client-side web_search when provider handles it natively
  if (provider.supportsNativeWebSearch) {
    toolRegistry.unregister('web_search');
  }
  // Disable sub-agent task tool in exec mode — it's not wired up and wastes turns.
  // The model generates full file contents as task prompts that are never executed,
  // Apply toolset filter only when explicitly configured. Default stays full.
  let toolsetName = config.toolset ?? cfg.agent.toolset ?? 'full';
  if (toolsetName && toolsetName !== 'full') {
    const { ToolsetManager } = await import('./tools/toolsets.js');
    const mgr = new ToolsetManager();
    const allNames = toolRegistry.list().map((t) => t.name);
    const allowed = new Set(mgr.filterTools(toolsetName, allNames));
    for (const name of allNames) {
      if (!allowed.has(name)) toolRegistry.unregister(name);
    }
  }

  const permissions = new PermissionEngine(permissionMode, cfg.permissions.rules);
  const emitter = new AgentEventEmitter();
  const store = new StateStore();

  // Inject store into session search tool
  const { setSearchStore } = await import('./tools/builtin/session-search.js');
  setSearchStore(store);

  const mcpManager = new MCPManager();
  const mcpConfigs = [...(cfg.mcp.servers ?? []), ...(config.mcpServers ?? [])];
  if (mcpConfigs.length > 0) {
    await mcpManager.connectAll(mcpConfigs);
    await registerMCPTools(mcpManager, (h) => toolRegistry.register(h));
    for (const [serverName, conn] of mcpManager.getAll()) {
      if (conn.capabilities?.resources) {
        toolRegistry.register(createMCPResourceReadTool(serverName, mcpManager));
      }
    }
    mcpManager.setToolRegistry(toolRegistry);
  }

  const toolSearchConfig = cfg.mcp.toolSearch;
  const toolSearchState = new ToolSearchState();
  let toolSearchEnabled = false;
  if (mcpConfigs.length > 0 && toolSearchConfig.mode !== 'off') {
    toolSearchState.setCatalog(
      buildToolCatalog(mcpManager.listAllTools()),
      buildConfiguredServerSummaries(mcpConfigs),
    );
    toolSearchEnabled = toolSearchConfig.mode === 'on'
      || toolSearchState.shouldAutoEnable(maxContextTokens, toolSearchConfig.autoThresholdPercent);
    if (toolSearchEnabled) {
      toolRegistry.register(createToolSearchTool(toolSearchState, toolSearchConfig.maxResults, {
        inlineSchemas: modelNeedsInlineToolSchemas(model),
      }));
    }
  }

  // Load skills
  const { loadSkills: loadSkillsFn } = await import('./skills/loader.js');
  const { SkillRegistry: SkillReg } = await import('./skills/registry.js');
  const { createSkillTool: createSkill } = await import('./tools/builtin/skill.js');
  const skillReg = new SkillReg();
  skillReg.registerAll(loadSkillsFn(cwd, { trustProjectSkills: cfg.skills.trustProjectSkills }));
  if (skillReg.size > 0) {
    toolRegistry.register(createSkill(skillReg));
  }

  let session = resumeSessionId ? store.loadSession(resumeSessionId) : null;
  if (!session) {
    session = store.createSession(model, cwd);
  }

  const assistantMessageId = crypto.randomUUID();
  yield { type: 'session_start', sessionId: session.id, model, messageId: assistantMessageId, timestamp: Date.now() };

  const mcpAwareness = toolSearchEnabled
    ? buildAwarenessPrompt(toolSearchConfig.awareness, toolSearchState)
    : undefined;
  function getToolDefs(): import('./tools/types.js').ToolDefinition[] {
    const allDefs = toolRegistry.definitions();
    if (!toolSearchEnabled) return allDefs;
    return buildDeferredToolDefinitions(
      allDefs,
      toolSearchState,
      modelSupportsAppendOnlyToolActivation(model),
    );
  }

  let toolDefs = getToolDefs();
  const skillCatalogStr = skillReg.size > 0 ? skillReg.buildCatalog(process.env['AGENT_ROLE'], process.env['AGENT_TEAM']) : undefined;
  const systemPrompt = config.systemPrompt ?? await buildSystemPrompt({
    cwd,
    tools: toolDefs,
    model,
    contextWindow: maxContextTokens,
    mcpAwareness,
    deferredMcpTools: toolSearchEnabled,
    skillCatalog: skillCatalogStr,
  });
  let systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs, model);

  // Start from persisted session history so pipe turns can continue context.
  const messages: Message[] = [...session.messages];
  // On resume, rebuild the (in-memory-only) tool-search discovered set from the
  // loaded transcript — otherwise MCP tools the model already found get filtered
  // out of the tools array and weaker models fake the call via bash echo.
  if (toolSearchEnabled && messages.length > 0) {
    toolSearchState.markDiscoveredFromHistory(messages);
  }
  if (mcpManager.failedServers.length > 0) {
    const failedList = mcpManager.failedServers
      .map((f: { name: string; error: string }) => `- ${f.name}: ${f.error}`)
      .join('\n');
    const total = mcpManager.failedServers.length + mcpManager.size;
    const diagnostic = `[System Notice] ${mcpManager.failedServers.length}/${total} MCP tool servers failed to connect. You are operating with reduced capabilities.\n\nFailed servers:\n${failedList}\n\nInform the user about this limitation. Do not pretend everything is normal.`;
    const diagnosticMsg: Message = { id: crypto.randomUUID(), executionId: assistantMessageId, role: 'user', content: diagnostic, timestamp: Date.now() };
    const ackMsg: Message = { id: crypto.randomUUID(), executionId: assistantMessageId, role: 'assistant', content: 'Understood. I will inform the user about the degraded tool availability.', timestamp: Date.now() };
    messages.push(diagnosticMsg);
    messages.push(ackMsg);
    store.appendMessage(session.id, diagnosticMsg);
    store.appendMessage(session.id, ackMsg);
  }
  const userMessage: Message = { id: crypto.randomUUID(), executionId: assistantMessageId, role: 'user', content: prompt, timestamp: Date.now() };
  messages.push(userMessage);
  store.appendMessage(session.id, userMessage);

  const { BackgroundTaskRegistry } = await import('./tasks/registry.js');
  const taskRegistry = new BackgroundTaskRegistry();
  const sandboxCfg = (config as { sandbox?: import('./sandbox/types.js').SandboxConfig }).sandbox;
  const sandbox = sandboxCfg?.mode !== 'unrestricted' ? sandboxCfg : undefined;
  const toolContext = { cwd, sessionId: session.id, taskRegistry, sandbox };
  const startTime = Date.now();
  // SCLI-31 (P1): the exec/`-p`/pipe path runs this copied loop, so it needs the
  // SAME run-telemetry capture as the TUI loop — otherwise the primary live
  // exec/fleet runs write no turn-telemetry.jsonl and getTurnTelemetryWindow()
  // stays null. Shared window/sink/helper with agent/loop.ts.
  const telemetryWindow = new TurnTelemetryWindow();
  setActiveTelemetryWindow(telemetryWindow);
  const telemetryAgentLabel = process.env['AGENT_USERNAME'];
  const telemetrySink = createTurnTelemetrySink();
  const telemetryRunId = `${session.id}#${crypto.randomUUID().slice(0, 8)}`;

  // SCLI-32: heuristic struggle analyzer for this exec run. Drives
  // THRASH/ERROR_DENSITY/LONG_RUN off the telemetry window and STALL off the
  // live activity events executeTurn emits on `emitter`; emits 'struggle' events
  // that the SCLI-33 auto-filer files as deduped Pulse bugs. Declared before the
  // main try so the finally tears it down on every exit path (no leaked timer).
  const struggleAnalyzer = new StruggleAnalyzer(emitter, telemetryWindow, {
    runId: telemetryRunId,
    ...(telemetryAgentLabel ? { agent: telemetryAgentLabel } : {}),
  });
  // The auto-filer types its emitter structurally (`on(event: string, …)`);
  // AgentEventEmitter.on is typed narrower (AgentEventType|'*'). It only ever
  // subscribes to 'struggle' (a valid event), so the bridge cast is runtime-safe.
  const { unsub: struggleAutoFilerUnsub, flush: struggleAutoFilerFlush } = setupStrugglePulseAutoFiler(
    emitter as unknown as Parameters<typeof setupStrugglePulseAutoFiler>[0],
  );

  let turnIndex = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastReportedPromptTokens = 0; // SCLI-182: real last-turn prompt_tokens for the compaction gate
  let lastProviderPromptEstimate = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCacheReadInputTokens = 0;
  let postCompactionRequestKind: string | undefined;

  // Automatic context safety must never depend on another model request. A
  // remote compaction has the same cold-prefill cost as the turn it is meant to
  // protect and can be serialized behind another session. Keep the automatic
  // gate synchronous, persist its bounded projection atomically, and fail
  // locally if that projection somehow cannot restore threshold headroom.
  const compactAutomaticallyIfNeeded = async (reportedPromptTokens = 0, force = false): Promise<boolean> => {
    if (!force && !needsCompaction(
      messages,
      maxContextTokens,
      model,
      systemOverheadTokens,
      maxOutputTokens,
      reportedPromptTokens,
    )) return false;

    // ALWAYS use the LLM-based compaction (operator 2026-08-08): no local-vs-
    // autonomous differentiation — every agent compacts via the LLM so no
    // conversation loses meaning to the lossy extractive projection.
    const { compactMessagesRequired } = await import('./state/compaction.js');
    const { messages: compacted } = await compactMessagesRequired(
      messages,
      provider,
      model,
      maxContextTokens,
      { overheadTokens: systemOverheadTokens, force: true },
    );
    messages.length = 0;
    messages.push(...compacted);
    store.replaceMessages(session.id, compacted);
    lastReportedPromptTokens = 0;
    lastProviderPromptEstimate = 0;
    postCompactionRequestKind = 'post_compaction';

    if (needsCompaction(
      messages,
      maxContextTokens,
      model,
      systemOverheadTokens,
      maxOutputTokens,
    )) {
      throw new Error('Semantic context compaction did not restore provider-call headroom');
    }
    return true;
  };

  // Continuation logic:
  // - Text-only response (no tool_use) → STOP immediately (no nudges)
  // - max_tokens with a reasoning block (autonomous) → continue to tool-call
  // - Other incomplete (visible-only max_tokens / transport salvage) → fail closed
  // - Has tool_use → execute tools, continue loop
  const MAX_TRUNCATION_RECOVERY = 3;
  let truncationRecoveryCount = 0;
  let thinkingOnlyRecoveryCount = 0;
  const backgroundTaskWait = new BackgroundTaskWaitController();

  try {
    while (!maxTurns || turnIndex < maxTurns) {
      yield { type: 'turn_start', turnIndex, timestamp: Date.now() };
      const turnStart = Date.now();
      let compactionAction: HeartbeatCompactionAction = 'none';
      let preProviderBudgetExceeded = false;
      let effectiveReportedPromptTokens = providerPromptTokensOrEstimate(
        lastReportedPromptTokens,
        lastProviderPromptEstimate,
      );
      let promptBudget = estimatePromptTokenBudget({
        messages,
        systemPrompt,
        toolDefs,
        model,
        sourceKind: classifyPromptSource(messages, prompt),
        reportedPromptTokens: effectiveReportedPromptTokens,
      });
      const hbBudget = heartbeatBudgetConfig(maxContextTokens);
      const heartbeatOverSoft = promptBudget.sourceKind === 'heartbeat' && promptBudget.promptTokenEstimate > hbBudget.softBudgetTokens;
      if (await compactAutomaticallyIfNeeded(effectiveReportedPromptTokens, heartbeatOverSoft)) {
        preProviderBudgetExceeded = heartbeatOverSoft;
        compactionAction = 'compact';
        effectiveReportedPromptTokens = 0;
        promptBudget = estimatePromptTokenBudget({
          messages,
          systemPrompt,
          toolDefs,
          model,
          sourceKind: promptBudget.sourceKind,
        });
      }

      // Stream content/reasoning live while buffering the remaining events so
      // we can keep post-turn tool_start de-dup semantics for CLI/pipe.
      const bufferedEvents: AgentEvent[] = [];
      const liveEvents: AgentEvent[] = [];
      let wakeLive: (() => void) | null = null;
      let turnDone = false;
      let turnError: unknown = null;
      let result: Awaited<ReturnType<typeof executeTurn>> | undefined;
      const signalLive = () => {
        const wake = wakeLive;
        wakeLive = null;
        wake?.();
      };
      const unsub = emitter.on('*', (ev) => {
        if (ev.type === 'content' || ev.type === 'reasoning' || ev.type === 'reasoning_text' || ev.type === 'provider_status'
            || ev.type === 'struggle') {
          // `struggle` streams LIVE (review P2-3): a STALL fired by the idle timer
          // while `executeTurn` is still pending (the exact hung-call case STALL
          // diagnoses) would otherwise sit in bufferedEvents until the hang
          // resolves, so JSON/NDJSON consumers never see it during the hang.
          liveEvents.push(ev);
          signalLive();
          return;
        }
        bufferedEvents.push(ev);
      });

      // SCLI-32: no-op call retained for call-site compat; STALL is now driven by
      // the SCLI-22 provider watchdog (provider_status { code: 'stall_timeout' }).
      struggleAnalyzer.onTurnStart();

      // Retry transient API errors indefinitely with backoff (matches TUI session.ts)
      const turnPromise = (async () => {
        const {
          isTransientProviderFailure,
          sleepMs,
          transientRetryDelayMs,
          formatRetryNotice,
          resolveRetryDelayMs,
          retryAfterMsFromError,
        } = await import('./provider/transient-errors.js');
        let stallStartedAt = 0;
        for (let retryAttempt = 0; ; retryAttempt++) {
          try {
            const requestKind = postCompactionRequestKind;
            postCompactionRequestKind = undefined;
            result = await executeTurn(
              messages, provider, model, systemPrompt, toolDefs,
              toolRegistry, permissions, emitter, toolContext,
              maxOutputTokens, temperature,
              undefined, // onPermissionAsk — not used in exec mode
              undefined, // hookEngine
              thinkingLevel,
              undefined, // abortSignal
              reasoningEffort,
              undefined, // fastMode
              modelProfile.coerceToolParams
                ? (await import('./provider/tool-response-adapter.js')).coerceToolParams
                : undefined,
              undefined,
              {
                contextWindow: maxContextTokens,
                ...(requestKind ? { requestKind } : {}),
                observe: (snapshot) => {
                  const previous = typeof store.loadProviderPrefixSnapshot === 'function'
                    ? store.loadProviderPrefixSnapshot(session.id)
                    : null;
                  const continuity = compareProviderPrefixSnapshots(previous, snapshot);
                  if (typeof store.saveProviderPrefixSnapshot === 'function') {
                    store.saveProviderPrefixSnapshot(session.id, snapshot);
                  }
                  const log = continuity.cacheBreaking ? logger.warn.bind(logger) : logger.info.bind(logger);
                  log(
                    { sessionId: session.id, model, continuity, ...providerPrefixContinuityLogFields(continuity) },
                    providerPrefixContinuityLogMessage(continuity),
                  );
                  return continuity;
                },
              },
            );
            return;
          } catch (turnErr) {
            const status = (turnErr as { status?: number }).status;
            const code = (turnErr as { code?: string }).code;
            const msg = (turnErr as Error).message ?? '';
            // Rate limit errors (429 / allAccountsExhausted) are fully handled by the
            // provider (rotation + stall). Do NOT retry them here to avoid 429-spamming.
            const isRateLimit = status === 429 || (turnErr as any).allAccountsExhausted ||
              (turnErr as any).providerPoolDry === true || /provider_pool_dry/i.test(msg) ||
              /all.*account.*rate.limited/i.test(msg);
            if (isRateLimit) throw turnErr;
            const isTransient = isTransientProviderFailure({
              message: msg,
              code,
              retryable: (turnErr as { retryable?: boolean }).retryable,
              status,
            }) || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE'
              || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_REQ_RETRY';
            if (!isTransient) {
              throw turnErr;
            }
            // Honor Cortex's Retry-After when present (admission guards send one).
            const jitter = resolveRetryDelayMs({
              attempt: retryAttempt,
              retryAfterMs: retryAfterMsFromError(turnErr),
            });
            if (!stallStartedAt) stallStartedAt = Date.now();
            bufferedEvents.push({
              type: 'error',
              error: formatRetryNotice({
                label: 'API error',
                code,
                status,
                message: msg,
                attempt: retryAttempt + 1,
                elapsedMs: Date.now() - stallStartedAt,
                delayMs: jitter,
              }),
              timestamp: Date.now(),
            });
            await sleepMs(jitter);
          }
        }
      })()
        .catch((err) => {
          turnError = err;
        })
        .finally(() => {
          turnDone = true;
          signalLive();
        });

      // Flush live content/reasoning during turn execution.
      while (!turnDone || liveEvents.length > 0) {
        while (liveEvents.length > 0) {
          const ev = liveEvents.shift();
          if (ev) yield ev;
        }
        if (turnDone) break;
        await new Promise<void>((resolve) => {
          wakeLive = resolve;
          if (turnDone || liveEvents.length > 0) {
            signalLive();
          }
        });
      }

      await turnPromise;
      unsub();
      if (turnError) throw turnError;
      if (!result) throw new Error('Turn completed without a result');

      // De-duplicate tool_start events by toolCallId for CLI/pipe consumers.
      // executeTurn intentionally emits tool_start twice for the same call id:
      //   1) placeholder input at tool_use_start, 2) final parsed input at tool_use_end.
      // TUI merges these by id, but exec/pipe output should emit just one start.
      const normalizedEvents: AgentEvent[] = [];
      const toolStartIdxById = new Map<string, number>();
      for (const ev of bufferedEvents) {
        if (ev.type === 'tool_start') {
          const prevIdx = toolStartIdxById.get(ev.toolCallId);
          if (prevIdx != null) {
            normalizedEvents[prevIdx] = ev; // keep the latest (has complete input)
          } else {
            toolStartIdxById.set(ev.toolCallId, normalizedEvents.length);
            normalizedEvents.push(ev);
          }
          continue;
        }
        normalizedEvents.push(ev);
      }

      // Yield normalized events (content, tool_start, tool_complete, etc.)
      for (const ev of normalizedEvents) {
        yield ev;
      }

      result.assistantMessage.id = assistantMessageId;
      result.assistantMessage.executionId = assistantMessageId;
      messages.push(result.assistantMessage);
      store.appendMessage(session.id, result.assistantMessage);

      if (result.toolResults.length > 0) {
        // Apply model-specific tool response adapter (e.g., qwen-code todo nudge)
        let adaptFn: ((toolName: string, content: string, input: Record<string, unknown>, metadata?: Record<string, unknown>, isError?: boolean) => string) | undefined;
        if (modelProfile.toolResponseFormat) {
          const { adaptToolResult } = await import('./provider/tool-response-adapter.js');
          adaptFn = (toolName, content, input, metadata, isError) =>
            adaptToolResult(modelProfile.toolResponseFormat, toolName, content, input, metadata, isError);
        }
        const trMsg: Message = {
          role: 'user',
          content: result.toolResults.map((tr) => {
            let content = tr.content;
            if (adaptFn) {
              const tc = result!.toolCalls.find((c) => c.id === tr.toolUseId);
              if (tc) content = adaptFn(tc.name, tr.content, tc.input, tr.metadata, tr.isError);
            }
            return {
              type: 'tool_result' as const,
              toolUseId: tr.toolUseId,
              content,
              isError: tr.isError,
              image: tr.image,
            };
          }),
          timestamp: Date.now(),
        };
        messages.push(trMsg);
        store.appendMessage(session.id, trMsg);
      }

      totalInputTokens += result.inputTokens;
      if (result.inputTokens > 0) lastReportedPromptTokens = result.inputTokens; // SCLI-182
      if (result.providerPromptEstimate != null && result.providerPromptEstimate > 0) {
        lastProviderPromptEstimate = result.providerPromptEstimate;
      }
      totalOutputTokens += result.outputTokens;
      if (result.cacheCreationInputTokens) totalCacheCreationInputTokens += result.cacheCreationInputTokens;
      if (result.cacheReadInputTokens) totalCacheReadInputTokens += result.cacheReadInputTokens;
      store.updateTokens(session.id, result.inputTokens, result.outputTokens);

      if (toolSearchEnabled) {
        const newToolDefs = getToolDefs();
        if (newToolDefs.length !== toolDefs.length) {
          toolDefs = newToolDefs;
          systemOverheadTokens = estimateOverheadTokens(systemPrompt, toolDefs, model);
        }
      }

      // This boundary exists even for a text-only final response. Compact here
      // so a finished turn is safe to resume and a tool turn cannot enter its
      // next provider call with an over-threshold transcript.
      if (await compactAutomaticallyIfNeeded(providerPromptTokensOrEstimate(
        lastReportedPromptTokens,
        lastProviderPromptEstimate,
      ))) {
        compactionAction = 'compact';
      }

      // Capture before yield so consumer-side processing delay isn't included
      // in turnDurationMs (mirrors the same hoist in agent/loop.ts).
      const turnDurationMs = Date.now() - turnStart;

      yield {
        type: 'turn_complete', turnIndex,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        durationMs: turnDurationMs, timestamp: Date.now(),
      };

      // SCLI-31 (P1): capture this turn into the shared run-telemetry window +
      // durable sink — same helper the TUI loop uses. Best-effort; never breaks
      // a turn. (loopGuardHit is the TUI loop's signature-based guard, which the
      // exec loop doesn't track — omit it here.)
      try {
        recordTurnTelemetry({
          window: telemetryWindow,
          sink: telemetrySink,
          result,
          providerName: provider.name,
          runId: telemetryRunId,
          ...(telemetryAgentLabel ? { agentLabel: telemetryAgentLabel } : {}),
          turnIndex,
          model,
          turnDurationMs,
          promptBudget,
          compactionAction,
          preProviderBudgetExceeded,
        });
      } catch { /* telemetry is best-effort */ }
      // SCLI-32: run the window-driven struggle heuristics now that this turn's
      // record is in the window. The per-turn wildcard above has already
      // unsubscribed, so capture any struggle events the heuristics emit and
      // yield them here too (review P2) — otherwise they reach the auto-filer but
      // are dropped from the exec/SSE event stream. Best-effort; never breaks a turn.
      const turnStruggles: AgentEvent[] = [];
      const struggleCapture = emitter.on('struggle', (e: AgentEvent) => { turnStruggles.push(e); });
      try {
        const _c = result.assistantMessage.content;
        const _txt = typeof _c === 'string' ? _c
          : Array.isArray(_c) ? (_c as any[]).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
        const _isThinkingOnly = !_txt.replace(/<think>[\s\S]*?<\/think>/g, '').trim() && _txt.length > 0;
        const continuing = result.toolCalls.length > 0
          || (_isThinkingOnly && modelProfile.supportsThinking && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY);
        if (!continuing && taskRegistry.runningCount > 0 && isBackgroundTaskWaitContentIntent(_c)) {
          struggleAnalyzer.onTurnRecorded(true);
        } else {
          struggleAnalyzer.onTurnRecorded(continuing);
        }
      } catch { /* best-effort */ }
      struggleCapture();
      for (const s of turnStruggles) yield s;

      turnIndex++;

      // Continuation logic:
      if (result.toolCalls.length === 0) {
        // Bench/`shizuha exec` is this loop, not runAgent(). Continue must
        // run before the incomplete-terminal, including finish_reason=stop
        // after a 16k think (llama.cpp often emits stop, not length).
        if (shouldContinueAutonomousMaxTokens({
          stopReason: result.stopReason,
          permissionMode,
          reasoningText: reasoningTextFromContent(result.assistantMessage.content),
          recoveryCount: thinkingOnlyRecoveryCount,
          maxRecovery: MAX_THINKING_ONLY_RECOVERY,
          outputTokens: result.outputTokens,
        })) {
          thinkingOnlyRecoveryCount++;
          logger.warn(
            { turnIndex, attempt: thinkingOnlyRecoveryCount, outputTokens: result.outputTokens, stopReason: result.stopReason },
            'SCLI: max_tokens hit on a thinking-only autonomous turn — continuing so the model can tool-call',
          );
          const continueMsg: Message = {
            role: 'user',
            content: AUTONOMOUS_MAX_TOKENS_CONTINUE_PROMPT,
            timestamp: Date.now(),
          };
          messages.push(continueMsg);
          store.appendMessage(session.id, continueMsg);
          continue;
        }
        const incompleteError = incompleteTurnError(result.stopReason);
        if (incompleteError) {
          logger.warn({ turnIndex, stopReason: result.stopReason }, 'SCLI exec: model turn ended incomplete; refusing automatic replay');
          yield { type: 'error', error: incompleteError, timestamp: Date.now() };
          break;
        }

        // Thinking-only response: model generated <think>...</think> but no action/tool calls.
        // Strip thinking blocks to check if there's actual task output.
        const contentForCheck = result.assistantMessage.content;
        const contentCheckStr = typeof contentForCheck === 'string' ? contentForCheck
          : Array.isArray(contentForCheck) ? contentForCheck.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') : '';
        const strippedCheck = contentCheckStr.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
        // GLM/local-model fallback: answer landed entirely in the reasoning channel
        // with no text content. Surface it and stop instead of nudge-looping.
        if (!strippedCheck) {
          const reasoningStr = Array.isArray(contentForCheck)
            ? contentForCheck
                .filter((b: any) => b.type === 'reasoning')
                .map((b: any) => typeof b.rawContent === 'string' ? b.rawContent : '')
                .join('\n').trim()
            : '';
          if (reasoningStr.length > 0) {
            yield { type: 'content', text: reasoningStr, timestamp: Date.now() };
            break;
          }
        }
        if (!strippedCheck && modelProfile.supportsThinking && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY) {
          truncationRecoveryCount++;
          process.stderr.write(`[thinking-only] Turn ${turnIndex}: model produced thinking but no action — re-prompting\n`);
          const continueMsg: Message = {
            role: 'user',
            content: 'Continue. Use your tools to implement the solution.',
            timestamp: Date.now(),
          };
          messages.push(continueMsg);
          store.appendMessage(session.id, continueMsg);
          continue;
        }

        const backgroundAction = await decideBackgroundTaskContinuation({
          controller: backgroundTaskWait,
          registry: taskRegistry,
          toolCallCount: result.toolCalls.length,
          assistantContent: result.assistantMessage.content,
        });
        if (backgroundAction === 'continue') continue;
        if (backgroundAction === 'nudge') {
          const nudgeMsg = backgroundTaskWait.nudgeMessage();
          messages.push(nudgeMsg);
          store.appendMessage(session.id, nudgeMsg);
          continue;
        }

        // Text-only response with actual content → STOP.
        break;
      }
      // Has tool calls → reset truncation counter and continue
      truncationRecoveryCount = 0;
    }
  } catch (err) {
    yield { type: 'error', error: (err as Error).message, timestamp: Date.now() };
  } finally {
    // SCLI-32: tear down the analyzer (clears the STALL idle timer), DRAIN any
    // in-flight auto-filings (so a struggle bug from the final turn lands before
    // the -p/exec process exits), then unsubscribe. All exit paths incl. error.
    struggleAnalyzer.destroy();
    backgroundTaskWait.dispose();
    await struggleAutoFilerFlush();
    struggleAutoFilerUnsub();
    await mcpManager.disconnectAll();
    store.close();
  }

  yield {
    type: 'complete', totalTurns: turnIndex,
    totalInputTokens, totalOutputTokens,
    totalCacheCreationInputTokens, totalCacheReadInputTokens,
    totalDurationMs: Date.now() - startTime, timestamp: Date.now(),
  };
}
