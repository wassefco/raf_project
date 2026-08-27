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

    /* collapse the lines to one requirement per product, and — for products
       on combination stock — one requirement per exact combination too */
    var need = {}, needCombo = {}, comboOwner = {};
    for (var i = 0; i < (lines || []).length; i++) {
      var l = lines[i];
      if (!l || !l.id) return { ok:false, code:'INVALID_LINE',
        errors:[{ message:T('سطر غير صالح في الطلب','Invalid order line') }] };
      var q = l.qty == null ? 1 : l.qty;
      if (!validQty(q)) return { ok:false, code:'INVALID_QUANTITY',
        errors:[{ field:l.id, message:T('الكمية غير صالحة','Invalid quantity') }] };
      need[l.id] = (need[l.id] || 0) + q;

      if (isCombinationMode(l.id)) {
        /* the line must name the exact combination it is buying */
        var cid = l.combinationId || (l.combo ? l.combo : null);
        if (!cid && l.vs) cid = combinationIdFor(l.id, l.vs);
        if (!cid) return { ok:false, code:'COMBINATION_REQUIRED', productId:l.id,
          errors:[{ field:l.id,
                    message:T('لا يمكن تحديد الخيار المطلوب لهذا المنتج',
                              'The exact option for this product cannot be identified') }] };
        needCombo[cid] = (needCombo[cid] || 0) + q;
        comboOwner[cid] = l.id;
      }
    }
    var ids = Object.keys(need);
    if (!ids.length) return { ok:false, code:'EMPTY',
      errors:[{ message:T('لا توجد أصناف','No items') }] };

    /* 1 — validate the COMPLETE requirement first; no partial reservation.
       A combination-mode product is judged on its combination, never on the
       product total, so "P-001 has 10" can no longer oversell Black / M. */
    var short = [];
    ids.forEach(function (pid) {
      if (isCombinationMode(pid)) return;      /* judged per combination below */
      /* the placing session's own hold must not count against itself. On a
         surface without the checkout rules loaded there are no holds to
         consider, so on-hand is the whole constraint. */
      var free = onHand(pid) - reserved(pid);
      if (need[pid] > free) short.push({ productId:pid, requested:need[pid], available:Math.max(0, free) });
    });
    Object.keys(needCombo).forEach(function (cid) {
      var free = comboAvailable(cid);
      if (needCombo[cid] > free)
        short.push({ productId:comboOwner[cid], combinationId:cid,
                     requested:needCombo[cid], available:free });
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

    /* `combos` sits alongside `items`: the product totals keep every existing
       consumer working, the combination map makes each held unit exact */
    var res = { reservationId:newId('rsv'), orderId:orderId, items:need,
                combos: Object.keys(needCombo).length ? needCombo : null,
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
    resyncFromReservation(res);      /* combination products re-derive their total */
    if (res.combos) audit('inventory.combination.reserved', { orderId:orderId,
      storeSlug:slugOf(ids[0]), actor:actor, source:'system', systemGenerated:!actor,
      key:'creserve:' + orderId, metadata:{ combos:res.combos } });
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
    resyncFromReservation(res);      /* the exact combinations come back */
    if (res.combos) audit('inventory.combination.released', { orderId:orderId,
      storeSlug:slugOf(ids[0]), actor:actor, source:'system', systemGenerated:!actor,
      key:'crelease:' + orderId, metadata:{ combos:res.combos, reason:reason || 'released' } });
    emit();
    return { ok:true, released:res.items, releasedCombos:res.combos || null };
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
    /* a sale removes the units for good: physical combination stock drops
       once, here, and the reservation stops counting as held */
    if (res.combos) {
      var all2 = comboAll(), touched = {};
      Object.keys(res.combos).forEach(function (cid) {
        var pp = partsOf(cid); if (!pp) return;
        var m = all2[pp.productId] || {};
        if (m[cid]) { m[cid] = { onHand: Math.max(0, (m[cid].onHand || 0) - res.combos[cid]),
                                 updatedAt: Date.now() }; }
        all2[pp.productId] = m; touched[pp.productId] = 1;
      });
      writeJSON(LS_COMBO, all2);
      Object.keys(touched).forEach(syncProductTotal);
      audit('inventory.combination.sale_committed', { orderId:orderId, storeSlug:slugOf(ids[0]),
        actor:actor, source:'system', systemGenerated:!actor, key:'csale:' + orderId,
        metadata:{ combos:res.combos } });
    }
    emit();
    return { ok:true, committed:res.items, committedCombos:res.combos || null };
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

  /* ══════════════ VARIANT COMBINATION INVENTORY ══════════════
     Stock for an exact purchasable combination — "Black / M", not "Black"
     and not "M". This lives inside RAFInventory because there is one
     inventory authority; it is a sub-model, not a second engine.

     IDENTITY. A combination is identified by the product plus the stable
     option ids (`v`) from Phase 3.2, sorted, so the id never moves:

         P-001|black|m

     Sorting is what makes it deterministic — {colour then size} and {size
     then colour} produce the same id, and reordering the groups in the
     editor changes nothing. Labels, translations, swatches and group
     positions are all absent by design, so renaming "Black" to "Midnight
     Black" keeps its inventory. Group ids would have been the more obvious
     dimension key, but variant groups carry only `label` and `options` —
     no id exists to use, and inventing one would extend the frozen Phase
     3.2 variant schema. Sorted option ids need no new field.

     This relies on option ids being unique ACROSS a product's groups. That
     holds for every product in the catalogue today (verified: zero
     collisions), and `combinationIdFor` refuses to mint an ambiguous id
     rather than let two dimensions collide silently.

     MODE. A product is in combination mode only once a merchant has
     configured at least one combination. Until then it stays on
     product-level stock and behaves exactly as before — nothing is
     migrated, divided or guessed. */

  var LS_COMBO = 'raf_inventory_combinations';

  function comboAll(){ return readJSON(LS_COMBO, {}); }
  function comboMapOf(productId){
    var m = comboAll()[productId];
    return (m && typeof m === 'object') ? m : {};
  }
  /* a product uses combination stock once at least one combination exists */
  function modeOf(productId){
    return Object.keys(comboMapOf(productId)).length ? 'combination' : 'product';
  }
  function isCombinationMode(productId){ return modeOf(productId) === 'combination'; }

  /* the product's option ids, by group, straight from the catalogue */
  function groupsOf(productId){
    var p = global.RAFCatalog ? RAFCatalog.get(productId) : null;
    return (p && p.variants) || [];
  }
  /* every option id the product defines, and whether any is ambiguous */
  function optionIndex(productId){
    var gs = groupsOf(productId), seen = {}, dup = null;
    gs.forEach(function (g, gi) {
      (g.options || []).forEach(function (o) {
        var v = String(o.v);
        if (seen[v] != null && seen[v] !== gi) dup = v;
        seen[v] = gi;
      });
    });
    return { byV:seen, groups:gs, duplicate:dup };
  }

  /* THE identity function. `vs` is a list of stable option ids. */
  function combinationIdFor(productId, vs){
    if (!productId || !vs || !vs.length) return null;
    var idx = optionIndex(productId);
    if (idx.duplicate) return null;            /* ambiguous — refuse to mint */
    var clean = [], seenGroup = {};
    for (var i = 0; i < vs.length; i++) {
      var v = String(vs[i]);
      var gi = idx.byV[v];
      if (gi == null) return null;             /* not an option of this product */
      if (seenGroup[gi]) return null;          /* two choices in one dimension */
      seenGroup[gi] = 1;
      clean.push(v);
    }
    /* one selection per dimension, or it is not a purchasable combination */
    if (idx.groups.length && clean.length !== idx.groups.length) return null;
    clean.sort();
    return productId + '|' + clean.join('|');
  }
  /* the option ids inside an id, for display and validation */
  function partsOf(comboId){
    if (!comboId || comboId.indexOf('|') < 0) return null;
    var bits = comboId.split('|');
    return { productId:bits[0], vs:bits.slice(1) };
  }

  /* every combination the product's options can express, configured or not */
  function candidateCombinations(productId){
    var gs = groupsOf(productId);
    if (!gs.length) return [];
    var out = [[]];
    gs.forEach(function (g) {
      var next = [];
      (g.options || []).forEach(function (o) {
        out.forEach(function (row) { next.push(row.concat([o])); });
      });
      out = next;
    });
    return out.map(function (row) {
      var vs = row.map(function (o) { return String(o.v); });
      return { id:combinationIdFor(productId, vs), vs:vs, options:row };
    }).filter(function (c) { return !!c.id; });
  }

  /* ---- reserved, per combination ----
     Reservations record their combinations alongside their product totals,
     so "Black / M reserved 2" never borrows from "White / M". */
  function reservedCombo(comboId){
    var all = allReservations(), n = 0;
    for (var k in all) if (all.hasOwnProperty(k)) {
      var r = all[k];
      if (!r || r.status !== STATUS.ACTIVE || !r.combos) continue;
      if (r.combos[comboId]) n += r.combos[comboId];
    }
    return n;
  }
  function comboOnHand(comboId){
    var p = partsOf(comboId); if (!p) return 0;
    var rec = comboMapOf(p.productId)[comboId];
    return rec ? (rec.onHand || 0) : 0;
  }
  function comboAvailable(comboId){
    return Math.max(0, comboOnHand(comboId) - reservedCombo(comboId));
  }
  /* is this exact combination purchasable right now? */
  function combinationState(productId, vs){
    var id = combinationIdFor(productId, vs);
    if (!id) return { ok:false, code:'INVALID_COMBINATION' };
    if (!isCombinationMode(productId))
      return { ok:true, mode:'product', configured:false,
               available:available(productId), onHand:onHand(productId) };
    var rec = comboMapOf(productId)[id];
    if (!rec) return { ok:true, mode:'combination', configured:false,
                       available:0, onHand:0, reserved:0 };
    return { ok:true, mode:'combination', configured:true, combinationId:id,
             onHand:rec.onHand || 0, reserved:reservedCombo(id), available:comboAvailable(id) };
  }

  /* the merchant-facing view: every candidate, with its numbers */
  function combinationsOf(productId){
    var map = comboMapOf(productId);
    return candidateCombinations(productId).map(function (c) {
      var rec = map[c.id];
      var oh = rec ? (rec.onHand || 0) : 0, rs = reservedCombo(c.id);
      return { id:c.id, vs:c.vs, options:c.options, configured:!!rec,
               onHand:oh, reserved:rs, available:Math.max(0, oh - rs),
               updatedAt:rec ? rec.updatedAt : null };
    });
  }

  /* product.stock stays the sum of configured combinations so that every
     existing consumer — cards, cart ceilings, RAFRules, the sold-out badge —
     keeps working untouched while combination stock is authoritative */
  function syncProductTotal(productId){
    if (!isCombinationMode(productId)) return null;
    var map = comboMapOf(productId), sum = 0;
    for (var k in map) if (map.hasOwnProperty(k)) {
      /* combination onHand is PHYSICAL stock; product.stock already means
         "not spoken for by an order", so order-held units come off here.
         Keeping that meaning is what lets every existing consumer stay
         untouched while combinations become authoritative. */
      sum += Math.max(0, (map[k].onHand || 0) - reservedCombo(k));
    }
    S().updateProduct(productId, { stock: sum });
    return sum;
  }
  /* re-derive the totals of every combination-mode product a reservation
     touches, after that reservation's status has been written */
  function resyncFromReservation(res){
    if (!res || !res.combos) return;
    var done = {};
    Object.keys(res.combos).forEach(function (cid) {
      var p = partsOf(cid); if (!p || done[p.productId]) return;
      done[p.productId] = 1; syncProductTotal(p.productId);
    });
  }

  /* ---- merchant writes ---- */
  function permitted(productId, actor){
    if (!actor || !actor.id) return { ok:false, code:'FORBIDDEN' };
    var can = false;
    try { can = !!(global.RAFPerm && RAFPerm.can(actor.id, 'products.edit')); } catch (e) { can = false; }
    if (!can) return { ok:false, code:'FORBIDDEN' };
    var p = global.RAFCatalog ? RAFCatalog.get(productId) : null;
    if (!p) return { ok:false, code:'INVALID_PRODUCT' };
    if (!actor.storeSlug || !p.slug || actor.storeSlug !== p.slug)
      return { ok:false, code:'CROSS_STORE', actorStore:actor.storeSlug || null, productStore:p.slug || null };
    return { ok:true, product:p };
  }
  function wholeQty(n){ return typeof n === 'number' && isFinite(n) && n === Math.floor(n) && n >= 0; }

  /* Set quantities for one or more combinations, all or nothing.
     `entries` is { combinationId: onHand }. No reason is required — the
     approved adjustment UX does not ask for one. */
  function setCombinations(productId, entries, opts){
    opts = opts || {};
    var auth = permitted(productId, opts.actor); if (!auth.ok) return auth;
    if (!entries || typeof entries !== 'object') return { ok:false, code:'INVALID_COMBINATION' };

    var idx = optionIndex(productId);
    if (idx.duplicate) return { ok:false, code:'AMBIGUOUS_OPTION_ID', optionV:idx.duplicate };

    var valid = {}, ids = Object.keys(entries);
    if (!ids.length) return { ok:false, code:'INVALID_COMBINATION', reason:'empty' };
    var known = {};
    candidateCombinations(productId).forEach(function (c) { known[c.id] = 1; });

    /* validate EVERY entry before a single one is written */
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], q = entries[id];
      if (!known[id]) return { ok:false, code:'INVALID_COMBINATION', combinationId:id };
      if (!wholeQty(q)) return { ok:false, code:'INVALID_QUANTITY', combinationId:id, value:q };
      var held = reservedCombo(id);
      if (q < held) return { ok:false, code:'BELOW_RESERVED', combinationId:id, reserved:held, requested:q };
      valid[id] = q;
    }

    var all = comboAll(), map = all[productId] || {};
    /* stale-write protection, same shape the product editor already uses */
    if (opts.baseVersion != null) {
      var current = 0;
      for (var k2 in map) if (map.hasOwnProperty(k2)) current = Math.max(current, map[k2].updatedAt || 0);
      if (current > opts.baseVersion) return { ok:false, code:'STALE', current:current, baseVersion:opts.baseVersion };
    }

    var now = Date.now(), before = {};
    for (var id2 in valid) if (valid.hasOwnProperty(id2)) {
      before[id2] = map[id2] ? (map[id2].onHand || 0) : null;
      map[id2] = { onHand: valid[id2], updatedAt: now };
    }
    all[productId] = map;
    if (!writeJSON(LS_COMBO, all)) return { ok:false, code:'PERSIST_FAILED' };

    var total = syncProductTotal(productId);
    audit('inventory.combination.adjusted', { storeSlug:auth.product.slug, actor:opts.actor,
      source:'merchant', key:'combo:' + productId + ':' + now,
      metadata:{ productId:productId, changes:valid, before:before, productTotal:total } });
    emit();
    return { ok:true, productId:productId, applied:valid, before:before, productTotal:total, updatedAt:now };
  }

  /* +/- against the current value; the UI shows the resulting number */
  function adjustCombination(productId, comboId, delta, opts){
    opts = opts || {};
    if (typeof delta !== 'number' || !isFinite(delta) || delta === 0)
      return { ok:false, code:'INVALID_QUANTITY', value:delta };
    if (delta !== Math.floor(delta)) return { ok:false, code:'INVALID_QUANTITY', value:delta };
    var next = comboOnHand(comboId) + delta;
    if (next < 0) return { ok:false, code:'INVALID_QUANTITY', reason:'negative', resulting:next };
    var e = {}; e[comboId] = next;
    return setCombinations(productId, e, opts);
  }

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

    var snapshotItems = res.items, snapshotStatus = res.status, snapshotCombos = res.combos;
    res.items = next;
    if (!Object.keys(next).length) { res.status = STATUS.RELEASED; res.releasedAt = Date.now(); }
    /* §28 — release ONLY this line's combination, never every size or colour */
    var relCombo = opts.combinationId || null;
    if (res.combos) {
      if (!relCombo) {
        var owned = Object.keys(res.combos).filter(function (c) {
          var pp = partsOf(c); return pp && pp.productId === productId; });
        /* one combination of this product on the order: unambiguous */
        if (owned.length === 1) relCombo = owned[0];
      }
      if (!relCombo || !res.combos[relCombo] || res.combos[relCombo] < qty) {
        S().updateProduct(productId, { stock: before });    /* undo step 1 */
        return { ok:false, code:'COMBINATION_REQUIRED', productId:productId,
                 held:res.combos[relCombo] || 0, requested:qty };
      }
      var nc = {};
      for (var ck in res.combos) if (res.combos.hasOwnProperty(ck)) nc[ck] = res.combos[ck];
      nc[relCombo] -= qty;
      if (nc[relCombo] === 0) delete nc[relCombo];
      res.combos = Object.keys(nc).length ? nc : null;
    }
    lineOps(res)[opKey] = { type:'release', productId:productId, qty:qty,
                            combinationId:relCombo || null, at:Date.now() };
    all[orderId] = res;

    if (!writeJSON(LS_RES, all)) {
      /* nothing partial survives: put the stock back exactly as it was */
      S().updateProduct(productId, { stock: before });
      res.items = snapshotItems; res.status = snapshotStatus; res.combos = snapshotCombos;
      return { ok:false, code:'PERSIST_FAILED', rolledBack:true };
    }
    if (isCombinationMode(productId)) syncProductTotal(productId);

    addMovements([movement(productId, qty, DIRECTION.RELEASE,
                           opts.reason || 'order_line_removed', orderId, opts.actor)]);
    if (relCombo) audit('inventory.combination.released', { orderId:orderId, storeSlug:slugOf(productId),
      actor:opts.actor, source:'system', systemGenerated:!opts.actor, key:'crelline:' + opKey,
      metadata:{ combinationId:relCombo, quantity:qty, reason:opts.reason || 'order_line_removed' } });
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
    /* Same product is allowed ONLY when the combination itself is moving —
       an approved size or colour change swaps Black/M for Black/L within the
       same product. Anything else is still a no-op and refused. */
    var sameProduct = fromProductId === toProductId;
    if (sameProduct && !(opts.fromCombinationId && opts.toCombinationId &&
                         opts.fromCombinationId !== opts.toCombinationId))
      return { ok:false, code:'INVALID_LINE', reason:'same_product' };
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

    var snapshotItems = res.items, snapshotCombos = res.combos;
    var next = {};
    for (var k in res.items) if (res.items.hasOwnProperty(k)) next[k] = res.items[k];
    next[fromProductId] -= qty;
    if (next[fromProductId] === 0) delete next[fromProductId];
    next[toProductId] = (next[toProductId] || 0) + qty;

    /* §29 — the held combination moves too: the old one is given back and
       the new one taken, in the same write. Either both land or neither. */
    var fromCombo = opts.fromCombinationId || null, toCombo = opts.toCombinationId || null;
    if (res.combos || isCombinationMode(toProductId)) {
      var held = res.combos || {};
      if (!fromCombo && isCombinationMode(fromProductId)) {
        var mine = Object.keys(held).filter(function (c) {
          var pp = partsOf(c); return pp && pp.productId === fromProductId; });
        if (mine.length === 1) fromCombo = mine[0];
      }
      if (isCombinationMode(fromProductId) && (!fromCombo || (held[fromCombo] || 0) < qty)) {
        S().updateProduct(fromProductId, { stock: fromBefore });
        S().updateProduct(toProductId,   { stock: toBefore });
        return { ok:false, code:'COMBINATION_REQUIRED', productId:fromProductId, rolledBack:true };
      }
      if (isCombinationMode(toProductId)) {
        if (!toCombo) {
          S().updateProduct(fromProductId, { stock: fromBefore });
          S().updateProduct(toProductId,   { stock: toBefore });
          return { ok:false, code:'COMBINATION_REQUIRED', productId:toProductId, rolledBack:true };
        }
        if (comboAvailable(toCombo) < qty) {
          S().updateProduct(fromProductId, { stock: fromBefore });
          S().updateProduct(toProductId,   { stock: toBefore });
          return { ok:false, code:'INSUFFICIENT_STOCK', rolledBack:true,
                   shortages:[{ productId:toProductId, combinationId:toCombo,
                                requested:qty, available:comboAvailable(toCombo) }] };
        }
      }
      var nc = {};
      for (var ck2 in held) if (held.hasOwnProperty(ck2)) nc[ck2] = held[ck2];
      if (fromCombo) { nc[fromCombo] -= qty; if (nc[fromCombo] === 0) delete nc[fromCombo]; }
      if (toCombo)   { nc[toCombo] = (nc[toCombo] || 0) + qty; }
      res.combos = Object.keys(nc).length ? nc : null;
    }

    res.items = next;
    lineOps(res)[opKey] = { type:'replace', from:fromProductId, to:toProductId, qty:qty,
                            fromCombinationId:fromCombo || null, toCombinationId:toCombo || null,
                            at:Date.now() };
    all[orderId] = res;

    if (!writeJSON(LS_RES, all)) {
      S().updateProduct(fromProductId, { stock: fromBefore });
      S().updateProduct(toProductId,   { stock: toBefore });
      res.items = snapshotItems; res.combos = snapshotCombos;
      return { ok:false, code:'PERSIST_FAILED', rolledBack:true };
    }
    if (isCombinationMode(fromProductId)) syncProductTotal(fromProductId);
    if (isCombinationMode(toProductId))   syncProductTotal(toProductId);

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
    /* variant combination inventory */
    combinationIdFor: combinationIdFor, partsOf: partsOf, modeOf: modeOf,
    isCombinationMode: isCombinationMode, combinationsOf: combinationsOf,
    candidateCombinations: candidateCombinations, combinationState: combinationState,
    comboOnHand: comboOnHand, comboAvailable: comboAvailable, reservedCombo: reservedCombo,
    setCombinations: setCombinations, adjustCombination: adjustCombination,
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
