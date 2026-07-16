import type { Page } from '@playwright/test';

import { test } from '../../../fixtures/standalone';
import { uniqueTeamName } from '../../../helpers/lifecycle';
import {
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisible,
  expectOverlayVisibleWithTexts,
} from '../../../helpers/office';
import {
  appendAssistantToolUse,
  appendJsonlRecord,
  appendTeamMetadata,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
  createClaudeTranscript,
  createTeammateTranscript,
  seedTeamConfig,
} from '../../../helpers/team';
import { setSettings } from '../../../helpers/webview';

// PORTING NOTE (VS Code Electron harness -> standalone browser harness):
//
// The original suite spawned "internal" leads through the VS Code "+ Agent"
// terminal (spawnInternalAgentAndWait) and "external" leads through mock-claude
// on PATH (spawnExternalClaudeScenario). Both mechanisms are VS-Code/terminal
// specific and have no standalone equivalent, but the behavior they exercised —
// heuristic JSONL-polling adoption and Lead+Teammate routing — is a server-side,
// transport-agnostic concern.
//
// This is the "Hooks OFF" suite, so adoption must come from the file-watcher
// POLLER (never from sendHookEvent, which is the hooks path). Each test:
//   1. disables hooks and hand-writes a transcript JSONL into the workspace
//      project dir (getClaudeProjectDir(tmpHome, workspaceDir)/<sessionId>.jsonl).
//      The standalone server tracks that dir (startProjectScan/startExternalScanning),
//      and with hooksEnabled=false its 3s external scanner adopts the file.
//   2. appends records to drive activity; the per-agent poller picks them up.
//   3. for teams, seeds ~/.claude/teams/<name>/config.json and writes teammate
//      transcripts under <projectDir>/<sessionId>/subagents/; the 1s project scan
//      discovers them once the lead's teamName is parsed from its transcript.
// Hand-written transcripts are the documented standalone exception (see
// e2e/README.md "Mocking model & rules").
//
// Both "internal" cases are re-expressed as JSONL-in-workspace adoption (same as
// external, since standalone has no terminal); the internal/external distinction
// is preserved via the Watch All Sessions setting (internal: off, external: on).
//
// NO tests were dropped: none of the original assertions depended on the terminal
// surface itself — they all assert on overlays/labels via the office helpers,
// which work identically against a browser Page.

const TEAMMATE_ROLE = 'web-researcher';
const TEAMMATE_SLUG = `agent-${TEAMMATE_ROLE}`;

async function expectLeadActivity(page: Page, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(page, ['LEAD', text]);
  await expectNoOverlayWithTexts(page, [TEAMMATE_ROLE, text]);
}

async function expectTeammateActivity(page: Page, text: string): Promise<void> {
  await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE, text]);
  await expectNoOverlayWithTexts(page, ['LEAD', text]);
}

