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

const keywordMap: { keywords: string[]; icon: IconComponent }[] = [
  { keywords: ["phone", "iphone", "samsung", "galaxy", "pixel", "موبايل", "تليفون", "هاتف"], icon: Smartphone },
  { keywords: ["laptop", "macbook", "notebook", "لابتوب", "كمبيوتر"], icon: Laptop },
  { keywords: ["watch", "ساعة"], icon: Watch },
  { keywords: ["headphone", "airpods", "earbuds", "سماعة"], icon: Headphones },
  { keywords: ["camera", "كاميرا"], icon: Camera },
  { keywords: ["tv", "television", "تليفزيون"], icon: Tv },
  { keywords: ["car", "سيارة"], icon: Car },
  { keywords: ["shoe", "جزمة", "sneaker"], icon: Footprints },
  { keywords: ["bag", "شنطة"], icon: ShoppingBag },
  { keywords: ["console", "playstation", "xbox"], icon: Gamepad2 },
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