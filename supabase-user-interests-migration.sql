-- ============================================================
-- USER INTERESTS TABLE (Smart Memory System)
-- Stores the user's shopping interests, recent searches, and favorite products.
-- Updated automatically after each advisor interaction by /api/ask.ts
-- ============================================================
create table if not exists public.user_interests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  categories text[] not null default '{}',
  recent_searches text[] not null default '{}',
  favorite_products text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Advisor usage tracking (monthly)
create table if not exists public.advisor_usage (
  identity text primary key,
  messages_used int not null default 0,
  reset_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- RLS: users can only see/update their own interests
alter table public.user_interests enable row level security;

create policy "Users can view own interests" on public.user_interests
  for select using (auth.uid() = user_id);

create policy "Users can update own interests" on public.user_interests
  for update using (auth.uid() = user_id);

create policy "Users can insert own interests" on public.user_interests
  for insert with check (auth.uid() = user_id);
