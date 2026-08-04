"use client";

import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  calculateEstimates,
  defaultMapping,
  detectMapping,
  normalizeData,
  normalizeSkills,
  type CalculationResult,
  type Estimate,
  type Item,
  type Recipe,
  type SchemaMapping,
  type Skill,
} from "./lib/recipe-engine";
import {
  analyzeProductionLines,
  buildBalanceSuggestion,
  median,
  type ProductionLine,
} from "./lib/line-analysis";
import {
  calculationRulesAreDefault,
  DEFAULT_CALCULATION_RULES,
  sanitizeCalculationRules,
  type CalculationRules,
} from "./lib/calculation-rules";

const DATA_URL = "/data/items.json";
const DB_NAME = "production-line-calculator";
const STORAGE_KEY = "production-line-settings-v1";
const LINE_COLUMNS_STORAGE_KEY = "production-line-columns-v1";

type SavedDataset = { rawText: string; mapping: SchemaMapping };
type ViewMode = "graph" | "table" | "lines" | "rules";

const mappingFields: Array<{ key: keyof SchemaMapping; label: string; hint: string }> = [
  { key: "itemsPath", label: "Items collection", hint: "Blank means document root" },
  { key: "rootItemName", label: "Envelope root item", hint: "Optional name for a top-level detail record" },
  { key: "itemNamePath", label: "Item name", hint: "@key or a field path" },
  { key: "recipesPath", label: "Recipes", hint: "Path within each item" },
  { key: "outputQtyPath", label: "Output quantity", hint: "Path within each recipe" },
  { key: "ingredientsPath", label: "Ingredients", hint: "Map or array path" },
  { key: "ingredientNamePath", label: "Ingredient name", hint: "@key or a field path" },
  { key: "ingredientQtyPath", label: "Ingredient quantity", hint: "@value or a field path" },
  { key: "producersPath", label: "Producer variants", hint: "Map or array path" },
  { key: "producerNamePath", label: "Producer name", hint: "@key or a field path" },
  { key: "manualTimePath", label: "Manual time (seconds)", hint: "Path within a producer" },
  { key: "byproductsPath", label: "By-products", hint: "Path within a producer" },
  { key: "byproductNamePath", label: "By-product name", hint: "@key or a field path" },
  { key: "byproductQtyPath", label: "By-product quantity", hint: "Path within a by-product" },
  { key: "byproductChancePath", label: "By-product chance", hint: "Percent path" },
];

function money(value: number): string {
  const abs = Math.abs(value);
  const digits = abs !== 0 && abs < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value);
}

function estimateLabel(estimate?: Estimate): string {
  if (!estimate) return "Can’t be estimated";
  if (Math.abs(estimate.low - estimate.high) < 1e-8) return money(estimate.low);
  return `${money(estimate.low)} – ${money(estimate.high)}`;
}

function duration(seconds: number): string {
  if (!seconds) return "No manual work";
  if (seconds < 60) return `${seconds}s manual`;
  const minutes = seconds / 60;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)}m manual`;
}

function titleCategory(value: string): string {
  return value.replace(/_Category$/i, "").replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compactTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)}m`;
  return `${(seconds / 3600).toFixed(seconds < 36000 ? 1 : 0)}h`;
}

function numericRange(low: number | undefined, high: number | undefined, suffix = ""): string {
  if (low === undefined || high === undefined) return "—";
  const left = money(low);
  const right = money(high);
  return Math.abs(low - high) < 1e-8 ? `${left}${suffix}` : `${left} – ${right}${suffix}`;
}

function readSavedDataset(): Promise<SavedDataset | null> {
  return new Promise((resolve) => {
    if (!("indexedDB" in window)) return resolve(null);
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const transaction = request.result.transaction("data", "readonly");
      const get = transaction.objectStore("data").get("active");
      get.onsuccess = () => resolve((get.result as SavedDataset | undefined) ?? null);
      get.onerror = () => resolve(null);
    };
  });
}

function writeSavedDataset(dataset: SavedDataset | null): Promise<void> {
  return new Promise((resolve) => {
    if (!("indexedDB" in window)) return resolve();
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("data");
    request.onerror = () => resolve();
    request.onsuccess = () => {
      const transaction = request.result.transaction("data", "readwrite");
      const store = transaction.objectStore("data");
      if (dataset) store.put(dataset, "active");
      else store.delete("active");
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    };
  });
}

function StatusBadge({ estimate }: { estimate?: Estimate }) {
  if (!estimate) return <span className="status status-missing">Unresolved</span>;
  if (estimate.direction === "fixed") return <span className="status status-fixed">Exact</span>;
  if (estimate.provisional) return <span className="status status-provisional">Provisional</span>;
  if (estimate.low < 0) return <span className="status status-credit">Net credit</span>;
  return <span className="status status-estimated">Estimated</span>;
}

