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
import { MessageBlock } from './components/MessageBlock.js';
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


// Module-level ref for SIGINT handler to access the interrupt function
let _interruptFn: (() => void) | null = null;
let _isProcessing = false;
let _ctrlCTimestamp = 0;

const MODE_CYCLE: PermissionMode[] = ['plan', 'supervised', 'autonomous'];

/** Fixed-height UI chrome lines: Header(2) + InputBox(3) + StatusBar(2) + margins(1) + buffer(2) = 10 */
const UI_CHROME_LINES = 10;

/** Minimum entries to show even on tiny terminals. */
const MIN_VISIBLE_ENTRIES = 2;

/** Estimate the rendered height of a transcript entry in visual lines.
 *  Accounts for line wrapping at terminal width. No content capping —
 *  all agent output is shown; tall content scrolls upward off-screen. */
function estimateEntryHeight(entry: { role: string; content?: string; toolCalls?: unknown[] }, terminalCols: number): number {
  const contentText = entry.content ?? '';
  const contentWidth = Math.max(40, terminalCols - 4); // paddingX + marginLeft

  let visualLines = 0;
  if (contentText) {
    for (const line of contentText.split('\n')) {
      visualLines += line.length === 0 ? 1 : Math.ceil(line.length / contentWidth);
    }
  }

  const header = 1; // "▶ You" or "◆ Shizuha"
  const margin = 1; // marginBottom={1}
  const toolLines = Array.isArray(entry.toolCalls) ? entry.toolCalls.length * 2 : 0;
  return header + visualLines + toolLines + margin;
}

/** Compute how many completed entries fit in the available viewport height.
 *  Walks entries from newest to oldest, accumulating estimated visual heights. */
function computeMaxEntries(terminalRows: number, terminalCols: number, entries: Array<{ role: string; content?: string; toolCalls?: unknown[] }>): number {
  const available = terminalRows - UI_CHROME_LINES;
  let used = 0;
  let count = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const h = estimateEntryHeight(entries[i]!, terminalCols);
    if (used + h > available && count >= MIN_VISIBLE_ENTRIES) break;
    used += h;
    count++;
  }
  return Math.max(MIN_VISIBLE_ENTRIES, count);
}

interface AppProps {
  cwd: string;
  initialModel?: string;
  initialMode?: PermissionMode;
}

