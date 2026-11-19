# Pixel Agents — Compressed Reference

Pixel art office where AI agents (Claude Code terminals today, any tool tomorrow) become animated characters. Ships as **`npx pixel-agents` standalone CLI**.

## Architecture

Two halves joined by an HTTP contract. A **client** (emitter) runs next to the agent tool, observes its sessions and sends normalized events. A **server** (receiver + viewer) applies them and serves the office. `npx pixel-agents` runs both in one process; `pixel-agents server` and `pixel-agents client` run them apart.

Strict layering: `core/` depends on nothing; `client/` and `server/` depend only on `core/` and **never on each other** (ESLint `no-restricted-imports` enforces it); `cli/` is the only module that composes both; `webview-ui/` depends only on `core/`.

```
core/                                Contract + shared types (zero runtime side effects)
  asyncapi.yaml                      AsyncAPI 3.0 contract — browser channel (/ws) AND ingest channel (/api/ingest)
  src/
    messages.ts                      AUTO-GENERATED browser protocol unions (do not edit)
    ingestMessages.ts                AUTO-GENERATED ingest contract types (do not edit)
    ingestSchema.ts                  AUTO-GENERATED JSON Schema for IngestRequest (server validates with it)
    ingest.ts                        AgentEvent / AgentEventOf helpers over the generated union
    schemas.ts                       AgentMeta, SpriteData, FurnitureCatalogEntry, PersistedAgent
    transport.ts                     MessageTransport interface, TransportState
    adapter.ts                       StateAdapter
    normalizeProjectPath.ts
    constants.ts                     Wire constants (ingest path, protocol version, batching, heartbeat, timeouts)

client/                              Emitter: the only code that touches the agent tool's files
  src/
    provider.ts                      HookProvider (client-side): hook + transcript normalization, session dirs
    teamProvider.ts                  TeamProvider: discoverTeammates, getTeamMembers
    providers/claude/                Claude Code provider — the only place that knows Claude specifics
      claude.ts                      normalizeHookEvent, formatToolStatus, describeToolStart (status/activity/flags)
      transcript.ts                  JSONL record → AgentEvents (no prompt text / tool input leaves the machine)
      claudeTeamProvider.ts          Reads ~/.claude/projects/<p>/<lead>/subagents + ~/.claude/teams/<name>/config.json
      claudeHookInstaller.ts         Atomic install/uninstall in ~/.claude/settings.json
      hooks/claude-hook.ts           Hook script (CJS+shebang, bundled to dist/hooks/claude-hook.js)
    sessionEmitter.ts                Session discovery, adoption, transcript polling, /clear + /resume, teams, stale check
    delivery.ts                      EventDelivery: batching, seq, retry/backoff, bounded queue, heartbeat, snapshot, goodbye
    hookEndpoint.ts                  Loopback POST /api/hooks/:providerId + GET /api/health, writes ~/.pixel-agents/server.json
    client.ts                        startClient(): composition of the above
    clientConfig.ts                  client.json (clientId, label, server, token, settings), client-state.json, target resolution
    dismissalTracker.ts              Dismissal cooldowns, seeded mtimes, pending /clear files
    constants.ts                     Polling / scanning / grace timings
  __tests__/                         Vitest (provider, parser, emitter, delivery, endpoint, config, installer, hook script)

server/                              Receiver + viewer: no agent-tool knowledge, no ~/.claude access
  src/
    server.ts                        startServer(): store, reducer, ingest, Fastify, WebSocket
    agentEventReducer.ts             THE place agent state changes: AgentEvent → AgentState + browser messages, heuristic timers
    ingestService.ts                 Token auth, schema validation, versioning, seq ordering/resync, snapshots, client liveness
    clientTokens.ts                  Issued tokens (SHA-256 hashes, 0600) + ephemeral all-in-one token
    agentStateStore.ts               EventEmitter-backed single source of truth (typed mutations + events)
    clientMessageHandler.ts          Single dispatch point for browser ClientMessage
    infrastructure/http/             Fastify adapter + plugins (health, ingest, static)
    infrastructure/websocket/        /ws adapter
    fileStateAdapter.ts              Namespaced ~/.pixel-agents/ persistence
    configPersistence.ts             { vscode, standalone, externalAssetDirectories }
    layoutPersistence.ts             ~/.pixel-agents/layout.json with atomic tmp+rename
    assetLoader.ts                   PNG → SpriteData via pngjs
    dailyUsageTracker.ts, pricing.ts Daily token/cost totals
    types.ts                         AgentState (keyed by clientId + sessionId)
    constants.ts                     Heuristic timer + liveness constants
  __tests__/                         Vitest (reducer, ingest/presence, HTTP ingest, store, persistence, ...)
  manual-hook-events.http            Manual requests for the client hook endpoint and the server ingest endpoint

cli/
  src/cli.ts                         npx pixel-agents entry (npm bin): all-in-one / server / server token / client

webview-ui/                          React 19 + Canvas UI (depends only on core/)
  src/
    transport/
      index.ts                       createTransport() — always WebSocketTransport
      webSocketTransport.ts          WebSocket with exponential backoff, send queue
      types.ts                       Re-exports MessageTransport from core
    runtime.ts                       isBrowserRuntime detection
    browserMock.ts                   Standalone-browser asset fetch + message injection
    testHooks.ts                     window globals exposed for e2e (officeState, helpers)
    main.tsx                         React entry (StrictMode + createRoot)
    App.tsx                          Composition root (hooks + components + EditActionBar)
    constants.ts                     Webview magic numbers/strings
    notificationSound.ts             Web Audio API chime
    changelogData.ts                 Changelog modal content
    components/                      React UI (toolbars, modals, settings)
      BottomToolbar.tsx, ZoomControls.tsx, SettingsModal.tsx, InfoModal.tsx,
      Tooltip.tsx, DebugView.tsx, ui/Button.tsx, ...
    hooks/
      useExtensionMessages.ts        Message handler — translates ServerMessage into OfficeState mutations
      useEditorActions.ts            Editor state + callbacks
      useEditorKeyboard.ts           Keyboard shortcuts (R, T, Esc, Ctrl+Z/Y)
    office/
      types.ts                       OfficeLayout, Character, etc. + re-exports constants
      toolUtils.ts                   STATUS_TO_TOOL mapping, extractToolName, defaultZoom
      colorize.ts                    Colorize (grayscale→HSL) + Adjust (HSL shift)
      floorTiles.ts                  Floor sprite storage + colorized cache
      wallTiles.ts                   Wall auto-tile: 16 bitmask sprites
      sprites/
        spriteData.ts                Pixel data (characters, furniture, tiles, bubbles)
        spriteCache.ts               SpriteData → offscreen canvas, per-zoom WeakMap
      editor/
        editorActions.ts             Pure layout ops
        editorState.ts               Imperative state (tools, ghost, selection, undo/redo, drag)
        EditorToolbar.tsx
      layout/
        furnitureCatalog.ts          Dynamic catalog from loaded assets
        layoutSerializer.ts          OfficeLayout ↔ runtime (tileMap, furniture, seats)
        tileMap.ts                   Walkability, BFS pathfinding
      engine/
        characters.ts                Character FSM (idle/walk/type) + wander AI
        officeState.ts               Game world (layout, characters, seats, selection, subagents)
        gameLoop.ts                  rAF loop with delta-time cap (0.1 s)
        renderer.ts                  Canvas: tiles, z-sorted entities, overlays, edit UI
        matrixEffect.ts              Spawn/despawn digital rain
      components/
        OfficeCanvas.tsx             Canvas, resize, DPR, mouse hit-testing, drag-to-move
        ToolOverlay.tsx              Activity label above hovered/selected character

e2e/                                 Playwright suite (standalone browser + mock-claude scenarios)
  playwright.config.ts
  global-setup.ts
  fixtures/
    standalone.ts                    Standalone CLI fixture: spawn server + browser page
    mock-claude, mock-claude.cmd     Bash + cmd wrapper invoked instead of real claude
    mock-claude-runner.cjs           Scenario runner: appendJsonl, emitHook, holdOpen
  helpers/
    office.ts                        Overlay locators + assertions
    webview.ts                       Settings/modal helpers
    hooks.ts                         Hook server lifecycle helpers
    standalone.ts                    Standalone server + WebSocket browser helpers
    lifecycle.ts                     Reusable scenario fragments
    team.ts                          Team config seeding + teammate helpers
    allure-labels.ts                 @area:<tag> → Allure epic
  tests/
    claude/hooks-on/                 basic.spec.ts, lifecycle.spec.ts, teams.spec.ts
    claude/hooks-off/                lifecycle.spec.ts, matrix.spec.ts
    standalone/                      hooks.spec.ts
  README.md                          Auto-generated test inventory (regen via npm run e2e:inventory)

scripts/
  generate-messages.ts               AsyncAPI → core/src/messages.ts via Modelina (with CI drift check)
  run-e2e.mjs                        Playwright wrapper (run-id namespacing, video attach flags)
  generate-e2e-inventory.mjs         Splices test list into e2e/README.md (CI drift check)
  build-allure-report.mjs            Combine e2e+server+webview Allure results
  assemble-vercel-output.mjs         Stage /reports/allure/ for Vercel deploy
  asset-manager.html                 Unified furniture editor (positions + metadata)
  jsonl-viewer.html                  Standalone JSONL transcript inspector
  wall-tile-editor.html              Wall sprite editor

core/                                npm workspace (no separate package; root manages)
server/                              npm workspace
webview-ui/                          npm workspace
```

