/* ==========================================================================
   Walka "November challenge" funnel, ENGINE
   Two-screen flow (home -> checkout), gate, resume-from-localStorage,
   analytics events, Supabase sync, one-time combined-charge Stripe
   checkout. All copy/config lives in couch6k-copy.js. Structure mirrors
   start-app.js; see that file's comments for the parts that are identical
   (uuid/state/sync/gate plumbing).

   The homepage is a full marketing-style landing page (hero, your-week
   grid, coach preview, how-it-works, community preview, pricing, final
   CTA), not a quiz card -- it renders its own full-bleed sections and
   escapes the narrow centered "shell" that checkout still uses (see
   body.is-home in myplan.html's CSS). The coach toggle on the homepage is
   a non-binding preview only: clicking it swaps the sample-message panel
   in place (no full re-render, so scroll position never jumps) but never
   writes to state.answers or Supabase -- coach is chosen in the app,
   after purchase.
   ========================================================================== */
(function () {
  "use strict";

  var WS = window.WALKA_COUCH6K;
  var COPY = WS.COPY;
  var EVENTS = WS.EVENTS;
  /* v2: the step schema changed (9-step quiz -> home+checkout -> this
     landing-page redesign). Bumped so a phone that tested an earlier
     version doesn't load a stepIndex that no longer maps to a real step
     -- see the loadState() bounds check below for why that used to crash
     straight past the homepage into a stuck "Welcome back" banner. */
  var STORAGE_KEY = "walka_couch6k_state_v2";
  var STEP_IDS = ["home", "checkout"];

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
        posthog.capture(event, props || {});
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

  /* GB/AU/NG bill in USD at the same price point as the US -- only CA
     gets its own currency. */
  function checkoutCurrency(a) {
    return a.country === "CA" ? "cad" : "usd";
  }

  /* Real USD->CAD conversion (WS.USD_TO_CAD_RATE), not the same numeral
     relabeled -- a Canadian buy-in must come out to the actual CAD
     equivalent of the USD price, not a cheaper flat number that happens
     to share digits with it. Rounds to the nearest cent so Stripe always
     receives a whole-cent integer. */
  function convertedCents(usdCents, currency) {
    return currency === "cad" ? Math.round(usdCents * WS.USD_TO_CAD_RATE) : usdCents;
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

  /* Always two decimals -- for itemized price rows/stat cards, where
     "$20.00" reads as a real line item next to "$19.99"/"$39.99" rather
     than the looser "$20" prose elsewhere on the page. */
  function centsLabelExact(cents) {
    return "$" + (cents / 100).toFixed(2);
  }

  function templ(str, map) {
    return Object.keys(map).reduce(function (s, key) {
      return s.split("{" + key + "}").join(map[key]);
    }, str);
  }

  /* ---------------- cohort date formatting: ONE source, WS.COHORT_START_DATE_ISO ---------------- */

  var SHORT_DATE_OPTS = { weekday: "short", month: "short", day: "numeric" };
  var LONG_DATE_OPTS = { weekday: "long", month: "long", day: "numeric" };
  var MONTH_OPTS = { month: "long" };
  var NUMBER_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

  function cohortDates() {
    var start = new Date(WS.COHORT_START_DATE_ISO + "T00:00:00");
    return {
      shortLabel: start.toLocaleDateString("en-US", SHORT_DATE_OPTS).toUpperCase(), // "MON, NOV 2"
      longLabel: start.toLocaleDateString("en-US", LONG_DATE_OPTS), // "Monday, November 2"
      month: start.toLocaleDateString("en-US", MONTH_OPTS) // "November"
    };
  }

  /* Every placeholder the homepage's copy templates reference, derived
     straight from WS's config constants so the page can never show a
     number that disagrees with what checkout actually charges. Currency-
     aware: a Canadian visitor (state.answers.country === "CA", stamped
     from middleware.js's geo cookie before this ever renders) sees the
     real CAD-converted fee/stake/total/perDay, suffixed " CAD" so it's
     never mistaken for a bare USD number. convertedCents() is mirrored
     server-side in create-couch6k-payment-intent/index.ts, so the amount
     shown here is always the amount Stripe actually charges. */
  function commonVars() {
    var dates = cohortDates();
    var currency = checkoutCurrency(state.answers);
    var suffix = currency === "cad" ? " CAD" : "";
    var feeCents = convertedCents(WS.FEE_CENTS, currency);
    var stakeCents = convertedCents(WS.STAKE_CENTS, currency);
    var perDayCents = convertedCents(WS.MISS_LOSS_CENTS_PER_DAY, currency);
    return {
      weeks: String(WS.PROGRAM_WEEKS), // numeral, for the compact hero badge only
      weeksWord: NUMBER_WORDS[WS.PROGRAM_WEEKS] || String(WS.PROGRAM_WEEKS), // spelled out, sentence-initial ("Four weeks is...")
      weeksWordLower: (NUMBER_WORDS[WS.PROGRAM_WEEKS] || String(WS.PROGRAM_WEEKS)).toLowerCase(), // spelled out, mid-sentence ("...for four weeks.")
      goal: WS.DAILY_GOAL_STEPS.toLocaleString(),
      fee: centsLabel(feeCents) + suffix,
      stake: centsLabel(stakeCents) + suffix,
      total: centsLabelExact(feeCents + stakeCents) + suffix, // summed from the already-converted parts, so it never drifts a cent from the itemized rows
      perDay: centsLabel(perDayCents) + suffix,
      trackedWeekdays: String(WS.TRACKED_WEEKDAYS),
      month: dates.month,
      monthUpper: dates.month.toUpperCase(),
      startDateShort: dates.shortLabel,
      startDateLong: dates.longLabel
    };
  }

  /* ---------------- accordion: independent, multi-item expand/collapse ---------------- */
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
        // A stepIndex that no longer maps to a real step (left over from a
        // step schema this funnel no longer has) must never be trusted --
        // it would otherwise make renderStep() call .render() on
        // undefined and crash before the page ever paints, visible only
        // as a stuck resume banner over a blank screen.
        if (parsed && parsed.localId && parsed.stepIndex >= 0 && parsed.stepIndex < STEP_IDS.length) return parsed;
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
      first_name: a.first_name || null,
      email: a.email || null,
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
            first_name: row.first_name || null,
            email: row.email || null,
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

  var screenEl, continueBtn, backBtn, skipBtn, resumeBanner, resumeBannerText, resumeBannerDismiss, gateEl, appEl, loadingEl, mainEl, exitLink, flownavEl, navEl, footerEl;

  /* ====================================================================
     HOME step: section renderers. One function per section on the page,
     top to bottom, each taking the home copy block and the shared
     template vars from commonVars(). Keeping these as separate functions
     (rather than one giant template literal) is what makes each section
     independently readable/editable.
     ==================================================================== */

  function renderHero(c, vars) {
    var h = c.hero;
    var remaining = WS.DAILY_GOAL_STEPS - h.exampleSteps;
    var exampleVars = Object.assign({}, vars, {
      exampleSteps: h.exampleSteps.toLocaleString(),
      remaining: remaining.toLocaleString()
    });
    /* Force the highlighted phrase onto its own line with an explicit
       <br> rather than leaving it to wrap naturally: left to itself, the
       highlight's last word or two lands on the line above (next to
       plain text) and the rest alone below, so box-decoration-break:clone
       paints two uneven background fragments stacked close together --
       which reads as the highlight overlapping the line above it, not
       as one clean highlighted line like the mockup. */
    var headlineRaw = templ(h.headline, vars);
    var highlightIndex = headlineRaw.indexOf(h.headlineHighlight);
    var headlineHtml;
    if (highlightIndex !== -1) {
      var before = escapeAttr(headlineRaw.slice(0, highlightIndex).trim());
      var highlight = escapeAttr(headlineRaw.slice(highlightIndex));
      headlineHtml = before + '<br>' + '<mark class="hl-mark">' + highlight + '</mark>';
    } else {
      headlineHtml = escapeAttr(headlineRaw);
    }

    return '<section class="sec sec--hero">' +
      '<div class="sec__in hero__in">' +
        '<div class="hero__top">' +
          '<span class="wordmark">walka</span>' +
          '<span class="badge badge--yellow">' + templ(h.badge, vars) + '</span>' +
        '</div>' +
        '<div class="hero__grid">' +
          '<div class="hero__copy">' +
            '<p class="eyebrow eyebrow--mono eyebrow--indigo">' + templ(h.eyebrow, { weeks: vars.weeks, month: vars.monthUpper }) + '</p>' +
            '<h1 class="display display--xl">' + headlineHtml + '</h1>' +
            '<p class="lede">' + h.body + '</p>' +
            '<div class="hero__cta-row">' +
              '<button type="button" class="btn btn--ink js-cta">' + templ(h.ctaLabel, vars) + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="example-card">' +
            '<p class="eyebrow eyebrow--mono">' + h.exampleEyebrow + '</p>' +
            '<p class="example-card__steps">' + h.exampleSteps.toLocaleString() + ' <span>/ ' + vars.goal + ' steps</span></p>' +
            '<div class="example-card__bar"><div class="example-card__bar-fill" style="width:' + Math.round((h.exampleSteps / WS.DAILY_GOAL_STEPS) * 100) + '%"></div></div>' +
            '<div class="example-bubble example-bubble--pink">' +
              '<p class="example-bubble__label">' + h.examplePrincessLabel + '</p>' +
              '<p class="example-bubble__text">' + templ(h.examplePrincessLine, exampleVars) + '</p>' +
            '</div>' +
            '<div class="example-bubble example-bubble--blue">' +
              '<p class="example-bubble__label">' + h.exampleToughLabel + '</p>' +
              '<p class="example-bubble__text">' + templ(h.exampleToughLine, exampleVars) + '</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  function renderWeek(c) {
    var w = c.week;
    var goCards = w.weekdayLabels.map(function (label) {
      return '<div class="week-card week-card--go">' +
        '<p class="week-card__label">' + label + '</p>' +
        '<p class="week-card__value">' + WS.DAILY_GOAL_STEPS.toLocaleString() + '</p>' +
        '<p class="week-card__unit">' + w.weekdayUnit + '</p>' +
      '</div>';
    }).join("");
    var graceCards = w.graceLabels.map(function (label) {
      return '<div class="week-card week-card--grace">' +
        '<p class="week-card__label">' + label + '</p>' +
        '<p class="week-card__value">' + w.graceValue + '</p>' +
        '<p class="week-card__unit">' + w.graceUnit + '</p>' +
      '</div>';
    }).join("");

    return '<section class="sec sec--cream">' +
      '<div class="sec__in">' +
        '<p class="eyebrow eyebrow--mono eyebrow--indigo">' + w.eyebrow + '</p>' +
        '<h2 class="display display--lg">' + w.headline + '</h2>' +
        '<p class="lede">' + w.body + '</p>' +
        '<div class="week-grid">' + goCards + graceCards + '</div>' +
      '</div>' +
    '</section>';
  }

  /* Coach preview: a non-binding toggle, local to this screen only -- see
     this file's header comment. coachPreviewMarkup() is shared between the
     initial render and the click handler that swaps it in place. */
  function coachPreviewMarkup(value, c) {
    var opt = c.coach.options[value];
    var bubbles = opt.schedule.map(function (m) {
      return '<div class="chat-bubble">' +
        '<p class="chat-bubble__time">' + m.time + '</p>' +
        '<p class="chat-bubble__text">' + escapeAttr(m.text) + '</p>' +
      '</div>';
    }).join("");
    return '<p class="eyebrow eyebrow--mono eyebrow--rose" id="coachPreviewEyebrow">' +
        templ(c.coach.previewEyebrow, { coachTitle: opt.previewTitle }) +
      '</p>' +
      '<div class="chat-stack">' + bubbles + '</div>';
  }

  function renderCoach(c) {
    var co = c.coach;
    var keys = Object.keys(co.options);
    var optionsHtml = keys.map(function (key) {
      var opt = co.options[key];
      var active = key === "princess";
      return '<button type="button" class="coach-option' + (active ? " is-active" : "") + '" data-coach="' + key + '">' +
        '<p class="coach-option__kicker">' + (active ? co.previewingLabel : co.tapToPreviewLabel) + '</p>' +
        '<p class="coach-option__title">' + opt.title + '</p>' +
        '<p class="coach-option__body">' + opt.body + '</p>' +
      '</button>';
    }).join("");

    return '<section class="sec sec--pink">' +
      '<div class="sec__in coach__in">' +
        '<div class="coach__copy">' +
          '<p class="eyebrow eyebrow--mono eyebrow--rose">' + co.eyebrow + '</p>' +
          '<h2 class="display display--lg">' + co.headline + '</h2>' +
          '<p class="lede">' + co.body + '</p>' +
          '<div class="coach-options" id="coachOptions">' + optionsHtml + '</div>' +
        '</div>' +
        '<div class="coach__preview" id="coachPreview">' + coachPreviewMarkup("princess", c) + '</div>' +
      '</div>' +
    '</section>';
  }

  function renderHowItWorks(c, vars) {
    var h = c.howItWorks;
    return '<section class="sec sec--cream">' +
      '<div class="sec__in">' +
        '<p class="eyebrow eyebrow--mono eyebrow--indigo">' + h.eyebrow + '</p>' +
        '<h2 class="display display--lg">' + h.headline + '</h2>' +
        '<div class="steps-grid">' +
          '<div class="step-card">' +
            '<p class="eyebrow eyebrow--mono eyebrow--indigo">' + h.step1Label + '</p>' +
            '<p class="step-card__title">' + h.step1Title + '</p>' +
            '<p class="step-card__body">' + templ(h.step1Body, vars) + '</p>' +
          '</div>' +
          '<div class="step-card">' +
            '<p class="eyebrow eyebrow--mono eyebrow--indigo">' + h.step2Label + '</p>' +
            '<p class="step-card__title">' + h.step2Title + '</p>' +
            '<p class="step-card__body">' + templ(h.step2Body, vars) + '</p>' +
          '</div>' +
        '</div>' +
        '<div class="outcome-grid">' +
          '<div class="outcome-card outcome-card--hit">' +
            '<p class="eyebrow eyebrow--mono eyebrow--green">' + h.hitLabel + '</p>' +
            '<p class="outcome-card__headline">' + templ(h.hitHeadline, vars) + '</p>' +
          '</div>' +
          '<div class="outcome-card outcome-card--miss">' +
            '<p class="eyebrow eyebrow--mono eyebrow--rose">' + h.missLabel + '</p>' +
            '<p class="outcome-card__headline">' + templ(h.missHeadline, vars) + '</p>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* Static preview of an in-app community feature -- see the
     couch6k-copy.js comment on COPY.steps.home.community for why the
     reply controls below are disabled rather than wired to nothing. */
  function communityCard(block) {
    var replies = block.replies.map(function (r) {
      return '<div class="reply">' +
        '<div class="reply__avatar" aria-hidden="true">' + escapeAttr(r.name.charAt(0).toUpperCase()) + '</div>' +
        '<div class="reply__body">' +
          '<p class="reply__meta"><strong>' + escapeAttr(r.name) + '</strong> <span>' + escapeAttr(r.time) + '</span></p>' +
          '<p class="reply__text">' + escapeAttr(r.text) + '</p>' +
        '</div>' +
      '</div>';
    }).join("");

    return '<div class="community-card">' +
      '<p class="eyebrow eyebrow--mono eyebrow--gold">' + block.label + '</p>' +
      '<p class="community-card__text">' + escapeAttr(block.text) + '</p>' +
      '<div class="vote-row">' +
        '<span class="vote-pill" aria-hidden="true">&#9650; ' + block.votes + ' &#9660;</span>' +
        '<span class="vote-count">' + block.replies.length + ' replies</span>' +
      '</div>' +
      '<div class="reply-list">' + replies + '</div>' +
      '<div class="reply-form">' +
        '<input type="text" class="reply-form__input" placeholder="' + escapeAttr(block.replyPlaceholder) + '" disabled aria-label="' + escapeAttr(block.replyPlaceholder) + '">' +
        '<button type="button" class="btn btn--ink btn--sm" disabled>' + escapeAttr(block.replyCta) + '</button>' +
      '</div>' +
    '</div>';
  }

  function renderCommunity(c) {
    var co = c.community;
    return '<section class="sec sec--yellow">' +
      '<div class="sec__in">' +
        '<h2 class="display display--lg">' + co.headline + '</h2>' +
        '<p class="lede">' + co.body + '</p>' +
        '<div class="community-grid">' + communityCard(co.quote) + communityCard(co.question) + '</div>' +
      '</div>' +
    '</section>';
  }

  var PRICE_CARD_TONES = ["lavender", "mint", "rose", "gold"];

  function renderPricing(c, vars) {
    var p = c.pricing;
    var cards = p.cards.map(function (card, i) {
      return '<div class="price-card price-card--' + PRICE_CARD_TONES[i % PRICE_CARD_TONES.length] + '">' +
        '<p class="eyebrow eyebrow--mono">' + card.label + '</p>' +
        '<p class="price-card__value">' + templ(card.value, vars) + '</p>' +
        '<p class="price-card__note">' + templ(card.note, vars) + '</p>' +
      '</div>';
    }).join("");

    return '<section class="sec sec--cream">' +
      '<div class="sec__in">' +
        '<p class="eyebrow eyebrow--mono eyebrow--indigo">' + p.eyebrow + '</p>' +
        '<h2 class="display display--lg">' + p.headline + '</h2>' +
        '<p class="lede">' + templ(p.body, vars) + '</p>' +
        '<div class="price-grid">' + cards + '</div>' +
        '<div class="total-card">' +
          '<div class="total-card__figure">' +
            '<p class="eyebrow eyebrow--mono">' + p.totalLabel + '</p>' +
            '<p class="total-card__value">' + vars.total + '</p>' +
          '</div>' +
          '<p class="total-card__note">' + templ(p.totalNote, vars) + '</p>' +
        '</div>' +
        '<p class="q-label" style="margin-top:28px">' + p.rulesLabel + '</p>' +
        '<div class="accordion">' +
          accordionItem("step-source", p.ruleStepSource.title, '<p>' + p.ruleStepSource.body + '</p>') +
          accordionItem("time-zone", p.ruleTimeZone.title, '<p>' + p.ruleTimeZone.body + '</p>') +
          accordionItem("cancellation", p.ruleCancellation.title, '<p>' + templ(p.ruleCancellation.body, vars) + '</p>') +
          accordionItem("payout", p.rulePayout.title, '<p>' + templ(p.rulePayout.body, vars) + '</p>') +
          accordionItem("edge-cases", p.ruleEdgeCases.title, '<p>' + p.ruleEdgeCases.body + '</p>') +
        '</div>' +
      '</div>' +
    '</section>';
  }

  function renderFinalCta(c, vars) {
    var f = c.finalCta;
    return '<section class="sec sec--periwinkle">' +
      '<div class="sec__in final-cta">' +
        '<div class="final-cta__copy">' +
          '<p class="eyebrow eyebrow--mono eyebrow--indigo">' + f.eyebrow + '</p>' +
          '<h2 class="display display--lg">' + templ(f.headline, vars) + '</h2>' +
          '<p class="lede">' + templ(f.body, vars) + '</p>' +
        '</div>' +
        '<button type="button" class="btn btn--ink js-cta">' + templ(f.ctaLabel, vars) + '</button>' +
      '</div>' +
      '<div class="final-cta__footer">' +
        '<span class="wordmark wordmark--sm">walka</span>' +
        '<div class="final-cta__legal"><a href="/terms">Terms of Service</a><a href="/privacy">Privacy Policy</a></div>' +
        '<span class="final-cta__domain">getwalka.com</span>' +
      '</div>' +
    '</section>';
  }

  /* ---------------- step definitions ---------------- */
  /* Each step: render() -> HTML, bind(root) attach listeners, canAdvance()
     -> bool, onEnter()/onLeave() optional. Just two steps: the homepage
     (a full landing page, not a quiz card -- see renderStep's
     document.body.classList.toggle("is-home", ...)) and checkout. */

  var steps = {

    home: {
      hideNav: true, // the page carries its own CTA buttons; no shared flownav
      onEnter: function () {
        track(EVENTS.homeViewed, { local_id: state.localId });
        syncLead();
      },
      render: function () {
        var c = COPY.steps.home;
        var vars = commonVars();
        return renderHero(c, vars) +
          renderWeek(c) +
          renderCoach(c) +
          renderHowItWorks(c, vars) +
          renderCommunity(c) +
          renderPricing(c, vars) +
          renderFinalCta(c, vars);
      },
      bind: function (root) {
        bindAccordion(root);

        root.querySelectorAll(".js-cta").forEach(function (btn) {
          btn.addEventListener("click", function () { goNext(); });
        });

        var co = COPY.steps.home.coach;
        var preview = root.querySelector("#coachPreview");
        root.querySelectorAll("#coachOptions .coach-option").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var value = btn.getAttribute("data-coach");
            root.querySelectorAll("#coachOptions .coach-option").forEach(function (b) {
              var isActive = b === btn;
              b.classList.toggle("is-active", isActive);
              var kicker = b.querySelector(".coach-option__kicker");
              if (kicker) kicker.textContent = isActive ? co.previewingLabel : co.tapToPreviewLabel;
            });
            if (preview) preview.innerHTML = coachPreviewMarkup(value, COPY.steps.home);
            track(EVENTS.coachPreviewed, { coach: value });
          });
        });
      },
      canAdvance: function () { return true; }
    },

    checkout: {
      render: function (a) {
        var c = COPY.steps.checkout;
        var vars = commonVars();
        var currency = checkoutCurrency(a);
        var feeCents = convertedCents(WS.FEE_CENTS, currency);
        var stakeCents = convertedCents(WS.STAKE_CENTS, currency);
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="charge-breakdown">' +
            '<div class="charge-breakdown__row"><span>' + c.feeRowLabel + '</span><strong>' + centsLabel(feeCents) + ' ' + currency.toUpperCase() + '</strong></div>' +
            '<div class="charge-breakdown__row"><span>' + templ(c.stakeRowLabel, vars) + '</span><strong>' + centsLabel(stakeCents) + ' ' + currency.toUpperCase() + '</strong></div>' +
          '</div>' +
          '<p class="q-hint">' + templ(c.billingNoteBase, vars) + '</p>' +
          '<p class="q-label">' + c.includedLabel + '</p>' +
          '<div class="recap"><ul class="recap__list">' +
            c.includedItems.map(function (t) { return '<li>' + templ(t, vars) + '</li>'; }).join("") +
          '</ul></div>' +
          '<label class="field"><span>' + c.nameLabel + '</span><input type="text" id="firstName" value="' + escapeAttr(a.first_name || "") + '" autocomplete="given-name"></label>' +
          '<label class="field"><span>' + c.emailLabel + '</span><input type="email" id="email" value="' + escapeAttr(a.email || "") + '" placeholder="you@example.com" autocomplete="email"></label>' +
          '<label class="checkline"><input type="checkbox" id="agreeCheck"> ' + c.agreePrefix +
            ' <a href="' + c.legalLinks.terms + '" target="_blank" rel="noopener">' + c.agreeTermsText + '</a> ' + c.agreeJoiner +
            ' <a href="' + c.legalLinks.privacy + '" target="_blank" rel="noopener">' + c.agreePrivacyText + '</a></label>' +
          (WS.STRIPE_MODE === "test" ? '<p class="q-note">' + c.testModeNote + '</p>' : '') +
          '<div id="paymentElementContainer" class="payment-pending"><p class="q-hint">' + c.paymentPlaceholder + '</p></div>' +
          '<button type="button" class="btn btn--ink" id="payBtn" style="width:100%;margin-top:8px" disabled>' + templ(c.confirmCta, vars) + '</button>' +
          '<p class="q-error" id="checkoutError" hidden></p>';
      },
      bind: function (root) {
        var c = COPY.steps.checkout;
        var vars = commonVars();
        var name = root.querySelector("#firstName"), email = root.querySelector("#email");
        var agree = root.querySelector("#agreeCheck"), pay = root.querySelector("#payBtn"), err = root.querySelector("#checkoutError");
        var paymentContainer = root.querySelector("#paymentElementContainer");

        var stripeClient = null, elements = null;
        var initiated = false, mounted = false, alreadyActive = false;
        var debounceTimer = null;
        var confirmCtaText = templ(c.confirmCta, vars);

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
          window.location.href = "/myplan-success";
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
                confirmParams: { return_url: window.location.origin + "/myplan-success" },
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

  function renderStep(trackView) {
    var id = currentStepId();
    var step = steps[id];
    document.body.classList.toggle("is-home", id === "home");
    navEl.hidden = id === "home";
    footerEl.hidden = id === "home"; // the homepage's final-cta section carries its own Terms/Privacy footer
    screenEl.innerHTML = step.render(state.answers);
    step.bind(screenEl);
    screenEl.className = id === "home" ? "landing" : "card";
    void screenEl.offsetWidth;
    screenEl.classList.add("card--enter");
    var hideNav = id === "checkout" ? false : !!step.hideNav;
    flownavEl.hidden = hideNav;
    backBtn.hidden = state.stepIndex === 0;
    continueBtn.hidden = true; // neither step uses the shared Continue button
    skipBtn.hidden = true; // no optional/skippable questions in this funnel
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
      resumeBanner.hidden = true;
      renderStep();
      window.scrollTo(0, 0);
    }
  }

  function goBack() {
    if (state.stepIndex > 0) {
      state.stepIndex--;
      resumeBanner.hidden = true;
      renderStep();
      window.scrollTo(0, 0);
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
    resumeBanner = document.getElementById("resumeBanner");
    resumeBannerText = document.getElementById("resumeBannerText");
    resumeBannerDismiss = document.getElementById("resumeBannerDismiss");
    gateEl = document.getElementById("gate");
    appEl = document.getElementById("app");
    loadingEl = document.getElementById("loading");
    mainEl = document.getElementById("top");
    exitLink = document.getElementById("exitLink");
    flownavEl = document.querySelector(".flownav");
    navEl = document.querySelector(".nav");
    footerEl = document.querySelector(".footer");

    continueBtn.addEventListener("click", function () { goNext(); });
    backBtn.addEventListener("click", goBack);
    resumeBannerDismiss.addEventListener("click", function () { resumeBanner.hidden = true; });

    maybeRehydrateFromLink().then(function () { initGate(); });
  });
})();
