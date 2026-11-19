import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../core/src/ingest.js';
import type { IngestRequest } from '../../core/src/ingestMessages.js';

// Isolated HOME so nothing touches the real ~/.pixel-agents/.
let tmpBase: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

const { startServer } = await import('../src/server.js');
const { ClientTokenStore } = await import('../src/clientTokens.js');

type Running = Awaited<ReturnType<typeof startServer>>;

const toolStart = (toolId: string, statusText = 'Running: npm test'): AgentEvent => ({
  kind: 'toolStart',
  toolId,
  toolName: 'Bash',
  statusText,
  activity: 'typing',
  permissionExempt: false,
  spawnsSubagent: false,
});

function batch(
  seq: number,
  events: IngestRequest['events'],
  extra: Partial<IngestRequest> = {},
): IngestRequest {
  return { protocolVersion: 1, clientId: 'client-a', seq, sentAt: 1000 + seq, events, ...extra };
}

async function post(port: number, token: string | null, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('server ingest endpoint', () => {
  let server: Running;
  let token: string;
  let broadcasts: Array<Record<string, unknown>>;

  beforeEach(async () => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-server-test-'));
    const tokens = new ClientTokenStore(path.join(tmpBase, 'tokens.json'));
    token = tokens.issue('laptop').secret;
    server = await startServer({ host: '127.0.0.1', port: 0, tokens });
    broadcasts = [];
    server.store.on('broadcast', (m) => broadcasts.push(m));
  });

  afterEach(async () => {
    await server?.stop();
    fs.rmSync(tmpBase, { recursive: true, force: true });
  });

  it('applies a valid batch in order: session start then tool start', async () => {
    const res = await post(
      server.port,
      token,
      batch(
        1,
        [
          {
            sessionId: 's1',
            origin: 'hook',
            ts: 1,
            event: { kind: 'sessionStart', folderName: 'proj' },
          },
          { sessionId: 's1', origin: 'hook', ts: 2, event: toolStart('hook-1') },
        ],
        { snapshot: { sessions: [] } },
      ),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, appliedSeq: 1 });
    expect(server.store.size).toBe(1);
    const toolMsg = broadcasts.find((m) => m.type === 'agentToolStart');
    expect(toolMsg).toMatchObject({ status: 'Running: npm test', toolName: 'Bash' });
  });

  it('accepts an empty batch without changing state', async () => {
    const res = await post(server.port, token, batch(1, [], { snapshot: { sessions: [] } }));
    expect(res.status).toBe(200);
    expect(server.store.size).toBe(0);
  });

  it('rejects a missing or unknown token', async () => {
    expect((await post(server.port, null, batch(1, []))).status).toBe(401);
    expect((await post(server.port, 'not-a-token', batch(1, []))).status).toBe(401);
    expect(server.store.size).toBe(0);
  });

  it('binds a token to its first client and rejects another identity', async () => {
    await post(server.port, token, batch(1, [], { snapshot: { sessions: [] } }));
    const res = await post(server.port, token, batch(2, [], { clientId: 'client-b' }));
    expect(res.status).toBe(403);
  });

  it('rejects a revoked token', async () => {
    await post(server.port, token, batch(1, [], { snapshot: { sessions: [] } }));
    server.tokens.revoke('laptop');
    expect((await post(server.port, token, batch(2, []))).status).toBe(401);
  });

  it('rejects a malformed event and names its index, applying nothing', async () => {
    const res = await post(
      server.port,
      token,
      batch(
        1,
        [
          { sessionId: 's1', origin: 'hook', ts: 1, event: { kind: 'sessionStart' } },
          { sessionId: 's1', origin: 'hook', ts: 2, event: { kind: 'nope' } as never },
        ],
        { snapshot: { sessions: [] } },
      ),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { eventIndex?: number };
    expect(body.eventIndex).toBe(1);
    expect(server.store.size).toBe(0);
  });

  it('rejects an oversized body', async () => {
    const res = await post(server.port, token, 'x'.repeat(2 * 1024 * 1024));
    expect(res.status).toBe(413);
  });

  it('rejects an unsupported version and lists the supported ones', async () => {
    const res = await post(server.port, token, batch(1, [], { protocolVersion: 99 }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { supportedVersions: number[] }).supportedVersions).toEqual([1]);
  });

  it('acknowledges a retried batch without applying it twice', async () => {
    const first = batch(
      1,
      [
        { sessionId: 's1', origin: 'transcript', ts: 1, event: { kind: 'sessionStart' } },
        {
          sessionId: 's1',
          origin: 'transcript',
          ts: 2,
          event: { kind: 'tokenUsage', inputTokens: 10, outputTokens: 5 },
        },
      ],
      { snapshot: { sessions: [] } },
    );
    await post(server.port, token, first);
    const res = await post(server.port, token, first);
    expect(res.status).toBe(200);
    const agent = [...server.store.values()][0];
    expect(agent.inputTokens).toBe(10);
  });

  it('asks for a resync on a sequence gap and does not apply the batch', async () => {
    await post(server.port, token, batch(1, [], { snapshot: { sessions: [] } }));
    const res = await post(
      server.port,
      token,
      batch(5, [{ sessionId: 's1', origin: 'hook', ts: 1, event: { kind: 'sessionStart' } }]),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { resync: boolean }).resync).toBe(true);
    expect(server.store.size).toBe(0);
  });

  it('asks an unknown client without a snapshot to resync (server restarted)', async () => {
    const res = await post(server.port, token, batch(7, []));
    expect(res.status).toBe(409);
  });

  it('removes the client agents on goodbye', async () => {
    await post(
      server.port,
      token,
      batch(1, [{ sessionId: 's1', origin: 'hook', ts: 1, event: { kind: 'sessionStart' } }], {
        snapshot: { sessions: [] },
      }),
    );
    expect(server.store.size).toBe(1);
    await post(server.port, token, batch(2, [], { goodbye: true }));
    expect(server.store.size).toBe(0);
  });

  it('keeps serving other clients when one sends garbage', async () => {
    const other = server.tokens.issue('ci').secret;
    await post(server.port, token, 'not json');
    const res = await post(
      server.port,
      other,
      batch(1, [{ sessionId: 's1', origin: 'hook', ts: 1, event: { kind: 'sessionStart' } }], {
        clientId: 'client-b',
        snapshot: { sessions: [] },
      }),
    );
    expect(res.status).toBe(200);
    expect(server.store.size).toBe(1);
  });

  it('health endpoint answers without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/health`);
    expect(res.status).toBe(200);
  });

  it('serves no hook endpoint and writes no server.json', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/hooks/claude`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(fs.existsSync(path.join(tmpBase, '.pixel-agents', 'server.json'))).toBe(false);
  });
});
