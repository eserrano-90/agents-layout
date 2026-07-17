import type { AgentPersistence, PersistedAgent, SeatMetadata } from '../../application/ports/AgentPersistence.js';
import type { ConfigNamespace } from '../../configPersistence.js';
import { FileStateAdapter } from '../../fileStateAdapter.js';

export class FileSystemAgentAdapter implements AgentPersistence {
  private adapter: FileStateAdapter;

  constructor(namespace: ConfigNamespace = 'standalone') {
    this.adapter = new FileStateAdapter({ namespace });
  }

  saveAgents(agents: PersistedAgent[]): void {
    this.adapter.saveAgents(agents);
  }

  loadAgents(): PersistedAgent[] {
    return this.adapter.loadAgents();
  }

  saveSeats(seats: Record<string, SeatMetadata>): void {
    this.adapter.saveSeats(seats);
  }

  loadSeats(): Record<string, SeatMetadata> {
    return this.adapter.loadSeats();
  }

  saveSetting(key: string, value: unknown): void {
    this.adapter.setSetting(key, value as never);
  }

  getSetting<T>(key: string, defaultValue: T): T {
    return this.adapter.getSetting(key, defaultValue);
  }
}
