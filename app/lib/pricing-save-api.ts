import { DuplicateSaveNameError } from "./pricing-save-store.ts";
import { MAX_PRICING_SAVE_BYTES } from "./pricing-saves.ts";

export async function readPricingSaveBody(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_PRICING_SAVE_BYTES) throw new Error("REQUEST_TOO_LARGE");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > MAX_PRICING_SAVE_BYTES) throw new Error("REQUEST_TOO_LARGE");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("INVALID_JSON");
  }
}

export function pricingSaveError(error: unknown): Response {
  if (error instanceof DuplicateSaveNameError) return Response.json({ error: error.message }, { status: 409 });
  if (error instanceof Error && error.message === "REQUEST_TOO_LARGE") return Response.json({ error: "Pricing save exceeds the 1 MB limit." }, { status: 413 });
  if (error instanceof Error && error.message === "INVALID_JSON") return Response.json({ error: "Request body must contain valid JSON." }, { status: 400 });
  if (error instanceof Error && !/SQLITE|database/i.test(error.message)) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ error: "The pricing save could not be stored." }, { status: 500 });
}

