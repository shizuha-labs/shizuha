import { renderMarkdown } from '../lib/markdown';
import { ReasoningBlock } from './ReasoningBlock';
import { ActiveTools } from './ToolCard';

interface StreamingMessageProps {
  content: string;
  activeTools: string[];
  reasoningSummaries: string[];
}

export function StreamingMessage({ content, activeTools, reasoningSummaries }: StreamingMessageProps) {
  const hasContent = content.length > 0;
  const hasTools = activeTools.length > 0;
  const hasReasoning = reasoningSummaries.length > 0;

  if (!hasContent && !hasTools && !hasReasoning) {
    // Waiting for first token
    return (
      <div className="flex justify-start mb-3">
        <div className="flex gap-2.5">
          <div className="flex-shrink-0 w-7 h-7 rounded-full bg-shizuha-600 flex items-center justify-center mt-1">
            <span className="text-xs font-bold text-white">S</span>
          </div>
          <div className="bg-zinc-800 rounded-2xl rounded-tl-sm px-4 py-3">
            <div className="flex gap-1">
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 bg-zinc-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start mb-3">
      <div className="flex gap-2.5 w-full">
        <div className="flex-shrink-0 w-7 h-7 rounded-full bg-shizuha-600 flex items-center justify-center mt-1">
          <span className="text-xs font-bold text-white">S</span>
        </div>

        <div className="min-w-0 flex-1">
          {/* Reasoning — full width */}
          {hasReasoning && (
            <ReasoningBlock summaries={reasoningSummaries} isStreaming />
          )}

          {/* Active tools */}
          {hasTools && (
            <div className="mb-2">
              <ActiveTools tools={activeTools} />
            </div>
          )}

          {/* Streaming content — constrained width */}
          {hasContent && (
            <div className="max-w-[85%]">
              <div className="bg-zinc-800 rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm">
                <div
                  className="markdown-content text-sm text-zinc-200 leading-relaxed streaming-cursor"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
