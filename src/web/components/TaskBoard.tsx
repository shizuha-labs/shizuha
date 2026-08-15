/**
 * TaskBoard — Kanban board for local Pulse tasks.
 * Columns: Pending, In Progress, Completed.
 * Features: drag-and-drop, inline editing, schedule display, task detail modal.
 */

import { useState, useEffect, useCallback } from 'react';
import { renderMarkdown } from '../lib/markdown';

interface Task {
  id: string;
  item_key: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  assignee: string | null;
  assignee_name: string | null;
  created_by: string | null;
  project_key: string | null;
  labels: string[];
  due_date: string | null;
  is_recurring: boolean;
  schedule: string | null;
  next_run_at: string | null;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
  mode: string;
  severity: string | null;
  source: string | null;
  source_id: string | null;
  fingerprint: string | null;
  payload: Record<string, unknown> | null;
  acknowledged_at: string | null;
  workflow: string | null;
  workflow_status: string | null;
  assignment_group: string | null;
}

interface Project {
  id: string;
  name: string;
  key: string;
  default_assignee: string | null;
}

interface Comment {
  id: string;
  author: string;
  content: string;
  created_at: string;
}

interface TaskBoardProps {
  isOpen: boolean;
  onClose: () => void;
}

const COLUMNS = [
  { status: 'firing', label: 'Alerts', color: 'red' },
  { status: 'pending', label: 'To Do', color: 'zinc' },
  { status: 'in_progress', label: 'In Progress', color: 'blue' },
  { status: 'completed', label: 'Done', color: 'emerald' },
] as const;

// Routing: which statuses go in which column
const DONE_STATUSES = new Set(['completed', 'cancelled', 'blocked', 'resolved', 'silenced']);
const ALERT_STATUSES = new Set(['firing', 'acknowledged']);

const PRIORITY_COLORS: Record<string, string> = {
  urgent: 'bg-red-500', high: 'bg-orange-500', normal: 'bg-blue-500', low: 'bg-zinc-500',
};

const PRIORITY_BORDER: Record<string, string> = {
  urgent: 'border-l-red-500', high: 'border-l-orange-500', normal: 'border-l-blue-500', low: 'border-l-zinc-600',
};

async function api(path: string, method = 'GET', body?: unknown) {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

function relTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const now = Date.now();
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 60000) return diff > 0 ? 'in <1m' : '<1m ago';
  if (abs < 3600000) return `${diff > 0 ? 'in ' : ''}${Math.round(abs / 60000)}m${diff < 0 ? ' ago' : ''}`;
  if (abs < 86400000) return `${diff > 0 ? 'in ' : ''}${Math.round(abs / 3600000)}h${diff < 0 ? ' ago' : ''}`;
  return d.toLocaleDateString();
}

// ── Workflow transition panel ──

const TRIGGER_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  human: { bg: 'bg-amber-600 hover:bg-amber-500', text: 'text-white', label: 'You' },
  agent: { bg: 'bg-purple-800', text: 'text-purple-300', label: 'Agent' },
  auto: { bg: 'bg-zinc-700', text: 'text-zinc-400', label: 'Auto' },
  any: { bg: 'bg-zinc-700 hover:bg-zinc-600', text: 'text-zinc-200', label: 'Any' },
};

interface WorkflowTransition {
  from: string;
  to: string;
  trigger: string;
  label?: string;
  on_transition?: { assign_to?: string; comment?: string; add_label?: string; remove_label?: string };
}

interface WorkflowDef {
  name: string;
  statuses: Array<{ id: string; label: string; category: string; color?: string }>;
  initial_status: string;
  transitions: WorkflowTransition[];
}

