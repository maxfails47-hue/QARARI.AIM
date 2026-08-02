// ============================================================================
// Gemini fallback provider.
//
// WHY THIS EXISTS: Groq's free tier caps openai/gpt-oss-120b at ~8,000
// tokens/minute (TPM) — see production logs from 2026-08-02, where both the
// Compound price-lookup call and the narrative-analysis call hit 429
// ("Rate limit reached ... tokens per minute (TPM): Limit 8000") within the
// same request. Multiple keys don't help (Groq's limit is per-organization),
// and upgrading to Groq's Dev Tier requires a card.
//
// Google's Gemini API free tier (no card required — sign up at
// https://aistudio.google.com/apikey) has a MUCH higher TPM ceiling
// (250,000 TPM on Flash/Flash-Lite vs Groq's 8,000), even though its RPM
// cap is lower (10-15 RPM vs Groq's 30). Since our bottleneck is token
// volume per request (long Serper snippets + a large structured JSON
// schema output), not request frequency, Gemini is the better fit as a
// LAST-RESORT fallback after Groq's own primary+fallback models are
// exhausted — never as the first call, to avoid burning Gemini's much
// lower RPM budget unnecessarily.
//
// Requires env var GEMINI_API_KEY. If it's not set, every function here
// fails fast (throws) so the caller's existing catch/fallback logic treats
// it exactly like any other unavailable provider — no behavior change for
// people who haven't set up Gemini yet.
// ============================================================================

import { loggedFetch, loggedJsonParse } from "./_logger.js";

// Flash-Lite has the most generous free-tier RPM/RPD of the Gemini family
// while still sharing a high TPM ceiling — the right tradeoff for a
// fallback we want available as often as possible.
//
// IMPORTANT: Google retires/closes older model IDs to new API keys on a
// rolling basis (gemini-2.5-flash-lite stopped accepting new users and now
// 404s with "no longer available to new users"). If this fallback starts
// 404-ing again, check https://ai.google.dev/gemini-api/docs/models for
// the current model ID and swap it in below — there is no code change
// needed elsewhere, this is the single source of truth for the model name.
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function getGeminiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Missing GEMINI_API_KEY");
  return key;
}

// ─── Schema helpers (Gemini's responseSchema is OpenAPI-subset, NOT plain
// JSON Schema — no additionalProperties, no ["number","null"] union types;
// nullability is expressed via "nullable": true instead) ───
const gBiStr = {
  type: "object",
  properties: { ar: { type: "string" }, en: { type: "string" } },
  required: ["ar", "en"],
};
const gBiArr = {
  type: "object",
  properties: {
    ar: { type: "array", items: { type: "string" } },
    en: { type: "array", items: { type: "string" } },
  },
  required: ["ar", "en"],
};

export const GEMINI_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["good", "fair", "bad"] },
    reasoningPoints: gBiArr,
    preRecommendation: gBiStr,
    futureCompatibility: gBiStr,
    regretLevel: { type: "string", enum: ["low", "medium", "high"] },
    regretJustification: gBiStr,
    pros: gBiArr,
    cons: gBiArr,
    hiddenRisks: gBiArr,
    finalTip: gBiStr,
    negotiationScript: gBiStr,
    negotiationScriptVariants: {
      type: "object",
      properties: { polite: gBiStr, firm: gBiStr },
      required: ["polite", "firm"],
    },
    resaleValueRightNow: { type: "number", nullable: true },
    resaleValue2Years: { type: "number", nullable: true },
    resaleInsight: gBiStr,
    betterAlternatives: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, reason: gBiStr, whySuitable: gBiStr },
        required: ["name", "reason", "whySuitable"],
      },
    },
  },
  required: [
    "verdict", "reasoningPoints", "preRecommendation", "futureCompatibility",
    "regretLevel", "regretJustification", "pros", "cons", "hiddenRisks",
    "finalTip", "negotiationScript", "negotiationScriptVariants",
    "resaleValueRightNow", "resaleValue2Years", "resaleInsight", "betterAlternatives",
  ],
};

const GEMINI_PRICE_SCHEMA = {
  type: "object",
  properties: {
    min: { type: "number", nullable: true },
    max: { type: "number", nullable: true },
    mid: { type: "number", nullable: true },
    summary: {
      type: "object",
      properties: { ar: { type: "string" }, en: { type: "string" } },
      required: ["ar", "en"],
    },
  },
  required: ["min", "max", "mid", "summary"],
};

