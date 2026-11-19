/**
 * AgentEventReducer: applies normalized agent events to agent state and turns
 * them into browser messages.
 *
 * This is the single entry point through which agent state changes. It knows no
 * agent tool: every tool-specific decision (status text, reading vs typing,
 * permission exemption, sub-agent and teammate spawns) arrives as a field of the
 * event. It never touches the filesystem.
 *
 * Events come from two origins that are handled differently, exactly like the
 * hooks-vs-heuristic split they replace:
 *
 *   hook         instant and authoritative. The first one for an agent sets
 *                `hookDelivered`, which suppresses the heuristic timers.
 *   transcript   derived from the session transcript. Carries what hooks don't
 *                (sub-agent tools, tokens, model, team info) and drives the
 *                heuristic permission (7 s) and text-idle (5 s) timers when no
 *                hook has been seen.
 */

import type { AgentEvent, AgentEventOf } from '../../core/src/ingest.js';
import type {
  IngestEventOrigin,
  IngestSnapshotSession,
  SessionTeam,
} from '../../core/src/ingestMessages.js';
import type { PersistedAgent } from '../../core/src/schemas.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  PERMISSION_TIMER_DELAY_MS,
  SUBAGENT_TOOL_DONE_DELAY_MS,
  TEXT_IDLE_DELAY_MS,
  TOOL_DONE_DELAY_MS,
} from './constants.js';
import type { DailyUsageTracker } from './dailyUsageTracker.js';
import type { AgentState } from './types.js';

const debug = process.env.PIXEL_AGENTS_DEBUG !== '0';

function sessionKey(clientId: string, sessionId: string): string {
  return `${clientId}\u0000${sessionId}`;
}

export interface AgentEventReducerOptions {
  store: AgentStateStore;
  dailyUsage?: DailyUsageTracker;
  /** Called after an agent is removed (for lifecycle bookkeeping). */
  onAgentRemoved?: (agent: AgentState) => void;
}

export class AgentEventReducer {
  private readonly store: AgentStateStore;
  private readonly dailyUsage?: DailyUsageTracker;
  private readonly onAgentRemoved?: (agent: AgentState) => void;

  /** (clientId, sessionId) -> agent id. */
  private readonly sessions = new Map<string, number>();
  private readonly waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();
  /** Persisted identities from before a restart, waiting for their client. */
  private readonly restorable = new Map<string, PersistedAgent>();

  /** Tool names seen with the reading animation / as sub-agent spawners. The
   *  browser uses these to pick animations and sub-agent characters by name. */
  readonly readingTools = new Set<string>();
  readonly subagentToolNames = new Set<string>();

  constructor(opts: AgentEventReducerOptions) {
    this.store = opts.store;
    this.dailyUsage = opts.dailyUsage;
    this.onAgentRemoved = opts.onAgentRemoved;
  }

  // ── Public surface ─────────────────────────────────────────

  /** Remember persisted agents so a confirming snapshot can restore their ids. */
  setRestorable(persisted: PersistedAgent[]): void {
    this.restorable.clear();
    let maxId = 0;
    for (const p of persisted) {
      this.restorable.set(sessionKey(p.clientId, p.sessionId), p);
      maxId = Math.max(maxId, p.id);
    }
    if (maxId >= this.store.nextAgentId.current) this.store.nextAgentId.current = maxId + 1;
  }

  /** Forget persisted agents of a client that never came back. */
  discardRestorable(clientId: string): void {
    for (const [key, p] of this.restorable) {
      if (p.clientId === clientId) this.restorable.delete(key);
    }
  }

  agentIdFor(clientId: string, sessionId: string): number | undefined {
    return this.sessions.get(sessionKey(clientId, sessionId));
  }

  /** Apply one event from one client. */
  apply(clientId: string, sessionId: string, origin: IngestEventOrigin, event: AgentEvent): void {
    this.noteToolCapabilities(event);

    if (event.kind === 'sessionStart') {
      this.handleSessionStart(clientId, sessionId, origin, event);
      return;
    }
    if (event.kind === 'sessionReplaced') {
      this.handleSessionReplaced(clientId, sessionId, event);
      return;
    }

    const agentId = this.agentIdFor(clientId, sessionId);
    if (agentId === undefined) return; // a session the client never announced
    const agent = this.store.get(agentId);
    if (!agent) return;
    agent.lastDataAt = Date.now();

    if (event.kind === 'sessionEnd') {
      this.removeAgent(agentId);
      return;
    }

    if (origin === 'hook') {
      agent.hookDelivered = true;
      this.applyHookEvent(agent, event);
    } else {
      this.applyTranscriptEvent(agent, event);
    }
  }

