import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { callAiWithFallback } from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";
import { FREE_TIER_LIMITS, DEFAULT_PREMIUM_LIMITS } from "./_planConfig.js";

// Hard cap on how many chat questions can be asked per analysis (Free/guest
// tier only — Premium uses dynamic limit from user row). Each
// question is a Groq call WITHOUT a Tavily search (unlike the main
// analysis) — plain reasoning over the existing report context only —
// so the per-message cost is low enough to allow a much higher cap.
const MAX_CHAT_MESSAGES_PER_REPORT = 20;

// Section 15: Free tier advisor chat limit from centralized config
const MAX_ADVISOR_MESSAGES_PER_MONTH_FREE = FREE_TIER_LIMITS.chatMessages;

// Section 15: Default premium chat limit (used as fallback if user row doesn't have dynamic limit)
const DEFAULT_PREMIUM_CHAT_MONTHLY_LIMIT = DEFAULT_PREMIUM_LIMITS.chatMessages;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

interface UserInterests {
  categories: string[];
  recentSearches: string[];
  favoriteProducts: string[];
}

function buildAdvisorPrompt(opts: {
  question: string;
  history: ChatTurn[];
  language: "ar" | "en";
  userInterests?: UserInterests;
}) {
  const { question, history, language, userInterests } = opts;
  const languageInstruction = language === "ar" ? "أجب بالعربية الطبيعية الودية." : "Answer in natural, friendly English.";

  let interestContext = "";
  if (userInterests?.categories?.length) {
    interestContext = `\nYour shopping interests: ${userInterests.categories.join(", ")}\nRecent searches: ${userInterests.recentSearches.join(", ")}`;
  }

  const historyBlock = history.map((m) => `${m.role === "user" ? "You" : "Me"}: ${m.content}`).join("\n");

  return `You are a friendly, expert shopping advisor (like a personal shopping consultant). Help users make smart purchase decisions by:
1. Understanding their budget and needs
2. Suggesting real products with realistic prices
3. Comparing options fairly
4. Proactively warning about common pitfalls
5. Remembering their past interests

IMPORTANT: Always be proactive. After answering the user's question, proactively add one helpful suggestion at the end using these patterns:
- If they ask about a specific model: "الموديل اللي بتسأل عليه ده نزل منه نسخة أحدث، تحب أقارنلك؟" or "This model has a newer version available, want me to compare?"
- If they mention a price: "في نفس النطاق ده فيه خيارات تانية ممكن تكون أفضل، تحب أقولك؟"
- If they compare products: mention pros/cons and battery life or common issues proactively

${interestContext}

CONVERSATION HISTORY:
${historyBlock || "(New conversation)"}

USER'S QUESTION: ${question}

${languageInstruction} Be conversational, warm, and helpful. Keep answers to 3-5 sentences. If you suggest products, mention realistic price ranges. Always end with a helpful proactive tip or suggestion.

ADDITIONAL: If the user's question includes a specific budget/amount AND asks for a product recommendation (phone, laptop, camera, etc.), also return a "productSuggestions" field with 2-3 real products that actually exist in the market — an accurate name/model, an approximate price in the currency implied by the question, and a short reason why it fits their budget and use case. If the question is not a budget-based product recommendation, return "productSuggestions": [] (empty).

Return a JSON object with EXACTLY this shape and nothing else:
{
  "answer": string,
  "productSuggestions": [
    { "name": string, "approxPrice": string, "reason": string }
  ]
}`;
}

