# Tasks: Server Hexagonal Refactor

## Implementation Strategy

**MVP**: Port interfaces + TimerService + SessionRouter extraction (Phases 1-3). These are the foundational changes that enable all downstream work. After MVP, the server remains fully functional while new code coexists alongside old.

**Incremental delivery**: Each phase preserves passing tests. No phase breaks the existing server — the old modules remain importable until their replacement is complete and the composition root switches over.

**Backward compatibility**: All tasks use the `server/src/` directory. New directories (`domain/`, `application/`, `infrastructure/`) are created alongside existing files. The old files stay until Phase 7, when the migration is complete and we can remove them.

---

## Phase 1: Setup & Directory Structure

**Goal**: Create the three-layer directory skeleton, configure TypeScript module resolution, verify existing tests pass before any changes.

- [X] T001 Create directory structure: `server/src/domain/`, `server/src/application/`, `server/src/application/ports/`, `server/src/infrastructure/`
- [X] T002 Verify existing test suite passes with `npm test` (baseline checkpoint)
- [X] T003 [P] Create barrel export files: `server/src/domain/index.ts`, `server/src/application/index.ts`, `server/src/infrastructure/index.ts`
- [X] T004 [P] Update TypeScript path aliases in `server/tsconfig.json` if needed for new directory structure

---

## Phase 2: Foundational — Port Interfaces

**Goal**: Define all port interfaces in `server/src/application/ports/`. These are pure TypeScript interfaces with zero runtime dependencies. No implementation changes yet.

- [X] T005 Create `server/src/application/ports/TimerService.ts` — TimerService + TimerHandle interfaces
- [X] T006 Create `server/src/application/ports/Clock.ts` — Clock interface
- [X] T007 Create `server/src/application/ports/FileWatcher.ts` — FileWatcher, WatchOptions, WatcherHandle, FileStats interfaces
- [X] T008 [P] Create `server/src/application/ports/AgentPersistence.ts` — AgentPersistence, PersistedAgent, SeatMetadata interfaces
- [X] T009 [P] Create `server/src/application/ports/LayoutPersistence.ts` — LayoutPersistence interface
- [X] T010 [P] Create `server/src/application/ports/ConfigPersistence.ts` — ConfigPersistence, ServerConfig interfaces
- [X] T011 Create `server/src/application/ports/MessageBus.ts` — MessageBus interface
- [X] T012 Create `server/src/application/ports/HttpServer.ts` — HttpServer, HttpServerOptions, HttpServerHandle, RouteRegistration, WebSocketConnection, HttpRequest, HttpResponse interfaces
- [X] T013 Create `server/src/application/ports/AssetLoader.ts` — AssetLoader, LoadedCharacterSprites, LoadedPetSprites, LoadedAssets interfaces
- [X] T014 Create `server/src/application/ports/ScannerInfrastructure.ts` — ScannerInfrastructure interface (groups fileWatchers, pollingTimers, waitingTimers, permissionTimers, jsonlPollTimers, knownJsonlFiles, dismissalTracker)
- [X] T015 Create `server/src/application/ports/AgentStore.ts` — AgentStore interface (wraps AgentStateStore methods)
- [X] T016 Verify `npm run check-types` passes with all port interfaces defined

---

## Phase 3: US1 — TimerService + Simple Infrastructure Adapters

**Goal**: Extract the simplest infrastructure dependencies first. Create `NodeTimerAdapter` and `SystemClockAdapter`, then extract `SessionRouter` → `SessionManagementService` and `DismissalTracker` → injectable class. These are the building blocks for all downstream extraction. All existing behavior preserved.

- [X] T017 [US1] Create `server/src/infrastructure/adapters/NodeTimerAdapter.ts` implementing TimerService
- [X] T018 [US1] Create `server/src/infrastructure/adapters/SystemClockAdapter.ts` implementing Clock
- [X] T019 [US1] Create `server/__tests__/adapters/NodeTimerAdapter.test.ts` — verify setTimeout/clearTimeout/setInterval/clearInterval/clearAll work correctly
- [X] T020 [US1] Create `server/__tests__/adapters/SystemClockAdapter.test.ts` — verify now() and monotonic() return values
- [X] T021 [US1] Refactor `server/src/sessionRouter.ts` to implement `SessionManagementService` port in `server/src/application/services/SessionManagementService.ts` (pure application service, no infrastructure imports)
- [X] T022 [US1] Create `server/__tests__/application/SessionManagementService.test.ts` — verify register/unregister/resolve/pending/buffer with mocked clock
- [X] T023 [US1] Refactor `server/src/dismissalTracker.ts` to `server/src/application/services/DismissalTrackerService.ts` — export interface DismissalTracker with dismiss/permanentlyDismiss/isDismissed/isPermanentlyDismissed/seedMtime/getSeededMtime/clearSeededMtime/registerPendingClear/hasPendingClear/clearPendingClear/resetAll
- [X] T024 [US1] Create `server/__tests__/application/DismissalTrackerService.test.ts` — verify cooldown expiration, permanent dismissal, mtime seeding
- [X] T025 [US1] Create `server/src/infrastructure/adapters/NodeFileWatcherAdapter.ts` implementing FileWatcher — wraps fs.watch + polling read loops (extracted from fileWatcher.ts readNewLines/startFileWatching)
- [X] T026 [US1] Update `server/src/agentRuntime.ts` to accept `AgentStateStore` port interface + `TimerService` + `Clock` via constructor (backward-compatible overload)

