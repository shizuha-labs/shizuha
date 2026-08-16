import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FleetSshCredentialGrant } from './agent-credential.js';
import { recordFleetSshGrantStagedAuditEvent } from './credential-audit.js';
import type { AgentInfo } from './types.js';

const DEFAULT_FLEET_SSH_KEY_FILES = ['id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub', 'known_hosts', 'config'] as const;

export interface FleetSshStageResult {
  hostSshDir: string;
  sshStageDir: string;
  mounted: number;
}

export interface FleetSshStageOptions {
  agent: Pick<AgentInfo, 'id' | 'username'>;
  grant: FleetSshCredentialGrant;
  shizuhaHome: string;
  recordAuditEvent: (event: Record<string, unknown>) => void;
  expandHomePath?: (value: string) => string;
}

function isPrivateSshFile(fileName: string): boolean {
  return !fileName.endsWith('.pub') && fileName !== 'known_hosts' && fileName !== 'config';
}

export function stageFleetSshCredentialGrant(options: FleetSshStageOptions): FleetSshStageResult | null {
  const sshStageDir = path.join(options.shizuhaHome, '.shizuha', 'ssh-keys', options.agent.username);
  const keyFiles = options.grant.keyFiles?.length ? options.grant.keyFiles : [...DEFAULT_FLEET_SSH_KEY_FILES];

  const explicitSource = options.grant.sshDir
    ? (options.expandHomePath ?? ((value: string) => value))(options.grant.sshDir)
    : undefined;

  // Canonical source resolution (PLAT-194):
  //   - An explicit grant.sshDir is honored AS-IS — never masked by stale staged
  //     keys. If the explicit source is empty/unmounted, staging fails (and the
  //     caller fails loud), so key rotation/removal at that source is respected.
  //   - A grant with NO explicit sshDir falls back to the legacy ~/.ssh default;
  //     it must NOT reuse the per-agent store, since revoking a grant only marks
  //     it inactive (staged keys persist) and reusing them would serve stale keys.
  //   - Legacy ~/.ssh is the last resort (host-side daemon only).
  // Host-plane grants point sshDir at the per-agent store explicitly, so they take
  // the first branch and resolve to the mounted, populated store.
  let hostSshDir: string;
  if (explicitSource) {
    hostSshDir = explicitSource;
  } else {
    hostSshDir = path.join(options.shizuhaHome, '.ssh');
  }

  // When the resolved source IS the stage dir, the keys are already in place —
  // copying a file onto itself would truncate it, and the error-path rmSync would
  // destroy the master store. Stage-in-place: just (re)assert perms and mount.
  const sourceIsStage = path.resolve(hostSshDir) === path.resolve(sshStageDir);

  const filesToStage = keyFiles
    .map((fileName) => ({
      fileName,
      src: path.join(hostSshDir, fileName),
      dst: path.join(sshStageDir, fileName),
      mode: isPrivateSshFile(fileName) ? 0o600 : 0o644,
    }))
    .filter((file) => fs.existsSync(file.src));

  // Require at least one PRIVATE key — known_hosts/config/.pub alone cannot
  // authenticate, and mounting only those would suppress the caller's fail-loud
  // path while SSH auth still fails.
  if (!filesToStage.some((file) => isPrivateSshFile(file.fileName))) return null;

  try {
    fs.mkdirSync(sshStageDir, { recursive: true, mode: 0o700 });
    for (const file of filesToStage) {
      if (!sourceIsStage) fs.copyFileSync(file.src, file.dst);
      fs.chmodSync(file.dst, file.mode);
    }
    recordFleetSshGrantStagedAuditEvent(
      options.recordAuditEvent,
      options.agent,
      options.grant,
      filesToStage.length,
    );
  } catch (err) {
    // Never delete the stage dir when it is itself the source of truth.
    if (!sourceIsStage) fs.rmSync(sshStageDir, { recursive: true, force: true });
    throw err;
  }

  return { hostSshDir, sshStageDir, mounted: filesToStage.length };
}
