interface ReasoningBlockProps {
  summaries: string[];
  isStreaming?: boolean;
}

export function ReasoningBlock({ summaries, isStreaming }: ReasoningBlockProps) {
  if (summaries.length === 0) return null;

  // Join all summaries into a single block of text.
  // Streaming fragments arrive as short chunks ("The user wants", "a", "joke.")
  // which look broken when rendered as separate paragraphs.
  const combined = summaries.join(' ').trim();

  return (
    <div className="mb-2">
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-zinc-500 text-xs font-medium">Reasoning</span>
        {isStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-shizuha-400 animate-pulse" />
        )}
      </div>
      <div className="pl-3 border-l-2 border-zinc-700">
        <p className="text-xs text-zinc-500 italic leading-relaxed whitespace-pre-wrap">
          {combined}
        </p>
      </div>
    </div>
  );
}
