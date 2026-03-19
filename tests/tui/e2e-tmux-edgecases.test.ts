import { beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StateStore } from '../../src/state/store.js';

const projectDir = path.resolve(import.meta.dirname!, '../..');

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function run(command: string, cwd = projectDir): string {
  return execSync(command, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function sleepMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function hasTmux(): boolean {
  try {
    run('tmux -V');
    return true;
  } catch {
    return false;
  }
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

function stageProviderCredentials(tempHome: string): boolean {
  const srcDir = path.join(os.homedir(), '.shizuha');
  const dstDir = path.join(tempHome, '.shizuha');
  const candidates = ['credentials.json', 'auth.json', 'jwt_token', 'config.toml'];
  let copiedAny = false;
  for (const file of candidates) {
    const src = path.join(srcDir, file);
    const dst = path.join(dstDir, file);
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      copiedAny = true;
    }
  }
  return copiedAny;
}

function seedLargeSessions(homeDir: string, cwd: string, count = 140): void {
  const dbPath = path.join(homeDir, '.config', 'shizuha', 'state.db');
  const store = new StateStore(dbPath);
  const now = Date.now();

  for (let i = 0; i < count; i += 1) {
    const session = store.createSession('gpt-5.3-codex', cwd);
    const title = `edge-resume-${String(i).padStart(3, '0')} ${'very-long-content '.repeat(10)}`;
    const userMsg = `${title}\n${'x'.repeat(800)}`;
    const assistantMsg = `assistant-${i} ${'y'.repeat(1800)}`;
    const ts = now - (count - i) * 60_000;
    store.appendMessage(session.id, { role: 'user', content: userMsg, timestamp: ts });
    store.appendMessage(session.id, { role: 'assistant', content: assistantMsg, timestamp: ts + 1000 });
    store.updateTokens(session.id, 60_000 + i * 11, 35_000 + i * 7);
    if (i % 2 === 0) {
      store.renameSession(session.id, `${title} ${'z'.repeat(80)}`);
    }
  }

  store.close();
}

function newSessionName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function launchTmux(
  name: string,
  width: number,
  height: number,
  command: string,
): { session: string; target: string } {
  const session = newSessionName(name);
  const target = `${session}:0.0`;
  run(`tmux new-session -d -x ${width} -y ${height} -s ${shQuote(session)} ${shQuote(command)}`);
  return { session, target };
}

function killTmux(session: string): void {
  try {
    run(`tmux kill-session -t ${shQuote(session)}`);
  } catch {
    // ignore
  }
}

function capture(target: string, startLine = -320): string {
  return run(`tmux capture-pane -p -t ${shQuote(target)} -S ${startLine}`);
}

function sendKeys(target: string, ...keys: string[]): void {
  const args = keys.map(shQuote).join(' ');
  run(`tmux send-keys -t ${shQuote(target)} ${args}`);
}

function sendLiteral(target: string, text: string): void {
  run(`tmux send-keys -t ${shQuote(target)} -l ${shQuote(text)}`);
}

async function waitForPattern(target: string, pattern: RegExp, timeoutMs: number): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    last = capture(target);
    if (pattern.test(last)) return last;
    await sleepMs(80);
  }
  throw new Error(`Timeout waiting for ${pattern}. Last capture:\n${last.slice(-2000)}`);
}

const runTmuxEdgeSuite = hasTmux() && process.env['SHIZUHA_RUN_TMUX_EDGE_E2E'] === '1';
const tmuxDescribe = runTmuxEdgeSuite ? describe : describe.skip;

