import React, { useState, useCallback, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { MultiLineInput } from './MultiLineInput.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import { getComposerTheme } from '../utils/composerTheme.js';


interface InputBoxProps {
  onSubmit: (text: string) => void;
  isProcessing: boolean;
  isLocked?: boolean;
  queuedCount?: number;
  queuedPrompts?: string[];
  stalledMs?: number;
  processingLabel?: string | null;
  placeholder?: string;
  /** Slash commands for tab completion */
  slashCommands?: Array<{ name: string; description: string }>;
}

const DEFAULT_SLASH_COMMANDS = [
  { name: '/model', description: 'Switch model' },
  { name: '/mode', description: 'Switch mode' },
  { name: '/clear', description: 'Clear transcript' },
  { name: '/compact', description: 'Compact context' },
  { name: '/cost', description: 'Cost breakdown' },
  { name: '/context', description: 'Context window usage' },
  { name: '/copy', description: 'Copy last response' },
  { name: '/think', description: 'Set Claude thinking (on/off)' },
  { name: '/effort', description: 'Set Codex reasoning effort' },
  { name: '/config', description: 'Settings shortcuts' },
  { name: '/session', description: 'Session manager' },
  { name: '/resume', description: 'Resume session (alias)' },
  { name: '/diff', description: 'Show git diff' },
  { name: '/status', description: 'Session info' },
  { name: '/review', description: 'Code review diff' },
  { name: '/rename', description: 'Rename session' },
  { name: '/init', description: 'Create AGENTS.md' },
  { name: '/mcp', description: 'List MCP tools' },
  { name: '/statusline', description: 'Configure status bar' },
  { name: '/memory', description: 'View/edit memory' },
  { name: '/verbose', description: 'Toggle verbosity' },
  { name: '/fork', description: 'Fork session' },
  { name: '/feedback', description: 'Save feedback' },
  { name: '/paste-image', description: 'Paste clipboard image' },
  { name: '/doctor', description: 'Installation diagnostics' },
  { name: '/help', description: 'Show help' },
  { name: '/exit', description: 'Exit' },
];

/** Argument completions for slash commands that accept predefined values */
const ARG_COMPLETIONS: Record<string, string[]> = {
  '/mode': ['plan', 'supervised', 'autonomous'],
  '/think': ['off', 'on'],
  '/effort': ['low', 'medium', 'high', 'xhigh'],
  '/verbose': ['minimal', 'normal', 'verbose'],
  '/statusline': ['model', 'mode', 'activity', 'verbosity', 'tokens', 'context', 'cost', 'turns', 'session', 'time', 'branch', 'lines'],
};

// Shared ref for paste buffer between MultiLineInput and InputBox
export const pasteBufferRef = { current: null as string | null };

function formatStallDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export const InputBox: React.FC<InputBoxProps> = React.memo(({
  onSubmit,
  isProcessing,
  isLocked = false,
  queuedCount = 0,
  queuedPrompts = [],
  stalledMs = 0,
  processingLabel = null,
  placeholder,
  slashCommands,
}) => {
  const [value, setValue] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [completions, setCompletions] = useState<string[] | null>(null);
  const { columns } = useTerminalSize();

  const commands = slashCommands ?? DEFAULT_SLASH_COMMANDS;

  const inputBoxHandlerRef = useRef<(input: string, key: any) => void>(() => {});
  inputBoxHandlerRef.current = (_input: string, key: any) => {
    if (key.escape) {
      setValue('');
      setHistoryIndex(-1);
      setCompletions(null);
    } else if (key.ctrl && _input === 'u') {
      setValue('');
      setCompletions(null);
    } else if (key.ctrl && _input === 'k') {
      setValue('');
      setCompletions(null);
    } else if (key.upArrow && history.length > 0) {
      const newIndex = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(newIndex);
      setValue(history[newIndex] ?? '');
      setCompletions(null);
    } else if (key.downArrow) {
      if (historyIndex <= 0) {
        setHistoryIndex(-1);
        setValue('');
      } else {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setValue(history[newIndex] ?? '');
      }
      setCompletions(null);
    } else if (key.tab && value.startsWith('/')) {
      const parts = value.split(/\s+/);
      if (parts.length >= 2 && parts[0]) {
        // Argument completion
        const cmd = parts[0].toLowerCase();
        const partial = parts[parts.length - 1]!.toLowerCase();
        const candidates = ARG_COMPLETIONS[cmd];
        if (candidates) {
          const matches = candidates.filter((c) => c.startsWith(partial));
          if (matches.length === 1) {
            setValue(cmd + ' ' + matches[0]!);
            setCompletions(null);
          } else if (matches.length > 1) {
            setCompletions(matches);
          }
        }
      } else {
        // Tab completion for slash commands
        const matches = commands.filter((c) => c.name.startsWith(value.toLowerCase()));
        if (matches.length === 1) {
          setValue(matches[0]!.name + ' ');
          setCompletions(null);
        } else if (matches.length > 1) {
          setCompletions(matches.map((c) => c.name));
        }
      }
    } else if (key.tab) {
      // No completion for non-slash input
    } else {
      if (completions) setCompletions(null);
    }
  };
  const stableInputBoxHandler = useCallback((input: string, key: any) => {
    inputBoxHandlerRef.current(input, key);
  }, []);
  useInput(stableInputBoxHandler, { isActive: !isLocked });

  const handleChange = useCallback((newValue: string) => {
    setValue(newValue);
    if (completions) setCompletions(null);
  }, [completions]);

  const handleSubmit = useCallback((text: string) => {
    let finalText = text;
    // Replace paste placeholders with stored content
    if (pasteBufferRef.current && /\[Pasted \d+ chars, \d+ lines\]/.test(finalText)) {
      finalText = finalText.replace(/\[Pasted \d+ chars, \d+ lines\]/, pasteBufferRef.current);
      pasteBufferRef.current = null;
    }
    const trimmed = finalText.trim();
    if (!trimmed) return;
    setHistory((prev) => [trimmed, ...prev]);
    setHistoryIndex(-1);
    setValue('');
    setCompletions(null);
    onSubmit(trimmed);
  }, [onSubmit]);

  const frameWidth = Math.max(24, (columns ?? 80) - 4);
  const contentWidth = Math.max(16, frameWidth - 2);
  const composerTheme = getComposerTheme();
  const inputBackground = composerTheme.background;
  const inputForeground = composerTheme.foreground;
  const promptColor = composerTheme.prompt;
  const rightGutter = 1; // keep a breathing space at the right edge
  const inputWidth = Math.max(8, contentWidth);
  const highlightFill = ' '.repeat(contentWidth);
  const queueSuffix = queuedCount > 0 ? ` \u00b7 queued ${queuedCount}` : '';
  const maxQueuePreview = Math.min(queuedPrompts.length, 3);
  const truncatePrompt = (text: string, max: number) => {
    const first = text.split('\n')[0] ?? text;
    return first.length <= max ? first : first.slice(0, max - 1) + '\u2026';
  };
  const isStalled = isProcessing && stalledMs > 0;
  const activePlaceholder = isProcessing
    ? (placeholder ?? 'Type a message and press Enter to queue...')
    : (placeholder ?? 'Type a message, Ctrl+J for newline, /help for commands...');

  // Determine prompt character based on input mode
  const isBashMode = value.startsWith('!');
  const promptChar = isBashMode ? '!' : '\u276F';
  const stalledGlyph = '\u26A0';
  const queuedGlyph = '\u21B3';

  return (
    <Box flexDirection="column" width={frameWidth}>
      {isProcessing && (isStalled || queuedCount > 0) && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          {isStalled && (
            <Text color="yellow">{stalledGlyph} Stalled {formatStallDuration(stalledMs)} \u00b7 no agent events{queueSuffix}</Text>
          )}
          {queuedPrompts.slice(0, maxQueuePreview).map((prompt, idx) => (
            <Text key={idx} dimColor>{queuedGlyph} {truncatePrompt(prompt, Math.max(20, contentWidth - 4))}</Text>
          ))}
          {queuedPrompts.length > maxQueuePreview && (
            <Text dimColor>  +{queuedPrompts.length - maxQueuePreview} more queued</Text>
          )}
        </Box>
      )}
      {/* Slash command completions */}
      {completions && completions.length > 1 && (
        <Box gap={2} marginBottom={0}>
          {completions.map((c) => (
            <Text key={c} color="cyan">{c}</Text>
          ))}
        </Box>
      )}
      <Box paddingX={1} width={frameWidth}>
        <Box flexDirection="column" width={contentWidth}>
          <Text color={inputForeground} backgroundColor={inputBackground}>{highlightFill}</Text>
          <MultiLineInput
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder={activePlaceholder}
            isActive={!isLocked}
            textColor={inputForeground}
            backgroundColor={inputBackground}
            placeholderColor={composerTheme.placeholder}
            cursorForegroundColor="black"
            cursorBackgroundColor="white"
            promptChar={promptChar}
            promptColor={promptColor}
            rightGutter={rightGutter}
            width={inputWidth}
          />
          <Text color={inputForeground} backgroundColor={inputBackground}>{highlightFill}</Text>
        </Box>
      </Box>
    </Box>
  );
});
InputBox.displayName = 'InputBox';
