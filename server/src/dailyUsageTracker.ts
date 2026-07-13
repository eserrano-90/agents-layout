/**
 * DailyUsageTracker: global (cross-agent) token + cost accounting bucketed by
 * calendar day and model. Persists to ~/.pixel-agents/usage.json so totals
 * survive restarts, and broadcasts the current day's aggregate whenever it
 * changes or a client (re)connects.
 *
 * Tokens are the raw input/output deltas observed in transcripts (the same
 * increments surfaced per-agent). Cost is estimated via pricing.ts. History for
 * past days is retained in the file but only today's total is broadcast.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR, USAGE_FILE_NAME } from './constants.js';
import { costFor } from './pricing.js';

interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
}

/** Per-day bucket: model id → accumulated tokens. */
type DayBucket = Record<string, ModelTokens>;

interface UsageFile {
  /** date (YYYY-MM-DD, local) → model → tokens */
  days: Record<string, DayBucket>;
}

/** Broadcast shape for the current day (mirrors DailyUsage in asyncapi.yaml). */
export interface DailyUsageSnapshot {
  date: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  models: Array<{ model: string; inputTokens: number; outputTokens: number; costUsd: number }>;
}

/** Local calendar day as YYYY-MM-DD (not UTC — matches what the user sees). */
function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class DailyUsageTracker {
  private readonly filePath: string;
  private data: UsageFile = { days: {} };
  private onChange: ((snapshot: DailyUsageSnapshot) => void) | null = null;

  constructor() {
    this.filePath = path.join(os.homedir(), LAYOUT_FILE_DIR, USAGE_FILE_NAME);
    this.load();
  }

  /** Register the broadcast callback. Called on every recorded delta. */
  setOnChange(cb: (snapshot: DailyUsageSnapshot) => void): void {
    this.onChange = cb;
  }

  /** Record a token delta for a model against today's bucket, persist, broadcast. */
  record(model: string | undefined, inputDelta: number, outputDelta: number): void {
    if (!inputDelta && !outputDelta) return;
    const modelKey = model && model.length > 0 ? model : 'unknown';
    const today = localDay(new Date());
    const bucket = (this.data.days[today] ??= {});
    const entry = (bucket[modelKey] ??= { inputTokens: 0, outputTokens: 0 });
    entry.inputTokens += Math.max(0, inputDelta);
    entry.outputTokens += Math.max(0, outputDelta);
    this.save();
    this.onChange?.(this.snapshot());
  }

  /** Current day's aggregate (tokens + estimated cost, per-model and total). */
  snapshot(): DailyUsageSnapshot {
    const date = localDay(new Date());
    const bucket = this.data.days[date] ?? {};
    const models: DailyUsageSnapshot['models'] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    for (const [model, tokens] of Object.entries(bucket)) {
      const cost = costFor(model, tokens.inputTokens, tokens.outputTokens);
      models.push({
        model,
        inputTokens: tokens.inputTokens,
        outputTokens: tokens.outputTokens,
        costUsd: cost,
      });
      inputTokens += tokens.inputTokens;
      outputTokens += tokens.outputTokens;
      costUsd += cost;
    }
    models.sort((a, b) => b.costUsd - a.costUsd);
    return { date, inputTokens, outputTokens, costUsd, models };
  }

  // ── File I/O ────────────────────────────────────────────────

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<UsageFile>;
      if (parsed.days && typeof parsed.days === 'object') {
        this.data = { days: parsed.days as Record<string, DayBucket> };
      }
    } catch (err) {
      console.error('[Pixel Agents] Failed to read usage file:', err);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const json = JSON.stringify(this.data, null, 2);
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      console.error('[Pixel Agents] Failed to write usage file:', err);
    }
  }
}
