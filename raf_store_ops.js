/* ============================================================
   RAF — STORE OPERATIONS ENGINE  (shared, headless)
   ------------------------------------------------------------
   The single authority for a store's LIVE operating condition:

     · workload state, calculated from active orders
     · merchant manual override, and the return to automatic
     · the expected preparation time shown to customers
     · Busy Mode and its automatic expiry
     · the closing-time cutoff for new orders
     · the operational model for scheduled orders

   Merchant and customer surfaces both read from here, so the two can
   never disagree. Nothing in this module writes to an order snapshot:
   workload is live data, the preparation time attached to an accepted
   order is historical snapshot data, and the two are never mixed.

   Scope is always the canonical storeSlug. Store names, emails,
   usernames and approximate matching are never used.
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFStoreOps) return;

  var LS = 'raf_store_ops';
  var MAX_BUSY_MS = 8 * 60 * 60 * 1000;      /* temporary closure ceiling */
  var CUTOFF_MS   = 30 * 60 * 1000;          /* last order before closing */

  /* the only three workload states, with their customer-facing ranges */
  var STATE = { NORMAL:'normal', MODERATE:'moderate', HIGH:'high' };
  var RANGES = {
    normal:   { key:'5-10',  min:5,  max:10, ar:'5–10 دقائق',  en:'5–10 minutes' },
    moderate: { key:'15-20', min:15, max:20, ar:'15–20 دقيقة', en:'15–20 minutes' },
    high:     { key:'20-30', min:20, max:30, ar:'20–30 دقيقة', en:'20–30 minutes' }
  };
  /* range key → range, so a historical order renders without touching live state */
  var BY_KEY = {};
  Object.keys(RANGES).forEach(function (k) { BY_KEY[RANGES[k].key] = RANGES[k]; });

  var MODE = { AUTO:'auto', MANUAL:'manual' };
  var BUSY_DURATIONS = [1, 2, 4, 8];          /* hours */

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }

  /* ---------- persisted operational state, per store ---------- */
  function readAll(){
    try { var v = JSON.parse(localStorage.getItem(LS)); return (v && typeof v === 'object') ? v : {}; }
    catch (e) { return {}; }
  }
  function writeAll(v){
    try { localStorage.setItem(LS, JSON.stringify(v)); } catch (e) {}
    emit();
  }
  function recordOf(slug){
    var r = readAll()[slug];
    return r || { mode:MODE.AUTO, manualState:null, busyUntil:null, updatedAt:null, by:null, byName:null };
  }
  function save(slug, patch, actor){
    if (!slug) return false;
    var all = readAll();
    var cur = all[slug] || { mode:MODE.AUTO, manualState:null, busyUntil:null };
    all[slug] = Object.assign({}, cur, patch, {
      updatedAt: Date.now(),
      by: (actor && actor.id) || null,
      byName: (actor && actor.name) || null
    });
    writeAll(all);
    return true;
  }

  /* ---------- active orders ----------
     Orders still needing merchant attention. Scoped by storeSlug through the
     snapshot engine — never by store name. */
  function activeOrders(slug){
    if (!slug || !global.RAFOrderSnapshot || !global.RAFOrderEngine) return [];
    var E = global.RAFOrderEngine;
    return RAFOrderSnapshot.forStore(slug).filter(function (o) {
      /* a scheduled order is not part of today's immediate workload */
      var snap = o.snapshot;
      if (snap && snap.scheduled) return false;
      var m = E.mstate(o.id);
      return m === E.MSTATE.PENDING || m === E.MSTATE.ACCEPTED || m === E.MSTATE.PREPARING;
    });
  }
  function activeCount(slug){ return activeOrders(slug).length; }

  /* ---------- workload ---------- */
  function stateForCount(n){
    if (n >= 21) return STATE.HIGH;
    if (n >= 11) return STATE.MODERATE;
    return STATE.NORMAL;
  }
  /* what the system calculates, ignoring any override */
  function autoState(slug){ return stateForCount(activeCount(slug)); }
  /* what the store is actually operating at right now */
  function currentState(slug){
    var r = recordOf(slug);
    if (r.mode === MODE.MANUAL && r.manualState && RANGES[r.manualState]) return r.manualState;
    return autoState(slug);
  }
  function isManual(slug){
    var r = recordOf(slug);
    return r.mode === MODE.MANUAL && !!(r.manualState && RANGES[r.manualState]);
  }
  /* the preparation-time range customers are being shown right now */
  function prepRange(slug){ return RANGES[currentState(slug)]; }
  function prepKey(slug){ return prepRange(slug).key; }
  /* a historical range, resolved from a stored key — never from live state */
  function rangeForKey(key){ return BY_KEY[key] || null; }
  function rangeLabel(range){ return range ? T(range.ar, range.en) : null; }

  /* the whole live picture, for a surface to render in one read */
  function snapshotOf(slug){
    var r = recordOf(slug), auto = autoState(slug), cur = currentState(slug);
    return {
      slug: slug,
      mode: r.mode || MODE.AUTO,
      manual: isManual(slug),
      state: cur,
      autoState: auto,
      activeCount: activeCount(slug),
      range: RANGES[cur],
      busy: isBusy(slug),
      busyUntil: busyUntil(slug),
      acceptingOrders: acceptsNewOrders(slug).ok,
      updatedAt: r.updatedAt || null,
      byName: r.byName || null
    };
  }

  /* ---------- merchant control ---------- */
  /* Only meaningful transitions are audited — never the per-tick order count. */
  function audit(action, slug, opts){
    if (!global.RAFAudit) return;
    try {
      var o = opts || {};
      o.action = action; o.storeSlug = slug;
      RAFAudit.record(o);
    } catch (e) {}
  }
  /* M-04 — every mutation below used to trust whatever slug it was handed,
     so a direct call could change another store's operating state. The slug
     is now proven against the caller: the actor must exist, must hold the
     existing orders.manage permission, and must belong to that store. This
     reuses RAFPerm and the existing merchant↔store link; it is not a second
     permission system, and read paths are deliberately untouched. */
  function opsGuard(slug, actor){
    if (!slug) return { ok:false, reason:'CROSS_STORE', code:'CROSS_STORE',
                        message:T('هذا المتجر لا يخصك.','This store does not belong to you.') };
    if (!actor || !actor.id) return { ok:false, reason:'FORBIDDEN', code:'FORBIDDEN',
                        message:T('ليس لديك صلاحية لهذا الإجراء.','You do not have permission for this action.') };
    var allowed = false;
    try { allowed = !!(global.RAFPerm && RAFPerm.can(actor.id, 'orders.manage')); } catch (e) { allowed = false; }
    if (!allowed) return { ok:false, reason:'FORBIDDEN', code:'FORBIDDEN',
                        message:T('ليس لديك صلاحية لهذا الإجراء.','You do not have permission for this action.') };
    /* the actor's store comes from the permission authority by id — a store
       written onto the actor object by the caller is never trusted */
    var mine = null;
    try { mine = (global.RAFPerm && RAFPerm.storeSlugOf(actor.id)) || null; } catch (e) { mine = null; }
    if (!mine || mine !== slug)
      return { ok:false, reason:'CROSS_STORE', code:'CROSS_STORE', actorStore:mine,
               targetStore:slug, message:T('هذا المتجر لا يخصك.','This store does not belong to you.') };
    return { ok:true };
  }

  function setManual(slug, state, actor){
    var auth = opsGuard(slug, actor); if (!auth.ok) return auth;
    if (!RANGES[state]) return { ok:false, reason:'unknown_state' };
    if (offline()) return { ok:false, reason:'offline' };
    var before = currentState(slug);
    save(slug, { mode:MODE.MANUAL, manualState:state }, actor);
    audit('ops.workload_manual', slug, { actor:actor, source:'merchant',
      key:recordOf(slug).updatedAt, previousState:before, newState:state,
      reason:'merchant_override' });
    return { ok:true, state:state, range:RANGES[state] };
  }
  /* back to automatic: the current active count decides, never a cached value */
  function setAutomatic(slug, actor){
    var auth = opsGuard(slug, actor); if (!auth.ok) return auth;
    if (offline()) return { ok:false, reason:'offline' };
    var before = currentState(slug);
    save(slug, { mode:MODE.AUTO, manualState:null }, actor);
    audit('ops.workload_auto', slug, { actor:actor, source:'merchant',
      key:recordOf(slug).updatedAt, previousState:before, newState:autoState(slug) });
    return { ok:true, state:autoState(slug), range:RANGES[autoState(slug)] };
  }

  /* ---------- busy mode / temporary closure ---------- */
  function busyUntil(slug){
    var r = recordOf(slug);
    if (!r.busyUntil) return null;
    if (Date.now() >= r.busyUntil) return null;      /* expired → open again */
    return r.busyUntil;
  }
  function isBusy(slug){ return busyUntil(slug) !== null; }
  function busyMsLeft(slug){
    var u = busyUntil(slug);
    return u ? Math.max(0, u - Date.now()) : 0;
  }
  function setBusy(slug, hours, actor){
    var auth = opsGuard(slug, actor); if (!auth.ok) return auth;
    if (offline()) return { ok:false, reason:'offline' };
    var h = parseFloat(hours);
    if (!isFinite(h) || h <= 0) return { ok:false, reason:'bad_duration' };
    var ms = Math.min(h * 3600000, MAX_BUSY_MS);      /* 8 hours is the ceiling */
    var wasBusy = isBusy(slug);
    save(slug, { busyUntil: Date.now() + ms }, actor);
    var until = recordOf(slug).busyUntil;
    audit('ops.busy_on', slug, { actor:actor, source:'merchant', key:until,
      reason:'temporary_closure', metadata:{ hours:Math.min(h, MAX_BUSY_MS/3600000), wasBusy:wasBusy } });
    return { ok:true, until:until, cappedTo8h: h * 3600000 > MAX_BUSY_MS };
  }
  function reopen(slug, actor){
    var auth = opsGuard(slug, actor); if (!auth.ok) return auth;
    if (offline()) return { ok:false, reason:'offline' };
    var was = recordOf(slug).busyUntil;
    save(slug, { busyUntil:null }, actor);
    if (was) audit('ops.busy_off', slug, { actor:actor, source:'merchant', key:was, reason:'reopened_now' });
    return { ok:true };
  }
  /* clears expired closures from storage so sessions converge */
  function sweep(){
    var all = readAll(), changed = false, now = Date.now();
    Object.keys(all).forEach(function (s) {
      if (all[s].busyUntil && now >= all[s].busyUntil) {
        audit('ops.busy_expired', s, { automatic:true, systemGenerated:true, source:'automation',
          key:all[s].busyUntil, reason:'temporary_closure_elapsed' });
        all[s].busyUntil = null; changed = true;
      }
    });
    if (changed) writeAll(all);
    return changed;
  }

  /* ---------- closing time & the 30-minute cutoff ----------
     Driven by a structured `closesAt` ("HH:MM", 24h) on the store record.
     The free-text `hours` string is display copy and is never parsed — a
     store without structured hours reports the missing data instead of
     having a closing time invented for it. */
  function storeOf(slug){
    return (global.RAFSource && slug) ? RAFSource.store(slug) : null;
  }
  var DAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  var HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
  /* Business time is Asia/Kuwait (UTC+3) — the same wall clock RAFMarketing
     uses. Today's weekday and today's closing time are read on it, never on
     the viewer's own timezone. */
  var TZ_OFFSET_MIN = 3 * 60;
  function kuwaitNow(){
    var d = new Date();
    return new Date(d.getTime() + (d.getTimezoneOffset() + TZ_OFFSET_MIN) * 60000);
  }
  /* a Kuwait wall-clock date + 'HH:MM' → the real instant (epoch ms), or null */
  function kuwaitWallMs(dateISO, hhmm){
    var d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateISO === 'string' ? dateISO : '');
    var t = HHMM.exec(typeof hhmm === 'string' ? hhmm : '');
    if (!d || !t) return null;
    return Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]) - TZ_OFFSET_MIN * 60000;
  }

  /* The structured schedule, or null when the store has none recorded.
     `schedule` on the store record is the ONLY source of opening hours; the
     free-text `hours` copy is never read. RAFStoreSchedule validates every
     write — this reader only interprets what is stored. A day is
     { closed:true }, { periods:[{open,close}, …] } (one or two periods), or
     the earlier single-period { open, close }. */
  function minutesOf(t){
    if (typeof t !== 'string' || !HHMM.test(t)) return null;
    var p = t.split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }
  /* a day's periods in time order: [] for a closed day, null when unreadable */
  function periodsOf(e){
    if (!e || typeof e !== 'object') return null;
    if (e.closed === true) return [];
    var list = Array.isArray(e.periods) ? e.periods
             : (typeof e.close === 'string' ? [{ open:e.open, close:e.close }] : null);
    if (!list || !list.length) return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var o = minutesOf(list[i] && list[i].open), c = minutesOf(list[i] && list[i].close);
      if (o === null || c === null || c <= o) return null;
      out.push({ open:list[i].open, close:list[i].close, o:o, c:c });
    }
    return out.sort(function (a, b) { return a.o - b.o; });
  }
  function scheduleOf(slug){
    var s = storeOf(slug);
    if (!s) return null;
    var cand = s.schedule || null;
    if (!cand || typeof cand !== 'object') return null;
    /* only accept a shape that actually reads */
    var ok = DAYS.some(function (d) { return periodsOf(cand[d]) !== null; });
    return ok ? cand : null;
  }
  function dayEntry(slug, date){
    var sch = scheduleOf(slug);
    if (!sch) return null;
    return sch[DAYS[(date || kuwaitNow()).getDay()]] || null;
  }
  /* today's final closing time as 'HH:MM' — the end of the day's last
     period — or null when unavailable / closed today */
  function closingTimeOf(slug){
    var p = periodsOf(dayEntry(slug));
    return (p && p.length) ? p[p.length - 1].close : null;
  }
  function isClosedDay(slug){
    var e = dayEntry(slug);
    return !!(e && e.closed === true);
  }
  /* ms from now until today's closing time, or null when unavailable */
  function msUntilClose(slug){
    var t = closingTimeOf(slug);
    if (!t) return null;
    /* both sides are Kuwait wall-clock, so the difference is real time */
    var parts = t.split(':'), now = kuwaitNow();
    var close = new Date(now.getFullYear(), now.getMonth(), now.getDate(),
                         parseInt(parts[0], 10), parseInt(parts[1], 10), 0, 0);
    if (close <= now) return 0;                    /* today's window has passed */
    return close - now;
  }
  var NEXT_DAY_MSG = function(){
    return T('سيتم تجهيز وتوصيل طلبك في يوم العمل التالي.',
             'Your order will be prepared and delivered on the next business day.');
  };
  /* Can a NEW order still be fulfilled today? Measured against the day's
     final closing time, as before. known:false means the store has no
     structured schedule recorded — never a guessed time. */
  function cutoff(slug){
    if (!scheduleOf(slug)) {
      return { known:false, reason:'closing_time_unavailable',
               sameDay:null, msLeft:null, closesAt:null, closedToday:null, message:null };
    }
    if (isClosedDay(slug)) {
      return { known:true, closedToday:true, sameDay:false, msLeft:0, closesAt:null,
               message: NEXT_DAY_MSG() };
    }
    var left = msUntilClose(slug);
    if (left === null) {
      return { known:false, reason:'closing_time_unavailable',
               sameDay:null, msLeft:null, closesAt:null, closedToday:false, message:null };
    }
    return {
      known: true,
      closedToday: false,
      closesAt: closingTimeOf(slug),
      msLeft: left,
      sameDay: left > CUTOFF_MS,
      message: left > CUTOFF_MS ? null : NEXT_DAY_MSG()
    };
  }

  /* Where the store stands against today's periods, in Kuwait time.
     DESCRIPTIVE ONLY: it does not decide whether an order is accepted — that
     stays acceptsNewOrders() and cutoff(), unchanged.
       closed_today · before_open · open (period 1 or 2) · between_periods ·
       after_close · unconfigured · unknown
     `at` (optional) is a Kuwait wall-clock Date, as kuwaitNow() returns. */
  function hoursState(slug, at){
    if (!scheduleOf(slug)) return { configured:false, state:'unconfigured' };
    var now = at instanceof Date ? at : kuwaitNow(), e = dayEntry(slug, now);
    if (!e) return { configured:true, state:'unknown' };
    if (e.closed === true) return { configured:true, state:'closed_today' };
    var p = periodsOf(e);
    if (!p || !p.length) return { configured:true, state:'unknown' };
    var m = now.getHours() * 60 + now.getMinutes(), n = p.length;
    if (m < p[0].o) return { configured:true, state:'before_open', period:1, periods:n, opensAt:p[0].open, closesAt:p[0].close };
    for (var i = 0; i < n; i++) {
      if (m >= p[i].o && m < p[i].c)
        return { configured:true, state:'open', period:i + 1, periods:n, opensAt:p[i].open, closesAt:p[i].close };
      if (i + 1 < n && m >= p[i].c && m < p[i + 1].o)
        return { configured:true, state:'between_periods', period:i + 2, periods:n,
                 closedAt:p[i].close, opensAt:p[i + 1].open, closesAt:p[i + 1].close };
    }
    return { configured:true, state:'after_close', periods:n, closesAt:p[n - 1].close };
  }

  /* ---------- delivery availability ----------
     Three separate things, never collapsed into one flag:
       manual   — the merchant's Open / Closed / Busy / Suspended state
       schedule — where today stands against the structured periods
       delivery — Instant Delivery now, Scheduled Delivery, next opening
     The schedule never changes the manual state, and being outside a
     period is not "closed". Schedule arithmetic stays in RAFStoreSchedule;
     the Kuwait clock and availability stay here. */
  function two(n){ return (n < 10 ? '0' : '') + n; }
  /* RAF has not defined a delivery-slot policy (slot length, days ahead).
     This is the single plug-in point for it; until one is configured,
     Scheduled Delivery reports itself unavailable instead of guessing. */
  var SLOT_POLICY = null;
  function configureSlotPolicy(policy){
    if (policy === null) { SLOT_POLICY = null; return { ok:true }; }
    if (!global.RAFStoreSchedule || !RAFStoreSchedule.validSlotPolicy(policy)) return { ok:false, reason:'invalid_policy' };
    SLOT_POLICY = { slotMinutes:Number(policy.slotMinutes), horizonDays:Number(policy.horizonDays) };
    return { ok:true };
  }
  function slotPolicy(){ return SLOT_POLICY ? { slotMinutes:SLOT_POLICY.slotMinutes, horizonDays:SLOT_POLICY.horizonDays } : null; }

  /* Instant Delivery stops CUTOFF_MS before the END OF THE DAY'S FINAL
     PERIOD — never the end of an earlier period. 'HH:MM' or null. */
  function instantCutoffOf(slug, at){
    var now = at instanceof Date ? at : kuwaitNow();
    var p = periodsOf(dayEntry(slug, now));
    if (!p || !p.length) return null;
    var c = Math.max(0, p[p.length - 1].c - CUTOFF_MS / 60000);
    return two(Math.floor(c / 60)) + ':' + two(c % 60);
  }

  /* `at` (optional) is a Kuwait wall-clock Date, as kuwaitNow() returns */
  function deliveryAvailability(slug, at){
    var now = at instanceof Date ? at : kuwaitNow();
    var s = storeOf(slug), hs = hoursState(slug, now);
    var out = {
      configured: !!hs.configured,
      manual:   { status:(s && s.status) || null, busy:isBusy(slug) },
      schedule: hs,
      instant:  { available:null, reason:null, cutoffAt:null },
      nextOpening: null,
      scheduled: { available:false, reason:null, dates:[] }
    };
    /* no schedule → nothing is invented: no cutoff, no windows, no opening */
    if (!hs.configured) { out.instant.reason = 'unconfigured'; out.scheduled.reason = 'unconfigured'; return out; }

    var cut = instantCutoffOf(slug, now), m = now.getHours() * 60 + now.getMinutes();
    out.instant.cutoffAt = cut;
    if (hs.state === 'open' && cut !== null && m < minutesOf(cut)) out.instant.available = true;
    else {
      out.instant.available = false;
      out.instant.reason = (hs.state === 'open' || hs.state === 'after_close') ? 'cutoff_passed'
                         : (hs.state === 'between_periods' || hs.state === 'before_open') ? 'outside_period'
                         : hs.state === 'closed_today' ? 'closed_today' : 'unknown';
    }
    var lib = global.RAFStoreSchedule, sch = s && s.schedule;
    if (!lib || !sch) { out.scheduled.reason = 'unavailable'; return out; }
    out.nextOpening = lib.nextOpening(sch, now);
    var pol = slotPolicy();
    if (!pol) out.scheduled.reason = 'no_slot_policy';
    else {
      out.scheduled.dates = lib.deliveryDates(sch, pol, now) || [];
      out.scheduled.available = out.scheduled.dates.length > 0;
      out.scheduled.reason = out.scheduled.available ? null : 'no_windows';
    }
    return out;
  }

  var DELIVERY_ERRORS = {
    DELIVERY_OPTION_REQUIRED: { ar:'اختر طريقة التوصيل.', en:'Choose a delivery option.' },
    DELIVERY_CHANGED:         { ar:'تغيّرت خيارات التوصيل المتاحة. راجع اختيارك ثم أكّد الطلب.',
                                en:'The available delivery options have changed. Review your choice and confirm again.' },
    SCHEDULED_UNAVAILABLE:    { ar:'التوصيل المجدول غير متاح حالياً.', en:'Scheduled delivery is not available right now.' },
    NEXT_OPENING_UNAVAILABLE: { ar:'لا يوجد موعد افتتاح قادم لهذا المتجر.', en:'This store has no upcoming opening.' },
    SCHEDULED_INVALID:        { ar:'موعد التوصيل المختار غير متاح. اختر موعداً آخر.', en:'The selected delivery time is not available. Choose another time.' }
  };
  function derr(code){ var e = DELIVERY_ERRORS[code]; return { ok:false, code:code, message:T(e.ar, e.en) }; }
  /* The one authoritative check of a delivery choice at order placement,
     for the cart's own store. Returns exactly what the order records:
       { timing:'instant' | 'scheduled' | 'next_opening' | null, scheduled, receiveAt }
     Nothing the page computed is trusted. */
  function checkDeliveryChoice(slug, choice, at){
    choice = choice || {};
    var now = at instanceof Date ? at : kuwaitNow();
    var av = deliveryAvailability(slug, now), t = choice.timing || null;
    if (!av.configured) {
      if (t && t !== 'instant') return derr('SCHEDULED_UNAVAILABLE');
      return { ok:true, timing:null, scheduled:null, receiveAt:null };      /* unchanged behaviour */
    }
    if (t === 'instant')
      return av.instant.available ? { ok:true, timing:'instant', scheduled:null, receiveAt:null } : derr('DELIVERY_CHANGED');
    if (t === 'next_opening') {
      if (av.instant.available) return derr('DELIVERY_CHANGED');
      var n = av.nextOpening;
      /* no future opening → no commitment can be made, so no order is created */
      if (!n) return derr('NEXT_OPENING_UNAVAILABLE');
      return { ok:true, timing:'next_opening', scheduled:null, receiveAt:{ date:n.date, time:n.time } };
    }
    if (t === 'scheduled') {
      if (!av.scheduled.available) return derr('SCHEDULED_UNAVAILABLE');
      if (!RAFStoreSchedule.isValidWindow(storeOf(slug).schedule, choice.date, choice.start, choice.end, slotPolicy(), now))
        return derr('SCHEDULED_INVALID');
      return { ok:true, timing:'scheduled', scheduled:scheduleFor(choice.date, choice.start, choice.end), receiveAt:null };
    }
    return derr('DELIVERY_OPTION_REQUIRED');
  }

  /* ---------- can this store take a new order right now? ----------
     Applies to NEW orders only. Nothing here touches orders already placed. */
  function acceptsNewOrders(slug){
    if (!slug) return { ok:false, reason:'no_store' };
    var s = storeOf(slug);
    if (s && s.status && s.status !== 'open') return { ok:false, reason:'store_' + s.status };
    if (isBusy(slug)) {
      return { ok:false, reason:'busy', until:busyUntil(slug),
               message: T('المتجر مشغول حاليًا ولا يستطيع استقبال الطلبات. سيعاود الاستقبال قريبًا.',
                          'The store is currently busy and cannot accept new orders. It will resume accepting orders soon.') };
    }
    return { ok:true };
  }

  /* ---------- scheduled orders (operational model only) ----------
     A scheduled order is not part of today's immediate workload and is not
     treated as an ordinary order. The snapshot already reserves `scheduled`;
     this is the shape that belongs in it. */
  function scheduleFor(dateISO, windowFrom, windowTo){
    if (!dateISO || !windowFrom || !windowTo) return null;
    return { date:String(dateISO), from:String(windowFrom), to:String(windowTo), createdAt:Date.now() };
  }
  function isScheduled(order){
    return !!(order && order.snapshot && order.snapshot.scheduled);
  }
  function scheduledAt(order){
    var s = order && order.snapshot && order.snapshot.scheduled;
    if (!s || !s.date || !s.from) return null;
    var d = new Date(s.date + 'T' + (s.from.length === 5 ? s.from : '00:00'));
    return isNaN(d.getTime()) ? null : d.getTime();
  }

  /* ---------- connectivity ----------
     An operational change must never be reported as done while offline. */
  function offline(){ return global.navigator && global.navigator.onLine === false; }

  /* ---------- change propagation ----------
     Every merchant session of the same store converges on one state. */
  var watchers = [];
  function emit(){
    watchers.forEach(function (fn) { try { fn(); } catch (e) {} });
    try { document.dispatchEvent(new CustomEvent('raf:ops')); } catch (e) {}
  }
  function watch(fn){
    if (typeof fn !== 'function') return function () {};
    watchers.push(fn);
    return function () { watchers = watchers.filter(function (f) { return f !== fn; }); };
  }
  global.addEventListener('storage', function (e) {
    if (e.key === LS) emit();                     /* another employee changed it */
  });
  global.addEventListener('online',  emit);
  global.addEventListener('offline', emit);

  global.RAFStoreOps = {
    STATE: STATE, MODE: MODE, RANGES: RANGES, BUSY_DURATIONS: BUSY_DURATIONS,
    MAX_BUSY_MS: MAX_BUSY_MS, CUTOFF_MS: CUTOFF_MS,
    /* workload */
    activeOrders: activeOrders, activeCount: activeCount, stateForCount: stateForCount,
    autoState: autoState, currentState: currentState, isManual: isManual,
    prepRange: prepRange, prepKey: prepKey, rangeForKey: rangeForKey, rangeLabel: rangeLabel,
    snapshot: snapshotOf, recordOf: recordOf,
    /* control */
    setManual: setManual, setAutomatic: setAutomatic,
    setBusy: setBusy, reopen: reopen, isBusy: isBusy, busyUntil: busyUntil,
    busyMsLeft: busyMsLeft, sweep: sweep,
    /* gates */
    acceptsNewOrders: acceptsNewOrders, cutoff: cutoff, closingTimeOf: closingTimeOf,
    scheduleOf: scheduleOf, isClosedDay: isClosedDay, DAYS: DAYS,
    hoursState: hoursState, kuwaitNow: kuwaitNow, kuwaitWallMs: kuwaitWallMs,
    /* scheduled */
    scheduleFor: scheduleFor, isScheduled: isScheduled, scheduledAt: scheduledAt,
    /* delivery availability */
    instantCutoffOf: instantCutoffOf, deliveryAvailability: deliveryAvailability,
    checkDeliveryChoice: checkDeliveryChoice, configureSlotPolicy: configureSlotPolicy, slotPolicy: slotPolicy,
    /* misc */
    offline: offline, watch: watch
  };
  sweep();
})(window);
