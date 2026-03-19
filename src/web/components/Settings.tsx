import { useState, useEffect, useCallback } from 'react';
import type { Agent, AgentCredential } from '../lib/types';
import { getAgentModel } from '../lib/types';

interface SettingsData {
  identity: {
    loggedIn: boolean;
    username?: string;
    accessTokenExpiresAt?: string;
    refreshTokenExpiresAt?: string;
  };
  daemon: {
    pid: number;
    startedAt: string;
    platformUrl: string;
    agentCount: number;
  } | null;
  runners: Array<{
    agent_id: string;
    agent_name?: string;
    token_prefix: string;
    connected_at: string;
    version?: string;
  }>;
  providers: {
    anthropic: {
      configured: boolean;
      tokens: Array<{ label: string; prefix: string; addedAt: string }>;
    };
    openai: {
      configured: boolean;
      keyPrefix: string | null;
    };
    google: {
      configured: boolean;
      keyPrefix: string | null;
    };
    codex: {
      configured: boolean;
      accounts: Array<{ email: string; accountId: string; addedAt: string; lastRefresh: string | null }>;
    };
    copilot: {
      configured: boolean;
      tokenPrefix: string | null;
      label: string | null;
      addedAt: string | null;
    };
  };
  agents: Array<Agent & {
    startedAt?: string;
    tokenPrefix?: string;
  }>;
  runtime: {
    version: string;
    nodeVersion: string;
    platform: string;
    arch: string;
    uptime: number;
    memoryUsage: number;
  };
}

type Section = 'profile' | 'agents' | 'connection' | 'fan-out' | 'providers' | 'runtime';

interface SettingsProps {
  isOpen: boolean;
  onClose: () => void;
}

const SECTIONS: Array<{ id: Section; label: string; icon: string }> = [
  { id: 'profile', label: 'Profile', icon: 'M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z' },
  { id: 'agents', label: 'Agents', icon: 'M18 18.72a9.094 9.094 0 0 0 3.741-.479 3 3 0 0 0-4.682-2.72m.94 3.198.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0 1 12 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 0 1 6 18.719m12 0a5.971 5.971 0 0 0-.941-3.197m0 0A5.995 5.995 0 0 0 12 12.75a5.995 5.995 0 0 0-5.058 2.772m0 0a3 3 0 0 0-4.681 2.72 8.986 8.986 0 0 0 3.74.477m.94-3.197a5.971 5.971 0 0 0-.94 3.197M15 6.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm6 3a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Zm-13.5 0a2.25 2.25 0 1 1-4.5 0 2.25 2.25 0 0 1 4.5 0Z' },
  { id: 'connection', label: 'Connection', icon: 'M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244' },
  { id: 'fan-out', label: 'Fan-out', icon: 'M7.217 10.907a2.25 2.25 0 1 0 0 2.186m0-2.186c.18.324.283.696.283 1.093s-.103.77-.283 1.093m0-2.186 9.566-5.314m-9.566 7.5 9.566 5.314m0 0a2.25 2.25 0 1 0 3.935 2.186 2.25 2.25 0 0 0-3.935-2.186Zm0-12.814a2.25 2.25 0 1 0 3.933-2.185 2.25 2.25 0 0 0-3.933 2.185Z' },
  { id: 'providers', label: 'Providers', icon: 'M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z' },
  { id: 'runtime', label: 'Runtime', icon: 'M11.42 15.17 17.25 21A2.652 2.652 0 0 0 21 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 1 1-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 0 0 4.486-6.336l-3.276 3.277a3.004 3.004 0 0 1-2.25-2.25l3.276-3.276a4.5 4.5 0 0 0-6.336 4.486c.048.58.024 1.194-.14 1.743' },
];

