import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..', '..');
const cliPath = path.join(projectRoot, 'dist', 'shizuha.js');
const mockMcpPath = path.join(projectRoot, 'scripts', 'ci', 'mock-mcp-server.mjs');
const artifactsDir = process.env.SHIZUHA_LONG_E2E_ARTIFACT_DIR
  ? path.resolve(process.env.SHIZUHA_LONG_E2E_ARTIFACT_DIR)
  : path.join(projectRoot, 'ci-artifacts', 'e2e');
const model = process.env.SHIZUHA_LONG_E2E_MODEL || 'cortex/GLM-4.7';
const timeoutMs = Number(process.env.SHIZUHA_LONG_E2E_TIMEOUT_MS || 300000);

const baseEnv = {
  ...process.env,
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  SHIZUHA_DISABLE_MCP_JSON: '1',
  VLLM_REQUEST_STATUS_INTERVAL_MS: process.env.VLLM_REQUEST_STATUS_INTERVAL_MS || '5000',
};
for (const key of ['CORTEX_BASE_URL', 'CORTEX_API_KEY', 'CORTEX_OAUTH_TOKEN']) {
  if (!baseEnv[key]) delete baseEnv[key];
}

const steps = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function safeName(name) {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

async function tempDir(prefix) {
  return mkdtemp(path.join('/tmp', `${prefix}-`));
}

function parseEvents(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Some model/tool diagnostics can leak to stdout in development builds.
    }
  }
  return events;
}

function contentText(events) {
  return events
    .filter((event) => event.type === 'content')
    .map((event) => event.text || '')
    .join('');
}

function toolNames(events, eventType = 'tool_start') {
  return events
    .filter((event) => event.type === eventType)
    .map((event) => event.toolName)
    .filter(Boolean);
}

function providerMessages(events) {
  return events
    .filter((event) => event.type === 'provider_status')
    .map((event) => event.message || '');
}

async function runProcess(name, command, args, options = {}) {
  const artifactBase = path.join(artifactsDir, safeName(name));
  const env = options.env || baseEnv;
  const started = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const result = await execFile(command, args, {
      cwd: options.cwd || projectRoot,
      env,
      timeout: options.timeoutMs || timeoutMs,
      maxBuffer: 30 * 1024 * 1024,
    });
    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (error) {
    stdout = error.stdout || '';
    stderr = error.stderr || String(error);
    exitCode = typeof error.code === 'number' ? error.code : 1;
  }

  await writeFile(`${artifactBase}.stdout.log`, stdout);
  await writeFile(`${artifactBase}.stderr.log`, stderr);

  return {
    name,
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - started,
    artifactBase,
  };
}

async function runShizuha(name, args, options = {}) {
  const result = await runProcess(name, process.execPath, [cliPath, ...args], options);
  const events = parseEvents(result.stdout);
  await writeFile(`${result.artifactBase}.events.json`, JSON.stringify(events, null, 2));
  if (result.exitCode !== 0) {
    throw new Error(`${name} exited ${result.exitCode}; see ${result.artifactBase}.stderr.log`);
  }
  assert(events.some((event) => event.type === 'complete'), `${name} did not emit a complete event`);
  return { ...result, events };
}

async function runStep(name, fn) {
  const started = Date.now();
  process.stdout.write(`TODO ${name} ... `);
  try {
    await fn();
    const duration = ((Date.now() - started) / 1000).toFixed(1);
    steps.push({ name, ok: true, duration });
    process.stdout.write(`ok (${duration}s)\n`);
  } catch (error) {
    const duration = ((Date.now() - started) / 1000).toFixed(1);
    steps.push({ name, ok: false, duration, error: error?.message || String(error) });
    process.stdout.write(`failed (${duration}s)\n`);
    throw error;
  }
}

async function runPython(cwd, args) {
  return runProcess(`python-${path.basename(cwd)}-${args.join('-')}`, 'python3', args, {
    cwd,
    env: baseEnv,
    timeoutMs: 30000,
  });
}

await rm(artifactsDir, { recursive: true, force: true });
await mkdir(artifactsDir, { recursive: true });

