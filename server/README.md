# Server — Pixel Agents

Hexagonal (ports-and-adapters) server that aggregates agent activity from CLI hooks and JSONL transcripts, then broadcasts state to webview clients via WebSocket.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   compositionRoot.ts                 │
│  (wires all layers, single createServer() entry)    │
└────┬──────────┬──────────────┬──────────────────────┘
     │          │              │
┌────▼────┐ ┌──▼───┐   ┌─────▼──────────────┐
│ domain/ │ │ app/ │   │  infrastructure/    │
│ Pure    │ │ svc  │   │  Adapters (Fastify, │
│ entities│ │ +    │   │  fs, WebSocket,     │
│ + value │ │ ports│   │  Node timers, etc.) │
│ objects │ │(ifce)│   │                     │
└─────────┘ └──────┘   └────────────────────┘
```

### Layering rules

| Layer | Directory | Depends on | Contains |
|-------|-----------|------------|----------|
| Domain | `domain/` | nothing | `Agent`, `AgentStatus`, `ToolInvocation`, `Session`, `AgentTeam` |
| Application | `application/` | domain only | Port interfaces + services (`HookRoutingService`, `BroadcastService`, `FileScanningService`, `TranscriptProcessingService`, `SessionManagementService`, `DismissalTrackerService`) |
| Infrastructure | `infrastructure/` | domain + application | Adapter implementations (`FastifyHttpAdapter`, `WebSocketAdapter`, `NodeTimerAdapter`, `SystemClockAdapter`, `NodeFileWatcherAdapter`, `FileSystemAgentAdapter`, `FileSystemLayoutAdapter`, `FileSystemConfigAdapter`, `PngAssetLoader`) |

### Port interfaces (`application/ports/`)

| Port | Purpose | Methods |
|------|---------|---------|
| `TimerService` | Schedule/cancel delayed work | `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `clearAll` |
| `Clock` | Provide current time | `now()`, `monotonic()` |
| `FileWatcher` | Watch files for changes | `watch`, `unwatch`, `listFiles`, `stat`, `readFileChunk`, `exists`, `close` |
| `AgentPersistence` | Save/load agent state | `saveAgents`, `loadAgents`, `saveSeats`, `loadSeats` |
| `LayoutPersistence` | Read/write office layout | `load`, `save` |
| `ConfigPersistence` | Read/write server settings | `load`, `save` |
| `MessageBus` | Broadcast to transports | `broadcast` |
| `HttpServer` | Bind port, register routes | `start`, `stop`, `port` |
| `AssetLoader` | Load sprite assets | `loadCharacters`, `loadFurniture`, `loadFloors`, `loadWalls` |
| `AgentStore` | Agent state access | `get`, `set`, `has`, `delete`, `values`, `entries`, `keys`, `broadcast`, `persist` |
| `ScannerInfrastructure` | Scanner deps grouping | DismissalTracker + timer Maps |

### Application services (`application/services/`)

| Service | Responsibility |
|---------|----------------|
| `HookRoutingService` | Routes normalized `AgentEvent` to lifecycle callbacks via HookProvider |
| `BroadcastService` | Typed wrapper over `MessageBus` for agent state broadcasts |
| `FileScanningService` | Coordinates file watching, polling, external session adoption, teammate detection |
| `TranscriptProcessingService` | Parses JSONL lines, updates agent state, manages timer/permission timers |
| `SessionManagementService` | `session_id → agent_id` mapping, event buffering, pending external sessions |
| `DismissalTrackerService` | Unified file dismissal state (cooldown + permanent + mtime seeding + pending clears) |

## Entry point

`cli.ts` → `compositionRoot.createServer()` creates and wires all layers:

```
compositionRoot.createServer()
├── AgentStateStore (in-memory event emitter)
├── FileStateAdapter (persistence to ~/.pixel-agents/)
├── NodeTimerAdapter + SystemClockAdapter
├── NodeFileWatcherAdapter
├── DismissalTrackerService
├── SessionManagementService
├── BroadcastService
├── TranscriptProcessingService
├── FileScanningService
├── HookRoutingService
├── AgentRuntime (lifecycle core)
├── PixelAgentsServer (Fastify HTTP + WebSocket)
└── Claude hook installation
```

## Key design decisions

- **Zero module-level mutable state**: All dependencies injected via constructors. No `setX()` functions.
- **Domain purity**: Zero imports of `fs`, `fastify`, or `ws` in `domain/` or `application/`.
- **Transport independence**: `AgentRuntime` broadcasts via `BroadcastService` → `MessageBus` port; no transport code in domain or application.
- **Provider extensibility**: New CLI providers are one subdirectory under `infrastructure/providers/` — no changes to runtime.

## Testing

```bash
npm test                     # All server unit + integration tests
npx vitest run server/__tests__/application/  # Application service tests (mocked ports)
npx vitest run server/__tests__/domain/       # Domain tests (zero setup)
npx vitest run server/__tests__/infrastructure/ # Integration tests (real Fastify)
npx vitest run server/__tests__/adapters/     # Adapter tests
```
