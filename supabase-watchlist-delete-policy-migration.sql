-- Watchlist "unfollow" now permanently deletes the row instead of a
-- soft-delete (active=false). The table previously only had
-- select/insert/update RLS policies, so a client-side .delete() call would
-- have been silently blocked by Row Level Security (RLS): PostgREST returns
-- HTTP 200 with zero affected rows and no error in that case, which is why
-- the product appeared to come back after a page reload — the delete never
-- actually happened. This policy lets a signed-in user delete only their
-- own watchlist rows.

drop policy if exists "Users can delete own watchlist" on public.watchlist;
create policy "Users can delete own watchlist"
  on public.watchlist
  for delete
  using (auth.uid() = user_id);
