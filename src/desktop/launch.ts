import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const CANDIDATES = [
  'http://127.0.0.1:8016',
  'http://127.0.0.1:8015',
];

async function probe(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

function waitForPort(port: number, timeoutMs = 20_000): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const tryOnce = () => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - started > timeoutMs) resolve(false);
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

function openBrowser(url: string): void {
  const plat = process.platform;
  if (plat === 'darwin') spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  else if (plat === 'win32') spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  else spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function startLocalCore(): void {
  const child = spawn(process.execPath, [process.argv[1] || 'shizuha', 'up', '--foreground', '--no-service'], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      SHIZUHA_ALLOW_LOCAL_DAEMON: '1',
    },
  });
  child.unref();
}

export async function openShizuhaDesktop(opts: { openBrowser?: boolean } = {}): Promise<number> {
  let url = '';
  for (const candidate of CANDIDATES) {
    if (await probe(candidate)) {
      url = candidate;
      break;
    }
  }
  if (!url) {
    process.stdout.write('Starting local Shizuha core (`shizuha up`)…\n');
    startLocalCore();
    const up = await waitForPort(8015) || await waitForPort(8016);
    if (!up) {
      process.stderr.write(
        'Could not start the local core. Run `shizuha up --foreground` in another terminal and retry.\n',
      );
      return 1;
    }
    for (const candidate of CANDIDATES) {
      if (await probe(candidate)) {
        url = candidate;
        break;
      }
    }
  }
  if (!url) {
    process.stderr.write('Core port is open but /health failed. Check the daemon logs.\n');
    return 1;
  }
  process.stdout.write(`Shizuha Desktop → ${url}\n`);
  process.stdout.write('Click Live for Hina-style voice-to-voice (needs XAI_API_KEY or `shizuha login`).\n');
  if (opts.openBrowser !== false) openBrowser(url);
  return 0;
}
