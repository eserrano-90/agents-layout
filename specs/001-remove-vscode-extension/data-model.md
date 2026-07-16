# Phase 1 Data Model: Removal Inventory

This feature has no runtime data entities — it is a subtractive refactor. The "data model" is therefore the **removal inventory**: every artifact classified as DELETE, EDIT, or CREATE, with the invariant each touch must preserve. Ordered by dependency (leaf consumers first, so nothing references a deleted symbol mid-change).

## Entities

### Entity: VS Code Adapter Surface (DELETE)

Files whose sole purpose is the VS Code host. Delete entirely.

| File | Reason | Depends-on removed first? |
|------|--------|---------------------------|
| `adapters/vscode/extension.ts` | Extension entry (`activate`/`deactivate`) | — |
| `adapters/vscode/PixelAgentsViewProvider.ts` | `WebviewViewProvider`; sole caller of `send*ToWebview` | — |
| `adapters/vscode/agentManager.ts` | Terminal lifecycle (`claude --session-id`) | — |
| `adapters/vscode/vscodeTerminalAdapter.ts` | Only `TerminalAdapter` implementation | — |
| `adapters/vscode/migrateVsCodeState.ts` | Legacy VS Code state migration | — |
| `adapters/vscode/constants.ts` | VS Code IDs/commands/keys | — |
| `adapters/` (dir) | No members remain | after all above |

**Validation**: after delete, `grep -rl "adapters/vscode" --include=*.ts` returns zero production hits (build config + tests handled separately).

### Entity: Server `vscode`-Typed Code (EDIT)

Server files coupled to VS Code's API surface via type-only imports. Purge the coupling; retain standalone behavior.

| File | Change | Invariant preserved |
|------|--------|---------------------|
| `server/src/types.ts` | Remove `import type * as vscode`; remove `ServerAgentState.terminalRef` | All non-terminal fields (session key, tool state, team fields, token usage, `hookDelivered`) unchanged |
| `server/src/fileWatcher.ts` | Remove `vscode.Terminal` casts + `TerminalAdapter`-driven terminal-adoption branch | JSONL polling, partial-line buffering, `/clear` detection, dismissal integration all unchanged |
| `server/src/assetLoader.ts` | Remove `send*ToWebview(vscode.Webview)` functions | All `load*` functions (used by `cli.ts`) unchanged: `loadFurnitureAssets`, `loadWallTiles`, `loadFloorTiles`, `loadCharacterSprites`, `loadPetSprites`, `loadDefaultLayout`, `mergeLoadedAssets` |
| `server/src/clientMessageHandler.ts` | Remove "mirror adapters/vscode/constants.ts" comment coupling | Dispatch behavior unchanged |
| `server/src/layoutPersistence.ts` | Remove `migrateVsCodeState` doc reference | Atomic tmp+rename write behavior unchanged |

**Validation**: `check-types` passes with `@types/vscode` removed; `grep -rn "vscode" server/src` returns zero.

### Entity: Core Terminal Abstraction (DELETE)

| File | Change | Invariant |
|------|--------|-----------|
| `core/src/terminalAdapter.ts` | Delete interface (`TerminalAdapter`/`ITerminalAdapter`) | Zero live consumers after `fileWatcher.ts` edit (R3) |

**Validation**: `grep -rn "TerminalAdapter" core server` returns zero.

### Entity: Webview Transport Split (EDIT)

| File | Change | Invariant |
|------|--------|-----------|
| `webview-ui/src/transport/postMessageTransport.ts` | Delete (VS Code-only) | — |
| `webview-ui/src/transport/index.ts` | `createTransport()` always builds `WebSocketTransport` | `MessageTransport` interface unchanged; every downstream consumer untouched |
| `webview-ui/src/runtime.ts` | Remove `acquireVsCodeApi` detection; runtime is always browser | — |

**Validation**: `grep -rn "acquireVsCodeApi\|PostMessageTransport" webview-ui/src` returns zero; webview builds and existing webview Vitest passes.

### Entity: Build & Config (EDIT)

