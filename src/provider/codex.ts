/**
 * CodexProvider — uses the OpenAI Responses API via chatgpt.com/backend-api/codex.
 *
 * This provider enables gpt-5.x-codex models when authenticated through Codex CLI's
 * ChatGPT OAuth flow. Supports multi-account credential cycling:
 *   - Primary: ~/.codex/accounts/*.json (one file per email)
 *   - Fallback: ~/.codex/auth.json (single account)
 *
 * On 429 rate limit, automatically rotates to the next available account in the pool.
 * Short resets (≤30s) wait on the same account; longer resets trigger rotation.
 *
 * The ChatGPT backend requires:
 *   - Authorization: Bearer <access_token>
 *   - ChatGPT-Account-ID: <account_id>
 *   - instructions field (system prompt)
 *   - input as array (Responses API format)
 *   - store: false
 *   - stream: true
 */

import OpenAI from 'openai';
import type { Stream } from 'openai/streaming';
import type {
  ResponseStreamEvent,
  ResponseInputItem,
  ResponseCreateParamsStreaming,
  ResponseOutputMessage,
} from 'openai/resources/responses/responses';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLMProvider, ChatMessage, ChatOptions, StreamChunk, ChatContentBlock } from './types.js';
import { logger } from '../utils/logger.js';
import { readCodexAccounts, saveCodexAccount, updateCodexTokens } from '../config/credentials.js';
import type { CodexAccountEntry } from '../config/credentials.js';

/** Context windows — sourced from codex-rs/core/models.json */
const MODEL_CONTEXT: Record<string, number> = {
  'gpt-5.4': 272000,
  'gpt-5.3-codex': 272000,
  'gpt-5.3-codex-spark': 272000,
  'gpt-5.3-xhigh': 272000,
  'gpt-5.2-codex': 272000,
  'gpt-5.2': 272000,
  'gpt-5.1-codex-max': 272000,
  'gpt-5.1-codex': 272000,
  'gpt-5.1-codex-mini': 272000,
  'gpt-5.1': 272000,
  'gpt-5-codex': 272000,
  'gpt-5-codex-mini': 272000,
  'gpt-5': 272000,
  'gpt-oss-120b': 128000,
  'gpt-oss-20b': 128000,
};

/** Model capabilities — sourced from codex-rs/core/models.json */
interface ModelCapabilities {
  supportsReasoningSummaries: boolean;
  supportsParallelToolCalls: boolean;
  defaultReasoningLevel: 'low' | 'medium' | 'high' | 'xhigh' | null;
}

type SupportedReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

/** Model capabilities — synced from codex-rs/core/models.json (2026-03-09) */
const MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  'gpt-5.4': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: true,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.3-codex': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: true,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.3-codex-spark': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: true,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.2-codex': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: true,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.2': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: true,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.1-codex-max': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.1-codex': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.1-codex-mini': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5.1': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: true,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5-codex': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5-codex-mini': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
  'gpt-5': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
  'gpt-oss-120b': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
  'gpt-oss-20b': {
    supportsReasoningSummaries: true,
    supportsParallelToolCalls: false,
    defaultReasoningLevel: 'medium',
  },
};

/** Get the default reasoning/effort level for a codex model, or null if none. */
export function getCodexDefaultReasoning(model: string): string | null {
  return (MODEL_CAPABILITIES[model]?.defaultReasoningLevel) ?? null;
}

/** Returns true if this model is served by the Codex (ChatGPT backend) provider. */
export function isCodexModel(model: string): boolean {
  return model in MODEL_CONTEXT;
}

function getModelCapabilities(model: string): ModelCapabilities {
  return MODEL_CAPABILITIES[model] ?? {
    supportsReasoningSummaries: false,
    supportsParallelToolCalls: true,
    defaultReasoningLevel: null,
  };
}

/** Responses API accepts low|medium|high|xhigh; normalize Codex/TUI aliases safely. */
function normalizeReasoningEffort(effort: string | null | undefined): SupportedReasoningEffort {
  const level = String(effort ?? 'medium').toLowerCase();
  if (level === 'minimal' || level === 'low') return 'low';
  if (level === 'xhigh') return 'xhigh';
  if (level === 'high') return 'high';
  return 'medium';
}

function getCompletedAssistantMessageText(item: ResponseOutputMessage): string | undefined {
  const combined = item.content
    .filter((part): part is Extract<ResponseOutputMessage['content'][number], { type: 'output_text' }> => part.type === 'output_text')
    .map((part) => part.text)
    .join('');
  if (!combined.trim()) return undefined;
  return combined;
}

const CHATGPT_BASE_URL = process.env['CODEX_BASE_URL'] ?? 'https://chatgpt.com/backend-api/codex';
const REFRESH_URL = 'https://auth.openai.com/oauth/token';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

// Retry configuration (5xx and transport errors only — 429 uses rate limit tracking)
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_BASE_DELAY_MS = 200; // 200ms base
const MAX_RATELIMIT_WAIT_MS = 600000; // 10 minutes max wait for rate limit reset

