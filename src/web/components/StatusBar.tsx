import { useState } from 'react';

interface StatusBarProps {
  model: string;
  method?: string;
  effort?: string;
  thinking?: string;
  mode: string;
  sessionId: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  isStreaming: boolean;
  error: string | null;
  wsConnected?: boolean;
  onModelChange?: (model: string) => void;
  onMethodChange?: (method: string) => void;
  onModeChange?: (mode: 'plan' | 'supervised' | 'autonomous') => void;
  onEffortChange?: (effort: string) => void;
  onThinkingChange?: (thinking: string) => void;
}

const MODE_COLORS: Record<string, string> = {
  plan: 'text-cyan-400',
  supervised: 'text-yellow-400',
  autonomous: 'text-green-400',
};

const MODES: Array<'plan' | 'supervised' | 'autonomous'> = ['plan', 'supervised', 'autonomous'];

// Method-specific valid options
const CLAUDE_METHODS = new Set(['claude_code_server', 'cli', 'sdk', 'sdk_direct']);
const CODEX_METHODS = new Set(['codex', 'codex_app_server', 'codex_sdk']);

// Execution methods available in the status bar picker
const EXEC_METHODS = ['shizuha', 'claude_code_server', 'codex_app_server', 'codex', 'cli', 'sdk'];

function getEffortValues(method?: string, model?: string): string[] {
  if (!method && !model) return [];
  // Claude Code has its own --effort flag (low/medium/high/max)
  if (method && CLAUDE_METHODS.has(method)) return ['low', 'medium', 'high', 'max'];
  if (method && CODEX_METHODS.has(method)) return ['low', 'medium', 'high', 'xhigh'];
  // shizuha/direct — model-dependent
  if (model?.startsWith('claude-')) return ['low', 'medium', 'high', 'max'];
  if (model?.startsWith('gpt-5') || model?.startsWith('codex-')) return ['low', 'medium', 'high', 'xhigh'];
  if (model?.startsWith('o3') || model?.startsWith('o4')) return ['low', 'medium', 'high'];
  return ['low', 'medium', 'high', 'xhigh']; // fallback
}

function getThinkingValues(method?: string, model?: string): string[] {
  if (!method && !model) return [];
  if (method && CODEX_METHODS.has(method)) return []; // Codex doesn't use thinking
  if (method && CLAUDE_METHODS.has(method)) return ['off', 'on', 'low', 'medium', 'high'];
  // shizuha/direct — model-dependent
  if (model?.startsWith('claude-')) return ['off', 'on', 'low', 'medium', 'high'];
  if (model?.startsWith('gpt-5') || model?.startsWith('codex-')) return [];
  return ['off', 'on', 'low', 'medium', 'high']; // fallback
}

const QUICK_MODELS = [
  'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001',
  'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-4.1', 'o4-mini', 'codex-mini-latest',
];

