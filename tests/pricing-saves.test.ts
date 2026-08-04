import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CALCULATION_RULES } from "../app/lib/calculation-rules.ts";
import {
  closePricingSaveDatabaseForTests,
  createPricingSave,
  deletePricingSave,
  getPricingSave,
  listPricingSaves,
  updatePricingSave,
} from "../app/lib/pricing-save-store.ts";
import { datasetFingerprint, validatePricingScenario, type PricingScenarioState } from "../app/lib/pricing-saves.ts";
import * as collectionRoute from "../app/api/pricing-saves/route.ts";
import * as recordRoute from "../app/api/pricing-saves/[id]/route.ts";

const scenario = (price = 10): PricingScenarioState => ({
  fixedPrices: { Flaxa: price },
  npcPayouts: { fabric: 738 },
  hourlyRate: 20,
  machineHourlyRate: 4,
  calculationRules: DEFAULT_CALCULATION_RULES,
  skillLevels: { SK_TAILORING: 3 },
  disabledLineIds: ["missing-machine-line"],
});

function withDatabase(name: string, run: () => void | Promise<void>) {
  return async () => {
    const directory = mkdtempSync(path.join(tmpdir(), `seed-eco-${name}-`));
    process.env.DATA_DIR = directory;
    closePricingSaveDatabaseForTests();
    try {
      await run();
    } finally {
      closePricingSaveDatabaseForTests();
      delete process.env.DATA_DIR;
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("SQLite save library persists CRUD and latest-write-wins revisions", withDatabase("crud", () => {
  const created = createPricingSave({ name: "July prices", description: "Baseline", datasetFingerprint: "dataset-v1-0123456789abcdef", state: scenario() });
  assert.equal(created.revision, 1);
  assert.equal(listPricingSaves().length, 1);
  assert.equal(getPricingSave(created.id)?.state.fixedPrices.Flaxa, 10);

  const firstUpdate = updatePricingSave(created.id, { state: scenario(15) })!;
  const finalUpdate = updatePricingSave(created.id, { state: scenario(22) })!;
  assert.equal(firstUpdate.revision, 2);
  assert.equal(finalUpdate.revision, 3);
  assert.equal(finalUpdate.state.fixedPrices.Flaxa, 22);

  closePricingSaveDatabaseForTests();
  assert.equal(getPricingSave(created.id)?.state.fixedPrices.Flaxa, 22);
  assert.equal(deletePricingSave(created.id), true);
  assert.equal(deletePricingSave(created.id), false);
}));

test("save names are unique without regard to case", withDatabase("unique", () => {
  createPricingSave({ name: "Balance A", description: "", datasetFingerprint: "dataset-v1-0123456789abcdef", state: scenario() });
  assert.throws(() => createPricingSave({ name: "balance a", description: "", datasetFingerprint: "dataset-v1-0123456789abcdef", state: scenario() }), /already exists/i);
}));

test("scenario validation rejects invalid numbers and fingerprints are stable", () => {
  assert.throws(() => validatePricingScenario({ ...scenario(), fixedPrices: { Flaxa: Number.NaN } }), /finite/);
  const items = [{ name: "Flaxa", recipes: [] }, { name: "Thread", recipes: [{ id: "thread", output: "Thread", outputQty: 12, station: "Bench", manualSeconds: 10, ingredients: [{ name: "Flaxa", qty: 1 }], byproducts: [] }] }];
  assert.equal(datasetFingerprint(items), datasetFingerprint([...items].reverse()));
  assert.match(datasetFingerprint(items), /^dataset-v1-[a-f0-9]{16}$/);
});

test("pricing save API validates, creates, updates, lists, and deletes", withDatabase("api", async () => {
  const createResponse = await collectionRoute.POST(new Request("http://localhost/api/pricing-saves", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "API scenario", description: "Shared", datasetFingerprint: "dataset-v1-0123456789abcdef", state: scenario() }) }));
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json() as { save: { id: string } }).save;

  const listResponse = await collectionRoute.GET();
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json() as { saves: unknown[] }).saves.length, 1);

  const patchResponse = await recordRoute.PATCH(new Request(`http://localhost/api/pricing-saves/${created.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: scenario(99) }) }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(patchResponse.status, 200);
  assert.equal((await patchResponse.json() as { save: { state: PricingScenarioState } }).save.state.fixedPrices.Flaxa, 99);

  const deleteResponse = await recordRoute.DELETE(new Request(`http://localhost/api/pricing-saves/${created.id}`, { method: "DELETE" }), { params: Promise.resolve({ id: created.id }) });
  assert.equal(deleteResponse.status, 204);
  const missingResponse = await recordRoute.GET(new Request(`http://localhost/api/pricing-saves/${created.id}`), { params: Promise.resolve({ id: created.id }) });
  assert.equal(missingResponse.status, 404);
}));

test("pricing save API rejects malformed and oversized bodies", withDatabase("limits", async () => {
  const malformed = await collectionRoute.POST(new Request("http://localhost/api/pricing-saves", { method: "POST", body: "{" }));
  assert.equal(malformed.status, 400);
  const oversized = await collectionRoute.POST(new Request("http://localhost/api/pricing-saves", { method: "POST", body: JSON.stringify({ padding: "x".repeat(1024 * 1024) }) }));
  assert.equal(oversized.status, 413);
}));

