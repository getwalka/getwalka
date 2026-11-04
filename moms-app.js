/* ==========================================================================
   Walka Mom funnel, ENGINE
   Two-screen flow (home -> checkout), gate, resume-from-localStorage,
   analytics events, Supabase sync, one-time-charge Stripe checkout (moved
   off a recurring membership 2026-11-03 -- see moms-copy.js's PAYMENTS
   section). All copy/config lives in moms-copy.js. Structure mirrors
   couch6k-app.js (the November-challenge funnel already made this same
   landing+checkout move AND is itself a one-time charge, same pattern);
   see that file's comments for the parts that are identical (uuid/state/
   sync/gate plumbing).

   The homepage is a full marketing-style landing page (hero, feature
   blocks, how-it-works, testimonials, final CTA), not a quiz card -- it
   renders its own full-bleed sections and escapes the narrow centered
   "shell" that checkout still uses (see body.is-home in moms.html's CSS).
   ========================================================================== */
(function () {
  "use strict";

  var WM = window.WALKA_MOMS;
  var COPY = WM.COPY;
  var EVENTS = WM.EVENTS;
  /* v7: the step schema changed (13-step quiz -> this 2-step landing page
     redesign). Bumped so a phone that tested an earlier version doesn't
     load a stepIndex that no longer maps to a real step -- see the
     loadState() bounds check below. moms-success.html reads the same key
     and must be bumped in lockstep. */
  var STORAGE_KEY = "walka_moms_state_v7";
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
        window.posthog.capture(event, props || {});
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
     gets its own currency (same numeral, not a converted equivalent). */
  function checkoutCurrency(a) {
    return a.country === "CA" ? "cad" : "usd";
  }

  function centsLabel(cents) {
    return "$" + (cents / 100).toFixed(2).replace(/\.00$/, "");
  }

  function templ(str, map) {
    return Object.keys(map).reduce(function (s, key) {
      return s.split("{" + key + "}").join(map[key]);
    }, str);
  }

  /* supabase-js's FunctionsHttpError.message is always the generic "Edge
     Function returned a non-2xx status code" -- unwraps the Edge Function's
     real { error: "..." } body, same helper couch6k-app.js uses. */
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

  /* The resolved price for this visitor: state.answers.price_cents is set
     once, early (see resolvePriceTier()), and persisted to localStorage +
     Supabase so a resumed session never shows a different price than the
     one it started with. Falls back to the safe default tier if somehow
     unset (e.g. a pre-pricing-flag saved session). */
  function currentPriceCents() {
    return state.answers.price_cents || WM.PRICE_TIERS.default;
  }

  /* Every placeholder the homepage/checkout copy templates reference. */
  function commonVars() {
    var currency = checkoutCurrency(state.answers);
    var suffix = currency === "cad" ? " CAD" : "";
    return {
      price: centsLabel(currentPriceCents()) + suffix
    };
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
        // undefined and crash before the page ever paints.
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
  if (window.supabase && WM.SUPABASE_URL.indexOf("REPLACE_ME") === -1 && WM.SUPABASE_ANON_KEY.indexOf("REPLACE_ME") === -1) {
    try { sbClient = window.supabase.createClient(WM.SUPABASE_URL, WM.SUPABASE_ANON_KEY); } catch (e) { sbClient = null; }
  } else {
    console.warn("[moms-flow] Supabase URL/key not configured yet.");
  }

  function syncLead(extra) {
    if (!sbClient) return Promise.resolve();
    var a = state.answers;
    var row = Object.assign({
      local_id: state.localId,
      updated_at: new Date().toISOString(),
      country: a.country || null,
      plan_price_cents: currentPriceCents(),
      billing_currency: checkoutCurrency(a),
      email: a.email || null,
      first_name: a.first_name || null,
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
     only thing that lets this device find their saved progress. */
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
            price_cents: row.plan_price_cents || null, // resume at the same price they originally saw, never re-roll the flag
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

  /* ---------------- DOM refs ---------------- */

  var screenEl, continueBtn, backBtn, skipBtn, resumeBanner, resumeBannerText, resumeBannerDismiss, gateEl, appEl, loadingEl, mainEl, exitLink, flownavEl, navEl, footerEl, stickyCta;

  /* ====================================================================
     HOME step: section renderers. One function per section on the page,
     top to bottom.
     ==================================================================== */

  /* Concentric-circle "moiré ring" decoration (two overlapping sets of
     circles, offset from each other) -- a plain CSS gradient can't
     produce this interference-pattern look, so it's built as inline SVG.
     Purely decorative (aria-hidden), colored via the .ring-motif circle
     CSS rule, not inline, so it always follows the page's rose token. */
  function ringMotif(size, extraClass) {
    var cx1 = size * 0.42, cx2 = size * 0.58, cy = size * 0.5;
    var n = 14, maxR = size * 0.46;
    var circles = "";
    for (var i = 0; i < n; i++) {
      var r1 = (4 + i * (maxR / n)).toFixed(1);
      circles += '<circle cx="' + cx1 + '" cy="' + cy + '" r="' + r1 + '"/>';
    }
    for (var j = 0; j < n; j++) {
      var r2 = (4 + j * (maxR / n)).toFixed(1);
      circles += '<circle cx="' + cx2 + '" cy="' + cy + '" r="' + r2 + '"/>';
    }
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" class="ring-motif' + (extraClass ? " " + extraClass : "") + '" aria-hidden="true">' + circles + '</svg>';
  }

  function renderHero(c, vars) {
    var h = c.hero;
    var headlineRaw = h.headline;
    var highlightIndex = headlineRaw.indexOf(h.headlineHighlight);
    var headlineHtml;
    if (highlightIndex !== -1) {
      var before = escapeAttr(headlineRaw.slice(0, highlightIndex).trim());
      var highlight = escapeAttr(headlineRaw.slice(highlightIndex));
      headlineHtml = before + '<br>' + '<span class="hl">' + highlight + '</span>';
    } else {
      headlineHtml = escapeAttr(headlineRaw);
    }

    return '<section class="sec sec--hero">' +
      '<div class="sec__in hero__in">' +
        '<div class="hero__top">' +
          '<span class="wordmark">walka mom</span>' +
        '</div>' +
        '<div class="hero__grid">' +
          '<div class="hero__copy">' +
            '<p class="eyebrow eyebrow--mono">' + h.eyebrow + '</p>' +
            '<h1 class="display display--xl">' + headlineHtml + '</h1>' +
            '<p class="lede">' + h.body + '</p>' +
            '<p class="hero__subline">' + templ(h.subhead, vars) + '</p>' +
            '<p class="hero__subline hero__subline--muted">' + h.anonymityNote + '</p>' +
            '<div class="hero__cta-row">' +
              '<button type="button" class="btn btn--cream js-cta">' + templ(h.ctaLabel, vars) + '</button>' +
            '</div>' +
          '</div>' +
          '<div class="hero__media">' +
            ringMotif(180, "ring-motif--hero") +
            '<div class="hero__media-card"><img src="images/feature-pace.jpg" alt="A mom walking with a stroller" loading="eager"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* Plain icon+text cards (no imagery): three short, scannable features.
     The one feature that does pair well with an existing illustration
     (the matched mom group) gets its own dedicated spotlight below
     instead of being squeezed into this grid, so no image here is
     awkwardly reused across unrelated features. */
  function renderFeatures(c) {
    var f = c.features;
    var cards = f.items.map(function (item) {
      return '<div class="step-card">' +
        '<p style="font-size:1.6rem;line-height:1;margin-bottom:10px" aria-hidden="true">' + item.icon + '</p>' +
        '<p class="step-card__title">' + escapeAttr(item.title) + '</p>' +
        '<p class="step-card__body">' + escapeAttr(item.body) + '</p>' +
      '</div>';
    }).join("");

    return '<section class="sec sec--alt">' +
      '<div class="sec__in">' +
        '<p class="eyebrow eyebrow--mono" style="text-align:center">' + f.eyebrow + '</p>' +
        '<div class="steps-grid">' + cards + '</div>' +
      '</div>' +
    '</section>';
  }

  /* The one feature paired with real imagery: the existing "moms at a
     park together" illustration, already used by this funnel pre-quiz. */
  function renderCommunity(c) {
    var co = c.community;
    return '<section class="sec sec--hero">' +
      '<div class="sec__in spotlight">' +
        '<div class="spotlight__media"><img src="images/feature-circle.jpg" alt="A group of moms together with their babies at a park" loading="lazy"></div>' +
        '<div class="spotlight__copy">' +
          '<p class="eyebrow eyebrow--mono">' + co.eyebrow + '</p>' +
          '<h2 class="display display--lg">' + co.headline + '</h2>' +
          '<p class="lede" style="margin-bottom:0">' + co.body + '</p>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  function renderHowItWorks(c) {
    var h = c.howItWorks;
    var cards = h.items.map(function (item) {
      return '<div class="step-card">' +
        '<p class="eyebrow eyebrow--mono">' + item.label + '</p>' +
        '<p class="step-card__title">' + escapeAttr(item.title) + '</p>' +
        '<p class="step-card__body">' + escapeAttr(item.body) + '</p>' +
      '</div>';
    }).join("");

    return '<section class="sec sec--alt">' +
      '<div class="sec__in">' +
        '<p class="eyebrow eyebrow--mono" style="text-align:center">' + h.eyebrow + '</p>' +
        '<h2 class="display display--lg" style="text-align:center;margin-left:auto;margin-right:auto">' + h.headline + '</h2>' +
        '<div class="steps-grid">' + cards + '</div>' +
      '</div>' +
    '</section>';
  }

  function renderFinalCta(c, vars) {
    var f = c.finalCta;
    return '<section class="sec sec--alt">' +
      ringMotif(160, "ring-motif--final") +
      '<div class="sec__in final-cta">' +
        '<div class="final-cta__copy">' +
          '<h2 class="display display--lg">' + f.headline + '</h2>' +
          '<p class="lede">' + templ(f.priceNote, vars) + '</p>' +
          '<span class="guarantee-badge">' + f.guarantee + '</span>' +
        '</div>' +
        '<button type="button" class="btn btn--cream js-cta">' + f.ctaLabel + '</button>' +
      '</div>' +
      '<div class="sec__in">' +
        '<p class="q-disclaimer" style="margin-top:0">' + f.footerDisclaimer + '</p>' +
        '<div class="final-cta__footer">' +
          '<span class="wordmark wordmark--sm">walka</span>' +
          '<div class="final-cta__legal"><a href="/moms-terms">Terms of Service</a><a href="/moms-privacy">Privacy Policy</a></div>' +
          '<span class="final-cta__domain">getwalka.com</span>' +
        '</div>' +
      '</div>' +
    '</section>';
  }

  /* ---------------- step definitions ---------------- */
  /* Just two steps: the homepage (a full landing page, not a quiz card --
     see renderStep's document.body.classList.toggle("is-home", ...)) and
     checkout. */

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
          renderFeatures(c) +
          renderCommunity(c) +
          renderHowItWorks(c) +
          renderFinalCta(c, vars);
      },
      bind: function (root) {
        root.querySelectorAll(".js-cta").forEach(function (btn) {
          btn.addEventListener("click", function () { goNext(); });
        });
      },
      canAdvance: function () { return true; }
    },

    checkout: {
      render: function (a) {
        var c = COPY.steps.checkout;
        var vars = commonVars();
        return '<h2 class="q-title">' + c.title + '</h2>' +
          '<p class="q-body">' + c.intro + '</p>' +
          '<div class="price-tag">' + vars.price + '</div>' +
          '<p class="q-hint">' + c.billingNote + '</p>' +
          '<p class="q-note">' + c.guaranteeNote + '</p>' +
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
          (WM.STRIPE_MODE === "test" ? '<p class="q-note">' + c.testModeNote + '</p>' : '') +
          '<div id="paymentElementContainer" class="payment-pending"><p class="q-hint">' + c.paymentPlaceholder + '</p></div>' +
          '<button type="button" class="btn btn--ink" id="payBtn" style="width:100%;margin-top:8px" disabled>' + templ(c.confirmCta, vars) + '</button>' +
          '<p class="q-error" id="checkoutError" hidden></p>';
      },
      bind: function (root) {
        var c = COPY.steps.checkout;
        var vars = commonVars();
        var confirmCtaText = templ(c.confirmCta, vars);
        var name = root.querySelector("#firstName"), email = root.querySelector("#email");
        var agree = root.querySelector("#agreeCheck"), pay = root.querySelector("#payBtn"), err = root.querySelector("#checkoutError");
        var paymentContainer = root.querySelector("#paymentElementContainer");

        /* No "continue" click: the intent is created automatically, in the
           background, the moment name/email/terms are all valid (debounced
           so we don't fire on every keystroke), and the Payment Element
           replaces the dimmed placeholder as soon as it mounts. The Pay
           button stays disabled until both that AND the fields are valid.
           No redirect fallback (same as the November-challenge funnel):
           if Stripe.js never loaded or the intent call fails, checkout
           shows an error rather than sending anyone somewhere that could
           confirm a different amount than what was just shown. */
        var stripeClient = null, elements = null;
        var initiated = false; // intent creation started (or already done)
        var mounted = false;   // Payment Element is actually on the page
        var alreadyPaid = false;
        var debounceTimer = null;

        function fieldsValid() {
          return name.value.trim().length > 0 && agree.checked && /\S+@\S+\.\S+/.test(email.value.trim());
        }
        function refreshButton() {
          pay.disabled = !((mounted || alreadyPaid) && fieldsValid());
          if (!pay.disabled || pay.textContent !== c.processingCta) pay.textContent = confirmCtaText;
        }

        function showError(msg) {
          err.textContent = msg;
          err.hidden = false;
        }

        function startInlineCheckout(currency) {
          var pk = WM.STRIPE_PUBLISHABLE_KEY[WM.STRIPE_MODE];
          if (!window.Stripe || !pk || pk.indexOf("REPLACE_ME") !== -1) {
            showError("Payment isn't configured yet. Add the publishable key to moms-copy.js.");
            track(EVENTS.checkoutFailed, { reason: "missing_publishable_key" });
            return;
          }
          sbClient.functions.invoke("create-moms-payment-intent", {
            body: { local_id: state.localId, email: email.value.trim(), name: name.value.trim(), currency: currency, price_cents: currentPriceCents() }
          }).then(function (res) {
            if (res.error) throw res.error;
            var data = res.data || {};
            if (data.error) throw new Error(data.error);

            if (data.alreadyActive) {
              alreadyPaid = true;
              paymentContainer.className = "";
              paymentContainer.innerHTML = '<p class="q-hint">Payment already received. Ready when you are.</p>';
              refreshButton();
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

            track(EVENTS.checkoutStarted, { local_id: state.localId, plan_price_cents: currentPriceCents(), currency: currency });
          }).catch(function (e) {
            describeFunctionError(e).then(function (described) {
              console.warn("[moms checkout] create-moms-payment-intent failed", described);
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

            var currency = checkoutCurrency(state.answers);
            state.answers.checkout_status = "started";
            state.answers.billing_currency = currency;
            saveState();

            /* The real email just typed needs to land in Supabase before
               create-moms-payment-intent reads it back, but a
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

          var paymentConfirmed = alreadyPaid
            ? Promise.resolve()
            : stripeClient.confirmPayment({
                elements: elements,
                confirmParams: { return_url: window.location.origin + "/moms-success" },
                redirect: "if_required"
              }).then(function (result) {
                if (result.error) throw result.error;
              });

          paymentConfirmed.then(function () {
            // Confirmed without a redirect (no 3D Secure challenge needed);
            // a challenge would have sent the browser to return_url itself.
            state.answers.checkout_status = "completed_unverified";
            saveState();
            track(EVENTS.checkoutCompleted, { local_id: state.localId, plan_price_cents: currentPriceCents() });
            window.location.href = "/moms-success";
          }).catch(function (e) {
            showError((e && e.message) || c.genericError);
            refreshButton();
            track(EVENTS.checkoutFailed, { reason: "confirm_error" });
          });
        }

        pay.addEventListener("click", function () {
          if (!(mounted || alreadyPaid)) return; // guarded by disabled state anyway
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

  /* ---------------- flow control ---------------- */

  function currentStepId() { return STEP_IDS[state.stepIndex]; }

  function renderStep(trackView) {
    var id = currentStepId();
    var step = steps[id];
    document.body.classList.toggle("is-home", id === "home");
    navEl.hidden = id === "home";
    footerEl.hidden = id === "home"; // the homepage's final-cta section carries its own Terms/Privacy footer
    stickyCta.hidden = id !== "home"; // lives outside #screen, so it isn't reset/rebound by step.bind() below
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

  /* drop-off: best-effort signal fired if the tab is hidden/closed before checkout completes */
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

  /* Resolves state.answers.price_cents once per session. Never re-rolls an
     already-resolved price (a prior visit on this device, or a rehydrated
     cross-device session, both set it already) -- a visitor must see and
     be charged the same price throughout. ?price=19 / ?price=29 overrides
     the flag for QA, same convention as ?preview=1. Reading the flag can
     only make PRICE_TIERS.discount ($19.99) apply; any failure (no
     PostHog, flag unresolved, thrown error) leaves the safe default
     ($29.99) in place. */
  function resolvePriceTier() {
    if (state.answers.price_cents) return;
    var override = getQueryParam("price");
    if (override === "19") { state.answers.price_cents = WM.PRICE_TIERS.discount; return; }
    if (override === "29") { state.answers.price_cents = WM.PRICE_TIERS.default; return; }
    var discount = false;
    try { discount = !!(window.posthog && posthog.isFeatureEnabled(WM.PRICE_FLAG_KEY)); } catch (e) { discount = false; }
    state.answers.price_cents = discount ? WM.PRICE_TIERS.discount : WM.PRICE_TIERS.default;
  }

  function startFlow() {
    resolvePriceTier();
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
       (used for checkout currency and analytics), even in preview mode. */
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
    stickyCta = document.getElementById("stickyCta");

    continueBtn.addEventListener("click", function () { goNext(); });
    backBtn.addEventListener("click", goBack);
    resumeBannerDismiss.addEventListener("click", function () { resumeBanner.hidden = true; });
    stickyCta.querySelector(".js-cta").addEventListener("click", function () { goNext(); });

    maybeRehydrateFromLink().then(function () { initGate(); });
  });
})();
