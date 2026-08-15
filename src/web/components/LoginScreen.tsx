import { useState, useCallback } from 'react';

interface LoginScreenProps {
  onLogin: (username: string, password: string) => Promise<void>;
  error: string | null;
  isLoading: boolean;
}

interface ForcePasswordChangeProps {
  onPasswordChanged: () => void;
  onLogout: () => void;
}

/**
 * SEC-642: Forced password change screen shown when default credentials are in use.
 * Blocks all dashboard access until the user sets a new password.
 */
export function ForcePasswordChange({ onPasswordChanged, onLogout }: ForcePasswordChangeProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword || !confirmPassword || busy) return;
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    setBusy(true);
    setError(null);
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
      // Update stored credentials so auto-reauth works with new password
      try {
        const raw = localStorage.getItem('shizuha_auth');
        if (raw) {
          const auth = JSON.parse(raw);
          auth.password = newPassword;
          localStorage.setItem('shizuha_auth', JSON.stringify(auth));
        }
      } catch { /* ignore */ }
      onPasswordChanged();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }, [currentPassword, newPassword, confirmPassword, busy, onPasswordChanged]);

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl bg-amber-600/20 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-amber-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z" />
            </svg>
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">Password Change Required</h1>
          <p className="text-sm text-zinc-400 mt-2">
            You are using the default credentials. Please set a new password before continuing.
          </p>
        </div>

        {/* Password change form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="current-password" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Current Password
            </label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              autoFocus
              disabled={busy}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-shizuha-600 focus:ring-1 focus:ring-shizuha-600/30 transition-colors disabled:opacity-50"
              placeholder="Current password"
            />
          </div>

          <div>
            <label htmlFor="new-password" className="block text-xs font-medium text-zinc-400 mb-1.5">
              New Password
            </label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              disabled={busy}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-shizuha-600 focus:ring-1 focus:ring-shizuha-600/30 transition-colors disabled:opacity-50"
              placeholder="New password (min 8 characters)"
            />
          </div>

          <div>
            <label htmlFor="confirm-password" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Confirm New Password
            </label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              disabled={busy}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-shizuha-600 focus:ring-1 focus:ring-shizuha-600/30 transition-colors disabled:opacity-50"
              placeholder="Confirm new password"
            />
          </div>

          {error && (
            <div className="bg-red-950/30 border border-red-900/30 rounded-lg px-3.5 py-2.5">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={!currentPassword || !newPassword || !confirmPassword || busy}
            className="w-full bg-shizuha-600 hover:bg-shizuha-500 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg py-2.5 transition-colors cursor-pointer flex items-center justify-center gap-2"
          >
            {busy ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Changing password...
              </>
            ) : (
              'Change Password'
            )}
          </button>
        </form>

        <button
          onClick={onLogout}
          className="w-full mt-3 text-sm text-zinc-500 hover:text-zinc-300 transition-colors cursor-pointer"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export function LoginScreen({ onLogin, error, isLoading }: LoginScreenProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!username.trim() || !password || isLoading) return;
      onLogin(username.trim(), password);
    },
    [username, password, isLoading, onLogin],
  );

  return (
    <div className="h-[100dvh] flex items-center justify-center bg-zinc-950 px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-shizuha-600/20 flex items-center justify-center mx-auto mb-4">
            <span className="text-2xl font-bold text-shizuha-400">S</span>
          </div>
          <h1 className="text-xl font-semibold text-zinc-100">Shizuha</h1>
          <p className="text-sm text-zinc-500 mt-1">Sign in to your dashboard</p>
        </div>

        {/* Login form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              disabled={isLoading}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-shizuha-600 focus:ring-1 focus:ring-shizuha-600/30 transition-colors disabled:opacity-50"
              placeholder="shizuha"
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-xs font-medium text-zinc-400 mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={isLoading}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3.5 py-2.5 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-shizuha-600 focus:ring-1 focus:ring-shizuha-600/30 transition-colors disabled:opacity-50"
              placeholder="Password"
            />
          </div>

          {error && (
            <div className="bg-red-950/30 border border-red-900/30 rounded-lg px-3.5 py-2.5">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          <button
            type="submit"
            disabled={!username.trim() || !password || isLoading}
            className="w-full bg-shizuha-600 hover:bg-shizuha-500 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-lg py-2.5 transition-colors cursor-pointer flex items-center justify-center gap-2"
          >
            {isLoading ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Signing in...
              </>
            ) : (
              'Sign in'
            )}
          </button>
        </form>

        {/* First-run setup hint */}
        <div className="mt-6 bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-4 py-3">
          <p className="text-xs text-zinc-400 text-center">
            First run: use <span className="text-zinc-300 font-mono">SHIZUHA_DASHBOARD_PASSWORD</span> or the one-time setup password printed in the local daemon log.
          </p>
          <p className="text-[10px] text-zinc-600 text-center mt-1">
            Generated setup passwords must be changed after signing in.
          </p>
        </div>
      </div>
    </div>
  );
}
