/**
 * Local Pulse Store — lightweight offline task management for agents.
 *
 * SQLite-backed (better-sqlite3), Pulse-compatible schema.
 * Shares field names with the online Pulse service so sync is a clean mapping.
 *
 * Features:
 * - Tasks with status, priority, assignee, due dates, labels
 * - Projects (lightweight — just name + key + default assignee)
 * - Comments on tasks
 * - Full-text search via FTS5
 * - Sync metadata (local_id ↔ remote_id, dirty flag, last_synced)
 */

import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Schedule parsing ──

/** Parse "every 30m", "every 1h", "every 2d", "30m", "1h" etc. to milliseconds. */
export function parseScheduleMs(schedule: string): number | null {
  const m = schedule.match(/^(?:every\s+)?(\d+)\s*(s|m|h|d)$/i);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2]!.toLowerCase();
  const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return n * (multipliers[unit] ?? 60000);
}

/** Compute next run time from now + interval. */
export function computeNextRun(schedule: string, from?: Date): string | null {
  const ms = parseScheduleMs(schedule);
  if (!ms) return null;
  return new Date((from ?? new Date()).getTime() + ms).toISOString();
}

// ── Team → Lead resolution ──
// Local config: maps team/group names to their lead (default assignee).
// Loaded from ~/.shizuha/teams.json if it exists, otherwise uses built-in defaults.
// Platform sync can populate this from shizuha-admin's Team model.

let _teamConfig: Record<string, { lead: string; members: string[] }> | null = null;

function loadTeamConfig(): Record<string, { lead: string; members: string[] }> {
  if (_teamConfig) return _teamConfig;
  const configPath = path.join(os.homedir(), '.shizuha', 'teams.json');
  try {
    if (fs.existsSync(configPath)) {
      _teamConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return _teamConfig!;
    }
  } catch { /* fall through to defaults */ }

  // Built-in defaults matching the agent team structure
  _teamConfig = {
    'triage':           { lead: 'hritik', members: ['hritik'] },
    'security-triage':  { lead: 'hritik', members: ['hritik'] },
    'engineering':      { lead: 'kai', members: ['kai', 'ryo'] },
    'security':         { lead: 'akira', members: ['akira', 'ren'] },
    'review':           { lead: 'akira', members: ['akira', 'ren'] },
    'qa':               { lead: 'zen', members: ['zen', 'mika'] },
    'architecture':     { lead: 'sora', members: ['sora', 'aoi'] },
    'documentation':    { lead: 'yuki', members: ['yuki', 'haru'] },
    'research-analytics': { lead: 'hana', members: ['hana', 'tomo'] },
    'leads':            { lead: 'hritik', members: ['hritik'] },
  };
  return _teamConfig;
}

/** Resolve a team name to its lead (default assignee). */
function resolveTeamLead(teamName: string): string | null {
  const config = loadTeamConfig();
  const canonical = teamName === 'research' || teamName === 'analytics'
    ? 'research-analytics'
    : teamName;
  return config[canonical]?.lead ?? null;
}

/** Reload team config from disk (call after sync updates). */
export function reloadTeamConfig(): void {
  _teamConfig = null;
}

// ── Types ──

export type ItemMode = 'task' | 'alert' | 'action';
export type AlertStatus = 'firing' | 'acknowledged' | 'resolved' | 'silenced';
export type ActionStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked';
export type ItemStatus = TaskStatus | AlertStatus | ActionStatus;

