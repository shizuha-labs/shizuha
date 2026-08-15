/**
 * PLAT-5106 — browser MCP auto-wire + stdio server surface.
 *
 * After cron-mcp decommission, QA agents lost every Browser tool because:
 *   1. wantsBrowserMcp never auto-enabled for the qa capability
 *   2. resolveBrowserMcpServer always emitted HTTP against :18116 (no sidecar)
 *   3. no stdio browser-mcp server existed to wrap native browser/mouse/keyboard
 *
 * These tests lock the replacement contract.
 */
import { describe, expect, it } from 'vitest';
import {
  wantsBrowserMcp,
  resolveBrowserMcpServer,
} from '../src/browser-mcp.js';
import {
  listBrowserMcpTools,
  toolResultToMcp,
  BROWSER_MCP_TOOLS,
} from '../src/browser-mcp/server.js';

function bareEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  // Start from a clean slate so ambient fleet env (AGENT_ROLE etc.) cannot
  // leak into unit assertions.
  const env: NodeJS.ProcessEnv = { ...overrides };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  return env;
}

describe('wantsBrowserMcp (PLAT-5106)', () => {
  it('is false by default with no capability signals', () => {
    expect(wantsBrowserMcp(undefined, bareEnv())).toBe(false);
    expect(wantsBrowserMcp('you are a helpful engineer', bareEnv())).toBe(false);
  });

  it('auto-enables when AGENT_EFFECTIVE_CAPABILITIES includes qa', () => {
    expect(
      wantsBrowserMcp(undefined, bareEnv({ AGENT_EFFECTIVE_CAPABILITIES: 'engineering,qa' })),
    ).toBe(true);
  });

  it('auto-enables for browser / social-media capability tokens', () => {
    expect(
      wantsBrowserMcp(undefined, bareEnv({ AGENT_EFFECTIVE_CAPABILITIES: 'browser' })),
    ).toBe(true);
    expect(
      wantsBrowserMcp(undefined, bareEnv({ AGENT_SKILLS: 'social-media' })),
    ).toBe(true);
    expect(
      wantsBrowserMcp(undefined, bareEnv({ AGENT_ROLE: 'qa_engineer' })),
    ).toBe(true);
  });

  it('honors explicit SHIZUHA_BROWSER_MCP=0 even when qa is present', () => {
    expect(
      wantsBrowserMcp(
        undefined,
        bareEnv({
          SHIZUHA_BROWSER_MCP: '0',
          AGENT_EFFECTIVE_CAPABILITIES: 'qa',
        }),
      ),
    ).toBe(false);
  });

  it('honors explicit SHIZUHA_BROWSER_MCP=1 with no other signals', () => {
    expect(wantsBrowserMcp(undefined, bareEnv({ SHIZUHA_BROWSER_MCP: '1' }))).toBe(true);
  });

  it('enables when SHIZUHA_BROWSER_MCP_URL is set (HTTP sidecar mode)', () => {
    expect(
      wantsBrowserMcp(
        undefined,
        bareEnv({ SHIZUHA_BROWSER_MCP_URL: 'http://127.0.0.1:18116/mcp' }),
      ),
    ).toBe(true);
  });

  it('does NOT auto-enable from free-text contextPrompt alone', () => {
    // Previously context free-text could trip HTTP sidecar probes for every
    // bridge. Capability-gated auto-wire is the only non-explicit path.
    expect(
      wantsBrowserMcp(
        'You are a QA engineer. Use browser tools to verify the UI.',
        bareEnv(),
      ),
    ).toBe(false);
  });
});

