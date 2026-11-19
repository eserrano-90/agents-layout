import type { AgentEventReducer } from './agentEventReducer.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import { readConfig, writeConfig } from './configPersistence.js';
import type { DailyUsageTracker } from './dailyUsageTracker.js';
import type { IngestService } from './ingestService.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';

type WsSend = (message: Record<string, unknown>) => void;

/**
 * Settings that belong to an emitting client running in the same process
 * (all-in-one mode). Absent in server-only mode, where the UI hides them.
 */
export interface LocalClientControl {
  getSettings(): { hooksEnabled: boolean; watchAllSessions: boolean };
  setHooksEnabled(enabled: boolean): Promise<void> | void;
  setWatchAllSessions(enabled: boolean): void;
}

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  pets: LoadedPetSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export interface ClientMessageContext {
  store: AgentStateStore;
  cache: AssetCache | null;
  reducer?: AgentEventReducer;
  ingest?: IngestService;
  dailyUsage?: DailyUsageTracker;
  localClient?: LocalClientControl;
}

// ── Setting key constants ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
const KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store } = ctx;
  const adapter = store.getAdapter();

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'saveLayout':
      if (msg.layout) {
        writeLayoutToFile(msg.layout as Record<string, unknown>);
      }
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        adapter?.saveSeats(
          msg.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>,
        );
      }
      break;

    case 'setSoundEnabled':
      adapter?.setSetting(KEY_SOUND_ENABLED, msg.enabled);
      break;

    case 'setLastSeenVersion':
      adapter?.setSetting(KEY_LAST_SEEN_VERSION, msg.version as string);
      break;

    case 'setAlwaysShowLabels':
      adapter?.setSetting(KEY_ALWAYS_SHOW_LABELS, msg.enabled);
      break;

    // Client settings: only meaningful with a co-located client.
    case 'setWatchAllSessions':
      ctx.localClient?.setWatchAllSessions(msg.enabled === true);
      break;

    case 'setHooksEnabled':
      void ctx.localClient?.setHooksEnabled(msg.enabled === true);
      break;

    case 'setHooksInfoShown':
      adapter?.setSetting(KEY_HOOKS_INFO_SHOWN, true);
      break;

    case 'addExternalAssetDirectory': {
      const newPath = msg.path as string | undefined;
      if (!newPath) break;
      const cfg = readConfig();
      if (!cfg.externalAssetDirectories.includes(newPath)) {
        cfg.externalAssetDirectories.push(newPath);
        writeConfig(cfg);
      }
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      break;
    }

    case 'removeExternalAssetDirectory': {
      const removePath = msg.path as string | undefined;
      if (!removePath) break;
      const cfg = readConfig();
      cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter((d) => d !== removePath);
      writeConfig(cfg);
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      break;
    }

    default:
      // focusAgent, exportLayout, importLayout
      // require IDE-specific handling (not yet implemented for standalone)
      break;
  }
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, cache, reducer, ingest } = ctx;
  const adapter = store.getAdapter();

  // 1. Tool capabilities learned from events so far (must arrive before any
  //    agent messages; updated live as new tool names appear).
  send({
    type: 'providerCapabilities',
    readingTools: [...(reducer?.readingTools ?? [])],
    subagentToolNames: [...(reducer?.subagentToolNames ?? [])],
  });

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.pets) {
      send({
        type: 'petSpritesLoaded',
        pets: cache.pets.pets,
        petNames: cache.pets.manifests.map((m) => m.name),
      });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  // 3. Layout (saved file, or bundled default)
  const savedLayout = readLayoutFromFile();
  send({ type: 'layoutLoaded', layout: savedLayout ?? cache?.defaultLayout ?? null });

  // 4. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const clientSettings = ctx.localClient?.getSettings();
  send({
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions: clientSettings?.watchAllSessions ?? false,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    hooksEnabled: clientSettings?.hooksEnabled ?? false,
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: cfg.externalAssetDirectories,
    localClient: ctx.localClient !== undefined,
  });

  // 5. Existing agents. Client labels only when several clients feed this office.
  const showClientLabels = (ingest?.connectedClients().length ?? 0) > 1;
  const agentIds: number[] = [];
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  const clientLabels: Record<number, string> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
    const label = showClientLabels ? ingest?.labelOf(agent.clientId) : undefined;
    if (label) clientLabels[id] = label;
  }
  const seats = adapter?.loadSeats() ?? {};
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta: seats,
    folderNames,
    externalAgents,
    ...(showClientLabels ? { clientLabels } : {}),
  });

  // Replay per-agent token + model snapshot so a reconnecting client shows
  // current values immediately instead of blank-until-next-turn.
  for (const [id, agent] of store) {
    const total = agent.inputTokens + agent.outputTokens;
    if (total > 0) {
      send({
        type: 'agentTokenUsage',
        id,
        inputTokens: agent.inputTokens,
        outputTokens: agent.outputTokens,
      });
    }
    if (agent.model) {
      send({ type: 'agentModelInfo', id, model: agent.model });
    }
  }

  // Global daily usage snapshot (tokens + estimated cost for today).
  if (ctx.dailyUsage) {
    send({ type: 'dailyUsage', ...ctx.dailyUsage.snapshot() });
  }
}
