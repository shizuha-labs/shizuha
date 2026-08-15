import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import { theme as palette } from '../theme.js';
import type { PermissionMode } from '../../permissions/types.js';
import { computeCost, formatCost } from '../utils/pricing.js';
import { contextUsagePercent } from '../utils/contextWindow.js';
import { getStatusItems } from '../utils/statusConfig.js';
import { getComposerTheme } from '../utils/composerTheme.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { VerbosityLevel } from '../hooks/useSlashCommands.js';
import { isTmuxSession } from '../utils/terminal.js';
import { formatModelDisplay } from '../utils/modelDisplay.js';
import { resolveReasoningEffortForRequest } from '../../provider/model-profile.js';

interface StatusBarProps {
  model: string;
  mode: PermissionMode;
  sessionId: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  turnCount: number;
  contextTokens?: number;
  servedModelInfo?: { requestedModel: string; model: string; contextWindow: number } | null;
  /** Last-turn perf fragment (SCLI-21), e.g. "TTFT 1.2s · 38 tok/s". */
  lastTurnPerf?: string | null;
  /** Current-turn live token progress, e.g. "in ~3.4k · out ~210 · 14 tok/s". */
  liveTurnPerf?: string | null;
  startTime?: number;
  linesAdded?: number;
  linesRemoved?: number;
  branch?: string | null;
  isProcessing?: boolean;
  stalledMs?: number;
  /** Epoch-ms timestamp of the last agent event (0 = none).
   *  StatusBar derives "idle Xs" / "live Xs" internally to avoid
   *  triggering parent re-renders every second. */
  lastAgentEventAt?: number;
  rateLimitWarning?: string | null;
  thinkingLevel?: string;
  reasoningEffort?: string | null;
  fastMode?: boolean;
  verbosity?: VerbosityLevel;
  /** Active plan file path in plan mode */
  planFilePath?: string | null;
  /** Descriptions of running background tasks, shown in stall message */
  runningTasks?: string[];
  /** Active /watch subscriptions */
  activeWatches?: string[];
}

const modeColors: Record<PermissionMode, string> = {
  plan: 'cyan',
  supervised: 'yellow',
  autonomous: 'green',
};

/** Short mode labels to prevent status bar overflow at 120 columns */
const modeLabels: Record<PermissionMode, string> = {
  plan: 'plan',
  supervised: 'sup',
  autonomous: 'auto',
};

