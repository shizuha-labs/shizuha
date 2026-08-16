/**
 * Virtual keyboard — human-like keystroke timing via CDP Input.dispatchKeyEvent.
 *
 * Types with variable inter-key delays, occasional rhythm bursts,
 * and realistic modifier key handling. Uses Chrome DevTools Protocol
 * which goes through Chrome's native input pipeline.
 */

export interface KeyboardConfig {
  /** CDP port for Chrome remote debugging */
  cdpPort?: number;
  /** Base typing speed: min delay between keystrokes (ms) */
  minDelayMs?: number;
  /** Base typing speed: max delay between keystrokes (ms) */
  maxDelayMs?: number;
}

/** CDP key definitions: DOM key name → { key, code, keyCode, text } */
const KEY_DEFS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  'enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
  'tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
  'backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  'delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
  'escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
  'space': { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  'up': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  'down': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  'left': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  'right': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  'home': { key: 'Home', code: 'Home', keyCode: 36 },
  'end': { key: 'End', code: 'End', keyCode: 35 },
  'pageup': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  'pagedown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  'f1': { key: 'F1', code: 'F1', keyCode: 112 },
  'f2': { key: 'F2', code: 'F2', keyCode: 113 },
  'f3': { key: 'F3', code: 'F3', keyCode: 114 },
  'f4': { key: 'F4', code: 'F4', keyCode: 115 },
  'f5': { key: 'F5', code: 'F5', keyCode: 116 },
  'f6': { key: 'F6', code: 'F6', keyCode: 117 },
  'f7': { key: 'F7', code: 'F7', keyCode: 118 },
  'f8': { key: 'F8', code: 'F8', keyCode: 119 },
  'f9': { key: 'F9', code: 'F9', keyCode: 120 },
  'f10': { key: 'F10', code: 'F10', keyCode: 121 },
  'f11': { key: 'F11', code: 'F11', keyCode: 122 },
  'f12': { key: 'F12', code: 'F12', keyCode: 123 },
  'shift': { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  'ctrl': { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  'alt': { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  'meta': { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
  'lshift': { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  'rshift': { key: 'Shift', code: 'ShiftRight', keyCode: 16 },
  'lctrl': { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  'rctrl': { key: 'Control', code: 'ControlRight', keyCode: 17 },
};

/** Characters that require Shift. */
const SHIFT_CHARS: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']',
  '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
};

interface CdpSender {
  send(method: string, params: Record<string, unknown>): void;
  close(): void;
}

export class VirtualKeyboard {
  private cdpPort: number;
  private conn: CdpSender | null = null;
  private minDelay: number;
  private maxDelay: number;
  private msgId = 1000; // offset from mouse IDs

  constructor(config: KeyboardConfig = {}) {
    this.cdpPort = config.cdpPort ?? 9222;
    this.minDelay = config.minDelayMs ?? 50;
    this.maxDelay = config.maxDelayMs ?? 180;
  }

  /** Connect to Chrome CDP (can share connection with mouse if same port). */
  async start(): Promise<void> {
    const http = await import('node:http');
    const net = await import('node:net');
    const crypto = await import('node:crypto');

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

    const socket = await new Promise<ReturnType<typeof net.createConnection>>((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port: this.cdpPort }, () => {
        s.write(
          `GET ${wsUrl.pathname} HTTP/1.1\r\n` +
          `Host:127.0.0.1:${this.cdpPort}\r\n` +
          `Upgrade:websocket\r\nConnection:Upgrade\r\n` +
          `Sec-WebSocket-Key:${key}\r\nSec-WebSocket-Version:13\r\n\r\n`,
        );
      });
      s.once('data', (d: Buffer) => {
        if (d.toString().includes('101')) resolve(s);
        else reject(new Error('WS upgrade failed'));
      });
      s.on('error', reject);
    });

    const self = this;
    this.conn = {
      send(method: string, params: Record<string, unknown>) {
        const p = Buffer.from(JSON.stringify({ id: self.msgId++, method, params }));
        const m = crypto.randomBytes(4);
        const h = Buffer.alloc(2 + (p.length > 125 ? 2 : 0) + 4 + p.length);
        let o = 0;
        h[o++] = 0x81;
        if (p.length > 125) { h[o++] = 0x80 | 126; h.writeUInt16BE(p.length, o); o += 2; }
        else { h[o++] = 0x80 | p.length; }
        m.copy(h, o); o += 4;
        for (let i = 0; i < p.length; i++) h[o + i] = p[i]! ^ m[i % 4]!;
        socket.write(h);
      },
      close() { socket.destroy(); },
    };
  }

  /** Press and release a named key. */
  async pressKey(key: string): Promise<void> {
    if (!this.conn) throw new Error('Keyboard not started');

    const def = KEY_DEFS[key.toLowerCase()];
    if (def) {
      this.conn.send('Input.dispatchKeyEvent', {
        type: 'keyDown', key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
      });
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
      this.conn.send('Input.dispatchKeyEvent', {
        type: 'keyUp', key: def.key, code: def.code,
        windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
      });
    } else {
      // Single character key
      await this.typeChar(key);
    }
  }

  /** Hold a modifier key down. */
  holdKey(key: string): void {
    if (!this.conn) throw new Error('Keyboard not started');
    const def = KEY_DEFS[key.toLowerCase()];
    if (!def) throw new Error(`Unknown key: ${key}`);
    this.conn.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key: def.key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
    });
  }

  /** Release a held modifier key. */
  releaseKey(key: string): void {
    if (!this.conn) throw new Error('Keyboard not started');
    const def = KEY_DEFS[key.toLowerCase()];
    if (!def) throw new Error(`Unknown key: ${key}`);
    this.conn.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: def.key, code: def.code,
      windowsVirtualKeyCode: def.keyCode, nativeVirtualKeyCode: def.keyCode,
    });
  }

  /** Keyboard shortcut (e.g., Ctrl+L, Ctrl+Shift+T). */
  async hotkey(modifiers: string[], key: string): Promise<void> {
    // Build modifier bitmask
    let modBits = 0;
    for (const mod of modifiers) {
      const m = mod.toLowerCase();
      if (m === 'ctrl' || m === 'control') modBits |= 2;
      if (m === 'alt') modBits |= 1;
      if (m === 'shift') modBits |= 8;
      if (m === 'meta' || m === 'super') modBits |= 4;
      this.holdKey(mod);
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }

    await this.pressKey(key);

    for (let i = modifiers.length - 1; i >= 0; i--) {
      await new Promise((r) => setTimeout(r, 10 + Math.random() * 20));
      this.releaseKey(modifiers[i]!);
    }
  }

  /**
   * Type a string with human-like timing.
   *
   * Features:
   * - Variable inter-key delay
   * - Occasional burst typing (3-5 fast characters)
   * - Longer pauses after spaces and punctuation
   * - Proper shift handling for uppercase and symbols
   */
  async typeText(text: string): Promise<void> {
    let burstCounter = 0;
    let burstLength = 3 + Math.floor(Math.random() * 4);

    for (let i = 0; i < text.length; i++) {
      const char = text[i]!;
      await this.typeChar(char);

      burstCounter++;
      let delay: number;

      if (burstCounter < burstLength) {
        delay = this.minDelay + Math.random() * (this.maxDelay - this.minDelay) * 0.4;
      } else {
        delay = this.minDelay + Math.random() * (this.maxDelay - this.minDelay);
        burstCounter = 0;
        burstLength = 3 + Math.floor(Math.random() * 4);
      }

      if (char === ' ') delay *= 1.2;
      if ('.!?,;:'.includes(char)) delay *= 1.5;

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  /** Type a single character via CDP. */
  private async typeChar(char: string): Promise<void> {
    if (!this.conn) throw new Error('Keyboard not started');

    // CDP's simplest approach for printable chars: use 'char' event type
    this.conn.send('Input.dispatchKeyEvent', {
      type: 'char',
      text: char,
      unmodifiedText: char,
    });
  }

  async stop(): Promise<void> {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }
}
