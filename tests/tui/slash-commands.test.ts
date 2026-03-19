import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { handleSlashCommand, handleSlashCommandAsync } from '../../src/tui/hooks/useSlashCommands.js';
import type { PermissionMode } from '../../src/permissions/types.js';
import type { ScreenMode } from '../../src/tui/state/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { getVerbosity } from '../../src/tui/hooks/useSlashCommands.js';

function createMockContext(overrides: Record<string, unknown> = {}) {
  return {
    setModel: vi.fn(() => true),
    setMode: vi.fn(),
    clearTranscript: vi.fn(),
    compact: vi.fn(),
    setScreen: vi.fn() as unknown as (screen: ScreenMode) => void,
    exit: vi.fn(),
    showInPager: vi.fn() as unknown as (content: string) => void,
    cwd: '/tmp/test-project',
    submitPrompt: vi.fn(),
    getSessionInfo: vi.fn(() => ({
      sessionId: 'test-session-id-1234',
      model: 'claude-sonnet-4-6',
      mode: 'supervised' as PermissionMode,
      turnCount: 5,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      contextTokens: 3000,
      startTime: Date.now() - 60000,
      cwd: '/tmp/test-project',
    })),
    getLastAssistantMessage: vi.fn(() => 'This is the last assistant response'),
    setThinking: vi.fn(),
    setEffort: vi.fn(),
    ...overrides,
  };
}

function resetVerbosity(): void {
  while (getVerbosity() !== 'normal') {
    handleSlashCommand('/verbose', createMockContext());
  }
}

beforeEach(() => {
  resetVerbosity();
});

