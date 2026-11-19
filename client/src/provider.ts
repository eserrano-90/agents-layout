/**
 * Provider abstraction for agent tools, as seen by the emitting client.
 *
 * A provider is the only code that knows a specific agent tool (Claude Code
 * today). It turns that tool's hook payloads and transcript records into the
 * normalized AgentEvent contract (core/asyncapi.yaml), and knows where the tool
 * keeps its sessions on this machine. Nothing in a provider is ever imported
 * by the server.
 */

import type { AgentEvent } from '../../core/src/ingest.js';
import type { TeamProvider } from './teamProvider.js';

/** What a provider extracted from one transcript line. */
export interface ParsedTranscriptLine {
  /** Normalized events, in the order the server must apply them. */
  events: AgentEvent[];
  /** Team membership stated by this record, when present. The emitter resolves
   *  lead/teammate links across sessions before telling the server. */
  team?: { teamName: string; agentName?: string };
}

export interface HookProvider {
  readonly kind: 'hook';
  readonly id: string;
  readonly displayName: string;

  /** Normalize a raw hook payload into an AgentEvent. Each tool sends different
   *  JSON; the provider translates it. Returns null for events to ignore. */
  normalizeHookEvent(raw: Record<string, unknown>): {
    sessionId: string;
    event: AgentEvent;
  } | null;

  /** Register the hook script in the agent tool's settings on this machine. */
  installHooks(): Promise<void>;
  /** Remove the hook script registration. */
  uninstallHooks(): Promise<void>;
  /** Check if hooks are currently installed. */
  areHooksInstalled(): Promise<boolean>;

  // ── Optional transcript support ──

  /** Session directories for a workspace. Undefined = no transcript support. */
  getSessionDirs?(workspacePath: string): string[];
  /** Roots containing every session this provider may have started, across all
   *  workspaces. Each root holds one directory per project. Used by "watch all
   *  sessions". */
  getAllSessionRoots?(): string[];
  /** Extension of session transcript files (e.g. '.jsonl'). */
  readonly sessionFileExtension?: string;
  /** Parse one transcript line. Returns null for a line that is not a record. */
  parseTranscriptLine?(line: string): ParsedTranscriptLine | null;
  /** True when the head of a transcript shows the session was started by a
   *  clear of a previous one. */
  isClearedSessionHead?(head: string): boolean;
  /** Short project label derived from a session directory name. */
  folderNameFromSessionDir?(dirName: string): string;

  // ── Optional team extension ──

  readonly team?: TeamProvider;
}
