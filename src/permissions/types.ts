export type PermissionMode = 'plan' | 'supervised' | 'autonomous';

export type PermissionDecision = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  tool: string;
  pattern?: string;
  decision: PermissionDecision;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  riskLevel: 'low' | 'medium' | 'high';
}

/** Network access policy for sandbox mode */
export interface NetworkPolicy {
  /** Whether outbound network access is allowed at all */
  networkAccess: boolean;
  /** Allowed destination hosts (empty = all allowed when networkAccess=true) */
  allowedHosts: string[];
}