  /**
   * Make one client's agents match its list of live sessions: remove the ones
   * that are gone, create the missing ones, and refresh team links.
   */
  reconcile(clientId: string, sessions: IngestSnapshotSession[]): void {
    const live = new Set(sessions.map((s) => s.sessionId));
    for (const agent of [...this.store.values()]) {
      if (agent.clientId === clientId && !live.has(agent.sessionId)) {
        this.removeAgent(agent.id);
      }
    }
    for (const s of sessions) {
      const existingId = this.agentIdFor(clientId, s.sessionId);
      if (existingId !== undefined) {
        const agent = this.store.get(existingId);
        if (agent && s.hookDelivered) agent.hookDelivered = true;
        continue;
      }
      this.createAgent(clientId, s.sessionId, {
        folderName: s.folderName,
        cwd: s.cwd,
        transcriptPath: s.transcriptPath,
        hooksOnly: s.hooksOnly,
        hookDelivered: s.hookDelivered === true,
      });
    }
    // Team links reference other sessions, so resolve them once all exist.
    for (const s of sessions) {
      if (!s.team) continue;
      const agentId = this.agentIdFor(clientId, s.sessionId);
      const agent = agentId !== undefined ? this.store.get(agentId) : undefined;
      if (agent) this.applyTeam(agent, s.team);
    }
  }

  /** Remove every agent of a client. */
  removeClientAgents(clientId: string): void {
    for (const agent of [...this.store.values()]) {
      if (agent.clientId === clientId) this.removeAgent(agent.id);
    }
  }

  /** Remove an agent and the inline teammates it leads. */
  removeAgent(agentId: number): void {
    const agent = this.store.get(agentId);
    if (!agent) return;
    if (agent.isTeamLead) {
      for (const teammate of [...this.store.values()]) {
        if (teammate.leadAgentId === agentId) {
          console.log(`[Pixel Agents] Removing teammate ${teammate.id} (lead ${agentId} closed)`);
          this.deleteAgent(teammate);
        }
      }
    }
    this.deleteAgent(agent);
  }

  dispose(): void {
    for (const t of this.waitingTimers.values()) clearTimeout(t);
    for (const t of this.permissionTimers.values()) clearTimeout(t);
    this.waitingTimers.clear();
    this.permissionTimers.clear();
  }

  // ── Agent lifecycle ────────────────────────────────────────

