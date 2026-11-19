import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { applyAllureLabels } from '../../helpers/allure-labels';
import {
  preToolUseBash,
  sendHookEvent,
  sessionEndClear,
  sessionStartClear,
  sessionStartStartup,
} from '../../helpers/hooks';
import {
  expectOverlayCount,
  expectOverlayVisible,
  readAgentOverlayIds,
} from '../../helpers/office';
import { launchSplit, type SplitSession } from '../../helpers/split';
import { appendJsonlRecord, createClaudeTranscript } from '../../helpers/team';
import { setSettings } from '../../helpers/webview';

/**
 * Server and client as separate processes with separate home directories:
 * every session the office shows must have travelled over /api/ingest.
 */
test.describe('Standalone / split deployment', () => {
  let split: SplitSession;

  test.beforeEach(async ({ page }, testInfo) => {
    await applyAllureLabels(testInfo);
    split = await launchSplit(page);
  });

  test.afterEach(async ({}, testInfo) => {
    await testInfo.attach('split-logs', { body: split.getLogs(), contentType: 'text/plain' });
    await split.cleanup();
  });

  test('a remote client session shows status, tokens and survives /clear @area:standalone', async ({
    page,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });

    // The server's home never gets a ~/.claude: it cannot read transcripts itself.
    const sessionId = 'split-session-1';
    const { transcriptPath } = createClaudeTranscript(
      split.clientHome,
      split.workspaceDir,
      sessionId,
    );
    await sendHookEvent(
      split.hookServerConfig,
      sessionStartStartup(sessionId, split.workspaceDir, transcriptPath),
    );
    await sendHookEvent(split.hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);
    await expectOverlayVisible(page, 'Running: npm test');
    expect(fs.existsSync(path.join(split.serverHome, '.claude'))).toBe(false);

    // Token usage and model only exist in the transcript on the client machine.
    appendJsonlRecord(transcriptPath, {
      type: 'assistant',
      message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1200, output_tokens: 300 },
        content: [],
      },
    });
    await expectOverlayVisible(page, 'opus');

    // /clear keeps the same character.
    const [idBefore] = await readAgentOverlayIds(page);
    await sendHookEvent(split.hookServerConfig, sessionEndClear(sessionId));
    const next = createClaudeTranscript(split.clientHome, split.workspaceDir, 'split-session-2');
    await sendHookEvent(
      split.hookServerConfig,
      sessionStartClear('split-session-2', split.workspaceDir, next.transcriptPath),
    );
    await sendHookEvent(split.hookServerConfig, preToolUseBash('split-session-2', 'npm run build'));
    await expectOverlayVisible(page, 'Running: npm run build');
    expect(await readAgentOverlayIds(page)).toEqual([idBefore]);
  });

  test('stopping the client removes its agents; a server restart brings them back @area:standalone', async ({
    page,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    const sessionId = 'split-session-restart';
    const { transcriptPath } = createClaudeTranscript(
      split.clientHome,
      split.workspaceDir,
      sessionId,
    );
    await sendHookEvent(
      split.hookServerConfig,
      sessionStartStartup(sessionId, split.workspaceDir, transcriptPath),
    );
    await sendHookEvent(split.hookServerConfig, preToolUseBash(sessionId, 'npm test'));
    await expectOverlayCount(page, 1);

    // Server restart: the client's next heartbeat/batch resyncs with a snapshot.
    await split.restartServer();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });
    await expectOverlayCount(page, 1, 20_000);

    // Clean client shutdown: goodbye removes its agents right away.
    await split.stopClient();
    await expectOverlayCount(page, 0, 5_000);
  });

  test('server-only mode hides client-only settings @area:standalone', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByText('Always Show Labels')).toBeVisible();
    await expect(page.getByText('Instant Detection (Hooks)')).toHaveCount(0);
    await expect(page.getByText('Watch All Sessions')).toHaveCount(0);
  });

  test('a third-party emitter can post contract batches directly @area:standalone', async ({
    page,
  }) => {
    await setSettings(page, { alwaysShowLabels: true });
    // No bundled client involved: hand-built batches with the issued token.
    // (The bundled client already bound this token, so use a fresh one.)
    const res = await fetch(`${split.serverUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${split.token}` },
      body: JSON.stringify({
        protocolVersion: 1,
        clientId: 'third-party',
        seq: 1,
        sentAt: Date.now(),
        events: [],
        snapshot: { sessions: [] },
      }),
    });
    // The token is bound to the bundled client: another identity is refused.
    expect(res.status).toBe(403);

    const thirdPartyToken = issueToken(split, 'third-party');
    const post = (seq: number, events: unknown[], extra: Record<string, unknown> = {}) =>
      fetch(`${split.serverUrl}/api/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${thirdPartyToken}` },
        body: JSON.stringify({
          protocolVersion: 1,
          clientId: 'third-party',
          seq,
          sentAt: seq,
          events,
          ...extra,
        }),
      });

    expect(
      (
        await post(
          1,
          [
            {
              sessionId: 'tp-1',
              origin: 'hook',
              ts: 1,
              event: { kind: 'sessionStart', folderName: 'other-repo' },
            },
            {
              sessionId: 'tp-1',
              origin: 'hook',
              ts: 2,
              event: {
                kind: 'toolStart',
                toolId: 'x1',
                toolName: 'Index',
                statusText: 'Indexing repo',
                activity: 'reading',
                permissionExempt: false,
                spawnsSubagent: false,
              },
            },
          ],
          { snapshot: { sessions: [] } },
        )
      ).status,
    ).toBe(200);
    await expectOverlayVisible(page, 'Indexing repo');
    // Two clients now feed the office, so the agent shows which one it runs on.
    await expectOverlayVisible(page, 'other-repo · third-party');
  });
});

function issueToken(split: SplitSession, label: string): string {
  const out = spawnSync(
    process.execPath,
    [path.join(__dirname, '../../../dist/cli.js'), 'server', 'token', 'add', label],
    {
      env: { ...process.env, HOME: split.serverHome, USERPROFILE: split.serverHome },
      encoding: 'utf-8',
    },
  );
  return out.stdout.trim().split('\n').at(-1)!.trim();
}
