/**
 * Server-side state of one agent. Every field is derived from ingested events;
 * nothing here points at a file on the emitting client's machine.
 */
export interface AgentState {
  id: number;
  /** Emitting client that owns this agent. */
  clientId: string;
  /** Session id within that client. (clientId, sessionId) identifies the agent. */
  sessionId: string;
  /** Always true today: every agent comes from an emitting client. */
  isExternal: boolean;
  /** Short project label shown next to the character. */
  folderName?: string;
  /** Opaque labels from the client; never opened by the server. */
  cwd?: string;
  transcriptPath?: string;

  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  /** Active tools that spawn a sub-agent character (Task/Agent-like). */
  subagentSpawnToolIds: Set<string>;
  /** Active tools (and sub-agent tools) that never wait on a permission prompt. */
  permissionExemptToolIds: Set<string>;
  activeSubagentToolIds: Map<string, Set<string>>; // parentToolId -> active sub-tool ids
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId -> (subToolId -> name)
  /** Background sub-agent tools; they stay alive until their result is queued. */
  backgroundAgentToolIds: Set<string>;
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  /** Timestamp of the last event received for this agent (ms since epoch). */
  lastDataAt: number;
  /** A hook event has been received for this agent; suppresses heuristic timers. */
  hookDelivered: boolean;
  /** The agent has no transcript; all state comes from hooks. */
  hooksOnly?: boolean;
  /** Hook-generated tool id for PreToolUse/PostToolUse correlation. */
  currentHookToolId?: string;
  /** Tool name from the most recent hook tool start. */
  currentHookToolName?: string;
  /** True if the most recent hook tool start spawns a persistent teammate. Not
   *  cleared on tool end, so it survives the PostToolUse-before-SubagentStart race. */
  currentHookIsTeammateSpawn?: boolean;

  // -- Token tracking --
  inputTokens: number;
  outputTokens: number;
  /** Model backing the current session; undefined until reported. */
  model?: string;

  // -- Agent Teams --
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  /** True when the lead's teammates run as separate sessions (tmux). */
  teamUsesTmux?: boolean;
}

export type { PersistedAgent } from '../../core/src/schemas.js';
