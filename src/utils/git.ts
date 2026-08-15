import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, timeout: 10000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function getGitStatus(cwd: string): Promise<string> {
  return git(['status', '--short'], cwd);
}

export async function getGitDiff(cwd: string): Promise<string> {
  return git(['diff', '--stat'], cwd);
}

export async function getGitLog(cwd: string, count = 5): Promise<string> {
  return git(['log', `--oneline`, `-${count}`], cwd);
}

export async function getGitBranch(cwd: string): Promise<string> {
  return git(['branch', '--show-current'], cwd);
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await git(['rev-parse', '--is-inside-work-tree'], cwd);
  return result === 'true';
}