function formatTokens(n: number): string {
  if (n > 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n > 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

export function StatusBar({
  model,
  method,
  effort,
  thinking,
  mode,
  sessionId,
  totalInputTokens,
  totalOutputTokens,
  turnCount,
  isStreaming,
  error,
  wsConnected,
  onModelChange,
  onMethodChange,
  onModeChange,
  onEffortChange,
  onThinkingChange,
}: StatusBarProps) {
  const totalTokens = totalInputTokens + totalOutputTokens;
  const modeColor = MODE_COLORS[mode] || 'text-zinc-400';
  const [showMethodPicker, setShowMethodPicker] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showEffortPicker, setShowEffortPicker] = useState(false);
  const [showThinkingPicker, setShowThinkingPicker] = useState(false);

  const cycleMode = () => {
    const idx = MODES.indexOf(mode as typeof MODES[number]);
    const next = MODES[(idx + 1) % MODES.length]!;
    onModeChange?.(next);
  };

  const effortValues = getEffortValues(method, model);
  const thinkingValues = getThinkingValues(method, model);

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 px-4 py-1.5 relative">
      <div className="flex items-center justify-between max-w-4xl mx-auto text-[11px]">
        <div className="flex items-center gap-2">
          {/* WS connection indicator */}
          {wsConnected !== undefined && (
            <span className="flex items-center gap-1" title={wsConnected ? 'Connected' : 'Disconnected'}>
              <span className={`w-1.5 h-1.5 rounded-full ${wsConnected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
            </span>
          )}

          {/* Method/Model — each independently clickable */}
          <div className="flex items-center font-mono">
            {/* Method picker */}
            {method && (
              <div className="relative">
                <button
                  onClick={() => { setShowMethodPicker(!showMethodPicker); setShowModelPicker(false); setShowEffortPicker(false); setShowThinkingPicker(false); }}
                  className="text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
                  title="Click to switch execution method"
                >
                  {method}
                </button>
                {showMethodPicker && onMethodChange && (
                  <div className="absolute bottom-full left-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 z-50 min-w-[180px]">
                    {EXEC_METHODS.map((m) => (
                      <button
                        key={m}
                        onClick={() => { onMethodChange(m); setShowMethodPicker(false); }}
                        className={`block w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-zinc-800 cursor-pointer ${m === method ? 'text-shizuha-400' : 'text-zinc-300'}`}
                      >
                        {m}{m === method ? ' ✓' : ''}
                      </button>
                    ))}
                  </div>
                )}
                <span className="text-zinc-700">/</span>
              </div>
            )}
            {/* Model picker */}
            <div className="relative">
              <button
                onClick={() => { setShowModelPicker(!showModelPicker); setShowMethodPicker(false); setShowEffortPicker(false); setShowThinkingPicker(false); }}
                className="text-zinc-300 hover:text-zinc-100 transition-colors cursor-pointer"
                title="Click to switch model"
              >
                {model}
              </button>
              {showModelPicker && onModelChange && (
                <div className="absolute bottom-full left-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 z-50 min-w-[200px]">
                  {QUICK_MODELS.map((m) => (
                    <button
                      key={m}
                      onClick={() => { onModelChange(m); setShowModelPicker(false); }}
                      className={`block w-full text-left px-3 py-1.5 text-xs font-mono hover:bg-zinc-800 cursor-pointer ${m === model ? 'text-shizuha-400' : 'text-zinc-300'}`}
                    >
                      {m}{m === model ? ' ✓' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Separator */}
          <span className="text-zinc-700">|</span>

          {/* Effort — clickable to cycle (only if method supports it) */}
          {effortValues.length > 0 && (
            <div className="relative">
              <button
                onClick={() => {
                  if (onEffortChange) {
                    setShowEffortPicker(!showEffortPicker);
                    setShowModelPicker(false);
                    setShowThinkingPicker(false);
                  }
                }}
                className={`font-medium transition-colors cursor-pointer ${effort ? 'text-amber-400 hover:text-amber-300' : 'text-zinc-600 hover:text-zinc-400'}`}
                title={`Reasoning effort: ${effort || 'default'}. Click to change.`}
              >
                effort:{effort || 'default'}
              </button>
              {showEffortPicker && onEffortChange && (
                <div className="absolute bottom-full left-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 z-50 min-w-[120px]">
                  <button
                    onClick={() => { onEffortChange(''); setShowEffortPicker(false); }}
                    className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 cursor-pointer ${!effort ? 'text-shizuha-400' : 'text-zinc-400'}`}
                  >default{!effort ? ' ✓' : ''}</button>
                  {effortValues.map((e) => (
                    <button
                      key={e}
                      onClick={() => { onEffortChange(e); setShowEffortPicker(false); }}
                      className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 cursor-pointer ${e === effort ? 'text-amber-400' : 'text-zinc-300'}`}
                    >
                      {e}{e === effort ? ' ✓' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Thinking — clickable to cycle (only if method supports it) */}
          {thinkingValues.length > 0 && (
            <div className="relative">
              <button
                onClick={() => {
                  if (onThinkingChange) {
                    setShowThinkingPicker(!showThinkingPicker);
                    setShowModelPicker(false);
                    setShowEffortPicker(false);
                  }
                }}
                className={`font-medium transition-colors cursor-pointer ${thinking && thinking !== 'off' ? 'text-blue-400 hover:text-blue-300' : 'text-zinc-600 hover:text-zinc-400'}`}
                title={`Thinking: ${thinking || 'default'}. Click to change.`}
              >
                thinking:{thinking || 'default'}
              </button>
              {showThinkingPicker && onThinkingChange && (
                <div className="absolute bottom-full left-0 mb-1 bg-zinc-900 border border-zinc-700 rounded-lg shadow-xl py-1 z-50 min-w-[120px]">
                  <button
                    onClick={() => { onThinkingChange(''); setShowThinkingPicker(false); }}
                    className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 cursor-pointer ${!thinking ? 'text-shizuha-400' : 'text-zinc-400'}`}
                  >default{!thinking ? ' ✓' : ''}</button>
                  {thinkingValues.map((t) => (
                    <button
                      key={t}
                      onClick={() => { onThinkingChange(t); setShowThinkingPicker(false); }}
                      className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 cursor-pointer ${t === thinking ? 'text-blue-400' : 'text-zinc-300'}`}
                    >
                      {t}{t === thinking ? ' ✓' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Separator */}
          <span className="text-zinc-700">|</span>

          {/* Mode */}
          <button
            onClick={cycleMode}
            className={`${modeColor} font-medium hover:opacity-80 transition-opacity cursor-pointer`}
            title="Click to cycle mode"
          >
            {mode}
          </button>

          {/* Status */}
          {isStreaming && (
            <span className="flex items-center gap-1 text-shizuha-400">
              <span className="w-1.5 h-1.5 rounded-full bg-shizuha-400 animate-pulse" />
              streaming
            </span>
          )}

          {error && (
            <span className="text-red-400 truncate max-w-[200px]" title={error}>
              {error}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 text-zinc-600">
          {totalInputTokens > 0 && (
            <span title={`Input: ${formatTokens(totalInputTokens)} · Output: ${formatTokens(totalOutputTokens)}`}>
              {formatTokens(totalTokens)} tokens
            </span>
          )}
          {turnCount > 0 && (
            <span>{turnCount} turns</span>
          )}
        </div>
      </div>
    </div>
  );
}
