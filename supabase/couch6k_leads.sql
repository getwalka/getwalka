-- Walka: "Couch to 6K" paid 6-week test-cohort funnel, leads table.
-- Run this once in the Supabase SQL editor for your project.
-- Written client-side (anon key) from couch6k.html / couch6k-app.js / couch6k-success.html.
--
-- Own table, not a reuse of start_leads: different question set (no
-- difficulty screen, a waitlist branch, no subscription/stake-picker
-- columns) and a different payment shape (one combined one-time
-- PaymentIntent instead of a subscription + optional stake). Mirrors
-- start_leads.sql's local_id-scoped RLS/upsert trust model exactly.

create table if not exists public.couch6k_leads (
  id uuid primary key default gen_random_uuid(),
  local_id uuid unique not null,         -- generated client-side, lets the browser resume + upsert its own row
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  country text,                          -- stamped from middleware.js's walka_geo_country cookie; logged whether allowed or blocked
  billing_currency text,                 -- 'usd' | 'cad', resolved from country

  goal text,                             -- 'build_habit' | 'hit_10k'(removed) ... | 'lose_weight' | 'stay_consistent' | 'get_moving' (see couch6k-copy.js's goal options)
  fitness_goal text,                     -- mapped onto profiles.fitness_goal's vocabulary
  baseline_bucket text,                  -- 'under_2k' | 'two_to_three' | 'three_to_five' | 'five_to_seven' | 'seven_plus'
  coach_style text,                      -- 'princess' | 'tough' -- mirrors profiles.coach_style's vocabulary exactly
  mode text,                             -- 'group' | 'solo', defaults to 'group' in the UI

  first_name text,
  email text,
  referral_source text,                  -- optional, attribution only

  last_step text,                        -- furthest step reached, the drop-off signal
  checkout_status text not null default 'not_started', -- not_started | viewed | started | waitlisted | completed_unverified

  stripe_payment_intent_id text,         -- set by create-couch6k-payment-intent, the single combined charge (stake + program fee)
  payment_amount_cents int,              -- the amount that PaymentIntent was actually created for (server-resolved constant, never trusted from the client)
  payment_status text,                  -- mirrors Stripe's PaymentIntent.status; 'succeeded' once link-couch6k-purchase confirms it
  paid_at timestamptz                    -- set by link-couch6k-purchase once Stripe confirms success
);

create index if not exists couch6k_leads_checkout_status_idx on public.couch6k_leads (checkout_status);
create index if not exists couch6k_leads_created_at_idx on public.couch6k_leads (created_at);
create index if not exists couch6k_leads_email_idx on public.couch6k_leads (lower(email));

alter table public.couch6k_leads enable row level security;

-- Anon (public) key can create its own lead row...
drop policy if exists "couch6k_leads anon insert" on public.couch6k_leads;
create policy "couch6k_leads anon insert"
  on public.couch6k_leads for insert
  to anon
  with check (true);

-- ...and update only the row whose local_id it already holds (generated
-- client-side, never shown in the UI/URL, so not guessable in practice; same
-- backend-less trade-off start_leads.sql documents).
drop policy if exists "couch6k_leads anon update own row" on public.couch6k_leads;
create policy "couch6k_leads anon update own row"
  on public.couch6k_leads for update
  to anon
  using (true);

-- Required for upsert(..., { onConflict: "local_id" }) to resolve under RLS,
-- same reasoning as start_leads.sql's own select policy.
drop policy if exists "couch6k_leads anon select own row" on public.couch6k_leads;
create policy "couch6k_leads anon select own row"
  on public.couch6k_leads for select
  to anon
  using (true);
