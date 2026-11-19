# Design

## Context

See `proposal.md` for motivation. What shapes the approach is how the current code is coupled, observed in the tree at `13e8932`:

- `server/src/compositionRoot.ts` builds one object graph where `claudeProvider` is injected into `HookRoutingService`, `TranscriptProcessingService` and `AgentRuntime`, and calls `claudeProvider.installHooks("http://127.0.0.1:<port>", token)` and `getSessionDirs(process.cwd())`.
- `TranscriptProcessingService` (458 lines) does two jobs in one pass: it parses Claude JSONL records **and** mutates the store / broadcasts. It calls `provider.formatToolStatus`, `permissionExemptTools`, `subagentToolNames` and `team.extractTeamMetadataFromRecord`.
- `HookRoutingService` (569 lines) receives already-normalized `AgentEvent`s but still consults the provider for `formatToolStatus`, `subagentToolNames`, `team.isTeammateSpawnCall` and `team.extractTeammateNameFromEvent`, and treats `transcriptPath` / `cwd` as local paths (`dirname`, `resolvePath`).
- `FileScanningService` (721 lines) owns project scanning, external-session adoption, stale checks, `/clear` reassignment and teammate file discovery. `AgentRuntime.restoreExternalAgents` calls `fs.existsSync` / `fs.statSync` on `jsonlFile`.
- Agent identity is effectively the transcript path: `ServerAgentState.jsonlFile`, `DismissalTracker` keys, `knownJsonlFiles`, and `PersistedAgent` all use it.
- The hook script reads `~/.pixel-agents/server.json` and posts to `127.0.0.1` with a 2 s timeout, synchronously inside Claude's hook.
- The browser WebSocket is unauthenticated in standalone mode (`embedded: false`).
- `core/asyncapi.yaml` specifies only server↔browser. `AgentEvent` is hand-written in `core/src/provider.ts`.
- `clientMessageHandler.ts` no longer handles `launchAgent` / `focusAgent`; nothing on the server spawns `claude`, so no launch path has to move.

Constraints: strict layering (`core` depends on nothing), no `enum`, constants centralized, AsyncAPI pinned to 3.0.0 with a CI drift check, and an e2e suite of six spec files that drives real hook and JSONL flows through `mock-claude`.

### Baseline (found during apply)

The e2e suite was already failing on `main` before this change: 0 of 40 executed tests passed on `13e8932`. The hexagonal refactor in that commit broke the lifecycle services (sub-agents never despawn, heuristic mode creates no characters, `progress` records read the wrong field). On `5de96d3`, the commit before it, 17 of 50 pass. With the user's agreement the lifecycle logic is ported from `5de96d3` (`hookEventHandler.ts`, `transcriptParser.ts`, `timerManager.ts`, `fileWatcher.ts`) instead of from the broken services, and the regression gate is those 17 tests. The other 33 failed before the refactor too and stay out of scope.

## Goals / Non-Goals

**Goals:**

- A server that can run with an empty home directory and render sessions from other machines.
- No provider-specific import anywhere under `server/`.
- One delivery path from client to server, exercised identically in all-in-one and split modes.
- No e2e regression against the reference baseline: every test that passes on `5de96d3` (the commit before the hexagonal refactor) passes after this change, without edits to its assertions. See "Baseline" below.

**Non-Goals:**

- Authentication for the browser UI and its WebSocket. Remote deployments are expected to sit behind an authenticating reverse proxy; the server warns when bound to a non-loopback host.
- TLS termination in the server. The client accepts `https://` URLs; termination is the proxy's job.
- A separately published client-only npm package. One package, three modes.
- A second provider. The contract is designed so one can be added, but only Claude is implemented.
- Server-to-client commands. The channel is one-way; anything the server needs from a client it requests in an HTTP response.
- Migrating persisted external agents across the upgrade.
- A daemonless "hook script posts straight to the remote server" mode.

## Decisions

### 1. Normalized events on the wire, with display fields resolved by the client

The ingest contract carries `AgentEvent` plus new kinds, not raw Claude JSON. The server's remaining uses of the provider are all lookups that can be resolved at the source, so they become event fields:

| Server lookup today | Replaced by |
|---|---|
| `formatToolStatus(toolName, input)` | `statusText` on `toolStart` / `subagentStart` |
| `readingTools.has(toolName)` | `activity: 'reading' \| 'typing'` |
| `permissionExemptTools.has(toolName)` | `permissionExempt: boolean` |
| `subagentToolNames.has(toolName)` | `spawnsSubagent: boolean` |
| `team.isTeammateSpawnCall(name, input)` | `spawnsTeammate: boolean` |
| `team.extractTeammateNameFromEvent(raw)` | `teammateName` on the relevant events |
| `team.extractTeamMetadataFromRecord` | `team` block on `sessionStart`, or a `teamInfo` event |

