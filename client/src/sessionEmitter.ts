/**
 * SessionEmitter: observes agent sessions on this machine and emits them as
 * normalized events.
 *
 * Two sources feed it:
 *
 *   HOOKS (preferred)    the agent tool's hooks API delivers instant, reliable
 *                        events for session lifecycle and tool activity.
 *   TRANSCRIPTS          per-session polling of the transcript file. Always
 *                        active: it carries what hooks don't (status text of
 *                        sub-agents, token usage, model, team metadata), and it
 *                        is the only source when hooks are off.
 *
 * The emitter owns everything that needs this machine's filesystem or the
 * provider: which sessions exist, which transcript belongs to which session,
 * adoption and dismissal, /clear and /resume reassignment, teammate discovery
 * and team membership. It keeps no display state and renders nothing: the
 * server derives all of that from the events.
 */

import * as path from 'path';

import type { AgentEvent, AgentEventOf } from '../../core/src/ingest.js';
import type {
  IngestEventOrigin,
  IngestSnapshotSession,
  SessionTeam,
} from '../../core/src/ingestMessages.js';
import {
  ADOPTION_FRESHNESS_WINDOW_MS,
  CLEAR_MARKER_SCAN_BYTES,
  EXTERNAL_ACTIVE_THRESHOLD_MS,
  EXTERNAL_SCAN_INTERVAL_MS,
  EXTERNAL_STALE_CHECK_INTERVAL_MS,
  FILE_WATCHER_POLL_INTERVAL_MS,
  GLOBAL_SCAN_ACTIVE_MAX_AGE_MS,
  GLOBAL_SCAN_ACTIVE_MIN_SIZE,
  PROJECT_SCAN_INTERVAL_MS,
  SESSION_END_GRACE_MS,
  TRANSCRIPT_MAX_READ_BYTES,
} from './constants.js';
import type { DismissalTracker } from './dismissalTracker.js';
import type { Clock } from './ports/Clock.js';
import type { FileWatcher } from './ports/FileWatcher.js';
import type { TimerHandle, TimerService } from './ports/Timer.js';
import type { HookProvider } from './provider.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

export type EmitFn = (sessionId: string, origin: IngestEventOrigin, event: AgentEvent) => void;

/** A session this client is observing. */
export interface TrackedSession {
  /** Identifier on the wire. Unique within this client. */
  sessionId: string;
  /** The agent tool's own session id. Equals `sessionId` except for in-process
   *  teammates, which share their lead's tool session. */
  toolSessionId: string;
  /** Directory holding the session's transcript (or its cwd when hooks-only). */
  projectDir: string;
  /** Transcript file. Empty for sessions that have none (hooks-only). */
  transcriptPath: string;
  fileOffset: number;
  lineBuffer: string;
  folderName?: string;
  cwd?: string;
  /** True once a hook event has been received for this session. */
  hookDelivered: boolean;
  hooksOnly?: boolean;
  /** Set when SessionEnd(reason=clear|resume) fired; cleared when the follow-up
   *  SessionStart reassigns the session, or when the grace period ends it. */
  pendingClear?: boolean;
  /** True if the most recent hook tool call spawns a persistent teammate. Not
   *  cleared on tool end, so it survives the PostToolUse-before-SubagentStart race. */
  currentHookIsTeammateSpawn?: boolean;

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  /** Wire session id of the team lead, when this session is a teammate. */
  leadSessionId?: string;
  teamUsesTmux?: boolean;
}

/** What survives a client restart, so live sessions are picked up again. */
export interface PersistedSession {
  sessionId: string;
  toolSessionId: string;
  projectDir: string;
  transcriptPath: string;
  folderName?: string;
  cwd?: string;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadSessionId?: string;
  teamUsesTmux?: boolean;
}

interface PendingSession {
  sessionId: string;
  transcriptPath: string | undefined;
  cwd: string;
}