try {
  await runStep('bundle-help', async () => {
    const result = await runProcess('bundle-help', process.execPath, [cliPath, '--help'], {
      env: baseEnv,
      timeoutMs: 30000,
    });
    assert(result.exitCode === 0, 'CLI help exited non-zero');
    assert(result.stdout.includes('shizuha'), 'CLI help did not mention shizuha');
    assert(result.stdout.includes('exec'), 'CLI help did not mention exec');
  });

  await runStep('cortex-text-response', async () => {
    const cwd = await tempDir('shizuha-cortex-text');
    const home = await tempDir('shizuha-home');
    const result = await runShizuha(
      'cortex-text-response',
      [
        'exec',
        '--cwd', cwd,
        '--model', model,
        '--mode', 'autonomous',
        '--max-turns', '1',
        '--toolset', 'safe',
        '--json',
        '--prompt', 'Reply exactly with this text and no extra words: CORTEX_TEXT_OK',
      ],
      { cwd, env: { ...baseEnv, HOME: home } },
    );
    assert(contentText(result.events).includes('CORTEX_TEXT_OK'), 'Cortex text response did not contain marker');
  });

  await runStep('cortex-streaming-write-tool', async () => {
    const cwd = await tempDir('shizuha-cortex-write');
    const home = await tempDir('shizuha-home');
    const result = await runShizuha(
      'cortex-streaming-write-tool',
      [
        'exec',
        '--cwd', cwd,
        '--model', model,
        '--mode', 'autonomous',
        '--max-turns', '5',
        '--toolset', 'local',
        '--json',
        '--prompt', 'Use the write tool to create hello.txt containing exactly STREAM_OK. Then answer done.',
      ],
      { cwd, env: { ...baseEnv, HOME: home } },
    );
    const status = providerMessages(result.events).join('\n');
    assert(status.includes('streaming') || !status.includes('non-streaming'), 'Provider reported non-streaming tool path');
    assert(toolNames(result.events).includes('write'), 'write tool was not called');
    assert(
      result.events.some((event) => event.type === 'tool_complete' && event.toolName === 'write' && event.isError === false),
      'write tool did not complete successfully',
    );
    const fileContent = (await readFile(path.join(cwd, 'hello.txt'), 'utf8')).trim();
    assert(fileContent === 'STREAM_OK', `hello.txt contained ${JSON.stringify(fileContent)}`);
  });

  await runStep('resume-state-readback', async () => {
    const cwd = await tempDir('shizuha-resume');
    const home = await tempDir('shizuha-home');
    const first = await runShizuha(
      'resume-state-first-turn',
      [
        'exec',
        '--cwd', cwd,
        '--model', model,
        '--mode', 'autonomous',
        '--max-turns', '5',
        '--toolset', 'local',
        '--json',
        '--prompt', 'Use the write tool to create note.txt containing exactly RESUME_E2E_TOKEN. Then answer saved.',
      ],
      { cwd, env: { ...baseEnv, HOME: home } },
    );
    const sessionStart = first.events.find((event) => event.type === 'session_start');
    assert(sessionStart?.sessionId, 'First turn did not emit a session id');
    assert((await readFile(path.join(cwd, 'note.txt'), 'utf8')).trim() === 'RESUME_E2E_TOKEN', 'note.txt was not written');

    const second = await runShizuha(
      'resume-state-second-turn',
      [
        'exec',
        '--cwd', cwd,
        '--resume', sessionStart.sessionId,
        '--model', model,
        '--mode', 'autonomous',
        '--max-turns', '5',
        '--toolset', 'local',
        '--json',
        '--prompt', 'Read note.txt and answer exactly with its contents.',
      ],
      { cwd, env: { ...baseEnv, HOME: home } },
    );
    assert(contentText(second.events).includes('RESUME_E2E_TOKEN'), 'Resumed session did not read back the persisted file content');
  });

  await runStep('mcp-toolsearch-stdio', async () => {
    const cwd = await tempDir('shizuha-mcp');
    const home = await tempDir('shizuha-home');
    await mkdir(path.join(cwd, '.shizuha'), { recursive: true });
    await writeFile(
      path.join(cwd, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          ci_mock: {
            command: process.execPath,
            args: [mockMcpPath],
          },
        },
      }, null, 2),
    );
    await writeFile(
      path.join(cwd, '.shizuha', 'config.local.toml'),
      '[mcp.toolSearch]\nmode = "on"\nawareness = "tools"\nmaxResults = 5\n',
    );
    const mcpEnv = { ...baseEnv, HOME: home };
    delete mcpEnv.SHIZUHA_DISABLE_MCP_JSON;
    const result = await runShizuha(
      'mcp-toolsearch-stdio',
      [
        'exec',
        '--cwd', cwd,
        '--model', model,
        '--mode', 'autonomous',
        '--max-turns', '6',
        '--json',
        '--prompt', 'First call ToolSearch with query "select:mcp__ci_mock__ci_echo". Then call mcp__ci_mock__ci_echo with text="MCP_E2E_OK". Then answer exactly MCP_DONE.',
      ],
      { cwd, env: mcpEnv },
    );
    const names = toolNames(result.events);
    assert(names.includes('ToolSearch'), 'ToolSearch was not called');
    assert(names.includes('mcp__ci_mock__ci_echo'), 'ci_mock MCP echo tool was not called');
    assert(
      result.events.some((event) => event.type === 'tool_complete' && event.toolName === 'mcp__ci_mock__ci_echo' && String(event.result).includes('ci_echo:MCP_E2E_OK')),
      'MCP echo result was not returned to the agent loop',
    );
  });

  await runStep('easy-benchmark-fibonacci', async () => {
    const cwd = await tempDir('shizuha-bench-fib');
    const home = await tempDir('shizuha-home');
    await runShizuha(
      'easy-benchmark-fibonacci',
      [
        'exec',
        '--cwd', cwd,
        '--model', model,
        '--mode', 'autonomous',
        '--max-turns', '6',
        '--toolset', 'local',
        '--json',
        '--prompt',
        [
          'Create a file called fibonacci.py that contains:',
          '1. A function fibonacci(n) that returns the nth Fibonacci number.',
          '2. fibonacci(0)=0, fibonacci(1)=1, fibonacci(10)=55.',
          '3. When run directly, print the first 20 Fibonacci numbers, one per line.',
          'The program should run with: python3 fibonacci.py',
        ].join('\n'),
      ],
      { cwd, env: { ...baseEnv, HOME: home } },
    );
    const pyFile = path.join(cwd, 'fibonacci.py');
    assert((await readFile(pyFile, 'utf8')).includes('def fibonacci'), 'fibonacci.py did not define fibonacci');

    let result = await runPython(cwd, ['-c', 'import py_compile; py_compile.compile("fibonacci.py", doraise=True)']);
    assert(result.exitCode === 0, `fibonacci.py failed syntax check: ${result.stderr}`);
    result = await runPython(cwd, ['-c', 'from fibonacci import fibonacci; print(fibonacci(10))']);
    assert(result.exitCode === 0 && result.stdout.trim() === '55', `fibonacci(10) returned ${JSON.stringify(result.stdout.trim())}`);
    result = await runPython(cwd, ['fibonacci.py']);
    assert(result.exitCode === 0, `python3 fibonacci.py failed: ${result.stderr}`);
    assert(result.stdout.trim().split(/\r?\n/).length === 20, 'fibonacci.py did not print 20 lines');
  });

  const total = steps.reduce((sum, step) => sum + Number(step.duration), 0).toFixed(1);
  await writeFile(path.join(artifactsDir, 'summary.json'), JSON.stringify({ model, steps, totalSeconds: total }, null, 2));
  process.stdout.write(`\nLong E2E passed against ${model}. Artifacts: ${artifactsDir}\n`);
} catch (error) {
  await writeFile(path.join(artifactsDir, 'summary.json'), JSON.stringify({ model, steps, error: error?.message || String(error) }, null, 2));
  process.stderr.write(`\nLong E2E failed: ${error?.stack || error}\nArtifacts: ${artifactsDir}\n`);
  process.exit(1);
}
