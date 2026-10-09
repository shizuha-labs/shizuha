import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createCortexAuthResolver } from '../../src/provider/registry.js';
import { VLlmProvider } from '../../src/provider/vllm.js';

const AMBIENT_ENV_KEYS = [
  'CORTEX_OAUTH_TOKEN',
  'CORTEX_API_KEY',
  'CORTEX_API_KEY_SHARED_FALLBACK',
  'SHIZUHA_CORTEX_AUTH_MODE',
  'SHIZUHA_AGENT_USERNAME',
  'SHIZUHA_AGENT_ID',
  'SHIZUHA_K8S_PRIMARY_MODEL',
];

const savedEnv = new Map<string, string | undefined>();
beforeEachEnv();
function beforeEachEnv() {
  for (const key of AMBIENT_ENV_KEYS) savedEnv.set(key, process.env[key]);
}
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createCortexAuthResolver — no unauthenticated window at token rotation', () => {
  it('prefers the sync precedence when it resolves a credential', async () => {
    process.env['CORTEX_OAUTH_TOKEN'] = 'env-token';
    const getValidCalls: number[] = [];
    const resolve = createCortexAuthResolver(undefined, {
      getValidAccessToken: async () => {
        getValidCalls.push(1);
        return 'refreshed-token';
      },
    });
    await expect(resolve()).resolves.toBe('env-token');
    expect(getValidCalls).toHaveLength(0);
  });

  it('falls back to the on-demand refresh when the sync read refuses (pre-expiry skew window)', async () => {
    // No env keys, no API key in config/credentials — the sync read yields
    // nothing (this is the exact state inside the 10-minute pre-expiry skew
    // window with no sk-cortex key configured).
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-'));
    try {
      const authDir = path.join(home, '.shizuha');
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({
        username: 'hritik',
        accessToken: 'expired-jwt',
        refreshToken: 'refresh-token',
        lastLoginAt: new Date().toISOString(),
      }));
      const savedHome = process.env['HOME'];
      process.env['HOME'] = home;
      try {
        const resolve = createCortexAuthResolver(undefined, {
          getValidAccessToken: async () => 'freshly-minted-token',
        });
        await expect(resolve()).resolves.toBe('freshly-minted-token');
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('never borrows the human login in an agent runtime', async () => {
    process.env['SHIZUHA_AGENT_USERNAME'] = 'agent-seat';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-agent-'));
    try {
      const authDir = path.join(home, '.shizuha');
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({
        username: 'human',
        accessToken: 'human-jwt',
        refreshToken: 'refresh-token',
        lastLoginAt: new Date().toISOString(),
      }));
      const savedHome = process.env['HOME'];
      process.env['HOME'] = home;
      try {
        let refreshCalled = false;
        const resolve = createCortexAuthResolver(undefined, {
          getValidAccessToken: async () => {
            refreshCalled = true;
            return 'freshly-minted-token';
          },
        });
        await expect(resolve()).resolves.toBeUndefined();
        expect(refreshCalled).toBe(false);
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('stays undefined without a stored login (no auth.json) — the /login hint stays correct', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-empty-'));
    try {
      const savedHome = process.env['HOME'];
      process.env['HOME'] = home;
      try {
        let refreshCalled = false;
        const resolve = createCortexAuthResolver(undefined, {
          getValidAccessToken: async () => {
            refreshCalled = true;
            return 'should-not-be-used';
          },
        });
        await expect(resolve()).resolves.toBeUndefined();
        expect(refreshCalled).toBe(false);
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('maps a failed refresh to undefined (401 path then reports the truth)', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-auth-fail-'));
    try {
      const authDir = path.join(home, '.shizuha');
      fs.mkdirSync(authDir, { recursive: true });
      fs.writeFileSync(path.join(authDir, 'auth.json'), JSON.stringify({
        username: 'hritik',
        accessToken: 'expired-jwt',
        refreshToken: 'refresh-token',
        lastLoginAt: new Date().toISOString(),
      }));
      const savedHome = process.env['HOME'];
      process.env['HOME'] = home;
      try {
        const resolve = createCortexAuthResolver(undefined, {
          getValidAccessToken: async () => {
            throw new Error('refresh endpoint unreachable');
          },
        });
        await expect(resolve()).resolves.toBeUndefined();
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('VLlmProvider await-capable auth resolver', () => {
  it('sends the Authorization header from an async resolver on the FIRST attempt', async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['authorization']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', object: 'model' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = new VLlmProvider(
        `http://127.0.0.1:${port}`,
        undefined,
        async () => 'token-from-async-resolver', // the Cortex resolver shape
        'cortex',
      );
      const model = await provider.getServedModel('test-model');
      expect(model).toBe('test-model');
      expect(seen).toEqual(['Bearer token-from-async-resolver']);
    } finally {
      server.close();
    }
  });

  it('sync resolvers keep working unchanged', async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['authorization']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', object: 'model' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = new VLlmProvider(
        `http://127.0.0.1:${port}`,
        undefined,
        () => 'token-from-sync-resolver',
        'cortex',
      );
      await provider.getServedModel('test-model');
      expect(seen).toEqual(['Bearer token-from-sync-resolver']);
    } finally {
      server.close();
    }
  });

  it('async resolver failure degrades to no header (server decides), never a crash', async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers['authorization']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model', object: 'model' }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const provider = new VLlmProvider(
        `http://127.0.0.1:${port}`,
        undefined,
        async () => {
          throw new Error('refresh endpoint unreachable');
        },
        'cortex',
      );
      await provider.getServedModel('test-model');
      expect(seen).toEqual([undefined]);
    } finally {
      server.close();
    }
  });
});
