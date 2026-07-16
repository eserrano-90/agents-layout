# Contract: Standalone CLI Preservation

The invariants the standalone `npx pixel-agents` surface MUST still satisfy after the VS Code extension is removed. This is the "nothing regressed" contract (FR-004, FR-006, SC-004). Each item is a checkable assertion, not a code sketch.

## C1 — CLI entry & artifacts

- **MUST** produce `dist/cli.js` from `server/src/cli.ts` via `npm run compile`.
- **MUST** produce `dist/webview/`, `dist/assets/`, `dist/hooks/claude-hook.js`.
- **MUST NOT** produce `dist/extension.js`.
- `package.json.bin.pixel-agents` **MUST** still point to `./dist/cli.js`.

## C2 — HTTP + WebSocket protocol (unchanged)

The Fastify server contract is untouched:

| Method | Path | MUST |
|--------|------|------|
| POST | `/api/hooks/:providerId` | Accept bearer-authenticated hook events |
| GET | `/api/health` | Return `{ ok, version, port, pid }` |
| GET | `/ws` | Serve the bidirectional protocol channel |
| GET | `/*` | Serve the webview SPA (standalone static) |

- Server discovery via `~/.pixel-agents/server.json` (`{ port, pid, authToken }`) **MUST** be unchanged.

## C3 — Protocol contract (frozen)

- `core/asyncapi.yaml` **MUST** be byte-identical (no message added/removed by this feature).
- `core/src/messages.ts` **MUST** still regenerate with zero drift (`npm run asyncapi:generate` → clean `git diff`).
- All 26 ServerMessage / 18 ClientMessage variants **MUST** remain.

## C4 — Persistence (single namespace)

- `~/.pixel-agents/` layout, config, `standalone-state.json`, `layout.json`, `server.json` **MUST** keep working.
- `vscode-state.json` and the verify-before-clear migration path **MUST** be gone (no longer referenced), without breaking standalone read/write.

## C5 — Transport (single path)

- `webview-ui/src/transport/index.ts` `createTransport()` **MUST** return a `WebSocketTransport` for every runtime.
- The `MessageTransport` interface **MUST** be unchanged; all downstream consumers compile untouched.

## C6 — Provider abstraction (untouched)

- `server/src/providers/hook/claude/**` **MUST** be byte-identical.
- Hook install/uninstall, `normalizeHookEvent`, team provider **MUST** be unchanged.

## Verification

Run `quickstart.md`. This contract passes iff every gate there is green **and** `git diff --stat core/ server/src/providers/` shows no changes to protocol or provider files.
