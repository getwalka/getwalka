/* ==========================================================================
   Walka Mom (getwalka.com/moms): COPY + CONFIG
   Redesigned 2026-10-31: dropped the 13-screen onboarding quiz in favor of
   a single marketing-style landing page (hero, three feature blocks, how
   it works, final CTA) that goes straight into checkout -- the same
   landing+checkout shape the November-challenge funnel (couch6k-copy.js /
   couch6k-app.js) already moved to. Matching/personalization questions
   (motherhood stage, motivations, barriers, etc.) are gone from this page;
   "which stage are you" now happens in the app after signup, same as
   couch6k moved coach selection into the app post-purchase. Everything
   editable about this funnel lives in this one file.
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
   * 1b. GEO GATE: US/Canada (+GB/AU/NG, billed in USD) only
   *    middleware.js (Vercel Edge Middleware) stamps a walka_geo_country
   *    cookie from Vercel's own IP geolocation on every /moms request.
   *    moms-app.js reads that cookie and blocks checkout for anyone
   *    outside this list, showing COPY.geoGate instead of the page.
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
  var GEO_ALLOWED_COUNTRIES = ["US", "CA", "GB", "AU", "NG"];

  /* ------------------------------------------------------------------ *
   * 2. PAYMENTS: Stripe, ONE one-time charge, priced per currency
   *
   *    Moved off a recurring membership (2026-11-03): the 8-week program
   *    is now a single payment, no subscription, nothing to cancel or
   *    renew. Inline checkout (Stripe Elements) is the only path:
   *    create-moms-payment-intent returns a clientSecret, the Payment
   *    Element mounts right on the checkout screen, and
   *    stripe.confirmPayment charges the card without leaving
   *    getwalka.com. No Payment Link fallback exists (same as the
   *    November-challenge funnel) -- if Stripe.js fails to load, checkout
   *    shows an error rather than redirecting somewhere that could charge
   *    a different amount than what was just shown.
   *
   *    Same numeral, two currencies per tier: $X.XX USD for US visitors,
   *    $X.XX CAD for Canadian visitors (not a currency conversion of one
   *    price into the other). GB/AU/NG bill in USD too: checkoutCurrency()
   *    in moms-app.js only special-cases "CA".
   *
   *    TWO PRICE TIERS, flag-controlled. PRICE_FLAG_KEY is a PostHog
   *    boolean flag: ON shows/charges PRICE_TIERS.discount ($19.99), OFF
   *    or unresolved (flag fetch failed/timed out) falls back to
   *    PRICE_TIERS.default ($29.99) -- the higher price is the safe
   *    default so a flag outage never undercharges. moms-app.js resolves
   *    this once per session (resolvePriceTier()), persists the chosen
   *    cents onto state.answers.price_cents, and sends it to
   *    create-moms-payment-intent, which independently validates it
   *    against the two allowed values before charging -- the server never
   *    trusts an arbitrary client-sent amount as-is, only as a lookup key
   *    into a fixed allow-list. ?price=19 / ?price=29 on the URL overrides
   *    the flag for QA, same pattern as ?preview=1.
   *
   *    Unlike the retired subscription version, no Stripe Price objects
   *    need creating in the dashboard -- the amount goes straight into
   *    paymentIntents.create, same simplification create-couch6k-payment-
   *    intent already uses for its own fixed charge. The PostHog flag
   *    itself still needs to exist (key below) before this does anything
   *    but show the $29.99 default to everyone. */
  var STRIPE_MODE = "live"; // "test" | "live"

  var PRICE_FLAG_KEY = "moms-price-1999";
  var PRICE_TIERS = {
    default: 2999, // $29.99 -- shown/charged when the flag is off, unresolved, or PostHog can't be reached
    discount: 1999 // $19.99 -- shown/charged only when moms-price-1999 is explicitly on
  };

  /* Publishable keys are not secret, safe to ship in client code (unlike
     the Edge Function's STRIPE_SECRET_KEY). From the Stripe dashboard:
     Developers > API keys > Publishable key, once per mode. */
  var STRIPE_PUBLISHABLE_KEY = {
    test: "pk_test_51IAPwwKmW6iAmon9BvmoxKu3jXyKpZsKwOQ3uEoeZDk36hIzuECAUktrzreXANmhKa03DWf7GFhUPT8i54UZBWUV00oO4xYgwS",
    live: "pk_live_51IAPwwKmW6iAmon97vBggpfUblagf7SYYMOQ6mYGj0gWjCtZQ1nnst9oiSu9rka7jvlwnIPbca0RLScydPB8Scy4005VuT8ANc"
  };

  /* ------------------------------------------------------------------ *
   * 3. SUPABASE: stores leads + checkout status
   *
   *    Public anon key only (never the service role key in client code).
   *    Protected by the RLS policy in supabase/moms_leads.sql: anon can
   *    insert, and can read/update only the row matching the local_id it
   *    already holds.
   * ------------------------------------------------------------------ */
  var SUPABASE_URL = "https://mgocpqbxssvjlmqzqfgn.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nb2NwcWJ4c3N2amxtcXpxZmduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzNzQyMjQsImV4cCI6MjA3Nzk1MDIyNH0.CEgJvGEOJJe5slTp3EKvOqw1pOwJOWK2GTitoL1QODY";
  var SUPABASE_TABLE = "moms_leads";

  /* ------------------------------------------------------------------ *
   * 4. COPY. Warm, plainspoken, no em dashes (brand voice rule,
   *    CLAUDE.md). No guilt, no weight-loss language, no before/after
   *    talk -- this is a friend saying "you don't have to do this alone,"
   *    not a fitness pitch.
   * ------------------------------------------------------------------ */
  var COPY = {
    metaTitle: "Walka Mom",
    metaDescription: "A gentle walking community for new moms, matched with moms at the same stage as you.",

    gate: {
      title: "This page isn't open yet.",
      body: "Check back soon, or head back to the homepage.",
      cta: "Back to getwalka.com"
    },

    geoGate: {
      title: "Not available in your country yet.",
      body: "This program is currently only open to the US, Canada, the UK, Australia, and Nigeria. Check back as we expand to more places.",
      cta: "Back to getwalka.com"
    },

    nav: { back: "Save & exit" },
    resumeBanner: "Welcome back. Picking up where you left off.",

    disclaimer: "Not medical advice, and this isn't a medical clearance. Always follow your doctor's or midwife's guidance.",

    steps: {
      /* The homepage: one long landing page, no quiz. Each key below is
         one section, top to bottom. {price} is filled in by
         moms-app.js from WM's config constants above, so the copy can't
         go stale relative to what checkout actually charges. */
      home: {
        hero: {
          eyebrow: "FOR NEW MOMS",
          headline: "Walk. Breathe. You're not doing this alone.",
          headlineHighlight: "not doing this alone.",
          body: "A gentle walking community for new moms, matched with moms at the same stage as you.",
          subhead: "8 weeks of community, audio walks, and steps. {price} once, no subscription.",
          anonymityNote: "Share as yourself, or anonymously.",
          ctaLabel: "Find your village"
        },

        features: {
          eyebrow: "WHAT'S INSIDE",
          items: [
            {
              icon: "🗓️",
              title: "An 8-week plan",
              body: "Week by week, built for where you are. No guessing what's next."
            },
            {
              icon: "🎧",
              title: "A daily walk-along",
              body: "Press play. A voice walks with you."
            },
            {
              icon: "✅",
              title: "Daily check-ins",
              body: "Tell us how you feel. We set today's step goal."
            },
            {
              icon: "🔥",
              title: "Streaks",
              body: "Watch your streak build day by day. Rest days never break it."
            }
          ]
        },

        community: {
          eyebrow: "YOUR CIRCLE",
          headline: "Moms who get it, right when you need them.",
          body: "Matched with a small group of moms at your stage. Share under your name, or post anonymously when you'd rather not."
        },

        howItWorks: {
          eyebrow: "HOW IT WORKS",
          headline: "Three steps, at your pace.",
          items: [
            { label: "STEP 1", title: "Join", body: "Join, then tell us how many weeks postpartum you are, right in the app." },
            { label: "STEP 2", title: "Get matched", body: "Get matched with a small group of moms at the same stage." },
            { label: "STEP 3", title: "Walk", body: "Take a walk, listen, share, repeat." }
          ]
        },

        /* Testimonials section removed until there are real, collected
           quotes to show. Re-add a `testimonials` block here (and the
           matching renderTestimonials() call in moms-app.js, removed in
           the same change) once actual moms have signed off on their
           words -- see git history for the last draft/markup if useful
           as a starting point. */

        finalCta: {
          headline: "Your village is already walking. Join them.",
          ctaLabel: "Join your village",
          priceNote: "{price} once for 8 weeks. No subscription.",
          guarantee: "14-day money-back guarantee",
          footerDisclaimer: "Walka is not medical advice. Check with your provider before starting any exercise after birth."
        }
      },

      checkout: {
        title: "Your program",
        intro: "Here's what you're joining.",
        includedLabel: "What's included",
        includedItems: [
          "An 8-week plan, week by week",
          "A daily walk-along, guided and a few human-recorded ones",
          "Daily check-ins with step goals that adjust to you",
          "Your matched mom group, share anonymously anytime"
        ],
        nameLabel: "First name",
        emailLabel: "Email",
        guaranteeNote: "Backed by our 14-day money-back guarantee. Not for you? Email us within 14 days for a full refund.",
        billingNote: "Charged once today. No subscription, nothing to cancel.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        cardLabel: "Card details",
        paymentPlaceholder: "Complete the fields above to enter payment details.",
        paymentLoading: "Loading payment details...",
        confirmCta: "Pay {price} and start",
        processingCta: "Processing...",
        testModeNote: "Test mode: card 4242 4242 4242 4242, any date, any CVC.",
        genericError: "Something went wrong. Please try again.",
        legalLinks: { terms: "/moms-terms", privacy: "/moms-privacy" }
      }
    },

    success: {
      title: "You're in.",
      subtitle: "Welcome to the founding circle of Walka Mom. We're so glad you're here.",
      circleLabel: "Your circle begins",
      circleDate: "November 9, 2026",
      circleNote: "Everything you need to get started will be ready for you before your circle opens.",
      nextTitle: "What happens next",
      nextSteps: [
        { title: "Check your inbox", body: "Watch for a receipt from Stripe confirming today's payment." },
        { title: "We'll get your circle ready", body: "We're bringing together moms who are in this same season of life." },
        { title: "Start together on November 9", body: "That's when your 8-week program and the Walka app open up to you." }
      ],
      guaranteeFooter: "Backed by our 14-day money-back guarantee. Questions or want a refund? Email susan@getwalka.com."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susan@getwalka.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 5. ANALYTICS EVENT NAMES, prefixed moms_ so they never collide with
   *    the start/couch6k funnels' events or the main app's.
   * ------------------------------------------------------------------ */
  var EVENTS = {
    onboardingStart: "moms_onboarding_start",
    stepViewed: "moms_step_viewed",
    stepCompleted: "moms_step_completed",
    dropoff: "moms_dropoff",
    homeViewed: "moms_home_viewed",
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
    PRICE_FLAG_KEY: PRICE_FLAG_KEY,
    PRICE_TIERS: PRICE_TIERS,
    STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    SUPABASE_TABLE: SUPABASE_TABLE,
    COPY: COPY,
    EVENTS: EVENTS
  };
})();
