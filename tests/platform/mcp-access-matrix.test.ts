import { afterEach, describe, it, expect } from 'vitest';
import {
  MCP_ACCESS_MATRIX,
  loadMatrixFromFile,
  _resetMatrixCacheForTest,
  normalizeRole,
  resolveAllowedServers,
  type McpAccessMatrix,
} from '../../src/platform/mcp-access-matrix.js';

// base = core constructs every agent gets: work + messaging + knowledge + the
// org-chart/identity core (admin/id) (operator 2026-06-24).
const BASE = ['pulse', 'connect', 'wiki', 'admin', 'id', 'scs'];
// The defensive fallback when the matrix is structurally broken — minimal, fail-closed.
const MIN_BASE = ['pulse', 'connect', 'wiki'];
const sorted = (s: Set<string>) => [...s].sort();

describe('mcp-access-matrix: resolveAllowedServers (per wiki 288f65e8 §3/§4)', () => {
  it('loads the checked-in mcp_access_matrix.yaml in the standard run and aligns it with the built-in fallback', () => {
    // No MCP_ACCESS_MATRIX_PATH override — this proves the DEFAULT candidate
    // resolution reaches the repo-root YAML in source/CI mode (PLAT-4818 P1). The
    // old `../../../` overshot ABOVE the repo root, so `npm run ci` silently
    // served the built-in fallback and a YAML/fallback drift could pass the gate.
    delete process.env['MCP_ACCESS_MATRIX_PATH'];
    _resetMatrixCacheForTest();
    const fileMatrix = loadMatrixFromFile();
    expect(fileMatrix, 'repo-root mcp_access_matrix.yaml must load without an env override').not.toBeNull();
    // File-backed matrix and built-in fallback must agree across base, roles, and
    // overrides — the exact drift this regression exists to catch.
    expect(sorted(new Set(fileMatrix!.base))).toEqual(sorted(new Set(MCP_ACCESS_MATRIX.base)));
    expect(fileMatrix!.roles ?? {}).toEqual(MCP_ACCESS_MATRIX.roles ?? {});
    expect(fileMatrix!.overrides ?? {}).toEqual(MCP_ACCESS_MATRIX.overrides ?? {});
    // And the fallback base still equals the documented base literal.
    expect(sorted(new Set(MCP_ACCESS_MATRIX.base))).toEqual(sorted(new Set(BASE)));
  });

  it('every role includes the universal base {pulse, connect, wiki, admin, id, scs}', () => {
    for (const role of ['reviewer', 'architect', 'engineer', 'qa', 'security', 'docs', 'analytics', 'accounting', 'devops', 'social']) {
      const allowed = resolveAllowedServers(role);
      for (const b of BASE) expect(allowed.has(b)).toBe(true);
    }
  });

  it('reviewer → base only', () => {
    expect(sorted(resolveAllowedServers('reviewer'))).toEqual(sorted(new Set(BASE)));
  });

  it('engineer → base only', () => {
    expect(sorted(resolveAllowedServers('engineer'))).toEqual(sorted(new Set(BASE)));
  });

  it('qa → base only (product MCP is per-task override, not standing)', () => {
    expect(sorted(resolveAllowedServers('qa'))).toEqual(sorted(new Set(BASE)));
  });

  it('architect → base only (admin/id now in base)', () => {
    expect(sorted(resolveAllowedServers('architect'))).toEqual(sorted(new Set(BASE)));
  });

  it('security → base only (admin/id now in base)', () => {
    expect(sorted(resolveAllowedServers('security'))).toEqual(sorted(new Set(BASE)));
  });

  it('docs → base + drive', () => {
    expect(sorted(resolveAllowedServers('docs'))).toEqual(sorted(new Set([...BASE, 'drive'])));
  });

  it('analytics → base + finance, books, inventory', () => {
    expect(sorted(resolveAllowedServers('analytics'))).toEqual(
      sorted(new Set([...BASE, 'finance', 'books', 'inventory'])),
    );
  });

  it('accounting → base + tenant-selected books and drive', () => {
    expect(sorted(resolveAllowedServers('accounting'))).toEqual(
      sorted(new Set([...BASE, 'books', 'drive'])),
    );
    expect(sorted(resolveAllowedServers('Accountant'))).toEqual(
      sorted(new Set([...BASE, 'books', 'drive'])),
    );
    expect(sorted(resolveAllowedServers('Accountant — Shizuha Digital LLP'))).toEqual(
      sorted(new Set([...BASE, 'books', 'drive'])),
    );
  });

  it('devops → base + cron + hive (role-gated sensitive servers; admin is base)', () => {
    expect(sorted(resolveAllowedServers('devops'))).toEqual(sorted(new Set([...BASE, 'cron', 'hive'])));
  });

  it('social → base + drive', () => {
    expect(sorted(resolveAllowedServers('social'))).toEqual(sorted(new Set([...BASE, 'drive'])));
  });

  // ── FAIL CLOSED ──
  it('unknown role → base only (fail closed, never all-servers)', () => {
    expect(sorted(resolveAllowedServers('Wizard'))).toEqual(sorted(new Set(BASE)));
  });

  it('null / undefined / empty role → base only', () => {
    for (const r of [null, undefined, '', '   '] as Array<string | null | undefined>) {
      expect(sorted(resolveAllowedServers(r))).toEqual(sorted(new Set(BASE)));
    }
  });

  it('malformed matrix (no base) still fails closed to the minimal default base', () => {
    const bad = { roles: {}, overrides: {} } as unknown as McpAccessMatrix;
    expect(sorted(resolveAllowedServers('engineer', undefined, undefined, bad))).toEqual(sorted(new Set(MIN_BASE)));
  });

  // ── default-deny tail (§3): granted to NO role by default ──
  it('default-deny tail servers are never present for any role without an override', () => {
    const tail = ['google-drive', 'ori', 'mail', 'notes', 'hr', 'time'];
    for (const role of ['reviewer', 'architect', 'engineer', 'qa', 'security', 'docs', 'analytics', 'devops', 'social']) {
      const allowed = resolveAllowedServers(role, 'someagent');
      for (const t of tail) expect(allowed.has(t)).toBe(false);
    }
  });

  // ── per-agent overrides (§4), applied last ──
  it('override.add grants an extra server (e.g. QA task-scoped product MCP)', () => {
    const m: McpAccessMatrix = { ...MCP_ACCESS_MATRIX, overrides: { zen: { add: ['inventory'] } } };
    const allowed = resolveAllowedServers('qa', 'zen', undefined, m);
    expect(allowed.has('inventory')).toBe(true);
    expect(sorted(allowed)).toEqual(sorted(new Set([...BASE, 'inventory'])));
  });

  it('override.remove revokes — even a base server — and wins (applied last)', () => {
    const m: McpAccessMatrix = { ...MCP_ACCESS_MATRIX, overrides: { x: { remove: ['wiki'] } } };
    const allowed = resolveAllowedServers('engineer', 'x', undefined, m);
    expect(allowed.has('wiki')).toBe(false);
    expect(allowed.has('pulse')).toBe(true);
  });

  it('override only applies to the matching agentId', () => {
    const m: McpAccessMatrix = { ...MCP_ACCESS_MATRIX, overrides: { zen: { add: ['inventory'] } } };
    expect(resolveAllowedServers('qa', 'other', undefined, m).has('inventory')).toBe(false);
  });

  // ── capability union: skills[] tags add servers, unioned with role (operator 2026-06-24) ──
  it('skills[] capability tags add servers unioned with the role', () => {
    // engineer role = base only; the data-analysis skill tag adds the analytics servers.
    const allowed = resolveAllowedServers('engineer', 'a', ['data-analysis', 'backend', 'debugging']);
    expect(sorted(allowed)).toEqual(sorted(new Set([...BASE, 'finance', 'books', 'inventory'])));
  });

  it('multi-capability agent gets the UNION of role + skill server sets', () => {
    // role devops (+cron +hive) ∪ docs skill (+drive) → cron/hive from role, drive from skill.
    const allowed = resolveAllowedServers('DevOps Engineer', 'b', ['technical-writing', 'kubernetes']);
    expect(sorted(allowed)).toEqual(sorted(new Set([...BASE, 'cron', 'hive', 'drive'])));
  });

  it('unrecognised concrete skill tags grant nothing (fail closed, least-privilege)', () => {
    const allowed = resolveAllowedServers('reviewer', 'c', ['git-workflow', 'testing', 'roadmap']);
    expect(sorted(allowed)).toEqual(sorted(new Set(BASE)));
  });

  it('product-management capability grants drive', () => {
    expect(sorted(resolveAllowedServers('Product Manager', 'd', ['product-management'])))
      .toEqual(sorted(new Set([...BASE, 'drive'])));
  });

  // ── TIERING: a SKILL tag cannot unlock the role-gated sensitive server (cron) ──
  it('a devops SKILL tag does NOT grant cron/hive (role-gated); a devops ROLE does', () => {
    // engineer + 'devops' skill → cron/hive stay gated (engineer is not a devops role).
    const viaSkill = resolveAllowedServers('engineer', 'k', ['devops', 'data-analysis']);
    expect(viaSkill.has('cron')).toBe(false);           // gated — skills can't grant cron
    expect(viaSkill.has('hive')).toBe(false);           // gated — skills can't grant hive (agent lifecycle)
    expect(viaSkill.has('finance')).toBe(true);         // safe data server from data-analysis IS granted
    // A real devops ROLE grants both cron and hive.
    const viaRole = resolveAllowedServers('DevOps Engineer', 'k2', []);
    expect(viaRole.has('cron')).toBe(true);
    expect(viaRole.has('hive')).toBe(true);
  });

  it('override.remove wins over a base server (admin)', () => {
    const m: McpAccessMatrix = { ...MCP_ACCESS_MATRIX, overrides: { e: { remove: ['admin'] } } };
    const allowed = resolveAllowedServers('engineer', 'e', ['devops'], m);
    expect(allowed.has('admin')).toBe(false); // base admin explicitly revoked
    expect(allowed.has('id')).toBe(true);     // other base servers untouched
  });
});

