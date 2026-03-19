import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelInfo } from '../state/types.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

interface ModelPickerProps {
  models: ModelInfo[];
  currentModel: string;
  availableProviders: string[];
  onSelect: (slug: string, effort?: string) => void;
  onCancel: () => void;
  onAuthConfigure?: (provider: string, modelSlug: string, token: string) => void;
  onCodexDeviceAuth?: (modelSlug: string) => void;
}

/** Mask a token for display: first 8 + ***... + last 4 */
function maskToken(token: string): string {
  if (token.length <= 16) return '*'.repeat(token.length);
  return token.slice(0, 8) + '***...' + token.slice(-4);
}

/** A row in the picker — either a group header or a model entry */
type PickerRow =
  | { type: 'group'; group: string; expanded: boolean; available: boolean }
  | { type: 'model'; model: ModelInfo };

export const ModelPicker: React.FC<ModelPickerProps> = ({
  models, currentModel, availableProviders, onSelect, onCancel, onAuthConfigure, onCodexDeviceAuth,
}) => {
  const [selected, setSelected] = useState(-1); // -1 = needs init from pickerRows
  const selectedInitialized = useRef(false);
  const [showHidden, setShowHidden] = useState(false);
  const [mode, setMode] = useState<'browse' | 'auth' | 'device-auth' | 'effort'>('browse');
  const [authToken, setAuthToken] = useState('');
  const [authTarget, setAuthTarget] = useState<{ provider: string; slug: string } | null>(null);
  // Effort picker state
  const [effortTarget, setEffortTarget] = useState<{ slug: string; levels: string[] } | null>(null);
  const [effortSelected, setEffortSelected] = useState(0);
  // Device auth state
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [deviceAuthStatus, setDeviceAuthStatus] = useState<'requesting' | 'waiting' | 'success' | 'error'>('requesting');
  const [deviceAuthError, setDeviceAuthError] = useState<string | null>(null);
  const [deviceAuthEmail, setDeviceAuthEmail] = useState<string | null>(null);
  const deviceAuthAbortRef = useRef<AbortController | null>(null);
  // Track which groups are expanded — start with current model's group expanded
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => {
    const currentGroup = models.find((m) => m.slug === currentModel)?.group;
    return new Set(currentGroup ? [currentGroup] : []);
  });
  const { rows } = useTerminalSize();

  const providerAvailable = (provider: string) => availableProviders.includes(provider);

  // Build the flat row list with group headers + models
  const pickerRows = useMemo(() => {
    const filtered = showHidden ? models : models.filter((m) => m.visibility === 'list');

    // Group models by their group label, preserving order
    const groupOrder: string[] = [];
    const groupMap = new Map<string, ModelInfo[]>();
    for (const m of filtered) {
      const g = m.group || m.provider;
      if (!groupMap.has(g)) {
        groupOrder.push(g);
        groupMap.set(g, []);
      }
      groupMap.get(g)!.push(m);
    }

    // Sort within each group: current model first
    for (const [, list] of groupMap) {
      list.sort((a, b) => {
        if (a.slug === currentModel) return -1;
        if (b.slug === currentModel) return 1;
        return 0;
      });
    }

    // Build flat rows
    const rows: PickerRow[] = [];
    for (const group of groupOrder) {
      const list = groupMap.get(group)!;
      const expanded = expandedGroups.has(group);
      const available = list.some((m) => providerAvailable(m.provider));
      rows.push({ type: 'group', group, expanded, available });
      if (expanded) {
        for (const m of list) {
          rows.push({ type: 'model', model: m });
        }
      }
    }
    return rows;
  }, [models, currentModel, showHidden, expandedGroups, availableProviders]);

  // Initialize cursor to the current model's row
  useEffect(() => {
    if (selectedInitialized.current) return;
    const idx = pickerRows.findIndex(
      (r) => r.type === 'model' && r.model.slug === currentModel,
    );
    if (idx >= 0) {
      setSelected(idx);
      selectedInitialized.current = true;
    } else {
      setSelected(0);
    }
  }, [pickerRows, currentModel]);

  // ── Device auth flow ──
  useEffect(() => {
    if (mode !== 'device-auth' || !authTarget) return;

    const abort = new AbortController();
    deviceAuthAbortRef.current = abort;

    (async () => {
      try {
        setDeviceAuthStatus('requesting');
        setDeviceAuthError(null);
        setDeviceCode(null);
        setDeviceAuthEmail(null);

        const { codexDeviceAuth } = await import('../../auth/codex-device-auth.js');

        const email = await codexDeviceAuth({
          onUserCode: (code, _url) => {
            if (abort.signal.aborted) return;
            setDeviceCode(code);
            setDeviceAuthStatus('waiting');
          },
          onPolling: () => {
            // Could show a spinner tick here
          },
          onSuccess: (email) => {
            if (abort.signal.aborted) return;
            setDeviceAuthEmail(email);
            setDeviceAuthStatus('success');
          },
          onError: (error) => {
            if (abort.signal.aborted) return;
            setDeviceAuthError(error);
            setDeviceAuthStatus('error');
          },
        });

        // Auth succeeded — reinitialize providers and select the model
        if (!abort.signal.aborted && authTarget) {
          // Small delay so user sees the success message
          await new Promise((r) => setTimeout(r, 1500));
          if (!abort.signal.aborted && onCodexDeviceAuth) {
            onCodexDeviceAuth(authTarget.slug);
          }
        }
      } catch (err) {
        if (!abort.signal.aborted) {
          setDeviceAuthError((err as Error).message);
          setDeviceAuthStatus('error');
        }
      }
    })();

    return () => {
      abort.abort();
      deviceAuthAbortRef.current = null;
    };
  }, [mode, authTarget?.slug]);

  // ── Auth mode input handler (API key paste) ──
  useInput((input, key) => {
    if (mode !== 'auth') return;

    if (key.escape) {
      setMode('browse');
      setAuthToken('');
      setAuthTarget(null);
      return;
    }
    if (key.return) {
      if (authToken.length > 0 && authTarget && onAuthConfigure) {
        onAuthConfigure(authTarget.provider, authTarget.slug, authToken);
      }
      setMode('browse');
      setAuthToken('');
      setAuthTarget(null);
      return;
    }
    if (key.backspace || key.delete) {
      setAuthToken((prev) => prev.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'u') {
      setAuthToken('');
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      setAuthToken((prev) => prev + input);
    }
  }, { isActive: mode === 'auth' });

  // ── Device auth mode input handler ──
  useInput((_input, key) => {
    if (mode !== 'device-auth') return;

    if (key.escape) {
      deviceAuthAbortRef.current?.abort();
      setMode('browse');
      setAuthTarget(null);
      setDeviceCode(null);
      setDeviceAuthStatus('requesting');
      setDeviceAuthError(null);
      return;
    }
  }, { isActive: mode === 'device-auth' });

  // ── Effort picker input handler ──
  useInput((_input, key) => {
    if (mode !== 'effort' || !effortTarget) return;

    if (key.escape) {
      setMode('browse');
      setEffortTarget(null);
      return;
    }
    if (key.upArrow) {
      setEffortSelected((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setEffortSelected((prev) => Math.min(effortTarget.levels.length - 1, prev + 1));
    } else if (key.return) {
      const level = effortTarget.levels[effortSelected];
      if (level) {
        onSelect(effortTarget.slug, level);
      }
      setMode('browse');
      setEffortTarget(null);
    }
  }, { isActive: mode === 'effort' });

  // ── Browse mode input handler ──
  useInput((input, key) => {
    if (mode !== 'browse') return;

    if (key.upArrow) {
      setSelected((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelected((prev) => Math.min(pickerRows.length - 1, prev + 1));
    } else if (key.return) {
      const row = pickerRows[selected];
      if (!row) return;
      if (row.type === 'group') {
        // Toggle group expand/collapse
        setExpandedGroups((prev) => {
          const next = new Set(prev);
          if (next.has(row.group)) next.delete(row.group);
          else next.add(row.group);
          return next;
        });
      } else {
        const isAvailable = providerAvailable(row.model.provider);
        if (isAvailable) {
          // If model has reasoning levels, show effort picker
          if (row.model.reasoningLevels.length > 0) {
            setEffortTarget({ slug: row.model.slug, levels: row.model.reasoningLevels });
            setEffortSelected(0);
            setMode('effort');
          } else {
            onSelect(row.model.slug);
          }
        } else if (row.model.provider === 'codex') {
          // Codex uses device auth flow — run inline
          setAuthTarget({ provider: row.model.provider, slug: row.model.slug });
          setMode('device-auth');
        } else if (onAuthConfigure) {
          setAuthTarget({ provider: row.model.provider, slug: row.model.slug });
          setAuthToken('');
          setMode('auth');
        }
      }
    } else if (key.escape) {
      onCancel();
    } else if (input === 'h' || input === 'H') {
      setShowHidden((prev) => !prev);
      setSelected(0);
    }
  }, { isActive: mode === 'browse' });

  // ── Effort picker screen ──
  if (mode === 'effort' && effortTarget) {
    const EFFORT_LABELS: Record<string, string> = {
      low: 'Low — fast, minimal reasoning',
      medium: 'Medium — balanced (default)',
      high: 'High — deeper reasoning',
      xhigh: 'Extra High — maximum reasoning depth',
    };
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
        <Text bold color="cyan">{effortTarget.slug}</Text>
        <Text dimColor>Select reasoning effort · Esc to go back</Text>
        <Box marginTop={1} flexDirection="column">
          {effortTarget.levels.map((level, i) => (
            <Box key={level}>
              <Text
                color={effortSelected === i ? 'cyan' : undefined}
                bold={effortSelected === i}
              >
                {effortSelected === i ? '\u25B6 ' : '  '}
                {EFFORT_LABELS[level] ?? level}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>
    );
  }

  // ── Device auth screen ──
  if (mode === 'device-auth' && authTarget) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Text bold color="yellow">Login with ChatGPT (free)</Text>
        <Text dimColor> </Text>
        {deviceAuthStatus === 'requesting' && (
          <Text>Requesting device code...</Text>
        )}
        {deviceAuthStatus === 'waiting' && deviceCode && (
          <>
            <Text>Go to: <Text bold color="cyan">https://auth.openai.com/codex/device</Text></Text>
            <Text dimColor> </Text>
            <Text>Enter code: <Text bold color="green">{deviceCode}</Text></Text>
            <Text dimColor> </Text>
            <Text dimColor>Waiting for authorization...</Text>
          </>
        )}
        {deviceAuthStatus === 'success' && (
          <>
            <Text color="green" bold>Authenticated as {deviceAuthEmail}</Text>
            <Text dimColor>Switching to {authTarget.slug}...</Text>
          </>
        )}
        {deviceAuthStatus === 'error' && (
          <>
            <Text color="red">Error: {deviceAuthError}</Text>
            <Text dimColor> </Text>
            <Text dimColor>Esc to go back and try again</Text>
          </>
        )}
        {deviceAuthStatus !== 'success' && deviceAuthStatus !== 'error' && (
          <>
            <Text dimColor> </Text>
            <Text dimColor>Esc to cancel</Text>
          </>
        )}
      </Box>
    );
  }

  // ── API key auth entry screen ──
  if (mode === 'auth' && authTarget) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginY={1}>
        <Text bold color="yellow">Configure {authTarget.provider}</Text>
        <Text dimColor> </Text>
        <Text>Paste API key:</Text>
        <Text color="cyan" bold>
          {'\u25B8'} {authToken.length > 0 ? maskToken(authToken) : '(waiting for input...)'}
        </Text>
        <Text dimColor> </Text>
        <Text dimColor>Enter to save {'\u00B7'} Esc to cancel</Text>
      </Box>
    );
  }

  // ── Browse screen ──
  const maxVisible = Math.max(5, rows - 10);
  const total = pickerRows.length;

  let scrollStart = 0;
  if (total > maxVisible) {
    scrollStart = Math.min(
      Math.max(0, selected - Math.floor(maxVisible / 2)),
      total - maxVisible,
    );
  }
  const scrollEnd = Math.min(scrollStart + maxVisible, total);
  const windowRows = pickerRows.slice(scrollStart, scrollEnd);

  const showUpArrow = scrollStart > 0;
  const showDownArrow = scrollEnd < total;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Text bold color="cyan">{'\u2630'} Model Picker</Text>
      <Text dimColor>
        {'\u2191\u2193'} navigate, Enter to select/expand, Esc to cancel, H to {showHidden ? 'hide' : 'show'} hidden
      </Text>
      <Box marginTop={1} flexDirection="column">
        {showUpArrow && (
          <Text dimColor>  {'\u2191'} {scrollStart} more above</Text>
        )}
        {windowRows.map((row, i) => {
          const realIdx = scrollStart + i;
          const isSelected = selected === realIdx;

          if (row.type === 'group') {
            const chevron = row.expanded ? '\u25BC' : '\u25B6';
            return (
              <Box key={`group-${row.group}`}>
                <Text
                  color={isSelected ? 'cyan' : row.available ? 'white' : 'gray'}
                  bold
                  dimColor={!row.available}
                >
                  {isSelected ? '\u25B6 ' : '  '}
                  {chevron} {row.group}
                  {!row.available ? ' (not configured)' : ''}
                </Text>
              </Box>
            );
          }

          const m = row.model;
          const isCurrent = m.slug === currentModel;
          const isAvailable = providerAvailable(m.provider);

          return (
            <Box key={m.slug}>
              <Text
                color={isSelected ? 'cyan' : isCurrent ? 'green' : isAvailable ? undefined : 'gray'}
                bold={isSelected}
                dimColor={!isAvailable}
              >
                {isSelected ? '  \u25B6 ' : '    '}
                {m.slug}
                {isCurrent ? ' (current)' : ''}
                {!isAvailable && m.provider === 'codex'
                  ? ' (Enter to login with ChatGPT)'
                  : !isAvailable
                    ? ` (Enter to configure)`
                    : ''}
              </Text>
              {m.description ? (
                <Text dimColor> {m.description}</Text>
              ) : null}
            </Box>
          );
        })}
        {showDownArrow && (
          <Text dimColor>  {'\u2193'} {total - scrollEnd} more below</Text>
        )}
      </Box>
      {pickerRows.length === 0 && (
        <Text dimColor>  No models available</Text>
      )}
      {total > maxVisible && (
        <Text dimColor>  {selected + 1}/{total}</Text>
      )}
    </Box>
  );
};
