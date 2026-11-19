import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentEvent } from '../../core/src/ingest.js';
import { NodeTimerAdapter } from '../src/adapters/NodeTimerAdapter.js';
import { FILE_WATCHER_POLL_INTERVAL_MS, SESSION_END_GRACE_MS } from '../src/constants.js';
import { DismissalTrackerService } from '../src/dismissalTracker.js';
import type { FileStats, FileWatcher } from '../src/ports/FileWatcher.js';
import type { HookProvider } from '../src/provider.js';
import { claudeProvider } from '../src/providers/claude/claude.js';
import { SessionEmitter } from '../src/sessionEmitter.js';

const PROJECT = '/home/u/.claude/projects/-work-app';

/** In-memory filesystem for transcripts. */
class MemFs implements FileWatcher {
  files = new Map<string, { data: string; birth: number; mtime: number }>();
  write(p: string, data: string, now = Date.now()): void {
    const f = this.files.get(p);
    if (f) {
      f.data += data;
      f.mtime = now;
    } else this.files.set(p, { data, birth: now, mtime: now });
  }
  watch(): never {
    throw new Error('unused');
  }
  unwatch(): void {}
  listFiles(dir: string, ext: string): string[] {
    return [...this.files.keys()].filter((p) => path.dirname(p) === dir && p.endsWith(ext));
  }
  listDirectories(): string[] {
    return [];
  }
  readFileChunk(p: string, offset: number, length: number): Buffer | null {
    const f = this.files.get(p);
    return f ? Buffer.from(f.data).subarray(offset, offset + length) : null;
  }
  stat(p: string): FileStats | null {
    const f = this.files.get(p);
    return f ? { size: Buffer.byteLength(f.data), mtimeMs: f.mtime, birthtimeMs: f.birth } : null;
  }
  exists(p: string): boolean {
    return this.files.has(p);
  }
}

const rec = (o: unknown) => JSON.stringify(o) + '\n';
const toolUse = (id: string, name = 'Bash') =>
  rec({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: {} }] } });

