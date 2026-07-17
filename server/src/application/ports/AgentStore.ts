import type { ServerMessage } from '../../../../core/src/messages.js';

export interface StoreEvents {
  agentAdded: (id: number, agent: Record<string, unknown>) => void;
  agentRemoved: (id: number) => void;
  agentUpdated: (id: number, agent: Record<string, unknown>, field: string) => void;
  broadcast: (message: Record<string, unknown>) => void;
}

export interface AgentStore {
  get(id: number): Record<string, unknown> | undefined;
  has(id: number): boolean;
  set(id: number, agent: Record<string, unknown>): void;
  delete(id: number): boolean;
  keys(): IterableIterator<number>;
  values(): IterableIterator<Record<string, unknown>>;
  entries(): IterableIterator<[number, Record<string, unknown>]>;
  forEach(cb: (agent: Record<string, unknown>, id: number) => void): void;
  readonly size: number;
  readonly nextAgentId: { current: number };

  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): void;
  off<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): void;
  broadcast(message: ServerMessage): void;
  persist(): void;
}
