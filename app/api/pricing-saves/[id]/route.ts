import { deletePricingSave, getPricingSave, updatePricingSave } from "../../../lib/pricing-save-store.ts";
import { pricingSaveError, readPricingSaveBody } from "../../../lib/pricing-save-api.ts";
import { validatePricingScenario, validateSaveDescription, validateSaveName } from "../../../lib/pricing-saves.ts";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  try {
    const save = getPricingSave((await context.params).id);
    return save ? Response.json({ save }) : Response.json({ error: "Pricing save not found." }, { status: 404 });
  } catch (error) {
    return pricingSaveError(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const body = await readPricingSaveBody(request) as Record<string, unknown>;
    if (!("name" in body) && !("description" in body) && !("state" in body)) return Response.json({ error: "No save changes were supplied." }, { status: 400 });
    const save = updatePricingSave((await context.params).id, {
      name: "name" in body ? validateSaveName(body.name) : undefined,
      description: "description" in body ? validateSaveDescription(body.description) : undefined,
      state: "state" in body ? validatePricingScenario(body.state) : undefined,
    });
    return save ? Response.json({ save }) : Response.json({ error: "Pricing save not found." }, { status: 404 });
  } catch (error) {
    return pricingSaveError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    return deletePricingSave((await context.params).id) ? new Response(null, { status: 204 }) : Response.json({ error: "Pricing save not found." }, { status: 404 });
  } catch (error) {
    return pricingSaveError(error);
  }
}

