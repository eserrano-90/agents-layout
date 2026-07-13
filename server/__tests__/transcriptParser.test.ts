import { beforeEach, describe, expect, it } from 'vitest';

import type { ServerMessage } from '../../core/src/messages.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

function makeAgent(id: number): AgentState {
  return {
    id,
    sessionId: `sess-${id}`,
    terminalRef: undefined,
    isExternal: false,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: false,
    inputTokens: 0,
    outputTokens: 0,
  } as AgentState;
}

function assistantLine(model: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { model, usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
  });
}

describe('processTranscriptLine — model extraction', () => {
  let store: AgentStateStore;
  let broadcasts: ServerMessage[];

  beforeEach(() => {
    store = new AgentStateStore();
    broadcasts = [];
    store.on('broadcast', (m) => broadcasts.push(m as unknown as ServerMessage));
    store.set(1, makeAgent(1));
  });

  function models(): ServerMessage[] {
    return broadcasts.filter((m) => m.type === 'agentModelInfo');
  }

  it('broadcasts agentModelInfo on first assistant record', () => {
    processTranscriptLine(1, assistantLine('claude-opus-4-8'), store, new Map(), new Map());
    expect(models()).toEqual([{ type: 'agentModelInfo', id: 1, model: 'claude-opus-4-8' }]);
    expect(store.get(1)?.model).toBe('claude-opus-4-8');
  });

  it('does not re-broadcast when the model is unchanged', () => {
    processTranscriptLine(1, assistantLine('claude-opus-4-8'), store, new Map(), new Map());
    processTranscriptLine(1, assistantLine('claude-opus-4-8'), store, new Map(), new Map());
    expect(models()).toHaveLength(1);
  });

  it('re-broadcasts when the model changes mid-session', () => {
    processTranscriptLine(1, assistantLine('claude-opus-4-8'), store, new Map(), new Map());
    processTranscriptLine(1, assistantLine('claude-sonnet-5'), store, new Map(), new Map());
    expect(models()).toEqual([
      { type: 'agentModelInfo', id: 1, model: 'claude-opus-4-8' },
      { type: 'agentModelInfo', id: 1, model: 'claude-sonnet-5' },
    ]);
    expect(store.get(1)?.model).toBe('claude-sonnet-5');
  });
});
