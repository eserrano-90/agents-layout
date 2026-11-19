import * as fs from 'fs';
import * as path from 'path';

import type { FileStats, FileWatcher, WatcherHandle, WatchOptions } from '../ports/FileWatcher.js';

let nextWatcherId = 1;

export class NodeFileWatcherAdapter implements FileWatcher {
  watch(filePath: string, options: WatchOptions): WatcherHandle {
    const id = nextWatcherId++;
    const interval = setInterval(() => {
      try {
        const stat = fs.statSync(filePath);
        if (stat.size > 0) {
          options.onData(id, filePath);
        }
      } catch {
        options.onError(id, new Error(`Cannot stat ${filePath}`));
      }
    }, options.intervalMs);

    const handle: WatcherHandle = {
      id,
      path: filePath,
      close() {
        clearInterval(interval);
      },
    };
    return handle;
  }

  unwatch(handle: WatcherHandle): void {
    handle.close();
  }

  listFiles(dir: string, extension: string): string[] {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(extension))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  listDirectories(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name));
    } catch {
      return [];
    }
  }

  readFileChunk(filePath: string, offset: number, length: number): Buffer | null {
    try {
      const buf = Buffer.alloc(length);
      const fd = fs.openSync(filePath, 'r');
      const bytesRead = fs.readSync(fd, buf, 0, length, offset);
      fs.closeSync(fd);
      return buf.subarray(0, bytesRead);
    } catch {
      return null;
    }
  }

  stat(filePath: string): FileStats | null {
    try {
      const s = fs.statSync(filePath);
      return { size: s.size, mtimeMs: s.mtimeMs, birthtimeMs: s.birthtimeMs };
    } catch {
      return null;
    }
  }

  exists(filePath: string): boolean {
    try {
      fs.statSync(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