describe('SessionEmitter', () => {
  let fs: MemFs;
  let timers: NodeTimerAdapter;
  let emitted: Array<{ sessionId: string; origin: string; event: AgentEvent }>;
  let emitter: SessionEmitter;
  let teamMembers: Set<string> | null;
  const hooksEnabled = { current: true };
  const watchAll = { current: false };

  const kinds = (sessionId?: string) =>
    emitted.filter((e) => !sessionId || e.sessionId === sessionId).map((e) => e.event.kind);

  beforeEach(() => {
    vi.useFakeTimers();
    fs = new MemFs();
    timers = new NodeTimerAdapter();
    emitted = [];
    teamMembers = new Set(['web']);
    hooksEnabled.current = true;
    watchAll.current = false;
    const provider: HookProvider = {
      ...claudeProvider,
      getSessionDirs: () => [PROJECT],
      team: {
        providerId: 'claude',
        discoverTeammates: (dir, lead) => {
          const file = path.join(dir, lead, 'subagents', 'web.jsonl');
          return fs.exists(file) ? [{ jsonlPath: file, teammateName: 'web' }] : [];
        },
        getTeamMembers: () => teamMembers,
      },
    };
    emitter = new SessionEmitter({
      provider,
      fileWatcher: fs,
      timers,
      clock: { now: () => Date.now() },
      dismissal: new DismissalTrackerService(),
      emit: (sessionId, origin, event) => emitted.push({ sessionId, origin, event }),
      hooksEnabled,
      watchAllSessions: watchAll,
    });
    emitter.start('/work/app');
  });

  afterEach(() => {
    emitter.dispose();
    timers.clearAll();
    vi.useRealTimers();
  });

  function startHookSession(id: string): string {
    const transcript = path.join(PROJECT, `${id}.jsonl`);
    fs.write(transcript, '');
    emitter.handleHookEvent({
      hook_event_name: 'SessionStart',
      session_id: id,
      transcript_path: transcript,
      cwd: '/work/app',
      source: 'startup',
    });
    emitter.handleHookEvent({
      hook_event_name: 'PreToolUse',
      session_id: id,
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    return transcript;
  }

  it('holds a SessionStart until a confirming event, then announces the session first', () => {
    const transcript = path.join(PROJECT, 's1.jsonl');
    emitter.handleHookEvent({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      transcript_path: transcript,
      source: 'startup',
    });
    expect(emitted).toEqual([]);
    emitter.handleHookEvent({ hook_event_name: 'Stop', session_id: 's1' });
    expect(kinds()).toEqual(['sessionStart', 'turnEnd']);
  });

  it('drops a transient session that ends without activity', () => {
    emitter.handleHookEvent({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      transcript_path: path.join(PROJECT, 's1.jsonl'),
    });
    emitter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'exit' });
    expect(emitted).toEqual([]);
  });

  it('ignores sessions of other projects unless watching all sessions', () => {
    emitter.handleHookEvent({
      hook_event_name: 'SessionStart',
      session_id: 'x',
      transcript_path: '/elsewhere/x.jsonl',
    });
    emitter.handleHookEvent({ hook_event_name: 'Stop', session_id: 'x' });
    expect(emitted).toEqual([]);
  });

  it('emits a partial transcript line only once it is complete', () => {
    const transcript = startHookSession('s1');
    emitted.length = 0;
    const full = toolUse('tu1');
    fs.write(transcript, full.slice(0, 20));
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    expect(kinds()).toEqual([]);
    fs.write(transcript, full.slice(20));
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS * 2);
    expect(kinds()).toEqual(['progress', 'toolStart']);
  });

  it('reports /clear as one sessionReplaced on the same character', () => {
    startHookSession('s1');
    emitted.length = 0;
    emitter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' });
    const next = path.join(PROJECT, 's2.jsonl');
    fs.write(next, '');
    emitter.handleHookEvent({
      hook_event_name: 'SessionStart',
      session_id: 's2',
      transcript_path: next,
      source: 'clear',
    });
    vi.advanceTimersByTime(SESSION_END_GRACE_MS * 2);
    expect(kinds()).toEqual(['turnEnd', 'sessionReplaced']);
    expect(emitted[1]).toMatchObject({ sessionId: 's2', event: { previousSessionId: 's1' } });
  });

  it('ends a cleared session whose follow-up never arrives', () => {
    startHookSession('s1');
    emitted.length = 0;
    emitter.handleHookEvent({ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' });
    vi.advanceTimersByTime(SESSION_END_GRACE_MS);
    expect(kinds()).toEqual(['turnEnd', 'sessionEnd']);
  });

  it('discovers sessions from transcripts when hooks are off', () => {
    hooksEnabled.current = false;
    fs.write(path.join(PROJECT, 'h1.jsonl'), toolUse('tu1'));
    vi.advanceTimersByTime(3000);
    expect(kinds('h1')).toEqual(['sessionStart', 'progress', 'toolStart']);
    expect(emitted.every((e) => e.origin === 'transcript')).toBe(true);
  });

  it('ends a session whose transcript was deleted', () => {
    const transcript = startHookSession('s1');
    emitted.length = 0;
    fs.files.delete(transcript);
    emitter.removeStaleSessions();
    expect(kinds()).toEqual(['sessionEnd']);
  });

  it('discovers an inline teammate and ends it when it leaves the team', () => {
    const transcript = startHookSession('lead');
    fs.write(transcript, rec({ type: 'system', teamName: 'research' }));
    vi.advanceTimersByTime(FILE_WATCHER_POLL_INTERVAL_MS);
    fs.write(
      path.join(PROJECT, 'lead', 'subagents', 'web.jsonl'),
      rec({ type: 'system', teamName: 'research', agentName: 'web' }),
    );
    vi.advanceTimersByTime(1000);
    const start = emitted.find(
      (e) => e.sessionId === 'lead:web' && e.event.kind === 'sessionStart',
    );
    expect(start?.event).toMatchObject({
      team: { teamName: 'research', agentName: 'web', leadSessionId: 'lead' },
    });

    teamMembers = new Set();
    vi.advanceTimersByTime(1000);
    expect(kinds('lead:web')).toContain('sessionEnd');
  });

  it('snapshot lists the live sessions with their team', () => {
    startHookSession('s1');
    expect(emitter.snapshot()).toEqual([
      expect.objectContaining({ sessionId: 's1', hookDelivered: true }),
    ]);
  });
});
