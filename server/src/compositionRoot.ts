import { AgentRuntime } from './agentRuntime.js';
import { AgentStateStore } from './agentStateStore.js';
import { BroadcastService } from './application/services/BroadcastService.js';
import { DismissalTrackerService } from './application/services/DismissalTrackerService.js';
import { FileScanningService } from './application/services/FileScanningService.js';
import { HookRoutingService } from './application/services/HookRoutingService.js';
import { SessionManagementService } from './application/services/SessionManagementService.js';
import { TranscriptProcessingService } from './application/services/TranscriptProcessingService.js';
import type { AssetCache } from './clientMessageHandler.js';
import { DailyUsageTracker } from './dailyUsageTracker.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { NodeFileWatcherAdapter } from './infrastructure/adapters/NodeFileWatcherAdapter.js';
import { NodeTimerAdapter } from './infrastructure/adapters/NodeTimerAdapter.js';
import { SystemClockAdapter } from './infrastructure/adapters/SystemClockAdapter.js';
import { claudeProvider } from './providers/index.js';
import { PixelAgentsServer } from './server.js';

export interface CreateServerOptions {
  host: string;
  port: number;
  staticDir: string;
  assetCache: AssetCache;
  packageRoot: string;
}

export async function createServer(options: CreateServerOptions): Promise<{
  runtime: AgentRuntime;
  server: PixelAgentsServer;
  store: AgentStateStore;
  config: { port: number; token: string };
}> {
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  const nodeTimer = new NodeTimerAdapter();
  const systemClock = new SystemClockAdapter();
  const nodeFileWatcher = new NodeFileWatcherAdapter();
  const sessionService = new SessionManagementService();
  const dismissalTrackerService = new DismissalTrackerService();
  const storeAsAgentStore = store as never;
  const broadcastService = new BroadcastService(storeAsAgentStore);
  const dailyUsage = new DailyUsageTracker();
  const transcriptProcessingService = new TranscriptProcessingService(
    claudeProvider,
    storeAsAgentStore,
    broadcastService,
    nodeTimer,
    dailyUsage,
  );
  const fileScanningService = new FileScanningService({
    fileWatcher: nodeFileWatcher,
    timerService: nodeTimer,
    clock: systemClock,
    dismissalTracker: dismissalTrackerService,
    agentStore: storeAsAgentStore,
    transcriptProcessingService,
  });
  const hookRoutingService = new HookRoutingService(
    claudeProvider,
    storeAsAgentStore,
    sessionService,
    broadcastService,
    nodeTimer,
  );

  const runtime = new AgentRuntime(store, claudeProvider, {
    timerService: nodeTimer,
    clock: systemClock,
    fileScanningService,
    hookRoutingService,
    broadcastService,
    sessionService,
    transcriptProcessingService,
    dismissalTracker: dismissalTrackerService,
    dailyUsage,
  });

  dailyUsage.setOnChange((snapshot) => {
    store.broadcast({ type: 'dailyUsage', ...snapshot });
  });

  const server = new PixelAgentsServer();

  let currentConfig: { port: number; token: string } | null = null;

  server.onHookEvent((providerId, event) => {
    runtime.handleHookEvent(providerId, event);
  });

  const onSetHooksEnabled = async (enabled: boolean): Promise<void> => {
    if (!currentConfig) return;
    if (enabled) {
      await claudeProvider.installHooks(
        `http://127.0.0.1:${currentConfig.port}`,
        currentConfig.token,
      );
    } else {
      await claudeProvider.uninstallHooks();
    }
  };

  const config = await server.start({
    store,
    runtime,
    embedded: false,
    host: options.host,
    port: options.port,
    staticDir: options.staticDir,
    assetCache: options.assetCache,
    onSetHooksEnabled,
  });

  currentConfig = { port: config.port, token: config.token };

  runtime.hooksEnabled.current = adapter.getSetting('pixel-agents.hooksEnabled', true);
  runtime.watchAllSessions.current = adapter.getSetting('pixel-agents.watchAllSessions', false);

  if (runtime.hooksEnabled.current) {
    try {
      await claudeProvider.installHooks(
        `http://127.0.0.1:${config.port}`,
        config.token,
      );
    } catch (err) {
      console.error('[Pixel Agents] Failed to install hooks:', err);
    }
  }

  const cwd = process.cwd();
  const dirs = claudeProvider.getSessionDirs?.(cwd);
  if (dirs && dirs[0]) {
    const projectDir = dirs[0];
    console.log(`[Pixel Agents] Scanning project dir: ${projectDir}`);
    runtime.startProjectScan(projectDir);
    runtime.startExternalScanning(projectDir);
    runtime.startStaleCheck();
  }

  return { runtime, server, store, config: { port: config.port, token: config.token } };
}