/** Exponential backoff with ±10% jitter */
function backoffMs(attempt: number): number {
  if (attempt === 0) return RETRY_BASE_DELAY_MS;
  const exp = Math.pow(2, attempt - 1);
  const raw = RETRY_BASE_DELAY_MS * exp;
  const jitter = 0.9 + Math.random() * 0.2; // 0.9 to 1.1
  return Math.min(raw * jitter, 60000); // cap at 60s
}

// ─── Rate Limit Tracking (proactive, like codex-rs) ───────────────────────

interface RateLimitSnapshot {
  usedPercent: number;      // 0-100
  windowMinutes: number;
  resetAt: number | null;   // unix timestamp ms, or null
  updatedAt: number;        // when this snapshot was taken
}

class RateLimitTracker {
  private primary: RateLimitSnapshot | null = null;
  private secondary: RateLimitSnapshot | null = null;
  private lastRequestAt = 0;

  /** Parse rate limit headers from any HTTP response (success or error) */
  updateFromHeaders(headers: Record<string, string> | null | undefined): void {
    if (!headers) return;
    // Primary window
    const pUsed = headers['x-codex-primary-used-percent'];
    if (pUsed) {
      this.primary = {
        usedPercent: Number(pUsed) || 0,
        windowMinutes: Number(headers['x-codex-primary-window-minutes']) || 0,
        resetAt: headers['x-codex-primary-reset-at'] ? Number(headers['x-codex-primary-reset-at']) * 1000 : null,
        updatedAt: Date.now(),
      };
    }
    // Secondary window
    const sUsed = headers['x-codex-secondary-used-percent'];
    if (sUsed) {
      this.secondary = {
        usedPercent: Number(sUsed) || 0,
        windowMinutes: Number(headers['x-codex-secondary-window-minutes']) || 0,
        resetAt: headers['x-codex-secondary-reset-at'] ? Number(headers['x-codex-secondary-reset-at']) * 1000 : null,
        updatedAt: Date.now(),
      };
    }
  }

  /** Get the highest current usage percentage */
  get currentUsagePercent(): number {
    const now = Date.now();
    const staleMs = 15 * 60 * 1000; // 15 minutes
    let maxUsed = 0;
    if (this.primary && (now - this.primary.updatedAt) < staleMs) {
      maxUsed = Math.max(maxUsed, this.primary.usedPercent);
    }
    if (this.secondary && (now - this.secondary.updatedAt) < staleMs) {
      maxUsed = Math.max(maxUsed, this.secondary.usedPercent);
    }
    return maxUsed;
  }

  /** Get suggested delay before next request (proactive throttling) */
  getPreRequestDelay(): number {
    const usage = this.currentUsagePercent;
    // No throttling under 70%
    if (usage < 70) return 0;
    // Mild throttling 70-85%: 1s between requests
    if (usage < 85) return 1000;
    // Heavy throttling 85-95%: 5s between requests
    if (usage < 95) return 5000;
    // Critical >95%: 15s between requests
    return 15000;
  }

  /** Parse reset time from a 429 error response */
  parseResetFromError(err: InstanceType<typeof OpenAI.APIError>): number | null {
    // Update tracker from error headers
    this.updateFromHeaders(err.headers as Record<string, string> | null);
    // Check retry-after header
    const headers = err.headers;
    if (headers) {
      const retryAfter = headers['retry-after'] ?? headers['Retry-After'];
      if (retryAfter) {
        const secs = Number(retryAfter);
        if (!isNaN(secs) && secs > 0 && secs <= 600) return secs * 1000;
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
          const waitMs = date.getTime() - Date.now();
          if (waitMs > 0 && waitMs <= MAX_RATELIMIT_WAIT_MS) return waitMs;
        }
      }
      // x-codex reset headers
      const resetAt = headers['x-codex-primary-reset-at'] ?? headers['x-codex-secondary-reset-at'];
      if (resetAt) {
        const waitMs = Number(resetAt) * 1000 - Date.now();
        if (waitMs > 0 && waitMs <= MAX_RATELIMIT_WAIT_MS) return waitMs;
      }
    }
    // Error body resets_at
    try {
      const body = typeof err.error === 'object' && err.error !== null ? err.error as Record<string, unknown> : null;
      const errorObj = body?.error as Record<string, unknown> | undefined;
      const resetsAt = errorObj?.resets_at as number | undefined;
      if (resetsAt && typeof resetsAt === 'number') {
        const waitMs = (resetsAt * 1000) - Date.now();
        if (waitMs > 0 && waitMs <= MAX_RATELIMIT_WAIT_MS) return waitMs;
      }
    } catch { /* ignore parse errors */ }
    // Check tracked snapshots
    const now = Date.now();
    for (const snap of [this.primary, this.secondary]) {
      if (snap?.resetAt && snap.resetAt > now && (snap.resetAt - now) <= MAX_RATELIMIT_WAIT_MS) {
        return snap.resetAt - now;
      }
    }
    return null;
  }

  /** Record that a request was made */
  recordRequest(): void {
    this.lastRequestAt = Date.now();
  }

  /** Get time since last request in ms */
  get timeSinceLastRequest(): number {
    return this.lastRequestAt ? Date.now() - this.lastRequestAt : Infinity;
  }

  /** Log current rate limit status */
  logStatus(): void {
    if (this.primary || this.secondary) {
      logger.info({
        primaryUsed: this.primary?.usedPercent ?? 'n/a',
        secondaryUsed: this.secondary?.usedPercent ?? 'n/a',
        primaryReset: this.primary?.resetAt ? new Date(this.primary.resetAt).toISOString() : 'n/a',
      }, 'Rate limit status');
    }
  }
}