| File | Change | Invariant |
|------|--------|-----------|
| `esbuild.js` | Remove extension context (`extension.ts`, `external:['vscode']`, `dist/extension.js`); restructure `main()` so CLI+assets+hooks still build | `buildCli()`, `copyAssets()`, `buildHooks()` still run on non-watch builds |
| `package.json` | Remove `engines.vscode`, `extensionKind`, `activationEvents`, `main`, `contributes`, `vscode:prepublish`, `build:extension`, `@types/vscode`, `@vscode/test-electron`; fix lint/format/lint-staged globs | `bin.pixel-agents`, `workspaces`, Fastify deps, `asyncapi:*`, `test:*`, `e2e*` scripts unchanged |
| `tsconfig.json` | Remove `"adapters/vscode"` from `include` | `server/src`, `core/src` still included |
| `eslint.config.mjs` | Remove `adapters/vscode` config block | Pixel-art ESLint rules (Principle V) unchanged |

**Validation**: `npm run compile` produces `dist/cli.js`, `dist/webview/`, `dist/assets/`, `dist/hooks/` and **no** `dist/extension.js`.

### Entity: E2E Suite (PORT + DELETE)

| File | Change | Invariant |
|------|--------|-----------|
| `e2e/tests/claude/hooks-on/{basic,lifecycle,teams}.spec.ts` | Port from `fixtures/pixel-agents` → `fixtures/standalone` | Assert-on-visible-outcomes preserved; VS-Code-only assertions dropped + logged |
| `e2e/tests/claude/hooks-off/{lifecycle,matrix,pets}.spec.ts` | Port to standalone fixture | Same |
| `e2e/tests/standalone/hooks.spec.ts` | Retain | — |
| `e2e/fixtures/pixel-agents.ts` | Delete (Electron fixture) | after all ports done |
| `e2e/helpers/launch.ts` | Delete (Electron launcher) | after all ports done |
| `e2e/helpers/webview.ts` | Delete or strip VS-Code-specific helpers | after all ports done |
| `e2e/README.md` | Regenerate inventory (`npm run e2e:inventory`) | Drift check passes |

**Validation**: `npm run e2e` passes; `e2e:inventory` drift check clean; no spec imports `fixtures/pixel-agents` or `helpers/launch`.

### Entity: Governance & Docs (AMEND + CREATE)

| File | Change | Invariant |
|------|--------|-----------|
| `.specify/memory/constitution.md` | Amend per R8; version 1.0.0 → 2.0.0; update Sync Impact Report | Principles II, III, V unchanged; both drift checks still mandated |
| `README.md` | CREATE — standalone-only usage | Only `npx pixel-agents` documented |
| `CHANGELOG.md` | CREATE — discontinuation notice → `npx pixel-agents` | FR-008 satisfied |
| `CLAUDE.md` | EDIT — strip VS Code architecture | Standalone/server/webview flow intact |

**Validation**: `grep -rn "VS Code\|vscode\|\.vsix" README.md CLAUDE.md` returns only discontinuation/historical context; constitution reads consistently as single-surface.

### Entity: Server Test (DELETE)

| File | Change |
|------|--------|
| `server/__tests__/migrateVsCodeState.test.ts` | Delete — tests a deleted adapter file |

**Validation**: `npm run test:server` passes; no test imports `adapters/vscode`.

## Removal order (dependency-safe)

1. **Docs/governance last-safe-first is inverted here** — do code deletions before doc rewrites so docs describe the final state.
2. Delete server test (`migrateVsCodeState.test.ts`) — removes a consumer of the adapter.
3. Edit `server/src` files to drop `vscode` types + terminal-adoption path (R2/R3).
4. Delete `core/src/terminalAdapter.ts` (now unreferenced).
5. Delete `adapters/vscode/` + `adapters/` dir.
6. Edit webview transport (R4).
7. Edit build/config (`esbuild.js`, `package.json`, `tsconfig.json`, `eslint.config.mjs`).
8. Port E2E specs to standalone; delete Electron harness; regenerate inventory.
9. Amend constitution; create README + CHANGELOG; update CLAUDE.md.
10. Run full gate: `npm run compile && npm test && npm run e2e` + grep gates (see quickstart.md).

## State transitions

Not applicable — no stateful runtime entities are introduced or modified. The only "state" is the repository moving from **two-surface** to **single-surface**, verified by the quickstart gates.
