import { Clock } from '../../application/ports/Clock.js';

export class SystemClockAdapter implements Clock {
  now(): number {
    return Date.now();
  }

  monotonic(): number {
    return performance.now();
  }
}
