import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Command } from 'commander';
import { CLI_VERSION } from './shared/version.js';
import { runAgent, createTurnTelemetrySink, setActiveTelemetryWindow } from './agent/loop.js';
import { TurnTelemetryWindow, recordTurnTelemetry } from './telemetry/turn-telemetry.js';
import {
  classifyPromptSource,
  classifyPromptText,
  estimatePromptTokenBudget,
  heartbeatBudgetConfig,
  type HeartbeatCompactionAction,
} from './agent/heartbeat-hygiene.js';
import { StruggleAnalyzer } from './agent/struggle-analyzer.js';
import { setupStrugglePulseAutoFiler } from './telemetry/struggle-auto-filer.js';
import { toNDJSON } from './events/stream.js';
import { writeExecEvent, type ExecAcc } from './cli/exec-channel.js';
import { validateImageSelector } from './cli/image-selector.js';
import { loadConfig } from './config/loader.js';
import { redactConfigForOutput } from './config/redaction.js';
import { launchTUI } from './tui/App.js';
import { StateStore } from './state/store.js';
import type { AgentConfig, MCPServerConfig } from './agent/types.js';
import type { PermissionMode } from './permissions/types.js';
import { logger } from './utils/logger.js';
import { assertWorkspaceDir } from './utils/fs.js';
import { inert, isInert } from './utils/display.js';
import {
  BackgroundTaskWaitController,
  decideBackgroundTaskContinuation,
  isBackgroundTaskWaitContentIntent,
} from './agent/background-task-wait.js';
import {
  exitOnOptionPreflightError,
  OptionPreflightError,
  preflightOrExit,
  requireOptionalEnumNonEmpty,
  requireOptionalNonEmpty,
  PERMISSION_MODES,
  validateCommonAgentOptions,
} from './cli/option-preflight.js';
import { preflightMcpServersOrExit } from './cli/mcp-preflight.js';
import {
  incompleteTurnError,
  shouldContinueAutonomousMaxTokens,
} from './agent/incomplete-turn.js';
import { reasoningTextFromContent, visibleTextFromContent } from './agent/content.js';
import { versionQueryError } from './cli/version-query.js';

// Keep CLI output clean from Node runtime deprecation warnings.
process.noDeprecation = true;


const program = new Command();
program.option('--profile <name>', 'Plugin profile: default | fleet');
program.hook('preAction', (thisCommand, actionCommand) => {
  const profile = thisCommand.optsWithGlobals()['profile'];
  if (typeof profile === 'string' && profile.trim()) {
    process.env['SHIZUHA_PROFILE'] = profile.trim();
  }
  // SCLI-531: root `--json` is only applicable to the root action combined with
  // -p/--prompt. When it is combined with a named command (regardless of token
  // order — e.g. `shizuha --json status`), reject fail-closed UNLESS that exact
  // command declares its own documented structured-output contract (its own
  // `--json` option, e.g. exec/whoami/pulse list). Without this, `--json status`
  // / `--json doctor` silently drop the flag and run the human/TUI path with
  // exit 0, which automation mistakes for NDJSON success.
  if (program.opts().json && actionCommand !== program) {
    const hasOwnJson = actionCommand.options.some((o) => o.long === '--json');
    if (!hasOwnJson) {
      console.error(
        `Error: --json is not applicable to the '${actionCommand.name()}' command; use it with -p/--prompt on the root (shizuha --json -p "...") or the command's own structured-output flag`,
      );
      process.exit(1);
    }
  }
});

const SHIZUHA_LOGIN_REQUIRED = 'Not logged in. Run: shizuha login';

/**
 * Enforce the same local Shizuha identity boundary as `auth whoami` before a
 * command reads or mutates user-owned platform state.
 */
