import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/platform/connect-dm.js', () => ({
  sendConnectDm: vi.fn(async () => ({ ok: true, messageId: 'm1' })),
}));
vi.mock('../../src/daemon/agent-accounts.js', () => ({
  refreshDaemonAdminToken: vi.fn(async () => 'daemon-control-plane-token'),
}));

import { sendConnectDm } from '../../src/platform/connect-dm.js';
import { refreshDaemonAdminToken } from '../../src/daemon/agent-accounts.js';
import {
  ACCOUNT_RECONCILE_ANDON_RATE_LIMIT_MS,
  resetAgentAccountReconcileAndonStateForTests,
  sendAgentAccountReconcileFailureAndon,
} from '../../src/daemon/account-reconcile-andon.js';

describe('PLAT-4006 account reconcile fail-loud notifier', () => {
  beforeEach(() => {
    resetAgentAccountReconcileAndonStateForTests();
    vi.clearAllMocks();
    vi.mocked(sendConnectDm).mockResolvedValue({ ok: true, messageId: 'm1' });
    vi.mocked(refreshDaemonAdminToken).mockResolvedValue('daemon-control-plane-token');
  });

  const agent = {
    id: 'ni-id',
    name: 'Ni',
    username: 'ni',
    email: 'ni@agents.shizuha.io',
    team: 'platform',
    enabled: true,
  } as any;

  it('DMs the owning cluster manager when startup account reconcile/provisioning fails', async () => {
    const result = await sendAgentAccountReconcileFailureAndon({
      agent,
      platformUrl: 'http://platform.test',
      reason: 'account_provisioning_failed_after_retries',
      detail: 'ensureAgentAccount returned null',
      now: 1_000,
    });

    expect(result).toEqual({ sent: true, rateLimited: false });
    expect(refreshDaemonAdminToken).toHaveBeenCalledWith({ platformUrl: 'http://platform.test' });
    const sendOpts = vi.mocked(sendConnectDm).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sendOpts).toMatchObject({
      recipientUsername: 'ichi',
      platformUrl: 'http://platform.test',
      token: 'daemon-control-plane-token',
      content: expect.stringContaining('agent account password reconcile failed at startup'),
    });
    expect(sendOpts).not.toHaveProperty('senderPassword');
    expect(sendOpts).not.toHaveProperty('sender');
  });

  it('uses the daemon token instead of the affected drifted agent credential', async () => {
    const result = await sendAgentAccountReconcileFailureAndon({
      agent,
      platformUrl: 'http://platform.test',
      reason: 'fully_drifted_agent_login_failed',
      daemonToken: 'pre-resolved-daemon-token',
      now: 1_000,
    });

    expect(result).toEqual({ sent: true, rateLimited: false });
    expect(refreshDaemonAdminToken).not.toHaveBeenCalled();
    expect(sendConnectDm).toHaveBeenCalledWith(expect.objectContaining({
      recipientUsername: 'ichi',
      token: 'pre-resolved-daemon-token',
    }));
    const sendOpts = vi.mocked(sendConnectDm).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sendOpts).not.toHaveProperty('sender');
    expect(sendOpts).not.toHaveProperty('senderPassword');
  });

  it('fails loud locally without falling back to the affected agent if daemon token is unavailable', async () => {
    vi.mocked(refreshDaemonAdminToken).mockResolvedValueOnce(null);

    const result = await sendAgentAccountReconcileFailureAndon({
      agent,
      platformUrl: 'http://platform.test',
      reason: 'daemon_token_missing',
      now: 1_000,
    });

    expect(result).toMatchObject({
      sent: false,
      rateLimited: false,
      error: expect.stringContaining('daemon control-plane token unavailable'),
    });
    expect(sendConnectDm).not.toHaveBeenCalled();
  });

  it('rate-limits successful pages per agent/reason but clears the limit after send failure', async () => {
    await sendAgentAccountReconcileFailureAndon({ agent, platformUrl: 'http://platform.test', reason: 'same_reason', now: 1_000 });

    const rateLimited = await sendAgentAccountReconcileFailureAndon({ agent, platformUrl: 'http://platform.test', reason: 'same_reason', now: 2_000 });
    expect(rateLimited).toEqual({ sent: false, rateLimited: true });
    expect(sendConnectDm).toHaveBeenCalledTimes(1);

    await sendAgentAccountReconcileFailureAndon({
      agent,
      platformUrl: 'http://platform.test',
      reason: 'same_reason',
      now: 1_000 + ACCOUNT_RECONCILE_ANDON_RATE_LIMIT_MS + 1,
    });
    expect(sendConnectDm).toHaveBeenCalledTimes(2);

    vi.mocked(sendConnectDm).mockResolvedValueOnce({ ok: false, status: 503, error: 'connect down' });
    const failed = await sendAgentAccountReconcileFailureAndon({ agent, platformUrl: 'http://platform.test', reason: 'new_reason', now: 3_000 });
    expect(failed).toMatchObject({ sent: false, rateLimited: false, error: 'connect down' });

    vi.mocked(sendConnectDm).mockResolvedValueOnce({ ok: true, messageId: 'm2' });
    const retry = await sendAgentAccountReconcileFailureAndon({ agent, platformUrl: 'http://platform.test', reason: 'new_reason', now: 3_001 });
    expect(retry).toEqual({ sent: true, rateLimited: false });
    expect(sendConnectDm).toHaveBeenCalledTimes(4);
  });
});
