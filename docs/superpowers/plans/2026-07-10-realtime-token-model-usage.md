# Real-Time Token + Model Usage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each agent's real-time model name and cumulative token usage in the office UI — expand the token fuel gauge from team-only to all agents, and add model-name tracking end-to-end (JSONL → server → protocol → webview overlay).

**Architecture:** Model is carried by a new `agentModelInfo` ServerMessage, extracted from the same JSONL assistant record that already yields token usage (`transcriptParser.ts`). Server stores `model?` on `AgentState`, broadcasts on change, and replays a token+model snapshot on webview reconnect. The webview stores `model?` on `Character`, and `ToolOverlay` drops the team-only gate on the fuel gauge and renders a shortened model name.

**Tech Stack:** TypeScript, Fastify (server), React 19 + Canvas (webview), AsyncAPI 3.0 + Modelina codegen, Vitest (server unit), Playwright (e2e).

## Global Constraints

- **No `enum`** in webview (`erasableSyntaxOnly`) — use `as const` objects. Server may use interfaces/types only.
- **`import type`** for type-only imports (webview `verbatimModuleSyntax`; convention in server).
- **`.js` extensions** on all relative imports in `core/` and `server/` (Node16 resolution).
- **`noUnusedLocals` / `noUnusedParameters`** strict everywhere.
- **`core/src/messages.ts` is AUTO-GENERATED** — never hand-edit. Edit `core/asyncapi.yaml`, then run `npm run asyncapi:generate`. CI runs the generator + `git diff --exit-code core/src/messages.ts`; a non-empty diff fails the build.
- **No inline colors/shadows/fonts** in webview outside `constants.ts` — custom ESLint rules block PRs (`no-inline-colors`, `pixel-shadow`, `pixel-font`).
- **AsyncAPI pinned to 3.0.0** — do not bump the version field.
- Commit after each task. End commit messages with the `Co-Authored-By` trailer used in this repo.

---

## File Structure

- `core/asyncapi.yaml` — add `AgentModelInfo` schema + union entry (source of truth).
- `core/src/messages.ts` — regenerated; gains `AgentModelInfo` interface + union member.
- `server/src/types.ts` — `model?: string` on `AgentState`.
- `server/src/transcriptParser.ts` — extract `record.message.model`, broadcast `agentModelInfo` on change.
- `server/src/clientMessageHandler.ts` — reconnect snapshot: replay `agentTokenUsage` + `agentModelInfo`.
- `server/__tests__/transcriptParser.test.ts` — NEW. Model extraction/broadcast unit tests.
- `webview-ui/src/office/types.ts` — `model?: string` on `Character`.
- `webview-ui/src/office/engine/officeState.ts` — `setAgentModel(id, model)`.
- `webview-ui/src/office/toolUtils.ts` (or new `webview-ui/src/office/modelLabel.ts`) — `shortenModelName(model)` pure fn + its unit test.
- `webview-ui/src/hooks/useExtensionMessages.ts` — handle `agentModelInfo`.
- `webview-ui/src/office/components/ToolOverlay.tsx` — drop team gate on gauge; render shortened model line.
- `e2e/` — solo-agent gauge + model assertion (scenario + spec).

---

## Task 1: Add `agentModelInfo` to the protocol

**Files:**
- Modify: `core/asyncapi.yaml` (union near line 101; schema near line 402, after `AgentTokenUsage`)
- Modify (generated): `core/src/messages.ts`

**Interfaces:**
- Produces: `AgentModelInfo { type: 'agentModelInfo'; id: number; model: string }`, added to the `ServerMessage` union.

- [ ] **Step 1: Add the schema + union entry to the yaml**

In `core/asyncapi.yaml`, add to the ServerMessage message-channel `oneOf` union (the block containing `- $ref: '#/components/schemas/AgentTokenUsage'`, around line 101):

```yaml
        - $ref: '#/components/schemas/AgentModelInfo'
```

Then add the schema in `components.schemas`, immediately after the `AgentTokenUsage` block (after line 415):

