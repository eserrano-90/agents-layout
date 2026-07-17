# Port Interface Contracts

All port interfaces live in `server/src/application/ports/`. Every port is a TypeScript interface with no runtime dependencies.

---

## HttpServer

Responsibility: Bind a port, register routes, start/stop the HTTP server.

```typescript
export interface HttpServer {
  start(options: HttpServerOptions): Promise<HttpServerHandle>;
  stop(): Promise<void>;
  port(): number;
}

export interface HttpServerOptions {
  host: string;
  port?: number;  // 0 = auto-assign
}

export interface HttpServerHandle {
  /** The port the server is actually listening on */
  port: number;
}

export interface RouteRegistration {
  get(path: string, handler: RouteHandler, opts?: RouteOptions): void;
  post(path: string, handler: RouteHandler, opts?: RouteOptions): void;
  ws(path: string, handler: WsHandler): void;
}

export interface RouteOptions {
  auth?: boolean;
  schema?: object;
  bodyLimit?: number;
}

export type RouteHandler = (request: HttpRequest, reply: HttpResponse) => Promise<void> | void;
export type WsHandler = (socket: WebSocketConnection, request: HttpRequest) => void;

export interface HttpRequest {
  params: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
}

export interface HttpResponse {
  send(data: unknown): void;
  code(status: number): HttpResponse;
  sendFile(path: string): void;
}

export interface WebSocketConnection {
  send(data: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}
```

---

## MessageBus

Responsibility: Distribute server messages to all connected clients. One implementation per transport channel.

```typescript
export interface MessageBus {
  /** Broadcast a message to all connected clients */
  broadcast(message: ServerMessage): void;
  /** Register a handler for incoming client messages */
  onClientMessage(handler: (message: ClientMessage) => void): void;
  /** Register a connection state change handler */
  onConnectionState(handler: (connected: boolean) => void): void;
  /** Dispose all connections */
  dispose(): void;
}
```

---

## FileWatcher

Responsibility: Watch filesystem paths for changes via polling or native watching.

```typescript
export interface FileWatcher {
  /** Start watching a file at interval. Returns a handle to stop watching. */
  watch(path: string, options: WatchOptions): WatcherHandle;
  /** Unwatch */
  unwatch(handle: WatcherHandle): void;
  /** List files matching a glob/extension in a directory */
  listFiles(dir: string, extension: string): string[];
  /** Read a portion of a file */
  readFileChunk(path: string, offset: number, length: number): Buffer | null;
  /** Get file stats */
  stat(path: string): FileStats | null;
  /** Check if a file exists */
  exists(path: string): boolean;
}

export interface WatchOptions {
  intervalMs: number;
  onData(agentId: number, data: string): void;
  onError(agentId: number, error: Error): void;
}

export interface WatcherHandle {
  id: number;
  path: string;
  close(): void;
}

export interface FileStats {
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
}
```

---

## AgentPersistence

Responsibility: Save and load agent state to/from durable storage.

```typescript
export interface AgentPersistence {
  saveAgents(agents: PersistedAgent[]): void;
  loadAgents(): PersistedAgent[];
  saveSeats(seats: Record<string, SeatMetadata>): void;
  loadSeats(): Record<string, SeatMetadata>;
  saveSetting(key: string, value: unknown): void;
  getSetting<T>(key: string, defaultValue: T): T;
}

export interface PersistedAgent {
  id: number;
  sessionId?: string;
  isExternal?: boolean;
  jsonlFile: string;
  projectDir: string;
  folderName?: string;
  teamName?: string;
  agentName?: string;
  isTeamLead?: boolean;
  leadAgentId?: number;
  teamUsesTmux?: boolean;
}

export interface SeatMetadata {
  palette?: number;
  hueShift?: number;
  seatId?: string;
}
```

---

## LayoutPersistence

Responsibility: Read and write office layout files.

```typescript
export interface LayoutPersistence {
  load(): Record<string, unknown> | null;
  save(layout: Record<string, unknown>): void;
}
```

---

## ConfigPersistence

Responsibility: Read and write server configuration (settings, external asset directories).

```typescript
export interface ConfigPersistence {
  load(): ServerConfig;
  save(config: ServerConfig): void;
}

export interface ServerConfig {
  externalAssetDirectories: string[];
}
```

---

## TimerService

Responsibility: Schedule and cancel delayed/periodic work. Abstraction over `setTimeout`/`setInterval`.

```typescript
export interface TimerService {
  setTimeout(fn: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, intervalMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  /** Clear all active timers (shutdown) */
  clearAll(): void;
}

export interface TimerHandle {
  id: number;
}
```

---

## Clock

Responsibility: Provide current time. Abstraction over `Date.now()` / `performance.now()`.

```typescript
export interface Clock {
  /** Wall clock time in ms since epoch */
  now(): number;
  /** Monotonic time in ms (for intervals/durations, not affected by system clock changes) */
  monotonic(): number;
}
```

---

## AssetLoader

Responsibility: Load and cache sprite assets from disk.

```typescript
export interface AssetLoader {
  loadCharacters(rootPath: string): Promise<LoadedCharacterSprites | null>;
  loadPets(rootPath: string): Promise<LoadedPetSprites | null>;
  loadFloorTiles(rootPath: string): Promise<{ sprites: string[][][] } | null>;
  loadWallTiles(rootPath: string): Promise<{ sets: string[][][][] } | null>;
  loadFurniture(rootPath: string): Promise<LoadedAssets | null>;
  loadDefaultLayout(rootPath: string): Record<string, unknown> | null;
}

export interface LoadedCharacterSprites {
  characters: string[][][][];
}

export interface LoadedPetSprites {
  pets: string[][][][];
  manifests: Array<{ name: string }>;
}

export interface LoadedAssets {
  catalog: Array<{ id: string; name: string }>;
  sprites: Map<string, string[][][]>;
}
```

---

## ScannerInfrastructure

Responsibility: Hold all runtime infrastructure handles that scanners need (watchers, timers, file sets). Replaces the 15+ individual Map/Set refs currently passed as positional args.

```typescript
export interface ScannerInfrastructure {
  readonly fileWatchers: Map<number, WatcherHandle>;
  readonly pollingTimers: Map<number, TimerHandle>;
  readonly jsonlPollTimers: Map<number, TimerHandle>;
  readonly waitingTimers: Map<number, TimerHandle>;
  readonly permissionTimers: Map<number, TimerHandle>;
  readonly knownJsonlFiles: Set<string>;
  readonly dismissalTracker: DismissalTracker;
}
```

---

## AgentStateStore (Port Interface)

Responsibility: Typed event-emitter store for agent state. Application layer depends on this interface; infrastructure provides the implementation.

```typescript
export interface AgentStore {
  get(id: number): Agent | undefined;
  has(id: number): boolean;
  set(id: number, agent: Agent): void;
  delete(id: number): boolean;
  keys(): IterableIterator<number>;
  values(): IterableIterator<Agent>;
  entries(): IterableIterator<[number, Agent]>;
  forEach(cb: (agent: Agent, id: number) => void): void;
  readonly size: number;
  readonly nextAgentId: { current: number };

  /** Subscribe to state changes */
  on<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): void;
  off<K extends keyof StoreEvents>(event: K, listener: StoreEvents[K]): void;

  /** Broadcast a message to all subscribers (transports) */
  broadcast(message: ServerMessage): void;
}
```
