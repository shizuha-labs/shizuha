import { useState, useEffect, useCallback, useRef } from 'react';
import type { Session } from '../lib/types';

interface SessionSidebarProps {
  isOpen: boolean;
  currentSessionId: string | null;
  onResume: (sessionId: string) => void;
  onNewChat: () => void;
  onClose: () => void;
  authHeaders?: () => Record<string, string>;
}

export function SessionSidebar({
  isOpen,
  currentSessionId,
  onResume,
  onNewChat,
  onClose,
  authHeaders,
}: SessionSidebarProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch('/v1/sessions?limit=50', { headers: authHeaders?.() ?? {} });
      if (!res.ok) throw new Error(`Failed to load sessions (${res.status})`);
      const data = (await res.json()) as { sessions?: Session[] };
      const list: Session[] = Array.isArray(data.sessions) ? data.sessions : [];
      // Sort by most recent first (updatedAt descending)
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      setSessions(list);
    } catch (e) {
      setError((e as Error).message || 'Failed to load sessions');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Fetch sessions when sidebar opens
  useEffect(() => {
    if (isOpen) {
      fetchSessions();
      fetchedRef.current = true;
    } else {
      fetchedRef.current = false;
    }
  }, [isOpen, fetchSessions]);

  const handleDelete = useCallback(async (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    if (deletingId) return;

    setDeletingId(sessionId);
    try {
      const res = await fetch(`/v1/sessions/${sessionId}`, { method: 'DELETE', headers: authHeaders?.() ?? {} });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (e) {
      setError((e as Error).message || 'Failed to delete session');
    } finally {
      setDeletingId(null);
    }
  }, [deletingId]);

  const handleNewChat = useCallback(() => {
    onNewChat();
  }, [onNewChat]);

  if (!isOpen) return null;

  return (
    <div className="w-[280px] flex-shrink-0 bg-zinc-900 border-r border-zinc-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-3 border-b border-zinc-800">
        <h2 className="text-sm font-semibold text-zinc-300">Sessions</h2>
        <button
          onClick={onClose}
          className="w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors cursor-pointer"
          title="Close sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* New Chat button */}
      <div className="px-3 py-2">
        <button
          onClick={handleNewChat}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-zinc-300 bg-zinc-800 hover:bg-zinc-700 rounded-lg transition-colors cursor-pointer"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M7 2.5V11.5M2.5 7H11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          New Chat
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && sessions.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <div className="flex items-center gap-2 text-zinc-500 text-sm">
              <div className="w-3.5 h-3.5 border-2 border-zinc-600 border-t-zinc-400 rounded-full animate-spin" />
              Loading...
            </div>
          </div>
        )}

        {error && (
          <div className="mx-1 mt-1 px-3 py-2 rounded-lg bg-red-950/30 border border-red-900/30">
            <p className="text-xs text-red-400">{error}</p>
            <button
              onClick={fetchSessions}
              className="text-xs text-red-400 underline hover:text-red-300 mt-1 cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}

        {!isLoading && !error && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <p className="text-sm text-zinc-500">No sessions yet</p>
            <p className="text-xs text-zinc-600 mt-1">Start a conversation to see it here</p>
          </div>
        )}

        {sessions.map((session) => {
          const isActive = session.id === currentSessionId;
          const isDeleting = session.id === deletingId;
          const totalTokens = session.totalInputTokens + session.totalOutputTokens;

          return (
            <div
              key={session.id}
              role="button"
              tabIndex={0}
              onClick={() => onResume(session.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onResume(session.id); }}
              className={`group relative mt-1 rounded-lg cursor-pointer transition-colors ${
                isActive
                  ? 'bg-zinc-800 border-l-2 border-l-shizuha-600 pl-2.5 pr-3'
                  : 'hover:bg-zinc-800/60 pl-3 pr-3'
              } ${isDeleting ? 'opacity-50 pointer-events-none' : ''}`}
            >
              <div className="py-2.5">
                {/* Session name / preview */}
                <div className="flex items-start justify-between gap-1">
                  <p className={`text-sm leading-snug truncate ${
                    isActive ? 'text-zinc-100 font-medium' : 'text-zinc-300'
                  }`}>
                    {getSessionLabel(session)}
                  </p>

                  {/* Delete button (visible on hover) */}
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-zinc-600 opacity-0 group-hover:opacity-100 hover:text-red-400 hover:bg-zinc-700 transition-all cursor-pointer"
                    title="Delete session"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M7.5 2.5L2.5 7.5M2.5 2.5L7.5 7.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>

                {/* Metadata row */}
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[10px] text-zinc-600 font-mono truncate max-w-[100px]">
                    {formatModelShort(session.model)}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {formatRelativeTime(session.updatedAt)}
                  </span>
                  {totalTokens > 0 && (
                    <span className="text-[10px] text-zinc-700">
                      {formatTokens(totalTokens)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Get a display label for the session: name, first message preview, or fallback */
function getSessionLabel(session: Session): string {
  if (session.name) return session.name;
  if (session.firstMessage) {
    const preview = session.firstMessage.trim();
    return preview.length > 60 ? preview.slice(0, 57) + '...' : preview;
  }
  return `Session ${session.id.slice(0, 8)}`;
}

/** Format an epoch timestamp as a relative time string */
function formatRelativeTime(epochMs: number): string {
  const now = Date.now();
  const diff = now - epochMs;

  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks}w ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

/** Shorten model name for display */
function formatModelShort(model: string): string {
  // e.g. "claude-sonnet-4-20250514" -> "sonnet-4"
  // e.g. "codex-mini-latest" -> "codex-mini"
  const parts = model.split('-');
  if (parts.length >= 3 && parts[0] === 'claude') {
    // claude-{variant}-{version}[-date]
    const variant = parts[1];
    const version = parts[2];
    return `${variant}-${version}`;
  }
  // Strip trailing date patterns (YYYYMMDD)
  const stripped = model.replace(/-\d{8}$/, '');
  // Strip "latest" suffix
  return stripped.replace(/-latest$/, '');
}

/** Format token count compactly */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
}
