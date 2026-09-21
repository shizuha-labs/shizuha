import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { getComposerTheme } from '../utils/composerTheme.js';

export interface McpServerRow {
  name: string;
  disabled: boolean;
  connected: boolean;
  tools: number;
  error?: string;
}

interface McpOverlayProps {
  listServers: () => McpServerRow[];
  setEnabled: (name: string, enabled: boolean) => Promise<{ ok: boolean; message: string }>;
  onExit: () => void;
}

/** Space/Enter flips the persisted enabled bit — never "reconnect because it's down". */
export function nextMcpEnabled(row: Pick<McpServerRow, 'disabled'>): boolean {
  return row.disabled;
}

export function formatMcpServerLine(row: McpServerRow, selected: boolean): string {
  const mark = row.disabled ? 'off' : row.connected ? 'on ' : '…  ';
  const state = row.disabled
    ? 'disabled'
    : row.connected
      ? `${row.tools} tools`
      : (row.error ? `error: ${row.error.slice(0, 48)}` : 'disconnected');
  const pointer = selected ? '❯ ' : '  ';
  return `${pointer}${mark}  ${row.name}  ${state}`;
}

/**
 * /mcp pane — toggle MCP servers permanently (persisted in settings.json).
 * Space/Enter toggles the selected server; Esc/q returns to the prompt.
 */
export const McpOverlay: React.FC<McpOverlayProps> = ({ listServers, setEnabled, onExit }) => {
  const theme = getComposerTheme();
  const bg = theme.background;
  const [rows, setRows] = useState<McpServerRow[]>(() => listServers());
  const [selected, setSelected] = useState(0);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setRows(listServers()), 1000);
    return () => clearInterval(timer);
  }, [listServers]);

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === 'Q') {
      onExit();
      return;
    }
    if (key.upArrow || input === 'k') {
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setSelected((i) => Math.min(Math.max(0, rows.length - 1), i + 1));
      return;
    }
    if (busy) return;
    if (key.return || input === ' ') {
      const row = rows[selected];
      if (!row) return;
      const enable = nextMcpEnabled(row);
      setBusy(true);
      void setEnabled(row.name, enable).then((result) => {
        setStatus(result.message);
        setRows(listServers());
        setBusy(false);
      });
    }
  });

  return (
    <Box flexGrow={1} flexDirection="column" paddingX={2} paddingY={1} overflow="hidden">
      <Text bold backgroundColor={bg}> MCP servers </Text>
      <Text dimColor backgroundColor={bg}>
        {' '}space/enter toggle · persisted · Esc/q back
      </Text>
      <Box marginTop={1} flexDirection="column">
        {rows.length === 0 ? (
          <Text dimColor>  No MCP servers configured (.mcp.json / config.toml)</Text>
        ) : rows.map((row, i) => (
          <Text
            key={row.name}
            color={row.disabled ? 'gray' : row.connected ? 'green' : 'yellow'}
            backgroundColor={bg}
          >
            {formatMcpServerLine(row, i === selected)}
          </Text>
        ))}
      </Box>
      {status ? (
        <Box marginTop={1}>
          <Text dimColor>{status}</Text>
        </Box>
      ) : null}
    </Box>
  );
};
