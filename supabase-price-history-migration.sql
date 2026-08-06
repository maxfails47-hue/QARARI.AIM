-- ============================================================
-- PRICE HISTORY (Phase 3 foundation for real BUY NOW / WAIT verdicts)
-- One row per store price reading. Populated two ways:
--   1. Every real /api/search call snapshots the live prices it just
--      read (zero extra cost — those pages are already open).
--   2. The daily cron re-checks every product_key seen before, so
--      history keeps growing even for products nobody re-searches.
--
-- /api/search reads from this table to compute lowestEver / average90d /
-- highestEver — but only once there's enough real data (see
-- api/_priceHistory.ts). Never fabricated, never backfilled with guesses.
-- ============================================================
create table if not exists public.price_history (
  id bigint generated always as identity primary key,
  product_key text not null,        -- normalized product name, same key /api/search already uses
  retailer text not null,
  url text not null,
  price numeric not null,
  currency text not null,
  in_stock boolean,
  checked_at timestamptz not null default now()
);

create index if not exists price_history_product_key_checked_at_idx
  on public.price_history (product_key, checked_at desc);

-- RLS enabled with NO policies — this table is written/read only by the
-- backend via the Service Role Key (see search.ts / cron/daily.ts), never
-- from the browser. Matches the fix in
-- supabase-lockdown-backend-only-tables-migration.sql: an RLS-enabled
-- table with zero policies denies all anon/authenticated access by
-- default, closing the direct-REST-API hole that "no RLS needed, backend
-- only" mistakenly left open elsewhere in this project before.
alter table public.price_history enable row level security;
