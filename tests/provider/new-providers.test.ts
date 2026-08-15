import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { ProviderRegistry } from '../../src/provider/registry.js';
import { XaiProvider } from '../../src/provider/xai.js';
import { GroqProvider } from '../../src/provider/groq.js';
import { TogetherProvider } from '../../src/provider/together.js';
import { getModelProfile, resolveReasoningEffortForRequest, shouldEnableThinkingForRequest } from '../../src/provider/model-profile.js';
import { configSchema } from '../../src/config/schema.js';
import type { ShizuhaConfig } from '../../src/config/types.js';

/** SCLI-29: Grok / Groq / Together provider classes, profiles, and routing. */

function ctxFor(p: object, model: string): number {
  return (p as unknown as { contextWindowFor(m: string): number }).contextWindowFor(model);
}

describe('new provider classes (xAI / Groq / Together)', () => {
  it('XaiProvider has the correct endpoint, name, and Grok context windows', () => {
    const p = new XaiProvider('test-key');
    expect(p.name).toBe('xai');
    expect(p.baseURL).toBe('https://api.x.ai/v1');
    expect(ctxFor(p, 'grok-4.6')).toBe(500000);
    expect(ctxFor(p, 'grok-4.5')).toBe(500000);
    expect(ctxFor(p, 'grok-4')).toBe(256000);
    expect(ctxFor(p, 'grok-3')).toBe(131072);
    expect(ctxFor(p, 'grok-unknown')).toBe(131072); // sane default, not 32K
  });

  it('GroqProvider has the correct endpoint, name, and context windows', () => {
    const p = new GroqProvider('test-key');
    expect(p.name).toBe('groq');
    expect(p.baseURL).toBe('https://api.groq.com/openai/v1');
    expect(ctxFor(p, 'llama-3.3-70b-versatile')).toBe(131072);
    expect(ctxFor(p, 'llama3-8b-8192')).toBe(8192);
    expect(ctxFor(p, 'something-new')).toBe(131072);
  });

  it('TogetherProvider has the correct endpoint, name, and context windows', () => {
    const p = new TogetherProvider('test-key');
    expect(p.name).toBe('together');
    expect(p.baseURL).toBe('https://api.together.xyz/v1');
    expect(ctxFor(p, 'meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(131072);
    expect(ctxFor(p, 'org/unknown-model')).toBe(32768);
  });
});

describe('grok- model profile (no longer DEFAULT_PROFILE)', () => {
  it('matches grok models with a proper context window + output budget', () => {
    const prof = getModelProfile('grok-3');
    expect(prof.displayName).toBe('Grok');
    expect(prof.nativeContextWindow).toBe(131072);     // not the 32768 default
    expect(prof.recommendedMaxOutputTokens).toBeGreaterThanOrEqual(16384);
    expect(prof.toolCallFormat).toBe('openai');
  });

  it('matches grok-4.6 / grok-4.5 at the served 500K SuperGrok window', () => {
    const g46 = getModelProfile('cortex/grok-4.6');
    expect(g46.displayName).toBe('Grok 4.6');
    expect(g46.nativeContextWindow).toBe(500000);
    expect(g46.benefitsFromPrefixCaching).toBe(true);
    const g45 = getModelProfile('grok-4.5');
    expect(g45.displayName).toBe('Grok 4.5');
    expect(g45.nativeContextWindow).toBe(500000);
    expect(g46.defaultReasoningEffort).toBe('low');
    expect(g45.defaultReasoningEffort).toBe('low');
    expect(g46.reasoningPassback).toBe('always');
    const savedVllm = process.env['VLLM_REASONING_EFFORT'];
    const savedReasoning = process.env['REASONING_EFFORT'];
    const savedAllow = process.env['SHIZUHA_ALLOW_GROK_HIGH_REASONING'];
    delete process.env['VLLM_REASONING_EFFORT'];
    delete process.env['REASONING_EFFORT'];
    delete process.env['SHIZUHA_ALLOW_GROK_HIGH_REASONING'];
    try {
      expect(resolveReasoningEffortForRequest('cortex/grok-4.6', { reasoningEffort: 'high' })).toBe('low');
      expect(resolveReasoningEffortForRequest('cortex/grok-4.6')).toBe('low');
      process.env['SHIZUHA_ALLOW_GROK_HIGH_REASONING'] = '1';
      expect(resolveReasoningEffortForRequest('cortex/grok-4.6', { reasoningEffort: 'high' })).toBe('high');
    } finally {
      if (savedVllm === undefined) delete process.env['VLLM_REASONING_EFFORT'];
      else process.env['VLLM_REASONING_EFFORT'] = savedVllm;
      if (savedReasoning === undefined) delete process.env['REASONING_EFFORT'];
      else process.env['REASONING_EFFORT'] = savedReasoning;
      if (savedAllow === undefined) delete process.env['SHIZUHA_ALLOW_GROK_HIGH_REASONING'];
      else process.env['SHIZUHA_ALLOW_GROK_HIGH_REASONING'] = savedAllow;
    }
  });

  it('disables DeepSeek thinking on lean talk seats; Grok 4.6 stays API-forced', () => {
    const savedUser = process.env['AGENT_USERNAME'];
    const savedTalk = process.env['SHIZUHA_TALK_MINIMAL_PROMPT'];
    const savedTeam = process.env['AGENT_TEAM'];
    const savedLean = process.env['SHIZUHA_LEAN_MCP'];
    delete process.env['AGENT_USERNAME'];
    delete process.env['AGENT_TEAM'];
    delete process.env['SHIZUHA_LEAN_MCP'];
    delete process.env['SHIZUHA_TALK_MINIMAL_PROMPT'];
    try {
      expect(shouldEnableThinkingForRequest('cortex/DeepSeek-V4-Flash', 'on')).toBe(true);
      process.env['AGENT_USERNAME'] = 'yuna';
      process.env['SHIZUHA_TALK_MINIMAL_PROMPT'] = '1';
      expect(shouldEnableThinkingForRequest('cortex/DeepSeek-V4-Flash', 'on')).toBe(false);
      expect(shouldEnableThinkingForRequest('cortex/grok-4.6', 'on')).toBe(true);
      expect(resolveReasoningEffortForRequest('cortex/DeepSeek-V4-Flash', { reasoningEffort: 'low' })).toBeUndefined();
      expect(resolveReasoningEffortForRequest('cortex/grok-4.6', { reasoningEffort: 'low' })).toBe('low');
    } finally {
      if (savedUser === undefined) delete process.env['AGENT_USERNAME'];
      else process.env['AGENT_USERNAME'] = savedUser;
      if (savedTalk === undefined) delete process.env['SHIZUHA_TALK_MINIMAL_PROMPT'];
      else process.env['SHIZUHA_TALK_MINIMAL_PROMPT'] = savedTalk;
      if (savedTeam === undefined) delete process.env['AGENT_TEAM'];
      else process.env['AGENT_TEAM'] = savedTeam;
      if (savedLean === undefined) delete process.env['SHIZUHA_LEAN_MCP'];
      else process.env['SHIZUHA_LEAN_MCP'] = savedLean;
    }
  });
});

describe('GLM-5 family model profiles', () => {
  it('matches GLM-5 and GLM-5.1 before falling back to the default profile', () => {
    const glm5 = getModelProfile('vllm/GLM-5');
    expect(glm5.displayName).toBe('GLM-5');
    expect(glm5.nativeContextWindow).toBe(202752);
    expect(glm5.defaultThinkingOn).toBe(true);
    expect(glm5.includeToolListInPrompt).toBe(false);
    expect(glm5.recommendedMaxOutputTokens).toBeGreaterThanOrEqual(16384);

    const glm51 = getModelProfile('cortex/GLM-5.1');
    expect(glm51.displayName).toBe('GLM-5.1');
    expect(glm51.nativeContextWindow).toBe(202752);
    expect(glm51.defaultThinkingOn).toBe(true);
  });

  it('matches GLM-5.2 before GLM-5 with lean prompt + thinking default', () => {
    const qt = getModelProfile('vllm/GLM-5.2-QuantTrio-256K');
    expect(qt.displayName).toBe('GLM-5.2');
    expect(qt.useFullSystemPrompt).toBe(false);
    expect(qt.defaultThinkingOn).toBe(true);
    expect(qt.nativeContextWindow).toBe(262144);
    expect(qt.recommendedMaxOutputTokens).toBeGreaterThanOrEqual(24576);
    expect(qt.minimalSystemPrompt).toBeTruthy();

    const nf3 = getModelProfile('vllm/GLM-5.2-NF3-256K');
    expect(nf3.displayName).toBe('GLM-5.2');
    expect(nf3.useFullSystemPrompt).toBe(false);
  });

  it('forces thinking ON for GLM-5.2 even when user/settings request off (SCLI-54 tool parser)', async () => {
    const {
      modelRequiresThinkingForTools,
      resolveThinkingLevelForModel,
      shouldEnableThinkingForRequest,
    } = await import('../../src/provider/model-profile.js');
    const ids = [
      'GLM-5.2-QuantTrio-256K',
      'cortex/GLM-5.2-QuantTrio-256K',
      'vllm/GLM-5.2-QuantTrio-256K',
      'GLM-4.7',
    ];
    for (const id of ids) {
      expect(modelRequiresThinkingForTools(id), id).toBe(true);
      expect(resolveThinkingLevelForModel(id, 'off'), id).toBe('on');
      expect(shouldEnableThinkingForRequest(id, 'off'), id).toBe(true);
      expect(shouldEnableThinkingForRequest(id, undefined), id).toBe(true);
    }
    // Qwen prefers off for latency and is not defaultThinkingOn
    expect(modelRequiresThinkingForTools('cortex/Qwen3.6-27B')).toBe(false);
    expect(resolveThinkingLevelForModel('cortex/Qwen3.6-27B', 'off')).toBe('off');
    expect(shouldEnableThinkingForRequest('cortex/Qwen3.6-27B', 'off')).toBe(false);
  });
});

describe('DeepSeek-V4-Flash model profile', () => {
  it('does not fall back to the default 32K profile', () => {
    const prof = getModelProfile('vllm/DeepSeek-V4-Flash');
    expect(prof.displayName).toBe('DeepSeek-V4-Flash');
    expect(prof.nativeContextWindow).toBe(524288);
    expect(prof.recommendedMaxOutputTokens).toBeGreaterThanOrEqual(16384);
    expect(prof.benefitsFromPrefixCaching).toBe(true);
    expect(prof.supportsThinking).toBe(true);
    expect(prof.defaultThinkingOn).toBe(true);
    expect(prof.disableThinkingExplicitly).toBe(false);
    // SCLI-451: cortex decides sampling — explicit null omits temperature
    // from the request so the engine's pinned 0.6/0.95 stability recipe
    // applies (client extremes produced the DSV4 repetition loops).
    expect(prof.defaultTemperature).toBeNull();
    expect(prof.defaultTopP).toBeNull();
    expect(prof.defaultReasoningEffort).toBe('high');
  });

  it('resolves the wire effort the TUI footer should show', () => {
    expect(resolveReasoningEffortForRequest('DeepSeek-V4-Flash', {
      thinkingLevel: 'on',
    })).toBe('high');
    expect(resolveReasoningEffortForRequest('DeepSeek-V4-Flash', {
      reasoningEffort: 'max',
      thinkingLevel: 'on',
    })).toBe('max');
    expect(resolveReasoningEffortForRequest('cortex/Qwen3.6-27B', {
      thinkingLevel: 'on',
    })).toBeUndefined();
  });
});

describe('DeepSeek-V4-Flash-MLX model profile (2-bit DQ on M4 Max)', () => {
  it('matches the MLX variant before the fleet DeepSeek-V4-Flash profile', () => {
    const prof = getModelProfile('cortex/DeepSeek-V4-Flash-MLX');
    expect(prof.displayName).toBe('DeepSeek-V4-Flash-MLX');
    // 2-bit quantized copy: bounded output budget so a runaway think block
    // cannot consume the whole turn (128K-think hang, 2026-08-14).
    expect(prof.recommendedMaxOutputTokens).toBe(16384);
    expect(prof.nativeContextWindow).toBe(262144);
    // Client-pinned stable sampling: rapid-mlx ships temp=1.0/top_p=1.0
    // which is degenerate for 2-bit weights.
    expect(prof.defaultTemperature).toBe(0.3);
    expect(prof.defaultTopP).toBe(0.9);
    expect(prof.defaultReasoningEffort).toBe('low');
    expect(prof.supportsThinking).toBe(true);
    expect(prof.defaultThinkingOn).toBe(true);
  });

  it('does not shadow the fleet profile for plain DeepSeek-V4-Flash', () => {
    const prof = getModelProfile('cortex/DeepSeek-V4-Flash');
    expect(prof.displayName).toBe('DeepSeek-V4-Flash');
    expect(prof.recommendedMaxOutputTokens).toBe(32768);
    expect(prof.defaultReasoningEffort).toBe('high');
  });
});

describe('Qwen3.6 model profile', () => {
  it('does not fall back to the stale 65K profile for Cortex NVFP4 deployments', () => {
    const prof = getModelProfile('cortex/Qwen3.6-27B-NVFP4');
    expect(prof.displayName).toBe('Qwen3.6');
    expect(prof.nativeContextWindow).toBe(262144);
    expect(prof.recommendedMaxOutputTokens).toBeGreaterThanOrEqual(16384);
    expect(prof.benefitsFromPrefixCaching).toBe(true);
  });
});

describe('Qwen3.8 model profile', () => {
  it('does not fall back to the default 32K profile for Cortex s1 adopt', () => {
    for (const id of ['Qwen3.8-27B', 'cortex/Qwen3.8-27B', 'Qwen/Qwen3.8-27B']) {
      const prof = getModelProfile(id);
      expect(prof.displayName, id).toBe('Qwen3.8-27B');
      expect(prof.nativeContextWindow, id).toBe(262144);
      expect(prof.supportsThinking, id).toBe(true);
      expect(prof.benefitsFromPrefixCaching, id).toBe(true);
      expect(prof.defaultTemperature, id).toBe(0.6);
      expect(prof.defaultTopP, id).toBe(0.95);
      expect(prof.defaultReasoningEffort, id).toBe('xhigh');
      expect(resolveReasoningEffortForRequest(id, { reasoningEffort: 'high' }), id).toBe('xhigh');
    }
  });

  it('pins the i9-ws Q4 slot window and the same coding recipe', () => {
    for (const id of ['Qwen3.8-27B-Q4', 'cortex/Qwen3.8-27B-Q4', 'vllm/Qwen3.8-27B-Q4']) {
      const prof = getModelProfile(id);
      expect(prof.displayName, id).toBe('Qwen3.8-27B-Q4');
      expect(prof.nativeContextWindow, id).toBe(122880);
      expect(prof.defaultTemperature, id).toBe(0.6);
      expect(prof.defaultReasoningEffort, id).toBe('xhigh');
    }
  });
});

describe('registry routing to the dedicated classes', () => {
  const PROVIDER_ENV = [
    'XAI_API_KEY', 'GROQ_API_KEY', 'TOGETHER_API_KEY',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
    'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GITHUB_COPILOT_TOKEN', 'LITELLM_PROXY_URL',
  ];
  let saved: Record<string, string | undefined> = {};
  let registry: ProviderRegistry;

  beforeEach(() => {
    saved = {};
    for (const k of PROVIDER_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env['XAI_API_KEY'] = 'xai-test';
    process.env['GROQ_API_KEY'] = 'groq-test';
    process.env['TOGETHER_API_KEY'] = 'together-test';
    registry = new ProviderRegistry(configSchema.parse({}) as ShizuhaConfig);
  });

  afterEach(() => {
    for (const k of PROVIDER_ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('routes explicit xai:grok-* (colon override) to XaiProvider', () => {
    // Bare grok-* / xai/grok-* prefer Cortex when the gateway is available.
    // Direct console xAI keys use the colon override.
    const r = registry.resolveWithModel('xai:grok-3');
    expect(r.provider).toBeInstanceOf(XaiProvider);
    expect(r.resolvedModel).toBe('grok-3');
  });

  it('routes groq/<model> (slash form) to GroqProvider and strips the prefix', () => {
    const r = registry.resolveWithModel('groq/llama-3.3-70b-versatile');
    expect(r.provider).toBeInstanceOf(GroqProvider);
    expect(r.resolvedModel).toBe('llama-3.3-70b-versatile');
  });

  it('routes together/<org/model> to TogetherProvider, preserving the org/model id', () => {
    const r = registry.resolveWithModel('together/meta-llama/Llama-3.3-70B-Instruct-Turbo');
    expect(r.provider).toBeInstanceOf(TogetherProvider);
    expect(r.resolvedModel).toBe('meta-llama/Llama-3.3-70B-Instruct-Turbo');
  });

  it('registers all three under their provider names', () => {
    expect(registry.get('xai')).toBeInstanceOf(XaiProvider);
    expect(registry.get('groq')).toBeInstanceOf(GroqProvider);
    expect(registry.get('together')).toBeInstanceOf(TogetherProvider);
  });
});
