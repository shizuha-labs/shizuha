/**
 * Platform API client — talks to shizuha-agent REST API to discover agents
 * and manage runner tokens.
 */

import type { AgentInfo, RunnerToken } from './types.js';
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

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    const response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
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
      }>;
    };

    return data.results.map((a) => ({
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

      // Capabilities
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
    }));
  }

  /**
   * Update an agent's configuration on the platform.
   * Proxies PATCH to /agent/api/agents/{id}/.
   */
  async updateAgent(agentId: string, updates: Record<string, unknown>): Promise<Record<string, unknown>> {
    const url = this.apiUrl(`/agents/${agentId}/`);
    const response = await this.fetch(url, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to update agent: ${response.status} ${text}`);
    }

    return await response.json() as Record<string, unknown>;
  }

  /**
   * Get or create a runner token for an agent.
   * First checks for existing tokens, creates one if none exist.
   */
  async ensureRunnerToken(agentId: string): Promise<RunnerToken> {
    // Check existing tokens
    const listUrl = this.apiUrl(`/runners/tokens/?agent_id=${agentId}`);
    const listResponse = await this.fetch(listUrl);

    if (listResponse.ok) {
      const tokens = await listResponse.json() as Array<{
        id: string;
        token_prefix: string;
        agent: string;
        agent_name: string;
        scopes: string[];
        expires_at: string | null;
        revoked: boolean;
      }>;

      // Find an active (non-revoked) token
      const active = tokens.find((t) => !t.revoked);
      if (active) {
        logger.info({ agentId, prefix: active.token_prefix }, 'Using existing runner token');
        return {
          id: active.id,
          token: '', // Can't retrieve raw token for existing tokens
          tokenPrefix: active.token_prefix,
          agentId: active.agent,
          agentName: active.agent_name,
          scopes: active.scopes,
          expiresAt: active.expires_at,
        };
      }
    }

    return this.createRunnerToken(agentId);
  }

  /**
   * Always create a fresh runner token (returns raw token).
   */
  async createRunnerToken(agentId: string): Promise<RunnerToken> {
    const createUrl = this.apiUrl('/runners/tokens/');
    const createResponse = await this.fetch(createUrl, {
      method: 'POST',
      body: JSON.stringify({
        agent_id: agentId,
        name: `shizuha-up-${Date.now()}`,
        scopes: ['chat', 'execute', 'mcp'],
      }),
    });

    if (!createResponse.ok) {
      const text = await createResponse.text().catch(() => '');
      throw new Error(`Failed to create runner token: ${createResponse.status} ${text}`);
    }

    // POST returns { token: "sza_...", token_record: { id, agent, ... }, warning: "..." }
    const created = await createResponse.json() as {
      token: string;
      token_record: {
        id: string;
        token_prefix: string;
        agent: string;
        agent_name: string;
        scopes: string[];
        expires_at: string | null;
      };
    };

    logger.info({ agentId, prefix: created.token_record.token_prefix }, 'Created new runner token');

    return {
      id: created.token_record.id,
      token: created.token,
      tokenPrefix: created.token_record.token_prefix,
      agentId: created.token_record.agent,
      agentName: created.token_record.agent_name,
      scopes: created.token_record.scopes,
      expiresAt: created.token_record.expires_at,
    };
  }

  /**
   * Revoke a runner token by ID.
   */
  async revokeRunnerToken(tokenId: string): Promise<void> {
    const url = this.apiUrl(`/runners/tokens/${tokenId}/`);
    await this.fetch(url, { method: 'DELETE' });
  }

  /**
   * Check connected runners status.
   */
  async getRunnerStatus(): Promise<Array<{
    agentId: string;
    agentName: string;
    tokenPrefix: string;
    connectedAt: number;
    runnerVersion: string;
  }>> {
    const url = this.apiUrl('/runners/status/');
    const response = await this.fetch(url);

    if (!response.ok) return [];

    const data = await response.json() as {
      runners: Array<{
        agent_id: string;
        agent_name: string;
        token_prefix: string;
        connected_at: string;
        runner_version: string;
      }>;
    };

    return (data.runners || []).map((r) => ({
      agentId: r.agent_id,
      agentName: r.agent_name,
      tokenPrefix: r.token_prefix,
      connectedAt: parseInt(r.connected_at, 10),
      runnerVersion: r.runner_version,
    }));
  }
}
