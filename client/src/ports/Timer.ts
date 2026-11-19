export interface TimerHandle {
  id: number;
}

/** Scheduling seam so tests can drive time without real timers. */
export interface TimerService {
  setTimeout(fn: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  clearAll(): void;
}
