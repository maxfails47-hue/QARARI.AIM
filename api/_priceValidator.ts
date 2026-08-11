// ============================================================================
// EGP price validator — a stricter, currency-committed second opinion.
//
// The general-purpose extractor in _priceExtraction.ts is deliberately
// multi-currency and permissive (it has to work across EGP/SAR/AED/USD/etc).
// That flexibility is exactly what lets a few bad EGP matches slip through
// on Egyptian listings:
//   - a price block that also has a SAR/AED/USD price nearby (comparison
//     tables, "ships from Amazon.sa" banners, multi-country price widgets)
//   - an installment number ("1,999 EGP/month" or "قسط شهري") mistaken for
//     the actual unit price
//   - a spec number (256/512/1024 GB storage) mistaken for a price because
//     it happens to sit near currency-looking text
//
// This module is a narrow, EGP-only gate: given a raw text blob, it either
// returns a single high-confidence EGP price or UNAVAILABLE. It does not
// replace extractPrices() — it's meant to be used as an extra confirmation
// pass specifically for EGP so Serper-sourced snippets don't get a
// confidently-wrong number.
// ============================================================================

export interface PriceExtractionResult {
  price: number | null;
  currency: string | null;
  priceStatus: "VERIFIED" | "UNAVAILABLE";
}

const FOREIGN_CURRENCY_KEYWORDS = [
  "sar", "ريال", "aed", "درهم", "usd", "$", "eur", "€",
  "kwd", "qar", "bhd", "omr", "jod", "try",
];

const EGP_INDICATORS = ["egp", "le", "ل.ج", "جنيه", "جنيه مصري", "ج.م"];

const INSTALLMENT_KEYWORDS = ["/month", "شهر", "قسط"];

// Spec numbers that commonly get mistaken for a price when they sit near
// currency text (storage sizes above the 1000-threshold used below).
const NON_PRICE_SPEC_NUMBERS = new Set([256, 512, 1024]);

export function extractAndValidateEGPPrice(
  rawText: string,
  productTitle: string = "",
  requestedVariant: string = ""
): PriceExtractionResult {
  if (!rawText) {
    return { price: null, currency: null, priceStatus: "UNAVAILABLE" };
  }

  const text = rawText.toLowerCase();

  // 1. Any foreign-currency signal anywhere in the text makes the whole
  // blob unreliable for a committed EGP read — better to say UNAVAILABLE
  // than risk mixing up a EGP figure with an adjacent SAR/AED/USD one.
  for (const fc of FOREIGN_CURRENCY_KEYWORDS) {
    if (text.includes(fc)) {
      return { price: null, currency: null, priceStatus: "UNAVAILABLE" };
    }
  }

  // 2. Must actually contain a genuine EGP indicator.
  const hasValidEGPIndicator = EGP_INDICATORS.some((ind) => text.includes(ind));
  if (!hasValidEGPIndicator) {
    return { price: null, currency: null, priceStatus: "UNAVAILABLE" };
  }

  // 3. Installment/monthly-payment figures are not the unit price.
  if (INSTALLMENT_KEYWORDS.some((kw) => text.includes(kw))) {
    return { price: null, currency: null, priceStatus: "UNAVAILABLE" };
  }

  // 4. Extract the first plausible price figure — comma-grouped
  // (52,999) or a bare 4-6 digit number (52999) — skipping numbers that
  // read as years or common storage sizes rather than money.
  const priceRegex = /\b(\d{1,3}(?:,\d{3})+|\d{4,6})\b/g;
  let match: RegExpExecArray | null;
  let extractedPrice: number | null = null;

  while ((match = priceRegex.exec(rawText)) !== null) {
    const cleanNum = parseInt(match[1].replace(/,/g, ""), 10);
    if (cleanNum > 1000 && !NON_PRICE_SPEC_NUMBERS.has(cleanNum)) {
      extractedPrice = cleanNum;
      break; // first qualifying number wins
    }
  }

  if (extractedPrice === null) {
    return { price: null, currency: null, priceStatus: "UNAVAILABLE" };
  }

  return { price: extractedPrice, currency: "EGP", priceStatus: "VERIFIED" };
}
