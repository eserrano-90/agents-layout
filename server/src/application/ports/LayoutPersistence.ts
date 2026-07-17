export interface LayoutPersistence {
  load(): Record<string, unknown> | null;
  save(layout: Record<string, unknown>): void;
}
