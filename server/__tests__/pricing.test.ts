import { describe, expect, it } from 'vitest';

import { costFor, rateFor } from '../src/pricing.js';

describe('pricing', () => {
  it('resolves known model prefixes to per-1M rates', () => {
    expect(rateFor('claude-opus-4-8')).toEqual({ input: 5, output: 25 });
    expect(rateFor('claude-sonnet-5')).toEqual({ input: 3, output: 15 });
    expect(rateFor('claude-haiku-4-5-20251001')).toEqual({ input: 1, output: 5 });
    expect(rateFor('claude-fable-5')).toEqual({ input: 10, output: 50 });
  });

  it('prefers the longest matching prefix', () => {
    // claude-3-5-haiku must win over a shorter accidental match
    expect(rateFor('claude-3-5-haiku-20241022')).toEqual({ input: 1, output: 5 });
    expect(rateFor('claude-3-opus-20240229')).toEqual({ input: 15, output: 75 });
  });

  it('falls back by tier keyword for unknown ids', () => {
    expect(rateFor('claude-opus-9-future')).toEqual({ input: 5, output: 25 });
    expect(rateFor('some-sonnet-thing')).toEqual({ input: 3, output: 15 });
    expect(rateFor('mystery-haiku')).toEqual({ input: 1, output: 5 });
  });

  it('returns zero rate for empty/unrecognized ids', () => {
    expect(rateFor(undefined)).toEqual({ input: 0, output: 0 });
    expect(rateFor('')).toEqual({ input: 0, output: 0 });
    expect(rateFor('gpt-4')).toEqual({ input: 0, output: 0 });
  });

  it('computes cost from token counts', () => {
    // 1M input + 1M output on opus-4-8 = $5 + $25 = $30
    expect(costFor('claude-opus-4-8', 1_000_000, 1_000_000)).toBeCloseTo(30, 6);
    // 500k input on sonnet-5 = $1.50
    expect(costFor('claude-sonnet-5', 500_000, 0)).toBeCloseTo(1.5, 6);
    expect(costFor(undefined, 1_000_000, 1_000_000)).toBe(0);
  });
});
