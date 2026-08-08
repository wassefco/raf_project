/* ============================================================
   RAF — AUDIT & TIMELINE ENGINE  (shared, headless, single owner)
   ------------------------------------------------------------
   One authoritative event log for every order. It answers: what
   happened, when, who did it, which store, from which surface, what
   the state was before and after, whether it was undone, and whether
   it happened automatically.

   Two readings of the same events:
     · Timeline  — the simple operational history a merchant reads
     · Audit Log — the detailed accountability record

   The log is APPEND-ONLY. Undo never erases anything: it appends a
   new event that points back at the one it reverses.

   This module records; it never performs business actions. The order
   engine and the store-operations engine do the work and call in here
   afterwards, so no page ever creates events of its own.
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFAudit) return;

  var LS       = 'raf_audit_events';
  var LS_FAIL  = 'raf_audit_failures';

  var ACTOR  = { CUSTOMER:'customer', MERCHANT:'merchant', MERCHANT_EMPLOYEE:'merchant_employee',
                 DRIVER:'driver', ADMIN:'admin', SYSTEM:'system', UNKNOWN:'unknown' };
  var SOURCE = { CUSTOMER:'customer', MERCHANT:'merchant', DRIVER:'driver', ADMIN:'admin',
                 SYSTEM:'system', AUTOMATION:'automation', INTEGRATION:'integration' };

  /* ---------- action registry ----------
     `tl` marks the events a merchant sees on the Timeline. Everything else
     is recorded but lives only in the Audit Log. */
  var A = {
    /* customer */
    'order.created':        { tl:true,  ar:'طلب جديد',                    en:'New order' },
    'order.cancelled':      { tl:true,  ar:'ألغى العميل الطلب',           en:'Customer cancelled the order' },
    'order.oos_preference': { tl:false, ar:'تفضيل نفاد المخزون',          en:'Out-of-stock preference' },
    'payment.result':       { tl:false, ar:'نتيجة الدفع',                 en:'Payment result' },
    'customer.approved':    { tl:true,  ar:'وافق العميل على التعديل',     en:'Customer approved a modification' },
    'customer.response':    { tl:false, ar:'رد العميل',                   en:'Customer response' },
    /* merchant */
    'order.opened':         { tl:false, ar:'فُتح الطلب',                  en:'Order opened' },
    'lock.acquired':        { tl:false, ar:'تم قفل الطلب',                en:'Order locked' },
    'lock.released':        { tl:false, ar:'تم تحرير القفل',              en:'Order lock released' },
    'lock.expired':         { tl:false, ar:'انتهت صلاحية القفل',          en:'Order lock expired' },
    'lock.overridden':      { tl:true,  ar:'تم تولّي معالجة الطلب',       en:'Order processing taken over' },
    'order.accept':         { tl:true,  ar:'قبل المتجر الطلب',            en:'Store accepted the order' },
    'order.reject':         { tl:true,  ar:'اعتذر المتجر عن الطلب',       en:'Store declined the order' },
    'order.ready':          { tl:true,  ar:'تم تجهيز الطلب',              en:'Order ready' },
    'order.undo':           { tl:true,  ar:'تم التراجع عن الإجراء',       en:'Action undone' },
    'modify.requested':     { tl:false, ar:'طلب تعديل الخيارات',          en:'Variant modification requested' },
    'modify.applied':       { tl:true,  ar:'تم تطبيق تعديل معتمد',        en:'Approved modification applied' },
    'product.removed':      { tl:true,  ar:'تم حذف منتج من الطلب',        en:'Product removed from the order' },
    'note.order':           { tl:false, ar:'أُضيفت ملاحظة على الطلب',     en:'Order note added' },
    'note.preparation':     { tl:false, ar:'أُضيفت ملاحظة تجهيز',         en:'Preparation note added' },
    'focus.entered':        { tl:false, ar:'دخول وضع التركيز',            en:'Focus Mode entered' },
    'focus.exited':         { tl:false, ar:'خروج من وضع التركيز',         en:'Focus Mode exited' },
    'session.recovered':    { tl:false, ar:'تمت استعادة الجلسة',          en:'Session recovered' },
    'session.emergency':    { tl:false, ar:'استعادة طارئة',               en:'Emergency recovery' },
    'net.offline':          { tl:false, ar:'انقطع الاتصال',               en:'Connection lost' },
    'net.online':           { tl:false, ar:'عاد الاتصال',                 en:'Connection restored' },
    /* driver */
    'driver.assigned':      { tl:true,  ar:'تم تعيين السائق',             en:'Driver assigned' },
    'driver.ready_ack':     { tl:false, ar:'أكد السائق جاهزية الطلب',     en:'Driver acknowledged ready' },
    'driver.pickup':        { tl:true,  ar:'استلم السائق الطلب',          en:'Driver picked up the order' },
    'driver.pickup_recovery':{tl:true,  ar:'اكتمل "جاهز" تلقائيًا بعد استلام السائق',
                                        en:'Ready auto-completed after driver pickup' },
    'driver.delivery_start':{ tl:true,  ar:'بدأ التوصيل',                 en:'Delivery started' },
    'driver.delivered':     { tl:true,  ar:'تم التسليم',                  en:'Delivered' },
    /* system */
    'system.timeout':       { tl:true,  ar:'انتهت مهلة القبول تلقائيًا',   en:'Acceptance window timed out' },
    'system.cancelled':     { tl:true,  ar:'أُلغي الطلب تلقائيًا',         en:'Order cancelled automatically' },
    'system.stock_restored':{ tl:false, ar:'أُعيدت الكمية للمخزون تلقائيًا', en:'Stock restored automatically' },
    'system.refunded':      { tl:true,  ar:'تم رد المبلغ تلقائيًا',        en:'Refunded automatically' },
    'system.ready_recovery':{ tl:true,  ar:'اكتمل "جاهز" تلقائيًا',        en:'Ready completed automatically' },
    'system.lock_expired':  { tl:false, ar:'انتهت صلاحية القفل تلقائيًا',  en:'Lock expired automatically' },
    'ops.workload_manual':  { tl:false, ar:'تغيير حالة التشغيل يدويًا',    en:'Workload changed manually' },
    'ops.workload_auto':    { tl:false, ar:'استئناف الحساب التلقائي',      en:'Automatic mode restored' },
    'ops.busy_on':          { tl:false, ar:'تفعيل الإيقاف المؤقت',        en:'Busy Mode enabled' },
    'ops.busy_off':         { tl:false, ar:'إلغاء الإيقاف المؤقت',        en:'Busy Mode disabled' },
    'ops.busy_expired':     { tl:false, ar:'انتهى الإيقاف المؤقت تلقائيًا', en:'Temporary closure expired' },
    'snapshot.updated':     { tl:false, ar:'تم تعديل سجل الطلب',          en:'Order record updated' },
    'order.migrated':       { tl:false, ar:'تمت ترقية سجل الطلب',         en:'Order record migrated' }
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }

  /* ---------- storage (append-only) ---------- */
  function readAll(){
    try { var a = JSON.parse(localStorage.getItem(LS)); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function writeAll(list){
    try { localStorage.setItem(LS, JSON.stringify(list)); return true; }
    catch (e) { return false; }
  }
  /* an audit failure is recorded for diagnostics — never silently swallowed,
     and never allowed to alter the business result that already happened */
  function recordFailure(ev, err){
    try {
      var f = JSON.parse(localStorage.getItem(LS_FAIL) || '[]');
      f.unshift({ at:Date.now(), eventId:ev && ev.eventId, action:ev && ev.action,
                  error:String((err && err.message) || err || 'persist_failed') });
      localStorage.setItem(LS_FAIL, JSON.stringify(f.slice(0, 50)));
    } catch (e) {}
  }
  function failures(){
    try { var f = JSON.parse(localStorage.getItem(LS_FAIL)); return Array.isArray(f) ? f : []; }
    catch (e) { return []; }
  }

  /* ---------- actor resolution ----------
     Never guessed. With no identifiable user the actor is `unknown` and no
     name is invented. */
  function resolveActor(actor){
    if (actor && actor.type === ACTOR.SYSTEM) {
      return { actorType:ACTOR.SYSTEM, actorId:null, actorName:null };
    }
    if (actor && actor.id) {
      var role = actor.roleId || null;
      if (!role && global.RAFPerm) { var u = RAFPerm.getUser(actor.id); role = u && u.roleId; }
      return { actorType: roleToActor(role), actorId:actor.id, actorName:actor.name || null };
    }
    if (global.RAFPerm && RAFPerm.currentUser) {
      var cu = RAFPerm.currentUser();
      if (cu && cu.id) return { actorType:roleToActor(cu.roleId), actorId:cu.id, actorName:cu.name || null };
    }
    return { actorType:ACTOR.UNKNOWN, actorId:null, actorName:null };
  }
  function roleToActor(roleId){
    if (roleId === 'merchant') return ACTOR.MERCHANT;
    if (roleId === 'merchant_employee') return ACTOR.MERCHANT_EMPLOYEE;
    if (roleId === 'driver') return ACTOR.DRIVER;
    if (roleId === 'customer') return ACTOR.CUSTOMER;
    if (roleId) return ACTOR.ADMIN;                 /* staff roles */
    return ACTOR.UNKNOWN;
  }

  /* ---------- store scoping ----------
     Always the canonical storeSlug, taken from the order snapshot. */
  function slugOf(orderId){
    if (!orderId || !global.RAFOrderSnapshot) return null;
    return RAFOrderSnapshot.storeSlugOf(orderId);
  }
  function snapVersionOf(orderId){
    if (!orderId || !global.RAFOrderSnapshot) return null;
    var s = RAFOrderSnapshot.of(orderId);
    return s ? s.v : null;
  }

  /* ---------- validation ---------- */
  function validate(ev){
    var missing = [];
    if (!ev.eventId)   missing.push('eventId');
    if (!ev.action)    missing.push('action');
    if (!A[ev.action]) missing.push('action:unknown(' + ev.action + ')');
    if (!ev.timestamp) missing.push('timestamp');
    if (!ev.actorType) missing.push('actorType');
    if (!ev.source)    missing.push('source');
    return { ok: missing.length === 0, missing: missing };
  }

  /* ---------- idempotency ----------
     The event id is derived from the business fact, so a retry, refresh,
     duplicate click or cross-tab echo produces the same id and is dropped. */
  function makeId(action, orderId, key){
    return [action, orderId || 'none', key == null ? '' : String(key)].join('|');
  }
  function exists(id){
    var all = readAll();
    for (var i = all.length - 1; i >= 0; i--) if (all[i].eventId === id) return true;
    return false;
  }

  /* ---------- the one write path ----------
     opts: { action, orderId, key, actor, source, previousState, newState,
             reason, metadata, reversible, undoOf, automatic, systemGenerated } */
  function record(opts){
    opts = opts || {};
    if (!opts.action || !A[opts.action]) return { ok:false, reason:'unknown_action', action:opts.action };

    var who = opts.systemGenerated || opts.automatic
      ? { actorType:ACTOR.SYSTEM, actorId:null, actorName:null }
      : resolveActor(opts.actor);

    var ts = opts.timestamp || Date.now();
    var ev = {
      eventId:        makeId(opts.action, opts.orderId, opts.key != null ? opts.key : ts),
      orderId:        opts.orderId || null,
      storeSlug:      opts.storeSlug || slugOf(opts.orderId),
      timestamp:      ts,
      seq:            0,
      actorType:      who.actorType,
      actorId:        who.actorId,
      actorName:      who.actorName,
      source:         opts.source || SOURCE.SYSTEM,
      action:         opts.action,
      previousState:  opts.previousState == null ? null : opts.previousState,
      newState:       opts.newState == null ? null : opts.newState,
      reason:         opts.reason || null,
      metadata:       opts.metadata || null,
      reversible:     !!opts.reversible,
      undone:         false,
      undoOf:         opts.undoOf || null,
      automatic:      !!opts.automatic,
      systemGenerated:!!opts.systemGenerated,
      snapshotVersion: opts.snapshotVersion || snapVersionOf(opts.orderId)
    };

    var check = validate(ev);
    if (!check.ok) { recordFailure(ev, 'invalid:' + check.missing.join(',')); return { ok:false, reason:'invalid', missing:check.missing }; }

    /* re-read immediately before appending so a concurrent tab is not lost */
    var all = readAll();
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].eventId === ev.eventId) return { ok:true, duplicate:true, event:all[i] };
    }
    ev.seq = (all.length ? (all[all.length - 1].seq || 0) : 0) + 1;

    /* an undo marks its original, without removing it */
    if (ev.undoOf) {
      for (var j = all.length - 1; j >= 0; j--) {
        if (all[j].eventId === ev.undoOf) { all[j].undone = true; break; }
      }
    }
    all.push(ev);
    if (all.length > MAX) {
      var dropped = all.length - MAX;
      all = all.slice(dropped);
      recordFailure(ev, 'trimmed:' + dropped + ' oldest events exceeded storage ceiling');
    }
    if (!writeAll(all)) { recordFailure(ev, 'persist_failed'); return { ok:false, reason:'persist_failed', event:ev }; }
    emit(ev);
    return { ok:true, event:ev };
  }

  /* ---------- reading ----------
     Deterministic order: timestamp, then sequence — never insertion order alone. */
  function sorted(list){
    return list.slice().sort(function (a, b) {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      if ((a.seq || 0) !== (b.seq || 0))  return (a.seq || 0) - (b.seq || 0);
      return String(a.eventId).localeCompare(String(b.eventId));
    });
  }
  function forOrder(orderId){
    return sorted(readAll().filter(function (e) { return e.orderId === orderId; }));
  }
  /* store isolation is enforced here, by slug only */
  function forStore(slug){
    if (!slug) return [];
    return sorted(readAll().filter(function (e) { return e.storeSlug === slug; }));
  }
  function query(opts){
    opts = opts || {};
    var list = readAll().filter(function (e) {
      if (opts.storeSlug && e.storeSlug !== opts.storeSlug) return false;
      if (opts.orderId  && e.orderId  !== opts.orderId)  return false;
      if (opts.action   && e.action   !== opts.action)   return false;
      if (opts.actorType&& e.actorType!== opts.actorType)return false;
      if (opts.source   && e.source   !== opts.source)   return false;
      if (opts.automatic != null && !!e.automatic !== !!opts.automatic) return false;
      if (opts.since    && e.timestamp < opts.since)     return false;
      return true;
    });
    return sorted(list);
  }

  /* ---------- timeline projection ----------
     The merchant's simple operational history, from the same events. No
     technical metadata is exposed here. */
  function label(action){
    var d = A[action];
    return d ? T(d.ar, d.en) : action;
  }
  function timeOf(ts){
    var d = new Date(ts);
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function timeline(orderId){
    return forOrder(orderId).filter(function (e) {
      return A[e.action] && A[e.action].tl;
    }).map(function (e) {
      var text = label(e.action);
      /* an automatic event must never read as if a person did it */
      if (e.action === 'order.undo' && e.metadata && e.metadata.of) text = T('تم التراجع عن: ','Undone: ') + label(e.metadata.of);
      return {
        eventId: e.eventId,
        time: timeOf(e.timestamp),
        timestamp: e.timestamp,
        text: text,
        actor: (e.automatic || e.systemGenerated) ? null : e.actorName,
        automatic: !!(e.automatic || e.systemGenerated),
        undone: !!e.undone,
        state: e.newState || null
      };
    });
  }

  /* ---------- audit log projection ----------
     The detailed accountability record. Callers gate access; this only
     shapes the data. */
  function auditLog(opts){
    return query(opts).map(function (e) {
      return {
        eventId:e.eventId, timestamp:e.timestamp, time:timeOf(e.timestamp),
        action:e.action, label:label(e.action),
        actorType:e.actorType, actorId:e.actorId, actorName:e.actorName,
        source:e.source, previousState:e.previousState, newState:e.newState,
        reason:e.reason, metadata:e.metadata, automatic:!!e.automatic,
        systemGenerated:!!e.systemGenerated, undone:!!e.undone, undoOf:e.undoOf,
        snapshotVersion:e.snapshotVersion, storeSlug:e.storeSlug, orderId:e.orderId
      };
    });
  }
  /* who may read the detailed log — existing RAFPerm keys only */
  function canViewAudit(userOrId){
    if (!global.RAFPerm) return false;
    try {
      var who = userOrId;
      if (!who) { var cu = RAFPerm.currentUser(); who = cu && cu.id; }
      if (!who) return false;
      return RAFPerm.can(who, 'reports.view');
    } catch (e) { return false; }
  }

  /* ---------- change propagation ---------- */
  var watchers = [];
  function emit(ev){
    watchers.forEach(function (fn) { try { fn(ev); } catch (e) {} });
    try { document.dispatchEvent(new CustomEvent('raf:audit', { detail:ev })); } catch (e) {}
  }
  function watch(fn){
    if (typeof fn !== 'function') return function () {};
    watchers.push(fn);
    return function () { watchers = watchers.filter(function (f) { return f !== fn; }); };
  }
  /* another session appended — surface it without re-recording anything */
  global.addEventListener('storage', function (e) { if (e.key === LS) emit(null); });

  global.RAFAudit = {
    ACTOR: ACTOR, SOURCE: SOURCE, ACTIONS: A, MAX: MAX,
    record: record, validate: validate, makeId: makeId, exists: exists,
    forOrder: forOrder, forStore: forStore, query: query, all: function(){ return sorted(readAll()); },
    timeline: timeline, auditLog: auditLog, canViewAudit: canViewAudit, label: label,
    failures: failures, watch: watch
  };
})(window);
