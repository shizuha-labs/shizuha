/**
 * Persistent credential store at ~/.shizuha/credentials.json
 *
 * Auto-persist: tokens discovered from transient sources (env vars, Claude CLI files)
 * are automatically saved so they survive across terminals. Run shizuha once with
 * CLAUDE_CODE_OAUTH_TOKEN set → token persists forever → works without the env var.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── Types ──

export interface AnthropicTokenEntry {
  token: string;
  label: string;
  addedAt: string;
  /** Whether this token is in the active pool for agent injection. Defaults to true. */
  active?: boolean;
  /**
   * ISO timestamp until which this token is considered "dead" (on cooldown).
   * Set when any agent reports a 429 on this token. Cooldown-aware pickers
   * skip tokens with `cooldownUntil > now` so rate-limited tokens don't get
   * re-picked across container respawns or sibling-agent spawns.
   */
  cooldownUntil?: string;
  /**
   * ISO timestamp of the last recorded 429 on this token. Used for LRU-style
   * rotation (prefer tokens that have never or least-recently been limited)
   * and for operator diagnostics.
   */
  lastRateLimitAt?: string;
  /**
   * ISO timestamp of the last bounded stale-cooldown probe. Used to cap
   * PLAT-1193 recovery probes across daemon restarts.
   */
  lastCooldownProbeAt?: string;
  /**
   * Selection tier — LOWER is preferred. The picker only falls to a higher
   * tier when every lower-tier token is on cooldown, and returns to the lower
   * tier once its cooldown expires. Lets the operator designate one PRIMARY
   * token (priority 1) that all agents drain first, with old/low-quota tokens
   * as per-agent failure fallbacks (priority 2+). Defaults to 1.
   */
  priority?: number;
}

export interface ProviderTokens {
  tokens: AnthropicTokenEntry[];
  apiKey?: string;
}

export interface CodexAccountEntry {
  email: string;
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accountId: string;
  addedAt: string;
  lastRefresh?: string;
}

export interface CopilotCredential {
  githubToken: string;
  label?: string;
  addedAt: string;
}

export interface CredentialStore {
  anthropic?: ProviderTokens;
  openai?: { apiKey?: string; baseUrl?: string; defaultModel?: string };
  google?: { apiKey: string };
  codex?: { accounts: CodexAccountEntry[] };
  copilot?: CopilotCredential;
  // SCLI-86: user's own Cortex inference key (sk-cortex-…) for cortex/<model> runs.
  cortex?: { apiKey: string; baseUrl?: string };
}

// ── Paths ──

export function credentialsDir(): string {
  return path.join(process.env['HOME'] ?? '~', '.shizuha');
}

export function credentialsPath(): string {
  return path.join(credentialsDir(), 'credentials.json');
}

// ── Read / Write ──

/** Read credential store (user-managed tokens only). */
export function readCredentials(): CredentialStore {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf-8');
    return JSON.parse(raw) as CredentialStore;
  } catch {
    // File doesn't exist or is invalid — return empty store
    return {};
  }
}

/**
 * SCLI-425: corruption-aware credential-store read for diagnostic surfaces.
 *
 * `readCredentials()` maps any read/parse failure to an empty store (correct
 * for token-discovery). `auth status` must distinguish absent vs corrupt, and
 * must not crash on a JSON `null` root.
 */
export type CredentialsReadResult =
  | { ok: true; store: CredentialStore }
  | { ok: false; error: string };

