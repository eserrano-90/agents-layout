/**
 * Claude Code transcript (JSONL) parsing.
 *
 * Turns one transcript record into normalized AgentEvents. This is the parsing
 * half of what used to be a single parse-and-mutate pass: it knows Claude's
 * record shapes and nothing about agent state. The server applies the events.
 *
 * Record types handled:
 *   assistant          tool_use blocks -> toolStart; text-only -> textOutput
 *   user               tool_result blocks -> toolEnd; a prompt -> userPrompt
 *   progress           agent_progress -> subagentStart / subagentEnd;
 *                      bash_progress / mcp_progress -> progress(toolId)
 *   system             subtype turn_duration -> turnEnd
 *   queue-operation    enqueue with a tool-use-id -> backgroundToolEnd
 * Any record may also carry token usage, the model, and team metadata.
 *
 * No prompt text, tool input or tool output is copied into an event.
 */

import type { AgentEvent } from '../../../../core/src/ingest.js';
import type { ParsedTranscriptLine } from '../../provider.js';
import { describeToolStart, formatToolStatus, isPermissionExemptTool } from './claude.js';
import { CLAUDE_ASYNC_AGENT_LAUNCH_PREFIX } from './constants.js';

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

/** Check if a tool_result block only confirms an async/background agent launch. */
function isAsyncAgentResult(block: Json): boolean {
  const content = block.content;
  if (Array.isArray(content)) {
    return content.some((item) => {
      const text = asObject(item)?.text;
      return typeof text === 'string' && text.startsWith(CLAUDE_ASYNC_AGENT_LAUNCH_PREFIX);
    });
  }
  return typeof content === 'string' && content.startsWith(CLAUDE_ASYNC_AGENT_LAUNCH_PREFIX);
}

function parseAssistant(content: unknown, events: AgentEvent[]): void {
  if (Array.isArray(content)) {
    const blocks = content.map(asObject).filter((b): b is Json => b !== undefined);
    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    if (toolUses.length > 0) {
      for (const block of toolUses) {
        if (typeof block.id !== 'string' || !block.id) continue;
        const toolName = typeof block.name === 'string' ? block.name : '';
        events.push(describeToolStart(block.id, toolName, asObject(block.input) ?? {}));
      }
    } else if (blocks.some((b) => b.type === 'text')) {
      events.push({ kind: 'textOutput' });
    }
  } else if (typeof content === 'string') {
    events.push({ kind: 'textOutput' });
  }
}

function parseUser(content: unknown, events: AgentEvent[]): void {
  if (Array.isArray(content)) {
    const blocks = content.map(asObject).filter((b): b is Json => b !== undefined);
    const results = blocks.filter((b) => b.type === 'tool_result');
    if (results.length === 0) {
      // A user record without tool results is a new prompt: a new turn starts.
      events.push({ kind: 'userPrompt' });
      return;
    }
    for (const block of results) {
      if (typeof block.tool_use_id !== 'string' || !block.tool_use_id) continue;
      events.push({
        kind: 'toolEnd',
        toolId: block.tool_use_id,
        backgroundLaunched: isAsyncAgentResult(block),
      });
    }
  } else if (typeof content === 'string' && content.trim()) {
    events.push({ kind: 'userPrompt' });
  }
}

function parseProgress(record: Json, events: AgentEvent[]): void {
  const parentToolId = record.parentToolUseID;
  if (typeof parentToolId !== 'string' || !parentToolId) return;
  const data = asObject(record.data);
  if (!data) return;

  // bash_progress / mcp_progress: the tool is executing, not stuck on a permission.
  if (data.type === 'bash_progress' || data.type === 'mcp_progress') {
    events.push({ kind: 'progress', toolId: parentToolId });
    return;
  }

  // agent_progress: a sub-agent's own assistant/user message, nested one level down.
  const msg = asObject(data.message);
  const content = asObject(msg?.message)?.content;
  if (!msg || !Array.isArray(content)) return;

  for (const raw of content) {
    const block = asObject(raw);
    if (!block) continue;
    if (msg.type === 'assistant' && block.type === 'tool_use' && typeof block.id === 'string') {
      const toolName = typeof block.name === 'string' ? block.name : '';
      events.push({
        kind: 'subagentStart',
        parentToolId,
        toolId: block.id,
        toolName,
        statusText: formatToolStatus(toolName, asObject(block.input) ?? {}),
        permissionExempt: isPermissionExemptTool(toolName),
      });
    } else if (
      msg.type === 'user' &&
      block.type === 'tool_result' &&
      typeof block.tool_use_id === 'string'
    ) {
      events.push({ kind: 'subagentEnd', parentToolId, toolId: block.tool_use_id });
    }
  }
}

export function parseTranscriptLine(line: string): ParsedTranscriptLine | null {
  let record: Json | undefined;
  try {
    record = asObject(JSON.parse(line));
  } catch {
    return null; // malformed or partial line
  }
  if (!record) return null;

  const events: AgentEvent[] = [];
  const result: ParsedTranscriptLine = { events };

  // -- Agent Teams metadata (Claude: record.teamName + record.agentName) --
  if (typeof record.teamName === 'string') {
    result.team = {
      teamName: record.teamName,
      agentName: typeof record.agentName === 'string' ? record.agentName : undefined,
    };
  }

  // -- Token usage + model --
  const message = asObject(record.message);
  const model = typeof message?.model === 'string' && message.model ? message.model : undefined;
  const usage = asObject(message?.usage);
  if (usage) {
    events.push({
      kind: 'tokenUsage',
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : 0,
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : 0,
      model,
    });
  }
  if (model) {
    events.push({ kind: 'modelInfo', model });
  }

  // Resilient content extraction: support both record.message.content and
  // record.content, since Claude Code has changed the structure across versions.
  const content = message?.content ?? record.content;

  switch (record.type) {
    case 'assistant':
      parseAssistant(content, events);
      break;
    case 'user':
      parseUser(content, events);
      break;
    case 'progress':
      parseProgress(record, events);
      break;
    case 'queue-operation': {
      // A background agent completed: the tool id is embedded in XML content.
      if (record.operation !== 'enqueue' || typeof record.content !== 'string') break;
      const match = record.content.match(/<tool-use-id>(.*?)<\/tool-use-id>/);
      if (match) events.push({ kind: 'backgroundToolEnd', toolId: match[1] });
      break;
    }
    case 'system':
      if (record.subtype === 'turn_duration') events.push({ kind: 'turnEnd' });
      break;
    default:
      break; // file-history-snapshot and other record types carry nothing we show
  }

  return result;
}