  private createAgent(
    clientId: string,
    sessionId: string,
    init: {
      folderName?: string;
      cwd?: string;
      transcriptPath?: string;
      hooksOnly?: boolean;
      hookDelivered: boolean;
      team?: SessionTeam;
    },
  ): AgentState {
    const key = sessionKey(clientId, sessionId);
    const restored = this.restorable.get(key);
    this.restorable.delete(key);
    const id =
      restored && !this.store.has(restored.id) ? restored.id : this.store.nextAgentId.current++;

    const agent: AgentState = {
      id,
      clientId,
      sessionId,
      isExternal: true,
      folderName: init.folderName ?? restored?.folderName,
      cwd: init.cwd,
      transcriptPath: init.transcriptPath,
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      subagentSpawnToolIds: new Set(),
      permissionExemptToolIds: new Set(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: Date.now(),
      hookDelivered: init.hookDelivered,
      hooksOnly: init.hooksOnly,
      inputTokens: 0,
      outputTokens: 0,
    };
    if (init.team) this.assignTeamFields(agent, init.team);

    this.sessions.set(key, id);
    this.store.set(id, agent);
    this.store.persist();
    if (debug) {
      console.log(
        `[Pixel Agents] Agent ${id} - session ${sessionId} from client ${clientId}${agent.folderName ? ` (${agent.folderName})` : ''}`,
      );
    }
    return agent;
  }

  private deleteAgent(agent: AgentState): void {
    this.cancelWaitingTimer(agent.id);
    this.cancelPermissionTimer(agent.id);
    this.sessions.delete(sessionKey(agent.clientId, agent.sessionId));
    this.onAgentRemoved?.(agent);
    this.store.delete(agent.id);
    this.store.persist();
  }

  private handleSessionStart(
    clientId: string,
    sessionId: string,
    origin: IngestEventOrigin,
    event: AgentEventOf<'sessionStart'>,
  ): void {
    const existingId = this.agentIdFor(clientId, sessionId);
    if (existingId !== undefined) {
      const agent = this.store.get(existingId);
      if (agent && origin === 'hook') agent.hookDelivered = true;
      return;
    }
    const agent = this.createAgent(clientId, sessionId, {
      folderName: event.folderName,
      cwd: event.cwd,
      transcriptPath: event.transcriptPath,
      hooksOnly: event.hooksOnly,
      hookDelivered: origin === 'hook',
      team: event.team,
    });
    if (event.team) this.broadcastTeamInfo(agent);
  }

  /** /clear or /resume: the same character continues as a new session. */
  private handleSessionReplaced(
    clientId: string,
    sessionId: string,
    event: AgentEventOf<'sessionReplaced'>,
  ): void {
    const agentId = this.agentIdFor(clientId, event.previousSessionId);
    if (agentId === undefined) return;
    const agent = this.store.get(agentId);
    if (!agent) return;
    console.log(
      `[Pixel Agents] Agent ${agentId} - session ${event.previousSessionId} continues as ${sessionId}`,
    );
    this.sessions.delete(sessionKey(clientId, event.previousSessionId));
    this.sessions.set(sessionKey(clientId, sessionId), agentId);
    agent.sessionId = sessionId;
    if (event.transcriptPath) {
      agent.transcriptPath = event.transcriptPath;
      this.cancelWaitingTimer(agentId);
      this.cancelPermissionTimer(agentId);
      this.clearAgentActivity(agent);
    }
    this.store.persist();
  }

  // ── Hook-origin events ─────────────────────────────────────

  private applyHookEvent(agent: AgentState, event: AgentEvent): void {
    switch (event.kind) {
      case 'toolStart':
        return this.hookToolStart(agent, event);
      case 'toolEnd':
        return this.hookToolEnd(agent);
      case 'subagentStart':
        return this.hookSubagentStart(agent, event);
      case 'subagentEnd':
        return this.hookSubagentEnd(agent);
      case 'permissionRequest':
        return this.hookPermissionRequest(agent);
      case 'turnEnd':
        // Stop and Notification(idle_prompt). awaitingInput tells them apart:
        // idle_prompt -> "Waiting for input", Stop -> "Done".
        return this.markAgentWaiting(agent, event.awaitingInput === true);
      case 'subagentTurnEnd':
        return event.reason === 'completed'
          ? this.hookTaskCompleted(agent, event.teammateName)
          : this.hookTeammateIdle(agent, event.teammateName);
      default:
        // Transcript-only kinds arriving from a hook are applied as transcript data.
        return this.applyTranscriptEvent(agent, event);
    }
  }

  /** Instantly mark the agent active without waiting for the transcript poll. */
  private hookToolStart(agent: AgentState, event: AgentEventOf<'toolStart'>): void {
    // Track for tool-end / SubagentStart correlation, even if display is suppressed below.
    agent.currentHookToolId = event.toolId;
    agent.currentHookToolName = event.toolName;
    agent.currentHookIsTeammateSpawn = event.spawnsTeammate === true;

    // With inline teammates, hook tool events are ambiguous (lead and teammates
    // share a tool session). Their tools are shown from the transcripts instead.
    if (this.hasInlineTeammates(agent.id)) return;

    this.cancelWaitingTimer(agent.id);
    agent.isWaiting = false;
    agent.permissionSent = false;
    agent.hadToolsInTurn = true;

    // Sub-agent spawning tools are shown from the transcript: their character
    // needs the stable transcript tool id (not this transient hook id) so the
    // sub-agent can be found again and removed.
    if (!event.spawnsSubagent) {
      this.store.broadcast({
        type: 'agentToolStart',
        id: agent.id,
        toolId: event.toolId,
        status: event.statusText,
        toolName: event.toolName,
      });
    }
    this.store.broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  private hookToolEnd(agent: AgentState): void {
    if (!agent.currentHookToolId) return;
    if (!this.hasInlineTeammates(agent.id)) {
      this.store.broadcast({
        type: 'agentToolDone',
        id: agent.id,
        toolId: agent.currentHookToolId,
      });
    }
    agent.currentHookToolId = undefined;
    agent.currentHookToolName = undefined;
  }

  /**
   * A sub-agent started. Teammate spawns are handled by the client (it discovers
   * the teammate's own session). A basic within-turn sub-agent gets its
   * character right away, under the active sub-agent-spawning tool.
   */
  private hookSubagentStart(agent: AgentState, event: AgentEventOf<'subagentStart'>): void {
    if (agent.currentHookIsTeammateSpawn === true && agent.teamName) return;

    // Only a real transcript-populated parent id; no synthetic fallback, or the
    // parent would be tracked twice once the transcript catches up.
    let parentToolId: string | undefined;
    for (const toolId of agent.activeToolIds) {
      if (agent.subagentSpawnToolIds.has(toolId)) {
        parentToolId = toolId;
        break;
      }
    }
    if (!parentToolId) return; // the transcript will report it via sub-agent progress

    this.trackSubagentTool(
      agent,
      parentToolId,
      event.toolId,
      event.toolName,
      event.permissionExempt,
    );
    this.store.broadcast({
      type: 'subagentToolStart',
      id: agent.id,
      parentToolId,
      toolId: event.toolId,
      status: event.statusText,
    });
  }

  /**
   * A sub-agent stopped. Inline teammates are only marked waiting: they may sit
   * idle for minutes between requests, and their removal is driven by team
   * membership. A basic within-turn sub-agent's character is cleared.
   */
  private hookSubagentEnd(agent: AgentState): void {
    const inlineTeammates = this.getInlineTeammates(agent.id);
    if (inlineTeammates.length > 0) {
      for (const teammate of inlineTeammates) this.markAgentWaiting(teammate);
      return;
    }

    // Pick a parent that still has tracked sub-agents, so a parent whose
    // sub-agents were already cleared this turn isn't picked again.
    let parentToolId: string | undefined;
    for (const toolId of agent.activeToolIds) {
      if (agent.subagentSpawnToolIds.has(toolId) && agent.activeSubagentToolIds.has(toolId)) {
        parentToolId = toolId;
        break;
      }
    }
    if (!parentToolId) return; // the transcript will report it

    agent.activeSubagentToolIds.delete(parentToolId);
    agent.activeSubagentToolNames.delete(parentToolId);
    this.store.broadcast({ type: 'subagentClear', id: agent.id, parentToolId });
  }

  /** Show the permission bubble on the agent and its sub-agents. */
  private hookPermissionRequest(agent: AgentState): void {
    // With inline teammates the prompt belongs to a teammate (they share the
    // lead's tool session), so the bubble goes to the teammates.
    const inlineTeammates = this.getInlineTeammates(agent.id);
    if (inlineTeammates.length > 0) {
      for (const teammate of inlineTeammates) {
        this.cancelPermissionTimer(teammate.id);
        teammate.permissionSent = true;
        this.store.broadcast({ type: 'agentToolPermission', id: teammate.id });
      }
      return;
    }

    this.cancelPermissionTimer(agent.id);
    agent.permissionSent = true;
    this.store.broadcast({ type: 'agentToolPermission', id: agent.id });
    for (const parentToolId of agent.activeSubagentToolNames.keys()) {
      this.store.broadcast({ type: 'subagentToolPermission', id: agent.id, parentToolId });
    }
  }

  /** A teammate is idle and available. Routed to the named teammate when known. */
  private hookTeammateIdle(agent: AgentState, teammateName: string | undefined): void {
    const inlineTeammates = this.getInlineTeammates(agent.id);
    if (inlineTeammates.length === 0) {
      // No teammates: a plain idle signal for the agent itself.
      this.markAgentWaiting(agent, true);
      return;
    }
    const match = teammateName
      ? inlineTeammates.find((t) => t.agentName === teammateName)
      : undefined;
    if (match) {
      this.markAgentWaiting(match, true);
      return;
    }
    for (const teammate of inlineTeammates) this.markAgentWaiting(teammate, true);
  }

  /** A teammate reported its task done. */
  private hookTaskCompleted(agent: AgentState, teammateName: string | undefined): void {
    const inlineTeammates = this.getInlineTeammates(agent.id);
    if (inlineTeammates.length === 0) return;
    const match = teammateName
      ? inlineTeammates.find((t) => t.agentName === teammateName)
      : undefined;
    if (match) {
      this.markAgentWaiting(match);
      return;
    }
    for (const teammate of inlineTeammates) this.markAgentWaiting(teammate);
  }

  // ── Transcript-origin events ───────────────────────────────

  private applyTranscriptEvent(agent: AgentState, event: AgentEvent): void {
    switch (event.kind) {
      case 'progress':
        return event.toolId === undefined
          ? this.transcriptData(agent)
          : this.transcriptToolProgress(agent, event.toolId);
      case 'tokenUsage':
        return this.tokenUsage(agent, event);
      case 'modelInfo':
        return this.modelInfo(agent, event.model);
      case 'teamInfo':
        this.applyTeam(agent, event.team);
        return;
      case 'toolStart':
        return this.transcriptToolStart(agent, event);
      case 'toolEnd':
        return this.transcriptToolEnd(agent, event);
      case 'backgroundToolEnd':
        return this.transcriptBackgroundToolEnd(agent, event.toolId);
      case 'textOutput':
        // A text-only reply in a turn without tools never gets a turn-end
        // record, so silence for TEXT_IDLE_DELAY_MS ends it. Hooks end it exactly.
        if (!agent.hadToolsInTurn && !agent.hookDelivered) {
          this.startWaitingTimer(agent.id, TEXT_IDLE_DELAY_MS);
        }
        return;
      case 'userPrompt':
        this.cancelWaitingTimer(agent.id);
        this.clearAgentActivity(agent);
        agent.hadToolsInTurn = false;
        return;
      case 'turnEnd':
        return this.transcriptTurnEnd(agent);
      case 'subagentStart':
        return this.transcriptSubagentStart(agent, event);
      case 'subagentEnd':
        return this.transcriptSubagentEnd(agent, event);
      default:
        return; // hook-only kinds (permissionRequest, subagentTurnEnd) carry nothing here
    }
  }

  /** New transcript data arrived: the agent is still working. */
  private transcriptData(agent: AgentState): void {
    this.cancelWaitingTimer(agent.id);
    this.cancelPermissionTimer(agent.id);
    // With hooks, a permission bubble came from a definitive signal; only a new
    // prompt or a tool result clears it.
    if (agent.permissionSent && !agent.hookDelivered && agent.leadAgentId === undefined) {
      agent.permissionSent = false;
      this.store.broadcast({ type: 'agentToolPermissionClear', id: agent.id });
    }
  }

  /** A running tool reported progress: it is executing, not stuck on a permission. */
  private transcriptToolProgress(agent: AgentState, toolId: string): void {
    if (
      agent.activeToolIds.has(toolId) &&
      !agent.hookDelivered &&
      agent.leadAgentId === undefined
    ) {
      this.startPermissionTimer(agent.id);
    }
  }

  private tokenUsage(agent: AgentState, event: AgentEventOf<'tokenUsage'>): void {
    agent.inputTokens += event.inputTokens;
    agent.outputTokens += event.outputTokens;
    this.store.broadcast({
      type: 'agentTokenUsage',
      id: agent.id,
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
    });
    // The model may not be known yet on the first record; price against the
    // model this record names.
    this.dailyUsage?.record(event.model ?? agent.model, event.inputTokens, event.outputTokens);
  }

  private modelInfo(agent: AgentState, model: string): void {
    if (!model || model === agent.model) return;
    agent.model = model;
    this.store.broadcast({ type: 'agentModelInfo', id: agent.id, model });
  }

  private transcriptToolStart(agent: AgentState, event: AgentEventOf<'toolStart'>): void {
    this.cancelWaitingTimer(agent.id);
    agent.isWaiting = false;
    agent.hadToolsInTurn = true;
    this.store.broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });

    agent.activeToolIds.add(event.toolId);
    agent.activeToolStatuses.set(event.toolId, event.statusText);
    agent.activeToolNames.set(event.toolId, event.toolName);
    if (event.spawnsSubagent) agent.subagentSpawnToolIds.add(event.toolId);
    if (event.permissionExempt) agent.permissionExemptToolIds.add(event.toolId);

    // Hooks already showed this tool instantly. Exceptions: sub-agent spawning
    // tools always come from here (their character needs this stable id), and
    // a lead with inline teammates shows tools from transcripts only.
    const transcriptShowsTools =
      !agent.hookDelivered || this.hasInlineTeammates(agent.id) || event.spawnsSubagent;
    if (transcriptShowsTools) {
      this.store.broadcast({
        type: 'agentToolStart',
        id: agent.id,
        toolId: event.toolId,
        status: event.statusText,
        toolName: event.toolName,
        permissionActive: agent.permissionSent,
        runInBackground: event.runInBackground === true,
      });
    }

    // Heuristic permission detection. Skipped with hooks (exact signal) and for
    // teammates (slow tools give false positives; the lead's hook routes theirs).
    if (!event.permissionExempt && !agent.hookDelivered && agent.leadAgentId === undefined) {
      this.startPermissionTimer(agent.id);
    }
  }

