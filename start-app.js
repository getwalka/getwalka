/* ==========================================================================
   Walka Start: general-audience onboarding flow, ENGINE
   Step state machine, feature-flag gate, resume-from-localStorage, analytics
   events, Supabase sync, two-charge Stripe checkout. All copy/config lives
   in start-copy.js. Structure mirrors moms-app.js; see that file's comments
   for the parts that are identical (uuid/state/sync/gate plumbing).
   ========================================================================== */
(function () {
  "use strict";

  var WS = window.WALKA_START;
  var COPY = WS.COPY;
  var EVENTS = WS.EVENTS;
  var STORAGE_KEY = "walka_start_state_v1";
  var PREPARING_DELAY_MS = 3000;
  // "stake" is removed from this list for now (see the PAYMENTS note in
  // start-copy.js) -- its step definition, copy, and the checkout stake
  // toggle/charge are gone too; check git history to restore all of it.
  var STEP_IDS = [
    "goal", "baseline", "difficulty", "coach", "mode", "contact", "preparing", "results", "checkout"
  ];

  /* ---------------- utilities ---------------- */

  function uuidv4() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map.call(bytes, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }

  function track(event, props) {
    try {
      if (window.posthog && window.posthog.capture) window.posthog.capture(event, props || {});
    } catch (e) { /* analytics should never break the flow */ }
  }

  function escapeAttr(str) {
    return String(str == null ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  }

  /* Same $24.99 numeral, charged in the visitor's own currency -- not a
     converted equivalent, two separate Stripe prices. getwalka only ever
     serves US/CA for this funnel (geoBlocked() below), so usd/cad are the
     only two cases; anything else (unknown country, local dev with no geo
     cookie) falls back to usd rather than leaving checkout without a price. */
  function checkoutCurrency(a) {
    return a.country === "CA" ? "cad" : "usd";
  }

  /* supabase-js's FunctionsHttpError.message is always the generic "Edge
     Function returned a non-2xx status code" -- the Edge Function's own
     { error: "..." } body (set by this project's jsonResponse() helper on
     every function) is only reachable via error.context, the raw fetch
     Response. Reads it so checkout can show (and dev tools can log) the
     real reason a call failed instead of that one indistinguishable string. */
  function describeFunctionError(err) {
    if (err && err.context && typeof err.context.json === "function") {
      return err.context.json().then(function (body) {
        return new Error((body && body.error) || (err && err.message) || "Request failed");
      }).catch(function () {
        return err instanceof Error ? err : new Error("Request failed");
      });
    }
    return Promise.resolve(err instanceof Error ? err : new Error(String((err && err.message) || "Request failed")));
  }

  /* ---------------- plan math (mirrors lib/recommendation.ts; see start-copy.js) ---------------- */

  function roundToHalfK(n) { return Math.round(n / 500) * 500; }

  function computeStepGoal(a) {
    var baseline = WS.BASELINE_BUCKETS[a.baseline_bucket] || 6000;
    var fitnessGoal = WS.GOAL_TO_FITNESS_GOAL[a.goal] || "habit";
    var stretch = WS.GOAL_STRETCH[fitnessGoal] || 1.0;
    var difficultyMult = WS.DIFFICULTY_MULTIPLIER[a.difficulty] || 1.0;
    var target = roundToHalfK(baseline * stretch * difficultyMult);
    return Math.min(WS.STEP_CEILING, Math.max(WS.STEP_FLOOR, target));
  }

  function centsLabel(cents) {
    return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
  }

  /* One row of the results step's plan-facts list: icon, label, value, and
     an optional smaller sub-line (e.g. "refunded in full when you finish"). */
  function planRow(icon, label, value, sub) {
    return '<div class="plan-summary__row">' +
      '<span class="plan-summary__icon" aria-hidden="true">' + icon + '</span>' +
      '<div class="plan-summary__text">' +
        '<p class="plan-summary__label">' + escapeAttr(label) + '</p>' +
        '<p class="plan-summary__value">' + escapeAttr(value) + '</p>' +
        (sub ? '<p class="plan-summary__sub">' + escapeAttr(sub) + '</p>' : '') +
      '</div>' +
    '</div>';
  }

  /* ---------------- state ---------------- */

  var state = loadState();

  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.localId) return parsed;
      }
    } catch (e) { /* ignore corrupt storage */ }
    return { localId: uuidv4(), stepIndex: 0, answers: {}, startedAt: Date.now(), isResumed: false };
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* storage may be full/blocked */ }
  }

  /* ---------------- Supabase (best effort, never blocks the UI) ---------------- */

  var sbClient = null;
  if (window.supabase) {
    try { sbClient = window.supabase.createClient(WS.SUPABASE_URL, WS.SUPABASE_ANON_KEY); } catch (e) { sbClient = null; }
  }

  function syncLead(extra) {
    if (!sbClient) return Promise.resolve();
    var a = state.answers;
    var row = Object.assign({
      local_id: state.localId,
      updated_at: new Date().toISOString(),
      country: a.country || null,
      billing_currency: checkoutCurrency(a),
      goal: a.goal || null,
      fitness_goal: a.goal ? (WS.GOAL_TO_FITNESS_GOAL[a.goal] || null) : null,
      baseline_bucket: a.baseline_bucket || null,
      baseline_avg_steps: a.baseline_bucket ? (WS.BASELINE_BUCKETS[a.baseline_bucket] || null) : null,
      difficulty: a.difficulty || null,
      coach_style: a.coach_style || null,
      mode: a.mode || null,
      stake_amount: null, // stake is off for this funnel right now; see start-copy.js's PAYMENTS note
      plan_step_goal: a.plan_step_goal || null,
      plan_duration_days: WS.PLAN_DURATION_DAYS,
      first_name: a.first_name || null,
      email: a.email || null,
      referral_source: a.referral_source || null,
      last_step: STEP_IDS[state.stepIndex] || null,
      checkout_status: a.checkout_status || "not_started",
      plan_price_cents: WS.PLAN_PRICE_CENTS,
      billing_interval: WS.BILLING_INTERVAL
    }, extra || {});

    return sbClient.from(WS.SUPABASE_TABLE).upsert(row, { onConflict: "local_id" })
      .then(function (res) { if (res.error) console.warn("[start-flow] supabase upsert error", res.error); })
      .catch(function (err) { console.warn("[start-flow] supabase upsert failed", err); });
  }

  /* Resuming from a different device/browser than the one that started the
     flow -- same ?lid=<local_id> mechanic as the moms funnel. */
  function maybeRehydrateFromLink() {
    var lid = getQueryParam("lid");
    if (!lid || !sbClient || state.localId === lid) return Promise.resolve();

    return sbClient.from(WS.SUPABASE_TABLE).select("*").eq("local_id", lid).maybeSingle()
      .then(function (res) {
        if (res.error || !res.data) return;
        var row = res.data;
        var idx = STEP_IDS.indexOf(row.last_step);
        state = {
          localId: row.local_id,
          stepIndex: idx >= 0 ? idx : 0,
          answers: {
            country: row.country || null,
            goal: row.goal || null,
            baseline_bucket: row.baseline_bucket || null,
            difficulty: row.difficulty || null,
            coach_style: row.coach_style || null,
            mode: row.mode || null,
            stake_amount: row.stake_amount || null,
            plan_step_goal: row.plan_step_goal || null,
            first_name: row.first_name || null,
            email: row.email || null,
            referral_source: row.referral_source || null,
            checkout_status: row.checkout_status || "not_started"
          },
          startedAt: Date.now(),
          isResumed: true
        };
        saveState();
        try {
          var url = new URL(window.location.href);
          url.searchParams.delete("lid");
          history.replaceState(null, "", url.pathname + url.search + url.hash);
        } catch (e) { /* ignore */ }
      })
      .catch(function (err) { console.warn("[start-flow] rehydrate from link failed", err); });
  }

  /* ---------------- DOM refs ---------------- */

  var screenEl, continueBtn, backBtn, skipBtn, progressFill, progressLabel, resumeBanner, resumeBannerText, resumeBannerDismiss, gateEl, appEl, loadingEl, mainEl, exitLink, flownavEl, introHeaderEl;

  /* ---------------- step definitions ---------------- */
  /* Each step: render() -> HTML, bind(root) attach listeners, canAdvance()
     -> bool, onEnter()/onLeave() optional, skip(a) optional (bypassed
     entirely in both directions when it returns true). */

  var steps = {

    goal: {
      hideContinue: true,
      render: function (a) {
        var c = COPY.steps.goal;
        var opts = c.options.map(function (o) {
          return pillOption("goal_value", o.value, o.label, a.goal === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="answer-grid" id="goalOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#goalOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.goal = b.getAttribute("data-value");
            root.querySelectorAll('#goalOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            autoAdvance();
          });
        });
      },
      canAdvance: function (a) { return !!a.goal; }
    },

    baseline: {
      hideContinue: true,
      render: function (a) {
        var c = COPY.steps.baseline;
        var opts = c.options.map(function (o) {
          return pillOption("baseline_value", o.value, o.label, a.baseline_bucket === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-hint">' + c.hint + '</p>' +
          '<div class="answer-grid" id="baselineOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#baselineOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.baseline_bucket = b.getAttribute("data-value");
            root.querySelectorAll('#baselineOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            autoAdvance();
          });
        });
      },
      canAdvance: function (a) { return !!a.baseline_bucket; }
    },

    difficulty: {
      hideContinue: true,
      render: function (a) {
        var c = COPY.steps.difficulty;
        var opts = c.options.map(function (o) {
          return pillOption("difficulty_value", o.value, o.label, a.difficulty === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<div class="answer-grid" id="difficultyOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#difficultyOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.difficulty = b.getAttribute("data-value");
            root.querySelectorAll('#difficultyOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            autoAdvance();
          });
        });
      },
      canAdvance: function (a) { return !!a.difficulty; }
    },

    coach: {
      hideContinue: true,
      render: function (a) {
        var c = COPY.steps.coach;
        var opts = c.options.map(function (o) {
          return pillOptionWithSub("coach_value", o.value, o.label, o.sub, a.coach_style === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<div class="answer-grid" id="coachOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#coachOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.coach_style = b.getAttribute("data-value");
            root.querySelectorAll('#coachOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            autoAdvance();
          });
        });
      },
      canAdvance: function (a) { return !!a.coach_style; }
    },

    mode: {
      hideContinue: true,
      render: function (a) {
        var c = COPY.steps.mode;
        var opts = c.options.map(function (o) {
          return pillOptionWithSub("mode_value", o.value, o.label, o.sub, a.mode === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<div class="answer-grid" id="modeOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#modeOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.mode = b.getAttribute("data-value");
            root.querySelectorAll('#modeOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            autoAdvance();
          });
        });
      },
      canAdvance: function (a) { return !!a.mode; }
    },

    contact: {
      render: function (a) {
        var c = COPY.steps.contact;
        var opts = c.referralOptions.map(function (o) {
          return pillOption("referral_value", o.value, o.label, a.referral_source === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.subtitle + '</p>' +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="firstName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="email" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<p class="q-label">' + c.referralLabel + '</p>' +
          '<div class="answer-grid" id="referralOpts">' + opts + '</div>';
      },
      bind: function (root) {
        var name = root.querySelector("#firstName"), email = root.querySelector("#email");
        name.addEventListener("input", function () { state.answers.first_name = name.value; refreshContinue(); });
        email.addEventListener("input", function () { state.answers.email = email.value; refreshContinue(); });
        root.querySelectorAll('#referralOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.referral_source = b.getAttribute("data-value");
            root.querySelectorAll('#referralOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
          });
        });
      },
      canAdvance: function (a) {
        return !!(a.first_name && a.first_name.trim()) && /\S+@\S+\.\S+/.test((a.email || "").trim());
      }
    },

    preparing: {
      hideNav: true,
      render: function () {
        var c = COPY.steps.preparing;
        return '<div class="preparing">' +
          '<div class="preparing__dots" aria-hidden="true">' +
            '<span class="preparing__dot preparing__dot--sage"></span>' +
            '<span class="preparing__dot preparing__dot--lavender"></span>' +
            '<span class="preparing__dot preparing__dot--amber"></span>' +
          '</div>' +
          '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.body + '</p>' +
        '</div>';
      },
      bind: function () {},
      canAdvance: function () { return true; },
      onEnter: function (a) {
        a.plan_step_goal = computeStepGoal(a);
        clearTimeout(pendingAdvanceTimer);
        pendingAdvanceTimer = setTimeout(function () { goNext(); }, PREPARING_DELAY_MS);
      }
    },

    /* The "Made for you" paywall. For `group`, fetches the REAL cohort terms.
       For `solo`, uses the illustrative plan_step_goal computed on
       `preparing`. Three plan-facts rows (goal, coach, format), same row
       height and alignment throughout, read at a glance; the recurring
       price is the only large number on the screen. The stake row is
       removed from here for now (see start-copy.js's PAYMENTS note) --
       re-add a fourth planRow("💵", ...) sourced from `stake` below (solo:
       a.stake_amount, group: cohort.buyIn) to bring it back. */
    results: {
      flownavVariant: "tight",
      render: function (a) {
        var c = COPY.steps.results;
        var isGroup = a.mode === "group";
        var currency = checkoutCurrency(a);
        var cohort = a.cohortPreview;
        var stepGoal = isGroup && cohort ? cohort.stepGoal : a.plan_step_goal;
        var coachLabel = a.coach_style === "princess" ? "Coach Serena" : "Coach Tim";

        var goalValue = stepGoal
          ? (Number(stepGoal).toLocaleString() + " steps/day for " + WS.PLAN_DURATION_DAYS + " days")
          : "Built from your answers";

        var formatValue, formatSub;
        if (isGroup) {
          formatValue = c.groupTitle;
          formatSub = (cohort && typeof cohort.paidCount === "number" && cohort.paidCount > 0)
            ? (c.groupSub + " · " + cohort.paidCount + " " + c.joinedLabel)
            : c.groupSub;
        } else {
          formatValue = c.soloTitle;
          formatSub = c.soloBody;
        }

        return '<div class="stagger">' +
          '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + c.title + '</h2>' +
          '<div class="plan-summary">' +
            planRow("🎯", c.dailyGoalLabel, goalValue) +
            planRow("🧑‍🏫", c.coachLabel, coachLabel) +
            planRow(isGroup ? "👥" : "🚶", c.formatLabel, formatValue, formatSub) +
          '</div>' +
          '<div class="plan-price">' +
            '<p class="q-label" style="margin-top:0">' + c.priceLabel + '</p>' +
            '<p class="price-tag">' + centsLabel(WS.PLAN_PRICE_CENTS) + ' ' + currency.toUpperCase() + '<span class="price-tag__interval">/' + WS.BILLING_INTERVAL + '</span></p>' +
          '</div>' +
        '</div>';
      },
      bind: function () {},
      canAdvance: function () { return true; },
      continueLabel: function () { return COPY.steps.results.continueCta; },
      onEnter: function (a) {
        track(EVENTS.resultsViewed, { mode: a.mode, local_id: state.localId });
        syncLead();
        if (a.mode === "group" && sbClient) {
          sbClient.functions.invoke("get-weekly-cohort-preview", { body: {} })
            .then(function (res) {
              var data = (res && res.data) || {};
              if (data.available) {
                a.cohortPreview = data;
                if (currentStepId() === "results") renderStep(false);
              }
            })
            .catch(function (err) { console.warn("[start-flow] cohort preview failed", err); });
        }
      }
    },

    checkout: {
      render: function (a) {
        var c = COPY.steps.checkout;
        var currency = checkoutCurrency(a);
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="charge-breakdown">' +
            '<div class="charge-breakdown__row"><span>' + c.membershipRowLabel + '</span><strong>' + centsLabel(WS.PLAN_PRICE_CENTS) + ' ' + currency.toUpperCase() + '/' + WS.BILLING_INTERVAL + '</strong></div>' +
          '</div>' +
          '<p class="q-hint">' + c.billingNoteBase + '</p>' +
          '<p class="q-label">' + c.includedLabel + '</p>' +
          '<div class="recap"><ul class="recap__list">' +
            c.includedItems.map(function (t) { return '<li>' + t + '</li>'; }).join("") +
          '</ul></div>' +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="firstName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="email" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<label class="checkline"><input type="checkbox" id="agreeCheck"> ' + c.agreePrefix +
            ' <a href="' + c.legalLinks.terms + '" target="_blank" rel="noopener">' + c.agreeTermsText + '</a> ' + c.agreeJoiner +
            ' <a href="' + c.legalLinks.privacy + '" target="_blank" rel="noopener">' + c.agreePrivacyText + '</a></label>' +
          '<p class="q-disclaimer">' + COPY.disclaimer + '</p>' +
          (WS.STRIPE_MODE === "test" ? '<p class="q-note">' + c.testModeNote + '</p>' : '') +
          '<div id="paymentElementContainer" class="payment-pending"><p class="q-hint">' + c.paymentPlaceholder + '</p></div>' +
          '<button type="button" class="btn btn--ink" id="payBtn" style="width:100%;margin-top:8px" disabled>' + c.confirmCta + '</button>' +
          '<p class="q-error" id="checkoutError" hidden></p>';
      },
      bind: function (root) {
        var c = COPY.steps.checkout;
        var name = root.querySelector("#firstName"), email = root.querySelector("#email");
        var agree = root.querySelector("#agreeCheck"), pay = root.querySelector("#payBtn"), err = root.querySelector("#checkoutError");
        var paymentContainer = root.querySelector("#paymentElementContainer");

        var stripeClient = null, elements = null;
        var initiated = false, mounted = false, alreadyActive = false;
        var debounceTimer = null;

        function confirmLabel() {
          return c.confirmCta;
        }
        function fieldsValid() {
          return name.value.trim().length > 0 && agree.checked && /\S+@\S+\.\S+/.test(email.value.trim());
        }
        function refreshButton() {
          pay.disabled = !((mounted || alreadyActive) && fieldsValid());
          if (!pay.disabled || pay.textContent !== c.processingCta) pay.textContent = confirmLabel();
        }
        function showError(msg) {
          err.textContent = msg;
          err.hidden = false;
        }

        function startInlineCheckout() {
          var pk = WS.STRIPE_PUBLISHABLE_KEY[WS.STRIPE_MODE];
          if (!window.Stripe || !pk) {
            showError("Payment isn't configured yet. Add the publishable key to start-copy.js.");
            track(EVENTS.checkoutFailed, { reason: "missing_publishable_key" });
            return;
          }
          var currency = checkoutCurrency(state.answers);
          stripeClient = window.Stripe(pk);
          sbClient.functions.invoke("create-start-subscription-intent", {
            body: { local_id: state.localId, email: email.value.trim(), name: name.value.trim(), currency: currency }
          }).then(function (res) {
            if (res.error) throw res.error;
            var data = res.data || {};
            if (data.error) throw new Error(data.error);

            if (data.alreadyActive) {
              alreadyActive = true;
              paymentContainer.className = "";
              paymentContainer.innerHTML = '<p class="q-hint">Membership already active. Ready when you are.</p>';
              refreshButton();
              return;
            }
            if (!data.clientSecret) throw new Error("no clientSecret in response");

            elements = stripeClient.elements({ clientSecret: data.clientSecret });
            paymentContainer.className = "";
            paymentContainer.innerHTML = '<p class="q-label">' + c.cardLabel + '</p><div id="paymentElement"></div>';
            elements.create("payment").mount("#paymentElement");

            mounted = true;
            err.hidden = true;
            refreshButton();
            track(EVENTS.checkoutStarted, { local_id: state.localId, mode: state.answers.mode, currency: currency });
          }).catch(function (e) {
            describeFunctionError(e).then(function (described) {
              console.warn("[start checkout] create-start-subscription-intent failed", described);
              showError(described.message || c.genericError);
              track(EVENTS.checkoutFailed, { reason: "subscription_intent_error" });
            });
          });
        }

        function scheduleInit() {
          if (initiated || !fieldsValid()) return;
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(function () {
            if (initiated || !fieldsValid()) return;
            initiated = true;

            paymentContainer.className = "payment-loading";
            paymentContainer.innerHTML =
              '<span class="payment-loading__dots" aria-hidden="true">' +
                '<span class="payment-loading__dot payment-loading__dot--sage"></span>' +
                '<span class="payment-loading__dot payment-loading__dot--lavender"></span>' +
                '<span class="payment-loading__dot payment-loading__dot--amber"></span>' +
              '</span>' +
              '<p class="q-hint">' + c.paymentLoading + '</p>';

            state.answers.checkout_status = "started";
            saveState();

            var started = false;
            function begin() { if (!started) { started = true; startInlineCheckout(); } }
            syncLead().then(begin).catch(begin);
            setTimeout(begin, 1200);
          }, 600);
        }

        name.addEventListener("input", function () { state.answers.first_name = name.value; refreshButton(); scheduleInit(); });
        email.addEventListener("input", function () { state.answers.email = email.value; refreshButton(); scheduleInit(); });
        agree.addEventListener("change", function () { refreshButton(); scheduleInit(); });

        // Stake charging (create-start-stake-intent) is removed from this
        // funnel for now -- see start-copy.js's PAYMENTS note. A prior
        // chargeStake() helper lived here; restore it alongside the
        // checkout UI if the stake comes back.

        function finishCheckout() {
          state.answers.checkout_status = "completed_unverified";
          saveState();
          track(EVENTS.checkoutCompleted, { local_id: state.localId, mode: state.answers.mode });
          window.location.href = "/start-success";
        }

        function handleCheckoutError(e) {
          showError((e && e.message) || c.genericError);
          pay.textContent = confirmLabel();
          refreshButton();
          track(EVENTS.checkoutFailed, { reason: "confirm_error" });
        }

        pay.addEventListener("click", function () {
          if (!(mounted || alreadyActive)) return;
          pay.disabled = true;
          pay.textContent = c.processingCta;
          err.hidden = true;

          var subscriptionConfirmed = alreadyActive
            ? Promise.resolve()
            : stripeClient.confirmPayment({
                elements: elements,
                confirmParams: { return_url: window.location.origin + "/start-success" },
                redirect: "if_required"
              }).then(function (result) {
                if (result.error) throw result.error;
              });

          subscriptionConfirmed
            .then(finishCheckout)
            .catch(handleCheckoutError);
        });
      },
      canAdvance: function () { return false; }, // own pay button drives navigation
      onEnter: function () {
        if (state.answers.checkout_status !== "started") state.answers.checkout_status = "viewed";
        track(EVENTS.checkoutViewed, { local_id: state.localId });
        syncLead();
      }
    }
  };

  /* ---------------- small render helpers ---------------- */

  function pillOption(name, value, label, active) {
    return '<button type="button" class="answer-card' + (active ? " is-active" : "") +
      '" data-value="' + value + '" data-name="' + name + '">' +
      '<span class="answer-card__label">' + label + '</span>' +
      '<span class="answer-card__indicator" aria-hidden="true"></span>' +
      '</button>';
  }

  function pillOptionWithSub(name, value, label, sub, active) {
    return '<button type="button" class="answer-card' + (active ? " is-active" : "") +
      '" data-value="' + value + '" data-name="' + name + '">' +
      '<span class="answer-card__label">' + label + (sub ? ('<br><span style="font-weight:400;color:var(--ink-soft);font-size:.82em">' + escapeAttr(sub) + '</span>') : '') + '</span>' +
      '<span class="answer-card__indicator" aria-hidden="true"></span>' +
      '</button>';
  }

  /* ---------------- flow control ---------------- */

  function currentStepId() { return STEP_IDS[state.stepIndex]; }

  function isSkipped(index) {
    var step = steps[STEP_IDS[index]];
    return !!(step && step.skip && step.skip(state.answers));
  }

  function refreshContinue() {
    var step = steps[currentStepId()];
    continueBtn.disabled = !step.canAdvance(state.answers);
  }

  var pendingAdvanceTimer = null;
  function autoAdvance() {
    refreshContinue();
    clearTimeout(pendingAdvanceTimer);
    if (steps[currentStepId()].canAdvance(state.answers)) {
      pendingAdvanceTimer = setTimeout(function () { goNext(); }, 220);
    }
  }

  function renderStep(trackView) {
    clearTimeout(pendingAdvanceTimer);
    var id = currentStepId();
    var step = steps[id];
    screenEl.innerHTML = step.render(state.answers);
    step.bind(screenEl);
    screenEl.className = "card";
    void screenEl.offsetWidth;
    screenEl.classList.add("card--enter");
    flownavEl.classList.toggle("flownav--tight", step.flownavVariant === "tight");
    introHeaderEl.hidden = id !== "goal";
    progressFill.style.width = Math.round(((state.stepIndex + 1) / STEP_IDS.length) * 100) + "%";
    progressLabel.textContent = (id === "goal") ? COPY.firstStepProgressLabel : "Step " + (state.stepIndex + 1);
    backBtn.hidden = state.stepIndex === 0;
    var isCheckout = id === "checkout";
    var hideNav = isCheckout || step.hideNav;
    continueBtn.hidden = hideNav || step.hideContinue;
    skipBtn.hidden = true; // no optional/skippable questions in this funnel
    if (step.hideNav) backBtn.hidden = true;
    if (!hideNav) {
      continueBtn.textContent = step.continueLabel ? step.continueLabel(state.answers) : COPY.continueLabel;
      refreshContinue();
    }
    if (trackView !== false) {
      track(EVENTS.stepViewed, { step: id, step_index: state.stepIndex });
      if (step.onEnter) step.onEnter(state.answers);
    }
    saveState();
  }

  function goNext() {
    var id = currentStepId();
    var step = steps[id];
    if (!step.canAdvance(state.answers)) return;
    track(EVENTS.stepCompleted, { step: id, step_index: state.stepIndex });
    if (step.onLeave) step.onLeave(state.answers);
    syncLead();
    var next = state.stepIndex;
    while (next < STEP_IDS.length - 1) {
      next++;
      if (!isSkipped(next)) break;
    }
    if (next !== state.stepIndex || !isSkipped(next)) {
      state.stepIndex = Math.min(next, STEP_IDS.length - 1);
      resumeBanner.hidden = true;
      renderStep();
    }
  }

  function goBack() {
    var prev = state.stepIndex;
    while (prev > 0) {
      prev--;
      if (!isSkipped(prev)) break;
    }
    if (prev !== state.stepIndex) {
      state.stepIndex = prev;
      resumeBanner.hidden = true;
      renderStep();
    }
  }

  var dropoffFired = false;
  function maybeFireDropoff() {
    if (dropoffFired) return;
    if (state.answers.checkout_status === "completed_unverified") return;
    if (!state.onboardingStarted) return;
    dropoffFired = true;
    track(EVENTS.dropoff, { step: currentStepId(), step_index: state.stepIndex });
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) maybeFireDropoff(); });
  window.addEventListener("pagehide", maybeFireDropoff);

  /* ---------------- feature flag gate ---------------- */

  function getQueryParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  }

  function previewOverrideActive() {
    var p = getQueryParam("preview");
    if (p === "1") { try { localStorage.setItem(WS.PREVIEW_STORAGE_KEY, "1"); } catch (e) {} }
    if (p === "0") { try { localStorage.removeItem(WS.PREVIEW_STORAGE_KEY); } catch (e) {} }
    try { return localStorage.getItem(WS.PREVIEW_STORAGE_KEY) === "1"; } catch (e) { return false; }
  }

  function showGate() {
    loadingEl.hidden = true;
    gateEl.hidden = false;
    gateEl.innerHTML = '<h1 class="q-title">' + COPY.gate.title + '</h1>' +
      '<p class="q-body">' + COPY.gate.body + '</p>' +
      '<a class="btn btn--ink" href="/">' + COPY.gate.cta + '</a>';
  }

  function showGeoGate() {
    loadingEl.hidden = true;
    gateEl.hidden = false;
    gateEl.innerHTML = '<h1 class="q-title">' + COPY.geoGate.title + '</h1>' +
      '<p class="q-body">' + COPY.geoGate.body + '</p>' +
      '<a class="btn btn--ink" href="/">' + COPY.geoGate.cta + '</a>';
  }

  /* Vercel's middleware.js sets this from its own edge geolocation on every
     /start request. Empty if middleware didn't run (e.g. local dev without
     `vercel dev`), in which case the gate below fails OPEN. */
  function geoBlocked() {
    var country = getCookie("walka_geo_country");
    state.answers.country = country || state.answers.country || null;
    if (!country) return false; // unknown: let through, log as unknown
    return WS.GEO_ALLOWED_COUNTRIES.indexOf(country) === -1;
  }

  function startFlow() {
    loadingEl.hidden = true;
    state.onboardingStarted = true;
    track(EVENTS.onboardingStart, { local_id: state.localId });
    saveState();
    mainEl.hidden = false;
    appEl.hidden = false;
    exitLink.hidden = false;
    if (state.stepIndex > 0) {
      resumeBanner.hidden = false;
      resumeBannerText.textContent = COPY.resumeBanner;
    }
    renderStep();
  }

  function initGate() {
    /* Always resolves + records state.answers.country as a side effect
       (used for checkout currency and analytics), even in preview mode --
       only the BLOCKING behavior below is skipped for preview, same as
       the feature-flag gate. Without this, a QA tester using ?preview=1
       would never see CAD pricing regardless of their real location,
       since country would stay unset. */
    var blocked = geoBlocked();

    if (previewOverrideActive()) { startFlow(); return; }

    if (blocked) {
      track(EVENTS.geoBlocked, { country: state.answers.country });
      syncLead({ last_step: "geo_blocked" });
      showGeoGate();
      return;
    }

    if (WS.FORCE_FLOW_ENABLED) { startFlow(); return; }
    if (!window.posthog) { showGate(); return; }

    var settled = false;
    var timer = setTimeout(function () { if (!settled) { settled = true; showGate(); } }, WS.POSTHOG_FLAG_TIMEOUT_MS);

    posthog.onFeatureFlags(function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (posthog.isFeatureEnabled(WS.FEATURE_FLAG_KEY)) startFlow(); else showGate();
    });
  }

  /* ---------------- boot ---------------- */

  document.addEventListener("DOMContentLoaded", function () {
    screenEl = document.getElementById("screen");
    continueBtn = document.getElementById("continueBtn");
    backBtn = document.getElementById("backBtn");
    skipBtn = document.getElementById("skipBtn");
    progressFill = document.getElementById("progressFill");
    progressLabel = document.getElementById("progressLabel");
    resumeBanner = document.getElementById("resumeBanner");
    resumeBannerText = document.getElementById("resumeBannerText");
    resumeBannerDismiss = document.getElementById("resumeBannerDismiss");
    gateEl = document.getElementById("gate");
    appEl = document.getElementById("app");
    loadingEl = document.getElementById("loading");
    mainEl = document.getElementById("top");
    exitLink = document.getElementById("exitLink");
    flownavEl = document.querySelector(".flownav");
    introHeaderEl = document.getElementById("introHeader");

    continueBtn.addEventListener("click", function () { goNext(); });
    backBtn.addEventListener("click", goBack);
    resumeBannerDismiss.addEventListener("click", function () { resumeBanner.hidden = true; });

    introHeaderEl.innerHTML =
      '<h1 class="intro-header__title">' + COPY.introHeader.title + '</h1>' +
      '<p class="intro-header__body">' + COPY.introHeader.body + '</p>' +
      '<div class="intro-header__features">' +
        COPY.introHeader.features.map(function (f) {
          return '<span class="intro-header__feature"><span aria-hidden="true">' + f.icon + '</span> ' + escapeAttr(f.label) + '</span>';
        }).join("") +
      '</div>';

    maybeRehydrateFromLink().then(function () { initGate(); });
  });
})();
