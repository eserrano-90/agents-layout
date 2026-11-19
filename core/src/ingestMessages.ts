/**
 * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.
 *
 * Run `npm run asyncapi:generate` to regenerate.
 *
 * Source of truth: the yaml at core/asyncapi.yaml.
 * Editors and clients in any language can consume the spec directly.
 */

export interface IngestResponse {
  ok: boolean;
  appliedSeq?: number;
  resync?: boolean;
  error?: string;
  eventIndex?: number;
  supportedVersions?: number[];
}

export interface IngestRequest {
  protocolVersion: number;
  clientId: string;
  label?: string;
  seq: number;
  sentAt: number;
  events: IngestEvent[];
  snapshot?: IngestSnapshot;
  goodbye?: boolean;
}

export interface IngestEvent {
  sessionId: string;
  origin: IngestEventOrigin;
  ts: number;
  event:
    | SessionStartEvent
    | SessionEndEvent
    | SessionReplacedEvent
    | ToolStartEvent
    | ToolEndEvent
    | BackgroundToolEndEvent
    | TurnEndEvent
    | SubagentStartEvent
    | SubagentEndEvent
    | SubagentTurnEndEvent
    | ProgressEvent
    | PermissionRequestEvent
    | TextOutputEvent
    | UserPromptEvent
    | TokenUsageEvent
    | ModelInfoEvent
    | TeamInfoEvent;
}

export type IngestEventOrigin = 'hook' | 'transcript';

export interface SessionStartEvent {
  kind: 'sessionStart';
  source?: string;
  folderName?: string;
  cwd?: string;
  transcriptPath?: string;
  hooksOnly?: boolean;
  team?: SessionTeam;
}

export interface SessionTeam {
  teamName?: string;
  agentName?: string;
  leadSessionId?: string;
  isTeamLead?: boolean;
  usesTmux?: boolean;
}

export interface SessionEndEvent {
  kind: 'sessionEnd';
  reason?: string;
}

export interface SessionReplacedEvent {
  kind: 'sessionReplaced';
  previousSessionId: string;
  transcriptPath?: string;
}

export interface ToolStartEvent {
  kind: 'toolStart';
  toolId: string;
  toolName: string;
  statusText: string;
  activity: AgentActivityKind;
  permissionExempt: boolean;
  spawnsSubagent: boolean;
  spawnsTeammate?: boolean;
  runInBackground?: boolean;
}

export type AgentActivityKind = 'reading' | 'typing';

export interface ToolEndEvent {
  kind: 'toolEnd';
  toolId: string;
  backgroundLaunched?: boolean;
}

export interface BackgroundToolEndEvent {
  kind: 'backgroundToolEnd';
  toolId: string;
}

export interface TurnEndEvent {
  kind: 'turnEnd';
  awaitingInput?: boolean;
}

export interface SubagentStartEvent {
  kind: 'subagentStart';
  parentToolId: string;
  toolId: string;
  toolName: string;
  statusText: string;
  permissionExempt: boolean;
  runInBackground?: boolean;
}

export interface SubagentEndEvent {
  kind: 'subagentEnd';
  parentToolId: string;
  toolId: string;
}

export interface SubagentTurnEndEvent {
  kind: 'subagentTurnEnd';
  parentToolId: string;
  reason: SubagentTurnEndReason;
  teammateName?: string;
}

export type SubagentTurnEndReason = 'idle' | 'completed';

export interface ProgressEvent {
  kind: 'progress';
  toolId?: string;
}

export interface PermissionRequestEvent {
  kind: 'permissionRequest';
}

export interface TextOutputEvent {
  kind: 'textOutput';
}

export interface UserPromptEvent {
  kind: 'userPrompt';
}

export interface TokenUsageEvent {
  kind: 'tokenUsage';
  inputTokens: number;
  outputTokens: number;
  model?: string;
}

export interface ModelInfoEvent {
  kind: 'modelInfo';
  model: string;
}

export interface TeamInfoEvent {
  kind: 'teamInfo';
  team: SessionTeam;
}

export interface IngestSnapshot {
  sessions: IngestSnapshotSession[];
}

export interface IngestSnapshotSession {
  sessionId: string;
  folderName?: string;
  cwd?: string;
  transcriptPath?: string;
  hooksOnly?: boolean;
  hookDelivered?: boolean;
  team?: SessionTeam;
}
