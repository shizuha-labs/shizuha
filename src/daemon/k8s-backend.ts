/**
 * Public Shizuha Code does not ship the in-cluster fleet actuator.
 * Local `shizuha up` still works for host processes; k8s spawn is a no-op.
 */
import type { AgentInfo } from './types.js';
import type { DesiredRuntimeRelease } from './runtime-release.js';

export interface K8sSpawnOpts {
  command: 'claude-bridge' | 'codex-bridge' | 'openclaw-bridge' | 'gateway' | string;
  model: string;
  effort?: string;
  contextPrompt: string;
  password: string;
  githubToken?: string;
  imageOverride?: string;
  brokerImageOverride?: string;
  runtimeRelease?: DesiredRuntimeRelease;
  fleetSshFiles?: Record<string, string>;
  extraEnv?: Record<string, string>;
}

export interface K8sDeploymentState {
  agentId: string;
  username: string;
  name: string;
  replicas: number;
  readyReplicas: number;
  availableReplicas: number;
  generation?: number;
  observedGeneration?: number;
  updatedReplicas?: number;
  progressingReason?: string;
  progressingUpdatedAtMs?: number;
  currentImage?: string;
  resourceVersion?: string;
  currentWorkspaceInitImage?: string;
  currentBrokerImage?: string;
  runtimeReleaseGeneration?: number;
  runtimeReleaseDigest?: string;
  configHash?: string;
  runtimeSpecRevision?: string;
  duplicateEnvMetadata?: boolean;
  githubCredentialExpected?: boolean;
  githubTokenEnvWired?: boolean;
  githubTokenSecretPresent?: boolean;
  githubCredentialDrift?: boolean;
}

export interface K8sRuntimeLaneProbe {
  generation: number;
  digest: string;
  brokerReady: boolean;
  runtime: Record<string, unknown>;
}

export interface K8sRuntimeRollBridgePreparation {
  busy: boolean;
  protocol: 'drain-v1' | 'drain-v2' | 'legacy-health';
  fenceVersion?: number;
  drainReserved?: boolean;
}

export interface K8sLegacyGatewayCheckpoint {
  sessionId: string;
  toolResultAt: number;
}

export type K8sGitHubCredentialProbeReason =
  | 'ok'
  | 'credential_unwired'
  | 'deployment_unready'
  | 'github_token_empty'
  | 'github_api_failed'
  | 'github_upstream_unavailable'
  | 'probe_transport_failed'
  | 'probe_error';

export interface K8sGitHubCredentialProbeResult {
  agentId: string;
  username: string;
  team: string;
  ownerGroup: string;
  expected: boolean;
  ok: boolean;
  reason: K8sGitHubCredentialProbeReason;
  checkedAt: string;
  identity?: string;
  probeRepo?: string;
  detail?: string;
}

export interface K8sTeamSecretBinding {
  name: string;
  key: string;
}

export type AgentResolvedRuntimeHashInputs = Pick<
  AgentInfo,
  'id' | 'username' | 'skills' | 'eagerSkills' | 'mcpServers'
>;

export interface K8sAgentSessionTail {
  file: string;
  lines: string[];
}

export interface K8sAgentSessionTailUnavailable {
  reason: 'not_k8s_agent' | 'deployment_unavailable' | 'deployment_not_ready' | 'exec_failed' | 'no_session_file';
  message: string;
  detail?: string;
}

export interface K8sAgentSessionTailStatus {
  tail: K8sAgentSessionTail | null;
  unavailable?: K8sAgentSessionTailUnavailable;
}

export interface ValidatedRuntimeReleaseResult {
  release?: DesiredRuntimeRelease;
  documentFingerprint?: string;
  issues: string[];
}

export interface K8sSessionResetResult {
  ok: boolean;
  error?: string;
  archived?: string[];
  deleted?: Record<string, number>;
}

export const MCP_CONFIG_HASH_ANNOTATION = 'shizuha.io/mcp-config-hash';
export const K8S_RUNTIME_SPEC_REVISION_ANNOTATION = 'shizuha.io/runtime-spec-revision';
export const K8S_RUNTIME_SPEC_REVISION = 'public-harness-stub';
export const MCP_CONFIG_HASH_SCHEMA_VERSION = 2;
export const K8S_ROLLOUT_SUPPRESS_WINDOW_MS = 120_000;
export const AGENT_TUNING_ENV_KEYS: string[] = [];

