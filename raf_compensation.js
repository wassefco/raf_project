/* ============================================================================
 * RAF Marketplace — COMPENSATION AUTHORITY  (shared, headless) — Phase I
 * ----------------------------------------------------------------------------
 * The single owner of customer delay compensation: eligibility, the delay
 * calculation, one-time issuance of the Compensation Coupon, the coupon's
 * lifecycle, Void / Reverse and the compensation records.
 *
 * IT DOES NOT OWN (and never touches directly)
 *   · wallet balances / consumption / expiry → RAFWallet (expiring credit lots)
 *   · order state, Promised ETA, delivered time → RAFOrderEngine
 *   · notification transport → RAFNotify · audit → RAFAudit · events → RAFEventBus
 *   · configuration → RAFConfig · storage → RAFRecordStore
 *
 * APPROVED RULES (values from RAFConfig)
 *   · ON/OFF: 'compensation.enabled' — anything but true is OFF. OFF means no
 *     calculation for issuance, no record, no coupon, no wallet credit, no
 *     notification, no audit, no event. OFF affects NEW issuance only (checked once, here, at
 *     Delivered): a coupon issued while ON stays valid and addable until its
 *     original expiresAt; switching ON again issues nothing retroactively.
 *     Default OFF (no approved value for compensation.enabled).
 *   · Evaluated only after Delivered:
 *       delay     = DeliveredAt − PromisedETA   (RAFOrderEngine.deliveredAt /
 *                   promisedEtaAt = Merchant Accepted + 'eta.promisedDurationMinutes')
 *       eligible  = delay − 'compensation.excludedDelayMinutes' (90)
 *       blocks    = floor(eligible / 'compensation.stepMinutes' (20)), never < 0
 *       amount    = blocks × 'compensation.amountPerStepFils' (1000 fils = 1 KWD)
 *     Integer milliseconds and fils only — no rounding up, no proration.
 *   · Issued automatically ONCE per order (compensationId 'CMP-<orderId>');
 *     no automatic reissue. processDelivered(orderId) is the entry point; the
 *     delivery implementation that called it was decommissioned, so nothing
 *     triggers an issuance today.
 *   · The benefit is a Compensation Coupon, valid 'compensation.couponExpiryDays'
 *     (7) from issuance: expiresAt = issuedAt + 7 days, never extended.
 *   · The coupon can ONLY be added to RAF Wallet, by its customer, before
 *     expiry → RAFWallet.creditLot (an expiring Compensation Credit that
 *     expires at the SAME expiresAt).
 *   · Void (management, before the coupon is added) cancels the coupon;
 *     Reverse (management, after it is added) takes back the credit's unused
 *     remainder through RAFWallet.reverseLot. A reason is mandatory for both.
 *   · Customer notification on issuance, text from 'compensation.customerMessage'.
 *
 * ACCESS — identity from the session only
 *   customer                 own compensations: view, add coupon to wallet
 *   management (existing drivers.suspend — Ops Manager, Higher Management,
 *   Super Admin)             view all, Void, Reverse
 *   everyone else            refused (merchant, merchant employee, driver,
 *                            customer service, finance, anonymous)
 *
 * PROTOTYPE LIMITS — browser + localStorage: not a trusted financial boundary,
 * not transactional across records/wallet/audit/notification, and issuance
 * depended on a client calling processDelivered after a delivery completed.
 * Production needs a server-side, transactional, idempotent post-delivery
 * consumer and server-side authorisation.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFCompensation) return;

  var PERM_MANAGE = 'drivers.suspend';
  var MIN = 60000, DAY = 86400000;
  var LIMITS = { reason:500 };                       /* technical guard, not a business rule */

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية على التعويضات.',            en:'You do not have access to compensations.' },
    ACTOR_INACTIVE:     { ar:'حسابك غير نشط.',                            en:'Your account is not active.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',       en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:    { ar:'الطلب غير موجود.',                          en:'The order was not found.' },
    NOT_DELIVERED:      { ar:'لم يتم تسليم الطلب بعد.',                   en:'The order has not been delivered yet.' },
    ETA_UNAVAILABLE:    { ar:'الوقت الموعود للتسليم غير متاح لهذا الطلب.', en:'The promised delivery time is not available for this order.' },
    NOT_CONFIGURED:     { ar:'قيم التعويض غير مُهيّأة.',                   en:'Compensation values are not configured.' },
    NO_CUSTOMER:        { ar:'لا يوجد عميل مسجّل لهذا الطلب.',              en:'No customer is recorded for this order.' },
    NOT_FOUND:          { ar:'التعويض غير موجود.',                        en:'The compensation was not found.' },
    REASON_REQUIRED:    { ar:'السبب إلزامي.',                             en:'A reason is required.' },
    REASON_TOO_LONG:    { ar:'السبب طويل جدًا.',                          en:'The reason is too long.' },
    NOT_VOIDABLE:       { ar:'لا يمكن إبطال هذا التعويض في حالته الحالية.', en:'This compensation cannot be voided in its current state.' },
    NOT_REVERSIBLE:     { ar:'لا يمكن عكس هذا التعويض في حالته الحالية.',   en:'This compensation cannot be reversed in its current state.' },
    NOTHING_TO_REVERSE: { ar:'لا يوجد رصيد تعويض غير مستخدم لعكسه.',        en:'No unused compensation credit remains to reverse.' },
    COUPON_NOT_AVAILABLE:{ ar:'لا يمكن إضافة هذه القسيمة إلى المحفظة.',     en:'This coupon cannot be added to the wallet.' },
    COUPON_EXPIRED:     { ar:'انتهت صلاحية قسيمة التعويض.',                en:'The compensation coupon has expired.' },
    WALLET_FAILED:      { ar:'تعذّرت عملية المحفظة.',                       en:'The wallet operation failed.' },
    PERSIST_FAILED:     { ar:'تعذّر حفظ التعويض.',                          en:'The compensation could not be saved.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' }, r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  function coll(n){ return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; }
  function cfg(k){ return global.RAFConfig ? RAFConfig.value(k) : null; }
  function cfgGet(k){ var g = global.RAFConfig ? RAFConfig.get(k) : null; return g ? { value:g.value, status:g.status } : { value:null, status:'not_configured' }; }
  function me(){ try { return global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; } catch (e) { return null; } }
  function isManager(u){ try { return !!(u && u.status === 'active' && RAFPerm.can(u.id, PERM_MANAGE)); } catch (e) { return false; } }
  function orderOf(orderId){
    try { return (global.RAFShop ? RAFShop.Orders.all() : []).filter(function (o) { return o && o.id === orderId; })[0] || null; } catch (e) { return null; }
  }
  function fmtFils(f){ return global.RAFWallet ? RAFWallet.format(f) : (f / 1000).toFixed(3); }
  function fmtTime(ms, lang){
    try { return new Date(ms).toLocaleString(lang === 'en' ? 'en-GB' : 'ar-KW-u-nu-latn', { timeZone:'Asia/Kuwait', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }); }
    catch (e) { return new Date(ms).toISOString(); }
  }
  var WALLET_ACTOR = { id:'RAFCompensation', type:'system' };

  /* ---------- the calculation (pure, integer) ---------- */
  function rules(){
    return { enabled:cfg('compensation.enabled') === true, excludedMinutes:cfg('compensation.excludedDelayMinutes'),
             stepMinutes:cfg('compensation.stepMinutes'), amountPerStepFils:cfg('compensation.amountPerStepFils'),
             validityDays:cfg('compensation.couponExpiryDays') };
  }
  /* the ON/OFF switch as it stood at the delivered instant (RAFConfig owns the history) */
  function enabledAtDelivery(f){
    return !!(global.RAFConfig && RAFConfig.valueAt && f.deliveredAt != null && RAFConfig.valueAt('compensation.enabled', f.deliveredAt) === true);
  }
  function rulesConfigured(r){
    return [r.excludedMinutes, r.stepMinutes, r.amountPerStepFils, r.validityDays].every(function (v) { return typeof v === 'number' && Math.floor(v) === v && v > 0; });
  }
  function calculate(promisedAt, deliveredAt, r){
    var delayMs = deliveredAt - promisedAt;
    var eligibleMs = Math.max(0, delayMs - r.excludedMinutes * MIN);
    var blocks = Math.floor(eligibleMs / (r.stepMinutes * MIN));
    return { delayMs:delayMs, actualDelayMinutes:Math.floor(delayMs / MIN), excludedDelayMinutes:r.excludedMinutes,
             eligibleDelayMinutes:Math.floor(eligibleMs / MIN), stepMinutes:r.stepMinutes, completedBlocks:blocks,
             amountPerStepFils:r.amountPerStepFils, amountFils:blocks * r.amountPerStepFils };
  }
  /* the authoritative facts of a delivered order */
  function facts(o){
    var E = global.RAFOrderEngine, s = o.snapshot || {};
    var d = E && E.deliveredAt ? E.deliveredAt(o.id) : null, p = E && E.promisedEtaAt ? E.promisedEtaAt(o.id) : null;
    return { delivered:o.status === 'delivered' && !!d, deliveredAt:d ? d.at : null, deliveredSource:d ? d.source : null,
             promisedEtaAt:p ? p.at : null, promisedEtaSource:p ? p.source : null,
             customerId:(s.customer && s.customer.id) || null, storeSlug:s.storeSlug || null };
  }

  /* ---------- records ---------- */
  function idFor(orderId){ return 'CMP-' + orderId; }
  function recordOf(id){ var c = coll('compensations'); return c ? c.byId('compensationId', id) : null; }
  function eventsOf(id){ var c = coll('compensation_events'); return c ? c.filter(function (e) { return e.compensationId === id; }).sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); }) : []; }
  function lotOf(rec){
    if (!global.RAFWallet) return null;
    var r = RAFWallet.lotBySource(rec.customerId, WALLET_ACTOR, RAFWallet.LOT_SOURCE.COMPENSATION, rec.compensationId);
    return r && r.ok ? r.lot : null;
  }
  /* THE LIFECYCLE DECISION — Add to RAF Wallet and Void are mutually exclusive
     outcomes of an issued coupon. Both must first win ONE record with the SAME
     deterministic id ('cme|<id>|decision'); the first durable writer wins, the
     other is refused. RAFWallet credits a lot only when this record says
     'added_to_wallet' by the owning customer — so a coupon durably VOIDED can
     never be credited, whoever calls the wallet. If duplicates ever existed
     (a lost localStorage update across processes) the lowest seq decides. */
  function decisionId(id){ return 'cme|' + id + '|decision'; }
  function decisionOf(id){
    var c = coll('compensation_events'); if (!c) return null;
    return c.filter(function (e) { return e.eventId === decisionId(id); })
            .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })[0] || null;
  }
  /* append a decision, then read it back: success only if the stored winner is ours */
  function claimDecision(rec, entry){
    var a = coll('compensation_events').append('eventId', Object.assign({ eventId:decisionId(rec.compensationId),
      compensationId:rec.compensationId, orderId:rec.orderId, version:1 }, entry));
    if (!a.ok) return { ok:false, code:'PERSIST_FAILED' };
    var won = decisionOf(rec.compensationId);
    var mine = !!(won && !a.duplicate && won.type === entry.type && won.at === entry.at && won.actor && won.actor.id === entry.actor.id);
    return { ok:true, mine:mine, decision:won };
  }
  /* status is derived: record + the decision + lifecycle events + the wallet's own lot */
  function stateOf(rec, now){
    now = now == null ? Date.now() : now;
    var ev = eventsOf(rec.compensationId), lot = lotOf(rec), decision = decisionOf(rec.compensationId);
    var voided = decision && decision.type === 'voided' ? decision : null;
    var added = decision && decision.type === 'added_to_wallet' ? decision : null;
    var reversed = ev.filter(function (e) { return e.type === 'reversed'; })[0];
    var status;
    if (reversed || (lot && lot.status === 'reversed')) status = 'reversed';
    else if (voided) status = 'voided';
    else if (lot) status = lot.status === 'expired' ? 'expired' : lot.status === 'consumed' ? 'consumed' : 'in_wallet';
    else if (added) status = now >= rec.expiresAt ? 'expired' : 'add_pending';   /* Add won; the credit write did not land yet — the customer may retry */
    else status = now >= rec.expiresAt ? 'expired' : 'issued';
    return { status:status, lot:lot, events:ev, decision:decision, voided:voided, added:added, reversed:reversed || null };
  }

  /* SERIALIZATION — Add, Void and Reverse of one compensation run inside an
     exclusive Web Lock named per compensation. Web Locks are shared by every
     same-origin tab, window and frame of the browser, so these operations never
     interleave across tabs. Without the API the operation runs directly (a
     single JS thread is already atomic for this synchronous code) and the
     decision record above still guarantees one outcome. */
  function serialized(id, fn){
    var locks = null;
    try { locks = global.navigator && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null; } catch (e) { locks = null; }
    if (!locks) { try { return Promise.resolve(fn()); } catch (e) { return Promise.resolve(fail('PERSIST_FAILED')); } }
    return locks.request('raf-compensation:' + String(id), { mode:'exclusive' }, function () {
      try { return fn(); } catch (e) { return fail('PERSIST_FAILED'); }
    }).catch(function () { return fail('PERSIST_FAILED'); });
  }
  function message(rec, lang){
    var tpl = cfg('compensation.customerMessage'); if (!tpl) return null;
    var s = String(tpl[lang] || tpl.en || tpl.ar || ''), v = {
      orderId:rec.orderId, promisedEta:fmtTime(rec.promisedEtaAt, lang), startAt:fmtTime(rec.promisedEtaAt + rec.excludedDelayMinutes * MIN, lang),
      excludedMinutes:rec.excludedDelayMinutes, stepMinutes:rec.stepMinutes, amountPerStep:fmtFils(rec.amountPerStepFils),
      amount:fmtFils(rec.amountFils), validityDays:rec.validityDays, expiresAt:fmtTime(rec.expiresAt, lang) };
    Object.keys(v).forEach(function (k) { s = s.split('{' + k + '}').join(String(v[k])); });
    return s;
  }
  function view(rec, admin){
    var st = stateOf(rec), lot = st.lot;
    var out = { compensationId:rec.compensationId, orderId:rec.orderId, status:st.status,
      amount:fmtFils(rec.amountFils), amountFils:rec.amountFils, currency:'KWD',
      promisedEtaAt:rec.promisedEtaAt, deliveredAt:rec.deliveredAt, actualDelayMinutes:rec.actualDelayMinutes,
      excludedDelayMinutes:rec.excludedDelayMinutes, eligibleDelayMinutes:rec.eligibleDelayMinutes, stepMinutes:rec.stepMinutes,
      amountPerStep:fmtFils(rec.amountPerStepFils), completedBlocks:rec.completedBlocks,
      compensationStartsAt:rec.promisedEtaAt + rec.excludedDelayMinutes * MIN,
      issuedAt:rec.issuedAt, expiresAt:rec.expiresAt, validityDays:rec.validityDays, walletOnly:true,
      canAddToWallet:st.status === 'issued' || st.status === 'add_pending',
      wallet:lot ? { added:true, addedAt:lot.addedAt, original:lot.original, consumed:lot.consumed, expired:lot.expired, reversed:lot.reversed, remaining:lot.remaining, status:lot.status } : { added:false },
      message:{ ar:message(rec, 'ar'), en:message(rec, 'en') } };
    if (admin) {
      out.customerId = rec.customerId; out.storeSlug = rec.storeSlug; out.config = rec.config; out.createdBy = rec.createdBy;
      out.canVoid = st.status === 'issued';
      out.canReverse = !!(lot && (lot.status === 'active' || lot.status === 'partially_consumed') && lot.remainingMinor > 0) && !st.reversed;
      out.lifecycle = st.events.map(function (e) { return { type:e.type, at:e.at, reason:e.reason || null, actor:e.actor || null, amount:e.amountFils != null ? fmtFils(e.amountFils) : null }; });
      out.walletReference = lot ? { lotId:lot.lotId, creditTransactionId:lot.creditTransactionId, expiryTransactionId:lot.expiryTransactionId, reversalTransactionId:lot.reversalTransactionId } : null;
    }
    return out;
  }

  /* ---------- issuance (the post-delivery trigger) ---------- */
  function processDelivered(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var r = rules();
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var f = facts(o);
    if (!f.delivered) return fail('NOT_DELIVERED');
    /* FINAL RULE — OFF affects NEW issuance only, decided by the switch as it
       stood AT DELIVERED: OFF then ⇒ nothing, ever (switching ON later is never
       retroactive); ON then ⇒ issued once, and a later OFF never touches it. */
    if (!enabledAtDelivery(f)) return { ok:true, issued:false, reason:'COMPENSATION_OFF' };   /* OFF: nothing at all */
    var id = idFor(orderId), existing = recordOf(id);
    if (existing) { notifyIssued(existing); return { ok:true, issued:false, duplicate:true, compensationId:id }; }   /* once, ever */
    if (!rulesConfigured(r)) return fail('NOT_CONFIGURED');
    if (f.promisedEtaAt == null) return fail('ETA_UNAVAILABLE');
    if (!f.customerId) return fail('NO_CUSTOMER');
    var calc = calculate(f.promisedEtaAt, f.deliveredAt, r);
    if (calc.amountFils <= 0) return { ok:true, issued:false, reason:'NOT_ELIGIBLE', calculation:calc };
    var now = Date.now();
    var rec = Object.assign({ compensationId:id, couponReference:id, orderId:orderId, customerId:f.customerId, storeSlug:f.storeSlug,
      promisedEtaAt:f.promisedEtaAt, promisedEtaSource:f.promisedEtaSource, deliveredAt:f.deliveredAt, deliveredSource:f.deliveredSource },
      calc, { amountFils:calc.amountFils, issuedAt:now, validityDays:r.validityDays, expiresAt:now + r.validityDays * DAY,
      createdBy:{ type:'system', id:'RAFCompensation' },
      config:{ enabled:cfgGet('compensation.enabled'), excludedDelayMinutes:cfgGet('compensation.excludedDelayMinutes'), stepMinutes:cfgGet('compensation.stepMinutes'),
               amountPerStepFils:cfgGet('compensation.amountPerStepFils'), couponExpiryDays:cfgGet('compensation.couponExpiryDays') },
      version:1 });
    var a = coll('compensations').append('compensationId', rec);
    if (!a.ok) return fail('PERSIST_FAILED');
    if (a.duplicate) { notifyIssued(a.record); return { ok:true, issued:false, duplicate:true, compensationId:id }; }
    if (global.RAFAudit) {
      try { RAFAudit.record({ action:'compensation.issued', orderId:orderId, storeSlug:rec.storeSlug, systemGenerated:true, source:'automation', key:id,
              previousState:null, newState:'issued', metadata:{ compensationId:id, customerId:rec.customerId, amountFils:rec.amountFils,
              completedBlocks:rec.completedBlocks, promisedEtaAt:rec.promisedEtaAt, deliveredAt:rec.deliveredAt, issuedAt:rec.issuedAt, expiresAt:rec.expiresAt } }); } catch (e) {}
    }
    if (global.RAFEventBus) RAFEventBus.publish('compensation.issued', { entityId:orderId, storeSlug:rec.storeSlug, system:true, payload:{ compensationId:id } });
    var n = notifyIssued(rec);
    return { ok:true, issued:true, compensationId:id, amount:fmtFils(rec.amountFils), notified:!!(n && n.ok) };
  }
  /* one notification per compensation (dedupe key); failure never undoes issuance */
  function notifyIssued(rec){
    if (!global.RAFNotify || !RAFNotify.create) return null;
    var def = (RAFNotify.EVENT_TYPES || {})['compensation.issued'] || {};
    try {
      return RAFNotify.create({ recipientUserId:rec.customerId, eventType:'compensation.issued', title:def.title,
        message:{ ar:message(rec, 'ar') || '', en:message(rec, 'en') || '' }, entityType:'order', entityId:rec.orderId,
        href:'raf_tracking.html?id=' + encodeURIComponent(rec.orderId), source:'system', dedupeKey:'compensation.issued|' + rec.compensationId });
    } catch (e) { return { ok:false, reason:'notify_error' }; }
  }

  /* ---------- reads ---------- */
  function evaluate(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var o = orderOf(orderId);
    if (!isManager(u)) { if (!o || !o.snapshot || !o.snapshot.customer || o.snapshot.customer.id !== u.id) return fail('FORBIDDEN'); }
    if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var r = rules();
    var f = facts(o);
    if (f.delivered ? !enabledAtDelivery(f) : !r.enabled) return { ok:true, enabled:false };   /* no promise, no figures */
    if (!f.delivered) return fail('NOT_DELIVERED');
    if (!rulesConfigured(r)) return fail('NOT_CONFIGURED');
    if (f.promisedEtaAt == null) return fail('ETA_UNAVAILABLE');
    return { ok:true, enabled:true, orderId:orderId, promisedEtaAt:f.promisedEtaAt, deliveredAt:f.deliveredAt, calculation:calculate(f.promisedEtaAt, f.deliveredAt, r) };
  }
  function access(rec){
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    if (isManager(u)) return { ok:true, admin:true, user:u };
    if (rec && u.roleId === 'customer' && rec.customerId === u.id) return { ok:true, admin:false, user:u };
    return fail('FORBIDDEN');
  }
  function get(compensationId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var rec = recordOf(compensationId), a = access(rec); if (!a.ok) return a;
    if (!rec) return fail('NOT_FOUND');
    return { ok:true, compensation:view(rec, a.admin) };
  }
  function forOrder(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var o = orderOf(orderId);
    var owner = !!(o && o.snapshot && o.snapshot.customer && o.snapshot.customer.id === u.id && u.roleId === 'customer');
    if (!owner && !isManager(u)) return fail('FORBIDDEN');
    var rec = recordOf(idFor(orderId));
    return { ok:true, compensation:rec ? view(rec, isManager(u)) : null };
  }
  function mine(opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u || u.roleId !== 'customer') return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var c = coll('compensations');
    return { ok:true, compensations:(c ? c.filter(function (x) { return x.customerId === u.id; }) : []).sort(function (a, b) { return b.issuedAt - a.issuedAt; }).map(function (x) { return view(x, false); }) };
  }
  function list(opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    if (!isManager(u)) return fail('FORBIDDEN');
    var c = coll('compensations');
    return { ok:true, compensations:(c ? c.all() : []).sort(function (a, b) { return b.issuedAt - a.issuedAt; }).map(function (x) { return view(x, true); }) };
  }

  /* ---------- customer: add the coupon to RAF Wallet ----------
     Order inside the lock: authorise → win the decision (durable, read back)
     → only then ask RAFWallet for the credit. A Void that won first makes this
     fail before any wallet call; RAFWallet re-checks the decision itself. */
  function addToWalletNow(compensationId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var rec = recordOf(compensationId);
    if (!rec || u.roleId !== 'customer' || rec.customerId !== u.id) return fail('FORBIDDEN');
    var st = stateOf(rec);
    if (st.voided) return fail('COUPON_NOT_AVAILABLE', { status:'voided' });
    if (st.lot) return { ok:true, duplicate:true, compensation:view(rec, false) };
    if (st.status === 'expired') return fail('COUPON_EXPIRED');
    if (st.status !== 'issued' && st.status !== 'add_pending') return fail('COUPON_NOT_AVAILABLE', { status:st.status });
    if (!global.RAFWallet) return fail('WALLET_FAILED');
    if (!st.added) {
      var at = Date.now();
      if (at >= rec.expiresAt) return fail('COUPON_EXPIRED');
      var d = claimDecision(rec, { type:'added_to_wallet', at:at, actor:{ type:'customer', id:u.id }, amountFils:rec.amountFils });
      if (!d.ok) return fail('PERSIST_FAILED');
      if (!d.mine) {
        if (d.decision && d.decision.type === 'voided') return fail('COUPON_NOT_AVAILABLE', { status:'voided' });
        if (!(d.decision && d.decision.type === 'added_to_wallet' && d.decision.actor.id === u.id)) return fail('COUPON_NOT_AVAILABLE');
      }
    } else if (st.added.actor.id !== u.id) return fail('FORBIDDEN');
    var w = RAFWallet.creditLot({ customerId:rec.customerId, amount:RAFWallet.toMajor(rec.amountFils), orderId:rec.orderId,
      idempotencyKey:'compensation-credit|' + rec.compensationId, source:{ type:RAFWallet.LOT_SOURCE.COMPENSATION, id:rec.compensationId },
      issuedAt:rec.issuedAt, expiresAt:rec.expiresAt, actor:{ id:u.id, name:u.name, type:'customer' } });
    if (!w.ok) return w.code === 'LOT_EXPIRED' ? fail('COUPON_EXPIRED') : fail('WALLET_FAILED', { wallet:w.code });
    /* the event is published once: only by the call whose wallet credit was new */
    if (!w.duplicate && global.RAFEventBus)
      RAFEventBus.publish('compensation.added_to_wallet', { entityId:rec.orderId, storeSlug:rec.storeSlug, payload:{ compensationId:rec.compensationId } });
    return { ok:true, duplicate:!!w.duplicate, compensation:view(rec, false) };
  }
  function addToWallet(compensationId, opts){
    return serialized(compensationId, function () { return addToWalletNow(compensationId, opts); });
  }

  /* ---------- management: Void / Reverse ---------- */
  function reasonOf(opts){
    var s = opts && typeof opts.reason === 'string' ? opts.reason.trim() : '';
    if (!s) return fail('REASON_REQUIRED');
    if (s.length > LIMITS.reason) return fail('REASON_TOO_LONG');
    return { ok:true, reason:s };
  }
  function manage(compensationId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['reason'])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    if (!isManager(u)) return fail('FORBIDDEN');
    var rs = reasonOf(opts); if (!rs.ok) return rs;
    var rec = recordOf(compensationId); if (!rec) return fail('NOT_FOUND');
    return { ok:true, user:u, reason:rs.reason, rec:rec };
  }
  /* Void: only an issued coupon nobody has claimed yet. Winning the decision is
     what makes it void; an Add that won first makes this refuse (use Reverse). */
  function voidNow(compensationId, opts){
    var m = manage(compensationId, opts); if (!m.ok) return m;
    var rec = m.rec, st = stateOf(rec);
    if (st.status !== 'issued') return fail('NOT_VOIDABLE', { status:st.status });
    var at = Date.now();
    if (at >= rec.expiresAt) return fail('NOT_VOIDABLE', { status:'expired' });
    var d = claimDecision(rec, { type:'voided', at:at, reason:m.reason, actor:{ type:'staff', id:m.user.id, name:m.user.name, roleId:m.user.roleId }, previousStatus:'issued' });
    if (!d.ok) return fail('PERSIST_FAILED');
    if (!d.mine) return fail('NOT_VOIDABLE', { status:d.decision && d.decision.type === 'voided' ? 'voided' : 'added_to_wallet' });
    if (lotOf(rec)) return fail('NOT_VOIDABLE', { status:'in_wallet' });   /* impossible by construction: the wallet needs an Add decision */
    if (global.RAFAudit) {
      try { RAFAudit.record({ action:'compensation.voided', orderId:rec.orderId, storeSlug:rec.storeSlug, actor:{ id:m.user.id }, source:'admin', key:rec.compensationId,
              previousState:'issued', newState:'voided', reason:m.reason, metadata:{ compensationId:rec.compensationId, customerId:rec.customerId, amountFils:rec.amountFils } }); } catch (e) {}
    }
    if (global.RAFEventBus) RAFEventBus.publish('compensation.voided', { entityId:rec.orderId, source:'admin', storeSlug:rec.storeSlug, payload:{ compensationId:rec.compensationId } });
    return { ok:true, compensation:view(rec, true) };
  }
  function voidCompensation(compensationId, opts){
    return serialized(compensationId, function () { return voidNow(compensationId, opts); });
  }
  function reverseCompensation(compensationId, opts){
    return serialized(compensationId, function () { return reverseNow(compensationId, opts); });
  }
  function reverseNow(compensationId, opts){
    var m = manage(compensationId, opts); if (!m.ok) return m;
    var rec = m.rec, st = stateOf(rec);
    if (st.reversed) return fail('NOT_REVERSIBLE', { status:'reversed' });
    if (!st.lot || (st.lot.status === 'expired')) return fail('NOT_REVERSIBLE', { status:st.status });
    if (!(st.lot.remainingMinor > 0)) return fail('NOTHING_TO_REVERSE');
    var previous = st.status;
    var w = RAFWallet.reverseLot({ customerId:rec.customerId, lotId:st.lot.lotId, idempotencyKey:'compensation-reversal|' + rec.compensationId, actor:WALLET_ACTOR });
    if (!w.ok) return w.code === 'LOT_NOTHING_REMAINING' ? fail('NOTHING_TO_REVERSE') : w.code === 'LOT_EXPIRED' ? fail('NOT_REVERSIBLE', { status:'expired' }) : fail('WALLET_FAILED', { wallet:w.code });
    var amountFils = RAFWallet.toMinor(w.transaction.amount);
    var a = coll('compensation_events').append('eventId', { eventId:'cme|' + rec.compensationId + '|reversed', compensationId:rec.compensationId, orderId:rec.orderId,
      type:'reversed', at:Date.now(), reason:m.reason, actor:{ type:'staff', id:m.user.id, name:m.user.name, roleId:m.user.roleId }, previousStatus:previous,
      walletTransactionId:w.transaction.id, amountFils:amountFils, version:1 });
    if (!a.ok) return fail('PERSIST_FAILED');
    if (!a.duplicate) {
      if (global.RAFAudit) {
        try { RAFAudit.record({ action:'compensation.reversed', orderId:rec.orderId, storeSlug:rec.storeSlug, actor:{ id:m.user.id }, source:'admin', key:rec.compensationId,
                previousState:previous, newState:'reversed', reason:m.reason, metadata:{ compensationId:rec.compensationId, customerId:rec.customerId,
                amountFils:rec.amountFils, reversedFils:amountFils, walletTransactionId:w.transaction.id } }); } catch (e) {}
      }
      if (global.RAFEventBus) RAFEventBus.publish('compensation.reversed', { entityId:rec.orderId, source:'admin', storeSlug:rec.storeSlug, payload:{ compensationId:rec.compensationId } });
    }
    return { ok:true, reversed:fmtFils(amountFils), compensation:view(rec, true) };
  }

  global.RAFCompensation = {
    ERRORS:ERRORS, processDelivered:processDelivered, evaluate:evaluate, get:get, forOrder:forOrder, mine:mine, list:list,
    /* lifecycle writes return a Promise: they run serialized per compensation */
    addToWallet:addToWallet, void:voidCompensation, reverse:reverseCompensation
  };
})(window);