New kinds: `tokenUsage { inputTokens, outputTokens, model? }`, `modelInfo { model }`, `teamInfo { teamName, agentName?, leadSessionId? }`, `sessionReplaced { previousSessionId }`. `sessionStart` gains `folderName` and optional `team`; `transcriptPath` and `cwd` stay as opaque labels. `input` is removed from the wire.

*Alternative — ship raw hook JSON and raw transcript lines, keep normalization on the server.* Smallest diff, but the server keeps `claude.ts`, stays tied to Claude's JSONL format, and raw tool inputs and prompt text would leave the developer's machine. Rejected on both the decoupling goal and privacy.

### 2. Timers and the hooks-vs-transcript gate stay on the server

Permission (7 s) and text-idle (5 s) timers, the 300 ms tool-done delay and the `hookDelivered` suppression stay in the server state machine. Each event carries `origin: 'hook' | 'transcript'`; the server sets `hookDelivered` on the first hook-origin event, exactly as today. The client forwards both streams without merging them.

*Alternative — move timers to the client and emit synthetic `permissionRequest` / `turnEnd`.* It would make the server a pure reducer, but it relocates the most timing-sensitive logic in the codebase (the source of the 9–10 s e2e budgets) for no functional gain. Rejected for risk.

### 3. Split `TranscriptProcessingService` along its existing seam

The parsing half (record type dispatch, usage extraction, `agent_progress` unpacking, team metadata) moves to the client and emits events. The mutating half becomes event handlers on the server, merged into the same dispatcher `HookRoutingService` already is. The result is one server-side `AgentEventReducer` fed from a single ingest queue, replacing two entry points that today both write to the store.

`FileScanningService`, `NodeFileWatcherAdapter` and `DismissalTrackerService` move to the client whole. What they used to do by mutating the store they now do by emitting `sessionStart`, `sessionEnd` and `sessionReplaced`.

### 4. Hook script → local client → server, over HTTP batches

```
claude ──stdin──> claude-hook.js ──POST loopback──> client ──POST /api/ingest (batched)──> server
                                                      ▲
                                    JSONL tail / scanners / team polling
```

The hook script keeps talking to loopback, so Claude's hook latency is unchanged and independent of network conditions. The client is the only thing that speaks to the server.

Client → server is `POST /api/ingest` with a JSON envelope:

```
{ protocolVersion, clientId, seq, sentAt, events: [{ sessionId, origin, ts, event }], snapshot? }
```

Batches flush every 50 ms or at 64 events, whichever comes first. `seq` is a per-client counter starting at 1 for each client process; the server stores the last applied `seq` per client, acknowledges duplicates without re-applying, and answers a gap with `409` and `{ resync: true }`. A `snapshot` field carries the full list of live sessions (with enough state to rebuild: team block, last known status) and resets the server's `seq` expectation.

*Alternative — WebSocket.* Gives ordering and liveness for free and would allow server→client commands, but the only server→client needs here (resync) fit in an HTTP response, and HTTP is simpler to proxy, authenticate, test with `.http` files and implement in third-party emitters. Rejected.

*Alternative — hook script posts directly to the remote server.* Removes the daemon for hook-only use, but puts network latency inside Claude's hook, loses transcript-derived data, and creates a second delivery path. Rejected; listed as a non-goal.

### 5. Liveness by heartbeat, reconciliation by snapshot

An idle client sends an empty batch every 10 s. The server marks a client disconnected after 30 s of silence and removes its agents through the normal `agentClosed` path. A clean shutdown sends a final batch with `goodbye: true`. A client sends a snapshot on its first request after start, after any `409 resync`, and after dropping events from its queue (queue limit 5,000 events). All four numbers go in the respective `constants.ts`.

Server persistence keeps seat and appearance keyed by `(clientId, sessionId)`. Restored agents are held in a pending set and only added to the store when a snapshot confirms them, replacing the `fs.existsSync(jsonlFile)` check.

### 6. Identity and tokens

`clientId` is a stable UUID the client generates once and stores in `~/.pixel-agents/config.json`; `label` defaults to `<user>@<hostname>` and is overridable. The server stores `{ clientId?, label, tokenHash }` per issued token (SHA-256, constant-time compare), binds the token to the first `clientId` that uses it, and rejects a mismatch afterwards. `pixel-agents server token add|list|revoke` manages them.

In all-in-one mode the process generates an ephemeral token and client id at startup and still delivers over loopback HTTP, not an in-process call, so the contract is exercised by every existing e2e test.

*Alternative — one shared ingest token.* Simpler, but it cannot attribute or revoke a single client and lets any client impersonate another. Rejected.

### 7. Agent ids

The server keeps allocating numeric agent ids; the browser protocol does not change shape. A `(clientId, sessionId) → agentId` map replaces `SessionRouter`'s `sessionId → agentId`. `agentCreated` and `existingAgents` gain an optional `clientLabel`, and the UI appends it to the label only when more than one client is connected.

