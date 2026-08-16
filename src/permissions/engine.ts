import * as path from 'node:path';
import type { PermissionMode, PermissionDecision, PermissionRequest, PermissionRule, NetworkPolicy } from './types.js';
import type { ToolHandler } from '../tools/types.js';

/** Tools that make outbound network requests */
const NETWORK_TOOLS = new Set(['web_fetch', 'web_search']);

export class PermissionEngine {
  private mode: PermissionMode;
  private rules: PermissionRule[];
  private sessionApprovals = new Set<string>();
  private onPersistApproval?: (toolName: string) => void;
  private planFilePath?: string;
  private networkPolicy?: NetworkPolicy;

  constructor(
    mode: PermissionMode,
    rules: PermissionRule[] = [],
    options?: {
      persistedApprovals?: string[];
      onPersistApproval?: (toolName: string) => void;
      networkPolicy?: NetworkPolicy;
    },
  ) {
    this.mode = mode;
    this.rules = rules;
    this.networkPolicy = options?.networkPolicy;
    // Load persisted approvals into session set
    if (options?.persistedApprovals) {
      for (const name of options.persistedApprovals) {
        this.sessionApprovals.add(name);
      }
    }
    this.onPersistApproval = options?.onPersistApproval;
  }

  /** Set the active plan file path for plan mode write exceptions */
  setPlanFilePath(filePath: string | undefined): void {
    this.planFilePath = filePath;
  }

  getPlanFilePath(): string | undefined {
    return this.planFilePath;
  }

  /** Check if a tool call is allowed */
  check(request: PermissionRequest): PermissionDecision {
    // 1. Plan mode — strictest enforcement, overrides rules and session approvals.
    //    Plan mode is intentionally more restrictive: only read-only tools,
    //    exit_plan_mode (for approval dialog), and writes to the plan file.
    //    Checked FIRST so that config rules like { edit: 'ask' } cannot weaken it.
    if (this.mode === 'plan') {
      if (request.riskLevel === 'low') return 'allow';
      if (request.toolName === 'exit_plan_mode') return 'ask';
      if (this.planFilePath && this.isPlanFileAccess(request)) return 'allow';
      return 'deny';
    }

    // 2. Check explicit rules
    for (const rule of this.rules) {
      if (this.matchesRule(rule, request)) {
        return rule.decision;
      }
    }

    // 3. Network policy — check destination host for network tools
    if (this.networkPolicy && NETWORK_TOOLS.has(request.toolName)) {
      const networkDecision = this.checkNetworkAccess(request);
      if (networkDecision === 'deny') return 'deny';
    }

    // 4. Check session approvals
    if (this.sessionApprovals.has(request.toolName)) {
      return 'allow';
    }

    // 5. Mode-based defaults
    switch (this.mode) {
      case 'autonomous':
        return 'allow';

      case 'supervised':
        // Read-only, low-risk tools are auto-allowed
        if (request.riskLevel === 'low') return 'allow';
        return 'ask';

      default:
        return 'ask';
    }
  }

  /** Record a session approval (user said "yes" for a tool) */
  approve(toolName: string): void {
    this.sessionApprovals.add(toolName);
    // Persist across sessions if callback is configured
    this.onPersistApproval?.(toolName);
  }

  /** Update mode */
  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  private matchesRule(rule: PermissionRule, request: PermissionRequest): boolean {
    // Simple glob match on tool name
    if (rule.tool === '*') return true;
    if (rule.tool === request.toolName) return true;
    if (rule.tool.endsWith('*') && request.toolName.startsWith(rule.tool.slice(0, -1))) return true;
    return false;
  }

  /** Check if a tool request is accessing the plan file (Write/Edit only) */
  private isPlanFileAccess(request: PermissionRequest): boolean {
    if (request.toolName !== 'write' && request.toolName !== 'edit') return false;
    const filePath = request.input.file_path as string | undefined;
    if (!filePath || !this.planFilePath) return false;
    const resolved = path.resolve(filePath);
    const resolvedPlan = path.resolve(this.planFilePath);
    return resolved === resolvedPlan;
  }

  /** Check network access for tools that make outbound requests */
  private checkNetworkAccess(request: PermissionRequest): PermissionDecision {
    if (!this.networkPolicy) return 'allow';

    // If network access is disabled entirely, deny
    if (!this.networkPolicy.networkAccess) return 'deny';

    // If no host allowlist, all hosts are allowed
    if (!this.networkPolicy.allowedHosts?.length) return 'allow';

    // Extract URL from tool input
    const url = request.input.url as string | undefined;
    if (!url) return 'allow'; // No URL to check (e.g., web_search with query only)

    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      for (const pattern of this.networkPolicy.allowedHosts) {
        if (matchHost(pattern, hostname)) return 'allow';
      }
      return 'deny'; // Host not in allowlist
    } catch {
      return 'deny'; // Malformed URL — deny to be safe
    }
  }

  /** Update network policy at runtime */
  setNetworkPolicy(policy: NetworkPolicy | undefined): void {
    this.networkPolicy = policy;
  }
}

/** Match a hostname against an allowed host pattern.
 *  Supports exact match ("api.example.com") and wildcard prefix ("*.example.com"). */
function matchHost(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  if (p === hostname) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".example.com"
    return hostname.endsWith(suffix) || hostname === p.slice(2); // also match "example.com" for "*.example.com"
  }
  return false;
}
