import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  OptionPreflightError,
  requireEnum,
  requireOptionalEnumNonEmpty,
  requirePort,
  requireNonNegativeInt,
  validateCommonAgentOptions,
  PERMISSION_MODES,
  THINKING_LEVELS,
  EFFORT_LEVELS,
  CHANNEL_MODES,
  TOOLSETS,
} from '../../src/cli/option-preflight.js';
import { assertWorkspaceDir } from '../../src/utils/fs.js';

describe('option-preflight (SCLI-400)', () => {
  it('accepts documented mode/thinking/effort', () => {
    const v = validateCommonAgentOptions({
      mode: 'autonomous',
      thinking: 'high',
      effort: 'xhigh',
      port: '8015',
      requirePortField: true,
    });
    expect(v.mode).toBe('autonomous');
    expect(v.thinking).toBe('high');
    expect(v.effort).toBe('xhigh');
    expect(v.port).toBe(8015);
  });

  it('rejects invalid mode/thinking/effort with field+value', () => {
    for (const [field, value, allowed] of [
      ['mode', 'definitely-invalid', PERMISSION_MODES],
      ['thinking', 'impossible', THINKING_LEVELS],
      ['effort', 'absurd', EFFORT_LEVELS],
    ] as const) {
      try {
        requireEnum(field, value, allowed);
        expect.fail('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(OptionPreflightError);
        const e = err as OptionPreflightError;
        expect(e.field).toBe(field);
        expect(e.value).toBe(value);
        expect(e.message).toContain(value);
        expect(e.message).not.toMatch(/TypeError|\/opt\/|stack/i);
      }
    }
  });

  it('accepts gpt-5.6-sol ChatGPT-backend effort levels ultra/max (codex-bridge)', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'ultra', 'max'] as const) {
      const v = validateCommonAgentOptions({ effort });
      expect(v.effort).toBe(effort);
    }
  });

  it('rejects non-decimal, zero, negative, overflow ports', () => {
    for (const bad of ['nope', 'not-a-number', '0', '-1', '70000', '08', '1e3']) {
      expect(() => requirePort('port', bad)).toThrow(OptionPreflightError);
      try {
        requirePort('port', bad);
      } catch (err) {
        const e = err as OptionPreflightError;
        expect(e.message).toMatch(/port/i);
        expect(e.message).not.toMatch(/ERR_SOCKET|node:net|stack/i);
      }
    }
    expect(requirePort('port', '1')).toBe(1);
    expect(requirePort('port', '65535')).toBe(65535);
  });

  it('rejects alphabetic/negative max-turns', () => {
    expect(() => requireNonNegativeInt('max-turns', 'abc')).toThrow(OptionPreflightError);
    expect(() => requireNonNegativeInt('max-turns', '-1')).toThrow(OptionPreflightError);
    expect(requireNonNegativeInt('max-turns', '0')).toBe(0);
    expect(requireNonNegativeInt('max-turns', '12')).toBe(12);
  });

  it('validateCommonAgentOptions rejects bad sandbox/temperature', () => {
    expect(() =>
      validateCommonAgentOptions({ mode: 'autonomous', sandbox: 'jail' }),
    ).toThrow(/sandbox/);
    expect(() =>
      validateCommonAgentOptions({ mode: 'plan', temperature: 'hot' }),
    ).toThrow(/temperature/);
  });
});

describe('explicit-empty/whitespace fail-closed (SCLI-492 / PLAT-5893)', () => {
  it('rejects explicit-empty and whitespace enum values instead of treating them as missing', () => {
    for (const field of ['mode', 'thinking', 'effort'] as const) {
      expect(() =>
        validateCommonAgentOptions({ [field]: '' }),
      ).toThrow(OptionPreflightError);
      expect(() =>
        validateCommonAgentOptions({ [field]: '   ' }),
      ).toThrow(OptionPreflightError);
    }
  });

  it('rejects explicit-empty numeric values', () => {
    expect(() => validateCommonAgentOptions({ maxTurns: '' })).toThrow(OptionPreflightError);
    expect(() => validateCommonAgentOptions({ temperature: '' })).toThrow(OptionPreflightError);
    expect(() => validateCommonAgentOptions({ port: '', requirePortField: true })).toThrow(OptionPreflightError);
  });

  it('rejects empty port when present (optional)', () => {
    expect(() => validateCommonAgentOptions({ lineWebhookPort: '' })).toThrow(OptionPreflightError);
    expect(() => validateCommonAgentOptions({ whatsappWebhookPort: '  ' })).toThrow(OptionPreflightError);
    expect(() => validateCommonAgentOptions({ imessageWebhookPort: 'nope' })).toThrow(OptionPreflightError);
  });
});

