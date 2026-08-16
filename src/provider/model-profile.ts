/**
 * Model profiles — per-model capabilities and preferences.
 *
 * The agent loop checks these to adapt its behavior per model.
 * For example, Qwen3-Coder-Next was agentically trained and prefers
 * minimal system prompts, while Claude/GPT need detailed behavioral instructions.
 *
 * Profiles are matched by model name substring (first match wins).
 * Unknown models get the DEFAULT profile.
 */

import { talkSeatDisablesThinking } from '../platform/lean-conversational.js';

export interface ModelProfile {
  /** Human-readable name for logs/dashboard */
  displayName: string;

  // ── System Prompt Behavior ──

  /** Whether the scaffold should inject its full system prompt.
   *  false = model was agentically trained, prefers minimal/no system prompt.
   *  true  = model needs detailed behavioral instructions. */
  useFullSystemPrompt: boolean;

  /** Keep the full compose path (policy, memory, skills, git, plan mode)
   *  but replace BASE_SYSTEM_PROMPT with LEAN_SYSTEM_PROMPT. For
   *  DeepSeek-V4-grade models that already know agentic few-shots —
   *  do not re-teach Qwen/tutorial "Let me…" examples. */
  useLeanBasePrompt?: boolean;

  /** When true, send NO system prompt at all — not even a minimal one.
   *  For models trained to operate purely from tool definitions + user message.
   *  Overrides useFullSystemPrompt and minimalSystemPrompt. */
  noSystemPrompt: boolean;

  /** Extra instructions to append even when useFullSystemPrompt is false.
   *  Useful for non-interactive mode rules. Ignored when noSystemPrompt is true. */
  minimalSystemPrompt?: string;

  /** Path to a dedicated system prompt file (relative to src/prompt/).
   *  Used for model-specific system prompts too large to inline. */
  systemPromptFile?: string;

  /** Whether to include tool descriptions in the system prompt.
   *  false = tools are already in the API `tools` parameter, no need to duplicate.
   *  true  = model benefits from seeing tool list in system prompt (e.g., Ollama GGUF models). */
  includeToolListInPrompt: boolean;

  /** Optional cap for project memory injected into the system prompt.
   *  Long local CLAUDE.md files can make smaller/open models autocomplete the
   *  operating manual instead of answering the user. */
  maxProjectMemoryChars?: number;

  // ── Thinking / Reasoning ──

  /** Whether the model supports <think>...</think> blocks. */
  supportsThinking: boolean;

  /** Whether to explicitly disable thinking via chat_template_kwargs.
   *  Only needed for models that default to thinking mode. */
  disableThinkingExplicitly: boolean;

  /** Thinking REQUIRED for correct tool-call parsing (SCLI-54).
   *  When true, SCLI forces enable_thinking / thinkingLevel=on even if the user
   *  saved `thinkingLevel=off` or toggled /think off. Required for models whose
   *  vLLM tool-call parser only works with thinking enabled — e.g. GLM-4.7 /
   *  GLM-5.2 (glm47 parser): thinking OFF → empty/corrupt tool args OR raw
   *  text like `<tool_call>…</arg_value>` instead of structured tool_calls.
   *  Safe when reasoning goes to a separate reasoning_content field (no user-output leak). */
  defaultThinkingOn?: boolean;

  // ── Tool Calling ──

  /** Tool call format the model was trained on. */
  toolCallFormat: 'openai' | 'hermes' | 'qwen3_coder' | 'minimax_m2' | 'auto';

  /** Whether the model supports parallel/batch tool calls in a single response. */
  supportsParallelToolCalls: boolean;

  // ── Context & Performance ──

  /** Native max context window (before quantization/KV cache limits). */
  nativeContextWindow: number;

  /** Recommended max output tokens per turn. */
  recommendedMaxOutputTokens: number;

  /** Whether the model benefits from prefix caching. */
  benefitsFromPrefixCaching: boolean;

  /** Default temperature override.
   *  undefined = use scaffold/config default. null = explicitly omit from API request.
   *  number = use this specific value. */
  defaultTemperature?: number | null;

  /** Default top_p override.
   *  undefined = use scaffold/vLLM default. null = explicitly omit from API request.
   *  number = use this specific value. */
  defaultTopP?: number | null;

  /** Default reasoning effort for agentic requests when the caller did not
   *  explicitly select one. Maintenance requests intentionally do not inherit
   *  this because compaction should remain short and deterministic. */
  defaultReasoningEffort?: string;

  /**
   * How to replay stored `reasoning_content` on later turns.
   * `always` (default) = current GLM/Qwen behavior.
   * `tool-call-turns` = official DeepSeek rule: only on assistant turns
   * that also carry tool_calls (SCLI-584 / Let-me contamination).
   */
  reasoningPassback?: 'always' | 'tool-call-turns';

