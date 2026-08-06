// ============================================================================
// Real price resolver — Shary Phase 2.
//
// Takes the direct retailer links that fetchMainProductRetailerLinks()
// already finds (see _groq_tavily.ts — that discovery step is unchanged)
// and opens EACH one for real to read the actual price/availability off the
// live page. This is the step the old app never did: before, an AI model
// only ever judged the price the user TYPED IN, using Serper snippets as
// context. Nothing here fabricates a number — if a store's price can't be
// read with reasonable confidence, we return null for it rather than guess.
//
// Extraction order per link (cheapest/most reliable first):
//   1. JSON-LD structured data (schema.org Product/Offer) — most retailers
//      (Amazon, Noon, Jumia, B.TECH...) embed this. Zero AI cost.
//   2. Common meta tags (og:price:amount, product:price:amount, itemprop).
//   3. AI fallback (Gemini, structured JSON out) reading a trimmed slice of
//      the page's visible text — only used when 1 and 2 both come up empty,
//      since it's slower and burns API budget.
//
// Links are resolved in parallel (Promise.allSettled) — a handful of stores
// per product (COUNTRY_RETAILERS has 3-4 domains per currency), which
// already satisfies the "3-5 concurrent" ceiling from the Shary spec's
// rate-limiting section without any extra throttling code. If/when this
// runs on a schedule (cron re-checking watched products across many users
// at once) it'll need a real system-wide limiter — that's a separate piece,
// not needed for the on-demand single-search path this file serves today.
// ============================================================================

import { callGeminiStructured } from "./_gemini.js";
import type { RetailerLink } from "./_groq_tavily.js";

export interface ResolvedStorePrice {
  retailer: string;
  url: string;
  price: number | null;
  currency: string;
  inStock: boolean | null; // null = couldn't determine
  lastChecked: string; // ISO timestamp
  source: "jsonld" | "meta" | "ai" | "unresolved";
}

const FETCH_TIMEOUT_MS = 8000;
const MAX_HTML_BYTES = 900_000; // don't buffer a huge page fully into memory
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
    return Buffer.from(slice).toString("utf-8");
  } catch {
    return null; // timeout, network block, DNS failure, etc. — never throws
  } finally {
    clearTimeout(timeout);
  }
}

// ─── 1. JSON-LD (schema.org) ───
function extractFromJsonLd(html: string): { price: number | null; inStock: boolean | null } | null {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of flattenGraph(nodes)) {
        const offer = node?.offers ?? node;
        const rawPrice = offer?.price ?? offer?.lowPrice;
        const price = typeof rawPrice === "string" ? parseFloat(rawPrice.replace(/,/g, "")) : rawPrice;
        if (typeof price === "number" && price > 0) {
          const availability: string = (offer?.availability || "").toString().toLowerCase();
          const inStock = availability
            ? availability.includes("instock") || availability.includes("in_stock")
            : null;
          return { price, inStock };
        }
      }
    } catch {
      // malformed JSON-LD on this block — try the next one
    }
  }
  return null;
}

function flattenGraph(nodes: any[]): any[] {
  const out: any[] = [];
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (Array.isArray(n["@graph"])) out.push(...n["@graph"]);
    else out.push(n);
  }
  return out;
}

// ─── 2. Meta tags ───
function extractFromMeta(html: string): { price: number | null; inStock: boolean | null } | null {
  const metaPatterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:price:amount|product:price:amount)["'][^>]+content=["']([\d.,]+)["']/i,
    /<meta[^>]+content=["']([\d.,]+)["'][^>]+(?:property|name)=["'](?:og:price:amount|product:price:amount)["']/i,
    /itemprop=["']price["'][^>]*content=["']([\d.,]+)["']/i,
  ];
  for (const re of metaPatterns) {
    const m = html.match(re);
    if (m) {
      const price = parseFloat(m[1].replace(/,/g, ""));
      if (price > 0) {
        const availability = /itemprop=["']availability["'][^>]*content=["'][^"']*instock/i.test(html);
        return { price, inStock: availability || null };
      }
    }
  }
  return null;
}

// ─── 3. AI fallback — only reached when 1 and 2 both miss ───
const PRICE_SCHEMA = {
  type: "object",
  properties: {
    price: { type: "number", nullable: true },
    inStock: { type: "boolean", nullable: true },
  },
  required: ["price", "inStock"],
};

function stripToVisibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 6000);
}

async function extractViaAi(html: string, retailer: string, currency: string): Promise<{ price: number | null; inStock: boolean | null } | null> {
  try {
    const text = stripToVisibleText(html);
    if (text.length < 40) return null;
    const system =
      "You read raw text scraped from a single e-commerce product page and pull out the CURRENT price and stock status. " +
      "Respond with ONLY a JSON object matching the schema. If you cannot find a clear current price for the main " +
      "product on this page, return price: null. Never guess or estimate — null is the correct answer when unsure.";
    const user = `Retailer: ${retailer}\nExpected currency: ${currency}\n\nPage text:\n${text}`;
    const raw = await callGeminiStructured(system, user, PRICE_SCHEMA, 300);
    const parsed = JSON.parse(raw);
    if (typeof parsed.price === "number" && parsed.price > 0) {
      return { price: parsed.price, inStock: typeof parsed.inStock === "boolean" ? parsed.inStock : null };
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveOne(link: RetailerLink, currency: string): Promise<ResolvedStorePrice> {
  const lastChecked = new Date().toISOString();
  const base = { retailer: link.retailer, url: link.url, currency, lastChecked };

  const html = await fetchHtml(link.url);
  if (!html) {
    return { ...base, price: null, inStock: null, source: "unresolved" };
  }

  const jsonld = extractFromJsonLd(html);
  if (jsonld) return { ...base, price: jsonld.price, inStock: jsonld.inStock, source: "jsonld" };

  const meta = extractFromMeta(html);
  if (meta) return { ...base, price: meta.price, inStock: meta.inStock, source: "meta" };

  const ai = await extractViaAi(html, link.retailer, currency);
  if (ai) return { ...base, price: ai.price, inStock: ai.inStock, source: "ai" };

  return { ...base, price: null, inStock: null, source: "unresolved" };
}

/**
 * Resolves real prices for every given retailer link, in parallel.
 * A failure on one link (blocked, timed out, unparseable) never throws —
 * it just comes back with price: null so the caller can still show the
 * other stores that did resolve.
 */
export async function resolvePricesForLinks(
  links: RetailerLink[],
  currency: string
): Promise<ResolvedStorePrice[]> {
  const settled = await Promise.allSettled(links.map((link) => resolveOne(link, currency)));
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          retailer: links[i].retailer,
          url: links[i].url,
          price: null,
          currency,
          inStock: null,
          lastChecked: new Date().toISOString(),
          source: "unresolved" as const,
        }
  );
}
