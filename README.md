# getwalka

Static marketing site (no framework, no build step) deployed on Vercel. Each
page is a self-contained `.html` file with its own inline `<style>`; routing
is just file-based plus the `/invite/:path*` rewrite in `vercel.json`.
PostHog is wired into every page for analytics.

## Postpartum Mums test flow (`/moms`)

A standalone, flagged-off onboarding + checkout experiment living alongside
the main site, built to test whether postpartum/pregnant mums will sign up
and commit under a gentler commitment mechanic. It does not touch the main
flow, legal copy, or stake logic.

Visitors see a landing screen (what Walka for new mums is, what's at stake,
roughly how long it takes) before any onboarding question, then the
step-by-step wizard. Resuming a started session skips straight back to the
wizard, no landing page again.

Files:
- `moms.html`: the route itself (page shell, styles, landing + step markup
  containers).
- `moms-copy.js`: **every** piece of copy and every tunable config value
  (feature flag key, Stripe links/mode, stake tiers, grace period, passes,
  goal-suggestion math, tone copy for "princess"/"coach"). Edit this file,
  not the others, to change wording or mechanics.
- `moms-app.js`: the step engine (state machine, validation, resume,
  analytics, Supabase sync, Stripe handoff). Shouldn't contain user-facing
  strings.
- `moms-success.html`: where Stripe redirects after a successful test-mode
  payment.
- `supabase/moms_leads.sql`: schema + RLS policy for the leads table (run
  once in the Supabase SQL editor).

### Enabling / disabling the flow

Gated by a PostHog feature flag (PostHog is already on every page):
1. In the PostHog dashboard, create a feature flag with the key
   `moms-postpartum-flow` (see `FEATURE_FLAG_KEY` in `moms-copy.js`) and
   release it to whoever should see the test.
2. If PostHog can't be reached (blocked, slow), the page **fails closed**:
   visitors see a plain "not open yet" message, never a broken flow.
3. To share a test link before the flag is rolled out, open
   `/moms?preview=1` once in a browser. That unlocks the flow on that
   device via `localStorage`, regardless of the flag. `/moms?preview=0`
   removes the override.

### Payments: Stripe, test mode by default

This is a one-time payment for a fixed-length challenge, not a
subscription. There's no payment backend in this repo, so checkout hands
off to Stripe-hosted **Payment Links**; we never touch card data ourselves.
1. In the Stripe **test mode** dashboard, create one **one-time price**
   Payment Link per stake tier in `moms-copy.js` → `STAKE_TIERS` (currently
   $15 / $25 / $50 / $100). Do not use a recurring/subscription price.
2. In each Payment Link's settings, set "After payment" → redirect to your
   own URL → `https://getwalka.com/moms-success`.
3. Paste the resulting `https://buy.stripe.com/test_...` URL into that
   tier's `links.test` in `moms-copy.js`.
4. To go live later: create the equivalent live-mode Payment Links, fill in
   `links.live`, and flip `STRIPE_MODE` from `"test"` to `"live"`. That's
   the entire switch.

Card test number: `4242 4242 4242 4242`, any future expiry, any CVC.

### The stake mechanic

All in `moms-copy.js`:
- `PROGRAM_LENGTH_WEEKS`: how long the challenge runs (currently 8 weeks).
  A placeholder default, since the brief didn't specify one; tune this to
  the real program length.
- `COHORT_STAKE_AMOUNT_CENTS`: fixed stake for cohort members (currently
  $15), no choice shown.
- `STAKE_TIERS`: the total stake solo members choose from (currently $15 /
  $25 / $50 / $100). Each tier has its own Stripe Payment Link (price must
  match `amountCents`) and its own `missOptions`, the amount actually at
  risk per missed week (e.g. the $15 tier offers $1 / $2 / $3).
- `GRACE_PERIOD_WEEKS`: weeks after joining with nothing at risk.
- `LIFE_HAPPENED_PASSES_TOTAL`: free misses for the whole challenge
  (currently 4). A flat total, not a recurring monthly allowance, since the
  stake is a one-time payment for a fixed-length challenge.

Everyone (cohort or solo) picks a miss amount from their tier's
`missOptions`. That amount, not the full stake, is what's actually at risk
per missed week once grace weeks and passes are used up; finishing the
challenge returns the rest.

### Data storage (Supabase)

Onboarding answers are upserted to Supabase after every step (so drop-offs
are captured too, not just completions), using the `local_id` generated in
the browser as the upsert key.
1. Run `supabase/moms_leads.sql` once in your Supabase project's SQL editor.
2. Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings → API,
   the **anon/public** key only, never the service role key) in
   `moms-copy.js`.
3. View/export leads from the Supabase dashboard Table Editor (service
   role, bypasses RLS). The anon key used by the page can write but not
   read back.

### Analytics events

All fire via the existing PostHog instance, prefixed `moms_` (see `EVENTS` in
`moms-copy.js`): `moms_landing_view`, `moms_onboarding_start`,
`moms_step_viewed`, `moms_step_completed`, `moms_dropoff`,
`moms_clearance_answered`, `moms_motivation_chosen`, `moms_cohort_chosen`,
`moms_checkout_viewed`, `moms_checkout_started`, `moms_checkout_completed`,
`moms_checkout_failed`.

### Assumptions & open questions

