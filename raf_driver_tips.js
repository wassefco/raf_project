/* ============================================================================
 * RAF Marketplace — DRIVER TIPS AUTHORITY  (RAFDriverTips · shared, headless)
 * ----------------------------------------------------------------------------
 * Confirmed business rules:
 *   · A driver tip is a DIRECT customer → driver amount. It is NOT RAF
 *     money: never revenue or expense, never a merchant payable, delivery fee
 *     or commission. 100% of it belongs to the driver who delivered the order.
 *   · This authority keeps the OPERATIONAL record (auditable). In the ledger
 *     the tip only passes through 2800 Pass-through Clearing: the order's
 *     settlement credits it (Customer payment / Wallet → Clearing) and
 *     postHandover clears it (Dr 2800 / Cr 1100) once Accounting has handed
 *     it over. Earning and the driver's confirmation post nothing.
 *     (2600 Driver Tips Payable is retired: RAFAccounting refuses it.)
 *   · The tip is the driver's IMMEDIATELY when the delivery is successfully
 *     completed (RAFLogistics.completeDelivery calls in here).
 *   · Accounting records that the tip was handed to the driver, by CASH or
 *     BANK TRANSFER (no other method), with a permanent receipt number.
 *   · The driver then confirms "Received" (تم التسليم), which completes it.
 *
 *   · A tip exists only with an online-type payment: K-Net / online, RAF
 *     Wallet, or Wallet + K-Net (RAFPaymentMethods.tipAllowed). NEVER with
 *     cash on delivery — a COD order gets no tip record of any kind.
 *   · The tip is INSIDE the order's grand total (never added on top) and
 *     reaches RAF's payment custody with the customer's payment: it is
 *     PASS-THROUGH money — identified separately, never RAF's.
 *   · An order cancelled before delivery returns its tip the way it came —
 *     from the component that FUNDED it (RAFMoney: the only component, or for
 *     Wallet + K-Net the larger one, Wallet on a tie): K-Net → BANK with the
 *     order's cancellation refund; Wallet → the REVERSAL of the original
 *     wallet movement (RAFWallet.reverseTipFunding). The tip is never earned.
 *   · A wallet-funded tip is Customer Wallet → Driver Tip pass-through →
 *     Driver: the customer's wallet value decreases, no RAF ledger account
 *     receives it (the FUNDED record here is the pass-through trace).
 *
 * FACTS, append-only, nothing is ever edited or deleted:
 *   PASS-THROUGH TIP-<orderId> (driver_tip_passthrough) — the tip as paid:
 *             order, customer, amount, payment method, payment reference
 *             (PAY-<orderId>), funding component (unresolved for mixed)
 *   EARNED    TIP-<orderId> (driver_tip_earnings) — at successful delivery:
 *             driver, delivery reference delivery:<orderId>
 *   HANDED    a handover recorded by Accounting: tips, method, amount,
 *             receipt number, reference, accountant, time
 *   RECEIVED  the driver's confirmation of that handover
 *   CANCELLED / RETURNED / RETURN_UNRESOLVED (driver_tip_events) — an order
 *             cancelled before delivery and its tip's return
 *   status and outstanding amounts are DERIVED from these, every time.
 * The receipt is rebuilt from those records (tipReceipt) — never stored apart.
 * (Records written by earlier versions keep their fields — e.g. journalId —
 * as history; nothing here rewrites them.)
 *
 * RECONCILIATION (reconcile): Σ pass-through = pending delivery + earned
 *   (outstanding · handed · received) + cancelled awaiting return + returned
 *   + return unresolved.  None of it is in the General Ledger.
 *
 * PERMISSIONS (existing keys): the paying customer's session records the
 * pass-through at checkout; the delivering driver's session records the
 * earned tip at completion; the cancellation's own session (the customer, the
 * store's merchant) records the return; Accounting with accounting.post may
 * record any of them from the same authoritative order record when missed;
 * accounting.post records payouts; accounting.view / drivers.view read; a
 * driver reads and confirms only their own.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDriverTips) return;

  var VERSION = 4;
  var METHODS = ['CASH', 'BANK_TRANSFER'];
  var P = { ACC_VIEW:'accounting.view', ACC_POST:'accounting.post', DRIVERS_VIEW:'drivers.view' };
  var STATE = { PENDING:'pending_delivery', EARNED:'earned', PAID:'handed_awaiting_confirmation', RECEIVED:'received',
                CANCELLED:'cancelled_return_pending', RETURNED:'returned', RETURN_UNRESOLVED:'return_unresolved' };
  var RECEIVED_TXT = { ar:'تم التسليم', en:'Received' };

  function isEn(){ var r = global.document && (document.getElementById('htmlRoot') || document.documentElement); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAVAILABLE:         { ar:'تعذّر الوصول إلى سجل الإكراميات.',            en:'The tips record is unavailable.' },
    UNAUTHENTICATED:     { ar:'يلزم تسجيل الدخول.',                          en:'Sign-in is required.' },
    ACTOR_INACTIVE:      { ar:'لا يمكن تنفيذ الإجراء بحساب موقوف.',          en:'A suspended account cannot perform this action.' },
    FORBIDDEN:           { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',           en:'You do not have permission for this action.' },
    FIELD_NOT_ACCEPTED:  { ar:'تحتوي البيانات على حقول غير مقبولة.',         en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:     { ar:'الطلب غير موجود.',                            en:'The order does not exist.' },
    NOT_DELIVERED:       { ar:'لم يُسلَّم الطلب بعد.',                       en:'The order has not been delivered yet.' },
    NO_DRIVER:           { ar:'لا يوجد سائق مسجّل على الطلب.',               en:'No driver is recorded on the order.' },
    NOT_YOUR_DELIVERY:   { ar:'هذا الطلب ليس مسنداً إليك.',                  en:'This order is not assigned to you.' },
    TIP_UNRECORDED:      { ar:'مبلغ الإكرامية غير مسجّل في سجل الطلب.',       en:'The tip amount is not recorded on the order.' },
    TIP_CONFLICT:        { ar:'إكرامية هذا الطلب مسجلة بتفاصيل مختلفة.',     en:'This order\'s tip is already recorded with different details.' },
    NOT_A_DRIVER:        { ar:'الحساب ليس حساب سائق.',                       en:'The account is not a driver.' },
    TIPS_EMPTY:          { ar:'اختر الإكراميات التي تُصرف.',                 en:'Choose the tips being paid.' },
    METHOD_INVALID:      { ar:'طريقة الصرف: نقداً أو تحويل بنكي فقط.',       en:'Payout method: cash or bank transfer only.' },
    TIP_NOT_FOUND:       { ar:'الإكرامية غير موجودة.',                       en:'The tip does not exist.' },
    TIP_NOT_DRIVERS:     { ar:'الإكرامية ليست لهذا السائق.',                 en:'The tip does not belong to this driver.' },
    TIP_IN_PAYOUT:       { ar:'الإكرامية مدرجة في صرف آخر.',                 en:'The tip is already part of another payout.' },
    PAYOUT_NOT_FOUND:    { ar:'عملية الصرف غير موجودة.',                     en:'The payout does not exist.' },
    NOT_YOUR_PAYOUT:     { ar:'عملية الصرف هذه ليست لك.',                    en:'This payout is not yours.' },
    PERSIST_FAILED:      { ar:'تعذّر الحفظ.',                                en:'Could not save.' },
    ALREADY_POSTED:      { ar:'سبق ترحيل هذا التسليم.', en:'This handover has already been posted.' },
    INSUFFICIENT_CLEARING_BALANCE:{ ar:'رصيد حساب المقاصة لا يكفي لهذا التسليم.', en:'The pass-through clearing balance does not cover this handover.' },
    NOT_IN_CLEARING:     { ar:'لم تدخل الإكرامية حساب المقاصة بعد (لم تُرحَّل تسوية الطلب).', en:'The tip has not entered clearing yet (its order settlement is not posted).' },
    ACCOUNTING_REFUSED:  { ar:'رفض السجل المحاسبي القيد.',                   en:'The accounting record refused the journal.' },
    TIP_NOT_ALLOWED_COD: { ar:'لا توجد إكرامية سائق مع الدفع عند الاستلام.',  en:'Cash-on-delivery orders carry no driver tip.' },
    METHOD_UNSUPPORTED:  { ar:'طريقة دفع الطلب غير معروفة.',                 en:'The order\'s payment method is not known.' },
    ORDER_CANCELLED:     { ar:'الطلب ملغى؛ لا تُستحق الإكرامية.',             en:'The order was cancelled; the tip is not earned.' },
    NOT_CANCELLED:       { ar:'الطلب غير ملغى.',                             en:'The order is not cancelled.' },
    ALREADY_EARNED:      { ar:'استحق السائق هذه الإكرامية بالفعل.',           en:'The driver has already earned this tip.' },
    CUSTOMER_UNKNOWN:    { ar:'لا يوجد عميل مسجّل على الطلب.',               en:'No customer is recorded on the order.' },
    WALLET_RETURN_FAILED:{ ar:'تعذّرت إعادة الإكرامية إلى المحفظة.',          en:'The tip could not be returned to the wallet.' }
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
  function coll(n){ try { return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; } catch (e) { return null; } }
  function rows(n){ var c = coll(n); return c ? c.all() : []; }
  function filsOf(s){
    if (typeof s === 'number') s = String(s);
    if (typeof s !== 'string' || !/^\d+(\.\d{1,3})?$/.test(s.trim())) return null;
    var p = s.trim().split('.'), f = (p[1] || '') + '000', v = parseInt(p[0], 10) * 1000 + parseInt(f.slice(0, 3), 10);
    return Number.isSafeInteger(v) ? v : null;
  }
  /* deterministic id: the same driver + tips always resolve to the same payout */
  function hash(s){ var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

  function me(){
    var R = global.RAFPerm; if (!R || !global.RAFRecordStore) return fail('UNAVAILABLE');
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
      var src = a.accountType === 'driver' ? 'driver' : a.accountType === 'customer' ? 'customer' : a.staff ? 'admin' : 'merchant';
      var o = { action:action, source:src, actor:{ id:a.id } };
      for (var k in (extra || {})) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return RAFAudit.record(o);
    } catch (e) { return null; }
  }
  function isDriver(id){ try { var u = global.RAFPerm.getUser(id); return !!(u && u.accountType === 'driver'); } catch (e) { return false; } }

  function snapOf(orderId){ var S = global.RAFOrderSnapshot; if (!S) return null; try { return S.of(orderId); } catch (e) { return null; } }
  function liveOrder(orderId){ try { return global.RAFShop ? RAFShop.Orders.get(orderId) : null; } catch (e) { return null; } }
  function deliveredAtOf(orderId, s){
    var d = (s && s.fulfilment && s.fulfilment.deliveredAt) || null;
    if (!d) { try { d = global.RAFOrderEngine && RAFOrderEngine.deliveredAt ? RAFOrderEngine.deliveredAt(orderId) : null; } catch (e) { d = null; } }
    return d || null;
  }
  /* the payment type of the order's own snapshot: cod | online | wallet | mixed */
  function payTypeOf(s){
    var id = s && s.commercial && s.commercial.paymentMethod && s.commercial.paymentMethod.id;
    if (!id) return null;
    if (id === 'cod') return 'cod';
    if (id === 'wallet' || id === 'mixed') return id;
    var m = null; try { m = global.RAFPaymentMethods ? RAFPaymentMethods.get(id) : null; } catch (e) { m = null; }
    return m && m.online ? 'online' : null;
  }
  function isStoreMerchant(a, s){
    try { return !!(global.RAFPerm && RAFPerm.isMerchant(a.id) && s && s.storeSlug && RAFPerm.storeSlugOf(a.id) === s.storeSlug); } catch (e) { return false; }
  }
  function passthroughRow(tipId){ return rows('driver_tip_passthrough').filter(function (r) { return r.tipId === tipId; })[0] || null; }
  function earnedRow(tipId){ return rows('driver_tip_earnings').filter(function (r) { return r.tipId === tipId; })[0] || null; }
  function eventsOf(tipId){ return rows('driver_tip_events').filter(function (e) { return e.tipId === tipId; }); }

  /* ══════════ PASS-THROUGH — the tip as the customer paid it ══════════
     One per order. The tip, the method and the payment reference come from the
     order's own snapshot; RAFMoney's payment id is deterministic (PAY-<order>).
     Wallet + K-Net: the tip is inside the total; which
     component carried it is known once the payment exists — RAFMoney's rule
     decides (larger component, Wallet on a tie) and recordFunding notes it. */
  function ensurePassthrough(a, orderId, s, source){
    var tip = filsOf((s.commercial || {}).driverTip);
    if (tip === null) return fail('TIP_UNRECORDED');
    var type = payTypeOf(s);
    if (tip === 0) return { ok:true, tip:false };
    if (type === 'cod') return fail('TIP_NOT_ALLOWED_COD');
    if (!type) return fail('METHOD_UNSUPPORTED');
    var id = 'TIP-' + orderId, ex = passthroughRow(id);
    if (ex) return ex.amountFils === tip ? { ok:true, tip:true, duplicate:true, passthrough:copy(ex) } : fail('TIP_CONFLICT', { tipId:id });
    var c = coll('driver_tip_passthrough'); if (!c) return fail('UNAVAILABLE');
    /* Wallet + K-Net: decided by RAFMoney's rule (larger component, Wallet on a tie) once the payment is recorded */
    var funding = type === 'mixed' ? { status:'pending_payment', rule:'larger_component_wallet_on_tie' } : { status:'resolved', componentId:'C1', method:type };
    var w = c.append('tipId', { tipId:id, orderId:orderId, customerId:(s.customer && s.customer.id) || null, amountFils:tip, currency:'KWD',
      paymentMethod:type, paymentMethodId:s.commercial.paymentMethod.id, paymentReference:'PAY-' + orderId, funding:funding,
      ledger:false, source:source, createdAt:Date.now(), createdBy:{ id:a.id, name:a.name }, version:4 });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return { ok:true, tip:true, duplicate:true, passthrough:copy(w.record) };
    audit('accounting.driver_tip_passthrough_recorded', a, { key:id, orderId:orderId, newState:STATE.PENDING,
      metadata:{ tipId:id, orderId:orderId, amountFils:tip, paymentMethod:type, paymentReference:'PAY-' + orderId, funding:funding.status, source:source, ledger:false } });
    return { ok:true, tip:true, passthrough:copy(w.record) };
  }
  /* at checkout (RAFRules.placeOrder): the paying customer — or Accounting catching one up */
  function recordFromCheckout(orderId){
    var a = me(); if (!a.ok) return a;
    var s = snapOf(orderId); if (!s) return fail('ORDER_NOT_FOUND');
    var own = a.accountType === 'customer' && s.customer && s.customer.id === a.id;
    if (!own && !staffWith(a, [P.ACC_POST])) return fail('FORBIDDEN');
    return ensurePassthrough(a, orderId, s, own ? 'checkout' : 'accounting');
  }

  /* ══════════ EARNED — at successful delivery ══════════ */
  function recordFromDelivery(orderId){
    var a = me(); if (!a.ok) return a;
    if (!global.RAFOrderSnapshot) return fail('UNAVAILABLE');
    var s = snapOf(orderId);
    if (!s) return fail('ORDER_NOT_FOUND');
    var f = s.fulfilment || {};
    if (!f.driverId) return fail('NO_DRIVER');
    /* the delivering driver (the session) — or Accounting recording a missed one */
    if (!(a.accountType === 'driver' && a.id === f.driverId) && !staffWith(a, [P.ACC_POST])) return fail(a.accountType === 'driver' ? 'NOT_YOUR_DELIVERY' : 'FORBIDDEN');
    var o = liveOrder(orderId);
    if (o && o.status === 'cancelled') return fail('ORDER_CANCELLED');
    var delivered = deliveredAtOf(orderId, s);
    if (!delivered) return fail('NOT_DELIVERED');
    var tip = filsOf((s.commercial || {}).driverTip);
    if (tip === null) return fail('TIP_UNRECORDED');
    if (tip === 0) return { ok:true, tip:false };
    var id = 'TIP-' + orderId;
    var ex = earnedRow(id);
    if (ex) return (ex.driverId === f.driverId && ex.amountFils === tip) ? { ok:true, tip:true, duplicate:true, entitlement:copy(ex) } : fail('TIP_CONFLICT', { tipId:id });
    /* the pass-through comes first (caught up here when checkout could not write it) */
    var pt = ensurePassthrough(a, orderId, s, 'delivery');
    if (!pt.ok) return pt;
    var c = coll('driver_tip_earnings'); if (!c) return fail('UNAVAILABLE');
    var w = c.append('tipId', { tipId:id, orderId:orderId, driverId:f.driverId, customerId:(s.customer && s.customer.id) || null,
      amountFils:tip, currency:'KWD', deliveredAt:delivered, ledger:false, passthroughRef:id,
      source:'delivery', sourceReference:'delivery:' + orderId, recordedAt:Date.now(), recordedBy:{ id:a.id, name:a.name }, version:4 });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return { ok:true, tip:true, duplicate:true, entitlement:copy(w.record) };
    audit('accounting.driver_tips_recognized', a, { key:id, orderId:orderId, previousState:STATE.PENDING, newState:STATE.EARNED,
      metadata:{ tipId:id, orderId:orderId, driverId:f.driverId, amountFils:tip, source:'delivery', ledger:false } });
    return { ok:true, tip:true, entitlement:copy(w.record) };
  }

  /* ══════════ CANCELLED BEFORE DELIVERY — the tip goes back ══════════
     Called by the order's existing cancel-and-refund chain (RAFOrderEngine).
     The order must be cancelled and never delivered (read from the order
     itself). The return follows the existing refund of the cancelled order:
       online  → BANK, the original payment (the order's cancellation refund)
       wallet  → the customer's RAF Wallet (RAFWallet, the one wallet authority)
       mixed   → UNRESOLVED: no rule allocates the tip between Wallet and K-Net */
  function recordCancellationReturn(orderId){
    var a = me(); if (!a.ok) return a;
    var s = snapOf(orderId); if (!s) return fail('ORDER_NOT_FOUND');
    var own = a.accountType === 'customer' && s.customer && s.customer.id === a.id;
    if (!own && !isStoreMerchant(a, s) && !staffWith(a, [P.ACC_POST])) return fail('FORBIDDEN');
    var o = liveOrder(orderId);
    if (!o || o.status !== 'cancelled') return fail('NOT_CANCELLED');
    var id = 'TIP-' + orderId;
    if (earnedRow(id) || deliveredAtOf(orderId, s)) return fail('ALREADY_EARNED');
    var tip = filsOf((s.commercial || {}).driverTip);
    if (tip === null) return fail('TIP_UNRECORDED');
    if (tip === 0) return { ok:true, tip:false };
    var pt = ensurePassthrough(a, orderId, s, 'cancellation');
    if (!pt.ok) return pt;
    var p = pt.passthrough, c = coll('driver_tip_events'); if (!c) return fail('UNAVAILABLE');
    var evs = eventsOf(id);
    var done = evs.filter(function (e) { return e.kind === 'returned' || e.kind === 'return_unresolved'; })[0];
    if (done) return { ok:true, tip:true, duplicate:true, tipRecord:tipView(id) };
    if (!evs.some(function (e) { return e.kind === 'cancelled_before_delivery'; })) {
      var wc = c.append('eventId', { eventId:'TPE|' + id + '|cancelled', tipId:id, orderId:orderId, kind:'cancelled_before_delivery', at:Date.now(), by:{ id:a.id, name:a.name } });
      if (!wc.ok) return fail('PERSIST_FAILED');
      if (!wc.duplicate) audit('accounting.driver_tip_cancelled', a, { key:id, orderId:orderId, previousState:STATE.PENDING, newState:STATE.CANCELLED,
        metadata:{ tipId:id, orderId:orderId, amountFils:p.amountFils } });
    }
    /* the tip goes back the way it came: the component that FUNDED it
       (RAFMoney — the only component, or for Wallet + K-Net the larger one,
       Wallet on a tie). K-Net → BANK with the order's cancellation refund.
       Wallet → the REVERSAL of the original wallet movement (RAFWallet). */
    /* the parts to give back come from the ORIGINAL recorded funding ('funded',
       written when the payment was received) — never recalculated */
    var ev, parts = null;
    if (p.paymentMethod === 'online') parts = [{ method:'online', tipFils:p.amountFils }];
    else {
      var fe = evs.filter(function (e) { return e.kind === 'funded'; })[0] || null;
      if (!fe) { var rf0 = recordFunding(orderId); if (rf0 && rf0.ok && rf0.funded) fe = rf0.funding; }
      if (!fe) ev = { kind:'return_unresolved', code:'TIP_PAYMENT_NOT_RECORDED' };
      else parts = (fe.allocation || []).filter(function (x) { return x.tipFils > 0; }).map(function (x) { return { method:x.method, componentId:x.componentId, tipFils:x.tipFils }; });
    }
    if (parts) {
      var out = [];
      for (var pi = 0; pi < parts.length; pi++) {
        var pt0 = parts[pi];
        if (pt0.method === 'wallet') {
          if (!global.RAFWallet || !RAFWallet.reverseTipFunding) return fail('UNAVAILABLE');
          var r = RAFWallet.reverseTipFunding(orderId);
          if (!r || !r.ok) return fail('WALLET_RETURN_FAILED', { walletCode:r && r.code, detail:r && r.detail });
          out.push({ destination:'WALLET', amountFils:pt0.tipFils, via:'wallet_tip_reversal', reference:r.transaction.id, reversalOf:(r.transaction.meta && r.transaction.meta.reversalOf) || null });
        } else if (pt0.method === 'online') {
          out.push({ destination:'BANK', amountFils:pt0.tipFils, via:'order_cancellation_refund', reference:'order-cancel-refund:' + orderId });
        } else return fail('METHOD_UNSUPPORTED');
      }
      var one = out.length === 1 ? out[0] : null;
      ev = { kind:'returned', destination:one ? one.destination : 'SPLIT', via:one ? one.via : 'split', reference:one ? one.reference : 'order-cancel-refund:' + orderId,
             reversalOf:(out.filter(function (x) { return x.reversalOf; })[0] || {}).reversalOf || null, parts:out };
    }
    var w = c.append('eventId', Object.assign({ eventId:'TPE|' + id + '|' + ev.kind, tipId:id, orderId:orderId, amountFils:p.amountFils, at:Date.now(), by:{ id:a.id, name:a.name } }, ev));
    if (!w.ok) return fail('PERSIST_FAILED');
    if (!w.duplicate) audit(ev.kind === 'returned' ? 'accounting.driver_tip_returned' : 'accounting.driver_tip_return_unresolved', a, {
      key:id, orderId:orderId, previousState:STATE.CANCELLED, newState:ev.kind === 'returned' ? STATE.RETURNED : STATE.RETURN_UNRESOLVED,
      metadata:{ tipId:id, orderId:orderId, amountFils:p.amountFils, destination:ev.destination || null, reference:ev.reference || null, code:ev.code || null, ledger:false } });
    return { ok:true, tip:true, tipRecord:tipView(id) };
  }

  /* FUNDED — the received payment fixes which component carried the tip
     (RAFMoney's deterministic rule). Appended once; for a wallet-funded tip it
     is the pass-through record of the wallet value that went to the driver
     (Customer Wallet → Driver Tip pass-through → Driver) — never a ledger entry. */
  function recordFunding(orderId){
    var a = me(); if (!a.ok) return a;
    var s = snapOf(orderId); if (!s) return fail('ORDER_NOT_FOUND');
    var own = a.accountType === 'customer' && s.customer && s.customer.id === a.id;
    if (!own && !staffWith(a, [P.ACC_POST, P.ACC_VIEW])) return fail('FORBIDDEN');
    var tip = filsOf((s.commercial || {}).driverTip);
    if (!tip) return { ok:true, tip:false };
    var f = global.RAFMoney && RAFMoney.tipFundingFor ? RAFMoney.tipFundingFor(orderId) : null;
    if (!f || f.status !== 'received') return fail('TIP_UNRECORDED', { detail:'payment_not_received' });
    if (!f.driverTip || f.driverTip.funding !== 'resolved') return { ok:true, tip:true, funded:false, code:(f.driverTip && f.driverTip.code) || null };
    var id = 'TIP-' + orderId, pt = passthroughRow(id);
    if (!pt) { var e0 = ensurePassthrough(a, orderId, s, 'payment'); if (!e0.ok) return e0; }
    var c = coll('driver_tip_events'); if (!c) return fail('UNAVAILABLE');
    var w = c.append('eventId', { eventId:'TPE|' + id + '|funded', tipId:id, orderId:orderId, kind:'funded', amountFils:tip, paymentId:f.paymentId,
      componentId:f.driverTip.componentId, method:f.driverTip.method, walletTipFils:f.driverTip.walletTipFils || 0, onlineTipFils:f.driverTip.onlineTipFils || 0,
      walletTransactionId:f.driverTip.walletTipFils > 0 ? f.walletTransactionId : null,
      allocation:copy(f.driverTip.allocation || null), ledger:false, at:Date.now(), by:{ id:a.id, name:a.name } });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (!w.duplicate) audit('accounting.driver_tip_funded', a, { key:id, orderId:orderId,
      metadata:{ tipId:id, amountFils:tip, paymentId:f.paymentId, componentId:f.driverTip.componentId, method:f.driverTip.method, ledger:false } });
    return { ok:true, tip:true, funded:true, duplicate:!!w.duplicate, funding:copy(w.record) };
  }
  /* one tip, its whole history, its derived status */
  function tipView(tipId){
    var p = passthroughRow(tipId), e = earnedRow(tipId);
    if (!p && !e) return null;
    var evs = eventsOf(tipId), h = payoutOfTip(tipId), conf = confirmations();
    var orderId = (p || e).orderId, o = liveOrder(orderId);
    var ret = evs.filter(function (x) { return x.kind === 'returned'; })[0] || null;
    var unres = evs.filter(function (x) { return x.kind === 'return_unresolved'; })[0] || null;
    var canc = evs.filter(function (x) { return x.kind === 'cancelled_before_delivery'; })[0] || null;
    var fnd = evs.filter(function (x) { return x.kind === 'funded'; })[0] || null;
    var st;
    if (ret) st = STATE.RETURNED;
    else if (unres) st = STATE.RETURN_UNRESOLVED;
    else if (e) st = h ? (conf[h.handoverId] ? STATE.RECEIVED : STATE.PAID) : STATE.EARNED;
    else if (canc || (o && o.status === 'cancelled')) st = STATE.CANCELLED;
    else st = STATE.PENDING;
    return { tipId:tipId, orderId:orderId, amountFils:(p || e).amountFils, currency:'KWD', status:st, ledger:false,
             customerId:(p || e).customerId || null,
             payment:p ? { method:p.paymentMethod, methodId:p.paymentMethodId, reference:p.paymentReference,
                           /* the component that funded the tip, once the payment is received; before that, as recorded at checkout */
                           funding:fnd ? { status:'resolved', componentId:fnd.componentId, method:fnd.method, walletTransactionId:fnd.walletTransactionId || null, allocation:copy(fnd.allocation) } : copy(p.funding) } : null,
             funded:fnd ? { paymentId:fnd.paymentId, componentId:fnd.componentId, method:fnd.method, at:fnd.at } : null,
             createdAt:p ? p.createdAt : null,
             earned:e ? { driverId:e.driverId, deliveredAt:e.deliveredAt, deliveryReference:e.sourceReference } : null,
             payout:h ? { payoutId:h.handoverId, receiptNumber:h.receiptNumber, method:h.method || null, reference:h.reference || null,
                          paidAt:h.recordedAt, paidBy:h.recordedBy, confirmedAt:conf[h.handoverId] ? conf[h.handoverId].at : null } : null,
             cancellation:canc ? { at:canc.at, by:canc.by } : null,
             returned:ret ? { destination:ret.destination, via:ret.via, reference:ret.reference, reversalOf:ret.reversalOf || null, parts:copy(ret.parts || null), at:ret.at } : null,
             returnUnresolved:unres ? { code:unres.code, at:unres.at } : null,
             passthroughMissing:!p };
  }
  function tipRecord(orderId){
    var a = me(); if (!a.ok) return a;
    var v = tipView('TIP-' + orderId); if (!v) return fail('TIP_NOT_FOUND');
    var own = a.accountType === 'customer' && v.customerId === a.id;
    var drv = a.accountType === 'driver' && v.earned && v.earned.driverId === a.id;
    if (!own && !drv && !staffWith(a, [P.ACC_VIEW, P.DRIVERS_VIEW])) return fail('FORBIDDEN');
    return { ok:true, tip:copy(v) };
  }
  /* pass-through reconciliation — every fils of every tip in exactly one state */
  function reconcile(){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_VIEW])) return fail('FORBIDDEN');
    var ids = {}; rows('driver_tip_passthrough').forEach(function (r) { ids[r.tipId] = 1; }); rows('driver_tip_earnings').forEach(function (r) { ids[r.tipId] = 1; });
    var t = { receivedThroughPaymentFils:0, pendingDeliveryFils:0, earnedOutstandingFils:0, handedAwaitingConfirmationFils:0, receivedByDriverFils:0,
              cancelledAwaitingReturnFils:0, returnedFils:0, returnUnresolvedFils:0, earnedWithoutPassthroughFils:0 };
    var KEY = {}; KEY[STATE.PENDING] = 'pendingDeliveryFils'; KEY[STATE.EARNED] = 'earnedOutstandingFils'; KEY[STATE.PAID] = 'handedAwaitingConfirmationFils';
    KEY[STATE.RECEIVED] = 'receivedByDriverFils'; KEY[STATE.CANCELLED] = 'cancelledAwaitingReturnFils'; KEY[STATE.RETURNED] = 'returnedFils'; KEY[STATE.RETURN_UNRESOLVED] = 'returnUnresolvedFils';
    var items = Object.keys(ids).sort().map(function (id) {
      var v = tipView(id);
      if (v.passthroughMissing) t.earnedWithoutPassthroughFils += v.amountFils; else t.receivedThroughPaymentFils += v.amountFils;
      if (!v.passthroughMissing) t[KEY[v.status]] += v.amountFils;
      return v;
    });
    var accounted = t.pendingDeliveryFils + t.earnedOutstandingFils + t.handedAwaitingConfirmationFils + t.receivedByDriverFils
                  + t.cancelledAwaitingReturnFils + t.returnedFils + t.returnUnresolvedFils;
    return { ok:true, currency:'KWD', ledger:false, totals:t, balanced:accounted === t.receivedThroughPaymentFils,
             unresolved:items.filter(function (v) { return v.status === STATE.RETURN_UNRESOLVED || (v.payment && v.payment.funding && v.payment.funding.status === 'unresolved'); })
                             .map(function (v) { return { tipId:v.tipId, orderId:v.orderId, code:v.returnUnresolved ? v.returnUnresolved.code : v.payment.funding.code }; }),
             items:copy(items) };
  }

  /* ══════════ derived state ══════════ */
  function confirmations(){ var m = {}; rows('driver_tip_handover_events').forEach(function (e) { if (e.kind === 'confirmed') m[e.handoverId] = e; }); return m; }
  function payoutOfTip(tipId){ return rows('driver_tip_handovers').filter(function (h) { return h.tipIds.indexOf(tipId) > -1; })[0] || null; }
  function payoutState(h, conf){
    var e = conf[h.handoverId];
    return { payoutId:h.handoverId, receiptNumber:h.receiptNumber, driverId:h.driverId, tipIds:h.tipIds.slice(), amountFils:h.amountFils,
             currency:h.currency, method:h.method || null, reference:h.reference || null, journalId:h.journalId || null,
             paidAt:h.recordedAt, paidBy:h.recordedBy, sourceReference:h.sourceReference,
             status:e ? STATE.RECEIVED : STATE.PAID, statusText:e ? { ar:RECEIVED_TXT.ar, en:RECEIVED_TXT.en } : null,
             confirmedAt:e ? e.at : null, confirmedBy:e ? e.by : null };
  }
  function summary(driverId){
    var conf = confirmations(), hs = rows('driver_tip_handovers').filter(function (h) { return h.driverId === driverId; });
    var tips = rows('driver_tip_earnings').filter(function (t) { return t.driverId === driverId; }).sort(function (x, y) { return x.recordedAt - y.recordedAt; });
    var owed = 0, paid = 0, received = 0;
    var list = tips.map(function (t) {
      owed += t.amountFils;
      var h = payoutOfTip(t.tipId), st = h ? (conf[h.handoverId] ? STATE.RECEIVED : STATE.PAID) : STATE.EARNED;
      if (st === STATE.RECEIVED) received += t.amountFils; else if (st === STATE.PAID) paid += t.amountFils;
      return { tipId:t.tipId, orderId:t.orderId, amountFils:t.amountFils, deliveredAt:t.deliveredAt || null, sourceReference:t.sourceReference || null,
               state:st, payoutId:h ? h.handoverId : null };
    });
    return { driverId:driverId, currency:'KWD', totalEarnedFils:owed, paidAwaitingConfirmationFils:paid, receivedFils:received,
             outstandingFils:owed - received, tips:list,
             payouts:hs.map(function (h) { return payoutState(h, conf); }).sort(function (x, y) { return x.paidAt - y.paidAt; }) };
  }
  function driverTips(driverId){
    var a = me(); if (!a.ok) return a;
    var id = driverId === undefined ? a.id : driverId;
    if (!(a.accountType === 'driver' && id === a.id) && !staffWith(a, [P.ACC_VIEW, P.DRIVERS_VIEW])) return fail('FORBIDDEN');
    if (!isDriver(id)) return fail('NOT_A_DRIVER');
    return Object.assign({ ok:true }, copy(summary(id)));
  }
  /* ══════════ HANDED — Accounting records the handover (no journal) ══════════ */
  function recordTipPayout(input){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_POST])) return fail('FORBIDDEN');
    input = input || {};
    if (!isObj(input) || badKeys(input, ['driverId', 'tipIds', 'method', 'reference']).length) return fail('FIELD_NOT_ACCEPTED');
    if (METHODS.indexOf(input.method) < 0) return fail('METHOD_INVALID');
    if (!isDriver(input.driverId)) return fail('NOT_A_DRIVER');
    var ref = input.reference === undefined ? '' : text(input.reference);
    if (ref.length > 120) return fail('FIELD_NOT_ACCEPTED');
    var ids = Array.isArray(input.tipIds) ? input.tipIds.filter(function (x, i, l) { return typeof x === 'string' && l.indexOf(x) === i; }) : [];
    if (!ids.length || ids.length !== input.tipIds.length) return fail('TIPS_EMPTY');
    var all = rows('driver_tip_earnings'), sum = 0;
    for (var i = 0; i < ids.length; i++) {
      var t = all.filter(function (x) { return x.tipId === ids[i]; })[0];
      if (!t) return fail('TIP_NOT_FOUND', { tipId:ids[i] });
      if (t.driverId !== input.driverId) return fail('TIP_NOT_DRIVERS', { tipId:ids[i] });
      sum += t.amountFils;
    }
    var key = ids.slice().sort().join(','), hs = rows('driver_tip_handovers');
    var same = hs.filter(function (h) { return h.driverId === input.driverId && h.tipIds.slice().sort().join(',') === key; })[0];
    if (same) return { ok:true, duplicate:true, payout:payoutState(same, confirmations()) };
    var clash = hs.filter(function (h) { return h.tipIds.some(function (x) { return ids.indexOf(x) > -1; }); })[0];
    if (clash) return fail('TIP_IN_PAYOUT', { payoutId:clash.handoverId });
    /* the same driver + tips always resolve to the same handover and receipt */
    var pid = 'TP-' + hash(input.driverId + '|' + key), receipt = 'TIPR-' + pid.slice(3).toUpperCase();
    var c = coll('driver_tip_handovers'); if (!c) return fail('UNAVAILABLE');
    var rec = { handoverId:pid, receiptNumber:receipt, driverId:input.driverId, tipIds:ids.slice().sort(), amountFils:sum, currency:'KWD',
                method:input.method, reference:ref || null, ledger:false,
                recordedAt:Date.now(), recordedBy:{ id:a.id, name:a.name }, sourceReference:'tip-payout:' + pid, version:3 };
    var w = c.append('handoverId', rec);
    if (!w.ok) return fail('PERSIST_FAILED');
    if (!w.duplicate) audit('accounting.driver_tip_handover_recorded', a, { key:pid, newState:STATE.PAID,
      metadata:{ payoutId:pid, receiptNumber:receipt, driverId:input.driverId, amountFils:sum, method:input.method, tipIds:rec.tipIds, ledger:false } });
    return { ok:true, payout:payoutState(w.record, confirmations()) };
  }

  /* ══════════ PASS-THROUGH CLEARING (2800) ══════════
     The order's settlement journal credits each tip to 2800 Pass-through
     Clearing (Customer payment / Wallet → Clearing). When Accounting POSTS a
     recorded handover, the tips leave clearing for the driver:
         Dr 2800 Pass-through Clearing / Cr 1100 Cash & Bank
     (CASH and BANK TRANSFER both leave RAF's one cash & bank account). Never
     revenue or expense. A tip can only leave clearing after it entered it —
     its order's settlement journal must be posted. Idempotent by source
     payouts:tip-handover:<payoutId>; the current open period. */
  var CLEARING = 'acc-passthrough-clearing', CASH_BANK = 'acc-cash-bank';
  function clearedBy(orderId){
    var S = global.RAFSettlement, A = global.RAFAccounting; if (!S || !A) return null;
    try {
      var l = S.closedListForAccounting(); if (!l || !l.ok) return null;
      for (var i = 0; i < l.items.length; i++) {
        var st = S.closedForAccounting(l.items[i].settlementId); if (!st.ok || !(st.settlement.orders || {})[orderId]) continue;
        var j = A.journalBySource('settlement', st.settlement.id);
        if (j && j.ok && j.journal.lines.some(function (x) { return x.accountId === CLEARING && x.credit > 0; })) return { settlementId:st.settlement.id, journalId:j.journal.journalId };
      }
    } catch (e) { return null; }
    return null;
  }
  function handoverJournalOf(pid){
    var A = global.RAFAccounting; if (!A) return null;
    try { var j = A.journalBySource('payouts', 'tip-handover:' + pid); return j && j.ok ? j.journal.journalId : null; } catch (e) { return null; }
  }
  function postHandover(payoutId){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_POST])) return fail('FORBIDDEN');
    var h = rows('driver_tip_handovers').filter(function (x) { return x.handoverId === payoutId; })[0];
    if (!h) return fail('PAYOUT_NOT_FOUND');
    var tips = rows('driver_tip_earnings'), notCleared = [];
    h.tipIds.forEach(function (id) { var t = tips.filter(function (x) { return x.tipId === id; })[0]; if (!t || !clearedBy(t.orderId)) notCleared.push(id); });
    if (notCleared.length) return fail('NOT_IN_CLEARING', { tipIds:notCleared });
    var A = global.RAFAccounting; if (!A) return fail('UNAVAILABLE');
    /* the clearing account must hold at least what leaves it (never debit 2800
       below what the settlements put in); a handover posts once — a repeat is
       refused (ALREADY_POSTED), never a second journal */
    var already = handoverJournalOf(payoutId);
    if (already) return fail('ALREADY_POSTED', { journalId:already });
    var bal = null; try { var L0 = A.ledger(CLEARING); bal = L0 && L0.ok ? L0.closingBalance : null; } catch (e) { bal = null; }
    if (bal === null || bal < h.amountFils) return fail('INSUFFICIENT_CLEARING_BALANCE', { clearingFils:bal, requiredFils:h.amountFils });
    var w = A.postFromSource('payouts', 'tip-handover:' + payoutId, { date:A.todayKuwait(),
      description:'Driver tips handed over · ' + h.receiptNumber + ' · ' + h.driverId + ' · ' + h.method + ' | تسليم إكراميات سائق',
      lines:[{ accountId:CLEARING, debit:h.amountFils, memo:'Tips ' + h.tipIds.join(',') + ' to driver ' + h.driverId, ref:h.receiptNumber },
             { accountId:CASH_BANK, credit:h.amountFils, memo:(h.method === 'CASH' ? 'Paid in cash' : 'Paid by bank transfer') + (h.reference ? ' ' + h.reference : ''), ref:h.receiptNumber }] });
    if (!w.ok) return fail('ACCOUNTING_REFUSED', { accountingCode:w.code, accountingMessage:w.message });
    if (!w.duplicate) audit('accounting.driver_tip_handover_posted', a, { key:payoutId,
      metadata:{ payoutId:payoutId, receiptNumber:h.receiptNumber, driverId:h.driverId, amountFils:h.amountFils, method:h.method, journalId:w.journal.journalId } });
    return { ok:true, duplicate:!!w.duplicate, journalId:w.journal.journalId };
  }
  /* 2800 reconciled against the tip records: tips whose settlement credited
     clearing, less tips whose handover has been posted */
  function clearingReconciliation(){
    var a = me(); if (!a.ok) return a;
    if (!staffWith(a, [P.ACC_VIEW])) return fail('FORBIDDEN');
    var inC = 0, out = 0, items = [], hs = rows('driver_tip_handovers');
    var ids = {}; rows('driver_tip_passthrough').forEach(function (r) { ids[r.tipId] = r.orderId; }); rows('driver_tip_earnings').forEach(function (r) { ids[r.tipId] = r.orderId; });
    Object.keys(ids).forEach(function (id) {
      var v = tipView(id), c = clearedBy(ids[id]); if (!c) return;
      var h = hs.filter(function (x) { return x.tipIds.indexOf(id) > -1; })[0], hj = h ? handoverJournalOf(h.handoverId) : null;
      inC += v.amountFils; if (hj) out += v.amountFils;
      items.push({ tipId:id, orderId:ids[id], amountFils:v.amountFils, status:v.status, inClearingBy:c.journalId, handoverJournalId:hj });
    });
    var gl = null; try { var L = global.RAFAccounting.ledger(CLEARING); gl = L && L.ok ? L.closingBalance : null; } catch (e) { gl = null; }
    return { ok:true, accountId:CLEARING, balanceFils:gl, expectedFils:inC - out, reconciles:gl === inC - out, inClearingFils:inC, handedOutFils:out, items:items };
  }

  /* ══════════ RECEIVED — the driver confirms ══════════ */
  function confirmTipReceipt(payoutId){
    var a = me(); if (!a.ok) return a;
    if (a.accountType !== 'driver') return fail('NOT_A_DRIVER');
    var h = rows('driver_tip_handovers').filter(function (x) { return x.handoverId === payoutId; })[0];
    if (!h) return fail('PAYOUT_NOT_FOUND');
    if (h.driverId !== a.id) return fail('NOT_YOUR_PAYOUT');
    var conf = confirmations();
    if (conf[payoutId]) return { ok:true, duplicate:true, payout:payoutState(h, conf) };
    var c = coll('driver_tip_handover_events'); if (!c) return fail('UNAVAILABLE');
    var w = c.append('eventId', { eventId:'THE|' + payoutId + '|confirmed', handoverId:payoutId, kind:'confirmed', at:Date.now(), by:{ id:a.id, name:a.name } });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return { ok:true, duplicate:true, payout:payoutState(h, confirmations()) };
    audit('accounting.driver_tip_receipt_confirmed', a, { key:payoutId, previousState:STATE.PAID, newState:STATE.RECEIVED,
      metadata:{ payoutId:payoutId, receiptNumber:h.receiptNumber, driverId:a.id, amountFils:h.amountFils, method:h.method || null } });
    return { ok:true, payout:payoutState(h, confirmations()) };
  }

  /* ══════════ the receipt — rebuilt from the records ══════════ */
  function tipReceipt(payoutId){
    var a = me(); if (!a.ok) return a;
    var h = rows('driver_tip_handovers').filter(function (x) { return x.handoverId === payoutId; })[0];
    if (!h) return fail('PAYOUT_NOT_FOUND');
    if (!(a.accountType === 'driver' && h.driverId === a.id) && !staffWith(a, [P.ACC_VIEW, P.DRIVERS_VIEW])) return fail('FORBIDDEN');
    var st = payoutState(h, confirmations()), tips = rows('driver_tip_earnings');
    var driver = null; try { var u = global.RAFPerm.getUser(h.driverId); driver = u ? { id:u.id, name:u.name || null } : null; } catch (e) { driver = null; }
    return { ok:true, receipt:{
      receiptNumber:h.receiptNumber, payoutId:h.handoverId, driver:driver, currency:'KWD', amountFils:h.amountFils,
      method:h.method || null, reference:h.reference || null, journalId:h.journalId || null,
      paidAt:h.recordedAt, paidBy:h.recordedBy, status:st.status, statusText:st.statusText, confirmedAt:st.confirmedAt,
      lines:h.tipIds.map(function (id) { var t = tips.filter(function (x) { return x.tipId === id; })[0] || {};
        return { tipId:id, orderId:t.orderId || null, amountFils:t.amountFils || null, deliveredAt:t.deliveredAt || null, sourceReference:t.sourceReference || null }; }) } };
  }
  function listTipPayouts(filters){
    filters = filters || {};
    var a = me(); if (!a.ok) return a;
    if (!isObj(filters) || badKeys(filters, ['driverId', 'status']).length) return fail('FIELD_NOT_ACCEPTED');
    var self = a.accountType === 'driver';
    if (!self && !staffWith(a, [P.ACC_VIEW, P.DRIVERS_VIEW])) return fail('FORBIDDEN');
    var conf = confirmations();
    return { ok:true, items:rows('driver_tip_handovers').filter(function (h) {
      return (!self || h.driverId === a.id) && (!filters.driverId || h.driverId === filters.driverId);
    }).map(function (h) { return payoutState(h, conf); }).filter(function (h) { return !filters.status || h.status === filters.status; }) };
  }

  global.RAFDriverTips = {
    VERSION:VERSION, STATE:STATE, METHODS:METHODS.slice(), ERRORS:ERRORS, RECEIVED_TXT:RECEIVED_TXT,
    /* pass-through lifecycle */
    recordFromCheckout:recordFromCheckout, recordFunding:recordFunding, recordFromDelivery:recordFromDelivery, recordCancellationReturn:recordCancellationReturn,
    tipRecord:tipRecord, reconcile:reconcile,
    /* handover */
    recordTipPayout:recordTipPayout, confirmTipReceipt:confirmTipReceipt, postHandover:postHandover, clearingReconciliation:clearingReconciliation,
    driverTips:driverTips, tipReceipt:tipReceipt, listTipPayouts:listTipPayouts
  };
})(window);
