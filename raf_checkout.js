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

  /* ---------- catalog (variants + stock, used for in-cart editing) ---------- */
  var SIZES = function (arr) { return arr.map(function (v) { return { v: String(v).toLowerCase(), label: { ar: String(v), en: String(v) } }; }); };
  var COLORS = [{ v: 'white', label: { ar: 'أبيض', en: 'White' } }, { v: 'black', label: { ar: 'أسود', en: 'Black' } }, { v: 'navy', label: { ar: 'كحلي', en: 'Navy' } }];
  var CATALOG = [
    { id: 'P-001', ar: 'قميص أوفرسايز كلاسيك', en: 'Classic Oversize Shirt', price: '12.000', old: '17.000', disc: 30, ic: 'ti-shirt', rate: '4.8', rev: '124', stock: 9, store: { ar: 'Casa Mode', en: 'Casa Mode' },
      variants: [{ label: { ar: 'المقاس', en: 'Size' }, options: SIZES(['S', 'M', 'L', 'XL']) }, { label: { ar: 'اللون', en: 'Color' }, options: COLORS }] },
    { id: 'P-007', ar: 'فستان سهرة بولدر', en: 'Boulder Evening Dress', price: '30.000', old: '60.000', disc: 50, ic: 'ti-hanger', rate: '4.7', rev: '44', stock: 6, store: { ar: 'Casa Mode', en: 'Casa Mode' },
      variants: [{ label: { ar: 'المقاس', en: 'Size' }, options: SIZES(['S', 'M', 'L']) }] },
    { id: 'P-005', ar: 'حقيبة يد جلد طبيعي', en: 'Genuine Leather Handbag', price: '35.700', old: '42.000', disc: 15, ic: 'ti-backpack', rate: '4.9', rev: '152', stock: 4, store: { ar: 'Casa Mode', en: 'Casa Mode' } },
    { id: 'P-EARBUDS', ar: 'سماعات لاسلكية فاخرة', en: 'Premium Wireless Earbuds', price: '24.500', old: '35.000', disc: 30, ic: 'ti-device-mobile', rate: '4.8', rev: '320', stock: 12, store: { ar: 'تك هاوس', en: 'Tech House' } },
    { id: 'P-HEADPHONES', ar: 'سماعة رأس احترافية', en: 'Pro Headphones', price: '38.000', old: '52.000', disc: 27, ic: 'ti-headphones', rate: '4.8', rev: '410', stock: 7, store: { ar: 'تك هاوس', en: 'Tech House' },
      variants: [{ label: { ar: 'اللون', en: 'Color' }, options: [{ v: 'black', label: { ar: 'أسود', en: 'Black' } }, { v: 'white', label: { ar: 'أبيض', en: 'White' } }] }] },
    { id: 'P-PERFUME', ar: 'عطر شرقي فاخر', en: 'Luxury Oriental Perfume', price: '42.000', old: '60.000', disc: 30, ic: 'ti-spray', rate: '4.9', rev: '215', stock: 15, store: { ar: 'دار العود', en: 'Dar Aloud' },
      variants: [{ label: { ar: 'الحجم', en: 'Size' }, options: [{ v: '50', label: { ar: '50 مل', en: '50 ml' } }, { v: '100', label: { ar: '100 مل', en: '100 ml' } }] }] },
    { id: 'P-WATCH', ar: 'ساعة كلاسيكية جلد', en: 'Classic Leather Watch', price: '68.000', old: '85.000', disc: 20, ic: 'ti-clock-hour-4', rate: '4.7', rev: '142', stock: 3, store: { ar: 'تايم بوكس', en: 'Time Box' },
      variants: [{ label: { ar: 'اللون / الخامة', en: 'Color / Material' }, options: [{ v: 'brown', label: { ar: 'جلد بني', en: 'Brown Leather' } }, { v: 'black', label: { ar: 'جلد أسود', en: 'Black Leather' } }] }] }
  ];
  function catalogFor(id) { return CATALOG.find(function (p) { return p.id === id; }) || null; }

  /* a cart line is unavailable when its catalog entry is out of stock */
  function isOOS(l) {
    if (l.available === false || l.stock === 0) return true;
    var p = catalogFor(l.id);
    return !!(p && (p.stock === 0 || p.available === false));
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
    get: get, set: set, getJSON: getJSON, setJSON: setJSON,
    CATALOG: CATALOG, catalogFor: catalogFor, isOOS: isOOS,
    groupByStore: groupByStore, totals: totals,
    SHIP: SHIP, FREE_OVER: FREE_OVER, shipFor: shipFor,
    COUPONS: COUPONS, getCoupon: getCoupon, setCoupon: setCoupon,
    getTip: getTip, setTip: setTip, applyLang: applyLang
  };
})();
