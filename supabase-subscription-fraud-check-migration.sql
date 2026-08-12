-- ============================================================
-- SUBSCRIPTION PAYMENT SCREENSHOT — FRAUD-REDUCTION FIELDS
-- Run this in Supabase SQL Editor (Project → SQL Editor → New Query)
-- ============================================================
-- Purpose: support the AI pre-check added to /api/user?action=subscribe:
--   1. An AI vision call rejects uploads that don't visibly look like a
--      payment receipt (success mark + amount + reference number) before
--      the request ever reaches the admin queue.
--   2. The transaction reference number printed on the receipt is
--      extracted and stored, so the SAME real receipt can't be reused
--      across multiple subscription requests (the app-level check in
--      api/user.ts already blocks this; the unique index below is a
--      second, DB-level guarantee that can't be bypassed even if the
--      app-level check is ever skipped, e.g. during the AI-outage
--      fail-open path where extracted_reference stays null).
-- Both extracted fields are informational/anti-fraud only — they are
-- NEVER used to auto-approve a subscription. A human still reviews every
-- request in the admin panel exactly as before.
-- ============================================================

alter table public.subscription_requests
  add column if not exists extracted_reference text,
  add column if not exists extracted_amount numeric;

-- Partial unique index: only enforced when a reference number was actually
-- extracted (nulls are excluded, so the fail-open path — AI outage, or a
-- receipt with no visible reference number — never blocks a legitimate
-- request).
create unique index if not exists subscription_requests_extracted_reference_uidx
  on public.subscription_requests (extracted_reference)
  where extracted_reference is not null;
