import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { callAiWithFallback, classifyProductCategory, verifyPaymentScreenshot, getFairPriceRange, type FairPriceRange } from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";
import { DEFAULT_PREMIUM_LIMITS, getAllPlans, getPlanConfig, FAIR_USE_CONFIG, getBurstLimit, FREE_TIER_LIMITS } from "./_planConfig.js";
import { sendTelegramAlert } from "./_telegram.js";

// ---------------------------------------------------------------------------
// Consolidated user-facing API — merges what used to be 3 separate
// serverless functions (scans-remaining, compare, subscribe) plus the new
// smart-icon classification call into a single Vercel Function, dispatched
// by `?action=` (query string). Keeps the project well under the Hobby
// plan's 12-function limit while preserving each route's exact original
// behavior, request/response shape, and auth checks.
//
// Frontend calls now look like:
//   /api/user?action=scans-remaining  (was /api/scans-remaining)
//   /api/user?action=compare          (was /api/compare)
//   /api/user?action=subscribe        (was /api/subscribe)
//   /api/user?action=classify-icon    (new — smart product icon)
// ---------------------------------------------------------------------------

const FREE_MONTHLY_LIMIT = FREE_TIER_LIMITS.scans; // free tier monthly analyses — single source of truth in _planConfig.ts
// NOTE: PREMIUM_MONTHLY_LIMIT is no longer used — plan limits are now
// read dynamically from the user's row (scans_limit_this_month) which is
// set during admin approval based on the actual plan config.
const DEFAULT_COMPARE_LIMIT = DEFAULT_PREMIUM_LIMITS.compares;

// ─── FAIR USE POLICY: In-memory burst rate limiter ───
// Tracks request timestamps per user/device to detect abnormal usage.
// When burst limit is exceeded, returns 429 with a friendly cooldown message.
// Normal heavy users of Elite/large plans are never affected.
interface BurstEntry {
  timestamps: number[];
  cooldownUntil?: number;
  warnedToday?: boolean;
}
const burstTracker = new Map<string, BurstEntry>();

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of burstTracker.entries()) {
    const windowStart = now - FAIR_USE_CONFIG.windowMs;
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
    if (entry.timestamps.length === 0 && !entry.cooldownUntil) {
      burstTracker.delete(key);
    }
  }
}, 5 * 60 * 1000);

function checkFairUseRateLimit(identifier: string, planName: string, monthlyQuota: number, monthlyUsed: number): { allowed: boolean; message?: { ar: string; en: string } } {
  const now = Date.now();
  let entry = burstTracker.get(identifier);

  if (!entry) {
    entry = { timestamps: [] };
    burstTracker.set(identifier, entry);
  }

  // If in cooldown, reject
  if (entry.cooldownUntil && now < entry.cooldownUntil) {
    return {
      allowed: false,
      message: {
        ar: "أنت بتستخدم قراري بسرعة عالية جداً. عشان نحافظ على الخدمة سريعة وموثوقة للجميع، بعض الطلبات ممكن تتأخر مؤقتاً. رصيدك المتبقي محفوظ.",
        en: "You're using Qarari at a very high speed. To keep the service fast and reliable for everyone, some requests may be temporarily slowed down. Your remaining credits are محفوظ.",
      },
    };
  }

  // Clear cooldown if expired
  if (entry.cooldownUntil && now >= entry.cooldownUntil) {
    entry.cooldownUntil = undefined;
  }

  // Remove timestamps outside the window
  const windowStart = now - FAIR_USE_CONFIG.windowMs;
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  // Check burst limit
  const burstLimit = getBurstLimit(planName);
  if (entry.timestamps.length >= burstLimit) {
    // Apply cooldown
    entry.cooldownUntil = now + FAIR_USE_CONFIG.cooldownMs;
    console.log("[Fair Use] Burst limit exceeded for", identifier, "| plan:", planName, "| timestamps:", entry.timestamps.length, "/", burstLimit);
    return {
      allowed: false,
      message: {
        ar: "أنت بتستخدم قراري بسرعة عالية جداً. عشان نحافظ على الخدمة سريعة وموثوقة للجميع، بعض الطلبات ممكن تتأخر مؤقتاً. رصيدك المتبقي محفوظ.",
        en: "You're using Qarari at a very high speed. To keep the service fast and reliable for everyone, some requests may be temporarily slowed down. Your remaining credits are protected.",
      },
    };
  }

  // Daily usage warning (log only, does NOT block)
  const dailyThreshold = monthlyQuota * FAIR_USE_CONFIG.dailyUsageWarningThreshold;
  if (monthlyUsed >= dailyThreshold && !entry.warnedToday) {
    const todayKey = new Date().toISOString().slice(0, 10);
    if (entry.warnedToday !== todayKey) {
      console.log("[Fair Use] Daily usage warning for", identifier, "| used:", monthlyUsed, "/", monthlyQuota, "(", ((monthlyUsed / monthlyQuota) * 100).toFixed(0), "%)");
      entry.warnedToday = todayKey;
    }
  }

  // Record this request
  entry.timestamps.push(now);
  return { allowed: true };
}

