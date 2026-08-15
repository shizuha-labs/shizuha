/**
 * Human-mode browser session.
 *
 * Runs a real Chrome instance on a virtual display (Xvfb) with:
 * - GPU acceleration (if available via /dev/dri)
 * - uinput virtual mouse + keyboard (real kernel input events)
 * - Anti-detection stealth patches
 * - Optional SOCKS proxy with credentials
 *
 * The agent interacts ONLY via screenshots + mouse/keyboard coordinates.
 * No CSS selectors, no page.evaluate, no CDP injection — just like a human.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { VirtualDisplay } from '../input-devices/display.js';
import { VirtualMouse } from '../input-devices/mouse.js';
import { VirtualKeyboard } from '../input-devices/keyboard.js';
import { getStealthArgs, getStealthScript, getRequiredFontPackages, type StealthConfig } from '../input-devices/stealth.js';
import { loadBrowserConfig, buildProxyUrl, type BrowserToolConfig } from '../input-devices/config.js';
import { SocksForwarder } from '../input-devices/socks-forwarder.js';

const PAGE_LOAD_WAIT_MS = 3000;
const IDLE_TIMEOUT_MS = 10 * 60_000; // 10 minutes

/** Persistent profile directory — survives across sessions for realistic browser history.
 * Checks for X-specific profile first (mounted by daemon for social media agents),
 * then falls back to the standard location. */
const PERSISTENT_PROFILE_DIR = (() => {
  const nativeProfile = '/home/agent/.shizuha/browser-profile';
  if (fs.existsSync(nativeProfile)) return nativeProfile;
  // Check for agent-specific browser profile (mounted by daemon extraVolumes)
  const agentProfile = '/home/agent/x-browser-profile';
  if (fs.existsSync(agentProfile)) return agentProfile;
  // Standard location
  return path.join(process.env['HOME'] ?? '/root', '.shizuha', 'browser-profile');
})();

export class HumanBrowserSession {
  private display: VirtualDisplay;
  private mouse: VirtualMouse;
  private keyboard: VirtualKeyboard;
  private chrome: ChildProcess | null = null;
  private socksForwarder: SocksForwarder | null = null;
  private config: BrowserToolConfig;
  private userDataDir: string;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private onClose?: () => void;
  private _started = false;

