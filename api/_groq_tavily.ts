import { logStep, logEnvPresence, loggedFetch, loggedJsonParse } from "./_logger.js";
import { computeMarketPriceRange, isSupportedCurrency, getSignificantTokens, matchesProduct, type SupportedCurrency } from "./_priceExtraction.js";
import { getFairPriceRangeViaGemini, callAnalysisModelViaGemini } from "./_gemini.js";

const PRIMARY_MODEL = "openai/gpt-oss-120b";
const FALLBACK_MODEL = "openai/gpt-oss-20b";
// Groq Compound — used ONLY in the background (never a step the client sees)
// to fetch the fair market price range. Unlike PRIMARY/FALLBACK_MODEL, it
// runs its own live web search internally, so it is never fed Serper
// snippets — it is the sole source of truth for pricing.
const COMPOUND_MODEL = "groq/compound";

export interface AiUsage {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  searchQueryCount: number;
}

export interface SerperResult {
  title: string;
  url: string;
  content: string;
  rawContent: string | null;
}

// Qarari runs on subscriptions, not retailer affiliate/commission deals — so
// there is no business reason to hide any store from the price comparison.
// The whole point of the product is showing the customer every real store
// that carries the item so they can find the cheapest price, regardless of
// whether Qarari has any commercial relationship with that store.

interface CountryRetailerMap {
  official: string;
  marketplace: string[];
}

const COUNTRY_RETAILERS: Record<string, CountryRetailerMap> = {
  EGP: {
    official: "site:apple.com OR site:samsung.com OR site:store.sony.com",
    marketplace: [
      "amazon.eg", "jumia.com.eg", "btech.com", "noon.com",
      "2b.com.eg", "rayashop.com", "carrefouregypt.com", "compumarts.com", "dreameg.net",
    ]
  },
  SAR: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["amazon.sa", "jarir.com", "extra.com", "noon.com"]
  },
  AED: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["amazon.ae", "noon.com", "carrefour.ae"]
  },
  KWD: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["xcite.com", "amazon.com"]
  },
  USD: {
    official: "site:apple.com OR site:samsung.com OR site:bestbuy.com",
    marketplace: ["amazon.com", "bhphotovideo.com", "newegg.com"]
  },
  EUR: {
    official: "site:apple.com OR site:samsung.com",
    marketplace: ["amazon.de", "amazon.fr", "amazon.it"]
  }
};

// Secondhand/open-box marketplaces, used when condition is "likeNew"
// (كسر زيرو) or "used" (مستعمل) — searching new-retailer sites for these
// conditions returns nothing relevant, since those sites only sell new.
const USED_MARKETPLACES: Record<string, string[]> = {
  EGP: ["dubizzle.com.eg", "eg.opensooq.com"],
  SAR: ["opensooq.com", "haraj.com.sa"],
  AED: ["dubizzle.com"],
  KWD: ["opensooq.com"],
  USD: ["ebay.com", "swappa.com"],
  EUR: ["ebay.de"],
};

async function searchSerper(query: string, opts: { gl?: string; hl?: string } = {}): Promise<SerperResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) throw new Error("Missing SERPER_API_KEY");

  try {
    const res = await loggedFetch("serper.search", "https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({
        q: query,
        num: 10,
        ...(opts.gl ? { gl: opts.gl } : {}),
        ...(opts.hl ? { hl: opts.hl } : {}),
      }),
    });

    if (!res.ok) return [];
    const json = await res.json();
    const organic = Array.isArray(json?.organic) ? json.organic : [];
    return organic.map((r: any) => ({
      title: r.title || "",
      url: r.link || "",
      content: r.snippet || "",
      rawContent: null,
    }));
  } catch (error) {
    console.error("[Serper] Error:", error);
    return [];
  }
}

function extractTargetCurrency(prompt: string): string | null {
  const match = prompt.match(/OFFERED PRICE:\s*[\d.,\s]+\s*([A-Za-z]{3})\b/);
  if (!match) return null;
  const code = match[1].toUpperCase();
  return isSupportedCurrency(code) ? code : null;
}

function extractProductName(prompt: string): string {
  const match = prompt.match(/PRODUCT:\s*(.+)/i);
  return match ? match[1].trim() : "";
}

// The specs/variant line lives on its own line in the prompt: "USAGE PROFILE
// — purpose: X, expected duration: Y, other specs/preferences: Z". Pull just
// the Z part so the search query can include it (storage/RAM/size/etc.) —
// otherwise Serper only ever searches the bare product name and returns
// prices spanning every variant/SKU, which is what was producing the
// misleadingly wide market range.
function extractSpecs(prompt: string): string {
  const match = prompt.match(/other specs\/preferences:\s*(.+)/i);
  if (!match) return "";
  const value = match[1].trim();
  return value.toLowerCase() === "none" ? "" : value;
}

// "PRODUCT CONDITION: new|likeNew|used" — this decides which sites we search
// and which listings we keep. Searching new-retailer sites for a "used"
// request, or keeping refurbished/open-box listings for a "new" request,
// mixes conditions together and produces a misleadingly wide price range.
function extractCondition(prompt: string): "new" | "likeNew" | "used" {
  const match = prompt.match(/PRODUCT CONDITION:\s*(\w+)/i);
  const value = (match?.[1] || "new").toLowerCase();
  if (value === "used") return "used";
  if (value === "likenew") return "likeNew";
  return "new";
}

// A short bilingual qualifier appended to the query text so Serper itself
// biases toward the right condition, on top of restricting which domains we search.
function conditionQualifier(condition: "new" | "likeNew" | "used"): string {
  if (condition === "likeNew") return '("كسر زيرو" OR "open box" OR "like new")';
  if (condition === "used") return "(مستعمل OR used OR \"second hand\")";
  return "";
}

function buildSearchTerm(product: string, specs: string): string {
  return specs ? `${product} ${specs}` : product;
}

const CURRENCY_REGION_HINTS: Record<string, { gl: string; hl: string }> = {
  EGP: { gl: "eg", hl: "ar" },
  SAR: { gl: "sa", hl: "ar" },
  AED: { gl: "ae", hl: "ar" },
  KWD: { gl: "kw", hl: "ar" },
  USD: { gl: "us", hl: "en" },
  EUR: { gl: "de", hl: "en" },
};

export function getRegionForCurrency(currency: string): { gl: string; hl: string } {
  return CURRENCY_REGION_HINTS[currency] || { gl: "eg", hl: "ar" };
}

// ─── Product name normalization for search ───
// Live web search (Serper and Groq Compound's own search tool) works far
// more reliably against a standard English product name
// ("Samsung Galaxy S24 Ultra 1TB") than a literal Arabic product string
// ("سامسونج اس 24 الترا 1 تيرا") — retailer listings and price pages are
// almost always indexed in English, so an Arabic query returns weak or
// irrelevant results and the model quietly falls back to a stale guess
// from its training data instead of a real current price. This was the
// root cause of the same phone pricing at ~35,000 EGP (Arabic input) vs
// ~90,000 EGP (English input, the correct current price).
//
// This translates/normalizes the product name to a clean, searchable
// English name before it is ever used in a live search query or as the
// market-data cache key — so results are consistent and accurate no
// matter which language the user typed the product in. It is NEVER used
// for anything shown to the user (the raw input is always what's
// displayed) — only for search/cache purposes.
const productNameCache = new Map<string, string>();

function containsArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text);
}

export async function normalizeProductNameForSearch(product: string): Promise<string> {
  const trimmed = (product || "").trim();
  if (!trimmed || !containsArabic(trimmed)) return trimmed; // already a searchable English/Latin name

  const cacheKey = trimmed.toLowerCase();
  const cached = productNameCache.get(cacheKey);
  if (cached) return cached;

  try {
    const system =
      'You translate/normalize product names into the exact standard English name used on e-commerce sites (brand + model + variant, e.g. "Samsung Galaxy S24 Ultra 1TB", "iPhone 15 Pro Max 256GB"). Respond with ONLY the product name, nothing else — no quotes, no explanation, no extra words.';
    const json = await callGroqModelPlainText(FALLBACK_MODEL, system, trimmed);
    const normalized = json?.choices?.[0]?.message?.content?.trim();
    if (normalized && normalized.length > 0 && normalized.length < 150) {
      productNameCache.set(cacheKey, normalized);
      console.log(`[normalizeProductNameForSearch] "${trimmed}" -> "${normalized}"`);
      return normalized;
    }
  } catch (e) {
    console.error(`[normalizeProductNameForSearch] failed for "${trimmed}" (non-fatal, using original):`, (e as any)?.message);
  }
  return trimmed; // fail open — never block the pipeline
}

