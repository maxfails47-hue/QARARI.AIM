import type { VercelRequest, VercelResponse } from "@vercel/node";
import { isValidAdmin } from "./admin/_auth.js";
import { getSupabaseAdmin } from "./_supabaseAdmin.js";
import { sendEmail } from "./_resend.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "./_logger.js";
import { getPlanConfig } from "./_planConfig.js";

// ---------------------------------------------------------------------------
// Consolidated admin API — merges what used to be 6 separate serverless
// functions (admin/requests, admin/approve, admin/reject, admin/metrics,
// admin/ai-costs, admin/login) into a single Vercel Function, dispatching by
// `?action=` (query string). This keeps the project comfortably under the
// Hobby plan's 12-serverless-function limit while preserving every route's
// exact original behavior, request/response shape, and auth checks.
//
// Frontend calls now look like:
//   /api/admin?action=requests   (was /api/admin/requests)
//   /api/admin?action=approve    (was /api/admin/approve)
//   /api/admin?action=reject     (was /api/admin/reject)
//   /api/admin?action=metrics    (was /api/admin/metrics)
//   /api/admin?action=ai-costs   (was /api/admin/ai-costs)
//   /api/admin?action=login      (was /api/admin/login)
// ---------------------------------------------------------------------------

async function handleRequests(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();

  console.log("Loading pending subscription requests...");
  const { data, error } = await admin
    .from("subscription_requests")
    .select("*, users(email, full_name)")
    .eq("status", "pending_review")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("[/api/admin?action=requests] Supabase select failed:", error);
    return res.status(500).json({ error: "server_error" });
  }
  console.log("[/api/admin?action=requests] Loaded", (data || []).length, "pending requests");

  console.log("Generating signed screenshot URLs...");
  const withSignedUrls = await Promise.all(
    (data || []).map(async (r: any) => {
      try {
        const { data: signed, error: signErr } = await admin.storage.from("screenshots").createSignedUrl(r.screenshot_url, 3600);
        if (signErr) {
          console.error(`[/api/admin?action=requests] Failed to sign screenshot for request ${r.id}:`, signErr);
        }
        return { ...r, screenshot_signed_url: signed?.signedUrl || null };
      } catch (e: any) {
        console.error(`[/api/admin?action=requests] Signing threw for request ${r.id}:`, e, e?.stack);
        return { ...r, screenshot_signed_url: null };
      }
    })
  );

  return res.status(200).json({ requests: withSignedUrls });
}

async function handleApprove(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { requestId } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ error: "missing_request_id" });
  }
  console.log("[/api/admin?action=approve] requestId:", requestId);

  const admin = getSupabaseAdmin();

  console.log("Loading subscription request...");
  const { data: reqRow, error: reqErr } = await admin
    .from("subscription_requests")
    .select("*, users(id, email)")
    .eq("id", requestId)
    .single();

  if (reqErr || !reqRow) {
    console.error("[/api/admin?action=approve] request_not_found. Supabase error:", reqErr);
    return res.status(404).json({ error: "request_not_found" });
  }
  if (reqRow.status !== "pending_review") {
    console.warn("[/api/admin?action=approve] Request already reviewed. status:", reqRow.status);
    return res.status(409).json({ error: "already_reviewed" });
  }

  // Item 7, second layer: handleSubscribe already blocks a user from
  // creating a new request while one is active, but that only prevents
  // NEW requests — it doesn't retroactively stop two already-pending
  // requests for the same user (e.g. one made just before the other was
  // approved) from both getting approved. Check again here right before
  // approval.
  const { data: activeCheck } = await admin
    .from("users")
    .select("tier, subscription_end_date")
    .eq("id", reqRow.user_id)
    .single();
  const alreadyActive =
    activeCheck?.tier === "premium" &&
    (!activeCheck.subscription_end_date || new Date(activeCheck.subscription_end_date) >= new Date());
  if (alreadyActive) {
    console.warn("[/api/admin?action=approve] User already has an active plan — refusing to stack another. user:", reqRow.user_id);
    return res.status(409).json({ error: "already_subscribed", message: "العميل ده لسه عنده باقة شغالة حاليًا." });
  }

  const planConfig = getPlanConfig(reqRow.plan);
  if (!planConfig) {
    console.error("[/api/admin?action=approve] unknown plan:", reqRow.plan);
    return res.status(400).json({ error: "unknown_plan" });
  }

  const now = new Date();
  const endDate = null;

  const { data: beforeUser } = await admin.from("users").select("*").eq("id", reqRow.user_id).single();

  console.log("Saving database...");
  const updateData: any = {
    tier: "premium",
    current_plan_name: reqRow.plan,
    subscription_start_date: now.toISOString(),
    subscription_end_date: endDate,
    scans_limit_this_month: planConfig.limits.scans,
    compares_limit_this_month: planConfig.limits.compares,
    chat_messages_limit: planConfig.limits.chatMessages,
    price_alerts_limit: 0,
    can_export_pdf: false,
  };

  updateData.scans_used_this_month = 0;
  updateData.compares_used_this_month = 0;
  updateData.chat_messages_used = 0;
  updateData.price_alerts_used = 0;

  const { error: updateErr } = await admin.from("users").update(updateData).eq("id", reqRow.user_id);
  if (updateErr) {
    console.error("[/api/admin?action=approve] failed to update user row:", updateErr);
    return res.status(500).json({ error: "update_failed", details: updateErr.message });
  }

  await admin
    .from("subscription_requests")
    .update({ status: "approved", reviewed_by: "admin", reviewed_at: now.toISOString() })
    .eq("id", requestId);

  await admin.from("admin_audit_log").insert({
    admin_identity: "admin",
    action_type: "approve_subscription",
    target_user_id: reqRow.user_id,
    before_value: beforeUser,
    after_value: updateData,
  });
  console.log("Saving database... done");

  if (reqRow.users?.email) {
    const planDisplayName = reqRow.plan.replace("_", " ").toUpperCase();
    await sendEmail(
      reqRow.users.email,
      `تم تفعيل باقة ${planDisplayName} — Qarari.AI`,
      `<p>تم تفعيل باقتك (${planDisplayName}) بنجاح!</p>
       ${endDate ? `<p>صالحة حتى ${(endDate as any).toLocaleDateString("ar-EG")}.</p>` : "<p>هذه الباقة لا تنتهي بصلاحية زمنية.</p>"}
       <p>Your ${planDisplayName} plan is now active!</p>`
    );
  }

  return res.status(200).json({ success: true });
}

