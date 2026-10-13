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
   * 2. PAYMENTS: Stripe, recurring membership
   *
   *    This repo has no payment backend, so checkout uses one Stripe
   *    Payment Link (hosted by Stripe; we never touch card data) for a
   *    RECURRING price, PLAN_PRICE_CENTS / BILLING_INTERVAL below.
   *    Create it in the Stripe dashboard:
   *      Products > + Add product > recurring price > Create payment link
   *    Then under the link's settings, set "After payment" to redirect
   *    to your own URL:
   *      https://getwalka.com/moms-success
   *    (Stripe Payment Links don't support a separate "cancel" redirect;
   *    if someone abandons, they just use the browser back button.)
   *
   *    TODO before going live with the new $39.99/mo price: the two URLs
   *    in MEMBERSHIP_PAYMENT_LINK below still point at the OLD one-time
   *    $49.99 (stake + entry fee) price from the retired cohort model.
   *    Create new recurring-price Payment Links in the Stripe dashboard
   *    (test and live) and swap these two URLs before rollout — this is a
   *    manual dashboard step, nothing in this codebase can do it for you.
   *
   *    TEST -> LIVE is a single change: swap STRIPE_MODE to "live" once
   *    the live-mode recurring Payment Link exists.
   * ------------------------------------------------------------------ */
  /* "test" until the TODO above is done: MEMBERSHIP_PAYMENT_LINK.live still
     points at the OLD one-time $49.99 product. Leaving this on "live"
     would send anyone who reaches checkout (including via ?preview=1,
     which isn't a secret) to a real charge for the wrong price under new
     $39.99/month copy. Flip to "live" only after creating the recurring
     Payment Links and swapping both URLs above. */
  var STRIPE_MODE = "test"; // "test" | "live"

  var PLAN_PRICE_CENTS = 3999; // $39.99/month
  var BILLING_INTERVAL = "month";

  var MEMBERSHIP_PAYMENT_LINK = {
    test: "https://buy.stripe.com/test_4gM3cw7Qa5offD74NHdwc00", // TODO: replace with a recurring-price link
    live: "https://buy.stripe.com/4gM3cw7Qa5offD74NHdwc00"        // TODO: replace with a recurring-price link
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
        dueDateLabel: "Due date (optional)",
        weeksLabel: "Weeks postpartum, if you know it (optional)"
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
          "Share under your name, or post anonymously to the group when you'd rather not. Either way, only our moderators can ever see who's behind a post."
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

      /* Screen 10, personalized results. The intro sentence and the three
         benefit cards are computed from RESULTS_COPY by resultsIntroSentence()/
         resultsCards() in moms-app.js, not static strings here. */
      results: {
        eyebrow: "Made for you",
        title: "A little space for you.",
        note: "This isn't a promise about results, just where we'd start with you."
      },

      /* Screen 11, trust / community preview */
      trustPreview: {
        eyebrow: "A peek inside",
        title: "What it actually feels like in here.",
        intro: "A few examples of what members share, since words are easier than a feature list.",
        illustrativeBadge: "Illustrative preview, not an actual member post",
        posts: [
          { author: "A member, 3 weeks postpartum", text: "Some days I walk for ten minutes and call it a win. This group actually gets that." },
          { author: "A member, 34 weeks pregnant", text: "Posted anonymously about feeling touched out today. Had three replies before dinner." },
          { author: "A member, 5 months postpartum", text: "Our little circle checks in most mornings. Some days that's the whole walk." }
        ]
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
   * 5. PERSONALIZATION: copy for the `results` step's three fixed benefit
   *    cards, its intro sentence, and the optional secondary diary
   *    mention, resolved deterministically against the member's actual
   *    answers by resultsCircleCard()/resultsCommunityCard()/
   *    resultsRoutineCard()/resultsDiaryCard()/resultsIntroSentence() in
   *    moms-app.js. Plain lookups and if/else, no scoring, no inference
   *    beyond "this answer maps to this line" — reused as-is on
   *    `checkout`'s "what's included" list so both screens agree.
   * ------------------------------------------------------------------ */
  var RESULTS_COPY = {
    introDefault: "Here's what we've put together, based on what you shared.",
    /* First match wins; order here IS the priority. */
    introWantPriority: ["other_moms", "reason_outside", "routine", "time_my_own", "encouragement", "energy"],
    introByWant: {
      other_moms: "Since you're hoping for other moms who understand, here's what we've put together around that.",
      reason_outside: "Since you're looking for a reason to get outside, here's what we've put together around that.",
      routine: "Since you're looking for a routine you can stick to, here's what we've put together around that.",
      time_my_own: "Since you're looking for a little time that's yours, here's what we've put together around that.",
      encouragement: "Since a little encouragement goes a long way, here's what we've put together around that.",
      energy: "Since you're looking for more energy day to day, here's what we've put together around that."
    },

    circle: {
      title: "Your walking circle", icon: "🫂",
      /* Explains a potential future match by stage. Never phrase these as
         an already-confirmed assignment (e.g. "you're walking with X") —
         matching hasn't happened yet when this screen renders. */
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

    community: {
      title: "Your community experience", icon: "💬",
      wantsOtherMoms: "You told us you'd love more moms who understand. Our community is built for exactly that, share as much or as little as feels right.",
      disconnected: "There's room to feel more connected here, at whatever pace works for you.",
      fallback: "A moderated space for honest conversations, whenever you want to take part.",
      preferReadNote: "You can take part at your own pace, reading along counts too."
    },

    routine: {
      title: "Your gentle walking routine", icon: "🚶‍♀️",
      /* Every line here is already goal-free by design (no step counts or
         numeric targets), so "don't assign exercise targets to recovering/
         uncertain/restricted members" holds for every branch, not just
         not_ready. */
      byPreference: {
        not_ready: "No pressure to set a goal yet. We'll check back in when you're ready, there's no clock on this.",
        short_walks: "Short walks when you can grab them, nothing more structured than that.",
        time_outside: "Time outside most days, however that looks for you, no fixed distance or pace.",
        flexible_goal: "A flexible weekly goal that moves with your week, not a fixed daily number.",
        gentle_challenges: "Gentle, shared challenges you can opt into when they fit, never mandatory."
      },
      fallback: "A walking routine that adjusts to your day, never a fixed step count.",
      outsideNote: "You mentioned wanting more reason to get outside, we'll keep opportunities like that coming."
    },

    /* Optional secondary feature: shown only when a specific answer
       actually points to it, never as a default filler card. */
    diary: {
      title: "A private mood diary",
      body: "A quiet place just for you to note how you're really feeling. Visible only to you."
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