## Distribution

Single artifact from the source tree:

- **npm package** (`pixel-agents`) — `npx pixel-agents [--port 3100]` runs the Fastify server and serves the SPA on the same port. Bundles CLI + webview SPA + assets + hook scripts + `core/asyncapi.yaml` (so third-party clients can regenerate from it).

`package.json:files` allowlist controls the npm tarball: `dist/cli.js{,.map}`, `dist/webview/`, `dist/assets/`, `dist/hooks/`, `core/asyncapi.yaml`, `icon.png`.

## Communication Flow

Hub-and-spoke. The server is the single aggregation point; clients are the only sources.

```
CLIENT (developer machine)                                   SERVER (office)
  claude ─hook─> claude-hook.js ─POST loopback─> HookEndpoint
                                                     │
  ~/.claude/projects/*.jsonl ─poll─> SessionEmitter <┘
  ~/.claude/teams/*/config.json ─────┘   │ normalized AgentEvent (+ origin hook|transcript)
                                         ▼
                                   EventDelivery ──POST /api/ingest (batched, seq)──> IngestService
                                                                                         │
                                                                                 AgentEventReducer
                                                                                         │
                                                                                 AgentStateStore ──/ws──> browser
```

In all-in-one mode the same path is used over loopback HTTP (ephemeral token), so every e2e test exercises the contract.

Adding a new CLI integration is one subdirectory under `client/src/providers/<id>/`: provider, optional `TeamProvider`, installer, hook script. Zero changes to the server, the UI, or any existing provider. A non-Node emitter only needs `core/asyncapi.yaml`.

## AsyncAPI Protocol Contract

`core/asyncapi.yaml` is the contract. Pinned to **3.0.0** because `@asyncapi/modelina@5.10.1` declares `supportedVersions: ['3.0.0']` only; bumping to 3.1.0 produces `export type Root = any`. Revisit when Modelina ships 3.1.0 support.

- **Ingest channel** (`/api/ingest`, HTTP POST): `IngestRequest { protocolVersion, clientId, label?, seq, sentAt, events[], snapshot?, goodbye? }` → `IngestResponse { ok, appliedSeq?, resync?, error?, eventIndex?, supportedVersions? }`. Each event is `{ sessionId, origin: hook|transcript, ts, event: AgentEvent }`. `AgentEvent` (17 kinds, discriminator `kind`) carries display fields resolved by the client: `statusText`, `activity`, `permissionExempt`, `spawnsSubagent`, `spawnsTeammate`. Contract version: `INGEST_PROTOCOL_VERSION`.
- **27 ServerMessage variants** (server → client): agent lifecycle, agent activity, sub-agent activity, team + tokens, assets, settings + workspace, diagnostics.
- **18 ClientMessage variants** (client → server): lifecycle (`webviewReady`, `launchAgent`, `focusAgent`, `closeAgent`), layout (`saveAgentSeats`, `saveLayout`, `exportLayout`, `importLayout`), settings (`setSoundEnabled`, `setHooksEnabled`, `setWatchAllSessions`, `setAlwaysShowLabels`, `setHooksInfoShown`, `setLastSeenVersion`), discovery + assets, diagnostics.

