import React from 'react';
import { Box, Text } from 'ink';
import type { ToolCallEntry } from '../state/types.js';
import type { VerbosityLevel } from '../hooks/useSlashCommands.js';
import { DiffView } from './DiffView.js';
import { MarkdownText } from './MarkdownText.js';
import { wrapFileLinks } from '../utils/osc8.js';
import { previewToolInput } from '../utils/toolInputPreview.js';
import { useSpinner } from '../hooks/useSpinner.js';
import { useElapsedTime } from '../hooks/useElapsedTime.js';

interface ToolCallProps {
  entry: ToolCallEntry;
  cwd?: string;
  verbosity?: VerbosityLevel;
}

/** Tool icons for visual identification */
const TOOL_ICONS: Record<string, string> = {
  bash: '\u26A1',
  read_file: '\uD83D\uDCC4',
  write_file: '\u270F',
  edit_file: '\u270F',
  search: '\uD83D\uDD0D',
  grep: '\uD83D\uDD0D',
  glob: '\uD83D\uDCC1',
  web_search: '\uD83C\uDF10',
  web_fetch: '\uD83C\uDF10',
  ask_user: '\uD83D\uDCAC',
  mcp: '\uD83D\uDD0C',
};

const MAX_RESULT_LINE_CHARS = 120;
const MAX_COMMAND_LINE_CHARS = 140;

interface TruncationLimits {
  head: number;
  tail: number;
  label: string;
}

const SUCCESS_RESULT_LIMITS: Record<VerbosityLevel, TruncationLimits> = {
  minimal: { head: 0, tail: 0, label: 'output hidden (/verbose to show)' },
  // Keep tool output concise by default while preserving enough context.
  normal: { head: 3, tail: 2, label: '... +{n} lines (/verbose to show all)' },
  verbose: { head: 3, tail: 2, label: '... +{n} lines (Ctrl+P for pager)' },
};

const ERROR_RESULT_LIMITS: Record<VerbosityLevel, TruncationLimits> = {
  // Keep the first error line visible even in minimal mode to preserve signal.
  minimal: { head: 1, tail: 0, label: '... +{n} lines (/verbose to show all)' },
  normal: { head: 3, tail: 2, label: '... +{n} lines (/verbose to show all)' },
  verbose: { head: 3, tail: 2, label: '... +{n} lines (Ctrl+P for pager)' },
};

const COMMAND_LIMITS: Record<VerbosityLevel, TruncationLimits> = {
  minimal: { head: 0, tail: 0, label: 'command hidden (/verbose to show)' },
  normal: { head: 3, tail: 2, label: '... +{n} command lines (/verbose to show all)' },
  verbose: { head: 5, tail: 3, label: '... +{n} command lines (Ctrl+P for pager)' },
};

function getToolIcon(name: string): string {
  if (name.startsWith('mcp__')) return TOOL_ICONS['mcp']!;
  if (TOOL_ICONS[name]) return TOOL_ICONS[name]!;
  // Prefix match for mcp__ tools
  const base = name.includes('__') ? name.split('__').pop()! : name;
  if (TOOL_ICONS[base]) return TOOL_ICONS[base]!;
  return '\u2699';
}

function getDisplayToolName(name: string): string {
  if (name.startsWith('mcp__')) {
    const [, server, tool] = name.split('__');
    if (server && tool) return `mcp:${server}/${tool}`;
  }
  return name;
}

function truncateInline(value: string, maxChars = 220): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function shellQuoteSingle(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getCommandPreview(entry: ToolCallEntry): string | null {
  if (entry.commandPreview?.trim()) return truncateInline(entry.commandPreview, 120);

  if (entry.name === 'bash') {
    const command = entry.input.command;
    if (typeof command === 'string' && command.trim()) {
      return `/bin/bash -lc ${shellQuoteSingle(truncateInline(command, 100))}`;
    }
    return 'bash';
  }

  if (entry.name.startsWith('mcp__')) {
    const [, server, tool] = entry.name.split('__');
    if (server && tool) return `mcp ${server}/${tool}`;
  }

  const inline = getToolInlineSummary(entry.input, 90);
  if (inline) return `${entry.name} ${inline}`;
  return entry.name;
}

/** Priority keys to show as inline summary on the tool header line.
 *  Returns a compact string like "/path/to/file.ts" or "pattern: foo.*bar". */
const INLINE_SUMMARY_KEYS = ['file_path', 'path', 'pattern', 'query', 'url', 'glob'];
function getToolInlineSummary(input: Record<string, unknown>, maxChars = 60): string {
  for (const key of INLINE_SUMMARY_KEYS) {
    const val = input[key];
    if (val && typeof val === 'string') {
      const display = key === 'file_path' || key === 'path' || key === 'url'
        ? val  // show raw path/URL (no key: prefix)
        : `${key}: ${val}`;
      return display.length > maxChars ? display.slice(0, maxChars - 3) + '...' : display;
    }
  }
  return '';
}

/** Truncate a single line to max chars */
function capLine(line: string, maxChars = MAX_RESULT_LINE_CHARS): string {
  return line.length > maxChars ? line.slice(0, maxChars) + '...' : line;
}

function getResultLimits(isError: boolean, verbosity: VerbosityLevel): TruncationLimits {
  if (isError) return ERROR_RESULT_LIMITS[verbosity] ?? ERROR_RESULT_LIMITS.normal;
  return SUCCESS_RESULT_LIMITS[verbosity] ?? SUCCESS_RESULT_LIMITS.normal;
}

function truncateTailResult(result: string, tailLines: number, maxLineChars = MAX_RESULT_LINE_CHARS): string {
  const lines = result.split('\n');
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length <= tailLines) {
    return lines.map((line) => capLine(line, maxLineChars)).join('\n');
  }
  const omitted = lines.length - tailLines;
  return [
    `... +${omitted} lines`,
    ...lines.slice(-tailLines).map((line) => capLine(line, maxLineChars)),
  ].join('\n');
}

