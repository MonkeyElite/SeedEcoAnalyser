export type Ingredient = { name: string; qty: number };

export type Byproduct = {
  name: string;
  qty: number;
  chance: number;
};

export type Recipe = {
  id: string;
  schematicId?: string;
  output: string;
  outputQty: number;
  station: string;
  manualSeconds: number;
  automaticSeconds?: number;
  ingredients: Ingredient[];
  byproducts: Byproduct[];
  skillRequirement?: { id: string; name: string; level: number };
  trainedSkills?: Array<{ id: string; name: string; multiplier: number }>;
  speedSkills?: Array<{ id: string; name: string; bonusPerLevel: number }>;
  impactedBySkill?: { id: string; name: string };
  difficulty?: number;
};

export type Skill = {
  id: string;
  name: string;
  description?: string;
  category?: string;
  maxLevel: number;
  parentId?: string;
  unlockedBy?: { id: string; name: string; level: number };
  speedBonusPerLevel: number;
  affectedSchematicCount: number;
};

export type Item = {
  name: string;
  type?: string;
  description?: string;
  icon?: string;
  recipes: Recipe[];
  referencedOnly?: boolean;
  wildHarvestable?: boolean;
  farmingSeed?: boolean;
};

export type SchemaMapping = {
  itemsPath: string;
  rootItemName: string;
  itemNamePath: string;
  recipesPath: string;
  outputQtyPath: string;
  ingredientsPath: string;
  ingredientNamePath: string;
  ingredientQtyPath: string;
  producersPath: string;
  producerNamePath: string;
  manualTimePath: string;
  byproductsPath: string;
  byproductNamePath: string;
  byproductQtyPath: string;
  byproductChancePath: string;
};

export type Candidate = {
  low: number;
  high: number;
  label: string;
  recipeId?: string;
  provisional: boolean;
  missingByproducts: string[];
  direction: "fixed" | "forward" | "backward";
  visitedItems?: string[];
  visitedRecipes?: string[];
};

export type Estimate = Candidate & { candidates: Candidate[] };

export type RecipeCalculation = {
  recipeId: string;
  ingredientLow: number;
  ingredientHigh: number;
  labor: number;
  machineCost: number;
  effectiveManualSeconds: number;
  creditLow: number;
  creditHigh: number;
  missingInputs: string[];
  missingByproducts: string[];
  result?: Candidate;
};

export type CalculationResult = {
  estimates: Record<string, Estimate>;
  recipeCalculations: Record<string, RecipeCalculation>;
  iterations: number;
};

export const defaultMapping: SchemaMapping = {
  itemsPath: "",
  rootItemName: "",
  itemNamePath: "@key",
  recipesPath: "schematics",
  outputQtyPath: "qty",
  ingredientsPath: "cost",
  ingredientNamePath: "@key",
  ingredientQtyPath: "@value",
  producersPath: "produce_by",
  producerNamePath: "@key",
  manualTimePath: "CraftingTime.ManualCraftingTime",
  byproductsPath: "by_product",
  byproductNamePath: "@key",
  byproductQtyPath: "qty",
  byproductChancePath: "chances",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getAt(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").reduce<unknown>((current, part) => {
    if (Array.isArray(current)) {
      const index = Number(part);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    return isRecord(current) ? current[part] : undefined;
  }, value);
}

function entries(value: unknown): Array<{ key: string; value: unknown }> {
  if (Array.isArray(value)) {
    return value.map((entry, index) => ({ key: String(index), value: entry }));
  }
  if (isRecord(value)) {
    return Object.entries(value).map(([key, entry]) => ({ key, value: entry }));
  }
  return [];
}

function mapped(entry: { key: string; value: unknown }, path: string): unknown {
  if (path === "@key") return entry.key;
  if (path === "@value") return entry.value;
  return getAt(entry.value, path);
}

function finiteNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function normalizeSkills(raw: unknown): Skill[] {
  if (!isRecord(raw)) return [];
  const skillEntries = entries(raw.skills);
  return skillEntries.map((entry) => {
    const record = isRecord(entry.value) ? entry.value : {};
    const unlocked = isRecord(record.unlockedBy) ? record.unlockedBy : undefined;
    return {
      id: String(record.id ?? entry.key),
      name: String(record.name ?? entry.key),
      description: typeof record.description === "string" ? record.description : undefined,
      category: typeof record.category === "string" ? record.category : undefined,
      maxLevel: Math.max(0, finiteNumber(record.maxLevel, 50)),
      parentId: typeof record.parentId === "string" ? record.parentId : undefined,
      unlockedBy: unlocked ? {
        id: String(unlocked.id ?? ""),
        name: String(unlocked.name ?? unlocked.id ?? "Unknown skill"),
        level: finiteNumber(unlocked.level),
      } : undefined,
      speedBonusPerLevel: finiteNumber(record.speedBonusPerLevel),
      affectedSchematicCount: finiteNumber(record.affectedSchematicCount),
    };
  }).filter((skill) => skill.id && skill.name).sort((a, b) => a.name.localeCompare(b.name));
}

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function detectMapping(raw: unknown): SchemaMapping {
  const mapping = { ...defaultMapping };
  if (isRecord(raw) && isRecord(raw.ingredients_data)) {
    mapping.itemsPath = "ingredients_data";
    if (isRecord(raw.detail)) mapping.rootItemName = "Root item";
  } else if (isRecord(raw) && Array.isArray(raw.items)) {
    mapping.itemsPath = "items";
    mapping.itemNamePath = "name";
  } else if (Array.isArray(raw)) {
    mapping.itemNamePath = "name";
  }

  const itemCollection = getAt(raw, mapping.itemsPath);
  const firstItem = entries(itemCollection)[0]?.value;
  if (isRecord(firstItem)) {
    if (!Array.isArray(firstItem.schematics) && Array.isArray(firstItem.recipes)) {
      mapping.recipesPath = "recipes";
    }
    const firstRecipe = entries(getAt(firstItem, mapping.recipesPath))[0]?.value;
    if (isRecord(firstRecipe)) {
      if (!("qty" in firstRecipe) && "outputQty" in firstRecipe) mapping.outputQtyPath = "outputQty";
      if (!("cost" in firstRecipe) && "ingredients" in firstRecipe) mapping.ingredientsPath = "ingredients";
      if (!("produce_by" in firstRecipe) && "producers" in firstRecipe) mapping.producersPath = "producers";
    }
  }
  return mapping;
}

