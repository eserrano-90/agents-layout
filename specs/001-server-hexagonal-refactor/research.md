# Research: Current Architecture Analysis for Hexagonal Refactor

## 1. Module-Level Mutable State (Anti-Patterns to Eliminate)

### fileWatcher.ts — 7 module-level mutable variables

| Variable | Set via | Purpose | Risk |
|----------|---------|---------|------|
| `dismissalTracker` | `setDismissalTracker()` | File dismissal state | Module assumes it's set before any scanner tick |
| `agentRemovalCallback` | `setAgentRemovalCallback()` | Agent cleanup | Undefined reference crashes on stale check |
| `trackedProjectDirs` | `ensureProjectScan()` | Direct mutation | Shared across all calls, no lifecycle |
| `knownTeammateFiles` | `scanForTeammateFiles()` | Direct mutation | Set-to-prevent-redundancy, leaked between tests |
| `teammateRemovalCallback` | `setTeammateRemovalCallback()` | Teammate cleanup | Module-level state coupling |
| `teamProvider` | `setTeamProvider()` | Team discovery | Fail-if-not-set pattern, no null safety |
| `hookProvider` | `setHookProvider()` | Session roots | Same pattern |

### transcriptParser.ts — 2 module-level mutable variables

| Variable | Set via | Purpose | Risk |
|----------|---------|---------|------|
| `dailyUsageTracker` | `setDailyUsageTracker()` | Token/cost accounting | Null-reference in tests without it |
| `hookProvider` | `setHookProvider()` | Tool formatting, team metadata | Module-level functions assume it's set |

### Constants used:
- `exemptTools()` — delegates via module-level hookProvider
- `isSubagentTool()` — delegates via module-level hookProvider

### Decision: All module-level state moves to constructor-injected dependencies.

---

## 2. Current Dependency Graph (File-Level Imports)

### Domain-relevant modules (have zero infrastructure imports):
- `dismissalTracker.ts` — imports only `constants.ts` ✓
- `sessionRouter.ts` — imports only `constants.ts` ✓
- `timerManager.ts` — imports `agentStateStore.ts` + `constants.ts` + `types.ts`
- `teamUtils.ts` — assume minimal, check later

### Mixed modules (domain logic + infrastructure):
- **`hookEventHandler.ts`** — domain logic (event routing, state transitions) mixed with broadcast calls
  - Imports: `path` (Infrastructure), `HookProvider` (Core boundary), `AgentStateStore`, `SessionRouter`, `teamUtils`, `timerManager`, `types`, `constants`
- **`transcriptParser.ts`** — 621 lines of domain logic mixed with `fs` access (via deferral) and broadcast
  - Imports: `HookProvider` (Core boundary), `AgentStateStore`, `DailyUsageTracker`, `teamUtils`, `timerManager`, `types`, `constants`
- **`fileWatcher.ts`** — 1033 lines of file I/O mixed with agent lifecycle decisions
  - Imports: `fs`, `path`, `HookProvider`, `TeamProvider` (Core), `AgentStateStore`, `DismissalTracker`, `timerManager`, `transcriptParser`, `types`, `constants`
- **`agentRuntime.ts`** — Orchestrator that wires scanner functions with timer Maps
  - Imports: `fs`, `path`, `HookProvider` (Core), `AgentStateStore`, `fileWatcher` functions, `HookEventHandler`, `SessionRouter`, `timerManager`, `transcriptParser`, `types`, `DailyUsageTracker`

### Infrastructure modules:
- **`httpServer.ts`** — Fastify setup + inline route handlers + WebSocket piping + inline auth
  - 229 lines of mixed concerns: server creation, route registration, auth, WebSocket lifecycle, broadcast piping
- **`server.ts`** — Server lifecycle management + server.json discovery + PID reuse
  - Imports: `crypto`, `fs`, `os`, `path`, `AgentRuntime`, `AgentStateStore`, `createHttpServer`
- **`cli.ts`** — Composition root: creates store, adapter, runtime, server, wires everything
  - 180 lines: argument parsing, asset loading, composition wiring, shutdown handling

### Decision: Extract infrastructure creation from domain/application modules.

---

## 3. Large Parameter Lists (10+ parameters)

| Function | File | Parameters | Issue |
|----------|------|------------|-------|
| `ensureProjectScan()` | fileWatcher.ts:160 | 15 params | 3 Map refs + 3 timer Maps + callback + state |
| `scanForTeammateFiles()` | fileWatcher.ts:266 | 14 params | Same pattern |
| `adoptExternalSessionFromHook()` | fileWatcher.ts:486 | 14 params | Includes callback for persistence |
| `scanExternalDir()` | fileWatcher.ts:724 | 11 params | Part of external scanner |
| `adoptExternalSession()` | fileWatcher.ts:581 | 11 params | Creates agent + starts watching |
| `startExternalSessionScanning()` | fileWatcher.ts:672 | 12 params | 3 Maps + 3 timer Maps + callbacks |
| `reassignAgentToFile()` | fileWatcher.ts:983 | 10 params | Stop old + start new watcher |

