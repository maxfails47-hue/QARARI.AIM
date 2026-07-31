import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { sendEmail } from "../_resend.js";
import { getFairPriceRange } from "../_groq_tavily.js";
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

// ---- 1. Auto-revert expired Premium subscriptions to Free (Section 16) ----
async function revertExpiredSubscriptions(admin: any) {
  const now = new Date().toISOString();
  const { data: expired, error } = await admin
    .from("users")
    .select("id, email, subscription_end_date")
    .eq("tier", "premium")
    .lt("subscription_end_date", now);

  if (error || !expired?.length) return { reverted: 0 };

  for (const u of expired) {
    await admin.from("users").update({ tier: "free" }).eq("id", u.id);
    await admin.from("admin_audit_log").insert({
      admin_identity: "cron",
      action_type: "subscription_expired_auto_revert",
      target_user_id: u.id,
      before_value: { tier: "premium" },
      after_value: { tier: "free" },
    });
    if (u.email) {
      await sendEmail(
        u.email,
        "انتهى اشتراكك في Qarari.AI Premium",
        `<p>انتهت صلاحية اشتراكك في بريميوم. جدّد اشتراكك للاستمرار في الاستفادة من المميزات الكاملة.</p>
         <p>Your Qarari.AI Premium subscription has expired. Renew to keep your full features.</p>`
      );
    }
  }
  return { reverted: expired.length };
}

// ---- 2. Proactively reset monthly free-scan counters (Section 14) ----
async function resetMonthlyScans(admin: any) {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const { data: usersToReset } = await admin
    .from("users")
    .select("id")
    .lt("scans_reset_at", startOfMonth)
    .gt("scans_used_this_month", 0);

  if (usersToReset?.length) {
    const ids = usersToReset.map((u: any) => u.id);
    await admin.from("users").update({ scans_used_this_month: 0, scans_reset_at: now.toISOString() }).in("id", ids);
  }

  // Reset IP-based guest usage (legacy)
  const { data: guestsToReset } = await admin
    .from("guest_usage")
    .select("ip_address")
    .lt("scans_reset_at", startOfMonth)
    .gt("scans_used_this_month", 0);

  if (guestsToReset?.length) {
    const ips = guestsToReset.map((g: any) => g.ip_address);
    await admin.from("guest_usage").update({ scans_used_this_month: 0, scans_reset_at: now.toISOString() }).in("ip_address", ips);
  }

  // Reset Device Fingerprint-based guest usage (primary)
  const { data: deviceLogsToReset } = await admin
    .from("device_usage_logs")
    .select("id, device_fingerprint")
    .lt("scans_reset_at", startOfMonth)
    .gt("scans_used_this_month", 0);

  let devicesReset = 0;
  if (deviceLogsToReset?.length) {
    const logIds = deviceLogsToReset.map((l: any) => l.id);
    await admin.from("device_usage_logs").update({ scans_used_this_month: 0, scans_reset_at: now.toISOString() }).in("id", logIds);
    devicesReset = deviceLogsToReset.length;
  }

  return { usersReset: usersToReset?.length || 0, guestsReset: guestsToReset?.length || 0, devicesReset };
}

// ---- 3. Real price-drop checking for the watchlist (Section 18) ----
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
          `نزل سعر ${row.product}! — Qarari.AI`,
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

// ---- 2b. Proactively reset monthly compare counters (Section 15's 10/month cap) ----
async function resetMonthlyCompares(admin: any) {
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

  const { data: usersToReset } = await admin
    .from("users")
    .select("id")
    .lt("compares_reset_at", startOfMonth)
    .gt("compares_used_this_month", 0);

  if (usersToReset?.length) {
    const ids = usersToReset.map((u: any) => u.id);
    await admin.from("users").update({ compares_used_this_month: 0, compares_reset_at: now.toISOString() }).in("id", ids);
  }

  return { usersReset: usersToReset?.length || 0 };
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

    logStep("revertExpiredSubscriptions...");
    try {
      summary.subscriptions = await revertExpiredSubscriptions(admin);
      console.log("[cron] revertExpiredSubscriptions result:", summary.subscriptions);
    } catch (e: any) {
      console.error("[cron] revertExpiredSubscriptions failed:");
      console.error(e);
      console.error(e?.stack);
      summary.subscriptions = { error: String(e) };
    }

    logStep("resetMonthlyScans...");
    try {
      summary.scanResets = await resetMonthlyScans(admin);
      console.log("[cron] resetMonthlyScans result:", summary.scanResets);
    } catch (e: any) {
      console.error("[cron] resetMonthlyScans failed:");
      console.error(e);
      console.error(e?.stack);
      summary.scanResets = { error: String(e) };
    }

    logStep("resetMonthlyCompares...");
    try {
      summary.compareResets = await resetMonthlyCompares(admin);
      console.log("[cron] resetMonthlyCompares result:", summary.compareResets);
    } catch (e: any) {
      console.error("[cron] resetMonthlyCompares failed:");
      console.error(e);
      console.error(e?.stack);
      summary.compareResets = { error: String(e) };
    }

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
