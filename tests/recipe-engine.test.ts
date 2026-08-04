import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  calculateEstimates,
  defaultMapping,
  detectMapping,
  normalizeData,
  normalizeSkills,
  type Item,
} from "../app/lib/recipe-engine.ts";
import { analyzeProductionLines, buildBalanceSuggestion } from "../app/lib/line-analysis.ts";
import { DEFAULT_CALCULATION_RULES, calculationRulesAreDefault, sanitizeCalculationRules } from "../app/lib/calculation-rules.ts";

const objectData = {
  Flaxa: {
    type: "Materials",
    schematics: [{
      qty: 10,
      cost: { "Flaxa Seeds": 1 },
      produce_by: { Field: { CraftingTime: { ManualCraftingTime: 0 }, by_product: {} } },
    }],
  },
  "Flaxa Seeds": {
    type: "Seeds",
    schematics: [{
      qty: 1,
      cost: { Flaxa: 1 },
      produce_by: { Separator: { CraftingTime: { ManualCraftingTime: 720 }, by_product: {} } },
    }],
  },
  "Flaxa Thread": {
    type: "Materials",
    schematics: [{
      qty: 12,
      cost: { Flaxa: 1 },
      produce_by: { Bench: { CraftingTime: { ManualCraftingTime: 480 }, by_product: {} } },
    }],
  },
};

test("normalizes object-keyed and array-based datasets equivalently", () => {
  const objectResult = normalizeData(objectData, defaultMapping);
  const arrayData = {
    items: Object.entries(objectData).map(([name, item]) => ({ name, ...item })),
  };
  const arrayMapping = detectMapping(arrayData);
  const arrayResult = normalizeData(arrayData, arrayMapping);
  assert.deepEqual(
    arrayResult.items.map((item) => [item.name, item.recipes.length]),
    objectResult.items.map((item) => [item.name, item.recipes.length]),
  );
});

test("includes a named detail record from the sample envelope", () => {
  const envelope = { detail: objectData.Flaxa, ingredients_data: { "Flaxa Thread": objectData["Flaxa Thread"] } };
  const mapping = detectMapping(envelope);
  mapping.rootItemName = "Flaxa";
  const result = normalizeData(envelope, mapping);
  assert.ok(result.items.some((item) => item.name === "Flaxa" && item.recipes.length === 1));
  assert.ok(result.items.some((item) => item.name === "Flaxa Thread"));
});

test("calculates forward with output quantity and manual labor", () => {
  const { items } = normalizeData(objectData, defaultMapping);
  const result = calculateEstimates(items, { Flaxa: 12 }, 36);
  assert.ok(result.estimates["Flaxa Thread"]);
  assert.ok(Math.abs(result.estimates["Flaxa Thread"].low - 1.4) < 1e-9);
  assert.ok(Math.abs(result.estimates["Flaxa Thread"].high - 1.4) < 1e-9);
});

test("skill levels reduce linked manual work time and labor cost", () => {
  const { items } = normalizeData(objectData, defaultMapping);
  const threadRecipe = items.find((item) => item.name === "Flaxa Thread")!.recipes[0];
  threadRecipe.speedSkills = [{ id: "SK_TAILORING", name: "Tailoring", bonusPerLevel: 0.1 }];
  const result = calculateEstimates(items, { Flaxa: 12 }, 36, { SK_TAILORING: 5 });
  assert.ok(Math.abs(result.recipeCalculations[threadRecipe.id].effectiveManualSeconds - 320) < 1e-9);
  assert.ok(Math.abs(result.estimates["Flaxa Thread"].low - (15.2 / 12)) < 1e-9);
});

test("back-solves the sole unknown ingredient", () => {
  const { items } = normalizeData(objectData, defaultMapping);
  const result = calculateEstimates(items, { "Flaxa Thread": 1.4 }, 36);
  assert.ok(Math.abs(result.estimates.Flaxa.low - 12) < 1e-9);
});

test("does not invent a split for multiple unresolved inputs", () => {
  const items: Item[] = [{
    name: "Composite",
    recipes: [{
      id: "composite-1",
      output: "Composite",
      outputQty: 1,
      station: "Mixer",
      manualSeconds: 0,
      ingredients: [{ name: "A", qty: 1 }, { name: "B", qty: 1 }],
      byproducts: [],
    }],
  }, { name: "A", recipes: [] }, { name: "B", recipes: [] }];
  const result = calculateEstimates(items, { Composite: 10 }, null);
  assert.equal(result.estimates.A, undefined);
  assert.equal(result.estimates.B, undefined);
});

