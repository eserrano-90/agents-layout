import type { AssetLoader, LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from '../../application/ports/AssetLoader.js';
import {
  loadCharacterSprites,
  loadDefaultLayout,
  loadFloorTiles,
  loadFurnitureAssets,
  loadPetSprites,
  loadWallTiles,
} from '../../assetLoader.js';

export class PngAssetLoader implements AssetLoader {
  async loadCharacters(rootPath: string): Promise<LoadedCharacterSprites | null> {
    return loadCharacterSprites(rootPath) as Promise<LoadedCharacterSprites | null>;
  }

  async loadPets(rootPath: string): Promise<LoadedPetSprites | null> {
    return loadPetSprites(rootPath) as Promise<LoadedPetSprites | null>;
  }

  async loadFloorTiles(rootPath: string): Promise<{ sprites: string[][][] } | null> {
    return loadFloorTiles(rootPath);
  }

  async loadWallTiles(rootPath: string): Promise<{ sets: string[][][][] } | null> {
    return loadWallTiles(rootPath);
  }

  async loadFurniture(rootPath: string): Promise<LoadedAssets | null> {
    return loadFurnitureAssets(rootPath) as Promise<LoadedAssets | null>;
  }

  loadDefaultLayout(rootPath: string): Record<string, unknown> | null {
    return loadDefaultLayout(rootPath);
  }
}