interface SearchState {
  allResults: SerperResult[];
  searchCount: number;
  lastMedian: number | null;
  lastConfidence: number;
  validPriceCount: number;
}

async function smartAdaptiveSearch(product: string, currency: string, region: { gl: string; hl: string }, condition: "new" | "likeNew" | "used", altProduct: string = ""): Promise<{ results: SerperResult[]; searchCount: number; retailerSearchResults: SerperResult[] }> {
  const state: SearchState = {
    allResults: [],
    searchCount: 0,
    lastMedian: null,
    lastConfidence: 0,
    validPriceCount: 0
  };

  const retailers = COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD;
  const usedSites = USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD;
  const qualifier = conditionQualifier(condition);
  const maxSearches = 6;

  // New-condition retailers only sell new stock, so they're irrelevant when
  // hunting for likeNew/used — skip straight to secondhand marketplaces.
  // (No official retail price comparison makes sense for used/likeNew, so
  // retailerSearchResults stays empty for this branch.)
  if (condition !== "new") {
    console.log(`[SmartSearch] Condition=${condition}: searching secondhand marketplaces`);
    const usedQuery = usedSites.map(m => `site:${m}`).join(" OR ");
    let query1 = `${product} price ${currency} ${qualifier} (${usedQuery})`;
    let results1 = await searchSerper(query1, region);
    state.allResults.push(...results1);
    state.searchCount++;

    let priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition, altProduct);
    if (priceAnalysis?.confidence === "High" && priceAnalysis.validCount >= 5) {
      // Used/likeNew marketplace results ARE the retailer results for this
      // condition — reuse them so direct listing links can be built too.
      return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults: results1 };
    }

    // Broaden with a plain query (still condition-qualified) if not enough signal yet
    let query2 = `${product} ${qualifier} price ${currency}`;
    let results2 = await searchSerper(query2, region);
    state.allResults.push(...results2);
    state.searchCount++;

    return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults: [...results1, ...results2] };
  }

  // SEARCH 1: Official Store
  console.log("[SmartSearch] Search 1: Official Store");
  let query1 = `${product} price ${currency} (${retailers.official})`;
  let results1 = await searchSerper(query1, region);
  state.allResults.push(...results1);
  state.searchCount++;
  console.log(`[SmartSearch] Search 1 returned ${results1.length} results`);

  // Check early stop condition 1: Confidence >= 90%
  let priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition, altProduct);
  if (priceAnalysis?.confidence === "High" && priceAnalysis.validCount >= 5) {
    console.log("[SmartSearch] Early stop: Confidence >= 90%");
    // Official-store-only stop means we never ran the marketplace (Jumia/Noon)
    // query, so there's nothing to build a retailer price comparison from.
    return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults: [] };
  }

  // SEARCH 2: Largest Marketplace
  console.log("[SmartSearch] Search 2: Largest Marketplace");
  const marketplaceQuery = retailers.marketplace.map(m => `site:${m}`).join(" OR ");
  let query2 = `${product} price ${currency} (${marketplaceQuery})`;
  let results2 = await searchSerper(query2, region);
  state.allResults.push(...results2);
  state.searchCount++;
  console.log(`[SmartSearch] Search 2 returned ${results2.length} results`);

  // These are the results that feed the per-retailer price comparison shown
  // in ReportScreen — reused as-is, no extra Serper call.
  const retailerSearchResults = results2;

  // Check early stop condition 2: At least 5 valid prices AND median change < 1%
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition, altProduct);
  if (priceAnalysis?.validCount >= 5) {
    const medianChange = state.lastMedian ? Math.abs(priceAnalysis.mid - state.lastMedian) / state.lastMedian : 1;
    if (medianChange < 0.01) {
      console.log("[SmartSearch] Early stop: 5+ prices with <1% median change");
      return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
    }
    state.lastMedian = priceAnalysis.mid;
  }

  // Check early stop condition 3: Last two searches added no new valid prices.
  // IMPORTANT: only counts as "no progress" if we'd already found SOME valid
  // prices — if validPriceCount is still 0 (e.g. a product from an
  // independent brand site that isn't on Amazon/Jumia/Noon/BTech), that just
  // means the official+marketplace searches don't apply here, not that
  // pricing is unreachable. In that case we must still try Search 3 below
  // (the unrestricted general web search) before giving up — stopping here
  // was silently skipping it and returning "price not available" for every
  // product outside the hardcoded retailer list.
  const pricesBefore = state.validPriceCount;
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition, altProduct);
  state.validPriceCount = priceAnalysis?.validCount || 0;
  
  if (state.validPriceCount > 0 && state.validPriceCount === pricesBefore && state.searchCount >= 2) {
    console.log("[SmartSearch] Early stop: No new valid prices in last searches");
    return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
  }

  // If confidence still below 90%, execute ONE additional search (Google Shopping)
  if (state.searchCount < maxSearches && (!priceAnalysis || priceAnalysis.confidence !== "High")) {
    console.log("[SmartSearch] Search 3: General web search (no site restriction)");
    let query3 = `${product} price ${currency}`;
    let results3 = await searchSerper(query3, region);
    state.allResults.push(...results3);
    state.searchCount++;
    console.log(`[SmartSearch] Search 3 returned ${results3.length} results`);

    // If we STILL have zero valid prices after the general search too, this
    // is very likely a niche/independent brand (not a major retailer at
    // all) — try one more, even looser query without the "price" keyword
    // forced next to a specific currency, since brand sites/social posts
    // often just show the number with a currency symbol rather than the
    // word "price". This is our last, broadest attempt before we accept
    // there's genuinely no findable market price.
    const afterSearch3 = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition, altProduct);
    if ((!afterSearch3 || afterSearch3.validCount === 0) && state.searchCount < maxSearches) {
      console.log("[SmartSearch] Search 4: Broadest fallback (brand/independent site)");
      let query4 = `"${product}" ${currency}`;
      let results4 = await searchSerper(query4, region);
      state.allResults.push(...results4);
      state.searchCount++;
      console.log(`[SmartSearch] Search 4 returned ${results4.length} results`);
    }
  }

  return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
}

// Vision-capable model on Groq, used ONLY for the payment-screenshot
// pre-check below. Separate from PRIMARY_MODEL/FALLBACK_MODEL (which are
// text-only) because it needs to accept an image_url content part.
// NOTE: verify this model id is still current on your Groq account/plan —
// Groq's vision model lineup changes; swap this string if the call starts
// failing with a model-not-found error.
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

export interface ScreenshotCheckResult {
  looksLikeReceipt: boolean;
  referenceNumber: string | null;
  amount: number | null;
  note: string;
}

/**
 * Fraud-reduction pre-check for subscription payment screenshots.
 *
 * This is NOT a replacement for manual review — it's a first filter that:
 * 1. Rejects obviously-wrong uploads (random photos, unrelated screenshots)
 *    before they ever hit the admin queue.
 * 2. Extracts the transaction reference number so the caller (handleSubscribe
 *    in api/user.ts) can block re-use of the exact same real receipt across
 *    multiple accounts — the part that actually stops fraud, since a
 *    genuine-looking receipt image will always pass a pure "is this a
 *    receipt" check.
 *
 * Fails OPEN on any error (network issue, model unavailable, bad JSON):
 * returns looksLikeReceipt: true with nulls, so a temporary AI outage never
 * blocks legitimate subscribers — it just falls back to pure manual review,
 * same as before this feature existed.
 */
