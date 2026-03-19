import { useState, useCallback, useRef, useEffect } from 'react';
import { ChatView, type ChatViewHandle } from './components/ChatView';
import { MessageInput } from './components/MessageInput';
import { StatusBar } from './components/StatusBar';
import { AgentSidebar } from './components/AgentSidebar';
import { AgentProfile } from './components/AgentProfile';
import { ModelPicker } from './components/ModelPicker';
import { CommandPalette } from './components/CommandPalette';
import { SearchBar } from './components/SearchBar';
import { LoginScreen } from './components/LoginScreen';
import { Settings } from './components/Settings';
import { useChat } from './hooks/useChat';
import { useTalkMode } from './hooks/useTalkMode';
import { useTheme } from './hooks/useTheme';
import { useNotifications } from './hooks/useNotifications';
import { useSwipeGesture } from './hooks/useSwipeGesture';
import { exportAsMarkdown, exportAsJSON, downloadFile } from './lib/export';
import { getAgentModel, getAgentMethod, getAgentEffort, getAgentThinking } from './lib/types';
import type { Agent, ImageAttachment } from './lib/types';

const VERSION = '0.1.0-beta';

/** True when viewport >= 768px (sm breakpoint) */
function isDesktop(): boolean {
  return typeof window !== 'undefined' && window.innerWidth >= 768;
}

