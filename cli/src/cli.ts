#!/usr/bin/env node

/**
 * `npx pixel-agents` entry point. Three modes:
 *
 *   pixel-agents [--port N] [--host H]         all-in-one: server + local client
 *   pixel-agents server [--port N] [--host H]  server only (no session observing)
 *   pixel-agents server token add|list|revoke  manage client tokens
 *   pixel-agents client --server URL --token T client only (no UI)
 *
 * This is the only module that may import both client/ and server/.
 */

import * as path from 'path';

import { startClient } from '../../client/src/client.js';
import { loadClientConfig, resolveTarget } from '../../client/src/clientConfig.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
} from '../../server/src/assetLoader.js';
import type { AssetCache } from '../../server/src/clientMessageHandler.js';
import { ClientTokenStore } from '../../server/src/clientTokens.js';
import { startServer } from '../../server/src/server.js';

const DEFAULT_PORT = 3100;
const DEFAULT_HOST = '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const USAGE = `Usage:
  pixel-agents [--port N] [--host H]
      Run the office and observe Claude Code sessions on this machine.

  pixel-agents server [--port N] [--host H]
      Run only the office. Sessions arrive from clients (see below).
  pixel-agents server token add <label>
  pixel-agents server token list
  pixel-agents server token revoke <id|label>
      Manage the tokens clients use to send events.

  pixel-agents client --server <url> --token <token> [--label <name>]
      Observe Claude Code sessions on this machine and send them to a server.
      Also read from PIXEL_AGENTS_URL, PIXEL_AGENTS_TOKEN, PIXEL_AGENTS_LABEL.

Options:
  --port, -p <number>   Port to listen on (default: ${DEFAULT_PORT})
  --host <string>       Host to bind to (default: ${DEFAULT_HOST})
  --help                Show this help message`;

interface ParsedArgs {
  positional: string[];
  port: number;
  host: string;
  server?: string;
  token?: string;
  label?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { positional: [], port: DEFAULT_PORT, host: DEFAULT_HOST };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if ((a === '--port' || a === '-p') && next) {
      args.port = parseInt(next, 10);
      i++;
    } else if (a === '--host' && next) {
      args.host = next;
      i++;
    } else if (a === '--server' && next) {
      args.server = next;
      i++;
    } else if (a === '--token' && next) {
      args.token = next;
      i++;
    } else if (a === '--label' && next) {
      args.label = next;
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

/** dist/ holds the CLI bundle plus assets/, webview/ and hooks/. */
const distRoot = __dirname;
/** Root that contains dist/ (copyHookScript looks for dist/hooks/ under it). */
const packageRoot = path.dirname(distRoot);

async function loadAssets(): Promise<AssetCache> {
  console.log('[Pixel Agents] Loading assets...');
  const cache: AssetCache = {
    characters: await loadCharacterSprites(distRoot),
    pets: await loadPetSprites(distRoot),
    floorTiles: await loadFloorTiles(distRoot).then((t) => t?.sprites ?? null),
    wallTiles: await loadWallTiles(distRoot).then((t) => t?.sets ?? null),
    furniture: await loadFurnitureAssets(distRoot),
    defaultLayout: loadDefaultLayout(distRoot),
  };
  console.log(
    `[Pixel Agents] Assets loaded: ${cache.characters?.characters.length ?? 0} characters, ${cache.pets?.pets.length ?? 0} pets, ${cache.furniture?.catalog.length ?? 0} furniture items`,
  );
  return cache;
}

function warnIfExposed(host: string): void {
  if (LOOPBACK_HOSTS.has(host)) return;
  console.warn(
    `\n  WARNING: listening on ${host}. The office page and its /ws channel have no\n` +
      '  authentication: anyone who can reach this address sees agent activity.\n' +
      '  Put an authenticating reverse proxy in front of it. Only /api/ingest\n' +
      '  requires a client token.\n',
  );
}

function onShutdown(stop: () => Promise<void>): void {
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    console.log('\nShutting down...');
    stop()
      .catch((err: unknown) => console.error(err))
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function runAllInOne(args: ParsedArgs): Promise<void> {
  const tokens = new ClientTokenStore();
  const server = await startServer({
    host: args.host,
    port: args.port,
    staticDir: path.join(distRoot, 'webview'),
    assetCache: await loadAssets(),
    tokens,
  });
  warnIfExposed(args.host);

  // The co-located client delivers over loopback HTTP like any other client,
  // with a token that exists only in this process.
  const config = loadClientConfig();
  const client = await startClient({
    serverUrl: `http://127.0.0.1:${server.port}`,
    token: tokens.addEphemeral(config.label ?? 'local'),
    packageRoot,
    workspacePath: process.cwd(),
  });
  server.setLocalClient(client);

  console.log(`\n  Pixel Agents running at http://${args.host}:${server.port}\n`);
  onShutdown(async () => {
    await client.stop();
    await server.stop();
  });
}

