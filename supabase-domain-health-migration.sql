-- ============================================================
-- DOMAIN HEALTH (price-resolution success tracking, cumulative)
--
-- api/_retailerPriceRetry.ts already computed a per-domain success/fail
-- tally EVERY cron run, but only ever logged it to console — it reset to
-- zero on the next invocation, so there was no lasting memory of "this
-- domain basically never resolves via plain fetch."
--
-- This table accumulates that signal permanently across every retry run
-- AND every live analyze.ts resolution, so api/_priceResolver.ts can look
-- it up before deciding which extraction path to try first for a given
-- domain (see routeReaderProxyFirst() in _priceResolver.ts) instead of
-- wasting the fetch+retry budget on a domain with a known ~0% success
-- rate via plain fetch.
-- ============================================================
create table if not exists public.domain_health (
  domain text primary key,          -- hostname, no "www." prefix (see hostnameOf())
  attempts int not null default 0,  -- cumulative resolution attempts logged
  fixed int not null default 0,     -- cumulative attempts that got a real price
  success_rate numeric not null default 0,
  updated_at timestamptz not null default now()
);

-- Backend-only table (service role key), same reasoning as
-- supabase-lockdown-backend-only-tables-migration.sql — RLS on, no policies.
alter table public.domain_health enable row level security;
