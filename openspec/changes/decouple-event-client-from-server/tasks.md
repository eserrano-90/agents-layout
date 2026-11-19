# Tasks

## 1. Ingest contract in core

- [x] 1.1 Add the ingest channel to `core/asyncapi.yaml`: envelope (`protocolVersion`, `clientId`, `seq`, `sentAt`, `events`, `snapshot?`, `goodbye?`), the per-event wrapper (`sessionId`, `origin`, `ts`, `event`), and every event kind including the new `tokenUsage`, `modelInfo`, `teamInfo`, `sessionReplaced` and the new display fields on `toolStart` / `subagentStart` / `sessionStart`; verify with `npm run asyncapi:validate`
- [x] 1.2 Extend `scripts/generate-messages.ts` to emit `core/src/ingestMessages.ts` and a JSON Schema file for the envelope; verify `npm run asyncapi:generate` is idempotent (`git diff --exit-code core/src` clean on a second run)
- [x] 1.3 Add `clientLabel?` to `agentCreated` / `existingAgents` and `localClient` to the settings payload in `core/asyncapi.yaml`, regenerate, and verify `npm run check-types` passes
- [x] 1.4 Add ingest constants (`INGEST_API_PATH`, protocol version, batch size, flush interval, heartbeat interval, client timeout, queue limit) to `core/src/constants.ts` and verify no numeric literal for them exists elsewhere via `grep`
- [x] 1.5 Extend the CI drift check to cover the new generated files and verify it fails when `core/src/ingestMessages.ts` is hand-edited

## 2. Event reducer inside the server (in-process emitter)

- [x] 2.1 Add a `SessionKey` (`clientId` + `sessionId`) and re-key `SessionRouter`, `ServerAgentState` and `PersistedAgent` on it, using a fixed local client id for now; verify `sessionRouter.test.ts` and `agentStateStore.test.ts` pass after updating them
- [x] 2.2 Create the server-side event reducer by moving the store-mutating half of `TranscriptProcessingService` and the dispatch in `HookRoutingService` into one dispatcher on event kind; add unit tests covering each event kind including the four new ones
- [x] 2.3 Replace every provider lookup in the reducer (`formatToolStatus`, `readingTools`, `permissionExemptTools`, `subagentToolNames`, `isTeammateSpawnCall`, `extractTeammateNameFromEvent`) with the corresponding event field; verify `grep -rn "provider\." server/src/application` returns no reducer hits
- [x] 2.4 Make the transcript parser emit events (status text, activity, token usage, model, team info, sub-agent progress) instead of mutating the store, tagging them `origin: 'transcript'`; verify with unit tests that feed recorded JSONL lines and assert the emitted events
- [x] 2.5 Make scanning, adoption, stale check, `/clear` reassignment and teammate discovery emit `sessionStart` / `sessionEnd` / `sessionReplaced` instead of writing to the store; verify with unit tests per case
- [x] 2.6 Keep permission and text-idle timers in the reducer driven by `origin` and `permissionExempt`; verify the existing timer tests pass unchanged
- [x] 2.7 Run `npm run test:server` and `npm run e2e` and verify the server tests pass and every e2e test that passes on `5de96d3` (reference baseline, see design.md) still passes, with no assertion edits in `e2e/tests/`

## 3. Extract the client workspace

- [x] 3.1 Create `client/` and `cli/` npm workspaces with `package.json` and `tsconfig.json`, register them in the root `workspaces`, `tsconfig.json`, `knip.json` and `eslint.config.mjs`; verify `npm install && npm run check-types` succeeds
- [x] 3.2 Add an ESLint `no-restricted-imports` rule forbidding `client` ↔ `server` imports and verify it fails on a deliberate violation, then remove the violation
- [x] 3.3 Move `server/src/providers/` to `client/src/providers/` and split `core/src/provider.ts` into the generated wire types and `client/src/provider.ts`; move `claude.test.ts`, `claudeHookInstaller.test.ts`, `claudeTeamProvider.test.ts`, `claude-hook.test.ts` to `client/__tests__/` and verify they pass there
- [x] 3.4 Move `FileScanningService`, `NodeFileWatcherAdapter`, `DismissalTrackerService`, their ports and the transcript parser to `client/`; verify `grep -rnE "\.claude|jsonlFile|readFileSync.*jsonl" server/src` returns nothing
- [x] 3.5 Implement the client's loopback hook endpoint (`POST /api/hooks/:providerId`, bearer auth) and have the client write `~/.pixel-agents/server.json`; verify the moved `claude-hook.test.ts` posts successfully to it
- [x] 3.6 Implement the client delivery queue: batching, `seq`, retry with exponential backoff, bounded queue with drop-oldest; verify with unit tests for ordering, retry and overflow
- [x] 3.7 Implement `POST /api/ingest` on the server with the generated JSON Schema, body size limit, `seq` de-duplication and `409 { resync: true }` on a gap; verify with `server.test.ts` cases for valid batch, malformed event (error names the index), duplicate, gap and oversized body
- [x] 3.8 Remove `POST /api/hooks/:providerId`, provider imports and hook installation from `server/`; verify `grep -rn "providers/" server/src` returns nothing and `server/` builds
- [x] 3.9 Move `server/src/cli.ts` to `cli/src/cli.ts` and compose all-in-one mode (server + co-located client over loopback HTTP with an ephemeral token); update `esbuild.js` entry points and `package.json:files`; verify `npm run build && node dist/cli.js --help` works
- [x] 3.10 Route `setHooksEnabled` / `setWatchAllSessions` from the server to the co-located client through `cli/`, and send `localClient: true`; verify the hook install/uninstall e2e test passes
- [x] 3.11 Run `npm test` and `npm run e2e` and verify unit tests pass and the reference e2e baseline (17 tests passing on `5de96d3`) still passes, with no assertion edits in `e2e/tests/`