// Short reset threshold: if rate limit resets within this time, wait instead of rotating
const SHORT_RESET_THRESHOLD_MS = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Account Pool (multi-account credential cycling) ─────────────────────

interface CodexAccount {
  email: string;
  auth: CodexAuth;
  client: OpenAI;
  rateLimitTracker: RateLimitTracker;
  exhaustedUntil: number | null; // timestamp when rate limit resets, null = available
}

class CodexAccountPool {
  private accounts: CodexAccount[];
  private currentIdx: number = 0;

  constructor(auths: CodexAuth[]) {
    this.accounts = auths.map(auth => ({
      email: auth.email,
      auth,
      client: CodexAccountPool.createClient(auth),
      rateLimitTracker: new RateLimitTracker(),
      exhaustedUntil: null,
    }));
  }

  private static createClient(auth: CodexAuth): OpenAI {
    return new OpenAI({
      apiKey: auth.accessToken,
      baseURL: CHATGPT_BASE_URL,
      defaultHeaders: {
        'ChatGPT-Account-ID': auth.accountId,
      },
    });
  }

  /** Get the currently active account */
  current(): CodexAccount {
    return this.accounts[this.currentIdx]!;
  }

  /** Get current index (for external reference) */
  get currentIndex(): number {
    return this.currentIdx;
  }

  /** Number of accounts in pool */
  get size(): number {
    return this.accounts.length;
  }

  /** Get account at a specific index */
  accountAt(index: number): CodexAccount | undefined {
    return this.accounts[index];
  }

  /**
   * Rotate to next available account on 429.
   * Returns false if ALL accounts are exhausted.
   */
  rotateOnRateLimit(resetAtMs?: number): boolean {
    // Mark current account as exhausted
    this.accounts[this.currentIdx]!.exhaustedUntil = resetAtMs ?? (Date.now() + 600000);

    if (this.accounts.length === 1) return false;

    const now = Date.now();
    // Try each other account in round-robin order
    for (let i = 1; i < this.accounts.length; i++) {
      const idx = (this.currentIdx + i) % this.accounts.length;
      const account = this.accounts[idx]!;
      // Account is available if not exhausted, or if exhaustion has expired
      if (account.exhaustedUntil === null || account.exhaustedUntil <= now) {
        account.exhaustedUntil = null;
        this.currentIdx = idx;
        return true;
      }
    }
    return false; // all exhausted
  }

  /** Reload a specific account's tokens from disk */
  reloadAccount(index: number): boolean {
    const account = this.accounts[index];
    if (!account) return false;

    let fresh: CodexAuth | null = null;
    if (account.auth.authPath) {
      // Legacy: reload from ~/.codex/ file
      fresh = parseCodexAuthFile(account.auth.authPath);
    } else {
      // Shizuha credential store: reload from ~/.shizuha/credentials.json
      const entries = readCodexAccounts();
      const entry = entries.find((e) => e.email === account.auth.email);
      if (entry) fresh = entryToAuth(entry);
    }

    if (!fresh) return false;
    if (fresh.accessToken !== account.auth.accessToken) {
      account.auth = fresh;
      account.client = CodexAccountPool.createClient(fresh);
      return true;
    }
    return false;
  }

  /** Update a specific account's client after token refresh */
  refreshClient(index: number): void {
    const account = this.accounts[index];
    if (!account) return;
    account.client = CodexAccountPool.createClient(account.auth);
  }

  /** Get the earliest reset time across all exhausted accounts (for waiting) */
  earliestResetMs(): number | null {
    let earliest: number | null = null;
    for (const account of this.accounts) {
      if (account.exhaustedUntil !== null) {
        if (earliest === null || account.exhaustedUntil < earliest) {
          earliest = account.exhaustedUntil;
        }
      }
    }
    return earliest;
  }
}

interface CodexAuth {
  authMode: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  accountId: string;
  authPath: string;
}

/** Parse a Codex CLI auth JSON file into CodexAuth (read-only import from ~/.codex/) */
function parseCodexAuthFile(authPath: string): CodexAuth | null {
  try {
    const data = JSON.parse(fs.readFileSync(authPath, 'utf-8'));
    if (data?.auth_mode !== 'chatgpt') return null;
    const tokens = data.tokens;
    if (!tokens?.access_token || !tokens?.account_id) return null;
    return {
      authMode: data.auth_mode,
      email: data.email ?? tokens.account_id,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? '',
      accountId: tokens.account_id,
      authPath,
    };
  } catch {
    return null;
  }
}

/** Convert a credential store entry to CodexAuth */
function entryToAuth(entry: CodexAccountEntry): CodexAuth {
  return {
    authMode: 'chatgpt',
    email: entry.email,
    accessToken: entry.accessToken,
    refreshToken: entry.refreshToken,
    accountId: entry.accountId,
    authPath: '',  // managed by credential store, not a file
  };
}