function buildChatPrompt(opts: {
  product: string;
  offeredPrice: number;
  currency: string;
  verdict: string;
  marketFairPriceMin: number;
  marketFairPriceMax: number;
  history: ChatTurn[];
  question: string;
  language: "ar" | "en";
}) {
  const { product, offeredPrice, currency, verdict, marketFairPriceMin, marketFairPriceMax, history, question, language } = opts;

  // Cost-saving: send only the base product context + the single last
  // assistant reply, not the full conversation history. The model doesn't
  // need every prior turn to answer a short follow-up — just the last thing
  // it said (for continuity) plus the fixed analysis context above.
  const lastAssistantTurn = [...history].reverse().find((m) => m.role === "assistant");
  const historyBlock = lastAssistantTurn ? `Assistant: ${lastAssistantTurn.content}` : "";

  const languageInstruction = language === "ar" ? "Answer in natural, fluent Arabic (Egyptian-friendly)." : "Answer in natural, fluent English.";

  return `You are a helpful purchase-decision assistant answering a short follow-up question about an analysis the user already received. Base your answer on the analysis context and conversation below only — you do not have live web/search access for this chat, so don't claim to look anything up; answer from the given facts and general knowledge.

ANALYSIS CONTEXT:
- Product: ${product}
- Offered price: ${offeredPrice} ${currency}
- Verdict: ${verdict}
- Fair market range: ${marketFairPriceMin}-${marketFairPriceMax} ${currency}

${historyBlock ? `LAST REPLY:\n${historyBlock}\n` : ""}
NEW QUESTION: ${question}

${languageInstruction} Keep the answer short and conversational — 2-4 sentences, no headers or markdown.

Return a JSON object with EXACTLY this shape and nothing else:
{ "answer": string }`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const start = Date.now();
  logRequestStart(req);
  logEnvPresence({
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  if (req.method !== "POST") {
    console.warn("[/api/ask] Rejected non-POST method:", req.method);
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // ---- Race-safe quota reservation (declared outside try/catch so the
  // catch block can release a reservation if anything throws) ----
  // See supabase-atomic-quota-migration.sql — same fix as analyze.ts/compare:
  // the slot is claimed atomically BEFORE the paid AI call, not after it,
  // so concurrent requests can't all read the same "still under limit"
  // snapshot and all slip through.
  const adminForRelease = getSupabaseAdmin();
  let chatReservation:
    | { kind: "premiumChat"; userId: string }
    | { kind: "advisor"; identity: string }
    | { kind: "report"; reportId: string; identity: string }
    | null = null;

  async function releaseChatReservation() {
    if (!chatReservation) return;
    try {
      if (chatReservation.kind === "premiumChat") {
        const { data } = await adminForRelease.from("users").select("premium_chat_used_this_month").eq("id", chatReservation.userId).single();
        if (data) {
          await adminForRelease.from("users").update({ premium_chat_used_this_month: Math.max(0, data.premium_chat_used_this_month - 1) }).eq("id", chatReservation.userId);
        }
      } else if (chatReservation.kind === "advisor") {
        const { data } = await adminForRelease.from("advisor_usage").select("messages_used").eq("identity", chatReservation.identity).single();
        if (data) {
          await adminForRelease.from("advisor_usage").update({ messages_used: Math.max(0, data.messages_used - 1) }).eq("identity", chatReservation.identity);
        }
      } else if (chatReservation.kind === "report") {
        const { data } = await adminForRelease.from("chat_usage").select("messages_used").eq("report_id", chatReservation.reportId).eq("identity", chatReservation.identity).single();
        if (data) {
          await adminForRelease.from("chat_usage").update({ messages_used: Math.max(0, data.messages_used - 1) }).eq("report_id", chatReservation.reportId).eq("identity", chatReservation.identity);
        }
      }
    } catch (releaseErr) {
      console.error("[/api/ask] Failed to release chat reservation (non-fatal):", releaseErr);
    }
  }

  try {
    const {
      reportId,
      product,
      offeredPrice,
      currency,
      verdict,
      marketFairPriceMin,
      marketFairPriceMax,
      question,
      history = [],
      language = "ar",
      mode = "report", // "report" for analysis chat, "advisor" for open shopping questions
    } = req.body || {};

    console.log("[/api/ask] Validating input...");
    if (!question || typeof question !== "string" || !question.trim()) {
      console.warn("[/api/ask] Invalid input (question):", { question });
      return res.status(400).json({ error: "invalid_input" });
    }

    // Mode validation: "report" requires reportId, "advisor" is open-form
    if (mode === "report") {
      if (!reportId || typeof reportId !== "string") {
        console.warn("[/api/ask] Invalid input (reportId required for report mode):", { reportId });
        return res.status(400).json({ error: "invalid_input" });
      }
      if (!product || typeof product !== "string" || typeof offeredPrice !== "number") {
        console.warn("[/api/ask] Invalid input (product/offeredPrice):", { product, offeredPrice });
        return res.status(400).json({ error: "invalid_input" });
      }
    }
    console.log("[/api/ask] Input OK. mode:", mode, "| question:", question.slice(0, 50));

    console.log("Checking authentication...");
    const admin = getSupabaseAdmin();
    const user = await getAuthedUser(req);
    console.log("Authentication OK. Signed in:", !!user, user ? `(userId: ${user.id})` : "(guest)");

    // Advisor mode now works for guests too — quota is tracked by IP-based
    // identity below, same as report-mode chat. Smart-memory (remembering
    // interests) still only applies to signed-in users, further down.

    const identity = user
      ? `user:${user.id}`
      : `ip:${(req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown"}`;

    // Real tier, resolved BEFORE loading usage — Premium tracks a single
    // shared monthly counter (PREMIUM_CHAT_MONTHLY_LIMIT, covering BOTH chat
    // modes combined), while Free/guest keep their existing per-mode caps.
    let tier: "free" | "premium" | "guest" = "guest";
    if (user) {
      const { data: userRow } = await admin
        .from("users")
        .select("tier, subscription_end_date")
        .eq("id", user.id)
        .single();
      let effectiveTier = userRow?.tier || "free";
      if (effectiveTier === "premium" && userRow?.subscription_end_date && new Date(userRow.subscription_end_date) < new Date()) {
        effectiveTier = "free";
        await admin.from("users").update({ tier: "free" }).eq("id", user.id);
      }
      tier = effectiveTier as "free" | "premium";
    }

    const isPremiumTier = tier === "premium";
    let maxMessages = mode === "advisor" ? MAX_ADVISOR_MESSAGES_PER_MONTH_FREE : MAX_CHAT_MESSAGES_PER_REPORT;

    // ---- Race-safe: atomic check-and-reserve BEFORE the paid AI call ----
    // Each branch below claims its slot via a single row-locked Postgres
    // function (see supabase-atomic-quota-migration.sql), so concurrent
    // requests from the same identity can no longer all read the same
    // "still under limit" snapshot and all slip through.
    if (isPremiumTier && mode === "advisor") {
      // Section 15 (fixed): advisor-mode monthly counter, using the REAL
      // per-plan limit stored on the user row at activation time — not the
      // constant DEFAULT_PREMIUM_CHAT_MONTHLY_LIMIT, which was silently
      // giving every premium plan the same 80/month regardless of what
      // they actually paid for. report-mode chat is handled separately
      // below and never touches this counter, for any tier.
      const { data: premiumRow } = await admin
        .from("users")
        .select("chat_messages_limit")
        .eq("id", user!.id)
        .single();
      maxMessages = premiumRow?.chat_messages_limit ?? DEFAULT_PREMIUM_CHAT_MONTHLY_LIMIT;

      const { data: reserved, error: reserveErr } = await admin.rpc("increment_premium_chat", {
        p_user_id: user!.id,
        p_limit: maxMessages,
      });
      if (reserveErr) {
        console.error("[/api/ask] increment_premium_chat RPC failed:", reserveErr);
        return res.status(500).json({ error: "server_error" });
      }
      if (!reserved) {
        console.warn("[/api/ask] Chat message limit reached. identity:", identity, "| mode:", mode, "| tier:", tier);
        return res.status(403).json({ error: "chat_limit_reached", remaining: 0, max: maxMessages });
      }
      chatReservation = { kind: "premiumChat", userId: user!.id };
    } else if (mode === "advisor") {
      // Open advisor mode (Free/guest): track monthly usage per user/IP
      const { data: reserved, error: reserveErr } = await admin.rpc("increment_advisor_usage", {
        p_identity: identity,
        p_limit: maxMessages,
      });
      if (reserveErr) {
        console.error("[/api/ask] increment_advisor_usage RPC failed:", reserveErr);
        return res.status(500).json({ error: "server_error" });
      }
      if (!reserved) {
        console.warn("[/api/ask] Chat message limit reached. identity:", identity, "| mode:", mode, "| tier:", tier);
        return res.status(403).json({ error: "chat_limit_reached", remaining: 0, max: maxMessages });
      }
      chatReservation = { kind: "advisor", identity };
    } else {
      // Report mode: ALWAYS a fixed 20 messages per report_id, for every
      // tier including premium — this used to let premium share its
      // monthly advisor counter here instead, which was wrong on two
      // counts (mixed two different quotas together, and per-report chat
      // should never have a monthly cap at all). Tracked in chat_usage,
      // same table/shape Free already used.
      const { data: reserved, error: reserveErr } = await admin.rpc("increment_chat_usage", {
        p_report_id: reportId,
        p_identity: identity,
        p_limit: maxMessages,
      });
      if (reserveErr) {
        console.error("[/api/ask] increment_chat_usage RPC failed:", reserveErr);
        return res.status(500).json({ error: "server_error" });
      }
      if (!reserved) {
        console.warn("[/api/ask] Chat message limit reached. identity:", identity, "| mode:", mode, "| tier:", tier);
        return res.status(403).json({ error: "chat_limit_reached", remaining: 0, max: maxMessages });
      }
      chatReservation = { kind: "report", reportId, identity };
    }

    let prompt: string;

    if (mode === "advisor") {
      // Fetch user interests if available
      let userInterests: UserInterests | undefined;
      if (user) {
        const { data: interestsRow } = await admin
          .from("user_interests")
          .select("categories, recent_searches, favorite_products")
          .eq("user_id", user.id)
          .single();
        if (interestsRow) {
          userInterests = {
            categories: interestsRow.categories || [],
            recentSearches: interestsRow.recent_searches || [],
            favoriteProducts: interestsRow.favorite_products || [],
          };
        }
      }

      prompt = buildAdvisorPrompt({
        question: question.trim(),
        history: Array.isArray(history) ? history : [],
        language: language === "en" ? "en" : "ar",
        userInterests,
      });
    } else {
      // Report mode: use existing chat prompt
      prompt = buildChatPrompt({
        product,
        offeredPrice: Number(offeredPrice),
        currency: currency || "EGP",
        verdict: verdict || "fair",
        marketFairPriceMin: Number(marketFairPriceMin) || 0,
        marketFairPriceMax: Number(marketFairPriceMax) || 0,
        history: Array.isArray(history) ? history : [],
        question: question.trim(),
        language: language === "en" ? "en" : "ar",
      });
    }

    let aiResult;
    try {
      logStep("Calling AI pipeline (Groq, no search) for chat answer...");
      aiResult = await callAiWithFallback(prompt, undefined, false);
      console.log("[/api/ask] AI pipeline succeeded. modelUsed:", aiResult.modelUsed, "| usage:", aiResult.usage);
    } catch (e: any) {
      console.error("[/api/ask] AI pipeline failed (both primary and fallback exhausted):");
      console.error(e);
      console.error(e?.stack);
      await releaseChatReservation();
      return res.status(502).json({ error: "ask_failed", reason: e?.message });
    }

    const answer = aiResult.data?.answer;
    if (typeof answer !== "string" || !answer.trim()) {
      console.error("[/api/ask] AI response failed shape validation. data:", JSON.stringify(aiResult.data)?.slice(0, 2000));
      await releaseChatReservation();
      return res.status(502).json({ error: "ask_invalid" });
    }

    // Section 9: budget-based product suggestions — advisor mode only.
    // Groq general-knowledge output (no Serper call), so validate shape
    // defensively and default to an empty array on anything unexpected.
    let productSuggestions: { name: string; approxPrice: string; reason: string }[] = [];
    if (mode === "advisor" && Array.isArray(aiResult.data?.productSuggestions)) {
      productSuggestions = aiResult.data.productSuggestions
        .filter((s: any) => s && typeof s.name === "string" && typeof s.approxPrice === "string" && typeof s.reason === "string")
        .slice(0, 3);
    }

    // Section 25: log every real Groq call, same as /api/analyze and /api/compare.
    console.log("Saving database...");
    await logAiUsage(admin, {
      endpoint: "ask",
      model: aiResult.modelUsed,
      tier,
      userId: user?.id || null,
      usage: aiResult.usage,
    });

    // Usage was already reserved atomically before the AI call above —
    // nothing left to record here. Just read back the current count for
    // the "remaining" figure in the response below.
    let newUsed = maxMessages;
    if (chatReservation?.kind === "premiumChat") {
      const { data } = await admin.from("users").select("premium_chat_used_this_month").eq("id", chatReservation.userId).single();
      newUsed = data?.premium_chat_used_this_month ?? maxMessages;
    } else if (chatReservation?.kind === "advisor") {
      const { data } = await admin.from("advisor_usage").select("messages_used").eq("identity", chatReservation.identity).single();
      newUsed = data?.messages_used ?? maxMessages;
    } else if (chatReservation?.kind === "report") {
      const { data } = await admin.from("chat_usage").select("messages_used").eq("report_id", chatReservation.reportId).eq("identity", chatReservation.identity).single();
      newUsed = data?.messages_used ?? maxMessages;
    }

    // Smart Memory System: update user interests after each advisor interaction
    // (any tier — this is independent of which usage counter was bumped above).
    if (mode === "advisor" && user) {
      try {
          // Extract product mentions from the user's question for smart memory
          const questionLower = question.toLowerCase();
          const productKeywords = [
            "موبايل", "iphone", "samsung", "xiaomi", "هاتف", "mobile", "phone",
            "لابتوب", "laptop", "كمبيوتر", "computer", "macbook",
            "سماعات", "headphone", "airpods", "earbuds",
            "تلفزيون", "tv", "شاشة", "monitor",
            "كاميرا", "camera",
            "ساعة", "watch", "apple watch",
            "تابلت", "tablet", "ipad",
            "جهاز", "device",
          ];
          const detectedCategories = productKeywords.filter((kw) =>
            questionLower.includes(kw)
          );

          if (detectedCategories.length > 0) {
            const { data: existingInterests } = await admin
              .from("user_interests")
              .select("categories, recent_searches")
              .eq("user_id", user.id)
              .single();

            if (existingInterests) {
              // Merge new categories with existing ones
              const existingCats = existingInterests.categories || [];
              const newCats = [...new Set([...existingCats, ...detectedCategories])];

              // Add to recent searches
              const existingSearches = existingInterests.recent_searches || [];
              const newSearches = [question.slice(0, 100), ...existingSearches].slice(0, 20);

              await admin
                .from("user_interests")
                .update({
                  categories: newCats,
                  recent_searches: newSearches,
                  updated_at: new Date().toISOString(),
                })
                .eq("user_id", user.id);
            } else {
              // Create new interests record
              await admin.from("user_interests").upsert({
                user_id: user.id,
                categories: detectedCategories,
                recent_searches: [question.slice(0, 100)],
                favorite_products: [],
                updated_at: new Date().toISOString(),
              });
            }
          }
      } catch (memoryErr) {
        console.warn("[advisor] Smart memory update failed (non-critical):", memoryErr);
      }
    }
    console.log("Saving database... done");

    console.log("Returning response...");
    logRequestSuccess(start);
    return res.status(200).json({
      answer: answer.trim(),
      // Section 9: only ever populated in advisor mode; report-mode chat
      // always gets an empty array here so older clients see no change.
      productSuggestions,
      // Everyone now has a real cap (Free/guest: 20/mo or 20/report; Premium:
      // 150/mo shared) — "unlimited" is kept in the response shape only so
      // older clients don't break, but it's always false now.
      remaining: Math.max(0, maxMessages - newUsed),
      max: maxMessages,
      unlimited: false,
      mode,
    });
  } catch (err: any) {
    logUnhandledError(err, start);
    await releaseChatReservation();
    return res.status(500).json({ error: "server_error", message: err?.message, stack: err?.stack });
  }
}
