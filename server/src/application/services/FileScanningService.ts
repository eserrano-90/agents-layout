import * as path from 'path';

import type { HookProvider } from '../../../../core/src/provider.js';
import type { TeamProvider } from '../../../../core/src/teamProvider.js';
import type { AgentState } from '../../types.js';
import type { AgentStore } from '../ports/AgentStore.js';
import type { Clock } from '../ports/Clock.js';
import type { FileWatcher } from '../ports/FileWatcher.js';
import type { ScannerDismissalTracker } from '../ports/ScannerInfrastructure.js';
import type { TimerHandle,TimerService } from '../ports/TimerService.js';
import type { TranscriptProcessingService } from './TranscriptProcessingService.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

/**
 * FileScanningService — pure orchestration (no module-level state).
 *
 * Coordinates FileWatcher, DismissalTracker, AgentStore, and TimerService
 * to detect external sessions, adopt JSONL files, scan teammate transcripts,
 * and clean up stale agents.
 */
export class FileScanningService {
  // Per-agent timer Maps (owned here)
  readonly pollingTimers = new Map<number, TimerHandle>();
  readonly jsonlPollTimers = new Map<number, TimerHandle>();
  readonly waitingTimers = new Map<number, TimerHandle>();
  readonly permissionTimers = new Map<number, TimerHandle>();

  // Scanning state
  readonly knownJsonlFiles = new Set<string>();
  readonly trackedProjectDirs = new Set<string>();
  readonly knownTeammateFiles = new Set<string>();

  private readonly fileWatcher: FileWatcher;
  private readonly timerService: TimerService;
  private readonly clock: Clock;
  private readonly dismissalTracker: ScannerDismissalTracker;
  private readonly agentStore: AgentStore;
  private readonly teamProvider?: TeamProvider;
  private readonly hookProvider?: HookProvider;
  private readonly transcriptProcessingService?: TranscriptProcessingService;
  private readonly onAgentCreated?: (agent: AgentState) => void;
  private readonly onAgentRemoved?: (agentId: number) => void;
  private readonly onTeammateRemoved?: (agentId: number) => void;

  constructor(deps: {
    fileWatcher: FileWatcher;
    timerService: TimerService;
    clock: Clock;
    dismissalTracker: ScannerDismissalTracker;
    agentStore: AgentStore;
    teamProvider?: TeamProvider;
    hookProvider?: HookProvider;
    transcriptProcessingService?: TranscriptProcessingService;
    onAgentCreated?: (agent: AgentState) => void;
    onAgentRemoved?: (agentId: number) => void;
    onTeammateRemoved?: (agentId: number) => void;
  }) {
    this.fileWatcher = deps.fileWatcher;
    this.timerService = deps.timerService;
    this.clock = deps.clock;
    this.dismissalTracker = deps.dismissalTracker;
    this.agentStore = deps.agentStore;
    this.teamProvider = deps.teamProvider;
    this.hookProvider = deps.hookProvider;
    this.transcriptProcessingService = deps.transcriptProcessingService;
    this.onAgentCreated = deps.onAgentCreated;
    this.onAgentRemoved = deps.onAgentRemoved;
    this.onTeammateRemoved = deps.onTeammateRemoved;
  }

  /** Check if a project dir is tracked by the workspace scanner. */
  isTrackedProjectDir(dir: string): boolean {
    if (this.trackedProjectDirs.has(dir)) return true;
    const resolved = path.resolve(dir).toLowerCase();
    for (const tracked of this.trackedProjectDirs) {
      if (path.resolve(tracked).toLowerCase() === resolved) return true;
    }
    return false;
  }

