import { useState, useMemo } from 'react';

interface DiffViewProps {
  diff: string;
  maxLines?: number;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk' | 'header';
  text: string;
}

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split('\n');
  const result: DiffLine[] = [];
  for (const line of lines) {
    if (line.startsWith('@@')) {
      result.push({ type: 'hunk', text: line });
    } else if (line.startsWith('---') || line.startsWith('+++')) {
      result.push({ type: 'header', text: line });
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', text: line });
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', text: line });
    } else {
      result.push({ type: 'context', text: line });
    }
  }
  return result;
}

const LINE_STYLES: Record<DiffLine['type'], string> = {
  add: 'bg-green-950/40 text-green-300',
  remove: 'bg-red-950/40 text-red-300',
  hunk: 'text-cyan-400 bg-cyan-950/20',
  header: 'text-zinc-500 italic',
  context: 'text-zinc-400',
};

export function DiffView({ diff, maxLines = 40 }: DiffViewProps) {
  const [expanded, setExpanded] = useState(false);

  const parsed = useMemo(() => parseDiff(diff), [diff]);

  // Extract file path from diff header
  const filePath = useMemo(() => {
    for (const line of parsed) {
      if (line.type === 'header' && line.text.startsWith('---')) {
        const p = line.text.replace(/^---\s+a\//, '').trim();
        if (p && p !== '/dev/null') return p;
      }
    }
    return null;
  }, [parsed]);

  const displayLines = expanded ? parsed : parsed.slice(0, maxLines);
  const hasMore = parsed.length > maxLines && !expanded;
  const stats = useMemo(() => {
    let adds = 0, removes = 0;
    for (const l of parsed) {
      if (l.type === 'add') adds++;
      if (l.type === 'remove') removes++;
    }
    return { adds, removes };
  }, [parsed]);

  return (
    <div className="rounded-lg border border-zinc-700/60 overflow-hidden text-xs font-mono">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-zinc-800/80 border-b border-zinc-700/60">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-zinc-500">diff</span>
          {filePath && (
            <span className="text-zinc-300 truncate">{filePath}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {stats.adds > 0 && <span className="text-green-400">+{stats.adds}</span>}
          {stats.removes > 0 && <span className="text-red-400">-{stats.removes}</span>}
        </div>
      </div>

      {/* Diff lines */}
      <div className="overflow-x-auto max-h-80 overflow-y-auto">
        {displayLines.map((line, i) => (
          <div
            key={i}
            className={`px-3 py-px whitespace-pre leading-5 ${LINE_STYLES[line.type]}`}
          >
            {line.text || '\u00A0'}
          </div>
        ))}
      </div>

      {/* Show more */}
      {hasMore && (
        <button
          onClick={() => setExpanded(true)}
          className="w-full px-3 py-1.5 text-xs text-zinc-500 hover:text-zinc-300 bg-zinc-800/40 border-t border-zinc-700/60 cursor-pointer text-center"
        >
          Show {parsed.length - maxLines} more lines
        </button>
      )}
    </div>
  );
}