export function normalizeData(
  raw: unknown,
  mapping: SchemaMapping,
): { items: Item[]; warnings: string[] } {
  const warnings: string[] = [];
  const collection = getAt(raw, mapping.itemsPath);
  const itemEntries = entries(collection);
  const rootItemName = (mapping.rootItemName ?? "").trim();
  if (mapping.itemsPath && rootItemName && isRecord(raw) && isRecord(raw.detail)) {
    itemEntries.unshift({ key: rootItemName, value: raw.detail });
  }
  if (!itemEntries.length) {
    throw new Error(`No items found at “${mapping.itemsPath || "document root"}”.`);
  }

  const itemMap = new Map<string, Item>();
  for (const itemEntry of itemEntries) {
    const rawName = mapped(itemEntry, mapping.itemNamePath);
    const name = typeof rawName === "string" && rawName.trim() ? rawName.trim() : `Item ${itemEntry.key}`;
    const record = isRecord(itemEntry.value) ? itemEntry.value : {};
    const recipes: Recipe[] = [];
    const recipeEntries = entries(getAt(record, mapping.recipesPath));

    for (const [recipeIndex, recipeEntry] of recipeEntries.entries()) {
      const outputQty = finiteNumber(getAt(recipeEntry.value, mapping.outputQtyPath), 1);
      if (outputQty <= 0) {
        warnings.push(`${name}: recipe ${recipeIndex + 1} was skipped because output quantity is not positive.`);
        continue;
      }

      const ingredients = entries(getAt(recipeEntry.value, mapping.ingredientsPath))
        .map((ingredientEntry) => ({
          name: String(mapped(ingredientEntry, mapping.ingredientNamePath) ?? "").trim(),
          qty: finiteNumber(mapped(ingredientEntry, mapping.ingredientQtyPath)),
        }))
        .filter((ingredient) => ingredient.name && ingredient.qty > 0);

      let producers = entries(getAt(recipeEntry.value, mapping.producersPath));
      if (!producers.length) producers = [{ key: "Direct", value: recipeEntry.value }];

      for (const [producerIndex, producerEntry] of producers.entries()) {
        const station = String(mapped(producerEntry, mapping.producerNamePath) ?? "Direct");
        const manualSeconds = finiteNumber(getAt(producerEntry.value, mapping.manualTimePath));
        const automaticSeconds = finiteNumber(getAt(producerEntry.value, "CraftingTime.AutomaticCraftingTime"));
        const producerRecord = isRecord(producerEntry.value) ? producerEntry.value : {};
        const requirementRecord = isRecord(producerRecord.skillRequirement) ? producerRecord.skillRequirement : undefined;
        const trainedSkills = Array.isArray(producerRecord.trainedSkills) ? producerRecord.trainedSkills : [];
        const speedSkills = Array.isArray(producerRecord.speedSkills) ? producerRecord.speedSkills : [];
        const impactedRecord = isRecord(producerRecord.impactedBySkill) ? producerRecord.impactedBySkill : undefined;
        const byproducts = entries(getAt(producerEntry.value, mapping.byproductsPath))
          .map((byproductEntry) => ({
            name: String(mapped(byproductEntry, mapping.byproductNamePath) ?? "").trim(),
            qty: finiteNumber(getAt(byproductEntry.value, mapping.byproductQtyPath), 1),
            chance: finiteNumber(getAt(byproductEntry.value, mapping.byproductChancePath), 100),
          }))
          .filter((byproduct) => byproduct.name && byproduct.qty > 0)
          .map((byproduct) => ({ ...byproduct, chance: Math.max(0, Math.min(100, byproduct.chance)) }));

        const schematicId = typeof producerRecord.schematicId === "string" ? producerRecord.schematicId : undefined;
        recipes.push({
          id: schematicId ? `${safeId(schematicId)}-${safeId(station)}` : `${safeId(name)}-${recipeIndex + 1}-${producerIndex + 1}`,
          schematicId,
          output: name,
          outputQty,
          station,
          manualSeconds,
          automaticSeconds,
          ingredients,
          byproducts,
          skillRequirement: requirementRecord ? {
            id: String(requirementRecord.id ?? ""),
            name: String(requirementRecord.name ?? requirementRecord.id ?? "Unknown skill"),
            level: finiteNumber(requirementRecord.level),
          } : undefined,
          trainedSkills: trainedSkills.filter(isRecord).map((skill) => ({
            id: String(skill.id ?? ""),
            name: String(skill.name ?? skill.id ?? "Unknown skill"),
            multiplier: finiteNumber(skill.multiplier, 1),
          })),
          speedSkills: speedSkills.filter(isRecord).map((skill) => ({
            id: String(skill.id ?? ""),
            name: String(skill.name ?? skill.id ?? "Unknown skill"),
            bonusPerLevel: finiteNumber(skill.bonusPerLevel),
          })),
          impactedBySkill: impactedRecord ? {
            id: String(impactedRecord.id ?? ""),
            name: String(impactedRecord.name ?? impactedRecord.id ?? "Unknown skill"),
          } : undefined,
          difficulty: Number.isFinite(Number(producerRecord.difficulty)) ? Number(producerRecord.difficulty) : undefined,
        });
      }
    }

    itemMap.set(name, {
      name,
      type: typeof record.type === "string" ? record.type : undefined,
      description: typeof record.description === "string" ? record.description : undefined,
      icon: typeof record.itemIcon === "string" ? record.itemIcon : undefined,
      recipes,
      wildHarvestable: record.wildHarvestable === true,
      farmingSeed: record.farmingSeed === true,
    });
  }

  for (const item of [...itemMap.values()]) {
    for (const recipe of item.recipes) {
      for (const reference of [...recipe.ingredients, ...recipe.byproducts]) {
        if (!itemMap.has(reference.name)) {
          itemMap.set(reference.name, { name: reference.name, recipes: [], referencedOnly: true });
          warnings.push(`${reference.name} is referenced by a recipe but has no item record.`);
        }
      }
    }
  }

  return { items: [...itemMap.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings };
}

function aggregate(candidates: Candidate[]): Estimate | undefined {
  if (!candidates.length) return undefined;
  const low = Math.min(...candidates.map((candidate) => candidate.low));
  const high = Math.max(...candidates.map((candidate) => candidate.high));
  const provisional = candidates.some((candidate) => candidate.provisional);
  return {
    low,
    high,
    label: candidates.length === 1 ? candidates[0].label : `${candidates.length} production paths`,
    provisional,
    missingByproducts: [...new Set(candidates.flatMap((candidate) => candidate.missingByproducts))],
    direction: candidates.length === 1 ? candidates[0].direction : "forward",
    candidates: [...candidates].sort((a, b) => a.low - b.low),
  };
}

function closeEnough(a: Candidate | undefined, b: Candidate): boolean {
  return Boolean(a) && Math.abs(a!.low - b.low) < 1e-7 && Math.abs(a!.high - b.high) < 1e-7 && a!.provisional === b.provisional;
}

export function calculateEstimates(
  items: Item[],
  fixedPrices: Record<string, number>,
  hourlyRate: number | null,
  skillLevels: Record<string, number> = {},
  machineHourlyRate: number | null = null,
  calculationRules: CalculationRules = DEFAULT_CALCULATION_RULES,
): CalculationResult {
  const recipes = items.flatMap((item) => item.recipes);
  const candidates = new Map<string, Map<string, Candidate>>();
  const fixed = new Map<string, Candidate>();
  for (const [name, price] of Object.entries(fixedPrices)) {
    if (Number.isFinite(price)) {
      fixed.set(name, {
        low: price,
        high: price,
        label: "Exact price",
        provisional: false,
        missingByproducts: [],
        direction: "fixed",
        visitedItems: [name],
        visitedRecipes: [],
      });
    }
  }

  const currentEstimates = (): Record<string, Estimate> => {
    const result: Record<string, Estimate> = {};
    for (const item of items) {
      const exact = fixed.get(item.name);
      const values = exact ? [exact] : [...(candidates.get(item.name)?.values() ?? [])];
      const estimate = aggregate(values);
      if (estimate) result[item.name] = estimate;
    }
    return result;
  };

  const filteredEstimate = (
    estimates: Record<string, Estimate>,
    itemName: string,
    avoidItem: string,
    avoidRecipe: string,
  ): Estimate | undefined => {
    const estimate = estimates[itemName];
    if (!estimate) return undefined;
    const eligible = estimate.candidates.filter((candidate) =>
      !(candidate.visitedItems ?? []).includes(avoidItem) &&
      !(candidate.visitedRecipes ?? []).includes(avoidRecipe),
    );
    return aggregate(eligible);
  };

  const provenance = (dependencies: Array<Estimate | undefined>, itemName: string, recipeId: string) => ({
    visitedItems: [...new Set([...dependencies.flatMap((estimate) => estimate?.candidates.flatMap((candidate) => candidate.visitedItems ?? []) ?? []), itemName])],
    visitedRecipes: [...new Set([...dependencies.flatMap((estimate) => estimate?.candidates.flatMap((candidate) => candidate.visitedRecipes ?? []) ?? []), recipeId])],
  });

  const effectiveSeconds = (recipe: Recipe) => {
    const speedBonus = (recipe.speedSkills ?? []).reduce((total, skill) => {
      const level = Math.max(0, skillLevels[skill.id] ?? 0);
      return total + skill.bonusPerLevel * level;
    }, 0);
    return recipe.manualSeconds / Math.max(1, 1 + speedBonus * calculationRules.skillSpeedMultiplier);
  };

  let iterations = 0;
  for (; iterations < 32; iterations += 1) {
    const estimates = currentEstimates();
    let changed = false;

    const put = (itemName: string, key: string, candidate: Candidate) => {
      if (fixed.has(itemName) || !Number.isFinite(candidate.low) || !Number.isFinite(candidate.high)) return;
      if (Math.abs(candidate.low) > 1e12 || Math.abs(candidate.high) > 1e12) return;
      const itemCandidates = candidates.get(itemName) ?? new Map<string, Candidate>();
      if (!closeEnough(itemCandidates.get(key), candidate)) {
        itemCandidates.set(key, candidate);
        candidates.set(itemName, itemCandidates);
        changed = true;
      }
    };

    for (const recipe of recipes) {
      const laborSeconds = effectiveSeconds(recipe);
      const labor = hourlyRate === null ? 0 : (hourlyRate * laborSeconds) / 3600 * calculationRules.laborCostMultiplier;
      const machineCost = machineHourlyRate === null ? 0 : machineHourlyRate * (recipe.automaticSeconds ?? 0) / 3600 * calculationRules.machineCostMultiplier;
      const operatingCost = labor + machineCost;
      const inputEstimates = recipe.ingredients.map((ingredient) => filteredEstimate(estimates, ingredient.name, recipe.output, recipe.id));
      if (inputEstimates.every((estimate): estimate is Estimate => Boolean(estimate))) {
        let inputLow = 0;
        let inputHigh = 0;
        recipe.ingredients.forEach((ingredient, index) => {
          inputLow += inputEstimates[index].low * ingredient.qty;
          inputHigh += inputEstimates[index].high * ingredient.qty;
        });
        let creditLow = 0;
        let creditHigh = 0;
        const missingByproducts: string[] = [];
        for (const byproduct of recipe.byproducts) {
          const estimate = filteredEstimate(estimates, byproduct.name, recipe.output, recipe.id);
          const expectedQty = byproduct.qty * (byproduct.chance / 100);
          if (estimate) {
            creditLow += estimate.low * expectedQty * calculationRules.byproductCreditMultiplier;
            creditHigh += estimate.high * expectedQty * calculationRules.byproductCreditMultiplier;
          } else {
            missingByproducts.push(byproduct.name);
          }
        }
        const path = provenance([...inputEstimates, ...recipe.byproducts.map((byproduct) => filteredEstimate(estimates, byproduct.name, recipe.output, recipe.id))], recipe.output, recipe.id);
        put(recipe.output, `forward:${recipe.id}`, {
          low: (inputLow + operatingCost - creditHigh) / recipe.outputQty,
          high: (inputHigh + operatingCost - creditLow) / recipe.outputQty,
          label: `Produced at ${recipe.station}`,
          recipeId: recipe.id,
          provisional: missingByproducts.length > 0 || inputEstimates.some((estimate) => estimate.provisional),
          missingByproducts,
          direction: "forward",
          ...path,
        });
      }

      const unresolved = recipe.ingredients.filter((ingredient) => !estimates[ingredient.name]);
      const targetName = unresolved.length === 1 ? unresolved[0].name : "";
      const outputEstimate = targetName ? filteredEstimate(estimates, recipe.output, targetName, recipe.id) : undefined;
      if (outputEstimate) {
        if (unresolved.length === 1) {
          const target = unresolved[0];
          let knownLow = 0;
          let knownHigh = 0;
          for (const ingredient of recipe.ingredients) {
            if (ingredient.name === target.name) continue;
            const estimate = filteredEstimate(estimates, ingredient.name, target.name, recipe.id);
            if (estimate) {
              knownLow += estimate.low * ingredient.qty;
              knownHigh += estimate.high * ingredient.qty;
            }
          }
          let creditLow = 0;
          let creditHigh = 0;
          const missingByproducts: string[] = [];
          for (const byproduct of recipe.byproducts) {
            const estimate = filteredEstimate(estimates, byproduct.name, target.name, recipe.id);
            const expectedQty = byproduct.qty * (byproduct.chance / 100);
            if (estimate) {
              creditLow += estimate.low * expectedQty * calculationRules.byproductCreditMultiplier;
              creditHigh += estimate.high * expectedQty * calculationRules.byproductCreditMultiplier;
            } else {
              missingByproducts.push(byproduct.name);
            }
          }
          const path = provenance([
            outputEstimate,
            ...recipe.ingredients.filter((ingredient) => ingredient.name !== target.name).map((ingredient) => filteredEstimate(estimates, ingredient.name, target.name, recipe.id)),
            ...recipe.byproducts.map((byproduct) => filteredEstimate(estimates, byproduct.name, target.name, recipe.id)),
          ], target.name, recipe.id);
          put(target.name, `backward:${recipe.id}`, {
            low: (outputEstimate.low * recipe.outputQty - knownHigh - operatingCost + creditLow) / target.qty,
            high: (outputEstimate.high * recipe.outputQty - knownLow - operatingCost + creditHigh) / target.qty,
            label: `Back-solved from ${recipe.output}`,
            recipeId: recipe.id,
            provisional: outputEstimate.provisional || missingByproducts.length > 0,
            missingByproducts,
            direction: "backward",
            ...path,
          });
        }
      }
    }
    if (!changed) break;
  }

  const estimates = currentEstimates();
  const recipeCalculations: Record<string, RecipeCalculation> = {};
  for (const recipe of recipes) {
    const laborSeconds = effectiveSeconds(recipe);
    const labor = hourlyRate === null ? 0 : (hourlyRate * laborSeconds) / 3600 * calculationRules.laborCostMultiplier;
    const machineCost = machineHourlyRate === null ? 0 : machineHourlyRate * (recipe.automaticSeconds ?? 0) / 3600 * calculationRules.machineCostMultiplier;
    let ingredientLow = 0;
    let ingredientHigh = 0;
    const missingInputs: string[] = [];
    for (const ingredient of recipe.ingredients) {
      const estimate = estimates[ingredient.name];
      if (!estimate) missingInputs.push(ingredient.name);
      else {
        ingredientLow += estimate.low * ingredient.qty;
        ingredientHigh += estimate.high * ingredient.qty;
      }
    }
    let creditLow = 0;
    let creditHigh = 0;
    const missingByproducts: string[] = [];
    for (const byproduct of recipe.byproducts) {
      const estimate = estimates[byproduct.name];
      const expectedQty = byproduct.qty * (byproduct.chance / 100);
      if (!estimate) missingByproducts.push(byproduct.name);
      else {
        creditLow += estimate.low * expectedQty * calculationRules.byproductCreditMultiplier;
        creditHigh += estimate.high * expectedQty * calculationRules.byproductCreditMultiplier;
      }
    }
    const result = estimates[recipe.output]?.candidates.find((candidate) => candidate.recipeId === recipe.id && candidate.direction === "forward");
    recipeCalculations[recipe.id] = {
      recipeId: recipe.id,
      ingredientLow,
      ingredientHigh,
      labor,
      machineCost,
      effectiveManualSeconds: laborSeconds,
      creditLow,
      creditHigh,
      missingInputs,
      missingByproducts,
      result,
    };
  }
  return { estimates, recipeCalculations, iterations: iterations + 1 };
}
import { DEFAULT_CALCULATION_RULES, type CalculationRules } from "./calculation-rules.ts";
