/**
 * Process-level compaction e2e: real `dist/shizuha.js` in tmux, real SQLite,
 * mocked vLLM HTTP. These are the journeys helper-level compactMessages tests
 * cannot see (shizuha1 2026-09-18/19): resume init, continuation stall, and
 * pre-turn deadline abort of a later hierarchical pass.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  captureVisible,
  killTmux,
  launchShizuhaCli,
  projectDir,
  sendKeys,
  sendLiteral,
  sleepMs,
  tmuxE2eDescribe,
  waitForPattern,
} from './helpers/tmux-e2e.js';
import {
  isCompactionRequest,
  startMockVllmServer,
  type MockVllmServer,
} from './helpers/mock-vllm-server.js';
import { StateStore } from '../../src/state/store.js';

const MODEL = 'GLM-5.3-Flash';
const WINDOW = 262_144;
const SEED_MESSAGES = 80;
const SEED_WORDS = 3_200;
const SUMMARY = `<summary>
1. Primary request: keep the session usable after compaction.
2. Key Technical Concepts: hierarchical prefix summaries.
3. Files and Code Sections: cli/src/state/compaction.ts.
4. Errors and Fixes: stalled continuation and deadline abort.
5. Problem Solving: keep the last reduced projection.
6. All User Messages: ping the compacted session.
7. Pending Tasks: continue the user request.
8. Current Work: compaction e2e.
9. Optional Next Step: answer the user.
${'word '.repeat(250)}
</summary>`;

const tempHomes: string[] = [];
const servers: MockVllmServer[] = [];

function dbPath(home: string): string {
  return path.join(home, '.config', 'shizuha', 'state.db');
}

function seedOversizedSession(home: string): string {
  fs.mkdirSync(path.dirname(dbPath(home)), { recursive: true });
  const store = new StateStore(dbPath(home));
  const session = store.createSession(`vllm/${MODEL}`, projectDir);
  for (let index = 0; index < SEED_MESSAGES; index++) {
    store.appendMessage(session.id, {
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `sentinel-${index}: ${'word '.repeat(SEED_WORDS)}`,
      timestamp: Date.now() + index,
    });
  }
  store.close();
  return session.id;
}

function launchResume(home: string, sessionId: string, vllmUrl: string, deadlineMs: string) {
  return launchShizuhaCli({
    tempHome: home,
    name: 'scli-compact',
    width: 100,
    height: 32,
    args: ['--model', `vllm/${MODEL}`, 'resume', sessionId],
    env: {
      VLLM_BASE_URL: vllmUrl,
      VLLM_API_KEY: 'e2e-mock',
      SHIZUHA_COMPACTION_DEADLINE_MS: deadlineMs,
    },
  });
}

tmuxE2eDescribe('TUI compaction process e2e', () => {
  beforeAll(() => {
    // Must live under this package so Node ESM can walk to cli/node_modules
    // for externals (pino, better-sqlite3). A ramdisk scratch path cannot.
    const scratch = path.join(projectDir, 'node_modules', '.cache', 'scli-e2e-cli');
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.mkdirSync(scratch, { recursive: true });
    const outfile = path.join(scratch, 'shizuha.js');
    execFileSync('node', ['esbuild.config.js'], {
      cwd: projectDir,
      env: { ...process.env, SHIZUHA_ESBUILD_OUTFILE: outfile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    process.env['SHIZUHA_E2E_CLI'] = outfile;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close().catch(() => undefined)));
    for (const home of tempHomes) {
      try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it('resumes an oversized session when compaction continuation stalls', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-compact-stall-'));
    tempHomes.push(home);
    const sessionId = seedOversizedSession(home);
    let compactionCalls = 0;
    const server = await startMockVllmServer({
      modelId: MODEL,
      maxModelLen: WINDOW,
      script: (req) => {
        if (!isCompactionRequest(req)) {
          return { kind: 'text', text: 'Ready after resume.' };
        }
        compactionCalls++;
        if (compactionCalls === 1) {
          return { kind: 'text', text: SUMMARY, finishReason: 'length' };
        }
        if (compactionCalls === 2) {
          return { kind: 'text', text: '', finishReason: 'stop' };
        }
        return { kind: 'text', text: SUMMARY, finishReason: 'stop' };
      },
    });
    servers.push(server);
    const { session, target } = launchResume(home, sessionId, server.url, '900000');
    try {
      const frame = await waitForPattern(target, /Type a message|Failed to initialize/, 45_000);
      expect(frame).not.toContain('Failed to initialize');
      expect(frame).toMatch(/Type a message|❯/);
    } finally {
      killTmux(session);
    }
  }, 60_000);

  it('keeps reduced working context when a later hierarchical pass hits the deadline', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-compact-deadline-'));
    tempHomes.push(home);
    const sessionId = seedOversizedSession(home);
    const originalCount = SEED_MESSAGES;
    let compactionCalls = 0;
    const server = await startMockVllmServer({
      modelId: MODEL,
      maxModelLen: WINDOW,
      script: (req) => {
        if (!isCompactionRequest(req)) {
          return { kind: 'text', text: 'Turn after partial compact.' };
        }
        compactionCalls++;
        if (compactionCalls === 2) return { kind: 'hang' };
        return { kind: 'text', text: SUMMARY, finishReason: 'stop' };
      },
    });
    servers.push(server);
    const { session, target } = launchResume(home, sessionId, server.url, '2000');
    try {
      const started = Date.now();
      let workingCount = originalCount;
      let hasSummary = false;
      while (Date.now() - started < 40_000) {
        const store = new StateStore(dbPath(home));
        const loaded = store.loadSession(sessionId);
        workingCount = loaded?.messages.length ?? originalCount;
        hasSummary = Boolean(loaded?.messages.some(
          (message) => typeof message.content === 'string'
            && message.content.includes('[Conversation Summary]'),
        ));
        const transcript = store.loadTranscriptMessages(sessionId);
        store.close();
        if (hasSummary && workingCount < originalCount && transcript.length >= originalCount) {
          break;
        }
        await sleepMs(400);
      }
      expect(hasSummary, 'deadline abort discarded hierarchical progress').toBe(true);
      expect(workingCount).toBeLessThan(originalCount);
      const frame = captureVisible(target);
      expect(frame).not.toContain('Failed to initialize');
    } finally {
      killTmux(session);
    }
  }, 60_000);

  it('writes a semantic summary and keeps the append-only transcript after resume compact', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-compact-success-'));
    tempHomes.push(home);
    const sessionId = seedOversizedSession(home);
    const server = await startMockVllmServer({
      modelId: MODEL,
      maxModelLen: WINDOW,
      script: (req) => {
        if (isCompactionRequest(req)) {
          return { kind: 'text', text: SUMMARY, finishReason: 'stop' };
        }
        return { kind: 'text', text: 'Ready after compact.' };
      },
    });
    servers.push(server);
    const { session, target } = launchResume(home, sessionId, server.url, '900000');
    try {
      const frame = await waitForPattern(target, /Type a message|Failed to initialize/, 45_000);
      expect(frame).not.toContain('Failed to initialize');
      const started = Date.now();
      let hasSummary = false;
      let workingCount = SEED_MESSAGES;
      let transcriptCount = 0;
      while (Date.now() - started < 20_000) {
        const store = new StateStore(dbPath(home));
        const loaded = store.loadSession(sessionId);
        workingCount = loaded?.messages.length ?? SEED_MESSAGES;
        hasSummary = Boolean(loaded?.messages.some(
          (message) => typeof message.content === 'string'
            && message.content.includes('[Conversation Summary]'),
        ));
        transcriptCount = store.loadTranscriptMessages(sessionId).length;
        store.close();
        if (hasSummary && workingCount < SEED_MESSAGES && transcriptCount >= SEED_MESSAGES) break;
        await sleepMs(300);
      }
      expect(hasSummary).toBe(true);
      expect(workingCount).toBeLessThan(SEED_MESSAGES);
      expect(transcriptCount).toBeGreaterThanOrEqual(SEED_MESSAGES);
    } finally {
      killTmux(session);
    }
  }, 60_000);

  it('resumes a session whose screenshots would overflow JSON.stringify-as-text', async () => {
    // shizuha2 e81682dd: 3 screenshots (~256k base64) made the vLLM preflight
    // count prompt≈523191 against a 500k window while estimateTokens stayed
    // under. The composer then showed "preserved the full active projection".
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scli-compact-vision-'));
    tempHomes.push(home);
    fs.mkdirSync(path.dirname(dbPath(home)), { recursive: true });
    const store = new StateStore(dbPath(home));
    const sessionRow = store.createSession(`vllm/${MODEL}`, projectDir);
    store.appendMessage(sessionRow.id, {
      role: 'user',
      content: 'Inspect the captured screenshots.',
      timestamp: Date.now(),
    });
    store.appendMessage(sessionRow.id, {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'shot-1', name: 'browser_screenshot', input: {} }],
      timestamp: Date.now() + 1,
    });
    const screenshot = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.repeat(4_000);
    store.appendMessage(sessionRow.id, {
      role: 'user',
      content: [{
        type: 'tool_result',
        toolUseId: 'shot-1',
        content: 'Screenshot captured.',
        image: { base64: screenshot, mediaType: 'image/png' },
      }],
      timestamp: Date.now() + 2,
    });
    store.close();
    const window = 65_536;
    let agenticCalls = 0;
    const server = await startMockVllmServer({
      modelId: MODEL,
      maxModelLen: window,
      script: (req) => {
        if (isCompactionRequest(req)) {
          return { kind: 'text', text: SUMMARY, finishReason: 'stop' };
        }
        agenticCalls++;
        return { kind: 'text', text: 'Screenshots received without overflowing the window.' };
      },
    });
    servers.push(server);
    const { session, target } = launchResume(home, sessionRow.id, server.url, '900000');
    try {
      const frame = await waitForPattern(target, /Type a message|Failed to initialize|preserved the full active projection/, 45_000);
      expect(frame).not.toContain('Failed to initialize');
      expect(frame).not.toContain('preserved the full active projection');
      sendLiteral(target, 'continue from the screenshots');
      sendKeys(target, 'Enter');
      await waitForPattern(target, /Screenshots received|preserved the full active projection|context window exhausted/, 45_000);
      const after = captureVisible(target);
      expect(after).not.toContain('preserved the full active projection');
      expect(after).not.toContain('context window exhausted');
      expect(agenticCalls).toBeGreaterThan(0);
      const verify = new StateStore(dbPath(home));
      const transcript = verify.loadTranscriptMessages(sessionRow.id);
      verify.close();
      expect(JSON.stringify(transcript)).toContain(screenshot);
    } finally {
      killTmux(session);
    }
  }, 90_000);
});