export function Settings({ isOpen, onClose }: SettingsProps) {
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeSection, setActiveSection] = useState<Section>('profile');

  const fetchSettings = useCallback(async () => {
    try {
      const res = await fetch('/v1/settings');
      if (res.ok) {
        setData(await res.json());
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetchSettings();
    }
  }, [isOpen, fetchSettings]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      {/* Settings panel */}
      <div className="relative ml-auto w-full max-w-2xl bg-zinc-900 flex h-full">
        {/* Section nav */}
        <nav className="w-12 sm:w-48 flex-shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col">
          <div className="flex items-center gap-2 px-2 sm:px-4 py-3 border-b border-zinc-800">
            <button
              onClick={onClose}
              className="w-7 h-7 flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
            <span className="hidden sm:inline text-sm font-semibold text-zinc-200">Settings</span>
          </div>

          <div className="flex-1 py-2 overflow-y-auto">
            {SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => setActiveSection(section.id)}
                className={`w-full flex items-center gap-2.5 px-3 sm:px-4 py-2 text-left text-sm transition-colors cursor-pointer ${
                  activeSection === section.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
                title={section.label}
              >
                <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={section.icon} />
                </svg>
                <span className="hidden sm:inline">{section.label}</span>
              </button>
            ))}
          </div>

          {/* Version footer */}
          <div className="hidden sm:block px-4 py-3 border-t border-zinc-800">
            <span className="text-[10px] text-zinc-600 font-mono">shizuha v{data?.runtime.version ?? '...'}</span>
          </div>
        </nav>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
            </div>
          ) : data ? (
            <div className="p-3 sm:p-6">
              {activeSection === 'profile' && <ProfileSection data={data} onRefresh={fetchSettings} />}
              {activeSection === 'agents' && <AgentsSection data={data} onRefresh={fetchSettings} />}
              {activeSection === 'connection' && <ConnectionSection data={data} />}
              {activeSection === 'fan-out' && <FanOutSection />}
              {activeSection === 'providers' && <ProvidersSection data={data} onRefresh={fetchSettings} />}
              {activeSection === 'runtime' && <RuntimeSection data={data} />}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
              Failed to load settings
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Section Components ──

function ProfileSection({ data, onRefresh }: { data: SettingsData; onRefresh: () => void }) {
  return (
    <div className="space-y-8">
      <DashboardAccountSection />
      <div className="border-t border-zinc-700/50" />
      <AccountLinkingSection data={data} onRefresh={onRefresh} />
    </div>
  );
}

/** Local dashboard account — change password for the shizuha/shizuha login */
function DashboardAccountSection() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isDefault, setIsDefault] = useState(false);

  // Check if default password is still in use
  useEffect(() => {
    fetch('/v1/dashboard/session')
      .then((r) => r.json())
      .then((d) => { if (d.defaultPassword) setIsDefault(true); })
      .catch(() => {});
  }, [success]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword || !confirmPassword) return;
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 4) {
      setError('Password must be at least 4 characters');
      return;
    }
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      const res = await fetch('/v1/dashboard/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }));
        setError(err.error || 'Failed to change password');
        return;
      }
      setCurrentPassword('');
      setConfirmPassword('');
      setSuccess(true);
      setIsDefault(false);
      // Update stored credentials so auto-reauth works with new password
      try {
        const raw = localStorage.getItem('shizuha_auth');
        if (raw) {
          const auth = JSON.parse(raw);
          auth.password = newPassword;
          localStorage.setItem('shizuha_auth', JSON.stringify(auth));
        }
      } catch { /* ignore */ }
      setNewPassword('');
      // Session was invalidated — reload page to show login
      setTimeout(() => { window.location.reload(); }, 1500);
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <SectionHeader title="Dashboard Account" />

      {isDefault && (
        <div className="bg-amber-950/30 border border-amber-800/40 rounded-lg px-3.5 py-2.5 flex items-start gap-2.5">
          <svg className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <div>
            <p className="text-xs text-amber-300 font-medium">Default password in use</p>
            <p className="text-[11px] text-amber-400/70 mt-0.5">Change your password to secure this dashboard.</p>
          </div>
        </div>
      )}

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
          {error}
        </div>
      )}

      {success && (
        <div className="text-xs text-emerald-400 bg-emerald-950/30 px-3 py-2 rounded-lg border border-emerald-900/30">
          Password changed. You will be redirected to sign in again.
        </div>
      )}

      <form onSubmit={handleChangePassword} className="space-y-3">
        <div>
          <label className="text-[11px] font-medium text-zinc-400 block mb-1">Current password</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Enter current password"
            autoComplete="current-password"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400 block mb-1">New password</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Enter new password"
            autoComplete="new-password"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
        </div>
        <div>
          <label className="text-[11px] font-medium text-zinc-400 block mb-1">Confirm new password</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Confirm new password"
            autoComplete="new-password"
            className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
          />
        </div>
        <button
          type="submit"
          disabled={busy || !currentPassword || !newPassword || !confirmPassword}
          className="w-full py-2 bg-zinc-700 hover:bg-zinc-600 text-sm font-medium text-zinc-200 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Changing...' : 'Change password'}
        </button>
      </form>
    </div>
  );
}

/** Account Linking — connect local runtime to Shizuha's online platform */
function AccountLinkingSection({ data, onRefresh }: { data: SettingsData; onRefresh: () => void }) {
  const { identity } = data;
  const initials = (identity.username ?? '?').slice(0, 2).toUpperCase();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(!identity.loggedIn);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Login failed' }));
        setError(err.error || 'Login failed');
        return;
      }
      setPassword('');
      setShowLogin(false);
      onRefresh();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async () => {
    setBusy(true);
    setError(null);
    try {
      await fetch('/v1/auth/logout', { method: 'POST' });
      setShowLogin(true);
      onRefresh();
    } catch {
      setError('Failed to unlink');
    } finally {
      setBusy(false);
    }
  };

  const LINK_BENEFITS = [
    { label: 'Remote access', desc: 'Chat with your agents from the web, mobile, Telegram, or Discord' },
    { label: 'Platform agents', desc: 'Access team agents managed by your organization' },
    { label: 'Sync & backup', desc: 'Agent configs, chat history, and MCP servers synced to the cloud' },
    { label: 'Collaboration', desc: 'Share agents with teammates via Pulse tasks and Wiki docs' },
  ];

  return (
    <div className="space-y-5">
      <SectionHeader title="Account Linking" subtitle="Connect your local runtime to Shizuha's online platform" />

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
          {error}
        </div>
      )}

      {identity.loggedIn && !showLogin ? (
        <>
          {/* Linked state */}
          <div className="bg-emerald-950/20 border border-emerald-800/30 rounded-lg px-4 py-3 flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-emerald-500 flex-shrink-0 animate-pulse" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-300">Linked to Shizuha ID</p>
              <p className="text-[11px] text-emerald-400/70 mt-0.5">Your local agents are connected to the platform</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-full bg-shizuha-600 flex items-center justify-center flex-shrink-0">
              <span className="text-lg font-bold text-white">{initials}</span>
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-zinc-100">{identity.username}</h2>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                {data.daemon?.platformUrl || 'Platform connected'}
              </p>
            </div>
          </div>

          <Card>
            <CardRow label="Account" value={identity.username ?? '—'} />
            {identity.accessTokenExpiresAt && (
              <CardRow label="Session expires" value={formatRelativeTime(identity.accessTokenExpiresAt)} />
            )}
            {identity.refreshTokenExpiresAt && (
              <CardRow label="Refresh token" value={formatRelativeTime(identity.refreshTokenExpiresAt)} />
            )}
          </Card>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowLogin(true)}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
            >
              Switch account
            </button>
            <span className="text-zinc-700">|</span>
            <button
              onClick={handleUnlink}
              disabled={busy}
              className="text-[11px] text-red-400/70 hover:text-red-300 cursor-pointer transition-colors disabled:opacity-50"
            >
              {busy ? 'Unlinking...' : 'Unlink account'}
            </button>
          </div>
        </>
      ) : (
        <>
          {/* Not linked — show benefits and login form */}
          <div className="bg-zinc-800/40 border border-zinc-700/50 rounded-lg px-4 py-3 flex items-center gap-3">
            <div className="w-3 h-3 rounded-full bg-zinc-600 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-zinc-300">Local mode</p>
              <p className="text-[11px] text-zinc-500 mt-0.5">Agents run locally without platform connection</p>
            </div>
          </div>

          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2.5">Link to unlock</p>
            <div className="grid grid-cols-2 gap-2">
              {LINK_BENEFITS.map((b) => (
                <div key={b.label} className="bg-zinc-800/30 rounded-lg px-3 py-2.5 border border-zinc-800">
                  <p className="text-xs font-medium text-zinc-300">{b.label}</p>
                  <p className="text-[10px] text-zinc-500 mt-0.5 leading-relaxed">{b.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <form onSubmit={handleLink} className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Sign in to Shizuha ID</p>
            <div>
              <label className="text-[11px] font-medium text-zinc-400 block mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Your Shizuha ID username"
                autoComplete="username"
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
              />
            </div>
            <div>
              <label className="text-[11px] font-medium text-zinc-400 block mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your Shizuha ID password"
                autoComplete="current-password"
                className="w-full bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 focus:ring-1 focus:ring-zinc-500"
              />
            </div>
            <button
              type="submit"
              disabled={busy || !username || !password}
              className="w-full py-2.5 bg-shizuha-600 hover:bg-shizuha-500 text-sm font-medium text-white rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Linking...' : 'Link Account'}
            </button>
          </form>

          <p className="text-[10px] text-zinc-600 leading-relaxed">
            Your local dashboard credentials stay the same.
            Linking connects your runtime to the platform for remote access and team features.
            {!identity.loggedIn && ' You can also link from the CLI: shizuha login'}
          </p>

          {identity.loggedIn && (
            <button
              onClick={() => setShowLogin(false)}
              className="text-[11px] text-zinc-500 hover:text-zinc-300 cursor-pointer transition-colors"
            >
              Cancel
            </button>
          )}
        </>
      )}
    </div>
  );
}

const SETTINGS_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-4.1',
  'o4-mini',
  'codex-mini-latest',
  'gemini-2.0-flash',
];

const SETTINGS_EXEC_METHODS = [
  'shizuha', 'cli', 'claude_code_server', 'sdk', 'direct', 'sdk_direct',
  'codex', 'codex_app_server', 'codex_sdk',
];

type ModelChainEntry = { method: string; model: string; reasoningEffort?: string; thinkingLevel?: string };

/** Derive model chain from agent — uses modelFallbacks if set, else builds from legacy fields */
function getModelChain(agent: Agent): ModelChainEntry[] {
  if (agent.modelFallbacks?.length) return agent.modelFallbacks;
  // Legacy: derive from execution_method + model_overrides
  const method = agent.executionMethod ?? 'shizuha';
  const overrides = agent.modelOverrides ?? {};
  const model = overrides[method] || overrides['shizuha'] || getAgentModel(agent);
  return [{ method, model }];
}

// Provider-specific options for reasoning/thinking
// Claude (anthropic, claude_code_server, cli, sdk): thinking + effort (separate API fields)
// Codex (codex, codex_app_server, codex_sdk): reasoning effort only
// shizuha: depends on model — Claude models get both, GPT models get effort
const CLAUDE_METHODS = new Set(['claude_code_server', 'cli', 'sdk', 'sdk_direct']);
const CODEX_METHODS = new Set(['codex', 'codex_app_server', 'codex_sdk']);
// 'shizuha' and 'direct' are model-dependent

const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'] as const;
const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'max'] as const;
const CLAUDE_THINKING = ['', 'off', 'on', 'low', 'medium', 'high'] as const;
const OPENAI_REASONING = ['', 'low', 'medium', 'high'] as const; // o-series

type MethodCapability = 'thinking' | 'effort' | 'both' | 'none';

function getMethodCapability(method: string, model: string): MethodCapability {
  if (CLAUDE_METHODS.has(method)) return 'both';
  if (CODEX_METHODS.has(method)) return 'effort';
  if (method === 'shizuha' || method === 'direct') {
    // Model-dependent
    if (model.startsWith('claude-')) return 'both';
    if (model.startsWith('gpt-5') || model.startsWith('codex-')) return 'effort';
    if (model.startsWith('o3') || model.startsWith('o4')) return 'effort';
    return 'both'; // unknown model — show both
  }
  return 'none';
}

function getEffortOptions(method: string, model: string): readonly string[] {
  const cap = getMethodCapability(method, model);
  if (cap === 'effort' || cap === 'both') {
    if (CLAUDE_METHODS.has(method) || model.startsWith('claude-')) return CLAUDE_EFFORTS;
    if (CODEX_METHODS.has(method) || model.startsWith('gpt-5') || model.startsWith('codex-')) return CODEX_EFFORTS;
    if (model.startsWith('o3') || model.startsWith('o4')) return OPENAI_REASONING;
    return CODEX_EFFORTS;
  }
  return [];
}

function getThinkingOptions(method: string, model: string): readonly string[] {
  const cap = getMethodCapability(method, model);
  if (cap === 'thinking' || cap === 'both') return CLAUDE_THINKING;
  return [];
}

function ModelChainEditor({ agent, saving, onSave }: { agent: Agent; saving: string | null; onSave: (fallbacks: ModelChainEntry[]) => void }) {
  const chain = getModelChain(agent);
  const [adding, setAdding] = useState(false);
  const [newMethod, setNewMethod] = useState('shizuha');
  const [newModel, setNewModel] = useState('claude-opus-4-6');
  const [newEffort, setNewEffort] = useState('');
  const [newThinking, setNewThinking] = useState('');
  const [editIdx, setEditIdx] = useState<number | null>(null);
  const [editMethod, setEditMethod] = useState('');
  const [editModel, setEditModel] = useState('');
  const [editEffort, setEditEffort] = useState('');
  const [editThinking, setEditThinking] = useState('');

  const save = (updated: ModelChainEntry[]) => {
    // Strip empty optional fields before saving
    const cleaned = updated.map(e => {
      const entry: ModelChainEntry = { method: e.method, model: e.model };
      if (e.reasoningEffort) entry.reasoningEffort = e.reasoningEffort;
      if (e.thinkingLevel) entry.thinkingLevel = e.thinkingLevel;
      return entry;
    });
    onSave(cleaned);
    setEditIdx(null);
    setAdding(false);
  };

  const move = (idx: number, dir: -1 | 1) => {
    const next = [...chain];
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= next.length) return;
    [next[idx], next[newIdx]] = [next[newIdx]!, next[idx]!];
    save(next);
  };

  const remove = (idx: number) => {
    if (chain.length <= 1) return; // must keep at least one
    save(chain.filter((_, i) => i !== idx));
  };

  const selectClass = "bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500";

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Model Chain (tried top to bottom)</h4>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer">+ Add</button>
        )}
      </div>
      <Card>
        {chain.map((entry, idx) => (
          <div key={idx} className="px-3 py-2">
            {editIdx === idx ? (
              <div className="space-y-1.5">
                <div className="flex gap-2">
                  <select value={editMethod} onChange={(e) => setEditMethod(e.target.value)} className={selectClass + " flex-1"}>
                    {SETTINGS_EXEC_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                  </select>
                  <select value={editModel} onChange={(e) => setEditModel(e.target.value)} className={selectClass + " flex-1"}>
                    {SETTINGS_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
                    {!SETTINGS_MODELS.includes(editModel) && <option value={editModel}>{editModel}</option>}
                  </select>
                </div>
                {/* Show only provider-appropriate options */}
                {(() => {
                  const effortOpts = getEffortOptions(editMethod, editModel);
                  const thinkingOpts = getThinkingOptions(editMethod, editModel);
                  if (!effortOpts.length && !thinkingOpts.length) return null;
                  return (
                    <div className="flex gap-2">
                      {effortOpts.length > 0 && (
                        <select value={editEffort} onChange={(e) => setEditEffort(e.target.value)} className={selectClass + " flex-1"} title="Reasoning effort">
                          {effortOpts.map((e) => <option key={e} value={e}>{e || 'effort: default'}</option>)}
                        </select>
                      )}
                      {thinkingOpts.length > 0 && (
                        <select value={editThinking} onChange={(e) => setEditThinking(e.target.value)} className={selectClass + " flex-1"} title="Thinking level">
                          {thinkingOpts.map((t) => <option key={t} value={t}>{t || 'thinking: default'}</option>)}
                        </select>
                      )}
                    </div>
                  );
                })()}
                <div className="flex gap-2">
                  <button
                    onClick={() => { const next = [...chain]; next[idx] = { method: editMethod, model: editModel, reasoningEffort: editEffort || undefined, thinkingLevel: editThinking || undefined }; save(next); }}
                    disabled={saving !== null}
                    className="text-[10px] text-green-400 hover:text-green-300 cursor-pointer disabled:opacity-50"
                  >Save</button>
                  <button onClick={() => setEditIdx(null)} className="text-[10px] text-zinc-500 hover:text-zinc-400 cursor-pointer">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {/* Priority number */}
                  <span className="text-[10px] text-zinc-600 font-mono w-4 text-right flex-shrink-0">{idx + 1}</span>
                  {/* Up/down */}
                  <div className="flex flex-col -space-y-0.5 flex-shrink-0">
                    <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-zinc-500 hover:text-zinc-300 disabled:text-zinc-800 disabled:cursor-not-allowed cursor-pointer leading-none">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" /></svg>
                    </button>
                    <button onClick={() => move(idx, 1)} disabled={idx === chain.length - 1} className="text-zinc-500 hover:text-zinc-300 disabled:text-zinc-800 disabled:cursor-not-allowed cursor-pointer leading-none">
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" /></svg>
                    </button>
                  </div>
                  {/* Badge */}
                  {idx === 0 && <span className="text-[9px] bg-shizuha-500/20 text-shizuha-400 px-1.5 py-0.5 rounded">primary</span>}
                  {idx > 0 && <span className="text-[9px] bg-zinc-800 text-zinc-500 px-1.5 py-0.5 rounded">fallback</span>}
                  {/* Method + model */}
                  <span className="text-xs text-zinc-400 font-mono">{entry.method}</span>
                  <span className="text-xs text-zinc-500">/</span>
                  <span className="text-xs text-zinc-200 font-mono truncate">{entry.model}</span>
                  {/* Effort/thinking badges */}
                  {entry.reasoningEffort && (
                    <span className="text-[9px] bg-amber-500/15 text-amber-400 px-1.5 py-0.5 rounded">{entry.reasoningEffort}</span>
                  )}
                  {entry.thinkingLevel && (
                    <span className="text-[9px] bg-blue-500/15 text-blue-400 px-1.5 py-0.5 rounded">{entry.thinkingLevel}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button onClick={() => { setEditIdx(idx); setEditMethod(entry.method); setEditModel(entry.model); setEditEffort(entry.reasoningEffort ?? ''); setEditThinking(entry.thinkingLevel ?? ''); }} className="text-[10px] text-zinc-400 hover:text-zinc-300 cursor-pointer">Edit</button>
                  {chain.length > 1 && (
                    <button onClick={() => remove(idx)} className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer">Remove</button>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Add new entry */}
        {adding && (
          <div className="px-3 py-2 border-t border-zinc-800 space-y-1.5">
            <div className="flex gap-2">
              <select value={newMethod} onChange={(e) => setNewMethod(e.target.value)} className={selectClass + " flex-1"}>
                {SETTINGS_EXEC_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <select value={newModel} onChange={(e) => setNewModel(e.target.value)} className={selectClass + " flex-1"}>
                {SETTINGS_MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            {/* Show only provider-appropriate options */}
            {(() => {
              const effortOpts = getEffortOptions(newMethod, newModel);
              const thinkingOpts = getThinkingOptions(newMethod, newModel);
              if (!effortOpts.length && !thinkingOpts.length) return null;
              return (
                <div className="flex gap-2">
                  {effortOpts.length > 0 && (
                    <select value={newEffort} onChange={(e) => setNewEffort(e.target.value)} className={selectClass + " flex-1"} title="Reasoning effort">
                      {effortOpts.map((e) => <option key={e} value={e}>{e || 'effort: default'}</option>)}
                    </select>
                  )}
                  {thinkingOpts.length > 0 && (
                    <select value={newThinking} onChange={(e) => setNewThinking(e.target.value)} className={selectClass + " flex-1"} title="Thinking level">
                      {thinkingOpts.map((t) => <option key={t} value={t}>{t || 'thinking: default'}</option>)}
                    </select>
                  )}
                </div>
              );
            })()}
            <div className="flex gap-2">
              <button
                onClick={() => save([...chain, { method: newMethod, model: newModel, reasoningEffort: newEffort || undefined, thinkingLevel: newThinking || undefined }])}
                disabled={saving !== null}
                className="text-[10px] text-green-400 hover:text-green-300 cursor-pointer disabled:opacity-50"
              >Add</button>
              <button onClick={() => setAdding(false)} className="text-[10px] text-zinc-500 hover:text-zinc-400 cursor-pointer">Cancel</button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

async function patchAgentSetting(agentId: string, updates: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`/v1/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({}));
    return { ok: false, error: body.error || `Failed (${res.status})` };
  } catch {
    return { ok: false, error: 'Network error' };
  }
}

