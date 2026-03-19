import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

// ── Plan file utilities ──

const ADJECTIVES = [
  'giggly', 'hugging', 'dancing', 'singing', 'dreamy',
  'bouncy', 'cozy', 'gentle', 'sparkly', 'whimsy',
  'fluffy', 'cheerful', 'mellow', 'vivid', 'witty',
  'daring', 'nimble', 'sleepy', 'lively', 'golden',
  'misty', 'breezy', 'frosty', 'sunny', 'rainy',
  'lunar', 'cosmic', 'rustic', 'swift', 'quiet',
];

const NOUNS = [
  'leaf', 'pebble', 'brook', 'cloud', 'ember',
  'meadow', 'willow', 'fern', 'coral', 'dawn',
  'spark', 'frost', 'bloom', 'ridge', 'delta',
  'grove', 'shore', 'dune', 'reef', 'vale',
  'crest', 'glade', 'knoll', 'ledge', 'spire',
  'cairn', 'fjord', 'mesa', 'oasis', 'plume',
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Generate a human-friendly slug like "giggly-hugging-leaf" */
export function generatePlanSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

/** Ensure ~/.claude/plans directory exists, return the dir path */
export function ensurePlanDir(): string {
  const dir = path.join(os.homedir(), '.claude', 'plans');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolve the full plan file path for a given slug */
export function resolvePlanFilePath(slug: string): string {
  const dir = ensurePlanDir();
  return path.join(dir, `${slug}.md`);
}

/** Read plan content from disk, return null if file doesn't exist */
export function readPlanContent(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

// ── Tool handlers ──

export const enterPlanModeTool: ToolHandler = {
  name: 'enter_plan_mode',
  description:
    'Enter plan mode to design an implementation approach before coding. ' +
    'In plan mode, you can explore the codebase and write a plan file, but cannot make other changes. ' +
    'Use this proactively when starting non-trivial implementation tasks.',
  parameters: z.object({}),
  readOnly: true,
  riskLevel: 'low',

  async execute(_params: unknown, _context: ToolContext): Promise<ToolResult> {
    return {
      toolUseId: '',
      content:
        'Plan mode is now active. You are in exploration and planning mode.\n\n' +
        'Workflow:\n' +
        '1. **Explore**: Use Read, Glob, Grep to understand the codebase\n' +
        '2. **Design**: Consider approaches, identify files to modify\n' +
        '3. **Write Plan**: Write your plan to the plan file using write_file\n' +
        '4. **Exit**: Call exit_plan_mode when ready for user approval\n\n' +
        'You can only edit the plan file — all other writes are blocked.',
    };
  },
};

export const exitPlanModeTool: ToolHandler = {
  name: 'exit_plan_mode',
  description:
    'Exit plan mode and request user approval of the plan. ' +
    'The plan content will be read from the plan file on disk. ' +
    'If the user approves, mode switches to supervised and you can start implementing. ' +
    'If denied, you stay in plan mode to refine the plan.',
  parameters: z.object({}),
  readOnly: false,
  riskLevel: 'medium',

  async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
    const planFilePath = context.planFilePath;
    if (!planFilePath) {
      return {
        toolUseId: '',
        content: 'No plan file path is set. Are you in plan mode?',
        isError: true,
      };
    }

    const planContent = readPlanContent(planFilePath);
    if (!planContent) {
      return {
        toolUseId: '',
        content: `No plan file found at ${planFilePath}. Write your plan first using write_file, then call exit_plan_mode again.`,
        isError: true,
      };
    }

    return {
      toolUseId: '',
      content: `User has approved your plan. You can now start coding. Plan saved at: ${planFilePath}`,
      metadata: {
        plan: planContent,
        planFilePath,
      },
    };
  },
};