export async function verifyPaymentScreenshot(imageUrl: string): Promise<ScreenshotCheckResult> {
  const apiKey = process.env.GROQ_API_KEY;
  const fallback: ScreenshotCheckResult = {
    looksLikeReceipt: true,
    referenceNumber: null,
    amount: null,
    note: "ai_check_skipped",
  };
  if (!apiKey) return fallback;

  try {
    const res = await loggedFetch("groq.vision.receipt-check", "https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: VISION_MODEL,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "You are checking an uploaded image for a payment-app subscription flow (Egyptian mobile wallets: InstaPay, Vodafone Cash, Fawry, bank transfer apps, etc). " +
                  "Look ONLY at what's visibly printed on the image. Return strict JSON with exactly these keys: " +
                  '{"looksLikeReceipt": boolean, "referenceNumber": string|null, "amount": number|null}. ' +
                  "looksLikeReceipt = true only if the image is clearly a payment/transfer confirmation screen (has a success indicator, a transferred amount, and typically a reference/transaction number). " +
                  "referenceNumber = the transaction/reference number exactly as printed (digits, no spaces), or null if none visible. " +
                  "amount = the numeric transferred amount, or null if unclear. Do not guess — if unsure, use null / false.",
              },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      console.error("[verifyPaymentScreenshot] Groq vision error:", res.status);
      return fallback;
    }
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return fallback;
    const parsed = loggedJsonParse("verifyPaymentScreenshot", content);
    return {
      looksLikeReceipt: parsed?.looksLikeReceipt !== false, // fail open on ambiguous parse
      referenceNumber: typeof parsed?.referenceNumber === "string" ? parsed.referenceNumber.trim() || null : null,
      amount: typeof parsed?.amount === "number" ? parsed.amount : null,
      note: "ai_check_ran",
    };
  } catch (err) {
    console.error("[verifyPaymentScreenshot] threw:", (err as any)?.message);
    return fallback;
  }
}

async function callGroqModel(model: string, system: string, user: string, maxTokens: number = 4096) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await loggedFetch("groq.chat", "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}`);
  return res.json();
}

/**
 * Same as callGroqModel but uses Groq's Structured Outputs
 * (response_format: json_schema, strict: true) instead of the loose
 * json_object mode.
 *
 * WHY THIS EXISTS: json_object mode only asks the model to "please output
 * valid JSON" — it does NOT constrain generation, so a model can (and, in
 * production, DID) emit structurally broken JSON, e.g. closing a nested
 * object one brace too early. With a schema this deeply nested and full of
 * repeated {"ar":[...], "en":[...]} blocks (reasoningPoints/pros/cons/
 * hiddenRisks/negotiationScriptVariants), gpt-oss-20b in particular loses
 * track of nesting under load. Groq then rejects the whole generation with
 * a 400 (json_validate_failed) — after we already paid for every token of
 * it — and the caller has nothing usable to fall back on.
 * json_schema + strict:true uses constrained (grammar-level) decoding on
 * Groq's side, so the output is GUARANTEED to match the schema — this
 * failure mode becomes structurally impossible, not just less likely.
 * Supported on both openai/gpt-oss-120b and openai/gpt-oss-20b.
 */
async function callGroqModelStructured(
  model: string,
  system: string,
  user: string,
  schemaName: string,
  schema: Record<string, any>,
  maxTokens: number = 4096
) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await loggedFetch("groq.chat", "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.1,
      max_tokens: maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
    }),
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}`);
  return res.json();
}

// Reusable bilingual-string / bilingual-array shapes for the analysis schema.
const biStr = {
  type: "object",
  additionalProperties: false,
  properties: { ar: { type: "string" }, en: { type: "string" } },
  required: ["ar", "en"],
};
const biArr = {
  type: "object",
  additionalProperties: false,
  properties: { ar: { type: "array", items: { type: "string" } }, en: { type: "array", items: { type: "string" } } },
  required: ["ar", "en"],
};

/**
 * Mirrors the JSON shape demanded in buildPrompt() (api/analyze.ts) exactly.
 * negotiationScriptVariants is always present in the schema (Groq's strict
 * mode requires every property to be listed in "required") even though the
 * free-tier prompt doesn't ask for it — analyze.ts already defaults missing
 * bilingual fields to "" downstream, so an empty-string pair is harmless.
 */
const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["good", "fair", "bad"] },
    reasoningPoints: biArr,
    preRecommendation: biStr,
    futureCompatibility: biStr,
    regretLevel: { type: "string", enum: ["low", "medium", "high"] },
    regretJustification: biStr,
    pros: biArr,
    cons: biArr,
    hiddenRisks: biArr,
    finalTip: biStr,
    negotiationScript: biStr,
    negotiationScriptVariants: {
      type: "object",
      additionalProperties: false,
      properties: { polite: biStr, firm: biStr },
      required: ["polite", "firm"],
    },
    resaleValueRightNow: { type: ["number", "null"] },
    resaleValue2Years: { type: ["number", "null"] },
    resaleInsight: biStr,
    betterAlternatives: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, reason: biStr, whySuitable: biStr },
        required: ["name", "reason", "whySuitable"],
      },
    },
  },
  required: [
    "verdict",
    "reasoningPoints",
    "preRecommendation",
    "futureCompatibility",
    "regretLevel",
    "regretJustification",
    "pros",
    "cons",
    "hiddenRisks",
    "finalTip",
    "negotiationScript",
    "negotiationScriptVariants",
    "resaleValueRightNow",
    "resaleValue2Years",
    "resaleInsight",
    "betterAlternatives",
  ],
};

/**
 * Same as callGroqModel but WITHOUT response_format: json_object.
 * Groq (like the OpenAI API it mirrors) rejects json_object mode with a 400
 * unless the literal word "json" appears somewhere in the messages — a
 * requirement that has nothing to do with whether the caller actually wants
 * JSON back. callGroqModel forced json_object unconditionally, which meant
 * any caller that just wants a plain text answer (no JSON keyword in its
 * prompt) got a guaranteed 400 on every single call. Use this for those —
 * e.g. normalizeProductNameForSearch, which just wants a plain product name
 * string back, not a JSON object.
 */
async function callGroqModelPlainText(model: string, system: string, user: string) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await loggedFetch("groq.chat", "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.1,
    }),
  });
  if (!res.ok) throw new Error(`Groq error ${res.status}`);
  return res.json();
}

/**
 * Dedicated caller for groq/compound — deliberately separate from
 * callGroqModel above because Compound has different needs:
 * - No response_format (not guaranteed to support strict JSON mode).
 * - A much higher max_completion_tokens: the tool-use loop (searching +
 *   reading results + writing the final answer) burns tokens fast, and the
 *   default limit was cutting Compound off mid-answer — producing a
 *   truncated, non-JSON response that failed to parse and silently fell
 *   back to "not available".
 * - Logs `executed_tools` from the response so it's provable (in the
 *   server logs) whether Compound actually ran a live search or not, since
 *   Groq's usage dashboard attributes Compound's token usage to its
 *   underlying constituent models rather than showing "groq/compound" as
 *   its own line item — the dashboard alone can't answer "did it search?".
 */
// Mapping from currency codes to Groq Web Search `search_settings.country` values.
// The web-search tool internally boosts results from the specified country,
// so e.g. "Egypt" makes Groq prioritize amazon.eg / jumia.com.eg pricing
// over amazon.com US listings — which is exactly what we need for
// per-currency fair-price ranges.
const CURRENCY_GROQ_COUNTRY: Record<string, string> = {
  EGP: "Egypt",
  SAR: "Saudi Arabia",
  AED: "United Arab Emirates",
  KWD: "Kuwait",
  USD: "United States",
  EUR: "Germany",
};

// Compound's own web-search tool is billed per search + per token, so unlike
// the Serper domain lists (which just build display links and cost nothing
// extra), we deliberately cap this to the top 3 marketplace domains for the
// price range so the tool has a narrower, cheaper search surface instead of
// fanning out across every marketplace. This cap is purely a cost control —
// it does not hide any store from the UI (the full retailer list is always
// shown; see fetchMainProductRetailerLinks).
const COMPOUND_MAX_PRICE_DOMAINS = 3;

// Helper that maps a retailer domain to a Groq `search_settings.include_domains`
// entry. The Groq web-search tool only accepts a plain list of domains (no
// `site:` prefix), so we strip that when building the settings object.
function buildGroqSearchSettings(currency: string, condition: "new" | "likeNew" | "used"): Record<string, any> {
  const country = CURRENCY_GROQ_COUNTRY[currency];
  const retailers = COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD;
  const usedSites = USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD;
  const domains = condition === "new" ? retailers.marketplace : usedSites;
  const settings: Record<string, any> = {};
  if (country) settings.country = country;
  // For new-condition searches, restrict to the top 3 known marketplace
  // domains so Groq's web search doesn't drift into unrelated blogs/forums
  // AND doesn't burn tokens checking every single marketplace.
  if (condition === "new" && domains.length > 0) {
    settings.include_domains = domains.slice(0, COMPOUND_MAX_PRICE_DOMAINS);
  }
  return settings;
}

async function callCompoundModel(model: string, system: string, user: string, searchSettings?: Record<string, any>): Promise<{ content: string; executedToolCount: number; finishReason: string | null }> {
  const apiKey = process.env.GROQ_API_KEY;
  const requestBody: Record<string, any> = {
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0.3,
    max_completion_tokens: 4096,
    // Only the web_search tool is needed for a price lookup — explicitly
    // excluding code_interpreter/visit_website stops Compound from running
    // extra billed tool calls (each is its own line item) that add nothing
    // for this use case.
    compound_custom: { tools: { enabled_tools: ["web_search"] } },
  };
  if (searchSettings && Object.keys(searchSettings).length > 0) {
    requestBody.search_settings = searchSettings;
  }
  const res = await loggedFetch(`groq.${model}`, "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    throw new Error(`Groq Compound HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  }
  const json = await res.json();
  const choice = json?.choices?.[0];
  const executedTools = Array.isArray(choice?.message?.executed_tools) ? choice.message.executed_tools : [];
  console.log(`[compound:${model}] executed_tools=${executedTools.length} finish_reason=${choice?.finish_reason}`);
  if (executedTools.length === 0) {
    console.warn(`[compound:${model}] Compound answered WITHOUT calling its search tool at all — likely answered from training data or declined to search. Raw content starts with:`, String(choice?.message?.content || "").slice(0, 200));
  }
  return {
    content: choice?.message?.content || "",
    executedToolCount: executedTools.length,
    finishReason: choice?.finish_reason || null,
  };
}

