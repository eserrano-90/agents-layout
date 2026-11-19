import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IngestEvent, IngestRequest } from '../../core/src/ingestMessages.js';
import { NodeTimerAdapter } from '../src/adapters/NodeTimerAdapter.js';
import { EventDelivery, type TransportResult } from '../src/delivery.js';

const ev = (n: number): IngestEvent => ({
  sessionId: 's1',
  origin: 'transcript',
  ts: n,
  event: { kind: 'progress', toolId: `t${n}` },
});
const ok = (seq: number): TransportResult => ({ status: 200, body: { ok: true, appliedSeq: seq } });

describe('EventDelivery', () => {
  let sent: IngestRequest[];
  let respond: (req: IngestRequest) => Promise<TransportResult>;
  let timers: NodeTimerAdapter;

  const make = (opts: Partial<ConstructorParameters<typeof EventDelivery>[0]> = {}) =>
    new EventDelivery({
      clientId: 'c1',
      transport: (req) => {
        sent.push(structuredClone(req));
        return respond(req);
      },
      timers,
      clock: { now: () => Date.now() },
      snapshot: () => [{ sessionId: 's1' }],
      log: () => {},
      ...opts,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    respond = async (req) => ok(req.seq);
    timers = new NodeTimerAdapter();
  });

  afterEach(() => {
    timers.clearAll();
    vi.useRealTimers();
  });

  it('sends a snapshot first, then batches in order with increasing seq', async () => {
    const d = make();
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    d.enqueue(ev(1));
    d.enqueue(ev(2));
    await vi.advanceTimersByTimeAsync(100);
    expect(sent[0].snapshot?.sessions).toEqual([{ sessionId: 's1' }]);
    expect(sent.map((r) => r.seq)).toEqual([1, 2]);
    expect(sent[1].events.map((e) => e.ts)).toEqual([1, 2]);
    expect(sent[1].snapshot).toBeUndefined();
  });

  it('retries a failed batch with the same seq and keeps order after recovery', async () => {
    let down = true;
    respond = async (req) => {
      if (down) throw new Error('ECONNREFUSED');
      return ok(req.seq);
    };
    const d = make();
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    d.enqueue(ev(1));
    await vi.advanceTimersByTimeAsync(300);
    d.enqueue(ev(2));
    d.enqueue(ev(3));
    down = false;
    await vi.advanceTimersByTimeAsync(10_000);
    const delivered = sent.filter(
      (_r, i) => i === sent.length - 1 || sent[i + 1]?.seq !== sent[i].seq,
    );
    expect(new Set(sent.filter((r) => r.seq === 1).map((r) => r.sentAt)).size).toBe(1);
    const order = delivered.flatMap((r) => r.events.map((e) => e.ts));
    expect(order).toEqual([1, 2, 3]);
  });

  it('drops the oldest events on overflow and sends a snapshot on recovery', async () => {
    let down = true;
    respond = async (req) => {
      if (down) throw new Error('down');
      return ok(req.seq);
    };
    const d = make({ queueLimit: 3, batchMaxEvents: 100 });
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 1; i <= 6; i++) d.enqueue(ev(i));
    expect(d.droppedEvents).toBe(3);
    down = false;
    await vi.advanceTimersByTimeAsync(10_000);
    const afterFirst = sent.filter((r) => r.seq > 1);
    expect(afterFirst[0].snapshot).toBeDefined();
    expect(afterFirst.flatMap((r) => r.events.map((e) => e.ts))).toEqual([4, 5, 6]);
  });

  it('resends with a snapshot when the server asks for a resync', async () => {
    let first = true;
    respond = async (req) => {
      if (req.seq === 2 && first) {
        first = false;
        return { status: 409, body: { ok: false, resync: true } };
      }
      return ok(req.seq);
    };
    const d = make();
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    d.enqueue(ev(1));
    await vi.advanceTimersByTimeAsync(100);
    const retry = sent.find((r) => r.seq === 3);
    expect(retry?.snapshot).toBeDefined();
    expect(retry?.events.map((e) => e.ts)).toEqual([1]);
  });

  it('sends a heartbeat when idle', async () => {
    const d = make({ heartbeatIntervalMs: 1000 });
    d.start();
    await vi.advanceTimersByTimeAsync(3500);
    expect(sent.length).toBeGreaterThanOrEqual(3);
    expect(sent.at(-1)?.events).toEqual([]);
  });

  it('says goodbye on stop', async () => {
    const d = make();
    d.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopped = d.stop(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await stopped;
    expect(sent.at(-1)?.goodbye).toBe(true);
  });

  it('keeps retrying, without throwing, when the token is rejected', async () => {
    respond = async () => ({ status: 401, body: { ok: false, error: 'unauthorized' } });
    const log = vi.fn();
    const d = make({ log });
    d.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(log).toHaveBeenCalledTimes(1);
    expect(sent.length).toBeGreaterThan(1);
  });
});
