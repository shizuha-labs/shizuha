import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { formatMcpServerLine, nextMcpEnabled } from '../../src/tui/components/McpOverlay.js';
import {
  loadSettings,
  resetSettingsCache,
  setMcpServerDisabled,
  isMcpServerDisabled,
} from '../../src/tui/utils/settings.js';

describe('MCP overlay rows', () => {
  it('toggles the persisted enabled bit even when the server is disconnected', () => {
    expect(nextMcpEnabled({ disabled: false })).toBe(false);
    expect(nextMcpEnabled({ disabled: true })).toBe(true);
  });

  it('marks selected/disabled/connected servers distinctly', () => {
    expect(formatMcpServerLine({
      name: 'shizuha-wiki', disabled: false, connected: true, tools: 54,
    }, true)).toContain('❯ ');
    expect(formatMcpServerLine({
      name: 'shizuha-finance', disabled: true, connected: false, tools: 0,
    }, false)).toMatch(/off\s+shizuha-finance\s+disabled/);
    expect(formatMcpServerLine({
      name: 'shizuha-pulse', disabled: false, connected: true, tools: 97,
    }, false)).toContain('97 tools');
  });
});

describe('disabled MCP servers persist in settings.json', () => {
  let tempHome: string;
  const prevHome = process.env['HOME'];

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-mcp-settings-'));
    process.env['HOME'] = tempHome;
    resetSettingsCache();
  });

  afterEach(() => {
    process.env['HOME'] = prevHome;
    resetSettingsCache();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('round-trips disable/enable', () => {
    expect(isMcpServerDisabled('shizuha-scs')).toBe(false);
    expect(setMcpServerDisabled('shizuha-scs', true)).toEqual(['shizuha-scs']);
    resetSettingsCache();
    expect(loadSettings().disabledMcpServers).toEqual(['shizuha-scs']);
    expect(isMcpServerDisabled('shizuha-scs')).toBe(true);
    setMcpServerDisabled('shizuha-scs', false);
    resetSettingsCache();
    expect(loadSettings().disabledMcpServers ?? []).toEqual([]);
  });
});
