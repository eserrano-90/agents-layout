import { describe, expect,it } from 'vitest';

import { SystemClockAdapter } from '../../src/infrastructure/adapters/SystemClockAdapter.js';

describe('SystemClockAdapter', () => {
  it('now() returns current time', () => {
    const clock = new SystemClockAdapter();
    const before = Date.now();
    const val = clock.now();
    const after = Date.now();
    expect(val).toBeGreaterThanOrEqual(before);
    expect(val).toBeLessThanOrEqual(after);
  });

  it('monotonic() returns non-negative value', () => {
    const clock = new SystemClockAdapter();
    expect(clock.monotonic()).toBeGreaterThanOrEqual(0);
  });
});
