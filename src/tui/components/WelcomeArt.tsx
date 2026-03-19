import React, { useMemo } from 'react';
import { Box, Text } from 'ink';

const TIPS: string[] = [
  'Ctrl+J to insert a newline in your message',
  '/model to switch between LLM providers',
  '/mode to toggle plan / supervised / autonomous',
  '/session to manage conversation sessions',
  '/compact to free up context window space',
  'Ctrl+P to page through full transcript history',
  'Ctrl+C to interrupt a running agent turn',
  'Prefix with ! to run a shell command directly',
  '/think on|off to toggle extended thinking',
  '/effort low|medium|high to set reasoning effort',
  '/help for the full list of commands',
  'Mention @filepath to include file context',
  '/verbose minimal|normal|verbose to control output detail',
  'Ctrl+R to search through input history',
];

const GREETINGS: string[] = [
  'What are you building today?',
  'Ready when you are.',
  'How can I help?',
  'What shall we work on?',
  'Describe a task to get started.',
];

// Header(2) + InputBox(3) + StatusBar(2) + margins/buffer(3) = 10
const CHROME_LINES = 10;

const VERSION = '0.1.0-beta';

interface WelcomeArtProps {
  columns: number;
  rows: number;
  model: string;
  mode: string;
  cwd: string;
}

export const WelcomeArt: React.FC<WelcomeArtProps> = ({ columns, rows, model, mode, cwd }) => {
  const maxHeight = rows - CHROME_LINES;
  if (maxHeight < 4) return null;

  const content = useMemo(() => {
    const contentWidth = Math.max(30, columns - 6);
    const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]!;

    // Info box takes 6 lines (top border + 3 content + bottom border + blank)
    // greeting takes 1 line + 1 blank = 2 lines
    const infoBoxLines = maxHeight >= 12 ? 6 : 0;
    const tipBudget = maxHeight - 2 - infoBoxLines;
    const offset = (columns + rows) % TIPS.length;
    const tips: string[] = [];
    for (let i = 0; i < TIPS.length && tips.length < tipBudget; i++) {
      const tip = TIPS[(offset + i) % TIPS.length]!;
      if (tip.length < contentWidth - 4) {
        tips.push(tip);
      }
    }

    // Shorten cwd: replace $HOME with ~
    const home = process.env['HOME'] ?? '';
    const shortCwd = home && cwd.startsWith(home) ? '~' + cwd.slice(home.length) : cwd;

    return { greeting, tips, showInfoBox: infoBoxLines > 0, shortCwd };
  }, [columns, rows, maxHeight, cwd]);

  return (
    <Box flexDirection="column" flexGrow={1} height={maxHeight} justifyContent="center" paddingX={2}>
      {content.showInfoBox && (
        <Box flexDirection="column" marginBottom={1}>
          <Box borderStyle="round" flexDirection="column" paddingX={1}>
            <Text bold>{'>'}_ Shizuha <Text dimColor>(v{VERSION})</Text></Text>
            <Text> </Text>
            <Text dimColor>{'model:     '}<Text>{model}</Text>{'   '}<Text dimColor>/model to change</Text></Text>
            <Text dimColor>{'mode:      '}<Text>{mode}</Text>{'   '}<Text dimColor>/mode to change</Text></Text>
            <Text dimColor>{'directory: '}<Text>{content.shortCwd}</Text></Text>
          </Box>
        </Box>
      )}
      <Box flexDirection="column" marginBottom={1}>
        <Text dimColor bold>{content.greeting}</Text>
      </Box>
      <Box flexDirection="column">
        {content.tips.map((tip, i) => (
          <Text key={i} dimColor>  {'·'} {tip}</Text>
        ))}
      </Box>
    </Box>
  );
};
