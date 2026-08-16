#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PUBLIC_NPM_REGISTRY = 'https://registry.npmjs.org';

export function validateReleaseLockUrls(lock, label) {
  for (const [packagePath, entry] of Object.entries(lock?.packages || {})) {
    if (!entry?.resolved) continue;
    let resolved;
    try {
      resolved = new URL(entry.resolved);
    } catch {
      throw new Error(`${label} has an invalid resolved URL for ${packagePath || '<root>'}`);
    }
    if (resolved.origin !== PUBLIC_NPM_REGISTRY || resolved.protocol !== 'https:') {
      throw new Error(`${label} must resolve every package from the public npm registry`);
    }
  }
}

export function validateOriginReleaseEvent({ repository, ref, sha, head, parents }) {
  if (repository !== 'shizuha-labs/shizuha') throw new Error('release repository is not canonical');
  if (ref !== 'refs/heads/master') throw new Error('release workflow must run only from canonical master');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('release SHA is not an exact commit');
  if (head !== sha) throw new Error('Origin checkout does not match the release event SHA');
  if (!Array.isArray(parents) || parents.length !== 2 || parents.some((parent) => !/^[0-9a-f]{40}$/.test(parent))) {
    throw new Error('release SHA is not one exact Origin merge commit');
  }
  return {
    repository,
    ref,
    source_sha: sha,
    release_gate: 'origin-master-merge-build-evidence',
  };
}

async function main() {
  const repository = process.env.RELEASE_REPOSITORY || '';
  const ref = process.env.RELEASE_REF || '';
  const sha = (process.env.RELEASE_SHA || '').toLowerCase();
  // Reject untrusted event data before invoking git. Besides failing closed,
  // this keeps refs as inert data even in a source-only validation context.
  if (repository !== 'shizuha-labs/shizuha') throw new Error('release repository is not canonical');
  if (ref !== 'refs/heads/master') throw new Error('release workflow must run only from canonical master');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('release SHA is not an exact commit');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim().toLowerCase();
  const parents = execFileSync('git', ['show', '-s', '--format=%P', sha], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
  validateReleaseLockUrls(JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url))), 'root package-lock.json');
  validateReleaseLockUrls(JSON.parse(readFileSync(new URL('../extensions/vscode/package-lock.json', import.meta.url))), 'extension package-lock.json');
  console.log(JSON.stringify(validateOriginReleaseEvent({ repository, ref, sha, head, parents })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
