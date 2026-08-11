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
import { hostnameOf } from "./_domainHealth.js";

export interface ResolvedStorePrice {
  retailer: string;
  url: string;
  price: number | null;
  currency: string;
  inStock: boolean | null; // null = couldn't determine
  imageUrl: string | null; // product photo, when the page's own JSON-LD/meta has one — never AI-generated
  lastChecked: string; // ISO timestamp
  source: "jsonld" | "meta" | "embedded-state" | "ai" | "ai-rendered" | "unresolved";
  // Carried straight through from the input RetailerLink — whether `url` is
  // a verified product page vs a plain store-search fallback. Independent
  // of `price`: a direct product page can still resolve price: null (store
  // blocks scraping), and that must NOT be confused with the fallback case.
  isDirectProduct: boolean;
}

const FETCH_TIMEOUT_MS = 6000;
const RETRY_TIMEOUT_MS = 3500; // shorter on the retry so total wall time stays bounded
// Reader-proxy fallback (see fetchViaReaderProxy below) renders the page
// with JS before returning text, which is inherently slower than a plain
// fetch — give it its own, separate budget rather than squeezing it into
// what's left of FETCH_TIMEOUT_MS/RETRY_TIMEOUT_MS.
const READER_PROXY_TIMEOUT_MS = 7000;
// Hard ceiling on a SINGLE store's entire resolution (fetch + retry + AI
// fallback + reader-proxy fallback combined). Every link is resolved in
// parallel, so the whole resolvePricesForLinks() call is only ever as slow
// as its single slowest store — this cap is what keeps one dead/very slow
// domain from dragging the whole report past a minute. Past this point we
// give up on that one store and return it unresolved rather than let it
// hold up every other store's already-successful result.
// Raised from 9500 -> 13500 to leave room for the new reader-proxy tier
// (only reached when the first three tiers all miss) without starving it
// of a fair timeout of its own.
const PER_LINK_HARD_CAP_MS = 13500;
const MAX_HTML_BYTES = 900_000; // don't buffer a huge page fully into memory

// Rotating pool of realistic desktop UAs. Some retailer sites fingerprint
// on UA alone (or keep a blocklist keyed to the single most common
// scraper UA) — cycling through a few real, current browser strings means
// a block on one doesn't guarantee a block on the retry.
const UA_POOL = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
];

// Markers that show up on interstitial/challenge/"we think you're a bot"
// pages rather than the real product page. When we see one of these we
// treat the fetch as failed (never try to read a price off a challenge
// page) and, on the first attempt, trigger the UA-rotated retry.
const BLOCK_PAGE_MARKERS = [
  "captcha", "robot check", "pardon our interruption", "access denied",
  "are you a human", "unusual traffic", "just a moment", "cf-browser-verification",
  "attention required", "enable javascript and cookies",
];

function looksLikeBlockPage(html: string): boolean {
  const head = html.slice(0, 4000).toLowerCase();
  return BLOCK_PAGE_MARKERS.some((m) => head.includes(m));
}

function buildBrowserHeaders(ua: string): Record<string, string> {
  return {
    "User-Agent": ua,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,ar;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    // A referer from a search engine reads as an organic visit rather than
    // a direct scraper hit, which some anti-bot rules weigh heavily.
    Referer: "https://www.google.com/",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-User": "?1",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
  };
}

async function fetchOnce(url: string, ua: string, timeoutMs: number): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: buildBrowserHeaders(ua),
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

