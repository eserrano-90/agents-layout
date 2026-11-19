import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const { HookEndpoint } = await import('../src/hookEndpoint.js');

describe('HookEndpoint', () => {
  let endpoint: InstanceType<typeof HookEndpoint>;
  let received: Array<Record<string, unknown>>;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-hook-endpoint-'));
    received = [];
    endpoint = new HookEndpoint((_p, payload) => received.push(payload));
  });

  afterEach(async () => {
    await endpoint.stop();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const post = (port: number, token: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}/api/hooks/claude`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('writes server.json for the hook script and removes it on stop', async () => {
    const cfg = await endpoint.start();
    const file = path.join(tmpHome, '.pixel-agents', 'server.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toMatchObject({
      port: cfg.port,
      token: cfg.token,
      pid: process.pid,
    });
    await endpoint.stop();
    expect(fs.existsSync(file)).toBe(false);
  });

  it('accepts authenticated hook payloads', async () => {
    const cfg = await endpoint.start();
    const res = await post(cfg.port, cfg.token, { hook_event_name: 'Stop', session_id: 's1' });
    expect(res.status).toBe(200);
    expect(received).toEqual([{ hook_event_name: 'Stop', session_id: 's1' }]);
  });

  it('rejects a wrong token', async () => {
    const cfg = await endpoint.start();
    expect(
      (await post(cfg.port, 'nope', { hook_event_name: 'Stop', session_id: 's1' })).status,
    ).toBe(401);
    expect(received).toEqual([]);
  });

  it('listens on loopback only', async () => {
    await endpoint.start();
    const address = (
      endpoint as unknown as { server: { address(): { address: string } } }
    ).server.address();
    expect(address.address).toBe('127.0.0.1');
  });
});
