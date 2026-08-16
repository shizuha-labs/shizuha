import React from 'react';
import { Box, Text } from 'ink';
import { useSpinner } from '../hooks/useSpinner.js';
import { useElapsedTime } from '../hooks/useElapsedTime.js';
import type { SpinnerStyle } from '../hooks/useSpinner.js';

export type Phase = 'thinking' | 'responding' | 'tool' | 'compacting';
export const ACTIVE_SPINNER_LIMIT_MS = 30_000;

interface PhaseConfig {
  spinner: SpinnerStyle;
  color: string;
  label: string;
  /** Fast tick used while the turn is still short. */
  spinnerInterval: number;
}

const PHASE_CONFIG: Record<Phase, PhaseConfig> = {
  thinking: { spinner: 'dots', color: 'cyan', label: 'Thinking', spinnerInterval: 80 },
  responding: { spinner: 'dots', color: 'green', label: 'Responding', spinnerInterval: 80 },
  tool: { spinner: 'dots9', color: 'yellow', label: 'Running tool', spinnerInterval: 80 },
  compacting: { spinner: 'arrow3', color: 'magenta', label: 'Compacting', spinnerInterval: 120 },
};

/**
 * Derive phase from lifecycle-owned labels only. Natural-language reasoning
 * such as "Searching the cluster" is still thinking until a real tool_start
 * event changes the label to "Running <tool>...".
 */
export function derivePhase(label: string | null | undefined, streaming = false): Phase {
  if (!label) return streaming ? 'responding' : 'thinking';
  const lower = label.toLowerCase();
  if (/compact/i.test(lower)) return 'compacting';
  if (/^(?:running|executing)\b/i.test(lower)) return 'tool';
  if (streaming) return 'responding';
  return 'thinking';
}

/**
 * How fast the spinner ticks once a turn has run long.
 *
 * The elapsed timer already re-renders this component once a second for the
 * whole turn, so a 1s spinner costs nothing beyond what is already being paid —
 * while an 80ms timer running for hours genuinely does burn CPU.
 */
export const SLOW_SPINNER_INTERVAL_MS = 1_000;

export function resolveIndicatorPresentation(
  phase: Phase,
  label: string | null | undefined,
  elapsedMs: number,
): { color: string; displayLabel: string; animate: boolean; spinnerIntervalMs: number } {
  const config = PHASE_CONFIG[phase];
  const baseLabel = phase === 'responding'
    ? config.label
    : (label?.replace(/\.{2,}$/, '') ?? config.label);
  const runningLong = elapsedMs >= ACTIVE_SPINNER_LIMIT_MS;
  return {
    color: runningLong && phase === 'thinking' ? 'yellow' : config.color,
    // Operator 2026-08-05, on a 6m40s turn reading
    // "No tool call yet · Esc to cancel" with a frozen glyph:
    //
    //   maybe cortex is processing the request here but we see no animation
    //   which is bad UX .. and also "No tool call yet" is a bad UX experience
    //   for the user .. it should be something helpful and good/professional
    //
    // "No tool call yet" described an internal detail (the model has generated
    // for a while without emitting a tool call) in a way that reads like an
    // error. What a waiting user needs is: it is still working, how long it has
    // been, and how to stop. The phase label plus the elapsed timer already say
    // the first two, so the long-run state only adds the escape hatch.
    displayLabel: runningLong ? `${baseLabel} · Esc to interrupt` : baseLabel,
    // NEVER stop animating. Freezing the spinner after 30s is what made a long
    // Cortex call indistinguishable from a hung session — the glyph dropped to
    // a static fallback while the request was perfectly healthy. Slow it down
    // instead: the CPU concern the freeze was protecting against is real, but a
    // 1s tick rides the re-render the elapsed timer is already doing.
    animate: true,
    spinnerIntervalMs: runningLong ? SLOW_SPINNER_INTERVAL_MS : config.spinnerInterval,
  };
}

interface ThinkingIndicatorProps {
  label?: string | null;
  active: boolean;
  /** Text deltas are arriving; keep visible motion and name that phase. */
  streaming?: boolean;
}

/** Internal component to isolate hook calls from conditional rendering */
const AnimatedIndicator: React.FC<{ phase: Phase; label: string | null | undefined }> = ({ phase, label }) => {
  const config = PHASE_CONFIG[phase];
  const { elapsedMs, formatted } = useElapsedTime(true, phase);
  const presentation = resolveIndicatorPresentation(phase, label, elapsedMs);
  const { frame } = useSpinner(config.spinner, presentation.animate, presentation.spinnerIntervalMs);

  return (
    <Box marginLeft={2} flexShrink={0}>
      <Text color={presentation.color}>{frame}</Text>
      <Text color={presentation.color}> {presentation.displayLabel} </Text>
      <Text dimColor>{formatted}</Text>
    </Box>
  );
};

/**
 * Phase-aware thinking/progress indicator.
 * Derives phase from processingLabel regex and shows appropriate spinner + color + elapsed time.
 */
export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ label, active, streaming = false }) => {
  if (!active) return null;

  const phase = derivePhase(label, streaming);

  return <AnimatedIndicator phase={phase} label={label} />;
};
