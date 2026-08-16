import { describe, expect, it } from 'vitest';
import {
  buildDaemonCredentialPayload,
  daemonCredentialLabel,
  findMatchingDaemonCredential,
  formatDaemonCredentialPersistError,
  mapCredentialServiceToScope,
} from '../src/daemon/credential-persistence.js';

describe('cron MCP credential daemon persistence mapping', () => {
  it('passes closed enum services through unchanged', () => {
    expect(mapCredentialServiceToScope('github')).toBe('github');
    expect(buildDaemonCredentialPayload('github', 'GitHub API', { GITHUB_TOKEN: 'ghp_example' })).toMatchObject({
      scope: 'github',
      service: 'github',
      label: 'GitHub API',
      credentialData: { GITHUB_TOKEN: 'ghp_example' },
      injectAsEnv: true,
      _noRestart: true,
    });
  });

  it('routes arbitrary service names through custom scope while preserving the name in label', () => {
    expect(mapCredentialServiceToScope('x-twitter')).toBe('custom');
    expect(daemonCredentialLabel('x-twitter', 'X API')).toBe('X API (x-twitter)');
    expect(buildDaemonCredentialPayload('openai', undefined, { OPENAI_API_KEY: 'sk-example' })).toMatchObject({
      scope: 'custom',
      service: 'custom',
      label: 'openai',
      credentialData: { OPENAI_API_KEY: 'sk-example' },
    });
  });

  it('matches existing custom daemon credentials by mapped label instead of colliding all custom services', () => {
    const existing = [
      { id: 'twitter', scope: 'custom', service: 'custom', label: 'X API (x-twitter)' },
      { id: 'openai', scope: 'custom', service: 'custom', label: 'openai' },
    ];

    expect(findMatchingDaemonCredential(existing, 'x-twitter', 'X API')?.id).toBe('twitter');
    expect(findMatchingDaemonCredential(existing, 'openai')?.id).toBe('openai');
  });

  it('matches a labeled custom credential when later updated by service name only', () => {
    const existing = [
      { id: 'twitter', scope: 'custom', service: 'custom', label: 'X API (x-twitter)' },
    ];

    expect(findMatchingDaemonCredential(existing, 'x-twitter')?.id).toBe('twitter');
  });

  it('matches multi-instance closed scopes by label instead of first scope match', () => {
    const existing = [
      { id: 'staging', scope: 'kubeconfig', service: 'kubeconfig', label: 'Staging cluster' },
      { id: 'prod', scope: 'kubeconfig', service: 'kubeconfig', label: 'Production cluster' },
      { id: 'vault-prod', scope: 'vault-token', service: 'vault-token', label: 'Production vault' },
    ];

    expect(findMatchingDaemonCredential(existing, 'kubeconfig', 'Production cluster')?.id).toBe('prod');
    expect(findMatchingDaemonCredential(existing, 'kubeconfig', 'Missing cluster')).toBeUndefined();
    expect(findMatchingDaemonCredential(existing, 'vault-token', 'Production vault')?.id).toBe('vault-prod');
  });

  it('matches promoted kubeconfig/vault-token credentials from legacy custom labels without colliding labels', () => {
    const existing = [
      { id: 'legacy-staging', scope: 'custom', service: 'custom', label: 'Staging cluster (kubeconfig)' },
      { id: 'legacy-prod', scope: 'custom', service: 'custom', label: 'Production cluster (kubeconfig)' },
      { id: 'legacy-vault', scope: 'custom', service: 'custom', label: 'Production vault (vault-token)' },
      { id: 'legacy-service-dev', scope: 'custom', service: 'kubeconfig', label: 'Dev cluster' },
    ];

    expect(findMatchingDaemonCredential(existing, 'kubeconfig', 'Production cluster')?.id).toBe('legacy-prod');
    expect(findMatchingDaemonCredential(existing, 'kubeconfig', 'Staging cluster')?.id).toBe('legacy-staging');
    expect(findMatchingDaemonCredential(existing, 'kubeconfig', 'Dev cluster')?.id).toBe('legacy-service-dev');
    expect(findMatchingDaemonCredential(existing, 'kubeconfig', 'Missing cluster')).toBeUndefined();
    expect(findMatchingDaemonCredential(existing, 'vault-token', 'Production vault')?.id).toBe('legacy-vault');
  });


  it('does not match unrelated custom credentials that only share a promoted scope label', () => {
    const existing = [
      { id: 'unrelated-custom', scope: 'custom', service: 'custom', label: 'Production cluster' },
      { id: 'legacy-prod', scope: 'custom', service: 'custom', label: 'Production cluster (kubeconfig)' },
      { id: 'legacy-service-prod', scope: 'custom', service: 'kubeconfig', label: 'Production cluster' },
    ];

    expect(findMatchingDaemonCredential([existing[0]!], 'kubeconfig', 'Production cluster')).toBeUndefined();
    expect(findMatchingDaemonCredential(existing, 'kubeconfig', 'Production cluster')?.id).toBe('legacy-prod');
    expect(findMatchingDaemonCredential([existing[0]!, existing[2]!], 'kubeconfig', 'Production cluster')?.id)
      .toBe('legacy-service-prod');
  });

  it('surfaces daemon validation failures as explicit non-persistence errors', () => {
    expect(formatDaemonCredentialPersistError('Persist credential', 400, { error: 'Unknown AgentCredential scope: x-twitter' }))
      .toContain('Persist credential failed with HTTP 400: Unknown AgentCredential scope: x-twitter');
  });
});
