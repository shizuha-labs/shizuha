import { useState, useEffect, useRef } from 'react';

/** Format elapsed milliseconds into a human-readable string */
export function formatElapsed(ms: number): string {
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Elapsed time tracker hook.
 * Ticks once per second. Sub-second repaints force Ink to reconcile the whole
 * transcript and become pathological in multi-hour sessions.
 */
export function useElapsedTime(active: boolean, resetKey?: string): { elapsedMs: number; formatted: string } {
  const startRef = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const tickMs = 1000;

  // Reset on resetKey change
  useEffect(() => {
    startRef.current = Date.now();
    setElapsedMs(0);
  }, [resetKey]);

  useEffect(() => {
    if (!active) {
      return;
    }
    startRef.current = Date.now();
    setElapsedMs(0);

    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startRef.current);
    }, tickMs);
    return () => clearInterval(timer);
  }, [active, tickMs]);

  return { elapsedMs, formatted: formatElapsed(elapsedMs) };
}
