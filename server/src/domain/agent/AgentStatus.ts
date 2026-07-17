export const AgentStatus = {
  Idle: 'idle',
  Active: 'active',
  Waiting: 'waiting',
  Permission: 'permission',
  Disconnected: 'disconnected',
} as const;

export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];
