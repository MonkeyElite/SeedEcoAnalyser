import { DEFAULT_CALCULATION_RULES, sanitizeCalculationRules, type CalculationRules } from "./calculation-rules.ts";
import type { Item } from "./recipe-engine.ts";

export const PRICING_SCENARIO_SCHEMA_VERSION = 1;
export const MAX_PRICING_SAVE_BYTES = 1024 * 1024;

export type PricingScenarioState = {
  fixedPrices: Record<string, number>;
  npcPayouts: Record<string, number>;
  hourlyRate: number | null;
  machineHourlyRate: number | null;
  calculationRules: CalculationRules;
  skillLevels: Record<string, number>;
  disabledLineIds: string[];
};

export type PricingSaveSummary = {
  id: string;
  name: string;
  description: string;
  datasetFingerprint: string;
  schemaVersion: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type PricingSaveRecord = PricingSaveSummary & {
  state: PricingScenarioState;
};

export const EMPTY_PRICING_SCENARIO: PricingScenarioState = {
  fixedPrices: {},
  npcPayouts: {},
  hourlyRate: null,
  machineHourlyRate: null,
  calculationRules: DEFAULT_CALCULATION_RULES,
  skillLevels: {},
  disabledLineIds: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numericRecord(value: unknown, label: string, minimum?: number): Record<string, number> {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > 10_000) throw new Error(`${label} contains too many entries.`);
  const result: Record<string, number> = {};
  for (const [key, candidate] of entries) {
    if (!key.trim() || key.length > 300) throw new Error(`${label} contains an invalid identifier.`);
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || (minimum !== undefined && candidate < minimum)) {
      throw new Error(`${label}.${key} must be a finite number${minimum !== undefined ? ` of at least ${minimum}` : ""}.`);
    }
    result[key] = candidate;
  }
  return result;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be a finite number or null.`);
  return value;
}

export function validateSaveName(value: unknown): string {
  if (typeof value !== "string") throw new Error("Save name is required.");
  const name = value.trim();
  if (!name || name.length > 80) throw new Error("Save name must contain 1 to 80 characters.");
  return name;
}

export function validateSaveDescription(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 500) throw new Error("Description must contain at most 500 characters.");
  return value.trim();
}

export function validateDatasetFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^dataset-v1-[a-f0-9]{16}$/.test(value)) throw new Error("Dataset fingerprint is invalid.");
  return value;
}

export function validatePricingScenario(value: unknown): PricingScenarioState {
  if (!isRecord(value)) throw new Error("Pricing scenario must be an object.");
  if (!isRecord(value.calculationRules)) throw new Error("Calculation rules must be an object.");
  const rawRules = value.calculationRules as Partial<CalculationRules>;
  for (const key of Object.keys(DEFAULT_CALCULATION_RULES) as Array<keyof CalculationRules>) {
    if (typeof rawRules[key] !== "number" || !Number.isFinite(rawRules[key])) throw new Error(`Calculation rule ${key} must be finite.`);
  }
  const calculationRules = sanitizeCalculationRules(rawRules);
  for (const key of Object.keys(DEFAULT_CALCULATION_RULES) as Array<keyof CalculationRules>) {
    if (calculationRules[key] !== rawRules[key]) throw new Error(`Calculation rule ${key} is outside its accepted range.`);
  }
  if (!Array.isArray(value.disabledLineIds) || value.disabledLineIds.length > 10_000 || value.disabledLineIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 300)) {
    throw new Error("Disabled production-line identifiers are invalid.");
  }
  return {
    fixedPrices: numericRecord(value.fixedPrices, "Fixed prices"),
    npcPayouts: numericRecord(value.npcPayouts, "NPC payouts"),
    hourlyRate: nullableNumber(value.hourlyRate, "Hourly rate"),
    machineHourlyRate: nullableNumber(value.machineHourlyRate, "Machine hourly rate"),
    calculationRules,
    skillLevels: numericRecord(value.skillLevels, "Skill levels", 0),
    disabledLineIds: [...new Set(value.disabledLineIds as string[])],
  };
}

export function datasetFingerprint(items: Item[]): string {
  const lines: string[] = [];
  for (const item of [...items].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`item:${item.name}`);
    for (const recipe of [...item.recipes].sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`recipe:${recipe.id}|${recipe.output}|${recipe.outputQty}|${recipe.station}`);
      for (const ingredient of [...recipe.ingredients].sort((a, b) => a.name.localeCompare(b.name))) lines.push(`in:${ingredient.name}|${ingredient.qty}`);
      for (const byproduct of [...recipe.byproducts].sort((a, b) => a.name.localeCompare(b.name))) lines.push(`by:${byproduct.name}|${byproduct.qty}|${byproduct.chance}`);
    }
  }
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (const character of lines.join("\n")) {
    const code = character.codePointAt(0) ?? 0;
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `dataset-v1-${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}