  /** Recommended toolset name for this model.
   *  Agentically-trained models work best with a focused tool set (~14 tools)
   *  rather than the full 42-tool set which confuses tool selection. */
  recommendedToolset?: string;

  /** Path to JSON file with exact tool definitions for this model.
   *  When set, replaces auto-generated tool schemas from our registry.
   *  The model was trained on these exact descriptions/schemas. */
  toolDefinitionsFile?: string;

  /** Tool name aliases — map shizuha tool names to model-expected names.
   *  e.g., { 'write': 'write_file', 'bash': 'run_shell_command' }
   *  Applied when building the tools array sent to the model. */
  toolNameAliases?: Record<string, string>;

  /** User message content format: 'string' (default) or 'array' (content blocks).
   *  Some models (Qwen3-Coder) were trained with array format [{type:'text',text:'...'}]. */
  userMessageFormat?: 'string' | 'array';

  /** Whether to prime the conversation with a context message + assistant ack.
   *  Some models work better when the conversation starts with context setup. */
  conversationPriming?: boolean;

  /** Tool response format adapter — transforms tool results to match model training data.
   *  e.g., 'qwen-code' reformats todo_write, write_file, edit, read_file responses
   *  to match qwen-code scaffold output the model was trained on. */
  toolResponseFormat?: string;

  /** Auto-coerce string→number for known numeric tool parameters (timeout, limit, etc).
   *  Fixes models that send "30000" instead of 30000. */
  coerceToolParams?: boolean;

  /** Whether the served model accepts image content blocks (vision/multimodal).
   *  Default (undefined/false) = TEXT-ONLY: the vLLM provider substitutes image
   *  tool-results with a textual placeholder instead of sending image_url blocks,
   *  which a text-only model (e.g. GLM-4.7) rejects with HTTP 400 (SCLI-63).
   *  Set true only for a genuinely multimodal served model (e.g. a Qwen-VL via
   *  the CTX-8 vision track) to re-enable image passing + auto-downscale. */
  supportsVision?: boolean;
}

const MINIMAL_NON_INTERACTIVE_PROMPT = `You operate in non-interactive mode. Do not ask the user questions — proceed with available context. Use tools to complete the task. When done, return the final result as text (not a tool call).`;

/**
 * Known model profiles. Matched by substring against model name (first match wins).
 * Order matters — more specific patterns should come first.
 */