export function readCredentialsStrict(): CredentialsReadResult {
  const filePath = credentialsPath();
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { ok: true, store: {} };
  }

  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'the credential store is EMPTY (expected a JSON object)' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `the credential store is not valid JSON: ${detail}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed;
    return {
      ok: false,
      error: `the credential store root has an unsupported type ("${kind}"); expected a JSON object`,
    };
  }

  return { ok: true, store: parsed as CredentialStore };
}

/**
 * Discover ALL Claude OAuth tokens from all sources.
 * Returns a deduplicated pool for random-pick + 401-failover.
 *
 * Auto-persist: tokens found from transient sources (env vars, Claude CLI files)
 * are automatically saved to ~/.shizuha/credentials.json so they survive across
 * terminals/sessions. This means: run shizuha once with CLAUDE_CODE_OAUTH_TOKEN
 * set → token is saved permanently → works in all future terminals without env var.
 *
 * Sources (all additive, not priority-ordered):
 * 1. CLAUDE_CODE_OAUTH_TOKEN env var
 * 2. CLAUDE_ACCOUNTS_JSON env var (all entries)
 * 3. ~/.shizuha/credentials.json → anthropic.tokens (user-managed)
 * 4. ~/.claude/.credentials.json → claudeAiOauth.accessToken
 * 5. ~/.claude/accounts/*.json files
 */
export function discoverClaudeTokens(): AnthropicTokenEntry[] {
  const seen = new Set<string>();
  const tokens: AnthropicTokenEntry[] = [];

  const add = (token: string, label: string) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    tokens.push({ token, label, addedAt: '' });
  };

  // 3. ~/.shizuha/credentials.json → anthropic.tokens (read FIRST to know what's persisted)
  const persistedTokens = new Set<string>();
  try {
    const creds = readCredentials();
    for (const t of creds.anthropic?.tokens ?? []) {
      persistedTokens.add(t.token);
      add(t.token, t.label);
    }
  } catch { /* ignore */ }

  // Track tokens from transient sources for auto-persist
  const transientTokens: Array<{ token: string; label: string }> = [];

  // 1. CLAUDE_CODE_OAUTH_TOKEN env var
  const envToken = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  if (envToken) {
    add(envToken, 'env-primary');
    if (!persistedTokens.has(envToken)) transientTokens.push({ token: envToken, label: 'env-primary' });
  }

  // 2. CLAUDE_ACCOUNTS_JSON env var
  const envJson = process.env['CLAUDE_ACCOUNTS_JSON'];
  if (envJson) {
    try {
      const parsed = JSON.parse(envJson) as Array<{ token: string; label?: string }>;
      for (let i = 0; i < parsed.length; i++) {
        const entry = parsed[i];
        if (entry?.token) {
          const label = entry.label ?? `accounts_${i}`;
          add(entry.token, label);
          if (!persistedTokens.has(entry.token)) transientTokens.push({ token: entry.token, label });
        }
      }
    } catch { /* ignore */ }
  }

  // Token sources 4 and 5 (auto-discovery from ~/.claude/) are intentionally disabled.
  // Only explicitly configured tokens (env vars + dashboard settings) are used.
  // Auto-discovery from ~/.claude/ created token clutter (every OAuth refresh added a new entry)
  // and made it hard to reason about which tokens were active.
  //
  // To add a token: set CLAUDE_CODE_OAUTH_TOKEN env var, or use the dashboard settings UI.

  // Auto-persist env-var tokens to credential store (so they show in dashboard settings).
  // Only persist the env-primary token, not stale auto-discovered ones.
  if (envToken && !persistedTokens.has(envToken)) {
    try {
      const store = readCredentials();
      if (!store.anthropic) store.anthropic = { tokens: [] };
      store.anthropic.tokens.push({ token: envToken, label: 'primary', addedAt: new Date().toISOString() });
      writeCredentials(store);
    } catch { /* ignore */ }
  }

  return tokens;
}

/** Atomic write with restricted permissions. */
export function writeCredentials(store: CredentialStore): void {
  const dir = credentialsDir();
  // Ensure directory exists with mode 700
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const filePath = credentialsPath();
  const tmpPath = filePath + '.tmp';

  fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

// ── Anthropic Token Management ──

/** Append a token to the anthropic.tokens array. */
export function addAnthropicToken(token: string, label?: string): void {
  const store = readCredentials();
  if (!store.anthropic) {
    store.anthropic = { tokens: [] };
  }

  const finalLabel = label ?? `token_${store.anthropic.tokens.length + 1}`;
  store.anthropic.tokens.push({
    token,
    label: finalLabel,
    addedAt: new Date().toISOString(),
  });

  writeCredentials(store);
}

/** Default cooldown duration when the 429 response didn't include a retry hint. */
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
/** Upper bound so a mis-parsed reset clause can never park a token effectively forever. */
const MAX_COOLDOWN_MS = 8 * 24 * 60 * 60 * 1000; // 8 days (covers a weekly reset + slack)
/** PLAT-1193: do not probe a freshly stamped cooldown; it may be a real live throttle. */
const STALE_COOLDOWN_PROBE_MIN_AGE_MS = 15 * 60 * 1000;
/** PLAT-1193: per-token probe rate cap so a stale cooldown cannot cause a retry storm. */
const STALE_COOLDOWN_PROBE_INTERVAL_MS = 30 * 60 * 1000;
const DEFAULT_CLAUDE_TOKEN_PROBE_MODEL = 'claude-3-5-haiku-20241022';

const RESET_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * Parse the explicit reset time out of an Anthropic quota error and return
 * milliseconds-until-reset (or undefined if there's no parseable clause).
 *
 * Anthropic surfaces e.g. "You've hit your weekly limit · resets Jun 27, 5pm (UTC)".
 * Without this we stamp a flat 1h cooldown on a WEEKLY-exhausted token, so it
 * re-enters rotation after an hour and immediately re-fails — the pool churns
 * through weekly-dead tokens instead of parking each until it actually resets
 * (the hana/nao 2026-06-23 strand). All times are treated as UTC (the message
 * says "(UTC)"). Defensive: returns undefined on any parse failure so callers
 * fall back to the default cooldown.
 */
export function parseQuotaResetMs(message: unknown, now = Date.now()): number | undefined {
  if (typeof message !== 'string' || !message) return undefined;
  // "resets Jun 27, 5pm (UTC)" / "resets Jun 27 17:00" / "resets Jun 27"
  const m = /resets?\s+(?:on\s+|at\s+)?([A-Za-z]{3,9})\s+(\d{1,2})(?:,)?(?:\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i.exec(message);
  if (!m) return undefined;
  const mon = RESET_MONTHS[m[1]!.slice(0, 3).toLowerCase()];
  if (mon === undefined) return undefined;
  const day = parseInt(m[2]!, 10);
  let hour = m[3] ? parseInt(m[3], 10) : 0;
  const min = m[4] ? parseInt(m[4], 10) : 0;
  const ap = (m[5] ?? '').toLowerCase();
  if (ap === 'pm' && hour < 12) hour += 12;
  if (ap === 'am' && hour === 12) hour = 0;
  const yr = new Date(now).getUTCFullYear();
  let ts = Date.UTC(yr, mon, day, hour, min, 0);
  // Reset clauses never name a year; if the date already passed this year it's next year.
  if (ts <= now) ts = Date.UTC(yr + 1, mon, day, hour, min, 0);
  const ms = ts - now;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, MAX_COOLDOWN_MS);
}

function isOnCooldown(t: AnthropicTokenEntry, now = Date.now()): boolean {
  if (!t.cooldownUntil) return false;
  const ts = Date.parse(t.cooldownUntil);
  return Number.isFinite(ts) && ts > now;
}

/**
 * True when the host-pool token with this label is currently on cooldown
 * (a recent 429 we reported to the daemon host pool). The bridge uses this to
 * VETO a broker-served token the daemon already knows is exhausted: the broker
 * draws from the hive coordinator pool, which doesn't see real-traffic 429s, so
 * without this veto a cooled token would be re-served forever (the 2026-06-24
 * crash loop). credentials.json is a live read-only mount in the agent
 * container, so the daemon's cooldown writes are visible here.
 */
export function isClaudeTokenLabelOnCooldown(label: string, now = Date.now()): boolean {
  if (!label) return false;
  const store = readCredentials();
  const entry = (store.anthropic?.tokens ?? []).find(t => t.label === label);
  return entry ? isOnCooldown(entry, now) : false;
}


async function probeClaudeOAuthToken(token: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env['CLAUDE_TOKEN_PROBE_MODEL'] || DEFAULT_CLAUDE_TOKEN_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function readCredentialsWithUpdatedProbeTimes(updatedTokens: AnthropicTokenEntry[]): CredentialStore {
  const store = readCredentials();
  const byLabel = new Map(updatedTokens.map(t => [t.label, t.lastCooldownProbeAt]));
  for (const entry of store.anthropic?.tokens ?? []) {
    const probeAt = byLabel.get(entry.label);
    if (probeAt) entry.lastCooldownProbeAt = probeAt;
  }
  return store;
}

function maybeRecoverStaleClaudeCooldowns(
  tokens: AnthropicTokenEntry[],
  excludeLabel: string | undefined,
  now: number,
): void {
  const notExcluded = excludeLabel ? tokens.filter(t => t.label !== excludeLabel) : tokens;
  const cooled = notExcluded.filter(t => isOnCooldown(t, now));
  // PLAT-1193 recurrence fix (2026-07-04): probe cooled tokens on the bounded
  // schedule REGARDLESS of how many fresh tokens remain. The original
  // `fresh.length > 1` emergency-only gate meant overshot cooldown stamps
  // (e.g. a mis-parsed weekly reset parking a token until tomorrow) were never
  // re-verified while ≥2 tokens lived — the fleet silently ran at reduced
  // capacity and Hive painted agents Unavailable (recurred 2026-07-03/04 with
  // 3 of 5 tokens cooled). A cooldown is a hypothesis to re-verify, not a fact:
  // the min-age (15m) + per-token interval (30m) caps bound probe cost to a
  // few 1-token calls per hour across the whole pool.
  if (cooled.length === 0) return;

  const staleCandidates: AnthropicTokenEntry[] = [];
  for (const t of cooled) {
    const stampedAt = t.lastRateLimitAt ? Date.parse(t.lastRateLimitAt) : 0;
    if (!Number.isFinite(stampedAt) || stampedAt <= 0) continue;
    if (now - stampedAt < STALE_COOLDOWN_PROBE_MIN_AGE_MS) continue;
    const lastProbe = t.lastCooldownProbeAt ? Date.parse(t.lastCooldownProbeAt) : 0;
    if (Number.isFinite(lastProbe) && lastProbe > 0 && now - lastProbe < STALE_COOLDOWN_PROBE_INTERVAL_MS) continue;
    t.lastCooldownProbeAt = new Date(now).toISOString();
    staleCandidates.push({ ...t });
  }
  if (!staleCandidates.length) return;
  try {
    writeCredentials(readCredentialsWithUpdatedProbeTimes(tokens));
  } catch (err) {
    console.error(`[credentials] stale Claude cooldown probe stamp failed: ${(err as Error).message}`);
    return;
  }
  for (const candidate of staleCandidates) {
    void probeClaudeOAuthToken(candidate.token).then((ok) => {
      if (!ok) return;
      const store = readCredentials();
      const entry = store.anthropic?.tokens?.find(t => t.label === candidate.label && t.token === candidate.token);
      if (!entry || entry.active === false) return;
      // Only clear the SAME cooldown we probed. If a bridge stamped a newer real
      // 429 while the probe was in flight, preserve that fresh cooldown.
      if (entry.lastRateLimitAt !== candidate.lastRateLimitAt || entry.cooldownUntil !== candidate.cooldownUntil) return;
      delete entry.cooldownUntil;
      entry.lastCooldownProbeAt = new Date().toISOString();
      writeCredentials(store);
      console.log(`[credentials] Cleared stale Claude token cooldown after successful bounded probe: ${entry.label}`);
    }).catch(() => { /* fire-and-forget recovery must never break token selection */ });
  }
}

/**
 * Pick the best active Claude OAuth token for an agent spawn.
 *
 * Selection rules:
 *  - Drop `active === false` tokens (operator-disabled).
 *  - Drop tokens currently on cooldown (we've seen a 429 recently).
 *  - If `excludeLabel` is set, drop that too (used when a bridge is
 *    rotating away from its own known-dead token).
 *  - Among survivors, prefer the one with the **oldest** (or no)
 *    `lastRateLimitAt` — round-robin by LRU so a single healthy token
 *    doesn't get pile-on traffic. This replaces the old "prefer primary"
 *    logic, which caused every agent to share one hot token.
 *  - Within the LRU-equal bucket: if `activeCounts` is provided, pick the
 *    token with the fewest live sessions (least-loaded). Without it, fall
 *    back to random — the random tiebreak exists to prevent pile-on when
 *    many agents spawn simultaneously with no count context.
 *  - If every candidate is on cooldown, pick the one whose cooldown
 *    expires **soonest** — it's our best shot at the next successful
 *    call.
 *
 * `activeCounts` should be a Map of label → number of currently-active
 * agent sessions using that token. Pass it from the daemon where it can
 * be derived from in-memory agent state. Bridge/dashboard rotation calls
 * can omit it and keep the random fallback.
 *
 * Returns null only if the pool is empty or every token is disabled.
 */
/**
 * PLAT-1193 recurrence fix (2026-07-04, part 2): run the bounded stale-cooldown
 * probe WITHOUT a token pick. In the production broker topology (bridge →
 * mcp-auth-proxy → hive coordinator) the daemon's getActiveClaudeToken is
 * rarely called, so probe-on-pick alone left stale stamps untouched for hours.
 * The daemon calls this on a timer; all bounds (15m min-age, 30m per-token
 * interval, probe-200-then-compare-and-clear) are enforced inside.
 */
export function probeStaleClaudeCooldowns(now = Date.now()): void {
  const store = readCredentials();
  const enabled = (store.anthropic?.tokens ?? []).filter(t => t.active !== false);
  if (!enabled.length) return;
  maybeRecoverStaleClaudeCooldowns(enabled, undefined, now);
}

export function getActiveClaudeToken(
  excludeLabel?: string,
  activeCounts?: ReadonlyMap<string, number>,
): AnthropicTokenEntry | null {
  const store = readCredentials();
  const enabled = (store.anthropic?.tokens ?? []).filter(t => t.active !== false);
  if (!enabled.length) return null;

  const now = Date.now();
  maybeRecoverStaleClaudeCooldowns(enabled, excludeLabel, now);
  const notExcluded = excludeLabel ? enabled.filter(t => t.label !== excludeLabel) : enabled;
  const fresh = notExcluded.filter(t => !isOnCooldown(t, now));

  // Happy path: PRIORITY tier first (lower wins — the operator's primary token
  // is tier 1, fallbacks tier 2+; fallbacks are only reached when the whole
  // lower tier is on cooldown, and the picker returns to the primary once its
  // cooldown expires). Within a tier: LRU bucket, then live-count-aware pick.
  if (fresh.length > 0) {
    const tier = (t: AnthropicTokenEntry) => t.priority ?? 1;
    const minTier = Math.min(...fresh.map(tier));
    const tierPool = fresh.filter(t => tier(t) === minTier);
    const score = (t: AnthropicTokenEntry) => (t.lastRateLimitAt ? Date.parse(t.lastRateLimitAt) : 0);
    // Spread agents across ALL fresh same-tier tokens by least-loaded (SCLI-77).
    // Distribute by active-session count FIRST so N agents fan out over the whole
    // tier instead of all piling onto one token and exhausting its weekly quota
    // (the 2026-06-24 fleet-wide weekly-limit crash loop: 9 agents all on cl2).
    // Tie-break by least-recently-rate-limited, then randomly. Previously the
    // bucket was pre-narrowed to the single min-lastRateLimitAt token, so the
    // least-loaded step (which needs >1 candidate) almost never ran.
    if (activeCounts && tierPool.length > 1) {
      // Stable sort (sort is stable in V8 ≥ Node 11) so ties preserve insertion order.
      const sorted = [...tierPool].sort(
        (a, b) =>
          ((activeCounts.get(a.label) ?? 0) - (activeCounts.get(b.label) ?? 0)) ||
          (score(a) - score(b)),
      );
      return sorted[0]!;
    }
    const minScore = Math.min(...tierPool.map(score));
    const bestBucket = tierPool.filter(t => score(t) === minScore);
    return bestBucket[Math.floor(Math.random() * bestBucket.length)]!;
  }

  // All non-excluded tokens are on cooldown. Pick the soonest to expire
  // — it's likely to be usable first.
  if (notExcluded.length > 0) {
    notExcluded.sort((a, b) =>
      Date.parse(a.cooldownUntil ?? '') - Date.parse(b.cooldownUntil ?? ''),
    );
    return notExcluded[0]!;
  }

  // Only the excluded token remains — return it (caller will deal with the
  // fact that rotation isn't possible right now).
  return enabled[0]!;
}


/**
 * Returns a diagnostic snapshot of the Claude OAuth token pool.
 * Useful for logging pool state at rotation/exit time.
 */
export function getClaudeTokenPoolSummary(excludeLabel?: string, now = Date.now()): {
  total: number;
  enabled: number;
  fresh: number;
  onCooldown: number;
  nextLabel: string | null;
} {
  const store = readCredentials();
  const all = store.anthropic?.tokens ?? [];
  const enabled = all.filter(t => t.active !== false);
  const notExcluded = excludeLabel ? enabled.filter(t => t.label !== excludeLabel) : enabled;
  const fresh = notExcluded.filter(t => !isOnCooldown(t, now));
  let nextLabel: string | null = null;
  if (fresh.length > 0) {
    const tier = (t: AnthropicTokenEntry) => t.priority ?? 1;
    const minTier = Math.min(...fresh.map(tier));
    const tierPool = fresh.filter(t => tier(t) === minTier);
    nextLabel = tierPool[0]?.label ?? null;
  } else if (notExcluded.length > 0) {
    const sorted = [...notExcluded].sort((a, b) =>
      Date.parse(a.cooldownUntil ?? '') - Date.parse(b.cooldownUntil ?? ''),
    );
    nextLabel = sorted[0]?.label ?? null;
  }
  return {
    total: all.length,
    enabled: enabled.length,
    fresh: fresh.length,
    onCooldown: notExcluded.length - fresh.length,
    nextLabel,
  };
}

/**
 * Record that a token hit a 429. Persists the cooldown so that subsequent
 * agent spawns (and sibling bridge processes) skip this token until the
 * window expires.
 *
 * If `retryAfterSeconds` is provided (from the API's retry-after header),
 * we honor it; otherwise we default to 1 hour, which covers the common
 * "daily quota" case without parking the token forever.
 */
export function reportTokenRateLimited(label: string, retryAfterSeconds?: number): boolean {
  const store = readCredentials();
  const tokens = store.anthropic?.tokens ?? [];
  const entry = tokens.find(t => t.label === label);
  if (!entry) return false;
  const cooldownMs = typeof retryAfterSeconds === 'number' && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, MAX_COOLDOWN_MS)
    : DEFAULT_COOLDOWN_MS;
  const nowIso = new Date().toISOString();
  entry.cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();
  entry.lastRateLimitAt = nowIso;
  delete entry.lastCooldownProbeAt;
  writeCredentials(store);
  console.log(`[credentials] Claude token "${label}" rate-limited; cooldown_until=${entry.cooldownUntil}; retry_after_seconds=${retryAfterSeconds ?? 'default'}; cooldown_ms=${cooldownMs}`);
  return true;
}

/**
 * Record that a token is auth-invalid (401 — bad key or permanently revoked).
 * Distinct from a transient 429: the token is set `active=false` so the picker
 * never selects it again until the operator explicitly re-enables it via
 * `toggleAnthropicTokenActive(label, true)` (or the dashboard toggle).
 *
 * HIVE-122: called by the bridge + the daemon `report-invalid` endpoint on any
 * 401 auth error so the daemon's host pool drops the dead label immediately.
 */
export function reportTokenInvalid(label: string): boolean {
  const store = readCredentials();
  const entry = store.anthropic?.tokens?.find(t => t.label === label);
  if (!entry) return false;
  entry.active = false;
  writeCredentials(store);
  return true;
}

/** Clear a token's cooldown (operator override, e.g. "I know the limit reset"). */
export function clearTokenCooldown(label: string): boolean {
  const store = readCredentials();
  const entry = store.anthropic?.tokens?.find(t => t.label === label);
  if (!entry) return false;
  if (!entry.cooldownUntil) return true; // already clear
  delete entry.cooldownUntil;
  writeCredentials(store);
  return true;
}

/** Toggle a token's active state by label. Returns the new active state, or null if not found. */
export function toggleAnthropicTokenActive(label: string, active: boolean): boolean | null {
  const store = readCredentials();
  if (!store.anthropic?.tokens?.length) return null;
  const token = store.anthropic.tokens.find((t) => t.label === label);
  if (!token) return null;
  token.active = active;
  writeCredentials(store);
  return active;
}

/** Remove a token by label. */
export function removeAnthropicToken(label: string): boolean {
  const store = readCredentials();
  if (!store.anthropic?.tokens?.length) return false;

  const before = store.anthropic.tokens.length;
  store.anthropic.tokens = store.anthropic.tokens.filter((t) => t.label !== label);

  if (store.anthropic.tokens.length === before) return false;
  writeCredentials(store);
  return true;
}

/** Set the Anthropic API key (sk-ant-api..., not OAuth). */
export function setAnthropicApiKey(key: string): void {
  const store = readCredentials();
  if (!store.anthropic) store.anthropic = { tokens: [] };
  store.anthropic.apiKey = key;
  writeCredentials(store);
}

// ── OpenAI / Google Key Management ──

/** Ensure an OpenAI-compatible base URL ends in /v1. */
export function normalizeOpenAICompatibleBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const noSlash = trimmed.replace(/\/+$/, '');
  return /\/v1$/i.test(noSlash) ? noSlash : `${noSlash}/v1`;
}

export function setOpenAIKey(key: string): void {
  setOpenAIEndpoint({ apiKey: key });
}

/** Persist an OpenAI-compatible endpoint. A base URL alone is enough for
 *  local servers that do not require a real API key. */
export function setOpenAIEndpoint(opts: {
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
}): void {
  const store = readCredentials();
  const prev = store.openai ?? {};
  const apiKey = opts.apiKey !== undefined ? opts.apiKey.trim() : prev.apiKey;
  const baseUrl = opts.baseUrl !== undefined ? opts.baseUrl.trim() : prev.baseUrl;
  const defaultModel = opts.defaultModel !== undefined ? opts.defaultModel.trim() : prev.defaultModel;
  const next: NonNullable<CredentialStore['openai']> = {};
  if (apiKey) next.apiKey = apiKey;
  if (baseUrl) next.baseUrl = baseUrl;
  if (defaultModel) next.defaultModel = defaultModel;
  if (!next.apiKey && !next.baseUrl) {
    delete store.openai;
  } else {
    store.openai = next;
  }
  writeCredentials(store);
}

export function setGoogleKey(key: string): void {
  const store = readCredentials();
  store.google = { apiKey: key };
  writeCredentials(store);
}

// ── Cortex Key Management (SCLI-86) ──

/**
 * Persist the user's own Cortex inference key (sk-cortex-…) to
 * credentials.json (0600). Resolved at lowest priority by
 * resolveCortexAuthToken() — env vars still win. An optional baseUrl lets a
 * user point at a non-default Cortex; preserved if only the key is updated.
 */
export function setCortexApiKey(key: string, baseUrl?: string): void {
  const store = readCredentials();
  store.cortex = {
    apiKey: key,
    ...(baseUrl ? { baseUrl } : store.cortex?.baseUrl ? { baseUrl: store.cortex.baseUrl } : {}),
  };
  writeCredentials(store);
}

export function removeProvider(provider: 'anthropic' | 'openai' | 'google'): boolean {
  const store = readCredentials();
  if (!store[provider]) return false;
  delete store[provider];
  writeCredentials(store);
  return true;
}

// ── Codex Account Management ──

/** Read all Codex accounts from the credential store. */
export function readCodexAccounts(): CodexAccountEntry[] {
  const store = readCredentials();
  return store.codex?.accounts ?? [];
}

/** Add or update a Codex account in the credential store. */
export function saveCodexAccount(entry: CodexAccountEntry): void {
  const store = readCredentials();
  if (!store.codex) store.codex = { accounts: [] };
  // Replace if same email exists, otherwise append
  const idx = store.codex.accounts.findIndex((a) => a.email === entry.email);
  if (idx >= 0) {
    store.codex.accounts[idx] = entry;
  } else {
    store.codex.accounts.push(entry);
  }
  writeCredentials(store);
}

/** Update tokens for an existing Codex account (after refresh). */
export function updateCodexTokens(email: string, accessToken: string, refreshToken?: string, idToken?: string): void {
  const store = readCredentials();
  if (!store.codex?.accounts) return;
  const account = store.codex.accounts.find((a) => a.email === email);
  if (!account) return;
  account.accessToken = accessToken;
  if (refreshToken) account.refreshToken = refreshToken;
  if (idToken) account.idToken = idToken;
  account.lastRefresh = new Date().toISOString();
  writeCredentials(store);
}

/** Remove a Codex account by email. */
export function removeCodexAccount(email: string): boolean {
  const store = readCredentials();
  if (!store.codex?.accounts?.length) return false;
  const before = store.codex.accounts.length;
  store.codex.accounts = store.codex.accounts.filter((a) => a.email !== email);
  if (store.codex.accounts.length === before) return false;
  writeCredentials(store);
  return true;
}

/** Reorder Codex accounts. `emails` must contain exactly the same set of emails. */
export function reorderCodexAccounts(emails: string[]): boolean {
  const store = readCredentials();
  if (!store.codex?.accounts?.length) return false;
  const existing = store.codex.accounts;
  if (emails.length !== existing.length) return false;

  const byEmail = new Map(existing.map((a) => [a.email, a]));
  const reordered: CodexAccountEntry[] = [];
  for (const email of emails) {
    const entry = byEmail.get(email);
    if (!entry) return false; // unknown email
    reordered.push(entry);
  }

  store.codex.accounts = reordered;
  writeCredentials(store);
  return true;
}

// ── GitHub Copilot Credential Management ──

/** Read GitHub Copilot credential. */
export function readCopilotCredential(): CopilotCredential | undefined {
  const store = readCredentials();
  return store.copilot;
}

/** Set GitHub Copilot credential (GitHub PAT with Copilot scope). */
export function setCopilotToken(githubToken: string, label?: string): void {
  const store = readCredentials();
  store.copilot = {
    githubToken,
    label,
    addedAt: new Date().toISOString(),
  };
  writeCredentials(store);
}

/** Remove GitHub Copilot credential. */
export function removeCopilotToken(): boolean {
  const store = readCredentials();
  if (!store.copilot) return false;
  delete store.copilot;
  writeCredentials(store);
  return true;
}

