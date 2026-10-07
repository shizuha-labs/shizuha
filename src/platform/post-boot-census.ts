export interface CensusProbe {
  name: string;
  ok: boolean;
  detail: string;
}

export function censusRepoVisibility(
  expected: readonly string[],
  visible: ReadonlySet<string>,
): CensusProbe[] {
  return expected
    .map((repo) => repo.trim())
    .filter(Boolean)
    .map((repo) => ({
      name: `repo:${repo}`,
      ok: visible.has(repo),
      detail: visible.has(repo) ? 'visible' : 'missing',
    }));
}

export function censusNames(
  kind: string,
  expected: readonly string[],
  live: ReadonlySet<string>,
): CensusProbe[] {
  return expected
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({
      name: `${kind}:${name}`,
      ok: live.has(name),
      detail: live.has(name) ? 'present' : 'missing',
    }));
}

export function formatCensusAlarm(probes: readonly CensusProbe[]): string | null {
  const missing = probes.filter((probe) => !probe.ok);
  if (missing.length === 0) return null;
  return `post-boot access drift: ${missing.map((probe) => probe.name).join(', ')}`;
}

export function parseCsv(value: string | undefined): string[] {
  return (value ?? '').split(',').map((part) => part.trim()).filter(Boolean);
}

export async function confirmedVisibleRepos(
  expected: readonly string[],
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const injected = new Set(parseCsv(env.SHIZUHA_VISIBLE_REPOS));
  if (injected.size > 0 || !env.SHIZUHA_ORIGIN_API || !env.FORGEJO_TOKEN) return injected;
  const visible = new Set<string>();
  for (const repo of expected) {
    try {
      const response = await fetchImpl(`${env.SHIZUHA_ORIGIN_API.replace(/\/$/, '')}/api/v1/repos/${repo}`, {
        headers: { Authorization: `token ${env.FORGEJO_TOKEN}` },
      });
      if (response.status !== 404) visible.add(repo);
    } catch {
      visible.add(repo);
    }
  }
  return visible;
}

export async function runPostBootAccessCensus(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const expectedRepos = parseCsv(env.SHIZUHA_EXPECTED_REPOS);
  const visible = await confirmedVisibleRepos(expectedRepos, env, fetchImpl);
  const expectedTools = parseCsv(env.SHIZUHA_EXPECTED_TOOLS);
  const liveTools = new Set(parseCsv(env.SHIZUHA_LIVE_TOOLS));
  const probes = [
    ...censusRepoVisibility(expectedRepos, visible),
    ...censusNames('tool', expectedTools, liveTools),
    ...censusNames('primitive', parseCsv(env.SHIZUHA_EXPECTED_PRIMITIVES), new Set([
      env.SHIZUHA_LIST_AGENTS_OK === '1' ? 'list_agents' : '',
      env.CI_LOGS_BEARER || env.SHIZUHA_CI_LOGS_BEARER ? 'ci-logs' : '',
      env.CONNECT_URL || env.SHIZUHA_CONNECT_URL ? 'connect-auth' : '',
    ].filter(Boolean))),
  ];
  return formatCensusAlarm(probes);
}
