/* ==========================================================================
   Walka: Postpartum Mums test flow, ENGINE
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
  var STORAGE_KEY = "walka_moms_state_v1";
  var STEP_IDS = ["stage", "clearance", "baseline", "insightActivity", "goal", "motivation", "insightCommunity", "cohort", "planPreview", "checkout"];

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

  function fmtTemplate(str, vars) {
    return str.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? vars[k] : ""; });
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
      weeks_postpartum: a.weeks_postpartum != null ? Number(a.weeks_postpartum) : null,
      due_date: a.due_date || null,
      clearance_status: a.clearance_status || null,
      prepare_mode: a.clearance_status ? a.clearance_status !== "yes" : null,
      current_steps_bucket: a.current_steps_bucket || null,
      energy_level: a.energy_level || null,
      barriers: a.barriers || null,
      adjusted_goal: a.adjusted_goal != null ? a.adjusted_goal : null,
      motivation_style: a.motivation_style || "princess",
      cohort: a.cohort || null,
      stake_cents: WM.COHORT_STAKE_AMOUNT_CENTS,
      miss_cents: a.clearance_status === "yes" ? WM.MISS_AMOUNT_CENTS_PER_DAY : null,
      entry_fee_cents: WM.ENTRY_FEE_CENTS,
      program_length_weeks: WM.PROGRAM_LENGTH_WEEKS,
      email: a.email || null,
      first_name: a.first_name || null,
      last_step: STEP_IDS[state.stepIndex] || null,
      checkout_status: a.checkout_status || "not_started"
    }, extra || {});

    sbClient.from(WM.SUPABASE_TABLE).upsert(row, { onConflict: "local_id" })
      .then(function (res) { if (res.error) console.warn("[moms-flow] supabase upsert error", res.error); })
      .catch(function (err) { console.warn("[moms-flow] supabase upsert failed", err); });
  }

  /* No longer user-pickable: the cohort step shows whichever of these the
     visitor is auto-placed into, read-only. Postpartum without a weeks
     answer (that field is optional) falls back to the earliest group
     rather than leaving nothing assigned. */
  function resolvedCohortFor(a) {
    if (a.stage === "pregnant") return "due_soon";
    var weeks = Number(a.weeks_postpartum);
    if (!weeks || isNaN(weeks)) return "0_3m";
    if (weeks <= 13) return "0_3m";
    if (weeks <= 26) return "3_6m";
    return "6_12m";
  }

  function tone() { return WM.TONE[state.answers.motivation_style || "princess"]; }

  /* ---------------- DOM refs ---------------- */

  var screenEl, continueBtn, backBtn, progressFill, resumeBanner, gateEl, landingEl, appEl, loadingEl, mainEl, exitLink;

  /* ---------------- step definitions ---------------- */
  /* Each step: render() -> HTML string, bind(root) attach listeners,
     canAdvance() -> bool, onEnter() optional, onLeave() optional (validate+persist) */

  var steps = {

    stage: {
      render: function (a) {
        var opts = COPY.steps.stage.options.map(function (o) {
          return pillOption("stage_value", o.value, o.label, a.stage === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.stage.title + '</h2>' +
          '<div class="opts" id="stageOpts">' + opts + '</div>' +
          '<div id="stageFollowup">' + stageFollowupHTML(a) + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#stageOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.stage = b.getAttribute("data-value");
            root.querySelectorAll('#stageOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            root.querySelector("#stageFollowup").innerHTML = stageFollowupHTML(state.answers);
            bindStageFollowup(root);
            refreshContinue();
          });
        });
        bindStageFollowup(root);
      },
      canAdvance: function (a) { return !!a.stage; }
    },

    clearance: {
      render: function (a) {
        var opts = COPY.steps.clearance.options.map(function (o) {
          return pillOption("clearance_value", o.value, o.label, a.clearance_status === o.value);
        }).join("");
        var note = (a.clearance_status && a.clearance_status !== "yes")
          ? '<p class="q-note">' + COPY.steps.clearance.notClearedNote + '</p>' : "";
        return '<h2 class="q-title">' + COPY.steps.clearance.title + '</h2>' +
          '<div class="opts" id="clearanceOpts">' + opts + '</div>' +
          '<div id="clearanceNote">' + note + '</div>' +
          '<p class="q-disclaimer">' + COPY.steps.clearance.medicalReminder + '</p>';
      },
      bind: function (root) {
        root.querySelectorAll('#clearanceOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.clearance_status = b.getAttribute("data-value");
            root.querySelectorAll('#clearanceOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            root.querySelector("#clearanceNote").innerHTML = state.answers.clearance_status !== "yes"
              ? '<p class="q-note">' + COPY.steps.clearance.notClearedNote + '</p>' : "";
            track(EVENTS.clearanceAnswered, { value: state.answers.clearance_status });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.clearance_status; }
    },

    baseline: {
      render: function (a) {
        var stepsOpts = COPY.steps.baseline.stepsOptions.map(function (o) {
          return pillOption("steps_value", o.value, o.label, a.current_steps_bucket === o.value);
        }).join("");
        var energyOpts = COPY.steps.baseline.energyOptions.map(function (o) {
          return pillOption("energy_value", o.value, o.label, a.energy_level === o.value);
        }).join("");
        var barrierOpts = COPY.steps.baseline.barriersOptions.map(function (o) {
          var checked = (a.barriers || []).indexOf(o.value) !== -1;
          return pillOption("barrier_value", o.value, o.label, checked, true);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.baseline.title + '</h2>' +
          '<p class="q-label">' + COPY.steps.baseline.stepsLabel + '</p>' +
          '<div class="opts" id="stepsOpts">' + stepsOpts + '</div>' +
          '<p class="q-label">' + COPY.steps.baseline.energyLabel + '</p>' +
          '<div class="opts" id="energyOpts">' + energyOpts + '</div>' +
          '<p class="q-label">' + COPY.steps.baseline.barriersLabel + '</p>' +
          '<div class="opts" id="barrierOpts">' + barrierOpts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#stepsOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.current_steps_bucket = b.getAttribute("data-value");
            root.querySelectorAll('#stepsOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
        root.querySelectorAll('#energyOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.energy_level = b.getAttribute("data-value");
            root.querySelectorAll('#energyOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
        root.querySelectorAll('#barrierOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            var v = b.getAttribute("data-value");
            var list = state.answers.barriers || [];
            var idx = list.indexOf(v);
            if (idx === -1) list.push(v); else list.splice(idx, 1);
            state.answers.barriers = list;
            b.classList.toggle("is-active");
          });
        });
      },
      canAdvance: function (a) { return !!a.current_steps_bucket && !!a.energy_level; }
    },

    insightActivity: makeInsightStep("insightActivity"),

    goal: {
      render: function (a) {
        if (a.clearance_status !== "yes") {
          return '<h2 class="q-title">' + COPY.steps.goal.prepareModeTitle + '</h2>' +
            '<p class="q-body">' + tone().prepareModeNote + '</p>';
        }
        var g = COPY.steps.goal;
        var opts = g.options.map(function (o) {
          return pillOption("goal_value", o.value, o.label, a.adjusted_goal === o.value);
        }).join("");
        return '<h2 class="q-title">' + g.title + '</h2>' +
          '<p class="q-body">' + tone().encourageGoal + '</p>' +
          '<div class="opts" id="goalOpts">' + opts + '</div>' +
          '<p class="q-note">' + g.weeklyFrame + '</p>';
      },
      bind: function (root) {
        var opts = root.querySelectorAll('#goalOpts .pill');
        if (!opts.length) return;
        opts.forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.adjusted_goal = Number(b.getAttribute("data-value"));
            opts.forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return a.clearance_status !== "yes" || !!a.adjusted_goal; }
    },

    motivation: {
      render: function (a) {
        var opts = COPY.steps.motivation.options.map(function (o) {
          var active = (a.motivation_style || "princess") === o.value;
          return '<button type="button" class="card-opt' + (active ? " is-active" : "") + '" data-value="' + o.value + '">' +
            '<span class="card-opt__label">' + o.label + '</span><span class="card-opt__desc">' + o.desc + '</span></button>';
        }).join("");
        if (!a.motivation_style) a.motivation_style = "princess";
        return '<h2 class="q-title">' + COPY.steps.motivation.title + '</h2>' +
          '<div class="opts opts--cards" id="toneOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#toneOpts .card-opt').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.motivation_style = b.getAttribute("data-value");
            root.querySelectorAll('#toneOpts .card-opt').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            track(EVENTS.motivationChosen, { value: state.answers.motivation_style });
          });
        });
      },
      canAdvance: function (a) { return !!a.motivation_style; }
    },

    insightCommunity: makeInsightStep("insightCommunity"),

    cohort: {
      render: function (a) {
        var c = COPY.steps.cohort;
        a.cohort = resolvedCohortFor(a);
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<div class="recap">' +
            '<ul class="recap__list">' + c.recapItems.map(function (i) { return '<li>' + i + '</li>'; }).join("") + '</ul>' +
          '</div>' +
          '<p class="q-body"><strong>' + fmtTemplate(c.assignedLabel, { group: prettyCohort(a.cohort) }) + '</strong></p>';
      },
      bind: function () {},
      canAdvance: function () { return true; },
      onLeave: function (a) { track(EVENTS.cohortChosen, { cohort: a.cohort }); }
    },

    planPreview: {
      render: function (a) {
        var c = COPY.steps.planPreview;
        var prepareMode = a.clearance_status !== "yes";
        var goalText = !prepareMode && a.adjusted_goal ? a.adjusted_goal.toLocaleString() + " steps/day" : c.prepareGoalValue;
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-note">' + c.recapLine + '</p>' +
          '<div class="summary">' +
            summaryRow(c.goalLabel, goalText) +
            summaryRow(c.lengthLabel, WM.PROGRAM_LENGTH_WEEKS + " weeks") +
            summaryRow(c.cohortLabel, prettyCohort(a.cohort)) +
            summaryRow(c.toneLabel, WM.TONE[a.motivation_style || "princess"].name) +
          '</div>' +
          '<p class="q-hint">' + c.note + '</p>';
      },
      bind: function () {},
      canAdvance: function () { return true; }
    },

    checkout: {
      render: function (a) {
        var prepareMode = a.clearance_status !== "yes";
        var goalText = !prepareMode && a.adjusted_goal ? a.adjusted_goal.toLocaleString() + " steps/day" : "Prepare mode, no goal yet";
        var c = COPY.steps.checkout;
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + tone().checkoutIntro + '</p>' +
          (prepareMode ? '<p class="q-note">' + fmtTemplate(c.prepareExplainer, { total: centsLabel(WM.TOTAL_CHARGE_CENTS) }) + '</p>' : '') +
          '<div class="summary">' +
            summaryRow(c.summaryGoalLabel, goalText) +
            summaryRow(c.summaryLengthLabel, WM.PROGRAM_LENGTH_WEEKS + " weeks") +
            summaryRow(c.summaryCohortLabel, prettyCohort(a.cohort)) +
            summaryRow(c.summaryToneLabel, WM.TONE[a.motivation_style || "princess"].name) +
            summaryRow(c.summaryStakeLabel, centsLabel(WM.COHORT_STAKE_AMOUNT_CENTS)) +
            summaryRow(c.summaryFeeLabel, centsLabel(WM.ENTRY_FEE_CENTS)) +
            summaryRow(c.summaryMissLabel, prepareMode ? c.prepareMissValue : missValueLabel()) +
            summaryRow(c.summaryTotalLabel, prepareMode ? c.prepareTotalValue : centsLabel(WM.TOTAL_CHARGE_CENTS)) +
          '</div>' +
          stakeSummaryHTML(prepareMode) +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="firstName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="email" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<label class="checkline"><input type="checkbox" id="agreeCheck"> ' + c.agreePrefix +
            ' <a href="' + c.legalLinks.terms + '" target="_blank" rel="noopener">' + c.agreeTermsText + '</a> ' + c.agreeJoiner +
            ' <a href="' + c.legalLinks.privacy + '" target="_blank" rel="noopener">' + c.agreePrivacyText + '</a></label>' +
          '<p class="q-disclaimer">' + COPY.disclaimer + '</p>' +
          (!prepareMode && WM.STRIPE_MODE === "test" ? '<p class="q-note">' + c.testModeNote + '</p>' : '') +
          '<button type="button" class="btn btn--ink" id="payBtn" style="width:100%;margin-top:8px" disabled>' + (prepareMode ? c.payCtaPrepare : c.payCta) + '</button>' +
          '<p class="q-error" id="checkoutError" hidden></p>';
      },
      bind: function (root) {
        var prepareMode = state.answers.clearance_status !== "yes";
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

          if (prepareMode) {
            state.answers.checkout_status = "reserved";
            saveState();
            track(EVENTS.prepareReserved, { local_id: state.localId });
            syncLead();
            var c = COPY.steps.checkout;
            screenEl.innerHTML = '<h2 class="q-title">' + c.reservedTitle + '</h2>' +
              '<p class="q-body">' + c.reservedBody + '</p>';
            backBtn.hidden = true;
            return;
          }

          var link = WM.COHORT_PAYMENT_LINK[WM.STRIPE_MODE];
          if (!link || link.indexOf("REPLACE_ME") !== -1) {
            err.textContent = "Payment link isn't configured yet. Add it to moms-copy.js.";
            err.hidden = false;
            track(EVENTS.checkoutFailed, { reason: "missing_payment_link" });
            return;
          }
          state.answers.checkout_status = "started";
          saveState();
          track(EVENTS.checkoutStarted, {
            stake_cents: WM.COHORT_STAKE_AMOUNT_CENTS, entry_fee_cents: WM.ENTRY_FEE_CENTS, local_id: state.localId
          });
          syncLead();

          var url = link + "?client_reference_id=" + encodeURIComponent(state.localId) +
            "&prefilled_email=" + encodeURIComponent(email.value.trim());
          window.location.href = url;
        });
      },
      canAdvance: function () { return false; }, // own pay button drives navigation
      onEnter: function (a) {
        if (a.checkout_status !== "started") a.checkout_status = "viewed";
        track(EVENTS.checkoutViewed, { stake_cents: WM.COHORT_STAKE_AMOUNT_CENTS, entry_fee_cents: WM.ENTRY_FEE_CENTS });
        syncLead();
      }
    }
  };

  /* ---------------- insight steps ---------------- */
  /* Read-only "why this works" screens, one per stage (pregnant/postpartum),
     inserted between relevant questions. No input required, so canAdvance
     is always true; the shared continueBtn borrows each screen's own CTA
     copy via continueLabel instead of the generic tone().continue. */

  function insightCopyFor(a, key) {
    var group = COPY.steps[key];
    return group[a.stage] || group.postpartum;
  }

  function makeInsightStep(key) {
    return {
      render: function (a) {
        var c = insightCopyFor(a, key);
        return '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + c.title + '</h2>' +
          c.body.map(function (p) { return '<p class="q-body">' + p + '</p>'; }).join("") +
          (c.callout ? '<div class="q-note"><strong>' + c.callout + '</strong></div>' : "") +
          '<p class="q-source">Source: <a href="' + escapeAttr(c.sourceUrl) + '" target="_blank" rel="noopener">' + c.sourceLabel + '</a></p>';
      },
      bind: function () {},
      canAdvance: function () { return true; },
      continueLabel: function (a) { return insightCopyFor(a, key).continueLabel; }
    };
  }

  /* ---------------- small render helpers ---------------- */

  function pillOption(name, value, label, active, multi) {
    return '<button type="button" class="pill' + (active ? " is-active" : "") + '" data-value="' + value + '" data-name="' + name + '">' + label + '</button>';
  }

  function summaryRow(label, value) {
    return '<div class="summary__row"><span>' + label + '</span><b>' + value + '</b></div>';
  }

  function centsLabel(cents) {
    return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
  }

  /* Reads as a deduction from the stake already being held, not a separate
     charge due today, since it sits in the same summary table as Stake,
     Entry fee, and Total today. */
  function missValueLabel() {
    return "−" + centsLabel(WM.MISS_AMOUNT_CENTS_PER_DAY) + " from your stake";
  }

  function stakeSummaryHTML(prepareMode) {
    var c = COPY.steps.checkout;
    return '<p class="q-hint">' + (prepareMode ? c.prepareNote : c.noteLine) + '</p>';
  }

  function prettyCohort(value) {
    var all = COPY.steps.cohort.groupsPregnant.concat(COPY.steps.cohort.groupsPostpartum);
    var match = all.filter(function (o) { return o.value === value; })[0];
    return match ? match.label : value || "";
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
    backBtn.hidden = state.stepIndex === 0;
    var isCheckout = id === "checkout";
    continueBtn.hidden = isCheckout;
    if (!isCheckout) {
      continueBtn.textContent = step.continueLabel ? step.continueLabel(state.answers) : tone().continue;
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

  var COHORT_VISUAL_SVG =
    '<svg viewBox="0 0 200 200" role="img" aria-label="Four women walking together in a circle">' +
      '<circle cx="100" cy="100" r="74" fill="none" stroke="var(--line)" stroke-width="2" stroke-dasharray="6 10"/>' +
      '<circle cx="100" cy="26" r="22" fill="var(--rose)"/>' +
      '<circle cx="174" cy="100" r="22" fill="var(--lavender)"/>' +
      '<circle cx="100" cy="174" r="22" fill="var(--amber)"/>' +
      '<circle cx="26" cy="100" r="22" fill="var(--sage)"/>' +
      '<text x="100" y="112" text-anchor="middle" font-size="36">🚶‍♀️</text>' +
    '</svg>';

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
                '<p>' + fmtTemplate(s.desc, { stake: centsLabel(WM.COHORT_STAKE_AMOUNT_CENTS) }) + '</p>' +
              '</div>' +
            '</div>';
          }).join("") +
        '</div>' +
      '</div></section>' +

      '<section class="mcohort"><div class="wrap cohort-layout">' +
        '<div class="cohort-visual rv">' + COHORT_VISUAL_SVG + '</div>' +
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
    progressFill = document.getElementById("progressFill");
    resumeBanner = document.getElementById("resumeBanner");
    gateEl = document.getElementById("gate");
    landingEl = document.getElementById("landing");
    appEl = document.getElementById("app");
    loadingEl = document.getElementById("loading");
    mainEl = document.getElementById("top");
    exitLink = document.getElementById("exitLink");

    continueBtn.addEventListener("click", goNext);
    backBtn.addEventListener("click", goBack);

    initGate();
  });
})();