test("subtracts known by-product value and flags unknown credit", () => {
  const items: Item[] = [{
    name: "Main",
    recipes: [{
      id: "main-1",
      output: "Main",
      outputQty: 1,
      station: "Still",
      manualSeconds: 0,
      ingredients: [{ name: "Input", qty: 2 }],
      byproducts: [{ name: "Credit", qty: 1, chance: 50 }],
    }],
  }, { name: "Input", recipes: [] }, { name: "Credit", recipes: [] }];
  const known = calculateEstimates(items, { Input: 10, Credit: 4 }, null);
  assert.equal(known.estimates.Main.low, 18);
  assert.equal(known.estimates.Main.provisional, false);
  const unknown = calculateEstimates(items, { Input: 10 }, null);
  assert.equal(unknown.estimates.Main.low, 20);
  assert.equal(unknown.estimates.Main.provisional, true);
  assert.deepEqual(unknown.estimates.Main.missingByproducts, ["Credit"]);
});

test("unanchored cycles terminate unresolved and anchored cycles terminate", () => {
  const { items } = normalizeData(objectData, defaultMapping);
  const unresolved = calculateEstimates(items, {}, null);
  assert.equal(unresolved.estimates.Flaxa, undefined);
  assert.ok(unresolved.iterations < 34);
  const anchored = calculateEstimates(items, { Flaxa: 5 }, null);
  assert.ok(anchored.estimates["Flaxa Thread"]);
  assert.ok(anchored.iterations < 34);
});

test("bundled export contains merged items, schematics, and skills", () => {
  const bundled = JSON.parse(readFileSync(new URL("../public/data/items.json", import.meta.url), "utf8"));
  assert.ok(bundled.items.length > 1000);
  assert.ok(bundled.skills.length > 40);
  assert.ok(bundled._meta.schematicCount > 700);
  const thread = bundled.items.find((item: { name: string }) => item.name === "Flaxa Thread");
  assert.equal(thread.schematics[0].produce_by["Tailoring Bench"].skillRequirement.name, "Tailoring");
  assert.ok(thread.schematics[0].produce_by["Tailoring Bench"].speedSkills.length > 0);
});

test("production line ranking spans cheapest and costliest upstream recipes", () => {
  const items: Item[] = [
    { name: "Ore", recipes: [] },
    { name: "Scrap", recipes: [] },
    { name: "Ingot", recipes: [
      { id: "smelt", output: "Ingot", outputQty: 1, station: "Smelter", manualSeconds: 3600, automaticSeconds: 7200, ingredients: [{ name: "Ore", qty: 2 }], byproducts: [] },
      { id: "recycle", output: "Ingot", outputQty: 1, station: "Recycler", manualSeconds: 1800, automaticSeconds: 3600, ingredients: [{ name: "Scrap", qty: 1 }], byproducts: [] },
    ] },
    { name: "Widget", recipes: [
      { id: "widget", output: "Widget", outputQty: 1, station: "Assembler", manualSeconds: 3600, automaticSeconds: 3600, ingredients: [{ name: "Ingot", qty: 2 }], byproducts: [] },
    ] },
  ];
  const fixed = { Ore: 2, Scrap: 10, Widget: 30 };
  const estimates = calculateEstimates(items, fixed, 4).estimates;
  const widget = analyzeProductionLines(items, fixed, 4, {}, estimates).find((line) => line.id === "widget")!;
  assert.equal(widget.min.cost, 20);
  assert.equal(widget.max.cost, 28);
  assert.equal(widget.minProfit, 2);
  assert.equal(widget.maxProfit, 10);
  assert.deepEqual(widget.rawInputs.sort(), ["Ore", "Scrap"]);
  const suggestion = buildBalanceSuggestion(widget, 2);
  assert.notEqual(suggestion.direction, "unavailable");
  assert.ok(Number.isFinite(suggestion.targetSalePrice));
});

