export interface ScannerDismissalTracker {
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

export interface ScannerInfrastructure {
  readonly fileWatchers: Map<number, { close(): void }>;
  readonly pollingTimers: Map<number, ReturnType<typeof setInterval>>;
  readonly jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>;
  readonly waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  readonly permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  readonly knownJsonlFiles: Set<string>;
  readonly dismissalTracker: ScannerDismissalTracker;
}