---

## Phase 4: US1 — FileScanningService Extraction (Large Module)

**Goal**: Extract the 1033-line `fileWatcher.ts` scanning logic into a well-structured `FileScanningService` in the application layer, using the new port interfaces. This is the largest extraction and the most risky — done after the simple extractions validate the pattern.

- [X] T027 [US1] Create `server/src/application/services/FileScanningService.ts` — pure orchestration that coordinates FileWatcher port, DismissalTracker, AgentStore, and TimerService. Contains: scanProject, scanExternalDir, scanForTeammateFiles, scanGlobalProjectDirs, adoptExternalSession, startExternalSessionScanning, startStaleCheck, reassignAgentToFile
- [X] T028 [US1] Create `server/__tests__/application/FileScanningService.test.ts` — verify scanning with mocked FileWatcher and AgentStore
- [X] T029 [US1] Wire FileScanningService into agentRuntime.ts — replace direct calls to fileWatcher.ts exports with service methods
- [X] T030 [US1] Verify `npm test` passes — all existing scanner behavior preserved through new service

---

## Phase 5: US1 — HookEventHandler + TranscriptParser Extraction

**Goal**: Extract the remaining two large mixed-concern modules into clean application services. HookEventHandler becomes HookRoutingService, transcriptParser becomes TranscriptProcessingService plus domain Agent state machine.

- [X] T031 [US1] Create `server/src/application/services/HookRoutingService.ts` — pure routing logic extracted from hookEventHandler.ts. Routes normalized AgentEvent to lifecycle callbacks. Depends on AgentStore, SessionManagementService, BroadcastService, HookProvider
- [X] T032 [US1] Create `server/src/application/services/BroadcastService.ts` — typed broadcast wrapper over MessageBus port. Translates domain events into ServerMessage format
- [X] T033 [US1] Create `server/src/application/services/TranscriptProcessingService.ts` — pure line-processing logic extracted from transcriptParser.ts. Parses JSONL lines, updates agent state, delegates to BroadcastService
- [X] T034 [US1] Create `server/src/domain/agent/AgentStatus.ts` — AgentStatus type and state machine transitions
- [X] T035 [US1] Create `server/src/domain/agent/ToolInvocation.ts` — ToolInvocation value object with factory methods
- [X] T036 [US1] Create `server/src/domain/agent/Agent.ts` — Agent domain entity (pure state container, no infrastructure imports)
- [X] T037 [US1] Create `server/src/domain/session/Session.ts` — Session entity
- [X] T038 [US1] Create `server/src/domain/team/AgentTeam.ts` — AgentTeam value object
- [X] T039 [US1] Create `server/src/__tests__/domain/Agent.test.ts` — pure function tests for state transitions (zero setup, mocked nothing)
- [X] T040 [US1] Create `server/__tests__/application/HookRoutingService.test.ts` — verify event routing with mocked AgentStore, SessionManagementService
- [X] T041 [US1] Create `server/__tests__/application/TranscriptProcessingService.test.ts` — verify JSONL parsing with mocked dependencies
- [X] T042 [US1] Wire HookRoutingService and TranscriptProcessingService into agentRuntime.ts — replace direct hookEventHandler/transcriptParser usage
- [X] T043 [US1] Verify `npm test` passes — all event routing and transcript parsing preserved

---

## Phase 6: US2 — HTTP Server Refactoring (Fastify Plugins)

**Goal**: Refactor `httpServer.ts` from a single monolithic function into separate Fastify plugin files. Each route group becomes its own plugin. WebSocket handling is extracted behind the MessageBus port. This demonstrates US2 (framework swap capability) by making the adapter boundary explicit.

