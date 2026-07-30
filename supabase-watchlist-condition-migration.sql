-- Adds product condition to the watchlist so the daily price-drop cron
-- checks the SAME condition (new / likeNew / used) the user originally
-- priced — checking "new" prices for an item saved as "used" would produce
-- a meaningless comparison and could fire false price-drop emails.
alter table public.watchlist add column if not exists condition text not null default 'new';
