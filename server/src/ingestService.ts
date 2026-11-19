/**
 * IngestService: accepts event batches from emitting clients.
 *
 * Responsibilities (openspec event-ingestion + client-presence):
 *   - authenticate the bearer token and bind it to one client id
 *   - validate the body against the published contract (generated JSON Schema)
 *   - reject unsupported contract versions
 *   - apply batches in `seq` order per client; acknowledge duplicates without
 *     re-applying; answer a gap with a resync request
 *   - reconcile a client's agents with its snapshot
 *   - track liveness: remove a client's agents on `goodbye` or after the
 *     timeout, and drop persisted agents of clients that never come back
 *
 * Nothing here reads the emitting machine's filesystem: an event's paths are
 * labels only.
 */

import Ajv, { type ValidateFunction } from 'ajv';

import { CLIENT_TIMEOUT_MS, INGEST_SUPPORTED_VERSIONS } from '../../core/src/constants.js';
import type { IngestRequest, IngestResponse } from '../../core/src/ingestMessages.js';
import { INGEST_REQUEST_SCHEMA } from '../../core/src/ingestSchema.js';
import type { AgentEventReducer } from './agentEventReducer.js';
import type { ClientTokenStore } from './clientTokens.js';
import { CLIENT_LIVENESS_CHECK_INTERVAL_MS } from './constants.js';

export interface ConnectedClient {
  clientId: string;
  label: string;
  lastSeenAt: number;
  lastSeq: number;
  lastSentAt: number;
}

export interface IngestResult {
  status: number;
  body: IngestResponse;
}

export interface IngestServiceOptions {
  reducer: AgentEventReducer;
  tokens: ClientTokenStore;
  clientTimeoutMs?: number;
  now?: () => number;
  /** Called when the set of connected clients changes. */
  onClientsChanged?: () => void;
}

let compiled: ValidateFunction | null = null;

function validator(): ValidateFunction {
  if (!compiled) {
    // strict: false -- the schema is generated from AsyncAPI and may carry
    // annotation keywords Ajv doesn't know; they don't affect validation.
    const ajv = new Ajv({ strict: false, allErrors: false });
    const { $id: _id, ...schema } = INGEST_REQUEST_SCHEMA as unknown as Record<string, unknown>;
    compiled = ajv.compile(schema);
  }
  return compiled;
}

/** Index in `events` of the first validation error, when it points into one. */
function eventIndexOf(validate: ValidateFunction): number | undefined {
  for (const err of validate.errors ?? []) {
    const m = err.instancePath.match(/^\/events\/(\d+)/);
    if (m) return Number(m[1]);
  }
  return undefined;
}

export class IngestService {
  private readonly clients = new Map<string, ConnectedClient>();
  private readonly reducer: AgentEventReducer;
  private readonly tokens: ClientTokenStore;
  private readonly clientTimeoutMs: number;
  private readonly now: () => number;
  private readonly onClientsChanged?: () => void;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  /** Clients with persisted agents from before a restart: id -> when we started waiting. */
  private readonly awaitedClients = new Map<string, number>();

  constructor(opts: IngestServiceOptions) {
    this.reducer = opts.reducer;
    this.tokens = opts.tokens;
    this.clientTimeoutMs = opts.clientTimeoutMs ?? CLIENT_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
    this.onClientsChanged = opts.onClientsChanged;
  }

  /** Expect these clients to come back (they had persisted agents). */
  awaitClients(clientIds: Iterable<string>): void {
    for (const id of clientIds) this.awaitedClients.set(id, this.now());
  }

  startLivenessCheck(intervalMs = CLIENT_LIVENESS_CHECK_INTERVAL_MS): void {
    if (this.livenessTimer) return;
    this.livenessTimer = setInterval(() => this.checkLiveness(), intervalMs);
    this.livenessTimer.unref?.();
  }

  dispose(): void {
    if (this.livenessTimer) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
  }

  connectedClients(): ConnectedClient[] {
    return [...this.clients.values()];
  }

  labelOf(clientId: string): string | undefined {
    return this.clients.get(clientId)?.label;
  }

