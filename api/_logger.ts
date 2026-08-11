// ============================================================================
// Shared debug/trace logger.
//
// This file exists purely to make every serverless-function failure visible
// in Vercel Logs. It does NOT change any business logic, response shape, or
// status codes returned to the client — it only adds console.log/error
// breadcrumbs plus a couple of small wrapper utilities so every route logs
// the same way instead of re-inventing ad-hoc console.log calls.
//
// Nothing here should ever throw on its own — a logging failure must never
// become the reason a request fails.
// ============================================================================

/** Simple boxed step marker, e.g. logStep("Calling Tavily..."). */
export function logStep(step: string) {
  console.log("");
  console.log("==========");
  console.log(step);
  console.log(new Date().toISOString());
  console.log("==========");
}

/** Called once at the very top of every handler. */
export function logRequestStart(req: { url?: string; method?: string }) {
  console.log("========== REQUEST START ==========");
  console.log("Route:", req.url);
  console.log("Method:", req.method);
  console.log("Time:", new Date().toISOString());
  const mem = safeMemoryUsage();
  if (mem) console.log("Memory (rss MB):", mem);
}

/** Called right before returning a 2xx response. */
export function logRequestSuccess(startedAt: number) {
  console.log("========== SUCCESS ==========");
  console.log("Execution Time:", Date.now() - startedAt, "ms");
  const mem = safeMemoryUsage();
  if (mem) console.log("Memory (rss MB):", mem);
  console.log("=============================");
}

/** Called from the outermost catch of every handler, before responding. */
export function logUnhandledError(error: any, startedAt?: number) {
  console.error("==========================");
  console.error("UNHANDLED ERROR");
  console.error(error);
  console.error(error?.stack);
  if (typeof startedAt === "number") {
    console.error("Failed after:", Date.now() - startedAt, "ms");
  }
  console.error("==========================");
}

/** Prints which required env vars exist WITHOUT ever printing their values. */
export function logEnvPresence(vars: Record<string, string | undefined>) {
  console.log("---- ENV VAR PRESENCE ----");
  for (const [name, value] of Object.entries(vars)) {
    console.log(`${name}:`, !!value);
  }
  console.log("---------------------------");
}

function safeMemoryUsage(): number | null {
  try {
    // process.memoryUsage() is available in the Vercel Node runtime.
    return Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Wraps a fetch() call with full request/response tracing:
 * - logs URL, method, status, elapsed ms
 * - on non-ok status, logs the full response body before returning it
 * - on network/throw failure, logs the error + stack and re-throws
 *
 * Does NOT change response handling — callers still get back the raw
 * Response object exactly as fetch() would have returned it, so all
 * existing .ok / .status / .json() / .text() call sites keep working
 * unchanged.
 */
export async function loggedFetch(
  label: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const method = init?.method || "GET";
  const start = Date.now();
  console.log(`[fetch:${label}] -> ${method} ${url}`);
  try {
    const response = await fetch(url, init);
    const elapsed = Date.now() - start;
    console.log(`[fetch:${label}] <- ${response.status} ${url} (${elapsed}ms)`);
    if (!response.ok) {
      // Clone so the caller can still read the body themselves afterwards.
      try {
        const clone = response.clone();
        const bodyText = await clone.text();
        console.error(`[fetch:${label}] NON-OK RESPONSE BODY:`, bodyText);
      } catch (readErr) {
        console.error(`[fetch:${label}] Failed to read error response body:`, readErr);
      }
    }
    return response;
  } catch (error: any) {
    const elapsed = Date.now() - start;
    console.error(`[fetch:${label}] THREW after ${elapsed}ms`);
    console.error(`[fetch:${label}] URL:`, url);
    console.error(`[fetch:${label}] ERROR:`, error);
    console.error(`[fetch:${label}] STACK:`, error?.stack);
    throw error;
  }
}

/**
 * Wraps JSON.parse with full context logging on failure — prints the exact
 * raw text that failed to parse so a bad AI response is never a mystery.
 */
export function loggedJsonParse(label: string, text: string): any {
  try {
    return JSON.parse(text);
  } catch (error: any) {
    console.error(`[jsonParse:${label}] JSON PARSE FAILED`);
    console.error(`[jsonParse:${label}] RAW TEXT:`, text);
    console.error(`[jsonParse:${label}] ERROR:`, error);
    console.error(`[jsonParse:${label}] STACK:`, error?.stack);
    throw error;
  }
}
