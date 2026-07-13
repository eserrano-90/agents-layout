/**
 * Model pricing for cost estimation (USD per 1,000,000 tokens).
 *
 * Estimation only — exact billing depends on cache reads/writes, batch
 * discounts, and tier. We track raw input/output tokens observed in the
 * transcript (the same deltas surfaced per-agent) and multiply by the rate
 * below. Cache/batch adjustments are not modeled.
 *
 * Matched by longest-prefix against the model id, then by tier keyword as a
 * fallback so date-suffixed or future minor versions still get a sensible
 * rate instead of $0.
 */

export interface ModelRate {
  /** USD per 1M input tokens */
  input: number;
  /** USD per 1M output tokens */
  output: number;
}

/** Known model-id prefixes → per-1M rates. Keep sorted longest-prefix-first is
 *  not required; lookup scans for the longest matching prefix. */
const MODEL_RATES: ReadonlyArray<readonly [prefix: string, rate: ModelRate]> = [
  ['claude-opus-4', { input: 5, output: 25 }],
  ['claude-sonnet-4', { input: 3, output: 15 }],
  ['claude-sonnet-5', { input: 3, output: 15 }],
  ['claude-haiku-4', { input: 1, output: 5 }],
  ['claude-fable-5', { input: 10, output: 50 }],
  ['claude-mythos-5', { input: 10, output: 50 }],
  ['claude-3-opus', { input: 15, output: 75 }],
  ['claude-3-5-sonnet', { input: 3, output: 15 }],
  ['claude-3-7-sonnet', { input: 3, output: 15 }],
  ['claude-3-5-haiku', { input: 1, output: 5 }],
  ['claude-3-haiku', { input: 0.25, output: 1.25 }],
];

/** Tier-keyword fallback when no prefix matches (unknown / off-by-a-version id). */
function fallbackRate(model: string): ModelRate {
  const m = model.toLowerCase();
  if (m.includes('opus')) return { input: 5, output: 25 };
  if (m.includes('haiku')) return { input: 1, output: 5 };
  if (m.includes('sonnet')) return { input: 3, output: 15 };
  return { input: 0, output: 0 };
}

/** Resolve a per-1M rate for a model id. Never throws; returns zero-rate for empty ids. */
export function rateFor(model: string | undefined): ModelRate {
  if (!model) return { input: 0, output: 0 };
  let best: ModelRate | null = null;
  let bestLen = 0;
  for (const [prefix, rate] of MODEL_RATES) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = rate;
      bestLen = prefix.length;
    }
  }
  return best ?? fallbackRate(model);
}

/** Estimated USD cost for a token count on a given model. */
export function costFor(model: string | undefined, inputTokens: number, outputTokens: number): number {
  const rate = rateFor(model);
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}
