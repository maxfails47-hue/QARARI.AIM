import { getSupabaseAdmin } from "./_supabaseAdmin.js";
import type { RetailerLink } from "./_groq_tavily.js";

/**
 * Pure post-processing step. Takes a RetailerLink[] that has ALREADY been
 * fully built (by pickDirectRetailerLinks / buildRetailerSearchLinks — the
 * exact same code path for both the main product's `retailerPrices` and
 * each alternative's `searchLinks`), and swaps the "Noon" entry's URL for
 * the cached affiliate link if we have one.
 *
 * Deliberately does NOT touch:
 *  - marketFairPriceMin/Max/Mid or any pricing/verdict logic
 *  - Serper, Groq, or any credential/API-key handling
 *  - any field other than `url` on entries where retailer === "Noon"
 *
 * Never blocks or throws the request: any Supabase failure just returns
 * the links unchanged (original noon.com URL still works fine, it's just
 * not the affiliate-tracked version yet).
 */
export async function wrapNoonLinks(links: RetailerLink[]): Promise<RetailerLink[]> {
  const noonLinks = links.filter((l) => l.retailer === "Noon" && l.url.includes("noon.com"));
  if (noonLinks.length === 0) return links;

  try {
    const admin = getSupabaseAdmin();
    const urls = noonLinks.map((l) => l.url);

    const { data: rows, error } = await admin
      .from("noon_affiliate_links")
      .select("product_url, affiliate_url, status")
      .in("product_url", urls);

    if (error) {
      console.error("[wrapNoonLinks] Supabase lookup failed (non-fatal):", error);
      return links;
    }

    const known = new Set((rows || []).map((r) => r.product_url));
    const doneMap = new Map(
      (rows || [])
        .filter((r) => r.status === "done" && r.affiliate_url)
        .map((r) => [r.product_url, r.affiliate_url as string])
    );

    // Queue any noon.com URL we've never seen before so the offline
    // Playwright automation script picks it up on its next run.
    // Best-effort — a failure here never blocks the response.
    const unseen = urls.filter((u) => !known.has(u));
    if (unseen.length > 0) {
      const { error: upsertErr } = await admin
        .from("noon_affiliate_links")
        .upsert(
          unseen.map((u) => ({ product_url: u, status: "pending" })),
          { onConflict: "product_url", ignoreDuplicates: true }
        );
      if (upsertErr) {
        console.error("[wrapNoonLinks] Queueing pending link failed (non-fatal):", upsertErr);
      }
    }

    return links.map((l) =>
      l.retailer === "Noon" && doneMap.has(l.url) ? { ...l, url: doneMap.get(l.url)! } : l
    );
  } catch (e) {
    console.error("[wrapNoonLinks] Unexpected error (non-fatal, returning original links):", e);
    return links;
  }
}

/**
 * Convenience wrapper for the alternatives array, which nests its
 * RetailerLink[] under `searchLinks` on each alternative. Same
 * non-blocking, isolated behavior as wrapNoonLinks above.
 */
export async function wrapNoonLinksInAlternatives<T extends { searchLinks: RetailerLink[] }>(
  alternatives: T[]
): Promise<T[]> {
  if (alternatives.length === 0) return alternatives;
  return Promise.all(
    alternatives.map(async (alt) => ({
      ...alt,
      searchLinks: await wrapNoonLinks(alt.searchLinks),
    }))
  );
}