export interface SessionEmitterDeps {
  provider: HookProvider;
  fileWatcher: FileWatcher;
  timers: TimerService;
  clock: Clock;
  dismissal: DismissalTracker;
  emit: EmitFn;
  /** Mutable settings shared with the composition (toggled at runtime). */
  hooksEnabled: { current: boolean };
  watchAllSessions: { current: boolean };
  /** Called whenever the set of tracked sessions (or their identity) changes. */
  onSessionsChanged?: () => void;
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function teamOf(s: TrackedSession): SessionTeam {
  return {
    teamName: s.teamName,
    agentName: s.agentName,
    leadSessionId: s.leadSessionId,
    isTeamLead: s.isTeamLead,
    usesTmux: s.teamUsesTmux,
  };
}

function sameTeam(a: SessionTeam, b: SessionTeam): boolean {
  return (
    a.teamName === b.teamName &&
    a.agentName === b.agentName &&
    a.leadSessionId === b.leadSessionId &&
    a.isTeamLead === b.isTeamLead &&
    a.usesTmux === b.usesTmux
  );
}

export class SessionEmitter {
  private readonly sessions = new Map<string, TrackedSession>();
  /** Sessions announced by SessionStart that have shown no activity yet. They are
   *  only tracked once a confirming event arrives, which filters transient
   *  sessions that fire SessionStart + SessionEnd and nothing else. */
  private readonly pending = new Map<string, PendingSession>();
  private readonly pollTimers = new Map<string, TimerHandle>();
  private readonly graceTimers = new Map<string, TimerHandle>();

  private readonly knownTranscripts = new Set<string>();
  private readonly knownTeammateTranscripts = new Set<string>();
  private readonly trackedProjectDirs = new Set<string>();

  private projectScanTimer: TimerHandle | null = null;
  private externalScanTimer: TimerHandle | null = null;
  private staleCheckTimer: TimerHandle | null = null;

  private readonly provider: HookProvider;
  private readonly fileWatcher: FileWatcher;
  private readonly timers: TimerService;
  private readonly clock: Clock;
  private readonly dismissal: DismissalTracker;
  private readonly emit: EmitFn;
  private readonly hooksEnabled: { current: boolean };
  private readonly watchAllSessions: { current: boolean };
  private readonly onSessionsChanged?: () => void;

  constructor(deps: SessionEmitterDeps) {
    this.provider = deps.provider;
    this.fileWatcher = deps.fileWatcher;
    this.timers = deps.timers;
    this.clock = deps.clock;
    this.dismissal = deps.dismissal;
    this.emit = deps.emit;
    this.hooksEnabled = deps.hooksEnabled;
    this.watchAllSessions = deps.watchAllSessions;
    this.onSessionsChanged = deps.onSessionsChanged;
  }

  // ── Public surface ─────────────────────────────────────────

  /** Start observing sessions of the given workspace (and, when enabled, all). */
  start(workspacePath: string): void {
    const dirs = this.provider.getSessionDirs?.(workspacePath);
    if (!dirs || !dirs[0]) return;
    const projectDir = dirs[0];
    console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
    this.ensureProjectScan(projectDir);
    this.startExternalScanning();
    this.startStaleCheck();
  }

