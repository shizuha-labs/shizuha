/**
 * WorkflowsView — Visual workflow designer/viewer for the dashboard.
 * Shows workflow definitions as interactive state machine diagrams.
 * Statuses are nodes, transitions are arrows. Color-coded by category.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';

interface WorkflowStatus {
  id: string;
  label: string;
  category: 'open' | 'in_progress' | 'done' | 'cancelled';
  color?: string;
}

interface TransitionAction {
  assign_to?: string;
  add_label?: string;
  remove_label?: string;
  comment?: string;
}

interface WorkflowTransition {
  from: string;
  to: string;
  trigger: 'auto' | 'human' | 'agent' | 'any';
  label?: string;
  description?: string;
  on_transition?: TransitionAction;
}

interface WorkflowInfo {
  name: string;
  description?: string;
  version?: string;
  project?: string;
  statuses: WorkflowStatus[];
  initial_status: string;
  transition_count: number;
}

interface WorkflowDefinition extends WorkflowInfo {
  transitions: WorkflowTransition[];
  created_at?: string;
  created_by?: string;
}

interface WorkflowsViewProps {
  isOpen: boolean;
  onClose: () => void;
}

async function api(path: string) {
  const res = await fetch(path);
  return res.json();
}

// ── Category styling ──

const CATEGORY_COLORS: Record<string, { bg: string; border: string; text: string; dot: string }> = {
  open:        { bg: 'bg-zinc-800', border: 'border-zinc-600', text: 'text-zinc-200', dot: 'bg-zinc-400' },
  in_progress: { bg: 'bg-blue-950', border: 'border-blue-700', text: 'text-blue-200', dot: 'bg-blue-400' },
  done:        { bg: 'bg-emerald-950', border: 'border-emerald-700', text: 'text-emerald-200', dot: 'bg-emerald-400' },
  cancelled:   { bg: 'bg-zinc-900', border: 'border-zinc-700', text: 'text-zinc-500', dot: 'bg-zinc-600' },
};

const TRIGGER_BADGES: Record<string, { label: string; color: string }> = {
  auto:  { label: 'auto', color: 'bg-zinc-700 text-zinc-300' },
  human: { label: 'human', color: 'bg-amber-900 text-amber-300' },
  agent: { label: 'agent', color: 'bg-purple-900 text-purple-300' },
  any:   { label: 'any', color: 'bg-zinc-700 text-zinc-400' },
};

// ── Layout engine — place statuses in rows by category ──

interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  status: WorkflowStatus;
}

function layoutNodes(statuses: WorkflowStatus[], initialStatus: string): NodePosition[] {
  const NODE_W = 160;
  const NODE_H = 56;
  const GAP_X = 40;
  const GAP_Y = 70;
  const PAD_X = 40;
  const PAD_Y = 30;

  // Group by category in display order
  const categoryOrder = ['open', 'in_progress', 'done', 'cancelled'];
  const groups: Record<string, WorkflowStatus[]> = {};
  for (const cat of categoryOrder) groups[cat] = [];
  for (const s of statuses) {
    (groups[s.category] ??= []).push(s);
  }

  // Put initial status first in its group
  for (const cat of categoryOrder) {
    const items = groups[cat]!;
    const idx = items.findIndex(s => s.id === initialStatus);
    if (idx > 0) {
      const [item] = items.splice(idx, 1);
      if (item) items.unshift(item);
    }
  }

  const positions: NodePosition[] = [];
  let col = 0;

  for (const cat of categoryOrder) {
    const items = groups[cat]!;
    if (items.length === 0) continue;

    for (let row = 0; row < items.length; row++) {
      positions.push({
        x: PAD_X + col * (NODE_W + GAP_X),
        y: PAD_Y + row * (NODE_H + GAP_Y),
        width: NODE_W,
        height: NODE_H,
        status: items[row]!,
      });
    }
    col++;
  }

  return positions;
}

// ── SVG arrow path between two nodes ──

function arrowPath(
  from: NodePosition,
  to: NodePosition,
  index: number,
  total: number,
): string {
  const fromCx = from.x + from.width / 2;
  const fromCy = from.y + from.height / 2;
  const toCx = to.x + to.width / 2;
  const toCy = to.y + to.height / 2;

  // Offset for parallel arrows
  const offset = total > 1 ? (index - (total - 1) / 2) * 12 : 0;

  let sx: number, sy: number, ex: number, ey: number;

  if (toCx > fromCx + from.width / 2) {
    // Target is to the right
    sx = from.x + from.width;
    sy = fromCy + offset;
    ex = to.x;
    ey = toCy + offset;
  } else if (toCx < fromCx - from.width / 2) {
    // Target is to the left (back-transition)
    sx = from.x;
    sy = fromCy + offset;
    ex = to.x + to.width;
    ey = toCy + offset;
  } else if (toCy > fromCy) {
    // Target is below
    sx = fromCx + offset;
    sy = from.y + from.height;
    ex = toCx + offset;
    ey = to.y;
  } else {
    // Target is above
    sx = fromCx + offset;
    sy = from.y;
    ex = toCx + offset;
    ey = to.y + to.height;
  }

  // Self-transition
  if (from.status.id === to.status.id) {
    const loopR = 25;
    return `M ${sx},${from.y} C ${sx - loopR},${from.y - loopR * 2} ${sx + loopR},${from.y - loopR * 2} ${sx},${from.y}`;
  }

  // Curved path
  const dx = ex - sx;
  const dy = ey - sy;
  const cx1 = sx + dx * 0.4;
  const cy1 = sy;
  const cx2 = sx + dx * 0.6;
  const cy2 = ey;

  return `M ${sx},${sy} C ${cx1},${cy1} ${cx2},${cy2} ${ex},${ey}`;
}

// ── WorkflowDiagram component ──

function WorkflowDiagram({ workflow }: { workflow: WorkflowDefinition }) {
  const [hoveredTransition, setHoveredTransition] = useState<number | null>(null);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);

  const nodes = useMemo(() => layoutNodes(workflow.statuses, workflow.initial_status), [workflow]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, NodePosition>();
    for (const n of nodes) m.set(n.status.id, n);
    return m;
  }, [nodes]);

  // Count parallel edges between same pair
  const edgeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const indices = new Map<string, number>();
    for (const t of workflow.transitions) {
      const key = [t.from, t.to].sort().join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return { counts, indices };
  }, [workflow.transitions]);

  const svgWidth = Math.max(...nodes.map(n => n.x + n.width)) + 60;
  const svgHeight = Math.max(...nodes.map(n => n.y + n.height)) + 60;

  // Highlighted transitions (from selected node)
  const highlightedFrom = selectedNode
    ? new Set(workflow.transitions.filter(t => t.from === selectedNode).map((_, i) => i))
    : null;
  const highlightedTo = selectedNode
    ? new Set(workflow.transitions.filter(t => t.to === selectedNode).map((_, i) => i))
    : null;

  // Track edge indices for parallel edges
  const edgeIndices = new Map<string, number>();

  return (
    <div className="relative overflow-auto">
      <svg
        width={svgWidth}
        height={svgHeight}
        className="min-w-full"
        style={{ minHeight: svgHeight }}
      >
        <defs>
          <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#6b7280" />
          </marker>
          <marker id="arrowhead-blue" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#60a5fa" />
          </marker>
          <marker id="arrowhead-amber" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#fbbf24" />
          </marker>
          <marker id="arrowhead-hover" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill="#e5e7eb" />
          </marker>
        </defs>

        {/* Transition arrows */}
        {workflow.transitions.map((t, i) => {
          const from = nodeMap.get(t.from);
          const to = nodeMap.get(t.to);
          if (!from || !to) return null;

          const pairKey = [t.from, t.to].sort().join('|');
          const total = edgeCounts.counts.get(pairKey) ?? 1;
          const idx = edgeIndices.get(pairKey) ?? 0;
          edgeIndices.set(pairKey, idx + 1);

          const path = arrowPath(from, to, idx, total);
          const isHovered = hoveredTransition === i;
          const isHighlighted = highlightedFrom?.has(i) || highlightedTo?.has(i);
          const dimmed = selectedNode && !isHighlighted;

          const strokeColor = isHovered ? '#e5e7eb'
            : t.trigger === 'human' ? '#92400e'
            : t.trigger === 'agent' ? '#6d28d9'
            : t.trigger === 'auto' ? '#374151'
            : '#4b5563';

          const markerEnd = isHovered ? 'url(#arrowhead-hover)'
            : t.trigger === 'human' ? 'url(#arrowhead-amber)'
            : t.trigger === 'agent' ? 'url(#arrowhead-blue)'
            : 'url(#arrowhead)';

          return (
            <g key={i} className="cursor-pointer"
              onMouseEnter={() => setHoveredTransition(i)}
              onMouseLeave={() => setHoveredTransition(null)}
            >
              {/* Wider invisible hit area */}
              <path d={path} fill="none" stroke="transparent" strokeWidth={16} />
              <path
                d={path}
                fill="none"
                stroke={strokeColor}
                strokeWidth={isHovered ? 2.5 : 1.5}
                strokeDasharray={t.trigger === 'auto' ? '6,3' : undefined}
                markerEnd={markerEnd}
                opacity={dimmed ? 0.15 : isHovered ? 1 : 0.6}
                className="transition-all duration-150"
              />
              {/* Transition label on hover */}
              {isHovered && (
                <foreignObject
                  x={(from.x + from.width / 2 + to.x + to.width / 2) / 2 - 70}
                  y={(from.y + from.height / 2 + to.y + to.height / 2) / 2 - 16}
                  width={140}
                  height={32}
                >
                  <div className="flex items-center justify-center">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${TRIGGER_BADGES[t.trigger]?.color ?? 'bg-zinc-700 text-zinc-300'}`}>
                      {t.label || `${t.trigger}`}
                      {t.on_transition?.assign_to ? ` \u2192 ${t.on_transition.assign_to}` : ''}
                    </span>
                  </div>
                </foreignObject>
              )}
            </g>
          );
        })}

        {/* Status nodes */}
        {nodes.map((node) => {
          const cat = CATEGORY_COLORS[node.status.category] ?? CATEGORY_COLORS.open!;
          const isInitial = node.status.id === workflow.initial_status;
          const isSelected = selectedNode === node.status.id;
          const dimmed = selectedNode && !isSelected
            && !workflow.transitions.some(t => (t.from === selectedNode && t.to === node.status.id) || (t.to === selectedNode && t.from === node.status.id));

          return (
            <foreignObject
              key={node.status.id}
              x={node.x}
              y={node.y}
              width={node.width}
              height={node.height}
              className="cursor-pointer"
              onClick={() => setSelectedNode(isSelected ? null : node.status.id)}
            >
              <div className={`h-full rounded-lg border-2 flex flex-col items-center justify-center gap-0.5 transition-all duration-150 ${cat.bg} ${isSelected ? 'border-white shadow-lg shadow-white/10' : isInitial ? 'border-shizuha-500' : cat.border} ${dimmed ? 'opacity-20' : ''}`}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-2 h-2 rounded-full ${node.status.color ? '' : cat.dot}`}
                    style={node.status.color ? { backgroundColor: node.status.color } : undefined}
                  />
                  <span className={`text-sm font-medium ${cat.text}`}>{node.status.label}</span>
                </div>
                <span className="text-[10px] text-zinc-500">{node.status.category.replace('_', ' ')}</span>
                {isInitial && <span className="text-[9px] text-shizuha-400 font-medium">INITIAL</span>}
              </div>
            </foreignObject>
          );
        })}
      </svg>

      {/* Selected node info panel */}
      {selectedNode && (() => {
        const status = workflow.statuses.find(s => s.id === selectedNode);
        const outgoing = workflow.transitions.filter(t => t.from === selectedNode);
        const incoming = workflow.transitions.filter(t => t.to === selectedNode);
        if (!status) return null;

        return (
          <div className="absolute top-3 right-3 w-72 bg-zinc-800 border border-zinc-700 rounded-lg p-4 shadow-xl">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: status.color || '#6b7280' }} />
                <h4 className="text-sm font-semibold text-zinc-100">{status.label}</h4>
              </div>
              <button onClick={() => setSelectedNode(null)} className="text-zinc-500 hover:text-zinc-300 text-xs">ESC</button>
            </div>
            <div className="text-xs text-zinc-500 mb-3">Category: {status.category.replace('_', ' ')}</div>

            {outgoing.length > 0 && (
              <div className="mb-3">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Transitions out ({outgoing.length})</div>
                {outgoing.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 py-1 text-xs">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${TRIGGER_BADGES[t.trigger]?.color}`}>{t.trigger}</span>
                    <span className="text-zinc-300">{'\u2192'} {workflow.statuses.find(s => s.id === t.to)?.label ?? t.to}</span>
                    {t.on_transition?.assign_to && <span className="text-zinc-600 ml-auto">@{t.on_transition.assign_to}</span>}
                  </div>
                ))}
              </div>
            )}

            {incoming.length > 0 && (
              <div>
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Transitions in ({incoming.length})</div>
                {incoming.map((t, i) => (
                  <div key={i} className="flex items-center gap-2 py-1 text-xs">
                    <span className="text-zinc-400">{workflow.statuses.find(s => s.id === t.from)?.label ?? t.from} {'\u2192'}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] ${TRIGGER_BADGES[t.trigger]?.color}`}>{t.trigger}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}

// ── Main WorkflowsView ──

export function WorkflowsView({ isOpen, onClose }: WorkflowsViewProps) {
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [selected, setSelected] = useState<WorkflowDefinition | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api('/v1/local-pulse/workflows');
      setWorkflows(data.workflows ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) fetchWorkflows();
  }, [isOpen, fetchWorkflows]);

  const selectWorkflow = async (name: string) => {
    const data = await api(`/v1/local-pulse/workflows/${encodeURIComponent(name)}`);
    if (data.workflow) setSelected(data.workflow);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-6xl bg-zinc-900 shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-zinc-100">Workflows</h2>
            <span className="text-xs text-zinc-500">{workflows.length} defined</span>
          </div>
          <div className="flex items-center gap-2">
            {selected && (
              <button
                onClick={() => setSelected(null)}
                className="text-xs text-zinc-400 hover:text-zinc-200 px-2 py-1 bg-zinc-800 rounded"
              >
                {'\u2190'} Back to list
              </button>
            )}
            <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 p-1">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto">
          {loading && <div className="flex items-center justify-center h-full text-zinc-500">Loading...</div>}

          {!loading && !selected && (
            <div className="p-6">
              {workflows.length === 0 ? (
                <div className="text-center text-zinc-500 py-20">
                  <svg className="w-12 h-12 mx-auto mb-4 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                  </svg>
                  <p className="text-sm">No workflows defined yet.</p>
                  <p className="text-xs text-zinc-600 mt-1">Agents can create workflows via pulse_create_workflow tool,<br/>or they sync automatically from the platform.</p>
                </div>
              ) : (
                <div className="grid gap-3">
                  {workflows.map((wf) => (
                    <button
                      key={wf.name}
                      onClick={() => selectWorkflow(wf.name)}
                      className="text-left p-4 bg-zinc-800/50 border border-zinc-800 rounded-lg hover:border-zinc-600 hover:bg-zinc-800 transition-all group"
                    >
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <h3 className="text-sm font-semibold text-zinc-200 group-hover:text-white">{wf.name}</h3>
                          {wf.project && <span className="text-[10px] px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded font-mono">{wf.project}</span>}
                          {wf.version && <span className="text-[10px] text-zinc-600">v{wf.version}</span>}
                        </div>
                        <div className="text-[10px] text-zinc-600">
                          {wf.statuses.length} statuses &middot; {wf.transition_count} transitions
                        </div>
                      </div>
                      {wf.description && <p className="text-xs text-zinc-500 mb-2">{wf.description}</p>}

                      {/* Mini status pipeline */}
                      <div className="flex items-center gap-1">
                        {wf.statuses.map((s, i) => {
                          const cat = CATEGORY_COLORS[s.category] ?? CATEGORY_COLORS.open!;
                          return (
                            <div key={s.id} className="flex items-center gap-1">
                              {i > 0 && <svg className="w-3 h-3 text-zinc-700" viewBox="0 0 12 12"><path d="M3 2l5 4-5 4" fill="none" stroke="currentColor" strokeWidth={1.5} /></svg>}
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${cat.bg} ${cat.text} border ${cat.border}`}
                                style={s.color ? { borderColor: s.color + '40', color: s.color } : undefined}
                              >
                                {s.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Workflow detail view with diagram */}
          {!loading && selected && (
            <div className="flex flex-col h-full">
              {/* Workflow metadata */}
              <div className="px-6 py-3 border-b border-zinc-800 flex items-center gap-4">
                <h3 className="text-base font-semibold text-zinc-100">{selected.name}</h3>
                {selected.project && <span className="text-xs px-2 py-0.5 bg-zinc-800 text-zinc-400 rounded font-mono">{selected.project}</span>}
                {selected.version && <span className="text-xs text-zinc-600">v{selected.version}</span>}
                <span className="text-xs text-zinc-600">&middot; {selected.statuses.length} statuses &middot; {selected.transitions.length} transitions</span>
                {selected.description && <span className="text-xs text-zinc-500 ml-auto">{selected.description}</span>}
              </div>

              {/* Legend */}
              <div className="px-6 py-2 border-b border-zinc-800/50 flex items-center gap-4 text-[10px] text-zinc-500">
                <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-amber-800 inline-block" /> human</span>
                <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-purple-700 inline-block" /> agent</span>
                <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-zinc-600 border-dashed inline-block" /> auto</span>
                <span className="flex items-center gap-1"><span className="w-4 border-t-2 border-zinc-600 inline-block" /> any</span>
                <span className="ml-4 flex items-center gap-1"><span className="w-2 h-2 rounded border-2 border-shizuha-500 inline-block" /> initial</span>
                <span className="text-zinc-600 ml-auto">Click a status to see its transitions</span>
              </div>

              {/* Diagram */}
              <div className="flex-1 overflow-auto p-4 bg-zinc-950/50">
                <WorkflowDiagram workflow={selected} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
