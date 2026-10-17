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
  /* v6: bumped because `contact` (first name + email, captured earlier so
     checkout dropoffs still leave a reachable lead) was inserted before
     `preparing`. Any change to STEP_IDS's length or order needs the same
     bump — a saved numeric stepIndex from before this change would resume
     into a different step than the one the visitor left, so stale state
     must be discarded rather than resumed. moms-success.html reads the
     same key and must be bumped in lockstep. */
  var STORAGE_KEY = "walka_moms_state_v6";
  var PREPARING_DELAY_MS = 5000;
  var STEP_IDS = [
    "stage", "motivation", "barriers", "interludeCare", "connection", "conversations",
    "interludeCommunity", "baseline", "clearance", "contact", "preparing", "results", "checkout"
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
    if (!sbClient) return Promise.resolve();
    var a = state.answers;
    var row = Object.assign({
      local_id: state.localId,
      updated_at: new Date().toISOString(),
      country: a.country || null,
      stage: a.stage || null,
      motherhood_stage: a.motherhood_stage || null,
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
      referral_source: a.referral_source || null,
      last_step: STEP_IDS[state.stepIndex] || null,
      checkout_status: a.checkout_status || "not_started"
    }, extra || {});

    return sbClient.from(WM.SUPABASE_TABLE).upsert(row, { onConflict: "local_id" })
      .then(function (res) { if (res.error) console.warn("[moms-flow] supabase upsert error", res.error); })
      .catch(function (err) { console.warn("[moms-flow] supabase upsert failed", err); });
  }

  /* Resuming from an emailed link (process-abandoned-moms-leads), where the
     visitor may be on a different device/browser than the one that started
     the flow, so localStorage has nothing. ?lid=<local_id> on the URL is the
     only thing that lets this device find their saved progress.
     Only last_step is persisted server-side (no full step-by-step snapshot),
     so this can land one step off from exactly where they stopped -- a UX
     nit, not a money issue: nothing here re-sends a Payment Link click
     without the visitor tapping the checkout CTA again. */
  function maybeRehydrateFromLink() {
    var lid = getQueryParam("lid");
    if (!lid || !sbClient || state.localId === lid) return Promise.resolve();

    return sbClient.from(WM.SUPABASE_TABLE).select("*").eq("local_id", lid).maybeSingle()
      .then(function (res) {
        if (res.error || !res.data) return;
        var row = res.data;
        var idx = STEP_IDS.indexOf(row.last_step);
        state = {
          localId: row.local_id,
          stepIndex: idx >= 0 ? idx : 0,
          answers: {
            email: row.email || null,
            first_name: row.first_name || null,
            country: row.country || null,
            stage: row.stage || null,
            motherhood_stage: row.motherhood_stage || null,
            clearance_status: row.clearance_status || null,
            routine_preference: row.routine_preference || null,
            activity_baseline: row.activity_baseline || null,
            barriers: row.barriers || null,
            motivation_wants: row.motivation_wants || null,
            connection: row.connection || null,
            conversations_openness: row.conversations_openness || null,
            cohort: row.cohort || null,
            checkout_status: row.checkout_status || "not_started"
          },
          startedAt: Date.now(),
          isResumed: true
        };
        saveState();
        // Strip ?lid= so a later refresh resumes from localStorage (now
        // populated above), not a possibly-stale server copy.
        try {
          var url = new URL(window.location.href);
          url.searchParams.delete("lid");
          history.replaceState(null, "", url.pathname + url.search + url.hash);
        } catch (e) { /* ignore */ }
      })
      .catch(function (err) { console.warn("[moms-flow] rehydrate from link failed", err); });
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

  /* `results` step: two cards, a walking-challenge preview and a
     community preview, mostly static copy per the brief (moms-copy.js's
     RESULTS_COPY). The personalized elements are the sentence under the
     headline, the circle chip (member's actual stage), and whether the
     challenge card's numeric example is shown at all. Title strings
     below are reused as-is by `checkout`'s "what's included" list via
     resultsCards()/resultsDiaryCard(), so the two screens agree. */

  /* Reads the same grouping data COPY.cohort uses for resolvedCohortFor()'s
     return codes, for display on the "Finding your circle:" chip. */
  function cohortLabel(value) {
    var all = COPY.cohort.groupsPregnant.concat(COPY.cohort.groupsPostpartum);
    var match = all.filter(function (o) { return o.value === value; })[0];
    return match ? match.label : "";
  }

  /* "You told us you'd love to {a}, while {bIng}." built from up to two
     of the member's actual onboarding answers (see the priority-ordered
     `clauses` list in moms-copy.js for why each one is worded the way
     it is). Deterministic lookup, no scoring. */
  function resultsPersonalizedSentence(a) {
    var p = WM.RESULTS_COPY.personalization;
    var wants = a.motivation_wants || [];
    var barriers = a.barriers || [];
    var matches = p.clauses.filter(function (c) {
      var source = c.field === "barriers" ? barriers : wants;
      return source.indexOf(c.value) !== -1;
    });
    if (matches.length === 0) return p.default;
    if (matches.length === 1) return p.oneClause.replace("{a}", matches[0].base);
    return p.twoClause.replace("{a}", matches[0].base).replace("{bIng}", matches[1].ing);
  }

  /* Gates the walking-challenge card's numeric example goal/progress —
     never shown to someone who indicated restrictions or a recovery
     break, per onboarding's clearance/routine questions. */
  function isRecovering(a) {
    return a.routine_preference === "not_ready" || a.clearance_status === "not_yet";
  }

  function resultsCircleCard(a) {
    var c = WM.RESULTS_COPY.circle;
    var label = cohortLabel(a.cohort);
    var chip = label ? (c.chipPrefix + label) : c.genericChip;
    var reason = label ? ("stage:" + a.motherhood_stage) : "fallback";
    return { title: c.title, chip: chip, reason: reason };
  }

  /* No longer personalized (the brief replaces the per-preference bullet
     list with one static line); kept as a function purely so checkout's
     resultsCards() has a consistent title to read. */
  function resultsRoutineCard() {
    return { title: WM.RESULTS_COPY.routine.title };
  }

  /* Optional secondary feature: returns null (render nothing) unless a
     specific answer actually points to it. Never a default filler. Only
     consumed by checkout's recap list now; the results step itself no
     longer shows a diary mention. */
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
    return [resultsCircleCard(a), { title: WM.RESULTS_COPY.communityPreview.title }, resultsRoutineCard()];
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
        var c = COPY.steps.stage;
        var opts = c.options.map(function (o) {
          return pillOption("stage_value", o.value, o.label, a.motherhood_stage === o.value);
        }).join("");
        return '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="answer-grid" id="stageOpts">' + opts + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#stageOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            var v = b.getAttribute("data-value");
            state.answers.motherhood_stage = v;
            state.answers.stage = (v === "pregnant") ? "pregnant" : "postpartum";
            root.querySelectorAll('#stageOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            autoAdvance();
          });
        });
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
            autoAdvance();
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
            autoAdvance();
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
            autoAdvance();
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
            autoAdvance();
          });
        });
      },
      canAdvance: function (a) { return !!a.routine_preference; }
    },

    /* Screen 10: captures first name + email here, before the offer and
       checkout, rather than only at checkout — so a member who reaches
       checkout but doesn't finish paying still leaves a reachable lead
       (email/name previously only existed on rows that got all the way
       through checkout). checkout's own name/email fields already read
       from state.answers and will arrive here pre-filled, no change
       needed there. referral_source is optional and purely for
       attribution, so it doesn't gate canAdvance. */
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

    /* Screen 11: a brief, timed "preparing your circle" transition — no
       question, no Continue/Back/Skip (hideNav), just a pause with a
       loading motif before the personalized results reveal. Advances
       itself via onEnter's timer; canAdvance stays true as a fallback
       only (goNext() checks it, but nothing in the UI can trigger goNext
       early since hideNav removes every button). */
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
      onEnter: function () {
        clearTimeout(pendingAdvanceTimer);
        pendingAdvanceTimer = setTimeout(function () { goNext(); }, PREPARING_DELAY_MS);
      }
    },

    /* Screen 12, personalized results — two equally-weighted cards, a
       walking-challenge preview and a community preview, so the screen
       doesn't read as just a chat group. flownavVariant tightens the CTA
       gap for this richer step; the shell stays the default width since
       it's one column, not a two-up grid — see renderStep(). */
    results: {
      flownavVariant: "tight",
      render: function (a) {
        var c = COPY.steps.results;
        var rc = WM.RESULTS_COPY;
        a.cohort = resolvedCohortFor(a); // still stored/synced for real matching later; not displayed as confirmed
        var circle = resultsCircleCard(a);
        var ch = rc.routine; // walking-challenge content
        var recovering = isRecovering(a);

        return '<div class="stagger">' +
          '<p class="eyebrow">' + c.eyebrow + '</p>' +
          '<h2 class="q-title">' + rc.title + '</h2>' +
          '<p class="q-body">' + resultsPersonalizedSentence(a) + '</p>' +

          '<div class="walk-card">' +
            '<h3 class="walk-card__title">' + ch.title + '</h3>' +
            '<p class="walk-card__desc">' + ch.description + '</p>' +
            '<div class="walk-card__preview">' +
              (recovering ? '' : '<span class="walk-card__tag">' + escapeAttr(ch.previewTag) + '</span>') +
              '<p class="walk-card__goal">' + (recovering ? ch.goalRecovering : ch.goal) + '</p>' +
              '<div class="walk-card__days" aria-hidden="true">' + weekDaysHTML() + '</div>' +
              (recovering ? '' : '<p class="walk-card__progress">' + ch.progress + '</p>') +
            '</div>' +
            '<p class="walk-card__note">' + ch.note + '</p>' +
          '</div>' +

          '<div class="circle-chat">' +
            '<div class="circle-chat__header">' +
              '<h3 class="circle-chat__title">' + circle.title + '</h3>' +
              '<p class="circle-chat__desc">' + escapeAttr(rc.circle.description) + '</p>' +
              '<span class="circle-chat__stage">' + escapeAttr(circle.chip) + '</span>' +
            '</div>' +
            chatMessagesHTML(rc.circle.messages) +
          '</div>' +

          (rc.foundingNote ? '<p class="founding-note">' + rc.foundingNote + '</p>' : '') +
        '</div>';
      },
      bind: function () {},
      canAdvance: function () { return true; },
      onEnter: function (a) {
        track(EVENTS.cohortChosen, { cohort: a.cohort });
        var circle = resultsCircleCard(a);
        track(EVENTS.resultsViewed, { circle_reason: circle.reason, challenge_goal_shown: !isRecovering(a) });
      }
    },

    /* Screen 13 */
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
          '<div id="paymentElementContainer" class="payment-pending"><p class="q-hint">' + c.paymentPlaceholder + '</p></div>' +
          '<button type="button" class="btn btn--ink" id="payBtn" style="width:100%;margin-top:8px" disabled>' + c.confirmCta + '</button>' +
          '<p class="q-error" id="checkoutError" hidden></p>';
      },
      bind: function (root) {
        var c = COPY.steps.checkout;
        var name = root.querySelector("#firstName"), email = root.querySelector("#email");
        var agree = root.querySelector("#agreeCheck"), pay = root.querySelector("#payBtn"), err = root.querySelector("#checkoutError");
        var paymentContainer = root.querySelector("#paymentElementContainer");

        /* No "continue" click: the intent is created automatically, in the
           background, the moment name/email/terms are all valid (debounced
           so we don't fire on every keystroke), and the Payment Element
           replaces the dimmed placeholder as soon as it mounts. The Subscribe
           button stays disabled until both that AND the fields are valid.
           Falls back to the old Payment Link redirect if Stripe.js never
           loaded, the publishable key isn't configured, or the intent call
           fails, so checkout never dead-ends on a broken inline path. */
        var stripeClient = null, elements = null;
        var initiated = false; // intent creation started (or already done)
        var mounted = false;   // Payment Element is actually on the page
        var debounceTimer = null;

        function fieldsValid() {
          return name.value.trim().length > 0 && agree.checked && /\S+@\S+\.\S+/.test(email.value.trim());
        }
        function refreshButton() {
          pay.disabled = !(mounted && fieldsValid());
        }

        function showError(msg) {
          err.textContent = msg;
          err.hidden = false;
        }

        function fallbackToRedirect(currency) {
          var link = WM.MEMBERSHIP_PAYMENT_LINK[WM.STRIPE_MODE][currency];
          if (!link || link.indexOf("REPLACE_ME") !== -1) {
            showError("Payment isn't configured yet. Add it to moms-copy.js.");
            track(EVENTS.checkoutFailed, { reason: "missing_payment_link", currency: currency });
            return;
          }
          var url = link + "?client_reference_id=" + encodeURIComponent(state.localId) +
            "&prefilled_email=" + encodeURIComponent(email.value.trim());
          var navigated = false;
          function goToStripe() { if (!navigated) { navigated = true; window.location.href = url; } }
          syncLead().then(goToStripe).catch(goToStripe);
          setTimeout(goToStripe, 1200);
        }

        function startInlineCheckout(currency) {
          var pk = WM.STRIPE_PUBLISHABLE_KEY[WM.STRIPE_MODE];
          if (!window.Stripe || !pk || pk.indexOf("REPLACE_ME") !== -1) {
            fallbackToRedirect(currency);
            return;
          }
          sbClient.functions.invoke("create-moms-subscription-intent", {
            body: { local_id: state.localId, email: email.value.trim(), name: name.value.trim(), currency: currency }
          }).then(function (res) {
            if (res.error) throw res.error;
            var data = res.data || {};
            if (data.error) throw new Error(data.error);

            if (data.alreadyActive) {
              state.answers.checkout_status = "completed_unverified";
              state.answers.billing_currency = currency;
              saveState();
              window.location.href = "/moms-success";
              return;
            }
            if (!data.clientSecret) throw new Error("no clientSecret in response");

            stripeClient = window.Stripe(pk);
            elements = stripeClient.elements({ clientSecret: data.clientSecret });
            paymentContainer.className = "";
            paymentContainer.innerHTML = '<p class="q-label">' + c.cardLabel + '</p><div id="paymentElement"></div>';
            elements.create("payment").mount("#paymentElement");

            mounted = true;
            err.hidden = true;
            refreshButton();

            track(EVENTS.checkoutStarted, { local_id: state.localId, plan_price_cents: WM.PLAN_PRICE_CENTS, currency: currency });
          }).catch(function (e) {
            console.warn("[moms checkout] create-moms-subscription-intent failed, falling back to redirect", e);
            fallbackToRedirect(currency);
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

            var currency = checkoutCurrency(state.answers);
            state.answers.checkout_status = "started";
            state.answers.billing_currency = currency;
            saveState();

            /* The real email just typed needs to land in Supabase before
               create-moms-subscription-intent reads it back, but a
               slow/broken connection must never trap someone who can't pay. */
            var started = false;
            function begin() { if (!started) { started = true; startInlineCheckout(currency); } }
            syncLead().then(begin).catch(begin);
            setTimeout(begin, 1200);
          }, 600);
        }

        name.addEventListener("input", function () { state.answers.first_name = name.value; refreshButton(); scheduleInit(); });
        email.addEventListener("input", function () { state.answers.email = email.value; refreshButton(); scheduleInit(); });
        agree.addEventListener("change", function () { refreshButton(); scheduleInit(); });

        function confirmInlinePayment() {
          pay.disabled = true;
          pay.textContent = c.processingCta;
          err.hidden = true;
          stripeClient.confirmPayment({
            elements: elements,
            confirmParams: { return_url: window.location.origin + "/moms-success" },
            redirect: "if_required"
          }).then(function (result) {
            if (result.error) {
              showError(result.error.message || c.genericError);
              pay.textContent = c.confirmCta;
              refreshButton();
              return;
            }
            // Confirmed without a redirect (no 3D Secure challenge needed);
            // a challenge would have sent the browser to return_url itself.
            state.answers.checkout_status = "completed_unverified";
            saveState();
            track(EVENTS.checkoutCompleted, { local_id: state.localId, plan_price_cents: WM.PLAN_PRICE_CENTS });
            window.location.href = "/moms-success";
          }).catch(function () {
            showError(c.genericError);
            pay.textContent = c.confirmCta;
            refreshButton();
          });
        }

        pay.addEventListener("click", function () {
          if (!mounted) return; // guarded by disabled state anyway
          confirmInlinePayment();
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

  /* results step walking-challenge card: a purely illustrative "shape of
     a week" row (Mon-Sun, two example completed days) — never a real
     tracked-activity visualization, since no real activity data exists
     pre-signup. Shown regardless of isRecovering(), since it carries no
     numeric target, only the goal/progress text next to it is gated. */
  function weekDaysHTML() {
    var labels = ["M", "T", "W", "T", "F", "S", "S"];
    var done = [true, false, false, true, false, false, false]; // Mon + Thu, illustrative only
    return labels.map(function (label, i) {
      return '<span class="walk-card__day' + (done[i] ? " is-done" : "") + '" aria-hidden="true">' + label + '</span>';
    }).join("");
  }

  /* results step chat preview: same person keeps the same avatar tint
     across all of their messages (assigned by first appearance), rather
     than tinting by message position. No timestamps — the brief is
     explicit this must never read as real, dated member activity. */
  function chatMessagesHTML(messages) {
    var tintByName = {};
    var nextTint = 0;
    return messages.map(function (m, i) {
      if (!(m.name in tintByName)) { tintByName[m.name] = AVATAR_TINTS[nextTint % AVATAR_TINTS.length]; nextTint++; }
      // Alternate sides by position so a short back-and-forth reads as a
      // conversation (a reply) rather than a stack of identical posts.
      var replyClass = (i % 2 === 1) ? " chat-message--reply" : "";
      return '<div class="chat-message' + replyClass + '"><span class="circle-avatar circle-avatar--' + tintByName[m.name] + '" aria-hidden="true">' + initials(m.name) + '</span>' +
        '<div class="chat-message__bubble">' +
          '<div class="chat-message__meta"><span class="chat-message__name">' + escapeAttr(m.name) + '</span></div>' +
          '<p class="chat-message__text">' + escapeAttr(m.text) + '</p>' +
        '</div></div>';
    }).join("");
  }

  function centsLabel(cents) {
    return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
  }

  /* ---------------- flow control ---------------- */

  function currentStepId() { return STEP_IDS[state.stepIndex]; }

  function refreshContinue() {
    var step = steps[currentStepId()];
    continueBtn.disabled = !step.canAdvance(state.answers);
  }

  /* For single-select questions only (never multi-select, which still
     needs an explicit Continue so the member can pick more than one
     before moving on): advances automatically once the step's one
     required pick is made, after a short delay so the selection
     highlight is visible first. pendingAdvanceTimer is reset on every
     call so a second click (changing their mind) cancels the first
     timer rather than both eventually firing. */
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
    screenEl.className = "card" + (step.cardVariant ? " card--reassurance card--" + step.cardVariant : "");
    void screenEl.offsetWidth; // force reflow so the entrance animation restarts on every step
    screenEl.classList.add("card--enter");
    shellEl.classList.toggle("shell--wide", step.shellVariant === "wide");
    flownavEl.classList.toggle("flownav--tight", step.flownavVariant === "tight");
    progressFill.style.width = Math.round(((state.stepIndex + 1) / STEP_IDS.length) * 100) + "%";
    progressLabel.textContent = "Step " + (state.stepIndex + 1) + " of " + STEP_IDS.length;
    backBtn.hidden = state.stepIndex === 0;
    var isCheckout = id === "checkout";
    var hideNav = isCheckout || step.hideNav; // checkout drives its own nav; a few steps (e.g. preparing) are timed/non-interactive
    continueBtn.hidden = hideNav;
    skipBtn.hidden = hideNav || !step.optional;
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

  /* /moms goes straight into the step wizard now, no marketing landing
     page first (landingEl stays hidden/empty, left in moms.html in case
     this gets reverted). onboardingStart still fires immediately since
     there's no separate landing-view moment to distinguish it from
     anymore. */
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

    maybeRehydrateFromLink().then(function () { initGate(); });
  });
})();
