/**
 * Agent template type definitions.
 *
 * Templates use YAML frontmatter + Markdown body in TEMPLATE.md files,
 * mirroring the SKILL.md format. The frontmatter contains agent config
 * defaults; the markdown body becomes the agent's contextPrompt.
 */

/** Parsed agent template definition. */
export interface AgentTemplate {
  /** Template identifier (from frontmatter `name` or directory name) */
  name: string;
  /** One-line description */
  description: string;
  /** Search/filter tags */
  tags: string[];
  /** Template category (e.g., "social-media", "devops", "security") */
  category?: string;
  /** System requirements (e.g., ["google-chrome-stable", "xvfb", "gpu"]) */
  requires?: string[];
  /** Template author */
  author?: string;
  /** Template version */
  version?: string;
  /** Path to TEMPLATE.md file */
  contentPath: string;
  /** Root directory of the template */
  templateRoot: string;
  /** Where the template was loaded from */
  source: TemplateSource;

  // ── Agent config defaults (applied when creating from this template) ──

  role?: string;
  executionMethod?: string;
  runtimeEnvironment?: string;
  model?: string;
  effort?: string;
  thinking?: string;
  skills?: string[];
  personalityTraits?: Record<string, string>;
  modelOverrides?: Record<string, string>;
  modelFallbacks?: Array<{
    method: string;
    model: string;
    reasoningEffort?: string;
    thinkingLevel?: string;
  }>;
  mcpServers?: string[];
  extraDockerArgs?: string[];
  extraVolumes?: Array<{ host: string; container: string; mode?: string }>;

  /** The markdown body — becomes agent's contextPrompt. Loaded lazily. */
  contextPrompt?: string;
}

export type TemplateSource = 'project' | 'user' | 'bundled';

/** Serialized template for API/dashboard responses. */
export interface TemplateInfo {
  name: string;
  description: string;
  tags: string[];
  category?: string;
  requires?: string[];
  author?: string;
  version?: string;
  role?: string;
  executionMethod?: string;
  model?: string;
  skills?: string[];
}
