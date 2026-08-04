import type { Estimate, Item, Recipe, Skill } from "./recipe-engine.ts";
import { DEFAULT_CALCULATION_RULES, type CalculationRules } from "./calculation-rules.ts";

export type LineRequirement = { id: string; name: string; level: number };

export type LineStep = {
  recipeId: string;
  schematicId?: string;
  output: string;
  station: string;
  runs: number;
  outputQtyPerRun: number;
  ingredientQtyPerRun: Array<{ name: string; qty: number }>;
  baseManualSecondsPerRun: number;
  effectiveManualSecondsPerRun: number;
  automaticSecondsPerRun: number;
  manualSeconds: number;
  automaticSeconds: number;
  skill?: string;
  requirements: LineRequirement[];
};

export type LineScenario = {
  cost: number;
  materialCost: number;
  laborCost: number;
  machineCost: number;
  byproductCredit: number;
  manualSeconds: number;
  automaticSeconds: number;
  productionSeconds: number;
  fullyAutomatable: boolean;
  complete: boolean;
  provisional: boolean;
  unresolved: string[];
  unresolvedCredits: string[];
  rawInputs: Record<string, number>;
  origins: string[];
  requirements: LineRequirement[];
  stations: string[];
  skills: string[];
  steps: LineStep[];
};

export type ProductionLine = {
  id: string;
  output: string;
  outputQty: number;
  finalStation: string;
  schematicId?: string;
  min: LineScenario;
  max: LineScenario;
  salePrice?: number;
  revenue?: number;
  minProfit?: number;
  maxProfit?: number;
  minMargin?: number;
  maxMargin?: number;
  minProfitPerManualHour?: number;
  maxProfitPerManualHour?: number;
  minProfitPerAutoHour?: number;
  maxProfitPerAutoHour?: number;
  minGrossPerTotalHour?: number;
  maxGrossPerTotalHour?: number;
  minNetPerTotalHour?: number;
  maxNetPerTotalHour?: number;
  stations: string[];
  skills: string[];
  rawInputs: string[];
  complete: boolean;
  provisional: boolean;
  requirements: Array<LineRequirement & { configuredLevel: number; met: boolean }>;
  eligible: boolean;
  calculationRules: CalculationRules;
};

export type BalanceSuggestion = {
  direction: "above" | "below" | "on-target" | "unavailable";
  gapPercent?: number;
  targetSalePrice?: number;
  salePriceDelta?: number;
  targetManualSeconds?: number;
  manualSecondsDelta?: number;
  targetAutomaticSeconds?: number;
  automaticSecondsDelta?: number;
  costAdjustment?: number;
  targetTotalSeconds?: number;
  targetOutputQty?: number;
};

