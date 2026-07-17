import { describe, expect,it } from 'vitest';

import { SessionManagementService } from '../../src/application/services/SessionManagementService.js';

describe('SessionManagementService', () => {
  it('register and resolve', () => {
    const svc = new SessionManagementService();
    svc.register('sess-1', 1);
    expect(svc.resolve('sess-1')).toBe(1);
    expect(svc.hasSession('sess-1')).toBe(true);
  });

  it('unregister removes mapping', () => {
    const svc = new SessionManagementService();
    svc.register('sess-1', 1);
    svc.unregister('sess-1');
    expect(svc.resolve('sess-1')).toBeUndefined();
  });

  it('storePending and confirmPending', () => {
    const svc = new SessionManagementService();
    svc.storePending('sess-1', { sessionId: 'sess-1', transcriptPath: '/tmp/test.jsonl', cwd: '/tmp' });
    expect(svc.hasPending('sess-1')).toBe(true);
    const info = svc.confirmPending('sess-1');
    expect(info?.transcriptPath).toBe('/tmp/test.jsonl');
    expect(svc.hasPending('sess-1')).toBe(false);
  });

  it('discardPending removes without returning', () => {
    const svc = new SessionManagementService();
    svc.storePending('sess-1', { sessionId: 'sess-1', transcriptPath: undefined, cwd: '/tmp' });
    svc.discardPending('sess-1');
    expect(svc.hasPending('sess-1')).toBe(false);
  });

  it('bufferEvent and hasBuffered', () => {
    const svc = new SessionManagementService();
    svc.bufferEvent('claude', { session_id: 'sess-1' });
    expect(svc.hasBuffered('sess-1')).toBe(true);
    svc.dispose();
  });

  it('register returns buffered events', () => {
    const svc = new SessionManagementService();
    svc.bufferEvent('claude', { session_id: 'sess-1' });
    const flushed = svc.register('sess-1', 1);
    expect(flushed.length).toBe(1);
    expect(flushed[0].event.session_id).toBe('sess-1');
    svc.dispose();
  });

  it('dispose clears all state', () => {
    const svc = new SessionManagementService();
    svc.register('sess-1', 1);
    svc.storePending('sess-2', { sessionId: 'sess-2', transcriptPath: undefined, cwd: '/tmp' });
    svc.bufferEvent('claude', { session_id: 'sess-3' });
    svc.dispose();
    expect(svc.resolve('sess-1')).toBeUndefined();
    expect(svc.hasPending('sess-2')).toBe(false);
    expect(svc.hasBuffered('sess-3')).toBe(false);
  });
});
