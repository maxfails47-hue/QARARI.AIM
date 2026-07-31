-- ============================================================
-- CRITICAL SECURITY FIX — LOCK DOWN "BACKEND-ONLY" TABLES
-- ============================================================
-- Several tables across the earlier migrations were created WITHOUT Row
-- Level Security, with comments like "No RLS needed — only touched by the
-- backend (Service Role Key)". That reasoning is a common Supabase mistake:
-- the Service Role Key does bypass RLS, but "the frontend code never calls
-- this table" does NOT mean the table is private. Every Supabase project
-- ships a public `anon` key inside the browser bundle (visible in any
-- Network tab), and by default Supabase grants anon/authenticated roles
-- SELECT/INSERT/UPDATE/DELETE on every table in the `public` schema. RLS is
-- the ONLY thing that gate keeps that access — with it disabled, anyone in
-- the world can call the Supabase REST endpoint directly (no login, no app,
-- just the public anon key) and freely read or write these tables.
--
-- Concretely, before this fix, anyone could have:
--   • Reset their own device_usage_logs / guest_usage row to 0, silently
--     defeating the entire anti-abuse quota system built specifically to
--     stop that.
--   • Overwritten chat_usage / advisor_usage counters to bypass the
--     paid-tier chat message caps.
--   • Inserted fake rows into product_price_events / analysis_cache,
--     poisoning the "genuine community price" data and cached AI results
--     shown to every future visitor.
--   • Tampered with or read admin_audit_log / ai_usage_log / cron_logs —
--     internal, sensitive operational data.
--   • Overwritten noon_affiliate_links.affiliate_url, redirecting users who
--     click a retailer link to an attacker-controlled URL.
--
-- Fix: enable RLS on every one of these tables with NO policies attached.
-- An RLS-enabled table with zero policies denies ALL access to the `anon`
-- and `authenticated` roles by default — while the Service Role Key used
-- server-side in /api routes keeps working exactly as before, since it
-- bypasses RLS entirely regardless of policies. Nothing in the app changes
-- behavior; this only closes the direct-REST-API hole.
-- ============================================================

alter table public.analysis_cache        enable row level security;
alter table public.chat_usage            enable row level security;
alter table public.product_price_events  enable row level security;
alter table public.device_usage_logs     enable row level security;
alter table public.guest_device_aliases  enable row level security;
alter table public.admin_audit_log       enable row level security;
alter table public.guest_usage           enable row level security;
alter table public.ai_usage_log          enable row level security;
alter table public.cron_logs             enable row level security;
alter table public.advisor_usage         enable row level security;
alter table public.noon_affiliate_links  enable row level security;

-- Note: comparison_history and user_interests already had correct RLS +
-- policies from their own migrations — nothing to change there.
