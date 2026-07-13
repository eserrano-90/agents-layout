import path from 'path';

import { expect, test } from '../../../fixtures/pixel-agents';
import {
  idlePrompt,
  permissionRequest,
  preToolUseBash,
  sendHookEvent,
  sessionEndExit,
  sessionStartStartup,
  stop,
  waitForHookServer,
} from '../../../helpers/hooks';
import { spawnInternalAgentAndWait } from '../../../helpers/internal-agent';
import {
  arrangeNextClaudeInvocation,
  claudeScenario,
  spawnExternalClaudeScenario,
  waitForClaudeHookSetup,
} from '../../../helpers/mock-claude';
import {
  expectOverlayCount,
  expectOverlayVisible,
  expectSingleAgentOverlay,
  getOverlayByAgentId,
} from '../../../helpers/office';
import {
  appendAssistantToolUse,
  appendJsonlRecord,
  buildUserToolResultRecord,
  getClaudeProjectDir,
} from '../../../helpers/team';
import { getPixelAgentsFrame, openPixelAgentsPanel, setSettings } from '../../../helpers/webview';

test.describe('Hooks ON / spawn paths', () => {
  test('internal terminal spawns agent and Task subagent appears then despawns @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('internal terminal basic spawn').build(),
    );
    const spawned = await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    expect(spawned.invocationLog).toContain(`session-id=${spawned.sessionId}`);
    expect(path.basename(spawned.jsonlFile)).toBe(`${spawned.sessionId}.jsonl`);

    const terminalTab = window.getByText(/Claude Code #\d+/);
    await expect(terminalTab.first()).toBeVisible({ timeout: 15_000 });

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    await expectOverlayCount(panelFrame, 1);

    // Sub-character appears on Task tool_use and despawns on tool_result.
    // Task subagent lifecycle is JSONL-driven even in hooks-on mode
    // (transcriptParser routes Task/Agent tool events through JSONL
    // regardless of hookDelivered).
    const taskToolId = 'toolu-subagent-spawn';
    appendAssistantToolUse(spawned.jsonlFile, taskToolId, 'Task', {
      description: 'spawned subtask',
    });
    await expectOverlayCount(panelFrame, 2);
    await expectOverlayVisible(panelFrame, 'Subtask: spawned subtask');

    appendJsonlRecord(spawned.jsonlFile, buildUserToolResultRecord(taskToolId));
    await expectOverlayCount(panelFrame, 1);
  });

  // External hook-driven session adoption.
  //
  // Driven directly from the test via sendHookEvent (not from mock-claude's
  // scheduler) for deterministic timing. The original timer-driven version
  // passed in isolation but flaked reliably under full-suite load: the
  // 200ms/2000ms/3200ms/4400ms/6000ms scheduled emissions slipped, and the
  // test raced to see all 5 effects within fixed wall-clock windows. The
  // teammate-routing tests use this same direct-emission pattern and don't
  // flake.
  test('external Claude session adopted via hook confirmation lifecycle @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, tmpHome, workspaceDir, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await waitForClaudeHookSetup(tmpHome);
    const serverConfig = await waitForHookServer(tmpHome);
    const sessionId = 'external-hook-session';

    // Spawn mock-claude with only autoInit; the test drives every hook below.
    // holdOpenFor(3_000) keeps the process alive briefly so the JSONL it created
    // stays attached during the assertions, then exits before fixture teardown
    // (the fixture's killTrackedExternalProcesses sweep is the fallback safety net).
    await spawnExternalClaudeScenario({
      tmpHome,
      workspaceDir,
      mockLogFile,
      scenario: claudeScenario('external hook-driven session adoption').holdOpenFor(3_000).build(),
      sessionId,
    });

    const projectDir = getClaudeProjectDir(tmpHome, workspaceDir);
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);

    // 1. SessionStart fires. Session is pending (transient filter), no overlay yet.
    await sendHookEvent(serverConfig, sessionStartStartup(sessionId, workspaceDir, transcriptPath));
    await frame.waitForTimeout(500); // give SessionStart time to land before asserting absence
    await expectOverlayCount(frame, 0);

    // 2. PreToolUseBash confirms the session; agent appears with bash status.
    await sendHookEvent(serverConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(frame, 1);
    await expectOverlayVisible(frame, 'Running: npm test');

    // 3. PermissionRequest → "Needs approval"
    await sendHookEvent(serverConfig, permissionRequest(sessionId));
    await expectOverlayVisible(frame, 'Needs approval');

    // 4. Stop → finished turn shows ONLY the checkmark; the label falls back to
    //    idle (no dedicated text), distinct from idle_prompt's "Waiting for input".
    await sendHookEvent(serverConfig, stop(sessionId));
    await expectOverlayVisible(frame, 'Idle');

    // 5. Notification(idle_prompt) → "Waiting for input"
    await sendHookEvent(serverConfig, idlePrompt(sessionId));
    await expectOverlayVisible(frame, 'Waiting for input');

    // 6. SessionEnd(exit) → agent is removed.
    await sendHookEvent(serverConfig, sessionEndExit(sessionId));
    await expectOverlayCount(frame, 0);
  });

  // Fuel gauge + model name were team-only before this feature; this pins
  // that a plain SOLO agent (no team, no teamName) also renders both once its
  // transcript carries a message.model + message.usage record. The scenario
  // appends the assistant record after spawn via the scenario builder (not a
  // hand-fired hook) per the mocking model's process-boundary rule; the
  // server's transcriptParser always extracts model/usage from JSONL
  // (unconditional on hookDelivered), so this is exercised with hooks ON.
  test('solo agent shows fuel gauge and shortened model name @area:spawn', async ({
    pixelAgents,
  }) => {
    const { frame, window, tmpHome, mockLogFile } = pixelAgents;

    await setSettings(frame, {
      watchAllSessions: false,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });

    await arrangeNextClaudeInvocation(
      tmpHome,
      claudeScenario('solo agent model + token usage')
        .at(500)
        .appendJsonl({
          type: 'assistant',
          message: {
            model: 'claude-opus-4-8',
            usage: { input_tokens: 120_000, output_tokens: 5_000 },
            content: [],
          },
        })
        .build(),
    );
    await spawnInternalAgentAndWait(frame, tmpHome, mockLogFile);

    await openPixelAgentsPanel(window);
    const panelFrame = await getPixelAgentsFrame(window);
    const agentId = await expectSingleAgentOverlay(panelFrame);

    // Model line renders as the shortened form ("claude-opus-4-8" -> "opus 4.8").
    await expectOverlayVisible(panelFrame, 'opus 4.8');

    // Fuel gauge: the div whose title reads "<pct>% context used (<k>k tokens)".
    // Before this feature the gauge only rendered for team agents; this agent
    // has no teamName, so its presence here is the whole point of the test.
    const gauge = getOverlayByAgentId(panelFrame, agentId).locator('div[title*="context used"]');
    await expect(gauge).toBeVisible({ timeout: 15_000 });
    await expect(gauge).toHaveAttribute('title', /^\d+% context used \(\d+k tokens\)$/);
  });
});
