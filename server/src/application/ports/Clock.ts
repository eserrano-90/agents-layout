export interface Clock {
  now(): number;
  monotonic(): number;
}
