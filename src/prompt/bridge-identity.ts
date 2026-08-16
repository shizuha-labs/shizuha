import { listSkillNames, readSkillByName } from '../skills/frontmatter.js';
import { skillMatchesAudience } from '../skills/registry.js';
import { AGENT_POLICY } from './templates.js';

/** Fields the identity prompt needs — not the full fleet AgentInfo. */
export type BridgeIdentityAgent = {
  name: string;
  username: string;
  role?: string | null;
  team?: string | null;
  skills?: string[];
  eagerSkills?: string[];
  personalityTraits?: Record<string, unknown>;
  effectiveCapabilities?: {
    source?: string;
    skills?: string[];
    eagerSkills?: string[];
    capabilities?: string[];
    sourceTeams?: string[];
    mcpServers?: string[];
    diagnostics?: Array<{ severity?: string; code?: string; message?: string }>;
    catalogVersion?: string | number;
  } | null;
};

/**
 * Keep in sync with PLATFORM_UNIVERSAL_SKILLS in daemon/manager.ts — these are
 * eager-loaded for every agent regardless of per-agent `skills` config.
 */
export const PLATFORM_UNIVERSAL_SKILLS = [
  'connect-messaging',    // every agent sends/receives DMs → must know the protocol
  'heartbeat-protocol',   // every agent receives heartbeats → must know silence-is-default
  'pulse-core',           // every agent receives task assignments → must advance state per workflow (lean core; role depth in the role skills below)
  'skill-loader',         // LOAD relevant skills before acting; where to find them (folder/git/wiki) — every operating rule is a skill (critical, inlined; operator 2026-06-24)
  'web-search',           // web-search current external facts before major/current/jurisdictional decisions; default India/IST operator context (critical, inlined; operator 2026-06-25)
  'skill-builder',        // every agent can CREATE/modify/re-tier skills; prefer reference, keep static context lean; "update CLAUDE.md / change behavior" = author a skill (critical, inlined; operator 2026-06-24)
  'wiki-lifecycle',       // CONSULT the wiki before any non-trivial action (gather info first), DOCUMENT durable knowledge after — every agent, by default (critical, inlined; operator 2026-06-24)
  'budget-discipline',    // operator budget cap (1 agent/team; no capacity growth; never re-enable a disabled agent) — critical, body inlined for every agent
  'session-stamina',      // one continuous session — keep working the queue to full quality; "session depth" is never a reason to stop/defer/do-less (critical, inlined)
  'defer-exposed-token-rotation', // credential/token rotation (incl. exposed/leaked) is auto-deferred until system stable — never raise/file/escalate/block on it (critical, inlined)
];



function trimOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildBridgeIdentityPrompt(
  agent: BridgeIdentityAgent,
  customPrompt?: string | null,
): string {
  const sections: string[] = [];
  const identityLines = [
    `You are ${agent.name}, a Shizuha agent.`,
    `Your username is ${agent.username}.`,
    agent.role ? `Your role is ${agent.role}.` : null,
    `You operate as a named Shizuha agent, not as the underlying CLI, model, bridge runtime, or provider.`,
    `When asked who you are, identify yourself as ${agent.name}${agent.role ? ` (${agent.role})` : ''}.`,
    `Do not present yourself as Claude Code, Codex, OpenClaw, GPT, Claude, or any other underlying runtime unless you are explicitly discussing implementation details.`,
  ].filter(Boolean);
  sections.push(`## Shizuha Agent Identity\n\n${identityLines.join('\n')}`);

  // Voice — how you talk to humans. This sits next to identity (not in the
  // skills section) because it's not optional knowledge; it's how your
  // output reaches anyone at all. The model otherwise defaults to plain
  // text replies and we lose the message.
  const voiceLines = [
    `## Your Voice — How You Talk to Users`,
    ``,
    `Your natural text output during a turn is private reasoning. It never reaches any user. It is not a reply.`,
    ``,
    `**The ONLY way to deliver words to a user (human or agent) is the \`mcp__shizuha-connect__message_user\` tool.** Every reply you want anyone to see MUST be a tool call.`,
    ``,
    `Inbound messages arrive prefixed with the sender's username:`,
    ``,
    `    [hritik] Hi ${agent.name}, please reply with the word: pong`,
    ``,
    `Your response to that is a tool call (NOT a text reply):`,
    ``,
    `    mcp__shizuha-connect__message_user(`,
    `      recipient_username="hritik",`,
    `      content="pong",`,
    `    )`,
    ``,
    `If you write \`pong\` as plain text in your turn, no human or agent will ever see it. The text vanishes.`,
    ``,
    `### After your tool call, STOP`,
    ``,
    `Once you've sent your reply via \`message_user\` (or decided no reply is needed), **end the turn immediately**. Do not produce a wrap-up. Do not summarize what you just did. Do not narrate "Escalated to Hritik" or "Acknowledged Kai's update" or "No action needed". The user already knows what you did because they will see the message you sent. Wrap-up text wastes tokens, pollutes the activity log, and makes you look like you're doing more than you are.`,
    ``,
    `**Examples of what NOT to do** (these are all turns that should have ended silently):`,
    ``,
    `    "Escalated to Hritik. The 'Verify Fixed' transition..." — Hritik already got the DM, don't recap`,
    `    "Acknowledged Kai's update — flagged AT-41 to Hritik" — same, you already messaged both`,
    `    "No action needed — Akira's message is an acknowledgment" — just end the turn`,
    `    "Standing by." — silence achieves the same thing without text`,
    ``,
    `### Silence is the default`,
    ``,
    `If a message warrants no reply (heartbeats, acknowledgments, status echoes, model artifacts, anything with no actionable content), do nothing. End the turn without text and without a tool call. Silence is the default; messages are the exception.`,
    ``,
    `For full details on the messaging protocol, see the \`connect-messaging\` skill (already loaded in your context).`,
  ];
  sections.push(voiceLines.join('\n'));

  // Soul — hard policy rules, always injected
  sections.push(AGENT_POLICY);

  // Skills section — four buckets, split by how much of the skill is
  // actually in the agent's context right now:
  //
  //   1. **Critical (body inlined below)**: `critical: true` frontmatter.
  //      Full SKILL.md body is appended to this prompt; must-read, must-obey.
  //      Used for correctness-critical procedures (workflow state machines,
  //      heartbeat handling, org-context discipline) where guessing from
  //      the description alone is unacceptable.
  //   2. **Auto-discoverable**: starred / universal skills that are NOT
  //      marked critical. Claude/Codex bridges mount these into native skill
  //      directories. Other bridges list the same name + description here;
  //      SCLI-219 makes `critical`, not `starred`, the inline-body bit.
  //   3. **Available on demand**: not starred/critical/universal. Name +
  //      description shown; provider-native skills load the body when selected.
  //   4. **Tags**: skills without a SKILL.md or without a description in
  //      frontmatter — name only.
  //
  // Skill metadata is read from ~/.shizuha/skills/<name>/SKILL.md frontmatter.
  // Actual body injection happens in manager.ts (loadStarredSkills inlines
  // only critical bodies for every bridge; provider bridges additionally mount
  // all skills for native discovery where the underlying CLI supports it).
  const configuredSkills = new Set(agent.skills ?? []);
  const eagerOverride = new Set(agent.eagerSkills ?? []);
  const mergedSkills = new Set<string>([
    ...listSkillNames(),
    ...configuredSkills,
    ...PLATFORM_UNIVERSAL_SKILLS,
    ...eagerOverride,
  ]);
  if (mergedSkills.size > 0) {
    const critical: string[] = [];      // body inlined below (inline-critical tier)
    const autoDiscover: string[] = [];  // mounted; name+desc in native system reminder
    const onDemand: string[] = [];      // name+desc here; provider-native loader reads body
    const tags: string[] = [];
    for (const skill of [...mergedSkills].sort()) {
      const meta = readSkillByName(skill);
      if (meta && !skillMatchesAudience(meta, agent.role, agent.team)) continue;
      const isPlatformUniversal = PLATFORM_UNIVERSAL_SKILLS.includes(skill);
      const isExplicit = configuredSkills.has(skill) || eagerOverride.has(skill);
      const isEager = isPlatformUniversal || isExplicit || (meta?.starred ?? false) || (meta?.critical ?? false);
      const isCritical = meta?.critical ?? false;
      if (!meta?.description) {
        // CI/local dev checkouts may not have the full /opt/skills tree
        // mounted. Platform-universal skills are still part of the prompt
        // contract, so surface their names even when frontmatter metadata is
        // unavailable.
        if (isExplicit || isPlatformUniversal) tags.push(skill);
        continue;
      }
      const line = `- **${skill}**: ${meta.description}`;
      if (isEager && isCritical) critical.push(line);
      else if (isEager) autoDiscover.push(line);
      else if (isExplicit) onDemand.push(line);
    }
    const lines: string[] = [];
    if (critical.length > 0) {
      lines.push('### Critical skills (full body inlined below in this prompt — you MUST follow them)\n');
      lines.push(...critical);
    }
    if (autoDiscover.length > 0) {
      lines.push((critical.length > 0 ? '\n' : '') + '### Auto-discoverable starred skills (description here; use your native skill mechanism to load body)\n');
      lines.push(...autoDiscover);
    }
    if (onDemand.length > 0) {
      lines.push((critical.length > 0 || autoDiscover.length > 0 ? '\n' : '') + '### Available on demand (use your native skill mechanism to load body)\n');
      lines.push(...onDemand);
    }
    if (tags.length > 0) {
      lines.push((critical.length > 0 || autoDiscover.length > 0 || onDemand.length > 0 ? '\n' : '') + '### Capabilities\n');
      lines.push(...tags.map(t => `- ${t}`));
    }
    if (lines.length > 0) {
      lines.push('\nUse provider-native skill discovery for additional skills beyond the ones listed here.');
      sections.push(`## Skills\n\n${lines.join('\n')}`);
    }
  }

  if (agent.effectiveCapabilities?.source === 'hive') {
    const effective = agent.effectiveCapabilities;
    const capabilities = effective.capabilities ?? [];
    const sourceTeams = effective.sourceTeams ?? [];
    const mcpServers = effective.mcpServers ?? [];
    const diagnostics = effective.diagnostics ?? [];
    const capLine = capabilities.length ? capabilities.join(', ') : 'none';
    const teamLine = sourceTeams.length ? sourceTeams.join(', ') : 'none';
    const mcpLine = mcpServers.length ? mcpServers.join(', ') : 'none';
    const diagLine = diagnostics
      .filter((d) => d.severity !== 'info')
      .map((d) => `${d.severity}:${d.code}`)
      .join(', ') || 'none';
    sections.push(`## Runtime Capabilities

Hive effective capabilities are applied by the fleet daemon. Catalog version: ${effective.catalogVersion ?? 'unknown'}. Source teams: ${teamLine}. Capabilities: ${capLine}. Enabled platform MCP services: ${mcpLine}. Diagnostics: ${diagLine}.`);
  }

  const traitEntries = Object.entries(agent.personalityTraits ?? {})
    .map(([key, value]) => {
      const k = String(key).trim();
      const v = Array.isArray(value) ? value.join(', ') : String(value ?? '').trim();
      return [k, v] as const;
    })
    .filter(([key, value]) => key && value)
    .sort(([a], [b]) => a.localeCompare(b));
  if (traitEntries.length > 0) {
    sections.push(`## Personality Traits\n\n${traitEntries.map(([key, value]) => `- ${key}: ${value}`).join('\n')}`);
  }

  const resolvedCustomPrompt = trimOrNull(customPrompt);
  if (resolvedCustomPrompt) {
    sections.push(`## Agent Instructions\n\n${resolvedCustomPrompt}`);
  }

  return sections.join('\n\n---\n\n');
}
