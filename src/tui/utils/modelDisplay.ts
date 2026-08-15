/** Human-facing model label. Keep routing slugs unchanged elsewhere. */
export function formatModelDisplay(model: string): string {
  if (model.startsWith('cortex/')) return `Cortex/${model.slice('cortex/'.length)}`;
  return model;
}
