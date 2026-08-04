/* ============================================================================
 * RAF Marketplace — BUSINESS RULES LAYER
 * ----------------------------------------------------------------------------
 * Sits on top of the central data authority (raf_source.js) and provides the
 * operational guarantees the storefront depends on:
 *
 *   1. Store Status Policy   — what a store's state means for visibility
 *   2. Product Validation    — nothing invalid can be bought
 *   3. Cart Synchronization  — the cart re-reads the source whenever it opens
 *   4. Final Cart Validation — one last check immediately before an order
 *   5. Stock Reservation     — inventory held during checkout, released or
 *                              committed deterministically
 *
 * Load order: raf_source.js → raf_data.js → raf_catalog.js → raf_rules.js
 * No page API changes; this layer is additive and pages opt in.
 * ==========================================================================*/
(function (global) {
  if (global.RAFRules) return;

  var LS_RESERVE = 'raf_reservations';
  var RESERVE_MS = 15 * 60 * 1000;              /* a checkout hold lasts 15 minutes */

  function S(){ return global.RAFSource || null; }
  function root(){ return document.getElementById('htmlRoot') || document.documentElement; }
  function isEn(){ return root().lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function L(o){ return (o && typeof o === 'object') ? (isEn() ? (o.en||o.ar) : (o.ar||o.en)) : (o || ''); }

  /* ══════════════════════════════════════════════════════════════
     1 · STORE STATUS POLICY
     open       → fully visible, highest priority
     closed     → store + products hidden from listings until reopened
     suspended  → store + products hidden until reactivated (admin)
     deleted    → gone entirely; not even reachable by direct link
     ══════════════════════════════════════════════════════════════ */
  var StorePolicy = {
    of: function (slug) {
      var s = S() && S().store(slug);
      return s ? s.status : null;
    },
    /* may this store appear in listings/search/recommendations? */
    isListable: function (slug) { return StorePolicy.of(slug) === 'open'; },
    /* may this store's storefront (and therefore its products) be browsed?
       Only an open store may: closed and suspended both hide their products
       until reopened/reactivated, and deleted is gone entirely. */
    isReachable: function (slug) { return StorePolicy.of(slug) === 'open'; },
    /* human explanation used by store pages and validation messages */
    notice: function (slug) {
      switch (StorePolicy.of(slug)) {
        case 'closed':    return { level:'warn', title:T('المتجر مغلق مؤقتاً','Store temporarily closed'),
                                   msg:T('لا يمكن الطلب من هذا المتجر حتى إعادة فتحه.','Ordering is unavailable until this store reopens.') };
        case 'suspended': return { level:'error', title:T('المتجر موقوف','Store suspended'),
                                   msg:T('تم إيقاف هذا المتجر مؤقتاً من قبل الإدارة.','This store has been suspended by RAF administration.') };
        case 'deleted':   return { level:'error', title:T('المتجر غير موجود','Store not found'),
                                   msg:T('لم يعد هذا المتجر متاحاً على رف.','This store is no longer available on RAF.') };
        default:          return null;
      }
    },
    /* guard a store page: returns null when fine, or a notice to render */
    guard: function (slug) {
      if (!S() || !S().store(slug)) return StorePolicy.notice('__missing__') || { level:'error',
        title:T('المتجر غير موجود','Store not found'), msg:T('تحقق من الرابط أو تصفّح المتاجر.','Check the link or browse stores.') };
      return StorePolicy.isReachable(slug) ? null : StorePolicy.notice(slug);
    }
  };

  /* ══════════════════════════════════════════════════════════════
     2 · PRODUCT VALIDATION
     Every purchase path funnels through validate(). Reasons are typed so
     callers can render them however they like, in either language.
     ══════════════════════════════════════════════════════════════ */
  var REASONS = {
    NOT_FOUND:      { code:'NOT_FOUND',      ar:'هذا المنتج لم يعد متاحاً',              en:'This product is no longer available' },
    PRODUCT_HIDDEN: { code:'PRODUCT_HIDDEN', ar:'هذا المنتج غير معروض حالياً',            en:'This product is not currently listed' },
    STORE_CLOSED:   { code:'STORE_CLOSED',   ar:'متجر هذا المنتج مغلق مؤقتاً',            en:'This product’s store is temporarily closed' },
    STORE_BLOCKED:  { code:'STORE_BLOCKED',  ar:'متجر هذا المنتج غير متاح حالياً',        en:'This product’s store is unavailable' },
    OUT_OF_STOCK:   { code:'OUT_OF_STOCK',   ar:'نفدت كمية هذا المنتج',                  en:'This product is sold out' },
    NOT_ENOUGH:     { code:'NOT_ENOUGH',     ar:'الكمية المطلوبة أكبر من المتوفر',        en:'Requested quantity exceeds available stock' },
    OPTION_MISSING: { code:'OPTION_MISSING', ar:'اختر الخيارات المطلوبة أولاً',           en:'Please select the required options' },
    OPTION_INVALID: { code:'OPTION_INVALID', ar:'أحد الخيارات المختارة لم يعد متاحاً',     en:'A selected option is no longer available' },
    BAD_QTY:        { code:'BAD_QTY',        ar:'الكمية غير صحيحة',                      en:'Invalid quantity' }
  };
  function fail(reason, extra){
    var r = { ok:false, code:reason.code, message:T(reason.ar, reason.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function ok(product){ return { ok:true, product:product }; }

  /* variant is the { "المقاس":"M", … } shape the cart stores */
  function validate(id, variant, qty) {
    if (!S()) return fail(REASONS.NOT_FOUND);
    var p = S().product(id);
    if (!p) return fail(REASONS.NOT_FOUND);
    if (p.status === 'deleted') return fail(REASONS.NOT_FOUND);
    if (p.status !== 'active')  return fail(REASONS.PRODUCT_HIDDEN);

    var st = StorePolicy.of(p.store);
    if (st === 'closed')  return fail(REASONS.STORE_CLOSED, { store:p.store });
    if (st !== 'open')    return fail(REASONS.STORE_BLOCKED, { store:p.store });

    if (p.stock === 0) return fail(REASONS.OUT_OF_STOCK);

    /* required options must all be chosen, and each value must still exist */
    if (p.variants && p.variants.length) {
      var chosen = variant || {};
      for (var i = 0; i < p.variants.length; i++) {
        var g = p.variants[i], label = L(g.label), picked = chosen[label];
        if (picked == null || picked === '') return fail(REASONS.OPTION_MISSING, { group:label });
        var exists = g.options.some(function (o) {
          var lb = o.label || o;
          return L(lb) === picked || String(o.v) === String(picked);
        });
        if (!exists) return fail(REASONS.OPTION_INVALID, { group:label, value:picked });
      }
    }

    if (qty != null) {
      var q = parseInt(qty, 10);
      if (!q || q < 1) return fail(REASONS.BAD_QTY);
      var free = Reserve.availableFor(id);
      if (q > free) return fail(REASONS.NOT_ENOUGH, { available:free, requested:q });
    }
    return ok(p);
  }

  /* ══════════════════════════════════════════════════════════════
     5 · STOCK RESERVATION  (declared before Sync/Final, which use it)
     A reservation holds units for one checkout session. Expired holds are
     swept lazily on every read, so nothing leaks if a tab is closed.
     ══════════════════════════════════════════════════════════════ */
  function readRes(){
    var all;
    try { all = JSON.parse(localStorage.getItem(LS_RESERVE)) || {}; } catch(e){ all = {}; }
    var now = Date.now(), changed = false;
    Object.keys(all).forEach(function (k) {
      if (!all[k] || all[k].expires <= now) { delete all[k]; changed = true; }
    });
    if (changed) writeRes(all);
    return all;
  }
  function writeRes(all){
    try { localStorage.setItem(LS_RESERVE, JSON.stringify(all)); } catch(e){}
    document.dispatchEvent(new CustomEvent('raf:reserve'));
  }
  function sessionId(){
    var k = 'raf_checkout_session';
    var v = null; try { v = sessionStorage.getItem(k); } catch(e){}
    if (!v) { v = 'cs-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
      try { sessionStorage.setItem(k, v); } catch(e){} }
    return v;
  }
  var Reserve = {
    RESERVE_MS: RESERVE_MS,
    all: function(){ return readRes(); },
    /* units held by OTHER sessions (mine don't reduce what I can buy) */
    heldElsewhere: function (productId) {
      var mine = sessionId(), n = 0, all = readRes();
      Object.keys(all).forEach(function (k) {
        var r = all[k];
        if (r.session !== mine && r.items && r.items[productId]) n += r.items[productId];
      });
      return n;
    },
    /* how many units this shopper may still take */
    availableFor: function (productId) {
      var p = S() && S().product(productId);
      if (!p || p.stock == null) return 0;
      return Math.max(0, p.stock - Reserve.heldElsewhere(productId));
    },
    /* hold the cart's quantities for this checkout session */
    hold: function (lines) {
      var items = {};
      (lines || []).forEach(function (l) { items[l.id] = (items[l.id] || 0) + (l.qty || 1); });
      var all = readRes(), id = sessionId();
      all[id] = { session:id, items:items, created:Date.now(), expires:Date.now() + RESERVE_MS };
      writeRes(all);
      return { id:id, expires:all[id].expires };
    },
    /* release on payment failure, cancellation or abandonment */
    release: function () {
      var all = readRes(), id = sessionId();
      if (all[id]) { delete all[id]; writeRes(all); return true; }
      return false;
    },
    /* commit: stock is decremented centrally and the hold is dropped */
    commit: function () {
      var all = readRes(), id = sessionId(), r = all[id];
      if (!r) return false;
      Object.keys(r.items).forEach(function (pid) {
        var p = S() && S().product(pid);
        if (!p || p.stock == null) return;
        S().updateProduct(pid, { stock: Math.max(0, p.stock - r.items[pid]) });
      });
      delete all[id]; writeRes(all);
      return true;
    },
    msLeft: function () {
      var r = readRes()[sessionId()];
      return r ? Math.max(0, r.expires - Date.now()) : 0;
    },
    session: sessionId
  };

  /* ══════════════════════════════════════════════════════════════
     3 · CART SYNCHRONIZATION
     Re-reads price, name, store, stock and availability from the source
     for every cart line. Returns the changes so the UI can tell the shopper
     what moved rather than silently altering their basket.
     ══════════════════════════════════════════════════════════════ */
  function syncCart() {
    if (!global.RAFShop || !S()) return { changed:false, changes:[], removed:[] };
    var lines = RAFShop.Cart.read();
    var changes = [], removed = [], next = [];

    lines.forEach(function (l) {
      var p = S().product(l.id);
      var name = l.name ? L(l.name) : l.id;

      if (!p || p.status === 'deleted') {
        removed.push({ id:l.id, name:name, code:'NOT_FOUND', message:T('لم يعد متاحاً','No longer available') });
        return;
      }
      if (p.status !== 'active' || !StorePolicy.isListable(p.store)) {
        removed.push({ id:l.id, name:name,
          code: p.status !== 'active' ? 'PRODUCT_HIDDEN' : 'STORE_CLOSED',
          message: p.status !== 'active' ? T('لم يعد معروضاً','No longer listed') : T('متجره مغلق','Its store is closed') });
        return;
      }
      var line = Object.assign({}, l);
      /* price / naming drift */
      if (String(p.price) !== String(l.price)) {
        changes.push({ id:l.id, name:name, field:'price', from:l.price, to:p.price,
          message:T('تغيّر السعر من '+l.price+' إلى '+p.price, 'Price changed from '+l.price+' to '+p.price) });
        line.price = p.price;
      }
      if (p.name && l.name && (p.name.ar !== l.name.ar || p.name.en !== l.name.en)) line.name = { ar:p.name.ar, en:p.name.en };
      var s = S().store(p.store);
      if (s) line.store = { ar:s.name.ar, en:s.name.en };
      line.ic = p.ic || line.ic;
      line.stock = p.stock;
      line.available = p.stock !== 0;

      /* stock shrank below what's in the basket */
      if (p.stock === 0) {
        removed.push({ id:l.id, name:name, code:'OUT_OF_STOCK', message:T('نفدت الكمية','Sold out') });
        return;
      }
      var free = Reserve.availableFor(l.id);
      if ((line.qty || 1) > free) {
        changes.push({ id:l.id, name:name, field:'qty', from:line.qty, to:free,
          message:T('تم تعديل الكمية إلى '+free+' (المتوفر)', 'Quantity reduced to '+free+' (all that is left)') });
        line.qty = free;
      }
      next.push(line);
    });

    var changed = changes.length > 0 || removed.length > 0;
    if (changed) RAFShop.Cart.write(next);
    /* resetting an emptied cart clears coupon/tip leftovers too */
    if (!next.length) resetCartState();
    return { changed:changed, changes:changes, removed:removed, lines:next };
  }

  /* clean slate once the basket is empty, so stale promos can't survive */
  function resetCartState() {
    try {
      localStorage.removeItem('raf_coupon');
      localStorage.removeItem('raf_tip');
      localStorage.removeItem('raf_order_notes');
      localStorage.removeItem('raf_driver_notes');
    } catch (e) {}
    Reserve.release();
    if (global.RAFShop) RAFShop.Cart.badge();
    document.dispatchEvent(new CustomEvent('raf:cart-reset'));
  }

  /* ══════════════════════════════════════════════════════════════
     4 · FINAL CART VALIDATION  (+ duplicate-order protection)
     ══════════════════════════════════════════════════════════════ */
  var placing = false;                                   /* in-flight guard */
  function finalValidate() {
    if (!global.RAFShop) return { ok:false, errors:[{ message:T('تعذّر التحقق','Validation unavailable') }] };
    var sync = syncCart();
    var lines = RAFShop.Cart.read();
    if (!lines.length) {
      return { ok:false, empty:true, sync:sync,
               errors:[{ code:'EMPTY_CART', message:T('سلتك فارغة','Your cart is empty') }] };
    }
    var errors = [];
    lines.forEach(function (l) {
      var v = validate(l.id, l.variant, l.qty);
      if (!v.ok) errors.push({ id:l.id, name:l.name ? L(l.name) : l.id, code:v.code, message:v.message });
    });
    /* single store per order stays enforced at the final gate too */
    var stores = {};
    lines.forEach(function (l) { var k = RAFShop.Cart.storeOf(l); if (k) stores[k] = 1; });
    if (Object.keys(stores).length > 1) {
      errors.push({ code:'MULTI_STORE', message:T('سلتك تحتوي منتجات من أكثر من متجر','Your cart contains items from more than one store') });
    }
    return { ok: errors.length === 0 && !sync.changed, errors:errors, sync:sync };
  }

  /* Wraps order creation so a double click / slow connection cannot create
     two orders. Resolves { ok, order } or { ok:false, errors }. */
  function placeOrder(opts) {
    if (placing) return Promise.resolve({ ok:false, duplicate:true,
      errors:[{ code:'IN_FLIGHT', message:T('جارٍ إنشاء طلبك…','Your order is already being placed…') }] });
    placing = true;
    return new Promise(function (resolve) {
      var check = finalValidate();
      if (!check.ok) { placing = false; return resolve({ ok:false, errors:check.errors, sync:check.sync }); }
      var order = RAFShop.Orders.create(opts || {});
      if (!order) { placing = false; return resolve({ ok:false,
        errors:[{ code:'CREATE_FAILED', message:T('تعذّر إنشاء الطلب','Could not create the order') }] }); }
      Reserve.commit();                       /* inventory committed on success */
      RAFShop.Cart.clear();
      resetCartState();
      placing = false;
      resolve({ ok:true, order:order });
    });
  }

  global.RAFRules = {
    StorePolicy: StorePolicy,
    REASONS: REASONS, validate: validate,
    syncCart: syncCart, resetCartState: resetCartState,
    finalValidate: finalValidate, placeOrder: placeOrder,
    Reserve: Reserve,
    isPlacing: function () { return placing; }
  };
})(window);
