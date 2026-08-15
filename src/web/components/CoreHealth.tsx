import { useState, useEffect, useCallback } from 'react';

// --- Types matching the Rust backend ---

interface AuthStatus {
  authenticated: boolean;
  account: string;
  message: string;
}

interface CoreHealth {
  version: string;
  protocolVersion: number;
  authStatus: AuthStatus;
  providers: string[];
  models: string[];
  capabilities: string[];
  message: string;
}

interface HealthResult {
  reachable: boolean;
  health: CoreHealth | null;
  error: string | null;
  compatible: boolean;
  serverError: boolean;
  nextAction: string;
}

// --- Tauri invoke wrapper ---

async function invokeCoreHealth(coreUrl?: string): Promise<HealthResult> {
  // In Tauri, we use the Tauri invoke API.
  // In browser dev mode, we fall back to a direct HTTP call.
  if (typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<HealthResult>('core_health', { coreUrl: coreUrl ?? null });
  }

  // Fallback for browser dev: hit the core directly via Vite proxy
  const baseUrl = coreUrl ?? '';
  const healthUrl = baseUrl
    ? `${baseUrl.replace(/\/+$/, '')}/health`
    : '/health';

  try {
    const resp = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      return {
        reachable: true,
        health: null,
        error: `Core returned HTTP ${resp.status}`,
        compatible: false,
        serverError: true,
        nextAction: 'Check the core logs for errors.',
      };
    }
    const data: CoreHealth = await resp.json();
    const compatible = data.protocolVersion === 1;
    return {
      reachable: true,
      health: data,
      error: compatible ? null : `Protocol version mismatch: core v${data.protocolVersion}, app expects v1.`,
      compatible,
      serverError: false,
      nextAction: compatible ? '' : 'Upgrade required: install the latest Shizuha version.',
    };
  } catch (err: any) {
    const msg = err.message ?? String(err);
    let nextAction = 'Check your Shizuha installation and try again.';
    if (msg.includes('Connection refused') || msg.includes('Failed to fetch')) {
      nextAction = "Start the Shizuha core first: run 'shizuha gateway' or launch the Shizuha daemon.";
    } else if (msg.includes('timed out') || msg.includes('Timeout')) {
      nextAction = 'The core may be busy or hung. Check the core logs or restart it.';
    }
    return {
      reachable: false,
      health: null,
      error: `Cannot connect to core: ${msg}`,
      compatible: false,
      serverError: false,
      nextAction,
    };
  }
}

// --- UI Components ---

