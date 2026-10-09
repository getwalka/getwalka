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
  var STEP_IDS = ["stage", "clearance", "baseline", "goal", "motivation", "cohort", "commit", "checkout"];

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
      stage: a.stage || null,
      weeks_postpartum: a.weeks_postpartum != null ? Number(a.weeks_postpartum) : null,
      due_date: a.due_date || null,
      delivery_type: a.delivery_type || null,
      clearance_status: a.clearance_status || null,
      prepare_mode: a.clearance_status ? a.clearance_status !== "yes" : null,
      current_steps_bucket: a.current_steps_bucket || null,
      energy_level: a.energy_level || null,
      barriers: a.barriers || null,
      suggested_goal: a.suggested_goal != null ? a.suggested_goal : null,
      adjusted_goal: a.adjusted_goal != null ? a.adjusted_goal : null,
      motivation_style: a.motivation_style || "princess",
      cohort: a.cohort || null,
      stake_cents: WM.COHORT_STAKE_AMOUNT_CENTS,
      miss_cents: WM.MISS_AMOUNT_CENTS_PER_DAY,
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

  /* ---------------- goal calc ---------------- */

  function computeSuggestedGoal(answers) {
    if (answers.clearance_status !== "yes") return WM.PREPARE_MODE_DEFAULT_GOAL;
    var base = WM.BASELINE_STEPS_BY_BUCKET[answers.current_steps_bucket] || WM.BASELINE_STEPS_BY_BUCKET.not_sure;
    var mult = WM.ENERGY_MULTIPLIER[answers.energy_level] || 1;
    var stepped = Math.round((base * mult) / WM.GOAL_STEP_INCREMENT) * WM.GOAL_STEP_INCREMENT;
    return Math.min(WM.GOAL_MAX, Math.max(WM.GOAL_MIN, stepped));
  }

  function tone() { return WM.TONE[state.answers.motivation_style || "princess"]; }

  /* ---------------- DOM refs ---------------- */

  var screenEl, continueBtn, backBtn, progressFill, resumeBanner, gateEl, landingEl, appEl, loadingEl, mainEl;

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

    goal: {
      render: function (a) {
        if (a.clearance_status !== "yes") {
          return '<h2 class="q-title">' + COPY.steps.goal.prepareModeTitle + '</h2>' +
            '<p class="q-body">' + tone().prepareModeNote + '</p>';
        }
        if (a.suggested_goal == null) a.suggested_goal = computeSuggestedGoal(a);
        if (a.adjusted_goal == null) a.adjusted_goal = a.suggested_goal;
        return '<h2 class="q-title">' + COPY.steps.goal.title + '</h2>' +
          '<p class="q-body">' + tone().encourageGoal + '</p>' +
          '<div class="goal-stepper">' +
            '<button type="button" class="goal-btn" id="goalDown" aria-label="Decrease">−</button>' +
            '<div class="goal-value"><span id="goalNum">' + a.adjusted_goal.toLocaleString() + '</span><span class="goal-unit">' + COPY.steps.goal.dailyLabel + '</span></div>' +
            '<button type="button" class="goal-btn" id="goalUp" aria-label="Increase">+</button>' +
          '</div>' +
          '<p class="q-note">' + COPY.steps.goal.weeklyFrame + '</p>' +
          '<p class="q-hint">' + COPY.steps.goal.adjustHint + '</p>';
      },
      bind: function (root) {
        var down = root.querySelector("#goalDown"), up = root.querySelector("#goalUp"), num = root.querySelector("#goalNum");
        if (!down) return;
        function apply(delta) {
          state.answers.adjusted_goal = Math.min(WM.GOAL_MAX, Math.max(WM.GOAL_MIN, (state.answers.adjusted_goal || 0) + delta));
          num.textContent = state.answers.adjusted_goal.toLocaleString();
        }
        down.addEventListener("click", function () { apply(-WM.GOAL_STEP_INCREMENT); });
        up.addEventListener("click", function () { apply(WM.GOAL_STEP_INCREMENT); });
      },
      canAdvance: function () { return true; }
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

    cohort: {
      render: function (a) {
        var groups = a.stage === "pregnant" ? COPY.steps.cohort.groupsPregnant : COPY.steps.cohort.groupsPostpartum;
        var opts = groups.map(function (o) {
          return pillOption("cohort_value", o.value, o.label, a.cohort === o.value);
        }).join("");
        return '<h2 class="q-title">' + COPY.steps.cohort.title + '</h2>' +
          '<div class="opts" id="cohortOpts">' + opts + '</div>' +
          '<p class="q-hint">' + COPY.steps.cohort.partnerNote + '</p>';
      },
      bind: function (root) {
        root.querySelectorAll('#cohortOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.cohort = b.getAttribute("data-value");
            root.querySelectorAll('#cohortOpts .pill').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
          });
        });
      },
      canAdvance: function (a) { return !!a.cohort; },
      onLeave: function (a) { track(EVENTS.cohortChosen, { cohort: a.cohort }); }
    },

    commit: {
      render: function (a) {
        var c = COPY.steps.commit;
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + fmtTemplate(c.lengthNote, { weeks: WM.PROGRAM_LENGTH_WEEKS }) + '</p>' +
          '<p class="q-body">' + fmtTemplate(c.stakeLine, { stake: centsLabel(WM.COHORT_STAKE_AMOUNT_CENTS) }) + '</p>' +
          '<p class="q-body">' + fmtTemplate(c.missLine, { miss: centsLabel(WM.MISS_AMOUNT_CENTS_PER_DAY) }) + '</p>' +
          '<p class="q-note">' + c.poolLine + '</p>' +
          '<p class="q-hint">' + fmtTemplate(c.feeLine, { fee: centsLabel(WM.ENTRY_FEE_CENTS) }) + '</p>';
      },
      bind: function () {},
      canAdvance: function () { return true; }
    },

    checkout: {
      render: function (a) {
        var goalText = a.clearance_status === "yes" && a.adjusted_goal ? a.adjusted_goal.toLocaleString() + " steps/day" : "Prepare mode, no goal yet";
        var c = COPY.steps.checkout;
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + tone().checkoutIntro + '</p>' +
          '<div class="summary">' +
            summaryRow(c.summaryGoalLabel, goalText) +
            summaryRow(c.summaryLengthLabel, WM.PROGRAM_LENGTH_WEEKS + " weeks") +
            summaryRow(c.summaryCohortLabel, prettyCohort(a.cohort)) +
            summaryRow(c.summaryToneLabel, WM.TONE[a.motivation_style || "princess"].name) +
            summaryRow(c.summaryStakeLabel, centsLabel(WM.COHORT_STAKE_AMOUNT_CENTS)) +
            summaryRow(c.summaryFeeLabel, centsLabel(WM.ENTRY_FEE_CENTS)) +
            summaryRow(c.summaryMissLabel, centsLabel(WM.MISS_AMOUNT_CENTS_PER_DAY)) +
            summaryRow(c.summaryTotalLabel, centsLabel(WM.TOTAL_CHARGE_CENTS)) +
          '</div>' +
          stakeSummaryHTML() +
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

  function stakeSummaryHTML() {
    var c = COPY.steps.commit;
    var vars = { miss: centsLabel(WM.MISS_AMOUNT_CENTS_PER_DAY) };
    return '<p class="q-note">' + fmtTemplate(c.summaryLine, vars) + '</p>' +
      '<p class="q-hint">' + c.summaryHint + '</p>';
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
      html += '<p class="q-label">' + s.deliveryLabel + '</p><div class="opts" id="deliveryOpts">' +
        s.deliveryOptions.map(function (o) { return pillOption("delivery", o.value, o.label, a.delivery_type === o.value); }).join("") + '</div>';
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
    root.querySelectorAll("#deliveryOpts .pill").forEach(function (b) {
      b.addEventListener("click", function () {
        state.answers.delivery_type = b.getAttribute("data-value");
        root.querySelectorAll("#deliveryOpts .pill").forEach(function (p) { p.classList.toggle("is-active", p === b); });
      });
    });
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
      continueBtn.textContent = tone().continue;
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
      '<section class="mhero"><div class="wrap">' +
        '<p class="eyebrow">' + L.eyebrow + '</p>' +
        '<h1>' + L.title + '</h1>' +
        '<p class="mhero__sub">' + L.body + '</p>' +
        '<div class="mhero__ctas">' +
          '<button type="button" class="btn btn--ink" id="landingCta">' + L.cta + '</button>' +
          '<span class="landing-time">' + L.takesTime + '</span>' +
        '</div>' +
        '<p class="q-note" style="max-width:28rem;margin-top:20px">' + L.stakeNote + '</p>' +
        '<p class="q-disclaimer" style="border-top:none;padding-top:0;max-width:28rem">' + COPY.disclaimer + '</p>' +
      '</div></section>' +

      '<section class="mhow"><div class="wrap">' +
        '<div class="sec-head rv">' +
          '<p class="eyebrow">' + L.howEyebrow + '</p>' +
          '<h2>' + L.howTitle + '</h2>' +
        '</div>' +
        '<div class="msteps3">' +
          L.howSteps.map(function (s) {
            return '<div class="ms3 rv">' +
              '<div class="ms3__ic">' + s.icon + '</div>' +
              '<h3>' + s.title + '</h3>' +
              '<p>' + s.desc + '</p>' +
            '</div>';
          }).join("") +
        '</div>' +
      '</div></section>' +

      '<section class="mcohort"><div class="wrap">' +
        '<div class="sec-head rv">' +
          '<p class="eyebrow">' + L.cohortEyebrow + '</p>' +
          '<h2>' + L.cohortTitle + '</h2>' +
          '<p class="q-body" style="margin:10px 0 0">' + L.cohortBody + '</p>' +
        '</div>' +
        '<div class="cohort-grid">' +
          L.cohortGroups.map(function (g) {
            return '<div class="cohort-card rv">' +
              '<div class="member-ph">' +
                '<img src="' + escapeAttr(g.photo) + '" alt="" ' +
                  'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
                '<span class="member-ph__fallback">' + g.fallbackIcon + '</span>' +
              '</div>' +
              '<p class="cohort-card__caption">' + g.caption + '</p>' +
            '</div>';
          }).join("") +
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
      renderStep();
    });
  }

  function startFlow() {
    loadingEl.hidden = true;
    if (state.onboardingStarted) {
      appEl.hidden = false;
      if (state.stepIndex > 0) {
        resumeBanner.hidden = false;
        resumeBanner.textContent = COPY.resumeBanner;
      }
      renderStep();
    } else {
      showLanding();
    }
  }

  function initGate() {
    if (WM.FORCE_FLOW_ENABLED) { startFlow(); return; }

    if (previewOverrideActive()) { startFlow(); return; }

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

    continueBtn.addEventListener("click", goNext);
    backBtn.addEventListener("click", goBack);

    initGate();
  });
})();