export interface LocalTask {
  id: string;
  project_id: string | null;
  project_key: string | null;
  item_key: string;              // e.g., "GEN-1", "SEC-3"
  // Mode: 'task' (default) or 'alert'
  mode: ItemMode;
  item_type: string | null;      // e.g., "alert.email.new", "task.generic"
  title: string;
  description: string;
  status: ItemStatus;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  severity: string | null;       // For alerts: info, warning, error, critical
  assignee: string | null;
  created_by: string | null;
  labels: string[];
  due_date: string | null;
  start_date: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  // Alert-specific
  source: string | null;         // Origin: "gmail", "webhook", "agent", etc.
  source_id: string | null;      // External reference ID
  source_url: string | null;     // Link to source
  fingerprint: string | null;    // Dedup hash
  payload: Record<string, unknown> | null;  // Alert-specific data
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  // Scheduling
  is_recurring: boolean;
  schedule: string | null;        // e.g., "every 1h", "every 30m", cron expression
  next_run_at: string | null;     // ISO 8601 — when this task next triggers
  last_triggered_at: string | null;
  // Workflow
  workflow: string | null;        // workflow name (references ~/.shizuha/workflows/<name>.json)
  workflow_status: string | null;  // current status within the workflow
  // Action support (mode='action')
  rejection_reason: string | null;
  linked_task_id: string | null;  // task this action controls
  transition_to: string | null;   // workflow status to transition to on approval
  // Assignment group (ServiceNow-style)
  assignment_group: string | null; // team/group name — the team that owns this task
  // Sync metadata
  remote_id: string | null;      // Pulse task ID (after sync)
  remote_key: string | null;     // e.g., "PROJ-42"
  dirty: boolean;                // local changes not yet synced
  last_synced: string | null;
}

export interface LocalProject {
  id: string;
  name: string;
  key: string;                   // short prefix, e.g., "SEC"
  description: string;
  default_assignee: string | null;
  created_at: string;
  remote_id: number | null;
}

export interface LocalComment {
  id: string;
  task_id: string;
  author: string;
  content: string;
  created_at: string;
}

// ── Store ──

