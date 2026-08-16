/**
 * SCLI-44 (SCLI-43.2) + SCLI-67 (SCLI-46): Canonical Role → MCP-Server
 * access-matrix + the default-deny resolver the runtime connect-filter uses.
 *
 * Source of truth: `mcp_access_matrix.yaml` in the repo root (SCLI-67).
 * The built-in TS const below is the authoritative fallback when the file
 * is absent, unreadable, or malformed — ensuring the filter always works.
 *
 * Algorithm (§4): allowed = base ∪ roles[role] ∪ overrides[agent].add
 *                            − overrides[agent].remove.
 * FAIL CLOSED: unknown/unset/malformed role → `base` only, NEVER all servers.
 * Server names are the logical `PLATFORM_MCP_SERVICES[].name` (the runtime maps
 * them to the `shizuha-{name}` mcp keys).
 *
 * Hot-reload: resolveAllowedServers re-reads the file at most every
 * MCP_MATRIX_RELOAD_TTL_MS (env, default 60 000 ms). Set to "0" to disable.
 * No daemon restart required for matrix edits — changes take effect within
 * one TTL window.
 */

import { createRequire } from 'node:module';
import {
  LEAN_CONVERSATIONAL_MCP,
  LEAN_CONVERSATIONAL_USERNAMES,
  LEAN_TRIMMABLE_PLATFORM_MCP,
  isLeanConversationalEnv,
} from './lean-conversational.js';

/** A role row in the access-matrix (logical role key → its non-base servers). */
export type MatrixRole =
  | 'reviewer'
  | 'architect'
  | 'engineer'
  | 'qa'
  | 'security'
  | 'docs'
  | 'analytics'
  | 'accounting'
  | 'devops'
  | 'social'
  | 'product';

export interface McpAccessMatrix {
  /** Universal base — connected for EVERY task-driven agent (§2.2). */
  base: string[];
  /** role key → additional (non-base) servers granted to that role (§3). */
  roles: Record<MatrixRole, string[]>;
  /** per-agent grants/revocations, applied last (§4). Keyed by agent username. */
  overrides: Record<string, { add?: string[]; remove?: string[] }>;
}

/**
 * Servers a SKILL tag may NOT grant — they need a real role or an explicit
 * per-agent override (operator 2026-06-24). With admin/id in `base` (core
 * constructs almost every agent needs), the role-gated sensitive servers are
 * `cron` (host exec + agent lifecycle) and `hive` (claw/agent lifecycle mgmt via
 * MCP — create/pause/delete/restart agents, HIVE-435; comparably privileged to
 * cron). Keeping them out of skill-grants means listing `devops` as one of many
 * skills never silently unlocks host/agent-lifecycle control (a real devops ROLE
 * or explicit per-agent override still grants them).
 */
export const SKILL_GATED_SERVERS = new Set<string>(['cron', 'hive']);

/**
 * The canonical matrix (wiki §3). `base = {pulse, connect, wiki, admin, id, scs}`
 * for every row — pulse/connect/wiki for work+messaging+knowledge, admin/id as
 * core org-chart/identity constructs (operator 2026-06-24), and SCS for the
 * shared apps estate (operator 2026-07-11). Roles add only what's beyond that;
 * an empty list = base-only (intentional default-deny, not an omission).
 */