tmuxDescribe('TUI tmux edge-case rendering tests', () => {
  beforeAll(() => {
    run('npm run build');
  }, 35000);

  it('keeps /resume picker structurally stable with large session content', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-tmux-resume-'));
    stageProviderCredentials(tempHome);
    seedLargeSessions(tempHome, projectDir, 120);

    const launchCommand = `cd ${shQuote(projectDir)} && HOME=${shQuote(tempHome)} FORCE_COLOR=0 node dist/shizuha.js --model claude-opus-4-6`;
    const { session, target } = launchTmux('resume_stability', 76, 42, launchCommand);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);
      sendKeys(target, '/resume');
      await sleepMs(60);
      sendKeys(target, 'C-m');
      await waitForPattern(target, /Sessions|☰ Sessions/, 15_000);

      const violations: string[] = [];
      const batches = 40;
      const keysPerBatch = 3;

      for (let i = 0; i < batches; i += 1) {
        for (let j = 0; j < keysPerBatch; j += 1) {
          sendKeys(target, 'Down');
          await sleepMs(15);
        }
        await sleepMs(20);
        const frame = capture(target);
        const selected = countMatches(frame, /▶/g);
        const showing = countMatches(frame, /Showing \d+-\d+ of \d+ items/g);
        const topBorder = countMatches(frame, /╭/g);
        const bottomBorder = countMatches(frame, /╰/g);
        if (selected !== 1 || showing !== 1 || topBorder !== 1 || bottomBorder !== 1) {
          violations.push(`down-batch:${i} selected=${selected} showing=${showing} top=${topBorder} bottom=${bottomBorder}`);
        }
      }

      for (let i = 0; i < batches; i += 1) {
        for (let j = 0; j < keysPerBatch; j += 1) {
          sendKeys(target, 'Up');
          await sleepMs(15);
        }
        await sleepMs(20);
        const frame = capture(target);
        const selected = countMatches(frame, /▶/g);
        const showing = countMatches(frame, /Showing \d+-\d+ of \d+ items/g);
        const topBorder = countMatches(frame, /╭/g);
        const bottomBorder = countMatches(frame, /╰/g);
        if (selected !== 1 || showing !== 1 || topBorder !== 1 || bottomBorder !== 1) {
          violations.push(`up-batch:${i} selected=${selected} showing=${showing} top=${topBorder} bottom=${bottomBorder}`);
        }
      }

      expect(violations).toEqual([]);
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);

  it('keeps input rendering stable when launched after heavy scrollback near pane bottom', async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'shizuha-tmux-bottom-'));
    const hasCreds = stageProviderCredentials(tempHome);
    if (!hasCreds) return;
    const prefill = 'for i in $(seq 1 260); do printf "prefill-%03d\\n" "$i"; done';
    const launchCommand = `cd ${shQuote(projectDir)} && ${prefill} && HOME=${shQuote(tempHome)} FORCE_COLOR=0 node dist/shizuha.js --model claude-opus-4-6`;
    const { session, target } = launchTmux('bottom_launch', 72, 40, launchCommand);

    try {
      await waitForPattern(target, /Type a message|❯/, 15_000);
      const launchFrame = capture(target, -120);
      const launchLines = launchFrame.split('\n');
      const launchStatusIdx = launchLines.findIndex((line) => line.includes('| sup |'));
      expect(launchStatusIdx).toBeGreaterThan(0);
      const trailingAfterStatus = launchLines.slice(launchStatusIdx + 1);
      expect(trailingAfterStatus.filter((line) => line.trim().length > 0).length).toBe(0);
      expect(trailingAfterStatus.length).toBeLessThanOrEqual(2);

      const marker = 'heightprobe_marker';
      const longInput = `${marker}_a ${marker}_b ${marker}_c ${marker}_d ${marker}_e ${marker}_f ${marker}_g`;
      sendLiteral(target, longInput);
      await sleepMs(220);

      const typedFrame = capture(target);
      const lines = typedFrame.split('\n');
      const statusIdx = lines.findIndex((line) => line.includes('| sup |'));
      expect(statusIdx).toBeGreaterThan(0);

      const inputWindow = lines.slice(Math.max(0, statusIdx - 10), statusIdx);
      const markerLines = inputWindow.filter((line) => line.includes(marker)).length;
      expect(markerLines).toBeGreaterThanOrEqual(2);

      const backspaces = '\u007f'.repeat(320);
      sendLiteral(target, backspaces);
      await sleepMs(260);
      const clearedFrame = capture(target);
      expect(clearedFrame).toContain('Type a message');
      expect(clearedFrame).not.toContain(marker);
      expect(clearedFrame).toContain('| sup |');
    } finally {
      killTmux(session);
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  }, 90_000);
});