  private transcriptToolEnd(agent: AgentState, event: AgentEventOf<'toolEnd'>): void {
    const toolId = event.toolId;
    const spawnsSubagent = agent.subagentSpawnToolIds.has(toolId);

    // A background agent launch: keep the tool alive until its result is queued.
    if (spawnsSubagent && event.backgroundLaunched) {
      agent.backgroundAgentToolIds.add(toolId);
      return;
    }

    if (spawnsSubagent) {
      agent.activeSubagentToolIds.delete(toolId);
      agent.activeSubagentToolNames.delete(toolId);
      this.store.broadcast({ type: 'subagentClear', id: agent.id, parentToolId: toolId });
    }
    this.forgetTool(agent, toolId);

    // Sub-agent spawning tools always end here, for a consistent sub-agent lifecycle.
    const transcriptShowsTools =
      !agent.hookDelivered || this.hasInlineTeammates(agent.id) || spawnsSubagent;
    if (transcriptShowsTools) {
      this.broadcastToolDoneLater(agent.id, toolId);
    }

    // All tools done: allow the text-idle timer to end the turn if no turn-end
    // record follows.
    if (agent.activeToolIds.size === 0) agent.hadToolsInTurn = false;
  }

  /** A background sub-agent finished. */
  private transcriptBackgroundToolEnd(agent: AgentState, toolId: string): void {
    if (!agent.backgroundAgentToolIds.has(toolId)) return;
    agent.backgroundAgentToolIds.delete(toolId);
    agent.activeSubagentToolIds.delete(toolId);
    agent.activeSubagentToolNames.delete(toolId);
    this.store.broadcast({ type: 'subagentClear', id: agent.id, parentToolId: toolId });
    this.forgetTool(agent, toolId);
    if (!agent.hookDelivered) this.broadcastToolDoneLater(agent.id, toolId);
  }