```yaml
    AgentModelInfo:
      description: The model backing the agent's current session (e.g. claude-opus-4-8). Re-sent when the model changes mid-session.
      type: object
      additionalProperties: false
      required: [type, id, model]
      properties:
        type:
          const: agentModelInfo
        id:
          type: integer
        model:
          type: string
```

- [ ] **Step 2: Validate the spec**

Run: `npm run asyncapi:validate`
Expected: PASS (no schema errors).

- [ ] **Step 3: Regenerate the TS bindings**

Run: `npm run asyncapi:generate`
Expected: `core/src/messages.ts` now contains `export interface AgentModelInfo` and `| AgentModelInfo` in the `ServerMessage` union.

- [ ] **Step 4: Verify the generated diff is what we expect**

Run: `git diff core/src/messages.ts`
Expected: only additions — a new `AgentModelInfo` interface and the union member. No unrelated churn.

- [ ] **Step 5: Type-check**

Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add core/asyncapi.yaml core/src/messages.ts
git commit -m "$(cat <<'EOF'
feat(protocol): add agentModelInfo server message

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Track + broadcast model on the server

**Files:**
- Modify: `server/src/types.ts:51-52` (add field near `inputTokens`/`outputTokens`)
- Modify: `server/src/transcriptParser.ts:86-103` (extract model beside token usage)
- Create: `server/__tests__/transcriptParser.test.ts`

**Interfaces:**
- Consumes: `AgentModelInfo` (Task 1); `AgentStateStore.broadcast`, `AgentStateStore.set/get`, `AgentStateStore.on('broadcast', cb)`.
- Produces: `AgentState.model?: string`; `processTranscriptLine` broadcasts `{ type: 'agentModelInfo', id, model }` when the parsed record's `message.model` differs from the stored value.

- [ ] **Step 1: Add the field to `AgentState`**

In `server/src/types.ts`, under the `// -- Token tracking --` group (after line 52 `outputTokens: number;`), add:

```typescript
  /** Model backing the current session (e.g. "claude-opus-4-8"); undefined until first assistant record. */
  model?: string;
```

- [ ] **Step 2: Write the failing test**

Create `server/__tests__/transcriptParser.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';
import type { ServerMessage } from '../../core/src/messages.js';

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
    store.on('broadcast', (m) => broadcasts.push(m));
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:server -- transcriptParser`
Expected: FAIL — no `agentModelInfo` broadcasts (model extraction not implemented yet).

- [ ] **Step 4: Implement model extraction**

In `server/src/transcriptParser.ts`, inside the `// -- Token usage extraction from assistant records --` block, immediately after the closing `}` of the `if (usage) { ... }` (after line 103), add:

```typescript
    // -- Model extraction from assistant records --
    const model = record.message?.model as string | undefined;
    if (typeof model === 'string' && model.length > 0 && model !== agent.model) {
      agent.model = model;
      agents.broadcast({ type: 'agentModelInfo', id: agentId, model });
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:server -- transcriptParser`
Expected: PASS (3 tests).

- [ ] **Step 6: Type-check**

Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/types.ts server/src/transcriptParser.ts server/__tests__/transcriptParser.test.ts
git commit -m "$(cat <<'EOF'
feat(server): extract and broadcast agent model from transcript

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Replay token + model snapshot on reconnect

**Files:**
- Modify: `server/src/clientMessageHandler.ts:202-221` (after the `existingAgents` send)

**Interfaces:**
- Consumes: `AgentTokenUsage`, `AgentModelInfo`; the `store` iterator (`for (const [id, agent] of store)`); the local `send` function already in scope in this handler.
- Produces: per-agent replay broadcasts sent to the just-connected client.

- [ ] **Step 1: Add the snapshot replay**

In `server/src/clientMessageHandler.ts`, immediately after the `send({ type: 'existingAgents', ... })` call (after line 221, before the closing `}` at line 222), add:

