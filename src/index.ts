import * as crypto from 'node:crypto';
import { Command } from 'commander';
import { runAgent } from './agent/loop.js';
import { toNDJSON } from './events/stream.js';
import { loadConfig } from './config/loader.js';
import { launchTUI } from './tui/App.js';
import type { AgentConfig, MCPServerConfig } from './agent/types.js';
import type { PermissionMode } from './permissions/types.js';

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
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .option('--mode <mode>', 'Permission mode (plan/supervised/autonomous)')
  .option('--json', 'Output NDJSON events (with -p)')
  .action(async (opts) => {
    // If -p is given, run in exec mode (non-interactive)
    if (opts.prompt) {
      const config: AgentConfig = {
        model: opts.model,
        cwd: opts.cwd as string,
        maxTurns: 0,
        permissionMode: (opts.mode as AgentConfig['permissionMode']) ?? 'autonomous',
        mcpServers: [],
        temperature: 0,
      };

      const isJSON = opts.json as boolean;
      let finalText = '';

      for await (const event of runAgentWithPrompt(config, opts.prompt as string)) {
        if (isJSON) {
          process.stdout.write(toNDJSON(event));
        } else {
          if (event.type === 'content') {
            process.stdout.write(event.text);
            finalText += event.text;
          } else if (event.type === 'tool_start') {
            process.stderr.write(`\n[Tool] ${formatToolInvocation(event.toolName, event.input)}\n`);
          } else if (event.type === 'tool_complete') {
            if (event.isError) {
              process.stderr.write(`[Error: ${event.result.slice(0, 200)}]\n`);
            }
          } else if (event.type === 'error') {
            process.stderr.write(`\n[Error: ${event.error}]\n`);
          } else if (event.type === 'complete') {
            if (!isJSON && finalText) process.stdout.write('\n');
            process.stderr.write(
              `\n[Done: ${event.totalTurns} turns, ${event.totalInputTokens}+${event.totalOutputTokens} tokens, ${(event.totalDurationMs / 1000).toFixed(1)}s]\n`,
            );
          }
        }
      }
      return;
    }

    // Default: launch interactive TUI
    launchTUI({
      cwd: opts.cwd as string,
      model: opts.model as string | undefined,
      mode: opts.mode as PermissionMode | undefined,
    });
  });