### Pattern: 7 functions pass the same 3 Map refs (`fileWatchers`, `pollingTimers`, `jsonlPollTimers`) + 2 timer Maps (`waitingTimers`, `permissionTimers`) + `AgentStateStore` as a group.

### Decision: Group into a `ScanningContext` or `AgentInfrastructure` value object that all file-watching/scanner functions receive.

---

## 4. Fastify Integration (Current Patterns)

### Current structure in `httpServer.ts`:
```
createHttpServer(options):
  1. Create Fastify instance
  2. Register CORS, WebSocket plugins
  3. Register static serving (standalone only)
  4. Register 3 route groups (inline functions):
     a. GET /api/health
     b. POST /api/hooks/:providerId (with bearer auth)
     c. GET /ws (with broadcast piping + message handling)
  5. Listen on port
```

### Inline concerns:
- Bearer auth is a standalone function but sits inside `httpServer.ts`
- WebSocket handler directly pipes `AgentStateStore` events → `socket.send`
- WebSocket handler directly calls `handleClientMessage()`
- Route registration is procedural (registerHealthRoute, registerHookRoute, registerWebSocketRoute)
- Static file serving with HTML5 fallback is embedded

### Fastify best practices to adopt:
- **Plugins**: Each route group should be a Fastify plugin with `encapsulation`
- **Decorators**: Use `app.decorate` for shared state (store, runtime, auth token)
- **Schemas**: Use JSON Schema for request validation (already partially done for hook params)
- **Hooks/PreHandler**: Already using preHandler for auth — extend pattern
- **Type providers**: Use TypeBox for type-safe schemas

### Decision: Refactor httpServer.ts into separate plugin files under `server/src/infrastructure/http/plugins/`.

---

## 5. Agent State Store Pattern

`AgentStateStore` is already well-factored:
- EventEmitter-based typed events
- Map-compatible interface for iteration
- Broadcast as a single method
- Adapter pattern for persistence (setAdapter/getAdapter)

**However**: The broadcast method directly takes `Record<string, unknown>` — no type safety. The event types (`StoreEvents`) are typed but not connected to the message protocol types in `core/`.

### Decision: Preserve AgentStateStore as infrastructure, but add a port interface for it in application layer.

---

## 6. Key Extraction Targets

### What moves to Domain (`server/src/domain/`):
- `AgentStatus` — value object (idle/working/waiting/permission)  
- `ToolInvocation` — value object
- `HookEvent` — typed event kind enum
- `Session` — entity: session_id, agent_id mapping
- `AgentTeam` — value object: teamName, agentName, isLead

### What moves to Application (`server/src/application/`):
- `AgentLifecycleService` — orchestrates create/remove/transition
- `HookRoutingService` — routes hook events to agents (from `hookEventHandler.ts`)
- `SessionManagementService` — session→agent mapping (from `sessionRouter.ts`)
- `FileScanningService` — coordinates watchers/scanners (from `fileWatcher.ts` scanning logic)
- `BroadcastService` — typed broadcast layer (wraps AgentStateStore.broadcast)
- `TimerSchedulingService` — manages waiting/permission/stale timers (from `timerManager.ts`)
- All **port interfaces** (see contracts)

### What stays in Infrastructure (`server/src/infrastructure/`):
- `FastifyHttpAdapter` — HTTP server
- `WebSocketAdapter` — WebSocket transport
- `NodeFsWatcherAdapter` — file watcher (from `fileWatcher.ts`)
- `FileSystemAgentPersistenceAdapter` — agent persistence (from `fileStateAdapter.ts`)
- `FileSystemLayoutPersistenceAdapter` — layout persistence (from `layoutPersistence.ts`)
- `FileSystemConfigPersistenceAdapter` — config persistence (from `configPersistence.ts`)
- `NodeTimerAdapter` — setTimeout/setInterval wrapper
- `SystemClockAdapter` — Date.now() wrapper
- `PngAssetLoader` — PNG → SpriteData (from `assetLoader.ts`)
- `PixelAgentsServer` — composed server (from `server.ts`)
- `ScannerInfrastructure` — holds all fs.watch instances, poll intervals (replaces the 3 Map refs + 2 timer Maps + AgentStateStore that currently flow together)

---

## 7. Migration Strategy

### Incremental extraction order (each step preserves passing tests):
1. **Port interfaces first** — define all ports in `server/src/application/ports/` (no code changes yet)
2. **Move timerManager** → `TimerService` port + `NodeTimerAdapter` — simplest extraction, no state
3. **Extract SessionRouter** → `SessionManagementService` — already clean, just add port
4. **Extract DismissalTracker** → part of persistence adapter — already clean
5. **Extract fileWatcher.ts scanning logic** → `FileScanningService` — largest extraction, needs `ScannerInfrastructure` value object
6. **Extract hookEventHandler.ts routing** → `HookRoutingService`
7. **Extract transcriptParser.ts** → domain agent state machine + application `TranscriptProcessingService`
8. **Refactor httpServer.ts** → Fastify plugin architecture
9. **Refactor server.ts** → composition root with factory function
10. **Remove all module-level setX() functions**

### Decision: Follow this order to maintain backward compatibility and pass tests at each step.
