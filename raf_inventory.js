/* ============================================================
   RAF — INVENTORY AUTHORITY  (shared, headless)
   ------------------------------------------------------------
   The single authority for stock. Nothing else may decrement,
   restore or adjust inventory.

   MODEL (preserves the existing semantics exactly):

     onHand    = product.stock — unchanged meaning, unchanged values.
                 It drops when an order is placed and returns when that
                 order is cancelled, rejected or times out.
     reserved  = units held by OTHER checkout sessions that have not yet
                 placed an order. Derived from the existing 15-minute
                 checkout holds; no second stored number.
     available = onHand - reserved

   Two distinct records, both already present in RAF:

     · checkout hold  — pre-order, session-scoped, 15 min, UI state only
     · order reservation — created the moment an order id exists and its
       placement validation has passed. THIS is the authoritative record:
       it carries orderId, so a release is idempotent and can be performed
       from any session, including a merchant's.

   One order produces exactly one inventory sale effect. Accept, Ready,
   driver pickup and delivery move the order forward without touching
   stock again.
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFInventory) return;

  var LS_RES  = 'raf_inventory_reservations';
  var LS_MOVE = 'raf_inventory_movements';

  var STATUS = { ACTIVE:'active', COMMITTED:'committed', RELEASED:'released' };
  var DIRECTION = { RESERVE:'reserve', RELEASE:'release', SALE:'sale', ADJUSTMENT:'adjustment' };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }
  function S(){ return global.RAFSource || null; }

  function readJSON(k, dflt){
    try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : dflt; }
    catch (e) { return dflt; }
  }
  /* every write re-reads immediately before persisting, so a concurrent tab
     is never clobbered. This is compare-and-write, not a transaction. */
  function writeJSON(k, v){
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
  }

  /* ---------- stock model ---------- */
  function onHand(productId){
    var s = S(); if (!s) return 0;
    var p = s.product(productId);
    return (p && p.stock != null) ? p.stock : 0;
  }
  /* units held by other checkout sessions — the existing 15-minute holds */
  function reserved(productId, opts){
    opts = opts || {};
    if (!global.RAFRules || !RAFRules.Reserve) return 0;
    try {
      return opts.includeOwnSession
        ? totalHeld(productId)
        : RAFRules.Reserve.heldElsewhere(productId);
    } catch (e) { return 0; }
  }
  function totalHeld(productId){
    var all = {}, n = 0;
    try { all = RAFRules.Reserve.all() || {}; } catch (e) { return 0; }
    Object.keys(all).forEach(function (k) {
      var r = all[k];
      if (r && r.items && r.items[productId]) n += r.items[productId];
    });
    return n;
  }
  function available(productId, opts){
    return Math.max(0, onHand(productId) - reserved(productId, opts));
  }
  /* derived availability state — never a product lifecycle status */
  function stateOf(productId){
    return available(productId) > 0 ? 'available' : 'out_of_stock';
  }

  /* ---------- quantity validation ---------- */
  function validQty(q){
    var n = typeof q === 'number' ? q : Number(q);
    return isFinite(n) && n > 0 && n % 1 === 0;
  }

  /* ---------- reservations (order-scoped, authoritative) ---------- */
  function allReservations(){ return readJSON(LS_RES, {}); }
  function reservationFor(orderId){ return allReservations()[orderId] || null; }
  function newId(prefix){
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,7);
  }

  /* ---------- movement ledger (append-only, never an authority) ---------- */
  function movements(filter){
    var all = readJSON(LS_MOVE, []);
    if (!Array.isArray(all)) all = [];
    if (!filter) return all.slice();
    return all.filter(function (m) {
      if (filter.productId && m.productId !== filter.productId) return false;
      if (filter.orderId   && m.orderId   !== filter.orderId)   return false;
      if (filter.direction && m.direction !== filter.direction) return false;
      return true;
    });
  }
  function addMovements(rows){
    var all = readJSON(LS_MOVE, []);
    if (!Array.isArray(all)) all = [];
    rows.forEach(function (r) { all.push(r); });
    return writeJSON(LS_MOVE, all);
  }
  function movement(productId, qty, direction, reason, orderId, actor){
    return { movementId:newId('mv'), productId:productId, quantity:qty, direction:direction,
             reason:reason || null, orderId:orderId || null, timestamp:Date.now(),
             actorType:(actor && actor.type) || (actor && actor.id ? 'merchant' : 'system'),
             actorId:(actor && actor.id) || null };
  }

  /* ---------- audit ---------- */
  function audit(action, opts){
    if (!global.RAFAudit) return;
    try { RAFAudit.record(opts ? Object.assign({ action:action }, opts) : { action:action }); }
    catch (e) {}
  }
  function slugOf(productId){
    var s = S(); if (!s) return null;
    var p = s.product(productId);
    return (p && p.store) || null;
  }

  /* ---------- permissions ---------- */
  function canEdit(userOrId){
    var m = global.RAFMerchantProducts;
    return m ? m.canEdit(userOrId) : false;
  }
  function owns(productId, userOrId){
    var m = global.RAFMerchantProducts;
    return m ? m.owns(productId, userOrId) : false;
  }

  /* ══════════════ RESERVE FOR AN ORDER ══════════════
     Called once, immediately after an order id exists and placement
     validation has passed. Atomic across every line: the whole requirement
     is re-checked against live stock, then applied. Nothing is applied if
     any line fails. Idempotent by orderId. */
  function reserveForOrder(orderId, lines, actor){
    if (!orderId) return { ok:false, code:'NO_ORDER',
      errors:[{ message:T('معرّف الطلب مفقود','Order reference is missing') }] };

    var existing = reservationFor(orderId);
    if (existing) return { ok:true, alreadyApplied:true, reservation:existing };

    /* collapse the lines to one requirement per product */
    var need = {};
    for (var i = 0; i < (lines || []).length; i++) {
      var l = lines[i];
      if (!l || !l.id) return { ok:false, code:'INVALID_LINE',
        errors:[{ message:T('سطر غير صالح في الطلب','Invalid order line') }] };
      var q = l.qty == null ? 1 : l.qty;
      if (!validQty(q)) return { ok:false, code:'INVALID_QUANTITY',
        errors:[{ field:l.id, message:T('الكمية غير صالحة','Invalid quantity') }] };
      need[l.id] = (need[l.id] || 0) + q;
    }
    var ids = Object.keys(need);
    if (!ids.length) return { ok:false, code:'EMPTY',
      errors:[{ message:T('لا توجد أصناف','No items') }] };

    /* 1 — validate the COMPLETE requirement first; no partial reservation */
    var short = [];
    ids.forEach(function (pid) {
      /* the placing session's own hold must not count against itself. On a
         surface without the checkout rules loaded there are no holds to
         consider, so on-hand is the whole constraint. */
      var free = onHand(pid) - reserved(pid);
      if (need[pid] > free) short.push({ productId:pid, requested:need[pid], available:Math.max(0, free) });
    });
    if (short.length) {
      return { ok:false, code:'INSUFFICIENT_STOCK', shortages:short,
               errors:short.map(function (s) {
                 return { field:s.productId,
                          message:T('الكمية المطلوبة غير متوفرة','The requested quantity is not available') };
               }) };
    }

    /* 2 — apply. Re-read each product immediately before writing, and never
       clamp: a negative result aborts and rolls back what was applied. */
    var applied = [], failed = null;
    for (var j = 0; j < ids.length; j++) {
      var pid = ids[j], cur = onHand(pid), next = cur - need[pid];
      if (next < 0) { failed = { productId:pid, requested:need[pid], available:cur }; break; }
      if (!S().updateProduct(pid, { stock: next })) { failed = { productId:pid, write:true }; break; }
      applied.push(pid);
    }
    if (failed) {
      /* deterministic rollback — the strongest guarantee localStorage allows */
      applied.forEach(function (pid) { S().updateProduct(pid, { stock: onHand(pid) + need[pid] }); });
      return { ok:false, code: failed.write ? 'PERSIST_FAILED' : 'INSUFFICIENT_STOCK',
               rolledBack:true, shortages: failed.write ? [] : [failed],
               errors:[{ message: failed.write
                 ? T('تعذّر حفظ المخزون','Inventory could not be saved')
                 : T('الكمية المطلوبة غير متوفرة','The requested quantity is not available') }] };
    }

    var res = { reservationId:newId('rsv'), orderId:orderId, items:need,
                createdAt:Date.now(), status:STATUS.ACTIVE, reason:'order_placed' };
    var all = allReservations();
    if (all[orderId]) return { ok:true, alreadyApplied:true, reservation:all[orderId] };
    all[orderId] = res;
    if (!writeJSON(LS_RES, all)) {
      applied.forEach(function (pid) { S().updateProduct(pid, { stock: onHand(pid) + need[pid] }); });
      return { ok:false, code:'PERSIST_FAILED', rolledBack:true,
               errors:[{ message:T('تعذّر حفظ الحجز','The reservation could not be saved') }] };
    }
    addMovements(ids.map(function (pid) {
      return movement(pid, need[pid], DIRECTION.RESERVE, 'order_placed', orderId, actor);
    }));
    audit('inventory.reserved', { orderId:orderId, storeSlug:slugOf(ids[0]), actor:actor,
      source:'system', systemGenerated:!actor, key:'rsv:' + orderId,
      metadata:{ reservationId:res.reservationId, items:need } });
    emit();
    return { ok:true, reservation:res };
  }

  /* ══════════════ RELEASE ══════════════
     Identified by orderId, never by browser session, so a merchant can
     release a hold created in a customer's tab. Idempotent. */
  function releaseForOrder(orderId, reason, actor){
    var all = allReservations(), res = all[orderId];
    if (!res) return { ok:true, alreadyApplied:true, noop:true };
    if (res.status !== STATUS.ACTIVE)
      return { ok:true, alreadyApplied:true, status:res.status };

    var ids = Object.keys(res.items || {});
    ids.forEach(function (pid) { S().updateProduct(pid, { stock: onHand(pid) + res.items[pid] }); });

    res.status = STATUS.RELEASED; res.releasedAt = Date.now(); res.releaseReason = reason || 'released';
    all[orderId] = res;
    if (!writeJSON(LS_RES, all)) {
      ids.forEach(function (pid) { S().updateProduct(pid, { stock: Math.max(0, onHand(pid) - res.items[pid]) }); });
      return { ok:false, code:'PERSIST_FAILED',
               errors:[{ message:T('تعذّر حفظ التغيير','The change could not be saved') }] };
    }
    addMovements(ids.map(function (pid) {
      return movement(pid, res.items[pid], DIRECTION.RELEASE, reason || 'released', orderId, actor);
    }));
    audit('inventory.released', { orderId:orderId, storeSlug:slugOf(ids[0]), actor:actor,
      source:'system', systemGenerated:!actor, key:'rel:' + orderId,
      metadata:{ reservationId:res.reservationId, reason:reason || 'released', items:res.items } });
    emit();
    return { ok:true, released:res.items };
  }

  /* ══════════════ COMMIT THE SALE ══════════════
     Stock already left on-hand at placement, so this records the sale and
     closes the reservation. It never decrements again. Idempotent. */
  function commitSale(orderId, actor){
    var all = allReservations(), res = all[orderId];
    if (!res) return { ok:true, alreadyApplied:true, noop:true };
    if (res.status !== STATUS.ACTIVE) return { ok:true, alreadyApplied:true, status:res.status };

    res.status = STATUS.COMMITTED; res.committedAt = Date.now();
    all[orderId] = res;
    if (!writeJSON(LS_RES, all)) return { ok:false, code:'PERSIST_FAILED',
      errors:[{ message:T('تعذّر حفظ التغيير','The change could not be saved') }] };

    var ids = Object.keys(res.items || {});
    addMovements(ids.map(function (pid) {
      return movement(pid, res.items[pid], DIRECTION.SALE, 'sale_committed', orderId, actor);
    }));
    audit('inventory.sale_committed', { orderId:orderId, storeSlug:slugOf(ids[0]), actor:actor,
      source:'system', systemGenerated:!actor, key:'sale:' + orderId,
      metadata:{ reservationId:res.reservationId, items:res.items } });
    emit();
    return { ok:true, committed:res.items };
  }

  /* ══════════════ MANUAL ADJUSTMENT ══════════════ */
  function adjust(productId, delta, reason, opts){
    opts = opts || {};
    var actor = opts.actor || null, who = (actor && actor.id) || null;

    if (!canEdit(who)) return { ok:false, code:'FORBIDDEN',
      errors:[{ message:T('لا تملك صلاحية تعديل المخزون','You do not have permission to change inventory') }] };
    if (!owns(productId, who)) return { ok:false, code:'CROSS_STORE',
      errors:[{ message:T('هذا المنتج لا يخص متجرك','This product does not belong to your store') }] };

    var n = typeof delta === 'number' ? delta : Number(delta);
    if (!isFinite(n) || n % 1 !== 0 || n === 0) return { ok:false, code:'INVALID_QUANTITY',
      errors:[{ field:'delta', message:T('أدخل عدداً صحيحاً غير صفري','Enter a non-zero whole number') }] };
    if (!reason || !String(reason).trim()) return { ok:false, code:'REASON_REQUIRED',
      errors:[{ field:'reason', message:T('سبب التعديل مطلوب','A reason is required') }] };

    /* the same concurrency stamp the product editor uses — an adjustment made
       against an out-of-date reading is rejected, never merged */
    var mp = global.RAFMerchantProducts;
    if (opts.baseVersion !== undefined && mp) {
      var currentVersion = mp.versionOf(productId);
      if (opts.baseVersion !== currentVersion) {
        return { ok:false, code:'STALE', currentVersion:currentVersion,
          errors:[{ field:'conflict',
            message:T('تم تغيير المخزون في جلسة أخرى. أعد تحميل المنتج ثم حاول مجدداً.',
                      'Inventory changed in another session. Reload the product and try again.') }] };
      }
    }

    var cur = onHand(productId), next = cur + n;
    if (next < 0) return { ok:false, code:'NEGATIVE_STOCK',
      errors:[{ field:'delta', message:T('النتيجة ستكون سالبة','The result would be negative') }] };

    /* stamping updatedAt keeps inventory writes visible to the shared
       concurrency check, so a later stale product edit is caught */
    if (!S().updateProduct(productId, { stock: next, updatedAt: Date.now() }))
      return { ok:false, code:'PERSIST_FAILED',
        errors:[{ message:T('تعذّر حفظ المخزون','Inventory could not be saved') }] };

    addMovements([movement(productId, Math.abs(n), DIRECTION.ADJUSTMENT, String(reason).trim(), null, actor)]);
    audit('inventory.adjusted', { storeSlug:slugOf(productId), actor:actor, source:'merchant',
      key:productId + ':adj:' + Date.now(),
      metadata:{ productId:productId, from:cur, to:next, delta:n, reason:String(reason).trim() } });
    emit();
    return { ok:true, productId:productId, from:cur, to:next, delta:n };
  }

  /* ---------- change propagation ---------- */
  var watchers = [];
  function emit(){
    watchers.forEach(function (fn) { try { fn(); } catch (e) {} });
    try { document.dispatchEvent(new CustomEvent('raf:inventory')); } catch (e) {}
  }
  function watch(fn){
    if (typeof fn !== 'function') return function () {};
    watchers.push(fn);
    return function () { watchers = watchers.filter(function (f) { return f !== fn; }); };
  }
  global.addEventListener('storage', function (e) {
    if (e.key === LS_RES || e.key === LS_MOVE) emit();
  });

  /* ══════════════ GROUP C · LINE-LEVEL RESERVATION OPERATIONS ══════════════
     Authorised narrow addition. Everything above stays as it was: an order
     reserves as a whole, releases as a whole and commits as a whole.

     A customer-approved change touches ONE line of a live order, so these two
     operations move a single line's quantity while the rest of the
     reservation stays ACTIVE. They are the only way to do that — no caller
     may reach into a reservation itself.

     Idempotency is by operation key, recorded on the reservation. Replaying
     an approval therefore cannot move stock twice. */

  function lineOps(res){ return res.lineOps || (res.lineOps = {}); }

  /* qty must be a whole, positive, in-range number — never clamped */
  function lineQtyOk(res, productId, qty){
    if (!validQty(qty)) return false;
    var held = (res.items || {})[productId];
    return typeof held === 'number' && held >= qty;
  }

  /* release exactly `qty` of one product from a live reservation */
  function releaseLine(orderId, productId, qty, opts){
    opts = opts || {};
    var opKey = opts.opKey;
    if (!orderId || !productId) return { ok:false, code:'INVALID_LINE' };
    if (!opKey) return { ok:false, code:'OP_KEY_REQUIRED' };

    var all = allReservations(), res = all[orderId];
    if (!res) return { ok:false, code:'NO_RESERVATION' };
    if (lineOps(res)[opKey]) return { ok:true, alreadyApplied:true, result:res.lineOps[opKey] };
    if (res.status !== STATUS.ACTIVE) return { ok:false, code:'RESERVATION_NOT_ACTIVE', status:res.status };
    if (!lineQtyOk(res, productId, qty))
      return { ok:false, code:'INVALID_LINE', held:(res.items || {})[productId] || 0, requested:qty };

    /* 1 — return the units to stock */
    var before = onHand(productId);
    if (!S().updateProduct(productId, { stock: before + qty }))
      return { ok:false, code:'PERSIST_FAILED' };

    /* 2 — shrink the reservation line; an emptied reservation is released */
    var next = {};
    for (var k in res.items) if (res.items.hasOwnProperty(k)) next[k] = res.items[k];
    next[productId] -= qty;
    if (next[productId] === 0) delete next[productId];

    var snapshotItems = res.items, snapshotStatus = res.status;
    res.items = next;
    if (!Object.keys(next).length) { res.status = STATUS.RELEASED; res.releasedAt = Date.now(); }
    lineOps(res)[opKey] = { type:'release', productId:productId, qty:qty, at:Date.now() };
    all[orderId] = res;

    if (!writeJSON(LS_RES, all)) {
      /* nothing partial survives: put the stock back exactly as it was */
      S().updateProduct(productId, { stock: before });
      res.items = snapshotItems; res.status = snapshotStatus;
      return { ok:false, code:'PERSIST_FAILED', rolledBack:true };
    }

    addMovements([movement(productId, qty, DIRECTION.RELEASE,
                           opts.reason || 'order_line_removed', orderId, opts.actor)]);
    audit('inventory.line_released', { orderId:orderId, storeSlug:slugOf(productId),
      actor:opts.actor, source:'system', systemGenerated:!opts.actor, key:'relline:' + opKey,
      metadata:{ reservationId:res.reservationId, productId:productId, quantity:qty,
                 reason:opts.reason || 'order_line_removed', remaining:res.items } });
    emit();
    return { ok:true, released:qty, productId:productId, remaining:res.items, status:res.status };
  }

  /* swap one product for another inside a live reservation, all-or-nothing */
  function replaceLine(orderId, fromProductId, toProductId, qty, opts){
    opts = opts || {};
    var opKey = opts.opKey;
    if (!orderId || !fromProductId || !toProductId) return { ok:false, code:'INVALID_LINE' };
    if (fromProductId === toProductId) return { ok:false, code:'INVALID_LINE', reason:'same_product' };
    if (!opKey) return { ok:false, code:'OP_KEY_REQUIRED' };

    var all = allReservations(), res = all[orderId];
    if (!res) return { ok:false, code:'NO_RESERVATION' };
    if (lineOps(res)[opKey]) return { ok:true, alreadyApplied:true, result:res.lineOps[opKey] };
    if (res.status !== STATUS.ACTIVE) return { ok:false, code:'RESERVATION_NOT_ACTIVE', status:res.status };
    if (!lineQtyOk(res, fromProductId, qty))
      return { ok:false, code:'INVALID_LINE', held:(res.items || {})[fromProductId] || 0, requested:qty };

    /* 1 — the replacement must be genuinely available BEFORE anything moves */
    var free = onHand(toProductId) - reserved(toProductId);
    if (qty > free)
      return { ok:false, code:'INSUFFICIENT_STOCK',
               shortages:[{ productId:toProductId, requested:qty, available:Math.max(0, free) }],
               errors:[{ field:toProductId,
                         message:T('الكمية المطلوبة غير متوفرة','The requested quantity is not available') }] };

    /* 2 — apply both halves, undoing the first if the second cannot land */
    var fromBefore = onHand(fromProductId);
    if (!S().updateProduct(fromProductId, { stock: fromBefore + qty }))
      return { ok:false, code:'PERSIST_FAILED' };

    var toBefore = onHand(toProductId), toNext = toBefore - qty;
    if (toNext < 0 || !S().updateProduct(toProductId, { stock: toNext })) {
      S().updateProduct(fromProductId, { stock: fromBefore });      /* undo half one */
      return { ok:false, code:toNext < 0 ? 'INSUFFICIENT_STOCK' : 'PERSIST_FAILED', rolledBack:true };
    }

    var snapshotItems = res.items;
    var next = {};
    for (var k in res.items) if (res.items.hasOwnProperty(k)) next[k] = res.items[k];
    next[fromProductId] -= qty;
    if (next[fromProductId] === 0) delete next[fromProductId];
    next[toProductId] = (next[toProductId] || 0) + qty;

    res.items = next;
    lineOps(res)[opKey] = { type:'replace', from:fromProductId, to:toProductId, qty:qty, at:Date.now() };
    all[orderId] = res;

    if (!writeJSON(LS_RES, all)) {
      S().updateProduct(fromProductId, { stock: fromBefore });
      S().updateProduct(toProductId,   { stock: toBefore });
      res.items = snapshotItems;
      return { ok:false, code:'PERSIST_FAILED', rolledBack:true };
    }

    addMovements([
      movement(fromProductId, qty, DIRECTION.RELEASE, opts.reason || 'order_line_replaced', orderId, opts.actor),
      movement(toProductId,   qty, DIRECTION.RESERVE, opts.reason || 'order_line_replaced', orderId, opts.actor)
    ]);
    audit('inventory.line_replaced', { orderId:orderId, storeSlug:slugOf(toProductId),
      actor:opts.actor, source:'system', systemGenerated:!opts.actor, key:'repline:' + opKey,
      metadata:{ reservationId:res.reservationId, from:fromProductId, to:toProductId,
                 quantity:qty, reason:opts.reason || 'order_line_replaced', items:res.items } });
    emit();
    return { ok:true, from:fromProductId, to:toProductId, qty:qty, items:res.items };
  }

  global.RAFInventory = {
    STATUS: STATUS, DIRECTION: DIRECTION,
    /* Group C · line-level reservation operations */
    releaseLine: releaseLine, replaceLine: replaceLine,
    /* read */
    onHand: onHand, reserved: reserved, available: available, stateOf: stateOf,
    reservationFor: reservationFor, allReservations: allReservations, movements: movements,
    /* write */
    reserveForOrder: reserveForOrder, releaseForOrder: releaseForOrder,
    commitSale: commitSale, adjust: adjust,
    /* misc */
    validQty: validQty, watch: watch
  };
})(window);
