import { useRef, useState, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
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
}, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAutoScrollRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);

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

  // Detect manual scroll — show "scroll to bottom" button when scrolled up
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < 60;
    isAutoScrollRef.current = atBottom;
    setShowScrollDown(!atBottom && distFromBottom > 80);
  };

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
      isAutoScrollRef.current = true;
      setShowScrollDown(false);
    }
  }, []);

  const isEmpty = messages.length === 0 && !isStreaming;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-2 sm:px-4 py-4"
      >
        <div className="max-w-4xl mx-auto">
          {isEmpty && <WelcomeScreen />}

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

      {/* Scroll to bottom — positioned over the scroll area, not inside it */}
      {showScrollDown && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 w-9 h-9 rounded-full bg-zinc-700 hover:bg-zinc-600 border border-zinc-600 shadow-lg flex items-center justify-center transition-all cursor-pointer"
          title="Scroll to bottom"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-zinc-300">
            <path d="M8 3v10M4 9l4 4 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      )}
    </div>
  );
});

function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center">
      <div className="mb-6">
        <div className="w-16 h-16 rounded-2xl bg-shizuha-600/20 flex items-center justify-center mb-4 mx-auto">
          <span className="text-3xl">❖</span>
        </div>
        <h1 className="text-xl font-semibold text-zinc-200">Shizuha</h1>
        <p className="text-sm text-zinc-500 mt-1">Interactive Coding Agent</p>
      </div>

    </div>
  );
}

