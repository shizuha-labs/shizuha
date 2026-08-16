import { useEffect, useState } from 'react';

export const DEFAULT_DASHBOARD_MODELS = [
  'claude-opus-5',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5.5',
  'gpt-4.1',
  'o4-mini',
  'codex-mini-latest',
  'gemini-2.0-flash',
  'GLM-4.7',
];

export function dedupeDashboardModels(models: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    const trimmed = model?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export async function fetchDashboardModels(): Promise<string[]> {
  const res = await fetch('/v1/models');
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  const data = await res.json() as { models?: Array<{ slug?: string }> };
  return dedupeDashboardModels((data.models ?? []).map((entry) => entry.slug));
}

const DEFAULT_PROVIDERS = ['anthropic', 'openai', 'google', 'copilot', 'codex', 'cortex', 'ollama', 'litellm', 'vllm', 'openrouter', 'llamacpp', 'deepseek', 'mistral', 'xai'];

export function useDashboardProviders(): string[] {
  const [providers, setProviders] = useState<string[]>(DEFAULT_PROVIDERS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/v1/models');
        if (!res.ok) return;
        const data = await res.json() as { providers?: string[] };
        if (!cancelled && data.providers?.length) {
          // Merge remote providers with defaults, deduplicated
          const seen = new Set<string>();
          const merged: string[] = [];
          for (const p of [...data.providers, ...DEFAULT_PROVIDERS]) {
            if (!seen.has(p)) { seen.add(p); merged.push(p); }
          }
          setProviders(merged);
        }
      } catch { /* keep defaults */ }
    })();
    return () => { cancelled = true; };
  }, []);

  return providers;
}

export function useDashboardModels(seedModels: Array<string | null | undefined>): string[] {
  const seedKey = JSON.stringify(seedModels.map((model) => model?.trim() ?? ''));
  const [models, setModels] = useState<string[]>(() =>
    dedupeDashboardModels([...seedModels, ...DEFAULT_DASHBOARD_MODELS]),
  );

  useEffect(() => {
    const seeded = dedupeDashboardModels([...seedModels, ...DEFAULT_DASHBOARD_MODELS]);
    setModels((prev) => dedupeDashboardModels([...seeded, ...prev]));

    let cancelled = false;

    async function loadModels() {
      try {
        const remoteModels = await fetchDashboardModels();
        if (!cancelled) {
          setModels(dedupeDashboardModels([...seedModels, ...remoteModels]));
        }
      } catch {
        if (!cancelled) {
          setModels((prev) => dedupeDashboardModels([...seedModels, ...prev, ...DEFAULT_DASHBOARD_MODELS]));
        }
      }
    }

    loadModels();
    return () => { cancelled = true; };
  }, [seedKey]);

  return models;
}
