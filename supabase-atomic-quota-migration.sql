-- ============================================================
-- ATOMIC QUOTA ENFORCEMENT (fixes race-condition quota bypass)
-- ============================================================
-- PROBLEM: every quota check in the app used to be "read the counter in
-- JS, compare to the limit, do the expensive work, THEN write counter+1
-- back" as three separate round-trips. Two (or twenty) concurrent
-- requests from the same user/device/IP all read the same starting
-- value before any of them had written back, so all of them passed the
-- check and all of them ran — silently blowing through the free-tier
-- limit (3/month), a paid plan's limit, or the chat/compare limits, and
-- burning real Groq/Tavily API cost on every request past the cap.
--
-- FIX: each function below does the "is there room? if so, take it" as
-- a single atomic SQL statement (a row-level UPDATE ... WHERE used <
-- limit, guarded by SELECT ... FOR UPDATE for the upsert-style tables).
-- Postgres serializes concurrent writers to the same row, so only as
-- many concurrent callers as there is real remaining quota can ever
-- succeed — the rest get `false` back immediately, no matter how many
-- requests land in the same instant.
--
-- All functions return boolean: true = the increment happened and the
-- caller may proceed; false = quota was already exhausted, do not
-- proceed (and do not run the paid AI call).
-- ============================================================

-- ---- 1. Signed-in user scans (free monthly reset OR premium no-reset) ----
-- p_do_monthly_reset: true for free tier (calendar-month reset), false for
-- premium (quota only refills on admin-approved renewal).
create or replace function public.increment_user_scans(
  p_user_id uuid,
  p_limit int,
  p_do_monthly_reset boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
  v_reset_at timestamptz;
  v_now timestamptz := now();
  v_needs_reset boolean;
begin
  select scans_used_this_month, scans_reset_at into v_used, v_reset_at
  from public.users
  where id = p_user_id
  for update;

  if not found then
    return false;
  end if;

  v_needs_reset := p_do_monthly_reset
    and (date_trunc('month', v_reset_at) <> date_trunc('month', v_now));

  if v_needs_reset then
    v_used := 0;
  end if;

  if v_used >= p_limit then
    if v_needs_reset then
      update public.users set scans_used_this_month = 0, scans_reset_at = v_now where id = p_user_id;
    end if;
    return false;
  end if;

  update public.users
  set scans_used_this_month = v_used + 1,
      scans_reset_at = case when v_needs_reset then v_now else scans_reset_at end
  where id = p_user_id;

  return true;
end;
$$;

-- ---- 2. Signed-in user compares (premium-only, no calendar reset) ----
create or replace function public.increment_user_compares(
  p_user_id uuid,
  p_limit int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  select compares_used_this_month into v_used
  from public.users
  where id = p_user_id
  for update;

  if not found or v_used >= p_limit then
    return false;
  end if;

  update public.users set compares_used_this_month = v_used + 1 where id = p_user_id;
  return true;
end;
$$;

-- ---- 3. Premium advisor-chat monthly counter (no calendar reset) ----
create or replace function public.increment_premium_chat(
  p_user_id uuid,
  p_limit int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  select premium_chat_used_this_month into v_used
  from public.users
  where id = p_user_id
  for update;

  if not found or v_used >= p_limit then
    return false;
  end if;

  update public.users set premium_chat_used_this_month = v_used + 1 where id = p_user_id;
  return true;
end;
$$;

-- ---- 4. Free/guest advisor-mode chat (identity = "user:<uuid>" or "ip:<addr>", monthly reset) ----
create or replace function public.increment_advisor_usage(
  p_identity text,
  p_limit int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
  v_reset_at timestamptz;
  v_now timestamptz := now();
  v_needs_reset boolean;
begin
  insert into public.advisor_usage (identity, messages_used, reset_at)
  values (p_identity, 0, v_now)
  on conflict (identity) do nothing;

  select messages_used, reset_at into v_used, v_reset_at
  from public.advisor_usage
  where identity = p_identity
  for update;

  v_needs_reset := date_trunc('month', v_reset_at) <> date_trunc('month', v_now);
  if v_needs_reset then
    v_used := 0;
  end if;

  if v_used >= p_limit then
    if v_needs_reset then
      update public.advisor_usage set messages_used = 0, reset_at = v_now where identity = p_identity;
    end if;
    return false;
  end if;

  update public.advisor_usage
  set messages_used = v_used + 1,
      reset_at = case when v_needs_reset then v_now else reset_at end
  where identity = p_identity;

  return true;
end;
$$;

-- ---- 5. Per-report chat (fixed 20/report, every tier, no monthly reset) ----
create or replace function public.increment_chat_usage(
  p_report_id text,
  p_identity text,
  p_limit int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  insert into public.chat_usage (report_id, identity, messages_used)
  values (p_report_id, p_identity, 0)
  on conflict (report_id, identity) do nothing;

  select messages_used into v_used
  from public.chat_usage
  where report_id = p_report_id and identity = p_identity
  for update;

  if v_used >= p_limit then
    return false;
  end if;

  update public.chat_usage
  set messages_used = v_used + 1, updated_at = now()
  where report_id = p_report_id and identity = p_identity;

  return true;
end;
$$;

-- ---- 6. Guest scans, device-fingerprint based (primary guest tracking) ----
create or replace function public.increment_device_scan(
  p_fingerprint text,
  p_ip text,
  p_reset_at timestamptz,
  p_limit int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
begin
  insert into public.device_usage_logs (device_fingerprint, ip_address, scans_used_this_month, scans_reset_at, last_seen_at)
  values (p_fingerprint, p_ip, 0, p_reset_at, now())
  on conflict (device_fingerprint, scans_reset_at) do nothing;

  select scans_used_this_month into v_used
  from public.device_usage_logs
  where device_fingerprint = p_fingerprint and scans_reset_at = p_reset_at
  for update;

  if v_used >= p_limit then
    return false;
  end if;

  update public.device_usage_logs
  set scans_used_this_month = v_used + 1, ip_address = p_ip, last_seen_at = now()
  where device_fingerprint = p_fingerprint and scans_reset_at = p_reset_at;

  return true;
end;
$$;

-- ---- 7. Guest scans, legacy IP-only fallback (monthly reset) ----
create or replace function public.increment_ip_scan(
  p_ip text,
  p_limit int
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used int;
  v_reset_at timestamptz;
  v_now timestamptz := now();
  v_needs_reset boolean;
begin
  insert into public.guest_usage (ip_address, scans_used_this_month, scans_reset_at, updated_at)
  values (p_ip, 0, v_now, v_now)
  on conflict (ip_address) do nothing;

  select scans_used_this_month, scans_reset_at into v_used, v_reset_at
  from public.guest_usage
  where ip_address = p_ip
  for update;

  v_needs_reset := date_trunc('month', v_reset_at) <> date_trunc('month', v_now);
  if v_needs_reset then
    v_used := 0;
  end if;

  if v_used >= p_limit then
    if v_needs_reset then
      update public.guest_usage set scans_used_this_month = 0, scans_reset_at = v_now, updated_at = v_now where ip_address = p_ip;
    end if;
    return false;
  end if;

  update public.guest_usage
  set scans_used_this_month = v_used + 1,
      scans_reset_at = case when v_needs_reset then v_now else scans_reset_at end,
      updated_at = v_now
  where ip_address = p_ip;

  return true;
end;
$$;

-- These are only ever called from backend code using the service role
-- key (see api/_supabaseAdmin.ts), same trust boundary as every other
-- table in this file — no anon/authenticated grant needed.
