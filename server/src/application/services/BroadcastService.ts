import type { ServerMessage } from '../../../../core/src/messages.js';
import type { AgentStore } from '../ports/AgentStore.js';

export class BroadcastService {
  constructor(private readonly agentStore: AgentStore) {}

  broadcast(message: ServerMessage): void {
    this.agentStore.broadcast(message);
  }

  agentToolStart(
    id: number,
    toolName: string,
    status: string,
    isBackground = false,
  ): void {
    this.broadcast({
      type: 'agentToolStart',
      id,
      toolName,
      status,
      isBackground,
      toolId: '',
    } as unknown as ServerMessage);
  }

  agentToolDone(
    id: number,
    toolName: string,
    subAgentId?: number,
  ): void {
    this.broadcast({
      type: 'agentToolDone',
      id,
      toolName,
      subAgentId,
      toolId: '',
    } as unknown as ServerMessage);
  }

  agentToolsClear(id: number): void {
    this.broadcast({ type: 'agentToolsClear', id } as unknown as ServerMessage);
  }

  agentStatus(
    id: number,
    status: string,
    extra?: Record<string, unknown>,
  ): void {
    this.broadcast({
      type: 'agentStatus',
      id,
      status,
      ...extra,
    } as unknown as ServerMessage);
  }

  agentToolPermission(
    id: number,
    toolName: string,
    status: string,
  ): void {
    this.broadcast({
      type: 'agentToolPermission',
      id,
      toolName,
      status,
    } as unknown as ServerMessage);
  }

  agentToolPermissionClear(id: number): void {
    this.broadcast({
      type: 'agentToolPermissionClear',
      id,
    } as unknown as ServerMessage);
  }

  subagentToolPermission(
    subAgentId: number,
    toolName: string,
    status: string,
  ): void {
    this.broadcast({
      type: 'subagentToolPermission',
      id: subAgentId,
      toolName,
      status,
      parentToolId: '',
    } as unknown as ServerMessage);
  }

  subagentToolStart(
    id: number,
    parentId: number,
    toolName: string,
    status: string,
  ): void {
    this.broadcast({
      type: 'subagentToolStart',
      id,
      parentId,
      toolName,
      status,
      parentToolId: '',
      toolId: '',
    } as unknown as ServerMessage);
  }

  subagentToolDone(
    id: number,
    parentId: number,
    toolName: string,
  ): void {
    this.broadcast({
      type: 'subagentToolDone',
      id,
      parentId,
      toolName,
      parentToolId: '',
      toolId: '',
    } as unknown as ServerMessage);
  }

  agentTeamInfo(
    id: number,
    teamName: string,
    agentName: string,
    isTeamLead: boolean,
    leadAgentId?: number,
  ): void {
    this.broadcast({
      type: 'agentTeamInfo',
      id,
      teamName,
      agentName,
      isTeamLead,
      leadAgentId,
    } as unknown as ServerMessage);
  }
}
