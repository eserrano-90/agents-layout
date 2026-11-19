import { DISMISSED_COOLDOWN_MS } from './constants.js';

export interface DismissalTracker {
  dismiss(path: string, timestamp?: number): void;
  permanentlyDismiss(path: string): void;
  clearDismissal(path: string): void;
  isDismissed(path: string): boolean;
  isPermanentlyDismissed(path: string): boolean;
  seedMtime(path: string, mtime: number): void;
  getSeededMtime(path: string): number | undefined;
  clearSeededMtime(path: string): void;
  hasSeededMtime(path: string): boolean;
  registerPendingClear(path: string, timestamp?: number): void;
  hasPendingClear(path: string): boolean;
  clearPendingClear(path: string): void;
  resetAll(): void;
}

export class DismissalTrackerService implements DismissalTracker {
  private dismissed = new Map<string, number>();
  private permanent = new Set<string>();
  private seeded = new Map<string, number>();
  private pending = new Map<string, number>();

  dismiss(path: string, timestamp = Date.now()): void {
    this.dismissed.set(path, timestamp);
  }

  clearDismissal(path: string): void {
    this.dismissed.delete(path);
  }

  isDismissed(path: string): boolean {
    const timestamp = this.dismissed.get(path);
    if (timestamp === undefined) return false;
    if (Date.now() - timestamp < DISMISSED_COOLDOWN_MS) return true;
    this.dismissed.delete(path);
    return false;
  }

  permanentlyDismiss(path: string): void {
    this.permanent.add(path);
  }

  isPermanentlyDismissed(path: string): boolean {
    return this.permanent.has(path);
  }

  seedMtime(path: string, mtime: number): void {
    this.seeded.set(path, mtime);
  }

  getSeededMtime(path: string): number | undefined {
    return this.seeded.get(path);
  }

  clearSeededMtime(path: string): void {
    this.seeded.delete(path);
  }

  hasSeededMtime(path: string): boolean {
    return this.seeded.has(path);
  }

  registerPendingClear(path: string, timestamp = Date.now()): void {
    this.pending.set(path, timestamp);
  }

  hasPendingClear(path: string): boolean {
    return this.pending.has(path);
  }

  clearPendingClear(path: string): void {
    this.pending.delete(path);
  }

  resetAll(): void {
    this.dismissed.clear();
    this.permanent.clear();
    this.seeded.clear();
    this.pending.clear();
  }
}
