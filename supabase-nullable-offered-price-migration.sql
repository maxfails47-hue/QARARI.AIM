-- ============================================================
-- QARARI.AI — Make offered_price nullable on public.analyses
-- Run this in Supabase SQL Editor (Project → SQL Editor → New Query)
--
-- Needed for the "مش عارف السعر؟" ("Don't know the price?") flow: the
-- user can submit an analysis without an offered price, in which case
-- the server stores offered_price as NULL.
-- ============================================================

alter table public.analyses
  alter column offered_price drop not null;