program
  .command('exec')
  .description('Execute a prompt and return results')
  .requiredOption('-p, --prompt <text>', 'The prompt to execute')
  .option('-m, --model <model>', 'Model to use')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .option('--max-turns <n>', 'Maximum turns', '0')
  .option('--mode <mode>', 'Permission mode (plan/supervised/autonomous)', 'autonomous')
  .option('--json', 'Output NDJSON events')
  .option('--mcp-server <cmd>', 'MCP server command (can be repeated)', (val: string, prev: string[]) => [...prev, val], [] as string[])
  .option('--temperature <n>', 'Temperature', '0')
  .option('--thinking <level>', 'Claude extended thinking (off/on)')
  .option('--effort <level>', 'Codex reasoning effort (low/medium/high/xhigh)')
  .option('--sandbox <mode>', 'OS-level sandbox (unrestricted/read-only/workspace-write/external)')
  .option('--toolset <name>', 'Tool profile (full/safe/local/developer/architect/engineer/qa_engineer/...)')
  .action(async (opts) => {
    const mcpServers: MCPServerConfig[] = (opts.mcpServer as string[]).map((cmd, i) => ({
      name: `mcp_${i}`,
      transport: 'stdio' as const,
      command: cmd.split(' ')[0]!,
      args: cmd.split(' ').slice(1),
    }));

    const config: AgentConfig = {
      model: opts.model,
      cwd: opts.cwd as string,
      maxTurns: parseInt(opts.maxTurns as string, 10),
      permissionMode: opts.mode as AgentConfig['permissionMode'],
      mcpServers,
      temperature: parseFloat(opts.temperature as string),
      thinkingLevel: opts.thinking as string | undefined,
      reasoningEffort: opts.effort as string | undefined,
      sandboxMode: opts.sandbox as AgentConfig['sandboxMode'],
      toolset: opts.toolset as string | undefined,
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
    let finalText = '';

    for await (const event of runAgentWithPrompt(agentConfig, opts.prompt as string)) {
      if (isJSON) {
        process.stdout.write(toNDJSON(event));
      } else {
        if (event.type === 'content') {
          process.stdout.write(event.text);
          finalText += event.text;
        } else if (event.type === 'reasoning_text') {
          // Show live reasoning/thinking text (dimmed on stderr so it doesn't mix with content)
          process.stderr.write(`\x1b[2m${event.text}\x1b[0m`);
        } else if (event.type === 'tool_start') {
          process.stderr.write(`\n[Tool] ${formatToolInvocation(event.toolName, event.input)}\n`);
        } else if (event.type === 'tool_complete') {
          if (event.isError) {
            process.stderr.write(`[Error: ${event.result.slice(0, 200)}]\n`);
          }
        } else if (event.type === 'error') {
          process.stderr.write(`\n[Error: ${event.error}]\n`);
        } else if (event.type === 'complete') {
          if (!isJSON && finalText) process.stdout.write('\n');
          process.stderr.write(
            `\n[Done: ${event.totalTurns} turns, ${event.totalInputTokens}+${event.totalOutputTokens} tokens, ${(event.totalDurationMs / 1000).toFixed(1)}s]\n`,
          );
        }
      }
    }
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
  .option('--effort <level>', 'Codex reasoning effort (low/medium/high/xhigh)')
  .action(async (opts) => {
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

    for await (const line of rl) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type !== 'user') continue;
      const userContent = (msg.message as Record<string, unknown> | undefined)?.content as string;
      if (!userContent) continue;
      const incomingSessionId =
        (typeof msg.session_id === 'string' ? msg.session_id : undefined)
        ?? (typeof msg.sessionId === 'string' ? msg.sessionId : undefined)
        ?? '';
      const sessionKey = incomingSessionId.trim() || DEFAULT_PIPE_SESSION_KEY;
      const resumeSessionId = pipeSessionMap.get(sessionKey);

      const config: AgentConfig = {
        model: opts.model as string,
        cwd: process.cwd(),
        maxTurns: parseInt(opts.maxTurns as string, 10),
        permissionMode: opts.mode as AgentConfig['permissionMode'],
        mcpServers,
        systemPrompt: opts.systemPrompt as string | undefined,
        thinkingLevel: opts.thinking as string | undefined,
        reasoningEffort: opts.effort as string | undefined,
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
    const { startServer } = await import('./server.js');
    await startServer(parseInt(opts.port as string, 10), opts.host as string);
  });

program
  .command('gateway')
  .description('Start the agent as a persistent gateway process')
  .option('-p, --port <n>', 'HTTP port', '8015')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Default model')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .option('--mode <mode>', 'Permission mode (plan/supervised/autonomous)', 'autonomous')
  .option('--agent-id <id>', 'Agent identity (for eternal session)')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username (for per-agent config from ~/.shizuha/agents/{username}/)')
  .option('--thinking <level>', 'Thinking level (off/on/low/medium/high)')
  .option('--effort <level>', 'Reasoning effort (low/medium/high/xhigh)')
  .option('--context-prompt <prompt>', 'Platform context prompt (fallback if no per-agent CLAUDE.md)')
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
    const { AgentProcess } = await import('./gateway/agent-process.js');
    const { HttpChannel } = await import('./gateway/channels/http.js');

    const agent = new AgentProcess({
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      model: opts.model as string | undefined,
      cwd: opts.cwd as string,
      permissionMode: opts.mode as 'plan' | 'supervised' | 'autonomous',
      thinkingLevel: opts.thinking as string | undefined,
      reasoningEffort: opts.effort as string | undefined,
      contextPrompt: opts.contextPrompt as string | undefined,
      channels: [], // Channels registered below
    });

    // HTTP channel (always enabled)
    const httpChannel = new HttpChannel({
      port: parseInt(opts.port as string, 10),
      host: opts.host as string,
      getMessages: () => agent.getMessages(),
      getSessionId: () => agent.getSessionId(),
      getFanOutSettings: () => agent.getFanOutSettings(),
      setFanOut: (type, enabled) => agent.setFanOut(type as any, enabled),
    });
    agent.registerChannel(httpChannel);

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
      const { EventLog } = await import('./daemon/event-log.js');
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
        respondMode: (opts.discordMode as 'mention' | 'dm' | 'all') ?? 'mention',
      });
      agent.registerChannel(discordChannel);
    }

    // WhatsApp channel (if --whatsapp-token or WHATSAPP_ACCESS_TOKEN provided)
    const waToken = (opts.whatsappToken as string | undefined)
      ?? process.env['WHATSAPP_ACCESS_TOKEN'];
    const waPhoneId = (opts.whatsappPhoneId as string | undefined)
      ?? process.env['WHATSAPP_PHONE_NUMBER_ID'];
    if (waToken && waPhoneId) {
      const { WhatsAppChannel } = await import('./gateway/channels/whatsapp.js');
      const verifyToken = (opts.whatsappVerifyToken as string | undefined)
        ?? process.env['WHATSAPP_VERIFY_TOKEN']
        ?? crypto.randomUUID().slice(0, 16);
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
        webhookPort: parseInt(opts.whatsappWebhookPort as string, 10),
        allowedNumbers,
        appSecret: (opts.whatsappAppSecret as string | undefined)
          ?? process.env['WHATSAPP_APP_SECRET'],
      });
      agent.registerChannel(waChannel);
      console.log(`WhatsApp webhook verify token: ${verifyToken}`);
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
        respondMode: (opts.slackMode as 'mention' | 'dm' | 'all') ?? 'mention',
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
        webhookPort: parseInt(opts.lineWebhookPort as string, 10),
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
  .option('--model <model>', 'Claude model', 'claude-opus-4-6')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .option('--agent-id <id>', 'Agent identity')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username')
  .option('--thinking <level>', 'Thinking level (off/on/low/medium/high)')
  .option('--effort <level>', 'Reasoning effort')
  .option('--context-prompt <prompt>', 'System prompt appendix')
  .action(async (opts) => {
    const { startClaudeBridge } = await import('./claude-bridge/index.js');
    await startClaudeBridge({
      port: parseInt(opts.port as string, 10),
      host: opts.host as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      thinkingLevel: opts.thinking as string | undefined,
      reasoningEffort: opts.effort as string | undefined,
      contextPrompt: opts.contextPrompt as string | undefined,
      cwd: opts.cwd as string,
    });
  });

