import type { LayoutPersistence } from '../../application/ports/LayoutPersistence.js';
import { readLayoutFromFile, writeLayoutToFile } from '../../layoutPersistence.js';

export class FileSystemLayoutAdapter implements LayoutPersistence {
  load(): Record<string, unknown> | null {
    return readLayoutFromFile();
  }

  save(layout: Record<string, unknown>): void {
    writeLayoutToFile(layout);
  }
}
