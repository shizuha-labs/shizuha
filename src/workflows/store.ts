/**
 * Workflow store — CRUD operations for workflow definitions.
 *
 * Workflows are stored as JSON files in ~/.shizuha/workflows/.
 * Agents can create, read, update, and delete workflows at runtime.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type {
  WorkflowDefinition,
  WorkflowInfo,
  WorkflowTransition,
  TransitionValidation,
  TransitionResult,
  TransitionAction,
} from './types.js';
import { logger } from '../utils/logger.js';

const WORKFLOWS_DIR = path.join(os.homedir(), '.shizuha', 'workflows');

/** Ensure the workflows directory exists. */
function ensureDir(): void {
  fs.mkdirSync(WORKFLOWS_DIR, { recursive: true });
}

/** Sanitize workflow name for filesystem use. */
function sanitizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-');
}

/** Path to a workflow's JSON file. */
function workflowPath(name: string): string {
  return path.join(WORKFLOWS_DIR, `${sanitizeName(name)}.json`);
}

// ── CRUD Operations ──

/** Create a new workflow definition. */
export function createWorkflow(def: WorkflowDefinition): { ok: boolean; error?: string } {
  ensureDir();
  const safeName = sanitizeName(def.name);
  const filePath = workflowPath(safeName);

  if (fs.existsSync(filePath)) {
    return { ok: false, error: `Workflow "${safeName}" already exists` };
  }

  // Validate
  const validation = validateWorkflowDefinition(def);
  if (!validation.ok) return validation;

  def.name = safeName;
  def.created_at = def.created_at || new Date().toISOString();

  fs.writeFileSync(filePath, JSON.stringify(def, null, 2));
  logger.info({ workflow: safeName }, 'Workflow created');
  return { ok: true };
}

/** Get a workflow by name. */
export function getWorkflow(name: string): WorkflowDefinition | null {
  const filePath = workflowPath(name);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as WorkflowDefinition;
  } catch {
    return null;
  }
}

/** List all workflows. */
export function listWorkflows(): WorkflowInfo[] {
  ensureDir();
  const results: WorkflowInfo[] = [];

  for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const def = JSON.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8')) as WorkflowDefinition;
      results.push({
        name: def.name,
        description: def.description,
        version: def.version,
        project: def.project,
        statuses: def.statuses,
        initial_status: def.initial_status,
        transition_count: def.transitions.length,
      });
    } catch { /* skip malformed */ }
  }

  return results;
}

/** Update an existing workflow. */
export function updateWorkflow(name: string, updates: Partial<WorkflowDefinition>): { ok: boolean; error?: string } {
  const existing = getWorkflow(name);
  if (!existing) return { ok: false, error: `Workflow "${name}" not found` };

  const merged = { ...existing, ...updates, name: existing.name }; // don't allow renaming via update
  const validation = validateWorkflowDefinition(merged);
  if (!validation.ok) return validation;

  fs.writeFileSync(workflowPath(name), JSON.stringify(merged, null, 2));
  return { ok: true };
}

/** Delete a workflow. */
export function deleteWorkflow(name: string): { ok: boolean; error?: string } {
  const filePath = workflowPath(name);
  if (!fs.existsSync(filePath)) return { ok: false, error: `Workflow "${name}" not found` };
  fs.unlinkSync(filePath);
  return { ok: true };
}

// ── Transition Logic ──

/** Validate whether a transition is allowed. */
export function validateTransition(
  workflow: WorkflowDefinition,
  currentStatus: string,
  targetStatus: string,
  actorType: 'human' | 'agent' | 'auto',
): TransitionValidation {
  // Find matching transitions
  const matching = workflow.transitions.filter(
    (t) => t.from === currentStatus && t.to === targetStatus,
  );

  if (matching.length === 0) {
    const validTargets = workflow.transitions
      .filter((t) => t.from === currentStatus)
      .map((t) => t.to);
    return {
      valid: false,
      error: `No transition from "${currentStatus}" to "${targetStatus}". Valid targets: ${validTargets.join(', ') || 'none'}`,
    };
  }

  // Check trigger permissions
  const transition = matching[0]!;
  if (transition.trigger !== 'any' && transition.trigger !== actorType) {
    return {
      valid: false,
      error: `Transition from "${currentStatus}" to "${targetStatus}" requires "${transition.trigger}" but actor is "${actorType}"`,
    };
  }

  return { valid: true, transition };
}

/** Get valid transitions from a given status. */
export function getValidTransitions(
  workflow: WorkflowDefinition,
  currentStatus: string,
  actorType?: 'human' | 'agent' | 'auto',
): WorkflowTransition[] {
  return workflow.transitions.filter((t) => {
    if (t.from !== currentStatus) return false;
    if (actorType && t.trigger !== 'any' && t.trigger !== actorType) return false;
    return true;
  });
}

/** Apply template variables to a string. */
export function applyTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
}

/** Execute transition actions and return the result. */
export function executeTransitionActions(
  action: TransitionAction,
  vars: Record<string, string>,
): { assign_to?: string; assign_team?: string; comment?: string; add_label?: string; remove_label?: string } {
  const result: { assign_to?: string; assign_team?: string; comment?: string; add_label?: string; remove_label?: string } = {};

  if (action.assign_to) {
    result.assign_to = applyTemplate(action.assign_to, vars);
  }
  if (action.assign_team) {
    result.assign_team = applyTemplate(action.assign_team, vars);
  }
  if (action.comment) {
    result.comment = applyTemplate(action.comment, vars);
  }
  if (action.add_label) {
    result.add_label = action.add_label;
  }
  if (action.remove_label) {
    result.remove_label = action.remove_label;
  }

  return result;
}

// ── Validation ──

/** Validate a workflow definition for internal consistency. */
function validateWorkflowDefinition(def: WorkflowDefinition): { ok: boolean; error?: string } {
  if (!def.name || def.name.trim() === '') {
    return { ok: false, error: 'Workflow name is required' };
  }

  if (!def.statuses || def.statuses.length === 0) {
    return { ok: false, error: 'At least one status is required' };
  }

  const statusIds = new Set(def.statuses.map((s) => s.id));

  if (!def.initial_status || !statusIds.has(def.initial_status)) {
    return { ok: false, error: `Initial status "${def.initial_status}" not found in statuses` };
  }

  // Validate transitions reference valid statuses
  for (const t of def.transitions) {
    if (!statusIds.has(t.from)) {
      return { ok: false, error: `Transition references unknown status "${t.from}"` };
    }
    if (!statusIds.has(t.to)) {
      return { ok: false, error: `Transition references unknown status "${t.to}"` };
    }
    if (!['auto', 'human', 'agent', 'any'].includes(t.trigger)) {
      return { ok: false, error: `Invalid trigger "${t.trigger}" on transition ${t.from} → ${t.to}` };
    }
  }

  return { ok: true };
}