/**
 * Fast, tiny classification call for the "smart product icon" feature
 * (InputScreen product-name field). Deliberately separate from
 * callAnalysisModel/callAiWithFallback above:
 * - Uses FALLBACK_MODEL (the smaller/faster 20b model) — this only needs to
 *   pick one of a handful of categories, not reason deeply, so the smallest
 *   capable model keeps latency low.
 * - No web search at all (useSearch is simply never involved here) — the
 *   category is obvious from the product name/description alone, and a
 *   search would only add latency for zero benefit.
 * - A very small max token budget + a system prompt of the strictest
 *   `response_format: json_object` — keeps the round trip fast so the
 *   frontend's instant local keyword-based icon (see categoryIcons.ts) is
 *   never blocked; this call only *upgrades* the icon if/when it resolves.
 */
const ICON_CATEGORIES = [
  "phone", "laptop", "headphones", "watch", "camera", "tv",
  "console", "car", "shoes", "bag", "other",
] as const;
export type IconCategory = typeof ICON_CATEGORIES[number];

export async function classifyProductCategory(productName: string): Promise<IconCategory> {
  const trimmed = (productName || "").trim();
  if (!trimmed) return "other";

  const system =
    "You classify a shopping product name into exactly one category. " +
    `Valid categories: ${ICON_CATEGORIES.join(", ")}. ` +
    'Respond with ONLY this JSON object: {"category": "<one of the valid categories>"}. ' +
    "Text may be Arabic or English. If unsure, use \"other\". Never explain, never add extra fields.";

  try {
    const json = await callGroqModel(FALLBACK_MODEL, system, trimmed);
    const parsed = JSON.parse(json.choices[0].message.content);
    const category = String(parsed?.category || "").toLowerCase().trim();
    return (ICON_CATEGORIES as readonly string[]).includes(category) ? (category as IconCategory) : "other";
  } catch (e) {
    console.error("[classifyProductCategory] Groq call failed, falling back to 'other':", e);
    return "other";
  }
}

/**
 * Calls the primary analysis model to generate the full purchase-decision analysis:
 * pros/cons, hidden risks, alternatives, negotiation script, resale value.
 * Deliberately does NOT run any Serper search and is NOT responsible for
 * deriving the fair price range itself: the caller must supply the
 * Groq-Compound-derived price range as already-researched facts inside the
 * prompt. Serper's role in this pipeline is limited to direct retailer
 * links (see fetchMainProductRetailerLinks / attachLinksAndPricesToAlternatives).
 */
export async function callAnalysisModel(prompt: string): Promise<{ data: any; modelUsed: string; usage: AiUsage }> {
  const systemPrompt = "You are a purchase-decision analyst. Respond with ONLY a single valid JSON object.";
  // This schema (reasoningPoints, pros/cons/hiddenRisks, both negotiation
  // script variants, resale info, 3-4 bilingual betterAlternatives entries)
  // can easily run past a small default token budget on premium tier,
  // which silently truncates the JSON mid-object — every field before the
  // cut lands fine, but everything after (and the field being cut mid-way)
  // is lost, and downstream code was defaulting those to "" / [] with no
  // error. A generous explicit budget removes truncation as a cause.
  const ANALYSIS_MAX_TOKENS = 6000;
  try {
    const json = await callGroqModelStructured(PRIMARY_MODEL, systemPrompt, prompt, "purchase_analysis", ANALYSIS_JSON_SCHEMA, ANALYSIS_MAX_TOKENS);
    return {
      data: JSON.parse(json.choices[0].message.content),
      modelUsed: PRIMARY_MODEL,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
        searchQueryCount: 0,
      },
    };
  } catch (e) {
    console.warn("[callAnalysisModel] Groq PRIMARY_MODEL failed, trying Groq FALLBACK_MODEL:", (e as any)?.message || e);
    try {
      const json = await callGroqModelStructured(FALLBACK_MODEL, systemPrompt, prompt, "purchase_analysis", ANALYSIS_JSON_SCHEMA, ANALYSIS_MAX_TOKENS);
      return {
        data: JSON.parse(json.choices[0].message.content),
        modelUsed: FALLBACK_MODEL,
        usage: {
          promptTokens: json.usage.prompt_tokens,
          outputTokens: json.usage.completion_tokens,
          totalTokens: json.usage.total_tokens,
          searchQueryCount: 0,
        },
      };
    } catch (e2) {
      // Both Groq models exhausted (rate limit / truncated-JSON / outage).
      // Last resort: Gemini's free tier has a far higher TPM ceiling
      // (250,000 vs Groq's ~8,000), so it's very unlikely to be rate
      // limited at the exact same moment Groq is. Requires GEMINI_API_KEY;
      // if that's not set, this throws and the caller's existing
      // "both primary and fallback exhausted" error path is unchanged.
      console.warn("[callAnalysisModel] Groq FALLBACK_MODEL also failed, trying Gemini:", (e2 as any)?.message || e2);
      const { data, modelUsed } = await callAnalysisModelViaGemini(prompt);
      return {
        data,
        modelUsed,
        usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, searchQueryCount: 0 },
      };
    }
  }
}

export interface FairPriceRange {
  min: number | null;
  max: number | null;
  mid: number | null;
  summary: { ar: string; en: string } | null;
}

function stripJsonFences(text: string): string {
  return text.replace(/```json|```/g, "").trim();
}

// Pull the first {...} block out of a response that may contain stray prose
// around the JSON (Compound systems, unlike json_object mode, don't
// guarantee the response is ONLY the JSON object).
function extractJsonObject(text: string): string {
  const cleaned = stripJsonFences(text);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return cleaned;
  return cleaned.slice(start, end + 1);
}

/**
 * Groq Compound — runs entirely in the background (the client never sees
 * this as a separate step). This is the SOLE source of the fair market
 * price range for the main product: it performs its own live web search
 * internally and is never handed Serper snippets or any other pre-fetched
 * pricing signal.
 */
