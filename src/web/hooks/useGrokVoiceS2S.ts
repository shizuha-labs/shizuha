/**
 * Native Grok Voice speech-to-speech for Shizuha Desktop / dashboard.
 * Mic PCM ↔ same-origin /v1/voice/realtime (dashboard proxies to the agent).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { backendApiUrl } from '../lib/backend';
import { historyItems, realtimeVoiceUrl } from '../lib/grokVoiceClient';
import type { ChatMessage } from '../lib/types';

export type LiveCallState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface LiveCallError {
  kind: string;
  message: string;
  canRetry: boolean;
}

interface UseGrokVoiceS2SOptions {
  agentUsername?: string;
  messages?: ChatMessage[];
  onHeard?: (text: string) => void;
  onReply?: (text: string) => void;
}

function toPcm16(samples: Float32Array): ArrayBuffer {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]!));
    pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  return pcm.buffer;
}

async function playPcmChunk(bytes: Uint8Array, sampleRate = 24000): Promise<void> {
  const AudioContextImpl = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioContextImpl({ sampleRate });
  const frames = Math.floor(bytes.byteLength / 2);
  const buffer = ctx.createBuffer(1, frames, sampleRate);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    channel[i] = view.getInt16(i * 2, true) / 32768;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  await new Promise<void>((resolve) => {
    source.onended = () => {
      void ctx.close();
      resolve();
    };
  });
}

function playBase64Pcm(b64: string): void {
  if (!b64) return;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  void playPcmChunk(bytes);
}

export function useGrokVoiceS2S(opts: UseGrokVoiceS2SOptions = {}) {
  const [callState, setCallState] = useState<LiveCallState>('idle');
  const [callError, setCallError] = useState<LiveCallError | null>(null);
  const [muted, setMuted] = useState(false);
  const [lastHeard, setLastHeard] = useState('');
  const [lastReply, setLastReply] = useState('');
  const [s2sReady, setS2sReady] = useState<boolean | null>(null);
  const activeRef = useRef(false);
  const mutedRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const captureRef = useRef<{ stop: () => void; setMicEnabled: (on: boolean) => void } | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const teardown = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try { socket.close(); } catch { /* noop */ }
    }
  }, []);

  const sendJson = useCallback((payload: unknown) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }, []);

  useEffect(() => {
    const username = opts.agentUsername;
    if (!username) {
      setS2sReady(false);
      return;
    }
    let cancelled = false;
    void fetch(backendApiUrl(`/v1/voice/s2s?agent=${encodeURIComponent(username)}`))
      .then((res) => res.json())
      .then((body: { ok?: boolean }) => {
        if (!cancelled) setS2sReady(Boolean(body?.ok));
      })
      .catch(() => {
        if (!cancelled) setS2sReady(false);
      });
    return () => { cancelled = true; };
  }, [opts.agentUsername]);

  const connectSession = useCallback(() => {
    if (!activeRef.current) return;
    const username = optsRef.current.agentUsername || '';
    if (!username) {
      setCallError({ kind: 'not_voice_agent', message: 'Pick an agent first.', canRetry: false });
      setCallState('error');
      activeRef.current = false;
      return;
    }
    teardown();
    setCallError(null);
    setCallState('connecting');

    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let processor: ScriptProcessorNode | null = null;
    let ready = false;
    let cancelled = false;
    let micEnabled = !mutedRef.current;

    const stopCapture = () => {
      cancelled = true;
      try { source?.disconnect(); } catch { /* noop */ }
      try { processor?.disconnect(); } catch { /* noop */ }
      source = null;
      processor = null;
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
      void context?.close();
      context = null;
    };
    captureRef.current = {
      stop: stopCapture,
      setMicEnabled: (on) => {
        micEnabled = !!on;
        stream?.getAudioTracks().forEach((track) => { track.enabled = micEnabled; });
      },
    };

    const socket = new WebSocket(realtimeVoiceUrl(username));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;

    socket.onopen = () => {
      if (cancelled || !activeRef.current) return;
      socket.send(JSON.stringify({
        type: 'start',
        sample_rate: 24000,
        history: historyItems(optsRef.current.messages),
      }));
    };

    socket.onmessage = (event) => {
      if (cancelled || !activeRef.current) return;
      if (typeof event.data !== 'string') {
        setCallState('speaking');
        void playPcmChunk(new Uint8Array(event.data as ArrayBuffer));
        return;
      }
      let msg: { type?: string; message?: string; code?: string; delta?: string; transcript?: string; text?: string; audio?: string };
      try { msg = JSON.parse(event.data); } catch { return; }
      const type = String(msg.type || '');
      if (type === 'ready' || type === 'session.updated') {
        setCallState(mutedRef.current ? 'listening' : 'listening');
        ready = true;
        return;
      }
      if (type === 'error') {
        activeRef.current = false;
        teardown();
        setCallError({
          kind: msg.code || 'stream_unavailable',
          message: msg.message || 'Live voice session failed.',
          canRetry: msg.code !== 'out_of_credits',
        });
        setCallState('error');
        return;
      }
      if (type === 'input_audio_transcription.completed' || type === 'conversation.item.input_audio_transcription.completed') {
        const text = String(msg.transcript || msg.text || '').trim();
        if (text) {
          setLastHeard(text);
          optsRef.current.onHeard?.(text);
          setCallState('thinking');
        }
        return;
      }
      if (
        type === 'response.output_audio_transcript.delta'
        || type === 'response.audio_transcript.delta'
        || type === 'response.output_text.delta'
      ) {
        const text = String(msg.delta || msg.text || '');
        if (text) setLastReply((prev) => `${prev}${text}`);
        setCallState('speaking');
        return;
      }
      if (
        type === 'response.output_audio_transcript.done'
        || type === 'response.audio_transcript.done'
        || type === 'response.output_text.done'
      ) {
        const text = String(msg.transcript || msg.text || '').trim();
        if (text) {
          setLastReply(text);
          optsRef.current.onReply?.(text);
        }
        return;
      }
      if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
        setCallState('speaking');
        playBase64Pcm(String(msg.delta || msg.audio || ''));
        return;
      }
      if (type === 'response.done' || type === 'response.completed') {
        if (!mutedRef.current) setCallState('listening');
      }
    };

    socket.onerror = () => {
      if (cancelled || !activeRef.current) return;
      setCallError({ kind: 'stream_unavailable', message: 'Could not reach the Live voice socket.', canRetry: true });
      setCallState('error');
    };
    socket.onclose = () => {
      if (cancelled || !activeRef.current) return;
      setCallError({ kind: 'stream_unavailable', message: 'Live voice disconnected.', canRetry: true });
      setCallState('error');
    };

    void (async () => {
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        if (cancelled || !activeRef.current) {
          acquired.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = acquired;
        const AudioContextImpl = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        context = new AudioContextImpl({ sampleRate: 24000 });
        await context.resume();
        source = context.createMediaStreamSource(stream);
        processor = context.createScriptProcessor(2048, 1, 1);
        const mute = context.createGain();
        mute.gain.value = 0;
        processor.connect(mute);
        mute.connect(context.destination);
        processor.onaudioprocess = (audioEvent) => {
          if (cancelled || socket.readyState !== WebSocket.OPEN || !ready) return;
          const samples = audioEvent.inputBuffer.getChannelData(0);
          socket.send(micEnabled ? toPcm16(samples) : new Int16Array(samples.length).buffer);
        };
        source.connect(processor);
      } catch (error) {
        const denied = String((error as Error)?.name || '').includes('NotAllowed')
          || String((error as Error)?.message || '').toLowerCase().includes('permission');
        activeRef.current = false;
        teardown();
        setCallError({
          kind: denied ? 'permission_denied' : 'no_mic',
          message: denied
            ? 'Microphone permission denied. Allow mic access, then try Live again.'
            : 'No microphone found. Connect a mic or type instead.',
          canRetry: false,
        });
        setCallState('error');
      }
    })();
  }, [teardown]);

  const startCall = useCallback(() => {
    if (activeRef.current) return;
    activeRef.current = true;
    mutedRef.current = false;
    setMuted(false);
    setLastHeard('');
    setLastReply('');
    setCallError(null);
    connectSession();
  }, [connectSession]);

  const endCall = useCallback(() => {
    activeRef.current = false;
    mutedRef.current = false;
    teardown();
    setMuted(false);
    setCallError(null);
    setCallState('idle');
  }, [teardown]);

  const toggleMute = useCallback(() => {
    if (!activeRef.current) return;
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    captureRef.current?.setMicEnabled(!next);
    sendJson({ type: 'mic', enabled: !next });
  }, [sendJson]);

  const retryCall = useCallback(() => {
    endCall();
    startCall();
  }, [endCall, startCall]);

  useEffect(() => () => {
    activeRef.current = false;
    teardown();
  }, [teardown]);

  return {
    callState,
    callError,
    muted,
    lastHeard,
    lastReply,
    s2sReady,
    transport: 's2s' as const,
    startCall,
    endCall,
    retryCall,
    toggleMute,
    isCallActive: () => activeRef.current,
  };
}

export { historyItems, realtimeVoiceUrl } from '../lib/grokVoiceClient';
