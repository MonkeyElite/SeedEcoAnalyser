import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const sourceRoot = process.argv[2];
const outputFile = process.argv[3];

if (!sourceRoot || !outputFile) {
  throw new Error("Usage: node scripts/import-seed-data.mjs <export-directory> <output-file>");
}

async function readEntries(folder) {
  const directory = path.join(sourceRoot, folder, "entries");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".json"));
  const rows = [];
  for (const file of files) {
    try {
      rows.push(JSON.parse(await readFile(path.join(directory, file), "utf8")));
    } catch (error) {
      console.warn(`Skipped ${folder}/${file}: ${error.message}`);
    }
  }
  return rows;
}

function titleCase(value) {
  return String(value ?? "")
    .replace(/^(GMT|SCH|SK|TAG_MACHINE)_/, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function itemType(identifier, parentIdentifier) {
  const source = identifier || parentIdentifier || "";
  if (source.startsWith("GMT_MATERIAL")) return "Materials";
  if (source.startsWith("GMT_PRODUCT")) return "Products";
  if (source.startsWith("GMT_SEED")) return "Seeds";
  if (source.startsWith("GMT_CONSUMABLE")) return "Consumables";
  if (source.startsWith("GMT_TOOL")) return "Tools";
  return titleCase(parentIdentifier || "Item");
}

function isUsableSchematic(entry) {
  const id = entry?.Identifier ?? "";
  return id.startsWith("SCH_") && !/(^|_)(TEST|DEBUG)(_|$)/.test(id) && entry?.Schematic?.Outputs?.OutputList?.length;
}

const [gameTypes, schematics, skillEntries] = await Promise.all([
  readEntries("GameType"),
  readEntries("Schematics"),
  readEntries("Skills"),
]);

const gameTypeById = new Map(gameTypes.filter((entry) => entry?.Identifier).map((entry) => [entry.Identifier, entry]));

const rawSkills = skillEntries
  .filter((entry) => entry?.Identifier?.startsWith("SK_") && !/(DEBUG|TEST)/.test(entry.Identifier) && entry.Skill?.Name)
  .map((entry) => ({
    id: entry.Identifier,
    name: entry.Skill.Name,
    description: entry.Skill.Description ?? "",
    category: entry.Skill.SkillCategory ?? "",
    maxLevel: Number(entry.Skill.MaxLevel ?? 50),
    parentId: entry.ParentIdentifier || undefined,
    unlockedBy: entry.Skill.UnlockedBySkill?.Skill && entry.Skill.UnlockedBySkill.Skill !== "Undefined"
      ? { id: entry.Skill.UnlockedBySkill.Skill, level: Number(entry.Skill.UnlockedBySkill.Level ?? 0) }
      : undefined,
    speedBonusPerLevel: Number(entry.SkillSpeedBonus?.SpeedBonusPerLevel ?? 0),
    affectedSchematics: [
      ...(entry.SkillSpeedBonus?.AffectsSchematicsManualTime ?? []),
      ...(entry.SkillSpeedBonus?.AffectsSchematicsAutonomousTime ?? []),
    ],
  }));

const skillById = new Map(rawSkills.map((skill) => [skill.id, skill]));
const skillName = (id) => skillById.get(id)?.name ?? titleCase(id);
const skills = rawSkills.map(({ affectedSchematics, ...skill }) => ({
  ...skill,
  unlockedBy: skill.unlockedBy ? { ...skill.unlockedBy, name: skillName(skill.unlockedBy.id) } : undefined,
  affectedSchematicCount: new Set(affectedSchematics).size,
})).sort((a, b) => a.name.localeCompare(b.name));

const speedSkillsBySchematic = new Map();
for (const skill of rawSkills) {
  for (const schematicId of new Set(skill.affectedSchematics)) {
    const values = speedSkillsBySchematic.get(schematicId) ?? [];
    values.push({ id: skill.id, name: skill.name, bonusPerLevel: skill.speedBonusPerLevel });
    speedSkillsBySchematic.set(schematicId, values);
  }
}

const validSchematics = schematics.filter(isUsableSchematic);
const relevantIds = new Set();
for (const entry of gameTypes) {
  if (entry?.Identifier?.startsWith("GMT_") && entry.Info?.Name && !/(^|_)(TEST|DEBUG)(_|$)/.test(entry.Identifier) && !entry.GameTypeLLMData?.IsDisabled) {
    relevantIds.add(entry.Identifier);
  }
  if (entry?.CropData?.CropGametype) {
    relevantIds.add(entry.Identifier);
    relevantIds.add(entry.CropData.CropGametype);
  }
}
for (const entry of validSchematics) {
  for (const input of entry.Schematic.Inputs ?? []) if (input.Resource) relevantIds.add(input.Resource);
  for (const output of entry.Schematic.Outputs.OutputList ?? []) if (output.Resource) relevantIds.add(output.Resource);
}

const baseNameById = new Map();
const nameCounts = new Map();
for (const id of relevantIds) {
  const entry = gameTypeById.get(id);
  const baseName = entry?.Info?.Name?.trim() || titleCase(id);
  baseNameById.set(id, baseName);
  nameCounts.set(baseName, (nameCounts.get(baseName) ?? 0) + 1);
}
const uniqueNameById = new Map([...relevantIds].map((id) => {
  const baseName = baseNameById.get(id);
  return [id, nameCounts.get(baseName) > 1 ? `${baseName} · ${titleCase(id)}` : baseName];
}));
const itemName = (id) => uniqueNameById.get(id) ?? titleCase(id);

const itemById = new Map();
for (const id of relevantIds) {
  const entry = gameTypeById.get(id) ?? {};
  itemById.set(id, {
    name: itemName(id),
    sourceId: id,
    itemId: entry.UniqueId,
    type: itemType(id, entry.ParentIdentifier),
    description: entry.Info?.Description || entry.GameTypeLLMData?.Description || "",
    itemIcon: entry.Icon?.Default || undefined,
    wildHarvestable: (entry.GameTags?.Tags ?? []).includes("TAG_RESOURCE_HARVESTABLE"),
    farmingSeed: Boolean(entry.CropData?.CropGametype),
    schematics: [],
  });
}

function ensureItem(id) {
  if (!itemById.has(id)) {
    itemById.set(id, { name: itemName(id), sourceId: id, type: itemType(id), description: "", schematics: [] });
  }
  return itemById.get(id);
}

for (const entry of validSchematics) {
  const schematic = entry.Schematic;
  const outputs = schematic.Outputs.OutputList ?? [];
  const primary = outputs[0];
  if (!primary?.Resource || Number(primary.Amount) <= 0) continue;

  const cost = {};
  for (const input of schematic.Inputs ?? []) {
    if (!input.Resource || Number(input.Amount) <= 0) continue;
    ensureItem(input.Resource);
    cost[itemName(input.Resource)] = Number(input.Amount);
  }
  const byProducts = {};
  for (const output of outputs.slice(1)) {
    if (!output.Resource || Number(output.Amount) <= 0) continue;
    ensureItem(output.Resource);
    byProducts[itemName(output.Resource)] = {
      qty: Number(output.Amount),
      chances: Number(output.Probability ?? 100),
    };
  }

  const requirement = entry.SchematicProductionSkillRequirement?.Skill;
  const requirementLevel = Number(entry.SchematicProductionSkillRequirement?.Level ?? 0);
  const impactedSkill = entry.SchematicActivityOutcomes?.ImpactedBySkill;
  const trained = entry.SchematicProductionSkillXPContribution?.TrainedSkills ?? [];
  const multiplier = Number(entry.SchematicProductionSkillXPContribution?.ExperienceMultiplier ?? 1);
  const stations = schematic.Machines?.CraftedBy?.length ? schematic.Machines.CraftedBy : ["Direct"];
  const produceBy = {};
  for (const stationId of stations) {
    produceBy[titleCase(stationId)] = {
      schematicId: entry.Identifier,
      CraftingTime: {
        ManualCraftingTime: Number(schematic.Process?.CraftingTime?.ManualTimeInSeconds ?? 0),
        AutomaticCraftingTime: Number(schematic.Process?.CraftingTime?.AutoTimeInSeconds ?? 0),
      },
      by_product: byProducts,
      skillRequirement: requirement && requirement !== "Undefined" ? { id: requirement, name: skillName(requirement), level: requirementLevel } : undefined,
      trainedSkills: trained.filter((id) => id && id !== "Undefined").map((id) => ({ id, name: skillName(id), multiplier })),
      impactedBySkill: impactedSkill && impactedSkill !== "Undefined" ? { id: impactedSkill, name: skillName(impactedSkill) } : undefined,
      speedSkills: speedSkillsBySchematic.get(entry.Identifier) ?? [],
      difficulty: entry.SchematicActivityOutcomes?.Difficulty,
    };
  }

  ensureItem(primary.Resource).schematics.push({
    sourceId: entry.Identifier,
    qty: Number(primary.Amount),
    probability: Number(primary.Probability ?? 100),
    cost,
    produce_by: produceBy,
  });
}

for (const entry of gameTypes) {
  const crop = entry?.CropData;
  if (!entry?.Identifier || !crop?.CropGametype || Number(crop.CropYield) <= 0) continue;
  const seed = ensureItem(entry.Identifier);
  const output = ensureItem(crop.CropGametype);
  const schematicId = `CROP_${entry.Identifier}`;
  const growthSeconds = Number(crop.GrowthSpeed) > 0 ? (3600 / Number(crop.GrowthSpeed)) : 0;
  output.schematics.push({
    sourceId: schematicId,
    qty: Number(crop.CropYield),
    probability: 100,
    cost: { [seed.name]: 1 },
    produce_by: {
      "Farming Field": {
        schematicId,
        CraftingTime: { ManualCraftingTime: 0, AutomaticCraftingTime: growthSeconds },
        by_product: {},
        skillRequirement: { id: "SK_FARMING", name: skillName("SK_FARMING"), level: 0 },
        trainedSkills: [{ id: "SK_FARMING", name: skillName("SK_FARMING"), multiplier: 1 }],
        impactedBySkill: { id: "SK_FARMING", name: skillName("SK_FARMING") },
        speedSkills: [],
      },
    },
  });
}

const items = [...itemById.values()]
  .sort((a, b) => a.name.localeCompare(b.name));

const output = {
  _meta: {
    source: sourceRoot,
    exportDate: path.basename(sourceRoot),
    generatedAt: new Date().toISOString(),
    itemCount: items.length,
    schematicCount: items.reduce((sum, item) => sum + item.schematics.length, 0),
    skillCount: skills.length,
  },
  items,
  skills,
};

await writeFile(outputFile, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(JSON.stringify(output._meta));
