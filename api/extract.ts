import type { VercelRequest, VercelResponse } from "@vercel/node";
import { extractListingFromImage } from "./_gemini.js";
import { logRequestStart, logUnhandledError, logEnvPresence } from "./_logger.js";

// ============================================================================
// Section 4: Photo-to-autofill with mandatory confirmation.
//
// This endpoint is deliberately separate from api/analyze.ts: it only reads
// { productName, price, currency } off a photo to PRE-FILL the existing
// InputScreen form fields — it never runs the real analysis, never touches
// market pricing, and never consumes the person's analysis quota. The
// person always still sees and can edit the pre-filled fields before
// tapping "حلّل القرار", which still goes through the normal, unmodified
// api/analyze.ts flow with its own validation.
//
// No auth/quota check on purpose (see above) — but this is a Gemini vision
// call, so it's still rate-limited implicitly by Gemini's own free-tier
// RPM/RPD caps; that's an acceptable ceiling for a pre-fill convenience
// feature.
// ============================================================================

export default async function handler(req: VercelRequest, res: VercelResponse) {
  logRequestStart(req);
  logEnvPresence({ GEMINI_API_KEY: process.env.GEMINI_API_KEY });

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64.data !== "string" || typeof imageBase64.mimeType !== "string") {
      return res.status(400).json({ error: "invalid_input" });
    }

    const result = await extractListingFromImage(imageBase64);
    return res.status(200).json(result);
  } catch (e: any) {
    logUnhandledError(e);
    // Non-fatal by design: the caller (InputScreen) treats any failure here
    // as "couldn't read the photo" and simply falls back to manual entry —
    // never blocks the form.
    return res.status(200).json({ productName: null, price: null, currency: null });
  }
}
