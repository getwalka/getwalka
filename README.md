# getwalka

Static marketing site (no framework, no build step) deployed on Vercel. Each
page is a self-contained `.html` file with its own inline `<style>`; routing
is just file-based plus the `/invite/:path*` rewrite in `vercel.json`.
PostHog is wired into every page for analytics.

## Postpartum Mums test flow (`/moms`)

A standalone, flagged-off onboarding + checkout experiment living alongside
the main site, built to test whether postpartum/pregnant mums will sign up
and commit under a gentler commitment mechanic. It does not touch the main
flow or its stake logic (it does link to the shared `/terms` and `/privacy`
pages).

**Cohort only.** Solo is out of scope for this flow, it's hidden behind a
separate feature flag on mobile, not built here. Every `/moms` signup joins
a cohort group.

Visitors see a full-width marketing landing page first (headline, a 3-step
"how it works", a cohort section), then the step-by-step wizard. Resuming a
started session skips straight back to the wizard, no landing page again.
The landing lives outside the wizard's 440px card shell (it's a sibling of
`<main>` in `moms.html`, toggled by `mainEl`/`landingEl` in `moms-app.js`),
reusing the main site's `.wrap`/`.steps3`/`.s3`-style visual language rather
than the compact wizard card look.

The cohort section's photo slots (`COPY.landing.cohortGroups[].photo` in
`moms-copy.js`) point at `images/cohort-*.jpg`, which don't exist yet; each
`<img>` fails gracefully to a colored fallback icon via `onerror` until real
photos are dropped into a `getwalka/images/` folder at those exact paths.
Nothing here uses stock or generated photos of people, real cohort photos
(with consent) are a prerequisite for that section to look finished, not
optional polish.

Files:
- `moms.html`: the route itself (page shell, styles, landing + step markup
  containers).
- `moms-copy.js`: **every** piece of copy and every tunable config value
  (feature flag key, Stripe link/mode, stake/fee/miss amounts, program
  length, goal-suggestion math, tone copy for "princess"/"coach"). Edit
  this file, not the others, to change wording or mechanics.
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

This is a single one-time payment for a fixed-length challenge, not a
subscription. There's no payment backend in this repo, so checkout hands
off to one Stripe-hosted **Payment Link**; we never touch card data
ourselves.
1. In the Stripe **test mode** dashboard, create **one one-time price**
   Payment Link, price = `TOTAL_CHARGE_CENTS` in `moms-copy.js` (stake +
   entry fee, currently $80). Do not use a recurring/subscription price,
   and do not create separate links for the stake and the fee, it's one
   checkout.
2. In the Payment Link's settings, set "After payment" → redirect to your
   own URL → `https://getwalka.com/moms-success`.
3. Paste the resulting `https://buy.stripe.com/test_...` URL into
   `COHORT_PAYMENT_LINK.test` in `moms-copy.js`.
4. To go live later: create the equivalent live-mode Payment Link, fill in
   `COHORT_PAYMENT_LINK.live`, and flip `STRIPE_MODE` from `"test"` to
   `"live"`. That's the entire switch (also hides the test-mode card note
   on checkout, it's gated on `STRIPE_MODE`).

Card test number: `4242 4242 4242 4242`, any future expiry, any CVC.

### The stake mechanic

All in `moms-copy.js`, cohort only, no tiers or choices shown:
- `PROGRAM_LENGTH_WEEKS`: 4 weeks.
- `COHORT_STAKE_AMOUNT_CENTS`: $60 total stake ($15/week x 4), returned in
  full if you don't miss every day.
- `ENTRY_FEE_CENTS`: $20 total, platform revenue, not refundable. Marketed
  as "$4.99/week" but charged as this one upfront amount, never billed
  weekly; a real weekly charge would make it a recurring subscription
  collected outside IAP, which this flow must not do, same invariant as
  the main app.
- `MISS_AMOUNT_CENTS_PER_DAY`: $3, applies from day one. No grace period,
  no free "life happened" passes, every missed day costs $3 (missing all
  20 weekdays forfeits exactly the $60 stake). Money from missed days goes
  into the pool split among cohort members who finish, same mechanic as
  the main app's weekly cohorts.
- `TOTAL_CHARGE_CENTS`: stake + fee, what the single Payment Link actually
  charges ($80).

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
- **Nothing in this repo tracks actual missed days or enforces the stake
  loss.** That bookkeeping (who missed, how much they lose, payouts) lives
  in the native app/backend, same as the main flow. This checkout only
  captures the plan someone agreed to and takes one payment for stake +
  entry fee; enforcing the per-day miss amount and pooling it to the
  cohort's finishers is a follow-up build.
- **An email + first name step was added to checkout** (not explicitly in
  the brief) since there was otherwise no way to reach someone after
  payment or tie a Supabase row to a person.
- **Not linked from the main site nav**, by design, so it stays a quiet,
  share-by-link test. `<meta name="robots" content="noindex">` is set on
  both `moms.html` and `moms-success.html`.
- **Legal copy is shared with the main flow, not rewritten for this
  mechanic**: the checkout screen links to the existing `/terms` and
  `/privacy`. `terms.html` §15's governing law (Delaware) and arbitration
  venue (San Francisco, CA, administered by AAA) are filled in. The
  stake/fee/miss language on the `/moms` checkout screen is new copy and
  hasn't had a legal look yet; get one before taking real payments.
  `privacy.html` still has an unfilled EEA/UK data-transfer-mechanism
  placeholder, only matters if this flow reaches EU/UK users.
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
      groups; no solo option; walking-partner line is just a note, not a
      selectable option.
- [ ] Commit: shows $60 stake, $3/day if you miss, $20 entry fee, no
      choices to make, just a Continue button.
- [ ] Checkout: summary shows stake ($60), entry fee ($20), miss amount
      ($3), and total today ($80); Pay button stays disabled until a
      valid email is entered and the terms checkbox is checked.
- [ ] Checkout → **Pay** redirects to the single test-mode Stripe Payment
      Link, with `client_reference_id` and `prefilled_email` populated in
      the URL.
- [ ] Complete a test payment (4242 card): lands on `/moms-success` with a
      personalized message; Supabase row's `checkout_status` becomes
      `completed_unverified`.
- [ ] Abandon mid-checkout (close tab): `moms_dropoff` fires in PostHog;
      Supabase row retains `last_step` at wherever you stopped.
- [ ] Close the tab mid-flow (e.g. after Baseline) and reopen `/moms`:
      resumes at the same step with a "welcome back" banner, answers intact.
- [ ] Confirm `/`, `/invite`, `/terms`, `/privacy` are all unchanged.
