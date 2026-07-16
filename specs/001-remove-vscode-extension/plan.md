# Implementation Plan: Remove VS Code Extension

**Branch**: `001-remove-vscode-extension` | **Date**: 2026-07-16 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-remove-vscode-extension/spec.md`

## Summary

Remove the VS Code extension surface entirely, leaving the standalone `npx pixel-agents` CLI as the project's only distribution. This means deleting `adapters/vscode/`, purging `vscode`-typed leaks from `server/src/`, dropping the extension build target and its packaging/config, migrating the 6 VS Code Electron E2E specs onto the standalone WebSocket+browser harness (no coverage loss), amending the project constitution (MAJOR bump, single-surface governance), and producing standalone-only docs plus a discontinuation notice.

## Technical Context

**Language/Version**: TypeScript 5.9 (Node16 module resolution in server/core; ES2022 target). React 19 in webview.

**Primary Dependencies**: Fastify v5 (`@fastify/{cors,websocket,static}`), pngjs, esbuild, Vite, Playwright, Vitest. Removed after this change: `vscode` ambient types (`@types/vscode`), `@vscode/test-electron`.

**Storage**: `~/.pixel-agents/` file persistence. Post-removal only the `standalone` namespace remains in active use; `vscode-state.json` and the legacy VS Code migration path are dropped.

**Testing**: Vitest (server unit/integration), Playwright E2E (standalone WebSocket + mock-claude), Vitest (webview). Post-removal E2E runs entirely against the standalone Fastify server + browser page.

**Target Platform**: Node.js CLI (`npx pixel-agents`) serving a browser SPA. VS Code Electron host removed.

**Project Type**: Multi-package monorepo (`core/`, `server/`, `webview-ui/`) — single distribution surface after this change.

**Performance Goals**: No change to runtime behavior; removal is subtractive. CI job count/duration decreases (SC-005).

**Constraints**: Strict layering must hold post-removal (`core → server`, `core → webview-ui`). `core/asyncapi.yaml` ↔ `core/src/messages.ts` drift check and `e2e/README.md` inventory drift check must still pass. No functional regression in the standalone CLI (FR-004, SC-004).

**Scale/Scope**: ~6 adapter files deleted; 3 server files de-`vscode`-typed; 1 build target + esbuild extension bundle removed; 6 E2E specs ported; ~5 npm scripts + package.json extension metadata removed; constitution amended; README + CHANGELOG created; CLAUDE.md updated.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The current constitution (v1.0.0) enshrines the VS Code extension as a first-class surface. This removal **intentionally conflicts** with it, so the constitution is amended within this feature (user-approved) rather than treated as an unjustified violation.

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Strict Layering | ⚠ Amended | Clauses naming `adapters/vscode/` removed. Removal *improves* layering: `server/src` no longer imports `vscode` types. Post-removal `core → server`, `core → webview-ui` still hold. |
| II. Protocol Contract Is Law | ✅ Pass | AsyncAPI contract untouched. Both drift checks stay enforced. `core/asyncapi.yaml` unchanged. |
| III. Provider Abstraction | ✅ Pass | `HookProvider`/Claude provider untouched. Removal does not touch `server/src/providers/`. |
| IV. Behavior-First Testing | ✅ Pass (via port) | VS Code Electron E2E specs migrated to standalone harness — behavior coverage preserved, not deleted. `e2e/README.md` inventory regenerated. |
| V. Centralized Constants & Aesthetic | ✅ Pass | ESLint pixel rules untouched. `adapters/vscode/constants.ts` deleted with the adapter. |
| Dual-distribution clause | ⚠ Amended | Struck — single surface now. |
| Persistence isolation clause | ⚠ Amended | Reduced to single-namespace; verify-before-clear migration removed. |

**Gate resolution**: Constitution amendment (MAJOR 1.0.0 → 2.0.0) is an explicit deliverable of this feature (see Complexity Tracking). No unjustified violations remain.

## Project Structure

### Documentation (this feature)

```text
specs/001-remove-vscode-extension/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output — coupling analysis + removal decisions
├── data-model.md        # Phase 1 output — removal inventory (delete / retain / edit)
├── quickstart.md        # Phase 1 output — validation guide (build + test + grep gates)
├── contracts/           # Phase 1 output — invariants the change must preserve
│   ├── standalone-cli.contract.md
│   └── removal-verification.contract.md
├── checklists/
│   └── requirements.md  # Already created by /speckit-specify
└── tasks.md             # Phase 2 output (/speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
adapters/vscode/                     ← DELETE ENTIRELY (6 files)
  extension.ts
  PixelAgentsViewProvider.ts
  agentManager.ts
  vscodeTerminalAdapter.ts
  migrateVsCodeState.ts
  constants.ts

