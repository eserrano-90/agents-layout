# Pixel Agents

Pixel art office where your AI coding agents come to life as animated characters.

```bash
npx pixel-agents [--port 3100]
```

Opens a browser-based office view. Agents appear as pixel-art characters, showing their
current activity (typing, reading, browsing, waiting).

## Installation

**Requirements:** Node.js 18 or later. Nothing else to install — `npx` downloads and runs
the package on demand.

```bash
cd your-project        # the directory Claude Code runs in
npx pixel-agents
```

No install step, no global state beyond `~/.pixel-agents/` (see [Persistence](#persistence)).
To skip the download on every run, install it once globally instead:

```bash
npm install -g pixel-agents
pixel-agents            # same CLI, same flags, from anywhere
```

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

If a character doesn't appear, check **Troubleshooting** below.

### Troubleshooting

- **Port 3100 already in use** — pick another port: `npx pixel-agents --port 3200`.
- **No character appears after enabling hooks** — restart any already-running Claude
  Code session; hooks only apply to sessions started after install. Check
  `~/.claude/settings.json` has a `pixel-agents` hook entry.
- **Office loads but stays empty with hooks off** — heuristic mode polls JSONL
  transcripts every few seconds; give it a moment, and confirm the project directory
  matches where Claude Code is actually running.
- **Client can't reach a remote server** — verify the server's `--host`/`--port`, that
  firewalls allow the connection, and that the token wasn't revoked
  (`npx pixel-agents server token list`).
- **Stale state** — delete `~/.pixel-agents/` to reset all settings, layout, and
  tokens, then run `npx pixel-agents` again.

## Running the office on another machine

Pixel Agents has two halves that can run on different machines:

- the **server** shows the office and receives events;
- a **client** runs next to Claude Code, watches its sessions and sends them to a server.

### Connecting a client — step by step

**1. On the machine that will show the office, start the server:**

```bash
npx pixel-agents server --host 0.0.0.0 --port 3100
```

`--host 0.0.0.0` is required for other machines to reach it; the default `127.0.0.1`
only accepts connections from the same machine. See
[Network exposure](#network-exposure) before exposing it beyond a trusted network.

**2. Still on the server machine, issue one token per client:**

```bash
npx pixel-agents server token add ana-laptop      # pick a label that identifies the client
```

This prints the token secret **once** — copy it now. It is not shown again (only the
hashed copy is kept in `client-tokens.json`); if you lose it, revoke it and add a new one.

**3. On each developer machine, start the client with that token:**

```bash
cd your-project        # the directory Claude Code runs in
npx pixel-agents client --server http://office-host:3100 --token <token>
```

Use the server machine's actual address for `--server` (hostname, IP, or Tailscale/VPN
address) — `office-host` above is a placeholder.

**4. Verify it connected:**

- the client logs a successful connection to the server on startup;
- the office page (`http://office-host:3100`) shows a character for that session once
  Claude Code runs there;
- `npx pixel-agents server token list` (run on the server) shows the token as issued.

If it doesn't connect, see [Troubleshooting](#troubleshooting) — "Client can't reach a
remote server".

### Client configuration

The client also reads `PIXEL_AGENTS_URL`, `PIXEL_AGENTS_TOKEN` and `PIXEL_AGENTS_LABEL`
as an alternative to flags — handy for a long-running client in a shell profile or
service unit:

```bash
export PIXEL_AGENTS_URL=http://office-host:3100
export PIXEL_AGENTS_TOKEN=<token>
export PIXEL_AGENTS_LABEL=ana-laptop
npx pixel-agents client
```

Command-line options win over environment variables, which win over
`~/.pixel-agents/client.json` (the client's saved config from a previous run).
When several clients feed one office, each character shows which machine it runs on.

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
