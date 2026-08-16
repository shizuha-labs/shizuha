import { useState, useEffect, useRef } from 'react';
import { renderMarkdown } from '../lib/markdown';

interface ActivityEvent {
  type: 'message' | 'tool_call' | 'tool_result';
  ts?: string;
  role?: 'user' | 'assistant';
  text?: string;
  tool?: string;
  input?: string;
  output?: string;
}

interface ActivityLogProps {
  agentId: string;
  agentName: string;
}

function formatTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export default function ActivityLog({ agentId, agentName }: ActivityLogProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScroll = useRef(true);

  useEffect(() => {
    let mounted = true;
    const fetchActivity = async () => {
      try {
        const res = await fetch(`/v1/agents/${agentId}/activity?limit=200`);
        if (res.ok && mounted) {
          const data = await res.json();
          setEvents(data.events ?? []);
          setTotal(data.total ?? 0);
          setLoading(false);
        }
      } catch { /* ignore */ }
    };
    fetchActivity();
    const interval = setInterval(fetchActivity, 10_000);
    return () => { mounted = false; clearInterval(interval); };
  }, [agentId]);

  useEffect(() => {
    if (isAutoScroll.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    isAutoScroll.current = scrollHeight - scrollTop - clientHeight < 50;
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-zinc-500 text-sm">Loading activity...</div>;
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4">
        <p className="text-zinc-500 text-sm">No activity yet</p>
        <p className="text-zinc-600 text-xs mt-1">{agentName}'s full transcript will appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-xs text-zinc-500">{events.length} events (of {total} total)</span>
        <span className="text-xs text-zinc-600">Auto-refreshes every 10s</span>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {events.map((evt, i) => <EventRow key={i} event={evt} />)}
      </div>
    </div>
  );
}

function EventRow({ event }: { event: ActivityEvent }) {
  const [expanded, setExpanded] = useState(false);

  if (event.type === 'message' && event.role === 'user') {
    return (
      <div className="py-2 px-3 rounded-lg bg-cyan-950/20 border border-cyan-900/30">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-cyan-600 font-mono">{formatTime(event.ts)}</span>
          <span className="text-[10px] font-medium text-cyan-400">MESSAGE RECEIVED</span>
        </div>
        <div className="text-sm text-cyan-100 prose prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(event.text ?? '') }} />
      </div>
    );
  }

  if (event.type === 'message' && event.role === 'assistant') {
    return (
      <div className="py-2 px-3 rounded-lg bg-zinc-800/50">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-zinc-500 font-mono">{formatTime(event.ts)}</span>
          <span className="text-[10px] font-medium text-zinc-400">RESPONSE</span>
        </div>
        <div className="text-sm text-zinc-200 prose prose-invert prose-sm max-w-none" dangerouslySetInnerHTML={{ __html: renderMarkdown(event.text ?? '') }} />
      </div>
    );
  }

  if (event.type === 'tool_call') {
    return (
      <div className="py-1.5 px-3 rounded-lg hover:bg-zinc-800/30 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 font-mono">{formatTime(event.ts)}</span>
          <span className="text-[10px] text-blue-500">TOOL</span>
          <span className="text-xs text-blue-300 font-mono">{event.tool}</span>
          <span className="text-[9px] text-zinc-600">{expanded ? '▼' : '▶'}</span>
        </div>
        {expanded && event.input && (
          <pre className="mt-1 text-[11px] text-zinc-500 bg-zinc-900 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
            {tryFormatJson(event.input)}
          </pre>
        )}
      </div>
    );
  }

  if (event.type === 'tool_result') {
    return (
      <div className="py-1 px-3 rounded-lg hover:bg-zinc-800/30 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-zinc-600 font-mono">{formatTime(event.ts)}</span>
          <span className="text-[10px] text-emerald-600">RESULT</span>
          <span className="text-xs text-emerald-400/60 font-mono">{event.tool}</span>
          <span className="text-[9px] text-zinc-600">{expanded ? '▼' : '▶'}</span>
        </div>
        {expanded && event.output && (
          <pre className="mt-1 text-[11px] text-zinc-500 bg-zinc-900 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto">
            {event.output.slice(0, 500)}
          </pre>
        )}
      </div>
    );
  }

  return null;
}

function tryFormatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
