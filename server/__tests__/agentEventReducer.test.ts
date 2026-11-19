import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../core/src/ingest.js';
import { AgentEventReducer } from '../src/agentEventReducer.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  PERMISSION_TIMER_DELAY_MS,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from '../src/constants.js';

const C = 'client-a';

function tool(
  toolId: string,
  toolName = 'Bash',
  extra: Partial<Extract<AgentEvent, { kind: 'toolStart' }>> = {},
): AgentEvent {
  return {
    kind: 'toolStart',
    toolId,
    toolName,
    statusText: `Using ${toolName}`,
    activity: 'typing',
    permissionExempt: false,
    spawnsSubagent: false,
    ...extra,
  };
}

describe('AgentEventReducer', () => {
  let store: AgentStateStore;
  let reducer: AgentEventReducer;
  let msgs: Array<Record<string, unknown>>;
  const usage = { record: vi.fn() };

  const types = () => msgs.map((m) => m.type);
  const agentOf = (sessionId: string, clientId = C) => {
    const id = reducer.agentIdFor(clientId, sessionId);
    return id === undefined ? undefined : store.get(id);
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = new AgentStateStore();
    reducer = new AgentEventReducer({ store, dailyUsage: usage as never });
    msgs = [];
    store.on('broadcast', (m) => msgs.push(m));
    usage.record.mockClear();
  });

  afterEach(() => {
    reducer.dispose();
    vi.useRealTimers();
  });

  describe('sessions', () => {
    it('creates an agent on sessionStart and confirms it on a repeat', () => {
      reducer.apply(C, 's1', 'transcript', { kind: 'sessionStart', folderName: 'proj' });
      reducer.apply(C, 's1', 'hook', { kind: 'sessionStart' });
      expect(store.size).toBe(1);
      expect(agentOf('s1')).toMatchObject({ folderName: 'proj', hookDelivered: true });
    });

    it('keeps sessions from different clients apart', () => {
      reducer.apply('a', 's1', 'hook', { kind: 'sessionStart' });
      reducer.apply('b', 's1', 'hook', { kind: 'sessionStart' });
      expect(store.size).toBe(2);
      reducer.apply('a', 's1', 'hook', tool('t1'));
      expect(agentOf('s1', 'b')?.hadToolsInTurn).toBe(false);
      expect(agentOf('s1', 'a')?.hadToolsInTurn).toBe(true);
    });

    it('ignores events for a session the client never announced', () => {
      reducer.apply(C, 'ghost', 'hook', tool('t1'));
      expect(store.size).toBe(0);
      expect(msgs).toEqual([]);
    });

    it('removes the agent on sessionEnd', () => {
      reducer.apply(C, 's1', 'hook', { kind: 'sessionStart' });
      reducer.apply(C, 's1', 'hook', { kind: 'sessionEnd', reason: 'exit' });
      expect(store.size).toBe(0);
    });

    it('keeps the same character across sessionReplaced and clears its tools', () => {
      reducer.apply(C, 's1', 'transcript', { kind: 'sessionStart' });
      const id = reducer.agentIdFor(C, 's1');
      reducer.apply(C, 's1', 'transcript', tool('t1'));
      msgs.length = 0;
      reducer.apply(C, 's2', 'hook', {
        kind: 'sessionReplaced',
        previousSessionId: 's1',
        transcriptPath: '/x/s2.jsonl',
      });
      expect(reducer.agentIdFor(C, 's2')).toBe(id);
      expect(reducer.agentIdFor(C, 's1')).toBeUndefined();
      expect(types()).toContain('agentToolsClear');
      expect(store.get(id!)?.activeToolIds.size).toBe(0);
      reducer.apply(C, 's2', 'hook', tool('t2'));
      expect(store.get(id!)?.hadToolsInTurn).toBe(true);
    });
  });

  describe('hook events', () => {
    beforeEach(() => reducer.apply(C, 's1', 'hook', { kind: 'sessionStart' }));

    it('shows the status text and tool name carried by the event', () => {
      reducer.apply(
        C,
        's1',
        'hook',
        tool('hook-1', 'IndexRepo', { statusText: 'Indexing repo', activity: 'reading' }),
      );
      expect(msgs).toContainEqual(
        expect.objectContaining({
          type: 'agentToolStart',
          status: 'Indexing repo',
          toolName: 'IndexRepo',
        }),
      );
      expect(msgs).toContainEqual({
        type: 'providerCapabilities',
        readingTools: ['IndexRepo'],
        subagentToolNames: [],
      });
    });

    it('does not show sub-agent spawning tools from hooks (the transcript does)', () => {
      reducer.apply(
        C,
        's1',
        'hook',
        tool('hook-1', 'Task', { spawnsSubagent: true, permissionExempt: true }),
      );
      expect(types()).not.toContain('agentToolStart');
      expect(types()).toContain('agentStatus');
    });

    it('ends the hook tool on toolEnd(current)', () => {
      reducer.apply(C, 's1', 'hook', tool('hook-1'));
      reducer.apply(C, 's1', 'hook', { kind: 'toolEnd', toolId: 'current' });
      expect(msgs).toContainEqual({
        type: 'agentToolDone',
        id: agentOf('s1')!.id,
        toolId: 'hook-1',
      });
    });

    it('turnEnd marks waiting, awaitingInput telling Stop and idle_prompt apart', () => {
      reducer.apply(C, 's1', 'hook', { kind: 'turnEnd', awaitingInput: true });
      expect(msgs.at(-1)).toMatchObject({
        type: 'agentStatus',
        status: 'waiting',
        awaitingInput: true,
      });
    });

    it('permissionRequest shows the bubble on the agent and its sub-agents', () => {
      reducer.apply(
        C,
        's1',
        'transcript',
        tool('task-1', 'Task', { spawnsSubagent: true, permissionExempt: true }),
      );
      reducer.apply(C, 's1', 'transcript', {
        kind: 'subagentStart',
        parentToolId: 'task-1',
        toolId: 'sub-1',
        toolName: 'Bash',
        statusText: 'x',
        permissionExempt: false,
      });
      msgs.length = 0;
      reducer.apply(C, 's1', 'hook', { kind: 'permissionRequest' });
      expect(types()).toEqual(['agentToolPermission', 'subagentToolPermission']);
    });
  });

  describe('transcript events', () => {
    beforeEach(() => reducer.apply(C, 's1', 'transcript', { kind: 'sessionStart' }));

    it('accumulates token usage and feeds daily usage', () => {
      reducer.apply(C, 's1', 'transcript', {
        kind: 'tokenUsage',
        inputTokens: 1200,
        outputTokens: 300,
        model: 'claude-x',
      });
      reducer.apply(C, 's1', 'transcript', {
        kind: 'tokenUsage',
        inputTokens: 10,
        outputTokens: 5,
      });
      expect(agentOf('s1')).toMatchObject({ inputTokens: 1210, outputTokens: 305 });
      expect(usage.record).toHaveBeenCalledWith('claude-x', 1200, 300);
    });

    it('broadcasts the model only when it changes', () => {
      reducer.apply(C, 's1', 'transcript', { kind: 'modelInfo', model: 'm1' });
      reducer.apply(C, 's1', 'transcript', { kind: 'modelInfo', model: 'm1' });
      expect(types().filter((t) => t === 'agentModelInfo')).toHaveLength(1);
    });

    it('fires the heuristic permission bubble after the delay without hooks', () => {
      reducer.apply(C, 's1', 'transcript', tool('t1'));
      vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS);
      expect(types()).toContain('agentToolPermission');
    });

    it('does not fire the heuristic once hooks are flowing', () => {
      reducer.apply(C, 's1', 'hook', { kind: 'sessionStart' });
      reducer.apply(C, 's1', 'transcript', tool('t1'));
      vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS);
      expect(types()).not.toContain('agentToolPermission');
    });

    it('new transcript data cancels the heuristic timer', () => {
      reducer.apply(C, 's1', 'transcript', tool('t1'));
      vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS - 1);
      reducer.apply(C, 's1', 'transcript', { kind: 'progress' });
      vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS);
      expect(types()).not.toContain('agentToolPermission');
    });

    it('ends a text-only turn after the idle delay', () => {
      reducer.apply(C, 's1', 'transcript', { kind: 'textOutput' });
      vi.advanceTimersByTime(TEXT_IDLE_DELAY_MS);
      expect(msgs.at(-1)).toMatchObject({ type: 'agentStatus', status: 'waiting' });
    });

    it('a Task tool shows and despawns its sub-agent character', () => {
      reducer.apply(
        C,
        's1',
        'transcript',
        tool('task-1', 'Task', { spawnsSubagent: true, permissionExempt: true }),
      );
      expect(msgs).toContainEqual(
        expect.objectContaining({ type: 'agentToolStart', toolId: 'task-1' }),
      );
      reducer.apply(C, 's1', 'transcript', { kind: 'toolEnd', toolId: 'task-1' });
      expect(types()).toContain('subagentClear');
      vi.advanceTimersByTime(TOOL_DONE_DELAY_MS);
      expect(msgs).toContainEqual(
        expect.objectContaining({ type: 'agentToolDone', toolId: 'task-1' }),
      );
    });

    it('keeps a background agent alive until its result is queued', () => {
      reducer.apply(
        C,
        's1',
        'transcript',
        tool('bg-1', 'Agent', {
          spawnsSubagent: true,
          permissionExempt: true,
          runInBackground: true,
        }),
      );
      reducer.apply(C, 's1', 'transcript', {
        kind: 'toolEnd',
        toolId: 'bg-1',
        backgroundLaunched: true,
      });
      expect(types()).not.toContain('subagentClear');
      reducer.apply(C, 's1', 'transcript', { kind: 'backgroundToolEnd', toolId: 'bg-1' });
      expect(types()).toContain('subagentClear');
    });

    it('turnEnd from the transcript clears tools and marks done', () => {
      reducer.apply(C, 's1', 'transcript', tool('t1'));
      reducer.apply(C, 's1', 'transcript', { kind: 'turnEnd' });
      expect(types().slice(-2)).toEqual(['agentToolsClear', 'agentStatus']);
      expect(msgs.at(-1)).toMatchObject({ status: 'waiting', awaitingInput: false });
    });

    it('a user prompt starts a new turn', () => {
      reducer.apply(C, 's1', 'transcript', tool('t1'));
      reducer.apply(C, 's1', 'transcript', { kind: 'userPrompt' });
      expect(agentOf('s1')?.activeToolIds.size).toBe(0);
      expect(msgs.at(-1)).toMatchObject({ type: 'agentStatus', status: 'active' });
    });
  });

  describe('teams', () => {
    it('links a teammate to its lead and routes permission to it', () => {
      reducer.apply(C, 'lead', 'transcript', { kind: 'sessionStart' });
      reducer.apply(C, 'lead', 'transcript', {
        kind: 'teamInfo',
        team: { teamName: 't', isTeamLead: true },
      });
      reducer.apply(C, 'lead:web', 'transcript', {
        kind: 'sessionStart',
        team: { teamName: 't', agentName: 'web', leadSessionId: 'lead', isTeamLead: false },
      });
      const lead = agentOf('lead')!;
      const mate = agentOf('lead:web')!;
      expect(mate.leadAgentId).toBe(lead.id);
      msgs.length = 0;
      reducer.apply(C, 'lead', 'hook', { kind: 'permissionRequest' });
      expect(msgs).toEqual([{ type: 'agentToolPermission', id: mate.id }]);
    });

    it('removing the lead removes its teammates', () => {
      reducer.apply(C, 'lead', 'transcript', {
        kind: 'sessionStart',
        team: { teamName: 't', isTeamLead: true },
      });
      reducer.apply(C, 'lead:web', 'transcript', {
        kind: 'sessionStart',
        team: { teamName: 't', agentName: 'web', leadSessionId: 'lead' },
      });
      reducer.apply(C, 'lead', 'hook', { kind: 'sessionEnd' });
      expect(store.size).toBe(0);
    });
  });

  describe('reconcile', () => {
    it('makes the client agents match its snapshot', () => {
      reducer.apply(C, 'gone', 'hook', { kind: 'sessionStart' });
      reducer.apply(C, 'kept', 'hook', { kind: 'sessionStart' });
      reducer.apply('other', 'x', 'hook', { kind: 'sessionStart' });
      reducer.reconcile(C, [{ sessionId: 'kept' }, { sessionId: 'new', folderName: 'p' }]);
      expect(agentOf('gone')).toBeUndefined();
      expect(agentOf('kept')).toBeDefined();
      expect(agentOf('new')?.folderName).toBe('p');
      expect(agentOf('x', 'other')).toBeDefined();
    });

    it('restores a persisted agent id (and so its seat) when the snapshot confirms it', () => {
      reducer.setRestorable([{ id: 7, clientId: C, sessionId: 's1' }]);
      reducer.reconcile(C, [{ sessionId: 's1' }]);
      expect(reducer.agentIdFor(C, 's1')).toBe(7);
      reducer.apply(C, 's2', 'hook', { kind: 'sessionStart' });
      expect(reducer.agentIdFor(C, 's2')).toBe(8);
    });

    it('never shows persisted agents whose client does not return', () => {
      reducer.setRestorable([{ id: 7, clientId: C, sessionId: 's1' }]);
      reducer.discardRestorable(C);
      expect(store.size).toBe(0);
      reducer.reconcile(C, [{ sessionId: 's1' }]);
      expect(reducer.agentIdFor(C, 's1')).not.toBe(7);
    });
  });
});
