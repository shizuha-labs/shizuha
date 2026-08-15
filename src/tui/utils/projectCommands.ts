/**
 * Project-aware command snippets for `/init` AGENTS.md generation (SCLI-391).
 *
 * Detect common manifests and emit ecosystem-appropriate build/test/dev
 * commands. When nothing is detected, leave explicit unset placeholders —
 * never invent Node/npm commands for a non-Node tree.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type ProjectEcosystem =
  | 'node'
  | 'python'
  | 'rust'
  | 'go'
  | 'unknown';

export interface DetectedProjectCommands {
  ecosystem: ProjectEcosystem;
  /** Markdown fenced bash block body (without the fences). */
  commandsBlock: string;
}

function exists(cwd: string, name: string): boolean {
  try {
    return fs.existsSync(path.join(cwd, name));
  } catch {
    return false;
  }
}

function readPackageScripts(cwd: string): { build?: string; test?: string; dev?: string } {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    return {
      build: scripts.build ? 'npm run build' : undefined,
      test: scripts.test ? 'npm test' : undefined,
      dev: scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : undefined,
    };
  } catch {
    return {};
  }
}

function nodeCommands(cwd: string): string {
  const scripts = readPackageScripts(cwd);
  const build = scripts.build ?? 'npm run build  # add a "build" script if needed';
  const test = scripts.test ?? 'npm test  # add a "test" script if needed';
  const dev = scripts.dev ?? 'npm run dev  # add a "dev"/"start" script if needed';
  return `# Build
${build}

# Test
${test}

# Dev
${dev}`;
}

function pythonCommands(cwd: string): string {
  const hasUv = exists(cwd, 'uv.lock') || exists(cwd, 'pyproject.toml');
  const runner = hasUv ? 'uv run' : 'python -m';
  const testCmd = hasUv ? 'uv run pytest' : 'pytest';
  const devHint = hasUv
    ? 'uv run python main.py  # or the project entrypoint'
    : 'python main.py  # or the project entrypoint';
  return `# Build / install
${hasUv ? 'uv sync' : 'pip install -e .  # or: pip install -r requirements.txt'}

# Test
${testCmd}

# Dev
${devHint}

# Module run example
${runner} <module_or_script>`;
}

function rustCommands(): string {
  return `# Build
cargo build

# Test
cargo test

# Dev / run
cargo run`;
}

function goCommands(): string {
  return `# Build
go build ./...

# Test
go test ./...

# Dev / run
go run .`;
}

function unknownCommands(): string {
  return `# Commands not auto-detected for this tree.
# Replace these placeholders with the repo's real build/test/dev commands.
# Build
# <unset — add the project build command>

# Test
# <unset — add the project test command>

# Dev
# <unset — add the project dev/run command>`;
}

/**
 * Detect the primary project ecosystem from cwd manifests.
 * Preference order when multiple match: node > python > rust > go.
 * (Node first only when package.json is present — Python-only trees without
 * package.json never get npm commands.)
 */
export function detectProjectEcosystem(cwd: string): ProjectEcosystem {
  if (exists(cwd, 'package.json')) return 'node';
  if (
    exists(cwd, 'pyproject.toml') ||
    exists(cwd, 'setup.py') ||
    exists(cwd, 'setup.cfg') ||
    exists(cwd, 'requirements.txt') ||
    exists(cwd, 'Pipfile') ||
    exists(cwd, 'poetry.lock')
  ) {
    return 'python';
  }
  if (exists(cwd, 'Cargo.toml')) return 'rust';
  if (exists(cwd, 'go.mod')) return 'go';
  return 'unknown';
}

export function detectProjectCommands(cwd: string): DetectedProjectCommands {
  const ecosystem = detectProjectEcosystem(cwd);
  switch (ecosystem) {
    case 'node':
      return { ecosystem, commandsBlock: nodeCommands(cwd) };
    case 'python':
      return { ecosystem, commandsBlock: pythonCommands(cwd) };
    case 'rust':
      return { ecosystem, commandsBlock: rustCommands() };
    case 'go':
      return { ecosystem, commandsBlock: goCommands() };
    default:
      return { ecosystem: 'unknown', commandsBlock: unknownCommands() };
  }
}

/** Full AGENTS.md boilerplate for `/init`. */
export function buildAgentsMdBoilerplate(cwd: string): string {
  const { commandsBlock } = detectProjectCommands(cwd);
  return `# AGENTS.md

## Project Overview
<!-- Describe the project for AI agents -->

## Architecture
<!-- Key architectural decisions and patterns -->

## Development Guidelines
<!-- Coding standards, testing requirements -->

## Commands
\`\`\`bash
${commandsBlock}
\`\`\`
`;
}