### 8. Package layout and layering

```
core/      contract + shared types             (depends on nothing)
client/    emitter: providers, watchers, queue (depends on core)
server/    ingest, reducer, store, WS, SPA     (depends on core)
cli/       mode selection + all-in-one wiring  (depends on client, server, core)
```

`server/src/cli.ts` moves to `cli/` because all-in-one composition must import both sides and neither side may import the other. An ESLint `no-restricted-imports` rule enforces `client ↛ server` and `server ↛ client`. `core/src/provider.ts` splits into `core/src/ingest.ts` (wire types, generated) and `client/src/provider.ts` (the `HookProvider` / `TeamProvider` interfaces, which are no longer shared).

### 9. Contract lives in AsyncAPI, with generated types and a runtime schema

The ingest channel is added to `core/asyncapi.yaml` with an HTTP binding. `scripts/generate-messages.ts` additionally emits `core/src/ingestMessages.ts` and a JSON Schema used as the Fastify body schema for `/api/ingest`, under the same `git diff --exit-code` drift check. This keeps one source of truth and lets a third party generate an emitter from the file that already ships in the npm tarball.

*Alternative — hand-written types plus a hand-written validator.* Faster to write, but two artifacts that can drift, and nothing for third parties to generate from. Rejected.

### 10. Settings that belong to the client

`hooksEnabled` and `watchAllSessions` move to client configuration. The server sends a capability flag with the settings payload (`localClient: boolean`). In all-in-one mode the existing `setHooksEnabled` / `setWatchAllSessions` messages are routed by `cli/` to the co-located client, so the hook install/uninstall e2e test keeps passing; in server-only mode the UI hides both toggles and the server ignores the messages.

### 11. Discovery file keeps its path

`~/.pixel-agents/server.json` keeps its name and `{ port, pid, token }` shape and is now written by the client to describe the loopback hook endpoint. Renaming it would be more accurate but would break `e2e/fixtures/standalone.ts`, `e2e/helpers/hooks.ts`, `server/manual-hook-events.http` and any already-installed hook script, for no behavioral gain.

## Risks / Trade-offs

- [The office UI and its WebSocket are unauthenticated, and this change makes non-loopback binds a normal use case] → Loopback stays the default; a non-loopback bind prints a warning naming the exposure; the docs prescribe an authenticating reverse proxy. Viewer auth is a follow-up change.
- [Status text and folder names leave the developer's machine; a Bash status line can contain a secret typed on the command line] → Only contract fields are sent, raw input/output never is, status text keeps today's truncation. Documented plainly in the README section on remote mode.
- [Splitting the transcript parser can change event ordering or timing and break timing-sensitive e2e tests] → The client emits one `progress` per transcript batch before its events, mirroring the old per-batch timer cancellation; batch flush is 50 ms, well inside the 300 ms tool-done delay. Verified against the 17 reference tests.
- [Loopback HTTP in all-in-one mode adds a hop that did not exist] → Sub-millisecond on loopback; it buys a single code path. If e2e budgets tighten on CI runners, the flush interval is the knob.
- [A lost batch desynchronizes state] → `seq` gap detection plus snapshot resync; tested by dropping a batch in a unit test.
- [Persisted external agents are not restored after upgrade] → They reappear on the next event or snapshot from their client; only seat and appearance are lost once. Called out in `CHANGELOG.md`.
- [Token leakage via config files] → Config written with mode `0600`; server stores hashes only; tokens are revocable individually.
- [Large refactor across ~2,000 lines of lifecycle code] → Phased, with the e2e suite as the gate between phases, and no phase that leaves both the old and new path live for the same event.

## Migration Plan

1. **Contract** — add ingest schemas and the extended event kinds to `core/`; nothing consumes them yet.
2. **Reducer inside the server** and 3. **Extract the client workspace** — landed together: with the services on `main` broken there was no green in-process intermediate to stop at. The reducer and the client are ported from `5de96d3`; the server receives everything through `/api/ingest` on loopback. Gate: the 17 reference e2e tests.
4. **Presence and tokens** — heartbeat, snapshot, expiry, token management, `clientLabel`.
5. **Modes and docs** — `server` and `client` subcommands, the split-homes e2e, documentation.

Rollback is per phase by reverting its commits; phases 1–3 leave user-visible behavior unchanged. After phase 4 a downgrade loses persisted seats for external agents, the same one-time cost as the upgrade.

## Open Questions

- Should the client label be shown in the hover overlay only, or also in the always-visible label when "always show labels" is on? Either satisfies the spec; decide when the UI change is reviewed.
- Should `pixel-agents client` daemonize itself or always run in the foreground under the user's process manager? Foreground is assumed; a `--daemon` flag can be added later without touching the contract.
