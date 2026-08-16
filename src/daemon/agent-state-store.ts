/**
 * AgentStateStore — PLAT-1062 P1 (HLD PLAT-1061 / epic PLAT-706).
 *
 * Single durable desired-state store for agent config + enabled/disabled state,
 * backed by SQLite in WAL mode. This is the foundation slice: the typed mutation
 * service + schema + JSON migration import/export. It does NOT yet replace the
 * live write path (`agents.json` / `enabled-agents.json` / `disabled-agents.json`)
 * — that cutover is P2 (and carries the security review of the privileged
 * enable/disable control surface, HLD §10). Landing this module is purely
 * additive: nothing imports it into the hot path yet.
 *
 * Invariants implemented here (HLD §2):
 *  - INV-1: desired config + enabled/disabled live in one DB; JSON is import/export only.
 *  - INV-2: every mutation goes through one of the typed commands below.
 *  - INV-5: `operator_disabled` is fail-closed and distinct from user `desired_enabled`;
 *           an operator-disabled agent is never effectively-enabled unless an explicit
 *           override clears it (see `setDesiredEnabled({overrideKillSwitch})`).
 *  - per-row monotonic `version` + an append-only `agent_state_event` audit trail.
 *
 * Concurrency: better-sqlite3 is synchronous; mutations run in IMMEDIATE
 * transactions so concurrent dashboard/MCP/CLI writers queue instead of
 * interleaving stale read-modify-write. `updateAgent` additionally supports
 * optimistic concurrency via `expectedVersion` (throws StaleVersionError on conflict).
 *
 * SQLite WAL: https://sqlite.org/wal.html
 */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { AgentInfo } from './types.js';

export type RuntimeKind = 'child_process' | 'docker' | 'k8s';
export type AgentStateEventType =
  | 'created' | 'updated' | 'enabled' | 'disabled'
  | 'started' | 'stopped' | 'drift' | 'reconciled' | 'deleted';

export interface AgentRow {
  id: string;
  username: string;
  email: string | null;
  name: string;
  role: string | null;
  team: string | null;
  runtime_environment: string;
  execution_method: string | null;
  model: string | null;
  model_fallbacks_json: string | null;
  model_overrides_json: string | null;
  skills_json: string;
  env_json: string | null;
  resource_limits_json: string | null;
  desired_enabled: number;
  operator_disabled: number;
  desired_status: string;
  version: number;
  updated_at: string;
  created_at: string;
}

export interface AgentObservation {
  observed_state: string;
  runtime_kind: RuntimeKind;
  container_or_pod?: string | null;
  pid?: number | null;
  last_error?: string | null;
}

export interface AgentObservationRow extends Required<Omit<AgentObservation, 'pid' | 'container_or_pod' | 'last_error'>> {
  agent_id: string;
  container_or_pod: string | null;
  pid: number | null;
  last_seen_at: string;
  last_error: string | null;
}

export interface CreateAgentSpec {
  id?: string;
  username: string;
  email?: string | null;
  name: string;
  role?: string | null;
  team?: string | null;
  runtimeEnvironment?: string;
  executionMethod?: string | null;
  model?: string | null;
  modelFallbacks?: unknown;
  modelOverrides?: unknown;
  skills?: string[];
  env?: Record<string, string> | null;
  resourceLimits?: unknown;
  desiredEnabled?: boolean;
  operatorDisabled?: boolean;
}

export type AgentJsonExport = Partial<AgentInfo> & {
  id: string;
  username: string;
  name: string;
  desiredEnabled: boolean;
  operatorDisabled: boolean;
};

/** Thrown by updateAgent when expectedVersion does not match the committed row. */
export class StaleVersionError extends Error {
  constructor(public readonly agentId: string, public readonly expected: number, public readonly actual: number) {
    super(`stale version for agent ${agentId}: expected ${expected}, found ${actual}`);
    this.name = 'StaleVersionError';
  }
}

