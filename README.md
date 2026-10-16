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

As of 2026-10-16, `/moms` goes straight into the step-by-step wizard, no
separate marketing landing page first. (There used to be a full-width hero
section with a headline, a 3-step "how it works," and a cohort preview,
gated behind its own "Let's begin" button; `startFlow()` in `moms-app.js`
now enters the wizard directly instead of calling into that, and the old
render function was deleted along with the scroll-reveal helper it was the
only caller of. `landingEl`/`#landing` is still a sibling of `<main>` in
`moms.html`, left in place but permanently empty/hidden, in case this gets
reverted.) `COPY.landing` in `moms-copy.js` is consequently unused by the
flow itself; `moms_landing_view` no longer fires for the same reason.

Files:
- `moms.html`: the route itself (page shell, styles, landing + step markup
  containers).
- `moms-copy.js`: **every** piece of copy and every tunable config value
  (feature flag key, Stripe link/mode, stake/fee/miss amounts, program
  length, the fixed goal options, tone copy for "princess"/"coach"). Edit
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

### Geo gate: US/Canada only

`/moms` is additionally restricted to US and Canadian visitors
(`GEO_ALLOWED_COUNTRIES` in `moms-copy.js`), independent of the feature flag
above.

- `middleware.js` (Vercel Edge Middleware, matches `/moms` only) reads
  Vercel's own `x-vercel-ip-country` request header and stamps it onto a
  `walka_geo_country` cookie. This is the one piece of this experiment that
  isn't purely static: everything else here is plain files with no build
  step, this is a small edge function. No npm dependency, no `@vercel/edge`
  package; it hand-writes the `x-middleware-next: 1` response header that
  tells Vercel to keep serving the static route rather than replacing the
  response.
- `moms-app.js` reads that cookie and, if the country isn't in the allowed
  list, shows `COPY.geoGate` instead of the wizard. The decision lives
  here, not in middleware, so there's one place (same as the feature-flag
  gate) that owns who gets in.
- **Fails OPEN**, the opposite of the feature-flag gate: if the cookie is
  missing or empty (middleware didn't run, e.g. plain `vercel dev` or a
  local file open), the visitor is let through rather than blocked. A
  detection hiccup should never cost a real US/CA signup.
- `?preview=1` bypasses this gate too, same as the feature flag, so QA can
  test from any location.
- Every visitor's country, allowed, blocked, or unknown, is written to
  `moms_leads.country` (upserted on landing, before onboarding even starts)
  and sent as a `moms_geo_blocked` PostHog event when someone is actually
  blocked, so the country breakdown is visible in both places, not just the
  pass/fail outcome.

### Payments: Stripe, test mode by default

This is a single one-time payment for a fixed-length challenge, not a
subscription. There's no payment backend in this repo, so checkout hands
off to one Stripe-hosted **Payment Link**; we never touch card data
ourselves.
1. In the Stripe **test mode** dashboard, create **one one-time price**
   Payment Link, price = `TOTAL_CHARGE_CENTS` in `moms-copy.js` (stake +
   entry fee, currently $49.99). Do not use a recurring/subscription price,
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
- `COHORT_STAKE_AMOUNT_CENTS`: $39.99 total stake, a cent under $40 on
  purpose (same under-the-round-number pattern as the main app's $19.99
  entry), returned in full if you don't miss every day.
- `ENTRY_FEE_CENTS`: $10 total, platform revenue, not refundable. Marketed
  as "~$2.50/week" but charged as this one upfront amount, never billed
  weekly; a real weekly charge would make it a recurring subscription
  collected outside IAP, which this flow must not do, same invariant as
  the main app.
- `MISS_AMOUNT_CENTS_PER_DAY`: $2, applies from day one. No grace period,
  no free "life happened" passes, every missed day costs $2 (missing all
  20 weekdays forfeits effectively the full $39.99 stake, one cent over on
  paper; the mechanic caps forfeiture at the stake itself). Money from
  missed days goes into the pool split among cohort members who finish,
  same mechanic as the main app's weekly cohorts. The checkout screen
  shows this as "-$2 from your stake," not a bare "$2," so it doesn't
  read as a separate charge due today.
- `TOTAL_CHARGE_CENTS`: stake + fee, what the single Payment Link actually
  charges ($49.99).

**Prepare mode never charges anyone.** If `clearance_status !== "yes"`,
there's no step goal to miss (the plan preview/checkout copy and the
`miss_cents` field written to Supabase both reflect "not tracked"/"no goal
yet" rather than the $2 figure) and, as of 2026-10, **no Stripe checkout at
all**: the "Pay" button
is replaced with "Reserve my spot," which skips the Payment Link entirely,
upserts the lead with `checkout_status: "reserved"` and the email/name
they entered, and shows an on-page "you're on the list" confirmation.
Follow-up (emailing them once they're cleared, to come back and actually
pay) is manual for now, there's no automated re-engagement built here.
Earlier versions of this flow charged the full stake upfront in prepare
mode too ("reserving a spot" with a refundable stake); that's been
replaced because asking for a real card charge before someone can even
start wasn't the right call.

