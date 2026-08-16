import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import type React from 'react';

interface Command {
  id: string;
  label: string;
  shortcut: string;
  category: string;
  action: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onAction: (actionId: string) => void;
}

const COMMANDS: Command[] = [
  // Chat
  { id: 'new-chat', label: 'New Conversation', shortcut: '', category: 'Chat', action: 'newChat' },
  { id: 'clear', label: 'Clear Messages', shortcut: '', category: 'Chat', action: 'clearMessages' },
  { id: 'clear-all', label: 'Clear All Chats', shortcut: '', category: 'Chat', action: 'clearAllMessages' },
  { id: 'export-md', label: 'Export as Markdown', shortcut: '', category: 'Chat', action: 'exportMarkdown' },
  { id: 'export-json', label: 'Export as JSON', shortcut: '', category: 'Chat', action: 'exportJSON' },

  // Model
  { id: 'model', label: 'Switch Model', shortcut: '', category: 'Model', action: 'openModelPicker' },

  // Mode
  { id: 'mode-plan', label: 'Plan Mode', shortcut: '', category: 'Mode', action: 'setModePlan' },
  { id: 'mode-supervised', label: 'Supervised Mode', shortcut: '', category: 'Mode', action: 'setModeSupervised' },
  { id: 'mode-auto', label: 'Autonomous Mode', shortcut: '', category: 'Mode', action: 'setModeAutonomous' },

  // View
  { id: 'toggle-sidebar', label: 'Toggle Sidebar', shortcut: 'Ctrl+B', category: 'View', action: 'toggleSidebar' },
  { id: 'toggle-theme', label: 'Toggle Theme', shortcut: '', category: 'View', action: 'toggleTheme' },
  { id: 'search', label: 'Search Messages', shortcut: 'Ctrl+F', category: 'View', action: 'openSearch' },
  { id: 'notifications', label: 'Enable Desktop Notifications', shortcut: '', category: 'View', action: 'enableNotifications' },

  // Settings
  { id: 'settings', label: 'Open Settings', shortcut: '', category: 'Settings', action: 'openSettings' },

  // Account
  { id: 'logout', label: 'Log Out', shortcut: '', category: 'Account', action: 'logout' },
];

function fuzzyMatch(text: string, query: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  return lowerText.includes(lowerQuery);
}

function groupByCategory(commands: Command[]): Map<string, Command[]> {
  const groups = new Map<string, Command[]>();
  for (const cmd of commands) {
    const existing = groups.get(cmd.category);
    if (existing) {
      existing.push(cmd);
    } else {
      groups.set(cmd.category, [cmd]);
    }
  }
  return groups;
}

export function CommandPalette({ isOpen, onClose, onAction }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  const filtered = useMemo(() => {
    if (!query.trim()) return COMMANDS;
    return COMMANDS.filter(
      (cmd) => fuzzyMatch(cmd.label, query) || fuzzyMatch(cmd.category, query),
    );
  }, [query]);

  const grouped = useMemo(() => groupByCategory(filtered), [filtered]);

  // Build a flat index for keyboard navigation
  const flatList = useMemo(() => {
    const items: Command[] = [];
    for (const cmds of grouped.values()) {
      items.push(...cmds);
    }
    return items;
  }, [grouped]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      // Focus input on next frame to ensure the element is rendered
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [isOpen]);

  // Clamp selected index when filtered results change
  useEffect(() => {
    setSelectedIndex((prev) => Math.min(prev, Math.max(0, flatList.length - 1)));
  }, [flatList.length]);

  // Scroll the selected item into view
  useEffect(() => {
    const el = itemRefs.current.get(selectedIndex);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  // Global keyboard shortcut to open
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) {
          onClose();
        }
      }
    }
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [isOpen, onClose]);

  const executeCommand = useCallback(
    (cmd: Command) => {
      onAction(cmd.action);
      onClose();
    },
    [onAction, onClose],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % Math.max(1, flatList.length));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + flatList.length) % Math.max(1, flatList.length));
          break;
        case 'Enter':
          e.preventDefault();
          if (flatList[selectedIndex]) {
            executeCommand(flatList[selectedIndex]);
          }
          break;
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    },
    [flatList, selectedIndex, executeCommand, onClose],
  );

  const setItemRef = useCallback((index: number, el: HTMLDivElement | null) => {
    if (el) {
      itemRefs.current.set(index, el);
    } else {
      itemRefs.current.delete(index);
    }
  }, []);

  if (!isOpen) return null;

  let flatIndex = 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]"
      onClick={onClose}
      role="presentation"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      {/* Modal */}
      <div
        className="relative w-full max-w-[520px] overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 border-b border-zinc-700/80 px-4 py-3">
          <span className="flex-shrink-0 text-zinc-400" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            className="flex-1 bg-transparent text-base text-zinc-100 placeholder-zinc-500 outline-none"
            autoComplete="off"
            spellCheck={false}
            aria-label="Search commands"
            aria-activedescendant={
              flatList[selectedIndex] ? `cmd-${flatList[selectedIndex].id}` : undefined
            }
            role="combobox"
            aria-expanded={true}
            aria-controls="command-list"
            aria-haspopup="listbox"
          />
          <kbd className="hidden flex-shrink-0 rounded border border-zinc-600 bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400 sm:inline-block">
            ESC
          </kbd>
        </div>

        {/* Command list */}
        <div
          ref={listRef}
          id="command-list"
          role="listbox"
          className="max-h-[340px] overflow-y-auto overscroll-contain px-2 py-2"
        >
          {flatList.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-zinc-500">No matching commands</div>
          ) : (
            Array.from(grouped.entries()).map(([category, commands]) => (
              <div key={category} className="mb-1">
                <div className="px-3 pb-1 pt-2 text-xs font-medium uppercase tracking-wider text-zinc-500">
                  {category}
                </div>
                {commands.map((cmd) => {
                  const currentIndex = flatIndex++;
                  const isSelected = currentIndex === selectedIndex;
                  return (
                    <div
                      key={cmd.id}
                      id={`cmd-${cmd.id}`}
                      ref={(el) => setItemRef(currentIndex, el)}
                      role="option"
                      aria-selected={isSelected}
                      className={`flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 transition-colors ${
                        isSelected ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'
                      }`}
                      onClick={() => executeCommand(cmd)}
                      onMouseEnter={() => setSelectedIndex(currentIndex)}
                    >
                      <span className="text-sm">{cmd.label}</span>
                      {cmd.shortcut && (
                        <kbd className="ml-4 flex-shrink-0 rounded border border-zinc-600/60 bg-zinc-800/80 px-1.5 py-0.5 text-xs text-zinc-500">
                          {cmd.shortcut}
                        </kbd>
                      )}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
