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
  var LS_NOTIF  = 'raf_notif_extra';
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
    var s = { id:orderId, deadline:Date.now() + WINDOW_MS, items:items, done:null, at:Date.now() };
    save(s);
    emit(orderId, 'started');
    return s;
  }

  /* ---------- countdown ---------- */
  function msLeft(orderId){
    var s = get(orderId);
    if (!s || s.done) return 0;
    return Math.max(0, s.deadline - Date.now());
  }
  function isPending(s){ return !!(s && !s.done && s.deadline > Date.now()); }
  function isExpired(s){ return !!(s && !s.done && s.deadline <= Date.now()); }
  /* every order still awaiting a decision, soonest deadline first */
  function pending(){
    var m = readAll(), out = [];
    Object.keys(m).forEach(function (k) { if (isPending(m[k])) out.push(m[k]); });
    return out.sort(function (a, b) { return a.deadline - b.deadline; });
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
    return 1 - (msLeft(orderId) / WINDOW_MS);
  }

  /* ---------- outcomes ----------
     One guard, one decision: whoever gets there first wins, exactly as
     before. Accept keeps the order moving; reject / cancel / timeout all
     run the identical cancel-and-refund chain. */
  function decide(orderId, decision, why){
    var s = get(orderId);
    if (!s || s.done) return false;
    s.done = decision; s.decidedAt = Date.now(); save(s);

    if (decision === DECISION.ACCEPTED) {
      setOrderStatus(orderId, STATUS.PROGRESS);
      notify(orderId,
        T('قبل المتجر طلبك ' + orderId, 'Store accepted order ' + orderId),
        'raf_tracking.html?id=' + encodeURIComponent(orderId));
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
      cancelAndRefund(orderId, why || decision);
    }
    emit(orderId, decision);
    return true;
  }
  function accept(orderId){ return decide(orderId, DECISION.ACCEPTED); }
  /* the merchant declining is the existing cancellation path with its own
     trigger — same status, same refund, same stock restoration */
  function reject(orderId){ return decide(orderId, DECISION.REJECTED, 'rejected'); }
  function cancel(orderId){ return decide(orderId, DECISION.CANCELLED, 'customer'); }
  function timeout(orderId){ return decide(orderId, DECISION.TIMEOUT, 'timeout'); }

  /* mark the order cancelled, restore its stock and record the refund */
  function cancelAndRefund(orderId, why){
    var st = get(orderId);
    var k = (st && st.decidedAt) || Date.now();
    setOrderStatus(orderId, STATUS.CANCELLED);
    audit('system.cancelled', orderId, { automatic:true, systemGenerated:true, source:'automation',
      key:k, reason:why, previousState:null, newState:STATUS.CANCELLED });
    restoreStock(orderId);
    audit('system.stock_restored', orderId, { automatic:true, systemGenerated:true, source:'automation',
      key:k, metadata:{ items:(st && st.items) || null } });
    audit('system.refunded', orderId, { automatic:true, systemGenerated:true, source:'automation',
      key:k, reason:why });
    if (global.RAFRules) { try { RAFRules.Reserve.release(); } catch (e) {} }
    notify(orderId,
      why === 'timeout'
        ? T('تم إلغاء الطلب ' + orderId + ' تلقائياً وإعادة المبلغ', 'Order ' + orderId + ' was auto-cancelled and refunded')
        : T('تم إلغاء الطلب ' + orderId + ' وإعادة المبلغ', 'Order ' + orderId + ' was cancelled and refunded'),
      'raf_order_details.html?id=' + encodeURIComponent(orderId));
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
  function restoreStock(orderId){
    if (!global.RAFSource || !global.RAFShop) return;
    var s = get(orderId);
    if (!s || !s.items) return;
    Object.keys(s.items).forEach(function (pid) {
      var p = RAFSource.product(pid);
      if (p && p.stock != null) RAFSource.updateProduct(pid, { stock: p.stock + s.items[pid] });
    });
  }

  /* surface the outcome in the notification centre */
  function notify(orderId, text, href){
    try {
      var a = JSON.parse(localStorage.getItem(LS_NOTIF) || '[]');
      a.unshift({ id:'ord-' + orderId + '-' + Date.now(), t:{ ar:text, en:text }, href:href, ts:Date.now() });
      localStorage.setItem(LS_NOTIF, JSON.stringify(a.slice(0, 20)));
    } catch (e) {}
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
  var LS_PICKUP = 'raf_driver_pickup';

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
  function openUndo(orderId, action, prevState, actor){
    var all = undoAll();
    var cur = mstateAll()[orderId];
    all[orderId] = { action:action, prev:prevState || null, at:Date.now(),
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
    if (u.action === ACTION.ACCEPT)      accept(orderId);   /* existing chain */
    else if (u.action === ACTION.REJECT) reject(orderId);   /* existing chain */
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
  function merchantAccept(orderId, actor){
    var g = actionable(orderId, actor); if (!g.ok) return g;
    if (mstate(orderId) !== MSTATE.PENDING) return { ok:false, reason:'not_pending' };
    var prev = mrecord(orderId);
    setMState(orderId, MSTATE.PREPARING, actor);
    appendTimeline(orderId, 'm-accept', 'قبل المتجر الطلب', 'Store accepted the order');
    openUndo(orderId, ACTION.ACCEPT, prev, actor);
    audit('order.accept', orderId, { actor:actor, source:'merchant', reversible:true,
      key:(mrecord(orderId) || {}).at, previousState:MSTATE.PENDING, newState:MSTATE.PREPARING });
    return { ok:true, undoMs:UNDO_MS };
  }
  function merchantReject(orderId, actor){
    var g = actionable(orderId, actor); if (!g.ok) return g;
    if (mstate(orderId) !== MSTATE.PENDING) return { ok:false, reason:'not_pending' };
    var prev = mrecord(orderId);
    setMState(orderId, 'rejected', actor);
    appendTimeline(orderId, 'm-reject', 'اعتذر المتجر عن الطلب', 'Store declined the order', 'cancel');
    openUndo(orderId, ACTION.REJECT, prev, actor);
    audit('order.reject', orderId, { actor:actor, source:'merchant', reversible:true,
      key:(mrecord(orderId) || {}).at, previousState:MSTATE.PENDING, newState:'rejected' });
    return { ok:true, undoMs:UNDO_MS };
  }
  function merchantReady(orderId, actor){
    var g = actionable(orderId, actor); if (!g.ok) return g;
    var cur = mstate(orderId);
    if (cur !== MSTATE.PREPARING && cur !== MSTATE.ACCEPTED) return { ok:false, reason:'not_preparing' };
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
  function driverAssigned(orderId, actor){
    if (mstate(orderId) !== MSTATE.READY) return { ok:false, reason:'not_ready' };
    setMState(orderId, MSTATE.WAITING_DRIVER, actor);
    appendTimeline(orderId, 'm-waiting-driver', 'بانتظار السائق', 'Waiting for driver', 'active');
    audit('driver.assigned', orderId, { actor:actor, source:'driver',
      key:(mrecord(orderId) || {}).at, previousState:MSTATE.READY, newState:MSTATE.WAITING_DRIVER });
    return { ok:true };
  }
  /* after Ready the merchant has no further processing actions */
  function merchantDone(orderId){
    var s = mstate(orderId);
    return s === MSTATE.READY || s === MSTATE.WAITING_DRIVER || s === 'rejected';
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
    /* a driver pickup reported by another surface always wins over UI state */
    else if (e.key === LS_PICKUP && e.newValue) driverPickedUp(e.newValue);
    else if (e.key === LS || e.key === LS_ORDERS || e.key === LS_MSTATE ||
             e.key === LS_LOCKS || e.key === LS_UNDO) {
      watchers.forEach(function (fn) { try { fn({ kind:'sync' }); } catch (e2) {} });
    }
  });
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
    mstate: mstate, mrecord: mrecord, merchantDone: merchantDone,
    merchantAccept: merchantAccept, merchantReject: merchantReject, merchantReady: merchantReady,
    undo: undo, undoOf: undoOf, undoMsLeft: undoMsLeft, commitUndo: commitUndo, sweepUndo: sweepUndo,
    driverPickedUp: driverPickedUp, driverAssigned: driverAssigned,
    /* locking */
    lockOf: lockOf, acquireLock: acquireLock, heartbeat: heartbeat, releaseLock: releaseLock,
    overrideLock: overrideLock, lockedByOther: lockedByOther, canProcess: canProcess, sweepLocks: sweepLocks,
    /* policy */
    canModify: canModify, modifyPolicy: modifyPolicy, oosPreferenceOf: oosPreferenceOf,
    appendTimeline: appendTimeline,
    /* window */
    start: start, get: get, clear: clear, pending: pending,
    isPending: isPending, isExpired: isExpired,
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
