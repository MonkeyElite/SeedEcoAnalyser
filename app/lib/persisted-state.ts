import type { SchemaMapping } from "./recipe-engine";

export type PersistedDataset = {
  rawText: string;
  mapping: SchemaMapping;
};

export type PersistedServerState = {
  dataset: PersistedDataset | null;
  updatedAt: string | null;
};
