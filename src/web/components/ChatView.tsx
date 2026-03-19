import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { MessageBubble } from './MessageBubble';
import { StreamingMessage } from './StreamingMessage';
import type { ChatMessage } from '../lib/types';

interface ChatViewProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingContent: string;
  activeTools: string[];
  reasoningSummaries: string[];
  highlightMessageId?: string | null;
  onSuggestionClick?: (text: string) => void;
}

export interface ChatViewHandle {
  scrollToMessage: (messageId: string) => void;
}

export const ChatView = forwardRef<ChatViewHandle, ChatViewProps>(function ChatView({
  messages,
  isStreaming,
  streamingContent,
  activeTools,
  reasoningSummaries,
  highlightMessageId,
  onSuggestionClick,
}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollRef = useRef(true);

  const scrollToMessage = useCallback((messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight flash
      el.classList.add('ring-1', 'ring-shizuha-500/50');
      setTimeout(() => el.classList.remove('ring-1', 'ring-shizuha-500/50'), 2000);
    }
  }, []);

  useImperativeHandle(ref, () => ({ scrollToMessage }), [scrollToMessage]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (isAutoScrollRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streamingContent, activeTools, reasoningSummaries]);

  // Detect manual scroll
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    isAutoScrollRef.current = atBottom;
  };

  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto px-2 sm:px-4 py-4"
    >
      <div className="max-w-4xl mx-auto">
        {isEmpty && <WelcomeScreen onSuggestionClick={onSuggestionClick} />}

        {messages.map((msg) => (
          <div key={msg.id} id={`msg-${msg.id}`} className={`rounded-lg transition-all duration-300 ${highlightMessageId === msg.id ? 'ring-1 ring-shizuha-500/50' : ''}`}>
            <MessageBubble message={msg} />
          </div>
        ))}

        {isStreaming && (
          <StreamingMessage
            content={streamingContent}
            activeTools={activeTools}
            reasoningSummaries={reasoningSummaries}
          />
        )}
      </div>
    </div>
  );
});

function WelcomeScreen({ onSuggestionClick }: { onSuggestionClick?: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
      <div className="mb-6">
        <div className="w-16 h-16 rounded-2xl bg-shizuha-600/20 flex items-center justify-center mb-4 mx-auto">
          <span className="text-3xl">❖</span>
        </div>
        <h1 className="text-xl font-semibold text-zinc-200">Shizuha</h1>
        <p className="text-sm text-zinc-500 mt-1">Interactive Coding Agent</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-w-lg w-full">
        {SUGGESTIONS.map((suggestion, i) => (
          <button
            key={i}
            onClick={() => onSuggestionClick?.(suggestion)}
            className="p-3 rounded-xl bg-zinc-800/50 border border-zinc-800 text-left hover:bg-zinc-800 hover:border-zinc-700 transition-colors cursor-pointer"
          >
            <p className="text-sm text-zinc-400">{suggestion}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  'Explain the architecture of this project',
  'Find and fix bugs in the test suite',
  'Add a new API endpoint for...',
  'Refactor this function to be more efficient',
];