export type K8sObserveKind = 'auth' | 'unreachable' | 'unknown';
export class K8sObserveError extends Error {
  kind: K8sObserveKind;
  constructor(kind: K8sObserveKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export function normalizeAgentDeploymentEnvMetadata(_raw: string): {
  env: Record<string, string>;
  duplicateKeys: string[];
} {
  return { env: {}, duplicateKeys: [] };
}

export function repairAgentK8sDuplicateEnvMetadata(..._args: unknown[]): boolean {
  return false;
}

export function isK8sAgent(_agent?: AgentInfo): boolean {
  return false;
}

export function agentMcpEnv(_agent: AgentInfo): Record<string, string> {
  return {};
}

export function agentPlatformEnv(): Record<string, string> {
  return {};
}

export function githubIdentityFor(_agent: AgentInfo): string | undefined {
  return undefined;
}

export function agentTuningEnv(_agent: AgentInfo): Record<string, string> {
  return {};
}

export function k8sTeamSecretBindingsForAgent(_agent: AgentInfo): K8sTeamSecretBinding[] {
  return [];
}

export function mergeOrderedUniqueEnv(
  ...groups: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const group of groups) Object.assign(out, group ?? {});
  return out;
}

export function computeAgentMcpConfigHash(..._args: unknown[]): string {
  return 'public-harness-stub';
}

export function explainK8sUnsupportedRuntime(_agent?: AgentInfo): string | null {
  return 'k8s fleet backend is not included in Shizuha Code';
}

export function isPrivilegedK8sAgent(_agent?: AgentInfo): boolean {
  return false;
}

export function requiresFleetSshForK8sAgent(_agent?: AgentInfo): boolean {
  return false;
}

export function missingRequiredFleetSshReason(..._args: unknown[]): string | null {
  return null;
}

export function shouldSpawnK8sAgent(_agent?: AgentInfo): boolean {
  return false;
}

export function classifyKubectlFailure(_err: unknown): 'auth' | 'unreachable' | 'not_found' | 'other' {
  return 'other';
}

export function isK8sControlPlaneUnreadable(_err: unknown): boolean {
  return false;
}

export function operatorFacingK8sError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function scheduleK8sLastActivityProbe(..._args: unknown[]): void {}

export async function readK8sAgentSessionTailStatus(
  _agent: AgentInfo,
  _maxLines = 2000,
): Promise<K8sAgentSessionTailStatus> {
  return {
    tail: null,
    unavailable: { reason: 'not_k8s_agent', message: 'k8s live-tail is not part of Shizuha Code' },
  };
}

export async function readK8sAgentSessionTail(
  _agent: AgentInfo,
  _maxLines = 2000,
): Promise<K8sAgentSessionTail | null> {
  return null;
}

export function agentNodeHeapMb(_command: string): number {
  return 0;
}

export function renderK8sInlineFailoverEntrypoint(..._args: unknown[]): string {
  return '#!/bin/sh\nexit 0\n';
}

export async function resolveRuntimeImageDigest(imageRef: string): Promise<string> {
  return imageRef;
}

export async function readValidatedRuntimeRelease(): Promise<ValidatedRuntimeReleaseResult> {
  return { issues: [] };
}

export async function refreshHiveDesiredImage(..._args: unknown[]): Promise<void> {}

export function desiredBrokerImage(): string {
  return '';
}

export function renderAgentManifest(..._args: unknown[]): string {
  return '';
}

export function spawnAgentK8s(_agent: AgentInfo, _opts: K8sSpawnOpts): void {
  throw new Error('k8s fleet backend is not included in Shizuha Code');
}

export function rollAgentK8sRuntimeRelease(..._args: unknown[]): void {
  throw new Error('k8s fleet backend is not included in Shizuha Code');
}

export function getAgentK8sDeploymentState(_agent: AgentInfo): K8sDeploymentState | null {
  return null;
}

export async function getAgentK8sDeploymentStateAsync(
  _agent: AgentInfo,
): Promise<K8sDeploymentState | null> {
  return null;
}

export async function probeAgentK8sRuntimeLane(_agent: AgentInfo): Promise<K8sRuntimeLaneProbe> {
  throw new Error('runtime_lane_probe_requires_k8s_agent');
}

export async function probeAgentK8sBridgeBusy(_agent: AgentInfo): Promise<boolean> {
  return false;
}

export async function readLatestAgentK8sHeartbeatOutcomeLogLine(
  _agent: AgentInfo,
): Promise<string | null> {
  return null;
}

export async function readLatestAgentK8sLegacyGatewayCheckpoint(
  _agent: AgentInfo,
): Promise<K8sLegacyGatewayCheckpoint | undefined> {
  return undefined;
}

export async function prepareAgentK8sBridgeForRuntimeRoll(
  ..._args: unknown[]
): Promise<K8sRuntimeRollBridgePreparation> {
  return { busy: false, protocol: 'legacy-health' };
}

export function stageStoppedAgentK8sRuntime(..._args: unknown[]): void {}

export function rollRunningAgentK8sRuntime(..._args: unknown[]): void {
  throw new Error('k8s fleet backend is not included in Shizuha Code');
}

export function noteK8sDaemonApply(..._args: unknown[]): void {}

export function k8sDaemonApplyInProgress(..._args: unknown[]): boolean {
  return false;
}

export function k8sDeploymentRolloutInProgress(..._args: unknown[]): boolean {
  return false;
}

export function listK8sAgentDeployments(..._args: unknown[]): K8sDeploymentState[] {
  return [];
}

export function probeK8sGithubCredentialHealth(
  ..._args: unknown[]
): K8sGitHubCredentialProbeResult[] {
  return [];
}

export function stopAgentK8s(..._args: unknown[]): void {}

export function restoreAgentK8s(..._args: unknown[]): void {}

export async function resetK8sAgentRuntimeSession(
  ..._args: unknown[]
): Promise<K8sSessionResetResult> {
  return { ok: false };
}

export async function restartAgentK8s(..._args: unknown[]): Promise<void> {}

export function deleteAgentK8s(..._args: unknown[]): void {}