test("farm seeds and wild crops bound the Fabric line without lumber cycles", () => {
  const bundled = JSON.parse(readFileSync(new URL("../public/data/items.json", import.meta.url), "utf8"));
  const { items } = normalizeData(bundled, detectMapping(bundled));
  const fixed = { Fabric: 100 };
  const estimates = calculateEstimates(items, fixed, null).estimates;
  const fabric = analyzeProductionLines(items, fixed, null, {}, estimates).find((line) => line.output === "Fabric")!;
  assert.equal(fabric.complete, true);
  assert.ok(fabric.min.origins.includes("Flaxa · wild harvest"));
  assert.ok(fabric.max.origins.includes("Flaxa Seeds · farming seed"));
  assert.deepEqual(fabric.min.steps.map((step) => step.output), ["Flaxa Thread", "Retted Flaxa", "Fabric"]);
  assert.deepEqual(fabric.max.steps.map((step) => step.output), ["Flaxa", "Flaxa Thread", "Retted Flaxa", "Fabric"]);
  assert.ok(!fabric.rawInputs.some((name) => /Lumber|Biomass|Sapling/i.test(name)));
  assert.deepEqual(fabric.max.unresolved, []);
});

test("production-hour proof reproduces Copper Wire and exact-ratio Fabric throughput", () => {
  const bundled = JSON.parse(readFileSync(new URL("../public/data/items.json", import.meta.url), "utf8"));
  const { items } = normalizeData(bundled, detectMapping(bundled));
  const skills = normalizeSkills(bundled);
  const copperRecipe = items.find((item) => item.name === "Copper Wire")!.recipes[0];
  const fabricRecipe = items.find((item) => item.name === "Fabric")!.recipes[0];
  const npcPayouts = { [copperRecipe.id]: 879, [fabricRecipe.id]: 738 };
  const lines = analyzeProductionLines(items, {}, null, {}, {}, null, skills, npcPayouts);
  const copper = lines.find((line) => line.id === copperRecipe.id)!;
  const fabric = lines.find((line) => line.id === fabricRecipe.id)!;

  assert.equal(copper.min.manualSeconds, 10440);
  assert.equal(copper.min.automaticSeconds, 19920);
  assert.equal(copper.min.manualSeconds + copper.min.automaticSeconds, 30360);
  assert.equal(copper.min.productionSeconds, 30360);
  assert.ok(Math.abs(copper.maxGrossPerTotalHour! - (879 / (30360 / 3600))) < 1e-9);
  assert.deepEqual(copper.min.steps[1].ingredientQtyPerRun, [{ name: "Chalcopyrite Ore", qty: 2 }]);
  assert.equal(copper.min.steps[1].outputQtyPerRun, 4);
  assert.equal(copper.min.steps[1].runs, 5);
  assert.equal(copper.min.steps[1].baseManualSecondsPerRun, 720);
  assert.equal(copper.min.steps[1].automaticSecondsPerRun, 1440);
  assert.ok(copper.requirements.some((requirement) => requirement.name === "Engineering" && requirement.level === 13 && !requirement.met));

  assert.equal(fabric.min.manualSeconds, 6700);
  assert.equal(fabric.min.automaticSeconds, 0);
  assert.ok(Math.abs(fabric.maxGrossPerTotalHour! - (738 / (6700 / 3600))) < 1e-9);
  assert.ok(Math.abs(fabric.min.steps[0].runs - 25 / 12) < 1e-9);

  const withMachineCost = analyzeProductionLines(items, {}, null, {}, {}, 10, skills, npcPayouts).find((line) => line.id === copperRecipe.id)!;
  assert.ok(Math.abs(withMachineCost.min.machineCost - 10 * 19920 / 3600) < 1e-9);
  assert.ok(withMachineCost.minNetPerTotalHour! < withMachineCost.minGrossPerTotalHour!);
});

test("editable calculation rules change throughput and can be restored exactly", () => {
  const bundled = JSON.parse(readFileSync(new URL("../public/data/items.json", import.meta.url), "utf8"));
  const { items } = normalizeData(bundled, detectMapping(bundled));
  const skills = normalizeSkills(bundled);
  const copperRecipe = items.find((item) => item.name === "Copper Wire")!.recipes[0];
  const customRules = { ...DEFAULT_CALCULATION_RULES, automaticTimeWeight: 0.5 };
  const copper = analyzeProductionLines(items, {}, null, {}, {}, null, skills, { [copperRecipe.id]: 879 }, customRules)
    .find((line) => line.id === copperRecipe.id)!;

  assert.equal(copper.min.productionSeconds, 10440 + 19920 * 0.5);
  assert.ok(Math.abs(copper.maxGrossPerTotalHour! - (879 / (20400 / 3600))) < 1e-9);
  assert.equal(calculationRulesAreDefault(customRules), false);
  assert.deepEqual(sanitizeCalculationRules(undefined), DEFAULT_CALCULATION_RULES);
  assert.equal(calculationRulesAreDefault(sanitizeCalculationRules(DEFAULT_CALCULATION_RULES)), true);
});