export async function getFairPriceRangeViaCompound(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used",
  specs: string
): Promise<FairPriceRange> {
  const conditionLabel = condition === "used" ? "used/second-hand" : condition === "likeNew" ? "like-new/open-box" : "new";
  const searchSettings = buildGroqSearchSettings(currency, condition);
  const targetStores: string[] = Array.isArray(searchSettings.include_domains) ? searchSettings.include_domains : [];
  const storesLabel = targetStores.length > 0 ? targetStores.join(", ") : "major retailers for this region";

  const system = "You are a market-pricing research analyst. You MUST use your web search tool before answering — you are never allowed to answer a pricing question from memory/training data alone, because prices change constantly and yours is out of date. Your final message must contain ONLY a single valid JSON object — no prose, no markdown code fences, no explanation before or after it.";
  const user = `Find the CURRENT fair market price range for this exact product in ${currency}, condition: ${conditionLabel}.

PRODUCT: ${product}${specs ? `\nVARIANT/SPECS: ${specs}` : ""}

Run exactly ONE web search covering these stores only: ${storesLabel}. One well-formed query is enough to see listings from all of them — do not run multiple separate searches or visit additional pages/sites beyond that one search's results; base your answer only on what that single search returns.

Ignore trade-in value, financing/installment/monthly-payment figures, insurance/warranty prices, accessory prices, coupon/discount amounts, and shipping/tax fees — only actual full selling-price listings for the product itself count. If a variant/spec is given above, the range MUST reflect that variant only, not other configurations.

After searching, respond with ONLY this JSON shape, nothing else — no markdown table, no citations, no commentary:
{ "min": number | null, "max": number | null, "mid": number | null, "summary": { "ar": string, "en": string } }

- min: the lowest reliable selling price in ${currency} you found for this exact product/variant.
- max: the highest reliable selling price in ${currency} you found for this exact product/variant.
- mid: the fair average/midpoint price in ${currency} based on what your search found — calculate this as the midpoint between min and max, or as the most common/representative price you saw. Return null ONLY if you genuinely found no reliable pricing signal.
- summary: ONE short natural sentence (in both Arabic and English) stating the range you found. If min/max/mid are null, say plainly that no reliable current price was found instead of describing a range.`;

  if (Object.keys(searchSettings).length > 0) {
    console.log(`[getFairPriceRangeViaCompound] search_settings for "${product}":`, JSON.stringify(searchSettings));
  }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { content, executedToolCount } = await callCompoundModel(COMPOUND_MODEL, system, user, searchSettings);
      const parsed = loggedJsonParse(`compound.price[${product}]#${attempt}`, extractJsonObject(content));
      let min = typeof parsed?.min === "number" ? parsed.min : null;
      let max = typeof parsed?.max === "number" ? parsed.max : null;
      // Same guard as the Serper fallback: a lone min or max renders as a
      // broken half-empty box in the UI — treat it as no signal instead.
      if (min === null || max === null) {
        if (min !== null || max !== null) {
          console.warn(`[getFairPriceRangeViaCompound] "${product}": incomplete range (min=${min}, max=${max}) — discarding.`);
        }
        min = null;
        max = null;
      }
      const modelMid = typeof parsed?.mid === "number" ? parsed.mid : null;
      // Trust the model's own midpoint when it provides one; otherwise
      // fall back to computing it locally from min/max (keeps behavior
      // identical if the model happens to skip the mid field).
      const mid = min !== null && max !== null ? (modelMid !== null ? modelMid : Math.round((min + max) / 2)) : null;
      const summary =
        parsed?.summary && typeof parsed.summary === "object"
          ? { ar: typeof parsed.summary.ar === "string" ? parsed.summary.ar : "", en: typeof parsed.summary.en === "string" ? parsed.summary.en : "" }
          : null;
      if (min === null && max === null && executedToolCount === 0 && attempt === 1) {
        // It answered null WITHOUT even searching — that's Compound skipping
        // the tool, not a genuine "no data found". Worth one retry with a
        // fresh attempt before accepting it.
        console.warn(`[getFairPriceRangeViaCompound] "${product}": null result with zero tool calls on attempt 1 — retrying once.`);
        continue;
      }
      return { min, max, mid, summary };
    } catch (e) {
      console.error(`[getFairPriceRangeViaCompound] Compound pricing failed for "${product}" on attempt ${attempt} (non-fatal):`, e);
      // 413 (Groq's own free-tier internal search-result size cap) and 429
      // (TPM rate limit) are not fixed by an immediate identical retry —
      // they just burn more of the same tight per-minute token budget that
      // the downstream analysis call still needs. Only genuinely transient
      // errors (5xx, network) are worth a second attempt.
      const msg = (e as any)?.message || "";
      const isRetryable = !/Groq Compound HTTP (413|429)/.test(msg);
      if (attempt === 2 || !isRetryable) {
        // Groq Compound is exhausted (413 response-size cap or 429 TPM
        // limit) — try Gemini + Google Search as a last resort before
        // falling through to the Serper+Groq fallback pipeline upstream.
        // Requires GEMINI_API_KEY; silently returns nulls if unset/fails,
        // same as before this fallback existed.
        console.warn(`[getFairPriceRangeViaCompound] "${product}": Groq Compound exhausted, trying Gemini.`);
        return await getFairPriceRangeViaGemini(product, currency, condition, specs);
      }
    }
  }
  return { min: null, max: null, mid: null, summary: null };
}

/**
 * The "fiery" fair-price extraction prompt for the Serper + gpt-oss-120b
 * fallback pipeline. Used ONLY when Groq Compound is unavailable or errors
 * out (e.g. the Free Tier's internal response-size limit on its search
 * tool, which throws a 413 regardless of how small our own request is).
 * Handed raw Serper search snippets and asked to derive the same
 * marketFairPriceMin/Max/Mid shape Compound would have produced.
 */
export function buildSmartSerperPricingPrompt(productName: string, currency: string, serperResultsJson: string, specs: string = ""): string {
  const variantLine = specs
    ? `\nالنسخة/المواصفات المطلوبة تحديداً: "${specs}" — هذا الشرط إلزامي وليس اختيارياً.`
    : "";
  const variantRule = specs
    ? `\n4. **تطابق النسخة إلزامي:** المستخدم حدد نسخة "${specs}" بالتحديد. استخرج السعر فقط من النتائج التي تذكر صراحة نفس هذه النسخة (نفس سعة التخزين/الذاكرة إلخ). تجاهل تماماً أي سعر يخص نسخة مختلفة (مثال: لو المطلوب 256GB، لازم تتجاهل تماماً أي سعر مذكور لنسخة 128GB أو 512GB حتى لو كانت النتيجة الوحيدة المتاحة). لو مفيش أي نتيجة تذكر النسخة المطلوبة بشكل صريح وواضح، أرجع marketFairPriceMin و marketFairPriceMax و marketFairPriceMid كلهم null بدل ما تخمن أو تستخدم سعر نسخة تانية.`
    : "";
  return `
أنت خبير تسعير ذكي جداً ومحلل سوق محترف في السوق المصري. 
أمامك نتائج بحث حية من محرك Google (عبر Serper) لمنتج: "${productName}" بالعملة (${currency}).${variantLine}

نتائج البحث كالتالي:
${serperResultsJson}

التعليمات الصارمة لاستخراج السعر العادل (Fair Price Range):
1. **تصفية دقيقة:** تجاهل تماماً الإعلانات الوهمية، قطع الغيار، الإكسسوارات الرخيصة، أو الأسعار غير المنطقية (مثل 1 جنيه أو أسعار قديمة لا تعبر عن الواقع). التركيز فقط على السعر الفعلي للجهاز الجديد أو المتاح حالياً في المتاجر المذكورة (مثل أمازون، جوميا، نون، إلخ).
2. **استخراج النطاق:** حدد بدقة ثلاثة أرقام:
   - marketFairPriceMin: أقل سعر منطقي وموثوق في السوق حالياً لنفس النسخة المطلوبة.
   - marketFairPriceMax: أعلى سعر عادل لنفس النسخة المطلوبة بدون مبالغة التجار.
   - marketFairPriceMid: السعر المتوسط أو المتوقع بدقة شديدة لنفس النسخة المطلوبة.
3. **الإخراج البرمجي الصارم:** أجب حصرياً بصيغة JSON نظيفة جداً ودون أي كلام إضافي، ولازم الحقول الثلاثة تكون كلها أرقام أو كلها null معاً (ممنوع تسيب واحد منهم null والباقي أرقام) بالشكل التالي:
{
  "marketFairPriceMin": 00000,
  "marketFairPriceMax": 00000,
  "marketFairPriceMid": 00000,
  "confidenceScore": 0.95
}${variantRule}
`;
}

/**
 * Fallback fair-price pipeline: Serper live search snippets fed into
 * gpt-oss-120b with buildSmartSerperPricingPrompt. Kicks in only when
 * Groq Compound (getFairPriceRangeViaCompound) errors out or comes back
 * empty — never runs alongside Compound, only instead of it.
 */
