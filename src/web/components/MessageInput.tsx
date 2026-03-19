import { useState, useRef, useCallback, useEffect } from 'react';
import type { ImageAttachment } from '../lib/types';

import type { TalkPhase } from '../hooks/useTalkMode';
import type { CallState } from '../hooks/useVoiceCall';

interface MessageInputProps {
  onSend: (content: string, images?: ImageAttachment[]) => void;
  onCancel?: () => void;
  disabled?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
  /** Talk mode state */
  talkPhase?: TalkPhase;
  talkEnabled?: boolean;
  onToggleTalk?: () => void;
  onStartRecording?: () => void;
  onStopRecording?: () => void;
  onStopSpeaking?: () => void;
  recordingDuration?: number;
  micSupported?: boolean;
  talkError?: string | null;
  /** Voice call state */
  voiceCallAvailable?: boolean;
  voiceCallState?: CallState;
  voiceCallDuration?: number;
  onStartVoiceCall?: () => void;
  onHangupVoiceCall?: () => void;
}

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function MessageInput({
  onSend,
  onCancel,
  disabled,
  isStreaming,
  placeholder = 'Type a message...',
  talkPhase = 'idle',
  talkEnabled = false,
  onToggleTalk,
  onStartRecording,
  onStopRecording,
  onStopSpeaking,
  recordingDuration = 0,
  micSupported = false,
  talkError,
  voiceCallAvailable = false,
  voiceCallState = 'idle',
  voiceCallDuration = 0,
  onStartVoiceCall,
  onHangupVoiceCall,
}: MessageInputProps) {
  const [value, setValue] = useState('');
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const clamped = Math.min(el.scrollHeight, 200);
    el.style.height = `${clamped}px`;
    // Show scrollbar only when content exceeds max height
    el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
  }, [value]);

  // Auto-focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const addImages = useCallback(async (files: File[]) => {
    const validFiles = files.filter(
      (f) => ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_IMAGE_SIZE
    );
    if (validFiles.length === 0) return;

    const newImages: ImageAttachment[] = [];
    for (const file of validFiles) {
      const dataUrl = await fileToDataUrl(file);
      newImages.push({ dataUrl, mimeType: file.type, name: file.name });
    }
    setImages((prev) => [...prev, ...newImages].slice(0, 5)); // Max 5 images
  }, []);

  const removeImage = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed && images.length === 0) return;
    onSend(trimmed || '(image)', images.length > 0 ? images : undefined);
    setValue('');
    setImages([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [value, images, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  // Paste handler for images
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addImages(imageFiles);
    }
  }, [addImages]);

  // Drag and drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) addImages(files);
  }, [addImages]);

  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) addImages(files);
    e.target.value = ''; // Reset to allow re-selecting same file
  }, [addImages]);

  return (
    <div
      className={`border-t bg-zinc-900 px-2 sm:px-4 py-3 transition-colors ${
        isDragOver ? 'border-shizuha-500 bg-shizuha-950/20' : 'border-zinc-800'
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="max-w-4xl mx-auto">
        {/* Image previews */}
        {images.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {images.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={img.dataUrl}
                  alt={img.name || `Image ${i + 1}`}
                  className="h-16 w-16 object-cover rounded-lg border border-zinc-700"
                />
                <button
                  onClick={() => removeImage(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-zinc-700 text-zinc-300 hover:bg-red-600 hover:text-white flex items-center justify-center text-xs cursor-pointer opacity-0 group-hover:opacity-100 touch-visible transition-opacity"
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Drag overlay hint */}
        {isDragOver && (
          <div className="flex items-center justify-center py-2 mb-2 rounded-lg border-2 border-dashed border-shizuha-500/50 text-shizuha-400 text-sm">
            Drop images here
          </div>
        )}

        <div className="flex items-end gap-2">
          {/* Image upload button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-zinc-800 hover:bg-zinc-700 flex items-center justify-center transition-colors cursor-pointer"
            title="Attach image (paste or drag-drop)"
          >
            <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            className="hidden"
            onChange={handleFileSelect}
          />

          {/* Microphone button (Talk Mode) */}
          {micSupported && (
            <button
              onClick={() => {
                if (talkPhase === 'recording') {
                  onStopRecording?.();
                } else if (talkPhase === 'speaking') {
                  onStopSpeaking?.();
                } else if (talkPhase === 'idle') {
                  onStartRecording?.();
                }
              }}
              disabled={talkPhase === 'transcribing'}
              className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
                talkPhase === 'recording'
                  ? 'bg-red-600 hover:bg-red-500 animate-pulse'
                  : talkPhase === 'transcribing'
                    ? 'bg-amber-600 cursor-wait'
                    : talkPhase === 'speaking'
                      ? 'bg-shizuha-600 hover:bg-shizuha-500'
                      : 'bg-zinc-800 hover:bg-zinc-700'
              }`}
              title={
                talkPhase === 'recording' ? `Recording (${recordingDuration}s) — click to stop`
                : talkPhase === 'transcribing' ? 'Transcribing...'
                : talkPhase === 'speaking' ? 'Speaking — click to stop'
                : 'Voice input (click to record)'
              }
            >
              {talkPhase === 'recording' ? (
                /* Stop icon (square) */
                <svg className="w-4 h-4 text-white" viewBox="0 0 16 16" fill="currentColor">
                  <rect x="3" y="3" width="10" height="10" rx="1" />
                </svg>
              ) : talkPhase === 'transcribing' ? (
                /* Spinner */
                <svg className="w-4 h-4 text-white animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeLinecap="round" />
                </svg>
              ) : talkPhase === 'speaking' ? (
                /* Speaker/volume icon */
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M5 9l4-4v14l-4-4H2V9h3z" />
                </svg>
              ) : (
                /* Microphone icon */
                <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 1a4 4 0 00-4 4v6a4 4 0 008 0V5a4 4 0 00-4-4z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 10v1a7 7 0 01-14 0v-1M12 19v4M8 23h8" />
                </svg>
              )}
            </button>
          )}

          {/* Voice call button (Twilio) */}
          {voiceCallAvailable && (
            <button
              onClick={() => {
                if (voiceCallState === 'idle' || voiceCallState === 'ended' || voiceCallState === 'error') {
                  onStartVoiceCall?.();
                } else {
                  onHangupVoiceCall?.();
                }
              }}
              className={`flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
                voiceCallState === 'active'
                  ? 'bg-green-600 hover:bg-red-500'
                  : voiceCallState === 'connecting' || voiceCallState === 'ringing'
                    ? 'bg-amber-600 animate-pulse'
                    : 'bg-zinc-800 hover:bg-zinc-700'
              }`}
              title={
                voiceCallState === 'active' ? `In call (${Math.floor(voiceCallDuration / 60)}:${(voiceCallDuration % 60).toString().padStart(2, '0')}) — click to hang up`
                : voiceCallState === 'connecting' ? 'Connecting...'
                : voiceCallState === 'ringing' ? 'Ringing...'
                : 'Start voice call'
              }
            >
              {voiceCallState === 'active' || voiceCallState === 'connecting' || voiceCallState === 'ringing' ? (
                /* Active call — phone with waves */
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
              ) : (
                /* Idle — phone icon */
                <svg className="w-4 h-4 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
              )}
            </button>
          )}

          {/* Recording indicator */}
          {talkPhase === 'recording' && (
            <div className="flex-shrink-0 text-xs text-red-400 font-mono self-center">
              {recordingDuration}s
            </div>
          )}

          {/* Talk error */}
          {talkError && talkPhase === 'idle' && (
            <div className="flex-shrink-0 text-xs text-red-400 self-center max-w-[100px] truncate" title={talkError}>
              {talkError}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            rows={1}
            className="flex-1 resize-none overflow-hidden bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-shizuha-600 focus:ring-1 focus:ring-shizuha-600/30 transition-colors"
          />
          {/* Send button — always available. Stop button shown alongside when streaming. */}
          {isStreaming && onCancel && (
            <button
              onClick={onCancel}
              className="flex-shrink-0 w-8 h-8 rounded-lg bg-zinc-700 hover:bg-red-600/80 flex items-center justify-center transition-colors cursor-pointer"
              title="Stop generation"
            >
              <svg className="w-3 h-3 text-zinc-300" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3" y="3" width="10" height="10" rx="1" />
              </svg>
            </button>
          )}
          <button
            onClick={handleSubmit}
            disabled={!value.trim() && images.length === 0}
            className="flex-shrink-0 w-10 h-10 rounded-xl bg-shizuha-600 hover:bg-shizuha-500 disabled:bg-zinc-700 disabled:cursor-not-allowed flex items-center justify-center transition-colors cursor-pointer"
            title="Send (Enter)"
          >
            <svg className="w-4 h-4 text-white" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1 8.5L7.5 2M7.5 2L14 8.5M7.5 2v12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-90 8 8)" />
            </svg>
          </button>
        </div>
        <div className="mt-1">
          <p className="text-[10px] text-zinc-600 text-center">
            Shift+Enter for newline · Paste or drop images · Enter to send{micSupported ? ' · Click mic for voice' : ''}
          </p>
        </div>
      </div>
    </div>
  );
}
