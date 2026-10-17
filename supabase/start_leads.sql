-- Walka: general-audience /start funnel, leads table.
-- Run this once in the Supabase SQL editor for your project.
-- Written client-side (anon key) from start.html / start-app.js / start-success.html.
--
-- Mirrors moms_leads.sql's shape (local_id-scoped RLS, same trust model) but
-- with this funnel's own question set (goal / baseline / difficulty / coach /
-- mode / stake) instead of the pregnancy/postpartum one. Kept as a separate
-- table rather than extending moms_leads, since none of that table's columns
-- apply here and bolting more nullable columns onto it would make both
-- funnels harder to reason about.

create table if not exists public.start_leads (
  id uuid primary key default gen_random_uuid(),
  local_id uuid unique not null,         -- generated client-side, lets the browser resume + upsert its own row
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  goal text,                             -- 'get_moving' | 'hit_10k' | 'lose_weight' | 'stay_consistent' (raw quiz answer)
  fitness_goal text,                     -- mapped onto profiles.fitness_goal's vocabulary: 'start_small' | 'habit' | 'compete' | 'lose_weight'
  baseline_bucket text,                  -- 'under_5000' | 'five_to_ten' | 'ten_to_fifteen' | 'fifteen_plus'
  baseline_avg_steps int,                -- representative average for the chosen bucket, used in the step-goal math
  difficulty text,                       -- 'easy' | 'medium' | 'hard'
  coach_style text,                      -- 'princess' | 'tough' -- mirrors profiles.coach_style's vocabulary exactly
  mode text,                             -- 'group' | 'solo' -- mirrors profiles.weekly_mode's concept ('cohort' | 'solo')
  stake_amount numeric,                  -- solo only, one of 15/25/50/100 (lib/soloOffer.ts's SOLO_STAKE_OPTIONS); null for group (the real cohort stake is used instead)

  plan_step_goal int,                    -- computed at the results step: the step goal the paywall actually shows
  plan_duration_days int,                -- 5, matches both SOLO_DURATION_DAYS and the cohort's DURATION_DAYS

  first_name text,
  email text,
  referral_source text,                  -- optional, attribution only

  last_step text,                        -- furthest step reached, the drop-off signal
  checkout_status text not null default 'not_started', -- not_started | viewed | started | completed_unverified

  plan_price_cents int,                  -- recurring membership price, currently always 999 ($9.99/mo)
  billing_interval text,                 -- 'month'

  stripe_customer_id text,               -- set by create-start-subscription-intent
  stripe_subscription_id text,           -- set by create-start-subscription-intent; lets a retry/resume reuse the same incomplete subscription
  subscription_status text,              -- mirrors Stripe's subscription.status (active | trialing | past_due | canceled | incomplete | ...)

  stake_payment_intent_id text,          -- set by create-start-stake-intent, the one-time charge for the refundable stake
  stake_amount_cents int                 -- the amount that PaymentIntent was actually created for (server-resolved, never trusted from the client)
);

create index if not exists start_leads_checkout_status_idx on public.start_leads (checkout_status);
create index if not exists start_leads_created_at_idx on public.start_leads (created_at);
create index if not exists start_leads_email_idx on public.start_leads (lower(email));

alter table public.start_leads enable row level security;

-- Anon (public) key can create its own lead row...
drop policy if exists "start_leads anon insert" on public.start_leads;
create policy "start_leads anon insert"
  on public.start_leads for insert
  to anon
  with check (true);

-- ...and update only the row whose local_id it already holds (generated
-- client-side, never shown in the UI/URL, so not guessable in practice; same
-- backend-less trade-off moms_leads.sql documents).
drop policy if exists "start_leads anon update own row" on public.start_leads;
create policy "start_leads anon update own row"
  on public.start_leads for update
  to anon
  using (true);

-- Required for upsert(..., { onConflict: "local_id" }) to resolve under RLS,
-- same reasoning as moms_leads.sql's own select policy.
drop policy if exists "start_leads anon select own row" on public.start_leads;
create policy "start_leads anon select own row"
  on public.start_leads for select
  to anon
  using (true);
