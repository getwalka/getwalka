/* ==========================================================================
   Walka: Postpartum Mums test flow, COPY + CONFIG
   Everything editable about this experiment lives in this one file:
   wording, tone variants, commitment-mechanic settings, feature flag name,
   and third-party keys/links. No other file should need to change to tune
   the experiment.
   ========================================================================== */
window.WALKA_MOMS = (function () {

  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. FEATURE FLAG
   *    Gated via a PostHog feature flag (PostHog is already wired into
   *    this site). Create a flag with this exact key in the PostHog
   *    dashboard and release it to the people/cohort you want to test
   *    with. Default-off (fail closed) if PostHog can't be reached.
   *
   *    QA / sharing a test link before the flag is rolled out:
   *    visit /moms?preview=1 once in a browser to locally unlock the
   *    flow on that device regardless of the flag (stored in
   *    localStorage). /moms?preview=0 removes the override.
   * ------------------------------------------------------------------ */
  var FEATURE_FLAG_KEY = "moms-postpartum-flow";
  var PREVIEW_STORAGE_KEY = "walka_moms_preview";
  var POSTHOG_FLAG_TIMEOUT_MS = 2500; // fail closed if flags never arrive

  /* ------------------------------------------------------------------ *
   * 2. PAYMENTS: Stripe, TEST MODE by default
   *
   *    This repo has no payment backend, so checkout uses Stripe
   *    Payment Links (hosted by Stripe; we never touch card data).
   *    Each stake tier below needs its own Payment Link created in the
   *    Stripe TEST MODE dashboard:
   *      Products > + Add product > ... > Create payment link
   *    Then under the link's settings, set "After payment" to redirect
   *    to your own URL:
   *      https://getwalka.com/moms-success
   *    (Stripe Payment Links don't support a separate "cancel" redirect;
   *    if someone abandons, they just use the browser back button.)
   *
   *    TEST -> LIVE is a single change: swap STRIPE_MODE to "live" and
   *    fill in the "live" link for each tier below once you've created
   *    the equivalent live-mode Payment Links.
   * ------------------------------------------------------------------ */
  var STRIPE_MODE = "test"; // "test" | "live"

  /* Cohort members always stake this amount, no choice shown. */
  var COHORT_STAKE_AMOUNT_CENTS = 1500;

  /* Solo members pick one of these as their total stake, then pick how
     much of it is actually at risk per missed week from that tier's
     missOptions. One Payment Link per tier (price = amountCents). */
  var STAKE_TIERS = [
    {
      amountCents: 1500,
      amountLabel: "$15",
      missOptions: [
        { cents: 100, label: "$1" },
        { cents: 200, label: "$2" },
        { cents: 300, label: "$3" }
      ],
      links: {
        test: "https://buy.stripe.com/test_REPLACE_ME_15",
        live: "https://buy.stripe.com/REPLACE_ME_15"
      }
    },
    {
      amountCents: 2500,
      amountLabel: "$25",
      missOptions: [
        { cents: 200, label: "$2" },
        { cents: 350, label: "$3.50" },
        { cents: 500, label: "$5" }
      ],
      links: {
        test: "https://buy.stripe.com/test_REPLACE_ME_25",
        live: "https://buy.stripe.com/REPLACE_ME_25"
      }
    },
    {
      amountCents: 5000,
      amountLabel: "$50",
      missOptions: [
        { cents: 300, label: "$3" },
        { cents: 500, label: "$5" },
        { cents: 1000, label: "$10" }
      ],
      links: {
        test: "https://buy.stripe.com/test_REPLACE_ME_50",
        live: "https://buy.stripe.com/REPLACE_ME_50"
      }
    },
    {
      amountCents: 10000,
      amountLabel: "$100",
      missOptions: [
        { cents: 500, label: "$5" },
        { cents: 1000, label: "$10" },
        { cents: 2000, label: "$20" }
      ],
      links: {
        test: "https://buy.stripe.com/test_REPLACE_ME_100",
        live: "https://buy.stripe.com/REPLACE_ME_100"
      }
    }
  ];

  /* One-time payment, fixed-length challenge (not a subscription).
     Stripe Payment Links above should be one-time prices, not recurring. */
  var PROGRAM_LENGTH_WEEKS = 8;
  var GRACE_PERIOD_WEEKS = 2;          // no money at risk for this many weeks after joining
  var LIFE_HAPPENED_PASSES_TOTAL = 4;  // free misses for the whole challenge, not recurring

  /* ------------------------------------------------------------------ *
   * 3. SUPABASE: stores onboarding answers + lead status
   *
   *    Public anon key only (never the service role key in client code).
   *    Protected by the RLS policy in supabase/moms_leads.sql; anon can
   *    insert and can update only the row matching the local_id it
   *    already holds, nothing is readable with this key.
   *    Fill these in from Project Settings > API in your Supabase dashboard.
   * ------------------------------------------------------------------ */
  var SUPABASE_URL = "https://mgocpqbxssvjlmqzqfgn.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nb2NwcWJ4c3N2amxtcXpxZmduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzNzQyMjQsImV4cCI6MjA3Nzk1MDIyNH0.CEgJvGEOJJe5slTp3EKvOqw1pOwJOWK2GTitoL1QODY";
  var SUPABASE_TABLE = "moms_leads";

  /* ------------------------------------------------------------------ *
   * 4. GOAL SUGGESTION
   * ------------------------------------------------------------------ */
  var BASELINE_STEPS_BY_BUCKET = {
    under_2k: 1500,
    "2k_5k": 3500,
    "5k_8k": 6500,
    "8k_plus": 9000,
    not_sure: 3000
  };
  var ENERGY_MULTIPLIER = { low: 0.8, medium: 1.0, high: 1.15 };
  var GOAL_STEP_INCREMENT = 500;
  var GOAL_MIN = 1000;
  var GOAL_MAX = 15000;
  var PREPARE_MODE_DEFAULT_GOAL = null; // no numeric step goal until cleared

  /* ------------------------------------------------------------------ *
   * 5. COPY, by motivation style. "princess" is the default tone;
   *    every onboarding/checkout string below should pull from here
   *    rather than being hardcoded in the page. Keep it short.
   * ------------------------------------------------------------------ */
  var TONE = {
    princess: {
      name: "Princess treatment",
      continue: "Continue",
      encourageGoal: "Here's a gentle starting goal. You can adjust it.",
      prepareModeNote: "No pressure, no numbers yet. You're welcome here as you are.",
      checkoutIntro: "Here's your plan."
    },
    coach: {
      name: "Tough coach",
      continue: "Next",
      encourageGoal: "Here's your starting number. Adjust if needed, but commit.",
      prepareModeNote: "No goal yet. Get cleared first, then we go to work.",
      checkoutIntro: "Here's the deal. Lock it in."
    }
  };

  var COPY = {
    metaTitle: "Walka for new mums",
    metaDescription: "A walking plan and accountability cohort for pregnancy and postpartum, at your pace.",

    gate: {
      title: "This page isn't open yet.",
      body: "Check back soon, or head back to the homepage.",
      cta: "Back to getwalka.com"
    },

    nav: { back: "Save & exit" },

    resumeBanner: "Welcome back. Picking up where you left off.",

    disclaimer: "Not medical advice. Follow your doctor's or midwife's guidance.",

    landing: {
      eyebrow: "For pregnancy & postpartum",
      title: "A gentler way to keep moving.",
      body: "A walking plan and cohort built around new motherhood. Set your own pace, show up with people who get it.",
      features: [
        { icon: "🌱", title: "Starts gentle", desc: "Goals ramp up slowly. Nothing before you're cleared." },
        { icon: "🤝", title: "A cohort that gets it", desc: "Walk alongside other pregnant and postpartum mums." },
        { icon: "💛", title: "Grace, not guilt", desc: "Free weeks and free misses built in. Finish and your stake comes back." }
      ],
      stakeNote: "A small, mostly-refundable stake, from $15.",
      cta: "Let's begin",
      takesTime: "About 3 minutes."
    },

    steps: {
      stage: {
        title: "Where are you right now?",
        options: [
          { value: "pregnant", label: "Pregnant" },
          { value: "postpartum", label: "Postpartum" }
        ],
        dueDateLabel: "Due date (optional)",
        weeksLabel: "Weeks postpartum (optional)",
        deliveryLabel: "Delivery type",
        deliveryOptions: [
          { value: "vaginal", label: "Vaginal" },
          { value: "csection", label: "C-section" },
          { value: "prefer_not_to_say", label: "Prefer not to say" }
        ]
      },
      clearance: {
        title: "Cleared for exercise by your doctor or midwife?",
        options: [
          { value: "yes", label: "Yes" },
          { value: "not_yet", label: "Not yet" },
          { value: "not_sure", label: "Not sure" }
        ],
        notClearedNote: "No problem. Join now in prepare mode, no step goals until you're cleared.",
        medicalReminder: "Not medical advice. Check with your doctor or midwife first."
      },
      baseline: {
        title: "Where are you starting from?",
        stepsLabel: "Typical steps per day",
        stepsOptions: [
          { value: "under_2k", label: "Under 2,000" },
          { value: "2k_5k", label: "2,000–5,000" },
          { value: "5k_8k", label: "5,000–8,000" },
          { value: "8k_plus", label: "8,000+" },
          { value: "not_sure", label: "Not sure" }
        ],
        energyLabel: "Energy level lately",
        energyOptions: [
          { value: "low", label: "Low" },
          { value: "medium", label: "Okay" },
          { value: "high", label: "Good" }
        ],
        barriersLabel: "What gets in the way?",
        barriersOptions: [
          { value: "baby_sleep", label: "Baby's sleep" },
          { value: "time", label: "Time" },
          { value: "tiredness", label: "Tiredness" },
          { value: "motivation", label: "Motivation" },
          { value: "pain", label: "Pain" },
          { value: "other", label: "Something else" }
        ]
      },
      goal: {
        title: "Your starting goal",
        adjustHint: "Drag up or down. No wrong answer.",
        dailyLabel: "Daily steps",
        weeklyFrame: "Aim for 5 good days a week, not 7.",
        prepareModeTitle: "No step goal yet, and that's the plan."
      },
      motivation: {
        title: "What kind of voice helps you most?",
        options: [
          { value: "princess", label: "Princess treatment", desc: "Gentle and encouraging" },
          { value: "coach", label: "Tough coach", desc: "Direct, no excuses" }
        ]
      },
      cohort: {
        title: "Pick your people",
        soloOption: { value: "solo", label: "Just me, solo" },
        partnerNote: "Want a walking partner instead? You can ask once you're in.",
        groupsPregnant: [
          { value: "due_soon", label: "Due soon" }
        ],
        groupsPostpartum: [
          { value: "0_3m", label: "0–3 months postpartum" },
          { value: "3_6m", label: "3–6 months postpartum" },
          { value: "6_12m", label: "6–12 months postpartum" }
        ]
      },
      commit: {
        title: "Your stake",
        lengthNote: "Your challenge runs {weeks} weeks.",
        chooseStakeLabel: "Choose your stake",
        cohortStakeNote: "Your stake is {amount}.",
        missLabel: "If you miss a week, how much is at risk?",
        summaryLine: "Miss a week, lose {miss}. Finish, keep it all.",
        summaryHint: "No risk for your first {grace} weeks, plus {passes} free misses after that."
      },
      checkout: {
        title: "Confirm",
        nameLabel: "First name",
        emailLabel: "Email",
        summaryGoalLabel: "Goal",
        summaryLengthLabel: "Challenge length",
        summaryCohortLabel: "Cohort",
        summaryToneLabel: "Style",
        summaryAmountLabel: "Stake",
        summaryMissLabel: "If you miss",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        payCta: "Pay",
        testModeNote: "Test mode: card 4242 4242 4242 4242, any date, any CVC.",
        legalLinks: { terms: "/terms", privacy: "/privacy" }
      }
    },

    success: {
      title: "You're in.",
      body: "Welcome to your cohort. We'll email your plan and next steps soon.",
      note: "Check your inbox for details."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susanadelokiki@gmail.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 6. ANALYTICS EVENT NAMES: keep these in sync with anything you
   *    build in PostHog (insights, funnels). All prefixed moms_ so they
   *    never collide with the main flow's events.
   * ------------------------------------------------------------------ */
  var EVENTS = {
    landingView: "moms_landing_view",
    onboardingStart: "moms_onboarding_start",
    stepViewed: "moms_step_viewed",
    stepCompleted: "moms_step_completed",
    dropoff: "moms_dropoff",
    clearanceAnswered: "moms_clearance_answered",
    motivationChosen: "moms_motivation_chosen",
    cohortChosen: "moms_cohort_chosen",
    checkoutViewed: "moms_checkout_viewed",
    checkoutStarted: "moms_checkout_started",
    checkoutCompleted: "moms_checkout_completed",
    checkoutFailed: "moms_checkout_failed"
  };

  return {
    FEATURE_FLAG_KEY: FEATURE_FLAG_KEY,
    PREVIEW_STORAGE_KEY: PREVIEW_STORAGE_KEY,
    POSTHOG_FLAG_TIMEOUT_MS: POSTHOG_FLAG_TIMEOUT_MS,
    STRIPE_MODE: STRIPE_MODE,
    COHORT_STAKE_AMOUNT_CENTS: COHORT_STAKE_AMOUNT_CENTS,
    STAKE_TIERS: STAKE_TIERS,
    PROGRAM_LENGTH_WEEKS: PROGRAM_LENGTH_WEEKS,
    GRACE_PERIOD_WEEKS: GRACE_PERIOD_WEEKS,
    LIFE_HAPPENED_PASSES_TOTAL: LIFE_HAPPENED_PASSES_TOTAL,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    SUPABASE_TABLE: SUPABASE_TABLE,
    BASELINE_STEPS_BY_BUCKET: BASELINE_STEPS_BY_BUCKET,
    ENERGY_MULTIPLIER: ENERGY_MULTIPLIER,
    GOAL_STEP_INCREMENT: GOAL_STEP_INCREMENT,
    GOAL_MIN: GOAL_MIN,
    GOAL_MAX: GOAL_MAX,
    PREPARE_MODE_DEFAULT_GOAL: PREPARE_MODE_DEFAULT_GOAL,
    TONE: TONE,
    COPY: COPY,
    EVENTS: EVENTS
  };
})();
