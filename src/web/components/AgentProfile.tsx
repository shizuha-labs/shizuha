import { useState, useEffect } from 'react';
import type { Agent } from '../lib/types';
import { getAgentModel } from '../lib/types';

interface AgentProfileProps {
  agent: Agent;
  isOpen: boolean;
  onClose: () => void;
  onAgentUpdated?: () => void;
}

const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  running: { label: 'Online', color: 'text-green-400' },
  starting: { label: 'Starting...', color: 'text-yellow-400' },
  error: { label: 'Error', color: 'text-red-400' },
  stopped: { label: 'Offline', color: 'text-zinc-500' },
  unknown: { label: 'Unknown', color: 'text-zinc-600' },
};

const AVAILABLE_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-4.1',
  'o4-mini',
  'codex-mini-latest',
  'gemini-2.0-flash',
];

const EXECUTION_METHODS = [
  'cli',
  'claude_code_server',
  'sdk',
  'direct',
  'sdk_direct',
  'codex',
  'codex_app_server',
  'codex_sdk',
];

const RUNTIME_ENVIRONMENTS: Array<{ value: string; label: string; description: string }> = [
  { value: 'bare_metal', label: 'Bare Metal', description: 'Direct host execution (fastest)' },
  { value: 'container', label: 'Container', description: 'Docker isolated' },
  { value: 'restricted_container', label: 'Restricted Container', description: 'Docker + seccomp, cap-drop, pids limit' },
  { value: 'sandbox', label: 'Sandbox', description: 'Fully isolated (no network, read-only fs)' },
];

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    'bg-blue-600', 'bg-purple-600', 'bg-emerald-600', 'bg-rose-600',
    'bg-amber-600', 'bg-cyan-600', 'bg-indigo-600', 'bg-teal-600',
  ];
  return colors[Math.abs(hash) % colors.length]!;
}

