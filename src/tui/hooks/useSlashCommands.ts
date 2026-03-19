import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import type { PermissionMode } from '../../permissions/types.js';
import type { ScreenMode } from '../state/types.js';
import { toggleStatusItem, getStatusItems, getAllStatusItems, type StatusItem } from '../utils/statusConfig.js';
import { computeCost, formatCost } from '../utils/pricing.js';
import { getContextWindow, contextUsagePercent } from '../utils/contextWindow.js';
import { writeClipboardText } from '../utils/clipboard.js';
import { readCredentials, addAnthropicToken, setOpenAIKey, setGoogleKey, removeProvider, credentialsPath } from '../../config/credentials.js';
import { isTmuxSession, shouldAnimateTUI, shouldUseSynchronizedOutput } from '../utils/terminal.js';

interface SessionInfo {
  sessionId: string | null;
  model: string;
  mode: PermissionMode;
  turnCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  contextTokens: number;
  startTime: number;
  cwd: string;
}

interface SlashCommandContext {
  setModel: (model: string) => boolean;
  setMode: (mode: PermissionMode) => void;
  clearTranscript: () => void;
  compact: (instructions?: string) => void;
  setScreen: (screen: ScreenMode) => void;
  exit: () => void;
  showInPager?: (content: string) => void;
  cwd?: string;
  submitPrompt?: (text: string) => void;
  getSessionInfo?: () => SessionInfo;
  renameSession?: (name: string) => void;
  forkSession?: () => string | null;
  listMCPTools?: () => Promise<Array<{ name: string; description: string }>>;
  getLastAssistantMessage?: () => string | null;
  setThinking?: (level: string) => void;
  setEffort?: (level: string) => void;
  toggleFastMode?: () => { enabled: boolean; model: string };
  submitWithImage?: (prompt: string, imageBase64: string, mediaType: string) => void;
  loginShizuha?: (username: string, password: string) => Promise<{ username: string; mcpReloaded: boolean; reloadError?: string }>;
  logoutShizuha?: () => Promise<{ loggedOut: boolean; mcpReloaded: boolean; reloadError?: string }>;
  getShizuhaAuthStatus?: () => Promise<{
    loggedIn: boolean;
    username?: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
  }>;
  verifyShizuhaIdentity?: () => Promise<{ username?: string }>;
}

interface SlashCommandResult {
  handled: boolean;
  message?: string;
}

/** Current verbosity level */
let _verbosity: VerbosityLevel = 'normal';

export type VerbosityLevel = 'minimal' | 'normal' | 'verbose';

export function getVerbosity(): VerbosityLevel {
  return _verbosity;
}

const HELP_COMPACT_TEXT = `Slash Commands (grouped):
  Session:   /session (/resume), /clear, /fork, /rename <name>
  Model:     /model [name], /mode <plan|supervised|autonomous>
  Settings:  /config ..., /settings ... (alias), /statusline [item]
  Reasoning: /think <off|on>, /effort <low|medium|high|xhigh>, /fast
  Context:   /compact [instr], /context, /cost
  Code:      /diff, /review, /status, /copy
  Tools:     /mcp, /memory, /paste-image [prompt]
  Utility:   /verbose, /feedback <text>, /doctor, /init, /exit
  Auth:      /login <username> <password>, /logout, /auth status [live]
  More:      /help all`;

