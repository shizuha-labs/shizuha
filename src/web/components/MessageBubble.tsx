import { useState, useCallback, useRef } from 'react';
import { renderMarkdown } from '../lib/markdown';
import { ReasoningBlock } from './ReasoningBlock';
import { ToolCard } from './ToolCard';
import { ImageViewer } from './ImageViewer';
import { CanvasApp, isInteractiveContent, extractCanvasTitle } from './CanvasApp';
import type { ChatMessage, ToolCall } from '../lib/types';

/** Copy text to clipboard — works on HTTP (non-secure) contexts too */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

function fallbackCopy(text: string): Promise<void> {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
  } catch { /* ignore */ }
  document.body.removeChild(textarea);
  return Promise.resolve();
}

interface MessageBubbleProps {
  message: ChatMessage;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const isFailed = message.status === 'failed';
  const [viewingImage, setViewingImage] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handlePointerDown = useCallback(() => {
    longPressTimer.current = setTimeout(() => setShowInfo(true), 500);
  }, []);

  const handlePointerUp = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // System message (auth flow, status updates)
  if (isSystem) {
    return <SystemMessage message={message} />;
  }

  if (isUser) {
    return (
      <div
        className="flex justify-end mb-3 relative"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerUp}
        onContextMenu={(e) => { e.preventDefault(); setShowInfo(true); }}
      >
        <div className="max-w-[75%] min-w-[60px]">
          {/* Attached images */}
          {message.images && message.images.length > 0 && (
            <div className="flex gap-1.5 mb-1.5 justify-end flex-wrap">
              {message.images.map((img, i) => (
                <button
                  key={i}
                  onClick={() => setViewingImage(img.dataUrl)}
                  className="cursor-pointer rounded-xl overflow-hidden border border-zinc-700 hover:border-shizuha-500 transition-colors"
                >
                  <img
                    src={img.dataUrl}
                    alt={img.name || `Image ${i + 1}`}
                    className="max-h-40 max-w-[200px] object-cover"
                  />
                </button>
              ))}
            </div>
          )}
          <div className="bg-shizuha-700 text-zinc-100 rounded-2xl rounded-tr-sm px-4 py-2.5 shadow-sm">
            <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
          </div>
          <div className="text-right mt-0.5 pr-1">
            <span className="text-[10px] text-zinc-600">
              {formatTime(message.createdAt)}
            </span>
          </div>
        </div>

        {viewingImage && (
          <ImageViewer src={viewingImage} onClose={() => setViewingImage(null)} />
        )}
        {showInfo && <MessageInfoOverlay message={message} onClose={() => setShowInfo(false)} />}
      </div>
    );
  }

  // Assistant message
  return (
    <div
      className="flex justify-start mb-3 relative"
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
      onContextMenu={(e) => { e.preventDefault(); setShowInfo(true); }}
    >
      <div className="flex gap-2.5 w-full">
        {/* Avatar */}
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-shizuha-600 flex items-center justify-center mt-1">
          <span className="text-xs font-bold text-white">S</span>
        </div>

        <div className="min-w-0 flex-1">
          {/* Reasoning — full width */}
          {message.reasoningSummaries && message.reasoningSummaries.length > 0 && (
            <ReasoningBlock summaries={message.reasoningSummaries} />
          )}

          {/* Tool calls — collapsed by default, expandable */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <CollapsedToolCalls toolCalls={message.toolCalls} />
          )}

          {/* Content — constrained width, with interactive canvas app detection */}
          {message.content && (
            isInteractiveContent(message.content) ? (
              /* Interactive HTML/JS app — render in sandboxed iframe */
              (() => {
                const { title, html } = extractCanvasTitle(message.content);
                return (
                  <div className="max-w-[95%]">
                    <CanvasApp content={html} title={title} />
                  </div>
                );
              })()
            ) : (
              <div className="max-w-[85%]">
                <div className={`rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm ${
                  isFailed ? 'bg-zinc-800 border border-red-900/50' : 'bg-zinc-800'
                }`}>
                  <div
                    className="markdown-content text-sm text-zinc-200 leading-relaxed"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
                  />
                </div>
              </div>
            )
          )}

          {/* Error */}
          {isFailed && message.errorMessage && (
            <div className="mt-1 px-3 py-1 rounded bg-red-950/30 border border-red-900/30">
              <p className="text-xs text-red-400">{message.errorMessage}</p>
            </div>
          )}

          {/* Metadata */}
          <div className="mt-0.5 pl-1 flex items-center gap-2">
            <span className="text-[10px] text-zinc-600">
              {formatTime(message.createdAt)}
            </span>
            {message.inputTokens != null && message.outputTokens != null && (
              <span className="text-[10px] text-zinc-700">
                {formatTokens(message.inputTokens + message.outputTokens)} tokens
              </span>
            )}
          </div>
        </div>
      </div>
      {showInfo && <MessageInfoOverlay message={message} onClose={() => setShowInfo(false)} />}
    </div>
  );
}

