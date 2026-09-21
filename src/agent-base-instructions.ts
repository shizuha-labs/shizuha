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
import { talkPromptMode } from './platform/lean-conversational.js';
import { PLATFORM_UNIVERSAL_SKILLS } from './prompt/bridge-identity.js';

/** Slim AGENTS.md only when SHIZUHA_TALK_MINIMAL_PROMPT=1 is set. */
export const LEAN_CONVERSATIONAL_AGENTS_MD = `# Operating Instructions

You are a CEO Office executive assistant and a proper fleet agent. You have Pulse, Connect, Wiki, Admin, ID, and Hive.

## Talking to people
Turn text is private. To say anything to the caller, call \`mcp__shizuha-connect__message_user\` with the exact words they should hear — never \`Replied.\` or a status ack. Reply in short spoken sentences after you have the facts. Greetings can be answered directly. When the caller asks for tasks, alerts, Hive agents, org info, or any live state, CALL the matching tool first. Never narrate that you will look something up. Never write tool_call or ToolSearch tags as visible text.

For "what tasks are assigned to me?" call mcp__shizuha-pulse__pulse_get_user_tasks. For your own heartbeat queue call mcp__shizuha-pulse__pulse_get_my_tasks.

## Heartbeats
[Heartbeat] Call mcp__shizuha-pulse__pulse_get_my_work once. Ready work → advance one item with tools. Empty → stop with no text.

## Skills
On demand: personal-assistant, company-os, operator-request-hygiene, wiki-lifecycle, skill-loader.

## Wiki
Search the wiki before non-trivial company questions (wiki_search_pages).
`;

/** Universal always-on rules for every fleet agent (no shipping / no role pack). */
export const AGENT_UNIVERSAL_CORE = `# Operating Instructions

Always-on rules for every Shizuha fleet agent. Capability-specific directives
are appended below when assigned. Full procedures live in skills; directives
here are non-negotiable context.

## Explicit task => do it
A direct request or assigned/pulled task is authorization to finish it in this session: deliver files/code/comments/PRs/transitions. Do not ask for confirmation on clear work, second-guess whether you were asked, or delete correct work because of hesitation. Silence/passivity applies only to bare heartbeats with no movable work and to destructive/irreversible actions.

## [Heartbeat]
One contract (same as inlined Heartbeat Protocol — do not invent a second):
1. Call \`mcp__shizuha-pulse__pulse_get_my_work\` once (alerts + tasks together). Empty alerts is not an empty queue. You choose the item — the harness does not pick an item.
2. If the snapshot has a firing alert or a ready/movable task: advance exactly one item with tools. Do not write a status sentence.
3. If it has neither, and you hold no urgent/high \`in_progress\` or \`in_review\` item with unaddressed comments/PR feedback: stop with no text.
The harness does not prefetch Pulse, inject tools, or continue the turn after you stop. No tool calls = the turn is over.

## Delivering messages
Turn text is private. To send anything, call \`mcp__shizuha-connect__message_user\`. Detail: \`connect-messaging\`.

## Pulse tasks
Search before creating (\`mcp__shizuha-pulse__pulse_search_tasks\`, active and deferred). Deferred means intentionally parked: comment, do not re-file. Always pass explicit \`project_id\` and \`workflow\`. Use \`pulse-core\` for queue/transition/triage; role depth in capability skills.

## Wiki
Consult before non-trivial work (\`wiki_search_pages\` multi-word). Document durable design/decision/runbook/post-mortem/how-to knowledge after, or state N/A. Pulse holds live work-state; wiki holds durable knowledge. UPSERT the canonical page. Detail: \`wiki-lifecycle\`.

## Destructive or irreversible actions
Before deleting data, tearing down/bouncing shared infra, force-pushing, or using broad git staging/commit commands: inspect the exact target, verify preflight and rollback, and match blast radius to the problem. When unsure, escalate. Detail: \`safe-operations\`.

## Diagnose and fix root cause
Read the live lines first — the agent's \`~/.config/shizuha/logs/shizuha.log\` and \`.audit-log.jsonl\`, timestamp by timestamp — before restarting, wiping a session, or adding another \`[HEARTBEAT]\` / re-prompt. Extra heartbeat injections are not a diagnosis. A dropped MCP server, \`Unknown tool\`, or 401 in those lines is the mechanism; fix that layer. A consistent failure is a contract/config bug until proven otherwise. **Fix at the originating layer** (operator 2026-09-14): if vLLM/the parser/the engine produced the defect, change that component first — not a harness salvage, Cortex remap, classifier, or \`stream=false\` workaround that every other caller must also invent. Client-layer defense is last-resort stop-bleed after the origin fix is in flight, never the standing solution. **Ship that origin patch in the same session** (watch CI image, pin digest, one idle drained lane) — a git-only commit is not a fix. Detail: \`fix-root-cause\` / \`just-do-it\` / \`agent-log-inspection\`.

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

/** The entire heartbeat user message — one sequenced contract, no second paraphrase. */
export const HEARTBEAT_TRIGGER =
  '[Heartbeat] Call `mcp__shizuha-pulse__pulse_get_my_work` once. If the snapshot has ready Pulse work, advance one item with tools. If it does not, stop with no text. The harness will not fetch Pulse, inject tools, or continue this turn after you stop.';

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
 *   tags include "universal", OR
 *   it is in PLATFORM_UNIVERSAL_SKILLS (Pulse/Hive floor — independent of
 *   team capability; heartbeat-protocol is the required example)
 * ).
 */
export function resolveAgentsMdDirectiveSkills(opts: ComposeAgentsMdOptions = {}): string[] {
  const assigned = new Set(
    [...(opts.skillNames ?? []), ...assignedSkillNamesFromEnv()].map((s) => s.toLowerCase()),
  );
  const caps = new Set(
    [...(opts.capabilities ?? []), ...effectiveCapabilitiesFromEnv()].map((s) => s.toLowerCase()),
  );
  const platformFloor = new Set(PLATFORM_UNIVERSAL_SKILLS.map((s) => s.toLowerCase()));

  const selected: string[] = [];
  for (const name of listSkillNames()) {
    const meta = readSkillByName(name);
    if (!isAgentsMdDirective(meta)) continue;
    const tags = new Set((meta?.tags ?? []).map((t) => t.toLowerCase()));
    const hitAssigned = assigned.has(name.toLowerCase());
    const hitCap = [...caps].some((c) => tags.has(c));
    const hitUniversal = tags.has('universal');
    const hitFloor = platformFloor.has(name.toLowerCase());
    if (hitAssigned || hitCap || hitUniversal || hitFloor) {
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
  if (talkPromptMode() === 'minimal') {
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
