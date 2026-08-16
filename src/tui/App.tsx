import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { PermissionMode } from '../permissions/types.js';
import type { ScreenMode } from './state/types.js';
import { useAgentSession } from './hooks/useAgentSession.js';
import { getVerbosity, handleSlashCommandAsync } from './hooks/useSlashCommands.js';
import { getCodexDefaultReasoning, isCodexModel } from '../provider/codex.js';
import { resolveThinkingLevelForModel } from '../provider/model-profile.js';
import { InputBox } from './components/InputBox.js';
import { StatusBar } from './components/StatusBar.js';
import { ApprovalDialog } from './components/ApprovalDialog.js';
import { SessionPicker } from './components/SessionPicker.js';
import { HelpOverlay } from './components/HelpOverlay.js';
import { ModelPicker } from './components/ModelPicker.js';
import { HistorySearch } from './components/HistorySearch.js';
import { TranscriptPager } from './components/TranscriptPager.js';
import { ThinkingIndicator } from './components/ThinkingIndicator.js';
import { WelcomeArt } from './components/WelcomeArt.js';
import { useGitInfo } from './hooks/useGitInfo.js';
import { popEdit, getLineStats } from './utils/editHistory.js';
import { isModeCycleKey } from './utils/keys.js';
import { useTerminalSize } from './hooks/useTerminalSize.js';
import { loadSettings, saveSettings } from './utils/settings.js';
import { maybeAutoUpdateTui, restartInstalledTui } from './auto-update.js';
import {
  ConversationViewport,
  type ConversationViewportHandle,
} from './components/ConversationViewport.js';
import { parseMouseWheel } from './utils/mouse.js';
import { enterInteractiveScreen, leaveInteractiveScreen } from './utils/interactiveScreen.js';


// Module-level ref for SIGINT handler to access the interrupt function
let _interruptFn: (() => void) | null = null;
let _isProcessing = false;
let _currentSessionId: string | null = null;

/**
 * Persist the current TUI session id to a marker file so a hard crash (e.g. a
 * V8 heap OOM abort, which bypasses all JS handlers) can still be resumed. The
 * bash launcher wrapper prints "Resume with: shizuha resume <id>" from this
 * marker when the node process dies with a crash exit code. Written idempotently
 * whenever the session id is (re)set — cheap, survives crashes.
 */
function writeSessionMarker(sessionId: string): void {
  try {
    const dir = process.env['SHIZUHA_HOME'] ?? path.join(os.homedir(), '.shizuha');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.last-tui-session'), `${sessionId}\n`, { mode: 0o600 });
  } catch {
    // Marker is a convenience for crash recovery only; never fatal.
  }
}

const MODE_CYCLE: PermissionMode[] = ['plan', 'supervised', 'autonomous'];