const PROFILES: Array<[string, ModelProfile]> = [
  // ── Qwen Coder Models (agentically trained, minimal prompt) ──
  ['Qwen3-Coder-Next', {
    displayName: 'Qwen3-Coder-Next',
    useFullSystemPrompt: false,  // don't use shizuha's generic prompt
    noSystemPrompt: false,
    // systemPromptFile: removed — causes regression at both 65K and 131K
    // The model performs best with NO system prompt. Quality comes from tool definitions + response adapters.
    defaultTemperature: null,  // null = explicitly omit temperature from API request
    recommendedToolset: 'coding-agent',  // ~15 focused tools
    toolDefinitionsFile: 'qwen-coder-tools.json',  // ESSENTIAL — removal causes 0-tool-call crashes
    includeToolListInPrompt: false,
    supportsThinking: false,
    disableThinkingExplicitly: false,  // qwen-code doesnt send chat_template_kwargs
    toolCallFormat: 'qwen3_coder',
    supportsParallelToolCalls: false,
    nativeContextWindow: 262144,
    recommendedMaxOutputTokens: 8192,  // must match qwen-code training — 16384 causes regression
    benefitsFromPrefixCaching: true,
    // Model was trained with specific tool names — alias shizuha names to match
    toolNameAliases: {
      'write': 'write_file',
      'read': 'read_file',
      'bash': 'run_shell_command',
      'grep': 'grep_search',
      'ask_user': 'ask_user_question',
      'memory': 'save_memory',
    },
    // Model trained with array-format content blocks
    userMessageFormat: 'array',
    // Prime conversation with context setup + assistant ack
    conversationPriming: true,
    toolResponseFormat: 'qwen-code',  // ESSENTIAL — removal causes 0-tool-call crashes
    // Auto-coerce "30000" → 30000 for timeout params (model sends strings)
    coerceToolParams: true,
  }],

  // ── Qwen3-Next (thinking variant) ──
  ['Qwen3-Next', {
    displayName: 'Qwen3-Next',
    useFullSystemPrompt: false,
    noSystemPrompt: false,
    minimalSystemPrompt: MINIMAL_NON_INTERACTIVE_PROMPT,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'qwen3_coder',
    supportsParallelToolCalls: false,
    nativeContextWindow: 262144,
    recommendedMaxOutputTokens: 8192,
    benefitsFromPrefixCaching: true,
  }],

  // ── Qwen3.5 Models ──
  // NOTE: Qwen3.5 uses XML-based tool calling (<tool_call>/<tool_response>),
  // NOT the qwen-code JSON format. Use 'auto' to let vLLM handle it natively
  // with --tool-call-parser qwen3_xml.
  ['Qwen3.5', {
    displayName: 'Qwen3.5',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: false,
    nativeContextWindow: 262144,
    // Quality-first default: DeepSeek can spend a meaningful budget in hidden
    // reasoning before emitting final text/tool calls.
    recommendedMaxOutputTokens: 32768,
    benefitsFromPrefixCaching: true,
    // SCLI-63: Qwen3.5 is natively multimodal (vision) across served variants —
    // qwen3.5:35b-a3b / 27B / 122B-A10B / 397B are all documented "natively
    // multimodal (vision)" (benchmark/config.py). Opt in so image tool-results
    // keep flowing as image_url blocks instead of the text-only placeholder
    // (the placeholder is only needed for genuinely text-only models like GLM-4.7,
    // which 400 on images; a vision arch accepts — or harmlessly ignores — them).
    supportsVision: true,
  }],

  // Qwen3.8-27B-Q4 — i9-ws llama.cpp UD-Q4_K_XL, 1×122880 slot. Must precede
  // the generic Qwen3.8 profile (first-match-wins). Same thinking+coding
  // recipe as BF16; native window is the live slot, not the 256K card.
  ['Qwen3.8-27B-Q4', {
    displayName: 'Qwen3.8-27B-Q4',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: true,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 122880,
    recommendedMaxOutputTokens: 16384,
    defaultTemperature: 0.6,
    defaultTopP: 0.95,
    defaultReasoningEffort: 'xhigh',
    benefitsFromPrefixCaching: true,
    supportsVision: false,
  }],

  // Qwen3.8-27B — hybrid GDN+full-attn, served on s1 2x A6000 via adopted
  // host vLLM (cortex-self). Must precede any future bare 'Qwen3' profile.
  // 256K native ctx, qwen3 reasoning parser, qwen3_coder tools.
  // Sampling: Unsloth/Qwen thinking + precise coding (temp 0.6 / top_p 0.95).
  // Silent profile used to fall through to scaffold temp=0 (greedy) — that
  // is the documented-wrong setting for this thinking coder.
  ['Qwen3.8', {
    displayName: 'Qwen3.8-27B',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: true,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 262144,
    recommendedMaxOutputTokens: 16384,
    defaultTemperature: 0.6,
    defaultTopP: 0.95,
    defaultReasoningEffort: 'xhigh',
    benefitsFromPrefixCaching: true,
    supportsVision: false,
  }],

  // ── DeepSeek R1 — thinking/reasoning model, 128K context ──
  ['DeepSeek-R1', {
    displayName: 'DeepSeek-R1',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,           // emits reasoning_content via vLLM
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: false, // R1 reasoning models typically single-call
    nativeContextWindow: 131072,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: true,
  }],

  // ── DeepSeek-V4-Flash-MLX — 2-bit DQ on M4 Max (rapid-mlx via Cortex) ──
  // MUST precede 'DeepSeek-V4-Flash' (first-match-by-substring wins).
  // The 2-bit quantization makes reasoning noisier than the NVFP4 fleet:
  // at effort=high the model can burn the entire 32K output budget inside
  // <think> without converging (observed 128K think tokens, 31-min hang,
  // 2026-08-14). Cap output lower and use effort=low so the think block
  // stays short enough to leave room for the answer + tool call.
  ['DeepSeek-V4-Flash-MLX', {
    displayName: 'DeepSeek-V4-Flash-MLX',
    useFullSystemPrompt: true,
    useLeanBasePrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    defaultThinkingOn: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 262144,
    // 2-bit MLX: 16K cap keeps worst-case decode at ~13 min (21 tok/s) and
    // leaves headroom for the answer after a bounded think block.
    recommendedMaxOutputTokens: 16384,
    // Pin a stable sampling recipe client-side: rapid-mlx has no
    // --override-generation-config, and the model's generation_config.json
    // ships temp=1.0/top_p=1.0 which is too permissive for 2-bit weights
    // (degenerate repetition at temp≥0.7, observed 2026-08-14).
    defaultTemperature: 0.3,
    defaultTopP: 0.9,
    // effort=low: bounds the think block so the 2-bit model cannot consume
    // the whole output budget reasoning. The NVFP4 fleet uses 'high'; this
    // quantized copy needs the smaller budget to converge.
    defaultReasoningEffort: 'low',
    reasoningPassback: 'tool-call-turns',
    benefitsFromPrefixCaching: true,
  }],

  // ── DeepSeek-V4-Flash GA-0731 — Cortex TP2/TP4/TP8 512K fleet ──
  ['DeepSeek-V4-Flash', {
    displayName: 'DeepSeek-V4-Flash',
    // Operator 2026-08-14: go with the model. V4-Flash is agentically trained;
    // the Qwen few-shot file is not on this path, but BASE_SYSTEM_PROMPT is
    // written for smaller-context models ("Plan your approach", file-write
    // lecture) and primes "Let me…" narration. Lean base; keep memory/skills.
    useFullSystemPrompt: true,
    useLeanBasePrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    defaultThinkingOn: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 524288,
    // 16384 → 32768 (operator 2026-08-09): thinking tokens share max_tokens,
    // so at effort=max a large Write tool call was routinely truncated at the
    // old ceiling ('max_tokens' incomplete turns). Ceiling ≠ target — turns
    // stop at EOS; the only standing cost is cortex's admission reservation
    // (prompt + max_tokens + margin), +16K/request against 2.4–4.7M pools.
    // Worst-case decode at ~47 tok/s ≈ 11.6 min on mc=3/5/7 lanes.
    recommendedMaxOutputTokens: 32768,
    // SCLI-451 (operator 2026-08-11): CORTEX DECIDES SAMPLING. Explicit null
    // = omit temperature/top_p from the request entirely; the serving
    // engines pin the stability recipe (0.6/0.95) via
    // --override-generation-config, so sampling is tuned server-side with
    // no harness roll. History: the profile's 1.0/1.0 eval recipe (and the
    // scaffold's temp-0 greedy before it) produced the documented DSV4
    // long-context repetition loops ("Let me commit and push." x40,
    // qwen-code#4695 class) — both extremes are client overrides the
    // engine's defaults existed to prevent.
    defaultTemperature: null,
    defaultTopP: null,
    // DSv4 effort is low|high|max (no medium). Engine serve default is already
    // high; SCLI used to send max on every turn. At 280k+ that extra think
    // budget showed up as "Let me …" planning carousels (shizuha5 2026-08-13).
    defaultReasoningEffort: 'high',
    // Official DeepSeek thinking-mode passback (SCLI-584): replay CoT only
    // on tool-call turns. Feeding every prior "Let me…" trace back into
    // self-hosted templates is the slow session-long carousel.
    reasoningPassback: 'tool-call-turns',
    benefitsFromPrefixCaching: true,
  }],

  // ── DeepSeek-V3 (non-reasoning) ──
  ['DeepSeek-V3', {
    displayName: 'DeepSeek-V3',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: false,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 131072,
    recommendedMaxOutputTokens: 8192,
    benefitsFromPrefixCaching: true,
  }],

  // Qwen3.6-35B-A3B-8bit-MLX — v4 Apple Metal backend, served through Cortex.
  // Keep this before the generic Qwen3.6 profile because profile matching is
  // first-match-wins by substring.
  ['Qwen3.6-35B-A3B-8bit-MLX', {
    displayName: 'Qwen3.6-35B-A3B-8bit-MLX',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: true,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 262144,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: true,
    supportsVision: false,
  }],

  // Qwen3.6 — MoE family. Defaults to thinking ON; explicitly disable via
  // chat_template_kwargs since /think off breaks tool-calling otherwise.
  // Current Cortex Qwen3.6 deployments advertise 256K; provider discovery is
  // still authoritative if a specific backend serves a smaller window.
  ['Qwen3.6', {
    displayName: 'Qwen3.6',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: true,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 262144,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: true,
    // SCLI-63: Qwen3.6 is the same Qwen3_5 multimodal (vision) arch as Qwen3.5
    // — benchmark/config.py documents vllm/Qwen3.6-27B as "Qwen3_5 arch
    // (multimodal)". Opt in so image tool-results keep flowing instead of the
    // text-only placeholder.
    supportsVision: true,
  }],

  // ── MiniMax Models ──
  // MiniMax M2.5 generates long <think> blocks (5-12K tokens) for complex tasks.
  // vLLM cluster serves at max_model_len=65536, so output budget must leave room for
  // ~30K prompt + history. 32K output reserved 50% of window — model would write
  // 800-line single-shot files that triggered compaction by turn 6 (see bench
  // logs/shizuha-minimax-m25-awq-tp4-impossible-compiler-optimizer.log). Capping at
  // 12K forces incremental edits and matches what claude-code uses on equivalent
  // limited-window models.
  ['MiniMax', {
    displayName: 'MiniMax-M2.5',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'minimax_m2',
    supportsParallelToolCalls: true,
    nativeContextWindow: 1048576,
    recommendedMaxOutputTokens: 12288,
    benefitsFromPrefixCaching: true,
  }],

  // ── GLM Models ──
  // Order matters: first-match-wins by substring.
  // GLM-5.2 must precede GLM-5.1 / GLM-5 (otherwise "GLM-5.2-…" matches "GLM-5").
  // QT + production GLM-5.2 use vLLM --tool-call-parser glm47 — same SCLI-54/57
  // failure class as GLM-4.7: full bulk prompt + thinking-off → corrupt/empty
  // tool args and mid-JSON truncation at max_tokens. Lean prompt + thinking ON.
  ['GLM-5.2', {
    displayName: 'GLM-5.2',
    useFullSystemPrompt: false,
    minimalSystemPrompt: `You are an autonomous agent. You complete real work by USING TOOLS — you do not just talk about it.

When you call a tool, pass ALL required arguments as valid JSON. Many tools are available via ToolSearch: search by keyword (e.g. "wiki create page", "pulse transition") or use \`select:<exact_tool_name>\` to load a tool before calling it.

On [HEARTBEAT]: call mcp__shizuha-pulse__pulse_get_my_alerts first, then mcp__shizuha-pulse__pulse_get_my_tasks. After both results, work the highest-priority ready item across alerts and tasks to a real outcome (a comment, a status transition, a PR); alerts win ties but never preempt higher-priority task WIP. Then re-check alerts before tasks and take the next ready item — drain your ready inboxes and never idle while an alert or task is assigned to you. Before going idle while holding non-blocked urgent/high in_progress or in_review work, re-read EACH such held item's latest comments + linked-PR review feedback (not just the top-ranked one) — get_my_tasks shows status only, so a held task whose next action arrived as a comment looks "done" but is ready work (SCLI-76). Only if no alert/task is ready AND no held item has unaddressed feedback: produce no output and end the turn.

To send anything to a human or another agent, call mcp__shizuha-connect__message_user (your turn text is private and reaches no one otherwise). Ship code ONLY through Pull Requests — never push to a main/default branch; author from a fork. If you cannot do something yourself (operator-only access, blocked, another team's work), forward it the same turn (reassign or raise to admin-ops); do not sit on work you cannot move.`,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    defaultThinkingOn: true,  // SCLI-54: thinking-off breaks glm47 tool-arg parsing
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    // QT/NF3 256K stack; keep output under hang/truncation cliff while leaving
    // room for thinking + tool JSON (class-A bench fails hit exactly 16384).
    nativeContextWindow: 262144,
    recommendedMaxOutputTokens: 24576,
    benefitsFromPrefixCaching: true,
  }],

  // GLM-5.1 / GLM-5 use the GLM MoE-DSA architecture. They are long-context
  // reasoning models served through vLLM with the GLM tool-call parser and
  // DeepSeek-R1-style reasoning stream. Keep these before GLM-4.7 because model
  // profile matching is first-match-wins by substring.
  ['GLM-5.1', {
    displayName: 'GLM-5.1',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    defaultThinkingOn: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 202752,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: true,
  }],

  ['GLM-5', {
    displayName: 'GLM-5',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    defaultThinkingOn: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 202752,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: true,
  }],

  // GLM-4.7 uses the glm47 tool parser on vLLM. Current vLLM recipes also
  // document glm45 for reasoning parsing, but the live 2026-06-05 Cortex image
  // exposes only deepseek_r1-style reasoning parsers; the scaffold must preserve
  // vLLM reasoning_content when thinking is enabled so GLM tool turns remain valid.
  // Supports thinking via <think> blocks — needs sufficient output budget.
  // Served at max_model_len=65536 (vLLM TP=4 cluster); 12K output keeps room for
  // ~30K prompt + history. Same logic as M2.5 fix.
  ['GLM-4.7', {
    displayName: 'GLM-4.7',
    // SCLI-57/SCLI-43: GLM-4.7's vLLM glm47 tool-call parser corrupts streamed
    // argument JSON when the system prompt is large (~100K) — proven by freeze-and-
    // replay (103K prompt = 5/5 corrupt args; lean prompt = 0/5, valid args). Use a
    // LEAN prompt: skip the full BASE+POLICY+ROLE+tool-list bulk; the essentials below
    // + the agent's contextPrompt (identity) + on-demand skills are enough.
    useFullSystemPrompt: false,
    minimalSystemPrompt: `You are an autonomous agent. You complete real work by USING TOOLS — you do not just talk about it.

When you call a tool, pass ALL required arguments as valid JSON. Many tools are available via ToolSearch: search by keyword (e.g. "wiki create page", "pulse transition") or use \`select:<exact_tool_name>\` to load a tool before calling it.

On [HEARTBEAT]: call mcp__shizuha-pulse__pulse_get_my_alerts first, then mcp__shizuha-pulse__pulse_get_my_tasks. After both results, work the highest-priority ready item across alerts and tasks to a real outcome (a comment, a status transition, a PR); alerts win ties but never preempt higher-priority task WIP. Then re-check alerts before tasks and take the next ready item — drain your ready inboxes and never idle while an alert or task is assigned to you. Before going idle while holding non-blocked urgent/high in_progress or in_review work, re-read EACH such held item's latest comments + linked-PR review feedback (not just the top-ranked one) — get_my_tasks shows status only, so a held task whose next action arrived as a comment looks "done" but is ready work (SCLI-76). Only if no alert/task is ready AND no held item has unaddressed feedback: produce no output and end the turn.

To send anything to a human or another agent, call mcp__shizuha-connect__message_user (your turn text is private and reaches no one otherwise). Ship code ONLY through Pull Requests — never push to a main/default branch; author from a fork. If you cannot do something yourself (operator-only access, blocked, another team's work), forward it the same turn (reassign or raise to admin-ops); do not sit on work you cannot move.`,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    defaultThinkingOn: true,  // SCLI-54: thinking-off breaks glm47 tool-arg parsing
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 131072,
    recommendedMaxOutputTokens: 12288,
    benefitsFromPrefixCaching: true,
  }],

  // ── Nemotron Models ──
  ['Nemotron', {
    displayName: 'Nemotron',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: false,
    disableThinkingExplicitly: true,
    toolCallFormat: 'qwen3_coder',
    supportsParallelToolCalls: false,
    nativeContextWindow: 131072,
    recommendedMaxOutputTokens: 8192,
    benefitsFromPrefixCaching: true,
  }],

  // ── gpt-oss (OpenAI open-source) ──
  ['gpt-oss', {
    displayName: 'GPT-OSS',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: false,
    disableThinkingExplicitly: false,
    toolCallFormat: 'openai',
    supportsParallelToolCalls: true,
    nativeContextWindow: 131072,
    recommendedMaxOutputTokens: 8192,
    benefitsFromPrefixCaching: false,
  }],

  // ── Step-3.5 ──
  ['Step-3.5', {
    displayName: 'Step-3.5-Flash',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'hermes',
    supportsParallelToolCalls: false,
    nativeContextWindow: 262144,
    recommendedMaxOutputTokens: 8192,
    benefitsFromPrefixCaching: true,
  }],

  // ── Kimi family (K2.x, K2.5, K2.6, future K2.7+) ──
  // Pattern 'Kimi' is intentionally broad — Moonshot's recommended params
  // (max_tokens 4096-8192, temp 1.0, top_p 0.95 per official HF model card)
  // apply across the K2 family. Per project_kimi_chess_engine_tool_args_truncation:
  // chess-engine 0.0 in run 500 was caused by 4K default capping reasoning before
  // the kimi_k2 parser's `<|tool_call_end|>` could land. 8K is the sweet spot.
  // Validated 2026-05-27: 8K max_tokens + top_p 0.95 flipped multiple impossibles
  // (compiler-optimizer, database-engine, type-checker, concurrent-ds) from
  // partial-fail to full PASS. Higher max_tokens (32K) caused over-thinking spiral.
  ['Kimi', {
    displayName: 'Kimi-K2.6',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 131072,
    recommendedMaxOutputTokens: 8192,
    defaultTemperature: 1.0,
    defaultTopP: 0.95,
    benefitsFromPrefixCaching: true,
  }],

  // ── Claude Fable 5 (1M context; thinking is always adaptive — never explicitly enabled/disabled) ──
  ['claude-fable-5', {
    displayName: 'Claude Fable 5',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 1_000_000,
    recommendedMaxOutputTokens: 64000,
    benefitsFromPrefixCaching: true,
  }],

  // ── Claude Opus 5 (1M context; thinking is adaptive and on by default) ──
  ['claude-opus-5', {
    displayName: 'Claude Opus 5',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 1_000_000,
    recommendedMaxOutputTokens: 64000,
    benefitsFromPrefixCaching: true,
  }],

  // ── Claude Opus 4.6+ / Sonnet 4.x — 1M context (long-context beta / Claude Code
  //    1M variant). MUST precede the generic 'claude-' entry (first-match-by-substring).
  //    Matches the anthropic provider's context-1m beta gate + claude-bridge modelMaxTokens. ──
  ['claude-opus-4', {
    displayName: 'Claude Opus 4 (1M)',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 1_000_000,
    recommendedMaxOutputTokens: 32000,
    benefitsFromPrefixCaching: true,
  }],
  ['claude-sonnet-4', {
    displayName: 'Claude Sonnet 4 (1M)',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 1_000_000,
    recommendedMaxOutputTokens: 32000,
    benefitsFromPrefixCaching: true,
  }],

  // ── Claude (via any provider) — haiku / older / unversioned (200K class) ──
  ['claude-', {
    displayName: 'Claude',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 200000,
    recommendedMaxOutputTokens: 32000,
    benefitsFromPrefixCaching: true,
  }],

  // ── Grok 4.5 / 4.6 (xAI SuperGrok, 500K) — must precede generic grok- ──
  // reasoning_effort: low | medium | high (default) | xhigh (4.6+).
  // Cannot disable reasoning. Prefix cache + 500K window are load-bearing
  // for conversational latency; the old 131072 profile caused SCLI to warn
  // and clamp against the served 500K window.
  ['grok-4.6', {
    displayName: 'Grok 4.6',
    useFullSystemPrompt: true,
    useLeanBasePrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'openai',
    supportsParallelToolCalls: true,
    nativeContextWindow: 500000,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: true,
    defaultReasoningEffort: 'low',
    reasoningPassback: 'always',
  }],
  ['grok-4.5', {
    displayName: 'Grok 4.5',
    useFullSystemPrompt: true,
    useLeanBasePrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'openai',
    supportsParallelToolCalls: true,
    nativeContextWindow: 500000,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: true,
    defaultReasoningEffort: 'low',
    reasoningPassback: 'always',
  }],

  // ── Grok (xAI) ──
  // SuperGrok / grok-4.5 support reasoning_effort (low|high) on the xAI Chat
  // Completions API — same control Grok Build exposes via --reasoning-effort.
  // supportsThinking must be true so SCLI's vLLM/Cortex path emits
  // reasoning_effort (chat_template_kwargs + top-level for xAI). Previously
  // false → every SCLI Grok bench turn ran without high reasoning even when
  // the agent asked for --thinking high / --effort high (bench gap vs Grok Build).
  ['grok-', {
    displayName: 'Grok',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: true,
    disableThinkingExplicitly: false,
    toolCallFormat: 'openai',
    supportsParallelToolCalls: true,
    nativeContextWindow: 131072,
    recommendedMaxOutputTokens: 16384,
    benefitsFromPrefixCaching: false,
  }],

  // ── GPT (via any provider) ──
  ['gpt-4', {
    displayName: 'GPT-4',
    useFullSystemPrompt: true,
    noSystemPrompt: false,
    includeToolListInPrompt: false,
    supportsThinking: false,
    disableThinkingExplicitly: false,
    toolCallFormat: 'auto',
    supportsParallelToolCalls: true,
    nativeContextWindow: 128000,
    recommendedMaxOutputTokens: 8192,
    benefitsFromPrefixCaching: false,
  }],
];

