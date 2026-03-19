import { useState } from 'react';
import { getAgentMethod } from '../lib/types';
import type { Agent } from '../lib/types';

interface AgentSidebarProps {
  isOpen: boolean;
  selectedAgentId: string | null;
  agents: Agent[];
  onSelectAgent: (agent: Agent) => void;
  onClose: () => void;
}

const ROLE_COLORS: Record<string, string> = {
  'Engineer': 'text-blue-400',
  'Architect': 'text-purple-400',
  'QA Engineer': 'text-yellow-400',
  'Security Engineer': 'text-red-400',
  'Technical Writer': 'text-emerald-400',
  'Data Analyst': 'text-cyan-400',
  'General Assistant': 'text-shizuha-400',
};

const STATUS_COLORS: Record<string, { dot: string; bg: string }> = {
  running: { dot: 'bg-green-400', bg: 'bg-green-400/20' },
  starting: { dot: 'bg-yellow-400 animate-pulse', bg: 'bg-yellow-400/20' },
  error: { dot: 'bg-red-400', bg: 'bg-red-400/20' },
  stopped: { dot: 'bg-zinc-500', bg: 'bg-zinc-500/20' },
  unknown: { dot: 'bg-zinc-600', bg: 'bg-zinc-600/20' },
};

function getInitials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    'bg-blue-600', 'bg-purple-600', 'bg-emerald-600', 'bg-rose-600',
    'bg-amber-600', 'bg-cyan-600', 'bg-indigo-600', 'bg-teal-600',
    'bg-pink-600', 'bg-violet-600', 'bg-orange-600', 'bg-lime-600',
  ];
  return colors[Math.abs(hash) % colors.length]!;
}

export function AgentSidebar({
  isOpen,
  selectedAgentId,
  agents,
  onSelectAgent,
  onClose,
}: AgentSidebarProps) {
  const [search, setSearch] = useState('');

  const filtered = search
    ? agents.filter((a) =>
        a.name.toLowerCase().includes(search.toLowerCase()) ||
        a.username.toLowerCase().includes(search.toLowerCase()) ||
        (a.role ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : agents;

  if (!isOpen) return null;

  return (
    <div className="w-[85vw] max-w-[300px] flex-shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Agents</h2>
          <p className="text-[10px] text-zinc-500 mt-0.5">
            {agents.filter((a) => a.status === 'running').length}/{agents.length} online
          </p>
        </div>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors cursor-pointer sm:hidden"
          title="Close sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Search */}
      {agents.length > 5 && (
        <div className="px-3 py-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search agents..."
            className="w-full px-3 py-1.5 bg-zinc-800 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600"
          />
        </div>
      )}

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {agents.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-sm text-zinc-500">
              {search ? 'No agents match your search' : 'No agents available'}
            </p>
          </div>
        )}

        {filtered.map((agent) => {
          const isSelected = agent.id === selectedAgentId;
          const statusStyle = STATUS_COLORS[agent.status] ?? STATUS_COLORS['unknown']!;
          const roleColor = ROLE_COLORS[agent.role ?? ''] ?? 'text-zinc-500';

          return (
            <button
              key={agent.id}
              onClick={() => onSelectAgent(agent)}
              className={[
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer mt-0.5',
                isSelected
                  ? 'bg-zinc-800 border-l-2 border-l-shizuha-500'
                  : 'hover:bg-zinc-800/60',
              ].join(' ')}
            >
              {/* Avatar with status dot */}
              <div className="relative flex-shrink-0">
                <div className={`w-10 h-10 rounded-full ${hashColor(agent.name)} flex items-center justify-center`}>
                  <span className="text-sm font-semibold text-white">{getInitials(agent.name)}</span>
                </div>
                {/* Status dot */}
                <div className={`absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 rounded-full ${statusStyle.dot} border-2 border-zinc-900`} />
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0 text-left">
                <div className="flex items-center gap-1.5">
                  <span className={`text-sm font-medium truncate ${isSelected ? 'text-zinc-100' : 'text-zinc-300'}`}>
                    {agent.name}
                  </span>
                  <span className="text-[10px] text-zinc-600 font-mono">@{agent.username}</span>
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className={`text-[11px] ${roleColor}`}>{agent.role ?? 'Agent'}</span>
                  <span className="text-zinc-700">·</span>
                  <span className="text-[10px] text-zinc-600 font-mono truncate">{getAgentMethod(agent)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
