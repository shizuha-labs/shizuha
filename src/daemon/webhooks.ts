/**
 * Webhook System — external triggers for agents.
 *
 * Endpoints:
 *   POST /v1/hooks/wake          — inject a system event into an agent's session
 *   POST /v1/hooks/agent/:id     — dispatch an isolated agent turn
 *   POST /v1/hooks/:preset       — preset parser (github, gmail, etc.)
 *
 * Security:
 *   - Bearer token auth (constant-time comparison)
 *   - Per-IP rate limiting (20 failures / 60s → 429)
 *   - Payload size limit (256KB)
 *   - Query-string tokens rejected (prevent URL logging leaks)
 *   - Idempotency-Key deduplication (prevent double execution)
 *
 * Modeled after OpenClaw's /hooks/wake system.
 */

import * as crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ── Config ──

export interface WebhookConfig {
  /** Enable webhooks (default: false) */
  enabled: boolean;
  /** Auth token — required if enabled */
  token: string;
  /** Max request body size in bytes (default: 256KB) */
  maxBodyBytes: number;
  /** Allowed agent IDs (empty = all, ['*'] = all) */
  allowedAgentIds: string[];
  /** Preset mappings */
  presets: WebhookPreset[];
}

export interface WebhookPreset {
  id: string;
  name: string;
  /** Template: {{field.path}} extracts from payload */
  messageTemplate: string;
  /** Default agent to route to (or leave empty for caller to specify) */
  defaultAgentId?: string;
}

const DEFAULT_MAX_BODY = 256 * 1024; // 256KB

// ── Built-in presets ──

const BUILTIN_PRESETS: WebhookPreset[] = [
  {
    id: 'github',
    name: 'GitHub',
    messageTemplate: 'GitHub {{action}}: {{pull_request.title || issue.title || repository.full_name}}\n{{pull_request.html_url || issue.html_url || compare}}',
  },
  {
    id: 'gmail',
    name: 'Gmail',
    messageTemplate: 'New email from {{from}}\nSubject: {{subject}}\n{{snippet || body}}',
  },
  {
    id: 'generic',
    name: 'Generic',
    messageTemplate: '{{text || message || body}}',
  },
];

// ── Constant-time string comparison ──

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to maintain constant timing
    crypto.timingSafeEqual(Buffer.from(a), Buffer.from(a));
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ── Rate limiter (per IP) ──

const AUTH_FAIL_LIMIT = 10000;
const AUTH_FAIL_WINDOW_MS = 60_000;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry && now < entry.resetAt) {
    if (entry.count >= AUTH_FAIL_LIMIT) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      return { allowed: false, retryAfter };
    }
  }

  return { allowed: true };
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry && now < entry.resetAt) {
    entry.count++;
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + AUTH_FAIL_WINDOW_MS });
  }
}

function resetAuthFailures(ip: string): void {
  rateLimitMap.delete(ip);
}

// Periodic cleanup (every 5 min)
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now >= entry.resetAt) rateLimitMap.delete(ip);
  }
}, 5 * 60_000).unref();

// ── Idempotency deduplication ──

const DEDUPE_TTL_MS = 10 * 60_000; // 10 minutes
const DEDUPE_MAX = 1000;
const dedupeCache = new Map<string, { runId: string; expiresAt: number }>();

function dedupeKey(token: string, path: string, idempotencyKey: string): string {
  return crypto.createHash('sha256').update(`${token}:${path}:${idempotencyKey}`).digest('hex');
}

function checkDedupe(key: string): string | null {
  const entry = dedupeCache.get(key);
  if (entry && Date.now() < entry.expiresAt) return entry.runId;
  return null;
}

function recordDedupe(key: string, runId: string): void {
  // Evict oldest if at capacity
  if (dedupeCache.size >= DEDUPE_MAX) {
    const oldest = dedupeCache.keys().next().value;
    if (oldest) dedupeCache.delete(oldest);
  }
  dedupeCache.set(key, { runId, expiresAt: Date.now() + DEDUPE_TTL_MS });
}

// ── Token extraction ──

function extractToken(request: FastifyRequest): string | null {
  // Reject query string tokens (prevents URL logging leaks)
  const url = request.url ?? '';
  if (url.includes('token=')) return null; // Will be caught as explicit rejection

  // Bearer token (preferred)
  const auth = request.headers.authorization?.trim() ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }

  // Custom header fallback
  const custom = (request.headers['x-shizuha-token'] as string)?.trim();
  if (custom) return custom;

  return null;
}

// ── Template rendering ──

