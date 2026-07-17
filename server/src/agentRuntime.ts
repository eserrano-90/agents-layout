import * as fs from 'fs';
import * as path from 'path';

import type { HookProvider } from '../../core/src/provider.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { Clock } from './application/ports/Clock.js';
import type { TimerService } from './application/ports/TimerService.js';
import type { BroadcastService } from './application/services/BroadcastService.js';
import type { DismissalTracker } from './application/services/DismissalTrackerService.js';
import type { FileScanningService } from './application/services/FileScanningService.js';
import type { HookRoutingService } from './application/services/HookRoutingService.js';
import type { SessionManagementService } from './application/services/SessionManagementService.js';
import type { TranscriptProcessingService } from './application/services/TranscriptProcessingService.js';
import type { DailyUsageTracker } from './dailyUsageTracker.js';
import type { AgentState } from './types.js';

export interface RuntimeLifecycleCallbacks {
  onAgentRemoved?: (agentId: number, agent: AgentState) => void;
  onTeammateRemoved?: (teammateId: number, agent: AgentState, source: string) => void;
}

export class AgentRuntime {
  readonly fileScanningService: FileScanningService;
  readonly hookRoutingService: HookRoutingService;
  readonly transcriptProcessingService: TranscriptProcessingService;
  readonly broadcastService: BroadcastService;
  readonly sessionService: SessionManagementService;
  readonly timerService: TimerService;
  readonly clock: Clock;
  readonly watchAllSessions = { current: false };
  readonly hooksEnabled = { current: true };
  readonly dailyUsage: DailyUsageTracker;
  private readonly provider: HookProvider;
  private readonly dismissalTracker: DismissalTracker;
  private readonly store: AgentStateStore;
  private lifecycleCallbacks: RuntimeLifecycleCallbacks = {};

  constructor(
    store: AgentStateStore,
    provider: HookProvider,
    deps: {
      timerService: TimerService;
      clock: Clock;
      fileScanningService: FileScanningService;
      hookRoutingService: HookRoutingService;
      transcriptProcessingService: TranscriptProcessingService;
      broadcastService: BroadcastService;
      sessionService: SessionManagementService;
      dismissalTracker: DismissalTracker;
      dailyUsage: DailyUsageTracker;
    },
  ) {
    this.store = store;
    this.provider = provider;
    this.timerService = deps.timerService;
    this.clock = deps.clock;
    this.fileScanningService = deps.fileScanningService;
    this.hookRoutingService = deps.hookRoutingService;
    this.transcriptProcessingService = deps.transcriptProcessingService;
    this.broadcastService = deps.broadcastService;
    this.sessionService = deps.sessionService;
    this.dismissalTracker = deps.dismissalTracker;
    this.dailyUsage = deps.dailyUsage;

    this.hookRoutingService.setCallbacks({
      onExternalSessionDetected: (sessionId: string, transcriptPath: string | undefined, cwd: string) => {
        const projectDir = transcriptPath ? path.dirname(transcriptPath) : cwd;
        if (!this.fileScanningService.isTrackedProjectDir(projectDir) && !this.watchAllSessions.current) {
          return;
        }
        this.fileScanningService.adoptExternalSessionFromHook(
          sessionId,
          transcriptPath,
          cwd,
          this.store.nextAgentId,
          () => this.store.persist(),
        );
        const adoptedAgent = [...this.store.values()].find(
          (a) => (a as unknown as AgentState).sessionId === sessionId,
        ) as unknown as AgentState | undefined;
        if (adoptedAgent) {
          this.hookRoutingService.registerAgent(adoptedAgent.sessionId, adoptedAgent.id);
        }
      },
      onSessionClear: (agentId: number, newSessionId: string, newTranscriptPath: string | undefined) => {
        if (newTranscriptPath) {
          this.fileScanningService.reassignAgentToFile(
            agentId,
            newTranscriptPath,
            () => this.store.persist(),
          );
        }
        const agent = this.store.get(agentId);
        if (agent) {
          this.hookRoutingService.unregisterAgent(agent.sessionId);
          agent.sessionId = newSessionId;
          this.hookRoutingService.registerAgent(agent.sessionId, agent.id);
        }
      },
      onSessionResume: (transcriptPath: string) => {
        this.dismissalTracker.clearDismissal(transcriptPath);
        this.dismissalTracker.clearSeededMtime(transcriptPath);
        this.fileScanningService.knownJsonlFiles.delete(transcriptPath);
      },
      onTeammateDetected: (parentAgentId: number, sessionId: string, _agentType: string) => {
        const parentAgent = this.store.get(parentAgentId);
        if (!parentAgent) return;
        this.fileScanningService.scanForTeammateFiles(
          parentAgent.projectDir,
          sessionId,
          parentAgentId,
          this.store.nextAgentId,
          () => this.store.persist(),
        );
      },
      onTeammateRemoved: (teammateAgentId: number) => {
        this.removeTeammate(teammateAgentId, 'hooks');
      },
      onSessionEnd: (agentId: number) => {
        const agent = this.store.get(agentId);
        if (!agent) return;
        this.dismissalTracker.clearSeededMtime(agent.jsonlFile);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        if (agent.isTeamLead) {
          this.removeTeammates(agentId);
        }
        if (agent.isExternal) {
          this.hookRoutingService.unregisterAgent(agent.sessionId);
          this.removeAgent(agentId);
        }
      },
    });
  }