function formatElapsed(startTime: number): string {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

function formatAge(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins === 0) return `${secs}s`;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function clampLabel(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(1, max - 1))}\u2026`;
}

function shortEffort(level: string): string {
  switch (level) {
    case 'low': return 'l';
    case 'medium': return 'm';
    case 'high': return 'h';
    case 'xhigh': return 'xh';
    default: return level;
  }
}

function shortVerbosity(level: VerbosityLevel): string {
  switch (level) {
    case 'minimal': return 'min';
    case 'normal': return 'norm';
    case 'verbose': return 'verb';
    default: return level;
  }
}

function thinkingState(thinkingLevel?: string): 'on' | 'off' {
  return thinkingLevel && thinkingLevel !== 'off' ? 'on' : 'off';
}

/** Footer token: `think:on(high)` / `t:on(h)`. Effort is the wire value. */
export function formatThinkStatus(
  model: string,
  thinkingLevel: string | undefined,
  reasoningEffort: string | null | undefined,
  opts?: { veryNarrow?: boolean; narrow?: boolean },
): string {
  const on = thinkingState(thinkingLevel);
  const prefix = opts?.veryNarrow ? 't' : 'think';
  if (on === 'off') return `${prefix}:off`;
  const effort = resolveReasoningEffortForRequest(model, {
    reasoningEffort,
    thinkingLevel,
  });
  if (!effort) return `${prefix}:on`;
  const shown = opts?.veryNarrow || opts?.narrow ? shortEffort(effort) : effort;
  return `${prefix}:on(${shown})`;
}

export const StatusBar: React.FC<StatusBarProps> = React.memo(({
  model, mode, sessionId, totalInputTokens, totalOutputTokens, turnCount,
  contextTokens, servedModelInfo, startTime, linesAdded, linesRemoved, branch, isProcessing = false, stalledMs = 0,
  lastAgentEventAt = 0, lastTurnPerf, liveTurnPerf, rateLimitWarning, thinkingLevel, reasoningEffort, fastMode = false, verbosity = 'normal',
  planFilePath, runningTasks = [], activeWatches = [],
}) => {
  const { columns } = useTerminalSize();
  const isTmux = isTmuxSession();

  // Update activity age while processing; freeze while idle to avoid
  // continuous full-screen repaints in long transcript sessions.
  const [agentEventAge, setAgentEventAge] = useState<number | null>(() =>
    lastAgentEventAt > 0 ? Math.max(0, Date.now() - lastAgentEventAt) : null,
  );
  const lastAtRef = useRef(lastAgentEventAt);
  lastAtRef.current = lastAgentEventAt;
  useEffect(() => {
    const computeAge = () => {
      const ts = lastAtRef.current;
      return ts > 0 ? Math.max(0, Date.now() - ts) : null;
    };
    setAgentEventAge(computeAge());
    // stalledMs is already minute-bucketed. Once the long-wait row is visible,
    // stop the otherwise-useful one-second activity clock from re-rendering an
    // identical status line behind it.
    if (!isProcessing || stalledMs > 0 || lastAtRef.current <= 0) return;
    const timer = setInterval(() => setAgentEventAge(computeAge()), 1000);
    return () => clearInterval(timer);
  }, [isProcessing, lastAgentEventAt, stalledMs]);
  const theme = getComposerTheme();
  const chromeColor = theme.background;
  const isNarrow = (columns ?? 80) < 90;
  const isVeryNarrow = (columns ?? 80) < 70;

  const tokens = totalInputTokens + totalOutputTokens;
  const tokenStr = tokens > 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`;
  const shortSession = sessionId ? sessionId.slice(0, 8) : 'new';

  // Context usage
  const ctxUsed = contextTokens ?? tokens;
  const effectiveContextWindow = servedModelInfo?.contextWindow;
  const ctxPercent = contextUsagePercent(ctxUsed, servedModelInfo?.model ?? model, effectiveContextWindow);
  const ctxColor = ctxPercent > 80 ? 'red' : ctxPercent > 60 ? 'yellow' : undefined;

  // Cost
  const cost = computeCost(model, totalInputTokens, totalOutputTokens);
  const costStr = formatCost(cost);
  const hasLineDelta = (linesAdded ?? 0) > 0 || (linesRemoved ?? 0) > 0;
  const displayModel = servedModelInfo && servedModelInfo.model !== servedModelInfo.requestedModel
    ? `${formatModelDisplay(servedModelInfo.requestedModel)}→${formatModelDisplay(servedModelInfo.model)}`
    : formatModelDisplay(servedModelInfo?.model ?? model);
  const perfStatus = liveTurnPerf ?? lastTurnPerf;

  const items = getStatusItems();
  const show = (item: string) => items.includes(item as any);

  if (isTmux) {
    const parts: string[] = [];

    if (show('model')) {
      const modelLabel = clampLabel(displayModel, isVeryNarrow ? 16 : isNarrow ? 22 : 30);
      const thinkSuffix = ` ${formatThinkStatus(model, thinkingLevel, reasoningEffort, { veryNarrow: isVeryNarrow, narrow: isNarrow })}`;
      const fastSuffix = fastMode ? ' (f)' : '';
      parts.push(`${modelLabel}${thinkSuffix}${fastSuffix}`);
    }

    if (show('mode')) parts.push(modeLabels[mode]);
    if (mode === 'plan' && planFilePath) {
      const planBasename = planFilePath.split('/').pop() ?? planFilePath;
      parts.push(planBasename);
    }

    if (show('activity')) {
      const bgSuffix = [
        activeWatches.length > 0 ? `watch:${activeWatches[0]!.slice(0, 24)}` : '',
      ].filter(Boolean).join(' ');
      if (isProcessing && stalledMs > 0) {
        const taskInfo = runningTasks.length > 0
          ? `wait:${runningTasks[0]!.slice(0, 40)}`
          : `wait ${formatAge(stalledMs)}`;
        parts.push(taskInfo);
      } else if (isProcessing) parts.push(`live ${formatAge(agentEventAge ?? 0)}`);
      else if (agentEventAge != null) parts.push(`idle ${formatAge(agentEventAge)}${bgSuffix ? ` ${bgSuffix}` : ''}`);
      else parts.push(`idle --${bgSuffix ? ` ${bgSuffix}` : ''}`);
    }

    if (show('verbosity')) parts.push(shortVerbosity(verbosity));
    if (show('branch') && branch) parts.push(`git:${clampLabel(branch, isVeryNarrow ? 10 : isNarrow ? 16 : 24)}`);
    if (show('context')) parts.push(`${ctxPercent}%`);
    if (show('cost')) parts.push(costStr);
    if (show('tokens')) parts.push(tokenStr);
    if (show('turns')) parts.push(`${turnCount}`);
    if (show('perf') && perfStatus) parts.push(perfStatus);
    if (show('time') && startTime) parts.push(formatElapsed(startTime));

    if (show('lines') && hasLineDelta) {
      const add = linesAdded ?? 0;
      const del = linesRemoved ?? 0;
      if (add > 0 && del > 0) parts.push(`+${add}/-${del}`);
      else if (add > 0) parts.push(`+${add}`);
      else if (del > 0) parts.push(`-${del}`);
    }

    if (show('session')) parts.push(shortSession);
    if (rateLimitWarning) parts.push(`WARN ${rateLimitWarning}`);

    const maxWidth = Math.max(20, (columns ?? 80) - 2);
    const rawLine = parts.join(' | ') || 'idle --';
    const line = rawLine.length > maxWidth ? `${rawLine.slice(0, maxWidth - 1)}\u2026` : rawLine;

    return (
      <Box flexDirection="column" width="100%">
        <Text color={palette.border}>{'\u2500'.repeat(Math.max(1, (columns ?? 80) - 2))}</Text>
        <Box paddingX={1}>
          <Text color={chromeColor}>{line}</Text>
        </Box>
      </Box>
    );
  }

  const segments: Array<{ key: string; node: React.ReactNode }> = [];

  if (show('model')) {
    const modelLabel = clampLabel(displayModel, isVeryNarrow ? 16 : isNarrow ? 22 : 30);
    const thinkSuffix = ` ${formatThinkStatus(model, thinkingLevel, reasoningEffort, { veryNarrow: isVeryNarrow, narrow: isNarrow })}`;
    const fastSuffix = fastMode ? (isNarrow ? ' (f)' : ' (fast)') : '';
    segments.push({
      key: 'model',
      node: (
        <Text color={chromeColor} bold>{modelLabel}{thinkSuffix}{fastSuffix}</Text>
      ),
    });
  }

  if (show('mode')) {
    segments.push({ key: 'mode', node: <Text color={modeColors[mode]}>{modeLabels[mode]}</Text> });
  }

  if (mode === 'plan' && planFilePath) {
    const planBasename = planFilePath.split('/').pop() ?? planFilePath;
    segments.push({ key: 'plan', node: <Text color={palette.accent}>{planBasename}</Text> });
  }

  if (show('activity')) {
    const bgSuffix = [
      activeWatches.length > 0 ? ` watch:${activeWatches[0]!.slice(0, 32)}` : '',
    ].join('');
    if (isProcessing && stalledMs > 0) {
      const taskSuffix = runningTasks.length > 0
        ? ` \u00B7 ${runningTasks[0]!.slice(0, 50)}`
        : '';
      segments.push({ key: 'activity', node: <Text color={palette.warning}>wait {formatAge(stalledMs)}{taskSuffix}</Text> });
    } else if (isProcessing) {
      const age = agentEventAge ?? 0;
      const color = age <= 5000 ? 'green' : age <= 20000 ? 'yellow' : chromeColor;
      segments.push({ key: 'activity', node: <Text color={color}>live {formatAge(age)}{bgSuffix}</Text> });
    } else if (agentEventAge != null) {
      segments.push({ key: 'activity', node: <Text color={chromeColor}>idle {formatAge(agentEventAge)}{bgSuffix}</Text> });
    } else {
      segments.push({ key: 'activity', node: <Text color={chromeColor}>idle --{bgSuffix}</Text> });
    }
  }

  if (show('verbosity')) {
    segments.push({ key: 'verbosity', node: <Text color={chromeColor}>{shortVerbosity(verbosity)}</Text> });
  }

  if (show('branch') && branch) {
    const branchLabel = clampLabel(branch, isVeryNarrow ? 10 : isNarrow ? 16 : 24);
    segments.push({
      key: 'branch',
      node: <Text color={chromeColor}>{`\uE0A0 ${branchLabel}`}</Text>,
    });
  }

  if (show('context')) {
    segments.push({ key: 'context', node: <Text color={ctxColor ?? chromeColor}>{ctxPercent}%</Text> });
  }

  if (show('cost')) {
    segments.push({ key: 'cost', node: <Text color={chromeColor}>{costStr}</Text> });
  }

  if (show('tokens')) {
    segments.push({ key: 'tokens', node: <Text color={chromeColor}>{tokenStr}</Text> });
  }

  if (show('turns')) {
    segments.push({ key: 'turns', node: <Text color={chromeColor}>{turnCount}</Text> });
  }
  if (show('perf') && perfStatus) {
    segments.push({ key: 'perf', node: <Text color={chromeColor}>{perfStatus}</Text> });
  }

  if (show('time') && startTime) {
    segments.push({ key: 'time', node: <Text color={chromeColor}>{formatElapsed(startTime)}</Text> });
  }

  if (show('lines') && hasLineDelta) {
    const add = linesAdded ?? 0;
    const del = linesRemoved ?? 0;
    segments.push({
      key: 'lines',
      node: (
        <Box>
          {add > 0 && <Text color="green">+{add}</Text>}
          {add > 0 && del > 0 && <Text color={chromeColor}> / </Text>}
          {del > 0 && <Text color="red">-{del}</Text>}
        </Box>
      ),
    });
  }

  if (show('session')) {
    segments.push({ key: 'session', node: <Text color={chromeColor}>{shortSession}</Text> });
  }

  if (rateLimitWarning) {
    segments.push({ key: 'warning', node: <Text color="red">{'\u26A0'} {rateLimitWarning}</Text> });
  }

  // ── Overflow prevention: drop lower-priority segments until content fits ──
  // Available width = terminal columns - 2 (border) - 2 (paddingX=1 each side)
  const availWidth = Math.max(20, (columns ?? 80) - 4);

  // Priority order for dropping (lowest priority first)
  const dropOrder = ['session', 'lines', 'verbosity', 'perf', 'cost', 'tokens', 'time', 'turns', 'branch', 'context'];

  // Estimate rendered width of a segment (plain text length)
  const estimateSegmentWidth = (seg: { key: string; node: React.ReactNode }): number => {
    // Extract text from React node tree — approximate by rendering to string
    const extractText = (n: React.ReactNode): string => {
      if (n == null || typeof n === 'boolean') return '';
      if (typeof n === 'string' || typeof n === 'number') return String(n);
      if (React.isValidElement(n)) {
        const props = n.props as Record<string, unknown>;
        const children = props.children;
        if (Array.isArray(children)) return children.map(extractText).join('');
        return extractText(children as React.ReactNode);
      }
      return '';
    };
    return extractText(seg.node).length;
  };

  // Calculate total width: sum of segment widths + separators (" · " = 3 chars between each)
  const calcTotalWidth = (segs: typeof segments): number => {
    if (segs.length === 0) return 0;
    const contentWidth = segs.reduce((sum, s) => sum + estimateSegmentWidth(s), 0);
    const separatorWidth = (segs.length - 1) * 5; // " · " rendered as "  ·  " (5 chars with spaces)
    return contentWidth + separatorWidth;
  };

  let visibleSegments = [...segments];
  for (const dropKey of dropOrder) {
    if (calcTotalWidth(visibleSegments) <= availWidth) break;
    visibleSegments = visibleSegments.filter((s) => s.key !== dropKey);
  }

  return (
    <Box flexDirection="column" width="100%">
      <Text color={chromeColor}>{'\u2500'.repeat(Math.max(1, (columns ?? 80) - 2))}</Text>
      <Box paddingX={1} flexWrap="nowrap">
        {visibleSegments.map((segment, idx) => (
          <React.Fragment key={segment.key}>
            {idx > 0 && <Text color={chromeColor}> {' · '} </Text>}
            {segment.node}
          </React.Fragment>
        ))}
      </Box>
    </Box>
  );
});
StatusBar.displayName = 'StatusBar';
