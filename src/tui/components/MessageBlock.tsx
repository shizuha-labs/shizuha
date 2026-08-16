import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme as palette } from '../theme.js';
import type { TranscriptEntry } from '../state/types.js';
import { ToolCall } from './ToolCall.js';
import { StreamingText } from './StreamingText.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { renderMarkdown } from '../utils/markdown.js';
import type { VerbosityLevel } from '../hooks/useSlashCommands.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

interface MessageBlockProps {
  entry: TranscriptEntry;
  verbosity?: VerbosityLevel;
  processingLabel?: string | null;
}

/** Max reasoning summary items to show per verbosity level.
 *  Keep this small to avoid transcript reflow/flicker during streaming. */
const MAX_REASONING_LINES: Record<VerbosityLevel, number> = {
  minimal: 0,
  normal: 1,
  verbose: 3,
};

export function shouldAnimateReasoningSummary(isStreaming: boolean, isLatest: boolean): boolean {
  return isStreaming && isLatest;
}

export const MessageBlock: React.FC<MessageBlockProps> = React.memo(({
  entry,
  verbosity = 'normal',
  processingLabel,
}) => {
  const userGlyph = '\u25B6';
  const assistantGlyph = '\u25C6';
  // SCLI-189: wrap to the CURRENT terminal width (reactive) instead of reading
  // process.stdout.columns inside a memo that never re-runs on resize.
  const { columns } = useTerminalSize();

  if (entry.role === 'system') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box marginLeft={2}>
          <Text dimColor>{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  if (entry.role === 'user') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color={palette.user}>{userGlyph} You</Text>
        <Box marginLeft={2}>
          <Text>{entry.content}</Text>
        </Box>
      </Box>
    );
  }

  // Skip empty completed assistant entries (tool-only turns with no text output).
  // Without this, multi-turn tool use creates stacked bare "◆ Shizuha" headers.
  // Also skip whitespace-only content (e.g. lone '\n' from turn_start paragraph breaks).
  const hasContent = entry.content && entry.content.trim().length > 0;
  const hasVisibleTools = (entry.toolCalls ?? []).length > 0;
  if (!entry.isStreaming && !hasContent && !hasVisibleTools) {
    return null;
  }

  const renderedContent = useMemo(() => {
    if (!entry.content || entry.isStreaming) return entry.content ?? '';
    try {
      return renderMarkdown(entry.content, columns);
    } catch {
      return entry.content;
    }
  }, [entry.content, entry.isStreaming, columns]);

  const reasoningInfo = useMemo(() => {
    const lines = entry.reasoningSummaries ?? [];
    const max = MAX_REASONING_LINES[verbosity] ?? 3;
    if (max === Infinity) return { visible: lines, hidden: 0 };
    if (lines.length <= max) return { visible: lines, hidden: 0 };
    // Keep the latest reasoning items visible; hide older ones first.
    return { visible: lines.slice(-max), hidden: lines.length - max };
  }, [entry.reasoningSummaries, verbosity]);

  const activeToolCalls = useMemo(() => {
    return (entry.toolCalls ?? []).filter((tc) => tc.status === 'running');
  }, [entry.toolCalls]);

  // Assistant message
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold color={palette.assistant}>{assistantGlyph} Shizuha</Text>
      {entry.isStreaming && reasoningInfo.visible.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginBottom={0}>
          {reasoningInfo.visible.map((summary, i) => {
            const isLatest = i === reasoningInfo.visible.length - 1;
            if (shouldAnimateReasoningSummary(Boolean(entry.isStreaming), isLatest)) {
              return (
                <Box key={`r-${reasoningInfo.hidden + i}`}>
                  <Text dimColor>{'\u2022'} </Text>
                  {/* Streaming deltas already prove liveness. An 80 ms shimmer
                      made every frame re-layout the full transcript. */}
                  <Text dimColor>{summary}</Text>
                </Box>
              );
            }
            return (
              <Text key={`r-${reasoningInfo.hidden + i}`} dimColor>
                {'\u2022'} {summary}
              </Text>
            );
          })}
          {reasoningInfo.hidden > 0 && (
            <Text dimColor>
              ... +{reasoningInfo.hidden} older reasoning items hidden (/verbose to show all)
            </Text>
          )}
        </Box>
      )}
      {entry.isStreaming && !entry.content && activeToolCalls.length === 0 && (
        <ThinkingIndicator label={processingLabel} active={true} />
      )}
      {entry.content ? (
        <Box marginLeft={2} flexDirection="column">
          {entry.isStreaming ? (
            <StreamingText text={entry.content} />
          ) : (
            <Text>{renderedContent}</Text>
          )}
        </Box>
      ) : null}
      {activeToolCalls.map((tc, index) => (
        <Box
          key={tc.id}
          marginLeft={2}
          marginTop={entry.content && index === 0 ? 1 : 0}
        >
          <ToolCall entry={tc} verbosity={verbosity} />
        </Box>
      ))}
    </Box>
  );
});
MessageBlock.displayName = 'MessageBlock';
