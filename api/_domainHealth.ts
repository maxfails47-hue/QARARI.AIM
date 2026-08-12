// ============================================================================
// Cumulative per-domain price-resolution health (backed by domain_health
// table — see supabase-domain-health-migration.sql).
//
// Two call sites feed into and read from this:
//   - api/_retailerPriceRetry.ts (cron retry pass) — already tallies
//     domainStats per run; this persists that tally instead of letting it
//     evaporate at the end of the invocation.
//   - api/analyze.ts (live user-facing resolution) — loads the "known
//     bad" set once before calling resolvePricesForLinks(), so
//     _priceResolver.ts can skip straight to the reader-proxy tier for
//     domains that plain fetch() essentially never gets through, instead
//     of spending the fetch+retry budget on tiers that are known to fail.
// ============================================================================

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

// A domain only counts as "known bad" once it has enough attempts to be
// meaningful (a single unlucky miss says nothing) and its cumulative
// success rate is low enough that trying plain-fetch tiers first is more
// likely to waste time than to succeed.
const MIN_ATTEMPTS_FOR_SIGNAL = 5;
const BAD_SUCCESS_RATE_CEILING = 0.15;

/**
 * Loads the set of domains whose plain-fetch success rate is low enough
 * that resolveOne() should try the reader-proxy tier FIRST for them,
 * rather than as a last resort. Never throws — a DB hiccup here should
 * never block price resolution, it just means no domain gets prioritized
 * this run (same behavior as before this feature existed).
 */
export async function loadKnownBadDomains(admin: any): Promise<Set<string>> {
  try {
    const { data, error } = await admin
      .from("domain_health")
      .select("domain, attempts, success_rate")
      .gte("attempts", MIN_ATTEMPTS_FOR_SIGNAL)
      .lte("success_rate", BAD_SUCCESS_RATE_CEILING);
    if (error || !data) return new Set();
    return new Set(data.map((r: any) => r.domain as string));
  } catch {
    return new Set();
  }
}

/**
 * Merges this run's per-domain {attempts, fixed} tallies into the
 * cumulative domain_health table. Fire-and-forget from the caller's
 * perspective is fine, but we still await it here so callers can log
 * failures if they want — it just never throws upward.
 */
export async function persistDomainHealth(
  admin: any,
  domainStats: Map<string, { attempts: number; fixed: number }>
): Promise<void> {
  if (domainStats.size === 0) return;
  try {
    const domains = Array.from(domainStats.keys());
    const { data: existing } = await admin
      .from("domain_health")
      .select("domain, attempts, fixed")
      .in("domain", domains);

    const existingByDomain = new Map((existing || []).map((r: any) => [r.domain, r]));

    const rows = domains.map((domain) => {
      const delta = domainStats.get(domain)!;
      const prior = existingByDomain.get(domain) as { attempts: number; fixed: number } | undefined;
      const attempts = (prior?.attempts || 0) + delta.attempts;
      const fixed = (prior?.fixed || 0) + delta.fixed;
      return {
        domain,
        attempts,
        fixed,
        success_rate: attempts > 0 ? Math.round((fixed / attempts) * 100) / 100 : 0,
        updated_at: new Date().toISOString(),
      };
    });

    await admin.from("domain_health").upsert(rows, { onConflict: "domain" });
  } catch (e) {
    console.error("[persistDomainHealth] failed to upsert (non-fatal):", e);
  }
}
