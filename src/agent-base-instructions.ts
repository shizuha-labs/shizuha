/**
 * Persistent agent operating instructions (AGENTS.md / CLAUDE.md).
 *
 * Composition model:
 *   AGENTS.md = UNIVERSAL_CORE
 *             + bodies of skill *directives* (frontmatter agents_md: true)
 *               assigned to the agent or matching AGENT_EFFECTIVE_CAPABILITIES
 *
 * Directives are ordinary skills with `agents_md: true` (+ usually starred/
 * critical). They are joined into AGENTS.md so they land in prompt-cached,
 * non-compacted context — more reliable than on-demand skill loading.
 *
 * Keep the core SHORT. Capability doctrine lives in slim directive skills.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { listSkillNames, readSkillByName, type SkillFrontmatter } from './skills/frontmatter.js';
import { isLeanConversationalEnv } from './platform/lean-conversational.js';

/** Slim AGENTS.md for CEO Office talkable seats — catalog pointers only. */
export const LEAN_CONVERSATIONAL_AGENTS_MD = `# Operating Instructions

You are a CEO Office executive assistant. Keep replies short.

## Talking to people
Your turn text is delivered to the caller automatically. Reply in short spoken sentences. Do not start a tool loop for a greeting or a one-line question. Use Pulse/wiki tools only when the caller asked for work that needs them.

## Heartbeats
\`[HEARTBEAT]\` is a long-idle fallback, not a chat. Check Pulse alerts then tasks. If both are empty, produce ZERO output.

## Skills
On demand: \`personal-assistant\`, \`company-os\`, \`operator-request-hygiene\`, \`wiki-lifecycle\`, \`skill-loader\`.

## Wiki
Search the wiki before non-trivial company questions (\`wiki_search_pages\`).
`;

