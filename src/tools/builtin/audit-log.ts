/**
 * Audit Log Query Tool — lets agents query their own audit trail.
 *
 * GAP C: OpenClaw parity — audit_log built-in tool.
 */
import { z } from 'zod';
import type { ToolHandler, ToolContext, ToolResult } from '../types.js';
import { AuditLogger } from '../../security/audit.js';

// Singleton logger — set via setAuditLogger() from agent-process.ts
let _auditLogger: AuditLogger | null = null;

export function setAuditLogger(logger: AuditLogger): void {
  _auditLogger = logger;
}

export function getAuditLogger(): AuditLogger | null {
  return _auditLogger;
}

export const auditLogTool: ToolHandler = {
  name: 'audit_log',
  description:
    'Query the security audit trail for this agent. Shows tool invocations ' +
    'with timing, risk flags, and results.\n\n' +
    'Use this to review what tools have been called, detect anomalies, ' +
    'or audit your own actions.\n\n' +
    'Examples:\n' +
    '  audit_log(limit=20)\n' +
    '  audit_log(tool="bash", risk_only=true)\n' +
    '  audit_log(limit=10, tool="write")',
  parameters: z.object({
    limit: z.number().int().min(1).max(200).optional().default(50).describe('Max entries to return'),
    tool: z.string().optional().describe('Filter by tool name'),
    risk_only: z.boolean().optional().default(false).describe('Only show entries with risk flags'),
  }),
  readOnly: true,
  riskLevel: 'low',

  async execute(params: unknown, _context: ToolContext): Promise<ToolResult> {
    if (!_auditLogger) {
      return { toolUseId: '', content: 'Audit logging is not enabled for this agent.', isError: true };
    }

    const args = (this as any).parameters.parse(params);
    const entries = _auditLogger.query({
      limit: args.limit,
      tool: args.tool,
      riskOnly: args.risk_only,
    });

    if (entries.length === 0) {
      return { toolUseId: '', content: 'No audit entries found matching the criteria.' };
    }

    const lines = entries.map((e) => {
      const risks = e.riskFlags.length > 0 ? ` [${e.riskFlags.join(', ')}]` : '';
      const duration = e.durationMs !== undefined ? ` (${e.durationMs}ms)` : '';
      const result = e.resultSummary ? `\n    Result: ${e.resultSummary.slice(0, 200)}` : '';
      return `${e.timestamp} ${e.phase.toUpperCase()} ${e.tool}${risks}${duration}\n    Input: ${e.inputSummary.slice(0, 200)}${result}`;
    });

    return {
      toolUseId: '',
      content: `Audit trail (${entries.length} entries):\n\n${lines.join('\n\n')}`,
    };
  },
};
