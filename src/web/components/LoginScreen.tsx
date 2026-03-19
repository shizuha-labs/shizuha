import { useState, useCallback } from 'react';

interface LoginScreenProps {
  onLogin: (username: string, password: string) => Promise<void>;
  error: string | null;
  isLoading: boolean;
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

        {/* Default credentials hint */}
        <div className="mt-6 bg-zinc-800/50 border border-zinc-700/50 rounded-lg px-4 py-3">
          <p className="text-xs text-zinc-400 text-center">
            Default credentials: <span className="text-zinc-300 font-mono">shizuha</span> / <span className="text-zinc-300 font-mono">shizuha</span>
          </p>
          <p className="text-[10px] text-zinc-600 text-center mt-1">
            Change your password in Settings after signing in
          </p>
        </div>
      </div>
    </div>
  );
}
