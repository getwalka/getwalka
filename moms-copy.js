/* ==========================================================================
   Walka Mom: onboarding flow, COPY + CONFIG
   Everything editable about this experiment lives in this one file:
   wording, personalization data, feature flag name, and third-party
   keys/links. No other file should need to change to tune the experiment.
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
   *
   *    IMPORTANT before flipping this to false: confirm the PostHog flag
   *    below actually exists and has an intended rollout % configured.
   *    initGate() fails CLOSED (shows the gate screen to everyone) if
   *    PostHog has no flag state, so flipping this off with an
   *    unconfigured flag takes the page offline for all visitors.
   * ------------------------------------------------------------------ */
  var FEATURE_FLAG_KEY = "moms-postpartum-flow";
  var PREVIEW_STORAGE_KEY = "walka_moms_preview";
  var FORCE_FLOW_ENABLED = false;
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
   * 2. PAYMENTS: Stripe, recurring membership, priced per currency
   *
   *    This repo has no payment backend, so checkout uses a Stripe
   *    Payment Link (hosted by Stripe; we never touch card data) per
   *    RECURRING price. Same numeral, two currencies: $39.99 USD for US
   *    visitors, $39.99 CAD for Canadian visitors (not a currency
   *    conversion of one price into the other — two separate Stripe
   *    Prices, each literally 3999 minor units in its own currency).
   *    getwalka only ever serves US/CA (see GEO_ALLOWED_COUNTRIES below),
   *    so those are the only two currencies this needs.
   *
   *    For EACH currency, in the Stripe dashboard:
   *      Products > (existing "Walka Mom Membership" product, or create
   *      it) > + Add another price > Recurring, Monthly, pick the
   *      currency, 39.99 > Create payment link
   *    On each link's settings, set "After payment" to redirect to:
   *      https://getwalka.com/moms-success
   *    (Stripe Payment Links don't support a separate "cancel" redirect;
   *    if someone abandons, they just use the browser back button.)
   *    That's 4 links total: {test,live} x {usd,cad}.
   *
   *    All 4 recurring Payment Links below now exist (filled in 2026-10).
   *    TEST -> LIVE is a single change: swap STRIPE_MODE to "live" once
   *    the test links have been clicked through end to end (preview=1,
   *    Stripe's 4242 4242 4242 4242 test card, confirm the redirect to
   *    /moms-success and that link-moms-subscriber reconciles correctly).
   * ------------------------------------------------------------------ */
  /* "test" until that end-to-end check above has actually been done.
     Flipping to "live" before then risks sending a real visitor through
     an unverified checkout path. */
  var STRIPE_MODE = "live"; // "test" | "live"

  var PLAN_PRICE_CENTS = 3999; // $39.99, same numeral in both currencies
  var BILLING_INTERVAL = "month";

  var MEMBERSHIP_PAYMENT_LINK = {
    test: {
      usd: "https://buy.stripe.com/test_dRmbJ25I2aIz0Iddkddwc05",
      cad: "https://buy.stripe.com/test_5kQeVefiC17Z9eJ5RLdwc06"
    },
    live: {
      usd: "https://buy.stripe.com/3cIaEY8UeeYP2Qlcg9dwc02",
      cad: "https://buy.stripe.com/eVqbJ2fiCdUL8aFcg9dwc04"
    }
  };

  /* No-code cancellation, per the README's documented plan: Settings >
     Billing > Customer portal > the shareable link option (asks the
     member to verify their email, no login system needed on our side).
     Empty until that's enabled in the Stripe dashboard and the link is
     pasted in here — moms-success.html only shows the "manage membership"
     link when this is non-empty, so there's never a dead link on the page. */
  var CUSTOMER_PORTAL_URL = "";

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
   * 4. COPY. One consistent warm voice throughout (no tone picker) —
   *    every onboarding/checkout string lives here, not hardcoded in
   *    the page. Keep it warm, plainspoken, and short: no guilt, no
   *    pressure, no weight-loss or "bounce back" language, no promises
   *    of health outcomes.
   * ------------------------------------------------------------------ */
  var COPY = {
    metaTitle: "Walka Mom",
    metaDescription: "A gentle walking plan, a private community, and support made for pregnancy and postpartum, at your pace.",

    continueLabel: "Continue",
    skipLabel: "Skip for now",

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

    disclaimer: "Not medical advice, and this isn't a medical clearance. Always follow your doctor's or midwife's guidance.",

    privacyNote: "Anything you share here is private to your Walka Mom account. You can skip any question you'd rather not answer.",

    landing: {
      eyebrow: "For pregnancy & postpartum",
      title: "Find your rhythm again, one walk at a time.",
      tagline: "Gentle walking challenges, honest conversations, and a private community of moms who understand what you're going through.",
      cta: "Let's begin",
      heroPhoto: "images/feature-pace.jpg",

      howEyebrow: "How it works",
      howTitle: "Three steps, at your pace.",
      howSteps: [
        {
          icon: "💬",
          photo: "images/feature-coach.jpg",
          title: "Tell us about you",
          desc: "A few honest questions about this season, no judgment and nothing you have to answer."
        },
        {
          icon: "🫂",
          photo: "images/feature-circle.jpg",
          title: "Find your people",
          desc: "Small walking circles and a private community of moms who get it."
        },
        {
          icon: "🚶‍♀️",
          photo: "images/feature-pace.jpg",
          title: "Walk together, at your pace",
          desc: "Gentle, flexible challenges shaped around your day, not a fixed step count."
        }
      ],

      cohortEyebrow: "You don't have to do this alone",
      cohortTitle: "Walk with people who get it.",
      cohortBody: "Grouped by stage, so you're never the only one.",
      cohortGroups: [
        { caption: "Due soon" },
        { caption: "0–3 months postpartum" },
        { caption: "3–6 months postpartum" },
        { caption: "6–12 months postpartum" },
        { caption: "1+ year postpartum" }
      ]
    },

    /* Reference data for resolvedCohortFor()'s return codes in
       moms-app.js. Not its own screen (the old "cohort" step was
       retired), and not rendered anywhere as a confirmed assignment —
       see RESULTS_COPY.circle below for how the `results` step talks
       about matching (potential, not yet confirmed). */
    cohort: {
      groupsPregnant: [
        { value: "due_soon", label: "Due soon" }
      ],
      groupsPostpartum: [
        { value: "0_3m", label: "0–3 months postpartum" },
        { value: "3_6m", label: "3–6 months postpartum" },
        { value: "6_12m", label: "6–12 months postpartum" },
        { value: "12m_plus", label: "1+ year postpartum" }
      ]
    },

    steps: {
      /* Screen 1 */
      stage: {
        title: "Where are you in your motherhood journey?",
        options: [
          { value: "pregnant", label: "Currently pregnant" },
          { value: "postpartum_0_3", label: "0–3 months postpartum" },
          { value: "postpartum_3_6", label: "3–6 months postpartum" },
          { value: "postpartum_6_12", label: "6–12 months postpartum" },
          { value: "postpartum_12_plus", label: "More than a year postpartum" }
        ]
      },

      /* Screen 2, multi-select, skippable */
      motivation: {
        title: "What would you love a little more of in this season?",
        hint: "Pick as many as you'd like.",
        optional: true,
        options: [
          { value: "time_my_own", label: "Time that feels like my own" },
          { value: "energy", label: "More energy for everyday life" },
          { value: "reason_outside", label: "A reason to get outside" },
          { value: "other_moms", label: "Other moms who understand" },
          { value: "routine", label: "A routine I can stick to" },
          { value: "encouragement", label: "A little encouragement" }
        ]
      },

      /* Screen 3, multi-select, skippable */
      barriers: {
        title: "What's making it difficult to find time for yourself lately?",
        hint: "Pick as many as apply.",
        optional: true,
        exclusiveValues: ["prefer_not_to_say"],
        options: [
          { value: "exhaustion", label: "Exhaustion" },
          { value: "unpredictable_routine", label: "Unpredictable routine" },
          { value: "limited_support", label: "Limited support" },
          { value: "motivation", label: "Motivation" },
          { value: "recovering_physically", label: "Recovering or adjusting physically" },
          { value: "doing_okay", label: "I'm doing okay, just want a routine" },
          { value: "prefer_not_to_say", label: "Prefer not to say" }
        ]
      },

      /* Screen 4, interlude */
      interludeCare: {
        eyebrow: "A little reassurance",
        title: "You deserve care, too.",
        body: [
          "Some days, a walk feels wonderful. Other days, rest is exactly what you need.",
          "Your routine should have room for both."
        ]
      },

      /* Screen 5, skippable */
      connection: {
        title: "How connected do you feel to other moms right now?",
        optional: true,
        options: [
          { value: "strong_circle", label: "Strong circle" },
          { value: "few_not_close", label: "A few, but not close" },
          { value: "want_more", label: "Want to meet more" },
          { value: "sometimes_alone", label: "Sometimes feel alone" },
          { value: "mainly_walking", label: "Mainly here for walking" }
        ]
      },

      /* Screen 6, skippable */
      conversations: {
        title: "Are there things about motherhood you wish you could talk about more openly?",
        optional: true,
        options: [
          { value: "yes_always", label: "Yes, all the time" },
          { value: "sometimes", label: "Sometimes" },
          { value: "not_really", label: "Not really" },
          { value: "prefer_read", label: "I'd rather read what others share" }
        ]
      },

      /* Screen 7, interlude */
      interludeCommunity: {
        eyebrow: "A quieter kind of community",
        title: "Some conversations are easier when you can just be yourself.",
        body: [
          "Our community is private to members and moderated throughout.",
          "Share under your name, or post anonymously to the group when you'd rather not."
        ]
      },

      /* Screen 8 */
      baseline: {
        title: "What does walking look like for you these days?",
        options: [
          { value: "walks_regularly", label: "I walk regularly" },
          { value: "gets_out_when_can", label: "I get out when I can" },
          { value: "no_routine_yet", label: "No routine yet" },
          { value: "recovery_break", label: "Taking a recovery break" },
          { value: "unsure_comfortable", label: "Unsure what's comfortable" }
        ]
      },

      /* Screen 9, two parts: optional safety question, then routine preference */
      clearance: {
        title: "Has a clinician given you any guidance about activity right now?",
        options: [
          { value: "yes", label: "No restrictions" },
          { value: "not_yet", label: "Some restrictions" },
          { value: "not_sure", label: "Not sure" },
          { value: "prefer_not_to_say", label: "Prefer not to say" }
        ],
        notClearedNote: "Good to know. We'll keep things gentle and skip any fixed goals for now.",
        medicalReminder: "This isn't medical advice or a medical clearance. Always follow your doctor's or midwife's guidance.",
        routineTitle: "What would a good walking routine feel like for you?",
        routineOptions: [
          { value: "short_walks", label: "Short walks when possible" },
          { value: "time_outside", label: "Time outside most days" },
          { value: "flexible_goal", label: "A flexible weekly goal" },
          { value: "gentle_challenges", label: "Gentle shared challenges" },
          { value: "not_ready", label: "Not ready to set a goal" }
        ]
      },

      /* Screen 10: brief timed transition before results, no question —
         see PREPARING_DELAY_MS in moms-app.js for how long it shows. */
      preparing: {
        title: "Preparing your circle",
        body: "We're using what you shared to find your people and your pace."
      },

      /* Screen 11, personalized results. Title/subtext/hero/preview content
         all comes from RESULTS_COPY via moms-app.js's results* functions,
         not static strings here. */
      results: {
        eyebrow: "Made for you"
      },

      /* Landing-page-only now: the funnel step this originally rendered
         was merged into `results` (see RESULTS_COPY.circle below), but
         the landing page's compact community section still reads this
         via renderCirclePreview() in moms-app.js. No member counts,
         response-time/engagement numbers, or real named people anywhere
         in this data — illustrative only. */
      trustPreview: {
        illustrativeBadge: "Illustrative community preview",
        circleName: "Early Days Circle",
        messages: [
          { name: "Jess", time: "this morning", text: "Only made it around the block today but I went. Ten minutes still counts." },
          { name: "Maya", time: "this morning", text: "Needed to hear that. Rough night here too." },
          { name: "Priya", time: "yesterday", text: "Posting this one anonymously, just a tired day. Glad this space is here." }
        ],
        challenge: {
          icon: "🚶‍♀️", title: "This week's gentle challenge",
          body: "A short walk most days, however that looks for you. No fixed step count, no leaderboard."
        },
        participation: ["Post", "Reply", "Just read, that counts too"]
      },

      /* Screen 12 */
      checkout: {
        title: "Your membership",
        intro: "Here's what you're joining.",
        includedLabel: "What's included",
        nameLabel: "First name",
        emailLabel: "Email",
        billingNote: "Billed monthly. Cancel anytime, a link to manage or cancel your membership is in your confirmation email.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        payCta: "Start my membership",
        testModeNote: "Test mode: card 4242 4242 4242 4242, any date, any CVC.",
        legalLinks: { terms: "/terms", privacy: "/privacy" }
      }
    },

    success: {
      title: "You're in.",
      subtitle: "Welcome to the founding circle of Walka Mom. We're so glad you're here.",
      circleLabel: "Your circle begins",
      circleDate: "November 2, 2026",
      circleNote: "Everything you need to get started will be ready for you before your circle opens.",
      nextTitle: "What happens next",
      nextSteps: [
        { title: "Check your inbox", body: "Watch for a receipt from Stripe confirming today's payment." },
        { title: "We'll get your circle ready", body: "We're bringing together moms who are in this same season of life." },
        { title: "Start together on November 2", body: "That's when your walking circle and the Walka app open up to you." }
      ],
      cancelFallback: "To manage or cancel anytime, email susan@getwalka.com."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susan@getwalka.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 5. RESULTS: copy for the `results` step's two equally-weighted
   *    cards — walking challenges and community — so the screen doesn't
   *    read as just a chat group (the old separate trustPreview step was
   *    folded into the community card here). The personalized pieces are
   *    the sentence under the headline (resultsPersonalizedSentence() in
   *    moms-app.js, built from `personalization.clauses` below), the
   *    circle chip (member's actual stage), and whether the challenge
   *    card shows a numeric goal at all (see isRecovering()).
   *    `communityPreview`/`routine.title`/`diary` stay around only
   *    because checkout's "what's included" recap list (resultsCards())
   *    still wants three distinct titles.
   * ------------------------------------------------------------------ */
  var RESULTS_COPY = {
    title: "Here's what we've created for you.",

    /* Builds "You told us you'd love to {a}, while {bIng}." from up to
       two of the member's actual answers, in priority order below
       (motivation_wants first, since those already read as "I'd love
       X"; barriers second, each reframed as the want implied by that
       obstacle, so the sentence shape stays consistent either way).
       0 matches -> `default`. 1 match -> `oneClause`. Every clause is
       traceable to one specific answer value, no scoring/inference. */
    personalization: {
      default: "Here's a preview of what your Walka Mom experience could look like.",
      oneClause: "You told us you'd love to {a}.",
      twoClause: "You told us you'd love to {a}, while {bIng}.",
      clauses: [
        { field: "motivation_wants", value: "other_moms", base: "meet other moms who understand this season", ing: "meeting other moms who understand this season" },
        { field: "motivation_wants", value: "routine", base: "find a routine that actually sticks", ing: "finding a routine that actually sticks" },
        { field: "motivation_wants", value: "reason_outside", base: "have a reason to get outside", ing: "having a reason to get outside" },
        { field: "motivation_wants", value: "time_my_own", base: "find a little more time for yourself", ing: "finding a little more time for yourself" },
        { field: "motivation_wants", value: "encouragement", base: "feel a little more encouraged along the way", ing: "feeling a little more encouraged along the way" },
        { field: "motivation_wants", value: "energy", base: "find a bit more energy for your day", ing: "finding a bit more energy for your day" },
        { field: "barriers", value: "exhaustion", base: "have a little more ease in your days", ing: "having a little more ease in your days" },
        { field: "barriers", value: "limited_support", base: "feel a bit more backed up", ing: "feeling a bit more backed up" },
        { field: "barriers", value: "unpredictable_routine", base: "find some steadiness in days that don't always go as planned", ing: "finding some steadiness in days that don't always go as planned" },
        { field: "barriers", value: "recovering_physically", base: "move at a pace that respects where you're at physically", ing: "moving at a pace that respects where you're at physically" },
        { field: "barriers", value: "motivation", base: "feel that first step get a little easier", ing: "feeling that first step get a little easier" },
        { field: "barriers", value: "doing_okay", base: "settle into a simple, steady routine", ing: "settling into a simple, steady routine" }
      ]
    },

    /* Walking-challenge preview card. The real app tracks steps, not
       minutes (see modal_step_goal()/FALLBACK_STEP_GOAL in the main
       stepr repo) — 5,000 is that same fallback goal, not an invented
       number. `goal`/`progress` are illustrative example numbers, never
       shown when the member indicated restrictions or isn't ready for a
       goal yet (goalRecovering instead, see isRecovering()). */
    routine: {
      title: "Your gentle walking challenges",
      description: "Join flexible step challenges, track your progress, and build a routine that fits your own pace.",
      previewTag: "Example progress",
      goal: "5,000 steps on 3 days this week",
      goalRecovering: "No set goal until you're ready, just gentle movement at your pace.",
      progress: "2 of 3 walks completed",
      note: "Goals are adjustable, and rest days are always welcome."
    },

    circle: {
      title: "Your circle of moms",
      description: "You'll be invited into a community of moms at a similar stage, to connect, share experiences, and encourage each other.",
      genericChip: "Moms at a similar stage",
      /* "Finding your circle: {label}", never a confirmed assignment —
         matching hasn't happened yet when this screen renders. */
      chipPrefix: "Finding your circle: ",
      messages: [
        { name: "Jess", text: "Why does everyone say “sleep when the baby sleeps” like there's not a mountain of laundry staring at me? 😂" },
        { name: "Maya", text: "And somehow the baby only sleeps when I have 47 things to do." }
      ]
    },

    communityPreview: {
      title: "Honest conversations"
    },

    /* Optional secondary feature: shown only on checkout's recap list,
       when a specific answer actually points to it, never as a default
       filler card. */
    diary: {
      title: "A little space just for you",
      body: "Keep a private note of how you're feeling, whenever you want."
    },

    /* Only a real, confirmed date — never a placeholder. Matches the
       date on moms-success.html's COPY.success.circleDate. */
    foundingNote: "Your founding circle opens November 2, 2026. We'll email your app invitation before it begins."
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
    motivationAnswered: "moms_motivation_answered",
    cohortChosen: "moms_cohort_chosen",
    resultsViewed: "moms_results_viewed",
    checkoutViewed: "moms_checkout_viewed",
    checkoutStarted: "moms_checkout_started",
    checkoutCompleted: "moms_checkout_completed",
    checkoutFailed: "moms_checkout_failed",
    geoBlocked: "moms_geo_blocked"
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
    MEMBERSHIP_PAYMENT_LINK: MEMBERSHIP_PAYMENT_LINK,
    CUSTOMER_PORTAL_URL: CUSTOMER_PORTAL_URL,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    SUPABASE_TABLE: SUPABASE_TABLE,
    COPY: COPY,
    RESULTS_COPY: RESULTS_COPY,
    EVENTS: EVENTS
  };
})();
