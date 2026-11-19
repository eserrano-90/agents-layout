/**
 * EventDelivery: batches normalized events and delivers them to the server.
 *
 * Guarantees (see openspec event-emitter / client-presence specs):
 *   - Batches leave in the order events were queued, one request at a time,
 *     each with the next `seq`.
 *   - A failed request is retried with exponential backoff; the same batch
 *     (same `seq`) is resent until the server answers.
 *   - The queue is bounded. On overflow the oldest events are dropped and the
 *     next request carries a full session snapshot so the server can recover.
 *   - The first request after start, and the first after the server asks for a
 *     resync, carries a snapshot.
 *   - An idle client sends an empty batch at the heartbeat interval.
 *   - A clean shutdown sends a final `goodbye` batch.
 *
 * Delivery failures never throw out of this class.
 */

import {
  CLIENT_HEARTBEAT_INTERVAL_MS,
  CLIENT_QUEUE_LIMIT,
  INGEST_BATCH_MAX_EVENTS,
  INGEST_FLUSH_INTERVAL_MS,
  INGEST_PROTOCOL_VERSION,
  INGEST_RETRY_BASE_MS,
  INGEST_RETRY_MAX_MS,
} from '../../core/src/constants.js';
import type {
  IngestEvent,
  IngestRequest,
  IngestResponse,
  IngestSnapshotSession,
} from '../../core/src/ingestMessages.js';
import type { Clock } from './ports/Clock.js';
import type { TimerHandle, TimerService } from './ports/Timer.js';

/** Result of one HTTP exchange with the server. */
export interface TransportResult {
  status: number;
  body: IngestResponse | null;
}

/** Sends one request to the server. Rejects on network failure. */
export type IngestTransport = (request: IngestRequest) => Promise<TransportResult>;

export interface EventDeliveryOptions {
  clientId: string;
  label?: string;
  transport: IngestTransport;
  timers: TimerService;
  clock: Clock;
  /** Current list of live sessions, for snapshots. */
  snapshot: () => IngestSnapshotSession[];
  queueLimit?: number;
  batchMaxEvents?: number;
  flushIntervalMs?: number;
  heartbeatIntervalMs?: number;
  log?: (message: string) => void;
}

export class EventDelivery {
  private queue: IngestEvent[] = [];
  private inFlight: IngestRequest | null = null;
  private nextSeq = 1;
  private needsSnapshot = true;
  private retryDelay = INGEST_RETRY_BASE_MS;
  private flushTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private heartbeatTimer: TimerHandle | null = null;
  private lastSentAt = 0;
  private stopped = false;
  private lastErrorLogged = '';

  private readonly queueLimit: number;
  private readonly batchMaxEvents: number;
  private readonly flushIntervalMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly log: (message: string) => void;

  /** Number of events dropped because the queue overflowed. */
  droppedEvents = 0;

  constructor(private readonly opts: EventDeliveryOptions) {
    this.queueLimit = opts.queueLimit ?? CLIENT_QUEUE_LIMIT;
    this.batchMaxEvents = opts.batchMaxEvents ?? INGEST_BATCH_MAX_EVENTS;
    this.flushIntervalMs = opts.flushIntervalMs ?? INGEST_FLUSH_INTERVAL_MS;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? CLIENT_HEARTBEAT_INTERVAL_MS;
    this.log = opts.log ?? ((m) => console.log(`[Pixel Agents] Client: ${m}`));
  }

  /** Begin delivering: send the initial snapshot and start heartbeats. */
  start(): void {
    this.stopped = false;
    this.heartbeatTimer = this.opts.timers.setInterval(() => {
      if (this.inFlight || this.retryTimer) return;
      if (this.opts.clock.now() - this.lastSentAt >= this.heartbeatIntervalMs) {
        this.send();
      }
    }, this.heartbeatIntervalMs);
    this.send();
  }

  /** Queue one event for delivery. */
  enqueue(event: IngestEvent): void {
    if (this.stopped) return;
    this.queue.push(event);
    if (this.queue.length > this.queueLimit) {
      const overflow = this.queue.length - this.queueLimit;
      this.queue.splice(0, overflow);
      this.droppedEvents += overflow;
      // The server can no longer rebuild state from events alone.
      this.needsSnapshot = true;
    }
    if (this.queue.length >= this.batchMaxEvents) {
      this.flushNow();
    } else if (!this.flushTimer) {
      this.flushTimer = this.opts.timers.setTimeout(() => {
        this.flushTimer = null;
        this.send();
      }, this.flushIntervalMs);
    }
  }

  /** Force a snapshot on the next request (e.g. after a settings change). */
  requestSnapshot(): void {
    this.needsSnapshot = true;
    this.flushNow();
  }

  get pendingEvents(): number {
    return this.queue.length + (this.inFlight?.events.length ?? 0);
  }

