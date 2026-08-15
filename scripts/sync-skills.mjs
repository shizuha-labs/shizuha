#!/usr/bin/env node
/**
 * sync-skills.mjs — Copy integration skills from src/ to dist/ without a full JS rebuild.
 *
 * Run this after editing any src/skills/integrations/SKILL.md file, then re-deploy with
 * deploy.sh to push the updated skills to the host.
 *
 * Usage:
 *   npm run sync-skills
 *
 * The full `npm run build` also calls this step (via esbuild.config.js), so this script
 * is only needed for skills-only changes where you want to skip the ~30s JS bundle step.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(root, 'src', 'skills', 'integrations');
const dst = path.join(root, 'dist', 'skills', 'integrations');

if (!fs.existsSync(src)) {
  console.error(`Source not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(dst, { recursive: true });

let copied = 0;
let upToDate = 0;

for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const srcFile = path.join(src, entry.name, 'SKILL.md');
  if (!fs.existsSync(srcFile)) continue;

  const dstDir = path.join(dst, entry.name);
  const dstFile = path.join(dstDir, 'SKILL.md');
  fs.mkdirSync(dstDir, { recursive: true });

  const srcContent = fs.readFileSync(srcFile);
  if (fs.existsSync(dstFile)) {
    const dstContent = fs.readFileSync(dstFile);
    if (srcContent.equals(dstContent)) {
      upToDate++;
      continue;
    }
  }

  fs.copyFileSync(srcFile, dstFile);
  console.log(`  updated: ${entry.name}/SKILL.md`);
  copied++;
}

console.log(`sync-skills: ${copied} updated, ${upToDate} already up-to-date (dist/skills/integrations/)`);
if (copied > 0) {
  console.log(`  → Run deploy.sh to push changes to the host.`);
}
