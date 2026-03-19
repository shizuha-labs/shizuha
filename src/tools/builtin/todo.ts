import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

/** In-memory task list per session */
interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  createdAt: number;
}

const sessionTodos = new Map<string, TodoItem[]>();

function getTodos(sessionId: string): TodoItem[] {
  if (!sessionTodos.has(sessionId)) {
    sessionTodos.set(sessionId, []);
  }
  return sessionTodos.get(sessionId)!;
}

export const todoWriteTool: ToolHandler = {
  name: 'todo_write',
  description:
    'Create or update tasks in your working todo list. Use this to track multi-step work, ' +
    'mark tasks in_progress when starting, and completed when done. ' +
    'Accepts an array of todos with id, content, and status fields.',
  parameters: z.object({
    todos: z.array(z.object({
      id: z.string().describe('Unique task ID (e.g., "1", "2")'),
      content: z.string().describe('Task description'),
      status: z.enum(['pending', 'in_progress', 'completed']).describe('Task status'),
    })).describe('Array of todo items to create or update'),
  }),
  readOnly: false,
  riskLevel: 'low',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { todos } = this.parameters.parse(params);
    const list = getTodos(context.sessionId);

    for (const todo of todos) {
      const existing = list.find((t) => t.id === todo.id);
      if (existing) {
        existing.content = todo.content;
        existing.status = todo.status;
      } else {
        list.push({
          id: todo.id,
          content: todo.content,
          status: todo.status,
          createdAt: Date.now(),
        });
      }
    }

    const summary = list.map((t) => {
      const icon = t.status === 'completed' ? '\u2713' : t.status === 'in_progress' ? '\u25B6' : '\u25CB';
      return `${icon} [${t.id}] ${t.content} (${t.status})`;
    }).join('\n');

    return {
      toolUseId: '',
      content: `Todo list updated (${list.length} items):\n${summary}`,
    };
  },
};

export const todoReadTool: ToolHandler = {
  name: 'todo_read',
  description:
    'Read your current todo list to check progress and find the next task to work on.',
  parameters: z.object({}),
  readOnly: true,
  riskLevel: 'low',

  async execute(_params: unknown, context: ToolContext): Promise<ToolResult> {
    const list = getTodos(context.sessionId);

    if (list.length === 0) {
      return {
        toolUseId: '',
        content: 'No tasks in todo list.',
      };
    }

    const pending = list.filter((t) => t.status === 'pending').length;
    const inProgress = list.filter((t) => t.status === 'in_progress').length;
    const completed = list.filter((t) => t.status === 'completed').length;

    const items = list.map((t) => {
      const icon = t.status === 'completed' ? '\u2713' : t.status === 'in_progress' ? '\u25B6' : '\u25CB';
      return `${icon} [${t.id}] ${t.content} (${t.status})`;
    }).join('\n');

    return {
      toolUseId: '',
      content: `Todo list (${pending} pending, ${inProgress} in progress, ${completed} completed):\n${items}`,
    };
  },
};
