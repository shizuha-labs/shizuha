#!/usr/bin/env node
// SCLI-13: Update the perf baseline from the latest test run.
// Usage: npm run perf:update-baseline
// This re-runs the perf tests and saves new baseline.json values.
// Only run this intentionally — committing the result updates the regression threshold.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(__dirname, '../tests/perf/baseline.json');

console.log('Re-running perf tests to capture fresh baseline...');
// Run perf tests and capture stdout for the p50/p95 lines
let output;
try {
  output = execSync('npx vitest run tests/perf/ --reporter=verbose', {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  // vitest exits non-zero on test failure — but we want the output anyway
  output = (err.stdout ?? '') + (err.stderr ?? '');
}

// Parse lines like: "[text-only] p50=3.2ms  p95=8.5ms  (50 iters)"
const entries = {};
for (const line of output.split('\n')) {
  const m = line.match(/\[(\S+)\]\s+p50=([\d.]+)ms\s+p95=([\d.]+)ms/);
  if (m) {
    const [, name, p50, p95] = m;
    entries[name] = {
      p50Ms: parseFloat(p50),
      p95Ms: parseFloat(p95),
      iterations: 50,
      recordedAt: new Date().toISOString(),
    };
  }
}

if (Object.keys(entries).length === 0) {
  console.error('No perf results found in test output. Baseline NOT updated.');
  process.exit(1);
}

// Merge with existing baseline (keep entries the run didn't produce)
let existing = {};
try { existing = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')); } catch { /* first run */ }
const merged = { ...existing, ...entries };
writeFileSync(BASELINE_PATH, JSON.stringify(merged, null, 2) + '\n');

console.log(`Baseline updated: ${Object.keys(entries).join(', ')}`);
console.log(`Written to ${BASELINE_PATH}`);
console.log('Commit this file to lock in the new threshold.');
