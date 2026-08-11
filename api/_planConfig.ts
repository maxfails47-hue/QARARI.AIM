/**
 * Section 15: Centralized Plan Configuration
 * Single source of truth for all subscription plans, limits, and pricing
 * Used by: approve.ts, analyze.ts, compare.ts, ask.ts, scans-remaining.ts, subscribe.ts
 */

export interface PlanConfig {
  id: string;
  name: string; // e.g., "small_bundle", "medium_bundle", "large_bundle", "smart_shopper", "power_buyer", "buywise_elite"
  displayName: string; // e.g., "Small Bundle", "Smart Shopper", "BuyWise Elite"
  price: number; // in EGP
  currency: string;
  limits: {
    scans: number; // monthly analysis limit
    compares: number; // monthly comparison limit
    chatMessages: number; // monthly chat/advisor messages limit
  };
  description: string;
  badge?: string; // optional premium badge label (e.g., "Elite")
}

/**
 * All subscription plans with their limits
 * This is the ONLY place where plan limits should be defined
 */
export const PLAN_CONFIGS: Record<string, PlanConfig> = {
  small_bundle: {
    id: "small_bundle",
    name: "small_bundle",
    displayName: "Small Bundle",
    price: 50,
    currency: "EGP",
    limits: {
      scans: 12,
      compares: 0,
      chatMessages: 25,
    },
    description: "12 analyses, 25 chat messages",
  },
  medium_bundle: {
    id: "medium_bundle",
    name: "medium_bundle",
    displayName: "Medium Bundle",
    price: 80,
    currency: "EGP",
    limits: {
      scans: 25,
      compares: 2,
      chatMessages: 50,
    },
    description: "25 analyses, 2 comparisons, 50 chat messages",
  },
  large_bundle: {
    id: "large_bundle",
    name: "large_bundle",
    displayName: "Large Bundle",
    price: 120,
    currency: "EGP",
    limits: {
      scans: 40,
      compares: 5,
      chatMessages: 90,
    },
    description: "40 analyses, 5 comparisons, 90 chat messages",
  },
  smart_shopper: {
    id: "smart_shopper",
    name: "smart_shopper",
    displayName: "Smart Shopper",
    price: 150,
    currency: "EGP",
    limits: {
      scans: 60,
      compares: 10,
      chatMessages: 150,
    },
    description: "60 analyses, 10 comparisons, 150 chat messages",
  },
  power_buyer: {
    id: "power_buyer",
    name: "power_buyer",
    displayName: "Power Buyer",
    price: 300,
    currency: "EGP",
    limits: {
      scans: 150,
      compares: 30,
      chatMessages: 300,
    },
    description: "150 analyses, 30 comparisons, 300 chat messages",
  },
  buywise_elite: {
    id: "buywise_elite",
    name: "buywise_elite",
    displayName: "BuyWise Elite",
    price: 500,
    currency: "EGP",
    limits: {
      scans: 300,
      compares: 75,
      chatMessages: 600,
    },
    description: "300 analyses, 75 comparisons, 600 chat messages",
    badge: "Elite",
  },
};

/**
 * Free tier limits (non-premium users)
 */
export const FREE_TIER_LIMITS = {
  scans: 3, // monthly free analyses
  compares: 0, // free users cannot compare
  chatMessages: 20, // monthly free chat messages
};

/**
 * Default premium tier limits (used as fallback if plan not found)
 * This should NOT be used directly — always fetch from database or PLAN_CONFIGS
 */
export const DEFAULT_PREMIUM_LIMITS = {
  scans: 8,
  compares: 2,
  chatMessages: 80,
};

/**
 * Get plan config by ID
 */
export function getPlanConfig(planId: string): PlanConfig | null {
  return PLAN_CONFIGS[planId] || null;
}

/**
 * Get plan config by price (for validation/matching)
 */
export function getPlanConfigByPrice(price: number): PlanConfig | null {
  return Object.values(PLAN_CONFIGS).find((p) => p.price === price) || null;
}

/**
 * Get all available plans
 */
export function getAllPlans(): PlanConfig[] {
  return Object.values(PLAN_CONFIGS);
}

/**
 * Validate that a plan exists
 */
export function isValidPlan(planId: string): boolean {
  return planId in PLAN_CONFIGS;
}

/**
 * FAIR USE POLICY — Rate limiting configuration
 * Prevents abuse of large quota plans without removing purchased credits.
 * If a user exceeds the burst threshold within the window, requests are
 * temporarily slowed (429) with a friendly message. Their remaining
 * credits are preserved.
 *
 * Thresholds scale with plan size so that normal heavy users of Elite
 * are never impacted — only abnormal automated/abusive patterns trigger it.
 */
export const FAIR_USE_CONFIG = {
  // Time window for burst detection (milliseconds)
  windowMs: 60 * 1000, // 1 minute

  // Maximum requests allowed within the window per plan tier
  burstLimits: {
    free: 3,           // 3 per minute for free users
    small_bundle: 5,   // 5 per minute
    medium_bundle: 8,  // 8 per minute
    large_bundle: 12,  // 12 per minute
    smart_shopper: 18, // 18 per minute
    power_buyer: 35,   // 35 per minute
    buywise_elite: 60, // 60 per minute
  },

  // Cooldown duration after burst limit is exceeded (milliseconds)
  cooldownMs: 30 * 1000, // 30 seconds

  // Daily cap multiplier: if user consumes >= this fraction of monthly quota
  // in a single day, flag for monitoring (does NOT block — just logs)
  dailyUsageWarningThreshold: 0.5, // 50% of monthly quota in one day
};

/**
 * Get the burst limit for a given plan
 */
export function getBurstLimit(planName: string): number {
  const plan = getPlanConfig(planName);
  if (!plan) return FAIR_USE_CONFIG.burstLimits.free;
  return FAIR_USE_CONFIG.burstLimits[planName as keyof typeof FAIR_USE_CONFIG.burstLimits]
    || FAIR_USE_CONFIG.burstLimits.free;
}
