/**
 * Platform API client — talks to shizuha-agent REST API to discover agents
 * and manage runner tokens.
 */

import type { AgentInfo } from './types.js';
import { applyEffectiveCapabilitiesToAgent } from '../platform/effective-capabilities.js';
import { logger } from '../utils/logger.js';

export class PlatformClient {
  private baseUrl: string;
  private accessToken: string;

  constructor(baseUrl: string, accessToken: string) {
    // Normalize: ensure /agent/api prefix
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.accessToken = accessToken;
  }

  private apiUrl(path: string): string {
    // If baseUrl already includes /agent/api, use directly
    if (this.baseUrl.includes('/agent/api')) {
      return `${this.baseUrl}${path}`;
    }
    return `${this.baseUrl}/agent/api${path}`;
  }

  private rootUrl(path: string): string {
    const root = this.baseUrl.replace(/\/(?:agent|id|admin)\/api\/?$/, '');
    return `${root}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  private async fetch(
    url: string,
    init?: RequestInit,
    options: { omitBearer?: boolean } = {},
  ): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(10_000),
      headers: {
        'Content-Type': 'application/json',
        ...(options.omitBearer ? {} : { Authorization: `Bearer ${this.accessToken}` }),
        ...init?.headers,
      },
    });
    return response;
  }

  /**
   * Discover agents assigned to the current user.
   * Returns all active agents the user has access to.
   */
  async discoverAgents(): Promise<AgentInfo[]> {
    const url = this.apiUrl('/agents/?page_size=100&status=active');
    const response = await this.fetch(url);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to discover agents: ${response.status} ${text}`);
    }

    const data = await response.json() as {
      results: Array<{
        id: string;
        name: string;
        username: string;
        email: string;
        role_name: string | null;
        execution_method: string;
        runtime_environment: string;
        status: string;
        model_overrides: Record<string, string>;
        model_fallbacks?: Array<{ method: string; model: string }>;
        enabled_mcp_servers: Array<{
          name: string;
          slug: string;
        }>;
        personality_traits: Record<string, string>;
        context_prompt: string;
        skills: string[];
        effective_capabilities?: unknown;
      }>;
    };

    return data.results.map((a) => {
      const legacyAgent: AgentInfo = {
        // Identity (always used)
        id: a.id,
        name: a.name,
        username: a.username,
        email: a.email,
        role: a.role_name,
        status: a.status as 'active' | 'paused' | 'disabled',

        // Platform runtime hints (deprecated — fallback only when no local agent.toml)
        executionMethod: a.execution_method || undefined,
        runtimeEnvironment: (a.runtime_environment || undefined) as AgentInfo['runtimeEnvironment'],
        modelOverrides: Object.keys(a.model_overrides || {}).length > 0 ? a.model_overrides : undefined,
        modelFallbacks: a.model_fallbacks?.length ? a.model_fallbacks : undefined,
        contextPrompt: a.context_prompt || undefined,

        // Capabilities (legacy compatibility fallback unless Hive effective_capabilities is valid)
        mcpServers: (a.enabled_mcp_servers || []).map((s) => ({
          name: s.name,
          slug: s.slug,
          command: '',
          args: [],
          env: {},
          transportType: 'stdio',
        })),
        personalityTraits: a.personality_traits || {},
        skills: a.skills || [],
      };
      if (a.effective_capabilities) {
        const applied = applyEffectiveCapabilitiesToAgent(legacyAgent, a.effective_capabilities);
        if (!applied.report.applied) {
          logger.warn({ agent: a.username, diagnostics: applied.report.diagnostics }, 'Ignoring invalid inline Hive effective_capabilities payload; using legacy agent capability fields');
        }
        return applied.agent;
      }
      return legacyAgent;
    });
  }

  /**
   * Fetch the Hive-resolved runtime capability read model for one agent.
   * Returns null for absent/not-yet-rolled endpoints so callers can keep legacy
   * compatibility fallback without treating migration gaps as daemon failures.
   *
   * Takes the DAEMON AGENT ID (agents.json `id`, e.g. "7ddaf1a7-…"), not the
   * username — Hive resolves runtime agents via get_runtime_agent(), which
   * matches only `id` (fleet/runtime_fleet.py). The route is Hive's real
   * fleet API (fleet/urls.py: v1/fleet/agents/<id>/effective-capabilities).
   * The previous '/api/fleet/runtime/capabilities/<user>/effective' path never
   * existed anywhere: at the domain root it fell through the ingress to the
   * home SPA, so EVERY refresh failed with "Unexpected token '<' … <!DOCTYPE"
   * and agents silently kept legacy/last-valid capability config (2026-07-02
   * handover finding #3).
   */
  async getEffectiveCapabilities(agentId: string): Promise<unknown | null> {
    const path = `/hive/api/v1/fleet/agents/${encodeURIComponent(agentId)}/effective-capabilities`;
    const daemonId = process.env['SHIZUHA_DAEMON_ID'] || '';
    const daemonToken = process.env['SHIZUHA_DAEMON_LINK_TOKEN'] || '';
    const daemonHeaders: Record<string, string> = {};
    if (daemonId && daemonToken) {
      daemonHeaders['X-Hive-Daemon-Id'] = daemonId;
      daemonHeaders['X-Hive-Daemon-Token'] = daemonToken;
    }
    const daemonAuthenticated = Boolean(daemonId && daemonToken);
    const response = await this.fetch(
      this.rootUrl(path),
      {
        signal: AbortSignal.timeout(5000),
        headers: daemonHeaders,
      },
      // DRF authenticates a presented bearer before endpoint-level daemon
      // headers. A long-running daemon's user JWT can expire while its scoped
      // daemon credential remains valid; sending both makes the valid request
      // fail 403 and freezes capability refresh fleet-wide.
      { omitBearer: daemonAuthenticated },
    );
    if (response.status === 404 || response.status === 405) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to fetch effective capabilities for ${agentId}: ${response.status} ${text}`);
    }
    const data = await response.json() as unknown;
    if (data && typeof data === 'object' && !Array.isArray(data) && 'effective_capabilities' in data) {
      return (data as { effective_capabilities?: unknown }).effective_capabilities ?? null;
    }
    return data;
  }

  /**
   * PLAT-4112 Guard 2: fetch the Hive FleetAgent row (model/method/fallbacks)
   * for one agent. Returns null if the agent is not found or the endpoint is
   * not yet available. The reconcile loop uses this to detect SSOT drift that
   * daemon-link may have missed.
   */
  async getFleetAgent(agentId: string, outerSignal?: AbortSignal): Promise<{
    model?: string;
    executionMethod?: string;
    modelFallbacks?: Array<{ method: string; model: string }>;
    modelOverrides?: Record<string, string>;
    reasoningEffort?: string;
  } | null> {
    const path = `/hive/api/v1/fleet/agents/${encodeURIComponent(agentId)}/runtime-lane`;
    const daemonId = process.env['SHIZUHA_DAEMON_ID'] || '';
    const daemonToken = process.env['SHIZUHA_DAEMON_LINK_TOKEN'] || '';
    const daemonHeaders: Record<string, string> = {};
    if (daemonId && daemonToken) {
      daemonHeaders['X-Hive-Daemon-Id'] = daemonId;
      daemonHeaders['X-Hive-Daemon-Token'] = daemonToken;
    }
    try {
      const requestSignal = AbortSignal.timeout(5000);
      const response = await this.fetch(
        this.rootUrl(path),
        {
          signal: outerSignal ? AbortSignal.any([outerSignal, requestSignal]) : requestSignal,
          headers: daemonHeaders,
        },
        // A retained user JWT can expire while the scoped daemon credential
        // remains valid. DRF rejects the expired bearer before the view can
        // authorize daemon headers, so daemon-authenticated reads must omit it.
        { omitBearer: Boolean(daemonId && daemonToken) },
      );
      if (response.status === 404 || response.status === 405) return null;
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Failed to fetch runtime lane for ${agentId}: ${response.status} ${text}`);
      }
      const data = await response.json() as Record<string, unknown>;
      return {
        model: typeof data.model === 'string' ? data.model : undefined,
        executionMethod: typeof data.execution_method === 'string' ? data.execution_method : undefined,
        modelFallbacks: Array.isArray(data.model_fallbacks) ? data.model_fallbacks as Array<{ method: string; model: string }> : undefined,
        modelOverrides: data.model_overrides && typeof data.model_overrides === 'object' ? data.model_overrides as Record<string, string> : undefined,
        reasoningEffort: typeof data.reasoning_effort === 'string' ? data.reasoning_effort : undefined,
      };
    } catch (err) {
      logger.error({ agentId, err: (err as Error).message }, 'getFleetAgent failed');
      throw err;
    }
  }

  // updateAgent / *RunnerToken / getRunnerStatus methods removed
  // 2026-04-20 along with the shizuha-agent service retirement. All agent
  // roster / runner-token plumbing was part of the Django side that's now
  // gone; the daemon reads agents from ~/.shizuha/agents.json directly.
}