  /** Definitive turn end: clear foreground tool state, keep background agents. */
  private transcriptTurnEnd(agent: AgentState): void {
    this.cancelWaitingTimer(agent.id);
    this.cancelPermissionTimer(agent.id);

    const hasForegroundTools = agent.activeToolIds.size > agent.backgroundAgentToolIds.size;
    if (hasForegroundTools) {
      for (const toolId of [...agent.activeToolIds]) {
        if (agent.backgroundAgentToolIds.has(toolId)) continue;
        if (agent.subagentSpawnToolIds.has(toolId)) {
          agent.activeSubagentToolIds.delete(toolId);
          agent.activeSubagentToolNames.delete(toolId);
        }
        this.forgetTool(agent, toolId);
      }
      // With hooks, Stop already updated the browser.
      if (!agent.hookDelivered) this.store.broadcast({ type: 'agentToolsClear', id: agent.id });
      // Re-send background agent tools so their sub-agents stay alive.
      this.resendBackgroundTools(agent);
    } else if (agent.activeToolIds.size > 0 && agent.backgroundAgentToolIds.size === 0) {
      this.clearToolState(agent);
      if (!agent.hookDelivered) this.store.broadcast({ type: 'agentToolsClear', id: agent.id });
    }

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    if (!agent.hookDelivered) {
      // A completed turn: "Done", not "Waiting for input".
      this.store.broadcast({
        type: 'agentStatus',
        id: agent.id,
        status: 'waiting',
        awaitingInput: false,
      });
    }
  }

