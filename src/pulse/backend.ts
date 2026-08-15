/**
 * Pulse Backend Adapter — routes task operations to either platform API or local SQLite.
 *
 * At startup, checks if the platform is reachable via the daemon's pulse-proxy.
 * If yes → all task CRUD goes to the platform API.
 * If no  → all task CRUD goes to the local SQLite store.
 *
 * The agent sees the same tool interface regardless of backend.
 * No sync between the two — they are separate data stores.
 */

import * as http from 'node:http';

const DAEMON_HOST = process.env['DAEMON_HOST'] || '127.0.0.1';
const DAEMON_PORT = parseInt(process.env['DAEMON_PORT'] || '8016', 10);

/** Convert markdown to HTML for platform TipTap editor. */
function mdToHtml(md: string): string {
  if (!md) return '';
  let html = md;
  // Code blocks (```...```) → <pre><code>
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre><code>${code.replace(/</g, '&lt;').replace(/>/g, '&gt;').trimEnd()}</code></pre>`);
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Headers
  html = html.replace(/^### (.+)$/gm, '</p><h3>$1</h3><p>');
  html = html.replace(/^## (.+)$/gm, '</p><h2>$1</h2><p>');
  html = html.replace(/^# (.+)$/gm, '</p><h1>$1</h1><p>');
  // Ordered list items
  html = html.replace(/^(\d+)\. (.+)$/gm, '<li>$2</li>');
  // Unordered list items
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  // Wrap consecutive <li> in <ol>/<ul>
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, '<ul>$1</ul>');
  html = html.replace(/<\/ul>\s*<ul>/g, ''); // merge adjacent
  // HR
  html = html.replace(/^---$/gm, '<hr/>');
  // Paragraphs: double newline
  html = html.replace(/\n\n/g, '</p><p>');
  // Single newlines → <br>
  html = html.replace(/\n/g, '<br/>');
  // Wrap
  html = '<p>' + html + '</p>';
  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p><(h[123]|pre|ul|ol|hr)/g, '<$1');
  html = html.replace(/<\/(h[123]|pre|ul|ol)><\/p>/g, '</$1>');
  return html;
}

// Human email mapping (same as teams config)
const HUMAN_EMAILS: Record<string, string> = {
  hritik: 'hothritik1@gmail.com',
};

function toEmail(username: string): string {
  return HUMAN_EMAILS[username] ?? `${username}@agents.shizuha.io`;
}

function fromEmail(email: string): string {
  for (const [user, e] of Object.entries(HUMAN_EMAILS)) {
    if (e === email) return user;
  }
  return email.split('@')[0] ?? email;
}

export type PulseBackend = 'platform' | 'local';

let _backend: PulseBackend | null = null;
let _projectIdCache = new Map<string, number>();

/** Detect which backend to use. Caches the result. */
export async function detectBackend(): Promise<PulseBackend> {
  if (_backend) return _backend;
  try {
    const resp = await daemonRequest('GET', '/v1/pulse-proxy/projects/', undefined, 3000);
    if (resp.statusCode === 200) {
      _backend = 'platform';
      // Cache project key → ID mapping
      const data = resp.data as Record<string, unknown>;
      const results = (data.results ?? data) as Array<Record<string, unknown>>;
      for (const p of results) {
        if (typeof p.key === 'string' && typeof p.id === 'number') {
          _projectIdCache.set(p.key, p.id);
        }
      }
    } else {
      _backend = 'local';
    }
  } catch {
    _backend = 'local';
  }
  return _backend;
}

export function getBackend(): PulseBackend {
  return _backend ?? 'local';
}

/** Reset backend detection (e.g., on connectivity change). */
export function resetBackend(): void {
  _backend = null;
}

// ── Normalized task shape (what tools see) ──

export interface NormalizedTask {
  id: string;
  item_key: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string | null;
  created_by: string | null;
  project_key: string | null;
  labels: string[];
  due_date: string | null;
  is_recurring: boolean;
  schedule: string | null;
  next_run_at: string | null;
  workflow: string | null;
  workflow_status: string | null;
  assignment_group: string | null;
  mode: string;
  severity: string | null;
  created_at: string;
  updated_at: string;
}

// ── Platform response → normalized ──

function normalizePlatformTask(t: Record<string, unknown>): NormalizedTask {
  return {
    id: String(t.id ?? ''),
    item_key: String(t.item_key ?? t.id ?? ''),
    title: String(t.title ?? ''),
    description: String(t.description ?? ''),
    status: String(t.status ?? 'pending'),
    priority: String(t.priority ?? 'normal'),
    assignee: t.assignee_email ? fromEmail(String(t.assignee_email)) : null,
    created_by: t.created_by_email ? fromEmail(String(t.created_by_email)) : null,
    project_key: String(t.project_key ?? t.project ?? ''),
    labels: (t.labels ?? []) as string[],
    due_date: (t.due_date as string) ?? null,
    is_recurring: !!(t.is_recurring ?? t.recurrence_pattern),
    schedule: (t.recurrence_pattern as string) ?? null,
    next_run_at: null,
    workflow: (t.metadata as any)?.workflow ?? null,
    workflow_status: (t.metadata as any)?.workflow_status ?? null,
    assignment_group: (t.assignment_group as string) ?? null,
    mode: String(t.mode ?? 'task'),
    severity: (t.severity as string) ?? null,
    created_at: String(t.created_at ?? ''),
    updated_at: String(t.updated_at ?? ''),
  };
}

// ── Routing functions ──

export async function createTask(args: Record<string, unknown>, agentUsername: string): Promise<NormalizedTask | { error: string }> {
  const backend = getBackend();

  if (backend === 'platform') {
    const body: Record<string, unknown> = {
      title: args.title,
      description: mdToHtml(String(args.description ?? '')),
      priority: args.priority ?? 'normal',
      status: args.status ?? 'pending',
      mode: 'task',
      labels: args.labels ?? [],
      source: 'agent-runtime',
    };
    if (args.assignee) body.assignee_email = toEmail(String(args.assignee));
    else body.assignee_email = toEmail(args.created_by as string ?? agentUsername);
    if (args.created_by) body.created_by_email = toEmail(String(args.created_by));
    if (args.due_date) body.due_date = args.due_date;
    if (args.project) {
      const pid = _projectIdCache.get(String(args.project));
      if (pid) body.project = pid;
    }
    if (args.workflow) {
      body.workflow_name = args.workflow;
      body.workflow_status = args.workflow_status ?? null;
    }
    if (args.assignment_group) body.assignment_group = args.assignment_group;

    const resp = await daemonRequest('POST', '/v1/pulse-proxy/tasks/', body, 10000);
    if (resp.statusCode === 200 || resp.statusCode === 201) {
      return normalizePlatformTask(resp.data as Record<string, unknown>);
    }
    return { error: String((resp.data as any)?.detail ?? (resp.data as any)?.error ?? 'Creation failed') };
  }

  // Local backend — route through daemon HTTP (existing behavior)
  const resp = await daemonRequest('POST', '/v1/local-pulse/tasks', {
    ...args, created_by: args.created_by ?? agentUsername,
  }, 10000);
  const task = (resp.data as any)?.task;
  if (!task) return { error: (resp.data as any)?.error ?? 'Creation failed' };
  return task as NormalizedTask;
}

export async function listTasks(args: Record<string, unknown>): Promise<NormalizedTask[]> {
  const backend = getBackend();

  if (backend === 'platform') {
    const params = new URLSearchParams();
    if (args.status) params.set('status', String(args.status));
    // Use assignee_id when available (most reliable), fall back to assignee_email
    if (args.assignee_id) params.set('assignee_id', String(args.assignee_id));
    else if (args.assignee) params.set('assignee_email', toEmail(String(args.assignee)));
    if (args.assignment_group) params.set('assignment_group', String(args.assignment_group));
    if (args.priority) params.set('priority', String(args.priority));
    if (args.limit) params.set('limit', String(args.limit));
    const resp = await daemonRequest('GET', `/v1/pulse-proxy/tasks/?${params}`, undefined, 10000);
    if (resp.statusCode === 200) {
      const data = resp.data as Record<string, unknown>;
      const results = (data.results ?? []) as Array<Record<string, unknown>>;
      return results.map(normalizePlatformTask);
    }
    return [];
  }

  const params = new URLSearchParams();
  for (const key of ['status', 'assignee', 'project', 'priority', 'limit']) {
    if (args[key] !== undefined) params.set(key, String(args[key]));
  }
  if (args.include_completed) params.set('include_completed', 'true');
  const resp = await daemonRequest('GET', `/v1/local-pulse/tasks?${params}`, undefined, 10000);
  return ((resp.data as any)?.tasks ?? []) as NormalizedTask[];
}

export async function getTask(idOrKey: string): Promise<{ task: NormalizedTask | null; comments: Array<{ author: string; content: string; created_at: string }> }> {
  const backend = getBackend();

  if (backend === 'platform') {
    const resp = await daemonRequest('GET', `/v1/pulse-proxy/tasks/${encodeURIComponent(idOrKey)}/`, undefined, 5000);
    if (resp.statusCode === 200) {
      const task = normalizePlatformTask(resp.data as Record<string, unknown>);
      // Fetch comments separately
      let comments: any[] = [];
      try {
        const cResp = await daemonRequest('GET', `/v1/pulse-proxy/items/${task.id}/comments/`, undefined, 5000);
        if (cResp.statusCode === 200) {
          const cData = cResp.data as Record<string, unknown>;
          comments = ((cData.results ?? cData) as any[]).map((c: any) => ({
            author: c.created_by_email?.split('@')[0] ?? 'unknown',
            content: c.content ?? '',
            created_at: c.created_at ?? '',
          }));
        }
      } catch { /* comments are optional */ }
      return { task, comments };
    }
    return { task: null, comments: [] };
  }

  const resp = await daemonRequest('GET', `/v1/local-pulse/tasks/${encodeURIComponent(idOrKey)}`, undefined, 5000);
  const d = resp.data as any;
  return { task: d.task ?? null, comments: d.comments ?? [] };
}

export async function updateTask(idOrKey: string, updates: Record<string, unknown>): Promise<NormalizedTask | null> {
  const backend = getBackend();

  if (backend === 'platform') {
    // Need to resolve the platform ID first
    const { task } = await getTask(idOrKey);
    if (!task) return null;
    const body: Record<string, unknown> = {};
    if (updates.title !== undefined) body.title = updates.title;
    if (updates.description !== undefined) body.description = updates.description;
    if (updates.status !== undefined) body.status = updates.status;
    if (updates.priority !== undefined) body.priority = updates.priority;
    if (updates.assignee !== undefined) body.assignee_email = updates.assignee ? toEmail(String(updates.assignee)) : null;
    if (updates.labels !== undefined) body.labels = updates.labels;
    if (updates.due_date !== undefined) body.due_date = updates.due_date;
    if (updates.assignment_group !== undefined) body.assignment_group = updates.assignment_group;

    const resp = await daemonRequest('PATCH', `/v1/pulse-proxy/tasks/${task.id}/`, body, 10000);
    if (resp.statusCode === 200) return normalizePlatformTask(resp.data as Record<string, unknown>);
    return null;
  }

  const resp = await daemonRequest('PATCH', `/v1/local-pulse/tasks/${encodeURIComponent(idOrKey)}`, updates, 10000);
  return (resp.data as any)?.task ?? null;
}

export async function completeTask(idOrKey: string): Promise<NormalizedTask | null> {
  const backend = getBackend();

  if (backend === 'platform') {
    return updateTask(idOrKey, { status: 'completed' });
  }

  const resp = await daemonRequest('POST', `/v1/local-pulse/tasks/${encodeURIComponent(idOrKey)}/complete`, {}, 10000);
  return (resp.data as any)?.task ?? null;
}

export async function addComment(idOrKey: string, author: string, content: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === 'platform') {
    const { task } = await getTask(idOrKey);
    if (!task) return false;
    const resp = await daemonRequest('POST', `/v1/pulse-proxy/items/${task.id}/comments/`, { content }, 10000);
    return resp.statusCode === 200 || resp.statusCode === 201;
  }

  const resp = await daemonRequest('POST', `/v1/local-pulse/tasks/${encodeURIComponent(idOrKey)}/comments`, { content, author }, 10000);
  return !(resp.data as any)?.error;
}

export async function searchTasks(query: string, limit = 20): Promise<NormalizedTask[]> {
  const backend = getBackend();

  if (backend === 'platform') {
    const resp = await daemonRequest('GET', `/v1/pulse-proxy/tasks/?search=${encodeURIComponent(query)}&limit=${limit}`, undefined, 10000);
    if (resp.statusCode === 200) {
      const data = resp.data as Record<string, unknown>;
      return ((data.results ?? []) as Array<Record<string, unknown>>).map(normalizePlatformTask);
    }
    return [];
  }

  const resp = await daemonRequest('GET', `/v1/local-pulse/search?q=${encodeURIComponent(query)}&limit=${limit}`, undefined, 10000);
  return ((resp.data as any)?.tasks ?? []) as NormalizedTask[];
}

export async function transitionTask(idOrKey: string, to: string, actorType: string, actor: string, comment?: string): Promise<{ task?: NormalizedTask; comment?: string; error?: string }> {
  // Transitions always go through local (workflow engine is local)
  // If platform backend, we also update the platform task status afterwards
  const resp = await daemonRequest('POST',
    `/v1/local-pulse/tasks/${encodeURIComponent(idOrKey)}/transition`,
    { to, actor_type: actorType, actor, comment }, 10000);
  const d = resp.data as any;
  if (d.error) return { error: d.error };

  // If platform backend, sync the status change
  if (getBackend() === 'platform' && d.task?.remote_id) {
    try {
      await daemonRequest('PATCH', `/v1/pulse-proxy/tasks/${d.task.remote_id}/`, {
        status: d.task.status,
        assignment_group: d.task.assignment_group,
        assignee_email: d.task.assignee ? toEmail(d.task.assignee) : undefined,
      }, 5000);
    } catch { /* best-effort platform update */ }
  }

  return { task: d.task, comment: d.comment };
}

// ── HTTP helper ──

function daemonRequest(
  method: string, urlPath: string, body?: unknown, timeout = 5000,
): Promise<{ statusCode: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      hostname: DAEMON_HOST, port: DAEMON_PORT, path: urlPath, method, timeout,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => { raw += chunk; });
      res.on('end', () => {
        try { resolve({ statusCode: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : {} }); }
        catch { resolve({ statusCode: res.statusCode ?? 0, data: { raw } }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (payload) req.write(payload);
    req.end();
  });
}
