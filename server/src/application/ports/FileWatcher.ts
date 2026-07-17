export interface WatcherHandle {
  id: number;
  path: string;
  close(): void;
}

export interface WatchOptions {
  intervalMs: number;
  onData(agentId: number, data: string): void;
  onError(agentId: number, error: Error): void;
}

export interface FileStats {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}

export interface FileWatcher {
  watch(path: string, options: WatchOptions): WatcherHandle;
  unwatch(handle: WatcherHandle): void;
  listFiles(dir: string, extension: string): string[];
  readFileChunk(path: string, offset: number, length: number): Buffer | null;
  stat(path: string): FileStats | null;
  exists(path: string): boolean;
}
