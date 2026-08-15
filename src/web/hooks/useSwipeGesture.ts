import { useEffect, useRef } from 'react';

interface SwipeOptions {
  onSwipeRight: () => void;
  onSwipeLeft: () => void;
  edgeThreshold?: number;   // px from left edge to start tracking (default 20)
  swipeMinDistance?: number; // minimum px for a swipe (default 60)
}

/**
 * Lightweight swipe gesture hook for mobile sidebar open/close.
 * Only active on viewports < 640px (matches Tailwind sm: breakpoint).
 */
export function useSwipeGesture({
  onSwipeRight,
  onSwipeLeft,
  edgeThreshold = 20,
  swipeMinDistance = 60,
}: SwipeOptions): void {
  const startRef = useRef<{ x: number; y: number; fromEdge: boolean } | null>(null);

  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (window.innerWidth >= 640) return; // desktop — skip
      const touch = e.touches[0];
      if (!touch) return;
      startRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        fromEdge: touch.clientX <= edgeThreshold,
      };
    };

    const onTouchEnd = (e: TouchEvent) => {
      const start = startRef.current;
      startRef.current = null;
      if (!start) return;

      const touch = e.changedTouches[0];
      if (!touch) return;

      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;

      // Must be primarily horizontal
      if (Math.abs(dx) < Math.abs(dy)) return;
      if (Math.abs(dx) < swipeMinDistance) return;

      if (dx > 0 && start.fromEdge) {
        onSwipeRight();
      } else if (dx < 0) {
        onSwipeLeft();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchend', onTouchEnd);
    };
  }, [onSwipeRight, onSwipeLeft, edgeThreshold, swipeMinDistance]);
}