/**
 * Read all Codex accounts. Priority:
 * 1. CODEX_API_KEY env var (gateway mode)
 * 2. ~/.shizuha/credentials.json → codex.accounts (own credential store)
 * 3. ~/.codex/accounts/*.json and ~/.codex/auth.json (read-only import from Codex CLI)
 *
 * Tokens discovered from ~/.codex/ are auto-persisted to ~/.shizuha/ so they
 * survive independently of Codex CLI (avoids refresh token rotation conflicts).
 */
function readAllCodexAccounts(): CodexAuth[] {
  // Gateway mode: CODEX_API_KEY env var provides auth (JWT swapped by gateway)
  const codexApiKey = process.env['CODEX_API_KEY'];
  if (codexApiKey) {
    logger.info('Using CODEX_API_KEY env var (gateway mode)');
    return [{
      authMode: 'chatgpt',
      email: 'gateway',
      accessToken: codexApiKey,
      refreshToken: '',
      accountId: 'gateway',
      authPath: '',
    }];
  }

  const accountFilter = process.env['CODEX_ACCOUNT_FILTER'];

  // Read from Shizuha credential store (~/.shizuha/credentials.json) — sole source of truth
  const storeAccounts = readCodexAccounts();
  let accounts: CodexAuth[] = storeAccounts.map(entryToAuth);

  // Filter to specific account if requested
  if (accountFilter && accounts.length > 0) {
    const filtered = accounts.filter((a) => a.email === accountFilter);
    if (filtered.length > 0) {
      accounts = filtered;
      logger.info({ email: accountFilter }, 'Codex account pool filtered to single account');
    } else {
      logger.warn({ filter: accountFilter, available: accounts.map((a) => a.email) }, 'CODEX_ACCOUNT_FILTER did not match any account');
    }
  }

  if (accounts.length > 0) {
    logger.info({ count: accounts.length, emails: accounts.map((a) => a.email) }, 'Loaded Codex account pool');
  }
  return accounts;
}

/** Refresh the access token using the refresh token */
async function refreshToken(auth: CodexAuth): Promise<string | null> {
  if (!auth.refreshToken) return null;
  try {
    const resp = await fetch(REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: auth.refreshToken,
        scope: 'openid profile email',
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as Record<string, unknown>;
    const newAccessToken = data.access_token as string;
    const newRefreshToken = data.refresh_token as string | undefined;

    // Persist refreshed tokens to ~/.shizuha/credentials.json
    try {
      updateCodexTokens(auth.email, newAccessToken, newRefreshToken);
    } catch { /* best effort */ }

    // Update in-memory auth object
    auth.accessToken = newAccessToken;
    if (newRefreshToken) auth.refreshToken = newRefreshToken;

    return newAccessToken;
  } catch {
    return null;
  }
}

/** Convert internal ChatMessage[] to Responses API input items + system prompt */
function toResponsesInput(
  messages: ChatMessage[],
  systemPrompt?: string,
): { instructions: string; input: ResponseInputItem[] } {
  const instructions = systemPrompt ?? 'You are a helpful coding assistant.';
  const input: ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue; // handled via instructions

    if (typeof msg.content === 'string') {
      if (msg.role === 'tool') {
        // Tool result message → function_call_output
        input.push({
          type: 'function_call_output',
          call_id: msg.toolCallId ?? '',
          output: msg.content,
        });
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        input.push({ role: msg.role, content: msg.content });
      }
      continue;
    }

    // Content blocks
    const blocks = msg.content as ChatContentBlock[];

    if (msg.role === 'assistant') {
      // Collect text parts and tool call parts
      const textParts: string[] = [];
      for (const b of blocks) {
        if (b.type === 'text') {
          textParts.push(b.text);
        } else if (b.type === 'tool_use') {
          // First, emit any accumulated text as an assistant message
          if (textParts.length) {
            input.push({ role: 'assistant', content: textParts.join('\n') });
            textParts.length = 0;
          }
          // Emit function_call item
          input.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: JSON.stringify(b.input),
          });
        } else if (b.type === 'reasoning') {
          // Only include reasoning items with encrypted_content AND valid rs_ IDs.
          // After compaction strips encryptedContent, sending just the `id` causes
          // a 404 because store:false means the API can't look up the response item.
          // Non-rs_ IDs (e.g. thinking_0 from Claude provider) are rejected with 400.
          if (!b.encryptedContent || !b.id?.startsWith('rs_')) continue;
          if (textParts.length) {
            input.push({ role: 'assistant', content: textParts.join('\n') });
            textParts.length = 0;
          }
          input.push({
            type: 'reasoning',
            id: b.id,
            summary: b.summary?.map((s) => ({ text: s.text, type: 'summary_text' as const })) ?? [],
            encrypted_content: b.encryptedContent,
          } as ResponseInputItem);
        }
      }
      // Remaining text
      if (textParts.length) {
        input.push({ role: 'assistant', content: textParts.join('\n') });
      }
    } else if (msg.role === 'user') {
      // User message may contain tool_result blocks and text
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: b.toolUseId,
            output: b.content,
          });
        } else if (b.type === 'text') {
          input.push({ role: 'user', content: b.text });
        }
      }
    }
  }

  return { instructions, input };
}

