/**
 * Pixel Agents server: receives events from emitting clients, keeps agent
 * state, and serves the office to browsers.
 *
 * Routes (Fastify):
 *   POST /api/ingest   event batches from clients (per-client bearer token)
 *   GET  /api/health   liveness (no auth)
 *   GET  /ws           browser protocol channel
 *   GET  /*            office SPA (when a static dir is given)
 *
 * The server reads nothing from an agent tool's files and installs no hooks:
 * see the client/ workspace for that half.
 */

import { AgentEventReducer } from './agentEventReducer.js';
import { AgentStateStore } from './agentStateStore.js';
import type { AssetCache, LocalClientControl } from './clientMessageHandler.js';
import { ClientTokenStore } from './clientTokens.js';
import { CLIENT_LIVENESS_CHECK_INTERVAL_MS } from './constants.js';
import { DailyUsageTracker } from './dailyUsageTracker.js';
import { FileStateAdapter } from './fileStateAdapter.js';
import { FastifyHttpAdapter } from './infrastructure/http/FastifyHttpAdapter.js';
import { WebSocketAdapter } from './infrastructure/websocket/WebSocketAdapter.js';
import { IngestService } from './ingestService.js';

export interface ServerOptions {
  host: string;
  port: number;
  /** Office SPA to serve. Omit to serve only the API. */
  staticDir?: string;
  assetCache?: AssetCache;
  /** Token store (defaults to ~/.pixel-agents/client-tokens.json). */
  tokens?: ClientTokenStore;
}

export interface RunningServer {
  port: number;
  store: AgentStateStore;
  reducer: AgentEventReducer;
  ingest: IngestService;
  tokens: ClientTokenStore;
  /** Attach the co-located client of all-in-one mode (enables its settings in the UI). */
  setLocalClient(control: LocalClientControl): void;
  stop(): Promise<void>;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const store = new AgentStateStore();
  const adapter = new FileStateAdapter({ namespace: 'standalone' });
  store.setAdapter(adapter);

  const dailyUsage = new DailyUsageTracker();
  dailyUsage.setOnChange((snapshot) => {
    store.broadcast({ type: 'dailyUsage', ...snapshot });
  });

  const reducer = new AgentEventReducer({ store, dailyUsage });
  const tokens = options.tokens ?? new ClientTokenStore();

  // Agents persisted before a restart stay hidden until their client confirms them.
  const persisted = adapter.loadAgents();
  reducer.setRestorable(persisted);

  // Client labels are shown only when several clients feed this office.
  const broadcastClientLabels = (): void => {
    const clients = ingest.connectedClients();
    const labels: Record<string, string> = {};
    if (clients.length > 1) {
      for (const agent of store.values()) {
        const label = ingest.labelOf(agent.clientId);
        if (label) labels[String(agent.id)] = label;
      }
    }
    store.broadcast({ type: 'agentClientLabels', labels });
  };

  const ingest: IngestService = new IngestService({
    reducer,
    tokens,
    onClientsChanged: broadcastClientLabels,
  });
  ingest.awaitClients(new Set(persisted.map((p) => p.clientId)));
  ingest.startLivenessCheck(CLIENT_LIVENESS_CHECK_INTERVAL_MS);

  const context: { localClient?: LocalClientControl } = {};
  const wsAdapter = new WebSocketAdapter({
    store,
    context: {
      get localClient() {
        return context.localClient;
      },
      cache: options.assetCache ?? null,
      reducer,
      ingest,
      dailyUsage,
    },
    clientLabelFor: (agent) =>
      ingest.connectedClients().length > 1 ? ingest.labelOf(agent.clientId) : undefined,
  });

  const httpAdapter = new FastifyHttpAdapter({
    embedded: false,
    staticDir: options.staticDir,
    ingest,
    registerPlugins: async (app) => {
      wsAdapter.registerRoutes(app);
    },
  });
  const { port } = await httpAdapter.start({ host: options.host, port: options.port });
  console.log(`[Pixel Agents] Server: listening on ${options.host}:${port}`);

  return {
    port,
    store,
    reducer,
    ingest,
    tokens,
    setLocalClient(control) {
      context.localClient = control;
    },
    async stop() {
      ingest.dispose();
      reducer.dispose();
      wsAdapter.dispose();
      await httpAdapter.stop();
    },
  };
}