interface AppProps {
  cwd: string;
  initialModel?: string;
  initialMode?: PermissionMode;
  initialResumeSessionId?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellQuoteIfNeeded(value: string): string {
  return /^[A-Za-z0-9._:@%+=,/-]+$/.test(value) ? value : shellQuote(value);
}

function buildResumeCommand(): string | null {
  if (!_currentSessionId) return null;
  return `shizuha resume ${shellQuoteIfNeeded(_currentSessionId)}`;
}

function exitTui(exit: () => void): void {
  leaveInteractiveScreen();
  const resumeCommand = buildResumeCommand();
  if (resumeCommand) {
    process.stderr.write(`\n \u2139 Resume with: ${resumeCommand}\n`);
  }
  exit();
  setImmediate(() => process.exit(0));
}

function defaultThinkingLevelForModel(slug?: string | null): string {
  // Shared with provider-side force (SCLI-54): GLM-5.2/4.7 always 'on'.
  return resolveThinkingLevelForModel(slug, undefined);
}

function isBenchAlignedLocalModel(slug?: string | null): boolean {
  const lower = (slug ?? '').toLowerCase();
  return lower.startsWith('cortex/')
    || lower.startsWith('vllm/')
    || lower.includes('glm')
    || lower.includes('qwen')
    || lower.includes('minimax')
    || lower.includes('nemotron');
}

function initialThinkingLevelForModel(slug?: string | null, savedLevel?: string): string {
  // resolveThinkingLevelForModel forces 'on' for defaultThinkingOn profiles
  // even when settings.json has thinkingLevel=off (2026-07-25 tool-call breakage).
  return resolveThinkingLevelForModel(slug, savedLevel);
}

function initialModeForModel(slug?: string | null, savedMode?: PermissionMode): PermissionMode {
  // The benchmark harness that validated GLM-4.7 runs autonomous. For local
  // vLLM/Cortex models, prefer that behavior over stale saved TUI state.
  if (isBenchAlignedLocalModel(slug)) return 'autonomous';
  return savedMode ?? 'supervised';
}

const App: React.FC<AppProps> = ({ cwd, initialModel, initialMode, initialResumeSessionId }) => {
  const { exit } = useApp();
  const [screen, setScreen] = useState<ScreenMode>('prompt');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [historySearchActive, setHistorySearchActive] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [stashedInput, setStashedInput] = useState<string | null>(null);

  // Load persisted settings — CLI flags override saved values
  const savedSettings = useMemo(() => loadSettings(), []);
  const effectiveInitialModel = initialModel ?? savedSettings.model;
  const effectiveInitialMode = initialMode ?? initialModeForModel(effectiveInitialModel, savedSettings.permissionMode as PermissionMode | undefined);
  const [thinkingLevel, setThinkingLevel] = useState<string>(
    initialThinkingLevelForModel(effectiveInitialModel, savedSettings.thinkingLevel),
  );
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(savedSettings.reasoningEffort ?? null);
  const [fastMode, setFastMode] = useState(savedSettings.fastMode ?? false);
  const [pagerContent, setPagerContent] = useState<string | null>(null);
  /** Last externally seeded composer draft. Live keys stay local to InputBox. */
  const [composerDraft, setComposerDraft] = useState('');
  const [composerDraftVersion, setComposerDraftVersion] = useState(0);
  const inputRef = useRef<string>('');
  /** SCLI-383: after help/pager dismiss, lock composer briefly so the dismiss
   *  keystroke cannot land in the draft (q → `q/mode supervised`). */
  const [composerKeySuppressed, setComposerKeySuppressed] = useState(false);
  const armComposerKeySuppress = useCallback(() => {
    setComposerKeySuppressed(true);
    // Clear on next macrotask — long enough that the dismiss key is gone,
    // short enough that the user can type immediately after.
    setTimeout(() => setComposerKeySuppressed(false), 0);
  }, []);
  const conversationViewportRef = useRef<ConversationViewportHandle>(null);
  const draftRemeasureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestConversationRemeasure = useCallback(() => {
    if (draftRemeasureTimerRef.current) return;
    draftRemeasureTimerRef.current = setTimeout(() => {
      draftRemeasureTimerRef.current = null;
      conversationViewportRef.current?.remeasure();
    }, 0);
    draftRemeasureTimerRef.current.unref?.();
  }, []);
  const handleDraftChange = useCallback((value: string) => {
    inputRef.current = value;
    // InputBox deliberately owns keystroke state so the full App does not
    // rerender per character. Remeasure only the viewport after Ink commits a
    // draft wrap/newline that may have changed composer height.
    requestConversationRemeasure();
  }, [requestConversationRemeasure]);
  const replaceComposerDraft = useCallback((value: string) => {
    inputRef.current = value;
    setComposerDraft(value);
    setComposerDraftVersion((version) => version + 1);
  }, []);

  const {
    ready, initStatus, completedEntries, retryNotice, liveEntry, transcript, getPagerTranscript,
    isProcessing, pendingApproval, approvalQueueLength, error,
    model, mode, totalInputTokens, totalOutputTokens, turnCount, sessionId,
    contextTokens, servedModelInfo, lastTurnPerf, liveTurnPerf, queuedPromptCount, queuedPrompts, stalledMs, lastAgentEventAt, processingLabel, runningTasks, activeWatches,
    getTaskRegistry, refreshWatches,
    submitPrompt, dequeueQueuedPrompts, resolveApproval, setModel, setMode, clearTranscript,
    compact, interrupt, listSessions, resumeSession, newSession,
    initWarning, availableModels, availableProviders,
    renameSession, forkSession, listMCPTools, addTranscriptEntry, submitWithImage,
    setThinkingLevel: setSessionThinkingLevel,
    setReasoningEffort: setSessionReasoningEffort, setFastMode: setSessionFastMode,
    deleteSession, configureAuth, codexDeviceAuthDone, consumeAutoShowModelPicker,
    loginShizuha, logoutShizuha, getShizuhaAuthStatus, verifyShizuhaIdentity,
    planFilePath,
  } = useAgentSession(cwd, effectiveInitialModel, effectiveInitialMode, initialResumeSessionId);

  // Persist settings to ~/.shizuha/settings.json when they change
  const settingsInitRef = useRef(false);
  useEffect(() => {
    // Skip the initial render — only save after user-initiated changes
    if (!settingsInitRef.current) {
      settingsInitRef.current = true;
      return;
    }
    if (!ready) return;
    saveSettings({
      model: model || undefined,
      thinkingLevel,
      reasoningEffort,
      fastMode,
      permissionMode: mode,
    });
  }, [ready, model, thinkingLevel, reasoningEffort, fastMode, mode]);

  const [pagerEntries, setPagerEntries] = useState<typeof transcript | null>(null);
  const [startTime] = useState(() => Date.now());
  const { rows: terminalRows, columns: terminalCols } = useTerminalSize();
  const gitInfo = useGitInfo(cwd);

  // Keep module-level state in sync for SIGINT handler
  _interruptFn = interrupt;
  _isProcessing = isProcessing;
  _currentSessionId = sessionId;

  // This performs synchronous filesystem work; doing it during render put a
  // mkdir/stat/write sequence on every character. Session ids change rarely.
  useEffect(() => {
    if (sessionId) writeSessionMarker(sessionId);
  }, [sessionId]);

  useEffect(() => () => {
    if (draftRemeasureTimerRef.current) clearTimeout(draftRemeasureTimerRef.current);
  }, []);

  // launchTUI owns the alternate screen. Restore it when Ink unmounts for
  // /exit or auto-update, before a replacement process inherits the TTY.
  useEffect(() => () => { leaveInteractiveScreen(); }, []);

  // Host binary installs update at a genuinely idle TUI boundary, then resume
  // this exact durable session under the new runtime. Container/pod installs
  // are rejected inside the updater and continue through Hive image rollout.
  useEffect(() => {
    if (process.env['SHIZUHA_AUTO_UPDATE_RESTARTED'] === '1') {
      delete process.env['SHIZUHA_AUTO_UPDATE_RESTARTED'];
      return;
    }
    let cancelled = false;
    const check = async () => {
      const result = await maybeAutoUpdateTui({
        ready,
        isProcessing,
        hasPendingApproval: Boolean(pendingApproval),
        queuedPromptCount,
        runningTaskCount: runningTasks.length,
        hasDraftInput: Boolean(inputRef.current.trim()),
        onPromptScreen: screen === 'prompt',
      });
      if (cancelled || result.action !== 'restart') return;
      setStatusMessage(`Updated Shizuha${result.version ? ` to ${result.version}` : ''} — restarting session…`);
      const restart = { cwd, sessionId, model: model || undefined, mode };
      // Give Ink one frame to paint the status and restore terminal state before
      // the replacement process inherits stdio.
      setTimeout(() => {
        if (cancelled) return;
        exit();
        setTimeout(() => {
          const replacement = restartInstalledTui(restart);
          replacement.on('error', (err) => {
            console.error(`Unable to restart updated Shizuha TUI: ${err.message}`);
            process.exit(1);
          });
          replacement.on('exit', (code) => process.exit(code ?? 0));
        }, 50);
      }, 50);
    };
    const initial = setTimeout(() => { void check(); }, 2_000);
    const interval = setInterval(() => { void check(); }, 30_000);
    initial.unref?.(); interval.unref?.();
    return () => {
      cancelled = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [cwd, exit, isProcessing, mode, model, pendingApproval, queuedPromptCount, ready, runningTasks.length, screen, sessionId]);

  // Always-active Ctrl+C / Escape handler — must never be gated by isActive
  // so it works during streaming, overlays, approval dialogs, etc.
  // Stable ref pattern prevents useInput from re-subscribing on every render.
  const globalInputRef = useRef<(input: string, key: any) => void>(() => {});
  globalInputRef.current = (_input: string, key: any) => {
    if (key.ctrl && _input === 'c') {
      if (isProcessing) {
        setStatusMessage('Interrupting...');
        interrupt();
      } else {
        exitTui(exit);
      }
    }
    if (key.escape) {
      if (screen !== 'prompt') {
        setScreen('prompt');
      } else if (isProcessing) {
        setStatusMessage('Interrupting...');
        interrupt();
      }
    }
  };
  const stableGlobalInput = useCallback((input: string, key: any) => {
    globalInputRef.current(input, key);
  }, []);
  useInput(stableGlobalInput);

  // Other keyboard shortcuts (gated by screen/approval state)
  const shortcutInputRef = useRef<(input: string, key: any) => void>(() => {});
  shortcutInputRef.current = (_input: string, key: any) => {
    if (historySearchActive) return;

    const wheel = parseMouseWheel(_input);
    if (wheel) {
      conversationViewportRef.current?.scrollBy(wheel === 'up' ? -3 : 3);
      return;
    }
    if (key.pageUp) {
      conversationViewportRef.current?.pageBy(-1);
      return;
    }
    if (key.pageDown) {
      conversationViewportRef.current?.pageBy(1);
      return;
    }

    // Ctrl+Z — undo last edit
    if (key.ctrl && _input === 'z' && !isProcessing) {
      const edit = popEdit();
      if (edit) {
        try {
          fs.writeFileSync(edit.filePath, edit.oldContent, 'utf-8');
          setStatusMessage(`Undid edit to ${path.basename(edit.filePath)}`);
        } catch (err) {
          setStatusMessage(`Undo failed: ${(err as Error).message}`);
        }
      } else {
        setStatusMessage('Nothing to undo');
      }
    }
    // Ctrl+R — history search
    if (key.ctrl && _input === 'r' && !isProcessing) {
      setComposerDraft(inputRef.current);
      setHistorySearchActive(true);
    }
    // Ctrl+M — model picker (note: Ctrl+M = Enter in some terminals, check screen)
    // Use Ctrl+\ instead to avoid Enter collision
    // Ctrl+T — cycle thinking (on/off) for Claude
    if (key.ctrl && _input === 't' && !isProcessing) {
      setThinkingLevel((prev) => {
        const next = prev === 'on' ? 'off' : 'on';
        setStatusMessage(`Thinking: ${next}`);
        setSessionThinkingLevel(next);
        return next;
      });
    }
    // Ctrl+E — cycle reasoning effort for Codex
    if (key.ctrl && _input === 'e' && !isProcessing) {
      const levels = ['low', 'medium', 'high', 'xhigh'];
      setReasoningEffort((prev) => {
        const idx = levels.indexOf(prev ?? 'xhigh');
        const next = levels[(idx + 1) % levels.length]!;
        setStatusMessage(`Effort: ${next}`);
        setSessionReasoningEffort(next);
        return next;
      });
    }
    // Ctrl+X — open external editor
    if (key.ctrl && _input === 'x' && !isProcessing) {
      const editor = process.env['EDITOR'] || process.env['VISUAL'] || 'vi';
      const tmpFile = path.join(os.tmpdir(), `shizuha-input-${Date.now()}.md`);
      fs.writeFileSync(tmpFile, inputRef.current, 'utf-8');
      try {
        execSync(`${editor} ${tmpFile}`, { stdio: 'inherit' });
        const content = fs.readFileSync(tmpFile, 'utf-8').trim();
        if (content) {
          submitPrompt(content);
        }
      } catch { /* user cancelled */ }
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
    // Ctrl+S — stash/restore input
    if (key.ctrl && _input === 's' && !isProcessing) {
      if (stashedInput !== null) {
        replaceComposerDraft(stashedInput);
        setStashedInput(null);
        setStatusMessage('Input restored from stash');
      } else if (inputRef.current) {
        setStashedInput(inputRef.current);
        replaceComposerDraft('');
        setStatusMessage('Input stashed');
      }
    }
    // Ctrl+P — open transcript pager (must work during active execution too).
    // Snapshot the locally-owned draft first; pager is the sole Ink child so
    // parent chrome cannot blank the alternate-screen canvas (SCLI-382).
    if (key.ctrl && _input === 'p') {
      setComposerDraft(inputRef.current);
      setPagerContent(null);
      setPagerEntries(getPagerTranscript());
      setScreen('pager');
    }
    // Shift+Tab / reverse-tab sequence — cycle mode.
    // Keep available while processing so users can adjust permission mode
    // without waiting for the current turn to finish.
    if (isModeCycleKey(_input, key)) {
      const currentIdx = MODE_CYCLE.indexOf(mode);
      const nextIdx = (currentIdx + 1) % MODE_CYCLE.length;
      const nextMode = MODE_CYCLE[nextIdx]!;
      setMode(nextMode);
      setStatusMessage(`Mode: ${nextMode}`);
    }
  };
  const stableShortcutInput = useCallback((input: string, key: any) => {
    shortcutInputRef.current(input, key);
  }, []);
  useInput(stableShortcutInput, {
    isActive: !pendingApproval && screen === 'prompt',
  });

  const handleClearTranscript = useCallback(() => {
    clearTranscript();
  }, [clearTranscript]);

  /** Toggle fast mode — same model, faster inference at 2x credit usage.
   *  Sends service_tier: 'priority' to the Responses API.
   *  Defaults to ON for Codex models; auto-disables on 400 errors. */
  const toggleFastMode = useCallback((): { enabled: boolean; model: string } => {
    const next = !fastMode;
    setFastMode(next);
    setSessionFastMode(next);
    return { enabled: next, model };
  }, [model, fastMode, setSessionFastMode]);

  const handleSubmitImpl = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const lowerTrimmed = trimmed.toLowerCase();
    const isSensitiveSlash =
      lowerTrimmed === '/login'
      || lowerTrimmed.startsWith('/login ')
      || lowerTrimmed.startsWith('/config auth ')
      || lowerTrimmed.startsWith('/settings auth ');

    // Track history for Ctrl+R (skip secret-bearing auth commands)
    if (!isSensitiveSlash) {
      setInputHistory((prev) => [text, ...prev.filter((h) => h !== text)].slice(0, 100));
    }

    // !cmd bash mode — execute locally, not sent to LLM
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim();
      if (!cmd) return;
      // Add user entry
      addTranscriptEntry({
        id: `user-${Date.now()}`,
        role: 'user',
        content: `! ${cmd}`,
        timestamp: Date.now(),
      });
      try {
        const output = execSync(cmd, { cwd, timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
        addTranscriptEntry({
          id: `system-${Date.now()}`,
          role: 'assistant',
          content: output.trim() || '(no output)',
          timestamp: Date.now(),
        });
      } catch (err) {
        const error = err as { stderr?: string; message?: string };
        addTranscriptEntry({
          id: `system-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${error.stderr?.trim() || error.message || 'Command failed'}`,
          timestamp: Date.now(),
        });
      }
      return;
    }

    // Check for slash commands
    if (text.startsWith('/')) {
      if (isSensitiveSlash) {
        if (lowerTrimmed === '/login' || lowerTrimmed.startsWith('/login ')) {
          setStatusMessage('Logging in...');
        } else {
          setStatusMessage('Updating auth...');
        }
      }
      const result = await handleSlashCommandAsync(text, {
        setModel: (m: string) => setModel(m),
        setMode,
        clearTranscript: handleClearTranscript,
        compact,
        setScreen,
        exit,
        showInPager: (content: string) => { setPagerEntries(null); setPagerContent(content); setScreen('pager'); },
        cwd,
        submitPrompt,
        getTaskRegistry,
        onWatchesChanged: refreshWatches,
        getSessionInfo: () => ({
          sessionId, model, mode, turnCount,
          totalInputTokens, totalOutputTokens,
          contextTokens, startTime, cwd,
        }),
        renameSession,
        forkSession,
        listMCPTools,
        getLastAssistantMessage: () => {
          for (let i = transcript.length - 1; i >= 0; i--) {
            if (transcript[i]!.role === 'assistant') return transcript[i]!.content;
          }
          return null;
        },
        setThinking: (level: string) => { setThinkingLevel(level); setSessionThinkingLevel(level); },
        setEffort: (level: string) => { setReasoningEffort(level); setSessionReasoningEffort(level); },
        toggleFastMode,
        submitWithImage: (prompt: string, imageBase64: string, mediaType: string) => submitWithImage(prompt, imageBase64, mediaType),
        loginShizuha,
        logoutShizuha,
        getShizuhaAuthStatus,
        verifyShizuhaIdentity,
        configureAuth,
      });
      if (result.handled) {
        if (result.message) setStatusMessage(result.message);
        return;
      }
    }

    setStatusMessage(null);
    submitPrompt(text);
  }, [
    submitPrompt,
    setModel,
    setMode,
    handleClearTranscript,
    compact,
    exit,
    transcript,
    cwd,
    addTranscriptEntry,
    sessionId,
    model,
    mode,
    turnCount,
    totalInputTokens,
    totalOutputTokens,
    contextTokens,
    startTime,
    renameSession,
    forkSession,
    listMCPTools,
    submitWithImage,
    loginShizuha,
    logoutShizuha,
    getShizuhaAuthStatus,
    verifyShizuhaIdentity,
    configureAuth,
    getTaskRegistry,
    refreshWatches,
    setSessionThinkingLevel,
    setSessionReasoningEffort,
    toggleFastMode,
  ]);

  // Keep InputBox onSubmit stable. The slash-command context above depends on
  // fast-changing transcript/session stats, which would otherwise recreate
  // onSubmit every stream chunk and force avoidable input re-renders.
  const handleSubmitRef = useRef<(text: string) => void | Promise<void>>(() => {});
  handleSubmitRef.current = handleSubmitImpl;
  const handleSubmit = useCallback((text: string) => {
    void handleSubmitRef.current(text);
  }, []);

  const handleComposerSubmit = useCallback((text: string) => {
    inputRef.current = '';
    setComposerDraft('');
    conversationViewportRef.current?.scrollToBottom();
    handleSubmit(text);
  }, [handleSubmit]);

  const handleApproval = useCallback((decision: 'allow' | 'deny' | 'allow_always') => {
    resolveApproval(decision);
  }, [resolveApproval]);

  const handleSessionSelect = useCallback(async (id: string) => {
    // Dismiss the session picker immediately to prevent its content from
    // leaking into scrollback when the resumed session's Static items flush.
    setScreen('prompt');
    const result = await resumeSession(id);
    if (!result.ok) {
      setStatusMessage(`Failed to resume session ${id.slice(0, 8)}`);
      return;
    }
    const base = `Resumed session ${id.slice(0, 8)}`;
    setStatusMessage(result.checkpointNotice ? `${base} · ${result.checkpointNotice}` : base);
  }, [resumeSession]);

  const handleNewSession = useCallback(() => {
    newSession();
    setScreen('prompt');
    setStatusMessage('New session started');
  }, [newSession]);

  /** Sync reasoning effort, thinking, and fast mode to model's defaults when model changes */
  const syncEffortToModel = useCallback((slug: string) => {
    const codex = isCodexModel(slug);
    const defaultLevel = getCodexDefaultReasoning(slug);
    setReasoningEffort(defaultLevel);
    setSessionReasoningEffort(defaultLevel);
    // Codex uses reasoningEffort, not Claude thinking — disable thinking for Codex
    if (codex) {
      setThinkingLevel('off');
      setSessionThinkingLevel('off');
    } else if (!codex && defaultLevel === null) {
      const nextThinkingLevel = defaultThinkingLevelForModel(slug);
      setThinkingLevel(nextThinkingLevel);
      setSessionThinkingLevel(nextThinkingLevel);
    }
    // Fast mode is opt-in only; priority service tier costs more without
    // changing output quality for our normal fleet usage.
    setFastMode(false);
    setSessionFastMode(false);
  }, [setSessionReasoningEffort, setSessionFastMode, setSessionThinkingLevel]);

  // Skip auto-sync when handleModelSelect already applied explicit effort,
  // or when saved settings match the model on initial load
  const skipEffortSyncRef = useRef(false);
  const initialSyncDoneRef = useRef(false);

  // Auto-set reasoning effort when model changes (including initial load and auto-pin)
  useEffect(() => {
    if (skipEffortSyncRef.current) {
      skipEffortSyncRef.current = false;
      return;
    }
    if (ready && model) {
      // On initial load, if saved settings exist for this model, use them instead of defaults
      if (!initialSyncDoneRef.current && savedSettings.model === model && savedSettings.reasoningEffort !== undefined) {
        initialSyncDoneRef.current = true;
        // Settings already loaded into state from useState initializers — just sync to session
        setSessionReasoningEffort(reasoningEffort);
        setSessionThinkingLevel(thinkingLevel);
        setSessionFastMode(fastMode);
        return;
      }
      initialSyncDoneRef.current = true;
      syncEffortToModel(model);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, model]);

  const handleModelSelect = useCallback((slug: string, effort?: string) => {
    if (effort) {
      // Mark to skip the useEffect auto-sync — we'll set effort explicitly below
      skipEffortSyncRef.current = true;
    }
    const ok = setModel(slug);
    setScreen('prompt');
    if (ok) {
      if (effort) {
        // User explicitly chose an effort level — apply it instead of the default
        setReasoningEffort(effort);
        setSessionReasoningEffort(effort);
        // Still sync thinking/fast mode
        const codex = isCodexModel(slug);
        if (codex) {
          setThinkingLevel('off');
          setSessionThinkingLevel('off');
        }
        setFastMode(false);
        setSessionFastMode(false);
        setStatusMessage(`Model set to ${slug} (${effort})`);
      } else {
        syncEffortToModel(slug);
        setStatusMessage(`Model set to ${slug}`);
      }
    }
  }, [setModel, syncEffortToModel, setSessionReasoningEffort, setSessionThinkingLevel, setSessionFastMode]);

  const handleAuthConfigure = useCallback((provider: string, modelSlug: string, token: string) => {
    configureAuth(provider, modelSlug, token);
    syncEffortToModel(modelSlug);
    setScreen('prompt');
    setStatusMessage(`Configured ${provider} and set model to ${modelSlug}`);
  }, [configureAuth, syncEffortToModel]);

  const handleCodexDeviceAuth = useCallback((modelSlug: string) => {
    // Device auth completed — reinitialize providers and switch model
    codexDeviceAuthDone(modelSlug);
    syncEffortToModel(modelSlug);
    setScreen('prompt');
    setStatusMessage(`Logged in via ChatGPT and set model to ${modelSlug}`);
  }, [codexDeviceAuthDone, syncEffortToModel]);

  const handleHistorySelect = useCallback((entry: string) => {
    setHistorySearchActive(false);
    handleSubmit(entry);
  }, [handleSubmit]);

  const handleHistoryCancel = useCallback(() => {
    setHistorySearchActive(false);
  }, []);

  // Auto-open model picker after first-turn auth/rate-limit errors
  useEffect(() => {
    if (!isProcessing && screen === 'prompt' && consumeAutoShowModelPicker()) {
      setScreen('models');
    }
  }, [isProcessing, screen, consumeAutoShowModelPicker]);

  const lineStats = ready ? getLineStats() : { added: 0, removed: 0 };
  const appGlyph = '\u2756';
  const assistantGlyph = '\u25C6';
  // Empty idle liveEntry is a bug residue (provider_status → upsertStreamingAssistant).
  // Never render it — it produces ◆ Shizuha + a forever ThinkingIndicator and
  // continuous spinner frames that ghost-duplicate chrome in tmux scrollback.
  const liveEntryHasBody = !!(
    liveEntry
    && (
      (liveEntry.content && liveEntry.content.trim().length > 0)
      || (liveEntry.toolCalls && liveEntry.toolCalls.length > 0)
    )
  );
  const showLiveEntry = !!(liveEntry && (isProcessing || liveEntryHasBody));
  const liveEntryHasText = !!(liveEntry?.content && liveEntry.content.trim().length > 0);

  // SCLI-382: pager must be the sole Ink root — any sibling Box/StatusBar
  // re-paints the alternate screen and blanks the middle canvas.
  if (ready && screen === 'pager') {
    return (
      <TranscriptPager
        entries={pagerContent ? undefined : (pagerEntries ?? transcript)}
        rawContent={pagerContent ?? undefined}
        manageAlternateScreen={false}
        onExit={() => { armComposerKeySuppress(); setScreen('prompt'); setPagerContent(null); setPagerEntries(null); }}
      />
    );
  }

  return (
    <Box flexDirection="column" height={terminalRows} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
        {!ready ? (
        /* Loading state — header + init message in dynamic area until ready */
        <Box flexDirection="column">
          <Box paddingX={1} marginBottom={1}>
            <Text bold color="cyan">{appGlyph} Shizuha</Text>
            <Text dimColor> | Interactive Agent | /help for commands</Text>
          </Box>
          <Box paddingX={1}>
            {error ? (
              <Text color="red">{'\u2717'} Failed to initialize: {error}</Text>
            ) : initStatus ? (
              /* Resume-time maintenance (e.g. compacting an over-window
                 session) can run for minutes \u2014 show its live heartbeat
                 instead of a silent "Initializing..." */
              <Text color="yellow">{initStatus}</Text>
            ) : (
              <Text dimColor>Initializing...</Text>
            )}
          </Box>
        </Box>
        ) : (
        <>
          {/* Init warning (e.g. provider not configured) */}
          {initWarning && (
            <Box paddingX={1}>
              <Text color="yellow">{'\u26A0'} {initWarning}</Text>
            </Box>
          )}

          {/* Error display */}
          {error && (
            <Box paddingX={1}>
              <Text color="red">{'\u2717'} {error}</Text>
            </Box>
          )}

          {/* Status message */}
          {statusMessage && (
            <Box paddingX={1}>
              <Text color="cyan">{'\u2139'} {statusMessage}</Text>
            </Box>
          )}

          {/* Header */}
          <Box paddingX={1} marginBottom={1}>
            <Text bold color="cyan">{appGlyph} Shizuha</Text>
            <Text dimColor> | Interactive Agent | /help for commands</Text>
          </Box>

          {/* Welcome art — shown on idle start screen before any messages */}
          {screen === 'prompt' && completedEntries.length === 0 && !showLiveEntry && !isProcessing && (
            <WelcomeArt columns={terminalCols} rows={terminalRows} model={model} mode={mode} cwd={cwd} />
          )}

          {/* Full source transcript, virtualized to visible terminal rows. The
              alternate screen owns scrolling; tmux history stays empty while
              the mouse/PageUp moves this internal viewport. */}
          {screen === 'prompt' && (completedEntries.length > 0 || showLiveEntry) && (
            <ConversationViewport
              ref={conversationViewportRef}
              completedEntries={completedEntries}
              liveEntry={showLiveEntry ? liveEntry : null}
              columns={terminalCols}
              rows={terminalRows}
            />
          )}

          {/* Main content area */}
          {screen === 'prompt' && (
            <>
              {/* Keep visible motion through the whole turn. Once text deltas
                  arrive the phase becomes Responding rather than disappearing. */}
              {isProcessing && !pendingApproval && (
                <ThinkingIndicator
                  label={processingLabel}
                  active={true}
                  streaming={liveEntryHasText}
                />
              )}

              {/* Retry/stall notice — pinned beneath the always-visible phase
                  indicator so it remains actionable while text streams. */}
              {retryNotice && (
                <Box marginTop={1}>
                  <Text color="yellow">{retryNotice}</Text>
                </Box>
              )}

              {/* Approval dialog */}
              {pendingApproval && (
                <ApprovalDialog request={pendingApproval} onResolve={handleApproval} queueSize={approvalQueueLength} />
              )}

              {/* History search overlay */}
              {historySearchActive && (
                <Box paddingX={1}>
                  <HistorySearch
                    history={inputHistory}
                    onSelect={handleHistorySelect}
                    onCancel={handleHistoryCancel}
                  />
                </Box>
              )}
            </>
          )}

          {screen === 'sessions' && (
            <SessionPicker
              sessions={listSessions()}
              onSelect={handleSessionSelect}
              onNew={handleNewSession}
              onCancel={() => setScreen('prompt')}
              onDelete={(id) => {
                const ok = deleteSession(id);
                if (ok) setStatusMessage(`Session ${id.slice(0, 8)} deleted`);
                return ok;
              }}
            />
          )}

          {screen === 'models' && (
            <ModelPicker
              models={availableModels()}
              currentModel={model}
              availableProviders={availableProviders()}
              onSelect={handleModelSelect}
              onCancel={() => setScreen('prompt')}
              onAuthConfigure={handleAuthConfigure}
              onCodexDeviceAuth={handleCodexDeviceAuth}
            />
          )}

          {screen === 'help' && (
            <HelpOverlay onDismiss={() => {
              armComposerKeySuppress();
              setScreen('prompt');
            }} />
          )}
        </>
        )}
      </Box>

      {/* Input — stays available during execution; only lock during approval to avoid key leakage.
          Hidden (unmounted) while pager is open; App snapshots the local draft (SCLI-382).
          Also locked for one tick after help/pager dismiss so the dismiss key cannot leak (SCLI-383). */}
      {ready && screen === 'prompt' && !historySearchActive && (
        <Box paddingX={1} flexShrink={0}>
          <InputBox
            onSubmit={handleComposerSubmit}
            isProcessing={isProcessing}
            isLocked={!!pendingApproval || composerKeySuppressed}
            queuedCount={queuedPromptCount}
            queuedPrompts={queuedPrompts}
            onDequeueQueuedPrompts={dequeueQueuedPrompts}
            stalledMs={stalledMs}
            processingLabel={processingLabel}
            draftValue={composerDraft}
            draftVersion={composerDraftVersion}
            onDraftChange={handleDraftChange}
          />
        </Box>
      )}

      {/* Status bar — always at the bottom of the main (non-pager) UI */}
      <Box paddingX={1} width="100%" flexShrink={0}>
        <StatusBar
          model={model}
          mode={mode}
          sessionId={sessionId}
          totalInputTokens={totalInputTokens}
          totalOutputTokens={totalOutputTokens}
          turnCount={turnCount}
          contextTokens={contextTokens}
          servedModelInfo={servedModelInfo}
          lastTurnPerf={lastTurnPerf}
          liveTurnPerf={liveTurnPerf}
          startTime={startTime}
          linesAdded={lineStats.added}
          linesRemoved={lineStats.removed}
          branch={gitInfo.branch}
          isProcessing={isProcessing}
          stalledMs={stalledMs}
          lastAgentEventAt={lastAgentEventAt}
          runningTasks={runningTasks}
          activeWatches={activeWatches}
          thinkingLevel={thinkingLevel}
          reasoningEffort={reasoningEffort}
          fastMode={fastMode}
          verbosity={getVerbosity()}
          planFilePath={planFilePath}
        />
      </Box>
    </Box>
  );
};

/** Launch the TUI — called from CLI entry point */
export function launchTUI(options: { cwd?: string; model?: string; mode?: PermissionMode; resumeSessionId?: string } = {}): void {
  const cwd = options.cwd ?? process.cwd();

  // Interactive sessions should fail fast and show a clear timeout budget.
  // Batch/daemon paths keep the longer Cortex/vLLM queue-tolerant defaults.
  process.env['SHIZUHA_INTERACTIVE_TUI'] ??= '1';

  // Fullscreen owner: history lives in the source-backed conversation
  // viewport, not tmux's incomplete pane scrollback. Mouse reports are routed
  // to the internal scroll offset and disabled on every exit path.
  enterInteractiveScreen(process.stdout);
  process.once('exit', leaveInteractiveScreen);

  // Route TUI logs to a rotating file so the UI stays clean while retaining
  // detailed debugging data for long-running/stuck sessions.
  import('../utils/logger.js').then(({ enableFileLogging }) => {
    const level = process.env['SHIZUHA_TUI_LOG_LEVEL']
      ?? process.env['SHIZUHA_LOG_LEVEL']
      ?? 'debug';
    enableFileLogging({ level, mirrorToStderr: false });
  });

  // SIGINT handler: interrupt the agent or exit cleanly
  // Works even during event loop starvation (streaming) because signals
  // are delivered asynchronously by the OS
  process.on('SIGINT', () => {
    if (_isProcessing && _interruptFn) {
      _interruptFn();
      // Use stderr to avoid corrupting Ink's stdout cursor tracking
      process.stderr.write('\n \u2139 Interrupted\n');
    } else {
      leaveInteractiveScreen();
      const resumeCommand = buildResumeCommand();
      if (resumeCommand) {
        process.stderr.write(`\n \u2139 Resume with: ${resumeCommand}\n`);
      }
      process.exit(0);
    }
  });

  // Set up ask-user callback before rendering
  import('../tools/builtin/ask-user.js').then(({ setAskUserCallback }) => {
    setAskUserCallback(async (question: string) => {
      // In TUI mode, the ask-user tool returns a message directing the agent
      // to wait for user input through the normal prompt flow
      return `[TUI] The user has been shown the question: "${question}". They will respond via the input box.`;
    });
  });

  // Proxy stdout.rows so Ink's fullscreen / clearTerminal path never triggers.
  // When lastOutputHeight >= stdout.rows, Ink writes clearTerminal + full output
  // on every frame — the root cause of TUI flickering. By reporting large rows,
  // all rendering goes through our custom diffLogUpdate line-diff renderer.
  // Our components still read the real rows via process.stdout.rows / useTerminalSize.
  const inkStdout = new Proxy(process.stdout, {
    get(target, prop, receiver) {
      if (prop === 'rows') return 9999;
      return Reflect.get(target, prop, receiver);
    },
  });

  render(
    <App
      cwd={cwd}
      initialModel={options.model}
      initialMode={options.mode as PermissionMode | undefined}
      initialResumeSessionId={options.resumeSessionId}
    />,
    { stdout: inkStdout as NodeJS.WriteStream, exitOnCtrlC: false, maxFps: 0 },
  );
}