const HELP_FULL_TEXT = `Slash Commands:
  [Session]
  /session | /resume        Open session manager
  /clear                    Clear transcript and start new session
  /fork                     Fork current session
  /rename <name>            Rename current session

  [Model & Reasoning]
  /model [name]             Open model picker or switch directly
  /mode <mode>              plan | supervised | autonomous
  /think <off|on>           Set Claude thinking
  /effort <level>           low | medium | high | xhigh
  /fast                     Toggle fast mode (1.5x speed, 2x credits)

  [Settings]
  /config [subcommand]      Config umbrella (same as /settings)
  /statusline [item]        Toggle status bar items

  [Context & Review]
  /compact [instr]          Trigger context compaction
  /context                  Show context window usage
  /cost                     Show detailed cost breakdown
  /diff                     Show git diff in pager
  /review                   Submit git diff for code review
  /status                   Show session info
  /copy                     Copy last response to clipboard

  [Tools]
  /mcp                      List MCP servers and tools
  /memory                   View memory file
  /paste-image [prompt]     Paste image from clipboard and submit

  [Utility]
  /verbose                  Cycle verbosity (minimal/normal/verbose)
  /feedback <text>          Save feedback
  /doctor                   Run installation diagnostics
  /init                     Create AGENTS.md boilerplate

  [Shizuha Auth]
  /login <username> <password>  Login to Shizuha ID and refresh MCP auth
  /logout                        Remove local Shizuha auth and refresh MCP auth
  /auth status [live]            Show current auth status (optional live verification)
  /auth verify                   Alias for /auth status live

  /help                     Show compact help
  /help all                 Show full help
  /exit                     Exit`;

const CONFIG_HELP_TEXT = `Config shortcuts:
  /config show              Show current settings summary
  /config auth              Show auth status per provider
  /config auth <prov> <tok> Save credential (anthropic/openai/google)
  /config auth remove <prov> Remove saved credentials
  /config model [name]      Open model picker or set model
  /config mode <mode>       Set mode (plan/supervised/autonomous)
  /config think <off|on>    Set thinking level
  /config effort <level>    Set reasoning effort
  /config statusline [item] Configure status bar items
  /settings ...             Alias for /config ...`;

function formatExpiry(iso: string | undefined): string {
  if (!iso) return 'unknown';
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'unknown';
  const deltaMs = ts - Date.now();
  const deltaMin = Math.round(deltaMs / 60000);
  if (deltaMin >= 0) {
    return `${iso} (in ~${deltaMin} min)`;
  }
  return `${iso} (~${Math.abs(deltaMin)} min ago)`;
}

