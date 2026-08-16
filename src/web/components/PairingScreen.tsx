/**
 * Pairing screen — shown when the device is not paired with the agent.
 *
 * The user enters an 8-character pairing code (displayed on the server terminal)
 * to authenticate this browser/device.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

interface PairingScreenProps {
  onPair: (code: string, deviceName?: string) => Promise<void>;
  error: string | null;
  isPairing: boolean;
}

const CODE_LENGTH = 8;

export function PairingScreen({ onPair, error, isPairing }: PairingScreenProps) {
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(''));
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);

  // Focus first input on mount
  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleInput = useCallback((index: number, value: string) => {
    // Only allow alphanumeric (unambiguous alphabet)
    const char = value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(-1);
    if (!char) return;

    setLocalError(null);
    setDigits((prev) => {
      const next = [...prev];
      next[index] = char;
      return next;
    });

    // Auto-advance to next input
    if (index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }, []);

  const handleKeyDown = useCallback((index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      setDigits((prev) => {
        const next = [...prev];
        if (next[index]) {
          next[index] = '';
        } else if (index > 0) {
          next[index - 1] = '';
          inputRefs.current[index - 1]?.focus();
        }
        return next;
      });
    } else if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/[-\s]/g, '').toUpperCase().slice(0, CODE_LENGTH);
    if (!pasted) return;

    const chars = pasted.split('').filter((c) => /[A-Z0-9]/.test(c));
    setDigits((prev) => {
      const next = [...prev];
      for (let i = 0; i < chars.length && i < CODE_LENGTH; i++) {
        next[i] = chars[i]!;
      }
      return next;
    });

    // Focus last filled or next empty
    const focusIdx = Math.min(chars.length, CODE_LENGTH - 1);
    inputRefs.current[focusIdx]?.focus();
  }, []);

  const handleSubmit = useCallback(async () => {
    const code = digits.join('');
    if (code.length !== CODE_LENGTH) {
      setLocalError('Please enter the full 8-character code');
      return;
    }
    try {
      await onPair(code);
    } catch {
      // Error is handled by parent via the error prop
    }
  }, [digits, onPair]);

  // Auto-submit when all digits filled
  useEffect(() => {
    const code = digits.join('');
    if (code.length === CODE_LENGTH && !isPairing) {
      handleSubmit();
    }
  }, [digits, isPairing, handleSubmit]);

  const displayError = error || localError;

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-zinc-950 p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-16 h-16 rounded-2xl bg-shizuha-600 flex items-center justify-center mb-4">
            <span className="text-2xl font-bold text-white">❖</span>
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">Pair with Shizuha</h1>
          <p className="text-sm text-zinc-500 mt-2 text-center max-w-[300px]">
            Enter the pairing code shown on the server terminal to connect this device.
          </p>
        </div>

        {/* Code input */}
        <div className="flex justify-center gap-2 mb-2">
          {digits.map((digit, i) => (
            <div key={i} className="flex items-center">
              <input
                ref={(el) => { inputRefs.current[i] = el; }}
                type="text"
                inputMode="text"
                autoCapitalize="characters"
                maxLength={1}
                value={digit}
                onChange={(e) => handleInput(i, e.target.value)}
                onKeyDown={(e) => handleKeyDown(i, e)}
                onPaste={i === 0 ? handlePaste : undefined}
                disabled={isPairing}
                className={`w-10 h-12 sm:w-12 sm:h-14 text-center text-lg sm:text-xl font-mono font-bold rounded-lg border transition-colors outline-none ${
                  displayError
                    ? 'border-red-500/50 bg-red-950/20 text-red-300'
                    : digit
                    ? 'border-shizuha-500/50 bg-zinc-800 text-zinc-100'
                    : 'border-zinc-700 bg-zinc-900 text-zinc-300'
                } focus:border-shizuha-500 focus:ring-1 focus:ring-shizuha-500/30 disabled:opacity-50`}
              />
              {/* Dash separator after 4th digit */}
              {i === 3 && (
                <span className="text-zinc-600 text-xl font-bold mx-1">-</span>
              )}
            </div>
          ))}
        </div>

        {/* Error message */}
        {displayError && (
          <div className="mt-4 px-4 py-2.5 rounded-lg bg-red-950/30 border border-red-900/30 text-center">
            <p className="text-sm text-red-400">{displayError}</p>
          </div>
        )}

        {/* Loading state */}
        {isPairing && (
          <div className="flex items-center justify-center mt-4 gap-2 text-zinc-400 text-sm">
            <div className="w-4 h-4 border-2 border-zinc-600 border-t-shizuha-400 rounded-full animate-spin" />
            Pairing...
          </div>
        )}

        {/* Submit button */}
        <button
          onClick={handleSubmit}
          disabled={isPairing || digits.join('').length !== CODE_LENGTH}
          className="w-full mt-6 py-3 px-4 rounded-lg bg-shizuha-600 hover:bg-shizuha-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white font-medium text-sm transition-colors cursor-pointer disabled:cursor-not-allowed"
        >
          {isPairing ? 'Pairing...' : 'Connect Device'}
        </button>

        {/* Help text */}
        <div className="mt-8 text-center">
          <p className="text-xs text-zinc-600">
            Generate a code on the server:
          </p>
          <code className="inline-block mt-1.5 px-3 py-1.5 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 font-mono">
            shizuha pair --show-code
          </code>
        </div>
      </div>
    </div>
  );
}