  /**
   * Stop delivering. Sends what is queued plus a final `goodbye` batch, waiting
   * at most `timeoutMs` for the server.
   */
  async stop(timeoutMs: number): Promise<void> {
    this.clearTimers();
    this.stopped = true;
    const deadline = this.opts.clock.now() + timeoutMs;
    // Let an in-flight request finish first so seq order holds.
    while (this.inFlight && this.opts.clock.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const request = this.buildRequest(true);
    request.goodbye = true;
    try {
      await Promise.race([
        this.opts.transport(request),
        new Promise((r) => setTimeout(r, Math.max(0, deadline - this.opts.clock.now()))),
      ]);
    } catch {
      /* best effort */
    }
  }

  // ── Internal ───────────────────────────────────────────────

  private flushNow(): void {
    if (this.flushTimer) {
      this.opts.timers.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.send();
  }

  private clearTimers(): void {
    for (const t of [this.flushTimer, this.retryTimer]) {
      if (t) this.opts.timers.clearTimeout(t);
    }
    if (this.heartbeatTimer) this.opts.timers.clearInterval(this.heartbeatTimer);
    this.flushTimer = null;
    this.retryTimer = null;
    this.heartbeatTimer = null;
  }

  /** Build the next request from the queue. Consumes up to one batch of events. */
  private buildRequest(drainAll = false): IngestRequest {
    const count = drainAll ? this.queue.length : Math.min(this.queue.length, this.batchMaxEvents);
    const events = this.queue.splice(0, count);
    const request: IngestRequest = {
      protocolVersion: INGEST_PROTOCOL_VERSION,
      clientId: this.opts.clientId,
      label: this.opts.label,
      seq: this.nextSeq++,
      sentAt: this.opts.clock.now(),
      events,
    };
    if (this.needsSnapshot) {
      request.snapshot = { sessions: this.opts.snapshot() };
      this.needsSnapshot = false;
    }
    return request;
  }

  private send(): void {
    if (this.stopped || this.inFlight || this.retryTimer) return;
    const request = this.buildRequest();
    this.dispatch(request);
  }

  private dispatch(request: IngestRequest): void {
    this.inFlight = request;
    this.lastSentAt = this.opts.clock.now();
    this.opts
      .transport(request)
      .then((result) => this.onResult(request, result))
      .catch((err: unknown) =>
        this.onFailure(request, err instanceof Error ? err.message : String(err)),
      );
  }

  private onResult(request: IngestRequest, result: TransportResult): void {
    if (result.status === 409 && result.body?.resync) {
      // The server lost track of our sequence. Resend this batch's events
      // together with a snapshot so nothing is applied out of order.
      this.inFlight = null;
      this.queue.unshift(...request.events);
      this.needsSnapshot = true;
      this.retryDelay = INGEST_RETRY_BASE_MS;
      this.send();
      return;
    }
    if (result.status >= 200 && result.status < 300) {
      this.inFlight = null;
      this.retryDelay = INGEST_RETRY_BASE_MS;
      this.lastErrorLogged = '';
      if (result.body?.resync) this.needsSnapshot = true;
      if (this.queue.length > 0 || this.needsSnapshot) this.send();
      return;
    }
    if (result.status === 401 || result.status === 403) {
      this.onFailure(request, `server rejected the token (HTTP ${result.status})`);
      return;
    }
    if (result.status >= 400 && result.status < 500) {
      // The server will never accept this batch (contract mismatch). Drop it
      // rather than block every later event behind it, and resync.
      this.logOnce(
        `server rejected a batch (HTTP ${result.status}): ${result.body?.error ?? 'no reason given'}`,
      );
      this.inFlight = null;
      this.needsSnapshot = true;
      this.send();
      return;
    }
    this.onFailure(request, `server error (HTTP ${result.status})`);
  }

  private onFailure(request: IngestRequest, reason: string): void {
    this.logOnce(`delivery failed, retrying: ${reason}`);
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryDelay * 2, INGEST_RETRY_MAX_MS);
    this.retryTimer = this.opts.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) {
        this.inFlight = null;
        return;
      }
      // Resend the same batch (same seq) with any events queued since appended
      // as a fresh batch afterwards.
      this.dispatch(request);
    }, delay);
  }

  private logOnce(message: string): void {
    if (message === this.lastErrorLogged) return;
    this.lastErrorLogged = message;
    this.log(message);
  }
}

/** HTTP transport to `<serverUrl>/api/ingest` using the global fetch. */
export function createHttpTransport(
  serverUrl: string,
  token: string,
  ingestPath: string,
  timeoutMs: number,
): IngestTransport {
  const url = new URL(ingestPath, serverUrl).toString();
  return async (request) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      let body: IngestResponse | null = null;
      try {
        body = (await res.json()) as IngestResponse;
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  };
}