export async function handleSlashCommandAsync(input: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const arg = parts.slice(1).join(' ');

  if (cmd === '/login') {
    const username = parts[1]?.trim();
    const password = parts.slice(2).join(' ');
    if (!username || !password) {
      return { handled: true, message: 'Usage: /login <username> <password>' };
    }
    if (!ctx.loginShizuha) {
      return { handled: true, message: 'Login is not available in this context' };
    }

    try {
      const result = await ctx.loginShizuha(username, password);
      if (result.mcpReloaded) {
        return { handled: true, message: `Logged in as ${result.username}. MCP auth reloaded.` };
      }
      return {
        handled: true,
        message: `Logged in as ${result.username}. MCP auth reload pending: ${result.reloadError ?? 'unknown error'}`,
      };
    } catch (err) {
      return { handled: true, message: `Login failed: ${(err as Error).message}` };
    }
  }

  if (cmd === '/logout') {
    if (!ctx.logoutShizuha) {
      return { handled: true, message: 'Logout is not available in this context' };
    }

    try {
      const result = await ctx.logoutShizuha();
      const base = result.loggedOut ? 'Logged out from Shizuha.' : 'No local Shizuha login found.';
      if (result.mcpReloaded) {
        return { handled: true, message: `${base} MCP auth reloaded.` };
      }
      return {
        handled: true,
        message: `${base} MCP auth reload pending: ${result.reloadError ?? 'unknown error'}`,
      };
    } catch (err) {
      return { handled: true, message: `Logout failed: ${(err as Error).message}` };
    }
  }

  if (cmd === '/auth') {
    const argParts = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const wantsLiveVerification =
      argParts[0] === 'verify'
      || (argParts[0] === 'status' && ['live', 'verify', '--live'].includes(argParts[1] ?? ''));

    const isValidAuthCommand =
      argParts.length === 0
      || argParts[0] === 'status'
      || argParts[0] === 'verify';
    const hasInvalidStatusOption =
      argParts[0] === 'status'
      && argParts[1] != null
      && !['live', 'verify', '--live'].includes(argParts[1]);

    if (!isValidAuthCommand || argParts.length > 2 || hasInvalidStatusOption) {
      return { handled: true, message: 'Usage: /auth status [live]\n       /auth verify' };
    }

    if (!ctx.getShizuhaAuthStatus) {
      return { handled: true, message: 'Auth status is not available in this context' };
    }

    try {
      const status = await ctx.getShizuhaAuthStatus();
      if (!status.loggedIn) {
        return { handled: true, message: 'Shizuha auth: not logged in\nUse /login <username> <password>' };
      }

      const localUser = status.username ?? 'unknown';
      const lines = [
        'Shizuha auth: logged in',
        `  Local user:    ${localUser}`,
        `  Access token:  ${formatExpiry(status.accessTokenExpiresAt)}`,
        `  Refresh token: ${formatExpiry(status.refreshTokenExpiresAt)}`,
      ];

      if (!wantsLiveVerification) {
        lines.push('  Verified user: (not checked) · run /auth status live');
        return { handled: true, message: lines.join('\n') };
      }

      if (!ctx.verifyShizuhaIdentity) {
        lines.push('  Verified user: unavailable in this context');
        return { handled: true, message: lines.join('\n') };
      }

      try {
        const verified = await ctx.verifyShizuhaIdentity();
        const verifiedUser = verified.username ?? 'unknown';
        const match = localUser === verifiedUser ? 'yes' : 'no';
        lines.push(`  Verified user: ${verifiedUser}`);
        lines.push(`  Local vs verified match: ${match}`);
      } catch (err) {
        lines.push(`  Verified user: failed (${(err as Error).message})`);
      }

      return { handled: true, message: lines.join('\n') };
    } catch (err) {
      return { handled: true, message: `Unable to read auth status: ${(err as Error).message}` };
    }
  }

  return handleSlashCommand(input, ctx);
}

