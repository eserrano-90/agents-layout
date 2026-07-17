import { describe, expect, it } from 'vitest';

import { createAgent } from '../../src/domain/agent/Agent.js';
import { createToolInvocation } from '../../src/domain/agent/ToolInvocation.js';
import { createSession } from '../../src/domain/session/Session.js';
import { createAgentTeam } from '../../src/domain/team/AgentTeam.js';

describe('Agent domain', () => {
  describe('createAgent', () => {
    it('creates an agent with default values', () => {
      const agent = createAgent(1, 'sess-abc');
      expect(agent.id).toBe(1);
      expect(agent.sessionId).toBe('sess-abc');
      expect(agent.isExternal).toBe(false);
      expect(agent.isWaiting).toBe(false);
      expect(agent.permissionSent).toBe(false);
      expect(agent.linesProcessed).toBe(0);
      expect(agent.inputTokens).toBe(0);
      expect(agent.outputTokens).toBe(0);
    });

    it('creates an external agent', () => {
      const agent = createAgent(2, 'sess-xyz', true);
      expect(agent.isExternal).toBe(true);
    });

    it('has empty Sets/Maps', () => {
      const agent = createAgent(3, 'sess-def');
      expect(agent.activeToolIds.size).toBe(0);
      expect(agent.activeToolStatuses.size).toBe(0);
      expect(agent.activeToolNames.size).toBe(0);
    });
  });

  describe('createToolInvocation', () => {
    it('creates a tool invocation with all fields', () => {
      const tool = createToolInvocation('t1', 'Read', 'Reading file', 1000);
      expect(tool.toolId).toBe('t1');
      expect(tool.toolName).toBe('Read');
      expect(tool.status).toBe('Reading file');
      expect(tool.startedAt).toBe(1000);
    });
  });

  describe('createSession', () => {
    it('creates a session with defaults', () => {
      const sess = createSession('sess-abc');
      expect(sess.sessionId).toBe('sess-abc');
      expect(sess.projectDir).toBeUndefined();
      expect(sess.agentId).toBeUndefined();
    });

    it('creates a session with options', () => {
      const sess = createSession('sess-abc', { projectDir: '/proj', agentId: 1 });
      expect(sess.projectDir).toBe('/proj');
      expect(sess.agentId).toBe(1);
    });
  });

  describe('createAgentTeam', () => {
    it('creates a team with only required fields', () => {
      const team = createAgentTeam('my-team', 'sess-lead');
      expect(team.teamName).toBe('my-team');
      expect(team.leadSessionId).toBe('sess-lead');
      expect(team.members).toEqual([]);
    });

    it('creates a team with members and tmux', () => {
      const team = createAgentTeam('my-team', 'sess-lead', ['researcher', 'coder'], true);
      expect(team.members).toEqual(['researcher', 'coder']);
      expect(team.usesTmux).toBe(true);
    });
  });
});