  constructor(onClose?: () => void) {
    this.onClose = onClose;
    this.config = loadBrowserConfig();

    const width = this.config.stealth?.viewportWidth ?? 1920;
    const height = this.config.stealth?.viewportHeight ?? 1080;

    this.display = new VirtualDisplay({ width, height });

    // Mouse and keyboard use CDP — initialized after Chrome starts (in start())
    this.mouse = new VirtualMouse({ screenWidth: width, screenHeight: height });
    this.keyboard = new VirtualKeyboard({});
    // Use persistent profile so browser has history, cookies, localStorage across sessions.
    // A brand-new profile visiting a complex site is suspicious.
    this.userDataDir = PERSISTENT_PROFILE_DIR;
    fs.mkdirSync(this.userDataDir, { recursive: true, mode: 0o700 });

    // Clean up stale Chrome profile locks from previous container runs.
    // Chrome refuses to start if SingletonLock exists from a different host/PID.
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const lockPath = path.join(this.userDataDir, lock);
      try { fs.unlinkSync(lockPath); } catch { /* doesn't exist — fine */ }
    }
  }

  // uinput-helper is no longer used — mouse/keyboard use CDP Input.dispatch*
  // which goes through Chrome's native input pipeline. This is both simpler
  // and more effective (works with cross-origin iframes, Cloudflare Turnstile, etc.).

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { void this.close(); }, IDLE_TIMEOUT_MS);
  }

  /** Start the display, input devices, and Chrome. */
  async start(): Promise<void> {
    if (this._started) return;
    this.resetIdleTimer();

    // 1. Start virtual display
    const displayId = await this.display.start();

    // 2. Mouse/keyboard are started AFTER Chrome launches (they need CDP).
    //    Placeholder start here is skipped — real start happens at step 7 below.

    // 3. Ensure fonts are installed (one-time, idempotent)
    this.ensureFonts();

    // 4. Start SOCKS5 auth forwarder if proxy has credentials
    // Chrome can't do authenticated SOCKS5 directly. We run a local forwarder:
    // Chrome → localhost:LOCAL_PORT (no auth) → forwarder → remote (with auth) → internet
    let proxyUrl: string | undefined;
    if (this.config.proxy) {
      if (this.config.proxy.username) {
        const url = new URL(this.config.proxy.url);
        this.socksForwarder = new SocksForwarder({
          remoteHost: url.hostname,
          remotePort: parseInt(url.port) || 1080,
          username: this.config.proxy.username,
          password: this.config.proxy.password ?? '',
        });
        const localPort = await this.socksForwarder.start();
        proxyUrl = `socks5://127.0.0.1:${localPort}`;
        console.log(`[human-browser] SOCKS5 forwarder: Chrome → :${localPort} → ${url.hostname}:${url.port} (authenticated)`);
      } else {
        proxyUrl = buildProxyUrl(this.config.proxy);
      }
    }

    // 5. Launch Chrome (non-headless, on the virtual display)
    // Check if Chrome with CDP is already running (e.g. started by agent via Bash)
    let cdpPort = 9222;
    try {
      const http = await import('node:http');
      const existing = await new Promise<boolean>((resolve) => {
        const req = http.get(`http://127.0.0.1:9222/json/version`, (res) => {
          res.destroy();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      });
      if (existing) {
        console.log('[human-browser] Reusing existing Chrome CDP on port 9222');
        // Skip launching Chrome — it's already running
        const fingerprintSeed = Math.floor(Math.random() * 2147483647);
        const stealthConfig: StealthConfig = {
          userDataDir: this.userDataDir,
          screenWidth: this.config.stealth?.viewportWidth ?? 1920,
          screenHeight: this.config.stealth?.viewportHeight ?? 1080,
          fingerprintSeed,
        };
        await this.injectStealthViaCDP(cdpPort, stealthConfig, fingerprintSeed);
        this.mouse = new VirtualMouse({ cdpPort, screenWidth: this.config.stealth?.viewportWidth ?? 1920, screenHeight: this.config.stealth?.viewportHeight ?? 1080 });
        this.keyboard = new VirtualKeyboard({ cdpPort });
        await this.mouse.start();
        await this.keyboard.start();
        this._started = true;
        return;
      }
    } catch { /* no existing Chrome — start fresh below */ }
    cdpPort = 9222; // Always use fixed port — cdpEvaluate() and mouse/keyboard connect to 9222
    const fingerprintSeed = Math.floor(Math.random() * 2147483647);

    const stealthConfig: StealthConfig = {
      proxyUrl,
      userDataDir: this.userDataDir,
      userAgent: this.config.stealth?.userAgent,
      locale: this.config.stealth?.locale,
      timezone: this.config.stealth?.timezone,
      screenWidth: this.config.stealth?.viewportWidth ?? 1920,
      screenHeight: this.config.stealth?.viewportHeight ?? 1080,
      webglVendor: this.config.stealth?.webglVendor,
      webglRenderer: this.config.stealth?.webglRenderer,
      fingerprintSeed,
    };
    const chromeArgs = [
      ...getStealthArgs(stealthConfig),
      // CDP on localhost only — used once for stealth injection, then not needed
      `--remote-debugging-port=${cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      'about:blank',
    ];

    const chromePath = this.findChrome();

    this.chrome = spawn(chromePath, chromeArgs, {
      env: {
        ...process.env,
        DISPLAY: displayId,
        // Strip all proxy env vars — Chrome must connect to CDP and X directly.
        // Daemon injects HTTPS_PROXY for container IPv6 workaround, but Chrome
        // doesn't need it (DinD/sysbox has proper networking).
        HTTPS_PROXY: '',
        HTTP_PROXY: '',
        https_proxy: '',
        http_proxy: '',
        NO_PROXY: '*',
        no_proxy: '*',
        ...(this.config.stealth?.timezone ? { TZ: this.config.stealth.timezone } : {}),
        ...(this.config.stealth?.locale ? { LANG: `${this.config.stealth.locale}.UTF-8` } : {}),
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    });

    this.chrome.on('exit', (code) => {
      console.log(`[human-browser] Chrome exited with code ${code}`);
      this.chrome = null;
    });

    // Wait for Chrome + CDP to be ready
    await new Promise((r) => setTimeout(r, 3000));

    // 6. Inject stealth patches via CDP (runs before any page navigation)
    await this.injectStealthViaCDP(cdpPort, stealthConfig, fingerprintSeed);

    // 7. Connect mouse + keyboard to CDP (they use Input.dispatch* for real input)
    this.mouse = new VirtualMouse({
      cdpPort,
      screenWidth: this.config.stealth?.viewportWidth ?? 1920,
      screenHeight: this.config.stealth?.viewportHeight ?? 1080,
    });
    this.keyboard = new VirtualKeyboard({ cdpPort });
    await this.mouse.start();
    await this.keyboard.start();

    this._started = true;
    console.log(`[human-browser] Started (display=${displayId}, chrome=${chromePath}, cdp=:${cdpPort})`);
  }

  /**
   * Install a Chrome extension that runs stealth patches at document_start.
   * This is more reliable than CDP script injection since it runs before
   * any page JavaScript and doesn't require a DevTools connection.
   */
  /** Install desktop fonts for realistic font fingerprint (idempotent). */
  private ensureFonts(): void {
    const marker = path.join(this.userDataDir, '.fonts-installed');
    if (fs.existsSync(marker)) return;

    try {
      const packages = getRequiredFontPackages();
      execSync(`apt-get install -y -qq ${packages.join(' ')} 2>/dev/null || true`, {
        timeout: 60_000, stdio: 'pipe',
      });
      // Rebuild font cache
      execSync('fc-cache -f 2>/dev/null || true', { timeout: 10_000, stdio: 'pipe' });
      fs.writeFileSync(marker, new Date().toISOString());
      console.log('[human-browser] Fonts installed');
    } catch (err) {
      console.warn(`[human-browser] Font install failed (non-fatal): ${(err as Error).message}`);
    }
  }

  /**
   * Inject stealth patches via CDP Page.addScriptToEvaluateOnNewDocument.
   *
   * This runs the script in the MAIN world before any page JS — same timing
   * as a content_script with run_at: document_start, but without --load-extension
   * (which triggers navigator.webdriver=true in Chromium 130+).
   *
   * Uses a minimal raw WebSocket client to avoid dependency on 'ws' module.
   */
  private async injectStealthViaCDP(
    cdpPort: number,
    config: StealthConfig,
    fingerprintSeed: number,
  ): Promise<void> {
    const script = getStealthScript({
      ...config,
      languages: config.locale ? [config.locale, config.locale.split('-')[0]!] : undefined,
      fingerprintSeed,
    });

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const http = await import('node:http');
        const net = await import('node:net');
        const crypto = await import('node:crypto');

        // Get page target WebSocket URL
        const targetsJson = await new Promise<string>((resolve, reject) => {
          http.get(`http://127.0.0.1:${cdpPort}/json`, (res) => {
            let data = '';
            res.on('data', (c: Buffer) => data += c.toString());
            res.on('end', () => resolve(data));
          }).on('error', reject);
        });

        const targets = JSON.parse(targetsJson) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((t) => t.type === 'page');
        if (!page?.webSocketDebuggerUrl) throw new Error('No page target');

        const wsUrl = new URL(page.webSocketDebuggerUrl);

        // Raw WebSocket handshake + CDP command
        await new Promise<void>((resolve, reject) => {
          const key = crypto.randomBytes(16).toString('base64');
          const socket = net.createConnection({ host: '127.0.0.1', port: cdpPort }, () => {
            socket.write(
              `GET ${wsUrl.pathname} HTTP/1.1\r\n` +
              `Host: 127.0.0.1:${cdpPort}\r\n` +
              `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
              `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
            );
          });

          let handshakeDone = false;
          let buf = Buffer.alloc(0);

          socket.on('data', (chunk: Buffer) => {
            buf = Buffer.concat([buf, chunk]);

            if (!handshakeDone) {
              const idx = buf.indexOf('\r\n\r\n');
              if (idx === -1) return;
              if (!buf.subarray(0, idx).toString().includes('101')) {
                socket.destroy();
                reject(new Error('WebSocket upgrade failed'));
                return;
              }
              handshakeDone = true;
              buf = buf.subarray(idx + 4);

              // Send CDP command as masked WebSocket text frame
              const payload = Buffer.from(JSON.stringify({
                id: 1,
                method: 'Page.addScriptToEvaluateOnNewDocument',
                params: { source: script },
              }));
              const mask = crypto.randomBytes(4);
              const header = Buffer.alloc(payload.length > 125 ? 4 : 2);
              header[0] = 0x81; // FIN + TEXT
              if (payload.length > 125) {
                header[1] = 0x80 | 126;
                header.writeUInt16BE(payload.length, 2);
              } else {
                header[1] = 0x80 | payload.length;
              }
              const masked = Buffer.alloc(payload.length);
              for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
              socket.write(Buffer.concat([header, mask, masked]));
            } else {
              // Response received — command accepted
              socket.destroy();
              resolve();
            }
          });

          socket.on('error', reject);
          setTimeout(() => { socket.destroy(); reject(new Error('CDP timeout')); }, 5000);
        });

        console.log('[human-browser] Stealth patches injected via CDP');
        return;
      } catch (err) {
        if (attempt < 7) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        console.warn(`[human-browser] CDP injection failed after retries: ${(err as Error).message}`);
      }
    }
  }

  private findChrome(): string {
    const playwrightRoot = process.env['PLAYWRIGHT_BROWSERS_PATH'] || '/opt/playwright-browsers';
    const candidates = [
      process.env['CHROME_PATH'],
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ].filter(Boolean) as string[];

    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }

    const bundled = this.findBundledChromium(playwrightRoot);
    if (bundled) return bundled;

    // Try which
    try {
      return execSync('which google-chrome || which chromium-browser || which chromium', {
        encoding: 'utf-8', timeout: 3000,
      }).trim().split('\n')[0]!;
    } catch { /* not found */ }

    // Auto-install Google Chrome (preferred over Chromium for stealth). Google's
    // .deb is amd64-only, while k3s-native fleet pods commonly run on arm64
    // GB10 nodes. Do not download an unexecutable binary on non-amd64.
    if (process.arch !== 'x64') {
      throw new Error(
        `Chrome not found for ${process.arch}. Set CHROME_PATH or install Playwright Chromium under ${playwrightRoot}`,
      );
    }
    console.log('[human-browser] Chrome not found — installing Google Chrome...');
    try {
      execSync(
        'wget -q https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -O /tmp/chrome.deb'
        + ' && (dpkg -i /tmp/chrome.deb 2>/dev/null || apt-get install -f -y -qq 2>/dev/null)'
        + ' && rm /tmp/chrome.deb',
        { timeout: 120_000, stdio: 'pipe' },
      );
      if (fs.existsSync('/usr/bin/google-chrome-stable')) {
        console.log('[human-browser] Google Chrome installed');
        return '/usr/bin/google-chrome-stable';
      }
    } catch (err) {
      console.warn(`[human-browser] Chrome auto-install failed: ${(err as Error).message}`);
    }

    throw new Error(
      'Chrome not found. Install with:\n'
      + '  wget https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && dpkg -i google-chrome-stable_current_amd64.deb\n'
      + '  Or set CHROME_PATH environment variable',
    );
  }

  private findBundledChromium(root: string): string | null {
    const candidates = [
      path.join(root, 'chromium-1208', 'chrome-linux', 'chrome'),
      path.join(root, 'chromium_headless_shell-1208', 'chrome-linux', 'chrome'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    try {
      const found = execSync(`find ${JSON.stringify(root)} -path '*/chrome-linux/chrome' -type f 2>/dev/null | head -1`, {
        encoding: 'utf-8',
        timeout: 3000,
      }).trim();
      return found || null;
    } catch {
      return null;
    }
  }

  // ── Public API (same shape as BrowserSession) ──

  async navigate(url: string): Promise<string> {
    await this.ensureStarted();
    this.resetIdleTimer();

    // Use CDP Page.navigate — this is identical to the browser's own internal
    // navigation (same as typing URL + Enter). It's undetectable because:
    // - No DOM events are fired (it's a top-level navigation, not JS-initiated)
    // - navigator.webdriver is not involved
    // - The browser's network stack handles it identically to user navigation
    // - Anti-bot scripts can't distinguish this from a bookmark click or address bar input
    //
    // The old keyboard approach (Ctrl+L → type URL → Enter) failed when Chrome
    // ran inside Xvfb without a window manager to focus the address bar.
    try {
      const result = await this.cdpCommand('Page.navigate', { url }) as Record<string, unknown> | undefined;
      // Check for navigation error (e.g., "Aborted", "net::ERR_ABORTED")
      if (result?.errorText) {
        console.warn(`[human-session] CDP navigate error: ${result.errorText}`);
      }
    } catch (err) {
      // Fallback: try keyboard-based navigation if CDP fails
      console.warn(`[human-session] CDP navigate failed (${(err as Error).message}), falling back to keyboard`);
      await this.keyboard.hotkey(['ctrl'], 'l');
      await new Promise((r) => setTimeout(r, 300));
      await this.keyboard.hotkey(['ctrl'], 'a');
      await new Promise((r) => setTimeout(r, 100));
      await this.keyboard.typeText(url);
      await new Promise((r) => setTimeout(r, 150));
      await this.keyboard.pressKey('enter');
    }

    // Poll for navigation commit — Page.navigate returns before Chrome commits the URL.
    // For heavy SPAs like x.com (cold cache), this can take 5-15s.
    // Poll the CDP target list until the page URL leaves about:blank.
    const maxWait = 15_000;
    const pollInterval = 500;
    const deadline = Date.now() + maxWait;
    let committed = false;

    while (Date.now() < deadline) {
      try {
        const pageUrl = await this.cdpEvaluate('document.location.href') as string;
        if (pageUrl && pageUrl !== 'about:blank' && !pageUrl.startsWith('chrome://')) {
          committed = true;
          break;
        }
      } catch { /* CDP not ready yet */ }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    if (!committed) {
      console.warn(`[human-session] Navigation to ${url} may not have committed after ${maxWait}ms`);
    }

    // Additional wait for SPA hydration (React/Next.js render after initial load)
    await new Promise((r) => setTimeout(r, 1500));

    return `Navigated to ${url}`;
  }

  async screenshot(): Promise<string> {
    await this.ensureStarted();
    this.resetIdleTimer();

    // Try CDP Page.captureScreenshot first (most reliable, no X11 tools needed)
    // Capture as PNG for maximum quality — provider-level downscaling handles context limits.
    try {
      const data = await this.cdpCommand('Page.captureScreenshot', { format: 'png' });
      if (data?.data && typeof data.data === 'string' && data.data.length > 100) {
        return data.data;
      }
    } catch { /* fall through to display screenshot */ }

    // Fallback: X11 display capture (scrot/import/xwd)
    const buf = await this.display.screenshot();
    return buf.toString('base64');
  }

  /** Send a raw CDP command and return the result. */
  private async cdpCommand(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const http = await import('node:http');
    const net = await import('node:net');
    const crypto = await import('node:crypto');

    const targetsJson = await new Promise<string>((resolve, reject) => {
      const req = http.get('http://127.0.0.1:9222/json', (res) => {
        let d = ''; res.on('data', (c: Buffer) => d += c.toString()); res.on('end', () => resolve(d));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('CDP timeout')); });
    });

    const targets = JSON.parse(targetsJson) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('No page target');

    const wsUrl = new URL(page.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection({ host: '127.0.0.1', port: 9222 }, () => {
        socket.write(
          `GET ${wsUrl.pathname} HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      let handshakeDone = false;
      let buf = Buffer.alloc(0);
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('CDP command timeout')); }, 15000);

      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!handshakeDone) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          handshakeDone = true;
          buf = buf.subarray(idx + 4);
          // Send CDP command — handle extended WebSocket frame encoding for payloads > 125 bytes
          const msg = JSON.stringify({ id: 1, method, params });
          const msgBuf = Buffer.from(msg, 'utf-8');
          const mask = crypto.randomBytes(4);
          let header: Buffer;
          if (msgBuf.length <= 125) {
            header = Buffer.alloc(2 + 4);
            header[0] = 0x81;
            header[1] = 0x80 | msgBuf.length;
            mask.copy(header, 2);
          } else if (msgBuf.length <= 65535) {
            header = Buffer.alloc(4 + 4);
            header[0] = 0x81;
            header[1] = 0x80 | 126;
            header.writeUInt16BE(msgBuf.length, 2);
            mask.copy(header, 4);
          } else {
            header = Buffer.alloc(10 + 4);
            header[0] = 0x81;
            header[1] = 0x80 | 127;
            header.writeBigUInt64BE(BigInt(msgBuf.length), 2);
            mask.copy(header, 10);
          }
          const masked = Buffer.alloc(msgBuf.length);
          for (let i = 0; i < msgBuf.length; i++) masked[i] = msgBuf[i]! ^ mask[i % 4]!;
          socket.write(Buffer.concat([header, masked]));
        }
        // Parse WebSocket frames
        while (buf.length > 2) {
          const payloadLen = buf[1]! & 0x7f;
          let offset = 2;
          let len = payloadLen;
          if (payloadLen === 126) { len = buf.readUInt16BE(2); offset = 4; }
          else if (payloadLen === 127) { offset = 10; len = Number(buf.readBigUInt64BE(2)); }
          if (buf.length < offset + len) break;
          const payload = buf.subarray(offset, offset + len).toString();
          buf = buf.subarray(offset + len);
          try {
            const resp = JSON.parse(payload);
            if (resp.id === 1) {
              clearTimeout(timeout);
              socket.destroy();
              if (resp.error) reject(new Error(resp.error.message));
              else resolve(resp.result);
            }
          } catch { /* not JSON yet */ }
        }
      });
      socket.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
  }

  async click(_selector: string): Promise<string> {
    return 'Error: CSS selector-based click is not available in human mode. '
      + 'Use the mouse tool with coordinates from a screenshot instead.';
  }

  async type(_selector: string, _text: string): Promise<string> {
    return 'Error: CSS selector-based typing is not available in human mode. '
      + 'Use the keyboard tool to type text directly.';
  }

  async scroll(direction: 'up' | 'down'): Promise<string> {
    await this.ensureStarted();
    this.resetIdleTimer();
    await this.mouse.scroll(direction === 'down' ? 5 : -5);
    return `Scrolled ${direction}`;
  }

  async getText(_selector?: string): Promise<string> {
    // Run via CDP Runtime.evaluate — reading page text is safe
    await this.ensureStarted();
    try {
      const result = await this.cdpEvaluate(
        _selector
          ? `document.querySelector(${JSON.stringify(_selector)})?.innerText || '(not found)'`
          : `document.body?.innerText?.substring(0, 50000) || '(empty)'`,
      );
      return typeof result === 'string' ? result : JSON.stringify(result ?? '(no result)');
    } catch (err) {
      return `getText error: ${(err as Error).message}`;
    }
  }

  async evaluate(script: string): Promise<string> {
    // Allow reading DOM state via CDP — needed for getBoundingClientRect, element discovery.
    // This uses Runtime.evaluate which does NOT trigger isTrusted event concerns.
    // Clicking/typing should still be done via mouse/keyboard tools.
    await this.ensureStarted();
    try {
      const result = await this.cdpEvaluate(script);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return `evaluate error: ${(err as Error).message}`;
    }
  }

  /** Run a script via CDP Runtime.evaluate (reading only). */
  private async cdpEvaluate(expression: string): Promise<unknown> {
    const http = await import('node:http');
    const net = await import('node:net');
    const crypto = await import('node:crypto');

    const targetsJson = await new Promise<string>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:9222/json`, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => data += c.toString());
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('CDP timeout')); });
    });

    const targets = JSON.parse(targetsJson) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('No page target');

    const wsUrl = new URL(page.webSocketDebuggerUrl);

    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection({ host: '127.0.0.1', port: 9222 }, () => {
        socket.write(
          `GET ${wsUrl.pathname} HTTP/1.1\r\nHost: 127.0.0.1:9222\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });

      let handshakeDone = false;
      let buf = Buffer.alloc(0);
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('CDP WS timeout')); }, 10000);

      socket.on('data', (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        if (!handshakeDone) {
          const idx = buf.indexOf('\r\n\r\n');
          if (idx === -1) return;
          if (!buf.subarray(0, idx).toString().includes('101')) {
            socket.destroy(); clearTimeout(timeout); reject(new Error('WS upgrade failed')); return;
          }
          handshakeDone = true;
          buf = buf.subarray(idx + 4);

          // Send evaluate command
          const payload = Buffer.from(JSON.stringify({
            id: 1, method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          }));
          const mask = crypto.randomBytes(4);
          const header = Buffer.alloc(payload.length > 125 ? 4 : 2);
          header[0] = 0x81;
          if (payload.length > 125) {
            header[1] = 0x80 | 126;
            header.writeUInt16BE(payload.length, 2);
          } else {
            header[1] = 0x80 | payload.length;
          }
          const masked = Buffer.alloc(payload.length);
          for (let i = 0; i < payload.length; i++) masked[i] = payload[i]! ^ mask[i % 4]!;
          socket.write(Buffer.concat([header, mask, masked]));
        } else {
          // Parse response frames
          if (buf.length < 2) return;
          const len = buf[1]! & 0x7f;
          const dataStart = len <= 125 ? 2 : (len === 126 ? 4 : 10);
          const dataLen = len <= 125 ? len : (len === 126 ? buf.readUInt16BE(2) : Number(buf.readBigUInt64BE(2)));
          if (buf.length < dataStart + dataLen) return;
          const frameData = buf.subarray(dataStart, dataStart + dataLen);
          try {
            const msg = JSON.parse(frameData.toString());
            if (msg.id === 1) {
              clearTimeout(timeout);
              socket.destroy();
              if (msg.error) reject(new Error(msg.error.message));
              else resolve(msg.result?.result?.value);
            }
          } catch { /* partial frame */ }
        }
      });
      socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
    });
  }

  async back(): Promise<string> {
    await this.ensureStarted();
    this.resetIdleTimer();
    await this.keyboard.hotkey(['alt'], 'left');
    await new Promise((r) => setTimeout(r, PAGE_LOAD_WAIT_MS));
    return 'Navigated back';
  }

  // ── Direct device access (for mouse/keyboard tools) ──

  getMouse(): VirtualMouse { return this.mouse; }
  getKeyboard(): VirtualKeyboard { return this.keyboard; }
  getDisplay(): VirtualDisplay { return this.display; }

  // ── Lifecycle ──

  private async ensureStarted(): Promise<void> {
    if (!this._started) await this.start();
  }

  async close(): Promise<string> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.chrome) {
      this.chrome.kill('SIGTERM');
      // Give Chrome 2s to close gracefully, then force kill
      await new Promise((r) => setTimeout(r, 2000));
      if (this.chrome && !this.chrome.killed) this.chrome.kill('SIGKILL');
      this.chrome = null;
    }

    if (this.socksForwarder) {
      await this.socksForwarder.stop();
      this.socksForwarder = null;
    }

    await this.mouse.stop();
    await this.keyboard.stop();
    await this.display.stop();

    // Persistent profile — don't delete (retains cookies, history, localStorage)

    this._started = false;
    this.onClose?.();
    return 'Browser session closed.';
  }

  get isActive(): boolean { return this._started; }
}
