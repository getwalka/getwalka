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
   *    This repo has no payment backend, so checkout uses one Stripe
   *    Payment Link (hosted by Stripe; we never touch card data) for
   *    the whole cohort plan below, price = TOTAL_CHARGE_CENTS.
   *    Create it in the Stripe TEST MODE dashboard:
   *      Products > + Add product > one-time price > Create payment link
   *    Then under the link's settings, set "After payment" to redirect
   *    to your own URL:
   *      https://getwalka.com/moms-success
   *    (Stripe Payment Links don't support a separate "cancel" redirect;
   *    if someone abandons, they just use the browser back button.)
   *
   *    TEST -> LIVE is a single change: swap STRIPE_MODE to "live" and
   *    fill in the "live" link once you've created the equivalent
   *    live-mode Payment Link.
   *
   *    Cohort only: solo is out of scope for this flow (hidden behind a
   *    separate feature flag on mobile, not built here).
   * ------------------------------------------------------------------ */
  var STRIPE_MODE = "test"; // "test" | "live"

  var PROGRAM_LENGTH_WEEKS = 4;

  /* Total stake, returned in full if you finish without missing every day. */
  var COHORT_STAKE_AMOUNT_CENTS = 6000; // $60 total: $15/week x 4 weeks

  /* Platform revenue, not returned. One upfront charge, marketed as
     "$4.99/week" but never billed weekly, that would make it a recurring
     subscription collected outside the App/Play Store, which this flow
     must not do. */
  var ENTRY_FEE_CENTS = 2000; // $20 total ($4.99/week x 4, rounded)

  /* Applies from day 1: no grace period, no free "life happened" passes.
     Missing every day across the whole program forfeits exactly the full
     stake (300 x 20 weekdays = 6000). Forfeited money goes into the pool
     split among cohort members who finish, same mechanic as the main app. */
  var MISS_AMOUNT_CENTS_PER_DAY = 300; // $3/day

  var TOTAL_CHARGE_CENTS = COHORT_STAKE_AMOUNT_CENTS + ENTRY_FEE_CENTS; // $80, one charge

  var COHORT_PAYMENT_LINK = {
    test: "https://buy.stripe.com/test_REPLACE_ME_COHORT",
    live: "https://buy.stripe.com/REPLACE_ME_COHORT"
  };

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
      title: "Moving again, gently.",
      body: "A short walking plan built around where your body actually is right now, pregnant or postpartum. No weigh-ins, no before-and-afters, no bouncing back to anything.",
      cta: "Let's begin",
      takesTime: "About 3 minutes.",

      howEyebrow: "How it works",
      howTitle: "Three steps, at your pace.",
      howSteps: [
        {
          icon: "💬",
          title: "Tell us where you're at",
          desc: "A few quick questions about your stage, clearance, and energy. No pressure, no wrong answers."
        },
        {
          icon: "🤝",
          title: "Get matched to your cohort",
          desc: "Walk alongside others at a similar stage, due soon, or weeks to months postpartum."
        },
        {
          icon: "👣",
          title: "Walk, and get your stake back",
          desc: "A $60 stake over 4 weeks. Miss a day, lose $3. Finish, and the rest comes right back."
        }
      ],

      cohortEyebrow: "Your people",
      cohortTitle: "Walk with people who get it.",
      cohortBody: "Every cohort is grouped by stage, so you're never the only one due soon or a few weeks postpartum.",
      cohortGroups: [
        { caption: "Due soon", photo: "images/cohort-due-soon.jpg", fallbackIcon: "🤰" },
        { caption: "0–3 months postpartum", photo: "images/cohort-0-3m.jpg", fallbackIcon: "🚶‍♀️" },
        { caption: "3–6 months postpartum", photo: "images/cohort-3-6m.jpg", fallbackIcon: "🚶‍♀️" },
        { caption: "6–12 months postpartum", photo: "images/cohort-6-12m.jpg", fallbackIcon: "🚶‍♀️" }
      ],

      stakeNote: "A $60 stake over 4 weeks, plus a one-time $20 entry fee."
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
        stakeLine: "You're staking {stake}.",
        missLine: "Miss a day, lose {miss}. No grace days, no free passes, every day counts from day one.",
        poolLine: "Money from missed days goes to the cohort members who finish.",
        feeLine: "Plus a one-time {fee} entry fee, charged today, not refundable.",
        summaryLine: "Miss a day, lose {miss}. Finish, keep your stake.",
        summaryHint: "Every day counts from day one. No grace period, no free misses."
      },
      checkout: {
        title: "Confirm",
        nameLabel: "First name",
        emailLabel: "Email",
        summaryGoalLabel: "Goal",
        summaryLengthLabel: "Challenge length",
        summaryCohortLabel: "Cohort",
        summaryToneLabel: "Style",
        summaryStakeLabel: "Stake",
        summaryFeeLabel: "Entry fee",
        summaryMissLabel: "If you miss a day",
        summaryTotalLabel: "Total today",
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
    PROGRAM_LENGTH_WEEKS: PROGRAM_LENGTH_WEEKS,
    COHORT_STAKE_AMOUNT_CENTS: COHORT_STAKE_AMOUNT_CENTS,
    ENTRY_FEE_CENTS: ENTRY_FEE_CENTS,
    MISS_AMOUNT_CENTS_PER_DAY: MISS_AMOUNT_CENTS_PER_DAY,
    TOTAL_CHARGE_CENTS: TOTAL_CHARGE_CENTS,
    COHORT_PAYMENT_LINK: COHORT_PAYMENT_LINK,
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
