export const SUPPORTED_CURRENCIES = ["USD", "EGP", "SAR", "AED", "KWD", "EUR", "GBP", "QAR", "BHD", "OMR", "JOD"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

const CURRENCY_PATTERNS: { code: SupportedCurrency; regex: RegExp }[] = [
  // جنيه is the formal spelling, but Egyptian retail/blog listings very
  // commonly write جنية (تاء مربوطة) or جنيها (accusative, "٢٠٠٠٠ جنيها
  // مصريا") instead. Without matching those variants, a real EGP price like
  // "20000 جنية" was silently dropped (currency stayed null → excluded),
  // which was a major cause of empty market-price results for EG listings.
  { code: "EGP", regex: /(E£|EGP|\bL\.?E\.?\b|ج\.م|جني[هة](?:ا)?)/i },
  { code: "SAR", regex: /(SAR|\bS\.?R\.?\b|ر\.س|ريال)/i },
  { code: "AED", regex: /(AED|\bDHS\b|د\.إ|درهم)/i },
  { code: "KWD", regex: /(KWD|\bK\.?D\.?\b|د\.ك|دينار)/i },
  { code: "EUR", regex: /(€|EUR)/i },
  { code: "GBP", regex: /(£|GBP)/i },
  { code: "USD", regex: /(US\$|USD|\$)/i },
];

// ─── Product identity matching ───
// Serper snippets/titles for a product page are not guaranteed to contain
// ONLY that product's price. A single search hit can legitimately include
// text from "Similar products" / "You may also like" / category-page
// carousels — e.g. an Amazon listing page for "RTX 5070 Ti" whose snippet
// also surfaces a "RTX 5090" or "RTX 4070 Ti" price from an adjacent card.
// Without checking that the hit is actually about the requested product,
// those unrelated prices get silently folded into the same min/max/mid
// range — this is what produced a "fair price" range spanning an entry-
// level card's price up to a completely different, far more expensive
// model's price. Every significant token of the product name (model
// number, "Ti"/"Pro"/storage size, etc.) must appear, as a whole word, in
// the result's combined title+content before any price from it is kept.
const TOKEN_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "with", "for", "of", "in", "on",
  "new", "original", "international", "version", "edition",
]);

export function getSignificantTokens(productName: string): string[] {
  return Array.from(
    new Set(
      (productName || "")
        .toLowerCase()
        .split(/[^a-z0-9\u0600-\u06FF]+/i)
        .filter((t) => t.length >= 2 && !TOKEN_STOPWORDS.has(t))
    )
  );
}

export function matchesProduct(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true; // no product name given — don't filter
  const lower = haystack.toLowerCase();
  return tokens.every((t) => {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Whole-word match (word boundary on both sides) so "5070" doesn't match
    // "45070", and "ti" doesn't match "edition"/"multi" via plain substring.
    const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i");
    return re.test(lower);
  });
}

const NOISE_KEYWORDS = /accessory|cable|cover|case|screen protector|shipping|delivery|bundle|combo/i;
// These words indicate the listing is NOT a brand-new unit. They should only
// be rejected when the user is asking about a "new" purchase — for
// "likeNew" (كسر زيرو/open box) and "used" (مستعمل) searches these are
// exactly the listings we WANT, so they must not be filtered out.
const CONDITION_INDICATOR_KEYWORDS = /refurbished|open box|used|second\s?hand|مستعمل|كسر زيرو/i;
const TRUSTED_RETAILERS = ["amazon", "noon", "jumia", "jarir", "extra", "carrefour", "bhphotovideo", "bestbuy", "apple", "samsung", "dubizzle", "opensooq", "olx"];

interface PriceHit {
  value: number;
  currency: SupportedCurrency;
  url: string;
  title: string;
  weight: number;
}

