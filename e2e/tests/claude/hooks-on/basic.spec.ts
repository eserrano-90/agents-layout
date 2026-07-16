import { expect, test } from '../../../fixtures/standalone';
import {
  idlePrompt,
  permissionRequest,
  preToolUseBash,
  sendHookEvent,
  sessionEndExit,
  sessionStartStartup,
  stop,
} from '../../../helpers/hooks';
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
  createClaudeTranscript,
} from '../../../helpers/team';
import { setSettings } from '../../../helpers/webview';

// DROPPED (VS Code-only, no standalone equivalent):
// - "internal terminal spawns agent" — the "+ Agent" internal-terminal spawn
//   path (spawnInternalAgentAndWait), the invocationLog `session-id=` assertion,
//   the launched-jsonl basename assertion, and the "Claude Code #N" terminal-tab
//   assertion all verify VS Code's terminal-launch mechanism, which does not
//   exist in the standalone CLI (no terminals, no "+ Agent" button; every
//   session is external and hook-driven). The portable half of that test — the
//   JSONL-driven Task sub-character appear/despawn lifecycle — is ported below
//   as "Task subagent appears then despawns", with the session brought up via a
//   hand-created transcript + SessionStart hook instead of an internal spawn.

test.describe('Hooks ON / spawn paths', () => {
  // JSONL-driven sub-character lifecycle. A Task tool_use in the transcript
  // spawns a "Subtask:" sub-character; its matching tool_result despawns it.
  // transcriptParser routes Task/Agent tool events through JSONL regardless of
  // hookDelivered, so this is exercised with hooks ON. The lead session is
  // stood up via a hand-created transcript + SessionStart hook (the documented
  // standalone exception to the no-hand-written-transcript rule), then confirmed
  // by a PreToolUse hook so its overlay renders.
  test('Task subagent appears then despawns @area:spawn', async ({ page, standalone }) => {
    await setSettings(page, {
      watchAllSessions: true,
      hooksEnabled: true,
      alwaysShowLabels: true,
      debugView: false,
    });
    await standalone.drainMessages();

    const sessionId = 'subagent-lifecycle-session';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    // SessionStart only stages a pending session (transient filter); a
    // PreToolUse confirms it and the lead overlay appears.
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    await sendHookEvent(standalone.hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);

    // Sub-character appears on the Task tool_use and despawns on its tool_result.
    const taskToolId = 'toolu-subagent-spawn';
    appendAssistantToolUse(transcriptPath, taskToolId, 'Task', {
      description: 'spawned subtask',
    });
    await expectOverlayCount(page, 2);
    await expectOverlayVisible(page, 'Subtask: spawned subtask');

    appendJsonlRecord(transcriptPath, buildUserToolResultRecord(taskToolId));
    await expectOverlayCount(page, 1);
  });

  // External hook-driven session adoption.
  //
  // Driven directly from the test via sendHookEvent for deterministic timing.
  // The original VS Code version spawned mock-claude only to create the JSONL;
  // here the transcript is hand-created and every lifecycle transition is a
  // sent hook, matching the standalone template's discipline.
  test('external Claude session adopted via hook confirmation lifecycle @area:spawn', async ({
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

    const sessionId = 'external-hook-session';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    // 1. SessionStart fires. Session is pending (transient filter), no overlay yet.
    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    // Settle wait before the negative assertion: SessionStart only stages a
    // pending session, so no overlay should appear. Without the wait,
    // toHaveCount(0) passes instantly just because the overlay has not been
    // created yet, which would not prove SessionStart stays invisible.
    await page.waitForTimeout(500);
    await expectOverlayCount(page, 0);

    // 2. PreToolUseBash confirms the session; agent appears with bash status.
    await sendHookEvent(standalone.hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');

    // 3. PermissionRequest → "Needs approval"
    await sendHookEvent(standalone.hookServerConfig, permissionRequest(sessionId));
    await expectOverlayVisible(page, 'Needs approval');

    // 4. Stop → finished turn shows ONLY the checkmark; the label falls back to
    //    idle (no dedicated text), distinct from idle_prompt's "Waiting for input".
    await sendHookEvent(standalone.hookServerConfig, stop(sessionId));
    await expectOverlayVisible(page, 'Idle');

    // 5. Notification(idle_prompt) → "Waiting for input"
    await sendHookEvent(standalone.hookServerConfig, idlePrompt(sessionId));
    await expectOverlayVisible(page, 'Waiting for input');

    // 6. SessionEnd(exit) → agent is removed.
    await sendHookEvent(standalone.hookServerConfig, sessionEndExit(sessionId));
    await expectOverlayCount(page, 0);
  });

  // Fuel gauge + model name were team-only before this feature; this pins
  // that a plain SOLO agent (no team, no teamName) also renders both once its
  // transcript carries a message.model + message.usage record. The server's
  // transcriptParser always extracts model/usage from JSONL (unconditional on
  // hookDelivered), so this is exercised with hooks ON. The session is stood up
  // via a hand-created transcript + SessionStart/PreToolUse hooks, then the
  // model/usage record is appended to the transcript for the file-watcher.
  test('solo agent shows fuel gauge and shortened model name @area:spawn', async ({
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

    const sessionId = 'solo-agent-session';
    const { transcriptPath } = createClaudeTranscript(
      standalone.tmpHome,
      standalone.workspaceDir,
      sessionId,
    );

    await sendHookEvent(
      standalone.hookServerConfig,
      sessionStartStartup(sessionId, standalone.workspaceDir, transcriptPath),
    );
    await sendHookEvent(standalone.hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    const agentId = await expectSingleAgentOverlay(page);

    // Append an assistant record carrying model + token usage. This is the SOLO
    // agent's only team-independent source of model/usage, so its presence is
    // the whole point of the test.
    appendJsonlRecord(transcriptPath, {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 120_000, output_tokens: 5_000 },
        content: [],
      },
    });

    // Model line renders as the shortened form ("claude-opus-4-8" -> "opus 4.8").
    await expectOverlayVisible(page, 'opus 4.8');

    // Fuel gauge: the div whose title reads "<pct>% context used (<k>k tokens)".
    const gauge = getOverlayByAgentId(page, agentId).locator('div[title*="context used"]');
    await expect(gauge).toBeVisible({ timeout: 15_000 });
    await expect(gauge).toHaveAttribute('title', /^\d+% context used \(\d+k tokens\)$/);
  });
});
