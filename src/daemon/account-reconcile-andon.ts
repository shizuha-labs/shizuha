import type { AgentInfo } from './types.js';
import { resolveClusterManagerUsername } from './auto-andon.js';
import { refreshDaemonAdminToken } from './agent-accounts.js';
import { sendConnectDm } from '../platform/connect-dm.js';
import { recordAgentAccountReconcileAndonOutcome } from '../metrics/registry.js';

export const ACCOUNT_RECONCILE_ANDON_RATE_LIMIT_MS = 6 * 60 * 60 * 1000;

const lastSentByAgentReason = new Map<string, number>();

export interface AgentAccountReconcileAndonResult {
  sent: boolean;
  rateLimited: boolean;
  error?: string;
}

export function resetAgentAccountReconcileAndonStateForTests(): void {
  lastSentByAgentReason.clear();
}

function rateLimitKey(agent: AgentInfo, reason: string): string {
  return `${agent.id}:${reason}`;
}

function platformBase(override?: string): string {
  return override || process.env['SHIZUHA_PLATFORM_URL'] || process.env['BACKEND_URL'] || '';
}

function andonContent(agent: AgentInfo, manager: string, reason: string, detail?: string): string {
  return [
    '## 🔴 ANDON — agent account password reconcile failed at startup',
    `- Agent: ${agent.name} (@${agent.username})`,
    `- Team: ${agent.team || 'unknown'} → manager @${manager}`,
    `- Reason: ${reason}`,
    detail ? `- Detail: ${detail}` : null,
    '',
    'Invariant: daemon-managed agent start must reconcile shizuha-id account password to the injected AGENT_PASSWORD before spawning the runtime. A failure here means the agent can start without AGENT_ACCESS_TOKEN/Connect auth and may fall into empty-turn thrash. This DM is rate-limited per agent/reason for 6h; send/rate-limit/failure outcomes are exported on /metrics.',
  ].filter(Boolean).join('\n');
}

export async function sendAgentAccountReconcileFailureAndon(opts: {
  agent: AgentInfo;
  platformUrl?: string;
  reason: string;
  detail?: string;
  now?: number;
  daemonToken?: string;
}): Promise<AgentAccountReconcileAndonResult> {
  const now = opts.now ?? Date.now();
  const key = rateLimitKey(opts.agent, opts.reason);
  const lastSent = lastSentByAgentReason.get(key);
  if (lastSent !== undefined && now - lastSent < ACCOUNT_RECONCILE_ANDON_RATE_LIMIT_MS) {
    recordAgentAccountReconcileAndonOutcome('rate_limited');
    return { sent: false, rateLimited: true };
  }
  lastSentByAgentReason.set(key, now);

  const manager = resolveClusterManagerUsername(opts.agent.team);
  const base = platformBase(opts.platformUrl);
  try {
    const daemonToken = opts.daemonToken || (
      base ? await refreshDaemonAdminToken({ platformUrl: base }) : null
    );
    if (!daemonToken) {
      lastSentByAgentReason.delete(key);
      recordAgentAccountReconcileAndonOutcome('failed');
      return {
        sent: false,
        rateLimited: false,
        error: 'daemon control-plane token unavailable for account reconcile ANDON',
      };
    }
    const result = await sendConnectDm({
      recipientUsername: manager,
      content: andonContent(opts.agent, manager, opts.reason, opts.detail),
      platformUrl: base,
      // This notifier must not authenticate as the affected agent: the failure
      // mode is precisely that shizuha-id rejects that agent's injected
      // canonical password. Use the daemon/platform control-plane token instead
      // so the ANDON path is independent of the broken account being reported.
      token: daemonToken,
      timeoutMs: 10_000,
    });
    if (!result.ok) {
      lastSentByAgentReason.delete(key);
      recordAgentAccountReconcileAndonOutcome('failed');
      return {
        sent: false,
        rateLimited: false,
        error: result.error || `Connect DM failed with status ${result.status ?? 'unknown'}`,
      };
    }
    recordAgentAccountReconcileAndonOutcome('sent');
    return { sent: true, rateLimited: false };
  } catch (err) {
    lastSentByAgentReason.delete(key);
    recordAgentAccountReconcileAndonOutcome('failed');
    return { sent: false, rateLimited: false, error: (err as Error).message };
  }
}