async function runServer(args: ParsedArgs): Promise<void> {
  const server = await startServer({
    host: args.host,
    port: args.port,
    staticDir: path.join(distRoot, 'webview'),
    assetCache: await loadAssets(),
  });
  warnIfExposed(args.host);
  console.log(`\n  Pixel Agents server running at http://${args.host}:${server.port}\n`);
  console.log(
    `  Clients connect with: pixel-agents client --server http://<this-host>:${server.port} --token <token>`,
  );
  console.log('  Issue a token with:   pixel-agents server token add <label>\n');
  onShutdown(() => server.stop());
}

function runTokenCommand(rest: string[]): void {
  const tokens = new ClientTokenStore();
  const [sub, arg] = rest;
  switch (sub) {
    case 'add': {
      if (!arg) {
        console.error('Usage: pixel-agents server token add <label>');
        process.exit(1);
      }
      const { id, secret } = tokens.issue(arg);
      console.log(`Token ${id} issued for "${arg}". It is shown only once:\n\n  ${secret}\n`);
      return;
    }
    case 'list': {
      const list = tokens.list();
      if (list.length === 0) {
        console.log('No tokens issued.');
        return;
      }
      for (const t of list) {
        const bound = t.clientId ? `bound to ${t.clientId}` : 'not used yet';
        console.log(
          `${t.id}  ${t.label}  (${bound}, issued ${new Date(t.createdAt).toISOString()})`,
        );
      }
      return;
    }
    case 'revoke': {
      if (!arg) {
        console.error('Usage: pixel-agents server token revoke <id|label>');
        process.exit(1);
      }
      if (!tokens.revoke(arg)) {
        console.error(`No token matches "${arg}".`);
        process.exit(1);
      }
      console.log(`Revoked ${arg}.`);
      return;
    }
    default:
      console.error(USAGE);
      process.exit(1);
  }
}

async function runClient(args: ParsedArgs): Promise<void> {
  const target = resolveTarget(
    { serverUrl: args.server, token: args.token, label: args.label },
    process.env,
    loadClientConfig(),
  );
  if ('missing' in target) {
    console.error(`pixel-agents client: no server configured. Set ${target.missing}.`);
    process.exit(1);
  }
  const client = await startClient({
    serverUrl: target.serverUrl,
    token: target.token,
    label: target.label,
    packageRoot,
    workspacePath: process.cwd(),
  });
  console.log(`\n  Pixel Agents client "${target.label}" sending to ${target.serverUrl}\n`);
  onShutdown(() => client.stop());
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [mode, ...rest] = args.positional;
  try {
    if (mode === undefined) await runAllInOne(args);
    else if (mode === 'server' && rest[0] === 'token') runTokenCommand(rest.slice(1));
    else if (mode === 'server') await runServer(args);
    else if (mode === 'client') await runClient(args);
    else {
      console.error(`Unknown command "${mode}".\n\n${USAGE}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
}

void main();
