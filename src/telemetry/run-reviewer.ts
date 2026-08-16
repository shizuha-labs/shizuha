/**
 * SCLI-35: Run-reviewer — periodic systemic-pattern digest.
 *
 * Aggregates struggle bugs filed by SCLI-33 across runs over a rolling time
 * window, groups them by pattern kind and agent, and classifies recurring ones
 * as systemic. When systemic patterns are found a digest Pulse task is filed
 * (or the existing open digest is updated via comment) and routed to the
 * architecture team so Aoi can re-groom the SCLI backlog.
 *
 * Exported surface:
 *   runReview(config)                       — one-shot digest run
 *   setupPeriodicRunReviewer(config, ms)    — wrap in setInterval; returns unsubscribe
 */

import { logger } from '../utils/logger.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type StruggleKind = 'STALL' | 'THRASH' | 'ERROR_DENSITY' | 'LONG_RUN';

export interface RunReviewerConfig {
  /** Base URL for Pulse REST API. Default: PULSE_INTERNAL_URL or http://shizuha-pulse:8002 */
  pulseBaseUrl?: string;
  /** Bearer token. Default: PULSE_SERVICE_TOKEN env var. */
  serviceToken?: string;
  /** Numeric project PK for newly filed digest tasks. Default: PULSE_PROJECT_ID. */
  projectId?: number;
  /** Look-back window in milliseconds. Default: 7 days. */
  windowMs?: number;
  /**
   * Min occurrences of the same kind within the window to classify as systemic.
   * Default: SCLI35_SYSTEMIC_THRESHOLD env var or 3.
   */
  systemicThreshold?: number;
  /** Max struggle bugs to fetch (paging). Default: 200. */
  maxItems?: number;
}

/** Stats for one struggle-kind bucket. */
export interface PatternBucket {
  kind: StruggleKind;
  count: number;
  /** Most affected agents (top 3 by occurrence count). */
  topAgents: string[];
  /** Most common diagnosis fragments (top 3 by occurrence count). */
  topDiagnoses: string[];
  /** Whether this bucket exceeds the systemic threshold. */
  isSystemic: boolean;
}

