/**
 * Virtual mouse — human-like mouse movement via CDP Input.dispatchMouseEvent.
 *
 * DESIGN PRINCIPLE: No teleportation. Every position change goes through
 * a bezier curve with human-like acceleration, deceleration, and micro-jitter.
 * There is NO absolute positioning API — the cursor always moves along a
 * continuous path, exactly as a physical mouse would.
 *
 * Uses Chrome DevTools Protocol (CDP) Input.dispatchMouseEvent which goes
 * through Chrome's native input pipeline — indistinguishable from real
 * hardware events, including for cross-origin iframe interactions (Cloudflare
 * Turnstile, etc.).
 */

export interface MouseConfig {
  /** CDP port for Chrome remote debugging */
  cdpPort?: number;
  /** Base movement speed (ms per 100px of distance) */
  speedMs?: number;
  /** Jitter amplitude in pixels (0 = perfectly smooth) */
  jitter?: number;
  /** Screen width */
  screenWidth?: number;
  /** Screen height */
  screenHeight?: number;
}

/** Generate a point on a cubic bezier curve at parameter t (0-1). */
function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

/** Raw CDP WebSocket connection for Input.dispatch* calls. */
interface CdpConnection {
  send(method: string, params: Record<string, unknown>): void;
  close(): void;
  destroyed?: boolean;
}

export class VirtualMouse {
  private cdpPort: number;
  private conn: CdpConnection | null = null;
  private _x: number;
  private _y: number;
  private speedMs: number;
  private jitter: number;
  private msgId = 1;

  constructor(config: MouseConfig = {}) {
    this.cdpPort = config.cdpPort ?? 9222;
    this.speedMs = config.speedMs ?? 8;
    this.jitter = config.jitter ?? 1.5;
    // Start at center of viewport (a natural resting position)
    this._x = Math.round((config.screenWidth ?? 1920) / 2);
    this._y = Math.round((config.screenHeight ?? 1080) / 2);
  }

  get x(): number { return this._x; }
  get y(): number { return this._y; }

