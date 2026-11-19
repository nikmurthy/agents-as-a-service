// US dollars per million tokens. Used only to show rough running costs in the admin app.
// Check against https://www.anthropic.com/pricing when models change.
export const MODEL_PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.10, output: 0.50 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
};

/** Dollars for the given tokens, or null when the model isn't in the table. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICES[model];
  return p ? (inputTokens * p.input + outputTokens * p.output) / 1_000_000 : null;
}
