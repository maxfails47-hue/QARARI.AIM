-- ============================================================
-- PREMIUM CHAT — MONTHLY USAGE CAP (150 messages/month)
-- Premium subscribers previously had truly unlimited chat (both the
-- Report-screen "Ask Assistant" bubble AND the open Shopping Advisor),
-- with zero cost ceiling since every message is still a real Groq call.
-- This adds the same kind of counter/reset pair that
-- compares_used_this_month / compares_reset_at already provide for
-- Compare (see supabase-compare-limit-migration.sql), so /api/ask.ts can
-- enforce a single shared 150/month fair-use cap across both chat modes
-- for Premium users. Free/guest users keep their existing separate caps
-- (20 messages/report, 20 advisor messages/month) unchanged.
-- ============================================================
alter table public.users
  add column if not exists premium_chat_used_this_month int not null default 0,
  add column if not exists premium_chat_reset_at timestamptz not null default now();
