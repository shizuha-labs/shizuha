import { useState, useRef, useEffect, useCallback } from 'react';
import type { ChatMessage } from '../lib/types';

interface SearchBarProps {
  isOpen: boolean;
  messages: ChatMessage[];
  onClose: () => void;
  onScrollToMessage: (messageId: string) => void;
}

export function SearchBar({ isOpen, messages, onClose, onScrollToMessage }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<ChatMessage[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setQuery('');
      setMatches([]);
      setCurrentIdx(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      setCurrentIdx(0);
      return;
    }
    const q = query.toLowerCase();
    const found = messages.filter((m) => m.content.toLowerCase().includes(q));
    setMatches(found);
    setCurrentIdx(0);
    if (found.length > 0) onScrollToMessage(found[0]!.id);
  }, [query, messages, onScrollToMessage]);

  const navigate = useCallback((dir: 1 | -1) => {
    if (matches.length === 0) return;
    const next = (currentIdx + dir + matches.length) % matches.length;
    setCurrentIdx(next);
    onScrollToMessage(matches[next]!.id);
  }, [matches, currentIdx, onScrollToMessage]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      navigate(e.shiftKey ? -1 : 1);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="absolute top-0 right-0 z-20 m-3">
      <div className="flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 shadow-xl">
        <svg className="w-4 h-4 text-zinc-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" strokeLinecap="round" />
        </svg>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search messages..."
          className="bg-transparent text-sm text-zinc-100 placeholder-zinc-500 outline-none w-48"
        />
        {matches.length > 0 && (
          <span className="text-xs text-zinc-500 whitespace-nowrap">
            {currentIdx + 1}/{matches.length}
          </span>
        )}
        {query && matches.length === 0 && (
          <span className="text-xs text-zinc-600 whitespace-nowrap">No results</span>
        )}
        <div className="flex items-center gap-0.5">
          <button onClick={() => navigate(-1)} className="p-0.5 text-zinc-500 hover:text-zinc-300 cursor-pointer" title="Previous">▲</button>
          <button onClick={() => navigate(1)} className="p-0.5 text-zinc-500 hover:text-zinc-300 cursor-pointer" title="Next">▼</button>
        </div>
        <button onClick={onClose} className="p-0.5 text-zinc-500 hover:text-zinc-300 cursor-pointer" title="Close (Esc)">✕</button>
      </div>
    </div>
  );
}