async function handleReject(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { requestId, reason } = req.body || {};
  if (!requestId) {
    return res.status(400).json({ error: "missing_request_id" });
  }
  console.log("[/api/admin?action=reject] requestId:", requestId, "| reason:", reason);

  const admin = getSupabaseAdmin();
  const { error } = await admin
    .from("subscription_requests")
    .update({ status: "rejected", reject_reason: reason || null, reviewed_by: "admin", reviewed_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", "pending_review");

  if (error) {
    console.error("[/api/admin?action=reject] Supabase update failed:", error);
    return res.status(500).json({ error: "server_error" });
  }

  return res.status(200).json({ success: true });
}

async function handleMetrics(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const now = new Date();
  const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  console.log("Loading metrics (parallel Supabase queries)...");
  const [
    { count: totalUsers },
    { data: premiumUserRows },
    { count: newSignupsWeek },
    { count: totalAnalyses },
    { count: analysesThisMonth },
    { data: moneySavedRows },
    { count: pendingRequests },
    { count: approvedThisMonth },
    { count: rejectedThisMonth },
    { data: activeSubs },
  ] = await Promise.all([
    admin.from("users").select("id", { count: "exact", head: true }),
    admin.from("users").select("current_plan_name").eq("tier", "premium"),
    admin.from("users").select("id", { count: "exact", head: true }).gte("created_at", sevenDaysAgo),
    admin.from("analyses").select("id", { count: "exact", head: true }),
    admin.from("analyses").select("id", { count: "exact", head: true }).gte("created_at", startOfMonth),
    admin.from("users").select("total_money_saved"),
    admin.from("subscription_requests").select("id", { count: "exact", head: true }).eq("status", "pending_review"),
    admin.from("subscription_requests").select("id", { count: "exact", head: true }).eq("status", "approved").gte("reviewed_at", startOfMonth),
    admin.from("subscription_requests").select("id", { count: "exact", head: true }).eq("status", "rejected").gte("reviewed_at", startOfMonth),
    admin.from("subscription_requests").select("plan").eq("status", "approved").gte("reviewed_at", startOfMonth),
  ]);

  const totalMoneySaved = (moneySavedRows || []).reduce((sum: number, r: any) => sum + Number(r.total_money_saved || 0), 0);
  const premiumUsers = (premiumUserRows || []).length;

  const mrrEstimate = (premiumUserRows || []).reduce(
    (sum: number, r: any) => sum + (getPlanConfig(r.current_plan_name)?.price || 0),
    0
  );

  const newMrrThisMonth = (activeSubs || []).reduce(
    (sum: number, r: any) => sum + (getPlanConfig(r.plan)?.price || 0),
    0
  );

  const conversionRate = totalUsers ? Number((((premiumUsers || 0) / totalUsers) * 100).toFixed(1)) : 0;

  return res.status(200).json({
    totalUsers: totalUsers || 0,
    premiumUsers: premiumUsers || 0,
    freeUsers: (totalUsers || 0) - (premiumUsers || 0),
    newSignupsThisWeek: newSignupsWeek || 0,
    conversionRate,
    totalAnalyses: totalAnalyses || 0,
    analysesThisMonth: analysesThisMonth || 0,
    totalMoneySaved,
    mrrEstimate,
    newMrrThisMonth: Number(newMrrThisMonth.toFixed(2)),
    pendingRequests: pendingRequests || 0,
    approvedThisMonth: approvedThisMonth || 0,
    rejectedThisMonth: rejectedThisMonth || 0,
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
      case "requests":
        result = await handleRequests(req, res);
        break;
      case "approve":
        result = await handleApprove(req, res);
        break;
      case "reject":
        result = await handleReject(req, res);
        break;
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
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