// Arabic-Indic (٠-٩) and Persian (۰-۹) digit variants are common on Egyptian
// and Gulf retail pages and are NOT matched by \d (ASCII-only in JS regex).
// Without this normalization, any price written in Eastern Arabic numerals
// was silently invisible to extractPrices — this is a real, common case on
// Arabic-language product listings, not an edge case.
const ARABIC_INDIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
function normalizeDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (ch) => {
    const arabicIdx = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (arabicIdx !== -1) return String(arabicIdx);
    const persianIdx = PERSIAN_DIGITS.indexOf(ch);
    if (persianIdx !== -1) return String(persianIdx);
    return ch;
  });
}

function getTrustWeight(url: string): number {
  let domain: string;
  try {
    domain = new URL(url).hostname.toLowerCase();
  } catch {
    // Malformed URL — don't crash the whole extraction pass over one bad link.
    return 1;
  }
  for (const trusted of TRUSTED_RETAILERS) {
    // Substring match alone is spoofable (e.g. "fake-amazon-deals.com" or
    // "amazon.evil.com" would both incorrectly get full trust). Require the
    // trusted name to be the registrable domain label itself — either
    // exactly "amazon.com"/"amazon.eg", or a subdomain of it like
    // "www.amazon.com" — never just "contains the substring somewhere".
    if (domain === trusted || domain.endsWith("." + trusted) || domain.includes("." + trusted + ".") || domain.startsWith(trusted + ".")) return 2;
  }
  return 1;
}

export function extractPrices(text: string, title: string, url: string, condition: string, productName: string = "", altProductName: string = ""): PriceHit[] {
  const prices: PriceHit[] = [];

  // Product-identity gate: if this result's title+content doesn't actually
  // mention the product we're pricing (all significant tokens present as
  // whole words), skip it entirely — don't let a "similar products" /
  // different-model price leak into the range. See matchesProduct above.
  //
  // We check BOTH the search-normalized name (often translated to English,
  // e.g. "La Belle Hot Air Brush") AND the original name as given (which
  // may be Arabic, e.g. "لابيل برش - اسود") and accept the result if EITHER
  // fully matches. A listing on an Arabic-only independent brand site will
  // never contain the English-translated tokens, so requiring only the
  // normalized name was silently discarding every real match for products
  // not sold on major English-language marketplaces.
  const productTokens = getSignificantTokens(productName);
  const altTokens = getSignificantTokens(altProductName);
  const matchesPrimary = matchesProduct(`${title} ${text}`, productTokens);
  const matchesAlt = altTokens.length > 0 ? matchesProduct(`${title} ${text}`, altTokens) : false;
  if (!matchesPrimary && !matchesAlt) return prices;

  const normalizedText = normalizeDigits(text);
  const numRegex = /\d{1,3}(?:[,\s]\d{3})*(?:\.\d+)?/g;
  let match;

  while ((match = numRegex.exec(normalizedText)) !== null) {
    const val = parseFloat(match[0].replace(/[,\s]/g, ""));
    if (val < 10 || val > 20_000_000) continue;

    const window = normalizedText.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20);
    let currency: SupportedCurrency | null = null;
    for (const p of CURRENCY_PATTERNS) {
      if (p.regex.test(window)) {
        currency = p.code;
        break;
      }
    }

    const isNoise = NOISE_KEYWORDS.test(window) || NOISE_KEYWORDS.test(title);
    // Only reject "used/refurbished/open box" signals when the user actually
    // wants a NEW unit — otherwise those are the correct matches to keep.
    const isWrongCondition = condition === "new" && (CONDITION_INDICATOR_KEYWORDS.test(window) || CONDITION_INDICATOR_KEYWORDS.test(title));

    if (currency && !isNoise && !isWrongCondition) {
      const weight = getTrustWeight(url);
      prices.push({ value: val, currency, url, title, weight });
    }
  }
  return prices;
}

