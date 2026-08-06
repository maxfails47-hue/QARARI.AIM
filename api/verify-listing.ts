// ============================================================================
// POST /api/verify-listing — "is this ad's price legit?" (photo-in, live
// store comparison out).
//
// Deliberately NOT a price-history feature: the person saw a listing on an
// unofficial source (a Facebook post, a random ad) and just wants to know if
// the number is reasonable *right now* against real stores. So this reuses,
// unchanged:
//   1. extractListingFromImage() (_gemini.ts) — reads productName/price/
//      currency/discountPercent off the photo. Never guesses a field that
//      isn't visible in the image.
//   2. The exact same live-discovery + live-price engine api/search.ts uses
//      (fetchMainProductRetailerLinks + resolvePricesForLinks) — no new
//      search logic, just the same real stores read a moment ago.
//
// If the product can't be identified from the photo, or isn't found in any
// of the official stores Shary watches, this says so plainly rather than
// fabricating a comparison — see `verdict.status === "unverified"`.
// ============================================================================

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { extractListingFromImage } from "./_gemini.js";
import {
  fetchMainProductRetailerLinks,
  normalizeProductNameForSearch,
  getRegionForCurrency,
} from "./_groq_tavily.js";
import { resolvePricesForLinks } from "./_priceResolver.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";

function buildVerdict(
  priceAfterDiscount: number,
  withPrice: { price: number | null }[],
  language: string
): { status: "unverified" | "excellent" | "good" | "fair" | "high"; message: string } {
  const ar = language === "ar";
  if (withPrice.length === 0) {
    return {
      status: "unverified",
      message: ar
        ? "المنتج ده مش لاقينه في المتاجر الرسمية اللي بنراقبها، مقدرش أتأكد من السعر ده بمصدر تاني."
        : "Couldn't find this product in any of the official stores Shary checks, so this price can't be verified against another source.",
    };
  }

  const prices = withPrice.map((p) => p.price as number);
  const min = Math.min(...prices);
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  if (priceAfterDiscount <= min) {
    return {
      status: "excellent",
      message: ar
        ? `السعر ده أرخص من أقل سعر لقيناه في المتاجر الرسمية (${Math.round(min).toLocaleString()}) — يبان منطقي جدًا.`
        : `This price is even lower than the cheapest price found across official stores (${Math.round(min).toLocaleString()}) — looks very reasonable.`,
    };
  }

  const diffFromMinPct = ((priceAfterDiscount - min) / min) * 100;
  if (diffFromMinPct <= 10) {
    return {
      status: "good",
      message: ar
        ? `السعر قريب من أرخص سعر رسمي (${Math.round(min).toLocaleString()}) — يبان منطقي.`
        : `This price is close to the cheapest official price (${Math.round(min).toLocaleString()}) — looks reasonable.`,
    };
  }

  if (priceAfterDiscount <= avg) {
    return {
      status: "fair",
      message: ar
        ? `السعر أعلى من أرخص متجر رسمي (${Math.round(min).toLocaleString()}) بس لسه أقل من متوسط السوق (${Math.round(avg).toLocaleString()}).`
        : `This price is above the cheapest official store (${Math.round(min).toLocaleString()}) but still under the market average (${Math.round(avg).toLocaleString()}).`,
    };
  }

  return {
    status: "high",
    message: ar
      ? `السعر ده أعلى من متوسط السوق الحقيقي (${Math.round(avg).toLocaleString()}) — ممكن تلاقي أرخص من متجر رسمي.`
      : `This price is above the real market average (${Math.round(avg).toLocaleString()}) — you can likely find it cheaper at an official store.`,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const startedAt = Date.now();
  logRequestStart(req);
  logEnvPresence({ GEMINI_API_KEY: process.env.GEMINI_API_KEY });

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const { imageBase64, currency = "EGP", language = "ar" } = (req.body || {}) as {
      imageBase64?: { data: string; mimeType: string };
      currency?: string;
      language?: string;
    };

    if (!imageBase64 || typeof imageBase64.data !== "string" || typeof imageBase64.mimeType !== "string") {
      res.status(400).json({ error: language === "ar" ? "ارفع صورة الإعلان" : "Upload the listing photo" });
      return;
    }

    logStep("extract listing from image");
    const listing = await extractListingFromImage(imageBase64);

    if (!listing.productName || !listing.price) {
      res.status(200).json({
        listing,
        stores: [],
        verdict: {
          status: "unverified",
          message:
            language === "ar"
              ? "معرفناش نقرا اسم المنتج والسعر بوضوح من الصورة — جرب صورة أوضح أو اكتب اسم المنتج يدوي."
              : "Couldn't clearly read the product name and price from this photo — try a clearer photo or enter the product name manually.",
        },
      });
      return;
    }

    const listingCurrency = listing.currency || currency;

    logStep("normalize product name");
    const searchProduct = await normalizeProductNameForSearch(listing.productName);

    logStep("discover retailer links");
    const links = await fetchMainProductRetailerLinks(searchProduct, listingCurrency, "new");

    logStep("resolve live prices");
    const resolved = await resolvePricesForLinks(links, listingCurrency);

    const withPrice = resolved.filter((r) => typeof r.price === "number");
    const sorted = [...withPrice].sort((a, b) => (a.price as number) - (b.price as number));
    const cheapest = sorted[0] || null;

    const stores = resolved
      .map((r) => ({ ...r, isCheapest: cheapest ? r.url === cheapest.url : false }))
      .sort((a, b) => {
        if (a.price === null && b.price === null) return 0;
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return a.price - b.price;
      });

    const priceAfterDiscount = listing.discountPercent
      ? Math.round(listing.price * (1 - listing.discountPercent / 100))
      : listing.price;

    const verdict = buildVerdict(priceAfterDiscount, withPrice, language);

    logRequestSuccess(startedAt);
    res.status(200).json({
      listing: { ...listing, currency: listingCurrency, priceAfterDiscount },
      product: searchProduct,
      currency: listingCurrency,
      region: getRegionForCurrency(listingCurrency),
      stores,
      cheapest,
      storesChecked: resolved.length,
      storesResolved: withPrice.length,
      verdict,
    });
  } catch (err) {
    logUnhandledError(err, startedAt);
    res.status(500).json({
      error: "Verification failed",
    });
  }
}
