-- ============================================================
-- CRITICAL FIX — MISSING PLAN LIMIT COLUMNS
-- api/admin.ts (handleApprove) writes scans_limit_this_month and
-- compares_limit_this_month, and api/user.ts / api/analyze.ts read them,
-- but no migration ever created these columns. Every premium quota check
-- (scans-remaining, compare-remaining, and the approve-subscription flow
-- itself) has been silently failing against Postgres with an "unknown
-- column" error. This must be run before launch.
-- ============================================================
alter table public.users
  add column if not exists scans_limit_this_month int,
  add column if not exists compares_limit_this_month int;
