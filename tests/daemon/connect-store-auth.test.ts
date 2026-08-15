import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/daemon/connect-store/auth.js';
import { ConnectStore } from '../../src/daemon/connect-store/sqlite.js';

describe('mini-Connect agent bootstrap identity reconciliation', () => {
  let dir: string;
  let store: ConnectStore;
  let auth: AuthService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-connect-auth-'));
    store = new ConnectStore(path.join(dir, 'connect.db'));
    auth = new AuthService(store, { keyPath: path.join(dir, 'connect-jwt.key') });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reuses the stable agent row when its username changes and remains idempotent', () => {
    const original = auth.ensureAgentUser({
      username: 'fumi-old',
      agentId: 'agent-fumi',
      email: 'old-fumi@shizuha.com',
      displayName: 'Fumi Old',
      password: 'first-secret',
    });

    const renamed = auth.ensureAgentUser({
      username: 'fumi',
      agentId: 'agent-fumi',
      email: 'fumi@shizuha.com',
      displayName: 'Fumi',
      password: 'current-secret',
    });
    const replay = auth.ensureAgentUser({
      username: 'fumi',
      agentId: 'agent-fumi',
      email: 'fumi@shizuha.com',
      displayName: 'Fumi',
      password: 'current-secret',
    });

    expect(renamed.id).toBe(original.id);
    expect(replay.id).toBe(original.id);
    expect(store.listUsers()).toHaveLength(1);
    expect(store.getUserByUsername('fumi-old')).toBeNull();
    expect(store.getUserByAgentId('agent-fumi')).toMatchObject({
      id: original.id,
      username: 'fumi',
      email: 'fumi@shizuha.com',
      displayName: 'Fumi',
      isAgent: true,
      agentId: 'agent-fumi',
    });
    expect(auth.login('fumi', 'current-secret')?.user.id).toBe(original.id);
  });

  it('fails closed without rewriting either row when username and agent id identify different users', () => {
    const stableIdentity = auth.ensureAgentUser({
      username: 'fumi-old',
      agentId: 'agent-fumi',
      password: 'fumi-secret',
    });
    const usernameOwner = auth.ensureAgentUser({
      username: 'fumi',
      agentId: 'agent-other',
      password: 'other-secret',
    });

    expect(() => auth.ensureAgentUser({
      username: 'fumi',
      agentId: 'agent-fumi',
      password: 'fumi-secret',
    })).toThrow(
      'Cannot reconcile mini-Connect user "fumi": agent_id "agent-fumi" already belongs to "fumi-old"',
    );

    expect(store.listUsers()).toHaveLength(2);
    expect(store.getUserByAgentId('agent-fumi')).toMatchObject({
      id: stableIdentity.id,
      username: 'fumi-old',
    });
    expect(store.getUserByAgentId('agent-other')).toMatchObject({
      id: usernameOwner.id,
      username: 'fumi',
    });
  });
});
