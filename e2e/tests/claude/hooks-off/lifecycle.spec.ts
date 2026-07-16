import fs from 'node:fs';

import { expect, test } from '../../../fixtures/standalone';
import { uniqueTeamName } from '../../../helpers/lifecycle';
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
  readAgentOverlayTexts,
} from '../../../helpers/office';
import {
  appendAssistantToolUse,
  appendJsonlRecord,
  appendTeamMetadata,
  buildAssistantToolUseBatchRecord,
  buildClearCommandRecord,
  buildTeamConfig,
  buildTurnDurationRecord,
  buildUserToolResultBatchRecord,
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
// heuristic JSONL-polling adoption, /clear reassignment, stale cleanup,
// turn_duration clearing, permission timers, sub-agent detection, and team
// config polling — is a server-side, transport-agnostic concern.
//
// This is the "Hooks OFF" suite, so adoption must come from the file-watcher
// POLLER (never from sendHookEvent, which is the hooks path). Each test:
//   1. disables hooks and hand-writes a transcript JSONL into the workspace
//      project dir. The standalone server tracks that dir via the project
//      scanner, and with hooksEnabled=false its poller adopts the file.
//   2. appends records to drive activity; the per-agent poller picks them up.
//   3. for teams, seeds ~/.claude/teams/<name>/config.json and writes teammate
//      transcripts under <projectDir>/<leadSessionId>/subagents/; the project
//      scan discovers them once the lead's teamName is parsed.
// Hand-written transcripts are the documented standalone exception (see
// e2e/README.md "Mocking model & rules").
//
// One test was dropped because it was VS-Code-specific and cannot be
// expressed in standalone: "--resume reassigns the same agent within grace
// via JSONL polling". The VS Code agent manager polls for an expected
// --session-id file that never materializes; standalone has no equivalent
// agent-manager concept (agents are created on discovery, not pre-registered).

const TEAMMATE_ROLE = 'web-researcher';

function otherOverlayId(ids: number[], knownId: number): number {
  const otherId = ids.find((id) => id !== knownId);
  if (otherId === undefined) {
    throw new Error(`Expected an overlay id other than ${knownId}, got ${JSON.stringify(ids)}`);
  }
  return otherId;
}

test.describe('Hooks OFF / lifecycle', () => {
  test('/clear on internal agent reassigns the same character via JSONL polling @area:lifecycle', async ({
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

    // Create the original session transcript. The project scanner discovers
    // it and creates one agent overlay.
    const sessionId = 'hooks-off-clear-reassign';
    const { transcriptPath: originalTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    await expectOverlayCount(page, 1);
    const originalAgentId = await expectSingleAgentOverlay(page);

    // Create a replacement transcript with a /clear command + new tool.
    // The file-watcher detects /clear in the first 8KB and reassigns the
    // existing agent to the new file — same overlay ID is preserved.
    const replacementSessionId = `${sessionId}-clear`;
    const { transcriptPath: replacementTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      replacementSessionId,
    );
    appendJsonlRecord(replacementTranscript, buildClearCommandRecord());
    appendAssistantToolUse(replacementTranscript, 'toolu-b1-fresh', 'Bash', {
      command: 'npm test',
    });

    // Write a stale tool use to the ORIGINAL transcript — it should NOT
    // appear because that session is no longer active after /clear.
    appendAssistantToolUse(originalTranscript, 'toolu-b1-stale', 'Bash', {
      command: 'npm run stale',
    });

    await expectOverlayVisible(page, 'Running: npm test', 12_000);
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    await page.waitForTimeout(1_000);
    await expectNoOverlay(page, 'Running: npm run stale');
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);
  });

  // PORTING NOTE: "--resume reassigns the same agent within grace via JSONL
  // polling" was dropped. The VS Code agent-manager polls for an expected
  // --session-id JSONL at 1Hz; when it doesn't appear after ~10s, it scans
  // the project dir for the newest candidate. Standalone has no equivalent
  // agent-manager or pre-registered session concept — agents are created on
  // discovery by the project scanner. The behavioral equivalent (single agent
  // adopting whatever transcript appears in the project dir) is already
  // covered by all adoption-based tests here and in matrix.spec.ts.

  test('/clear edge case with a sibling agent in the same projectDir via JSONL polling @area:lifecycle', async ({
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

    // Create the sibling session transcript — one agent appears.
    const siblingSessionId = 'hooks-off-sibling';
    const { transcriptPath: siblingTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      siblingSessionId,
    );
    appendAssistantToolUse(siblingTranscript, 'toolu-b2-sibling', 'Bash', {
      command: 'npm run sibling',
    });
    await expectOverlayCount(page, 1);
    const siblingAgentId = await expectSingleAgentOverlay(page);

    // Create a second "clearer" session transcript — second agent appears.
    // This is the agent whose session will be replaced by /clear.
    const clearTargetSessionId = 'hooks-off-clear-target';
    const { transcriptPath: clearTargetTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      clearTargetSessionId,
    );

    // Create the /clear replacement for the clearer session and write new
    // tool content. The server detects /clear and reassigns the clearer
    // agent to this file.
    const clearReplacementSessionId = `${clearTargetSessionId}-clear`;
    const { transcriptPath: clearReplacementTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      clearReplacementSessionId,
    );
    appendJsonlRecord(clearReplacementTranscript, buildClearCommandRecord());
    appendAssistantToolUse(clearReplacementTranscript, 'toolu-b2-fresh', 'Bash', {
      command: 'npm run cleared',
    });

    // Write a stale tool to the clearer's ORIGINAL transcript — replaced
    // session should not pick this up.
    appendAssistantToolUse(clearTargetTranscript, 'toolu-b2-stale', 'Bash', {
      command: 'npm run stale',
    });

    await expectOverlayCount(page, 2, 12_000);
    const clearingAgentId = otherOverlayId(await readAgentOverlayIds(page), siblingAgentId);

    await expectOverlayVisibleForAgent(page, clearingAgentId, 'Running: npm run cleared');
    await expectNoOverlay(page, 'Running: npm run stale');
    const overlayTexts = await readAgentOverlayTexts(page);
    const siblingOverlay = overlayTexts.find(({ id }) => id === siblingAgentId);
    expect(siblingOverlay).toBeDefined();
    expect(siblingOverlay?.text).not.toContain('npm run cleared');
    expect(siblingOverlay?.text).not.toContain('npm run stale');
    expect([...(await readAgentOverlayIds(page)).sort((a, b) => a - b)]).toEqual([
      siblingAgentId,
      clearingAgentId,
    ]);
  });

  test('stale cleanup followed by new session adoption via JSONL polling @area:lifecycle', async ({
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

    // Create an external-like session transcript and let the server adopt it.
    const oldSessionId = 'stale-cleanup-old-session';
    const { transcriptPath: oldTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      oldSessionId,
    );
    appendAssistantToolUse(oldTranscript, 'toolu-b4-before', 'Bash', {
      command: 'npm run before-resume',
    });
    await expectOverlayVisible(page, 'Running: npm run before-resume');
    const oldAgentId = await expectSingleAgentOverlay(page);

    // Delete the transcript to simulate the session ending. After the next
    // stale check (30s interval) the agent is cleaned up.
    fs.unlinkSync(oldTranscript);
    await expectOverlayCount(page, 0, 45_000);

    // Create a new session transcript with fresh content. A new agent with a
    // different ID should appear.
    const newSessionId = 'stale-cleanup-new-session';
    const { transcriptPath: newTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      newSessionId,
    );
    appendAssistantToolUse(newTranscript, 'toolu-b4-late', 'Bash', {
      command: 'npm run late-resume',
    });
    await expectOverlayVisible(page, 'Running: npm run late-resume', 12_000);
    const [newAgentId] = await readAgentOverlayIds(page);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);
  });

  test('three parallel Task subagents in one turn render distinct sub-characters via polling @area:lifecycle', async ({
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

    const sessionId = 'hooks-off-three-tasks';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    // Three parallel Task tool_uses in one assistant turn.
    appendJsonlRecord(
      transcriptPath,
      buildAssistantToolUseBatchRecord([
        {
          toolId: 'toolu-b5-parent-1',
          toolName: 'Task',
          input: { description: 'Parallel task 1' },
        },
        {
          toolId: 'toolu-b5-parent-2',
          toolName: 'Task',
          input: { description: 'Parallel task 2' },
        },
        {
          toolId: 'toolu-b5-parent-3',
          toolName: 'Task',
          input: { description: 'Parallel task 3' },
        },
      ]),
    );

    await expectOverlayVisible(page, 'Subtask: Parallel task 3');
    await expectOverlayVisible(page, 'Parallel task 1');
    await expectOverlayVisible(page, 'Parallel task 2');
    await expectOverlayVisible(page, 'Parallel task 3');
    await expectOverlayCount(page, 4, 10_000);
    expect(await readAgentOverlayIds(page)).toHaveLength(4);

    // Complete all three tasks with tool_results + turn_duration.
    appendJsonlRecord(
      transcriptPath,
      buildUserToolResultBatchRecord([
        { toolUseId: 'toolu-b5-parent-1' },
        { toolUseId: 'toolu-b5-parent-2' },
        { toolUseId: 'toolu-b5-parent-3' },
      ]),
    );
    appendJsonlRecord(transcriptPath, buildTurnDurationRecord());

    await expectOverlayCount(page, 1, 16_000);
  });

  test('inline teammate removed from team config disappears within one second via polling @area:lifecycle', async ({
    page,
    standalone,
  }) => {
    const teamName = uniqueTeamName('teammate-removal-hooks-off');
    const configPath = seedTeamConfig(standalone.tmpHome, teamName, [
      'lead',
      TEAMMATE_ROLE,
    ]);

    await setSettings(page, {
      watchAllSessions: false,
      hooksEnabled: false,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const leadSessionId = 'hooks-off-teammate-removal';
    const { projectDir, transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      leadSessionId,
    );

    // Lead adopts alone first, then team metadata flips it to a LEAD.
    await expectOverlayCount(page, 1);
    appendTeamMetadata(transcriptPath, teamName);
    await expectOverlayVisibleWithTexts(page, ['lead']);

    // PORTING NOTE (mock-claude session aliases dropped): the original test
    // used withInlineTeammateSession to set up a mock-claude teammate session
    // via the scenario builder. In standalone, createTeammateTranscript
    // achieves the same: it writes a transcript + sidecar metadata under
    // <projectDir>/<leadSessionId>/subagents/, which the project scanner
    // discovers and renders as an inline teammate overlay.

    // Inline teammate appears.
    const teammateTranscript = createTeammateTranscript(
      projectDir,
      leadSessionId,
      `agent-${TEAMMATE_ROLE}`,
      teamName,
      TEAMMATE_ROLE,
    );
    await expectOverlayVisibleWithTexts(page, [TEAMMATE_ROLE], 10_000);
    await expectOverlayCount(page, 2, 10_000);

    // Teammate becomes active with a tool.
    appendAssistantToolUse(teammateTranscript, 'toolu-b6-teammate-search', 'WebSearch', {
      query: 'pixel agents lifecycle regressions',
    });
    await expectOverlayVisible(page, 'Searching the web');

    // Remove teammate from team config. The 1s team-config polling detects
    // the change and removes the teammate overlay.
    fs.writeFileSync(configPath, JSON.stringify(buildTeamConfig(['lead']), null, 2));
    await expectOverlayCount(page, 1, 12_000);
    await expectNoOverlayWithTexts(page, [TEAMMATE_ROLE], 2_000);

    // Stability check (heuristic mode): after the 1s team-config polling
    // removes the teammate, ensure it stays removed under continued polling.
    await page.waitForTimeout(8_000);
    await expectOverlayCount(page, 1);
    await expectNoOverlayWithTexts(page, [TEAMMATE_ROLE], 2_000);
  });

  test('rapid /clear then new tool within 500ms lands on the reassigned agent via polling @area:lifecycle', async ({
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

    const sessionId = 'hooks-off-rapid-clear';
    const { transcriptPath: originalTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    await expectOverlayCount(page, 1);
    const originalAgentId = await expectSingleAgentOverlay(page);

    // Replacement session with /clear + new tool written in rapid succession
    // (both written before the next scanner tick, so the server sees the new
    // file as a /clear session atomically).
    const replacementSessionId = `${sessionId}-clear-fast`;
    const { transcriptPath: replacementTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      replacementSessionId,
    );
    appendJsonlRecord(replacementTranscript, buildClearCommandRecord());
    appendAssistantToolUse(replacementTranscript, 'toolu-b11-fresh', 'Bash', {
      command: 'npm run fresh',
    });

    // Ghost tool on the old transcript — should be ignored.
    appendAssistantToolUse(originalTranscript, 'toolu-b11-ghost', 'Bash', {
      command: 'npm run ghost',
    });

    await expectOverlayVisible(page, 'Running: npm run fresh', 12_000);
    await expectOverlayCount(page, 1);
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);

    await page.waitForTimeout(1_000);
    await expectNoOverlay(page, 'Running: npm run ghost');
    expect(await readAgentOverlayIds(page)).toEqual([originalAgentId]);
  });

  test('close via X prevents re-adoption of old JSONL during dismissal cooldown via polling @area:lifecycle', async ({
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

    // Create an external-like session with initial activity.
    const oldSessionId = 'dismissal-cooldown-old-session';
    const { transcriptPath: oldTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      oldSessionId,
    );
    appendAssistantToolUse(oldTranscript, 'toolu-b12-old-live', 'Bash', {
      command: 'npm run old-live',
    });

    await expectOverlayVisible(page, 'Running: npm run old-live');
    const oldAgentId = await expectSingleAgentOverlay(page);
    await closeAgentFromOverlay(page, { agentId: oldAgentId });
    await expectOverlayCount(page, 0, 8_000);

    // Second transcript with fresh content — should adopt as a new agent.
    const newSessionId = 'dismissal-cooldown-new-session';
    const { transcriptPath: newTranscript } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      newSessionId,
    );
    appendAssistantToolUse(newTranscript, 'toolu-b12-new-live', 'Bash', {
      command: 'npm run reopened',
    });

    await expectOverlayVisible(page, 'Running: npm run reopened', 12_000);
    await expectOverlayCount(page, 1);
    const [newAgentId] = await readAgentOverlayIds(page);
    expect(newAgentId).toBeDefined();
    expect(newAgentId).not.toBe(oldAgentId);

    // Write stale content to the old dismissed transcript. Under dismissal
    // cooldown the old JSONL should NOT be re-adopted.
    appendAssistantToolUse(oldTranscript, 'toolu-b12-old-stale', 'Bash', {
      command: 'npm run old-stale',
    });

    // Stability check (heuristic mode): cover several external scanner ticks
    // (3s interval) to ensure the dismissed JSONL is not re-adopted.
    await page.waitForTimeout(8_000);
    await expectNoOverlay(page, 'Running: npm run old-stale', 2_000);
    await expectOverlayCount(page, 1);
  });

  test('external basic subagent with run_in_background but no teamName routes to basic path @area:lifecycle', async ({
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

    // Heuristic-mode mirror of the hooks-on external-background-subagent
    // case: external session with an Agent tool_use that carries
    // run_in_background=true but the lead has NO teamName. The regression
    // case is misrouting this to the teammate path, which would produce an
    // extra "general-purpose" teammate overlay alongside the basic Subtask
    // sub-character.
    const sessionId = 'external-basic-background-subagent';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    appendAssistantToolUse(transcriptPath, 'toolu-b8-off-agent', 'Agent', {
      description: 'Background basic subtask',
      run_in_background: true,
    });

    // External scanner runs on a 3s interval, so external adoption is bounded
    // by ~3s for the JSONL to be picked up + JSONL polling time for the tool_use.
    await expectOverlayVisible(page, 'Subtask: Background basic subtask', 20_000);
    await expectOverlayCount(page, 1, 10_000);
    await expectNoOverlay(page, 'general-purpose', 2_000);

    // Complete the agent task + emit turn_duration to clean up.
    appendJsonlRecord(transcriptPath, buildUserToolResultRecord('toolu-b8-off-agent'));
    appendJsonlRecord(transcriptPath, buildTurnDurationRecord());

    // Stability check: ensure no late-fire misroutes the subagent as a teammate.
    await page.waitForTimeout(5_000);
    await expectOverlayCount(page, 1);
    await expectNoOverlay(page, 'general-purpose', 2_000);
  });

  test('agentToolsClear fires at turn end via turn_duration JSONL record @area:cross-cutting', async ({
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

    // Cross-cutting invariant: when a turn ends (turn_duration record), all
    // active tool overlays must clear back to "Idle". The test runs in
    // hooks-off so it exercises the JSONL parser path.
    const sessionId = 'hooks-off-turn-end';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    appendAssistantToolUse(transcriptPath, 'toolu-c4-bash', 'Bash', { command: 'npm test' });

    // First the active overlay should show the bash command.
    await expectOverlayVisible(page, 'Running: npm test', 8_000);

    // Tool result + turn_duration → overlay must revert to "Idle".
    appendJsonlRecord(transcriptPath, buildUserToolResultRecord('toolu-c4-bash'));
    appendJsonlRecord(transcriptPath, buildTurnDurationRecord());
    await expectOverlayVisible(page, 'Idle', 8_000);
    await expectNoOverlay(page, 'Running: npm test', 2_000);
  });

  // Heuristic permission and text-idle timers are cancelled when an agent
  // is closed via the overlay X.
  //
  // Invariant: closing an agent must cancel its in-flight 7s permission and
  // 5s text-idle heuristic timers. If a timer fires after close and the
  // server unconditionally broadcasts agentToolPermission (or
  // agentStatus: waiting) for the gone agent, the webview's handler runs
  // playPermissionSound() / playDoneSound() (see
  // webview-ui/src/hooks/useExtensionMessages.ts), which our
  // notificationSound.ts instrumentation records in
  // window.__pixelAgentsTestHooks.playedSounds.
  //
  // This catches "hard" leaks (broadcast despite missing agent). "Soft" leaks
  // (timer fires but its callback no-ops because internal state is gone) are
  // invisible from the webview — they require server instrumentation and are
  // out of scope here.
  test('heuristic permission timer is cancelled when an agent is closed via overlay @area:cross-cutting', async ({
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

    // Create an external-like session with a Bash tool — the non-exempt tool
    // starts a heuristic permission timer. The test verifies the timer is
    // cancelled when we close the agent.
    const sessionId = 'heuristic-timer-cancellation';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );
    appendAssistantToolUse(transcriptPath, 'toolu-c7', 'Bash', {
      command: 'npm test',
    });

    await expectOverlayCount(page, 1, 12_000);
    await expectOverlayVisible(page, 'Running: npm test');
    const [agentId] = await readAgentOverlayIds(page);

    await closeAgentFromOverlay(page, { agentId });
    await expectOverlayCount(page, 0, 8_000);

    // Reset AFTER close so only post-close sounds count as leaks.
    await page.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: unknown[] };
      };
      if (w.__pixelAgentsTestHooks) w.__pixelAgentsTestHooks.playedSounds = [];
    });

    // Wait longer than the 7s permission timer + cushion. If a timer leaked,
    // the broadcast lands during this window.
    await page.waitForTimeout(9_000);

    await expectOverlayCount(page, 0);
    const playedKinds = await page.evaluate(() => {
      const w = window as Window & {
        __pixelAgentsTestHooks?: { playedSounds?: Array<{ kind: string }> };
      };
      return (w.__pixelAgentsTestHooks?.playedSounds ?? []).map((s) => s.kind);
    });
    expect(playedKinds).not.toContain('permission');
    expect(playedKinds).not.toContain('done');
  });

  // Sub-agent permission bubble fires when a sub-agent runs a non-exempt
  // tool with no follow-up data for ~5s. The heuristic permission timer is
  // active for sub-agents in hooks-OFF mode (same path as parent agents).
  //
  // Trigger sequence:
  // 1. Parent agent does Task tool_use -> sub-character appears.
  // 2. A progress record arrives with a sub-agent tool_use for a non-exempt
  //    tool (Bash). transcriptParser registers the sub-tool and starts the
  //    permission timer.
  // 3. ~5s with no further sub-agent data -> permission bubble appears on
  //    both parent and sub-character.
  test('sub-agent permission bubble fires on stalled non-exempt sub-tool via heuristic timer @area:cross-cutting', async ({
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

    const parentToolId = 'toolu-c14-task';
    const subToolId = 'toolu-c14-bash-sub';
    const sessionId = 'hooks-off-sub-permission-bubble';

    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    // Parent Task tool_use → sub-character appears.
    appendAssistantToolUse(transcriptPath, parentToolId, 'Task', {
      description: 'permission subtask',
    });

    // PORTING NOTE (spawned.sessionId dropped): the original test captured
    // the return of spawnInternalAgentAndWait to assert spawned.sessionId.
    // In standalone there is no spawn call — the transcript is hand-written.
    // The session is valid by construction.

    // Sub-character appears once the Task tool_use is parsed.
    await expectOverlayCount(page, 2, 12_000);
    await expectOverlayVisible(page, 'Subtask: permission subtask');

    // Progress record with sub-agent Bash tool_use starts the permission timer.
    appendJsonlRecord(transcriptPath, {
      type: 'progress',
      parentToolUseID: parentToolId,
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: subToolId,
                name: 'Bash',
                input: { command: 'npm test' },
              },
            ],
          },
        },
      },
    });

    // The "Subtask: permission subtask" overlay resolves the moment the Task
    // tool_use is parsed, but the heuristic permission timer only starts when
    // the sub-tool tool_use lands in the progress record. The timer is
    // PERMISSION_TIMER_DELAY_MS (7s), and broadcast-to-DOM takes another
    // ~300ms (transport + React render). So this wait must cover: sub-tool
    // record gap + 7s timer + slop.
    await expectOverlayVisible(page, 'Needs approval', 10_000);
  });
});
