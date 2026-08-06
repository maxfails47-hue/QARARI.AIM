import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { classifyProductCategory } from "./_groq_tavily.js";
import { logRequestStart, logRequestSuccess, logUnhandledError } from "./_logger.js";

// ---------------------------------------------------------------------------
// Consolidated user-facing API.
//
// Shary pivot: this used to also serve scans-remaining, compares-remaining,
// compare, and subscribe — all of that was built around the old
// verdict/subscription model (paid plans with monthly scan/compare quotas).
// Shary's /api/search endpoint is unmetered and the product is now
// affiliate-funded, not subscription-funded, so those actions and the
// entire plan/quota system they depended on (_planConfig.ts,
// subscription_requests, scans/compares_used_this_month, etc.) are gone.
//
// What's left is genuinely still needed:
//   /api/user?action=classify-icon    — smart product icon (AI category)
//   /api/user?action=chat-remaining   — advisor chat quota display (flat
//                                        cap, shared with api/ask.ts)
// ---------------------------------------------------------------------------

// Keep in sync with MAX_ADVISOR_MESSAGES_PER_MONTH in api/ask.ts.
const MAX_ADVISOR_MESSAGES_PER_MONTH = 30;

async function handleChatRemaining(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const user = await getAuthedUser(req);
  const now = new Date();

  const identity = user
    ? `user:${user.id}`
    : `ip:${(req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown"}`;

  const { data: advisorRow } = await admin
    .from("advisor_usage")
    .select("messages_used, reset_at")
    .eq("identity", identity)
    .single();

  const resetAt = advisorRow?.reset_at ? new Date(advisorRow.reset_at) : null;
  const needsReset = !resetAt || now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
  const used = needsReset ? 0 : advisorRow?.messages_used || 0;
  const max = MAX_ADVISOR_MESSAGES_PER_MONTH;

  return res.status(200).json({ remaining: Math.max(0, max - used), max });
}

async function handleClassifyIcon(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const { productName } = req.body || {};
  if (!productName || typeof productName !== "string") {
    return res.status(400).json({ error: "invalid_input", category: "other" });
  }

  try {
    const category = await classifyProductCategory(productName);
    return res.status(200).json({ category });
  } catch (e: any) {
    // Never let this block the UI — always resolve with a safe fallback.
    console.error("[/api/user?action=classify-icon] failed, returning fallback:", e);
    return res.status(200).json({ category: "other" });
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);

  const action = (req.query?.action as string) || (req.method === "POST" ? (req.body || {}).action : undefined);

  try {
    let result: VercelResponse | void;
    switch (action) {
      case "chat-remaining":
        result = await handleChatRemaining(req, res);
        break;
      case "classify-icon":
        result = await handleClassifyIcon(req, res);
        break;
      default:
        return res.status(400).json({ error: "unknown_action" });
    }

    logRequestSuccess(start);
    return result;
  } catch (err: any) {
    logUnhandledError(err, start);
    return res.status(500).json({ error: "server_error", message: err?.message });
  }
}
