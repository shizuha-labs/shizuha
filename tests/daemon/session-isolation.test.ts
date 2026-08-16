import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const managerSource = fs.readFileSync(path.join(process.cwd(), 'src/daemon/manager.ts'), 'utf-8');
const codexBridgeSource = fs.readFileSync(path.join(process.cwd(), 'src/codex-bridge/index.ts'), 'utf-8');
const claudeBridgeSource = fs.readFileSync(path.join(process.cwd(), 'src/claude-bridge/index.ts'), 'utf-8');

describe('PLAT-86 agent session mount isolation', () => {
  // NOTE: coordinator-backed Codex agents get a fully private CODEX_HOME and
  // access-only broker cache. The shared auth directory exists only for explicit
  // standalone/headless compatibility. Gemini and Claude stay fully per-agent.
  it('isolates Codex/Gemini/Claude session state per agent (private homes, no host-global mounts)', () => {
    // Per-agent private session dirs (not shared host homes).
    expect(managerSource).toContain("'.shizuha', 'codex-home', agent.username");
    expect(managerSource).toContain("'.shizuha', 'gemini-sessions', agent.username");
    expect(managerSource).toContain("'.shizuha', 'claude-sessions', agent.username");
    // Per-agent Codex overlays — sessions/config are private to the agent.
    expect(managerSource).toContain('`${perAgentSessions}:/home/agent/.codex/sessions`');
    expect(managerSource).toContain('`${perAgentConfig}:/home/agent/.codex/config.toml`');
    // Gemini home is per-agent.
    expect(managerSource).toContain('`${perAgentGeminiDir}:/home/agent/.gemini`');
    // The host's own ~/.gemini is never mounted into a container.
    expect(managerSource).not.toContain('`${hostGeminiDir}:/home/agent/.gemini`');
  });

  it('keeps host Codex credentials out of coordinator-backed agent containers', () => {
    expect(managerSource).toContain('if (coordinatorConfigured) {');
    expect(managerSource).toContain('`${agentCodexDir}:/home/agent/.codex`');
    expect(managerSource).toContain('!coordinatorConfigured && fs.existsSync');
    expect(managerSource).toContain("path.join(shizuhaHome, '.codex')");
    expect(managerSource).toContain("path.join(shizuhaHome, '.shizuha', 'codex-auth')");
    expect(managerSource).toContain("path.join(shizuhaHome, '.shizuha', 'credentials.json')");
    expect(managerSource).toContain("'/home/agent/.codex'");
    expect(managerSource).toContain("'/root/.shizuha/credentials.json'");
    // Standalone mode may still share a directory for atomic auth refresh.
    expect(managerSource).toContain("'.shizuha', 'codex-auth'");
    expect(managerSource).toContain('`${sharedCodexDir}:/home/agent/.codex`');
    // Private-by-default permissions — never world-readable/writable.
    expect(managerSource).toContain('function ensurePrivateDir(dir: string, containerAgentOwned = false): void');
    expect(managerSource).toContain('ensurePrivateFileForContainerAgent');
    expect(managerSource).not.toContain('0o777');
    expect(managerSource).not.toContain('0o666');
    // Remapped container-agent ownership is honored.
    expect(managerSource).toContain('SHIZUHA_CONTAINER_AGENT_UID');
    expect(managerSource).toContain('ensurePrivateDir(claudeSessionDir');
  });

  it('propagates safe Gemini settings on each launch without remounting host-global session state', () => {
    expect(managerSource).toContain("path.join(hostGeminiDir, 'settings.json')");
    expect(managerSource).toContain("path.join(perAgentGeminiDir, 'settings.json')");
    expect(managerSource).toContain('fs.copyFileSync(hostGeminiSettings, perAgentGeminiSettings)');
    expect(managerSource).not.toContain('fs.statSync(perAgentGeminiSettings).size === 0');
    expect(managerSource).toContain('ensurePrivateFileForContainerAgent(perAgentGeminiSettings)');
    expect(managerSource).not.toContain('`${hostGeminiDir}:/home/agent/.gemini`');
  });

  it('keeps private mounts usable outside DinD without relaxing permissions', () => {
    expect(managerSource).toContain('const NON_DIND_ENTRYPOINT');
    expect(managerSource).toContain('SHIZUHA_CONTAINER_AGENT_UID');
    expect(managerSource).toContain('SHIZUHA_CONTAINER_AGENT_GID');
    expect(managerSource).toContain('runuser -u agent can still traverse those private mounts');
    expect(managerSource).toContain('--entrypoint\', NON_DIND_ENTRYPOINT_CONTAINER');
    expect(managerSource).toContain('const useNonDindNumericUser = !(useDind && hasDindImage) && runtime === \'sandbox\'');
    expect(managerSource).toContain('--user\', `${containerAgentUid()}:${containerAgentGid()}`');
  });

  it('honors remapped container agent IDs in Codex bridge ownership fixups', () => {
    expect(codexBridgeSource).toContain('SHIZUHA_CONTAINER_AGENT_UID');
    expect(codexBridgeSource).toContain('SHIZUHA_CONTAINER_AGENT_GID');
    expect(codexBridgeSource).toContain('function chownForContainerAgent');
    expect(codexBridgeSource).toContain('execFileSync(\'chown\', args');
    expect(codexBridgeSource).not.toContain('chown -R 1000:1000 ${agentCodexDir}');
    expect(codexBridgeSource).not.toContain('chown 1000:1000 ${agentAuthFile}');
  });

  it('honors remapped container agent IDs in Claude bridge ownership fixups', () => {
    expect(claudeBridgeSource).toContain('SHIZUHA_CONTAINER_AGENT_UID');
    expect(claudeBridgeSource).toContain('SHIZUHA_CONTAINER_AGENT_GID');
    expect(claudeBridgeSource).toContain('function chownForContainerAgent');
    expect(claudeBridgeSource).toContain('fs.chownSync(homeDir, targetUid, targetGid)');
    expect(claudeBridgeSource).toContain('fs.chownSync(workDir, targetUid, targetGid)');
    expect(claudeBridgeSource).not.toContain('const targetUid = 1000');
    expect(claudeBridgeSource).not.toContain('const targetGid = 1000');
    expect(claudeBridgeSource).not.toContain('chown -R 1000:1000 ${claudeDir}');
  });
});
