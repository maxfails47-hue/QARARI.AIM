/**
 * Standalone OFFLINE automation. This is NOT deployed to Vercel and is not
 * part of the api/ serverless functions — it runs a real Chromium browser,
 * which serverless functions can't do reliably (cold-start time, package
 * size, execution limits). Run it manually or on a cron (your laptop, a
 * small VPS, a GitHub Action with a schedule — anything that isn't
 * Vercel's serverless runtime).
 *
 * What it does, every run:
 *   1. Reads all `pending` rows from the `noon_affiliate_links` table
 *      (queued automatically by api/_affiliateLinks.ts whenever /api/analyze
 *      sees a noon.com link it hasn't handled before)
 *   2. Opens Noon's affiliate Link Builder in a browser using your saved
 *      login session
 *   3. Pastes each product URL in, clicks Generate, reads back the
 *      s.noon.com short link
 *   4. Writes the result back to Supabase as status: 'done'
 *
 * Once you're approved for real API/traffic access from Noon, this whole
 * file gets deleted and _affiliateLinks.ts calls the API directly instead —
 * nothing else in the codebase needs to change, since analyze.ts only ever
 * reads from the noon_affiliate_links table.
 *
 * ---- ONE-TIME SETUP ----
 *   npm install -D playwright dotenv tsx
 *   npx playwright install chromium
 *
 * Add to .env (same Supabase service role key already used elsewhere):
 *   SUPABASE_URL=...
 *   SUPABASE_SERVICE_ROLE_KEY=...
 *
 * ---- LOG IN ONCE (saves your session so future runs never need to log in) ----
 *   HEADLESS=false npx tsx scripts/noonAffiliateAutomation.ts --login-only
 *   (a real browser window opens — log in by hand, including any OTP/2FA,
 *    then come back to the terminal and press Enter)
 *
 * ---- REGULAR RUNS (cron-friendly, headless) ----
 *   npx tsx scripts/noonAffiliateAutomation.ts
 *
 * ⚠️ FILL IN THE SELECTORS BELOW (marked TODO) after inspecting the real
 * Link Builder page in your affiliate dashboard: right-click the URL input
 * box → Inspect → copy a stable selector (id, name, or data-testid
 * attribute if there is one — those survive redesigns better than classes).
 * I can't see that page myself since it's behind your login, so these are
 * best-guess placeholders.
 */

import { chromium, type Page } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { existsSync } from "fs";
import "dotenv/config";

const SESSION_FILE = "noon-affiliate-session.json";
const HEADLESS = process.env.HEADLESS !== "false";
const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 50;

// Confirmed from the dashboard screenshot: platform is affiliates.noon.partners,
// affiliate ID AFFa72bbd56ad14, campaign "Everyday Campaign" — always-on
// (Apr 22 - Dec 31 2026, no deadline), so this campaign URL should stay
// valid long-term.
const LOGIN_URL = "https://affiliates.noon.partners/en/login"; // TODO: confirm — guessed pattern, adjust if different
const LINK_BUILDER_URL = "https://affiliates.noon.partners/en/AFFa72bbd56ad14/campaigns/CMP2ce0b63a6a1anoon";

// The campaign page loads on an overview — the "Links" tab needs a click
// before the URL-input form appears (it's not the default tab shown).
const LINKS_TAB_SELECTOR = 'button:has-text("Links"), [role="tab"]:has-text("Links")';

// TODO: replace these three after scrolling down past the "Links" heading
// on that page and inspecting the actual input/button/result elements
// (right-click -> Inspect). The screenshot cuts off right where the link
// generator form should start, so these are still best-guess.
const SELECTORS = {
  urlInput: 'input[placeholder*="product" i], input[placeholder*="url" i], input[name="url"]',
  generateButton: 'button:has-text("Generate"), button:has-text("Create")',
  resultLink: '[data-testid="generated-link"], input[readonly]',
};

const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function generateOneLink(page: Page, productUrl: string): Promise<string | null> {
  await page.goto(LINK_BUILDER_URL, { waitUntil: "networkidle" });

  // Land on the campaign overview — click into the Links tab first.
  await page.locator(LINKS_TAB_SELECTOR).first().click();
  await page.waitForTimeout(500);

  const input = page.locator(SELECTORS.urlInput).first();
  await input.fill(productUrl);
  await page.locator(SELECTORS.generateButton).first().click();

  const result = page.locator(SELECTORS.resultLink).first();
  await result.waitFor({ state: "visible", timeout: 15000 });

  const value = (await result.inputValue().catch(() => null)) ?? (await result.textContent());
  if (!value || !value.includes("s.noon.com")) return null;
  return value.trim();
}

async function loginOnly() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(LOGIN_URL);

  console.log("Log in by hand in the opened window (including OTP/2FA if asked).");
  console.log("Once you're looking at the affiliate dashboard, come back here and press Enter...");
  await new Promise((resolve) => process.stdin.once("data", resolve));

  await context.storageState({ path: SESSION_FILE });
  console.log(`Session saved to ${SESSION_FILE}. Re-run without --login-only from now on.`);
  await browser.close();
}

async function run() {
  if (!existsSync(SESSION_FILE)) {
    console.error(`No saved session found (${SESSION_FILE}). Run with --login-only first.`);
    process.exit(1);
  }

  const { data: pending, error } = await supabase
    .from("noon_affiliate_links")
    .select("product_url, attempts")
    .eq("status", "pending")
    .lt("attempts", MAX_ATTEMPTS)
    .limit(BATCH_SIZE);

  if (error) {
    console.error("Failed to load pending links:", error);
    process.exit(1);
  }

  if (!pending || pending.length === 0) {
    console.log("Nothing pending. Done.");
    return;
  }

  console.log(`Processing ${pending.length} pending links...`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ storageState: SESSION_FILE });
  const page = await context.newPage();

  for (const row of pending) {
    try {
      const affiliateUrl = await generateOneLink(page, row.product_url);
      if (!affiliateUrl) throw new Error("No s.noon.com link found on the page after generating");

      await supabase
        .from("noon_affiliate_links")
        .update({ affiliate_url: affiliateUrl, status: "done", updated_at: new Date().toISOString() })
        .eq("product_url", row.product_url);
      console.log(`OK: ${row.product_url} -> ${affiliateUrl}`);
    } catch (e) {
      const attempts = (row.attempts ?? 0) + 1;
      console.error(`FAILED (attempt ${attempts}/${MAX_ATTEMPTS}): ${row.product_url}`, e);
      await supabase
        .from("noon_affiliate_links")
        .update({
          attempts,
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
          updated_at: new Date().toISOString(),
        })
        .eq("product_url", row.product_url);
    }

    // Gentle pacing — don't hammer the dashboard back-to-back.
    await page.waitForTimeout(3000 + Math.random() * 2000);
  }

  await browser.close();
  console.log("Done.");
}

async function main() {
  if (process.argv.includes("--login-only")) {
    await loginOnly();
  } else {
    await run();
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
