-- ============================================================
-- FIX: full_name was never saved when email confirmation is
-- required at signup.
--
-- Root cause: the client only wrote full_name to public.users via
-- a client-side UPDATE that ran *after* supabase.auth.signUp()
-- resolved with a session. When the Supabase project requires
-- email confirmation, signUp() resolves with NO session (the user
-- isn't logged in yet), so that UPDATE never ran and the name
-- typed at signup was lost for good — the row only ever got id,
-- email, and referral_code from the on_auth_user_created trigger.
--
-- Fix: the app now also passes full_name as auth user_metadata at
-- signUp() time (see options.data in supabase.auth.signUp). This
-- migration updates the trigger to read it from there and set
-- full_name at row-creation time, so it's captured regardless of
-- whether email confirmation is required.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, email, referral_code, full_name)
  values (
    new.id,
    new.email,
    substr(md5(random()::text), 1, 8),
    new.raw_user_meta_data ->> 'full_name'
  );
  return new;
end;
$$ language plpgsql security definer;

-- Backfill: any already-registered user whose row still has no
-- full_name, but who DID supply one in their auth metadata (e.g. if
-- they signed up, confirmed by email, and the name was captured in
-- metadata by a client build newer than their signup but before this
-- migration ran) gets it filled in. Harmless no-op for accounts that
-- never had a name in metadata either.
update public.users u
set full_name = a.raw_user_meta_data ->> 'full_name'
from auth.users a
where u.id = a.id
  and u.full_name is null
  and a.raw_user_meta_data ->> 'full_name' is not null;
