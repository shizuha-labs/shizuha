import React from 'react';
import { Box, Text } from 'ink';

interface DiffViewProps {
  diff: string;
  maxLines?: number;
}

const MAX_DIFF_LINES = 20;

/** Render a unified diff with color-coded lines */
export const DiffView: React.FC<DiffViewProps> = ({ diff, maxLines = MAX_DIFF_LINES }) => {
  const lines = diff.split('\n');
  // Skip the first two lines (--- and +++ headers) if present
  const startIndex = lines.findIndex((l) => l.startsWith('@@'));
  const diffLines = startIndex >= 0 ? lines.slice(startIndex) : lines;
  const truncated = diffLines.length > maxLines;
  const displayed = truncated ? diffLines.slice(0, maxLines) : diffLines;

  return (
    <Box flexDirection="column">
      {displayed.map((line, i) => {
        if (line.startsWith('@@')) {
          return <Text key={i} color="cyan">{line}</Text>;
        }
        if (line.startsWith('+')) {
          return <Text key={i} color="green">{line}</Text>;
        }
        if (line.startsWith('-')) {
          return <Text key={i} color="red">{line}</Text>;
        }
        return <Text key={i} dimColor>{line}</Text>;
      })}
      {truncated && (
        <Text dimColor>... ({diffLines.length - maxLines} more lines)</Text>
      )}
    </Box>
  );
};