export interface ReviewDigest {
  windowMs: number;
  fetchedAt: number;
  totalBugs: number;
  buckets: PatternBucket[];
  systemicCount: number;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

interface PulseItem {
  id?: string | number;
  item_key?: string;
  title: string;
  description?: string;
  status?: string;
  source?: string;
  created_at?: string;
}

interface PulseListResponse {
  results?: PulseItem[];
  next?: string | null;
}

const TERMINAL_STATUSES = new Set([
  'completed', 'cancelled', 'done', 'resolved', 'rejected',
  'duplicate', 'wont_fix', 'closed', 'deferred',
]);

function resolveConfig(c: RunReviewerConfig) {
  const rawId = c.projectId ?? parseInt(process.env['PULSE_PROJECT_ID'] ?? '', 10);
  const rawThreshold = parseInt(process.env['SCLI35_SYSTEMIC_THRESHOLD'] ?? '', 10);
  return {
    pulseBaseUrl:
      c.pulseBaseUrl ??
      process.env['PULSE_INTERNAL_URL'] ??
      'http://shizuha-pulse:8002',
    serviceToken: c.serviceToken ?? process.env['PULSE_SERVICE_TOKEN'] ?? '',
    projectId: Number.isFinite(rawId) && rawId > 0 ? rawId : undefined,
    windowMs: c.windowMs ?? 7 * 24 * 60 * 60 * 1000,
    systemicThreshold: c.systemicThreshold ?? (Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 3),
    maxItems: c.maxItems ?? 200,
  };
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Fetch struggle bugs filed by scli-33-struggle-auto-filer in the look-back window.
 * Pages through results but caps at maxItems.
 */
async function fetchStruggleBugs(
  pulseBaseUrl: string,
  token: string,
  windowMs: number,
  maxItems: number,
): Promise<PulseItem[]> {
  const since = new Date(Date.now() - windowMs).toISOString();
  const url = `${pulseBaseUrl}/api/items/?source=scli-33-struggle-auto-filer&ordering=-created_at&page_size=50&created_at__gte=${encodeURIComponent(since)}`;

  const items: PulseItem[] = [];
  let nextUrl: string | null = url;

  while (nextUrl && items.length < maxItems) {
    const resp = await fetch(nextUrl, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      logger.warn({ status: resp.status, url: nextUrl }, 'SCLI-35: Pulse fetch failed');
      break;
    }
    const data = (await resp.json()) as PulseListResponse;
    const results = data.results ?? [];
    items.push(...results);
    nextUrl = resolveNextUrl(pulseBaseUrl, data.next ?? null);
  }

  return items.slice(0, maxItems);
}

/**
 * Resolve a (possibly relative) DRF `next` pagination link to an absolute URL.
 * DRF commonly returns a path-only `next` (e.g. "/api/items/?page=2"), but
 * Node's fetch() rejects non-absolute URLs — so paging would crash on page 2.
 * Same-origin is enforced so a poisoned link can't redirect us off-platform.
 */
function resolveNextUrl(pulseBaseUrl: string, next: string | null): string | null {
  if (!next) return null;
  const origin = new URL(pulseBaseUrl).origin;
  const resolved = new URL(next, origin);
  if (resolved.origin !== origin) {
    logger.warn({ next }, 'SCLI-35: off-origin pagination link ignored');
    return null;
  }
  return resolved.toString();
}

/** Extract the struggle kind from a task title: "[Struggle/STALL] run:abcd1234 — ..." */
function extractKind(title: string): StruggleKind | null {
  const m = title.match(/\[Struggle\/(STALL|THRASH|ERROR_DENSITY|LONG_RUN)\]/);
  return m ? (m[1] as StruggleKind) : null;
}

/** Extract agent name from description "- **Agent**: <name>" */
function extractAgent(description: string | undefined): string | null {
  if (!description) return null;
  const m = description.match(/\*\*Agent\*\*:\s*(.+)/);
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Extract the short diagnosis line from a description.
 * Uses the "**Diagnosis**: ..." line.
 */
function extractDiagnosis(description: string | undefined): string | null {
  if (!description) return null;
  const m = description.match(/\*\*Diagnosis\*\*:\s*(.+)/);
  return m && m[1] ? m[1].trim().slice(0, 120) : null;
}

/** Returns the top N entries from a frequency map, sorted desc. */
function topEntries(freq: Map<string, number>, n: number): string[] {
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

// ─── Core analysis ────────────────────────────────────────────────────────────

export function analyzePatterns(
  bugs: PulseItem[],
  systemicThreshold: number,
  windowMs: number,
): ReviewDigest {
  const kindCounts = new Map<StruggleKind, { agents: Map<string, number>; diagnoses: Map<string, number> }>();

  for (const bug of bugs) {
    const kind = extractKind(bug.title);
    if (!kind) continue;

    if (!kindCounts.has(kind)) {
      kindCounts.set(kind, { agents: new Map(), diagnoses: new Map() });
    }
    const bucket = kindCounts.get(kind)!;

    const agent = extractAgent(bug.description);
    if (agent) bucket.agents.set(agent, (bucket.agents.get(agent) ?? 0) + 1);

    const diagnosis = extractDiagnosis(bug.description);
    if (diagnosis) bucket.diagnoses.set(diagnosis, (bucket.diagnoses.get(diagnosis) ?? 0) + 1);
  }

  const buckets: PatternBucket[] = [...kindCounts.entries()]
    .map(([kind, data]) => {
      // Count occurrences of this kind directly from the bug list (the per-agent
      // and per-diagnosis maps only track the top-N breakdowns, not the total).
      const exactCount = bugs.filter((b) => extractKind(b.title) === kind).length;
      return {
        kind,
        count: exactCount,
        topAgents: topEntries(data.agents, 3),
        topDiagnoses: topEntries(data.diagnoses, 3),
        isSystemic: exactCount >= systemicThreshold,
      };
    })
    .sort((a, b) => b.count - a.count);

  return {
    windowMs,
    fetchedAt: Date.now(),
    totalBugs: bugs.length,
    buckets,
    systemicCount: buckets.filter((b) => b.isSystemic).length,
  };
}

// ─── Digest task filing ───────────────────────────────────────────────────────

export function buildDigestBody(digest: ReviewDigest, systemicThreshold: number): string {
  const windowDays = Math.round(digest.windowMs / 86_400_000);
  const lines: string[] = [
    `**SCLI-35 Run-Reviewer digest** — auto-generated, ${new Date(digest.fetchedAt).toISOString()}`,
    ``,
    `**Window**: ${windowDays}d | **Total struggle bugs**: ${digest.totalBugs} | **Systemic threshold**: ≥${systemicThreshold} occurrences`,
    ``,
    `## Pattern summary`,
    ``,
  ];

  if (digest.buckets.length === 0) {
    lines.push('_No struggle bugs filed in this window._');
  } else {
    for (const b of digest.buckets) {
      const tag = b.isSystemic ? '🔴 SYSTEMIC' : '🟡 one-off';
      lines.push(`### ${b.kind} — ${b.count} occurrence${b.count !== 1 ? 's' : ''} ${tag}`);
      if (b.topAgents.length) lines.push(`- **Agents**: ${b.topAgents.join(', ')}`);
      if (b.topDiagnoses.length) {
        lines.push(`- **Top diagnoses**:`);
        for (const d of b.topDiagnoses) lines.push(`  - ${d}`);
      }
      lines.push('');
    }
  }

  if (digest.systemicCount > 0) {
    lines.push('');
    lines.push('> **Architecture action**: review the systemic patterns above and re-groom the SCLI backlog.');
  }

  return lines.join('\n');
}

/** Dedup check: is there an open digest task for this kind from this window? */
async function findOpenDigestTask(
  pulseBaseUrl: string,
  token: string,
): Promise<PulseItem | null> {
  const url = `${pulseBaseUrl}/api/items/?search=${encodeURIComponent('[SCLI-35 Digest]')}&page_size=10&ordering=-created_at`;
  try {
    const resp = await fetch(url, {
      headers: authHeaders(token),
      signal: AbortSignal.timeout(8_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as PulseListResponse;
    const results = data.results ?? [];
    return results.find((t) => t.title.includes('[SCLI-35 Digest]') && !TERMINAL_STATUSES.has(t.status ?? '')) ?? null;
  } catch {
    return null;
  }
}

/**
 * Add a comment update to an existing digest task. Comments are nested under
 * the item — POST /api/items/{id}/comments/ — not a top-level /api/comments/
 * collection (which doesn't exist and silently 404s). The caller already
 * resolved the item, so we use its id directly.
 */
async function commentOnDigestTask(
  task: PulseItem,
  pulseBaseUrl: string,
  token: string,
  body: string,
): Promise<void> {
  const id = task.id ?? task.item_key;
  if (id === undefined || id === null || id === '') {
    logger.warn({ key: task.item_key }, 'SCLI-35: cannot comment — digest task has no id');
    return;
  }
  const url = `${pulseBaseUrl}/api/items/${encodeURIComponent(String(id))}/comments/`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ content: body }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    logger.warn({ status: resp.status, key: task.item_key ?? id }, 'SCLI-35: failed to comment on digest task');
  }
}

/** File a new digest task in Pulse routed to the architecture team. */
async function fileDigestTask(
  digest: ReviewDigest,
  cfg: ReturnType<typeof resolveConfig>,
): Promise<string | null> {
  const windowDays = Math.round(digest.windowMs / 86_400_000);
  const systemicSummary = digest.systemicCount > 0
    ? `${digest.systemicCount} systemic pattern${digest.systemicCount !== 1 ? 's' : ''}`
    : 'no systemic patterns';
  const title = `[SCLI-35 Digest] ${windowDays}d struggle review — ${digest.totalBugs} bugs, ${systemicSummary}`;
  const priority = digest.systemicCount >= 5 ? 'high' : digest.systemicCount >= 1 ? 'normal' : 'low';

  const body: Record<string, unknown> = {
    title,
    description: buildDigestBody(digest, cfg.systemicThreshold),
    priority,
    workflow_name: 'simple',
    source: 'scli-35-run-reviewer',
    source_id: `digest:${Math.floor(Date.now() / (24 * 3600 * 1000))}`,
    assignment_group: 'architecture',
    reporter_email: 'aoi@shizuha.com',
  };
  if (cfg.projectId !== undefined) body['project'] = cfg.projectId;

  try {
    const resp = await fetch(`${cfg.pulseBaseUrl}/api/tasks/`, {
      method: 'POST',
      headers: authHeaders(cfg.serviceToken),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      logger.warn({ status: resp.status, body: text.slice(0, 200) }, 'SCLI-35: digest filing failed');
      return null;
    }
    const data = (await resp.json()) as { item_key?: string };
    return data.item_key ?? null;
  } catch (err) {
    logger.warn({ err }, 'SCLI-35: digest filing error (non-fatal)');
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Run one review cycle:
 * 1. Fetch struggle bugs in the window
 * 2. Analyse patterns
 * 3. If there are bugs to report, file or update the digest Pulse task
 *
 * Best-effort — never throws.
 */
export async function runReview(config: RunReviewerConfig = {}): Promise<ReviewDigest | null> {
  const cfg = resolveConfig(config);

  if (!cfg.serviceToken) {
    logger.debug('SCLI-35: PULSE_SERVICE_TOKEN not set — skipping run review');
    return null;
  }

  try {
    const bugs = await fetchStruggleBugs(
      cfg.pulseBaseUrl,
      cfg.serviceToken,
      cfg.windowMs,
      cfg.maxItems,
    );

    const digest = analyzePatterns(bugs, cfg.systemicThreshold, cfg.windowMs);

    logger.info(
      {
        totalBugs: digest.totalBugs,
        systemicCount: digest.systemicCount,
        buckets: digest.buckets.map((b) => ({ kind: b.kind, count: b.count, isSystemic: b.isSystemic })),
      },
      'SCLI-35: run review complete',
    );

    if (digest.totalBugs === 0) {
      // Nothing to report — skip filing
      return digest;
    }

    const existing = await findOpenDigestTask(cfg.pulseBaseUrl, cfg.serviceToken);
    if (existing) {
      const key = existing.item_key ?? String(existing.id ?? '');
      await commentOnDigestTask(existing, cfg.pulseBaseUrl, cfg.serviceToken, buildDigestBody(digest, cfg.systemicThreshold));
      logger.info({ key }, 'SCLI-35: updated existing digest task');
    } else {
      const key = await fileDigestTask(digest, cfg);
      if (key) logger.info({ key }, 'SCLI-35: filed new digest task');
    }

    return digest;
  } catch (err) {
    logger.warn({ err }, 'SCLI-35: unexpected error in runReview (non-fatal)');
    return null;
  }
}

/**
 * Register a periodic run-reviewer using setInterval.
 *
 * @param config  RunReviewerConfig
 * @param intervalMs  How often to run. Default: 24 hours.
 * @returns  Unsubscribe function that clears the interval.
 */
export function setupPeriodicRunReviewer(
  config: RunReviewerConfig = {},
  intervalMs = 24 * 60 * 60 * 1000,
): () => void {
  // Run immediately on setup, then periodically
  runReview(config).catch(() => {/* best-effort */});

  const timer = setInterval(() => {
    runReview(config).catch(() => {/* best-effort */});
  }, intervalMs);

  // Don't hold the process open just for the reviewer
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as NodeJS.Timeout).unref();
  }

  logger.info({ intervalMs }, 'SCLI-35: periodic run-reviewer registered');

  return () => clearInterval(timer);
}