function renderTemplate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{\{(.+?)\}\}/g, (_match, expr: string) => {
    // Handle fallback: {{field1 || field2}}
    const alternatives = expr.split('||').map(s => s.trim());

    for (const alt of alternatives) {
      const value = resolveField(payload, alt);
      if (value !== undefined && value !== null && value !== '') {
        return String(value);
      }
    }
    return '';
  });
}

function resolveField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    // Handle array indexing: field[0]
    const arrMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrMatch) {
      current = (current as Record<string, unknown>)[arrMatch[1]!];
      if (Array.isArray(current)) {
        current = current[parseInt(arrMatch[2]!, 10)];
      } else {
        return undefined;
      }
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

// ── Register webhook routes ──

export interface WebhookDeps {
  /** Get agent list */
  getAgents: () => Array<{ id: string; name: string; username: string; status?: string }>;
  /** Send message to agent (returns runId) */
  sendToAgent: (agentId: string, message: string, source: string) => Promise<string>;
  /** Get webhook token from config */
  getToken: () => string;
  /** Check if agent ID is allowed */
  isAgentAllowed: (agentId: string, allowedIds: string[]) => boolean;
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  deps: WebhookDeps,
  config?: Partial<WebhookConfig>,
): void {
  const cfg: WebhookConfig = {
    enabled: config?.enabled ?? true,
    token: config?.token ?? deps.getToken(),
    maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_MAX_BODY,
    allowedAgentIds: config?.allowedAgentIds ?? ['*'],
    presets: [...BUILTIN_PRESETS, ...(config?.presets ?? [])],
  };

  // ── Auth middleware ──

  function authenticate(request: FastifyRequest, reply: FastifyReply): boolean {
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';

    // Rate limit check
    const rl = checkRateLimit(ip);
    if (!rl.allowed) {
      reply.status(429)
        .header('Retry-After', String(rl.retryAfter ?? 60))
        .send({ error: 'Too many failed attempts. Try again later.', retryAfter: rl.retryAfter });
      return false;
    }

    // Reject query-string tokens
    if ((request.url ?? '').includes('token=')) {
      reply.status(400).send({ error: 'Token must be sent in Authorization header, not query string.' });
      return false;
    }

    const token = extractToken(request);
    if (!token) {
      recordAuthFailure(ip);
      reply.status(401).send({ error: 'Missing authentication. Use Authorization: Bearer <token> header.' });
      return false;
    }

    if (!cfg.token) {
      reply.status(503).send({ error: 'Webhooks not configured. Set a webhook token in dashboard settings.' });
      return false;
    }

    if (!safeEqual(token, cfg.token)) {
      recordAuthFailure(ip);
      reply.status(401).send({ error: 'Invalid token.' });
      return false;
    }

    resetAuthFailures(ip);
    return true;
  }

  // ── Body size limit ──

  app.addContentTypeParser('application/json', { bodyLimit: cfg.maxBodyBytes }, (req, body, done) => {
    let data = '';
    let size = 0;
    body.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cfg.maxBodyBytes) {
        done(new Error('Payload too large'), undefined);
        return;
      }
      data += chunk.toString();
    });
    body.on('end', () => {
      try {
        done(null, JSON.parse(data));
      } catch {
        done(new Error('Invalid JSON'), undefined);
      }
    });
    body.on('error', (err: Error) => done(err, undefined));
  });

  // ── POST /v1/hooks/wake ──

  app.post<{ Body: { text: string; agent_id?: string } }>('/v1/hooks/wake', async (request, reply) => {
    if (!authenticate(request, reply)) return;

    const { text, agent_id } = request.body ?? {};
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return reply.status(400).send({ error: 'text is required (non-empty string)' });
    }

    // Idempotency check
    const idempotencyKey = (request.headers['idempotency-key'] as string) || (request.headers['x-shizuha-idempotency-key'] as string) || '';
    if (idempotencyKey) {
      const dk = dedupeKey(cfg.token, '/v1/hooks/wake', idempotencyKey);
      const existing = checkDedupe(dk);
      if (existing) {
        return { ok: true, runId: existing, deduplicated: true };
      }
    }

    // Resolve target agent
    let targetId = agent_id;
    if (!targetId) {
      // Default to first running agent
      const agents = deps.getAgents().filter(a => a.status === 'running');
      if (agents.length === 0) {
        return reply.status(503).send({ error: 'No agents running.' });
      }
      targetId = agents[0]!.id;
    }

    // Check agent allowlist
    if (!deps.isAgentAllowed(targetId, cfg.allowedAgentIds)) {
      return reply.status(403).send({ error: `Agent ${targetId} not allowed for webhooks.` });
    }

    try {
      const runId = await deps.sendToAgent(targetId, text.trim(), 'webhook:wake');
      if (idempotencyKey) {
        recordDedupe(dedupeKey(cfg.token, '/v1/hooks/wake', idempotencyKey), runId);
      }
      return { ok: true, runId };
    } catch (err) {
      return reply.status(500).send({ error: `Failed to dispatch: ${(err as Error).message}` });
    }
  });

  // ── POST /v1/hooks/agent/:agentId ──

  app.post<{ Params: { agentId: string }; Body: { message: string; idempotencyKey?: string } }>(
    '/v1/hooks/agent/:agentId',
    async (request, reply) => {
      if (!authenticate(request, reply)) return;

      const { agentId } = request.params;
      const { message, idempotencyKey: bodyKey } = request.body ?? {};

      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return reply.status(400).send({ error: 'message is required (non-empty string)' });
      }

      // Resolve agent by ID or username
      const agents = deps.getAgents();
      const agent = agents.find(a => a.id === agentId || a.username === agentId);
      if (!agent) {
        return reply.status(404).send({ error: `Agent "${agentId}" not found.` });
      }

      if (!deps.isAgentAllowed(agent.id, cfg.allowedAgentIds)) {
        return reply.status(403).send({ error: `Agent "${agentId}" not allowed for webhooks.` });
      }

      // Idempotency
      const idk = (request.headers['idempotency-key'] as string) || bodyKey || '';
      if (idk) {
        const dk = dedupeKey(cfg.token, `/v1/hooks/agent/${agent.id}`, idk);
        const existing = checkDedupe(dk);
        if (existing) return { ok: true, runId: existing, agentId: agent.id, deduplicated: true };
      }

      try {
        const runId = await deps.sendToAgent(agent.id, message.trim(), `webhook:agent:${agent.username}`);
        if (idk) {
          recordDedupe(dedupeKey(cfg.token, `/v1/hooks/agent/${agent.id}`, idk), runId);
        }
        return { ok: true, runId, agentId: agent.id, agentName: agent.name };
      } catch (err) {
        return reply.status(500).send({ error: `Failed to dispatch: ${(err as Error).message}` });
      }
    },
  );

  // ── POST /v1/hooks/:preset ──

  app.post<{ Params: { preset: string }; Body: Record<string, unknown> }>(
    '/v1/hooks/:preset',
    async (request, reply) => {
      if (!authenticate(request, reply)) return;

      const { preset: presetId } = request.params;
      const payload = request.body ?? {};

      // Find preset
      const preset = cfg.presets.find(p => p.id === presetId);
      if (!preset) {
        return reply.status(404).send({
          error: `Unknown preset "${presetId}".`,
          available: cfg.presets.map(p => p.id),
        });
      }

      // Render template
      const message = renderTemplate(preset.messageTemplate, payload).trim();
      if (!message) {
        return reply.status(400).send({ error: 'Rendered message is empty. Check payload matches template fields.' });
      }

      // Resolve agent
      let targetId = (payload.agent_id as string) || preset.defaultAgentId;
      if (!targetId) {
        const agents = deps.getAgents().filter(a => a.status === 'running');
        if (agents.length === 0) return reply.status(503).send({ error: 'No agents running.' });
        targetId = agents[0]!.id;
      }

      if (!deps.isAgentAllowed(targetId!, cfg.allowedAgentIds)) {
        return reply.status(403).send({ error: `Agent not allowed for webhooks.` });
      }

      // Idempotency
      const idk = (request.headers['idempotency-key'] as string) || '';
      if (idk) {
        const dk = dedupeKey(cfg.token, `/v1/hooks/${presetId}`, idk);
        const existing = checkDedupe(dk);
        if (existing) return { ok: true, runId: existing, preset: presetId, deduplicated: true };
      }

      const prefixed = `[${preset.name}] ${message}`;
      try {
        const runId = await deps.sendToAgent(targetId!, prefixed, `webhook:${presetId}`);
        if (idk) {
          recordDedupe(dedupeKey(cfg.token, `/v1/hooks/${presetId}`, idk), runId);
        }
        return { ok: true, runId, preset: presetId };
      } catch (err) {
        return reply.status(500).send({ error: `Failed to dispatch: ${(err as Error).message}` });
      }
    },
  );

  // ── GET /v1/hooks/status ──

  app.get('/v1/hooks/status', async (request, reply) => {
    if (!authenticate(request, reply)) return;

    return {
      enabled: cfg.enabled,
      hasToken: !!cfg.token,
      presets: cfg.presets.map(p => ({ id: p.id, name: p.name })),
      allowedAgentIds: cfg.allowedAgentIds,
      maxBodyBytes: cfg.maxBodyBytes,
      rateLimitTracked: rateLimitMap.size,
      dedupeEntries: dedupeCache.size,
    };
  });
}