  /**
   * Seed a project directory's known files and register it for periodic scanning.
   * Can be called multiple times with different directories.
   */
  ensureProjectScan(
    projectDir: string,
    projectScanTimerRef: { current: TimerHandle | null },
    nextAgentIdRef: { current: number },
    persistAgents: () => void,
    _hooksEnabledRef?: { current: boolean },
  ): void {
    try {
      const files = this.fileWatcher.listFiles(projectDir, '.jsonl');
      for (const f of files) {
        this.knownJsonlFiles.add(f);
        try {
          const stat = this.fileWatcher.stat(f);
          if (stat) {
            this.dismissalTracker.seedMtime(f, stat.mtimeMs);
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* dir may not exist yet */
    }

    this.trackedProjectDirs.add(projectDir);

    if (projectScanTimerRef.current) return;
    projectScanTimerRef.current = this.timerService.setInterval(() => {
      this.scanAllTeammateFiles(nextAgentIdRef, persistAgents);

      const toRemove = this.scanTeamConfigsForRemovals();
      for (const id of toRemove) {
        this.onTeammateRemoved?.(id);
      }
    }, 1000);
  }

  /**
   * Scan for teammate JSONL files in a project directory.
   */
  scanForTeammateFiles(
    projectDir: string,
    sessionId: string,
    parentAgentId: number,
    nextAgentIdRef: { current: number },
    persistAgents: () => void,
  ): void {
    if (!this.teamProvider) return;
    const teammates = this.teamProvider.discoverTeammates(projectDir, sessionId);

    const parentAgent = this.getAgent(parentAgentId);

    for (const { jsonlPath: file, teammateName } of teammates) {
      if (this.knownTeammateFiles.has(file)) continue;

      let alreadyTracked = false;
      for (const a of this.agentStore.values()) {
        const agent = a as unknown as AgentState;
        if (agent.jsonlFile === file) {
          alreadyTracked = true;
          break;
        }
      }
      if (alreadyTracked) continue;

      this.knownTeammateFiles.add(file);

      let existingTeammate: AgentState | undefined;
      for (const a of this.agentStore.values()) {
        const agent = a as unknown as AgentState;
        if (agent.leadAgentId === parentAgentId && agent.agentName === teammateName) {
          existingTeammate = agent;
          break;
        }
      }
      if (existingTeammate) {
        if (debug) {
          console.log(
            `[Pixel Agents] Teammate "${teammateName}" already exists (Agent ${existingTeammate.id}), reassigning to ${path.basename(file)}`,
          );
        }
        const oldTimer = this.pollingTimers.get(existingTeammate.id);
        if (oldTimer) this.timerService.clearInterval(oldTimer);
        this.pollingTimers.delete(existingTeammate.id);
        existingTeammate.jsonlFile = file;
        existingTeammate.fileOffset = 0;
        existingTeammate.lineBuffer = '';
        existingTeammate.lastDataAt = this.clock.now();
        existingTeammate.linesProcessed = 0;
        existingTeammate.isWaiting = false;
        existingTeammate.teamUsesTmux = parentAgent?.teamUsesTmux;
        this.startFileWatching(existingTeammate.id);
        this.readNewLines(existingTeammate.id);
        continue;
      }

      const id = nextAgentIdRef.current++;
      const agent: AgentState = {
        id,
        sessionId,
        isExternal: true,
        projectDir,
        jsonlFile: file,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        backgroundAgentToolIds: new Set(),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        hookDelivered: false,
        lastDataAt: this.clock.now(),
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        inputTokens: 0,
        outputTokens: 0,
        agentName: teammateName,
        leadAgentId: parentAgentId,
        teamName: parentAgent?.teamName,
        teamUsesTmux: parentAgent?.teamUsesTmux,
      } as AgentState;

      this.agentStore.set(id, agent as unknown as Record<string, unknown>);
      persistAgents();

      console.log(
        `[Pixel Agents] Teammate detected: "${teammateName}" (Agent ${id}) for parent Agent ${parentAgentId} (${path.basename(file)})`,
      );

      this.onAgentCreated?.(agent);
      this.startFileWatching(id);
      this.readNewLines(id);
    }
  }

  /**
   * Scan team config files to detect dismissed teammates.
   */
  scanTeamConfigsForRemovals(): number[] {
    const toRemove: number[] = [];
    if (!this.teamProvider) return toRemove;

    const teammatesByTeam = new Map<string, Array<{ id: number; agent: AgentState }>>();
    for (const [id, a] of this.agentStore.entries()) {
      const agent = a as unknown as AgentState;
      if (agent.leadAgentId === undefined || agent.teamUsesTmux || !agent.teamName) continue;
      let list = teammatesByTeam.get(agent.teamName);
      if (!list) {
        list = [];
        teammatesByTeam.set(agent.teamName, list);
      }
      list.push({ id, agent });
    }

    for (const [teamName, members] of teammatesByTeam) {
      const memberNames = this.teamProvider.getTeamMembers(teamName);
      for (const { id, agent } of members) {
        if (memberNames === null) {
          toRemove.push(id);
        } else if (agent.agentName && !memberNames.has(agent.agentName)) {
          toRemove.push(id);
        }
      }
    }

    return toRemove;
  }

  /**
   * Scan all tracked project dirs for teammate JSONL files (periodic fallback).
   */
  scanAllTeammateFiles(
    nextAgentIdRef: { current: number },
    persistAgents: () => void,
  ): void {
    for (const [agentId, a] of this.agentStore.entries()) {
      const agent = a as unknown as AgentState;
      if (agent.leadAgentId !== undefined) continue;
      if (!agent.sessionId || !agent.projectDir) continue;
      if (!agent.teamName) continue;

      this.scanForTeammateFiles(
        agent.projectDir,
        agent.sessionId,
        agentId,
        nextAgentIdRef,
        persistAgents,
      );
    }
  }

  /**
   * Adopt an external session detected via hooks.
   */
  adoptExternalSessionFromHook(
    sessionId: string,
    transcriptPath: string | undefined,
    cwd: string,
    nextAgentIdRef: { current: number },
    persistAgents: () => void,
  ): void {
    if (transcriptPath) {
      for (const a of this.agentStore.values()) {
        const agent = a as unknown as AgentState;
        if (agent.jsonlFile === transcriptPath) return;
      }

      if (this.dismissalTracker.isDismissed(transcriptPath)) return;
      if (this.dismissalTracker.isPermanentlyDismissed(transcriptPath)) return;

      this.knownJsonlFiles.add(transcriptPath);
      const projectDir = path.dirname(transcriptPath);
      const folderName = this.folderNameFromProjectDir(path.basename(projectDir));

      this.adoptExternalSession(
        transcriptPath,
        projectDir,
        nextAgentIdRef,
        persistAgents,
        folderName,
      );

      const adoptedAgent = [...this.agentStore.values()].find(
        (a) => (a as unknown as AgentState).jsonlFile === transcriptPath,
      ) as unknown as AgentState | undefined;
      if (adoptedAgent && debug) {
        console.log(
          `[Pixel Agents] Hook: Agent ${adoptedAgent.id} - detected external session ${path.basename(transcriptPath)}${adoptedAgent.folderName ? ` (${adoptedAgent.folderName})` : ''}`,
        );
      }
      if (adoptedAgent) {
        adoptedAgent.sessionId = sessionId;
        adoptedAgent.hookDelivered = true;
        this.onAgentCreated?.(adoptedAgent);
      }
    } else {
      const id = nextAgentIdRef.current++;
      const folderName = cwd ? path.basename(cwd) : undefined;
      const agent: AgentState = {
        id,
        sessionId,
        isExternal: true,
        projectDir: cwd,
        jsonlFile: '',
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        backgroundAgentToolIds: new Set(),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        hookDelivered: true,
        hooksOnly: true,
        lastDataAt: this.clock.now(),
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName,
        inputTokens: 0,
        outputTokens: 0,
      } as AgentState;
      this.agentStore.set(id, agent as unknown as Record<string, unknown>);
      persistAgents();
      if (debug) {
        console.log(
          `[Pixel Agents] Hook: Agent ${id} - detected hooks-only external session${folderName ? ` (${folderName})` : ''}`,
        );
      }
      this.onAgentCreated?.(agent);
    }
  }

  /** Adopt a session from a JSONL file. */
  adoptExternalSession(
    jsonlFile: string,
    projectDir: string,
    nextAgentIdRef: { current: number },
    persistAgents: () => void,
    folderName?: string,
  ): void {
    const id = nextAgentIdRef.current++;
    let fileOffset = 0;
    try {
      const stat = this.fileWatcher.stat(jsonlFile);
      if (stat) {
        const ageMs = stat.birthtimeMs > 0 ? this.clock.now() - stat.birthtimeMs : Number.POSITIVE_INFINITY;
        const freshnessWindowMs = 6000;
        fileOffset = ageMs <= freshnessWindowMs ? 0 : stat.size;
      }
    } catch {
      /* start from beginning if stat fails */
    }

    const agent: AgentState = {
      id,
      sessionId: path.basename(jsonlFile, '.jsonl'),
      isExternal: true,
      projectDir,
      jsonlFile,
      fileOffset,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      hookDelivered: false,
      lastDataAt: this.clock.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName,
      inputTokens: 0,
      outputTokens: 0,
    } as AgentState;

    this.agentStore.set(id, agent as unknown as Record<string, unknown>);
    persistAgents();

    this.startFileWatching(id);
    this.readNewLines(id);
  }

  /**
   * Start periodic scanning for external sessions.
   */
  startExternalSessionScanning(
    hooksEnabledRef?: { current: boolean },
    watchAllSessionsRef?: { current: boolean },
  ): TimerHandle {
    return this.timerService.setInterval(() => {
      if (!hooksEnabledRef?.current) {
        for (const dir of this.trackedProjectDirs) {
          this.scanExternalDir(dir);
        }
      }
      if (watchAllSessionsRef?.current) {
        this.scanGlobalProjectDirs();
      }
    }, 3000);
  }

  /** Scan a single project dir for external sessions. */
  scanExternalDir(projectDir: string): void {
    const files = this.fileWatcher.listFiles(projectDir, '.jsonl');
    const now = this.clock.now();

    const hasOrphanedInternal = [...this.agentStore.values()].some((a) => {
      const agent = a as unknown as AgentState;
      if (agent.isExternal || agent.projectDir !== projectDir) return false;
      return !this.fileWatcher.exists(agent.jsonlFile);
    });
    if (hasOrphanedInternal) return;

    for (const file of files) {
      const seededMtime = this.dismissalTracker.getSeededMtime(file);
      if (seededMtime !== undefined) {
        try {
          const stat = this.fileWatcher.stat(file);
          if (stat && stat.mtimeMs > seededMtime) {
            this.dismissalTracker.clearSeededMtime(file);
            this.knownJsonlFiles.delete(file);
          }
        } catch {
          /* ignore */
        }
        continue;
      }

      if (this.knownJsonlFiles.has(file)) continue;
      if (this.dismissalTracker.isPermanentlyDismissed(file)) continue;
      if (this.dismissalTracker.isDismissed(file)) continue;

      const normalizedFile = path.resolve(file);
      let tracked = false;
      for (const a of this.agentStore.values()) {
        const agent = a as unknown as AgentState;
        if (path.resolve(agent.jsonlFile) === normalizedFile) {
          tracked = true;
          break;
        }
      }
      if (tracked) continue;

      try {
        const stat = this.fileWatcher.stat(file);
        if (!stat || now - stat.mtimeMs > 60000) continue;
      } catch {
        continue;
      }

      try {
        const buf = this.fileWatcher.readFileChunk(file, 0, 8192);
        if (buf && buf.toString('utf-8', 0, buf.length).includes('/clear</command-name>')) {
          if (!this.dismissalTracker.hasPendingClear(file)) {
            this.dismissalTracker.registerPendingClear(file);
            continue;
          }
          this.dismissalTracker.clearPendingClear(file);
        }
      } catch {
        continue;
      }

      this.knownJsonlFiles.add(file);
      console.log(`[Pixel Agents] Watcher: detected external session ${path.basename(file)}`);
      this.adoptExternalSession(
        file,
        projectDir,
        { current: this.agentStore.nextAgentId.current },
        () => this.agentStore.persist(),
      );
    }
  }

  /** Scan global project dirs via the active provider. */
  scanGlobalProjectDirs(): void {
    const roots = this.hookProvider?.getAllSessionRoots?.() ?? [];
    if (roots.length === 0) return;

    const projectDirs: string[] = [];
    for (const root of roots) {
      try {
        const entries = this.fileWatcher.listFiles(root, '');
        for (const entry of entries) {
          const stat = this.fileWatcher.stat(entry);
          if (stat) projectDirs.push(entry);
        }
      } catch {
        /* skip */
      }
    }

    const now = this.clock.now();
    for (const dirPath of projectDirs) {
      if (this.trackedProjectDirs.has(dirPath)) continue;

      const files = this.fileWatcher.listFiles(dirPath, '.jsonl');

      for (const file of files) {
        if (this.knownJsonlFiles.has(file)) continue;

        let tracked = false;
        for (const a of this.agentStore.values()) {
          const agent = a as unknown as AgentState;
          if (agent.jsonlFile === file) {
            tracked = true;
            break;
          }
        }
        if (tracked) continue;

        try {
          const stat = this.fileWatcher.stat(file);
          if (!stat || stat.size < 3072 || now - stat.mtimeMs > 600000) continue;
        } catch {
          continue;
        }

        const folderName = this.folderNameFromProjectDir(path.basename(dirPath));
        this.knownJsonlFiles.add(file);
        console.log(
          `[Pixel Agents] Watcher: detected global session ${path.basename(file)} (${folderName})`,
        );
        this.adoptExternalSession(
          file,
          dirPath,
          { current: this.agentStore.nextAgentId.current },
          () => this.agentStore.persist(),
          folderName,
        );
      }
    }
  }

  /**
   * Periodic stale external agent check.
   */
  startStaleExternalAgentCheck(
    hooksEnabledRef?: { current: boolean },
  ): TimerHandle {
    return this.timerService.setInterval(() => {
      if (hooksEnabledRef?.current) return;
      const toRemove: number[] = [];

      for (const [id, a] of this.agentStore.entries()) {
        const agent = a as unknown as AgentState;
        if (!agent.isExternal) continue;

        try {
          if (this.fileWatcher.exists(agent.jsonlFile)) continue;
        } catch {
          /* file gone */
        }
        toRemove.push(id);
      }

      for (const id of toRemove) {
        const agent = this.agentStore.get(id) as unknown as AgentState | undefined;
        if (agent) {
          this.knownJsonlFiles.delete(agent.jsonlFile);
        }
        console.log(`[Pixel Agents] Watcher: Agent ${id} - removing stale external agent`);
        this.onAgentRemoved?.(id);
      }
    }, 30000);
  }

  /**
   * Reassign an agent to a new JSONL file (/clear detection).
   */
  reassignAgentToFile(
    agentId: number,
    newFilePath: string,
    persistAgents: () => void,
  ): void {
    const agent = this.getAgent(agentId);
    if (!agent) return;

    const pt = this.pollingTimers.get(agentId);
    if (pt) {
      this.timerService.clearInterval(pt);
    }
    this.pollingTimers.delete(agentId);

    this.dismissalTracker.permanentlyDismiss(agent.jsonlFile);

    agent.sessionId = path.basename(newFilePath, '.jsonl');
    agent.jsonlFile = newFilePath;
    agent.fileOffset = 0;
    agent.lineBuffer = '';
    persistAgents();

    this.startFileWatching(agentId);
    this.readNewLines(agentId);
  }

  /** Cancel the waiting timer for an agent. */
  cancelWaitingTimer(agentId: number): void {
    const t = this.waitingTimers.get(agentId);
    if (t) {
      this.timerService.clearTimeout(t);
      this.waitingTimers.delete(agentId);
    }
  }

  /** Cancel the permission timer for an agent. */
  cancelPermissionTimer(agentId: number): void {
    const t = this.permissionTimers.get(agentId);
    if (t) {
      this.timerService.clearTimeout(t);
      this.permissionTimers.delete(agentId);
    }
  }

  /** Clear activity for an agent (cancels waiting + permission timers). */
  clearAgentActivity(agentId: number): void {
    this.cancelWaitingTimer(agentId);
    this.cancelPermissionTimer(agentId);
  }

  // ── Public helpers (used by composition root) ──

  /** Start watching a JSONL file for new lines. */
  startFileWatching(agentId: number): void {
    const agent = this.getAgent(agentId);
    if (!agent) return;

    const handle = this.timerService.setInterval(() => {
      if (!this.agentStore.has(agentId)) {
        this.timerService.clearInterval(handle);
        return;
      }
      this.readNewLines(agentId);
    }, 500);

    this.pollingTimers.set(agentId, handle);
  }

  /** Read and process new lines from an agent's JSONL file. */
  readNewLines(agentId: number): void {
    const agent = this.getAgent(agentId);
    if (!agent) return;

    try {
      const stat = this.fileWatcher.stat(agent.jsonlFile);
      if (!stat || stat.size <= agent.fileOffset) return;

      const MAX_READ_BYTES = 65536;
      const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
      const buf = this.fileWatcher.readFileChunk(agent.jsonlFile, agent.fileOffset, bytesToRead);
      if (!buf) return;

      agent.fileOffset += buf.length;
      const text = agent.lineBuffer + buf.toString('utf-8');
      const lines = text.split('\n');
      agent.lineBuffer = lines.pop() || '';

      const hasLines = lines.some((l) => l.trim());
      if (hasLines) {
        if (!agent.hookDelivered && !agent.leadAgentId) {
          agent.permissionSent = false;
        }
      }

      for (const line of lines) {
        if (!line.trim()) continue;
        this.transcriptProcessingService?.processLine(agentId, line);
      }
    } catch {
      /* ENOENT expected for hook-detected agents */
    }
  }

  // ── Internal helpers ──

  private getAgent(id: number): AgentState | undefined {
    const a = this.agentStore.get(id);
    return a as unknown as AgentState | undefined;
  }

  private folderNameFromProjectDir(dirName: string): string {
    const parts = dirName.replace(/^-+/, '').split('-');
    return parts[parts.length - 1] || dirName;
  }
}
