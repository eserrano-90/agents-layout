/**
 * Loopback endpoint that receives raw hook payloads from the agent tool's hook
 * script, and the ~/.pixel-agents/server.json discovery file that tells the
 * script where to post.
 *
 *   POST /api/hooks/:providerId   Bearer-authenticated, 127.0.0.1 only
 *   GET  /api/health              liveness probe (no auth)
 *
 * The endpoint answers immediately; delivery to the server happens later and
 * asynchronously, so the agent tool's hook never waits on the network.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { HOOK_API_PREFIX, SERVER_JSON_DIR, SERVER_JSON_NAME } from '../../core/src/constants.js';
import { HOOK_ENDPOINT_HOST, MAX_HOOK_BODY_SIZE } from './constants.js';

/** Discovery file written to ~/.pixel-agents/server.json for hook scripts. */
export interface HookEndpointConfig {
  /** Loopback port of the hook endpoint. */
  port: number;
  /** PID of the process that owns the endpoint. */
  pid: number;
  /** Token the hook script must send in the Authorization header. */
  token: string;
  /** Timestamp (ms) when the endpoint started. */
  startedAt: number;
  /** CI / e2e diagnostic ONLY: hook scripts log their delivery outcome here.
   *  Env vars don't reliably reach the spawned hook process across platforms. */
  debugLog?: string;
}

export type RawHookHandler = (providerId: string, payload: Record<string, unknown>) => void;

const PROVIDER_ID_PATTERN = /^[a-z0-9-]+$/;
const HEALTH_PATH = '/api/health';

function serverJsonPath(): string {
  return path.join(os.homedir(), SERVER_JSON_DIR, SERVER_JSON_NAME);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export class HookEndpoint {
  private server: http.Server | null = null;
  private config: HookEndpointConfig | null = null;

  constructor(private readonly onHook: RawHookHandler) {}

  async start(): Promise<HookEndpointConfig> {
    const token = crypto.randomUUID();
    const expected = `Bearer ${token}`;
    const server = http.createServer((req, res) => this.handle(req, res, expected));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, HOOK_ENDPOINT_HOST, () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    this.server = server;
    this.config = {
      port,
      pid: process.pid,
      token,
      startedAt: Date.now(),
      ...(process.env['PIXEL_AGENTS_DEBUG_LOG']
        ? { debugLog: process.env['PIXEL_AGENTS_DEBUG_LOG'] }
        : {}),
    };
    this.writeServerJson(this.config);
    console.log(`[Pixel Agents] Hook endpoint listening on ${HOOK_ENDPOINT_HOST}:${port}`);
    return this.config;
  }

  async stop(): Promise<void> {
    this.deleteServerJson();
    const server = this.server;
    this.server = null;
    this.config = null;
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  getConfig(): HookEndpointConfig | null {
    return this.config;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, expected: string): void {
    if (req.method === 'GET' && req.url === HEALTH_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: process.pid }));
      return;
    }
    const match = req.url?.match(new RegExp(`^${HOOK_API_PREFIX}/([^/?]+)`));
    if (req.method !== 'POST' || !match || !PROVIDER_ID_PATTERN.test(match[1])) {
      res.writeHead(404).end();
      return;
    }
    if (!timingSafeEqualStrings(req.headers.authorization ?? '', expected)) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const providerId = match[1];
    let size = 0;
    const chunks: Buffer[] = [];
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_HOOK_BODY_SIZE) {
        aborted = true;
        res.writeHead(413).end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      res.writeHead(200).end('ok');
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
        if (
          payload &&
          typeof payload === 'object' &&
          typeof (payload as Record<string, unknown>).session_id === 'string' &&
          typeof (payload as Record<string, unknown>).hook_event_name === 'string'
        ) {
          this.onHook(providerId, payload as Record<string, unknown>);
        }
      } catch {
        /* malformed payload: the hook already got its answer */
      }
    });
  }

  /** Write server.json atomically (tmp + rename) with mode 0600. */
  private writeServerJson(config: HookEndpointConfig): void {
    const filePath = serverJsonPath();
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (e) {
      console.error(`[Pixel Agents] Failed to write server.json: ${e}`);
    }
  }

  /** Delete server.json only if it still describes this process. */
  private deleteServerJson(): void {
    try {
      const filePath = serverJsonPath();
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as HookEndpointConfig;
      if (existing.pid === process.pid) fs.unlinkSync(filePath);
    } catch {
      /* already gone */
    }
  }
}
