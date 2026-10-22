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
   * 1b. GEO GATE: US/Canada only
   *    middleware.js (Vercel Edge Middleware) stamps a walka_geo_country
   *    cookie from Vercel's own IP geolocation on every /start request.
   *    start-app.js reads that cookie and blocks checkout for anyone
   *    outside this list, showing COPY.geoGate instead of the flow. Same
   *    mechanism as the moms funnel's gate (moms-copy.js).
   *
   *    Fails OPEN: if the cookie is missing or empty (middleware didn't
   *    run, e.g. local dev), the visitor is let through rather than
   *    blocked, so a detection hiccup never costs a real US/CA signup.
   *    The ?preview=1 override bypasses this gate too, same as the
   *    feature-flag gate, so QA can test from anywhere.
   *
   *    Every visitor's country (allowed, blocked, or unknown) is still
   *    logged to Supabase (start_leads.country) and PostHog so you can see
   *    the actual country breakdown, not just who got through.
   * ------------------------------------------------------------------ */
  var GEO_ALLOWED_COUNTRIES = ["US", "CA"];

  /* ------------------------------------------------------------------ *
   * 2. PAYMENTS: Stripe, recurring membership, priced per currency.
   *
   *    Checkout charges the $24.99/mo membership only (via
   *    create-start-subscription-intent, a Stripe Subscription). The stake
   *    is removed from this funnel for now -- see git history for the old
   *    `stake` step and the stake UI in the `results`/`checkout` steps of
   *    start-app.js. create-start-stake-intent and SOLO_STAKE_OPTIONS below
   *    are unused while it's off.
   *
   *    Same numeral, two currencies: $24.99 USD for US visitors, $24.99 CAD
   *    for Canadian visitors (not a currency conversion of one price into
   *    the other -- two separate Stripe Prices, each literally 2499 minor
   *    units in its own currency). getwalka only ever serves US/CA for this
   *    funnel (see GEO_ALLOWED_COUNTRIES above), so those are the only two
   *    currencies this needs.
   *
   *    In the Stripe dashboard, for EACH currency: Products > "Walka Start
   *    Membership" (existing product, or create it) > + Add another price >
   *    Recurring, Monthly, pick the currency, 24.99 > copy its Price id into
   *    the matching env var on the create-start-subscription-intent Edge
   *    Function (NOT here -- price ids are read server-side):
   *      USD -> START_MEMBERSHIP_PRICE_ID_USD
   *      CAD -> START_MEMBERSHIP_PRICE_ID_CAD
   * ------------------------------------------------------------------ */
  /* Temporarily "live", NOT because checkout has been verified end to end --
     it hasn't yet. The shared STRIPE_SECRET_KEY on this Supabase project is
     the LIVE key (the /moms funnel already runs in live mode off the same
     project-wide secret, and Edge Functions only have one STRIPE_SECRET_KEY,
     not a test/live pair), so a "test" publishable key here would mount
     Stripe Elements against a live-mode clientSecret and fail silently.
     Testing the actual checkout therefore means a real card and a real
     (small, refundable) charge -- cancel/refund it in the Stripe dashboard
     afterward. Revisit if this funnel gets its own test-mode secret key
     later. */
  var STRIPE_MODE = "live"; // "test" | "live"

  var PLAN_PRICE_CENTS = 2499; // $24.99
  var BILLING_INTERVAL = "month";
  var PLAN_DURATION_DAYS = 5; // matches SOLO_DURATION_DAYS (lib/soloChallenge.ts) and the cohort's DURATION_DAYS (seed-weekly-cohort)

  /* Unused while the stake is removed from this funnel (see the PAYMENTS
     note above). Left defined, still mirroring SOLO_STAKE_OPTIONS in
     lib/soloOffer.ts and the enforce_solo_stake() trigger
     (20260925000003_solo_stake_bounds.sql), so re-adding a stake step
     doesn't require re-deriving these numbers. */
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
    metaDescription: "A step goal and a coach built around how you actually walk.",

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

    disclaimer: "No app feature is ever locked behind a fee. Tracking, your coach, and history are free, always.",

    introHeader: {
      title: "A plan that actually fits how you walk.",
      body: "Some quick questions, then we'll build your plan: a daily goal and a coach in your corner.",
      features: [
        { icon: "🎯", label: "Your own goal" },
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
          { value: "princess", label: "Gentle coach", sub: "Princess treatment: warm and encouraging, Coach Serena" },
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

      /* Screen 6: first name + email, captured before the paywall/checkout so
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

      /* Screen 7: brief timed transition, no question. */
      preparing: {
        title: "Building your plan",
        body: "We're turning what you told us into an actual plan."
      },

      /* Screen 8, the paywall -- "Made for you". A short plan-facts list (one
         row per fact: your goal, your coach, your format) plus one clearly
         separated price at the bottom. The stake is left out here for now
         (see start-app.js); re-add its planRow if it comes back. Mostly
         built from state in start-app.js, not static strings here. */
      results: {
        eyebrow: "Made for you",
        title: "Here's your plan.",
        dailyGoalLabel: "Daily goal",
        coachLabel: "Coach",
        formatLabel: "Format",
        groupTitle: "A shared weekly cohort",
        groupSub: "Starting Monday",
        /* Shown only when paidCount > 0 -- social proof ("3 people already
           joined"), not a spots-remaining count. max_participants is a
           generous cap (30), so "X spots left" on a young cohort reads as
           "barely anyone's here" instead of urgent; see
           get-weekly-cohort-preview's comment on paidCount. */
        joinedLabel: "already joined",
        soloTitle: "Your own private challenge",
        soloBody: "Just you, your pace, starting the day you join.",
        priceLabel: "Your membership",
        continueCta: "Continue to checkout"
      },

      /* Screen 9 */
      checkout: {
        title: "Lock in your plan.",
        intro: "Your membership charges today.",
        includedLabel: "What's included",
        includedItems: [
          "Your personal step goal, built from your answers",
          "Daily messages from your coach",
          "Connect with other walkers in your group",
          "Free tracking, history and leaderboards, always"
        ],
        membershipRowLabel: "Membership",
        nameLabel: "First name",
        emailLabel: "Email",
        billingNoteBase: "The membership is billed monthly, cancel anytime.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        cardLabel: "Card details",
        paymentPlaceholder: "Complete the fields above to enter payment details.",
        paymentLoading: "Loading payment details...",
        confirmCta: "Subscribe",
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
      cancelFallback: "To manage or cancel the membership anytime, email susan@getwalka.com."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susan@getwalka.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 6. ANALYTICS EVENT NAMES, prefixed start_ so they never collide with
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
    checkoutFailed: "start_checkout_failed",
    geoBlocked: "start_geo_blocked"
  };

  return {
    FEATURE_FLAG_KEY: FEATURE_FLAG_KEY,
    FORCE_FLOW_ENABLED: FORCE_FLOW_ENABLED,
    PREVIEW_STORAGE_KEY: PREVIEW_STORAGE_KEY,
    POSTHOG_FLAG_TIMEOUT_MS: POSTHOG_FLAG_TIMEOUT_MS,
    GEO_ALLOWED_COUNTRIES: GEO_ALLOWED_COUNTRIES,
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
    EVENTS: EVENTS
  };
})();
