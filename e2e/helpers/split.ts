import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

import { type HookServerConfig, waitForHookServer } from './hooks';

/**
 * Split deployment harness: a server-only process and a client-only process,
 * each with its OWN home directory, so the server provably cannot see the
 * client's ~/.claude. They only meet over HTTP (/api/ingest).
 *
 * Like standalone/hooks.spec.ts, there is no terminal to host a mocked
 * `claude`, so tests drive the client's loopback hook endpoint directly.
 */

const REPO_ROOT = path.join(__dirname, '../..');
const CLI = path.resolve(REPO_ROOT, 'dist', 'cli.js');

export interface SplitSession {
  serverHome: string;
  clientHome: string;
  workspaceDir: string;
  serverUrl: string;
  token: string;
  hookServerConfig: HookServerConfig;
  getLogs: () => string;
  /** Stop the client with SIGINT (clean shutdown: goodbye to the server). */
  stopClient: () => Promise<void>;
  /** Kill and restart the server on the same port and home. */
  restartServer: () => Promise<void>;
  cleanup: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stop(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill(signal);
  await Promise.race([
    new Promise<void>((r) => child.once('exit', () => r())),
    new Promise<void>((r) => setTimeout(r, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

export async function launchSplit(page: Page): Promise<SplitSession> {
  if (!fs.existsSync(CLI)) throw new Error(`CLI not built at ${CLI}. Run 'npm run compile'.`);
  const serverHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-split-server-home-'));
  const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-split-client-home-'));
  // realpath: on macOS tmpdir is a symlink (/var -> /private/var) and the
  // client derives its project dir from process.cwd(), which is resolved.
  const workspaceDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-split-workspace-')),
  );
  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  let logs = '';
  const capture = (name: string, child: ChildProcessWithoutNullStreams) => {
    child.stdout.on('data', (c) => (logs += `[${name}] ${c}`));
    child.stderr.on('data', (c) => (logs += `[${name}] ${c}`));
  };

  // Issue a client token in the SERVER's home.
  const issued = spawnSync(process.execPath, [CLI, 'server', 'token', 'add', 'e2e-laptop'], {
    env: { ...process.env, HOME: serverHome, USERPROFILE: serverHome },
    encoding: 'utf-8',
  });
  const token = issued.stdout.trim().split('\n').at(-1)!.trim();

  const startServerProcess = () => {
    const child = spawn(process.execPath, [CLI, 'server', '--port', String(port)], {
      cwd: workspaceDir,
      env: { ...process.env, HOME: serverHome, USERPROFILE: serverHome },
      stdio: 'pipe',
    });
    capture('server', child);
    return child;
  };
  let server = startServerProcess();

  const client = spawn(
    process.execPath,
    [CLI, 'client', '--server', serverUrl, '--token', token, '--label', 'e2e-laptop'],
    {
      cwd: workspaceDir,
      env: { ...process.env, HOME: clientHome, USERPROFILE: clientHome },
      stdio: 'pipe',
    },
  );
  capture('client', client);

  const cleanupDirs = () => {
    for (const d of [serverHome, clientHome, workspaceDir])
      fs.rmSync(d, { recursive: true, force: true });
  };

  try {
    await waitForHealth(serverUrl);
    const hookServerConfig = await waitForHookServer(clientHome);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E = true;
    });
    await page.goto(`${serverUrl}/`);
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 });

    return {
      serverHome,
      clientHome,
      workspaceDir,
      serverUrl,
      token,
      hookServerConfig,
      getLogs: () => logs,
      stopClient: () => stop(client, 'SIGINT'),
      restartServer: async () => {
        await stop(server, 'SIGKILL');
        server = startServerProcess();
        await waitForHealth(serverUrl);
      },
      cleanup: async () => {
        await stop(client, 'SIGTERM');
        await stop(server, 'SIGTERM');
        cleanupDirs();
      },
    };
  } catch (error) {
    await stop(client, 'SIGKILL');
    await stop(server, 'SIGKILL');
    cleanupDirs();
    throw error;
  }
}
