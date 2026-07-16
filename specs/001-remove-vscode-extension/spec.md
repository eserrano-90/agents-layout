# Feature Specification: Remove VS Code Extension

**Feature Branch**: `001-remove-vscode-extension`

**Created**: 2026-07-16

**Status**: Draft

**Input**: User description: "Remove all code about the vscode extesion in this project"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintainer drops a distribution surface to cut upkeep cost (Priority: P1)

As a project maintainer, I want the VS Code extension surface (code, build target, packaging, and its dedicated tests) removed from the repository so the project has a single supported distribution (the standalone CLI/npm package) instead of two surfaces that must be kept in sync.

**Why this priority**: This is the core ask — without it, nothing else in this feature matters. It directly reduces ongoing maintenance, build, and CI cost.

**Independent Test**: Can be fully tested by running the full build and test suite after removal and confirming: no `.vsix` artifact is produced, no VS Code-specific source remains, and every remaining command (`npm run compile`, `npm test`, `npm run e2e`) completes successfully against the standalone-only codebase.

**Acceptance Scenarios**:

1. **Given** the repository after removal, **When** a maintainer runs the project build, **Then** it produces only the standalone CLI/npm artifacts and no VS Code extension package.
2. **Given** the repository after removal, **When** a maintainer runs the full test suite (unit + e2e), **Then** all remaining tests pass and no test references a VS Code-only code path.
3. **Given** the repository after removal, **When** a maintainer searches the codebase for VS Code extension APIs (e.g. `vscode` module imports, `WebviewViewProvider`), **Then** no production source file outside of historical git history contains such references.

---

### User Story 2 - Contributor gets a simpler, single-surface codebase (Priority: P2)

As a contributor, I want the codebase, docs, and architecture references to describe only the standalone CLI so I don't have to reason about two parallel adapters, two persistence namespaces, or two transports when making a change.

**Why this priority**: Improves clarity and onboarding once the extension is gone, but is a direct consequence of User Story 1 rather than independent work — it's the "make it clean" follow-through.

**Independent Test**: Can be tested by reading the updated architecture documentation and confirming it describes one runtime surface end-to-end, and by confirming a new contributor can trace a feature (e.g. "agent spawns") through the code without hitting a VS Code-only branch.

**Acceptance Scenarios**:

1. **Given** the updated project documentation, **When** a contributor reads the architecture overview, **Then** it describes only the standalone CLI/server/webview flow, with no VS Code adapter layer.
2. **Given** the updated codebase, **When** a contributor inspects persistence and transport code, **Then** there is exactly one persistence namespace and one transport implementation in active use, not a VS Code/standalone split.

---

### User Story 3 - Existing VS Code extension user is not silently broken (Priority: P3)

As someone who currently has the Pixel Agents VS Code extension installed, I want to understand that the extension is no longer maintained/available so I'm not confused when it stops receiving updates, and I know the standalone CLI is the supported path forward.

**Why this priority**: Lower priority than the removal itself, but skipping it entirely creates a poor experience for existing users; it is polish/communication rather than core scope.

**Independent Test**: Can be tested by confirming a clear, discoverable statement exists (in the repository, e.g. README/CHANGELOG) that the VS Code extension has been discontinued and pointing to the standalone CLI as the replacement.

**Acceptance Scenarios**:

1. **Given** a person visiting the project's README after this change, **When** they look for VS Code extension instructions, **Then** they instead find a clear note that the extension is discontinued and a pointer to `npx pixel-agents`.

---

### Edge Cases

- What happens to code that is shared but was written to serve both surfaces (e.g. layout persistence format, protocol contract) — it MUST remain intact for the standalone CLI even though the VS Code-only half of its consumers is removed.
- What happens to the one-time legacy state migration logic that only exists to migrate old VS Code global/workspace state — it has no purpose without the VS Code host and MUST be removed rather than left dead.
- What happens to CI jobs that build/test/publish the extension (e.g. `.vsix` packaging, VS Code Marketplace/Open VSX publish steps, VS Code E2E matrix legs) — they MUST be removed so CI doesn't fail trying to build a surface that no longer exists.
- What happens to in-flight or historical VS Code extension installations already in users' editors — this feature only controls the repository; it cannot reach into already-installed extensions (see clarification on marketplace listing handling).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST no longer build, package, or produce a VS Code extension artifact (`.vsix`) as part of its build or release process.
- **FR-002**: The project MUST remove all VS Code adapter source code (extension activation, webview view provider, terminal/agent management tied to VS Code APIs, VS Code-only migration and persistence code) and any code that exists solely to support it.
- **FR-003**: The project MUST remove VS Code-specific tests (unit and end-to-end) and any CI steps that build, test, or publish the VS Code extension, while preserving all tests that validate the standalone CLI.
- **FR-004**: The standalone CLI (`npx pixel-agents`) MUST retain full existing functionality with no feature regression after the VS Code surface is removed — every capability a user has today via the standalone path MUST continue to work identically.
- **FR-005**: Project documentation (README, architecture docs, CLAUDE.md-style references) MUST no longer describe VS Code extension installation, usage, or architecture as a current, supported feature.
- **FR-006**: Shared building blocks that are still used by the standalone CLI (protocol contract, layout persistence format, core schemas) MUST NOT be removed or altered in ways that break the standalone CLI, even though they were originally designed to serve both surfaces.
- **FR-007**: Project metadata (package manifests, marketplace listing text tracked in the repo, extension identity fields) MUST no longer present the VS Code extension as an actively maintained, installable product.
- **FR-008**: The project MUST provide a clear, discoverable statement that the VS Code extension is discontinued and that the standalone CLI is the supported replacement. *(handling of the live marketplace listings themselves is out of this feature's control — see Assumptions)*

### Key Entities

- **VS Code Adapter Surface**: The set of source files, build targets, tests, and docs whose sole purpose is running Pixel Agents inside VS Code (activation, webview host, terminal management, VS Code-only persistence/migration). Entirely removed by this feature.
- **Standalone CLI Surface**: The npm-distributed `npx pixel-agents` server + webview SPA. Untouched in behavior; becomes the project's only distribution surface.
- **Shared Core**: Protocol contract, schemas, and persistence formats used by both surfaces today. Retained as-is for the standalone CLI; only its VS Code-only consumers are removed.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Building the project produces zero VS Code extension artifacts, down from one (`.vsix`) today.
- **SC-002**: 100% of the remaining automated test suite (unit + e2e) passes with zero references to VS Code-only code paths.
- **SC-003**: A full-text search of the repository for VS Code extension APIs (`vscode` module usage, extension manifest fields) returns zero matches in production source, outside of the discontinuation notice and historical changelog entries.
- **SC-004**: Every capability available today through `npx pixel-agents` remains available and passes its existing acceptance tests after removal, with 0% functional regression.
- **SC-005**: CI pipeline duration and job count decrease because VS Code packaging/publish/test legs are no longer run (measurable by comparing job count before/after).

## Assumptions

- The standalone CLI (npm package `pixel-agents`) already implements 100% of the functionality end users need; nothing VS Code-only is uniquely valuable enough to port before removal.
- Shared protocol/schema/persistence code (`core/`, layout format, AsyncAPI contract) stays exactly as useful to the standalone CLI as it is today; this feature removes VS Code *consumers* of that code, not the shared code itself.
- This feature covers the repository and its CI/build/release pipeline only. It does not cover unpublishing or archiving the existing listings on the VS Code Marketplace or Open VSX — that is an external, one-way action tracked separately (see clarification below).
- Existing users with the extension already installed will keep whatever version they have; no forced uninstall or auto-migration to the standalone CLI is in scope.
