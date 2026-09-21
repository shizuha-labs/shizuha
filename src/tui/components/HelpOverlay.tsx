import React from 'react';
import { Box, Text, useInput } from 'ink';
import { getComposerTheme } from '../utils/composerTheme.js';

interface HelpOverlayProps {
  onDismiss: () => void;
  /** SCLI-460: buffer printable keystrokes into the composer draft instead of
   *  losing them while the panel is open. */
  onInput?: (input: string) => void;
}

/**
 * Compact help card.
 *
 * SCLI-383: dismiss keys must be fully consumed. Ink can deliver the same
 * keystroke to a newly-mounted composer after setScreen('prompt'), which left
 * a stray `q` in the draft and turned `/mode …` into a provider turn.
 * We only accept Esc/q (documented) and call onDismiss once; the parent also
 * arms a one-shot composer suppress barrier.
 *
 * SCLI-460: printable keystrokes are NOT dismiss keys — they are buffered into
 * the composer draft via onInput so a user who runs /help and immediately
 * starts typing their next message does not lose those keystrokes.
 */
export const HelpOverlay: React.FC<HelpOverlayProps> = ({ onDismiss, onInput }) => {
  const theme = getComposerTheme();
  const bg = theme.background;
  const chrome = theme.background;

  useInput((input, key) => {
    // Dismiss keys — fully consumed, never leak to the composer (SCLI-383).
    if (key.escape || input === 'q' || input === 'Q' || key.return) {
      onDismiss();
      return;
    }
    // Control/meta keys — consume without dismissing or buffering.
    if (key.ctrl || key.meta) {
      return;
    }
    // Printable keystrokes — buffer into the composer draft (SCLI-460).
    if (input.length > 0) {
      onInput?.(input);
    }
  });

  return (
    <Box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1} overflow="hidden">
      <Text bold backgroundColor={bg}> Shizuha Help </Text>
      <Text dimColor backgroundColor={bg}> Esc or q closes   ·   /help all shows full reference </Text>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Session </Text>
        <Text dimColor backgroundColor={bg}>   /session · /resume · /clear · /fork · /rename {'<name>'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Model & Reasoning </Text>
        <Text dimColor backgroundColor={bg}>   /model [name] · /mode {'<mode>'} · /think {'<off|on>'} · /effort {'<level>'} · /mouse {'[on|off]'}</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Settings & Context </Text>
        <Text dimColor backgroundColor={bg}>   /config ... · /settings ... · /statusline [item] · /compact [instr] · /context · /cost</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Code & Tools </Text>
        <Text dimColor backgroundColor={bg}>   /diff · /review · /status · /copy · /mcp (toggle servers) · /memory · /paste-image [prompt]</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Utility </Text>
        <Text dimColor backgroundColor={bg}>   /verbose · /feedback {'<text>'} · /doctor · /init · /exit</Text>
      </Box>

      <Box marginTop={2} flexDirection="column">
        <Text color={chrome} backgroundColor={bg}> Keyboard </Text>
        <Text dimColor backgroundColor={bg}>   Enter submit · Ctrl+J newline · Tab complete · Up/Down history · Ctrl+R search</Text>
        <Text dimColor backgroundColor={bg}>   Ctrl+C interrupt/quit · Ctrl+Z suspend (fg resumes) · Ctrl+Y undo edit</Text>
        <Text dimColor backgroundColor={bg}>   Ctrl+P pager · Ctrl+X editor · Ctrl+S stash</Text>
        <Text dimColor backgroundColor={bg}>   Ctrl+B demote foreground command to background · Ctrl+G tasks pane</Text>
        <Text dimColor backgroundColor={bg}>   Scroll: mouse wheel or PgUp/PgDn · Ctrl+P opens the full-history pager</Text>
        <Text dimColor backgroundColor={bg}>   Select: hold Shift+click/drag in tmux · q/Esc exits the pager</Text>
      </Box>
    </Box>
  );
};