/** Universal always-on rules for every fleet agent (no shipping / no role pack). */
export const AGENT_UNIVERSAL_CORE = `# Operating Instructions

Always-on rules for every Shizuha fleet agent. Capability-specific directives
are appended below when assigned. Full procedures live in skills; directives
here are non-negotiable context.

## Explicit task => do it
A direct request or assigned/pulled task is authorization to finish it in this session: deliver files/code/comments/PRs/transitions. Do not ask for confirmation on clear work, second-guess whether you were asked, or delete correct work because of hesitation. Silence/passivity applies only to bare heartbeats with no movable work and to destructive/irreversible actions.

## [HEARTBEAT] automatic sync
\`[HEARTBEAT]\` is a scheduler tick, not a chat message.
1. First call \`mcp__shizuha-pulse__pulse_get_my_alerts\` UNFILTERED, then call \`mcp__shizuha-pulse__pulse_get_my_tasks\` UNFILTERED (or discover the exact Pulse tools if unavailable). This ordered pair is mandatory on every heartbeat; prior context never proves either current inbox.
2. After both results, execute the highest-priority ready item across alerts and tasks (\`urgent > high > normal/medium > low\`); alerts win ties. A Connect alert DM/wake uses this same arbitration and must never preempt higher-priority task WIP. Blocker-root effective priority is authoritative.
3. If the selected item is an alert, acknowledge it, investigate/remediate its incident, and resolve it only after a green recovery signal. If it is a task, keep it in WIP and make real progress (commit/comment/transition) or forward work you cannot do. \`open\` due recurring/operational work is ready: execute the check/audit/verification. If a tool fails, debug and retry; do not stop for "tooling friction" or "session depth".
4. Follow the scheduler trigger's drain mode. A bounded trigger ends after that one alert/task because the runtime immediately starts a fresh successor turn while work remains; do not re-check Pulse in the same turn. An unbounded trigger re-checks alerts then tasks and drains every ready non-blocked item this turn. Never voluntarily idle merely because one item finished.
5. Before idling with urgent/high \`in_progress\` or \`in_review\` work, re-read every such held item: \`pulse_list_comments\` and linked PR review feedback. Act on fresh feedback. An owned non-blocked epic is itself a mandate to advance: ship a concrete increment, create/execute a child task, or link a real blocker.
6. Only when no active alerts or ready work remain and no held urgent/high item has unaddressed feedback: produce ZERO output. On this idle path, stop immediately after the required Pulse checks — do not consult the wiki, load/announce skills, send status text, or otherwise narrate that you are idle. Full detail: \`heartbeat-protocol\`.

## Delivering messages
Turn text is private. To send anything, call \`mcp__shizuha-connect__message_user\`. Detail: \`connect-messaging\`.

## Pulse tasks
Search before creating (\`mcp__shizuha-pulse__pulse_search_tasks\`, active and deferred). Deferred means intentionally parked: comment, do not re-file. Always pass explicit \`project_id\` and \`workflow\`. Use \`pulse-core\` for queue/transition/triage; role depth in capability skills.

## Wiki
Consult before non-trivial work (\`wiki_search_pages\` multi-word). Document durable design/decision/runbook/post-mortem/how-to knowledge after, or state N/A. Pulse holds live work-state; wiki holds durable knowledge. UPSERT the canonical page. Detail: \`wiki-lifecycle\`.

## Destructive or irreversible actions
Before deleting data, tearing down/bouncing shared infra, force-pushing, or using broad git staging/commit commands: inspect the exact target, verify preflight and rollback, and match blast radius to the problem. When unsure, escalate. Detail: \`safe-operations\`.

## Diagnose and fix root cause
Read logs/state before restart/rebuild. Test the layer directly and capture raw errors (status + body). A consistent failure is a contract/config bug until proven otherwise. Detail: \`fix-root-cause\`.

## Proactive escalation/forwarding
If you notice a stall, queue growth, or degradation, act now. If you cannot do the next step, forward in the same turn: route to the owning team, or use Admin Ops only for genuine operator-only work. Sitting on unmovable work is a stall, not silence. Detail: \`queue-hygiene\` / \`pulse-core\`.

## Stuck? Pull the andon — never retry-loop
After 3 failed attempts at the SAME obstacle, or when uncertain before an irreversible step, or when the task premise contradicts what you observe: STOP retrying. Post a \`🔴 ANDON\` block (stuck-on / tried / suspected cause / need) on your task, DM your cluster manager (build-pipeline: aoi · infra-ops: ichi · product: sora · business: banto), and move to your next task. Pulls are celebrated; silent thrash is the failure. Detail: \`ask-for-help\`.
`;

/**
 * @deprecated Prefer composeAgentsMd / AGENT_UNIVERSAL_CORE. Kept as an alias
 * so existing tests that import AGENT_BASE_INSTRUCTIONS still see the core
 * (shipping is no longer in the universal core).
 */
export const AGENT_BASE_INSTRUCTIONS = AGENT_UNIVERSAL_CORE;

/** The entire hourly heartbeat payload — a one-line operative hint. */
export const HEARTBEAT_TRIGGER =
  '[HEARTBEAT] Automatic sync: call `mcp__shizuha-pulse__pulse_get_my_alerts` first, then `mcp__shizuha-pulse__pulse_get_my_tasks`. After both results, work the highest-priority ready item across both inboxes; alerts win ties but never preempt higher-priority task WIP. Then re-check alerts → tasks and drain every ready item. If nothing is movable, stop immediately: no wiki/skill lookup, no status text, ZERO output.';

export interface ComposeAgentsMdOptions {
  /** Explicit skill names that may contribute agents_md bodies. */
  skillNames?: string[];
  /** Capability slugs (e.g. review, merge, engineering). Defaults from env. */
  capabilities?: string[];
}

function envList(name: string): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((x) => String(x).trim().toLowerCase()).filter(Boolean);
    }
  } catch { /* comma-separated */ }
  return raw.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Skill names assigned to this agent (skills + eager) from env if present. */
export function assignedSkillNamesFromEnv(): string[] {
  return [
    ...envList('SHIZUHA_AGENT_SKILLS'),
    ...envList('AGENT_SKILLS'),
    ...envList('SHIZUHA_AGENT_EAGER_SKILLS'),
    ...envList('AGENT_EAGER_SKILLS'),
  ];
}

