/* ==========================================================================
   Walka Mom: onboarding flow, ENGINE
   Step state machine, feature-flag gate, resume-from-localStorage,
   analytics events, Supabase sync, Stripe Payment Link handoff.
   All copy/config lives in moms-copy.js, this file should not contain
   user-facing strings.
   ========================================================================== */
(function () {
  "use strict";

  var WM = window.WALKA_MOMS;
  var COPY = WM.COPY;
  var EVENTS = WM.EVENTS;
  /* v3: bumped for the empathetic-funnel/membership redesign, which
     replaced the step sequence wholesale (new steps inserted/removed/
     reordered throughout, not just a couple added in the middle). A saved
     numeric stepIndex from before this change would resume into a
     completely different step than the one the visitor left, so stale
     state must be discarded rather than resumed. moms-success.html reads
     the same key and must be bumped in lockstep. */
  var STORAGE_KEY = "walka_moms_state_v3";
  var STEP_IDS = [
    "stage", "motivation", "barriers", "interludeCare", "connection", "conversations",
    "interludeCommunity", "baseline", "clearance", "results", "trustPreview", "checkout"
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
      if (window.posthog && window.posthog.capture) {
        window.posthog.capture(event, props || {});
      }
    } catch (e) { /* analytics should never break the flow */ }
  }

  function el(html) {
    var t = document.createElement("template");
    t.innerHTML = html.trim();
    return t.content.firstChild;
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
  if (window.supabase && WM.SUPABASE_URL.indexOf("REPLACE_ME") === -1 && WM.SUPABASE_ANON_KEY.indexOf("REPLACE_ME") === -1) {
    try { sbClient = window.supabase.createClient(WM.SUPABASE_URL, WM.SUPABASE_ANON_KEY); } catch (e) { sbClient = null; }
  } else {
    console.warn("[moms-flow] Supabase URL/key not configured yet. Onboarding answers will only be captured via PostHog until moms-copy.js is filled in.");
  }

  function syncLead(extra) {
    if (!sbClient) return;
    var a = state.answers;
    var row = Object.assign({
      local_id: state.localId,
      updated_at: new Date().toISOString(),
      country: a.country || null,
      stage: a.stage || null,
      motherhood_stage: a.motherhood_stage || null,
      weeks_postpartum: (a.weeks_postpartum != null && a.weeks_postpartum !== "") ? Number(a.weeks_postpartum) : null,
      due_date: a.due_date || null,
      clearance_status: a.clearance_status || null,
      prepare_mode: a.clearance_status ? a.clearance_status !== "yes" : null,
      routine_preference: a.routine_preference || null,
      activity_baseline: a.activity_baseline || null,
      barriers: (a.barriers && a.barriers.length) ? a.barriers : null,
      motivation_wants: (a.motivation_wants && a.motivation_wants.length) ? a.motivation_wants : null,
      motivation_style: null, // tone picker retired; see supabase/moms_leads.sql
      connection: a.connection || null,
      conversations_openness: a.conversations_openness || null,
      cohort: a.cohort || null,
      plan_price_cents: WM.PLAN_PRICE_CENTS,
      billing_interval: WM.BILLING_INTERVAL,
      email: a.email || null,
      first_name: a.first_name || null,
      last_step: STEP_IDS[state.stepIndex] || null,
      checkout_status: a.checkout_status || "not_started"
    }, extra || {});

    sbClient.from(WM.SUPABASE_TABLE).upsert(row, { onConflict: "local_id" })
      .then(function (res) { if (res.error) console.warn("[moms-flow] supabase upsert error", res.error); })
      .catch(function (err) { console.warn("[moms-flow] supabase upsert failed", err); });
  }

  /* Auto-placement into a small walking circle, read-only (no screen of
     its own — the assignment surfaces as one line on the `results` step).
     Falls back to the earliest postpartum group if motherhood_stage is
     somehow unset, so placement never leaves a member unassigned. */
  function resolvedCohortFor(a) {
    switch (a.motherhood_stage) {
      case "pregnant": return "due_soon";
      case "postpartum_0_3": return "0_3m";
      case "postpartum_3_6": return "3_6m";
      case "postpartum_6_12": return "6_12m";
      case "postpartum_12_plus": return "12m_plus";
      default: return "0_3m";
    }
  }

  /* `results` step personalization: three fixed cards (circle/community/
     routine) plus an optional diary mention plus an intro sentence, each
     resolved deterministically against the member's actual answers from
     moms-copy.js's RESULTS_COPY. Plain lookups/if-else, no scoring —
     every branch is traceable to one specific answer. Reused as-is by
     `checkout`'s "what's included" list via resultsCards()/
     resultsDiaryCard(), so both screens agree. */

  function isRecovering(a) {
    return a.routine_preference === "not_ready" || a.clearance_status === "not_yet";
  }

  function resultsCircleCard(a) {
    var c = WM.RESULTS_COPY.circle;
    var body = c.byStage[a.motherhood_stage] || c.fallback;
    var reason = c.byStage[a.motherhood_stage] ? ("stage:" + a.motherhood_stage) : "fallback";
    if (isRecovering(a)) body += " " + c.recoveringNote;
    return { title: c.title, icon: c.icon, body: body, reason: reason };
  }

  function resultsCommunityCard(a) {
    var c = WM.RESULTS_COPY.community;
    var wants = a.motivation_wants || [];
    var body, reason;
    if (wants.indexOf("other_moms") !== -1) {
      body = c.wantsOtherMoms; reason = "wants:other_moms";
    } else if (["want_more", "sometimes_alone", "few_not_close"].indexOf(a.connection) !== -1) {
      body = c.disconnected; reason = "connection:" + a.connection;
    } else {
      body = c.fallback; reason = "fallback";
    }
    if (a.conversations_openness === "prefer_read") body += " " + c.preferReadNote;
    return { title: c.title, icon: c.icon, body: body, reason: reason };
  }

  function resultsRoutineCard(a) {
    var c = WM.RESULTS_COPY.routine;
    var body = c.byPreference[a.routine_preference] || c.fallback;
    var reason = c.byPreference[a.routine_preference] ? ("routine:" + a.routine_preference) : "fallback";
    var wants = a.motivation_wants || [];
    if (wants.indexOf("reason_outside") !== -1 && a.routine_preference !== "not_ready") body += " " + c.outsideNote;
    return { title: c.title, icon: c.icon, body: body, reason: reason };
  }

  /* Optional secondary feature: returns null (render nothing) unless a
     specific answer actually points to it. Never a default filler. */
  function resultsDiaryCard(a) {
    var wants = a.motivation_wants || [];
    var show = wants.indexOf("encouragement") !== -1 || wants.indexOf("time_my_own") !== -1
      || a.conversations_openness === "prefer_read" || a.conversations_openness === "not_really";
    if (!show) return null;
    var c = WM.RESULTS_COPY.diary;
    return { title: c.title, body: c.body };
  }

  function resultsIntroSentence(a) {
    var c = WM.RESULTS_COPY;
    var wants = a.motivation_wants || [];
    for (var i = 0; i < c.introWantPriority.length; i++) {
      var w = c.introWantPriority[i];
      if (wants.indexOf(w) !== -1) return c.introByWant[w];
    }
    return c.introDefault;
  }

  function resultsCards(a) {
    return [resultsCircleCard(a), resultsCommunityCard(a), resultsRoutineCard(a)];
  }

  /* ---------------- DOM refs ---------------- */

  var screenEl, continueBtn, backBtn, skipBtn, progressFill, progressLabel, resumeBanner, gateEl, landingEl, appEl, loadingEl, mainEl, exitLink;

  /* ---------------- step definitions ---------------- */
  /* Each step: render() -> HTML string, bind(root) attach listeners,
     canAdvance() -> bool, onEnter() optional, onLeave() optional
     (validate+persist). A step may also set optional:true (shows a
     "Skip for now" link that bypasses canAdvance) and continueLabel(a)
     (overrides the shared continue button's default text). */

  var steps = {

    /* Screen 1 */
    stage: {
      render: function (a) {
        var opts = COPY.steps.stage.options.map(function (o) {
          return pillOption("stage_value", o.value, o.label, a.motherhood_stage === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.stage.title + '</h2>' +
          '<div class="opts" id="stageOpts">' + opts + '</div>' +
          '<div id="stageFollowup">' + stageFollowupHTML(a) + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#stageOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            var v = b.getAttribute("data-value");
            state.answers.motherhood_stage = v;
            state.answers.stage = (v === "pregnant") ? "pregnant" : "postpartum";
            root.querySelectorAll('#stageOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            root.querySelector("#stageFollowup").innerHTML = stageFollowupHTML(state.answers);
            bindStageFollowup(root);
            refreshContinue();
          });
        });
        bindStageFollowup(root);
      },
      canAdvance: function (a) { return !!a.motherhood_stage; }
    },

    /* Screen 2, multi-select, skippable */
    motivation: {
      optional: true,
      render: function (a) {
        var c = COPY.steps.motivation;
        var opts = c.options.map(function (o) {
          return pillOption("motivation_value", o.value, o.label, (a.motivation_wants || []).indexOf(o.value) !== -1, true);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-hint">' + c.hint + '</p>' +
          '<div class="opts" id="motivationOpts">' + opts + '</div>';
      },
      bind: function (root) { bindMultiSelect(root, "#motivationOpts", "motivation_wants", null); },
      canAdvance: function (a) { return (a.motivation_wants || []).length > 0; },
      onLeave: function (a) { track(EVENTS.motivationAnswered, { values: a.motivation_wants || [] }); }
    },

    /* Screen 3, multi-select, skippable */
    barriers: {
      optional: true,
      render: function (a) {
        var c = COPY.steps.barriers;
        var opts = c.options.map(function (o) {
          return pillOption("barrier_value", o.value, o.label, (a.barriers || []).indexOf(o.value) !== -1, true);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-hint">' + c.hint + '</p>' +
          '<div class="opts" id="barriersOpts">' + opts + '</div>';
      },
      bind: function (root) { bindMultiSelect(root, "#barriersOpts", "barriers", COPY.steps.barriers.exclusiveValues); },
      canAdvance: function (a) { return (a.barriers || []).length > 0; }
    },

    /* Screen 4, interlude */
    interludeCare: makeInsightStep("interludeCare"),

    /* Screen 5, skippable */
    connection: {
      optional: true,
      render: function (a) {
        var opts = COPY.steps.connection.options.map(function (o) {
          return pillOption("connection_value", o.value, o.label, a.connection === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.connection.title + '</h2>' +
          '<div class="opts" id="connectionOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#connectionOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.connection = b.getAttribute("data-value");
            root.querySelectorAll('#connectionOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.connection; }
    },

    /* Screen 6, skippable */
    conversations: {
      optional: true,
      render: function (a) {
        var opts = COPY.steps.conversations.options.map(function (o) {
          return pillOption("conversations_value", o.value, o.label, a.conversations_openness === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.conversations.title + '</h2>' +
          '<div class="opts" id="conversationsOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#conversationsOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.conversations_openness = b.getAttribute("data-value");
            root.querySelectorAll('#conversationsOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.conversations_openness; }
    },

    /* Screen 7, interlude */
    interludeCommunity: makeInsightStep("interludeCommunity"),

    /* Screen 8 */
    baseline: {
      render: function (a) {
        var opts = COPY.steps.baseline.options.map(function (o) {
          return pillOption("baseline_value", o.value, o.label, a.activity_baseline === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.baseline.title + '</h2>' +
          '<div class="opts" id="baselineOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#baselineOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.activity_baseline = b.getAttribute("data-value");
            root.querySelectorAll('#baselineOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.activity_baseline; }
    },

    /* Screen 9: part A (optional, non-blocking safety question) + part B
       (routine preference, required). Worded so it never reads as medical
       clearance, per the brief. */
    clearance: {
      render: function (a) {
        var c = COPY.steps.clearance;
        var opts = c.options.map(function (o) {
          return pillOption("clearance_value", o.value, o.label, a.clearance_status === o.value);
        }).join("");
        var note = (a.clearance_status && a.clearance_status !== "yes")
          ? '<p class="q-note">' + c.notClearedNote + '</p>' : "";
        var routineOpts = c.routineOptions.map(function (o) {
          return pillOption("routine_value", o.value, o.label, a.routine_preference === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<div class="opts" id="clearanceOpts">' + opts + '</div>' +
          '<div id="clearanceNote">' + note + '</div>' +
          '<p class="q-disclaimer">' + c.medicalReminder + '</p>' +
          '<p class="q-label">' + c.routineTitle + '</p>' +
          '<div class="opts" id="routineOpts">' + routineOpts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#clearanceOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.clearance_status = b.getAttribute("data-value");
            root.querySelectorAll('#clearanceOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            root.querySelector("#clearanceNote").innerHTML = state.answers.clearance_status !== "yes"
              ? '<p class="q-note">' + COPY.steps.clearance.notClearedNote + '</p>' : "";
            track(EVENTS.clearanceAnswered, { value: state.answers.clearance_status });
          });
        });
        root.querySelectorAll('#routineOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.routine_preference = b.getAttribute("data-value");
            root.querySelectorAll('#routineOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.routine_preference; }
    },

    /* Screen 10, personalized results */
    results: {
      render: function (a) {
        var c = COPY.steps.results;
        a.cohort = resolvedCohortFor(a); // still stored/synced for real matching later; not displayed as confirmed
        var cards = resultsCards(a);
        var diary = resultsDiaryCard(a);
        return '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + resultsIntroSentence(a) + '</p>' +
          '<div class="benefits">' + cards.map(benefitCardHTML).join("") + '</div>' +
          (diary ? '<div class="q-note"><strong>' + diary.title + '</strong><br>' + diary.body + '</div>' : '') +
          '<p class="q-hint">' + c.note + '</p>';
      },
      bind: function () {},
      canAdvance: function () { return true; },
      continueLabel: function () { return WM.RESULTS_COPY.continueLabel; },
      onEnter: function (a) {
        track(EVENTS.cohortChosen, { cohort: a.cohort });
        var cards = resultsCards(a);
        track(EVENTS.resultsViewed, {
          circle_reason: cards[0].reason,
          community_reason: cards[1].reason,
          routine_reason: cards[2].reason,
          diary_shown: !!resultsDiaryCard(a)
        });
      }
    },

    /* Screen 11, trust / community preview */
    trustPreview: {
      render: function (a) {
        var c = COPY.steps.trustPreview;
        return '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          renderCirclePreview(c);
      },
      bind: function () {},
      canAdvance: function () { return true; }
    },

    /* Screen 12 */
    checkout: {
      render: function (a) {
        var c = COPY.steps.checkout;
        var cards = resultsCards(a);
        var diary = resultsDiaryCard(a);
        var includedTitles = cards.map(function (b) { return b.title; });
        if (diary) includedTitles.push(diary.title);
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="price-tag">' + centsLabel(WM.PLAN_PRICE_CENTS) + '/' + WM.BILLING_INTERVAL + '</div>' +
          '<p class="q-hint">' + c.billingNote + '</p>' +
          '<p class="q-label">' + c.includedLabel + '</p>' +
          '<div class="recap"><ul class="recap__list">' +
            includedTitles.map(function (t) { return '<li>' + t + '</li>'; }).join("") +
          '</ul></div>' +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="firstName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="email" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<label class="checkline"><input type="checkbox" id="agreeCheck"> ' + c.agreePrefix +
            ' <a href="' + c.legalLinks.terms + '" target="_blank" rel="noopener">' + c.agreeTermsText + '</a> ' + c.agreeJoiner +
            ' <a href="' + c.legalLinks.privacy + '" target="_blank" rel="noopener">' + c.agreePrivacyText + '</a></label>' +
          '<p class="q-disclaimer">' + COPY.disclaimer + '</p>' +
          (WM.STRIPE_MODE === "test" ? '<p class="q-note">' + c.testModeNote + '</p>' : '') +
          '<button type="button" class="btn btn--ink" id="payBtn" style="width:100%;margin-top:8px" disabled>' + c.payCta + '</button>' +
          '<p class="q-error" id="checkoutError" hidden></p>';
      },
      bind: function (root) {
        var name = root.querySelector("#firstName"), email = root.querySelector("#email");
        var agree = root.querySelector("#agreeCheck"), pay = root.querySelector("#payBtn"), err = root.querySelector("#checkoutError");

        function validate() {
          var valid = agree.checked && /\S+@\S+\.\S+/.test(email.value.trim());
          pay.disabled = !valid;
          return valid;
        }
        name.addEventListener("input", function () { state.answers.first_name = name.value; });
        email.addEventListener("input", function () { state.answers.email = email.value; validate(); });
        agree.addEventListener("change", validate);

        pay.addEventListener("click", function () {
          if (!validate()) return;

          var link = WM.MEMBERSHIP_PAYMENT_LINK[WM.STRIPE_MODE];
          if (!link || link.indexOf("REPLACE_ME") !== -1) {
            err.textContent = "Payment link isn't configured yet. Add it to moms-copy.js.";
            err.hidden = false;
            track(EVENTS.checkoutFailed, { reason: "missing_payment_link" });
            return;
          }
          state.answers.checkout_status = "started";
          saveState();
          track(EVENTS.checkoutStarted, { local_id: state.localId, plan_price_cents: WM.PLAN_PRICE_CENTS });
          syncLead();

          var url = link + "?client_reference_id=" + encodeURIComponent(state.localId) +
            "&prefilled_email=" + encodeURIComponent(email.value.trim());
          window.location.href = url;
        });
      },
      canAdvance: function () { return false; }, // own pay button drives navigation
      onEnter: function (a) {
        if (a.checkout_status !== "started") a.checkout_status = "viewed";
        track(EVENTS.checkoutViewed, { local_id: state.localId });
        syncLead();
      }
    }
  };

  /* ---------------- interlude steps ---------------- */
  /* Read-only "why this matters" screens, inserted between relevant
     questions. No input required, so canAdvance is always true; the
     shared continueBtn falls back to COPY.continueLabel since these
     don't need their own CTA copy. */

  /* Small decorative SVGs, deliberately only for the two interludes — every
     other screen already has either interactive pills or real visual
     content (benefit-card icons, the circle preview, the price tag), so
     adding art there would be redundant, not a fix for repetition. Kept
     abstract/geometric and limited to 2-3 existing palette colors each,
     no gradients. */
  var INTERLUDE_ART = {
    interludeCare:
      '<svg viewBox="0 0 96 96" width="72" height="72" role="img" aria-hidden="true">' +
        '<circle cx="48" cy="48" r="40" fill="var(--sage-tint)"/>' +
        '<path d="M26 54c6-14 20-22 34-16" stroke="var(--sage)" stroke-width="4" stroke-linecap="round" fill="none"/>' +
        '<circle cx="62" cy="32" r="5" fill="var(--sage)"/>' +
      '</svg>',
    interludeCommunity:
      '<svg viewBox="0 0 96 96" width="72" height="72" role="img" aria-hidden="true">' +
        '<circle cx="48" cy="28" r="15" fill="var(--rose-tint)" stroke="var(--rose-ink)" stroke-width="2"/>' +
        '<circle cx="28" cy="58" r="15" fill="var(--lavender)" stroke="var(--lavender-ink)" stroke-width="2"/>' +
        '<circle cx="68" cy="58" r="15" fill="var(--sage-tint)" stroke="var(--sage)" stroke-width="2"/>' +
      '</svg>'
  };

  function makeInsightStep(key) {
    return {
      render: function () {
        var c = COPY.steps[key];
        var art = INTERLUDE_ART[key];
        return (art ? '<div class="interlude-illustration">' + art + '</div>' : "") +
          '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + c.title + '</h2>' +
          c.body.map(function (p) { return '<p class="q-body">' + p + '</p>'; }).join("");
      },
      bind: function () {},
      canAdvance: function () { return true; }
    };
  }

  /* ---------------- small render helpers ---------------- */

  function pillOption(name, value, label, active, multi) {
    return '<button type="button" class="pill' + (multi ? " pill--multi" : "") + (active ? " is-active" : "") +
      '" data-value="' + value + '" data-name="' + name + '">' +
      (multi ? '<span class="pill__check" aria-hidden="true"></span>' : "") + label + '</button>';
  }

  /* Toggles array membership in state.answers[fieldName] on click. Any
     value listed in exclusiveValues (e.g. "prefer_not_to_say") clears
     every other pick when chosen, and is itself cleared the moment a
     real option is picked. */
  function bindMultiSelect(root, containerSelector, fieldName, exclusiveValues) {
    root.querySelectorAll(containerSelector + " .pill").forEach(function (b) {
      b.addEventListener("click", function () {
        var v = b.getAttribute("data-value");
        var list = (state.answers[fieldName] || []).slice();
        var isExclusive = exclusiveValues && exclusiveValues.indexOf(v) !== -1;
        if (isExclusive) {
          list = (list.indexOf(v) !== -1) ? [] : [v];
        } else {
          if (exclusiveValues) list = list.filter(function (x) { return exclusiveValues.indexOf(x) === -1; });
          var idx = list.indexOf(v);
          if (idx === -1) list.push(v); else list.splice(idx, 1);
        }
        state.answers[fieldName] = list;
        root.querySelectorAll(containerSelector + " .pill").forEach(function (p) {
          p.classList.toggle("is-active", list.indexOf(p.getAttribute("data-value")) !== -1);
        });
        refreshContinue();
      });
    });
  }

  function benefitCardHTML(b) {
    return '<div class="benefit-card"><span class="benefit-card__icon" aria-hidden="true">' + b.icon + '</span>' +
      '<div><h3 class="benefit-card__title">' + b.title + '</h3>' +
      '<p class="benefit-card__body">' + b.body + '</p></div></div>';
  }

  var AVATAR_TINTS = ["sage", "lavender", "amber", "rose"];

  function initials(name) {
    return ((name || "").trim().charAt(0) || "?").toUpperCase();
  }

  function avatarHTML(name, index) {
    return '<span class="circle-avatar circle-avatar--' + AVATAR_TINTS[index % AVATAR_TINTS.length] + '" aria-hidden="true">' + initials(name) + '</span>';
  }

  /* Shared between the `trustPreview` step and the landing page's
     community section, so the "clearly labeled illustrative preview"
     the brief asks for is one implementation, not two different mocks.
     opts.compact (landing page use) trims to 2 messages and drops the
     challenge card / participation row, so the marketing page stays lean. */
  function renderCirclePreview(data, opts) {
    opts = opts || {};
    var messages = opts.compact ? data.messages.slice(0, 2) : data.messages;

    var avatarsHTML = messages.map(function (m, i) { return avatarHTML(m.name, i); }).join("");

    var messagesHTML = messages.map(function (m, i) {
      return '<div class="chat-message">' + avatarHTML(m.name, i) +
        '<div class="chat-message__bubble">' +
          '<div class="chat-message__meta"><span class="chat-message__name">' + escapeAttr(m.name) + '</span>' +
          (m.time ? '<span class="chat-message__time">' + escapeAttr(m.time) + '</span>' : '') + '</div>' +
          '<p class="chat-message__text">' + escapeAttr(m.text) + '</p>' +
        '</div></div>';
    }).join("");

    var challengeHTML = (!opts.compact && data.challenge) ?
      '<div class="challenge-card"><span class="challenge-card__icon" aria-hidden="true">' + data.challenge.icon + '</span>' +
        '<div><p class="challenge-card__title">' + data.challenge.title + '</p>' +
        '<p class="challenge-card__body">' + data.challenge.body + '</p></div></div>' : "";

    var participationHTML = (!opts.compact && data.participation) ?
      '<div class="participation-row">' +
        data.participation.map(function (p) { return '<span class="participation-chip">' + escapeAttr(p) + '</span>'; }).join("") +
      '</div>' : "";

    return '<div class="circle-preview">' +
      '<span class="badge badge--illustrative">' + escapeAttr(data.illustrativeBadge) + '</span>' +
      '<div class="circle-preview__header">' +
        '<span class="circle-preview__name">' + escapeAttr(data.circleName) + '</span>' +
        '<span class="circle-preview__avatars">' + avatarsHTML + '</span>' +
      '</div>' +
      messagesHTML + challengeHTML + participationHTML +
      '</div>';
  }

  function centsLabel(cents) {
    return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
  }

  function stageFollowupHTML(a) {
    if (!a.stage) return "";
    var s = COPY.steps.stage;
    var html = "";
    if (a.stage === "postpartum") {
      html += '<label class="field"><span>' + s.weeksLabel + '</span><input type="number" min="0" max="104" id="weeksInput" value="' + escapeAttr(a.weeks_postpartum || "") + '"></label>';
    } else if (a.stage === "pregnant") {
      html += '<label class="field"><span>' + s.dueDateLabel + '</span><input type="date" id="dueDateInput" value="' + escapeAttr(a.due_date || "") + '"></label>';
    }
    return html;
  }

  function bindStageFollowup(root) {
    var weeks = root.querySelector("#weeksInput");
    if (weeks) weeks.addEventListener("input", function () { state.answers.weeks_postpartum = weeks.value; });
    var due = root.querySelector("#dueDateInput");
    if (due) due.addEventListener("input", function () { state.answers.due_date = due.value; });
  }

  /* ---------------- flow control ---------------- */

  function currentStepId() { return STEP_IDS[state.stepIndex]; }

  function refreshContinue() {
    var step = steps[currentStepId()];
    continueBtn.disabled = !step.canAdvance(state.answers);
  }

  function renderStep(trackView) {
    var id = currentStepId();
    var step = steps[id];
    screenEl.innerHTML = step.render(state.answers);
    step.bind(screenEl);
    progressFill.style.width = Math.round(((state.stepIndex + 1) / STEP_IDS.length) * 100) + "%";
    progressLabel.textContent = "Step " + (state.stepIndex + 1) + " of " + STEP_IDS.length;
    backBtn.hidden = state.stepIndex === 0;
    var isCheckout = id === "checkout";
    continueBtn.hidden = isCheckout;
    skipBtn.hidden = isCheckout || !step.optional;
    if (!isCheckout) {
      continueBtn.textContent = step.continueLabel ? step.continueLabel(state.answers) : COPY.continueLabel;
      refreshContinue();
    }
    if (trackView !== false) {
      track(EVENTS.stepViewed, { step: id, step_index: state.stepIndex });
      if (step.onEnter) step.onEnter(state.answers);
    }
    saveState();
  }

  function goNext(force) {
    var id = currentStepId();
    var step = steps[id];
    var skipped = false;
    if (!step.canAdvance(state.answers)) {
      if (force && step.optional) { skipped = true; } else { return; }
    }
    track(EVENTS.stepCompleted, { step: id, step_index: state.stepIndex, skipped: skipped });
    if (step.onLeave) step.onLeave(state.answers);
    syncLead();
    if (state.stepIndex < STEP_IDS.length - 1) {
      state.stepIndex++;
      renderStep();
    }
  }

  function goBack() {
    if (state.stepIndex > 0) {
      state.stepIndex--;
      renderStep();
    }
  }

  /* drop-off: best-effort signal fired if the tab is hidden/closed before checkout completes */
  var dropoffFired = false;
  function maybeFireDropoff() {
    if (dropoffFired) return;
    if (state.answers.checkout_status === "completed") return;
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
    if (p === "1") { try { localStorage.setItem(WM.PREVIEW_STORAGE_KEY, "1"); } catch (e) {} }
    if (p === "0") { try { localStorage.removeItem(WM.PREVIEW_STORAGE_KEY); } catch (e) {} }
    try { return localStorage.getItem(WM.PREVIEW_STORAGE_KEY) === "1"; } catch (e) { return false; }
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
     /moms request. Empty if middleware didn't run (e.g. local dev without
     `vercel dev`), in which case the gate below fails OPEN. */
  function geoBlocked() {
    var country = getCookie("walka_geo_country");
    state.answers.country = country || state.answers.country || null;
    if (!country) return false; // unknown: let through, log as unknown
    return WM.GEO_ALLOWED_COUNTRIES.indexOf(country) === -1;
  }

  function observeReveals(root) {
    var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var els = root.querySelectorAll(".rv");
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(function (e) { e.classList.add("in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { threshold: 0.15 });
    els.forEach(function (e) { io.observe(e); });
  }

  function showLanding() {
    mainEl.hidden = true;
    landingEl.hidden = false;
    var L = COPY.landing;

    landingEl.innerHTML =
      '<section class="mhero"><div class="wrap mhero__grid">' +
        '<div>' +
          '<p class="eyebrow">' + L.eyebrow + '</p>' +
          '<h1>' + L.title + '</h1>' +
          '<p class="mhero__sub mhero__tagline">' + L.tagline + '</p>' +
          '<div class="mhero__ctas">' +
            '<button type="button" class="btn btn--ink" id="landingCta">' + L.cta + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="mhero__media">' +
          '<img src="' + escapeAttr(L.heroPhoto) + '" alt="A mum walking outside with a stroller">' +
        '</div>' +
      '</div></section>' +

      '<section class="mhow"><div class="wrap">' +
        '<div class="sec-head rv">' +
          '<p class="eyebrow">' + L.howEyebrow + '</p>' +
          '<h2>' + L.howTitle + '</h2>' +
        '</div>' +
        '<div class="msteps3">' +
          L.howSteps.map(function (s, i) {
            return '<div class="ms3 rv">' +
              '<div class="ms3__photo">' +
                '<img src="' + escapeAttr(s.photo) + '" alt="" ' +
                  'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
                '<span class="ms3__fallback">' + s.icon + '</span>' +
              '</div>' +
              '<div class="ms3__body">' +
                '<p class="ms3__step">Step ' + (i + 1) + '</p>' +
                '<h3>' + s.title + '</h3>' +
                '<p>' + s.desc + '</p>' +
              '</div>' +
            '</div>';
          }).join("") +
        '</div>' +
      '</div></section>' +

      '<section class="mcohort"><div class="wrap cohort-layout">' +
        '<div class="cohort-visual rv">' + renderCirclePreview(COPY.steps.trustPreview, { compact: true }) + '</div>' +
        '<div class="rv">' +
          '<p class="eyebrow">' + L.cohortEyebrow + '</p>' +
          '<h2>' + L.cohortTitle + '</h2>' +
          '<p class="q-body" style="margin:10px 0 18px">' + L.cohortBody + '</p>' +
          '<div class="cohort-chips">' +
            L.cohortGroups.map(function (g) {
              return '<span class="cohort-chip">' + g.caption + '</span>';
            }).join("") +
          '</div>' +
        '</div>' +
      '</div></section>';

    track(EVENTS.landingView, { local_id: state.localId });
    observeReveals(landingEl);

    document.getElementById("landingCta").addEventListener("click", function () {
      state.onboardingStarted = true;
      track(EVENTS.onboardingStart, { local_id: state.localId });
      saveState();
      landingEl.hidden = true;
      mainEl.hidden = false;
      appEl.hidden = false;
      exitLink.hidden = false;
      if (state.stepIndex > 0) {
        resumeBanner.hidden = false;
        resumeBanner.textContent = COPY.resumeBanner;
      }
      renderStep();
    });
  }

  function startFlow() {
    loadingEl.hidden = true;
    showLanding();
  }

  function initGate() {
    if (previewOverrideActive()) { startFlow(); return; }

    if (geoBlocked()) {
      track(EVENTS.geoBlocked, { country: state.answers.country });
      syncLead({ last_step: "geo_blocked" });
      showGeoGate();
      return;
    }
    syncLead({ last_step: "landing" });

    if (WM.FORCE_FLOW_ENABLED) { startFlow(); return; }

    if (!window.posthog) { showGate(); return; }

    var settled = false;
    var timer = setTimeout(function () { if (!settled) { settled = true; showGate(); } }, WM.POSTHOG_FLAG_TIMEOUT_MS);

    posthog.onFeatureFlags(function () {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (posthog.isFeatureEnabled(WM.FEATURE_FLAG_KEY)) startFlow(); else showGate();
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
    gateEl = document.getElementById("gate");
    landingEl = document.getElementById("landing");
    appEl = document.getElementById("app");
    loadingEl = document.getElementById("loading");
    mainEl = document.getElementById("top");
    exitLink = document.getElementById("exitLink");

    continueBtn.addEventListener("click", function () { goNext(); });
    skipBtn.addEventListener("click", function () { goNext(true); });
    backBtn.addEventListener("click", goBack);

    initGate();
  });
})();
