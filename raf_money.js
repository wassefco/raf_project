/* ============================================================================
 * RAF Marketplace — MONEY AUTHORITY  (RAFMoney · shared, headless)
 * ----------------------------------------------------------------------------
 * The record of VERIFIED money evidence. It answers four questions, and only
 * from evidence that actually exists:
 *     Did the customer pay?      → a payment and its evidence events
 *     Where is that money now?   → custody, derived from the evidence
 *     For COD, which driver holds the cash?
 *     Has Accounting physically accepted it?
 *
 * IT IS NOT A PAYMENT GATEWAY. No provider (KNET, card, aggregator) is
 * implemented or chosen. An order's own "paid" / "cod" flag
 * (snapshot.commercial.paymentStatus) is NEVER treated as proof of payment:
 * checkout writes "paid" as a prototype confirmation.
 *
 * WHAT IT OWNS — and what it does not
 *   owns     payments (one per order), their evidence events, COD collections,
 *            COD cash handovers and their acceptance
 *   reads    the order's immutable snapshot (RAFOrderSnapshot: amount,
 *            method, customer, assigned driver, delivery), wallet transactions
 *            (RAFWallet — the one wallet authority, never copied), identity
 *            and permissions (RAFPerm)
 *   never    posts accounting journals, recognises revenue, decides any
 *            accounting treatment, or keeps a balance
 *
 * MONEY — integer fils only. Amounts from the snapshot (3-decimal KWD
 * strings) are converted by string arithmetic, never by floating point.
 *
 * PAYMENT
 *   method      online | cod | wallet | mixed  (from the order's own snapshot:
 *               cod → cod, knet / visa → online, wallet → wallet,
 *               mixed → mixed with caller-declared components)
 *   status      pending → received | failed | cancelled   (final states are
 *               final). Derived from evidence events, never stored mutably.
 *               A mixed payment's status is derived from its components.
 *   evidence    online  → an external provider + reference (the provider
 *                         itself is future work)
 *               cod     → the driver's COD collection
 *               wallet  → an existing RAFWallet debit for this order
 *   custody     online received   → gateway_receivable (no bank settlement
 *                                   is ever claimed: none is recorded)
 *               cod collected     → driver_cod (the collecting driver)
 *               cod handover accepted → raf_cash
 *               wallet received   → raf_wallet
 *
 * COD — three separate facts, never merged:
 *   COLLECTED   the driver received the customer's cash   → driver custody
 *   SUBMITTED   the driver handed a set of collections in  → still the driver's
 *   ACCEPTED    Accounting physically received the cash    → RAF holds it
 *   A driver's outstanding COD = Σ collected − Σ collections in ACCEPTED
 *   handovers. It is derived every time, explainable record by record, and
 *   nothing — not Logistics, not the driver — can set or clear it. Only an
 *   acceptance reduces it.
 *
 * NOT DECIDED HERE (business decisions; every one is refused, never guessed):
 *   a collected amount that differs from the order amount, a counted amount
 *   that differs from a handover, splitting one collection across handovers,
 *   withdrawing / rejecting a handover, deposit deadlines, cash limits,
 *   penalties, bank deposits / reconciliation, gateway settlement and fees,
 *   wallet / refund / tax accounting.
 *
 * PERMISSIONS (existing keys only — none added)
 *   customer     records the payment of their OWN order; links their OWN
 *                wallet debit (proved by RAFWallet in their own session)
 *   driver       records the COD collection of an order assigned to them and
 *                delivered; submits handovers of their OWN collections; reads
 *                their own COD
 *   drivers.view (Logistics) reads COD collections, handovers, driver COD
 *   accounting.view reads payments, COD, exposure, settlement evidence
 *   accounting.post records external payment evidence, failures,
 *                cancellations; ACCEPTS a cash handover
 *   Staff must be an active RAF Management account (accountType 'staff', not
 *   a store account). A caller-supplied actor / driver / customer is never
 *   trusted: identity is the signed-in session.
 *
 * STORAGE — RAFRecordStore, all append-only: money_payments,
 * money_payment_events, money_cod_collections, money_cod_handovers,
 * money_cod_handover_events. PROTOTYPE LIMIT: the localStorage adapter is not
 * atomic; every write re-reads right before appending.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFMoney) return;

  var VERSION = 1;
  var CURRENCY = 'KWD';
  var METHOD = { ONLINE:'online', COD:'cod', WALLET:'wallet', MIXED:'mixed' };
  var COMPONENT_METHODS = ['online', 'cod', 'wallet'];
  /* the snapshot's payment method id → the domain method */
  var METHOD_OF = { cod:'cod', knet:'online', visa:'online', wallet:'wallet', mixed:'mixed' };
  var STATUS = { PENDING:'pending', RECEIVED:'received', FAILED:'failed', CANCELLED:'cancelled' };
  var CUSTODY = { NONE:null, GATEWAY:'gateway_receivable', DRIVER:'driver_cod', RAF_CASH:'raf_cash', WALLET:'raf_wallet' };
  var HANDOVER = { SUBMITTED:'submitted', ACCEPTED:'accepted' };
  var P = { DRIVERS_VIEW:'drivers.view', ACC_VIEW:'accounting.view', ACC_POST:'accounting.post' };
  var LIMITS = { provider:40, reference:120, reason:300 };

  function isEn(){ var r = global.document && (document.getElementById('htmlRoot') || document.documentElement); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAVAILABLE:            { ar:'تعذّر الوصول إلى سجل الأموال.',                            en:'The money record is unavailable.' },
    UNAUTHENTICATED:        { ar:'يلزم تسجيل الدخول.',                                       en:'Sign-in is required.' },
    ACTOR_INACTIVE:         { ar:'لا يمكن تنفيذ الإجراء بحساب موقوف.',                       en:'A suspended account cannot perform this action.' },
    FORBIDDEN:              { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',                        en:'You do not have permission for this action.' },
    FIELD_NOT_ACCEPTED:     { ar:'تحتوي البيانات على حقول غير مقبولة.',                      en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:        { ar:'الطلب غير موجود.',                                         en:'The order does not exist.' },
    AMOUNT_UNRECORDED:      { ar:'مبلغ الطلب غير مسجّل في سجله.',                            en:'The order amount is not recorded on the order.' },
    METHOD_UNSUPPORTED:     { ar:'طريقة الدفع في سجل الطلب غير مدعومة.',                     en:'The order\'s payment method is not supported.' },
    COMPONENTS_INVALID:     { ar:'مكوّنات الدفع المختلط غير صالحة.',                         en:'The mixed-payment components are not valid.' },
    PAYMENT_CONFLICT:       { ar:'لهذا الطلب دفعة مسجّلة بتفاصيل مختلفة.',                   en:'This order already has a payment recorded with different details.' },
    PAYMENT_NOT_FOUND:      { ar:'الدفعة غير موجودة.',                                       en:'The payment does not exist.' },
    COMPONENT_NOT_FOUND:    { ar:'مكوّن الدفع غير موجود.',                                   en:'The payment component does not exist.' },
    WRONG_METHOD:           { ar:'هذه العملية لا تنطبق على طريقة الدفع هذه.',                en:'This operation does not apply to this payment method.' },
    INVALID_TRANSITION:     { ar:'لا يمكن تغيير حالة الدفعة بهذا الشكل.',                    en:'The payment cannot change status this way.' },
    EXTERNAL_REF_REQUIRED:  { ar:'مزوّد الدفع ومرجعه مطلوبان.',                              en:'The payment provider and its reference are required.' },
    EXTERNAL_REF_USED:      { ar:'مرجع مزوّد الدفع مستخدم لدفعة أخرى.',                      en:'This provider reference is already used by another payment.' },
    ORDER_NOT_CANCELLED:    { ar:'لا يُلغى الدفع إلا لطلب ملغى.',                            en:'A payment can only be cancelled for a cancelled order.' },
    WALLET_TX_INVALID:      { ar:'معاملة المحفظة غير موجودة أو لا تطابق هذا الطلب.',         en:'The wallet transaction does not exist or does not match this order.' },
    WALLET_TX_USED:         { ar:'معاملة المحفظة مرتبطة بدفعة أخرى.',                        en:'The wallet transaction is already linked to another payment.' },
    NOT_A_DRIVER:           { ar:'هذا الإجراء للسائق فقط.',                                  en:'This action is for a driver only.' },
    NOT_YOUR_DELIVERY:      { ar:'هذا الطلب ليس مسنداً إليك.',                               en:'This order is not assigned to you.' },
    NOT_DELIVERED:          { ar:'لم يُسلَّم الطلب بعد.',                                    en:'The order has not been delivered yet.' },
    AMOUNT_INVALID:         { ar:'المبلغ غير صالح.',                                         en:'The amount is not valid.' },
    AMOUNT_MISMATCH:        { ar:'المبلغ لا يطابق المبلغ المستحق، ولا توجد سياسة معتمدة للفروقات.', en:'The amount does not match what is due, and no discrepancy policy exists.' },
    COLLECTION_CONFLICT:    { ar:'لهذا الطلب تحصيل مسجّل بتفاصيل مختلفة.',                   en:'This order already has a collection recorded with different details.' },
    COLLECTION_NOT_FOUND:   { ar:'التحصيل غير موجود.',                                       en:'The collection does not exist.' },
    COLLECTION_NOT_YOURS:   { ar:'التحصيل ليس لك.',                                          en:'The collection is not yours.' },
    COLLECTION_IN_HANDOVER: { ar:'التحصيل مُدرج في تسليم آخر.',                              en:'The collection is already part of another handover.' },
    HANDOVER_EMPTY:         { ar:'اختر التحصيلات التي تُسلَّم.',                             en:'Choose the collections being handed over.' },
    HANDOVER_NOT_FOUND:     { ar:'التسليم غير موجود.',                                       en:'The handover does not exist.' },
    PERSIST_FAILED:         { ar:'تعذّر الحفظ.',                                             en:'Could not save.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function isObj(o){ return !!o && typeof o === 'object' && !Array.isArray(o); }
  function badKeys(o, allowed){ return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; }); }
  function text(v){ return typeof v === 'string' ? v.trim() : ''; }
  function isFils(v){ return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }
  function Perm(){ return global.RAFPerm || null; }
  function coll(n){ try { return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; } catch (e) { return null; } }
  function rows(n){ var c = coll(n); return c ? c.all() : []; }
  function newId(prefix){ return global.RAFRecordStore ? RAFRecordStore.makeId(prefix) : prefix + '-' + Date.now().toString(36); }
  /* '24.500' → 24500, by string arithmetic. Anything else → null. */
  function filsOf(s){
    if (typeof s === 'number') s = String(s);
    if (typeof s !== 'string' || !/^\d+(\.\d{1,3})?$/.test(s.trim())) return null;
    var p = s.trim().split('.'), f = (p[1] || '') + '000';
    var v = parseInt(p[0], 10) * 1000 + parseInt(f.slice(0, 3), 10);
    return Number.isSafeInteger(v) ? v : null;
  }

  /* ══════════════════════ IDENTITY ══════════════════════ */
  function me(){
    var R = Perm(); if (!R || !global.RAFRecordStore) return fail('UNAVAILABLE');
    var sid = null; try { sid = R.sessionUserId ? R.sessionUserId() : null; } catch (e) { sid = null; }
    var u = sid ? R.getUser(sid) : null;
    if (!u || !u.id) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var staff = false; try { staff = u.accountType === 'staff' && !R.isMerchant(u.id); } catch (e) { staff = false; }
    return { ok:true, id:u.id, name:u.name || null, accountType:u.accountType, staff:staff,
             can:function (k) { try { return staff && !!R.can(u.id, k); } catch (e) { return false; } } };
  }
  function staffWith(a, keys){ return a.staff && keys.some(function (k) { return a.can(k); }); }

  function audit(action, a, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try {
      var o = { action:action, source:a && a.accountType === 'driver' ? 'driver' : a && a.staff ? 'admin' : 'customer' };
      if (a && a.id) o.actor = { id:a.id };
      for (var k in (extra || {})) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return RAFAudit.record(o);
    } catch (e) { return null; }
  }
  /* a refused money operation by an identified account — once per operation / target / reason */
  function refuse(a, op, target, r){
    if (a && a.ok) audit('money.operation_refused', a, { key:[op, target || '-', r.code, a.id].join('|'), reason:r.code,
      metadata:{ operation:op, target:target || null, code:r.code } });
    return r;
  }

  /* ══════════════════════ ORDER FACTS (read-only) ══════════════════════ */
  function snapOf(orderId){
    if (typeof orderId !== 'string' || !orderId || !global.RAFOrderSnapshot) return null;
    try { return RAFOrderSnapshot.of(orderId) || null; } catch (e) { return null; }
  }
  function orderStatusOf(orderId){
    try { var o = global.RAFShop ? RAFShop.Orders.get(orderId) : null; return o ? o.status || null : null; } catch (e) { return null; }
  }
  /* COD rule (confirmed): a product removed before the customer pays is simply
     not collected. The amounts RAFOrderChanges refunded to the ORIGINAL payment
     (recorded on the order record as refunds[] destination original_payment)
     are therefore not due at the door. Read-only, from the order record. */
  function originalPaymentRefundFils(orderId){
    var o = null; try { o = global.RAFShop ? RAFShop.Orders.get(orderId) : null; } catch (e) { o = null; }
    var sum = 0, bad = false;
    ((o && o.refunds) || []).forEach(function (r) {
      if (!r || r.destination !== 'original_payment') return;
      var v = filsOf(r.amount); if (v === null) bad = true; else sum += v;
    });
    return bad ? null : sum;
  }
  /* what the customer owes for an order paid by this method. For COD it is the
     AUTHORITATIVE CURRENT payable: the live order total that RAFOrderChanges
     recomputes (applyInvoice) when a product is removed or replaced — so a
     removed product is never collected. Every other method owes the order's
     checkout total (money taken at checkout; later changes are refunds). */
  function amountDueFils(orderId, s, method){
    var total = filsOf((s.commercial || {}).grandTotal);
    if (total === null || method !== METHOD.COD) return total;
    /* the live order total is the amount only once RAFOrderChanges has applied
       a change to the invoice; without one the snapshot stays authoritative */
    var applied = false;
    try { applied = !!(global.RAFOrderChanges && RAFOrderChanges.historyOf && (RAFOrderChanges.historyOf(orderId) || []).some(function (c) { return c && c.state === 'applied'; })); } catch (e) { applied = false; }
    if (!applied) return total;
    var o = null; try { o = global.RAFShop ? RAFShop.Orders.get(orderId) : null; } catch (e) { o = null; }
    if (!o || o.total == null) return total;
    var live = filsOf(String(o.total));
    return live === null ? null : live;
  }
  function deliveredAtOf(orderId, s){
    var f = (s && s.fulfilment) || {};
    if (f.deliveredAt) return f.deliveredAt;
    try { return global.RAFOrderEngine && RAFOrderEngine.deliveredAt ? (RAFOrderEngine.deliveredAt(orderId) || null) : null; } catch (e) { return null; }
  }

  /* ══════════════════════ PAYMENTS (derived view) ══════════════════════ */
  function paymentRow(id){ return rows('money_payments').filter(function (p) { return p.paymentId === id; })[0] || null; }
  function paymentRowOfOrder(orderId){ if (!orderId) return null; return rows('money_payments').filter(function (p) { return p.orderId === orderId; })[0] || null; }
  function eventsOf(paymentId){ return rows('money_payment_events').filter(function (e) { return e.paymentId === paymentId; }).sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); }); }
  function collectionOfOrder(orderId){ return rows('money_cod_collections').filter(function (c) { return c.orderId === orderId; })[0] || null; }
  function acceptedHandoverIds(){
    var m = {}; rows('money_cod_handover_events').forEach(function (e) { if (e.kind === 'accepted') m[e.handoverId] = e; }); return m;
  }
  function handoverOfCollection(collectionId){
    return rows('money_cod_handovers').filter(function (h) { return h.collectionIds.indexOf(collectionId) > -1; })[0] || null;
  }
  /* one component's status, custody and evidence — from its events only */
  function componentState(pay, comp, evs, accepted){
    var mine = evs.filter(function (e) { return e.componentId === comp.componentId; });
    var fin = mine.filter(function (e) { return e.kind === 'received' || e.kind === 'failed' || e.kind === 'cancelled'; })[0] || null;
    var st = fin ? fin.kind : STATUS.PENDING, custody = CUSTODY.NONE, holder = null;
    if (st === STATUS.RECEIVED) {
      var ev = fin.evidence || {};
      if (comp.method === METHOD.ONLINE) custody = CUSTODY.GATEWAY;
      else if (comp.method === METHOD.WALLET) custody = CUSTODY.WALLET;
      else if (comp.method === METHOD.COD) {
        var h = ev.collectionId ? handoverOfCollection(ev.collectionId) : null;
        if (h && accepted[h.handoverId]) custody = CUSTODY.RAF_CASH;
        else { custody = CUSTODY.DRIVER; holder = ev.driverId || null; }
      }
    }
    /* the component's CURRENT amount: its latest revision (an approved order
       change before collection), never overwriting what was first recorded */
    var revs = mine.filter(function (e) { return e.kind === 'amount_revised'; });
    var amount = revs.length ? revs[revs.length - 1].toFils : comp.amountFils;
    return { componentId:comp.componentId, method:comp.method, amountFils:amount, originalAmountFils:comp.amountFils, status:st,
             custody:custody, driverId:holder, evidence:fin ? copy(fin.evidence) : null, statusAt:fin ? fin.at : null };
  }
  /* the driver tip INSIDE the payment (confirmed: part of the grand total,
     never added on top, never RAF money). Read from the order's own snapshot —
     nothing is stored here. ALLOCATION (confirmed, deterministic):
       · a single-component payment → that component;
       · Wallet + K-Net → the LARGER component first (equal → the Wallet
         first); if the tip is larger than it, the rest of the tip comes from
         the other component. Never more than a component holds, never more
         than the payment, never counted twice. What is left of each component
         funds the non-tip (commercial) part of the order.
     The allocation comes only from the payment's own (immutable) components. */
  /* the allocation itself: amounts already in funding ORDER (larger first,
     Wallet first on a tie); each gives min(what is left of the tip, itself).
     null when the components cannot cover the tip. Pure — no records. */
  function allocate(amounts, tip){
    var left = tip, out = amounts.map(function (v) { var x = Math.min(left, v); left -= x; return x; });
    return left > 0 ? null : out;
  }
  /* the confirmed Wallet + K-Net rule as a pure calculation (for verification) */
  function allocateTip(input){
    var w = input && input.walletFils, k = input && input.onlineFils, t = input && input.tipFils;
    if (![w, k, t].every(function (v) { return isFils(v); }) || t > w + k) return { ok:false, code:'TIP_EXCEEDS_PAYMENT' };
    var walletFirst = w >= k, tk = allocate(walletFirst ? [w, k] : [k, w], t);
    var wt = walletFirst ? tk[0] : tk[1], kt = walletFirst ? tk[1] : tk[0];
    return { ok:true, grandTotalFils:w + k, tipFils:t, first:walletFirst ? 'wallet' : 'online',
             wallet:{ amountFils:w, tipFils:wt, nonTipFils:w - wt }, online:{ amountFils:k, tipFils:kt, nonTipFils:k - kt } };
  }
  function tipComponent(pay){
    var s = snapOf(pay.orderId), t = s ? filsOf((s.commercial || {}).driverTip) : null;
    if (t === null) return { amountFils:null, funding:'unrecorded' };
    if (t === 0) return { amountFils:0, funding:null };
    var cs = pay.components, order;
    if (cs.length === 1) order = [cs[0]];
    else if (cs.length === 2) {
      var w = cs.filter(function (c) { return c.method === METHOD.WALLET; })[0], k = cs.filter(function (c) { return c.method === METHOD.ONLINE; })[0];
      if (!w || !k) return { amountFils:t, funding:'unresolved', code:'MIXED_TIP_COMPONENTS_UNSUPPORTED' };
      order = w.amountFils >= k.amountFils ? [w, k] : [k, w];
    } else return { amountFils:t, funding:'unresolved', code:'MIXED_TIP_COMPONENTS_UNSUPPORTED' };
    var take = allocate(order.map(function (c) { return c.amountFils; }), t);
    if (!take) return { amountFils:t, funding:'unresolved', code:'TIP_EXCEEDS_PAYMENT' };
    take = (function (tk) { var m = {}; order.forEach(function (c, i) { m[c.componentId] = tk[i]; }); return m; })(take);
    var funders = order.filter(function (c) { return take[c.componentId] > 0; });
    return { amountFils:t, funding:'resolved', split:funders.length > 1,
             componentId:funders.length === 1 ? funders[0].componentId : null, method:funders.length === 1 ? funders[0].method : 'split',
             walletTipFils:cs.filter(function (c) { return c.method === METHOD.WALLET; }).reduce(function (s0, c) { return s0 + take[c.componentId]; }, 0),
             onlineTipFils:cs.filter(function (c) { return c.method === METHOD.ONLINE; }).reduce(function (s0, c) { return s0 + take[c.componentId]; }, 0),
             allocation:cs.map(function (c) { var tf = take[c.componentId];
               return { componentId:c.componentId, method:c.method, amountFils:c.amountFils, tipFils:tf, nonTipFils:c.amountFils - tf }; }) };
  }
  /* the tip's funding for an order — no amounts beyond the tip, no identities
     (RAFDriverTips / RAFWallet read it from any session that handles the order) */
  function tipFundingFor(orderId){
    var pay = paymentRowOfOrder(orderId); if (!pay) return null;
    var v = present(pay), wc = v.components.filter(function (c) { return c.method === METHOD.WALLET; })[0] || null;
    return { paymentId:pay.paymentId, status:v.status, driverTip:copy(v.driverTip),
             walletTransactionId:wc && wc.evidence && wc.evidence.type === 'wallet_transaction' ? wc.evidence.walletTransactionId : null };
  }
  function present(pay){
    var evs = eventsOf(pay.paymentId), acc = acceptedHandoverIds();
    var comps = pay.components.map(function (c) { return componentState(pay, c, evs, acc); });
    var st;
    if (comps.every(function (c) { return c.status === STATUS.RECEIVED; })) st = STATUS.RECEIVED;
    else if (comps.some(function (c) { return c.status === STATUS.FAILED; })) st = STATUS.FAILED;
    else if (comps.some(function (c) { return c.status === STATUS.CANCELLED; })) st = STATUS.CANCELLED;
    else st = STATUS.PENDING;
    var last = evs.length ? evs[evs.length - 1].at : pay.createdAt;
    return { paymentId:pay.paymentId, orderId:pay.orderId, customerId:pay.customerId, paymentMethod:pay.method,
             totalAmountFils:comps.reduce(function (t, c) { return t + c.amountFils; }, 0), originalAmountFils:pay.totalAmountFils,
             driverTip:pay.orderId ? tipComponent(pay) : null, purpose:pay.purpose || 'order', purposeRef:pay.purposeRef || null,
             currency:pay.currency, status:st, components:comps,
             externalProvider:comps.map(function (c) { return c.evidence && c.evidence.provider; }).filter(Boolean)[0] || null,
             externalReference:comps.map(function (c) { return c.evidence && c.evidence.reference; }).filter(Boolean)[0] || null,
             sourceReference:pay.sourceReference, createdAt:pay.createdAt, updatedAt:last,
             events:evs.map(function (e) { var v = { eventId:e.eventId, componentId:e.componentId, kind:e.kind, at:e.at, by:e.by, evidence:copy(e.evidence), reason:e.reason || null };
               if (e.kind === 'amount_revised') { v.fromFils = e.fromFils; v.toFils = e.toFils; }
               return v; }) };
  }

  /* may this account read / write this payment? */
  function ownsPayment(a, pay){ return a.accountType === 'customer' && pay.customerId && pay.customerId === a.id; }

  /* ── record the payment of an order (idempotent: one per order) ── */
  function recordPayment(orderId, opts){
    opts = opts || {};
    var a = me(); if (!a.ok) return a;
    if (!isObj(opts) || badKeys(opts, ['components']).length) return refuse(a, 'record_payment', orderId, fail('FIELD_NOT_ACCEPTED', { fields:badKeys(opts, ['components']) }));
    var s = snapOf(orderId); if (!s) return refuse(a, 'record_payment', orderId, fail('ORDER_NOT_FOUND'));
    var customerId = (s.customer && s.customer.id) || null;
    var driverOk = a.accountType === 'driver' && s.fulfilment && s.fulfilment.driverId === a.id;
    if (!(a.accountType === 'customer' && customerId === a.id) && !driverOk && !staffWith(a, [P.ACC_POST])) return refuse(a, 'record_payment', orderId, fail('FORBIDDEN'));
    return ensurePayment(a, orderId, s, opts.components);
  }
  function ensurePayment(a, orderId, s, components){
    var c = s.commercial || {};
    var method = METHOD_OF[c.paymentMethod && c.paymentMethod.id];
    if (!method) return refuse(a, 'record_payment', orderId, fail('METHOD_UNSUPPORTED', { snapshotMethod:(c.paymentMethod && c.paymentMethod.id) || null }));
    /* the amount due: the order total — for COD less what was refunded to the
       original payment before the customer paid (never collected) */
    var total = amountDueFils(orderId, s, method);
    if (total === null || total <= 0) return refuse(a, 'record_payment', orderId, fail('AMOUNT_UNRECORDED'));
    var comps;
    if (method === METHOD.MIXED) {
      if (!Array.isArray(components) || components.length < 2) return refuse(a, 'record_payment', orderId, fail('COMPONENTS_INVALID'));
      var sum = 0, okc = components.every(function (x) {
        if (!isObj(x) || badKeys(x, ['method', 'amountFils']).length || COMPONENT_METHODS.indexOf(x.method) < 0 || !isFils(x.amountFils) || x.amountFils <= 0) return false;
        sum += x.amountFils; return true;
      });
      /* confirmed: the only mixed payment is RAF Wallet + K-Net — one of each */
      var kinds = components.map(function (x) { return isObj(x) ? x.method : null; }).sort().join('+');
      if (okc && kinds !== METHOD.ONLINE + '+' + METHOD.WALLET) okc = false;
      if (!okc || sum !== total) return refuse(a, 'record_payment', orderId, fail('COMPONENTS_INVALID', { total:total, sum:sum }));
      comps = components.map(function (x, i) { return { componentId:'C' + (i + 1), method:x.method, amountFils:x.amountFils }; });
    } else {
      if (components !== undefined) return refuse(a, 'record_payment', orderId, fail('FIELD_NOT_ACCEPTED', { fields:['components'] }));
      comps = [{ componentId:'C1', method:method, amountFils:total }];
    }
    var existing = paymentRowOfOrder(orderId);
    /* a COD payment recorded before an approved order change is the SAME payment:
       its amount is revised (append-only) when the cash is collected */
    function same(p){
      if (p.method === METHOD.COD && method === METHOD.COD && p.components.length === 1) return true;
      return p.method === method && p.totalAmountFils === total && JSON.stringify(p.components) === JSON.stringify(comps);
    }
    if (existing) return same(existing) ? { ok:true, duplicate:true, payment:present(existing) } : refuse(a, 'record_payment', orderId, fail('PAYMENT_CONFLICT', { paymentId:existing.paymentId }));
    var col = coll('money_payments'); if (!col) return fail('UNAVAILABLE');
    var rec = { paymentId:'PAY-' + orderId, orderId:orderId, customerId:(s.customer && s.customer.id) || null, method:method,
                totalAmountFils:total, currency:c.currency || CURRENCY, components:comps,
                sourceReference:'order:' + orderId, createdAt:Date.now(), createdBy:{ id:a.id, name:a.name }, version:1 };
    var again = paymentRowOfOrder(orderId);               /* re-read right before writing */
    if (again) return same(again) ? { ok:true, duplicate:true, payment:present(again) } : refuse(a, 'record_payment', orderId, fail('PAYMENT_CONFLICT'));
    var w = col.append('paymentId', rec);
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit('money.payment_recorded', a, { key:rec.paymentId, orderId:orderId, newState:STATUS.PENDING,
      metadata:{ paymentId:rec.paymentId, orderId:orderId, method:method, totalAmountFils:total,
                 components:comps.map(function (x) { return x.method + ':' + x.amountFils; }) } });
    return { ok:true, payment:present(w.record) };
  }

  /* one evidence event moves one component out of pending — once */
  function addEvent(a, pay, comp, kind, evidence, reason){
    var evs = eventsOf(pay.paymentId);
    var cur = componentState(pay, comp, evs, acceptedHandoverIds());
    if (cur.status !== STATUS.PENDING) {
      if (cur.status === kind && JSON.stringify(cur.evidence) === JSON.stringify(evidence)) return { ok:true, duplicate:true, payment:present(pay) };
      return refuse(a, 'payment_' + kind, pay.paymentId, fail('INVALID_TRANSITION', { from:cur.status, to:kind }));
    }
    var col = coll('money_payment_events'); if (!col) return fail('UNAVAILABLE');
    var before = present(pay).status;
    var w = col.append('eventId', { eventId:'PE|' + pay.paymentId + '|' + comp.componentId + '|final', paymentId:pay.paymentId,
      componentId:comp.componentId, kind:kind, at:Date.now(), by:{ id:a.id, name:a.name }, evidence:evidence, reason:reason || null });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return refuse(a, 'payment_' + kind, pay.paymentId, fail('INVALID_TRANSITION'));
    var after = present(pay);
    audit('money.payment_status_changed', a, { key:w.record.eventId, orderId:pay.orderId, previousState:before, newState:after.status, reason:reason || null,
      metadata:{ paymentId:pay.paymentId, componentId:comp.componentId, componentStatus:kind, evidenceType:evidence ? evidence.type : null } });
    /* a received order payment fixes which component funded the driver tip:
       the tip's pass-through record notes it (RAFDriverTips, outside the ledger) */
    if (after.status === STATUS.RECEIVED && pay.orderId && after.driverTip && after.driverTip.amountFils > 0 && global.RAFDriverTips && RAFDriverTips.recordFunding) {
      try { RAFDriverTips.recordFunding(pay.orderId); } catch (e) {}
    }
    return { ok:true, payment:after };
  }
  function componentOf(pay, componentId, method){
    var list = pay.components.filter(function (c) { return componentId ? c.componentId === componentId : c.method === method; });
    return list.length === 1 ? list[0] : null;
  }

  /* online evidence — the future provider's event; recorded by Accounting
     (accounting.post) with the provider's own reference until a provider exists */
  function recordOnlineReceipt(paymentId, input){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_POST])) return refuse(a, 'online_receipt', paymentId, fail('FORBIDDEN'));
    input = input || {};
    if (!isObj(input) || badKeys(input, ['componentId', 'provider', 'reference']).length) return refuse(a, 'online_receipt', paymentId, fail('FIELD_NOT_ACCEPTED'));
    var pay = paymentRow(paymentId); if (!pay) return refuse(a, 'online_receipt', paymentId, fail('PAYMENT_NOT_FOUND'));
    var comp = componentOf(pay, input.componentId, METHOD.ONLINE);
    if (!comp) return refuse(a, 'online_receipt', paymentId, fail(input.componentId ? 'COMPONENT_NOT_FOUND' : 'WRONG_METHOD'));
    if (comp.method !== METHOD.ONLINE) return refuse(a, 'online_receipt', paymentId, fail('WRONG_METHOD'));
    var provider = text(input.provider), reference = text(input.reference);
    if (!provider || !reference || provider.length > LIMITS.provider || reference.length > LIMITS.reference) return refuse(a, 'online_receipt', paymentId, fail('EXTERNAL_REF_REQUIRED'));
    var used = rows('money_payment_events').filter(function (e) {
      return e.evidence && e.evidence.type === 'external' && e.evidence.provider === provider && e.evidence.reference === reference
        && !(e.paymentId === paymentId && e.componentId === comp.componentId);
    })[0];
    if (used) return refuse(a, 'online_receipt', paymentId, fail('EXTERNAL_REF_USED', { paymentId:used.paymentId }));
    return afterExternalEvidence(pay, addEvent(a, pay, comp, STATUS.RECEIVED, { type:'external', provider:provider, reference:reference }));
  }
  function recordOnlineFailure(paymentId, input){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_POST])) return refuse(a, 'online_failure', paymentId, fail('FORBIDDEN'));
    input = input || {};
    if (!isObj(input) || badKeys(input, ['componentId', 'provider', 'reference', 'reason']).length) return refuse(a, 'online_failure', paymentId, fail('FIELD_NOT_ACCEPTED'));
    var pay = paymentRow(paymentId); if (!pay) return refuse(a, 'online_failure', paymentId, fail('PAYMENT_NOT_FOUND'));
    var comp = componentOf(pay, input.componentId, METHOD.ONLINE);
    if (!comp || comp.method !== METHOD.ONLINE) return refuse(a, 'online_failure', paymentId, fail('WRONG_METHOD'));
    var provider = text(input.provider), reference = text(input.reference), reason = text(input.reason);
    if (!provider || !reference) return refuse(a, 'online_failure', paymentId, fail('EXTERNAL_REF_REQUIRED'));
    if (reason.length > LIMITS.reason) return refuse(a, 'online_failure', paymentId, fail('FIELD_NOT_ACCEPTED'));
    return addEvent(a, pay, comp, STATUS.FAILED, { type:'external', provider:provider, reference:reference }, reason || null);
  }
  /* a payment whose ORDER was cancelled before any money was received */
  function cancelPayment(paymentId, input){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_POST])) return refuse(a, 'cancel_payment', paymentId, fail('FORBIDDEN'));
    input = input || {};
    if (!isObj(input) || badKeys(input, ['reason']).length) return refuse(a, 'cancel_payment', paymentId, fail('FIELD_NOT_ACCEPTED'));
    var pay = paymentRow(paymentId); if (!pay) return refuse(a, 'cancel_payment', paymentId, fail('PAYMENT_NOT_FOUND'));
    if (orderStatusOf(pay.orderId) !== 'cancelled') return refuse(a, 'cancel_payment', paymentId, fail('ORDER_NOT_CANCELLED'));
    var cur = present(pay);
    if (cur.components.some(function (c) { return c.status !== STATUS.PENDING && c.status !== STATUS.CANCELLED; })) return refuse(a, 'cancel_payment', paymentId, fail('INVALID_TRANSITION', { from:cur.status, to:STATUS.CANCELLED }));
    var reason = text(input.reason), r = null;
    for (var i = 0; i < pay.components.length; i++) {
      r = addEvent(a, pay, pay.components[i], STATUS.CANCELLED, { type:'order_cancelled', orderId:pay.orderId }, reason || null);
      if (!r.ok) return r;
    }
    return { ok:true, payment:present(pay) };
  }
  /* wallet evidence — an EXISTING RAFWallet debit of this customer for this
     order, proved by RAFWallet itself in the customer's own session */
  function linkWalletPayment(paymentId, input){
    var a = me(); if (!a.ok) return a;
    input = input || {};
    if (!isObj(input) || badKeys(input, ['componentId', 'walletTransactionId']).length) return refuse(a, 'wallet_link', paymentId, fail('FIELD_NOT_ACCEPTED'));
    var pay = paymentRow(paymentId); if (!pay) return refuse(a, 'wallet_link', paymentId, fail('PAYMENT_NOT_FOUND'));
    if (!ownsPayment(a, pay)) return refuse(a, 'wallet_link', paymentId, fail('FORBIDDEN'));
    var comp = componentOf(pay, input.componentId, METHOD.WALLET);
    if (!comp || comp.method !== METHOD.WALLET) return refuse(a, 'wallet_link', paymentId, fail('WRONG_METHOD'));
    var W = global.RAFWallet; if (!W) return fail('UNAVAILABLE');
    var h = null; try { h = W.history(a.id, { id:a.id }); } catch (e) { h = null; }
    var tx = h && h.ok ? h.transactions.filter(function (t) { return t.id === input.walletTransactionId; })[0] : null;
    if (!tx || tx.type !== 'debit' || tx.orderId !== pay.orderId || W.toMinor(tx.amount) !== comp.amountFils) return refuse(a, 'wallet_link', paymentId, fail('WALLET_TX_INVALID'));
    var used = rows('money_payment_events').filter(function (e) { return e.evidence && e.evidence.type === 'wallet_transaction' && e.evidence.walletTransactionId === tx.id && !(e.paymentId === paymentId && e.componentId === comp.componentId); })[0];
    if (used) return refuse(a, 'wallet_link', paymentId, fail('WALLET_TX_USED'));
    return addEvent(a, pay, comp, STATUS.RECEIVED, { type:'wallet_transaction', walletTransactionId:tx.id });
  }

  /* ══════════════════════ COD COLLECTION ══════════════════════ */
  function recordCodCollection(orderId, input){
    var a = me(); if (!a.ok) return a;
    if (a.accountType !== 'driver') return refuse(a, 'cod_collection', orderId, fail('NOT_A_DRIVER'));
    input = input || {};
    if (!isObj(input) || badKeys(input, ['collectedFils']).length) return refuse(a, 'cod_collection', orderId, fail('FIELD_NOT_ACCEPTED'));
    var s = snapOf(orderId); if (!s) return refuse(a, 'cod_collection', orderId, fail('ORDER_NOT_FOUND'));
    if (!s.fulfilment || s.fulfilment.driverId !== a.id) return refuse(a, 'cod_collection', orderId, fail('NOT_YOUR_DELIVERY'));
    if (!deliveredAtOf(orderId, s)) return refuse(a, 'cod_collection', orderId, fail('NOT_DELIVERED'));
    if (!isFils(input.collectedFils) || input.collectedFils <= 0) return refuse(a, 'cod_collection', orderId, fail('AMOUNT_INVALID'));
    var pr = ensurePayment(a, orderId, s); if (!pr.ok) return pr;
    var pay = paymentRow(pr.payment.paymentId);
    var comp = componentOf(pay, null, METHOD.COD);
    if (!comp) return refuse(a, 'cod_collection', orderId, fail('WRONG_METHOD'));
    /* the amount due is the authoritative CURRENT payable (approved removals /
       replacements included) — never an older payment-record amount. No
       discrepancy policy exists: the cash must equal it exactly. */
    var due = amountDueFils(orderId, s, METHOD.COD);
    if (due === null || due <= 0) return refuse(a, 'cod_collection', orderId, fail('AMOUNT_UNRECORDED'));
    if (input.collectedFils !== due) return refuse(a, 'cod_collection', orderId, fail('AMOUNT_MISMATCH', { expectedFils:due, collectedFils:input.collectedFils }));
    var existing = collectionOfOrder(orderId);
    if (existing) return (existing.driverId === a.id && existing.collectedFils === input.collectedFils)
      ? { ok:true, duplicate:true, collection:copy(existing), payment:present(pay) }
      : refuse(a, 'cod_collection', orderId, fail('COLLECTION_CONFLICT', { collectionId:existing.collectionId }));
    /* the COD component must still be awaiting its money — checked BEFORE the
       collection is written, so a refusal never leaves half a record */
    var cs = componentState(pay, comp, eventsOf(pay.paymentId), acceptedHandoverIds());
    if (cs.status !== STATUS.PENDING) return refuse(a, 'cod_collection', orderId, fail('INVALID_TRANSITION', { from:cs.status, to:STATUS.RECEIVED }));
    /* the payment was recorded at a different amount (an approved order change
       since): revise it, append-only, before the cash is recorded */
    if (cs.amountFils !== due) {
      var pe = coll('money_payment_events'); if (!pe) return fail('UNAVAILABLE');
      var rv = pe.append('eventId', { eventId:'PE|' + pay.paymentId + '|' + comp.componentId + '|rev|' + cs.amountFils + '>' + due, paymentId:pay.paymentId,
        componentId:comp.componentId, kind:'amount_revised', fromFils:cs.amountFils, toFils:due, at:Date.now(), by:{ id:a.id, name:a.name },
        evidence:{ type:'order_adjusted', orderId:orderId }, reason:'order_adjusted' });
      if (!rv.ok) return fail('PERSIST_FAILED');
      if (!rv.duplicate) audit('money.payment_status_changed', a, { key:rv.record.eventId, orderId:orderId, previousState:'amount:' + cs.amountFils, newState:'amount:' + due,
        reason:'order_adjusted', metadata:{ paymentId:pay.paymentId, componentId:comp.componentId, fromFils:cs.amountFils, toFils:due } });
    }
    var col = coll('money_cod_collections'); if (!col) return fail('UNAVAILABLE');
    var rec = { collectionId:'COD-' + orderId, orderId:orderId, paymentId:pay.paymentId, componentId:comp.componentId, driverId:a.id,
                expectedFils:due, collectedFils:input.collectedFils, currency:pay.currency, collectedAt:Date.now(),
                sourceReference:'cod:' + orderId, recordedBy:{ id:a.id, name:a.name }, version:1 };
    if (collectionOfOrder(orderId)) return refuse(a, 'cod_collection', orderId, fail('COLLECTION_CONFLICT'));
    var w = col.append('collectionId', rec);
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit('money.cod_collected', a, { key:rec.collectionId, orderId:orderId, newState:'driver_cod',
      metadata:{ collectionId:rec.collectionId, paymentId:pay.paymentId, driverId:a.id, expectedFils:rec.expectedFils, collectedFils:rec.collectedFils } });
    var ev = addEvent(a, pay, comp, STATUS.RECEIVED, { type:'cod_collection', collectionId:rec.collectionId, driverId:a.id });
    if (!ev.ok) return ev;
    return { ok:true, collection:copy(w.record), payment:ev.payment };
  }

  /* For the delivery-completion authority (RAFLogistics.completeDelivery):
     BEFORE a delivery moves, may its COD collection be recorded? Everything
     recordCodCollection() will check except "delivered" (which only becomes
     true by completing). Writes no money record; a refusal is audited like
     any refused money operation, because it refuses the delivery.
       → { ok:true, cod:false }                         not a COD order: nothing to collect
       → { ok:true, cod:true, dueFils, alreadyCollected } COD, collection can be recorded
       → { ok:false, code }                              COD, but it cannot */
  function codCollectionPrecheck(orderId){
    var a = me(); if (!a.ok) return a;
    if (a.accountType !== 'driver') return refuse(a, 'cod_precheck', orderId, fail('NOT_A_DRIVER'));
    var s = snapOf(orderId); if (!s) return refuse(a, 'cod_precheck', orderId, fail('ORDER_NOT_FOUND'));
    var c = s.commercial || {};
    var method = METHOD_OF[c.paymentMethod && c.paymentMethod.id];
    if (method !== METHOD.COD) return { ok:true, cod:false, method:method || null };
    if (!s.fulfilment || !s.fulfilment.driverId || s.fulfilment.driverId !== a.id) return refuse(a, 'cod_precheck', orderId, fail('NOT_YOUR_DELIVERY'));
    var due = amountDueFils(orderId, s, METHOD.COD);    /* the authoritative current payable (live adjusted order total) */
    if (due === null || due <= 0) return refuse(a, 'cod_precheck', orderId, fail('AMOUNT_UNRECORDED'));
    var pay = paymentRowOfOrder(orderId);
    if (pay) {
      var comp = pay.method === METHOD.COD && pay.components.length === 1 ? pay.components[0] : null;
      /* an earlier, different amount is revised at collection — never forced */
      if (!comp) return refuse(a, 'cod_precheck', orderId, fail('PAYMENT_CONFLICT', { paymentId:pay.paymentId }));
      var cs = componentState(pay, comp, eventsOf(pay.paymentId), acceptedHandoverIds());
      var col0 = collectionOfOrder(orderId);
      var mineAlready = cs.status === STATUS.RECEIVED && cs.evidence && cs.evidence.type === 'cod_collection' && col0 && col0.driverId === a.id;
      if (cs.status !== STATUS.PENDING && !mineAlready) return refuse(a, 'cod_precheck', orderId, fail('INVALID_TRANSITION', { from:cs.status, to:STATUS.RECEIVED }));
    }
    var col = collectionOfOrder(orderId);
    if (col && !(col.driverId === a.id && col.collectedFils === due)) return refuse(a, 'cod_precheck', orderId, fail('COLLECTION_CONFLICT', { collectionId:col.collectionId }));
    return { ok:true, cod:true, dueFils:due, alreadyCollected:!!col };
  }

  /* ══════════════════════ COD HANDOVER ══════════════════════ */
  function handoverState(h, acc){
    var e = acc[h.handoverId];
    return { handoverId:h.handoverId, driverId:h.driverId, amountFils:h.amountFils, currency:h.currency,
             collectionIds:h.collectionIds.slice(), status:e ? HANDOVER.ACCEPTED : HANDOVER.SUBMITTED,
             submittedAt:h.submittedAt, submittedBy:h.submittedBy, sourceReference:h.sourceReference,
             acceptedAt:e ? e.at : null, acceptedBy:e ? e.by : null, countedFils:e ? e.countedFils : null };
  }
  /* the driver hands in the cash of specific collections, each in full */
  function submitCashHandover(input){
    var a = me(); if (!a.ok) return a;
    if (a.accountType !== 'driver') return refuse(a, 'cod_handover', null, fail('NOT_A_DRIVER'));
    input = input || {};
    if (!isObj(input) || badKeys(input, ['collectionIds']).length) return refuse(a, 'cod_handover', null, fail('FIELD_NOT_ACCEPTED'));
    var ids = Array.isArray(input.collectionIds) ? input.collectionIds.filter(function (x, i, l) { return typeof x === 'string' && l.indexOf(x) === i; }) : [];
    if (!ids.length || ids.length !== input.collectionIds.length) return refuse(a, 'cod_handover', null, fail('HANDOVER_EMPTY'));
    var all = rows('money_cod_collections'), sum = 0;
    for (var i = 0; i < ids.length; i++) {
      var c = all.filter(function (x) { return x.collectionId === ids[i]; })[0];
      if (!c) return refuse(a, 'cod_handover', ids[i], fail('COLLECTION_NOT_FOUND'));
      if (c.driverId !== a.id) return refuse(a, 'cod_handover', ids[i], fail('COLLECTION_NOT_YOURS'));
      sum += c.collectedFils;
    }
    var key = ids.slice().sort().join(',');
    var handovers = rows('money_cod_handovers');
    var same = handovers.filter(function (h) { return h.driverId === a.id && h.collectionIds.slice().sort().join(',') === key; })[0];
    if (same) return { ok:true, duplicate:true, handover:handoverState(same, acceptedHandoverIds()) };
    var clash = handovers.filter(function (h) { return h.collectionIds.some(function (x) { return ids.indexOf(x) > -1; }); })[0];
    if (clash) return refuse(a, 'cod_handover', clash.handoverId, fail('COLLECTION_IN_HANDOVER', { handoverId:clash.handoverId }));
    var col = coll('money_cod_handovers'); if (!col) return fail('UNAVAILABLE');
    var rec = { handoverId:newId('HO'), driverId:a.id, collectionIds:ids.slice().sort(), amountFils:sum, currency:CURRENCY,
                submittedAt:Date.now(), submittedBy:{ id:a.id, name:a.name }, sourceReference:'cod-handover:' + a.id + ':' + key, version:1 };
    if (rows('money_cod_handovers').some(function (h) { return h.collectionIds.some(function (x) { return ids.indexOf(x) > -1; }); })) return refuse(a, 'cod_handover', null, fail('COLLECTION_IN_HANDOVER'));
    var w = col.append('handoverId', rec);
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit('money.cod_handover_submitted', a, { key:rec.handoverId, newState:HANDOVER.SUBMITTED,
      metadata:{ handoverId:rec.handoverId, driverId:a.id, amountFils:sum, collectionIds:rec.collectionIds } });
    return { ok:true, handover:handoverState(w.record, acceptedHandoverIds()) };
  }
  /* Accounting physically received the cash — the ONLY event that moves COD
     custody from the driver to RAF */
  function acceptCashHandover(handoverId, input){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_POST])) return refuse(a, 'cod_accept', handoverId, fail('FORBIDDEN'));
    input = input || {};
    if (!isObj(input) || badKeys(input, ['countedFils']).length) return refuse(a, 'cod_accept', handoverId, fail('FIELD_NOT_ACCEPTED'));
    var h = rows('money_cod_handovers').filter(function (x) { return x.handoverId === handoverId; })[0];
    if (!h) return refuse(a, 'cod_accept', handoverId, fail('HANDOVER_NOT_FOUND'));
    var acc = acceptedHandoverIds();
    if (acc[handoverId]) return { ok:true, duplicate:true, handover:handoverState(h, acc) };
    if (!isFils(input.countedFils)) return refuse(a, 'cod_accept', handoverId, fail('AMOUNT_INVALID'));
    if (input.countedFils !== h.amountFils) return refuse(a, 'cod_accept', handoverId, fail('AMOUNT_MISMATCH', { expectedFils:h.amountFils, countedFils:input.countedFils }));
    /* the amount must still be backed by the driver's own collections */
    var cols = rows('money_cod_collections'), sum = 0, ok = h.collectionIds.every(function (id) {
      var c = cols.filter(function (x) { return x.collectionId === id; })[0];
      if (!c || c.driverId !== h.driverId) return false;
      sum += c.collectedFils; return true;
    });
    if (!ok || sum !== h.amountFils) return refuse(a, 'cod_accept', handoverId, fail('AMOUNT_MISMATCH', { expectedFils:sum }));
    var col = coll('money_cod_handover_events'); if (!col) return fail('UNAVAILABLE');
    var w = col.append('eventId', { eventId:'HE|' + handoverId + '|accepted', handoverId:handoverId, kind:'accepted', at:Date.now(),
      by:{ id:a.id, name:a.name }, countedFils:input.countedFils });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return { ok:true, duplicate:true, handover:handoverState(h, acceptedHandoverIds()) };
    audit('money.cod_handover_accepted', a, { key:handoverId, previousState:HANDOVER.SUBMITTED, newState:HANDOVER.ACCEPTED,
      metadata:{ handoverId:handoverId, driverId:h.driverId, amountFils:h.amountFils, countedFils:input.countedFils, collectionIds:h.collectionIds } });
    return { ok:true, handover:handoverState(h, acceptedHandoverIds()) };
  }

  /* ══════════════════════ READS (derived, write nothing) ══════════════════════ */
  function driverSummary(driverId){
    var acc = acceptedHandoverIds(), hs = rows('money_cod_handovers').filter(function (h) { return h.driverId === driverId; });
    var inAccepted = {}, inSubmitted = {};
    hs.forEach(function (h) { h.collectionIds.forEach(function (id) { (acc[h.handoverId] ? inAccepted : inSubmitted)[id] = h.handoverId; }); });
    var cols = rows('money_cod_collections').filter(function (c) { return c.driverId === driverId; }).sort(function (x, y) { return x.collectedAt - y.collectedAt; });
    var collected = 0, accepted = 0, submitted = 0;
    var list = cols.map(function (c) {
      collected += c.collectedFils;
      var st = inAccepted[c.collectionId] ? 'accepted' : inSubmitted[c.collectionId] ? 'submitted' : 'held';
      if (st === 'accepted') accepted += c.collectedFils; else if (st === 'submitted') submitted += c.collectedFils;
      return { collectionId:c.collectionId, orderId:c.orderId, paymentId:c.paymentId, collectedFils:c.collectedFils, expectedFils:c.expectedFils,
               collectedAt:c.collectedAt, sourceReference:c.sourceReference, state:st, handoverId:inAccepted[c.collectionId] || inSubmitted[c.collectionId] || null };
    });
    return { driverId:driverId, currency:CURRENCY,
             totalCollectedFils:collected, totalSubmittedFils:submitted + accepted, totalAcceptedFils:accepted,
             outstandingFils:collected - accepted,              /* only ACCEPTED reduces it */
             pendingHandoverFils:submitted,
             collections:list,
             outstandingCollections:list.filter(function (x) { return x.state !== 'accepted'; }),
             handovers:hs.map(function (h) { return handoverState(h, acc); }).sort(function (x, y) { return x.submittedAt - y.submittedAt; }),
             acceptedHandovers:hs.filter(function (h) { return acc[h.handoverId]; }).map(function (h) { return handoverState(h, acc); }) };
  }
  /* a driver's COD — the driver themselves, Logistics (drivers.view) or Accounting / Management (accounting.view) */
  function driverCod(driverId){
    var a = me(); if (!a.ok) return a;
    var id = driverId === undefined ? a.id : driverId;
    if (!(a.accountType === 'driver' && id === a.id) && !staffWith(a, [P.DRIVERS_VIEW, P.ACC_VIEW])) return fail('FORBIDDEN');
    var u = null; try { u = Perm().getUser(id); } catch (e) { u = null; }
    if (!u || u.accountType !== 'driver') return fail('NOT_A_DRIVER');
    return Object.assign({ ok:true }, copy(driverSummary(id)));
  }
  /* platform-wide COD exposure, per driver */
  function codExposure(){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.DRIVERS_VIEW, P.ACC_VIEW])) return fail('FORBIDDEN');
    var ids = {}; rows('money_cod_collections').forEach(function (c) { ids[c.driverId] = 1; });
    var drivers = Object.keys(ids).sort().map(function (id) {
      var s = driverSummary(id);
      return { driverId:id, totalCollectedFils:s.totalCollectedFils, totalAcceptedFils:s.totalAcceptedFils,
               pendingHandoverFils:s.pendingHandoverFils, outstandingFils:s.outstandingFils };
    });
    var t = { totalCollectedFils:0, totalAcceptedFils:0, pendingHandoverFils:0, outstandingFils:0 };
    drivers.forEach(function (d) { Object.keys(t).forEach(function (k) { t[k] += d[k]; }); });
    return { ok:true, currency:CURRENCY, drivers:drivers, totals:t };
  }
  function listHandovers(filters){
    filters = filters || {};
    var a = me(); if (!a.ok) return a;
    if (!isObj(filters) || badKeys(filters, ['status', 'driverId']).length) return fail('FIELD_NOT_ACCEPTED');
    var self = a.accountType === 'driver';
    if (!self && !staffWith(a, [P.DRIVERS_VIEW, P.ACC_VIEW])) return fail('FORBIDDEN');
    var acc = acceptedHandoverIds();
    var items = rows('money_cod_handovers').filter(function (h) {
      if (self && h.driverId !== a.id) return false;
      if (filters.driverId && h.driverId !== filters.driverId) return false;
      return true;
    }).map(function (h) { return handoverState(h, acc); }).filter(function (h) { return !filters.status || h.status === filters.status; })
      .sort(function (x, y) { return x.submittedAt - y.submittedAt; });
    return { ok:true, items:items };
  }
  /* ── a customer payment that belongs to no order: a Wallet top-up or a Gift
     Code purchase (confirmed sources). Always ONE online (K-Net / card)
     component; it is only a pending payment until Accounting records the
     external evidence through recordOnlineReceipt — never a receipt by itself.
     Idempotent by the caller's purpose reference. ── */
  var PURPOSES = ['wallet_topup', 'gift_purchase'];
  function recordExternalPayment(input){
    var a = me(); if (!a.ok) return a;
    input = input || {};
    if (!isObj(input) || badKeys(input, ['purpose', 'purposeRef', 'amountFils', 'methodId']).length) return refuse(a, 'record_external_payment', null, fail('FIELD_NOT_ACCEPTED'));
    if (a.accountType !== 'customer') return refuse(a, 'record_external_payment', null, fail('FORBIDDEN'));
    if (PURPOSES.indexOf(input.purpose) < 0 || typeof input.purposeRef !== 'string' || !/^[A-Za-z0-9|:_-]{3,80}$/.test(input.purposeRef)) return refuse(a, 'record_external_payment', null, fail('FIELD_NOT_ACCEPTED'));
    if (!isFils(input.amountFils) || input.amountFils <= 0) return refuse(a, 'record_external_payment', null, fail('AMOUNT_UNRECORDED'));
    var m = null; try { m = global.RAFPaymentMethods ? RAFPaymentMethods.get(input.methodId) : null; } catch (e) { m = null; }
    if (!m || !m.online) return refuse(a, 'record_external_payment', null, fail('METHOD_UNSUPPORTED', { methodId:input.methodId || null }));
    var id = 'PAY-' + input.purposeRef, ex = paymentRow(id);
    if (ex) return (ex.customerId === a.id && ex.purpose === input.purpose && ex.totalAmountFils === input.amountFils) ? { ok:true, duplicate:true, payment:present(ex) }
                                                                                                                       : refuse(a, 'record_external_payment', id, fail('PAYMENT_CONFLICT', { paymentId:id }));
    var col = coll('money_payments'); if (!col) return fail('UNAVAILABLE');
    var rec = { paymentId:id, orderId:null, purpose:input.purpose, purposeRef:input.purposeRef, customerId:a.id, method:METHOD.ONLINE, methodId:m.id,
                totalAmountFils:input.amountFils, currency:CURRENCY, components:[{ componentId:'C1', method:METHOD.ONLINE, amountFils:input.amountFils }],
                sourceReference:input.purpose + ':' + input.purposeRef, createdAt:Date.now(), createdBy:{ id:a.id, name:a.name }, version:1 };
    var w = col.append('paymentId', rec);
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return { ok:true, duplicate:true, payment:present(w.record) };
    audit('money.payment_recorded', a, { key:id, newState:STATUS.PENDING,
      metadata:{ paymentId:id, purpose:input.purpose, purposeRef:input.purposeRef, method:METHOD.ONLINE, totalAmountFils:input.amountFils } });
    return { ok:true, payment:present(w.record) };
  }
  /* after evidence: a received top-up becomes wallet value (RAFWallet decides) */
  function afterExternalEvidence(pay, r){
    if (r && r.ok && !r.duplicate && pay.purpose === 'wallet_topup' && global.RAFWallet && RAFWallet.settleTopUp) {
      try { r.walletCredit = RAFWallet.settleTopUp(pay.paymentId); } catch (e) { r.walletCredit = { ok:false, code:'UNAVAILABLE' }; }
    }
    /* a received gift code purchase starts the code's validity (RAFGift) */
    if (r && r.ok && !r.duplicate && pay.purpose === 'gift_purchase' && global.RAFGift && RAFGift._activate) {
      try { RAFGift._activate(pay.purposeRef); } catch (e) {}
    }
    return r;
  }
  function getPayment(paymentId){
    var a = me(); if (!a.ok) return a;
    var pay = paymentRow(paymentId); if (!pay) return fail('PAYMENT_NOT_FOUND');
    if (!ownsPayment(a, pay) && !staffWith(a, [P.ACC_VIEW])) return fail('FORBIDDEN');
    return { ok:true, payment:present(pay) };
  }
  function paymentForOrder(orderId){
    var a = me(); if (!a.ok) return a;
    var pay = paymentRowOfOrder(orderId); if (!pay) return fail('PAYMENT_NOT_FOUND');
    if (!ownsPayment(a, pay) && !staffWith(a, [P.ACC_VIEW])) return fail('FORBIDDEN');
    return { ok:true, payment:present(pay) };
  }
  function listPayments(filters){
    filters = filters || {};
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_VIEW])) return fail('FORBIDDEN');
    if (!isObj(filters) || badKeys(filters, ['status', 'method']).length) return fail('FIELD_NOT_ACCEPTED');
    var items = rows('money_payments').map(present).filter(function (p) {
      return (!filters.status || p.status === filters.status) && (!filters.method || p.paymentMethod === filters.method);
    });
    return { ok:true, items:items };
  }
  /* SETTLEMENT EVIDENCE — for the accounting integration: per order, what
     money evidence exists. Read-only; makes no accounting decision. */
  function evidenceForOrders(orderIds){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_VIEW])) return fail('FORBIDDEN');
    if (!Array.isArray(orderIds)) return fail('FIELD_NOT_ACCEPTED');
    var items = orderIds.map(function (id) {
      var pay = paymentRowOfOrder(id);
      if (!pay) return { orderId:id, recorded:false, status:null, rafReceived:false, components:[] };
      var p = present(pay);
      /* RAF received the money when every component is in RAF's custody or owed to RAF by the gateway — never while a driver holds COD cash */
      var held = p.components.every(function (c) { return c.custody === CUSTODY.RAF_CASH || c.custody === CUSTODY.GATEWAY || c.custody === CUSTODY.WALLET; });
      return { orderId:id, recorded:true, paymentId:p.paymentId, status:p.status, totalAmountFils:p.totalAmountFils, driverTip:copy(p.driverTip),
               rafReceived:p.status === STATUS.RECEIVED && held,
               components:p.components.map(function (c) { return { componentId:c.componentId, method:c.method, amountFils:c.amountFils, status:c.status, custody:c.custody,
                 walletTransactionId:(c.evidence && c.evidence.type === 'wallet_transaction') ? c.evidence.walletTransactionId : null }; }) };
    });
    return { ok:true, items:items };
  }

  global.RAFMoney = {
    VERSION:VERSION, METHOD:METHOD, STATUS:STATUS, CUSTODY:CUSTODY, HANDOVER:HANDOVER, ERRORS:ERRORS,
    filsOf:filsOf,
    /* yes/no only: has the driver collected this COD order's cash? (no amounts, no identities) */
    codCollected:function (orderId) { return !!collectionOfOrder(orderId); },
    /* what an order's customer owes by its payment method (read-only; COD less refunds to the original payment) */
    amountDueFor:function (orderId) { var s = snapOf(orderId); if (!s) return null; var m = METHOD_OF[s.commercial && s.commercial.paymentMethod && s.commercial.paymentMethod.id] || null;
      return { method:m, dueFils:m ? amountDueFils(orderId, s, m) : null, originalPaymentRefundFils:originalPaymentRefundFils(orderId) }; },
    /* payments */
    recordPayment:recordPayment, recordExternalPayment:recordExternalPayment, recordOnlineReceipt:recordOnlineReceipt,
    /* status only (no amounts, no identities) of a non-order payment — e.g. is a gift code paid for? */
    tipFundingFor:tipFundingFor, allocateTip:allocateTip,
    externalPaymentStatus:function (paymentId) { var p = paymentRow(paymentId); if (!p || !p.purpose) return null; var v = present(p); return { purpose:p.purpose, status:v.status, receivedAt:v.status === STATUS.RECEIVED ? (v.components[0].statusAt || null) : null }; }, recordOnlineFailure:recordOnlineFailure,
    cancelPayment:cancelPayment, linkWalletPayment:linkWalletPayment,
    getPayment:getPayment, paymentForOrder:paymentForOrder, listPayments:listPayments,
    /* COD */
    recordCodCollection:recordCodCollection, codCollectionPrecheck:codCollectionPrecheck,
    submitCashHandover:submitCashHandover, acceptCashHandover:acceptCashHandover,
    driverCod:driverCod, codExposure:codExposure, listHandovers:listHandovers,
    /* accounting integration evidence (read-only) */
    evidenceForOrders:evidenceForOrders
  };
})(window);
