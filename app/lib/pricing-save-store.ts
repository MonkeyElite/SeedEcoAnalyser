import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  PRICING_SCENARIO_SCHEMA_VERSION,
  type PricingSaveRecord,
  type PricingSaveSummary,
  type PricingScenarioState,
} from "./pricing-saves.ts";

type PricingSaveRow = {
  id: string;
  name: string;
  description: string;
  dataset_fingerprint: string;
  schema_version: number;
  state_json: string;
  revision: number;
  created_at: string;
  updated_at: string;
};

export class DuplicateSaveNameError extends Error {}

let database: DatabaseSync | null = null;

function databasePath(): string {
  return path.join(path.resolve(process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data")), "seed-eco-analyser.sqlite");
}

function getDatabase(): DatabaseSync {
  if (database) return database;
  const filePath = databasePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  database = new DatabaseSync(filePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`CREATE TABLE IF NOT EXISTS pricing_saves (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    dataset_fingerprint TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`);
  database.exec("CREATE INDEX IF NOT EXISTS idx_pricing_saves_updated_at ON pricing_saves(updated_at DESC)");
  database.exec("PRAGMA optimize");
  return database;
}

function summary(row: PricingSaveRow): PricingSaveSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    datasetFingerprint: row.dataset_fingerprint,
    schemaVersion: row.schema_version,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function record(row: PricingSaveRow): PricingSaveRecord {
  return { ...summary(row), state: JSON.parse(row.state_json) as PricingScenarioState };
}

function duplicateName(error: unknown): never {
  if (error instanceof Error && /UNIQUE constraint failed: pricing_saves\.name/i.test(error.message)) throw new DuplicateSaveNameError("A save with this name already exists.");
  throw error;
}

export function listPricingSaves(): PricingSaveSummary[] {
  const rows = getDatabase().prepare("SELECT * FROM pricing_saves ORDER BY updated_at DESC, name COLLATE NOCASE ASC").all() as PricingSaveRow[];
  return rows.map(summary);
}

export function getPricingSave(id: string): PricingSaveRecord | null {
  const row = getDatabase().prepare("SELECT * FROM pricing_saves WHERE id = ?").get(id) as PricingSaveRow | undefined;
  return row ? record(row) : null;
}

export function createPricingSave(input: { name: string; description: string; datasetFingerprint: string; state: PricingScenarioState }): PricingSaveRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    getDatabase().prepare(`INSERT INTO pricing_saves
      (id, name, description, dataset_fingerprint, schema_version, state_json, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(id, input.name, input.description, input.datasetFingerprint, PRICING_SCENARIO_SCHEMA_VERSION, JSON.stringify(input.state), now, now);
  } catch (error) {
    duplicateName(error);
  }
  return getPricingSave(id)!;
}

export function updatePricingSave(id: string, input: { name?: string; description?: string; state?: PricingScenarioState }): PricingSaveRecord | null {
  const existing = getPricingSave(id);
  if (!existing) return null;
  const name = input.name ?? existing.name;
  const description = input.description ?? existing.description;
  const state = input.state ?? existing.state;
  const now = new Date().toISOString();
  try {
    getDatabase().prepare(`UPDATE pricing_saves
      SET name = ?, description = ?, state_json = ?, revision = revision + 1, updated_at = ?
      WHERE id = ?`)
      .run(name, description, JSON.stringify(state), now, id);
  } catch (error) {
    duplicateName(error);
  }
  return getPricingSave(id);
}

export function deletePricingSave(id: string): boolean {
  return Number(getDatabase().prepare("DELETE FROM pricing_saves WHERE id = ?").run(id).changes) > 0;
}

export function closePricingSaveDatabaseForTests(): void {
  database?.close();
  database = null;
}

