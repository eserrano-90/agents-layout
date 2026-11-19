# Pixel Agents

Pixel art office where your AI coding agents come to life as animated characters.

```bash
npx pixel-agents [--port 3100]
```

Opens a browser-based office view. Agents appear as pixel-art characters, showing their
current activity (typing, reading, browsing, waiting).

## Quick Start

```bash
npx pixel-agents
# Open http://localhost:3100 in your browser
```

This runs everything on one machine: the office and a local client that watches
Claude Code sessions in the current directory.

### Claude Code Hook Setup

1. Click **Settings** → enable **Instant Detection (Hooks)**
2. The hook script is installed automatically into `~/.claude/settings.json`
3. When Claude Code runs in any project watched by the office, agents appear instantly

## Running the office on another machine

Pixel Agents has two halves that can run on different machines:

- the **server** shows the office and receives events;
- a **client** runs next to Claude Code, watches its sessions and sends them to a server.

```bash
# On the machine that shows the office
npx pixel-agents server --host 0.0.0.0 --port 3100
npx pixel-agents server token add ana-laptop      # prints a token once

# On each developer machine
npx pixel-agents client --server http://office-host:3100 --token <token>
```

The client also reads `PIXEL_AGENTS_URL`, `PIXEL_AGENTS_TOKEN` and `PIXEL_AGENTS_LABEL`.
Command-line options win over environment variables, which win over
`~/.pixel-agents/client.json`. When several clients feed one office, each character
shows which machine it runs on.

Manage tokens on the server with `npx pixel-agents server token list` and
`npx pixel-agents server token revoke <id|label>`. A revoked client is refused on its
next request and its characters leave the office after 30 seconds.

### What leaves the developer's machine

The client sends only the fields of the ingest contract (`core/asyncapi.yaml`): session
ids, the project folder name, the working-directory and transcript paths (as labels),
tool names, the **status line the office displays** (for example `Running: npm test`,
truncated to 30 characters for shell commands), token counts, the model name and team
membership. It never sends prompts, tool inputs, tool outputs or transcript contents.

A shell command typed with a secret on the command line can still appear, truncated, in
its status line.

### Network exposure

The server listens on `127.0.0.1` unless `--host` is given. Only `POST /api/ingest`
requires a token: the office page and its `/ws` channel are **not authenticated**.
When you bind to another address, put an authenticating reverse proxy (and TLS) in
front of the server. The server prints a warning when it is bound to a non-loopback
address.

## Features

- **Live agent visualization**: agents walk around, sit at desks, and show activity
- **Automatic detection**: JSONL transcript polling (heuristic fallback) works without hooks
- **Agent Teams support**: teammates appear as separate characters (Claude Agent Teams)
- **Several machines, one office**: run clients anywhere, one server shows them all
- **Layout editor**: design your office floor plan with furniture, walls, and floors
- **Cross-platform**: macOS, Linux, Windows (browser-based, no editor dependency)

## Architecture

```
core/         Protocol contract (AsyncAPI) + generated types (no runtime side effects)
client/       Emitter: Claude Code provider, hooks, transcript watching, delivery
server/       Receiver + viewer: ingest, agent state, WebSocket, office SPA
cli/          `pixel-agents` entry: all-in-one, server and client modes
webview-ui/   React 19 + Canvas UI (browser SPA)
```

The server exposes:
- `POST /api/ingest` — event batches from clients (per-client bearer token)
- `GET /api/health` — liveness endpoint
- `GET /ws` — WebSocket protocol channel
- `GET /*` — webview SPA (static files)

The client exposes, on `127.0.0.1` only:
- `POST /api/hooks/:providerId` — raw hook events from Claude Code's hook script

Any program that posts contract-conforming batches to `/api/ingest` with a valid token
is a valid client; see the `ingest` channel in `core/asyncapi.yaml`.

## Persistence

State is stored in `~/.pixel-agents/`:
- `config.json` — office settings
- `layout.json` — office layout
- `standalone-state.json` — agent identities and seats (server)
- `client-tokens.json` — issued client tokens, hashes only (server)
- `client.json` — client id, label, server address and token (client)
- `client-state.json` — sessions the client is watching (client)
- `server.json` — the client's local hook endpoint (`{ port, pid, token }`)

## Discontinuation Notice

Previously distributed as a VS Code extension (`pablodelucca.pixel-agents`).
See [CHANGELOG.md](./CHANGELOG.md) for details.
