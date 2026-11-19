import { describe, expect, it } from 'vitest';

import { DismissalTrackerService } from '../src/dismissalTracker.js';

describe('DismissalTrackerService', () => {
  it('dismiss and isDismissed within cooldown', () => {
    const tracker = new DismissalTrackerService();
    tracker.dismiss('/tmp/test.jsonl', Date.now());
    expect(tracker.isDismissed('/tmp/test.jsonl')).toBe(true);
  });

  it('isDismissed returns false after cooldown', () => {
    const tracker = new DismissalTrackerService();
    const old = Date.now() - 400_000; // > DISMISSED_COOLDOWN_MS (180000)
    tracker.dismiss('/tmp/test.jsonl', old);
    expect(tracker.isDismissed('/tmp/test.jsonl')).toBe(false);
  });

  it('permanentlyDismiss prevents readoption', () => {
    const tracker = new DismissalTrackerService();
    tracker.permanentlyDismiss('/tmp/test.jsonl');
    expect(tracker.isPermanentlyDismissed('/tmp/test.jsonl')).toBe(true);
    expect(tracker.isPermanentlyDismissed('/tmp/other.jsonl')).toBe(false);
  });

  it('seedMtime and getSeededMtime round-trip', () => {
    const tracker = new DismissalTrackerService();
    tracker.seedMtime('/tmp/test.jsonl', 1000);
    expect(tracker.getSeededMtime('/tmp/test.jsonl')).toBe(1000);
    expect(tracker.hasSeededMtime('/tmp/test.jsonl')).toBe(true);
  });

  it('clearSeededMtime removes seeded value', () => {
    const tracker = new DismissalTrackerService();
    tracker.seedMtime('/tmp/test.jsonl', 1000);
    tracker.clearSeededMtime('/tmp/test.jsonl');
    expect(tracker.getSeededMtime('/tmp/test.jsonl')).toBeUndefined();
  });

  it('registerPendingClear and hasPendingClear', () => {
    const tracker = new DismissalTrackerService();
    tracker.registerPendingClear('/tmp/test.jsonl');
    expect(tracker.hasPendingClear('/tmp/test.jsonl')).toBe(true);
    tracker.clearPendingClear('/tmp/test.jsonl');
    expect(tracker.hasPendingClear('/tmp/test.jsonl')).toBe(false);
  });

  it('clearDismissal re-enables dismissed file', () => {
    const tracker = new DismissalTrackerService();
    tracker.dismiss('/tmp/test.jsonl', Date.now());
    tracker.clearDismissal('/tmp/test.jsonl');
    expect(tracker.isDismissed('/tmp/test.jsonl')).toBe(false);
  });

  it('resetAll clears all state', () => {
    const tracker = new DismissalTrackerService();
    tracker.dismiss('/tmp/a.jsonl', Date.now());
    tracker.permanentlyDismiss('/tmp/b.jsonl');
    tracker.seedMtime('/tmp/c.jsonl', 1);
    tracker.registerPendingClear('/tmp/d.jsonl');
    tracker.resetAll();
    expect(tracker.isDismissed('/tmp/a.jsonl')).toBe(false);
    expect(tracker.isPermanentlyDismissed('/tmp/b.jsonl')).toBe(false);
    expect(tracker.getSeededMtime('/tmp/c.jsonl')).toBeUndefined();
    expect(tracker.hasPendingClear('/tmp/d.jsonl')).toBe(false);
  });
});
