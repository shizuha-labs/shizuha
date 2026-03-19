import React from 'react';
import { Box, Text, useInput } from 'ink';
import { getComposerTheme } from '../utils/composerTheme.js';

interface HelpOverlayProps {
  onDismiss: () => void;
}

export const HelpOverlay: React.FC<HelpOverlayProps> = ({ onDismiss }) => {
  const theme = getComposerTheme();
  const bg = theme.background;
  const chrome = theme.background;

  useInput(() => {
    onDismiss();
  });

  return (
    <Box flexDirection="column" marginY={1} paddingX={2} paddingY={1}>
      <Text bold backgroundColor={bg}> Shizuha Help </Text>
      <Text dimColor backgroundColor={bg}> any key closes   ·   /help all shows full reference </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Session </Text>
        <Text dimColor backgroundColor={bg}>   /session · /resume · /clear · /fork · /rename {'<name>'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Model & Reasoning </Text>
        <Text dimColor backgroundColor={bg}>   /model [name] · /mode {'<mode>'} · /think {'<off|on>'} · /effort {'<level>'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Settings & Context </Text>
        <Text dimColor backgroundColor={bg}>   /config ... · /settings ... · /statusline [item] · /compact [instr] · /context · /cost</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Code & Tools </Text>
        <Text dimColor backgroundColor={bg}>   /diff · /review · /status · /copy · /mcp · /memory · /paste-image [prompt]</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Utility </Text>
        <Text dimColor backgroundColor={bg}>   /verbose · /feedback {'<text>'} · /doctor · /init · /exit</Text>
      </Box>

      <Box marginTop={2} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Keyboard </Text>
        <Text dimColor backgroundColor={bg}>   Enter submit · Ctrl+J newline · Tab complete · Up/Down history · Ctrl+R search</Text>
        <Text dimColor backgroundColor={bg}>   Ctrl+C interrupt/quit · Ctrl+P pager · Ctrl+X editor · Ctrl+S stash</Text>
        <Text dimColor backgroundColor={bg}>   Scroll: use tmux scrollback (prefix+[) or terminal scroll</Text>
        <Text dimColor backgroundColor={bg}>   Select: hold Shift+click/drag in tmux · Ctrl+P pager for full history</Text>
      </Box>
    </Box>
  );
};
