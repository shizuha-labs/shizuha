import React from 'react';
import { Box, Text } from 'ink';
import { useSpinner } from '../hooks/useSpinner.js';
import { useElapsedTime } from '../hooks/useElapsedTime.js';
import type { SpinnerStyle } from '../hooks/useSpinner.js';

type Phase = 'thinking' | 'tool' | 'compacting';

interface PhaseConfig {
  spinner: SpinnerStyle;
  color: string;
  label: string;
}

const PHASE_CONFIG: Record<Phase, PhaseConfig> = {
  thinking: { spinner: 'dots', color: 'cyan', label: 'Thinking' },
  tool: { spinner: 'dots9', color: 'yellow', label: 'Running tool' },
  compacting: { spinner: 'arrow3', color: 'magenta', label: 'Compacting' },
};

/** Derive phase from the processingLabel string */
function derivePhase(label: string | null | undefined): Phase {
  if (!label) return 'thinking';
  const lower = label.toLowerCase();
  if (/compact/i.test(lower)) return 'compacting';
  if (/running|executing|reading|writing|searching|fetching|editing/i.test(lower)) return 'tool';
  return 'thinking';
}

interface ThinkingIndicatorProps {
  label?: string | null;
  active: boolean;
}

/** Internal component to isolate hook calls from conditional rendering */
const AnimatedIndicator: React.FC<{ phase: Phase; label: string | null | undefined }> = ({ phase, label }) => {
  const config = PHASE_CONFIG[phase];
  const { frame } = useSpinner(config.spinner, true);
  const { formatted } = useElapsedTime(true, phase);

  const displayLabel = label?.replace(/\.{2,}$/, '') ?? config.label;

  return (
    <Box marginLeft={2}>
      <Text color={config.color}>{frame}</Text>
      <Text color={config.color}> {displayLabel} </Text>
      <Text dimColor>{formatted}</Text>
    </Box>
  );
};

/**
 * Phase-aware thinking/progress indicator.
 * Derives phase from processingLabel regex and shows appropriate spinner + color + elapsed time.
 */
export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ label, active }) => {
  if (!active) return null;

  const phase = derivePhase(label);

  return <AnimatedIndicator phase={phase} label={label} />;
};
