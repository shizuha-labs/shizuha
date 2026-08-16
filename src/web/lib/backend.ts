/**
 * Backend URL — the single platform endpoint the dashboard talks to.
 *
 * One URL configures all backend services: chat (Connect), identity
 * (`/id/api/...`), tasks (Pulse), wiki, knowledge articles. The daemon at
 * `:8015` is itself a lightweight backend (mini-Connect + mini-id), so users
 * who don't want to use the real platform can point at the daemon's own host
 * and still have a working chat experience.
 *
 * - Default: `window.location.origin` → the daemon serving this dashboard.
 * - User can switch to the real platform (e.g. `https://s1.tail.shizuha.com`)
 *   in Settings → Backend URL, and the same chat UI starts talking to real
 *   shizuha-connect / shizuha-id with no protocol change.
 */

const STORAGE_KEY = 'shizuha_backend_url';

/** Default = whatever origin the dashboard was served from. */
export function defaultBackendUrl(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/** Read from localStorage, fall back to the default origin. Never returns ''. */
export function getBackendUrl(): string {
  if (typeof window === 'undefined') return '';
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && stored.length > 0) return normalize(stored);
  } catch { /* private mode etc. */ }
  return defaultBackendUrl();
}

/** True iff the user has explicitly saved a backend URL (vs. just defaulting). */
export function hasBackendUrlSet(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return !!v && v.length > 0;
  } catch {
    return false;
  }
}

/**
 * Persist a new backend URL. Pass an empty string (or call clearBackendUrl)
 * to revert to the default origin. Strips trailing slashes for consistency.
 */
export function setBackendUrl(url: string): void {
  if (typeof window === 'undefined') return;
  try {
    if (!url || !url.trim()) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, normalize(url));
  } catch { /* private mode etc. */ }
}

/** Revert to the default origin. */
export function clearBackendUrl(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* swallow */ }
}

/** True when the URL points at the daemon serving this dashboard (local mode). */
export function isLocalBackend(url: string = getBackendUrl()): boolean {
  if (typeof window === 'undefined') return true;
  return normalize(url) === normalize(window.location.origin);
}

/** Build a Connect-protocol WebSocket URL from a backend URL. */
export function connectWsUrl(path: '/connect/ws/connect/user/' | '/connect/ws/connect/agent/', token: string, url: string = getBackendUrl()): string {
  const base = normalize(url).replace(/^http/, 'ws');
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

/** Build a REST URL (e.g. `/id/api/auth/login/`, `/connect/api/conversations/`). */
export function backendApiUrl(path: string, url: string = getBackendUrl()): string {
  const base = normalize(url);
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

function normalize(url: string): string {
  return url.replace(/\/+$/, '');
}
