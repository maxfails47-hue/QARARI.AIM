import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getSupabaseAdmin, getAuthedUser } from "./_supabaseAdmin.js";
import { callAiWithFallback } from "./_groq_tavily.js";
import { logAiUsage } from "./_costTracking.js";
import { logRequestStart, logRequestSuccess, logUnhandledError, logStep, logEnvPresence } from "./_logger.js";

// Shary advisor chat — open-form shopping Q&A, no report/verdict context.
// The old "report mode" (per-analysis follow-up chat tied to an
// offeredPrice/verdict) was removed with the verdict engine — nothing in
// the frontend has sent mode="report" since the Shary pivot. Advisor mode
// is now the only mode this endpoint serves.
//
// Flat monthly cap for everyone (guest/signed-in) — no more per-plan chat
// quotas now that subscriptions are gone. Still rate-limited so the AI
// cost doesn't run away.
const MAX_ADVISOR_MESSAGES_PER_MONTH = 30;

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
  const adminForRelease = getSupabaseAdmin();
  let reservedIdentity: string | null = null;

  async function releaseChatReservation() {
    if (!reservedIdentity) return;
    try {
      const { data } = await adminForRelease.from("advisor_usage").select("messages_used").eq("identity", reservedIdentity).single();
      if (data) {
        await adminForRelease.from("advisor_usage").update({ messages_used: Math.max(0, data.messages_used - 1) }).eq("identity", reservedIdentity);
      }
    } catch (releaseErr) {
      console.error("[/api/ask] Failed to release chat reservation (non-fatal):", releaseErr);
    }
  }

  try {
    const {
      question,
      history = [],
      language = "ar",
    } = req.body || {};

    console.log("[/api/ask] Validating input...");
    if (!question || typeof question !== "string" || !question.trim()) {
      console.warn("[/api/ask] Invalid input (question):", { question });
      return res.status(400).json({ error: "invalid_input" });
    }
    console.log("[/api/ask] Input OK. question:", question.slice(0, 50));

    console.log("Checking authentication...");
    const admin = getSupabaseAdmin();
    const user = await getAuthedUser(req);
    console.log("Authentication OK. Signed in:", !!user, user ? `(userId: ${user.id})` : "(guest)");

    // Advisor chat works for guests too — quota tracked by IP-based identity.
    const identity = user
      ? `user:${user.id}`
      : `ip:${(req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown"}`;

    const maxMessages = MAX_ADVISOR_MESSAGES_PER_MONTH;

    // ---- Race-safe: atomic check-and-reserve BEFORE the paid AI call ----
    const { data: reserved, error: reserveErr } = await admin.rpc("increment_advisor_usage", {
      p_identity: identity,
      p_limit: maxMessages,
    });
    if (reserveErr) {
      console.error("[/api/ask] increment_advisor_usage RPC failed:", reserveErr);
      return res.status(500).json({ error: "server_error" });
    }
    if (!reserved) {
      console.warn("[/api/ask] Chat message limit reached. identity:", identity);
      return res.status(403).json({ error: "chat_limit_reached", remaining: 0, max: maxMessages });
    }
    reservedIdentity = identity;

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

    const prompt = buildAdvisorPrompt({
      question: question.trim(),
      history: Array.isArray(history) ? history : [],
      language: language === "en" ? "en" : "ar",
      userInterests,
    });

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

    let productSuggestions: { name: string; approxPrice: string; reason: string }[] = [];
    if (Array.isArray(aiResult.data?.productSuggestions)) {
      productSuggestions = aiResult.data.productSuggestions
        .filter((s: any) => s && typeof s.name === "string" && typeof s.approxPrice === "string" && typeof s.reason === "string")
        .slice(0, 3);
    }

    console.log("Saving database...");
    await logAiUsage(admin, {
      endpoint: "ask",
      model: aiResult.modelUsed,
      tier: "guest",
      userId: user?.id || null,
      usage: aiResult.usage,
    });

    // Usage was already reserved atomically before the AI call above.
    const { data: usageRow } = await admin.from("advisor_usage").select("messages_used").eq("identity", identity).single();
    const newUsed = usageRow?.messages_used ?? maxMessages;

    // Smart Memory System: update user interests after each interaction.
    if (user) {
      try {
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
        const detectedCategories = productKeywords.filter((kw) => questionLower.includes(kw));

        if (detectedCategories.length > 0) {
          const { data: existingInterests } = await admin
            .from("user_interests")
            .select("categories, recent_searches")
            .eq("user_id", user.id)
            .single();

          if (existingInterests) {
            const existingCats = existingInterests.categories || [];
            const newCats = [...new Set([...existingCats, ...detectedCategories])];
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
      productSuggestions,
      remaining: Math.max(0, maxMessages - newUsed),
      max: maxMessages,
      unlimited: false,
      mode: "advisor",
    });
  } catch (err: any) {
    logUnhandledError(err, start);
    await releaseChatReservation();
    return res.status(500).json({ error: "server_error", message: err?.message });
  }
}
