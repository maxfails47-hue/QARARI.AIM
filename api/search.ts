// ============================================================================
// POST /api/search — Shary's new core endpoint (Phase 2).
//
// Replaces the old "judge the price I typed" flow. Takes ONLY a product
// name, finds real retailer links (existing discovery — unchanged), opens
// each one for real and reads the live price/stock (_priceResolver.ts —
// new), then returns them sorted cheapest-first.
//
// NOT included yet (see the Shary master spec, phases 3-4 — need
// price_history table + tracked-product cron before these can be real
// instead of fabricated):
//   - "Lowest Ever / Average (90d) / Highest Ever"
//   - The full BUY NOW / WAIT score (that needs the historical signal —
//     today this only has the instant cross-store comparison signal)
//   - "Why this decision?" template bullets that reference history
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

    const stores = resolved
      .map((r) => ({ ...r, isCheapest: cheapest ? r.url === cheapest.url : false }))
      // cheapest-first, then everything else (including unresolved, shown last)
      .sort((a, b) => {
        if (a.price === null && b.price === null) return 0;
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return a.price - b.price;
      });

    logRequestSuccess(startedAt);
    res.status(200).json({
      product: searchProduct,
      currency,
      region: getRegionForCurrency(currency),
      stores,
      cheapest,
      storesChecked: resolved.length,
      storesResolved: withPrice.length,
      // Phase 3/4 will add: priceHistory { lowestEver, average90d, highestEver },
      // decision { verdict: "BUY_NOW" | "WAIT", score, reasons[] }
      note:
        language === "ar"
          ? "مقارنة لحظية بين المتاجر بس دلوقتي — تاريخ الأسعار (أقل سعر في آخر كذا شهر) لسه هيتضاف."
          : "Instant cross-store comparison only for now — price history (lowest in N months) is coming next.",
    });
  } catch (err) {
    logUnhandledError(err, startedAt);
    res.status(500).json({
      error: "Search failed",
    });
  }
}
