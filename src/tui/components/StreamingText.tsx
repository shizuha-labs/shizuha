import React, { useMemo } from 'react';
import { Text } from 'ink';
import { useSpinner } from '../hooks/useSpinner.js';
import { renderMarkdown } from '../utils/markdown.js';

interface StreamingTextProps {
  text: string;
}

const TERM_COLS = process.stdout.columns ?? 80;
const STREAM_MARKDOWN_CHAR_BUDGET = 12000;

/** Animated trailing spinner for streaming text (isolates hook calls) */
const StreamTail: React.FC = () => {
  const { frame } = useSpinner('dots', true);
  return <Text dimColor>  {frame}</Text>;
};

export const StreamingText: React.FC<StreamingTextProps> = ({ text }) => {
  const source = useMemo(() => {
    // Parsing full streaming transcripts repeatedly is expensive and causes
    // visible lag/jitter in long runs. Keep only a suffix during stream.
    if (text.length <= STREAM_MARKDOWN_CHAR_BUDGET) return text;
    const tail = text.slice(-STREAM_MARKDOWN_CHAR_BUDGET);
    const firstNewline = tail.indexOf('\n');
    if (firstNewline >= 0) return `...\n${tail.slice(firstNewline + 1)}`;
    return `...${tail}`;
  }, [text]);

  const rendered = useMemo(() => {
    try {
      return renderMarkdown(source, TERM_COLS);
    } catch {
      return source;
    }
  }, [source]);

  return (
    <Text>
      {rendered}
      <StreamTail />
    </Text>
  );
};
