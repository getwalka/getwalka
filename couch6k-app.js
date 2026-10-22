/* ==========================================================================
   Walka Couch to 6K: paid 6-week test-cohort funnel, ENGINE
   Step state machine, feature-flag gate, resume-from-localStorage, analytics
   events, Supabase sync, one-time combined-charge Stripe checkout. All
   copy/config lives in couch6k-copy.js. Structure mirrors start-app.js; see
   that file's comments for the parts that are identical (uuid/state/sync/
   gate plumbing). Deviations from start-app.js are called out inline where
   they happen: the waitlist step, the pre-selected mode step with its
   tap-to-expand disclosure, the always-tagged-with-mode track() wrapper,
   and the one-time combined-PaymentIntent checkout (no subscription, no
   deferred/optional stake).
   ========================================================================== */
(function () {
  "use strict";

  var WS = window.WALKA_COUCH6K;
  var COPY = WS.COPY;
  var EVENTS = WS.EVENTS;
  var STORAGE_KEY = "walka_couch6k_state_v1";
  var PREPARING_DELAY_MS = 3000;
  var STEP_IDS = [
    "goal", "baseline", "waitlist", "coach", "mode", "contact", "preparing", "results", "checkout"
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

  /* Always merges `mode` into every event's props, from whatever state.answers
     holds at call time (null until the mode step is reached) -- a structural
     fix rather than auditing each call site, since start-app.js's own track()
     is inconsistent about which calls include mode (CLAUDE.md flag item 4). */
  function track(event, props) {
    try {
      if (window.posthog && window.posthog.capture) {
        posthog.capture(event, Object.assign({ mode: (state.answers && state.answers.mode) || null }, props || {}));
      }
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

  /* Same numeral-in-the-visitor's-own-currency pattern as /start. */
  function checkoutCurrency(a) {
    return a.country === "CA" ? "cad" : "usd";
  }

  /* supabase-js's FunctionsHttpError.message is always the generic "Edge
     Function returned a non-2xx status code" -- unwraps the Edge Function's
     real { error: "..." } body, same as start-app.js's identical helper. */
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

  function centsLabel(cents) {
    return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
  }

  /* Always two decimals -- for the itemized price-breakdown rows only,
     where "$90.00" reads as a real line item next to "$29.99"/"$119.99"
     rather than the looser "$90" prose elsewhere on the page. */
  function centsLabelExact(cents) {
    return "$" + (cents / 100).toFixed(2);
  }

  /* ---------------- plan-facts rendering (paywall + checkout) ---------------- *
   * The weekly ramp is ONE fixed schedule for every user (WS.WEEKLY_TARGETS),
   * never computed from onboarding answers -- the baseline-steps question is
   * analytics only (see syncLead below) and must never feed this. */

  function templ(str, map) {
    return Object.keys(map).reduce(function (s, key) {
      return s.replace("{" + key + "}", map[key]);
    }, str);
  }

  /* Six bars, one per WS.WEEKLY_TARGETS entry, height scaled between the
     schedule's own min/max so the ramp reads at a glance. Week 1 carries a
     distinct "you start here" label + the real start date (group) or "the
     day you join" (solo) instead of a plain week number. Bars fill in on
     load via CSS animation (--fill custom property, staggered --i delay);
     @media (prefers-reduced-motion:reduce) in couch6k.html shows the final
     height immediately instead. */
  function rampBars(targets, startLabel, startDateText) {
    var min = Math.min.apply(null, targets);
    var max = Math.max.apply(null, targets);
    return '<div class="ramp-bars">' +
      targets.map(function (steps, i) {
        var pct = max === min ? 100 : Math.round(10 + 90 * ((steps - min) / (max - min)));
        var weekLine = i === 0
          ? '<p class="ramp-bar__week ramp-bar__week--start">' + escapeAttr(startLabel) + '</p><p class="ramp-bar__date">' + escapeAttr(startDateText) + '</p>'
          : '<p class="ramp-bar__week">' + COPY.steps.results.rampWeekLabel + ' ' + (i + 1) + '</p>';
        return '<div class="ramp-bar">' +
          '<div class="ramp-bar__track"><div class="ramp-bar__fill" style="--fill:' + pct + '%;--i:' + i + '"></div></div>' +
          '<p class="ramp-bar__value">' + steps.toLocaleString() + '</p>' +
          weekLine +
        '</div>';
      }).join("") +
    '</div>';
  }

  /* ---------------- cohort dates: ONE source (WS.COHORT_START_DATE_ISO), ---------------- *
   * both the start label and the refund/end label are derived from it so
   * they can never drift apart by hand-editing one and not the other. */

  var DATE_FORMAT_OPTS = { weekday: "short", month: "short", day: "numeric" };

  function formatDateLabel(date) {
    return date.toLocaleDateString("en-US", DATE_FORMAT_OPTS);
  }

  function cohortDates() {
    var start = new Date(WS.COHORT_START_DATE_ISO + "T00:00:00");
    var end = new Date(start);
    // Friday of the final week: (PROGRAM_WEEKS - 1) full weeks forward, +4
    // days to land on that week's Friday.
    end.setDate(start.getDate() + (WS.PROGRAM_WEEKS - 1) * 7 + 4);
    return { startLabel: formatDateLabel(start), endLabel: formatDateLabel(end) };
  }

  /* ---------------- coach card: real, already-shipped sample lines ---------------- *
   * Pulled from lib/coach.ts's own MESSAGES pool (one representative line
   * per style) rather than invented for this page, so the preview matches
   * what actually gets sent. */
  var COACH_META = {
    princess: {
      name: "Coach Serena",
      descriptor: "Warm and encouraging",
      emoji: "👑",
      sample: "Look at you go, over halfway there! 💪"
    },
    tough: {
      name: "Coach Tim",
      descriptor: "Blunt, no excuses",
      emoji: "🔥",
      sample: "Halfway. Don’t you dare quit now."
    }
  };

  /* ---------------- accordion: independent, multi-item expand/collapse ---------------- *
   * Sibling to disclosureMarkup/bindDisclosure (the mode step's single
   * tap-to-expand), but supports several items open/closed independently. */
  function accordionItem(id, title, body) {
    return '<div class="accordion-item">' +
      '<button type="button" class="accordion-toggle" data-accordion="' + id + '" aria-expanded="false">' +
        '<span>' + escapeAttr(title) + '</span><span class="accordion-toggle__caret" aria-hidden="true">+</span>' +
      '</button>' +
      '<div class="accordion-body" id="accordion-' + id + '" hidden>' + body + '</div>' +
    '</div>';
  }
  function bindAccordion(root) {
    root.querySelectorAll(".accordion-toggle").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var body = root.querySelector("#accordion-" + btn.getAttribute("data-accordion"));
        var open = btn.getAttribute("aria-expanded") === "true";
        btn.setAttribute("aria-expanded", String(!open));
        if (body) body.hidden = open;
      });
    });
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
      coach_style: a.coach_style || null,
      mode: a.mode || null,
      first_name: a.first_name || null,
      email: a.email || null,
      referral_source: a.referral_source || null,
      last_step: STEP_IDS[state.stepIndex] || null,
      checkout_status: a.checkout_status || "not_started"
    }, extra || {});

    return sbClient.from(WS.SUPABASE_TABLE).upsert(row, { onConflict: "local_id" })
      .then(function (res) { if (res.error) console.warn("[couch6k-flow] supabase upsert error", res.error); })
      .catch(function (err) { console.warn("[couch6k-flow] supabase upsert failed", err); });
  }

  /* Resuming from a different device/browser than the one that started the
     flow -- same ?lid=<local_id> mechanic as start/moms. */
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
            coach_style: row.coach_style || null,
            mode: row.mode || null,
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
      .catch(function (err) { console.warn("[couch6k-flow] rehydrate from link failed", err); });
  }

  /* ---------------- DOM refs ---------------- */

  var screenEl, continueBtn, backBtn, skipBtn, progressFill, progressLabel, resumeBanner, resumeBannerText, resumeBannerDismiss, gateEl, appEl, loadingEl, mainEl, exitLink, flownavEl, introHeaderEl;

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

  /* New: tap-to-expand disclosure, sibling to pillOption/pillOptionWithSub.
     Plain click/aria-expanded toggle -- no :hover dependency anywhere, this
     funnel is mobile-first. */
  /* Used by both the mode step's "what's the difference" and the results
     step's "why 6,000" row -- IDs are plain (not step-prefixed) and safe
     to reuse since only one step's DOM exists at a time. A step with more
     than one disclosure would need per-instance IDs; neither does today. */
  function disclosureMarkup(label, body) {
    return '<button type="button" class="disclosure-toggle" id="pageDisclosureToggle" aria-expanded="false">' +
        escapeAttr(label) +
      '</button>' +
      '<div class="disclosure-body" id="pageDisclosureBody" hidden>' + body + '</div>';
  }
  function bindDisclosure(root) {
    var btn = root.querySelector("#pageDisclosureToggle");
    var body = root.querySelector("#pageDisclosureBody");
    if (!btn || !body) return;
    btn.addEventListener("click", function () {
      var open = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!open));
      body.hidden = open;
    });
  }

  /* ---------------- step definitions ---------------- */
  /* Each step: render() -> HTML, bind(root) attach listeners, canAdvance()
     -> bool, onEnter()/onLeave() optional, skip(a) optional (bypassed
     entirely in both directions when it returns true -- used to hide the
     `waitlist` step for anyone who didn't pick the 7,000+ baseline). */

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

    /* 7,000+ only -- skipped entirely for everyone else, in both nav
       directions. Terminal: its own submit button absorbs the step rather
       than calling goNext(), same self-contained idea checkout's pay
       button uses. */
    waitlist: {
      hideNav: true,
      skip: function (a) { return a.baseline_bucket !== "seven_plus"; },
      render: function (a) {
        var c = COPY.steps.waitlist;
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.body + '</p>' +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="wlName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="wlEmail" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<button type="button" class="btn btn--ink" id="wlSubmit" style="width:100%;margin-top:16px" disabled>' + c.submitCta + '</button>';
      },
      bind: function (root) {
        var c = COPY.steps.waitlist;
        var name = root.querySelector("#wlName"), email = root.querySelector("#wlEmail"), submit = root.querySelector("#wlSubmit");
        function fieldsValid() {
          return name.value.trim().length > 0 && /\S+@\S+\.\S+/.test(email.value.trim());
        }
        function refresh() { submit.disabled = !fieldsValid(); }
        name.addEventListener("input", function () { state.answers.first_name = name.value; refresh(); });
        email.addEventListener("input", function () { state.answers.email = email.value; refresh(); });
        submit.addEventListener("click", function () {
          if (!fieldsValid()) return;
          state.answers.checkout_status = "waitlisted";
          saveState();
          track(EVENTS.waitlisted, { local_id: state.localId });
          syncLead({ checkout_status: "waitlisted" });
          root.innerHTML = '<h2 class="q-title">' + c.confirmedTitle + '</h2>' +
            '<p class="q-body">' + c.confirmedBody + '</p>';
        });
      },
      canAdvance: function () { return false; }
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

    /* Real engine deviation from start-app.js's mode step: pre-selected to
       "group" (Continue is visible and already enabled, no tap required),
       plus a tap-to-expand "what's the difference?" disclosure. A tap on a
       card still requires hitting the visible Continue button -- it does
       NOT auto-advance, since the step no longer needs a forced choice to
       become valid. */
    mode: {
      onEnter: function (a) { if (!a.mode) a.mode = "group"; },
      render: function (a) {
        var c = COPY.steps.mode;
        var opts = c.options.map(function (o) {
          return pillOptionWithSub("mode_value", o.value, o.label, o.sub, a.mode === o.value);
        }).join("");
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<div class="answer-grid" id="modeOpts">' + opts + '</div>' +
          (a.mode === "solo" ? '<p class="q-hint">' + c.soloMoneyNote + '</p>' : '') +
          '<div class="disclosure">' + disclosureMarkup(c.disclosureLabel, c.disclosureBody) + '</div>';
      },
      bind: function (root) {
        root.querySelectorAll('#modeOpts .answer-card').forEach(function (b) {
          b.addEventListener("click", function () {
            state.answers.mode = b.getAttribute("data-value");
            root.querySelectorAll('#modeOpts .answer-card').forEach(function (p) { p.classList.toggle("is-active", p === b); });
            refreshContinue();
            renderStep(false); // re-render to toggle the solo money note, without re-tracking a step view
          });
        });
        bindDisclosure(root);
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
        clearTimeout(pendingAdvanceTimer);
        pendingAdvanceTimer = setTimeout(function () { goNext(); }, PREPARING_DELAY_MS);
      }
    },

    /* The paywall. Screen order: headline, ramp, money card (slider),
       coach card, one-liners, rules accordion, "why 6,000" row, sticky
       total+button bar. No "made for you" framing and no per-user ramp
       math anywhere: WS.WEEKLY_TARGETS is the one schedule every user
       gets, independent of onboarding answers. "N already joined" and any
       countdown are left out entirely -- there's no real data source for
       a manually-created one-off cohort (wiring a real count would mean a
       get-weekly-cohort-preview-style Edge Function call scoped to this
       cohort's actual challenge row, which doesn't exist yet; flagged
       here rather than faked).

       Its own sticky bottom bar drives navigation (hideContinue:true
       hides the shared flownav's Continue button; Back stays visible). */
    results: {
      flownavVariant: "tight",
      hideContinue: true,
      render: function (a) {
        var c = COPY.steps.results;
        var isGroup = a.mode === "group";
        var targets = WS.WEEKLY_TARGETS;
        var coach = COACH_META[a.coach_style] || COACH_META.princess;
        var dates = cohortDates();

        var startLabel = isGroup ? c.rampStartLabelGroup : c.rampStartLabelSolo;
        var startDateText = isGroup
          ? templ(c.rampStartDateGroup, { startDate: dates.startLabel })
          : c.rampStartDateSolo;

        var payoutFragment = isGroup ? c.payoutFragmentGroup : c.payoutFragmentSolo;
        var payoutDetail = isGroup ? c.rulePayoutDetailGroup : c.rulePayoutDetailSolo;

        return '<div class="stagger">' +

          /* 1. Headline + subline */
          '<h2 class="q-title">' + templ(c.headline, {
            rampStart: targets[0].toLocaleString(),
            rampEnd: targets[targets.length - 1].toLocaleString()
          }) + '</h2>' +
          '<p class="q-body">' + templ(c.subline, { perDay: centsLabel(WS.MISS_LOSS_CENTS_PER_DAY) }) + '</p>' +

          /* 2. Ramp chart */
          rampBars(targets, startLabel, startDateText) +

          /* 3. Money card + slider */
          '<div class="money-card">' +
            '<p class="money-card__finish">' + templ(c.moneyFinishLine, { fee: centsLabel(WS.FEE_CENTS), stake: centsLabel(WS.STAKE_CENTS) }) + '</p>' +
            '<p class="money-card__slider-label" id="missSliderLabel">' + templ(c.sliderLabel, { misses: "0" }) + '</p>' +
            '<input type="range" id="missSlider" class="money-card__slider" min="0" max="' + WS.TRACKED_WEEKDAYS + '" step="1" value="0" aria-label="' + escapeAttr(c.sliderLabel.replace("{misses}", "")) + '">' +
            '<div class="money-card__outputs">' +
              '<p class="money-card__back" id="missSliderBack">' + templ(c.sliderBack, { back: centsLabelExact(WS.STAKE_CENTS) }) + '</p>' +
              '<p class="money-card__lose" id="missSliderLose">' + templ(c.sliderLose, { lose: centsLabelExact(0) }) + '</p>' +
            '</div>' +
          '</div>' +

          /* 4. Coach card */
          '<div class="coach-card">' +
            '<div class="coach-card__avatar" aria-hidden="true">' + coach.emoji + '</div>' +
            '<div class="coach-card__text">' +
              '<p class="coach-card__name">' + c.coachCardLabel + ': ' + coach.name + '</p>' +
              '<p class="coach-card__style">' + coach.descriptor + '</p>' +
              '<p class="coach-card__sample">“' + coach.sample + '”</p>' +
            '</div>' +
          '</div>' +
          '<p class="coach-card__caption">' + c.coachCardCaption + '</p>' +

          /* 5. Three one-liners */
          '<ul class="fact-lines">' +
            '<li>' + c.lineGoal + '</li>' +
            '<li>' + templ(c.lineMaxLoss, { stake: centsLabel(WS.STAKE_CENTS) }) + '</li>' +
            '<li>' + templ(c.lineRefund, { refundDate: dates.endLabel, payoutFragment: payoutFragment }) + '</li>' +
          '</ul>' +

          /* 6. "Rules in detail" accordion */
          '<p class="q-label">' + c.rulesLabel + '</p>' +
          '<div class="accordion">' +
            accordionItem("step-source", c.ruleStepSource.title, '<p>' + c.ruleStepSource.body + '</p>') +
            accordionItem("time-zone", c.ruleTimeZone.title, '<p>' + c.ruleTimeZone.body + '</p>') +
            accordionItem("cancellation", c.ruleCancellation.title, '<p>' + c.ruleCancellation.body + '</p>') +
            accordionItem("payout", c.rulePayout.title, '<p>' + templ(c.rulePayout.body, {
              perDay: centsLabel(WS.MISS_LOSS_CENTS_PER_DAY),
              stake: centsLabel(WS.STAKE_CENTS),
              payoutDetail: payoutDetail
            }) + '</p>') +
            accordionItem("edge-cases", c.ruleEdgeCases.title, '<p>' + c.ruleEdgeCases.body + '</p>') +
          '</div>' +

          /* 7. "Why 6,000?" row, collapsed by default */
          '<div class="why-row">' + disclosureMarkup(c.whyLabel, '<p>' + c.whyBody + '</p>') + '</div>' +

          /* 9. Cancellation line. "Joined"/countdown omitted: no real data
             source for this manually-created one-off cohort. */
          '<p class="q-hint cancellation-line">' + c.cancellationLine + '</p>' +

          '<div class="sticky-bar-spacer" aria-hidden="true"></div>' +
        '</div>' +

        /* 8. Sticky bottom bar -- fixed to the viewport, outside the
           staggered-fade-in content above. */
        '<div class="sticky-bar">' +
          '<div class="sticky-bar__row">' +
            '<p class="sticky-bar__total">' + templ(c.totalLine, { total: centsLabelExact(WS.TOTAL_CENTS), stake: centsLabel(WS.STAKE_CENTS) }) + '</p>' +
            '<button type="button" class="btn btn--ink sticky-bar__btn" id="resultsContinueBtn">' + c.continueCta + '</button>' +
          '</div>' +
          '<p class="sticky-bar__note">' + c.afterButtonNote + '</p>' +
        '</div>';
      },
      bind: function (root) {
        var c = COPY.steps.results;
        bindDisclosure(root); // the "why 6,000" row
        bindAccordion(root);

        var slider = root.querySelector("#missSlider");
        var label = root.querySelector("#missSliderLabel");
        var backEl = root.querySelector("#missSliderBack");
        var loseEl = root.querySelector("#missSliderLose");
        if (slider) {
          slider.addEventListener("input", function () {
            var misses = Number(slider.value);
            var loseCents = Math.min(misses * WS.MISS_LOSS_CENTS_PER_DAY, WS.STAKE_CENTS);
            var backCents = WS.STAKE_CENTS - loseCents;
            label.textContent = templ(c.sliderLabel, { misses: String(misses) });
            backEl.textContent = templ(c.sliderBack, { back: centsLabelExact(backCents) });
            loseEl.textContent = templ(c.sliderLose, { lose: centsLabelExact(loseCents) });
          });
        }

        var stickyBtn = root.querySelector("#resultsContinueBtn");
        if (stickyBtn) stickyBtn.addEventListener("click", function () { goNext(); });
      },
      canAdvance: function () { return true; },
      onEnter: function (a) {
        track(EVENTS.resultsViewed, { local_id: state.localId });
        syncLead();
      }
    },

    checkout: {
      render: function (a) {
        var c = COPY.steps.checkout;
        var currency = checkoutCurrency(a);
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="charge-breakdown">' +
            '<div class="charge-breakdown__row"><span>' + c.feeRowLabel + '</span><strong>' + centsLabel(WS.FEE_CENTS) + ' ' + currency.toUpperCase() + '</strong></div>' +
            '<div class="charge-breakdown__row"><span>' + templ(c.stakeRowLabel, { perDay: centsLabel(WS.MISS_LOSS_CENTS_PER_DAY) }) + '</span><strong>' + centsLabel(WS.STAKE_CENTS) + ' ' + currency.toUpperCase() + '</strong></div>' +
          '</div>' +
          '<p class="q-hint">' + templ(c.billingNoteBase, { perDay: centsLabel(WS.MISS_LOSS_CENTS_PER_DAY) }) + '</p>' +
          '<p class="q-label">' + c.includedLabel + '</p>' +
          '<div class="recap"><ul class="recap__list">' +
            c.includedItems.map(function (t) { return '<li>' + t + '</li>'; }).join("") +
          '</ul></div>' +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="firstName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="email" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<label class="checkline"><input type="checkbox" id="agreeCheck"> ' + c.agreePrefix +
            ' <a href="' + c.legalLinks.terms + '" target="_blank" rel="noopener">' + c.agreeTermsText + '</a> ' + c.agreeJoiner +
            ' <a href="' + c.legalLinks.privacy + '" target="_blank" rel="noopener">' + c.agreePrivacyText + '</a></label>' +
          (WS.STRIPE_MODE === "test" ? '<p class="q-note">' + c.testModeNote + '</p>' : '') +
          '<div id="paymentElementContainer" class="payment-pending"><p class="q-hint">' + c.paymentPlaceholder + '</p></div>' +
          '<button type="button" class="btn btn--ink" id="payBtn" style="width:100%;margin-top:8px" disabled>' + templ(c.confirmCta, { total: centsLabel(WS.TOTAL_CENTS) }) + '</button>' +
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
        var confirmCtaText = templ(c.confirmCta, { total: centsLabel(WS.TOTAL_CENTS) });

        function fieldsValid() {
          return name.value.trim().length > 0 && agree.checked && /\S+@\S+\.\S+/.test(email.value.trim());
        }
        function refreshButton() {
          pay.disabled = !((mounted || alreadyActive) && fieldsValid());
          if (!pay.disabled || pay.textContent !== c.processingCta) pay.textContent = confirmCtaText;
        }
        function showError(msg) {
          err.textContent = msg;
          err.hidden = false;
        }

        function startInlineCheckout() {
          var pk = WS.STRIPE_PUBLISHABLE_KEY[WS.STRIPE_MODE];
          if (!window.Stripe || !pk) {
            showError("Payment isn't configured yet. Add the publishable key to couch6k-copy.js.");
            track(EVENTS.checkoutFailed, { reason: "missing_publishable_key" });
            return;
          }
          var currency = checkoutCurrency(state.answers);
          stripeClient = window.Stripe(pk);
          sbClient.functions.invoke("create-couch6k-payment-intent", {
            body: { local_id: state.localId, email: email.value.trim(), name: name.value.trim(), currency: currency }
          }).then(function (res) {
            if (res.error) throw res.error;
            var data = res.data || {};
            if (data.error) throw new Error(data.error);

            if (data.alreadyActive) {
              alreadyActive = true;
              paymentContainer.className = "";
              paymentContainer.innerHTML = '<p class="q-hint">Payment already received. Ready when you are.</p>';
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
            track(EVENTS.checkoutStarted, { local_id: state.localId, currency: currency });
          }).catch(function (e) {
            describeFunctionError(e).then(function (described) {
              console.warn("[couch6k checkout] create-couch6k-payment-intent failed", described);
              showError(described.message || c.genericError);
              track(EVENTS.checkoutFailed, { reason: "payment_intent_error" });
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

        function finishCheckout() {
          state.answers.checkout_status = "completed_unverified";
          saveState();
          track(EVENTS.checkoutCompleted, { local_id: state.localId });
          window.location.href = "/couch6k-success";
        }

        function handleCheckoutError(e) {
          showError((e && e.message) || c.genericError);
          pay.textContent = confirmCtaText;
          refreshButton();
          track(EVENTS.checkoutFailed, { reason: "confirm_error" });
        }

        pay.addEventListener("click", function () {
          if (!(mounted || alreadyActive)) return;
          pay.disabled = true;
          pay.textContent = c.processingCta;
          err.hidden = true;

          var paymentConfirmed = alreadyActive
            ? Promise.resolve()
            : stripeClient.confirmPayment({
                elements: elements,
                confirmParams: { return_url: window.location.origin + "/couch6k-success" },
                redirect: "if_required"
              }).then(function (result) {
                if (result.error) throw result.error;
              });

          paymentConfirmed
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
     /couch6k request. Empty if middleware didn't run (e.g. local dev
     without `vercel dev`), in which case the gate below fails OPEN. */
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
