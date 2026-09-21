import type { LiveCallError, LiveCallState } from '../hooks/useGrokVoiceS2S';

interface LiveHudProps {
  callState: LiveCallState;
  callError: LiveCallError | null;
  muted: boolean;
  lastHeard: string;
  lastReply: string;
  onMute: () => void;
  onEnd: () => void;
  onRetry: () => void;
}

const STATE_COPY: Record<LiveCallState, string> = {
  idle: 'Idle',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Unavailable',
};

export function LiveHud({
  callState,
  callError,
  muted,
  lastHeard,
  lastReply,
  onMute,
  onEnd,
  onRetry,
}: LiveHudProps) {
  if (callState === 'idle') return null;
  const caption = callError?.message || lastReply || lastHeard || 'Live voice';
  return (
    <div
      className="absolute top-3 left-1/2 z-30 -translate-x-1/2 w-[min(36rem,calc(100%-1.5rem))]"
      data-live-hud="s2s"
      data-transport="s2s"
      data-call-state={callState}
    >
      <div className="rounded-2xl border border-cyan-400/30 bg-zinc-950/90 backdrop-blur-md shadow-[0_12px_40px_rgba(8,145,178,0.18)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${
                callState === 'speaking' ? 'bg-cyan-400 animate-pulse'
                  : callState === 'listening' ? 'bg-emerald-400 animate-pulse'
                    : callState === 'error' ? 'bg-red-400'
                      : 'bg-amber-400 animate-pulse'
              }`} />
              <p className="text-[10px] uppercase tracking-[0.22em] text-cyan-300/80 font-medium">
                Live · {STATE_COPY[callState]}{muted ? ' · muted' : ''}
              </p>
            </div>
            <p className="mt-1 text-sm text-zinc-100 truncate" title={caption}>{caption}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {callState === 'error' ? (
              <button
                type="button"
                onClick={onRetry}
                className="h-9 px-3 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium cursor-pointer"
              >
                Retry
              </button>
            ) : (
              <button
                type="button"
                onClick={onMute}
                className="h-9 w-9 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 cursor-pointer"
                title={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? '🔇' : '🎤'}
              </button>
            )}
            <button
              type="button"
              onClick={onEnd}
              className="h-9 px-3 rounded-xl bg-red-600/90 hover:bg-red-500 text-white text-xs font-medium cursor-pointer"
            >
              End
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
