/* ==========================================================================
 * RAF — DRIVER DELIVERY AUTHORITY  (RAFDriver)
 * --------------------------------------------------------------------------
 * The delivery-side reading and acting layer for the Driver workspace. It is
 * NOT a second order engine: every order state it reports comes from
 * RAFOrderEngine, every order fact it shows comes from RAFOrderSnapshot, and
 * the single mutation it performs is the engine's own driver operation.
 *
 * WHAT EXISTS TODAY (verified in the code, not assumed):
 *   · RAFOrderEngine.driverAssigned(orderId, actor)  Ready → with a driver
 *     (the stored engine state is named 'waiting_driver'; it means a driver
 *     has claimed the order)
 *   · RAFOrderEngine.driverPickedUp(orderId, actor)  pickup + Ready recovery
 *   · RAFOrderSnapshot.fulfilment { driverId, assignedAt, pickedUpAt, deliveredAt }
 *     — a reserved, approved-to-update section
 *   · RAFAudit driver actions: assigned (a claim), pickup, pickup_recovery,
 *     delivered
 *
 * THE POOL MODEL: a RAF-wide DRIVER POOL with FIRST-COME-FIRST-SERVED
 * claiming, and no automatic or proximity-based dispatch: every eligible
 * driver sees the same pool and the first successful claim owns the order.
 * MANUAL DISPATCH (Phase C): a Logistics employee may instead assign a pool
 * delivery to an active driver through transferOwnership({ kind:
 * 'first_assignment' }). Claim and dispatch share one race arbitration, so
 * exactly one of them can win a delivery. Reassignment of an owned delivery
 * is reserved for the next phase and refused. A driver may SKIP a pool
 * delivery: a permanent record, never ownership. See claim() for how far a
 * browser-storage prototype can take arbitration, and where a server becomes
 * mandatory.
 *
 * A driver cannot hand a claimed delivery back directly. The future problem
 * flow is a reassignment request decided by Logistics (not implemented).
 *
 * WHAT DOES NOT EXIST, AND IS THEREFORE NOT INVENTED HERE:
 *   · driver availability (online/offline), driver metrics, proof of
 *     delivery, delivery-failure reasons, coordinates or navigation. None of
 *     them have a data model in RAF today.
 * Each of these is reported by capabilities() as unavailable, with the reason.
 *
 * IDENTITY. A driver is the AUTHENTICATED account and nothing else: RAFPerm's
 * user record, with accountType `driver`, the driver role, an active status
 * and the orders.view permission that role carries. A caller-supplied driver
 * id, order owner or store slug is never trusted; an id naming somebody else
 * is refused rather than redirected. Everything fails closed.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDriver) return;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function L(o){ return (o && typeof o === 'object') ? (isEn() ? (o.en || o.ar) : (o.ar || o.en)) : (o || ''); }

  var ERRORS = {
    FORBIDDEN:          { ar:'مساحة السائق متاحة لحسابات السائقين النشطة فقط.', en:'The driver workspace is available to active driver accounts only.' },
    OTHER_DRIVER:       { ar:'لا يمكن العمل نيابة عن سائق آخر.',               en:'Another driver’s work cannot be acted on.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',            en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:    { ar:'الطلب غير موجود.',                              en:'That order does not exist.' },
    NOT_ASSIGNED:       { ar:'هذا الطلب غير مسند إليك.',                      en:'That order is not assigned to you.' },
    ALREADY_PICKED_UP:  { ar:'تم تسجيل استلام هذا الطلب مسبقاً.',             en:'This order is already recorded as picked up.' },
    NOT_READY:          { ar:'الطلب غير جاهز للاستلام بعد.',                  en:'The order is not ready for pickup yet.' },
    ALREADY_CLAIMED:    { ar:'سحب سائق آخر هذا الطلب.',                       en:'This delivery was already taken by another driver.' },
    NOT_CLAIMABLE:      { ar:'هذا الطلب غير متاح للسحب.',                     en:'This delivery is not available to take.' },
    CLAIM_FAILED:       { ar:'تعذّر سحب الطلب. حدّث القائمة وحاول مرة أخرى.', en:'The delivery could not be taken. Refresh the list and try again.' },
    NOT_PICKED_UP:      { ar:'سجّل استلام الطلب من المتجر أولاً.',            en:'Record the pickup from the store first.' },
    ALREADY_DELIVERED:  { ar:'تم تسجيل تسليم هذا الطلب مسبقاً.',              en:'This order is already recorded as delivered.' },
    ENGINE_REFUSED:     { ar:'تعذّر تسجيل الاستلام.',                         en:'The pickup could not be recorded.' },
    UNAVAILABLE:        { ar:'هذه العملية غير مُهيّأة بعد وتحتاج اعتماد قاعدة عمل.',
                          en:'That operation is not configured yet and needs a business rule to be approved.' },
    NOT_SKIPPABLE:      { ar:'لا يمكن تخطي هذا الطلب لأنه غير متاح في القائمة.', en:'This delivery cannot be skipped because it is not available in the pool.' },
    ALREADY_SKIPPED:    { ar:'سبق أن تخطيت هذا الطلب.',                          en:'You already skipped this delivery.' },
    SKIP_FAILED:        { ar:'تعذّر تسجيل التخطي.',                              en:'The skip could not be recorded.' },
    NOT_AVAILABLE:      { ar:'أنت غير متاح حاليًا لمهام جديدة.',                   en:'You are currently unavailable for new tasks.' },
    TARGET_UNAVAILABLE: { ar:'السائق المحدد غير متاح لمهام جديدة.',               en:'The selected driver is unavailable for new tasks.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(obj, allowed){
    return Object.keys(obj || {}).every(function (k) { return allowed.indexOf(k) > -1; });
  }

  /* ══════════════════ IDENTITY ══════════════════
     Fail closed. A merchant, a customer, a suspended driver, an account that
     is not a driver at all and an unknown session all get the same refusal,
     and no surface can talk this module into a different answer. */
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  /* The signed-in account, and only an explicitly signed-in one. RAFPerm's
     currentUser() falls back to the first administrator when no session is
     stored; that demo convenience is not inherited here, so "nobody is signed
     in" resolves to nobody rather than to somebody. */
  function sessionId(){
    try {
      var key = (global.RAFPerm && RAFPerm.LS && RAFPerm.LS.session) || 'raf_current_user';
      var raw = localStorage.getItem(key);
      if (raw == null || raw === '') return null;
      var id = null;
      try { id = JSON.parse(raw); } catch (e) { id = raw; }
      if (typeof id !== 'string' || !id) return null;
      var u = RAFPerm.getUser(id);
      return (u && u.id) || null;
    } catch (e) { return null; }
  }
  function driverRecord(id){
    if (!id || !global.RAFPerm) return null;
    var u = null;
    try { u = RAFPerm.getUser(id); } catch (e) { return null; }
    if (!u) return null;
    if (u.accountType !== 'driver' || u.roleId !== 'driver') return null;
    if (u.status !== 'active') return null;
    /* the permission the driver role actually carries — not a new key */
    try { if (!RAFPerm.can(u.id, 'orders.view')) return null; } catch (e) { return null; }
    return u;
  }
  function scope(actor){
    var me = sessionId();
    if (!me) return fail('FORBIDDEN');
    var asked = actorId(actor);
    if (asked && asked !== me) return fail('OTHER_DRIVER');
    var u = driverRecord(me);
    if (!u) return fail('FORBIDDEN');
    return { ok:true, id:u.id, name:u.name, roleId:u.roleId };
  }
  /* the actor object handed to the engine and the audit log — built here from
     the authenticated record, never from anything the caller passed in */
  function engineActor(sc){ return { id:sc.id, name:sc.name, roleId:sc.roleId }; }
  function isDriver(userOrId){ return !!driverRecord(actorId(userOrId) || sessionId()); }

  /* ══════════════════ ORDER READING ══════════════════
     Nothing is computed about an order here. The stage comes from the engine,
     the facts come from the snapshot. */
  var E = function (){ return global.RAFOrderEngine; };
  var SNAP = function (){ return global.RAFOrderSnapshot; };

  function allOrders(){
    if (!global.RAFShop) return [];
    try { return RAFShop.Orders.all() || []; } catch (e) { return []; }
  }
  function fulfilmentOf(snap){
    var f = snap && snap.fulfilment;
    return (f && typeof f === 'object') ? f : { driverId:null, assignedAt:null, pickedUpAt:null, deliveredAt:null };
  }
  /* ---------- the delivery stage ----------
     DERIVED, never stored twice. Every stage below is read from the engine's
     own order state plus the snapshot's approved `fulfilment` section, so the
     delivery lifecycle adds no parallel state machine and no second
     assignment field:

       awaiting_driver  — the store is finished, nobody has claimed it
       claimed          — fulfilment.driverId is set, no pickup recorded
       out_for_delivery — fulfilment.pickedUpAt is set; the goods are with the
                          driver and on the way. "Delivery started" is this
                          same moment: leaving the store with the order IS the
                          start, so no separate start timestamp is invented.
       delivered        — the engine moved the order to delivered
       closed           — cancelled, or otherwise no longer live             */
  var STAGE = { AWAITING:'awaiting_driver', CLAIMED:'claimed',
                OUT:'out_for_delivery', DELIVERED:'delivered', CLOSED:'closed' };
  function stageOf(order){
    var eng = E(); if (!eng || !order) return null;
    if (order.status === 'delivered') return STAGE.DELIVERED;
    if (order.status === 'cancelled') return STAGE.CLOSED;
    var f = fulfilmentOf(order.snapshot);
    var q = eng.queueOf(order);
    /* Phase D: a delivery returned to the pool AFTER pickup has no owner and
       is READY again. The pickup stays historically true (pickedUpAt is kept)
       but the delivery is waiting for a driver, so ownership decides first. */
    if (!f.driverId && q === 'ready') return STAGE.AWAITING;
    if (f.pickedUpAt) return STAGE.OUT;
    if (q === 'driver') return f.driverId ? STAGE.CLAIMED : STAGE.OUT;
    if (q === 'ready')  return f.driverId ? STAGE.CLAIMED : STAGE.AWAITING;
    return null;                                  /* still the merchant's */
  }
  var STAGE_TEXT = {
    awaiting_driver: { ar:'بانتظار سائق',          en:'Waiting for a driver' },
    /* covers both a claim and a Logistics assignment: the driver owns it either way */
    claimed:         { ar:'لديك — للاستلام',       en:'Yours — collect' },
    out_for_delivery:{ ar:'بحوزتك — قيد التوصيل',  en:'With you — out for delivery' },
    delivered:       { ar:'تم التسليم',            en:'Delivered' },
    closed:          { ar:'منتهٍ',                 en:'Closed' }
  };

  /* ---------- the delivery view of an order ----------
     Deliberately narrow. A driver sees what delivering the order requires and
     nothing else: no audit trail, no settlement or commission, no inventory,
     no preparation notes, no permissions, no customer account record. The
     customer's name, phone and address are the ones the customer themselves
     entered for this delivery in the snapshot — no new PII is introduced and
     nothing is copied into driver-side storage. */
  function taskView(order){
    var snap = order && order.snapshot; if (!snap) return null;
    var f = fulfilmentOf(snap), d = snap.delivery || {}, c = snap.customer || {}, m = snap.commercial || {};
    var cod = m.paymentStatus === 'cod';
    return {
      orderId:    snap.orderId || order.id,
      stage:      stageOf(order),
      store:      { name:{ ar:snap.storeNameAr, en:snap.storeNameEn }, number:snap.storeId || null,
                    /* RAF holds no store address or coordinates — see capabilities() */
                    address:null },
      delivery:   { type:d.type || null, timing:d.timing || null, receiveAt:d.receiveAt || null,
                    scheduled:snap.scheduled || null,
                    address:d.address || null, area:d.area || null, block:d.block || null,
                    street:d.street || null, building:d.building || null, floor:d.floor || null,
                    apartment:d.apartment || null,
                    /* written by the customer for whoever delivers the order */
                    instructions:d.instructions || null },
      customer:   { name:c.name || null, phone:c.phone || null },
      items:      (snap.items || []).map(function (it) {
                    return { name:{ ar:it.nameAr, en:it.nameEn }, qty:it.qty };
                  }),
      itemCount:  (snap.items || []).reduce(function (s, it) { return s + (Number(it.qty) || 0); }, 0),
      payment:    { method:m.paymentMethod || null, status:m.paymentStatus || null,
                    /* the amount to collect, and only when the customer pays on delivery */
                    collect:cod ? (m.grandTotal != null ? m.grandTotal : null) : null,
                    currency:m.currency || null },
      fulfilment: { driverId:f.driverId, assignedAt:f.assignedAt, pickedUpAt:f.pickedUpAt, deliveredAt:f.deliveredAt },
      /* the owner's own pending reassignment request (task views are only
         returned to the owner or, for the pool, have no owner) */
      reassignmentRequest: (function () { var p = f.driverId ? pendingRequestOf(snap.orderId || order.id) : null;
        return p ? { requestId:p.requestId, reason:p.reason, at:p.at } : null; })(),
      placedAt:   snap.checkoutAt || null
    };
  }

  /* ══════════════════ READS ══════════════════ */
  /* a delivery is live until it is delivered, cancelled or otherwise closed */
  function isLive(o){
    var s = stageOf(o);
    return !!s && s !== STAGE.DELIVERED && s !== STAGE.CLOSED;
  }
  /* every live delivery-side order, whoever it belongs to */
  function liveOrders(){ return allOrders().filter(isLive); }
  /* THE DRIVER POOL. Orders the store has finished with that nobody has
     claimed yet — the same list for every eligible driver, across every store:
     the approved model is one RAF pool, not a per-store, zoned or matched
     queue. An order leaves this list the moment somebody claims it. */
  function queue(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var list = liveOrders().filter(function (o) { return stageOf(o) === STAGE.AWAITING; });
    var byId = {}; list.forEach(function (o) { byId[o.id] = o; });
    var pooled = orderPool(list.map(function (o) { return { orderId:o.id, entry:poolEntryOf(o) }; }));
    var tasks = pooled.priority.concat(pooled.regular).map(function (p) {
      return Object.assign(taskView(byId[p.orderId]), { pool:p.entry.pool, skippedByMe:hasSkipped(sc.id, p.orderId, p.entry) });
    });
    return { ok:true, driverId:sc.id, claimable:true, tasks:tasks };
  }

  /* ══════════════════ POOL ENTRY & ORDERING ══════════════════
     When a delivery entered the pool, and which pool it is in, derived from
     authoritative records only:

       · FIRST ENTRY — the store finished the order: the latest non-undone
         'order.ready' audit event (RAFOrderEngine.readyAt). Always the
         Regular Pool: the Priority rule applies to returned deliveries only.
       · RETURNED — the latest ownership-history entry is a 'returned_to_pool'
         record. No Phase C action produces one (return-to-pool belongs to the
         Reassignment phase); the classification is ready for it. Approved
         rule (RAFConfig 'pool.priorityAfterMinutes' = 5): returned within the
         first 5 minutes of the returning driver's ownership → Regular; after
         more than 5 minutes → Priority.

     Ordering (RAFConfig 'pool.regularOrder' / 'pool.priorityOrder'):
       · Regular  — oldest pool entry first;
       · Priority — promised ETA closest first (RAFOrderEngine.promisedEtaAt).
     A delivery whose ordering timestamp is missing is placed after every
     timed one and reports which source is missing; ties break by order id so
     the order never depends on storage insertion. */
  function poolEntryOf(o){
    var recs = ownershipRecords(o.id), last = recs.length ? recs[recs.length - 1] : null;
    if (last && last.kind === 'returned_to_pool') {
      /* the classification decided at the moment of return is authoritative */
      if (last.pool === 'priority' || last.pool === 'regular')
        return { kind:'returned', enteredAt:last.at || null, source:'RAFRecordStore:ownership',
                 heldMs:last.heldMs != null ? last.heldMs : null, pool:last.pool, classified:true, missing:null };
      var after = global.RAFConfig ? RAFConfig.value('pool.priorityAfterMinutes') : null;
      var held = (last.previousOwnerSince != null && last.at != null) ? last.at - last.previousOwnerSince : null;
      var known = typeof after === 'number' && held != null;
      return { kind:'returned', enteredAt:last.at || null, source:'RAFRecordStore:ownership',
               heldMs:held, pool:known && held > after * 60000 ? 'priority' : 'regular', classified:known,
               missing:known ? null : (held == null ? 'ownership.previousOwnerSince' : 'RAFConfig:pool.priorityAfterMinutes') };
    }
    var eng = E(), r = eng && eng.readyAt ? eng.readyAt(o.id) : null;
    return { kind:'first', enteredAt:r ? r.at : null, source:r ? r.source : null,
             heldMs:null, pool:'regular', classified:true, missing:r ? null : 'RAFAudit:order.ready' };
  }
  function orderPool(items){
    var eng = E();
    function cmp(a, b){
      var x = a.ordering.at, y = b.ordering.at;
      if (x == null && y != null) return 1;
      if (y == null && x != null) return -1;
      if (x != null && y != null && x !== y) return x - y;
      return String(a.orderId) < String(b.orderId) ? -1 : (String(a.orderId) > String(b.orderId) ? 1 : 0);
    }
    var regular = [], priority = [];
    items.forEach(function (it) {
      if (it.entry.pool === 'priority') {
        var eta = eng && eng.promisedEtaAt ? eng.promisedEtaAt(it.orderId) : null;
        priority.push(Object.assign({}, it, { ordering:{ basis:'promised_eta', at:eta ? eta.at : null,
          missing:eta ? null : 'RAFOrderEngine.promisedEtaAt' } }));
      } else {
        regular.push(Object.assign({}, it, { ordering:{ basis:'pool_entry', at:it.entry.enteredAt,
          missing:it.entry.enteredAt != null ? null : (it.entry.missing || 'pool_entry') } }));
      }
    });
    return { regular:regular.sort(cmp), priority:priority.sort(cmp) };
  }

  /* ══════════════════ SKIP ══════════════════
     Approved definition: a driver skips an Available Pool delivery WITHOUT
     claiming it. A skip creates no ownership, changes no order state, assigns
     nobody, cancels and refunds nothing, touches no inventory, notifies no
     customer and resets no availability timer (none exists yet). It is
     recorded permanently in RAFRecordStore 'driver_skips' for the future
     Performance system, audited ('driver.skipped') and published.
     One skip per driver per pool entry: a delivery that later returns to the
     pool is a new entry. The skipped delivery stays visible and claimable —
     no rule hides it. Identity is the session; driverId / storeSlug / actorId
     are not accepted. SKIP IS A DRIVER OPERATION, NOT A LOGISTICS ONE: it is
     gated by scope() (an active driver account acting for itself) and never by
     staff access, so customers, merchants, merchant employees and every staff
     role — ops manager and super admin included — are refused. */
  function skipIdOf(driverId, orderId, entry){
    return 'skp|' + driverId + '|' + orderId + '|' + (entry && entry.enteredAt != null ? entry.enteredAt : 'na');
  }
  function hasSkipped(driverId, orderId, entry){
    if (!global.RAFRecordStore) return false;
    return !!RAFRecordStore.collection('driver_skips').byId('skipId', skipIdOf(driverId, orderId, entry));
  }
  function skip(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!global.RAFRecordStore) return fail('SKIP_FAILED');
    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    if (o.status === 'delivered' || o.status === 'cancelled') return fail('NOT_SKIPPABLE', { reason:'closed' });
    var f = fulfilmentOf(o.snapshot);
    if (f.driverId) return fail('NOT_SKIPPABLE', { reason:'owned' });
    if (stageOf(o) !== STAGE.AWAITING) return fail('NOT_SKIPPABLE', { reason:'not_in_pool' });
    var entry = poolEntryOf(o), c = RAFRecordStore.collection('driver_skips');
    var skipId = skipIdOf(sc.id, orderId, entry);
    if (c.byId('skipId', skipId)) return fail('ALREADY_SKIPPED');
    var rec = { skipId:skipId, orderId:orderId, driverId:sc.id, at:Date.now(), pool:entry.pool,
                poolEntryKind:entry.kind, poolEntryAt:entry.enteredAt, storeSlug:o.snapshot.storeSlug || null, version:1 };
    var r = c.append('skipId', rec);
    if (!r.ok) return fail('SKIP_FAILED', { detail:r.reason });
    if (r.duplicate) return fail('ALREADY_SKIPPED');
    if (global.RAFAudit) {
      try { RAFAudit.record({ action:'driver.skipped', orderId:orderId, actor:{ id:sc.id }, source:'driver', key:skipId,
              metadata:{ skipId:skipId, pool:entry.pool, poolEntryAt:entry.enteredAt } }); } catch (e) {}
    }
    if (global.RAFEventBus) RAFEventBus.publish('driver.delivery.skipped', { entityId:orderId, source:'driver',
      storeSlug:o.snapshot.storeSlug || null, payload:{ skipId:skipId } });
    return { ok:true, skip:r.record };
  }
  /* only what this authenticated driver is actually assigned, proven from the
     order's own snapshot — never from a parameter */
  function mine(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var list = allOrders().filter(function (o) {
      return fulfilmentOf(o.snapshot).driverId === sc.id;
    });
    return { ok:true, driverId:sc.id,
             tasks:list.filter(isLive).map(taskView),
             /* delivered and cancelled work belongs to the history screen */
             closed:list.filter(function (o) { return !isLive(o) && !!stageOf(o); }).map(taskView) };
  }
  /* the one delivery in hand: RAF has no batching rule, so this is the single
     oldest live assignment and never a route */
  function active(opts){
    var r = mine(opts); if (!r.ok) return r;
    var t = r.tasks.slice().sort(function (a, b) {
      return (a.fulfilment.assignedAt || 0) - (b.fulfilment.assignedAt || 0); })[0] || null;
    return { ok:true, driverId:r.driverId, task:t, others:Math.max(0, r.tasks.length - (t ? 1 : 0)) };
  }
  /* completed work, read from the real orders. No record is generated to fill
     the screen: with nothing delivered the list is honestly empty. */
  function history(opts){
    var r = mine(opts); if (!r.ok) return r;
    return { ok:true, driverId:r.driverId, tasks:r.closed };
  }
  function task(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var f = fulfilmentOf(o.snapshot);
    /* an order nobody is carrying is queue information; an order somebody else
       is carrying is none of this driver's business */
    if (f.driverId && f.driverId !== sc.id) return fail('NOT_ASSIGNED');
    return { ok:true, driverId:sc.id, task:taskView(o) };
  }
  /* the driver's own account record, read-only, straight from RAFPerm */
  function profile(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var u = driverRecord(sc.id), role = null;
    try { role = RAFPerm.getRole(u.roleId); } catch (e) {}
    return { ok:true, id:u.id, name:u.name, email:u.email || null, phone:u.phone || null,
             role:role ? { ar:role.nameAr, en:role.nameEn } : null,
             accountType:u.accountType, status:u.status, since:u.regDate || null,
             editable:false, editableReason:'no_self_service_account_authority' };
  }

  /* ══════════════════ CLAIMING — FIRST COME, FIRST SERVED ══════════════════
     No automatic assignment. Every eligible driver sees the same pool and the
     first one to claim an order owns it.
     ──────────────────────────────────────────────────────────────────────
     HOW FAR THE PROTOTYPE CAN GO, STATED PLAINLY.
     `localStorage` has no transaction: two tabs can read the same "free"
     order and both write. A production deployment REQUIRES a server-side
     transactional claim (a conditional update / compare-and-set on the order
     row). Nothing here can substitute for that, and nothing here pretends to.

     What this does instead is the strongest arbitration the storage layer
     allows, and it is deterministic rather than hopeful:

       1 · the durable record is checked first — a snapshot that already
           names a driver ends the attempt immediately;
       2 · the claim is written into a small, single-purpose ledger as an
           INTENT carrying a unique token and the claim instant. The ledger is
           not a second assignment field: it decides races only, and every
           read of who owns an order still comes from the snapshot;
       3 · the ledger is then RE-READ and the winner is resolved by the
           earliest instant (token as the tie-break). Both racing tabs run the
           same resolution over the same data, so they agree on the same
           winner, and the loser restores the winner's intent and is refused;
       4 · only the winner writes ownership into the snapshot and moves the
           engine to waiting-driver.
     A lost update between steps 2 and 3 is still possible in principle; when
     it happens, step 1's durable check on the next attempt refuses the second
     driver. That is the honest boundary of a browser-storage prototype. */
  var LS_CLAIMS = 'raf_driver_claims';
  function claimsAll(){
    try { var v = JSON.parse(localStorage.getItem(LS_CLAIMS) || 'null');
      return (v && typeof v === 'object') ? v : {}; } catch (e) { return {}; }
  }
  function writeClaims(m){
    try { localStorage.setItem(LS_CLAIMS, JSON.stringify(m)); return true; } catch (e) { return false; }
  }
  function token(){
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
  /* earliest instant wins; identical instants are resolved by token so the
     comparison can never depend on which tab happens to ask */
  function earlier(a, b){
    if (!a) return b; if (!b) return a;
    if (a.at !== b.at) return a.at < b.at ? a : b;
    return String(a.token) < String(b.token) ? a : b;
  }
  /* Steps 2 and 3 of the arbitration, shared by a driver's claim and a
     Logistics first assignment so the two can never both win one delivery.
     `driverId` is the driver who would own it — the claimant, or the target
     an authorised staff member chose. */
  function arbitrate(orderId, driverId){
    var intent = { driverId:driverId, token:token(), at:Date.now() };
    var ledger = claimsAll();
    var standing = ledger[orderId];
    if (standing && standing.driverId && standing.driverId !== driverId) return { ok:false };
    ledger[orderId] = intent;
    if (!writeClaims(ledger)) return { ok:false, failed:true };
    /* re-read and resolve — both racers reach the same verdict */
    var after = claimsAll()[orderId];
    var winner = earlier(after, intent);
    if (!winner || winner.driverId !== driverId || winner.token !== intent.token){
      var back = claimsAll(); back[orderId] = winner; writeClaims(back);   /* keep the winner's intent */
      return { ok:false };
    }
    return { ok:true, intent:intent };
  }
  function dropIntent(orderId, intent){
    var l = claimsAll();
    if (l[orderId] && intent && l[orderId].token === intent.token) { delete l[orderId]; writeClaims(l); }
  }
  function claim(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var eng = E(), sn = SNAP();
    if (!eng || !sn) return fail('CLAIM_FAILED');

    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');

    /* 1 · the durable record decides first */
    var f = fulfilmentOf(o.snapshot);
    if (f.driverId) return f.driverId === sc.id ? task(orderId, { actor:sc.id }) : fail('ALREADY_CLAIMED');
    /* the order must really be claimable: the store has finished with it */
    if (stageOf(o) !== STAGE.AWAITING) return fail('NOT_CLAIMABLE');
    /* Phase F: only an AVAILABLE driver takes new work (evaluated now, so an
       auto-offline that fell due is applied before the claim is decided) */
    var av = availabilityFor(sc.id); if (!av.eligible) return fail('NOT_AVAILABLE', { detail:av.reason });

    /* 2 + 3 · write the intent, re-read and resolve */
    var arb = arbitrate(orderId, sc.id);
    if (!arb.ok) return fail(arb.failed ? 'CLAIM_FAILED' : 'ALREADY_CLAIMED');
    var mine = arb.intent;
    /* somebody may have committed ownership while we arbitrated */
    var fresh = fulfilmentOf(sn.of(orderId));
    if (fresh.driverId && fresh.driverId !== sc.id) return fail('ALREADY_CLAIMED');
    /* availability may have changed while arbitrating (e.g. the driver or
       management set Unavailable) — re-checked right before commit */
    var av2 = availabilityFor(sc.id);
    if (!av2.eligible) { dropIntent(orderId, mine); return fail('NOT_AVAILABLE', { detail:av2.reason }); }

    /* 4 · commit: the snapshot is the record of ownership, the engine owns
           the state. Both go through their own authority. */
    /* a returned delivery that was already collected keeps its pickup: no
       second, fictional pickup is required or recorded */
    var next = { driverId:sc.id, assignedAt:mine.at, pickedUpAt:fresh.pickedUpAt || null, deliveredAt:null };
    var up = sn.update(orderId, 'fulfilment', next, 'driver_claim', engineActor(sc));
    if (!up.ok){
      var undo = claimsAll(); delete undo[orderId]; writeClaims(undo);
      return fail('CLAIM_FAILED', { detail:up.reason });
    }
    /* the engine records the assignment and its audit event (driver.assigned) */
    eng.driverAssigned(orderId, engineActor(sc));
    /* the permanent ownership history gets the claim as its first entry */
    recordOwnership({ orderId:orderId, kind:'claim', fromDriverId:null, toDriverId:sc.id, at:mine.at,
                      actor:{ type:'driver', id:sc.id, name:sc.name, roleId:sc.roleId }, reason:null,
                      storeSlug:o.snapshot.storeSlug || null, pickedUpAt:next.pickedUpAt });
    if (global.RAFEventBus) RAFEventBus.publish('ownership.claimed', { entityId:orderId, source:'driver',
      storeSlug:o.snapshot.storeSlug || null, payload:{ toDriverId:sc.id } });
    /* a SUCCESSFUL claim is the only Auto-Offline reset (the claim record above is the reference) */
    if (global.RAFDriverManagement && RAFDriverManagement.availability) { try { RAFDriverManagement.availability.claimSucceeded(sc.id); } catch (e) {} }
    return task(orderId, { actor:sc.id });
  }
  /* Phase F — the availability authority decides eligibility for NEW work;
     without it loaded nothing new can be taken (fail closed) */
  function availabilityFor(driverId){
    var A = global.RAFDriverManagement && RAFDriverManagement.availability;
    if (!A || !A.eligibleForNewWork) return { eligible:false, reason:'availability_authority_not_loaded' };
    try { return A.eligibleForNewWork(driverId); } catch (e) { return { eligible:false, reason:'availability_error' }; }
  }

  /* ══════════════════ OWNERSHIP HISTORY — APPEND-ONLY ══════════════════
     The snapshot's fulfilment section says who owns a delivery NOW; this
     history says who owned it, since when, and how it changed hands. Entries
     are appended through RAFRecordStore's 'ownership' collection and are never
     edited or removed — the order blob is not rewritten to remember history.
     Claims made before this history existed have no entry; they are reported
     as `unrecordedOrigin` rather than back-filled. */
  function recordOwnership(e){
    if (!global.RAFRecordStore) return { ok:false, reason:'no_record_store' };
    var rec = Object.assign({ recordId:RAFRecordStore.makeId('own'), version:1 }, e);
    return RAFRecordStore.collection('ownership').append('recordId', rec);
  }
  function ownershipRecords(orderId){
    if (!global.RAFRecordStore) return [];
    return RAFRecordStore.collection('ownership').filter(function (r) { return r.orderId === orderId; })
      .sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); });
  }

  /* ══════════════════ LOGISTICS STAFF (for ownership operations) ══════════════════
     Identity is the signed-in account. The Logistics access rule is
     RAFDeliveryOps' own (active account holding orders.view AND drivers.view).
     Changing who owns a delivery additionally requires the EXISTING
     `orders.manage` key — a provisional mapping until the granular Logistics
     permission phase defines dispatch permissions. No new key, no new role. */
  var STAFF_ERRORS = {
    STAFF_FORBIDDEN:   { ar:'لا تملك صلاحية تغيير ملكية التوصيل.',          en:'You do not have permission to change delivery ownership.' },
    LOCK_REQUIRED:     { ar:'يجب أن تعمل على هذا التوصيل (قفل العملية) أولاً.', en:'You must hold this delivery’s operation lock first.' },
    NOT_OWNED:         { ar:'هذا التوصيل ليس لدى أي سائق.',                  en:'No driver owns this delivery.' },
    DELIVERY_CLOSED:   { ar:'هذا التوصيل منتهٍ.',                            en:'This delivery is already closed.' },
    TARGET_INVALID:    { ar:'السائق المحدد غير صالح أو غير نشط.',             en:'The selected driver is not a valid active driver.' },
    SAME_DRIVER:       { ar:'السائق المحدد هو المالك الحالي.',                en:'The selected driver already owns this delivery.' },
    REASON_REQUIRED:   { ar:'السبب إلزامي لهذه العملية.',                     en:'A reason is required for this operation.' },
    OWNERSHIP_CHANGED: { ar:'تغيّرت ملكية التوصيل أثناء العملية. أعد المحاولة.', en:'Ownership changed during the operation. Try again.' },
    TRANSFER_FAILED:   { ar:'تعذّر نقل الملكية.',                             en:'The ownership transfer could not be completed.' },
    KIND_REQUIRED:     { ar:'نوع عملية الملكية غير محدد.',                     en:'The ownership operation kind is missing or not recognised.' },
    NOT_REASSIGNABLE:  { ar:'هذا التوصيل ليس لدى سائق في مرحلة تسمح بإعادة الإسناد.', en:'This delivery is not with a driver at a stage that allows reassignment.' },
    REQUEST_PENDING:   { ar:'يوجد طلب إعادة إسناد معلّق من السائق؛ يجب البت فيه أولاً.', en:'The driver has a pending reassignment request; decide it first.' },
    NO_PENDING_REQUEST:{ ar:'لا يوجد طلب إعادة إسناد معلّق.',                  en:'There is no pending reassignment request.' },
    REQUEST_CHANGED:   { ar:'تغيّر طلب إعادة الإسناد أثناء العملية. أعد المحاولة.', en:'The reassignment request changed during the operation. Try again.' },
    DECISION_INVALID:  { ar:'قرار غير صالح.',                                  en:'That decision is not valid.' },
    POOL_RULE_NOT_CONFIGURED:{ ar:'قاعدة تصنيف القائمة غير مُهيّأة.',          en:'The pool classification rule is not configured.' },
    ALREADY_OWNED:     { ar:'هذا التوصيل لدى سائق بالفعل ولم يعد متاحاً للإسناد.', en:'A driver already owns this delivery; it is no longer available for assignment.' },
    NOT_DISPATCHABLE:  { ar:'هذا التوصيل ليس بانتظار سائق.',                  en:'This delivery is not waiting for a driver.' },
    STORE_UNRESOLVED:  { ar:'لا يمكن إسناد طلب غير مرتبط بمتجر معروف.',        en:'An order without a resolved store cannot be assigned.' },
    LOCK_POLICY_NOT_CONFIGURED:{ ar:'مدة أقفال العمليات غير مُهيّأة بعد، لذلك الإسناد غير متاح.', en:'Operation lock timing is not configured yet, so assignment is unavailable.' }
  };
  Object.keys(STAFF_ERRORS).forEach(function (k) { ERRORS[k] = STAFF_ERRORS[k]; });

  function staffScope(needsManage){
    if (!global.RAFDeliveryOps || !RAFDeliveryOps.scope) return fail('STAFF_FORBIDDEN');
    var sc = RAFDeliveryOps.scope();                 /* session-based, refuses actors */
    if (!sc.ok) return fail('STAFF_FORBIDDEN', { detail:sc.code });
    if (needsManage) {
      var ok = false; try { ok = !!RAFPerm.can(sc.id, 'orders.manage'); } catch (e) { ok = false; }
      if (!ok) return fail('STAFF_FORBIDDEN');
    }
    return { ok:true, id:sc.id, name:sc.name, roleId:sc.roleId };
  }

  /* ══════════════════ OWNERSHIP CHANGE — THE ONE STAFF PRIMITIVE ══════════════════
     transferOwnership(orderId, { kind, toDriverId }) is the ONE way Logistics
     staff change who owns a delivery. `kind` makes the business action
     explicit so a caller can never turn one into the other:

       · 'first_assignment' — IMPLEMENTED (Phase C manual dispatch). The
         delivery is in the pool with no owner; an owned delivery is refused
         with ALREADY_OWNED, never silently reassigned.
       · 'reassignment'     — IMPLEMENTED (Phase D). An owned, open delivery
         moves to another active driver; reason mandatory after pickup. An
         unowned delivery is refused with NOT_OWNED (use first assignment).
       · 'return_to_pool'   — IMPLEMENTED (Phase D). Ownership is removed and
         the delivery is dispatchable again; reason mandatory; Regular or
         Priority decided at the moment of return.
       · anything else      — KIND_REQUIRED.
     While the current driver has a pending reassignment request, reassignment
     and return are refused with REQUEST_PENDING: the request must be decided
     through decideReassignmentRequest(), so no action runs on stale state.
     `expectedDriverId` (optional) is a compare-and-set precondition, never an
     identity: if the owner is no longer that driver the call is refused.

     Authorisation (both kinds): the signed-in account with Logistics access
     plus the existing `orders.manage` key. TEMPORARY PROTOTYPE AUTHORISATION
     BOUNDARY: under today's shared permission model this also admits Customer
     Service and Higher Management (the Finance role does not hold
     drivers.view / orders.manage and is refused). That is not the final Logistics permission model and
     not a business rule; staffScope() is the single place future granular
     Logistics permissions replace it. */
  function transferOwnership(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['kind', 'toDriverId', 'reason', 'expectedDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var st = staffScope(true); if (!st.ok) return st;
    if (opts.kind === 'first_assignment') return firstAssignment(orderId, opts, st);
    if (opts.kind === 'reassignment') return reassignment(orderId, opts, st, null);
    if (opts.kind === 'return_to_pool') return returnToPool(orderId, opts, st, null);
    return fail('KIND_REQUIRED');
  }

  /* the caller must hold the delivery's live Logistics operation lock */
  function lockCheck(orderId, st){
    var D = global.RAFDeliveryOps;
    if (!D || !D.lockOf || !D.lockPolicy) return fail('LOCK_REQUIRED');
    if (!D.lockPolicy().configured) return fail('LOCK_POLICY_NOT_CONFIGURED');
    var l = D.lockOf(orderId);
    if (!l || !l.ok || !l.lock || l.lock.ownerUserId !== st.id || l.lock.stale)
      return fail('LOCK_REQUIRED', { lock:l && l.lock ? { ownerName:l.lock.ownerName, stale:l.lock.stale, mine:l.lock.ownerUserId === st.id } : null });
    return { ok:true, lock:l.lock };
  }

  /* ══════════════════ FIRST ASSIGNMENT (MANUAL DISPATCH) ══════════════════
     A Logistics employee gives a pool delivery to an active driver they chose.
     Order of operations — every check is repeated immediately before commit:
       1 · order exists, is not closed, belongs to a resolved store (snapshot);
       2 · nobody owns it and its derived stage is still "waiting for a driver";
       3 · the caller holds the live operation lock (timing from RAFConfig);
       4 · the target is an active driver account (RAFPerm), never an object
           the page passed;
       5 · the shared claim arbitration is won, so a racing claim or a second
           assignment cannot also win;
       6 · fresh re-read: still unowned, engine still READY, driver still
           active, lock still held, staff session unchanged;
       7 · commit through the owners: snapshot fulfilment (RAFOrderSnapshot),
           engine transition + audit 'dispatch.assigned' (RAFOrderEngine), a
           'dispatch' ownership-history entry, the driver's notification
           (RAFNotify) and 'logistics.delivery.assigned' (RAFEventBus).
     If the engine refuses after the snapshot was written, the snapshot is put
     back and the intent dropped, so no partial assignment remains. Nothing
     financial, commercial or inventory-related is touched and the customer is
     not notified. PROTOTYPE LIMIT: localStorage has no transaction; production
     needs a server-side conditional write covering steps 5–7. */
  function firstAssignment(orderId, opts, st){
    if (!onlyKeys(opts, ['kind', 'toDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var eng = E(), sn = SNAP();
    if (!eng || !sn || typeof eng.driverAssigned !== 'function') return fail('TRANSFER_FAILED');

    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    if (o.status === 'delivered' || o.status === 'cancelled') return fail('DELIVERY_CLOSED');
    if (o.snapshot.legacyUnresolved === true || !o.snapshot.storeSlug) return fail('STORE_UNRESOLVED');
    var f = fulfilmentOf(o.snapshot);
    if (f.deliveredAt) return fail('DELIVERY_CLOSED');
    if (f.driverId) return fail('ALREADY_OWNED');
    if (stageOf(o) !== STAGE.AWAITING) return fail('NOT_DISPATCHABLE', { stage:stageOf(o) });

    var lk = lockCheck(orderId, st); if (!lk.ok) return lk;
    var to = typeof opts.toDriverId === 'string' ? opts.toDriverId : null;
    if (!to || !driverRecord(to)) return fail('TARGET_INVALID');
    if (!availabilityFor(to).eligible) return fail('TARGET_UNAVAILABLE');
    var entry = poolEntryOf(o);

    var arb = arbitrate(orderId, to);
    if (!arb.ok) return fail(arb.failed ? 'TRANSFER_FAILED' : 'ALREADY_OWNED');

    /* 6 · revalidate against fresh reads */
    var fo = allOrders().filter(function (x) { return x.id === orderId; })[0];
    function refuse(code, extra){ dropIntent(orderId, arb.intent); return fail(code, extra); }
    if (!fo || !fo.snapshot || fo.status === 'delivered' || fo.status === 'cancelled') return refuse('DELIVERY_CLOSED');
    var ff = fulfilmentOf(fo.snapshot);
    if (ff.driverId) return refuse('ALREADY_OWNED');
    if (stageOf(fo) !== STAGE.AWAITING || eng.mstate(orderId) !== eng.MSTATE.READY) return refuse('NOT_DISPATCHABLE');
    if (!driverRecord(to)) return refuse('TARGET_INVALID');
    if (!availabilityFor(to).eligible) return refuse('TARGET_UNAVAILABLE');
    var lk2 = lockCheck(orderId, st); if (!lk2.ok) { dropIntent(orderId, arb.intent); return lk2; }
    var st2 = staffScope(true);
    if (!st2.ok || st2.id !== st.id) return refuse('STAFF_FORBIDDEN');

    /* 7 · commit */
    var now = Date.now();
    var staffActor = { id:st.id, name:st.name, roleId:st.roleId };
    var up = sn.update(orderId, 'fulfilment', { driverId:to, assignedAt:now, pickedUpAt:ff.pickedUpAt || null, deliveredAt:null },
                       'dispatch_assignment', staffActor);
    if (!up.ok) return refuse('TRANSFER_FAILED', { detail:up.reason });

    var histId = global.RAFRecordStore ? RAFRecordStore.makeId('own') : null;
    var meta = { fromDriverId:null, toDriverId:to, lockId:lk2.lock.lockId, pool:entry.pool,
                 poolEntryAt:entry.enteredAt, historyRecordId:histId };
    var moved = eng.driverAssigned(orderId, staffActor, { via:'dispatch', metadata:meta });
    if (!moved || !moved.ok) {
      sn.update(orderId, 'fulfilment', ff, 'dispatch_rollback', staffActor);
      return refuse('TRANSFER_FAILED', { detail:moved && moved.reason });
    }

    var hist = recordOwnership({ recordId:histId, orderId:orderId, kind:'dispatch', fromDriverId:null, toDriverId:to,
      at:now, actor:{ type:'staff', id:st.id, name:st.name, roleId:st.roleId }, reason:null,
      storeSlug:fo.snapshot.storeSlug || null, pickedUpAt:ff.pickedUpAt || null, lockId:lk2.lock.lockId,
      pool:entry.pool, poolEntryAt:entry.enteredAt });

    var note = null;
    if (global.RAFNotify && RAFNotify.create) {
      var def = (RAFNotify.EVENT_TYPES || {})['driver.delivery.assigned'] || {};
      note = RAFNotify.create({ recipientUserId:to, eventType:'driver.delivery.assigned', title:def.title,
        message:{ ar:'الطلب ' + orderId, en:'Order ' + orderId }, entityType:'order', entityId:orderId,
        href:'raf_driver.html', source:'admin', metadata:{ historyRecordId:histId },
        dedupeKey:'driver.delivery.assigned|' + orderId + '|' + histId });
    }
    if (global.RAFEventBus) RAFEventBus.publish('logistics.delivery.assigned', { entityId:orderId, source:'admin',
      storeSlug:fo.snapshot.storeSlug || null, payload:{ toDriverId:to, pool:entry.pool } });

    return { ok:true, kind:'first_assignment', orderId:orderId, fromDriverId:null, toDriverId:to, at:now,
             record:hist && hist.record ? hist.record : null, notified:!!(note && note.ok) };
  }

  /* the drivers a Logistics employee may choose from — an active account
     (RAFPerm) AND operationally Available (Phase F, RAFDriverManagement).
     No proximity or capacity rule exists, so none is applied. `liveDeliveries`
     is the number of live deliveries each already owns, read from snapshots.
     `unavailable` counts active accounts currently not available for new work. */
  function eligibleDrivers(){
    var st = staffScope(false); if (!st.ok) return st;
    var users = []; try { users = RAFPerm.getUsers() || []; } catch (e) { users = []; }
    var live = liveOrders();
    var active = users.filter(function (u) { return u && driverRecord(u.id); });
    var avail = active.filter(function (u) { return availabilityFor(u.id).eligible; });
    return { ok:true, unavailable:active.length - avail.length, drivers:avail.map(function (u) {
      return { id:u.id, name:u.name || null,
               liveDeliveries:live.filter(function (o) { return fulfilmentOf(o.snapshot).driverId === u.id; }).length };
    }) };
  }

  /* the dispatchable pool for Logistics staff, classified and ordered */
  function dispatchPool(){
    var st = staffScope(false); if (!st.ok) return st;
    var items = liveOrders().filter(function (o) { return stageOf(o) === STAGE.AWAITING && o.snapshot; })
      .map(function (o) { return { orderId:o.id, entry:poolEntryOf(o),
        storeResolved:!!(o.snapshot.storeSlug && o.snapshot.legacyUnresolved !== true) }; });
    var p = orderPool(items);
    return { ok:true, regular:p.regular, priority:p.priority };
  }

  /* how a delivery's current owner got it: 'claim', 'dispatch', 'transfer', or
     null when the ownership predates the history (staff projection) */
  function ownershipKindOf(orderId){
    var recs = ownershipRecords(orderId), last = recs.length ? recs[recs.length - 1] : null;
    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    var f = o ? fulfilmentOf(o.snapshot) : null;
    return (last && f && f.driverId && last.toDriverId === f.driverId) ? last.kind : null;
  }

  /* ══════════════════ SHARED PHASE D HELPERS ══════════════════ */
  function orderById(orderId){ return allOrders().filter(function (x) { return x.id === orderId; })[0] || null; }
  function trimReason(v){ return typeof v === 'string' ? v.trim() : ''; }
  function audited(opts){
    if (!global.RAFAudit) return null;
    try { var r = RAFAudit.record(opts); return (r && r.event && r.event.eventId) || null; } catch (e) { return null; }
  }
  function userName(id){ try { var u = RAFPerm.getUser(id); return (u && u.name) || null; } catch (e) { return null; } }
  function notifyUser(recipientUserId, eventType, orderId, dedupeTail, href, metadata){
    if (!global.RAFNotify || !RAFNotify.create || !recipientUserId) return null;
    var def = (RAFNotify.EVENT_TYPES || {})[eventType] || {};
    return RAFNotify.create({ recipientUserId:recipientUserId, eventType:eventType, title:def.title,
      message:{ ar:'الطلب ' + orderId, en:'Order ' + orderId }, entityType:'order', entityId:orderId,
      href:href || 'raf_driver.html', source:'admin', metadata:metadata || null,
      dedupeKey:eventType + '|' + orderId + '|' + dedupeTail });
  }
  /* the Logistics staff who receive request notifications: every active
     account inside the SAME temporary Logistics scope staffScope(true) uses
     (orders.view + drivers.view + orders.manage) — no list is invented */
  function staffRecipients(){
    var users = []; try { users = RAFPerm.getUsers() || []; } catch (e) { users = []; }
    return users.filter(function (u) {
      if (!u || u.status !== 'active') return false;
      try { return RAFPerm.can(u.id, 'orders.view') && RAFPerm.can(u.id, 'drivers.view') && RAFPerm.can(u.id, 'orders.manage'); }
      catch (e) { return false; }
    }).map(function (u) { return u.id; });
  }
  /* a live delivery a driver currently owns, at a stage that can change hands */
  function ownedOpen(o){
    var s = stageOf(o), f = fulfilmentOf(o.snapshot);
    return !!(f.driverId && !f.deliveredAt && (s === STAGE.CLAIMED || s === STAGE.OUT));
  }
  /* common staff preconditions for reassignment / return. Returns
     { ok, o, f } or a refusal. */
  function ownedPreconditions(orderId, opts, st, ctx){
    var o = orderById(orderId);
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    if (o.status === 'delivered' || o.status === 'cancelled') return fail('DELIVERY_CLOSED');
    if (o.snapshot.legacyUnresolved === true || !o.snapshot.storeSlug) return fail('STORE_UNRESOLVED');
    var f = fulfilmentOf(o.snapshot);
    if (f.deliveredAt) return fail('DELIVERY_CLOSED');
    if (!f.driverId) return fail('NOT_OWNED');
    if (!ownedOpen(o)) return fail('NOT_REASSIGNABLE', { stage:stageOf(o) });
    if (typeof opts.expectedDriverId === 'string' && opts.expectedDriverId !== f.driverId) return fail('OWNERSHIP_CHANGED');
    var pend = pendingRequestOf(orderId);
    if (pend && !(ctx && ctx.requestId === pend.requestId)) return fail('REQUEST_PENDING', { requestId:pend.requestId });
    if (ctx && ctx.requestId && (!pend || pend.requestId !== ctx.requestId)) return fail('REQUEST_CHANGED');
    return { ok:true, o:o, f:f };
  }

  /* ══════════════════ REASSIGNMENT (Phase D) ══════════════════
     Moves responsibility for an owned, open delivery from its current driver to
     another active driver chosen by a Logistics employee. Manual only.
       · actor = signed-in staff (temporary Logistics scope + orders.manage);
       · OLD owner read from the snapshot, never supplied;
       · target must be an active driver account and not the current owner;
       · the caller must hold the live operation lock (RAFConfig timings);
       · reason optional before pickup, MANDATORY after pickup;
       · everything is re-read right before commit; a pickup that happened in
         between changes the requirement and the call is refused;
       · commit: snapshot fulfilment (new driverId, assignedAt = now, pickup
         kept exactly as it was — no new pickup is recorded) → claim ledger
         follows the owner → audit 'dispatch.reassigned' → ownership record
         'reassignment' → reassignment history → notifications (old driver:
         removed / request approved; new driver: now responsible) → event
         'logistics.delivery.reassigned'.
     The order is not cancelled, refunded, re-priced or re-stocked; the engine
     state does not change (the delivery stays with a driver). */
  function reassignment(orderId, opts, st, ctx){
    if (!onlyKeys(opts, ['kind', 'toDriverId', 'reason', 'expectedDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var sn = SNAP(); if (!sn) return fail('TRANSFER_FAILED');
    var pre = ownedPreconditions(orderId, opts, st, ctx); if (!pre.ok) return pre;
    var o = pre.o, f = pre.f;
    var lk = lockCheck(orderId, st); if (!lk.ok) return lk;
    var to = typeof opts.toDriverId === 'string' ? opts.toDriverId : null;
    if (!to || !driverRecord(to)) return fail('TARGET_INVALID');
    if (to === f.driverId) return fail('SAME_DRIVER');
    if (!availabilityFor(to).eligible) return fail('TARGET_UNAVAILABLE');
    var reason = trimReason(opts.reason);
    if (f.pickedUpAt && !reason) return fail('REASON_REQUIRED');

    /* revalidate against fresh reads */
    var pre2 = ownedPreconditions(orderId, opts, st, ctx); if (!pre2.ok) return pre2;
    var fresh = pre2.f;
    if (fresh.driverId !== f.driverId) return fail('OWNERSHIP_CHANGED');
    if (!!fresh.pickedUpAt !== !!f.pickedUpAt) return fail('OWNERSHIP_CHANGED', { detail:'pickup_changed' });
    if (!driverRecord(to)) return fail('TARGET_INVALID');
    if (!availabilityFor(to).eligible) return fail('TARGET_UNAVAILABLE');
    var lk2 = lockCheck(orderId, st); if (!lk2.ok) return lk2;
    var st2 = staffScope(true); if (!st2.ok || st2.id !== st.id) return fail('STAFF_FORBIDDEN');

    var now = Date.now();
    var staffActor = { id:st.id, name:st.name, roleId:st.roleId };
    var up = sn.update(orderId, 'fulfilment', { driverId:to, assignedAt:now, pickedUpAt:fresh.pickedUpAt || null, deliveredAt:null },
                       'dispatch_reassignment', staffActor);
    if (!up.ok) return fail('TRANSFER_FAILED', { detail:up.reason });
    var led = claimsAll(); led[orderId] = { driverId:to, token:'reassign-' + now.toString(36), at:now }; writeClaims(led);

    var ownId = RAFRecordStore.makeId('own'), rsgId = RAFRecordStore.makeId('rsg');
    var auditId = audited({ action:'dispatch.reassigned', orderId:orderId, actor:{ id:st.id }, source:'admin',
      key:rsgId, previousState:fresh.driverId, newState:to, reason:reason || null,
      metadata:{ fromDriverId:fresh.driverId, toDriverId:to, pickedUp:!!fresh.pickedUpAt, lockId:lk2.lock.lockId,
                 reassignmentId:rsgId, ownershipRecordId:ownId, requestId:(ctx && ctx.requestId) || null } });
    recordOwnership({ recordId:ownId, orderId:orderId, kind:'reassignment', fromDriverId:fresh.driverId, toDriverId:to, at:now,
      actor:{ type:'staff', id:st.id, name:st.name, roleId:st.roleId }, reason:reason || null,
      storeSlug:o.snapshot.storeSlug, pickedUpAt:fresh.pickedUpAt || null, previousOwnerSince:fresh.assignedAt || null,
      lockId:lk2.lock.lockId, requestId:(ctx && ctx.requestId) || null });
    var rec = RAFRecordStore.collection('reassignments').append('reassignmentId', {
      reassignmentId:rsgId, orderId:orderId, storeSlug:o.snapshot.storeSlug, previousDriverId:fresh.driverId, newDriverId:to,
      actorUserId:st.id, actorName:st.name || null, at:now, reason:reason || null,
      pickedUp:!!fresh.pickedUpAt, pickedUpAt:fresh.pickedUpAt || null, previousOwnerSince:fresh.assignedAt || null,
      source:'admin', requestId:(ctx && ctx.requestId) || null, ownershipRecordId:ownId, auditEventId:auditId, version:1 });

    notifyUser(fresh.driverId, ctx && ctx.requestId ? 'driver.reassignment_request.approved' : 'driver.delivery.removed',
               orderId, rsgId, 'raf_driver.html', { via:'reassignment' });
    notifyUser(to, 'driver.delivery.reassigned', orderId, rsgId, 'raf_driver.html', { via:'reassignment' });
    if (global.RAFEventBus) RAFEventBus.publish('logistics.delivery.reassigned', { entityId:orderId, source:'admin',
      storeSlug:o.snapshot.storeSlug, payload:{ reassignmentId:rsgId } });
    return { ok:true, kind:'reassignment', orderId:orderId, fromDriverId:fresh.driverId, toDriverId:to, at:now,
             pickedUp:!!fresh.pickedUpAt, reassignmentId:rsgId, record:rec && rec.record ? rec.record : null };
  }

  /* ══════════════════ RETURN TO POOL (Phase D) ══════════════════
     Removes the current driver's ownership so the delivery can be dispatched
     again. Not a cancellation: no refund, stock, price or delivery closure.
       · reason MANDATORY;
       · classification decided NOW from authoritative ownership timestamps:
         held = return time − fulfilment.assignedAt (when the returning driver
         became the responsible owner). Approved rule, RAFConfig
         'pool.priorityAfterMinutes' (5): held ≤ 5 min → Regular; > 5 min →
         Priority. Stored on the ownership record and the return record.
       · pickup is NOT undone: fulfilment.pickedUpAt is kept and the return
         record states whether pickup had happened;
       · commit: snapshot fulfilment (no owner) → engine READY + audit
         'dispatch.returned_to_pool' (rolled back if the engine refuses) →
         claim ledger cleared → ownership record 'returned_to_pool' → return
         record → old driver notified → 'logistics.delivery.returned_to_pool'. */
  function returnToPool(orderId, opts, st, ctx){
    if (!onlyKeys(opts, ['kind', 'reason', 'expectedDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var eng = E(), sn = SNAP();
    if (!eng || !sn || typeof eng.driverUnassigned !== 'function') return fail('TRANSFER_FAILED');
    var pre = ownedPreconditions(orderId, opts, st, ctx); if (!pre.ok) return pre;
    var o = pre.o, f = pre.f;
    var lk = lockCheck(orderId, st); if (!lk.ok) return lk;
    var reason = trimReason(opts.reason);
    if (!reason) return fail('REASON_REQUIRED');
    var afterMin = global.RAFConfig ? RAFConfig.value('pool.priorityAfterMinutes') : null;
    if (typeof afterMin !== 'number') return fail('POOL_RULE_NOT_CONFIGURED');

    var pre2 = ownedPreconditions(orderId, opts, st, ctx); if (!pre2.ok) return pre2;
    var fresh = pre2.f;
    if (fresh.driverId !== f.driverId || !!fresh.pickedUpAt !== !!f.pickedUpAt) return fail('OWNERSHIP_CHANGED');
    if (eng.mstate(orderId) !== eng.MSTATE.WAITING_DRIVER) return fail('OWNERSHIP_CHANGED', { detail:'engine_state' });
    var lk2 = lockCheck(orderId, st); if (!lk2.ok) return lk2;
    var st2 = staffScope(true); if (!st2.ok || st2.id !== st.id) return fail('STAFF_FORBIDDEN');

    var now = Date.now();
    var held = fresh.assignedAt ? now - fresh.assignedAt : null;
    var pool = held != null && held > afterMin * 60000 ? 'priority' : 'regular';
    var staffActor = { id:st.id, name:st.name, roleId:st.roleId };
    var ownId = RAFRecordStore.makeId('own'), rtpId = RAFRecordStore.makeId('rtp');

    var up = sn.update(orderId, 'fulfilment', { driverId:null, assignedAt:null, pickedUpAt:fresh.pickedUpAt || null, deliveredAt:null },
                       'dispatch_return_to_pool', staffActor);
    if (!up.ok) return fail('TRANSFER_FAILED', { detail:up.reason });
    var meta = { fromDriverId:fresh.driverId, pickedUp:!!fresh.pickedUpAt, heldMs:held, pool:pool,
                 priorityAfterMinutes:afterMin, lockId:lk2.lock.lockId, returnId:rtpId, ownershipRecordId:ownId,
                 requestId:(ctx && ctx.requestId) || null };
    var moved = eng.driverUnassigned(orderId, staffActor, { via:'return_to_pool', reason:reason, metadata:meta });
    if (!moved || !moved.ok) {
      sn.update(orderId, 'fulfilment', fresh, 'dispatch_rollback', staffActor);
      return fail('TRANSFER_FAILED', { detail:moved && moved.reason });
    }
    var led = claimsAll(); delete led[orderId]; writeClaims(led);

    recordOwnership({ recordId:ownId, orderId:orderId, kind:'returned_to_pool', fromDriverId:fresh.driverId, toDriverId:null, at:now,
      actor:{ type:'staff', id:st.id, name:st.name, roleId:st.roleId }, reason:reason,
      storeSlug:o.snapshot.storeSlug, pickedUpAt:fresh.pickedUpAt || null, previousOwnerSince:fresh.assignedAt || null,
      heldMs:held, pool:pool, priorityAfterMinutes:afterMin, lockId:lk2.lock.lockId, requestId:(ctx && ctx.requestId) || null });
    var rec = RAFRecordStore.collection('pool_returns').append('returnId', {
      returnId:rtpId, orderId:orderId, storeSlug:o.snapshot.storeSlug, previousDriverId:fresh.driverId,
      actorUserId:st.id, actorName:st.name || null, at:now, reason:reason,
      pickedUp:!!fresh.pickedUpAt, pickedUpAt:fresh.pickedUpAt || null, previousOwnerSince:fresh.assignedAt || null,
      heldMs:held, pool:pool, priorityAfterMinutes:afterMin, requestId:(ctx && ctx.requestId) || null,
      ownershipRecordId:ownId, auditEventId:moved.auditEventId || null, source:'admin', version:1 });

    notifyUser(fresh.driverId, ctx && ctx.requestId ? 'driver.reassignment_request.approved' : 'driver.delivery.removed',
               orderId, rtpId, 'raf_driver.html', { via:'return_to_pool' });
    if (global.RAFEventBus) RAFEventBus.publish('logistics.delivery.returned_to_pool', { entityId:orderId, source:'admin',
      storeSlug:o.snapshot.storeSlug, payload:{ returnId:rtpId, pool:pool } });
    return { ok:true, kind:'return_to_pool', orderId:orderId, fromDriverId:fresh.driverId, at:now, pool:pool,
             heldMs:held, pickedUp:!!fresh.pickedUpAt, returnId:rtpId, record:rec && rec.record ? rec.record : null };
  }

  /* ══════════════════ DRIVER REASSIGNMENT REQUESTS (Phase D) ══════════════════
     A driver asks Logistics to take back a delivery they own. It is a REQUEST,
     never a reassignment. Stored as append-only lifecycle entries in
     RAFRecordStore 'reassignment_requests' ({ entryId, requestId, type:
     submitted | cancelled | approved | rejected, … }); the current state is
     derived, never edited. A request is PENDING while its latest entry is
     'submitted', the delivery is open, and the requester still owns it.
     While pending, the driver's pickup and delivery actions are refused
     (REQUEST_PENDING) and Logistics cannot reassign or return the delivery
     except by deciding the request. */
  function requestEntries(orderId){
    if (!global.RAFRecordStore) return [];
    return RAFRecordStore.collection('reassignment_requests').filter(function (r) { return r.orderId === orderId; })
      .sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); });
  }
  function pendingRequestOf(orderId){
    var o = orderById(orderId); if (!o || !o.snapshot) return null;
    var f = fulfilmentOf(o.snapshot);
    if (!f.driverId || !ownedOpen(o)) return null;
    var byReq = {}, order = [];
    requestEntries(orderId).forEach(function (e) {
      if (!byReq[e.requestId]) { byReq[e.requestId] = []; order.push(e.requestId); }
      byReq[e.requestId].push(e);
    });
    for (var i = order.length - 1; i >= 0; i--) {
      var list = byReq[order[i]], first = list[0], last = list[list.length - 1];
      if (first.type === 'submitted' && last.type === 'submitted' && first.driverId === f.driverId)
        return { requestId:first.requestId, orderId:orderId, driverId:first.driverId, reason:first.reason, at:first.at };
    }
    return null;
  }
  var REQUEST_ERRORS = {
    REQUEST_ALREADY_PENDING:{ ar:'لديك طلب إعادة إسناد معلّق لهذا التوصيل.', en:'You already have a pending reassignment request for this delivery.' },
    REQUEST_PROCESSED:      { ar:'تمت معالجة الطلب',                         en:'The request has been processed' }
  };
  Object.keys(REQUEST_ERRORS).forEach(function (k) { ERRORS[k] = REQUEST_ERRORS[k]; });
  function appendRequestEntry(e){
    return RAFRecordStore.collection('reassignment_requests').append('entryId',
      Object.assign({ entryId:RAFRecordStore.makeId('rrq'), version:1 }, e));
  }

  /* the signed-in driver asks for reassignment of a delivery they own */
  function requestReassignment(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['reason', 'actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!global.RAFRecordStore) return fail('TRANSFER_FAILED');
    var o = orderById(orderId);
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    if (o.status === 'delivered' || o.status === 'cancelled') return fail('DELIVERY_CLOSED');
    var f = fulfilmentOf(o.snapshot);
    if (f.deliveredAt) return fail('DELIVERY_CLOSED');
    if (f.driverId !== sc.id || !ownedOpen(o)) return fail('NOT_ASSIGNED');
    var reason = trimReason(opts.reason);
    if (!reason) return fail('REASON_REQUIRED');
    if (pendingRequestOf(orderId)) return fail('REQUEST_ALREADY_PENDING');
    var now = Date.now(), reqId = RAFRecordStore.makeId('rrq');
    var auditId = audited({ action:'reassignment.requested', orderId:orderId, actor:{ id:sc.id }, source:'driver',
      key:reqId, reason:reason, metadata:{ requestId:reqId, pickedUp:!!f.pickedUpAt } });
    var r = appendRequestEntry({ requestId:reqId, orderId:orderId, storeSlug:o.snapshot.storeSlug || null, type:'submitted',
      driverId:sc.id, actor:{ type:'driver', id:sc.id, name:sc.name }, at:now, reason:reason,
      pickedUp:!!f.pickedUpAt, auditEventId:auditId });
    if (!r.ok) return fail('TRANSFER_FAILED', { detail:r.reason });
    staffRecipients().forEach(function (uid) {
      notifyUser(uid, 'logistics.reassignment_request.submitted', orderId, reqId,
                 'raf_delivery_management.html#/dispatch/assignment', { requestId:reqId });
    });
    if (global.RAFEventBus) RAFEventBus.publish('driver.delivery.reassignment_requested', { entityId:orderId, source:'driver',
      storeSlug:o.snapshot.storeSlug || null, payload:{ requestId:reqId } });
    return { ok:true, requestId:reqId, request:r.record };
  }

  /* the requesting driver withdraws their own pending request */
  function cancelReassignmentRequest(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var o = orderById(orderId);
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var pend = pendingRequestOf(orderId);
    if (!pend || pend.driverId !== sc.id) return fail('NO_PENDING_REQUEST');
    var now = Date.now();
    var auditId = audited({ action:'reassignment.cancelled', orderId:orderId, actor:{ id:sc.id }, source:'driver',
      key:pend.requestId + ':cancelled', metadata:{ requestId:pend.requestId } });
    var r = appendRequestEntry({ requestId:pend.requestId, orderId:orderId, storeSlug:o.snapshot.storeSlug || null,
      type:'cancelled', driverId:sc.id, actor:{ type:'driver', id:sc.id, name:sc.name }, at:now, auditEventId:auditId });
    if (!r.ok) return fail('TRANSFER_FAILED', { detail:r.reason });
    staffRecipients().forEach(function (uid) {
      notifyUser(uid, 'logistics.reassignment_request.cancelled', orderId, pend.requestId,
                 'raf_delivery_management.html#/dispatch/assignment', { requestId:pend.requestId });
    });
    if (global.RAFEventBus) RAFEventBus.publish('driver.delivery.reassignment_request_cancelled', { entityId:orderId, source:'driver',
      storeSlug:o.snapshot.storeSlug || null, payload:{ requestId:pend.requestId } });
    /* the approved driver-safe wording for the outcome */
    var m = REQUEST_ERRORS.REQUEST_PROCESSED;
    return { ok:true, requestId:pend.requestId, message:T(m.ar, m.en) };
  }

  /* Logistics decides a pending request (staff, lock required):
       'approve_reassign' → reassignment to the chosen active driver;
       'approve_return'   → return to pool (reason required);
       'reject'           → the driver keeps the delivery and continues.
     The transfer runs first; the decision entry is appended only if it
     succeeded, so a refused transfer leaves the request pending. */
  function decideReassignmentRequest(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['requestId', 'decision', 'toDriverId', 'reason', 'expectedDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var st = staffScope(true); if (!st.ok) return st;
    var o = orderById(orderId);
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    if (o.status === 'delivered' || o.status === 'cancelled') return fail('DELIVERY_CLOSED');
    var pend = pendingRequestOf(orderId);
    if (!pend) return fail('NO_PENDING_REQUEST');
    if (opts.requestId !== pend.requestId) return fail('REQUEST_CHANGED');
    var ctx = { requestId:pend.requestId }, base = { expectedDriverId:opts.expectedDriverId };
    if (base.expectedDriverId === undefined) delete base.expectedDriverId;
    var result, decision;
    if (opts.decision === 'approve_reassign') {
      result = reassignment(orderId, Object.assign({ kind:'reassignment', toDriverId:opts.toDriverId, reason:opts.reason }, base), st, ctx);
      decision = { type:'approved', action:'reassigned', toDriverId:opts.toDriverId };
    } else if (opts.decision === 'approve_return') {
      result = returnToPool(orderId, Object.assign({ kind:'return_to_pool', reason:opts.reason }, base), st, ctx);
      decision = { type:'approved', action:'returned_to_pool' };
    } else if (opts.decision === 'reject') {
      var pre = ownedPreconditions(orderId, base, st, ctx); if (!pre.ok) return pre;
      var lk = lockCheck(orderId, st); if (!lk.ok) return lk;
      if (!pendingRequestOf(orderId) || pendingRequestOf(orderId).requestId !== pend.requestId) return fail('REQUEST_CHANGED');
      result = { ok:true, kind:'reject' };
      decision = { type:'rejected', action:'continue' };
    } else return fail('DECISION_INVALID');
    if (!result.ok) return result;

    var now = Date.now(), note = trimReason(opts.reason);
    var auditId = audited({ action:'reassignment.decided', orderId:orderId, actor:{ id:st.id }, source:'admin',
      key:pend.requestId + ':' + decision.type, reason:note || null,
      metadata:{ requestId:pend.requestId, decision:decision.type, action:decision.action,
                 driverId:pend.driverId, toDriverId:decision.toDriverId || null,
                 reassignmentId:result.reassignmentId || null, returnId:result.returnId || null } });
    appendRequestEntry({ requestId:pend.requestId, orderId:orderId, storeSlug:o.snapshot.storeSlug || null, type:decision.type,
      driverId:pend.driverId, actor:{ type:'staff', id:st.id, name:st.name }, at:now, reason:note || null,
      decision:{ action:decision.action, toDriverId:decision.toDriverId || null,
                 reassignmentId:result.reassignmentId || null, returnId:result.returnId || null },
      auditEventId:auditId });
    /* approval notifications were sent by the transfer itself; a rejection
       tells the driver to continue */
    if (decision.type === 'rejected')
      notifyUser(pend.driverId, 'driver.reassignment_request.rejected', orderId, pend.requestId, 'raf_driver.html', { requestId:pend.requestId });
    if (global.RAFEventBus) RAFEventBus.publish('logistics.delivery.reassignment_request_decided', { entityId:orderId, source:'admin',
      storeSlug:o.snapshot.storeSlug || null, payload:{ requestId:pend.requestId, decision:decision.type, action:decision.action } });
    return Object.assign({}, result, { ok:true, decision:decision.type, action:decision.action, requestId:pend.requestId });
  }

  /* pending requests across all live deliveries (staff) */
  function pendingRequests(){
    var st = staffScope(false); if (!st.ok) return st;
    var seen = {}, out = [];
    if (global.RAFRecordStore) RAFRecordStore.collection('reassignment_requests').all().forEach(function (e) {
      if (seen[e.orderId]) return; seen[e.orderId] = 1;
      var p = pendingRequestOf(e.orderId);
      if (p) out.push(Object.assign({ driverName:userName(p.driverId) }, p));
    });
    return { ok:true, requests:out.sort(function (a, b) { return a.at - b.at; }) };
  }

  /* the complete operational history of one delivery, for Logistics staff —
     names resolved for display; every record stays as it was appended */
  function operationsHistory(orderId){
    var st = staffScope(false); if (!st.ok) return st;
    var o = orderById(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    function withNames(r){
      var x = Object.assign({}, r);
      ['fromDriverId', 'toDriverId', 'previousDriverId', 'newDriverId', 'driverId'].forEach(function (k) {
        if (x[k]) x[k.replace(/Id$/, 'Name')] = userName(x[k]); });
      return x;
    }
    var coll = function (n) { return global.RAFRecordStore ? RAFRecordStore.collection(n).filter(function (r) { return r.orderId === orderId; }) : []; };
    return { ok:true, orderId:orderId,
      ownership:ownershipRecords(orderId).map(withNames),
      reassignments:coll('reassignments').map(withNames),
      returns:coll('pool_returns').map(withNames),
      requests:requestEntries(orderId).map(withNames),
      pendingRequest:pendingRequestOf(orderId) };
  }

  /* the ownership history of one delivery, for Logistics staff */
  function ownershipHistory(orderId){
    var st = staffScope(false); if (!st.ok) return st;
    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var recs = ownershipRecords(orderId);
    var f = fulfilmentOf(o.snapshot);
    var last = recs.length ? recs[recs.length - 1] : null;
    return { ok:true, orderId:orderId, currentDriverId:f.driverId || null, records:recs,
             /* an owner with no recorded origin predates this history */
             unrecordedOrigin:!!(f.driverId && (!last || last.toDriverId !== f.driverId)) };
  }

  /* the canonical operational timestamps of one delivery, for Logistics staff.
     Each comes from its own authority; nothing is estimated and no ETA is
     computed here. */
  function milestones(orderId){
    var st = staffScope(false); if (!st.ok) return st;
    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var eng = E(), f = fulfilmentOf(o.snapshot), recs = ownershipRecords(orderId);
    var firstClaim = recs.filter(function (r) { return r.kind === 'claim'; })[0] || null;
    return { ok:true, orderId:orderId,
      acceptedAt:   eng && eng.acceptedAt ? eng.acceptedAt(orderId) : null,   /* RAFAudit order.accept */
      readyAt:      eng && eng.readyAt ? eng.readyAt(orderId) : null,         /* RAFAudit order.ready  */
      firstClaimedAt: firstClaim ? { at:firstClaim.at, source:'RAFRecordStore:ownership' } : null,
      currentOwnerSince: f.assignedAt ? { at:f.assignedAt, source:'RAFOrderSnapshot:fulfilment.assignedAt' } : null,
      pickedUpAt:   f.pickedUpAt ? { at:f.pickedUpAt, source:'RAFOrderSnapshot:fulfilment.pickedUpAt' } : null,
      deliveredAt:  f.deliveredAt ? { at:f.deliveredAt, source:'RAFOrderSnapshot:fulfilment.deliveredAt' } : null };
  }

  /* ══════════════════ THE ONE REAL OPERATION ══════════════════
     Confirming a pickup. It changes nothing itself: the engine's own
     driverPickedUp performs the transition (including its Ready recovery and
     its audit records), and the snapshot records when it happened through the
     approved update path. Ownership is proved from the snapshot before any of
     that runs, so a forged id, another driver's order or an unassigned order
     is refused. */
  function confirmPickup(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var eng = E(), sn = SNAP();
    if (!eng || !sn) return fail('ENGINE_REFUSED');

    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var f = fulfilmentOf(o.snapshot);
    if (f.driverId !== sc.id)  return fail('NOT_ASSIGNED');
    /* a pending reassignment request pauses the driver's delivery actions */
    if (pendingRequestOf(orderId)) return fail('REQUEST_PENDING');
    if (f.pickedUpAt)          return fail('ALREADY_PICKED_UP');
    var st = stageOf(o);
    if (st !== STAGE.CLAIMED) return fail('NOT_READY');

    var done = eng.driverPickedUp(orderId, engineActor(sc));
    if (!done) return fail('ENGINE_REFUSED');

    var next = { driverId:f.driverId, assignedAt:f.assignedAt || null,
                 pickedUpAt:Date.now(), deliveredAt:f.deliveredAt || null };
    var up = sn.update(orderId, 'fulfilment', next, 'driver_pickup', engineActor(sc));
    if (!up.ok) return fail('ENGINE_REFUSED', { detail:up.reason });
    return task(orderId, { actor:sc.id });
  }

  /* ══════════════════ DELIVERY COMPLETION ══════════════════
     Driver confirmation, and nothing more: this phase has no OTP, signature,
     photo or customer confirmation, and none is simulated. Ownership is
     proved from the snapshot before the engine is asked to close the order,
     so another driver's delivery can never be completed from here. */
  function completeDelivery(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var eng = E(), sn = SNAP();
    if (!eng || !sn || typeof eng.driverDelivered !== 'function') return fail('ENGINE_REFUSED');

    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var f = fulfilmentOf(o.snapshot);
    if (f.driverId !== sc.id) return fail('NOT_ASSIGNED');
    if (pendingRequestOf(orderId)) return fail('REQUEST_PENDING');
    if (f.deliveredAt || o.status === 'delivered') return fail('ALREADY_DELIVERED');
    if (!f.pickedUpAt) return fail('NOT_PICKED_UP');

    var done = eng.driverDelivered(orderId, engineActor(sc));
    if (!done || !done.ok) return fail('ENGINE_REFUSED', { detail:done && done.reason });

    var next = { driverId:f.driverId, assignedAt:f.assignedAt || null,
                 pickedUpAt:f.pickedUpAt, deliveredAt:Date.now() };
    var up = sn.update(orderId, 'fulfilment', next, 'driver_delivered', engineActor(sc));
    if (!up.ok) return fail('ENGINE_REFUSED', { detail:up.reason });
    /* the claim ledger's job ended when the order did */
    var led = claimsAll(); delete led[orderId]; writeClaims(led);
    /* Phase E: an open delivery exception auto-closes ("Auto-Closed — Order
       Delivered") and a late delivery is checked for penalty risk — owned by
       RAFDeliveryOps.exceptions, which re-checks that the order is delivered */
    if (global.RAFDeliveryOps && RAFDeliveryOps.exceptions) { try { RAFDeliveryOps.exceptions.autoCloseOnDelivery(orderId); } catch (e) {} }
    /* Phase I: delay compensation is evaluated once, after Delivered — owned by
       RAFCompensation (OFF does nothing; a duplicate call issues nothing) */
    if (global.RAFCompensation) { try { RAFCompensation.processDelivered(orderId); } catch (e) {} }
    return task(orderId, { actor:sc.id });
  }

  /* ══════════════════ WHO IS CARRYING THIS ORDER ══════════════════
     The PUBLIC projection, read by the merchant's Orders page, the customer's
     tracking page and order details so each can see that a driver has taken
     the order. It answers with the driver's NAME and the timestamps only —
     never the account id, never a permission and NEVER THE DRIVER'S PHONE:
     a customer must not receive the driver's number, and this projection
     needs no session, so it carries nothing a customer may not see. Staff
     surfaces that are entitled to contact details read them through their own
     authorised authority (RAFDeliveryOps proves its session first). */
  function assignmentOf(orderId){
    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return { claimed:false };
    var f = fulfilmentOf(o.snapshot);
    if (!f.driverId) return { claimed:false };
    var name = null;
    try {
      var u = global.RAFPerm && RAFPerm.getUser(f.driverId);
      name  = (u && u.name)  || null;
    } catch (e) {}
    return { claimed:true, driverName:name, assignedAt:f.assignedAt || null,
             pickedUpAt:f.pickedUpAt || null, deliveredAt:f.deliveredAt || null,
             stage:stageOf(o) };
  }

  /* ══════════════════ WHAT THIS PROTOTYPE CAN AND CANNOT DO ══════════════════
     The workspace renders straight from this, so an unavailable capability is
     always shown as unavailable with its reason instead of being faked. */
  function capabilities(){
    return {
      queueVisible:      { available:true,  via:'RAFOrderEngine.queueOf + RAFOrderSnapshot' },
      claimDelivery:     { available:true,  via:'RAFDriver.claim — first come, first served' },
      confirmPickup:     { available:true,  via:'RAFOrderEngine.driverPickedUp' },
      reassignmentRequest:{ available:true, via:'RAFDriver.requestReassignment — decided by Logistics' },
      /* leaving the store with the order IS the start of the delivery, so the
         stage is derived from the pickup rather than stored a second time */
      startDelivery:     { available:true,  via:'derived from fulfilment.pickedUpAt' },
      completeDelivery:  { available:true,  via:'RAFOrderEngine.driverDelivered' },
      deliveryException: { available:true, via:'RAFDeliveryOps.exceptions — report a problem on your delivery' },
      proofOfDelivery:   { available:false, reason:'no_proof_model',
                           ar:'لا يوجد نموذج إثبات تسليم (صورة أو توقيع أو رمز).',
                           en:'No proof-of-delivery model exists (photo, signature or code).' },
      /* Phase F: the driver may set themselves Unavailable (reason required);
         becoming Available again is a management decision */
      availabilityToggle:{ available:true, via:'RAFDriverManagement.availability.setSelfUnavailable' },
      navigation:        { available:false, reason:'no_coordinates',
                           ar:'لا توجد إحداثيات أو خرائط في بيانات رف.',
                           en:'RAF holds no coordinates or map integration.' },
      /* a pool delivery can be skipped without claiming it (RAFDriver.skip) */
      skipDelivery:      { available:true,  via:'RAFDriver.skip — permanent record, no ownership' },
      /* the driver's own notifications (today: a Logistics assignment) */
      notifications:     { available:true,  via:'RAFNotify.forRecipient({ audience:"driver" })' },
      /* Phase G: own performance, read-only (earnings and distance are still not recorded) */
      metrics:           { available:true,  via:'RAFDriverPerformance.mine + RAFDriverRating.mine (total only)' }
    };
  }

  global.RAFDriver = {
    STAGE:STAGE, STAGE_TEXT:STAGE_TEXT, ERRORS:ERRORS,
    isDriver:isDriver, scope:scope, profile:profile, capabilities:capabilities,
    queue:queue, mine:mine, active:active, history:history, task:task, assignmentOf:assignmentOf,
    /* the derived delivery stage of one order, read-only. Exposed so another
       surface (Logistics Management) can read the same stage this module
       shows a driver instead of deriving it a second time. */
    stageOfOrder:function(order){
      var o = (typeof order === 'string')
        ? allOrders().filter(function (x) { return x.id === order; })[0]
        : order;
      return o ? stageOf(o) : null;
    },
    claim:claim, skip:skip, confirmPickup:confirmPickup, completeDelivery:completeDelivery,
    /* Logistics staff only: manual dispatch and the projections it reads */
    transferOwnership:transferOwnership, eligibleDrivers:eligibleDrivers, dispatchPool:dispatchPool,
    ownershipHistory:ownershipHistory, milestones:milestones, ownershipKindOf:ownershipKindOf,
    /* Phase D — driver requests (the signed-in owner) and staff decisions / reads */
    requestReassignment:requestReassignment, cancelReassignmentRequest:cancelReassignmentRequest,
    decideReassignmentRequest:decideReassignmentRequest, pendingRequests:pendingRequests,
    operationsHistory:operationsHistory,
    label:L
  };
})(window);