program
  .command('codex-bridge')
  .description('Bridge Codex CLI (codex exec --json) to the gateway HTTP/WS protocol')
  .option('-p, --port <n>', 'HTTP port', '8020')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Codex model', 'o4-mini')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .option('--agent-id <id>', 'Agent identity')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username')
  .option('--effort <level>', 'Reasoning effort')
  .option('--context-prompt <prompt>', 'System prompt appendix')
  .action(async (opts) => {
    const { startCodexBridge } = await import('./codex-bridge/index.js');
    await startCodexBridge({
      port: parseInt(opts.port as string, 10),
      host: opts.host as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      reasoningEffort: opts.effort as string | undefined,
      contextPrompt: opts.contextPrompt as string | undefined,
      cwd: opts.cwd as string,
    });
  });

program
  .command('openclaw-bridge')
  .description('Bridge OpenClaw (openclaw agent --local --json) to the gateway HTTP/WS protocol')
  .option('-p, --port <n>', 'HTTP port', '8021')
  .option('-h, --host <addr>', 'HTTP host', '0.0.0.0')
  .option('--model <model>', 'Model to use', 'gpt-5.3-codex-spark')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .option('--agent-id <id>', 'Agent identity')
  .option('--agent-name <name>', 'Agent display name')
  .option('--agent-username <username>', 'Agent username')
  .option('--effort <level>', 'Reasoning effort')
  .option('--thinking <level>', 'Thinking level')
  .option('--context-prompt <prompt>', 'System prompt appendix')
  .action(async (opts) => {
    const { startOpenClawBridge } = await import('./openclaw-bridge/index.js');
    await startOpenClawBridge({
      port: parseInt(opts.port as string, 10),
      host: opts.host as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      reasoningEffort: opts.effort as string | undefined,
      thinkingLevel: opts.thinking as string | undefined,
      contextPrompt: opts.contextPrompt as string | undefined,
      cwd: opts.cwd as string,
    });
  });

