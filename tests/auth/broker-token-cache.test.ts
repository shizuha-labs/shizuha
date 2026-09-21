import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { writeAgentTokenCache } from '../../src/auth/agent-token-cache.js';

vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
}));

import { AgentTokenManager } from '../../src/auth/agent-token-manager.js';
import { fetchBrokerToken } from '../../src/auth/broker-token.js';
import { readAgentOwnToken } from '../../src/provider/registry.js';

function jwt(overrides: Record<string, unknown> = {}): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [encode({ alg: 'RS256', typ: 'JWT' }), encode({
    username: 'mio', user_id: '72', email: 'mio@agents.shizuha.io', token_type: 'access',
    iat: Math.floor(Date.now() / 1000) - 120, exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  }), 'test-signature'].join('.');
}

describe('broker renewal reaches the existing agent-owned subprocess cache', () => {
  let directory: string;
  let file: string;
  let server: http.Server;
  let response: { access?: unknown; expires_at?: unknown };
  let status: number;
  let requests: string[];
  const previousEnv = { ...process.env };

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-cache-'));
    process.env['HOME'] = directory;
    process.env['AGENT_USERNAME'] = 'mio';
    process.env['SHIZUHA_AGENT_USERNAME'] = 'mio';
    delete process.env['AGENT_USER_ID'];
    process.env['MCP_AUTH_PROXY_SOCKET'] = path.join(directory, 'broker.sock');
    file = path.join(directory, '.shizuha', 'auth', 'token-mio.json');
    status = 200;
    response = { access: jwt({ jti: 'initial' }) };
    requests = [];
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) => server.listen(process.env['MCP_AUTH_PROXY_SOCKET'], resolve));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env = { ...previousEnv };
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('projects the initial token and broker successor at the actual GET and one-shot read boundaries', async () => {
    const initial = response.access;
    expect((await fetchBrokerToken())?.accessToken).toBe(initial);
    expect(readAgentOwnToken()).toBe(initial);
    fs.chmodSync(file, 0o660); // Legacy shared-workspace mode is replaced, not retained.
    response = { access: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'successor', exp: Math.floor(Date.now() / 1000) + 7200 }) };
    expect((await fetchBrokerToken())?.accessToken).toBe(response.access);
    expect(readAgentOwnToken()).toBe(response.access);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
      accessToken: response.access, userId: '72', refreshToken: '',
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(requests).toEqual(['GET /token', 'GET /token']); // No refresh/login/model request.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['token-mio.json']);
  });

  it.each([
    ['wrong username', () => jwt({ username: 'sara' })],
    ['wrong immutable principal', () => jwt({ user_id: '99' })],
    ['missing immutable principal', () => jwt({ user_id: null })],
    ['missing issuer timestamp', () => jwt({ iat: undefined })],
    ['future issuer timestamp', () => jwt({ iat: Math.floor(Date.now() / 1000) + 100 })],
    ['expired', () => jwt({ exp: Math.floor(Date.now() / 1000) - 1 })],
    ['invalid timestamp range', () => jwt({ exp: 1e18 })],
    ['malformed', () => 'not-a-jwt'],
  ])('preserves the valid cache on %s broker data', async (_name, invalidToken) => {
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    response = { access: invalidToken() };
    expect(await fetchBrokerToken()).toBeNull();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('preserves the cache on failed HTTP reads or mismatched runtime identity hints', async () => {
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    status = 503;
    expect(await fetchBrokerToken()).toBeNull();
    status = 200;
    process.env['SHIZUHA_AGENT_USERNAME'] = 'sara';
    expect(await fetchBrokerToken()).toBeNull();
    process.env['SHIZUHA_AGENT_USERNAME'] = 'mio';
    process.env['AGENT_USER_ID'] = '99';
    expect(await fetchBrokerToken()).toBeNull();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('preserves the cache when expiry metadata disagrees with the JWT or is malformed', async () => {
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    for (const expires_at of ['not-a-date', new Date(Date.now() + 24 * 3600_000).toISOString(), 123]) {
      response = { access: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'successor' }), expires_at };
      expect(await fetchBrokerToken()).toBeNull();
      expect(fs.readFileSync(file)).toEqual(before);
    }
  });

  it('never exposes a partly-written successor and retains the old cache on atomic replacement failure', async () => {
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    response = { access: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'successor' }) };
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      expect(fs.readFileSync(file)).toEqual(before);
      throw new Error('test rename failure');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await fetchBrokerToken())?.accessToken).toBe(response.access); // Live MCP auth remains usable.
    expect(rename).toHaveBeenCalledOnce();
    expect(fs.readFileSync(file)).toEqual(before);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['token-mio.json']);
    expect(warning).toHaveBeenCalledWith('Agent token cache update failed; existing cache retained');
  });

  it('keeps valid in-memory auth when refusing a symlink cache target without modifying its referent', async () => {
    await fetchBrokerToken();
    const target = path.join(directory, 'other.json');
    fs.renameSync(file, target);
    const before = fs.readFileSync(target);
    fs.symlinkSync(target, file);
    response = { access: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'successor' }) };
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await fetchBrokerToken())?.accessToken).toBe(response.access);
    expect(fs.readFileSync(target)).toEqual(before);
    expect(warning).toHaveBeenCalledOnce();
  });
  it('keeps the newer issuer token when an older response completes last in independent processes', async () => {
    server.removeAllListeners('request');
    const pending: http.ServerResponse[] = [];
    server.on('request', (req, res) => { requests.push(`${req.method} ${req.url}`); pending.push(res); server.emit('pending'); });
    const script = `import { fetchBrokerToken } from './src/auth/broker-token.ts';
      const value = await fetchBrokerToken(); process.exitCode = value ? 0 : 1;`;
    const child = () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const children: ReturnType<typeof spawn>[] = [];
    try {
      const old = child(); children.push(old);
      const oldExit = once(old, 'exit');
      let error = '';
      old.stderr!.on('data', (value) => { error += value.toString().slice(0, 2000); });
      if (pending.length < 1) await Promise.race([once(server, 'pending'), oldExit.then(([code]) => {
        throw new Error(`older reader exited before request (${code}): ${error}`);
      })]);
      const fresh = child(); children.push(fresh); const freshExit = once(fresh, 'exit');
      if (pending.length < 2) await Promise.race([once(server, 'pending'), freshExit.then(([code]) => {
        throw new Error(`newer reader exited before request (${code})`);
      })]);
      const now = Math.floor(Date.now() / 1000);
      // Longer expiry is deliberately OLDER: TTL is not issuer ordering.
      const older = jwt({ iat: now - 60, exp: now + 7200, jti: 'older' });
      const newer = jwt({ iat: now, exp: now + 3600, jti: 'newer' });
      pending[1]!.writeHead(200); pending[1]!.end(JSON.stringify({ access: newer }));
      expect(await freshExit).toEqual([0, null]);
      expect(readAgentOwnToken()).toBe(newer);
      pending[0]!.writeHead(200); pending[0]!.end(JSON.stringify({ access: older }));
      expect(await oldExit).toEqual([0, null]);
      expect(readAgentOwnToken()).toBe(newer);
      expect(requests).toEqual(['GET /token', 'GET /token']);
    } finally {
      for (const process of children) if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
      for (const response of pending) response.destroy();
    }
  });

  it('preserves the current token on an unorderable same-second issuer tie', async () => {
    // Pin BOTH issuer times to one explicit second: the tie is unorderable
    // only while cached-iat == incoming-iat. Deriving each iat from its own
    // Date.now() (the jwt() default, now-120) let a second-boundary straddle
    // order the incoming token as newer and rewrite the cache — the 1/4680
    // full-suite failure on run 6613 (broker-token-cache.test.ts:197).
    const tieIat = Math.floor(Date.now() / 1000) - 120;
    response = { access: jwt({ iat: tieIat, jti: 'tie-current' }) };
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    response = { access: jwt({ iat: tieIat, jti: 'same-second', exp: Math.floor(Date.now() / 1000) + 7200 }) };
    expect((await fetchBrokerToken())?.accessToken).toBe(response.access);
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it('common manager writer cannot overwrite a newer broker projection', async () => {
    response = { access: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'newer' }) };
    await fetchBrokerToken();
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    writeAgentTokenCache(file, { ...current, accessToken: jwt({ jti: 'old-manager-result' }) });
    expect(readAgentOwnToken()).toBe(current.accessToken);
  });

  it('retains valid broker auth if Linux locking is unavailable on a development platform', async () => {
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
      response = { access: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'newer' }) };
      expect((await fetchBrokerToken())?.accessToken).toBe(response.access);
      expect(fs.readFileSync(file)).toEqual(before);
      // Legacy development login retains its existing atomic cache behavior.
      delete process.env['MCP_AUTH_PROXY_SOCKET'];
      const previous = JSON.parse(before.toString());
      writeAgentTokenCache(file, { ...previous, accessToken: response.access });
      expect(readAgentOwnToken()).toBe(response.access);
    } finally { Object.defineProperty(process, 'platform', platform); }
    expect(warning).toHaveBeenCalledOnce();
  });

  it.each(['close', 'crash', 'competing older writer'])('kernel ownership survives helper exit and releases on writer %s', async (finish) => {
    await fetchBrokerToken();
    const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
    const next = { ...previous, accessToken: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'next' }) };
    const script = String.raw`import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { spawnSync } from 'node:child_process';
      import { writeAgentTokenCache } from './src/auth/agent-token-cache.ts';
      const file = process.env.TEST_CACHE;
      const read = fs.readFileSync; let reads = 0;
      fs.readFileSync = function(p, ...args) {
        const result = read.call(this, p, ...args);
        if (p === file && ++reads === 2) {
          fs.writeSync(1, 'LOCKED\n');
          // Test barrier only. The production lock acquisition helper has
          // already exited; ownership must still belong to this writer.
          spawnSync('/bin/cat', [], { stdio: [0, 'ignore', 'ignore'] });
        }
        return result;
      };
      syncBuiltinESMExports();
      writeAgentTokenCache(file, JSON.parse(process.env.TEST_TOKEN));`;
    const writer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: { ...process.env, TEST_CACHE: file, TEST_TOKEN: JSON.stringify(next) }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = once(writer, 'exit');
    try {
      const [marker] = await Promise.race([once(writer.stdout, 'data'),
        exited.then(([code]) => { throw new Error(`writer exited before lock marker: ${code}`); })]);
      expect(marker.toString()).toBe('LOCKED\n');
      const contender = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', path.dirname(file), '/bin/true']);
      expect(contender.status).toBe(1);
      expect(readAgentOwnToken()).toBe(previous.accessToken);
      let older: ReturnType<typeof spawn> | undefined;
      let olderExit: Promise<[number | null, NodeJS.Signals | null]> | undefined;
      if (finish === 'competing older writer') {
        const oldScript = String.raw`import cp from 'node:child_process';
          import fs from 'node:fs';
          import { syncBuiltinESMExports } from 'node:module';
          import { writeAgentTokenCache } from './src/auth/agent-token-cache.ts';
          const spawn = cp.spawnSync;
          cp.spawnSync = function(command, ...args) {
            if (command === '/usr/bin/flock') fs.writeSync(1, 'CONTENDING\n');
            return spawn.call(this, command, ...args);
          };
          syncBuiltinESMExports();
          writeAgentTokenCache(process.env.TEST_CACHE, JSON.parse(process.env.TEST_TOKEN));`;
        older = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', oldScript], {
          cwd: fileURLToPath(new URL('../..', import.meta.url)),
          env: { ...process.env, TEST_CACHE: file, TEST_TOKEN: JSON.stringify({
            ...previous, accessToken: jwt({ iat: Math.floor(Date.now() / 1000) - 60, jti: 'late-older' }),
          }) }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        olderExit = once(older, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
        const [ready] = await Promise.race([once(older.stdout!, 'data'),
          olderExit.then(([code]) => { throw new Error(`older writer exited before contention: ${code}`); })]);
        expect(ready.toString()).toBe('CONTENDING\n');
      }
      if (finish === 'crash') writer.kill('SIGKILL');
      writer.stdin.end();
      expect(await exited).toEqual(finish === 'crash' ? [null, 'SIGKILL'] : [0, null]);
      if (olderExit) {
        expect(await olderExit).toEqual([0, null]);
        expect(readAgentOwnToken()).toBe(next.accessToken);
      }
      const released = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', path.dirname(file), '/bin/true']);
      expect(released.status).toBe(0);
      writeAgentTokenCache(file, next);
      expect(readAgentOwnToken()).toBe(next.accessToken);
      expect(fs.readdirSync(path.dirname(file))).toEqual(['token-mio.json']);
    } finally {
      if (writer.exitCode === null && writer.signalCode === null) writer.kill('SIGKILL');
      writer.stdin.end();
    }
  });

  it('avoids a helper process when the current valid disk token already matches', async () => {
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    const helper = vi.spyOn(childProcess, 'spawnSync');
    expect((await fetchBrokerToken())?.accessToken).toBe(response.access);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(helper).not.toHaveBeenCalled();
  });

  it('repairs a corrupt regular cache through a broker GET and the existing one-shot reader', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"accessToken":"truncated-private-fragment', { mode: 0o600 });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await fetchBrokerToken())?.accessToken).toBe(response.access);
    expect(readAgentOwnToken()).toBe(response.access);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).accessToken).toBe(response.access);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(warning).not.toHaveBeenCalled(); // No parse exception can expose a token fragment.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['token-mio.json']);
  });

  it('the actual manager repairs corrupt cache without logging a token fragment', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"accessToken":"truncated-private-fragment', { mode: 0o600 });
    delete process.env['AGENT_ACCESS_TOKEN'];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const manager = new AgentTokenManager({ agentUsername: 'mio', platformUrl: 'http://127.0.0.1:1' });
    expect(await manager.getToken()).toBe(response.access);
    expect(readAgentOwnToken()).toBe(response.access);
    expect(warning).toHaveBeenCalledExactlyOnceWith('[mio] Agent token: failed to read cached token');
  });

  it('retains valid in-memory auth when the Linux lock helper is missing', async () => {
    await fetchBrokerToken();
    const before = fs.readFileSync(file);
    const unavailable = spawnSync('/missing-agent-runtime-cache-lock-helper');
    expect(unavailable.error).toBeDefined();
    vi.spyOn(childProcess, 'spawnSync').mockReturnValue(unavailable);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    response = { access: jwt({ iat: Math.floor(Date.now() / 1000), jti: 'successor' }) };
    expect((await fetchBrokerToken())?.accessToken).toBe(response.access);
    expect(fs.readFileSync(file)).toEqual(before);
    expect(warning).toHaveBeenCalledOnce();
  });

});
