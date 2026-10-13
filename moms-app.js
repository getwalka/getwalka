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
      billing_currency: checkoutCurrency(a),
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

  /* `results` step personalization: a headline subtext, a walking-circle
     hero, a routine preview, and an optional diary mention, each resolved
     deterministically against the member's actual answers from
     moms-copy.js's RESULTS_COPY. Plain lookups/if-else, no scoring —
     every branch is traceable to one specific answer. Card titles are
     reused as-is by `checkout`'s "what's included" list via resultsCards()/
     resultsDiaryCard(), so both screens agree. The community preview
     (example chat messages) is static/illustrative, not personalized —
     the headline subtext above it already carries the "wants other moms"
     signal, so a second personalized variant here would be redundant. */

  function isRecovering(a) {
    return a.routine_preference === "not_ready" || a.clearance_status === "not_yet";
  }

  /* Reads the same grouping data COPY.cohort uses for resolvedCohortFor()'s
     return codes, for display on the results hero's "Finding your
     circle:" chip. */
  function cohortLabel(value) {
    var all = COPY.cohort.groupsPregnant.concat(COPY.cohort.groupsPostpartum);
    var match = all.filter(function (o) { return o.value === value; })[0];
    return match ? match.label : "";
  }

  function resultsHeadlineSubtext(a) {
    var c = WM.RESULTS_COPY;
    var wants = a.motivation_wants || [];
    var barriers = a.barriers || [];
    for (var i = 0; i < c.subtextPriority.length; i++) {
      var entry = c.subtextPriority[i];
      var source = entry.field === "barriers" ? barriers : wants;
      if (source.indexOf(entry.value) !== -1) return c.subtextByKey[entry.field + ":" + entry.value];
    }
    return c.subtextDefault;
  }

  function resultsCircleCard(a) {
    var c = WM.RESULTS_COPY.circle;
    var label = cohortLabel(a.cohort);
    var chip = label ? (c.chipPrefix + label) : c.genericChip;
    var body = c.explainer;
    if (isRecovering(a)) body += " " + c.recoveringNote;
    var reason = (c.byStage[a.motherhood_stage]) ? ("stage:" + a.motherhood_stage) : "fallback";
    return { title: c.title, chip: chip, body: body, reason: reason };
  }

  function resultsRoutineCard(a) {
    var c = WM.RESULTS_COPY.routine;
    var bullets = (c.byPreference[a.routine_preference] || c.fallback).slice();
    var reason = c.byPreference[a.routine_preference] ? ("routine:" + a.routine_preference) : "fallback";
    var wants = a.motivation_wants || [];
    if (wants.indexOf("reason_outside") !== -1 && a.routine_preference !== "not_ready") bullets.push(c.outsideNote);
    return { title: c.title, bullets: bullets, reason: reason };
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

  /* checkout's "what's included" list just needs three titles; the middle
     one (community) has no per-user variant to resolve, since the chat
     preview it's based on is static/illustrative. */
  function resultsCards(a) {
    return [resultsCircleCard(a), { title: WM.RESULTS_COPY.communityPreview.title }, resultsRoutineCard(a)];
  }

  /* ---------------- DOM refs ---------------- */

  var screenEl, continueBtn, backBtn, skipBtn, progressFill, progressLabel, resumeBanner, resumeBannerText, resumeBannerDismiss, gateEl, landingEl, appEl, loadingEl, mainEl, exitLink, shellEl, flownavEl;

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
          '<div class="answer-grid" id="stageOpts">' + opts + '</div>' +
          '<div id="stageFollowup">' + stageFollowupHTML(a) + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#stageOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            var v = b.getAttribute("data-value");
            state.answers.motherhood_stage = v;
            state.answers.stage = (v === "pregnant") ? "pregnant" : "postpartum";
            root.querySelectorAll('#stageOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
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
          '<div class="answer-grid" id="motivationOpts">' + opts + '</div>';
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
          '<div class="answer-grid" id="barriersOpts">' + opts + '</div>';
      },
      bind: function (root) { bindMultiSelect(root, "#barriersOpts", "barriers", COPY.steps.barriers.exclusiveValues); },
      canAdvance: function (a) { return (a.barriers || []).length > 0; }
    },

    /* Screen 4, interlude */
    interludeCare: makeInsightStep("interludeCare", "care"),

    /* Screen 5, skippable */
    connection: {
      optional: true,
      render: function (a) {
        var opts = COPY.steps.connection.options.map(function (o) {
          return pillOption("connection_value", o.value, o.label, a.connection === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.connection.title + '</h2>' +
          '<div class="answer-grid" id="connectionOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#connectionOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.connection = b.getAttribute("data-value");
            root.querySelectorAll('#connectionOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
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
          '<div class="answer-grid" id="conversationsOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#conversationsOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.conversations_openness = b.getAttribute("data-value");
            root.querySelectorAll('#conversationsOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.conversations_openness; }
    },

    /* Screen 7, interlude */
    interludeCommunity: makeInsightStep("interludeCommunity", "community"),

    /* Screen 8 */
    baseline: {
      render: function (a) {
        var opts = COPY.steps.baseline.options.map(function (o) {
          return pillOption("baseline_value", o.value, o.label, a.activity_baseline === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.baseline.title + '</h2>' +
          '<div class="answer-grid" id="baselineOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#baselineOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.activity_baseline = b.getAttribute("data-value");
            root.querySelectorAll('#baselineOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
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
          '<div class="answer-grid" id="clearanceOpts">' + opts + '</div>' +
          '<div id="clearanceNote">' + note + '</div>' +
          '<p class="q-disclaimer">' + c.medicalReminder + '</p>' +
          '<p class="q-label">' + c.routineTitle + '</p>' +
          '<div class="answer-grid" id="routineOpts">' + routineOpts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#clearanceOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.clearance_status = b.getAttribute("data-value");
            root.querySelectorAll('#clearanceOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            root.querySelector("#clearanceNote").innerHTML = state.answers.clearance_status !== "yes"
              ? '<p class="q-note">' + COPY.steps.clearance.notClearedNote + '</p>' : "";
            track(EVENTS.clearanceAnswered, { value: state.answers.clearance_status });
          });
        });
        root.querySelectorAll('#routineOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.routine_preference = b.getAttribute("data-value");
            root.querySelectorAll('#routineOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.routine_preference; }
    },

    /* Screen 10, personalized results — the richest screen in the funnel:
       a walking-circle hero, an illustrative community chat preview, a
       routine preview, and an optional diary strip. cardVariant is unset
       (plain .card), but shellVariant/flownavVariant widen the shell and
       tighten the CTA gap for this one step — see renderStep(). */
    results: {
      shellVariant: "wide",
      flownavVariant: "tight",
      render: function (a) {
        var c = COPY.steps.results;
        var rc = WM.RESULTS_COPY;
        a.cohort = resolvedCohortFor(a); // still stored/synced for real matching later; not displayed as confirmed
        var circle = resultsCircleCard(a);
        var routine = resultsRoutineCard(a);
        var diary = resultsDiaryCard(a);
        var cp = rc.communityPreview;

        return '<div class="stagger">' +
          '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + rc.title + '</h2>' +
          '<p class="q-body">' + resultsHeadlineSubtext(a) + '</p>' +

          '<div class="circle-hero">' +
            '<span class="circle-hero__blob" aria-hidden="true"></span>' +
            '<span class="circle-hero__chip">' + escapeAttr(circle.chip) + '</span>' +
            '<div class="circle-hero__avatars">' + heroAvatarsHTML() + '</div>' +
            '<h3 class="circle-hero__title">' + circle.title + '</h3>' +
            '<p class="circle-hero__body">' + circle.body + '</p>' +
          '</div>' +

          '<div class="results-grid">' +
            '<div class="mini-chat">' +
              '<span class="badge badge--illustrative">' + escapeAttr(cp.illustrativeBadge) + '</span>' +
              '<h3 class="q-label" style="margin-top:12px">' + cp.title + '</h3>' +
              cp.messages.map(function (m, i) {
                return '<div class="chat-message">' + avatarHTML(m.name, i) +
                  '<div class="chat-message__bubble">' +
                    '<div class="chat-message__meta"><span class="chat-message__name">' + escapeAttr(m.name) + '</span></div>' +
                    '<p class="chat-message__text">' + escapeAttr(m.text) + '</p>' +
                  '</div></div>';
              }).join("") +
            '</div>' +

            '<div class="routine-preview">' +
              '<h3 class="q-label" style="margin-top:0">' + routine.title + '</h3>' +
              '<div class="routine-preview__dots" aria-hidden="true">' + routineDotsHTML() + '</div>' +
              '<ul class="routine-preview__list">' + routine.bullets.map(function (b) { return '<li>' + b + '</li>'; }).join("") + '</ul>' +
            '</div>' +
          '</div>' +

          (diary ? '<div class="diary-strip"><span class="diary-strip__icon" aria-hidden="true">💛</span>' +
            '<p><strong>' + diary.title + '</strong> ' + diary.body + '</p></div>' : '') +

          '<p class="q-hint">' + c.note + '</p>' +
        '</div>';
      },
      bind: function () {},
      canAdvance: function () { return true; },
      continueLabel: function () { return WM.RESULTS_COPY.continueLabel; },
      onEnter: function (a) {
        track(EVENTS.cohortChosen, { cohort: a.cohort });
        var circle = resultsCircleCard(a);
        var routine = resultsRoutineCard(a);
        track(EVENTS.resultsViewed, {
          circle_reason: circle.reason,
          routine_reason: routine.reason,
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
        var currency = checkoutCurrency(a);
        var cards = resultsCards(a);
        var diary = resultsDiaryCard(a);
        var includedTitles = cards.map(function (b) { return b.title; });
        if (diary) includedTitles.push(diary.title);
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="price-tag">' + centsLabel(WM.PLAN_PRICE_CENTS) + ' ' + currency.toUpperCase() + '/' + WM.BILLING_INTERVAL + '</div>' +
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

          var currency = checkoutCurrency(state.answers);
          var link = WM.MEMBERSHIP_PAYMENT_LINK[WM.STRIPE_MODE][currency];
          if (!link || link.indexOf("REPLACE_ME") !== -1) {
            err.textContent = "Payment link isn't configured yet. Add it to moms-copy.js.";
            err.hidden = false;
            track(EVENTS.checkoutFailed, { reason: "missing_payment_link", currency: currency });
            return;
          }
          state.answers.checkout_status = "started";
          state.answers.billing_currency = currency;
          saveState();
          track(EVENTS.checkoutStarted, { local_id: state.localId, plan_price_cents: WM.PLAN_PRICE_CENTS, currency: currency });
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

  /* Larger, more composed original SVGs for the two reassurance screens —
     deliberately only these two (every other screen already has either
     interactive answer cards or real visual content: benefit-card icons,
     the circle preview, the price tag), so more art elsewhere would be
     redundant, not a fix for repetition. Still abstract/geometric, built
     only from existing palette variables, no gradients. Each card's own
     background is a solid tint (set via cardVariant below), so the
     illustration's backdrop shape uses --card (white) at partial opacity
     to read as a soft halo rather than disappearing into a matching fill. */
  var INTERLUDE_ART = {
    interludeCare:
      '<svg viewBox="0 0 160 160" width="140" height="140" role="img" aria-hidden="true">' +
        '<circle cx="80" cy="80" r="68" fill="var(--card)" opacity=".55"/>' +
        '<path d="M40 92c10-28 40-44 68-32" stroke="var(--sage)" stroke-width="5" stroke-linecap="round" fill="none"/>' +
        '<path d="M48 112c14-16 40-24 62-14" stroke="var(--sage-deep)" stroke-width="3" stroke-linecap="round" fill="none" opacity=".5"/>' +
        '<circle cx="112" cy="54" r="9" fill="var(--sage)"/>' +
        '<circle cx="54" cy="56" r="5" fill="var(--sage-deep)" opacity=".6"/>' +
      '</svg>',
    interludeCommunity:
      '<svg viewBox="0 0 160 160" width="140" height="140" role="img" aria-hidden="true">' +
        '<circle cx="80" cy="80" r="68" fill="var(--card)" opacity=".4"/>' +
        '<circle cx="80" cy="46" r="24" fill="var(--rose-tint)" stroke="var(--rose-ink)" stroke-width="2.5"/>' +
        '<circle cx="46" cy="98" r="24" fill="var(--lavender)" stroke="var(--lavender-ink)" stroke-width="2.5"/>' +
        '<circle cx="114" cy="98" r="24" fill="var(--sage-tint)" stroke="var(--sage)" stroke-width="2.5"/>' +
      '</svg>'
  };

  /* cardVariant tells renderStep() which .card--* modifier to apply to the
     shared #screen element (its class is reset fresh on every render, see
     renderStep() below) — the step's own render() only returns inner
     markup, it can't set classes on its own container. Passed explicitly
     by each call site rather than looked up, since makeInsightStep() is
     invoked while the `steps` object literal is still being built — a
     lookup table assigned later in this file wouldn't exist yet at that
     point (var hoisting only hoists the declaration, not the assignment). */
  function makeInsightStep(key, cardVariant) {
    return {
      cardVariant: cardVariant,
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
    return '<button type="button" class="answer-card' + (multi ? " answer-card--multi" : "") + (active ? " is-active" : "") +
      '" data-value="' + value + '" data-name="' + name + '">' +
      '<span class="answer-card__label">' + label + '</span>' +
      '<span class="answer-card__indicator" aria-hidden="true"></span>' +
      '</button>';
  }

  /* Toggles array membership in state.answers[fieldName] on click. Any
     value listed in exclusiveValues (e.g. "prefer_not_to_say") clears
     every other pick when chosen, and is itself cleared the moment a
     real option is picked. */
  function bindMultiSelect(root, containerSelector, fieldName, exclusiveValues) {
    root.querySelectorAll(containerSelector + " .answer-card").forEach(function (b) {
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
        root.querySelectorAll(containerSelector + " .answer-card").forEach(function (p) {
          p.classList.toggle("is-active", list.indexOf(p.getAttribute("data-value")) !== -1);
        });
        refreshContinue();
      });
    });
  }

  var AVATAR_TINTS = ["sage", "lavender", "amber", "rose"];

  function initials(name) {
    return ((name || "").trim().charAt(0) || "?").toUpperCase();
  }

  function avatarHTML(name, index) {
    return '<span class="circle-avatar circle-avatar--' + AVATAR_TINTS[index % AVATAR_TINTS.length] + '" aria-hidden="true">' + initials(name) + '</span>';
  }

  /* results step hero: unlabeled circles (no initials) — these represent
     future circle members in the abstract, not specific named people, so
     nothing is put inside one. Five falls within the brief's 4-6 range. */
  function heroAvatarsHTML() {
    var html = "";
    for (var i = 0; i < 5; i++) {
      html += '<span class="circle-hero__avatar circle-avatar--' + AVATAR_TINTS[i % AVATAR_TINTS.length] + '" aria-hidden="true"></span>';
    }
    return html;
  }

  /* Purely decorative "a flexible week" motif for the routine preview —
     not a real tracked-activity visualization (no real activity data
     exists pre-signup), so the pattern is fixed/illustrative, never
     derived from anything resembling real data. */
  function routineDotsHTML() {
    var pattern = [true, false, true, true, false, true, true];
    return pattern.map(function (filled) {
      return '<span class="routine-preview__dot' + (filled ? " is-filled" : "") + '" aria-hidden="true"></span>';
    }).join("");
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
    if (a.stage !== "pregnant") return "";
    var s = COPY.steps.stage;
    return '<label class="field"><span>' + s.dueDateLabel + '</span><input type="date" id="dueDateInput" value="' + escapeAttr(a.due_date || "") + '"></label>';
  }

  function bindStageFollowup(root) {
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
    screenEl.className = "card" + (step.cardVariant ? " card--reassurance card--" + step.cardVariant : "");
    void screenEl.offsetWidth; // force reflow so the entrance animation restarts on every step
    screenEl.classList.add("card--enter");
    shellEl.classList.toggle("shell--wide", step.shellVariant === "wide");
    flownavEl.classList.toggle("flownav--tight", step.flownavVariant === "tight");
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
      resumeBanner.hidden = true;
      renderStep();
    }
  }

  function goBack() {
    if (state.stepIndex > 0) {
      state.stepIndex--;
      resumeBanner.hidden = true;
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

  /* Same $39.99 numeral, charged in the visitor's own currency — not a
     converted equivalent, two separate Stripe prices. getwalka only ever
     serves US/CA (geoBlocked() above), so usd/cad are the only two cases;
     anything else (unknown country, local dev with no geo cookie) falls
     back to usd rather than leaving checkout without a price. */
  function checkoutCurrency(a) {
    return a.country === "CA" ? "cad" : "usd";
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
        resumeBannerText.textContent = COPY.resumeBanner;
      }
      renderStep();
    });
  }

  function startFlow() {
    loadingEl.hidden = true;
    showLanding();
  }

  function initGate() {
    /* Always resolves + records state.answers.country as a side effect
       (used for checkout currency and analytics), even in preview mode —
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
    resumeBannerText = document.getElementById("resumeBannerText");
    resumeBannerDismiss = document.getElementById("resumeBannerDismiss");
    gateEl = document.getElementById("gate");
    landingEl = document.getElementById("landing");
    appEl = document.getElementById("app");
    loadingEl = document.getElementById("loading");
    mainEl = document.getElementById("top");
    exitLink = document.getElementById("exitLink");
    shellEl = document.querySelector(".shell");
    flownavEl = document.querySelector(".flownav");

    continueBtn.addEventListener("click", function () { goNext(); });
    skipBtn.addEventListener("click", function () { goNext(true); });
    backBtn.addEventListener("click", goBack);
    resumeBannerDismiss.addEventListener("click", function () { resumeBanner.hidden = true; });

    initGate();
  });
})();
