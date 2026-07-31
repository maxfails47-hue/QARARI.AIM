-- ============================================================
-- Change: the AI "does this look like a receipt?" check used to
-- HARD-BLOCK the upload outright when it said no — but the vision
-- model isn't reliable enough for that; a blurry-but-real receipt,
-- an unusual bank app layout, or a bad crop could get a false
-- "not a receipt" and turn away a paying customer with no way to
-- override it themselves.
--
-- New behavior: the AI check no longer blocks anything. Every
-- upload still reaches the pending_review queue for a human to
-- decide — but if the AI is unsure it's a receipt, the request is
-- flagged so admins see it clearly and can look closer, instead of
-- silently trusting or blindly rejecting it.
-- ============================================================

alter table public.subscription_requests
  add column if not exists ai_flagged boolean not null default false,
  add column if not exists ai_flag_reason text;