/** Default profile for unknown models.
 * Conservative-but-functional: 8K max_tokens (vs 4K) prevents tool-call-end truncation
 * for any model with markered tool calls (Kimi, MiniMax, GLM, DeepSeek all need 6K+ for
 * reasoning + JSON args). 4K was a chess-engine regression magnet for any Kimi-family
 * release that lacked an explicit profile entry. */
const DEFAULT_PROFILE: ModelProfile = {
  displayName: 'Unknown',
  useFullSystemPrompt: true,
  noSystemPrompt: false,
  includeToolListInPrompt: true,
  supportsThinking: false,
  disableThinkingExplicitly: false,
  toolCallFormat: 'auto',
  supportsParallelToolCalls: false,
  nativeContextWindow: 32768,
  recommendedMaxOutputTokens: 8192,
  benefitsFromPrefixCaching: false,
};

// Track which profiles have already logged a match — avoid log spam on every request.
const _loggedMatches = new Set<string>();

function shouldLogModelProfiles(): boolean {
  return process.env['SHIZUHA_MODEL_PROFILE_DEBUG'] === '1';
}

/**
 * Get the model profile for a given model name.
 * Matches by substring (first match wins). Logs the match once per model name
 * so we can verify auto-detection picked the right profile.
 *
 * SCLI-63: matching is CASE-INSENSITIVE. Served vLLM model IDs vary in case
 * (e.g. lowercase `qwen3.5:35b-a3b` vs the `Qwen3.5` pattern); a case-sensitive
 * `includes` would drop those to DEFAULT_PROFILE — losing supportsVision and the
 * per-model tuning. Lowercasing both sides preserves first-match-wins order.
 */
