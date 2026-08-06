// ============================================================================
// Phase 3 foundation — real price history + a real BUY NOW / WAIT verdict.
//
// Two jobs live here, deliberately kept separate:
//   1. The NUMBERS (recordPriceSnapshots, getPriceStats, buildVerdict) are
//      plain arithmetic over rows actually read from `price_history`. No AI
//      involved, so they can never be wrong in the "hallucinated" sense.
//   2. The WORDING (generateVerdictReasoning) hands those already-computed
//      real numbers to Gemini and asks it ONLY to phrase them naturally in
//      Egyptian Arabic — the prompt explicitly forbids inventing any number
//      that isn't in the input. If that call fails for any reason, we fall
//      back to a plain template built from the same real numbers rather
//      than blocking the response.
//
// Minimum data bar: we only surface lowestEver/average90d/highestEver and a
// verdict once history spans MIN_HISTORY_DAYS distinct days. Below that,
// callers should keep showing the existing "still gathering data" note —
// see api/search.ts.
// ============================================================================

import { callGeminiStructured } from "./_gemini.js";
import type { ResolvedStorePrice } from "./_priceResolver.js";

export const MIN_HISTORY_DAYS = 3;
const HISTORY_WINDOW_DAYS = 90;

export interface PriceStats {
  lowestEver: number;
  average90d: number;
  highestEver: number;
  dataPoints: number;
  distinctDays: number;
  hasEnoughData: boolean;
}

export interface Verdict {
  verdict: "BUY_NOW" | "WAIT";
  score: number; // 0-100, how good the current cheapest price is vs history
  reasons: string[];
}

/**
 * Best-effort snapshot of the prices /api/search just read live. Never
 * throws — a logging failure here shouldn't fail the user's search.
 */
export async function recordPriceSnapshots(
  admin: any,
  productKey: string,
  currency: string,
  resolved: ResolvedStorePrice[]
): Promise<void> {
  const rows = resolved
    .filter((r) => typeof r.price === "number" && r.price > 0)
    .map((r) => ({
      product_key: productKey,
      retailer: r.retailer,
      url: r.url,
      price: r.price,
      currency,
      in_stock: r.inStock,
      checked_at: r.lastChecked,
    }));

  if (!rows.length) return;

  try {
    const { error } = await admin.from("price_history").insert(rows);
    if (error) console.error("[priceHistory] insert failed:", error.message);
  } catch (e: any) {
    console.error("[priceHistory] insert threw:", e?.message);
  }
}

/**
 * Real lowest/average/highest over the last 90 days for this product+currency,
 * computed straight from stored rows — no estimation.
 */
export async function getPriceStats(
  admin: any,
  productKey: string,
  currency: string
): Promise<PriceStats | null> {
  try {
    const since = new Date(Date.now() - HISTORY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await admin
      .from("price_history")
      .select("price, checked_at")
      .eq("product_key", productKey)
      .eq("currency", currency)
      .gte("checked_at", since);

    if (error || !data?.length) return null;

    const prices: number[] = data.map((r: any) => Number(r.price)).filter((p: number) => p > 0);
    if (!prices.length) return null;

    const distinctDays = new Set(data.map((r: any) => r.checked_at.slice(0, 10))).size;

    return {
      lowestEver: Math.min(...prices),
      average90d: prices.reduce((a, b) => a + b, 0) / prices.length,
      highestEver: Math.max(...prices),
      dataPoints: prices.length,
      distinctDays,
      hasEnoughData: distinctDays >= MIN_HISTORY_DAYS,
    };
  } catch (e: any) {
    console.error("[priceHistory] getPriceStats threw:", e?.message);
    return null;
  }
}

/**
 * Deterministic decision from real numbers only: how the current cheapest
 * price compares to its own real 90-day average and real historical low.
 * No AI, no fabrication — same input always gives the same output.
 */
export function buildVerdict(currentPrice: number, stats: PriceStats): Verdict {
  const vsAverage = (currentPrice - stats.average90d) / stats.average90d; // negative = cheaper than usual
  const vsLowest = stats.lowestEver > 0 ? (currentPrice - stats.lowestEver) / stats.lowestEver : 0;

  // Score: 100 = at/below the real historical low, 0 = at/above the real
  // historical high. Clamped, purely arithmetic.
  const range = stats.highestEver - stats.lowestEver;
  const score =
    range > 0 ? Math.round(Math.max(0, Math.min(100, 100 * (1 - (currentPrice - stats.lowestEver) / range)))) : 50;

  const verdict: Verdict["verdict"] = vsAverage <= -0.03 || vsLowest <= 0.02 ? "BUY_NOW" : "WAIT";

  const reasons: string[] = [];
  if (vsLowest <= 0.02) {
    reasons.push(
      currentPrice <= stats.lowestEver
        ? "دلوقتي عند أقل سعر مسجّل ليه خالص"
        : "دلوقتي قريب جدًا من أقل سعر مسجّل ليه"
    );
  }
  reasons.push(
    vsAverage <= 0
      ? `أرخص من متوسط سعره في آخر ${HISTORY_WINDOW_DAYS} يوم بـ ${Math.abs(Math.round(vsAverage * 100))}%`
      : `أغلى من متوسط سعره في آخر ${HISTORY_WINDOW_DAYS} يوم بـ ${Math.round(vsAverage * 100)}%`
  );

  return { verdict, score, reasons };
}

const REASONING_SCHEMA = {
  type: "object",
  properties: {
    reasons_ar: { type: "array", items: { type: "string" }, maxItems: 3 },
  },
  required: ["reasons_ar"],
};

/**
 * Re-phrases the already-computed real numbers into natural Egyptian
 * Arabic bullets. The prompt hands Gemini the exact numbers and forbids
 * introducing any figure not given. On any failure, falls back to the
 * plain deterministic reasons from buildVerdict — never blocks the response.
 */
export async function generateVerdictReasoning(
  productName: string,
  currency: string,
  currentPrice: number,
  stats: PriceStats,
  verdict: Verdict
): Promise<string[]> {
  try {
    const system =
      "You write 2-3 short Egyptian Arabic bullet points explaining a BUY_NOW/WAIT verdict for a shopping app. " +
      "You are given the exact real numbers already computed — you must not invent, round differently, or add " +
      "any number that isn't given to you. Just phrase the given facts naturally and briefly. " +
      "Respond with ONLY JSON matching the schema.";
    const user = JSON.stringify({
      product: productName,
      currency,
      currentPrice,
      lowestEver: stats.lowestEver,
      average90d: Math.round(stats.average90d),
      highestEver: stats.highestEver,
      distinctDaysOfHistory: stats.distinctDays,
      verdict: verdict.verdict,
      score: verdict.score,
    });
    const raw = await callGeminiStructured(system, user, REASONING_SCHEMA, 300);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.reasons_ar) && parsed.reasons_ar.length) {
      return parsed.reasons_ar.slice(0, 3);
    }
    return verdict.reasons;
  } catch (e: any) {
    console.error("[priceHistory] generateVerdictReasoning failed, using template reasons:", e?.message);
    return verdict.reasons;
  }
}