export const MCP_ACCESS_MATRIX: McpAccessMatrix = {
  base: ['pulse', 'connect', 'wiki', 'admin', 'id', 'scs'],
  roles: {
    reviewer: [], // revi + board (aoi/akira): review = GitHub CLI + base. Base-only (PLAT-213).
    architect: [], // org-chart/team routing + identity lookups now come from base.
    engineer: [], // code work = GitHub CLI / repos / host, not MCP. `drive` via skill/override if needed.
    qa: [], // base + the product MCP under test, granted PER-TASK via override (not standing) — §3/§6.
    security: [], // audits/access reviews use admin+id, now in base.
    docs: ['drive'], // attachments / exports / asset links.
    analytics: ['finance', 'books', 'inventory'], // metrics/dashboards over active data services.
    accounting: ['books', 'drive'], // tenant-selected books + evidence/report storage.
    devops: ['cron', 'hive'], // cron = host exec / agent mgmt; hive = claw/agent lifecycle mgmt via MCP (HIVE-435).
    social: ['drive'], // media assets (feed posting is `connect`, already base).
    product: ['drive'], // PRDs/specs/roadmap attachments + exports.
  },
  // Per-agent overrides (PLAT-309 singleton roles — intentionally unmapped roles
  // whose non-base access comes exclusively from these entries, not the role table).
  overrides: {
    // shizuha: Chief of Staff (role = "General Assistant", intentionally unmapped).
    // admin/id now base; the standing extra is agent lifecycle (cron).
    shizuha: { add: ['cron'] },
    // shion: Deputy Chief of Staff — admin/id now base; no standing extras (add cron via override if needed).
    shion: { add: [] },
    // CEO Office talk seats are proper agents (operator 2026-08-16). Keep
    // the platform base and add Hive so they can list/inspect fleet agents.
    hina: { add: ['hive'] },
    aya: { add: ['hive'] },
    yuna: { add: ['hive'] },
    ena: { add: ['hive'] },
  },
};

// ─── SCLI-67: file loader + hot-reload cache ──────────────────────────────────

/**
 * Minimal YAML parser for the mcp_access_matrix.yaml structure.
 * Handles exactly: top-level keys → (string[], map→string[], map→map→string[]).
 * Comments, blank lines, and the 2-space indent convention are supported.
 * Returns null on any structural error so the caller falls back to the built-in
 * const (fail-closed guarantee — a malformed file never silently grants access).
 */