export function getModelProfile(modelName: string): ModelProfile {
  const lowerName = (modelName || '').toLowerCase();
  for (const [pattern, profile] of PROFILES) {
    if (lowerName.includes(pattern.toLowerCase())) {
      if (shouldLogModelProfiles() && !_loggedMatches.has(modelName)) {
        _loggedMatches.add(modelName);
        // eslint-disable-next-line no-console
        console.error(
          `[model-profile] '${modelName}' → '${pattern}' (${profile.displayName}): ` +
          `maxOut=${profile.recommendedMaxOutputTokens}, ctx=${profile.nativeContextWindow}, ` +
          `toolFormat=${profile.toolCallFormat}, temp=${profile.defaultTemperature ?? 'default'}, ` +
          `topP=${profile.defaultTopP ?? 'default'}`,
        );
      }
      return profile;
    }
  }
  if (shouldLogModelProfiles() && !_loggedMatches.has(modelName)) {
    _loggedMatches.add(modelName);
    // eslint-disable-next-line no-console
    console.error(
      `[model-profile] '${modelName}' → NO MATCH, using DEFAULT_PROFILE ` +
      `(maxOut=${DEFAULT_PROFILE.recommendedMaxOutputTokens}). ` +
      `Consider adding an entry for this family to model-profile.ts for optimal config.`,
    );
  }
  return DEFAULT_PROFILE;
}