Both unions use `oneOf` with `discriminator: type`. Every concrete message sets `additionalProperties: false`.

`core/src/messages.ts`, `core/src/ingestMessages.ts` and `core/src/ingestSchema.ts` are generated by `scripts/generate-messages.ts` (schemas reachable from `IngestRequest`/`IngestResponse` go to the ingest files; a schema shared by both contracts fails generation) invoking `@asyncapi/modelina` with custom constraints (`propertyKey` preserves `type`/`status` field names; `constant` inlines `const` literals). The file has an auto-generation banner. **CI (and `.husky/pre-push`) runs `asyncapi:generate` then `git diff --exit-code` on the three generated files — any non-empty diff fails the build.**

## Transport Abstraction

```typescript
export interface MessageTransport {
  send(msg: ClientMessage): void;
  onMessage(handler: (msg: ServerMessage) => void): () => void;
  readonly ready: Promise<void>;
  readonly state: TransportState;
  onStateChange(handler: (state: TransportState) => void): () => void;
  dispose(): void;
}
export type TransportState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

`WebSocketTransport` reconnects with exponential backoff (250 ms, 500 ms, 1 s, 2 s, 4 s, capped) and queues sends while disconnected.

`createTransport()` in `webview-ui/src/transport/index.ts` always creates a `WebSocketTransport`. Everything downstream uses the `MessageTransport` interface and never knows which transport is active.

## Provider Abstraction

`HookProvider` (`client/src/provider.ts`) is the integration boundary, and it lives **only in the client**. Today only Claude Code is implemented. The interface:

- **Required**: `normalizeHookEvent(raw)` → `{ sessionId, event: AgentEvent } | null`; `installHooks` / `uninstallHooks` / `areHooksInstalled`.
- **Optional transcript support**: `getSessionDirs(workspace)`, `getAllSessionRoots()`, `sessionFileExtension`, `parseTranscriptLine(line)` → `{ events, team? }`, `isClearedSessionHead(head)`, `folderNameFromSessionDir(dir)`.
- **Optional team extension**: `team?: TeamProvider` for Lead + Teammates support.

Tool knowledge (status text, reading vs typing, permission exemption, sub-agent / teammate spawns) is resolved by the provider into event fields. The server learns tool names for the browser's animations from events (`providerCapabilities` is rebuilt as names appear).

`AgentEvent.kind` values: `sessionStart`, `sessionEnd`, `sessionReplaced`, `toolStart`, `toolEnd`, `backgroundToolEnd`, `turnEnd`, `subagentStart`, `subagentEnd`, `subagentTurnEnd`, `progress`, `permissionRequest`, `textOutput`, `userPrompt`, `tokenUsage`, `modelInfo`, `teamInfo`. The server dispatches on `kind` and `origin`, never on CLI-specific tool names.

### TeamProvider (Lead + Teammates)

Optional client-side extension for CLIs that support team workflows (Claude Agent Teams today). Two filesystem queries: `discoverTeammates(projectDir, leadSessionId)` and `getTeamMembers(teamName)`. The `SessionEmitter` resolves lead/teammate links and sends them as `SessionTeam` (`teamName`, `agentName`, `leadSessionId`, `isTeamLead`, `usesTmux`). In-process teammates get wire session id `<leadSessionId>:<teammateName>`.

Three teammate modes:

| Mode                            | Trigger                                          | Detection                                                             |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------- |
| Basic subagent (teams OFF)      | `Task(...)` or `Agent(run_in_background: false)` | `subagentStart` with team gate not matched, or JSONL `agent_progress` |
| Inline teammate (teams ON)      | `Agent(run_in_background: true)` in-process      | `onTeammateDetected` → `discoverTeammates(projectDir, leadSessionId)` |
| Session teammate (teams + tmux) | `Agent(run_in_background: true)` in tmux pane    | Own session, own hooks, routes through normal flow                    |

Teammate dismissal is driven by the client's team config polling (`getTeamMembers(teamName)` is authoritative, emitted as `sessionEnd`) and by `sessionEnd` on the lead (the server removes the lead's teammates).

**Subtle gate (the one that bit us recently)**: in `webview-ui/src/hooks/useExtensionMessages.ts`, `agentToolStart` with `runInBackground=true` only creates a Subtask sub-character when the **parent has no `teamName`**. With a team, `onTeammateDetected` creates the teammate instead (and the gate prevents a ghost sub-agent). Without a team, the teammate path never fires and the basic Subtask sub-character is the only visible representation.

## Server Runtime

`startServer()` (`server/src/server.ts`) composes `AgentStateStore`, `AgentEventReducer`, `IngestService`, `ClientTokenStore`, the Fastify adapter and the `/ws` adapter. It reads nothing under `~/.claude`, installs no hooks and writes no `server.json`.

### AgentEventReducer

`server/src/agentEventReducer.ts` is the only code that changes agent state. Agents are keyed by `(clientId, sessionId)`; ids stay numeric for the browser. Hook-origin events set `hookDelivered`, which suppresses the heuristic permission (7 s) and text-idle (5 s) timers; transcript-origin events drive them. Tool-done broadcasts are delayed 300 ms. Ported from the pre-refactor `hookEventHandler` + `transcriptParser` + `timerManager` (`5de96d3`) — when behavior is in doubt, that commit is the reference.

### IngestService and presence

`server/src/ingestService.ts`: bearer token → `ClientTokenStore` (bound to the first `clientId` that uses it; mismatch → 403), version check, Ajv validation with the generated schema (400 with `eventIndex`), per-client `seq` (duplicate → ack, gap or unknown client without snapshot → 409 `resync`). A request's `snapshot` is reconciled before its events. Liveness: clients heartbeat every 10 s (`CLIENT_HEARTBEAT_INTERVAL_MS`); silence beyond 30 s (`CLIENT_TIMEOUT_MS`) or `goodbye` removes the client's agents. Persisted agents stay hidden until a snapshot confirms them (keeping their id, so their seat); unconfirmed ones are dropped after the timeout.

### AgentStateStore

EventEmitter-backed container in `server/src/agentStateStore.ts`. Typed mutations, typed events (`agentAdded`, `agentRemoved`, `agentUpdated`, `broadcast`). The `/ws` adapter subscribes per socket. **No module under `server/` calls a transport method directly.**

### HTTP + WebSocket Server

Fastify v5 with `@fastify/cors`, `@fastify/websocket`, `@fastify/static`:

| Method | Path            | Purpose                                      |
| ------ | --------------- | -------------------------------------------- |
| POST   | `/api/ingest`   | Event batches from clients (per-client token) |
| GET    | `/api/health`   | Liveness                                     |
| GET    | `/ws`           | Browser protocol channel (unauthenticated)   |
| GET    | `/*`            | Office SPA via `@fastify/static`             |

Binds to `127.0.0.1` by default; a non-loopback `--host` prints an exposure warning.

The **client** serves, on `127.0.0.1` only, `POST /api/hooks/:providerId` (token from `~/.pixel-agents/server.json`) and `GET /api/health`. The hook script never waits on the network.

### ClientMessageHandler

Single dispatch point for browser `ClientMessage`. `setHooksEnabled` / `setWatchAllSessions` go to an optional `LocalClientControl` (the co-located client in all-in-one mode); `settingsLoaded.localClient` tells the UI whether to show those toggles. `existingAgents.clientLabels`, `agentCreated.clientLabel` and `agentClientLabels` carry client labels only when more than one client is connected.

## Persistence

```
~/.pixel-agents/
  config.json              { vscode, standalone, externalAssetDirectories }     (server: office settings)
  standalone-state.json    { agents: [{ id, clientId, sessionId, folderName? }], seats }  (server)
  client-tokens.json       { tokens: [{ id, label, hash, clientId?, createdAt }] }  (server, 0600)
  layout.json              OfficeLayout                                         (server)
  usage.json               Daily token totals                                   (server)
  client.json              { clientId, label?, serverUrl?, token?, hooksEnabled, watchAllSessions }  (client, 0600)
  client-state.json        { sessions }  live sessions to resume after restart  (client)
  server.json              { port, pid, token }  the client's loopback hook endpoint
  hooks/claude-hook.js     Bundled hook script (CJS, shebang)                   (client)
```

Layout and state writes are atomic via tmp + rename. Agent records written before the client split (no `clientId`) are dropped on load.

## Agent Status Tracking

JSONL transcripts at `~/.claude/projects/<project-hash>/<session-id>.jsonl`, read **by the client only**. Project hash = workspace path with `:`/`\`/`/` → `-`.

**JSONL record types**: `assistant` (tool_use or thinking), `user` (tool_result or text prompt), `system` with `subtype: "turn_duration"` (reliable turn-end signal), `progress` with `data.type`: `agent_progress` (sub-agent tool_use/tool_result, non-exempt tools trigger permission timers), `bash_progress` (Bash output — restarts permission timer), `mcp_progress` (MCP tool — same timer restart). Also observed but not tracked: `file-history-snapshot`, `queue-operation`.

**File watching**: 500 ms polling with partial-line buffering for mid-write reads. Tool-done messages delayed 300 ms to prevent React batching from hiding brief active states.

### Dual-mode detection

| Mode                     | Source                                                 | Detection                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hooks** (preferred)    | Claude Code Hooks API → HTTP POST → `HookEventHandler` | Instant, reliable. 11 events: `SessionStart`, `SessionEnd`, `Stop`, `PermissionRequest`, `Notification`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop` |
| **Heuristic** (fallback) | Polling JSONL files                                    | Per-agent 500 ms JSONL polling for /clear detection; 1 s main scanner for terminal adoption; 3 s external scanner; 30 s stale check. Content-based /clear detection (`/clear</command-name>` in first 8 KB)     |

The `hookDelivered` flag (per agent) and `hooksEnabled` (global) gate timer logic. JSONL polling always runs in both modes for tool content (status text, animations); only permission (7 s) and text-idle (5 s) timers are suppressed by `hookDelivered`.

### Sub-agent permission detection (heuristic)

When a sub-agent runs a non-exempt tool, `startPermissionTimer` fires on the parent agent. If `PERMISSION_TIMER_DELAY_MS` (7 s) elapses with no data, permission bubbles appear on both parent and sub-agent characters via `agentToolPermission` + `subagentToolPermission` broadcasts.

`activeSubagentToolNames: Map<parentToolId, Map<subToolId, toolName>>` tracks which sub-tools are active for the exempt check. Cleared when data resumes, Task completes, or `turn_duration` arrives.

**Timing budget for tests**: the test waits for the bubble AFTER waiting for the "Subtask:" overlay. But the Subtask overlay appears when the parent's **Task tool_use** is parsed (scenario time T), while the timer only starts when the **sub-tool tool_use** in the progress record is parsed (~1 s later). Plus 7 s timer + 300 ms IPC/render slop = a wait timeout less than ~10 s is unsafe.

## Office UI

**Rendering**: Game state in imperative `OfficeState` class (not React state). Pixel-perfect: zoom = integer device-pixels-per-sprite-pixel (1x–10x). No `ctx.scale(dpr)`. Default zoom = `Math.round(2 * devicePixelRatio)`. Z-sort all entities by Y. Pan via middle-mouse drag (`panRef`). **Camera follow**: `cameraFollowId` (separate from `selectedAgentId`) smoothly centers camera on the followed agent; set on agent click, cleared on deselection or manual pan.

**UI styling**: Pixel art aesthetic — sharp corners (`borderRadius: 0`), solid backgrounds (`#1e1e2e`), `2px solid` borders, hard offset shadows (`2px 2px 0px #0a0a14`, no blur). CSS variables in `index.css` `:root` (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...). Pixel font: FS Pixel Sans (`webview-ui/src/fonts/`), loaded via `@font-face`, applied globally.

Custom ESLint rules (`eslint-rules/pixel-agents-rules.mjs`) enforce: `no-inline-colors` (hex/rgb/rgba/hsl/hsla literals only in `constants.ts`), `pixel-shadow` (must use `var(--pixel-shadow)` or `2px 2px 0px`), `pixel-font` (must reference FS Pixel Sans). All `error`-level — they block PRs.

**Characters**: FSM states — active (pathfind to seat, typing/reading animation by tool type), idle (wander randomly with BFS, return to seat after `wanderLimit` moves). 4-directional sprites, left = flipped right. Tool animations: typing (Write/Edit/Bash/Task) vs reading (Read/Grep/Glob/WebFetch). Sitting offset: characters shift down 6 px in TYPE state. Z-sort uses `ch.y + TILE_SIZE/2 + 0.5` so characters render in front of same-row furniture but behind lower-row furniture. **Chair z-sorting**: non-back chairs use `zY = (row+1)*TILE_SIZE` (capped to first row); back-facing chairs use `zY = (row+1)*TILE_SIZE + 1` so the chair back renders in front of the character. Chair tiles are blocked for all characters except their own assigned seat (per-character pathfinding via `withOwnSeatUnblocked`).

**Diverse palette assignment**: `pickDiversePalette()` counts palettes of current non-sub-agent characters; picks randomly from least-used palette(s). First 6 agents each get a unique skin; beyond 6, skins repeat with a random hue shift (45–315°) via `adjustSprite()`. Character stores `palette` (0-5) + `hueShift` (degrees). Sprite cache keyed by `"palette:hueShift"`.

**Spawn/despawn effect**: Matrix-style digital rain animation (0.3 s). 16 vertical columns sweep top-to-bottom with staggered timing. Spawn: green rain reveals character pixels. Despawn: character pixels consumed by green rain trails. `matrixEffect` field on Character (`'spawn'`/`'despawn'`/`null`). Normal FSM is paused during effect. Restored agents (`existingAgents`) use `skipSpawnEffect: true` to appear instantly.

**Sub-agents**: Negative IDs (from -1 down). Created on `agentToolStart` with "Subtask:" prefix. Same palette + hueShift as parent. Click focuses parent terminal. Not persisted. Spawn at closest free seat to parent (Manhattan distance); fallback: closest walkable tile.

**Speech bubbles**: Permission ("..." amber dots) stays until clicked/cleared. Waiting (green checkmark) auto-fades 2 s. Sprites in `spriteData.ts`.

**Sound notifications**: Ascending two-note chime (E5 → E6) via Web Audio API plays when waiting bubble appears (`agentStatus: 'waiting'`). `notificationSound.ts` manages AudioContext lifecycle; `unlockAudio()` on canvas mousedown resumes the context (webviews start suspended). Toggled via Settings modal. Persisted per-namespace in `~/.pixel-agents/config.json`.

**Seats**: Derived from chair furniture. `layoutToSeats()` creates a seat at every footprint tile of every chair. Multi-tile chairs produce multiple seats keyed `uid` / `uid:1` / `uid:2`. Facing direction priority: 1) chair `orientation` from catalog (front→DOWN, back→UP, left→LEFT, right→RIGHT), 2) adjacent desk direction, 3) forward (DOWN). Click character → select (white outline) → click available seat → reassign.

## Layout Editor

Toggle via "Layout" button. Tools: SELECT (default), Floor paint, Wall paint, Erase (set tiles to VOID), Furniture place, Furniture pick (eyedropper for furniture type), Eyedropper (floor).

**Floor**: 7 patterns from `floors.png` (grayscale 16×16), colorizable via HSBC sliders (Photoshop Colorize). Color baked per-tile on paint. Eyedropper picks pattern+color.

**Walls**: Separate Wall paint tool. Click/drag to add walls; click/drag existing walls to remove (toggle direction set by first tile of drag, tracked by `wallDragAdding`). HSBC color sliders (Colorize mode) apply to all wall tiles at once. Eyedropper on a wall tile picks its color and switches to Wall tool. Furniture cannot be placed on wall tiles, but background rows may overlap walls.

**Furniture**: Ghost preview (green/red validity). R key rotates, T key toggles on/off state. Drag-to-move in SELECT. Delete button (red X) + rotate button (blue arrow) on selected items. Any selected furniture shows HSBC color sliders (Color toggle + Clear button); color stored per-item in `PlacedFurniture.color?`. Single undo entry per color-editing session (tracked by `colorEditUidRef`). Pick tool copies type+color from placed item. Surface items preferred when clicking stacked furniture.

**Undo/Redo**: 50-level, Ctrl+Z/Y. EditActionBar (top-center when dirty): Undo, Redo, Save, Reset.

**Multi-stage Esc**: exit furniture pick → deselect catalog → close tool tab → deselect furniture → close editor.

**Erase tool**: Sets tiles to `TileType.VOID` (transparent, non-walkable, no furniture). Right-click in floor/wall/erase tools also erases to VOID (drag-erasing supported). Context menu suppressed in edit mode.

**Grid expansion**: In floor/wall/erase tools, a ghost border (dashed outline) appears 1 tile outside the grid. Clicking a ghost tile calls `expandLayout()` to grow the grid by 1 tile in that direction. New tiles are VOID. Furniture positions and character positions shift when expanding left/up. Max: `MAX_COLS`×`MAX_ROWS` (64×64). Default: `DEFAULT_COLS`×`DEFAULT_ROWS` (20×11). Characters outside bounds after resize relocated to random walkable tiles.

**Layout model**: `{ version: 1, cols, rows, tiles: TileType[], furniture: PlacedFurniture[], tileColors?: ColorValue[] }`. Grid dimensions are dynamic. Persisted via debounced saveLayout message → `writeLayoutToFile()` → `~/.pixel-agents/layout.json`.

## Asset System

**Loading**: `esbuild.js` copies `webview-ui/public/assets/` → `dist/assets/`. Loader checks bundled path first, falls back to workspace root. PNG → pngjs → SpriteData (2D hex array, alpha≥2 = visible, `#RRGGBBAA` for semi-transparent). `loadDefaultLayout()` reads `assets/default-layout.json` as fallback for new workspaces.

**Catalog**: `furniture-catalog.json` with `id, name, label, category, footprint, isDesk, canPlaceOnWalls, groupId?, orientation?, state?, canPlaceOnSurfaces?, backgroundTiles?`. String-based type system. Categories: desks, chairs, storage, electronics, decor, wall, misc. Wall-placeable items use the `wall` category and appear in a dedicated "Wall" tab. Asset naming convention: `{BASE}[_{ORIENTATION}][_{STATE}]` (e.g., `MONITOR_FRONT_OFF`).

**Per-furniture manifests**: Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`; wall tile sets in `assets/walls/`.

**Rotation groups**: `buildDynamicCatalog()` builds `rotationGroups` Map from assets sharing a `groupId`. Supports 2+ orientations (e.g., front/back only). Editor palette shows 1 item per group (front orientation preferred). `getRotatedType()` cycles through available orientations.

**State groups**: Items with `state: "on"` / `"off"` sharing the same `groupId` + `orientation` form toggle pairs. `stateGroups` Map enables `getToggledType()` lookup. Editor palette hides on-state variants. State groups are mirrored across orientations.

**Auto-state**: `officeState.rebuildFurnitureInstances()` swaps electronics to ON sprites when an active agent faces a desk with that item nearby (3 tiles deep in facing direction, 1 tile to each side). Operates at render time without modifying the saved layout.

**Background tiles**: `backgroundTiles?: number` — top N footprint rows allow other furniture to be placed on them AND characters to walk through. Z-sort places bg-row items behind the host furniture.

**Surface placement**: `canPlaceOnSurfaces?: boolean` — items like laptops, monitors, mugs can overlap with all tiles of `isDesk` furniture. `canPlaceFurniture()` builds a desk-tile set and excludes it from collision checks. Z-sort: surface items get `zY = max(spriteBottom, deskZY + 0.5)`.

**Wall placement**: `canPlaceOnWalls?: boolean` — items like paintings, windows, clocks can only be placed on wall tiles. `canPlaceFurniture()` requires the bottom row of the footprint to be on wall tiles; upper rows may extend above the map. `getWallPlacementRow()` offsets placement so the bottom row aligns with the hovered tile.

**Colorize module**: `colorize.ts` with two modes selected by `ColorValue.colorize?` flag. **Colorize mode** (Photoshop-style): grayscale → luminance → contrast → brightness → fixed HSL; always used for floor tiles. **Adjust mode** (default for furniture and character hue shifts): shifts original pixel HSL. `adjustSprite()` exported for character hue shifts. Cache keyed by arbitrary string (includes colorize flag).

**Floor tiles**: `floors.png` (112×16, 7 patterns). Cached by (pattern, h, s, b, c).

**Wall tiles**: `walls.png` (64×128, 4×4 grid of 16×32 pieces). 4-bit auto-tile bitmask (N=1, E=2, S=4, W=8). Sprites extend 16 px above tile (3D face). `wallTiles.ts` computes bitmask at render time. Colorizable via HSBC sliders. Wall sprites z-sorted with furniture/characters (`getWallInstances()` builds `FurnitureInstance[]`).

**Character sprites**: 6 pre-colored PNGs (`assets/characters/char_0.png`–`char_5.png`), one per palette. Each 112×96: 7 frames × 16 px wide, 3 direction rows × 32 px tall. Row 0 = down, Row 1 = up, Row 2 = right. Frame order: walk1, walk2, walk3, type1, type2, read1, read2. Left = flipped right at runtime. When `hueShift !== 0`, `hueShiftSprites()` applies `adjustSprite()` to all frames before caching.

**Load order**: `characterSpritesLoaded` → `floorTilesLoaded` → `wallTilesLoaded` → `furnitureAssetsLoaded` → `layoutLoaded`.

## Testing

Three tiers, each with its own framework.

### Server unit/integration (Vitest)

`server/__tests__/` — reducer (`agentEventReducer.test.ts`: every event kind, timers, teams, reconcile), presence (`ingestService.test.ts`), HTTP ingest (`server.test.ts`: auth, validation, version, seq, goodbye), store, persistence, usage.

Run: `npm run test:server`.

### Client unit/integration (Vitest)

`client/__tests__/` — provider normalization (`claude.test.ts`), transcript parsing (`transcript.test.ts`), `SessionEmitter` with an in-memory filesystem (`sessionEmitter.test.ts`), delivery queue (`delivery.test.ts`), hook endpoint, config precedence, installer, spawned hook script (needs `dist/hooks/claude-hook.js`), team provider.

Run: `npm run test:client` (`npm test` runs webview + server + client).

### Webview unit (Vitest, Node runner)

`webview-ui/test/` — `build-subpath.test.ts`, `dev-assets.test.ts`. Asset wiring and Vite plugin smoke tests.

Run: `npm run test:webview`.

### End-to-end (Playwright)

`e2e/` — Playwright tests against the standalone Fastify server. **Tests across 6 spec files**, run on CI as a multi-OS matrix.

| Area (`@area:<tag>`) | Specs                                                                     | What                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `spawn`              | `claude/hooks-on/basic.spec.ts`                                           | "+ Agent" creates JSONL session, character renders, external session adoption                                                                                      |
| `lifecycle`          | `claude/hooks-on/lifecycle.spec.ts`, `claude/hooks-off/lifecycle.spec.ts` | /clear, --resume, reassignment, stale cleanup, subagent visibility, background routing                                                                             |
| `cross-cutting`      | spread across both lifecycle files                                        | turn_duration cleanup, permission timer cancellation, sub-agent permission bubble, sound, label persistence, hook install/uninstall, layout editor save round-trip |
| `teams`              | `claude/hooks-on/teams.spec.ts`                                           | Internal/external lead + tmux/inline teammate routing                                                                                                              |
| `matrix`             | `claude/hooks-off/matrix.spec.ts`                                         | Heuristic-mode broad coverage                                                                                                                                      |
| `standalone`         | `standalone/hooks.spec.ts`, `standalone/split.spec.ts`                    | npx pixel-agents serves SPA, WebSocket protocol, hook-driven lifecycle in browser; server + client with separate homes, restart, goodbye, third-party emitter     |

**Mock claude**: Tests never invoke real `claude`. A bash script (`e2e/fixtures/mock-claude`) is copied into an isolated `bin/` and prepended to `PATH`. The scenario runner (`mock-claude-runner.cjs`) honors `claudeScenario(...).at(ms).appendJsonl(record).emitHook(event).holdOpenFor(ms).build()` to drive timed JSONL writes and hook events.

**Authoring rules (normative)**: before writing a new spec, read `e2e/README.md` → "Mocking model & rules". It is the single source of truth for the process-boundary principle, the append-only transcript rule, the assert-on-visible-outcomes discipline, and the one standalone-server exception. New tests must follow that model.

**Isolation**: each test gets its own `tmpHome`, workspace directory, and mock-log file. No state leaks between tests.

**Auto-fixtures**: `_allureLabels` (auto: true) reads `@area:<tag>` from `testInfo.tags` and applies the corresponding Allure epic.

**Single source of truth for test inventory**: `e2e/README.md` contains an auto-generated section spliced between `<!-- BEGIN:E2E-INVENTORY -->` and `<!-- END:E2E-INVENTORY -->` markers. CI regenerates via `npm run e2e:inventory` and fails on `git diff --exit-code e2e/README.md`.

Run:

```bash
npm run e2e                                    # all tests
npm run e2e -- --workers=1                     # single worker (matches CI sharding)
npm run e2e -- --grep "lifecycle"              # filter by name
npm run e2e:debug                              # step-through
npm run e2e -- --attach-videos-on-success      # keep videos for passes too
npm run e2e:inventory                          # regen e2e/README.md inventory
npm run test:report                            # build combined Allure report
npm run test:report:open                       # serve Allure locally (file:// can't fetch)
```

**Reproducing CI failures locally**: CI uses `--workers=1` because the runners can't handle more. Reproduce locally with `npm run e2e -- --workers=1 --grep "<test>"`. For full Linux fidelity, `act -j linux-e2e --matrix shard:1 -P ubuntu-latest=catthehacker/ubuntu:full-22.04 --container-architecture linux/amd64` or run inside `mcr.microsoft.com/playwright:v1.58.2-noble` Docker with `--cpus=2 --memory=4g` to simulate runner throttling.

## Build & Dev

**npm workspaces monorepo** (`server`, `client`, `cli`, `webview-ui`). A single `npm install` at the root installs deps for all workspaces; `cd webview-ui && npm install` is redundant.

```bash
npm install                # installs root + workspaces in one shot
npm run compile            # asyncapi:generate, check-types, lint, esbuild, vite
npm run build              # alias for compile
npm run package            # production build (esbuild --production)
npm test                   # webview + server vitest
npm run e2e                # Playwright
```

`esbuild.js` runs two bundles:

1. **CLI** (`dist/cli.js`) from `cli/src/cli.ts`. Externals pulled at install time (`fastify`, `@fastify/*`, `ajv`).
2. **Hook scripts** (`dist/hooks/claude-hook.js`) from `client/src/providers/claude/hooks/claude-hook.ts`. CJS, shebang.

`define: { 'process.env.PIXEL_AGENTS_VERSION': JSON.stringify(version) }` stamps the package version into all bundles.

**Watch mode**:

```bash
npm run watch                       # parallel esbuild watch + tsc --noEmit watch
cd webview-ui && npm run dev        # Vite dev server (separate terminal)
```

The webview Vite dev server is **not** included in `npm run watch` — it has to be run separately.


### CI

Single workflow runs (in order): install, lint, `asyncapi:validate`, `asyncapi:generate` + drift check, `e2e:inventory` + drift check, `check-types`, `test:server`, `test:webview`, `e2e` (3-OS x 3-shard matrix: Linux, macOS, Windows), `package`, Vercel preview deploy (gated on secrets; gracefully skips on forks, non-blocking on failure).

The drift checks are the central guarantees: `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list.

The drift checks are the central guarantees: `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep; `e2e/README.md` stays in sync with the spec list.

## TypeScript Constraints

- **No `enum`** (`erasableSyntaxOnly` in webview) — use `as const` objects (`TileType`, `CharacterState`, `Direction`, `EditTool`).
- **`import type`** required for type-only imports (`verbatimModuleSyntax` in webview; convention in server).
- **`noUnusedLocals` / `noUnusedParameters`** — strict everywhere.
- **`.js` extensions** on all relative imports in server (Node16 module resolution).
- **Module Node16, target ES2022** in the server. **`erasableSyntaxOnly`, `verbatimModuleSyntax`, `noFallthroughCasesInSwitch`** in the webview.

## Constants Policy

All magic numbers and strings are centralized — never inline:

| Where                              | What lives there                                                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `server/src/constants.ts`          | Heuristic timers (`PERMISSION_TIMER_DELAY_MS`, `TEXT_IDLE_DELAY_MS`, `TOOL_DONE_DELAY_MS`), liveness check interval                 |
| `client/src/constants.ts`          | Transcript polling, session scanning, dismissal cooldowns, `/clear` grace, hook endpoint, delivery timeouts                         |
| `core/src/constants.ts`            | Wire constants: ingest path + version, batch size/flush, heartbeat, client timeout, queue limit, retry backoff                         |
| `webview-ui/src/constants.ts`      | Webview magic numbers (grid, animation, rendering, camera, zoom, editor, game logic) + canvas overlay rgba strings                      |
| `webview-ui/src/index.css` `:root` | CSS custom properties (`--pixel-bg`, `--pixel-border`, `--pixel-accent`, ...) for React inline styles and CSS                           |
| `webview-ui/src/office/types.ts`   | Re-exports grid constants from `constants.ts` for convenience                                                                           |

## Error Handling

- **Try-catch with graceful degradation** — errors logged but never crash the extension.
- **Malformed JSONL lines** silently ignored (catch block in `processTranscriptLine`).
- **Missing assets** logged with warning, operation continues with null/fallback.
- No centralized error reporting or telemetry.

## Logging

Use `console.log`/`error`/`warn` with prefixed context:

- Server/CLI: `[Pixel Agents]`
- Asset loading: `[AssetLoader]`
- Webview: `[Webview]`

## Condensed Lessons

- `fs.watch` unreliable on Windows — always pair with polling backup.
- Partial line buffering essential for append-only file reads (carry unterminated lines).
- Delay `agentToolDone` 300 ms to prevent React batching from hiding brief active states.
- **Idle detection** has two signals: (1) `system` + `subtype: "turn_duration"` — reliable for tool-using turns (~98%), emitted once per completed turn. (2) Text-idle timer (`TEXT_IDLE_DELAY_MS = 5 s`) — for text-only turns. Only starts when `hadToolsInTurn` is false; suppressed once `hadToolsInTurn` becomes true. Reset on new user prompt or `turn_duration`. Cancelled by ANY new JSONL data.
- User prompt `content` can be string (text) or array (tool_results) — handle both.
- `/clear` creates a NEW JSONL file (old file just stops).
- `--output-format stream-json` needs non-TTY stdin — can't use with VS Code terminals.
- Hook-based IPC failed in early prototypes (hooks captured at startup, env vars don't propagate). HTTP `/api/hooks/:providerId` with `~/.pixel-agents/server.json` discovery works.
- PNG→SpriteData: pngjs for RGBA buffer, alpha threshold 2 (`PNG_ALPHA_THRESHOLD`), supports `#RRGGBBAA` semi-transparent pixels.
- OfficeCanvas selection changes are imperative (`editorState.selectedFurnitureUid`); must call `onEditorSelectionChange()` to trigger React re-render for toolbar.
- **External-session adoption**: scanner runs every 3 s. In hooks-OFF mode external scenarios, the test setup can race the first scanner tick. Mock-claude scenarios should give a few seconds of margin before assertions.
- **Heuristic sub-agent permission bubble timing**: the bubble lands 7 s after the SUB-TOOL is registered, not 7 s after the parent Task tool appears. Tests waiting on it from the "Subtask:" overlay need at least `1 s (Task→Bash gap) + 7 s timer + ~300 ms IPC/render = 9–10 s` budget.
- **runInBackground sub-character gate**: in webview `agentToolStart`, `runInBackground=true` Agent tools are gated out of sub-character creation when the parent has a `teamName` (teammate path handles it). With no `teamName`, the gate must be bypassed so the basic Subtask sub-character still renders. `addSubagent` dedups via `subagentIdMap`, so the bypass is safe even if a teammate is detected later.
- **Allure HTML report**: viewing via `file://` fails (browsers block `fetch()` from local files). Use `npx allure open allure-report/allure` or `npm run test:report:open`.

## Manual Hook Testing

`server/manual-hook-events.http` (REST-Client format) drives the client's loopback hook endpoint (copy `port` and `token` from `~/.pixel-agents/server.json`) and, at the end, the server's `/api/ingest` (token from `pixel-agents server token add`). Covers `SessionStart` → `PreToolUse` → `PermissionRequest`/`Notification`/`Stop` → `SessionEnd`.

If `cwd` is outside the current workspace, enable **Watch All Sessions** first.

## Asset Pipeline (legacy tileset import)

7-stage pipeline in `scripts/` for importing third-party tilesets (the bundled assets don't need this):

1. `0-import-tileset.ts` — Interactive CLI wrapper
2. `1-detect-assets.ts` — Flood-fill asset detection
3. `2-asset-editor.html` — Browser UI for position/bounds editing
4. `3-vision-inspect.ts` — Claude vision auto-metadata
5. `4-review-metadata.html` — Browser UI for metadata review
6. `5-export-assets.ts` — Export PNGs + `furniture-catalog.json`
7. `asset-manager.html` — Unified editor (stages 2+4 combined), Save/Save As via File System Access API

Supporting: `wall-tile-editor.html` (wall sprite editing), `jsonl-viewer.html` (transcript inspector).

## Key Decisions

- **Client / server split** (openspec change `decouple-event-client-from-server`): the client normalizes, the server is tool-agnostic and filesystem-blind toward agent tools; one HTTP ingest path in every mode; `cli/` is the only composition point.
- **Layered monorepo**: core ← client, core ← server, core ← webview-ui; client and server never import each other.
- **AsyncAPI 3.0 contract**, generated TS bindings, CI drift check. Single source of truth for the wire protocol.
- **AgentEventReducer** is the single place agent state changes; heuristic timers stay server-side, gated by event `origin`.
- **AgentStateStore** as single source of truth with typed mutations and typed events. No transport calls outside the broadcast layer.
- **Transport abstraction**: `MessageTransport` interface, `PostMessageTransport` + `WebSocketTransport`. One branching point in the entire UI.
- **HookProvider** as the integration boundary, client-side only, with optional transcript fallback. New CLIs are a single subdirectory under `client/src/providers/<id>/`.
- **TeamProvider** as optional extension. Claude Agent Teams is the only implementation.
- **Per-adapter namespaced persistence** under `~/.pixel-agents/`. Single namespace for all state.
- **Single `WebviewViewProvider`** (panel area, not editor area).
- **Inline esbuild problem matcher** (no extra extension needed).
- **`erasableSyntaxOnly`** in webview forbids `enum` — use `as const` objects.
- **Server always starts** regardless of hooks toggle. Only hook installation (a client concern) is gated by the setting.
- **E2E over webview unit tests** for OSS friction. Community PRs change webview internals constantly; unit tests would force contributors to update internals tests on top of feature work. E2E pins user-facing behavior, which is stable across internal refactors.

## Project Identity

- npm package: `pixel-agents` (CLI bin: `pixel-agents`)
- GitHub: `https://github.com/pixel-agents-hq/pixel-agents`
- License: MIT