export function handleSlashCommand(input: string, ctx: SlashCommandContext): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false };

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0]!.toLowerCase();
  const arg = parts.slice(1).join(' ');

  switch (cmd) {
    case '/model':
      if (!arg) {
        ctx.setScreen('models');
        return { handled: true };
      }
      const ok = ctx.setModel(arg);
      return { handled: true, message: ok ? `Model set to ${arg}` : undefined };

    case '/mode': {
      const validModes = ['plan', 'supervised', 'autonomous'];
      if (!arg || !validModes.includes(arg)) {
        return { handled: true, message: `Usage: /mode <${validModes.join('|')}>` };
      }
      ctx.setMode(arg as PermissionMode);
      return { handled: true, message: `Mode set to ${arg}` };
    }

    case '/clear':
      ctx.clearTranscript();
      return { handled: true, message: 'Transcript cleared' };

    case '/compact':
      ctx.compact(arg || undefined);
      return { handled: true, message: arg ? `Compacting context with instructions: "${arg}"` : 'Compacting context...' };

    case '/cost': {
      if (!ctx.getSessionInfo) {
        return { handled: true, message: '/cost requires session info' };
      }
      const info = ctx.getSessionInfo();
      const cost = computeCost(info.model, info.totalInputTokens, info.totalOutputTokens);
      const elapsed = Math.floor((Date.now() - info.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const avgPerTurn = info.turnCount > 0 ? cost / info.turnCount : 0;
      const msg = [
        `Cost Breakdown`,
        `  Total:     ${formatCost(cost)}`,
        `  Input:     ${info.totalInputTokens.toLocaleString()} tokens`,
        `  Output:    ${info.totalOutputTokens.toLocaleString()} tokens`,
        `  Avg/turn:  ${formatCost(avgPerTurn)} (${info.turnCount} turns)`,
        `  Model:     ${info.model}`,
        `  Session:   ${mins}m ${secs}s`,
      ].join('\n');
      return { handled: true, message: msg };
    }

    case '/context': {
      if (!ctx.getSessionInfo) {
        return { handled: true, message: '/context requires session info' };
      }
      const info = ctx.getSessionInfo();
      const maxCtx = getContextWindow(info.model);
      const pct = contextUsagePercent(info.contextTokens, info.model);
      const bar = buildProgressBar(pct, 30);
      const free = maxCtx - info.contextTokens;
      const lines = [
        `Context Window`,
        `  ${bar} ${pct}%`,
        `  Used: ${info.contextTokens.toLocaleString()} / ${maxCtx.toLocaleString()} tokens`,
        `  Free: ${free.toLocaleString()} tokens`,
        `  Model: ${info.model}`,
      ];
      if (pct >= 90) {
        lines.push(`  \u26A0 Critical: Context nearly full! Use /compact to free space.`);
      } else if (pct >= 75) {
        lines.push(`  \u26A0 Warning: Context usage high. Consider /compact.`);
      }
      return { handled: true, message: lines.join('\n') };
    }

    case '/copy': {
      if (!ctx.getLastAssistantMessage) {
        return { handled: true, message: '/copy requires message access' };
      }
      const lastMsg = ctx.getLastAssistantMessage();
      if (!lastMsg) {
        return { handled: true, message: 'No assistant message to copy' };
      }
      const ok = writeClipboardText(lastMsg);
      if (ok) {
        return { handled: true, message: `Copied ${lastMsg.length} chars to clipboard` };
      }
      return { handled: true, message: 'Clipboard write failed. Ensure xclip, xsel, or wl-copy is installed.' };
    }

    case '/think': {
      const levels = ['off', 'on'];
      if (!arg || !levels.includes(arg.toLowerCase())) {
        return { handled: true, message: `Usage: /think <${levels.join('|')}>` };
      }
      if (ctx.setThinking) {
        ctx.setThinking(arg.toLowerCase());
      }
      return { handled: true, message: `Thinking: ${arg.toLowerCase()}` };
    }

    case '/effort': {
      const levels = ['low', 'medium', 'high', 'xhigh'];
      if (!arg || !levels.includes(arg.toLowerCase())) {
        return { handled: true, message: `Usage: /effort <${levels.join('|')}>` };
      }
      if (ctx.setEffort) {
        ctx.setEffort(arg.toLowerCase());
      }
      return { handled: true, message: `Reasoning effort: ${arg.toLowerCase()}` };
    }

    case '/fast': {
      if (!ctx.toggleFastMode) {
        return { handled: true, message: 'Fast mode is not available in this context' };
      }
      const result = ctx.toggleFastMode();
      const state = result.enabled ? 'on (1.5x speed, 2x credits)' : 'off';
      return { handled: true, message: `Fast mode: ${state}` };
    }

    case '/config':
    case '/settings':
      return handleConfigCommand(arg, ctx);

    case '/doctor': {
      const checks: string[] = ['Installation Diagnostics'];

      // 1. API credentials
      const keys = [
        ['ANTHROPIC_API_KEY', process.env['ANTHROPIC_API_KEY']],
        ['OPENAI_API_KEY', process.env['OPENAI_API_KEY']],
        ['GOOGLE_API_KEY', process.env['GOOGLE_API_KEY']],
        ['ANTHROPIC_AUTH_TOKEN', process.env['ANTHROPIC_AUTH_TOKEN']],
      ] as const;
      for (const [name, val] of keys) {
        if (val) {
          checks.push(`  \u2713 ${name}: configured (${val.slice(0, 8)}...)`);
        } else {
          checks.push(`  \u2717 ${name}: not set`);
        }
      }

      // 2. Node.js version
      const nodeVer = process.version;
      const major = parseInt(nodeVer.slice(1), 10);
      if (major >= 18) {
        checks.push(`  \u2713 Node.js: ${nodeVer}`);
      } else {
        checks.push(`  \u26A0 Node.js: ${nodeVer} (recommend >= 18)`);
      }

      // 3. Terminal
      const term = process.env['TERM'] ?? 'unknown';
      const colorterm = process.env['COLORTERM'] ?? 'none';
      if (term === 'dumb') {
        checks.push(`  \u26A0 Terminal: ${term} (limited rendering)`);
      } else {
        checks.push(`  \u2713 Terminal: ${term} (color: ${colorterm})`);
      }

      // 3b. TUI rendering mode
      const inTmux = isTmuxSession();
      const animated = shouldAnimateTUI();
      const syncOutput = shouldUseSynchronizedOutput();
      const modeLabel = animated ? 'animated' : 'stable';
      const syncLabel = syncOutput ? 'on' : 'off';
      const transport = inTmux ? 'tmux' : 'direct';
      if (inTmux && (animated || syncOutput)) {
        checks.push(`  \u26A0 TUI rendering: ${modeLabel} (sync output: ${syncLabel}, ${transport})`);
      } else {
        checks.push(`  \u2713 TUI rendering: ${modeLabel} (sync output: ${syncLabel}, ${transport})`);
      }

      // 4. Clipboard tools
      const clipTools = ['xclip', 'xsel', 'wl-copy'];
      const foundClip = clipTools.filter((t) => {
        try { execSync(`which ${t}`, { stdio: 'pipe' }); return true; } catch { return false; }
      });
      if (foundClip.length > 0) {
        checks.push(`  \u2713 Clipboard: ${foundClip.join(', ')}`);
      } else {
        checks.push(`  \u26A0 Clipboard: no tools found (install xclip or xsel)`);
      }

      // 5. Working directory
      const docCwd = ctx.cwd ?? process.cwd();
      if (fs.existsSync(docCwd)) {
        checks.push(`  \u2713 Working dir: ${docCwd}`);
      } else {
        checks.push(`  \u2717 Working dir: ${docCwd} (not found)`);
      }

      const passCount = checks.filter((c) => c.includes('\u2713')).length;
      const total = checks.length - 1; // exclude header
      checks.push(`\n  ${passCount}/${total} checks passed`);

      return { handled: true, message: checks.join('\n') };
    }

    case '/session':
    case '/sessions':
    case '/resume':
      ctx.setScreen('sessions');
      return { handled: true };

    case '/memory': {
      const home = process.env['HOME'] ?? '~';
      // Derive project slug from cwd (absolute path with / → -)
      const cwd = process.cwd();
      const projectSlug = cwd.replace(/\//g, '-');
      const memoryPath = path.join(home, '.claude', 'projects', projectSlug, 'memory', 'MEMORY.md');
      try {
        const content = fs.readFileSync(memoryPath, 'utf-8');
        const lines = content.split('\n');
        const preview = lines.slice(0, 20).join('\n');
        return { handled: true, message: `Memory (${lines.length} lines):\n${preview}\n... (use editor to view full)` };
      } catch {
        return { handled: true, message: `Memory file not found at ${memoryPath}` };
      }
    }

    case '/verbose': {
      const cycle: Array<'minimal' | 'normal' | 'verbose'> = ['minimal', 'normal', 'verbose'];
      const idx = cycle.indexOf(_verbosity);
      _verbosity = cycle[(idx + 1) % cycle.length]!;
      return { handled: true, message: `Verbosity: ${_verbosity}` };
    }

    case '/diff': {
      if (!ctx.showInPager || !ctx.cwd) {
        return { handled: true, message: '/diff requires pager support' };
      }
      try {
        const cwd = ctx.cwd;
        const staged = safeExec('git diff --cached --color=always', cwd);
        const unstaged = safeExec('git diff --color=always', cwd);
        const untracked = safeExec('git ls-files --others --exclude-standard', cwd);

        const sections: string[] = [];
        if (staged) sections.push('=== Staged Changes ===\n' + staged);
        if (unstaged) sections.push('=== Unstaged Changes ===\n' + unstaged);
        if (untracked) sections.push('=== Untracked Files ===\n' + untracked);

        if (sections.length === 0) {
          return { handled: true, message: 'No changes detected' };
        }

        ctx.showInPager(sections.join('\n\n'));
        return { handled: true };
      } catch (err) {
        return { handled: true, message: `Git error: ${(err as Error).message}` };
      }
    }

    case '/status': {
      if (!ctx.getSessionInfo) {
        return { handled: true, message: '/status requires session info' };
      }
      const info = ctx.getSessionInfo();
      const elapsed = Math.floor((Date.now() - info.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const msg = [
        `Session: ${info.sessionId?.slice(0, 8) ?? 'new'}`,
        `Model:   ${info.model}`,
        `Mode:    ${info.mode}`,
        `Turns:   ${info.turnCount}`,
        `Tokens:  ${info.totalInputTokens} in / ${info.totalOutputTokens} out`,
        `Context: ${info.contextTokens} tokens`,
        `Elapsed: ${mins}m ${secs}s`,
        `CWD:     ${info.cwd}`,
      ].join('\n');
      return { handled: true, message: msg };
    }

    case '/review': {
      if (!ctx.submitPrompt || !ctx.cwd) {
        return { handled: true, message: '/review requires submit and cwd' };
      }
      try {
        const cwd = ctx.cwd;
        const staged = safeExec('git diff --cached', cwd);
        const unstaged = safeExec('git diff', cwd);
        const diff = (staged + '\n' + unstaged).trim();
        if (!diff) {
          return { handled: true, message: 'No changes to review' };
        }
        const prompt = `Please review the following git diff. Check for bugs, security issues, performance problems, and code style. Be concise and actionable.\n\n\`\`\`diff\n${diff}\n\`\`\``;
        ctx.submitPrompt(prompt);
        return { handled: true };
      } catch (err) {
        return { handled: true, message: `Git error: ${(err as Error).message}` };
      }
    }

    case '/rename': {
      if (!arg) {
        return { handled: true, message: 'Usage: /rename <name>' };
      }
      if (ctx.renameSession) {
        ctx.renameSession(arg);
      }
      return { handled: true, message: `Session renamed to "${arg}"` };
    }

    case '/init': {
      const cwd = ctx.cwd ?? process.cwd();
      const agentsPath = path.join(cwd, 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        return { handled: true, message: 'AGENTS.md already exists' };
      }
      const boilerplate = `# AGENTS.md

## Project Overview
<!-- Describe the project for AI agents -->

## Architecture
<!-- Key architectural decisions and patterns -->

## Development Guidelines
<!-- Coding standards, testing requirements -->

## Commands
\`\`\`bash
# Build
npm run build

# Test
npm test

# Dev
npm run dev
\`\`\`
`;
      try {
        fs.writeFileSync(agentsPath, boilerplate, 'utf-8');
        return { handled: true, message: 'Created AGENTS.md' };
      } catch (err) {
        return { handled: true, message: `Failed to create AGENTS.md: ${(err as Error).message}` };
      }
    }

    case '/mcp': {
      if (ctx.listMCPTools) {
        // Async — fire and forget, show via pager if available
        ctx.listMCPTools().then((tools) => {
          if (tools.length === 0) {
            if (ctx.showInPager) {
              ctx.showInPager('MCP Tools: none connected\n\nTo add MCP servers, create a .mcp.json in your project root\nor add [[mcp.servers]] to .shizuha/config.toml');
            }
            return;
          }
          const listing = tools.map((t) => `  ${t.name} — ${t.description}`).join('\n');
          const content = `MCP Tools (${tools.length}):\n${listing}`;
          if (ctx.showInPager) {
            ctx.showInPager(content);
          }
        }).catch((err) => {
          if (ctx.showInPager) {
            ctx.showInPager(`MCP error: ${(err as Error).message ?? 'unknown error'}`);
          }
        });
        return { handled: true, message: 'Loading MCP tools...' };
      }
      return { handled: true, message: 'No MCP servers configured' };
    }

    case '/statusline': {
      return handleStatuslineCommand(arg);
    }

    case '/fork': {
      if (ctx.forkSession) {
        const newId = ctx.forkSession();
        if (newId) {
          return { handled: true, message: `Session forked → ${newId.slice(0, 8)}` };
        }
        return { handled: true, message: 'No active session to fork' };
      }
      return { handled: true, message: 'Fork not available' };
    }

    case '/feedback': {
      if (!arg) {
        return { handled: true, message: 'Usage: /feedback <text>' };
      }
      const home = process.env['HOME'] ?? '.';
      const feedbackDir = path.join(home, '.shizuha', 'feedback');
      try {
        fs.mkdirSync(feedbackDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filePath = path.join(feedbackDir, `feedback-${timestamp}.txt`);
        fs.writeFileSync(filePath, arg, 'utf-8');
        return { handled: true, message: `Feedback saved to ${filePath}` };
      } catch (err) {
        return { handled: true, message: `Failed to save feedback: ${(err as Error).message}` };
      }
    }

    case '/paste-image': {
      try {
        const data = safeExec('xclip -selection clipboard -t image/png -o | base64', ctx.cwd ?? process.cwd());
        if (!data || data.length < 100) {
          return { handled: true, message: 'No image found in clipboard' };
        }
        if (ctx.submitWithImage) {
          const prompt = arg || 'Describe this image.';
          ctx.submitWithImage(prompt, data, 'image/png');
          return { handled: true, message: `Image pasted (${Math.round(data.length / 1024)}kb). Sending to model with prompt: "${prompt}"` };
        }
        return { handled: true, message: `Clipboard image captured (${Math.round(data.length / 1024)}kb base64) but image submission not available.` };
      } catch {
        return { handled: true, message: 'Clipboard read failed. Ensure xclip is installed.' };
      }
    }

    case '/help':
      if (['all', 'full', 'verbose'].includes(arg.trim().toLowerCase())) {
        return { handled: true, message: HELP_FULL_TEXT };
      }
      ctx.setScreen('help');
      return { handled: true };

    case '/exit':
    case '/quit':
      ctx.exit();
      return { handled: true };

    default:
      return { handled: true, message: `Unknown command: ${cmd}. Type /help for available commands.` };
  }
}

function handleConfigCommand(arg: string, ctx: SlashCommandContext): SlashCommandResult {
  const trimmed = arg.trim();
  if (!trimmed || trimmed.toLowerCase() === 'show') {
    const lines: string[] = [CONFIG_HELP_TEXT];
    if (ctx.getSessionInfo) {
      const info = ctx.getSessionInfo();
      lines.push('');
      lines.push(`Current: model=${info.model}, mode=${info.mode}, session=${info.sessionId?.slice(0, 8) ?? 'new'}`);
    }
    lines.push(`Statusline: ${getStatusItems().join(', ')}`);
    return { handled: true, message: lines.join('\n') };
  }

  const parts = trimmed.split(/\s+/);
  const sub = parts[0]!.toLowerCase();
  const rest = parts.slice(1).join(' ');
  switch (sub) {
    case 'model':
      return handleSlashCommand(rest ? `/model ${rest}` : '/model', ctx);
    case 'mode':
      return handleSlashCommand(`/mode ${rest}`.trim(), ctx);
    case 'think':
      return handleSlashCommand(`/think ${rest}`.trim(), ctx);
    case 'effort':
      return handleSlashCommand(`/effort ${rest}`.trim(), ctx);
    case 'statusline':
      return handleSlashCommand(`/statusline ${rest}`.trim(), ctx);
    case 'auth':
      return handleAuthCommand(rest);
    case 'help':
      return { handled: true, message: CONFIG_HELP_TEXT };
    default:
      return { handled: true, message: `Unknown /config option: ${sub}\n\n${CONFIG_HELP_TEXT}` };
  }
}

function handleAuthCommand(arg: string): SlashCommandResult {
  const trimmed = arg.trim();

  // No args — show status
  if (!trimmed) {
    const creds = readCredentials();
    const lines: string[] = [
      `Provider credentials (${credentialsPath()}):`,
    ];

    // Anthropic
    const anthropicTokens = creds.anthropic?.tokens ?? [];
    if (anthropicTokens.length > 0) {
      const labels = anthropicTokens.map((t) => t.label).join(', ');
      lines.push(`  anthropic: ${anthropicTokens.length} token${anthropicTokens.length > 1 ? 's' : ''} (${labels})`);
    } else {
      lines.push('  anthropic: not configured');
    }

    // OpenAI
    if (creds.openai?.apiKey) {
      lines.push(`  openai:    configured (${creds.openai.apiKey.slice(0, 8)}...)`);
    } else {
      lines.push('  openai:    not configured');
    }

    // Google
    if (creds.google?.apiKey) {
      lines.push(`  google:    configured (${creds.google.apiKey.slice(0, 8)}...)`);
    } else {
      lines.push('  google:    not configured');
    }

    return { handled: true, message: lines.join('\n') };
  }

  const parts = trimmed.split(/\s+/);
  const provider = parts[0]!.toLowerCase();
  const value = parts.slice(1).join(' ');

  // /config auth remove <provider>
  if (provider === 'remove') {
    const target = value.toLowerCase();
    if (!['anthropic', 'openai', 'google'].includes(target)) {
      return { handled: true, message: `Usage: /config auth remove <anthropic|openai|google>` };
    }
    const ok = removeProvider(target as 'anthropic' | 'openai' | 'google');
    return { handled: true, message: ok ? `Removed ${target} credentials` : `No ${target} credentials found` };
  }

  // /config auth <provider> <token>
  if (!['anthropic', 'openai', 'google'].includes(provider)) {
    return { handled: true, message: `Unknown provider: ${provider}. Use: anthropic, openai, google` };
  }

  if (!value) {
    return { handled: true, message: `Usage: /config auth ${provider} <token/key>` };
  }

  if (provider === 'anthropic') {
    addAnthropicToken(value);
    return { handled: true, message: `Anthropic token saved. Restart or /model to activate.` };
  } else if (provider === 'openai') {
    setOpenAIKey(value);
    return { handled: true, message: `OpenAI API key saved. Restart or /model to activate.` };
  } else {
    setGoogleKey(value);
    return { handled: true, message: `Google API key saved. Restart or /model to activate.` };
  }
}

function handleStatuslineCommand(arg: string): SlashCommandResult {
  if (!arg) {
    const current = getStatusItems();
    const all = getAllStatusItems();
    const status = all.map((item) => `${current.includes(item) ? '\u2713' : '\u2717'} ${item}`).join('\n');
    return { handled: true, message: `Status line items:\n${status}\n\nUsage: /statusline <item> to toggle` };
  }
  const item = arg.toLowerCase() as StatusItem;
  const allItems = getAllStatusItems();
  if (!allItems.includes(item)) {
    return { handled: true, message: `Unknown item: ${arg}. Available: ${allItems.join(', ')}` };
  }
  const enabled = toggleStatusItem(item);
  return { handled: true, message: `${item}: ${enabled ? 'shown' : 'hidden'}` };
}

/** Safely exec a command, returning stdout or empty string */
function safeExec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

/** Build a visual progress bar like [████████░░░░] */
function buildProgressBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return '[' + '\u2588'.repeat(filled) + '\u2591'.repeat(empty) + ']';
}