const App: React.FC<AppProps> = ({ cwd, initialModel, initialMode }) => {
  const { exit } = useApp();
  const [screen, setScreen] = useState<ScreenMode>('prompt');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [historySearchActive, setHistorySearchActive] = useState(false);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [stashedInput, setStashedInput] = useState<string | null>(null);

  // Load persisted settings — CLI flags override saved values
  const savedSettings = useMemo(() => loadSettings(), []);
  const effectiveInitialModel = initialModel ?? savedSettings.model;
  const effectiveInitialMode = initialMode ?? (savedSettings.permissionMode as PermissionMode | undefined);
  const [thinkingLevel, setThinkingLevel] = useState<string>(savedSettings.thinkingLevel ?? 'on');
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(savedSettings.reasoningEffort ?? null);
  const [fastMode, setFastMode] = useState(savedSettings.fastMode ?? false);
  const [pagerContent, setPagerContent] = useState<string | null>(null);
  const [ctrlCPending, setCtrlCPending] = useState(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<string>('');

  const {
    ready, completedEntries, archivedEntryCount, liveEntry, transcript, getPagerTranscript,
    isProcessing, pendingApproval, approvalQueueLength, error,
    model, mode, totalInputTokens, totalOutputTokens, turnCount, sessionId,
    contextTokens, queuedPromptCount, queuedPrompts, stalledMs, lastAgentEventAt, processingLabel,
    submitPrompt, resolveApproval, setModel, setMode, clearTranscript,
    compact, interrupt, listSessions, resumeSession, newSession,
    initWarning, availableModels, availableProviders,
    renameSession, forkSession, listMCPTools, addTranscriptEntry, submitWithImage,
    setThinkingLevel: setSessionThinkingLevel,
    setReasoningEffort: setSessionReasoningEffort, setFastMode: setSessionFastMode,
    deleteSession, configureAuth, codexDeviceAuthDone, consumeAutoShowModelPicker,
    loginShizuha, logoutShizuha, getShizuhaAuthStatus, verifyShizuhaIdentity,
    planFilePath,
  } = useAgentSession(cwd, effectiveInitialModel, effectiveInitialMode);

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

  // Always-active Ctrl+C / Escape handler — must never be gated by isActive
  // so it works during streaming, overlays, approval dialogs, etc.
  // Stable ref pattern prevents useInput from re-subscribing on every render.
  const globalInputRef = useRef<(input: string, key: any) => void>(() => {});
  globalInputRef.current = (_input: string, key: any) => {
    if (key.ctrl && _input === 'c') {
      if (isProcessing) {
        setStatusMessage('Interrupting...');
        interrupt();
      } else if (ctrlCPending) {
        // Second press within window — quit
        if (ctrlCTimerRef.current) clearTimeout(ctrlCTimerRef.current);
        setCtrlCPending(false);
        exit();
      } else {
        // First press — show hint, start timer
        setCtrlCPending(true);
        setStatusMessage('Press Ctrl+C again to quit');
        ctrlCTimerRef.current = setTimeout(() => {
          setCtrlCPending(false);
          setStatusMessage(null);
        }, 1500);
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
        inputRef.current = stashedInput;
        setStashedInput(null);
        setStatusMessage('Input restored from stash');
      } else if (inputRef.current) {
        setStashedInput(inputRef.current);
        inputRef.current = '';
        setStatusMessage('Input stashed');
      }
    }
    // Ctrl+P — open transcript pager (must work during active execution too)
    if (key.ctrl && _input === 'p') {
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
      const result = await handleSlashCommandAsync(text, {
        setModel: (m: string) => { setModel(m); },
        setMode,
        clearTranscript: handleClearTranscript,
        compact,
        setScreen,
        exit,
        showInPager: (content: string) => { setPagerEntries(null); setPagerContent(content); setScreen('pager'); },
        cwd,
        submitPrompt,
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
      // Non-Codex model without reasoning: ensure thinking is on (Claude default)
      setThinkingLevel('on');
      setSessionThinkingLevel('on');
    }
    // Fast mode defaults to on for codex models (priority service tier)
    setFastMode(codex);
    setSessionFastMode(codex);
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
        setFastMode(codex);
        setSessionFastMode(codex);
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

  // Height-aware viewport windowing: dynamically limit entries so the total
  // output never exceeds stdout.rows. During streaming, reserve space for the
  // live entry (tool calls, reasoning, streaming text) by reducing the budget.
  const liveEntryBudget = useMemo(() => {
    if (!liveEntry) return 0;
    const runningTools = (liveEntry.toolCalls ?? []).filter((tc: any) => tc.status === 'running').length;
    const cappedTools = Math.min(runningTools, 5);
    return 1 + // header "◆ Shizuha"
      Math.min(1, (liveEntry.reasoningSummaries ?? []).length) + // reasoning
      (!liveEntry.content && runningTools === 0 ? 1 : 0) + // thinking indicator
      cappedTools * 2 + // tool calls (~2 lines each)
      Math.min(Math.max(6, terminalRows - 15), 6) + // streaming content (conservative)
      1; // margin
  }, [liveEntry, terminalRows]);
  const maxEntries = useMemo(() => computeMaxEntries(terminalRows - liveEntryBudget, terminalCols, completedEntries), [terminalRows, terminalCols, completedEntries, liveEntryBudget]);
  const visibleEntries = useMemo(() => {
    if (completedEntries.length <= maxEntries) return completedEntries;
    return completedEntries.slice(-maxEntries);
  }, [completedEntries, maxEntries]);
  const hiddenEntryCount = completedEntries.length - visibleEntries.length;
  const totalHiddenEntryCount = archivedEntryCount + hiddenEntryCount;

  return (
    <Box flexDirection="column" minHeight={terminalRows}>
      <Box flexDirection="column" flexGrow={1}>
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
          {screen === 'prompt' && visibleEntries.length === 0 && !liveEntry && !isProcessing && (
            <WelcomeArt columns={terminalCols} rows={terminalRows} model={model} mode={mode} cwd={cwd} />
          )}

          {/* Viewport-windowed entries: only the last N are mounted.
              Older entries accessible via Ctrl+P pager.
              Hidden when overlays (sessions, models, help, pager) are active. */}
          {screen === 'prompt' && (
            <>
              {totalHiddenEntryCount > 0 && (
                <Box paddingX={1}>
                  <Text dimColor>[+{totalHiddenEntryCount} older entries — Ctrl+P for full transcript]</Text>
                </Box>
              )}
              {visibleEntries.map((entry) => (
                <MessageBlock key={entry.id} entry={entry} verbosity={getVerbosity()} />
              ))}
            </>
          )}

          {/* Main content area */}
          {screen === 'prompt' && (
            <>
              {/* Standalone thinking indicator — shown before liveEntry exists */}
              {isProcessing && !liveEntry && !pendingApproval && (
                <ThinkingIndicator label={processingLabel} active={true} />
              )}

              {/* Live streaming entry */}
              {liveEntry && (
                <MessageBlock entry={liveEntry} verbosity={getVerbosity()} processingLabel={processingLabel} />
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
            <HelpOverlay onDismiss={() => setScreen('prompt')} />
          )}

          {screen === 'pager' && (
            <TranscriptPager
              entries={pagerContent ? undefined : (pagerEntries ?? transcript)}
              rawContent={pagerContent ?? undefined}
              onExit={() => { setScreen('prompt'); setPagerContent(null); setPagerEntries(null); }}
            />
          )}
        </>
        )}
      </Box>

      {/* Input — stays available during execution; only lock during approval to avoid key leakage */}
      {ready && screen === 'prompt' && !historySearchActive && (
        <Box paddingX={1}>
          <InputBox
            onSubmit={handleSubmit}
            isProcessing={isProcessing}
            isLocked={!!pendingApproval}
            queuedCount={queuedPromptCount}
            queuedPrompts={queuedPrompts}
            stalledMs={stalledMs}
            processingLabel={processingLabel}
          />
        </Box>
      )}

      {/* Status bar — always rendered at the bottom of the terminal */}
      <Box paddingX={1} width="100%">
        <StatusBar
          model={model}
          mode={mode}
          sessionId={sessionId}
          totalInputTokens={totalInputTokens}
          totalOutputTokens={totalOutputTokens}
          turnCount={turnCount}
          contextTokens={contextTokens}
          startTime={startTime}
          linesAdded={lineStats.added}
          linesRemoved={lineStats.removed}
          branch={gitInfo.branch}
          isProcessing={isProcessing}
          stalledMs={stalledMs}
          lastAgentEventAt={lastAgentEventAt}
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
export function launchTUI(options: { cwd?: string; model?: string; mode?: PermissionMode } = {}): void {
  const cwd = options.cwd ?? process.cwd();

  // Stay on the main screen so the terminal's native scrollback buffer works.
  // Home + clear visible area; old output remains in scrollback history.
  // No alternate screen — old output stays in scrollback.
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[H\x1b[2J');
  }

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
      const now = Date.now();
      if (now - _ctrlCTimestamp < 1500) {
        process.exit(0);
      } else {
        _ctrlCTimestamp = now;
        process.stderr.write('\n \u2139 Press Ctrl+C again to quit\n');
      }
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
    />,
    { stdout: inkStdout as NodeJS.WriteStream, exitOnCtrlC: false, maxFps: 0 },
  );
}