const DIFF_TOOLS = new Set(['edit', 'write']);

function CollapsedToolCalls({ toolCalls }: { toolCalls: ToolCall[] }) {
  const [expanded, setExpanded] = useState(false);

  // Separate: edit/write with diffs always show; rest are collapsed
  const diffCalls = toolCalls.filter(
    (tc) => DIFF_TOOLS.has(tc.tool) && (tc.diff || (tc.output && /^---\s+a\//m.test(tc.output))),
  );
  const otherCalls = toolCalls.filter((tc) => !diffCalls.includes(tc));

  // Summarize tool usage: "read ×3, bash ×2, grep"
  const counts = new Map<string, number>();
  for (const tc of otherCalls) {
    counts.set(tc.tool, (counts.get(tc.tool) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
    .join(', ');

  const hasErrors = otherCalls.some((tc) => tc.isError);

  return (
    <div className="mb-2">
      {/* Diff tools always visible */}
      {diffCalls.map((tc, i) => (
        <ToolCard key={`diff-${tc.tool}-${i}`} toolCall={tc} />
      ))}

      {/* Other tools — collapsed summary */}
      {otherCalls.length > 0 && (
        <div className="my-1">
          <button
            onClick={() => setExpanded(!expanded)}
            className="flex items-center gap-2 text-xs px-2 py-1 rounded-md bg-zinc-800/40 hover:bg-zinc-700/40 transition-colors cursor-pointer"
          >
            <span className="text-zinc-500">⚙</span>
            <span className="text-zinc-500">
              Used {otherCalls.length} tool{otherCalls.length !== 1 ? 's' : ''}
            </span>
            {hasErrors && <span className="text-red-400 text-[10px]">has errors</span>}
            <span className="text-zinc-600 text-[10px]">{summary}</span>
            <span className="text-zinc-600 ml-auto">{expanded ? '▾' : '▸'}</span>
          </button>

          {expanded && (
            <div className="mt-1">
              {otherCalls.map((tc, i) => (
                <ToolCard key={`${tc.tool}-${i}`} toolCall={tc} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Long-press / right-click info overlay showing message metadata. */
function MessageInfoOverlay({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const created = new Date(message.createdAt);
  const ageMs = Date.now() - created.getTime();
  const ageStr = formatAge(ageMs);
  const isOld = ageMs > 5 * 60_000; // older than 5 minutes

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40" onClick={onClose} />
      {/* Info card */}
      <div className="absolute z-50 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl p-3 min-w-[220px] text-xs"
        style={{ top: '50%', left: message.role === 'user' ? 'auto' : '40px', right: message.role === 'user' ? '0' : 'auto', transform: 'translateY(-50%)' }}
      >
        <div className="flex justify-between items-center mb-2">
          <span className="text-zinc-400 font-semibold">Message Info</span>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 cursor-pointer">&times;</button>
        </div>
        <div className="space-y-1.5">
          <InfoRow label="ID" value={message.id.length > 20 ? `${message.id.slice(0, 8)}...${message.id.slice(-8)}` : message.id} />
          <InfoRow label="Role" value={message.role} />
          <InfoRow label="Created" value={created.toLocaleString()} />
          <InfoRow label="Age" value={ageStr} highlight={isOld} />
          {message.seqNum != null && <InfoRow label="Seq #" value={String(message.seqNum)} />}
          {message.status && <InfoRow label="Status" value={message.status} />}
          {message.inputTokens != null && <InfoRow label="In tokens" value={formatTokens(message.inputTokens)} />}
          {message.outputTokens != null && <InfoRow label="Out tokens" value={formatTokens(message.outputTokens)} />}
          {message.durationMs != null && <InfoRow label="Duration" value={`${(message.durationMs / 1000).toFixed(1)}s`} />}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <InfoRow label="Tools" value={`${message.toolCalls.length} call${message.toolCalls.length !== 1 ? 's' : ''}`} />
          )}
          {isOld && (
            <div className="mt-1 px-2 py-1 rounded bg-amber-950/40 border border-amber-800/30">
              <span className="text-amber-400">Possibly replayed (old message)</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function InfoRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-zinc-500">{label}</span>
      <span className={`text-right font-mono ${highlight ? 'text-amber-400' : 'text-zinc-300'}`}>{value}</span>
    </div>
  );
}

function formatAge(ms: number): string {
  if (ms < 1000) return 'just now';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h ago`;
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatTokens(n: number): string {
  if (n > 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

function SystemMessage({ message }: { message: ChatMessage }) {
  const auth = message.authData;
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback((text: string) => {
    copyToClipboard(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  // Auth token input card — paste-in token (e.g. Claude OAuth)
  if (auth?.stage === 'token_input') {
    return <TokenInputCard auth={auth} agentId={message.id} />;
  }

  // Auth device code card — the main interactive auth UI
  if (auth?.stage === 'device_code' && auth.userCode) {
    return (
      <div className="flex justify-center mb-3">
        <div className="max-w-md w-full bg-zinc-800/80 border border-zinc-700 rounded-2xl p-5 shadow-lg">
          <div className="flex items-center gap-2 mb-3">
            <div className="w-8 h-8 rounded-full bg-emerald-600/20 flex items-center justify-center">
              <svg className="w-4 h-4 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">Sign in with ChatGPT</h3>
              <p className="text-xs text-zinc-500">Free with any ChatGPT account</p>
            </div>
          </div>

          <div className="bg-zinc-900 rounded-xl p-4 mb-3">
            <p className="text-xs text-zinc-500 mb-2 text-center">Enter this code at</p>
            <a
              href={auth.verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-center text-sm text-shizuha-400 hover:text-shizuha-300 underline mb-3"
            >
              {auth.verificationUrl}
            </a>
            <div className="flex justify-center">
              <button
                onClick={() => handleCopy(auth.userCode!)}
                className="bg-zinc-800 hover:bg-zinc-700 border border-zinc-600 rounded-lg px-6 py-3 cursor-pointer transition-colors group"
                title="Click to copy"
              >
                <span className="text-2xl font-mono font-bold tracking-[0.3em] text-zinc-100">
                  {auth.userCode}
                </span>
                <span className={`block text-[10px] mt-1 transition-colors ${copied ? 'text-emerald-400' : 'text-zinc-500 group-hover:text-zinc-400'}`}>
                  {copied ? 'Copied!' : 'Click to copy'}
                </span>
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="w-2 h-2 bg-amber-500 rounded-full animate-pulse" />
            Waiting for authorization...
          </div>
        </div>
      </div>
    );
  }

  // Auth complete
  if (auth?.stage === 'complete') {
    return (
      <div className="flex justify-center mb-3">
        <div className="bg-emerald-950/30 border border-emerald-800/40 rounded-xl px-4 py-2.5 flex items-center gap-2">
          <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <p className="text-sm text-emerald-300">{message.content}</p>
        </div>
      </div>
    );
  }

  // Auth error
  if (auth?.stage === 'error') {
    return (
      <div className="flex justify-center mb-3">
        <div className="bg-red-950/30 border border-red-800/40 rounded-xl px-4 py-2.5 flex items-center gap-2">
          <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
          <p className="text-sm text-red-300">{message.content}</p>
        </div>
      </div>
    );
  }

  // Generic system message (status updates, auth_required, etc.)
  return (
    <div className="flex justify-center mb-3">
      <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-xl px-4 py-2 max-w-md">
        <p className="text-xs text-zinc-400 text-center">{message.content}</p>
      </div>
    </div>
  );
}

/** Token input card — paste-in OAuth token for providers like Claude */
function TokenInputCard({ auth }: { auth: NonNullable<ChatMessage['authData']>; agentId: string }) {
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = useCallback(async () => {
    if (!token.trim()) return;
    setStatus('saving');
    try {
      // Get the selected agent ID from the global WS
      const ws = (window as any).__shizuhaWs as WebSocket | null;
      if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Not connected');

      // Send RPC to save token
      const rpcId = `rpc-${Date.now()}`;
      const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
        const handler = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'rpc_response' && msg.id === rpcId) {
              clearTimeout(timeout);
              ws.removeEventListener('message', handler);
              if (msg.error) reject(new Error(msg.error));
              else resolve(msg.result);
            }
          } catch {}
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({
          type: 'rpc', id: rpcId, method: 'auth.save_token',
          params: { token: token.trim(), provider: auth.provider, agent_id: auth.agentId || '' },
        }));
      });

      setStatus('saved');
    } catch (err) {
      setStatus('error');
      setErrorMsg((err as Error).message);
    }
  }, [token, auth.provider]);

  return (
    <div className="flex justify-center mb-3">
      <div className="max-w-md w-full bg-zinc-800/80 border border-zinc-700 rounded-2xl p-5 shadow-lg">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-full bg-violet-600/20 flex items-center justify-center">
            <svg className="w-4 h-4 text-violet-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-zinc-200">
              {auth.provider === 'claude' ? 'Connect Claude' : `Connect ${auth.provider}`}
            </h3>
            <p className="text-xs text-zinc-500">
              {auth.instructions || 'Paste your token below'}
            </p>
          </div>
        </div>

        {status === 'saved' ? (
          <div className="bg-emerald-950/30 border border-emerald-800/40 rounded-xl px-4 py-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-emerald-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            <p className="text-sm text-emerald-300">Token saved. Restarting agent...</p>
          </div>
        ) : (
          <>
            <div className="mb-3">
              <label className="text-xs text-zinc-500 mb-1 block">
                {auth.tokenLabel || 'Token'}
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
                placeholder={auth.placeholder || 'Paste token here...'}
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:border-violet-500 focus:outline-none"
                autoFocus
              />
            </div>

            {auth.provider === 'claude' && (
              <div className="mb-3 space-y-2">
                <div className="bg-zinc-900/50 rounded-lg px-3 py-2">
                  <p className="text-xs text-zinc-400 font-medium mb-1">Option 1 (recommended)</p>
                  <p className="text-xs text-zinc-500">
                    Run <code className="text-violet-400 bg-zinc-800 px-1 rounded">claude setup-token</code> to get a long-lived token, then paste it here.
                  </p>
                </div>
                <div className="bg-zinc-900/30 rounded-lg px-3 py-2">
                  <p className="text-xs text-zinc-500 font-medium mb-1">Other options</p>
                  <p className="text-xs text-zinc-600">
                    Run <code className="text-zinc-500 bg-zinc-800 px-1 rounded">claude</code> to authenticate, then the token at <code className="text-zinc-500 bg-zinc-800 px-1 rounded">~/.claude/.credentials.json</code> will be used automatically on restart. Or set <code className="text-zinc-500 bg-zinc-800 px-1 rounded">CLAUDE_CODE_OAUTH_TOKEN</code> env var.
                  </p>
                </div>
              </div>
            )}

            <button
              onClick={handleSubmit}
              disabled={!token.trim() || status === 'saving'}
              className="w-full bg-violet-600 hover:bg-violet-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white rounded-lg px-4 py-2 text-sm font-medium transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              {status === 'saving' ? 'Saving...' : 'Connect'}
            </button>

            {status === 'error' && (
              <p className="mt-2 text-xs text-red-400">{errorMsg}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
