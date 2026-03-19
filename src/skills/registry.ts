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
   */
  buildCatalog(): string {
    const modelInvocable = this.listModelInvocable();
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