**The cohort step is no longer a choice** (it was, until 2026-10; see the
manual test checklist for the old pick-and-mismatch-warning behavior this
replaced). It auto-places from `weeks_postpartum`, read-only (0–13 weeks
-> 0–3mo, 13–26 -> 3–6mo, otherwise 6–12mo; pregnant always lands in "Due
soon"; postpartum with no weeks answer, that field is optional, falls
back to 0–3mo rather than leaving the group unresolved).

### Data storage (Supabase)

Onboarding answers are upserted to Supabase after every step (so drop-offs
are captured too, not just completions), using the `local_id` generated in
the browser as the upsert key.
1. Run `supabase/moms_leads.sql` once in your Supabase project's SQL editor.
2. Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project Settings → API,
   the **anon/public** key only, never the service role key) in
   `moms-copy.js`.
3. View/export leads from the Supabase dashboard Table Editor (service
   role, bypasses RLS). Nothing in this page reads leads back, but the
   anon key can technically `select` its own row by `local_id`, that
   policy exists only because Postgres requires it to resolve
   `upsert()`'s `ON CONFLICT` under RLS, see the note in
   `supabase/moms_leads.sql`. Without it, every single upsert, including
   a brand-new row with nothing to conflict with, fails outright with a
   row-level security error. This isn't a hypothetical: it's exactly
   what silently broke lead capture for this flow until the select
   policy was added, so don't remove it as a "we don't need reads"
   cleanup.

### Analytics events

All fire via the existing PostHog instance, prefixed `moms_` (see `EVENTS` in
`moms-copy.js`): `moms_landing_view`, `moms_onboarding_start`,
`moms_step_viewed`, `moms_step_completed`, `moms_dropoff`,
`moms_clearance_answered`, `moms_motivation_chosen`, `moms_cohort_chosen`,
`moms_checkout_viewed`, `moms_checkout_started`, `moms_checkout_completed`,
`moms_checkout_failed`, `moms_geo_blocked`, `moms_prepare_reserved` (fires
instead of `moms_checkout_started`/`completed` in prepare mode, since there's
no Stripe handoff to track).

### Assumptions & open questions

- **The checkout screen still charges the old stake/fee model, not the
  coaching subscription.** As of 2026-10-11, the "Your stake" screen was
  removed from the funnel (replaced by "Your plan," a no-dollar-figures
  preview of goal/length/cohort/coach style) because its $39.99 stake +
  $10 entry fee language conflicted with a stated $24.99/mo or $199.99/yr
  coaching-and-community subscription offer. The checkout screen right
  after it was explicitly out of scope for that change and **still shows
  the same stake/fee/total breakdown and still charges the one-time
  $49.99 via `COHORT_PAYMENT_LINK`**, now with no screen above it
  explaining those numbers. This is a known gap, not an oversight: the
  checkout rework depends on deciding how the subscription is actually
  billed (see the architecture question below) before touching it.
- **One-time Payment Links can't bill a subscription, by platform
  default, but Payment Links do support recurring prices** (the "one-time
  only" rule earlier in this file was specific to the stake model, not a
  Stripe limitation): `COHORT_PAYMENT_LINK` can point at a recurring price
  once the checkout screen itself is reworked for the subscription (not
  yet done; see above). Stripe bills recurring charges automatically
  regardless of what this repo tracks; what's missing without a webhook
  is *our own* record of renewals/failures/cancellations.
- **`link-moms-subscriber`** (Edge Function, in the main stepr repo's
  `supabase/functions/`, not here) is the first piece of that: called
  from `/moms-success` right after the Stripe redirect, same "replaces a
  webhook, call it on return" pattern the main app's
  `sync-subscription-status` already uses. Payment Links don't hand back
  a customer/subscription id in the redirect URL, so it looks the Stripe
  Customer up by the email already on the `moms_leads` row and writes
  `stripe_customer_id` + `subscription_status` (mirrors Stripe's own
  `subscription.status`) back onto that row. Public, unauthenticated
  (the moms funnel never creates a Supabase session), gated only on
  knowing the row's `local_id`, same trust model as every other write
  here.
- **Still not built: linking a `moms_leads` row to an actual app
  account.** When someone downloads the app and signs up with the same
  email, nothing yet copies `stripe_customer_id` onto their new
  `profiles` row. That means extending `handle_new_user()`, the trigger
  that creates a `profiles` row for every signup app-wide, so it's
  deliberately held until there's a real recurring Payment Link and a
  tested `link-moms-subscriber` run to reconcile against, given the blast
  radius of a mistake there (every signup, not just moms subscribers).
  Once that exists, the main app's own `sync-subscription-status`
  (already built, called on cold start) picks up the real status from
  Stripe with no further moms-specific code.