/**
 * Generic structured-JSON caller for Gemini. Mirrors callGroqModelStructured's
 * contract (system + user text in, parsed object out) so it's a drop-in
 * fallback wherever a Groq structured call is exhausted.
 */
async function callGeminiStructured(
  system: string,
  user: string,
  schema: Record<string, any>,
  maxOutputTokens: number,
  tools?: Record<string, any>[]
): Promise<any> {
  const apiKey = getGeminiKey();
  const body: Record<string, any> = {
    contents: [{ role: "user", parts: [{ text: user }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      maxOutputTokens,
      responseMimeType: "application/json",
      responseSchema: schema,
    },
  };
  // Note: Gemini doesn't allow combining responseSchema with the
  // google_search tool in the same call — grounding responses are
  // free-form text. getFairPriceRangeViaGemini below handles that by
  // running search WITHOUT a schema, then parsing the JSON out of the text.
  if (tools && tools.length > 0) {
    body.tools = tools;
    delete body.generationConfig.responseMimeType;
    delete body.generationConfig.responseSchema;
  }

  const res = await loggedFetch(
    "gemini.generateContent",
    `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const json = await res.json();
  const text = json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text || "").join("") || "";
  if (!text) throw new Error("Gemini returned empty content");
  return text;
}

function extractJsonObject(text: string): string {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return cleaned;
  return cleaned.slice(start, end + 1);
}

/**
 * Last-resort fair-price lookup via Gemini + Google Search grounding.
 * Mirrors getFairPriceRangeViaCompound's contract and prompt intent, called
 * only after Groq Compound (and, upstream, the Serper+Groq fallback) have
 * both failed — see getFairPriceRange's provider chain in _groq_tavily.ts.
 */
export async function getFairPriceRangeViaGemini(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used",
  specs: string
): Promise<{ min: number | null; max: number | null; mid: number | null; summary: { ar: string; en: string } | null }> {
  const conditionLabel = condition === "used" ? "used/second-hand" : condition === "likeNew" ? "like-new/open-box" : "new";
  const system =
    "You are a market-pricing research analyst. You MUST use Google Search before answering — never answer from memory, prices change constantly. " +
    "Your final message must contain ONLY a single valid JSON object, no prose, no markdown fences.";
  const user = `Find the CURRENT fair market price range for this exact product in ${currency}, condition: ${conditionLabel}.

PRODUCT: ${product}${specs ? `\nVARIANT/SPECS: ${specs}` : ""}

Search current retailer listings for this exact product/variant only. Ignore trade-in value, installment/financing figures, accessory prices, and shipping/tax fees.

Respond with ONLY this JSON shape:
{ "min": number | null, "max": number | null, "mid": number | null, "summary": { "ar": string, "en": string } }`;

  try {
    const text = await callGeminiStructured(system, user, {}, 2048, [{ google_search: {} }]);
    const parsed = loggedJsonParse(`gemini.price[${product}]`, extractJsonObject(text));
    let min = typeof parsed?.min === "number" ? parsed.min : null;
    let max = typeof parsed?.max === "number" ? parsed.max : null;
    if (min === null || max === null) { min = null; max = null; }
    const modelMid = typeof parsed?.mid === "number" ? parsed.mid : null;
    const mid = min !== null && max !== null ? (modelMid !== null ? modelMid : Math.round((min + max) / 2)) : null;
    const summary =
      parsed?.summary && typeof parsed.summary === "object"
        ? { ar: String(parsed.summary.ar || ""), en: String(parsed.summary.en || "") }
        : null;
    return { min, max, mid, summary };
  } catch (e) {
    console.error(`[getFairPriceRangeViaGemini] Failed for "${product}" (non-fatal):`, e);
    return { min: null, max: null, mid: null, summary: null };
  }
}

/**
 * Last-resort narrative-analysis call via Gemini structured output.
 * Called only after both PRIMARY_MODEL and FALLBACK_MODEL on Groq have
 * failed inside callAnalysisModel (_groq_tavily.ts) — same prompt/contract,
 * different provider.
 */
export async function callAnalysisModelViaGemini(prompt: string): Promise<{ data: any; modelUsed: string }> {
  const system = "You are a purchase-decision analyst. Respond with ONLY a single valid JSON object matching the given schema.";
  const text = await callGeminiStructured(system, prompt, GEMINI_ANALYSIS_SCHEMA, 6000);
  return { data: JSON.parse(text), modelUsed: `gemini:${GEMINI_MODEL}` };
}
