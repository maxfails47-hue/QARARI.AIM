export const SUPPORTED_CURRENCIES = ["USD", "EGP", "SAR", "AED", "KWD", "EUR", "GBP", "QAR", "BHD", "OMR", "JOD"] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export function isSupportedCurrency(code: string): code is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code.toUpperCase());
}

const CURRENCY_PATTERNS: { code: SupportedCurrency; regex: RegExp }[] = [
  { code: "EGP", regex: /(E£|EGP|\bL\.?E\.?\b|ج\.م|جنيه)/i },
  { code: "SAR", regex: /(SAR|\bS\.?R\.?\b|ر\.س|ريال)/i },
  { code: "AED", regex: /(AED|\bDHS\b|د\.إ|درهم)/i },
  { code: "KWD", regex: /(KWD|\bK\.?D\.?\b|د\.ك|دينار)/i },
  { code: "EUR", regex: /(€|EUR)/i },
  { code: "GBP", regex: /(£|GBP)/i },
  { code: "USD", regex: /(US\$|USD|\$)/i },
];

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

export function extractPrices(text: string, title: string, url: string, condition: string): PriceHit[] {
  const prices: PriceHit[] = [];
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
  condition: string = "new"
): number | null {
  const hits = extractPrices(text, title, url, condition).filter((h) => h.currency === targetCurrency);
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

export async function computeMarketPriceRange(results: any[], targetCurrency: SupportedCurrency, prompt: string, condition: string = "new") {
  let allPrices: PriceHit[] = [];
  for (const r of results) {
    allPrices = allPrices.concat(extractPrices(r.content, r.title, r.url, condition));
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

  // Calculate confidence based on sample size
  let confidence = "Low";
  if (filtered.length >= 5) confidence = "High";
  else if (filtered.length >= 2) confidence = "Medium";
  else return null;

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
