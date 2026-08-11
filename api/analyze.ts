import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import {
  callAnalysisModel,
  getFairPriceRange,
  fetchMainProductRetailerLinks,
  attachLinksAndPricesToAlternatives,
  attachSearchLinksToAlternatives,
  getRegionForCurrency,
  normalizeProductNameForSearch,
  type FairPriceRange,
  type AlternativeWithLinks,
} from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { resolvePricesForLinks } from "./_priceResolver.js";
import { hostnameOf, loadKnownBadDomains, persistDomainHealth } from "./_domainHealth.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";
import { FREE_TIER_LIMITS, DEFAULT_PREMIUM_LIMITS, FAIR_USE_CONFIG, getBurstLimit } from "./_planConfig.js";

// ─── FAIR USE POLICY: In-memory burst rate limiter (shared with user.ts) ───
interface BurstEntry {
  timestamps: number[];
  cooldownUntil?: number;
  warnedToday?: string; // date key (YYYY-MM-DD)
}
const burstTracker = new Map<string, BurstEntry>();

function checkFairUseRateLimit(identifier: string, planName: string, monthlyQuota: number, monthlyUsed: number): { allowed: boolean; message?: { ar: string; en: string } } {
  const now = Date.now();
  let entry = burstTracker.get(identifier);

  if (!entry) {
    entry = { timestamps: [] };
    burstTracker.set(identifier, entry);
  }

  // If in cooldown, reject
  if (entry.cooldownUntil && now < entry.cooldownUntil) {
    return {
      allowed: false,
      message: {
        ar: "أنت بتستخدم قراري بسرعة عالية جداً. عشان نحافظ على الخدمة سريعة وموثوقة للجميع، بعض الطلبات ممكن تتأخر مؤقتاً. رصيدك المتبقي محفوظ.",
        en: "You're using Qarari at a very high speed. To keep the service fast and reliable for everyone, some requests may be temporarily slowed down. Your remaining credits are protected.",
      },
    };
  }

  // Clear cooldown if expired
  if (entry.cooldownUntil && now >= entry.cooldownUntil) {
    entry.cooldownUntil = undefined;
  }

  // Remove timestamps outside the window
  const windowStart = now - FAIR_USE_CONFIG.windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  // Check burst limit
  const burstLimit = getBurstLimit(planName);
  if (entry.timestamps.length >= burstLimit) {
    entry.cooldownUntil = now + FAIR_USE_CONFIG.cooldownMs;
    console.log("[Fair Use / analyze] Burst limit exceeded for", identifier, "| plan:", planName, "| timestamps:", entry.timestamps.length, "/", burstLimit);
    return {
      allowed: false,
      message: {
        ar: "أنت بتستخدم قراري بسرعة عالية جداً. عشان نحافظ على الخدمة سريعة وموثوقة للجميع، بعض الطلبات ممكن تتأخر مؤقتاً. رصيدك المتبقي محفوظ.",
        en: "You're using Qarari at a very high speed. To keep the service fast and reliable for everyone, some requests may be temporarily slowed down. Your remaining credits are protected.",
      },
    };
  }

  // Daily usage warning (log only, does NOT block)
  const dailyThreshold = monthlyQuota * FAIR_USE_CONFIG.dailyUsageWarningThreshold;
  if (monthlyUsed >= dailyThreshold) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (entry.warnedToday !== todayKey) {
      console.log("[Fair Use / analyze] Daily usage warning for", identifier, "| used:", monthlyUsed, "/", monthlyQuota, "(", ((monthlyUsed / monthlyQuota) * 100).toFixed(0), "%)");
      entry.warnedToday = todayKey;
    }
  }

  // Record this request
  entry.timestamps.push(now);
  return { allowed: true };
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of burstTracker.entries()) {
    const windowStart = now - FAIR_USE_CONFIG.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    if (entry.timestamps.length === 0 && !entry.cooldownUntil) {
      burstTracker.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Section 15: Use centralized config for free tier limits
const FREE_MONTHLY_LIMIT = FREE_TIER_LIMITS.scans;
const CACHE_TTL_HOURS = 72; // how long a cached market-research result stays valid for reuse

// ─── Price sanitizer for betterAlternatives text ───
// The AI is never given verified pricing for alternative products (only the
// main product gets a real Compound/Serper-researched fair price range),
// so any specific number/price/percentage it writes in an alternative's
// "reason" or "whySuitable" is fabricated — see the production report where
// every alternative card showed a wrong invented price. The prompt now
// explicitly forbids this, but this strips any number that slips through
// anyway as a second line of defense, rather than relying on the model
// alone. Matches Western digits, Arabic-Indic digits (٠-٩), thousands
// separators, decimals, and a trailing currency/percent word if present.
const PRICE_NUMBER_PATTERN =
  /[\d٠-٩][\d٠-٩,.]*\s*(جنيه|جنيها|ج\.م|EGP|SAR|AED|KWD|USD|EUR|ريال|درهم|دينار|%|percent)?/gi;

function stripPriceMentions(bi: { ar?: string; en?: string } | null | undefined): { ar: string; en: string } {
  const clean = (s: unknown) =>
    typeof s === "string"
      ? s.replace(PRICE_NUMBER_PATTERN, "").replace(/\s{2,}/g, " ").trim()
      : "";
  return { ar: clean(bi?.ar), en: clean(bi?.en) };
}


// ─── Cache key: only product + condition + specs + currency (NOT user context) ───
// The cache stores reusable product market intelligence — the fair price range,
// retailer links, and alternative products with their own pricing data.
// Everything that depends on the USER (offered price, notes, purpose, duration,
// budget, etc.) is NEVER cached and is re-generated by the AI on every request.
//
// CACHE_KEY_VERSION: bump this whenever a change to buildPrompt()/marketData's
// shape means OLD cached rows would silently serve stale/incomplete data under
// an unchanged key. Example: before v2, buildPrompt() never asked the model for
// "betterAlternatives", so every cached row had betterAlternatives: [] baked in
// for a full 72h — bumping the version here makes those rows miss the cache
// once instead of serving an empty alternatives section indefinitely.
const CACHE_KEY_VERSION = "v2";
function normalizeCacheKey(product: string, currency: string, condition: string = "new", specs: string = ""): string {
  const normalizedProduct = product.trim().toLowerCase().replace(/\s+/g, " ");
  const normalizedCondition = condition.trim().toLowerCase();
  // specs (storage/RAM/size/color/etc.) must be part of the key — otherwise
  // "iPhone 13 Pro" @ 128GB and "iPhone 13 Pro" @ 256GB collide into the same
  // cached market-price result even though they're different products.
  const normalizedSpecs = specs.trim().toLowerCase().replace(/\s+/g, " ");
  return `${normalizedProduct}::${normalizedSpecs}::${normalizedCondition}::${currency.trim().toUpperCase()}::${CACHE_KEY_VERSION}`;
}

// ─── What we cache (Product Market Intelligence only) ───
interface MarketCacheEntry {
  marketFairPriceMin: number | null;
  marketFairPriceMax: number | null;
  marketFairPriceMid: number | null;
  marketPriceSummary: { ar: string; en: string } | null;
  retailerPrices: any[];
  betterAlternatives: AlternativeWithLinks[];
  productImage: string | null;
}

function extractMarketData(parsed: any): MarketCacheEntry {
  return {
    marketFairPriceMin: parsed.marketFairPriceMin ?? null,
    marketFairPriceMax: parsed.marketFairPriceMax ?? null,
    marketFairPriceMid: parsed.marketFairPriceMid ?? null,
    marketPriceSummary: parsed.marketPriceSummary ?? null,
    retailerPrices: Array.isArray(parsed.retailerPrices) ? parsed.retailerPrices : [],
    betterAlternatives: Array.isArray(parsed.betterAlternatives) ? parsed.betterAlternatives : [],
    productImage: typeof parsed.productImage === "string" ? parsed.productImage : null,
  };
}

// ─── AI response shape validation/normalization (decision/recommendation only) ───
// This now validates ONLY the AI-generated decision fields (verdict, reasoning,
// pros/cons, negotiation, resale). Market price fields are validated separately
// because they come from the cache/pipeline, not the AI model.
interface FieldIssue {
  field: string;
  expected: string;
  received: string;
  value: unknown;
}

function describeType(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function isNumberOrNull(v: unknown): v is number | null {
  return v === null || typeof v === "number";
}

// A "good"/complete AI narrative response fills preRecommendation,
// futureCompatibility, negotiationScript, pros, cons, hiddenRisks, and
// betterAlternatives. Occasionally the model returns a technically-valid
// JSON object (verdict/regretLevel present) but leaves most of those
// mandatory fields blank/empty — bilingualStrings/bilingualArrays then
// silently normalize that to "" / [] with no error, and the report renders
// with several empty boxes. This checks the RAW model output (before that
// normalization hides the difference) so we can retry once instead of
// silently accepting/caching a half-blank report.
function isNarrativeCriticallyEmpty(raw: any): boolean {
  const emptyStr = (v: any) => !(typeof v?.ar === "string" && v.ar.trim().length > 0);
  const emptyArr = (v: any) => !(Array.isArray(v?.ar) && v.ar.length > 0);
  const emptyAlternatives = !(
    Array.isArray(raw?.betterAlternatives) &&
    raw.betterAlternatives.some((a: any) => typeof a?.name === "string" && a.name.trim().length > 0)
  );
  const checks = [
    emptyStr(raw?.preRecommendation),
    emptyStr(raw?.futureCompatibility),
    emptyStr(raw?.negotiationScript),
    emptyArr(raw?.pros),
    emptyArr(raw?.cons),
    emptyArr(raw?.hiddenRisks),
    emptyAlternatives,
  ];
  const emptyCount = checks.filter(Boolean).length;
  return emptyCount >= 4; // majority of mandatory fields blank => something went wrong
}

async function callAnalysisModelWithRetry(prompt: string): Promise<{ data: any; modelUsed: string; usage: any }> {
  const first = await callAnalysisModel(prompt);
  if (!isNarrativeCriticallyEmpty(first.data)) return first;

  console.warn("[/api/analyze] AI narrative response came back mostly empty (preRecommendation/futureCompatibility/negotiationScript/pros/cons/hiddenRisks/betterAlternatives) — retrying once.");
  try {
    const retry = await callAnalysisModel(prompt);
    if (isNarrativeCriticallyEmpty(retry.data)) {
      console.warn("[/api/analyze] Retry also came back mostly empty — proceeding with the retry result anyway (better than a hard failure).");
    }
    return retry;
  } catch (e) {
    console.error("[/api/analyze] Retry after empty narrative response failed — using the original (mostly empty) result:", e);
    return first;
  }
}

function bilingualStrings(v: any): { ar: string; en: string } {
  return {
    ar: typeof v?.ar === "string" ? v.ar : "",
    en: typeof v?.en === "string" ? v.en : "",
  };
}

function bilingualArrays(v: any): { ar: string[]; en: string[] } {
  return {
    ar: Array.isArray(v?.ar) ? v.ar : [],
    en: Array.isArray(v?.en) ? v.en : [],
  };
}

// Validate and normalize the AI-generated DECISION (verdict, reasoning,
// negotiation, resale). Market price fields are handled separately via
// normalizeMarketData below.
function validateAndNormalizeDecision(aiOutput: any): { ok: true; data: any } | { ok: false; issues: FieldIssue[] } {
  const issues: FieldIssue[] = [];

  if (typeof aiOutput !== "object" || aiOutput === null || Array.isArray(aiOutput)) {
    issues.push({ field: "(root)", expected: "object", received: describeType(aiOutput), value: aiOutput });
    return { ok: false, issues };
  }

  // verdict is the only essential AI-generated field
  if (typeof aiOutput.verdict !== "string" || !["good", "fair", "bad"].includes(aiOutput.verdict)) {
    issues.push({
      field: "verdict",
      expected: '"good" | "fair" | "bad"',
      received: describeType(aiOutput.verdict),
      value: aiOutput.verdict,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  // Non-critical fields: normalize to safe defaults instead of throwing 502.
  const data = {
    verdict: aiOutput.verdict,
    reasoningPoints: bilingualArrays(aiOutput.reasoningPoints),
    pros: bilingualArrays(aiOutput.pros),
    cons: bilingualArrays(aiOutput.cons),
    hiddenRisks: bilingualArrays(aiOutput.hiddenRisks),
    preRecommendation: bilingualStrings(aiOutput.preRecommendation),
    futureCompatibility: bilingualStrings(aiOutput.futureCompatibility),
    regretJustification: bilingualStrings(aiOutput.regretJustification),
    finalTip: bilingualStrings(aiOutput.finalTip),
    negotiationScript: bilingualStrings(aiOutput.negotiationScript),
    regretLevel: ["low", "medium", "high"].includes(aiOutput.regretLevel) ? aiOutput.regretLevel : "medium",
    ...(aiOutput.negotiationScriptVariants
      ? (() => {
          const baseScript = bilingualStrings(aiOutput.negotiationScript);
          const politeVariant = bilingualStrings(aiOutput.negotiationScriptVariants?.polite);
          const firmVariant = bilingualStrings(aiOutput.negotiationScriptVariants?.firm);
          // A variant with empty ar text would render an empty negotiation
          // box for whichever tab the user has selected — fall back to the
          // base negotiationScript (which is always required) instead.
          return {
            negotiationScriptVariants: {
              polite: politeVariant.ar ? politeVariant : baseScript,
              firm: firmVariant.ar ? firmVariant : baseScript,
            },
          };
        })()
      : {}),
    resaleValueRightNow: typeof aiOutput.resaleValueRightNow === "number" ? aiOutput.resaleValueRightNow : null,
    resaleValue2Years: typeof aiOutput.resaleValue2Years === "number" ? aiOutput.resaleValue2Years : null,
    resaleInsight: bilingualStrings(aiOutput.resaleInsight),
  };

  return { ok: true, data };
}

// Validate and normalize the MARKET DATA (from cache or pipeline) — ensures
// the three price fields are always number | null, computing mid from
// min/max when the model omitted it.
function normalizeMarketData(raw: any): {
  min: number | null;
  max: number | null;
  mid: number | null;
  summary: { ar: string; en: string } | null;
} {
  const min: number | null = isNumberOrNull(raw.marketFairPriceMin) ? raw.marketFairPriceMin : null;
  const max: number | null = isNumberOrNull(raw.marketFairPriceMax) ? raw.marketFairPriceMax : null;
  let mid: number | null = raw.marketFairPriceMid;
  if (!isNumberOrNull(mid) || mid === null) {
    mid = min !== null && max !== null ? Math.round((min + max) / 2) : null;
  }
  return {
    min,
    max,
    mid,
    summary: raw.marketPriceSummary
      ? { ar: typeof raw.marketPriceSummary?.ar === "string" ? raw.marketPriceSummary.ar : "", en: typeof raw.marketPriceSummary?.en === "string" ? raw.marketPriceSummary.en : "" }
      : null,
  };
}

// ─── Dynamic AI prompt — always re-generated based on user context ───
function buildPrompt(opts: {
  product: string;
  offeredPrice: number;
  currency: string;
  notes: string;
  purpose: string;
  duration: string;
  specs: string;
  condition: string;
  language: "ar" | "en";
  tier: "free" | "premium";
  marketPrice: FairPriceRange;
}) {
  const { product, offeredPrice, currency, notes, purpose, duration, specs, condition, tier, language, marketPrice } = opts;

  const depthInstruction =
    tier === "premium"
      ? `PREMIUM DEPTH REQUIRED:
- reasoningPoints: 3-4 fuller sentences each, with specific numbers (prices, percentages, timing).
- pros: 3-4 complete specific sentences (not short phrases).
- cons: 2-3 complete specific sentences (not short phrases).
- hiddenRisks: 3-4 specific, actionable items (seller verification, serial number checks, spec mismatches vs the stated usage profile).
- Also include "negotiationScriptVariants": { "polite": {"ar":"...","en":"..."}, "firm": {"ar":"...","en":"..."} } IN ADDITION to negotiationScript.
  - "polite" MUST read as genuinely warm and deferential: a friendly opening greeting, indirect/softened phrasing ("would it be possible...", "I was wondering if..."), no pressure or urgency, may briefly compliment the item before asking.
  - "firm" MUST read as direct and confident: opens straight with a specific number/offer (no small talk), no over-apologizing or hedging, assertive but still polite/respectful in tone — never rude.
  - The two MUST differ in their opening line, sentence structure, and overall tone — not just in word choice. If they would sound interchangeable with the labels swapped, rewrite them until they clearly wouldn't.`
      : `FREE TIER DEPTH:
- reasoningPoints: 2-3 short numbered points.
- pros: 2-4 short bullet phrases.
- cons: 2-3 short bullet phrases.
- hiddenRisks: 1-2 short risk strings.
- Do NOT include negotiationScriptVariants, only the single negotiationScript field.`;

  const marketPriceSummaryText = marketPrice.summary ? (language === "ar" ? marketPrice.summary.ar : marketPrice.summary.en) : null;

  return `You are a purchase-decision analyst producing a structured JSON analysis for this product.

PRODUCT: ${product}
OFFERED PRICE: ${offeredPrice} ${currency}
PRODUCT CONDITION: ${condition}
USER NOTES: ${notes || "none"}
USAGE PROFILE — purpose: ${purpose}, expected duration: ${duration}, other specs/preferences: ${specs || "none"}

MARKET PRICE DATA (already researched live for you by a separate pricing system — DO NOT recalculate or invent different numbers, just use these exact figures everywhere you need a price):
- marketFairPriceMin: ${marketPrice.min ?? "null"}
- marketFairPriceMax: ${marketPrice.max ?? "null"}
- marketFairPriceMid: ${marketPrice.mid ?? "null"}
${marketPriceSummaryText ? `- Research note: ${marketPriceSummaryText}` : "- No reliable pricing signal was found — treat both bounds as null."}

${depthInstruction}

Return a JSON object with EXACTLY this shape (all text fields must have both "ar" and "en" versions, natural fluent Arabic and English — not machine-translated):

{
  "verdict": "good" | "fair" | "bad",
  "reasoningPoints": { "ar": string[], "en": string[] },
  "preRecommendation": { "ar": string, "en": string },
  "futureCompatibility": { "ar": string, "en": string },
  "regretLevel": "low" | "medium" | "high",
  "regretJustification": { "ar": string, "en": string },
  "pros": { "ar": string[], "en": string[] },
  "cons": { "ar": string[], "en": string[] },
  "hiddenRisks": { "ar": string[], "en": string[] },
  "finalTip": { "ar": string, "en": string },
  "negotiationScript": { "ar": string, "en": string }${tier === "premium" ? ',\n  "negotiationScriptVariants": { "polite": {"ar":string,"en":string}, "firm": {"ar":string,"en":string} }' : ""},
  "resaleValueRightNow": number | null,
  "resaleValue2Years": number | null,
  "resaleInsight": { "ar": string, "en": string },
  "betterAlternatives": [
    { "name": string, "reason": { "ar": string, "en": string }, "whySuitable": { "ar": string, "en": string } }
  ]
}

Rules:
- verdict: "good" if offeredPrice < marketFairPriceMin, "fair" if within range, "bad" if above marketFairPriceMax (using the given numbers above). If the price fields are null, use "fair" unless other context clearly points elsewhere.
- All prices in ${currency}.
- resaleValueRightNow: estimate what this product would sell for on the second-hand market RIGHT NOW (in ${currency}), based on brand reputation, current demand, and the offeredPrice of ${offeredPrice} ${currency}. Return null if no reliable data.
- resaleValue2Years: estimate what this product will be worth on the second-hand market in 2 years from now. Return null if no reliable data.
- resaleInsight: a bilingual text with a brief insight about the resale value of this product. E.g. in Arabic: "آبل بتحتفظ بقيمة عالية جداً في السوق، بعد سنتين ممكن تبيعه بـ 55% من سعره" and in English: "Apple retains value well in the market, after 2 years you can sell for ~55% of current price."
- betterAlternatives (MANDATORY, always include exactly 3-4 items, never an empty array): real, currently-sold, named products (brand + model, e.g. "Samsung Galaxy S24 Ultra 256GB", not a generic category like "a cheaper phone") that are genuine alternatives to ${product} for this user's stated usage profile — a mix of (a) close competitors at a similar or lower price and (b) a notably cheaper option that still covers the stated purpose/duration.
  - "name": the alternative's plain product name/model only (no bilingual object, no price, no extra words) — it is used as-is in a live retailer search, so keep it a clean, searchable product name.
  - "reason": one bilingual sentence on why this is a relevant alternative to compare against — specs or value angle ONLY. **NEVER mention any specific price, number, currency amount, or percentage of any kind** (no "10,000 EGP cheaper", no "~15% less", nothing numeric) — you have NOT been given verified pricing for these alternatives, so any number you write would be fabricated. Describe it qualitatively instead, e.g. "a more affordable option with a similar core experience" / "the previous generation at a lower price point".
  - "whySuitable": one bilingual sentence on why it fits THIS user's specific purpose/duration/notes from the usage profile above — same rule: no prices, numbers, or currency amounts here either.
  - Never repeat ${product} itself or a different storage/color variant of the exact same model as an "alternative".
- negotiationScript (MANDATORY DIRECTION): always write this as a message the USER (the BUYER) would send TO the merchant/seller — over WhatsApp, chat, or in person — to convince them to lower the price based on the fair market price above. It must NEVER be phrased as if the merchant/seller is the one speaking to the buyer.
- finalTip / negotiationScript (MANDATORY PRICE-DIRECTION LOGIC): any specific target price you mention MUST be LOWER than offeredPrice (${offeredPrice} ${currency}) — never equal to or higher than it. The entire point of negotiating is paying LESS than the price on offer, so a target above offeredPrice is a contradiction and is never valid, regardless of where offeredPrice sits relative to marketFairPriceMin/Max.
  - If verdict is "good" (offeredPrice is already at or below marketFairPriceMin): this is an EXCELLENT / golden deal for the buyer, NOT a problem to fix. Never describe the price as wrong, suspicious-because-cheap, or something to push down further, and NEVER suggest any negotiation target price in this case. Instead:
    - finalTip must explicitly praise the price as an excellent/rare deal well below the fair market range, and recommend moving to confirm the purchase quickly before the seller reconsiders or someone else buys it.
    - The ONLY thing finalTip and negotiationScript should ask the user to verify is the product's condition and legitimacy — e.g. confirming the item is not stolen (ask for the original box/receipt/IMEI or serial number and check it isn't reported lost/stolen), checking it has no hidden defects, and confirming warranty/accessories are as described. This is a condition check, not a price negotiation.
    - negotiationScript in this case should read as a short, friendly buyer message confirming strong interest, asking the seller to hold the item, and politely asking to verify the IMEI/serial number and check the device for any hidden defects before finalizing — it must NOT ask for any discount or lower price.
  - If verdict is "fair" or "bad": a negotiation target price is appropriate, but it must sit strictly below offeredPrice (e.g. anchored near marketFairPriceMin or a reasonable point between marketFairPriceMin and offeredPrice) — never above offeredPrice.
- Return ONLY the JSON object, nothing else.`;
}

// ─── Main handler ───
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);
  logEnvPresence({
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY, // optional — Gemini fallback is skipped (not fatal) if unset
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  if (req.method !== "POST") {
    console.warn("[/api/analyze] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // ---- Race-safe quota reservation (declared outside the try/catch below
  // so the catch block can release a reservation if anything throws) ----
  const adminForRelease = getSupabaseAdmin();
  let usageReservation: { kind: "user"; userId: string } | { kind: "device"; fingerprint: string; ip: string; resetAt: string } | { kind: "ip"; ip: string } | null = null;

  async function releaseReservation() {
    if (!usageReservation) return;
    try {
      if (usageReservation.kind === "user") {
        const { data: row } = await adminForRelease.from("users").select("scans_used_this_month").eq("id", usageReservation.userId).single();
        if (row) {
          await adminForRelease.from("users").update({ scans_used_this_month: Math.max(0, row.scans_used_this_month - 1) }).eq("id", usageReservation.userId);
        }
      } else if (usageReservation.kind === "device") {
        const { data: row } = await adminForRelease
          .from("device_usage_logs")
          .select("scans_used_this_month")
          .eq("device_fingerprint", usageReservation.fingerprint)
          .eq("scans_reset_at", usageReservation.resetAt)
          .single();
        if (row) {
          await adminForRelease
            .from("device_usage_logs")
            .update({ scans_used_this_month: Math.max(0, row.scans_used_this_month - 1) })
            .eq("device_fingerprint", usageReservation.fingerprint)
            .eq("scans_reset_at", usageReservation.resetAt);
        }
      } else if (usageReservation.kind === "ip") {
        const { data: row } = await adminForRelease.from("guest_usage").select("scans_used_this_month").eq("ip_address", usageReservation.ip).single();
        if (row) {
          await adminForRelease.from("guest_usage").update({ scans_used_this_month: Math.max(0, row.scans_used_this_month - 1) }).eq("ip_address", usageReservation.ip);
        }
      }
    } catch (releaseErr) {
      console.error("[/api/analyze] Failed to release usage reservation (non-fatal):", releaseErr);
    }
  }

  try {
    const {
      product,
      offeredPrice,
      currency,
      notes = "",
      purpose = "personal",
      duration = "threePlusYears",
      specs = "",
      condition = "new",
      language = "ar",
      imageBase64, // optional: { data, mimeType }
      deviceFingerprint, // optional: device fingerprint from FingerprintJS
    } = req.body || {};

    // "Find the price" mode: the person doesn't know/didn't provide a
    // price at all (either they left it blank on purpose, or photo OCR
    // couldn't read one off the listing). In that case there's no verdict
    // to compute — offeredPrice is simply absent and we skip straight to
    // returning the researched fair-price range + real store comparison.
    const hasPrice = offeredPrice !== undefined && offeredPrice !== null && offeredPrice !== "" && !isNaN(Number(offeredPrice)) && Number(offeredPrice) > 0;

    console.log("[/api/analyze] Validating input...");
    if (!product || typeof product !== "string") {
      console.warn("[/api/analyze] Invalid input:", { product, offeredPrice });
      return res.status(400).json({ error: "invalid_input" });
    }
    console.log("[/api/analyze] Input OK. product:", product, "| offeredPrice:", hasPrice ? offeredPrice : "(none — find-price mode)", "| currency:", currency);

    console.log("Checking authentication...");
    const admin = getSupabaseAdmin();
    const user = await getAuthedUser(req);
    console.log("Authentication OK. Signed in:", !!user, user ? `(userId: ${user.id})` : "(guest)");

    let tier: "free" | "premium" = "free";
    // usageReservation/releaseReservation are declared above the outer
    // try/catch (Race-safe quota reservation) so a thrown error anywhere
    // below can still give the reserved slot back.

    if (user) {
      // ---- SIGNED-IN USER: check/enforce quota tied to their account row ----
      console.log("[/api/analyze] Loading user row for quota check...");
      const { data: userRow, error: userErr } = await admin
        .from("users")
        .select("tier, subscription_end_date, scans_used_this_month, scans_reset_at, scans_limit_this_month, current_plan_name")
        .eq("id", user.id)
        .single();

      if (userErr || !userRow) {
        console.error("[/api/analyze] user_not_found. Supabase error:", userErr);
        return res.status(404).json({ error: "user_not_found" });
      }
      console.log("[/api/analyze] User row loaded. tier:", userRow.tier, "| scansUsed:", userRow.scans_used_this_month);

      // Auto-revert to Free if subscription expired (Section 16)
      const now = new Date();
      let effectiveTier = userRow.tier;
      if (effectiveTier === "premium" && userRow.subscription_end_date && new Date(userRow.subscription_end_date) < now) {
        effectiveTier = "free";
        await admin.from("users").update({ tier: "free" }).eq("id", user.id);
      }
      tier = effectiveTier as "free" | "premium";

      // Section 15: Use dynamic limits from user row (stored when plan was activated)
      const scansLimit = tier === "premium" ? (userRow.scans_limit_this_month || DEFAULT_PREMIUM_LIMITS.scans) : FREE_MONTHLY_LIMIT;

      // Fair Use rate limit check (uses last-known usage snapshot purely for
      // the "how close to the cap" warning threshold — the actual quota
      // decision below is atomic and authoritative regardless of this value).
      const planName = tier === "premium" ? (userRow.current_plan_name || "small_bundle") : "free";
      const fairUse = checkFairUseRateLimit("user:" + user.id, planName, scansLimit, userRow.scans_used_this_month);
      if (!fairUse.allowed) {
        console.warn("[Fair Use / analyze] Rate limited user:", user.id, "| plan:", planName);
        return res.status(429).json({
          error: "rate_limited",
          message: fairUse.message,
          retryAfterMs: FAIR_USE_CONFIG.cooldownMs,
        });
      }

      // Atomic check-and-reserve — free tier also gets its calendar-month
      // reset applied inside the same transaction.
      const { data: reserved, error: reserveErr } = await admin.rpc("increment_user_scans", {
        p_user_id: user.id,
        p_limit: scansLimit,
        p_do_monthly_reset: tier === "free",
      });
      if (reserveErr) {
        console.error("[/api/analyze] increment_user_scans RPC failed:", reserveErr);
        return res.status(500).json({ error: "server_error" });
      }
      if (!reserved) {
        console.warn("[/api/analyze] Quota exceeded for user:", user.id, "| tier:", tier);
        return res.status(403).json({ error: "quota_exceeded" });
      }
      usageReservation = { kind: "user", userId: user.id };
    } else {
      // ---- GUEST: track by Device Fingerprint + IP (Server-authoritative) ----
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
      const now = new Date();

      // Resolve effective fingerprint (IP-aliasing: if same IP has >= 2 FPs in 24h,
      // they share the same quota)
      let effectiveFingerprint: string | null = deviceFingerprint || null;
      if (effectiveFingerprint) {
        // Check existing aliases first
        const { data: existingAlias } = await admin
          .from("guest_device_aliases")
          .select("primary_fingerprint")
          .eq("device_fingerprint", effectiveFingerprint)
          .single();
        if (existingAlias) {
          effectiveFingerprint = existingAlias.primary_fingerprint;
        } else {
          // Check IP-aliasing policy: if IP has >= 2 distinct FPs in 24h
          const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: recentLogs } = await admin
            .from("device_usage_logs")
            .select("device_fingerprint")
            .eq("ip_address", ip)
            .gte("created_at", cutoff);
          if (recentLogs && recentLogs.length >= 2) {
            const distinctFps = [...new Set(recentLogs.map((l: any) => l.device_fingerprint))];
            if (distinctFps.length >= 2) {
              const primaryFp = distinctFps[0];
              try {
                await admin.from("guest_device_aliases").insert({
                  device_fingerprint: effectiveFingerprint,
                  primary_fingerprint: primaryFp,
                  ip_address: ip,
                });
              } catch (e) {
                console.log("[/api/analyze] Alias insert skipped:", (e as any)?.message);
              }
              console.log("[/api/analyze] IP-alias: FP", effectiveFingerprint, "→ primary", primaryFp);
              effectiveFingerprint = primaryFp;
            }
          }
        }
      }

      console.log("[/api/analyze] Guest request. IP:", ip, "| FP:", effectiveFingerprint || "(none)");

      // Fair Use rate limit check for guests. Uses a last-known usage
      // snapshot purely for the "how close to the cap" warning threshold —
      // the actual quota decision below is atomic and authoritative
      // regardless of this value, so a stale read here can't be exploited.
      let lastKnownUsed = 0;
      if (effectiveFingerprint) {
        const { data: logRow } = await admin
          .from("device_usage_logs")
          .select("scans_used_this_month, scans_reset_at")
          .eq("device_fingerprint", effectiveFingerprint)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (logRow) {
          const resetAt = new Date(logRow.scans_reset_at);
          const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
          lastKnownUsed = needsReset ? 0 : logRow.scans_used_this_month;
        }
      } else {
        const { data: guestRow } = await admin.from("guest_usage").select("*").eq("ip_address", ip).single();
        if (guestRow) {
          const resetAt = new Date(guestRow.scans_reset_at);
          const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
          lastKnownUsed = needsReset ? 0 : guestRow.scans_used_this_month;
        }
      }

      const guestFairUse = checkFairUseRateLimit(
        "guest:" + (effectiveFingerprint || ip),
        "free",
        FREE_MONTHLY_LIMIT,
        lastKnownUsed
      );
      if (!guestFairUse.allowed) {
        console.warn("[Fair Use / analyze] Rate limited guest. IP:", ip, "| FP:", effectiveFingerprint || "(none)");
        return res.status(429).json({
          error: "rate_limited",
          message: guestFairUse.message,
          retryAfterMs: FAIR_USE_CONFIG.cooldownMs,
        });
      }

      // Atomic check-and-reserve — no more read-then-upsert race window.
      if (effectiveFingerprint) {
        const monthResetAt = now.getUTCFullYear() + "-" + String(now.getUTCMonth() + 1).padStart(2, "0") + "-01T00:00:00.000Z";
        const { data: reserved, error: reserveErr } = await admin.rpc("increment_device_scan", {
          p_fingerprint: effectiveFingerprint,
          p_ip: ip,
          p_reset_at: monthResetAt,
          p_limit: FREE_MONTHLY_LIMIT,
        });
        if (reserveErr) {
          console.error("[/api/analyze] increment_device_scan RPC failed:", reserveErr);
          return res.status(500).json({ error: "server_error" });
        }
        if (!reserved) {
          console.warn("[/api/analyze] Guest quota exceeded. IP:", ip, "| FP:", effectiveFingerprint);
          return res.status(403).json({ error: "quota_exceeded" });
        }
        usageReservation = { kind: "device", fingerprint: effectiveFingerprint, ip, resetAt: monthResetAt };
      } else {
        const { data: reserved, error: reserveErr } = await admin.rpc("increment_ip_scan", {
          p_ip: ip,
          p_limit: FREE_MONTHLY_LIMIT,
        });
        if (reserveErr) {
          console.error("[/api/analyze] increment_ip_scan RPC failed:", reserveErr);
          return res.status(500).json({ error: "server_error" });
        }
        if (!reserved) {
          console.warn("[/api/analyze] Guest quota exceeded (IP-only). IP:", ip);
          return res.status(403).json({ error: "quota_exceeded" });
        }
        usageReservation = { kind: "ip", ip };
      }
    }

    // ─── STEP 1: Get Market Data (cached or fresh pipeline) ───
    // The cache stores ONLY product market intelligence:
    //   - Fair market price range (min/max/mid)
    //   - Product purchase links (Amazon, Noon, Jumia, etc.)
    //   - Alternative products with their own fair price ranges
    // It NEVER stores AI-generated verdict, reasoning, negotiation, or resale.
    // Every analysis is re-generated dynamically from this cached market data
    // combined with the current user's offered price and context.
    console.log("Loading market data cache...");
    // Normalize the product name to a standard English form before it's used
    // for search or as the cache key — see normalizeProductNameForSearch in
    // _groq_tavily.ts. This keeps the raw `product` value (whatever the user
    // typed, in any language) unchanged for display purposes below.
    const searchProductName = await normalizeProductNameForSearch(product);
    const cacheKey = normalizeCacheKey(searchProductName, currency, condition, specs);
    const cacheCutoff = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

    let marketData: MarketCacheEntry | null = null;
    let modelUsed: string = "unknown";
    let aiUsage: any = null; // track AI usage even on cache miss
    // On a cache MISS, the narrative-analysis call below (aiResult) is run
    // with the exact same product/price/currency/notes/purpose/duration/
    // specs/condition/tier/marketPrice inputs the "dynamic analysis" call
    // further down would otherwise re-run with — i.e. it's the identical
    // prompt, called twice. That used to cost double the Groq tokens per
    // analysis (and was the direct cause of hitting Groq's per-minute token
    // rate limit, which is what actually produced the "analysisError" some
    // users saw despite the market-data step having succeeded). Stashing
    // the result here lets us skip the second call entirely on cache miss.
    let reusableAiResult: { data: any; modelUsed: string; usage: any } | null = null;

    const { data: cachedRow } = await admin
      .from("analysis_cache")
      .select("market_data, model_used, created_at")
      .eq("cache_key", cacheKey)
      .gte("created_at", cacheCutoff)
      .single();

    if (cachedRow && cachedRow.market_data) {
      // Cache hit — reuse market data, but still run AI analysis dynamically
      // with the current user's offered price and context.
      marketData = cachedRow.market_data;
      modelUsed = cachedRow.model_used || "cached-market";
      console.log("[/api/analyze] Market data cache hit. Running dynamic AI analysis...");
    } else {
      // Cache miss — run the full market research pipeline, then store
      // ONLY the market data (not the AI decision).
      const cond: "new" | "likeNew" | "used" = condition === "used" ? "used" : condition === "likeNew" ? "likeNew" : "new";

      // ---- STEP 1a: fair price range (background, invisible to the client) ----
      // Tries Groq Compound first (its own built-in live web search). If
      // Compound errors out — including the Free Tier's internal
      // response-size limit on its search tool, which throws a 413
      // regardless of our own request size — it falls through immediately
      // to a Serper + gpt-oss-120b pipeline instead of surfacing a failure.
      logStep("Calling fair price range pipeline (Compound, with Serper+GPT fallback)...");
      const marketPrice: FairPriceRange = await getFairPriceRange(searchProductName, currency, cond, specs);
      console.log("[/api/analyze] Fair price range:", marketPrice.min, "-", marketPrice.max, "| mid:", marketPrice.mid);

      // ---- STEP 1b: retailer direct listing links (Jumia/Amazon/Noon, etc.) ----
      let retailerPrices: any[] = [];
      try {
        retailerPrices = await fetchMainProductRetailerLinks(searchProductName, currency, cond);
      } catch (e) {
        console.error("[/api/analyze] Building retailer search links failed (non-fatal):", e);
      }

      // ---- STEP 1b-2: resolve REAL live prices for those links, then use the
      // actual cheapest/most-expensive price found as the fair price range —
      // replacing the AI-estimated marketPrice above. Ported from Shary's
      // live price-comparison engine (api/_priceResolver.ts): opens each
      // retailer link for real and reads JSON-LD/meta/AI-extracted price off
      // the live page. Never fabricates — if a store's price can't be read,
      // it's excluded rather than guessed. Falls back to the AI estimate
      // from STEP 1a only if literally zero stores resolve a real price, so
      // the range is never null.
      let productImage: string | null = null;
      try {
        logStep("Resolving live retailer prices...");
        // Domains with a known-poor plain-fetch success rate (learned from
        // cumulative history, see _domainHealth.ts) get routed to the
        // reader-proxy tier first inside resolvePricesForLinks, instead of
        // burning the fetch+retry budget on a path that's historically
        // near-0% for them.
        const knownBadDomains = await loadKnownBadDomains(admin);
        const resolved = await resolvePricesForLinks(retailerPrices, currency, knownBadDomains);
        // Exclude "similar product, not an exact match" hits (matched ===
        // false — see _groq_tavily.ts) from ever feeding the fair-price
        // range: a price read off a different model would skew the range
        // even though the store link itself is legitimate to show.
        const withPrice = resolved.filter((r) => typeof r.price === "number" && r.matched !== false);

        // Feed this live resolution's outcome back into the same
        // cumulative table — this is what lets the "known bad" signal
        // accumulate from real user-facing traffic (much higher volume
        // than the cron retry alone), not just the retry pass. Fire-and-
        // forget: never await this on the user-facing request path.
        if (resolved.length > 0) {
          const liveDomainStats = new Map<string, { attempts: number; fixed: number }>();
          for (const r of resolved) {
            const domain = hostnameOf(r.url);
            const stat = liveDomainStats.get(domain) || { attempts: 0, fixed: 0 };
            stat.attempts++;
            if (r.price != null) stat.fixed++;
            liveDomainStats.set(domain, stat);
          }
          persistDomainHealth(admin, liveDomainStats).catch(() => {});
        }

        // Only trust the REAL prices as the fair-price range once enough of
        // them came back — 1-3 stores is too thin a sample to safely
        // replace the AI's own broader-market estimate with (a single
        // store's price isn't a "range" at all, it's one data point that
        // could be unusually high or low). At 4+ stores the live numbers
        // are a more reliable signal than the AI estimate and take over.
        const MIN_STORES_FOR_REAL_RANGE = 4;
        if (withPrice.length >= MIN_STORES_FOR_REAL_RANGE) {
          const prices = withPrice.map((r) => r.price as number);
          const min = Math.min(...prices);
          const max = Math.max(...prices);
          marketPrice.min = min;
          marketPrice.max = max;
          marketPrice.mid = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
          // The AI's own summary sentence was written for its ESTIMATED
          // range — replace it with a plain, deterministic sentence built
          // from the real numbers so the text never contradicts the figures
          // shown above it.
          marketPrice.summary = {
            ar: `بناءً على أسعار حقيقية من ${withPrice.length} متاجر تم فحصها الآن، يتراوح السعر بين ${Math.round(min).toLocaleString()} و${Math.round(max).toLocaleString()} ${currency}.`,
            en: `Based on real prices just checked across ${withPrice.length} stores, the price ranges from ${Math.round(min).toLocaleString()} to ${Math.round(max).toLocaleString()} ${currency}.`,
          };
          console.log(`[/api/analyze] Real price range from ${withPrice.length} stores: ${min}-${max} (was AI estimate before override)`);
        } else {
          console.warn(
            `[/api/analyze] Only ${withPrice.length} store(s) resolved a real price (need ${MIN_STORES_FOR_REAL_RANGE}+) — keeping AI-estimated fair price range.`
          );
        }

        // Product photo: prefer the cheapest resolved store's image, else
        // any resolved store's image. Never generated — null if none found.
        const cheapestResolved = withPrice.length > 0
          ? withPrice.reduce((a, b) => ((a.price as number) <= (b.price as number) ? a : b))
          : null;
        productImage = cheapestResolved?.imageUrl || resolved.find((r) => r.imageUrl)?.imageUrl || null;

        // Merge the real price/stock/lastChecked data back into retailerPrices
        // so the "find the best price yourself" section can show real numbers
        // next to each store link instead of just a bare link.
        //
        // Links we could never confirm even open (source: "unreachable" —
        // every fetch path came back empty) are dropped here rather than
        // shown to the user: a link with no evidence it loads has no
        // business being presented as somewhere to go check the price.
        retailerPrices = resolved.filter((r) => r.source !== "unreachable");
      } catch (e) {
        console.error("[/api/analyze] Resolving live retailer prices failed (non-fatal, keeping AI-estimated range):", e);
      }

      // ---- STEP 1c: alternatives with their own fair price ranges + links ----
      // For now we need a lightweight prompt to get alternative names.
      // We pass this to the AI model in the same call (Step 2 below).
      // But we also need to research each alternative's pricing — that
      // happens below after the AI call.

      // ---- STEP 2: narrative analysis + alternative names ----
      // The AI model gets the market price as a fact and produces:
      // verdict, reasoning, pros/cons, negotiation, resale, AND alternative names.
      // The alternative pricing research happens separately after the AI call.
      //
      // Find-price mode (no offeredPrice) has no verdict to compute and no
      // point suggesting "better alternatives" to a price the person never
      // gave us — skip this whole narrative call and hand back just the
      // researched price range + real store comparison from Step 1 above.
      if (hasPrice) {
      const tempPrompt = buildPrompt({ product, offeredPrice: Number(offeredPrice), currency, notes, purpose, duration, specs, condition, language, tier, marketPrice });

      let aiResult;
      try {
        logStep("Calling AI pipeline (narrative analysis)...");
        aiResult = await callAnalysisModelWithRetry(tempPrompt);
        console.log("[/api/analyze] AI pipeline succeeded. modelUsed:", aiResult.modelUsed, "| usage:", aiResult.usage);
      } catch (e: any) {
        console.error("[/api/analyze] AI pipeline failed (both primary and fallback exhausted):");
        console.error(e);
        console.error(e?.stack);
        return res.status(502).json({ error: "analysis_failed", reason: e?.message });
      }

      modelUsed = aiResult.modelUsed;
      aiUsage = aiResult.usage;
      // Same inputs as the "dynamic analysis" call below would use — reuse
      // this result instead of paying for a second, near-identical call.
      reusableAiResult = aiResult;

      // Build the market data to cache (product intelligence only — no decision)
      const alternativesOutput: any[] = Array.isArray(aiResult.data?.betterAlternatives)
        ? aiResult.data.betterAlternatives
            .filter((a: any) => typeof a?.name === "string" && a.name.trim().length > 0)
            .slice(0, 4)
            .map((a: any) => ({
              ...a,
              reason: stripPriceMentions(a?.reason),
              whySuitable: stripPriceMentions(a?.whySuitable),
            }))
        : [];
      if (Array.isArray(aiResult.data?.betterAlternatives) && alternativesOutput.length === 0) {
        console.warn("[/api/analyze] Model returned betterAlternatives but all entries were malformed:", aiResult.data.betterAlternatives);
      }

      // Research each alternative's pricing + links (same as before)
      let alternativesWithPrices: AlternativeWithLinks[] = [];
      if (alternativesOutput.length > 0) {
        try {
          const region = getRegionForCurrency(currency);
          alternativesWithPrices = await attachLinksAndPricesToAlternatives(
            alternativesOutput,
            currency,
            region,
            cond
          );
        } catch (e) {
          console.error("[/api/analyze] Researching alternative prices failed (non-fatal):", e);
          alternativesWithPrices = attachSearchLinksToAlternatives(alternativesOutput, currency);
        }
      }

      marketData = {
        marketFairPriceMin: marketPrice.min,
        marketFairPriceMax: marketPrice.max,
        marketFairPriceMid: marketPrice.mid,
        marketPriceSummary: marketPrice.summary,
        retailerPrices,
        betterAlternatives: alternativesWithPrices,
        productImage,
      };

      // Log AI usage for the market research call
      if (aiUsage) {
        await logAiUsage(admin, {
          endpoint: "analyze",
          model: aiResult.modelUsed,
          tier: user ? tier : "guest",
          userId: user?.id || null,
          usage: aiUsage,
        });
      }
      } else {
        // Find-price mode: no AI narrative call, no alternatives — just the
        // real researched price data from Step 1.
        modelUsed = "find-price-mode";
        marketData = {
          marketFairPriceMin: marketPrice.min,
          marketFairPriceMax: marketPrice.max,
          marketFairPriceMid: marketPrice.mid,
          marketPriceSummary: marketPrice.summary,
          retailerPrices,
          betterAlternatives: [],
          productImage,
        };
      }

      console.log(`[/api/analyze] Compound market price: min=${marketPrice.min}, max=${marketPrice.max}, mid=${marketPrice.mid}`);

      // Store market data for future requests (product intelligence only)
      await admin.from("analysis_cache").upsert({
        cache_key: cacheKey,
        market_data: marketData,
        model_used: modelUsed,
        created_at: new Date().toISOString(),
      });
      console.log("Saving market data to cache... done");
    }

    // ─── STEP 2: Dynamic AI Analysis ───
    // On a cache HIT, no decision has been generated yet for this request,
    // so we still need this call. On a cache MISS, `reusableAiResult` above
    // already holds the result of calling the model with these exact same
    // inputs (product/price/currency/notes/purpose/duration/specs/
    // condition/tier/marketPrice) — so we reuse it instead of firing a
    // second, functionally identical call. This halves Groq token usage per
    // new-product analysis and avoids the per-minute rate-limit errors that
    // a second unnecessary call was causing.
    const normalizedMarket = normalizeMarketData(marketData);

    // ─── Find-price mode: no verdict to compute, assemble a lighter result
    // directly from the researched market data and skip the AI decision
    // call, community-insights price logging, and history verdict entirely.
    let result: Record<string, any>;

    if (!hasPrice) {
      result = {
        id: crypto.randomUUID(),
        product,
        priceMode: "findPrice",
        offeredPrice: null,
        currency,
        condition,
        marketFairPriceMin: normalizedMarket.min,
        marketFairPriceMax: normalizedMarket.max,
        marketFairPriceMid: normalizedMarket.mid,
        marketPriceSummary: normalizedMarket.summary,
        retailerPrices: marketData.retailerPrices,
        productImage: marketData.productImage ?? null,
        createdAt: Date.now(),
      };
    } else {

    let dynamicAiResult: { data: any; modelUsed: string; usage: any };
    if (reusableAiResult) {
      dynamicAiResult = reusableAiResult;
    } else {
      const dynamicPrompt = buildPrompt({
        product,
        offeredPrice: Number(offeredPrice),
        currency,
        notes,
        purpose,
        duration,
        specs,
        condition,
        language,
        tier,
        marketPrice: {
          min: normalizedMarket.min,
          max: normalizedMarket.max,
          mid: normalizedMarket.mid,
          summary: normalizedMarket.summary,
        },
      });

      try {
        logStep("Calling AI pipeline (dynamic analysis for this user's context)...");
        dynamicAiResult = await callAnalysisModelWithRetry(dynamicPrompt);
        console.log("[/api/analyze] Dynamic AI analysis succeeded. modelUsed:", dynamicAiResult.modelUsed);
      } catch (e: any) {
        console.error("[/api/analyze] Dynamic AI analysis failed:");
        console.error(e);
        return res.status(502).json({ error: "analysis_failed", reason: e?.message });
      }
    }

    // Validate the AI decision output
    const decisionValidation = validateAndNormalizeDecision(dynamicAiResult.data);
    if (!decisionValidation.ok) {
      console.error("[/api/analyze] Decision validation failed");
      for (const issue of decisionValidation.issues) {
        console.error(
          `Field: ${issue.field}\nExpected: ${issue.expected}\nReceived: ${issue.received}\nValue: ${JSON.stringify(issue.value)}`
        );
      }
      console.error("Raw AI JSON:", JSON.stringify(dynamicAiResult.data)?.slice(0, 4000));
      return res.status(502).json({
        error: "analysis_invalid",
        issues: decisionValidation.issues.map(({ field, expected, received }) => ({ field, expected, received })),
      });
    }

    // Log AI usage for the dynamic analysis call — only when it was an
    // actual fresh call (cache hit path). On cache miss, this is the same
    // reusableAiResult whose usage was already logged above, so logging it
    // again here would double-count the cost/usage for one real API call.
    if (!reusableAiResult && dynamicAiResult.usage) {
      await logAiUsage(admin, {
        endpoint: "analyze",
        model: dynamicAiResult.modelUsed,
        tier: user ? tier : "guest",
        userId: user?.id || null,
        usage: dynamicAiResult.usage,
      });
    }

    // ─── STEP 3: Assemble the final result ───
    // Market data (from cache or pipeline) + AI decision (always fresh)
    const decision = decisionValidation.data;

    const marketFairPriceMid: number | null = normalizedMarket.mid;
    const moneySaved = marketFairPriceMid === null ? null : Math.max(0, marketFairPriceMid - Number(offeredPrice));

    // ---- Community insights (Section 27 — REAL social proof, never fabricated) ----
    // Log this user's real offered price as an anonymous event, then look at
    // how many real events exist for the same product+currency.
    let communityInsights: {
      analyzedCount: number;
      recentPrices: number[];
    } | null = null;

    try {
      await admin.from("product_price_events").insert({
        cache_key: cacheKey,
        offered_price: Number(offeredPrice),
        currency,
      });

      const { count } = await admin
        .from("product_price_events")
        .select("*", { count: "exact", head: true })
        .eq("cache_key", cacheKey);

      const MIN_REAL_EVENTS_TO_SHOW = 3;

      if (count && count >= MIN_REAL_EVENTS_TO_SHOW) {
        const { data: recentEvents } = await admin
          .from("product_price_events")
          .select("offered_price")
          .eq("cache_key", cacheKey)
          .order("created_at", { ascending: false })
          .limit(5);

        communityInsights = {
          analyzedCount: count,
          recentPrices: (recentEvents || []).map((e: any) => Number(e.offered_price)),
        };
      }
    } catch (e) {
      console.error("[/api/analyze] community insights failed:", e);
    }

    result = {
      id: crypto.randomUUID(),
      product,
      priceMode: "evaluate",
      offeredPrice: Number(offeredPrice),
      currency,
      condition,
      // Market data (from cache or pipeline)
      marketFairPriceMin: normalizedMarket.min,
      marketFairPriceMax: normalizedMarket.max,
      marketFairPriceMid,
      marketPriceSummary: normalizedMarket.summary,
      retailerPrices: marketData.retailerPrices,
      betterAlternatives: marketData.betterAlternatives,
      productImage: marketData.productImage ?? null,
      // AI-generated decision (always fresh, never cached)
      ...decision,
      moneySaved,
      communityInsights,
      createdAt: Date.now(),
    };
    }

    // Usage was already reserved atomically up front (see usageReservation
    // above) — nothing left to record here. This also means a failed
    // analysis (thrown error below) correctly gives the slot back via
    // releaseReservation() in the catch block, same guarantee as before.
    console.log("[/api/analyze] Usage already recorded atomically at reservation time.");

    // ---- Item 4: auto-save premium analyses to history (regardless of the
    // "Save" button) — mirrors the same "analyses" table/shape AppContext's
    // client-side saveToHistory() writes, just done server-side right after
    // a successful analysis so it's never missed. Free/guest users still
    // rely on the manual save button in ReportScreen, unchanged. Never
    // blocks the response if it fails — just logs it.
    if (user && tier === "premium") {
      try {
        await admin.from("analyses").insert({
          user_id: user.id,
          product: result.product,
          offered_price: result.offeredPrice || 0,
          currency: result.currency,
          verdict: (result as any).verdict || null,
          market_fair_price_min: result.marketFairPriceMin || 0,
          market_fair_price_max: result.marketFairPriceMax || 0,
          market_fair_price_mid: result.marketFairPriceMid || 0,
          money_saved: result.moneySaved || 0,
          full_report: result,
        });
        console.log("[/api/analyze] Auto-saved premium analysis to history for user:", user.id);
      } catch (histErr) {
        console.error("[/api/analyze] Auto-save to history failed (non-blocking):", histErr);
      }
    }

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json(result);
  } catch (err: any) {
    logUnhandledError(err, start);
    await releaseReservation();
    // err.stack is logged server-side above (logUnhandledError) — never
    // send stack traces to the client, they leak internal file paths and
    // code structure to anyone who can trigger a 500.
    return res.status(500).json({
      error: "server_error",
      message: err?.message,
    });
  }
}