- **No self-serve cancellation yet.** A recurring charge needs one;
  enabling Stripe's hosted Customer Portal (Settings → Billing → Customer
  portal → the no-code, shareable link option, fits this repo's
  no-backend approach) and linking to it from `/moms-success` or a
  confirmation email is the plan, not yet wired in.
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
- **The RLS policy lets anon read and update any row by `local_id`.** The
  UUID is never shown in the UI or URL, so it isn't practically guessable,
  but it's a real trade-off of skipping a backend; see
  `supabase/moms_leads.sql`.
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
- **The goal step is a flat choice, not a computed suggestion.** Cleared
  users pick 3,000 / 5,000 / 10,000 steps/day directly (`GOAL_OPTIONS` in
  `moms-copy.js`); there's no baseline/energy/delivery-type math behind it
  anymore. The delivery-type question (vaginal/C-section/prefer not to
  say) was dropped from the stage step entirely, since it no longer
  affected anything the user could see. `barriers` is still collected
  from the baseline step for segmentation in Supabase; it just no longer
  drives a computed number or appears as goal-screen copy. The
  `delivery_type` column stays in `moms_leads` for historical rows but
  nothing writes to it going forward.

### Manual test checklist

- [ ] `/moms` with the PostHog flag off and no `?preview=1` shows the
      "not open yet" gate, no flow visible.
- [ ] `/moms?preview=1` unlocks the flow on that device; `?preview=0`
      relocks it.
- [ ] From a US or Canadian IP (or a VPN set to one), `/moms` goes straight
      into the wizard as normal; a `moms_leads` row appears with `country`
      set to `US`/`CA` even before completing the first step.
- [ ] From a VPN set to a third country, `/moms` shows the "not available
      in your country yet" gate instead of the wizard; a `moms_geo_blocked`
      event fires in PostHog and the `moms_leads` row's `country` reflects
      that country with `last_step: "geo_blocked"`.
- [ ] `/moms?preview=1` from that same non-US/CA VPN still unlocks the full
      flow (preview bypasses the geo gate, not just the feature flag).
- [ ] Reload mid-flow → returns straight to the saved step with a "welcome
      back" banner instead of restarting from Step 1.
- [ ] Stage: pick **pregnant**, due-date field shows, no delivery
      type question.
- [ ] Stage: pick **postpartum**, weeks-postpartum + delivery type fields
      show.
- [ ] Clearance: **yes** → Goal step shows three pill choices (3,000 /
      5,000 / 10,000 steps/day), none pre-selected; Continue stays disabled
      until one is picked.
- [ ] Clearance: **not yet** or **not sure** → kind message shown, Goal step
      shows prepare-mode copy with no numeric goal, nothing exercise-related
      is pushed.
- [ ] Stage **postpartum**, weeks postpartum **4** → Cohort step shows
      "You'll be grouped with: 0–3 months postpartum" as plain text, no
      pickable options and no way to change it.
- [ ] Stage **postpartum**, weeks postpartum left blank → Cohort step
      still shows "0–3 months postpartum" (the no-weeks fallback), not a
      blank or broken state.
- [ ] Cohort: pregnant shows "You'll be grouped with: Due soon"; no solo
      option; a "What you're joining" recap (coach, circle, pace) shows
      above it; Continue is never disabled on this step.
- [ ] Plan preview, clearance **yes**: shows a summary table (Daily goal,
      Length, Your people, Coach style), no dollar amounts anywhere on this
      screen; Continue is never disabled.
- [ ] Plan preview, clearance **not yet/not sure**: Daily goal row shows
      "No goal yet, prepare mode" instead of a steps/day figure.
- [ ] Checkout, clearance **yes**: summary shows stake ($39.99), entry fee
      ($10), "if you miss a weekday" (-$2 from your stake), and total today
      ($49.99); Pay button stays disabled until a valid email is entered
      and the terms checkbox is checked.
- [ ] Checkout, clearance **not yet/not sure**: an explainer note appears
      before the summary table ("you're reserving your spot... no payment
      today"), "if you miss a weekday" row shows "Not tracked yet", and
      "Total today" shows "Nothing today" instead of a dollar amount; the
      button reads "Reserve my spot" instead of "Pay".
- [ ] Clicking **Reserve my spot** (clearance not yet/not sure, valid email
      + terms checked): no redirect to Stripe happens; the screen replaces
      itself with "You're on the list" copy; `moms_prepare_reserved` fires
      in PostHog; the Supabase row's `checkout_status` becomes `reserved`
      and `miss_cents` stays `null`.
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
