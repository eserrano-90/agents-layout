import { describe, expect, it } from 'vitest';

import { AgentEventReducer } from '../../src/agentEventReducer.js';
import { AgentStateStore } from '../../src/agentStateStore.js';
import { ClientTokenStore } from '../../src/clientTokens.js';
import { FastifyHttpAdapter } from '../../src/infrastructure/http/FastifyHttpAdapter.js';
import { IngestService } from '../../src/ingestService.js';

function ingest(): IngestService {
  const store = new AgentStateStore();
  return new IngestService({
    reducer: new AgentEventReducer({ store }),
    tokens: new ClientTokenStore('/nonexistent/client-tokens.json'),
  });
}

describe('FastifyHttpAdapter', () => {
  it('starts and returns port', async () => {
    const adapter = new FastifyHttpAdapter({ embedded: true, ingest: ingest() });

    const handle = await adapter.start({ host: '127.0.0.1' });
    expect(handle.port).toBeGreaterThan(0);
    expect(adapter.port()).toBe(handle.port);

    await adapter.stop();
  });

  it('port returns 0 before start', () => {
    const adapter = new FastifyHttpAdapter({ embedded: true, ingest: ingest() });
    expect(adapter.port()).toBe(0);
  });

  it('stop is safe when not started', async () => {
    const adapter = new FastifyHttpAdapter({ embedded: true, ingest: ingest() });
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
});
