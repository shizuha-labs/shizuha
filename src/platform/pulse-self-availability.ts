/**
 * Report this seat's capacity signal to Pulse (AgentAvailability self-PATCH).
 *
 * Hive remains SoT for identity (model / execution method / enablement).
 * Bridges must pass `executionMethod` so Pulse can reject cross-provider
 * self-latches (e.g. claude-token-pool-exhausted from a non-Claude seat).
 */

export async function markPulseSelfAvailability(opts: {
  active: boolean;
  reason?: string;
  /** Hive execution_method for this seat (claude_code_server, codex_app_server, shizuha, …). */
  executionMethod?: string;
  platformUrl?: string;
  accessToken?: string;
  logPrefix?: string;
}): Promise<void> {
  const platformBase = (
    opts.platformUrl
    || process.env['BACKEND_URL']
    || process.env['SHIZUHA_PLATFORM_URL']
    || ''
  ).replace(/\/$/, '');
  if (!platformBase) return;

  let token = opts.accessToken || process.env['AGENT_ACCESS_TOKEN'] || '';
  if (!token) {
    try {
      const { AgentTokenManager } = await import('../auth/agent-token-manager.js');
      const tm = new AgentTokenManager({
        agentUsername: process.env['AGENT_USERNAME'] || 'agent',
        agentEmail: process.env['AGENT_EMAIL'] || undefined,
        platformUrl: platformBase,
      });
      token = (await tm.getToken()) ?? '';
    } catch {
      return;
    }
  }
  if (!token) return;

  const method = (opts.executionMethod || process.env['EXECUTION_METHOD'] || '').trim();
  const url = `${platformBase}/pulse/api/agent-availability/self/`;
  const body = {
    active: opts.active,
    reason: opts.reason ?? '',
    ...(method ? { execution_method: method } : {}),
  };
  const prefix = opts.logPrefix ?? 'pulse-availability';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(method ? { 'X-Shizuha-Execution-Method': method } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        console.log(`[${prefix}] AgentAvailability set active=${opts.active}`);
        return;
      }
      console.warn(`[${prefix}] AgentAvailability PATCH returned ${res.status} (attempt ${attempt + 1}/3)`);
    } catch (err) {
      console.warn(
        `[${prefix}] AgentAvailability PATCH failed (attempt ${attempt + 1}/3): ${(err as Error).message}`,
      );
    }
  }
}
