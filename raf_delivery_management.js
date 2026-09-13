/* ==========================================================================
 * RAF — DELIVERY OPERATIONS  (RAFDeliveryOps)
 * --------------------------------------------------------------------------
 * The RAF-wide operational view of delivery activity. It is a PROJECTION and
 * an authorisation gate — nothing else:
 *
 *   · it owns no delivery state. Every stage comes from RAFDriver, which
 *     derives it from RAFOrderEngine and the snapshot's fulfilment section;
 *   · it performs no mutation. Claiming stays driver-initiated, there is no
 *     dispatcher assignment, and nothing here can move, cancel, refund or
 *     reassign a delivery;
 *   · it duplicates no value. Order facts are read from RAFOrderSnapshot,
 *     driver facts from RAFDriver.assignmentOf, accounts from RAFPerm.
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
    FORBIDDEN:          { ar:'إدارة التوصيل متاحة لفريق عمليات رف فقط.', en:'Delivery Management is available to RAF operations staff only.' },
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
                                 phone:a.driverPhone || (driverUser && driverUser.phone) || null,
                                 status:(driverUser && driverUser.status) || null } : null,
      assignedAt: f.assignedAt || null,
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
      { key:'claimed',   ar:'سحبه السائق',           en:'Driver claimed it',    at:d.assignedAt,  done:!!d.assignedAt },
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
                   ar:'مسحوب ولم يُستلم من المتجر بعد',
                   en:'Claimed but not collected from the store yet' });
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

  global.RAFDeliveryOps = {
    PERM:PERM, QUEUES:QUEUES, ERRORS:ERRORS, TIMING:TIMING,
    canAccess:canAccess, scope:scope,
    board:board, detail:detail, queueOfStage:queueOfStage, label:L
  };
})(window);
