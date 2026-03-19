/**
 * Background task type definitions.
 *
 * Background tasks allow bash commands and sub-agents to run
 * asynchronously while the main agent loop continues.
 * The model gets notified when tasks complete.
 */

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'killed';
export type TaskType = 'bash' | 'agent';

export interface BackgroundTask {
  id: string;
  type: TaskType;
  description: string;
  status: TaskStatus;
  /** Monotonically-growing output buffer */
  output: string;
  /** Error message if status is 'failed' */
  error?: string;
  /** Exit code for bash tasks */
  exitCode?: number;
  /** When the task was created */
  createdAt: number;
  /** When the task completed/failed/killed */
  completedAt?: number;
  /** How many bytes of output have been reported to the model */
  outputOffset: number;
  /** Whether the model has been notified of completion */
  notified: boolean;
  /** AbortController for cancellation */
  abort: AbortController;
  /** Child process PID (bash tasks only) */
  pid?: number;
}

/** Attachment injected into conversation before each API call */
export interface TaskAttachment {
  type: 'task_status' | 'task_progress';
  taskId: string;
  taskType: TaskType;
  status: TaskStatus;
  description: string;
  /** Incremental output since last check */
  deltaOutput?: string;
  /** Error message */
  error?: string;
}
