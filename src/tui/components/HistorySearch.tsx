import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';

interface HistorySearchProps {
  history: string[];
  onSelect: (entry: string) => void;
  onCancel: () => void;
}

/**
 * Overlay for Ctrl+R history search.
 * Fuzzy-matches input against history, Up/Down to navigate, Enter to select, Esc to cancel.
 */
export const HistorySearch: React.FC<HistorySearchProps> = ({ history, onSelect, onCancel }) => {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const matches = useMemo(() => {
    if (!query) return history.slice(0, 10);
    const lower = query.toLowerCase();
    return history.filter((h) => h.toLowerCase().includes(lower)).slice(0, 10);
  }, [query, history]);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      if (matches[selectedIndex]) {
        onSelect(matches[selectedIndex]!);
      } else {
        onCancel();
      }
      return;
    }
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.min(prev + 1, matches.length - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((prev) => prev.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setQuery((prev) => prev + input);
      setSelectedIndex(0);
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">history search: </Text>
        <Text>{query}<Text inverse> </Text></Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {matches.length === 0 ? (
          <Text dimColor>No matches</Text>
        ) : (
          matches.map((entry, i) => {
            const isSelected = i === selectedIndex;
            const display = entry.length > 70 ? entry.slice(0, 70) + '...' : entry;
            // Replace newlines for display
            const singleLine = display.replace(/\n/g, ' \u23CE ');
            return (
              <Box key={i}>
                <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                  {isSelected ? '\u25B6 ' : '  '}{singleLine}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Enter to select, Esc to cancel</Text>
      </Box>
    </Box>
  );
};
