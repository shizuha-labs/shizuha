// Full test-suite gate (SCLI-11). Runs typecheck → node build → the COMPLETE
// vitest suite (no exclusions beyond the explicit quarantine list), then
// surfaces pass/fail counts and the slowest test files.
//
// Quarantine: tests/quarantine.list — one test-file path per line, with a
// mandatory trailing `# reason (owner, date)` comment. Quarantined files are
// excluded from the gate and printed LOUDLY at the end of every run — flaky
// or slow tests are parked explicitly and visibly, never silently dropped.
//
// Escape hatch: the `skip-full-ci` PR label (see .github/workflows/ci.yml)
// skips the suite for genuine hotfixes only — typecheck still runs.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const home = await mkdtemp(path.join('/tmp', 'shizuha-full-ci-home-'));
const reportFile = path.join(home, 'vitest-report.json');
const env = {
  ...process.env,
  HOME: home,
  SHIZUHA_DISABLE_MCP_JSON: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
};

// ── Quarantine list (explicit, loud — never silent) ─────────────────────────
const quarantinePath = path.join(projectRoot, 'tests', 'quarantine.list');
const quarantined = [];
if (existsSync(quarantinePath)) {
  for (const raw of readFileSync(quarantinePath, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [file, ...reason] = line.split('#');
    const filePath = file.trim();
    if (!filePath) continue;
    if (!reason.join('#').trim()) {
      console.error(`✖ quarantine.list entry "${filePath}" has no '# reason' — a reason (owner, date) is mandatory.`);
      process.exit(1);
    }
    quarantined.push({ file: filePath, reason: reason.join('#').trim() });
  }
}

// Vitest otherwise consumes every available CPU. On the shared coordinator and
// Origin runners that starves SQLite/process-heavy tests long enough to trip
// their 30s correctness timeout. Four workers keep the suite parallel while
// avoiding the oversubscription cliff; operators can tune explicitly when a
// runner has a different resource envelope.
const maxWorkers = process.env.SHIZUHA_CI_MAX_WORKERS?.trim() || '4';
const vitestArgs = [
  'vitest', 'run', `--maxWorkers=${maxWorkers}`,
  '--reporter=default', `--reporter=json`, `--outputFile=${reportFile}`,
];
for (const q of quarantined) vitestArgs.push('--exclude', q.file);

const commands = [
  [npmCmd, ['run', 'build:check']],
  [npmCmd, ['run', 'build:node']],
  // The FULL unit/integration suite (the e2e CLI tests need the node bundle
  // built above). CI previously ran only a ~18-file subset, which let dozens
  // of real failures land on master unnoticed.
  [npxCmd, vitestArgs],
];

let failed = false;
for (const [command, args] of commands) {
  process.stdout.write(`▶ running: ${[command, ...args].join(' ')}\n`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: projectRoot,
        env,
        stdio: 'inherit',
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${command} ${args.join(' ')} failed with ${signal || code}`));
        }
      });
    });
  } catch (err) {
    failed = true;
    console.error(`\n✖ ${err.message}`);
    break;
  }
}

// ── Surface pass/fail + the slowest test files (from the vitest JSON report) ─
try {
  const report = JSON.parse(await readFile(reportFile, 'utf-8'));
  const results = report.testResults ?? [];
  const passed = report.numPassedTests ?? 0;
  const failedCount = report.numFailedTests ?? 0;
  const skipped = report.numPendingTests ?? 0;
  console.log(`\n── Full-suite summary ──────────────────────────────`);
  console.log(`   tests: ${passed} passed, ${failedCount} failed, ${skipped} skipped (${results.length} files)`);
  const slowest = results
    .map((r) => ({
      file: path.relative(projectRoot, r.name ?? ''),
      ms: (r.endTime ?? 0) - (r.startTime ?? 0),
    }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  console.log(`   slowest test files:`);
  for (const s of slowest) console.log(`     ${String(Math.round(s.ms)).padStart(6)}ms  ${s.file}`);
} catch {
  // Report missing (e.g. vitest never ran) — the exit code already tells the story.
}

if (quarantined.length) {
  console.log(`\n⚠ QUARANTINED (excluded from the gate — fix or un-quarantine, never let this list rot):`);
  for (const q of quarantined) console.log(`   - ${q.file}  # ${q.reason}`);
}

process.exit(failed ? 1 : 0);
