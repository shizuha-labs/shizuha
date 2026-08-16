import { useState, useMemo } from 'react';
import { DiffView } from './DiffView';
import type { ToolCall } from '../lib/types';

interface ToolCardProps {
  toolCall: ToolCall;
}

const TOOL_ICONS: Record<string, string> = {
  read: '📄',
  write: '✏️',
  edit: '✏️',
  bash: '⚡',
  grep: '🔍',
  glob: '📁',
  web_search: '🌐',
  web_fetch: '🌐',
  ask_user: '💬',
  notebook: '📓',
  todo: '📋',
  task: '📋',
  plan_mode: '📐',
};

function getToolIcon(name: string): string {
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith('mcp__')) return '🔌';
  return '⚙️';
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Try to extract a diff from tool output or metadata */
function extractDiff(toolCall: ToolCall): string | null {
  // Explicit diff field
  if (toolCall.diff) return toolCall.diff;
  // Check output for unified diff patterns
  if (toolCall.output && /^---\s+a\//m.test(toolCall.output)) {
    const lines = toolCall.output.split('\n');
    const diffStart = lines.findIndex((l) => l.startsWith('--- a/'));
    if (diffStart >= 0) return lines.slice(diffStart).join('\n');
  }
  return null;
}

const DIFF_TOOLS = new Set(['edit', 'write']);

export function ToolCard({ toolCall }: ToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const icon = getToolIcon(toolCall.tool);
  const duration = formatDuration(toolCall.durationMs);
  const isDiffTool = DIFF_TOOLS.has(toolCall.tool);
  const diff = useMemo(() => isDiffTool ? extractDiff(toolCall) : null, [toolCall, isDiffTool]);

  // Auto-expand edit/write tools that have diffs
  const [showDiff, setShowDiff] = useState(true);

  // Extract file path from input
  const filePath = toolCall.input?.file_path as string | undefined;

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs px-2 py-1 rounded-md bg-zinc-800/60 hover:bg-zinc-700/60 transition-colors w-full text-left cursor-pointer"
      >
        <span>{icon}</span>
        <span className="text-zinc-300 font-mono truncate">
          {toolCall.tool}
          {filePath && <span className="text-zinc-500 ml-1">{filePath.split('/').pop()}</span>}
        </span>
        {toolCall.isError && <span className="text-red-400">✗</span>}
        {!toolCall.isError && toolCall.durationMs && <span className="text-green-400">✓</span>}
        {duration && <span className="text-zinc-500 ml-auto">{duration}</span>}
        <span className="text-zinc-600">{expanded ? '▾' : '▸'}</span>
      </button>

      {/* Inline diff for edit/write tools */}
      {diff && showDiff && !expanded && (
        <div className="mt-1 ml-6">
          <DiffView diff={diff} maxLines={20} />
        </div>
      )}

      {expanded && (
        <div className="mt-1 ml-6 space-y-1">
          {/* Diff toggle for edit/write */}
          {diff && (
            <div>
              <button
                onClick={() => setShowDiff(!showDiff)}
                className="text-xs text-zinc-500 hover:text-zinc-300 cursor-pointer mb-1"
              >
                {showDiff ? 'Hide diff' : 'Show diff'}
              </button>
              {showDiff && <DiffView diff={diff} />}
            </div>
          )}

          {/* Input */}
          {toolCall.input && (
            <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
              <div className="text-[10px] text-zinc-600 mb-1 uppercase tracking-wider">Input</div>
              <pre className="text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap break-words">
                {JSON.stringify(toolCall.input, null, 2)}
              </pre>
            </div>
          )}

          {/* Output (skip raw diff if we already show DiffView) */}
          {toolCall.output && (
            <div className="p-2 rounded bg-zinc-900 border border-zinc-800">
              <div className="text-[10px] text-zinc-600 mb-1 uppercase tracking-wider">Output</div>
              <pre className="text-xs text-zinc-400 overflow-x-auto whitespace-pre-wrap break-words max-h-60 overflow-y-auto">
                {toolCall.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ActiveToolsProps {
  tools: string[];
}

export function ActiveTools({ tools }: ActiveToolsProps) {
  if (tools.length === 0) return null;

  return (
    <div className="space-y-1">
      {tools.map((tool, i) => (
        <div key={`${tool}-${i}`} className="flex items-center gap-2 text-xs px-2 py-1 rounded-md bg-zinc-800/40">
          <span className="animate-spin text-shizuha-400">⟳</span>
          <span className="text-zinc-400 font-mono">{tool}</span>
        </div>
      ))}
    </div>
  );
}