const PLAN_PRICES: Record<string, number> = {};
for (const plan of getAllPlans()) {
  PLAN_PRICES[plan.id] = plan.price;
}

// IP-alias policy: if a given IP has >= 2 distinct fingerprints within 24h,
// we treat the newest fingerprint as belonging to the same device as the
// earliest one (i.e. fingerprint rotation on the same machine). We then
// alias every subsequent new fingerprint from that IP to the primary one
// so the quota stays consolidated.
const FINGERPRINT_ALIAS_THRESHOLD = 2;
const FINGERPRINT_ALIAS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

async function resolveGuestFingerprint(
  admin: ReturnType<typeof getSupabaseAdmin>,
  fingerprint: string,
  ip: string
): Promise<{ effectiveFingerprint: string }> {
  // 1. Check if this fingerprint is already aliased to a primary one
  const { data: existingAlias } = await admin
    .from("guest_device_aliases")
    .select("primary_fingerprint")
    .eq("device_fingerprint", fingerprint)
    .single();
  if (existingAlias) {
    return { effectiveFingerprint: existingAlias.primary_fingerprint };
  }

  // 2. Check IP aliasing: count distinct fingerprints from this IP in last 24h
  const cutoff = new Date(Date.now() - FINGERPRINT_ALIAS_WINDOW_MS).toISOString();
  const { data: recentLogs } = await admin
    .from("device_usage_logs")
    .select("device_fingerprint, created_at")
    .eq("ip_address", ip)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: true });

  if (recentLogs && recentLogs.length >= FINGERPRINT_ALIAS_THRESHOLD) {
    // Find the primary (earliest) fingerprint for this IP
    const existingFingerprints = [...new Set(recentLogs.map((l: any) => l.device_fingerprint))];
    if (existingFingerprints.length >= FINGERPRINT_ALIAS_THRESHOLD) {
      const primaryFingerprint = existingFingerprints[0];
      // Insert alias so we don't re-compute every time
      try {
        await admin.from("guest_device_aliases").insert({
          device_fingerprint: fingerprint,
          primary_fingerprint: primaryFingerprint,
          ip_address: ip,
        });
      } catch (aliasErr) {
        // Unique constraint violation is fine — alias already exists
        console.log("[/api/user] Alias insert skipped (already exists):", aliasErr?.message);
      }
      console.log("[/api/user] IP-alias: fingerprint", fingerprint, "aliased to primary", primaryFingerprint);
      return { effectiveFingerprint: primaryFingerprint };
    }
  }

  // 3. No alias found — this is the primary fingerprint for this device
  return { effectiveFingerprint: fingerprint };
}

