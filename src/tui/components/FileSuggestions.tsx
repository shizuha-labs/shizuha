import React from 'react';
import { Box, Text } from 'ink';

interface FileSuggestionsProps {
  suggestions: string[];
  selectedIndex?: number;
}

/** Dropdown showing file suggestions for @mentions */
export const FileSuggestions: React.FC<FileSuggestionsProps> = ({ suggestions, selectedIndex = -1 }) => {
  if (suggestions.length === 0) return null;

  return (
    <Box flexDirection="column" marginBottom={0}>
      {suggestions.map((s, i) => (
        <Box key={s}>
          <Text
            color={i === selectedIndex ? 'cyan' : undefined}
            bold={i === selectedIndex}
          >
            {i === selectedIndex ? '\u25B6 ' : '  '}@{s}
          </Text>
        </Box>
      ))}
    </Box>
  );
};
