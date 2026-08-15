import type { AgentCredentialScope } from './types.js';

const CLOSED_CREDENTIAL_SCOPES = new Set<string>([
  'fleet-ssh',
  'kubeconfig',
  'vault-token',
  'shizuha-id',
  'github',
  'gitlab',
  'aws',
  'npm',
  'docker',
  'custom',
]);

const LABEL_SCOPED_CREDENTIAL_SCOPES = new Set<string>([
  'kubeconfig',
  'vault-token',
]);

export interface DaemonCredentialSummary {
  id: string;
  service?: string;
  scope?: string;
  label?: string;
  envMapping?: Record<string, string>;
}

export interface DaemonCredentialPayload {
  service: AgentCredentialScope;
  scope: AgentCredentialScope;
  label: string;
  credentialData: Record<string, string>;
  injectAsEnv: boolean;
  _noRestart: boolean;
}

export function mapCredentialServiceToScope(service: string): AgentCredentialScope {
  return CLOSED_CREDENTIAL_SCOPES.has(service) ? service as AgentCredentialScope : 'custom';
}

export function daemonCredentialLabel(service: string, label?: string): string {
  const displayLabel = label || service;
  if (mapCredentialServiceToScope(service) !== 'custom') return displayLabel;
  return displayLabel === service ? service : `${displayLabel} (${service})`;
}

export function buildDaemonCredentialPayload(
  service: string,
  label: string | undefined,
  credentialData: Record<string, string>,
): DaemonCredentialPayload {
  const scope = mapCredentialServiceToScope(service);
  return {
    service: scope,
    scope,
    label: daemonCredentialLabel(service, label),
    credentialData,
    injectAsEnv: true,
    _noRestart: true,
  };
}

export function findMatchingDaemonCredential(
  credentials: DaemonCredentialSummary[],
  service: string,
  label?: string,
): DaemonCredentialSummary | undefined {
  const scope = mapCredentialServiceToScope(service);
  const mappedLabel = daemonCredentialLabel(service, label);
  const legacyCustomLabel = label ? `${label} (${service})` : service;
  return credentials.find((credential) => {
    const credentialScope = credential.scope ?? credential.service;
    if (scope === 'custom' && credential.service === service) return true; // legacy arbitrary service value, before PLAT-99 scope closure
    if (LABEL_SCOPED_CREDENTIAL_SCOPES.has(scope)) {
      if (credentialScope === scope) return credential.label === mappedLabel;
      // kubeconfig/vault-token were promoted from custom credentials. Preserve
      // the old `custom` row match by exact preserved label so updates PATCH
      // the legacy grant instead of POSTing a second active credential.
      return credentialScope === 'custom' &&
        (
          (
            credential.service === service &&
            (label === undefined || credential.label === mappedLabel || credential.label === legacyCustomLabel)
          ) ||
          (
            credential.service === 'custom' &&
            credential.label === legacyCustomLabel
          )
        );
    }
    if (credentialScope !== scope) return false;
    if (scope !== 'custom') return true;
    // For arbitrary services mapped into the custom scope, preserve matching by
    // original service across both documented call shapes:
    //   create: update_credential(service='x-twitter', label='X API', ...)
    //   update: update_credential(service='x-twitter', ...)
    // The daemon label from the create path is `X API (x-twitter)`; match that
    // preserved suffix to avoid creating duplicate active custom grants.
    return credential.label === mappedLabel ||
      credential.label === service ||
      credential.label?.endsWith(`(${service})`) === true;
  });
}

export function formatDaemonCredentialPersistError(action: string, statusCode: number, data: unknown): string {
  let detail = '';
  if (data && typeof data === 'object' && 'error' in data) {
    const error = (data as { error?: unknown }).error;
    detail = typeof error === 'string' ? error : JSON.stringify(error);
  } else if (data && typeof data === 'object' && 'raw' in data) {
    const raw = (data as { raw?: unknown }).raw;
    detail = typeof raw === 'string' ? raw.slice(0, 200) : JSON.stringify(raw);
  } else if (data !== undefined) {
    detail = JSON.stringify(data).slice(0, 200);
  }
  return `${action} failed with HTTP ${statusCode}${detail ? `: ${detail}` : ''}`;
}