describe('mcp-access-matrix: normalizeRole (slugs + display names + capability tags)', () => {
  it('maps display names to matrix keys', () => {
    expect(normalizeRole('Code Reviewer')).toBe('reviewer');
    expect(normalizeRole('QA Engineer')).toBe('qa');
    expect(normalizeRole('Security Engineer')).toBe('security');
    expect(normalizeRole('Technical Writer')).toBe('docs');
    expect(normalizeRole('Data Analyst')).toBe('analytics');
    expect(normalizeRole('Engineer')).toBe('engineer');
    expect(normalizeRole('Architect')).toBe('architect');
    expect(normalizeRole('DevOps Engineer')).toBe('devops');
    expect(normalizeRole('Social Media Manager')).toBe('social'); // nori — drive grant
    expect(normalizeRole('Product Manager')).toBe('product');
  });

  it('maps role slugs + skill capability tags to matrix keys', () => {
    expect(normalizeRole('qa_engineer')).toBe('qa');
    expect(normalizeRole('security_engineer')).toBe('security');
    expect(normalizeRole('data_analyst')).toBe('analytics');
    expect(normalizeRole('technical_writer')).toBe('docs');
    // skill[] capability tags
    expect(normalizeRole('security-audit')).toBe('security');
    expect(normalizeRole('data-analysis')).toBe('analytics');
    expect(normalizeRole('product-management')).toBe('product');
    expect(normalizeRole('technical-writing')).toBe('docs');
    expect(normalizeRole('code-review')).toBe('reviewer');
  });

  it('concrete (non-capability) skill tags → null (grant nothing)', () => {
    for (const t of ['kubernetes', 'backend', 'frontend', 'debugging', 'roadmap', 'git-workflow', 'testing']) {
      expect(normalizeRole(t)).toBeNull();
    }
  });

  it('unknown / empty → null (caller fails closed)', () => {
    expect(normalizeRole('Wizard')).toBeNull();
    expect(normalizeRole('')).toBeNull();
    expect(normalizeRole(null)).toBeNull();
    expect(normalizeRole(undefined)).toBeNull();
  });
});

