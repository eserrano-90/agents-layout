export interface PersistedAgent {
  id: number;
  sessionId?: string;
  terminalName: string;
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  folderName?: string;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface SeatMetadata {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export interface AgentPersistence {
  saveAgents(agents: PersistedAgent[]): void;
  loadAgents(): PersistedAgent[];
  saveSeats(seats: Record<string, SeatMetadata>): void;
  loadSeats(): Record<string, SeatMetadata>;
  saveSetting(key: string, value: unknown): void;
  getSetting<T>(key: string, defaultValue: T): T;
}