/** Smart head+tail truncation instead of just head */
function truncateResult(result: string, limits: TruncationLimits, maxLineChars = MAX_RESULT_LINE_CHARS): string {
  if (limits.head === 0 && limits.tail === 0) return '';

  const lines = result.split('\n');
  if (lines.length <= limits.head + limits.tail) {
    return lines.map((line) => capLine(line, maxLineChars)).join('\n');
  }

  const omitted = lines.length - limits.head - limits.tail;
  return [
    ...lines.slice(0, limits.head).map((line) => capLine(line, maxLineChars)),
    limits.label.replace('{n}', `${omitted}`),
    ...lines.slice(-limits.tail).map((line) => capLine(line, maxLineChars)),
  ].join('\n');
}

function getResultText(entry: ToolCallEntry, verbosity: VerbosityLevel): string {
  if (!entry.result) return '';
  if (entry.status === 'running' && verbosity !== 'verbose') {
    // For in-flight tools in normal/minimal mode, keep a compact live tail.
    return truncateTailResult(entry.result, 2);
  }
  return truncateResult(entry.result, getResultLimits(Boolean(entry.isError), verbosity));
}

function getCommandText(command: string, verbosity: VerbosityLevel): string {
  return truncateResult(command, COMMAND_LIMITS[verbosity] ?? COMMAND_LIMITS.normal, MAX_COMMAND_LINE_CHARS);
}

/** Animated spinner for running tools (isolates hook calls) */
const ToolSpinner: React.FC = () => {
  const { frame } = useSpinner('dots9', true);
  return <Text color="yellow">{frame} </Text>;
};

/** Live elapsed time for running tools (isolates hook calls) */
const RunningDuration: React.FC = () => {
  const { formatted } = useElapsedTime(true);
  return <Text dimColor> ({formatted})</Text>;
};

export const ToolCall: React.FC<ToolCallProps> = ({ entry, cwd, verbosity = 'normal' }) => {
  const isRunning = entry.status === 'running';
  const commandLimits = COMMAND_LIMITS[verbosity] ?? COMMAND_LIMITS.normal;
  const commandPreview = getCommandPreview(entry);
  const commandText = entry.name === 'bash' && entry.input.command
    ? getCommandText(String(entry.input.command), verbosity)
    : '';
  const inputLines = entry.name === 'bash' ? [] : previewToolInput(entry.input, 2);
  const inlineSummary = entry.name !== 'bash' ? getToolInlineSummary(entry.input) : '';
  const isHiddenCommand = entry.name === 'bash' && Boolean(entry.input.command) && !commandText && !commandPreview;
  const resultLimits = getResultLimits(Boolean(entry.isError), verbosity);
  const resultText = getResultText(entry, verbosity);
  const shouldShowResult = Boolean(resultText);
  const isHiddenResult = !entry.isError && entry.result && resultLimits.head === 0 && resultLimits.tail === 0;
  const isDiffHidden = Boolean(entry.metadata?.diff) && !entry.isError && verbosity !== 'verbose';

  return (
    <Box flexDirection="column" marginTop={0} marginBottom={0}>
      <Box>
        {isRunning ? (
          <ToolSpinner />
        ) : (
          <Text color={entry.isError ? 'red' : 'green'}>{entry.isError ? '\u2717' : '\u2713'} </Text>
        )}
        <Text bold color="yellow">{getToolIcon(entry.name)} {getDisplayToolName(entry.name)}</Text>
        {commandPreview ? <Text dimColor> {commandPreview}</Text> : inlineSummary ? <Text dimColor> {inlineSummary}</Text> : null}
        {isRunning ? (
          <RunningDuration />
        ) : entry.durationMs != null ? (
          <Text dimColor> ({(entry.durationMs / 1000).toFixed(1)}s)</Text>
        ) : null}
      </Box>
      {entry.name === 'bash' && entry.input.command && commandText && verbosity === 'verbose' ? (
        <Box marginLeft={3}>
          <MarkdownText>{'```bash\n' + commandText + '\n```'}</MarkdownText>
        </Box>
      ) : isHiddenCommand ? (
        <Box marginLeft={3}>
          <Text dimColor>{commandLimits.label}</Text>
        </Box>
      ) : inputLines.length > 0 ? (
        <Box marginLeft={3} flexDirection="column">
          {inputLines.map((line, idx) => (
            <Text key={`${entry.id}-input-${idx}`} dimColor>{line}</Text>
          ))}
        </Box>
      ) : null}
      {entry.result && !entry.isError && Boolean(entry.metadata?.diff) && verbosity === 'verbose' && (
        <Box marginLeft={3}>
          <DiffView diff={entry.metadata!.diff as string} />
        </Box>
      )}
      {isDiffHidden && (
        <Box marginLeft={3}>
          <Text dimColor>diff hidden (/verbose to show)</Text>
        </Box>
      )}
      {entry.result && !entry.isError && !Boolean(entry.metadata?.diff) && shouldShowResult && (
        <Box marginLeft={3}>
          <Text dimColor>{cwd ? wrapFileLinks(resultText, cwd) : resultText}</Text>
        </Box>
      )}
      {entry.result && entry.isError && (
        <Box marginLeft={3}>
          <Text color="red">{cwd ? wrapFileLinks(resultText, cwd) : resultText}</Text>
        </Box>
      )}
      {isHiddenResult && (
        <Box marginLeft={3}>
          <Text dimColor>{resultLimits.label}</Text>
        </Box>
      )}
    </Box>
  );
};