  /** The sessions currently live on this client, for a server snapshot. */
  snapshot(): IngestSnapshotSession[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      folderName: s.folderName,
      cwd: s.cwd,
      transcriptPath: s.transcriptPath || undefined,
      hooksOnly: s.hooksOnly,
      hookDelivered: s.hookDelivered,
      team: s.teamName || s.leadSessionId ? teamOf(s) : undefined,
    }));
  }

  /** The tracked sessions in a form that can be written to disk. */
  exportSessions(): PersistedSession[] {
    return [...this.sessions.values()]
      .filter((s) => s.transcriptPath)
      .map((s) => ({
        sessionId: s.sessionId,
        toolSessionId: s.toolSessionId,
        projectDir: s.projectDir,
        transcriptPath: s.transcriptPath,
        folderName: s.folderName,
        cwd: s.cwd,
        teamName: s.teamName,
        agentName: s.agentName,
        isTeamLead: s.isTeamLead,
        leadSessionId: s.leadSessionId,
        teamUsesTmux: s.teamUsesTmux,
      }));
  }

  /**
   * Resume observing sessions that were live before a restart. Only sessions
   * whose transcript still exists are restored, and they continue from the end
   * of the file. Nothing is emitted: the next snapshot carries them.
   */
  restoreSessions(persisted: PersistedSession[]): void {
    for (const p of persisted) {
      if (this.sessions.has(p.sessionId)) continue;
      const stat = this.fileWatcher.stat(p.transcriptPath);
      if (!stat) continue;
      const session: TrackedSession = {
        ...p,
        fileOffset: stat.size,
        lineBuffer: '',
        hookDelivered: false,
      };
      this.sessions.set(session.sessionId, session);
      this.knownTranscripts.add(p.transcriptPath);
      this.startPolling(session);
      console.log(
        `[Pixel Agents] Restored session ${p.sessionId} -> ${path.basename(p.transcriptPath)}`,
      );
    }
  }

  getSession(sessionId: string): TrackedSession | undefined {
    return this.sessions.get(sessionId);
  }

  get sessionCount(): number {
    return this.sessions.size;
  }

  /** Stop all scanning and polling. Emits nothing. */
  dispose(): void {
    for (const t of this.pollTimers.values()) this.timers.clearInterval(t);
    for (const t of this.graceTimers.values()) this.timers.clearTimeout(t);
    this.pollTimers.clear();
    this.graceTimers.clear();
    if (this.projectScanTimer) this.timers.clearInterval(this.projectScanTimer);
    if (this.externalScanTimer) this.timers.clearInterval(this.externalScanTimer);
    if (this.staleCheckTimer) this.timers.clearInterval(this.staleCheckTimer);
    this.projectScanTimer = null;
    this.externalScanTimer = null;
    this.staleCheckTimer = null;
  }

  // ── Hook events ────────────────────────────────────────────

  /** Process one raw hook payload from the agent tool. */
  handleHookEvent(raw: Record<string, unknown>): void {
    const normalized = this.provider.normalizeHookEvent(raw);
    if (!normalized) return; // unknown / uninteresting event -- silently drop
    const { sessionId, event } = normalized;

    if (event.kind === 'sessionStart') {
      this.handleSessionStart(sessionId, event);
      return;
    }

    // SessionEnd for a session that never showed activity: it was transient.
    if (event.kind === 'sessionEnd' && this.pending.has(sessionId)) {
      this.pending.delete(sessionId);
      return;
    }

    // Any other event confirms a pending session: start tracking it first.
    const pending = this.pending.get(sessionId);
    if (pending) {
      this.pending.delete(sessionId);
      this.adoptFromHook(pending);
    }

    const session = this.sessions.get(sessionId);
    if (!session) return; // a session we have no record of (e.g. another project)

    session.hookDelivered = true;

    switch (event.kind) {
      case 'sessionEnd':
        this.handleSessionEnd(session, event);
        return;
      case 'toolStart':
        // Authoritative teammate-vs-subagent discriminator for a later SubagentStart.
        session.currentHookIsTeammateSpawn = event.spawnsTeammate === true;
        this.emit(sessionId, 'hook', event);
        return;
      case 'subagentStart':
        this.emit(sessionId, 'hook', event);
        // A teammate spawn by a confirmed team lead: its transcript appears on
        // disk now, so look for it without waiting for the periodic scan.
        if (session.currentHookIsTeammateSpawn && session.teamName) {
          this.scanForTeammates(session);
        }
        return;
      default:
        this.emit(sessionId, 'hook', event);
    }
  }

  private handleSessionStart(sessionId: string, event: AgentEventOf<'sessionStart'>): void {
    const { source, transcriptPath, cwd } = event;

    // A session we already track: hooks are confirmed to be flowing for it.
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.hookDelivered = true;
      this.emit(sessionId, 'hook', { kind: 'sessionStart', source });
      return;
    }

    // /clear or /resume: SessionEnd came first and left a session waiting in the
    // same project dir. The new session takes its place.
    if (source === 'clear' || source === 'resume') {
      const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
      if (projectDir) {
        for (const session of this.sessions.values()) {
          if (session.pendingClear && samePath(session.projectDir, projectDir)) {
            this.replaceSession(session, sessionId, transcriptPath);
            return;
          }
        }
      }
    }

    // Unknown session: hold it until a confirming event arrives.
    if (transcriptPath || cwd) {
      if (source === 'resume' && transcriptPath) {
        // A resumed transcript may have been dismissed when its session ended.
        this.dismissal.clearDismissal(transcriptPath);
        this.dismissal.clearSeededMtime(transcriptPath);
        this.knownTranscripts.delete(transcriptPath);
      }
      this.pending.set(sessionId, { sessionId, transcriptPath, cwd: cwd ?? '' });
    }
  }

  private handleSessionEnd(session: TrackedSession, event: AgentEventOf<'sessionEnd'>): void {
    const reason = event.reason;
    // /clear and /resume send SessionEnd then SessionStart. Wait briefly for the
    // follow-up. All other reasons (exit, logout, ...) are final.
    const expectsFollowUp = reason === 'clear' || reason === 'resume';

    if (!expectsFollowUp) {
      this.endSession(session, 'hook', reason ?? 'unknown');
      return;
    }

    session.pendingClear = true;
    // The turn is over either way; show the agent as done while we wait.
    this.emit(session.sessionId, 'hook', { kind: 'turnEnd' });
    const sessionId = session.sessionId;
    const timer = this.timers.setTimeout(() => {
      this.graceTimers.delete(sessionId);
      // Safety net: SessionStart never arrived, so the session really ended.
      if (session.pendingClear) {
        session.pendingClear = false;
        this.endSession(session, 'hook', reason);
      }
    }, SESSION_END_GRACE_MS);
    this.graceTimers.set(sessionId, timer);
  }

  /** `session` continues as `newSessionId` (after /clear or /resume). */
  private replaceSession(
    session: TrackedSession,
    newSessionId: string,
    newTranscriptPath: string | undefined,
  ): void {
    const previousSessionId = session.sessionId;
    session.pendingClear = false;
    const grace = this.graceTimers.get(previousSessionId);
    if (grace) {
      this.timers.clearTimeout(grace);
      this.graceTimers.delete(previousSessionId);
    }
    console.log(
      `[Pixel Agents] Hook: session ${previousSessionId} continues as ${newSessionId} (/clear or /resume)`,
    );

    this.stopPolling(session);
    this.sessions.delete(previousSessionId);
    session.sessionId = newSessionId;
    session.toolSessionId = newSessionId;
    this.sessions.set(newSessionId, session);
    for (const other of this.sessions.values()) {
      if (other.leadSessionId === previousSessionId) other.leadSessionId = newSessionId;
    }

    if (newTranscriptPath) {
      this.knownTranscripts.add(newTranscriptPath);
      // Permanently dismiss the old file so scanners never re-adopt it.
      if (session.transcriptPath) this.dismissal.permanentlyDismiss(session.transcriptPath);
      session.transcriptPath = newTranscriptPath;
      session.projectDir = path.dirname(newTranscriptPath);
      session.fileOffset = 0;
      session.lineBuffer = '';
    }

    this.emit(newSessionId, 'hook', {
      kind: 'sessionReplaced',
      previousSessionId,
      transcriptPath: newTranscriptPath,
    });
    this.onSessionsChanged?.();

    if (newTranscriptPath) {
      this.startPolling(session);
      this.readNewLines(session);
    }
  }

  /** Track a session that hooks confirmed is real. */
  private adoptFromHook(pending: PendingSession): void {
    const { sessionId, transcriptPath, cwd } = pending;
    const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
    if (!this.isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) return;

    if (!transcriptPath) {
      // Hooks-only session: no transcript file, all state comes from hooks.
      const folderName = cwd ? path.basename(cwd) : undefined;
      const session: TrackedSession = {
        sessionId,
        toolSessionId: sessionId,
        projectDir: cwd,
        transcriptPath: '',
        fileOffset: 0,
        lineBuffer: '',
        folderName,
        cwd: cwd || undefined,
        hookDelivered: true,
        hooksOnly: true,
      };
      this.sessions.set(sessionId, session);
      if (debug) console.log(`[Pixel Agents] Hook: detected hooks-only session ${sessionId}`);
      this.emit(sessionId, 'hook', {
        kind: 'sessionStart',
        cwd: session.cwd,
        folderName,
        hooksOnly: true,
      });
      this.onSessionsChanged?.();
      return;
    }

    // Don't adopt a transcript that another session already owns.
    for (const s of this.sessions.values()) {
      if (s.transcriptPath === transcriptPath) return;
    }
    // Hooks confirmed this is a real session, so a file seeded at startup may be
    // adopted -- but not one that was dismissed.
    if (this.dismissal.isDismissed(transcriptPath)) return;
    if (this.dismissal.isPermanentlyDismissed(transcriptPath)) return;

    this.knownTranscripts.add(transcriptPath);
    const folderName = this.folderNameOf(projectDir);
    if (debug) {
      console.log(
        `[Pixel Agents] Hook: detected session ${path.basename(transcriptPath)} (${folderName})`,
      );
    }
    this.adoptTranscript(transcriptPath, projectDir, 'hook', { sessionId, folderName, cwd });
  }

  // ── Transcript adoption and polling ────────────────────────

  /**
   * Start tracking a session from its transcript file, announce it, and replay
   * or skip its existing content.
   */
  private adoptTranscript(
    transcriptPath: string,
    projectDir: string,
    origin: IngestEventOrigin,
    opts: { sessionId?: string; folderName?: string; cwd?: string } = {},
  ): TrackedSession {
    const ext = this.provider.sessionFileExtension ?? '';
    const sessionId = opts.sessionId ?? path.basename(transcriptPath, ext);

    // Decide whether to replay the existing content or skip to its end.
    //
    // A freshly-created session writes its first records in the gap between
    // scanner ticks. Unconditionally skipping to the end would silently discard
    // them: the character appears but its active tools never surface. So a file
    // born inside the freshness window is replayed from the start. Older files
    // are sessions that were already running; for those we skip to the end so an
    // hours-long session doesn't flash hundreds of past tools through the UI.
    //
    // birthtimeMs is reliable on APFS, NTFS and modern ext4. Where it isn't
    // tracked Node reports the epoch (0), which we treat as "very old".
    let fileOffset = 0;
    const stat = this.fileWatcher.stat(transcriptPath);
    if (stat) {
      const ageMs =
        stat.birthtimeMs > 0 ? this.clock.now() - stat.birthtimeMs : Number.POSITIVE_INFINITY;
      fileOffset = ageMs <= ADOPTION_FRESHNESS_WINDOW_MS ? 0 : stat.size;
    }

    const session: TrackedSession = {
      sessionId,
      toolSessionId: sessionId,
      projectDir,
      transcriptPath,
      fileOffset,
      lineBuffer: '',
      folderName: opts.folderName,
      cwd: opts.cwd || undefined,
      hookDelivered: origin === 'hook',
    };
    this.sessions.set(sessionId, session);
    this.emit(sessionId, origin, {
      kind: 'sessionStart',
      transcriptPath,
      cwd: session.cwd,
      folderName: session.folderName,
    });
    this.onSessionsChanged?.();

    this.startPolling(session);
    this.readNewLines(session);
    return session;
  }

  private startPolling(session: TrackedSession): void {
    this.stopPolling(session);
    const timer = this.timers.setInterval(() => {
      if (this.sessions.get(session.sessionId) !== session) {
        this.timers.clearInterval(timer);
        return;
      }
      this.readNewLines(session);
    }, FILE_WATCHER_POLL_INTERVAL_MS);
    this.pollTimers.set(session.sessionId, timer);
  }

  private stopPolling(session: TrackedSession): void {
    const timer = this.pollTimers.get(session.sessionId);
    if (timer) this.timers.clearInterval(timer);
    this.pollTimers.delete(session.sessionId);
  }

  /** Read the lines appended to a session's transcript since the last poll. */
  private readNewLines(session: TrackedSession): void {
    if (!session.transcriptPath) return;
    const parse = this.provider.parseTranscriptLine;
    if (!parse) return;

    const stat = this.fileWatcher.stat(session.transcriptPath);
    // A missing file is expected for a hook-detected session whose transcript
    // hasn't been created yet.
    if (!stat || stat.size <= session.fileOffset) return;

    // Cap a single read so a massive transcript dump can't block; the rest is
    // picked up on the next poll.
    const bytesToRead = Math.min(stat.size - session.fileOffset, TRANSCRIPT_MAX_READ_BYTES);
    const buf = this.fileWatcher.readFileChunk(
      session.transcriptPath,
      session.fileOffset,
      bytesToRead,
    );
    if (!buf) return;
    session.fileOffset += buf.length;

    // Carry an unterminated last line over to the next read.
    const text = session.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    session.lineBuffer = lines.pop() || '';

    const nonEmpty = lines.filter((l) => l.trim());
    if (nonEmpty.length === 0) return;

    // New data is arriving: tell the server once per batch, before the events,
    // so its heuristic timers see "the session is alive" first.
    this.emit(session.sessionId, 'transcript', { kind: 'progress' });

    for (const line of nonEmpty) {
      const parsed = parse(line);
      if (!parsed) continue; // malformed line
      if (parsed.team && parsed.team.teamName !== session.teamName) {
        this.applyTeamMetadata(session, parsed.team);
      }
      for (const event of parsed.events) {
        if (
          event.kind === 'toolStart' &&
          event.spawnsTeammate &&
          session.teamName &&
          !session.teamUsesTmux
        ) {
          this.markTeamUsesTmux(session);
        }
        this.emit(session.sessionId, 'transcript', event);
      }
    }
  }

  // ── Agent Teams ────────────────────────────────────────────

  private emitTeamInfo(session: TrackedSession): void {
    this.emit(session.sessionId, 'transcript', { kind: 'teamInfo', team: teamOf(session) });
  }

  /** A transcript record stated the session's team. Re-link the whole team. */
  private applyTeamMetadata(
    session: TrackedSession,
    team: { teamName: string; agentName?: string },
  ): void {
    session.teamName = team.teamName;
    session.agentName = team.agentName;
    session.isTeamLead = undefined;
    session.leadSessionId = undefined;
    if (debug) {
      console.log(
        `[Pixel Agents] Session ${session.sessionId} team metadata: team=${team.teamName}, role=${team.agentName ?? 'lead'}`,
      );
    }

    const members = [...this.sessions.values()].filter((s) => s.teamName === team.teamName);
    const before = new Map(members.map((s) => [s.sessionId, teamOf(s)]));

    // The lead is the member WITHOUT an agentName. Preferring it handles a
    // teammate being detected first and temporarily taken for the lead.
    const lead =
      members.find((s) => !s.agentName) ?? members.find((s) => s.isTeamLead) ?? members[0];
    for (const s of members) {
      if (s === lead) {
        s.isTeamLead = true;
        s.leadSessionId = undefined;
      } else {
        s.isTeamLead = false;
        s.leadSessionId = lead.sessionId;
      }
    }

    this.emitTeamInfo(session);
    for (const s of members) {
      if (s === session) continue;
      const prev = before.get(s.sessionId);
      if (!prev || !sameTeam(prev, teamOf(s))) this.emitTeamInfo(s);
    }
    this.onSessionsChanged?.();
  }

  /** The lead issued a teammate-spawn call in its transcript: its teammates run
   *  as separate sessions with their own hooks. */
  private markTeamUsesTmux(lead: TrackedSession): void {
    lead.teamUsesTmux = true;
    this.emitTeamInfo(lead);
    for (const s of this.sessions.values()) {
      if (s === lead || s.leadSessionId !== lead.sessionId) continue;
      s.teamUsesTmux = true;
      this.emitTeamInfo(s);
    }
    this.onSessionsChanged?.();
  }

  /**
   * Look for transcripts of in-process teammates of a lead session. Each
   * teammate becomes its own session, linked to the lead.
   *
   * Called immediately when a SubagentStart hook reports a teammate spawn, and
   * periodically as a fallback (hooks missed, or hooks off).
   */
  private scanForTeammates(lead: TrackedSession): void {
    const team = this.provider.team;
    if (!team) return;
    const found = team.discoverTeammates(lead.projectDir, lead.toolSessionId);

    for (const { jsonlPath: file, teammateName } of found) {
      if (this.knownTeammateTranscripts.has(file)) continue;
      if ([...this.sessions.values()].some((s) => s.transcriptPath === file)) continue;
      this.knownTeammateTranscripts.add(file);

      // The tool may restart a teammate, creating a new transcript for the same
      // role. Keep the same session and follow the new file.
      const existing = [...this.sessions.values()].find(
        (s) => s.leadSessionId === lead.sessionId && s.agentName === teammateName,
      );
      if (existing) {
        if (debug) {
          console.log(
            `[Pixel Agents] Teammate "${teammateName}" already tracked, following ${path.basename(file)}`,
          );
        }
        existing.transcriptPath = file;
        existing.fileOffset = 0;
        existing.lineBuffer = '';
        existing.teamUsesTmux = lead.teamUsesTmux;
        this.onSessionsChanged?.();
        this.startPolling(existing);
        this.readNewLines(existing);
        continue;
      }

      // In-process teammates share the lead's tool session, so they get a wire
      // id of their own. Read from the start: a teammate transcript is small and
      // its full tool history is wanted.
      const session: TrackedSession = {
        sessionId: `${lead.sessionId}:${teammateName}`,
        toolSessionId: lead.toolSessionId,
        projectDir: lead.projectDir,
        transcriptPath: file,
        fileOffset: 0,
        lineBuffer: '',
        // Teammates never count as hook-delivered: their tool activity comes
        // from their transcript, and permissions are routed from the lead's hooks.
        hookDelivered: false,
        teamName: lead.teamName,
        agentName: teammateName,
        isTeamLead: false,
        leadSessionId: lead.sessionId,
        teamUsesTmux: lead.teamUsesTmux,
      };
      this.sessions.set(session.sessionId, session);
      console.log(
        `[Pixel Agents] Teammate detected: "${teammateName}" for lead ${lead.sessionId} (${path.basename(file)})`,
      );
      this.emit(session.sessionId, 'transcript', {
        kind: 'sessionStart',
        transcriptPath: file,
        team: teamOf(session),
      });
      this.onSessionsChanged?.();
      this.startPolling(session);
      this.readNewLines(session);
    }
  }

  /** Periodic fallback: scan for teammates of every confirmed team lead. */
  private scanAllTeammates(): void {
    for (const session of [...this.sessions.values()]) {
      if (session.leadSessionId !== undefined) continue; // teammates have no teammates
      // Gate: only sessions whose transcript confirmed a team. Without it, basic
      // sub-agents' transcripts (written to the same directory) would become
      // spurious teammates.
      if (!session.teamName || !session.projectDir) continue;
      this.scanForTeammates(session);
    }
  }

  /**
   * End teammates that left their team. The team's member list is the
   * authoritative source: a teammate is gone when it is no longer listed, or
   * when the team itself can no longer be read (dissolved).
   */
  private removeDismissedTeammates(): void {
    const team = this.provider.team;
    if (!team) return;
    const membersByTeam = new Map<string, Set<string> | null>();
    for (const session of [...this.sessions.values()]) {
      if (session.leadSessionId === undefined || session.teamUsesTmux || !session.teamName) {
        continue;
      }
      if (!membersByTeam.has(session.teamName)) {
        membersByTeam.set(session.teamName, team.getTeamMembers(session.teamName));
      }
      const members = membersByTeam.get(session.teamName);
      if (members === null || (session.agentName && !members?.has(session.agentName))) {
        console.log(`[Pixel Agents] Removing teammate ${session.sessionId} (left the team)`);
        this.endSession(session, 'transcript', 'teammate-removed');
      }
    }
  }

  // ── Session end ────────────────────────────────────────────

  /** Stop tracking a session (and its teammates) and tell the server. */
  private endSession(session: TrackedSession, origin: IngestEventOrigin, reason: string): void {
    if (this.sessions.get(session.sessionId) !== session) return;

    // A lead takes its teammates with it. The server removes them when the lead
    // ends, so only local tracking needs cleaning up here.
    for (const other of [...this.sessions.values()]) {
      if (other.leadSessionId !== session.sessionId) continue;
      console.log(`[Pixel Agents] Removing teammate ${other.sessionId} (lead ended)`);
      this.forget(other);
    }

    this.forget(session);
    this.emit(session.sessionId, origin, { kind: 'sessionEnd', reason });
    this.onSessionsChanged?.();
  }

  /** Drop local tracking of a session and dismiss its transcript for a while,
   *  so a scanner doesn't immediately adopt it again. */
  private forget(session: TrackedSession): void {
    this.stopPolling(session);
    const grace = this.graceTimers.get(session.sessionId);
    if (grace) {
      this.timers.clearTimeout(grace);
      this.graceTimers.delete(session.sessionId);
    }
    if (session.transcriptPath) {
      this.dismissal.clearSeededMtime(session.transcriptPath);
      this.dismissal.dismiss(session.transcriptPath);
    }
    this.sessions.delete(session.sessionId);
  }

  // ── Scanning ───────────────────────────────────────────────

  /** Check if a project dir is covered by the workspace scanner. */
  isTrackedProjectDir(dir: string): boolean {
    if (!dir) return false;
    if (this.trackedProjectDirs.has(dir)) return true;
    // Case-insensitive fallback for Windows (drive letter casing: c:\ vs C:\).
    for (const tracked of this.trackedProjectDirs) {
      if (samePath(tracked, dir)) return true;
    }
    return false;
  }

  private folderNameOf(projectDir: string): string {
    const dirName = path.basename(projectDir);
    return this.provider.folderNameFromSessionDir?.(dirName) ?? dirName;
  }

  private listTranscripts(dir: string): string[] {
    return this.fileWatcher.listFiles(dir, this.provider.sessionFileExtension ?? '');
  }

  /**
   * Register a project directory for scanning. Transcripts that already exist
   * are seeded as known, so sessions that ended before we started aren't
   * adopted; their mtime is recorded so a later write can be noticed.
   */
  ensureProjectScan(projectDir: string): void {
    for (const file of this.listTranscripts(projectDir)) {
      this.knownTranscripts.add(file);
      const stat = this.fileWatcher.stat(file);
      if (stat) this.dismissal.seedMtime(file, stat.mtimeMs);
    }
    this.trackedProjectDirs.add(projectDir);

    if (this.projectScanTimer) return;
    this.projectScanTimer = this.timers.setInterval(() => {
      // Runs in both modes: with hooks, SubagentStart triggers an immediate
      // scan, but this catches teammates the hook missed.
      this.scanAllTeammates();
      this.removeDismissedTeammates();
    }, PROJECT_SCAN_INTERVAL_MS);
  }

  private startExternalScanning(): void {
    if (this.externalScanTimer) return;
    this.externalScanTimer = this.timers.setInterval(() => {
      // With hooks on, SessionStart detects workspace sessions. Global scanning
      // is still needed: hooks can't reveal sessions that were already running.
      if (!this.hooksEnabled.current) {
        for (const dir of this.trackedProjectDirs) this.scanProjectDir(dir);
      }
      if (this.watchAllSessions.current) this.scanAllProjectDirs();
    }, EXTERNAL_SCAN_INTERVAL_MS);
  }

  /** Scan one project dir for sessions that started without us noticing. */
  scanProjectDir(projectDir: string): void {
    const now = this.clock.now();
    for (const file of this.listTranscripts(projectDir)) {
      // A file that existed at startup: if it has been written since, stop
      // treating it as known so it can go through normal adoption next tick.
      // Adopting it right here would be too ambiguous (resume vs. ongoing).
      const seededMtime = this.dismissal.getSeededMtime(file);
      if (seededMtime !== undefined) {
        const stat = this.fileWatcher.stat(file);
        if (stat && stat.mtimeMs > seededMtime) {
          this.dismissal.clearSeededMtime(file);
          this.knownTranscripts.delete(file);
        }
        continue;
      }

      if (this.knownTranscripts.has(file)) continue;
      if (this.dismissal.isPermanentlyDismissed(file)) continue;
      if (this.dismissal.isDismissed(file)) continue;
      if ([...this.sessions.values()].some((s) => samePath(s.transcriptPath || '.', file))) {
        continue;
      }

      // Only adopt recently-active files.
      const stat = this.fileWatcher.stat(file);
      if (!stat || now - stat.mtimeMs > EXTERNAL_ACTIVE_THRESHOLD_MS) continue;

      // A transcript started by a clear gets one extra tick before adoption, so
      // a hook-driven reassignment of the cleared session can claim it first.
      const head = this.fileWatcher.readFileChunk(file, 0, CLEAR_MARKER_SCAN_BYTES);
      if (!head) continue;
      if (this.provider.isClearedSessionHead?.(head.toString('utf-8'))) {
        if (!this.dismissal.hasPendingClear(file)) {
          this.dismissal.registerPendingClear(file);
          continue;
        }
        this.dismissal.clearPendingClear(file);
      }

      this.knownTranscripts.add(file);
      console.log(`[Pixel Agents] Watcher: detected session ${path.basename(file)}`);
      this.adoptTranscript(file, projectDir, 'transcript');
    }
  }

  /** Scan every project of the provider for active sessions ("watch all sessions"). */
  private scanAllProjectDirs(): void {
    const roots = this.provider.getAllSessionRoots?.() ?? [];
    const now = this.clock.now();
    for (const root of roots) {
      for (const dirPath of this.fileWatcher.listDirectories(root)) {
        if (this.trackedProjectDirs.has(dirPath)) continue; // workspace scanning covers it
        for (const file of this.listTranscripts(dirPath)) {
          if (this.knownTranscripts.has(file)) continue;
          if ([...this.sessions.values()].some((s) => s.transcriptPath === file)) continue;
          // Activity filter: big enough to be a real session, and recently written.
          const stat = this.fileWatcher.stat(file);
          if (!stat || stat.size < GLOBAL_SCAN_ACTIVE_MIN_SIZE) continue;
          if (now - stat.mtimeMs > GLOBAL_SCAN_ACTIVE_MAX_AGE_MS) continue;

          const folderName = this.folderNameOf(dirPath);
          this.knownTranscripts.add(file);
          console.log(
            `[Pixel Agents] Watcher: detected global session ${path.basename(file)} (${folderName})`,
          );
          this.adoptTranscript(file, dirPath, 'transcript', { folderName });
        }
      }
    }
  }

  private startStaleCheck(): void {
    if (this.staleCheckTimer) return;
    this.staleCheckTimer = this.timers.setInterval(() => {
      // With hooks on, SessionEnd ends sessions.
      if (this.hooksEnabled.current) return;
      this.removeStaleSessions();
    }, EXTERNAL_STALE_CHECK_INTERVAL_MS);
  }

  /**
   * End sessions whose transcript was deleted. An inactive session whose
   * transcript still exists stays, so it can continue when it is resumed.
   */
  removeStaleSessions(): void {
    for (const session of [...this.sessions.values()]) {
      if (this.fileWatcher.exists(session.transcriptPath)) continue;
      // Allow the file to be adopted again if it reappears.
      this.knownTranscripts.delete(session.transcriptPath);
      console.log(`[Pixel Agents] Watcher: session ${session.sessionId} is stale, ending it`);
      this.endSession(session, 'transcript', 'stale');
    }
  }
}
