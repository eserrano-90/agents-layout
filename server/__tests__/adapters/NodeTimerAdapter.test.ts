import { describe, expect, it, vi } from 'vitest';

import { NodeTimerAdapter } from '../../src/infrastructure/adapters/NodeTimerAdapter.js';

describe('NodeTimerAdapter', () => {
  it('setTimeout calls fn after delay', async () => {
    const adapter = new NodeTimerAdapter();
    const fn = vi.fn();
    adapter.setTimeout(fn, 5);
    await new Promise((r) => setTimeout(r, 20));
    expect(fn).toHaveBeenCalledTimes(1);
    adapter.clearAll();
  });

  it('clearTimeout cancels pending timeout', async () => {
    const adapter = new NodeTimerAdapter();
    const fn = vi.fn();
    const handle = adapter.setTimeout(fn, 50);
    adapter.clearTimeout(handle);
    await new Promise((r) => setTimeout(r, 70));
    expect(fn).not.toHaveBeenCalled();
  });

  it('setInterval calls fn repeatedly', async () => {
    const adapter = new NodeTimerAdapter();
    const fn = vi.fn();
    const handle = adapter.setInterval(fn, 2);
    await new Promise((r) => setTimeout(r, 15));
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);
    adapter.clearInterval(handle);
    adapter.clearAll();
  });

  it('clearInterval stops interval', async () => {
    const adapter = new NodeTimerAdapter();
    const fn = vi.fn();
    const handle = adapter.setInterval(fn, 5);
    await new Promise((r) => setTimeout(r, 15));
    adapter.clearInterval(handle);
    const before = fn.call.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(fn.call.length).toBe(before);
    adapter.clearAll();
  });

  it('clearAll stops all timers', async () => {
    const adapter = new NodeTimerAdapter();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    adapter.setTimeout(fn1, 10);
    adapter.setInterval(fn2, 10);
    adapter.clearAll();
    await new Promise((r) => setTimeout(r, 30));
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).not.toHaveBeenCalled();
  });
});
