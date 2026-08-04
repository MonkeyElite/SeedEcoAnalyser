import type { SchemaMapping } from "./recipe-engine";

export type PersistedAppSettings = {
  fixedPrices: Record<string, number>;
  npcPayouts: Record<string, number>;
  hourlyRate: number | null;
  machineHourlyRate: number | null;
  skillLevels: Record<string, number>;
  disabledLineIds: string[];
  depth: number;
  viewMode: "graph" | "table" | "lines";
};

export type PersistedDataset = {
  rawText: string;
  mapping: SchemaMapping;
};

export type PersistedServerState = {
  settings: PersistedAppSettings | null;
  dataset: PersistedDataset | null;
  updatedAt: string | null;
};