/**
 * Whether this model REQUIRES thinking for correct tool-call parsing (SCLI-54).
 * When true, callers must not honor thinkingLevel='off' — it produces broken tools.
 */
export function modelRequiresThinkingForTools(modelName?: string | null): boolean {
  if (!modelName) return false;
  return getModelProfile(modelName).defaultThinkingOn === true;
}

/**
 * Resolve the effective thinking level for a model, given any saved/user preference.
 * Models with defaultThinkingOn always resolve to 'on' (tool-parser correctness).
 */
export function resolveThinkingLevelForModel(
  modelName?: string | null,
  savedOrUserLevel?: string | null,
): string {
  if (talkSeatDisablesThinking(modelName ?? '')) return 'off';
  if (modelRequiresThinkingForTools(modelName)) return 'on';
  const lower = (modelName ?? '').toLowerCase();
  if (lower.includes('deepseek-v4-flash')) return 'on';
  // Cortex/vLLM latency default: thinking off unless the user explicitly wants it.
  // Do not let a stale global "on" re-enable it for models that prefer off.
  const prefersOff =
    lower.startsWith('cortex/')
    || lower.startsWith('vllm/')
    || lower.includes('qwen')
    || lower.includes('minimax')
    || lower.includes('nemotron');
  if (prefersOff) {
    if (savedOrUserLevel === 'on' || savedOrUserLevel === 'high') return 'off';
    return savedOrUserLevel && savedOrUserLevel !== 'off' ? savedOrUserLevel : 'off';
  }
  if (lower.includes('claude') || lower.startsWith('anthropic/')) {
    return savedOrUserLevel ?? 'on';
  }
  return savedOrUserLevel ?? 'off';
}