- [X] T044 [US2] Create `server/src/infrastructure/http/FastifyHttpAdapter.ts` — implements HttpServer port. Wraps Fastify create/start/stop. Registers plugins for each route group
- [X] T045 [US2] Create `server/src/infrastructure/http/plugins/healthPlugin.ts` — Fastify plugin for GET /api/health
- [X] T046 [US2] Create `server/src/infrastructure/http/plugins/hookPlugin.ts` — Fastify plugin for POST /api/hooks/:providerId with bearer auth preHandler
- [X] T047 [US2] Create `server/src/infrastructure/http/plugins/staticPlugin.ts` — Fastify plugin for SPA static serving with HTML5 fallback (standalone only)
- [X] T048 [US2] Create `server/src/infrastructure/http/middleware/auth.ts` — extract bearerAuth into its own module
- [X] T049 [US2] Create `server/src/infrastructure/websocket/WebSocketAdapter.ts` — implements MessageBus port. Wraps @fastify/websocket. Handles connection lifecycle, broadcast, message routing via ClientMessageHandler
- [X] T050 [US2] Create `server/__tests__/infrastructure/FastifyHttpAdapter.test.ts` — integration tests with real Fastify instance
- [X] T051 [US2] Wire FastifyHttpAdapter and WebSocketAdapter in cli.ts — replace direct createHttpServer call
- [X] T052 [US2] Verify `npm test` passes — all HTTP + WebSocket endpoints work through adapter

---

## Phase 7: US3 — Composition Root + Module-Level State Elimination

**Goal**: Refactor `server.ts` and `cli.ts` into a proper composition root. Eliminate all 9 module-level `setX()` functions by passing dependencies through constructors.

- [X] T053 [US3] Create `server/src/compositionRoot.ts` — factory function that creates all adapters, services, and wires them together. Single `createServer(options)` entry point
- [X] T054 [US3] Create `server/src/infrastructure/adapters/FileSystemAgentAdapter.ts` — implements AgentPersistence port (extracted from fileStateAdapter.ts)
- [X] T055 [US3] Create `server/src/infrastructure/adapters/FileSystemLayoutAdapter.ts` — implements LayoutPersistence port (extracted from layoutPersistence.ts)
- [X] T056 [US3] Create `server/src/infrastructure/adapters/FileSystemConfigAdapter.ts` — implements ConfigPersistence port (extracted from configPersistence.ts)
- [X] T057 [US3] Create `server/src/infrastructure/adapters/PngAssetLoader.ts` — implements AssetLoader port (extracted from assetLoader.ts)
- [X] T058 [US3] Remove all `setX()` functions from `server/src/fileWatcher.ts` — dependencies now injected through FileScanningService constructor
- [X] T059 [US3] Remove `setDailyUsageTracker()` and `setHookProvider()` from `server/src/transcriptParser.ts` — dependencies injected through TranscriptProcessingService constructor
- [X] T060 [US3] Refactor `server/src/cli.ts` to use compositionRoot — single createServer call that returns ready-to-start server
- [X] T061 [US3] Verify `npm test` passes — zero setX() functions remain in production code
- [X] T062 [US3] Verify `rg -n "export function set[A-Za-z]" server/src/` returns zero results (confirmation gate for Success Criterion #4)

---

## Phase 8: US4 — Polish & Verify

**Goal**: Final cleanup, dead code removal, documentation updates. Ensure the codebase is clean and all principles are enforced.

- [X] T063 [US4] Remove deprecated `server/src/fileWatcher.ts` (all scanning logic migrated to FileScanningService + NodeFileWatcherAdapter)
- [X] T064 [US4] Remove deprecated `server/src/hookEventHandler.ts` (routing migrated to HookRoutingService)
- [X] T065 [US4] Remove deprecated `server/src/transcriptParser.ts` (parsing migrated to TranscriptProcessingService + domain Agent)
- [X] T066 [US4] Remove deprecated `server/src/timerManager.ts` (timers migrated to TimerService port + NodeTimerAdapter)
- [X] T067 [US4] Verify `npm run compile` passes — lint, type-check, esbuild all succeed
- [X] T068 [US4] Verify `quickstart.md` validation scenarios — run all 7 validation scenarios from quickstart guide
- [X] T069 [US4] Update `server/src/constants.ts` — remove any constants only used by deleted modules
- [X] T070 [US4] Document new architecture in `server/README.md` with layer diagram and port/ adapter table

---

## Summary

- **Total tasks**: 70
- **All 70 tasks**: Complete ✅
- **Verification**: 212/212 tests pass, `check-types` clean, zero `setX()` functions, all quickstart scenarios pass, `server/README.md` documents the architecture
