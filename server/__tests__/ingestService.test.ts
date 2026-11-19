import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IngestRequest } from '../../core/src/ingestMessages.js';
import { AgentEventReducer } from '../src/agentEventReducer.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { ClientTokenStore } from '../src/clientTokens.js';
import { IngestService } from '../src/ingestService.js';

const TIMEOUT = 30_000;

describe('IngestService presence', () => {
  let dir: string;
  let now: number;
  let store: AgentStateStore;
  let reducer: AgentEventReducer;
  let tokens: ClientTokenStore;
  let ingest: IngestService;
  let auth: string;

  const req = (seq: number, extra: Partial<IngestRequest> = {}): IngestRequest => ({
    protocolVersion: 1,
    clientId: 'c1',
    seq,
    sentAt: seq,
    events: [],
    ...extra,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-ingest-'));
    now = 1_000_000;
    store = new AgentStateStore();
    reducer = new AgentEventReducer({ store });
    tokens = new ClientTokenStore(path.join(dir, 'tokens.json'));
    auth = `Bearer ${tokens.issue('laptop').secret}`;
    ingest = new IngestService({ reducer, tokens, clientTimeoutMs: TIMEOUT, now: () => now });
  });

  afterEach(() => {
    ingest.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps an idle client that keeps signaling', () => {
    ingest.handle(auth, req(1, { snapshot: { sessions: [{ sessionId: 's1' }] } }));
    for (let seq = 2; seq < 10; seq++) {
      now += TIMEOUT / 2;
      expect(ingest.handle(auth, req(seq)).status).toBe(200);
      ingest.checkLiveness();
    }
    expect(store.size).toBe(1);
  });

  it('removes the agents of a client that goes silent', () => {
    ingest.handle(auth, req(1, { snapshot: { sessions: [{ sessionId: 's1' }] } }));
    now += TIMEOUT + 1;
    ingest.checkLiveness();
    expect(store.size).toBe(0);
    expect(ingest.connectedClients()).toEqual([]);
  });

  it('a snapshot after a server restart restores exactly the live sessions', () => {
    ingest.handle(
      auth,
      req(3, { snapshot: { sessions: [{ sessionId: 'a' }, { sessionId: 'b' }] } }),
    );
    expect(store.size).toBe(2);
  });

  it('uses the request label, falling back to the token label', () => {
    ingest.handle(auth, req(1, { snapshot: { sessions: [] } }));
    expect(ingest.labelOf('c1')).toBe('laptop');
    ingest.handle(auth, req(2, { label: 'ana@laptop' }));
    expect(ingest.labelOf('c1')).toBe('ana@laptop');
  });

  it('drops persisted agents of awaited clients that never come back', () => {
    reducer.setRestorable([{ id: 4, clientId: 'c1', sessionId: 's1' }]);
    ingest.awaitClients(['c1']);
    now += TIMEOUT + 1;
    ingest.checkLiveness();
    ingest.handle(auth, req(1, { snapshot: { sessions: [{ sessionId: 's1' }] } }));
    expect(reducer.agentIdFor('c1', 's1')).not.toBe(4);
  });

  it('stores only a hash of issued tokens', () => {
    const raw = fs.readFileSync(path.join(dir, 'tokens.json'), 'utf-8');
    expect(raw).not.toContain(auth.slice(7));
    expect(tokens.list()[0]).not.toHaveProperty('hash');
    expect((fs.statSync(path.join(dir, 'tokens.json')).mode & 0o777).toString(8)).toBe('600');
  });
});
