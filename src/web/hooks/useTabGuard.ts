import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Single-tab enforcement (WhatsApp Web style).
 *
 * Only one dashboard tab can be active at a time. When a second tab opens,
 * it shows "Dashboard is open in another tab" with a "Use here" button.
 * Clicking "Use here" claims the lock and the other tab shows the blocked
 * screen.
 *
 * Uses BroadcastChannel for instant cross-tab messaging + localStorage
 * heartbeat as a fallback (detects crashed tabs that didn't release).
 */

const CHANNEL_NAME = 'shizuha-tab-guard';
const LOCK_KEY = 'shizuha_tab_lock';
const HEARTBEAT_INTERVAL = 2000; // ms
const HEARTBEAT_TIMEOUT = 6000; // ms — tab considered dead if no heartbeat for this long

interface TabLock {
  tabId: string;
  timestamp: number;
}

export function useTabGuard() {
  const tabId = useRef(
    `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const [isActive, setIsActive] = useState<boolean | null>(null); // null = checking
  const channelRef = useRef<BroadcastChannel | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const writeLock = useCallback(() => {
    const lock: TabLock = { tabId: tabId.current, timestamp: Date.now() };
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify(lock));
    } catch { /* ignore */ }
  }, []);

  const readLock = useCallback((): TabLock | null => {
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }, []);

  const startHeartbeat = useCallback(() => {
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    heartbeatRef.current = setInterval(() => {
      writeLock();
    }, HEARTBEAT_INTERVAL);
  }, [writeLock]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  // Attempt to claim the active tab
  const claim = useCallback(() => {
    writeLock();
    setIsActive(true);
    startHeartbeat();

    // Notify other tabs they've been superseded
    try {
      channelRef.current?.postMessage({ type: 'claim', tabId: tabId.current });
    } catch { /* ignore */ }
  }, [writeLock, startHeartbeat]);

  // Initialize on mount
  useEffect(() => {
    // Set up BroadcastChannel
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channelRef.current = channel;
    } catch {
      // BroadcastChannel not supported — fall back to localStorage only
    }

    // Check if another tab holds the lock
    const existing = readLock();
    const isStale = !existing || (Date.now() - existing.timestamp > HEARTBEAT_TIMEOUT);

    if (isStale) {
      // No active tab or stale heartbeat — claim it
      claim();
    } else {
      // Another tab is active — we're blocked
      setIsActive(false);
    }

    // Listen for messages from other tabs
    if (channel) {
      channel.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === 'claim' && msg.tabId !== tabId.current) {
          // Another tab claimed the lock — we're now blocked
          stopHeartbeat();
          setIsActive(false);
        }
      };
    }

    // Also listen for localStorage changes (fallback for browsers without BroadcastChannel)
    const onStorage = (e: StorageEvent) => {
      if (e.key !== LOCK_KEY) return;
      try {
        const lock: TabLock = e.newValue ? JSON.parse(e.newValue) : null;
        if (lock && lock.tabId !== tabId.current) {
          // Another tab took the lock
          stopHeartbeat();
          setIsActive(false);
        }
      } catch { /* ignore */ }
    };
    window.addEventListener('storage', onStorage);

    // Release lock on page refresh/close — must use beforeunload because
    // React's useEffect cleanup fires AFTER the new page's mount on refresh,
    // causing the new page to see a "fresh" lock from the old page and show
    // the "open in another tab" screen.
    const onBeforeUnload = () => {
      const lock = readLock();
      if (lock?.tabId === tabId.current) {
        try { localStorage.removeItem(LOCK_KEY); } catch { /* ignore */ }
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // Clean up on unmount (tab close / SPA navigation)
    return () => {
      stopHeartbeat();
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('beforeunload', onBeforeUnload);
      if (channel) {
        try { channel.close(); } catch { /* ignore */ }
      }
      // Release lock if we're the holder
      const lock = readLock();
      if (lock?.tabId === tabId.current) {
        try { localStorage.removeItem(LOCK_KEY); } catch { /* ignore */ }
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    /** null = still checking, true = this tab is active, false = blocked */
    isActive,
    /** Claim the active tab (steals from other tab) */
    claim,
  };
}
