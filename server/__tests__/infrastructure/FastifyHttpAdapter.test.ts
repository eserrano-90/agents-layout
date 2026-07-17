import { describe, expect, it } from 'vitest';

import { FastifyHttpAdapter } from '../../src/infrastructure/http/FastifyHttpAdapter.js';

describe('FastifyHttpAdapter', () => {
  it('starts and returns port', async () => {
    const adapter = new FastifyHttpAdapter({
      embedded: true,
      token: 'test-token',
    });

    const handle = await adapter.start({ host: '127.0.0.1' });
    expect(handle.port).toBeGreaterThan(0);
    expect(adapter.port()).toBe(handle.port);

    await adapter.stop();
  });

  it('port returns 0 before start', () => {
    const adapter = new FastifyHttpAdapter({ embedded: true, token: 'test' });
    expect(adapter.port()).toBe(0);
  });

  it('stop is safe when not started', async () => {
    const adapter = new FastifyHttpAdapter({ embedded: true, token: 'test' });
    await expect(adapter.stop()).resolves.toBeUndefined();
  });
});
