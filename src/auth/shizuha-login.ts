// Shizuha ID sign-in → auto-provision a Cortex API key.
//
// Powers `shizuha login` and the TUI first-run sign-in so a new user never has
// to paste an API key or export an env var: they enter their Shizuha ID email +
// password once, we exchange it for a JWT, mint a personal Cortex key on their
// behalf, and store it in ~/.shizuha/credentials.json. The Cortex base URL is a
// built-in default (registry.DEFAULT_CORTEX_BASE_URL), so nothing else is needed.
import os from 'node:os';
import readline from 'node:readline';
import { setCortexApiKey } from '../config/credentials.js';
import { loginToShizuhaId, readShizuhaAuth } from '../config/shizuhaAuth.js';
import { DEFAULT_CORTEX_BASE_URL } from '../provider/registry.js';

function cortexRoot(): string {
  // api-keys lives at <root>/v1/api-keys; strip a trailing /v1 if the user set one.
  const raw = process.env['CORTEX_BASE_URL'] || DEFAULT_CORTEX_BASE_URL;
  return raw.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

export interface LoginResult {
  cortexKey: string;
  account: string;
}

/** Mint a fresh personal Cortex API key for the signed-in user; returns the raw key. */
export async function mintCortexKey(accessToken: string, name: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${cortexRoot()}/v1/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ name }),
    });
  } catch {
    throw new Error(`Could not reach Cortex (${cortexRoot()}). Check your connection.`);
  }
  const data: any = await res.json().catch(() => ({}));
  const key = data?.key;
  if (!res.ok || !key) {
    throw new Error(`Could not create a Cortex key (HTTP ${res.status}).`);
  }
  return key as string;
}

/** Full flow: sign in to Shizuha ID, mint a Cortex key from the JWT, persist it. */
export async function loginAndProvision(emailOrUsername: string, password: string): Promise<LoginResult> {
  const res = await loginToShizuhaId(emailOrUsername, password);
  const auth = readShizuhaAuth();
  if (!auth?.accessToken) throw new Error('Sign-in did not return an access token.');
  let host = 'cli';
  try { host = os.hostname() || 'cli'; } catch { /* ignore */ }
  const day = new Date().toISOString().slice(0, 10);
  const key = await mintCortexKey(auth.accessToken, `shizuha-cli ${host} ${day}`);
  setCortexApiKey(key);
  return { cortexKey: key, account: res.username || emailOrUsername };
}

/** Prompt for a single line on the TTY. */
function ask(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (a) => { rl.close(); resolve(a.trim()); }));
}

/** Prompt for a password without echoing it to the terminal. */
function askHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf8');
      for (const ch of s) {
        if (ch === '\n' || ch === '\r' || ch === '\x04') { // Enter / Ctrl-D
          if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false);
          stdin.removeListener('data', onData);
          stdin.pause();
          stdout.write('\n');
          resolve(buf);
          return;
        } else if (ch === '\x03') { // Ctrl-C
          stdout.write('\n');
          process.exit(130);
        } else if (ch === '\x7f' || ch === '\b') { // backspace / delete
          if (buf.length > 0) { buf = buf.slice(0, -1); stdout.write('\b \b'); }
        } else if (ch >= ' ') { // printable
          buf += ch;
          stdout.write('*');
        }
      }
    };
    stdin.on('data', onData);
  });
}

/**
 * Interactive sign-in used by `shizuha login` and the TUI first-run gate.
 * Returns true on success (a Cortex key is now stored), false if the user
 * cancelled / chose to skip.
 */
export async function interactiveLogin(opts: { allowPasteFallback?: boolean } = {}): Promise<boolean> {
  console.log('\n  Sign in to Shizuha to use the hosted models (Qwen, Gemma).');
  console.log('  Use your Shizuha ID — the same email & password as shizuha.com.\n');
  const email = await ask('  Email: ');
  if (!email) { console.log('  Cancelled.'); return false; }
  const password = await askHidden('  Password: ');
  if (!password) { console.log('  Cancelled.'); return false; }
  try {
    process.stdout.write('  Signing in... ');
    const r = await loginAndProvision(email, password);
    console.log('done.');
    console.log(`\n  Signed in as ${r.account}. Your Cortex key is saved — you're ready to go.`);
    console.log('  Try:  shizuha exec -p "hello" --model cortex/Qwen3.6-27B-NVFP4');
    return true;
  } catch (e: any) {
    console.log('');
    console.error(`  ${e?.message || e}`);
    if (opts.allowPasteFallback) {
      console.log('  You can also paste an existing key with:  shizuha auth cortex');
    }
    return false;
  }
}
