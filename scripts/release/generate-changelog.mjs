#!/usr/bin/env node
// SCLI-12: Generate a conventional-commit changelog between two tags.
//
// Usage:
//   node scripts/release/generate-changelog.mjs <from-tag> [<to-ref>]
//
// Outputs markdown suitable for a GitHub Release body to stdout.
// Groups commits by type: Features, Bug Fixes, Performance, Documentation, Other.
// Skips merge commits and chore/ci commits.

import { execSync } from 'node:child_process';

const [, , fromTag, toRef = 'HEAD'] = process.argv;
if (!fromTag) {
  process.stderr.write('Usage: generate-changelog.mjs <from-tag> [<to-ref>]\n');
  process.exit(1);
}

const range = `${fromTag}..${toRef}`;
let rawLog;
try {
  rawLog = execSync(
    `git log "${range}" --pretty=format:"%H\t%s" --no-merges`,
    { encoding: 'utf-8' },
  );
} catch {
  process.stderr.write(`git log failed for range ${range}\n`);
  process.exit(1);
}

const SKIP_TYPES = new Set(['chore', 'ci', 'build', 'style', 'test', 'wip']);
const SECTIONS = [
  { key: 'feat', title: '✨ Features' },
  { key: 'fix', title: '🐛 Bug Fixes' },
  { key: 'perf', title: '⚡ Performance' },
  { key: 'docs', title: '📚 Documentation' },
  { key: 'refactor', title: '♻️ Refactoring' },
  { key: 'other', title: '🔧 Other Changes' },
];

const groups = Object.fromEntries(SECTIONS.map((s) => [s.key, []]));

for (const line of rawLog.split('\n').filter(Boolean)) {
  const tabIdx = line.indexOf('\t');
  const hash = line.slice(0, tabIdx);
  const subject = line.slice(tabIdx + 1);

  // Parse conventional commit: type(scope): description
  const match = subject.match(/^(\w+)(?:\([^)]+\))?!?:\s*(.+)$/);
  if (!match) {
    groups['other'].push({ hash: hash.slice(0, 7), description: subject });
    continue;
  }

  const [, type, description] = match;
  if (SKIP_TYPES.has(type)) continue;

  const short = hash.slice(0, 7);
  const entry = { hash: short, description };

  if (groups[type]) {
    groups[type].push(entry);
  } else {
    groups['other'].push({ hash: short, description: subject });
  }
}

const lines = [];
for (const { key, title } of SECTIONS) {
  const entries = groups[key];
  if (!entries || entries.length === 0) continue;
  lines.push(`### ${title}\n`);
  for (const { hash, description } of entries) {
    lines.push(`- ${description} (\`${hash}\`)`);
  }
  lines.push('');
}

if (lines.length === 0) {
  process.stdout.write('No notable changes in this release.\n');
} else {
  process.stdout.write(lines.join('\n'));
}
