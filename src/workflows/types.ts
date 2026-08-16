/**
 * Workflow type definitions.
 *
 * A workflow defines the lifecycle of a task — what statuses it can be in,
 * and what transitions are allowed between them. This is a task-centric model
 * (like Jira), not an execution pipeline (like Agno).
 *
 * Shared schema: the same structure is used by both the local runtime
 * and the platform Pulse. Workflows are stored as JSON files locally
 * and in PostgreSQL on the platform.
 */

/** A status in the workflow state machine. */
export interface WorkflowStatus {
  /** Machine-readable ID (used in transitions) */
  id: string;
  /** Human-readable display name */
  label: string;
  /** Category for grouping: open | in_progress | done | cancelled */
  category: 'open' | 'in_progress' | 'done' | 'cancelled';
  /** Hex color for UI rendering */
  color?: string;
}

/** An action to perform when a transition fires. */
export interface TransitionAction {
  /** Username to assign the task to. Supports {{actor}}, {{creator}} templates */
  assign_to?: string;
  /** Team/group to assign the task to (ServiceNow-style assignment group).
   *  Sets the assignment_group field. The team lead or round-robin resolves the individual assignee. */
  assign_team?: string;
  /** Label to add */
  add_label?: string;
  /** Label to remove */
  remove_label?: string;
  /** Auto-comment. Supports {{actor}}, {{assignee}}, {{from}}, {{to}} templates */
  comment?: string;
  /** Usernames to notify */
  notify?: string[];
}

/** A transition between two statuses. */
export interface WorkflowTransition {
  /** Source status ID */
  from: string;
  /** Target status ID */
  to: string;
  /** Who can trigger: auto (system), human, agent, any */
  trigger: 'auto' | 'human' | 'agent' | 'any';
  /** Optional display name for this transition */
  label?: string;
  /** Optional description / tooltip */
  description?: string;
  /** Actions to perform when this transition fires */
  on_transition?: TransitionAction;
}

/** A complete workflow definition. */
export interface WorkflowDefinition {
  /** Unique name (filesystem-safe, used as ID) */
  name: string;
  /** Human-readable description */
  description?: string;
  /** Semver version */
  version?: string;
  /** Which Pulse project this workflow applies to (e.g., "SEC", "GEN") */
  project?: string;
  /** All statuses in this workflow */
  statuses: WorkflowStatus[];
  /** The initial status for new tasks */
  initial_status: string;
  /** All allowed transitions */
  transitions: WorkflowTransition[];
  /** When this workflow was created */
  created_at?: string;
  /** Who created it (agent username or 'human') */
  created_by?: string;
}

/** Result of validating a transition. */
export interface TransitionValidation {
  valid: boolean;
  error?: string;
  transition?: WorkflowTransition;
}

/** Result of executing a transition. */
export interface TransitionResult {
  ok: boolean;
  new_status: string;
  assigned_to?: string;
  comment?: string;
  error?: string;
}

/** Serialized workflow info for API responses. */
export interface WorkflowInfo {
  name: string;
  description?: string;
  version?: string;
  project?: string;
  statuses: WorkflowStatus[];
  initial_status: string;
  transition_count: number;
}
