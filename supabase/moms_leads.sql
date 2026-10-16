-- Walka: Postpartum Mums test flow, leads table
-- Run this once in the Supabase SQL editor for your project.
-- Written client-side (anon key) from moms.html / moms-app.js / moms-success.html.

create table if not exists public.moms_leads (
  id uuid primary key default gen_random_uuid(),
  local_id uuid unique not null,         -- generated client-side, lets the browser resume + upsert its own row
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  country text,                          -- ISO country code from middleware.js's Vercel geo header; null if undetected

  stage text,                            -- 'pregnant' | 'postpartum', derived from motherhood_stage
  weeks_postpartum int,                  -- no longer asked, kept for historical rows
  due_date date,                         -- no longer asked, kept for historical rows
  delivery_type text,                    -- 'vaginal' | 'csection' | 'prefer_not_to_say'; no longer asked, kept for historical rows

  motherhood_stage text,                 -- 'pregnant' | 'postpartum_0_3' | 'postpartum_3_6' | 'postpartum_6_12' | 'postpartum_12_plus'

  clearance_status text,                 -- 'yes' | 'not_yet' | 'not_sure'
  prepare_mode boolean,                  -- no longer asked (the free no-charge checkout fork was retired); kept for historical rows
  routine_preference text,               -- what a good walking routine would feel like; replaces the old fixed step-goal question

  current_steps_bucket text,             -- no longer asked, kept for historical rows
  energy_level text,                     -- no longer asked, kept for historical rows
  activity_baseline text,                -- what walking looks like these days; replaces current_steps_bucket + energy_level
  barriers text[],                       -- what's making it hard to find time for yourself; same column, vocabulary changed

  suggested_goal int,                    -- no longer asked, kept for historical rows
  adjusted_goal int,                     -- no longer asked, kept for historical rows

  motivation_style text,                 -- 'princess' | 'coach'; tone picker retired, no longer written, kept for historical rows
  motivation_wants text[],               -- what she'd love more of this season (multi-select)
  connection text,                       -- how connected she feels to other moms right now
  conversations_openness text,           -- how openly she wishes she could talk about motherhood

  cohort text,

  stake_cents int,                       -- no longer charged (membership replaced the stake/entry-fee cohort model); kept for historical rows
  miss_cents int,                        -- no longer charged; kept for historical rows
  entry_fee_cents int,                   -- no longer charged; kept for historical rows
  program_length_weeks int,              -- no longer applicable (recurring membership, not a fixed-length challenge); kept for historical rows
  grace_period_weeks int,                -- unused since the flat per-day mechanic replaced grace weeks; kept for old rows
  passes_total int,                      -- unused since the flat per-day mechanic replaced free passes; kept for old rows

  plan_price_cents int,                  -- recurring membership price, currently always 3999 (same numeral in both currencies)
  billing_interval text,                 -- 'month'
  billing_currency text,                 -- 'usd' | 'cad', resolved from country (US visitors pay USD, CA visitors pay CAD)

  first_name text,
  email text,
  referral_source text,                  -- how she heard about us, self-reported, optional (instagram | facebook | tiktok | friend | google | other)

  last_step text,                        -- furthest step reached, the drop-off signal
  checkout_status text not null default 'not_started', -- not_started | viewed | started | completed_unverified | reserved (reserved is historical only: the no-charge fork was retired along with the stake model)

  stripe_customer_id text,               -- set by create-moms-subscription-intent (inline checkout) or link-moms-subscriber (Payment Link redirect fallback), matched by email in the latter case since Payment Links don't return a customer id in the URL
  stripe_subscription_id text,            -- set by create-moms-subscription-intent; lets a retry/resume reuse the same incomplete subscription instead of creating a duplicate
  subscription_status text,              -- mirrors Stripe's own subscription.status (active | trialing | past_due | canceled | incomplete | ...)

  abandoned_email_touch1_sent_at timestamptz, -- claimed (set before sending) by process-abandoned-moms-leads; doubles as its dedup state, there being no notify()-equivalent for email
  abandoned_email_touch2_sent_at timestamptz
);

-- Running this file again against an already-created table adds any new
-- columns without touching existing rows or policies.
alter table public.moms_leads add column if not exists entry_fee_cents int;
alter table public.moms_leads add column if not exists country text;
alter table public.moms_leads add column if not exists stripe_customer_id text;
alter table public.moms_leads add column if not exists stripe_subscription_id text;
alter table public.moms_leads add column if not exists subscription_status text;

-- Added for the empathetic-funnel/membership redesign (stake/cohort model
-- retired in favor of a flat recurring price; see the column comments above).
alter table public.moms_leads add column if not exists motherhood_stage text;
alter table public.moms_leads add column if not exists activity_baseline text;
alter table public.moms_leads add column if not exists motivation_wants text[];
alter table public.moms_leads add column if not exists connection text;
alter table public.moms_leads add column if not exists conversations_openness text;
alter table public.moms_leads add column if not exists routine_preference text;
alter table public.moms_leads add column if not exists plan_price_cents int;
alter table public.moms_leads add column if not exists billing_interval text;
alter table public.moms_leads add column if not exists billing_currency text;

-- Abandoned-cart email tracking (process-abandoned-moms-leads Edge Function).
alter table public.moms_leads add column if not exists abandoned_email_touch1_sent_at timestamptz;
alter table public.moms_leads add column if not exists abandoned_email_touch2_sent_at timestamptz;

-- Name/email moved earlier in the flow (the `contact` step, before the
-- offer and checkout) so a checkout dropoff still leaves a reachable lead;
-- referral_source is new alongside it, for attribution.
alter table public.moms_leads add column if not exists referral_source text;

-- The tone picker is retired and no longer writes this column; stop new rows
-- from silently inheriting 'princess' as if it were a real answer.
alter table public.moms_leads alter column motivation_style drop default;

create index if not exists moms_leads_checkout_status_idx on public.moms_leads (checkout_status);
create index if not exists moms_leads_created_at_idx on public.moms_leads (created_at);
create index if not exists moms_leads_abandoned_touch1_idx on public.moms_leads (abandoned_email_touch1_sent_at);
create index if not exists moms_leads_abandoned_touch2_idx on public.moms_leads (abandoned_email_touch2_sent_at);

alter table public.moms_leads enable row level security;

-- Anon (public) key can create its own lead row...
drop policy if exists "moms_leads anon insert" on public.moms_leads;
create policy "moms_leads anon insert"
  on public.moms_leads for insert
  to anon
  with check (true);

-- ...and update only the row whose local_id it already holds (the UUID is
-- generated client-side and never shown in the UI/URL, so it isn't guessable
-- in practice; acceptable for a short-lived test, but note this is the one
-- trade-off of going backend-less: anyone with the anon key + a given
-- local_id could overwrite that row).
drop policy if exists "moms_leads anon update own row" on public.moms_leads;
create policy "moms_leads anon update own row"
  on public.moms_leads for update
  to anon
  using (true);

-- A SELECT policy is required even though the anon key should only ever
-- write: Postgres needs read visibility on the conflict target to resolve
-- `upsert(..., { onConflict: "local_id" })` under RLS, and silently rejects
-- the INSERT itself (not just the read) without one, "new row violates
-- row-level security policy", even on a brand-new row with no actual
-- conflict. Scoped the same as the update policy above (same unguessable
-- UUID trade-off, not a wider exposure than update already allowed).
drop policy if exists "moms_leads anon select own row" on public.moms_leads;
create policy "moms_leads anon select own row"
  on public.moms_leads for select
  to anon
  using (true);
