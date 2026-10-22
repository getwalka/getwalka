/* ==========================================================================
   Walka Couch to 6K: paid 6-week test-cohort funnel, COPY + CONFIG
   Separate, feature-flagged funnel -- does NOT touch or replace the live
   /start funnel ($24.99/mo subscription model). Everything editable about
   this experiment lives in this one file. Mirrors start-copy.js's
   structure/conventions; see that file's comments for parts that are
   identical (uuid/state/sync/gate plumbing lives in couch6k-app.js).
   ========================================================================== */
window.WALKA_COUCH6K = (function () {

  "use strict";

  /* ------------------------------------------------------------------ *
   * 1. FEATURE FLAG
   *    Own PostHog flag, separate from "start-funnel" -- ships OFF. Same
   *    fail-closed pattern: if PostHog can't be reached, the gate shows
   *    "not open yet" rather than letting anyone through. ?preview=1
   *    unlocks the flow locally regardless of the flag; ?preview=0 removes
   *    that override.
   * ------------------------------------------------------------------ */
  var FEATURE_FLAG_KEY = "couch6k-funnel";
  var PREVIEW_STORAGE_KEY = "walka_couch6k_preview";
  var FORCE_FLOW_ENABLED = false;
  var POSTHOG_FLAG_TIMEOUT_MS = 2500; // fail closed if flags never arrive

  /* ------------------------------------------------------------------ *
   * 1b. GEO GATE: US/Canada only, same mechanism as /start.
   *    middleware.js stamps walka_geo_country on every /couch6k request;
   *    couch6k-app.js reads that cookie and blocks checkout for anyone
   *    outside this list. Fails OPEN if the cookie is missing (e.g. local
   *    dev), same reasoning as start-copy.js's identical gate.
   * ------------------------------------------------------------------ */
  var GEO_ALLOWED_COUNTRIES = ["US", "CA"];

  /* ------------------------------------------------------------------ *
   * 2. PAYMENTS: Stripe, ONE combined one-time charge. No subscription.
   *
   *    Checkout charges ONE PaymentIntent for the $90 refundable stake
   *    (minus $3 per missed weekday, settled later in the app) plus the
   *    $29.99 non-refundable program fee -- $119.99 total, via
   *    create-couch6k-payment-intent. Not framed as an "AI coach fee": this
   *    cohort gets the same free static princess/tough coach copy
   *    (lib/coach.ts) as everyone else, so the fee is a neutral program
   *    fee, never described in this file's copy as paying for the coach.
   *
   *    The amounts below are DISPLAY ONLY, mirrored from the Edge
   *    Function's own hardcoded STAKE_CENTS/FEE_CENTS constants
   *    (supabase/functions/create-couch6k-payment-intent/index.ts) -- keep
   *    the two in step by hand, there is no shared source since this repo
   *    has no build step to share values between Deno and this file.
   * ------------------------------------------------------------------ */
  /* "live", for the same reason start-copy.js is "live": this Supabase
     project has exactly one STRIPE_SECRET_KEY (the live one; /moms and
     /start already run checkout off it too), not a test/live pair. A
     "test" publishable key here would mount Stripe Elements against a
     live-mode clientSecret and fail. Testing this funnel for real means a
     real card and a real $119.99 charge -- refund/cancel it in the Stripe
     dashboard afterward. Revisit if this project ever gets its own
     test-mode secret key. */
  var STRIPE_MODE = "live"; // "test" | "live"

  var STAKE_CENTS = 9000;   // $90.00
  var FEE_CENTS = 2999;     // $29.99
  var TOTAL_CENTS = STAKE_CENTS + FEE_CENTS; // $119.99
  var MISS_LOSS_CENTS_PER_DAY = 300; // $3/missed weekday, capped at the stake -- GROUP ONLY, see SOLO_LOSER_REFUND_PCT below
  /* Solo's real mechanic, mirrored exactly from process-payouts' own
     SOLO_LOSER_REFUND_PCT constant: binary, not prorated. Solo instances
     run with miss_limit 0 and $90 isn't in miss_loss_options()'s supported
     stake tiers (15/25/50/100), so a solo couch6k participant gets the
     legacy rule -- miss even one day and 90% of the stake is forfeited to
     Walka, 10% comes back as wallet credit. Perfect completion still
     returns the full stake either way. */
  var SOLO_LOSER_REFUND_PCT = 0.1;
  var PROGRAM_WEEKS = 6;
  var PROGRAM_DURATION_DAYS = 42; // 6 calendar weeks; only Mon-Fri are actually tracked (weekdays_only on the manually-created challenge row)
  var TRACKED_WEEKDAYS = PROGRAM_WEEKS * 5; // 30 -- the actual scored days (weekends are free)

  /* THE single source of truth for the weekly step-goal ramp. Fixed for
     every user, independent of onboarding answers -- the average-steps
     question is analytics only (see couch6k-app.js's syncLead) and must
     never feed this array. Used by the paywall's ramp display and
     checkout's copy; there is nowhere else in THIS funnel that needs it.
     FLAG: the real in-app challenge (the manually-created row + its
     step_goal) can only hold ONE flat goal -- the app's challenge schema
     has no per-week goal field (confirmed when this funnel was built; see
     the implementation plan's "per-week ramp storage" non-goal). Wiring
     this exact ramp into real day-by-day in-app enforcement is a backend
     change this file deliberately does NOT make -- flag for the operator:
     either pick one representative flat step_goal for the manually-created
     challenge row, or scope a real backend change later. */
  var WEEKLY_TARGETS = [2000, 3000, 4000, 5000, 6000, 6000];

  /* Manually curated to match whatever the operator actually sets as the
     real manually-created challenge's start_date (see the implementation
     plan -- this funnel has no live cohort-preview API to read a real date
     from). ONE value, a real parseable date -- couch6k-app.js derives the
     displayed start label AND the end/refund-date label from this single
     ISO string, so the two can never drift apart. Keep this in step by
     hand when the real start date is set; it only applies to group mode
     (solo starts whenever the user joins, so app.js shows a different
     line for solo instead of this date). */
  var COHORT_START_DATE_ISO = "2026-11-02";

  /* Publishable keys are not secret, safe to ship in client code. Same
     Stripe account as /start and /moms -- shared project, one key per mode. */
  var STRIPE_PUBLISHABLE_KEY = {
    test: "pk_test_51IAPwwKmW6iAmon9BvmoxKu3jXyKpZsKwOQ3uEoeZDk36hIzuECAUktrzreXANmhKa03DWf7GFhUPT8i54UZBWUV00oO4xYgwS",
    live: "pk_live_51IAPwwKmW6iAmon97vBggpfUblagf7SYYMOQ6mYGj0gWjCtZQ1nnst9oiSu9rka7jvlwnIPbca0RLScydPB8Scy4005VuT8ANc"
  };

  /* ------------------------------------------------------------------ *
   * 3. SUPABASE: own leads table (couch6k_leads), same project as start/moms.
   *    Protected by the RLS policy in supabase/couch6k_leads.sql: anon can
   *    insert, and can read/update only the row matching the local_id it
   *    already holds.
   * ------------------------------------------------------------------ */
  var SUPABASE_URL = "https://mgocpqbxssvjlmqzqfgn.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nb2NwcWJ4c3N2amxtcXpxZmduIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjIzNzQyMjQsImV4cCI6MjA3Nzk1MDIyNH0.CEgJvGEOJJe5slTp3EKvOqw1pOwJOWK2GTitoL1QODY";
  var SUPABASE_TABLE = "couch6k_leads";

  /* App download link shown on the success page. Android isn't live yet. */
  var APP_STORE_URL = "https://apps.apple.com/us/app/walka/id6758069435";

  /* ------------------------------------------------------------------ *
   * 4. GOAL -> FitnessGoal mapping. Mirrors profiles.fitness_goal's
   *    vocabulary exactly, same reasoning as start-copy.js's identical map.
   * ------------------------------------------------------------------ */
  var GOAL_TO_FITNESS_GOAL = {
    stay_consistent: "habit",
    build_habit: "habit",
    lose_weight: "lose_weight"
  };

  /* ------------------------------------------------------------------ *
   * 5. COPY. Warm, plainspoken, no em dashes (brand voice rule, CLAUDE.md).
   * ------------------------------------------------------------------ */
  var COPY = {
    metaTitle: "Walka: Couch to 6K",
    metaDescription: "From couch to 6,000 steps a day in 6 weeks. A ramping goal, a coach, and a little accountability built in.",

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

    /* The landing/quiz first screen, tuned for ad traffic. title is a prop
       (couch6k-app.js reads a ?headline= override so each ad creative can
       swap it without a redeploy) -- this is just the default when no
       override is present. Always "steps", never a bare "6K": that reads
       as a running distance, not a step count. */
    introHeader: {
      title: "From couch to 6K steps in 6 weeks.",
      body: "Put {stake} on the line. Hit your daily goal and keep it. Miss a day and lose {perDay}. A coach messages you every day.",
      features: [
        { icon: "🎯", label: "Starts at {startSteps} steps" },
        { icon: "💰", label: "Keep your stake when you walk" },
        { icon: "🧑‍🏫", label: "A coach in your style" }
      ]
    },

    /* Shown under the card, first step only. True today: checkout is the
       literal last step, nothing charges before it -- if that ever
       changes, drop the second sentence rather than let it go stale. */
    belowCardNote: "Takes about 2 minutes. No payment until the last step.",

    steps: {
      /* Screen 1. No intro line inside the card (introHeader above already
         covers it, saying it twice read as filler) -- instead a reassurance
         line rendered under the card, first step only: belowCardNote. */
      goal: {
        title: "What's your goal right now?",
        options: [
          { value: "build_habit", label: "Build a daily walking habit" },
          { value: "lose_weight", label: "Lose some weight" },
          { value: "stay_consistent", label: "Finally stay consistent" }
        ]
      },

      /* Screen 2 */
      baseline: {
        title: "How many steps do you average now?",
        hint: "A rough guess is fine.",
        options: [
          { value: "under_2k", label: "Under 2,000" },
          { value: "two_to_three", label: "2,000 to 3,000" },
          { value: "three_to_five", label: "3,000 to 5,000" },
          { value: "five_to_seven", label: "5,000 to 7,000" },
          { value: "seven_plus", label: "7,000+" }
        ]
      },

      /* Screen 3, seven_plus only -- skipped entirely for everyone else, in
         both nav directions (see couch6k-app.js's skip contract). Terminal:
         no checkout, just a reachable lead for later. */
      waitlist: {
        title: "You're already ahead of this one.",
        body: "This 6-week plan is built for people building up from under 7,000 steps a day. Join the waitlist and we'll let you know if we open a program for your level.",
        nameLabel: "First name",
        emailLabel: "Email",
        submitCta: "Join the waitlist",
        confirmedTitle: "You're on the list.",
        confirmedBody: "We'll email you if a program opens up for your level."
      },

      /* Screen 4 */
      coach: {
        title: "Pick your coach.",
        options: [
          { value: "princess", label: "Gentle coach", sub: "Princess treatment: warm and encouraging, Coach Serena" },
          { value: "tough", label: "Tough coach", sub: "Blunt, no excuses, Coach Tim" }
        ]
      },

      /* Screen 5. Pre-selected to "group" -- Continue is enabled without a
         tap (see couch6k-app.js's mode step, a real deviation from the
         pill-only auto-advance pattern every other step uses). */
      mode: {
        title: "Solo, or with a group?",
        options: [
          { value: "group", label: "With a group", sub: "Join this cohort, starting together" },
          { value: "solo", label: "Solo", sub: "Your own private challenge, same terms" }
        ],
        disclosureLabel: "What's the difference?",
        disclosureBody: "<p>With a group, everyone starts the same week and keeps each other honest. If you miss a day, your $3 gets shared among the people who finish, not kept by Walka.</p>" +
          "<p>Solo is the same price, same goal, same 6 weeks, just without a group. If you miss a day, that $3 goes to Walka instead of back to a group.</p>",
        soloMoneyNote: "Solo heads up: missed-day money goes to Walka, not back to you."
      },

      /* Screen 6: first name + email, captured before the paywall/checkout so
         a dropoff there still leaves a reachable lead. */
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
        body: "We're turning what you told us into a 6-week ramp."
      },

      /* Screen 8, the paywall. No "made for you"/personalized framing
         anywhere -- the ramp, stake and fee are the same for every user;
         the baseline-steps answer is analytics only. Order on screen:
         headline, ramp, money card, coach card, one-liners, rules
         accordion, "why 6,000" row, sticky total+button bar.
         {placeholders} are filled in by couch6k-app.js from WS's config
         constants (never hardcoded twice, so this screen can't diverge
         from checkout). */
      results: {
        /* 1. Headline + subline */
        headline: "From couch to {finalK}K steps",
        /* Solo's real mechanic is binary, not the group's prorated per-day
           loss: solo instances run with miss_limit 0 and no per-day penalty
           support for a $90 stake (miss_loss_options() only covers 15/25/
           50/100), so missing even one day forfeits 90% of the stake to
           Walka (the legacy SOLO_LOSER_REFUND_PCT rule, process-payouts),
           not a $3/day deduction. Keep these two sublines genuinely
           different, not a shared template with a swapped number. */
        sublineGroup: "Hit your daily goal and keep your money. Miss a day and lose {perDay}.",
        sublineSolo: "Hit your daily goal and keep your money. Miss just one day solo and you lose 90% of your stake to Walka, not {perDay} a day.",

        /* 2. Ramp chart */
        rampWeekLabel: "Week",
        rampStartLabelGroup: "You start here",
        rampStartDateGroup: "{startDate}",
        rampStartLabelSolo: "You start here",
        rampStartDateSolo: "The day you join",

        /* 3. Money card. Group gets the interactive slider (its loss is
           genuinely prorated day by day). Solo's mechanic is binary -- see
           the SOLO_LOSER_REFUND_PCT comment in the config section -- so it
           gets a static two-line outcome instead of a slider that would
           otherwise sit flat at one value for every miss count from 1 to
           {totalDays}, which would read as broken, not intentional. */
        moneyFinishLine: "Finish every day and the only money that stays with Walka is the {fee} program fee. Your {stake} comes back in full.",
        sliderLabel: "If I miss {misses} days",
        sliderBack: "You get back {back}.",
        sliderLose: "You lose {lose}.",
        soloOutcomePerfect: "Finish every day: {stake} back, in full.",
        soloOutcomeMiss: "Miss even one day: only {refund} back. {forfeit} goes to Walka, not split with anyone.",

        /* 4. Coach card. Sample messages are real lines already shipped in
           lib/coach.ts (one per style), not invented for this page -- see
           couch6k-app.js's COACH_SAMPLES. Caption is deliberately neutral:
           the coach is free for every user in the app (CLAUDE.md), so
           nothing here claims the fee pays specifically for coaching. */
        coachCardLabel: "Your coach",
        coachCardStyleGroup: "coach_style", // internal key, not displayed
        coachCardCaption: "Included with your program fee, not an extra charge.",

        /* 5. Fact one-liner(s) */
        lineGoal: "Reach your goal by 11:59 pm your time, Mon-Fri. Weekends are grace days.",

        /* 6. "Rules in detail" accordion */
        rulesLabel: "Rules in detail",
        ruleStepSource: { title: "Where your steps come from", body: "Apple Health, synced automatically from your phone. No manual entry, nothing to remember to log. Walka is iOS-only right now, so this is an iPhone-only program." },
        ruleTimeZone: { title: "Time zones", body: "Your day runs midnight to midnight in your phone's time zone. If you travel, your day follows your phone, not the cohort's home zone." },
        ruleCancellation: { title: "Cancellation policy", body: "If this program doesn't reach enough participants, or the organizer cancels before it starts, every participant gets a full refund automatically. Once the program has started, your stake follows the miss-day rule above instead of a cancellation refund." },
        rulePayout: { title: "Payout rule", body: "Each missed weekday costs {perDay} from your stake, capped at your full {stake} stake, so you can never lose more than you put in. {payoutDetail}" },
        rulePayoutDetailGroup: "That missed-day money is split evenly between everyone in your group who finishes.",
        rulePayoutDetailSolo: "That missed-day money goes to Walka; solo challenges have no group to split it with.",
        ruleEdgeCases: { title: "Edge cases", body: "Something not syncing, a day that looks wrong, or a question this page doesn't answer? Email susan@getwalka.com and we'll sort it out before it affects your payout." },

        /* 8. Sticky bottom bar */
        totalLine: "Today: {total} ({stake} refundable)",
        continueCta: "Lock in my plan",
        afterButtonNote: "Secure payment via Stripe · Next: download the app and connect Apple Health."

        /* 9. "Joined"/countdown -- only shown when backed by real data.
           Neither exists for this manually-created one-off cohort today
           (no live preview API), so couch6k-app.js omits both rather than
           showing a fake number. The standalone cancellation line was
           removed too; the full policy is still in the "Rules in detail"
           accordion's Cancellation policy item above. */
      },

      /* Screen 9 */
      checkout: {
        title: "Lock in your plan.",
        intro: "Charged once today. No subscription.",
        includedLabel: "What's included",
        includedItems: [
          "Your 6-week ramp, built from your answers",
          "Daily messages from your coach",
          "Connect with other walkers in your group",
          "Free tracking, history and leaderboards, always"
        ],
        feeRowLabel: "Program fee (non-refundable)",
        stakeRowLabel: "Stake (refundable, minus {perDay}/missed weekday)",
        nameLabel: "First name",
        emailLabel: "Email",
        billingNoteBase: "Charged once today, no subscription. The stake is refunded in full if you finish, minus {perDay} for every weekday you miss.",
        agreePrefix: "I agree to the",
        agreeTermsText: "Terms",
        agreeJoiner: "and",
        agreePrivacyText: "Privacy Policy",
        cardLabel: "Card details",
        paymentPlaceholder: "Complete the fields above to enter payment details.",
        paymentLoading: "Loading payment details...",
        confirmCta: "Pay {total} and start",
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
      cancelFallback: "Questions about your payment? Email susan@getwalka.com."
    },

    returnMissing: {
      title: "Thanks!",
      body: "Your payment went through. If anything looks off, email susan@getwalka.com and we'll sort it."
    }
  };

  /* ------------------------------------------------------------------ *
   * 6. ANALYTICS EVENT NAMES, prefixed couch6k_ so they never collide with
   *    the start/moms funnels' events or the main app's.
   * ------------------------------------------------------------------ */
  var EVENTS = {
    onboardingStart: "couch6k_onboarding_start",
    stepViewed: "couch6k_step_viewed",
    stepCompleted: "couch6k_step_completed",
    dropoff: "couch6k_dropoff",
    waitlisted: "couch6k_waitlisted",
    resultsViewed: "couch6k_results_viewed",
    checkoutViewed: "couch6k_checkout_viewed",
    checkoutStarted: "couch6k_checkout_started",
    checkoutCompleted: "couch6k_checkout_completed",
    checkoutFailed: "couch6k_checkout_failed",
    geoBlocked: "couch6k_geo_blocked"
  };

  return {
    FEATURE_FLAG_KEY: FEATURE_FLAG_KEY,
    FORCE_FLOW_ENABLED: FORCE_FLOW_ENABLED,
    PREVIEW_STORAGE_KEY: PREVIEW_STORAGE_KEY,
    POSTHOG_FLAG_TIMEOUT_MS: POSTHOG_FLAG_TIMEOUT_MS,
    GEO_ALLOWED_COUNTRIES: GEO_ALLOWED_COUNTRIES,
    STRIPE_MODE: STRIPE_MODE,
    STAKE_CENTS: STAKE_CENTS,
    FEE_CENTS: FEE_CENTS,
    TOTAL_CENTS: TOTAL_CENTS,
    MISS_LOSS_CENTS_PER_DAY: MISS_LOSS_CENTS_PER_DAY,
    SOLO_LOSER_REFUND_PCT: SOLO_LOSER_REFUND_PCT,
    PROGRAM_WEEKS: PROGRAM_WEEKS,
    PROGRAM_DURATION_DAYS: PROGRAM_DURATION_DAYS,
    TRACKED_WEEKDAYS: TRACKED_WEEKDAYS,
    WEEKLY_TARGETS: WEEKLY_TARGETS,
    COHORT_START_DATE_ISO: COHORT_START_DATE_ISO,
    STRIPE_PUBLISHABLE_KEY: STRIPE_PUBLISHABLE_KEY,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    SUPABASE_TABLE: SUPABASE_TABLE,
    APP_STORE_URL: APP_STORE_URL,
    GOAL_TO_FITNESS_GOAL: GOAL_TO_FITNESS_GOAL,
    COPY: COPY,
    EVENTS: EVENTS
  };
})();
