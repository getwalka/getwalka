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
  var STRIPE_MODE = "test"; // "test" | "live"

  var PLAN_PRICE_CENTS = 3999; // $39.99, same numeral in both currencies
  var BILLING_INTERVAL = "month";

  var MEMBERSHIP_PAYMENT_LINK = {
    test: {
      usd: "https://buy.stripe.com/test_3cIaEY8UeeYP2Qlcg9dwc02",
      cad: "https://buy.stripe.com/test_eVqbJ2fiCdUL8aFcg9dwc04"
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
        ],
        dueDateLabel: "Due date (optional)"
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

      /* Screen 10, personalized results. Title/subtext/hero/preview content
         all comes from RESULTS_COPY via moms-app.js's results* functions,
         not static strings here. */
      results: {
        eyebrow: "Made for you"
      },

      /* Screen 11, trust / community preview. Renders as a mocked circle
         screen (header + chat + challenge card + participation row) via
         renderCirclePreview() in moms-app.js, not a list of quote cards.
         No member counts, response-time/engagement numbers, or real named
         people anywhere in this data — illustrative only. */
      trustPreview: {
        eyebrow: "A peek inside",
        title: "What it actually feels like in here.",
        intro: "Here's a peek at what a circle actually looks like.",
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
      body: "Your Walka Mom membership is active. Open the Walka app to see your plan and your people.",
      note: "A confirmation email is on its way, with a link to manage your membership anytime."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susanadelokiki@gmail.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 5. PERSONALIZATION: copy for the `results` step — a headline subtext,
   *    a walking-circle hero, a community preview, a routine preview, and
   *    an optional secondary diary mention — resolved deterministically
   *    against the member's actual answers by resultsHeadlineSubtext()/
   *    resultsCircleCard()/resultsRoutineCard()/resultsDiaryCard() in
   *    moms-app.js. Plain lookups and if/else, no
   *    scoring, no inference beyond "this answer maps to this line" —
   *    card titles are reused as-is on `checkout`'s "what's included"
   *    list so both screens agree.
   * ------------------------------------------------------------------ */
  var RESULTS_COPY = {
    title: "You don't have to figure this out alone.",

    subtextDefault: "Here's a preview of what your Walka experience could look like.",
    /* First match wins; order here IS the priority. Each entry names which
       answer field it reads, since motivation_wants and barriers are two
       separate fields a reader shouldn't have to infer from the value
       alone. */
    subtextPriority: [
      { field: "motivation_wants", value: "other_moms" },
      { field: "barriers", value: "exhaustion" },
      { field: "motivation_wants", value: "routine" },
      { field: "motivation_wants", value: "reason_outside" },
      { field: "barriers", value: "limited_support" },
      { field: "barriers", value: "unpredictable_routine" },
      { field: "motivation_wants", value: "time_my_own" },
      { field: "motivation_wants", value: "encouragement" },
      { field: "motivation_wants", value: "energy" },
      { field: "barriers", value: "motivation" },
      { field: "barriers", value: "recovering_physically" },
      { field: "barriers", value: "doing_okay" }
    ],
    subtextByKey: {
      "motivation_wants:other_moms": "You told us you'd love to meet moms who understand this season. Here's what your Walka experience could look like.",
      "barriers:exhaustion": "You've got a lot on your plate. Your Walka experience is designed to make room for real life.",
      "motivation_wants:routine": "You're looking for a little consistency. We'll help you find a rhythm that works for your life.",
      "motivation_wants:reason_outside": "You're looking for a reason to get outside. Here's what your Walka experience could look like.",
      "barriers:limited_support": "You've been doing a lot without much backup. This is a place to find some.",
      "barriers:unpredictable_routine": "Your days don't always go as planned. Your Walka experience is built to flex with that.",
      "motivation_wants:time_my_own": "You're looking for a little time that's yours. Here's what your Walka experience could look like.",
      "motivation_wants:encouragement": "A little encouragement goes a long way. Here's what your Walka experience could look like.",
      "motivation_wants:energy": "You're looking for more energy day to day. Here's what your Walka experience could look like.",
      "barriers:motivation": "Some days the hardest part is just starting. Your Walka experience is designed to help with that.",
      "barriers:recovering_physically": "You're recovering or adjusting physically right now. Your Walka experience is designed to meet you there, gently.",
      "barriers:doing_okay": "You're doing okay and just want a routine. Here's what your Walka experience could look like."
    },

    circle: {
      title: "Your walking circle",
      explainer: "A small circle to walk, check in, and share the everyday moments with.",
      genericChip: "Moms at a similar stage",
      /* "Finding your circle: {label}", never a confirmed assignment —
         matching hasn't happened yet when this screen renders. */
      chipPrefix: "Finding your circle: ",
      /* Longer-form line kept for checkout's "what's included" list, which
         just needs a sentence, not the hero's chip+explainer pair. */
      byStage: {
        pregnant: "You're currently pregnant, so when you're ready, we'll look to match you with others due around the same time.",
        postpartum_0_3: "You're in the early postpartum weeks, so we'll look to match you with others in a similar season.",
        postpartum_3_6: "Based on where you are postpartum, we'll look to match you with others a few months in, too.",
        postpartum_6_12: "Based on where you are postpartum, we'll look to match you with others further along in recovery.",
        postpartum_12_plus: "However long it's been, we'll look to match you with others further out from birth too."
      },
      fallback: "We'll look to match you with a small circle of moms as you get started.",
      recoveringNote: "No pressure to keep pace with anyone, this is about company, not competition."
    },

    communityPreview: {
      title: "Honest conversations",
      illustrativeBadge: "Illustrative example, not actual member posts",
      messages: [
        { name: "Ava", text: "Anyone else counting getting outside today as a win?" },
        { name: "Nora", text: "Absolutely. We made it around the block and I'm celebrating." },
        { name: "Ava", text: "Some days that's more than enough." }
      ]
    },

    routine: {
      title: "Your pace, your way",
      /* Every bullet set here is already goal-free by design (no step
         counts or numeric targets), so "don't assign exercise targets to
         recovering/uncertain/restricted members" holds for every branch,
         not just not_ready. */
      byPreference: {
        not_ready: ["No pressure to set a goal yet", "We'll check back in when you're ready", "Rest days are always welcome"],
        short_walks: ["Short walks when you can grab them", "Nothing more structured than that", "Rest days are welcome"],
        time_outside: ["Time outside most days, however that looks", "No fixed distance or pace", "Rest days are welcome"],
        flexible_goal: ["A flexible weekly goal, not a daily number", "Moves with your week", "Rest days are welcome"],
        gentle_challenges: ["Gentle, shared challenges you can opt into", "Never mandatory", "Rest days are welcome"]
      },
      fallback: ["Short walks when you can", "Flexible weekly goals", "Rest days are welcome"],
      outsideNote: "Extra encouragement to get outside, since that's what you're looking for"
    },

    /* Optional secondary feature: shown only when a specific answer
       actually points to it, never as a default filler card. */
    diary: {
      title: "A little space just for you",
      body: "Keep a private note of how you're feeling, whenever you want."
    },

    continueLabel: "See your community"
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