  /** Connect to Chrome's CDP WebSocket for input dispatch. */
  async start(): Promise<void> {
    const http = await import('node:http');
    const net = await import('node:net');
    const crypto = await import('node:crypto');

    // Get page target WS URL
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

    // Send initial mouseMoved to establish cursor position
    this.conn.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: this._x, y: this._y, button: 'none', clickCount: 0,
    });
  }

  /**
   * Move the mouse to target coordinates with human-like bezier curve.
   *
   * This is the ONLY way to change cursor position. There is no teleport/
   * absolute positioning API. Every movement follows a continuous path with:
   * - Bezier curve trajectory (not straight line)
   * - Ease-out deceleration (fast start, slow approach)
   * - Micro-jitter (simulates hand tremor)
   * - Slight overshoot on longer movements
   * - Variable step timing
   */
  async moveTo(targetX: number, targetY: number): Promise<void> {
    if (!this.conn || this.conn.destroyed) {
      // CDP connection lost — try to reconnect
      try { await this.start(); } catch { throw new Error('CDP connection lost and reconnect failed — Chrome may have crashed'); }
    }

    const dx = targetX - this._x;
    const dy = targetY - this._y;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 2) {
      this._x = targetX;
      this._y = targetY;
      return;
    }

    // Steps scale with distance (more = smoother)
    const steps = Math.max(10, Math.min(60, Math.round(distance / 10)));

    // Bezier control points with natural overshoot — reduced for short distances
    // to prevent landing on adjacent elements (e.g., transparent link overlays).
    const overshootScale = distance < 100 ? 0.05 : 0.12;
    const overshoot = Math.min(distance * overshootScale, 20) * (Math.random() > 0.5 ? 1 : -1);
    const cp1x = this._x + dx * 0.3 + (Math.random() - 0.5) * overshoot;
    const cp1y = this._y + dy * 0.3 + (Math.random() - 0.5) * overshoot;
    const cp2x = this._x + dx * 0.7 + (Math.random() - 0.5) * overshoot * 0.4;
    const cp2y = this._y + dy * 0.7 + (Math.random() - 0.5) * overshoot * 0.4;

    // Movement time: 80-500ms depending on distance
    const totalTimeMs = Math.max(80, Math.min(500, distance * this.speedMs / 100));
    const stepDelayMs = totalTimeMs / steps;

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const easedT = 1 - Math.pow(1 - t, 2.5); // ease-out

      let nextX = Math.round(bezier(easedT, this._x, cp1x, cp2x, targetX));
      let nextY = Math.round(bezier(easedT, this._y, cp1y, cp2y, targetY));

      // Micro-jitter (not on final step)
      if (i < steps && this.jitter > 0) {
        nextX += Math.round((Math.random() - 0.5) * this.jitter * 2);
        nextY += Math.round((Math.random() - 0.5) * this.jitter * 2);
      }

      const conn = this.conn;
      if (!conn) throw new Error('Mouse not started');
      conn.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: nextX, y: nextY, button: 'none', clickCount: 0,
      });

      const jitteredDelay = stepDelayMs * (0.7 + Math.random() * 0.6);
      await new Promise((r) => setTimeout(r, jitteredDelay));
    }

    // Final position (exact, no jitter)
    const conn = this.conn;
    if (!conn) throw new Error('Mouse not started');
    conn.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: targetX, y: targetY, button: 'none', clickCount: 0,
    });

    this._x = targetX;
    this._y = targetY;
  }

  /** Click at current position. */
  async click(button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    if (!this.conn || this.conn.destroyed) {
      try { await this.start(); } catch { throw new Error('CDP connection lost — Chrome may have crashed'); }
    }
    const conn = this.conn;
    if (!conn) throw new Error('Mouse not started');

    // CRITICAL: `buttons: 1` is required for React apps (like X/Twitter) to register the click.
    // Without it, mousePressed fires but React's synthetic event system ignores it.
    const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
    conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: this._x, y: this._y, button, clickCount: 1, buttons,
    });
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 70));
    conn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: this._x, y: this._y, button, clickCount: 1, buttons: 0,
    });
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
  }

  /** Move to coordinates and click. */
  async clickAt(x: number, y: number, button: 'left' | 'right' | 'middle' = 'left'): Promise<void> {
    await this.moveTo(x, y);
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 80));
    await this.click(button);
  }

  /** Double-click at current position. */
  async doubleClick(): Promise<void> {
    await this.click('left');
    await new Promise((r) => setTimeout(r, 80 + Math.random() * 80));
    await this.click('left');
  }

  /** Scroll the mouse wheel. Positive = down, negative = up. */
  async scroll(delta: number): Promise<void> {
    if (!this.conn) throw new Error('Mouse not started');

    // delta is in pixels. One mouse wheel notch = 120px.
    // Simulate a natural scroll: break into notch-sized ticks with human-like timing.
    const totalPixels = Math.abs(Math.round(delta));
    const direction = delta > 0 ? 1 : -1;
    const notchSize = 120; // pixels per wheel notch (browser standard)
    const ticks = Math.max(1, Math.ceil(totalPixels / notchSize));

    for (let i = 0; i < ticks; i++) {
      // Last tick may be a partial notch
      const remaining = totalPixels - i * notchSize;
      const tickDelta = Math.min(remaining, notchSize);
      this.conn.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: this._x, y: this._y,
        deltaX: 0, deltaY: direction * tickDelta,
        button: 'none', clickCount: 0,
      });
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 30));
    }
  }

  /** Drag from current position to target. */
  async drag(toX: number, toY: number): Promise<void> {
    if (!this.conn) throw new Error('Mouse not started');

    this.conn.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: this._x, y: this._y, button: 'left', clickCount: 1,
    });
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
    await this.moveTo(toX, toY);
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
    this.conn.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: this._x, y: this._y, button: 'left', clickCount: 1,
    });
  }

  async stop(): Promise<void> {
    if (this.conn) {
      this.conn.close();
      this.conn = null;
    }
  }
}
