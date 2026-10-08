-- Walka: Postpartum Mums test flow, leads table
-- Run this once in the Supabase SQL editor for your project.
-- Written client-side (anon key) from moms.html / moms-app.js / moms-success.html.

create table if not exists public.moms_leads (
  id uuid primary key default gen_random_uuid(),
  local_id uuid unique not null,         -- generated client-side, lets the browser resume + upsert its own row
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  stage text,                            -- 'pregnant' | 'postpartum'
  weeks_postpartum int,
  due_date date,
  delivery_type text,                    -- 'vaginal' | 'csection' | 'prefer_not_to_say'

  clearance_status text,                 -- 'yes' | 'not_yet' | 'not_sure'
  prepare_mode boolean,

  current_steps_bucket text,
  energy_level text,                     -- 'low' | 'medium' | 'high'
  barriers text[],

  suggested_goal int,
  adjusted_goal int,

  motivation_style text default 'princess', -- 'princess' | 'coach'

  cohort text,

  stake_cents int,                       -- total stake: 1500 | 2500 | 5000 | 10000 (cohort is always 1500)
  miss_cents int,                        -- amount actually at risk per missed week, from that stake's miss options
  program_length_weeks int,              -- one-time payment, fixed-length challenge (not a subscription)
  grace_period_weeks int,
  passes_total int,                      -- free misses for the whole challenge, not recurring

  first_name text,
  email text,

  last_step text,                        -- furthest step reached, the drop-off signal
  checkout_status text not null default 'not_started' -- not_started | viewed | started | completed_unverified
);

create index if not exists moms_leads_checkout_status_idx on public.moms_leads (checkout_status);
create index if not exists moms_leads_created_at_idx on public.moms_leads (created_at);

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

-- No select policy for anon: the anon key can write but not read back leads.
-- View/export leads from the Supabase dashboard (Table Editor), which uses
-- the service role and bypasses RLS.