function AgentsSection({ data, onRefresh }: { data: SettingsData; onRefresh: () => void }) {
  const dockerAvailable = data.daemon?.dockerAvailable ?? false;
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [restarting, setRestarting] = useState<string | null>(null);
  const [newAgent, setNewAgent] = useState({ name: '', username: '', role: '', email: '' });

  const handleRestart = async (agentId: string) => {
    setRestarting(agentId);
    try {
      const res = await fetch(`/v1/agents/${agentId}/restart`, { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Restart failed:', err);
      }
      setTimeout(onRefresh, 3000);
    } catch (e) {
      console.error('Restart error:', e);
    } finally {
      setRestarting(null);
    }
  };

  const handleToggle = async (agentId: string, enable: boolean) => {
    setToggling(agentId);
    try {
      const res = await fetch('/v1/agents/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentId, enabled: enable }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        console.error('Toggle failed:', err);
      }
      // Refresh settings data after a brief delay (agent needs time to start)
      setTimeout(onRefresh, enable ? 2000 : 500);
    } catch (e) {
      console.error('Toggle error:', e);
    } finally {
      setToggling(null);
    }
  };

  const startEdit = (field: string, value: string) => {
    setEditingField(field);
    setEditValue(value);
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingField(null);
    setEditValue('');
  };

  const saveAgentField = async (agentId: string, field: string, value: unknown) => {
    setSaving(field);
    setEditError(null);
    const result = await patchAgentSetting(agentId, { [field]: value });
    setSaving(null);
    if (result.ok) {
      setEditingField(null);
      onRefresh();
    } else {
      setEditError(result.error || `Failed to update ${field}`);
    }
  };

  const handleCreate = async () => {
    if (!newAgent.name.trim() || !newAgent.username.trim()) return;
    setCreating(true);
    setEditError(null);
    try {
      const res = await fetch('/v1/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newAgent.name.trim(),
          username: newAgent.username.trim().toLowerCase(),
          email: newAgent.email.trim() || undefined,
          role: newAgent.role.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to create agent' }));
        setEditError((err as { error: string }).error);
      } else {
        setShowCreate(false);
        setNewAgent({ name: '', username: '', role: '', email: '' });
        onRefresh();
      }
    } catch {
      setEditError('Network error');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (agentId: string) => {
    setDeleting(agentId);
    setEditError(null);
    try {
      const res = await fetch(`/v1/agents/${agentId}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to delete agent' }));
        setEditError((err as { error: string }).error);
      } else {
        setExpandedAgent(null);
        onRefresh();
      }
    } catch {
      setEditError('Network error');
    } finally {
      setDeleting(null);
    }
  };

  const byStatus = {
    enabled: data.agents.filter((a) => a.enabled),
    disabled: data.agents.filter((a) => !a.enabled),
  };

  return (
    <div className="space-y-6">
      <SectionHeader title="Agents" subtitle={`${data.agents.length} agents configured`} />

      {/* Summary */}
      <div className="grid grid-cols-3 gap-3">
        <StatBox
          label="Enabled"
          value={String(byStatus.enabled.length)}
          color="text-green-400"
        />
        <StatBox
          label="Disabled"
          value={String(byStatus.disabled.length)}
          color="text-zinc-500"
        />
        <StatBox
          label="Total"
          value={String(data.agents.length)}
          color="text-zinc-300"
        />
      </div>

      {/* Create agent button + form */}
      <div>
        {!showCreate ? (
          <button
            onClick={() => setShowCreate(true)}
            className="w-full py-2.5 rounded-lg border border-dashed border-zinc-700 text-xs text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors cursor-pointer"
          >
            + New Agent
          </button>
        ) : (
          <div className="bg-zinc-800/50 rounded-lg border border-zinc-700 p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-200">Create Agent</span>
              <button onClick={() => { setShowCreate(false); setEditError(null); }} className="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer">Cancel</button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                placeholder="Display name"
                value={newAgent.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setNewAgent((prev) => ({
                    ...prev,
                    name,
                    // Auto-generate username from name (lowercase, no spaces)
                    username: prev.username === '' || prev.username === prev.name.toLowerCase().replace(/[^a-z0-9]/g, '')
                      ? name.toLowerCase().replace(/[^a-z0-9]/g, '')
                      : prev.username,
                  }));
                }}
                className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-shizuha-500"
              />
              <input
                type="text"
                placeholder="username"
                value={newAgent.username}
                onChange={(e) => setNewAgent((prev) => ({ ...prev, username: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '') }))}
                className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
              />
              <input
                type="text"
                placeholder="Role (e.g. engineer)"
                value={newAgent.role}
                onChange={(e) => setNewAgent((prev) => ({ ...prev, role: e.target.value }))}
                className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-shizuha-500"
              />
              <input
                type="email"
                placeholder="Email (optional)"
                value={newAgent.email}
                onChange={(e) => setNewAgent((prev) => ({ ...prev, email: e.target.value }))}
                className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-shizuha-500"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={creating || !newAgent.name.trim() || !newAgent.username.trim()}
              className="w-full py-2 rounded-lg bg-shizuha-600 hover:bg-shizuha-500 text-white text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {creating ? 'Creating...' : 'Create Agent'}
            </button>
          </div>
        )}
      </div>

      <p className="text-[11px] text-zinc-600 leading-relaxed">
        Agents default to off. Enable an agent to start its runtime, or just send a message — the runtime starts automatically.
      </p>

      {editError && (
        <div className="text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
          {editError}
        </div>
      )}

      {/* Agent list */}
      <div className="space-y-2">
        {data.agents.map((agent) => {
          const expanded = expandedAgent === agent.id;
          const agentModel = getAgentModel(agent);
          const fieldKey = (f: string) => `${agent.id}_${f}`;

          return (
            <div
              key={agent.id}
              className="bg-zinc-800/50 rounded-lg border border-zinc-800 overflow-hidden"
            >
              {/* Agent row */}
              <button
                onClick={() => setExpandedAgent(expanded ? null : agent.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/80 transition-colors cursor-pointer"
              >
                {/* Avatar */}
                <div className={`w-9 h-9 rounded-full ${hashColor(agent.name)} flex items-center justify-center flex-shrink-0 relative`}>
                  <span className="text-xs font-bold text-white">{agent.name.slice(0, 2).toUpperCase()}</span>
                  <StatusDot status={agent.status} />
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{agent.name}</span>
                    <span className="text-[10px] text-zinc-600 font-mono">@{agent.username}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    <span className="text-[11px] text-zinc-500">{agent.role ?? 'Agent'}</span>
                    <span className="text-zinc-700">·</span>
                    <span className="text-[11px] text-zinc-500 font-mono">{agentModel}</span>
                  </div>
                </div>

                {/* Restart button */}
                {agent.enabled && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRestart(agent.id);
                    }}
                    disabled={restarting === agent.id}
                    className="p-1 rounded hover:bg-zinc-700/50 transition-colors cursor-pointer disabled:opacity-50 flex-shrink-0"
                    title="Restart agent"
                  >
                    <svg className={`w-3.5 h-3.5 text-zinc-400 ${restarting === agent.id ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                )}

                {/* Toggle switch */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggle(agent.id, !agent.enabled);
                  }}
                  disabled={toggling === agent.id}
                  className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer disabled:opacity-50 ${
                    agent.enabled ? 'bg-green-500' : 'bg-zinc-600'
                  }`}
                  title={agent.enabled ? 'Disable agent' : 'Enable agent'}
                >
                  <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${
                    agent.enabled ? 'translate-x-4' : ''
                  } ${toggling === agent.id ? 'animate-pulse' : ''}`} />
                </button>

                {/* Chevron */}
                <svg
                  className={`w-4 h-4 text-zinc-500 transition-transform ${expanded ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {/* Expanded details */}
              {expanded && (
                <div className="px-4 pb-3 border-t border-zinc-800 space-y-3 pt-3">
                  <Card>
                    <CardRow label="ID" value={agent.id} mono />

                    {/* Editable Email */}
                    {editingField === fieldKey('email') ? (
                      <div className="px-3 py-2 space-y-1.5">
                        <span className="text-xs text-zinc-400">Email</span>
                        <input
                          type="email"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') saveAgentField(agent.id, 'email', editValue);
                            if (e.key === 'Escape') cancelEdit();
                          }}
                          autoFocus
                          className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                        />
                        <InlineSaveCancel saving={saving === fieldKey('email')} onSave={() => saveAgentField(agent.id, 'email', editValue)} onCancel={cancelEdit} />
                      </div>
                    ) : (
                      <EditableCardRow label="Email" value={agent.email} mono onClick={() => startEdit(fieldKey('email'), agent.email)} />
                    )}

                    <CardRow label="Status" value={agent.status} />
                    {agent.pid && <CardRow label="PID" value={String(agent.pid)} mono />}
                    {agent.tokenPrefix && <CardRow label="Token" value={agent.tokenPrefix + '...'} mono />}
                    {agent.startedAt && <CardRow label="Started" value={formatRelativeTime(agent.startedAt)} />}

                    {/* Runtime Environment — editable dropdown */}
                    {editingField === fieldKey('runtime_env') ? (
                      <div className="px-3 py-2 space-y-1.5">
                        <span className="text-xs text-zinc-400">Runtime Environment</span>
                        <select
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                        >
                          <option value="bare_metal">Bare Metal — Direct host execution (fastest)</option>
                          <option value="container" disabled={!dockerAvailable}>Container — Docker isolated{!dockerAvailable ? ' (Docker not found)' : ''}</option>
                          <option value="restricted_container" disabled={!dockerAvailable}>Restricted Container — Docker + seccomp{!dockerAvailable ? ' (Docker not found)' : ''}</option>
                          <option value="sandbox" disabled={!dockerAvailable}>Sandbox — Fully isolated{!dockerAvailable ? ' (Docker not found)' : ''}</option>
                        </select>
                        <InlineSaveCancel
                          saving={saving === fieldKey('runtime_env')}
                          onSave={() => saveAgentField(agent.id, 'runtimeEnvironment', editValue)}
                          onCancel={cancelEdit}
                        />
                      </div>
                    ) : (
                      <EditableCardRow
                        label="Runtime"
                        value={
                          agent.runtimeEnvironment === 'sandbox' ? 'Sandbox' :
                          agent.runtimeEnvironment === 'restricted_container' ? 'Restricted Container' :
                          agent.runtimeEnvironment === 'container' ? 'Container' :
                          'Bare Metal'
                        }
                        onClick={() => startEdit(fieldKey('runtime_env'), agent.runtimeEnvironment ?? 'bare_metal')}
                      />
                    )}

                    {/* Resource Limits — only for container-based runtimes */}
                    {agent.runtimeEnvironment && agent.runtimeEnvironment !== 'bare_metal' ? (
                      editingField === fieldKey('resource_limits') ? (
                        <div className="px-3 py-2 space-y-2">
                          <span className="text-xs text-zinc-400">Resource Limits</span>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <label className="text-[10px] text-zinc-500 block mb-0.5">Memory</label>
                              <input
                                type="text"
                                placeholder="e.g. 2g, 512m"
                                defaultValue={agent.resourceLimits?.memory ?? ''}
                                onChange={(e) => setEditValue((prev) => {
                                  try { const o = JSON.parse(prev || '{}'); o.memory = e.target.value || undefined; return JSON.stringify(o); } catch { return JSON.stringify({ memory: e.target.value || undefined }); }
                                })}
                                className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-zinc-500 block mb-0.5">CPUs</label>
                              <input
                                type="text"
                                placeholder="e.g. 1.0, 0.5"
                                defaultValue={agent.resourceLimits?.cpus ?? ''}
                                onChange={(e) => setEditValue((prev) => {
                                  try { const o = JSON.parse(prev || '{}'); o.cpus = e.target.value || undefined; return JSON.stringify(o); } catch { return JSON.stringify({ cpus: e.target.value || undefined }); }
                                })}
                                className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                              />
                            </div>
                            <div>
                              <label className="text-[10px] text-zinc-500 block mb-0.5">PID Limit</label>
                              <input
                                type="number"
                                placeholder="e.g. 256"
                                defaultValue={agent.resourceLimits?.pidsLimit ?? ''}
                                onChange={(e) => setEditValue((prev) => {
                                  try { const o = JSON.parse(prev || '{}'); o.pidsLimit = e.target.value ? Number(e.target.value) : undefined; return JSON.stringify(o); } catch { return JSON.stringify({ pidsLimit: e.target.value ? Number(e.target.value) : undefined }); }
                                })}
                                className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                              />
                            </div>
                          </div>
                          <InlineSaveCancel
                            saving={saving === fieldKey('resource_limits')}
                            onSave={() => {
                              try {
                                const parsed = JSON.parse(editValue || '{}');
                                // Clean out empty values
                                const clean: Record<string, unknown> = {};
                                if (parsed.memory) clean.memory = parsed.memory;
                                if (parsed.cpus) clean.cpus = parsed.cpus;
                                if (parsed.pidsLimit) clean.pidsLimit = parsed.pidsLimit;
                                saveAgentField(agent.id, 'resourceLimits', Object.keys(clean).length > 0 ? clean : null);
                              } catch {
                                saveAgentField(agent.id, 'resourceLimits', null);
                              }
                            }}
                            onCancel={cancelEdit}
                          />
                        </div>
                      ) : (
                        <EditableCardRow
                          label="Limits"
                          value={
                            [
                              agent.resourceLimits?.memory && `RAM ${agent.resourceLimits.memory}`,
                              agent.resourceLimits?.cpus && `CPU ${agent.resourceLimits.cpus}`,
                              agent.resourceLimits?.pidsLimit && `PIDs ${agent.resourceLimits.pidsLimit}`,
                            ].filter(Boolean).join(', ') || 'No limits'
                          }
                          onClick={() => startEdit(fieldKey('resource_limits'), JSON.stringify(agent.resourceLimits ?? {}))}
                        />
                      )
                    ) : null}
                  </Card>

                  {/* Model Chain — ordered fallbacks */}
                  <ModelChainEditor agent={agent} saving={saving} onSave={(fallbacks) => saveAgentField(agent.id, 'modelFallbacks', fallbacks)} />

                  {/* Skills — editable */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Skills</h4>
                      {editingField !== fieldKey('skills') && (
                        <button onClick={() => startEdit(fieldKey('skills'), (agent.skills ?? []).join(', '))} className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer">Edit</button>
                      )}
                    </div>
                    {editingField === fieldKey('skills') ? (
                      <div className="space-y-1.5">
                        <textarea
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          rows={3}
                          placeholder="Comma-separated skills"
                          className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500 resize-none"
                        />
                        <InlineSaveCancel
                          saving={saving === fieldKey('skills')}
                          onSave={() => {
                            const skills = editValue.split(',').map((s) => s.trim()).filter(Boolean);
                            saveAgentField(agent.id, 'skills', skills);
                          }}
                          onCancel={cancelEdit}
                        />
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {(agent.skills?.length ?? 0) > 0 ? agent.skills.map((s) => (
                          <Tag key={s} text={s} />
                        )) : (
                          <span className="text-xs text-zinc-600">No skills</span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* MCP Servers */}
                  {(agent.mcpServers?.length ?? 0) > 0 && (
                    <div>
                      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">MCP Servers</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {agent.mcpServers.map((s) => (
                          <Tag key={s.slug} text={s.name} accent />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Personality — editable */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Personality</h4>
                      {editingField !== fieldKey('personality') && (
                        <button
                          onClick={() => {
                            const val = Object.entries(agent.personalityTraits ?? {}).map(([k, v]) => `${k}: ${v}`).join('\n');
                            startEdit(fieldKey('personality'), val);
                          }}
                          className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                    {editingField === fieldKey('personality') ? (
                      <div className="space-y-1.5">
                        <textarea
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          rows={4}
                          placeholder={'key: value (one per line)'}
                          className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500 resize-none"
                        />
                        <InlineSaveCancel
                          saving={saving === fieldKey('personality')}
                          onSave={() => {
                            const parsed: Record<string, string> = {};
                            editValue.split('\n').forEach((line) => {
                              const idx = line.indexOf(':');
                              if (idx > 0) {
                                parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                              }
                            });
                            saveAgentField(agent.id, 'personality_traits', parsed);
                          }}
                          onCancel={cancelEdit}
                        />
                      </div>
                    ) : Object.keys(agent.personalityTraits ?? {}).length > 0 ? (
                      <Card>
                        {Object.entries(agent.personalityTraits ?? {}).map(([k, v]) => (
                          <CardRow key={k} label={k} value={v} />
                        ))}
                      </Card>
                    ) : (
                      <span className="text-xs text-zinc-600">No traits</span>
                    )}
                  </div>

                  {/* Credentials */}
                  <CredentialsSection agent={agent} onRefresh={onRefresh} />

                  {/* Context Prompt */}
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Context Prompt</h4>
                      {editingField !== fieldKey('context_prompt') && (
                        <button onClick={() => startEdit(fieldKey('context_prompt'), agent.contextPrompt ?? '')} className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer">Edit</button>
                      )}
                    </div>
                    {editingField === fieldKey('context_prompt') ? (
                      <div className="space-y-1.5">
                        <textarea
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          rows={5}
                          placeholder="System-level instructions for this agent..."
                          className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500 resize-none"
                        />
                        <InlineSaveCancel
                          saving={saving === fieldKey('context_prompt')}
                          onSave={() => saveAgentField(agent.id, 'contextPrompt', editValue || null)}
                          onCancel={cancelEdit}
                        />
                      </div>
                    ) : (
                      <p className="text-xs text-zinc-400 whitespace-pre-wrap">{agent.contextPrompt || <span className="text-zinc-600">No context prompt set</span>}</p>
                    )}
                  </div>

                  {/* Operational Settings */}
                  <div>
                    <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Operations</h4>
                    <Card>
                      {/* Tier */}
                      {editingField === fieldKey('tier') ? (
                        <div className="px-3 py-2 space-y-1.5">
                          <span className="text-xs text-zinc-400">Tier</span>
                          <select
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                          >
                            <option value="normal">Normal — requires approval checkpoints</option>
                            <option value="superuser">Superuser — bypasses approval checkpoints</option>
                          </select>
                          <InlineSaveCancel saving={saving === fieldKey('tier')} onSave={() => saveAgentField(agent.id, 'tier', editValue)} onCancel={cancelEdit} />
                        </div>
                      ) : (
                        <EditableCardRow label="Tier" value={agent.tier === 'superuser' ? 'Superuser' : 'Normal'} onClick={() => startEdit(fieldKey('tier'), agent.tier ?? 'normal')} />
                      )}

                      {/* Max Concurrent Tasks */}
                      {editingField === fieldKey('max_concurrent') ? (
                        <div className="px-3 py-2 space-y-1.5">
                          <span className="text-xs text-zinc-400">Max Concurrent Tasks</span>
                          <input type="number" min={1} max={10} value={editValue} onChange={(e) => setEditValue(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                          />
                          <InlineSaveCancel saving={saving === fieldKey('max_concurrent')} onSave={() => saveAgentField(agent.id, 'maxConcurrentTasks', Number(editValue) || 1)} onCancel={cancelEdit} />
                        </div>
                      ) : (
                        <EditableCardRow label="Max Concurrent" value={String(agent.maxConcurrentTasks ?? 1)} onClick={() => startEdit(fieldKey('max_concurrent'), String(agent.maxConcurrentTasks ?? 1))} />
                      )}

                      {/* Warm Pool Size */}
                      {editingField === fieldKey('warm_pool') ? (
                        <div className="px-3 py-2 space-y-1.5">
                          <span className="text-xs text-zinc-400">Warm Pool Size</span>
                          <input type="number" min={0} max={5} value={editValue} onChange={(e) => setEditValue(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500"
                          />
                          <InlineSaveCancel saving={saving === fieldKey('warm_pool')} onSave={() => saveAgentField(agent.id, 'warmPoolSize', Number(editValue) || 0)} onCancel={cancelEdit} />
                        </div>
                      ) : (
                        <EditableCardRow label="Warm Pool" value={String(agent.warmPoolSize ?? 0)} onClick={() => startEdit(fieldKey('warm_pool'), String(agent.warmPoolSize ?? 0))} />
                      )}
                    </Card>
                  </div>

                  {/* Work Schedule */}
                  <WorkScheduleSection agent={agent} editing={editingField} fieldKey={fieldKey} startEdit={startEdit} cancelEdit={cancelEdit} editValue={editValue} setEditValue={setEditValue} saving={saving} saveAgentField={saveAgentField} />

                  {/* Token Budget */}
                  <TokenBudgetSection agent={agent} editing={editingField} fieldKey={fieldKey} startEdit={startEdit} cancelEdit={cancelEdit} editValue={editValue} setEditValue={setEditValue} saving={saving} saveAgentField={saveAgentField} />

                  {/* Error */}
                  {agent.error && (
                    <div className="text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
                      {agent.error}
                    </div>
                  )}

                  {/* Delete */}
                  <div className="pt-2 border-t border-zinc-800">
                    <button
                      onClick={() => {
                        if (confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) {
                          handleDelete(agent.id);
                        }
                      }}
                      disabled={deleting === agent.id}
                      className="text-[11px] text-red-400 hover:text-red-300 transition-colors cursor-pointer disabled:opacity-50"
                    >
                      {deleting === agent.id ? 'Deleting...' : 'Delete this agent'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Credentials sub-component ──

const CREDENTIAL_SERVICES = [
  { value: 'github', label: 'GitHub', fields: [{ key: 'token', label: 'Personal Access Token', envDefault: 'GITHUB_TOKEN' }] },
  { value: 'gitlab', label: 'GitLab', fields: [{ key: 'token', label: 'Access Token', envDefault: 'GITLAB_TOKEN' }] },
  { value: 'aws', label: 'AWS', fields: [{ key: 'access_key_id', label: 'Access Key ID', envDefault: 'AWS_ACCESS_KEY_ID' }, { key: 'secret_access_key', label: 'Secret Access Key', envDefault: 'AWS_SECRET_ACCESS_KEY' }] },
  { value: 'npm', label: 'NPM', fields: [{ key: 'token', label: 'Auth Token', envDefault: 'NPM_TOKEN' }] },
  { value: 'docker', label: 'Docker Hub', fields: [{ key: 'username', label: 'Username', envDefault: 'DOCKER_USERNAME' }, { key: 'password', label: 'Password', envDefault: 'DOCKER_PASSWORD' }] },
  { value: 'custom', label: 'Custom', fields: [] },
];

function CredentialsSection({ agent, onRefresh }: { agent: Agent & { startedAt?: string }; onRefresh: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [service, setService] = useState('github');
  const [label, setLabel] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [envMapping, setEnvMapping] = useState<Record<string, string>>({});
  const [customKey, setCustomKey] = useState('');
  const [customEnvName, setCustomEnvName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const serviceDef = CREDENTIAL_SERVICES.find((s) => s.value === service);

  const handleAdd = async () => {
    const credData: Record<string, string> = {};
    const envMap: Record<string, string> = {};

    if (service === 'custom') {
      if (!customKey || !fields[customKey]) return;
      credData[customKey] = fields[customKey]!;
      if (customEnvName) envMap[customKey] = customEnvName;
    } else {
      for (const f of serviceDef?.fields ?? []) {
        if (fields[f.key]) {
          credData[f.key] = fields[f.key]!;
          envMap[f.key] = envMapping[f.key] || f.envDefault;
        }
      }
    }

    if (Object.keys(credData).length === 0) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/v1/agents/${agent.id}/credentials`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service,
          label: label || `${serviceDef?.label ?? service} credential`,
          credentialData: credData,
          injectAsEnv: true,
          envMapping: Object.keys(envMap).length > 0 ? envMap : undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError((body as { error?: string }).error || 'Failed to add credential');
      } else {
        setShowAdd(false);
        setFields({});
        setEnvMapping({});
        setLabel('');
        setCustomKey('');
        setCustomEnvName('');
        onRefresh();
      }
    } catch {
      setError('Network error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (credId: string) => {
    setDeleting(credId);
    try {
      await fetch(`/v1/agents/${agent.id}/credentials/${credId}`, { method: 'DELETE' });
      onRefresh();
    } finally {
      setDeleting(null);
    }
  };

  const handleToggle = async (credId: string, active: boolean) => {
    await fetch(`/v1/agents/${agent.id}/credentials/${credId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: active }),
    });
    onRefresh();
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Credentials</h4>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer">+ Add</button>
        )}
      </div>

      {error && (
        <div className="text-[10px] text-red-400 bg-red-950/30 px-2 py-1 rounded mb-2 border border-red-900/30">{error}</div>
      )}

      {/* Existing credentials */}
      {(agent.credentials?.length ?? 0) > 0 ? (
        <div className="space-y-1.5">
          {agent.credentials!.map((cred) => (
            <div key={cred.id} className="flex items-center gap-2 bg-zinc-800/40 rounded px-3 py-2 border border-zinc-800">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-zinc-200">{cred.label}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-400">{cred.service}</span>
                </div>
                <div className="text-[10px] text-zinc-500 mt-0.5 font-mono">
                  {Object.entries(cred.credentialData).map(([k, v]) => `${k}=${v}`).join(', ')}
                </div>
                {cred.envMapping && (
                  <div className="text-[10px] text-zinc-600 mt-0.5">
                    Env: {Object.entries(cred.envMapping).map(([k, envName]) => `${envName}`).join(', ')}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={() => handleToggle(cred.id, !cred.isActive)}
                  className={`w-7 h-4 rounded-full transition-colors cursor-pointer ${cred.isActive ? 'bg-green-500' : 'bg-zinc-600'}`}
                  title={cred.isActive ? 'Active' : 'Inactive'}
                >
                  <span className={`block w-3 h-3 rounded-full bg-white transition-transform ml-0.5 ${cred.isActive ? 'translate-x-3' : ''}`} />
                </button>
                <button
                  onClick={() => handleDelete(cred.id)}
                  disabled={deleting === cred.id}
                  className="text-[10px] text-red-400/70 hover:text-red-300 cursor-pointer disabled:opacity-50"
                >
                  {deleting === cred.id ? '...' : 'x'}
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : !showAdd ? (
        <span className="text-xs text-zinc-600">No credentials configured</span>
      ) : null}

      {/* Add credential form */}
      {showAdd && (
        <div className="mt-2 bg-zinc-800/50 rounded-lg border border-zinc-700 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-zinc-200">Add Credential</span>
            <button onClick={() => { setShowAdd(false); setError(null); }} className="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer">Cancel</button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <select value={service} onChange={(e) => { setService(e.target.value); setFields({}); setEnvMapping({}); }}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-shizuha-500">
              {CREDENTIAL_SERVICES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
            <input type="text" placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)}
              className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 focus:outline-none focus:border-shizuha-500" />
          </div>

          {service === 'custom' ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <input type="text" placeholder="Key name (e.g. api_key)" value={customKey} onChange={(e) => setCustomKey(e.target.value)}
                  className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
                <input type="text" placeholder="Env var name (e.g. MY_API_KEY)" value={customEnvName} onChange={(e) => setCustomEnvName(e.target.value)}
                  className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
              </div>
              {customKey && (
                <input type="password" placeholder="Value" value={fields[customKey] ?? ''} onChange={(e) => setFields((p) => ({ ...p, [customKey]: e.target.value }))}
                  className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {serviceDef?.fields.map((f) => (
                <div key={f.key}>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-[10px] text-zinc-400">{f.label}</label>
                    <span className="text-[10px] text-zinc-600 font-mono">${envMapping[f.key] || f.envDefault}</span>
                  </div>
                  <input type="password" placeholder={f.label} value={fields[f.key] ?? ''} onChange={(e) => setFields((p) => ({ ...p, [f.key]: e.target.value }))}
                    className="w-full bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
                </div>
              ))}
            </div>
          )}

          <button onClick={handleAdd} disabled={saving}
            className="w-full py-1.5 rounded bg-shizuha-600 hover:bg-shizuha-500 text-white text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer">
            {saving ? 'Adding...' : 'Add Credential'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Work Schedule sub-component ──

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function WorkScheduleSection({ agent, editing, fieldKey, startEdit, cancelEdit, editValue, setEditValue, saving, saveAgentField }: {
  agent: Agent & { startedAt?: string };
  editing: string | null;
  fieldKey: (f: string) => string;
  startEdit: (field: string, value: string) => void;
  cancelEdit: () => void;
  editValue: string;
  setEditValue: (v: string | ((prev: string) => string)) => void;
  saving: string | null;
  saveAgentField: (agentId: string, field: string, value: unknown) => Promise<void>;
}) {
  const schedule = agent.workSchedule;
  const fk = fieldKey('work_schedule');

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Work Schedule</h4>
        {editing !== fk && (
          <button onClick={() => startEdit(fk, JSON.stringify(schedule ?? { days: [0,1,2,3,4], startHour: 9, endHour: 18, timezone: 'UTC' }))} className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer">Edit</button>
        )}
      </div>
      {editing === fk ? (() => {
        let parsed = { days: [0,1,2,3,4], startHour: 9, endHour: 18, timezone: 'UTC' };
        try { parsed = JSON.parse(editValue); } catch {}
        return (
          <div className="space-y-2.5">
            {/* Days */}
            <div>
              <span className="text-[10px] text-zinc-400 block mb-1">Active Days</span>
              <div className="flex gap-1">
                {DAY_LABELS.map((d, i) => (
                  <button key={d}
                    onClick={() => {
                      const days = parsed.days.includes(i) ? parsed.days.filter((x: number) => x !== i) : [...parsed.days, i].sort();
                      setEditValue(JSON.stringify({ ...parsed, days }));
                    }}
                    className={`px-2 py-1 rounded text-[10px] font-medium cursor-pointer transition-colors ${
                      parsed.days.includes(i) ? 'bg-shizuha-600 text-white' : 'bg-zinc-800 text-zinc-500'
                    }`}
                  >{d}</button>
                ))}
              </div>
            </div>
            {/* Hours */}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-zinc-500 block mb-0.5">Start Hour</label>
                <input type="number" min={0} max={23} value={parsed.startHour}
                  onChange={(e) => setEditValue(JSON.stringify({ ...parsed, startHour: Number(e.target.value) }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 block mb-0.5">End Hour</label>
                <input type="number" min={0} max={23} value={parsed.endHour}
                  onChange={(e) => setEditValue(JSON.stringify({ ...parsed, endHour: Number(e.target.value) }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 block mb-0.5">Timezone</label>
                <input type="text" value={parsed.timezone}
                  onChange={(e) => setEditValue(JSON.stringify({ ...parsed, timezone: e.target.value }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
              </div>
            </div>
            <InlineSaveCancel saving={saving === fk} onSave={() => saveAgentField(agent.id, 'workSchedule', JSON.parse(editValue))} onCancel={cancelEdit} />
            <button onClick={() => saveAgentField(agent.id, 'workSchedule', null)} className="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer">Clear schedule</button>
          </div>
        );
      })() : schedule ? (
        <Card>
          <CardRow label="Days" value={schedule.days.map((d) => DAY_LABELS[d] ?? d).join(', ')} />
          <CardRow label="Hours" value={`${String(schedule.startHour).padStart(2, '0')}:00 – ${String(schedule.endHour).padStart(2, '0')}:00`} />
          <CardRow label="Timezone" value={schedule.timezone} />
        </Card>
      ) : (
        <span className="text-xs text-zinc-600">Always available (no schedule set)</span>
      )}
    </div>
  );
}

// ── Token Budget sub-component ──

function TokenBudgetSection({ agent, editing, fieldKey, startEdit, cancelEdit, editValue, setEditValue, saving, saveAgentField }: {
  agent: Agent & { startedAt?: string };
  editing: string | null;
  fieldKey: (f: string) => string;
  startEdit: (field: string, value: string) => void;
  cancelEdit: () => void;
  editValue: string;
  setEditValue: (v: string | ((prev: string) => string)) => void;
  saving: string | null;
  saveAgentField: (agentId: string, field: string, value: unknown) => Promise<void>;
}) {
  const budget = agent.tokenBudget;
  const fk = fieldKey('token_budget');

  const formatTokens = (n: number) => {
    if (n === 0) return 'Unlimited';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
    return String(n);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Token Budget</h4>
        {editing !== fk && (
          <button onClick={() => startEdit(fk, JSON.stringify(budget ?? { monthlyLimit: 0, tokensUsed: 0, resetDay: 1 }))} className="text-[10px] text-shizuha-400 hover:text-shizuha-300 cursor-pointer">Edit</button>
        )}
      </div>
      {editing === fk ? (() => {
        let parsed = { monthlyLimit: 0, tokensUsed: 0, resetDay: 1 };
        try { parsed = JSON.parse(editValue); } catch {}
        return (
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] text-zinc-500 block mb-0.5">Monthly Limit</label>
                <input type="number" min={0} value={parsed.monthlyLimit}
                  onChange={(e) => setEditValue(JSON.stringify({ ...parsed, monthlyLimit: Number(e.target.value) }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
                <span className="text-[9px] text-zinc-600">0 = unlimited</span>
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 block mb-0.5">Tokens Used</label>
                <input type="number" min={0} value={parsed.tokensUsed}
                  onChange={(e) => setEditValue(JSON.stringify({ ...parsed, tokensUsed: Number(e.target.value) }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
              </div>
              <div>
                <label className="text-[10px] text-zinc-500 block mb-0.5">Reset Day</label>
                <input type="number" min={1} max={28} value={parsed.resetDay}
                  onChange={(e) => setEditValue(JSON.stringify({ ...parsed, resetDay: Number(e.target.value) }))}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-2 py-1 text-xs text-zinc-200 font-mono focus:outline-none focus:border-shizuha-500" />
              </div>
            </div>
            <InlineSaveCancel saving={saving === fk} onSave={() => saveAgentField(agent.id, 'tokenBudget', JSON.parse(editValue))} onCancel={cancelEdit} />
            <button onClick={() => saveAgentField(agent.id, 'tokenBudget', null)} className="text-[10px] text-zinc-500 hover:text-zinc-300 cursor-pointer">Clear budget</button>
          </div>
        );
      })() : budget ? (
        <Card>
          <CardRow label="Monthly Limit" value={formatTokens(budget.monthlyLimit)} />
          <CardRow label="Used" value={formatTokens(budget.tokensUsed)} />
          {budget.monthlyLimit > 0 && (
            <div className="px-3 py-2">
              <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${budget.tokensUsed / budget.monthlyLimit > 0.9 ? 'bg-red-500' : budget.tokensUsed / budget.monthlyLimit > 0.7 ? 'bg-amber-500' : 'bg-green-500'}`}
                  style={{ width: `${Math.min(100, (budget.tokensUsed / budget.monthlyLimit) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-zinc-500 mt-0.5 block">{Math.round((budget.tokensUsed / budget.monthlyLimit) * 100)}% used</span>
            </div>
          )}
          <CardRow label="Resets on" value={`Day ${budget.resetDay} of each month`} />
        </Card>
      ) : (
        <span className="text-xs text-zinc-600">No budget set (unlimited)</span>
      )}
    </div>
  );
}

const CHANNEL_LABELS: Record<string, { label: string; description: string }> = {
  'http': { label: 'HTTP / Dashboard', description: 'Browser and mobile app connections' },
  'shizuha-ws': { label: 'Shizuha Platform', description: 'SaaS platform WebSocket channel' },
  'telegram': { label: 'Telegram', description: 'Telegram Bot messages' },
  'discord': { label: 'Discord', description: 'Discord bot messages' },
  'whatsapp': { label: 'WhatsApp', description: 'WhatsApp Business API (per-message cost)' },
  'slack': { label: 'Slack', description: 'Slack Events API' },
  'cli': { label: 'CLI', description: 'stdin/stdout pipe mode' },
};

function FanOutSection() {
  const [fanOut, setFanOut] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    fetch('/v1/fan-out')
      .then((res) => res.json())
      .then((data: any) => setFanOut(data.fanOut ?? {}))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const toggle = async (channelType: string, enabled: boolean) => {
    setSaving(channelType);
    try {
      const res = await fetch('/v1/fan-out', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelType, enabled }),
      });
      if (res.ok) {
        const data: any = await res.json();
        setFanOut(data.fanOut ?? {});
      }
    } catch {
      // ignore
    } finally {
      setSaving(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
      </div>
    );
  }

  const channels = Object.entries(fanOut);

  return (
    <div className="space-y-6">
      <SectionHeader
        title="Cross-Channel Fan-out"
        subtitle="When the agent responds on one channel, broadcast to others"
      />

      <div className="text-[11px] text-zinc-500 leading-relaxed">
        Fan-out ensures the agent's work is visible everywhere — dashboard, Telegram, Discord, etc.
        Push channels (Telegram, Discord) receive a single summary message on completion.
        WhatsApp is off by default due to per-message costs.
      </div>

      <Card>
        {channels.map(([type, enabled]) => {
          const info = CHANNEL_LABELS[type] ?? { label: type, description: '' };
          return (
            <div key={type} className="flex items-center justify-between px-3 py-2.5">
              <div>
                <div className="text-xs text-zinc-200">{info.label}</div>
                {info.description && (
                  <div className="text-[10px] text-zinc-600 mt-0.5">{info.description}</div>
                )}
              </div>
              <button
                onClick={() => toggle(type, !enabled)}
                disabled={saving === type}
                className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer disabled:opacity-50 ${
                  enabled ? 'bg-green-500' : 'bg-zinc-600'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow-sm ${
                  enabled ? 'translate-x-4' : ''
                } ${saving === type ? 'animate-pulse' : ''}`} />
              </button>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

function ConnectionSection({ data }: { data: SettingsData }) {
  return (
    <div className="space-y-6">
      <SectionHeader title="Connection" />

      {/* Daemon */}
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Daemon</h3>
        <Card>
          {data.daemon ? (
            <>
              <CardRow label="Status" value="Running" />
              <CardRow label="PID" value={String(data.daemon.pid)} mono />
              <CardRow label="Platform" value={data.daemon.platformUrl} mono />
              <CardRow label="Started" value={formatRelativeTime(data.daemon.startedAt)} />
              <CardRow label="Agents" value={String(data.daemon.agentCount)} />
            </>
          ) : (
            <CardRow label="Status" value="Not running" />
          )}
        </Card>
      </div>

      {/* Connected runners */}
      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">
          Connected Runners ({data.runners.length})
        </h3>
        {data.runners.length > 0 ? (
          <Card>
            {data.runners.map((r, i) => (
              <div key={i} className="flex items-center justify-between px-3 py-2">
                <div>
                  <span className="text-xs text-zinc-200">{r.agent_name ?? r.agent_id?.slice(0, 8)}</span>
                  <span className="text-[10px] text-zinc-600 ml-2 font-mono">{r.token_prefix}</span>
                </div>
                <span className="text-[10px] text-zinc-500">
                  {r.connected_at ? formatRelativeTime(r.connected_at) : '—'}
                </span>
              </div>
            ))}
          </Card>
        ) : (
          <div className="text-xs text-zinc-600 bg-zinc-800/50 rounded-lg border border-zinc-800 px-3 py-3 text-center">
            No runners connected
          </div>
        )}
      </div>
    </div>
  );
}

function ProvidersSection({ data, onRefresh }: { data: SettingsData; onRefresh: () => void }) {
  const { providers } = data;
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [newAnthropicToken, setNewAnthropicToken] = useState('');
  const [newAnthropicLabel, setNewAnthropicLabel] = useState('');
  const [newOpenAIKey, setNewOpenAIKey] = useState('');
  const [newGoogleKey, setNewGoogleKey] = useState('');
  const [newCodexEmail, setNewCodexEmail] = useState('');
  const [newCodexAccessToken, setNewCodexAccessToken] = useState('');
  const [newCodexRefreshToken, setNewCodexRefreshToken] = useState('');
  const [newCodexAccountId, setNewCodexAccountId] = useState('');
  const [newCopilotToken, setNewCopilotToken] = useState('');
  const [copilotTestResult, setCopilotTestResult] = useState<{ ok: boolean; status: string; message?: string; error?: string } | null>(null);
  const [copilotTesting, setCopilotTesting] = useState(false);

  // Codex account testing
  const [testingAccount, setTestingAccount] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; status: string; message?: string; error?: string }>>({});

  // Device auth flow
  const [deviceAuth, setDeviceAuth] = useState<{
    active: boolean;
    userCode?: string;
    verificationUrl?: string;
    sessionId?: string;
    status?: string;
    error?: string;
  }>({ active: false });

  const testCodexAccount = async (email: string) => {
    setTestingAccount(email);
    setTestResults((prev) => ({ ...prev, [email]: undefined as any }));
    try {
      const res = await fetch('/v1/providers/codex/accounts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const result = await res.json();
      setTestResults((prev) => ({ ...prev, [email]: result }));
      if (result.refreshed) onRefresh(); // refresh display if tokens were updated
    } catch {
      setTestResults((prev) => ({ ...prev, [email]: { ok: false, status: 'network_error', error: 'Network error' } }));
    } finally {
      setTestingAccount(null);
    }
  };

  const moveCodexAccount = async (idx: number, direction: -1 | 1) => {
    const accounts = [...providers.codex.accounts];
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= accounts.length) return;
    // Swap
    [accounts[idx], accounts[newIdx]] = [accounts[newIdx]!, accounts[idx]!];
    const emails = accounts.map((a) => a.email);
    await apiCall('/v1/providers/codex/accounts/reorder', 'POST', { emails });
  };

  const startDeviceAuth = async () => {
    setDeviceAuth({ active: true });
    try {
      const res = await fetch('/v1/providers/codex/device-auth/start', { method: 'POST' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed to start' }));
        setDeviceAuth({ active: false, error: err.error });
        return;
      }
      const data = await res.json();
      setDeviceAuth({
        active: true,
        userCode: data.userCode,
        verificationUrl: data.verificationUrl,
        sessionId: data.sessionId,
        status: 'pending',
      });

      // Poll for completion
      const pollInterval = setInterval(async () => {
        try {
          const pollRes = await fetch(`/v1/providers/codex/device-auth/poll/${data.sessionId}`);
          if (!pollRes.ok) { clearInterval(pollInterval); setDeviceAuth({ active: false, error: 'Session expired' }); return; }
          const pollData = await pollRes.json();
          if (pollData.status === 'complete') {
            clearInterval(pollInterval);
            setDeviceAuth({ active: false });
            onRefresh();
          } else if (pollData.status === 'error') {
            clearInterval(pollInterval);
            setDeviceAuth({ active: false, error: pollData.error });
          }
        } catch { /* keep polling */ }
      }, 3000);

      // Stop polling after 16 minutes
      setTimeout(() => clearInterval(pollInterval), 16 * 60 * 1000);
    } catch {
      setDeviceAuth({ active: false, error: 'Network error' });
    }
  };

  const apiCall = async (url: string, method: string, body?: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: 'Request failed' }));
        setError(errData.error || 'Request failed');
        return false;
      }
      onRefresh();
      return true;
    } catch {
      setError('Network error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const providerCards = [
    {
      key: 'anthropic',
      name: 'Anthropic',
      subtitle: 'Claude models (API key)',
      configured: providers.anthropic.configured,
      detail: providers.anthropic.tokens.length > 0 ? `${providers.anthropic.tokens.length} token(s)` : null,
    },
    {
      key: 'openai',
      name: 'OpenAI',
      subtitle: 'GPT models (API key)',
      configured: providers.openai.configured,
      detail: providers.openai.keyPrefix,
    },
    {
      key: 'google',
      name: 'Google',
      subtitle: 'Gemini models (API key)',
      configured: providers.google.configured,
      detail: providers.google.keyPrefix,
    },
    {
      key: 'codex',
      name: 'Codex (ChatGPT)',
      subtitle: 'ChatGPT backend accounts',
      configured: providers.codex.configured,
      detail: providers.codex.accounts.length > 0 ? `${providers.codex.accounts.length} account(s)` : null,
    },
    {
      key: 'copilot',
      name: 'GitHub Copilot',
      subtitle: 'Claude models via Copilot Pro+',
      configured: providers.copilot?.configured ?? false,
      detail: providers.copilot?.tokenPrefix ?? null,
    },
  ];

  return (
    <div className="space-y-6">
      <SectionHeader title="Providers" subtitle="LLM provider credentials" />

      {error && (
        <div className="text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
          {error}
        </div>
      )}

      <div className="space-y-2">
        {providerCards.map((p) => {
          const isExpanded = expanded === p.key;
          return (
            <div key={p.key} className="bg-zinc-800/50 rounded-lg border border-zinc-800 overflow-hidden">
              <button
                onClick={() => setExpanded(isExpanded ? null : p.key)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-800/80 transition-colors cursor-pointer"
              >
                <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${p.configured ? 'bg-green-400' : 'bg-zinc-600'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{p.name}</span>
                    {p.detail && <span className="text-[10px] text-zinc-500 font-mono">{p.detail}</span>}
                  </div>
                  <span className="text-[11px] text-zinc-500">{p.subtitle}</span>
                </div>
                <span className={`text-[10px] font-medium ${p.configured ? 'text-green-400' : 'text-zinc-600'}`}>
                  {p.configured ? 'Active' : 'Not set'}
                </span>
                <svg
                  className={`w-4 h-4 text-zinc-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                >
                  <path strokeLinecap="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              {isExpanded && (
                <div className="px-4 pb-4 border-t border-zinc-800 pt-3 space-y-3">
                  {p.key === 'anthropic' && (
                    <>
                      {providers.anthropic.tokens.length > 0 && (
                        <div>
                          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Tokens</h4>
                          <Card>
                            {providers.anthropic.tokens.map((t) => (
                              <div key={t.label} className="flex items-center justify-between px-3 py-2">
                                <div className="flex-1 min-w-0">
                                  <span className="text-xs text-zinc-200">{t.label}</span>
                                  <span className="text-[10px] text-zinc-600 ml-2 font-mono">{t.prefix}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                  {t.addedAt && <span className="text-[10px] text-zinc-600">{formatRelativeTime(t.addedAt)}</span>}
                                  <button
                                    onClick={() => apiCall(`/v1/providers/anthropic/tokens/${encodeURIComponent(t.label)}`, 'DELETE')}
                                    disabled={busy}
                                    className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                                  >
                                    Remove
                                  </button>
                                </div>
                              </div>
                            ))}
                          </Card>
                        </div>
                      )}
                      <div>
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Add Token</h4>
                        <div className="space-y-2">
                          <input
                            type="password"
                            placeholder="API key (sk-ant-...)"
                            value={newAnthropicToken}
                            onChange={(e) => setNewAnthropicToken(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                          />
                          <div className="flex gap-2">
                            <input
                              type="text"
                              placeholder="Label (optional)"
                              value={newAnthropicLabel}
                              onChange={(e) => setNewAnthropicLabel(e.target.value)}
                              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                            />
                            <button
                              onClick={async () => {
                                const ok = await apiCall('/v1/providers/anthropic/tokens', 'POST', {
                                  token: newAnthropicToken,
                                  label: newAnthropicLabel || undefined,
                                });
                                if (ok) { setNewAnthropicToken(''); setNewAnthropicLabel(''); }
                              }}
                              disabled={busy || !newAnthropicToken}
                              className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      </div>
                      {providers.anthropic.configured && (
                        <button
                          onClick={() => apiCall('/v1/providers/anthropic', 'DELETE')}
                          disabled={busy}
                          className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                        >
                          Remove all Anthropic tokens
                        </button>
                      )}
                    </>
                  )}

                  {p.key === 'openai' && (
                    <>
                      {providers.openai.configured && (
                        <Card>
                          <div className="flex items-center justify-between px-3 py-2">
                            <div>
                              <span className="text-xs text-zinc-400">API Key</span>
                              <span className="text-xs text-zinc-200 ml-2 font-mono">{providers.openai.keyPrefix}</span>
                            </div>
                            <button
                              onClick={() => apiCall('/v1/providers/openai', 'DELETE')}
                              disabled={busy}
                              className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </div>
                        </Card>
                      )}
                      <div>
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
                          {providers.openai.configured ? 'Replace API Key' : 'Set API Key'}
                        </h4>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            placeholder="sk-..."
                            value={newOpenAIKey}
                            onChange={(e) => setNewOpenAIKey(e.target.value)}
                            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                          />
                          <button
                            onClick={async () => {
                              const ok = await apiCall('/v1/providers/openai', 'PUT', { apiKey: newOpenAIKey });
                              if (ok) setNewOpenAIKey('');
                            }}
                            disabled={busy || !newOpenAIKey}
                            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {p.key === 'google' && (
                    <>
                      {providers.google.configured && (
                        <Card>
                          <div className="flex items-center justify-between px-3 py-2">
                            <div>
                              <span className="text-xs text-zinc-400">API Key</span>
                              <span className="text-xs text-zinc-200 ml-2 font-mono">{providers.google.keyPrefix}</span>
                            </div>
                            <button
                              onClick={() => apiCall('/v1/providers/google', 'DELETE')}
                              disabled={busy}
                              className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </div>
                        </Card>
                      )}
                      <div>
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
                          {providers.google.configured ? 'Replace API Key' : 'Set API Key'}
                        </h4>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            placeholder="AIza..."
                            value={newGoogleKey}
                            onChange={(e) => setNewGoogleKey(e.target.value)}
                            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                          />
                          <button
                            onClick={async () => {
                              const ok = await apiCall('/v1/providers/google', 'PUT', { apiKey: newGoogleKey });
                              if (ok) setNewGoogleKey('');
                            }}
                            disabled={busy || !newGoogleKey}
                            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </>
                  )}

                  {p.key === 'codex' && (
                    <>
                      {providers.codex.accounts.length > 0 && (
                        <div>
                          <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Accounts (priority order — tried top to bottom)</h4>
                          <Card>
                            {providers.codex.accounts.map((a, idx) => {
                              const result = testResults[a.email];
                              const total = providers.codex.accounts.length;
                              return (
                                <div key={a.email} className="px-3 py-2 space-y-1">
                                  <div className="flex items-center justify-between">
                                    <div className="flex-1 min-w-0 flex items-center gap-2">
                                      {/* Priority number */}
                                      <span className="text-[10px] text-zinc-600 font-mono w-4 text-right flex-shrink-0">{idx + 1}</span>
                                      {/* Up/down arrows */}
                                      <div className="flex flex-col -space-y-0.5 flex-shrink-0">
                                        <button
                                          onClick={() => moveCodexAccount(idx, -1)}
                                          disabled={idx === 0 || busy}
                                          className="text-zinc-500 hover:text-zinc-300 disabled:text-zinc-800 disabled:cursor-not-allowed cursor-pointer leading-none"
                                        >
                                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                                          </svg>
                                        </button>
                                        <button
                                          onClick={() => moveCodexAccount(idx, 1)}
                                          disabled={idx === total - 1 || busy}
                                          className="text-zinc-500 hover:text-zinc-300 disabled:text-zinc-800 disabled:cursor-not-allowed cursor-pointer leading-none"
                                        >
                                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                                          </svg>
                                        </button>
                                      </div>
                                      {/* Status dot */}
                                      {result && (
                                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                          result.status === 'working' ? 'bg-green-400' :
                                          result.status === 'rate_limited' ? 'bg-yellow-400' :
                                          'bg-red-400'
                                        }`} />
                                      )}
                                      <span className="text-xs text-zinc-200 truncate">{a.email}</span>
                                      <span className="text-[10px] text-zinc-600 font-mono flex-shrink-0">{a.accountId.slice(0, 12)}...</span>
                                    </div>
                                    <div className="flex items-center gap-2 flex-shrink-0">
                                      {a.lastRefresh && <span className="text-[10px] text-zinc-600">refreshed {formatRelativeTime(a.lastRefresh)}</span>}
                                      <button
                                        onClick={() => testCodexAccount(a.email)}
                                        disabled={testingAccount === a.email}
                                        className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer disabled:opacity-50"
                                      >
                                        {testingAccount === a.email ? (
                                          <span className="flex items-center gap-1">
                                            <span className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin inline-block" />
                                            Testing
                                          </span>
                                        ) : 'Test'}
                                      </button>
                                      <button
                                        onClick={() => apiCall(`/v1/providers/codex/accounts/${encodeURIComponent(a.email)}`, 'DELETE')}
                                        disabled={busy}
                                        className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                  {/* Test result message */}
                                  {result && (
                                    <div className={`text-[10px] px-1 pl-10 ${
                                      result.status === 'working' ? 'text-green-400' :
                                      result.status === 'rate_limited' ? 'text-yellow-400' :
                                      'text-red-400'
                                    }`}>
                                      {result.message || result.error}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </Card>
                        </div>
                      )}
                      <div>
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">Add Account</h4>

                        {/* Device auth flow */}
                        {deviceAuth.active && deviceAuth.userCode ? (
                          <div className="mb-3 bg-zinc-800/50 border border-zinc-700 rounded-lg p-3 space-y-2">
                            <div className="text-xs text-zinc-300">
                              1. Open <a href={deviceAuth.verificationUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{deviceAuth.verificationUrl}</a>
                            </div>
                            <div className="text-xs text-zinc-300">2. Enter this code:</div>
                            <div className="flex items-center gap-2">
                              <code className="text-lg font-bold text-zinc-100 bg-zinc-900 px-3 py-1 rounded font-mono tracking-wider">{deviceAuth.userCode}</code>
                              <button
                                onClick={() => navigator.clipboard.writeText(deviceAuth.userCode!)}
                                className="text-[10px] text-zinc-400 hover:text-zinc-300 cursor-pointer"
                              >
                                Copy
                              </button>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                              <span className="w-3 h-3 border border-zinc-500 border-t-transparent rounded-full animate-spin inline-block" />
                              Waiting for authorization (expires in 15 min)...
                            </div>
                            <button
                              onClick={() => setDeviceAuth({ active: false })}
                              className="text-[10px] text-zinc-500 hover:text-zinc-400 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : deviceAuth.error ? (
                          <div className="mb-3 text-xs text-red-400 bg-red-950/30 px-3 py-2 rounded-lg border border-red-900/30">
                            {deviceAuth.error}
                            <button onClick={() => setDeviceAuth({ active: false })} className="ml-2 text-zinc-400 hover:text-zinc-300 cursor-pointer">Dismiss</button>
                          </div>
                        ) : null}

                        <div className="space-y-2">
                          {/* Device auth button */}
                          <button
                            onClick={startDeviceAuth}
                            disabled={deviceAuth.active}
                            className="w-full px-3 py-2 bg-emerald-700 hover:bg-emerald-600 text-xs text-white rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 5.25a3 3 0 0 1 3 3m3 0a6 6 0 0 1-7.029 5.912c-.563-.097-1.159.026-1.563.43L10.5 17.25H8.25v2.25H6v2.25H2.25v-2.818c0-.597.237-1.17.659-1.591l6.499-6.499c.404-.404.527-1 .43-1.563A6 6 0 1 1 21.75 8.25Z" />
                            </svg>
                            Sign in with ChatGPT (Device Code)
                          </button>

                          <div className="flex items-center gap-2 py-1">
                            <div className="flex-1 h-px bg-zinc-800" />
                            <span className="text-[10px] text-zinc-600">or add manually</span>
                            <div className="flex-1 h-px bg-zinc-800" />
                          </div>

                          <input
                            type="email"
                            placeholder="Email"
                            value={newCodexEmail}
                            onChange={(e) => setNewCodexEmail(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                          />
                          <input
                            type="text"
                            placeholder="Account ID"
                            value={newCodexAccountId}
                            onChange={(e) => setNewCodexAccountId(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                          />
                          <input
                            type="password"
                            placeholder="Access token"
                            value={newCodexAccessToken}
                            onChange={(e) => setNewCodexAccessToken(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                          />
                          <div className="flex gap-2">
                            <input
                              type="password"
                              placeholder="Refresh token"
                              value={newCodexRefreshToken}
                              onChange={(e) => setNewCodexRefreshToken(e.target.value)}
                              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                            />
                            <button
                              onClick={async () => {
                                const ok = await apiCall('/v1/providers/codex/accounts', 'POST', {
                                  email: newCodexEmail,
                                  accessToken: newCodexAccessToken,
                                  refreshToken: newCodexRefreshToken,
                                  accountId: newCodexAccountId,
                                });
                                if (ok) {
                                  setNewCodexEmail(''); setNewCodexAccessToken('');
                                  setNewCodexRefreshToken(''); setNewCodexAccountId('');
                                }
                              }}
                              disabled={busy || !newCodexEmail || !newCodexAccessToken || !newCodexRefreshToken || !newCodexAccountId}
                              className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      </div>
                    </>
                  )}

                  {p.key === 'copilot' && (
                    <>
                      {providers.copilot?.configured && (
                        <Card>
                          <div className="flex items-center justify-between px-3 py-2">
                            <div>
                              <span className="text-xs text-zinc-400">GitHub PAT</span>
                              <span className="text-xs text-zinc-200 ml-2 font-mono">{providers.copilot.tokenPrefix}</span>
                              {providers.copilot.addedAt && (
                                <span className="text-[10px] text-zinc-600 ml-2">added {formatRelativeTime(providers.copilot.addedAt)}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={async () => {
                                  setCopilotTesting(true);
                                  setCopilotTestResult(null);
                                  try {
                                    const res = await fetch('/v1/providers/copilot/test', { method: 'POST' });
                                    const result = await res.json();
                                    setCopilotTestResult(result);
                                  } catch {
                                    setCopilotTestResult({ ok: false, status: 'error', error: 'Network error' });
                                  } finally {
                                    setCopilotTesting(false);
                                  }
                                }}
                                disabled={copilotTesting}
                                className="text-[10px] text-blue-400 hover:text-blue-300 cursor-pointer disabled:opacity-50"
                              >
                                {copilotTesting ? (
                                  <span className="flex items-center gap-1">
                                    <span className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin inline-block" />
                                    Testing
                                  </span>
                                ) : 'Test'}
                              </button>
                              <button
                                onClick={() => apiCall('/v1/providers/copilot', 'DELETE')}
                                disabled={busy}
                                className="text-[10px] text-red-400 hover:text-red-300 cursor-pointer disabled:opacity-50"
                              >
                                Remove
                              </button>
                            </div>
                          </div>
                          {copilotTestResult && (
                            <div className={`px-3 pb-2 text-[10px] ${
                              copilotTestResult.ok ? 'text-green-400' : 'text-red-400'
                            }`}>
                              {copilotTestResult.message || copilotTestResult.error}
                            </div>
                          )}
                        </Card>
                      )}
                      <div>
                        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500 mb-1.5">
                          {providers.copilot?.configured ? 'Replace GitHub Token' : 'Set GitHub Token'}
                        </h4>
                        <p className="text-[10px] text-zinc-600 mb-2">
                          Requires a GitHub PAT with Copilot scope and a Copilot Pro+ subscription. Enables Claude Opus 4.6, Sonnet 4.6, etc.
                        </p>
                        <div className="flex gap-2">
                          <input
                            type="password"
                            placeholder="ghp_... or github_pat_..."
                            value={newCopilotToken}
                            onChange={(e) => setNewCopilotToken(e.target.value)}
                            className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500"
                          />
                          <button
                            onClick={async () => {
                              const ok = await apiCall('/v1/providers/copilot', 'PUT', { githubToken: newCopilotToken });
                              if (ok) { setNewCopilotToken(''); setCopilotTestResult(null); }
                            }}
                            disabled={busy || !newCopilotToken}
                            className="px-3 py-1.5 bg-zinc-700 hover:bg-zinc-600 text-xs text-zinc-200 rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="text-[11px] text-zinc-600 leading-relaxed">
        Credentials stored in <code className="text-zinc-500">~/.shizuha/credentials.json</code>.
        Tokens from environment variables and Claude CLI are auto-discovered on startup.
      </div>
    </div>
  );
}

function RuntimeSection({ data }: { data: SettingsData }) {
  const { runtime } = data;

  return (
    <div className="space-y-6">
      <SectionHeader title="Runtime" />

      <Card>
        <CardRow label="Version" value={`v${runtime.version}`} />
        <CardRow label="Node.js" value={runtime.nodeVersion} mono />
        <CardRow label="Platform" value={`${runtime.platform} / ${runtime.arch}`} mono />
        <CardRow label="Uptime" value={formatDuration(runtime.uptime)} />
        <CardRow label="Memory" value={formatBytes(runtime.memoryUsage)} />
      </Card>

      <div>
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500 mb-2">Configuration Files</h3>
        <Card>
          <CardRow label="Auth" value="~/.shizuha/auth.json" mono />
          <CardRow label="Credentials" value="~/.shizuha/credentials.json" mono />
          <CardRow label="Daemon state" value="~/.shizuha/daemon.json" mono />
          <CardRow label="Daemon log" value="~/.shizuha/daemon.log" mono />
          <CardRow label="Project config" value=".shizuha/config.toml" mono />
        </Card>
      </div>
    </div>
  );
}

// ── Shared UI Primitives ──

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-2">
      <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
      {subtitle && <p className="text-xs text-zinc-500 mt-0.5">{subtitle}</p>}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-800 divide-y divide-zinc-800">
      {children}
    </div>
  );
}

function CardRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <span className="text-xs text-zinc-400 flex-shrink-0">{label}</span>
      <span className={`text-xs text-zinc-200 ${mono ? 'font-mono' : ''} truncate max-w-[280px] text-right ml-4`} title={value}>
        {value}
      </span>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="bg-zinc-800/50 rounded-lg border border-zinc-800 px-3 py-2.5 text-center">
      <div className={`text-lg font-semibold ${color}`}>{value}</div>
      <div className="text-[10px] text-zinc-500 mt-0.5">{label}</div>
    </div>
  );
}

function Tag({ text, accent }: { text: string; accent?: boolean }) {
  return (
    <span className={`px-2 py-0.5 rounded text-[11px] font-mono ${
      accent
        ? 'bg-shizuha-600/10 border border-shizuha-600/20 text-shizuha-400'
        : 'bg-zinc-800 border border-zinc-700 text-zinc-300'
    }`}>
      {text}
    </span>
  );
}

function EditableCardRow({ label, value, mono, onClick }: { label: string; value: string; mono?: boolean; onClick: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 py-2 group">
      <span className="text-xs text-zinc-400 flex-shrink-0">{label}</span>
      <button
        onClick={onClick}
        className="flex items-center gap-1.5 cursor-pointer text-right ml-4"
        title={`Edit ${label}`}
      >
        <span className={`text-xs text-zinc-200 ${mono ? 'font-mono' : ''} truncate max-w-[220px]`} title={value}>
          {value}
        </span>
        <svg className="w-3 h-3 text-zinc-600 group-hover:text-shizuha-400 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125" />
        </svg>
      </button>
    </div>
  );
}

function InlineSaveCancel({ saving, onSave, onCancel }: { saving: boolean; onSave: () => void; onCancel: () => void }) {
  return (
    <div className="flex items-center gap-2 justify-end">
      <button onClick={onCancel} disabled={saving} className="px-2 py-0.5 text-[10px] text-zinc-400 hover:text-zinc-200 cursor-pointer disabled:opacity-50">Cancel</button>
      <button onClick={onSave} disabled={saving} className="px-2 py-0.5 text-[10px] bg-shizuha-600 hover:bg-shizuha-500 text-white rounded cursor-pointer disabled:opacity-50">
        {saving ? 'Saving...' : 'Save'}
      </button>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color = status === 'running' ? 'bg-green-400'
    : status === 'error' ? 'bg-red-400'
    : status === 'starting' ? 'bg-yellow-400 animate-pulse'
    : 'bg-zinc-500';

  return (
    <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-900 ${color}`} />
  );
}

// ── Utilities ──

function hashColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const colors = [
    'bg-blue-600', 'bg-purple-600', 'bg-emerald-600', 'bg-rose-600',
    'bg-amber-600', 'bg-cyan-600', 'bg-indigo-600', 'bg-teal-600',
  ];
  return colors[Math.abs(hash) % colors.length]!;
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const absDiff = Math.abs(diff);
  const future = diff < 0;
  const prefix = future ? 'in ' : '';
  const suffix = future ? '' : ' ago';

  if (absDiff < 60_000) return 'just now';
  if (absDiff < 3600_000) return `${prefix}${Math.floor(absDiff / 60_000)}m${suffix}`;
  if (absDiff < 86400_000) return `${prefix}${Math.floor(absDiff / 3600_000)}h${suffix}`;
  return `${prefix}${Math.floor(absDiff / 86400_000)}d${suffix}`;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes: number): string {
  if (bytes > 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes > 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}
