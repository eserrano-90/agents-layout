import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DailyUsageTracker } from '../src/dailyUsageTracker.js';

describe('DailyUsageTracker', () => {
  let tempHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-usage-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('accumulates tokens per model and computes cost', () => {
    const t = new DailyUsageTracker();
    t.record('claude-opus-4-8', 1_000_000, 200_000);
    t.record('claude-opus-4-8', 0, 800_000);
    t.record('claude-sonnet-5', 1_000_000, 0);

    const snap = t.snapshot();
    expect(snap.inputTokens).toBe(2_000_000);
    expect(snap.outputTokens).toBe(1_000_000);
    // opus: 1M*5 + 1M*25 = $30 ; sonnet: 1M*3 = $3 → $33
    expect(snap.costUsd).toBeCloseTo(33, 6);
    expect(snap.models).toHaveLength(2);
    // sorted by cost desc → opus first
    expect(snap.models[0].model).toBe('claude-opus-4-8');
  });

  it('ignores zero deltas', () => {
    const t = new DailyUsageTracker();
    t.record('claude-opus-4-8', 0, 0);
    expect(t.snapshot().inputTokens).toBe(0);
    expect(t.snapshot().models).toHaveLength(0);
  });

  it('fires onChange with the current snapshot on record', () => {
    const t = new DailyUsageTracker();
    const seen: number[] = [];
    t.setOnChange((s) => seen.push(s.inputTokens));
    t.record('claude-opus-4-8', 100, 0);
    t.record('claude-opus-4-8', 50, 0);
    expect(seen).toEqual([100, 150]);
  });

  it('persists across instances (same HOME)', () => {
    const t1 = new DailyUsageTracker();
    t1.record('claude-haiku-4-5', 500, 500);
    const t2 = new DailyUsageTracker();
    const snap = t2.snapshot();
    expect(snap.inputTokens).toBe(500);
    expect(snap.outputTokens).toBe(500);
  });

  it('buckets unknown model under "unknown"', () => {
    const t = new DailyUsageTracker();
    t.record(undefined, 1000, 0);
    const snap = t.snapshot();
    expect(snap.models[0].model).toBe('unknown');
    expect(snap.costUsd).toBe(0);
  });
});