async function handleScansRemaining(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const user = await getAuthedUser(req);
  const now = new Date();

  if (user) {
    console.log("[/api/user?action=scans-remaining] Loading user row:", user.id);
    const { data: row } = await admin
      .from("users")
      .select("tier, scans_used_this_month, scans_reset_at, scans_limit_this_month")
      .eq("id", user.id)
      .single();

    if (!row) {
      console.error("[/api/user?action=scans-remaining] user_not_found:", user.id);
      return res.status(404).json({ error: "user_not_found" });
    }

    const resetAt = new Date(row.scans_reset_at);
    const needsReset = row.tier === "free" && (now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth());
    const used = needsReset ? 0 : row.scans_used_this_month;

    const max = row.tier === "premium"
      ? (row.scans_limit_this_month || DEFAULT_PREMIUM_LIMITS.scans)
      : FREE_MONTHLY_LIMIT;

    // Fair Use rate limit check
    const planName = row.tier === "premium" ? (row.current_plan_name || "small_bundle") : "free";
    const fairUse = checkFairUseRateLimit("user:" + user.id, planName, max, used);

    if (row.tier === "premium") {
      const remaining = Math.max(0, max - used);
      return res.status(200).json({ unlimited: false, remaining, max, plan: planName });
    }

    const remaining = Math.max(0, FREE_MONTHLY_LIMIT - used);
    return res.status(200).json({ unlimited: false, remaining, max: FREE_MONTHLY_LIMIT });
  } else {
    // ---- GUEST: resolve fingerprint (with IP aliasing) ----
    const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
    const fingerprint = req.body?.deviceFingerprint || req.query?.fp || null;
    console.log("[/api/user?action=scans-remaining] Guest request. IP:", ip, "| FP:", fingerprint || "(none)");

    let effectiveFingerprint = fingerprint || null;
    if (fingerprint) {
      const { effectiveFingerprint: resolved } = await resolveGuestFingerprint(admin, fingerprint, ip);
      effectiveFingerprint = resolved;
    }

    // Server-authoritative: always read from device_usage_logs (fingerprint-based)
    // or fall back to guest_usage (IP-based) for legacy clients without FP.
    let used = 0;
    let max = FREE_MONTHLY_LIMIT;

    if (effectiveFingerprint) {
      // Use fingerprint-based tracking
      const { data: logRow } = await admin
        .from("device_usage_logs")
        .select("scans_used_this_month, scans_reset_at")
        .eq("device_fingerprint", effectiveFingerprint)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (logRow) {
        const resetAt = new Date(logRow.scans_reset_at);
        const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
        used = needsReset ? 0 : logRow.scans_used_this_month;
      }
    } else {
      // Fallback: IP-based (legacy) — still works but less reliable
      const { data: row } = await admin.from("guest_usage").select("*").eq("ip_address", ip).single();
      if (row) {
        const resetAt = new Date(row.scans_reset_at);
        const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
        used = needsReset ? 0 : row.scans_used_this_month;
      }
    }

    // Fair Use rate limit check for guests
    const guestPlan = "free";
    const guestFairUse = checkFairUseRateLimit("guest:" + ip, guestPlan, max, used);

    const remaining = Math.max(0, max - used);
    return res.status(200).json({ unlimited: false, remaining, max });
  }
}

