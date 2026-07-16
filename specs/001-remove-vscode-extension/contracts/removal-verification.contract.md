# Contract: Removal Verification

The assertions that prove the VS Code surface is *gone*, not merely disconnected. Maps directly to the spec's Success Criteria. Each is a grep/build/test gate.

## V1 — No VS Code source (SC-003)

- `test -d adapters/` → **MUST** fail (directory removed).
- `grep -rn "from 'vscode'\|from \"vscode\"\|import type \* as vscode" server/src core/src webview-ui/src` → **MUST** return zero.
- `grep -rn "acquireVsCodeApi\|WebviewViewProvider\|PostMessageTransport" webview-ui/src` → **MUST** return zero.
- `grep -rn "TerminalAdapter\|migrateVsCodeState" core server` → **MUST** return zero.

**Exemptions** (allowed to match): `CHANGELOG.md` discontinuation notice, `specs/**` (this feature's own docs), git history.

## V2 — No VS Code artifact (SC-001, FR-001)

- After `npm run package`: `test -f dist/extension.js` → **MUST** fail.
- `package.json` **MUST NOT** contain `engines.vscode`, `extensionKind`, `activationEvents`, `main`, `contributes`, `vscode:prepublish`, `build:extension`.
- `package.json.devDependencies` **MUST NOT** contain `@types/vscode` or `@vscode/test-electron`.

## V3 — Build & typecheck green (FR-004)

- `npm run check-types` → **MUST** pass (no dangling `vscode` types).
- `npm run lint` → **MUST** pass (no reference to removed `adapters/vscode` in ESLint/globs).
- `npm run compile` → **MUST** succeed and emit CLI/webview/assets/hooks only.

## V4 — Tests green with no VS Code paths (SC-002, FR-003)

- `npm run test:server` → **MUST** pass; no test imports `adapters/vscode`.
- `npm run test:webview` → **MUST** pass.
- `npm run e2e` → **MUST** pass entirely on the standalone harness.
- `grep -rln "fixtures/pixel-agents\|helpers/launch" e2e/tests` → **MUST** return zero.
- `npm run e2e:inventory` → **MUST** leave `e2e/README.md` with zero drift.

## V5 — Docs & governance consistent (FR-005, FR-007, FR-008)

- `README.md` **MUST** exist and document only `npx pixel-agents` (no install-the-extension instructions).
- `CHANGELOG.md` **MUST** contain a discontinuation notice pointing to `npx pixel-agents`.
- `CLAUDE.md` **MUST NOT** describe the VS Code adapter layer, dual-distribution, or VS Code E2E as current.
- `.specify/memory/constitution.md` **MUST** be version 2.0.0 and read as single-surface; both drift checks still mandated.

## V6 — CI leaner (SC-005)

- CI config **MUST NOT** run a `.vsix` package/publish step or a VS Code Electron E2E leg.
- *(Note: no `.github/` workflows exist in the working tree — if CI config lives elsewhere or is added, this gate applies there. Log if no CI config is found so the reduction is auditable.)*

## Pass condition

The feature is DONE-verifiable iff V1–V5 are all green and V6 is either satisfied or explicitly logged as "no CI config present in repo".
