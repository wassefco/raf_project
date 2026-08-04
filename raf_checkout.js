/* ============================================================
   RAFCO — shared checkout-flow logic (Cart · Checkout · Confirmation)
   Totals, shipping, coupons, grouping, i18n. One implementation only.
   Requires raf_data.js (RAFShop).
   ============================================================ */
(function () {
  if (window.RAFCO) return;

  var SHIP = 1.000;        /* per-store delivery fee */
  var FREE_OVER = 25.000;  /* free delivery threshold (per order subtotal) */
  /* single source of truth for valid codes — shared by the cart and the
     Offers Center so a coupon behaves identically from either entry point */
  var COUPONS = { WELCOME20: 20, FLASH10: 10, VIP30: 30, RAMADAN25: 25, SUMMER15: 15 };

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

  function totals(items, opts) {
    opts = opts || {};
    items = items || RAFShop.Cart.items();
    var sub = items.reduce(function (s, l) { return s + price(l) * l.qty; }, 0);
    var count = items.reduce(function (s, l) { return s + l.qty; }, 0);
    /* delivery is charged per store, and waived per store above the threshold */
    var ship = groupByStore(items).reduce(function (s, g) {
      return s + shipFor(g.items.reduce(function (x, l) { return x + price(l) * l.qty; }, 0));
    }, 0);
    var c = getCoupon();
    var disc = c ? sub * (c.pct / 100) : 0;
    var tip = opts.withTip ? getTip() : 0;
    var total = Math.max(0, sub - disc) + ship + tip;
    return { sub: sub, count: count, ship: ship, disc: disc, tip: tip, total: total, coupon: c };
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
    groupByStore: groupByStore, totals: totals,
    SHIP: SHIP, FREE_OVER: FREE_OVER, shipFor: shipFor,
    COUPONS: COUPONS, getCoupon: getCoupon, setCoupon: setCoupon,
    getTip: getTip, setTip: setTip, applyLang: applyLang
  };
})();