## 4. Presence, reconciliation and tokens

- [x] 4.1 Implement per-client token storage (hash only, `0600`), constant-time verification and token→`clientId` binding on the server; verify with tests for unknown token, mismatched `clientId` and revoked token
- [x] 4.2 Add `pixel-agents server token add|list|revoke`; verify `add` prints the secret once, `list` never prints it, and a revoked token gets `401`
- [x] 4.3 Generate and persist a stable `clientId` and default label (`<user>@<hostname>`) on the client; verify it survives a client restart
- [x] 4.4 Implement client heartbeat and `goodbye` on clean shutdown, and server-side client expiry that removes that client's agents; verify with fake-timer tests for idle-but-alive, timeout and clean shutdown
- [x] 4.5 Implement the client snapshot (on start, on `409 resync`, after queue overflow) and server reconciliation that adds, keeps and removes agents to match it; verify with tests for server restart, session ended during outage, and seat/appearance preserved
- [x] 4.6 Change restore-on-boot to hold persisted agents as pending until a snapshot confirms them and discard them after the client timeout; verify no `fs` call remains in `agentRuntime.ts` and a test covers "client never returns"
- [x] 4.7 Show `clientLabel` in the webview label only when more than one client is connected; verify with an e2e test using two clients and confirm single-client label snapshots are unchanged
- [x] 4.8 Hide the hooks and watch-all-sessions toggles in `SettingsModal` when `localClient` is false; verify with an e2e assertion in server-only mode

## 5. Deployment modes and documentation

- [x] 5.1 Add the `server` subcommand (no client, no hook install, no scanning) and verify, with an agent session active on the same machine, that no character appears and `~/.claude/settings.json` is untouched
- [x] 5.2 Add the `client` subcommand with `--server`, `--token`, `--label`, env (`PIXEL_AGENTS_URL`, `PIXEL_AGENTS_TOKEN`) and config-file resolution in that precedence; verify precedence with unit tests and that a missing address exits non-zero with a message naming the setting
- [x] 5.3 Print a startup warning when the server binds to a non-loopback host and verify the text appears for `--host 0.0.0.0` and not for the default
- [x] 5.4 Extend `e2e/fixtures/standalone.ts` with a split fixture that starts a server and a client with **different** `HOME` directories, and add `e2e/tests/standalone/split.spec.ts` covering spawn, tool status, token usage, `/clear`, client stop (agents despawn) and server restart (agents return); verify it passes with `--workers=1`
- [x] 5.5 Add a contract-conformance test that posts hand-built batches (no bundled client) to `/api/ingest` and asserts the office state, proving third-party emitters work
- [x] 5.6 Regenerate the e2e inventory with `npm run e2e:inventory` and verify `git diff --exit-code e2e/README.md` is clean afterwards
- [x] 5.7 Update `CLAUDE.md` (architecture tree, communication flow, provider abstraction, persistence, key decisions), `README.md` (three modes, remote setup, what data leaves the machine, reverse-proxy guidance), `server/manual-hook-events.http` (loopback hook endpoint plus an ingest example) and `CHANGELOG.md` (breaking changes, one-time loss of persisted seats); verify every command shown in the README runs as written

## 6. Integration checks

- [ ] 6.1 Run `npm run compile`, `npm test` and `npm run e2e` from a clean checkout and verify they pass (e2e: reference baseline + split spec); run `npm run knip` and verify it reports nothing new compared with `main` (it already fails there)
- [x] 6.2 Run `npm run package`, install the tarball in a scratch directory, and verify `pixel-agents`, `pixel-agents server` and `pixel-agents client --server <url> --token <t>` each start from the installed package
- [ ] 6.3 Manually run a server on one machine (or container) and a client on another against a real Claude Code session and verify the character, status text, tokens and despawn-on-client-stop