- **Checkout completion is not server-verified.** Because there's no backend
  (by design, per the Payment Links choice), `moms_checkout_completed` and
  the Supabase `checkout_status: "completed_unverified"` fire when the
  browser lands back on `/moms-success` with its own `local_id` in
  `localStorage`. This is a strong signal, not cryptographic proof of
  payment. Reconcile actual payments against the Stripe test/live dashboard.
  If you want verified completion, that needs a backend (a serverless
  function + Stripe secret key), flagged here rather than built, since you
  explicitly chose the no-backend Payment Links approach.
- **No "cancel" redirect exists.** Stripe Payment Links don't support a
  separate cancel URL the way Checkout Sessions do. Someone who abandons
  payment just hits the browser back button; there's no distinct "payment
  failed" event from Stripe itself, card declines are retried on Stripe's
  own hosted page, invisible to us. `moms_dropoff` (fired on tab-hide/close
  before completion) is the closest signal we have to "gave up."
  `moms_checkout_failed` currently only fires for a misconfigured Payment
  Link (missing/placeholder URL), not a real card decline.
- **Resume only works on the same browser/device**: state lives in
  `localStorage`, keyed by a client-generated `local_id`. Switching devices
  mid-flow starts over.
- **The RLS policy lets anon update any row by `local_id`.** The UUID is
  never shown in the UI or URL, so it isn't practically guessable, but it's
  a real trade-off of skipping a backend; see `supabase/moms_leads.sql`.
- **Nothing in this repo tracks actual missed weeks or enforces the stake
  loss.** That bookkeeping (who missed, how much they lose, payouts) lives
  in the native app/backend, same as the main flow. This checkout only
  captures the plan someone agreed to and takes payment for the total
  stake; enforcing the per-week miss amount is a follow-up build.
- **`PROGRAM_LENGTH_WEEKS` defaults to 8**, a placeholder since no actual
  challenge length was specified. This is what makes "finish" mean
  something concrete and what the free-misses total is scoped to; confirm
  the real number and update `moms-copy.js`.
- **An email + first name step was added to checkout** (not explicitly in
  the brief) since there was otherwise no way to reach someone after
  payment or tie a Supabase row to a person.
- **Not linked from the main site nav**, by design, so it stays a quiet,
  share-by-link test. `<meta name="robots" content="noindex">` is set on
  both `moms.html` and `moms-success.html`.
- **Legal copy was reused, not rewritten**: the checkout screen links to
  the existing `/terms` and `/privacy`. `terms.html` §4.4 (refunds) and
  §15 (arbitration) still have unfilled placeholders (`[STATE]`,
  `[CITY, STATE]`, `[JAMS or AAA]`) predating this work, worth legal review
  before this flow takes real payments, same as the main flow. The
  stake/miss language on the `/moms` checkout screen is new copy and
  should get a legal look too.
- **Goal-suggestion math is a first guess**, not clinically validated:
  baseline steps by self-reported bucket times an energy multiplier,
  clamped 1,000 to 15,000, rounded to the nearest 500. Tune in
  `moms-copy.js`.

### Manual test checklist

- [ ] `/moms` with the PostHog flag off and no `?preview=1` shows the
      "not open yet" gate, no flow visible.
- [ ] `/moms?preview=1` unlocks the flow on that device; `?preview=0`
      relocks it.
- [ ] Landing page shows first, with the eyebrow/title/features/stake note,
      before any onboarding question. "Let's begin" starts the step wizard.
- [ ] Reload mid-flow (after starting the wizard) → skips the landing page
      entirely and resumes straight at the saved step.
- [ ] Stage: pick **pregnant**, due-date field shows, no delivery
      type question.
- [ ] Stage: pick **postpartum**, weeks-postpartum + delivery type fields
      show.
- [ ] Clearance: **yes** → Goal step shows a suggested/adjustable step
      number.
- [ ] Clearance: **not yet** or **not sure** → kind message shown, Goal step
      shows prepare-mode copy with no numeric goal, nothing exercise-related
      is pushed.
- [ ] Goal step: +/- buttons move by 500, clamp at 1,000 and 15,000.
- [ ] Cohort: pregnant shows "Due soon"; postpartum shows the baby-age
      groups; Solo always available; walking-partner line is just a note,
      not a selectable option.
- [ ] Commit, cohort picked: stake is locked to $15, no stake chooser shown,
      only the miss-amount pills ($1/$2/$3).
- [ ] Commit, solo picked: choosing a different stake tier resets the
      miss-amount choice and shows that tier's three options.
- [ ] Checkout: summary shows the right stake and miss amount; Pay button
      stays disabled until a valid email is entered and the terms checkbox
      is checked.
- [ ] Checkout → **Pay** redirects to the correct test-mode Stripe Payment
      Link for the chosen stake tier, with `client_reference_id` and
      `prefilled_email` populated in the URL.
- [ ] Complete a test payment (4242 card): lands on `/moms-success` with a
      personalized message; Supabase row's `checkout_status` becomes
      `completed_unverified`.
- [ ] Abandon mid-checkout (close tab): `moms_dropoff` fires in PostHog;
      Supabase row retains `last_step` at wherever you stopped.
- [ ] Close the tab mid-flow (e.g. after Baseline) and reopen `/moms`:
      resumes at the same step with a "welcome back" banner, answers intact.
- [ ] Confirm `/`, `/invite`, `/terms`, `/privacy` are all unchanged.