test.describe('Hooks OFF / matrix', () => {
  test('internal basic spawn adopted via JSONL polling @area:matrix', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const sessionId = 'hooks-off-internal-basic-session';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    // Poller adopts the freshly-written transcript from the tracked workspace
    // project dir (no hooks, no terminal): a single lead overlay appears.
    await expectOverlayCount(page, 1);

    // A within-turn Task subtask spawns and completes; the lead is left standing.
    appendAssistantToolUse(transcriptPath, 'toolu-internal-basic-task', 'Task', {
      description: 'Delegate research',
    });
    appendJsonlRecord(transcriptPath, buildUserToolResultRecord('toolu-internal-basic-task'));
    appendJsonlRecord(transcriptPath, buildTurnDurationRecord());

    // Stability check: after the subtask lifecycle settles, only the lead remains.
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 1);
  });

  test('internal inline teammate adopted via JSONL polling @area:matrix', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const teamName = uniqueTeamName('hooks-off-internal-inline');
    const sessionId = 'hooks-off-internal-inline-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await expectOverlayCount(page, 1);

    // Team metadata in the lead transcript flips it to a LEAD (parsed by poller).
    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    // Inline teammate: its transcript + sidecar under subagents/ is discovered by
    // the periodic project scan now that the lead has a teamName.
    const teammateTranscript = createTeammateTranscript(
      projectDir,
      sessionId,
      TEAMMATE_SLUG,
      teamName,
      TEAMMATE_ROLE,
    );
    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    appendAssistantToolUse(transcriptPath, 'toolu-internal-inline-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(page, 'Running: npm test');

    appendAssistantToolUse(teammateTranscript, 'toolu-internal-inline-teammate-search', 'WebSearch', {
      query: 'pixel agents',
    });
    await expectTeammateActivity(page, 'Searching the web');
  });

  test('internal tmux teammate adopted via JSONL polling @area:matrix', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const teamName = uniqueTeamName('hooks-off-internal-tmux');
    const sessionId = 'hooks-off-internal-tmux-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await expectOverlayCount(page, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    // Background Agent spawn (run_in_background: true) marks the team as tmux-mode
    // and surfaces as the lead's own "Subtask:" status — NOT a ghost sub-character.
    appendAssistantToolUse(transcriptPath, 'toolu-internal-tmux-team-spawn', 'Agent', {
      description: 'Delegate research',
      run_in_background: true,
    });
    await expectLeadActivity(page, 'Subtask: Delegate research');

    createTeammateTranscript(projectDir, sessionId, TEAMMATE_SLUG, teamName, TEAMMATE_ROLE);
    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    appendAssistantToolUse(transcriptPath, 'toolu-internal-tmux-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(page, 'Running: npm test');
  });

  test('external basic spawn adopted via JSONL polling @area:matrix', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const sessionId = 'hooks-off-external-basic-session';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    await expectOverlayCount(page, 1);

    appendAssistantToolUse(transcriptPath, 'toolu-external-basic-task', 'Task', {
      description: 'External research',
    });
    await expectOverlayVisible(page, 'Subtask: External research');
    await expectOverlayCount(page, 2);

    appendJsonlRecord(transcriptPath, buildUserToolResultRecord('toolu-external-basic-task'));
    appendJsonlRecord(transcriptPath, buildTurnDurationRecord());
    await expectOverlayCount(page, 1);
  });

  test('external inline teammate adopted via JSONL polling @area:matrix', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const teamName = uniqueTeamName('hooks-off-external-inline');
    const sessionId = 'hooks-off-external-inline-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await expectOverlayCount(page, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    const teammateTranscript = createTeammateTranscript(
      projectDir,
      sessionId,
      TEAMMATE_SLUG,
      teamName,
      TEAMMATE_ROLE,
    );
    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    appendAssistantToolUse(transcriptPath, 'toolu-external-inline-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(page, 'Running: npm test');

    appendAssistantToolUse(teammateTranscript, 'toolu-external-inline-teammate-search', 'WebSearch', {
      query: 'pixel agents',
    });
    await expectTeammateActivity(page, 'Searching the web');
  });

  test('external tmux teammate adopted via JSONL polling @area:matrix', async ({
    page,
    standalone,
  }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const teamName = uniqueTeamName('hooks-off-external-tmux');
    const sessionId = 'hooks-off-external-tmux-session';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    seedTeamConfig(standalone.tmpHome, teamName, ['lead', TEAMMATE_ROLE]);

    await expectOverlayCount(page, 1);

    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['LEAD']);

    appendAssistantToolUse(transcriptPath, 'toolu-external-tmux-team-spawn', 'Agent', {
      description: 'Delegate research',
      run_in_background: true,
    });
    await expectLeadActivity(page, 'Subtask: Delegate research');

    createTeammateTranscript(projectDir, sessionId, TEAMMATE_SLUG, teamName, TEAMMATE_ROLE);
    await expectOverlayCount(page, 2);
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE]);

    appendAssistantToolUse(transcriptPath, 'toolu-external-tmux-lead-bash', 'Bash', {
      command: 'npm test',
    });
    await expectLeadActivity(page, 'Running: npm test');
  });
});
