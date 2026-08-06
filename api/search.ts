// ============================================================================
// POST /api/search — Shary's new core endpoint (Phase 2).
//
// Replaces the old "judge the price I typed" flow. Takes ONLY a product
// name, finds real retailer links (existing discovery — unchanged), opens
// each one for real and reads the live price/stock (_priceResolver.ts —
// new), then returns them sorted cheapest-first.
//
// Phase 3: "Lowest Ever / Average (90d) / Highest Ever" and a real
// BUY NOW / WAIT verdict now come from api/_priceHistory.ts, computed from
// real rows in the price_history table (populated by this endpoint on every
// search, plus the daily cron re-checking known products). Both the numbers
// and the verdict are plain arithmetic — never fabricated. They only appear
// once a product has price_history.MIN_HISTORY_DAYS of real data; before
// that this still returns the honest "gathering data" note it always did.
//
// What IS real today: every price/stock value below was read from the
// store's own live page moments ago — see `source` on each entry
// ("jsonld" | "meta" | "ai" | "unresolved"). Never fabricated.
//
// Quota/auth: intentionally NOT wired into the existing scans_used_this_month
// reservation system yet (that system is built around the old per-analysis
// model in analyze.ts). This endpoint is unmetered for now — flagging this
// explicitly so it isn't mistaken for a finished, production-safe piece.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  fetchMainProductRetailerLinks,
  normalizeProductNameForSearch,
  getRegionForCurrency,
} from "./_groq_tavily.js";
import { resolvePricesForLinks } from "./_priceResolver.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep } from "./_logger.js";
import { getSupabaseAdmin } from "./_supabaseAdmin.js";
import { recordPriceSnapshots, getPriceStats, buildVerdict, generateVerdictReasoning } from "./_priceHistory.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();
  logRequestStart(req);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { product, currency = "EGP", language = "ar" } = (req.body || {}) as {
      product?: string;
      currency?: string;
      language?: string;
    };

    if (!product || !product.trim()) {
      res.status(400).json({
        error:
          language === "ar" ? "اكتب اسم المنتج" : "Enter a product name",
      });
      return;
    }

    logStep("normalize product name");
    const searchProduct = await normalizeProductNameForSearch(product.trim());

    logStep("discover retailer links");
    const links = await fetchMainProductRetailerLinks(searchProduct, currency, "new");

    logStep("resolve live prices");
    const resolved = await resolvePricesForLinks(links, currency);

    const withPrice = resolved.filter((r) => typeof r.price === "number");
    const sorted = [...withPrice].sort((a, b) => (a.price as number) - (b.price as number));
    const cheapest = sorted[0] || null;

    // Product photo: whichever resolved store had a real og:image/JSON-LD
    // image, preferring the cheapest store's if it has one. Never generated —
    // null if no store page had a usable one.
    const productImage =
      (cheapest && resolved.find((r) => r.url === cheapest.url)?.imageUrl) ||
      resolved.find((r) => r.imageUrl)?.imageUrl ||
      null;

    // Instant analysis: purely the spread between today's cheapest and
    // priciest real price. Deterministic arithmetic, no AI, no history
    // needed — so it's always available from the very first search, unlike
    // the historical `decision` below which needs several days of data.
    const instantAnalysis = (() => {
      if (withPrice.length < 2) return null;
      const prices = withPrice.map((r) => r.price as number);
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      const spreadPct = min > 0 ? Math.round(((max - min) / min) * 100) : 0;
      const message =
        language === "ar"
          ? spreadPct >= 10
            ? `فيه فرق ${spreadPct}% بين أرخص وأغلى سعر بين المتاجر — يستاهل تاخد الأرخص`
            : `الفرق بين المتاجر بسيط (${spreadPct}%) — مفيش داعي تقلق بين الاختيارات`
          : spreadPct >= 10
            ? `There's a ${spreadPct}% gap between the cheapest and priciest store — worth taking the cheaper one`
            : `Prices are close across stores (${spreadPct}% gap) — no major difference between options`;
      return { spreadPct, message };
    })();

    const stores = resolved
      .map((r) => ({ ...r, isCheapest: cheapest ? r.url === cheapest.url : false }))
      // cheapest-first, then everything else (including unresolved, shown last)
      .sort((a, b) => {
        if (a.price === null && b.price === null) return 0;
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return a.price - b.price;
      });

    // Best-effort: snapshot what we just read live into price_history, and
    // pull real history for this product+currency. Never blocks or fails
    // the response — a history hiccup shouldn't break the live comparison
    // the user actually asked for.
    let priceHistory: { lowestEver: number; average90d: number; highestEver: number } | null = null;
    let decision: { verdict: "BUY_NOW" | "WAIT"; score: number; reasons: string[] } | null = null;
    let savingsVsAverage: number | null = null;
    try {
      const admin = getSupabaseAdmin();
      logStep("record price snapshot");
      await recordPriceSnapshots(admin, searchProduct, currency, resolved);

      logStep("read price history");
      const stats = await getPriceStats(admin, searchProduct, currency);
      if (stats?.hasEnoughData && cheapest) {
        priceHistory = {
          lowestEver: stats.lowestEver,
          average90d: Math.round(stats.average90d),
          highestEver: stats.highestEver,
        };
        const verdict = buildVerdict(cheapest.price as number, stats);
        const reasons = await generateVerdictReasoning(
          searchProduct,
          currency,
          cheapest.price as number,
          stats,
          verdict
        );
        decision = { verdict: verdict.verdict, score: verdict.score, reasons };
        // Only surface a "you save" figure when the current price is
        // genuinely below the real 90-day average — never show a fake/zero saving.
        const diff = Math.round(stats.average90d - (cheapest.price as number));
        savingsVsAverage = diff > 0 ? diff : null;
      }
    } catch (e: any) {
      console.error("[search] price history step failed (non-fatal):", e?.message);
    }

    logRequestSuccess(startedAt);
    res.status(200).json({
      product: searchProduct,
      currency,
      region: getRegionForCurrency(currency),
      stores,
      cheapest,
      storesChecked: resolved.length,
      storesResolved: withPrice.length,
      productImage,
      instantAnalysis,
      priceHistory,
      decision,
      savingsVsAverage,
      note: priceHistory
        ? null
        : language === "ar"
          ? "مقارنة لحظية بين المتاجر بس دلوقتي — تاريخ الأسعار (أقل سعر في آخر كذا شهر) لسه بيتجمّع لحد ما يبقى عندنا بيانات كافية."
          : "Instant cross-store comparison only for now — price history is still being gathered for this product.",
    });
  } catch (err) {
    logUnhandledError(err, startedAt);
    res.status(500).json({
      error: "Search failed",
    });
  }
}
