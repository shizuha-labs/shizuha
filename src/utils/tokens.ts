import { encoding_for_model, type TiktokenModel } from 'tiktoken';

const encoderCache = new Map<string, ReturnType<typeof encoding_for_model>>();

function getEncoder(model: string) {
  let cached = encoderCache.get(model);
  if (cached) return cached;

  // Map model families to tiktoken models
  let tiktokenModel: TiktokenModel = 'gpt-4o';
  if (model.includes('claude')) tiktokenModel = 'gpt-4o'; // cl100k approximation
  if (model.includes('gpt-5') || model.includes('codex')) tiktokenModel = 'gpt-4o'; // o200k
  if (model.includes('gpt-4')) tiktokenModel = 'gpt-4o';
  if (model.includes('gpt-3.5')) tiktokenModel = 'gpt-3.5-turbo';

  try {
    cached = encoding_for_model(tiktokenModel);
  } catch {
    cached = encoding_for_model('gpt-4o');
  }
  encoderCache.set(model, cached);
  return cached;
}

/** Approximate token count for a string */
export function countTokens(text: string, model = 'gpt-4o'): number {
  try {
    const enc = getEncoder(model);
    return enc.encode(text).length;
  } catch {
    // Rough fallback: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}
