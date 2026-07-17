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

export interface AssetLoader {
  loadCharacters(rootPath: string): Promise<LoadedCharacterSprites | null>;
  loadPets(rootPath: string): Promise<LoadedPetSprites | null>;
  loadFloorTiles(rootPath: string): Promise<{ sprites: string[][][] } | null>;
  loadWallTiles(rootPath: string): Promise<{ sets: string[][][][] } | null>;
  loadFurniture(rootPath: string): Promise<LoadedAssets | null>;
  loadDefaultLayout(rootPath: string): Record<string, unknown> | null;
}
