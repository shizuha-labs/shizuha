import { useState, useEffect, useRef } from 'react';

export interface TerminalSize {
  rows: number;
  columns: number;
}

/** Hook returning terminal dimensions, debounced on resize.
 *  During rapid resizing (zoom in/out), updates are suppressed for 80ms
 *  after the last resize event to avoid rendering stale intermediate layouts. */
export function useTerminalSize(): TerminalSize {
  const [size, setSize] = useState<TerminalSize>({
    rows: process.stdout.rows ?? 24,
    columns: process.stdout.columns ?? 80,
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onResize = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        const next = {
          rows: process.stdout.rows ?? 24,
          columns: process.stdout.columns ?? 80,
        };
        setSize((prev) => {
          if (prev.rows === next.rows && prev.columns === next.columns) {
            return prev;
          }
          return next;
        });
      }, 80);
    };
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.removeListener('resize', onResize);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return size;
}
