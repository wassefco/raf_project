/* ============================================================================
 * RAF Marketplace — CUSTOMER REFUNDS AUTHORITY  (RAFRefunds · shared, headless)
 * ----------------------------------------------------------------------------
 * The accounting record of money RAF owes back to customers. It never edits
 * the original payment (RAFMoney) or the order change that caused the refund
 * (RAFOrderChanges); it records, append-only, what is owed, where it goes and
 * when it was completed, and posts the movement out of 2300.
 *
 * SOURCE — a refund always comes from an authoritative event: today, a product
 * removal / replacement the customer approved (RAFOrderChanges), whose own
 * record says the amount and the customer's chosen destination.
 *
 * DESTINATION RULES (confirmed):
 *   COD order, product removed BEFORE the customer paid — nothing is collected
 *     for it (RAFMoney's amount due excludes it): there is NO refund.
 *   COD order, money already collected — CASH (back to the customer) or WALLET.
 *   Online-paid order — BANK (back to the original payment method) or WALLET.
 *     CASH is refused: no cross-method cash refunds.
 *   The customer's choice in the order change decides between them:
 *     wallet → WALLET; original payment → BANK (online) / CASH (collected COD).
 *   Wallet / mixed-paid orders: no rule yet → refused.
 *   A BANK refund is expected within orders.refundOriginalPaymentDays (RAFConfig,
 *   currently 7) — configurable, never hard-coded.
 *
 * ACCOUNTING — 2300 Customer Refund Payable is the liability until completed.
 * It is RECOGNISED by the settlement journal (refunds owed, Cr 2300) or by a
 * late-adjustment journal (Cr 2300). Completing then posts, on RAF's explicit
 * call (accounting.post):
 *     BANK   Dr 2300 / Cr 1200 Payment Gateway Receivable (back through the
 *            original payment path; no gateway expense is invented)
 *     WALLET Dr 2300 / Cr 2200 Customer Wallet Liability (customer funds, never revenue)
 *     CASH   Dr 2300 / Cr 1100 Cash & Bank (cash leaving RAF custody)
 * A refund whose liability has not been recognised yet is refused, never posted.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFRefunds) return;

  var VERSION = 1;
  var DEST = { CASH:'CASH', BANK:'BANK', WALLET:'WALLET' };
  var CREDIT_OF = { BANK:'acc-gateway-receivable', WALLET:'acc-customer-wallet', CASH:'acc-cash-bank' };
  var LIABILITY = 'acc-customer-refunds';
  var CONFIG_DAYS = 'orders.refundOriginalPaymentDays';
  var P = { ACC_VIEW:'accounting.view', ACC_POST:'accounting.post' };

  function isEn(){ var r = global.document && (document.getElementById('htmlRoot') || document.documentElement); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAVAILABLE:            { ar:'تعذّر الوصول إلى سجل الاستردادات.',                        en:'The refunds record is unavailable.' },
    UNAUTHENTICATED:        { ar:'يلزم تسجيل الدخول.',                                       en:'Sign-in is required.' },
    ACTOR_INACTIVE:         { ar:'لا يمكن تنفيذ الإجراء بحساب موقوف.',                       en:'A suspended account cannot perform this action.' },
    FORBIDDEN:              { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',                        en:'You do not have permission for this action.' },
    FIELD_NOT_ACCEPTED:     { ar:'تحتوي البيانات على حقول غير مقبولة.',                      en:'The request contains fields that are not accepted.' },
    SOURCE_NOT_FOUND:       { ar:'مصدر الاسترداد غير موجود أو لم يكتمل.',                    en:'The refund source does not exist or is not complete.' },
    PAYMENT_NOT_FOUND:      { ar:'لا توجد دفعة مسجلة لهذا الطلب.',                           en:'No payment is recorded for this order.' },
    PAYMENT_NOT_RECEIVED:   { ar:'لم يُستلم مبلغ هذا الطلب بعد.',                            en:'The money for this order has not been received yet.' },
    NO_MONEY_COLLECTED:     { ar:'المنتج أُزيل قبل الدفع عند الاستلام؛ لم يُحصَّل مبلغه فلا يوجد استرداد.', en:'The product was removed before cash-on-delivery payment; its amount was never collected, so there is no refund.' },
    CASH_NOT_ALLOWED:       { ar:'الاسترداد النقدي متاح فقط لطلبات الدفع عند الاستلام.',     en:'A cash refund is only allowed for cash-on-delivery orders.' },
    DESTINATION_NOT_ALLOWED:{ ar:'وجهة الاسترداد لا تطابق اختيار العميل وطريقة الدفع.',      en:'The refund destination does not match the customer\'s choice and the payment method.' },
    METHOD_REFUND_UNRESOLVED:{ ar:'لا توجد قاعدة استرداد لطريقة الدفع هذه بعد.',             en:'No refund rule exists for this payment method yet.' },
    AMOUNT_UNRECORDED:      { ar:'مبلغ الاسترداد غير مسجّل.',                                en:'The refund amount is not recorded.' },
    REFUND_CONFLICT:        { ar:'هذا الاسترداد مسجّل بتفاصيل مختلفة.',                       en:'This refund is already recorded with different details.' },
    REFUND_NOT_FOUND:       { ar:'الاسترداد غير موجود.',                                     en:'The refund does not exist.' },
    EVIDENCE_REQUIRED:      { ar:'مرجع إتمام الاسترداد مطلوب.',                              en:'A completion reference is required.' },
    NOT_COMPLETED:          { ar:'لم يكتمل الاسترداد بعد.',                                  en:'The refund has not been completed yet.' },
    LIABILITY_NOT_RECOGNIZED:{ ar:'لم يُسجَّل التزام الاسترداد في المحاسبة بعد (قيد التسوية أو التعديل لم يُرحَّل).', en:'The refund liability is not recognised in accounting yet (its settlement or adjustment journal has not posted).' },
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
  function coll(n){ try { return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; } catch (e) { return null; } }
  function rows(n){ var c = coll(n); return c ? c.all() : []; }

  function me(){
    var R = global.RAFPerm; if (!R || !global.RAFRecordStore) return fail('UNAVAILABLE');
    var sid = null; try { sid = R.sessionUserId ? R.sessionUserId() : null; } catch (e) { sid = null; }
    var u = sid ? R.getUser(sid) : null;
    if (!u || !u.id) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var staff = false; try { staff = u.accountType === 'staff' && !R.isMerchant(u.id); } catch (e) { staff = false; }
    return { ok:true, id:u.id, name:u.name || null, staff:staff, can:function (k) { try { return staff && !!R.can(u.id, k); } catch (e) { return false; } } };
  }
  function audit(action, a, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try { var o = { action:action, source:'admin', actor:{ id:a.id } }; for (var k in (extra || {})) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k]; return RAFAudit.record(o); }
    catch (e) { return null; }
  }
  function refuse(a, op, target, r){
    audit('accounting.refund_refused', a, { key:[op, target || '-', r.code].join('|'), reason:r.code, metadata:{ operation:op, target:target || null, code:r.code } });
    return r;
  }
  function refundDays(){ var v = null; try { v = global.RAFConfig ? RAFConfig.value(CONFIG_DAYS) : null; } catch (e) { v = null; } return typeof v === 'number' && v > 0 ? v : null; }

  function completion(id){ return rows('refund_events').filter(function (e) { return e.refundId === id && e.kind === 'completed'; })[0] || null; }
  function present(r){
    var e = completion(r.refundId);
    return { refundId:r.refundId, orderId:r.orderId, paymentId:r.paymentId, paymentMethod:r.paymentMethod, amountFils:r.amountFils,
             currency:r.currency, reason:r.reason, source:copy(r.source), destination:r.destination, expectedBy:r.expectedBy, refundPeriodDays:r.refundPeriodDays,
             createdAt:r.createdAt, createdBy:r.createdBy, status:e ? 'completed' : 'payable',
             completedAt:e ? e.at : null, completedBy:e ? e.by : null, evidence:e ? copy(e.evidence) : null,
             accountingReference:'refund:' + r.refundId };
  }

  /* ══════════ RECORD — from the authoritative order change ══════════ */
  function createFromOrderChange(orderId, changeId, opts){
    var a = me(); if (!a.ok) return a;
    if (!a.can(P.ACC_POST)) return refuse(a, 'refund_create', changeId, fail('FORBIDDEN'));
    opts = opts || {};
    if (!isObj(opts) || badKeys(opts, ['destination']).length) return refuse(a, 'refund_create', changeId, fail('FIELD_NOT_ACCEPTED'));
    var OC = global.RAFOrderChanges, M = global.RAFMoney;
    if (!OC || !M) return fail('UNAVAILABLE');
    var hist = []; try { hist = OC.historyOf(orderId) || []; } catch (e) { hist = []; }
    var ch = hist.filter(function (c) { return c && c.id === changeId; })[0];
    if (!ch || !ch.refundDone || !ch.refundResult) return refuse(a, 'refund_create', changeId, fail('SOURCE_NOT_FOUND'));
    /* RAFOrderChanges recorded the amount as never collected: nothing to refund */
    if (ch.refundResult.destination === 'not_collected') return refuse(a, 'refund_create', changeId, fail('NO_MONEY_COLLECTED'));
    var amount = M.filsOf(ch.refundResult.amount);
    if (amount === null || amount <= 0) return refuse(a, 'refund_create', changeId, fail('AMOUNT_UNRECORDED'));
    var pr = M.paymentForOrder(orderId);
    if (!pr || !pr.ok) return refuse(a, 'refund_create', changeId, fail('PAYMENT_NOT_FOUND'));
    var pay = pr.payment, method = pay.paymentMethod, choice = ch.refundResult.destination;
    var collected = pay.components.length === 1 && pay.components[0].status === 'received';
    var dest;
    if (method === 'cod') {
      /* the driver collects the CURRENT adjusted total (RAFMoney), so a product
         removed BEFORE the cash was collected was never collected — there is
         nothing to refund, whatever the customer chose. Only a removal decided
         AFTER collection is refunded: CASH or WALLET by the customer's choice. */
      var collectedAt = collected ? pay.components[0].statusAt : null;
      var decidedAt = ch.decidedAt || ch.appliedAt || null;
      if (!collected || !decidedAt || decidedAt <= collectedAt) return refuse(a, 'refund_create', changeId, fail('NO_MONEY_COLLECTED'));
      dest = choice === 'wallet' ? DEST.WALLET : DEST.CASH;
    } else if (method === 'online') {
      if (!collected) return refuse(a, 'refund_create', changeId, fail('PAYMENT_NOT_RECEIVED'));
      dest = choice === 'wallet' ? DEST.WALLET : DEST.BANK;
    } else return refuse(a, 'refund_create', changeId, fail('METHOD_REFUND_UNRESOLVED', { method:method }));
    if (opts.destination !== undefined && opts.destination !== dest) {
      return refuse(a, 'refund_create', changeId, fail(opts.destination === DEST.CASH && method !== 'cod' ? 'CASH_NOT_ALLOWED' : 'DESTINATION_NOT_ALLOWED',
        { allowed:dest, requested:opts.destination }));
    }
    var id = 'RF-' + changeId;
    var ex = rows('refunds').filter(function (r) { return r.refundId === id; })[0];
    if (ex) return (ex.amountFils === amount && ex.destination === dest) ? { ok:true, duplicate:true, refund:present(ex) } : refuse(a, 'refund_create', changeId, fail('REFUND_CONFLICT'));
    var days = refundDays(), now = Date.now();
    var rec = { refundId:id, orderId:orderId, paymentId:pay.paymentId, paymentMethod:method, amountFils:amount, currency:'KWD',
                reason:ch.kind === 'removal' ? 'product_removed' : 'product_replacement_difference',
                source:{ type:'order_change', changeId:changeId, kind:ch.kind, productId:ch.productId || null, customerChoice:choice },
                destination:dest, expectedBy:dest === DEST.BANK && days ? now + days * 86400000 : null, refundPeriodDays:dest === DEST.BANK ? days : null,
                createdAt:now, createdBy:{ id:a.id, name:a.name }, sourceReference:'order-change:' + changeId, version:1 };
    var c = coll('refunds'); if (!c) return fail('UNAVAILABLE');
    var w = c.append('refundId', rec);
    if (!w.ok || w.duplicate) return fail('PERSIST_FAILED');
    audit('accounting.refund_recorded', a, { key:id, orderId:orderId, newState:'payable',
      metadata:{ refundId:id, orderId:orderId, paymentId:pay.paymentId, amountFils:amount, destination:dest, changeId:changeId } });
    return { ok:true, refund:present(w.record) };
  }

  /* ══════════ COMPLETE — with the destination's evidence ══════════ */
  function completeRefund(refundId, input){
    var a = me(); if (!a.ok) return a;
    if (!a.can(P.ACC_POST)) return refuse(a, 'refund_complete', refundId, fail('FORBIDDEN'));
    input = input || {};
    if (!isObj(input) || badKeys(input, ['provider', 'reference']).length) return refuse(a, 'refund_complete', refundId, fail('FIELD_NOT_ACCEPTED'));
    var r = rows('refunds').filter(function (x) { return x.refundId === refundId; })[0];
    if (!r) return refuse(a, 'refund_complete', refundId, fail('REFUND_NOT_FOUND'));
    if (completion(refundId)) return { ok:true, duplicate:true, refund:present(r) };
    var ev;
    if (r.destination === DEST.BANK) {
      var pv = text(input.provider), rf = text(input.reference);
      if (!pv || !rf) return refuse(a, 'refund_complete', refundId, fail('EVIDENCE_REQUIRED'));
      ev = { type:'bank_refund', provider:pv, reference:rf };
    } else if (r.destination === DEST.CASH) {
      var cr = text(input.reference);
      if (!cr || input.provider !== undefined) return refuse(a, 'refund_complete', refundId, fail('EVIDENCE_REQUIRED'));
      ev = { type:'cash_paid', reference:cr };
    } else {
      /* the wallet credit itself was made by RAFOrderChanges through RAFWallet at
         the customer's approval (idempotency key chg-<changeId>-refund) */
      if (input.provider !== undefined || input.reference !== undefined) return refuse(a, 'refund_complete', refundId, fail('FIELD_NOT_ACCEPTED'));
      /* the refund entitlement moves into the customer's wallet (2300 → 2200):
         the credit must exist, for exactly this amount — the order change's
         own credit, or (when the change made none, e.g. COD after collection)
         one credit made now from this refund, key RF-<refundId> */
      var W = global.RAFWallet; if (!W || !W.transactionByKey) return fail('UNAVAILABLE');
      var key = 'chg-' + r.source.changeId + '-refund', t = W.transactionByKey(key);
      if (!t.ok) {
        var sn = null; try { sn = global.RAFOrderSnapshot ? RAFOrderSnapshot.of(r.orderId) : null; } catch (e) { sn = null; }
        var cust = sn && sn.customer && sn.customer.id;
        if (!cust) return refuse(a, 'refund_complete', refundId, fail('EVIDENCE_REQUIRED'));
        key = 'RF-' + refundId;
        var cr = W.credit({ customerId:cust, amount:(r.amountFils / 1000).toFixed(3), currency:'KWD',
          reason:r.reason === 'product_removed' ? 'PRODUCT_REMOVAL_REFUND' : 'PRODUCT_REPLACEMENT_DIFFERENCE', source:'refund',
          orderId:r.orderId, relatedChangeId:r.source.changeId, idempotencyKey:key, actor:{ id:'RAFRefunds', type:'system' } });
        if (!cr || !cr.ok) return refuse(a, 'refund_complete', refundId, fail('EVIDENCE_REQUIRED', { walletCode:cr && cr.code }));
        t = W.transactionByKey(key);
      }
      if (!t.ok || t.transaction.type !== 'credit' || t.transaction.amountMinor !== r.amountFils || t.transaction.orderId !== r.orderId)
        return refuse(a, 'refund_complete', refundId, fail('EVIDENCE_REQUIRED', { detail:'wallet_credit_mismatch' }));
      ev = { type:'wallet_credit', walletIdempotencyKey:key, walletTransactionId:t.transaction.transactionId };
    }
    var c = coll('refund_events'); if (!c) return fail('UNAVAILABLE');
    var w = c.append('eventId', { eventId:'RFE|' + refundId + '|completed', refundId:refundId, kind:'completed', at:Date.now(), by:{ id:a.id, name:a.name }, evidence:ev });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (!w.duplicate) audit('accounting.refund_completed', a, { key:refundId, orderId:r.orderId, previousState:'payable', newState:'completed',
      metadata:{ refundId:refundId, destination:r.destination, amountFils:r.amountFils, evidenceType:ev.type } });
    return { ok:true, refund:present(r) };
  }

  /* where 2300 was credited for this refund: the order's settlement journal
     (refunded before close) or a late-adjustment journal (refunded after) */
  function recognition(r){
    var S = global.RAFSettlement, A = global.RAFAccounting; if (!S || !A) return null;
    var l = S.closedListForAccounting(); if (!l || !l.ok) return null;
    for (var i = 0; i < l.items.length; i++) {
      var st = S.closedForAccounting(l.items[i].settlementId); if (!st.ok) continue;
      var s = st.settlement, po = s.orders && s.orders[r.orderId];
      if (po && po.refundedToCustomer > 0) {
        var j = A.journalBySource('settlement', s.id);
        if (j && j.ok && j.journal.lines.some(function (x) { return x.accountId === LIABILITY && x.credit > 0; })) return { via:'settlement', settlementId:s.id, journalId:j.journal.journalId };
      }
      var adj = (s.adjustments || []).filter(function (x) { return x.orderId === r.orderId && x.commissionable < 0; })[0];
      if (adj) {
        var ja = A.journalBySource('settlement', 'adjustment:' + s.id + ':' + adj.orderId + ':' + adj.fromPeriod);
        if (ja && ja.ok) return { via:'adjustment', settlementId:s.id, journalId:ja.journal.journalId };
      }
    }
    return null;
  }

  /* ══════════ POST — the movement out of 2300 ══════════ */
  function postRefund(refundId){
    var a = me(); if (!a.ok) return a;
    if (!a.can(P.ACC_POST)) return refuse(a, 'refund_post', refundId, fail('FORBIDDEN'));
    var r = rows('refunds').filter(function (x) { return x.refundId === refundId; })[0];
    if (!r) return refuse(a, 'refund_post', refundId, fail('REFUND_NOT_FOUND'));
    if (!completion(refundId)) return refuse(a, 'refund_post', refundId, fail('NOT_COMPLETED'));
    var rec = recognition(r);
    if (!rec) return refuse(a, 'refund_post', refundId, fail('LIABILITY_NOT_RECOGNIZED'));
    var A = global.RAFAccounting;
    var w = A.postFromSource('refunds', 'refund:' + refundId, {
      date:A.todayKuwait(),
      description:'Customer refund ' + refundId + ' · order ' + r.orderId + ' · ' + r.destination + ' | استرداد لعميل',
      lines:[{ accountId:LIABILITY, debit:r.amountFils, memo:'Refund owed settled (' + rec.via + ' ' + rec.journalId + ')', ref:'order:' + r.orderId },
             { accountId:CREDIT_OF[r.destination], credit:r.amountFils, memo:'Refund to ' + r.destination, ref:'order:' + r.orderId }] });
    if (!w.ok) return refuse(a, 'refund_post', refundId, Object.assign({}, w, { accountingCode:w.code }));
    return { ok:true, duplicate:!!w.duplicate, journalId:w.journal.journalId, recognizedBy:rec, refund:present(r) };
  }

  function getRefund(refundId){
    var a = me(); if (!a.ok) return a;
    if (!a.can(P.ACC_VIEW)) return fail('FORBIDDEN');
    var r = rows('refunds').filter(function (x) { return x.refundId === refundId; })[0];
    return r ? { ok:true, refund:present(r) } : fail('REFUND_NOT_FOUND');
  }
  function listRefunds(filters){
    filters = filters || {};
    var a = me(); if (!a.ok) return a;
    if (!a.can(P.ACC_VIEW)) return fail('FORBIDDEN');
    if (!isObj(filters) || badKeys(filters, ['orderId', 'status', 'destination']).length) return fail('FIELD_NOT_ACCEPTED');
    return { ok:true, items:rows('refunds').map(present).filter(function (r) {
      return (!filters.orderId || r.orderId === filters.orderId) && (!filters.status || r.status === filters.status) && (!filters.destination || r.destination === filters.destination);
    }) };
  }

  global.RAFRefunds = {
    VERSION:VERSION, DESTINATION:DEST, ERRORS:ERRORS, CONFIG_DAYS:CONFIG_DAYS,
    refundPeriodDays:refundDays,
    createFromOrderChange:createFromOrderChange, completeRefund:completeRefund, postRefund:postRefund,
    getRefund:getRefund, listRefunds:listRefunds
  };
})(window);
