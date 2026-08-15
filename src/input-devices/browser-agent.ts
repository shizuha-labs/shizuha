/**
 * Browser Agent — single persistent CDP session for human-like web interaction.
 *
 * DESIGN PRINCIPLES:
 *   1. ONE CDP WebSocket connection for the entire session (no reconnects between actions)
 *   2. READ via Runtime.evaluate (invisible to the page — server never sees these)
 *   3. WRITE via Input.dispatchMouseEvent / Input.dispatchKeyEvent ONLY
 *      (these produce isTrusted:true events indistinguishable from real hardware)
 *   4. NEVER use JS .click(), .focus(), .value=, dispatchEvent on page elements
 *   5. Human timing: natural delays, no instant actions, mouse bezier curves
 *   6. Coordinate cache: getBoundingClientRect results cached per page state
 *
 * The server sees: real mouse movements, real keystrokes, real clicks.
 * The server CANNOT see: our Runtime.evaluate calls (these are debugger-level, not page-level).
 */

import * as http from 'node:http';
import * as net from 'node:net';
import * as crypto from 'node:crypto';

export interface ElementInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  tag: string;
  text: string;
  testId?: string;
  visible: boolean;
}

export interface BrowserAgentConfig {
  cdpPort?: number;
  /** Minimum delay between actions (ms) */
  minActionDelay?: number;
  /** Maximum delay between actions (ms) */
  maxActionDelay?: number;
  /** Mouse movement speed factor (lower = faster) */
  mouseSpeed?: number;
  /** Typing speed: min ms between keystrokes */
  typeMinDelay?: number;
  /** Typing speed: max ms between keystrokes */
  typeMaxDelay?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

export class BrowserAgent {
  private ws: net.Socket | null = null;
  private cdpPort: number;
  private msgId = 1;
  private mouseX = 960;
  private mouseY = 540;
  private config: Required<BrowserAgentConfig>;

  // Response handling
  private responseBuffer = Buffer.alloc(0);
  private pendingResponses = new Map<number, (result: unknown) => void>();
  private handshakeDone = false;

  constructor(config: BrowserAgentConfig = {}) {
    this.cdpPort = config.cdpPort ?? 9222;
    this.config = {
      cdpPort: this.cdpPort,
      minActionDelay: config.minActionDelay ?? 200,
      maxActionDelay: config.maxActionDelay ?? 600,
      mouseSpeed: config.mouseSpeed ?? 8,
      typeMinDelay: config.typeMinDelay ?? 40,
      typeMaxDelay: config.typeMaxDelay ?? 120,
    };
  }

  // ── Connection ──