function ItemNode({
  item,
  estimate,
  selected,
  onSelect,
}: {
  item?: Item;
  estimate?: Estimate;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  const name = item?.name ?? "Unknown item";
  return (
    <button className={`item-node ${selected ? "is-selected" : ""}`} onClick={() => onSelect(name)} type="button">
      <span className="item-node-topline">
        <span className="item-name">{name}</span>
        <StatusBadge estimate={estimate} />
      </span>
      <span className={`item-price ${!estimate ? "is-empty" : ""}`}>{estimateLabel(estimate)}</span>
      <span className="item-meta">{item?.type || (item?.referencedOnly ? "Referenced only" : "Item")}</span>
    </button>
  );
}

function RecipeCard({
  recipe,
  calculation,
  onSelect,
}: {
  recipe: Recipe;
  calculation?: CalculationResult["recipeCalculations"][string];
  onSelect: (name: string) => void;
}) {
  const effectiveSeconds = calculation?.effectiveManualSeconds ?? recipe.manualSeconds;
  const isSkillAdjusted = effectiveSeconds + 0.01 < recipe.manualSeconds;
  return (
    <div className="recipe-node">
      <div className="recipe-title-row">
        <span className="recipe-mark">R</span>
        <div>
          <strong>{recipe.station}</strong>
          <span>{recipe.outputQty} × {recipe.output}</span>
        </div>
      </div>
      <div className="recipe-equation">
        {recipe.ingredients.length ? recipe.ingredients.map((ingredient, index) => (
          <span key={`${ingredient.name}-${index}`}>{index > 0 && " + "}{ingredient.qty} {ingredient.name}</span>
        )) : <span>No material inputs</span>}
      </div>
      <div className="recipe-meta-row">
        <span>{duration(effectiveSeconds)}{isSkillAdjusted ? " after skills" : ""}</span>
        {calculation && calculation.labor > 0 && <span>Labor {money(calculation.labor)}</span>}
        {calculation && calculation.machineCost > 0 && <span>Machine {money(calculation.machineCost)}</span>}
      </div>
      {(recipe.skillRequirement || recipe.speedSkills?.length || recipe.trainedSkills?.length) ? (
        <div className="skill-strip">
          {recipe.skillRequirement && <span className="skill-required">Requires {recipe.skillRequirement.name} {recipe.skillRequirement.level}</span>}
          {recipe.speedSkills?.map((skill) => <span key={`speed-${skill.id}`}>{skill.name} +{(skill.bonusPerLevel * 100).toFixed(1)}%/lvl</span>)}
          {recipe.trainedSkills?.map((skill) => <span key={`train-${skill.id}`} className="skill-trained">Trains {skill.name}{skill.multiplier !== 1 ? ` ×${skill.multiplier}` : ""}</span>)}
        </div>
      ) : null}
      {isSkillAdjusted && <div className="skill-time-saving">Base {duration(recipe.manualSeconds)} → {duration(effectiveSeconds)}</div>}
      {recipe.byproducts.length > 0 && (
        <div className="credit-list">
          <span className="credit-label">By-product credit</span>
          {recipe.byproducts.map((byproduct) => (
            <button type="button" key={byproduct.name} onClick={() => onSelect(byproduct.name)}>
              − {byproduct.qty} {byproduct.name}{byproduct.chance < 100 ? ` @ ${byproduct.chance}%` : ""}
            </button>
          ))}
        </div>
      )}
      {calculation?.missingInputs.length ? (
        <div className="recipe-warning">Waiting for {calculation.missingInputs.join(", ")}</div>
      ) : calculation?.result ? (
        <div className="recipe-result">Recipe estimate <strong>{estimateLabel({ ...calculation.result, candidates: [calculation.result] })}</strong></div>
      ) : null}
      {calculation?.missingByproducts.length ? (
        <div className="recipe-warning provisional-copy">Excludes unresolved credit: {calculation.missingByproducts.join(", ")}</div>
      ) : calculation && calculation.creditHigh !== 0 ? (
        <div className="credit-total">Credit applied: −{money(calculation.creditLow)}{calculation.creditHigh !== calculation.creditLow ? ` – ${money(calculation.creditHigh)}` : ""}</div>
      ) : null}
    </div>
  );
}

type TreeProps = {
  name: string;
  depth: number;
  path: string[];
  direction: "up" | "down";
  itemsByName: Map<string, Item>;
  consumers: Map<string, Recipe[]>;
  calculations: CalculationResult;
  selectedName: string;
  onSelect: (name: string) => void;
};

function ProductionTree(props: TreeProps) {
  const { name, depth, path, direction, itemsByName, consumers, calculations, selectedName, onSelect } = props;
  const item = itemsByName.get(name);
  const recipes = direction === "up" ? item?.recipes ?? [] : consumers.get(name) ?? [];
  return (
    <div className={`tree tree-${direction}`}>
      <ItemNode item={item} estimate={calculations.estimates[name]} selected={selectedName === name} onSelect={onSelect} />
      {depth > 0 && recipes.length > 0 && (
        <div className="tree-branches">
          {recipes.map((recipe) => {
            const nextNames = direction === "up" ? recipe.ingredients.map((ingredient) => ingredient.name) : [recipe.output];
            return (
              <details className="branch" open={depth >= 2} key={`${direction}-${recipe.id}`}>
                <summary aria-label={`${recipe.station} recipe branch`}>
                  <span className="branch-line" />
                  <RecipeCard recipe={recipe} calculation={calculations.recipeCalculations[recipe.id]} onSelect={onSelect} />
                </summary>
                <div className="branch-children">
                  {nextNames.map((nextName) => path.includes(nextName) ? (
                    <button className="cycle-pill" type="button" key={nextName} onClick={() => onSelect(nextName)}>↻ Cycle to {nextName}</button>
                  ) : (
                    <ProductionTree
                      {...props}
                      key={`${recipe.id}-${nextName}`}
                      name={nextName}
                      depth={depth - 1}
                      path={[...path, nextName]}
                    />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

type LineSortKey = "output" | "maxProfit" | "minProfit" | "grossHour" | "netHour" | "workerHour" | "margin" | "manualTime" | "autoTime" | "totalTime" | "cost" | "steps" | "skillLevel";
type LineColumnId = "production" | "payout" | "skill" | "steps" | "manual" | "automatic" | "total" | "cost" | "revenue" | "net" | "grossRate" | "netRate" | "balance";

const DEFAULT_LINE_COLUMNS: LineColumnId[] = ["production", "payout", "skill", "steps", "manual", "automatic", "total", "cost", "revenue", "net", "grossRate", "netRate", "balance"];
const SCREENSHOT_LINE_COLUMNS: LineColumnId[] = ["production", "skill", "total", "revenue", "grossRate", "balance"];
const LINE_COLUMN_LABELS: Record<LineColumnId, string> = {
  production: "Production line",
  payout: "NPC payout / batch",
  skill: "Skill gate",
  steps: "Steps",
  manual: "Manual",
  automatic: "Autonomous",
  total: "Total time",
  cost: "Cost / batch",
  revenue: "NPC revenue",
  net: "Net / batch",
  grossRate: "Gross sc / production-hour",
  netRate: "Net sc / production-hour",
  balance: "Balance",
};

function loadLineColumnSettings(): { order: LineColumnId[]; hidden: LineColumnId[] } {
  if (typeof window === "undefined") return { order: DEFAULT_LINE_COLUMNS, hidden: [] };
  try {
    const saved = localStorage.getItem(LINE_COLUMNS_STORAGE_KEY);
    if (!saved) return { order: DEFAULT_LINE_COLUMNS, hidden: [] };
    const parsed = JSON.parse(saved) as { order?: LineColumnId[]; hidden?: LineColumnId[] };
    const validOrder = parsed.order?.filter((column): column is LineColumnId => DEFAULT_LINE_COLUMNS.includes(column));
    return {
      order: validOrder ? [...validOrder, ...DEFAULT_LINE_COLUMNS.filter((column) => !validOrder.includes(column))] : DEFAULT_LINE_COLUMNS,
      hidden: parsed.hidden?.filter((column): column is LineColumnId => column !== "production" && DEFAULT_LINE_COLUMNS.includes(column)) ?? [],
    };
  } catch {
    return { order: DEFAULT_LINE_COLUMNS, hidden: [] };
  }
}

function LineRankings({
  lines,
  fixedPrices,
  npcPayouts,
  onSetPrice,
  onSetNpcPayout,
  disabledLineIds,
  onToggleLine,
}: {
  lines: ProductionLine[];
  fixedPrices: Record<string, number>;
  npcPayouts: Record<string, number>;
  onSetPrice: (name: string, value: string) => void;
  onSetNpcPayout: (id: string, value: string) => void;
  disabledLineIds: string[];
  onToggleLine: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [station, setStation] = useState("all");
  const [skill, setSkill] = useState("all");
  const [status, setStatus] = useState("all");
  const [automation, setAutomation] = useState("all");
  const [visibility, setVisibility] = useState("active");
  const [rateMetric, setRateMetric] = useState<"gross" | "net">("gross");
  const [minProfitHour, setMinProfitHour] = useState("");
  const [minMargin, setMinMargin] = useState("");
  const [maxManualHours, setMaxManualHours] = useState("");
  const [sortKey, setSortKey] = useState<LineSortKey>("grossHour");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");
  const [benchmarkId, setBenchmarkId] = useState("median");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [initialColumns] = useState(loadLineColumnSettings);
  const [columnOrder, setColumnOrder] = useState<LineColumnId[]>(initialColumns.order);
  const [hiddenColumns, setHiddenColumns] = useState<LineColumnId[]>(initialColumns.hidden);

  useEffect(() => {
    localStorage.setItem(LINE_COLUMNS_STORAGE_KEY, JSON.stringify({ order: columnOrder, hidden: hiddenColumns }));
  }, [columnOrder, hiddenColumns]);

  const stations = useMemo(() => [...new Set(lines.flatMap((line) => line.stations))].sort(), [lines]);
  const skills = useMemo(() => [...new Set(lines.flatMap((line) => line.skills))].sort(), [lines]);
  const disabledSet = useMemo(() => new Set(disabledLineIds), [disabledLineIds]);
  const activeLines = useMemo(() => lines.filter((line) => !disabledSet.has(line.id)), [lines, disabledSet]);
  const rateBounds = useCallback((line: ProductionLine) => rateMetric === "gross"
    ? [line.minGrossPerTotalHour, line.maxGrossPerTotalHour] as const
    : [line.minNetPerTotalHour, line.maxNetPerTotalHour] as const, [rateMetric]);
  const evaluated = useMemo(() => activeLines.filter((line) => {
    const [low, high] = rateBounds(line);
    return line.complete && low !== undefined && high !== undefined;
  }), [activeLines, rateBounds]);
  const medianBenchmark = useMemo(() => median(evaluated.map((line) => {
    const [low, high] = rateBounds(line);
    return (low! + high!) / 2;
  })), [evaluated, rateBounds]);
  const selectedBenchmark = benchmarkId === "median" ? undefined : activeLines.find((line) => line.id === benchmarkId);
  const selectedBounds = selectedBenchmark ? rateBounds(selectedBenchmark) : undefined;
  const benchmark = selectedBounds?.[0] !== undefined && selectedBounds[1] !== undefined ? (selectedBounds[0] + selectedBounds[1]) / 2 : medianBenchmark;

  const bestLine = useMemo(() => [...evaluated].sort((a, b) => (rateBounds(b)[1] ?? -Infinity) - (rateBounds(a)[1] ?? -Infinity))[0], [evaluated, rateBounds]);

  const filteredLines = useMemo(() => {
    const lowered = query.trim().toLowerCase();
    const minProfitValue = minProfitHour === "" ? undefined : Number(minProfitHour);
    const minMarginValue = minMargin === "" ? undefined : Number(minMargin);
    const maxManualValue = maxManualHours === "" ? undefined : Number(maxManualHours) * 3600;
    const value = (line: ProductionLine, key: LineSortKey): number | string | undefined => {
      switch (key) {
        case "output": return line.output;
        case "maxProfit": return line.maxProfit;
        case "minProfit": return line.minProfit;
        case "grossHour": return line.maxGrossPerTotalHour;
        case "netHour": return line.maxNetPerTotalHour;
        case "workerHour": return line.maxProfitPerManualHour;
        case "margin": return line.maxMargin;
        case "manualTime": return line.min.manualSeconds;
        case "autoTime": return line.min.automaticSeconds;
        case "totalTime": return line.min.productionSeconds;
        case "cost": return line.min.cost;
        case "steps": return line.min.steps.length;
        case "skillLevel": return Math.max(0, ...line.requirements.map((requirement) => requirement.level));
      }
    };
    const result = lines.filter((line) => {
      if (lowered && ![line.output, line.finalStation, line.schematicId ?? "", ...line.stations, ...line.skills, ...line.rawInputs].join(" ").toLowerCase().includes(lowered)) return false;
      if (station !== "all" && !line.stations.includes(station)) return false;
      if (skill !== "all" && !line.skills.includes(skill)) return false;
      if (status === "priced" && line.salePrice === undefined) return false;
      if (status === "unpriced" && line.salePrice !== undefined) return false;
      if (status === "complete" && !line.complete) return false;
      if (status === "incomplete" && line.complete) return false;
      if (status === "provisional" && !line.provisional) return false;
      if (status === "eligible" && !line.eligible) return false;
      if (status === "locked" && line.eligible) return false;
      if (automation === "full" && !(line.min.fullyAutomatable && line.max.fullyAutomatable)) return false;
      if (automation === "manual" && line.min.fullyAutomatable && line.max.fullyAutomatable) return false;
      if (visibility === "active" && disabledSet.has(line.id)) return false;
      if (visibility === "disabled" && !disabledSet.has(line.id)) return false;
      const currentHighRate = rateBounds(line)[1];
      if (minProfitValue !== undefined && (currentHighRate === undefined || currentHighRate < minProfitValue)) return false;
      if (minMarginValue !== undefined && (line.maxMargin === undefined || line.maxMargin < minMarginValue)) return false;
      if (maxManualValue !== undefined && Math.max(line.min.manualSeconds, line.max.manualSeconds) > maxManualValue) return false;
      return true;
    });
    return result.sort((a, b) => {
      const aValue = value(a, sortKey);
      const bValue = value(b, sortKey);
      if (typeof aValue === "string" || typeof bValue === "string") {
        const comparison = String(aValue ?? "").localeCompare(String(bValue ?? ""));
        return sortDirection === "asc" ? comparison : -comparison;
      }
      const aNumber = aValue === undefined || !Number.isFinite(aValue) ? (sortDirection === "asc" ? Infinity : -Infinity) : aValue;
      const bNumber = bValue === undefined || !Number.isFinite(bValue) ? (sortDirection === "asc" ? Infinity : -Infinity) : bValue;
      return sortDirection === "asc" ? aNumber - bNumber : bNumber - aNumber;
    });
  }, [lines, query, station, skill, status, automation, visibility, disabledSet, minProfitHour, minMargin, maxManualHours, sortKey, sortDirection, rateBounds]);

  function changeSort(key: LineSortKey) {
    if (sortKey === key) setSortDirection((current) => current === "desc" ? "asc" : "desc");
    else {
      setSortKey(key);
      setSortDirection(key === "output" ? "asc" : "desc");
    }
  }

  function moveColumn(id: LineColumnId, direction: -1 | 1) {
    setColumnOrder((current) => {
      const index = current.indexOf(id);
      const destination = index + direction;
      if (index < 0 || destination < 0 || destination >= current.length) return current;
      const next = [...current];
      [next[index], next[destination]] = [next[destination], next[index]];
      return next;
    });
  }

  function toggleColumn(id: LineColumnId) {
    if (id === "production") return;
    setHiddenColumns((current) => current.includes(id) ? current.filter((column) => column !== id) : [...current, id]);
  }

  const visibleColumns = columnOrder.filter((column) => !hiddenColumns.includes(column));

  const SortHeader = ({ label, value, align }: { label: string; value: LineSortKey; align?: boolean }) => (
    <th className={align ? "numeric" : ""}><button type="button" className={sortKey === value ? "is-sorted" : ""} onClick={() => changeSort(value)}>{label}<span>{sortKey === value ? (sortDirection === "desc" ? "↓" : "↑") : "↕"}</span></button></th>
  );

  const ColumnHeader = ({ id }: { id: LineColumnId }) => {
    switch (id) {
      case "production": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="output" />;
      case "payout": return <th>{LINE_COLUMN_LABELS[id]}</th>;
      case "skill": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="skillLevel" />;
      case "steps": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="steps" align />;
      case "manual": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="manualTime" align />;
      case "automatic": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="autoTime" align />;
      case "total": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="totalTime" align />;
      case "cost": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="cost" align />;
      case "revenue": return <th className="numeric">{LINE_COLUMN_LABELS[id]}</th>;
      case "net": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="maxProfit" align />;
      case "grossRate": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="grossHour" align />;
      case "netRate": return <SortHeader label={LINE_COLUMN_LABELS[id]} value="netHour" align />;
      case "balance": return <th>{LINE_COLUMN_LABELS[id]}</th>;
    }
  };

  return (
    <div className="rankings-view">
      <div className="rankings-hero">
        <div><p className="eyebrow">Production portfolio</p><h2>Line profitability rankings</h2><p>Production time follows the active manual and autonomous time weights on the Calculation rules page.</p></div>
        <div className="ranking-stat"><span>Highest {rateMetric} rate</span><strong>{bestLine?.output ?? "Price more outputs"}</strong><small>{bestLine && rateBounds(bestLine)[1] !== undefined ? `${money(rateBounds(bestLine)[1]!)} sc / production-hour` : "No complete priced line yet"}</small></div>
        <div className="ranking-stat"><span>Balance benchmark</span><strong>{benchmark !== undefined ? money(benchmark) : "—"}</strong><small>{rateMetric} sc / production-hour</small></div>
        <div className="ranking-stat"><span>Evaluated</span><strong>{evaluated.length} / {activeLines.length}</strong><small>{disabledLineIds.length} disabled · complete, priced lines</small></div>
      </div>

      <div className="line-toolbar">
        <label className="line-search"><span className="sr-only">Search production lines</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search outputs, inputs, stations, skills…" /></label>
        <label><span>Station</span><select value={station} onChange={(event) => setStation(event.target.value)}><option value="all">All stations</option>{stations.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>Skill</span><select value={skill} onChange={(event) => setSkill(event.target.value)}><option value="all">All skills</option>{skills.map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
        <label><span>Availability</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All lines</option><option value="priced">Priced outputs</option><option value="unpriced">Missing sale price</option><option value="complete">Complete costs</option><option value="incomplete">Unresolved inputs</option><option value="eligible">Skill eligible</option><option value="locked">Skill locked</option><option value="provisional">Provisional credit</option></select></label>
        <label><span>Visibility</span><select value={visibility} onChange={(event) => setVisibility(event.target.value)}><option value="active">Active lines</option><option value="disabled">Disabled only</option><option value="all">Active & disabled</option></select></label>
        <label><span>Rate metric</span><select value={rateMetric} onChange={(event) => { const metric = event.target.value as "gross" | "net"; setRateMetric(metric); setSortKey(metric === "gross" ? "grossHour" : "netHour"); }}><option value="gross">Gross NPC revenue</option><option value="net">Net profit after costs</option></select></label>
        <label><span>Benchmark</span><select value={benchmarkId} onChange={(event) => setBenchmarkId(event.target.value)}><option value="median">Portfolio median</option>{evaluated.slice().sort((a, b) => a.output.localeCompare(b.output)).map((line) => <option value={line.id} key={line.id}>{line.output} · {line.finalStation}</option>)}</select></label>
        <button className={`advanced-toggle ${showAdvanced ? "active" : ""}`} type="button" onClick={() => setShowAdvanced((current) => !current)}>More filters</button>
      </div>
      {showAdvanced && (
        <div className="advanced-filters">
          <label><span>Automation</span><select value={automation} onChange={(event) => setAutomation(event.target.value)}><option value="all">Any automation</option><option value="full">Fully automatable</option><option value="manual">Has manual-only step</option></select></label>
          <label><span>Minimum {rateMetric} sc / production-hour</span><input inputMode="decimal" value={minProfitHour} onChange={(event) => setMinProfitHour(event.target.value)} placeholder="No minimum" /></label>
          <label><span>Minimum margin %</span><input inputMode="decimal" value={minMargin} onChange={(event) => setMinMargin(event.target.value)} placeholder="No minimum" /></label>
          <label><span>Maximum manual hours / batch</span><input inputMode="decimal" value={maxManualHours} onChange={(event) => setMaxManualHours(event.target.value)} placeholder="No maximum" /></label>
          <label><span>Sort by</span><select value={sortKey} onChange={(event) => setSortKey(event.target.value as LineSortKey)}><option value="grossHour">Gross sc / production-hour</option><option value="netHour">Net sc / production-hour</option><option value="workerHour">Net profit / worker-hour</option><option value="maxProfit">Maximum batch profit</option><option value="minProfit">Minimum batch profit</option><option value="margin">Margin</option><option value="totalTime">Combined time</option><option value="manualTime">Manual time</option><option value="autoTime">Autonomous time</option><option value="skillLevel">Required skill level</option><option value="cost">Production cost</option><option value="steps">Step count</option><option value="output">Output name</option></select></label>
          <button type="button" onClick={() => { setQuery(""); setStation("all"); setSkill("all"); setStatus("all"); setAutomation("all"); setVisibility("active"); setMinProfitHour(""); setMinMargin(""); setMaxManualHours(""); }}>Clear filters</button>
        </div>
      )}

      <div className="line-result-bar"><span>Showing <strong>{filteredLines.length}</strong> unique recipe lines</span><span>Production-hour uses the active manual and autonomous time weights.</span><div className="line-result-actions"><button type="button" onClick={() => setShowColumns((current) => !current)}>{showColumns ? "Close columns" : "Arrange columns"}</button><button type="button" onClick={() => { setColumnOrder([...SCREENSHOT_LINE_COLUMNS, ...DEFAULT_LINE_COLUMNS.filter((column) => !SCREENSHOT_LINE_COLUMNS.includes(column))]); setHiddenColumns(DEFAULT_LINE_COLUMNS.filter((column) => !SCREENSHOT_LINE_COLUMNS.includes(column))); }}>Screenshot layout</button></div></div>
      {showColumns && <section className="column-organizer" aria-label="Arrange ranking columns"><div><strong>Arrange horizontal columns</strong><span>Hide columns or move them left and right. Production line stays visible so rows can still be expanded.</span></div><div className="column-pills">{columnOrder.map((column, index) => { const visible = !hiddenColumns.includes(column); return <div className={`column-pill ${visible ? "is-visible" : "is-hidden"}`} key={column}><label><input type="checkbox" checked={visible} disabled={column === "production"} onChange={() => toggleColumn(column)} />{LINE_COLUMN_LABELS[column]}</label><span><button type="button" disabled={index === 0} onClick={() => moveColumn(column, -1)} aria-label={`Move ${LINE_COLUMN_LABELS[column]} left`}>←</button><button type="button" disabled={index === columnOrder.length - 1} onClick={() => moveColumn(column, 1)} aria-label={`Move ${LINE_COLUMN_LABELS[column]} right`}>→</button></span></div>; })}</div><div className="column-presets"><button type="button" onClick={() => { setColumnOrder(DEFAULT_LINE_COLUMNS); setHiddenColumns([]); }}>Show all in default order</button><button type="button" onClick={() => { setColumnOrder([...SCREENSHOT_LINE_COLUMNS, ...DEFAULT_LINE_COLUMNS.filter((column) => !SCREENSHOT_LINE_COLUMNS.includes(column))]); setHiddenColumns(DEFAULT_LINE_COLUMNS.filter((column) => !SCREENSHOT_LINE_COLUMNS.includes(column))); }}>Use compact screenshot layout</button></div></section>}
      <div className="line-table-wrap">
        <table className="line-table" style={{ minWidth: `${Math.max(760, 285 + (visibleColumns.length - 1) * 125)}px` }}>
          <caption className="sr-only">Production line profitability rankings</caption>
          <thead><tr>{visibleColumns.map((column) => <ColumnHeader id={column} key={column} />)}</tr></thead>
          <tbody>{filteredLines.map((line) => {
            const suggestion = buildBalanceSuggestion(line, benchmark, rateMetric);
            const expanded = expandedId === line.id;
            const disabled = disabledSet.has(line.id);
            const manualLow = Math.min(line.min.manualSeconds, line.max.manualSeconds);
            const manualHigh = Math.max(line.min.manualSeconds, line.max.manualSeconds);
            const autoLow = Math.min(line.min.automaticSeconds, line.max.automaticSeconds);
            const autoHigh = Math.max(line.min.automaticSeconds, line.max.automaticSeconds);
            const totalLow = Math.min(line.min.productionSeconds, line.max.productionSeconds);
            const totalHigh = Math.max(line.min.productionSeconds, line.max.productionSeconds);
            const primaryRequirement = [...line.requirements].sort((a, b) => b.level - a.level)[0];
            const renderCell = (column: LineColumnId) => {
              switch (column) {
                case "production": return <td key={column}><div className="line-name-cell"><button type="button" className="line-name-button" onClick={() => setExpandedId(expanded ? null : line.id)}><span className="expand-mark">{expanded ? "−" : "+"}</span><span><strong>{line.output}</strong><small>{line.finalStation}{line.schematicId ? ` · ${line.schematicId}` : ""}</small></span></button><button type="button" className="line-disable-button" onClick={() => onToggleLine(line.id)}>{disabled ? "Enable" : "Disable"}</button></div></td>;
                case "payout": return <td key={column}><div className="inline-price"><span>sc</span><input aria-label={`NPC payout per recipe batch for ${line.output}`} inputMode="decimal" value={npcPayouts[line.id] ?? fixedPrices[line.output] ?? ""} onChange={(event) => onSetNpcPayout(line.id, event.target.value)} placeholder="Set payout" /></div></td>;
                case "skill": return <td key={column}><div className={`skill-gate ${line.eligible ? "is-met" : "is-locked"}`}><strong>{primaryRequirement ? `${primaryRequirement.name} ${primaryRequirement.level}` : "No gate"}</strong><small>{line.eligible ? "Eligible" : `${line.requirements.filter((requirement) => !requirement.met).length} unmet`}</small></div></td>;
                case "steps": return <td className="numeric" key={column}><strong>{line.min.steps.length === line.max.steps.length ? line.min.steps.length : `${line.min.steps.length}–${line.max.steps.length}`}</strong><small>{line.rawInputs.length} raw inputs</small></td>;
                case "manual": return <td className="numeric" key={column}><strong>{compactTime(manualLow)}{manualHigh !== manualLow ? ` – ${compactTime(manualHigh)}` : ""}</strong><small>{line.max.laborCost > 0 ? `labor ${numericRange(line.min.laborCost, line.max.laborCost)}` : "no labor rate"}</small></td>;
                case "automatic": return <td className="numeric" key={column}><strong>{compactTime(autoLow)}{autoHigh !== autoLow ? ` – ${compactTime(autoHigh)}` : ""}</strong><small>{line.max.machineCost > 0 ? `machine ${numericRange(line.min.machineCost, line.max.machineCost)}` : "time still counted"}</small></td>;
                case "total": return <td className="numeric total-time-cell" key={column}><strong>{compactTime(totalLow)}{totalHigh !== totalLow ? ` – ${compactTime(totalHigh)}` : ""}</strong><small>weighted production time</small></td>;
                case "cost": return <td className="numeric" key={column}><strong>{numericRange(line.min.cost, line.max.cost)}</strong><small>{line.complete ? (line.provisional ? "provisional credit" : "complete") : `${line.min.unresolved.length || line.max.unresolved.length} unresolved`}</small></td>;
                case "revenue": return <td className="numeric" key={column}><strong>{line.revenue === undefined ? "—" : `${money(line.revenue)} sc`}</strong><small>{line.salePrice === undefined ? "set NPC payout" : `${line.outputQty} output / batch`}</small></td>;
                case "net": return <td className={`numeric ${line.maxProfit !== undefined && line.maxProfit > 0 ? "positive-value" : ""}`} key={column}><strong>{numericRange(line.minProfit, line.maxProfit)}</strong><small>{line.minMargin !== undefined ? `${numericRange(line.minMargin, line.maxMargin, "%")} margin` : "needs output price"}</small></td>;
                case "grossRate": return <td className="numeric profit-hour" key={column}><strong>{numericRange(line.minGrossPerTotalHour, line.maxGrossPerTotalHour)}</strong><small>NPC revenue ÷ total time</small></td>;
                case "netRate": return <td className="numeric profit-hour" key={column}><strong>{numericRange(line.minNetPerTotalHour, line.maxNetPerTotalHour)}</strong><small>after configured costs</small></td>;
                case "balance": return <td key={column}><span className={`balance-pill balance-${suggestion.direction}`}>{suggestion.direction === "above" ? `+${money(suggestion.gapPercent ?? 0)}%` : suggestion.direction === "below" ? `${money(suggestion.gapPercent ?? 0)}%` : suggestion.direction === "on-target" ? "On target" : "Not ready"}</span></td>;
              }
            };
            return (
              <Fragment key={line.id}>
                <tr className={`line-row ${expanded ? "is-expanded" : ""} ${disabled ? "is-disabled" : ""}`}>
                  {visibleColumns.map(renderCell)}
                </tr>
                {expanded && <tr className="line-detail-row"><td colSpan={visibleColumns.length}><LineDetails line={line} benchmark={benchmark} benchmarkLabel={selectedBenchmark ? selectedBenchmark.output : "portfolio median"} rateMetric={rateMetric} fixedPrices={fixedPrices} onSetPrice={onSetPrice} /></td></tr>}
              </Fragment>
            );
          })}</tbody>
        </table>
        {!filteredLines.length && <div className="empty-line-results">No production lines match these filters.</div>}
      </div>
    </div>
  );
}

function LineDetails({ line, benchmark, benchmarkLabel, rateMetric, fixedPrices, onSetPrice }: { line: ProductionLine; benchmark: number | undefined; benchmarkLabel: string; rateMetric: "gross" | "net"; fixedPrices: Record<string, number>; onSetPrice: (name: string, value: string) => void }) {
  const suggestion = buildBalanceSuggestion(line, benchmark, rateMetric);
  const averageManual = (line.min.manualSeconds + line.max.manualSeconds) / 2;
  const averageAuto = (line.min.automaticSeconds + line.max.automaticSeconds) / 2;
  const requirementText = (requirements: ProductionLine["min"]["requirements"]) => requirements.length
    ? requirements.map((requirement) => `${requirement.name} ${requirement.level}`).join(" · ")
    : "No skill gate";
  const quantity = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 }).format(value);
  const secondsValue = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value);

  const route = (label: string, scenario: ProductionLine["min"]) => (
    <section className="route-card">
      <div className="route-heading"><span>{label}</span><strong>{money(scenario.cost)} cost</strong></div>
      <div className="route-facts"><span>{scenario.steps.length} steps</span><span>{compactTime(scenario.manualSeconds)} manual</span><span>{compactTime(scenario.automaticSeconds)} autonomous</span><span>{compactTime(scenario.productionSeconds)} weighted production time</span><span>{money(scenario.byproductCredit)} by-product credit</span></div>
      <div className="route-flow">{scenario.steps.map((step, index) => <span key={`${step.recipeId}-${index}`}><i>{index + 1}</i>{step.output}<small>{step.station} · ×{step.runs.toFixed(step.runs < 1 ? 3 : 2)}</small><small>{compactTime(step.manualSeconds)} manual + {compactTime(step.automaticSeconds)} autonomous</small>{step.requirements.length > 0 && <small className="step-requirement">Requires {requirementText(step.requirements)}</small>}</span>)}</div>
      {scenario.origins.length > 0 && <div className="route-origins"><strong>Line starts at</strong>{scenario.origins.map((origin) => <span key={origin}>{origin}</span>)}</div>}
      <div className="raw-inputs"><strong>Starting resources</strong>{Object.entries(scenario.rawInputs).map(([name, qty]) => <span key={name}>{qty.toFixed(qty < 1 ? 3 : 2)} × {name}</span>)}</div>
      {scenario.unresolved.length > 0 && <div className="route-warning">Unresolved: {scenario.unresolved.join(", ")}</div>}
    </section>
  );

  const proof = (label: string, scenario: ProductionLine["min"]) => {
    const totalSeconds = scenario.productionSeconds;
    const totalHours = totalSeconds / 3600;
    const grossRate = line.revenue !== undefined && totalHours > 0 ? line.revenue / totalHours : undefined;
    const netEarnings = line.revenue !== undefined ? line.revenue - scenario.cost : undefined;
    const netRate = netEarnings !== undefined && totalHours > 0 ? netEarnings / totalHours : undefined;
    return (
      <article className="proof-card">
        <div className="proof-title"><span>{label}</span><strong>{grossRate === undefined ? "Set NPC price" : `${money(grossRate)} sc/h gross`}</strong></div>
        <p className="proof-route-explanation">This route starts with {scenario.origins.length ? scenario.origins.join(" and ") : "the listed starting resources"}. Each row below comes directly from one schematic in the imported JSON. “Runs” means how many times that schematic must execute to supply the next step.</p>
        <div className="proof-step-list">
          {scenario.steps.map((step, index) => {
            const recipeInputs = step.ingredientQtyPerRun.length ? step.ingredientQtyPerRun.map((ingredient) => `${quantity(ingredient.qty)} ${ingredient.name}`).join(" + ") : "No material input";
            const scaledInputs = step.ingredientQtyPerRun.length ? step.ingredientQtyPerRun.map((ingredient) => `${quantity(ingredient.qty * step.runs)} ${ingredient.name}`).join(" + ") : "No material input";
            const skillAdjusted = Math.abs(step.baseManualSecondsPerRun - step.effectiveManualSecondsPerRun) > 0.01;
            return <section className="proof-step" key={`${step.recipeId}-${index}`}>
              <div className="proof-step-heading"><i>{index + 1}</i><div><strong>{step.output}</strong><span>{step.station}{step.schematicId ? ` · ${step.schematicId}` : ""}</span></div></div>
              <dl>
                <div><dt>Recipe in JSON</dt><dd>{recipeInputs} → {quantity(step.outputQtyPerRun)} {step.output}</dd></div>
                <div><dt>Amount used by this line</dt><dd>{quantity(step.runs)} runs: {scaledInputs} → {quantity(step.outputQtyPerRun * step.runs)} {step.output}</dd></div>
                <div><dt>Manual time</dt><dd>{secondsValue(step.effectiveManualSecondsPerRun)}s per run × {quantity(step.runs)} = <b>{secondsValue(step.manualSeconds)}s</b>{skillAdjusted ? ` (base ${secondsValue(step.baseManualSecondsPerRun)}s before skill speed)` : ""}</dd></div>
                <div><dt>Autonomous time</dt><dd>{secondsValue(step.automaticSecondsPerRun)}s per run × {quantity(step.runs)} = <b>{secondsValue(step.automaticSeconds)}s</b></dd></div>
              </dl>
            </section>;
          })}
        </div>
        <div className="proof-subtotal"><span>Step-time subtotal</span><strong>{scenario.steps.map((step) => secondsValue(step.manualSeconds)).join(" + ")} = {secondsValue(scenario.manualSeconds)} manual seconds</strong><strong>{scenario.steps.map((step) => secondsValue(step.automaticSeconds)).join(" + ")} = {secondsValue(scenario.automaticSeconds)} autonomous seconds</strong></div>
        <div className="proof-time-equation"><span><b>{scenario.manualSeconds.toLocaleString()} × {line.calculationRules.manualTimeWeight}</b>manual seconds × weight</span><i>+</i><span><b>{scenario.automaticSeconds.toLocaleString()} × {line.calculationRules.automaticTimeWeight}</b>autonomous seconds × weight</span><i>=</i><span><b>{totalSeconds.toLocaleString()}</b> weighted seconds</span><i>=</i><span><b>{money(totalHours)}</b> production hours</span></div>
        <div className="proof-formulas">
          <p><span>Gross throughput</span><strong>{line.revenue === undefined ? "NPC price required" : `${money(line.revenue)} sc ÷ ${money(totalHours)} h = ${money(grossRate!)} sc/h`}</strong></p>
          <p><span>Net throughput</span><strong>{netEarnings === undefined ? "NPC price required" : `(${money(line.revenue!)} − ${money(scenario.cost)} cost) ÷ ${money(totalHours)} h = ${money(netRate!)} sc/h`}</strong></p>
        </div>
      </article>
    );
  };

  return (
    <div className="line-detail">
      <section className="calculation-proof">
        <div className="proof-heading"><div><p className="eyebrow">Calculation proof</p><h3>Where every value comes from</h3></div><span>Production time follows the active calculation weights.</span></div>
        <div className="proof-method"><article><i>1</i><div><strong>Follow the ingredients backward</strong><span>The calculator starts at this line’s output recipe, then follows every required ingredient until it reaches a wild resource, a farming seed, or another terminal input.</span></div></article><article><i>2</i><div><strong>Scale every schematic</strong><span>Runs = amount required by the next step ÷ output quantity per schematic. Fractional runs are retained, so Fabric uses 25 ÷ 12 = 2.0833 thread runs rather than rounding to 2.1.</span></div></article><article><i>3</i><div><strong>Weight production time</strong><span>For every step: seconds per run × runs. The route then applies the configured manual and autonomous time weights before adding the two totals.</span></div></article><article><i>4</i><div><strong>Divide the NPC payout</strong><span>Gross sc/hour = NPC batch payout ÷ weighted production hours. Net sc/hour first removes material, labor, machine, and by-product-adjusted costs.</span></div></article></div>
        <div className="proof-grid">{proof("Lowest-cost route", line.min)}{proof("Highest-cost route", line.max)}</div>
        <div className={`line-eligibility ${line.eligible ? "is-met" : "is-locked"}`}><strong>{line.eligible ? "Skill requirements met" : "Skill-locked with current levels"}</strong><span>{line.requirements.length ? line.requirements.map((requirement) => `${requirement.name} ${requirement.level} (you: ${requirement.configuredLevel})`).join(" · ") : "This line has no skill requirement."}</span></div>
      </section>
      <div className="terminal-prices"><div><strong>Starting-resource opportunity prices</strong><span>Optional NPC value lost by processing instead of selling raw.</span></div>{line.rawInputs.map((name) => <label key={name}><span>{name}</span><div><i>sc</i><input inputMode="decimal" value={fixedPrices[name] ?? ""} onChange={(event) => onSetPrice(name, event.target.value)} placeholder="Optional" /></div></label>)}</div>
      <div className="route-comparison">{route("Lowest-cost route", line.min)}{route("Highest-cost route", line.max)}</div>
      <section className="balance-lab">
        <div className="balance-lab-heading"><div><p className="eyebrow">Balance lab</p><h3>Ways to match {benchmarkLabel}</h3></div><span>{benchmark !== undefined ? `${money(benchmark)} ${rateMetric} sc / production-hour` : "Benchmark unavailable"}</span></div>
        {suggestion.direction === "unavailable" ? <p className="balance-message">Set the output NPC price and resolve terminal inputs to generate balancing suggestions.</p> : (
          <div className="suggestion-grid">
            <article><span className="suggestion-index">01</span><strong>NPC buy price</strong><p>{suggestion.salePriceDelta! < 0 ? "Decrease" : "Increase"} the unit price from {money(line.salePrice ?? 0)} to <b>{money(suggestion.targetSalePrice ?? 0)}</b> ({suggestion.salePriceDelta! >= 0 ? "+" : ""}{money(suggestion.salePriceDelta ?? 0)}).</p></article>
            <article><span className="suggestion-index">02</span><strong>Manual production time</strong><p>{suggestion.manualSecondsDelta! > 0 ? "Increase" : "Decrease"} total skilled manual time from {compactTime(averageManual)} to <b>{compactTime(suggestion.targetManualSeconds ?? 0)}</b>.</p></article>
            <article><span className="suggestion-index">03</span><strong>Autonomous production time</strong><p>{averageAuto > 0 && suggestion.targetAutomaticSeconds !== undefined ? `${suggestion.automaticSecondsDelta! > 0 ? "Increase" : "Decrease"} total autonomous time from ${compactTime(averageAuto)} to ${compactTime(suggestion.targetAutomaticSeconds)}.` : `No autonomous time is currently present; the target combined duration is ${compactTime(suggestion.targetTotalSeconds ?? 0)}.`}</p></article>
            {rateMetric === "gross"
              ? <article><span className="suggestion-index">04</span><strong>Output yield</strong><p>Change final output from {money(line.outputQty)} to <b>{money(suggestion.targetOutputQty ?? line.outputQty)}</b> units per batch at the current NPC unit price.</p></article>
              : <article><span className="suggestion-index">04</span><strong>Input and operating cost</strong><p>{suggestion.costAdjustment! > 0 ? `Add ${money(suggestion.costAdjustment ?? 0)} cost per batch through inputs, energy, or fees.` : `Remove ${money(Math.abs(suggestion.costAdjustment ?? 0))} cost per batch through yield or cheaper inputs.`}</p></article>}
          </div>
        )}
        <p className="balance-footnote">These are isolated levers, not a recommendation to apply all four. Each independently moves the line toward the selected production-hour benchmark. Parallel machines and overlapping batches are intentionally excluded so a scarce-machine line cannot hide its autonomous occupancy.</p>
      </section>
    </div>
  );
}

const ruleFields: Array<{ key: keyof CalculationRules; label: string; description: string; effect: string; max: number }> = [
  { key: "manualTimeWeight", label: "Manual-time weight", description: "How much each manual second occupies a production-hour.", effect: "1 counts all manual time; 0.5 counts half; 0 ignores it in throughput.", max: 5 },
  { key: "automaticTimeWeight", label: "Autonomous-time weight", description: "How much machine occupancy contributes to production time.", effect: "Keep at 1 to preserve the current scarce-machine assumption.", max: 5 },
  { key: "skillSpeedMultiplier", label: "Skill-speed effect", description: "Scales recipe speed bonuses supplied by configured skill levels.", effect: "1 applies the imported bonus fully; 0 disables skill speed reductions.", max: 2 },
  { key: "laborCostMultiplier", label: "Labor-cost multiplier", description: "Scales the employee cost produced by the global hourly rate.", effect: "Use values above 1 for overhead or below 1 for subsidized labor.", max: 10 },
  { key: "machineCostMultiplier", label: "Machine-cost multiplier", description: "Scales the autonomous machine cost produced by its hourly rate.", effect: "This changes net cost, not the time occupied by the machine.", max: 10 },
  { key: "byproductCreditMultiplier", label: "By-product credit multiplier", description: "Scales the expected value subtracted for recipe by-products.", effect: "0 ignores by-products; 1 uses their full probability-adjusted value.", max: 10 },
];

function CalculationRulesPage({ rules, hourlyRate, machineHourlyRate, onChange, onReset }: { rules: CalculationRules; hourlyRate: number | null; machineHourlyRate: number | null; onChange: (key: keyof CalculationRules, value: number) => void; onReset: () => void }) {
  const isDefault = calculationRulesAreDefault(rules);
  return <div className="rules-page">
    <header className="rules-hero">
      <div><p className="eyebrow">Auditable calculation engine</p><h2>Calculation rules</h2><p>These rules are applied live to item estimates, production-line rankings, route proofs, costs, and balancing suggestions. Changes stay in this browser.</p></div>
      <div className="rules-status"><span>Active ruleset</span><strong>{isDefault ? "Current defaults" : "Custom assumptions"}</strong><small>{isDefault ? "Matches the original implementation" : "Rankings are being recalculated live"}</small></div>
      <button className="rules-reset" type="button" disabled={isDefault} onClick={onReset}>Restore current defaults</button>
    </header>

    <section className="rules-section">
      <div className="rules-section-heading"><div><p className="eyebrow">Editable assumptions</p><h3>Change how time and cost are valued</h3></div><span>Accepted range: 0 to the displayed maximum</span></div>
      <div className="rule-editor-grid">{ruleFields.map((field) => <article className={Math.abs(rules[field.key] - DEFAULT_CALCULATION_RULES[field.key]) > 1e-9 ? "is-custom" : ""} key={field.key}>
        <div className="rule-editor-title"><label htmlFor={`rule-${field.key}`}>{field.label}</label><span>Default {DEFAULT_CALCULATION_RULES[field.key]}</span></div>
        <p>{field.description}</p><small>{field.effect}</small>
        <div className="rule-number"><input id={`rule-${field.key}`} type="number" min="0" max={field.max} step="0.05" value={rules[field.key]} onChange={(event) => onChange(field.key, Number(event.target.value))} /><span>×</span></div>
      </article>)}</div>
    </section>

    <section className="rules-section formula-section">
      <div className="rules-section-heading"><div><p className="eyebrow">Formula reference</p><h3>How every result is produced</h3></div><span>Values in green are editable above</span></div>
      <div className="formula-grid">
        <article><span className="formula-index">01</span><strong>Recipe runs</strong><code>amount needed ÷ output quantity</code><p>Runs remain fractional. This is why 25 Flaxa Thread uses 25 ÷ 12 = 2.0833 thread runs.</p></article>
        <article><span className="formula-index">02</span><strong>Skill-adjusted manual seconds</strong><code>base seconds ÷ (1 + skill bonus × <b>{rules.skillSpeedMultiplier}</b>)</code><p>Configured skill levels supply the skill bonus. Recipe requirements affect eligibility but do not otherwise change price.</p></article>
        <article><span className="formula-index">03</span><strong>Production seconds</strong><code>manual seconds × <b>{rules.manualTimeWeight}</b> + autonomous seconds × <b>{rules.automaticTimeWeight}</b></code><p>This weighted duration is the denominator for gross and net production-hour rates.</p></article>
        <article><span className="formula-index">04</span><strong>Labor cost</strong><code>{hourlyRate ?? 0} sc/hour × manual seconds ÷ 3,600 × <b>{rules.laborCostMultiplier}</b></code><p>The configured employee rate is {hourlyRate === null ? "currently disabled" : "currently active"}.</p></article>
        <article><span className="formula-index">05</span><strong>Machine cost</strong><code>{machineHourlyRate ?? 0} sc/hour × autonomous seconds ÷ 3,600 × <b>{rules.machineCostMultiplier}</b></code><p>The configured autonomous-machine rate is {machineHourlyRate === null ? "currently disabled" : "currently active"}.</p></article>
        <article><span className="formula-index">06</span><strong>Expected by-product credit</strong><code>price × quantity × probability × <b>{rules.byproductCreditMultiplier}</b></code><p>Unknown by-product prices temporarily contribute zero and mark the result provisional.</p></article>
        <article><span className="formula-index">07</span><strong>Forward item estimate</strong><code>(ingredients + labor + machine − by-products) ÷ output quantity</code><p>Exact prices override this estimate. Alternative schematics remain separate candidates and form a range.</p></article>
        <article><span className="formula-index">08</span><strong>Backward item estimate</strong><code>(output value − known inputs − labor − machine + by-products) ÷ unknown quantity</code><p>Backward solving happens only when exactly one ingredient remains unknown.</p></article>
        <article><span className="formula-index">09</span><strong>Batch revenue and net earnings</strong><code>revenue = NPC batch payout<br />net = revenue − route cost</code><p>Negative route costs are retained as net production credits rather than clamped to zero.</p></article>
        <article><span className="formula-index">10</span><strong>Production-hour rates</strong><code>gross = revenue ÷ production hours<br />net = net earnings ÷ production hours</code><p>Production hours are the weighted production seconds from rule 03 divided by 3,600.</p></article>
      </div>
    </section>

    <section className="rules-section safeguards-section">
      <div className="rules-section-heading"><div><p className="eyebrow">Engine safeguards</p><h3>Fixed rules that prevent invented values</h3></div><span>Documented here, intentionally not editable</span></div>
      <div className="safeguard-grid"><article><strong>Exact prices win</strong><p>A user-entered price is always the propagation anchor for that item.</p></article><article><strong>Multiple unknowns stop</strong><p>A recipe with two or more unresolved ingredients is not allocated an invented split.</p></article><article><strong>Cycles terminate</strong><p>Provenance prevents infinite recursion. Unanchored cycles remain unestimable.</p></article><article><strong>Routes remain distinct</strong><p>Conflicting schematics are retained as alternatives; their endpoints create the displayed range.</p></article><article><strong>Seeds and wild resources start lines</strong><p>Farming seeds are terminal starts. Wild-harvestable resources are valid alternative starts.</p></article><article><strong>Invalid quantities are rejected</strong><p>Zero, negative, or non-finite quantities cannot create a valid normalized recipe.</p></article></div>
    </section>
  </div>;
}

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [rawText, setRawText] = useState("");
  const [mapping, setMapping] = useState<SchemaMapping>(defaultMapping);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const [ready, setReady] = useState(false);
  const [focusName, setFocusName] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [fixedPrices, setFixedPrices] = useState<Record<string, number>>({});
  const [npcPayouts, setNpcPayouts] = useState<Record<string, number>>({});
  const [hourlyRate, setHourlyRate] = useState<number | null>(null);
  const [machineHourlyRate, setMachineHourlyRate] = useState<number | null>(null);
  const [calculationRules, setCalculationRules] = useState<CalculationRules>(DEFAULT_CALCULATION_RULES);
  const [skillLevels, setSkillLevels] = useState<Record<string, number>>({});
  const [disabledLineIds, setDisabledLineIds] = useState<string[]>([]);
  const [depth, setDepth] = useState(3);
  const [viewMode, setViewMode] = useState<ViewMode>("graph");
  const [showImporter, setShowImporter] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [draftText, setDraftText] = useState("");
  const [draftMapping, setDraftMapping] = useState<SchemaMapping>(defaultMapping);
  const [draftPreview, setDraftPreview] = useState<{ items: Item[]; warnings: string[] } | null>(null);
  const [importError, setImportError] = useState("");
  const [dragging, setDragging] = useState(false);

  const loadText = useCallback((text: string, preferredMapping?: SchemaMapping) => {
    const parsed = JSON.parse(text) as unknown;
    const nextMapping = preferredMapping ?? detectMapping(parsed);
    const normalized = normalizeData(parsed, nextMapping);
    setRawText(text);
    setMapping(nextMapping);
    setItems(normalized.items);
    setSkills(normalizeSkills(parsed));
    setWarnings(normalized.warnings);
    setLoadError("");
    setFocusName((current) => normalized.items.some((item) => item.name === current) ? current : normalized.items.find((item) => item.name === "Flaxa Thread")?.name ?? normalized.items[0]?.name ?? "");
    setSelectedName((current) => normalized.items.some((item) => item.name === current) ? current : normalized.items.find((item) => item.name === "Flaxa Thread")?.name ?? normalized.items[0]?.name ?? "");
    return { nextMapping, normalized };
  }, []);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const savedSettings = localStorage.getItem(STORAGE_KEY);
        if (savedSettings) {
          const parsed = JSON.parse(savedSettings) as { fixedPrices?: Record<string, number>; npcPayouts?: Record<string, number>; hourlyRate?: number | null; machineHourlyRate?: number | null; calculationRules?: Partial<CalculationRules>; skillLevels?: Record<string, number>; disabledLineIds?: string[]; depth?: number; viewMode?: ViewMode };
          setFixedPrices(parsed.fixedPrices ?? {});
          setNpcPayouts(parsed.npcPayouts ?? {});
          setHourlyRate(parsed.hourlyRate ?? null);
          setMachineHourlyRate(parsed.machineHourlyRate ?? null);
          setCalculationRules(sanitizeCalculationRules(parsed.calculationRules));
          setSkillLevels(parsed.skillLevels ?? {});
          setDisabledLineIds(parsed.disabledLineIds ?? []);
          setDepth(parsed.depth ?? 3);
          setViewMode(parsed.viewMode ?? "graph");
        }
        const savedDataset = await readSavedDataset();
        if (!active) return;
        if (savedDataset) loadText(savedDataset.rawText, savedDataset.mapping);
        else {
          const response = await fetch(DATA_URL);
          if (!response.ok) throw new Error("The bundled data file could not be loaded.");
          loadText(await response.text());
        }
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : "The recipe data could not be loaded.");
      } finally {
        if (active) setReady(true);
      }
    }
    void initialize();
    return () => { active = false; };
  }, [loadText]);

  useEffect(() => {
    if (!ready) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ fixedPrices, npcPayouts, hourlyRate, machineHourlyRate, calculationRules, skillLevels, disabledLineIds, depth, viewMode }));
  }, [fixedPrices, npcPayouts, hourlyRate, machineHourlyRate, calculationRules, skillLevels, disabledLineIds, depth, viewMode, ready]);

  const itemsByName = useMemo(() => new Map(items.map((item) => [item.name, item])), [items]);
  const consumers = useMemo(() => {
    const result = new Map<string, Recipe[]>();
    for (const item of items) for (const recipe of item.recipes) for (const ingredient of recipe.ingredients) {
      const list = result.get(ingredient.name) ?? [];
      list.push(recipe);
      result.set(ingredient.name, list);
    }
    return result;
  }, [items]);
  const deferredFixedPrices = useDeferredValue(fixedPrices);
  const deferredNpcPayouts = useDeferredValue(npcPayouts);
  const deferredHourlyRate = useDeferredValue(hourlyRate);
  const deferredMachineHourlyRate = useDeferredValue(machineHourlyRate);
  const deferredCalculationRules = useDeferredValue(calculationRules);
  const deferredSkillLevels = useDeferredValue(skillLevels);
  const calculations = useMemo(() => calculateEstimates(items, deferredFixedPrices, deferredHourlyRate, deferredSkillLevels, deferredMachineHourlyRate, deferredCalculationRules), [items, deferredFixedPrices, deferredHourlyRate, deferredSkillLevels, deferredMachineHourlyRate, deferredCalculationRules]);
  const productionLines = useMemo(
    () => analyzeProductionLines(items, deferredFixedPrices, deferredHourlyRate, deferredSkillLevels, calculations.estimates, deferredMachineHourlyRate, skills, deferredNpcPayouts, deferredCalculationRules),
    [items, deferredFixedPrices, deferredNpcPayouts, deferredHourlyRate, deferredSkillLevels, deferredMachineHourlyRate, deferredCalculationRules, skills, calculations.estimates],
  );
  const selectedItem = itemsByName.get(selectedName);
  const selectedEstimate = calculations.estimates[selectedName];
  const recipeCount = useMemo(() => items.reduce((sum, item) => sum + item.recipes.length, 0), [items]);
  const estimatedCount = Object.keys(calculations.estimates).length;
  const activeSkillCount = Object.values(skillLevels).filter((level) => level > 0).length;
  const filteredSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    return query ? skills.filter((skill) => `${skill.name} ${skill.description ?? ""} ${skill.category ?? ""}`.toLowerCase().includes(query)) : skills;
  }, [skills, skillSearch]);

  function setItemPrice(name: string, value: string) {
    setFixedPrices((current) => {
      const next = { ...current };
      if (value.trim() === "") delete next[name];
      else {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) next[name] = parsed;
      }
      return next;
    });
  }

  function setLineNpcPayout(id: string, value: string) {
    setNpcPayouts((current) => {
      const next = { ...current };
      if (value.trim() === "") delete next[id];
      else {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) next[id] = parsed;
      }
      return next;
    });
  }

  function updateCalculationRule(key: keyof CalculationRules, value: number) {
    setCalculationRules((current) => sanitizeCalculationRules({ ...current, [key]: value }));
  }

  function updatePrice(value: string) {
    setItemPrice(selectedName, value);
  }

  function inspectDraft(text = draftText) {
    try {
      const parsed = JSON.parse(text);
      const detected = detectMapping(parsed);
      const preview = normalizeData(parsed, detected);
      setDraftMapping(detected);
      setDraftPreview(preview);
      setImportError("");
    } catch (error) {
      setDraftPreview(null);
      setImportError(error instanceof Error ? error.message : "This is not valid JSON.");
    }
  }

  function refreshDraftPreview(nextMapping: SchemaMapping) {
    setDraftMapping(nextMapping);
    try {
      const preview = normalizeData(JSON.parse(draftText), nextMapping);
      setDraftPreview(preview);
      setImportError("");
    } catch (error) {
      setDraftPreview(null);
      setImportError(error instanceof Error ? error.message : "The mapping does not match this data.");
    }
  }

  async function applyImport() {
    try {
      loadText(draftText, draftMapping);
      await writeSavedDataset({ rawText: draftText, mapping: draftMapping });
      setShowImporter(false);
      setImportError("");
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "The import could not be applied.");
    }
  }

  async function reloadBundled() {
    try {
      const response = await fetch(DATA_URL, { cache: "no-store" });
      const text = await response.text();
      loadText(text);
      await writeSavedDataset(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "The bundled data could not be reloaded.");
    }
  }

  async function resetAll() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LINE_COLUMNS_STORAGE_KEY);
    setFixedPrices({});
    setNpcPayouts({});
    setHourlyRate(null);
    setMachineHourlyRate(null);
    setCalculationRules(DEFAULT_CALCULATION_RULES);
    setSkillLevels({});
    setDisabledLineIds([]);
    setDepth(3);
    setViewMode("graph");
    await reloadBundled();
  }

  function openImporter() {
    setDraftText(rawText);
    setDraftMapping(mapping);
    try {
      setDraftPreview(normalizeData(JSON.parse(rawText), mapping));
    } catch {
      setDraftPreview(null);
    }
    setImportError("");
    setShowImporter(true);
  }

  function selectItem(name: string, refocus = false) {
    setSelectedName(name);
    if (refocus) setFocusName(name);
  }

  function acceptFile(file?: File) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setDraftText(text);
      inspectDraft(text);
    };
    reader.onerror = () => setImportError("That file could not be read.");
    reader.readAsText(file);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <p className="eyebrow">Production intelligence</p>
            <h1>Line / Value</h1>
          </div>
        </div>
        <div className="dataset-summary" aria-label="Dataset summary">
          <span><strong>{items.length}</strong> items</span>
          <span><strong>{recipeCount}</strong> recipes</span>
          <span><strong>{skills.length}</strong> skills</span>
          <span><strong>{estimatedCount}</strong> priced</span>
        </div>
        <div className="top-actions">
          <button className="button button-quiet" type="button" onClick={reloadBundled}>Reload file</button>
          <button className="button button-skill" type="button" onClick={() => setShowSkills(true)}>Skills{activeSkillCount ? ` · ${activeSkillCount}` : ""}</button>
          <button className="button button-primary" type="button" onClick={openImporter}>Import & map JSON</button>
        </div>
      </header>

      <section className="control-deck" aria-label="Calculation controls">
        <label className="search-control">
          <span>Focus item</span>
          <div className="search-input-wrap">
            <span aria-hidden="true">⌕</span>
            <input
              list="item-names"
              value={focusName}
              onChange={(event) => {
                setFocusName(event.target.value);
                if (itemsByName.has(event.target.value)) setSelectedName(event.target.value);
              }}
              placeholder="Search any item…"
            />
            <datalist id="item-names">{items.map((item) => <option value={item.name} key={item.name} />)}</datalist>
          </div>
        </label>
        <label className="rate-control">
          <span>Employee cost / hour <em>optional</em></span>
          <div className="number-input-wrap">
            <span>sc</span>
            <input
              inputMode="decimal"
              min="0"
              step="0.01"
              value={hourlyRate ?? ""}
              onChange={(event) => setHourlyRate(event.target.value === "" ? null : Math.max(0, Number(event.target.value) || 0))}
              placeholder="Not included"
            />
          </div>
        </label>
        <label className="rate-control">
          <span>Autonomous machine cost / hour <em>optional</em></span>
          <div className="number-input-wrap">
            <span>sc</span>
            <input
              inputMode="decimal"
              min="0"
              step="0.01"
              value={machineHourlyRate ?? ""}
              onChange={(event) => setMachineHourlyRate(event.target.value === "" ? null : Math.max(0, Number(event.target.value) || 0))}
              placeholder="Not included"
            />
          </div>
        </label>
        <label className="depth-control">
          <span>Visible levels</span>
          <select value={depth} onChange={(event) => setDepth(Number(event.target.value))}>
            {[1, 2, 3, 4, 5].map((value) => <option value={value} key={value}>{value}</option>)}
          </select>
        </label>
        <div className="segmented" aria-label="View mode">
          <button className={viewMode === "graph" ? "active" : ""} onClick={() => setViewMode("graph")} type="button">Graph</button>
          <button className={viewMode === "table" ? "active" : ""} onClick={() => setViewMode("table")} type="button">Table</button>
          <button className={viewMode === "lines" ? "active" : ""} onClick={() => setViewMode("lines")} type="button">Line rankings</button>
          <button className={viewMode === "rules" ? "active" : ""} onClick={() => setViewMode("rules")} type="button">Calculation rules</button>
        </div>
      </section>

      {loadError && <div className="notice notice-error" role="alert">{loadError}</div>}
      {warnings.length > 0 && (
        <details className="notice notice-warning">
          <summary>{warnings.length} data note{warnings.length === 1 ? "" : "s"}</summary>
          <ul>{warnings.slice(0, 12).map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
        </details>
      )}

      <div className={`workspace-grid ${viewMode === "lines" || viewMode === "rules" ? "lines-mode" : ""}`}>
        <section className="workspace-main" aria-label="Production line workspace">
          {!ready ? (
            <div className="empty-state"><span className="loader" /><h2>Reading production data</h2></div>
          ) : viewMode === "rules" ? (
            <CalculationRulesPage rules={calculationRules} hourlyRate={hourlyRate} machineHourlyRate={machineHourlyRate} onChange={updateCalculationRule} onReset={() => setCalculationRules(DEFAULT_CALCULATION_RULES)} />
          ) : !itemsByName.has(focusName) ? (
            <div className="empty-state"><span className="empty-glyph">⌕</span><h2>Choose an item to trace its production line</h2><p>Use the focus search above to begin.</p></div>
          ) : viewMode === "lines" ? (
            <LineRankings lines={productionLines} fixedPrices={fixedPrices} npcPayouts={npcPayouts} onSetPrice={setItemPrice} onSetNpcPayout={setLineNpcPayout} disabledLineIds={disabledLineIds} onToggleLine={(id) => setDisabledLineIds((current) => current.includes(id) ? current.filter((lineId) => lineId !== id) : [...current, id])} />
          ) : viewMode === "graph" ? (
            <div className="graph-view">
              <div className="graph-head">
                <div><span className="direction-label">Inputs & production</span><p>How this item is made</p></div>
                <div className="graph-focus-label"><span>Focused line</span><strong>{focusName}</strong></div>
                <div className="align-right"><span className="direction-label">Uses & outputs</span><p>Where this item goes</p></div>
              </div>
              <div className="graph-columns">
                <div className="graph-column upstream-column">
                  <ProductionTree name={focusName} depth={depth} path={[focusName]} direction="up" itemsByName={itemsByName} consumers={consumers} calculations={calculations} selectedName={selectedName} onSelect={setSelectedName} />
                </div>
                <div className="graph-spine" aria-hidden="true"><span>→</span><i /><span>→</span></div>
                <div className="graph-column downstream-column">
                  <ProductionTree name={focusName} depth={depth} path={[focusName]} direction="down" itemsByName={itemsByName} consumers={consumers} calculations={calculations} selectedName={selectedName} onSelect={setSelectedName} />
                </div>
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <caption>All normalized items and their current estimated prices</caption>
                <thead><tr><th>Item</th><th>Type</th><th>Recipes</th><th>Status</th><th className="numeric">Price / range</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>{items.map((item) => {
                  const estimate = calculations.estimates[item.name];
                  return <tr key={item.name} className={item.name === selectedName ? "selected-row" : ""}>
                    <td><button className="table-item-button" type="button" onClick={() => setSelectedName(item.name)}>{item.name}</button></td>
                    <td>{item.type || "—"}</td><td>{item.recipes.length}</td><td><StatusBadge estimate={estimate} /></td>
                    <td className="numeric table-price">{estimateLabel(estimate)}</td>
                    <td><button className="text-button" type="button" onClick={() => selectItem(item.name, true)}>Trace line</button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}
        </section>

        {viewMode !== "lines" && viewMode !== "rules" && <aside className="inspector" aria-label="Item inspector">
          {selectedItem ? (
            <>
              <div className="inspector-kicker"><span>Item inspector</span><StatusBadge estimate={selectedEstimate} /></div>
              <h2>{selectedItem.name}</h2>
              <p className="inspector-description">{selectedItem.description || "No description supplied in this dataset."}</p>
              {selectedName !== focusName && <button className="text-button trace-button" type="button" onClick={() => setFocusName(selectedName)}>Trace this production line →</button>}

              <div className="price-anchor-card">
                <label htmlFor="exact-price">Exact item price</label>
                <p>Overrides every estimate and anchors calculations in both directions.</p>
                <div className="anchor-input"><span>sc</span><input id="exact-price" inputMode="decimal" value={fixedPrices[selectedName] ?? ""} placeholder="No NPC price" onChange={(event) => updatePrice(event.target.value)} /></div>
                {Object.prototype.hasOwnProperty.call(fixedPrices, selectedName) && <button type="button" className="clear-price" onClick={() => updatePrice("")}>Clear exact price</button>}
              </div>

              <section className="estimate-panel">
                <span className="section-label">Current value</span>
                <div className={`hero-estimate ${selectedEstimate?.low && selectedEstimate.low < 0 ? "negative" : ""}`}>{estimateLabel(selectedEstimate)}</div>
                {!selectedEstimate ? <p className="muted">Add an exact price somewhere in this connected line, or price every input of one recipe.</p> : (
                  <>
                    <p className="estimate-source">{selectedEstimate.label}</p>
                    {selectedEstimate.provisional && <p className="provisional-note">Provisional — unresolved by-product credit: {selectedEstimate.missingByproducts.join(", ") || "upstream estimate"}.</p>}
                    {selectedEstimate.low < 0 && <p className="credit-note">By-product value exceeds material and labor cost, creating a net production credit.</p>}
                  </>
                )}
              </section>

              {selectedEstimate && selectedEstimate.candidates.length > 1 && (
                <section className="candidate-panel">
                  <span className="section-label">Production paths</span>
                  <ol>{selectedEstimate.candidates.map((candidate, index) => (
                    <li key={`${candidate.label}-${candidate.recipeId}-${index}`}><span>{candidate.label}</span><strong>{candidate.low === candidate.high ? money(candidate.low) : `${money(candidate.low)} – ${money(candidate.high)}`}</strong></li>
                  ))}</ol>
                </section>
              )}

              <section className="recipe-panel">
                <span className="section-label">Produces this item</span>
                {selectedItem.recipes.length ? selectedItem.recipes.map((recipe) => (
                  <RecipeCard key={recipe.id} recipe={recipe} calculation={calculations.recipeCalculations[recipe.id]} onSelect={setSelectedName} />
                )) : <p className="muted">No production recipe is mapped for this item.</p>}
              </section>
            </>
          ) : <div className="empty-inspector">Select an item to inspect its price.</div>}
          <div className="inspector-footer"><button type="button" onClick={resetAll}>Reset data & settings</button><span>Stored only on this device</span></div>
        </aside>}
      </div>

      {showImporter && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowImporter(false); }}>
          <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-title">
            <header className="modal-header"><div><p className="eyebrow">Flexible data adapter</p><h2 id="import-title">Import & map recipe JSON</h2></div><button className="modal-close" type="button" onClick={() => setShowImporter(false)} aria-label="Close importer">×</button></header>
            <div className="import-body">
              <div className="import-source-panel">
                <label
                  className={`drop-zone ${dragging ? "dragging" : ""}`}
                  onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files[0]); }}
                >
                  <input className="sr-only" type="file" accept="application/json,.json" onChange={(event) => acceptFile(event.target.files?.[0])} />
                  <span className="drop-icon">↓</span><strong>Drop a JSON file here</strong><span>or choose a file from this computer</span>
                </label>
                <label className="json-label"><span>JSON content</span><textarea spellCheck={false} value={draftText} onChange={(event) => setDraftText(event.target.value)} placeholder="Paste recipe JSON here…" /></label>
                <button className="button button-dark" type="button" onClick={() => inspectDraft()}>Auto-detect structure</button>
              </div>
              <div className="mapping-panel">
                <div className="mapping-intro"><div><h3>Schema mapping</h3><p>Use dot-separated paths. <code>@key</code> reads an object key; <code>@value</code> reads its value.</p></div>{draftPreview && <span className="preview-count">{draftPreview.items.length} items found</span>}</div>
                <div className="mapping-grid">{mappingFields.map((field) => (
                  <label key={field.key}><span>{field.label}</span><input value={draftMapping[field.key] ?? ""} onChange={(event) => refreshDraftPreview({ ...draftMapping, [field.key]: event.target.value })} /><small>{field.hint}</small></label>
                ))}</div>
                {importError && <div className="mapping-error" role="alert">{importError}</div>}
                {draftPreview && <div className="mapping-preview"><strong>Preview:</strong> {draftPreview.items.slice(0, 5).map((item) => item.name).join(" · ")}{draftPreview.items.length > 5 ? " …" : ""}{draftPreview.warnings.length > 0 && <span>{draftPreview.warnings.length} data notes</span>}</div>}
              </div>
            </div>
            <footer className="modal-footer"><button type="button" className="button button-quiet" onClick={() => setShowImporter(false)}>Cancel</button><button type="button" className="button button-primary" disabled={!draftPreview} onClick={applyImport}>Use this dataset</button></footer>
          </section>
        </div>
      )}

      {showSkills && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) setShowSkills(false); }}>
          <section className="skill-modal" role="dialog" aria-modal="true" aria-labelledby="skills-title">
            <header className="modal-header">
              <div><p className="eyebrow">Labor speed profile</p><h2 id="skills-title">Employee skill levels</h2></div>
              <button className="modal-close" type="button" onClick={() => setShowSkills(false)} aria-label="Close skills">×</button>
            </header>
            <div className="skill-modal-controls">
              <div><strong>{skills.length} production skills</strong><p>Levels reduce manual work time when the source data links that skill to a schematic.</p></div>
              <label><span className="sr-only">Search skills</span><input value={skillSearch} onChange={(event) => setSkillSearch(event.target.value)} placeholder="Search skills…" /></label>
            </div>
            <div className="skill-list">
              {filteredSkills.map((skill) => {
                const level = Math.min(skill.maxLevel, Math.max(0, skillLevels[skill.id] ?? 0));
                return (
                  <article className={`skill-row ${level > 0 ? "is-active" : ""}`} key={skill.id}>
                    <div className="skill-copy">
                      <div className="skill-heading"><strong>{skill.name}</strong>{skill.category && <span>{titleCategory(skill.category)}</span>}</div>
                      <p>{skill.description || "No skill description supplied."}</p>
                      <div className="skill-facts">
                        {skill.speedBonusPerLevel > 0 && <span>+{(skill.speedBonusPerLevel * 100).toFixed(1)}% speed / level</span>}
                        {skill.affectedSchematicCount > 0 && <span>{skill.affectedSchematicCount} affected recipes</span>}
                        {skill.unlockedBy && <span>Unlocked by {skill.unlockedBy.name} {skill.unlockedBy.level}</span>}
                      </div>
                    </div>
                    <label className="skill-level-input"><span>Level</span><input type="number" inputMode="numeric" min="0" max={skill.maxLevel} value={level} onChange={(event) => {
                      const nextLevel = Math.min(skill.maxLevel, Math.max(0, Number(event.target.value) || 0));
                      setSkillLevels((current) => ({ ...current, [skill.id]: nextLevel }));
                    }} /><small>/ {skill.maxLevel}</small></label>
                  </article>
                );
              })}
              {!filteredSkills.length && <div className="no-skill-results">No skills match that search.</div>}
            </div>
            <footer className="modal-footer"><button type="button" className="button button-quiet" onClick={() => setSkillLevels({})}>Reset skill levels</button><button type="button" className="button button-primary" onClick={() => setShowSkills(false)}>Apply skill profile</button></footer>
          </section>
        </div>
      )}
    </main>
  );
}
