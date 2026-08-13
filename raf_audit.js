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
    /* product management — recorded against the store, not an order */
    'product.updated':      { tl:false, ar:'تم تعديل منتج',               en:'Product updated' },
    'variant.created':      { tl:false, ar:'تمت إضافة خيار للمنتج',       en:'Product option added' },
    'variant.updated':      { tl:false, ar:'تم تعديل خيارات المنتج',      en:'Product options updated' },
    'variant.removed':      { tl:false, ar:'تم حذف خيار من المنتج',       en:'Product option removed' },
    'size_guide.updated':   { tl:false, ar:'تم تعديل دليل المقاسات',      en:'Size guide updated' },
    'image.added':          { tl:false, ar:'تمت إضافة صورة للمنتج',       en:'Product image added' },
    'image.updated':        { tl:false, ar:'تم استبدال صورة المنتج',      en:'Product image replaced' },
    'image.reordered':      { tl:false, ar:'تم إعادة ترتيب صور المنتج',   en:'Product images reordered' },
    'image.removed':        { tl:false, ar:'تم حذف صورة من المنتج',       en:'Product image removed' },
    'main_image.changed':   { tl:false, ar:'تم تغيير الصورة الرئيسية',    en:'Main product image changed' },
    /* inventory */
    'inventory.reserved':      { tl:false, ar:'تم حجز المخزون',            en:'Inventory reserved' },
    'inventory.released':      { tl:false, ar:'تم تحرير المخزون',          en:'Inventory released' },
    'inventory.sale_committed':{ tl:false, ar:'تم اعتماد بيع المخزون',     en:'Inventory sale committed' },
    'inventory.adjusted':      { tl:false, ar:'تم تعديل المخزون يدويًا',   en:'Inventory adjusted' },
    'order.migrated':       { tl:false, ar:'تمت ترقية سجل الطلب',         en:'Order record migrated' }
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }

  /* ══════════════ STORAGE LAYER ══════════════
     Deliberately behind an interface. Capacity is a technical limitation of
     whatever store is plugged in — never a business rule. The engine never
     deletes, trims or overwrites an event to make room: if the store cannot
     accept an event, that is reported as a persistence failure.

     A storage adapter implements:
       name      — identifier for diagnostics
       durable   — true only for a store with unbounded, permanent retention
       read()    — returns the full event array
       append(e) — appends one event; THROWS if it cannot persist

     Swap in a server-backed store with RAFAudit.setStore(adapter). Nothing
     else changes: not the engine, the schema, the Timeline or the Audit Log. */
  var localStore = {
    name: 'localStorage',
    durable: false,                 /* bounded by the browser quota */
    read: function () {
      try { var a = JSON.parse(localStorage.getItem(LS)); return Array.isArray(a) ? a : []; }
      catch (e) { return []; }
    },
    append: function (ev) {
      /* re-read immediately before appending so a concurrent tab is not lost */
      var all = this.read();
      all.push(ev);
      try { localStorage.setItem(LS, JSON.stringify(all)); }
      catch (e) {
        /* quota exhausted, or storage unavailable. Existing history is left
           exactly as it is — nothing is discarded to make space. */
        var err = new Error('persist_failed:' + ((e && e.name) || 'unknown'));
        err.cause = e;
        throw err;
      }
      return ev;
    }
  };
  var store = localStore;
  function setStore(adapter){
    if (!adapter || typeof adapter.read !== 'function' || typeof adapter.append !== 'function') {
      return { ok:false, reason:'invalid_adapter' };
    }
    store = adapter;
    return { ok:true, name:adapter.name || 'custom', durable:!!adapter.durable };
  }
  function storeInfo(){
    return { name:store.name || 'custom', durable:!!store.durable,
             unboundedRetention:!!store.durable };
  }
  function readAll(){
    try { return store.read() || []; } catch (e) { return []; }
  }
  /* An audit failure is recorded for diagnostics — never silently swallowed,
     and never allowed to alter the business result that already happened.
     Mirrored in memory so a diagnostic survives even when the store itself is
     the thing that is full. */
  var failureLog = [];
  function recordFailure(ev, err){
    var entry = { at:Date.now(), eventId:ev && ev.eventId, action:ev && ev.action,
                  orderId:ev && ev.orderId, store:store.name || 'custom',
                  error:String((err && err.message) || err || 'persist_failed') };
    failureLog.unshift(entry);
    if (failureLog.length > 100) failureLog.length = 100;   /* diagnostics only, not audit data */
    try {
      var f = JSON.parse(localStorage.getItem(LS_FAIL) || '[]');
      f.unshift(entry);
      localStorage.setItem(LS_FAIL, JSON.stringify(f.slice(0, 50)));
    } catch (e) { /* storage full — the in-memory mirror still holds it */ }
    return entry;
  }
  function failures(){
    var stored = [];
    try { var f = JSON.parse(localStorage.getItem(LS_FAIL)); if (Array.isArray(f)) stored = f; }
    catch (e) {}
    /* whichever record is richer this session */
    return failureLog.length >= stored.length ? failureLog.slice() : stored;
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

    var all = readAll();
    for (var i = all.length - 1; i >= 0; i--) {
      if (all[i].eventId === ev.eventId) return { ok:true, duplicate:true, event:all[i] };
    }
    ev.seq = (all.length ? (all[all.length - 1].seq || 0) : 0) + 1;

    /* Append only. An undo never touches the event it reverses — it carries
       `undoOf`, and `undone` is derived when the log is read. Nothing already
       written is ever mutated, trimmed or discarded. */
    try {
      store.append(ev);
    } catch (e) {
      var diag = recordFailure(ev, e);
      return { ok:false, reason:'persist_failed', persisted:false, event:ev, diagnostic:diag,
               store:store.name || 'custom' };
    }
    emit(ev);
    return { ok:true, persisted:true, event:ev };
  }

  /* ---------- reading ----------
     Deterministic order: timestamp, then sequence — never insertion order alone. */
  /* `undone` is derived, never stored back onto the original event: an event
     is undone when some later event points at it with undoOf. */
  function withUndone(list, universe){
    var reversed = {};
    (universe || list).forEach(function (e) { if (e.undoOf) reversed[e.undoOf] = true; });
    return list.map(function (e) {
      return reversed[e.eventId] ? Object.assign({}, e, { undone:true }) : e;
    });
  }
  function sorted(list, universe){
    return withUndone(list, universe).sort(function (a, b) {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      if ((a.seq || 0) !== (b.seq || 0))  return (a.seq || 0) - (b.seq || 0);
      return String(a.eventId).localeCompare(String(b.eventId));
    });
  }
  function forOrder(orderId){
    var all = readAll();
    return sorted(all.filter(function (e) { return e.orderId === orderId; }), all);
  }
  /* store isolation is enforced here, by slug only */
  function forStore(slug){
    if (!slug) return [];
    var all = readAll();
    return sorted(all.filter(function (e) { return e.storeSlug === slug; }), all);
  }
  function query(opts){
    opts = opts || {};
    var all = readAll();
    var list = all.filter(function (e) {
      if (opts.storeSlug && e.storeSlug !== opts.storeSlug) return false;
      if (opts.orderId  && e.orderId  !== opts.orderId)  return false;
      if (opts.action   && e.action   !== opts.action)   return false;
      if (opts.actorType&& e.actorType!== opts.actorType)return false;
      if (opts.source   && e.source   !== opts.source)   return false;
      if (opts.automatic != null && !!e.automatic !== !!opts.automatic) return false;
      if (opts.since    && e.timestamp < opts.since)     return false;
      return true;
    });
    return sorted(list, all);
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
    ACTOR: ACTOR, SOURCE: SOURCE, ACTIONS: A,
    record: record, validate: validate, makeId: makeId, exists: exists,
    forOrder: forOrder, forStore: forStore, query: query,
    all: function(){ var a = readAll(); return sorted(a, a); },
    timeline: timeline, auditLog: auditLog, canViewAudit: canViewAudit, label: label,
    failures: failures, watch: watch,
    /* storage layer — swap in a durable store without touching anything else */
    setStore: setStore, storeInfo: storeInfo
  };
})(window);