function StatusBadge({ status, label }: { status: 'ok' | 'warn' | 'error'; label: string }) {
  const colors: Record<string, string> = {
    ok: 'bg-green-100 text-green-800 border-green-300',
    warn: 'bg-yellow-100 text-yellow-800 border-yellow-300',
    error: 'bg-red-100 text-red-800 border-red-300',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium border ${colors[status]}`}>
      {label}
    </span>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between py-1.5 border-b border-gray-100 last:border-b-0">
      <span className="text-sm font-medium text-gray-500">{label}</span>
      <span className="text-sm text-gray-900 font-mono">{value}</span>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="animate-pulse space-y-3 p-4">
      <div className="h-4 bg-gray-200 rounded w-1/3" />
      <div className="h-4 bg-gray-200 rounded w-1/2" />
      <div className="h-4 bg-gray-200 rounded w-2/3" />
      <div className="h-4 bg-gray-200 rounded w-1/4" />
    </div>
  );
}

function ErrorState({ error, nextAction, onRetry }: { error: string; nextAction: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 p-4">
      <div className="flex items-start gap-3">
        <span className="text-red-500 text-xl leading-none mt-0.5">&#x2717;</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-red-800">Core Unreachable</h3>
          <p className="mt-1 text-sm text-red-700 break-words">{error}</p>
          <p className="mt-2 text-sm text-red-600 font-medium">{nextAction}</p>
          <button
            onClick={onRetry}
            className="mt-3 inline-flex items-center px-3 py-1.5 text-sm font-medium text-red-700 bg-red-100 rounded-md hover:bg-red-200 transition-colors"
          >
            Retry Connection
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerErrorState({ error, nextAction, onRetry }: { error: string; nextAction: string; onRetry: () => void }) {
  return (
    <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
      <div className="flex items-start gap-3">
        <span className="text-orange-500 text-xl leading-none mt-0.5">&#x26A0;</span>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-orange-800">Core Error</h3>
          <p className="mt-1 text-sm text-orange-700 break-words">{error}</p>
          <p className="mt-2 text-sm text-orange-600 font-medium">{nextAction}</p>
          <button
            onClick={onRetry}
            className="mt-3 inline-flex items-center px-3 py-1.5 text-sm font-medium text-orange-700 bg-orange-100 rounded-md hover:bg-orange-200 transition-colors"
          >
            Retry Connection
          </button>
        </div>
      </div>
    </div>
  );
}

function UpgradeRequired({ error, nextAction }: { error: string; nextAction: string }) {
  return (
    <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
      <div className="flex items-start gap-3">
        <span className="text-yellow-500 text-xl leading-none mt-0.5">&#x26A0;</span>
        <div>
          <h3 className="text-sm font-semibold text-yellow-800">Upgrade Required</h3>
          <p className="mt-1 text-sm text-yellow-700">{error}</p>
          <p className="mt-2 text-sm text-yellow-600 font-medium">{nextAction}</p>
        </div>
      </div>
    </div>
  );
}

function HealthCard({ health }: { health: CoreHealth }) {
  const authBadge = health.authStatus.authenticated
    ? <StatusBadge status="ok" label="Authenticated" />
    : <StatusBadge status="warn" label="Not Authenticated" />;

  const providerList = health.providers.length > 0
    ? health.providers.join(', ')
    : 'None configured';

  const modelList = health.models.length > 0
    ? health.models.slice(0, 5).join(', ') + (health.models.length > 5 ? ` (+${health.models.length - 5} more)` : '')
    : 'No models available';

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-900">Core Status</h2>
        <StatusBadge status="ok" label="Connected" />
      </div>
      <div className="p-4 space-y-1">
        <InfoRow label="Version" value={health.version} />
        <InfoRow label="Protocol" value={`v${health.protocolVersion}`} />
        <div className="flex justify-between py-1.5 border-b border-gray-100">
          <span className="text-sm font-medium text-gray-500">Auth</span>
          <div>{authBadge}</div>
        </div>
        {health.authStatus.account && (
          <InfoRow label="Account" value={health.authStatus.account} />
        )}
        <InfoRow label="Providers" value={providerList} />
        <InfoRow label="Models" value={modelList} />
        {health.capabilities.length > 0 && (
          <InfoRow label="Capabilities" value={health.capabilities.join(', ')} />
        )}
        {health.message && (
          <InfoRow label="Message" value={health.message} />
        )}
      </div>
    </div>
  );
}

// --- Main Component ---

export default function CoreHealthView() {
  const [result, setResult] = useState<HealthResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [coreUrl, setCoreUrl] = useState('');

  const checkHealth = useCallback(async (url?: string) => {
    setLoading(true);
    try {
      const res = await invokeCoreHealth(url || undefined);
      setResult(res);
    } catch (err: any) {
      setResult({
        reachable: false,
        health: null,
        error: `Unexpected error: ${err.message ?? err}`,
        compatible: false,
        serverError: false,
        nextAction: 'Check your Shizuha installation and try again.',
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    // Auto-refresh every 30 seconds
    const interval = setInterval(() => checkHealth(coreUrl || undefined), 30_000);
    return () => clearInterval(interval);
  }, [checkHealth, coreUrl]);

  const handleRetry = () => checkHealth(coreUrl || undefined);

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900">Shizuha Desktop</h1>
        <p className="text-sm text-gray-500 mt-1">
          Thin client over the local Shizuha agent core
        </p>
      </div>

      {/* Core URL input (advanced) */}
      <details className="mb-4 text-sm text-gray-500">
        <summary className="cursor-pointer hover:text-gray-700">Advanced: Core URL</summary>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={coreUrl}
            onChange={(e) => setCoreUrl(e.target.value)}
            placeholder="http://127.0.0.1:8015"
            className="flex-1 px-3 py-1.5 text-sm border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={() => checkHealth(coreUrl || undefined)}
            className="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-colors"
          >
            Connect
          </button>
        </div>
      </details>

      {loading && <LoadingSkeleton />}

      {!loading && result && !result.reachable && (
        <ErrorState
          error={result.error!}
          nextAction={result.nextAction}
          onRetry={handleRetry}
        />
      )}

      {!loading && result && result.reachable && result.serverError && (
        <ServerErrorState
          error={result.error!}
          nextAction={result.nextAction}
          onRetry={handleRetry}
        />
      )}

      {!loading && result && result.reachable && !result.serverError && !result.compatible && (
        <UpgradeRequired
          error={result.error!}
          nextAction={result.nextAction}
        />
      )}

      {!loading && result && result.reachable && result.compatible && result.health && (
        <div className="space-y-4">
          <HealthCard health={result.health} />

          {/* Quick actions */}
          <div className="rounded-lg border border-gray-200 bg-white shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Quick Actions</h3>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleRetry}
                className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
              >
                Refresh Status
              </button>
              <button
                onClick={() => {
                  if (result.health?.authStatus.authenticated) {
                    // TODO: navigate to settings
                  }
                }}
                className="inline-flex items-center px-3 py-1.5 text-sm font-medium text-gray-700 bg-gray-100 rounded-md hover:bg-gray-200 transition-colors"
              >
                Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <div className="mt-8 text-center text-xs text-gray-400">
        Shizuha Desktop v0.1.0 &middot; Protocol v1
      </div>
    </div>
  );
}