  private transcriptSubagentStart(agent: AgentState, event: AgentEventOf<'subagentStart'>): void {
    // Only under an active sub-agent spawning tool.
    if (!agent.subagentSpawnToolIds.has(event.parentToolId)) return;
    this.trackSubagentTool(
      agent,
      event.parentToolId,
      event.toolId,
      event.toolName,
      event.permissionExempt,
    );
    this.store.broadcast({
      type: 'subagentToolStart',
      id: agent.id,
      parentToolId: event.parentToolId,
      toolId: event.toolId,
      status: event.statusText,
    });
    if (!event.permissionExempt && !agent.hookDelivered) this.startPermissionTimer(agent.id);
  }

  private transcriptSubagentEnd(agent: AgentState, event: AgentEventOf<'subagentEnd'>): void {
    if (!agent.subagentSpawnToolIds.has(event.parentToolId)) return;
    agent.activeSubagentToolIds.get(event.parentToolId)?.delete(event.toolId);
    agent.activeSubagentToolNames.get(event.parentToolId)?.delete(event.toolId);
    agent.permissionExemptToolIds.delete(event.toolId);

    const agentId = agent.id;
    const { parentToolId, toolId } = event;
    setTimeout(() => {
      this.store.broadcast({ type: 'subagentToolDone', id: agentId, parentToolId, toolId });
    }, SUBAGENT_TOOL_DONE_DELAY_MS);

    // Another sub-agent may still be stuck: restart the permission heuristic.
    if (this.hasNonExemptSubagentTools(agent) && !agent.hookDelivered) {
      this.startPermissionTimer(agent.id);
    }
  }

