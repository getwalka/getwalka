/* ==========================================================================
   Walka Couch to 6K: paid 6-week test-cohort funnel, COPY + CONFIG
   Separate, feature-flagged funnel -- does NOT touch or replace the live
   /start funnel ($24.99/mo subscription model). Everything editable about
   this experiment lives in this one file. Mirrors start-copy.js's
   structure/conventions; see that file's comments for parts that are
   identical (uuid/state/sync/gate plumbing lives in couch6k-app.js).
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
   *    Checkout charges ONE PaymentIntent for the $90 refundable stake
   *    (minus $3 per missed weekday, settled later in the app) plus the
   *    $29.99 non-refundable program fee -- $119.99 total, via
   *    create-couch6k-payment-intent. Not framed as an "AI coach fee": this
   *    cohort gets the same free static princess/tough coach copy
   *    (lib/coach.ts) as everyone else, so the fee is a neutral program
   *    fee, never described in this file's copy as paying for the coach.
   *
   *    The amounts below are DISPLAY ONLY, mirrored from the Edge
   *    Function's own hardcoded STAKE_CENTS/FEE_CENTS constants
   *    (supabase/functions/create-couch6k-payment-intent/index.ts) -- keep
   *    the two in step by hand, there is no shared source since this repo
   *    has no build step to share values between Deno and this file.
   * ------------------------------------------------------------------ */
  /* "live", for the same reason start-copy.js is "live": this Supabase
     project has exactly one STRIPE_SECRET_KEY (the live one; /moms and
     /start already run checkout off it too), not a test/live pair. A
     "test" publishable key here would mount Stripe Elements against a
     live-mode clientSecret and fail. Testing this funnel for real means a
     real card and a real $119.99 charge -- refund/cancel it in the Stripe
     dashboard afterward. Revisit if this project ever gets its own
     test-mode secret key. */
  var STRIPE_MODE = "live"; // "test" | "live"

  var STAKE_CENTS = 9000;   // $90.00
  var FEE_CENTS = 2999;     // $29.99
  var TOTAL_CENTS = STAKE_CENTS + FEE_CENTS; // $119.99
  var MISS_LOSS_CENTS_PER_DAY = 300; // $3/missed weekday, capped at the stake
  var PROGRAM_WEEKS = 6;
  var PROGRAM_DURATION_DAYS = 42; // 6 calendar weeks; only Mon-Fri are actually tracked (weekdays_only on the manually-created challenge row)

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
   * 4. GOAL -> FitnessGoal mapping. Mirrors profiles.fitness_goal's
   *    vocabulary exactly, same reasoning as start-copy.js's identical map.
   * ------------------------------------------------------------------ */
  var GOAL_TO_FITNESS_GOAL = {
    get_moving: "start_small",
    stay_consistent: "habit",
    build_habit: "habit",
    lose_weight: "lose_weight"
  };

  /* ------------------------------------------------------------------ *
   * 5. COPY. Warm, plainspoken, no em dashes (brand voice rule, CLAUDE.md).
   * ------------------------------------------------------------------ */
  var COPY = {
    metaTitle: "Walka: Couch to 6K",
    metaDescription: "From couch to 6,000 steps a day in 6 weeks. A ramping goal, a coach, and a little accountability built in.",

    continueLabel: "Continue",
    skipLabel: "Skip for now",
    firstStepProgressLabel: "Getting to know you",

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

    introHeader: {
      title: "From couch to 6K, in 6 weeks.",
      body: "A few quick questions, then we'll build your plan: a daily goal that ramps up week by week, and a coach in your corner.",
      features: [
        { icon: "🎯", label: "A goal that ramps up" },
        { icon: "🧑‍🏫", label: "A coach, your style" },
        { icon: "👥", label: "Solo or group, your choice" }
      ]
    },

    steps: {
      /* Screen 1 */
      goal: {
        intro: "A few quick questions to build your plan.",
        title: "What's your goal right now?",
        options: [
          { value: "get_moving", label: "Just get moving" },
          { value: "build_habit", label: "Build a daily walking habit." },
          { value: "lose_weight", label: "Lose some weight" },
          { value: "stay_consistent", label: "Finally stay consistent" }
        ]
      },

      /* Screen 2 */
      baseline: {
        title: "How many steps do you average now?",
        hint: "A rough guess is fine.",
        options: [
          { value: "under_2k", label: "Under 2,000" },
          { value: "two_to_three", label: "2,000 to 3,000" },
          { value: "three_to_five", label: "3,000 to 5,000" },
          { value: "five_to_seven", label: "5,000 to 7,000" },
          { value: "seven_plus", label: "7,000+" }
        ]
      },

      /* Screen 3, seven_plus only -- skipped entirely for everyone else, in
         both nav directions (see couch6k-app.js's skip contract). Terminal:
         no checkout, just a reachable lead for later. */
      waitlist: {
        title: "You're already ahead of this one.",
        body: "This 6-week plan is built for people building up from under 7,000 steps a day. Join the waitlist and we'll let you know if we open a program for your level.",
        nameLabel: "First name",
        emailLabel: "Email",
        submitCta: "Join the waitlist",
        confirmedTitle: "You're on the list.",
        confirmedBody: "We'll email you if a program opens up for your level."
      },

      /* Screen 4 */
      coach: {
        title: "Pick your coach.",
        options: [
          { value: "princess", label: "Gentle coach", sub: "Princess treatment: warm and encouraging, Coach Serena" },
          { value: "tough", label: "Tough coach", sub: "Blunt, no excuses, Coach Tim" }
        ]
      },

      /* Screen 5. Pre-selected to "group" -- Continue is enabled without a
         tap (see couch6k-app.js's mode step, a real deviation from the
         pill-only auto-advance pattern every other step uses). */
      mode: {
        title: "Solo, or with a group?",
        options: [
          { value: "group", label: "With a group", sub: "Join this cohort, starting together" },
          { value: "solo", label: "Solo", sub: "Your own private challenge, same terms" }
        ],
        disclosureLabel: "What's the difference?",
        disclosureBody: "<p>With a group, everyone starts the same week and keeps each other honest. If you miss a day, your $3 gets shared among the people who finish, not kept by Walka.</p>" +
          "<p>Solo is the same price, same goal, same 6 weeks, just without a group. If you miss a day, that $3 goes to Walka instead of back to a group.</p>",
        soloMoneyNote: "Solo heads up: missed-day money goes to Walka, not back to you."
      },

      /* Screen 6: first name + email, captured before the paywall/checkout so
         a dropoff there still leaves a reachable lead. */
      contact: {
        title: "Let's build your plan.",
        subtitle: "We'll use this to get your plan ready and keep you posted, nothing else.",
        nameLabel: "First name",
        emailLabel: "Email",
        referralLabel: "How did you hear about us?",
        referralOptions: [
          { value: "instagram", label: "Instagram" },
          { value: "tiktok", label: "TikTok" },
          { value: "friend", label: "A friend or family member" },
          { value: "google", label: "Google search" },
          { value: "other", label: "Something else" }
        ]
      },

      /* Screen 7: brief timed transition, no question. */
      preparing: {
        title: "Building your plan",
        body: "We're turning what you told us into a 6-week ramp."
      },

      /* Screen 8, the paywall -- "Made for you". Goal/coach/format rows plus
         schedule and stake facts, then one real health stat, then the
         total due today. */
      results: {
        eyebrow: "Made for you",
        title: "Here's your plan.",
        dailyGoalLabel: "Week-by-week goal",
        coachLabel: "Coach",
        formatLabel: "Format",
        scheduleLabel: "Schedule",
        scheduleValue: "Mon-Fri tracked, weekends free",
        stakeLabel: "Stake",
        stakeValue: "$90, refundable minus $3 per missed weekday",
        groupTitle: "A shared 6-week cohort",
        groupSub: "Starting together",
        soloTitle: "Your own private challenge",
        soloBody: "Just you, your pace, same 6 weeks.",
        healthStatFigure: "~3,550 vs ~5,800 steps/day",
        healthStatBody: "People averaging about 3,550 steps a day had roughly 40% higher all-cause mortality than people averaging about 5,800 (hazard ratio 0.60, lowest vs second step-count quartile).",
        healthStatCitation: "Paluch AE et al., Lancet Public Health, 2022. Meta-analysis of 15 cohorts, about 47,000 adults. Association, not causation: this doesn't prove walking more causes lower mortality, only that the two are correlated.",
        totalLabel: "Due today",
        continueCta: "Continue to checkout"
      },

      /* Screen 9 */
      checkout: {
        title: "Lock in your plan.",
        intro: "Charged once today. No subscription.",
        includedLabel: "What's included",
        includedItems: [
          "Your 6-week ramp, built from your answers",
          "Daily messages from your coach",
          "Connect with other walkers in your group",
          "Free tracking, history and leaderboards, always"
        ],
        feeRowLabel: "Program fee (non-refundable)",
        stakeRowLabel: "Stake (refundable, minus $3/missed weekday)",
        nameLabel: "First name",
        emailLabel: "Email",
        billingNoteBase: "Charged once today, no subscription. The stake is refunded in full if you finish, minus $3 for every weekday you miss.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        cardLabel: "Card details",
        paymentPlaceholder: "Complete the fields above to enter payment details.",
        paymentLoading: "Loading payment details...",
        confirmCta: "Pay $119.99 and start",
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
      downloadBody: "Sign up with {email} and your plan and coach will already be there, no setup needed.",
      downloadCta: "Download on the App Store",
      nextTitle: "What happens next",
      nextSteps: [
        { title: "Check your inbox", body: "Watch for a receipt from Stripe confirming today's charge." },
        { title: "Download Walka", body: "Sign up with the same email you just used, and your plan loads in automatically." },
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
   * 6. ANALYTICS EVENT NAMES, prefixed couch6k_ so they never collide with
   *    the start/moms funnels' events or the main app's.
   * ------------------------------------------------------------------ */
  var EVENTS = {
    onboardingStart: "couch6k_onboarding_start",
    stepViewed: "couch6k_step_viewed",
    stepCompleted: "couch6k_step_completed",
    dropoff: "couch6k_dropoff",
    waitlisted: "couch6k_waitlisted",
    resultsViewed: "couch6k_results_viewed",
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
    STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    SUPABASE_TABLE: SUPABASE_TABLE,
    APP_STORE_URL: APP_STORE_URL,
    GOAL_TO_FITNESS_GOAL: GOAL_TO_FITNESS_GOAL,
    COPY: COPY,
    EVENTS: EVENTS
  };
})();
