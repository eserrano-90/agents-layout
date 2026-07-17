import type { AgentEvent,HookProvider } from '../../../../core/src/provider.js';
import { SESSION_END_GRACE_MS } from '../../constants.js';
import type { AgentStore } from '../ports/AgentStore.js';
import type { TimerService } from '../ports/TimerService.js';
import type { BroadcastService } from './BroadcastService.js';
import type { SessionManagementService } from './SessionManagementService.js';

export interface HookLifecycleCallbacks {
  onExternalSessionDetected?: (sessionId: string, transcriptPath: string | undefined, cwd: string) => void;
  onSessionClear?: (agentId: number, newSessionId: string, newTranscriptPath: string | undefined) => void;
  onSessionResume?: (transcriptPath: string) => void;
  onTeammateDetected?: (parentAgentId: number, sessionId: string, agentType: string) => void;
  onTeammateRemoved?: (teammateAgentId: number) => void;
  onSessionEnd?: (agentId: number, reason?: string) => void;
}

export class HookRoutingService {
  private waitingTimers = new Map<number, { id: number }>();
  private permissionTimers = new Map<number, { id: number }>();
  private pendingClearTimeouts = new Map<number, { id: number }>();

  private callbacks: HookLifecycleCallbacks = {};

  setCallbacks(callbacks: HookLifecycleCallbacks): void {
    this.callbacks = callbacks;
  }

  constructor(
    private readonly provider: HookProvider,
    private readonly agentStore: AgentStore,
    private readonly sessionService: SessionManagementService,
    private readonly broadcast: BroadcastService,
    private readonly timerService: TimerService,
    callbacks?: HookLifecycleCallbacks,
  ) {
    if (callbacks) this.callbacks = callbacks;
  }

  registerAgent(sessionId: string, agentId: number): void {
    const flushed = this.sessionService.register(sessionId, agentId);
    for (const { providerId, event } of flushed) {
      this.handleBufferedEvent(providerId, event);
    }
  }

  unregisterAgent(sessionId: string): void {
    this.sessionService.unregister(sessionId);
  }

  /** Route a normalized AgentEvent to the appropriate handler. */
  route(sessionId: string, event: AgentEvent): void {
    // Check buffered events first (handlers register on first contact)
    if (this.sessionService.hasBuffered(sessionId)) {
      const flushed = this.sessionService.register(sessionId, -1);
      for (const { providerId, event: buffered } of flushed) {
        this.handleBufferedEvent(providerId, buffered);
      }
    }

    switch (event.kind) {
      case 'sessionStart':
        this.handleSessionStart(sessionId, event);
        return;
      case 'sessionEnd': {
        if (this.sessionService.hasPending(sessionId)) {
          this.sessionService.discardPending(sessionId);
          return;
        }
        this.handleSessionEnd(sessionId, event);
        return;
      }
    }

    // All other events: confirm pending external sessions, then dispatch
    const resolvedId = this.resolveOrConfirm(sessionId);
    if (resolvedId === undefined) {
      // Buffer for unregistered agents that may exist
      const hasUnregistered = [...this.agentStore.values()].some(
        (a) => (a as Record<string, unknown>).sessionId && !this.sessionService.hasSession((a as Record<string, unknown>).sessionId as string),
      );
      if (this.sessionService.hasPending(sessionId) || this.sessionService.hasBuffered(sessionId) || hasUnregistered) {
        this.sessionService.bufferEvent(this.provider.id, event as never);
      }
      return;
    }

    this.dispatch(sessionId, resolvedId, event);
  }

  /** Resolve agent or confirm pending external session. Returns agentId or undefined. */
  private resolveOrConfirm(sessionId: string): number | undefined {
    const resolved = this.sessionService.resolve(sessionId);
    if (resolved !== undefined) return resolved;

    const pending = this.sessionService.confirmPending(sessionId);
    if (pending) {
      this.callbacks.onExternalSessionDetected?.(pending.sessionId, pending.transcriptPath, pending.cwd);
      return this.sessionService.resolve(sessionId);
    }

    // Auto-discovery: find agent by sessionId
    for (const [id, a] of this.agentStore.entries()) {
      const agent = a as Record<string, unknown>;
      if (agent.sessionId === sessionId) {
        this.sessionService.register(sessionId, id);
        return id;
      }
    }

    return undefined;
  }