  setLifecycleCallbacks(callbacks: RuntimeLifecycleCallbacks): void {
    this.lifecycleCallbacks = callbacks;
  }

  handleHookEvent(_providerId: string, event: Record<string, unknown>): void {
    const normalized = this.provider.normalizeHookEvent(event);
    if (!normalized) return;
    this.hookRoutingService.route(normalized.sessionId, normalized.event);
  }

  registerAgent(sessionId: string, agentId: number): void {
    this.hookRoutingService.registerAgent(sessionId, agentId);
  }

  unregisterAgent(sessionId: string): void {
    this.hookRoutingService.unregisterAgent(sessionId);
  }

  removeAgent(id: number): void {
    const agent = this.store.get(id);
    if (!agent) return;

    this.fileScanningService.cancelWaitingTimer(id);
    this.fileScanningService.cancelPermissionTimer(id);

    this.lifecycleCallbacks.onAgentRemoved?.(id, agent);

    this.store.delete(id);
    this.store.persist();
  }

  removeTeammate(teammateId: number, source: string): void {
    const agent = this.store.get(teammateId);
    if (!agent) return;
    console.log(`[Pixel Agents] Removing teammate ${teammateId} (source: ${source})`);
    this.dismissalTracker.dismiss(agent.jsonlFile);
    this.unregisterAgent(agent.sessionId);
    this.lifecycleCallbacks.onTeammateRemoved?.(teammateId, agent, source);
    this.removeAgent(teammateId);
  }

  removeTeammates(leadId: number): void {
    const teammates: number[] = [];
    for (const [id, agent] of this.store) {
      if (agent.leadAgentId === leadId) {
        teammates.push(id);
      }
    }
    for (const id of teammates) {
      const agent = this.store.get(id);
      if (agent) {
        console.log(`[Pixel Agents] Removing teammate ${id} (lead ${leadId} closed)`);
        this.dismissalTracker.dismiss(agent.jsonlFile);
        this.unregisterAgent(agent.sessionId);
        this.removeAgent(id);
      }
    }
  }

  startProjectScan(projectDir: string, _onAgentCreated?: (agent: AgentState) => void): void {
    this.fileScanningService.ensureProjectScan(
      projectDir,
      { current: null } as { current: null },
      this.store.nextAgentId,
      () => this.store.persist(),
      this.hooksEnabled,
    );
  }

  startExternalScanning(_projectDir: string): void {
    this.fileScanningService.startExternalSessionScanning(
      this.hooksEnabled,
      this.watchAllSessions,
    );
  }

  startStaleCheck(): void {
    this.fileScanningService.startStaleExternalAgentCheck(this.hooksEnabled);
  }

  restoreExternalAgents(): void {
    const adapter = this.store.getAdapter();
    if (!adapter) return;
    const persisted = adapter.loadAgents();
    if (persisted.length === 0) return;

    let maxId = 0;

    for (const p of persisted) {
      if (!p.isExternal) continue;
      try {
        if (!fs.existsSync(p.jsonlFile)) continue;
      } catch {
        continue;
      }
      if (this.store.has(p.id)) {
        this.fileScanningService.knownJsonlFiles.add(p.jsonlFile);
        if (p.id > maxId) maxId = p.id;
        continue;
      }

      const agent: AgentState = {
        id: p.id,
        sessionId: p.sessionId || path.basename(p.jsonlFile, '.jsonl'),
        isExternal: true,
        projectDir: p.projectDir,
        jsonlFile: p.jsonlFile,
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
        lastDataAt: 0,
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName: p.folderName,
        hookDelivered: false,
        inputTokens: 0,
        outputTokens: 0,
        teamName: p.teamName,
        agentName: p.agentName,
        isTeamLead: p.isTeamLead,
        leadAgentId: p.leadAgentId,
        teamUsesTmux: p.teamUsesTmux,
      };

      this.store.set(p.id, agent);
      this.fileScanningService.knownJsonlFiles.add(p.jsonlFile);

      try {
        const stat = fs.statSync(p.jsonlFile);
        agent.fileOffset = stat.size;
        this.fileScanningService.startFileWatching(p.id);
      } catch {
        /* ignore stat errors on restore */
      }

      this.registerAgent(agent.sessionId, agent.id);

      if (p.id > maxId) maxId = p.id;
      console.log(
        `[Pixel Agents] Restored external agent ${p.id} -> ${path.basename(p.jsonlFile)}`,
      );
    }

    if (maxId >= this.store.nextAgentId.current) {
      this.store.nextAgentId.current = maxId + 1;
    }

    this.store.persist();
  }

  dispose(): void {
    this.hookRoutingService.dispose();

    for (const id of [...this.store.keys()]) {
      this.removeAgent(id);
    }
  }
}
