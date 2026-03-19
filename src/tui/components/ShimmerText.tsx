import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { shouldAnimateTUI } from '../utils/terminal.js';

interface ShimmerTextProps {
  children: string;
  /** ms between position updates (default 80) */
  interval?: number;
  /** Half-width of highlight band in characters (default 5) */
  bandWidth?: number;
}

/**
 * Animated shimmer text — a greyscale highlight wave sweeps left-to-right.
 * Cosine-shaped band blending from dim to bold.
 * Base text is dim; the highlight band is bold (bright white on dark terminals).
 */
export const ShimmerText: React.FC<ShimmerTextProps> = ({
  children,
  interval = 80,
  bandWidth = 5,
}) => {
  const text = children;
  const padding = 10;
  const period = text.length + padding * 2;
  const [pos, setPos] = useState(0);
  const animate = shouldAnimateTUI();

  useEffect(() => {
    if (!text || !animate) return;
    const timer = setInterval(() => {
      setPos((p) => (p + 1) % period);
    }, interval);
    return () => clearInterval(timer);
  }, [period, interval, text, animate]);

  if (!text) return null;
  if (!animate) return <Text dimColor>{text}</Text>;

  const sweepPos = pos - padding;

  // Split into segments: dim | bold | dim
  const bandStart = Math.max(0, sweepPos - bandWidth);
  const bandEnd = Math.min(text.length, sweepPos + bandWidth + 1);

  const before = text.slice(0, bandStart);
  const band = text.slice(bandStart, bandEnd);
  const after = text.slice(bandEnd);

  return (
    <Text>
      {before && <Text dimColor>{before}</Text>}
      {band && <Text bold>{band}</Text>}
      {after && <Text dimColor>{after}</Text>}
    </Text>
  );
};
