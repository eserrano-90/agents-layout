import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentStore } from '../../src/application/ports/AgentStore.js';
import type { Clock } from '../../src/application/ports/Clock.js';
import type { FileWatcher } from '../../src/application/ports/FileWatcher.js';
import type { ScannerDismissalTracker } from '../../src/application/ports/ScannerInfrastructure.js';
import type { TimerHandle,TimerService } from '../../src/application/ports/TimerService.js';
import { FileScanningService } from '../../src/application/services/FileScanningService.js';

describe('FileScanningService', () => {
  let service: FileScanningService;
  let mockFileWatcher: FileWatcher;
  let mockTimerService: TimerService;
  let mockClock: Clock;
  let mockDismissalTracker: ScannerDismissalTracker;
  let mockAgentStore: AgentStore;
  let agentMap: Map<number, Record<string, unknown>>;
  let persistSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    agentMap = new Map();
    let nextId = 100;

    mockFileWatcher = {
      watch: vi.fn(),
      unwatch: vi.fn(),
      listFiles: vi.fn().mockReturnValue([]),
      readFileChunk: vi.fn(),
      stat: vi.fn(),
      exists: vi.fn().mockReturnValue(false),
    };

    mockTimerService = {
      setTimeout: vi.fn().mockReturnValue({ id: 1 }),
      clearTimeout: vi.fn(),
      setInterval: vi.fn().mockReturnValue({ id: 2 }),
      clearInterval: vi.fn(),
      clearAll: vi.fn(),
    };

    mockClock = {
      now: vi.fn().mockReturnValue(1000000),
      monotonic: vi.fn().mockReturnValue(100),
    };

    mockDismissalTracker = {
      dismiss: vi.fn(),
      permanentlyDismiss: vi.fn(),
      clearDismissal: vi.fn(),
      isDismissed: vi.fn().mockReturnValue(false),
      isPermanentlyDismissed: vi.fn().mockReturnValue(false),
      seedMtime: vi.fn(),
      getSeededMtime: vi.fn().mockReturnValue(undefined),
      clearSeededMtime: vi.fn(),
      hasSeededMtime: vi.fn().mockReturnValue(false),
      registerPendingClear: vi.fn(),
      hasPendingClear: vi.fn().mockReturnValue(false),
      clearPendingClear: vi.fn(),
      resetAll: vi.fn(),
    };

    persistSpy = vi.fn();

    mockAgentStore = {
      get: vi.fn((id: number) => agentMap.get(id)),
      has: vi.fn((id: number) => agentMap.has(id)),
      set: vi.fn((id: number, agent: Record<string, unknown>) => {
        agentMap.set(id, agent);
      }),
      delete: vi.fn((id: number) => agentMap.delete(id)),
      keys: vi.fn(() => agentMap.keys()),
      values: vi.fn(() => agentMap.values()),
      entries: vi.fn(() => agentMap.entries()),
      forEach: vi.fn((cb: (agent: Record<string, unknown>, id: number) => void) => {
        agentMap.forEach(cb);
      }),
      size: 0,
      nextAgentId: { current: nextId },
      on: vi.fn(),
      off: vi.fn(),
      broadcast: vi.fn(),
      persist: persistSpy,
    };
    Object.defineProperty(mockAgentStore, 'size', { get: () => agentMap.size });

    service = new FileScanningService({
      fileWatcher: mockFileWatcher,
      timerService: mockTimerService,
      clock: mockClock,
      dismissalTracker: mockDismissalTracker,
      agentStore: mockAgentStore,
    });
  });

  describe('isTrackedProjectDir', () => {
    it('returns false for untracked directory', () => {
      expect(service.isTrackedProjectDir('/untracked')).toBe(false);
    });

    it('returns true for tracked directory', () => {
      service.trackedProjectDirs.add('/tracked');
      expect(service.isTrackedProjectDir('/tracked')).toBe(true);
    });

    it('is case-insensitive', () => {
      service.trackedProjectDirs.add('/CASE');
      expect(service.isTrackedProjectDir('/case')).toBe(true);
    });
  });

  describe('ensureProjectScan', () => {
    it('seeds known files from directory', () => {
      const listFiles = vi.mocked(mockFileWatcher.listFiles).mockReturnValue([
        '/dir/session-1.jsonl',
        '/dir/session-2.jsonl',
      ]);
      const stat = vi.mocked(mockFileWatcher.stat).mockReturnValue({ size: 100, mtimeMs: 5000, birthtimeMs: 4000 });

      const timerRef = { current: null as TimerHandle | null };
      service.ensureProjectScan('/dir', timerRef, { current: 50 }, persistSpy);

      expect(listFiles).toHaveBeenCalledWith('/dir', '.jsonl');
      expect(stat).toHaveBeenCalledTimes(2);
      expect(mockDismissalTracker.seedMtime).toHaveBeenCalledWith('/dir/session-1.jsonl', 5000);
      expect(mockDismissalTracker.seedMtime).toHaveBeenCalledWith('/dir/session-2.jsonl', 5000);
      expect(service.knownJsonlFiles.has('/dir/session-1.jsonl')).toBe(true);
      expect(service.trackedProjectDirs.has('/dir')).toBe(true);
    });

    it('does not start duplicate timer', () => {
      const timerRef = { current: { id: 99 } as TimerHandle };
      service.ensureProjectScan('/dir', timerRef, { current: 50 }, persistSpy);
      expect(mockTimerService.setInterval).not.toHaveBeenCalled();
    });
  });

  describe('scanExternalDir', () => {
    it('skips directories with orphaned internal agents', () => {
      const agent = {
        id: 1,
        isExternal: false,
        projectDir: '/dir',
        jsonlFile: '/dir/missing.jsonl',
      };
      agentMap.set(1, agent as unknown as Record<string, unknown>);
      const exists = vi.mocked(mockFileWatcher.exists).mockReturnValue(false);

      service.scanExternalDir('/dir');
      expect(exists).toHaveBeenCalledWith('/dir/missing.jsonl');
      // Should return early, no adoption
    });

    it('skips dismissed files', () => {
      vi.mocked(mockFileWatcher.listFiles).mockReturnValue(['/dir/file.jsonl']);
      vi.mocked(mockDismissalTracker.isPermanentlyDismissed).mockReturnValue(true);

      service.scanExternalDir('/dir');
      expect(mockDismissalTracker.isPermanentlyDismissed).toHaveBeenCalledWith('/dir/file.jsonl');
      // No adoption
    });

    it('skips already-tracked files', () => {
      vi.mocked(mockFileWatcher.listFiles).mockReturnValue(['/dir/file.jsonl']);
      service.knownJsonlFiles.add('/dir/file.jsonl');

      service.scanExternalDir('/dir');
      // If in knownJsonlFiles, scanExternalDir returns early for it
    });
  });

  describe('reassignAgentToFile', () => {
    it('reassigns agent to new file path', () => {
      const agent: Record<string, unknown> = {
        id: 1,
        sessionId: 'old-session',
        jsonlFile: '/dir/old.jsonl',
        fileOffset: 100,
        lineBuffer: 'old',
        isExternal: true,
      };
      agentMap.set(1, agent);

      service.reassignAgentToFile(1, '/dir/new.jsonl', persistSpy);

      expect(mockDismissalTracker.permanentlyDismiss).toHaveBeenCalledWith('/dir/old.jsonl');
      expect(agent.sessionId).toBe('new');
      expect(agent.jsonlFile).toBe('/dir/new.jsonl');
      expect(agent.fileOffset).toBe(0);
      expect(agent.lineBuffer).toBe('');
      expect(persistSpy).toHaveBeenCalled();
    });
  });

  describe('startStaleExternalAgentCheck', () => {
    it('returns a timer handle', () => {
      const handle = service.startStaleExternalAgentCheck();
      expect(handle).toBeDefined();
      expect(mockTimerService.setInterval).toHaveBeenCalled();
    });

    it('skips removal when hooks are active', () => {
      vi.mocked(mockTimerService.setInterval).mockImplementation((_fn: () => void) => {
        return { id: 2 };
      });
      const handle = service.startStaleExternalAgentCheck({ current: true });
      expect(handle).toBeDefined();
    });
  });

  describe('adoptExternalSession', () => {
    it('creates an agent for a JSONL file', () => {
      vi.mocked(mockFileWatcher.stat).mockReturnValue({ size: 0, mtimeMs: 0, birthtimeMs: 0 });

      service.adoptExternalSession('/dir/file.jsonl', '/dir', { current: 42 }, persistSpy);

      expect(mockTimerService.setInterval).toHaveBeenCalled(); // startFileWatching
      expect(persistSpy).toHaveBeenCalled();
      expect(agentMap.has(42)).toBe(true);
    });
  });
});