  async connect(): Promise<void> {
    const targetsJson = await new Promise<string>((resolve, reject) => {
      http.get(`http://127.0.0.1:${this.cdpPort}/json`, (res) => {
        let d = '';
        res.on('data', (c: Buffer) => d += c.toString());
        res.on('end', () => resolve(d));
      }).on('error', reject);
    });

    const targets = JSON.parse(targetsJson) as Array<{ type: string; webSocketDebuggerUrl: string }>;
    const page = targets.find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('No CDP page target');

    const wsUrl = new URL(page.webSocketDebuggerUrl);
    const key = crypto.randomBytes(16).toString('base64');

    this.ws = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: this.cdpPort }, () => {
        s.write(
          `GET ${wsUrl.pathname} HTTP/1.1\r\n` +
          `Host:127.0.0.1:${this.cdpPort}\r\n` +
          `Upgrade:websocket\r\nConnection:Upgrade\r\n` +
          `Sec-WebSocket-Key:${key}\r\nSec-WebSocket-Version:13\r\n\r\n`,
        );
      });
      s.on('error', reject);
      s.on('data', (chunk: Buffer) => {
        if (!this.handshakeDone) {
          const str = chunk.toString();
          if (str.includes('101')) {
            this.handshakeDone = true;
            // Store any remaining data after handshake
            const idx = chunk.indexOf('\r\n\r\n');
            if (idx >= 0) this.responseBuffer = Buffer.from(chunk.subarray(idx + 4));
            resolve(s);
          }
        } else {
          this.handleData(chunk);
        }
      });
    });

    // Continue handling data after handshake
    this.ws.on('data', (chunk: Buffer) => {
      if (this.handshakeDone) this.handleData(chunk);
    });
  }

  private handleData(chunk: Buffer): void {
    this.responseBuffer = Buffer.concat([this.responseBuffer, chunk]);

    // Parse WebSocket frames
    while (this.responseBuffer.length > 2) {
      const secondByte = this.responseBuffer[1]! & 0x7f;
      let payloadStart = 2;
      let payloadLen = secondByte;

      if (secondByte === 126) {
        if (this.responseBuffer.length < 4) return;
        payloadLen = this.responseBuffer.readUInt16BE(2);
        payloadStart = 4;
      } else if (secondByte === 127) {
        // 64-bit length — skip for now (very large messages)
        return;
      }

      if (this.responseBuffer.length < payloadStart + payloadLen) return;

      try {
        const payload = this.responseBuffer.subarray(payloadStart, payloadStart + payloadLen).toString();
        const msg = JSON.parse(payload);
        if (msg.id && this.pendingResponses.has(msg.id)) {
          this.pendingResponses.get(msg.id)!(msg.result);
          this.pendingResponses.delete(msg.id);
        }
      } catch { /* non-JSON or partial frame */ }

      this.responseBuffer = this.responseBuffer.subarray(payloadStart + payloadLen);
    }
  }

  // ── Low-level CDP ──

  private sendRaw(method: string, params: Record<string, unknown> = {}): number {
    if (!this.ws) throw new Error('Not connected');
    const id = this.msgId++;
    const payload = Buffer.from(JSON.stringify({ id, method, params }));
    const mask = crypto.randomBytes(4);
    const header = Buffer.alloc(2 + (payload.length > 125 ? 2 : 0) + 4 + payload.length);
    let off = 0;
    header[off++] = 0x81; // FIN + TEXT
    if (payload.length > 125) {
      header[off++] = 0x80 | 126;
      header.writeUInt16BE(payload.length, off);
      off += 2;
    } else {
      header[off++] = 0x80 | payload.length;
    }
    mask.copy(header, off);
    off += 4;
    for (let i = 0; i < payload.length; i++) header[off + i] = payload[i]! ^ mask[i % 4]!;
    this.ws.write(header);
    return id;
  }

  /** Send CDP command and wait for response. */
  private async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve) => {
      const id = this.sendRaw(method, params);
      this.pendingResponses.set(id, resolve);
      setTimeout(() => {
        if (this.pendingResponses.has(id)) {
          this.pendingResponses.delete(id);
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /** Fire-and-forget CDP command (no response needed). */
  private fire(method: string, params: Record<string, unknown> = {}): void {
    this.sendRaw(method, params);
  }

  // ── Reading (invisible to the page) ──

  /** Evaluate JavaScript in the page context. Returns the result as a string. */
  async evaluate(expression: string): Promise<string | null> {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    }) as { result?: { value?: unknown } } | null;
    const val = result?.result?.value;
    return val !== undefined ? String(val) : null;
  }

  /** Find an element by visible text content. Returns its viewport coordinates. */
  async findByText(text: string, options?: { exact?: boolean; index?: number }): Promise<ElementInfo | null> {
    const exact = options?.exact ?? true;
    const index = options?.index ?? 0;
    const escapedText = text.replace(/'/g, "\\'").replace(/\\/g, '\\\\');

    const js = exact
      ? `JSON.stringify((() => {
          const els = [...document.querySelectorAll('*')].filter(e =>
            e.textContent.trim() === '${escapedText}' &&
            e.children.length === 0 &&
            e.offsetParent !== null &&
            e.getBoundingClientRect().width > 0
          );
          const el = els[${index}];
          if (!el) return null;
          const btn = el.closest('[role="button"]') || el.closest('button') || el.closest('a') || el;
          const r = btn.getBoundingClientRect();
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
                   width: Math.round(r.width), height: Math.round(r.height),
                   tag: btn.tagName, text: btn.textContent.trim().substring(0,50),
                   testId: btn.dataset?.testid || '', visible: r.width > 0 && r.height > 0 };
        })())`
      : `JSON.stringify((() => {
          const els = [...document.querySelectorAll('*')].filter(e =>
            e.textContent.includes('${escapedText}') &&
            e.children.length === 0 &&
            e.offsetParent !== null
          );
          const el = els[${index}];
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
                   width: Math.round(r.width), height: Math.round(r.height),
                   tag: el.tagName, text: el.textContent.trim().substring(0,50),
                   testId: el.dataset?.testid || '', visible: r.width > 0 && r.height > 0 };
        })())`;

    const result = await this.evaluate(js);
    if (!result || result === 'null') return null;
    try { return JSON.parse(result) as ElementInfo; } catch { return null; }
  }

  /** Find an element by CSS selector. */
  async findBySelector(selector: string): Promise<ElementInfo | null> {
    const escapedSelector = selector.replace(/'/g, "\\'");
    const js = `JSON.stringify((() => {
      const el = document.querySelector('${escapedSelector}');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2),
               width: Math.round(r.width), height: Math.round(r.height),
               tag: el.tagName, text: (el.textContent || '').trim().substring(0,50),
               testId: el.dataset?.testid || '', visible: r.width > 0 && r.height > 0 };
    })())`;
    const result = await this.evaluate(js);
    if (!result || result === 'null') return null;
    try { return JSON.parse(result) as ElementInfo; } catch { return null; }
  }

  /** Find an element by data-testid attribute. */
  async findByTestId(testId: string): Promise<ElementInfo | null> {
    return this.findBySelector(`[data-testid="${testId}"]`);
  }

  /** Get the current page title. */
  async getTitle(): Promise<string> {
    return (await this.evaluate('document.title')) ?? '';
  }

  /** Get the current URL. */
  async getUrl(): Promise<string> {
    return (await this.evaluate('window.location.href')) ?? '';
  }

  /** Wait for an element to appear (polls every 500ms). */
  async waitForElement(textOrSelector: string, timeoutMs = 15000): Promise<ElementInfo | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const el = textOrSelector.startsWith('[') || textOrSelector.startsWith('#') || textOrSelector.startsWith('.')
        ? await this.findBySelector(textOrSelector)
        : await this.findByText(textOrSelector);
      if (el?.visible) return el;
      await sleep(500);
    }
    return null;
  }

  /** Wait for navigation (URL change or title change). */
  async waitForNavigation(timeoutMs = 15000): Promise<boolean> {
    const startUrl = await this.getUrl();
    const startTitle = await this.getTitle();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(500);
      const url = await this.getUrl();
      const title = await this.getTitle();
      if (url !== startUrl || title !== startTitle) return true;
    }
    return false;
  }

  // ── Writing (human-like input via CDP Input.dispatch*) ──

  /** Move mouse along a human-like bezier curve to target coordinates. */
  async mouseMove(targetX: number, targetY: number): Promise<void> {
    const dx = targetX - this.mouseX;
    const dy = targetY - this.mouseY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 2) {
      this.mouseX = targetX;
      this.mouseY = targetY;
      return;
    }

    const steps = Math.max(8, Math.min(40, Math.round(distance / 12)));
    const overshoot = Math.min(distance * 0.1, 20) * (Math.random() > 0.5 ? 1 : -1);
    const cp1x = this.mouseX + dx * 0.3 + (Math.random() - 0.5) * overshoot;
    const cp1y = this.mouseY + dy * 0.3 + (Math.random() - 0.5) * overshoot;
    const cp2x = this.mouseX + dx * 0.7 + (Math.random() - 0.5) * overshoot * 0.5;
    const cp2y = this.mouseY + dy * 0.7 + (Math.random() - 0.5) * overshoot * 0.5;

    const totalMs = Math.max(60, Math.min(400, distance * this.config.mouseSpeed / 100));

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const et = 1 - Math.pow(1 - t, 2.5);
      let nx = Math.round(bezier(et, this.mouseX, cp1x, cp2x, targetX));
      let ny = Math.round(bezier(et, this.mouseY, cp1y, cp2y, targetY));
      if (i < steps) {
        nx += Math.round((Math.random() - 0.5) * 1.5);
        ny += Math.round((Math.random() - 0.5) * 1.5);
      }
      this.fire('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx, y: ny, button: 'none', clickCount: 0 });
      await sleep(totalMs / steps * (0.7 + Math.random() * 0.6));
    }

    this.fire('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: targetY, button: 'none', clickCount: 0 });
    this.mouseX = targetX;
    this.mouseY = targetY;
  }

  /** Click at the current mouse position. */
  async mouseClick(button: 'left' | 'right' = 'left'): Promise<void> {
    this.fire('Input.dispatchMouseEvent', { type: 'mousePressed', x: this.mouseX, y: this.mouseY, button, clickCount: 1 });
    await sleep(50 + Math.random() * 60);
    this.fire('Input.dispatchMouseEvent', { type: 'mouseReleased', x: this.mouseX, y: this.mouseY, button, clickCount: 1 });
    await sleep(20 + Math.random() * 30);
  }

  /** Move to an element and click it. Human-like: move → pause → click. */
  async click(el: ElementInfo): Promise<void> {
    // Small random offset within the element (don't always click dead center)
    const offsetX = Math.round((Math.random() - 0.5) * el.width * 0.4);
    const offsetY = Math.round((Math.random() - 0.5) * el.height * 0.3);
    await this.mouseMove(el.x + offsetX, el.y + offsetY);
    await sleep(30 + Math.random() * 80); // human reaction time before clicking
    await this.mouseClick();
  }

  /** Find element by text and click it. Returns true if found and clicked. */
  async clickText(text: string): Promise<boolean> {
    const el = await this.findByText(text);
    if (!el) return false;
    await this.click(el);
    return true;
  }

  /** Find element by test ID and click it. */
  async clickTestId(testId: string): Promise<boolean> {
    const el = await this.findByTestId(testId);
    if (!el) return false;
    await this.click(el);
    return true;
  }

  /** Type text with human-like timing. Assumes the target field is already focused. */
  async type(text: string): Promise<void> {
    let burstCounter = 0;
    let burstLength = 3 + Math.floor(Math.random() * 4);

    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      this.fire('Input.dispatchKeyEvent', { type: 'char', text: char, unmodifiedText: char });

      burstCounter++;
      let delay: number;
      if (burstCounter < burstLength) {
        delay = this.config.typeMinDelay + Math.random() * (this.config.typeMaxDelay - this.config.typeMinDelay) * 0.4;
      } else {
        delay = this.config.typeMinDelay + Math.random() * (this.config.typeMaxDelay - this.config.typeMinDelay);
        burstCounter = 0;
        burstLength = 3 + Math.floor(Math.random() * 4);
      }
      if (char === ' ') delay *= 1.2;
      if ('.!?,;:'.includes(char)) delay *= 1.5;
      await sleep(delay);
    }
  }

  /** Press a named key (Enter, Tab, Backspace, Escape, etc.) */
  async pressKey(key: string): Promise<void> {
    const keyDefs: Record<string, { key: string; code: string; keyCode: number }> = {
      enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
      tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
      backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
      escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
      delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    };
    const def = keyDefs[key.toLowerCase()] ?? { key, code: key, keyCode: 0 };
    this.fire('Input.dispatchKeyEvent', { type: 'keyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode });
    await sleep(40 + Math.random() * 40);
    this.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode });
  }

  /** Keyboard shortcut (e.g., hotkey(['ctrl'], 'a') for Ctrl+A). */
  async hotkey(modifiers: string[], key: string): Promise<void> {
    for (const mod of modifiers) {
      const def = mod.toLowerCase() === 'ctrl' ? { key: 'Control', code: 'ControlLeft', kc: 17 }
        : mod.toLowerCase() === 'shift' ? { key: 'Shift', code: 'ShiftLeft', kc: 16 }
        : mod.toLowerCase() === 'alt' ? { key: 'Alt', code: 'AltLeft', kc: 18 }
        : { key: 'Meta', code: 'MetaLeft', kc: 91 };
      this.fire('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: def.key, code: def.code, windowsVirtualKeyCode: def.kc });
      await sleep(15 + Math.random() * 20);
    }
    await this.pressKey(key);
    for (let i = modifiers.length - 1; i >= 0; i--) {
      await sleep(10 + Math.random() * 15);
      const mod = modifiers[i]!.toLowerCase();
      const def = mod === 'ctrl' ? { key: 'Control', code: 'ControlLeft', kc: 17 }
        : mod === 'shift' ? { key: 'Shift', code: 'ShiftLeft', kc: 16 }
        : mod === 'alt' ? { key: 'Alt', code: 'AltLeft', kc: 18 }
        : { key: 'Meta', code: 'MetaLeft', kc: 91 };
      this.fire('Input.dispatchKeyEvent', { type: 'keyUp', key: def.key, code: def.code, windowsVirtualKeyCode: def.kc });
    }
  }

  // ── High-level actions (compound, human-like) ──

  /** Click a field, clear it, and type new text. */
  async clearAndType(el: ElementInfo, text: string): Promise<void> {
    await this.click(el);
    await sleep(100 + Math.random() * 150);
    await this.hotkey(['ctrl'], 'a');
    await sleep(50 + Math.random() * 50);
    await this.pressKey('backspace');
    await sleep(100 + Math.random() * 100);
    await this.type(text);
  }

  /** Click a field (found by placeholder/label text), clear it, and type. */
  async fillField(labelOrPlaceholder: string, value: string): Promise<boolean> {
    const el = await this.findByText(labelOrPlaceholder) ?? await this.findBySelector(`[placeholder*="${labelOrPlaceholder}"]`);
    if (!el) return false;
    await this.clearAndType(el, value);
    return true;
  }

  /** Human pause between actions. */
  async pause(): Promise<void> {
    await sleep(this.config.minActionDelay + Math.random() * (this.config.maxActionDelay - this.config.minActionDelay));
  }

  /** Short pause (between related actions). */
  async shortPause(): Promise<void> {
    await sleep(100 + Math.random() * 200);
  }

  /** Take a screenshot via scrot (requires DISPLAY env set). */
  async screenshot(path: string): Promise<void> {
    const { execSync } = await import('node:child_process');
    execSync(`scrot -o ${path}`, { env: { ...process.env }, timeout: 5000, stdio: 'pipe' });
  }

  // ── Lifecycle ──

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.destroy();
      this.ws = null;
    }
    this.handshakeDone = false;
    this.pendingResponses.clear();
  }
}
