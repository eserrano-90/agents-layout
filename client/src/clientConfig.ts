/**
 * Client configuration and persisted state, under ~/.pixel-agents/.
 *
 *   client.json         { clientId, label?, serverUrl?, token?, hooksEnabled, watchAllSessions }
 *   client-state.json   { sessions }  -- live sessions, to resume after a restart
 *
 * Both files are written atomically (tmp + rename) with mode 0600: client.json
 * may hold the token for a remote server.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { SERVER_JSON_DIR } from '../../core/src/constants.js';
import {
  CLIENT_CONFIG_FILE_NAME,
  CLIENT_STATE_FILE_NAME,
  ENV_LABEL,
  ENV_SERVER_URL,
  ENV_TOKEN,
} from './constants.js';
import type { PersistedSession } from './sessionEmitter.js';

export interface ClientConfigFile {
  clientId: string;
  label?: string;
  serverUrl?: string;
  token?: string;
  hooksEnabled: boolean;
  watchAllSessions: boolean;
}

function dir(): string {
  return path.join(os.homedir(), SERVER_JSON_DIR);
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (e) {
    console.error(`[Pixel Agents] Failed to write ${filePath}: ${e}`);
  }
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function defaultClientLabel(): string {
  let user = 'user';
  try {
    user = os.userInfo().username || user;
  } catch {
    /* some sandboxes have no passwd entry */
  }
  return `${user}@${os.hostname()}`;
}

/** Read client.json, creating it (with a fresh stable clientId) when missing. */
export function loadClientConfig(): ClientConfigFile {
  const filePath = path.join(dir(), CLIENT_CONFIG_FILE_NAME);
  const raw = readJson(filePath) ?? {};
  const config: ClientConfigFile = {
    clientId: typeof raw.clientId === 'string' && raw.clientId ? raw.clientId : crypto.randomUUID(),
    label: typeof raw.label === 'string' ? raw.label : undefined,
    serverUrl: typeof raw.serverUrl === 'string' ? raw.serverUrl : undefined,
    token: typeof raw.token === 'string' ? raw.token : undefined,
    hooksEnabled: typeof raw.hooksEnabled === 'boolean' ? raw.hooksEnabled : true,
    watchAllSessions: typeof raw.watchAllSessions === 'boolean' ? raw.watchAllSessions : false,
  };
  if (config.clientId !== raw.clientId) saveClientConfig(config);
  return config;
}

export function saveClientConfig(config: ClientConfigFile): void {
  writeJsonAtomic(path.join(dir(), CLIENT_CONFIG_FILE_NAME), config);
}

export function loadPersistedSessions(): PersistedSession[] {
  const raw = readJson(path.join(dir(), CLIENT_STATE_FILE_NAME));
  return Array.isArray(raw?.sessions) ? (raw.sessions as PersistedSession[]) : [];
}

export function savePersistedSessions(sessions: PersistedSession[]): void {
  writeJsonAtomic(path.join(dir(), CLIENT_STATE_FILE_NAME), { sessions });
}

/** Where the client delivers events, resolved from options, environment and config. */
export interface ResolvedTarget {
  serverUrl: string;
  token: string;
  label: string;
}

/**
 * Resolve the server address, token and label. Precedence: command-line
 * options, then environment, then client.json. Returns the name of the first
 * missing setting instead when the address or token cannot be resolved.
 */
export function resolveTarget(
  options: { serverUrl?: string; token?: string; label?: string },
  env: NodeJS.ProcessEnv,
  config: ClientConfigFile,
): ResolvedTarget | { missing: string } {
  const serverUrl = options.serverUrl ?? env[ENV_SERVER_URL] ?? config.serverUrl;
  const token = options.token ?? env[ENV_TOKEN] ?? config.token;
  const label = options.label ?? env[ENV_LABEL] ?? config.label ?? defaultClientLabel();
  if (!serverUrl) return { missing: `--server (or ${ENV_SERVER_URL})` };
  if (!token) return { missing: `--token (or ${ENV_TOKEN})` };
  return { serverUrl, token, label };
}
