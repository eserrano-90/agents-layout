import fs from 'fs';
import path from 'path';

import { expect, test } from '../../../fixtures/standalone';
import {
  idlePrompt,
  notificationPermissionPrompt,
  permissionRequest,
  preToolUseAgent,
  preToolUseBash,
  sendHookEvent,
  sessionEndClear,
  sessionEndExit,
  sessionEndResume,
  sessionStartClear,
  sessionStartResume,
  sessionStartStartup,
  subagentStart,
  teammateIdle,
} from '../../../helpers/hooks';
import {
  INLINE_TEAMMATE_ROLE,
  uniqueTeamName,
  inlineTeammateSlug,
} from '../../../helpers/lifecycle';
import {
  closeAgentFromOverlay,
  expectNoOverlay,
  expectNoOverlayWithTexts,
  expectOverlayCount,
  expectOverlayVisible,
  expectOverlayVisibleForAgent,
  expectOverlayVisibleWithTexts,
  expectSingleAgentOverlay,
  readAgentOverlayIds,
} from '../../../helpers/office';
import {
  buildAssistantToolUseBatchRecord,
  buildAssistantToolUseRecord,
  buildTeamConfig,
  buildTeamMetadataRecord,
  buildTurnDurationRecord,
  buildUserToolResultBatchRecord,
  buildUserToolResultRecord,
  createClaudeTranscript,
  createTeammateTranscript,
  getClaudeProjectDir,
  seedTeamConfig,
  appendJsonlRecord,
} from '../../../helpers/team';
import {
  getSettingChecked,
  setSettings,
} from '../../../helpers/webview';

const PARALLEL_PARENT_TOOL_ID = 'toolu-b5-parent';
const SECOND_TEAMMATE_ROLE = 'reviewer';

function otherOverlayId(ids: number[], knownId: number): number {
  const otherId = ids.find((id) => id !== knownId);
  if (otherId === undefined) {
    throw new Error(`Expected an overlay id other than ${knownId}, got ${JSON.stringify(ids)}`);
  }
  return otherId;
}

