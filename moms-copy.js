/* ==========================================================================
   Walka — Postpartum Mums test flow: COPY + CONFIG
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
   * 2. PAYMENTS — Stripe, TEST MODE by default
   *
   *    This repo has no payment backend, so checkout uses Stripe
   *    Payment Links (hosted by Stripe — we never touch card data).
   *    Each commitment option + amount below needs its own Payment
   *    Link created in the Stripe TEST MODE dashboard:
   *      Products > + Add product > ... > Create payment link
   *    Then under the link's settings, set "After payment" to redirect
   *    to your own URL:
   *      https://getwalka.com/moms-success
   *    (Stripe Payment Links don't support a separate "cancel" redirect —
   *    if someone abandons, they just use the browser back button.)
   *
   *    TEST -> LIVE is a single change: swap STRIPE_MODE to "live" and
   *    fill in the "live" link for each option below once you've
   *    created the equivalent live-mode Payment Links.
   * ------------------------------------------------------------------ */
  var STRIPE_MODE = "test"; // "test" | "live"

  var COMMITMENT_OPTIONS = [
    {
      id: "buyin",
      kind: "stake",
      label: "Small buy-in",
      amountCents: 1500, // $15 default — change freely, keep in sync with the Payment Link price
      amountLabel: "$15",
      blurb: "Finish your plan and it comes back. Miss too much and it doesn't — but grace weeks and passes mean normal new-mum chaos won't cost you.",
      links: {
        test: "https://buy.stripe.com/test_REPLACE_ME_BUYIN",
        live: "https://buy.stripe.com/REPLACE_ME_BUYIN"
      }
    },
    {
      id: "pledge",
      kind: "no_loss",
      label: "Commitment pledge",
      amountCents: 2000, // $20 default — fully refundable regardless of outcome
      amountLabel: "$20",
      blurb: "A fully refundable deposit. You get every cent back no matter what happens — it's just a commitment signal, not a stake.",
      links: {
        test: "https://buy.stripe.com/test_REPLACE_ME_PLEDGE",
        live: "https://buy.stripe.com/REPLACE_ME_PLEDGE"
      }
    }
  ];

  var GRACE_PERIOD_WEEKS = 2;        // no money at risk for this many weeks after joining
  var LIFE_HAPPENED_PASSES_PER_MONTH = 2; // missed-week passes that cost nothing

  /* ------------------------------------------------------------------ *
   * 3. SUPABASE — stores onboarding answers + lead status
   *
   *    Public anon key only (never the service role key in client code).
   *    Protected by the RLS policy in supabase/moms_leads.sql — anon can
   *    insert and can update only the row matching the local_id it
   *    already holds; nothing is readable with this key.
   *    Fill these in from Project Settings > API in your Supabase dashboard.
   * ------------------------------------------------------------------ */
  var SUPABASE_URL = "REPLACE_ME_SUPABASE_URL";
  var SUPABASE_ANON_KEY = "REPLACE_ME_SUPABASE_ANON_KEY";
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
   * 5. COPY — by motivation style. "princess" is the default tone;
   *    every onboarding/checkout string below should pull from here
   *    rather than being hardcoded in the page.
   * ------------------------------------------------------------------ */
  var TONE = {
    princess: {
      name: "Princess treatment",
      welcomeTitle: "You've just done something huge.",
      welcomeBody: "Let's get you moving at your own pace — gently, and on your terms. This takes about 3 minutes.",
      continue: "Continue",
      encourageGoal: "Here's a gentle starting goal — you can always adjust it.",
      prepareModeNote: "No pressure, no numbers yet. You're welcome here exactly as you are right now.",
      checkoutIntro: "Here's your plan. Take a breath — you've got this."
    },
    coach: {
      name: "Tough coach",
      welcomeTitle: "You showed up. That's step one.",
      welcomeBody: "No excuses from here — just a plan you can actually stick to. Takes about 3 minutes.",
      continue: "Next",
      encourageGoal: "Here's your starting number. Adjust it if you need to, but commit to it.",
      prepareModeNote: "No goal yet — get cleared first. Then we go to work.",
      checkoutIntro: "Here's the deal. Lock it in."
    }
  };

  var COPY = {
    metaTitle: "Walka for new mums — a gentler way to get moving",
    metaDescription: "A walking plan and accountability cohort built for pregnancy and postpartum — at your pace, with grace built in.",

    gate: {
      title: "This page isn't open yet.",
      body: "You've reached a page we're still testing. Check back soon, or head back to the Walka homepage.",
      cta: "Back to getwalka.com"
    },

    nav: { back: "← Save & exit" },

    resumeBanner: "Welcome back — picking up where you left off.",

    disclaimer: "Walka is not medical advice. Always follow your doctor's or midwife's guidance about when and how to exercise.",

    steps: {
      welcome: {
        eyebrow: "For pregnancy & postpartum",
        cta: "Let's begin"
      },
      stage: {
        title: "Where are you right now?",
        options: [
          { value: "pregnant", label: "Pregnant" },
          { value: "postpartum", label: "Postpartum" }
        ],
        dueDateLabel: "When's your due date? (optional)",
        weeksLabel: "How many weeks postpartum are you? (optional)",
        deliveryLabel: "Delivery type",
        deliveryOptions: [
          { value: "vaginal", label: "Vaginal" },
          { value: "csection", label: "C-section" },
          { value: "prefer_not_to_say", label: "Prefer not to say" }
        ]
      },
      clearance: {
        title: "Has your doctor or midwife cleared you for exercise?",
        options: [
          { value: "yes", label: "Yes, I'm cleared" },
          { value: "not_yet", label: "Not yet" },
          { value: "not_sure", label: "Not sure" }
        ],
        notClearedNote: "Totally fine — you can still join now in “prepare mode.” You'll meet your cohort and get ready, and we won't set any step goals until you're cleared. We'll never push you to exercise before then.",
        medicalReminder: "Walka is not medical advice — please check with your doctor or midwife before starting any new activity."
      },
      baseline: {
        title: "Let's get a feel for where you're starting.",
        stepsLabel: "Roughly how many steps do you walk on a typical day right now?",
        stepsOptions: [
          { value: "under_2k", label: "Under 2,000" },
          { value: "2k_5k", label: "2,000–5,000" },
          { value: "5k_8k", label: "5,000–8,000" },
          { value: "8k_plus", label: "8,000+" },
          { value: "not_sure", label: "Not sure" }
        ],
        energyLabel: "How's your energy most days lately?",
        energyOptions: [
          { value: "low", label: "Low — running on fumes" },
          { value: "medium", label: "Okay — some good hours" },
          { value: "high", label: "Pretty good" }
        ],
        barriersLabel: "What tends to get in the way? (pick any that fit)",
        barriersOptions: [
          { value: "baby_sleep", label: "Baby's sleep schedule" },
          { value: "time", label: "Finding the time" },
          { value: "tiredness", label: "Tiredness" },
          { value: "motivation", label: "Motivation" },
          { value: "pain", label: "Pain or discomfort" },
          { value: "other", label: "Something else" }
        ]
      },
      goal: {
        title: "Your starting goal",
        adjustHint: "Drag it up or down — there's no wrong answer.",
        dailyLabel: "Daily steps",
        weeklyFrame: "We'll count it a win on any day you hit this — aim for 5 good days a week, not 7.",
        prepareModeTitle: "No step goal yet — and that's the plan.",
      },
      motivation: {
        title: "What kind of voice helps you most?",
        options: [
          { value: "princess", label: "Princess treatment", desc: "Gentle, warm, encouraging" },
          { value: "coach", label: "Tough coach", desc: "Direct, strict, no excuses" }
        ]
      },
      cohort: {
        title: "Pick your people",
        soloOption: { value: "solo", label: "Just me, solo" },
        partnerLabel: "I'd like a walking partner matched to me",
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
        title: "Choose how you want to commit",
        rulesTitle: "How this works, in plain language:",
        graceRule: "First {grace} weeks: nothing is ever at risk, no matter what.",
        passesRule: "After that: you get {passes} “life happened” passes a month. Use one and a missed week costs you nothing.",
        hitRule: "Hit your plan: you get the full amount back.",
        stakeMissRule: "Miss a week with no pass left (buy-in option): that week's portion is forfeited — the rest keeps going.",
        pledgeMissRule: "Pledge option: you get it back regardless. It's a commitment signal, not a stake."
      },
      checkout: {
        title: "Review & confirm",
        nameLabel: "First name",
        emailLabel: "Email",
        emailHint: "We'll send your plan and cohort details here.",
        summaryGoalLabel: "Daily goal",
        summaryCohortLabel: "Cohort",
        summaryToneLabel: "Style",
        summaryAmountLabel: "Amount",
        summaryGraceLabel: "Grace period",
        summaryPassesLabel: "Passes",
        agreeLabel: "I agree to the Terms of Service and Privacy Policy",
        payCta: "Confirm — pay with card",
        testModeNote: "Test mode — use card 4242 4242 4242 4242, any future date, any CVC. No real money moves.",
        legalLinks: { terms: "/terms", privacy: "/privacy" }
      }
    },

    success: {
      title: "You're in.",
      body: "Welcome to your cohort. We'll email your plan and next steps shortly — including how to connect step tracking and say hello to your group.",
      note: "Keep an eye on your inbox — that's where the details are headed next."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susanadelokiki@gmail.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 6. ANALYTICS EVENT NAMES — keep these in sync with anything you
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
    COMMITMENT_OPTIONS: COMMITMENT_OPTIONS,
    GRACE_PERIOD_WEEKS: GRACE_PERIOD_WEEKS,
    LIFE_HAPPENED_PASSES_PER_MONTH: LIFE_HAPPENED_PASSES_PER_MONTH,
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