// Tries once with a random desktop UA. Only retries — once, with a
// *different* UA and a shorter timeout — when the first attempt actually
// got a response back but it was an anti-bot interstitial rather than the
// real product page. If the first attempt failed outright (timeout/DNS/
// network error), we do NOT retry: a host that didn't answer within
// FETCH_TIMEOUT_MS is usually genuinely slow or unreachable, and stacking
// a second full timeout on top of the first is exactly what was dragging
// whole-report analysis time past a minute. Never more than 2 network
// round-trips per link, and only when they're actually likely to help.
async function fetchHtml(url: string): Promise<string | null> {
  const firstUa = UA_POOL[Math.floor(Math.random() * UA_POOL.length)];
  const first = await fetchOnce(url, firstUa, FETCH_TIMEOUT_MS);
  if (!first) return null; // outright failure — don't retry, just move on
  if (!looksLikeBlockPage(first)) return first;

  const remainingUas = UA_POOL.filter((u) => u !== firstUa);
  const secondUa = remainingUas[Math.floor(Math.random() * remainingUas.length)];
  const second = await fetchOnce(url, secondUa, RETRY_TIMEOUT_MS);
  if (second && !looksLikeBlockPage(second)) return second;

  // Retry either failed outright or also hit a block page — genuinely
  // couldn't read this store. Return whichever HTML we have (if any) so
  // downstream extraction can still try; a block page will simply yield no
  // JSON-LD/meta/AI price, same as returning null.
  return second || first;
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

// ─── 2.5. Embedded framework state (Next.js/Nuxt/Redux-style SSR JSON) ───
// Many modern storefronts (Next.js, Nuxt, and similar SSR frameworks) ship
// the ENTIRE page's data — including price — as a JSON blob embedded
// directly in the raw HTML, even on pages where nothing is exposed via
// schema.org JSON-LD or og:price/product:price meta tags. This is a
// documented, standard convention used across countless storefronts
// regardless of retailer (not a guess tailored to one site) — reading it
// here means ANY site built this way gets its price for free, before ever
// needing the AI-on-text or reader-proxy tiers below, which cost real time
// and (for the AI tier) real API budget. Confirmed against a real noon.com
// Egypt category listing: prices like "EGP1,560" ARE present in the
// rendered page, just not in JSON-LD/meta form — exactly what this catches
// when the retailer embeds that data as page-state JSON.
const STATE_SCRIPT_PATTERNS = [
  /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  /<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  /<script[^>]+id=["']__APOLLO_STATE__["'][^>]*>([\s\S]*?)<\/script>/i,
  /window\.__NUXT__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
];

const PRICE_KEY_RE = /^(price|saleprice|sellingprice|currentprice|finalprice|specialprice|listprice|unitprice)$/i;

// Prefer a "product/pdp/item"-named subtree first, if one exists, so a
// price recursively found doesn't accidentally come from an unrelated
// "recommended products" or "similar items" block elsewhere in the same
// page-state blob — same concern _priceExtraction.ts's matchesProduct()
// guards against for the search-snippet path.
function findNamedSubtree(node: any, nameRe: RegExp, depth = 0): any {
  if (depth > 6 || node == null || typeof node !== "object") return null;
  for (const key of Object.keys(node)) {
    if (nameRe.test(key) && node[key] && typeof node[key] === "object") return node[key];
  }
  for (const key of Object.keys(node)) {
    const found = findNamedSubtree(node[key], nameRe, depth + 1);
    if (found) return found;
  }
  return null;
}

function findPriceInObject(node: any, depth = 0): number | null {
  if (depth > 8 || node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPriceInObject(item, depth + 1);
      if (found != null) return found;
    }
    return null;
  }
  for (const key of Object.keys(node)) {
    const val = node[key];
    if (PRICE_KEY_RE.test(key) && (typeof val === "number" || typeof val === "string")) {
      const num = typeof val === "string" ? parseFloat(val.replace(/,/g, "")) : val;
      if (typeof num === "number" && !Number.isNaN(num) && num > 0) return num;
    }
  }
  for (const key of Object.keys(node)) {
    const found = findPriceInObject(node[key], depth + 1);
    if (found != null) return found;
  }
  return null;
}

function extractFromEmbeddedState(html: string): { price: number | null; inStock: boolean | null } | null {
  for (const pattern of STATE_SCRIPT_PATTERNS) {
    const m = html.match(pattern);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1].trim());
      const productSubtree = findNamedSubtree(parsed, /^(product|pdp|productdetails|item)$/i);
      const price = (productSubtree && findPriceInObject(productSubtree)) ?? findPriceInObject(parsed);
      if (price != null) return { price, inStock: null };
    } catch {
      // Malformed/partial JSON captured by the regex (e.g. a trailing
      // script tag inside a string threw off the lazy match) — try the
      // next pattern rather than failing the whole tier.
    }
  }
  return null;
}

// ─── Product image (independent of which price path resolves) ───
function imageFromJsonLdNode(node: any): string | null {
  const raw = node?.image;
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const first = raw.find((v: any) => typeof v === "string" || typeof v?.url === "string");
    if (typeof first === "string") return first;
    if (typeof first?.url === "string") return first.url;
    return null;
  }
  if (typeof raw?.url === "string") return raw.url;
  return null;
}

function extractImage(html: string, pageUrl: string): string | null {
  let candidate: string | null = null;

  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1].trim());
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of flattenGraph(nodes)) {
        const img = imageFromJsonLdNode(node) || imageFromJsonLdNode(node?.offers);
        if (img) {
          candidate = img;
          break;
        }
      }
    } catch {
      // malformed JSON-LD block — skip it
    }
    if (candidate) break;
  }

  if (!candidate) {
    const metaPatterns = [
      /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
      /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i,
    ];
    for (const re of metaPatterns) {
      const m = html.match(re);
      if (m) {
        candidate = m[1];
        break;
      }
    }
  }

  if (!candidate) return null;

  try {
    return new URL(candidate, pageUrl).toString();
  } catch {
    return null; // malformed/relative URL we couldn't resolve — never guess
  }
}

