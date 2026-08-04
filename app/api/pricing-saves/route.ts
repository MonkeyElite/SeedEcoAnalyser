import { createPricingSave, listPricingSaves } from "../../lib/pricing-save-store.ts";
import { pricingSaveError, readPricingSaveBody } from "../../lib/pricing-save-api.ts";
import { validateDatasetFingerprint, validatePricingScenario, validateSaveDescription, validateSaveName } from "../../lib/pricing-saves.ts";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json({ saves: listPricingSaves() });
  } catch (error) {
    return pricingSaveError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await readPricingSaveBody(request) as Record<string, unknown>;
    const save = createPricingSave({
      name: validateSaveName(body.name),
      description: validateSaveDescription(body.description),
      datasetFingerprint: validateDatasetFingerprint(body.datasetFingerprint),
      state: validatePricingScenario(body.state),
    });
    return Response.json({ save }, { status: 201 });
  } catch (error) {
    return pricingSaveError(error);
  }
}

