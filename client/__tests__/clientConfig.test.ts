import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpHome: string;
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

const { loadClientConfig, resolveTarget } = await import('../src/clientConfig.js');

describe('client configuration', () => {
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-client-cfg-'));
  });
  afterEach(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it('creates a stable client id that survives a restart', () => {
    const first = loadClientConfig().clientId;
    expect(first).toMatch(/[0-9a-f-]{36}/);
    expect(loadClientConfig().clientId).toBe(first);
    const file = path.join(tmpHome, '.pixel-agents', 'client.json');
    expect((fs.statSync(file).mode & 0o777).toString(8)).toBe('600');
  });

  const base = { clientId: 'c', hooksEnabled: true, watchAllSessions: false };

  it('reads the address from the environment', () => {
    expect(
      resolveTarget({}, { PIXEL_AGENTS_URL: 'http://s:3100', PIXEL_AGENTS_TOKEN: 't' }, base),
    ).toMatchObject({
      serverUrl: 'http://s:3100',
      token: 't',
    });
  });

  it('command-line options override environment, which overrides the file', () => {
    const cfg = { ...base, serverUrl: 'http://file', token: 'ft', label: 'file-label' };
    expect(
      resolveTarget({ serverUrl: 'http://cli' }, { PIXEL_AGENTS_URL: 'http://env' }, cfg),
    ).toMatchObject({
      serverUrl: 'http://cli',
      token: 'ft',
      label: 'file-label',
    });
    expect(resolveTarget({}, { PIXEL_AGENTS_URL: 'http://env' }, cfg)).toMatchObject({
      serverUrl: 'http://env',
    });
  });

  it('names the missing setting when no address is configured', () => {
    expect(resolveTarget({}, {}, base)).toEqual({ missing: '--server (or PIXEL_AGENTS_URL)' });
  });

  it('defaults the label to user@host', () => {
    const r = resolveTarget({ serverUrl: 'http://s', token: 't' }, {}, base);
    expect('label' in r && r.label).toContain(`@${os.hostname()}`);
  });
});
