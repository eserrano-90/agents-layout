# Server Hexagonal Refactor

**Description**: Restructure the server codebase using hexagonal (ports-and-adapters) architecture to enforce strict layering, decouple business logic from infrastructure concerns, and improve testability and maintainability.

## Problem Statement

The current server architecture has a flat structure where business logic, HTTP routing, file system operations, and WebSocket management are interleaved across modules. This creates several pain points:

- **Module-level mutable state**: Several modules (`fileWatcher.ts`, `transcriptParser.ts`) use singleton-like `setX()` functions to inject dependencies at runtime, making initialization order fragile and testing difficult.
- **Mixed responsibilities**: The `httpServer.ts` file contains inline authentication, WebSocket broadcast piping, route registration, and server configuration — all in one function.
- **Large argument lists**: Functions in `agentRuntime.ts` pass 10+ positional parameters through layers, violating the Single Responsibility Principle and making the code hard to follow.
- **Procedural dispatch**: `clientMessageHandler.ts` is a giant switch statement that directly calls persistence adapters, runtime methods, and asset caching — all in one function.
- **Tight coupling**: Adding a new transport (e.g., HTTP/2, SSE) or swapping persistence (e.g., SQLite instead of JSON files) requires changes across multiple unrelated modules.

Developers currently need to understand the entire codebase to make a single change, and writing isolated unit tests for business logic is difficult because dependencies are not injectable.

## Success Criteria

| Criterion | Measure |
|-----------|---------|
| A developer can add a new CLI provider by implementing one port interface without modifying any existing adapter or domain code | Verified via a proven interface-contract test pattern |
| Business logic can be unit-tested without spinning up a Fastify server or touching the file system | All domain module tests use mocked ports, not real implementations |
| Replacing the HTTP framework requires changes only in the HTTP adapter directory | Adapter boundary is exactly one directory with one factory function |
| Module-level mutable state is eliminated | No `setX()` functions that mutate module-level variables |
| Adding a new transport channel requires zero changes to domain logic | Transport adapter plugs into a single port interface |
| All external dependencies (HTTP, file system, clock) are behind port interfaces | Zero direct `import` of `fs`, `fastify`, or `ws` packages in domain modules |

## Scope

### In Scope
- Define domain core with pure business logic (agent lifecycle, state management, event routing) — zero infrastructure imports
- Define port interfaces for all infrastructure concerns (HTTP server, WebSocket, file system, persistence, timers, clock)
- Implement adapters for each port using Fastify, WebSocket, and Node.js file system APIs
- Eliminate all module-level mutable state in favor of explicit dependency injection
- Restructure `clientMessageHandler.ts` into a domain service that accepts port implementations
- Preserve all existing server behavior — no regressions in agent lifecycle, hook handling, WebSocket broadcasting, or persistence

### Out of Scope
- Changing the AsyncAPI protocol contract or message types
- Modifying the webview UI or its transport layer
- Adding new server features
- Changing the standalone CLI entry point behavior
- Performance optimization beyond what falls out naturally from clean layering
- Migration of the VS Code extension adapter (only standalone CLI server)

## Functional Requirements

### FR1: Layered Module Structure

The server source code must be organized into exactly three layers, each in its own directory:

| Layer | Directory | Purpose | Dependencies |
|-------|-----------|---------|--------------|
| Domain | `server/src/domain/` | Pure business logic, entities, value objects | Nothing outside domain |
| Application | `server/src/application/` | Orchestration services, use cases, port interfaces | Domain only |
| Infrastructure | `server/src/infrastructure/` | Adapter implementations (Fastify, fs, WebSocket) | Domain + Application ports |

### FR2: Port Interfaces

All infrastructure dependencies must be accessed through TypeScript interfaces defined in the application layer. Minimum required ports:

| Port | Responsibility | Methods |
|------|----------------|---------|
| `HttpServer` | Bind port, register routes, start/stop | `start(options)`, `stop()`, `registerRoute(method, path, handler)` |
| `WebSocketServer` | Accept connections, broadcast, handle messages | `broadcast(message)`, `onConnection(handler)`, `close()` |
| `AgentPersistence` | Save/load agent state between restarts | `saveAgents(agents)`, `loadAgents()`, `saveSeats(seats)`, `loadSeats()` |
| `LayoutPersistence` | Read/write office layout | `load()`, `save(layout)` |
| `ConfigPersistence` | Read/write server settings | `load()`, `save(config)` |
| `FileWatcher` | Watch a path for changes | `watch(path, callback)`, `unwatch(id)`, `close()` |
| `TimerService` | Schedule and cancel delayed work | `setTimeout(delay, callback)`, `clearTimeout(id)`, `setInterval(interval, callback)` |
| `Clock` | Provide current time | `now()`, `monotonic()` |
| `AssetLoader` | Load and cache sprite assets | `loadCharacters()`, `loadFurniture()`, `loadFloors()`, `loadWalls()` |

### FR3: Dependency Injection

All adapters and services must receive their dependencies through constructor injection or factory parameters. Module-level mutable state is forbidden. Test doubles must be substitutable for any port without modifying production code.

### FR4: Domain Purity

The domain layer must have zero imports from:
- The `infrastructure/` directory
- Node.js built-in modules (`fs`, `path`, `os`, `crypto`)
- Third-party packages (`fastify`, `@fastify/*`, `ws`)

### FR5: Transport Independence

The agent lifecycle and state management code must not know whether messages are delivered via WebSocket, SSE, HTTP polling, or any other transport mechanism. Transport adapters must implement a single `MessageBus` port interface.

