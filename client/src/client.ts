/**
 * Client composition: wires the hook endpoint, the session emitter and event
 * delivery into one running emitter.
 *
 *   agent tool ──hook──> claude-hook.js ──POST loopback──> HookEndpoint
 *                                                              │
 *   transcripts ──poll──> SessionEmitter <─────────────────────┘
 *                              │ normalized events
 *                              ▼
 *                        EventDelivery ──POST /api/ingest──> server
 *
 * Renders nothing and serves no UI.
 */

import { INGEST_API_PATH } from '../../core/src/constants.js';
import { NodeFileWatcherAdapter } from './adapters/NodeFileWatcherAdapter.js';
import { NodeTimerAdapter } from './adapters/NodeTimerAdapter.js';
import {
  loadClientConfig,
  loadPersistedSessions,
  saveClientConfig,
  savePersistedSessions,
} from './clientConfig.js';
import { INGEST_REQUEST_TIMEOUT_MS, SHUTDOWN_FLUSH_TIMEOUT_MS } from './constants.js';
import { createHttpTransport, EventDelivery, type IngestTransport } from './delivery.js';
import { DismissalTrackerService } from './dismissalTracker.js';
import { HookEndpoint } from './hookEndpoint.js';
import type { Clock } from './ports/Clock.js';
import { claudeProvider, copyHookScript } from './providers/index.js';
import { SessionEmitter } from './sessionEmitter.js';

export interface ClientOptions {
  serverUrl: string;
  token: string;
  /** Overrides the label stored in client.json. */
  label?: string;
  /** Root that contains dist/ (for the bundled hook script). */
  packageRoot: string;
  /** Workspace whose sessions are tracked (others need "watch all sessions"). */
  workspacePath: string;
  /** Replace the HTTP transport (tests). */
  transport?: IngestTransport;
}

export interface ClientSettings {
  hooksEnabled: boolean;
  watchAllSessions: boolean;
}

export interface RunningClient {
  readonly clientId: string;
  readonly label: string;
  getSettings(): ClientSettings;
  setHooksEnabled(enabled: boolean): Promise<void>;
  setWatchAllSessions(enabled: boolean): void;
  /** Deliver what is queued, say goodbye to the server, and stop. */
  stop(): Promise<void>;
}

const systemClock: Clock = { now: () => Date.now() };

export async function startClient(options: ClientOptions): Promise<RunningClient> {
  const config = loadClientConfig();
  const label = options.label ?? config.label ?? undefined;
  const hooksEnabled = { current: config.hooksEnabled };
  const watchAllSessions = { current: config.watchAllSessions };

  const timers = new NodeTimerAdapter();
  let emitter: SessionEmitter | null = null;

  const delivery = new EventDelivery({
    clientId: config.clientId,
    label,
    transport:
      options.transport ??
      createHttpTransport(
        options.serverUrl,
        options.token,
        INGEST_API_PATH,
        INGEST_REQUEST_TIMEOUT_MS,
      ),
    timers,
    clock: systemClock,
    snapshot: () => emitter?.snapshot() ?? [],
  });

  const persistSessions = (): void => {
    if (emitter) savePersistedSessions(emitter.exportSessions());
  };

  emitter = new SessionEmitter({
    provider: claudeProvider,
    fileWatcher: new NodeFileWatcherAdapter(),
    timers,
    clock: systemClock,
    dismissal: new DismissalTrackerService(),
    emit: (sessionId, origin, event) =>
      delivery.enqueue({ sessionId, origin, ts: systemClock.now(), event }),
    hooksEnabled,
    watchAllSessions,
    onSessionsChanged: persistSessions,
  });
  emitter.restoreSessions(loadPersistedSessions());

  const hookEndpoint = new HookEndpoint((_providerId, payload) => {
    try {
      emitter?.handleHookEvent(payload);
    } catch (err) {
      console.error('[Pixel Agents] Client: failed to process hook event:', err);
    }
  });
  await hookEndpoint.start();

  const installHooks = async (): Promise<void> => {
    try {
      await claudeProvider.installHooks();
      copyHookScript(options.packageRoot);
      console.log('[Pixel Agents] Hooks installed');
    } catch (err) {
      console.error('[Pixel Agents] Failed to install hooks:', err);
    }
  };
  if (hooksEnabled.current) await installHooks();

  delivery.start();
  emitter.start(options.workspacePath);

  return {
    clientId: config.clientId,
    label: label ?? '',
    getSettings: () => ({
      hooksEnabled: hooksEnabled.current,
      watchAllSessions: watchAllSessions.current,
    }),
    async setHooksEnabled(enabled) {
      hooksEnabled.current = enabled;
      saveClientConfig({ ...loadClientConfig(), hooksEnabled: enabled });
      if (enabled) {
        await installHooks();
      } else {
        await claudeProvider.uninstallHooks();
        console.log('[Pixel Agents] Hooks uninstalled');
      }
    },
    setWatchAllSessions(enabled) {
      watchAllSessions.current = enabled;
      saveClientConfig({ ...loadClientConfig(), watchAllSessions: enabled });
    },
    async stop() {
      emitter?.dispose();
      persistSessions();
      await hookEndpoint.stop();
      await delivery.stop(SHUTDOWN_FLUSH_TIMEOUT_MS);
      timers.clearAll();
    },
  };
}
