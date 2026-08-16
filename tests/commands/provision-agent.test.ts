/**
 * SCLI-436 regression — `provision-agent` semantic preflight.
 *
 * Acceptance pinned here:
 *  - Username: nonblank canonical account identifier; no whitespace, control
 *    chars (TAB/LF/ANSI-ESC), or path/parent-traversal syntax.
 *  - Role: exactly one documented enum value; explicit empty NEVER silently
 *    defaults to engineer.
 *  - Platform URL: absolute http:// or https:// only.
 *  - Invalid values → ONE concise, ESCAPED, actionable diagnostic and a
 *    rejected promise, with NO "Provisioning …" copy, NO registration client
 *    invocation, and NO `~/.shizuha/agent-auth/` state write.
 *  - Valid documented path is preserved.
 *
 * Consumer-boundary fixtures call `runProvisionAgent` (the real command
 * handler) with `ensureAgentAccount` mocked so the registration client is
 * never invoked even on the valid path; invalid-path cases additionally assert
 * zero state mutation.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  validateProvisionInputs,
  describeProvisionValue,
  PROVISION_AGENT_ROLES,
  runProvisionAgent,
} from '../../src/commands/provision-agent.js';
import type { ProvisionAgentOptions } from '../../src/commands/provision-agent.js';

vi.mock('../../src/daemon/agent-accounts.js', () => ({
  ensureAgentAccount: vi.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ensureAgentAccount } = await import('../../src/daemon/agent-accounts.js');

const validOpts = (overrides: ProvisionAgentOptions = {}): ProvisionAgentOptions => ({
  role: 'qa',
  platformUrl: 'http://127.0.0.1:9',
  adminToken: 'dummy-admin',
  ...overrides,
});

const fakeProvision = {
  username: 'qa5',
  userId: 123,
  email: 'qa5@agents.shizuha.io',
  accessToken: 'dummy-access-token',
};

describe('SCLI-436 provision-agent preflight', () => {
  describe('validateProvisionInputs — username', () => {
    it('accepts canonical usernames', () => {
      for (const u of ['nagi', 'qa1', 'agent-x', 'dev_nagi', 'a.b', 'a0']) {
        expect(() => validateProvisionInputs(u, validOpts())).not.toThrow();
      }
    });

    it('rejects empty / whitespace / control / path-traversal usernames', () => {
      const bad = ['', '   ', '\t\t', '\u0000x', '\nadmin', 'na gi', '\u001b[31mred\u001b[0m', '../nagi', '/abs', 'a/b', '.', '..', 'a\nb'];
      for (const u of bad) {
        let msg = '';
        expect(() => {
          try { validateProvisionInputs(u, validOpts()); } catch (err) { msg = (err as Error).message; throw err; }
        }).toThrow(/provision-agent: username/);
        // Escaped + single-line diagnostic: no raw control bytes may reach a terminal.
        expect(msg).not.toMatch(/[\r\n]/);
        expect(msg).not.toContain('\u001b');
      }
    });
  });

  describe('validateProvisionInputs — role', () => {
    it('accepts each documented enum value exactly (case-sensitive)', () => {
      for (const r of PROVISION_AGENT_ROLES) {
        expect(() => validateProvisionInputs('nagi', validOpts({ role: r }))).not.toThrow();
      }
      // Case mismatch rejected (zen recurrence).
      expect(() => validateProvisionInputs('nagi', validOpts({ role: 'QA' }))).toThrow(/role must be one of/);
    });

    it('defaults to engineer only when the option is omitted', () => {
      const { role } = validateProvisionInputs('nagi', validOpts({ role: undefined }));
      expect(role).toBe('engineer');
    });

    it('rejects undefined-as-empty, explicit empty, and unknown/whitespace roles', () => {
      for (const r of ['root', 'nope', 'QA ', 'engineer2', 'devops3'] as string[]) {
        expect(() => validateProvisionInputs('nagi', validOpts({ role: r }))).toThrow(/role must be one of/);
      }
      // Explicit empty must NOT silently become engineer (SCLI-436).
      expect(() => validateProvisionInputs('nagi', validOpts({ role: '' }))).toThrow(/role must be one of/);
    });
  });

  describe('validateProvisionInputs — platform URL', () => {
    // Strip the container-global SHIZUHA_PLATFORM_URL so empty-explicit behaves
    // like the stripped-context contract (SCLI-436 QA matrix): no env fallback.
    beforeEach(() => {
      vi.stubEnv('SHIZUHA_PLATFORM_URL', '');
      vi.stubEnv('SHIZUHA_ADMIN_TOKEN', '');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('accepts absolute http(s) URLs', () => {
      for (const u of ['http://127.0.0.1:9', 'https://shizuha.com/x?y=1', 'https://shizuha.com/']) {
        expect(() => validateProvisionInputs('nagi', validOpts({ platformUrl: u }))).not.toThrow();
      }
    });

    it('rejects relative / non-http(s) / scheme-less / hostless URLs', () => {
      const bad = [
        '', 'shizuha.com', '127.0.0.1:9', '/base/path', '//host/path',
        'file:///etc/passwd', 'javascript:alert(1)', 'data:text/plain,x',
        'ftp://x.example', 'http://',
      ];
      for (const u of bad) {
        let msg = '';
        let threw = false;
        try {
          validateProvisionInputs('nagi', validOpts({ platformUrl: u }));
        } catch (err) {
          msg = (err as Error).message;
          threw = true;
        }
        if (!threw) console.error('DID NOT THROW for URL', JSON.stringify(u));
        expect(msg).toMatch(/provision-agent: platform URL/);
        expect(msg).not.toMatch(/[\r\n]/);
      }
    });
  });

  describe('validateProvisionInputs — admin token + display names', () => {
    it('requires an admin token', () => {
      expect(() => validateProvisionInputs('nagi', validOpts({ adminToken: '' }))).toThrow(/admin token required/);
    });

    it('rejects control bytes in display names', () => {
      expect(() => validateProvisionInputs('nagi', validOpts({ firstName: 'A\nB' }))).toThrow(/first-name/);
      expect(() => validateProvisionInputs('nagi', validOpts({ lastName: 'C\u001b[31mD' }))).toThrow(/last-name/);
      expect(() => validateProvisionInputs('nagi', validOpts({ firstName: 'Fine', lastName: 'Name' }))).not.toThrow();
    });
  });

  describe('describeProvisionValue — escape contract', () => {
    it('escapes line feeds and control bytes into a single safe line', () => {
      expect(describeProvisionValue('a\nb')).toBe('"a\\nb"');
      expect(describeProvisionValue('a\tb')).toBe('"a\\tb"');
      expect(describeProvisionValue('\u001b[31mred')).toBe('"\\u001b[31mred"');
      // No raw control bytes survive.
      expect(describeProvisionValue('x\ny')).not.toMatch(/[\u0000-\u001f\u007f]/);
    });

    it('caps long values', () => {
      const short = describeProvisionValue('a'.repeat(500));
      expect(short.length).toBeLessThan(100);
      expect(short.endsWith('…')).toBe(true);
    });
  });

  describe('runProvisionAgent — consumer boundary', () => {
    let tmpHome: string;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli436-home-'));
      process.env.HOME = tmpHome;
    });
    afterAll(() => {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });
    beforeEach(() => {
      vi.mocked(ensureAgentAccount).mockReset();
      logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    const authDir = () => path.join(tmpHome, '.shizuha', 'agent-auth');
    const provisioningPrinted = () => logSpy.mock.calls.some(([s]) => String(s).includes('[provision-agent] Provisioning'));

    it('invalid username: rejects, no provisioner call, no Provisioning copy, no state write', async () => {
      const homeBefore = fs.existsSync(authDir());
      await expect(runProvisionAgent('bad\nuser', validOpts())).rejects.toThrow(/provision-agent: username/);
      expect(vi.mocked(ensureAgentAccount)).not.toHaveBeenCalled();
      expect(provisioningPrinted()).toBe(false);
      expect(fs.existsSync(authDir())).toBe(homeBefore);
      expect(fs.existsSync(path.join(tmpHome, '.shizuha'))).toBe(homeBefore);
    });

    it('invalid role: explicit empty never reaches the provisioner', async () => {
      await expect(runProvisionAgent('qa5', validOpts({ role: '' }))).rejects.toThrow(/role must be one of/);
      expect(vi.mocked(ensureAgentAccount)).not.toHaveBeenCalled();
      expect(provisioningPrinted()).toBe(false);
      expect(fs.existsSync(authDir())).toBe(false);
    });

    it('invalid platform URL: rejects before any network/state', async () => {
      await expect(runProvisionAgent('qa5', validOpts({ platformUrl: 'javascript:alert(1)' }))).rejects.toThrow(/platform URL/);
      expect(vi.mocked(ensureAgentAccount)).not.toHaveBeenCalled();
      expect(provisioningPrinted()).toBe(false);
      expect(fs.existsSync(authDir())).toBe(false);
    });

    it('valid input: preserved documented path provisions through the mocked account client', async () => {
      vi.mocked(ensureAgentAccount).mockResolvedValue(fakeProvision as never);
      const opts = validOpts({ role: 'qa', home: path.join(tmpHome, 'homes', 'qa5') });
      const result = await runProvisionAgent('qa5', opts);
      expect(vi.mocked(ensureAgentAccount)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ensureAgentAccount)).toHaveBeenCalledWith(
        expect.objectContaining({
          agentUsername: 'qa5',
          agentEmail: 'qa5@agents.shizuha.io',
          platformUrl: 'http://127.0.0.1:9',
          adminToken: 'dummy-admin',
        }),
      );
      expect(provisioningPrinted()).toBe(true);
      expect(result.username).toBe('qa5');
      // The valid path DOES write agent state (that is its documented job).
      expect(fs.existsSync(result.mcpJsonPath)).toBe(true);
    });
  });
});