function parseMatrixYaml(src: string): McpAccessMatrix | null {
  try {
    const lines = src.split('\n');
    const result: {
      base?: string[];
      roles?: Record<string, string[]>;
      overrides?: Record<string, { add?: string[]; remove?: string[] }>;
    } = {};

    let section = '';   // 'base' | 'roles' | 'overrides'
    let subKey = '';    // role name or agent name
    let subSubKey = ''; // 'add' | 'remove'

    for (const rawLine of lines) {
      const line = rawLine.replace(/#.*$/, '').trimEnd();
      if (!line.trim()) continue;

      const indent = line.length - line.trimStart().length;
      const content = line.trim();

      if (indent === 0) {
        const m = content.match(/^(\w+)\s*:\s*(.*)$/);
        if (!m || !m[1]) continue;
        section = m[1];
        subKey = '';
        subSubKey = '';
        const val = (m[2] ?? '').trim();
        if (section === 'base') result.base = val === '[]' ? [] : [];
        else if (section === 'roles') result.roles = {};
        else if (section === 'overrides') result.overrides = {};
      } else if (indent === 2) {
        if (!section) continue;
        const listM = content.match(/^-\s+(.+)$/);
        if (listM && listM[1]) {
          // top-level list item (base)
          if (section === 'base') {
            if (!result.base) result.base = [];
            result.base.push(listM[1]);
          }
          continue;
        }
        const km = content.match(/^(\w+)\s*:\s*(.*)$/);
        if (!km || !km[1]) continue;
        subKey = km[1];
        subSubKey = '';
        const val = (km[2] ?? '').trim();
        if (section === 'roles') {
          if (!result.roles) result.roles = {};
          result.roles[subKey] = val === '[]' ? [] : [];
        } else if (section === 'overrides') {
          if (!result.overrides) result.overrides = {};
          result.overrides[subKey] = {};
        }
      } else if (indent === 4) {
        if (!section || !subKey) continue;
        if (section === 'roles') {
          const listM = content.match(/^-\s+(.+)$/);
          if (listM && listM[1]) {
            if (!result.roles) result.roles = {};
            if (!result.roles[subKey]) result.roles[subKey] = [];
            result.roles[subKey]!.push(listM[1]);
          }
        } else if (section === 'overrides') {
          const km = content.match(/^(\w+)\s*:\s*(.*)$/);
          if (km && km[1]) {
            subSubKey = km[1]; // 'add' | 'remove'
            if (!result.overrides) result.overrides = {};
            if (!result.overrides[subKey]) result.overrides[subKey] = {};
            const val = (km[2] ?? '').trim();
            (result.overrides[subKey] as Record<string, string[]>)[subSubKey] =
              val === '[]' ? [] : [];
          }
        }
      } else if (indent === 6) {
        if (!section || !subKey || !subSubKey) continue;
        if (section === 'overrides') {
          const listM = content.match(/^-\s+(.+)$/);
          if (listM && listM[1]) {
            if (!result.overrides) result.overrides = {};
            if (!result.overrides[subKey]) result.overrides[subKey] = {};
            const ov = result.overrides[subKey] as Record<string, string[]>;
            if (!ov[subSubKey]) ov[subSubKey] = [];
            ov[subSubKey]!.push(listM[1]);
          }
        }
      }
    }

    // Validate required fields.
    if (!Array.isArray(result.base) || result.base.length === 0) return null;
    if (!result.roles || typeof result.roles !== 'object') return null;
    return {
      base: result.base,
      roles: result.roles as Record<MatrixRole, string[]>,
      overrides: result.overrides ?? {},
    };
  } catch {
    return null;
  }
}

interface MatrixCache {
  matrix: McpAccessMatrix;
  loadedAt: number; // Date.now() equivalent via performance.now() epoch
  filePath: string;
}
let _matrixCache: MatrixCache | null = null;

/** Default paths to search for the YAML matrix file. */
const MATRIX_FILE_CANDIDATES = [
  // 1. Explicit env override (highest priority)
  process.env['MCP_ACCESS_MATRIX_PATH'] ?? '',
  // 2. Persistent workspace volume — survives fleet rolls
  '/workspace/mcp_access_matrix.yaml',
  // 3. Repo root. Both src/platform (dev/ci source) and dist/platform (built,
  //    outDir=dist/rootDir=src) sit exactly two levels below the repo root, so
  //    `../../` reaches the checked-in YAML in BOTH modes. PLAT-4818: the old
  //    `../../../` overshot ABOVE the repo root, so the standard source-mode run
  //    (`npm run ci`) never read the file and silently served the built-in
  //    fallback — a YAML/fallback drift could pass the full-suite gate.
  new URL('../../mcp_access_matrix.yaml', import.meta.url).pathname,
  // 4. Legacy relative depth, kept for any deeper bundled layout.
  new URL('../../../mcp_access_matrix.yaml', import.meta.url).pathname,
  // 5. Process CWD — npm/vitest run from the repo root.
  process.cwd() + '/mcp_access_matrix.yaml',
].filter(Boolean);

/**
 * Load the access matrix from the YAML file. Returns null when no file is
 * found or the file is malformed — caller falls back to MCP_ACCESS_MATRIX.
 * Results are TTL-cached (MCP_MATRIX_RELOAD_TTL_MS env, default 60 000 ms).
 * Set MCP_MATRIX_RELOAD_TTL_MS=0 to disable hot-reload (pin to first load).
 */
/** PLAT-4818: reset the TTL cache so a test can force a fresh file load. */
export function _resetMatrixCacheForTest(): void {
  _matrixCache = null;
}

export function loadMatrixFromFile(): McpAccessMatrix | null {
  const ttlMs = parseInt(process.env['MCP_MATRIX_RELOAD_TTL_MS'] ?? '60000', 10);
  const now = Date.now();

  // Return cached value if still fresh.
  if (_matrixCache && (ttlMs === 0 || now - _matrixCache.loadedAt < ttlMs)) {
    return _matrixCache.matrix;
  }

  // ESM-safe fs access (aoi, SCLI-44): a BARE `require` is undefined under tsx /
  // `npm run dev` source mode, so the old code silently skipped the file and served
  // the built-in fallback — for a SECURITY matrix, quietly ignoring hot-reloaded
  // grants/revokes (and throwing on the source-mode startup path) is a real failure.
  // createRequire(import.meta.url) resolves node:fs in BOTH the bundled-ESM and
  // tsx-source runtimes, so the file-backed matrix is honored everywhere; the catch
  // only fires on a genuine fs error, falling back to the const matrix.
  let fs: typeof import('node:fs');
  try {
    const nodeRequire = createRequire(import.meta.url);
    fs = nodeRequire('node:fs');
  } catch {
    _matrixCache = null;
    return null;
  }
  for (const candidate of MATRIX_FILE_CANDIDATES) {
    if (!candidate) continue;
    try {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = parseMatrixYaml(raw);
      if (parsed) {
        _matrixCache = { matrix: parsed, loadedAt: now, filePath: candidate };
        return parsed;
      }
    } catch {
      // file not found or unreadable — try next candidate
    }
  }
  // No file found or all malformed — clear cache so next call retries.
  _matrixCache = null;
  return null;
}

/**
 * Normalise a capability tag to a matrix capability key. The input is either an
 * agent's `role` (DB/agents.json — a slug like `qa_engineer` or a display name
 * like `QA Engineer` / `Code Reviewer`) OR one of its `skills[]` capability tags
 * (e.g. `security-audit`, `data-analysis`, `product-management`). Both feed the
 * same matrix (resolveAllowedServers unions over role + skills).
 *
 * Returns null when unrecognised → caller fails closed (grants no extra servers).
 * CONCRETE skill tags that don't imply a capability (`kubernetes`, `backend`,
 * `debugging`, `roadmap`, `git-workflow`, …) intentionally fall through to null:
 * they must not silently widen MCP access (least-privilege).
 */
export function normalizeRole(role: string | null | undefined): MatrixRole | null {
  if (!role || typeof role !== 'string') return null;
  // Hive display roles may append the organization after an em dash
  // ("Accountant — Shizuha Digital LLP"). The organization is selection
  // context, not part of the capability role; strip only that explicit suffix.
  const k = role.trim().toLowerCase().replace(/\s+[—–|]\s+.*$/, '').replace(/[\s_-]+/g, '');
  switch (k) {
    case 'reviewer':
    case 'codereviewer':
    case 'codereview':
    case 'juniorcodereviewer':
    case 'juniorreviewer':
      return 'reviewer';
    case 'architect':
    case 'architecture':
      return 'architect';
    case 'engineer':
    case 'softwareengineer':
    case 'fullstackengineer':
      return 'engineer';
    case 'qa':
    case 'qaengineer':
    case 'qatester':
      return 'qa';
    case 'security':
    case 'securityengineer':
    case 'securitytriage':
    case 'securityaudit':
    case 'securityanalysis':
      return 'security';
    case 'docs':
    case 'documentation':
    case 'technicalwriter':
    case 'technicalwriting':
    case 'writer':
      return 'docs';
    case 'analytics':
    case 'dataanalyst':
    case 'dataanalysis':
    case 'analyst':
      return 'analytics';
    case 'accounting':
    case 'accountant':
    case 'bookkeeper':
    case 'bookkeeping':
      return 'accounting';
    case 'devops':
    case 'devopsengineer':
    case 'sre':
      return 'devops';
    case 'social':
    case 'socialmedia':
    case 'socialmediamanager':
      return 'social';
    case 'product':
    case 'productmanagement':
    case 'productmanager':
      return 'product';
    default:
      return null;
  }
}

/**
 * Resolve the set of MCP servers (logical names) an agent may connect.
 *
 * allowed = base
 *         ∪ roles[role]                              ← full role grant (any server)
 *         ∪ ⋃ (roles[skill] − SENSITIVE)  for skill in capabilities[]
 *         ∪ overrides[agent].add − overrides[agent].remove
 *
 * The capability set is the agent's `role` PLUS its `skills[]` capability tags
 * (the same per-agent list that drives skill selection — operator 2026-06-24),
 * each normalised through `normalizeRole`. TIERING (operator 2026-06-24): the
 * ROLE may grant any server, but a SKILL tag may only grant the safe
 * data/content servers — the sensitive trio {admin, cron, id} stays ROLE-gated,
 * so listing `devops`/`security-audit` as one of many skills never silently
 * unlocks org-management / host-exec / identity-enumeration access. This keeps
 * the union least-privilege: skills compose the safe servers; privilege needs a
 * real role (or an explicit per-agent override).
 *
 * FAIL CLOSED: no recognised capability → `base` only. `remove` can trim even
 * base servers (explicit per-agent revoke), applied LAST so it always wins.
 *
 * Matrix source priority (SCLI-67):
 *  1. Explicit `matrix` argument (for tests / direct callers)
 *  2. mcp_access_matrix.yaml file (hot-reloadable, survives fleet rolls)
 *  3. Built-in MCP_ACCESS_MATRIX const (fallback — always present)
 */
export function resolveAllowedServers(
  role: string | null | undefined,
  agentId?: string | null,
  capabilities?: readonly string[] | null,
  matrix?: McpAccessMatrix,
): Set<string> {
  // Resolve matrix: explicit arg → file → built-in const (fail-closed chain).
  const activeMatrix: McpAccessMatrix =
    matrix ?? loadMatrixFromFile() ?? MCP_ACCESS_MATRIX;
  // Defensive: a malformed matrix must still fail closed to a sane base.
  const base = Array.isArray(activeMatrix?.base) ? activeMatrix.base : ['pulse', 'connect', 'wiki'];
  const allowed = new Set<string>(base);

  // Union over the agent's capability set: role + skills[] tags. Each maps
  // through normalizeRole; recognised → adds its servers, unrecognised → nothing
  // (fail closed). Dedup via Set so the same capability from role and skills is harmless.
  // Role grant: unrestricted (a real role may grant any server).
  const roleKey = normalizeRole(role);
  if (roleKey && activeMatrix?.roles && Array.isArray(activeMatrix.roles[roleKey])) {
    for (const s of activeMatrix.roles[roleKey]) allowed.add(s);
  }
  // Skill grants: TIERED — a skill tag may add the safe data/content servers but
  // NOT the role-gated sensitive ones (operator 2026-06-24). With admin/id in
  // base, `cron` (host exec + agent lifecycle) and `hive` (claw/agent lifecycle
  // mgmt, HIVE-435) are the servers a skill cannot unlock; they need a real
  // devops role or an explicit per-agent override.
  for (const tag of capabilities ?? []) {
    const key = normalizeRole(tag);
    if (key && activeMatrix?.roles && Array.isArray(activeMatrix.roles[key])) {
      for (const s of activeMatrix.roles[key]) if (!SKILL_GATED_SERVERS.has(s)) allowed.add(s);
    }
  }

  const ov = agentId && activeMatrix?.overrides ? activeMatrix.overrides[agentId] : undefined;
  if (ov) {
    if (Array.isArray(ov.add)) for (const s of ov.add) allowed.add(s);
    if (Array.isArray(ov.remove)) for (const s of ov.remove) allowed.delete(s);
  }
  const leanById = Boolean(agentId && LEAN_CONVERSATIONAL_USERNAMES.has(agentId.toLowerCase()));
  if (isLeanConversationalEnv() || leanById) {
    for (const extra of LEAN_TRIMMABLE_PLATFORM_MCP) allowed.delete(extra);
    for (const required of LEAN_CONVERSATIONAL_MCP) allowed.add(required);
  }
  return allowed;
}
