// ============================================================================
// Direct product URL validator.
//
// Serper (and any broad/unrestricted search) sometimes returns a store's
// SEARCH RESULTS page, a category/listing page, or a brand collection page
// instead of an actual product detail page. Treating one of those as a
// "direct" retailer link is misleading — the user clicks through and lands
// on a generic listing, not the item we priced. This module is the gate
// that decides whether a URL is really a single-product page before it's
// allowed to be shown as a direct link. If it isn't, the caller is expected
// to fall back to that store's own on-site search URL instead of a
// fabricated/guessed product link.
// ============================================================================

export function isValidDirectProductUrl(url: string, brand?: string, model?: string): boolean {
  if (!url || typeof url !== "string") return false;

  const lowerUrl = url.toLowerCase();

  // 1. Blacklist: search, listing, category, and collection-style paths.
  const blacklistPatterns = [
    "/search",
    "/catalog",
    "/category",
    "/categories",
    "/browse",
    "/filter",
    "/query=",
    "/s=",
    "/brand/",
    "/collections/",
    "/shop/",
    "results?",
  ];

  for (const pattern of blacklistPatterns) {
    if (lowerUrl.includes(pattern)) {
      return false;
    }
  }

  // 2. Known product-detail-page signatures (Amazon /dp/, Noon/B.TECH /p/, etc.)
  const validProductSignatures = [
    "/dp/", // Amazon
    "/gp/product/",
    "/p/", // Noon / B.TECH etc.
    "/product/",
    "/item/",
    "-p-",
  ];

  const hasValidSignature = validProductSignatures.some((sig) => lowerUrl.includes(sig));

  // If there's no recognizable product signature AND the path is too shallow
  // to plausibly be a specific listing (e.g. just the site root), reject it
  // rather than risk showing a homepage/section link as a "direct" one.
  try {
    const urlObj = new URL(url);
    const pathSegments = urlObj.pathname.split("/").filter(Boolean);
    if (pathSegments.length < 2 && !hasValidSignature) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

// Returns the URL unchanged if it passes validation, or null if it should be
// rejected outright. Callers must NOT substitute a fabricated URL when this
// returns null — fall back to a real, store-owned search URL instead.
export function cleanAndVerifyUrl(url: string, brand?: string, model?: string): string | null {
  if (isValidDirectProductUrl(url, brand, model)) {
    return url;
  }
  return null;
}
