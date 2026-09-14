/* ==========================================================================
 * RAF — LOGISTICS MANAGEMENT OPERATIONS AUTHORITY  (RAFDeliveryOps)
 * --------------------------------------------------------------------------
 * The operational authority behind Logistics Management (إدارة اللوجستيات).
 * The object keeps its established name, RAFDeliveryOps, so no caller breaks.
 * TODAY it is a read-only PROJECTION and an authorisation gate:
 *
 *   · it owns no delivery state. Every stage comes from RAFDriver, which
 *     derives it from RAFOrderEngine and the snapshot's fulfilment section;
 *   · MANUAL DISPATCH (Phase C): dispatchBoard() projects the classified,
 *     ordered pool, the active drivers and the locks; assign() orchestrates a
 *     first assignment — the ownership change itself happens only in
 *     RAFDriver.transferOwnership({ kind:'first_assignment' }), and assign()
 *     then releases the operation lock. Nothing here cancels, refunds or
 *     re-stocks a delivery, and there is no automatic dispatch;
 *   · REASSIGNMENT & RETURN TO POOL (Phase D): reassign(), returnToPool() and
 *     decideRequest() only call RAFDriver (kind made explicit) and release the
 *     lock afterwards; there is no automatic reassignment;
 *   · it duplicates no value. Order facts are read from RAFOrderSnapshot,
 *     driver names from RAFDriver.assignmentOf, and driver contact details —
 *     which the public projection deliberately omits — from RAFPerm, only
 *     after this module has proved the staff session.
 *
 * SCOPE. Deliveries are RAF-wide by design: the approved model is one driver
 * pool across every store, so this surface is never scoped to a merchant. A
 * store filter is a filter — it narrows what an authorised operator looks at
 * and never decides what they may see.
 *
 * ACCESS. Two EXISTING permissions together, no new key: `orders.view` (this
 * is order data) and `drivers.view` (this is driver activity). A merchant or
 * merchant employee holds the first and not the second, a driver holds only
 * the first, and finance holds the first without the second — so none of them
 * reaches RAF-wide delivery data through their own surfaces. The permissions
 * are proved on EVERY call, not once at page load, and an unauthenticated
 * caller is refused rather than inheriting RAFPerm's demo default.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDeliveryOps) return;

  var PERM = { orders:'orders.view', drivers:'drivers.view' };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function L(o){ return (o && typeof o === 'object') ? (isEn() ? (o.en || o.ar) : (o.ar || o.en)) : (o || ''); }

  var ERRORS = {
    FORBIDDEN:          { ar:'إدارة اللوجستيات متاحة لفريق عمليات رف فقط.', en:'Logistics Management is available to RAF operations staff only.' },
    ACTOR_INACTIVE:     { ar:'حسابك موقوف.',                              en:'Your account is suspended.' },
    OTHER_ACTOR:        { ar:'لا يمكن العمل نيابة عن مستخدم آخر.',        en:'Another user’s identity cannot be used.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',       en:'The request contains fields that are not accepted.' },
    NOT_FOUND:          { ar:'هذا الطلب غير موجود.',                      en:'That order does not exist.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){
    return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; });
  }

  /* ══════════════════ WHO IS ASKING ══════════════════ */
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
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  function scope(actor){
    if (!global.RAFPerm) return fail('FORBIDDEN');
    var me = sessionId(); if (!me) return fail('FORBIDDEN');
    var asked = actorId(actor);
    if (asked && asked !== me) return fail('OTHER_ACTOR');
    var u = null; try { u = RAFPerm.getUser(me); } catch (e) {}
    if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var ok = false;
    try { ok = !!RAFPerm.can(u.id, PERM.orders) && !!RAFPerm.can(u.id, PERM.drivers); } catch (e) { ok = false; }
    if (!ok) return fail('FORBIDDEN', { needs:[PERM.orders, PERM.drivers] });
    return { ok:true, id:u.id, name:u.name, roleId:u.roleId };
  }
  function canAccess(actor){ return scope(actor).ok; }

  /* ══════════════════ LOGISTICS OPERATION LOCKS ══════════════════
     One Logistics staff member works on a delivery at a time. A lock names the
     delivery, the owner (id + display name from their own account record), when
     it was acquired and when its owner last sent a heartbeat.

     TIMING IS CONFIGURATION, NOT CODE. Heartbeat and stale durations come from
     RAFConfig ('logistics.lock.heartbeatMs', 'logistics.lock.staleMs') on every
     call. Neither has an approved business value; RAFConfig currently serves
     TEMPORARY PROTOTYPE values (status 'prototype_temporary'). If both are ever
     unset, acquiring a lock is refused with LOCK_POLICY_NOT_CONFIGURED. No
     duration lives in this file, and the merchant order lock's timings are
     deliberately NOT reused.

     STALE RECOVERY is explicit and audited: a lock whose owner has been silent
     longer than the stale duration is reported `stale`, and another authorised
     staff member may take it over with recoverStaleLock(). Nothing sweeps locks
     on a timer. Management override of an ACTIVE lock is a future capability
     and does not exist here.

     STORAGE — RAFRecordStore state map 'logistics_locks' holds only the current
     lock per delivery (non-historical). Every acquire, release and recovery is
     appended to RAFAudit and published on RAFEventBus. Prototype localStorage:
     two tabs acquiring in the same instant can interleave; production needs a
     server-side conditional write. */
  var LOCK_ERRORS = {
    LOCK_POLICY_NOT_CONFIGURED: { ar:'مدة أقفال العمليات غير مُهيّأة بعد.', en:'Operation lock timing is not configured yet.' },
    LOCKED:        { ar:'جاري العمل عليها بواسطة ', en:'Being worked on by ' },
    LOCK_STALE:    { ar:'القفل الحالي متوقف ويمكن استعادته.', en:'The current lock is stale and can be recovered.' },
    NOT_LOCK_OWNER:{ ar:'أنت لا تملك هذا القفل.', en:'You do not hold this lock.' },
    NOT_STALE:     { ar:'القفل ما زال نشطاً.', en:'The lock is still active.' },
    NO_LOCK:       { ar:'لا يوجد قفل على هذا التوصيل.', en:'There is no lock on this delivery.' },
    LOCK_FAILED:   { ar:'تعذّر حفظ القفل.', en:'The lock could not be saved.' }
  };
  Object.keys(LOCK_ERRORS).forEach(function (k) { ERRORS[k] = LOCK_ERRORS[k]; });

  function lockPolicy(){
    var cfg = global.RAFConfig;
    var hb = cfg ? cfg.value('logistics.lock.heartbeatMs') : null;
    var stale = cfg ? cfg.value('logistics.lock.staleMs') : null;
    /* `temporary` — at least one timing is RAFConfig's TEMPORARY PROTOTYPE
       value rather than an approved or explicitly configured one */
    var temp = !!(cfg && ['logistics.lock.heartbeatMs', 'logistics.lock.staleMs'].some(function (k) {
      var g = cfg.get(k); return g && g.status === 'prototype_temporary'; }));
    return { configured:!!(hb && stale), heartbeatMs:hb, staleMs:stale, temporary:temp };
  }
  function lockStore(){ return global.RAFRecordStore ? RAFRecordStore.stateMap('logistics_locks') : null; }
  function orderExists(orderId){ return orders().some(function (o) { return o.id === orderId; }); }
  function lockView(l, pol){
    if (!l) return null;
    var stale = !!(pol.configured && (Date.now() - (l.heartbeatAt || l.acquiredAt || 0)) > pol.staleMs);
    return { lockId:l.lockId, entityType:l.entityType, entityId:l.entityId, ownerUserId:l.ownerUserId,
             ownerName:l.ownerName, acquiredAt:l.acquiredAt, heartbeatAt:l.heartbeatAt,
             state:stale ? 'stale' : 'active', stale:stale, recoveredFrom:l.recoveredFrom || null,
             label:{ ar:'جاري العمل عليها بواسطة ' + (l.ownerName || ''), en:'Being worked on by ' + (l.ownerName || '') } };
  }
  function lockAudit(action, orderId, sc, extra){
    if (!global.RAFAudit) return;
    try { RAFAudit.record(Object.assign({ action:action, orderId:orderId, actor:{ id:sc.id }, source:'admin',
            key:Date.now() + ':' + sc.id }, extra || {})); } catch (e) {}
  }
  function lockEvent(type, orderId, lock){
    if (global.RAFEventBus) RAFEventBus.publish(type, { entityId:orderId, source:'admin',
      payload:{ lockId:lock && lock.lockId, ownerUserId:lock && lock.ownerUserId, ownerName:lock && lock.ownerName } });
  }

  function lockOf(orderId){
    var sc = scope(); if (!sc.ok) return sc;
    var s = lockStore(); if (!s) return fail('LOCK_FAILED');
    var pol = lockPolicy();
    var v = lockView(s.get('delivery:' + orderId), pol);
    return { ok:true, policyConfigured:pol.configured, lock:v, heldByMe:!!(v && v.ownerUserId === sc.id && !v.stale),
             readOnly:!!(v && v.ownerUserId !== sc.id && !v.stale) };
  }
  function acquireLock(orderId){
    var sc = scope(); if (!sc.ok) return sc;
    var pol = lockPolicy(); if (!pol.configured) return fail('LOCK_POLICY_NOT_CONFIGURED');
    if (!orderExists(orderId)) return fail('NOT_FOUND');
    var s = lockStore(); if (!s) return fail('LOCK_FAILED');
    var key = 'delivery:' + orderId, now = Date.now();
    var cur = lockView(s.get(key), pol);
    if (cur && cur.ownerUserId === sc.id && !cur.stale) {
      var mine = s.get(key); mine.heartbeatAt = now;
      if (!s.set(key, mine)) return fail('LOCK_FAILED');
      return { ok:true, reacquired:true, lock:lockView(mine, pol) };
    }
    if (cur && !cur.stale) {
      var m = fail('LOCKED', { readOnly:true, lock:cur });
      m.message = T('جاري العمل عليها بواسطة ', 'Being worked on by ') + (cur.ownerName || '');
      return m;
    }
    if (cur && cur.stale) return fail('LOCK_STALE', { recoverable:true, lock:cur });
    var u = RAFPerm.getUser(sc.id);
    var rec = { lockId:'lck-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
                entityType:'delivery', entityId:orderId, ownerUserId:sc.id, ownerName:(u && u.name) || null,
                acquiredAt:now, heartbeatAt:now, recoveredFrom:null };
    if (!s.set(key, rec)) return fail('LOCK_FAILED');
    /* re-read: if another tab wrote in the same instant, the stored owner wins */
    var after = s.get(key);
    if (!after || after.lockId !== rec.lockId) {
      var lv = lockView(after, pol);
      var r2 = fail('LOCKED', { readOnly:true, lock:lv });
      r2.message = T('جاري العمل عليها بواسطة ', 'Being worked on by ') + ((lv && lv.ownerName) || '');
      return r2;
    }
    lockAudit('logistics.lock.acquired', orderId, sc, { metadata:{ lockId:rec.lockId } });
    lockEvent('logistics.lock.acquired', orderId, rec);
    return { ok:true, lock:lockView(rec, pol) };
  }
  function heartbeatLock(orderId){
    var sc = scope(); if (!sc.ok) return sc;
    var pol = lockPolicy(); if (!pol.configured) return fail('LOCK_POLICY_NOT_CONFIGURED');
    var s = lockStore(); if (!s) return fail('LOCK_FAILED');
    var key = 'delivery:' + orderId, l = s.get(key);
    if (!l) return fail('NO_LOCK');
    if (l.ownerUserId !== sc.id) return fail('NOT_LOCK_OWNER');
    var v = lockView(l, pol);
    if (v.stale) return fail('LOCK_STALE', { recoverable:false, lock:v });   /* a stale lock must be re-acquired or recovered */
    l.heartbeatAt = Date.now();
    if (!s.set(key, l)) return fail('LOCK_FAILED');
    return { ok:true, lock:lockView(l, pol) };                                  /* heartbeats are not audited or published */
  }
  function releaseLock(orderId){
    var sc = scope(); if (!sc.ok) return sc;
    var s = lockStore(); if (!s) return fail('LOCK_FAILED');
    var key = 'delivery:' + orderId, l = s.get(key);
    if (!l) return fail('NO_LOCK');
    if (l.ownerUserId !== sc.id) return fail('NOT_LOCK_OWNER');
    if (!s.remove(key)) return fail('LOCK_FAILED');
    lockAudit('logistics.lock.released', orderId, sc, { metadata:{ lockId:l.lockId } });
    lockEvent('logistics.lock.released', orderId, l);
    return { ok:true, released:true };
  }
  function recoverStaleLock(orderId){
    var sc = scope(); if (!sc.ok) return sc;
    var pol = lockPolicy(); if (!pol.configured) return fail('LOCK_POLICY_NOT_CONFIGURED');
    var s = lockStore(); if (!s) return fail('LOCK_FAILED');
    var key = 'delivery:' + orderId, l = s.get(key);
    if (!l) return fail('NO_LOCK');
    var v = lockView(l, pol);
    if (!v.stale) return fail('NOT_STALE', { lock:v });
    var now = Date.now(), u = RAFPerm.getUser(sc.id);
    var rec = { lockId:'lck-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 8),
                entityType:'delivery', entityId:orderId, ownerUserId:sc.id, ownerName:(u && u.name) || null,
                acquiredAt:now, heartbeatAt:now,
                recoveredFrom:{ lockId:l.lockId, ownerUserId:l.ownerUserId, ownerName:l.ownerName, lastHeartbeatAt:l.heartbeatAt } };
    if (!s.set(key, rec)) return fail('LOCK_FAILED');
    lockAudit('logistics.lock.recovered', orderId, sc, { previousState:l.ownerUserId, newState:sc.id,
      reason:'stale_lock_recovery', metadata:{ lockId:rec.lockId, recoveredLockId:l.lockId, lastHeartbeatAt:l.heartbeatAt } });
    lockEvent('logistics.lock.recovered', orderId, rec);
    return { ok:true, recovered:true, lock:lockView(rec, pol) };
  }

  /* ══════════════════ READING THE DELIVERIES ══════════════════ */
  function orders(){
    if (!global.RAFShop) return [];
    try { return RAFShop.Orders.all() || []; } catch (e) { return []; }
  }
  function stageOf(o){
    try { return (global.RAFDriver && RAFDriver.stageOfOrder) ? RAFDriver.stageOfOrder(o) : null; }
    catch (e) { return null; }
  }
  function assignmentOf(id){
    try { return (global.RAFDriver && RAFDriver.assignmentOf) ? RAFDriver.assignmentOf(id) : { claimed:false }; }
    catch (e) { return { claimed:false }; }
  }
  function fulfilmentOf(o){
    var f = o && o.snapshot && o.snapshot.fulfilment;
    return (f && typeof f === 'object') ? f : { driverId:null, assignedAt:null, pickedUpAt:null, deliveredAt:null };
  }
  /* a short, readable destination — the area and block the customer entered,
     never a joined-up profile record */
  function destinationOf(snap, o){
    var d = (snap && snap.delivery) || {};
    var bits = [d.area, d.block ? T('قطعة ','Block ') + d.block : null, d.street ? T('شارع ','St ') + d.street : null].filter(Boolean);
    return bits.length ? bits.join(' · ') : (d.address || L(o.addr) || null);
  }
  var TIMING = {
    instant:      { ar:'فوري',         en:'Instant' },
    scheduled:    { ar:'موعد محدد',    en:'Scheduled' },
    next_opening: { ar:'عند الافتتاح', en:'Next opening' }
  };
  function commitmentOf(o){
    try { return (global.RAFStoreSchedule && o.snapshot) ? RAFStoreSchedule.formatCommitment(o.snapshot, T('ar','en')) : null; }
    catch (e) { return null; }
  }

  /* One delivery, as operations needs to see it. Every field is read; none is
     computed twice and none is invented — a timestamp RAF does not hold comes
     back null and the surface says so. */
  function project(o){
    var stage = stageOf(o);
    if (!stage) return null;                       /* still the store's work */
    var snap = o.snapshot || null, f = fulfilmentOf(o), a = assignmentOf(o.id);
    var items = (snap && snap.items) || o.items || [];
    var d = (snap && snap.delivery) || {};
    var driverUser = null;
    if (f.driverId) { try { driverUser = RAFPerm.getUser(f.driverId); } catch (e) {} }
    return {
      orderId:    o.id,
      stage:      stage,
      status:     o.status,
      storeSlug:  (snap && snap.storeSlug) || null,
      store:      snap ? { ar:snap.storeNameAr, en:snap.storeNameEn } : (o.store || null),
      storeNumber:(snap && snap.storeId) || null,
      placedAt:   (snap && snap.checkoutAt) || null,
      dateText:   L(o.date) || null,
      customer:   { name:(snap && snap.customer && snap.customer.name) || null,
                    phone:(snap && snap.customer && snap.customer.phone) || null },
      destination:destinationOf(snap, o),
      address:    (snap && snap.delivery && snap.delivery.address) || L(o.addr) || null,
      instructions:(d.instructions || null),
      timing:     d.timing || null,
      timingText: TIMING[d.timing] ? T(TIMING[d.timing].ar, TIMING[d.timing].en) : null,
      type:       d.type || null,
      commitment: commitmentOf(o),
      total:      o.total || null,
      payment:    { method:(snap && snap.commercial && snap.commercial.paymentMethod) || o.pay || null,
                    status:(snap && snap.commercial && snap.commercial.paymentStatus) || null },
      itemCount:  items.reduce(function (n, it) { return n + (parseInt(it.qty, 10) || 1); }, 0),
      items:      items.map(function (it) {
                    return { name:{ ar:it.nameAr || (it.name && it.name.ar), en:it.nameEn || (it.name && it.name.en) },
                             qty:parseInt(it.qty, 10) || 1,
                             variant:it.variant || null, meta:it.meta || null,
                             price:(it.finalPrice != null ? it.finalPrice : it.price) };
                  }),
      /* the driver who owns it, by name — the account id stays internal */
      driver:     f.driverId ? { name:a.driverName || (driverUser && driverUser.name) || null,
                                 /* staff-only: reached after scope() proved the session */
                                 phone:(driverUser && driverUser.phone) || null,
                                 status:(driverUser && driverUser.status) || null } : null,
      assignedAt: f.assignedAt || null,
      /* how the current owner got it: 'claim' | 'dispatch' | null (predates history) */
      assignedVia:f.driverId && global.RAFDriver && RAFDriver.ownershipKindOf ? RAFDriver.ownershipKindOf(o.id) : null,
      pickedUpAt: f.pickedUpAt || null,
      deliveredAt:f.deliveredAt || null
    };
  }
  function allDeliveries(){
    return orders().map(project).filter(Boolean);
  }

  /* ══════════════════ QUEUES ══════════════════
     The queues ARE the existing stages — no new status, no parallel machine. */
  var QUEUES = [
    { key:'available', stage:'awaiting_driver',  ar:'المتاحة للسائقين', en:'Available' },
    { key:'claimed',   stage:'claimed',          ar:'مسحوبة',           en:'Claimed' },
    { key:'out',       stage:'out_for_delivery', ar:'قيد التوصيل',      en:'Out for delivery' },
    { key:'delivered', stage:'delivered',        ar:'تم التوصيل',       en:'Delivered' }
  ];
  function queueOfStage(stage){
    for (var i = 0; i < QUEUES.length; i++) if (QUEUES[i].stage === stage) return QUEUES[i].key;
    return null;
  }
  function sameDay(ts, now){
    if (!ts) return false;
    var a = new Date(ts), b = new Date(now || Date.now());
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  /* ══════════════════ THE BOARD ══════════════════ */
  function board(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;

    var list = allDeliveries();
    var counts = { available:0, claimed:0, out:0, delivered:0, deliveredToday:0 };
    list.forEach(function (d) {
      var q = queueOfStage(d.stage); if (!q) return;
      counts[q]++;
      if (q === 'delivered' && sameDay(d.deliveredAt)) counts.deliveredToday++;
    });
    return { ok:true, viewer:{ name:sc.name }, deliveries:list, counts:counts,
             queues:QUEUES.map(function (q) { return { key:q.key, stage:q.stage, ar:q.ar, en:q.en }; }),
             attention:attention(list), drivers:driverOptions(), stores:storeOptions(list) };
  }

  /* one delivery in full, for the operations drawer */
  function detail(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var o = orders().filter(function (x) { return x.id === orderId; })[0];
    if (!o) return fail('NOT_FOUND');
    var d = project(o);
    if (!d) return fail('NOT_FOUND');
    return { ok:true, delivery:d, timeline:timelineOf(d) };
  }

  /* The operational timeline: the same five moments the lifecycle actually
     has, in plain words. Audit actions and engine state names never appear
     here — the audit log keeps them and is not touched. */
  function timelineOf(d){
    var steps = [
      { key:'ready',     ar:'جاهز في المتجر',        en:'Ready at the store',   at:null, done:true },
      { key:'waiting',   ar:'بانتظار سائق',          en:'Waiting for a driver', at:null, done:true },
      { key:'claimed',   ar:(d.assignedVia === 'dispatch' || d.assignedVia === 'reassignment') ? 'أُسند إلى سائق' : 'سحبه السائق',
                         en:(d.assignedVia === 'dispatch' || d.assignedVia === 'reassignment') ? 'Assigned to a driver' : 'Driver claimed it', at:d.assignedAt, done:!!d.assignedAt },
      { key:'picked',    ar:'استلمه من المتجر',      en:'Picked up',            at:d.pickedUpAt,  done:!!d.pickedUpAt },
      { key:'delivered', ar:'تم التوصيل',            en:'Delivered',            at:d.deliveredAt, done:!!d.deliveredAt }
    ];
    /* RAF records no ready/waiting timestamp, so those two are marked reached
       without inventing a time for them */
    return steps;
  }

  /* ══════════════════ ATTENTION ══════════════════
     Only conditions the data can actually prove. No SLA, no "late": no
     threshold has been approved, so nothing is judged against a guess. */
  function attention(list){
    list = list || allDeliveries();
    var out = [];
    list.forEach(function (d) {
      if (d.driver && d.driver.status === 'suspended' && d.stage !== 'delivered')
        out.push({ kind:'suspended_driver', orderId:d.orderId, driver:d.driver.name,
                   ar:'هذا السائق موقوف وما زال يملك طلبًا جاريًا',
                   en:'This driver is suspended and still owns a live delivery' });
      if (d.stage === 'claimed' && d.assignedAt)
        out.push({ kind:'claimed_not_picked', orderId:d.orderId, driver:d.driver && d.driver.name, since:d.assignedAt,
                   ar:'لدى سائق ولم يُستلم من المتجر بعد',
                   en:'With a driver but not collected from the store yet' });
    });
    return out;
  }

  /* ══════════════════ FILTER OPTIONS ══════════════════ */
  /* real driver employee accounts, including suspended ones: a suspended
     driver still appears on the deliveries they own */
  function driverOptions(){
    try {
      return (RAFPerm.getUsers() || [])
        .filter(function (u) { return u.accountType === 'driver' && u.roleId === 'driver'; })
        .map(function (u) { return { name:u.name, status:u.status }; });
    } catch (e) { return []; }
  }
  /* the stores that actually have deliveries, by their own names */
  function storeOptions(list){
    var seen = {}, out = [];
    (list || allDeliveries()).forEach(function (d) {
      if (!d.storeSlug || seen[d.storeSlug]) return;
      seen[d.storeSlug] = 1;
      out.push({ slug:d.storeSlug, name:d.store });
    });
    return out;
  }

  /* ══════════════════ DISPATCH & OPERATIONS (Phase C) ══════════════════
     The board for manual dispatch. Every part is a projection of an owning
     authority, re-read on every call:
       · pool      — RAFDriver.dispatchPool(): Priority and Regular, already
                     classified and ordered (the ordering timestamp itself is
                     internal; no ETA is displayed);
       · drivers   — RAFDriver.eligibleDrivers(): active driver accounts only;
       · locks     — this module's operation locks, per delivery;
       · inProgress / closedToday — deliveries with a driver, and delivered
                     today, from the same stage derivation as every list.
     No metric is added and nothing is estimated. */
  function lockStateFor(orderId, me, pol){
    var s = lockStore(); if (!s) return { state:'none' };
    var v = lockView(s.get('delivery:' + orderId), pol);
    if (!v) return { state:'none' };
    if (v.stale) return { state:'stale', ownerName:v.ownerName, label:v.label };
    return { state:v.ownerUserId === me ? 'mine' : 'other', ownerName:v.ownerName, label:v.label };
  }
  function dispatchBoard(){
    var sc = scope(); if (!sc.ok) return sc;
    if (!global.RAFDriver || !RAFDriver.dispatchPool) return fail('FORBIDDEN');
    var pool = RAFDriver.dispatchPool(); if (!pool.ok) return pool;
    var drv = RAFDriver.eligibleDrivers(); if (!drv.ok) return drv;
    var pol = lockPolicy();
    var byId = {}; orders().forEach(function (o) { byId[o.id] = o; });
    function item(p){
      var d = project(byId[p.orderId]); if (!d) return null;
      return Object.assign(d, { pool:p.entry.pool, poolEntryKind:p.entry.kind, poolEnteredAt:p.entry.enteredAt,
        orderingMissing:p.ordering.missing, storeResolved:p.storeResolved, lock:lockStateFor(p.orderId, sc.id, pol) });
    }
    var list = allDeliveries();
    var labelCfg = global.RAFConfig ? RAFConfig.value('pool.priorityLabel') : null;
    var reqs = RAFDriver.pendingRequests ? RAFDriver.pendingRequests() : { ok:false };
    var pendingBy = {}; (reqs.ok ? reqs.requests : []).forEach(function (r) { pendingBy[r.orderId] = r; });
    function owned(d){
      return Object.assign(d, { lock:lockStateFor(d.orderId, sc.id, pol), pendingRequest:pendingBy[d.orderId] || null,
        driverId:(fulfilmentOf(byId[d.orderId]).driverId) || null });
    }
    return { ok:true, viewer:{ id:sc.id, name:sc.name },
      lockPolicy:{ configured:pol.configured, temporary:pol.temporary },
      canAssign:(function(){ try { return !!RAFPerm.can(sc.id, 'orders.manage'); } catch (e) { return false; } })(),
      priorityLabel:labelCfg,
      pool:{ priority:pool.priority.map(item).filter(Boolean), regular:pool.regular.map(item).filter(Boolean) },
      drivers:drv.drivers,
      inProgress:list.filter(function (d) { return d.stage === 'claimed' || d.stage === 'out_for_delivery'; })
        .map(owned).sort(function (a, b) { return (b.assignedAt || 0) - (a.assignedAt || 0); }),
      /* Phase D: pending driver reassignment requests, oldest first */
      requests:reqs.ok ? reqs.requests : [],
      closedToday:list.filter(function (d) { return d.stage === 'delivered' && sameDay(d.deliveredAt); })
        .sort(function (a, b) { return (b.deliveredAt || 0) - (a.deliveredAt || 0); }) };
  }
  /* Assign a pool delivery to the driver the employee confirmed. Validation,
     arbitration, audit, notification and events all happen inside
     RAFDriver.transferOwnership; this only calls it and then lets go of the
     operation lock. On a refusal that ends the work on this delivery (it is
     owned, closed or no longer in the pool) the lock is released too; on a
     refusal the employee can correct (e.g. an inactive driver) it is kept. */
  var TERMINAL = ['ALREADY_OWNED', 'NOT_DISPATCHABLE', 'DELIVERY_CLOSED', 'ORDER_NOT_FOUND', 'STORE_UNRESOLVED'];
  function assign(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['toDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(); if (!sc.ok) return sc;
    if (!global.RAFDriver || !RAFDriver.transferOwnership) return fail('FORBIDDEN');
    var r = RAFDriver.transferOwnership(orderId, { kind:'first_assignment', toDriverId:opts.toDriverId });
    var s = lockStore(), l = s ? s.get('delivery:' + orderId) : null;
    if (l && l.ownerUserId === sc.id && (r.ok || TERMINAL.indexOf(r.code) > -1)) {
      var rel = releaseLock(orderId);
      r.lockReleased = !!rel.ok;
    }
    return r;
  }

  /* ══════════════════ REASSIGNMENT & RETURN TO POOL (Phase D) ══════════════════
     Orchestration only. Every rule (lock, owner, stage, target, reason,
     pending request, revalidation, audit, history, notifications, events)
     lives in RAFDriver; these wrappers call it with the kind made explicit and
     let go of the operation lock when the work on the delivery is over. */
  var TERMINAL_OWNED = ['NOT_OWNED', 'NOT_REASSIGNABLE', 'DELIVERY_CLOSED', 'ORDER_NOT_FOUND', 'STORE_UNRESOLVED'];
  function releaseAfter(orderId, sc, r, terminal){
    var s = lockStore(), l = s ? s.get('delivery:' + orderId) : null;
    if (l && l.ownerUserId === sc.id && (r.ok || terminal.indexOf(r.code) > -1)) r.lockReleased = !!releaseLock(orderId).ok;
    return r;
  }
  function reassign(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['toDriverId', 'reason', 'expectedDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(); if (!sc.ok) return sc;
    if (!global.RAFDriver || !RAFDriver.transferOwnership) return fail('FORBIDDEN');
    return releaseAfter(orderId, sc, RAFDriver.transferOwnership(orderId, Object.assign({ kind:'reassignment' }, opts)), TERMINAL_OWNED);
  }
  function returnToPool(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['reason', 'expectedDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(); if (!sc.ok) return sc;
    if (!global.RAFDriver || !RAFDriver.transferOwnership) return fail('FORBIDDEN');
    return releaseAfter(orderId, sc, RAFDriver.transferOwnership(orderId, Object.assign({ kind:'return_to_pool' }, opts)), TERMINAL_OWNED);
  }
  function decideRequest(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['requestId', 'decision', 'toDriverId', 'reason', 'expectedDriverId'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(); if (!sc.ok) return sc;
    if (!global.RAFDriver || !RAFDriver.decideReassignmentRequest) return fail('FORBIDDEN');
    return releaseAfter(orderId, sc, RAFDriver.decideReassignmentRequest(orderId, opts), TERMINAL_OWNED.concat(['NO_PENDING_REQUEST']));
  }
  function history(orderId){
    var sc = scope(); if (!sc.ok) return sc;
    return RAFDriver && RAFDriver.operationsHistory ? RAFDriver.operationsHistory(orderId) : fail('FORBIDDEN');
  }

  /* ══════════════════ EXCEPTIONS + SLA + ESCALATION (Phase E) ══════════════════
     OWNERSHIP DECISION. Exceptions are a Logistics operation, so RAFDeliveryOps
     owns them (RAFDeliveryOps.exceptions). No separate engine exists. It reuses:
       · RAFDriver.scope()          — the driver's own identity;
       · scope() + orders.manage    — the TEMPORARY Logistics staff boundary;
       · the operation locks above  — every staff mutation needs the live lock;
       · RAFOrderEngine.acceptedAt / promisedEtaAt — the canonical Promised ETA;
       · RAFConfig                  — every threshold, template and category;
       · RAFRecordStore / RAFAudit / RAFNotify / RAFEventBus — records, audit,
         per-recipient notifications, live events.
     It never reassigns, returns to pool, cancels, refunds, touches stock,
     wallet, price or order state. "Reassign Driver" as a resolution records a
     decision; the reassignment itself is Phase D (RAFDriver.transferOwnership).

     MODEL. An exception is an immutable creation record ('exceptions') plus
     append-only lifecycle entries ('exception_events'); its current state is
     DERIVED by folding the entries, never edited:
        open ─escalated→ escalated ─taken→ in_management ─returned→ open
        open | in_management ─closed→ closed ─reopened→ open
     One active exception per delivery. ONE SLA clock: from openedAt, using the
     durations snapshotted at open; never paused or reset (escalation, locks,
     return, reopen and pending reassignment requests do not stop it).

     SLA / PENALTY EVALUATION (evaluate()) is deterministic and idempotent:
     transitions are appended with deterministic ids, so a second evaluator in
     another tab cannot notify twice. It runs whenever an authorised surface
     reads or acts, and at the next threshold instant on an open Logistics
     page. PROTOTYPE LIMIT: nothing evaluates while no page is open — production
     requires a server-side scheduler. */
  var EX_ERRORS = {
    EX_FORBIDDEN:          { ar:'لا تملك صلاحية على استثناءات التوصيل.',           en:'You do not have permission for delivery exceptions.' },
    MANAGEMENT_ONLY:       { ar:'هذا الإجراء لإدارة العمليات فقط.',                en:'This action is for Operations Management only.' },
    EX_LOCK_REQUIRED:      { ar:'يجب أن تعمل على هذا التوصيل (قفل العملية) أولاً.', en:'You must hold this delivery’s operation lock first.' },
    ORDER_NOT_OPEN:        { ar:'هذا الطلب ليس توصيلًا جاريًا.',                    en:'This order is not a live delivery.' },
    STORE_UNRESOLVED:      { ar:'الطلب غير مرتبط بمتجر معروف.',                     en:'The order has no resolved store.' },
    NOT_YOUR_DELIVERY:     { ar:'هذا التوصيل غير مسند إليك.',                       en:'This delivery is not assigned to you.' },
    CATEGORY_INVALID:      { ar:'فئة الاستثناء غير صالحة.',                         en:'That exception category is not valid.' },
    CATEGORY_NOT_APPLICABLE:{ ar:'هذه الفئة لا تنطبق على هذا التوصيل.',              en:'That category does not apply to this delivery.' },
    DESCRIPTION_REQUIRED:  { ar:'الوصف إلزامي لهذه الفئة.',                         en:'A description is required for this category.' },
    EXCEPTION_ALREADY_OPEN:{ ar:'يوجد استثناء نشط على هذا التوصيل.',                 en:'This delivery already has an active exception.' },
    CALL_ATTEMPTS_REQUIRED:{ ar:'يجب تسجيل محاولات الاتصال المطلوبة أولاً.',          en:'The required call attempts must be recorded first.' },
    NOT_CONFIGURED:        { ar:'الإعداد المطلوب غير مُهيّأ.',                       en:'The required configuration is not set.' },
    EXCEPTION_NOT_FOUND:   { ar:'الاستثناء غير موجود.',                             en:'That exception does not exist.' },
    EXCEPTION_CLOSED:      { ar:'الاستثناء مغلق.',                                  en:'The exception is closed.' },
    EXCEPTION_NOT_CLOSED:  { ar:'الاستثناء غير مغلق.',                              en:'The exception is not closed.' },
    ALREADY_ESCALATED:     { ar:'الاستثناء مُصعّد بالفعل.',                          en:'The exception is already escalated.' },
    NOT_ESCALATED:         { ar:'الاستثناء غير مُصعّد.',                             en:'The exception is not escalated.' },
    NOT_IN_MANAGEMENT:     { ar:'لم تتولَّ الإدارة هذا الاستثناء.',                   en:'Management has not taken this exception.' },
    ESCALATION_PENDING:    { ar:'الاستثناء بانتظار إجراء الإدارة.',                  en:'The exception is waiting for management action.' },
    ESCALATION_REASON_REQUIRED:{ ar:'اختر سبب التصعيد أو اكتب وصفًا.',               en:'Select an escalation reason or enter a description.' },
    REASON_INVALID:        { ar:'سبب التصعيد غير صالح.',                            en:'That escalation reason is not valid.' },
    RESOLUTION_INVALID:    { ar:'نوع المعالجة غير صالح.',                           en:'That resolution type is not valid.' },
    DETAILS_REQUIRED:      { ar:'التفاصيل إلزامية لهذه المعالجة.',                   en:'Details are required for this resolution.' },
    NOTE_REQUIRED:         { ar:'النص إلزامي.',                                      en:'Text is required.' },
    DECISION_REQUIRED:     { ar:'قرار الإدارة أو تعليماتها إلزامية.',                 en:'A management decision or instruction is required.' },
    REASON_REQUIRED:       { ar:'السبب إلزامي.',                                    en:'A reason is required.' },
    ETA_INVALID:           { ar:'الوقت المتوقع غير صالح.',                          en:'That ETA is not valid.' },
    NO_ACCEPTED_TIME:      { ar:'لا يوجد وقت قبول مسجّل لهذا الطلب.',                 en:'This order has no recorded acceptance time.' },
    DRIVER_CLOSE_NOT_ALLOWED:{ ar:'لا يمكن للسائق إغلاق هذا الاستثناء.',             en:'The driver cannot close this exception.' },
    STATE_CHANGED:         { ar:'تغيّرت حالة الاستثناء أثناء العملية. أعد المحاولة.', en:'The exception changed during the operation. Try again.' },
    PERSIST_FAILED:        { ar:'تعذّر حفظ السجل.',                                  en:'The record could not be saved.' }
  };
  Object.keys(EX_ERRORS).forEach(function (k) { ERRORS[k] = EX_ERRORS[k]; });

  var RESOLUTIONS = {
    reassign_driver:      { ar:'إعادة إسناد السائق',     en:'Reassign Driver' },
    driver_must_continue: { ar:'يجب أن يتابع السائق',    en:'Driver Must Continue' },
    other_resolution:     { ar:'معالجة أخرى',            en:'Other Resolution', detailsRequired:true }
  };
  var AUTO_CLOSE_REASON = { ar:'أُغلق تلقائيًا — تم تسليم الطلب', en:'Auto-Closed — Order Delivered' };

  function exColl(n){ return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; }
  function cfg(k){ return global.RAFConfig ? RAFConfig.value(k) : null; }
  function cfgGet(k){ return global.RAFConfig ? RAFConfig.get(k) : { configured:false, status:'not_configured', value:null }; }
  function trimmed(v){ return typeof v === 'string' ? v.trim() : ''; }
  function orderOf(id){ return orders().filter(function (o) { return o.id === id; })[0] || null; }
  function exAudit(o){ if (!global.RAFAudit) return null; try { var r = RAFAudit.record(o); return (r && r.event && r.event.eventId) || null; } catch (e) { return null; } }
  function exEvent(type, entityId, storeSlug, payload, system){
    if (global.RAFEventBus) RAFEventBus.publish(type, { entityId:entityId, source:system ? 'system' : 'admin', system:!!system,
      storeSlug:storeSlug || null, payload:payload || {} });
  }
  function userById(id){ try { return RAFPerm.getUser(id); } catch (e) { return null; } }

  /* ---------- identities (always the session) ---------- */
  function exStaff(){
    var sc = scope(); if (!sc.ok) return fail('EX_FORBIDDEN', { detail:sc.code });
    var ok = false; try { ok = !!RAFPerm.can(sc.id, 'orders.manage'); } catch (e) {}
    if (!ok) return fail('EX_FORBIDDEN');
    return { ok:true, type:'staff', id:sc.id, name:sc.name, roleId:sc.roleId };
  }
  /* Operations Management: the existing escalation-target role from RAFConfig
     ('ops_manager') or Super Admin (full access), inside the Logistics scope */
  function isManagementRole(roleId){ return roleId === cfg('sla.escalationTargetRole') || roleId === 'super_admin'; }
  function exManagement(){
    var st = exStaff(); if (!st.ok) return st;
    if (!isManagementRole(st.roleId)) return fail('MANAGEMENT_ONLY');
    return st;
  }
  function exDriver(){
    if (!global.RAFDriver || !RAFDriver.scope) return fail('EX_FORBIDDEN');
    var sc = RAFDriver.scope(); if (!sc.ok) return sc;
    return { ok:true, type:'driver', id:sc.id, name:sc.name, roleId:sc.roleId };
  }
  function actorRec(a){ return { type:a.type, id:a.id, name:a.name || null, roleId:a.roleId || null }; }
  function lockHeld(orderId, st){
    var pol = lockPolicy(); if (!pol.configured) return false;
    var s = lockStore(); var v = s ? lockView(s.get('delivery:' + orderId), pol) : null;
    return !!(v && v.ownerUserId === st.id && !v.stale);
  }

  /* ---------- recipients ---------- */
  function logisticsRecipients(){
    var users = []; try { users = RAFPerm.getUsers() || []; } catch (e) {}
    return users.filter(function (u) {
      if (!u || u.status !== 'active') return false;
      try { return RAFPerm.can(u.id, 'orders.view') && RAFPerm.can(u.id, 'drivers.view') && RAFPerm.can(u.id, 'orders.manage'); } catch (e) { return false; }
    }).map(function (u) { return u.id; });
  }
  function managementRecipients(){
    var role = cfg('sla.escalationTargetRole'), users = []; try { users = RAFPerm.getUsers() || []; } catch (e) {}
    return users.filter(function (u) { return u && u.status === 'active' && u.roleId === role; }).map(function (u) { return u.id; });
  }
  function notifyEx(recipients, type, orderId, tail, message, skipId){
    if (!global.RAFNotify || !RAFNotify.create) return 0;
    var def = (RAFNotify.EVENT_TYPES || {})[type] || {}, n = 0;
    (recipients || []).forEach(function (uid) {
      if (!uid || uid === skipId) return;
      var r = RAFNotify.create({ recipientUserId:uid, eventType:type, title:def.title, message:message || { ar:'الطلب ' + orderId, en:'Order ' + orderId },
        entityType:'order', entityId:orderId, href:def.audience === 'driver' ? 'raf_driver.html' : 'raf_delivery_management.html#/dispatch/exceptions',
        source:'system', dedupeKey:type + '|' + tail });
      if (r && r.ok && !r.duplicate) n++;
    });
    return n;
  }

  /* ---------- time, ETA ---------- */
  function fmtTime(ms, lang){
    try { return new Date(ms).toLocaleString(lang === 'en' ? 'en-GB' : 'ar-KW-u-nu-latn',
      { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kuwait' }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function promisedEta(orderId){ var e = global.RAFOrderEngine && RAFOrderEngine.promisedEtaAt ? RAFOrderEngine.promisedEtaAt(orderId) : null; return e ? e.at : null; }
  function etaUpdates(orderId){ var c = exColl('eta_updates'); return c ? c.filter(function (r) { return r.orderId === orderId; }).sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); }) : []; }
  function currentEta(orderId){ var u = etaUpdates(orderId); return u.length ? u[u.length - 1].etaAt : promisedEta(orderId); }

  /* ---------- categories ---------- */
  function categories(){ var c = cfg('exceptions.categories'); return Array.isArray(c) ? c : []; }
  function categoryOf(key){ return categories().filter(function (c) { return c && c.key === key; })[0] || null; }

  /* ---------- derived state ---------- */
  function exRecords(){ var c = exColl('exceptions'); return c ? c.all() : []; }
  function exEntries(exceptionId){
    var c = exColl('exception_events'); if (!c) return [];
    return c.filter(function (e) { return e.exceptionId === exceptionId; }).sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); });
  }
  function fold(rec){
    var st = { status:'open', escalation:'none', escalations:0, takes:0, returns:0, cycle:0, closedAt:null, closedBy:null,
               resolutionType:null, resolutionDetails:null, autoClosed:false, lastDecision:null, lastInstruction:null,
               approachingRecordedAt:null, breachedRecordedAt:null, escalatedBy:null, actions:0 };
    exEntries(rec.exceptionId).forEach(function (e) {
      switch (e.type) {
        case 'action':    st.actions++; break;
        case 'escalated': st.escalations++; st.status = 'escalated'; st.escalation = 'pending'; st.escalatedBy = e.actor; break;
        case 'taken':     st.takes++; st.status = 'in_management'; st.escalation = 'taken'; break;
        case 'returned':  st.returns++; st.status = 'open'; st.escalation = 'returned'; st.lastDecision = e.decision; st.lastInstruction = e.driverInstruction || null; break;
        case 'closed':    st.status = 'closed'; st.closedAt = e.at; st.closedBy = e.actor; st.resolutionType = e.resolutionType;
                          st.resolutionDetails = e.details || null; st.autoClosed = !!e.automatic; break;
        case 'reopened':  st.cycle++; st.status = 'open'; st.closedAt = null; st.closedBy = null; st.resolutionType = null; st.autoClosed = false;
                          if (st.escalation === 'pending' || st.escalation === 'taken') st.escalation = 'none'; break;
        case 'sla_approaching': st.approachingRecordedAt = e.at; break;
        case 'sla_breached':    st.breachedRecordedAt = e.at; break;
      }
    });
    return st;
  }
  function slaOf(rec, st, now){
    var dur = rec.sla && rec.sla.durationMinutes, appr = rec.sla && rec.sla.approachingMinutes;
    if (typeof dur !== 'number') return { state:'not_configured', configured:false };
    var breachAt = rec.openedAt + dur * 60000;
    var approachAt = typeof appr === 'number' ? breachAt - appr * 60000 : null;
    var end = st.status === 'closed' ? st.closedAt : now;
    var state;
    if (st.status === 'closed') state = end > breachAt ? 'breached_closed' : 'met';
    else if (end >= breachAt) state = 'breached';
    else if (approachAt != null && end >= approachAt) state = 'approaching';
    else state = 'running';
    return { state:state, configured:true, startedAt:rec.openedAt, breachAt:breachAt, approachAt:approachAt,
             durationMinutes:dur, approachingMinutes:typeof appr === 'number' ? appr : null,
             elapsedMs:end - rec.openedAt, remainingMs:breachAt - end, approachingRecorded:!!st.approachingRecordedAt, breachedRecorded:!!st.breachedRecordedAt };
  }
  function activeExceptionFor(orderId){
    var list = exRecords().filter(function (r) { return r.orderId === orderId; });
    for (var i = list.length - 1; i >= 0; i--) if (fold(list[i]).status !== 'closed') return list[i];
    return null;
  }
  function penaltyOf(orderId, o){
    var thr = cfg('sla.penaltyRiskAfterMinutes'), p = promisedEta(orderId);
    var recs = (exColl('penalty_risks') ? exColl('penalty_risks').filter(function (r) { return r.orderId === orderId; }) : []);
    var f = (o && o.snapshot && o.snapshot.fulfilment) || {};
    var ref = f.deliveredAt || (o && o.status === 'delivered' ? null : Date.now());
    var risk = typeof thr === 'number' && p != null && ref != null && (ref - p) > thr * 60000;
    return { configured:typeof thr === 'number', thresholdMinutes:thr, promisedEtaAt:p, atRisk:!!risk,
             detectedAt:recs.length ? recs[0].at : null, lateByMs:p != null && ref != null ? ref - p : null };
  }
  function view(rec, now){
    now = now || Date.now();
    var st = fold(rec), o = orderOf(rec.orderId), f = (o && o.snapshot && o.snapshot.fulfilment) || {};
    var drv = f.driverId ? userById(f.driverId) : null;
    var pol = lockPolicy(), s = lockStore(), lv = s ? lockView(s.get('delivery:' + rec.orderId), pol) : null;
    return {
      exceptionId:rec.exceptionId, orderId:rec.orderId, storeSlug:rec.storeSlug,
      store:o && o.snapshot ? { ar:o.snapshot.storeNameAr, en:o.snapshot.storeNameEn } : null,
      category:rec.category, description:rec.description || null,
      openedAt:rec.openedAt, openedBy:rec.openedBy,
      status:st.status, escalation:st.escalation, escalatedBy:st.escalatedBy,
      resolutionType:st.resolutionType, resolutionDetails:st.resolutionDetails, autoClosed:st.autoClosed,
      closedAt:st.closedAt, closedBy:st.closedBy, reopenCount:st.cycle,
      lastDecision:st.lastDecision, lastInstruction:st.lastInstruction,
      promisedEtaAt:promisedEta(rec.orderId), currentEtaAt:currentEta(rec.orderId), promisedEtaAtOpen:rec.promisedEtaAtOpen,
      sla:slaOf(rec, st, now), penalty:penaltyOf(rec.orderId, o),
      customerMessage:rec.customerMessage,
      stage:global.RAFDriver && RAFDriver.stageOfOrder && o ? RAFDriver.stageOfOrder(o) : null, orderStatus:o ? o.status : null,
      driver:drv ? { id:drv.id, name:drv.name || null } : null,
      lock:lv ? { ownerUserId:lv.ownerUserId, ownerName:lv.ownerName, stale:lv.stale, label:lv.label } : null
    };
  }

  /* ---------- SLA + penalty evaluation (idempotent) ---------- */
  function appendEntry(e){
    var c = exColl('exception_events'); if (!c) return { ok:false };
    return c.append('entryId', Object.assign({ version:1 }, e));
  }
  function evaluate(){
    var now = Date.now(), out = { approaching:0, breached:0, escalated:0, penalty:0 };
    exRecords().forEach(function (rec) {
      var st = fold(rec); if (st.status === 'closed') return;
      var o = orderOf(rec.orderId), slug = rec.storeSlug;
      /* reconciliation: a delivery completed where this module was not loaded
         still auto-closes its exception before any SLA transition */
      if (o && o.status === 'delivered') { autoCloseOnDelivery(rec.orderId); return; }
      var sla = slaOf(rec, st, now); if (!sla.configured) return;
      if (sla.state === 'approaching' && !st.approachingRecordedAt) {
        var a = appendEntry({ entryId:'exe|' + rec.exceptionId + '|sla_approaching', exceptionId:rec.exceptionId, orderId:rec.orderId,
          type:'sla_approaching', at:now, actor:{ type:'system' }, breachAt:sla.breachAt });
        if (a.ok && !a.duplicate) {
          out.approaching++;
          exAudit({ action:'exception.sla_approaching', orderId:rec.orderId, systemGenerated:true, source:'automation',
            key:rec.exceptionId + ':approaching', metadata:{ exceptionId:rec.exceptionId, breachAt:sla.breachAt } });
          notifyEx(logisticsRecipients(), 'logistics.exception.sla_approaching', rec.orderId, rec.exceptionId,
            { ar:'الطلب ' + rec.orderId + ' — ' + (rec.category.ar || rec.category.en), en:'Order ' + rec.orderId + ' — ' + rec.category.en });
          exEvent('logistics.exception.sla_approaching', rec.exceptionId, slug, { orderId:rec.orderId }, true);
        }
      }
      if (sla.state === 'breached' && !st.breachedRecordedAt) {
        var b = appendEntry({ entryId:'exe|' + rec.exceptionId + '|sla_breached', exceptionId:rec.exceptionId, orderId:rec.orderId,
          type:'sla_breached', at:now, actor:{ type:'system' }, breachAt:sla.breachAt });
        if (b.ok && !b.duplicate) {
          out.breached++;
          exAudit({ action:'exception.sla_breached', orderId:rec.orderId, systemGenerated:true, source:'automation',
            key:rec.exceptionId + ':breached', metadata:{ exceptionId:rec.exceptionId, breachAt:sla.breachAt } });
          notifyEx(logisticsRecipients(), 'logistics.exception.sla_breached', rec.orderId, rec.exceptionId,
            { ar:'الطلب ' + rec.orderId + ' — ' + (rec.category.ar || rec.category.en), en:'Order ' + rec.orderId + ' — ' + rec.category.en });
          exEvent('logistics.exception.sla_breached', rec.exceptionId, slug, { orderId:rec.orderId }, true);
          /* AUTOMATIC ESCALATION TO OPERATIONS MANAGEMENT — attention only */
          var st2 = fold(rec);
          if (st2.status === 'open') {
            var n = st2.escalations;
            var esc = appendEntry({ entryId:'exe|' + rec.exceptionId + '|escalated|' + n, exceptionId:rec.exceptionId, orderId:rec.orderId,
              type:'escalated', at:now, actor:{ type:'system' }, automatic:true, reasonKey:'sla_breached', description:null });
            if (esc.ok && !esc.duplicate) {
              out.escalated++;
              exAudit({ action:'exception.escalated', orderId:rec.orderId, systemGenerated:true, source:'automation',
                key:rec.exceptionId + ':escalated:' + n, reason:'sla_breached', metadata:{ exceptionId:rec.exceptionId, automatic:true, target:cfg('sla.escalationTargetRole') } });
              notifyEx(managementRecipients(), 'logistics.exception.escalated', rec.orderId, rec.exceptionId + '|' + n,
                { ar:'الطلب ' + rec.orderId + ' — تجاوز المهلة', en:'Order ' + rec.orderId + ' — SLA breached' });
              exEvent('logistics.exception.escalated', rec.exceptionId, slug, { orderId:rec.orderId, automatic:true }, true);
            }
          }
        }
      }
    });
    /* penalty RISK: live orders, and delivered orders at the moment of delivery (see autoCloseOnDelivery) */
    var thr = cfg('sla.penaltyRiskAfterMinutes');
    if (typeof thr === 'number') orders().forEach(function (o) {
      if (o.status !== 'progress' || !o.snapshot) return;
      if (detectPenalty(o, now)) out.penalty++;
    });
    return out;
  }
  function detectPenalty(o, now){
    var thr = cfg('sla.penaltyRiskAfterMinutes'), p = promisedEta(o.id); if (typeof thr !== 'number' || p == null) return false;
    var f = (o.snapshot && o.snapshot.fulfilment) || {}, ref = f.deliveredAt || now;
    if (ref - p <= thr * 60000) return false;
    var c = exColl('penalty_risks'); if (!c) return false;
    var r = c.append('riskId', { riskId:'pnr|' + o.id, orderId:o.id, storeSlug:o.snapshot.storeSlug || null, at:now,
      promisedEtaAt:p, referenceAt:ref, delivered:!!f.deliveredAt, lateByMs:ref - p, thresholdMinutes:thr, version:1 });
    if (!r.ok || r.duplicate) return false;
    exAudit({ action:'delivery.penalty_risk', orderId:o.id, systemGenerated:true, source:'automation', key:'penalty:' + o.id,
      metadata:{ promisedEtaAt:p, lateByMs:ref - p, thresholdMinutes:thr, delivered:!!f.deliveredAt } });
    notifyEx(logisticsRecipients(), 'logistics.delivery.penalty_risk', o.id, o.id,
      { ar:'الطلب ' + o.id + ' — تجاوز الوقت الموعود بأكثر من ' + thr + ' دقيقة', en:'Order ' + o.id + ' — more than ' + thr + ' min past the Promised ETA' });
    exEvent('logistics.delivery.penalty_risk', o.id, o.snapshot.storeSlug, { lateByMs:ref - p }, true);
    return true;
  }

  /* ---------- customer delay message (safe; ONE per exception) ---------- */
  function customerDelay(rec, o){
    var cats = cfg('exceptions.customerDelayCategories'), tpls = cfg('customerMessages.delayTemplates');
    var customer = o.snapshot.customer && o.snapshot.customer.id;
    var showReason = cfg('customerMessages.showDelayReason') === true;
    var res = { eligible:false, sent:false, reasonShown:false, notificationId:null, text:null };
    if (!Array.isArray(cats) || cats.indexOf(rec.category.key) < 0) return res;
    res.eligible = true;
    if (!customer || !Array.isArray(tpls)) return res;
    var t = tpls.filter(function (x) { return x && x.category === rec.category.key; })[0] || tpls.filter(function (x) { return x && x.category === '*'; })[0];
    if (!t) return res;
    var eta = currentEta(rec.orderId);
    function fill(s, lang){
      var label = lang === 'ar' ? (rec.category.ar || rec.category.en) : rec.category.en;
      return String(s || '').replace('{orderId}', rec.orderId).replace('{eta}', eta ? fmtTime(eta, lang) : (lang === 'ar' ? 'سيُحدَّد لاحقًا' : 'to be confirmed'))
        .replace('{reason}', showReason ? (lang === 'ar' ? ' السبب: ' + label : ' Reason: ' + label) : '');
    }
    var text = { ar:fill(t.ar, 'ar'), en:fill(t.en, 'en') };
    if (global.RAFNotify && RAFNotify.create) {
      var n = RAFNotify.create({ recipientUserId:customer, eventType:'order.delay', title:text, entityType:'order', entityId:rec.orderId,
        href:'raf_tracking.html?id=' + encodeURIComponent(rec.orderId), source:'system', dedupeKey:'order.delay|' + rec.exceptionId });
      if (n && n.ok) { res.sent = true; res.notificationId = n.notification.notificationId; }
    }
    res.reasonShown = showReason; res.text = text;
    return res;
  }

  /* ---------- helpers for the order checks ---------- */
  function liveStage(o){ return global.RAFDriver && RAFDriver.stageOfOrder ? RAFDriver.stageOfOrder(o) : null; }
  function isLiveStage(s){ return s === 'awaiting_driver' || s === 'claimed' || s === 'out_for_delivery'; }
  function recById(id){ var c = exColl('exceptions'); return c ? c.byId('exceptionId', id) : null; }

  /* ═════ OPEN ═════ */
  function openException(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['category', 'description'])) return fail('FIELD_NOT_ACCEPTED');
    var dr = exDriver(), actor = dr.ok ? dr : exStaff();
    if (!actor.ok) return fail('EX_FORBIDDEN');
    if (!exColl('exceptions')) return fail('PERSIST_FAILED');
    evaluate();
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('NOT_FOUND');
    if (o.snapshot.legacyUnresolved === true || !o.snapshot.storeSlug) return fail('STORE_UNRESOLVED');
    var stage = liveStage(o); if (o.status !== 'progress' || !isLiveStage(stage)) return fail('ORDER_NOT_OPEN');
    var f = o.snapshot.fulfilment || {};
    if (actor.type === 'driver' && (f.driverId !== actor.id || (stage !== 'claimed' && stage !== 'out_for_delivery'))) return fail('NOT_YOUR_DELIVERY');
    var cat = categoryOf(opts.category); if (!cat) return fail('CATEGORY_INVALID');
    /* a driver who owns the delivery cannot report that no driver is available */
    if (cat.key === 'no_driver_available' && (actor.type === 'driver' || f.driverId)) return fail('CATEGORY_NOT_APPLICABLE');
    var desc = trimmed(opts.description);
    if (cat.requiresDescription && !desc) return fail('DESCRIPTION_REQUIRED');
    if (activeExceptionFor(orderId)) return fail('EXCEPTION_ALREADY_OPEN');
    var attempts = null;
    if (cat.key === 'customer_unreachable' && actor.type === 'driver') {
      var req = cfg('exceptions.customerUnreachableCallAttempts');
      if (typeof req !== 'number') return fail('NOT_CONFIGURED', { key:'exceptions.customerUnreachableCallAttempts' });
      attempts = callAttemptCount(orderId, actor.id, f.assignedAt);
      if (attempts < req) return fail('CALL_ATTEMPTS_REQUIRED', { recorded:attempts, required:req });
    }
    var now = Date.now(), id = RAFRecordStore.makeId('exc');
    var rec = { exceptionId:id, orderId:orderId, storeSlug:o.snapshot.storeSlug,
      category:{ key:cat.key, en:cat.en || null, ar:cat.ar || null, requiresDescription:!!cat.requiresDescription },
      description:desc || null, openedAt:now, openedBy:actorRec(actor), driverIdAtOpen:f.driverId || null, stageAtOpen:stage,
      promisedEtaAtOpen:promisedEta(orderId), currentEtaAtOpen:currentEta(orderId),
      sla:{ durationMinutes:cfg('sla.exceptionDurationMinutes'), approachingMinutes:cfg('sla.approachingThresholdMinutes'),
            durationStatus:cfgGet('sla.exceptionDurationMinutes').status, approachingStatus:cfgGet('sla.approachingThresholdMinutes').status },
      callAttemptsAtOpen:attempts, version:1 };
    rec.customerMessage = customerDelay(rec, o);
    rec.auditEventId = exAudit({ action:'exception.opened', orderId:orderId, actor:{ id:actor.id }, source:actor.type === 'driver' ? 'driver' : 'admin',
      key:id, reason:cat.key, metadata:{ exceptionId:id, category:cat.key, description:desc || null, customerMessageSent:rec.customerMessage.sent } });
    var r = exColl('exceptions').append('exceptionId', rec);
    if (!r.ok) return fail('PERSIST_FAILED');
    var msg = { ar:'الطلب ' + orderId + ' — ' + (cat.ar || cat.en), en:'Order ' + orderId + ' — ' + cat.en };
    notifyEx(logisticsRecipients(), 'logistics.exception.opened', orderId, id, msg, actor.id);
    if (actor.type === 'staff' && f.driverId) notifyEx([f.driverId], 'driver.exception.opened', orderId, id, msg);
    exEvent('logistics.exception.opened', id, rec.storeSlug, { orderId:orderId, category:cat.key });
    evaluate();
    return { ok:true, exception:view(r.record) };
  }

  /* ═════ CUSTOMER UNREACHABLE — CALL ATTEMPTS ═════
     Only CALL attempts are recorded here (an in-app message is not a call).
     The driver declares each call they made; RAF has no telephony, so nothing
     pretends RAF placed or verified a call. Counted per driver since they
     became the owner of this delivery. */
  function callAttemptList(orderId){ var c = exColl('call_attempts'); return c ? c.filter(function (a) { return a.orderId === orderId; }) : []; }
  function callAttemptCount(orderId, driverId, since){
    return callAttemptList(orderId).filter(function (a) { return a.driverId === driverId && a.channel === 'call' && (!since || a.at >= since); }).length;
  }
  function recordCallAttempt(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var dr = exDriver(); if (!dr.ok) return fail('EX_FORBIDDEN');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('NOT_FOUND');
    var f = o.snapshot.fulfilment || {}, stage = liveStage(o);
    if (o.status !== 'progress' || f.driverId !== dr.id || (stage !== 'claimed' && stage !== 'out_for_delivery')) return fail('NOT_YOUR_DELIVERY');
    var now = Date.now(), active = activeExceptionFor(orderId), id = RAFRecordStore.makeId('cal');
    var auditId = exAudit({ action:'exception.call_attempt', orderId:orderId, actor:{ id:dr.id }, source:'driver', key:id,
      metadata:{ attemptId:id, channel:'call', exceptionId:active ? active.exceptionId : null } });
    var r = exColl('call_attempts').append('attemptId', { attemptId:id, orderId:orderId, storeSlug:o.snapshot.storeSlug || null,
      driverId:dr.id, at:now, channel:'call', exceptionId:active ? active.exceptionId : null, auditEventId:auditId, version:1 });
    if (!r.ok) return fail('PERSIST_FAILED');
    var count = callAttemptCount(orderId, dr.id, f.assignedAt);
    notifyEx(logisticsRecipients(), 'logistics.customer_unreachable_attempt', orderId, id,
      { ar:'الطلب ' + orderId + ' — محاولة ' + count, en:'Order ' + orderId + ' — attempt ' + count });
    if (global.RAFEventBus) RAFEventBus.publish('driver.customer_unreachable_attempt', { entityId:orderId, source:'driver',
      storeSlug:o.snapshot.storeSlug || null, payload:{ attemptId:id } });
    return { ok:true, attempt:r.record, count:count, required:cfg('exceptions.customerUnreachableCallAttempts') };
  }

  /* ═════ STAFF ACTIONS ═════ */
  function staffContext(exceptionId, needManagement){
    var st = needManagement ? exManagement() : exStaff(); if (!st.ok) return st;
    evaluate();
    var rec = recById(exceptionId); if (!rec) return fail('EXCEPTION_NOT_FOUND');
    if (!lockHeld(rec.orderId, st)) return fail('EX_LOCK_REQUIRED');
    return { ok:true, st:st, rec:rec, fold:fold(rec) };
  }
  function recipientsForStaffEvent(rec, actorId){ return logisticsRecipients().filter(function (u) { return u !== actorId; }); }
  function currentDriverOf(orderId){ var o = orderOf(orderId); return o && o.snapshot && o.snapshot.fulfilment ? o.snapshot.fulfilment.driverId || null : null; }

  function addAction(exceptionId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['note'])) return fail('FIELD_NOT_ACCEPTED');
    var c = staffContext(exceptionId, false); if (!c.ok) return c;
    if (c.fold.status === 'closed') return fail('EXCEPTION_CLOSED');
    var note = trimmed(opts.note); if (!note) return fail('NOTE_REQUIRED');
    var now = Date.now(), id = RAFRecordStore.makeId('exa');
    var auditId = exAudit({ action:'exception.action', orderId:c.rec.orderId, actor:{ id:c.st.id }, source:'admin', key:id,
      reason:note, metadata:{ exceptionId:exceptionId } });
    var r = appendEntry({ entryId:id, exceptionId:exceptionId, orderId:c.rec.orderId, type:'action', at:now, actor:actorRec(c.st), note:note, auditEventId:auditId });
    if (!r.ok) return fail('PERSIST_FAILED');
    notifyEx(recipientsForStaffEvent(c.rec, c.st.id), 'logistics.exception.updated', c.rec.orderId, id);
    exEvent('logistics.exception.updated', exceptionId, c.rec.storeSlug, { orderId:c.rec.orderId });
    return { ok:true, exception:view(c.rec) };
  }

  function escalate(exceptionId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['reasonKey', 'description'])) return fail('FIELD_NOT_ACCEPTED');
    var c = staffContext(exceptionId, false); if (!c.ok) return c;
    if (c.fold.status === 'closed') return fail('EXCEPTION_CLOSED');
    if (c.fold.status === 'escalated' || c.fold.status === 'in_management') return fail('ALREADY_ESCALATED');
    var reasons = cfg('exceptions.escalationReasons'), reasonKey = opts.reasonKey || null, desc = trimmed(opts.description);
    if (reasonKey && !(Array.isArray(reasons) && reasons.some(function (x) { return x && (x.key === reasonKey || x === reasonKey); }))) return fail('REASON_INVALID');
    if (!reasonKey && !desc) return fail('ESCALATION_REASON_REQUIRED');
    var now = Date.now(), n = c.fold.escalations;
    var r = appendEntry({ entryId:'exe|' + exceptionId + '|escalated|' + n, exceptionId:exceptionId, orderId:c.rec.orderId, type:'escalated',
      at:now, actor:actorRec(c.st), automatic:false, reasonKey:reasonKey, description:desc || null });
    if (!r.ok) return fail('PERSIST_FAILED');
    if (r.duplicate) return fail('ALREADY_ESCALATED');
    exAudit({ action:'exception.escalated', orderId:c.rec.orderId, actor:{ id:c.st.id }, source:'admin', key:exceptionId + ':escalated:' + n,
      reason:reasonKey || desc, metadata:{ exceptionId:exceptionId, automatic:false, reasonKey:reasonKey, description:desc || null } });
    notifyEx(managementRecipients(), 'logistics.exception.escalated', c.rec.orderId, exceptionId + '|' + n, null, c.st.id);
    exEvent('logistics.exception.escalated', exceptionId, c.rec.storeSlug, { orderId:c.rec.orderId, automatic:false });
    return { ok:true, exception:view(c.rec) };
  }

  function takeEscalation(exceptionId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var c = staffContext(exceptionId, true); if (!c.ok) return c;
    if (c.fold.status !== 'escalated') return fail(c.fold.status === 'in_management' ? 'ALREADY_ESCALATED' : 'NOT_ESCALATED');
    var now = Date.now(), n = c.fold.takes;
    var r = appendEntry({ entryId:'exe|' + exceptionId + '|taken|' + n, exceptionId:exceptionId, orderId:c.rec.orderId, type:'taken', at:now, actor:actorRec(c.st) });
    if (!r.ok) return fail('PERSIST_FAILED');
    if (r.duplicate) return fail('STATE_CHANGED');
    exAudit({ action:'exception.taken', orderId:c.rec.orderId, actor:{ id:c.st.id }, source:'admin', key:exceptionId + ':taken:' + n,
      metadata:{ exceptionId:exceptionId } });
    var esc = c.fold.escalatedBy;
    notifyEx(esc && esc.id ? [esc.id] : [], 'logistics.exception.management_action', c.rec.orderId, exceptionId + '|taken|' + n,
      { ar:'الطلب ' + c.rec.orderId + ' — تولّت الإدارة التصعيد', en:'Order ' + c.rec.orderId + ' — management took the escalation' }, c.st.id);
    exEvent('logistics.exception.management_action', exceptionId, c.rec.storeSlug, { orderId:c.rec.orderId, action:'taken' });
    return { ok:true, exception:view(c.rec) };
  }

  function returnEscalation(exceptionId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['decision', 'driverInstruction'])) return fail('FIELD_NOT_ACCEPTED');
    var c = staffContext(exceptionId, true); if (!c.ok) return c;
    if (c.fold.status !== 'in_management') return fail('NOT_IN_MANAGEMENT');
    var decision = trimmed(opts.decision), instr = trimmed(opts.driverInstruction);
    if (!decision) return fail('DECISION_REQUIRED');
    var now = Date.now(), n = c.fold.returns;
    var r = appendEntry({ entryId:'exe|' + exceptionId + '|returned|' + n, exceptionId:exceptionId, orderId:c.rec.orderId, type:'returned',
      at:now, actor:actorRec(c.st), decision:decision, driverInstruction:instr || null });
    if (!r.ok) return fail('PERSIST_FAILED');
    if (r.duplicate) return fail('STATE_CHANGED');
    exAudit({ action:'exception.returned', orderId:c.rec.orderId, actor:{ id:c.st.id }, source:'admin', key:exceptionId + ':returned:' + n,
      reason:decision, metadata:{ exceptionId:exceptionId, driverInstruction:instr || null } });
    var esc = c.fold.escalatedBy;
    notifyEx(esc && esc.id ? [esc.id] : logisticsRecipients(), 'logistics.exception.management_action', c.rec.orderId, exceptionId + '|returned|' + n,
      { ar:'الطلب ' + c.rec.orderId + ' — قرار الإدارة: ' + decision, en:'Order ' + c.rec.orderId + ' — management decision: ' + decision }, c.st.id);
    var drv = currentDriverOf(c.rec.orderId);
    if (instr && drv) notifyEx([drv], 'driver.exception.instruction', c.rec.orderId, exceptionId + '|returned|' + n,
      { ar:'الطلب ' + c.rec.orderId + ' — ' + instr, en:'Order ' + c.rec.orderId + ' — ' + instr });
    exEvent('logistics.exception.management_action', exceptionId, c.rec.storeSlug, { orderId:c.rec.orderId, action:'returned' });
    return { ok:true, exception:view(c.rec) };
  }

  function closeEntry(c, rec, fields){
    return appendEntry(Object.assign({ entryId:'exe|' + rec.exceptionId + '|closed|' + c.cycle, exceptionId:rec.exceptionId, orderId:rec.orderId,
      type:'closed', at:Date.now() }, fields));
  }
  function resolve(exceptionId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['resolutionType', 'details'])) return fail('FIELD_NOT_ACCEPTED');
    var c = staffContext(exceptionId, false); if (!c.ok) return c;
    if (c.fold.status === 'closed') return fail('EXCEPTION_CLOSED');
    if (c.fold.status === 'escalated' && !isManagementRole(c.st.roleId)) return fail('ESCALATION_PENDING');
    if (c.fold.status === 'in_management' && !isManagementRole(c.st.roleId)) return fail('ESCALATION_PENDING');
    var type = RESOLUTIONS[opts.resolutionType] ? opts.resolutionType : null; if (!type) return fail('RESOLUTION_INVALID');
    var details = trimmed(opts.details);
    if (RESOLUTIONS[type].detailsRequired && !details) return fail('DETAILS_REQUIRED');
    var r = closeEntry(c.fold, c.rec, { actor:actorRec(c.st), resolutionType:type, details:details || null, automatic:false });
    if (!r.ok) return fail('PERSIST_FAILED');
    if (r.duplicate) return fail('EXCEPTION_CLOSED');
    exAudit({ action:'exception.resolved', orderId:c.rec.orderId, actor:{ id:c.st.id }, source:'admin', key:exceptionId + ':closed:' + c.fold.cycle,
      reason:type, metadata:{ exceptionId:exceptionId, resolutionType:type, details:details || null,
        note:type === 'reassign_driver' ? 'decision_only_reassignment_uses_phase_d' : null } });
    var drv = currentDriverOf(c.rec.orderId);
    var label = RESOLUTIONS[type];
    if (drv) notifyEx([drv], 'driver.exception.closed', c.rec.orderId, exceptionId + '|closed|' + c.fold.cycle,
      type === 'driver_must_continue' ? { ar:'الطلب ' + c.rec.orderId + ' — تابع التوصيل', en:'Order ' + c.rec.orderId + ' — continue the delivery' }
                                      : { ar:'الطلب ' + c.rec.orderId + ' — ' + label.ar, en:'Order ' + c.rec.orderId + ' — ' + label.en });
    notifyEx(recipientsForStaffEvent(c.rec, c.st.id), 'logistics.exception.closed', c.rec.orderId, exceptionId + '|closed|' + c.fold.cycle,
      { ar:'الطلب ' + c.rec.orderId + ' — ' + label.ar, en:'Order ' + c.rec.orderId + ' — ' + label.en });
    exEvent('logistics.exception.closed', exceptionId, c.rec.storeSlug, { orderId:c.rec.orderId, resolutionType:type });
    return { ok:true, exception:view(c.rec) };
  }

  /* the delivering driver may close their OWN Customer Unreachable exception
     (e.g. the customer answered) while it is not with management */
  function driverClose(exceptionId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['resolutionType', 'details'])) return fail('FIELD_NOT_ACCEPTED');
    var dr = exDriver(); if (!dr.ok) return fail('EX_FORBIDDEN');
    evaluate();
    var rec = recById(exceptionId); if (!rec) return fail('EXCEPTION_NOT_FOUND');
    if (currentDriverOf(rec.orderId) !== dr.id) return fail('NOT_YOUR_DELIVERY');
    var st = fold(rec);
    if (rec.category.key !== 'customer_unreachable') return fail('DRIVER_CLOSE_NOT_ALLOWED');
    if (st.status === 'closed') return fail('EXCEPTION_CLOSED');
    if (st.status !== 'open') return fail('ESCALATION_PENDING');
    var type = (opts.resolutionType === 'driver_must_continue' || opts.resolutionType === 'other_resolution') ? opts.resolutionType : null;
    if (!type) return fail('RESOLUTION_INVALID');
    var details = trimmed(opts.details);
    if (RESOLUTIONS[type].detailsRequired && !details) return fail('DETAILS_REQUIRED');
    var r = closeEntry(st, rec, { actor:actorRec(dr), resolutionType:type, details:details || null, automatic:false });
    if (!r.ok) return fail('PERSIST_FAILED');
    if (r.duplicate) return fail('EXCEPTION_CLOSED');
    exAudit({ action:'exception.closed', orderId:rec.orderId, actor:{ id:dr.id }, source:'driver', key:exceptionId + ':closed:' + st.cycle,
      reason:type, metadata:{ exceptionId:exceptionId, resolutionType:type, details:details || null } });
    notifyEx(logisticsRecipients(), 'logistics.exception.closed', rec.orderId, exceptionId + '|closed|' + st.cycle,
      { ar:'الطلب ' + rec.orderId + ' — أغلقه السائق', en:'Order ' + rec.orderId + ' — closed by the driver' });
    exEvent('logistics.exception.closed', exceptionId, rec.storeSlug, { orderId:rec.orderId, resolutionType:type, by:'driver' });
    return { ok:true, exception:view(rec) };
  }

  function reopen(exceptionId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['reason'])) return fail('FIELD_NOT_ACCEPTED');
    var c = staffContext(exceptionId, true); if (!c.ok) return c;
    if (c.fold.status !== 'closed') return fail('EXCEPTION_NOT_CLOSED');
    var reason = trimmed(opts.reason); if (!reason) return fail('REASON_REQUIRED');
    var now = Date.now(), cycle = c.fold.cycle;
    var r = appendEntry({ entryId:'exe|' + exceptionId + '|reopened|' + cycle, exceptionId:exceptionId, orderId:c.rec.orderId, type:'reopened',
      at:now, actor:actorRec(c.st), reason:reason, previousClosedAt:c.fold.closedAt });
    if (!r.ok) return fail('PERSIST_FAILED');
    if (r.duplicate) return fail('STATE_CHANGED');
    exAudit({ action:'exception.reopened', orderId:c.rec.orderId, actor:{ id:c.st.id }, source:'admin', key:exceptionId + ':reopened:' + cycle,
      reason:reason, metadata:{ exceptionId:exceptionId, previousClosedAt:c.fold.closedAt } });
    var drv = currentDriverOf(c.rec.orderId);     /* the CURRENT responsible driver */
    if (drv) notifyEx([drv], 'driver.exception.reopened', c.rec.orderId, exceptionId + '|reopened|' + cycle);
    notifyEx(recipientsForStaffEvent(c.rec, c.st.id), 'logistics.exception.reopened', c.rec.orderId, exceptionId + '|reopened|' + cycle);
    exEvent('logistics.exception.reopened', exceptionId, c.rec.storeSlug, { orderId:c.rec.orderId });
    evaluate();
    return { ok:true, exception:view(c.rec) };
  }

  /* ═════ ETA UPDATE (management) ═════
     Changes the CURRENT ETA only; the Promised ETA (accepted + offset) is
     never changed. Reason mandatory. No order, payment, stock or commercial
     change. The customer and the current driver are told the new time; the
     reason is internal. */
  function updateEta(orderId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['etaAt', 'reason'])) return fail('FIELD_NOT_ACCEPTED');
    var st = exManagement(); if (!st.ok) return st;
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('NOT_FOUND');
    if (o.snapshot.legacyUnresolved === true || !o.snapshot.storeSlug) return fail('STORE_UNRESOLVED');
    if (o.status !== 'progress') return fail('ORDER_NOT_OPEN');
    if (!lockHeld(orderId, st)) return fail('EX_LOCK_REQUIRED');
    var acc = global.RAFOrderEngine && RAFOrderEngine.acceptedAt ? RAFOrderEngine.acceptedAt(orderId) : null;
    if (!acc) return fail('NO_ACCEPTED_TIME');
    var eta = Number(opts.etaAt);
    if (!isFinite(eta) || eta <= acc.at) return fail('ETA_INVALID');
    var reason = trimmed(opts.reason); if (!reason) return fail('REASON_REQUIRED');
    var now = Date.now(), id = RAFRecordStore.makeId('eta'), prev = currentEta(orderId), active = activeExceptionFor(orderId);
    var auditId = exAudit({ action:'eta.updated', orderId:orderId, actor:{ id:st.id }, source:'admin', key:id,
      previousState:prev != null ? String(prev) : null, newState:String(eta), reason:reason,
      metadata:{ etaUpdateId:id, promisedEtaAt:promisedEta(orderId), exceptionId:active ? active.exceptionId : null } });
    var r = exColl('eta_updates').append('etaUpdateId', { etaUpdateId:id, orderId:orderId, storeSlug:o.snapshot.storeSlug, at:now,
      etaAt:eta, previousEtaAt:prev, promisedEtaAt:promisedEta(orderId), reason:reason, actor:actorRec(st),
      exceptionId:active ? active.exceptionId : null, auditEventId:auditId, version:1 });
    if (!r.ok) return fail('PERSIST_FAILED');
    var customer = o.snapshot.customer && o.snapshot.customer.id, tpl = cfg('customerMessages.etaUpdateTemplate');
    if (customer && tpl && global.RAFNotify) {
      var text = { ar:String(tpl.ar || '').replace('{orderId}', orderId).replace('{eta}', fmtTime(eta, 'ar')),
                   en:String(tpl.en || '').replace('{orderId}', orderId).replace('{eta}', fmtTime(eta, 'en')) };
      RAFNotify.create({ recipientUserId:customer, eventType:'order.eta_updated', title:text, entityType:'order', entityId:orderId,
        href:'raf_tracking.html?id=' + encodeURIComponent(orderId), source:'system', dedupeKey:'order.eta_updated|' + id });
    }
    var etaMsg = { ar:'الطلب ' + orderId + ' — ' + fmtTime(eta, 'ar'), en:'Order ' + orderId + ' — ' + fmtTime(eta, 'en') };
    var drv = currentDriverOf(orderId);
    if (drv) notifyEx([drv], 'driver.delivery.eta_updated', orderId, id, etaMsg);
    notifyEx(logisticsRecipients(), 'logistics.delivery.eta_updated', orderId, id, etaMsg, st.id);
    exEvent('logistics.delivery.eta_updated', orderId, o.snapshot.storeSlug, { etaUpdateId:id });
    return { ok:true, orderId:orderId, promisedEtaAt:promisedEta(orderId), currentEtaAt:eta, update:r.record };
  }

  /* ═════ DELIVERY AUTO-CLOSE (called by RAFDriver.completeDelivery) ═════
     Acts only when the order really is delivered, so it cannot be used to
     close an exception otherwise. No customer message. */
  function autoCloseOnDelivery(orderId){
    var o = orderOf(orderId); if (!o || !o.snapshot || o.status !== 'delivered') return { ok:false, reason:'not_delivered' };
    var out = { ok:true, closed:null, penaltyRisk:false };
    var active = activeExceptionFor(orderId);
    if (active) {
      var st = fold(active);
      var r = closeEntry(st, active, { actor:{ type:'system' }, resolutionType:'auto_closed_delivered', automatic:true,
        reason:AUTO_CLOSE_REASON, deliveredAt:(o.snapshot.fulfilment || {}).deliveredAt || Date.now() });
      if (r.ok && !r.duplicate) {
        out.closed = active.exceptionId;
        exAudit({ action:'exception.auto_closed', orderId:orderId, systemGenerated:true, source:'automation',
          key:active.exceptionId + ':closed:' + st.cycle, reason:AUTO_CLOSE_REASON.en,
          metadata:{ exceptionId:active.exceptionId, deliveredAt:(o.snapshot.fulfilment || {}).deliveredAt || null } });
        notifyEx(logisticsRecipients(), 'logistics.exception.closed', orderId, active.exceptionId + '|closed|' + st.cycle,
          { ar:'الطلب ' + orderId + ' — ' + AUTO_CLOSE_REASON.ar, en:'Order ' + orderId + ' — ' + AUTO_CLOSE_REASON.en });
        exEvent('logistics.exception.closed', active.exceptionId, active.storeSlug, { orderId:orderId, resolutionType:'auto_closed_delivered' }, true);
      }
    }
    out.penaltyRisk = detectPenalty(o, Date.now());
    return out;
  }

  /* ═════ READS ═════ */
  function listExceptions(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['status'])) return fail('FIELD_NOT_ACCEPTED');
    var st = exStaff(); if (!st.ok) return st;
    evaluate();
    var now = Date.now();
    var list = exRecords().map(function (r) { return view(r, now); });
    if (opts.status === 'active') list = list.filter(function (v) { return v.status !== 'closed'; });
    else if (opts.status === 'closed') list = list.filter(function (v) { return v.status === 'closed'; });
    return { ok:true, exceptions:list.sort(function (a, b) { return b.openedAt - a.openedAt; }), config:exConfig(), viewer:{ id:st.id, management:isManagementRole(st.roleId) } };
  }
  function getException(exceptionId){
    var st = exStaff(); if (!st.ok) return st;
    evaluate();
    var rec = recById(exceptionId); if (!rec) return fail('EXCEPTION_NOT_FOUND');
    return { ok:true, exception:view(rec), record:rec, entries:exEntries(exceptionId), etaUpdates:etaUpdates(rec.orderId),
             callAttempts:callAttemptList(rec.orderId), viewer:{ id:st.id, management:isManagementRole(st.roleId), holdsLock:lockHeld(rec.orderId, st) },
             config:exConfig() };
  }
  /* what needs attention now — only conditions records prove */
  function attentionList(){
    var st = exStaff(); if (!st.ok) return st;
    evaluate();
    var now = Date.now(), items = [];
    exRecords().forEach(function (r) {
      var v = view(r, now); if (v.status === 'closed') return;
      if (v.status === 'escalated' || v.status === 'in_management') items.push({ kind:'escalation', exception:v });
      if (v.sla.state === 'breached') items.push({ kind:'sla_breached', exception:v });
      else if (v.sla.state === 'approaching') items.push({ kind:'sla_approaching', exception:v });
    });
    var pr = exColl('penalty_risks') ? exColl('penalty_risks').all() : [];
    pr.forEach(function (p) {
      var o = orderOf(p.orderId); if (!o || o.status !== 'progress') return;
      items.push({ kind:'penalty_risk', orderId:p.orderId, storeSlug:p.storeSlug, detectedAt:p.at, lateByMs:now - p.promisedEtaAt,
                   promisedEtaAt:p.promisedEtaAt, currentEtaAt:currentEta(p.orderId) });
    });
    return { ok:true, items:items };
  }
  /* the driver's own view of their delivery's exception state (no internal notes) */
  function driverView(orderId){
    var dr = exDriver(); if (!dr.ok) return fail('EX_FORBIDDEN');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('NOT_FOUND');
    var f = o.snapshot.fulfilment || {};
    if (f.driverId !== dr.id) return fail('NOT_YOUR_DELIVERY');
    evaluate();
    var list = exRecords().filter(function (r) { return r.orderId === orderId; });
    var active = activeExceptionFor(orderId), last = list.length ? list[list.length - 1] : null;
    function safe(r){ if (!r) return null; var v = view(r), s = fold(r);
      return { exceptionId:v.exceptionId, category:v.category, status:v.status === 'in_management' ? 'escalated' : v.status,
               openedAt:v.openedAt, openedByMe:r.openedBy && r.openedBy.id === dr.id, resolutionType:v.resolutionType,
               autoClosed:v.autoClosed, instruction:s.lastInstruction, canClose:r.category.key === 'customer_unreachable' && v.status === 'open' }; }
    var req = cfg('exceptions.customerUnreachableCallAttempts');
    return { ok:true, active:safe(active), last:safe(last), categories:categories().filter(function (c) { return c.key !== 'no_driver_available'; }),
             callAttempts:{ count:callAttemptCount(orderId, dr.id, f.assignedAt), required:typeof req === 'number' ? req : null } };
  }
  function exConfig(){
    function c(k){ var g = cfgGet(k); return { value:g.value, status:g.status, configured:!!g.configured }; }
    return { categories:categories(), resolutions:RESOLUTIONS, slaMinutes:c('sla.exceptionDurationMinutes'),
             approachingMinutes:c('sla.approachingThresholdMinutes'), penaltyRiskMinutes:c('sla.penaltyRiskAfterMinutes'),
             callAttempts:c('exceptions.customerUnreachableCallAttempts'), showDelayReason:c('customerMessages.showDelayReason'),
             escalationReasons:c('exceptions.escalationReasons'), escalationTargetRole:c('sla.escalationTargetRole'),
             etaOffset:c('eta.promisedDurationMinutes') };
  }
  /* the next instant at which a threshold is crossed (for the page's single
     deadline timer — not a synchronisation poll) */
  function nextDeadline(){
    var now = Date.now(), next = null;
    function consider(t){ if (t && t > now && (next == null || t < next)) next = t; }
    exRecords().forEach(function (r) { var s = fold(r); if (s.status === 'closed') return; var sla = slaOf(r, s, now);
      if (sla.configured) { consider(sla.approachAt); consider(sla.breachAt); } });
    var thr = cfg('sla.penaltyRiskAfterMinutes');
    if (typeof thr === 'number') orders().forEach(function (o) { if (o.status !== 'progress') return; var p = promisedEta(o.id); if (p != null) consider(p + thr * 60000 + 1); });
    return next;
  }

  var EXCEPTIONS = {
    RESOLUTIONS:RESOLUTIONS, AUTO_CLOSE_REASON:AUTO_CLOSE_REASON,
    open:openException, recordCallAttempt:recordCallAttempt, addAction:addAction, escalate:escalate,
    take:takeEscalation, returnToEmployee:returnEscalation, resolve:resolve, driverClose:driverClose, reopen:reopen,
    updateEta:updateEta, autoCloseOnDelivery:autoCloseOnDelivery,
    list:listExceptions, get:getException, attention:attentionList, driverView:driverView, config:exConfig,
    evaluate:function(){ var a = exDriver(); if (!a.ok) { a = exStaff(); if (!a.ok) return fail('EX_FORBIDDEN'); } return Object.assign({ ok:true }, evaluate()); },
    nextDeadline:function(){ var a = exStaff(); return a.ok ? nextDeadline() : null; },
    currentEtaAt:function(orderId){ var a = exStaff(); return a.ok ? currentEta(orderId) : null; }
  };

  global.RAFDeliveryOps = {
    exceptions:EXCEPTIONS, logisticsRecipients:logisticsRecipients,
    PERM:PERM, QUEUES:QUEUES, ERRORS:ERRORS, TIMING:TIMING,
    canAccess:canAccess, scope:scope,
    /* operation locks */
    lockPolicy:lockPolicy, lockOf:lockOf, acquireLock:acquireLock, heartbeatLock:heartbeatLock,
    releaseLock:releaseLock, recoverStaleLock:recoverStaleLock,
    /* manual dispatch */
    dispatchBoard:dispatchBoard, assign:assign,
    /* reassignment & return to pool */
    reassign:reassign, returnToPool:returnToPool, decideRequest:decideRequest, history:history,
    board:board, detail:detail, queueOfStage:queueOfStage, label:L
  };
})(window);