describe('channel modes + host + context-prompt-file (PLAT-5893 / SCLI-400)', () => {
  it('accepts valid discord/slack modes', () => {
    expect(validateCommonAgentOptions({ discordMode: 'mention' }).discordMode).toBe('mention');
    expect(validateCommonAgentOptions({ slackMode: 'all' }).slackMode).toBe('all');
    expect(validateCommonAgentOptions({ discordMode: 'dm' }).discordMode).toBe('dm');
  });

  it('rejects case-mismatched/empty/whitespace channel modes', () => {
    for (const bad of ['MENTION', 'Dm', '', '   ', 'bogus']) {
      expect(() => validateCommonAgentOptions({ discordMode: bad })).toThrow(OptionPreflightError);
      expect(() => validateCommonAgentOptions({ slackMode: bad })).toThrow(OptionPreflightError);
    }
  });

  it('rejects explicit-empty/whitespace host', () => {
    expect(() => validateCommonAgentOptions({ host: '' })).toThrow(OptionPreflightError);
    expect(() => validateCommonAgentOptions({ host: '   ' })).toThrow(OptionPreflightError);
    expect(validateCommonAgentOptions({ host: '127.0.0.1' }).host).toBe('127.0.0.1');
  });

  it('rejects explicit-empty/non-regular context-prompt-file without FIFO hang', () => {
    expect(() => validateCommonAgentOptions({ contextPromptFile: '' })).toThrow(OptionPreflightError);
    expect(() => validateCommonAgentOptions({ contextPromptFile: '/no/such/file' })).toThrow(OptionPreflightError);
  });
});

describe('exec --toolset fail-closed (PLAT-5893 / SCLI-178 exec-toolset)', () => {
  it('passes canonical toolset names through validate', () => {
    for (const name of TOOLSETS) {
      expect(validateCommonAgentOptions({ toolset: name }).toolset).toBe(name);
    }
    expect(TOOLSETS).toContain('full');
    expect(TOOLSETS).toContain('safe');
    expect(TOOLSETS).toContain('qa_engineer');
  });

  it('rejects unknown/case-mismatched toolset names', () => {
    for (const bad of ['bogus-toolset', 'FULL', 'Safe', 'hacker', 'all']) {
      try {
        validateCommonAgentOptions({ toolset: bad });
        expect.fail(`should reject toolset ${bad}`);
      } catch (err) {
        expect(err).toBeInstanceOf(OptionPreflightError);
        const e = err as OptionPreflightError;
        expect(e.field).toBe('toolset');
        expect(e.message).toContain(bad);
        expect(e.message).toContain('expected one of');
        expect(e.message).not.toMatch(/Unknown toolset|returning all tools|TypeError|\/opt\/|stack/i);
      }
    }
  });

  it('rejects explicit-empty and whitespace-only toolset', () => {
    for (const bad of ['', '   ']) {
      try {
        validateCommonAgentOptions({ toolset: bad });
        expect.fail(`should reject toolset ${JSON.stringify(bad)}`);
      } catch (err) {
        const e = err as OptionPreflightError;
        expect(e.field).toBe('toolset');
        expect(e.value).toBe('');
        expect(e.message).toContain('expected one of');
        expect(e.message).not.toMatch(/Unknown toolset|returning all tools|stack/i);
      }
    }
  });

  it('omitted toolset stays optional (undefined, NOT full expansion)', () => {
    expect(validateCommonAgentOptions({}).toolset).toBeUndefined();
    expect(validateCommonAgentOptions({ toolset: undefined }).toolset).toBeUndefined();
  });
});

describe('bridge --cwd preflight (SCLI-493 / SCLI-529)', () => {
  it('accepts directories and directory symlinks, and canonicalizes both', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scli529-cwd-valid-'));
    try {
      const target = path.join(root, 'target');
      const link = path.join(root, 'link');
      fs.mkdirSync(target);
      fs.symlinkSync(target, link);

      expect(assertWorkspaceDir(target)).toBe(fs.realpathSync(target));
      expect(assertWorkspaceDir(link)).toBe(fs.realpathSync(target));
      expect(validateCommonAgentOptions({ cwd: link }).cwd).toBe(fs.realpathSync(target));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the complete invalid workspace matrix with bounded --cwd diagnostics', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scli529-cwd-invalid-'));
    try {
      const missing = path.join(root, 'missing');
      const file = path.join(root, 'file');
      const fifo = path.join(root, 'fifo');
      const dangling = path.join(root, 'dangling');
      fs.writeFileSync(file, 'x');
      if (process.platform !== 'win32') execFileSync('mkfifo', [fifo]);
      fs.symlinkSync(path.join(root, 'no-such-target'), dangling);

      const invalid = [
        ['', /empty or whitespace-only/],
        [' \t\n ', /empty or whitespace-only/],
        [missing, /path does not resolve/],
        [file, /regular file/],
        ...(process.platform === 'win32' ? [] : [[fifo, /not a directory/]]),
        [dangling, /path does not resolve/],
      ] as Array<[string, RegExp]>;

      for (const [cwd, detail] of invalid) {
        for (const check of [
          () => assertWorkspaceDir(cwd),
          () => validateCommonAgentOptions({ cwd }),
        ]) {
          try {
            check();
            expect.fail(`accepted invalid cwd ${JSON.stringify(cwd)}`);
          } catch (err) {
            const message = (err as Error).message;
            expect(message).toContain('--cwd');
            expect(message).toMatch(/existing directory/);
            expect(message).toMatch(detail);
            expect(message).not.toMatch(/\n\s+at |node:fs|StateStore/);
          }
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
