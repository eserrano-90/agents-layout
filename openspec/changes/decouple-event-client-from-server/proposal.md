# Proposal

## Why

Pixel Agents runs as one process that both observes Claude Code and renders the office, so it only works when the server shares a disk with the Claude sessions: it reads `~/.claude/projects/*.jsonl`, `~/.claude/teams/`, edits `~/.claude/settings.json`, and the hook script posts to a hard-coded `127.0.0.1`. That makes it impossible to run one office that visualizes sessions from other machines, and it keeps Claude-specific knowledge inside the server.

## What Changes

- Introduce a **client (emitter)** role that owns everything touching the developer's machine: the hook script endpoint, hook installation, transcript tailing, session discovery, `/clear` detection, and team discovery. It only sends events.
- Reduce the **server (receiver + viewer)** role to event ingestion, agent state, WebSocket broadcast and the SPA. It performs no reads or writes under `~/.claude` and holds no provider-specific code.
- Add an explicit, versioned **ingest contract** in `core/` carrying normalized events plus the emitting client's identity. Today only the server→browser channel is specified; the hook endpoint accepts raw Claude JSON.
- Extend the normalized event set so everything the server currently derives from disk arrives as events: display status text, activity kind, token usage, model, team membership, session replacement (`/clear`), and session liveness.
- Support **several clients feeding one server**: per-client tokens, client identity on every event, and removal of a client's agents when that client goes away.
- Add CLI modes: `pixel-agents` (all-in-one, unchanged behavior), `pixel-agents server`, and `pixel-agents client --server <url> --token <token>`.
- **BREAKING**: `POST /api/hooks/:providerId` is no longer a server endpoint; it is served by the client on loopback. Remote parties send to the new ingest endpoint.
- **BREAKING**: `HookProvider` / `TeamProvider` leave the server; `server/src/providers/` moves to the client workspace and `core/src/provider.ts` is split into the wire contract and the client-side provider interface.
- **BREAKING**: persisted agents are keyed by client and session instead of by transcript file path; previously persisted external agents are not restored after upgrade.
- The "hooks enabled" and "watch all sessions" settings become client settings. The UI toggles keep working only when the server has a co-located client (all-in-one mode).

## Capabilities

### New Capabilities

- `event-ingestion`: how the server accepts normalized agent events from clients — authentication, validation, protocol versioning, ordering, and its independence from the emitting machine's filesystem.
- `event-emitter`: what the client observes on the developer's machine and turns into events — hooks, transcripts, teams — and how it delivers them reliably to a configured server.
- `client-presence`: how the server tracks which clients are connected, attributes agents to them, reconciles after reconnects, and removes agents of clients that disappear.
- `deployment-modes`: the three ways to run the product (all-in-one, server only, client only) and what each one guarantees.

### Modified Capabilities

None. `openspec/specs/` is empty; this change introduces the first capability specs.

## Impact

- **Code**: new `client/` workspace (receives `server/src/providers/`, `FileScanningService`, `NodeFileWatcherAdapter`, the parsing half of `TranscriptProcessingService`, `DismissalTrackerService`); new top-level CLI composition that may import both client and server; `server/` loses all `~/.claude` access and its provider dependency; `core/` gains the ingest contract.
- **Protocol**: `core/asyncapi.yaml` gains the ingest channel and its generated bindings (same CI drift check); `agentCreated` / `existingAgents` gain an optional client label; new `serverCapabilities`-style signal so the UI can hide client-only toggles.
- **Persistence**: `~/.pixel-agents/standalone-state.json` agent records change shape; `~/.pixel-agents/config.json` gains client tokens (server side) and server URL + token (client side). `~/.pixel-agents/server.json` keeps its path and shape and now describes the local hook endpoint.
- **Tests**: Claude provider, installer, hook-script and team tests move to the client workspace; the existing e2e suite runs unchanged against all-in-one mode and is the regression net; one new e2e proves a server with a separate home directory renders sessions from a remote client.
- **Build / packaging**: third esbuild bundle input, `package.json` workspaces, `knip`, ESLint layering rule (`client` and `server` must not import each other).
- **Docs**: `CLAUDE.md`, `README.md`, `server/manual-hook-events.http`.
- **Security**: the server becomes reachable from other machines; event payloads (status text, working-directory names) leave the developer's machine.
