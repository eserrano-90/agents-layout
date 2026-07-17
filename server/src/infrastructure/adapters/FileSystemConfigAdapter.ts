import type { ConfigPersistence, ServerConfig } from '../../application/ports/ConfigPersistence.js';
import { readConfig, writeConfig } from '../../configPersistence.js';

export class FileSystemConfigAdapter implements ConfigPersistence {
  load(): ServerConfig {
    const cfg = readConfig();
    return { externalAssetDirectories: cfg.externalAssetDirectories };
  }

  save(config: ServerConfig): void {
    const existing = readConfig();
    writeConfig({ ...existing, externalAssetDirectories: config.externalAssetDirectories });
  }
}