export async function getFairPriceRangeViaSerperFallback(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used",
  specs: string,
  altProduct: string = ""
): Promise<FairPriceRange> {
  try {
    const region = getRegionForCurrency(currency);
    const searchTerm = buildSearchTerm(product, specs);
    const { results } = await smartAdaptiveSearch(searchTerm, currency, region, condition, altProduct);

    if (results.length === 0) {
      console.warn(`[getFairPriceRangeViaSerperFallback] No Serper results for "${product}" — returning null range.`);
      return { min: null, max: null, mid: null, summary: null };
    }

    const serperResultsJson = JSON.stringify(
      results.slice(0, 15).map((r) => ({ title: r.title, url: r.url, snippet: r.content }))
    );
    const prompt = buildSmartSerperPricingPrompt(product, currency, serperResultsJson, specs);
    const systemPrompt = "You are a professional Egyptian-market pricing analyst. Respond with ONLY a single valid JSON object, no prose, no markdown fences.";

    let json;
    try {
      json = await callGroqModel(PRIMARY_MODEL, systemPrompt, prompt);
    } catch (e) {
      console.warn(`[getFairPriceRangeViaSerperFallback] Primary model failed for "${product}", trying fallback model:`, e);
      json = await callGroqModel(FALLBACK_MODEL, systemPrompt, prompt);
    }

    const parsed = loggedJsonParse(`serperFallback.price[${product}]`, extractJsonObject(json.choices[0].message.content));
    let min = typeof parsed?.marketFairPriceMin === "number" ? parsed.marketFairPriceMin : null;
    let max = typeof parsed?.marketFairPriceMax === "number" ? parsed.marketFairPriceMax : null;
    // Defensive guard: a range is only usable if BOTH ends are present.
    // A lone min or max (the model half-answering) would otherwise render
    // as a broken "22000–N/A" box in the UI — treat that as no signal.
    if (min === null || max === null) {
      console.warn(`[getFairPriceRangeViaSerperFallback] "${product}": incomplete range (min=${min}, max=${max}) — discarding.`);
      min = null;
      max = null;
    }
    const mid =
      typeof parsed?.marketFairPriceMid === "number"
        ? parsed.marketFairPriceMid
        : min !== null && max !== null
        ? Math.round((min + max) / 2)
        : null;

    const summary =
      min !== null && max !== null
        ? {
            ar: `بناءً على نتائج البحث الحية، يتراوح السعر العادل لـ ${product} حالياً بين ${min} و${max} ${currency}.`,
            en: `Based on live search results, the current fair price range for ${product} is between ${min} and ${max} ${currency}.`,
          }
        : null;

    console.log(`[getFairPriceRangeViaSerperFallback] "${product}": min=${min} max=${max} mid=${mid}`);
    return { min, max, mid, summary };
  } catch (e) {
    console.error(`[getFairPriceRangeViaSerperFallback] Fallback pipeline failed for "${product}" (non-fatal):`, e);
    return { min: null, max: null, mid: null, summary: null };
  }
}

/**
 * Combined entry point for the main product's fair price range, and the
 * ONLY function api/analyze.ts should call for this purpose.
 *
 * Serper (which queries Google's own search index directly, restricted to
 * the region's real retailer domains) is the PRIMARY source — it's what
 * actually matches what shows up in a plain Google search, which is the
 * ground truth users compare against. Groq Compound runs its own internal
 * web search with no domain restriction and no visibility into what index
 * it's hitting, and in practice has produced fair-price ranges far above
 * the real market (e.g. Samsung A17 256GB: Compound said ~22,400-28,000
 * EGP while Google itself shows ~13,690-15,560 EGP for the same phone).
 * So Compound is now only a last-resort fallback if Serper genuinely
 * returns nothing usable.
 */
export async function getFairPriceRange(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used",
  specs: string
): Promise<FairPriceRange> {
  // Always search using a normalized/English product name — see
  // normalizeProductNameForSearch above for why this matters. We also keep
  // the original (possibly Arabic) name and pass it through as an alternate
  // match target, since an independent/local brand's own listing page is
  // often Arabic-only and would never contain the English-translated name.
  const searchProduct = await normalizeProductNameForSearch(product);
  const altProduct = searchProduct !== product ? product : "";
  try {
    const serperResult = await getFairPriceRangeViaSerperFallback(searchProduct, currency, condition, specs, altProduct);
    if (serperResult.min !== null && serperResult.max !== null) {
      return serperResult;
    }
    console.warn(`[getFairPriceRange] Serper pipeline returned no usable range for "${searchProduct}"${specs ? ` (variant: ${specs})` : ""} — falling back to Groq Compound.`);
  } catch (e) {
    console.error(`[getFairPriceRange] Serper pipeline threw for "${searchProduct}" — falling back to Groq Compound:`, e);
  }
  try {
    return await getFairPriceRangeViaCompound(searchProduct, currency, condition, specs);
  } catch (e) {
    console.error(`[getFairPriceRange] Compound also threw for "${searchProduct}" — returning null range:`, e);
    return { min: null, max: null, mid: null, summary: null };
  }
}

export async function callAiWithFallback(
  prompt: string,
  imageBase64?: any,
  useSearch: boolean = true
): Promise<any> {
  let searchContext = "";
  let searchQueryCount = 0;
  let allResults: SerperResult[] = [];
  let retailerSearchResults: SerperResult[] = [];
  let targetCurrencyUsed = "EGP";

  if (useSearch) {
    const targetCurrency = extractTargetCurrency(prompt) || "EGP";
    targetCurrencyUsed = targetCurrency;
    const product = extractProductName(prompt);
    const specs = extractSpecs(prompt);
    const condition = extractCondition(prompt);
    const searchTerm = buildSearchTerm(product, specs);
    const region = CURRENCY_REGION_HINTS[targetCurrency] || { gl: "eg", hl: "ar" };

    // Execute Smart Adaptive Search
    const { results, searchCount, retailerSearchResults: retailerResults } = await smartAdaptiveSearch(searchTerm, targetCurrency, region, condition);
    allResults = results;
    searchQueryCount = searchCount;
    retailerSearchResults = retailerResults;

    // Serper's ONLY job is to fetch candidate listings/snippets. We
    // deliberately do NOT run a backend price calculation (computeMarketPriceRange)
    // and hand its output to the model as an "authoritative" figure anymore —
    // the AI itself is the one that reads the raw snippets and derives the
    // fair price range (see the PRICE SOURCE OF TRUTH rule in analyze.ts).
    // computeMarketPriceRange is still used internally by smartAdaptiveSearch
    // purely to decide when it has searched enough (an efficiency signal),
    // not to hand a computed number to the model.
    searchContext = "SEARCH SNIPPETS (raw listings found for this product — use these to work out the current fair price range yourself):\n" +
      allResults.slice(0, 15).map(r => `- ${r.title} (${r.url}): ${r.content}`).join("\n");
  }

  const systemPrompt = "You are a purchase-decision analyst. Respond with ONLY a single valid JSON object.";
  const userPrompt = `${prompt}\n\nSEARCH CONTEXT:\n${searchContext}`;

  try {
    const json = await callGroqModel(PRIMARY_MODEL, systemPrompt, userPrompt);
    return {
      data: JSON.parse(json.choices[0].message.content),
      modelUsed: PRIMARY_MODEL,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
        searchQueryCount
      },
      usedSearch: useSearch,
      retailerSearchResults,
      currency: targetCurrencyUsed
    };
  } catch (e) {
    const json = await callGroqModel(FALLBACK_MODEL, systemPrompt, userPrompt);
    return {
      data: JSON.parse(json.choices[0].message.content),
      modelUsed: FALLBACK_MODEL,
      usage: {
        promptTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens,
        totalTokens: json.usage.total_tokens,
        searchQueryCount
      },
      usedSearch: useSearch,
      retailerSearchResults,
      currency: targetCurrencyUsed
    };
  }
}

export interface AlternativeInput {
  name: string;
  reason: { ar: string; en: string };
  whySuitable: { ar: string; en: string };
}

export interface AlternativeWithLinks extends AlternativeInput {
  searchLinks: RetailerLink[];
  // Always null now — alternatives are link-only (see
  // attachLinksAndPricesToAlternatives). Kept in the type/UI so the report
  // component doesn't need changes; the fair-price block just won't render
  // for alternatives since ReportScreen only shows it when these are numbers.
  fairPriceMin: number | null;
  fairPriceMax: number | null;
  fairPriceMid: number | null;
}

