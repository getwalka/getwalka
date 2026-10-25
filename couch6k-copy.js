/* ==========================================================================
   Walka "November challenge" (internal slug stays couch6k; public URL is
   getwalka.com/myplan): paid 4-week test-cohort funnel, COPY + CONFIG.
   Separate, feature-flagged funnel -- does NOT touch or replace the live
   /start funnel ($24.99/mo subscription model). Everything editable about
   this experiment lives in this one file. Mirrors start-copy.js's
   structure/conventions; see that file's comments for parts that are
   identical (uuid/state/sync/gate plumbing lives in couch6k-app.js).

   Was previously a 9-screen onboarding quiz, then a single homepage that
   reused the quiz's 6-week ramp/solo-group framing. Redesigned again: a
   full marketing-style landing page (hero, your-week grid, coach preview,
   how-it-works, community preview, pricing breakdown, final CTA) that
   drops solo entirely (cohort/group only) and moves coach selection into
   the app, post-purchase -- the toggle on this page is a non-binding
   preview only, never sent anywhere. Also a real pricing change: $90
   stake / $29.99 fee / $3 a missed day / 6 weeks is now $20 buy-in /
   $19.99 fee / $1 a missed day / 4 weeks, flat 10,000-step goal instead
   of a weekly ramp. The $1/day figure is only honest because
   20261024000001_couch6k_miss_loss_override.sql lets this one challenge
   row override the database trigger's hard-coded $3/day -- see that
   migration before ever changing MISS_LOSS_CENTS_PER_DAY here without
   also setting miss_loss_per_day_override on the real challenge row.
   ========================================================================== */