```typescript
  // Replay per-agent token + model snapshot so a reconnecting client shows
  // current values immediately instead of blank-until-next-turn.
  for (const [id, agent] of store) {
    const total = agent.inputTokens + agent.outputTokens;
    if (total > 0) {
      send({
        type: 'agentTokenUsage',
        id,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }
    if (agent.model) {
      send({ type: 'agentModelInfo', id, model: agent.model });
    }
  }
```

- [ ] **Step 2: Type-check**

Run: `npm run check-types`
Expected: PASS.

- [ ] **Step 3: Run the full server suite (guard against regressions in the handler)**

Run: `npm run test:server`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/clientMessageHandler.ts
git commit -m "$(cat <<'EOF'
feat(server): replay token + model snapshot on webview reconnect

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Model-name shortening (pure fn + test)

**Files:**
- Create: `webview-ui/src/office/modelLabel.ts`
- Create: `webview-ui/test/modelLabel.test.ts`

**Interfaces:**
- Produces: `shortenModelName(model: string): string`.

Shortening rules: strip a leading `claude-`; strip a trailing `-YYYYMMDD` (8-digit date); the remaining `name-major[-minor]` renders as `name major.minor` (or `name major`). Unrecognized shapes return the raw input.

- [ ] **Step 1: Write the failing test**

Create `webview-ui/test/modelLabel.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { shortenModelName } from '../src/office/modelLabel.js';

describe('shortenModelName', () => {
  it('shortens opus with major.minor', () => {
    expect(shortenModelName('claude-opus-4-8')).toBe('opus 4.8');
  });
  it('shortens sonnet with major only', () => {
    expect(shortenModelName('claude-sonnet-5')).toBe('sonnet 5');
  });
  it('strips a trailing date', () => {
    expect(shortenModelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
  });
  it('returns unrecognized input unchanged', () => {
    expect(shortenModelName('gpt-4o')).toBe('gpt-4o');
  });
  it('handles empty string', () => {
    expect(shortenModelName('')).toBe('');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:webview -- modelLabel`
Expected: FAIL — module `../src/office/modelLabel.js` not found.

- [ ] **Step 3: Implement the pure function**

Create `webview-ui/src/office/modelLabel.ts`:

```typescript
/**
 * Shorten a raw Claude model id into a compact label for the office overlay.
 * "claude-opus-4-8" -> "opus 4.8", "claude-sonnet-5" -> "sonnet 5",
 * "claude-haiku-4-5-20251001" -> "haiku 4.5". Unrecognized shapes pass through.
 */
export function shortenModelName(model: string): string {
  if (!model) return model;
  let s = model.startsWith('claude-') ? model.slice('claude-'.length) : model;
  // Drop a trailing -YYYYMMDD date segment.
  s = s.replace(/-\d{8}$/, '');
  const m = /^([a-z]+)-(\d+)(?:-(\d+))?$/.exec(s);
  if (!m) return model;
  const [, name, major, minor] = m;
  return minor ? `${name} ${major}.${minor}` : `${name} ${major}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:webview -- modelLabel`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/modelLabel.ts webview-ui/test/modelLabel.test.ts
git commit -m "$(cat <<'EOF'
feat(webview): add shortenModelName label helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Store model on the webview Character

**Files:**
- Modify: `webview-ui/src/office/types.ts:212-215` (Character token fields block)
- Modify: `webview-ui/src/office/engine/characters.ts:92-93` (createCharacter init)
- Modify: `webview-ui/src/office/engine/officeState.ts:894-899` (near setAgentTokens)
- Modify: `webview-ui/src/hooks/useExtensionMessages.ts:521-524` (message handler)

**Interfaces:**
- Consumes: `AgentModelInfo` (Task 1).
- Produces: `Character.model?: string`; `OfficeState.setAgentModel(id: number, model: string): void`.

- [ ] **Step 1: Add `model` to the `Character` interface**

In `webview-ui/src/office/types.ts`, after `outputTokens: number;` (line 215), add:

```typescript
  /** Model backing this agent's session (raw id, e.g. "claude-opus-4-8"); undefined until known */
  model?: string;
