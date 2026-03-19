/**
 * Device authentication hook — manages device token in localStorage.
 *
 * Flow:
 * 1. On mount, check /v1/devices/status to see if pairing is required
 * 2. If no devices are paired on the server, skip auth (first-time setup)
 * 3. If devices exist, check localStorage for a saved token
 * 4. If token exists, assume paired (401 responses will trigger re-pair)
 * 5. If no token, show pairing screen
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const TOKEN_KEY = 'shizuha_device_token';
const DEVICE_ID_KEY = 'shizuha_device_id';
const DEVICE_NAME_KEY = 'shizuha_device_name';

export type AuthState = 'loading' | 'authenticated' | 'needs_pairing';

export interface DeviceAuth {
  state: AuthState;
  token: string | null;
  deviceId: string | null;
  deviceName: string | null;
  /** Returns auth headers to include in fetch requests */
  authHeaders: () => Record<string, string>;
  /** Pair with a code — resolves with success, rejects on error */
  pair: (code: string, deviceName?: string) => Promise<void>;
  /** Clear stored credentials and go back to pairing */
  unpair: () => void;
  /** Error message from last pair attempt */
  pairError: string | null;
  /** Whether a pair request is in flight */
  isPairing: boolean;
}

function detectPlatform(): string {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Mac/.test(ua)) return 'macos';
  if (/Win/.test(ua)) return 'windows';
  if (/Linux/.test(ua)) return 'linux';
  return 'web';
}

export function useDeviceAuth(): DeviceAuth {
  const [state, setState] = useState<AuthState>('loading');
  const [token, setToken] = useState<string | null>(() => localStorage.getItem(TOKEN_KEY));
  const [deviceId, setDeviceId] = useState<string | null>(() => localStorage.getItem(DEVICE_ID_KEY));
  const [deviceName, setDeviceName] = useState<string | null>(() => localStorage.getItem(DEVICE_NAME_KEY));
  const [pairError, setPairError] = useState<string | null>(null);
  const [isPairing, setIsPairing] = useState(false);
  const checkedRef = useRef(false);

  // Check if pairing is required on mount
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    async function checkStatus() {
      try {
        const res = await fetch('/v1/devices/status');
        if (!res.ok) {
          // Server error — assume no pairing needed (graceful degradation)
          setState('authenticated');
          return;
        }
        const data = await res.json();
        if (!data.pairingRequired) {
          // No devices paired yet — first-time setup, no auth needed
          setState('authenticated');
          return;
        }
        // Devices exist — check if we have a token
        if (token) {
          // Verify token is still valid with a lightweight request
          const verifyRes = await fetch('/v1/devices', {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (verifyRes.ok) {
            setState('authenticated');
          } else if (verifyRes.status === 401) {
            // Token revoked or invalid
            localStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(DEVICE_ID_KEY);
            localStorage.removeItem(DEVICE_NAME_KEY);
            setToken(null);
            setDeviceId(null);
            setDeviceName(null);
            setState('needs_pairing');
          } else {
            // Other error — assume OK for now
            setState('authenticated');
          }
        } else {
          setState('needs_pairing');
        }
      } catch {
        // Network error — assume authenticated (server might be localhost)
        setState('authenticated');
      }
    }

    checkStatus();
  }, [token]);

  const authHeaders = useCallback((): Record<string, string> => {
    if (!token) return {};
    return { Authorization: `Bearer ${token}` };
  }, [token]);

  const pair = useCallback(async (code: string, name?: string) => {
    setIsPairing(true);
    setPairError(null);

    const resolvedName = name || `${detectPlatform()} browser`;

    try {
      const res = await fetch('/v1/devices/pair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          deviceName: resolvedName,
          platform: detectPlatform(),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Pairing failed (${res.status})`);
      }

      const data = await res.json();
      const newToken = data.token as string;
      const newDeviceId = data.deviceId as string;
      const newDeviceName = data.deviceName as string;

      localStorage.setItem(TOKEN_KEY, newToken);
      localStorage.setItem(DEVICE_ID_KEY, newDeviceId);
      localStorage.setItem(DEVICE_NAME_KEY, newDeviceName);

      setToken(newToken);
      setDeviceId(newDeviceId);
      setDeviceName(newDeviceName);
      setState('authenticated');
    } catch (e) {
      setPairError((e as Error).message);
      throw e;
    } finally {
      setIsPairing(false);
    }
  }, []);

  const unpair = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
    localStorage.removeItem(DEVICE_NAME_KEY);
    setToken(null);
    setDeviceId(null);
    setDeviceName(null);
    setState('needs_pairing');
    checkedRef.current = false;
  }, []);

  return {
    state,
    token,
    deviceId,
    deviceName,
    authHeaders,
    pair,
    unpair,
    pairError,
    isPairing,
  };
}
