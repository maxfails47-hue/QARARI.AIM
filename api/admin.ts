import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./admin/_auth.js";
import { getSupabaseAdmin } from "./_supabaseAdmin.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "./_logger.js";

// ---------------------------------------------------------------------------
// Consolidated admin API.
//
// Shary pivot: the manual InstaPay subscription-approval workflow
// (requests/approve/reject — the whole "review screenshot, activate plan"
// flow) is gone along with the subscription model. Metrics no longer
// reports premium/MRR/subscription-request numbers.
//
// Frontend calls now look like:
//   /api/admin?action=metrics    (was /api/admin/metrics)
//   /api/admin?action=ai-costs   (was /api/admin/ai-costs)
//   /api/admin?action=login      (was /api/admin/login)
// ---------------------------------------------------------------------------

async function handleMetrics(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log("Loading metrics (parallel Supabase queries)...");
  const [
    { count: totalUsers },
    { count: newSignupsWeek },
    { count: totalAnalyses },
    { count: analysesThisMonth },
    { data: moneySavedRows },
  ] = await Promise.all([
    admin.from("users").select("id", { count: "exact", head: true }),
    admin.from("users").select("id", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    admin.from("analyses").select("id", { count: "exact", head: true }),
    admin.from("analyses").select("id", { count: "exact", head: true }).gte("created_at", startOfMonth),
    admin.from("users").select("total_money_saved"),
  ]);

  const totalMoneySaved = (moneySavedRows || []).reduce((sum: number, r: any) => sum + Number(r.total_money_saved || 0), 0);

  return res.status(200).json({
    totalUsers: totalUsers || 0,
    newSignupsThisWeek: newSignupsWeek || 0,
    totalAnalyses: totalAnalyses || 0,
    analysesThisMonth: analysesThisMonth || 0,
    totalMoneySaved,
  });
}

async function handleAiCosts(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  console.log("Loading ai_usage_log for this month...");
  const { data: monthRows, error: monthErr } = await admin
    .from("ai_usage_log")
    .select("model, endpoint, tier, total_tokens, estimated_cost_usd, created_at")
    .gte("created_at", startOfMonth);

  if (monthErr) {
    console.error("[/api/admin?action=ai-costs] Supabase select failed:", monthErr);
    return res.status(500).json({ error: "server_error" });
  }

  const rows = monthRows || [];
  const totalCostThisMonth = rows.reduce((s, r: any) => s + Number(r.estimated_cost_usd || 0), 0);
  const totalCallsThisMonth = rows.length;
  const totalTokensThisMonth = rows.reduce((s, r: any) => s + Number(r.total_tokens || 0), 0);

  const byModel: Record<string, { calls: number; cost: number }> = {};
  const byEndpoint: Record<string, { calls: number; cost: number }> = {};
  for (const r of rows as any[]) {
    byModel[r.model] = byModel[r.model] || { calls: 0, cost: 0 };
    byModel[r.model].calls++;
    byModel[r.model].cost += Number(r.estimated_cost_usd || 0);

    byEndpoint[r.endpoint] = byEndpoint[r.endpoint] || { calls: 0, cost: 0 };
    byEndpoint[r.endpoint].calls++;
    byEndpoint[r.endpoint].cost += Number(r.estimated_cost_usd || 0);
  }

  const { data: recentRows } = await admin
    .from("ai_usage_log")
    .select("estimated_cost_usd, created_at")
    .gte("created_at", fourteenDaysAgo);

  const byDay: Record<string, number> = {};
  for (const r of (recentRows || []) as any[]) {
    const day = new Date(r.created_at).toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + Number(r.estimated_cost_usd || 0);
  }
  const dailyTrend = Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, cost]) => ({ date, cost: Number(cost.toFixed(4)) }));

  const avgCostPerCall = totalCallsThisMonth ? Number((totalCostThisMonth / totalCallsThisMonth).toFixed(5)) : 0;

  return res.status(200).json({
    totalCostThisMonth: Number(totalCostThisMonth.toFixed(4)),
    totalCallsThisMonth,
    totalTokensThisMonth,
    avgCostPerCall,
    byModel,
    byEndpoint,
    dailyTrend,
    note: "Costs are ESTIMATED from a configured pricing table in api/_costTracking.ts — update it to match current Groq and Tavily pricing for accuracy.",
  });
}

async function handleLogin(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  // isValidAdmin() was already checked before dispatch, so reaching here means success.
  return res.status(200).json({ success: true });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  const action = (req.query?.action as string) || (req.method === "POST" ? (req.body || {}).action : undefined);

  try {
    console.log("Checking authentication...");
    if (!isValidAdmin(req)) {
      console.warn(`[/api/admin?action=${action}] Rejected — invalid admin credentials`);
      return res.status(401).json({ error: action === "login" ? "invalid_credentials" : "unauthorized" });
    }
    console.log("Authentication OK");

    let result: VercelResponse | void;
    switch (action) {
      case "metrics":
        result = await handleMetrics(req, res);
        break;
      case "ai-costs":
        result = await handleAiCosts(req, res);
        break;
      case "login":
        result = await handleLogin(req, res);
        break;
      default:
        return res.status(400).json({ error: "unknown_action" });
    }

    logRequestSuccess(start);
    return result;
  } catch (err: any) {
    logUnhandledError(err, start);
    // err.stack is logged server-side above — never expose it to the client.
    return res.status(500).json({ error: "server_error", message: err?.message });
  }
}