  /** Remove clients that have been silent too long, and give up on awaited ones. */
  checkLiveness(): void {
    const now = this.now();
    for (const client of [...this.clients.values()]) {
      if (now - client.lastSeenAt > this.clientTimeoutMs) {
        console.log(`[Pixel Agents] Client ${client.label} timed out; removing its agents`);
        this.disconnect(client.clientId);
      }
    }
    for (const [clientId, since] of [...this.awaitedClients]) {
      if (now - since > this.clientTimeoutMs) {
        this.awaitedClients.delete(clientId);
        this.reducer.discardRestorable(clientId);
      }
    }
  }

  /** Handle one POST /api/ingest. Never throws. */
  handle(authorization: string | undefined, body: unknown): IngestResult {
    const secret = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    const token = this.tokens.verify(secret);
    if (!token) return { status: 401, body: { ok: false, error: 'unauthorized' } };

    // Version first, so an incompatible client gets a useful answer even if
    // the rest of its body doesn't match this server's schema.
    const version = (body as { protocolVersion?: unknown } | null)?.protocolVersion;
    if (typeof version !== 'number' || !INGEST_SUPPORTED_VERSIONS.includes(version)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: `unsupported protocolVersion ${String(version)}`,
          supportedVersions: [...INGEST_SUPPORTED_VERSIONS],
        },
      };
    }

    const validate = validator();
    if (!validate(body)) {
      const first = validate.errors?.[0];
      return {
        status: 400,
        body: {
          ok: false,
          error: `invalid request${first ? `: ${first.instancePath || '/'} ${first.message ?? ''}`.trimEnd() : ''}`,
          eventIndex: eventIndexOf(validate),
        },
      };
    }
    const request = body as IngestRequest;

    // The token decides who the client is.
    if (token.clientId && token.clientId !== request.clientId) {
      return {
        status: 403,
        body: { ok: false, error: 'clientId does not match the token' },
      };
    }
    if (!token.clientId) this.tokens.bind(token, request.clientId);

    try {
      return this.apply(request, token.label);
    } catch (err) {
      console.error('[Pixel Agents] Failed to apply ingest batch:', err);
      return { status: 500, body: { ok: false, error: 'failed to apply batch' } };
    }
  }

  private apply(request: IngestRequest, tokenLabel: string): IngestResult {
    const now = this.now();
    let client = this.clients.get(request.clientId);

    // Retried batch whose first response was lost.
    if (client && request.seq === client.lastSeq && request.sentAt === client.lastSentAt) {
      client.lastSeenAt = now;
      return { status: 200, body: { ok: true, appliedSeq: client.lastSeq } };
    }

    if (!request.snapshot) {
      // Without a snapshot the server must already be in step with the client.
      if (!client || request.seq > client.lastSeq + 1) {
        if (client) client.lastSeenAt = now;
        return {
          status: 409,
          body: { ok: false, resync: true, appliedSeq: client?.lastSeq ?? 0 },
        };
      }
      if (request.seq <= client.lastSeq) {
        client.lastSeenAt = now;
        return { status: 200, body: { ok: true, appliedSeq: client.lastSeq } };
      }
    }

    const isNew = !client;
    if (!client) {
      client = {
        clientId: request.clientId,
        label: request.label || tokenLabel,
        lastSeenAt: now,
        lastSeq: 0,
        lastSentAt: 0,
      };
      this.clients.set(request.clientId, client);
      this.awaitedClients.delete(request.clientId);
      console.log(`[Pixel Agents] Client connected: ${client.label} (${client.clientId})`);
    }
    client.lastSeenAt = now;
    client.lastSeq = request.seq;
    client.lastSentAt = request.sentAt;
    if (request.label) client.label = request.label;
    if (isNew) this.onClientsChanged?.();

    // The snapshot reflects the client's state when the batch was built, which
    // already includes this batch's events; applying it first makes the events
    // that follow idempotent confirmations.
    if (request.snapshot) this.reducer.reconcile(request.clientId, request.snapshot.sessions);

    for (const e of request.events) {
      try {
        this.reducer.apply(request.clientId, e.sessionId, e.origin, e.event);
      } catch (err) {
        console.error('[Pixel Agents] Failed to apply event:', err);
      }
    }

    if (request.goodbye) {
      console.log(`[Pixel Agents] Client disconnected: ${client.label}`);
      this.disconnect(request.clientId);
    }

    return { status: 200, body: { ok: true, appliedSeq: request.seq } };
  }

  private disconnect(clientId: string): void {
    this.clients.delete(clientId);
    this.reducer.removeClientAgents(clientId);
    this.onClientsChanged?.();
  }
}
