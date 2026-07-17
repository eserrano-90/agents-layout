import type { HookProvider } from '../../../../core/src/provider.js';
import { TEXT_IDLE_DELAY_MS } from '../../constants.js';
import type { DailyUsageTracker } from '../../dailyUsageTracker.js';
import type { AgentStore } from '../ports/AgentStore.js';
import type { TimerHandle,TimerService } from '../ports/TimerService.js';
import type { BroadcastService } from './BroadcastService.js';

export class TranscriptProcessingService {
  private waitingTimers = new Map<number, TimerHandle>();
  private permissionTimers = new Map<number, TimerHandle>();

  constructor(
    private readonly provider: HookProvider,
    private readonly agentStore: AgentStore,
    private readonly broadcast: BroadcastService,
    private readonly timerService: TimerService,
    private readonly dailyUsageTracker?: DailyUsageTracker,
  ) {}

  private a(agentId: number): Record<string, unknown> | undefined {
    return this.agentStore.get(agentId) as Record<string, unknown> | undefined;
  }

  private cancelWaitingTimer(agentId: number): void {
    const t = this.waitingTimers.get(agentId);
    if (t) { this.timerService.clearTimeout(t); this.waitingTimers.delete(agentId); }
  }

  private cancelPermissionTimer(agentId: number): void {
    const t = this.permissionTimers.get(agentId);
    if (t) { this.timerService.clearTimeout(t); this.permissionTimers.delete(agentId); }
  }

  private startWaitingTimer(agentId: number, delayMs: number, agent: Record<string, unknown>): void {
    this.cancelWaitingTimer(agentId);
    const handle = this.timerService.setTimeout(() => {
      this.waitingTimers.delete(agentId);
      agent.isWaiting = true;
      agent.permissionSent = false;
      this.agentStore.broadcast({
        type: 'agentStatus',
        id: agentId,
        status: 'waiting',
        awaitingInput: false,
      });
    }, delayMs);
    this.waitingTimers.set(agentId, handle);
  }

  private startPermissionTimer(agentId: number, agent: Record<string, unknown>, exempt: ReadonlySet<string>): void {
    const currentToolName = (agent.activeToolNames as Map<string, string>)?.values().next().value as string | undefined;
    if (!currentToolName || exempt.has(currentToolName)) return;
    this.cancelPermissionTimer(agentId);
    const handle = this.timerService.setTimeout(() => {
      this.permissionTimers.delete(agentId);
      agent.permissionSent = true;
      this.agentStore.broadcast({ type: 'agentToolPermission', id: agentId });
    }, 7_000);
    this.permissionTimers.set(agentId, handle);
  }

  processLine(agentId: number, line: string): void {
    const raw = this.parseLine(line);
    if (!raw) return;

    const agent = this.a(agentId);
    if (!agent) return;

    agent.lastDataAt = Date.now();
    agent.linesProcessed = (agent.linesProcessed as number ?? 0) + 1;

    // Team metadata extraction
    const teamMeta = this.provider.team?.extractTeamMetadataFromRecord(raw);
    if (teamMeta?.teamName && teamMeta.teamName !== agent.teamName) {
      agent.teamName = teamMeta.teamName as string;
      agent.agentName = teamMeta.agentName as string | undefined;
      agent.isTeamLead = undefined;
      agent.leadAgentId = undefined;
      this.linkTeammates(agent, agent.teamName as string);
      this.agentStore.broadcast({
        type: 'agentTeamInfo',
        id: agentId,
        teamName: agent.teamName as string,
        agentName: agent.agentName as string | undefined,
        isTeamLead: agent.isTeamLead as boolean | undefined,
        leadAgentId: agent.leadAgentId as number | undefined,
      });
    }

    // Token usage & model extraction
    const msg = raw.message as Record<string, unknown> | undefined;
    const usage = msg?.usage as { input_tokens?: number; output_tokens?: number } | undefined;
    if (usage) {
      const inputDelta = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
      const outputDelta = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
      agent.inputTokens = ((agent.inputTokens as number) ?? 0) + inputDelta;
      agent.outputTokens = ((agent.outputTokens as number) ?? 0) + outputDelta;
      this.agentStore.broadcast({
        type: 'agentTokenUsage',
        id: agentId,
        inputTokens: agent.inputTokens as number,
        outputTokens: agent.outputTokens as number,
      });
      const usageModel = (msg?.model as string | undefined) ?? agent.model;
      this.dailyUsageTracker?.record(usageModel as string, inputDelta, outputDelta);
    }

    const model = msg?.model as string | undefined;
    if (typeof model === 'string' && model && model !== agent.model) {
      agent.model = model;
      this.agentStore.broadcast({ type: 'agentModelInfo', id: agentId, model });
    }

    const recordType = raw.type as string;
    switch (recordType) {
      case 'assistant':
        this.handleAssistant(agentId, agent, raw);
        break;
      case 'user':
        this.handleUser(agentId, agent, raw);
        break;
      case 'progress':
        this.handleProgress(agentId, agent, raw);
        break;
      case 'system':
        this.handleSystem(agentId, agent, raw);
        break;
      case 'queue-operation':
        this.handleQueueOperation(agentId, agent, raw);
        break;
      default:
        this.trackUnknownType(agent, recordType);
        break;
    }
  }

