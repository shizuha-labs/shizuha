import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserSession } from '../../src/browser/session.js';

// ── BrowserManager tests (import the manager module with mocked session) ──

// We test the manager logic independently by importing the module.
// We cannot easily mock Playwright at import level, so we test:
//  1. BrowserManager's session lifecycle (get/create/limit/cleanup)
//  2. BrowserSession's structure (without launching a real browser)
//  3. browserTool parameter validation/routing

describe('BrowserSession', () => {
  it('starts inactive (no browser launched)', () => {
    const session = new BrowserSession();
    expect(session.isActive).toBe(false);
  });

  it('calls onClose callback when close() is called', async () => {
    const onClose = vi.fn();
    const session = new BrowserSession(onClose);
    await session.close();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('close returns status message', async () => {
    const session = new BrowserSession();
    const result = await session.close();
    expect(result).toBe('Browser session closed.');
  });

  it('close is idempotent (can call multiple times)', async () => {
    const onClose = vi.fn();
    const session = new BrowserSession(onClose);
    await session.close();
    await session.close();
    // onClose is called both times (no guard in source)
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

// ── BrowserManager tests ──

// We need to test the manager's session management logic.
// We'll re-import manager for each test to get a fresh instance.

describe('BrowserManager', () => {
  // The singleton is module-scoped, so we create our own instances.
  // BrowserManager is not exported, so we test via the exported browserManager singleton
  // or by recreating the logic. Let's import the module and test the singleton.

  let managerMod: typeof import('../../src/browser/manager.js');

  beforeEach(async () => {
    // Dynamic import to get the module
    managerMod = await import('../../src/browser/manager.js');
    // Clean up any sessions from previous tests
    await managerMod.browserManager.closeAll();
  });

  afterEach(async () => {
    await managerMod.browserManager.closeAll();
  });

  it('exports a singleton browserManager', () => {
    expect(managerMod.browserManager).toBeDefined();
    expect(managerMod.browserManager.activeCount).toBe(0);
  });

  it('getSession creates a new session for unknown ID', () => {
    const session = managerMod.browserManager.getSession('test-1');
    expect(session).toBeInstanceOf(BrowserSession);
    expect(managerMod.browserManager.activeCount).toBe(1);
  });

  it('getSession returns existing session for known ID', () => {
    const session1 = managerMod.browserManager.getSession('test-1');
    const session2 = managerMod.browserManager.getSession('test-1');
    expect(session1).toBe(session2);
    expect(managerMod.browserManager.activeCount).toBe(1);
  });

  it('enforces max concurrent sessions (3)', () => {
    managerMod.browserManager.getSession('s1');
    managerMod.browserManager.getSession('s2');
    managerMod.browserManager.getSession('s3');
    expect(managerMod.browserManager.activeCount).toBe(3);

    expect(() => managerMod.browserManager.getSession('s4')).toThrow(
      /Maximum concurrent browser sessions/,
    );
  });

  it('session auto-removes from map on close', async () => {
    const session = managerMod.browserManager.getSession('auto-remove');
    expect(managerMod.browserManager.activeCount).toBe(1);

    await session.close();
    expect(managerMod.browserManager.activeCount).toBe(0);
  });

  it('closeAll removes all sessions', async () => {
    managerMod.browserManager.getSession('s1');
    managerMod.browserManager.getSession('s2');
    expect(managerMod.browserManager.activeCount).toBe(2);

    await managerMod.browserManager.closeAll();
    expect(managerMod.browserManager.activeCount).toBe(0);
  });

  it('can create new sessions after closing', async () => {
    managerMod.browserManager.getSession('s1');
    managerMod.browserManager.getSession('s2');
    managerMod.browserManager.getSession('s3');

    await managerMod.browserManager.closeAll();

    // Should work again after closeAll
    const session = managerMod.browserManager.getSession('s4');
    expect(session).toBeInstanceOf(BrowserSession);
    expect(managerMod.browserManager.activeCount).toBe(1);
  });
});

// ── Browser Tool parameter validation ──

describe('browserTool', () => {
  let browserTool: typeof import('../../src/tools/builtin/browser.js')['browserTool'];

  beforeEach(async () => {
    const mod = await import('../../src/tools/builtin/browser.js');
    browserTool = mod.browserTool;
  });

  it('has correct name and metadata', () => {
    expect(browserTool.name).toBe('browser');
    expect(browserTool.readOnly).toBe(false);
    expect(browserTool.riskLevel).toBe('medium');
    expect(browserTool.description).toContain('Playwright');
  });

  it('parameter schema validates action as required', () => {
    const result = browserTool.parameters.safeParse({});
    expect(result.success).toBe(false);
  });

  it('parameter schema accepts valid navigate action', () => {
    const result = browserTool.parameters.safeParse({
      action: 'navigate',
      url: 'https://example.com',
    });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts valid click action', () => {
    const result = browserTool.parameters.safeParse({
      action: 'click',
      selector: '#submit-btn',
    });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts valid type action', () => {
    const result = browserTool.parameters.safeParse({
      action: 'type',
      selector: 'input[name=email]',
      text: 'test@example.com',
    });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts valid scroll action', () => {
    const result = browserTool.parameters.safeParse({
      action: 'scroll',
      direction: 'down',
    });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts valid evaluate action', () => {
    const result = browserTool.parameters.safeParse({
      action: 'evaluate',
      script: 'document.title',
    });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts screenshot action', () => {
    const result = browserTool.parameters.safeParse({ action: 'screenshot' });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts get_text action', () => {
    const result = browserTool.parameters.safeParse({ action: 'get_text' });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts back action', () => {
    const result = browserTool.parameters.safeParse({ action: 'back' });
    expect(result.success).toBe(true);
  });

  it('parameter schema accepts close action', () => {
    const result = browserTool.parameters.safeParse({ action: 'close' });
    expect(result.success).toBe(true);
  });

  it('parameter schema rejects invalid action', () => {
    const result = browserTool.parameters.safeParse({ action: 'invalid_action' });
    expect(result.success).toBe(false);
  });

  it('parameter schema rejects invalid scroll direction', () => {
    const result = browserTool.parameters.safeParse({
      action: 'scroll',
      direction: 'left',
    });
    expect(result.success).toBe(false);
  });

  // ── Execute-level validation (requires calling execute with mocked context) ──
  // All these tests share a single session ID to avoid hitting the max concurrent limit.
  // The browserTool.execute creates a session via the singleton browserManager,
  // so we clean up after each group of tests.

  it('navigate action requires url parameter', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');
    await browserManager.closeAll();
    const context = { cwd: '/tmp', sessionId: 'tool-validate' };
    const result = await browserTool.execute({ action: 'navigate' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"url" parameter is required');
    await browserManager.closeAll();
  });

  it('click action requires selector parameter', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');
    await browserManager.closeAll();
    const context = { cwd: '/tmp', sessionId: 'tool-validate' };
    const result = await browserTool.execute({ action: 'click' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"selector" parameter is required');
    await browserManager.closeAll();
  });

  it('type action requires selector parameter', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');
    await browserManager.closeAll();
    const context = { cwd: '/tmp', sessionId: 'tool-validate' };
    const result = await browserTool.execute({ action: 'type' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"selector" parameter is required');
    await browserManager.closeAll();
  });

  it('type action requires text parameter', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');
    await browserManager.closeAll();
    const context = { cwd: '/tmp', sessionId: 'tool-validate' };
    const result = await browserTool.execute(
      { action: 'type', selector: '#input' },
      context,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"text" parameter is required');
    await browserManager.closeAll();
  });

  it('scroll action requires direction parameter', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');
    await browserManager.closeAll();
    const context = { cwd: '/tmp', sessionId: 'tool-validate' };
    const result = await browserTool.execute({ action: 'scroll' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"direction" parameter is required');
    await browserManager.closeAll();
  });

  it('evaluate action requires script parameter', async () => {
    const { browserManager } = await import('../../src/browser/manager.js');
    await browserManager.closeAll();
    const context = { cwd: '/tmp', sessionId: 'tool-validate' };
    const result = await browserTool.execute({ action: 'evaluate' }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"script" parameter is required');
    await browserManager.closeAll();
  });
});