// One live marketplace-scoped Serper search for a single alternative's name
// — same domain set (or used-marketplace set) as the main product search,
// so results are directly comparable and can double as both the "direct
// link" source and the pricing source.
async function searchAlternativeListings(
  altName: string,
  currency: string,
  region: { gl: string; hl: string },
  condition: "new" | "likeNew" | "used"
): Promise<SerperResult[]> {
  const retailers = COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD;
  const usedSites = USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD;
  const domains = condition === "new" ? retailers.marketplace : usedSites;
  const qualifier = conditionQualifier(condition);
  const siteQuery = domains.map((m) => `site:${m}`).join(" OR ");
  const query = `${altName} price ${currency} ${qualifier} (${siteQuery})`;
  return searchSerper(query, region);
}

/**
 * Serper's ONLY job for the main product: fetch raw listing snippets from
 * the target retailer/marketplace domains (Amazon/Jumia/Noon, or the
 * used-marketplace set for likeNew/used) so a direct link to a real first
 * listing can be picked. Never used for pricing — see
 * getFairPriceRangeViaCompound for that.
 */
async function fetchRetailerListings(
  product: string,
  currency: string,
  region: { gl: string; hl: string },
  condition: "new" | "likeNew" | "used"
): Promise<SerperResult[]> {
  const retailers = COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD;
  const usedSites = USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD;
  const qualifier = conditionQualifier(condition);
  const domains = condition === "new" ? retailers.marketplace : usedSites;

  // One Serper query PER domain, run in parallel — not a single combined
  // "(site:a OR site:b OR site:c)" query. A combined query only gets 10
  // organic slots total, and Google's ranking crowds those slots with
  // whichever single domain ranks highest for this query (almost always
  // Amazon), so the other stores never surface at all even though they
  // carry the product. Querying every domain separately guarantees each
  // store gets its own dedicated shot at a hit.
  const perDomainResults = await Promise.all(
    domains.map((domain) => searchSerper(`${product} price ${currency} ${qualifier} site:${domain}`, region))
  );
  return perDomainResults.flat();
}

/**
 * Domains that show up in general product-price searches but are never
 * themselves a store selling the product — social/video platforms, wikis,
 * review-only tech sites, and pure price-comparison aggregators (no
 * checkout/stock of their own, so a "price" read off them isn't a real
 * buyable price). Filtered out before a broad-search hit is ever considered
 * as a candidate retailer.
 */
const NON_RETAILER_DOMAINS = [
  "youtube.com", "facebook.com", "instagram.com", "tiktok.com", "twitter.com", "x.com",
  "reddit.com", "wikipedia.org", "linkedin.com", "pinterest.com",
  "google.com", "bing.com", "yahoo.com",
  "gsmarena.com", "cnet.com", "theverge.com", "engadget.com", "wired.com",
  "yaoota.com", "pricena.com", "priceoye.pk", "sooq.com",
  "wa.me", "whatsapp.com", "telegram.org", "t.me",
];

