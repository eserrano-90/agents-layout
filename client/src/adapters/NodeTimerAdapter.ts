import type { TimerHandle, TimerService } from '../ports/Timer.js';

let nextTimerId = 1;

export class NodeTimerAdapter implements TimerService {
  private readonly timeouts = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly intervals = new Map<number, ReturnType<typeof setInterval>>();

  setTimeout(fn: () => void, delayMs: number): TimerHandle {
    const id = nextTimerId++;
    const timer = setTimeout(() => {
      this.timeouts.delete(id);
      fn();
    }, delayMs);
    this.timeouts.set(id, timer);
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    const timer = this.timeouts.get(handle.id);
    if (timer) {
      clearTimeout(timer);
      this.timeouts.delete(handle.id);
    }
  }

  setInterval(fn: () => void, intervalMs: number): TimerHandle {
    const id = nextTimerId++;
    const timer = setInterval(fn, intervalMs);
    this.intervals.set(id, timer);
    return { id };
  }

  clearInterval(handle: TimerHandle): void {
    const timer = this.intervals.get(handle.id);
    if (timer) {
      clearInterval(timer);
      this.intervals.delete(handle.id);
    }
  }

  clearAll(): void {
    for (const timer of this.timeouts.values()) clearTimeout(timer);
    for (const timer of this.intervals.values()) clearInterval(timer);
    this.timeouts.clear();
    this.intervals.clear();
  }
}
