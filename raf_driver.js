/* ==========================================================================
 * RAF — DRIVER DELIVERY AUTHORITY  (RAFDriver)
 * --------------------------------------------------------------------------
 * The delivery-side reading and acting layer for the Driver workspace. It is
 * NOT a second order engine: every order state it reports comes from
 * RAFOrderEngine, every order fact it shows comes from RAFOrderSnapshot, and
 * the single mutation it performs is the engine's own driver operation.
 *
 * WHAT EXISTS TODAY (verified in the code, not assumed):
 *   · RAFOrderEngine.driverAssigned(orderId, actor)  Ready → Waiting for driver
 *   · RAFOrderEngine.driverPickedUp(orderId, actor)  pickup + Ready recovery
 *   · RAFOrderSnapshot.fulfilment { driverId, assignedAt, pickedUpAt, deliveredAt }
 *     — a reserved, approved-to-update section
 *   · RAFAudit driver actions: assigned, ready_ack, pickup, pickup_recovery,
 *     delivery_start, delivered
 *
 * THE APPROVED ASSIGNMENT MODEL (phase 2): a RAF-wide DRIVER POOL with
 * FIRST-COME-FIRST-SERVED claiming. There is no dispatcher and no automatic
 * dispatch: every eligible driver sees the same pool and the first successful
 * claim owns the order. See claim() for exactly how far a browser-storage
 * prototype can take that, and where a server becomes mandatory.
 *
 * WHAT DOES NOT EXIST, AND IS THEREFORE NOT INVENTED HERE:
 *   · driver availability (online/offline), driver notifications, driver
 *     metrics, proof of delivery, delivery-failure reasons, coordinates or
 *     navigation. None of them have a data model in RAF today.
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
    NOT_RETURNABLE:     { ar:'لا يمكن إعادة هذا الطلب إلى القائمة.',          en:'This delivery cannot be returned to the pool.' },
    ENGINE_REFUSED:     { ar:'تعذّر تسجيل الاستلام.',                         en:'The pickup could not be recorded.' },
    UNAVAILABLE:        { ar:'هذه العملية غير مُهيّأة بعد وتحتاج اعتماد قاعدة عمل.',
                          en:'That operation is not configured yet and needs a business rule to be approved.' }
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
    if (f.pickedUpAt) return STAGE.OUT;
    var q = eng.queueOf(order);
    if (q === 'driver') return f.driverId ? STAGE.CLAIMED : STAGE.OUT;
    if (q === 'ready')  return f.driverId ? STAGE.CLAIMED : STAGE.AWAITING;
    return null;                                  /* still the merchant's */
  }
  var STAGE_TEXT = {
    awaiting_driver: { ar:'بانتظار سائق',          en:'Waiting for a driver' },
    claimed:         { ar:'سحبته — للاستلام',      en:'Taken by you — collect' },
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
    return { ok:true, driverId:sc.id, claimable:true, tasks:list.map(taskView) };
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
    return { ok:true, driverId:r.driverId, tasks:r.closed,
             /* RAF records no driver earnings, distance, rating or acceptance
                rate anywhere, so none are reported */
             metricsAvailable:false };
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
     The approved model: no dispatcher and no automatic assignment. Every
     eligible driver sees the same pool and the first one to claim an order
     owns it.
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

    /* 2 · write the intent */
    var mine = { driverId:sc.id, token:token(), at:Date.now() };
    var ledger = claimsAll();
    var standing = ledger[orderId];
    if (standing && standing.driverId && standing.driverId !== sc.id) return fail('ALREADY_CLAIMED');
    ledger[orderId] = mine;
    if (!writeClaims(ledger)) return fail('CLAIM_FAILED');

    /* 3 · re-read and resolve — both racers reach the same verdict */
    var after = claimsAll()[orderId];
    var winner = earlier(after, mine);
    if (!winner || winner.driverId !== sc.id || winner.token !== mine.token){
      var back = claimsAll(); back[orderId] = winner; writeClaims(back);   /* keep the winner's intent */
      return fail('ALREADY_CLAIMED');
    }
    /* somebody may have committed ownership while we arbitrated */
    var fresh = fulfilmentOf(sn.of(orderId));
    if (fresh.driverId && fresh.driverId !== sc.id) return fail('ALREADY_CLAIMED');

    /* 4 · commit: the snapshot is the record of ownership, the engine owns
           the state. Both go through their own authority. */
    var next = { driverId:sc.id, assignedAt:mine.at, pickedUpAt:null, deliveredAt:null };
    var up = sn.update(orderId, 'fulfilment', next, 'driver_claim', engineActor(sc));
    if (!up.ok){
      var undo = claimsAll(); delete undo[orderId]; writeClaims(undo);
      return fail('CLAIM_FAILED', { detail:up.reason });
    }
    /* the engine records the assignment and its audit event (driver.assigned) */
    eng.driverAssigned(orderId, engineActor(sc));
    return task(orderId, { actor:sc.id });
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

  /* ══════════════════ HANDING A DELIVERY BACK ══════════════════
     A driver who has taken an order but has NOT collected it may put it back
     in the pool. It is a delivery-ownership change and nothing else:

       · the customer's order is NOT cancelled;
       · no price, coupon, promotion, refund or inventory is touched;
       · no new order is created and no order fact is rewritten;
       · after it, the order is claimable by anyone again — including the
         driver who returned it.

     After pickup it is refused: the goods have left the store, and handing
     the ORDER back would not hand the goods back. That needs a delivery
     exception workflow, which is not approved.

     Ordering matters for the race with another driver's claim. The engine
     goes back to Ready first and the snapshot's owner is cleared second, so
     at no instant is the order both ownerless and invisible: while the
     snapshot still names the driver the stage stays `claimed`, and only the
     final write puts it back in the pool. */
  function returnDelivery(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var eng = E(), sn = SNAP();
    if (!eng || !sn || typeof eng.driverUnassigned !== 'function') return fail('ENGINE_REFUSED');

    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var f = fulfilmentOf(o.snapshot);
    if (f.driverId !== sc.id) return fail('NOT_ASSIGNED');
    if (f.pickedUpAt)        return fail('ALREADY_PICKED_UP');
    if (f.deliveredAt || o.status === 'delivered') return fail('ALREADY_DELIVERED');
    if (o.status === 'cancelled') return fail('NOT_RETURNABLE');
    if (stageOf(o) !== STAGE.CLAIMED) return fail('NOT_RETURNABLE');

    var back = eng.driverUnassigned(orderId, engineActor(sc));
    if (!back || !back.ok) return fail('ENGINE_REFUSED', { detail:back && back.reason });

    var cleared = { driverId:null, assignedAt:null, pickedUpAt:null, deliveredAt:null };
    var up = sn.update(orderId, 'fulfilment', cleared, 'driver_return', engineActor(sc));
    if (!up.ok){
      /* the engine moved but the record did not: put the engine back rather
         than leave the two disagreeing */
      eng.driverAssigned(orderId, engineActor(sc));
      return fail('ENGINE_REFUSED', { detail:up.reason });
    }
    /* the arbitration ledger entry belongs to a claim that no longer exists */
    var led = claimsAll();
    if (led[orderId] && led[orderId].driverId === sc.id){ delete led[orderId]; writeClaims(led); }
    return { ok:true, orderId:orderId, returned:true, pooled:true };
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
    return task(orderId, { actor:sc.id });
  }

  /* ══════════════════ WHO IS CARRYING THIS ORDER ══════════════════
     Read by the merchant's Orders page and the customer's tracking page so
     both can see that a driver has taken the order. It answers with the
     driver's NAME, the contact number the account already holds and the
     timestamps — never the account id, never a permission, never anything
     else about the driver, and nothing invented: a field absent from the
     record comes back null. It needs no driver session, because it reveals
     nothing private about the delivery itself. */
  function assignmentOf(orderId){
    var o = allOrders().filter(function (x) { return x.id === orderId; })[0];
    if (!o || !o.snapshot) return { claimed:false };
    var f = fulfilmentOf(o.snapshot);
    if (!f.driverId) return { claimed:false };
    var name = null, phone = null;
    try {
      var u = global.RAFPerm && RAFPerm.getUser(f.driverId);
      name  = (u && u.name)  || null;
      phone = (u && u.phone) || null;
    } catch (e) {}
    return { claimed:true, driverName:name, driverPhone:phone, assignedAt:f.assignedAt || null,
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
      returnDelivery:    { available:true,  via:'RAFDriver.returnDelivery — before pickup only' },
      /* leaving the store with the order IS the start of the delivery, so the
         stage is derived from the pickup rather than stored a second time */
      startDelivery:     { available:true,  via:'derived from fulfilment.pickedUpAt' },
      completeDelivery:  { available:true,  via:'RAFOrderEngine.driverDelivered' },
      deliveryException: { available:false, reason:'no_failure_workflow',
                           ar:'مسار تعذّر التسليم يحتاج اعتماد قاعدة عمل.',
                           en:'Delivery exception workflow requires business-rule approval.' },
      proofOfDelivery:   { available:false, reason:'no_proof_model',
                           ar:'لا يوجد نموذج إثبات تسليم (صورة أو توقيع أو رمز).',
                           en:'No proof-of-delivery model exists (photo, signature or code).' },
      availabilityToggle:{ available:false, reason:'no_driver_availability_model',
                           ar:'لا توجد حالة اتصال للسائق في النظام.',
                           en:'RAF has no driver online/offline state.' },
      navigation:        { available:false, reason:'no_coordinates',
                           ar:'لا توجد إحداثيات أو خرائط في بيانات رف.',
                           en:'RAF holds no coordinates or map integration.' },
      notifications:     { available:false, reason:'no_driver_notification_source',
                           ar:'لا توجد إشعارات خاصة بالسائق في النظام.',
                           en:'No driver notification source exists.' },
      metrics:           { available:false, reason:'no_driver_metric_source',
                           ar:'لا توجد بيانات أرباح أو مسافات أو تقييم للسائق.',
                           en:'No driver earnings, distance or rating data exists.' }
    };
  }

  global.RAFDriver = {
    STAGE:STAGE, STAGE_TEXT:STAGE_TEXT, ERRORS:ERRORS,
    isDriver:isDriver, scope:scope, profile:profile, capabilities:capabilities,
    queue:queue, mine:mine, active:active, history:history, task:task, assignmentOf:assignmentOf,
    claim:claim, returnDelivery:returnDelivery, confirmPickup:confirmPickup, completeDelivery:completeDelivery,
    label:L
  };
})(window);
