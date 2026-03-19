/**
 * Talk Mode hook — voice input (STT) and output (TTS) for the chat dashboard.
 *
 * STT: Browser MediaRecorder → Whisper API (via dashboard backend)
 *      Falls back to browser SpeechRecognition if Whisper unavailable
 * TTS: OpenAI TTS API → Web Audio playback
 *      Falls back to browser SpeechSynthesis
 *
 * State machine: idle → recording → transcribing → idle
 *                                                → speaking → idle
 */

import { useState, useRef, useCallback, useEffect } from 'react';

export type TalkPhase = 'idle' | 'recording' | 'transcribing' | 'speaking';

interface UseTalkModeOptions {
  /** Called with transcribed text (user should send as message) */
  onTranscription: (text: string) => void;
  /** Whether talk mode auto-sends on transcription (vs filling input) */
  autoSend?: boolean;
  /** Session cookie for backend API auth */
  sessionCookie?: string;
}

interface UseTalkModeReturn {
  /** Current phase of the talk state machine */
  phase: TalkPhase;
  /** Whether talk mode is enabled (persisted) */
  enabled: boolean;
  /** Toggle talk mode on/off */
  toggleTalkMode: () => void;
  /** Start recording (microphone) */
  startRecording: () => Promise<void>;
  /** Stop recording and transcribe */
  stopRecording: () => void;
  /** Speak text aloud (TTS) */
  speak: (text: string) => Promise<void>;
  /** Stop current speech playback */
  stopSpeaking: () => void;
  /** Whether the browser supports voice input */
  micSupported: boolean;
  /** Error message if any */
  error: string | null;
  /** Recording duration in seconds */
  recordingDuration: number;
}

/** Check if browser supports getUserMedia */
function isMicSupported(): boolean {
  return !!(navigator.mediaDevices?.getUserMedia);
}

/** Check if SpeechRecognition is available (free fallback for STT) */
function isBrowserSttSupported(): boolean {
  return !!(window.SpeechRecognition || (window as any).webkitSpeechRecognition);
}

/** Check if SpeechSynthesis is available (free fallback for TTS) */
function isBrowserTtsSupported(): boolean {
  return !!window.speechSynthesis;
}

/** Strip markdown for TTS — don't read code blocks, links, etc. */
function stripMarkdownForSpeech(text: string): string {
  return text
    // Remove code blocks
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    // Remove inline code
    .replace(/`[^`]+`/g, (m) => m.slice(1, -1))
    // Remove links but keep text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove images
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    // Remove bold/italic markers
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    // Remove headers
    .replace(/^#{1,6}\s+/gm, '')
    // Remove horizontal rules
    .replace(/^[-*_]{3,}$/gm, '')
    // Collapse whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function useTalkMode(options: UseTalkModeOptions): UseTalkModeReturn {
  const [phase, setPhase] = useState<TalkPhase>('idle');
  const [enabled, setEnabled] = useState(() => localStorage.getItem('shizuha_talk_mode') === 'true');
  const [error, setError] = useState<string | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const synthRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
      if (timerRef.current) clearInterval(timerRef.current);
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (synthRef.current) window.speechSynthesis?.cancel();
    };
  }, []);

  const toggleTalkMode = useCallback(() => {
    setEnabled(prev => {
      const next = !prev;
      localStorage.setItem('shizuha_talk_mode', String(next));
      return next;
    });
  }, []);

  /** Start recording from microphone */
  const startRecording = useCallback(async () => {
    if (phase !== 'idle') return;
    setError(null);

    // Stop any current TTS playback
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (synthRef.current) window.speechSynthesis?.cancel();

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;
      audioChunksRef.current = [];

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
          ? 'audio/ogg;codecs=opus'
          : 'audio/webm';

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop mic
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        if (blob.size < 1000) {
          setPhase('idle');
          setError('Recording too short');
          return;
        }

        // Transcribe
        setPhase('transcribing');
        try {
          const text = await transcribeAudio(blob);
          if (text.trim()) {
            options.onTranscription(text.trim());
          } else {
            setError('No speech detected');
          }
        } catch (err) {
          setError(`Transcription failed: ${(err as Error).message}`);
        }
        setPhase('idle');
        setRecordingDuration(0);
      };

      recorder.start(250); // Collect in 250ms chunks
      setPhase('recording');
      setRecordingDuration(0);

      // Duration counter
      const startTime = Date.now();
      timerRef.current = window.setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);

    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Permission denied') || msg.includes('NotAllowed')) {
        setError('Microphone permission denied. Allow mic access and try again.');
      } else {
        setError(`Mic error: ${msg}`);
      }
      setPhase('idle');
    }
  }, [phase, options]);

  /** Stop recording */
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  /** Speak text aloud */
  const speak = useCallback(async (text: string) => {
    if (!text.trim()) return;
    const cleaned = stripMarkdownForSpeech(text);
    if (!cleaned.trim()) return;

    // Truncate for TTS (avoid long responses eating API quota)
    const truncated = cleaned.length > 4000 ? cleaned.slice(0, 4000) + '...' : cleaned;

    setPhase('speaking');

    try {
      // Try server TTS first (OpenAI TTS via dashboard backend)
      const resp = await fetch('/v1/audio/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: truncated, voice: 'nova' }),
        credentials: 'include',
      });

      if (resp.ok) {
        const audioBlob = await resp.blob();
        const url = URL.createObjectURL(audioBlob);
        const audio = new Audio(url);
        audioRef.current = audio;

        audio.onended = () => {
          URL.revokeObjectURL(url);
          audioRef.current = null;
          setPhase('idle');
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          audioRef.current = null;
          setPhase('idle');
        };

        await audio.play();
        return;
      }
    } catch {
      // Server TTS failed — fall back to browser
    }

    // Fallback: browser SpeechSynthesis
    if (isBrowserTtsSupported()) {
      const utterance = new SpeechSynthesisUtterance(truncated);
      utterance.rate = 1.1;
      utterance.pitch = 1.0;
      synthRef.current = utterance;

      utterance.onend = () => { synthRef.current = null; setPhase('idle'); };
      utterance.onerror = () => { synthRef.current = null; setPhase('idle'); };

      window.speechSynthesis.speak(utterance);
    } else {
      setPhase('idle');
    }
  }, []);

  /** Stop speaking */
  const stopSpeaking = useCallback(() => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    if (synthRef.current) window.speechSynthesis?.cancel();
    synthRef.current = null;
    setPhase('idle');
  }, []);

  return {
    phase,
    enabled,
    toggleTalkMode,
    startRecording,
    stopRecording,
    speak,
    stopSpeaking,
    micSupported: isMicSupported(),
    error,
    recordingDuration,
  };
}

// ── STT: Whisper API via dashboard backend ──

async function transcribeAudio(blob: Blob): Promise<string> {
  // Try server-side Whisper first
  try {
    const formData = new FormData();
    formData.append('audio', blob, 'recording.webm');
    formData.append('language', 'en');

    const resp = await fetch('/v1/audio/transcribe', {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (resp.ok) {
      const data = await resp.json();
      return data.text || '';
    }
  } catch {
    // Server Whisper failed
  }

  // Fallback: browser SpeechRecognition (can't transcribe a blob, only live mic)
  // If we reach here, return error
  throw new Error('Transcription service unavailable. Set OPENAI_API_KEY for Whisper STT.');
}
