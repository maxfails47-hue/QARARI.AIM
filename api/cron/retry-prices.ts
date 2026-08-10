import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin } from "../_supabaseAdmin.js";
import { retryUnresolvedRetailerPrices } from "../_retailerPriceRetry.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep } from "../_logger.js";

// Split out from cron/daily.ts on purpose: the retailer-price retry is the
// one piece of the daily maintenance job that genuinely benefits from
// running MORE than once a day — a store that failed on someone's first
// scan this morning shouldn't have to wait until 3am tomorrow to
// self-correct. Every other daily.ts job (quota resets, watchlist emails)
// only makes sense once a day, so they stay there unchanged.
//
// Note: if this project is on Vercel's Hobby plan, Vercel currently
// restricts cron jobs to at most once per day regardless of the schedule
// configured here — this endpoint will still work correctly whenever it
// does run, it just won't get the faster cadence until/unless the project
// is on a plan that allows more frequent crons. Nothing breaks either way.
function isValidCronRequest(req: VercelRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers.authorization;
  return auth === `Bearer ${secret}`;
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

    logStep("retryUnresolvedRetailerPrices (fast cadence)...");
    const result = await retryUnresolvedRetailerPrices(admin);
    console.log("[cron] retry-prices result:", result);

    await admin.from("cron_logs").insert({ job_name: "retry-prices", summary: result });

    logRequestSuccess(start);
    return res.status(200).json({ success: true, summary: result });
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