```

- [ ] **Step 2: Add the `setAgentModel` setter**

In `webview-ui/src/office/engine/officeState.ts`, immediately after the `setAgentTokens` method (after line 899), add:

```typescript
  setAgentModel(id: number, model: string): void {
    const ch = this.characters.get(id);
    if (!ch) return;
    ch.model = model;
  }
```

- [ ] **Step 3: Handle the message in the webview**

In `webview-ui/src/hooks/useExtensionMessages.ts`, extend the token branch (lines 521-524). Replace:

```typescript
      } else if (msg.type === 'agentTokenUsage') {
        const id = msg.id as number;
        os.setAgentTokens(id, msg.inputTokens as number, msg.outputTokens as number);
      }
```

with:

```typescript
      } else if (msg.type === 'agentTokenUsage') {
        const id = msg.id as number;
        os.setAgentTokens(id, msg.inputTokens as number, msg.outputTokens as number);
      } else if (msg.type === 'agentModelInfo') {
        os.setAgentModel(msg.id as number, msg.model as string);
      }
```

- [ ] **Step 4: Verify `createCharacter` needs no change**

`model` is optional (`model?`), so `createCharacter` in `characters.ts:92-93` does not need to initialize it. Confirm no non-optional access exists yet.

Run: `npm run check-types`
Expected: PASS (optional field, no required init).

- [ ] **Step 5: Commit**

```bash
git add webview-ui/src/office/types.ts webview-ui/src/office/engine/officeState.ts webview-ui/src/hooks/useExtensionMessages.ts
git commit -m "$(cat <<'EOF'
feat(webview): store agent model on Character via agentModelInfo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Render gauge for all agents + model line in the overlay

**Files:**
- Modify: `webview-ui/src/office/components/ToolOverlay.tsx` (import line 4-20; gauge gate line 271; label block lines 228-255)

**Interfaces:**
- Consumes: `Character.model` (Task 5), `shortenModelName` (Task 4).

- [ ] **Step 1: Import the shortener**

In `webview-ui/src/office/components/ToolOverlay.tsx`, add to the imports (after line 21 `import type { SubagentCharacter } ...`, keeping import ordering consistent with the file):

```typescript
import { shortenModelName } from '../modelLabel.js';
```

- [ ] **Step 2: Drop the team-only gate on the fuel gauge**

Change the gauge condition at line 271 from:

```tsx
            {isTeamAgent && totalTokens > 0 && (
```

to:

```tsx
            {totalTokens > 0 && (
```

- [ ] **Step 3: Render the model line in the label**

In the label's text column (the `<div className="flex flex-col gap-0 overflow-hidden">` block, lines 228-255), after the `{ch.folderName && ( ... )}` span (after line 254), add a model line — shown for non-sub agents only:

```tsx
                {!isSub && ch.model && (
                  <span className="text-2xs leading-none overflow-hidden text-ellipsis block">
                    {shortenModelName(ch.model)}
                  </span>
                )}
```

- [ ] **Step 4: Widen the overlay vertical offset when the model line is present**

At line 205, `hasExtraLines` decides the `top` offset (34 vs 28). Include the model line so the label isn't clipped. Change:

```tsx
        const hasExtraLines = !!(ch.folderName || teamRoleLabel);
```

to:

```tsx
        const hasExtraLines = !!(ch.folderName || teamRoleLabel || (!isSub && ch.model));
```

- [ ] **Step 5: Type-check + lint (guards the no-inline-colors / import rules)**

Run: `npm run check-types && npm run lint`
Expected: PASS. (No new colors introduced; model line reuses existing `text-2xs` styling.)

- [ ] **Step 6: Build the webview to confirm no runtime import breakage**

Run: `cd webview-ui && npm run build` (or root `npm run compile`)
Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add webview-ui/src/office/components/ToolOverlay.tsx
git commit -m "$(cat <<'EOF'
feat(webview): show fuel gauge for all agents + model name in overlay

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: E2E — solo agent shows gauge + model

