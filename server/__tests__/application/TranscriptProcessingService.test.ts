import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HookProvider } from '../../../core/src/provider.js';
import type { AgentStore } from '../../src/application/ports/AgentStore.js';
import type { TimerService } from '../../src/application/ports/TimerService.js';
import { BroadcastService } from '../../src/application/services/BroadcastService.js';
import { TranscriptProcessingService } from '../../src/application/services/TranscriptProcessingService.js';

describe('TranscriptProcessingService', () => {
  let service: TranscriptProcessingService;
  let mockProvider: HookProvider;
  let mockAgentStore: AgentStore;
  let broadcastSpy: ReturnType<typeof vi.fn>;
  let agent: Record<string, unknown>;
  let timerService: TimerService;

  beforeEach(() => {
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

    timerService = {
      setTimeout: vi.fn().mockReturnValue({ id: 1 }),
      clearTimeout: vi.fn(),
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      clearAll: vi.fn(),
    };

    agent = {
      id: 1,
      sessionId: 'sess-abc',
      activeToolIds: new Set<string>(),
      activeToolStatuses: new Map<string, string>(),
      activeToolNames: new Map<string, string>(),
      activeSubagentToolIds: new Map<string, Set<string>>(),
      activeSubagentToolNames: new Map<string, Map<string, string>>(),
      backgroundAgentToolIds: new Set<string>(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: 0,
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set<string>(),
      hookDelivered: false,
      inputTokens: 0,
      outputTokens: 0,
    };

    const agentMap = new Map<number, Record<string, unknown>>();
    agentMap.set(1, agent);

    mockAgentStore = {
      get: vi.fn((id: number) => agentMap.get(id)),
      has: vi.fn((id: number) => agentMap.has(id)),
      set: vi.fn(),
      delete: vi.fn(),
      keys: vi.fn(() => agentMap.keys()),
      values: vi.fn(() => agentMap.values()),
      entries: vi.fn(() => agentMap.entries()),
      forEach: vi.fn(),
      size: 1,
      nextAgentId: { current: 100 },
      on: vi.fn(),
      off: vi.fn(),
      broadcast: broadcastSpy,
      persist: vi.fn(),
    };

    service = new TranscriptProcessingService(
      mockProvider,
      mockAgentStore,
      new BroadcastService(mockAgentStore),
      timerService,
    );
  });

  it('ignores malformed JSON', () => {
    service.processLine(1, 'not json');
    // No crash, no state change
    expect(agent.linesProcessed).toBe(0);
  });

  it('handles assistant tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', id: 't1', input: { file_path: '/test.ts' } }],
    });
    service.processLine(1, line);

    expect((agent.activeToolIds as Set<string>).has('t1')).toBe(true);
    expect((agent.activeToolNames as Map<string, string>).get('t1')).toBe('Read');
    expect(agent.hadToolsInTurn).toBe(true);
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('handles assistant Text-only message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      content: 'Hello, how can I help?',
    });
    service.processLine(1, line);

    expect(agent.hadToolsInTurn).toBe(false);
  });

  it('handles subagent tool via Agent/Task tool_use', () => {
    const line = JSON.stringify({
      type: 'assistant',
      content: [{ type: 'tool_use', name: 'Task', id: 't1', input: { task: 'research' } }],
    });
    service.processLine(1, line);

    expect((agent.backgroundAgentToolIds as Set<string>).has('t1')).toBe(true);
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('handles user text prompt — resets turn state', () => {
    (agent.activeToolIds as Set<string>).add('t1');
    (agent.activeToolStatuses as Map<string, string>).set('t1', 'Reading');
    (agent.activeToolNames as Map<string, string>).set('t1', 'Read');

    const line = JSON.stringify({
      type: 'user',
      content: 'Can you fix this?',
    });
    service.processLine(1, line);

    expect((agent.activeToolIds as Set<string>).size).toBe(0);
    expect((agent.activeToolStatuses as Map<string, string>).size).toBe(0);
    expect(agent.hadToolsInTurn).toBe(false);
  });

  it('handles user tool_result — removes tool', () => {
    (agent.activeToolIds as Set<string>).add('t1');
    (agent.activeToolNames as Map<string, string>).set('t1', 'Read');

    const line = JSON.stringify({
      type: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file content' }],
    });
    service.processLine(1, line);

    expect((agent.activeToolIds as Set<string>).has('t1')).toBe(false);
  });

  it('handles system turn_duration — clears tools', () => {
    (agent.activeToolIds as Set<string>).add('t1');
    const line = JSON.stringify({
      type: 'system',
      subtype: 'turn_duration',
      duration_ms: 5000,
    });
    service.processLine(1, line);

    expect((agent.activeToolIds as Set<string>).size).toBe(0);
    expect(broadcastSpy).toHaveBeenCalled();
  });

  it('handles progress agent_progress — tracks sub-tools', () => {
    const line = JSON.stringify({
      type: 'progress',
      data: {
        type: 'agent_progress',
        parent_tool_id: 't1',
        content: [{ type: 'tool_use', name: 'Bash', id: 'sub1', input: { command: 'ls' } }],
      },
    });
    service.processLine(1, line);

    const subagentIds = (agent.activeSubagentToolIds as Map<string, Set<string>>).get('t1');
    expect(subagentIds?.has('sub1')).toBe(true);
  });

  it('handles queue-operation enqueue', () => {
    const line = JSON.stringify({
      type: 'queue-operation',
      operation: 'enqueue',
      content: 'Background task completed: <tool-use-id>t1</tool-use-id>',
    });
    service.processLine(1, line);

    expect(broadcastSpy).toHaveBeenCalled();
  });
});