core/                                ← RETAIN (untouched). terminalAdapter.ts interface
  src/                                 stays (standalone may pass no adapter); confirm no
    terminalAdapter.ts                 vscode leakage remains in core.

server/                              ← EDIT (purge vscode type leaks)
  src/
    types.ts                         drop `import type * as vscode`; ServerAgentState.terminalRef
                                       retyped/removed (VS Code-only field)
    fileWatcher.ts                   drop vscode.Terminal casts; terminalAdapter path is
                                       VS-Code-only → remove adapter-driven terminal adoption
    assetLoader.ts                   remove send*ToWebview(vscode.Webview) functions (only
                                       PixelAgentsViewProvider called them); keep load* funcs
    clientMessageHandler.ts          drop "mirror adapters/vscode/constants.ts" coupling comment
    layoutPersistence.ts             drop migrateVsCodeState doc reference
  __tests__/
    migrateVsCodeState.test.ts       ← DELETE (tests deleted adapter file)

webview-ui/                          ← RETAIN. Transport already branches; PostMessage path
  src/transport/                       becomes dead if VS Code is the only postMessage host.
    index.ts                           Confirm createTransport() standalone branch is the sole
    postMessageTransport.ts            live path; remove postMessage transport if unused.

e2e/                                 ← PORT + PRUNE
  fixtures/
    pixel-agents.ts                  ← DELETE (VS Code Electron fixture)
    standalone.ts                    RETAIN (target harness)
  helpers/
    launch.ts                        ← DELETE (Electron launcher)
    webview.ts                       ← DELETE/merge into standalone helpers if VS-Code-specific
  tests/
    claude/hooks-on/{basic,lifecycle,teams}.spec.ts   ← PORT to standalone fixture
    claude/hooks-off/{lifecycle,matrix,pets}.spec.ts  ← PORT to standalone fixture
    standalone/hooks.spec.ts                           RETAIN
  README.md                          regenerate inventory (npm run e2e:inventory)

Build / config / metadata            ← EDIT
  esbuild.js                         remove extension bundle (entryPoints extension.ts,
                                       external:['vscode']); keep CLI + hooks + assets
  package.json                       remove: engines.vscode, extensionKind, activationEvents,
                                       main, contributes, vscode:prepublish, build:extension,
                                       @types/vscode, @vscode/test-electron; fix lint/format/
                                       lint-staged globs that reference adapters/vscode
  tsconfig.json                      remove "adapters/vscode" from include
  eslint.config.mjs                  remove adapters/vscode config block

Docs                                 ← CREATE / EDIT
  README.md                          CREATE (standalone-only usage)
  CHANGELOG.md                       CREATE (discontinuation notice → npx pixel-agents)
  CLAUDE.md                          EDIT (strip VS Code architecture sections)
  .specify/memory/constitution.md    AMEND (MAJOR 1.0.0 → 2.0.0)
```

**Structure Decision**: Monorepo retained (`core/`, `server/`, `webview-ui/`). The `adapters/` layer is eliminated (its only member was `vscode/`). The standalone CLI composition in `server/src/cli.ts` + `server/src/server.ts` becomes the sole entry path. The `TerminalAdapter` abstraction in `core/` is retained as an interface (standalone passes none) but its only implementation (`vscodeTerminalAdapter.ts`) and its consumers in `fileWatcher.ts` are removed — see research.md for whether the interface itself should stay or go.

## Complexity Tracking

> Justifies the one deliberate deviation: amending the constitution inside a feature branch.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|--------------------------------------|
| Amend constitution (MAJOR 1.0.0 → 2.0.0) within this feature | Constitution Principle I, dual-distribution, and persistence-isolation clauses name the VS Code surface as first-class; leaving them describes a surface that no longer exists (permanent governance drift). | "Leave as-is" rejected: governing doc would lie about the codebase. "Defer to separate change" rejected: the removal PR would knowingly ship out-of-compliance with its own constitution; amending in-band keeps every commit self-consistent. |
