import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { TranscriptEntry } from '../state/types.js';
import { ToolCall } from './ToolCall.js';
import { StreamingText } from './StreamingText.js';
import { ThinkingIndicator } from './ThinkingIndicator.js';
import { renderMarkdown } from '../utils/markdown.js';
import { ShimmerText } from './ShimmerText.js';
import type { VerbosityLevel } from '../hooks/useSlashCommands.js';

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

export const MessageBlock: React.FC<MessageBlockProps> = React.memo(({ entry, verbosity = 'normal', processingLabel }) => {
  const userGlyph = '\u25B6';
  const assistantGlyph = '\u25C6';

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
        <Text bold color="blue">{userGlyph} You</Text>
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

  // Render markdown for completed messages — full output, no truncation.
  // Content that exceeds the terminal height scrolls upward naturally;
  // the renderer handles tall content via its visible-tail path.
  const renderedContent = useMemo(() => {
    if (!entry.content || entry.isStreaming) return entry.content ?? '';
    try {
      return renderMarkdown(entry.content, process.stdout.columns ?? 80);
    } catch {
      return entry.content;
    }
  }, [entry.content, entry.isStreaming]);

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
      <Text bold color="green">{assistantGlyph} Shizuha</Text>
      {entry.isStreaming && reasoningInfo.visible.length > 0 && (
        <Box flexDirection="column" marginLeft={2} marginBottom={0}>
          {reasoningInfo.visible.map((summary, i) => {
            const isLatest = i === reasoningInfo.visible.length - 1;
            if (isLatest) {
              return (
                <Box key={`r-${reasoningInfo.hidden + i}`}>
                  <Text dimColor>{'\u2022'} </Text>
                  <ShimmerText>{summary}</ShimmerText>
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
      {activeToolCalls.map((tc) => (
        <Box key={tc.id} marginLeft={2}>
          <ToolCall entry={tc} verbosity={verbosity} />
        </Box>
      ))}
      {entry.content ? (
        <Box marginLeft={2} marginTop={activeToolCalls.length ? 1 : 0} flexDirection="column">
          {entry.isStreaming ? (
            <StreamingText text={entry.content} />
          ) : (
            <Text>{renderedContent}</Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
});
MessageBlock.displayName = 'MessageBlock';