// ─── 4. Reader-proxy fallback — only reached when 1, 2 and 3 all miss ───
// Real-world failures (Jumia, Noon, apple.com, and various independent
// store domains in the wild) aren't always a missing JSON-LD tag — plenty
// are either JS-rendered SPA pages where the price never appears in the raw
// HTML our plain fetch() gets back, or anti-bot interstitials that
// looksLikeBlockPage() correctly detects but can't get past on its own.
// r.jina.ai is a free, no-API-key text-reader proxy that renders the target
// page (executing its JS) on its own infrastructure and returns the
// rendered page as plain readable text. Routing through it costs nothing
// extra to integrate (no new dependency, no new env var) and, because the
// request originates from their servers rather than ours, it also sidesteps
// a chunk of the UA/IP-based blocking that trips up our direct fetch. This
// is a best-effort last resort, not a guarantee — some sites block readers
// too — so it only fires after the cheaper tiers have already failed.
// Two independent free proxy providers, tried in order. r.jina.ai renders
// JS on its own infra (best chance against JS-only SPA prices) but gets
// rate-limited/blocked itself under heavy shared usage; allorigins.win
// doesn't render JS but still helps against plain IP/UA-based blocking
// since the request originates from ITS servers, not ours. Trying both
// costs nothing extra when the first one fails outright — READER_PROXY_TIMEOUT_MS
// is per-attempt, not shared, so a dead jina.ai doesn't eat into
// allorigins's own budget.
const READER_PROXIES: { name: string; build: (url: string) => string }[] = [
  { name: "jina", build: (url) => `https://r.jina.ai/${url}` },
  { name: "allorigins", build: (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}` },
];

async function fetchViaReaderProxy(url: string): Promise<string | null> {
  for (const proxy of READER_PROXIES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), READER_PROXY_TIMEOUT_MS);
    try {
      const res = await fetch(proxy.build(url), {
        signal: controller.signal,
        headers: { Accept: "text/plain,text/html" },
      });
      clearTimeout(timeout);
      if (!res.ok) continue; // try the next proxy
      const text = await res.text();
      if (text && text.length > 40) return text.slice(0, MAX_HTML_BYTES);
    } catch {
      // timeout, network error, or this proxy itself got blocked — fall
      // through to the next one rather than giving up entirely
    } finally {
      clearTimeout(timeout);
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

async function resolveOneInner(link: RetailerLink, currency: string, preferReaderProxy: boolean): Promise<ResolvedStorePrice> {
  const lastChecked = new Date().toISOString();
  const base = { retailer: link.retailer, url: link.url, currency, lastChecked, isDirectProduct: link.isDirectProduct };

  // Domains with a known-poor plain-fetch success rate (see
  // _domainHealth.ts — loaded from cumulative history, not a guess) skip
  // straight to the reader-proxy tier first. This doesn't touch the
  // extraction logic itself (still JSON-LD/meta/AI on whatever HTML/text
  // comes back) — it just reorders WHICH fetch path is tried first, so we
  // don't burn the fetch+retry budget on a path that's historically ~0%
  // for this domain before falling back to it if the proxy also misses.
  // Tracks whether the reader-proxy tier already ran (and, if so, what it
  // returned) so the fallback tiers further down never fire a second,
  // redundant proxy request for the same link — READER_PROXY_TIMEOUT_MS is
  // ~7s, and paying that twice would eat most of PER_LINK_HARD_CAP_MS.
  let proxyAlreadyTried = false;
  let proxyResult: string | null = null;

  if (preferReaderProxy) {
    proxyAlreadyTried = true;
    proxyResult = await fetchViaReaderProxy(link.url);
    if (proxyResult) {
      const imageUrl = extractImage(proxyResult, link.url);
      const jsonld = extractFromJsonLd(proxyResult);
      if (jsonld) return { ...base, price: jsonld.price, inStock: jsonld.inStock, imageUrl, source: "jsonld" };
      const meta = extractFromMeta(proxyResult);
      if (meta) return { ...base, price: meta.price, inStock: meta.inStock, imageUrl, source: "meta" };
      const ai = await extractViaAi(proxyResult, link.retailer, currency);
      if (ai) return { ...base, price: ai.price, inStock: ai.inStock, imageUrl, source: "ai-rendered" };
    }
    // Reader-proxy tier missed (or was itself blocked/rate-limited) — fall
    // through to the normal plain-fetch sequence below as a last resort,
    // same as any other domain would get.
  }

  const html = await fetchHtml(link.url);
  if (!html) {
    // Direct fetch failed outright (timeout, DNS, connection block) —
    // still worth trying the reader proxy before giving up entirely, since
    // it's a fully separate network path (see fetchViaReaderProxy above) —
    // unless we already tried it above for this same link.
    const rendered = proxyAlreadyTried ? proxyResult : await fetchViaReaderProxy(link.url);
    if (rendered) {
      const renderedAi = await extractViaAi(rendered, link.retailer, currency);
      if (renderedAi) {
        return { ...base, price: renderedAi.price, inStock: renderedAi.inStock, imageUrl: null, source: "ai-rendered" };
      }
    }
    return { ...base, price: null, inStock: null, imageUrl: null, source: "unresolved" };
  }

  // Image extraction is independent of which price path below succeeds —
  // a store can have a clean og:image even if its price needs the AI fallback.
  const imageUrl = extractImage(html, link.url);

  const jsonld = extractFromJsonLd(html);
  if (jsonld) return { ...base, price: jsonld.price, inStock: jsonld.inStock, imageUrl, source: "jsonld" };

  const meta = extractFromMeta(html);
  if (meta) return { ...base, price: meta.price, inStock: meta.inStock, imageUrl, source: "meta" };

  const embedded = extractFromEmbeddedState(html);
  if (embedded) return { ...base, price: embedded.price, inStock: embedded.inStock, imageUrl, source: "embedded-state" };

  const ai = await extractViaAi(html, link.retailer, currency);
  if (ai) return { ...base, price: ai.price, inStock: ai.inStock, imageUrl, source: "ai" };

  // Tiers 1-3 all missed on the raw fetch — try the JS-rendering reader
  // proxy as a last resort (see fetchViaReaderProxy above) before giving up
  // — unless we already tried it earlier for this same link.
  const rendered = proxyAlreadyTried ? proxyResult : await fetchViaReaderProxy(link.url);
  if (rendered) {
    const renderedAi = await extractViaAi(rendered, link.retailer, currency);
    if (renderedAi) {
      // Reader output is plain text, not the original HTML, so it won't
      // carry a better product image than what we already pulled (or
      // didn't) from the raw fetch above — reuse imageUrl as-is.
      return { ...base, price: renderedAi.price, inStock: renderedAi.inStock, imageUrl, source: "ai-rendered" };
    }
  }

  return { ...base, price: null, inStock: null, imageUrl, source: "unresolved" };
}

// Hard-caps a single store's ENTIRE resolution (fetch + retry + AI
// fallback, whatever combination actually ran) at PER_LINK_HARD_CAP_MS.
// fetchHtml's own internal timeouts already bound the network part, but
// the AI fallback call on top of a slow-but-successful fetch could still
// push one store well past what's reasonable — this is the outer safety
// net that guarantees no single store can hold up the whole report.
async function resolveOne(link: RetailerLink, currency: string, preferReaderProxy: boolean): Promise<ResolvedStorePrice> {
  const fallback: ResolvedStorePrice = {
    retailer: link.retailer,
    url: link.url,
    price: null,
    currency,
    inStock: null,
    imageUrl: null,
    lastChecked: new Date().toISOString(),
    source: "unresolved",
    isDirectProduct: link.isDirectProduct,
  };
  return Promise.race([
    resolveOneInner(link, currency, preferReaderProxy),
    new Promise<ResolvedStorePrice>((resolve) =>
      setTimeout(() => resolve(fallback), PER_LINK_HARD_CAP_MS)
    ),
  ]);
}

// Ceiling on how many retailer links get their price actually resolved.
// fetchMainProductRetailerLinks() can return up to ~12 links once the
// broad-discovery links are added on top of the fixed ones — resolving
// every one of those doesn't make the whole call any slower (they're all
// parallel, still bounded by PER_LINK_HARD_CAP_MS), but it does mean up to
// 12 concurrent outbound fetches (plus possible AI-fallback calls) fired
// from a single serverless invocation, which costs more and adds
// connection-setup overhead for diminishing returns past a handful of
// stores. The fixed, most-reliable links always come first in the input
// array, so slicing keeps those and only trims the long tail of broad-
// discovery extras.
const MAX_LINKS_TO_RESOLVE = 8;

/**
 * Resolves real prices for every given retailer link, in parallel.
 * A failure on one link (blocked, timed out, unparseable) never throws —
 * it just comes back with price: null so the caller can still show the
 * other stores that did resolve.
 */
export async function resolvePricesForLinks(
  links: RetailerLink[],
  currency: string,
  knownBadDomains: Set<string> = new Set()
): Promise<ResolvedStorePrice[]> {
  const capped = links.slice(0, MAX_LINKS_TO_RESOLVE);
  const settled = await Promise.allSettled(
    capped.map((link) => resolveOne(link, currency, knownBadDomains.has(hostnameOf(link.url))))
  );
  return settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          retailer: capped[i].retailer,
          url: capped[i].url,
          price: null,
          currency,
          inStock: null,
          imageUrl: null,
          lastChecked: new Date().toISOString(),
          source: "unresolved" as const,
          isDirectProduct: capped[i].isDirectProduct,
        }
  );
}
