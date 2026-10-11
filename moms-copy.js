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
   *
   *    FORCE_FLOW_ENABLED bypasses this gate for everyone, no PostHog
   *    flag or ?preview needed. Flip back to false (not delete the gate
   *    code) to go back to flag-gated access.
   * ------------------------------------------------------------------ */
  var FEATURE_FLAG_KEY = "moms-postpartum-flow";
  var PREVIEW_STORAGE_KEY = "walka_moms_preview";
  var FORCE_FLOW_ENABLED = true;
  var POSTHOG_FLAG_TIMEOUT_MS = 2500; // fail closed if flags never arrive

  /* ------------------------------------------------------------------ *
   * 1b. GEO GATE: US/Canada only
   *    middleware.js (Vercel Edge Middleware) stamps a walka_geo_country
   *    cookie from Vercel's own IP geolocation on every /moms request.
   *    moms-app.js reads that cookie and blocks checkout for anyone
   *    outside this list, showing COPY.geoGate instead of the flow.
   *
   *    Fails OPEN: if the cookie is missing or empty (middleware didn't
   *    run, e.g. local dev), the visitor is let through rather than
   *    blocked, so a detection hiccup never costs a real US/CA signup.
   *    The ?preview=1 override bypasses this gate too, same as the
   *    feature-flag gate, so QA can test from anywhere.
   *
   *    Every visitor's country (allowed, blocked, or unknown) is still
   *    logged to Supabase (moms_leads.country) and PostHog so you can see
   *    the actual country breakdown, not just who got through.
   * ------------------------------------------------------------------ */
  var GEO_ALLOWED_COUNTRIES = ["US", "CA"];

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
  var STRIPE_MODE = "live"; // "test" | "live"

  var PROGRAM_LENGTH_WEEKS = 4;

  /* Total stake, returned in full if you finish without missing every day.
     $39.99, deliberately a cent under $40, same under-the-round-number
     pattern as the main app's $19.99 entry (see CLAUDE.md). */
  var COHORT_STAKE_AMOUNT_CENTS = 3999; // $39.99 total

  /* Platform revenue, not returned. One upfront charge, marketed as
     "~$2.50/week" but never billed weekly, that would make it a recurring
     subscription collected outside the App/Play Store, which this flow
     must not do. */
  var ENTRY_FEE_CENTS = 1000; // $10 total (~$2.50/week x 4, rounded)

  /* Applies from day 1: no grace period, no free "life happened" passes.
     Missing every day across the whole program forfeits effectively the
     full stake (200 x 20 weekdays = 4000, one cent over the $39.99 stake;
     the mechanic caps forfeiture at the stake itself, same rounding gap as
     the stake-vs-$40 cent above). Forfeited money goes into the pool split
     among cohort members who finish, same mechanic as the main app. */
  var MISS_AMOUNT_CENTS_PER_DAY = 200; // $2/day

  var TOTAL_CHARGE_CENTS = COHORT_STAKE_AMOUNT_CENTS + ENTRY_FEE_CENTS; // $49.99, one charge

  var COHORT_PAYMENT_LINK = {
    test: "https://buy.stripe.com/test_4gM3cw7Qa5offD74NHdwc00",
    live: "https://buy.stripe.com/4gM3cw7Qa5offD74NHdwc00"
  };

  /* ------------------------------------------------------------------ *
   * 3. SUPABASE: stores onboarding answers + lead status
   *
   *    Public anon key only (never the service role key in client code).
   *    Protected by the RLS policy in supabase/moms_leads.sql; anon can
   *    insert, and can read/update only the row matching the local_id it
   *    already holds. The select policy exists because Postgres needs
   *    read visibility to resolve upsert()'s ON CONFLICT under RLS, not
   *    because anything in this page actually reads leads back.
   *    Fill these in from Project Settings > API in your Supabase dashboard.
   * ------------------------------------------------------------------ */
  var SUPABASE_URL = "https://mgocpqbxssvjlmqzqfgn.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nb2NwcWJ4c3N2amxtcXpxZmduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzNzQyMjQsImV4cCI6MjA3Nzk1MDIyNH0.CEgJvGEOJJe5slTp3EKvOqw1pOwJOWK2GTitoL1QODY";
  var SUPABASE_TABLE = "moms_leads";

  /* ------------------------------------------------------------------ *
   * 4. GOAL
   * ------------------------------------------------------------------ */
  var GOAL_OPTIONS = [3000, 5000, 10000];
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
      encourageGoal: "Pick a gentle starting goal.",
      prepareModeNote: "No pressure, no numbers yet. You're welcome here as you are.",
      checkoutIntro: "Here's your plan."
    },
    coach: {
      name: "Tough coach",
      continue: "Next",
      encourageGoal: "Pick your starting number and commit.",
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

    geoGate: {
      title: "Not available in your country yet.",
      body: "This program is currently only open to the US and Canada. Check back as we expand to more places.",
      cta: "Back to getwalka.com"
    },

    nav: { back: "Save & exit" },

    resumeBanner: "Welcome back. Picking up where you left off.",

    disclaimer: "Not medical advice. Follow your doctor's or midwife's guidance.",

    landing: {
      eyebrow: "For pregnancy & postpartum",
      title: "Moving again, gently.",
      tagline: "No weigh-ins. No bouncing back. Just your pace.",
      cta: "Let's begin",
      heroPhoto: "images/feature-pace.jpg",

      howEyebrow: "How it works",
      howTitle: "Three steps, at your pace.",
      howSteps: [
        {
          icon: "💬",
          photo: "images/feature-coach.jpg",
          title: "Find your starting point",
          desc: "A few quick questions. No wrong answers."
        },
        {
          icon: "🫂",
          photo: "images/feature-circle.jpg",
          title: "Meet your circle and coach",
          desc: "Walk alongside others at a similar stage, with daily nudges from your AI coach."
        },
        {
          icon: "🚶‍♀️",
          photo: "images/feature-pace.jpg",
          title: "Walk together. Stay accountable.",
          desc: "A {stake} stake over 4 weeks. Finish, and it all comes back."
        }
      ],

      cohortEyebrow: "Your people",
      cohortTitle: "Walk with people who get it.",
      cohortBody: "Grouped by stage, so you're never the only one.",
      cohortGroups: [
        { caption: "Due soon" },
        { caption: "0–3 months postpartum" },
        { caption: "3–6 months postpartum" },
        { caption: "6–12 months postpartum" }
      ]
    },

    steps: {
      stage: {
        title: "Where are you right now?",
        options: [
          { value: "pregnant", label: "Pregnant" },
          { value: "postpartum", label: "Postpartum" }
        ],
        dueDateLabel: "Due date (optional)",
        weeksLabel: "Weeks postpartum (optional)"
      },
      clearance: {
        title: "Are you cleared for exercise by your doctor or midwife?",
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
        options: [
          { value: 3000, label: "3,000 steps/day" },
          { value: 5000, label: "5,000 steps/day" },
          { value: 10000, label: "10,000 steps/day" }
        ],
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
        title: "Your people",
        recapTitle: "What you're joining",
        recapItems: [
          "A small circle of women at a similar stage",
          "Daily encouragement from Walka's AI coach",
          "A 4-week structure, at your own pace"
        ],
        assignedLabel: "You'll be grouped with: {group}",
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
        recapLine: "You're joining {cohort}.",
        lengthLabel: "Length",
        stakeLabel: "Stake",
        feeLabel: "Entry fee",
        missLabel: "Miss a weekday",
        prepareMissValue: "Not tracked yet",
        noteLine: "Finish, keep your stake. Weekends don't count.",
        prepareNote: "No payment until you're cleared. We'll email you when it's time to confirm your spot."
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
        summaryMissLabel: "If you miss a weekday",
        summaryTotalLabel: "Total today",
        prepareMissValue: "Not tracked yet",
        prepareTotalValue: "Nothing today",
        prepareExplainer: "You're reserving your spot, not starting a challenge yet. No workouts, no missed-day deductions, and no payment today. You'll pay {total} only once you're cleared and ready to begin.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        payCta: "Pay",
        payCtaPrepare: "Reserve my spot",
        reservedTitle: "You're on the list.",
        reservedBody: "No charge today. We'll email you when it's time to confirm your spot and pay, once you're cleared.",
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
    checkoutFailed: "moms_checkout_failed",
    geoBlocked: "moms_geo_blocked",
    prepareReserved: "moms_prepare_reserved"
  };

  return {
    FEATURE_FLAG_KEY: FEATURE_FLAG_KEY,
    FORCE_FLOW_ENABLED: FORCE_FLOW_ENABLED,
    PREVIEW_STORAGE_KEY: PREVIEW_STORAGE_KEY,
    POSTHOG_FLAG_TIMEOUT_MS: POSTHOG_FLAG_TIMEOUT_MS,
    GEO_ALLOWED_COUNTRIES: GEO_ALLOWED_COUNTRIES,
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
    GOAL_OPTIONS: GOAL_OPTIONS,
    PREPARE_MODE_DEFAULT_GOAL: PREPARE_MODE_DEFAULT_GOAL,
    TONE: TONE,
    COPY: COPY,
    EVENTS: EVENTS
  };
})();
