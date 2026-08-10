import { resolvePricesForLinks } from "./_priceResolver.js";

// ============================================================================
// Retailer price retry + per-domain health tracking.
//
// api/analyze.ts caches retailerPrices (from resolvePricesForLinks in
// _priceResolver.ts) per product+currency+condition so repeat scans of a
// popular product reuse it instead of re-resolving live (see
// supabase-cache-migration.sql). The problem: if a store failed to resolve
// on the FIRST scan (blocked, timed out, JS-rendered page), that null price
// sat in the cache for the rest of its TTL — every user who then hit that
// cached row saw the same missing price, with no chance to self-correct
// until the cache expired outright.
//
// retryUnresolvedRetailerPrices() re-runs resolution, in the background on
// a schedule instead of on a user's request, ONLY for the retailer links
// that came back unresolved — already-successful prices are left untouched.
// No new API, no new dependency — it's the exact same free
// resolvePricesForLinks() pipeline api/analyze.ts already calls, just given
// a second, unhurried attempt.
//
// While it's already reading every unresolved link's URL to retry it, this
// also tallies success/failure PER DOMAIN across the batch. A domain that
// keeps failing across many different products (not just one flaky link)
// usually means something structural changed on that retailer's site —
// this surfaces it in the cron summary (visible in the cron_logs table)
// instead of it silently sitting at a low success rate for weeks.
// ============================================================================

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

export interface RetailerPriceRetryResult {
  checked: number;
  rowsUpdated: number;
  storesRetried: number;
  storesFixed: number;
  // Domains with the most retry attempts in this run, worst success rate
  // first — capped to the top 10 so the cron_logs row doesn't balloon.
  domainHealth: { domain: string; attempts: number; fixed: number; successRate: number }[];
}

export async function retryUnresolvedRetailerPrices(admin: any, rowLimit = 150, maxRowsToRetry = 40): Promise<RetailerPriceRetryResult> {
  const { data: rows, error } = await admin
    .from("analysis_cache")
    .select("cache_key, market_data")
    .order("created_at", { ascending: false })
    .limit(rowLimit);

  if (error || !rows?.length) {
    return { checked: 0, rowsUpdated: 0, storesRetried: 0, storesFixed: 0, domainHealth: [] };
  }

  // Cap per run so a single cron invocation can't run away with time —
  // resolvePricesForLinks() is already internally bounded per-store, this
  // just bounds how many CACHE ROWS get a retry pass in one invocation.
  const batch = rows.filter((r: any) => {
    const rp = r?.market_data?.retailerPrices;
    return Array.isArray(rp) && rp.some((s: any) => s && s.price == null && s.url);
  }).slice(0, maxRowsToRetry);

  let rowsUpdated = 0;
  let storesRetried = 0;
  let storesFixed = 0;
  const domainStats = new Map<string, { attempts: number; fixed: number }>();

  for (const row of batch) {
    try {
      const retailerPrices: any[] = row.market_data.retailerPrices;
      const unresolved = retailerPrices.filter((s: any) => s && s.price == null && s.url);
      if (unresolved.length === 0) continue;

      storesRetried += unresolved.length;
      const links = unresolved.map((s: any) => ({ retailer: s.retailer, url: s.url }));
      const currency = unresolved[0]?.currency || "USD";
      const retried = await resolvePricesForLinks(links, currency);

      let fixedInRow = 0;
      const retriedByUrl = new Map(retried.map((r) => [r.url, r]));
      const mergedRetailerPrices = retailerPrices.map((s: any) => {
        if (s && s.price == null && s.url && retriedByUrl.has(s.url)) {
          const fresh = retriedByUrl.get(s.url)!;
          const domain = hostnameOf(s.url);
          const stat = domainStats.get(domain) || { attempts: 0, fixed: 0 };
          stat.attempts++;
          if (fresh.price != null) {
            stat.fixed++;
            fixedInRow++;
          }
          domainStats.set(domain, stat);
          return fresh;
        }
        return s;
      });

      if (fixedInRow > 0) {
        await admin
          .from("analysis_cache")
          .update({ market_data: { ...row.market_data, retailerPrices: mergedRetailerPrices } })
          .eq("cache_key", row.cache_key);
        rowsUpdated++;
        storesFixed += fixedInRow;
      }
    } catch (e: any) {
      console.error(`[cron] retryUnresolvedRetailerPrices failed for cache_key ${row.cache_key}:`);
      console.error(e);
    }
  }

  const domainHealth = Array.from(domainStats.entries())
    .map(([domain, stat]) => ({
      domain,
      attempts: stat.attempts,
      fixed: stat.fixed,
      successRate: stat.attempts > 0 ? Math.round((stat.fixed / stat.attempts) * 100) / 100 : 0,
    }))
    // Only domains retried at least a few times are meaningful signal —
    // a single miss doesn't tell you anything about the domain overall.
    .filter((d) => d.attempts >= 3)
    .sort((a, b) => a.successRate - b.successRate)
    .slice(0, 10);

  if (domainHealth.length > 0) {
    const worst = domainHealth.filter((d) => d.successRate === 0);
    if (worst.length > 0) {
      console.warn(
        "[cron] retryUnresolvedRetailerPrices: domains with 0% retry success this run (possible structural change on their site):",
        worst.map((d) => `${d.domain} (${d.attempts} attempts)`).join(", ")
      );
    }
  }

  return { checked: batch.length, rowsUpdated, storesRetried, storesFixed, domainHealth };
}
