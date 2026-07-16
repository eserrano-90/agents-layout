# Phase 0 Research: Remove VS Code Extension

Coupling analysis of the VS Code surface and the decisions that resolve every open question in `plan.md`. All findings verified against the working tree on branch `001-remove-vscode-extension`.

## R1 — VS Code adapter surface boundary

**Decision**: Delete `adapters/vscode/` in full (6 files: `extension.ts`, `PixelAgentsViewProvider.ts`, `agentManager.ts`, `vscodeTerminalAdapter.ts`, `migrateVsCodeState.ts`, `constants.ts`) and remove the `adapters/` directory entirely (it has no other members).

**Rationale**: These files import the `vscode` module and exist solely to host Pixel Agents inside the editor. Nothing in `core/`, `server/`, or `webview-ui/` imports them at runtime (verified: `grep -rl adapters/vscode` outside `adapters/` returns only build config, one server test, and doc-comment references — no production runtime import).

**Alternatives considered**: Keep as a dormant/unbuilt directory — rejected: leaves dead `vscode`-dependent code that `check-types` and lint must still process, and contradicts SC-003 (zero `vscode` matches in production source).

## R2 — `vscode` type leaks in `server/src/`

**Decision**: Purge `vscode` types from three server files. They use `import type * as vscode` (type-only, erased at build) but still couple the server to VS Code's API shape:

- `server/src/types.ts` — `ServerAgentState.terminalRef?: vscode.Terminal`. Drop the import and the field (VS Code-only; standalone has no terminal handle).
- `server/src/fileWatcher.ts` — casts `terminalAdapter?.activeTerminal()` to `vscode.Terminal`. This whole terminal-adoption path is driven by the VS-Code-only `TerminalAdapter`. Remove the adapter-driven branch (see R3).
- `server/src/assetLoader.ts` — `send*ToWebview(webview: vscode.Webview, ...)` functions. Only `PixelAgentsViewProvider` called them (verified). Remove these functions; retain all `load*` functions (used by `cli.ts`).

**Rationale**: Even type-only `vscode` imports violate strict layering post-removal (`server/` must not know VS Code). Removing them is the mechanical follow-through that makes SC-003 pass for the server layer.