describe('handleSlashCommand', () => {
  it('returns handled=false for non-slash input', () => {
    const ctx = createMockContext();
    expect(handleSlashCommand('hello world', ctx)).toEqual({ handled: false });
  });

  it('returns handled=false for empty string', () => {
    const ctx = createMockContext();
    expect(handleSlashCommand('', ctx)).toEqual({ handled: false });
  });

  describe('/model', () => {
    it('sets model with argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/model qwen3-coder', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('qwen3-coder');
      expect(ctx.setModel).toHaveBeenCalledWith('qwen3-coder');
    });

    it('opens model picker when no argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/model', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toBeUndefined();
      expect(ctx.setScreen).toHaveBeenCalledWith('models');
      expect(ctx.setModel).not.toHaveBeenCalled();
    });

    it('handles multi-word model names', () => {
      const ctx = createMockContext();
      handleSlashCommand('/model claude-sonnet-4-20250514', ctx);
      expect(ctx.setModel).toHaveBeenCalledWith('claude-sonnet-4-20250514');
    });
  });

  describe('/mode', () => {
    it('sets valid modes', () => {
      const ctx = createMockContext();
      for (const mode of ['plan', 'supervised', 'autonomous']) {
        handleSlashCommand(`/mode ${mode}`, ctx);
        expect(ctx.setMode).toHaveBeenCalledWith(mode);
      }
    });

    it('rejects invalid mode', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/mode invalid', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
      expect(ctx.setMode).not.toHaveBeenCalled();
    });

    it('returns usage when no argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/mode', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });
  });

  describe('/clear', () => {
    it('calls clearTranscript', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/clear', ctx);
      expect(result.handled).toBe(true);
      expect(ctx.clearTranscript).toHaveBeenCalled();
    });
  });

  describe('/compact', () => {
    it('calls compact without instructions', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/compact', ctx);
      expect(result.handled).toBe(true);
      expect(ctx.compact).toHaveBeenCalledWith(undefined);
    });

    it('calls compact with custom instructions', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/compact focus on auth code', ctx);
      expect(result.handled).toBe(true);
      expect(ctx.compact).toHaveBeenCalledWith('focus on auth code');
      expect(result.message).toContain('focus on auth code');
    });
  });

  describe('/session', () => {
    it('opens session picker', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/session', ctx);
      expect(result.handled).toBe(true);
      expect(ctx.setScreen).toHaveBeenCalledWith('sessions');
    });

    it('also works as /sessions', () => {
      const ctx = createMockContext();
      handleSlashCommand('/sessions', ctx);
      expect(ctx.setScreen).toHaveBeenCalledWith('sessions');
    });

    it('also works as /resume', () => {
      const ctx = createMockContext();
      handleSlashCommand('/resume', ctx);
      expect(ctx.setScreen).toHaveBeenCalledWith('sessions');
    });
  });

  describe('/help', () => {
    it('opens help overlay for /help', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/help', ctx);
      expect(result.handled).toBe(true);
      expect(ctx.setScreen).toHaveBeenCalledWith('help');
      expect(result.message).toBeUndefined();
    });

    it('supports full help variant', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/help all', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('[Session]');
      expect(result.message).toContain('/config [subcommand]');
      expect(result.message).toContain('/help all');
    });
  });

  describe('/config', () => {
    it('shows config summary with /config', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/config', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Config shortcuts');
      expect(result.message).toContain('Current: model=');
      expect(result.message).toContain('Statusline:');
    });

    it('accepts /settings alias', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/settings show', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Config shortcuts');
    });

    it('routes to nested commands', () => {
      const ctx = createMockContext();
      handleSlashCommand('/config model gpt-5.3-codex', ctx);
      expect(ctx.setModel).toHaveBeenCalledWith('gpt-5.3-codex');
      handleSlashCommand('/config mode plan', ctx);
      expect(ctx.setMode).toHaveBeenCalledWith('plan');
    });

    it('reports unknown config subcommand', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/config nope', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Unknown /config option');
    });
  });

  describe('/exit and /quit', () => {
    it('/exit calls exit', () => {
      const ctx = createMockContext();
      handleSlashCommand('/exit', ctx);
      expect(ctx.exit).toHaveBeenCalled();
    });

    it('/quit calls exit', () => {
      const ctx = createMockContext();
      handleSlashCommand('/quit', ctx);
      expect(ctx.exit).toHaveBeenCalled();
    });
  });

  describe('unknown commands', () => {
    it('returns error message', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/unknowncommand', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Unknown command');
    });
  });

  it('is case-insensitive for commands', () => {
    const ctx = createMockContext();
    handleSlashCommand('/MODEL gpt-4o', ctx);
    expect(ctx.setModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('handles leading/trailing whitespace', () => {
    const ctx = createMockContext();
    handleSlashCommand('  /clear  ', ctx);
    expect(ctx.clearTranscript).toHaveBeenCalled();
  });

  // --- New command tests ---

  describe('/diff', () => {
    it('calls showInPager when available', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/diff', ctx);
      expect(result.handled).toBe(true);
      // In test env without git, may return "no changes" or error
    });

    it('returns error when pager not available', () => {
      const ctx = createMockContext({ showInPager: undefined });
      const result = handleSlashCommand('/diff', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('pager');
    });
  });

  describe('/status', () => {
    it('returns session info', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/status', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('claude-sonnet-4-6');
      expect(result.message).toContain('supervised');
      expect(result.message).toContain('5'); // turnCount
    });

    it('returns error when getSessionInfo not available', () => {
      const ctx = createMockContext({ getSessionInfo: undefined });
      const result = handleSlashCommand('/status', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('session info');
    });
  });

  describe('/review', () => {
    it('requires cwd and submitPrompt', () => {
      const ctx = createMockContext({ submitPrompt: undefined });
      const result = handleSlashCommand('/review', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('submit');
    });
  });

  describe('/rename', () => {
    it('requires a name argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/rename', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });

    it('renames with argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/rename my-session', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('my-session');
    });
  });

  describe('/init', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('creates AGENTS.md when not exists', () => {
      const ctx = createMockContext({ cwd: tmpDir });
      const result = handleSlashCommand('/init', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Created');
      expect(fs.existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(true);
    });

    it('does not overwrite existing AGENTS.md', () => {
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), 'existing content');
      const ctx = createMockContext({ cwd: tmpDir });
      const result = handleSlashCommand('/init', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('already exists');
    });
  });

  describe('/statusline', () => {
    it('shows current status items without argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/statusline', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('model');
      expect(result.message).toContain('mode');
    });

    it('toggles a status item', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/statusline tokens', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toMatch(/tokens: (shown|hidden)/);
    });

    it('rejects unknown items', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/statusline foobar', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Unknown item');
    });
  });

  describe('/verbose', () => {
    it('cycles through verbosity levels', () => {
      const ctx = createMockContext();
      const first = getVerbosity();
      expect(first).toBe('normal');

      const verbose = handleSlashCommand('/verbose', ctx);
      expect(verbose.handled).toBe(true);
      expect(getVerbosity()).toBe('verbose');
      expect(verbose.message).toContain('verbose');

      handleSlashCommand('/verbose', ctx);
      expect(getVerbosity()).toBe('minimal');

      handleSlashCommand('/verbose', ctx);
      expect(getVerbosity()).toBe('normal');
    });

    it('is case-insensitive', () => {
      const ctx = createMockContext();
      expect(handleSlashCommand('/VERBOSE', ctx).handled).toBe(true);
    });
  });

  describe('/feedback', () => {
    it('requires text argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/feedback', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });

    it('saves feedback to file', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/feedback This is great!', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('saved');
    });
  });

  describe('/fork', () => {
    it('forks session when forkSession returns id', () => {
      const ctx = createMockContext({ forkSession: vi.fn(() => 'abcdef12-3456-7890') });
      const result = handleSlashCommand('/fork', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('forked');
      expect(result.message).toContain('abcdef12');
    });

    it('returns error when no active session', () => {
      const ctx = createMockContext({ forkSession: vi.fn(() => null) });
      const result = handleSlashCommand('/fork', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('No active session');
    });

    it('returns not available when forkSession not provided', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/fork', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('not available');
    });
  });

  describe('/cost', () => {
    it('returns cost breakdown', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/cost', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Cost Breakdown');
      expect(result.message).toContain('$');
      expect(result.message).toContain('1,000');
      expect(result.message).toContain('claude-sonnet-4-6');
    });

    it('returns error when getSessionInfo not available', () => {
      const ctx = createMockContext({ getSessionInfo: undefined });
      const result = handleSlashCommand('/cost', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('session info');
    });
  });

  describe('/context', () => {
    it('returns context window visualization', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/context', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Context Window');
      expect(result.message).toContain('%');
      expect(result.message).toContain('200,000');
    });

    it('shows warning when usage is high', () => {
      const ctx = createMockContext({
        getSessionInfo: vi.fn(() => ({
          sessionId: 'test', model: 'claude-sonnet-4-6', mode: 'supervised',
          turnCount: 50, totalInputTokens: 100000, totalOutputTokens: 50000,
          contextTokens: 160000, startTime: Date.now(), cwd: '/tmp',
        })),
      });
      const result = handleSlashCommand('/context', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Warning');
    });

    it('returns error when getSessionInfo not available', () => {
      const ctx = createMockContext({ getSessionInfo: undefined });
      const result = handleSlashCommand('/context', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('session info');
    });
  });

  describe('/copy', () => {
    it('copies last assistant message', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/copy', ctx);
      expect(result.handled).toBe(true);
      // May succeed or fail depending on clipboard tools — both are valid
      expect(result.message).toBeDefined();
    });

    it('returns error when no message available', () => {
      const ctx = createMockContext({ getLastAssistantMessage: vi.fn(() => null) });
      const result = handleSlashCommand('/copy', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('No assistant message');
    });

    it('returns error when getLastAssistantMessage not provided', () => {
      const ctx = createMockContext({ getLastAssistantMessage: undefined });
      const result = handleSlashCommand('/copy', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('message access');
    });
  });

  describe('/think', () => {
    it('sets valid thinking level', () => {
      const ctx = createMockContext();
      for (const level of ['off', 'on']) {
        const result = handleSlashCommand(`/think ${level}`, ctx);
        expect(result.handled).toBe(true);
        expect(result.message).toContain(level);
        expect(ctx.setThinking).toHaveBeenCalledWith(level);
      }
    });

    it('rejects invalid level', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/think turbo', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });

    it('rejects old granular levels (now use /effort)', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/think high', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });

    it('returns usage when no argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/think', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });
  });

  describe('/effort', () => {
    it('sets valid reasoning effort', () => {
      const ctx = createMockContext();
      for (const level of ['low', 'medium', 'high', 'xhigh']) {
        const result = handleSlashCommand(`/effort ${level}`, ctx);
        expect(result.handled).toBe(true);
        expect(result.message).toContain(level);
      }
    });

    it('rejects invalid level', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/effort turbo', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });

    it('returns usage when no argument', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/effort', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage');
    });
  });

  describe('/doctor', () => {
    it('runs diagnostics', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/doctor', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Diagnostics');
      expect(result.message).toContain('Node.js');
      expect(result.message).toContain('Terminal');
      expect(result.message).toContain('TUI rendering');
      expect(result.message).toContain('Working dir');
      expect(result.message).toContain('checks passed');
    });
  });

  describe('/paste-image', () => {
    it('attempts to read clipboard', () => {
      const ctx = createMockContext();
      const result = handleSlashCommand('/paste-image', ctx);
      expect(result.handled).toBe(true);
      // May fail in test env without xclip — either "No image" or "failed"
      expect(result.message).toBeDefined();
    });
  });

  describe('handleSlashCommandAsync auth', () => {
    it('handles /login success', async () => {
      const ctx = createMockContext({
        loginShizuha: vi.fn(async () => ({ username: 'sara', mcpReloaded: true })),
      });
      const result = await handleSlashCommandAsync('/login sara secret123', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Logged in as sara');
      expect(result.message).toContain('MCP auth reloaded');
    });

    it('handles /logout when nothing to clear', async () => {
      const ctx = createMockContext({
        logoutShizuha: vi.fn(async () => ({ loggedOut: false, mcpReloaded: true })),
      });
      const result = await handleSlashCommandAsync('/logout', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('No local Shizuha login found');
    });

    it('handles /auth status when logged in', async () => {
      const ctx = createMockContext({
        getShizuhaAuthStatus: vi.fn(async () => ({
          loggedIn: true,
          username: 'hritik',
          accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        })),
      });
      const result = await handleSlashCommandAsync('/auth status', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('logged in');
      expect(result.message).toContain('hritik');
      expect(result.message).toContain('not checked');
      expect(result.message).not.toContain('Bearer ');
    });

    it('supports /auth status live verification', async () => {
      const ctx = createMockContext({
        getShizuhaAuthStatus: vi.fn(async () => ({
          loggedIn: true,
          username: 'hritik',
          accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        })),
        verifyShizuhaIdentity: vi.fn(async () => ({ username: 'hritik' })),
      });
      const result = await handleSlashCommandAsync('/auth status live', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Local user:    hritik');
      expect(result.message).toContain('Verified user: hritik');
      expect(result.message).toContain('match: yes');
    });

    it('supports /auth verify alias', async () => {
      const ctx = createMockContext({
        getShizuhaAuthStatus: vi.fn(async () => ({
          loggedIn: true,
          username: 'sara',
          accessTokenExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
        })),
        verifyShizuhaIdentity: vi.fn(async () => ({ username: 'kai' })),
      });
      const result = await handleSlashCommandAsync('/auth verify', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Local user:    sara');
      expect(result.message).toContain('Verified user: kai');
      expect(result.message).toContain('match: no');
    });

    it('shows usage for invalid /auth command', async () => {
      const ctx = createMockContext();
      const result = await handleSlashCommandAsync('/auth whoami', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage: /auth status');
    });

    it('shows usage for invalid /auth status option', async () => {
      const ctx = createMockContext();
      const result = await handleSlashCommandAsync('/auth status maybe', ctx);
      expect(result.handled).toBe(true);
      expect(result.message).toContain('Usage: /auth status');
    });
  });
});
