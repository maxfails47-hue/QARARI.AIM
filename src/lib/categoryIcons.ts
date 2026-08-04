import {
  Smartphone, Laptop, Watch, Headphones, Camera, Tv, Car,
  Footprints, ShoppingBag, Gamepad2, Package,
} from "lucide-react";
import type { ComponentType } from "react";

interface IconProps {
  className?: string;
  strokeWidth?: number;
}

type IconComponent = ComponentType<IconProps>;

const keywordMap: { keywords: string[]; icon: IconComponent; key: string }[] = [
  { keywords: ["phone", "iphone", "samsung", "galaxy", "pixel", "موبايل", "تليفون", "هاتف", "سامسونج", "سامسونغ", "ايفون", "آيفون", "جالاكسي", "بيكسل"], icon: Smartphone, key: "phone" },
  { keywords: ["laptop", "macbook", "notebook", "لابتوب", "كمبيوتر", "ماك بوك", "ماكبوك"], icon: Laptop, key: "laptop" },
  { keywords: ["watch", "ساعة"], icon: Watch, key: "watch" },
  { keywords: ["headphone", "airpods", "earbuds", "سماعة"], icon: Headphones, key: "headphones" },
  { keywords: ["camera", "كاميرا"], icon: Camera, key: "camera" },
  { keywords: ["tv", "television", "تليفزيون"], icon: Tv, key: "tv" },
  { keywords: ["car", "سيارة"], icon: Car, key: "car" },
  { keywords: ["shoe", "جزمة", "sneaker"], icon: Footprints, key: "shoes" },
  { keywords: ["bag", "شنطة"], icon: ShoppingBag, key: "bag" },
  { keywords: ["console", "playstation", "xbox", "بلايستيشن", "بلاي ستيشن", "اكس بوكس", "إكس بوكس"], icon: Gamepad2, key: "console" },
];

function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .toLowerCase()
    .trim();
}

export function getCategoryIcon(productName: string): IconComponent {
  if (!productName || productName.trim().length === 0) return Package;
  const normalized = normalizeArabic(productName);
  for (const entry of keywordMap) {
    const normalizedKeywords = entry.keywords.map(normalizeArabic);
    if (normalizedKeywords.some((kw) => normalized.includes(kw))) {
      return entry.icon;
    }
  }
  return Package;
}

// Maps the category string returned by the Groq-powered classifier
// (see api/user.ts?action=classify-icon) to the same icon set above, so the
// "smart" AI-driven icon and the instant local keyword-based icon always
// look consistent. Used only as an *upgrade* over the instant icon above —
// never blocks the UI, since it's applied after an async API response.
const CATEGORY_ICON_MAP: Record<string, IconComponent> = {
  phone: Smartphone,
  laptop: Laptop,
  headphones: Headphones,
  watch: Watch,
  camera: Camera,
  tv: Tv,
  console: Gamepad2,
  car: Car,
  shoes: Footprints,
  bag: ShoppingBag,
  other: Package,
};

export function getIconByCategory(category: string | null | undefined): IconComponent {
  if (!category) return Package;
  return CATEGORY_ICON_MAP[category] || Package;
}

// Local (instant, no API call) category key match — same keyword list as
// getCategoryIcon above, but returns the string key ("phone", "laptop", …)
// instead of the icon component. Used to decide, before any AI call
// resolves, whether "condition" (new/like-new/used) is even a meaningful
// question for this product — it isn't for something like shampoo.
export function getCategoryKey(productName: string): string {
  if (!productName || productName.trim().length === 0) return "other";
  const normalized = normalizeArabic(productName);
  for (const entry of keywordMap) {
    const normalizedKeywords = entry.keywords.map(normalizeArabic);
    if (normalizedKeywords.some((kw) => normalized.includes(kw))) {
      return entry.key;
    }
  }
  return "other";
}

// Categories where "condition" (new / like-new / used) is a meaningful,
// price-relevant question — mainly electronics, where a used-market search
// genuinely changes the analysis. Left out on purpose: clothes/shoes/bags
// (condition matters less predictably) and anything else, since forcing a
// condition choice on a bottle of shampoo doesn't make sense.
const CONDITION_RELEVANT_CATEGORIES = new Set(["phone", "laptop", "watch", "headphones", "camera", "tv", "console"]);

export function isConditionRelevant(category: string | null | undefined): boolean {
  if (!category) return false;
  return CONDITION_RELEVANT_CATEGORIES.has(category);
}