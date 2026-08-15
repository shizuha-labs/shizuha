import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/auth/broker-token.js', () => ({
  brokerPresent: vi.fn(() => true),
  fetchBrokerToken: vi.fn(),
}));

vi.mock('../../src/auth/credential-resolver.js', () => ({
  readAgentCredential: vi.fn(() => undefined),
}));

import { AgentTokenManager } from '../../src/auth/agent-token-manager.js';
import { fetchBrokerToken } from '../../src/auth/broker-token.js';

const mockFetchBrokerToken = vi.mocked(fetchBrokerToken);

describe('AgentTokenManager durable cache expiry', () => {
  let tokenDir: string;

  beforeEach(() => {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-token-manager-'));
    mockFetchBrokerToken.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tokenDir, { recursive: true, force: true });
  });

  it.each(['', 'not-a-date'])(
    'rejects legacy cache with invalid expiresAt %j and replaces it from the broker',
    async (expiresAt) => {
      fs.writeFileSync(
        path.join(tokenDir, 'token-zen.json'),
        JSON.stringify({
          accessToken: 'expired-durable-jwt',
          refreshToken: '',
          expiresAt,
          userId: 15,
          email: 'zen@shizuha.com',
          organizationId: 1,
          obtainedAt: '2026-07-19T08:25:58Z',
        }),
      );
      mockFetchBrokerToken.mockResolvedValue({
        accessToken: 'fresh-broker-jwt',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });

      const manager = new AgentTokenManager({
        agentUsername: 'zen',
        agentEmail: 'zen@shizuha.com',
        platformUrl: 'http://shizuha.test',
        tokenDir,
      });

      await expect(manager.getToken()).resolves.toBe('fresh-broker-jwt');
      expect(mockFetchBrokerToken).toHaveBeenCalledTimes(1);
      const persisted = JSON.parse(
        fs.readFileSync(path.join(tokenDir, 'token-zen.json'), 'utf8'),
      );
      expect(persisted.accessToken).toBe('fresh-broker-jwt');
      expect(Number.isFinite(new Date(persisted.expiresAt).getTime())).toBe(true);
    },
  );
});
