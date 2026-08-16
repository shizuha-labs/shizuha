/**
 * Built-in plugin profiles (DeepSeek harness idea, without Cordis).
 *
 * Shizuha Code ships TUI + dashboard + harness. The Hive/k3s actuator
 * lives in Origin `shizuha-labs/hive-runtime`, not this tree. `fleet`
 * remains a recognized profile id so existing SHIZUHA_PROFILE=fleet /
 * k8s-daemon env still resolve, but it mounts the same rows as `default`.
 * Disk plugins (~/.shizuha/plugins) still load through PluginLoader.
 *
 * Resolve order:
 *   1. SHIZUHA_PROFILE=default|fleet
 *   2. k8s fleet daemon env (SHIZUHA_DAEMON_RUNTIME / RUNTIME_BACKEND / FLEET_NAMESPACE)
 *   3. default
 */

export const PROFILE_IDS = ['default', 'fleet'] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export interface BuiltinPluginRow {
  id: string;
  title: string;
  description: string;
  /** `*` = every profile. Otherwise only the listed profiles mount the row. */
  profiles: '*' | readonly ProfileId[];
}

export const BUILTIN_PLUGIN_ROWS: readonly BuiltinPluginRow[] = [
  {
    id: 'tui',
    title: 'Terminal UI',
    description: 'Interactive `shizuha` TUI',
    profiles: '*',
  },
  {
    id: 'dashboard',
    title: 'Browser dashboard',
    description: '`shizuha up` serves src/web on :8015',
    profiles: '*',
  },
  {
    id: 'harness',
    title: 'Agent harness',
    description: 'exec / resume / gateway / provider bridges',
    profiles: '*',
  },
];

export interface ComposedPluginTree {
  profile: ProfileId;
  source: 'env' | 'k8s-daemon' | 'default';
  mounted: BuiltinPluginRow[];
  available: BuiltinPluginRow[];
}

function isProfileId(value: string): value is ProfileId {
  return (PROFILE_IDS as readonly string[]).includes(value);
}

export function resolveProfile(
  env: NodeJS.ProcessEnv = process.env,
): { profile: ProfileId; source: ComposedPluginTree['source'] } {
  const explicit = (env['SHIZUHA_PROFILE'] ?? '').trim().toLowerCase();
  if (isProfileId(explicit)) return { profile: explicit, source: 'env' };
  const k8sDaemon =
    env['SHIZUHA_DAEMON_RUNTIME'] === 'k8s'
    || env['SHIZUHA_RUNTIME_BACKEND'] === 'k8s'
    || Boolean(env['SHIZUHA_FLEET_NAMESPACE']);
  if (k8sDaemon) return { profile: 'fleet', source: 'k8s-daemon' };
  return { profile: 'default', source: 'default' };
}

function rowMounted(row: BuiltinPluginRow, profile: ProfileId): boolean {
  return row.profiles === '*' || row.profiles.includes(profile);
}

export function isBuiltinPluginEnabled(
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const { profile } = resolveProfile(env);
  const row = BUILTIN_PLUGIN_ROWS.find((candidate) => candidate.id === id);
  if (!row) return false;
  return rowMounted(row, profile);
}

export function composePluginTree(
  env: NodeJS.ProcessEnv = process.env,
): ComposedPluginTree {
  const { profile, source } = resolveProfile(env);
  return {
    profile,
    source,
    mounted: BUILTIN_PLUGIN_ROWS.filter((row) => rowMounted(row, profile)),
    available: BUILTIN_PLUGIN_ROWS.filter((row) => !rowMounted(row, profile)),
  };
}

export function formatPluginTree(tree: ComposedPluginTree): string {
  const lines = [
    `profile: ${tree.profile} (${tree.source})`,
    'mounted:',
    ...tree.mounted.map((row) => `  - ${row.id}  ${row.title}`),
  ];
  if (tree.available.length > 0) {
    lines.push('available (not in this profile):');
    lines.push(...tree.available.map((row) => `  - ${row.id}  ${row.title}`));
  }
  return `${lines.join('\n')}\n`;
}
