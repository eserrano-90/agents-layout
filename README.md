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

### Claude Code Hook Setup

1. Click **Settings** → enable **Instant Detection (Hooks)**
2. The hook script is installed automatically into `~/.claude/settings.json`
3. When Claude Code runs in any project watched by the office, agents appear instantly

## Features

- **Live agent visualization**: agents walk around, sit at desks, and show activity
- **Automatic detection**: JSONL transcript polling (heuristic fallback) works without hooks
- **Agent Teams support**: teammates appear as separate characters (Claude Agent Teams)
- **Layout editor**: design your office floor plan with furniture, walls, and floors
- **Cross-platform**: macOS, Linux, Windows (browser-based, no editor dependency)

## Architecture

```
core/         Protocol + interface definitions (zero runtime side effects)
server/       Fastify HTTP/WS server + agent lifecycle runtime
webview-ui/   React 19 + Canvas UI (browser SPA)
```

The server exposes:
- `POST /api/hooks/:providerId` — bearer-authenticated hook event ingress
- `GET /api/health` — liveness endpoint
- `GET /ws` — WebSocket protocol channel
- `GET /*` — webview SPA (static files)

## Persistence

State is stored in `~/.pixel-agents/`:
- `config.json` — user settings
- `layout.json` — office layout
- `standalone-state.json` — agent metadata
- `server.json` — server discovery (`{ port, pid, authToken }`)

## Discontinuation Notice

Previously distributed as a VS Code extension (`pablodelucca.pixel-agents`).
See [CHANGELOG.md](./CHANGELOG.md) for details.