describe('resolveBrowserMcpServer (PLAT-5106)', () => {
  it('returns null when browser MCP is not wanted', () => {
    expect(resolveBrowserMcpServer(undefined, bareEnv())).toBeNull();
  });

  it('returns a stdio entry (command + browser-mcp args) for qa without URL', () => {
    const resolved = resolveBrowserMcpServer(
      undefined,
      bareEnv({
        AGENT_EFFECTIVE_CAPABILITIES: 'qa',
        PLAYWRIGHT_BROWSERS_PATH: '/opt/playwright-browsers',
      }),
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe('browser');
    expect(resolved!.transport).toBe('stdio');
    expect(resolved!.url).toBeUndefined();
    expect(resolved!.token).toBe('');
    expect(resolved!.entry).toMatchObject({
      command: 'node',
    });
    expect('args' in resolved!.entry).toBe(true);
    if ('args' in resolved!.entry) {
      expect(resolved!.entry.args).toContain('browser-mcp');
      // Last arg is the subcommand.
      expect(resolved!.entry.args[resolved!.entry.args.length - 1]).toBe('browser-mcp');
    }
    if ('env' in resolved!.entry) {
      expect(resolved!.entry.env.PLAYWRIGHT_BROWSERS_PATH).toBe('/opt/playwright-browsers');
    }
  });

  it('returns an HTTP entry when SHIZUHA_BROWSER_MCP_URL is set', () => {
    const resolved = resolveBrowserMcpServer(
      undefined,
      bareEnv({
        SHIZUHA_BROWSER_MCP_URL: 'http://127.0.0.1:18116/mcp',
        SHIZUHA_BROWSER_MCP_BEARER: 'test-token',
      }),
    );
    expect(resolved).not.toBeNull();
    expect(resolved!.transport).toBe('http');
    expect(resolved!.url).toBe('http://127.0.0.1:18116/mcp');
    expect(resolved!.token).toBe('test-token');
    expect(resolved!.entry).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:18116/mcp',
      headers: { Authorization: 'Bearer test-token' },
    });
  });

  it('prefers HTTP when both URL and qa capability are present', () => {
    const resolved = resolveBrowserMcpServer(
      undefined,
      bareEnv({
        AGENT_EFFECTIVE_CAPABILITIES: 'qa',
        SHIZUHA_BROWSER_MCP_URL: 'http://sidecar:18116/mcp',
        SHIZUHA_BROWSER_MCP_BEARER: 'tok',
      }),
    );
    expect(resolved!.transport).toBe('http');
    expect(resolved!.url).toBe('http://sidecar:18116/mcp');
  });

  it('never emits a shizuha-cron server name', () => {
    const resolved = resolveBrowserMcpServer(
      undefined,
      bareEnv({ AGENT_EFFECTIVE_CAPABILITIES: 'qa' }),
    );
    expect(resolved!.name).toBe('browser');
    expect(resolved!.name).not.toBe('shizuha-cron');
  });
});

describe('browser-mcp server tool surface (PLAT-5106)', () => {
  it('exposes exactly browser, mouse, keyboard (no cron tools)', () => {
    const names = BROWSER_MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['browser', 'keyboard', 'mouse']);

    const listed = listBrowserMcpTools();
    expect(listed.map((t) => t.name).sort()).toEqual(['browser', 'keyboard', 'mouse']);
    for (const tool of listed) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toBeTypeOf('object');
      // Must not resurrect retired cron surface.
      expect(tool.name).not.toMatch(/cron/i);
    }
  });

  it('maps ToolResult text + image onto MCP content parts', () => {
    const textOnly = toolResultToMcp({ toolUseId: 't1', content: 'hello' });
    expect(textOnly).toEqual({
      content: [{ type: 'text', text: 'hello' }],
    });

    const withImage = toolResultToMcp({
      toolUseId: 't2',
      content: 'shot',
      image: { base64: 'abc123', mediaType: 'image/png' },
    });
    expect(withImage.content).toEqual([
      { type: 'text', text: 'shot' },
      { type: 'image', data: 'abc123', mimeType: 'image/png' },
    ]);

    const err = toolResultToMcp({ toolUseId: 't3', content: 'boom', isError: true });
    expect(err.isError).toBe(true);
    expect(err.content[0]).toEqual({ type: 'text', text: 'boom' });
  });
});
