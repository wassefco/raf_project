/* ============================================================
   RAF — ORDER ENGINE  (shared, headless)
   ------------------------------------------------------------
   Single source of truth for the order acceptance workflow:
   acceptance · rejection · timeout · countdown · refund ·
   stock restoration · notifications · timeline · order status.

   This logic previously lived inside raf_pending.html, where only
   the customer's own tab could reach it. It has been moved here
   verbatim so the customer, merchant and admin surfaces all drive
   the SAME implementation. No rule changed in the move:

     · the acceptance window is still 5 minutes
     · it is still anchored to a stored deadline, so closing or
       reloading a tab can neither extend nor restart it
     · a decision is still final and taken once (`done` guard)
     · cancelling still sets status `cancelled`, marks the order
       refunded, rewrites the timeline to placed → cancelled,
       returns the reserved units to stock, releases the hold and
       writes a notification

   Headless on purpose: it touches no DOM and renders nothing, so
   any surface can consume it. Views subscribe with watch().

   Depends on (all optional at load, checked at call time):
     RAFShop.Orders · RAFSource · RAFRules.Reserve
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFOrderEngine) return;

  var WINDOW_MS = 5 * 60 * 1000;          /* unchanged: 5-minute acceptance window */
  var LS        = 'raf_pending';          /* unchanged storage key */
  /* customer notifications go through RAFNotify (see notify()) */
  var LS_ORDERS = 'raf_orders';
  var LS_ACCEPT = 'raf_order_accept';     /* unchanged cross-tab accept signal */

  /* how a pending window was closed */
  var DECISION = { ACCEPTED:'accepted', REJECTED:'rejected', TIMEOUT:'timeout', CANCELLED:'cancelled' };
  /* order statuses already used across the marketplace */
  var STATUS   = { PROGRESS:'progress', DELIVERED:'delivered', CANCELLED:'cancelled' };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }

  /* ---------- state ----------
     The window record is { id, deadline, items, done, at }. It used to be a
     single object holding one order; it is now keyed by order id so the
     merchant and admin can see every order awaiting a decision. The old
     single-object shape is migrated on first read, so a customer who was
     mid-countdown when this shipped keeps their exact deadline. */
  function readAll(){
    var raw;
    try { raw = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) { return {}; }
    if (!raw || typeof raw !== 'object') return {};
    if (raw.id && raw.deadline) {                     /* legacy single record */
      var m = {}; m[raw.id] = raw; writeAll(m); return m;
    }
    return raw;
  }
  function writeAll(map){
    try { localStorage.setItem(LS, JSON.stringify(map)); } catch (e) {}
  }
  function get(orderId){
    if (!orderId) return null;
    return readAll()[orderId] || null;
  }
  function save(s){
    if (!s || !s.id) return;
    var m = readAll(); m[s.id] = s; writeAll(m);
  }
  function clear(orderId){
    var m = readAll(); delete m[orderId]; writeAll(m);
  }

  /* ---------- who waits for what ----------
     The 5-minute window is the INSTANT DELIVERY rule only. An order placed
     for the next opening or for a scheduled window has NO acceptance
     deadline (deadline:null) and becomes actionable at the moment it
     committed to — read from its frozen snapshot, never re-derived from the
     store's current schedule. An order with no delivery timing recorded (a
     store without a schedule) keeps the existing 5-minute behaviour. */
  function acceptancePlan(orderId){
    var now = Date.now(), sn = null;
    try { sn = global.RAFOrderSnapshot ? RAFOrderSnapshot.of(orderId) : null; } catch (e) { sn = null; }
    var d = sn && sn.delivery, t = d && d.timing;
    function at(date, time){
      return (global.RAFStoreOps && RAFStoreOps.kuwaitWallMs) ? RAFStoreOps.kuwaitWallMs(date, time) : null;
    }
    if (t === 'next_opening')
      return { timing:t, deadline:null,
               actionableAt:(d.receiveAt && d.receiveAt.date) ? at(d.receiveAt.date, d.receiveAt.time) : null };
    if (t === 'scheduled' && sn.scheduled && sn.scheduled.date)
      return { timing:t, deadline:null, actionableAt:at(sn.scheduled.date, sn.scheduled.from) };
    return { timing:t || null, deadline:now + WINDOW_MS, actionableAt:null };
  }

  /* ---------- opening the window ----------
     Snapshots what was ordered so a cancellation can put the stock back.
     Idempotent: an existing window is never restarted. */
  function start(orderId){
    if (!orderId) return null;
    var existing = get(orderId);
    if (existing) return existing;
    var items = {};
    try {
      var o = global.RAFShop && RAFShop.Orders.get(orderId);
      ((o && o.items) || []).forEach(function (it) {
        if (it.id) items[it.id] = (items[it.id] || 0) + (it.qty || 1);
      });
    } catch (e) {}
    var plan = acceptancePlan(orderId);
    var s = { id:orderId, deadline:plan.deadline, items:items, done:null, at:Date.now(),
              timing:plan.timing, actionableAt:plan.actionableAt };
    save(s);
    emit(orderId, 'started');
    return s;
  }

  /* ---------- countdown ---------- */
  function msLeft(orderId){
    var s = get(orderId);
    if (!s || s.done || s.deadline == null) return 0;
    return Math.max(0, s.deadline - Date.now());
  }
  /* deadline:null means "no acceptance deadline" (next-opening / scheduled):
     still awaiting a decision, and never expiring on its own */
  function isPending(s){ return !!(s && !s.done && (s.deadline == null || s.deadline > Date.now())); }
  function isExpired(s){ return !!(s && !s.done && s.deadline != null && s.deadline <= Date.now()); }
  function hasDeadline(orderId){ var s = get(orderId); return !!(s && s.deadline != null); }
  /* when a not-yet-actionable order becomes actionable (epoch ms), else 0 */
  function waitOf(s){ return (s && !s.done && s.actionableAt && Date.now() < s.actionableAt) ? s.actionableAt : 0; }
  function waitingUntil(orderId){ return waitOf(get(orderId)); }
  /* every order still awaiting a decision, soonest deadline first */
  function pending(){
    var m = readAll(), out = [];
    Object.keys(m).forEach(function (k) { if (isPending(m[k])) out.push(m[k]); });
    return out.sort(function (a, b) {
      var A = a.deadline == null ? Infinity : a.deadline, B = b.deadline == null ? Infinity : b.deadline;
      return A === B ? 0 : (A < B ? -1 : 1);
    });
  }
  /* formatted m:ss, as the pending screen has always shown it */
  function clock(orderId){
    var left = msLeft(orderId);
    var m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
    return m + ':' + (sec < 10 ? '0' : '') + sec;
  }
  /* 0 → 1 elapsed fraction, for progress rings */
  function progress(orderId){
    var s = get(orderId);
    if (!s) return 1;
    if (s.deadline == null) return 0;          /* no countdown to show */
    return 1 - (msLeft(orderId) / WINDOW_MS);
  }

  /* ---------- outcomes ----------
     One guard, one decision: whoever gets there first wins, exactly as
     before. Accept keeps the order moving; reject / cancel / timeout all
     run the identical cancel-and-refund chain. */
  function decide(orderId, decision, why, context){
    var s = get(orderId);
    if (!s || s.done) return false;
    /* a next-opening / scheduled order cannot be accepted or rejected before
       its time — whichever path asks (merchant, cross-tab signal, admin) */
    if ((decision === DECISION.ACCEPTED || decision === DECISION.REJECTED) && waitOf(s)) return false;
    s.done = decision; s.decidedAt = Date.now();
    /* the rejection context becomes part of the committed record here, once,
       guarded by the same `s.done` gate that makes the decision idempotent */
    if (decision === DECISION.REJECTED && context) s.rejection = context;
    save(s);

    if (decision === DECISION.ACCEPTED) {
      setOrderStatus(orderId, STATUS.PROGRESS);
      notify(orderId, acceptedText(orderId, s), 'raf_tracking.html?id=' + encodeURIComponent(orderId), 'order.accepted');
    } else {
      /* the acceptance window closing on its own is a system event, never a
         merchant one */
      if (decision === DECISION.TIMEOUT) {
        audit('system.timeout', orderId, { automatic:true, systemGenerated:true,
          source:'automation', key:s.decidedAt, reason:'acceptance_window_elapsed' });
      }
      if (decision === DECISION.CANCELLED) {
        audit('order.cancelled', orderId, { source:'customer', key:s.decidedAt,
          actor:{ type:'customer' }, reason:'customer_cancelled' });
      }
      cancelAndRefund(orderId, why || decision, decision === DECISION.REJECTED ? (context || null) : null);
    }
    emit(orderId, decision);
    return true;
  }
  function accept(orderId){ return decide(orderId, DECISION.ACCEPTED); }
  /* the merchant declining is the existing cancellation path with its own
     trigger — same status, same refund, same stock restoration */
  function reject(orderId, context){ return decide(orderId, DECISION.REJECTED, 'rejected', context); }
  function cancel(orderId){ return decide(orderId, DECISION.CANCELLED, 'customer'); }
  function timeout(orderId){ return decide(orderId, DECISION.TIMEOUT, 'timeout'); }

  /* mark the order cancelled, restore its stock and record the refund */
  function cancelAndRefund(orderId, why, rejection){
    var st = get(orderId);
    var k = (st && st.decidedAt) || Date.now();
    setOrderStatus(orderId, STATUS.CANCELLED);
    audit('system.cancelled', orderId, { automatic:true, systemGenerated:true, source:'automation',
      key:k, reason:why, previousState:null, newState:STATUS.CANCELLED,
      metadata: rejection ? { rejection:rejection } : null });
    var rel = restoreStock(orderId, why);
    /* only report a restoration that actually happened */
    if (rel && rel.ok && !rel.alreadyApplied) {
      audit('system.stock_restored', orderId, { automatic:true, systemGenerated:true, source:'automation',
        key:k, metadata:{ items:rel.released || null } });
    }
    audit('system.refunded', orderId, { automatic:true, systemGenerated:true, source:'automation',
      key:k, reason:why });
    if (global.RAFRules) { try { RAFRules.Reserve.release(); } catch (e) {} }
    /* the refund wording states the expected processing period, never a
       guaranteed settlement date from the card provider */
    /* same wording as before, now kept in both languages */
    var msg;
    if (rejection) {
      var ct = customerRejectionText(rejection);
      msg = { ar:ct.ar + ' ' + REFUND_DAYS_TEXT.ar, en:ct.en + ' ' + REFUND_DAYS_TEXT.en };
    } else if (why === 'timeout') {
      msg = { ar:'تم إلغاء الطلب ' + orderId + ' تلقائياً وإعادة المبلغ. ' + REFUND_DAYS_TEXT.ar,
              en:'Order ' + orderId + ' was auto-cancelled and refunded. ' + REFUND_DAYS_TEXT.en };
    } else {
      msg = { ar:'تم إلغاء الطلب ' + orderId + ' وإعادة المبلغ. ' + REFUND_DAYS_TEXT.ar,
              en:'Order ' + orderId + ' was cancelled and refunded. ' + REFUND_DAYS_TEXT.en };
    }
    notify(orderId, msg, 'raf_order_details.html?id=' + encodeURIComponent(orderId), 'order.cancelled');
  }

  /* ---------- order status + timeline ---------- */
  function setOrderStatus(orderId, st){
    if (!global.RAFShop) return;
    try {
      var all = RAFShop.Orders.all();
      var i = all.findIndex(function (o) { return o.id === orderId; });
      if (i < 0) return;
      all[i].status = st;
      if (st === STATUS.CANCELLED) {
        all[i].refunded = true;
        all[i].tl = [{ k:'placed', t:{ ar:'تم استلام الطلب', en:'Order placed' }, time:all[i].date, s:'done' },
                     { k:'cancel', t:{ ar:'أُلغي الطلب وأُعيد المبلغ', en:'Cancelled and refunded' }, time:RAFShop.nowStr(), s:'cancel' }];
      }
      localStorage.setItem(LS_ORDERS, JSON.stringify(all));
    } catch (e) {}
  }

  /* a cancelled order returns its units to the shelf */
  /* PHASE 3.4 — inventory is owned by RAFInventory. Restoration is now keyed
     to the order, which makes it idempotent (a second call is a no-op) and
     releasable from any session, including a merchant's. The old per-session,
     non-idempotent path is gone. */
  function restoreStock(orderId, reason, actor){
    if (global.RAFInventory) return RAFInventory.releaseForOrder(orderId, reason || 'order_cancelled', actor);
    return { ok:false, code:'NO_INVENTORY' };
  }

  /* surface the outcome in the notification centre — through RAFNotify, the
     single notification authority. The recipient is the customer on the
     order's own snapshot, never an id a caller supplies. A guest order has no
     account to notify, so no notification is created for it. The legacy key
     'raf_notif_extra' is no longer written (RAFNotify still reads it). */
  function notify(orderId, text, href, eventType){
    try {
      var owner = null;
      try { var sn = global.RAFOrderSnapshot ? RAFOrderSnapshot.of(orderId) : null;
            owner = (sn && sn.customer && sn.customer.id) || null; } catch (e2) { owner = null; }
      if (!owner || !global.RAFNotify || !RAFNotify.create) return null;
      var t = (text && typeof text === 'object') ? { ar:String(text.ar), en:String(text.en) } : { ar:String(text), en:String(text) };
      return RAFNotify.create({ recipientUserId:owner, eventType:eventType || 'order.change', title:t,
        entityType:'order', entityId:orderId, href:href || null, source:'system' });
    } catch (e) { return null; }
  }
  /* the customer's acceptance message. Instant keeps its existing wording; a
     next-opening or scheduled order is told plainly, and a scheduled one is
     reminded of the delivery commitment frozen in its snapshot */
  function acceptedText(orderId, s){
    if (!s || (s.timing !== 'next_opening' && s.timing !== 'scheduled'))
      return { ar:'قبل المتجر طلبك ' + orderId, en:'Store accepted order ' + orderId };
    var ar = 'تم قبول طلبك ' + orderId + '.', en = 'Your order ' + orderId + ' has been accepted.';
    if (s.timing === 'scheduled' && global.RAFStoreSchedule && global.RAFOrderSnapshot) {
      try {
        var sn = RAFOrderSnapshot.of(orderId);
        var cAr = RAFStoreSchedule.formatCommitment(sn, 'ar'), cEn = RAFStoreSchedule.formatCommitment(sn, 'en');
        if (cAr) ar += ' ' + cAr;
        if (cEn) en += ' ' + cEn;
      } catch (e) {}
    }
    return { ar:ar, en:en };
  }

  /* ══════════════════════════════════════════════════════════════
     MERCHANT ORDER PROCESSING
     ------------------------------------------------------------
     The merchant's own workflow, living in the same shared engine as
     the acceptance window so no surface has to reimplement it:

       pending → accepted → preparing → ready → waiting driver

     Merchant actions are Accept, Reject and Ready only. Each one takes
     effect immediately and opens a 10-second undo window; the
     irreversible consequences (refund, stock restoration, customer
     notification) run when that window commits, so an undo never has
     to unwind money or inventory. There are no confirmation dialogs.
     ══════════════════════════════════════════════════════════════ */
  var MSTATE   = { PENDING:'pending', ACCEPTED:'accepted', PREPARING:'preparing',
                   READY:'ready', WAITING_DRIVER:'waiting_driver' };
  var ACTION   = { ACCEPT:'accept', REJECT:'reject', READY:'ready' };
  var UNDO_MS  = 10 * 1000;
  var LOCK_HEARTBEAT_MS = 10 * 1000;
  var LOCK_STALE_MS     = 60 * 1000;
  var LS_MSTATE = 'raf_order_mstate';
  var LS_LOCKS  = 'raf_order_locks';
  var LS_UNDO   = 'raf_order_undo';

  /* ---------- audit bridge ----------
     The engine performs the action; RAFAudit records it. Audit is never
     allowed to change or roll back a business result that already happened,
     so every call is fire-and-forget and failures are swallowed here (the
     audit engine records them for diagnostics itself). */
  function audit(action, orderId, opts){
    if (!global.RAFAudit) return null;
    try {
      var o = opts || {};
      o.action = action; o.orderId = orderId;
      return RAFAudit.record(o);
    } catch (e) { return null; }
  }

  function readJSON(k, dflt){
    try { var v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : dflt; }
    catch (e) { return dflt; }
  }
  function writeJSON(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  /* ---------- merchant state ---------- */
  function mstateAll(){ return readJSON(LS_MSTATE, {}); }
  function mstate(orderId){
    var rec = mstateAll()[orderId];
    if (rec && rec.state) return rec.state;
    /* an order still inside its acceptance window has not been acted on yet */
    if (isPending(get(orderId))) return MSTATE.PENDING;
    return null;
  }
  function mrecord(orderId){ return mstateAll()[orderId] || null; }
  function setMState(orderId, state, actor){
    var all = mstateAll();
    all[orderId] = { state:state, at:Date.now(), by:(actor && actor.id) || null, byName:(actor && actor.name) || null };
    writeJSON(LS_MSTATE, all);
    emit(orderId, 'mstate');
  }

  /* ---------- timeline ---------- */
  function appendTimeline(orderId, key, ar, en, status){
    if (!global.RAFShop) return;
    try {
      var all = RAFShop.Orders.all();
      var i = all.findIndex(function (o) { return o.id === orderId; });
      if (i < 0) return;
      all[i].tl = (all[i].tl || []).filter(function (t) { return t.k !== key; });
      all[i].tl.push({ k:key, t:{ ar:ar, en:en }, time:RAFShop.nowStr(), s:status || 'done' });
      localStorage.setItem(LS_ORDERS, JSON.stringify(all));
    } catch (e) {}
  }
  function dropTimeline(orderId, key){
    if (!global.RAFShop) return;
    try {
      var all = RAFShop.Orders.all();
      var i = all.findIndex(function (o) { return o.id === orderId; });
      if (i < 0) return;
      all[i].tl = (all[i].tl || []).filter(function (t) { return t.k !== key; });
      localStorage.setItem(LS_ORDERS, JSON.stringify(all));
    } catch (e) {}
  }

  /* ---------- undo window ----------
     One open window per order. The action is already visible; only its
     irreversible tail is held back until the window commits. */
  function undoAll(){ return readJSON(LS_UNDO, {}); }
  function undoOf(orderId){
    var u = undoAll()[orderId];
    if (!u) return null;
    if (Date.now() - u.at >= UNDO_MS) return null;
    return u;
  }
  function undoMsLeft(orderId){
    var u = undoOf(orderId);
    return u ? Math.max(0, UNDO_MS - (Date.now() - u.at)) : 0;
  }
  function openUndo(orderId, action, prevState, actor, context){
    var all = undoAll();
    var cur = mstateAll()[orderId];
    all[orderId] = { action:action, prev:prevState || null, at:Date.now(),
                     /* the validated rejection decision rides along with the
                        pending action and only becomes real at commit */
                     rejection: context || null,
                     /* the state timestamp the action's audit event was keyed on,
                        so an undo can point back at exactly that event */
                     actionAt: cur ? cur.at : null,
                     by:(actor && actor.id) || null, byName:(actor && actor.name) || null };
    writeJSON(LS_UNDO, all);
  }
  function clearUndo(orderId){
    var all = undoAll(); delete all[orderId]; writeJSON(LS_UNDO, all);
  }
  /* the window elapsed: run the consequences exactly once */
  function commitUndo(orderId){
    var all = undoAll(), u = all[orderId];
    if (!u) return false;
    delete all[orderId]; writeJSON(LS_UNDO, all);
    if (u.action === ACTION.ACCEPT)      accept(orderId);              /* existing chain */
    else if (u.action === ACTION.REJECT) reject(orderId, u.rejection); /* existing chain */
    /* READY has no engine-level consequence beyond the state already applied */
    emit(orderId, 'commit');
    return true;
  }
  function undo(orderId){
    var all = undoAll(), u = all[orderId];
    if (!u) return false;
    delete all[orderId]; writeJSON(LS_UNDO, all);
    /* put the merchant state back exactly as it was */
    var st = mstateAll();
    if (u.prev) st[orderId] = u.prev; else delete st[orderId];
    writeJSON(LS_MSTATE, st);
    if (u.action === ACTION.ACCEPT){ dropTimeline(orderId, 'm-accept'); }
    if (u.action === ACTION.REJECT){ dropTimeline(orderId, 'm-reject'); }
    if (u.action === ACTION.READY) { dropTimeline(orderId, 'm-ready'); dropTimeline(orderId, 'm-waiting-driver'); }
    /* the undo is appended as its own event and points back at the original;
       neither is ever removed from the audit log */
    if (global.RAFAudit){
      var origAction = u.action === ACTION.ACCEPT ? 'order.accept'
                     : u.action === ACTION.REJECT ? 'order.reject' : 'order.ready';
      var origId = RAFAudit.makeId(origAction, orderId, u.actionAt);
      audit('order.undo', orderId, { actor:{ id:u.by, name:u.byName }, source:'merchant',
        key:u.at, undoOf:origId, reason:'merchant_undo',
        previousState: u.action === ACTION.ACCEPT ? MSTATE.PREPARING
                     : u.action === ACTION.REJECT ? 'rejected' : MSTATE.READY,
        newState: (u.prev && u.prev.state) || MSTATE.PENDING,
        metadata:{ of:origAction } });
    }
    emit(orderId, 'undo');
    return true;
  }
  function sweepUndo(){
    var all = undoAll(), now = Date.now(), fired = false;
    Object.keys(all).forEach(function (k) {
      if (now - all[k].at >= UNDO_MS) { commitUndo(k); fired = true; }
    });
    return fired;
  }

  /* ---------- merchant actions ----------
     Guarded so the same action can never run twice and two employees can
     never both process one order. */
  function actionable(orderId, actor){
    if (!canProcess(orderId, actor)) return { ok:false, reason:'locked' };
    if (undoOf(orderId))             return { ok:false, reason:'in_undo_window' };
    return { ok:true };
  }
  /* a next-opening / scheduled order before its time */
  var NOT_YET = { ar:'لم يحن وقت معالجة هذا الطلب بعد.', en:'This order cannot be processed yet.' };
  function notYet(orderId){
    return { ok:false, reason:'not_yet_actionable', code:'NOT_YET_ACTIONABLE',
             actionableAt:waitingUntil(orderId), message:T(NOT_YET.ar, NOT_YET.en) };
  }
  function merchantAccept(orderId, actor){
    var auth = processGuard(orderId, actor); if (!auth.ok) return auth;
    var g = actionable(orderId, actor); if (!g.ok) return g;
    if (mstate(orderId) !== MSTATE.PENDING) return { ok:false, reason:'not_pending' };
    if (waitingUntil(orderId)) return notYet(orderId);
    var prev = mrecord(orderId);
    setMState(orderId, MSTATE.PREPARING, actor);
    appendTimeline(orderId, 'm-accept', 'قبل المتجر الطلب', 'Store accepted the order');
    openUndo(orderId, ACTION.ACCEPT, prev, actor);
    audit('order.accept', orderId, { actor:actor, source:'merchant', reversible:true,
      key:(mrecord(orderId) || {}).at, previousState:MSTATE.PENDING, newState:MSTATE.PREPARING });
    /* the Promised ETA becomes historical fact here, with the configuration as
       it stands now; later configuration changes affect later orders only */
    recordPromise(orderId, actor);
    return { ok:true, undoMs:UNDO_MS };
  }
  /* ---------- GROUP B · rejection reasons ----------
     A rejection is never a bare state change: the merchant states why, and
     that statement travels with the decision through the existing chain.
     The reasons are a closed list — the merchant picks one, never writes one,
     except for the explicit "other" case which demands an explanation. */
  var REJECT_REASONS = [
    { id:'product_unavailable',  ar:'المنتج غير متوفر',                 en:'Product unavailable',              needsItems:true },
    { id:'quantity_unavailable', ar:'الكمية المطلوبة غير متوفرة',       en:'Requested quantity unavailable' },
    { id:'cannot_prepare',       ar:'المتجر غير قادر على تجهيز الطلب',  en:'Store unable to prepare the order' },
    { id:'product_issue',        ar:'مشكلة في المنتج',                  en:'Product issue' },
    { id:'order_issue',          ar:'مشكلة في الطلب',                   en:'Order issue' },
    { id:'store_operational',    ar:'مشكلة تشغيلية في المتجر',          en:'Store operational issue' },
    { id:'other',                ar:'سبب آخر',                          en:'Other', needsExplanation:true }
  ];
  var EXPLANATION_MAX = 280;
  var REFUND_DAYS_TEXT = { ar:'قد يستغرق استرداد المبلغ حتى 7 أيام عمل.',
                           en:'Refunds may take up to 7 business days.' };

  function reasonById(id){
    for (var i = 0; i < REJECT_REASONS.length; i++) if (REJECT_REASONS[i].id === id) return REJECT_REASONS[i];
    return null;
  }
  /* typed validation failures, each with the wording the merchant sees */
  var REJECT_ERRORS = {
    INVALID_REJECTION_REASON:      { ar:'يرجى اختيار سبب الرفض.',              en:'Please select a rejection reason.' },
    UNAVAILABLE_PRODUCT_REQUIRED:  { ar:'يرجى تحديد المنتج غير المتوفر.',      en:'Please select the unavailable product.' },
    REJECTION_EXPLANATION_REQUIRED:{ ar:'يرجى كتابة سبب الرفض.',              en:'Please write the rejection reason.' },
    INVALID_REJECTION_ITEM:        { ar:'المنتج المحدد ليس ضمن هذا الطلب.',    en:'The selected product is not part of this order.' },
    CROSS_STORE:                   { ar:'هذا الطلب لا يخص متجرك.',            en:'This order does not belong to your store.' },
    FORBIDDEN:                     { ar:'ليس لديك صلاحية معالجة الطلبات.',     en:'You do not have permission to process orders.' },
    LOCKED:                        { ar:'موظف آخر يعالج هذا الطلب حالياً.',    en:'Another employee is processing this order.' }
  };
  function rejectError(code, extra){
    var m = REJECT_ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, reason:code, ar:m.ar, en:m.en, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* the order's authoritative item list — the snapshot, never the catalogue */
  function snapItems(orderId){
    if (!global.RAFOrderSnapshot) return null;
    var s = null; try { s = RAFOrderSnapshot.of(orderId); } catch (e) { return null; }
    return (s && s.items) ? s.items : null;
  }
  function snapSlug(orderId){
    if (!global.RAFOrderSnapshot) return null;
    try { return RAFOrderSnapshot.storeSlugOf(orderId) || null; } catch (e) { return null; }
  }

  /* Validate a rejection before anything at all is written. Order of checks
     matters: authorisation and ownership first, then business validation, so
     a validation failure is never reported as a permission failure. */
  function validateRejection(orderId, context, actor){
    if (!actor || !actor.id) return rejectError('FORBIDDEN');
    /* fails closed: without the permission authority present there is nothing
       to authorise against, and an unauthorised rejection is the worse error */
    var allowed = false;
    try { allowed = !!(global.RAFPerm && RAFPerm.can(actor.id, 'orders.manage')); } catch (e) { allowed = false; }
    if (!allowed) return rejectError('FORBIDDEN');

    /* ownership is proven from the canonical storeSlug on both sides, or the
       action is refused — an unprovable link is never treated as a match.
       The actor's store comes from the permission authority, never the caller. */
    var mine = actorStoreOf(actor), theirs = snapSlug(orderId);
    if (!mine || !theirs || mine !== theirs) return rejectError('CROSS_STORE', { actorStore:mine, orderStore:theirs });

    var l = lockOf(orderId);
    if (l && l.userId !== actor.id) return rejectError('LOCKED', { lockedBy:l.name || l.userId });

    var ctx = context || {};
    var r = reasonById(ctx.reasonId);
    if (!r) return rejectError('INVALID_REJECTION_REASON');

    var explanation = null;
    if (r.needsExplanation) {
      explanation = String(ctx.explanation == null ? '' : ctx.explanation).trim();
      if (!explanation) return rejectError('REJECTION_EXPLANATION_REQUIRED');
      explanation = explanation.slice(0, EXPLANATION_MAX);
    }

    var items = [];
    if (r.needsItems) {
      var lines = snapItems(orderId);
      if (!lines || !lines.length) return rejectError('INVALID_REJECTION_ITEM', { reason:'order_items_unavailable' });
      var picked = ctx.items || [];
      if (!picked.length) return rejectError('UNAVAILABLE_PRODUCT_REQUIRED');
      var seen = {};
      for (var i = 0; i < picked.length; i++) {
        var ix = picked[i];
        /* the line index in the order's own snapshot is the item identity —
           no name matching, no catalogue lookup */
        if (typeof ix !== 'number' || ix !== Math.floor(ix) || ix < 0 || ix >= lines.length)
          return rejectError('INVALID_REJECTION_ITEM', { index:ix });
        if (seen[ix]) continue;
        seen[ix] = 1;
        var it = lines[ix];
        items.push({ lineIndex:ix, productId:it.productId || null, variantId:it.variantId || null,
                     nameAr:it.nameAr || '', nameEn:it.nameEn || '', qty:it.qty || null,
                     size:it.size || null, color:it.color || null });
      }
      if (!items.length) return rejectError('UNAVAILABLE_PRODUCT_REQUIRED');
    }

    return { ok:true, context:{
      reasonId:r.id, reasonAr:r.ar, reasonEn:r.en,
      explanation:explanation, items:items,
      by:actor.id, byName:actor.name || actor.id, at:Date.now()
    } };
  }

  /* what the customer is told — reason in plain language, never internals */
  function customerRejectionText(ctx){
    if (!ctx || !ctx.reasonId) return { ar:'تم رفض طلبك من المتجر.', en:'Your order has been rejected by the store.' };
    if (ctx.reasonId === 'product_unavailable') {
      var names = (ctx.items || []);
      if (names.length) {
        return { ar:'تم رفض طلبك لأن بعض المنتجات غير متوفرة: ' + names.map(function(i){ return i.nameAr || i.nameEn; }).join('، ') + '.',
                 en:'Your order was rejected because some products are unavailable: ' + names.map(function(i){ return i.nameEn || i.nameAr; }).join(', ') + '.' };
      }
      return { ar:'تم رفض طلبك لأن بعض المنتجات غير متوفرة.', en:'Your order was rejected because some products are unavailable.' };
    }
    /* a free-text merchant explanation is internal — the customer gets the
       generic wording rather than text that was never written for them */
    if (ctx.reasonId === 'other') return { ar:'تم رفض طلبك من المتجر.', en:'Your order has been rejected by the store.' };
    return { ar:'تم رفض طلبك من المتجر: ' + ctx.reasonAr + '.',
             en:'Your order has been rejected by the store: ' + ctx.reasonEn + '.' };
  }
  /* the rejection context of a committed decision, or null */
  function rejectionOf(orderId){
    var s = get(orderId);
    return (s && s.done === DECISION.REJECTED && s.rejection) ? s.rejection : null;
  }

  /* M-03 — Accept and Ready are authoritative operations, so the engine
     proves the actor may perform them. It previously trusted the merchant
     page, which meant a direct API call bypassed every check. Reject already
     did this (Group B); this is the same gate, reused, not a second one. */
  /* the acting account's store, from its stored link — by id only */
  function actorStoreOf(actor){
    if (!actor || !actor.id || !global.RAFPerm) return null;
    try { return RAFPerm.storeSlugOf(actor.id) || null; } catch (e) { return null; }
  }
  function processGuard(orderId, actor){
    if (!actor || !actor.id) return rejectError('FORBIDDEN');
    var allowed = false;
    try { allowed = !!(global.RAFPerm && RAFPerm.can(actor.id, 'orders.manage')); } catch (e) { allowed = false; }
    if (!allowed) return rejectError('FORBIDDEN');

    /* ownership is proven from the canonical storeSlug on both sides. The
       actor's store is resolved from the permission authority by id — a store
       written onto the actor object by the caller is never trusted. */
    var mine = actorStoreOf(actor), theirs = snapSlug(orderId);
    if (!mine || !theirs || mine !== theirs) return rejectError('CROSS_STORE', { actorStore:mine, orderStore:theirs });

    var l = lockOf(orderId);
    if (l && l.userId !== actor.id) return rejectError('LOCKED', { lockedBy:l.name || l.userId });
    return { ok:true };
  }

  function merchantReject(orderId, actor, context){
    var g = actionable(orderId, actor);
    /* the shared guard reports a lock in the engine's older shape; a rejection
       reports it as a typed error so every caller gets one vocabulary */
    if (!g.ok && g.reason === 'locked') {
      var l = lockOf(orderId);
      return rejectError('LOCKED', { lockedBy:(l && (l.name || l.userId)) || null });
    }
    if (!g.ok) return g;
    if (mstate(orderId) !== MSTATE.PENDING) return { ok:false, reason:'not_pending' };
    if (waitingUntil(orderId)) return notYet(orderId);
    var v = validateRejection(orderId, context, actor); if (!v.ok) return v;
    var ctx = v.context;
    var prev = mrecord(orderId);
    setMState(orderId, 'rejected', actor);
    appendTimeline(orderId, 'm-reject', 'اعتذر المتجر عن الطلب', 'Store declined the order', 'cancel');
    openUndo(orderId, ACTION.REJECT, prev, actor, ctx);
    audit('order.reject', orderId, { actor:actor, source:'merchant', reversible:true,
      key:(mrecord(orderId) || {}).at, previousState:MSTATE.PENDING, newState:'rejected',
      reason:ctx.reasonId, metadata:{ rejection:ctx } });
    return { ok:true, undoMs:UNDO_MS, rejection:ctx };
  }
  function merchantReady(orderId, actor){
    var auth = processGuard(orderId, actor); if (!auth.ok) return auth;
    var g = actionable(orderId, actor); if (!g.ok) return g;
    var cur = mstate(orderId);
    if (cur !== MSTATE.PREPARING && cur !== MSTATE.ACCEPTED) return { ok:false, reason:'not_preparing' };
    /* the store's work cannot be declared finished while the customer still
       owes an answer on a change to that very order */
    if (global.RAFOrderChanges && RAFOrderChanges.hasPending(orderId)) {
      return { ok:false, reason:'awaiting_customer_approval',
               message:T('بانتظار موافقة العميل على التعديل المقترح',
                         'Waiting for the customer to approve the proposed change') };
    }
    var prev = mrecord(orderId);
    /* READY is a real, persistent state. The merchant's work ends here; the
       driver workflow owns everything after it (Ready → Waiting Driver →
       pickup). Nothing advances the order on the merchant's behalf. */
    setMState(orderId, MSTATE.READY, actor);
    appendTimeline(orderId, 'm-ready', 'الطلب جاهز', 'Order ready');
    openUndo(orderId, ACTION.READY, prev, actor);
    audit('order.ready', orderId, { actor:actor, source:'merchant', reversible:true,
      key:(mrecord(orderId) || {}).at, previousState:cur, newState:MSTATE.READY });
    return { ok:true, undoMs:UNDO_MS };
  }
  /* Driver workflow hook: the order has a driver on the way. Out of scope for
     the merchant phases, exposed so the driver module never has to reach into
     merchant state itself. */
  /* ctx (optional): { via:'dispatch', metadata } — a Logistics employee
     assigned the order to a driver instead of a driver claiming it. The state
     transition is the same one; only the recorded action and the neutral
     timeline wording differ, so one business action leaves one audit event
     ('dispatch.assigned' instead of 'driver.assigned'). The caller (RAFDriver)
     has already proved the staff session, the lock and the target driver. */
  function driverAssigned(orderId, actor, ctx){
    if (mstate(orderId) !== MSTATE.READY) return { ok:false, reason:'not_ready' };
    var dispatch = !!(ctx && ctx.via === 'dispatch');
    /* NOTE ON NAMING: the stored state WAITING_DRIVER ('waiting_driver') is
       entered when a driver CLAIMS the order and kept through pickup, so it
       means "a driver has it". It is not renamed here (stored data); every
       surface labels it by that meaning, never as "waiting for a driver". */
    setMState(orderId, MSTATE.WAITING_DRIVER, actor);
    if (dispatch) {
      appendTimeline(orderId, 'm-waiting-driver', 'تم إسناد الطلب إلى سائق', 'A driver was assigned to the order', 'active');
      audit('dispatch.assigned', orderId, { actor:actor, source:'admin',
        key:(mrecord(orderId) || {}).at, previousState:MSTATE.READY, newState:MSTATE.WAITING_DRIVER,
        metadata:(ctx.metadata && typeof ctx.metadata === 'object') ? ctx.metadata : null });
    } else {
      appendTimeline(orderId, 'm-waiting-driver', 'سحب السائق الطلب', 'A driver took the order', 'active');
      audit('driver.assigned', orderId, { actor:actor, source:'driver',
        key:(mrecord(orderId) || {}).at, previousState:MSTATE.READY, newState:MSTATE.WAITING_DRIVER });
    }
    return { ok:true };
  }
  /* The reverse of driverAssigned: the order returns to Ready, exactly where
     the merchant left it, and becomes available to the pool again. The
     merchant's work is not reopened and nothing commercial is touched — only
     the delivery-side claim is undone. Refused once the order has been picked
     up. INTERNAL PRIMITIVE: drivers no longer return deliveries directly (that
     action was removed from RAFDriver and the Driver App); it is kept only for
     the future ownership-transfer / reassignment flow, which must prove its
     own authority before calling it. */
  /* ctx (optional): { via:'return_to_pool', metadata } — Phase D: a Logistics
     employee returned the delivery to the pool (RAFDriver proved the staff
     session, the lock and the reason first). Same transition; the action is
     recorded as 'dispatch.returned_to_pool' and the customer-visible timeline
     line is neutral — no internal reason, no staff identity. Pickup (if it
     happened) is not undone: the engine keeps no pickup flag of its own and
     the snapshot keeps fulfilment.pickedUpAt. */
  function driverUnassigned(orderId, actor, ctx){
    if (mstate(orderId) !== MSTATE.WAITING_DRIVER) return { ok:false, reason:'not_assigned' };
    var ret = !!(ctx && ctx.via === 'return_to_pool');
    setMState(orderId, MSTATE.READY, actor);
    /* the assignment line goes with the assignment it described, and only the
       latest hand-back is kept: an order that is taken and returned several
       times leaves one line, not a growing stack of identical ones */
    dropTimeline(orderId, 'm-waiting-driver');
    dropTimeline(orderId, 'm-returned');
    var a;
    if (ret) {
      appendTimeline(orderId, 'm-returned', 'الطلب بانتظار سائق', 'The order is waiting for a driver');
      a = audit('dispatch.returned_to_pool', orderId, { actor:actor, source:'admin',
        key:(mrecord(orderId) || {}).at, previousState:MSTATE.WAITING_DRIVER, newState:MSTATE.READY,
        reason:ctx.reason || null,
        metadata:(ctx.metadata && typeof ctx.metadata === 'object') ? ctx.metadata : null });
    } else {
      appendTimeline(orderId, 'm-returned', 'أعاد السائق الطلب إلى قائمة الطلبات المتاحة',
                     'Driver returned the order to the available pool');
      a = audit('driver.returned', orderId, { actor:actor, source:'driver',
        key:Date.now(), previousState:MSTATE.WAITING_DRIVER, newState:MSTATE.READY });
    }
    emit(orderId, 'returned');
    return { ok:true, state:MSTATE.READY, auditEventId:(a && a.event && a.event.eventId) || null };
  }
  /* after Ready the merchant has no further processing actions */
  function merchantDone(orderId){
    var s = mstate(orderId);
    return s === MSTATE.READY || s === MSTATE.WAITING_DRIVER || s === 'rejected';
  }

  /* ---------- merchant queue group ----------
     The one placement of an order (a RAFOrderSnapshot record) into the
     merchant's queue groups, read by the Orders page and the Dashboard so
     the two can never disagree. Every order lands in exactly one group:
     the first match wins. A scheduled order waits under Scheduled until its
     window begins; from then on it is an ordinary order awaiting a decision. */
  function queueOf(o){
    if (!o || !o.id) return null;
    var OPS = global.RAFStoreOps;
    if (OPS && OPS.isScheduled(o) && (!get(o.id) || waitingUntil(o.id))) return 'scheduled';
    var m = mstate(o.id);
    if (m === MSTATE.WAITING_DRIVER) return 'driver';
    if (m === MSTATE.READY)          return 'ready';
    if (m === MSTATE.PREPARING || m === MSTATE.ACCEPTED) return 'preparing';
    if (m === 'rejected')            return 'cancelled';
    if (m === MSTATE.PENDING)        return 'pending';
    if (o.status === 'cancelled') return 'cancelled';
    if (o.status === 'delivered') return 'done';
    return 'preparing';
  }

  /* ---------- driver recovery ----------
     A real-world pickup always outranks whatever the UI managed to record.
     If Ready never landed, it is completed automatically and the recovery
     is written into the timeline. */
  function driverPickedUp(orderId, actor){
    var cur = mstate(orderId);
    /* Ready was never recorded — a crash, a lost connection, a refresh.
       Complete it automatically and say so in the timeline. */
    var recovered = (cur !== MSTATE.READY && cur !== MSTATE.WAITING_DRIVER);
    if (recovered){
      clearUndo(orderId);
      appendTimeline(orderId, 'm-ready', 'الطلب جاهز', 'Order ready');
      appendTimeline(orderId, 'm-auto-recovery',
        'اكتمل "جاهز" تلقائياً بعد استلام السائق', 'Ready auto-completed after driver pickup');
    }
    setMState(orderId, MSTATE.WAITING_DRIVER, actor);
    appendTimeline(orderId, 'm-picked-up', 'استلم السائق الطلب', 'Driver picked up the order');
    var k = (mrecord(orderId) || {}).at;
    /* the recovery is recorded as automatic, never as a merchant action */
    if (recovered) audit('driver.pickup_recovery', orderId, { automatic:true, systemGenerated:true,
      source:'automation', key:k, previousState:cur, newState:MSTATE.READY,
      reason:'ready_not_recorded_before_pickup' });
    audit('driver.pickup', orderId, { actor:actor, source:'driver', key:k,
      previousState:recovered ? MSTATE.READY : cur, newState:MSTATE.WAITING_DRIVER });
    emit(orderId, 'pickup');
    return true;
  }
  /* ---------- delivery completion ----------
     The transition the delivery workflow was missing: the order leaves the
     live queue and becomes a delivered order. It is the engine's decision, so
     no surface writes an order status itself.

     The merchant's boundary is unchanged — Ready already ended the store's
     responsibility — so this does not reopen anything on the merchant side;
     it closes the order the customer is waiting for. WHO may call it (the
     driver holding the order) is proved by the driver authority before it
     gets here, exactly as the merchant actions are guarded by theirs.

     Guarded, idempotent and honest about refusing: an order that was never
     picked up, or is already delivered or cancelled, is refused rather than
     forced. */
  function driverDelivered(orderId, actor){
    var all = global.RAFShop ? RAFShop.Orders.all() : [];
    var o = all.filter(function (x) { return x.id === orderId; })[0];
    if (!o) return { ok:false, reason:'order_not_found' };
    if (o.status === STATUS.DELIVERED) return { ok:false, reason:'already_delivered' };
    if (o.status === STATUS.CANCELLED) return { ok:false, reason:'order_cancelled' };
    var cur = mstate(orderId);
    if (cur !== MSTATE.WAITING_DRIVER) return { ok:false, reason:'not_with_driver' };

    setOrderStatus(orderId, STATUS.DELIVERED);
    appendTimeline(orderId, 'm-delivered', 'تم تسليم الطلب للعميل', 'Order delivered to the customer', 'done');
    audit('driver.delivered', orderId, { actor:actor, source:'driver',
      key:(mrecord(orderId) || {}).at, previousState:cur, newState:STATUS.DELIVERED });
    /* the customer hears it through the same notification path every other
       order event uses — no second notification system */
    notify(orderId, { ar:'تم تسليم طلبك ' + orderId, en:'Your order ' + orderId + ' has been delivered' },
           'raf_tracking.html?id=' + encodeURIComponent(orderId), 'order.delivered');
    emit(orderId, 'delivered');
    return { ok:true, status:STATUS.DELIVERED };
  }

  /* ---------- smart order lock ----------
     One employee processes an order at a time. The lock lives in shared
     storage and is kept alive by a heartbeat, so it survives a closed
     drawer, a refresh or a closed browser, and releases itself when the
     heartbeat has been silent for a minute. */
  function locksAll(){ return readJSON(LS_LOCKS, {}); }
  function lockOf(orderId){
    var l = locksAll()[orderId];
    if (!l) return null;
    if (Date.now() - l.ts > LOCK_STALE_MS) return null;   /* heartbeat lost */
    return l;
  }
  function acquireLock(orderId, actor){
    if (!orderId || !actor) return false;
    var l = lockOf(orderId);
    if (l && l.userId !== actor.id) return false;         /* someone else holds it */
    var fresh = !l;                                       /* a genuine new claim */
    var all = locksAll();
    var since = (all[orderId] && all[orderId].userId === actor.id && all[orderId].since) || Date.now();
    all[orderId] = { userId:actor.id, name:actor.name || actor.id, ts:Date.now(), since:since };
    writeJSON(LS_LOCKS, all);
    /* keyed on the claim, so refreshing or reclaiming does not log again */
    if (fresh) audit('lock.acquired', orderId, { actor:actor, source:'merchant', key:actor.id + ':' + since });
    emit(orderId, 'lock');
    return true;
  }
  function heartbeat(orderId, actor){
    var all = locksAll(), l = all[orderId];
    if (!l || !actor || l.userId !== actor.id) return false;
    l.ts = Date.now(); writeJSON(LS_LOCKS, all);
    return true;
  }
  function releaseLock(orderId, actor){
    var all = locksAll(), l = all[orderId];
    if (!l) return false;
    if (actor && l.userId !== actor.id) return false;
    delete all[orderId]; writeJSON(LS_LOCKS, all);
    audit('lock.released', orderId, { actor:actor, source:'merchant', key:l.since || l.ts });
    emit(orderId, 'lock');
    return true;
  }
  /* an override discards another holder's lock — permitted for managers and
     admins only; the caller decides that with canOverrideLock() */
  function overrideLock(orderId, actor){
    var all = locksAll();
    var prior = all[orderId] || null;
    delete all[orderId]; writeJSON(LS_LOCKS, all);
    var got = acquireLock(orderId, actor);
    if (got && prior && actor && prior.userId !== actor.id){
      audit('lock.overridden', orderId, { actor:actor, source:'merchant',
        key:prior.userId + ':' + (prior.since || prior.ts),
        reason:'manager_override', metadata:{ previousHolderId:prior.userId } });
    }
    return got;
  }
  function lockedByOther(orderId, actor){
    var l = lockOf(orderId);
    return !!(l && actor && l.userId !== actor.id) ? l : null;
  }
  /* processing rights: free, or held by me */
  function canProcess(orderId, actor){
    if (!actor) return false;
    var l = lockOf(orderId);
    return !l || l.userId === actor.id;
  }
  /* drop stale locks so a crashed session never holds an order hostage */
  function sweepLocks(){
    var all = locksAll(), now = Date.now(), changed = false;
    Object.keys(all).forEach(function (k) {
      if (now - all[k].ts > LOCK_STALE_MS) {
        audit('lock.expired', k, { automatic:true, systemGenerated:true, source:'automation',
          key:all[k].userId + ':' + (all[k].since || all[k].ts),
          reason:'heartbeat_lost', metadata:{ heldBy:all[k].userId } });
        delete all[k]; changed = true;
      }
    });
    if (changed) writeJSON(LS_LOCKS, all);
    return changed;
  }

  /* ---------- order modification policy ----------
     Variant, size and colour replacement is NEVER a free merchant action. It
     only ever happens through the Customer Approved Changes workflow, so a
     direct request is always refused here and reported as requiring that
     workflow. Product removal is permitted only before Accept. Quantity
     changes and additions are never permitted. */
  var APPROVAL_REQUIRED = ['variant', 'size', 'color'];
  function canModify(orderId, kind){
    if (APPROVAL_REQUIRED.indexOf(kind) > -1) return false;   /* never direct */
    var s = mstate(orderId);
    var beforeAccept = (s === MSTATE.PENDING || s === null);
    if (beforeAccept) return kind === 'remove-product';
    return false;
  }
  /* why a modification is refused, so a surface can route the merchant to the
     right workflow instead of silently disabling a control */
  function modifyPolicy(orderId, kind){
    if (APPROVAL_REQUIRED.indexOf(kind) > -1){
      return { allowed:false, reason:'customer_approval_required',
               message:T('يتم تغيير الخيارات عبر مسار التعديلات المعتمدة من العميل فقط',
                         'Option changes go through the Customer Approved Changes workflow only') };
    }
    if (canModify(orderId, kind)) return { allowed:true, reason:null, message:'' };
    return { allowed:false, reason:'not_permitted',
             message:T('غير مسموح بعد قبول الطلب','Not permitted once the order is accepted') };
  }

  /* ---------- customer out-of-stock preference ----------
     Read only. The order snapshot does not carry this field yet, so it
     returns null and the merchant surface reports it as not recorded
     rather than choosing a behaviour on the customer's behalf. */
  function oosPreferenceOf(orderId){
    if (!global.RAFShop) return null;
    var o = RAFShop.Orders.get ? RAFShop.Orders.get(orderId) : null;
    var v = o && (o.oosPreference || o.outOfStockPreference);
    return (v === 'remove' || v === 'cancel') ? v : null;
  }

  /* ---------- the clock that closes expired windows ----------
     Whichever surface is open drives it. Deadlines are absolute, so a
     throttled background tab resolves correctly the moment it catches up. */
  function sweep(){
    var m = readAll(), fired = false;
    Object.keys(m).forEach(function (k) {
      /* a merchant decision inside its undo window has already answered the
         acceptance question — the auto-timeout must not race it */
      if (undoOf(k)) return;
      if (isExpired(m[k])) { timeout(k); fired = true; }
    });
    sweepUndo();
    sweepLocks();
    return fired;
  }

  var watchers = [], ticker = null;
  function emit(orderId, kind){
    var detail = { id:orderId, kind:kind, state:get(orderId) };
    watchers.forEach(function (fn) { try { fn(detail); } catch (e) {} });
    try { document.dispatchEvent(new CustomEvent('raf:order', { detail: detail })); } catch (e) {}
  }
  function watch(fn){
    if (typeof fn !== 'function') return function () {};
    watchers.push(fn);
    startTicker();
    return function () { watchers = watchers.filter(function (f) { return f !== fn; }); };
  }
  function startTicker(){
    if (ticker) return;
    ticker = setInterval(function () {
      sweep();
      watchers.forEach(function (fn) { try { fn({ kind:'tick' }); } catch (e) {} });
    }, 1000);
  }

  /* cross-surface sync — the accept signal another tab writes, unchanged,
     plus any change to the shared window store */
  global.addEventListener('storage', function (e) {
    if (e.key === LS_ACCEPT && e.newValue) accept(e.newValue);
    /* there is deliberately no storage signal for a driver pickup: a pickup is
       performed only through RAFDriver.confirmPickup, which proves the
       authenticated driver owns the order before the engine is asked */
    else if (e.key === LS || e.key === LS_ORDERS || e.key === LS_MSTATE ||
             e.key === LS_LOCKS || e.key === LS_UNDO) {
      watchers.forEach(function (fn) { try { fn({ kind:'sync' }); } catch (e2) {} });
    }
  });
  /* ---------- canonical merchant milestones (read-only projections) ----------
     The authoritative record of WHEN the merchant accepted or finished an order
     is the append-only audit event the engine wrote at that moment
     ('order.accept', 'order.ready'). The merchant state record is overwritten
     by later states, so it is not a reliable source, and no second timestamp
     field is added. An action that was undone does not count; if it was
     performed again, the latest non-undone one is the milestone. Returns
     { at, eventId, source } or null — never an estimate.
     acceptedAt() is the approved base for the future Promised ETA
     (RAFConfig 'eta.base' / 'eta.promisedDurationMinutes'); no ETA is computed
     here. */
  function milestoneOf(orderId, action){
    if (!orderId || !global.RAFAudit || !RAFAudit.forOrder) return null;
    var hit = null;
    try {
      RAFAudit.forOrder(orderId).forEach(function (e) { if (e.action === action && !e.undone) hit = e; });
    } catch (e) { return null; }
    return hit ? { at:hit.timestamp, eventId:hit.eventId, source:'RAFAudit:' + action } : null;
  }
  function acceptedAt(orderId){ return milestoneOf(orderId, 'order.accept'); }
  function readyAt(orderId){ return milestoneOf(orderId, 'order.ready'); }
  /* Phase I: the delivered milestone (the driver.delivered audit written by driverDelivered) */
  function deliveredAt(orderId){ return milestoneOf(orderId, 'driver.delivered'); }
  /* THE PROMISED ETA — the one place it is computed. Approved rule:
     Merchant Accepted Time + RAFConfig 'eta.promisedDurationMinutes'. Read-only
     and used for Priority Pool ordering only; no surface displays or edits it
     in this phase. null when the accept milestone or the duration is missing. */
  function promisedEtaAt(orderId){
    /* HISTORY FIRST — the promise recorded on the snapshot at merchant
       acceptance is the historical fact and is returned exactly as recorded.
       A later configuration change can never restate it. */
    var rec = recordedPromise(orderId);
    if (rec) return { at:rec.promisedEtaAt, acceptedAt:rec.acceptedAt, durationMinutes:rec.durationMinutes,
                      recorded:true, recordedAt:rec.recordedAt, source:'RAFOrderSnapshot.promise (recorded at merchant acceptance)' };
    var acc = acceptedAt(orderId);
    var cfg = global.RAFConfig;
    var base = cfg ? cfg.value('eta.base') : null;
    var mins = cfg ? cfg.value('eta.promisedDurationMinutes') : null;
    if (!acc || base !== 'merchant_accepted_at' || typeof mins !== 'number') return null;
    /* nothing was recorded (an order accepted before this was persisted):
       derived from the CURRENT configuration and marked as such */
    return { at:acc.at + mins * 60000, acceptedAt:acc.at, durationMinutes:mins, recorded:false,
             source:acc.source + ' + RAFConfig:eta.promisedDurationMinutes' };
  }
  function recordedPromise(orderId){
    try {
      var s = global.RAFOrderSnapshot ? RAFOrderSnapshot.of(orderId) : null;
      var p = s && s.promise;
      return (p && typeof p.promisedEtaAt === 'number') ? p : null;
    } catch (e) { return null; }
  }
  /* write-once, at the acceptance itself: the promise as the configuration
     stood at that instant. An existing recorded value is never overwritten. */
  function recordPromise(orderId, actor){
    if (!global.RAFOrderSnapshot || !RAFOrderSnapshot.update) return null;
    if (recordedPromise(orderId)) return null;
    var acc = acceptedAt(orderId), cfg = global.RAFConfig;
    var base = cfg ? cfg.value('eta.base') : null;
    var mins = cfg ? cfg.value('eta.promisedDurationMinutes') : null;
    if (!acc || base !== 'merchant_accepted_at' || typeof mins !== 'number') return null;
    try {
      return RAFOrderSnapshot.update(orderId, 'promise',
        { promisedEtaAt:acc.at + mins * 60000, acceptedAt:acc.at, durationMinutes:mins, base:base, recordedAt:Date.now() },
        'promised_eta_recorded', actor || null);
    } catch (e) { return null; }
  }

  /* a surface without the engine loaded can still hand over an acceptance */
  function signalAccept(orderId){
    try { localStorage.setItem(LS_ACCEPT, orderId); } catch (e) {}
    return accept(orderId);
  }

  global.RAFOrderEngine = {
    WINDOW_MS: WINDOW_MS, DECISION: DECISION, STATUS: STATUS,
    /* merchant processing */
    MSTATE: MSTATE, ACTION: ACTION, UNDO_MS: UNDO_MS,
    LOCK_HEARTBEAT_MS: LOCK_HEARTBEAT_MS, LOCK_STALE_MS: LOCK_STALE_MS,
    mstate: mstate, mrecord: mrecord, merchantDone: merchantDone, queueOf: queueOf,
    merchantAccept: merchantAccept, merchantReject: merchantReject, merchantReady: merchantReady,
    undo: undo, undoOf: undoOf, undoMsLeft: undoMsLeft, commitUndo: commitUndo, sweepUndo: sweepUndo,
    acceptedAt: acceptedAt, readyAt: readyAt, deliveredAt: deliveredAt, promisedEtaAt: promisedEtaAt,
    driverPickedUp: driverPickedUp, driverAssigned: driverAssigned,
    driverUnassigned: driverUnassigned, driverDelivered: driverDelivered,
    /* locking */
    lockOf: lockOf, acquireLock: acquireLock, heartbeat: heartbeat, releaseLock: releaseLock,
    overrideLock: overrideLock, lockedByOther: lockedByOther, canProcess: canProcess, sweepLocks: sweepLocks,
    /* rejection (Group B) */
    REJECT_REASONS: REJECT_REASONS, REJECT_ERRORS: REJECT_ERRORS, EXPLANATION_MAX: EXPLANATION_MAX,
    REFUND_DAYS_TEXT: REFUND_DAYS_TEXT, reasonById: reasonById,
    validateRejection: validateRejection, rejectionOf: rejectionOf,
    customerRejectionText: customerRejectionText,
    /* policy */
    canModify: canModify, modifyPolicy: modifyPolicy, oosPreferenceOf: oosPreferenceOf,
    appendTimeline: appendTimeline,
    /* window */
    start: start, get: get, clear: clear, pending: pending,
    isPending: isPending, isExpired: isExpired,
    acceptancePlan: acceptancePlan, hasDeadline: hasDeadline, waitingUntil: waitingUntil,
    /* countdown */
    msLeft: msLeft, clock: clock, progress: progress,
    /* decisions */
    accept: accept, reject: reject, cancel: cancel, timeout: timeout,
    signalAccept: signalAccept,
    /* effects, exposed for the surfaces that need them directly */
    setOrderStatus: setOrderStatus, restoreStock: restoreStock, notify: notify,
    /* subscription */
    sweep: sweep, watch: watch
  };

  /* resolve anything that expired while every surface was closed */
  sweep();
})(window);