window.WALKA_COUCH6K = (function () {

  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. FEATURE FLAG
   *    Own PostHog flag, separate from "start-funnel" -- ships OFF. Same
   *    fail-closed pattern: if PostHog can't be reached, the gate shows
   *    "not open yet" rather than letting anyone through. ?preview=1
   *    unlocks the flow locally regardless of the flag; ?preview=0 removes
   *    that override.
   * ------------------------------------------------------------------ */
  var FEATURE_FLAG_KEY = "couch6k-funnel";
  var PREVIEW_STORAGE_KEY = "walka_couch6k_preview";
  var FORCE_FLOW_ENABLED = false;
  var POSTHOG_FLAG_TIMEOUT_MS = 2500; // fail closed if flags never arrive

  /* ------------------------------------------------------------------ *
   * 1b. GEO GATE: US/Canada only, same mechanism as /start.
   *    middleware.js stamps walka_geo_country on every /couch6k request;
   *    couch6k-app.js reads that cookie and blocks checkout for anyone
   *    outside this list. Fails OPEN if the cookie is missing (e.g. local
   *    dev), same reasoning as start-copy.js's identical gate.
   * ------------------------------------------------------------------ */
  var GEO_ALLOWED_COUNTRIES = ["US", "CA"];

  /* ------------------------------------------------------------------ *
   * 2. PAYMENTS: Stripe, ONE combined one-time charge. No subscription.
   *
   *    Checkout charges ONE PaymentIntent for the $20 refundable buy-in
   *    (minus $1 per missed weekday, settled later in the app) plus the
   *    $19.99 non-refundable entry fee -- $39.99 total, via
   *    create-couch6k-payment-intent.
   *
   *    The amounts below are DISPLAY ONLY, mirrored from the Edge
   *    Function's own hardcoded STAKE_CENTS/FEE_CENTS constants
   *    (supabase/functions/create-couch6k-payment-intent/index.ts) -- keep
   *    the two in step by hand, there is no shared source since this repo
   *    has no build step to share values between Deno and this file. The
   *    per-day amount also has to be kept in step with the real challenge
   *    row's miss_loss_per_day_override (see this file's header comment).
   * ------------------------------------------------------------------ */
  /* "live", for the same reason start-copy.js is "live": this Supabase
     project has exactly one STRIPE_SECRET_KEY (the live one; /moms and
     /start already run checkout off it too), not a test/live pair. A
     "test" publishable key here would mount Stripe Elements against a
     live-mode clientSecret and fail. Testing this funnel for real means a
     real card and a real $39.99 charge -- refund/cancel it in the Stripe
     dashboard afterward. Revisit if this project ever gets its own
     test-mode secret key. */
  var STRIPE_MODE = "live"; // "test" | "live"

  var STAKE_CENTS = 2000;   // $20.00 buy-in
  var FEE_CENTS = 1999;     // $19.99 entry fee
  var TOTAL_CENTS = STAKE_CENTS + FEE_CENTS; // $39.99
  var MISS_LOSS_CENTS_PER_DAY = 100; // $1/missed weekday, capped at the buy-in
  var PROGRAM_WEEKS = 4;
  var PROGRAM_DURATION_DAYS = 28; // 4 calendar weeks; only Mon-Fri are actually tracked (weekdays_only on the manually-created challenge row)
  var TRACKED_WEEKDAYS = PROGRAM_WEEKS * 5; // 20 -- the actual scored days (weekends are free)
  var DAILY_GOAL_STEPS = 10000; // ONE flat goal, every tracked day -- no weekly ramp anymore

  /* Manually curated to match whatever the operator actually sets as the
     real manually-created challenge's start_date (this funnel has no live
     cohort-preview API to read a real date from). ONE value, a real
     parseable date -- couch6k-app.js derives the start badge, the hero
     eyebrow's month name, and the final CTA's date line all from this
     single ISO string, so none of them can drift apart. Keep this in step
     by hand when the real start date is set. */
  var COHORT_START_DATE_ISO = "2026-11-02";

  /* Publishable keys are not secret, safe to ship in client code. Same
     Stripe account as /start and /moms -- shared project, one key per mode. */
  var STRIPE_PUBLISHABLE_KEY = {
    test: "pk_test_51IAPwwKmW6iAmon9BvmoxKu3jXyKpZsKwOQ3uEoeZDk36hIzuECAUktrzreXANmhKa03DWf7GFhUPT8i54UZBWUV00oO4xYgwS",
    live: "pk_live_51IAPwwKmW6iAmon97vBggpfUblagf7SYYMOQ6mYGj0gWjCtZQ1nnst9oiSu9rka7jvlwnIPbca0RLScydPB8Scy4005VuT8ANc"
  };

  /* ------------------------------------------------------------------ *
   * 3. SUPABASE: own leads table (couch6k_leads), same project as start/moms.
   *    Protected by the RLS policy in supabase/couch6k_leads.sql: anon can
   *    insert, and can read/update only the row matching the local_id it
   *    already holds.
   * ------------------------------------------------------------------ */
  var SUPABASE_URL = "https://mgocpqbxssvjlmqzqfgn.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nb2NwcWJ4c3N2amxtcXpxZmduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzNzQyMjQsImV4cCI6MjA3Nzk1MDIyNH0.CEgJvGEOJJe5slTp3EKvOqw1pOwJOWK2GTitoL1QODY";
  var SUPABASE_TABLE = "couch6k_leads";

  /* App download link shown on the success page. Android isn't live yet. */
  var APP_STORE_URL = "https://apps.apple.com/us/app/walka/id6758069435";

  /* ------------------------------------------------------------------ *
   * 4. COPY. Warm, plainspoken, no em dashes (brand voice rule, CLAUDE.md).
   *    {placeholders} are filled in by couch6k-app.js from WS's config
   *    constants above and from COHORT_START_DATE_ISO, so the page can
   *    never show a number or date that disagrees with what checkout
   *    actually charges.
   * ------------------------------------------------------------------ */
  var COPY = {
    metaTitle: "Walka: November Challenge",
    metaDescription: "Walk 10,000 steps a day for 4 weeks and get your buy-in back. A coach in your style, a cohort keeping you honest.",

    gate: {
      title: "This page isn't open yet.",
      body: "Check back soon, or head back to the homepage.",
      cta: "Back to getwalka.com"
    },

    geoGate: {
      title: "Not available in your country yet.",
      body: "This program is currently only open to the US and Canada. Check back as we expand to more places.",
      cta: "Back to getwalka.com"
    },

    nav: { back: "Save & exit" },
    resumeBanner: "Welcome back. Picking up where you left off.",

    steps: {
      /* The homepage: one long landing page, no quiz. Each key below is
         one section, top to bottom. ctaLabel/badge/eyebrow all read
         {month}/{startDateShort}/{startDateLong} filled from
         COHORT_START_DATE_ISO, so the copy can't go stale relative to the
         real cohort date. */
      home: {
        hero: {
          badge: "{weeks} WEEKS · STARTS {startDateShort}",
          eyebrow: "THE {weeks}-WEEK {month} CHALLENGE",
          headline: "Walk {goal} steps. Get your buy-in back.",
          headlineHighlight: "buy-in back.",
          body: "Join a cohort, put in your buy-in at checkout, and pick the coach who gets you out the door. Saturday and Sunday are grace days.",
          ctaLabel: "Join the {month} challenge",
          priceLine: "{fee} entry fee · {stake} buy-in",
          exampleEyebrow: "AN EXAMPLE MONDAY, 6:45 PM",
          exampleSteps: 8412,
          examplePrincessLabel: "PRINCESS TREATMENT",
          examplePrincessLine: "{exampleSteps} so far, gorgeous. one gentle lap and you're done.",
          exampleToughLabel: "TOUGH COACH",
          exampleToughLine: "{exampleSteps}. {remaining} to go. Move."
        },

        week: {
          eyebrow: "YOUR WEEK",
          headline: "Five days to walk. Two days of grace.",
          body: "Saturday and Sunday are grace days. Brunch, a wedding, a long drive, a very committed couch session. All fine.",
          weekdayLabels: ["MON", "TUE", "WED", "THU", "FRI"],
          weekdayUnit: "steps",
          graceLabels: ["SAT", "SUN"],
          graceValue: "Grace",
          graceUnit: "day"
        },

        /* Coach is chosen in the app, after purchase -- this toggle is a
           non-binding preview only (local UI state, never written to
           state.answers or synced to Supabase). "Tap a coach here to hear
           how your day sounds" sets that expectation explicitly, so
           nobody reads this as the real selection. */
        coach: {
          eyebrow: "YOUR COACH, YOUR CALL",
          headline: "You choose your coach.",
          body: "You pick yours in the app. Same steps, same buy-in, a very different voice in your ear. Tap a coach here to hear how your day sounds.",
          previewingLabel: "PREVIEWING",
          tapToPreviewLabel: "TAP TO PREVIEW",
          previewEyebrow: "A DAY WITH {coachTitle}",
          options: {
            princess: {
              title: "Princess treatment",
              body: "Gentle, encouraging and a little pampering. Celebrates every lap.",
              previewTitle: "THE PRINCESS TREATMENT",
              schedule: [
                { time: "7:30 AM", text: "good morning, gorgeous. 10,000 steps today, and the sun is out. coffee first, then a little stroll?" },
                { time: "6:45 PM", text: "you're at 6,420, babe. one cute walk around the block and you're basically there." },
                { time: "9:10 PM", text: "10,000. look at you. feet up, you earned it." }
              ]
            },
            tough: {
              title: "Tough coach",
              body: "Strict, no excuses, drill sergeant. Counts your steps and says so.",
              previewTitle: "TOUGH COACH",
              schedule: [
                { time: "7:30 AM", text: "10,000 steps. that's the job today. first one happens now, not after coffee." },
                { time: "6:45 PM", text: "6,420. 3,580 left. get up and go get them." },
                { time: "9:10 PM", text: "10,000. done. do it again tomorrow." }
              ]
            }
          }
        },

        howItWorks: {
          eyebrow: "HOW IT WORKS",
          headline: "Join your cohort. Get your steps in.",
          step1Label: "STEP 1",
          step1Title: "Join your cohort",
          step1Body: "Join the {month} challenge and pay your {fee} entry fee and {stake} buy-in at checkout. Then choose your coach in the app: Princess treatment or Tough coach.",
          step2Label: "STEP 2",
          step2Title: "Get your steps in",
          step2Body: "{goal} steps, Monday to Friday, for {weeksWordLower} weeks. Saturday and Sunday are grace days, so the weekend is yours.",
          hitLabel: "YOU HIT EVERY WEEKDAY",
          hitHeadline: "You get all {stake} back.",
          missLabel: "YOU MISS A WEEKDAY",
          missHeadline: "You lose {perDay}. It goes to the people in your cohort who hit theirs."
        },

        /* Static preview of an in-app community feature -- sample names,
           replies and vote counts, not live data. No backend exists for
           this on the public site, so the reply/vote controls are visual
           only (no click handlers); nothing typed here is ever sent
           anywhere. If this becomes a real feature, wire it then rather
           than fake a working form now. */
        community: {
          headline: "Something to talk about between laps.",
          body: "A quote and a question every day. Vote on what you like and add your reply.",
          quote: {
            label: "QUOTE OF THE DAY",
            text: "The walk you skip on Tuesday is the one you owe on Wednesday.",
            votes: 12,
            replyPlaceholder: "Add a reply",
            replyCta: "Reply",
            replies: [
              { name: "mia_b", time: "3h", text: "tuesday me needs to read this" },
              { name: "jonah.k", time: "1h", text: "ok but what if wednesday me also skips" }
            ]
          },
          question: {
            label: "QUESTION OF THE DAY",
            text: "What do you do to get your steps in after a 9-5?",
            votes: 7,
            replyPlaceholder: "Add your answer",
            replyCta: "Reply",
            replies: [
              { name: "dee", time: "2h", text: "i take every call walking. a teams meeting with the camera off is basically a lap" },
              { name: "marcus_r", time: "45m", text: "shoes by the door. if i sit down first it's over" },
              { name: "priya", time: "20m", text: "walk to the next bart stop instead of the closest one lol" }
            ]
          }
        },

        pricing: {
          eyebrow: "THE NUMBERS",
          headline: "What it costs, and what you can lose.",
          body: "{weeksWord} weeks is {trackedWeekdays} weekdays. Each one is worth {perDay} of your buy-in.",
          cards: [
            { label: "ENTRY FEE", value: "{fee}", note: "Paid once at checkout." },
            { label: "BUY-IN", value: "{stake}", note: "Your stake for all {weeksWordLower} weeks." },
            { label: "PER MISSED WEEKDAY", value: "{perDay}", note: "Goes to the people in your cohort who hit theirs." },
            { label: "SATURDAY AND SUNDAY", value: "$0", note: "Grace days. Nothing to lose." }
          ],
          totalLabel: "TOTAL AT CHECKOUT",
          totalNote: "That is {fee} for the entry fee and {stake} for your buy-in. Hit every weekday and the full {stake} comes back. Miss all {trackedWeekdays} and the {stake} is gone.",

          rulesLabel: "Rules in detail",
          ruleStepSource: { title: "Where your steps come from", body: "Apple Health, synced automatically from your phone. No manual entry, nothing to remember to log. Walka is iOS-only right now, so this is an iPhone-only program." },
          ruleTimeZone: { title: "Time zones", body: "Your day runs midnight to midnight in your phone's time zone. If you travel, your day follows your phone, not the cohort's home zone." },
          ruleCancellation: { title: "Cancellation policy", body: "If this program doesn't reach enough participants, or the organizer cancels before it starts, every participant gets a full refund automatically. Once the program has started, your buy-in follows the miss-day rule below instead of a cancellation refund." },
          rulePayout: { title: "Payout rule", body: "Each missed weekday costs {perDay} from your buy-in, capped at your full {stake} buy-in, so you can never lose more than you put in. That missed-weekday money is split evenly between everyone in your cohort who finishes." },
          ruleEdgeCases: { title: "Edge cases", body: "Something not syncing, a day that looks wrong, or a question this page doesn't answer? Email susan@getwalka.com and we'll sort it out before it affects your payout." }
        },

        finalCta: {
          eyebrow: "FOR EVERYONE WHO SAYS THEY WILL WALK TOMORROW",
          headline: "Starts {startDateLong}.",
          body: "{weeksWord} weeks. Join your cohort, pick your coach in the app, and get your steps in.",
          ctaLabel: "Join the {month} challenge"
        }
      },

      checkout: {
        title: "Lock in your plan.",
        intro: "Charged once today. No subscription.",
        includedLabel: "What's included",
        includedItems: [
          "Your spot in the {month} cohort",
          "Daily messages from your coach",
          "Connect with other walkers in your group",
          "Free tracking, history and leaderboards, always"
        ],
        feeRowLabel: "Entry fee (non-refundable)",
        stakeRowLabel: "Buy-in (refundable, minus {perDay}/missed weekday)",
        nameLabel: "First name",
        emailLabel: "Email",
        billingNoteBase: "Charged once today, no subscription. Your buy-in is refunded in full if you finish, minus {perDay} for every weekday you miss.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        cardLabel: "Card details",
        paymentPlaceholder: "Complete the fields above to enter payment details.",
        paymentLoading: "Loading payment details...",
        confirmCta: "Pay {total} and start",
        processingCta: "Processing...",
        testModeNote: "Test mode: card 4242 4242 4242 4242, any date, any CVC.",
        genericError: "Something went wrong. Please try again.",
        legalLinks: { terms: "/terms", privacy: "/privacy" }
      }
    },

    success: {
      title: "You're all set.",
      subtitle: "Your plan is ready and waiting for you in the app.",
      downloadLabel: "Download the app",
      downloadBody: "Sign up with {email} and your cohort will already be there, no setup needed.",
      downloadCta: "Download on the App Store",
      nextTitle: "What happens next",
      nextSteps: [
        { title: "Check your inbox", body: "Watch for a receipt from Stripe confirming today's charge." },
        { title: "Download Walka", body: "Sign up with the same email you just used, and choose your coach." },
        { title: "Start walking", body: "Your coach's first message lands within the hour." }
      ],
      cancelFallback: "Questions about your payment? Email susan@getwalka.com."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susan@getwalka.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 5. ANALYTICS EVENT NAMES, prefixed couch6k_ so they never collide with
   *    the start/moms funnels' events or the main app's.
   * ------------------------------------------------------------------ */
  var EVENTS = {
    onboardingStart: "couch6k_onboarding_start",
    stepViewed: "couch6k_step_viewed",
    stepCompleted: "couch6k_step_completed",
    dropoff: "couch6k_dropoff",
    homeViewed: "couch6k_home_viewed",
    coachPreviewed: "couch6k_coach_previewed",
    checkoutViewed: "couch6k_checkout_viewed",
    checkoutStarted: "couch6k_checkout_started",
    checkoutCompleted: "couch6k_checkout_completed",
    checkoutFailed: "couch6k_checkout_failed",
    geoBlocked: "couch6k_geo_blocked"
  };

  return {
    FEATURE_FLAG_KEY: FEATURE_FLAG_KEY,
    FORCE_FLOW_ENABLED: FORCE_FLOW_ENABLED,
    PREVIEW_STORAGE_KEY: PREVIEW_STORAGE_KEY,
    POSTHOG_FLAG_TIMEOUT_MS: POSTHOG_FLAG_TIMEOUT_MS,
    GEO_ALLOWED_COUNTRIES: GEO_ALLOWED_COUNTRIES,
    STRIPE_MODE: STRIPE_MODE,
    STAKE_CENTS: STAKE_CENTS,
    FEE_CENTS: FEE_CENTS,
    TOTAL_CENTS: TOTAL_CENTS,
    MISS_LOSS_CENTS_PER_DAY: MISS_LOSS_CENTS_PER_DAY,
    PROGRAM_WEEKS: PROGRAM_WEEKS,
    PROGRAM_DURATION_DAYS: PROGRAM_DURATION_DAYS,
    TRACKED_WEEKDAYS: TRACKED_WEEKDAYS,
    DAILY_GOAL_STEPS: DAILY_GOAL_STEPS,
    COHORT_START_DATE_ISO: COHORT_START_DATE_ISO,
    STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    SUPABASE_TABLE: SUPABASE_TABLE,
    APP_STORE_URL: APP_STORE_URL,
    COPY: COPY,
    EVENTS: EVENTS
  };
})();