export class CodexProvider implements LLMProvider {
  name = 'codex';
  supportsTools = true;
  supportsNativeWebSearch = true;
  maxContextWindow = 272000;
  private pool: CodexAccountPool;

  constructor(auths: CodexAuth[]) {
    this.pool = new CodexAccountPool(auths);
  }

  /** Check if Codex OAuth auth is available */
  static isAvailable(): boolean {
    return readAllCodexAccounts().length > 0;
  }

  /** Create a CodexProvider from ~/.codex/accounts/ or ~/.codex/auth.json. */
  static create(): CodexProvider | null {
    const accounts = readAllCodexAccounts();
    if (accounts.length === 0) return null;
    return new CodexProvider(accounts);
  }

  /** Proactively refresh tokens that are expired or near expiry (< 5 min).
   *  Call after create() — updates pool clients with fresh tokens. */
  async refreshExpiredTokens(): Promise<void> {
    const REFRESH_THRESHOLD_S = 300; // 5 minutes
    for (let i = 0; i < this.pool.size; i++) {
      const account = this.pool.accountAt(i);
      if (!account) continue;
      try {
        const parts = account.auth.accessToken.split('.');
        if (parts.length < 2) continue;
        const raw = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
        const padLen = (4 - (raw.length % 4)) % 4;
        const payload = JSON.parse(Buffer.from(raw + '='.repeat(padLen), 'base64').toString());
        const exp = payload.exp as number | undefined;
        if (exp && (exp - Date.now() / 1000) < REFRESH_THRESHOLD_S) {
          logger.info({ email: account.email, expiresIn: Math.round(exp - Date.now() / 1000) }, 'Codex token expired/near expiry, refreshing...');
          const newToken = await refreshToken(account.auth);
          if (newToken) {
            this.pool.refreshClient(i);
            logger.info({ email: account.email }, 'Codex token refreshed proactively');
          } else {
            logger.warn({ email: account.email }, 'Codex proactive refresh failed — will retry on 401');
          }
        }
      } catch { /* JWT parse failed — skip, will refresh on 401 */ }
    }
  }

