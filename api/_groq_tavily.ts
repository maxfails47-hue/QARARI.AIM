import { logStep, logEnvPresence, loggedFetch, loggedJsonParse } from "./_logger.js";
import { computeMarketPriceRange, isSupportedCurrency, type SupportedCurrency } from "./_priceExtraction.js";

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

// Feature flag: only show a B.TECH card in the retailer price comparison
// once we've confirmed an affiliate/commission deal with them. Toggle via
// env var — no code change needed to flip it on later.
export const SHOW_BTECH_COMPARISON = process.env.SHOW_BTECH_COMPARISON === "true";

interface CountryRetailerMap {
  official: string;
  marketplace: string[];
}

const COUNTRY_RETAILERS: Record<string, CountryRetailerMap> = {
  EGP: {
    official: "site:apple.com OR site:samsung.com OR site:store.sony.com",
    marketplace: ["amazon.eg", "jumia.com.eg", "btech.com", "noon.com"]
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

interface SearchState {
  allResults: SerperResult[];
  searchCount: number;
  lastMedian: number | null;
  lastConfidence: number;
  validPriceCount: number;
}

async function smartAdaptiveSearch(product: string, currency: string, region: { gl: string; hl: string }, condition: "new" | "likeNew" | "used"): Promise<{ results: SerperResult[]; searchCount: number; retailerSearchResults: SerperResult[] }> {
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

    let priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
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
  let priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
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
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
  if (priceAnalysis?.validCount >= 5) {
    const medianChange = state.lastMedian ? Math.abs(priceAnalysis.mid - state.lastMedian) / state.lastMedian : 1;
    if (medianChange < 0.01) {
      console.log("[SmartSearch] Early stop: 5+ prices with <1% median change");
      return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
    }
    state.lastMedian = priceAnalysis.mid;
  }

  // Check early stop condition 3: Last two searches added no new valid prices
  const pricesBefore = state.validPriceCount;
  priceAnalysis = await computeMarketPriceRange(state.allResults, currency as any, `PRODUCT: ${product}`, condition);
  state.validPriceCount = priceAnalysis?.validCount || 0;
  
  if (state.validPriceCount === pricesBefore && state.searchCount >= 2) {
    console.log("[SmartSearch] Early stop: No new valid prices in last searches");
    return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
  }

  // If confidence still below 90%, execute ONE additional search (Google Shopping)
  if (state.searchCount < maxSearches && (!priceAnalysis || priceAnalysis.confidence !== "High")) {
    console.log("[SmartSearch] Search 3: Google Shopping results");
    let query3 = `${product} price ${currency}`;
    let results3 = await searchSerper(query3, region);
    state.allResults.push(...results3);
    state.searchCount++;
    console.log(`[SmartSearch] Search 3 returned ${results3.length} results`);
  }

  return { results: state.allResults, searchCount: state.searchCount, retailerSearchResults };
}

async function callGroqModel(model: string, system: string, user: string) {
  const apiKey = process.env.GROQ_API_KEY;
  const res = await loggedFetch("groq.chat", "https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      temperature: 0.1,
      response_format: { type: "json_object" },
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
// extra), we deliberately cap this to the 3 stores that actually matter for
// the price range — dropping btech.com (hidden from the UI behind
// SHOW_BTECH_COMPARISON anyway, so there's no reason to pay for Compound to
// search it) and capping at 3 domains total so the tool has a narrower,
// cheaper search surface instead of fanning out across every marketplace.
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
  // domains (excluding btech, see comment above) so Groq's web search
  // doesn't drift into unrelated blogs/forums AND doesn't burn tokens
  // checking stores we don't even show a link for.
  if (condition === "new" && domains.length > 0) {
    settings.include_domains = domains.filter((d) => d !== "btech.com").slice(0, COMPOUND_MAX_PRICE_DOMAINS);
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
  try {
    const json = await callGroqModel(PRIMARY_MODEL, systemPrompt, prompt);
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
    const json = await callGroqModel(FALLBACK_MODEL, systemPrompt, prompt);
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
      const min = typeof parsed?.min === "number" ? parsed.min : null;
      const max = typeof parsed?.max === "number" ? parsed.max : null;
      const modelMid = typeof parsed?.mid === "number" ? parsed.mid : null;
      // Trust the model's own midpoint when it provides one; otherwise
      // fall back to computing it locally from min/max (keeps behavior
      // identical if the model happens to skip the mid field).
      const mid = modelMid !== null ? modelMid : (min !== null && max !== null ? Math.round((min + max) / 2) : null);
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
      if (attempt === 2) return { min: null, max: null, mid: null, summary: null };
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
export function buildSmartSerperPricingPrompt(productName: string, currency: string, serperResultsJson: string): string {
  return `
أنت خبير تسعير ذكي جداً ومحلل سوق محترف في السوق المصري. 
أمامك نتائج بحث حية من محرك Google (عبر Serper) لمنتج: "${productName}" بالعملة (${currency}).

نتائج البحث كالتالي:
${serperResultsJson}

التعليمات الصارمة لاستخراج السعر العادل (Fair Price Range):
1. **تصفية دقيقة:** تجاهل تماماً الإعلانات الوهمية، قطع الغيار، الإكسسوارات الرخيصة، أو الأسعار غير المنطقية (مثل 1 جنيه أو أسعار قديمة لا تعبر عن الواقع). التركيز فقط على السعر الفعلي للجهاز الجديد أو المتاح حالياً في المتاجر المذكورة (مثل أمازون، جوميا، نون، إلخ).
2. **استخراج النطاق:** حدد بدقة ثلاثة أرقام:
   - marketFairPriceMin: أقل سعر منطقي وموثوق في السوق حالياً.
   - marketFairPriceMax: أعلى سعر عادل لنفس النسخة بدون مبالغة التجار.
   - marketFairPriceMid: السعر المتوسط أو المتوقع بدقة شديدة.
3. **الإخراج البرمجي الصارم:** أجب حصرياً بصيغة JSON نظيفة جداً ودون أي كلام إضافي بالشكل التالي:
{
  "marketFairPriceMin": 00000,
  "marketFairPriceMax": 00000,
  "marketFairPriceMid": 00000,
  "confidenceScore": 0.95
}
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
  specs: string
): Promise<FairPriceRange> {
  try {
    const region = getRegionForCurrency(currency);
    const searchTerm = buildSearchTerm(product, specs);
    const { results } = await smartAdaptiveSearch(searchTerm, currency, region, condition);

    if (results.length === 0) {
      console.warn(`[getFairPriceRangeViaSerperFallback] No Serper results for "${product}" — returning null range.`);
      return { min: null, max: null, mid: null, summary: null };
    }

    const serperResultsJson = JSON.stringify(
      results.slice(0, 15).map((r) => ({ title: r.title, url: r.url, snippet: r.content }))
    );
    const prompt = buildSmartSerperPricingPrompt(product, currency, serperResultsJson);
    const systemPrompt = "You are a professional Egyptian-market pricing analyst. Respond with ONLY a single valid JSON object, no prose, no markdown fences.";

    let json;
    try {
      json = await callGroqModel(PRIMARY_MODEL, systemPrompt, prompt);
    } catch (e) {
      console.warn(`[getFairPriceRangeViaSerperFallback] Primary model failed for "${product}", trying fallback model:`, e);
      json = await callGroqModel(FALLBACK_MODEL, systemPrompt, prompt);
    }

    const parsed = loggedJsonParse(`serperFallback.price[${product}]`, extractJsonObject(json.choices[0].message.content));
    const min = typeof parsed?.marketFairPriceMin === "number" ? parsed.marketFairPriceMin : null;
    const max = typeof parsed?.marketFairPriceMax === "number" ? parsed.marketFairPriceMax : null;
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
 * 1. Try Groq Compound first (getFairPriceRangeViaCompound) — its own
 *    built-in live web search.
 * 2. If Compound throws (including the Free Tier's internal search-tool
 *    response-size limit, which surfaces as a 413 regardless of our own
 *    request size) OR comes back with no usable range at all, fall
 *    through immediately to the Serper + gpt-oss-120b smart pipeline
 *    instead of surfacing a failure or a null price to the user.
 */
export async function getFairPriceRange(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used",
  specs: string
): Promise<FairPriceRange> {
  try {
    const compoundResult = await getFairPriceRangeViaCompound(product, currency, condition, specs);
    if (compoundResult.min !== null || compoundResult.max !== null) {
      return compoundResult;
    }
    console.warn(`[getFairPriceRange] Compound returned no usable range for "${product}" — falling back to Serper + GPT pipeline.`);
  } catch (e) {
    console.error(`[getFairPriceRange] Compound threw for "${product}" — falling back to Serper + GPT pipeline:`, e);
  }
  return getFairPriceRangeViaSerperFallback(product, currency, condition, specs);
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
  const siteQuery = domains.map((m) => `site:${m}`).join(" OR ");
  const query = `${product} price ${currency} ${qualifier} (${siteQuery})`;
  return searchSerper(query, region);
}

/**
 * One-call helper for the main product: runs the Serper link search and
 * picks direct listing URLs for the target retailers, falling back to that
 * store's own search page only when Serper genuinely found nothing.
 */
export async function fetchMainProductRetailerLinks(
  product: string,
  currency: string,
  condition: "new" | "likeNew" | "used"
): Promise<RetailerLink[]> {
  try {
    const region = getRegionForCurrency(currency);
    const results = await fetchRetailerListings(product, currency, region, condition);
    return pickDirectRetailerLinks(results, product, currency, condition);
  } catch (e) {
    console.error("[fetchMainProductRetailerLinks] Serper link fetch failed (non-fatal):", e);
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

  const visibleDomains = SHOW_BTECH_COMPARISON ? domains : domains.filter((d) => d !== "btech.com");

  return visibleDomains.map((domain) => ({
    retailer: RETAILER_DISPLAY_NAMES[domain] || domain,
    url: buildStoreSearchUrl(domain, product),
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
 * marketplace-scoped query (no extra API call). Falls back to that store's
 * own search-results page only for a domain Serper genuinely returned
 * nothing for, so a link is always shown but never a fabricated one.
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

  const visibleDomains = SHOW_BTECH_COMPARISON ? domains : domains.filter((d) => d !== "btech.com");

  return visibleDomains.map((domain) => {
    const hit = serperResults.find((r) => urlDomain(r.url).endsWith(domain));
    return {
      retailer: RETAILER_DISPLAY_NAMES[domain] || domain,
      url: hit ? hit.url : buildStoreSearchUrl(domain, product),
    };
  });
}