test.describe('Hooks ON / lifecycle', () => {
  test('/clear on internal agent reassigns the same character to the new JSONL @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const sessionId = 'clear-reassignment-hooks-on';
    const replacementSessionId = `${sessionId}-clear`;

    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(sessionId, 'npm test'));

    const originalAgentId = await expectSingleAgentOverlay(page);
    await expectOverlayVisible(page, 'Running: npm test');
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    // Simulate /clear
    await sendHookEvent(hookServerConfig, sessionEndClear(sessionId));

    const { transcriptPath: replacementPath } = createClaudeTranscript(
      tmpHome,
      workspaceDir,
      replacementSessionId,
    );
    await sendHookEvent(
      hookServerConfig,
      sessionStartClear(replacementSessionId, workspaceDir, replacementPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(replacementSessionId, 'npm test'));

    await expectOverlayVisible(page, 'Running: npm test');
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    await page.waitForTimeout(500);
    await expectNoOverlay(page, 'Running: npm run stale');
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);
  });

  test('--resume reassigns the same agent within the grace window @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const sessionId = 'resume-reassignment-hooks-on';
    const replacementSessionId = `${sessionId}-resume`;

    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(sessionId, 'npm test'));

    const originalAgentId = await expectSingleAgentOverlay(page);
    await expectOverlayVisible(page, 'Running: npm test');
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    // Simulate --resume
    await sendHookEvent(hookServerConfig, sessionEndResume(sessionId));

    const { transcriptPath: replacementPath } = createClaudeTranscript(
      tmpHome,
      workspaceDir,
      replacementSessionId,
    );
    await sendHookEvent(
      hookServerConfig,
      sessionStartResume(replacementSessionId, workspaceDir, replacementPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(replacementSessionId, 'npm test'));

    await expectOverlayVisible(page, 'Running: npm test');
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    // Settling wait: give the runtime a chance to wrongly attach the stale tool
    // to the resumed agent before asserting absence.
    await page.waitForTimeout(500);
    await expectNoOverlay(page, 'Running: npm run stale');

    // Wait past the 2s resume grace window for the new tool to take effect.
    // expectOverlayVisible polls until the assertion holds; bumping the timeout
    // covers grace expiry + post-grace tool propagation.
    await expectOverlayVisible(page, 'Running: npm test', 5_000);
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);
  });

  test('/clear edge case with a sibling agent in the same projectDir @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const internalSessionId = 'clear-edge-internal-hooks-on';
    const replacementSessionId = `${internalSessionId}-clear`;
    const siblingSessionId = 'sibling-clear-edge-hooks-on';

    const { transcriptPath: internalPath } = createClaudeTranscript(
      tmpHome,
      workspaceDir,
      internalSessionId,
    );

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(internalSessionId, workspaceDir, internalPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(internalSessionId, 'npm test'));

    const internalAgentId = await expectSingleAgentOverlay(page);
    await expectOverlayVisible(page, 'Running: npm test');

    // Simulate /clear on the internal agent
    await sendHookEvent(hookServerConfig, sessionEndClear(internalSessionId));

    const { transcriptPath: replacementPath } = createClaudeTranscript(
      tmpHome,
      workspaceDir,
      replacementSessionId,
    );
    await sendHookEvent(
      hookServerConfig,
      sessionStartClear(replacementSessionId, workspaceDir, replacementPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(replacementSessionId, 'npm run cleared'));

    // Create sibling session
    const { transcriptPath: siblingPath } = createClaudeTranscript(
      tmpHome,
      workspaceDir,
      siblingSessionId,
    );
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(siblingSessionId, workspaceDir, siblingPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(siblingSessionId, 'npm run sibling'));

    await expectOverlayCount(page, 2, 12_000);
    const externalAgentId = otherOverlayId(await readAgentOverlayIds(page), internalAgentId);

    await expectOverlayVisibleForAgent(page, externalAgentId, 'Running: npm run sibling');
    await expectOverlayVisibleForAgent(page, internalAgentId, 'Running: npm run cleared', 12_000);
    await expectNoOverlay(page, 'Running: npm run stale');
    expect(await readAgentOverlayIds(page)).toEqual([internalAgentId, externalAgentId]);
  });

  test('--resume after the grace window expires cleans up the old agent @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const oldSessionId = 'late-resume-old-session-hooks-on';
    const newSessionId = 'late-resume-new-session-hooks-on';

    const { transcriptPath: oldPath } = createClaudeTranscript(tmpHome, workspaceDir, oldSessionId);

    // Create old session and drive it active
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(oldSessionId, workspaceDir, oldPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(oldSessionId, 'npm run before-resume'));

    await expectOverlayVisible(page, 'Running: npm run before-resume');
    const oldAgentId = await expectSingleAgentOverlay(page);

    // Resume with a new session
    await sendHookEvent(hookServerConfig, sessionEndResume(oldSessionId));

    const { transcriptPath: newPath } = createClaudeTranscript(tmpHome, workspaceDir, newSessionId);
    await sendHookEvent(
      hookServerConfig,
      sessionStartResume(newSessionId, workspaceDir, newPath),
    );

    // Wait past the 2s resume grace window
    await page.waitForTimeout(2_500);

    await sendHookEvent(hookServerConfig, preToolUseBash(newSessionId, 'npm run late-resume'));

    await expectOverlayCount(page, 0, 8_000);
    await expectOverlayVisible(page, 'Running: npm run late-resume', 10_000);
    const [newAgentId] = await readAgentOverlayIds(page);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);
  });

  test('three parallel Task subagents in one turn render distinct sub-characters @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const sessionId = 'parallel-subagents-hooks-on';

    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    // Register the agent
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );

    // Write parallel Task tool_use records to JSONL for subagent detection
    appendJsonlRecord(
      transcriptPath,
      buildAssistantToolUseBatchRecord([
        {
          toolId: `${PARALLEL_PARENT_TOOL_ID}-1`,
          toolName: 'Task',
          input: { description: 'Parallel task 1' },
        },
        {
          toolId: `${PARALLEL_PARENT_TOOL_ID}-2`,
          toolName: 'Task',
          input: { description: 'Parallel task 2' },
        },
        {
          toolId: `${PARALLEL_PARENT_TOOL_ID}-3`,
          toolName: 'Task',
          input: { description: 'Parallel task 3' },
        },
      ]),
    );

    // Allow file watcher to pick up the records
    await page.waitForTimeout(1_500);

    await expectOverlayVisible(page, 'Subtask: Parallel task 3');
    await expectOverlayVisible(page, 'Parallel task 1');
    await expectOverlayVisible(page, 'Parallel task 2');
    await expectOverlayVisible(page, 'Parallel task 3');
    await expectOverlayCount(page, 4, 10_000);
    expect(await readAgentOverlayIds(page)).toHaveLength(4);

    // Write tool results to resolve all three tasks
    appendJsonlRecord(
      transcriptPath,
      buildUserToolResultBatchRecord([
        { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-1` },
        { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-2` },
        { toolUseId: `${PARALLEL_PARENT_TOOL_ID}-3` },
      ]),
    );
    appendJsonlRecord(transcriptPath, buildTurnDurationRecord());

    await expectOverlayCount(page, 1, 16_000);
  });

  test('inline teammate removed from team config disappears within one second @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const teamName = uniqueTeamName('teammate-removal-hooks-on');
    const configPath = seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const sessionId = 'teammate-removal-lead-hooks-on';
    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    // Register lead with team metadata
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );
    appendJsonlRecord(transcriptPath, buildTeamMetadataRecord(teamName));

    // Create teammate transcript with team metadata
    createTeammateTranscript(
      getClaudeProjectDir(tmpHome, workspaceDir),
      sessionId,
      inlineTeammateSlug(INLINE_TEAMMATE_ROLE),
      teamName,
      INLINE_TEAMMATE_ROLE,
    );

    // Write tool_use for teammate for the watcher to pick up
    const teammateTranscriptPath = path.join(
      getClaudeProjectDir(tmpHome, workspaceDir),
      sessionId,
      'subagents',
      `${inlineTeammateSlug(INLINE_TEAMMATE_ROLE)}.jsonl`,
    );
    appendJsonlRecord(
      teammateTranscriptPath,
      buildAssistantToolUseRecord('toolu-b6-teammate-search', 'WebSearch', {
        query: 'pixel agents lifecycle regressions',
      }),
    );

    // Allow file watcher to detect teammate
    await page.waitForTimeout(1_500);

    await expectOverlayVisibleWithTexts(page, [INLINE_TEAMMATE_ROLE], 10_000);
    await expectOverlayVisible(page, 'Searching the web');
    await expectOverlayCount(page, 2, 10_000);

    // Remove teammate from config
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig(['lead']), null, 2));

    await expectOverlayCount(page, 1, 12_000);
    await expectNoOverlayWithTexts(page, [INLINE_TEAMMATE_ROLE], 2_000);

    // Stability check: after cascade removal, the teammate must not reappear
    await page.waitForTimeout(8_000);
    await expectOverlayCount(page, 1);
    await expectNoOverlayWithTexts(page, [INLINE_TEAMMATE_ROLE], 2_000);
  });

  test('lead SessionEnd cascade-removes active inline teammates @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const teamName = uniqueTeamName('lead-cascade-hooks-on');

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE, SECOND_TEAMMATE_ROLE]);

    const leadSessionId = 'lead-cascade-session-hooks-on';
    const { transcriptPath: leadPath } = createClaudeTranscript(tmpHome, workspaceDir, leadSessionId);

    // Register lead
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(leadSessionId, workspaceDir, leadPath),
    );
    await sendHookEvent(
      hookServerConfig,
      preToolUseAgent(leadSessionId, 'Delegate teammates'),
    );

    // Write team metadata
    appendJsonlRecord(leadPath, buildTeamMetadataRecord(teamName));

    // Create teammate transcripts
    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    createTeammateTranscript(
      projectDir,
      leadSessionId,
      inlineTeammateSlug(INLINE_TEAMMATE_ROLE),
      teamName,
      INLINE_TEAMMATE_ROLE,
    );
    createTeammateTranscript(
      projectDir,
      leadSessionId,
      inlineTeammateSlug(SECOND_TEAMMATE_ROLE),
      teamName,
      SECOND_TEAMMATE_ROLE,
    );

    // Write tool_use records for teammates
    const firstTeammatePath = path.join(
      projectDir,
      leadSessionId,
      'subagents',
      `${inlineTeammateSlug(INLINE_TEAMMATE_ROLE)}.jsonl`,
    );
    appendJsonlRecord(
      firstTeammatePath,
      buildAssistantToolUseRecord('toolu-b7-search', 'WebSearch', {
        query: 'pixel agents cascade removal',
      }),
    );

    const secondTeammatePath = path.join(
      projectDir,
      leadSessionId,
      'subagents',
      `${inlineTeammateSlug(SECOND_TEAMMATE_ROLE)}.jsonl`,
    );
    appendJsonlRecord(
      secondTeammatePath,
      buildAssistantToolUseRecord('toolu-b7-review', 'Bash', {
        command: 'npm run review',
      }),
    );

    // Send subagentStart for teammates
    await sendHookEvent(
      hookServerConfig,
      subagentStart(leadSessionId, INLINE_TEAMMATE_ROLE),
    );

    // Allow watcher to detect teammate activity
    await page.waitForTimeout(2_000);

    await expectOverlayCount(page, 3, 12_000);
    await expectOverlayVisibleWithTexts(page, [INLINE_TEAMMATE_ROLE]);
    await expectOverlayVisibleWithTexts(page, [SECOND_TEAMMATE_ROLE]);

    // End lead session - should cascade-remove teammates
    await sendHookEvent(hookServerConfig, sessionEndExit(leadSessionId));

    await expectOverlayCount(page, 0, 8_000);
  });

  test('external basic subagent with run_in_background routes to basic path @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const sessionId = 'external-background-subagent-hooks-on';
    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    // Register agent
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );
    await sendHookEvent(
      hookServerConfig,
      preToolUseAgent(sessionId, 'Background basic subtask'),
    );

    // Write Agent tool_use with run_in_background=true to JSONL
    appendJsonlRecord(
      transcriptPath,
      buildAssistantToolUseRecord('toolu-b8-agent', 'Agent', {
        description: 'Background basic subtask',
        run_in_background: true,
      }),
    );
    await sendHookEvent(
      hookServerConfig,
      subagentStart(sessionId, 'general-purpose'),
    );

    // Allow file watcher to detect Agent tool usage
    await page.waitForTimeout(1_500);

    await expectOverlayVisible(page, 'Subtask: Background basic subtask');
    await expectOverlayCount(page, 1, 10_000);
    await expectNoOverlay(page, 'general-purpose', 2_000);

    // Write tool result to resolve the background agent
    appendJsonlRecord(transcriptPath, buildUserToolResultRecord('toolu-b8-agent'));
    appendJsonlRecord(transcriptPath, buildTurnDurationRecord());

    // Wait for resolution + stability check
    await page.waitForTimeout(5_000);
    await expectOverlayCount(page, 1);
  });

  test('lead permission_prompt routes bubble to teammate not lead when teammates exist @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const teamName = uniqueTeamName('teammate-permission-hooks-on');

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE]);

    const leadSessionId = 'teammate-permission-session-hooks-on';
    const { transcriptPath: leadPath } = createClaudeTranscript(tmpHome, workspaceDir, leadSessionId);

    // Register lead
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(leadSessionId, workspaceDir, leadPath),
    );
    await sendHookEvent(
      hookServerConfig,
      preToolUseAgent(leadSessionId, 'Delegate teammate work'),
    );

    appendJsonlRecord(leadPath, buildTeamMetadataRecord(teamName));

    // Create teammate transcript
    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    createTeammateTranscript(
      projectDir,
      leadSessionId,
      inlineTeammateSlug(INLINE_TEAMMATE_ROLE),
      teamName,
      INLINE_TEAMMATE_ROLE,
    );

    // Write tool_use for teammate
    const teammatePath = path.join(
      projectDir,
      leadSessionId,
      'subagents',
      `${inlineTeammateSlug(INLINE_TEAMMATE_ROLE)}.jsonl`,
    );
    appendJsonlRecord(
      teammatePath,
      buildAssistantToolUseRecord('toolu-b9-search', 'WebSearch', {
        query: 'permission routing',
      }),
    );

    await sendHookEvent(
      hookServerConfig,
      subagentStart(leadSessionId, INLINE_TEAMMATE_ROLE),
    );

    // Allow watcher to detect teammate
    await page.waitForTimeout(2_000);

    await expectOverlayVisibleWithTexts(page, [INLINE_TEAMMATE_ROLE], 12_000);

    // Send notification permission prompt - should route to teammate
    await sendHookEvent(
      hookServerConfig,
      notificationPermissionPrompt(leadSessionId),
    );

    await expectOverlayVisibleWithTexts(page, [INLINE_TEAMMATE_ROLE, 'Needs approval'], 8_000);
    await expectNoOverlayWithTexts(page, ['LEAD', 'Needs approval']);
    await expectNoOverlayWithTexts(page, [INLINE_TEAMMATE_ROLE, 'Needs approval'], 8_000);
  });

  test('TeammateIdle marks the targeted teammate waiting and leaves lead unchanged @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const teamName = uniqueTeamName('targeted-teammate-idle-hooks-on');

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    seedTeamConfig(tmpHome, teamName, ['lead', INLINE_TEAMMATE_ROLE, SECOND_TEAMMATE_ROLE]);

    const leadSessionId = 'targeted-teammate-idle-session-hooks-on';
    const { transcriptPath: leadPath } = createClaudeTranscript(tmpHome, workspaceDir, leadSessionId);

    // Register lead
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(leadSessionId, workspaceDir, leadPath),
    );
    await sendHookEvent(
      hookServerConfig,
      preToolUseAgent(leadSessionId, 'Delegate teammates'),
    );

    appendJsonlRecord(leadPath, buildTeamMetadataRecord(teamName));

    // Create teammate transcripts
    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    createTeammateTranscript(
      projectDir,
      leadSessionId,
      inlineTeammateSlug(INLINE_TEAMMATE_ROLE),
      teamName,
      INLINE_TEAMMATE_ROLE,
    );
    createTeammateTranscript(
      projectDir,
      leadSessionId,
      inlineTeammateSlug(SECOND_TEAMMATE_ROLE),
      teamName,
      SECOND_TEAMMATE_ROLE,
    );

    // Write tool_use records for both teammates
    const firstTeammatePath = path.join(
      projectDir,
      leadSessionId,
      'subagents',
      `${inlineTeammateSlug(INLINE_TEAMMATE_ROLE)}.jsonl`,
    );
    appendJsonlRecord(
      firstTeammatePath,
      buildAssistantToolUseRecord('toolu-b10-search', 'WebSearch', {
        query: 'specific teammate idle',
      }),
    );

    const secondTeammatePath = path.join(
      projectDir,
      leadSessionId,
      'subagents',
      `${inlineTeammateSlug(SECOND_TEAMMATE_ROLE)}.jsonl`,
    );
    appendJsonlRecord(
      secondTeammatePath,
      buildAssistantToolUseRecord('toolu-b10-review', 'Bash', {
        command: 'npm run reviewer',
      }),
    );

    await sendHookEvent(
      hookServerConfig,
      subagentStart(leadSessionId, INLINE_TEAMMATE_ROLE),
    );

    // Allow watcher to detect teammate activity
    await page.waitForTimeout(2_000);

    await expectOverlayCount(page, 3, 12_000);
    await expectOverlayVisibleWithTexts(page, [INLINE_TEAMMATE_ROLE, 'Running: npm run reviewer']);

    // Send TeammateIdle for just the first teammate
    await sendHookEvent(
      hookServerConfig,
      teammateIdle(leadSessionId, INLINE_TEAMMATE_ROLE),
    );

    await expectOverlayVisibleWithTexts(page, [INLINE_TEAMMATE_ROLE, 'Waiting for input'], 8_000);
    await expectNoOverlayWithTexts(page, [SECOND_TEAMMATE_ROLE, 'Waiting for input']);
    await expectNoOverlayWithTexts(page, ['LEAD', 'Waiting for input']);
  });

  test('rapid /clear then new tool within 500ms lands on the reassigned agent @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;
    const sessionId = 'rapid-clear-hooks-on';
    const replacementSessionId = `${sessionId}-clear-fast`;

    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(sessionId, 'npm test'));

    const originalAgentId = await expectSingleAgentOverlay(page);
    await expectOverlayVisible(page, 'Running: npm test');
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    // Rapid /clear: end old session, create replacement, send new tool
    await sendHookEvent(hookServerConfig, sessionEndClear(sessionId));

    const { transcriptPath: replacementPath } = createClaudeTranscript(
      tmpHome,
      workspaceDir,
      replacementSessionId,
    );
    await sendHookEvent(
      hookServerConfig,
      sessionStartClear(replacementSessionId, workspaceDir, replacementPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(replacementSessionId, 'npm run fresh'));

    await expectOverlayVisible(page, 'Running: npm run fresh');
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    await page.waitForTimeout(750);
    await expectNoOverlay(page, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);
  });

  test('close via X prevents re-adoption of old JSONL during dismissal cooldown @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    // Create first (old) session
    const oldSessionId = 'dismissal-cooldown-old-session-hooks-on';
    let { transcriptPath: oldPath } = createClaudeTranscript(tmpHome, workspaceDir, oldSessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(oldSessionId, workspaceDir, oldPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(oldSessionId, 'npm run old-live'));

    await expectOverlayVisible(page, 'Running: npm run old-live');
    const oldAgentId = await expectSingleAgentOverlay(page);
    await closeAgentFromOverlay(page, { agentId: oldAgentId });
    await expectOverlayCount(page, 0, 8_000);

    // Create second (new) session — should adopt a new agent
    const newSessionId = 'dismissal-cooldown-new-session-hooks-on';
    const { transcriptPath: newPath } = createClaudeTranscript(tmpHome, workspaceDir, newSessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(newSessionId, workspaceDir, newPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(newSessionId, 'npm run reopened'));

    await expectOverlayVisible(page, 'Running: npm run reopened', 10_000);
    await expectOverlayCount(page, 1);
    const [newAgentId] = await readAgentOverlayIds(page);
    expect(newAgentId).not.toBe(oldAgentId);

    // Stability check: the closed JSONL must NOT be re-adopted during the 3-min
    // cooldown. 4s is enough to cover several scanner ticks.
    await page.waitForTimeout(4_000);
    await expectNoOverlay(page, 'Running: npm run old-stale', 2_000);
    await expectOverlayCount(page, 1);
  });

  test('done sound chime fires on agentStatus waiting @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const sessionId = 'done-chime-session';
    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    // SessionStart registers the session with the hook server so that the next
    // event (PreToolUseBash) drives the agent visible.
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );

    // Drive the agent active first
    await sendHookEvent(hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');

    // Reset the marker AFTER active-state dispatch so we only capture sounds
    // triggered by the idle_prompt under test.
    await page.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    await sendHookEvent(hookServerConfig, idlePrompt(sessionId));
    await expectOverlayVisible(page, 'Waiting for input');

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as Window & {
              __pixelAgentsTestHooks?: { playedSounds?: Array<{ kind: string }> };
            };
            return (w.__pixelAgentsTestHooks?.playedSounds ?? []).map((s) => s.kind);
          }),
        { timeout: 5_000 },
      )
      .toContain('done');
  });

  test('restored agents skip the matrix spawn animation @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;

    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const sessionId = 'restored-agents-hooks-on';
    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    // Create an agent via hooks
    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );

    await expectOverlayCount(page, 1);

    // Let the original spawn animation finish so we don't confuse it with
    // the post-restore observation (matrix effect lives ~300ms; 800ms cushion).
    await page.waitForTimeout(800);

    // Reload the page to trigger a fresh webview boot → existingAgents restore
    await page.reload();
    // Wait for the SPA to boot (settings button is the known ready signal)
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });

    // The fresh webview has an empty addAgentLog. Wait until restoreAgents has
    // run (existingAgents → layoutLoaded → addAgent), then read the log.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as Window & {
              __pixelAgentsTestHooks?: { addAgentLog?: unknown[] };
            };
            return w.__pixelAgentsTestHooks?.addAgentLog?.length ?? 0;
          }),
        { timeout: 15_000 },
      )
      .toBeGreaterThan(0);

    const log = await page.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: {
          addAgentLog?: Array<{
            id: number;
            skipSpawnEffect: boolean | undefined;
            matrixEffectAtCreation: string | null;
          }>;
        };
      };
      return w.__pixelAgentsTestHooks?.addAgentLog ?? [];
    });

    // Every addAgent call in this fresh webview comes from the restore path.
    // Each must have skipSpawnEffect=true and matrixEffect=null at creation.
    expect(log.length).toBeGreaterThan(0);
    for (const entry of log) {
      expect(entry.skipSpawnEffect).toBe(true);
      expect(entry.matrixEffectAtCreation).toBeNull();
    }
  });

  test('tool status text matches every PreToolUse tool name @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const sessionId = 'tool-status-matrix-session';
    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );

    // Drive the agent visible with a Bash tool first
    await sendHookEvent(hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');

    type ToolCase = { toolName: string; toolInput: Record<string, unknown>; expectedText: string };
    const cases: ToolCase[] = [
      { toolName: 'Read', toolInput: { file_path: '/x/foo.ts' }, expectedText: 'Reading foo.ts' },
      { toolName: 'Edit', toolInput: { file_path: '/x/bar.ts' }, expectedText: 'Editing bar.ts' },
      { toolName: 'Write', toolInput: { file_path: '/x/baz.ts' }, expectedText: 'Writing baz.ts' },
      { toolName: 'Glob', toolInput: { pattern: '**/*.ts' }, expectedText: 'Searching files' },
      { toolName: 'Grep', toolInput: { pattern: 'foo' }, expectedText: 'Searching code' },
      {
        toolName: 'WebFetch',
        toolInput: { url: 'https://x' },
        expectedText: 'Fetching web content',
      },
    ];

    for (const c of cases) {
      // PostToolUse clears any prior tool's overlay
      await sendHookEvent(hookServerConfig, {
        session_id: sessionId,
        hook_event_name: 'PostToolUse',
      });
      await sendHookEvent(hookServerConfig, {
        session_id: sessionId,
        hook_event_name: 'PreToolUse',
        tool_name: c.toolName,
        tool_input: c.toolInput,
      });
      await expectOverlayVisible(page, c.expectedText);
    }

    await sendHookEvent(hookServerConfig, sessionEndExit(sessionId));
    await expectOverlayCount(page, 0);
  });

  test('permission sound chime fires on agentToolPermission @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const sessionId = 'permission-chime-session';
    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);

    // Reset the marker right before the action under test
    await page.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    await sendHookEvent(hookServerConfig, permissionRequest(sessionId));
    await expectOverlayVisible(page, 'Needs approval');

    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const w = window as Window & {
              __pixelAgentsTestHooks?: { playedSounds?: Array<{ kind: string }> };
            };
            return (w.__pixelAgentsTestHooks?.playedSounds ?? []).map((s) => s.kind);
          }),
        { timeout: 5_000 },
      )
      .toContain('permission');
  });

  function readClaudeSettings(tmpHome: string): {
    hooks?: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
  } {
    const p = path.join(tmpHome, '.claude', 'settings.json');
    if (!fs.existsSync(p)) return {};
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return {};
    }
  }

  function pixelAgentsHookPresent(
    settings: ReturnType<typeof readClaudeSettings>,
    eventName: string,
  ): boolean {
    const entries = settings.hooks?.[eventName] ?? [];
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes('claude-hook.js') || h.command?.includes('pixel-agents-hook.js')) {
          return true;
        }
      }
    }
    return false;
  }

  function thirdPartyHookPresent(
    settings: ReturnType<typeof readClaudeSettings>,
    eventName: string,
    marker: string,
  ): boolean {
    const entries = settings.hooks?.[eventName] ?? [];
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command?.includes(marker)) return true;
      }
    }
    return false;
  }

  test('pixel-agents hook is installed in settings.json on extension startup @area:cross-cutting', async ({
    standalone,
  }) => {
    await standalone.drainMessages();
    const { tmpHome } = standalone;

    // In standalone mode, the hook installer runs at startup so the hooks
    // should be present in settings.json.
    const settings = readClaudeSettings(tmpHome);

    expect(pixelAgentsHookPresent(settings, 'SessionStart')).toBe(true);
    expect(pixelAgentsHookPresent(settings, 'PreToolUse')).toBe(true);
  });

  test('hook install and uninstall round-trip via the Settings toggle @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    const { tmpHome } = standalone;

    expect(pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse')).toBe(true);

    // Uninstall: toggle hooks off.
    await setSettings(page, { hooksEnabled: false });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(false);

    // Reinstall: toggle hooks back on.
    await setSettings(page, { hooksEnabled: true });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(true);

    // No duplication: exactly one pixel-agents entry across all PreToolUse hooks.
    const settings = readClaudeSettings(tmpHome);
    const preTool = settings.hooks?.['PreToolUse'] ?? [];
    const pixelAgentsCount = preTool.reduce((acc, entry) => {
      return (
        acc +
        (entry.hooks ?? []).filter(
          (h) =>
            h.command?.includes('claude-hook.js') || h.command?.includes('pixel-agents-hook.js'),
        ).length
      );
    }, 0);
    expect(pixelAgentsCount).toBe(1);
  });

  test('permission bubble auto-clears when a fresh PreToolUse arrives @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { hookServerConfig, tmpHome, workspaceDir } = standalone;

    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    const sessionId = 'permission-bubble-clear-session';
    const { transcriptPath } = createClaudeTranscript(tmpHome, workspaceDir, sessionId);

    await sendHookEvent(
      hookServerConfig,
      sessionStartStartup(sessionId, workspaceDir, transcriptPath),
    );
    await sendHookEvent(hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');

    await sendHookEvent(hookServerConfig, permissionRequest(sessionId));
    await expectOverlayVisible(page, 'Needs approval');

    // Fresh PreToolUse without permissionActive should clear the bubble
    await sendHookEvent(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PostToolUse',
    });
    await sendHookEvent(hookServerConfig, {
      session_id: sessionId,
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: '/x/foo.ts' },
    });
    await expectOverlayVisible(page, 'Reading foo.ts');
    await expectNoOverlay(page, 'Needs approval', 2_000);
  });

  test('settings toggles persist across a webview reload @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    // Read whatever the fixture default is, then flip it.
    const initial = await getSettingChecked(page, 'Always Show Labels');
    await setSettings(page, { alwaysShowLabels: !initial });
    expect(await getSettingChecked(page, 'Always Show Labels')).toBe(!initial);

    // Force a fresh webview by reloading the page (equivalent to closing and
    // reopening the VS Code panel).
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });

    // After settingsLoaded re-hydrates, the toggle must still be in the
    // flipped state.
    expect(await getSettingChecked(page, 'Always Show Labels')).toBe(!initial);
  });

  test('layout editor enter paint save persist and exit round-trip @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();

    const { tmpHome } = standalone;

    const layoutPath = path.join(tmpHome, '.pixel-agents', 'layout.json');

    let initialLayout = '';
    if (fs.existsSync(layoutPath)) {
      initialLayout = fs.readFileSync(layoutPath, 'utf8');
    }

    // Dismiss any first-run tooltips that overlay the top toolbar.
    for (const tooltipText of ['Instant Detection Active', 'Updated to v']) {
      const tooltip = page.locator('div', { hasText: tooltipText }).first();
      if (await tooltip.isVisible().catch(() => false)) {
        const closeBtn = tooltip.locator('button', { hasText: 'x' }).first();
        if (await closeBtn.isVisible().catch(() => false)) {
          await closeBtn.click().catch(() => {});
        }
      }
    }

    // Enter edit mode.
    const layoutButton = page.locator('button', { hasText: 'Layout' });
    await expect(layoutButton).toBeVisible({ timeout: 15_000 });
    await layoutButton.click();

    // Editor toolbar should reveal at least one tool button.
    const paintFloorBtn = page.locator('button[title="Paint floor tiles"]');
    await expect(paintFloorBtn).toBeVisible({ timeout: 10_000 });
    await paintFloorBtn.click();

    // Click the canvas center to paint a tile and mark layout dirty.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas has no bounding box');
    await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });

    // EditActionBar appears only when isDirty=true. Save button is part of it.
    const saveBtn = page.locator('button', { hasText: 'Save' });
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
    await saveBtn.click();

    // Wait until layout.json reflects a change.
    await expect
      .poll(
        () => {
          if (!fs.existsSync(layoutPath)) return false;
          return fs.readFileSync(layoutPath, 'utf8') !== initialLayout;
        },
        { timeout: 10_000 },
      )
      .toBe(true);

    // Exit edit mode and confirm the editor button disappears.
    await layoutButton.click();
    await expect(paintFloorBtn).toBeHidden({ timeout: 5_000 });
  });

  test('hook uninstall preserves a pre-existing third-party hook entry @area:cross-cutting', async ({
    page,
    standalone,
  }) => {
    await standalone.drainMessages();
    const { tmpHome } = standalone;

    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');

    // Inject a third-party hook entry alongside our install.
    const THIRD_PARTY_MARKER = '/usr/local/bin/third-party-hook.js';
    const settings = readClaudeSettings(tmpHome);
    if (!settings.hooks) settings.hooks = {};
    if (!settings.hooks['PreToolUse']) settings.hooks['PreToolUse'] = [];
    settings.hooks['PreToolUse'].push({
      matcher: '',
      hooks: [{ command: THIRD_PARTY_MARKER }],
    });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    // Sanity: both entries present before uninstall.
    let now = readClaudeSettings(tmpHome);
    expect(pixelAgentsHookPresent(now, 'PreToolUse')).toBe(true);
    expect(thirdPartyHookPresent(now, 'PreToolUse', THIRD_PARTY_MARKER)).toBe(true);

    // Uninstall via Settings toggle.
    await setSettings(page, { hooksEnabled: false });
    await expect
      .poll(() => pixelAgentsHookPresent(readClaudeSettings(tmpHome), 'PreToolUse'), {
        timeout: 5_000,
      })
      .toBe(false);

    // The third-party hook must still be there.
    now = readClaudeSettings(tmpHome);
    expect(thirdPartyHookPresent(now, 'PreToolUse', THIRD_PARTY_MARKER)).toBe(true);
  });

});
