import type { AgentStatus } from './AgentStatus.js';

export interface Agent {
  readonly id: number;
  sessionId: string;
  status: AgentStatus;
  isExternal: boolean;
  hookDelivered: boolean;
  isWaiting: boolean;
  permissionSent: boolean;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  lastDataAt: number;
  linesProcessed: number;
  inputTokens: number;
  outputTokens: number;
  model?: string;
  folderName?: string;
  hooksOnly?: boolean;
  providerId?: string;
}

export function createAgent(id: number, sessionId: string, isExternal = false): Agent {
  return {
    id,
    sessionId,
    status: 'idle' as AgentStatus,
    isExternal,
    hookDelivered: false,
    isWaiting: false,
    permissionSent: false,
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    lastDataAt: Date.now(),
    linesProcessed: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}
