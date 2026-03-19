import type { ReactNode } from 'react';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';

interface Model {
  slug: string;
  provider: string;
}

interface ModelsResponse {
  models: Model[];
  providers: string[];
}

interface ModelPickerProps {
  isOpen: boolean;
  currentModel: string;
  onSelect: (model: string) => void;
  onClose: () => void;
  authHeaders?: () => Record<string, string>;
}

const PROVIDER_STYLES: Record<string, { color: string; bg: string; border: string; icon: string }> = {
  anthropic: {
    color: 'text-orange-400',
    bg: 'bg-orange-500/10',
    border: 'border-orange-500/20',
    icon: '◈',
  },
  openai: {
    color: 'text-green-400',
    bg: 'bg-green-500/10',
    border: 'border-green-500/20',
    icon: '◉',
  },
  google: {
    color: 'text-blue-400',
    bg: 'bg-blue-500/10',
    border: 'border-blue-500/20',
    icon: '◆',
  },
  copilot: {
    color: 'text-purple-400',
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/20',
    icon: '⬡',
  },
};

const DEFAULT_STYLE = {
  color: 'text-zinc-400',
  bg: 'bg-zinc-500/10',
  border: 'border-zinc-500/20',
  icon: '○',
};

function getProviderStyle(provider: string) {
  return PROVIDER_STYLES[provider.toLowerCase()] ?? DEFAULT_STYLE;
}

// Module-level cache so it persists across mounts
let modelsCache: ModelsResponse | null = null;