async function requireShizuhaLogin(): Promise<boolean> {
  const { readShizuhaAuth } = await import('./config/shizuhaAuth.js');
  if (readShizuhaAuth()) return true;
  console.error(SHIZUHA_LOGIN_REQUIRED);
  process.exitCode = 1;
  return false;
}

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
  .version(CLI_VERSION)
  .enablePositionalOptions()
  // SCLI-580: commander's built-in --help exits before the root action, so an
  // invalid --mode combined with --help (either order) was masked as success.
  // exitOverride lets the parse site catch the help exit AFTER commander has
  // fully parsed the argv (opts are populated) and reject an invalid mode with
  // the same field-specific diagnostic as the action path.
  .exitOverride()
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
      model: opts.model,
    });

    // SCLI-531: root --json is ONLY valid combined with a nonblank -p/--prompt
    // (the exec-mode NDJSON contract). Bare `--json`, `--json --resume <id>`,
    // or any other root composition must reject fail-closed BEFORE the
    // renderer/session/state initialization below — never silently fall through
    // to a fresh interactive TUI with a polished human frame and exit 0.
    if (opts.json && !(typeof opts.prompt === 'string' && opts.prompt.trim() !== '')) {
      console.error(
        'Error: --json requires -p/--prompt (e.g. shizuha --json -p "..." or shizuha --json --prompt "...")',
      );
      process.exit(1);
    }

    // SCLI-411: an explicit -p/--prompt selects headless execution. A
    // present-but-empty/whitespace prompt must reject nonzero BEFORE any
    // auth/provider/TUI/state work — never fall back to interactive mode.
    if (opts.prompt !== undefined) {
      try {
        requireOptionalNonEmpty('prompt', opts.prompt);
      } catch (err) {
        exitOnOptionPreflightError(err);
      }
    }

    // If -p is given, run in exec mode (non-interactive)
    if (opts.prompt !== undefined) {
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
    // PLAT-5893/SCLI-178/SCLI-523: resume exposes --mode/--cwd like the
    // root/exec/gateway actions. Run the same shared option-domain preflight
    // BEFORE any session load / TUI launch — an invalid/case-mismatched/
    // empty/whitespace --mode or empty/whitespace/non-directory --cwd must
    // reject pre-init instead of entering the full resume path and rendering
    // a blank permission-mode footer or silently accepting a bad cwd override.
    const pf = preflightOrExit({
      mode: opts.mode,
      model: opts.model,
      cwd: opts.cwd,
    });

    if (!sessionId.trim() || /^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/.test(sessionId)) {
      // SCLI-490: an empty/whitespace-only session-id must be rejected before
      // lookup — otherwise it reaches the identifier-free "Session not found:"
      // verdict and cannot tell the user whether the argument was missing,
      // stripped, or actually looked up.
      console.error('error: session-id must be a non-empty value');
      process.exitCode = 1;
      return;
    }
    if (!isInert(sessionId)) {
      console.error(`Invalid session id: ${inert(sessionId)}`);
      process.exitCode = 1;
      return;
    }
    // SCLI-418/SCLI-400: validate the optional --mode before any session-store /
    // TUI init. Explicit-empty (--mode=), whitespace-only, and out-of-domain
    // values must fail closed with a bounded diagnostic — never reach the state
    // lookup or launch a fresh TUI with an unknowable permission posture.
    try {
      const modeValue = (opts.mode as unknown) ?? undefined;
      if (modeValue !== undefined) {
        requireOptionalEnumNonEmpty('mode', modeValue, PERMISSION_MODES);
      }
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }

    // SCLI-523: a failed read-only session lookup must be state-free. StateStore
    // eagerly creates ~/.config/shizuha/state.db on construction, so a syntactically
    // valid but unknown session id must not mutate a pristine HOME. If no state.db
    // exists there is nothing to look up — reject before constructing the store.
    const stateDbPath = path.join(process.env['HOME'] ?? '.', '.config', 'shizuha', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      console.error(`Session not found: ${inert(sessionId)}`);
      process.exitCode = 1;
      return;
    }

    // SCLI-418 acceptance #2: reject a missing session BEFORE any state file is
    // created. StateStore's constructor eagerly mkdirs + opens + migrates the
    // DB, so a plain `new StateStore().loadSession(...)` leaves a fresh state.db
    // behind even on `Session not found`. Probe read-only (no DB -> no session,
    // state-free) and only open the real store when a session actually exists.
    if (!StateStore.sessionExists(sessionId)) {
      console.error(`Session not found: ${inert(sessionId)}`);
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
      cwd: (pf.cwd as string | undefined) ?? session.cwd,
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
      model: opts.model,
    });

    // SCLI-411: exec -p is required; a present-but-empty/whitespace prompt must
    // reject nonzero locally before any auth/provider work.
    try {
      requireOptionalNonEmpty('prompt', opts.prompt);
    } catch (err) {
      exitOnOptionPreflightError(err);
    }

    const mcpServers: MCPServerConfig[] = (opts.mcpServer as string[]).map((cmd, i) => ({
      name: `mcp_${i}`,
      transport: 'stdio' as const,
      command: cmd.split(' ')[0]!,
      args: cmd.split(' ').slice(1),
    }));

    // SCLI-517: fail closed on explicitly-requested --mcp-server entries before
    // any provider/session/state initialization.
    await preflightMcpServersOrExit(mcpServers);

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

    try {
      for await (const event of runAgentWithPrompt(agentConfig, opts.prompt as string, opts.resume as string | undefined, true)) {
        if (event.type === 'error') {
          hadFatalError = true;
        } else if (event.type === 'turn_complete') {
          hadFatalError = false;
        } else if (event.type === 'complete') {
          completeSeen = true;
        }
        writeExecEvent(event, isJSON, acc);
      }
    } catch (err) {
      // SCLI-517: a requested --mcp-server failed to connect — fail closed with
      // ONE bounded diagnostic, never a raw Node/bundle stack.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
    // Force exit — provider HTTP keep-alive pools (e.g. undici Agent in vllm provider
    // with 60s keepAliveTimeout) keep the event loop alive otherwise, hanging the CLI
    // after the final "complete" event for up to 10 min. exec is by definition a
    // one-shot; the OS reaps any lingering sockets.
    process.exit(hadFatalError || !completeSeen ? 1 : 0);
  });

/** SCLI-565: true when a --system-prompt override is empty or whitespace-only
 * (ASCII + Unicode whitespace, e.g. U+00A0, U+2003, U+3000). A blank override
 * would silently replace the governing instruction scaffold with nothing. */
