/**
 * Skill registry — stores loaded skills and provides lookup/invocation.
 */

import type { Skill, SkillInvocationResult } from './types.js';
import { loadSkillContent } from './loader.js';
import { logger } from '../utils/logger.js';

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  /** Register a skill. Later registrations with the same name are ignored (first wins). */
  register(skill: Skill): void {
    if (this.skills.has(skill.name)) return;
    this.skills.set(skill.name, skill);
  }

  /** Register multiple skills. */
  registerAll(skills: Skill[]): void {
    for (const skill of skills) {
      this.register(skill);
    }
  }

  /** Get a skill by name. */
  get(name: string): Skill | undefined {
    return this.skills.get(normalizeLookup(name));
  }

  /** Check if a skill exists. */
  has(name: string): boolean {
    return this.skills.has(normalizeLookup(name));
  }

  /** List all skills. */
  list(): Skill[] {
    return [...this.skills.values()];
  }

  /** List user-invocable skills (for /slash command display). */
  listUserInvocable(): Skill[] {
    return this.list().filter((s) => s.userInvocable);
  }

  /** List LLM-invocable skills (for the Skill tool). */
  listModelInvocable(): Skill[] {
    return this.list().filter((s) => !s.disableModelInvocation);
  }

  /** Number of registered skills. */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Invoke a skill by name.
   * Returns the prompt content and metadata for the caller to inject.
   */
  invoke(name: string, args?: string): SkillInvocationResult {
    const skill = this.get(name);
    if (!skill) {
      return {
        success: false,
        skillName: name,
        mode: 'inline',
      };
    }

    try {
      let prompt = loadSkillContent(skill);

      // Append arguments if provided
      if (args) {
        prompt = `${prompt}\n\nUser arguments: ${args}`;
      }

      logger.info({ skill: skill.name, source: skill.source }, 'Skill invoked');

      return {
        success: true,
        skillName: skill.name,
        mode: skill.context === 'fork' ? 'forked' : 'inline',
        prompt,
        allowedTools: skill.allowedTools,
        model: skill.model,
      };
    } catch (err) {
      logger.warn({ err, skill: skill.name }, 'Failed to load skill content');
      return {
        success: false,
        skillName: skill.name,
        mode: 'inline',
      };
    }
  }

  /**
   * Build a skill catalog for inclusion in the system prompt.
   * Short descriptions only — the full content is loaded on invocation.
   *
   * PLAT-458 §3.3 — role/team targeting. When `role`/`team` are supplied, a
   * skill is included iff it is universal (no `roles:`) OR its `roles:` list
   * intersects {role, team} (P3-B OR-semantics). NON-BREAKING DEFAULT: a no-arg
   * call (no role/team context) returns the full catalog exactly as before, so
   * un-updated call sites keep working and a partial rollout never starves an
   * agent of context. Role/team provenance is the agent's trusted Pulse
   * identity / config — never a self-asserted value.
   */
  buildCatalog(role?: string, team?: string, onlyNames?: readonly string[]): string {
    const allow = onlyNames && onlyNames.length > 0
      ? new Set(onlyNames.map((name) => name.toLowerCase()))
      : null;
    const modelInvocable = this.listModelInvocable()
      .filter((s) => skillMatchesAudience(s, role, team))
      .filter((s) => !allow || allow.has(s.name.toLowerCase()))
      // PLAT-4189: emit in a STABLE (name-sorted) order. This catalog is part of
      // the system prompt; any reordering across a process restart invalidates
      // the vLLM prefix cache for the entire session (system prompt + history)
      // and forces a full re-prefill. Sorting here guarantees the cache-critical
      // output is byte-identical regardless of skill registration/load order.
      .sort((a, b) => a.name.localeCompare(b.name));
    if (modelInvocable.length === 0) return '';

    const lines = modelInvocable.map((s) => {
      const hint = s.argumentHint ? ` ${s.argumentHint}` : '';
      return `- **${s.name}**${hint}: ${s.description}`;
    });

    return `## Available Skills

You can invoke skills using the \`skill\` tool. Skills are specialized prompts for common tasks.

${lines.join('\n')}`;
  }
}

function normalizeLookup(name: string): string {
  // Strip leading / (from slash commands)
  return name.replace(/^\//, '').toLowerCase().replace(/\s+/g, '-');
}

/**
 * Audience filter for the skill catalog (PLAT-458 §3.3).
 * - A skill with no `roles:` is universal → always included.
 * - A no-arg call (no role AND no team) is not filtering → full catalog (back-compat).
 * - Otherwise include iff the skill's `roles:` intersects {role, team} (P3-B OR-semantics,
 *   case-insensitive): one `roles:` list can scope by role (`engineer`) OR team (`devops`).
 */
export interface AudienceScopedSkill {
  roles?: string[];
}

function normalizeAudienceToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function skillMatchesAudience(skill: AudienceScopedSkill, role?: string | null, team?: string | null): boolean {
  if (!skill.roles || skill.roles.length === 0) return true;
  if (!role && !team) return true;
  const targets = [role, team]
    .filter((t): t is string => !!t)
    .map(normalizeAudienceToken);
  return skill.roles.some((r) => targets.includes(normalizeAudienceToken(r)));
}