async function patchAgent(agentId: string, updates: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function AgentProfile({ agent, isOpen, onClose, onAgentUpdated }: AgentProfileProps) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Editable fields
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');

  // Reset editing state when agent changes or panel closes
  useEffect(() => {
    setEditingField(null);
    setError(null);
  }, [agent.id, isOpen]);

  if (!isOpen) return null;

  const model = getAgentModel(agent);
  const status = STATUS_LABELS[agent.status] ?? STATUS_LABELS['unknown']!;
  const traits = Object.entries(agent.personalityTraits || {});

  const startEdit = (field: string, value: string) => {
    setEditingField(field);
    setEditValue(value);
    setError(null);
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditValue('');
  };

  const saveField = async (field: string, value: unknown) => {
    setSaving(field);
    setError(null);
    const ok = await patchAgent(agent.id, { [field]: value });
    setSaving(null);
    if (ok) {
      setEditingField(null);
      onAgentUpdated?.();
    } else {
      setError(`Failed to update ${field}`);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent, field: string, value: unknown) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveField(field, value);
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-zinc-900 border-l border-zinc-700 w-full sm:max-w-sm h-full overflow-y-auto">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800">
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
          <span className="text-sm font-semibold text-zinc-200">Agent Settings</span>
        </div>

        {/* Avatar + Name */}
        <div className="flex flex-col items-center py-6 px-4">
          <div className={`w-20 h-20 rounded-full ${hashColor(agent.name)} flex items-center justify-center mb-3`}>
            <span className="text-2xl font-bold text-white">{agent.name.slice(0, 2).toUpperCase()}</span>
          </div>
          <h2 className="text-lg font-semibold text-zinc-100">{agent.name}</h2>
          <p className="text-sm text-zinc-500">@{agent.username}</p>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-2 h-2 rounded-full ${agent.status === 'running' ? 'bg-green-400' : agent.status === 'error' ? 'bg-red-400' : 'bg-zinc-500'}`} />
            <span className={`text-xs ${status.color}`}>{status.label}</span>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="mx-4 mb-3 text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
            {error}
          </div>
        )}

        {/* Config sections */}
        <div className="px-4 pb-6 space-y-4">
          {/* Configuration */}
          <Section title="Configuration">
            <Row label="Role" value={agent.role ?? 'Agent'} />

            {/* Execution Method — dropdown */}
            {editingField === 'execution_method' ? (
              <div className="px-3 py-2 space-y-2">
                <span className="text-xs text-zinc-400">Execution</span>
                <select
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                >
                  {EXECUTION_METHODS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <EditActions
                  saving={saving === 'execution_method'}
                  onSave={() => saveField('execution_method', editValue)}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <EditableRow
                label="Execution"
                value={agent.executionMethod}
                mono
                onClick={() => startEdit('execution_method', agent.executionMethod)}
              />
            )}

            {/* Runtime Environment — dropdown */}
            {editingField === 'runtime_environment' ? (
              <div className="px-3 py-2 space-y-2">
                <span className="text-xs text-zinc-400">Runtime</span>
                <select
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                >
                  {RUNTIME_ENVIRONMENTS.map((r) => (
                    <option key={r.value} value={r.value}>{r.label} — {r.description}</option>
                  ))}
                </select>
                <EditActions
                  saving={saving === 'runtime_environment'}
                  onSave={() => saveField('runtimeEnvironment', editValue)}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <EditableRow
                label="Runtime"
                value={RUNTIME_ENVIRONMENTS.find((r) => r.value === agent.runtimeEnvironment)?.label ?? agent.runtimeEnvironment ?? 'Bare Metal'}
                onClick={() => startEdit('runtime_environment', agent.runtimeEnvironment ?? 'bare_metal')}
              />
            )}

            {/* Model — dropdown */}
            {editingField === 'model' ? (
              <div className="px-3 py-2 space-y-2">
                <span className="text-xs text-zinc-400">Model</span>
                <select
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                >
                  {AVAILABLE_MODELS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                  {/* Include current value if not in list */}
                  {!AVAILABLE_MODELS.includes(model) && (
                    <option value={model}>{model} (current)</option>
                  )}
                </select>
                <EditActions
                  saving={saving === 'model'}
                  onSave={() => {
                    // Update model_overrides for the current execution method
                    const overrides = { ...(agent.modelOverrides ?? {}), [agent.executionMethod]: editValue };
                    saveField('modelOverrides', overrides);
                  }}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <EditableRow
                label="Model"
                value={model}
                mono
                onClick={() => startEdit('model', model)}
              />
            )}

            {/* Email — text input */}
            {editingField === 'email' ? (
              <div className="px-3 py-2 space-y-2">
                <span className="text-xs text-zinc-400">Email</span>
                <input
                  type="email"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={(e) => handleKeyDown(e, 'email', editValue)}
                  autoFocus
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                />
                <EditActions
                  saving={saving === 'email'}
                  onSave={() => saveField('email', editValue)}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <EditableRow
                label="Email"
                value={agent.email}
                mono
                onClick={() => startEdit('email', agent.email)}
              />
            )}

            {agent.pid && <Row label="PID" value={String(agent.pid)} />}
          </Section>

          {/* Model Overrides — editable per key */}
          <Section
            title="Model Overrides"
            action={
              <button
                onClick={() => startEdit('modelOverrides_new', '')}
                className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer"
              >
                + Add
              </button>
            }
          >
            {Object.entries((agent.modelOverrides ?? {})).map(([key, val]) => (
              editingField === `override_${key}` ? (
                <div key={key} className="px-3 py-2 space-y-2">
                  <span className="text-xs text-zinc-400">{key}</span>
                  <select
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                  >
                    {AVAILABLE_MODELS.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                    {!AVAILABLE_MODELS.includes(val) && (
                      <option value={val}>{val} (current)</option>
                    )}
                  </select>
                  <EditActions
                    saving={saving === `override_${key}`}
                    onSave={() => {
                      const overrides = { ...(agent.modelOverrides ?? {}), [key]: editValue };
                      saveField('modelOverrides', overrides);
                    }}
                    onCancel={cancelEdit}
                  />
                </div>
              ) : (
                <EditableRow
                  key={key}
                  label={key}
                  value={val}
                  mono
                  onClick={() => startEdit(`override_${key}`, val)}
                />
              )
            ))}
            {editingField === 'modelOverrides_new' && (
              <div className="px-3 py-2 space-y-2">
                <input
                  type="text"
                  placeholder="Method (e.g. cli, codex)"
                  value={editValue.split('|')[0] ?? ''}
                  onChange={(e) => setEditValue(e.target.value + '|' + (editValue.split('|')[1] ?? ''))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                />
                <select
                  value={editValue.split('|')[1] ?? ''}
                  onChange={(e) => setEditValue((editValue.split('|')[0] ?? '') + '|' + e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                >
                  <option value="">Select model...</option>
                  {AVAILABLE_MODELS.map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <EditActions
                  saving={saving === 'modelOverrides_new'}
                  onSave={() => {
                    const [method, modelVal] = editValue.split('|');
                    if (method && modelVal) {
                      const overrides = { ...(agent.modelOverrides ?? {}), [method]: modelVal };
                      saveField('modelOverrides', overrides);
                    }
                  }}
                  onCancel={cancelEdit}
                />
              </div>
            )}
            {Object.keys((agent.modelOverrides ?? {})).length === 0 && editingField !== 'modelOverrides_new' && (
              <div className="px-3 py-2 text-xs text-zinc-600">No overrides configured</div>
            )}
          </Section>

          {/* Skills — editable as comma-separated */}
          <Section title="Skills">
            {editingField === 'skills' ? (
              <div className="px-3 py-2 space-y-2">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={3}
                  placeholder="Comma-separated skills"
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500 resize-none"
                />
                <EditActions
                  saving={saving === 'skills'}
                  onSave={() => {
                    const skills = editValue.split(',').map((s) => s.trim()).filter(Boolean);
                    saveField('skills', skills);
                  }}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <div className="px-3 py-2">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex flex-wrap gap-1.5">
                    {(agent.skills?.length ?? 0) > 0 ? agent.skills.map((skill) => (
                      <span
                        key={skill}
                        className="px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded text-[11px] text-zinc-300 font-mono"
                      >
                        {skill}
                      </span>
                    )) : (
                      <span className="text-xs text-zinc-600">No skills</span>
                    )}
                  </div>
                  <button
                    onClick={() => startEdit('skills', (agent.skills ?? []).join(', '))}
                    className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer flex-shrink-0 ml-2"
                  >
                    Edit
                  </button>
                </div>
              </div>
            )}
          </Section>

          {/* Personality Traits — editable */}
          <Section title="Personality">
            {editingField === 'personalityTraits' ? (
              <div className="px-3 py-2 space-y-2">
                <textarea
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  rows={4}
                  placeholder={'key: value (one per line)\ne.g. style: Methodical'}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500 resize-none"
                />
                <EditActions
                  saving={saving === 'personalityTraits'}
                  onSave={() => {
                    const parsed: Record<string, string> = {};
                    editValue.split('\n').forEach((line) => {
                      const idx = line.indexOf(':');
                      if (idx > 0) {
                        parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                      }
                    });
                    saveField('personality_traits', parsed);
                  }}
                  onCancel={cancelEdit}
                />
              </div>
            ) : (
              <>
                {traits.length > 0 ? traits.map(([key, val]) => (
                  <Row key={key} label={key} value={val} />
                )) : (
                  <div className="px-3 py-2 text-xs text-zinc-600">No traits configured</div>
                )}
                <div className="px-3 py-1.5">
                  <button
                    onClick={() => {
                      const val = traits.map(([k, v]) => `${k}: ${v}`).join('\n');
                      startEdit('personalityTraits', val);
                    }}
                    className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer"
                  >
                    Edit
                  </button>
                </div>
              </>
            )}
          </Section>

          {/* MCP Servers */}
          <Section title="MCP Servers">
            <div className="px-3 py-2">
              <div className="flex flex-wrap gap-1.5">
                {(agent.mcpServers?.length ?? 0) > 0 ? agent.mcpServers.map((s) => (
                  <span
                    key={s.slug}
                    className="px-2 py-0.5 bg-shizuha-600/10 border border-shizuha-600/20 rounded text-[11px] text-shizuha-400 font-mono"
                  >
                    {s.name}
                  </span>
                )) : (
                  <span className="text-xs text-zinc-600">No MCP servers</span>
                )}
              </div>
              <p className="text-[10px] text-zinc-600 mt-2">
                MCP servers are managed from the admin dashboard.
              </p>
            </div>
          </Section>

          {/* Error */}
          {agent.error && (
            <Section title="Error">
              <p className="text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
                {agent.error}
              </p>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
        {action}
      </div>
      <div className="bg-zinc-800/50 rounded-lg border border-zinc-800 divide-y divide-zinc-800">
        {children}
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-xs text-zinc-400">{label}</span>
      <span className={`text-xs text-zinc-200 ${mono ? 'font-mono' : ''} truncate max-w-[200px] text-right`}>
        {value}
      </span>
    </div>
  );
}

function EditableRow({ label, value, mono, onClick }: { label: string; value: string; mono?: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 group">
      <span className="text-xs text-zinc-400">{label}</span>
      <button
        onClick={onClick}
        className="flex items-center gap-1.5 cursor-pointer text-right"
        title={`Edit ${label}`}
      >
        <span className={`text-xs text-zinc-200 ${mono ? 'font-mono' : ''} truncate max-w-[180px]`}>
          {value}
        </span>
        <svg className="w-3 h-3 text-zinc-600 group-hover:text-shizuha-400 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
        </svg>
      </button>
    </div>
  );
}

function EditActions({ saving, onSave, onCancel }: { saving: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 justify-end">
      <button
        onClick={onCancel}
        disabled={saving}
        className="px-2.5 py-1 text-[11px] text-zinc-400 hover:text-zinc-200 rounded cursor-pointer disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        onClick={onSave}
        disabled={saving}
        className="px-2.5 py-1 text-[11px] bg-shizuha-600 hover:bg-shizuha-500 text-white rounded cursor-pointer disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}