function buildComparePrompt(
  productA: string,
  productB: string,
  priceA: number,
  priceB: number,
  currency: string,
  fairA: FairPriceRange,
  fairB: FairPriceRange
) {
  return `You are a purchase-decision analyst. You are given two products, each with the price the customer was offered AND the real current fair-market price range for that exact product (already researched — do not search again, use these numbers as ground truth). Produce a structured JSON comparison.

PRODUCT A: ${productA} — offered price ${priceA} ${currency}
MARKET FAIR PRICE FOR A: min ${fairA.min ?? "null"}, max ${fairA.max ?? "null"}, mid ${fairA.mid ?? "null"}

PRODUCT B: ${productB} — offered price ${priceB} ${currency}
MARKET FAIR PRICE FOR B: min ${fairB.min ?? "null"}, max ${fairB.max ?? "null"}, mid ${fairB.mid ?? "null"}

Return a JSON object with EXACTLY this shape (all text fields must have both "ar" and "en" versions, natural fluent Arabic and English — not machine-translated):

{
  "rows": [
    { "category": {"ar":string,"en":string}, "valueA": {"ar":string,"en":string}, "valueB": {"ar":string,"en":string}, "winner": "A" | "B" | "tie" }
  ],
  "finalRecommendation": { "ar": string, "en": string },
  "resaleValueA": number,
  "resaleValueB": number,
  "resaleValueTimeframe": "1year",
  "warrantyScoreA": number,
  "warrantyScoreB": number
}

Rules:
- Include at least 6 comparison rows covering: price value, build/quality, performance, future compatibility/longevity, resale value potential, warranty/service availability, and overall value for money.
- "winner" must be based on real researched facts about these specific products, never random.
- For the price-value row specifically: judge by how close each offered price is to ITS OWN fair market range (value), never by which raw number is smaller. A product offered above its own fair range is a worse deal than a pricier product offered right at (or below) its own fair range — reflect that in the winner and in valueA/valueB text (mention the gap vs. the fair range, not just the price).
- finalRecommendation must weigh both the researched facts and how each offered price compares to its own fair market range (not simply which number is lower).
- resaleValueA/B: Estimate what each product will be worth in 1 year (as a percentage of current price, e.g., 65 means 65% of current price). Base this on brand reputation and market demand.
- warrantyScoreA/B: Rate warranty availability and service center accessibility on a scale of 1-10 (10 = excellent warranty + many service centers, 1 = no warranty + hard to find service).
- Return ONLY the JSON object, nothing else.`;
}

async function handleChatRemaining(req: VercelRequest, res: VercelResponse) {
  // Advisor-mode chat only — this is what InputScreen shows before the
  // first message is sent, mirroring scans-remaining. Report-mode chat
  // stays a flat 20-per-report constant on the frontend (see item 3 —
  // ReportScreen.tsx), so it needs no pre-fetch endpoint.
  const admin = getSupabaseAdmin();
  const user = await getAuthedUser(req);
  const now = new Date();

  if (user) {
    const { data: row } = await admin
      .from("users")
      .select("tier, subscription_end_date, premium_chat_used_this_month, premium_chat_reset_at, chat_messages_limit")
      .eq("id", user.id)
      .single();

    if (!row) {
      return res.status(404).json({ error: "user_not_found" });
    }

    let tier: "free" | "premium" = row.tier;
    if (tier === "premium" && row.subscription_end_date && new Date(row.subscription_end_date) < now) {
      tier = "free";
    }

    if (tier === "premium") {
      const used = row.premium_chat_used_this_month || 0;
      const max = row.chat_messages_limit ?? DEFAULT_PREMIUM_LIMITS.chatMessages;
      return res.status(200).json({ remaining: Math.max(0, max - used), max });
    }
  }

  // Free / guest: same identity scheme as api/ask.ts (user:id or ip:x)
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
  const max = FREE_TIER_LIMITS.chatMessages;

  return res.status(200).json({ remaining: Math.max(0, max - used), max });
}

