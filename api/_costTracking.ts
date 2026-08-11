import type { AiUsage } from "./_groq_tavily.js";

// ---- ESTIMATED pricing table (USD per 1M tokens) ----
// Groq's published per-token pricing (console.groq.com/docs/pricing) for the
// two models wired into _groq_tavily.ts. These exist so the AI Cost
// Dashboard (Section 25) can show a directional cost estimate, not an
// invoice-accurate figure (actual billing always comes from Groq).
// NOTE: keys must match PRIMARY_MODEL / FALLBACK_MODEL in _groq_tavily.ts
// exactly — a mismatch here silently falls back to DEFAULT_PRICING and
// understates cost. Re-check console.groq.com/docs/pricing periodically —
// Groq's model lineup and prices both move faster than most providers'.
const MODEL_PRICING_PER_1M_TOKENS: Record<string, { input: number; output: number }> = {
  "openai/gpt-oss-120b": { input: 0.15, output: 0.75 },
  "openai/gpt-oss-20b": { input: 0.05, output: 0.2 },
};
const DEFAULT_PRICING = { input: 0.5, output: 1.5 };

// Tavily bills per search call, not per token. The "Researcher" plan and
// similar tiers price out to roughly $0.008 per basic-depth search call;
// "advanced" depth (used in _groq_tavily.ts for better result quality)
// typically costs 2 credits instead of 1. Treat this as a directional
// estimate and confirm your actual plan's per-call price at tavily.com/pricing.
const TAVILY_COST_USD_PER_SEARCH = 0.016;

export function estimateCostUsd(model: string, usage: AiUsage): number {
  const pricing = MODEL_PRICING_PER_1M_TOKENS[model];
  if (!pricing) {
    // Surface this loudly instead of silently understating cost — if a model
    // name changes in _groq_tavily.ts without updating this table, the
    // Dashboard would otherwise report artificially low numbers with no
    // visible sign.
    console.error(`[costTracking] No pricing entry for model "${model}" — falling back to DEFAULT_PRICING. Update MODEL_PRICING_PER_1M_TOKENS.`);
  }
  const resolvedPricing = pricing || DEFAULT_PRICING;
  const inputCost = (usage.promptTokens / 1_000_000) * resolvedPricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * resolvedPricing.output;
  const searchCost = (usage.searchQueryCount || 0) * TAVILY_COST_USD_PER_SEARCH;
  return Number((inputCost + outputCost + searchCost).toFixed(6));
}

// Fire-and-forget-safe logger (still awaited by callers so it completes
// before the serverless function returns, but never throws upward).
export async function logAiUsage(
  admin: any,
  opts: {
    endpoint: string;
    model: string;
    tier: "free" | "premium" | "guest";
    userId?: string | null;
    usage: AiUsage;
  }
) {
  try {
    console.log("[costTracking] Logging AI usage for endpoint:", opts.endpoint, "| model:", opts.model);
    const costUsd = estimateCostUsd(opts.model, opts.usage);
    const { error } = await admin.from("ai_usage_log").insert({
      endpoint: opts.endpoint,
      model: opts.model,
      tier: opts.tier,
      user_id: opts.userId || null,
      prompt_tokens: opts.usage.promptTokens,
      output_tokens: opts.usage.outputTokens,
      total_tokens: opts.usage.totalTokens,
      search_query_count: opts.usage.searchQueryCount || 0,
      estimated_cost_usd: costUsd,
    });
    if (error) {
      console.error("[costTracking] Supabase insert error:", error);
    } else {
      console.log("[costTracking] AI usage logged. estimatedCostUsd:", costUsd);
    }
  } catch (e: any) {
    console.error("[costTracking] Failed to log AI usage:");
    console.error(e);
    console.error(e?.stack);
  }
}
