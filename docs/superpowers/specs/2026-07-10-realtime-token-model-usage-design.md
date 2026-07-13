# Real-Time Token + Model Usage on Agent Characters

**Date:** 2026-07-10
**Status:** Approved design

## Goal

Show each agent's real-time token usage and model name in the office UI. Today
the token fuel gauge renders only above team agents, and model info is not
tracked anywhere. Expand the gauge to all agents and add model identity.

## Data Source

Both token usage and model come from the same Claude JSONL assistant record,
parsed in `server/src/transcriptParser.ts:86-103`:

- Tokens: `record.message.usage.{input_tokens, output_tokens}` — already
  extracted, accumulated on `AgentState`, and broadcast via `agentTokenUsage`.
- Model: `record.message.model` — not yet read. New plumbing required.

**Known limitation (not fixed here):** hooks-only mode has no transcript file,
so agents in that mode receive no tokens and no model. The overlay omits both
when absent — no breakage.

## Protocol (choice A — separate message)

Add a new `agentModelInfo` ServerMessage rather than extending
`agentTokenUsage`. Rationale: model is set-once-ish (changes only on `/model`
switch), while tokens update every turn. A separate message keeps
`agentTokenUsage` semantically "cumulative token usage" and avoids re-sending
the model string on every turn.

```
AgentModelInfo:
  type: 'agentModelInfo'   (const)
  id: integer
  model: string
required: [type, id, model]
additionalProperties: false
```

Server→client only. Added to the `ServerMessage` union in `asyncapi.yaml`;
`core/src/messages.ts` regenerated via `npm run asyncapi:generate` (CI drift
check enforces the commit).

## Server Changes

- **`server/src/types.ts`** — add `model?: string` to `AgentState`
  (`ServerAgentState`), initialized `undefined`. Not persisted (matches token
  behavior).
- **`server/src/transcriptParser.ts`** — read `record.message.model`. If it
  differs from `agent.model`, set it and broadcast `agentModelInfo`. Placed
  beside the existing token extraction.
- **`server/src/clientMessageHandler.ts`** (reconnect snapshot) — after sending
  `existingAgents`, iterate the store and re-broadcast per agent:
  `agentTokenUsage` when `inputTokens + outputTokens > 0`, and `agentModelInfo`
  when `model` is set. Fixes blank-until-next-turn on reconnect.
- **`core/asyncapi.yaml`** — define `AgentModelInfo`, add to union; regenerate
  `messages.ts`.

## Webview Changes

- **`webview-ui/src/office/types.ts`** — add `model?: string` to `Character`.
- **`webview-ui/src/office/engine/officeState.ts`** — add
  `setAgentModel(id, model)` (absolute assignment).
- **`webview-ui/src/hooks/useExtensionMessages.ts`** — handle `agentModelInfo`
  → `os.setAgentModel(id, msg.model)`.
- **`webview-ui/src/office/components/ToolOverlay.tsx`**:
  1. Fuel gauge gate `isTeamAgent && totalTokens > 0` → `totalTokens > 0`
     (all agents).
  2. Add a dim model-name text line in the label (near `folderName`), shown for
     non-sub agents when `ch.model` is set. Suppressed for sub-agents (`isSub`).
  3. Exact token number stays in the gauge tooltip (already present); model is
     the new visible text.
- **`webview-ui/src/constants.ts`** — any new label color/size constants.

### Model shortening

Strip the `claude-` prefix and any trailing `-YYYYMMDD` date, convert the
version to a dotted form:

| Raw                         | Display     |
| --------------------------- | ----------- |
| `claude-opus-4-8`           | `opus 4.8`  |
| `claude-sonnet-5`           | `sonnet 5`  |
| `claude-haiku-4-5-20251001` | `haiku 4.5` |
| anything else               | raw string  |

## Edge Cases

- **Model switch mid-session** — `agentModelInfo` re-broadcast on change.
- **Reconnect** — snapshot replay populates immediately.
- **Hooks-only mode** — no model/tokens; overlay omits model line + gauge.
- **Restored agents** — tokens/model reset until next turn (existing behavior).

## Testing

- **Server unit** (`server/__tests__/`, extend transcriptParser coverage):
  assistant record with `message.model` broadcasts `agentModelInfo` once; same
  model on next record does not re-broadcast; a different model does.
- **E2E** (`e2e/`, follow `e2e/README.md` mocking rules): mock-claude scenario
  writes JSONL with `usage` + `model`; assert a **solo** agent overlay shows the
  fuel gauge (previously team-only) and the shortened model text.
- **CI drift** — regenerated `core/src/messages.ts` committed; `e2e/README.md`
  inventory regenerated if a new spec file is added.

## Out of Scope

- Model/token support in hooks-only mode (needs hook payload changes upstream).
- Persisting tokens/model across restart.
- Cache-token / per-turn breakdown (only cumulative input+output tracked).
