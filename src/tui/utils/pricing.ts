/** Pricing table: [inputPerMillion, outputPerMillion] in USD */
const PRICING: Record<string, [number, number]> = {
  // Anthropic
  'claude-opus-4-6':          [15, 75],
  'claude-sonnet-4-6':        [3, 15],
  'claude-haiku-4-5-20251001': [0.8, 4],
  'claude-haiku-4-5':         [0.8, 4],
  // OpenAI
  'gpt-5.3-codex-spark':      [2, 8],
  'gpt-5.4':                  [2, 8],
  'gpt-5.3-codex':            [2, 8],
  'gpt-5.2-codex':            [2, 8],
  'gpt-5.1-codex-max':        [2, 8],
  'gpt-5.1-codex-mini':       [0.4, 1.6],
  'gpt-5-codex-mini':         [0.4, 1.6],
  'gpt-4.1':                  [2, 8],
  'gpt-4.1-mini':             [0.4, 1.6],
  'gpt-4o':                   [2.5, 10],
  'o4-mini':                  [1.1, 4.4],
  'o3-mini':                  [1.1, 4.4],
  'codex-mini-latest':        [0.4, 1.6],
  // Google
  'gemini-2.5-pro':           [1.25, 10],
  'gemini-2.5-flash':         [0.15, 0.6],
  // OpenRouter (popular models — prices match upstream + OR markup)
  'anthropic/claude-opus-4-6':    [15, 75],
  'anthropic/claude-sonnet-4-6':  [3, 15],
  'anthropic/claude-haiku-4-5':   [0.8, 4],
  'openai/gpt-4.1':               [2, 8],
  'openai/gpt-4.1-mini':          [0.4, 1.6],
  'google/gemini-2.5-pro':        [1.25, 10],
  'deepseek/deepseek-chat':       [0.27, 1.1],
  'meta-llama/llama-3.3-70b':     [0.39, 0.39],
  'mistralai/mistral-large':      [2, 6],
  'qwen/qwen3-coder':             [0.2, 0.6],
};

/** Compute cost in USD for a given model and token counts */
export function computeCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = PRICING[model];
  if (!pricing) return 0;
  const [inputRate, outputRate] = pricing;
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

/** Format cost as string */
export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}