async function handleComparesRemaining(req: VercelRequest, res: VercelResponse) {
  const admin = getSupabaseAdmin();
  const user = await getAuthedUser(req);

  // Compare is premium-only — no guest/free path, matching handleCompare's
  // own auth_required / premium_required checks.
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }

  const { data: userRow, error: userErr } = await admin
    .from("users")
    .select("tier, subscription_end_date, compares_used_this_month, compares_reset_at, compares_limit_this_month")
    .eq("id", user.id)
    .single();

  if (userErr || !userRow) {
    return res.status(404).json({ error: "user_not_found" });
  }

  const now = new Date();
  let tier: "free" | "premium" = userRow.tier;
  if (tier === "premium" && userRow.subscription_end_date && new Date(userRow.subscription_end_date) < now) {
    tier = "free";
  }

  if (tier !== "premium") {
    return res.status(403).json({ error: "premium_required" });
  }

  const resetAt = new Date(userRow.compares_reset_at);
  const needsReset = now.getUTCFullYear() !== resetAt.getUTCFullYear() || now.getUTCMonth() !== resetAt.getUTCMonth();
  const used = needsReset ? 0 : userRow.compares_used_this_month;

  // Same ?? fix as item 1 — a plan with 0 compares (small_bundle) must stay 0,
  // not fall back to DEFAULT_COMPARE_LIMIT just because 0 is falsy.
  const max = userRow.compares_limit_this_month ?? DEFAULT_COMPARE_LIMIT;
  const remaining = Math.max(0, max - used);

  return res.status(200).json({ remaining, max });
}