  private handleBufferedEvent(_providerId: string, _event: unknown): void {
    // Re-dispatch buffered events through route()
    // This is a no-op in the new design; buffered events are re-routed
    // when registerAgent flushes them
  }

  private dispatch(sessionId: string, agentId: number, event: AgentEvent): void {
    switch (event.kind) {
      case 'toolStart':
        this.handleToolStart(agentId, event);
        break;
      case 'toolEnd':
        this.handleToolEnd(agentId, event);
        break;
      case 'subagentStart':
        this.handleSubagentStart(agentId, sessionId, event);
        break;
      case 'subagentEnd':
        this.handleSubagentEnd(agentId, event);
        break;
      case 'turnEnd':
        this.handleTurnEnd(agentId, event);
        break;
      case 'subagentTurnEnd':
        this.handleSubagentTurnEnd(agentId, event);
        break;
      case 'progress':
        break;
      case 'permissionRequest':
        this.handlePermissionRequest(agentId);
        break;
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private agent(agentId: number): Record<string, unknown> | undefined {
    return this.agentStore.get(agentId) as Record<string, unknown> | undefined;
  }

  private getSubagentToolSet(): ReadonlySet<string> {
    if (this.provider.team) {
      return new Set([
        ...this.provider.team.teammateSpawnTools,
        ...this.provider.team.withinTurnSubagentTools,
      ]);
    }
    return this.provider.subagentToolNames;
  }

  private getInlineTeammates(leadId: number): Array<[number, Record<string, unknown>]> {
    const out: Array<[number, Record<string, unknown>]> = [];
    for (const [id, a] of this.agentStore.entries()) {
      const agent = a as Record<string, unknown>;
      if (agent.leadAgentId === leadId && !agent.teamUsesTmux) {
        out.push([id, agent]);
      }
    }
    return out;
  }

  private hasInlineTeammates(leadId: number): boolean {
    for (const a of this.agentStore.values()) {
      const agent = a as Record<string, unknown>;
      if (agent.leadAgentId === leadId && !agent.teamUsesTmux) return true;
    }
    return false;
  }

  private cancelWaitingTimer(agentId: number): void {
    const timer = this.waitingTimers.get(agentId);
    if (timer) {
      this.timerService.clearTimeout(timer);
      this.waitingTimers.delete(agentId);
    }
  }

  private cancelPermissionTimer(agentId: number): void {
    const timer = this.permissionTimers.get(agentId);
    if (timer) {
      this.timerService.clearTimeout(timer);
      this.permissionTimers.delete(agentId);
    }
  }

  // ── Session Start ──────────────────────────────────────────

  private handleSessionStart(sessionId: string, event: AgentEvent & { kind: 'sessionStart' }): void {
    const existingAgentId = this.sessionService.resolve(sessionId);
    if (existingAgentId !== undefined) {
      const agent = this.agent(existingAgentId);
      if (agent) agent.hookDelivered = true;
      return;
    }

    // Auto-discovery
    for (const [id, a] of this.agentStore.entries()) {
      const agent = a as Record<string, unknown>;
      if (agent.sessionId === sessionId) {
        this.sessionService.register(sessionId, id);
        agent.hookDelivered = true;
        return;
      }
    }

    // /clear or /resume: reassign existing agent to new session
    if (event.source === 'clear' || event.source === 'resume') {
      const projectDir = event.transcriptPath ? this.dirname(event.transcriptPath) : event.cwd;
      if (projectDir) {
        for (const [id, a] of this.agentStore.entries()) {
          const agent = a as Record<string, unknown>;
          const isMatch =
            agent.pendingClear &&
            this.resolvePath(agent.projectDir as string) === this.resolvePath(projectDir);
          if (isMatch) {
            agent.pendingClear = false;
            this.sessionService.unregister(agent.sessionId as string);
            this.sessionService.register(sessionId, id);
            this.callbacks.onSessionClear?.(id, sessionId, event.transcriptPath);
            return;
          }
        }
      }
    }

    // Unknown session: store as pending
    if (event.transcriptPath || event.cwd) {
      if (event.source === 'resume' && event.transcriptPath) {
        this.callbacks.onSessionResume?.(event.transcriptPath);
      }
      this.sessionService.storePending(sessionId, {
        sessionId,
        transcriptPath: event.transcriptPath,
        cwd: event.cwd ?? '',
      });
    }
  }

  // ── Session End ────────────────────────────────────────────

  private handleSessionEnd(sessionId: string, event: AgentEvent & { kind: 'sessionEnd' }): void {
    const agentId = this.sessionService.resolve(sessionId);
    if (agentId === undefined) return;
    const agent = this.agent(agentId);
    if (!agent) return;

    const reason = event.reason;
    const expectsFollowUp = reason === '/clear' || reason === '/resume' || reason === 'clear' || reason === 'resume';

    if (expectsFollowUp) {
      agent.pendingClear = true;
      this.markAgentWaiting(agent, agentId);
      const timer = this.timerService.setTimeout(() => {
        if (agent.pendingClear) {
          agent.pendingClear = false;
          this.callbacks.onSessionEnd?.(agentId, reason);
        }
        this.pendingClearTimeouts.delete(agentId);
      }, SESSION_END_GRACE_MS);
      this.pendingClearTimeouts.set(agentId, timer);
    } else {
      this.markAgentWaiting(agent, agentId);
      this.callbacks.onSessionEnd?.(agentId, reason ?? 'unknown');
    }
  }

  // ── Tool Start ─────────────────────────────────────────────

  private handleToolStart(agentId: number, event: AgentEvent & { kind: 'toolStart' }): void {
    const agent = this.agent(agentId);
    if (!agent) return;

    agent.hookDelivered = true;
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.lastDataAt = Date.now();
    agent.currentHookToolId = event.toolId;
    agent.currentHookToolName = event.toolName;
    agent.currentHookIsTeammateSpawn =
      this.provider.team?.isTeammateSpawnCall(event.toolName, (event.input ?? {}) as Record<string, unknown>) ?? false;

    // Suppress tool display when lead has inline teammates
    if (this.hasInlineTeammates(agentId)) return;

    this.cancelWaitingTimer(agentId);
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.hadToolsInTurn = true;

    this.broadcast.agentStatus(agentId, 'active');

    const subagentTools = this.provider.subagentToolNames;
    if (!subagentTools.has(event.toolName)) {
      this.broadcast.agentToolStart(
        agentId,
        event.toolName,
        this.provider.formatToolStatus(event.toolName, event.input),
      );
    }
  }

  // ── Tool End ───────────────────────────────────────────────

  private handleToolEnd(agentId: number, _event: AgentEvent & { kind: 'toolEnd' }): void {
    const agent = this.agent(agentId);
    if (!agent) return;

    if (agent.currentHookToolId) {
      if (!this.hasInlineTeammates(agentId)) {
        this.broadcast.agentToolDone(agentId, agent.currentHookToolName as string ?? '');
      }
      agent.currentHookToolId = undefined;
      agent.currentHookToolName = undefined;
    }
  }

  // ── Subagent Start ─────────────────────────────────────────

  private handleSubagentStart(agentId: number, sessionId: string, event: AgentEvent & { kind: 'subagentStart' }): void {
    const agent = this.agent(agentId);
    if (!agent) return;

    const agentType = this.provider.team?.extractTeammateNameFromEvent(event) ?? 'unknown';

    // Teammate spawn path
    if (this.provider.team && agent.currentHookIsTeammateSpawn === true && agent.teamName) {
      this.callbacks.onTeammateDetected?.(agentId, sessionId, agentType);
      return;
    }

    // Basic within-turn subagent path
    const parentTools = this.getSubagentToolSet();
    let parentToolId: string | undefined;
    const activeToolNames = agent.activeToolNames as Map<string, string> | undefined;
    if (activeToolNames) {
      for (const [toolId, toolName] of activeToolNames) {
        if (parentTools.has(toolName)) {
          parentToolId = toolId;
          break;
        }
      }
    }
    if (!parentToolId) return;

    const subToolId = `hook-sub-${agentType}-${Date.now()}`;

    let subTools = agent.activeSubagentToolIds as Map<string, Set<string>> | undefined;
    if (!subTools) {
      subTools = new Map();
      agent.activeSubagentToolIds = subTools;
    }
    let subToolsForParent = subTools.get(parentToolId);
    if (!subToolsForParent) {
      subToolsForParent = new Set();
      subTools.set(parentToolId, subToolsForParent);
    }
    subToolsForParent.add(subToolId);

    let subNames = agent.activeSubagentToolNames as Map<string, Map<string, string>> | undefined;
    if (!subNames) {
      subNames = new Map();
      agent.activeSubagentToolNames = subNames;
    }
    let subNamesForParent = subNames.get(parentToolId);
    if (!subNamesForParent) {
      subNamesForParent = new Map();
      subNames.set(parentToolId, subNamesForParent);
    }
    subNamesForParent.set(subToolId, agentType);

    this.agentStore.broadcast({
      type: 'subagentToolStart',
      id: agentId,
      parentToolId,
      toolId: subToolId,
      status: `Subtask: ${agentType}`,
    });
  }

  // ── Subagent End ───────────────────────────────────────────

  private handleSubagentEnd(agentId: number, _event: AgentEvent & { kind: 'subagentEnd' }): void {
    const agent = this.agent(agentId);
    if (!agent) return;

    // Inline teammates: mark them waiting
    const inlineTeammates = this.getInlineTeammates(agentId);
    if (inlineTeammates.length > 0) {
      for (const [id, a] of inlineTeammates) {
        this.markAgentWaiting(a, id);
      }
      return;
    }

    // Old-style subagents: find and clear
    const subagentParentTools = this.getSubagentToolSet();
    const activeToolNames = agent.activeToolNames as Map<string, string> | undefined;
    const activeSubagentToolIds = agent.activeSubagentToolIds as Map<string, Set<string>> | undefined;
    if (!activeToolNames || !activeSubagentToolIds) return;

    let parentToolId: string | undefined;
    for (const [toolId, toolName] of activeToolNames) {
      if (subagentParentTools.has(toolName) && activeSubagentToolIds.has(toolId)) {
        parentToolId = toolId;
        break;
      }
    }
    if (!parentToolId) return;

    activeSubagentToolIds.delete(parentToolId);
    (agent.activeSubagentToolNames as Map<string, Map<string, string>> | undefined)?.delete(parentToolId);
    this.agentStore.broadcast({ type: 'subagentClear', id: agentId, parentToolId });
  }

  // ── Turn End ───────────────────────────────────────────────

  private handleTurnEnd(agentId: number, event: AgentEvent & { kind: 'turnEnd' }): void {
    const agent = this.agent(agentId);
    if (!agent) return;
    this.markAgentWaiting(agent, agentId, event.awaitingInput === true);
  }

  // ── Subagent Turn End (TeammateIdle / TaskCompleted) ──────

  private handleSubagentTurnEnd(agentId: number, event: AgentEvent & { kind: 'subagentTurnEnd' }): void {
    const agent = this.agent(agentId);
    if (!agent) return;

    if (!this.provider.team) return;

    if (event.reason === 'completed') {
      // TaskCompleted: mark all inline teammates waiting instantly
      const teammates = this.getInlineTeammates(agentId);
      for (const [id, a] of teammates) {
        this.markAgentWaiting(a, id);
      }
      return;
    }

    // TeammateIdle: mark as waiting-for-input
    const inlineTeammates = this.getInlineTeammates(agentId);
    if (inlineTeammates.length === 0) {
      this.markAgentWaiting(agent, agentId, true);
      return;
    }
    for (const [id, a] of inlineTeammates) {
      this.markAgentWaiting(a, id, true);
    }
  }

  // ── Permission Request ─────────────────────────────────────

  private handlePermissionRequest(agentId: number): void {
    const agent = this.agent(agentId);
    if (!agent) return;

    // Inline teammates: route permission to teammates instead
    const inlineTeammates = this.getInlineTeammates(agentId);
    if (inlineTeammates.length > 0) {
      for (const [id] of inlineTeammates) {
        this.cancelPermissionTimer(id);
        agent.permissionSent = true;
        this.agentStore.broadcast({ type: 'agentToolPermission', id });
      }
      return;
    }

    this.cancelPermissionTimer(agentId);
    agent.permissionSent = true;
    this.agentStore.broadcast({ type: 'agentToolPermission', id: agentId });

    // Also notify sub-agents
    const subNames = agent.activeSubagentToolNames as Map<string, Map<string, string>> | undefined;
    if (subNames) {
      for (const parentToolId of subNames.keys()) {
        this.agentStore.broadcast({ type: 'subagentToolPermission', id: agentId, parentToolId });
      }
    }
  }

  // ── Mark Agent Waiting ─────────────────────────────────────

  private markAgentWaiting(agent: Record<string, unknown>, agentId: number, awaitingInput = false): void {
    this.cancelWaitingTimer(agentId);
    this.cancelPermissionTimer(agentId);

    const activeToolIds = agent.activeToolIds as Set<string> | undefined;
    const activeToolStatuses = agent.activeToolStatuses as Map<string, string> | undefined;
    const activeToolNames = agent.activeToolNames as Map<string, string> | undefined;
    const backgroundAgentToolIds = agent.backgroundAgentToolIds as Set<string> | undefined;
    const activeSubagentToolIds = agent.activeSubagentToolIds as Map<string, Set<string>> | undefined;
    const activeSubagentToolNames = agent.activeSubagentToolNames as Map<string, Map<string, string>> | undefined;

    const parentTools = this.getSubagentToolSet();
    if (activeToolIds) {
      for (const toolId of [...activeToolIds]) {
        if (backgroundAgentToolIds?.has(toolId)) continue;
        activeToolIds.delete(toolId);
        activeToolStatuses?.delete(toolId);
        const toolName = activeToolNames?.get(toolId);
        activeToolNames?.delete(toolId);
        if (toolName && parentTools.has(toolName)) {
          activeSubagentToolIds?.delete(toolId);
          activeSubagentToolNames?.delete(toolId);
        }
      }
    }

    this.agentStore.broadcast({ type: 'agentToolsClear', id: agentId });

    // Re-send background agent tools after the clear
    if (backgroundAgentToolIds) {
      for (const toolId of backgroundAgentToolIds) {
        const status = activeToolStatuses?.get(toolId);
        if (status) {
          this.agentStore.broadcast({ type: 'agentToolStart', id: agentId, toolId, status });
        }
      }
    }

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    agent.currentHookToolId = undefined;
    agent.currentHookToolName = undefined;

    this.agentStore.broadcast({
      type: 'agentStatus',
      id: agentId,
      status: 'waiting',
      awaitingInput,
    });
  }

  // ── Path Helpers ───────────────────────────────────────────

  private dirname(p: string): string {
    const idx = p.lastIndexOf('/');
    if (idx === -1) return '.';
    return p.slice(0, idx) || '/';
  }

  private resolvePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
  }

  // ── Cleanup ────────────────────────────────────────────────

  dispose(): void {
    for (const timer of this.waitingTimers.values()) this.timerService.clearTimeout(timer);
    for (const timer of this.permissionTimers.values()) this.timerService.clearTimeout(timer);
    for (const timer of this.pendingClearTimeouts.values()) this.timerService.clearTimeout(timer);
    this.waitingTimers.clear();
    this.permissionTimers.clear();
    this.pendingClearTimeouts.clear();
  }
}
