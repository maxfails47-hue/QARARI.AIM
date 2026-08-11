// Generic "quick-pick" spec chips, keyed by product category — not just phones.
// Goal: instead of asking the user to type the full spec string (storage,
// RAM, screen size, capacity...), detect the category from the product name
// (reusing the same keyword approach as categoryIcons.ts) and offer common
// values as tappable chips. Tapping one appends it to the specs field.
//
// This directly affects pricing accuracy: without a specific variant, the
// backend has to quote a market range across every SKU of that product
// (e.g. Samsung S23 Ultra 256GB vs 1TB), which produces a misleadingly wide
// "fair range". A tapped chip narrows that immediately, with zero typing.

interface VariantGroup {
  keywords: string[];
  // One or more chip groups shown together (e.g. phones: storage only;
  // laptops: RAM group + storage group).
  chipGroups: { label: { ar: string; en: string }; options: string[] }[];
}

function normalizeArabic(text: string): string {
  return text
    .replace(/[أإآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .toLowerCase()
    .trim();
}

const variantMap: VariantGroup[] = [
  {
    keywords: [
      "phone", "iphone", "samsung", "galaxy", "pixel",
      "موبايل", "تليفون", "هاتف",
      "سامسونج", "سامسونغ", "ايفون", "آيفون", "جالاكسي", "بيكسل",
    ],
    chipGroups: [
      { label: { ar: "السعة", en: "Storage" }, options: ["64GB", "128GB", "256GB", "512GB", "1TB"] },
    ],
  },
  {
    keywords: [
      "laptop", "macbook", "notebook",
      "لابتوب", "كمبيوتر محمول", "ماك بوك", "ماكبوك",
    ],
    chipGroups: [
      { label: { ar: "الرام", en: "RAM" }, options: ["8GB", "16GB", "32GB", "64GB"] },
      { label: { ar: "التخزين", en: "Storage" }, options: ["256GB SSD", "512GB SSD", "1TB SSD"] },
    ],
  },
  {
    keywords: ["tv", "television", "تليفزيون", "شاشة"],
    chipGroups: [
      { label: { ar: "المقاس", en: "Screen size" }, options: ["43\"", "50\"", "55\"", "65\"", "75\"", "85\"", "98\""] },
    ],
  },
  {
    keywords: [
      "console", "playstation", "ps5", "ps4", "xbox",
      "بلايستيشن", "بلاي ستيشن", "اكس بوكس", "إكس بوكس",
    ],
    chipGroups: [
      { label: { ar: "السعة", en: "Storage" }, options: ["512GB", "825GB", "1TB", "2TB"] },
    ],
  },
  {
    keywords: ["fridge", "refrigerator", "ثلاجة"],
    chipGroups: [
      { label: { ar: "السعة", en: "Capacity" }, options: ["14 قدم", "16 قدم", "18 قدم", "20 قدم"] },
    ],
  },
  {
    keywords: ["washing machine", "washer", "غسالة"],
    chipGroups: [
      { label: { ar: "السعة", en: "Capacity" }, options: ["7 كيلو", "8 كيلو", "9 كيلو", "10 كيلو"] },
    ],
  },
  {
    keywords: ["ac", "air conditioner", "تكييف", "مكيف"],
    chipGroups: [
      { label: { ar: "القدرة", en: "Capacity" }, options: ["1.5 حصان", "2.25 حصان", "3 حصان"] },
    ],
  },
  {
    keywords: ["watch", "ساعة"],
    chipGroups: [
      { label: { ar: "المقاس", en: "Size" }, options: ["40mm", "41mm", "44mm", "45mm", "49mm"] },
    ],
  },
  {
    keywords: ["camera", "كاميرا"],
    chipGroups: [
      { label: { ar: "التخزين/الجسم", en: "Body/Storage" }, options: ["Body only", "with 18-55mm lens"] },
    ],
  },
];

export function getVariantChipGroups(productName: string, aiCategory?: string | null): VariantGroup["chipGroups"] {
  if (!productName || productName.trim().length === 0) return [];
  const normalized = normalizeArabic(productName);
  for (const entry of variantMap) {
    const normalizedKeywords = entry.keywords.map(normalizeArabic);
    if (normalizedKeywords.some((kw) => normalized.includes(kw))) {
      return entry.chipGroups;
    }
  }
  // Local keyword list found nothing — fall back to the AI-classified
  // category (e.g. Arabic brand names/slang the static list doesn't cover).
  if (aiCategory) {
    const byCategory: Record<string, VariantGroup["chipGroups"]> = {
      phone: [{ label: { ar: "السعة", en: "Storage" }, options: ["64GB", "128GB", "256GB", "512GB", "1TB"] }],
      laptop: [
        { label: { ar: "الرام", en: "RAM" }, options: ["8GB", "16GB", "32GB", "64GB"] },
        { label: { ar: "التخزين", en: "Storage" }, options: ["256GB SSD", "512GB SSD", "1TB SSD"] },
      ],
      tv: [{ label: { ar: "المقاس", en: "Screen size" }, options: ["43\"", "50\"", "55\"", "65\"", "75\"", "85\"", "98\""] }],
      console: [{ label: { ar: "السعة", en: "Storage" }, options: ["512GB", "825GB", "1TB", "2TB"] }],
      watch: [{ label: { ar: "المقاس", en: "Size" }, options: ["40mm", "41mm", "44mm", "45mm", "49mm"] }],
      camera: [{ label: { ar: "التخزين/الجسم", en: "Body/Storage" }, options: ["Body only", "with 18-55mm lens"] }],
    };
    if (byCategory[aiCategory]) return byCategory[aiCategory];
  }
  return [];
}
