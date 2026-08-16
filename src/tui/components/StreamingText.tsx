import React, { useMemo } from 'react';
import { Text } from 'ink';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { renderMarkdown } from '../utils/markdown.js';

interface StreamingTextProps {
  text: string;
}

/** Static caret: stream deltas already repaint, so no independent 80 ms timer. */
const StreamTail: React.FC = () => <Text dimColor>  {'▍'}</Text>;

export const StreamingText: React.FC<StreamingTextProps> = ({ text }) => {
  // SCLI-189: wrap markdown to the CURRENT terminal width. Previously this used a
  // module-level `TERM_COLS = process.stdout.columns` captured once at import, so
  // after a resize (e.g. to 80×24) text was still wrapped to the old width — the
  // scattered-characters corruption. useTerminalSize is reactive (debounced), so
  // a resize re-renders at the right width.
  const { columns } = useTerminalSize();

  const rendered = useMemo(() => {
    try {
      return renderMarkdown(text, columns);
    } catch {
      return text;
    }
  }, [text, columns]);

  return (
    <Text>
      {rendered}
      <StreamTail />
    </Text>
  );
};