// Cheapest valid price for a single listing, in the target currency only —
// used by the per-retailer price comparison (Jumia/Amazon/Noon cards), where
// we show one price per store and don't want to silently convert currencies.
// Reuses the same currency-aware, noise-filtered extraction as the market
// price range above, instead of a naive "smallest number in the text" regex.
export function extractListingPrice(
  text: string,
  title: string,
  url: string,
  targetCurrency: SupportedCurrency,
  condition: string = "new",
  productName: string = ""
): number | null {
  const hits = extractPrices(text, title, url, condition, productName).filter((h) => h.currency === targetCurrency);
  if (hits.length === 0) return null;
  return Math.min(...hits.map((h) => h.value));
}

async function getExchangeRate(from: string, to: string): Promise<number> {
  if (from === to) return 1;
  try {
    const res = await fetch(`https://open.er-api.com/v6/latest/${from}`);
    const json = await res.json();
    return json.rates[to] || 1;
  } catch {
    return 1;
  }
}

function calculateWeightedMedian(values: number[], weights: number[]): number {
  const sorted = values.map((v, i) => ({ value: v, weight: weights[i] })).sort((a, b) => a.value - b.value);
  const totalWeight = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulativeWeight = 0;
  const halfWeight = totalWeight / 2;
  
  for (const item of sorted) {
    cumulativeWeight += item.weight;
    if (cumulativeWeight >= halfWeight) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

export async function computeMarketPriceRange(results: any[], targetCurrency: SupportedCurrency, prompt: string, condition: string = "new", altProductName: string = "") {
  // The caller passes `PRODUCT: <name>` as `prompt` — pull the bare name back
  // out so extractPrices can gate out results that aren't actually about it.
  const productMatch = prompt.match(/PRODUCT:\s*(.+)/i);
  const productName = productMatch ? productMatch[1].trim() : "";

  let allPrices: PriceHit[] = [];
  for (const r of results) {
    allPrices = allPrices.concat(extractPrices(r.content, r.title, r.url, condition, productName, altProductName));
  }

  if (allPrices.length === 0) return null;

  // Convert all to target currency
  const convertedPrices: number[] = [];
  const weights: number[] = [];
  
  for (const p of allPrices) {
    const rate = await getExchangeRate(p.currency, targetCurrency);
    convertedPrices.push(p.value * rate);
    weights.push(p.weight);
  }

  convertedPrices.sort((a, b) => a - b);
  const median = calculateWeightedMedian(convertedPrices, weights);
  
  // Filter outliers: 60% to 160% of median
  const filtered: number[] = [];
  const filteredWeights: number[] = [];
  
  for (let i = 0; i < convertedPrices.length; i++) {
    if (convertedPrices[i] >= median * 0.6 && convertedPrices[i] <= median * 1.6) {
      filtered.push(convertedPrices[i]);
      filteredWeights.push(weights[i]);
    }
  }
  
  if (filtered.length === 0) return null;

  const min = Math.round(filtered[0]);
  const max = Math.round(filtered[filtered.length - 1]);
  const mid = Math.round(calculateWeightedMedian(filtered, filteredWeights));

  // Calculate confidence based on sample size. A single valid price is
  // still real signal (e.g. a narrow variant/spec search naturally returns
  // fewer matching listings) — it should surface as Low confidence, not be
  // discarded outright. Only a fully empty filtered set means "no data".
  let confidence = "Low";
  if (filtered.length >= 5) confidence = "High";
  else if (filtered.length >= 2) confidence = "Medium";

  return { 
    min, 
    mid, 
    max, 
    targetCurrency, 
    confidence, 
    validCount: filtered.length,
    sampleSize: filtered.length 
  };
}

export function formatMarketPriceContext(range: any): string {
  if (!range) return "Market price data unavailable.";
  return `
MARKET PRICE DATA (Confidence: ${range.confidence}):
- Currency: ${range.targetCurrency}
- Fair Price Range: ${range.min} - ${range.max}
- Estimated Average: ${range.mid}
- Data Points: ${range.validCount}
  `.trim();
}