// ── PLAT-309 singleton overrides + SCLI-46 env-intersection invariant ────────
describe('mcp-access-matrix: PLAT-309 overrides (shizuha / shion) × SHIZUHA_MCP_SERVICES narrowing', () => {
  const savedEnv = process.env['SHIZUHA_MCP_SERVICES'];
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['SHIZUHA_MCP_SERVICES'];
    else process.env['SHIZUHA_MCP_SERVICES'] = savedEnv;
  });

  it('shizuha (PA): base covers admin+id, override adds cron → {base, cron}', () => {
    // normalizeRole('General Assistant') = null → base-only ceiling; cron comes from override.
    expect(sorted(resolveAllowedServers('General Assistant', 'shizuha'))).toEqual(
      sorted(new Set([...BASE, 'cron'])),
    );
  });

  it('shizuha role strings are intentionally unmapped → normalizeRole returns null', () => {
    expect(normalizeRole('General Assistant')).toBeNull();
    expect(normalizeRole('Deputy Chief of Staff')).toBeNull();
  });

  it('shion (Deputy CoS): no standing extras — base only (admin/id from base)', () => {
    expect(sorted(resolveAllowedServers('General Assistant', 'shion'))).toEqual(
      sorted(new Set(BASE)),
    );
  });

  it('CEO Office seats keep the platform base and add Hive', () => {
    const expected = sorted(new Set([...BASE, 'hive']));
    expect(sorted(resolveAllowedServers('General Assistant', 'hina'))).toEqual(expected);
    expect(sorted(resolveAllowedServers('General Assistant', 'aya'))).toEqual(expected);
    expect(sorted(resolveAllowedServers('General Assistant', 'yuna'))).toEqual(expected);
    expect(sorted(resolveAllowedServers('General Assistant', 'ena'))).toEqual(expected);
  });

  it('General Assistant role without override → base only (fail-closed)', () => {
    expect(sorted(resolveAllowedServers('General Assistant', 'someone-else'))).toEqual(
      sorted(new Set(BASE)),
    );
  });

  // Core SCLI-46 invariant: SHIZUHA_MCP_SERVICES env-narrowing wins even for base/override servers.
  it('SHIZUHA_MCP_SERVICES env narrows base + override servers (operator lever wins)', async () => {
    const { resolveMcpAllowList } = await import('../../src/platform/mcp-services.js');
    process.env['SHIZUHA_MCP_SERVICES'] = 'pulse,wiki,connect';
    const matrixAllowed = resolveAllowedServers('General Assistant', 'shizuha');
    expect(matrixAllowed.has('admin')).toBe(true); // base granted it
    expect(matrixAllowed.has('cron')).toBe(true);  // override granted it
    const final = resolveMcpAllowList([...matrixAllowed]);
    expect(final).toEqual(new Set(['pulse', 'wiki', 'connect']));
    expect(final!.has('admin')).toBe(false);
    expect(final!.has('id')).toBe(false);
    expect(final!.has('cron')).toBe(false);
  });
});
