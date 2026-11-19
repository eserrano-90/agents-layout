import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { isTeammateSpawnCall } from '../src/providers/claude/claude.js';
import { claudeTeamProvider } from '../src/providers/claude/claudeTeamProvider.js';

describe('claudeTeamProvider', () => {
  describe('identity', () => {
    it('has providerId "claude"', () => {
      expect(claudeTeamProvider.providerId).toBe('claude');
    });
  });

  describe.each([
    { tool: 'Agent', input: { run_in_background: true }, expected: true },
    { tool: 'Agent', input: { run_in_background: false }, expected: false },
    { tool: 'Agent', input: {}, expected: false },
    // Non-boolean run_in_background must not trigger the teammate path.
    { tool: 'Agent', input: { run_in_background: 'true' }, expected: false },
    { tool: 'Agent', input: { run_in_background: 1 }, expected: false },
    // Task/arbitrary tools never spawn teammates regardless of flags.
    { tool: 'Task', input: { run_in_background: true }, expected: false },
    { tool: 'Read', input: {}, expected: false },
    { tool: 'WebSearch', input: { run_in_background: true }, expected: false },
  ])('isTeammateSpawnCall($tool, $input)', ({ tool, input, expected }) => {
    it(`returns ${expected}`, () => {
      expect(isTeammateSpawnCall(tool, input)).toBe(expected);
    });
  });

  describe('discoverTeammates', () => {
    const fsMod = require('fs') as typeof import('fs');
    const tmpRoot = path.join(os.tmpdir(), 'pixel-agents-discover-' + Date.now());

    afterEach(() => {
      try {
        fsMod.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });

    it('returns empty array when teammate directory does not exist', () => {
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'nonexistent-sess');
      expect(result).toEqual([]);
    });

    it('skips jsonl files without a valid sidecar', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      fsMod.writeFileSync(path.join(sessDir, 'orphan.jsonl'), '{}');
      expect(claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1')).toEqual([]);
    });

    it('returns jsonlPath + teammateName for each valid teammate', () => {
      const sessDir = path.join(tmpRoot, 'sess-1', 'subagents');
      fsMod.mkdirSync(sessDir, { recursive: true });
      const agentA = path.join(sessDir, 'agent-a.jsonl');
      const agentB = path.join(sessDir, 'agent-b.jsonl');
      fsMod.writeFileSync(agentA, '');
      fsMod.writeFileSync(
        agentA.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"web-researcher"}',
      );
      fsMod.writeFileSync(agentB, '');
      fsMod.writeFileSync(
        agentB.replace(/\.jsonl$/, '.meta.json'),
        '{"agentType":"code-reviewer"}',
      );
      const result = claudeTeamProvider.discoverTeammates(tmpRoot, 'sess-1');
      expect(result.map((t) => t.teammateName).sort()).toEqual(['code-reviewer', 'web-researcher']);
      expect(result.every((t) => t.jsonlPath.endsWith('.jsonl'))).toBe(true);
    });
  });

  describe('getTeamMembers', () => {
    // Writes under ~/.claude/teams/<TEAM_NAME>/ and cleans up in afterEach.
    const fs = require('fs') as typeof import('fs');
    const TEAM_NAME = 'test-team-' + Date.now();

    afterEach(() => {
      // Cleanup any test artifacts
      try {
        fs.rmSync(path.join(os.homedir(), '.claude', 'teams', TEAM_NAME), {
          recursive: true,
          force: true,
        });
      } catch {
        /* ignore */
      }
    });

    it('returns null when the team config does not exist', () => {
      const result = claudeTeamProvider.getTeamMembers('nonexistent-team-xyz-' + Date.now());
      expect(result).toBeNull();
    });

    it('returns members when config is well-formed', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [{ name: 'team-lead' }, { name: 'web-researcher' }],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect(result).not.toBeNull();
      expect([...result!].sort()).toEqual(['team-lead', 'web-researcher']);
    });

    it('returns null when config is not valid JSON', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(path.join(teamDir, 'config.json'), 'not json');
      expect(claudeTeamProvider.getTeamMembers(TEAM_NAME)).toBeNull();
    });

    it('skips members without a string name', () => {
      const teamDir = path.join(os.homedir(), '.claude', 'teams', TEAM_NAME);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, 'config.json'),
        JSON.stringify({
          members: [
            { name: 'valid' },
            { agentType: 'no-name' },
            { name: 42 },
            { name: 'also-valid' },
          ],
        }),
      );
      const result = claudeTeamProvider.getTeamMembers(TEAM_NAME);
      expect([...result!].sort()).toEqual(['also-valid', 'valid']);
    });
  });
});
