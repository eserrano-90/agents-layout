import { describe, expect, it } from 'vitest';

import { parseTranscriptLine } from '../src/providers/claude/transcript.js';

const line = (o: unknown) => JSON.stringify(o);

describe('parseTranscriptLine (Claude)', () => {
  it('returns null for a malformed or partial line', () => {
    expect(parseTranscriptLine('{"type":"assis')).toBeNull();
  });

  it('turns tool_use blocks into toolStart with display fields and no raw input', () => {
    const r = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu1',
              name: 'Bash',
              input: { command: 'export TOKEN=secret123 && deploy' },
            },
          ],
        },
      }),
    );
    expect(r?.events).toEqual([
      {
        kind: 'toolStart',
        toolId: 'tu1',
        toolName: 'Bash',
        statusText: 'Running: export TOKEN=secret123 && depl…',
        activity: 'typing',
        permissionExempt: false,
        spawnsSubagent: false,
        spawnsTeammate: false,
        runInBackground: false,
      },
    ]);
    // Only the truncated display text leaves the machine.
    expect(JSON.stringify(r)).not.toContain('deploy');
  });

  it('reports token usage and the model', () => {
    const r = parseTranscriptLine(
      line({
        type: 'assistant',
        message: {
          model: 'claude-x',
          usage: { input_tokens: 1200, output_tokens: 300 },
          content: [],
        },
      }),
    );
    expect(r?.events.slice(0, 2)).toEqual([
      { kind: 'tokenUsage', inputTokens: 1200, outputTokens: 300, model: 'claude-x' },
      { kind: 'modelInfo', model: 'claude-x' },
    ]);
  });

  it('a text-only assistant reply becomes textOutput without the text', () => {
    const r = parseTranscriptLine(
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello world' }] } }),
    );
    expect(r?.events).toEqual([{ kind: 'textOutput' }]);
  });

  it('tool results end tools and flag background agent launches', () => {
    const r = parseTranscriptLine(
      line({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'a', content: 'done' },
            {
              type: 'tool_result',
              tool_use_id: 'b',
              content: [{ type: 'text', text: 'Async agent launched successfully. id=1' }],
            },
          ],
        },
      }),
    );
    expect(r?.events).toEqual([
      { kind: 'toolEnd', toolId: 'a', backgroundLaunched: false },
      { kind: 'toolEnd', toolId: 'b', backgroundLaunched: true },
    ]);
  });

  it('a user prompt becomes userPrompt without the prompt text', () => {
    const r = parseTranscriptLine(
      line({ type: 'user', message: { content: 'please fix the bug' } }),
    );
    expect(r?.events).toEqual([{ kind: 'userPrompt' }]);
  });

  it('agent_progress becomes sub-agent start and end', () => {
    const start = parseTranscriptLine(
      line({
        type: 'progress',
        parentToolUseID: 'task-1',
        data: {
          type: 'agent_progress',
          message: {
            type: 'assistant',
            message: {
              content: [
                { type: 'tool_use', id: 'sub-1', name: 'Read', input: { file_path: '/a/b.ts' } },
              ],
            },
          },
        },
      }),
    );
    expect(start?.events).toEqual([
      {
        kind: 'subagentStart',
        parentToolId: 'task-1',
        toolId: 'sub-1',
        toolName: 'Read',
        statusText: 'Reading b.ts',
        permissionExempt: false,
      },
    ]);
    const end = parseTranscriptLine(
      line({
        type: 'progress',
        parentToolUseID: 'task-1',
        data: {
          type: 'agent_progress',
          message: {
            type: 'user',
            message: { content: [{ type: 'tool_result', tool_use_id: 'sub-1' }] },
          },
        },
      }),
    );
    expect(end?.events).toEqual([{ kind: 'subagentEnd', parentToolId: 'task-1', toolId: 'sub-1' }]);
  });

  it('bash_progress reports the running tool', () => {
    const r = parseTranscriptLine(
      line({ type: 'progress', parentToolUseID: 't1', data: { type: 'bash_progress' } }),
    );
    expect(r?.events).toEqual([{ kind: 'progress', toolId: 't1' }]);
  });

  it('turn_duration ends the turn and queue enqueue ends a background agent', () => {
    expect(parseTranscriptLine(line({ type: 'system', subtype: 'turn_duration' }))?.events).toEqual(
      [{ kind: 'turnEnd' }],
    );
    expect(
      parseTranscriptLine(
        line({
          type: 'queue-operation',
          operation: 'enqueue',
          content: '<tool-use-id>bg-1</tool-use-id>',
        }),
      )?.events,
    ).toEqual([{ kind: 'backgroundToolEnd', toolId: 'bg-1' }]);
  });

  it('reports team metadata separately from events', () => {
    const r = parseTranscriptLine(line({ type: 'system', teamName: 'research', agentName: 'web' }));
    expect(r?.team).toEqual({ teamName: 'research', agentName: 'web' });
  });
});