export function isBlankSystemPromptValue(value: string): boolean {
  if (value.trim() === '') return true;
  return /^[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/.test(value);
}

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
      model: opts.model,
    });

    const { createInterface } = await import('readline');

    // SCLI-565: an explicitly-provided --system-prompt that is empty or
    // whitespace-only silently replaces the governing instruction scaffold
    // with nothing (the warm-pool pipe exits 0 with no diagnostic). Reject it
    // non-zero BEFORE any session startup or state mutation. Absent option
    // (undefined) is fine — it means "no override", not "blank override".
    if (opts.systemPrompt !== undefined && isBlankSystemPromptValue(opts.systemPrompt as string)) {
      process.stderr.write(
        'error: --system-prompt must be a non-blank value; empty and ' +
          'whitespace-only overrides are rejected (SCLI-565)\n',
      );
      process.exit(2);
    }

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
      // PLAT-9185: enforce the runtime lifecycle invariant at the pipe
      // entrypoint. Autonomous heartbeat/scheduled turns start a CLEAN
      // session — they must NOT resume the predecessor transcript. Seat
      // telemetry (2,190 runs, jun): 95.5% of successor heartbeat runs
      // inherited the prior run's full accumulated context (63% of runs
      // STARTED above 150K prompt tokens; longest monotone chain 176 runs;
      // max 373K) because every scheduler tick resumed the persistent
      // session. Pulse + memory + the working tree are the durable state;
      // the transcript is not. The predecessor session is disposed
      // (unload lifecycle) instead of silently retained.
      const incomingKind = classifyPromptText(userContent);
      let resumeSessionId = pipeSessionMap.get(sessionKey);
      if (incomingKind === 'heartbeat' || incomingKind === 'scheduled') {
        if (resumeSessionId) {
          try {
            const { StateStore } = await import('./state/store.js');
            new StateStore().deleteSession(resumeSessionId);
          } catch (err) {
            // Disposal is best-effort hygiene; a failed delete must never
            // block the turn. The clean-start decision is unaffected.
            logger.warn({ err, resumeSessionId }, 'heartbeat session disposal failed (non-fatal)');
          }
        }
        resumeSessionId = undefined;
      }

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
    // PLAT-5893/SCLI-566: legacy serve shares the SCLI-400 port AND host
    // preflight. Invalid ports and invalid/empty hosts reject pre-start with a
    // bounded diagnostic — never a raw ERR_SOCKET_BAD_PORT / node:dns
    // getaddrinfo stack, and never an empty-host listener bind.
    const pf = preflightOrExit({
      port: opts.port,
      requirePortField: true,
      host: opts.host,
    });
    const { startServer } = await import('./server.js');
    await startServer(pf.port!, (pf.host ?? '0.0.0.0') as string);
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
      contextPrompt: opts.contextPrompt,
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
      getVoiceS2SHost: () => agent.getVoiceS2SHost(),
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
      model: opts.model,
      contextPrompt: opts.contextPrompt,
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
  .option('--context-prompt-file <path>', 'System prompt appendix read from a file (avoids the OS argv size limit)')
  .action(async (opts) => {
    // SCLI-400: semantic preflight before bridge bootstrap. SCLI-558: pass
    // --cwd through the shared preflight (SCLI-529 contract) so empty /
    // whitespace / nonexistent / regular-file / FIFO / dangling-symlink values
    // fail before broker/auth/state/listener work, matching codex/openclaw.
    const pf = preflightOrExit({
      thinking: opts.thinking,
      effort: opts.effort,
      port: opts.port,
      requirePortField: true,
      host: opts.host,
      cwd: opts.cwd,
      model: opts.model,
      contextPrompt: opts.contextPrompt,
      contextPromptFile: opts.contextPromptFile,
    });
    let contextPrompt = pf.contextPrompt;
    if (pf.contextPromptFile) {
      try {
        const fsmod = await import('node:fs');
        contextPrompt = fsmod.readFileSync(pf.contextPromptFile, 'utf-8');
      } catch (err) {
        console.error(`Error: Invalid --context-prompt-file ${JSON.stringify(String(pf.contextPromptFile))}; ${(err as Error).message}`);
        process.exit(1);
      }
    }
    const { startAntigravityBridge } = await import('./antigravity-bridge/index.js');
    await startAntigravityBridge({
      port: pf.port!,
      host: (pf.host ?? '0.0.0.0') as string,
      model: opts.model as string,
      agentId: opts.agentId as string | undefined,
      agentName: opts.agentName as string | undefined,
      agentUsername: opts.agentUsername as string | undefined,
      contextPrompt,
      cwd: pf.cwd,
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
      contextPrompt: opts.contextPrompt,
      cwd: (opts.cwd as string | undefined) ?? '/workspace',
      model: opts.model,
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
  .option('--effort <level>', 'Reasoning effort (low/medium/high/xhigh/ultra/max)')
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
      contextPrompt: opts.contextPrompt,
      cwd: (opts.cwd as string | undefined) ?? '/workspace',
      model: opts.model,
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
    // SCLI-403: validate all proxy startup config BEFORE announcing startup or
    // initializing the stdio loop. Any invalid --upstream-url / --header yields
    // one concise CLI diagnostic and a nonzero exit — never a raw Node stack.
    const { resolveProxyConfig, runMcpProxy } = await import('./mcp-proxy/server.js');
    let config;
    try {
      config = resolveProxyConfig(
        {
          name: opts.name as string | undefined,
          upstreamUrl: opts.upstreamUrl as string | undefined,
          header: opts.header as string[] | undefined,
        },
        process.env,
      );
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
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
    const { runMcpMultiplexer, validateMcpMultiplexerConfig } = await import('./mcp-multiplexer/server.js');
    const servicesJson = (opts.services as string) || process.env['MCP_MUX_SERVICES'] || '[]';
    let parsedServices: unknown;
    try {
      parsedServices = JSON.parse(servicesJson);
    } catch {
      console.error('mcp-multiplexer: --services must be valid JSON array');
      process.exit(1);
    }
    // SCLI-401: validate every service entry and the liveness interval BEFORE
    // creating connections or announcing startup. Invalid config exits nonzero
    // with a bounded field/index-specific diagnostic (no raw stack, no bundle
    // path, no retry loop, no success wording).
    const validated = validateMcpMultiplexerConfig(parsedServices, opts.livenessInterval as string);
    if (!validated.ok) {
      console.error(validated.error);
      process.exit(1);
    }
    const agentAudience = (process.env['AGENT_ID'] || process.env['AGENT_USERNAME'] || '').trim();
    if (!agentAudience) {
      console.error('mcp-multiplexer: AGENT_ID or AGENT_USERNAME is required for signed projection audience binding');
      process.exit(1);
    }
    await runMcpMultiplexer({
      ...validated.config,
      agentAudience,
    });
  });

program
  .command('config')
  .description('Show resolved configuration')
  .option('--cwd <dir>', 'Working directory')
  .action(async (opts) => {
    // SCLI-402: an explicit --cwd selector (either placement — before or after
    // the subcommand) must be authoritative for the resolved config and must
    // resolve to an existing directory. Never silently fall back to the caller
    // CWD or exit 0 for a bad path.
    const globals = program.opts() as Record<string, unknown>;
    const cwdValue = (opts.cwd ?? globals.cwd) as string | undefined;
    let workDir: string | undefined;
    if (cwdValue !== undefined) {
      try {
        workDir = assertWorkspaceDir(cwdValue);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    }
    // SCLI-440: `config` is a configuration-truth surface. A present-but-
    // malformed/non-regular/unreadable .mcp.json is NOT equivalent to no
    // config — fail nonzero with a concise diagnostic BEFORE printing
    // resolved configuration, naming the path, the problem, and recovery.
    // (The loader itself still skips unusable candidates so runtime callers
    // degrade gracefully; this gate is command-level only.)
    const { inspectMcpJsonCandidate } = await import('./config/loader.js');
    const cwd = workDir ?? process.cwd();
    const inspection = await inspectMcpJsonCandidate(cwd);
    if (inspection.kind === 'suspect') {
      const message =
        `Project MCP config ${inspection.path} ${inspection.reason}. ` +
        'Fix or remove the file, or set SHIZUHA_DISABLE_MCP_JSON=1 to bypass .mcp.json entirely.';
      console.error(message);
      process.exitCode = 1;
      return;
    }
    const config = await loadConfig(workDir);

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
    if (!(await requireShizuhaLogin())) return;
    const { listDevices: ld, DeviceStoreCorruptError } = await import('./devices/store.js');
    let devices;
    try {
      devices = ld();
    } catch (err) {
      if (err instanceof DeviceStoreCorruptError) {
        // SCLI-422: a corrupt registry must never render as an empty one.
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
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
    if (!(await requireShizuhaLogin())) return;
    if (deviceId.trim().length === 0) {
      console.error('Invalid deviceId: must be non-empty after trimming.');
      process.exitCode = 1;
      return;
    }
    if (!isInert(deviceId)) {
      console.error(`Invalid device id: ${inert(deviceId)}`);
      process.exitCode = 1;
      return;
    }
    const { removeDevice: rd, DeviceStoreCorruptError } = await import('./devices/store.js');
    let ok;
    try {
      ok = rd(deviceId);
    } catch (err) {
      if (err instanceof DeviceStoreCorruptError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }
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
    if (!(await requireShizuhaLogin())) return;
    const { generatePairingCode: gpc, formatCode: fc, CODE_TTL_MS: ttl } = await import('./devices/pairing.js');
    const { addPendingCode: apc, DeviceStoreCorruptError } = await import('./devices/store.js');

    const code = gpc();
    const now = Date.now();
    try {
      apc({ code, createdAt: now, expiresAt: now + ttl });
    } catch (err) {
      if (err instanceof DeviceStoreCorruptError) {
        console.error(err.message);
        process.exitCode = 1;
        return;
      }
      throw err;
    }

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
      const { promptRequired, InputCancelledError } = await import('./utils/prompt.js');
      try {
        token = await promptRequired('  Paste your Claude API key or OAuth token: ');
      } catch (err) {
        if (err instanceof InputCancelledError) {
          console.error('  Input cancelled (EOF) — no token saved.');
          process.exitCode = 1;
          return;
        }
        throw err;
      }
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
      const { promptRequired, InputCancelledError } = await import('./utils/prompt.js');
      try {
        key = await promptRequired('  Paste your Cortex API key (sk-cortex-…): ');
      } catch (err) {
        if (err instanceof InputCancelledError) {
          console.error('  Input cancelled (EOF) — no key saved.');
          process.exitCode = 1;
          return;
        }
        throw err;
      }
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
    // SCLI-438: fail closed on a hostile/non-regular credential store or parent
    // with one concise diagnostic — never a raw stack, never a destructive
    // replacement, never a hang on a FIFO.
    try {
      setCortexApiKey(key);
    } catch (err) {
      console.error(`\n  ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    console.log('\n  Cortex key saved to ~/.shizuha/credentials.json');
    console.log('  Use it: shizuha exec -p "hello" --model cortex/grok-4.6');
    console.log('  Or just run: shizuha');
  });

authCmd
  .command('openai [key]')
  .description('Save an OpenAI API key and optional OpenAI-compatible base URL (no Shizuha ID)')
  .option('--url <url>', 'OpenAI-compatible base URL (e.g. http://127.0.0.1:8000/v1)')
  .option('--model <model>', 'Default model id on that server')
  .action(async (key?: string, opts?: { url?: string; model?: string }) => {
    const { setOpenAIEndpoint, normalizeOpenAICompatibleBaseUrl } = await import('./config/credentials.js');
    const url = opts?.url ? normalizeOpenAICompatibleBaseUrl(opts.url) : undefined;
    if (!key && !url) {
      console.error('  Provide a key and/or --url. Example:');
      console.error('    shizuha auth openai sk-... ');
      console.error('    shizuha auth endpoint --url http://127.0.0.1:11434/v1 --model llama3.2');
      process.exitCode = 1;
      return;
    }
    setOpenAIEndpoint({ apiKey: key, baseUrl: url, defaultModel: opts?.model });
    console.log('\n  Saved. Shizuha ID is not required for this endpoint.');
    if (url) console.log(`  URL:   ${url}`);
    if (key) console.log('  Key:   stored in ~/.shizuha/credentials.json');
    const model = opts?.model || 'MODEL';
    console.log(`  Try:   shizuha exec -p "hello" --model openai:${model}`);
    console.log('  Or:    shizuha --model openai:' + model);
  });

authCmd
  .command('endpoint')
  .description('Point Shizuha at any OpenAI-compatible server (Ollama, vLLM, llama.cpp). No Shizuha ID required.')
  .option('--url <url>', 'Base URL, e.g. http://127.0.0.1:8000/v1 or http://127.0.0.1:11434/v1')
  .option('--key <key>', 'API key if the server requires one')
  .option('--model <model>', 'Default model id served at that URL')
  .action(async (opts: { url?: string; key?: string; model?: string }) => {
    const { setOpenAIEndpoint, normalizeOpenAICompatibleBaseUrl } = await import('./config/credentials.js');
    let url = opts.url?.trim();
    if (!url) {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      url = await new Promise<string>((resolve) => {
        rl.question('  OpenAI-compatible base URL (e.g. http://127.0.0.1:11434/v1): ', (answer) => {
          rl.close();
          resolve(answer.trim());
        });
      });
    }
    if (!url) {
      console.error('  No URL provided.');
      process.exitCode = 1;
      return;
    }
    const normalized = normalizeOpenAICompatibleBaseUrl(url);
    setOpenAIEndpoint({ apiKey: opts.key, baseUrl: normalized, defaultModel: opts.model });
    console.log('\n  Endpoint saved. No Shizuha ID login is required.');
    console.log(`  URL:   ${normalized}`);
    if (opts.key) console.log('  Key:   stored in ~/.shizuha/credentials.json');
    const model = opts.model || 'MODEL';
    console.log(`  Try:   shizuha exec -p "hello" --model openai:${model}`);
    console.log('  Status: shizuha auth status');
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
      const source = shizuhaStatus.source === 'fleet-runtime' ? ' (fleet runtime identity)' : ' (logged in)';
      console.log(`  Shizuha ID: ${shizuhaStatus.username}${source}`);
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

    // OpenAI / OpenAI-compatible endpoint
    const openaiUrl = process.env['OPENAI_BASE_URL'] || creds.openai?.baseUrl;
    if (creds.openai?.apiKey || process.env['OPENAI_API_KEY'] || openaiUrl) {
      const bits: string[] = [];
      if (creds.openai?.apiKey || process.env['OPENAI_API_KEY']) bits.push('API key');
      if (openaiUrl) bits.push(openaiUrl);
      if (creds.openai?.defaultModel) bits.push(`model ${creds.openai.defaultModel}`);
      console.log(`  OpenAI: ${bits.join(' · ')}`);
    } else {
      console.log('  OpenAI: not configured (shizuha auth endpoint --url http://127.0.0.1:11434/v1)');
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
    const { readShizuhaAuthSafe, verifyShizuhaAuthIdentity, getShizuhaAuthStatus, resolveRuntimeIdentity } = await import('./config/shizuhaAuth.js');
    const safe = readShizuhaAuthSafe();
    if (safe.kind === 'invalid') {
      // SCLI-439: present-but-corrupt/non-regular store is NOT "logged out".
      // Report the persisted auth store as suspect with a safe recovery path,
      // never instructing an ordinary login as if no store existed.
      const message = `Persisted auth store is corrupt or unreadable (${safe.reason}). Inspect ~/.shizuha/auth.json; safe recovery: remove or repair it, then run: shizuha login`;
      if (opts.json) console.log(JSON.stringify({ loggedIn: false, error: message, corruptStore: true }, null, 2));
      else console.error(message);
      process.exitCode = 1;
      return;
    }
    const status = getShizuhaAuthStatus();
    if (!status.loggedIn) {
      const message = SHIZUHA_LOGIN_REQUIRED;

      if (opts.json) console.log(JSON.stringify({ loggedIn: false, error: message }, null, 2));
      else console.error(message);
      process.exitCode = 1;
      return;
    }
    // SCLI-393: a fleet runtime is authenticated via the injected agent
    // identity (env), not an interactive auth.json. Surface it explicitly.
    const auth = safe.kind === 'ok' ? safe.state : null;
    const runtimeIdentity = !auth ? resolveRuntimeIdentity() : null;
    const username = status.username;

    let liveUsername: string | undefined;
    if (opts.live) {
      try {
        liveUsername = (await verifyShizuhaAuthIdentity()).username;
      } catch (err) {
        if (opts.json) {
          console.log(JSON.stringify({
            loggedIn: true,
            username,
            source: status.source ?? 'interactive',
            liveVerified: false,
            error: (err as Error).message,
          }, null, 2));
        } else {
          console.log(`Username: ${username}`);
          if (status.source === 'fleet-runtime') console.log('Source: fleet runtime identity');
          console.log(`Live verification: failed (${(err as Error).message})`);
        }
        process.exitCode = 1;
        return;
      }
    }

    const payload = {
      loggedIn: true,
      username: liveUsername ?? username,
      userId: auth?.userId ?? runtimeIdentity?.userId,
      idApiBaseUrl: auth?.idApiBaseUrl,
      source: status.source ?? 'interactive',
      accessTokenExpiresAt: auth?.accessTokenExpiresAt,
      refreshTokenExpiresAt: auth?.refreshTokenExpiresAt,
      liveVerified: opts.live ? true : undefined,
    };

    if (opts.json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Username: ${payload.username}`);
    if (payload.userId != null) console.log(`User ID: ${payload.userId}`);
    if (payload.idApiBaseUrl) console.log(`Platform: ${payload.idApiBaseUrl}`);
    if (payload.source === 'fleet-runtime') console.log('Source: fleet runtime identity');
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

program
  .command('plugins')
  .description('Show the composed built-in plugin tree for this profile')
  .action(async () => {
    const { composePluginTree, formatPluginTree, PROFILE_IDS } = await import('./plugins/profile.js');
    const explicit = (process.env['SHIZUHA_PROFILE'] ?? '').trim().toLowerCase();
    if (explicit && !(PROFILE_IDS as readonly string[]).includes(explicit)) {
      console.error(`Unknown profile "${explicit}". Use: ${PROFILE_IDS.join(' | ')}`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(formatPluginTree(composePluginTree()));
  });

// ── Daemon commands: up / down / status ──

program
  .command('up')
  .description('Start agent runtimes (like tailscale up)')
  .option('--agent <name>', 'Start specific agent(s) (comma-separated)')
  .option('--platform <url>', 'Platform URL (default: from login)')
  .option('--bare-metal', 'Run agents as local processes instead of containers')
  .option('--image <image>', 'Docker image for containers', 'shizuha-agent-runtime:latest')
  .option('--foreground', 'Run in foreground instead of daemonizing')
  .option('--no-service', 'Skip service installation (run in foreground only)')
  .action(async (opts) => {
    // SCLI-563: an explicitly supplied `--agent` is a scope decision and must
    // never collapse to omission's all-agents default. Commander stores
    // `undefined` when --agent is omitted but `''` when it is passed empty
    // (`--agent=` / `--agent ''`), so PRESENCE is the signal, not truthiness.
    // Reject malformed selectors here — before any auth, state, skill, network,
    // listener, or daemon work — so an explicit scoped selector can never
    // silently become an all-agents startup.
    let agentFilter: string[] = [];
    if (opts.agent !== undefined) {
      const spec = String(opts.agent);
      const shown = JSON.stringify(spec.length > 64 ? `${spec.slice(0, 64)}…` : spec);
      const reject = (why: string): undefined => {
        console.error(`Invalid --agent value ${shown}: ${why}`);
        process.exitCode = 1;
        return undefined;
      };
      if (!spec.trim()) return reject('expected a non-empty agent name; refusing to start all agents');
      if (/[\u0000-\u001f\u007f]/.test(spec)) return reject('control characters are not allowed');
      const segments = spec.split(',').map((s) => s.trim());
      if (segments.some((s) => !s)) return reject('empty agent name in comma-separated list');
      if (segments.some((s) => s === '.' || s === '..' || /[/\\]/.test(s))) {
        return reject('agent names must not be paths');
      }
      if (spec.length > 2048 || segments.some((s) => s.length > 256)) return reject('agent name is too long');
      agentFilter = segments;
    }

    const { readShizuhaAuth, getValidShizuhaAccessToken } = await import('./config/shizuhaAuth.js');
    const { startDaemon } = await import('./daemon/manager.js');
    const { isDaemonRunning } = await import('./daemon/state.js');
    const { detectInitSystem, initSystemName, installAndStartService, isServiceRunning, statusHints } = await import('./daemon/service.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');

    // SCLI-559: validate the final --image selector BEFORE any initialization
    // or state mutation. Empty/whitespace/control-bearing, URL-shaped, and
    // unreasonable-length values must fail nonzero with a field-specific
    // single-line diagnostic and create no HOME/XDG state.
    const imageErr = validateImageSelector(opts.image as string);
    if (imageErr) {
      console.error(`shizuha: invalid --image: ${imageErr}`);
      process.exit(2);
    }

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
  .command('desktop')
  .description('Open Shizuha Desktop — local GUI with Hina-style live voice')
  .option('--no-open', 'Start/probe the core but do not open a browser')
  .action(async (opts) => {
    const { openShizuhaDesktop } = await import('./desktop/launch.js');
    const code = await openShizuhaDesktop({ openBrowser: opts.open !== false });
    if (code !== 0) process.exitCode = code;
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

    // Also stop any legacy daemon. SCLI-587: stopDaemon now waits boundedly for
    // the daemon + owned children to exit (escalating to SIGKILL) and only
    // clears PID/state after exit — so a still-alive daemon is reported as a
    // non-zero actionable error with its live PID state preserved, never a
    // false "Shizuha stopped."
    const daemonResult = stopDaemon();
    if (daemonResult.remainingPids.length > 0) {
      console.error(
        `Shizuha daemon PID ${daemonResult.remainingPids.join(', ')} did not stop after SIGTERM` +
        (daemonResult.escalated ? ' and SIGKILL' : '') + '.',
      );
      console.error('Live PID state preserved at ~/.shizuha/daemon.pid — run "shizuha down" again or "shizuha status" to inspect.');
      process.exitCode = 1;
      return;
    }
    if (daemonResult.stopped) {
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
  .command('usage')
  .description('Show remaining Shizuha Code weekly Cortex allowance')
  .action(async () => {
    const { fetchCortexUsage, renderCortexUsage } = await import('./provider/cortex-usage.js');
    const view = await fetchCortexUsage();
    console.log(renderCortexUsage(view));
    if (!view.configured) process.exitCode = 2;
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

    let username = opts.username as string | undefined;
    let password = opts.password as string | undefined;

    if (!username || !password) {
      const { promptLine, InputCancelledError } = await import('./utils/prompt.js');
      const { createInterface } = await import('node:readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      try {
        if (!username) username = await promptLine(rl, 'Username: ');
        if (!password) password = await promptLine(rl, 'Password: ');
      } catch (err) {
        if (err instanceof InputCancelledError) {
          console.error('Input cancelled (EOF) — login aborted, no credentials saved.');
          process.exitCode = 1;
          return;
        }
        throw err;
      } finally {
        rl.close();
      }
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

// SCLI-520: `pulse help list surplus` must reject the surplus operand instead
// of silently printing `pulse list` help and exiting 0. Commander's implicit
// help command drops surplus operands before dispatch (_dispatchHelpCommand
// only receives operands[1]); declaring an explicit `help [command]` subcommand
// makes commander's argument-count validation reject surplus operands with a
// specific diagnostic, while the action below still shows the target's help.
pulseCmd
  .command('help [command]')
  .description('Display help for a command')
  .action((command: string | undefined) => {
    // SCLI-520: explicit-empty / whitespace-only help targets stay fail-closed
    // (a blank target is not a valid help request — reject, don't fall through
    // to the generic pulse help page).
    if (command !== undefined && command.trim() === '') {
      console.error(`Error: invalid help target ${JSON.stringify(command)}; expected a command name`);
      process.exitCode = 1;
      return;
    }
    if (command) {
      const target = pulseCmd.commands.find(
        (c) => c.name() === command || (typeof c.alias === 'function' && c.alias() === command),
      );
      if (target) {
        target.help();
        return;
      }
      // Unknown help target — mirror commander's error path (help + error).
      pulseCmd.help({ error: true });
      return;
    }
    pulseCmd.help();
  });

program
  .command('logout')
  .description('Clear stored authentication')
  .action(async () => {
    const { clearShizuhaAuth } = await import('./config/shizuhaAuth.js');
    const { clearAllProviderCredentials } = await import('./config/credentials.js');
    const { stopDaemon } = await import('./daemon/manager.js');

    // Stop daemon if running
    stopDaemon();

    // SCLI-414: logout must be honest — clear BOTH the platform auth AND all
    // stored provider credentials (Cortex/OpenAI/Anthropic/Google/Codex/Copilot)
    // so no provider authority survives a sign-out.
    clearShizuhaAuth();
    clearAllProviderCredentials();
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
    // SCLI-579: a supplied-but-blank --model selector must fail closed BEFORE
    // doctor runs or mutates state. Never treat --model= / whitespace-only as
    // "no model selected" and certify healthy with exit 0.
    if (opts.model !== undefined) {
      try {
        requireOptionalNonEmpty('model', opts.model);
      } catch (err) {
        exitOnOptionPreflightError(err);
      }
    }
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
  // Keep the default inside validateProvisionInputs(), not Commander. That
  // preserves the only semantic distinction that matters here: option absent
  // means "engineer", while an explicitly supplied empty value remains ""
  // and is rejected before account/network/state work.
  .option('--role <role>', 'Agent role (reviewer|architect|engineer|qa|security|docs|analytics|devops|social)')
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
    // Track option PRESENCE separately from value (SCLI-412): commander sets
    // `undefined` when --agent is omitted but `''` when it is passed empty
    // (`-a ''` / `--agent=`). An empty string is falsy, so the old
    // `opts.agent ? filter : all` collapsed an explicit-empty selector into an
    // all-workspace force overwrite. Only true option absence may select all
    // workspaces; a present-but-empty value is a caller error.
    let targets: string[];
    const agent = opts.agent !== undefined ? String(opts.agent).trim() : undefined;
    if (opts.agent !== undefined) {
      if (!agent) {
        console.error(`Invalid --agent value: ${JSON.stringify(opts.agent)} — expected a non-empty username; refusing to reseed all workspaces.`);
        process.exitCode = 1;
        return;
      }
      targets = all.filter(n => n === agent);
    } else {
      targets = all;
    }
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

program
  .command('workspace-gc')
  .description(
    'Prune aged per-task scratch in ~/.shizuha/work and ~/.shizuha/tmp (PLAT-6053). ' +
    'Removes only git clones that are clean + fully pushed + on-branch + no-stash + aged, ' +
    'and tmp entries older than --days with no live process cwd inside. Never touches ' +
    'browser/login state, audits, or sessions. DRY-RUN by default (verify-before-destroy).',
  )
  .option('--dry-run', 'Log RM/KEEP decisions without deleting (default: true)')
  .option('--no-dry-run', 'Actually delete aged scratch')
  .option('--days <n>', 'Prune entries older than N days (default: 7)', '7')
  .option('--home <dir>', 'Agent home directory (default: $HOME)')
  .action(async (opts) => {
    const { runWorkspaceGc } = await import('./workspace-gc.js');
    const days = Number.parseInt(opts.days as string, 10);
    const pruneDays = Number.isFinite(days) && days > 0 ? days : 7;
    const result = await runWorkspaceGc({
      homeDir: opts.home as string | undefined,
      pruneDays,
      dryRun: opts.dryRun !== false,
    });
    for (const e of result.entries) {
      console.log(`${e.decision === 'RM' ? 'RM  ' : 'KEEP'} [${e.area}] ${e.name} — ${e.reason}`);
    }
    console.log(
      `workspace-gc ${result.dryRun ? 'dry-run' : 'done'}: removed=${result.removed} kept=${result.kept} ` +
        `freedBytes=${result.freedBytes} (pruneDays=${result.pruneDays})`,
    );
    if (!result.dryRun && result.removed === 0 && result.kept === 0) {
      process.exitCode = 0;
    }
  });

// SCLI-521: reject structurally invalid argv that carries `--version` / `-V`
// BEFORE commander's built-in `.version()` can mask it with an eager exit 0.
// A valid lone version query returns null and commander prints CLI_VERSION.
const versionQueryErr = versionQueryError(process.argv.slice(2));
if (versionQueryErr) {
  console.error(versionQueryErr);
  process.exit(1);
}

// SCLI-395: an unknown subcommand must ALWAYS exit nonzero and name the
// rejected token — including when followed by --help. Commander short-circuits
// `--help` to root help + exit 0 before its unknown-command path runs, so an
// arbitrary typo was byte-identical to successful root help for humans and
// automation. This pre-parse gate rejects the first positional token when it is
// not a registered command, regardless of trailing flags.
function rejectUnknownCommand(program: Command, argv: string[]): void {
  const commandNames = new Set(program.commands.map((c) => c.name()));
  commandNames.add('help'); // commander auto-registers a help command
  const valueFlags = new Set<string>();
  for (const opt of program.options) {
    if (opt.required || opt.optional) {
      if (opt.short) valueFlags.add(opt.short);
      if (opt.long) valueFlags.add(opt.long);
    }
  }
  const args = argv.slice(2);
  let i = 0;
  while (i < args.length) {
    const tok = args[i]!;
    if (tok === '--') { i += 1; break; }
    if (tok.startsWith('--')) {
      if (tok.includes('=')) { i += 1; continue; } // --opt=value
      i += valueFlags.has(tok) ? 2 : 1;
      continue;
    }
    if (tok.startsWith('-') && tok.length > 1) {
      i += valueFlags.has(tok) ? 2 : 1;
      continue;
    }
    break; // first positional
  }
  const first = args[i];
  if (first && !commandNames.has(first)) {
    console.error(`Unknown command '${first}'.`);
    console.error(`Run '${program.name() || 'shizuha'} --help' to see available commands.`);
    process.exit(1);
  }
}

rejectUnknownCommand(program, process.argv);

// SCLI-580: --help must not mask an invalid --mode. Commander parses the FULL
// argv (populating opts) before it fires the built-in help exit, so with
// exitOverride we catch the help exit here and validate the root's parsed
// option domains first. An invalid/blank --mode combined with --help (either
// order) now rejects nonzero with the same field-specific diagnostic as the
// action path; a valid mode (or subcommand help) exits 0 with help already
// printed by commander.
try {
  program.parse();
} catch (err) {
  // For help and parse errors, Commander stops before an action starts. Keep
  // its status and let Node drain normally: forcing process.exit here can
  // join V8 compiler workers while they wait for a foreground GC, deadlocking
  // even `serve --help` (nodejs/node#54918, exit-time variant).
  process.exitCode = (err as { exitCode?: number } | null)?.exitCode ?? 1;
  if (
    err &&
    typeof err === 'object' &&
    (err as { code?: string }).code === 'commander.helpDisplayed'
  ) {
    try {
      validateCommonAgentOptions({
        mode: program.opts().mode,
        thinking: program.opts().thinking,
        effort: program.opts().effort,
        maxTurns: program.opts().maxTurns,
        temperature: program.opts().temperature,
        sandbox: program.opts().sandbox,
      });
    } catch (e) {
      if (!(e instanceof OptionPreflightError)) throw e;
      console.error(`Error: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

// Helper: run agent with an initial user prompt
import type { AgentEvent } from './events/types.js';
import type { Message } from './agent/types.js';

async function* runAgentWithPrompt(
  config: AgentConfig,
  prompt: string,
  resumeSessionId?: string,
  failClosedMcp = false,
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

  // SCLI-623: resolveWithModel() returns BOTH the provider and the canonical
  // (prefix-stripped) model name. resolveAutoModel() may return a provider-
  // prefixed spec (e.g. `openai:DeepSeek-V4-Flash` when a custom OpenAI-
  // compatible endpoint is configured); resolve() alone keeps that prefix on
  // the local `model` variable, which then gets sent verbatim to the upstream
  // API (Cortex 404s on `openai:DeepSeek-V4-Flash`). Mirror agent-process.ts.
  let provider;
  try {
    const resolved = providerReg.resolveWithModel(model);
    provider = resolved.provider;
    model = resolved.resolvedModel;
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

  // SCLI-517: when the caller explicitly requested --mcp-server entries and one
  // of them failed to connect (spawn/initialize/tools-list), fail closed instead
  // of silently running with a reduced tool surface. Only failures of the
  // explicitly-requested servers are fatal; config-file servers keep the
  // degraded-mode notice path.
  if (failClosedMcp && (config.mcpServers?.length ?? 0) > 0) {
    const requested = config.mcpServers ?? [];
    const requestedNames = new Set(requested.map((s) => s.name));
    const requestedFailures = mcpManager.failedServers.filter((f) => requestedNames.has(f.name));
    if (requestedFailures.length > 0) {
      const failedList = requestedFailures
        .map((f: { name: string; error: string }) => `- ${f.name}: ${f.error}`)
        .join('\n');
      throw new Error(
        `--mcp-server connection failed (${requestedFailures.length} of ${requested.length} requested server(s) unusable):\n` +
        failedList +
        `\n\nFix the --mcp-server value(s) and retry. No provider/session state was initialized.`,
      );
    }
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
  // protect and can be serialized behind another session. Persist the projection
  // atomically. Abort only when the next provider call cannot physically fit —
  // sitting above the 70% trigger after a successful compact is a hold-off,
  // not a session kill (Q4 remaining-16, 2026-08-16).
  let skipProactiveCompactUntilGrowth = false;
  const compactAutomaticallyIfNeeded = async (reportedPromptTokens = 0, force = false): Promise<boolean> => {
    const proactive = needsCompaction(
      messages,
      maxContextTokens,
      model,
      systemOverheadTokens,
      maxOutputTokens,
      reportedPromptTokens,
    );
    if (!force && skipProactiveCompactUntilGrowth && !proactive) {
      skipProactiveCompactUntilGrowth = false;
    }
    if (!force && skipProactiveCompactUntilGrowth) return false;
    if (!force && !proactive) return false;

    // ALWAYS use the LLM-based compaction (operator 2026-08-08): no local-vs-
    // autonomous differentiation — every agent compacts via the LLM so no
    // conversation loses meaning to the lossy extractive projection.
    const { applyRequiredCompactionOrThrow } = await import('./state/compaction.js');
    const compacted = await applyRequiredCompactionOrThrow({
      messages,
      provider,
      model,
      maxTokens: maxContextTokens,
      overheadTokens: systemOverheadTokens,
      outputBudget: maxOutputTokens,
    });
    messages.length = 0;
    messages.push(...compacted.messages);
    store.replaceMessages(session.id, compacted.messages);
    lastReportedPromptTokens = 0;
    lastProviderPromptEstimate = 0;
    postCompactionRequestKind = 'post_compaction';
    thinkingOnlyRecoveryCount = 0;
    truncationRecoveryCount = 0;
    skipProactiveCompactUntilGrowth = !compacted.reachedTrigger;
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
              hadSuccessfulProviderTurn: turnIndex > 0,
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
          assistantText: visibleTextFromContent(result.assistantMessage.content),
          recoveryCount: thinkingOnlyRecoveryCount,
          outputTokens: result.outputTokens,
        })) {
          thinkingOnlyRecoveryCount++;
          logger.warn(
            { turnIndex, attempt: thinkingOnlyRecoveryCount, outputTokens: result.outputTokens, stopReason: result.stopReason },
            'SCLI: output budget ended before a terminal sentinel — continuing from persisted prefix',
          );
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
          process.stderr.write(`[thinking-only] Turn ${turnIndex}: model produced thinking but no action — continuing from prefix\n`);
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
