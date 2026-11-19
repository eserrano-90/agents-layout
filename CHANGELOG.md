# Changelog

## Unreleased

### Client and server can run on different machines

`pixel-agents` now has two halves: a **client** that watches Claude Code sessions on a
developer machine and a **server** that shows the office. `npx pixel-agents` still runs
both together, unchanged. `npx pixel-agents server` and
`npx pixel-agents client --server <url> --token <token>` run them apart. See
[README.md](./README.md#running-the-office-on-another-machine).

**Breaking changes**

- The server no longer accepts `POST /api/hooks/:providerId`. Claude Code's hook script
  now posts to the client's loopback endpoint, which `~/.pixel-agents/server.json` still
  describes (same path and shape). Third-party emitters post normalized event batches to
  `POST /api/ingest` (contract: the `ingest` channel in `core/asyncapi.yaml`).
- `HookProvider` / `TeamProvider` moved from `core/` to `client/`; `core/` now exports
  the generated ingest contract instead.
- Agents are persisted by client and session instead of by transcript path. **External
  agents persisted by an earlier version are not restored once**: they reappear on their
  next activity, but lose their seat and appearance.
- "Instant Detection (Hooks)" and "Watch All Sessions" are client settings, stored in
  `~/.pixel-agents/client.json`. They are hidden in the office of a server-only instance.

## 2026-07-16

### VS Code Extension Discontinued

The VS Code extension (`pablodelucca.pixel-agents`) is no longer distributed or
maintained. The project now ships exclusively as a standalone CLI.

**What changed**: The `adapters/vscode/` layer, extension build target, VS Code E2E
harness, and all VS Code metadata have been removed. The codebase is now single-surface.

**What to do**: If you installed the VS Code extension, it will continue to work with
its last published version. For ongoing updates and new features, use the standalone CLI:

```bash
npx pixel-agents
```

See [README.md](./README.md) for usage instructions.

*Note: Unpublishing the VS Code Marketplace and Open VSX listings is tracked
externally and is out of scope for this repository.*
