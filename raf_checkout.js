/* ============================================================
   RAFCO — shared checkout-flow logic (Cart · Checkout · Confirmation)
   Totals, shipping, coupons, grouping, i18n. One implementation only.
   Requires raf_data.js (RAFShop).
   ============================================================ */
(function () {
  if (window.RAFCO) return;

  var SHIP = 1.000;        /* per-store delivery fee */
  var FREE_OVER = 25.000;  /* free delivery threshold (per order subtotal) */
  /* THE coupon source of truth is RAFMarketing. This map is a live view of it
     so the existing `RAFCO.COUPONS[code]` callers keep working unchanged,
     while there is only one place a coupon can actually be defined.
     It falls back to the original five codes only when the marketing
     authority is not loaded on a page, so nothing regresses. */
  var COUPON_FALLBACK = { WELCOME20: 20, FLASH10: 10, VIP30: 30, RAMADAN25: 25, SUMMER15: 15 };
  function couponMap() {
    if (!window.RAFMarketing) return COUPON_FALLBACK;
    var out = {};
    RAFMarketing.coupons().forEach(function (c) {
      /* only a usable coupon appears in the map, so a code that has expired
         or been switched off can no longer be applied — the dates the
         customer is shown are now the dates that are enforced */
      if (c.status === RAFMarketing.STATUS.ACTIVE) out[c.code] = c.value;
    });
    return out;
  }
  /* the authority's own answer, with a typed reason when it refuses */
  function checkCoupon(code, ctx) {
    if (window.RAFMarketing) return RAFMarketing.checkCoupon(code, ctx);
    var pct = COUPON_FALLBACK[String(code || '').trim().toUpperCase()];
    return pct ? { ok:true, code:String(code).trim().toUpperCase(), pct:pct }
               : { ok:false, code:'UNKNOWN_CODE', message:T('رمز الكوبون غير صالح','Invalid coupon code') };
  }

  function root() { return document.getElementById('htmlRoot') || document.documentElement; }
  function en() { return root().lang === 'en'; }
  function T(ar, e) { return en() ? e : ar; }
  function L(o) { return (o && typeof o === 'object') ? (en() ? o.en : o.ar) : (o || ''); }
  function money(n) { return (Math.round(n * 1000) / 1000).toFixed(3); }
  function price(l) { return parseFloat(l.price) || 0; }

  function get(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function getJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function setJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ---------- catalog (variants + stock, used for in-cart editing) ----------
     Reads the central authority. The local copy this replaced had drifted out
     of sync — it still listed stock for products the marketplace had marked
     sold out, which let checkout accept an unavailable item. */
  function catalogFor(id) { return (window.RAFCatalog && RAFCatalog.get) ? RAFCatalog.get(id) : null; }
  function catalogAll() { return (window.RAFCatalog && RAFCatalog.list) ? RAFCatalog.list({ visibleOnly:false }) : []; }

  /* a cart line is unavailable when the central record says so */
  function isOOS(l) {
    if (!l) return false;
    if (window.RAFShop && RAFShop.Stock) return RAFShop.Stock.isOOS({ id: l.id, stock: l.stock, available: l.available });
    if (l.available === false || l.stock === 0) return true;
    var p = catalogFor(l.id);
    return !!(p && p.stock === 0);
  }

  /* ---------- grouping ---------- */
  function groupByStore(items) {
    var map = {}, order = [];
    items.forEach(function (l) {
      var p = catalogFor(l.id);
      var st = l.store || (p && p.store) || { ar: 'رف', en: 'RAF' };
      var name = L(st);
      if (!map[name]) { map[name] = { name: name, items: [] }; order.push(name); }
      map[name].items.push(l);
    });
    return order.map(function (n) { return map[n]; });
  }

  /* ---------- coupon + totals ---------- */
  function getCoupon() { return getJSON('raf_coupon', null); }
  function setCoupon(c) { if (c) setJSON('raf_coupon', c); else { try { localStorage.removeItem('raf_coupon'); } catch (e) {} } }
  function shipFor(sub) { return sub >= FREE_OVER || sub === 0 ? 0 : SHIP; }
  function getTip() { return parseFloat(get('raf_tip', '0')) || 0; }
  function setTip(v) { set('raf_tip', String(v)); }

  /* ══════════════════════════════════════════════════════════════
     LINE-LEVEL PRICING — the one engine
     ──────────────────────────────────────────────────────────────
     Every discount is computed per line and then summed. There is no
     order-level percentage anywhere in the authoritative result:

       line.lineDiscount  — what this line actually gave up
       line.finalPrice    — unitPrice * qty - lineDiscount
       disc               — sum(lineDiscount), by construction

     Rounding follows the existing convention (3 decimals / fils). Each
     line is rounded to fils first and the order discount is the sum of
     those rounded values, so sum(lines) == order total exactly and no
     rounding residue can appear.

     ONE DISCOUNT PER ORDER is the approved rule. When a customer has
     applied a coupon it replaces the store's automatic promotion rather
     than stacking with it — an explicit customer action wins over an
     automatic one. That precedence is decided here, once.
     ══════════════════════════════════════════════════════════════ */
  var COUPON_OVERRIDES_PROMOTION = true;

  function fils(n){ return Math.round(n * 1000); }
  function fromFils(n){ return n / 1000; }

  /* the store a cart line belongs to, by stable slug */
  function slugOf(l){
    if (!window.RAFCatalog) return null;
    var p = RAFCatalog.get(l.id);
    return (p && p.slug) || null;
  }

  /* Decide the percentage for each line, then compute its money.
     Returns the priced lines plus the source that produced the discount. */
  function priceLines(items) {
    var coupon = getCoupon();
    var cartSlug = items.length ? slugOf(items[0]) : null;
    var couponOk = false;

    /* a stored coupon is re-proved every time totals() runs, so a coupon that
       expired or was switched off since it was applied stops discounting */
    if (coupon) {
      var chk = checkCoupon(coupon.code, { storeSlug: cartSlug });
      couponOk = !!chk.ok;
      if (couponOk) coupon = { code: chk.code, pct: chk.pct };
    }
    var useCoupon = couponOk && COUPON_OVERRIDES_PROMOTION;

    var lines = items.map(function (l) {
      var unit = price(l), qty = l.qty || 1;
      var gross = fils(unit * qty);
      var pct = 0, source = null;

      if (useCoupon) { pct = coupon.pct; source = 'coupon'; }
      else if (window.RAFMarketing) {
        /* eligibility is the marketing authority's answer, never the page's */
        var p = RAFMarketing.promotionPctFor(l.id, slugOf(l));
        if (p > 0) { pct = p; source = 'promotion'; }
      }

      var dFils = pct > 0 ? Math.round(gross * pct / 100) : 0;
      if (dFils > gross) dFils = gross;          /* never a negative line */
      if (dFils < 0) dFils = 0;

      return {
        key: l.key, id: l.id, qty: qty,
        unitPrice: unit,
        gross: fromFils(gross),
        lineDiscountPct: pct,
        lineDiscount: fromFils(dFils),
        finalPrice: fromFils(gross - dFils),
        discountSource: source
      };
    });

    return { lines: lines, coupon: couponOk ? coupon : null,
             couponInvalid: !!(getCoupon() && !couponOk) };
  }

  function totals(items, opts) {
    opts = opts || {};
    items = items || RAFShop.Cart.items();
    var priced = priceLines(items);

    var sub = items.reduce(function (s, l) { return s + price(l) * l.qty; }, 0);
    var count = items.reduce(function (s, l) { return s + l.qty; }, 0);
    /* delivery is charged per store, and waived per store above the threshold */
    var ship = groupByStore(items).reduce(function (s, g) {
      return s + shipFor(g.items.reduce(function (x, l) { return x + price(l) * l.qty; }, 0));
    }, 0);

    /* THE order discount is the sum of the lines — never an independent figure */
    var discFils = priced.lines.reduce(function (s, l) { return s + fils(l.lineDiscount); }, 0);
    var disc = fromFils(discFils);

    var tip = opts.withTip ? getTip() : 0;
    var total = Math.max(0, sub - disc) + ship + tip;

    /* which mechanism produced the discount, for the customer-facing wording */
    var source = null;
    for (var i = 0; i < priced.lines.length; i++) {
      if (priced.lines[i].discountSource) { source = priced.lines[i].discountSource; break; }
    }
    var promo = (source === 'promotion' && window.RAFMarketing)
      ? RAFMarketing.activePromotion(items.length ? slugOf(items[0]) : null) : null;

    return { sub: sub, count: count, ship: ship, disc: disc, tip: tip, total: total,
             coupon: priced.coupon, couponInvalid: priced.couponInvalid,
             /* the authoritative line-level result */
             lines: priced.lines, discountSource: source, promotion: promo };
  }
  /* a lookup for surfaces that need one line's pricing */
  function lineOf(items, key){
    var t = totals(items);
    for (var i = 0; i < t.lines.length; i++) if (t.lines[i].key === key) return t.lines[i];
    return null;
  }

  /* ---------- i18n ---------- */
  function applyLang() {
    var e = en();
    document.querySelectorAll('[data-ar]').forEach(function (el) {
      var t = el.getAttribute('data-' + (e ? 'en' : 'ar')); if (t !== null) el.textContent = t;
    });
    document.querySelectorAll('[data-ar-ph]').forEach(function (el) {
      var t = el.getAttribute('data-' + (e ? 'en-ph' : 'ar-ph')); if (t !== null) el.placeholder = t;
    });
    var lbl = document.getElementById('langLabel'); if (lbl) lbl.textContent = e ? 'ع' : 'EN';
  }
  window.toggleLang = function () {
    var r = root(), e = r.lang === 'en';
    r.lang = e ? 'ar' : 'en'; r.dir = e ? 'rtl' : 'ltr';
    set('raf_lang', r.lang); applyLang();
  };
  (function initLang() {
    var l = get('raf_lang', null);
    if (l) { var r = root(); r.lang = l; r.dir = l === 'en' ? 'ltr' : 'rtl'; }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', applyLang); else applyLang();
  })();

  window.RAFCO = {
    en: en, T: T, L: L, money: money, price: price,
    /* live view — kept readable as an array for existing callers */
    get CATALOG() { return catalogAll(); },
    get: get, set: set, getJSON: getJSON, setJSON: setJSON,
    catalogFor: catalogFor, isOOS: isOOS,
    groupByStore: groupByStore, totals: totals, lineOf: lineOf,
    SHIP: SHIP, FREE_OVER: FREE_OVER, shipFor: shipFor,
    get COUPONS() { return couponMap(); }, checkCoupon: checkCoupon,
    getCoupon: getCoupon, setCoupon: setCoupon,
    getTip: getTip, setTip: setTip, applyLang: applyLang
  };
})();