**Alternatives considered**: Leave type-only imports (they don't affect the bundle) — rejected: `@types/vscode` is being removed as a devDependency, so these imports would fail `check-types`; and they contradict the single-surface invariant.

## R3 — `TerminalAdapter` abstraction fate

**Decision**: Remove the `TerminalAdapter` interface (`core/src/terminalAdapter.ts`) and its consumer path in `fileWatcher.ts`.

**Rationale**: Verified references are exactly two: the definition in `core/src/terminalAdapter.ts` and the consumer in `server/src/fileWatcher.ts`. No code in `server/src/{agentRuntime,server,cli}.ts` constructs or injects a terminal adapter (grep returned zero). Its only implementation was `vscodeTerminalAdapter.ts` (deleted in R1). With no implementation and no injector, the interface is dead. The terminal-adoption scanner logic in `fileWatcher.ts` that depends on it is VS-Code-only (adopting editor terminals into agents) and is removed with it.

**Alternatives considered**: Keep the interface in `core/` "for future adapters" — rejected: YAGNI, and `core/` must stay side-effect-free and minimal; a future CLI integration would define its own boundary via `HookProvider` (Principle III), not a terminal adapter. Retaining a zero-implementation interface is speculative generality that the constitution's simplicity clause discourages.

## R4 — Webview `PostMessageTransport` fate

**Decision**: Remove `PostMessageTransport` (`webview-ui/src/transport/postMessageTransport.ts`), simplify `createTransport()` to always use `WebSocketTransport`, and simplify `runtime.ts` (the `acquireVsCodeApi` branch always resolves to `browser`).

**Rationale**: `createTransport()` returns `PostMessageTransport` only when `!isBrowserRuntime`, and `isBrowserRuntime` is false only inside a VS Code webview (`acquireVsCodeApi` defined). With the extension gone, no host ever provides `acquireVsCodeApi`, so the postMessage path is unreachable. Constitution Principle IV says webview internals are *not* pinned by unit tests, so this refactor is low-risk and keeps the "one transport, one branch" story honest.

**Alternatives considered**: Leave the transport branch intact — rejected: it's dead code referencing a host that no longer exists, and it keeps `runtime.ts`'s `vscode` detection alive (contradicts SC-003 spirit for the webview). Note: this is the one item where "leave it" is *defensible* (it's inert and type-safe), so it is sequenced as a clearly-labeled cleanup task, not a correctness-critical one.

## R5 — Build target removal (`esbuild.js`)

**Decision**: Remove the extension esbuild context (`entryPoints: ['adapters/vscode/extension.ts']`, `external: ['vscode']`, `outfile: 'dist/extension.js'`). Keep `buildCli()`, `copyAssets()`, `buildHooks()`. The `main()` function is restructured so the CLI/assets/hooks build no longer hangs off the extension context's `else` branch.

**Rationale**: `dist/extension.js` is the extension entry; with no extension it produces nothing shippable. The CLI, assets, and hook bundles are the standalone artifacts and must survive untouched (FR-001, FR-004). Watch mode (`--watch`) currently only watches the extension context — after removal, watch should target the CLI build (or be dropped from the extension path).

**Alternatives considered**: Guard the extension build behind a flag — rejected: no consumer, adds a conditional for a deleted surface.

## R6 — `package.json` metadata

**Decision**: Remove VS Code fields and scripts:
- Fields: `engines.vscode`, `extensionKind`, `activationEvents`, `main`, `contributes`, `publisher` (VS Code Marketplace identity — retain only if still meaningful for npm; else drop).
- Scripts: `vscode:prepublish`, `build:extension`; fix `compile`/`package` to drop the extension esbuild step if separated; fix `lint`, `lint:fix`, `format`, `format:check`, and `lint-staged` globs that reference `adapters/vscode`.
- devDependencies: `@types/vscode`, `@vscode/test-electron`.
- Keep: `bin.pixel-agents → ./dist/cli.js`, `workspaces`, all Fastify deps.

**Rationale**: These fields make npm/VS Code treat the package as an installable extension (FR-007). Removing them leaves a clean npm-only manifest. `files` allowlist is not present in package.json today (verified) — confirm the npm publish path during implementation; if a `files` array is added, it must exclude `dist/extension.js`.

**Alternatives considered**: Keep `contributes`/`engines.vscode` "harmlessly" — rejected: contradicts FR-007 (must not present as an actively maintained extension) and would keep VS Code Marketplace tooling treating it as an extension.

## R7 — E2E migration strategy (user-selected: port to standalone)

**Decision**: Migrate the 6 Electron-fixture specs onto the standalone fixture, then delete the Electron harness.

- Port targets (currently `fixtures/pixel-agents`): `claude/hooks-on/{basic,lifecycle,teams}.spec.ts`, `claude/hooks-off/{lifecycle,matrix,pets}.spec.ts`.
- Target harness: `e2e/fixtures/standalone.ts` + `e2e/helpers/standalone.ts` (`launchStandalone(page)` spawns the Fastify server and drives the browser SPA; already used by `standalone/hooks.spec.ts`).
- Delete after port: `e2e/fixtures/pixel-agents.ts`, `e2e/helpers/launch.ts` (Electron launcher), and any VS-Code-specific parts of `e2e/helpers/webview.ts`.
- Regenerate `e2e/README.md` inventory via `npm run e2e:inventory` (drift check must pass).

**Rationale**: Preserves behavior coverage (Principle IV) rather than deleting it. The standalone fixture already exercises the identical protocol over WebSocket — the mock-claude scenario runner and hook ingress are transport-agnostic, so scenarios port with fixture/locator swaps, not logic rewrites.

**Key porting notes** (verified from fixtures):
- The standalone fixture takes Playwright's `page` and returns a `StandaloneSession`; VS Code panel-launch and `webview.ts` settings helpers must be re-expressed against the browser page / standalone helpers.
- Assertions on visible outcomes (overlays, bubbles) transfer directly — office rendering is identical across transports.
- Tests that assert VS-Code-only behavior (terminal adoption, `claude --session-id` terminal launch, panel auto-show) have **no standalone equivalent** and must be dropped rather than ported — flag each explicitly in `tasks.md` and note the coverage delta (constitution: no silent caps).

**Alternatives considered**: "Delete VS Code specs only" and "delete now, port later" — rejected by the user in favor of preserving coverage now.

## R8 — Constitution amendment (user-selected: amend in this feature)

**Decision**: Amend `.specify/memory/constitution.md` in this feature. Version **1.0.0 → 2.0.0** (MAJOR: removing/redefining principles).

Edits:
- **Principle I (Strict Layering)**: remove the `adapters/vscode/` dependency clause and the "standalone CLI MUST NOT import adapters/vscode" sentence. Keep `core → server`, `core → webview-ui`, and the broadcast-layer rule.
- **Additional Constraints → Dual distribution**: strike the paragraph; replace with a single-distribution statement (npm `pixel-agents` only).
- **Additional Constraints → Persistence isolation**: reduce to single-namespace persistence; remove the verify-before-clear VS Code migration requirement.
- **Error handling**: reword "MUST NOT crash the extension" → "MUST NOT crash the server/CLI".
- **Development Workflow & Quality Gates**: remove `package` (`.vsix`) from the CI order if it referred to extension packaging; keep npm packaging. Keep both drift checks.
- **Sync Impact Report** header: prepend a new entry documenting 1.0.0 → 2.0.0 and the rationale.

**Rationale**: Keeps every commit self-consistent with its own governance (see plan.md Complexity Tracking). Constitution Governance section requires a version bump + rationale + propagation to dependent docs (`CLAUDE.md`, `README.md`) in the same change — satisfied here.

**Alternatives considered**: Defer / leave as-is — rejected by the user.

## R9 — Docs + discontinuation notice (user-selected: README + CHANGELOG)

**Decision**: Create `README.md` (standalone-only: what it is, `npx pixel-agents [--port 3100]`, hook setup, no VS Code content) and `CHANGELOG.md` (entry noting the VS Code extension is discontinued and directing users to `npx pixel-agents`). Update `CLAUDE.md` to strip VS Code architecture (adapter layer, dual-distribution, VS Code E2E legs, migration).

**Rationale**: Satisfies FR-005 (docs describe standalone only) and FR-008 (discoverable discontinuation notice). No README/CHANGELOG exist in the repo today (verified), so both are created fresh.

**Scope boundary (from spec Assumptions)**: Unpublishing/archiving the live VS Code Marketplace and Open VSX listings is an external, one-way action **out of scope** for this repo-level feature. The CHANGELOG notice is the in-repo deliverable; the external listing action is tracked separately.

**Alternatives considered**: CLAUDE.md-only or CLAUDE.md+CHANGELOG — rejected by the user in favor of a full README.

## Open questions

None. All NEEDS CLARIFICATION and both plan-level open questions (R3 terminal adapter, R4 postMessage transport) are resolved.