  // ── Teams ──────────────────────────────────────────────────

  private assignTeamFields(agent: AgentState, team: SessionTeam): void {
    agent.teamName = team.teamName;
    agent.agentName = team.agentName;
    agent.isTeamLead = team.isTeamLead;
    agent.leadAgentId =
      team.leadSessionId !== undefined
        ? this.agentIdFor(agent.clientId, team.leadSessionId)
        : undefined;
    agent.teamUsesTmux = team.usesTmux;
  }

  private applyTeam(agent: AgentState, team: SessionTeam): void {
    this.assignTeamFields(agent, team);
    this.broadcastTeamInfo(agent);
    this.store.persist();
  }

  private broadcastTeamInfo(agent: AgentState): void {
    this.store.broadcast({
      type: 'agentTeamInfo',
      id: agent.id,
      teamName: agent.teamName,
      agentName: agent.agentName,
      isTeamLead: agent.isTeamLead,
      leadAgentId: agent.leadAgentId,
      ...(agent.teamUsesTmux ? { teamUsesTmux: true } : {}),
    });
  }

  /** Teammates running in-process with the lead (they share its tool session). */
  private getInlineTeammates(leadId: number): AgentState[] {
    return [...this.store.values()].filter((a) => a.leadAgentId === leadId && !a.teamUsesTmux);
  }

  private hasInlineTeammates(leadId: number): boolean {
    for (const a of this.store.values()) {
      if (a.leadAgentId === leadId && !a.teamUsesTmux) return true;
    }
    return false;
  }

  // ── Tool bookkeeping ───────────────────────────────────────

  /** Learn tool names the browser should animate as reading / treat as spawners. */
  private noteToolCapabilities(event: AgentEvent): void {
    if (event.kind !== 'toolStart') return;
    let changed = false;
    if (event.activity === 'reading' && !this.readingTools.has(event.toolName)) {
      this.readingTools.add(event.toolName);
      changed = true;
    }
    if (event.spawnsSubagent && !this.subagentToolNames.has(event.toolName)) {
      this.subagentToolNames.add(event.toolName);
      changed = true;
    }
    if (changed) {
      this.store.broadcast({
        type: 'providerCapabilities',
        readingTools: [...this.readingTools],
        subagentToolNames: [...this.subagentToolNames],
      });
    }
  }

  private trackSubagentTool(
    agent: AgentState,
    parentToolId: string,
    toolId: string,
    toolName: string,
    permissionExempt: boolean,
  ): void {
    let ids = agent.activeSubagentToolIds.get(parentToolId);
    if (!ids) {
      ids = new Set();
      agent.activeSubagentToolIds.set(parentToolId, ids);
    }
    ids.add(toolId);
    let names = agent.activeSubagentToolNames.get(parentToolId);
    if (!names) {
      names = new Map();
      agent.activeSubagentToolNames.set(parentToolId, names);
    }
    names.set(toolId, toolName);
    if (permissionExempt) agent.permissionExemptToolIds.add(toolId);
    else agent.permissionExemptToolIds.delete(toolId);
  }

  private forgetTool(agent: AgentState, toolId: string): void {
    agent.activeToolIds.delete(toolId);
    agent.activeToolStatuses.delete(toolId);
    agent.activeToolNames.delete(toolId);
    agent.subagentSpawnToolIds.delete(toolId);
    agent.permissionExemptToolIds.delete(toolId);
  }

  private clearToolState(agent: AgentState): void {
    agent.activeToolIds.clear();
    agent.activeToolStatuses.clear();
    agent.activeToolNames.clear();
    agent.subagentSpawnToolIds.clear();
    agent.permissionExemptToolIds.clear();
    agent.activeSubagentToolIds.clear();
    agent.activeSubagentToolNames.clear();
  }

  private hasNonExemptSubagentTools(agent: AgentState): boolean {
    for (const names of agent.activeSubagentToolNames.values()) {
      for (const subToolId of names.keys()) {
        if (!agent.permissionExemptToolIds.has(subToolId)) return true;
      }
    }
    return false;
  }

  private broadcastToolDoneLater(agentId: number, toolId: string): void {
    // Delayed so a brief active state isn't hidden by browser-side batching.
    setTimeout(() => {
      this.store.broadcast({ type: 'agentToolDone', id: agentId, toolId });
    }, TOOL_DONE_DELAY_MS);
  }

  private resendBackgroundTools(agent: AgentState): void {
    for (const toolId of agent.backgroundAgentToolIds) {
      const status = agent.activeToolStatuses.get(toolId);
      if (status) {
        this.store.broadcast({ type: 'agentToolStart', id: agent.id, toolId, status });
      }
    }
  }

