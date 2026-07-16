---
description: "Task list for Remove VS Code Extension"
---

# Tasks: Remove VS Code Extension

**Input**: Design documents from `/specs/001-remove-vscode-extension/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: This feature is a subtractive refactor. No new test code is written; existing tests are ported (E2E) or deleted (VS Code-only). The "tests" gate for each story is the existing suite + the grep/build gates in `quickstart.md` and `contracts/removal-verification.contract.md`.

**Organization**: Grouped by user story. US1 (P1) is the MVP — the actual removal that makes the build/test suite green with no VS Code surface. US2 (P2) collapses the codebase + governance to a single surface. US3 (P3) communicates the discontinuation.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1 / US2 / US3 (Setup/Foundational/Polish have no story label)
- Every task lists exact file path(s)

## Path Conventions

Monorepo at repo root: `core/`, `server/`, `webview-ui/`, `adapters/vscode/` (to be deleted), `e2e/`. Config at root (`package.json`, `esbuild.js`, `tsconfig.json`, `eslint.config.mjs`). Governance in `.specify/memory/constitution.md`.

---

## Phase 1: Setup (Baseline Capture)

**Purpose**: Snapshot the "before" state so removal completeness (SC-001, SC-003, SC-005) is measurable.

- [X] T001 Capture removal baseline into `specs/001-remove-vscode-extension/baseline.txt`: output of `grep -rc "vscode" server/src core/src webview-ui/src`, the file list of `adapters/vscode/`, the current `e2e/README.md` inventory section, and a note that no `.github/` CI config exists in the working tree (per plan.md V6). Confirm working tree is clean before starting.

**Checkpoint**: Baseline recorded; safe to begin decoupling.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Decouple `server/` and `core/` from `vscode` types so the tree can compile after `adapters/vscode/` is deleted. Per data-model.md removal order, these MUST land before the adapter directory is removed (T012) and before any build/typecheck gate can pass.

**⚠️ CRITICAL**: US1 build/test gates cannot go green until this phase completes.

- [X] T002 Delete `server/__tests__/migrateVsCodeState.test.ts` (tests a soon-to-be-deleted adapter file; removes an importer of `adapters/vscode/`).
- [X] T003 [P] Purge `vscode` types from `server/src/types.ts`: remove `import type * as vscode` and the `ServerAgentState.terminalRef?: vscode.Terminal` field; leave every other field intact.
- [X] T004 [P] Remove `send*ToWebview(vscode.Webview, ...)` functions from `server/src/assetLoader.ts` (`sendAssetsToWebview`, `sendWallTilesToWebview`, `sendFloorTilesToWebview`, and any sibling `*ToWebview`); remove the `import type * as vscode`; keep ALL `load*` and `mergeLoadedAssets` exports (used by `server/src/cli.ts`).
- [X] T005 Remove the `vscode.Terminal` casts and the `TerminalAdapter`-driven terminal-adoption branch from `server/src/fileWatcher.ts` (the `terminalAdapter` module var, `setTerminalAdapter`, `activeTerminal()`/`allTerminals()` usage, and `import type { ITerminalAdapter }`); preserve JSONL polling, partial-line buffering, `/clear` detection, and dismissal integration. (Depends on T003 for the shared `vscode` type removal context.)
- [X] T006 [P] Remove the "mirror adapters/vscode/constants.ts" coupling comment in `server/src/clientMessageHandler.ts` and the `migrateVsCodeState` doc reference in `server/src/layoutPersistence.ts` (comment-only edits; no behavior change).
- [X] T007 Delete `core/src/terminalAdapter.ts` (the `TerminalAdapter`/`ITerminalAdapter` interface — now zero consumers after T005). Verify with `grep -rn "TerminalAdapter" core server` → zero.

**Checkpoint**: `server/` and `core/` no longer reference `vscode`; `adapters/vscode/` is now the only remaining VS Code code.

---

## Phase 3: User Story 1 - Maintainer drops a distribution surface (Priority: P1) 🎯 MVP

**Goal**: The VS Code extension surface (adapter source, build target, packaging, VS Code-only tests) is gone; the full build + test suite passes producing only standalone artifacts.

**Independent Test**: `npm run compile` emits `dist/cli.js` + webview/assets/hooks and **no** `dist/extension.js`; `npm run test:server && npm run test:webview && npm run e2e` all pass; `grep -rn "from 'vscode'" server/src core/src webview-ui/src` returns zero. (quickstart Gates 1–5, contract V1–V4.)

### Adapter & build removal

- [X] T008 [US1] Delete `adapters/vscode/extension.ts`, `adapters/vscode/PixelAgentsViewProvider.ts`, `adapters/vscode/agentManager.ts`, `adapters/vscode/vscodeTerminalAdapter.ts`, `adapters/vscode/migrateVsCodeState.ts`, `adapters/vscode/constants.ts`, then remove the now-empty `adapters/` directory.
- [X] T009 [US1] Edit `esbuild.js`: remove the extension esbuild context (`entryPoints: ['adapters/vscode/extension.ts']`, `external: ['vscode']`, `outfile: 'dist/extension.js'`) and restructure `main()` so `copyAssets()`, `buildHooks()`, and `buildCli()` still run on a normal (non-watch) build; repoint `--watch` to the CLI build.
- [X] T010 [P] [US1] Edit `package.json`: remove `main`, `contributes`, `extensionKind`, `activationEvents`, `engines.vscode`, the `vscode:prepublish` and `build:extension` scripts, and the `@types/vscode` + `@vscode/test-electron` devDependencies; remove `adapters/vscode` from the `lint`, `lint:fix`, `format`, `format:check`, and `lint-staged` globs; keep `bin.pixel-agents`, `workspaces`, Fastify deps, and all `asyncapi:*`/`test:*`/`e2e*` scripts. Reconcile `compile`/`package` so they no longer invoke the extension build step.
- [X] T011 [P] [US1] Edit `tsconfig.json`: remove `"adapters/vscode"` from `include` (leave `server/src`, `core/src`).
- [X] T012 [P] [US1] Edit `eslint.config.mjs`: remove the `adapters/vscode` config block; leave the pixel-art rules (`no-inline-colors`, `pixel-shadow`, `pixel-font`) and all other layers untouched.

### E2E port to standalone harness (preserve behavior coverage — Principle IV)

- [X] T013 [P] [US1] Port `e2e/tests/claude/hooks-on/basic.spec.ts` from the `fixtures/pixel-agents` (Electron) fixture to `fixtures/standalone`; keep assert-on-visible-outcome checks; drop any VS-Code-only assertions (terminal adoption, `claude --session-id` terminal launch, panel auto-show) and add a code comment noting each dropped assertion (no silent caps).
- [X] T014 [P] [US1] Port `e2e/tests/claude/hooks-on/lifecycle.spec.ts` to `fixtures/standalone` (same rules as T013; this file also had an `adapters/vscode` reference — remove it).
- [X] T015 [P] [US1] Port `e2e/tests/claude/hooks-on/teams.spec.ts` to `fixtures/standalone` (same rules).
- [X] T016 [P] [US1] Port `e2e/tests/claude/hooks-off/lifecycle.spec.ts` to `fixtures/standalone` (same rules).
- [X] T017 [P] [US1] Port `e2e/tests/claude/hooks-off/matrix.spec.ts` to `fixtures/standalone` (same rules).
- [X] T018 [P] [US1] Port `e2e/tests/claude/hooks-off/pets.spec.ts` to `fixtures/standalone` (same rules).
- [X] T019 [US1] After all ports (T013–T018), delete `e2e/fixtures/pixel-agents.ts` and `e2e/helpers/launch.ts`; delete `e2e/helpers/webview.ts` or strip its VS-Code-specific helpers if any are still used by ported specs. Verify `grep -rln "fixtures/pixel-agents\|helpers/launch" e2e/tests` → zero.
- [X] T020 [US1] Regenerate the E2E inventory: `npm run e2e:inventory`, then confirm `git diff --exit-code e2e/README.md` is clean.

### US1 verification

- [X] T021 [US1] Run `npm run compile` and confirm success + `test ! -f dist/extension.js` + presence of `dist/cli.js`, `dist/hooks/claude-hook.js`, `dist/webview/`, `dist/assets/` (quickstart Gate 2). Then run `npm run test:server && npm run test:webview && npm run e2e` — all green (quickstart Gate 5).

**Checkpoint**: MVP complete — VS Code surface removed, standalone build + full test suite green.

---

## Phase 4: User Story 2 - Contributor gets a simpler, single-surface codebase (Priority: P2)

**Goal**: One transport, one persistence namespace, and governance/docs that describe only the standalone CLI.

**Independent Test**: `grep -rn "acquireVsCodeApi\|PostMessageTransport" webview-ui/src` returns zero and `createTransport()` always builds a WebSocket transport; `constitution.md` reads as single-surface at v2.0.0; `CLAUDE.md`/`README.md` describe only the standalone flow. (quickstart Gates 1 & 7, contract V5.)

### Transport & runtime simplification (dead-code after US1)

- [X] T022 [P] [US2] Delete `webview-ui/src/transport/postMessageTransport.ts` (VS Code-only; unreachable once no host provides `acquireVsCodeApi`).
- [X] T023 [US2] Edit `webview-ui/src/transport/index.ts`: `createTransport()` always constructs and connects `WebSocketTransport`; remove the `PostMessageTransport` import and the `!isBrowserRuntime` branch. (Depends on T022.)
- [X] T024 [US2] Edit `webview-ui/src/runtime.ts`: remove the `acquireVsCodeApi` detection so runtime is always `browser`; drop the now-unused `Runtime` union member if it becomes dead. Verify `grep -rn "acquireVsCodeApi" webview-ui/src` → zero and `npm run test:webview` passes.

### Governance amendment (MAJOR bump)

- [X] T025 [US2] Amend `.specify/memory/constitution.md` per research.md R8: in Principle I remove the `adapters/vscode/` dependency clause + the "standalone CLI MUST NOT import adapters/vscode" sentence (keep the `core→server`/`core→webview-ui`/broadcast-layer rules); strike the dual-distribution paragraph (replace with single npm distribution); reduce persistence-isolation to a single namespace and remove the verify-before-clear migration requirement; reword "MUST NOT crash the extension" → "MUST NOT crash the server/CLI"; remove any `.vsix` packaging step from the CI order (keep both drift checks). Bump **Version 1.0.0 → 2.0.0**, set Last Amended date, and prepend a Sync Impact Report entry documenting the MAJOR change + rationale.

### Docs — single surface

- [X] T026 [P] [US2] Create `README.md` at repo root: what Pixel Agents is, standalone usage (`npx pixel-agents [--port 3100]`), Claude hook setup, and the architecture summary (server + webview SPA over WebSocket). No install-the-extension instructions. Include a one-line "Previously distributed as a VS Code extension; now standalone-only" pointer (the authoritative discontinuation notice lives in CHANGELOG per US3).
- [X] T027 [US2] Edit `CLAUDE.md`: remove the `adapters/vscode/` architecture section, the dual-distribution/`.vsix` description, the VS Code E2E legs, and the VS Code state-migration lessons; keep the standalone/server/webview flow, provider abstraction, and testing sections accurate to the single surface.

**Checkpoint**: Codebase, transport, governance, and internal docs all describe one surface.

---

## Phase 5: User Story 3 - Existing VS Code extension user is not silently broken (Priority: P3)

**Goal**: A clear, discoverable statement that the VS Code extension is discontinued, pointing to the standalone CLI.

**Independent Test**: `CHANGELOG.md` exists and contains a discontinuation entry referencing `npx pixel-agents`; the README pointer resolves to it. (quickstart Gate 7, contract V5 / FR-008.)

- [X] T028 [US3] Create `CHANGELOG.md` at repo root with a dated entry stating the VS Code extension (`pablodelucca.pixel-agents`) is discontinued and directing users to `npx pixel-agents` as the supported replacement; note that already-installed extensions keep their last version (no forced uninstall) and that unpublishing the Marketplace/Open VSX listings is tracked externally (out of repo scope, per spec Assumptions).
- [X] T029 [US3] Ensure the `README.md` discontinuation pointer (from T026) links/refers to the `CHANGELOG.md` entry so the notice is discoverable from the project landing doc. (Depends on T026, T028.)

**Checkpoint**: Discontinuation is documented and discoverable.

---

## Phase 6: Polish & Cross-Cutting Verification

**Purpose**: Run the full contract verification and confirm success criteria.

- [X] T030 Run `quickstart.md` Gates 1–7 end to end. Confirm: no `adapters/` dir; zero `vscode`/`WebviewViewProvider`/`PostMessageTransport`/`TerminalAdapter`/`migrateVsCodeState` matches in `server/src`, `core/src`, `webview-ui/src` (SC-003 / V1); `package.json` has no VS Code metadata (V2); `check-types` + `lint` + `compile` green (V3); server/webview/e2e suites green with no `fixtures/pixel-agents` reference (V4).
- [X] T031 [P] Verify protocol/provider frozen (contract C3/C6): `npm run asyncapi:generate` then `git diff --exit-code core/src/messages.ts`, and `git diff --stat core/ server/src/providers/` shows no changes from this feature.
- [X] T032 [P] Boot the standalone CLI (quickstart Gate 6): `node dist/cli.js --port 3199`, assert `/api/health` returns `ok:true`, `/` serves the SPA (200), and `~/.pixel-agents/server.json` is written; then stop it.
- [X] T033 Update `baseline.txt` with the "after" counts and record the CI-reduction note for SC-005 (V6): confirm no `.github/` VS Code packaging/publish or Electron E2E leg exists; if CI config is added elsewhere, apply the same reduction and log it. Final read-through of `constitution.md` (v2.0.0), `README.md`, `CHANGELOG.md`, `CLAUDE.md` for single-surface consistency.

---

## Dependencies & Execution Order

**Phase order**: Setup (P1) → Foundational (P2) → US1 (P3) → US2 (P4) → US3 (P5) → Polish (P6).

**Story dependencies**:
- **Foundational (T002–T007)** blocks US1's build/test gates (server/core must compile without `vscode` before `adapters/` is deleted and the suite is run).
- **US1 (T008–T021)** is the MVP. T008 depends on Foundational (T002 removed the adapter-importing test). Build-config tasks T009–T012 depend on T008 (adapter gone). E2E deletes (T019) depend on all ports (T013–T018). Inventory regen (T020) depends on T019. Gate T021 depends on everything above.
- **US2 (T022–T027)** is largely independent of US1 but logically follows it (PostMessage becomes provably dead only once no VS Code host exists; docs should describe the final state). T023 depends on T022; T024 follows T023. T027 (CLAUDE.md) should reflect the post-US1 + post-transport reality.
- **US3 (T028–T029)** depends only on US2's README (T026) for the pointer; CHANGELOG (T028) is otherwise standalone.
- **Polish (T030–T033)** depends on all stories complete.

**Critical safety rule (data-model.md)**: within Foundational + US1, follow the removal order — delete the adapter-importing test → purge server types → delete core interface → delete `adapters/vscode/` → build config. Never delete a file another still imports.

## Parallel Opportunities

- **Foundational**: T003, T004, T006 are `[P]` (distinct files). T005 (fileWatcher) shares `vscode`-type context with T003 — sequence after T003. T007 after T005.
- **US1 build config**: T010, T011, T012 are `[P]` (package.json / tsconfig.json / eslint.config.mjs — distinct files), all after T008.
- **US1 E2E port**: T013–T018 are all `[P]` (six distinct spec files). T019/T020 serialize after them.
- **US2**: T022 and T026 are `[P]`. T025 (constitution) is independent of the transport tasks.
- **Polish**: T031 and T032 are `[P]`.

Example parallel batch (US1 E2E): run T013, T014, T015, T016, T017, T018 together, then T019 → T020.

## Implementation Strategy

- **MVP = Phase 1 + Phase 2 + Phase 3 (US1)**: delivers the core outcome — VS Code surface removed, standalone build + full test suite green. This alone satisfies FR-001–FR-004 and SC-001/SC-002/SC-004.
- **Incremental**: US2 adds single-surface clarity + governance (FR-005/FR-006/FR-007, SC-003 for webview). US3 adds the discontinuation notice (FR-008). Each is independently shippable after the MVP.
- **Verification-driven**: every story's "done" is a `quickstart.md` gate, not a subjective judgment. Run Polish (Phase 6) before declaring the feature complete.