function WorkflowPanel({ task, onTransition, busy }: {
  task: Task;
  onTransition: (to: string) => void;
  busy: boolean;
}) {
  const [wf, setWf] = useState<WorkflowDef | null>(null);

  useEffect(() => {
    if (task.workflow) {
      api(`/v1/local-pulse/workflows/${encodeURIComponent(task.workflow)}`).then(d => {
        if (d.workflow) setWf(d.workflow);
      });
    }
  }, [task.workflow]);

  if (!wf || !task.workflow_status) {
    return (
      <div className="flex items-center gap-2 p-2 bg-shizuha-950/30 border border-shizuha-900/50 rounded">
        <svg className="w-3.5 h-3.5 text-shizuha-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
        <div className="text-[10px]">
          <span className="text-shizuha-400 font-medium">{task.workflow}</span>
          <span className="text-zinc-600 mx-1">/</span>
          <span className="text-zinc-300">{task.workflow_status}</span>
        </div>
      </div>
    );
  }

  const currentStatus = wf.statuses.find(s => s.id === task.workflow_status);
  const validTransitions = wf.transitions.filter(t => t.from === task.workflow_status);
  const humanTransitions = validTransitions.filter(t => t.trigger === 'human' || t.trigger === 'any');
  const agentTransitions = validTransitions.filter(t => t.trigger === 'agent');
  const autoTransitions = validTransitions.filter(t => t.trigger === 'auto');

  // Mini pipeline showing where the task is
  const categoryOrder = ['open', 'in_progress', 'done', 'cancelled'];
  const orderedStatuses = [...wf.statuses].sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category));
  const currentIdx = orderedStatuses.findIndex(s => s.id === task.workflow_status);

  return (
    <div className="bg-shizuha-950/30 border border-shizuha-900/50 rounded-lg p-3 space-y-2.5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <svg className="w-3.5 h-3.5 text-shizuha-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
        </svg>
        <span className="text-[10px] text-shizuha-400 font-medium">{wf.name}</span>
      </div>

      {/* Status pipeline */}
      <div className="flex items-center gap-0.5 overflow-x-auto pb-1">
        {orderedStatuses.map((s, i) => {
          const isCurrent = s.id === task.workflow_status;
          const isPast = i < currentIdx;
          return (
            <div key={s.id} className="flex items-center gap-0.5 shrink-0">
              {i > 0 && (
                <svg className={`w-2.5 h-2.5 shrink-0 ${isPast || isCurrent ? 'text-shizuha-600' : 'text-zinc-700'}`} viewBox="0 0 10 10">
                  <path d="M2 1l6 4-6 4" fill="none" stroke="currentColor" strokeWidth={1.5} />
                </svg>
              )}
              <span className={`text-[9px] px-1.5 py-0.5 rounded whitespace-nowrap transition-all ${
                isCurrent
                  ? 'bg-shizuha-600 text-white font-semibold ring-1 ring-shizuha-400'
                  : isPast
                    ? 'bg-zinc-700 text-zinc-400'
                    : 'bg-zinc-800/50 text-zinc-600'
              }`}
                style={isCurrent && s.color ? { backgroundColor: s.color } : undefined}
              >
                {s.label}
              </span>
            </div>
          );
        })}
      </div>

      {/* Transition buttons — direct workflow transitions */}
      {humanTransitions.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10px] text-amber-500 uppercase tracking-wider font-semibold">Transitions</div>
          <div className="flex flex-wrap gap-2">
            {humanTransitions.map((t, i) => {
              const targetStatus = wf.statuses.find(s => s.id === t.to);
              const isCancelType = targetStatus?.category === 'cancelled';
              return (
                <button key={i} disabled={busy}
                  onClick={() => onTransition(t.to)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium cursor-pointer transition-colors disabled:opacity-50 ${
                    isCancelType
                      ? 'bg-zinc-700 hover:bg-zinc-600 text-zinc-300'
                      : 'bg-amber-600 hover:bg-amber-500 text-white'
                  }`}
                >
                  {t.label || targetStatus?.label || t.to}
                  {t.on_transition?.assign_to && <span className="text-[10px] opacity-70 ml-1">→ @{t.on_transition.assign_to}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Agent/auto transitions — info only */}
      {(agentTransitions.length > 0 || autoTransitions.length > 0) && (
        <div className="text-[10px] text-zinc-600 space-y-0.5">
          {autoTransitions.map((t, i) => (
            <div key={'auto' + i}>Auto → {wf.statuses.find(s => s.id === t.to)?.label ?? t.to}</div>
          ))}
          {agentTransitions.map((t, i) => (
            <div key={'agent' + i}>Agent → {wf.statuses.find(s => s.id === t.to)?.label ?? t.to}
              {t.on_transition?.assign_to && <span className="text-zinc-700"> (assigns @{t.on_transition.assign_to})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TaskBoard({ isOpen, onClose }: TaskBoardProps) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<{ total: number; overdue: number; by_status: Record<string, number> } | null>(null);
  const [filterAssignee, setFilterAssignee] = useState('');
  const [filterProject, setFilterProject] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newPriority, setNewPriority] = useState('normal');
  const [newAssignee, setNewAssignee] = useState('');
  const [newProject, setNewProject] = useState('');
  const [newSchedule, setNewSchedule] = useState('');
  const [draggedTask, setDraggedTask] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState('');
  const [editField, setEditField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchTasks = useCallback(async () => {
    const params = new URLSearchParams({ include_completed: 'true', limit: '200' });
    if (filterAssignee) params.set('assignee', filterAssignee);
    if (filterProject) params.set('project', filterProject);
    const data = await api(`/v1/local-pulse/tasks?${params}`);
    setTasks(data.tasks ?? []);
  }, [filterAssignee, filterProject]);

  const fetchMeta = useCallback(async () => {
    const [p, s] = await Promise.all([api('/v1/local-pulse/projects'), api('/v1/local-pulse/stats')]);
    setProjects(p.projects ?? []);
    setStats(s);
  }, []);

  useEffect(() => {
    if (isOpen) {
      fetchTasks(); fetchMeta();
      const iv = setInterval(fetchTasks, 8000);
      return () => clearInterval(iv);
    }
  }, [isOpen, fetchTasks, fetchMeta]);

  const createTask = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    await api('/v1/local-pulse/tasks', 'POST', {
      title: newTitle.trim(), priority: newPriority,
      assignee: newAssignee || undefined, project: newProject || undefined,
      schedule: newSchedule || undefined,
    });
    setNewTitle(''); setNewSchedule(''); setCreating(false);
    await fetchTasks(); await fetchMeta();
    setBusy(false);
  };

  const updateStatus = async (taskId: string, newStatus: string) => {
    setBusy(true);
    await api(`/v1/local-pulse/tasks/${taskId}`, 'PATCH', { status: newStatus });
    await fetchTasks(); await fetchMeta();
    if (selectedTask?.id === taskId) {
      const d = await api(`/v1/local-pulse/tasks/${taskId}`);
      setSelectedTask(d.task);
    }
    setBusy(false);
  };

  const updateField = async (taskId: string, field: string, value: unknown) => {
    setBusy(true);
    await api(`/v1/local-pulse/tasks/${taskId}`, 'PATCH', { [field]: value });
    await fetchTasks();
    if (selectedTask?.id === taskId) {
      const d = await api(`/v1/local-pulse/tasks/${taskId}`);
      setSelectedTask(d.task);
    }
    setEditField(null);
    setBusy(false);
  };

  const deleteTask = async (taskId: string) => {
    setBusy(true);
    await api(`/v1/local-pulse/tasks/${taskId}`, 'DELETE');
    if (selectedTask?.id === taskId) setSelectedTask(null);
    await fetchTasks(); await fetchMeta();
    setBusy(false);
  };

  const openTask = async (task: Task) => {
    setSelectedTask(task);
    const d = await api(`/v1/local-pulse/tasks/${task.id}/comments`);
    setComments(d.comments ?? []);
  };

  const addComment = async () => {
    if (!newComment.trim() || !selectedTask) return;
    await api(`/v1/local-pulse/tasks/${selectedTask.id}/comments`, 'POST', { content: newComment, author: 'dashboard' });
    setNewComment('');
    const d = await api(`/v1/local-pulse/tasks/${selectedTask.id}/comments`);
    setComments(d.comments ?? []);
  };

  const assignees = [...new Set(tasks.map(t => t.assignee_name || t.assignee).filter(Boolean))] as string[];
  const getColumnTasks = (status: string) =>
    status === 'completed' ? tasks.filter(t => DONE_STATUSES.has(t.status))
    : status === 'firing' ? tasks.filter(t => ALERT_STATUSES.has(t.status))
    : tasks.filter(t => t.status === status);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-6xl bg-zinc-900 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-zinc-100">Tasks</h2>
            {stats && (
              <div className="flex gap-3 text-xs text-zinc-500">
                <span>{stats.total} total</span>
                {(stats.by_status?.pending ?? 0) > 0 && <span>{stats.by_status.pending} pending</span>}
                {(stats.by_status?.in_progress ?? 0) > 0 && <span className="text-blue-400">{stats.by_status.in_progress} active</span>}
                {(stats.by_status?.completed ?? 0) > 0 && <span className="text-emerald-400">{stats.by_status.completed} done</span>}
                {(stats.by_status?.cancelled ?? 0) > 0 && <span className="text-zinc-600">{stats.by_status.cancelled} cancelled</span>}
                {stats.overdue > 0 && <span className="text-red-400">{stats.overdue} overdue</span>}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <select value={filterAssignee} onChange={e => setFilterAssignee(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300">
              <option value="">All agents</option>
              {assignees.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={filterProject} onChange={e => setFilterProject(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300">
              <option value="">All projects</option>
              {projects.map(p => <option key={p.key} value={p.key}>{p.key}</option>)}
            </select>
            <button onClick={async () => {
              const r = await api('/v1/local-pulse/sync-all-to-platform', 'POST');
              if (r.ok) alert(`Synced ${r.synced} tasks to platform (${r.failed} failed)`);
              else alert('Sync failed: ' + (r.error || 'unknown'));
            }}
              className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 text-white text-xs rounded cursor-pointer"
              title="Push all local tasks to the platform Pulse service">Sync to Platform</button>
            <button onClick={() => setCreating(!creating)}
              className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded cursor-pointer">+ New</button>
            <button onClick={onClose} className="w-7 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-200 cursor-pointer">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Create form */}
        {creating && (
          <div className="px-6 py-2.5 border-b border-zinc-800 flex gap-2 items-center flex-wrap">
            <input autoFocus value={newTitle} onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && createTask()} placeholder="Task title..."
              className="flex-1 min-w-[200px] bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-blue-500" />
            <select value={newPriority} onChange={e => setNewPriority(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300">
              <option value="low">Low</option><option value="normal">Normal</option>
              <option value="high">High</option><option value="urgent">Urgent</option>
            </select>
            <input value={newAssignee} onChange={e => setNewAssignee(e.target.value)} placeholder="Assignee"
              className="w-20 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder-zinc-600" />
            <select value={newProject} onChange={e => setNewProject(e.target.value)}
              className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300">
              <option value="">Project</option>
              {projects.map(p => <option key={p.key} value={p.key}>{p.key}</option>)}
            </select>
            <input value={newSchedule} onChange={e => setNewSchedule(e.target.value)} placeholder="e.g. every 1h"
              className="w-24 bg-zinc-800 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-300 placeholder-zinc-600"
              title="Recurring schedule: every 30m, every 1h, every 6h, every 1d" />
            <button onClick={createTask} disabled={busy || !newTitle.trim()}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs rounded disabled:opacity-50 cursor-pointer">Create</button>
          </div>
        )}

        {/* Kanban + Detail split */}
        <div className="flex-1 flex overflow-hidden">
          {/* Columns */}
          <div className={`flex-1 overflow-x-auto p-3 ${selectedTask ? 'max-w-[60%]' : ''}`}>
            <div className="flex gap-3 h-full min-h-0">
              {COLUMNS.map(col => {
                const colTasks = getColumnTasks(col.status);
                return (
                  <div key={col.status}
                    className="flex-1 min-w-[240px] flex flex-col rounded-lg"
                    onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add('ring-1', 'ring-blue-500/50'); }}
                    onDragLeave={e => { e.currentTarget.classList.remove('ring-1', 'ring-blue-500/50'); }}
                    onDrop={e => { e.preventDefault(); e.currentTarget.classList.remove('ring-1', 'ring-blue-500/50'); if (draggedTask) updateStatus(draggedTask, col.status); setDraggedTask(null); }}>
                    <div className="px-3 py-2 flex items-center gap-2">
                      <div className={`w-2 h-2 rounded-full ${
                        col.color === 'red' ? 'bg-red-500' : col.color === 'blue' ? 'bg-blue-500' : col.color === 'emerald' ? 'bg-emerald-500' : 'bg-zinc-500'
                      }`} />
                      <span className="text-xs font-semibold text-zinc-300 uppercase tracking-wider">{col.label}</span>
                      <span className="text-[10px] text-zinc-600 ml-auto">{colTasks.length}</span>
                    </div>
                    <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-1.5">
                      {colTasks.map(task => (
                        <div key={task.id} draggable onDragStart={() => setDraggedTask(task.id)} onDragEnd={() => setDraggedTask(null)}
                          onClick={() => openTask(task)}
                          className={`bg-zinc-800 rounded-lg p-3 cursor-pointer border-l-4 border border-zinc-700/50 transition-all hover:shadow-md hover:border-zinc-600 ${
                            PRIORITY_BORDER[task.priority] ?? 'border-l-zinc-600'
                          } ${selectedTask?.id === task.id ? 'ring-1 ring-blue-500/60' : ''} ${draggedTask === task.id ? 'opacity-50' : ''}`}>
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="text-[11px] font-mono text-zinc-400 font-medium">{task.item_key}</span>
                            {(task as any).mode === 'alert' ? (
                              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                (task as any).severity === 'critical' ? 'bg-red-600 text-white' :
                                (task as any).severity === 'error' ? 'bg-red-500/80 text-white' :
                                (task as any).severity === 'warning' ? 'bg-orange-500/80 text-white' :
                                'bg-blue-500/50 text-blue-200'
                              }`}>{(task as any).severity ?? 'info'}</span>
                            ) : null}
                            {task.is_recurring && <span className="text-[11px] text-purple-400" title={`Recurring: ${task.schedule}`}>↻</span>}
                            {task.workflow && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-shizuha-900/60 text-shizuha-300 border border-shizuha-700/50" title={`Workflow: ${task.workflow} — ${task.workflow_status}`}>
                                {task.workflow_status || task.workflow}
                              </span>
                            )}
                            <span className="text-[10px] text-zinc-500 ml-auto font-mono">{task.project_key}</span>
                          </div>
                          <p className={`text-sm leading-snug font-medium ${task.status === 'cancelled' ? 'text-zinc-500 line-through' : task.status === 'blocked' ? 'text-orange-300' : 'text-zinc-100'}`}>{task.title}</p>
                          <div className="flex items-center gap-2.5 mt-2 text-[11px] text-zinc-500">
                            {(task.assignee_name || task.assignee) && (
                              <span className="flex items-center gap-1.5">
                                <span className="w-5 h-5 rounded-full bg-zinc-700 flex items-center justify-center text-[9px] text-zinc-300 uppercase font-medium">{(task.assignee_name || task.assignee || '').slice(0, 2)}</span>
                                {task.assignee_name || task.assignee}
                              </span>
                            )}
                            {task.is_recurring && <span className="text-purple-400">{task.schedule}</span>}
                            {task.due_date && !task.is_recurring && (
                              <span className={new Date(task.due_date) < new Date() && task.status !== 'completed' ? 'text-red-400' : ''}>
                                {relTime(task.due_date)}
                              </span>
                            )}
                            {task.next_run_at && <span className="text-purple-400/70" title="Next trigger">{relTime(task.next_run_at)}</span>}
                          </div>
                        </div>
                      ))}
                      {colTasks.length === 0 && <div className="text-center text-zinc-700 text-[10px] py-6">Empty</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Task detail panel */}
          {selectedTask && (
            <div className="w-[45%] min-w-[380px] border-l border-zinc-800 overflow-y-auto p-5 space-y-4">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-xs font-mono text-zinc-400">{selectedTask.item_key}</span>
                  {editField === 'title' ? (
                    <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                      onBlur={() => updateField(selectedTask.id, 'title', editValue)}
                      onKeyDown={e => { if (e.key === 'Enter') updateField(selectedTask.id, 'title', editValue); if (e.key === 'Escape') setEditField(null); }}
                      className="block w-full mt-1 bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-sm text-zinc-200" />
                  ) : (
                    <h3 className="text-base font-semibold text-zinc-100 mt-1 cursor-pointer hover:text-blue-300"
                      onClick={() => { setEditField('title'); setEditValue(selectedTask.title); }}>
                      {selectedTask.title}
                    </h3>
                  )}
                </div>
                <button onClick={() => setSelectedTask(null)} className="text-zinc-500 hover:text-zinc-300 cursor-pointer text-lg">×</button>
              </div>

              {/* Status + Priority */}
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase">Status</label>
                  <select value={selectedTask.status} onChange={e => updateStatus(selectedTask.id, e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 mt-0.5">
                    <option value="pending">Pending</option><option value="in_progress">In Progress</option>
                    <option value="completed">Completed</option><option value="blocked">Blocked</option>
                    <option value="cancelled">Cancelled</option>
                  </select>
                </div>
                <div>
                  <label className="text-[10px] text-zinc-500 uppercase">Priority</label>
                  <select value={selectedTask.priority} onChange={e => updateField(selectedTask.id, 'priority', e.target.value)}
                    className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 mt-0.5">
                    <option value="low">Low</option><option value="normal">Normal</option>
                    <option value="high">High</option><option value="urgent">Urgent</option>
                  </select>
                </div>
              </div>

              {/* Assignee */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase">Assignee</label>
                {editField === 'assignee' ? (
                  <input autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                    onBlur={() => updateField(selectedTask.id, 'assignee', editValue)}
                    onKeyDown={e => { if (e.key === 'Enter') updateField(selectedTask.id, 'assignee', editValue); if (e.key === 'Escape') setEditField(null); }}
                    className="w-full bg-zinc-800 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-300 mt-0.5" />
                ) : (
                  <p className="text-xs text-zinc-300 mt-0.5 cursor-pointer hover:text-blue-300"
                    onClick={() => { setEditField('assignee'); setEditValue(selectedTask.assignee ?? ''); }}>
                    {selectedTask.assignee_name || selectedTask.assignee || '(unassigned)'}
                  </p>
                )}
              </div>

              {/* Workflow status + transition buttons — placed ABOVE description for visibility */}
              {selectedTask.workflow && (
                <WorkflowPanel task={selectedTask} onTransition={async (to) => {
                  setBusy(true);
                  await api(`/v1/local-pulse/tasks/${selectedTask.id}/transition`, 'POST', { to, actor_type: 'human', actor: 'dashboard' });
                  await fetchTasks();
                  const refreshed = await api(`/v1/local-pulse/tasks/${selectedTask.item_key}`);
                  if (refreshed.task) setSelectedTask(refreshed.task);
                  const cmts = await api(`/v1/local-pulse/tasks/${selectedTask.id}/comments`);
                  setComments(cmts.comments ?? []);
                  setBusy(false);
                }} busy={busy} />
              )}

              {/* Schedule info */}
              {(selectedTask.is_recurring || selectedTask.schedule) && (
                <div className="bg-purple-900/20 border border-purple-500/20 rounded-lg p-2.5">
                  <div className="text-[9px] text-purple-400 uppercase font-semibold mb-1">Recurring</div>
                  <div className="text-xs text-zinc-300">Schedule: <span className="text-purple-300">{selectedTask.schedule}</span></div>
                  {selectedTask.next_run_at && <div className="text-xs text-zinc-400 mt-0.5">Next: {relTime(selectedTask.next_run_at)} <span className="text-zinc-600">({new Date(selectedTask.next_run_at).toLocaleString()})</span></div>}
                  {selectedTask.last_triggered_at && <div className="text-xs text-zinc-500 mt-0.5">Last: {relTime(selectedTask.last_triggered_at)}</div>}
                </div>
              )}

              {/* Description */}
              <div>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] text-zinc-500 uppercase">Description</label>
                  {editField !== 'description' && (
                    <button onClick={() => { setEditField('description'); setEditValue(selectedTask.description ?? ''); }}
                      className="text-[10px] text-zinc-600 hover:text-zinc-400 cursor-pointer">edit</button>
                  )}
                </div>
                {editField === 'description' ? (
                  <textarea autoFocus value={editValue} onChange={e => setEditValue(e.target.value)}
                    onBlur={() => updateField(selectedTask.id, 'description', editValue)}
                    rows={8} className="w-full bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-300 mt-1 resize-y font-mono" />
                ) : selectedTask.description ? (
                  <div className="markdown-content text-sm text-zinc-300 mt-1 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedTask.description) }} />
                ) : (
                  <p className="text-sm text-zinc-600 mt-1 cursor-pointer hover:text-zinc-400"
                    onClick={() => { setEditField('description'); setEditValue(''); }}>
                    (click to add description)
                  </p>
                )}
              </div>

              {/* Meta */}
              <div className="text-xs text-zinc-500 space-y-1 border-t border-zinc-800 pt-3">
                <div>Project: <span className="text-zinc-400">{selectedTask.project_key ?? 'none'}</span> &middot; Created by: <span className="text-zinc-400">{selectedTask.created_by ?? '?'}</span></div>
                <div>Created: {new Date(selectedTask.created_at).toLocaleString()} &middot; Updated: {new Date(selectedTask.updated_at).toLocaleString()}</div>
                {selectedTask.labels?.length > 0 && (
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span>Labels:</span>
                    {selectedTask.labels.map((l: string) => (
                      <span key={l} className="px-1.5 py-0.5 bg-zinc-800 text-zinc-300 rounded text-[10px]">{l}</span>
                    ))}
                  </div>
                )}
              </div>

              {/* Comments */}
              <div>
                <label className="text-[10px] text-zinc-500 uppercase">Comments ({comments.length})</label>
                <div className="mt-1 space-y-1.5 max-h-40 overflow-y-auto">
                  {comments.map(c => (
                    <div key={c.id} className="bg-zinc-800 rounded p-2">
                      <div className="flex items-center gap-2 text-[9px] text-zinc-500">
                        <span className="font-medium text-zinc-400">{c.author}</span>
                        <span>{new Date(c.created_at).toLocaleString()}</span>
                      </div>
                      <p className="text-xs text-zinc-300 mt-0.5">{c.content}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-1.5 mt-2">
                  <input value={newComment} onChange={e => setNewComment(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addComment()} placeholder="Add comment..."
                    className="flex-1 bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-300 placeholder-zinc-600" />
                  <button onClick={addComment} disabled={!newComment.trim()}
                    className="px-2 py-1 bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-300 rounded disabled:opacity-50 cursor-pointer">Post</button>
                </div>
              </div>

              {/* Stop recurring / Delete */}
              <div className="flex gap-2">
                {selectedTask.is_recurring && selectedTask.status !== 'cancelled' && (
                  <button onClick={async () => {
                    setBusy(true);
                    await api(`/v1/local-pulse/tasks/${selectedTask.id}/cancel-recurring`, 'POST');
                    await fetchTasks(); await fetchMeta();
                    const d = await api(`/v1/local-pulse/tasks/${selectedTask.id}`);
                    setSelectedTask(d.task);
                    setBusy(false);
                  }} className="flex-1 text-center text-[10px] text-orange-400 hover:text-orange-300 py-1 cursor-pointer">
                    Stop recurring
                  </button>
                )}
                <button onClick={() => deleteTask(selectedTask.id)}
                  className="flex-1 text-center text-[10px] text-red-400 hover:text-red-300 py-1 cursor-pointer">
                  Delete task
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
