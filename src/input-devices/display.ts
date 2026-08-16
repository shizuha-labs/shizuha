/**
 * Virtual display manager — Xvfb + lightweight window manager.
 *
 * Provides a real X11 display for Chrome to render on, with a window
 * manager so Chrome gets proper window decorations and focus handling.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';

export interface DisplayConfig {
  width?: number;
  height?: number;
  depth?: number;
  displayNum?: number;
}

export class VirtualDisplay {
  private xvfb: ChildProcess | null = null;
  private wm: ChildProcess | null = null;
  private _display = '';
  private _started = false;
  private width: number;
  private height: number;

  constructor(private config: DisplayConfig = {}) {
    this.width = config.width ?? 1920;
    this.height = config.height ?? 1080;
  }

  get display(): string { return this._display; }
  get resolution(): { width: number; height: number } { return { width: this.width, height: this.height }; }

  async start(): Promise<string> {
    const num = this.config.displayNum ?? 99;
    const depth = this.config.depth ?? 24;
    this._display = `:${num}`;

    // Check if Xvfb is already running on this display (e.g. started by agent via Bash)
    try {
      execSync(`test -e /tmp/.X11-unix/X${num}`, { stdio: 'pipe', timeout: 1000 });
      console.log(`[display] Xvfb already running on ${this._display} — reusing`);
      this._started = true;
      return this._display;
    } catch { /* not running — start it */ }

    // Start Xvfb
    this.xvfb = spawn('Xvfb', [
      this._display,
      '-screen', '0', `${this.width}x${this.height}x${depth}`,
      '-ac',        // disable access control (local only)
      '-nolisten', 'tcp',
      '+extension', 'GLX',   // GPU acceleration support
      '+extension', 'RANDR', // resolution changes
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env },
    });

    this.xvfb.on('error', (err) => {
      console.error(`[display] Xvfb error: ${err.message}`);
    });

    // Wait for Xvfb to be ready — check for X11 socket file (no xdpyinfo dependency)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Xvfb startup timeout (10s)')), 10000);
      const check = setInterval(() => {
        try {
          // Primary check: X11 socket file exists
          execSync(`test -e /tmp/.X11-unix/X${num}`, { stdio: 'pipe', timeout: 1000 });
          clearInterval(check);
          clearTimeout(timeout);
          resolve();
        } catch {
          // Fallback: try xdpyinfo if available
          try {
            execSync(`xdpyinfo -display ${this._display}`, { stdio: 'pipe', timeout: 1000 });
            clearInterval(check);
            clearTimeout(timeout);
            resolve();
          } catch { /* not ready yet */ }
        }
      }, 300);
    });

    // Start lightweight window manager (openbox is ~2MB, handles focus/decorations)
    try {
      this.wm = spawn('openbox', ['--sm-disable'], {
        stdio: 'ignore',
        env: { ...process.env, DISPLAY: this._display },
      });
      this.wm.on('error', () => { /* openbox not installed — ok, Chrome still works */ });
    } catch { /* openbox not available */ }

    console.log(`[display] Virtual display ${this._display} started (${this.width}x${this.height})`);
    return this._display;
  }

  /** Capture screenshot of the entire display as PNG buffer. */
  async screenshot(): Promise<Buffer> {
    // Try scrot first (faster), fall back to import (ImageMagick)
    const outPath = `/tmp/shizuha-screenshot-${Date.now()}.png`;
    try {
      execSync(`scrot -o ${outPath}`, {
        env: { ...process.env, DISPLAY: this._display },
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      try {
        execSync(`import -display ${this._display} -window root ${outPath}`, {
          timeout: 5000,
          stdio: 'pipe',
        });
      } catch {
        // Last resort: xwd + convert
        execSync(`xwd -display ${this._display} -root -silent | convert xwd:- png:${outPath}`, {
          timeout: 5000,
          stdio: 'pipe',
        });
      }
    }

    const { readFileSync, unlinkSync } = await import('node:fs');
    const buf = readFileSync(outPath);
    unlinkSync(outPath);
    return buf;
  }

  async stop(): Promise<void> {
    if (this.wm) {
      this.wm.kill('SIGTERM');
      this.wm = null;
    }
    if (this.xvfb) {
      this.xvfb.kill('SIGTERM');
      this.xvfb = null;
    }
    this._display = '';
    console.log('[display] Virtual display stopped');
  }

  get isRunning(): boolean {
    return this.xvfb !== null && !this.xvfb.killed;
  }
}
