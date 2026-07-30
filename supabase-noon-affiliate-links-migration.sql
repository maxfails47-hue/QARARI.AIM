-- Cache + work-queue table for Noon affiliate deep links.
--
-- Why this exists: Noon doesn't grant affiliate API access to brand-new
-- sites without traffic history, so links are generated offline via
-- scripts/noonAffiliateAutomation.ts (Playwright) instead of a live API
-- call. This table is the hand-off point between that offline script and
-- the live /api/analyze request path:
--   - analyze.ts only ever READS from this table (never blocks on writes)
--   - the offline script is the only thing that ever sets status='done'
--
-- Completely separate from analysis_cache / pricing tables — touching this
-- table can never affect marketFairPriceMin/Max/Mid or any other analysis
-- field.

create table if not exists noon_affiliate_links (
  product_url text primary key,
  affiliate_url text,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_noon_affiliate_links_status on noon_affiliate_links (status);