export default function App() {
  const { theme, toggleTheme } = useTheme();
  const chatViewRef = useRef<ChatViewHandle>(null);
  const { requestPermission, notify } = useNotifications();
  const prevStreamingRef = useRef(false);

  // Dashboard auth state
  const [authState, setAuthState] = useState<'loading' | 'login' | 'authenticated'>('loading');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);

  // Agent selection — restore last selected agent from localStorage
  const [agents, setAgents] = useState<Agent[]>(() => {
    // Hydrate from localStorage cache to avoid flash of empty sidebar on hard refresh
    try {
      const cached = localStorage.getItem('shizuha_agents_cache');
      return cached ? JSON.parse(cached) : [];
    } catch { return []; }
  });
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(() => {
    // Restore selected agent from cached list immediately
    try {
      const savedId = localStorage.getItem('shizuha_selected_agent');
      if (!savedId) return null;
      const cached = localStorage.getItem('shizuha_agents_cache');
      if (!cached) return null;
      const list = JSON.parse(cached) as Agent[];
      return list.find((a) => a.id === savedId) ?? null;
    } catch { return null; }
  });
  const [profileOpen, setProfileOpen] = useState(false);
  const restoredRef = useRef(false);
  const agentsInitialFetchedRef = useRef(false);

  // Sidebar visible by default on desktop
  const [sidebarOpen, setSidebarOpen] = useState(isDesktop);
  const [restarting, setRestarting] = useState(false);
  const [resettingSession, setResettingSession] = useState(false);

  const applyAgentList = useCallback((rawAgents: Agent[], restoreSelection = false) => {
    const agentList = rawAgents;
    setAgents(agentList);
    try { localStorage.setItem('shizuha_agents_cache', JSON.stringify(agentList)); } catch { /* quota */ }
    setSelectedAgent((prev) => {
      if (prev) {
        const updated = agentList.find((a) => a.id === prev.id);
        if (updated) return updated;
      }
      if (!restoreSelection) return prev;
      const savedId = localStorage.getItem('shizuha_selected_agent');
      if (!savedId) return prev;
      return agentList.find((a) => a.id === savedId) ?? prev;
    });
    if (restoreSelection) {
      restoredRef.current = true;
    }
  }, []);

  // Handlers for WS-pushed agent state
  const handleAgentsSnapshot = useCallback((rawAgents: unknown[]) => {
    applyAgentList(rawAgents as Agent[]);
  }, [applyAgentList]);

  const handleAgentUpdated = useCallback((rawAgent: unknown) => {
    const updated = rawAgent as Agent;
    setAgents((prev) => {
      const idx = prev.findIndex((a) => a.id === updated.id);
      let next: Agent[];
      if (idx < 0) {
        // New agent — add if enabled
        next = updated.enabled !== false ? [...prev, updated] : prev;
      } else if (updated.enabled === false) {
        // Agent disabled — remove from list
        next = prev.filter((a) => a.id !== updated.id);
      } else {
        // Agent updated — replace in place
        next = [...prev];
        next[idx] = updated;
      }
      // Update cache
      try { localStorage.setItem('shizuha_agents_cache', JSON.stringify(next)); } catch { /* quota */ }
      return next;
    });
    // Update selectedAgent if it's the one that changed
    setSelectedAgent((prev) => {
      if (!prev || prev.id !== updated.id) return prev;
      if (updated.enabled === false) return null; // Deselect disabled agent
      return updated;
    });
  }, []);

  const chat = useChat({
    agentId: selectedAgent?.id ?? null,
    authState,
    onAgentsSnapshot: handleAgentsSnapshot,
    onAgentUpdated: handleAgentUpdated,
  });

  // ── Auth helpers ──

  /** Try to login with given credentials. Returns true on success. */
  const tryLogin = useCallback(async (username: string, password: string): Promise<boolean> => {
    try {
      const res = await fetch('/v1/dashboard/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        localStorage.setItem('shizuha_auth', JSON.stringify({ username, password }));
        return true;
      }
    } catch { /* network error */ }
    return false;
  }, []);

  /** Try to re-authenticate using stored credentials. Returns true on success. */
  const tryAutoReauth = useCallback(async (): Promise<boolean> => {
    try {
      const raw = localStorage.getItem('shizuha_auth');
      if (!raw) return false;
      const { username, password } = JSON.parse(raw);
      if (!username || !password) return false;
      return await tryLogin(username, password);
    } catch {
      return false;
    }
  }, [tryLogin]);

  const fetchAgentsHttp = useCallback(async () => {
    const res = await fetch('/v1/agents');
    if (!res.ok) {
      throw new Error(`agents fetch failed: ${res.status}`);
    }
    const data = await res.json() as { agents?: Agent[] };
    applyAgentList(data.agents ?? [], true);
  }, [applyAgentList]);

  // Check session on mount — auto-reauth if session expired
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/v1/dashboard/session');
        const data = await r.json();
        if (data.authenticated) {
          setAuthState('authenticated');
          return;
        }
      } catch { /* daemon down */ }

      // Session invalid — try auto-reauth from stored credentials
      if (await tryAutoReauth()) {
        setAuthState('authenticated');
      } else {
        setAuthState('login');
      }
    })();
  }, [tryAutoReauth]);

  useEffect(() => {
    if (authState !== 'authenticated') return;
    fetchAgentsHttp().catch(() => { /* WS RPC path can still recover later */ });
  }, [authState, fetchAgentsHttp]);

  // Global 401 interceptor — auto-reauth, only show login if that fails too
  const reauthing = useRef(false);
  useEffect(() => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      const res = await originalFetch(...args);
      if (res.status === 401) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
        if (!url.includes('/v1/dashboard/login') && !url.includes('/v1/dashboard/session')) {
          // Try silent re-auth (only one at a time to avoid stampede)
          if (!reauthing.current) {
            reauthing.current = true;
            const ok = await tryAutoReauth();
            reauthing.current = false;
            if (ok) {
              // Retry the original request with the new session cookie
              return originalFetch(...args);
            }
          }
          setAuthState('login');
          setLoginError('Session expired — please sign in again');
        }
      }
      return res;
    };
    return () => { window.fetch = originalFetch; };
  }, [tryAutoReauth]);

  const handleLogin = useCallback(async (username: string, password: string) => {
    setLoginLoading(true);
    setLoginError(null);
    try {
      const ok = await tryLogin(username, password);
      if (ok) {
        setAuthState('authenticated');
        // WS will connect automatically — useChat effect fires on authState change
      } else {
        setLoginError('Invalid username or password');
      }
    } catch {
      setLoginError('Network error');
    } finally {
      setLoginLoading(false);
    }
  }, [tryLogin]);

  const handleLogout = useCallback(async () => {
    await fetch('/v1/dashboard/logout', { method: 'POST' }).catch(() => {});
    localStorage.removeItem('shizuha_auth');
    setAuthState('login');
    setLoginError(null);
  }, []);

  // UI state
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);

  // Notify on stream completion when tab is not focused
  useEffect(() => {
    if (prevStreamingRef.current && !chat.isStreaming) {
      const lastMsg = chat.messages[chat.messages.length - 1];
      const preview = lastMsg?.content?.slice(0, 80) || 'Response complete';
      const agentName = selectedAgent?.name ?? 'Shizuha';
      notify(agentName, { body: preview, tag: `shizuha-${selectedAgent?.id}` });
    }
    prevStreamingRef.current = chat.isStreaming;
  }, [chat.isStreaming, chat.messages, selectedAgent, notify]);

  // Show sidebar on resize to desktop
  useEffect(() => {
    const handler = () => {
      if (isDesktop()) setSidebarOpen(true);
    };
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Global keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'k') { e.preventDefault(); setCommandPaletteOpen((v) => !v); }
      if (mod && e.key === 'b') { e.preventDefault(); setSidebarOpen((v) => !v); }
      if (mod && e.key === 'f') { e.preventDefault(); setSearchOpen((v) => !v); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Mobile swipe: edge-right opens sidebar, left-swipe closes it
  useSwipeGesture({
    onSwipeRight: () => { if (!sidebarOpen) setSidebarOpen(true); },
    onSwipeLeft: () => { if (sidebarOpen && !isDesktop()) setSidebarOpen(false); },
  });

  // Fetch agents via RPC when WS connects, and restore selection
  useEffect(() => {
    if (!chat.wsConnected || agentsInitialFetchedRef.current) return;
    agentsInitialFetchedRef.current = true;
    chat.rpc('agents.list').then((result) => {
      const data = result as { agents: Agent[] };
      applyAgentList(data.agents ?? [], true);
    }).catch(() => { /* ignore — WS not ready yet */ });
  }, [applyAgentList, chat.wsConnected, chat.rpc]);

  // Reset initial fetch flag when WS disconnects (so we re-fetch on reconnect)
  useEffect(() => {
    if (!chat.wsConnected) {
      agentsInitialFetchedRef.current = false;
    }
  }, [chat.wsConnected]);

  const handleSelectAgent = useCallback((agent: Agent) => {
    setSelectedAgent(agent);
    setProfileOpen(false);
    localStorage.setItem('shizuha_selected_agent', agent.id);
    // useChat handles save/restore via localStorage when agentId changes
    if (!isDesktop()) setSidebarOpen(false);
  }, []);

  const handleAgentConfigUpdated = useCallback(async () => {
    // After config update, refetch the agent list via RPC
    try {
      const result = await chat.rpc('agents.list') as { agents: Agent[] };
      applyAgentList(result.agents ?? []);
    } catch { /* server will push updates anyway */ }
  }, [applyAgentList, chat.rpc]);

  const handleModelSelect = useCallback((model: string) => {
    chat.setModel(model);
    setModelPickerOpen(false);
  }, [chat]);

  // Quick-update agent model chain settings from status bar
  const patchAgentChain = useCallback(async (updates: Partial<{ method: string; model: string; reasoningEffort: string; thinkingLevel: string }>) => {
    if (!selectedAgent) return;
    const currentModel = getAgentModel(selectedAgent);
    const chain = selectedAgent.modelFallbacks?.length
      ? [...selectedAgent.modelFallbacks]
      : [{ method: selectedAgent.executionMethod ?? 'shizuha', model: currentModel }];
    if (chain.length === 0) return;
    const entry = { ...chain[0]! };
    if (updates.method !== undefined) entry.method = updates.method;
    if (updates.model !== undefined) entry.model = updates.model;
    if (updates.reasoningEffort !== undefined) {
      if (updates.reasoningEffort) entry.reasoningEffort = updates.reasoningEffort;
      else delete entry.reasoningEffort;
    }
    if (updates.thinkingLevel !== undefined) {
      if (updates.thinkingLevel) entry.thinkingLevel = updates.thinkingLevel;
      else delete entry.thinkingLevel;
    }
    chain[0] = entry;
    try {
      await chat.rpc('agents.update', { agent_id: selectedAgent.id, modelFallbacks: chain });
      // Server will broadcast agent_updated — no need to manually refetch
    } catch { /* ignore */ }
  }, [selectedAgent, chat.rpc]);

  const handleScrollToMessage = useCallback((messageId: string) => {
    setHighlightMsgId(messageId);
    chatViewRef.current?.scrollToMessage(messageId);
    setTimeout(() => setHighlightMsgId(null), 2500);
  }, []);

  const handleSendMessage = useCallback((text: string, images?: ImageAttachment[]) => {
    chat.sendMessage(text, images);
  }, [chat]);

  // Talk Mode (voice input/output)
  const talk = useTalkMode({
    onTranscription: (text) => {
      // Auto-send transcribed text as a message
      chat.sendMessage(text);
    },
  });

  // Auto-speak agent responses when talk mode is active
  const lastMessageRef = useRef<string>('');
  useEffect(() => {
    if (!talk.enabled || talk.phase === 'recording') return;
    const msgs = chat.messages;
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last?.role !== 'assistant' || !last.content) return;
    const content = typeof last.content === 'string' ? last.content : '';
    if (content && content !== lastMessageRef.current && !chat.isStreaming) {
      lastMessageRef.current = content;
      talk.speak(content);
    }
  }, [chat.messages, chat.isStreaming, talk.enabled, talk.phase]);

  const handleSuggestionClick = useCallback((text: string) => {
    chat.sendMessage(text);
  }, [chat]);

  const handleCommandAction = useCallback((actionId: string) => {
    setCommandPaletteOpen(false);
    switch (actionId) {
      case 'clearMessages': chat.clearMessages(); break;
      case 'clearAllMessages': chat.clearAllMessages(); break;
      case 'exportMarkdown': {
        const md = exportAsMarkdown(chat.messages);
        downloadFile(md, `shizuha-${selectedAgent?.username ?? 'chat'}-${Date.now()}.md`, 'text/markdown');
        break;
      }
      case 'exportJSON': {
        const json = exportAsJSON(chat.messages);
        downloadFile(json, `shizuha-${selectedAgent?.username ?? 'chat'}-${Date.now()}.json`, 'application/json');
        break;
      }
      case 'openModelPicker': setModelPickerOpen(true); break;
      case 'toggleSidebar': setSidebarOpen((v) => !v); break;
      case 'toggleTheme': toggleTheme(); break;
      case 'openSearch': setSearchOpen(true); break;
      case 'enableNotifications': requestPermission(); break;
      case 'openSettings': setSettingsOpen(true); break;
      case 'logout': handleLogout(); break;
    }
  }, [chat, selectedAgent, toggleTheme, requestPermission, handleLogout]);

  // Loading
  if (authState === 'loading') {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-zinc-950">
        <div className="flex items-center gap-3 text-zinc-500">
          <div className="w-5 h-5 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
          <span className="text-sm">Connecting...</span>
        </div>
      </div>
    );
  }

  // Login
  if (authState === 'login') {
    return (
      <LoginScreen
        onLogin={handleLogin}
        error={loginError}
        isLoading={loginLoading}
      />
    );
  }

  const agentModel = selectedAgent ? getAgentModel(selectedAgent) : null;
  const agentMethod = selectedAgent ? getAgentMethod(selectedAgent) : null;
  const agentEffort = selectedAgent ? getAgentEffort(selectedAgent) : undefined;
  const agentThinking = selectedAgent ? getAgentThinking(selectedAgent) : undefined;

  return (
    <div className="h-[100dvh] flex bg-zinc-950 text-zinc-100">
      {/* Mobile sidebar backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 sm:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Agent sidebar */}
      <div className={
        sidebarOpen
          ? 'fixed inset-y-0 left-0 z-40 sm:relative sm:z-auto'
          : 'hidden'
      }>
        <AgentSidebar
          isOpen={sidebarOpen}
          selectedAgentId={selectedAgent?.id ?? null}
          agents={agents}
          onSelectAgent={handleSelectAgent}
          onClose={() => setSidebarOpen(false)}
        />
      </div>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-2 sm:px-4 py-2 sm:py-2.5 border-b border-zinc-800 bg-zinc-900 safe-top">
          <div className="flex items-center gap-1.5 sm:gap-2.5">
            {/* Sidebar toggle — only when sidebar is closed */}
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                title="Toggle sidebar (Ctrl+B)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
            )}

            {/* Agent header — clickable to show profile */}
            {selectedAgent ? (
              <button
                onClick={() => setProfileOpen(true)}
                className="flex items-center gap-2 hover:bg-zinc-800 rounded-lg px-1.5 py-1 transition-colors cursor-pointer"
                title="View agent settings"
              >
                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-shizuha-600 flex items-center justify-center relative">
                  <span className="text-xs sm:text-sm font-bold text-white">
                    {selectedAgent.name.slice(0, 2).toUpperCase()}
                  </span>
                  <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border-2 border-zinc-900 ${
                    selectedAgent.status === 'running' ? 'bg-green-400'
                      : selectedAgent.status === 'error' ? 'bg-red-400'
                      : selectedAgent.status === 'starting' ? 'bg-yellow-400 animate-pulse'
                      : 'bg-zinc-500'
                  }`} />
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-1.5">
                    <h1 className="text-sm font-semibold text-zinc-100">{selectedAgent.name}</h1>
                    <svg className="w-3 h-3 text-zinc-500" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                      <path d="M4 5l2 2 2-2" />
                    </svg>
                  </div>
                  <p className="text-[10px] text-zinc-500 flex items-center gap-1 flex-wrap max-w-[45vw] sm:max-w-none">
                    <span className="truncate">{selectedAgent.role ?? 'Agent'} · {agentMethod}/{agentModel}</span>
                    {agentEffort && <span className="bg-amber-500/15 text-amber-400 px-1 rounded text-[9px]">{agentEffort}</span>}
                    {agentThinking && <span className="bg-blue-500/15 text-blue-400 px-1 rounded text-[9px]">thinking:{agentThinking}</span>}
                  </p>
                </div>
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-shizuha-600 flex items-center justify-center">
                  <span className="text-xs sm:text-sm font-bold text-white">S</span>
                </div>
                <div>
                  <h1 className="text-sm font-semibold text-zinc-100">Shizuha</h1>
                  <p className="text-[10px] text-zinc-600">v{VERSION}</p>
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-1 sm:gap-1.5">
            {/* Restart agent */}
            {selectedAgent && (
              <button
                onClick={async () => {
                  setRestarting(true);
                  try {
                    await chat.rpc('agents.restart', { agent_id: selectedAgent.id });
                    chat.restartSession();
                  } catch (e) {
                    console.error('Restart error:', e);
                  } finally {
                    setTimeout(() => setRestarting(false), 5000);
                  }
                }}
                disabled={restarting}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-amber-400 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                title="Restart agent"
              >
                <svg className={`w-4 h-4 ${restarting ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            )}

            {/* Reset runtime session */}
            {selectedAgent && (
              <button
                onClick={async () => {
                  const confirmed = window.confirm(
                    `Reset ${selectedAgent.name}'s runtime session?\n\nThis permanently clears the agent's durable conversation state and restarts the runtime fresh.`,
                  );
                  if (!confirmed) return;
                  setResettingSession(true);
                  try {
                    const res = await fetch(`/v1/agents/${selectedAgent.id}/reset-session`, { method: 'POST' });
                    if (!res.ok) {
                      const body = await res.json().catch(() => ({}));
                      throw new Error(body.error || `Reset failed (${res.status})`);
                    }
                    chat.clearMessages();
                    chat.restartSession();
                  } catch (e) {
                    console.error('Reset session error:', e);
                  } finally {
                    setTimeout(() => setResettingSession(false), 5000);
                  }
                }}
                disabled={resettingSession}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-rose-400 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer disabled:opacity-50"
                title="Reset runtime session"
              >
                <svg className={`w-4 h-4 ${resettingSession ? 'animate-pulse' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 6.75h18M8.25 6.75V4.875A1.875 1.875 0 0110.125 3h3.75A1.875 1.875 0 0115.75 4.875V6.75m-9 0v12.375A1.875 1.875 0 008.625 21h6.75a1.875 1.875 0 001.875-1.875V6.75M10 11.25v5.25m4-5.25v5.25" />
                </svg>
              </button>
            )}

            {/* Clear chat */}
            {selectedAgent && chat.messages.length > 0 && (
              <button
                onClick={() => chat.clearMessages()}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                title="Clear chat"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" />
                </svg>
              </button>
            )}

            {/* Clear all chats */}
            {selectedAgent && (
              <button
                onClick={() => chat.clearAllMessages()}
                className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                title="Clear all chats"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 01-2.247 2.118H6.622a2.25 2.25 0 01-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z" />
                </svg>
              </button>
            )}

            {/* Search */}
            {selectedAgent && (
              <button
                onClick={() => setSearchOpen((v) => !v)}
                className="flex w-8 h-8 items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
                title="Search (Ctrl+F)"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" strokeLinecap="round" />
                </svg>
              </button>
            )}

            {/* Command palette */}
            <button
              onClick={() => setCommandPaletteOpen(true)}
              className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
              title="Command palette (Ctrl+K)"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" d="M12 6.042A8.967 8.967 0 0 0 6 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 0 1 6 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 0 1 6-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0 0 18 18a8.967 8.967 0 0 0-6 2.292m0-14.25v14.25" />
              </svg>
            </button>

            {/* Settings */}
            <button
              onClick={() => setSettingsOpen(true)}
              className="w-8 h-8 flex items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
              title="Settings"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
              </svg>
            </button>

            {/* Theme toggle */}
            <button
              onClick={toggleTheme}
              className="hidden sm:flex w-8 h-8 items-center justify-center text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 rounded-lg transition-colors cursor-pointer"
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
            >
              {theme === 'dark' ? '☀' : '🌙'}
            </button>
          </div>
        </header>

        {/* Chat area */}
        <div className="flex-1 flex flex-col relative min-h-0">
          <SearchBar
            isOpen={searchOpen}
            messages={chat.messages}
            onClose={() => setSearchOpen(false)}
            onScrollToMessage={handleScrollToMessage}
          />

          {selectedAgent ? (
            <ChatView
              ref={chatViewRef}
              messages={chat.messages}
              isStreaming={chat.isStreaming}
              streamingContent={chat.streamingContent}
              activeTools={chat.activeTools}
              reasoningSummaries={chat.reasoningSummaries}
              highlightMessageId={highlightMsgId}
              onSuggestionClick={handleSuggestionClick}
            />
          ) : (
            <NoAgentSelected onOpenSidebar={() => setSidebarOpen(true)} sidebarOpen={sidebarOpen} />
          )}
        </div>

        {/* Input */}
        {selectedAgent && (
          <div className="safe-bottom">
            <MessageInput
              onSend={handleSendMessage}
              onCancel={chat.cancelStream}
              isStreaming={chat.isStreaming}
              placeholder={`Message ${selectedAgent.name}...`}
              talkPhase={talk.phase}
              talkEnabled={talk.enabled}
              onToggleTalk={talk.toggleTalkMode}
              onStartRecording={talk.startRecording}
              onStopRecording={talk.stopRecording}
              onStopSpeaking={talk.stopSpeaking}
              recordingDuration={talk.recordingDuration}
              micSupported={talk.micSupported}
              talkError={talk.error}
            />
          </div>
        )}

        {/* Mobile-only compact status strip */}
        {selectedAgent && (
          <div className="flex items-center justify-between px-3 py-1 border-t border-zinc-800 bg-zinc-950 text-[10px] sm:hidden">
            <div className="flex items-center gap-2 min-w-0">
              {chat.wsConnected !== undefined && (
                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${chat.wsConnected ? 'bg-green-400' : 'bg-red-400 animate-pulse'}`} />
              )}
              <span className="text-zinc-500 truncate font-mono">{agentMethod}/{agentModel}</span>
              {chat.isStreaming && (
                <span className="flex items-center gap-1 text-shizuha-400 flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-shizuha-400 animate-pulse" />
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-2 text-zinc-600">
              {(chat.totalInputTokens + chat.totalOutputTokens) > 0 && (
                <span>
                  {(chat.totalInputTokens + chat.totalOutputTokens) > 1000
                    ? `${((chat.totalInputTokens + chat.totalOutputTokens) / 1000).toFixed(1)}k`
                    : chat.totalInputTokens + chat.totalOutputTokens} tok
                </span>
              )}
              {chat.turnCount > 0 && <span>{chat.turnCount}t</span>}
            </div>
          </div>
        )}

        {/* Status bar (desktop) */}
        {selectedAgent && (
          <div className="hidden sm:block">
            <StatusBar
              model={agentModel ?? ''}
              method={agentMethod ?? undefined}
              effort={agentEffort}
              thinking={agentThinking}
              mode={chat.mode}
              sessionId={chat.sessionId}
              totalInputTokens={chat.totalInputTokens}
              totalOutputTokens={chat.totalOutputTokens}
              turnCount={chat.turnCount}
              isStreaming={chat.isStreaming}
              error={chat.error}
              wsConnected={chat.wsConnected}
              onModeChange={chat.setMode}
              onMethodChange={(m) => patchAgentChain({ method: m })}
              onModelChange={(m) => patchAgentChain({ model: m })}
              onEffortChange={(e) => patchAgentChain({ reasoningEffort: e })}
              onThinkingChange={(t) => patchAgentChain({ thinkingLevel: t })}
            />
          </div>
        )}
      </div>

      {/* Agent profile panel */}
      {selectedAgent && (
        <AgentProfile
          agent={selectedAgent}
          isOpen={profileOpen}
          onClose={() => setProfileOpen(false)}
          onAgentUpdated={handleAgentConfigUpdated}
        />
      )}

      {/* Overlays */}
      <ModelPicker
        isOpen={modelPickerOpen}
        currentModel={chat.model}
        onSelect={handleModelSelect}
        onClose={() => setModelPickerOpen(false)}
        authHeaders={() => ({})}
      />

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        onAction={handleCommandAction}
      />

      <Settings
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function NoAgentSelected({ onOpenSidebar, sidebarOpen }: { onOpenSidebar: () => void; sidebarOpen: boolean }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
      <div className="w-16 h-16 rounded-2xl bg-shizuha-600/20 flex items-center justify-center mb-4">
        <span className="text-3xl">S</span>
      </div>
      <h1 className="text-xl font-semibold text-zinc-200">Shizuha Dashboard</h1>
      <p className="text-sm text-zinc-500 mt-2 max-w-sm">
        Select an agent from the sidebar to start chatting.
        Each agent is a specialized AI team member.
      </p>
      {!sidebarOpen && (
        <button
          onClick={onOpenSidebar}
          className="mt-4 px-4 py-2 bg-shizuha-600 hover:bg-shizuha-500 text-white text-sm rounded-lg transition-colors cursor-pointer"
        >
          Show Agents
        </button>
      )}
    </div>
  );
}
