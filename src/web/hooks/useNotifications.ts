import { useState, useCallback, useEffect } from 'react';

type Permission = 'default' | 'granted' | 'denied' | 'unsupported';

export function useNotifications() {
  const [permission, setPermission] = useState<Permission>(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    return Notification.permission as Permission;
  });

  // Sync permission state if changed externally
  useEffect(() => {
    if (!('Notification' in window)) return;
    // Permissions API can observe changes
    if ('permissions' in navigator) {
      navigator.permissions.query({ name: 'notifications' }).then((status) => {
        const handler = () => setPermission(status.state === 'prompt' ? 'default' : status.state as Permission);
        status.addEventListener('change', handler);
        return () => status.removeEventListener('change', handler);
      }).catch(() => {});
    }
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') {
      setPermission('granted');
      return true;
    }
    if (Notification.permission === 'denied') {
      setPermission('denied');
      return false;
    }
    const result = await Notification.requestPermission();
    setPermission(result as Permission);
    return result === 'granted';
  }, []);

  const notify = useCallback((title: string, options?: { body?: string; tag?: string }) => {
    if (permission !== 'granted') return;
    // Only show when tab is not focused
    if (document.visibilityState === 'visible') return;
    const n = new Notification(title, {
      body: options?.body,
      icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect fill='%230891b2' width='100' height='100' rx='20'/><text x='50%25' y='50%25' dominant-baseline='central' text-anchor='middle' font-size='60'>❖</text></svg>",
      tag: options?.tag || 'shizuha',
      silent: false,
    });
    // Auto-close after 5s
    setTimeout(() => n.close(), 5000);
    // Focus window on click
    n.onclick = () => {
      window.focus();
      n.close();
    };
  }, [permission]);

  return { permission, requestPermission, notify };
}
