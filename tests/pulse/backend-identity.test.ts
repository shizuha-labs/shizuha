import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const servers: http.Server[] = [];
let privateRoot: string;
let mappingFile: string;
beforeEach(() => {
  privateRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pulse-installation-'));
  vi.stubEnv('HOME', privateRoot);
  vi.stubEnv('XDG_CONFIG_HOME', undefined);
  vi.stubEnv('SHIZUHA_PULSE_HUMAN_EMAILS', undefined);
  mappingFile = path.join(privateRoot, '.config', 'shizuha', 'pulse-human-emails.json');
});
function writePrivateMapping(contents: string): void {
  fs.mkdirSync(path.dirname(mappingFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(mappingFile, contents, { mode: 0o600 });
  fs.chmodSync(mappingFile, 0o600);
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(privateRoot, { recursive: true, force: true });
  vi.resetModules();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('explicit Pulse human identity configuration', () => {
  it('uses configured human mailbox through the actual HTTP adapter in both directions', async () => {
    let posted: Record<string, unknown> = {};
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        if (request.method === 'POST') {
          posted = JSON.parse(Buffer.concat(chunks).toString());
          response.end(JSON.stringify({ id: 1, assignee_email: posted.assignee_email }));
        } else response.end(JSON.stringify({results: []}));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    vi.stubEnv('DAEMON_PORT', String((server.address() as import('node:net').AddressInfo).port));
    vi.stubEnv('SHIZUHA_PULSE_HUMAN_EMAILS', JSON.stringify({ maintainer: 'maintainer@example.invalid' }));
    const backend = await import('../../src/pulse/backend.js');
    expect(await backend.detectBackend()).toBe('platform');
    const task = await backend.createTask({title: 'Configured routing', assignee: 'maintainer'}, 'agent');
    expect(posted.assignee_email).toBe('maintainer@example.invalid');
    expect(task).toMatchObject({ assignee: 'maintainer' });
  });
});


it('keeps generic agent routing and refuses malformed or ambiguous managed mappings', async () => {
  const identity = await import('../../src/pulse/identity.js');
  vi.stubEnv('SHIZUHA_PULSE_HUMAN_EMAILS', '');
  expect(identity.pulseEmailFor('agent')).toBe('agent@agents.shizuha.io');
  for (const value of ['[]', '{', '{"owner":"not-a-mailbox"}', '{"owner":"x@example.invalid","other":"x@example.invalid"}', '{"owner":null}']) {
    vi.stubEnv('SHIZUHA_PULSE_HUMAN_EMAILS', value);
    expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  }
});

it('uses an actual owner-private file through the HTTP adapter and respects XDG_CONFIG_HOME', async () => {
  vi.stubEnv('XDG_CONFIG_HOME', path.join(privateRoot, 'selected-config'));
  mappingFile = path.join(privateRoot, 'selected-config', 'shizuha', 'pulse-human-emails.json');
  writePrivateMapping(JSON.stringify({ maintainer: 'maintainer@example.invalid' }));
  let posted: Record<string, unknown> = {};
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') {
        posted = JSON.parse(Buffer.concat(chunks).toString());
        response.end(JSON.stringify({ id: 1, assignee_email: posted.assignee_email }));
      } else response.end(JSON.stringify({ results: [] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('DAEMON_PORT', String((server.address() as import('node:net').AddressInfo).port));
  const backend = await import('../../src/pulse/backend.js');
  expect(await backend.detectBackend()).toBe('platform');
  expect(await backend.createTask({ title: 'Private installation routing', assignee: 'maintainer' }, 'agent')).toMatchObject({ assignee: 'maintainer' });
  expect(posted.assignee_email).toBe('maintainer@example.invalid');
});

it('lets explicit environment configuration including empty override the file', async () => {
  writePrivateMapping('{malformed private content');
  const identity = await import('../../src/pulse/identity.js');
  vi.stubEnv('SHIZUHA_PULSE_HUMAN_EMAILS', '{"maintainer":"explicit@example.invalid"}');
  expect(identity.pulseEmailFor('maintainer')).toBe('explicit@example.invalid');
  vi.stubEnv('SHIZUHA_PULSE_HUMAN_EMAILS', '');
  expect(identity.pulseEmailFor('maintainer')).toBe('maintainer@agents.shizuha.io');
});

it('reloads missing, valid, removed and repaired files without retaining stale mapping authority', async () => {
  const identity = await import('../../src/pulse/identity.js');
  expect(identity.pulseEmailFor('maintainer')).toBe('maintainer@agents.shizuha.io');
  writePrivateMapping('{"maintainer":"maintainer@example.invalid"}');
  expect(identity.pulseUsernameFor('maintainer@example.invalid')).toBe('maintainer');
  fs.unlinkSync(mappingFile);
  expect(identity.pulseEmailFor('maintainer')).toBe('maintainer@agents.shizuha.io');
  writePrivateMapping('[]');
  expect(() => identity.pulseEmailFor('maintainer')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  writePrivateMapping('{"maintainer":"repaired@example.invalid"}');
  expect(identity.pulseEmailFor('maintainer')).toBe('repaired@example.invalid');
});

it('refuses malformed, empty, ambiguous and oversized local files with sanitized errors', async () => {
  const identity = await import('../../src/pulse/identity.js');
  for (const content of ['', '{private invalid data', '[]', '{"owner":"bad"}', '{"owner":"x@example.invalid","other":"x@example.invalid"}', ' '.repeat(64 * 1024 + 1)]) {
    writePrivateMapping(content);
    expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  }
});

it('refuses relative config roots, nonregular files and symlinks without following them', async () => {
  const identity = await import('../../src/pulse/identity.js');
  vi.stubEnv('XDG_CONFIG_HOME', 'relative-config');
  expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  vi.stubEnv('XDG_CONFIG_HOME', undefined);
  writePrivateMapping('{"owner":"owner@example.invalid"}');
  const target = path.join(privateRoot, 'target.json');
  fs.renameSync(mappingFile, target);
  fs.symlinkSync(target, mappingFile);
  expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  fs.unlinkSync(mappingFile);
  fs.mkdirSync(mappingFile);
  expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  fs.rmdirSync(mappingFile);
  const originalDirectory = path.dirname(mappingFile);
  const movedDirectory = originalDirectory + '-moved';
  fs.renameSync(originalDirectory, movedDirectory);
  fs.symlinkSync(movedDirectory, originalDirectory, 'dir');
  expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
});

it('enforces POSIX owner identity and private permissions on the actual file', async () => {
  if (process.platform === 'win32') return;
  const identity = await import('../../src/pulse/identity.js');
  writePrivateMapping('{"owner":"owner@example.invalid"}');
  expect(identity.pulseEmailFor('owner')).toBe('owner@example.invalid');
  fs.chmodSync(mappingFile, 0o640);
  expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  fs.chmodSync(mappingFile, 0o600);
  const owner = process.getuid!();
  const uid = vi.spyOn(process, 'getuid').mockReturnValue(owner + 1);
  expect(() => identity.pulseEmailFor('owner')).toThrow('Invalid SHIZUHA_PULSE_HUMAN_EMAILS configuration');
  uid.mockRestore();
  expect(identity.pulseEmailFor('owner')).toBe('owner@example.invalid');
});