program
  .command('cron-mcp')
  .description('Run the cron MCP server (stdio) — provides schedule_job/list_jobs/remove_job tools')
  .option('--workspace <dir>', 'Workspace directory for cron store', '/workspace')
  .action(async (opts) => {
    // Set env for the MCP server module
    process.env['WORKSPACE'] = opts.workspace as string;
    await import('./cron-mcp/server.js');
  });

program
  .command('config')
  .description('Show resolved configuration')
  .option('--cwd <dir>', 'Working directory', process.cwd())
  .action(async (opts) => {
    const config = await loadConfig(opts.cwd as string);
    console.log(JSON.stringify(config, null, 2));
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
      console.log(`  ${d.deviceName} (${d.platform})`);
      console.log(`    ID: ${d.deviceId}`);
      console.log(`    IP: ${d.remoteIp}`);
      console.log(`    Created: ${created}`);
      console.log(`    Last seen: ${lastSeen}`);
      console.log('');
    }
  });

devicesCmd
  .command('revoke <deviceId>')
  .description('Revoke a paired device')
  .action(async (deviceId: string) => {
    const { removeDevice: rd } = await import('./devices/store.js');
    const ok = rd(deviceId);
    if (ok) {
      console.log(`Device ${deviceId} revoked.`);
    } else {
      console.error(`Device ${deviceId} not found.`);
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
        console.log(`Device paired: ${newest.deviceName} (${newest.platform}) from ${newest.remoteIp}`);
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
  .command('codex')
  .description('Authenticate with OpenAI Codex via device code flow (free with ChatGPT)')
  .action(async () => {
    const { codexDeviceAuth } = await import('./auth/codex-device-auth.js');

    console.log('\n  Authenticating with ChatGPT (Codex)...');
    console.log('  Free with any ChatGPT account — uses gpt-5.3-codex-spark\n');

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
    const { readCredentials, readCodexAccounts } = await import('./config/credentials.js');
    const { getShizuhaAuthStatus } = await import('./config/shizuhaAuth.js');

    const creds = readCredentials();
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
    if (anthropicCount > 0) {
      console.log(`  Anthropic: ${anthropicCount} token(s)`);
    } else if (process.env['ANTHROPIC_API_KEY']) {
      console.log('  Anthropic: API key (env)');
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
  .command('doctor')
  .description('Check system health and diagnose issues')
  .action(async () => {
    const { runDoctor, printChecks } = await import('./commands/doctor.js');
    const checks = await runDoctor(process.cwd());
    printChecks(checks);
    const failed = checks.filter(c => c.status === 'fail').length;
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
  const { compactMessages } = await import('./state/compaction.js');
  const { needsCompaction } = await import('./prompt/context.js');
  const { resolveModelContextWindow } = await import('./provider/context-window.js');
  const { microcompactLatest } = await import('./state/microcompaction.js');
  const { MCPManager } = await import('./tools/mcp/manager.js');
  const { registerMCPTools } = await import('./tools/mcp/bridge.js');
  const { executeTurn } = await import('./agent/turn.js');

  const cfg = await lc(config.cwd);
  let model = config.model ?? cfg.agent.defaultModel;
  const cwd = config.cwd ?? cfg.agent.cwd;
  const maxTurns = config.maxTurns ?? cfg.agent.maxTurns;
  const temperature = config.temperature ?? cfg.agent.temperature;
  const maxOutputTokens = config.maxOutputTokens ?? cfg.agent.maxOutputTokens;
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
  const maxContextTokens = config.maxContextTokens
    ?? cfg.agent.maxContextTokens
    ?? resolveModelContextWindow(model, provider.maxContextWindow);
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools(toolRegistry);
  // Unregister client-side web_search when provider handles it natively
  if (provider.supportsNativeWebSearch) {
    toolRegistry.unregister('web_search');
  }
  // Disable sub-agent task tool in exec mode — it's not wired up and wastes turns.
  // The model generates full file contents as task prompts that are never executed,
  // then has to regenerate everything with direct write calls.
  toolRegistry.unregister('task');

  // Apply toolset filter — restrict available tools by role profile
  const toolsetName = config.toolset ?? cfg.agent.toolset;
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

  const toolDefs = toolRegistry.definitions();
  const skillCatalogStr = skillReg.size > 0 ? skillReg.buildCatalog() : undefined;
  const systemPrompt = config.systemPrompt ?? await buildSystemPrompt({ cwd, tools: toolDefs, skillCatalog: skillCatalogStr });

  // Start from persisted session history so pipe turns can continue context.
  const messages: Message[] = [...session.messages];
  if (mcpManager.failedServers.length > 0) {
    const failedList = mcpManager.failedServers
      .map((f: { name: string; error: string }) => `- ${f.name}: ${f.error}`)
      .join('\n');
    const total = mcpManager.failedServers.length + mcpManager.size;
    const diagnostic = `[System Notice] ${mcpManager.failedServers.length}/${total} MCP tool servers failed to connect. You are operating with reduced capabilities.\n\nFailed servers:\n${failedList}\n\nInform the user about this limitation. Do not pretend everything is normal.`;
    messages.push({ role: 'user', content: diagnostic, timestamp: Date.now() });
    messages.push({ role: 'assistant', content: 'Understood. I will inform the user about the degraded tool availability.', timestamp: Date.now() });
  }
  const userMessage: Message = { id: crypto.randomUUID(), executionId: assistantMessageId, role: 'user', content: prompt, timestamp: Date.now() };
  messages.push(userMessage);
  store.appendMessage(session.id, userMessage);

  const { BackgroundTaskRegistry } = await import('./tasks/registry.js');
  const taskRegistry = new BackgroundTaskRegistry();
  const sandboxCfg = config.sandbox;
  const sandbox = sandboxCfg?.mode !== 'unrestricted' ? sandboxCfg : undefined;
  const toolContext = { cwd, sessionId: session.id, taskRegistry, sandbox };
  const startTime = Date.now();
  let turnIndex = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreationInputTokens = 0;
  let totalCacheReadInputTokens = 0;

  // Continuation logic:
  // - Text-only response (no tool_use) → STOP immediately (no nudges)
  // - max_tokens truncation → nudge "response was cut off" up to 3 times
  // - Has tool_use → execute tools, continue loop
  // Same Opus 4.6 model means same behavior — no workaround nudges needed.
  const MAX_TRUNCATION_RECOVERY = 3;
  let truncationRecoveryCount = 0;

  try {
    while (!maxTurns || turnIndex < maxTurns) {
      yield { type: 'turn_start', turnIndex, timestamp: Date.now() };
      const turnStart = Date.now();

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
        if (ev.type === 'content' || ev.type === 'reasoning' || ev.type === 'reasoning_text') {
          liveEvents.push(ev);
          signalLive();
          return;
        }
        bufferedEvents.push(ev);
      });

      // Retry transient API errors at the session level (matches TUI session.ts)
      const SESSION_MAX_RETRIES = 3;
      const turnPromise = (async () => {
        for (let retryAttempt = 0; ; retryAttempt++) {
          try {
            result = await executeTurn(
              messages, provider, model, systemPrompt, toolDefs,
              toolRegistry, permissions, emitter, toolContext,
              maxOutputTokens, temperature,
              undefined, // onPermissionAsk — not used in exec mode
              undefined, // hookEngine
              thinkingLevel,
              undefined, // abortSignal
              reasoningEffort,
            );
            return;
          } catch (turnErr) {
            const status = (turnErr as { status?: number }).status;
            const code = (turnErr as { code?: string }).code;
            const msg = (turnErr as Error).message ?? '';
            // Rate limit errors (429 / allAccountsExhausted) are fully handled by the
            // provider (rotation + stall). Do NOT retry them here to avoid 429-spamming.
            const isRateLimit = status === 429 || (turnErr as any).allAccountsExhausted ||
              /all.*account.*rate.limited/i.test(msg);
            if (isRateLimit) throw turnErr;
            const isTransient = (status != null && status >= 500) ||
              code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE';
            if (!isTransient || retryAttempt >= SESSION_MAX_RETRIES) {
              throw turnErr;
            }
            const delay = Math.min(1000 * Math.pow(2, retryAttempt), 16000);
            const jitter = delay * (0.75 + Math.random() * 0.5);
            bufferedEvents.push({
              type: 'error',
              error: `API error (${status ?? code}), retrying in ${Math.round(jitter / 1000)}s... (${retryAttempt + 1}/${SESSION_MAX_RETRIES})`,
              timestamp: Date.now(),
            });
            await new Promise((r) => setTimeout(r, jitter));
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
        const trMsg: Message = {
          role: 'user',
          content: result.toolResults.map((tr) => ({
            type: 'tool_result' as const,
            toolUseId: tr.toolUseId,
            content: tr.content,
            isError: tr.isError,
            image: tr.image,
          })),
          timestamp: Date.now(),
        };
        messages.push(trMsg);
        microcompactLatest(messages);
        store.appendMessage(session.id, trMsg);
      }

      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      if (result.cacheCreationInputTokens) totalCacheCreationInputTokens += result.cacheCreationInputTokens;
      if (result.cacheReadInputTokens) totalCacheReadInputTokens += result.cacheReadInputTokens;
      store.updateTokens(session.id, result.inputTokens, result.outputTokens);

      yield {
        type: 'turn_complete', turnIndex,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens,
        cacheCreationInputTokens: result.cacheCreationInputTokens,
        cacheReadInputTokens: result.cacheReadInputTokens,
        durationMs: Date.now() - turnStart, timestamp: Date.now(),
      };

      turnIndex++;

      // Continuation logic:
      if (result.toolCalls.length === 0) {
        const isClaudeModel = model.startsWith('claude-');
        // No tool calls — check if this was a max_tokens truncation
        if (isClaudeModel && result.stopReason === 'max_tokens' && truncationRecoveryCount < MAX_TRUNCATION_RECOVERY) {
          // Response was cut off — nudge to continue (Claude models only)
          truncationRecoveryCount++;
          const nudgeMsg: Message = {
            role: 'user',
            content: 'Your response was cut off because it exceeded the output token limit. Please break your work into smaller pieces. Continue from where you left off.',
            timestamp: Date.now(),
          };
          messages.push(nudgeMsg);
          store.appendMessage(session.id, nudgeMsg);
          continue;
        }
        // Text-only response → STOP. Claude alone gets truncation nudges here.
        break;
      }
      // Has tool calls → reset truncation counter and continue
      truncationRecoveryCount = 0;

      if (needsCompaction(messages, maxContextTokens)) {
        const { messages: compacted, compacted: didCompact } = await compactMessages(messages, provider, model, maxContextTokens);
        if (didCompact) {
          messages.length = 0;
          messages.push(...compacted);
          store.replaceMessages(session.id, compacted);
        }
      }
    }
  } catch (err) {
    yield { type: 'error', error: (err as Error).message, timestamp: Date.now() };
  } finally {
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