**Files:**
- Modify or add a scenario in `e2e/tests/claude/hooks-on/basic.spec.ts` (or a new spec under the same dir)
- Read first: `e2e/README.md` → "Mocking model & rules"; `e2e/helpers/office.ts` (overlay locators); `e2e/helpers/mock-claude.ts` (`claudeScenario`)

**Interfaces:**
- Consumes: the full pipeline from Tasks 1-6.

- [ ] **Step 1: Read the authoring rules**

Read `e2e/README.md` "Mocking model & rules" and skim `e2e/helpers/office.ts` for the overlay locator (`agent-overlay` testid) and `e2e/helpers/mock-claude.ts` for `claudeScenario(...).at(ms).appendJsonl(record)`.

- [ ] **Step 2: Write the failing spec**

Add a test that spawns one solo agent whose mock-claude scenario appends an assistant JSONL record carrying `message.model` + `message.usage`, then asserts the overlay shows the shortened model text and the fuel gauge is present. Mirror the existing spawn test's setup in `basic.spec.ts`. The assistant record shape:

```javascript
scenario.at(500).appendJsonl({
  type: 'assistant',
  message: {
    model: 'claude-opus-4-8',
    usage: { input_tokens: 120000, output_tokens: 5000 },
    content: [],
  },
});
```

Assertions (using the office helper's overlay locator for the spawned agent id):
- overlay text contains `opus 4.8`
- the fuel-gauge element (the `div` with `title` matching `/context used/`) is visible for this **solo** (non-team) agent

Follow the assert-on-visible-outcomes discipline from `e2e/README.md` — locate by testid/visible text, not internal state. Use a wait budget consistent with the existing basic spec.

- [ ] **Step 3: Run the spec to verify it fails against a pre-Task-6 build, then passes now**

Run: `npm run e2e -- --workers=1 --grep "model"`
Expected: PASS with the full implementation in place. (If flaky on the gauge timing, widen the wait for the overlay text first, as the CLAUDE.md timing notes advise.)

- [ ] **Step 4: Regenerate the e2e inventory (CI drift check)**

Run: `npm run e2e:inventory`
Expected: `e2e/README.md` updated only if a new spec file was added. If unchanged, nothing to commit here.

- [ ] **Step 5: Commit**

```bash
git add e2e/
git commit -m "$(cat <<'EOF'
test(e2e): assert solo agent shows fuel gauge and model name

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full type-check + lint**

Run: `npm run check-types && npm run lint`
Expected: PASS.

- [ ] **Step 2: AsyncAPI drift check (must match CI)**

Run: `npm run asyncapi:generate && git diff --exit-code core/src/messages.ts`
Expected: clean (exit 0) — generated file already committed in Task 1.

- [ ] **Step 3: Unit suites**

Run: `npm test`
Expected: server + webview suites PASS (includes new `transcriptParser.test.ts` and `modelLabel.test.ts`).

- [ ] **Step 4: Confirm no unrelated files staged**

Run: `git status`
Expected: working tree clean except the pre-existing uncommitted chatter feature (`chatter.ts`, `office/data/`, and the chatter-related modifications) — leave those alone; they are out of scope for this plan.

---

## Self-Review Notes

- **Spec coverage:** protocol choice A (Task 1) ✓; server model track+broadcast (Task 2) ✓; reconnect snapshot (Task 3) ✓; model shortening table (Task 4) ✓; Character field + handler (Task 5) ✓; gauge-for-all + model text + suppress-on-sub (Task 6) ✓; server unit + e2e (Tasks 2, 7) ✓; CI drift (Tasks 1, 8) ✓.
- **Type consistency:** `setAgentModel(id, model)` used identically in Tasks 5-6; `shortenModelName` signature matches across Tasks 4 and 6; `AgentModelInfo` fields (`type`/`id`/`model`) identical across yaml, server broadcast, and webview handler.
- **Out of scope (from spec):** hooks-only mode model/tokens, persistence across restart, cache-token breakdown. Not implemented — overlay degrades gracefully (model line + gauge both gated on presence/`>0`).
