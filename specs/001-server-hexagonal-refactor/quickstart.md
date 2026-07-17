# Quickstart: Validating the Hexagonal Refactor

## Prerequisites

- Node.js 20+
- `npm install` at monorepo root (installs workspaces)
- Existing test suite passes before any changes

## Setup

```bash
cd /path/to/pixel-agents
npm install
npm run compile
```

## Validation Scenarios

### Scenario 1: Port Interfaces Compile Cleanly

**Goal**: Verify that all port interfaces are defined and type-check correctly.

```bash
npm run check-types
```

**Expected**: No TypeScript errors. Port interfaces in `server/src/application/ports/` are importable without any infrastructure dependencies.

---

### Scenario 2: Domain Layer Has Zero Infrastructure Imports

**Goal**: Verify domain purity constraint (FR4).

```bash
# Check that domain/ has no imports of fs, path, fastify, or ws
rg -n "from ['\"]fs['\"]" server/src/domain/ && echo "FAIL: domain imports fs" || echo "PASS: no fs in domain"
rg -n "from ['\"]fastify['\"]" server/src/domain/ && echo "FAIL: domain imports fastify" || echo "PASS: no fastify in domain"
rg -n "from ['\"]ws['\"]" server/src/domain/ && echo "FAIL: domain imports ws" || echo "PASS: no ws in domain"
rg -n "require\(" server/src/domain/ && echo "FAIL: domain uses require" || echo "PASS: no require in domain"
```

**Expected**: All four check commands report PASS.

---

### Scenario 3: Module-Level setX() Functions Eliminated

**Goal**: Verify all singleton-like module-level mutable state is gone (FR3).

```bash
# No setX functions in server/src/ that mutate module-level state
rg -n "export function set[A-Z]" server/src/ --include "*.ts" | grep -v "__tests__" | grep -v ".d.ts"
# Expected: only outputs from files that haven't been migrated yet, or empty (fully migrated)
```

**Expected**: Zero `export function set<Name>` functions exist after migration.

---

### Scenario 4: Unit Tests Run Without Fastify or Filesystem

**Goal**: Verify application-layer tests use mocked ports (FR7).

```bash
npx vitest run server/__tests__/ --reporter verbose
```

**Expected**: All application service tests pass without a server process or real file system access. Test files that import domain/application modules should mock rather than import infrastructure adapters.

---

### Scenario 5: Existing Server Behavior Preserved

**Goal**: Verify no regressions in the full test suite.

```bash
npm test
```

**Expected**: All existing tests pass — agent lifecycle, hook handling, WebSocket broadcasting, and persistence behavior are identical.

---

### Scenario 6: Integration Test — TimerService Port

**Goal**: Verify that `TimerService` port can be swapped between real and mock implementations.

```bash
npx vitest run server/__tests__/timerService.test.ts --reporter verbose
```

**Expected**: Tests pass using both `NodeTimerAdapter` and `MockTimerAdapter`, verifying that controller agents can be scheduled and timeout correctly.

---

### Scenario 7: Integration Test — Fastify Plugin Structure

**Goal**: Verify the HTTP server refactoring into Fastify plugins.

```bash
npx vitest run server/__tests__/httpServer.test.ts --reporter verbose
```

**Expected**: Tests pass that:
- Start the server on a random port
- Hit `GET /api/health` and receive `{ status: 'ok' }`
- POST a valid hook event and receive `200 OK`
- Connect via WebSocket and receive broadcast messages

---

### Scenario 8: End-to-End — Standalone CLI

**Goal**: Verify the standalone CLI starts and serves the webview.

```bash
npm run e2e -- --grep "standalone"
```

**Expected**: All standalone E2E tests pass, confirming that `npx pixel-agents` works end-to-end with the refactored server.

---

## Verification Tracker

| Scenario | Command | Expected Result | Done |
|----------|---------|-----------------|------|
| 1 | `npm run check-types` | No TS errors | ☐ |
| 2 | Content purity check | All PASS | ☐ |
| 3 | Module state check | Zero setX() | ☐ |
| 4 | `npm test` | All pass | ☐ |
| 5 | Timer integration | Mock/real parity | ☐ |
| 6 | HTTP integration | Routes work | ☐ |
| 7 | E2E standalone | All pass | ☐ |

## Implementation Notes

- Each migration step must preserve all existing tests (Scenario 5 must pass at every commit)
- Domain tests (Scenario 4) can be added incrementally as modules are extracted
- The module state elimination (Scenario 3) is the final validation gate — don't mark complete until all `setX()` functions are gone
- Reference: [Port Interfaces](contracts/ports.md), [Data Model](data-model.md), [Spec](../spec.md)
