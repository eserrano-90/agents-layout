export interface ServerConfig {
  externalAssetDirectories: string[];
}

export interface ConfigPersistence {
  load(): ServerConfig;
  save(config: ServerConfig): void;
}
