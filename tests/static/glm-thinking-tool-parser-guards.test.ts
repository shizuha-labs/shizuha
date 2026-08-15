/**
 * Static guards: GLM tool-call parser requires thinking ON (SCLI-54).
 *
 * 2026-07-25 shizuha1: GLM-5.2-QuantTrio-256K with think:off emitted raw
 *   <tool_call>ToolSearch("hive")</arg_value>
 * instead of structured OpenAI tool_calls — TUI idle, no tool execution.
 *
 * Root cause: defaultThinkingLevelForModel returned 'off' for all glm* and
 * settings.json thinkingLevel=off overrode profile.defaultThinkingOn=true;
 * vLLM chat_template_kwargs then sent enable_thinking=false.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getModelProfile,
  modelRequiresThinkingForTools,
  resolveThinkingLevelForModel,
  shouldEnableThinkingForRequest,
} from '../../src/provider/model-profile.js';

const repoRoot = resolve(__dirname, '../..');
function read(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('GLM thinking required for tool parser — static + behavioral', () => {
  it('GLM-5.2 / 4.7 profiles mark defaultThinkingOn', () => {
    for (const id of [
      'GLM-5.2-QuantTrio-256K',
      'cortex/GLM-5.2-QuantTrio-256K',
      'GLM-4.7',
      'vllm/GLM-4.7',
    ]) {
      expect(getModelProfile(id).defaultThinkingOn, id).toBe(true);
      expect(modelRequiresThinkingForTools(id), id).toBe(true);
    }
  });

  it('saved thinkingLevel=off cannot disable GLM tool thinking', () => {
    expect(resolveThinkingLevelForModel('GLM-5.2-QuantTrio-256K', 'off')).toBe('on');
    expect(shouldEnableThinkingForRequest('GLM-5.2-QuantTrio-256K', 'off')).toBe(true);
  });

  it('Connect auto-reply prefers email over inbound display-name username', () => {
    const source = read('src/gateway/channels/connect.ts');
    expect(source).toContain('recipientEmail ? undefined : target.username');
  });

  it('fleet gateway talk seats suppress tools and one-shot the inbox', () => {
    const source = read('src/gateway/agent-process.ts');
    expect(source).toContain('talkSeatSuppressesTools');
    expect(source).toContain('Talk seat: empty tools[]');
    expect(source).toContain("? 'none'");
  });

  it('vLLM uses shouldEnableThinkingForRequest (not thinkingLevel!==off alone)', () => {
    const source = read('src/provider/vllm.ts');
    expect(source).toContain('shouldEnableThinkingForRequest');
    // Old bug: defaultThinkingOn only when thinkingLevel !== 'off' (lets off win).
    expect(source).not.toMatch(
      /defaultThinkingOn\s*===\s*true\s*&&\s*options\.thinkingLevel\s*!==\s*['"]off['"]/,
    );
  });

  it('TUI initial thinking uses resolveThinkingLevelForModel (not hardcoded glm→off)', () => {
    const source = read('src/tui/App.tsx');
    expect(source).toContain('resolveThinkingLevelForModel');
    // Old defaultThinkingLevelForModel returned off for any slug including 'glm'
    expect(source).not.toMatch(/lower\.includes\(['"]glm['"]\)[\s\S]{0,40}return ['"]off['"]/);
  });

  it('/think off is refused for models that require thinking', () => {
    const source = read('src/tui/hooks/useSlashCommands.ts');
    expect(source).toContain('modelRequiresThinkingForTools');
    expect(source).toMatch(/tool-call parser/);
  });
});