  private parseLine(line: string): Record<string, unknown> | null {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private hasInlineTeammates(leadId: number): boolean {
    for (const a of this.agentStore.values()) {
      const aa = a as Record<string, unknown>;
      if (aa.leadAgentId === leadId && !aa.teamUsesTmux) return true;
    }
    return false;
  }

  private linkTeammates(agent: Record<string, unknown>, teamName: string): void {
    if (!teamName) return;
    let teamLeadId: number | undefined;
    for (const [id, a] of this.agentStore.entries()) {
      const aa = a as Record<string, unknown>;
      if (aa.teamName === teamName && aa.isTeamLead === true && aa.agentName === undefined) {
        teamLeadId = id;
        break;
      }
    }
    if (teamLeadId !== undefined) {
      agent.leadAgentId = teamLeadId;
      agent.isTeamLead = false;
    } else if (agent.agentName === undefined) {
      agent.isTeamLead = true;
    }
  }

  private handleAssistant(
    agentId: number,
    agent: Record<string, unknown>,
    data: Record<string, unknown>,
  ): void {
    const assistantContent = (data.message as Record<string, unknown> | undefined)?.content ?? data.content;

    if (Array.isArray(assistantContent)) {
      const blocks = assistantContent as Array<Record<string, unknown>>;
      const hasToolUse = blocks.some((b) => b.type === 'tool_use');

      if (hasToolUse) {
        this.cancelWaitingTimer(agentId);
        agent.isWaiting = false;
        agent.hadToolsInTurn = true;
        this.agentStore.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });

        let hasNonExemptTool = false;
        for (const block of blocks) {
          if (block.type === 'tool_use' && block.id) {
            this.handleBlockToolUse(agentId, agent, block);
            if (!this.provider.permissionExemptTools.has(block.name as string)) {
              hasNonExemptTool = true;
            }
          }
        }

        if (hasNonExemptTool && !agent.hookDelivered && !agent.leadAgentId) {
          this.startPermissionTimer(agentId, agent, this.provider.permissionExemptTools);
        }
      } else if (blocks.some((b) => b.type === 'text') && !agent.hadToolsInTurn) {
        if (!agent.hookDelivered) {
          this.startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agent);
        }
      }
    } else if (typeof assistantContent === 'string') {
      if (!agent.hadToolsInTurn && !agent.hookDelivered) {
        this.startWaitingTimer(agentId, TEXT_IDLE_DELAY_MS, agent);
      }
    } else if (assistantContent === undefined) {
      // log but don't crash
    }
  }

  private handleBlockToolUse(
    agentId: number,
    agent: Record<string, unknown>,
    block: Record<string, unknown>,
  ): void {
    const toolName = block.name as string;
    const toolId = (block.id as string) || (block.tool_use_id as string);
    if (!toolId) return;

    const status = this.provider.formatToolStatus(toolName, block.input);

    const idSet = agent.activeToolIds as Set<string>;
    if (!idSet.has(toolId)) idSet.add(toolId);
    (agent.activeToolNames as Map<string, string>).set(toolId, toolName);
    (agent.activeToolStatuses as Map<string, string>).set(toolId, status);

    const isSubagentSpawn = this.provider.subagentToolNames.has(toolName);
    const useJsonlToolEvents = agent.hookDelivered && this.hasInlineTeammates(agentId);

    if (!agent.hookDelivered || useJsonlToolEvents || isSubagentSpawn) {
      const runInBackground = isSubagentSpawn && (block.input as Record<string, unknown> | undefined)?.run_in_background === true;
      this.agentStore.broadcast({
        type: 'agentToolStart',
        id: agentId,
        toolId,
        status,
        toolName,
        permissionActive: agent.permissionSent as boolean | undefined,
        runInBackground,
      });
    }

    if (isSubagentSpawn) {
      (agent.backgroundAgentToolIds as Set<string>).add(toolId);
    }
  }

  private handleUser(
    agentId: number,
    agent: Record<string, unknown>,
    data: Record<string, unknown>,
  ): void {
    const content = (data.message as Record<string, unknown> | undefined)?.content ?? data.content;

    if (typeof content === 'string') {
      agent.hadToolsInTurn = false;
      const idSet = agent.activeToolIds as Set<string>;
      idSet.clear();
      (agent.activeToolStatuses as Map<string, string>).clear();
      (agent.activeToolNames as Map<string, string>).clear();
      (agent.activeSubagentToolIds as Map<string, Set<string>>).clear();
      (agent.activeSubagentToolNames as Map<string, Map<string, string>>).clear();
      this.agentStore.broadcast({ type: 'agentToolsClear', id: agentId });
      this.agentStore.broadcast({ type: 'agentStatus', id: agentId, status: 'active' });
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result') {
          this.handleToolResult(agentId, agent, block);
        }
      }
    }
  }

  private handleToolResult(
    agentId: number,
    agent: Record<string, unknown>,
    block: Record<string, unknown>,
  ): void {
    const toolUseId = block.tool_use_id as string;
    if (!toolUseId) return;

    const idSet = agent.activeToolIds as Set<string>;
    idSet.delete(toolUseId);
    (agent.activeToolStatuses as Map<string, string>).delete(toolUseId);

    const toolName = (agent.activeToolNames as Map<string, string>).get(toolUseId) ?? '';
    (agent.activeToolNames as Map<string, string>).delete(toolUseId);

    if (this.isAsyncAgentResult(block)) {
      (agent.backgroundAgentToolIds as Set<string>).delete(toolUseId);
      this.broadcast.agentToolDone(agentId, toolName);
      return;
    }

    if ((agent.backgroundAgentToolIds as Set<string>).has(toolUseId)) return;

    (agent.activeSubagentToolIds as Map<string, Set<string>>).delete(toolUseId);
    (agent.activeSubagentToolNames as Map<string, Map<string, string>>).delete(toolUseId);

    const subagentTools = this.provider.subagentToolNames;
    if (subagentTools.has(toolName)) {
      (agent.backgroundAgentToolIds as Set<string>).delete(toolUseId);
      this.broadcast.agentToolDone(agentId, toolName);
    }
  }

  private handleProgress(
    agentId: number,
    agent: Record<string, unknown>,
    data: Record<string, unknown>,
  ): void {
    const progressData = data.data as Record<string, unknown> | undefined;
    if (!progressData || typeof progressData.type !== 'string') return;

    const progressType = progressData.type as string;

    if (progressType === 'agent_progress') {
      this.handleAgentProgress(agentId, agent, progressData);
    } else if (progressType === 'bash_progress' || progressType === 'mcp_progress') {
      this.handleGenericProgress(agent);
    }
  }

  private handleAgentProgress(
    agentId: number,
    agent: Record<string, unknown>,
    progressData: Record<string, unknown>,
  ): void {
    const subToolContent = progressData.content as Array<Record<string, unknown>> | undefined;
    if (!subToolContent) return;

    const parentToolId = progressData.parent_tool_id as string;
    if (!parentToolId) return;

    for (const subBlock of subToolContent) {
      if (subBlock?.type === 'tool_use') {
        const subToolName = subBlock.name as string;
        const subToolId = (subBlock.id as string) || (subBlock.tool_use_id as string);
        if (!subToolId) continue;

        agent.lastDataAt = Date.now();

        const parentMap = agent.activeSubagentToolIds as Map<string, Set<string>>;
        if (!parentMap.has(parentToolId)) parentMap.set(parentToolId, new Set());
        parentMap.get(parentToolId)!.add(subToolId);

        const nameMap = agent.activeSubagentToolNames as Map<string, Map<string, string>>;
        if (!nameMap.has(parentToolId)) nameMap.set(parentToolId, new Map());
        nameMap.get(parentToolId)!.set(subToolId, subToolName);

        this.agentStore.broadcast({
          type: 'subagentToolStart',
          id: agentId,
          parentToolId,
          toolId: subToolId,
          status: this.provider.formatToolStatus(subToolName, subBlock.input),
        });
      } else if (subBlock?.type === 'tool_result') {
        const subToolId = subBlock.tool_use_id as string;
        if (!subToolId) continue;

        const nameMap = agent.activeSubagentToolNames as Map<string, Map<string, string>>;
        const parentSubNames = nameMap.get(parentToolId);

        (agent.activeSubagentToolIds as Map<string, Set<string>>).get(parentToolId)?.delete(subToolId);
        parentSubNames?.delete(subToolId);

        this.agentStore.broadcast({
          type: 'subagentToolDone',
          id: agentId,
          parentToolId,
          toolId: subToolId,
        } as never);
      }
    }
  }

  private handleGenericProgress(agent: Record<string, unknown>): void {
    agent.lastDataAt = Date.now();
  }

  private handleSystem(
    agentId: number,
    agent: Record<string, unknown>,
    data: Record<string, unknown>,
  ): void {
    const subtype = data.subtype as string | undefined;

    if (subtype === 'turn_duration') {
      this.agentStore.broadcast({ type: 'agentToolsClear', id: agentId });
      this.agentStore.broadcast({ type: 'agentStatus', id: agentId, status: 'waiting', awaitingInput: false });
      agent.hadToolsInTurn = false;

      const bgIds = agent.backgroundAgentToolIds as Set<string>;
      const activeTools = agent.activeToolIds as Set<string>;
      activeTools.clear();
      (agent.activeToolStatuses as Map<string, string>).clear();
      (agent.activeToolNames as Map<string, string>).clear();
      (agent.activeSubagentToolIds as Map<string, Set<string>>).clear();
      (agent.activeSubagentToolNames as Map<string, Map<string, string>>).clear();

      for (const toolId of bgIds) {
        activeTools.add(toolId);
      }
    }
  }

  private handleQueueOperation(
    agentId: number,
    _agent: Record<string, unknown>,
    data: Record<string, unknown>,
  ): void {
    const operation = data.operation as string;
    if (operation === 'enqueue') {
      const content = data.content as string | undefined;
      if (content) {
        const match = content.match(/<tool-use-id>([^<]+)<\/tool-use-id>/);
        if (match) {
          this.broadcast.agentToolDone(agentId, 'Task');
        }
      }
    }
  }

  private trackUnknownType(agent: Record<string, unknown>, recordType: string): void {
    const seen = agent.seenUnknownRecordTypes as Set<string>;
    if (seen && !seen.has(recordType)) {
      seen.add(recordType);
    }
  }

  private isAsyncAgentResult(block: Record<string, unknown>): boolean {
    const content = block.content;
    if (typeof content === 'string') {
      return content.startsWith('Async agent launched successfully.');
    }
    if (Array.isArray(content)) {
      const textBlock = content.find((c) => c?.type === 'text');
      if (textBlock && typeof textBlock.text === 'string') {
        return textBlock.text.startsWith('Async agent launched successfully.');
      }
    }
    return false;
  }

  dispose(): void {
    for (const t of this.waitingTimers.values()) this.timerService.clearTimeout(t);
    for (const t of this.permissionTimers.values()) this.timerService.clearTimeout(t);
    this.waitingTimers.clear();
    this.permissionTimers.clear();
  }
}