/**
 * Whether chat_template_kwargs.enable_thinking / thinking should be true for this request.
 * defaultThinkingOn models always enable (SCLI-54) — user 'off' cannot disable them.
 */
export function shouldEnableThinkingForRequest(
  modelName: string,
  thinkingLevel?: string | null,
): boolean {
  if (talkSeatDisablesThinking(modelName)) return false;
  const profile = getModelProfile(modelName);
  if (!profile.supportsThinking && !profile.disableThinkingExplicitly) return false;
  if (profile.defaultThinkingOn === true) return true;
  return thinkingLevel === 'on' || thinkingLevel === 'high';
}

/**
 * Effort that will actually go on the next vLLM/Cortex turn.
 * Matches `VllmProvider` precedence: env > explicit /effort > profile
 * default > thinkingLevel=high. Used by the TUI footer so `think:on`
 * is never silent about a hidden default (shizuha5, 2026-08-13).
 */
export function resolveReasoningEffortForRequest(
  modelName: string,
  options?: { reasoningEffort?: string | null; thinkingLevel?: string | null },
): string | undefined {
  if (talkSeatDisablesThinking(modelName)) return undefined;
  const env = process.env['VLLM_REASONING_EFFORT']?.trim()
    || process.env['REASONING_EFFORT']?.trim();
  const explicit = options?.reasoningEffort?.trim();
  const profileDefault = getModelProfile(modelName).defaultReasoningEffort?.trim();
  let resolved = env || explicit || profileDefault;
  if (!resolved && options?.thinkingLevel === 'high') resolved = 'high';
  if (!resolved) return undefined;
  // Operator 2026-08-15: SuperGrok conversational latency — high/xhigh is
  // not acceptable while we are optimizing TTFT. Benches that need high set
  // SHIZUHA_ALLOW_GROK_HIGH_REASONING=1.
  const modelId = (modelName || '').toLowerCase();
  const isSuperGrok = modelId.includes('grok-4.6') || modelId.includes('grok-4.5');
  const allowHigh = process.env['SHIZUHA_ALLOW_GROK_HIGH_REASONING'] === '1';
  if (isSuperGrok && !allowHigh && (resolved === 'high' || resolved === 'xhigh')) {
    return 'low';
  }
  // Qwen3.8 chat template only accepts xhigh|medium|low. Sending `high`
  // raises TemplateError and Cortex returns 400 (shizuha1, 2026-08-15).
  const isQwen38 = modelId.includes('qwen3.8');
  if (isQwen38 && (resolved === 'high' || resolved === 'max')) {
    return 'xhigh';
  }
  return resolved;
}

/**
 * Check if a model should use the full scaffold system prompt.
 */
export function shouldUseFullSystemPrompt(modelName: string): boolean {
  return getModelProfile(modelName).useFullSystemPrompt;
}