export function ModelPicker({ isOpen, currentModel, onSelect, onClose, authHeaders }: ModelPickerProps) {
  const [models, setModels] = useState<ModelsResponse | null>(modelsCache);
  const [loading, setLoading] = useState(!modelsCache);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [focusIndex, setFocusIndex] = useState(-1);

  // Fetch models on mount (uses cache)
  useEffect(() => {
    if (modelsCache) {
      setModels(modelsCache);
      setLoading(false);
      return;
    }

    let cancelled = false;

    async function fetchModels() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch('/v1/models', { headers: authHeaders?.() ?? {} });
        if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
        const data = (await res.json()) as ModelsResponse;
        if (!cancelled) {
          modelsCache = data;
          setModels(data);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load models');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchModels();
    return () => { cancelled = true; };
  }, []);

  // Group models by provider
  const grouped = useMemo(() => {
    if (!models) return new Map<string, Model[]>();
    const map = new Map<string, Model[]>();
    // Use provider order from the API response
    for (const provider of models.providers) {
      map.set(provider, []);
    }
    for (const model of models.models) {
      const list = map.get(model.provider);
      if (list) {
        list.push(model);
      } else {
        map.set(model.provider, [model]);
      }
    }
    return map;
  }, [models]);

  // Flat list of all model slugs for keyboard navigation
  const flatSlugs = useMemo(() => {
    const slugs: string[] = [];
    for (const [, items] of grouped) {
      for (const m of items) slugs.push(m.slug);
    }
    return slugs;
  }, [grouped]);

  // Reset focus index when opened
  useEffect(() => {
    if (isOpen) {
      const idx = flatSlugs.indexOf(currentModel);
      setFocusIndex(idx >= 0 ? idx : 0);
    }
  }, [isOpen, flatSlugs, currentModel]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    }

    // Defer to next tick so the opening click doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClick);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [isOpen, onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          onClose();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setFocusIndex((prev) => (prev + 1) % flatSlugs.length);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusIndex((prev) => (prev - 1 + flatSlugs.length) % flatSlugs.length);
          break;
        case 'Enter': {
          e.preventDefault();
          const slug = flatSlugs[focusIndex];
          if (slug) onSelect(slug);
          break;
        }
      }
    },
    [isOpen, flatSlugs, focusIndex, onClose, onSelect],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Scroll focused item into view
  useEffect(() => {
    if (!isOpen || focusIndex < 0) return;
    const el = panelRef.current?.querySelector(`[data-model-index="${focusIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [isOpen, focusIndex]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl w-full max-w-md max-h-[60vh] flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <h2 className="text-sm font-semibold text-zinc-200">Select Model</h2>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded transition-colors cursor-pointer"
            aria-label="Close"
          >
            <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain py-2">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <div className="flex items-center gap-2 text-zinc-500 text-sm">
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.3" />
                  <path d="M14 8a6 6 0 00-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
                Loading models...
              </div>
            </div>
          )}

          {error && (
            <div className="px-4 py-8 text-center">
              <p className="text-sm text-red-400 mb-3">{error}</p>
              <button
                onClick={() => {
                  modelsCache = null;
                  setModels(null);
                  setLoading(true);
                  setError(null);
                  fetch('/v1/models')
                    .then((res) => {
                      if (!res.ok) throw new Error(`${res.status}`);
                      return res.json() as Promise<ModelsResponse>;
                    })
                    .then((data) => {
                      modelsCache = data;
                      setModels(data);
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : 'Failed'))
                    .finally(() => setLoading(false));
                }}
                className="text-xs text-zinc-400 hover:text-zinc-200 underline underline-offset-2 cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && flatSlugs.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No models available.
            </div>
          )}

          {!loading && !error && (() => {
            let globalIndex = 0;
            const sections: ReactNode[] = [];

            for (const [provider, items] of grouped) {
              if (items.length === 0) continue;
              const style = getProviderStyle(provider);
              const sectionNodes: ReactNode[] = [];

              // Section header
              sectionNodes.push(
                <div
                  key={`header-${provider}`}
                  className="flex items-center gap-2 px-4 py-2 mt-1 first:mt-0"
                >
                  <span className={`text-xs font-medium ${style.color}`}>
                    {style.icon}
                  </span>
                  <span className={`text-[11px] font-semibold uppercase tracking-wider ${style.color}`}>
                    {provider}
                  </span>
                  <span className="text-[10px] text-zinc-600">
                    {items.length}
                  </span>
                </div>,
              );

              // Model items
              for (const model of items) {
                const idx = globalIndex++;
                const isSelected = model.slug === currentModel;
                const isFocused = idx === focusIndex;

                sectionNodes.push(
                  <button
                    key={model.slug}
                    data-model-index={idx}
                    onClick={() => onSelect(model.slug)}
                    className={[
                      'w-full flex items-center gap-3 px-4 py-2 text-left transition-colors cursor-pointer',
                      isFocused ? 'bg-zinc-800' : 'hover:bg-zinc-800/60',
                      isSelected ? 'text-zinc-100' : 'text-zinc-400',
                    ].join(' ')}
                  >
                    {/* Checkmark or spacer */}
                    <span className="w-4 flex-shrink-0 text-center">
                      {isSelected && (
                        <svg className="w-4 h-4 text-shizuha-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 8.5l3.5 3.5L13 5" />
                        </svg>
                      )}
                    </span>

                    {/* Provider dot */}
                    <span
                      className={`w-2 h-2 rounded-full flex-shrink-0 ${style.bg} ${style.border} border`}
                      style={{
                        backgroundColor: provider.toLowerCase() === 'anthropic' ? 'rgb(251 146 60 / 0.6)'
                          : provider.toLowerCase() === 'openai' ? 'rgb(74 222 128 / 0.6)'
                          : provider.toLowerCase() === 'google' ? 'rgb(96 165 250 / 0.6)'
                          : 'rgb(161 161 170 / 0.4)',
                      }}
                    />

                    {/* Model name */}
                    <span className="font-mono text-sm truncate">
                      {model.slug}
                    </span>
                  </button>,
                );
              }

              sections.push(
                <div key={provider}>
                  {sectionNodes}
                </div>,
              );
            }

            return sections;
          })()}
        </div>

        {/* Footer hint */}
        <div className="border-t border-zinc-800 px-4 py-2">
          <p className="text-[10px] text-zinc-600 text-center">
            ↑↓ navigate · Enter select · Esc close
          </p>
        </div>
      </div>
    </div>
  );
}
