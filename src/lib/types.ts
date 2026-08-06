export type Language = "ar" | "en";
export type Screen = "input" | "history" | "profile" | "login" | "guide" | "advisor" | "watchlist" | "verify-listing";

export interface Currency {
  code: string;
  enName: string;
  arName: string;
  enShort: string;
  arShort: string;
}

export const currencies: Currency[] = [
  { code: "EGP", enName: "Egyptian Pound", arName: "جنيه مصري", enShort: "EGP", arShort: "جنيه" },
  { code: "USD", enName: "US Dollar", arName: "دولار أمريكي", enShort: "USD", arShort: "دولار" },
  { code: "SAR", enName: "Saudi Riyal", arName: "ريال سعودي", enShort: "SAR", arShort: "ريال" },
  { code: "AED", enName: "UAE Dirham", arName: "درهم إماراتي", enShort: "AED", arShort: "درهم" },
  { code: "EUR", enName: "Euro", arName: "يورو", enShort: "EUR", arShort: "يورو" },
  { code: "KWD", enName: "Kuwaiti Dinar", arName: "دينار كويتي", enShort: "KWD", arShort: "دينار" },
];

export const SUPPORT_WHATSAPP = "201143494418";

export interface BilingualText {
  ar: string;
  en: string;
}

export interface BilingualArray {
  ar: string[];
  en: string[];
}

export interface Alternative {
  name: string;
  reason: BilingualText;
  whySuitable: BilingualText;
  // "Search this yourself" links (Jumia/Amazon/Noon/etc.) — pure store
  // search URLs for the alternative's name, no price attached. Replaces the
  // old estimatedPrice/medianPrice fields; alternatives no longer show any
  // computed or guessed price.
  searchLinks?: { retailer: string; url: string }[];
}

// Legacy shape kept only so old rows already saved in the `analyses` table
// (from before the plain-search pivot) still type-check when HistoryScreen
// sums up their stored moneySaved for the "total savings" stat. Nothing in
// the app creates new records with this shape anymore — no offered price,
// no verdict, no negotiation script. See CHANGES.md for the pivot notes.
export interface AnalysisResult {
  id: string;
  product: string;
  currency: string;
  condition?: string;
  // Nullable: the backend now allows the AI to return null for these when it
  // genuinely has no reliable pricing data, instead of inventing a number.
  marketFairPriceMin: number | null;
  marketFairPriceMax: number | null;
  marketFairPriceMid: number | null;
  // A single Gemini/Google-AI-Overview-style analytical paragraph describing
  // the current market price range in natural language (new vs used, min/max).
  marketPriceSummary: BilingualText;
  moneySaved: number | null;
  betterAlternatives: Alternative[];
  communityInsights?: {
    analyzedCount: number;
    recentPrices: number[];
  } | null;
  // Resale Value Prediction (2-year outlook only)
  resaleValueRightNow?: number | null;
  resaleValue2Years?: number | null;
  resaleInsight?: BilingualText;
  // "Search the best price yourself" links (Jumia/Amazon/Noon/optionally
  // B.TECH) — built server-side as pure store search URLs for the product
  // name (see buildRetailerSearchLinks in api/_groq_tavily.ts). No price is
  // fetched or shown here; each link just opens that store's own search
  // results page for the product.
  retailerPrices?: { retailer: string; url: string }[];
  createdAt: number;
}

// Feature flag mirroring api/_groq_tavily.ts's SHOW_BTECH_COMPARISON — flip
// this once a B.TECH affiliate/commission deal is confirmed. Kept as a
// simple constant since the frontend can't read server env vars directly.
export const SHOW_BTECH_COMPARISON = false;

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  age: string;
  country: string;
  phone: string;
  interests: string[];
  referralCode: string;
  inviteCount: number;
}