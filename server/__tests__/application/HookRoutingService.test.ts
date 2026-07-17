import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentEvent } from '../../../core/src/provider.js';
import type { AgentStore } from '../../src/application/ports/AgentStore.js';
import type { TimerService } from '../../src/application/ports/TimerService.js';
import { BroadcastService } from '../../src/application/services/BroadcastService.js';
import { HookRoutingService } from '../../src/application/services/HookRoutingService.js';
import { SessionManagementService } from '../../src/application/services/SessionManagementService.js';

describe('HookRoutingService', () => {
  let routingService: HookRoutingService;
  let mockProvider: HookProvider;
  let mockAgentStore: AgentStore;
  let sessionService: SessionManagementService;
  let broadcastService: BroadcastService;
  let broadcastSpy: ReturnType<typeof vi.fn>;
  let callbacks: Record<string, ReturnType<typeof vi.fn>>;
  let agentMap: Map<number, Record<string, unknown>>;
  let timerService: TimerService;

  beforeEach(() => {
    agentMap = new Map();

    mockProvider = {
      kind: 'hook',
      id: 'test',
      displayName: 'Test Provider',
      protocolVersion: 1,
      normalizeHookEvent: vi.fn(),
      installHooks: vi.fn(),
      uninstallHooks: vi.fn(),
      areHooksInstalled: vi.fn(),
      formatToolStatus: vi.fn().mockReturnValue('Using Read'),
      permissionExemptTools: new Set(['Read', 'Grep']),
      subagentToolNames: new Set(['Task', 'Agent']),
      readingTools: new Set(['Read', 'Grep', 'Glob']),
    };

    broadcastSpy = vi.fn();
    mockAgentStore = {
      get: vi.fn((id: number) => agentMap.get(id)),
      has: vi.fn((id: number) => agentMap.has(id)),
      set: vi.fn((id: number, agent: Record<string, unknown>) => { agentMap.set(id, agent); }),
      delete: vi.fn((id: number) => agentMap.delete(id)),
      keys: vi.fn(() => agentMap.keys()),
      values: vi.fn(() => agentMap.values()),
      entries: vi.fn(() => agentMap.entries()),
      forEach: vi.fn(),
      size: 0,
      nextAgentId: { current: 100 },
      on: vi.fn(),
      off: vi.fn(),
      broadcast: broadcastSpy,
      persist: vi.fn(),
    };
    Object.defineProperty(mockAgentStore, 'size', { get: () => agentMap.size });

    sessionService = new SessionManagementService();
    broadcastService = new BroadcastService(mockAgentStore);

    timerService = {
      setTimeout: vi.fn((_fn: () => void, _ms: number) => {
        // Real NodeTimerAdapter tracks and auto-deletes. For tests, capture the fn
        // but don't execute it (cancelPendingClear timers are the concern).
        return { id: 1 };
      }),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      clearAll: vi.fn(),
    };

    callbacks = {
      onExternalSessionDetected: vi.fn(),
      onSessionClear: vi.fn(),
      onSessionResume: vi.fn(),
      onTeammateDetected: vi.fn(),
      onTeammateRemoved: vi.fn(),
      onSessionEnd: vi.fn(),
    };

    routingService = new HookRoutingService(
      mockProvider,
      mockAgentStore,
      sessionService,
      broadcastService,
      timerService,
      callbacks,
    );
  });

  it('sessionStart for unknown session stores as pending', () => {
    const event: AgentEvent = {
      kind: 'sessionStart',
      transcriptPath: '/path/to/transcript.jsonl',
      cwd: '/project',
    };
    routingService.route('sess-abc', event);

    expect(sessionService.hasPending('sess-abc')).toBe(true);
    expect(callbacks.onExternalSessionDetected).not.toHaveBeenCalled();
  });

  it('sessionStart with source=resume calls onSessionResume', () => {
    const event: AgentEvent = {
      kind: 'sessionStart',
      source: 'resume',
      transcriptPath: '/path/old.jsonl',
      cwd: '/project',
    };
    routingService.route('sess-abc', event);

    expect(callbacks.onSessionResume).toHaveBeenCalledWith('/path/old.jsonl');
  });

  it('toolStart on registered agent broadcasts agentToolStart', () => {
    const agent = {
      id: 1,
      sessionId: 'sess-abc',
      hookDelivered: false,
      isWaiting: false,
      permissionSent: false,
      lastDataAt: 0,
      activeToolIds: new Set<string>(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
    };
    agentMap.set(1, agent);
    sessionService.register('sess-abc', 1);

    const event: AgentEvent = {
      kind: 'toolStart',
      toolId: 't1',
      toolName: 'Read',
      input: { file_path: '/test.ts' },
    };
    routingService.route('sess-abc', event);

    expect(agent.hookDelivered).toBe(true);
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('turnEnd marks agent waiting', () => {
    const agent: Record<string, unknown> = {
      id: 1,
      sessionId: 'sess-abc',
      activeToolIds: new Set(['t1']),
      activeToolStatuses: new Map([['t1', 'Reading']]),
      activeToolNames: new Map([['t1', 'Read']]),
      currentHookToolId: 't1',
      currentHookToolName: 'Read',
      isWaiting: false,
    };
    agentMap.set(1, agent);
    sessionService.register('sess-abc', 1);

    const event: AgentEvent = { kind: 'turnEnd' };
    routingService.route('sess-abc', event);

    expect(agent.isWaiting).toBe(true);
    expect((agent.activeToolIds as Set<string>).size).toBe(0);
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('sessionEnd with exit reason calls onSessionEnd', () => {
    const agent: Record<string, unknown> = { id: 1, sessionId: 'sess-abc', jsonlFile: '/file.jsonl', projectDir: '/p' };
    agentMap.set(1, agent);
    sessionService.register('sess-abc', 1);

    const event: AgentEvent = { kind: 'sessionEnd', reason: 'exit' };
    routingService.route('sess-abc', event);

    expect(callbacks.onSessionEnd).toHaveBeenCalledWith(1, 'exit');
  });

  it('sessionEnd with /clear marks pendingClear on agent', () => {
    const agent: Record<string, unknown> = { id: 1, sessionId: 'sess-abc', jsonlFile: '/file.jsonl', projectDir: '/p' };
    agentMap.set(1, agent);
    sessionService.register('sess-abc', 1);

    const event: AgentEvent = { kind: 'sessionEnd', reason: '/clear' };
    routingService.route('sess-abc', event);

    expect(agent.pendingClear).toBe(true);
    expect(callbacks.onSessionEnd).not.toHaveBeenCalled();
  });

  it('sessionEnd with /resume marks pendingClear on agent', () => {
    const agent: Record<string, unknown> = { id: 1, sessionId: 'sess-abc', jsonlFile: '/file.jsonl', projectDir: '/p' };
    agentMap.set(1, agent);
    sessionService.register('sess-abc', 1);

    const event: AgentEvent = { kind: 'sessionEnd', reason: '/resume' };
    routingService.route('sess-abc', event);

    expect(agent.pendingClear).toBe(true);
    expect(callbacks.onSessionEnd).not.toHaveBeenCalled();
  });

  it('confirms pending session on toolStart and calls onExternalSessionDetected', () => {
    sessionService.storePending('sess-new', {
      sessionId: 'sess-new',
      transcriptPath: '/path/new.jsonl',
      cwd: '/project',
    });

    const event: AgentEvent = {
      kind: 'toolStart',
      toolId: 't1',
      toolName: 'Bash',
    };
    routingService.route('sess-new', event);

    expect(callbacks.onExternalSessionDetected).toHaveBeenCalledWith(
      'sess-new',
      '/path/new.jsonl',
      '/project',
    );
  });
});
