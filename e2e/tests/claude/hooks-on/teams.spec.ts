import type { Page } from '@playwright/test';

import { test } from '../../../fixtures/standalone';
import {
  permissionRequest,
  preToolUseAgent,
  preToolUseBash,
  sendHookEvent,
  sessionStartStartup,
  subagentStart,
} from '../../../helpers/hooks';
import { uniqueTeamName } from '../../../helpers/lifecycle';
import {
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisibleWithTexts,
} from '../../../helpers/office';
import {
  appendAssistantToolUse,
  appendTeamMetadata,
  createClaudeTranscript,
  createTeammateTranscript,
  seedTeamConfig,
} from '../../../helpers/team';
import { setSettings } from '../../../helpers/webview';

// PORTING NOTE: the two "internal terminal lead" tests originally spawned the
// lead via the VS Code "+ Agent" terminal (spawnInternalAgentAndWait). That
// spawn mechanism is VS-Code-only and has no standalone equivalent, but the
// teammate-routing behavior it exercised is server-side and transport-agnostic.
// Both internal tests are re-expressed here as hook-driven sessions (SessionStart
// with a transcript_path, then a PreToolUse to surface the lead overlay), which
// is the same adoption path the standalone harness uses for external sessions.
// No test was dropped: none of the original assertions depended on the terminal
// surface itself — they only assert on overlays/labels via office helpers.

const TEAMMATE_ROLE = 'web-researcher';

async function expectLeadActivity(page: Page, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(page, ['LEAD', text]);
  await expectNoOverlayWithTexts(page, [TEAMMATE_ROLE, text]);
}

async function expectTeammateActivity(page: Page, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE, text]);
  await expectNoOverlayWithTexts(page, ['LEAD', text]);
}

test.describe('Hooks ON / teams', () => {
  test('hook-driven lead with inline teammate routes tools to teammate @area:teams', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const serverConfig = standalone.hookServerConfig;
    const sessionId = 'hooks-on-inline-teammate-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    const teamName = uniqueTeamName('hooks-on-inline');
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await sendHookEvent(
      serverConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    // Settle wait before the negative assertion: SessionStart only stages a
    // pending session, so no overlay should appear until a tool runs.
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 0);

    await sendHookEvent(serverConfig, preToolUseAgent(sessionId, 'Delegate research'));
    await expectOverlayCount(page, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    const teammateTranscript = createTeammateTranscript(
      projectDir,
      sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, subagentStart(sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    appendAssistantToolUse(transcriptPath, 'toolu-inline-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(page, 'Running: npm test');

    appendAssistantToolUse(teammateTranscript, 'toolu-inline-teammate-search', 'WebSearch', {
      query: 'pixel agents',
    });
    await expectTeammateActivity(page, 'Searching the web');
  });

  test('hook-driven lead with tmux teammate routes tools to teammate @area:teams', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const serverConfig = standalone.hookServerConfig;
    const sessionId = 'hooks-on-tmux-teammate-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    const teamName = uniqueTeamName('hooks-on-tmux');
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await sendHookEvent(
      serverConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    await sendHookEvent(serverConfig, preToolUseAgent(sessionId, 'Delegate research'));
    await expectOverlayCount(page, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    appendAssistantToolUse(transcriptPath, 'toolu-tmux-team-spawn', 'Agent', {
      description: 'Delegate research',
      run_in_background: true,
    });
    await expectLeadActivity(page, 'Subtask: Delegate research');

    createTeammateTranscript(
      projectDir,
      sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, subagentStart(sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectLeadActivity(page, 'Running: npm test');

    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectLeadActivity(page, 'Needs approval');
  });

  test('external session lead with inline teammate routes tools to teammate @area:teams', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const serverConfig = standalone.hookServerConfig;
    const sessionId = 'hooks-on-external-inline-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    const teamName = uniqueTeamName('hooks-on-external-inline');
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await sendHookEvent(
      serverConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 0);

    await sendHookEvent(serverConfig, preToolUseAgent(sessionId, 'Delegate research'));
    await expectOverlayCount(page, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    const teammateTranscript = createTeammateTranscript(
      projectDir,
      sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, subagentStart(sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    appendAssistantToolUse(transcriptPath, 'toolu-a9-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(page, 'Running: npm test');

    appendAssistantToolUse(teammateTranscript, 'toolu-a9-teammate-search', 'WebSearch', {
      query: 'pixel agents',
    });
    await expectTeammateActivity(page, 'Searching the web');
  });

  test('external session lead with tmux teammate routes tools to teammate @area:teams', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const serverConfig = standalone.hookServerConfig;
    const sessionId = 'hooks-on-external-tmux-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    const teamName = uniqueTeamName('hooks-on-external-tmux');
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await sendHookEvent(
      serverConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    await sendHookEvent(serverConfig, preToolUseAgent(sessionId, 'Delegate research'));
    await expectOverlayCount(page, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    appendAssistantToolUse(transcriptPath, 'toolu-a11-team-spawn', 'Agent', {
      description: 'Delegate research',
      run_in_background: true,
    });
    await expectLeadActivity(page, 'Subtask: Delegate research');

    createTeammateTranscript(
      projectDir,
      sessionId,
      'agent-web-researcher',
      teamName,
      TEAMMATE_ROLE,
    );

    await sendHookEvent(serverConfig, subagentStart(sessionId, TEAMMATE_ROLE));

    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectLeadActivity(page, 'Running: npm test');

    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectLeadActivity(page, 'Needs approval');
  });
});