  async *chat(messages: ChatMessage[], options: ChatOptions): AsyncGenerator<StreamChunk> {
    this.maxContextWindow = MODEL_CONTEXT[options.model] ?? 272000;
    const STREAM_TIMEOUT_MS = parseInt(process.env['STREAM_TIMEOUT_MS'] || process.env['API_TIMEOUT_MS'] || '300000', 10); // 5 min inactivity
    // First-token timeout: how long to wait for the initial response from the API.
    // Much shorter than STREAM_TIMEOUT_MS since a hanging connection should fail fast.
    const FIRST_TOKEN_TIMEOUT_MS = parseInt(process.env['FIRST_TOKEN_TIMEOUT_MS'] || '60000', 10); // 60s

    const { instructions, input } = toResponsesInput(messages, options.systemPrompt);
    const tools = options.tools?.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
      strict: false as const,
    }));

    let stream: Stream<ResponseStreamEvent>;
    let lastError: unknown = null;
    let requestModel = options.model;
    let sparkFallbackTried = false;
    let reasoningPayloadDisabled = false;
    let reasoningFallbackTried = false;
    let serviceTierDisabled = false;

    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      const account = this.pool.current();
      const tracker = account.rateLimitTracker;
      const requestAbort = new AbortController();
      let activityTimer: ReturnType<typeof setTimeout> | null = null;
      let gotFirstEvent = false;
      const resetActivityTimer = () => {
        if (activityTimer) clearTimeout(activityTimer);
        const timeout = gotFirstEvent ? STREAM_TIMEOUT_MS : FIRST_TOKEN_TIMEOUT_MS;
        activityTimer = setTimeout(() => {
          const label = gotFirstEvent ? 'stream stalled' : 'no first event (connection may be hanging)';
          requestAbort.abort(new Error(`Codex ${label}: no events for ${Math.round(timeout / 1000)}s`));
        }, timeout);
        activityTimer.unref?.();
      };

      const externalAbort = options.abortSignal;
      const onExternalAbort = () => {
        requestAbort.abort(externalAbort?.reason ?? new Error('Aborted'));
      };
      if (externalAbort) {
        if (externalAbort.aborted) {
          requestAbort.abort(externalAbort.reason ?? new Error('Aborted'));
        } else {
          externalAbort.addEventListener('abort', onExternalAbort, { once: true });
        }
      }

      try {
        // Proactive rate limit throttling — delay if approaching limits
        const preDelay = tracker.getPreRequestDelay();
        const minGap = Math.max(preDelay, 0);
        const elapsed = tracker.timeSinceLastRequest;
        if (minGap > 0 && elapsed < minGap) {
          const waitMs = minGap - elapsed;
          logger.info({ waitMs: Math.round(waitMs), usage: tracker.currentUsagePercent, email: account.email }, 'Throttling: approaching rate limit');
          await sleep(waitMs);
        }

        tracker.recordRequest();
        resetActivityTimer();
        stream = await this.createStream(
          requestModel,
          instructions,
          input,
          tools,
          serviceTierDisabled ? { ...options, serviceTier: undefined } : options,
          account.client,
          requestAbort.signal,
          reasoningPayloadDisabled,
        );
        // Success — process the stream
        yield* this.processStream(stream!, {
          onEvent: () => { gotFirstEvent = true; resetActivityTimer(); },
          abortSignal: requestAbort.signal,
        });
        return;
      } catch (err: unknown) {
        lastError = err;

        // Abort handling:
        // - user interrupt (external signal): stop immediately
        // - stream inactivity timeout: retry with backoff
        if (requestAbort.signal.aborted) {
          if (externalAbort?.aborted) {
            throw err;
          }
          if (attempt >= MAX_RETRY_ATTEMPTS) {
            throw new Error(`Codex stream stalled: no events for ${Math.round(STREAM_TIMEOUT_MS / 1000)}s`);
          }
          const delay = backoffMs(attempt);
          logger.warn(
            { attempt: attempt + 1, delay, email: account.email },
            `Codex stream stalled, retrying in ${Math.round(delay / 1000)}s...`,
          );
          await sleep(delay);
          this.pool.reloadAccount(this.pool.currentIndex);
          continue;
        }

        // Stream/connection errors (Premature close, ECONNRESET, etc.) — retry
        // Also catches `Codex stream error:` and `Codex response failed:` from
        // in-stream error/failed events (which don't have err.status set).
        if (!(err instanceof OpenAI.APIError)) {
          const msg = (err as Error)?.message ?? '';
          if (/premature close|ECONNRESET|socket hang up|network|ETIMEDOUT|Codex stream error|Codex response failed/i.test(msg)) {
            if (attempt >= MAX_RETRY_ATTEMPTS) throw err;
            const delay = backoffMs(attempt);
            logger.info({ attempt, delay, error: msg, email: account.email }, `Stream error, retrying in ${Math.round(delay / 1000)}s...`);
            await sleep(delay);
            this.pool.reloadAccount(this.pool.currentIndex);
            continue;
          }
          throw err;
        }

        // Update rate limit tracker from error response headers
        tracker.updateFromHeaders(err.headers as Record<string, string> | null);

        // 401 Unauthorized — try reload from disk, then refresh token
        if (err.status === 401) {
          logger.info({ email: account.email }, 'Codex OAuth token expired, attempting recovery...');
          if (this.pool.reloadAccount(this.pool.currentIndex)) {
            logger.info({ email: account.email }, 'Reloaded fresh token from disk');
            continue;
          }
          const newToken = await refreshToken(account.auth);
          if (newToken) {
            this.pool.refreshClient(this.pool.currentIndex);
            continue;
          }
          // If multi-account, try rotating to another account
          if (this.pool.size > 1 && this.pool.rotateOnRateLimit()) {
            logger.info({ email: this.pool.current().email }, 'Auth failed, rotated to next account');
            continue;
          }
          throw new Error(`Codex OAuth token expired for ${account.email} and refresh failed. Run "shizuha auth codex" to re-authenticate.`);
        }

        // 403 Forbidden — account may lack Codex access, try next account
        if (err.status === 403) {
          logger.warn({ email: account.email, status: 403 }, 'Codex account returned 403 Forbidden');
          if (this.pool.size > 1 && this.pool.rotateOnRateLimit(Date.now() + 3600000)) {
            logger.info(
              { from: account.email, to: this.pool.current().email, poolSize: this.pool.size },
              'Got 403 Forbidden, rotated to next Codex account',
            );
            attempt--; // account rotation, not a transport retry
            continue;
          }
          throw new Error(`Codex access forbidden (403) for all ${this.pool.size} accounts. Check subscription status. ${err.message}`);
        }

        // 429 Rate Limited — short wait or rotate to another account
        if (err.status === 429) {
          const resetWait = tracker.parseResetFromError(err);

          // Short reset (≤30s): wait on same account instead of rotating
          if (resetWait && resetWait <= SHORT_RESET_THRESHOLD_MS) {
            logger.info(
              { waitMs: Math.round(resetWait), email: account.email },
              `Rate limited (429). Short wait ${Math.round(resetWait / 1000)}s on same account...`,
            );
            tracker.logStatus();
            await sleep(resetWait + 1000);
            this.pool.reloadAccount(this.pool.currentIndex);
            continue;
          }

          // Longer reset or unknown — try rotating to another account
          const resetAtMs = resetWait ? Date.now() + resetWait : undefined;
          if (this.pool.rotateOnRateLimit(resetAtMs)) {
            logger.info(
              { from: account.email, to: this.pool.current().email, poolSize: this.pool.size },
              'Rate limited (429). Rotated to next Codex account',
            );
            attempt--; // don't count rotation as a retry attempt
            continue;
          }

          // All accounts exhausted — wait for earliest reset if known
          if (resetWait && resetWait <= MAX_RATELIMIT_WAIT_MS) {
            logger.info(
              { waitMs: Math.round(resetWait), email: account.email, poolSize: this.pool.size },
              `All ${this.pool.size} Codex accounts rate limited. Waiting ${Math.round(resetWait / 1000)}s...`,
            );
            tracker.logStatus();
            await sleep(resetWait + 1000);
            this.pool.reloadAccount(this.pool.currentIndex);
            continue;
          }

          // No reset time — surface error
          const usageMsg = tracker.currentUsagePercent > 0
            ? ` (current usage: ${tracker.currentUsagePercent}%)`
            : '';
          throw new Error(`All ${this.pool.size} Codex accounts rate limited${usageMsg}. ${err.message}`);
        }

        // 5xx Server errors — retry with backoff
        if (err.status && err.status >= 500) {
          if (attempt >= MAX_RETRY_ATTEMPTS) throw err;
          const delay = backoffMs(attempt);
          logger.info({ attempt, delay, email: account.email }, `Server error (${err.status}), retrying in ${Math.round(delay / 1000)}s...`);
          await sleep(delay);
          continue;
        }

        // service_tier: 'priority' may not be supported for all accounts/models.
        // If we get a 400 while it's enabled, retry without it.
        if (err.status === 400 && !serviceTierDisabled && options.serviceTier) {
          serviceTierDisabled = true;
          logger.warn(
            { model: requestModel, serviceTier: options.serviceTier, email: account.email },
            'Codex request returned 400 with service_tier; retrying without it',
          );
          attempt--; // compatibility fallback, not a transport retry
          continue;
        }

        // Some *-spark models are not accepted by the direct ChatGPT Responses API
        // even when Codex CLI can invoke them. Retry once with the non-spark sibling.
        if (err.status === 400 && !sparkFallbackTried && requestModel.endsWith('-spark')) {
          const fallbackModel = requestModel.replace(/-spark$/, '');
          if (fallbackModel !== requestModel) {
            sparkFallbackTried = true;
            requestModel = fallbackModel;
            logger.warn(
              { fromModel: options.model, retryModel: requestModel, email: account.email },
              'Codex model returned 400; retrying once with non-spark fallback model',
            );
            attempt--; // model fallback is not a transport retry
            continue;
          }
        }

        // Some ChatGPT Responses backends reject reasoning payloads for specific
        // account/model combinations with a bare 400. Retry once without it.
        if (err.status === 400 && !reasoningFallbackTried) {
          const caps = getModelCapabilities(requestModel);
          if (caps.supportsReasoningSummaries && !reasoningPayloadDisabled) {
            reasoningFallbackTried = true;
            reasoningPayloadDisabled = true;
            logger.warn(
              { model: requestModel, email: account.email },
              'Codex request returned 400; retrying once without reasoning payload',
            );
            attempt--; // compatibility fallback, not a transport retry
            continue;
          }
        }

        // Other errors — don't retry
        throw err;
      } finally {
        if (activityTimer) clearTimeout(activityTimer);
        if (externalAbort) {
          externalAbort.removeEventListener('abort', onExternalAbort);
        }
      }
    }

    // Should not reach here, but just in case
    throw lastError ?? new Error('Unexpected retry loop exit');
  }

  private async createStream(
    model: string,
    instructions: string,
    input: ResponseInputItem[],
    tools: Array<{ type: 'function'; name: string; description: string; parameters: Record<string, unknown>; strict: false }> | undefined,
    options: ChatOptions,
    client: OpenAI,
    abortSignal?: AbortSignal,
    disableReasoningPayload = false,
  ): Promise<Stream<ResponseStreamEvent>> {
    const caps = getModelCapabilities(model);
    const params: ResponseCreateParamsStreaming = {
      model,
      instructions,
      input,
      store: false,
      stream: true,
    };

    if (tools?.length) {
      params.tools = [
        ...tools,
        // Native web search — type "web_search" with live internet access
        { type: 'web_search', external_web_access: true } as unknown as typeof tools[0],
      ];
      params.parallel_tool_calls = caps.supportsParallelToolCalls;
    } else {
      params.tools = [
        { type: 'web_search', external_web_access: true },
      ] as unknown as typeof params.tools;
    }

    // Reasoning support — required for gpt-5.1-codex-max and other reasoning models
    if (caps.supportsReasoningSummaries && !disableReasoningPayload) {
      // Use explicit reasoningEffort if set, otherwise fall back to model's default
      const requestedEffort = options.reasoningEffort ?? caps.defaultReasoningLevel ?? 'medium';
      const effort = normalizeReasoningEffort(requestedEffort);
      if (requestedEffort && String(requestedEffort).toLowerCase() !== effort) {
        logger.warn(
          { model, requestedEffort, normalizedEffort: effort },
          'Codex reasoning effort normalized for Responses API compatibility',
        );
      }
      // summary: 'auto' shows reasoning summaries (thinking text); 'none' hides them.
      // Use 'auto' so the user can see thinking output. Codex defaults to 'none' for gpt-5.4
      // but we prefer 'auto' since shizuha streams reasoning text to the TUI/CLI.
      params.reasoning = { effort: effort as 'low' | 'medium' | 'high' | 'xhigh', summary: 'auto' };
      params.include = ['reasoning.encrypted_content'];
      logger.info({ model, effort }, 'Codex: reasoning enabled');
    }

    // Service tier: 'priority' for faster inference at 2x credits
    if (options.serviceTier) {
      (params as unknown as Record<string, unknown>).service_tier = options.serviceTier;
      logger.info({ model, serviceTier: options.serviceTier }, 'Codex: service tier set');
    }

    // Note: temperature and max_output_tokens are not supported by the
    // ChatGPT backend-api/codex endpoint — omit them from the request

    return client.responses.create(params, abortSignal ? { signal: abortSignal } : undefined);
  }

  private async *processStream(
    stream: Stream<ResponseStreamEvent>,
    opts?: { onEvent?: () => void; abortSignal?: AbortSignal },
  ): AsyncGenerator<StreamChunk> {
    // Note: Rate limit headers are captured from error responses in the retry loop.
    // The OpenAI SDK Stream class doesn't expose raw HTTP response headers directly.
    const toolCalls = new Map<string, { id: string; name: string; args: string }>();
    let inputTokens = 0;
    let outputTokens = 0;
    let lastThinkingHeartbeat = 0;

    for await (const event of stream) {
      opts?.onEvent?.();
      if (opts?.abortSignal?.aborted) {
        throw opts.abortSignal.reason ?? new Error('Aborted');
      }
      switch (event.type) {
        case 'response.output_text.delta': {
          if (event.delta) {
            yield { type: 'text', text: event.delta };
          }
          break;
        }

        case 'response.output_item.added': {
          const item = event.item;
          if (item.type === 'function_call') {
            const id = item.call_id;
            const name = item.name;
            toolCalls.set(id, { id, name, args: '' });
            yield { type: 'tool_use_start', id, name };
          } else if (item.type === 'reasoning') {
            // Reasoning block started — emit heartbeat so TUI shows "Thinking..." indicator
            lastThinkingHeartbeat = Date.now();
            yield { type: 'thinking' as const };
          } else if ((item as any).type === 'web_search_call') {
            yield { type: 'web_search', status: 'searching' };
          }
          break;
        }

        case 'response.function_call_arguments.delta': {
          const delta = event.delta;
          const itemId = event.item_id;
          const tc = toolCalls.get(itemId);
          if (tc && delta) {
            tc.args += delta;
            yield { type: 'tool_use_delta', id: tc.id, input: delta };
          }
          break;
        }

        case 'response.output_item.done': {
          const item = event.item;
          if (item.type === 'function_call') {
            const id = item.call_id;
            const argsStr = item.arguments || toolCalls.get(id)?.args || '{}';
            try {
              const parsed = JSON.parse(argsStr) as Record<string, unknown>;
              yield { type: 'tool_use_end', id, input: parsed };
            } catch {
              yield { type: 'tool_use_end', id, input: {} };
            }
          } else if (item.type === 'reasoning') {
            // Capture reasoning items for roundtripping (encrypted content enables prompt caching)
            yield {
              type: 'reasoning',
              id: item.id,
              encryptedContent: item.encrypted_content ?? undefined,
              summary: item.summary?.map((s: { text: string }) => ({ text: s.text })),
            };
          } else if (item.type === 'message' && item.role === 'assistant') {
            const finalText = getCompletedAssistantMessageText(item);
            if (finalText) {
              yield { type: 'final_text', text: finalText };
            }
          } else if ((item as any).type === 'web_search_call') {
            yield { type: 'web_search', status: 'done' };
          }
          break;
        }

        case 'response.completed': {
          const usage = event.response?.usage;
          if (usage) {
            inputTokens = usage.input_tokens ?? 0;
            outputTokens = usage.output_tokens ?? 0;
          }
          break;
        }

        // Native web search events
        case 'response.web_search_call.in_progress':
        case 'response.web_search_call.searching': {
          yield { type: 'web_search', status: 'searching' };
          break;
        }
        case 'response.web_search_call.completed': {
          yield { type: 'web_search', status: 'done' };
          break;
        }

        // ── Server-side errors — throw so the outer retry loop can retry ──

        case 'error': {
          // ResponseErrorEvent: { code, message, param, type: 'error' }
          const errEvt = event as unknown as { code: string | null; message: string };
          throw new Error(`Codex stream error: ${errEvt.message || 'unknown'} (code: ${errEvt.code || 'none'})`);
        }

        case 'response.failed': {
          // ResponseFailedEvent: { response: Response, type: 'response.failed' }
          const failedResp = (event as unknown as { response?: { error?: { message?: string } } }).response;
          const failMsg = failedResp?.error?.message || 'response failed';
          throw new Error(`Codex response failed: ${failMsg}`);
        }

        case 'response.incomplete': {
          // ResponseIncompleteEvent: response was cut short (safety, length, etc.)
          // Not retryable — yield what we have and mark as done
          break;
        }

        // Streaming reasoning summary — emit the actual reasoning text so the
        // user can see the model's thinking in real time (like Claude's thinking blocks)
        case 'response.reasoning_summary_text.delta': {
          const delta = (event as any).delta;
          if (delta) {
            yield { type: 'reasoning_text' as const, text: delta };
          }
          // Also emit periodic heartbeats so TUI stall detector stays alive
          const now = Date.now();
          if (now - lastThinkingHeartbeat >= 5000) {
            lastThinkingHeartbeat = now;
            yield { type: 'thinking' as const };
          }
          break;
        }
      }
    }

    if (inputTokens || outputTokens) {
      yield { type: 'usage', inputTokens, outputTokens };
    }
    yield { type: 'done' };
  }
}
