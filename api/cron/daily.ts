import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { sendEmail } from "../_resend.js";
import { getFairPriceRange, fetchMainProductRetailerLinks } from "../_groq_tavily.js";
import { resolvePricesForLinks } from "../_priceResolver.js";
import { recordPriceSnapshots } from "../_priceHistory.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep } from "../_logger.js";

// Verifies this request really came from Vercel Cron. Vercel automatically
// sends `Authorization: Bearer $CRON_SECRET` on scheduled invocations once
// the CRON_SECRET env var is set — see SETUP.md.
function isValidCronRequest(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${secret}`;
}

// ---- Real price-drop checking for the watchlist (Section 18) ----
async function checkWatchlistPriceDrops(admin: any) {
  const { data: rows, error } = await admin
    .from("watchlist")
    .select("*, users(email)")
    .eq("active", true)
    .is("notified_at", null);

  if (error || !rows?.length) return { checked: 0, notified: 0 };

  let notified = 0;

  // Cap per run so a single cron invocation can't run away with Groq/Tavily cost or time.
  const batch = rows.slice(0, 25);

  for (const row of batch) {
    try {
      const condition: "new" | "likeNew" | "used" =
        row.condition === "used" ? "used" : row.condition === "likeNew" ? "likeNew" : "new";

      // Same pipeline api/analyze.ts uses for the report itself: Groq
      // Compound first, falling back automatically to Serper + gpt-oss-120b
      // if Compound errors out (e.g. the Free Tier's internal search-tool
      // response-size limit) — so a watchlist check is exactly as accurate
      // as the price the user saw when they added the item.
      const priceRange = await getFairPriceRange(row.product, row.currency, condition, "");
      const currentPrice = priceRange.mid;
      if (!currentPrice || Number.isNaN(currentPrice)) continue;

      await admin
        .from("watchlist")
        .update({ last_checked_price: currentPrice, last_checked_at: new Date().toISOString() })
        .eq("id", row.id);

      // A meaningful drop = at least 5% below the price saved when they added it.
      const dropThreshold = row.saved_price * 0.95;
      if (currentPrice <= dropThreshold && row.users?.email) {
        await sendEmail(
          row.users.email,
          `نزل سعر ${row.product}! — Shary`,
          `<p>السعر الحالي المقدّر لـ ${row.product} أصبح ${currentPrice.toLocaleString()} ${row.currency}، أقل من ${row.saved_price.toLocaleString()} ${row.currency} اللي كنت متابعه.</p>
           <p>The estimated price for ${row.product} dropped to ${currentPrice.toLocaleString()} ${row.currency}, down from your saved ${row.saved_price.toLocaleString()} ${row.currency}.</p>`
        );
        await admin.from("watchlist").update({ notified_at: new Date().toISOString() }).eq("id", row.id);
        notified++;
      }
    } catch (e: any) {
      console.error(`[cron] watchlist check failed for row ${row.id}:`);
      console.error(e);
      console.error(e?.stack);
    }
  }

  return { checked: batch.length, notified };
}

// ---- Keep price_history growing for known products even when nobody
// re-searches them (Phase 3 foundation for real BUY NOW / WAIT verdicts —
// see api/_priceHistory.ts). Re-runs the exact same live discover+resolve
// pipeline /api/search uses, just triggered by the schedule instead of a
// user request, then snapshots the result the same way. ----
async function refreshPriceHistory(admin: any) {
  // Distinct product_key+currency pairs seen recently. Capped window so this
  // doesn't scan the whole table as it grows.
  const { data: recentRows, error } = await admin
    .from("price_history")
    .select("product_key, currency")
    .order("checked_at", { ascending: false })
    .limit(500);

  if (error || !recentRows?.length) return { checked: 0, snapshotted: 0 };

  const seen = new Set<string>();
  const pairs: { product_key: string; currency: string }[] = [];
  for (const row of recentRows) {
    const key = `${row.product_key}::${row.currency}`;
    if (!seen.has(key)) {
      seen.add(key);
      pairs.push(row);
    }
  }

  // Same per-run cap philosophy as checkWatchlistPriceDrops — this hits
  // real retailer pages per product, so a single cron run can't run away.
  const batch = pairs.slice(0, 25);
  let snapshotted = 0;

  for (const { product_key, currency } of batch) {
    try {
      const links = await fetchMainProductRetailerLinks(product_key, currency, "new");
      if (!links.length) continue;
      const resolved = await resolvePricesForLinks(links, currency);
      await recordPriceSnapshots(admin, product_key, currency, resolved);
      snapshotted++;
    } catch (e: any) {
      console.error(`[cron] price history refresh failed for "${product_key}" (${currency}):`);
      console.error(e);
    }
  }

  return { checked: batch.length, snapshotted };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  if (!isValidCronRequest(req)) {
    console.warn("[cron] Rejected request — invalid or missing CRON_SECRET auth");
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const admin = getSupabaseAdmin();
    const summary: Record<string, unknown> = {};

    // NOTE: the old scans/compares monthly quota reset jobs were removed
    // along with the subscription system — Shary's /api/search is
    // unmetered now, so there's no monthly counter left to reset.
    logStep("checkWatchlistPriceDrops...");
    try {
      summary.watchlist = await checkWatchlistPriceDrops(admin);
      console.log("[cron] checkWatchlistPriceDrops result:", summary.watchlist);
    } catch (e: any) {
      console.error("[cron] checkWatchlistPriceDrops failed:");
      console.error(e);
      console.error(e?.stack);
      summary.watchlist = { error: String(e) };
    }

    logStep("refreshPriceHistory...");
    try {
      summary.priceHistory = await refreshPriceHistory(admin);
      console.log("[cron] refreshPriceHistory result:", summary.priceHistory);
    } catch (e: any) {
      console.error("[cron] refreshPriceHistory failed:");
      console.error(e);
      console.error(e?.stack);
      summary.priceHistory = { error: String(e) };
    }

    console.log("Saving database...");
    await admin.from("cron_logs").insert({ job_name: "daily", summary });
    console.log("Saving database... done");

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json({ success: true, summary });
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