function isLikelyNonRetailer(domain: string): boolean {
  return NON_RETAILER_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

/**
 * Broad, UNRESTRICTED search for the exact product — no site: filter at all,
 * so any real store carrying it (an official brand site, a specialized
 * category store — e.g. an AC/appliance retailer, a local electronics
 * chain — whatever Google itself would surface) can turn up, not just the
 * fixed Amazon/Noon/Jumia/B.TECH list. Two query phrasings are combined
 * (plain "buy" query + the site-restricted "official" brand-site hint
 * already defined per currency in COUNTRY_RETAILERS) since a single Serper
 * call only returns ~10 organic hits and different phrasings surface
 * different stores.
 */
async function fetchBroadListings(
  product: string,
  currency: string,
  region: { gl: string; hl: string },
  condition: "new" | "likeNew" | "used"
): Promise<SerperResult[]> {
  const qualifier = conditionQualifier(condition);
  const official = (COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD).official;

  const generalQuery = `${product} price ${currency} ${qualifier} buy`.trim();
  const officialQuery = `${product} price ${currency} (${official})`;

  const [general, brand] = await Promise.all([
    searchSerper(generalQuery, region),
    searchSerper(officialQuery, region),
  ]);
  return [...general, ...brand];
}

/**
 * Turns broad (unrestricted) search hits into candidate retailer links:
 * drops known non-retailer domains, drops hits that don't actually mention
 * this exact product (reusing the same whole-word token match the fair-price
 * pipeline uses, so an "iPhone 15" search never pulls in an "iPhone 15 Pro"
 * page), keeps only the first hit per domain (one link per store), and caps
 * the total count so price-resolution stays fast.
 */
function pickBroadRetailerLinks(
  results: SerperResult[],
  product: string,
  seenDomains: Set<string>,
  maxLinks: number
): RetailerLink[] {
  const tokens = getSignificantTokens(product);
  const links: RetailerLink[] = [];

  for (const r of results) {
    if (!r.url) continue;
    const domain = urlDomain(r.url);
    if (!domain || isLikelyNonRetailer(domain) || seenDomains.has(domain)) continue;
    if (!matchesProduct(`${r.title} ${r.content}`, tokens)) continue;

    seenDomains.add(domain);
    links.push({
      retailer: RETAILER_DISPLAY_NAMES[domain] || domain.replace(/^www\./, ""),
      url: r.url,
      matched: true, // already passed matchesProduct() above
    });
    if (links.length >= maxLinks) break;
  }
  return links;
}

/**
 * One-call helper for the main product: combines the reliable, known-domain
 * links (Amazon/Noon/Jumia/B.TECH etc. — direct listing picked from a
 * site-restricted search) with a broad, unrestricted search that can surface
 * ANY other store actually carrying the exact product (an official brand
 * site, a specialized category store, a local chain — whatever's really out
 * there), then de-duplicates by domain so the same store never appears
 * twice. Falls back to plain store-search links only when Serper genuinely
 * returns nothing at all.
 */
export async function fetchMainProductRetailerLinks(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used"
): Promise<RetailerLink[]> {
  try {
    const searchProduct = await normalizeProductNameForSearch(product);
    const region = getRegionForCurrency(currency);

    const [fixedResults, broadResults] = await Promise.all([
      fetchRetailerListings(searchProduct, currency, region, condition),
      fetchBroadListings(searchProduct, currency, region, condition),
    ]);

    const fixedLinks = pickDirectRetailerLinks(fixedResults, searchProduct, currency, condition);
    const seenDomains = new Set(fixedLinks.map((l) => urlDomain(l.url)));
    const broadLinks = pickBroadRetailerLinks(broadResults, searchProduct, seenDomains, 8);

    const combined = [...fixedLinks, ...broadLinks];
    if (combined.length > 0) return combined;

    // Serper returned nothing at all for either query — fall back to plain
    // store-search links for the known domains so the UI still has
    // something to show rather than an empty list.
    return buildRetailerSearchLinks(product, currency, condition);
  }
}

/**
 * For each of the (exactly 4) alternatives: Serper fetches direct listing
 * links only (same marketplace domains as the main product) so the user can
 * click through and see the price themselves at the store.
 *
 * Deliberately NOT calling Groq Compound here anymore. Alternatives used to
 * get their own Compound-derived fair price range (4 parallel live-search
 * calls per report), but that was the direct cause of the 429/413 errors in
 * the logs: 4 simultaneous groq/compound calls blew past the org's
 * tokens-per-minute budget for the model behind Compound, on top of adding
 * ~20-50s to every request. The main product still gets its own Compound
 * price range via getFairPriceRangeViaCompound — that's the number that
 * actually matters for the verdict — alternatives are link-only now.
 */
export async function attachLinksAndPricesToAlternatives(
  alternatives: AlternativeInput[],
  currency: string,
  region: { gl: string; hl: string },
  condition: "new" | "likeNew" | "used"
): Promise<AlternativeWithLinks[]> {
  if (alternatives.length === 0) return [];

  const perAltResults = await Promise.all(
    alternatives.map((alt) => searchAlternativeListings(alt.name, currency, region, condition))
  );
  return alternatives.map((alt, i) => ({
    ...alt,
    searchLinks: pickDirectRetailerLinks(perAltResults[i], alt.name, currency, condition),
    fairPriceMin: null,
    fairPriceMax: null,
    fairPriceMid: null,
  }));
}

// Fallback-only path (no live search) — kept for when researchAndPriceAlternatives
// itself throws before any Serper call completes, so the UI still gets store
// search links even without a fair-price range.
export function attachSearchLinksToAlternatives(
  alternatives: AlternativeInput[],
  currency: string
): AlternativeWithLinks[] {
  return alternatives.map((alt) => ({
    ...alt,
    searchLinks: buildRetailerSearchLinks(alt.name, currency),
    fairPriceMin: null,
    fairPriceMax: null,
    fairPriceMid: null,
  }));
}

export interface RetailerLink {
  retailer: string;
  url: string;
  // true  = Serper's own result title/snippet for this URL was checked
  //         against the product's significant tokens and it's confirmed to
  //         be THIS product's page.
  // false = the link is real (came back from a live search hit) but its
  //         title/snippet didn't match the exact product — most likely a
  //         similar model / same-category alternative, not this exact item.
  //         The UI must label these as "similar product", never show a
  //         price next to them as if it were confirmed for the exact item.
  // undefined = legacy path (buildRetailerSearchLinks last-resort fallback)
  //         where no live hit exists at all — kept for backward compat only.
  matched?: boolean;
}

// Friendly display names for each retailer domain.
const RETAILER_DISPLAY_NAMES: Record<string, string> = {
  "jumia.com.eg": "Jumia",
  "amazon.eg": "Amazon",
  "amazon.sa": "Amazon",
  "amazon.ae": "Amazon",
  "amazon.com": "Amazon",
  "amazon.de": "Amazon",
  "amazon.fr": "Amazon",
  "amazon.it": "Amazon",
  "noon.com": "Noon",
  "btech.com": "B.TECH",
  "2b.com.eg": "2B",
  "rayashop.com": "RayaShop",
  "carrefouregypt.com": "Carrefour Egypt",
  "compumarts.com": "Compumarts",
  "dreameg.net": "Dream",
  "jarir.com": "Jarir",
  "extra.com": "Extra",
  "carrefour.ae": "Carrefour",
  "xcite.com": "Xcite",
  "bhphotovideo.com": "B&H",
  "newegg.com": "Newegg",
  "bestbuy.com": "Best Buy",
  "dubizzle.com.eg": "Dubizzle",
  "dubizzle.com": "Dubizzle",
  "eg.opensooq.com": "OpenSooq",
  "opensooq.com": "OpenSooq",
  "haraj.com.sa": "Haraj",
  "ebay.com": "eBay",
  "ebay.de": "eBay",
  "swappa.com": "Swappa",
};

// Each store's own in-site search URL pattern, so the link takes the person
// straight to a search for the product NAME inside that store — never a
// specific listing or price, since prices change constantly and we can't
// guarantee a specific URL still matches. Any domain without a known
// pattern here falls back to a Google site-search (still just a search,
// never a price lookup).
const RETAILER_SEARCH_URL_BUILDERS: Record<string, (q: string) => string> = {
  "jumia.com.eg": (q) => `https://www.jumia.com.eg/catalog/?q=${encodeURIComponent(q)}`,
  "amazon.eg": (q) => `https://www.amazon.eg/s?k=${encodeURIComponent(q)}`,
  "amazon.sa": (q) => `https://www.amazon.sa/s?k=${encodeURIComponent(q)}`,
  "amazon.ae": (q) => `https://www.amazon.ae/s?k=${encodeURIComponent(q)}`,
  "amazon.com": (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  "amazon.de": (q) => `https://www.amazon.de/s?k=${encodeURIComponent(q)}`,
  "amazon.fr": (q) => `https://www.amazon.fr/s?k=${encodeURIComponent(q)}`,
  "amazon.it": (q) => `https://www.amazon.it/s?k=${encodeURIComponent(q)}`,
  "noon.com": (q) => `https://www.noon.com/egypt-en/search/?q=${encodeURIComponent(q)}`,
  "btech.com": (q) => `https://btech.com/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  "2b.com.eg": (q) => `https://2b.com.eg/en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  "rayashop.com": (q) => `https://rayashop.com/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  "carrefouregypt.com": (q) => `https://www.carrefouregypt.com/mafeg/en/search?keyword=${encodeURIComponent(q)}`,
  "compumarts.com": (q) => `https://compumarts.com/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  "dreameg.net": (q) => `https://www.dreameg.net/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  "jarir.com": (q) => `https://www.jarir.com/sa-en/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  "extra.com": (q) => `https://www.extra.com/en-sa/search/?q=${encodeURIComponent(q)}`,
  "carrefour.ae": (q) => `https://www.carrefouruae.com/mafuae/en/search?keyword=${encodeURIComponent(q)}`,
  "xcite.com": (q) => `https://www.xcite.com/catalogsearch/result/?q=${encodeURIComponent(q)}`,
  "bestbuy.com": (q) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(q)}`,
  "bhphotovideo.com": (q) => `https://www.bhphotovideo.com/c/search?Ntt=${encodeURIComponent(q)}`,
  "newegg.com": (q) => `https://www.newegg.com/p/pl?d=${encodeURIComponent(q)}`,
  "dubizzle.com.eg": (q) => `https://www.dubizzle.com.eg/en/search/?q=${encodeURIComponent(q)}`,
  "dubizzle.com": (q) => `https://dubai.dubizzle.com/search/?q=${encodeURIComponent(q)}`,
  "eg.opensooq.com": (q) => `https://eg.opensooq.com/en/search?query=${encodeURIComponent(q)}`,
  "opensooq.com": (q) => `https://opensooq.com/en/search?query=${encodeURIComponent(q)}`,
  "ebay.com": (q) => `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  "ebay.de": (q) => `https://www.ebay.de/sch/i.html?_nkw=${encodeURIComponent(q)}`,
  "swappa.com": (q) => `https://swappa.com/search?q=${encodeURIComponent(q)}`,
};

function buildStoreSearchUrl(domain: string, query: string): string {
  const builder = RETAILER_SEARCH_URL_BUILDERS[domain];
  if (builder) return builder(query);
  return `https://www.google.com/search?q=${encodeURIComponent(`site:${domain} ${query}`)}`;
}

/**
 * Builds "search it yourself" links (Jumia/Amazon/Noon, optionally B.TECH,
 * or the used-marketplace set for likeNew/used condition) for a given
 * product name. This is pure URL construction — no Serper call, no price
 * extraction of any kind. Serper's role is limited to fetching search
 * result snippets that the AI model reads to work out the fair price range
 * itself; it plays no part in building these store links or in deciding
 * what price (if any) shows up next to a retailer.
 */
export function buildRetailerSearchLinks(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used" = "new"
): RetailerLink[] {
  const domains =
    condition === "new"
      ? (COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD).marketplace
      : (USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD);

  return domains.map((domain) => ({
    retailer: RETAILER_DISPLAY_NAMES[domain] || domain,
    url: buildStoreSearchUrl(domain, product),
    // This is a constructed in-site SEARCH page, not a link to any specific
    // product — only ever used when Serper returned literally nothing for
    // this product (see fetchMainProductRetailerLinks). matched: false so
    // the UI never presents it as a confirmed product page.
    matched: false,
  }));
}

function urlDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * Picks a direct link to the actual first listing Serper found for each
 * target retailer domain, using Serper results already fetched for a
 * marketplace-scoped query (no extra API call).
 *
 * A domain only makes it into the returned list if Serper actually returned
 * a real hit for it — we never fabricate a store-search/listing URL and
 * present it as if it were the product's own page (that used to happen via
 * buildStoreSearchUrl here; it's been removed). A store we found nothing
 * for is simply omitted rather than shown with a fake "search page" link
 * that isn't guaranteed to open, let alone show the right item.
 *
 * Each surviving hit is also checked against the product's significant
 * tokens (same whole-word matcher pickBroadRetailerLinks uses) and tagged
 * `matched: true/false` so the UI can tell a confirmed exact-product page
 * apart from a same-domain hit that's actually a similar/alternate model.
 */
export function pickDirectRetailerLinks(
  serperResults: SerperResult[],
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used" = "new"
): RetailerLink[] {
  const domains =
    condition === "new"
      ? (COUNTRY_RETAILERS[currency] || COUNTRY_RETAILERS.USD).marketplace
      : (USED_MARKETPLACES[currency] || USED_MARKETPLACES.USD);

  const tokens = getSignificantTokens(product);

  const links: RetailerLink[] = [];
  for (const domain of domains) {
    const hit = serperResults.find((r) => urlDomain(r.url).endsWith(domain));
    if (!hit) continue; // no real hit for this store — omit it, never fabricate a link
    links.push({
      retailer: RETAILER_DISPLAY_NAMES[domain] || domain,
      url: hit.url,
      matched: matchesProduct(`${hit.title} ${hit.content}`, tokens),
    });
  }
  return links;
}
