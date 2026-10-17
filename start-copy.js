/* ==========================================================================
   Walka Start: general-audience onboarding flow, COPY + CONFIG
   Everything editable about this experiment lives in this one file: wording,
   pricing, feature flag name, and third-party keys. No other file should
   need to change to tune it. Mirrors moms-copy.js's structure/conventions.
   ========================================================================== */
window.WALKA_START = (function () {

  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. FEATURE FLAG
   *    Same pattern as the moms funnel's gate: a PostHog flag, default-off
   *    (fail closed) if PostHog can't be reached. ?preview=1 unlocks the
   *    flow locally regardless of the flag; ?preview=0 removes that.
   * ------------------------------------------------------------------ */
  var FEATURE_FLAG_KEY = "start-funnel";
  var PREVIEW_STORAGE_KEY = "walka_start_preview";
  var FORCE_FLOW_ENABLED = false;
  var POSTHOG_FLAG_TIMEOUT_MS = 2500; // fail closed if flags never arrive

  /* ------------------------------------------------------------------ *
   * 2. PAYMENTS: Stripe, recurring membership (USD only for v1 -- no geo
   *    gate, no CAD price; add both together later if this expands beyond
   *    the US).
   *
   *    Checkout charges TWO things off the one card entered: the $9.99/mo
   *    membership (via create-start-subscription-intent, a Stripe
   *    Subscription) and, immediately after, the refundable stake (via
   *    create-start-stake-intent, a one-time PaymentIntent against the same
   *    saved payment method -- no Payment Link fallback for this funnel,
   *    since a Payment Link can't carry the second charge).
   *
   *    In the Stripe dashboard: Products > create "Walka Start Membership" >
   *    Recurring, Monthly, USD, 9.99 > copy its Price id into
   *    START_MEMBERSHIP_PRICE_ID_USD below (set as the
   *    START_MEMBERSHIP_PRICE_ID_USD env var on the create-start-subscription-intent
   *    Edge Function, NOT here -- the price id itself is read server-side).
   * ------------------------------------------------------------------ */
  /* Temporarily "live", NOT because checkout has been verified end to end --
     it hasn't yet. The shared STRIPE_SECRET_KEY on this Supabase project is
     the LIVE key (the /moms funnel already runs in live mode off the same
     project-wide secret, and Edge Functions only have one STRIPE_SECRET_KEY,
     not a test/live pair), so a "test" publishable key here would mount
     Stripe Elements against a live-mode clientSecret and fail silently.
     Testing the actual checkout therefore means a real card and a real
     (small, refundable-stake) charge -- cancel/refund it in the Stripe
     dashboard afterward. Revisit if this funnel gets its own test-mode
     secret key later. */
  var STRIPE_MODE = "live"; // "test" | "live"

  var PLAN_PRICE_CENTS = 999; // $9.99
  var BILLING_INTERVAL = "month";
  var PLAN_DURATION_DAYS = 5; // matches SOLO_DURATION_DAYS (lib/soloChallenge.ts) and the cohort's DURATION_DAYS (seed-weekly-cohort)

  /* MUST match SOLO_STAKE_OPTIONS in lib/soloOffer.ts and the
     enforce_solo_stake() trigger (20260925000003_solo_stake_bounds.sql). The
     group path never uses this -- its real stake comes from
     get-weekly-cohort-preview instead. */
  var SOLO_STAKE_OPTIONS = [15, 25, 50, 100];

  /* Publishable keys are not secret, safe to ship in client code. From the
     Stripe dashboard: Developers > API keys > Publishable key, once per mode. */
  var STRIPE_PUBLISHABLE_KEY = {
    test: "pk_test_51IAPwwKmW6iAmon9BvmoxKu3jXyKpZsKwOQ3uEoeZDk36hIzuECAUktrzreXANmhKa03DWf7GFhUPT8i54UZBWUV00oO4xYgwS",
    live: "pk_live_51IAPwwKmW6iAmon97vBggpfUblagf7SYYMOQ6mYGj0gWjCtZQ1nnst9oiSu9rka7jvlwnIPbca0RLScydPB8Scy4005VuT8ANc"
  };

  /* ------------------------------------------------------------------ *
   * 3. SUPABASE: stores onboarding answers + lead/checkout status.
   *    Same project as moms-copy.js (shared with the main Walka app); public
   *    anon key only. Protected by the RLS policy in
   *    supabase/start_leads.sql: anon can insert, and can read/update only
   *    the row matching the local_id it already holds.
   * ------------------------------------------------------------------ */
  var SUPABASE_URL = "https://mgocpqbxssvjlmqzqfgn.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nb2NwcWJ4c3N2amxtcXpxZmduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzNzQyMjQsImV4cCI6MjA3Nzk1MDIyNH0.CEgJvGEOJJe5slTp3EKvOqw1pOwJOWK2GTitoL1QODY";
  var SUPABASE_TABLE = "start_leads";

  /* App download link shown on the success page -- same URL the invite
     fallback page (getwalka/invite.html) links to. Android isn't live yet. */
  var APP_STORE_URL = "https://apps.apple.com/us/app/walka/id6758069435";

  /* ------------------------------------------------------------------ *
   * 4. GOAL -> FitnessGoal mapping. Mirrors profiles.fitness_goal's
   *    vocabulary exactly (lib/onboardingSelections.ts's FitnessGoal type:
   *    'habit' | 'lose_weight' | 'compete' | 'start_small') so
   *    apply-pending-web-plan can write it straight onto the profile with
   *    no translation. Comment-linked rather than imported since this file
   *    has no build step to share TypeScript with the app.
   * ------------------------------------------------------------------ */
  var GOAL_TO_FITNESS_GOAL = {
    get_moving: "start_small",
    stay_consistent: "habit",
    hit_10k: "compete",
    lose_weight: "lose_weight"
  };

  /* Mirrors GOAL_STRETCH in lib/recommendation.ts. */
  var GOAL_STRETCH = {
    start_small: 0.9,
    habit: 1.05,
    compete: 1.1,
    lose_weight: 1.15
  };

  /* Not an app concept -- lib/recommendation.ts has no difficulty-tier input,
     only a goal. This funnel's "easy/medium/hard" question is web-funnel-only
     personalization layered on top of the same stretch math, clamped the
     same way (recommendStepGoal's STEP_FLOOR/STEP_CEILING) before it's ever
     written anywhere. */
  var DIFFICULTY_MULTIPLIER = { easy: 0.9, medium: 1.0, hard: 1.15 };

  var STEP_FLOOR = 3000;
  var STEP_CEILING = 50000;

  /* Representative average for each baseline bucket, fed into the same math
     as lib/recommendation.ts's recommendStepGoal. A bucket picker instead of
     a free-text number field, matching this page's pill-based UI throughout. */
  var BASELINE_BUCKETS = {
    under_5000: 3500,
    five_to_ten: 7500,
    ten_to_fifteen: 12500,
    fifteen_plus: 18000
  };

  /* ------------------------------------------------------------------ *
   * 5. COPY. Warm, plainspoken, no em dashes (brand voice rule, CLAUDE.md).
   * ------------------------------------------------------------------ */
  var COPY = {
    metaTitle: "Walka",
    metaDescription: "A step goal, a coach, and a little money on the line, built around how you actually walk.",

    continueLabel: "Continue",
    skipLabel: "Skip for now",
    firstStepProgressLabel: "Getting to know you",

    gate: {
      title: "This page isn't open yet.",
      body: "Check back soon, or head back to the homepage.",
      cta: "Back to getwalka.com"
    },

    nav: { back: "Save & exit" },
    resumeBanner: "Welcome back. Picking up where you left off.",

    disclaimer: "No app feature is ever locked behind a fee. Tracking, your coach, and history are free, always.",

    introHeader: {
      title: "A plan that actually fits how you walk.",
      body: "Six quick questions, then we'll build your plan: a daily goal, a coach in your corner, and a little money on the line to keep you honest.",
      features: [
        { icon: "🎯", label: "Your own goal" },
        { icon: "🧑‍🏫", label: "A coach, your style" },
        { icon: "💵", label: "Money back if you finish" }
      ]
    },

    steps: {
      /* Screen 1 */
      goal: {
        intro: "A few quick questions to build your plan.",
        title: "What's your goal right now?",
        options: [
          { value: "get_moving", label: "Just get moving" },
          { value: "hit_10k", label: "Hit 10,000 steps a day" },
          { value: "lose_weight", label: "Lose some weight" },
          { value: "stay_consistent", label: "Finally stay consistent" }
        ]
      },

      /* Screen 2 */
      baseline: {
        title: "How many steps do you average now?",
        hint: "A rough guess is fine.",
        options: [
          { value: "under_5000", label: "Under 5,000" },
          { value: "five_to_ten", label: "5,000 to 10,000" },
          { value: "ten_to_fifteen", label: "10,000 to 15,000" },
          { value: "fifteen_plus", label: "15,000+" }
        ]
      },

      /* Screen 3 */
      difficulty: {
        title: "How much of a push do you want?",
        options: [
          { value: "easy", label: "Easy. Build the habit first." },
          { value: "medium", label: "Medium. A real stretch." },
          { value: "hard", label: "Hard. Push me." }
        ]
      },

      /* Screen 4 */
      coach: {
        title: "Pick your coach.",
        options: [
          { value: "princess", label: "Princess treatment", sub: "Warm, encouraging, Coach Serena" },
          { value: "tough", label: "Tough coach", sub: "Blunt, no excuses, Coach Tim" }
        ]
      },

      /* Screen 5 */
      mode: {
        title: "Solo, or with a group?",
        options: [
          { value: "group", label: "With a group", sub: "Join this week's cohort, starting Monday" },
          { value: "solo", label: "Solo", sub: "Your own private challenge, start anytime" }
        ]
      },

      /* Screen 6, solo only -- skipped entirely for group (see start-app.js).
         The group path's real stake comes from the actual cohort, not a pick. */
      stake: {
        title: "How much are you willing to put on the line?",
        hint: "Yours back in full the moment you finish.",
        options: SOLO_STAKE_OPTIONS.map(function (amount) {
          return { value: String(amount), label: "$" + amount };
        })
      },

      /* Screen 7: first name + email, captured before the paywall/checkout so
         a dropoff there still leaves a reachable lead (same reasoning as the
         moms funnel's contact step). */
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

      /* Screen 8: brief timed transition, no question. */
      preparing: {
        title: "Building your plan",
        body: "We're turning what you told us into an actual plan."
      },

      /* Screen 9, the paywall -- "Made for you". A short plan-facts list (one
         row per fact, icon + label + value) plus one clearly separated price
         at the bottom, rather than two same-sized numbers competing for
         attention. Mostly built from state in start-app.js, not static
         strings here. */
      results: {
        eyebrow: "Made for you",
        title: "Here's your plan.",
        dailyGoalLabel: "Daily goal",
        coachLabel: "Coach",
        formatLabel: "Format",
        stakeLabel: "Stake",
        stakeNote: "refunded in full when you finish",
        stakeDeferredNote: "choose at checkout",
        groupTitle: "A shared weekly cohort",
        groupSub: "Starting Monday",
        soloTitle: "Your own private challenge",
        soloBody: "Just you, your pace, starting the day you join.",
        spotsLeftLabel: "spots left this week",
        sampleMessageLabel: "A sample message from your coach",
        priceLabel: "Then, to keep your plan and your coach",
        continueCta: "Continue to checkout"
      },

      /* Screen 10 */
      checkout: {
        title: "Lock in your plan.",
        intro: "One card. The membership charges today; the stake is yours to choose.",
        includedLabel: "What's included",
        includedItems: [
          "Your personal step goal, built from your answers",
          "Daily messages from your coach",
          "Free tracking, history and leaderboards, always"
        ],
        membershipRowLabel: "Membership",
        stakeRowLabel: "Stake (refundable)",
        stakeRowDeferred: "Pay later, in the app",
        nameLabel: "First name",
        emailLabel: "Email",
        /* {stake} is replaced with the dollar amount, e.g. "$25". */
        stakeToggleLabel: "Also lock in my {stake} stake now",
        stakeToggleHint: "Leave this unchecked to pay it later, when you join in the app instead.",
        billingNote: "The membership is billed monthly, cancel anytime. The stake, if you lock it in now, is a one-time charge, refunded in full when you finish.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        cardLabel: "Card details",
        paymentPlaceholder: "Complete the fields above to enter payment details.",
        paymentLoading: "Loading payment details...",
        confirmCta: "Subscribe & lock in my stake",
        confirmCtaNoStake: "Subscribe",
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
      downloadBody: "Sign up with {email} and your plan, coach and stake will already be there, no setup needed.",
      downloadCta: "Download on the App Store",
      nextTitle: "What happens next",
      nextSteps: [
        { title: "Check your inbox", body: "Watch for a receipt from Stripe confirming today's charges." },
        { title: "Download Walka", body: "Sign up with the same email you just used, and your plan loads in automatically." },
        { title: "Start walking", body: "Your coach's first message lands within the hour." }
      ],
      cancelFallback: "To manage or cancel the membership anytime, email susan@getwalka.com."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susan@getwalka.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 6. SAMPLE COACH MESSAGES: one hand-copied line per persona for the
   *    paywall's "a sample message from your coach" preview. Lifted from
   *    the 'behind' bucket in lib/coach.ts (not imported -- this file has
   *    no build step to share TypeScript with the app) so a future coach-
   *    copy change there doesn't silently drift without a human noticing
   *    this needs updating too.
   * ------------------------------------------------------------------ */
  var SAMPLE_COACH_MESSAGE = {
    princess: "No rush, star. Every step still counts. Ease in when you're ready 👑",
    tough: "That goal won't hit itself. Move."
  };

  /* ------------------------------------------------------------------ *
   * 7. ANALYTICS EVENT NAMES, prefixed start_ so they never collide with
   *    the moms funnel's events or the main app's.
   * ------------------------------------------------------------------ */
  var EVENTS = {
    onboardingStart: "start_onboarding_start",
    stepViewed: "start_step_viewed",
    stepCompleted: "start_step_completed",
    dropoff: "start_dropoff",
    resultsViewed: "start_results_viewed",
    checkoutViewed: "start_checkout_viewed",
    checkoutStarted: "start_checkout_started",
    checkoutCompleted: "start_checkout_completed",
    checkoutFailed: "start_checkout_failed"
  };

  return {
    FEATURE_FLAG_KEY: FEATURE_FLAG_KEY,
    FORCE_FLOW_ENABLED: FORCE_FLOW_ENABLED,
    PREVIEW_STORAGE_KEY: PREVIEW_STORAGE_KEY,
    POSTHOG_FLAG_TIMEOUT_MS: POSTHOG_FLAG_TIMEOUT_MS,
    STRIPE_MODE: STRIPE_MODE,
    PLAN_PRICE_CENTS: PLAN_PRICE_CENTS,
    BILLING_INTERVAL: BILLING_INTERVAL,
    PLAN_DURATION_DAYS: PLAN_DURATION_DAYS,
    SOLO_STAKE_OPTIONS: SOLO_STAKE_OPTIONS,
    STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    SUPABASE_TABLE: SUPABASE_TABLE,
    APP_STORE_URL: APP_STORE_URL,
    GOAL_TO_FITNESS_GOAL: GOAL_TO_FITNESS_GOAL,
    GOAL_STRETCH: GOAL_STRETCH,
    DIFFICULTY_MULTIPLIER: DIFFICULTY_MULTIPLIER,
    STEP_FLOOR: STEP_FLOOR,
    STEP_CEILING: STEP_CEILING,
    BASELINE_BUCKETS: BASELINE_BUCKETS,
    COPY: COPY,
    SAMPLE_COACH_MESSAGE: SAMPLE_COACH_MESSAGE,
    EVENTS: EVENTS
  };
})();
