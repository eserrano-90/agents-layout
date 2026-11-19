import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TeamProvider } from '../../teamProvider.js';

/**
 * Claude Code implementation of the TeamProvider interface.
 *
 * Encapsulates every Claude-specific path, field name, and tool identifier
 * for the Agent Teams feature that involves this machine's filesystem. Adding
 * support for a new CLI means creating a sibling file; the session emitter is
 * untouched.
 */

// ── Internal helpers (not exposed on the public TeamProvider interface) ──

/** Claude stores teammate metadata in a sidecar `<file>.meta.json`. */
function sidecarPath(jsonlPath: string): string {
  return jsonlPath.replace(/\.jsonl$/, '.meta.json');
}

/** Parse a sidecar's `agentType` field, if present. */
function parseSidecarAgentType(jsonlPath: string): string | null {
  const metaPath = sidecarPath(jsonlPath);
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8');
    const data = JSON.parse(raw) as { agentType?: unknown };
    return typeof data.agentType === 'string' ? data.agentType : null;
  } catch {
    return null;
  }
}

/** Claude stores teammate JSONL files at `<projectDir>/<leadSessionId>/subagents/`. */
function teammateDir(projectDir: string, leadSessionId: string): string {
  return path.join(projectDir, leadSessionId, 'subagents');
}

// ── Public TeamProvider implementation ──

export const claudeTeamProvider: TeamProvider = {
  providerId: 'claude',

  discoverTeammates(projectDir, leadSessionId) {
    const dir = teammateDir(projectDir, leadSessionId);
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return []; // directory missing -> no teammates yet
    }
    const result: Array<{ jsonlPath: string; teammateName: string }> = [];
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const jsonlPath = path.join(dir, entry);
      const teammateName = parseSidecarAgentType(jsonlPath);
      if (teammateName) {
        result.push({ jsonlPath, teammateName });
      }
    }
    return result;
  },

  getTeamMembers(teamName) {
    const configPath = path.join(os.homedir(), '.claude', 'teams', teamName, 'config.json');
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf-8');
    } catch {
      return null; // config missing / unreadable -> team dissolved
    }
    try {
      const data = JSON.parse(raw) as { members?: Array<{ name?: unknown }> };
      if (!Array.isArray(data.members)) return null;
      const names = new Set<string>();
      for (const m of data.members) {
        if (m && typeof m.name === 'string') names.add(m.name);
      }
      return names;
    } catch {
      return null;
    }
  },
};
