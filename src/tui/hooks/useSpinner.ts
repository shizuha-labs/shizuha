import { useState, useEffect } from 'react';
import { shouldAnimateTUI } from '../utils/terminal.js';

/** Spinner style definitions */
export interface SpinnerDef {
  frames: string[];
  interval: number;
  fallback: string; // static glyph for tmux
}

export const SPINNERS: Record<string, SpinnerDef> = {
  dots: {
    frames: ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'],
    interval: 80,
    fallback: '*',
  },
  dots9: {
    frames: ['\u28B9', '\u28BA', '\u28BC', '\u28F8', '\u28C7', '\u2967', '\u2957', '\u294F'],
    interval: 80,
    fallback: '#',
  },
  arrow3: {
    frames: ['\u25B9\u25B9\u25B9\u25B9\u25B9', '\u25B8\u25B9\u25B9\u25B9\u25B9', '\u25B9\u25B8\u25B9\u25B9\u25B9', '\u25B9\u25B9\u25B8\u25B9\u25B9', '\u25B9\u25B9\u25B9\u25B8\u25B9', '\u25B9\u25B9\u25B9\u25B9\u25B8'],
    interval: 120,
    fallback: '>',
  },
};

export type SpinnerStyle = keyof typeof SPINNERS;

/**
 * Unified spinner hook. Returns the current frame string.
 */
export function useSpinner(style: SpinnerStyle, active: boolean): { frame: string } {
  const [frameIndex, setFrameIndex] = useState(0);
  const spinner = SPINNERS[style] ?? SPINNERS.dots!;
  const animate = active && shouldAnimateTUI();

  useEffect(() => {
    if (!animate) {
      setFrameIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setFrameIndex((prev) => (prev + 1) % spinner.frames.length);
    }, spinner.interval);
    return () => clearInterval(timer);
  }, [animate, spinner.frames.length, spinner.interval]);

  if (!animate) {
    return { frame: spinner.fallback };
  }
  return { frame: spinner.frames[frameIndex] ?? spinner.fallback };
}
