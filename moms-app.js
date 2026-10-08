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
      stake_cents: a.stake_cents != null ? a.stake_cents : null,
      miss_cents: a.miss_cents != null ? a.miss_cents : null,
      program_length_weeks: WM.PROGRAM_LENGTH_WEEKS,
      grace_period_weeks: WM.GRACE_PERIOD_WEEKS,
      passes_total: WM.LIFE_HAPPENED_PASSES_TOTAL,
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

  var screenEl, continueBtn, backBtn, progressFill, resumeBanner, gateEl, landingEl, appEl, loadingEl;

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
        var all = groups.concat([COPY.steps.cohort.soloOption]);
        var opts = all.map(function (o) {
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
        var isCohort = a.cohort && a.cohort !== "solo";
        var html = '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + fmtTemplate(c.lengthNote, { weeks: WM.PROGRAM_LENGTH_WEEKS }) + '</p>';

        if (isCohort) {
          a.stake_cents = WM.COHORT_STAKE_AMOUNT_CENTS;
          var cohortTier = tierFor(a.stake_cents);
          html += '<p class="q-body">' + fmtTemplate(c.cohortStakeNote, { amount: cohortTier.amountLabel }) + '</p>';
        } else {
          html += '<p class="q-label">' + c.chooseStakeLabel + '</p>' +
            '<div class="opts" id="stakeOpts">' + WM.STAKE_TIERS.map(function (t) {
              return pillOption("stake", t.amountCents, t.amountLabel, a.stake_cents === t.amountCents);
            }).join("") + '</div>';
        }

        var tier = tierFor(a.stake_cents);
        if (tier) {
          html += '<p class="q-label">' + c.missLabel + '</p>' +
            '<div class="opts" id="missOpts">' + tier.missOptions.map(function (m) {
              return pillOption("miss", m.cents, m.label, a.miss_cents === m.cents);
            }).join("") + '</div>';
          var missOpt = tier.missOptions.filter(function (m) { return m.cents === a.miss_cents; })[0];
          html += stakeSummaryHTML(missOpt);
        }
        return html;
      },
      bind: function (root) {
        root.querySelectorAll('#stakeOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.stake_cents = Number(b.getAttribute("data-value"));
            state.answers.miss_cents = null; // miss options differ per tier
            renderStep(false);
          });
        });
        root.querySelectorAll('#missOpts .pill').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.miss_cents = Number(b.getAttribute("data-value"));
            renderStep(false);
          });
        });
      },
      canAdvance: function (a) { return !!a.stake_cents && a.miss_cents != null; }
    },

    checkout: {
      render: function (a) {
        var tier = tierFor(a.stake_cents);
        var missOpt = tier ? tier.missOptions.filter(function (m) { return m.cents === a.miss_cents; })[0] : null;
        var goalText = a.clearance_status === "yes" && a.adjusted_goal ? a.adjusted_goal.toLocaleString() + " steps/day" : "Prepare mode, no goal yet";
        var c = COPY.steps.checkout;
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + tone().checkoutIntro + '</p>' +
          '<div class="summary">' +
            summaryRow(c.summaryGoalLabel, goalText) +
            summaryRow(c.summaryLengthLabel, WM.PROGRAM_LENGTH_WEEKS + " weeks") +
            summaryRow(c.summaryCohortLabel, prettyCohort(a.cohort)) +
            summaryRow(c.summaryToneLabel, WM.TONE[a.motivation_style || "princess"].name) +
            summaryRow(c.summaryAmountLabel, tier ? tier.amountLabel : "") +
            summaryRow(c.summaryMissLabel, missOpt ? missOpt.label : "") +
          '</div>' +
          stakeSummaryHTML(missOpt) +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="firstName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="email" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<label class="checkline"><input type="checkbox" id="agreeCheck"> ' + c.agreePrefix +
            ' <a href="' + c.legalLinks.terms + '" target="_blank" rel="noopener">' + c.agreeTermsText + '</a> ' + c.agreeJoiner +
            ' <a href="' + c.legalLinks.privacy + '" target="_blank" rel="noopener">' + c.agreePrivacyText + '</a></label>' +
          '<p class="q-disclaimer">' + COPY.disclaimer + '</p>' +
          '<p class="q-note">' + c.testModeNote + '</p>' +
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
          var tier = tierFor(state.answers.stake_cents);
          if (!tier) { err.textContent = "Please pick a stake first."; err.hidden = false; return; }
          var link = tier.links[WM.STRIPE_MODE];
          if (!link || link.indexOf("REPLACE_ME") !== -1) {
            err.textContent = "Payment link isn't configured yet. Add it to moms-copy.js.";
            err.hidden = false;
            track(EVENTS.checkoutFailed, { reason: "missing_payment_link" });
            return;
          }
          state.answers.checkout_status = "started";
          saveState();
          track(EVENTS.checkoutStarted, {
            stake_cents: tier.amountCents, miss_cents: state.answers.miss_cents, local_id: state.localId
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
        track(EVENTS.checkoutViewed, { stake_cents: a.stake_cents, miss_cents: a.miss_cents });
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

  function tierFor(cents) {
    return WM.STAKE_TIERS.filter(function (t) { return t.amountCents === cents; })[0];
  }

  function stakeSummaryHTML(missOpt) {
    if (!missOpt) return "";
    var c = COPY.steps.commit;
    var vars = { grace: WM.GRACE_PERIOD_WEEKS, passes: WM.LIFE_HAPPENED_PASSES_TOTAL, miss: missOpt.label };
    return '<p class="q-note">' + fmtTemplate(c.summaryLine, vars) + '</p>' +
      '<p class="q-hint">' + fmtTemplate(c.summaryHint, vars) + '</p>';
  }

  function prettyCohort(value) {
    var all = COPY.steps.cohort.groupsPregnant.concat(COPY.steps.cohort.groupsPostpartum, [COPY.steps.cohort.soloOption]);
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

  function showLanding() {
    landingEl.hidden = false;
    var L = COPY.landing;
    landingEl.innerHTML =
      '<div class="card">' +
        '<p class="eyebrow">' + L.eyebrow + '</p>' +
        '<h1 class="q-title" style="font-size:1.7rem">' + L.title + '</h1>' +
        '<p class="q-body">' + L.body + '</p>' +
        L.features.map(function (f) {
          return '<div class="landing-feature">' +
            '<div class="landing-feature__ic">' + f.icon + '</div>' +
            '<div><div class="landing-feature__title">' + f.title + '</div>' +
            '<div class="landing-feature__desc">' + f.desc + '</div></div>' +
          '</div>';
        }).join("") +
        '<p class="q-note">' + L.stakeNote + '</p>' +
        '<p class="q-disclaimer">' + COPY.disclaimer + '</p>' +
        '<button type="button" class="btn btn--ink" id="landingCta" style="width:100%;margin-top:4px">' + L.cta + '</button>' +
        '<p class="landing-time">' + L.takesTime + '</p>' +
      '</div>';

    track(EVENTS.landingView, { local_id: state.localId });

    document.getElementById("landingCta").addEventListener("click", function () {
      state.onboardingStarted = true;
      track(EVENTS.onboardingStart, { local_id: state.localId });
      saveState();
      landingEl.hidden = true;
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

    continueBtn.addEventListener("click", goNext);
    backBtn.addEventListener("click", goBack);

    initGate();
  });
})();