export class UnknownAgentError extends Error {
  constructor(public readonly agentId: string) {
    super(`unknown agent: ${agentId}`);
    this.name = 'UnknownAgentError';
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT,
  name TEXT NOT NULL,
  role TEXT,
  team TEXT,
  runtime_environment TEXT NOT NULL,
  execution_method TEXT,
  model TEXT,
  model_fallbacks_json TEXT,
  model_overrides_json TEXT,
  skills_json TEXT NOT NULL DEFAULT '[]',
  env_json TEXT,
  resource_limits_json TEXT,
  desired_enabled INTEGER NOT NULL DEFAULT 0,
  operator_disabled INTEGER NOT NULL DEFAULT 0,
  desired_status TEXT NOT NULL DEFAULT 'stopped',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runtime_observation (
  agent_id TEXT PRIMARY KEY REFERENCES agent(id) ON DELETE CASCADE,
  observed_state TEXT NOT NULL,
  runtime_kind TEXT NOT NULL,
  container_or_pod TEXT,
  pid INTEGER,
  last_seen_at TEXT NOT NULL,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS agent_state_event (
  event_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  desired_version INTEGER NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  payload_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_agent ON agent_state_event(agent_id, created_at);
`;

export class AgentStateStore {
  private readonly db: Database.Database;

  constructor(filename = ':memory:') {
    this.db = new Database(filename);
    // WAL improves reader/writer concurrency for the file-backed daemon store;
    // no-op but harmless for :memory: test instances.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  close(): void { this.db.close(); }

  // ── Reads ──────────────────────────────────────────────────────────────
  getAgent(agentId: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agent WHERE id = ?').get(agentId) as AgentRow | undefined;
  }
  getByUsername(username: string): AgentRow | undefined {
    return this.db.prepare('SELECT * FROM agent WHERE username = ?').get(username) as AgentRow | undefined;
  }
  listAgents(): AgentRow[] {
    return this.db.prepare('SELECT * FROM agent ORDER BY username').all() as AgentRow[];
  }
  listEvents(agentId: string): Array<Record<string, unknown>> {
    // Order by rowid (monotonic insertion order) — created_at has only ms
    // resolution, so several events in the same tick would otherwise sort
    // non-deterministically by the random event_id.
    return this.db.prepare('SELECT * FROM agent_state_event WHERE agent_id = ? ORDER BY rowid').all(agentId) as Array<Record<string, unknown>>;
  }
  getObservation(agentId: string): AgentObservationRow | undefined {
    return this.db.prepare('SELECT * FROM agent_runtime_observation WHERE agent_id = ?').get(agentId) as AgentObservationRow | undefined;
  }
  listObservations(): AgentObservationRow[] {
    return this.db.prepare('SELECT * FROM agent_runtime_observation ORDER BY agent_id').all() as AgentObservationRow[];
  }

  /**
   * Effective enabled = desired_enabled AND NOT operator_disabled (INV-5).
   * The reconcile loop (P3) must never start an operator-disabled agent.
   */
  isEffectivelyEnabled(agentId: string): boolean {
    const r = this.getAgent(agentId);
    return !!r && r.desired_enabled === 1 && r.operator_disabled === 0;
  }

  // ── Mutations (each is one IMMEDIATE txn: row write + version bump + audit) ──
  private writeEvent(agentId: string, type: AgentStateEventType, version: number, actor: string, reason?: string | null, payload?: unknown): void {
    this.db.prepare(
      `INSERT INTO agent_state_event (event_id, agent_id, event_type, desired_version, actor, reason, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), agentId, type, version, actor, reason ?? null, payload == null ? null : JSON.stringify(payload), new Date().toISOString());
  }

  /**
   * Reconcile/runtime paths record drift/convergence without changing desired
   * state, so they append audit events at the currently desired row version.
   */
  recordStateEvent(agentId: string, type: AgentStateEventType, actor: string, reason?: string | null, payload?: unknown): void {
    const row = this.getAgent(agentId);
    if (!row) throw new UnknownAgentError(agentId);
    this.writeEvent(agentId, type, row.version, actor, reason, payload);
  }

  createAgent(actor: string, spec: CreateAgentSpec): AgentRow {
    const txn = this.db.transaction((): AgentRow => {
      const now = new Date().toISOString();
      const id = spec.id ?? randomUUID();
      this.db.prepare(
        `INSERT INTO agent (id, username, email, name, role, team, runtime_environment, execution_method,
            model, model_fallbacks_json, model_overrides_json, skills_json, env_json, resource_limits_json,
            desired_enabled, operator_disabled, desired_status, version, updated_at, created_at)
         VALUES (@id,@username,@email,@name,@role,@team,@runtime_environment,@execution_method,
            @model,@model_fallbacks_json,@model_overrides_json,@skills_json,@env_json,@resource_limits_json,
            @desired_enabled,@operator_disabled,'stopped',1,@now,@now)`,
      ).run({
        id, username: spec.username, email: spec.email ?? null, name: spec.name,
        role: spec.role ?? null, team: spec.team ?? null,
        runtime_environment: spec.runtimeEnvironment ?? 'container',
        execution_method: spec.executionMethod ?? null,
        model: spec.model ?? null,
        model_fallbacks_json: spec.modelFallbacks == null ? null : JSON.stringify(spec.modelFallbacks),
        model_overrides_json: spec.modelOverrides == null ? null : JSON.stringify(spec.modelOverrides),
        skills_json: JSON.stringify(spec.skills ?? []),
        env_json: spec.env == null ? null : JSON.stringify(spec.env),
        resource_limits_json: spec.resourceLimits == null ? null : JSON.stringify(spec.resourceLimits),
        desired_enabled: spec.desiredEnabled ? 1 : 0,
        operator_disabled: spec.operatorDisabled ? 1 : 0,
        now,
      });
      this.writeEvent(id, 'created', 1, actor, null, { username: spec.username });
      return this.getAgent(id)!;
    });
    return txn.immediate();
  }

  /** Patch a subset of columns. Optimistic-concurrency when expectedVersion given. */
  updateAgent(actor: string, agentId: string, patch: Partial<CreateAgentSpec>, expectedVersion?: number): AgentRow {
    const txn = this.db.transaction((): AgentRow => {
      const row = this.getAgent(agentId);
      if (!row) throw new UnknownAgentError(agentId);
      if (expectedVersion != null && row.version !== expectedVersion) {
        throw new StaleVersionError(agentId, expectedVersion, row.version);
      }
      const map: Record<string, unknown> = {};
      if (patch.name !== undefined) map['name'] = patch.name;
      if (patch.email !== undefined) map['email'] = patch.email;
      if (patch.role !== undefined) map['role'] = patch.role;
      if (patch.team !== undefined) map['team'] = patch.team;
      if (patch.runtimeEnvironment !== undefined) map['runtime_environment'] = patch.runtimeEnvironment;
      if (patch.executionMethod !== undefined) map['execution_method'] = patch.executionMethod;
      if (patch.model !== undefined) map['model'] = patch.model;
      if (patch.modelFallbacks !== undefined) map['model_fallbacks_json'] = patch.modelFallbacks == null ? null : JSON.stringify(patch.modelFallbacks);
      if (patch.modelOverrides !== undefined) map['model_overrides_json'] = patch.modelOverrides == null ? null : JSON.stringify(patch.modelOverrides);
      if (patch.skills !== undefined) map['skills_json'] = JSON.stringify(patch.skills ?? []);
      if (patch.env !== undefined) map['env_json'] = patch.env == null ? null : JSON.stringify(patch.env);
      if (patch.resourceLimits !== undefined) map['resource_limits_json'] = patch.resourceLimits == null ? null : JSON.stringify(patch.resourceLimits);
      const cols = Object.keys(map);
      const nextVersion = row.version + 1;
      const now = new Date().toISOString();
      const setClause = [...cols.map((c) => `${c} = @${c}`), 'version = @__v', 'updated_at = @__now'].join(', ');
      this.db.prepare(`UPDATE agent SET ${setClause} WHERE id = @__id`).run({ ...map, __v: nextVersion, __now: now, __id: agentId });
      this.writeEvent(agentId, 'updated', nextVersion, actor, null, { fields: cols });
      return this.getAgent(agentId)!;
    });
    return txn.immediate();
  }

  /** User-facing enable/disable. Refuses to enable an operator-disabled agent unless overridden (INV-5). */
  setDesiredEnabled(actor: string, agentId: string, enabled: boolean, opts: { overrideKillSwitch?: boolean } = {}): AgentRow {
    const txn = this.db.transaction((): AgentRow => {
      const row = this.getAgent(agentId);
      if (!row) throw new UnknownAgentError(agentId);
      const clearOperator = enabled && opts.overrideKillSwitch && row.operator_disabled === 1;
      const nextVersion = row.version + 1;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE agent SET desired_enabled = ?, operator_disabled = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(enabled ? 1 : 0, clearOperator ? 0 : row.operator_disabled, nextVersion, now, agentId);
      this.writeEvent(agentId, enabled ? 'enabled' : 'disabled', nextVersion, actor, clearOperator ? 'override-kill-switch' : null);
      return this.getAgent(agentId)!;
    });
    return txn.immediate();
  }

  /** Operator kill-switch — fail-closed; only an operator path sets/clears this. */
  setOperatorDisabled(actor: string, agentId: string, disabled: boolean, reason?: string): AgentRow {
    const txn = this.db.transaction((): AgentRow => {
      const row = this.getAgent(agentId);
      if (!row) throw new UnknownAgentError(agentId);
      const nextVersion = row.version + 1;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE agent SET operator_disabled = ?, version = ?, updated_at = ? WHERE id = ?')
        .run(disabled ? 1 : 0, nextVersion, now, agentId);
      this.writeEvent(agentId, disabled ? 'disabled' : 'enabled', nextVersion, actor, reason ?? 'operator-kill-switch');
      return this.getAgent(agentId)!;
    });
    return txn.immediate();
  }

  deleteAgent(actor: string, agentId: string): void {
    const txn = this.db.transaction((): void => {
      const row = this.getAgent(agentId);
      if (!row) throw new UnknownAgentError(agentId);
      this.db.prepare('DELETE FROM agent WHERE id = ?').run(agentId);
      this.writeEvent(agentId, 'deleted', row.version, actor, null, { username: row.username });
    });
    txn.immediate();
  }

  recordObservation(agentId: string, obs: AgentObservation): void {
    this.db.prepare(
      `INSERT INTO agent_runtime_observation (agent_id, observed_state, runtime_kind, container_or_pod, pid, last_seen_at, last_error)
       VALUES (@agent_id,@observed_state,@runtime_kind,@container_or_pod,@pid,@last_seen_at,@last_error)
       ON CONFLICT(agent_id) DO UPDATE SET
         observed_state=excluded.observed_state, runtime_kind=excluded.runtime_kind,
         container_or_pod=excluded.container_or_pod, pid=excluded.pid,
         last_seen_at=excluded.last_seen_at, last_error=excluded.last_error`,
    ).run({
      agent_id: agentId, observed_state: obs.observed_state, runtime_kind: obs.runtime_kind,
      container_or_pod: obs.container_or_pod ?? null, pid: obs.pid ?? null,
      last_seen_at: new Date().toISOString(), last_error: obs.last_error ?? null,
    });
  }

  private rekeyUsernameMatchedImport(actor: string, existing: AgentRow, spec: AgentInfo, desiredEnabled: boolean, operatorDisabled: boolean): AgentRow {
    const observation = this.getObservation(existing.id);
    const nextVersion = existing.version + 1;
    const now = new Date().toISOString();

    // agent_runtime_observation has a FK to agent(id) without ON UPDATE CASCADE.
    // Move it explicitly around the primary-key update so a username/id drift
    // repair preserves runtime tracking instead of tripping the FK constraint.
    if (observation) {
      this.db.prepare('DELETE FROM agent_runtime_observation WHERE agent_id = ?').run(existing.id);
    }

    this.db.prepare(
      `UPDATE agent SET
          id = @id,
          username = @username,
          email = @email,
          name = @name,
          role = @role,
          team = @team,
          runtime_environment = @runtime_environment,
          execution_method = @execution_method,
          model = @model,
          model_fallbacks_json = @model_fallbacks_json,
          model_overrides_json = @model_overrides_json,
          skills_json = @skills_json,
          env_json = @env_json,
          resource_limits_json = @resource_limits_json,
          desired_enabled = @desired_enabled,
          operator_disabled = @operator_disabled,
          version = @version,
          updated_at = @updated_at
        WHERE id = @previous_id`,
    ).run({
      previous_id: existing.id,
      id: spec.id,
      username: spec.username,
      email: spec.email ?? null,
      name: spec.name,
      role: spec.role ?? null,
      team: spec.team ?? null,
      runtime_environment: spec.runtimeEnvironment ?? 'container',
      execution_method: spec.executionMethod ?? null,
      model: spec.model ?? null,
      model_fallbacks_json: spec.modelFallbacks == null ? null : JSON.stringify(spec.modelFallbacks),
      model_overrides_json: spec.modelOverrides == null ? null : JSON.stringify(spec.modelOverrides),
      skills_json: JSON.stringify(spec.skills ?? []),
      env_json: spec.env == null ? null : JSON.stringify(spec.env),
      resource_limits_json: spec.resourceLimits == null ? null : JSON.stringify(spec.resourceLimits),
      desired_enabled: desiredEnabled ? 1 : 0,
      operator_disabled: operatorDisabled ? 1 : 0,
      version: nextVersion,
      updated_at: now,
    });
    this.db.prepare('UPDATE agent_state_event SET agent_id = ? WHERE agent_id = ?').run(spec.id, existing.id);
    if (observation) {
      this.db.prepare(
        `INSERT INTO agent_runtime_observation (agent_id, observed_state, runtime_kind, container_or_pod, pid, last_seen_at, last_error)
         VALUES (@agent_id,@observed_state,@runtime_kind,@container_or_pod,@pid,@last_seen_at,@last_error)`,
      ).run({
        ...observation,
        agent_id: spec.id,
      });
    }
    this.writeEvent(spec.id, 'updated', nextVersion, actor, 'username-id-drift-import', {
      previousId: existing.id,
      id: spec.id,
      username: spec.username,
    });
    return this.getAgent(spec.id)!;
  }

  // ── Migration (HLD §8) ─────────────────────────────────────────────────
  /**
   * Import agents.json + enabled/disabled sets into the DB. Conflict resolution
   * is deterministic: operator-disabled (kill-switch) wins over enabled. Idempotent
   * (upsert by id); existing rows are left intact except for desired/operator flags.
   * If agents.json has the same username under a new id, rekey the DB row and
   * preserve observation/audit children instead of creating a duplicate username.
   * Returns the count imported and any usernames that appeared only in the
   * enabled/disabled sets without a matching agent row (rejected + reported).
   */
  importFromJson(agents: AgentInfo[], enabled: Set<string>, disabled: Set<string>, actor = 'migration'): { imported: number; orphanFlags: string[] } {
    const knownIds = new Set(agents.map((a) => a.id));
    const knownUsernames = new Set(agents.map((a) => a.username));
    const driftedIdsAlreadyInDb = new Set(
      agents
        .map((a) => this.getByUsername(a.username)?.id)
        .filter((id): id is string => id != null),
    );
    const orphanFlags = [...enabled, ...disabled].filter(
      (idOrName) => !knownIds.has(idOrName) && !knownUsernames.has(idOrName) && !driftedIdsAlreadyInDb.has(idOrName),
    );
    const txn = this.db.transaction((): number => {
      let n = 0;
      for (const a of agents) {
        const existing = this.getAgent(a.id);
        const usernameMatch = existing ? undefined : this.getByUsername(a.username);
        const previousId = usernameMatch?.id;
        const isDisabled = disabled.has(a.id) || disabled.has(a.username) || (previousId ? disabled.has(previousId) : false);
        const isEnabled = enabled.has(a.id) || enabled.has(a.username) || (previousId ? enabled.has(previousId) : false);
        if (existing) {
          // operator-disabled wins over enabled on conflict
          this.setOperatorDisabled(actor, a.id, isDisabled, 'import');
          this.setDesiredEnabled(actor, a.id, isEnabled && !isDisabled);
        } else if (usernameMatch) {
          this.rekeyUsernameMatchedImport(actor, usernameMatch, a, isEnabled && !isDisabled, isDisabled);
        } else {
          this.createAgent(actor, {
            id: a.id, username: a.username, email: a.email, name: a.name,
            role: a.role, team: a.team ?? null,
            runtimeEnvironment: a.runtimeEnvironment ?? 'container',
            executionMethod: a.executionMethod ?? null,
            model: a.model ?? null,
            modelFallbacks: a.modelFallbacks, modelOverrides: a.modelOverrides,
            skills: a.skills ?? [], env: a.env ?? null, resourceLimits: a.resourceLimits,
            desiredEnabled: isEnabled && !isDisabled,
            operatorDisabled: isDisabled,
          });
        }
        n++;
      }
      return n;
    });
    const imported = txn.immediate();
    return { imported, orphanFlags };
  }

  /** Read-only export back to the AgentInfo-ish shape (compat layer, HLD §4/§8). */
  exportToJson(): AgentJsonExport[] {
    return this.listAgents().map((r) => ({
      id: r.id, username: r.username, email: r.email ?? '', name: r.name,
      role: r.role, team: r.team,
      runtimeEnvironment: (r.runtime_environment as AgentInfo['runtimeEnvironment']),
      executionMethod: r.execution_method ?? undefined,
      model: r.model ?? undefined,
      modelFallbacks: r.model_fallbacks_json ? JSON.parse(r.model_fallbacks_json) : undefined,
      modelOverrides: r.model_overrides_json ? JSON.parse(r.model_overrides_json) : undefined,
      skills: r.skills_json ? JSON.parse(r.skills_json) : [],
      env: r.env_json ? JSON.parse(r.env_json) : undefined,
      resourceLimits: r.resource_limits_json ? JSON.parse(r.resource_limits_json) : undefined,
      desiredEnabled: r.desired_enabled === 1,
      operatorDisabled: r.operator_disabled === 1,
    }));
  }

  /**
   * Option B cutover export: merge DB-authoritative operational fields into the
   * existing agents.json rows instead of regenerating full AgentInfo records from
   * the DB. This keeps agents.json as the secret/identity/status source while the
   * DB owns operational config. In particular, credentials[], keypair, and status
   * are preserved by starting from the current JSON row and only overlaying fields
   * the AgentStateStore is authoritative for.
   */
  exportMergedAgentsJson(existingAgents: AgentInfo[]): AgentInfo[] {
    const rows = this.exportToJson();
    const rowById = new Map(rows.map((row) => [row.id, row]));
    const rowByUsername = new Map(rows.map((row) => [row.username, row]));
    const usedRowIds = new Set<string>();

    const mergeRow = (base: AgentInfo, row: AgentJsonExport): AgentInfo => ({
      ...base,
      id: row.id,
      username: row.username,
      email: row.email ?? '',
      name: row.name,
      role: row.role ?? null,
      team: row.team ?? null,
      runtimeEnvironment: row.runtimeEnvironment,
      executionMethod: row.executionMethod,
      model: row.model,
      modelFallbacks: row.modelFallbacks,
      modelOverrides: row.modelOverrides,
      skills: row.skills ?? [],
      env: row.env,
      resourceLimits: row.resourceLimits,
    });

    const mergedExisting = existingAgents.map((agent) => {
      const row = rowById.get(agent.id) ?? rowByUsername.get(agent.username);
      if (!row) return agent;
      usedRowIds.add(row.id);
      return mergeRow(agent, row);
    });

    const dbOnlyAgents = rows
      .filter((row) => !usedRowIds.has(row.id))
      .map((row): AgentInfo => mergeRow({
        id: row.id,
        username: row.username,
        name: row.name,
        email: row.email ?? '',
        role: row.role ?? null,
        status: 'disabled',
        mcpServers: [],
        personalityTraits: {},
        skills: [],
      } as AgentInfo, row));

    return [...mergedExisting, ...dbOnlyAgents];
  }
}