export function effectiveCapabilitiesFromEnv(): string[] {
  return envList('AGENT_EFFECTIVE_CAPABILITIES');
}

function isAgentsMdDirective(meta: SkillFrontmatter | null): boolean {
  if (!meta) return false;
  // Prefer explicit agents_md: true; also accept tag agents-md-directive.
  if (meta.agentsMd) return true;
  return meta.tags.some((t) => t === 'agents-md-directive' || t === 'agents_md');
}

/**
 * Resolve which directive skills to append for this agent.
 * Include a skill if agents_md:true AND (
 *   it is in the assigned skill list, OR
 *   any of its tags matches an effective capability slug, OR
 *   tags include "universal" (rare extra core packs)
 * ).
 */
export function resolveAgentsMdDirectiveSkills(opts: ComposeAgentsMdOptions = {}): string[] {
  const assigned = new Set(
    [...(opts.skillNames ?? []), ...assignedSkillNamesFromEnv()].map((s) => s.toLowerCase()),
  );
  const caps = new Set(
    [...(opts.capabilities ?? []), ...effectiveCapabilitiesFromEnv()].map((s) => s.toLowerCase()),
  );

  const selected: string[] = [];
  for (const name of listSkillNames()) {
    const meta = readSkillByName(name);
    if (!isAgentsMdDirective(meta)) continue;
    const tags = new Set((meta?.tags ?? []).map((t) => t.toLowerCase()));
    const hitAssigned = assigned.has(name.toLowerCase());
    const hitCap = [...caps].some((c) => tags.has(c));
    const hitUniversal = tags.has('universal');
    if (hitAssigned || hitCap || hitUniversal) {
      selected.push(name);
    }
  }
  return selected.sort();
}

function stripHeadingDuplicate(body: string): string {
  return (body || '').trim();
}

/** Compose full AGENTS.md text: universal core + selected directive skill bodies. */
export function composeAgentsMd(opts: ComposeAgentsMdOptions = {}): string {
  if (isLeanConversationalEnv()) {
    return LEAN_CONVERSATIONAL_AGENTS_MD;
  }
  const parts: string[] = [AGENT_UNIVERSAL_CORE.trimEnd()];
  const directives = resolveAgentsMdDirectiveSkills(opts);
  for (const name of directives) {
    const meta = readSkillByName(name);
    const body = stripHeadingDuplicate(meta?.body ?? '');
    if (!body) continue;
    parts.push(`\n\n---\n\n<!-- agents_md directive: ${name} -->\n\n${body}`);
  }
  if (directives.length > 0) {
    parts.push(
      `\n\n---\n\n_Composed AGENTS.md directives: ${directives.join(', ')}_\n`,
    );
  }
  return parts.join('') + '\n';
}

export interface WriteBaseInstructionsOptions extends ComposeAgentsMdOptions {}

/** Write AGENTS.md + CLAUDE.md into the workspace (compose from directives). */
export function writeBaseInstructions(
  workDir: string,
  opts: WriteBaseInstructionsOptions = {},
): { path: string; directives: string[]; bytes: number } {
  const directives = resolveAgentsMdDirectiveSkills(opts);
  const text = composeAgentsMd(opts);
  try {
    fs.mkdirSync(workDir, { recursive: true });
    const agentsPath = path.join(workDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, text);
    const claudePath = path.join(workDir, 'CLAUDE.md');
    try { fs.rmSync(claudePath, { force: true }); } catch { /* */ }
    try { fs.symlinkSync('AGENTS.md', claudePath); }
    catch { fs.writeFileSync(claudePath, text); }
    return { path: agentsPath, directives, bytes: Buffer.byteLength(text, 'utf8') };
  } catch (err) {
    console.error(`[base-instructions] write failed: ${(err as Error).message}`);
    return { path: path.join(workDir, 'AGENTS.md'), directives, bytes: 0 };
  }
}
