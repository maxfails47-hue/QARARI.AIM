-- ============================================================
-- CRITICAL SECURITY FIX — COLUMN-LEVEL WRITE RESTRICTION ON public.users
-- ============================================================
-- The existing RLS policy "Users can update own profile" only checks row
-- ownership (auth.uid() = id) — it does NOT restrict which columns can be
-- changed. Since the app talks to Supabase directly from the browser with
-- the user's own session (anon key), any signed-in user could open the
-- browser console and run, e.g.:
--
--   supabase.from('users').update({
--     tier: 'premium',
--     scans_limit_this_month: 999999,
--     can_export_pdf: true
--   }).eq('id', myOwnId)
--
-- ...and RLS would allow it, silently granting themselves premium access
-- and unlimited quota for free. This must be closed before launch.
--
-- Fix: use Postgres column-level GRANTs to allow the `authenticated` role
-- to update ONLY genuinely user-editable profile fields. Billing/quota/tier
-- fields stay writable only by the `service_role` key used server-side in
-- /api routes (service_role bypasses RLS and column grants entirely).
-- ============================================================

-- Remove blanket UPDATE privilege on all columns for authenticated users...
revoke update on public.users from authenticated;

-- ...and grant it back for only the columns a user should be able to edit
-- themselves (their own display profile — never tier, quotas, or money).
grant update (full_name, age, country, phone, interests) on public.users to authenticated;
