/**
 * useVoiceCall — hook for initiating Twilio voice calls from the dashboard.
 *
 * Not full WebRTC streaming. Uses a simpler model:
 * - Agent sends TTS via Twilio call to a phone number
 * - Receives transcription back via Twilio
 * - Dashboard shows call status in real-time
 *
 * Requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 * env vars on the daemon side. If not configured, the hook reports
 * `available: false` and the UI hides the phone button.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

export type CallState = 'idle' | 'connecting' | 'ringing' | 'active' | 'ended' | 'error';

interface UseVoiceCallOptions {
  /** Base URL for the dashboard API */
  apiBase?: string;
  /** Session cookie for auth */
  sessionCookie?: string;
}

interface UseVoiceCallReturn {
  /** Current call state */
  state: CallState;
  /** Whether Twilio is configured on the backend */
  available: boolean;
  /** Whether currently in a call (connecting, ringing, or active) */
  inCall: boolean;
  /** Call duration in seconds (updated every second while active) */
  duration: number;
  /** The phone number being called */
  phoneNumber: string | null;
  /** Error message (if state === 'error') */
  error: string | null;
  /** Whether the microphone is muted */
  muted: boolean;
  /** Initiate a call to a phone number */
  call: (phoneNumber: string) => Promise<void>;
  /** Hang up the current call */
  hangup: () => Promise<void>;
  /** Toggle mute */
  toggleMute: () => void;
  /** Check if Twilio is available */
  checkAvailability: () => Promise<void>;
}

export function useVoiceCall(options: UseVoiceCallOptions = {}): UseVoiceCallReturn {
  const { apiBase = '', sessionCookie } = options;

  const [state, setState] = useState<CallState>('idle');
  const [available, setAvailable] = useState(false);
  const [duration, setDuration] = useState(0);
  const [phoneNumber, setPhoneNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const durationTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const callSidRef = useRef<string | null>(null);

  const headers = useCallback((): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (sessionCookie) h['Cookie'] = sessionCookie;
    return h;
  }, [sessionCookie]);

  const inCall = state === 'connecting' || state === 'ringing' || state === 'active';

  // Check if Twilio is configured
  const checkAvailability = useCallback(async () => {
    try {
      const res = await fetch(`${apiBase}/v1/voice/status`, {
        headers: headers(),
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json() as { configured?: boolean };
        setAvailable(data.configured === true);
      } else {
        setAvailable(false);
      }
    } catch {
      setAvailable(false);
    }
  }, [apiBase, headers]);

  // Check availability on mount
  useEffect(() => {
    checkAvailability();
  }, [checkAvailability]);

  // Duration timer
  useEffect(() => {
    if (state === 'active') {
      durationTimer.current = setInterval(() => {
        setDuration((d) => d + 1);
      }, 1000);
    } else {
      if (durationTimer.current) {
        clearInterval(durationTimer.current);
        durationTimer.current = null;
      }
    }
    return () => {
      if (durationTimer.current) clearInterval(durationTimer.current);
    };
  }, [state]);

  // Poll call status while in a call
  useEffect(() => {
    if (!inCall || !callSidRef.current) return;

    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch(`${apiBase}/v1/voice/status?callSid=${callSidRef.current}`, {
          headers: headers(),
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json() as { callStatus?: string };
          if (data.callStatus === 'in-progress' && state !== 'active') {
            setState('active');
          } else if (data.callStatus === 'ringing' && state !== 'ringing') {
            setState('ringing');
          } else if (['completed', 'canceled', 'busy', 'no-answer', 'failed'].includes(data.callStatus ?? '')) {
            setState(data.callStatus === 'failed' ? 'error' : 'ended');
            if (data.callStatus === 'failed') setError('Call failed');
            callSidRef.current = null;
          }
        }
      } catch {
        // Ignore poll errors
      }
    }, 2000);

    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [inCall, apiBase, headers, state]);

  const call = useCallback(async (number: string) => {
    setError(null);
    setDuration(0);
    setPhoneNumber(number);
    setState('connecting');
    setMuted(false);

    try {
      const res = await fetch(`${apiBase}/v1/voice/call`, {
        method: 'POST',
        headers: headers(),
        credentials: 'include',
        body: JSON.stringify({ phoneNumber: number }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }

      const data = await res.json() as { callSid?: string };
      callSidRef.current = data.callSid ?? null;
      setState('ringing');
    } catch (err) {
      setState('error');
      setError((err as Error).message);
    }
  }, [apiBase, headers]);

  const hangup = useCallback(async () => {
    if (!callSidRef.current) {
      setState('idle');
      return;
    }

    try {
      await fetch(`${apiBase}/v1/voice/hangup`, {
        method: 'POST',
        headers: headers(),
        credentials: 'include',
        body: JSON.stringify({ callSid: callSidRef.current }),
      });
    } catch {
      // Best-effort
    }

    callSidRef.current = null;
    setState('ended');
    setTimeout(() => setState('idle'), 2000);
  }, [apiBase, headers]);

  const toggleMute = useCallback(() => {
    setMuted((m) => !m);
  }, []);

  return {
    state,
    available,
    inCall,
    duration,
    phoneNumber,
    error,
    muted,
    call,
    hangup,
    toggleMute,
    checkAvailability,
  };
}

/** Format seconds to mm:ss */
export function formatCallDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