async function handleCompare(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  logEnvPresence({
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  const { productA, productB, priceA, priceB, currency } = req.body || {};

  if (
    !productA || typeof productA !== "string" ||
    !productB || typeof productB !== "string" ||
    !priceA || Number(priceA) <= 0 ||
    !priceB || Number(priceB) <= 0
  ) {
    return res.status(400).json({ error: "invalid_input" });
  }

  const admin = getSupabaseAdmin();
  const user = await getAuthedUser(req);

  // Compare Products is a Premium-only feature (Section 15) — enforce
  // server-side too, never trust the client-side gate alone.
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }

  const { data: userRow, error: userErr } = await admin
    .from("users")
    .select("tier, subscription_end_date, compares_used_this_month, compares_reset_at, compares_limit_this_month")
    .eq("id", user.id)
    .single();

  if (userErr || !userRow) {
    return res.status(404).json({ error: "user_not_found" });
  }

  const now = new Date();
  let tier: "free" | "premium" = userRow.tier;
  if (tier === "premium" && userRow.subscription_end_date && new Date(userRow.subscription_end_date) < now) {
    tier = "free";
    await admin.from("users").update({ tier: "free" }).eq("id", user.id);
  }

  if (tier !== "premium") {
    return res.status(403).json({ error: "premium_required" });
  }

  // Premium compares balance never resets automatically by calendar date —
  // only a paid renewal (admin approval) refills it. This endpoint is
  // premium-only past the check above, so there is no free-tier case here.
  // Section 15: Use dynamic limit from user row (stored when plan was activated)
  const comparesLimit = userRow.compares_limit_this_month ?? DEFAULT_COMPARE_LIMIT;

  // ---- Race-safe: atomic check-and-reserve BEFORE the paid AI call ----
  // (see supabase-atomic-quota-migration.sql / increment_user_compares) —
  // closes the same race window analyze.ts had: concurrent requests can no
  // longer all read "still under limit" before any of them writes back.
  const { data: reserved, error: reserveErr } = await admin.rpc("increment_user_compares", {
    p_user_id: user.id,
    p_limit: comparesLimit,
  });
  if (reserveErr) {
    console.error("[/api/user?action=compare] increment_user_compares RPC failed:", reserveErr);
    return res.status(500).json({ error: "server_error" });
  }
  if (!reserved) {
    return res.status(403).json({ error: "compare_limit_reached", remaining: 0, max: comparesLimit });
  }

  // ---- Item 8 fix: real per-product fair market price, searched separately ----
  // The old buildComparePrompt asked the AI to "research" both products in one
  // shared call with no pre-fetched pricing signal of its own, and relied on
  // extractProductName()'s `PRODUCT:` regex to pull a search term out of the
  // prompt — but this prompt only ever contained "PRODUCT A:"/"PRODUCT B:",
  // which never matched, so the search term was empty and no real fair price
  // ever backed the comparison. Reuse the exact same getFairPriceRange
  // pipeline analyze.ts uses for a single product, once per product here.
  const reqCurrency = currency || "EGP";
  const [fairA, fairB]: [FairPriceRange, FairPriceRange] = await Promise.all([
    getFairPriceRange(productA, reqCurrency, "new", ""),
    getFairPriceRange(productB, reqCurrency, "new", ""),
  ]);
  console.log("[/api/user?action=compare] Fair price A:", fairA.min, "-", fairA.max, "| B:", fairB.min, "-", fairB.max);

  const prompt = buildComparePrompt(productA, productB, Number(priceA), Number(priceB), currency || "EGP", fairA, fairB);

  let aiResult;
  try {
    logStep("Calling AI pipeline (Groq) for comparison (search already done per-product above)...");
    aiResult = await callAiWithFallback(prompt, undefined, false);
  } catch (e: any) {
    console.error("[/api/user?action=compare] AI pipeline failed (both primary and fallback exhausted):", e, e?.stack);
    // Give the reserved slot back — never charge quota for a failed comparison.
    await admin.from("users").select("compares_used_this_month").eq("id", user.id).single().then(({ data }) => {
      if (data) return admin.from("users").update({ compares_used_this_month: Math.max(0, data.compares_used_this_month - 1) }).eq("id", user.id);
    });
    return res.status(502).json({ error: "comparison_failed", reason: e?.message });
  }

  const parsed = aiResult.data;
  if (!Array.isArray(parsed?.rows) || !parsed?.finalRecommendation) {
    console.error("[/api/user?action=compare] AI response failed shape validation. parsed:", JSON.stringify(parsed)?.slice(0, 2000));
    const { data: revertRow } = await admin.from("users").select("compares_used_this_month").eq("id", user.id).single();
    if (revertRow) {
      await admin.from("users").update({ compares_used_this_month: Math.max(0, revertRow.compares_used_this_month - 1) }).eq("id", user.id);
    }
    return res.status(502).json({ error: "comparison_invalid" });
  }

  const resaleValueA = typeof parsed.resaleValueA === "number" && parsed.resaleValueA > 0 ? Math.min(100, Math.max(0, parsed.resaleValueA)) : 50;
  const resaleValueB = typeof parsed.resaleValueB === "number" && parsed.resaleValueB > 0 ? Math.min(100, Math.max(0, parsed.resaleValueB)) : 50;
  const warrantyScoreA = typeof parsed.warrantyScoreA === "number" ? Math.min(10, Math.max(1, parsed.warrantyScoreA)) : 5;
  const warrantyScoreB = typeof parsed.warrantyScoreB === "number" ? Math.min(10, Math.max(1, parsed.warrantyScoreB)) : 5;

  await logAiUsage(admin, {
    endpoint: "compare",
    model: aiResult.modelUsed,
    tier: "premium",
    userId: user.id,
    usage: aiResult.usage,
  });

  // Usage was already reserved atomically before the AI call above (the
  // RPC's `reserved === true` guarantees exactly one increment happened) —
  // nothing left to record here, just reflect it for the response.
  const newComparesUsed = (userRow.compares_used_this_month ?? 0) + 1;

  const result = {
    productA,
    productB,
    priceA: Number(priceA),
    priceB: Number(priceB),
    currency: currency || "EGP",
    rows: parsed.rows,
    finalRecommendation: parsed.finalRecommendation,
    resaleValueA,
    resaleValueB,
    resaleValueTimeframe: "1year",
    warrantyScoreA,
    warrantyScoreB,
    marketFairPriceMinA: fairA.min,
    marketFairPriceMaxA: fairA.max,
    marketFairPriceMinB: fairB.min,
    marketFairPriceMaxB: fairB.max,
    remaining: Math.max(0, comparesLimit - newComparesUsed),
    max: comparesLimit,
  };

  // ---- Section 15: Save comparison to history (Comparison History) ----
  // Persist the comparison result so the user can revisit it later.
  // This runs after a successful comparison — never blocks the response
  // (fire-and-forget via Promise, but awaited for correctness).
  try {
    await admin.from("comparison_history").insert({
      user_id: user.id,
      product_a: productA,
      product_b: productB,
      price_a: Number(priceA),
      price_b: Number(priceB),
      currency: currency || "EGP",
      rows: parsed.rows,
      final_recommendation: parsed.finalRecommendation,
      resale_value_a: resaleValueA,
      resale_value_b: resaleValueB,
      warranty_score_a: warrantyScoreA,
      warranty_score_b: warrantyScoreB,
    });
    console.log("[comparison_history] Saved successfully for user:", user.id);
  } catch (dbErr) {
    // Never fail the user response if history save fails — just log it
    console.error("[comparison_history] Failed to save history:", dbErr);
  }

  return res.status(200).json(result);
}

async function handleSubscribe(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const user = await getAuthedUser(req);
  if (!user) {
    return res.status(401).json({ error: "auth_required" });
  }

  const { plan, screenshotUrl } = req.body || {};
  const amount = PLAN_PRICES[plan];

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "invalid_plan" });
  }
  if (!screenshotUrl || typeof screenshotUrl !== "string") {
    return res.status(400).json({ error: "missing_screenshot" });
  }
  // The service-role client bypasses storage RLS entirely, so we must check
  // ownership ourselves — otherwise a crafted request could point at another
  // user's uploaded screenshot path instead of the caller's own.
  if (!screenshotUrl.startsWith(`${user.id}/`)) {
    console.warn("[/api/user?action=subscribe] screenshotUrl does not belong to caller:", user.id, screenshotUrl);
    return res.status(403).json({ error: "invalid_screenshot_path" });
  }

  const admin = getSupabaseAdmin();

  // ---- Item 7: block requesting a new plan while one is already active ----
  // Nothing previously stopped a premium user from firing off another
  // subscribe request (and potentially getting double-charged / stacking
  // plans) before their current one expires.
  //
  // NOTE: this app has no subscription_end_date in practice — approve.ts
  // always sets it to null (quotas are monthly-usage-based, not date-based).
  // The old check (`!subscription_end_date || end_date >= now`) was true
  // for every premium user forever, so nobody could ever submit a renewal
  // request once their plan ran out — a permanent dead end. Gate on actual
  // remaining quota instead: block only while they still have scans left
  // on the plan they already paid for.
  const { data: activeCheck } = await admin
    .from("users")
    .select("tier, scans_used_this_month, scans_limit_this_month")
    .eq("id", user.id)
    .single();
  const scansRemaining = activeCheck
    ? (activeCheck.scans_limit_this_month ?? DEFAULT_PREMIUM_LIMITS.scans) - (activeCheck.scans_used_this_month ?? 0)
    : 0;
  const stillActive = activeCheck?.tier === "premium" && scansRemaining > 0;
  if (stillActive) {
    return res.status(409).json({
      error: "already_subscribed",
      message: "لسه عندك تحليلات فاضلة في باقتك الحالية. مينفعش تفعّل باقة جديدة إلا بعد ما تخلصها.",
    });
  }

  // ---- Fraud-reduction pre-check (never a replacement for manual review) ----
  // 1. Get a short-lived signed URL for the just-uploaded screenshot so the
  //    vision model can actually see it (the "screenshots" bucket is
  //    private — same pattern api/admin.ts already uses to show it to
  //    admins).
  // 2. Ask the AI whether it actually looks like a payment receipt. This
  //    used to hard-block the upload when the AI said no — but the vision
  //    check isn't reliable enough to gate a paying customer on: a blurry
  //    photo, an unusual bank-app layout, or a bad crop could all get a
  //    false "not a receipt" with no way for the customer to override it.
  //    Now it only FLAGS the request for closer manual review instead of
  //    rejecting it outright — every upload still reaches an admin.
  // 3. Extract the printed reference number and block re-use of the exact
  //    same real receipt across multiple requests — this one stays a hard
  //    block because it's actual evidence (a duplicate reference number),
  //    not a guess, and a genuine receipt image will always pass it.
  let extractedReference: string | null = null;
  let extractedAmount: number | null = null;
  let aiFlagged = false;
  let aiFlagReason: string | null = null;
  try {
    const { data: signed } = await admin.storage.from("screenshots").createSignedUrl(screenshotUrl, 300);
    if (signed?.signedUrl) {
      const check = await verifyPaymentScreenshot(signed.signedUrl);
      extractedReference = check.referenceNumber;
      extractedAmount = check.amount;

      if (!check.looksLikeReceipt) {
        console.warn("[/api/user?action=subscribe] AI check: not confident this is a receipt — flagging for review, not blocking. User:", user.id);
        aiFlagged = true;
        aiFlagReason = "AI couldn't confirm this looks like a payment receipt — needs a closer manual look.";
      }

      if (extractedReference) {
        const { data: dup } = await admin
          .from("subscription_requests")
          .select("id, user_id")
          .eq("extracted_reference", extractedReference)
          .limit(1)
          .maybeSingle();
        if (dup) {
          console.warn(
            "[/api/user?action=subscribe] Duplicate reference number:",
            extractedReference,
            "| new user:",
            user.id,
            "| original request user:",
            dup.user_id
          );
          return res.status(409).json({
            error: "duplicate_receipt",
            message: "رقم المرجع في الإيصال ده اتسجل قبل كده مع طلب اشتراك تاني. لو الإيصال ده جديد فعلاً تواصل معانا مباشرة.",
          });
        }
      }
    }
  } catch (checkErr) {
    // Never block a legitimate subscriber over an AI-check failure — just
    // log it and fall through to the normal manual-review flow.
    console.error("[/api/user?action=subscribe] Screenshot pre-check failed (continuing):", (checkErr as any)?.message);
  }

  const { data, error } = await admin
    .from("subscription_requests")
    .insert({
      user_id: user.id,
      plan,
      amount,
      screenshot_url: screenshotUrl,
      status: "pending_review",
      extracted_reference: extractedReference,
      extracted_amount: extractedAmount,
      ai_flagged: aiFlagged,
      ai_flag_reason: aiFlagReason,
    })
    .select()
    .single();

  if (error || !data) {
    // Postgres unique_violation — the DB-level index (see
    // supabase-subscription-fraud-check-migration.sql) caught a duplicate
    // reference number that raced past the app-level check above.
    if ((error as any)?.code === "23505") {
      console.warn("[/api/user?action=subscribe] Duplicate reference caught at DB level. User:", user.id);
      return res.status(409).json({
        error: "duplicate_receipt",
        message: "رقم المرجع في الإيصال ده اتسجل قبل كده مع طلب اشتراك تاني. لو الإيصال ده جديد فعلاً تواصل معانا مباشرة.",
      });
    }
    console.error("[/api/user?action=subscribe] insert failed:", error);
    return res.status(500).json({ error: "server_error" });
  }

  const mismatchNote =
    extractedAmount !== null && extractedAmount !== amount
      ? `\n⚠️ AI extracted amount (${extractedAmount} EGP) doesn't match plan price (${amount} EGP) — double-check.`
      : "";
  const aiFlagNote = aiFlagged ? `\n🚩 AI wasn't confident this is a receipt — please look closely before approving.` : "";

  await sendTelegramAlert(
    `💰 <b>New subscription request</b>\nUser: ${user.email}\nPlan: ${plan}\nAmount: ${amount} EGP\nRef #: ${extractedReference || "(not detected)"}\nScreenshot: ${screenshotUrl}${mismatchNote}${aiFlagNote}`
  );

  return res.status(200).json({ success: true, requestId: data.id });
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
      case "scans-remaining":
        result = await handleScansRemaining(req, res);
        break;
      case "chat-remaining":
        result = await handleChatRemaining(req, res);
        break;
      case "compares-remaining":
        result = await handleComparesRemaining(req, res);
        break;
      case "compare":
        result = await handleCompare(req, res);
        break;
      case "subscribe":
        result = await handleSubscribe(req, res);
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
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
