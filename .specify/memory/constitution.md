<!--
Sync Impact Report
==================
Version change: (template, unversioned) → 1.0.0
Rationale: Initial ratification. Constitution filled from raw template; MAJOR bump to 1.0.0
           establishes the first governed baseline.

Modified principles: none (initial adoption)
Added principles:
  - I. Strict Layering (core → server → adapters; core → webview-ui)
  - II. Protocol Contract Is Law (AsyncAPI single source of truth + CI drift check)
  - III. Provider Abstraction (integrations are additive, never invasive)
  - IV. Behavior-First Testing (E2E over webview-internal unit tests)
  - V. Centralized Constants & Pixel-Art Aesthetic (lint-enforced)
Added sections:
  - Additional Constraints (TypeScript + dual distribution)
  - Development Workflow & Quality Gates
Removed sections: none

Templates requiring updates:
  ✅ .specify/templates/plan-template.md   — Constitution Check is generic ("[Gates
     determined based on constitution file]"); no hardcoded principles to reconcile.
  ✅ .specify/templates/spec-template.md    — no constitution-driven mandatory section added/removed.
  ✅ .specify/templates/tasks-template.md    — task categories already cover testing/lint gates
     implied by Principles III–V; no edit required.
  ✅ .specify/templates/checklist-template.md — generic; unaffected.
  ⚠ .specify/templates/commands/*.md         — directory empty; nothing to reconcile.

Follow-up TODOs: none. RATIFICATION_DATE set to first adoption date (2026-07-13).

---

Version change: 1.0.0 → 2.0.0
Rationale: MAJOR bump. Removed VS Code extension as a shipping surface (deleted
           adapters/vscode/, purged vscode type leaks from server/, removed
           extension build target and VS Code E2E harness). Stripped dual-distribution
           governance, persistence-isolation clauses for separate surfaces, and
           verify-before-clear migration requirement. Reworded error-handling clause
           from "MUST NOT crash the extension" → "MUST NOT crash the server/CLI".
           Reduced from two-surface to single-surface (standalone CLI only).

Modified principles:
  - I. Strict Layering: removed adapters/vscode/ dependency clause and "standalone
       CLI MUST NOT import adapters/vscode" sentence; still bans transport calls
       outside broadcast layer. Layering is now core → server, core → webview-ui.
Removed sections:
  - Additional Constraints → Dual distribution (struck entire paragraph)
  - Additional Constraints → Persistence isolation (rewritten as single-namespace)
  - CI order: removed .vsix packaging step (no longer applicable)
Modified sections:
  - Additional Constraints → Error handling: "extension" → "server/CLI"
  - Development Workflow & Quality Gates: CI order drops extension packaging

Templates requiring updates:
  ✅ .specify/templates/plan-template.md — no principle-specific references changed.
  ✅ .specify/templates/spec-template.md — unaffected.
  ✅ .specify/templates/tasks-template.md — unaffected.
  ✅ .specify/templates/checklist-template.md — unaffected.

Follow-up TODOs: CLAUDE.md and README.md updated in the same feature to reflect
single-surface governance. E2E inventory drift check retained.
-->

# Pixel Agents Constitution

## Core Principles

### I. Strict Layering

Dependencies MUST flow in one direction only:

- `core/` depends on nothing (zero runtime side effects).
- `server/` depends only on `core/`.
- `webview-ui/` depends only on `core/`.

No module under `server/` calls a transport method directly — all outbound messages
flow through the `AgentStateStore` broadcast layer.

**Rationale**: The standalone CLI (`npx pixel-agents`) composes the same runtime as
any future host. Unidirectional dependencies are what make one source tree yield one
coherent artifact without leakage.

### II. Protocol Contract Is Law

`core/asyncapi.yaml` is the single source of truth for the wire protocol. Generated
bindings (`core/src/messages.ts`) MUST be produced only by `scripts/generate-messages.ts`
and MUST NEVER be hand-edited. Every new or changed message MUST be defined in the
AsyncAPI contract first, then regenerated. CI MUST run generation and fail on any
non-empty `git diff` of the generated file.

**Rationale**: Server, VS Code webview, standalone browser, and third-party clients all
speak the same protocol; the wire shape is identical and only the transport differs.
Hand-editing generated code or skipping the contract silently forks that shape and
breaks clients that regenerate from the published `asyncapi.yaml`.

### III. Provider Abstraction

New CLI integrations MUST be additive, never invasive. A new integration is a single
subdirectory under `server/src/providers/hook/<id>/` (provider, optional `TeamProvider`,
installer, hook scripts) with ZERO changes to `AgentRuntime`, the UI, or any existing
provider. The runtime MUST dispatch on canonical `AgentEvent.kind` values, NEVER on
CLI-specific tool names. CLI-specific knowledge (e.g. Claude event names) MUST live only
inside that CLI's provider directory.

**Rationale**: `HookProvider` is the integration boundary. Keeping it the only place that
knows a tool's specifics is what lets "any tool tomorrow" become a character without
destabilizing everything already shipped.

### IV. Behavior-First Testing

User-facing behavior MUST be pinned by E2E tests (Playwright, real VS Code + mock-claude,
plus standalone). Webview internals MUST NOT be locked down with unit tests that force
contributors to update internals tests on top of feature work. Server logic, protocol
routing, persistence, and provider normalization MUST have Vitest coverage. New E2E specs
MUST follow the normative rules in `e2e/README.md` ("Mocking model & rules") — the
process-boundary principle, append-only transcript rule, and assert-on-visible-outcomes
discipline are non-negotiable. Tests MUST NOT invoke real `claude`; the mock-claude
scenario runner is the only permitted driver.

**Rationale**: This is an OSS project; community PRs churn webview internals constantly.
E2E pins the stable contract (what the user sees) while leaving internals free to refactor,
minimizing contributor friction without sacrificing correctness guarantees.

### V. Centralized Constants & Pixel-Art Aesthetic

Magic numbers and strings MUST NOT be inlined; they live in the designated
`constants.ts` per layer (or `index.css` `:root` for CSS custom properties). The
pixel-art aesthetic is enforced by custom ESLint rules (`no-inline-colors`,
`pixel-shadow`, `pixel-font`) at `error` level — color literals belong only in
`constants.ts`, shadows MUST use the pixel token, and fonts MUST reference FS Pixel Sans.
These lint rules block PRs and MUST NOT be downgraded or suppressed to land a change.

**Rationale**: A consistent visual identity and a single home for tunables are what keep a
canvas-heavy, multi-surface UI coherent. Lint enforcement turns style discipline into an
automated gate instead of reviewer memory.

## Additional Constraints

**TypeScript discipline**:

- No `enum` in the webview (`erasableSyntaxOnly`) — use `as const` objects.
- `import type` for type-only imports (`verbatimModuleSyntax`).
- `.js` extensions on all relative imports in extension + server (Node16 resolution).
- `noUnusedLocals` / `noUnusedParameters` strict everywhere.

**Single distribution**: The `pixel-agents` npm package (`npx pixel-agents`) is the only
shipping surface. The `package.json:files` allowlist governs the npm tarball.

**Error handling & resilience**: Errors MUST be caught and logged with graceful
degradation — a failure MUST NOT crash the server or CLI. Malformed JSONL lines and
missing assets are silently tolerated with fallbacks; operation continues.

**Persistence isolation**: Single-namespace persistence under `~/.pixel-agents/`.
All state (layout, config, agents, server discovery) lives in one namespace.
No cross-surface migration is required.

## Development Workflow & Quality Gates

CI MUST pass in this order before merge: install, lint, `asyncapi:validate`,
`asyncapi:generate` + drift check, `e2e:inventory` + drift check, `check-types`,
`test:server`, `test:webview`, `e2e` (standalone only), `package`.

The two drift checks are central guarantees and MUST remain enforced:

1. `core/asyncapi.yaml` ↔ `core/src/messages.ts` stay in lockstep.
2. `e2e/README.md` inventory stays in sync with the spec list.

Any PR that adds/removes a protocol message, an E2E spec, or a lint rule MUST regenerate
the affected artifact in the same PR. Complexity beyond these principles MUST be justified
against a simpler rejected alternative.

## Governance

This constitution supersedes ad-hoc practice. Amendments require a documented rationale, a
version bump per the policy below, and propagation to any dependent template or guidance
doc (`.specify/templates/*`, `CLAUDE.md`, `README.md`) in the same change.

**Versioning policy** (semantic):

- **MAJOR**: Backward-incompatible governance changes — removing or redefining a principle.
- **MINOR**: Adding a new principle or section, or materially expanding guidance.
- **PATCH**: Clarifications, wording, and non-semantic refinements.

**Compliance**: All PRs and reviews MUST verify adherence to these principles. The CI gates
above are the automated enforcement surface; reviewers cover the rest. `CLAUDE.md` remains
the compressed runtime engineering reference and MUST stay consistent with this document.

**Version**: 2.0.0 | **Ratified**: 2026-07-13 | **Last Amended**: 2026-07-16