function blankScenario(): LineScenario {
  return {
    cost: 0,
    materialCost: 0,
    laborCost: 0,
    machineCost: 0,
    byproductCredit: 0,
    manualSeconds: 0,
    automaticSeconds: 0,
    productionSeconds: 0,
    fullyAutomatable: true,
    complete: true,
    provisional: false,
    unresolved: [],
    unresolvedCredits: [],
    rawInputs: {},
    origins: [],
    requirements: [],
    stations: [],
    skills: [],
    steps: [],
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function addQuantities(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const result = { ...a };
  for (const [name, qty] of Object.entries(b)) result[name] = (result[name] ?? 0) + qty;
  return result;
}

function scaleScenario(scenario: LineScenario, factor: number): LineScenario {
  return {
    ...scenario,
    cost: scenario.cost * factor,
    materialCost: scenario.materialCost * factor,
    laborCost: scenario.laborCost * factor,
    machineCost: scenario.machineCost * factor,
    byproductCredit: scenario.byproductCredit * factor,
    manualSeconds: scenario.manualSeconds * factor,
    automaticSeconds: scenario.automaticSeconds * factor,
    productionSeconds: scenario.productionSeconds * factor,
    rawInputs: Object.fromEntries(Object.entries(scenario.rawInputs).map(([name, qty]) => [name, qty * factor])),
    origins: scenario.origins,
    steps: scenario.steps.map((step) => ({
      ...step,
      runs: step.runs * factor,
      manualSeconds: step.manualSeconds * factor,
      automaticSeconds: step.automaticSeconds * factor,
    })),
  };
}

function mergeScenario(a: LineScenario, b: LineScenario): LineScenario {
  return {
    cost: a.cost + b.cost,
    materialCost: a.materialCost + b.materialCost,
    laborCost: a.laborCost + b.laborCost,
    machineCost: a.machineCost + b.machineCost,
    byproductCredit: a.byproductCredit + b.byproductCredit,
    manualSeconds: a.manualSeconds + b.manualSeconds,
    automaticSeconds: a.automaticSeconds + b.automaticSeconds,
    productionSeconds: a.productionSeconds + b.productionSeconds,
    fullyAutomatable: a.fullyAutomatable && b.fullyAutomatable,
    complete: a.complete && b.complete,
    provisional: a.provisional || b.provisional,
    unresolved: unique([...a.unresolved, ...b.unresolved]),
    unresolvedCredits: unique([...a.unresolvedCredits, ...b.unresolvedCredits]),
    rawInputs: addQuantities(a.rawInputs, b.rawInputs),
    origins: unique([...a.origins, ...b.origins]),
    requirements: mergeRequirements(a.requirements, b.requirements),
    stations: unique([...a.stations, ...b.stations]),
    skills: unique([...a.skills, ...b.skills]),
    steps: [...a.steps, ...b.steps],
  };
}

function effectiveManualSeconds(recipe: Recipe, skillLevels: Record<string, number>, calculationRules: CalculationRules): number {
  const speed = (recipe.speedSkills ?? []).reduce((sum, skill) => {
    return sum + skill.bonusPerLevel * Math.max(0, skillLevels[skill.id] ?? 0);
  }, 0);
  return recipe.manualSeconds / Math.max(1, 1 + speed * calculationRules.skillSpeedMultiplier);
}

function mergeRequirements(a: LineRequirement[], b: LineRequirement[]): LineRequirement[] {
  const result = new Map<string, LineRequirement>();
  for (const requirement of [...a, ...b]) {
    const current = result.get(requirement.id);
    if (!current || requirement.level > current.level) result.set(requirement.id, requirement);
  }
  return [...result.values()];
}

function missingScenario(name: string): LineScenario {
  return {
    ...blankScenario(),
    complete: false,
    fullyAutomatable: false,
    unresolved: [name],
    rawInputs: { [name]: 1 },
  };
}

function terminalScenario(name: string, cost: number, origin: string): LineScenario {
  return {
    ...blankScenario(),
    cost,
    materialCost: cost,
    rawInputs: { [name]: 1 },
    origins: [origin],
  };
}

export function analyzeProductionLines(
  items: Item[],
  fixedPrices: Record<string, number>,
  hourlyRate: number | null,
  skillLevels: Record<string, number>,
  estimates: Record<string, Estimate>,
  machineHourlyRate: number | null = null,
  skills: Skill[] = [],
  npcPayouts: Record<string, number> = {},
  calculationRules: CalculationRules = DEFAULT_CALCULATION_RULES,
): ProductionLine[] {
  const itemsByName = new Map(items.map((item) => [item.name, item]));
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const itemCache = new Map<string, { min: LineScenario; max: LineScenario }>();

  const recipeRequirements = (recipe: Recipe): LineRequirement[] => {
    if (!recipe.skillRequirement?.id) return [];
    const result: LineRequirement[] = [{ id: recipe.skillRequirement.id, name: recipe.skillRequirement.name, level: recipe.skillRequirement.level }];
    const visited = new Set<string>();
    let current = skillsById.get(recipe.skillRequirement.id);
    while (current?.unlockedBy?.id && !visited.has(current.unlockedBy.id)) {
      visited.add(current.unlockedBy.id);
      result.push({ id: current.unlockedBy.id, name: current.unlockedBy.name, level: current.unlockedBy.level });
      current = skillsById.get(current.unlockedBy.id);
    }
    return mergeRequirements([], result);
  };

  const expandRecipe = (
    recipe: Recipe,
    runs: number,
    stack: Set<string>,
    mode: "min" | "max",
    depth: number,
  ): LineScenario => {
    let result = blankScenario();
    for (const ingredient of recipe.ingredients) {
      const expanded = expandItem(ingredient.name, new Set([...stack, recipe.output]), mode, depth + 1);
      result = mergeScenario(result, scaleScenario(expanded, ingredient.qty * runs));
    }

    const effectiveManualPerRun = effectiveManualSeconds(recipe, skillLevels, calculationRules);
    const manualSeconds = effectiveManualPerRun * runs;
    const automaticSeconds = (recipe.automaticSeconds ?? 0) * runs;
    const productionSeconds = manualSeconds * calculationRules.manualTimeWeight + automaticSeconds * calculationRules.automaticTimeWeight;
    const laborCost = hourlyRate === null ? 0 : hourlyRate * manualSeconds / 3600 * calculationRules.laborCostMultiplier;
    const machineCost = machineHourlyRate === null ? 0 : machineHourlyRate * automaticSeconds / 3600 * calculationRules.machineCostMultiplier;
    let credit = 0;
    const unresolvedCredits: string[] = [];
    for (const byproduct of recipe.byproducts) {
      const estimate = estimates[byproduct.name];
      const expectedQty = byproduct.qty * (byproduct.chance / 100) * runs;
      if (estimate) credit += expectedQty * (mode === "min" ? estimate.high : estimate.low) * calculationRules.byproductCreditMultiplier;
      else unresolvedCredits.push(byproduct.name);
    }

    const own: LineScenario = {
      ...blankScenario(),
      cost: laborCost + machineCost - credit,
      laborCost,
      machineCost,
      byproductCredit: credit,
      manualSeconds,
      automaticSeconds,
      productionSeconds,
      fullyAutomatable: recipe.manualSeconds === 0 || (recipe.automaticSeconds ?? 0) > 0,
      provisional: unresolvedCredits.length > 0,
      unresolvedCredits,
      stations: [recipe.station],
      skills: unique([
        ...(recipe.skillRequirement ? [recipe.skillRequirement.name] : []),
        ...(recipe.speedSkills ?? []).map((skill) => skill.name),
        ...(recipe.trainedSkills ?? []).map((skill) => skill.name),
      ]),
      requirements: recipeRequirements(recipe),
      steps: [{
        recipeId: recipe.id,
        schematicId: recipe.schematicId,
        output: recipe.output,
        station: recipe.station,
        runs,
        outputQtyPerRun: recipe.outputQty,
        ingredientQtyPerRun: recipe.ingredients.map((ingredient) => ({ ...ingredient })),
        baseManualSecondsPerRun: recipe.manualSeconds,
        effectiveManualSecondsPerRun: effectiveManualPerRun,
        automaticSecondsPerRun: recipe.automaticSeconds ?? 0,
        manualSeconds,
        automaticSeconds,
        skill: recipe.skillRequirement?.name ?? recipe.impactedBySkill?.name,
        requirements: recipeRequirements(recipe),
      }],
    };
    return mergeScenario(result, own);
  };

  const expandItem = (
    name: string,
    stack: Set<string>,
    mode: "min" | "max",
    depth: number,
  ): LineScenario => {
    const item = itemsByName.get(name);
    const hasPrice = Object.prototype.hasOwnProperty.call(fixedPrices, name) && Number.isFinite(fixedPrices[name]);
    const terminalCost = hasPrice ? fixedPrices[name] : 0;
    if (item?.farmingSeed) return terminalScenario(name, terminalCost, `${name} · farming seed`);
    if (depth > 16 || stack.has(name)) {
      if (item?.wildHarvestable) return terminalScenario(name, terminalCost, `${name} · wild harvest`);
      const missing = missingScenario(name);
      missing.unresolved = [`${name} (cycle)`];
      return missing;
    }
    const cacheKey = `${name}|${[...stack].sort().join("¦")}|${mode}`;
    const cached = itemCache.get(cacheKey);
    if (cached) return mode === "min" ? cached.min : cached.max;

    if (!item?.recipes.length) {
      if (item?.wildHarvestable) return terminalScenario(name, terminalCost, `${name} · wild harvest`);
      if (hasPrice) return terminalScenario(name, terminalCost, `${name} · market input`);
      return missingScenario(name);
    }
    const nextStack = new Set([...stack, name]);
    const options = item.recipes.map((recipe) => expandRecipe(recipe, 1 / recipe.outputQty, nextStack, mode, depth + 1));
    if (item.wildHarvestable) options.push(terminalScenario(name, terminalCost, `${name} · wild harvest`));
    const completeOptions = options.filter((option) => option.complete);
    const pool = completeOptions.length ? completeOptions : options;
    const selected = [...pool].sort((a, b) => {
      const costDifference = mode === "min" ? a.cost - b.cost : b.cost - a.cost;
      if (Math.abs(costDifference) > 1e-8) return costDifference;
      const aEffort = a.steps.length * 1e9 + a.manualSeconds + a.automaticSeconds;
      const bEffort = b.steps.length * 1e9 + b.manualSeconds + b.automaticSeconds;
      return mode === "min" ? aEffort - bEffort : bEffort - aEffort;
    })[0] ?? missingScenario(name);
    const pair = itemCache.get(cacheKey) ?? { min: selected, max: selected };
    pair[mode] = selected;
    itemCache.set(cacheKey, pair);
    return selected;
  };

  const lines: ProductionLine[] = [];
  for (const item of items) {
    for (const recipe of item.recipes) {
      const min = expandRecipe(recipe, 1, new Set([item.name]), "min", 0);
      const max = expandRecipe(recipe, 1, new Set([item.name]), "max", 0);
      const linePayout = npcPayouts[recipe.id];
      const legacyItemPayout = fixedPrices[item.name];
      const salePrice = Number.isFinite(linePayout) ? linePayout : Number.isFinite(legacyItemPayout) ? legacyItemPayout : undefined;
      const revenue = salePrice;
      const minProfit = revenue === undefined ? undefined : revenue - max.cost;
      const maxProfit = revenue === undefined ? undefined : revenue - min.cost;
      const minManualHours = max.manualSeconds / 3600;
      const maxManualHours = min.manualSeconds / 3600;
      const minAutoHours = max.automaticSeconds / 3600;
      const maxAutoHours = min.automaticSeconds / 3600;
      const manualRates = [
        minProfit !== undefined && minManualHours > 0 ? minProfit / minManualHours : undefined,
        maxProfit !== undefined && maxManualHours > 0 ? maxProfit / maxManualHours : undefined,
      ].filter((value): value is number => value !== undefined);
      const autoRates = [
        minProfit !== undefined && max.fullyAutomatable && minAutoHours > 0 ? minProfit / minAutoHours : undefined,
        maxProfit !== undefined && min.fullyAutomatable && maxAutoHours > 0 ? maxProfit / maxAutoHours : undefined,
      ].filter((value): value is number => value !== undefined);
      const minTotalHours = min.productionSeconds / 3600;
      const maxTotalHours = max.productionSeconds / 3600;
      const grossRates = revenue === undefined ? [] : [
        minTotalHours > 0 ? revenue / minTotalHours : undefined,
        maxTotalHours > 0 ? revenue / maxTotalHours : undefined,
      ].filter((value): value is number => value !== undefined);
      const netRates = [
        maxProfit !== undefined && minTotalHours > 0 ? maxProfit / minTotalHours : undefined,
        minProfit !== undefined && maxTotalHours > 0 ? minProfit / maxTotalHours : undefined,
      ].filter((value): value is number => value !== undefined);
      const requirements = mergeRequirements(min.requirements, max.requirements).map((requirement) => ({
        ...requirement,
        configuredLevel: Math.max(0, skillLevels[requirement.id] ?? 0),
        met: Math.max(0, skillLevels[requirement.id] ?? 0) >= requirement.level,
      }));
      lines.push({
        id: recipe.id,
        output: item.name,
        outputQty: recipe.outputQty,
        finalStation: recipe.station,
        schematicId: recipe.schematicId,
        min,
        max,
        salePrice,
        revenue,
        minProfit,
        maxProfit,
        minMargin: revenue && minProfit !== undefined ? minProfit / revenue * 100 : undefined,
        maxMargin: revenue && maxProfit !== undefined ? maxProfit / revenue * 100 : undefined,
        minProfitPerManualHour: manualRates.length ? Math.min(...manualRates) : undefined,
        maxProfitPerManualHour: manualRates.length ? Math.max(...manualRates) : undefined,
        minProfitPerAutoHour: autoRates.length ? Math.min(...autoRates) : undefined,
        maxProfitPerAutoHour: autoRates.length ? Math.max(...autoRates) : undefined,
        minGrossPerTotalHour: grossRates.length ? Math.min(...grossRates) : undefined,
        maxGrossPerTotalHour: grossRates.length ? Math.max(...grossRates) : undefined,
        minNetPerTotalHour: netRates.length ? Math.min(...netRates) : undefined,
        maxNetPerTotalHour: netRates.length ? Math.max(...netRates) : undefined,
        stations: unique([...min.stations, ...max.stations]),
        skills: unique([...min.skills, ...max.skills, ...requirements.map((requirement) => requirement.name)]),
        rawInputs: unique([...Object.keys(min.rawInputs), ...Object.keys(max.rawInputs)]),
        complete: min.complete && max.complete,
        provisional: min.provisional || max.provisional,
        requirements,
        eligible: requirements.every((requirement) => requirement.met),
        calculationRules,
      });
    }
  }
  return lines;
}

export function median(values: number[]): number | undefined {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function buildBalanceSuggestion(line: ProductionLine, benchmark: number | undefined, metric: "gross" | "net" = "gross"): BalanceSuggestion {
  const lowRate = metric === "gross" ? line.minGrossPerTotalHour : line.minNetPerTotalHour;
  const highRate = metric === "gross" ? line.maxGrossPerTotalHour : line.maxNetPerTotalHour;
  const current = lowRate !== undefined && highRate !== undefined
    ? (lowRate + highRate) / 2
    : undefined;
  if (!line.complete || benchmark === undefined || benchmark <= 0 || current === undefined || line.revenue === undefined || line.minProfit === undefined || line.maxProfit === undefined) {
    return { direction: "unavailable" };
  }
  const averageProfit = (line.minProfit + line.maxProfit) / 2;
  const averageCost = (line.min.cost + line.max.cost) / 2;
  const averageManualSeconds = (line.min.manualSeconds + line.max.manualSeconds) / 2;
  const averageAutomaticSeconds = (line.min.automaticSeconds + line.max.automaticSeconds) / 2;
  const averageTotalSeconds = (line.min.productionSeconds + line.max.productionSeconds) / 2;
  const targetAmount = benchmark * averageTotalSeconds / 3600;
  const targetSalePrice = metric === "gross" ? targetAmount : averageCost + targetAmount;
  const currentAmount = metric === "gross" ? line.revenue : averageProfit;
  const targetTotalSeconds = currentAmount > 0 ? currentAmount / benchmark * 3600 : undefined;
  const targetManualSeconds = targetTotalSeconds === undefined || line.calculationRules.manualTimeWeight === 0 ? undefined : Math.max(0, (targetTotalSeconds - averageAutomaticSeconds * line.calculationRules.automaticTimeWeight) / line.calculationRules.manualTimeWeight);
  const targetAutomaticSeconds = targetTotalSeconds === undefined || line.calculationRules.automaticTimeWeight === 0 ? undefined : Math.max(0, (targetTotalSeconds - averageManualSeconds * line.calculationRules.manualTimeWeight) / line.calculationRules.automaticTimeWeight);
  const gapPercent = (current - benchmark) / benchmark * 100;
  return {
    direction: Math.abs(gapPercent) <= 5 ? "on-target" : gapPercent > 0 ? "above" : "below",
    gapPercent,
    targetSalePrice,
    salePriceDelta: targetSalePrice - (line.salePrice ?? 0),
    targetManualSeconds,
    manualSecondsDelta: targetManualSeconds === undefined ? undefined : targetManualSeconds - averageManualSeconds,
    targetAutomaticSeconds,
    automaticSecondsDelta: targetAutomaticSeconds === undefined ? undefined : targetAutomaticSeconds - averageAutomaticSeconds,
    costAdjustment: averageProfit - benchmark * averageTotalSeconds / 3600,
    targetTotalSeconds,
    targetOutputQty: line.revenue && line.revenue !== 0 ? line.outputQty * targetAmount / line.revenue : undefined,
  };
}
