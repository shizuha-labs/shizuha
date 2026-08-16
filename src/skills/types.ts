/**
 * Skill type definitions.
 *
 * Compatible with Claude Code, OpenClaw, and Hermes skill formats.
 * All use YAML frontmatter + Markdown body in SKILL.md files.
 */

/** Parsed skill definition. */
export interface Skill {
  /** Skill identifier (from frontmatter `name` or directory name) */
  name: string;
  /** One-line description — used by LLM to decide when to invoke */
  description: string;
  /** The markdown body (prompt content) — loaded lazily on invocation */
  contentPath: string;
  /** Root directory of the skill (for resolving relative references) */
  skillRoot: string;
  /** Where the skill was loaded from */
  source: SkillSource;

  // ── Optional frontmatter fields ──

  /** Model override for this skill (e.g., "sonnet", "opus") */
  model?: string;
  /** Execution context: "fork" for sub-agent, undefined for inline */
  context?: 'fork';
  /** Tools this skill is allowed to use (empty = all tools allowed) */
  allowedTools?: string[];
  /** Whether users can invoke this via /skill-name (default: true) */
  userInvocable: boolean;
  /** If true, LLM cannot invoke via the Skill tool */
  disableModelInvocation: boolean;
  /** Hint text for arguments (e.g., "[message]") */
  argumentHint?: string;
  /** When to use this skill (metadata for LLM) */
  whenToUse?: string;
  /** Skill version */
  version?: string;
  /** Hook definitions attached to this skill */
  hooks?: SkillHooks;

  /**
   * `roles:` frontmatter — audience targeting (PLAT-458 §3.2). Each entry is
   * matched against BOTH the agent's role AND team (OR semantics, P3-B), so a
   * list can scope a skill to a role (`engineer`) or a team (`devops`).
   * ABSENT/empty ⇒ universal (every agent), preserving today's behavior.
   */
  roles?: string[];
  /**
   * `starred: true` ⇒ eager-load default (always surfaced/inlined). Absent ⇒
   * catalog-visible + loaded on use. Eager-loading itself is handled by the
   * daemon's loadStarredSkills path; this flag carries the skill's intent
   * through to registry/catalog consumers.
   */
  starred?: boolean;
}

export type SkillSource =
  | 'project'    // .shizuha/skills/ or .claude/commands/
  | 'user'       // ~/.shizuha/skills/ or ~/.claude/commands/
  | 'bundled';   // Built-in skills shipped with shizuha

/** Hooks that can be defined in skill frontmatter. */
export interface SkillHooks {
  PreToolUse?: SkillHookEntry[];
  PostToolUse?: SkillHookEntry[];
  Notification?: SkillHookEntry[];
  Stop?: SkillHookEntry[];
}

export interface SkillHookEntry {
  matcher: string;
  command: string;
  once?: boolean;
}

/** Result of invoking a skill. */
export interface SkillInvocationResult {
  /** Whether the skill was found and executed */
  success: boolean;
  /** Skill name */
  skillName: string;
  /** Execution mode */
  mode: 'inline' | 'forked';
  /** The prompt content that was injected (inline mode) */
  prompt?: string;
  /** Tools restricted to (if skill specifies allowed-tools) */
  allowedTools?: string[];
  /** Model override (if skill specifies model) */
  model?: string;
}