  /** A new turn starts: clear foreground tools (keep background agents) and mark active. */
  private clearAgentActivity(agent: AgentState): void {
    if (agent.backgroundAgentToolIds.size > 0) {
      for (const toolId of [...agent.activeToolIds]) {
        if (agent.backgroundAgentToolIds.has(toolId)) continue;
        agent.activeSubagentToolIds.delete(toolId);
        agent.activeSubagentToolNames.delete(toolId);
        this.forgetTool(agent, toolId);
      }
    } else {
      this.clearToolState(agent);
    }
    agent.isWaiting = false;
    agent.permissionSent = false;
    this.cancelPermissionTimer(agent.id);
    this.store.broadcast({ type: 'agentToolsClear', id: agent.id });
    // Re-send background agent tools so the browser re-creates their sub-agents.
    this.resendBackgroundTools(agent);
    this.store.broadcast({ type: 'agentStatus', id: agent.id, status: 'active' });
  }

  /**
   * Turn over: clear foreground tools (keep background agents), cancel timers,
   * and show the agent as waiting. Always clears the browser's tools, even when
   * none are tracked anymore, so stale sub-agents and bubbles disappear.
   */
  private markAgentWaiting(agent: AgentState, awaitingInput = false): void {
    this.cancelWaitingTimer(agent.id);
    this.cancelPermissionTimer(agent.id);

    for (const toolId of [...agent.activeToolIds]) {
      if (agent.backgroundAgentToolIds.has(toolId)) continue;
      if (agent.subagentSpawnToolIds.has(toolId)) {
        agent.activeSubagentToolIds.delete(toolId);
        agent.activeSubagentToolNames.delete(toolId);
      }
      this.forgetTool(agent, toolId);
    }
    this.store.broadcast({ type: 'agentToolsClear', id: agent.id });
    this.resendBackgroundTools(agent);

    agent.isWaiting = true;
    agent.permissionSent = false;
    agent.hadToolsInTurn = false;
    agent.currentHookToolId = undefined;
    this.store.broadcast({ type: 'agentStatus', id: agent.id, status: 'waiting', awaitingInput });
  }

  // ── Heuristic timers ───────────────────────────────────────

  private cancelWaitingTimer(agentId: number): void {
    const t = this.waitingTimers.get(agentId);
    if (t) clearTimeout(t);
    this.waitingTimers.delete(agentId);
  }

  private startWaitingTimer(agentId: number, delayMs: number): void {
    this.cancelWaitingTimer(agentId);
    const timer = setTimeout(() => {
      this.waitingTimers.delete(agentId);
      const agent = this.store.get(agentId);
      if (agent) agent.isWaiting = true;
      // The turn ended without a clear idle signal: "Done", not "Waiting for input".
      this.store.broadcast({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
        awaitingInput: false,
      });
    }, delayMs);
    this.waitingTimers.set(agentId, timer);
  }

  private cancelPermissionTimer(agentId: number): void {
    const t = this.permissionTimers.get(agentId);
    if (t) clearTimeout(t);
    this.permissionTimers.delete(agentId);
  }

  /** Show a permission bubble if non-exempt tools are still running when it fires. */
  private startPermissionTimer(agentId: number): void {
    this.cancelPermissionTimer(agentId);
    const timer = setTimeout(() => {
      this.permissionTimers.delete(agentId);
      const agent = this.store.get(agentId);
      if (!agent) return;

      let hasNonExempt = false;
      for (const toolId of agent.activeToolIds) {
        if (!agent.permissionExemptToolIds.has(toolId)) {
          hasNonExempt = true;
          break;
        }
      }
      const stuckParents: string[] = [];
      for (const [parentToolId, names] of agent.activeSubagentToolNames) {
        for (const subToolId of names.keys()) {
          if (!agent.permissionExemptToolIds.has(subToolId)) {
            stuckParents.push(parentToolId);
            hasNonExempt = true;
            break;
          }
        }
      }
      if (!hasNonExempt) return;

      agent.permissionSent = true;
      console.log(`[Pixel Agents] Timer: Agent ${agentId} - possible permission wait detected`);
      this.store.broadcast({ type: 'agentToolPermission', id: agentId });
      for (const parentToolId of stuckParents) {
        this.store.broadcast({ type: 'subagentToolPermission', id: agentId, parentToolId });
      }
    }, PERMISSION_TIMER_DELAY_MS);
    this.permissionTimers.set(agentId, timer);
  }
}