### FR6: Provider Integration Through Ports

Adding a new CLI provider must require only:
1. A new implementation of the `HookProvider` port in the infrastructure layer
2. Registration in a single provider registry factory

Zero changes to domain or application code.

### FR7: Testability

Each domain and application module must be testable in isolation:
- Domain modules: pure function tests, zero setup
- Application services: tests using mocked ports, zero file system or network access
- Infrastructure adapters: integration tests with real dependencies (Fastify, fs) separated into dedicated test files

## User Scenarios

### US1: Developer adds a new CLI provider (e.g., Cursor)

1. Developer creates `server/src/infrastructure/providers/cursor/cursorProvider.ts` implementing `HookProvider` interface
2. Developer registers it in `server/src/infrastructure/providers/providerRegistry.ts`
3. The new provider is immediately available via the existing `POST /api/hooks/cursor` endpoint
4. No changes to domain, application, HTTP adapter, or any other infrastructure module

### US2: Developer replaces the HTTP framework

1. Developer creates a new adapter file in the HTTP adapter directory implementing the `HttpServer` port
2. Developer wires it in the composition root
3. All routes, middleware, and WebSocket handling continue working via the same port interface
4. No changes to any domain or application code

### US3: Developer writes a unit test for agent timeout logic

1. Developer imports the `AgentTimeoutService` from `server/src/application/services/`
2. Developer passes a `MockTimerService` and `MockClock` that are controlled in the test
3. Test advances the mock clock by 30 seconds and asserts the correct state transition
4. Test runs in milliseconds, no server process needed

### US4: Developer debugs an agent lifecycle bug

1. Developer reads `server/src/domain/agent/agent.ts` to understand the pure state machine
2. Developer reads `server/src/application/services/hookEventHandler.ts` to see how hook events translate to state transitions
3. Developer reads `server/src/infrastructure/fileSystem/fileWatcher.ts` to check if file change detection works
4. Each layer has a single responsibility, so the bug's location is immediately clear

## Key Entities

### Domain Layer

| Entity | Responsibility | State |
|--------|----------------|-------|
| `Agent` | Pure agent state machine | id, sessionId, status, active tools, token usage, team metadata |
| `AgentStatus` | Value object: idle, working, waiting, permission-requested | status enum + optional context |
| `ToolInvocation` | Value object tracking a tool call | toolId, toolName, status, startTime, subTools |
| `HookEvent` | Canonical event from a provider | kind, sessionId, payload, timestamp |
| `Session` | Maps an external session to agent identity | sessionId, agentId, transcriptPath, projectDir |
| `AgentTeam` | Team membership value object | teamName, agentName, isLead, teammateIds |

### Application Layer

| Service | Responsibility |
|---------|----------------|
| `AgentLifecycleService` | Orchestrates agent creation, removal, and state transitions |
| `HookRoutingService` | Routes incoming hook events to the correct agent |
| `SessionManagementService` | Manages session-to-agent mapping and pending sessions |
| `TimerSchedulingService` | Coordinates waiting, permission, and stale-check timers |
| `FileScanningService` | Coordinates file-watching, polling, and transcript scanning |
| `BroadcastService` | Distributes state changes to all connected transport channels |

### Port Interfaces

| Port | Consumers | Implementations |
|------|-----------|-----------------|
| `HttpServer` | Composition root sets up routes | `FastifyHttpAdapter` |
| `MessageBus` | `BroadcastService` publishes, transports subscribe | `WebSocketAdapter` |
| `AgentPersistence` | `AgentLifecycleService` saves/loads agents | `FileSystemAgentAdapter` |
| `LayoutPersistence` | Layout API handlers | `FileSystemLayoutAdapter` |
| `FileWatcher` | `FileScanningService` watches transcripts | `NodeFsWatcherAdapter` |
| `TimerService` | `TimerSchedulingService` schedules work | `NodeTimerAdapter` |
| `Clock` | All time-dependent logic | `SystemClockAdapter` |
| `AssetLoader` | WebView connection handler | `PngAssetLoader` |

## Dependencies and Assumptions

### Assumptions
- The existing server behavior is correct and must be preserved exactly
- The standalone CLI entry point (`cli.ts`) is the composition root that wires all adapters
- All existing provider implementations (Claude Code) remain functional
- The file-based persistence schema (`~/.pixel-agents/`) remains unchanged
- The WebSocket protocol between server and webview is unchanged
- Module-level mutable state can be scoped to the composition root only
- Adding interfaces and restructuring will temporarily increase line count but reduce per-file complexity

### Dependencies
- The existing `core/` types (`HookProvider`, `StateAdapter`, `AgentEvent`) remain the single source of truth for protocol types
- The existing `agentStateStore.ts` event-emitter pattern can be preserved as infrastructure, with a port abstracting it for tests
- Fastify will remain the initial HTTP adapter implementation
- Node.js built-in `fs` will remain the initial file system adapter implementation

## Edge Cases

1. **Backward compatibility during migration**: The refactoring must be done incrementally — each module should be extractable and testable independently while the rest of the server continues to function
2. **Error boundaries**: Port implementations must wrap infrastructure errors (file not found, port in use, connection refused) into domain-level error types so application code never catches raw system exceptions
3. **Graceful shutdown**: The composition root must coordinate stopping all adapters in dependency order (transport → timers → file watchers) without leaving dangling resources
4. **Startup ordering**: File watchers must not start scanning before the HTTP server is ready and the composition root has completed wiring
5. **Adapter lifecycle**: Each adapter implementation must implement a `dispose()` method that the composition root calls on shutdown, preventing resource leaks across server restarts