export class LocalPulseStore {
  private db: Database.Database;
  private nextSeqByProject = new Map<string, number>();

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key TEXT NOT NULL UNIQUE,
        description TEXT DEFAULT '',
        default_assignee TEXT,
        created_at TEXT NOT NULL,
        remote_id INTEGER
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT REFERENCES projects(id),
        project_key TEXT,
        item_key TEXT,
        title TEXT NOT NULL,
        description TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        assignee TEXT,
        created_by TEXT,
        labels TEXT DEFAULT '[]',
        due_date TEXT,
        start_date TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        remote_id TEXT,
        remote_key TEXT,
        is_recurring INTEGER DEFAULT 0,
        schedule TEXT,
        next_run_at TEXT,
        last_triggered_at TEXT,
        dirty INTEGER DEFAULT 1,
        last_synced TEXT
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
      CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_next_run ON tasks(next_run_at);
      CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id);
    `);

    // Add columns to existing DBs (idempotent migration)
    for (const col of [
      // Alert support
      "mode TEXT DEFAULT 'task'", "item_type TEXT", "severity TEXT",
      "source TEXT", "source_id TEXT", "source_url TEXT",
      "fingerprint TEXT", "payload TEXT DEFAULT '{}'",
      "acknowledged_at TEXT", "acknowledged_by TEXT",
      // Scheduling
      'is_recurring INTEGER DEFAULT 0', 'schedule TEXT', 'next_run_at TEXT', 'last_triggered_at TEXT',
      // Workflow support
      'workflow TEXT',           // workflow name (references ~/.shizuha/workflows/<name>.json)
      'workflow_status TEXT',    // current status within the workflow (e.g., "needs-triage")
      // Action support (mode='action')
      'rejection_reason TEXT',   // why an action was rejected
      'linked_task_id TEXT',     // task this action is linked to (for workflow transitions)
      'transition_to TEXT',      // target workflow status this action represents
      // Assignment group (ServiceNow-style two-tier assignment)
      'assignment_group TEXT',   // team/group name (e.g., "security-triage", "engineering")
    ]) {
      try { this.db.exec(`ALTER TABLE tasks ADD COLUMN ${col}`); } catch { /* already exists */ }
    }

    // FTS5 for search (ignore if already exists)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
          title, description, labels,
          content='tasks',
          content_rowid='rowid'
        );
      `);
    } catch { /* FTS5 might not be available */ }

    // Seed default project if none exist
    const count = this.db.prepare('SELECT COUNT(*) as n FROM projects').get() as { n: number };
    if (count.n === 0) {
      this.createProject({ name: 'General', key: 'GEN', description: 'Default project' });
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Projects ──

  createProject(opts: {
    name: string;
    key: string;
    description?: string;
    default_assignee?: string;
    remote_id?: number;
  }): LocalProject {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO projects (id, name, key, description, default_assignee, created_at, remote_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, opts.name, opts.key.toUpperCase(), opts.description ?? '', opts.default_assignee ?? null, now, opts.remote_id ?? null);
    return this.getProject(id)!;
  }

  getProject(idOrKey: string): LocalProject | null {
    const row = this.db.prepare(
      'SELECT * FROM projects WHERE id = ? OR key = ?'
    ).get(idOrKey, idOrKey.toUpperCase()) as any;
    return row ?? null;
  }

  listProjects(): LocalProject[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as LocalProject[];
  }

  // ── Tasks ──

  private nextItemKey(projectKey: string): string {
    // Get current max sequence for this project
    const row = this.db.prepare(
      "SELECT item_key FROM tasks WHERE project_key = ? ORDER BY CAST(SUBSTR(item_key, LENGTH(?) + 2) AS INTEGER) DESC LIMIT 1"
    ).get(projectKey, projectKey) as { item_key: string } | undefined;

    let seq = 1;
    if (row?.item_key) {
      const parts = row.item_key.split('-');
      seq = parseInt(parts[parts.length - 1]!, 10) + 1;
    }
    return `${projectKey}-${seq}`;
  }

  createTask(opts: {
    title: string;
    description?: string;
    project?: string;         // project key or ID
    status?: string;
    priority?: string;
    assignee?: string;
    created_by?: string;
    labels?: string[];
    due_date?: string;
    start_date?: string;
    schedule?: string;        // "every 1h", "every 30m", etc.
    workflow?: string;        // workflow name (references ~/.shizuha/workflows/<name>.json)
    workflow_status?: string; // initial status within the workflow
  }): LocalTask {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // Resolve project
    let project: LocalProject | null = null;
    if (opts.project) {
      project = this.getProject(opts.project);
    }
    if (!project) {
      project = this.db.prepare("SELECT * FROM projects ORDER BY created_at LIMIT 1").get() as LocalProject;
    }

    const assignee = opts.assignee ?? project?.default_assignee ?? opts.created_by ?? null;
    const itemKey = this.nextItemKey(project?.key ?? 'GEN');

    // Default workflow: every task gets a workflow
    const workflow = opts.workflow ?? 'simple';
    const workflowStatus = opts.workflow_status ?? (workflow === 'simple' ? 'pending' : null);

    // Scheduling — new recurring tasks fire immediately (next_run_at = now) unless due_date is set
    const isRecurring = !!opts.schedule;
    const nextRunAt = opts.schedule
      ? (opts.due_date ?? new Date().toISOString())  // fire now on first run
      : (opts.due_date ?? null);

    this.db.prepare(`
      INSERT INTO tasks (id, project_id, project_key, item_key, title, description, status, priority,
                         assignee, created_by, labels, due_date, start_date,
                         is_recurring, schedule, next_run_at,
                         workflow, workflow_status,
                         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, project?.id ?? null, project?.key ?? null, itemKey,
      opts.title, opts.description ?? '', opts.status ?? 'pending', opts.priority ?? 'normal',
      assignee, opts.created_by ?? null,
      JSON.stringify(opts.labels ?? []),
      opts.due_date ?? null, opts.start_date ?? null,
      isRecurring ? 1 : 0, opts.schedule ?? null, nextRunAt,
      workflow, workflowStatus,
      now, now,
    );

    // Update FTS
    try {
      this.db.prepare(
        "INSERT INTO tasks_fts(rowid, title, description, labels) SELECT rowid, title, description, labels FROM tasks WHERE id = ?"
      ).run(id);
    } catch { /* FTS might not exist */ }

    return this.getTask(id)!;
  }

  private mapRow(row: any): LocalTask {
    let payload = null;
    try { payload = row.payload ? JSON.parse(row.payload) : null; } catch { payload = null; }
    return {
      ...row,
      labels: JSON.parse(row.labels || '[]'),
      dirty: !!row.dirty,
      is_recurring: !!row.is_recurring,
      mode: row.mode || 'task',
      payload,
    };
  }

  getTask(idOrKey: string): LocalTask | null {
    const row = this.db.prepare(
      'SELECT * FROM tasks WHERE id = ? OR item_key = ? OR remote_key = ?'
    ).get(idOrKey, idOrKey.toUpperCase(), idOrKey.toUpperCase()) as any;
    if (!row) return null;
    return this.mapRow(row);
  }

  updateTask(idOrKey: string, updates: Partial<{
    title: string;
    description: string;
    status: string;
    priority: string;
    assignee: string;
    labels: string[];
    due_date: string | null;
    start_date: string | null;
    schedule: string | null;
    workflow: string | null;
    workflow_status: string | null;
    assignment_group: string | null;
  }>): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task) return null;

    const sets: string[] = [];
    const vals: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) continue;
      if (key === 'labels') {
        sets.push('labels = ?');
        vals.push(JSON.stringify(value));
      } else {
        sets.push(`${key} = ?`);
        vals.push(value);
      }
    }

    // Schedule change — recompute next run time
    if (updates.schedule !== undefined) {
      if (updates.schedule) {
        sets.push('is_recurring = 1');
        const nextRun = computeNextRun(updates.schedule);
        if (nextRun) {
          sets.push('next_run_at = ?');
          vals.push(nextRun);
        }
      } else {
        // Clear schedule
        sets.push('is_recurring = 0', 'next_run_at = NULL');
      }
    }

    if (updates.status === 'completed' && task.status !== 'completed') {
      sets.push('completed_at = ?');
      vals.push(new Date().toISOString());
    }
    if (updates.status === 'in_progress' && !task.start_date) {
      sets.push('start_date = ?');
      vals.push(new Date().toISOString());
    }

    sets.push('updated_at = ?', 'dirty = 1');
    vals.push(new Date().toISOString());
    vals.push(task.id);

    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);

    // Update FTS
    try {
      const updated = this.getTask(task.id)!;
      this.db.prepare("DELETE FROM tasks_fts WHERE rowid = (SELECT rowid FROM tasks WHERE id = ?)").run(task.id);
      this.db.prepare(
        "INSERT INTO tasks_fts(rowid, title, description, labels) SELECT rowid, title, description, labels FROM tasks WHERE id = ?"
      ).run(task.id);
    } catch { /* FTS */ }

    return this.getTask(task.id);
  }

  completeTask(idOrKey: string): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task) return null;

    // Recurring tasks don't truly complete — they reset to pending with next_run advanced
    if (task.is_recurring && task.schedule) {
      const now = new Date().toISOString();
      const nextRun = computeNextRun(task.schedule);
      this.db.prepare(
        'UPDATE tasks SET status = ?, completed_at = NULL, next_run_at = ?, updated_at = ? WHERE id = ?'
      ).run('pending', nextRun, now, task.id);
      return this.getTask(task.id);
    }

    return this.updateTask(idOrKey, { status: 'completed' });
  }

  /** Stop a recurring task permanently. */
  cancelRecurring(idOrKey: string): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task) return null;
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE tasks SET status = ?, is_recurring = 0, schedule = NULL, next_run_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?'
    ).run('cancelled', now, now, task.id);
    return this.getTask(task.id);
  }

  /**
   * Transition a task through its workflow.
   * Validates the transition, updates workflow_status, and executes on_transition actions.
   * Caller must provide workflow helpers (avoids ESM import issues in this sync module).
   */
  transitionTask(
    idOrKey: string,
    targetStatus: string,
    actorType: 'human' | 'agent' | 'auto',
    actorUsername?: string,
    workflowHelpers?: {
      getWorkflow: (name: string) => any;
      validateTransition: (wf: any, from: string, to: string, actor: string) => any;
      executeTransitionActions: (action: any, vars: Record<string, string>) => any;
    },
  ): { ok: boolean; task?: LocalTask; error?: string; comment?: string } {
    const task = this.getTask(idOrKey);
    if (!task) return { ok: false, error: `Task "${idOrKey}" not found` };

    if (!task.workflow) return { ok: false, error: `Task ${(task as any).item_key} has no workflow assigned` };
    if (!task.workflow_status) return { ok: false, error: `Task ${(task as any).item_key} has no current workflow status` };
    if (!workflowHelpers) return { ok: false, error: 'Workflow helpers not provided' };

    const workflow = workflowHelpers.getWorkflow(task.workflow);
    if (!workflow) return { ok: false, error: `Workflow "${task.workflow}" not found` };

    // Validate the transition
    const validation = workflowHelpers.validateTransition(workflow, task.workflow_status, targetStatus, actorType);
    if (!validation.valid) return { ok: false, error: validation.error };

    const transition = validation.transition!;
    const updates: Record<string, unknown> = { workflow_status: targetStatus };
    let comment: string | undefined;

    // Execute on_transition actions
    if (transition.on_transition) {
      const vars: Record<string, string> = {
        actor: actorUsername ?? actorType,
        assignee: task.assignee ?? 'unassigned',
        from: task.workflow_status,
        to: targetStatus,
        creator: task.created_by ?? 'unknown',
      };
      const actions = workflowHelpers.executeTransitionActions(transition.on_transition, vars);
      if (actions.assign_team) updates.assignment_group = actions.assign_team;
      if (actions.assign_to) updates.assignee = actions.assign_to;
      // If assign_team is set but assign_to is not, resolve assignee from team config
      if (actions.assign_team && !actions.assign_to) {
        const teamLead = resolveTeamLead(actions.assign_team);
        if (teamLead) updates.assignee = teamLead;
      }
      if (actions.comment) comment = actions.comment;
      if (actions.add_label) {
        const labels = [...(task.labels ?? [])];
        if (!labels.includes(actions.add_label)) labels.push(actions.add_label);
        updates.labels = labels;
      }
      if (actions.remove_label) {
        updates.labels = (task.labels ?? []).filter((l: string) => l !== actions.remove_label);
      }
    }

    // Map workflow status category to task status
    const statusDef = workflow.statuses.find((s: any) => s.id === targetStatus);
    if (statusDef) {
      const categoryMap: Record<string, string> = {
        open: 'pending',
        in_progress: 'in_progress',
        done: 'completed',
        cancelled: 'cancelled',
      };
      if (categoryMap[statusDef.category]) {
        updates.status = categoryMap[statusDef.category];
      }
    }

    // Apply updates
    const updated = this.updateTask(task.id, updates as any);
    if (!updated) return { ok: false, error: 'Failed to update task' };

    // Add auto-comment if transition produced one
    if (comment) {
      this.addComment(task.id, actorUsername ?? actorType, comment);
    }

    return { ok: true, task: updated, comment };
  }

  deleteTask(idOrKey: string): boolean {
    const task = this.getTask(idOrKey);
    if (!task) return false;
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    try { this.db.prepare("DELETE FROM tasks_fts WHERE rowid = (SELECT rowid FROM tasks WHERE id = ?)").run(task.id); } catch {}
    return true;
  }

  listTasks(opts?: {
    status?: string;
    assignee?: string;
    project?: string;
    priority?: string;
    limit?: number;
    include_completed?: boolean;
  }): LocalTask[] {
    const where: string[] = [];
    const params: unknown[] = [];

    if (opts?.status) { where.push('status = ?'); params.push(opts.status); }
    if (opts?.assignee) { where.push('assignee = ?'); params.push(opts.assignee); }
    if (opts?.project) { where.push('(project_key = ? OR project_id = ?)'); params.push(opts.project.toUpperCase(), opts.project); }
    if (opts?.priority) { where.push('priority = ?'); params.push(opts.priority); }
    if (!opts?.include_completed && !opts?.status) { where.push("status NOT IN ('completed', 'cancelled')"); }

    const limit = opts?.limit ?? 50;
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = this.db.prepare(
      `SELECT * FROM tasks ${whereClause} ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 END,
        CASE WHEN due_date IS NOT NULL THEN 0 ELSE 1 END,
        due_date ASC,
        created_at DESC
      LIMIT ?`
    ).all(...params, limit) as any[];

    return rows.map(r => (this.mapRow(r)));
  }

  searchTasks(query: string, limit = 20): LocalTask[] {
    try {
      const rows = this.db.prepare(`
        SELECT tasks.* FROM tasks_fts
        JOIN tasks ON tasks.rowid = tasks_fts.rowid
        WHERE tasks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(query, limit) as any[];
      return rows.map(r => (this.mapRow(r)));
    } catch {
      // FTS not available — fall back to LIKE
      const rows = this.db.prepare(
        "SELECT * FROM tasks WHERE title LIKE ? OR description LIKE ? ORDER BY updated_at DESC LIMIT ?"
      ).all(`%${query}%`, `%${query}%`, limit) as any[];
      return rows.map(r => (this.mapRow(r)));
    }
  }

  getMyTasks(username: string, status?: string, limit = 20): LocalTask[] {
    return this.listTasks({ assignee: username, status, limit, include_completed: !!status });
  }

  getOverdueTasks(limit = 20): LocalTask[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('completed', 'cancelled')
      ORDER BY due_date ASC LIMIT ?
    `).all(now, limit) as any[];
    return rows.map(r => (this.mapRow(r)));
  }

  getStatistics(): { total: number; by_status: Record<string, number>; by_priority: Record<string, number>; overdue: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as n FROM tasks').get() as any).n;
    const byStatus: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT status, COUNT(*) as n FROM tasks GROUP BY status').all() as any[]) {
      byStatus[row.status] = row.n;
    }
    const byPriority: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT priority, COUNT(*) as n FROM tasks WHERE status NOT IN (\'completed\', \'cancelled\') GROUP BY priority').all() as any[]) {
      byPriority[row.priority] = row.n;
    }
    const overdue = (this.db.prepare(
      "SELECT COUNT(*) as n FROM tasks WHERE due_date IS NOT NULL AND due_date < ? AND status NOT IN ('completed', 'cancelled')"
    ).get(new Date().toISOString()) as any).n;

    return { total, by_status: byStatus, by_priority: byPriority, overdue };
  }

  // ── Comments ──

  addComment(taskIdOrKey: string, author: string, content: string): LocalComment | null {
    const task = this.getTask(taskIdOrKey);
    if (!task) return null;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO comments (id, task_id, author, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, task.id, author, content, now);

    // Mark task as dirty (comment added)
    this.db.prepare('UPDATE tasks SET updated_at = ?, dirty = 1 WHERE id = ?').run(now, task.id);

    return { id, task_id: task.id, author, content, created_at: now };
  }

  listComments(taskIdOrKey: string): LocalComment[] {
    const task = this.getTask(taskIdOrKey);
    if (!task) return [];
    return this.db.prepare('SELECT * FROM comments WHERE task_id = ? ORDER BY created_at').all(task.id) as LocalComment[];
  }

  // ── Sync helpers ──

  getDirtyTasks(): LocalTask[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE dirty = 1').all() as any[];
    return rows.map(r => ({ ...r, labels: JSON.parse(r.labels || '[]'), dirty: true }));
  }

  markSynced(taskId: string, remoteId: string, remoteKey: string): void {
    this.db.prepare(
      'UPDATE tasks SET remote_id = ?, remote_key = ?, dirty = 0, last_synced = ? WHERE id = ?'
    ).run(remoteId, remoteKey, new Date().toISOString(), taskId);
  }

  // ── Scheduler ──

  /**
   * Get tasks that are due (next_run_at <= now) and not completed/cancelled.
   * These need to be dispatched to their assigned agents.
   */
  getDueTasks(): LocalTask[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(`
      SELECT * FROM tasks
      WHERE next_run_at IS NOT NULL
        AND next_run_at <= ?
        AND status NOT IN ('completed', 'cancelled')
    `).all(now) as any[];
    return rows.map(r => ({
      ...r,
      labels: JSON.parse(r.labels || '[]'),
      dirty: !!r.dirty,
      is_recurring: !!r.is_recurring,
    }));
  }

  /**
   * After a task is triggered:
   * - For recurring tasks: advance next_run_at to the next interval
   * - For one-shot tasks: clear next_run_at (task stays pending until agent completes it)
   */
  markTriggered(taskId: string): void {
    const task = this.getTask(taskId);
    if (!task) return;
    const now = new Date().toISOString();

    if (task.is_recurring && task.schedule) {
      // Advance to next occurrence
      const nextRun = computeNextRun(task.schedule);
      this.db.prepare(
        'UPDATE tasks SET last_triggered_at = ?, next_run_at = ?, status = ?, updated_at = ? WHERE id = ?'
      ).run(now, nextRun, 'pending', now, taskId);
    } else {
      // One-shot: set to in_progress, clear next_run
      this.db.prepare(
        'UPDATE tasks SET last_triggered_at = ?, next_run_at = NULL, status = ?, updated_at = ? WHERE id = ?'
      ).run(now, 'in_progress', now, taskId);
    }
  }

  // ── Alerts ──

  /**
   * Fire an alert. Deduplicates by fingerprint — if an identical alert exists and is still
   * firing/acknowledged, it increments the occurrence instead of creating a duplicate.
   */
  fireAlert(opts: {
    title: string;
    description?: string;
    item_type?: string;       // e.g., "alert.email.new"
    severity?: string;        // info, warning, error, critical
    assignee?: string;
    source?: string;          // "gmail", "webhook", etc.
    source_id?: string;       // external ID
    source_url?: string;
    payload?: Record<string, unknown>;
    labels?: string[];
    project?: string;
    created_by?: string;
  }): LocalTask {
    // Compute fingerprint for dedup
    const fp = opts.source_id
      ? crypto.createHash('sha256').update(`${opts.source ?? ''}:${opts.source_id}`).digest('hex').slice(0, 32)
      : null;

    // Check for existing unfired alert with same fingerprint
    if (fp) {
      const existing = this.db.prepare(
        "SELECT * FROM tasks WHERE fingerprint = ? AND mode = 'alert' AND status IN ('firing', 'acknowledged')"
      ).get(fp) as any;
      if (existing) {
        // Deduplicate — just update the timestamp
        this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), existing.id);
        return this.mapRow(existing);
      }
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let project: any = null;
    if (opts.project) project = this.getProject(opts.project);
    if (!project) project = this.db.prepare("SELECT * FROM projects ORDER BY created_at LIMIT 1").get();

    const assignee = opts.assignee ?? project?.default_assignee ?? opts.created_by ?? null;
    const itemKey = this.nextItemKey(project?.key ?? 'GEN');

    this.db.prepare(`
      INSERT INTO tasks (id, project_id, project_key, item_key, mode, item_type, title, description,
                         status, priority, severity, assignee, created_by, labels,
                         source, source_id, source_url, fingerprint, payload,
                         created_at, updated_at)
      VALUES (?, ?, ?, ?, 'alert', ?, ?, ?, 'firing', 'normal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, project?.id ?? null, project?.key ?? null, itemKey,
      opts.item_type ?? 'alert.generic',
      opts.title, opts.description ?? '',
      opts.severity ?? 'info',
      assignee, opts.created_by ?? null,
      JSON.stringify(opts.labels ?? []),
      opts.source ?? null, opts.source_id ?? null, opts.source_url ?? null,
      fp, JSON.stringify(opts.payload ?? {}),
      now, now,
    );

    return this.getTask(id)!;
  }

  acknowledgeAlert(idOrKey: string, by?: string): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task || task.mode !== 'alert') return null;
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE tasks SET status = ?, acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?'
    ).run('acknowledged', now, by ?? null, now, task.id);
    return this.getTask(task.id);
  }

  resolveAlert(idOrKey: string, by?: string): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task || task.mode !== 'alert') return null;
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?'
    ).run('resolved', now, now, task.id);
    return this.getTask(task.id);
  }

  silenceAlert(idOrKey: string): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task || task.mode !== 'alert') return null;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('silenced', now, task.id);
    return this.getTask(task.id);
  }

  getFiringAlerts(assignee?: string): LocalTask[] {
    const where = assignee ? "AND assignee = ?" : "";
    const params = assignee ? [assignee] : [];
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE mode = 'alert' AND status = 'firing' ${where} ORDER BY created_at DESC LIMIT 50`
    ).all(...params) as any[];
    return rows.map(r => this.mapRow(r));
  }

  // ── Actions (mode='action') ──

  /**
   * Create an action — a pending approval/decision item.
   * Actions can be linked to a task's workflow transition.
   */
  createAction(opts: {
    title: string;
    description?: string;
    assignee?: string;
    created_by?: string;
    priority?: string;
    project?: string;
    labels?: string[];
    linked_task_id?: string;    // task this action controls
    transition_to?: string;     // workflow status to transition to on approval
    workflow?: string;          // workflow name for context
    workflow_status?: string;   // current workflow status for context
  }): LocalTask {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    let project: any = null;
    if (opts.project) project = this.getProject(opts.project);
    if (!project) project = this.db.prepare("SELECT * FROM projects ORDER BY created_at LIMIT 1").get();

    const assignee = opts.assignee ?? project?.default_assignee ?? opts.created_by ?? null;
    const itemKey = this.nextItemKey(project?.key ?? 'GEN');

    this.db.prepare(`
      INSERT INTO tasks (id, project_id, project_key, item_key, mode, item_type, title, description,
                         status, priority, assignee, created_by, labels,
                         linked_task_id, transition_to, workflow, workflow_status,
                         created_at, updated_at)
      VALUES (?, ?, ?, ?, 'action', 'action.approval', ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, project?.id ?? null, project?.key ?? null, itemKey,
      opts.title, opts.description ?? '',
      opts.priority ?? 'normal',
      assignee, opts.created_by ?? null,
      JSON.stringify(opts.labels ?? []),
      opts.linked_task_id ?? null, opts.transition_to ?? null,
      opts.workflow ?? null, opts.workflow_status ?? null,
      now, now,
    );

    return this.getTask(id)!;
  }

  /**
   * Approve an action. If linked to a workflow task, the caller should fire the transition.
   */
  approveAction(idOrKey: string, by?: string): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task || task.mode !== 'action') return null;
    if (task.status !== 'pending') return null; // already acted on
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE tasks SET status = ?, acknowledged_by = ?, completed_at = ?, updated_at = ? WHERE id = ?'
    ).run('approved', by ?? null, now, now, task.id);
    return this.getTask(task.id);
  }

  /**
   * Reject an action.
   */
  rejectAction(idOrKey: string, by?: string, reason?: string): LocalTask | null {
    const task = this.getTask(idOrKey);
    if (!task || task.mode !== 'action') return null;
    if (task.status !== 'pending') return null;
    const now = new Date().toISOString();
    this.db.prepare(
      'UPDATE tasks SET status = ?, acknowledged_by = ?, rejection_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?'
    ).run('rejected', by ?? null, reason ?? null, now, now, task.id);
    return this.getTask(task.id);
  }

  /** Get pending actions, optionally filtered by assignee. */
  getPendingActions(assignee?: string): LocalTask[] {
    const where = assignee ? "AND assignee = ?" : "";
    const params = assignee ? [assignee] : [];
    const rows = this.db.prepare(
      `SELECT * FROM tasks WHERE mode = 'action' AND status = 'pending' ${where} ORDER BY created_at DESC LIMIT 50`
    ).all(...params) as any[];
    return rows.map(r => this.mapRow(r));
  }
}
