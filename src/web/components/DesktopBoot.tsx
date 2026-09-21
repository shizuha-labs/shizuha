import { useCallback, useEffect, useState } from 'react';
import { setBackendUrl } from '../lib/backend';

interface HealthResult {
  reachable: boolean;
  compatible: boolean;
  error: string | null;
  nextAction: string;
  health?: { version?: string; message?: string } | null;
}

const CANDIDATES = [
  'http://127.0.0.1:8016',
  'http://127.0.0.1:8015',
  'http://localhost:8016',
  'http://localhost:8015',
];

async function probe(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(2500) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function invokeStartCore(): Promise<{ ok: boolean; message: string }> {
  if (typeof window !== 'undefined' && (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<{ ok: boolean; message: string }>('start_core');
  }
  return { ok: false, message: 'Run `shizuha desktop` or `shizuha up` in a terminal first.' };
}

export function DesktopBoot({ onReady }: { onReady: () => void }) {
  const [status, setStatus] = useState('Looking for the local Shizuha core…');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const attach = useCallback(async (): Promise<boolean> => {
    for (const url of CANDIDATES) {
      if (await probe(url)) {
        setBackendUrl(url);
        onReady();
        return true;
      }
    }
    return false;
  }, [onReady]);

  useEffect(() => {
    void attach();
  }, [attach]);

  const startCore = useCallback(async () => {
    setBusy(true);
    setError(null);
    setStatus('Starting the local Shizuha core…');
    const result = await invokeStartCore();
    if (!result.ok) {
      setError(result.message);
      setBusy(false);
      return;
    }
    for (let i = 0; i < 20; i += 1) {
      if (await attach()) return;
      await new Promise((resolve) => window.setTimeout(resolve, 500));
    }
    setError('Core started but /health did not come up on :8015/:8016.');
    setBusy(false);
  }, [attach]);

  return (
    <div className="min-h-[100dvh] bg-zinc-950 text-zinc-100 flex items-center justify-center px-6">
      <div className="w-full max-w-md rounded-3xl border border-cyan-400/20 bg-zinc-900/80 p-8 shadow-[0_24px_80px_rgba(8,145,178,0.16)]">
        <p className="text-[10px] uppercase tracking-[0.28em] text-cyan-300/80">Shizuha Desktop</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Talk to your coding agent</h1>
        <p className="mt-3 text-sm text-zinc-400 leading-relaxed">
          Same Hina-style voice-to-voice as shizuha.com — the local harness hears you, speaks back, and can edit the repo.
        </p>
        <p className="mt-5 text-sm text-zinc-300">{status}</p>
        {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={() => void startCore()}
          className="mt-6 w-full h-11 rounded-2xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 text-white text-sm font-medium cursor-pointer"
        >
          {busy ? 'Starting…' : 'Start local core'}
        </button>
        <p className="mt-4 text-xs text-zinc-500 leading-relaxed">
          Needs the <code className="text-zinc-300">shizuha</code> CLI on your PATH.
          Install with <code className="text-zinc-300">curl -fsSL https://shizuha.com/install.sh | bash</code>,
          then add an xAI or Cortex key for Live.
        </p>
      </div>
    </div>
  );
}

export type { HealthResult };
