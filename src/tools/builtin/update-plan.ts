import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';

/** In-memory plan state per session */
interface PlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

const sessionPlans = new Map<string, PlanStep[]>();

export const updatePlanTool: ToolHandler = {
  name: 'update_plan',
  description:
    'Create or update a step-by-step plan for the current task. Use this to track progress ' +
    'on multi-step work. Each step has a description and status (pending, in_progress, completed). ' +
    'Call this tool to outline your approach before starting complex work, then update step statuses as you go. ' +
    'At most one step should be in_progress at a time. Do not use for trivial single-step tasks.',
  parameters: z.object({
    plan: z.array(z.object({
      step: z.string().describe('Short description of the step (5-7 words)'),
      status: z.enum(['pending', 'in_progress', 'completed']).describe('Step status'),
    })).describe('The list of plan steps'),
    explanation: z.string().optional().describe('Brief explanation of what changed in the plan'),
  }),
  readOnly: false,
  riskLevel: 'low',

  async execute(params: unknown, context: ToolContext): Promise<ToolResult> {
    const { plan, explanation } = this.parameters.parse(params);

    // Store plan for this session
    sessionPlans.set(context.sessionId, plan);

    const summary = plan.map((s: PlanStep) => {
      const icon = s.status === 'completed' ? '\u2713' : s.status === 'in_progress' ? '\u25B6' : '\u25CB';
      return `${icon} ${s.step} (${s.status})`;
    }).join('\n');

    const completed = plan.filter((s: PlanStep) => s.status === 'completed').length;
    const total = plan.length;
    const header = `Plan updated (${completed}/${total} completed)`;
    const body = explanation ? `${header}\n${explanation}\n\n${summary}` : `${header}\n${summary}`;

    return {
      toolUseId: '',
      content: body,
      metadata: { plan, explanation },
    };
  },
};
