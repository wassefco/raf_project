/* ============================================================================
 * RAF Marketplace — SETTLEMENT → ACCOUNTING POSTING  (RAFSettlementPosting)
 * ----------------------------------------------------------------------------
 * Finance, phase 3: the integration between two authorities that stay
 * separate. It owns NO data and NO rule of either side:
 *
 *   RAFSettlement   rates, commission base, commission, merchant entitlement,
 *                   monthly settlement periods and their close, late
 *                   adjustments — read here ONLY as the frozen closed record
 *                   (RAFSettlement.closedForAccounting). Nothing is recomputed.
 *   RAFAccounting   accounts, accounting periods, journals, ledger, trial
 *                   balance — written ONLY through RAFAccounting.postFromSource,
 *                   under all of its own validation and permission checks.
 *
 * RECOGNITION — commission is recognised when the monthly settlement is
 * closed: a settlement posts only once RAFSettlement has closed it, never when
 * an order is placed. The journal date is the Kuwait business date of the
 * settlement's close (closedAt); the accounting period covering it must be open.
 *
 * THE JOURNAL OF A CLOSED SETTLEMENT (all amounts are RAFSettlement's frozen
 * integer fils; the adapter only checks they agree with each other):
 *     Dr  <marketplace funds attributable to the settlement>   commissionable
 *     Cr  4100 acc-commission-revenue                          commission
 *     Cr  2100 acc-merchant-payables                           entitlement
 *   commission + entitlement = commissionable, so the entry balances by the
 *   settlement's own figures. Zero-value lines are left out.
 *   Each ADJUSTMENT a closed settlement carries (an order of an earlier,
 *   already-closed month that changed since) is its own journal, at the
 *   historical rate RAFSettlement recorded on it; a negative adjustment is the
 *   mirror image. The earlier month's journal is never touched.
 *
 * THE DEBIT SIDE (since the money authority) — with RAFMoney loaded, the debit
 * comes only from the SETTLEMENT FUNDS MAPPING (mapFunds / mapSettlement):
 * each order's customer money is classified from authoritative fields, and
 * the settlement posts only when every component has a defined destination
 * and every order's money is received and RAF's. Received RAF cash debits
 * 1100, online money owed by the gateway debits 1200. Anything else is
 * refused with the exact unresolved items. The paragraph below describes the
 * original seam, still used when RAFMoney is not loaded.
 *
 * THE DEBIT SIDE (seam) — is supplied by a FUNDS SOURCE: the authority that knows
 * where the customer money behind a settlement actually is (a future Payments
 * / gateway / cash-collection authority). It is registered through
 * registerFundsSource(). TODAY NONE EXISTS: online payments are prototype
 * confirmations (no gateway), cash-on-delivery collection is not recorded,
 * and RAF-funded discounts (part of the commission base the customer did not
 * pay) have no decided accounting treatment. So, with no source registered,
 * every posting refuses with ACCOUNTING_SOURCE_INCOMPLETE and writes nothing:
 * a cash / bank debit is never invented to make an entry balance.
 *
 * IDEMPOTENCY — source system 'settlement', references:
 *     <settlementId>                                   the settlement's own journal
 *     adjustment:<settlementId>:<orderId>:<fromPeriod>  each adjustment
 *   A replay with identical content returns the original journal; different
 *   content is refused as an integrity conflict. No second journal, ever.
 *
 * ALL OR NOTHING (per settlement) — every journal of a settlement is built
 * and checked through RAFAccounting.validateJournal before the first is
 * posted. (The localStorage store is not transactional; a storage failure
 * between two appends is the remaining, stated, prototype risk.)
 *
 * WHO POSTS — this is a SYSTEM INTEGRATION operation, and every journal says
 * so (source system 'settlement', never 'manual'). Settlement closing happens
 * inside RAFSettlement, often in a merchant's session; that session NEVER
 * posts. A browser cannot prove a trusted system caller, so posting must be
 * EXECUTED by an active RAF Management account that RAFAccounting authorises
 * (accounting.post); the journal records it as the executor. Production
 * should move this to a server-side job with a real system identity.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFSettlementPosting) return;

  var SOURCE_SYSTEM = 'settlement';
  var ACC = { COMMISSION:'acc-commission-revenue', PAYABLES:'acc-merchant-payables', DELIVERY_FEES:'acc-delivery-fees-payable' };
  var POSTABLE = ['settled', 'closed'];          /* RAFSettlement's two closed statuses with activity */

  function isEn(){ var r = global.document && (document.getElementById('htmlRoot') || document.documentElement); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAVAILABLE:                   { ar:'تعذّر الوصول إلى التسويات أو المحاسبة.',             en:'Settlement or accounting is unavailable.' },
    SETTLEMENT_INCONSISTENT:       { ar:'أرقام التسوية غير متسقة؛ لم يُرحَّل شيء.',          en:'The settlement figures are inconsistent; nothing was posted.' },
    SETTLEMENT_INCOMPLETE:         { ar:'التسوية بلا نسبة عمولة مسجلة؛ لم يُرحَّل شيء.',     en:'The settlement has no recorded commission rate; nothing was posted.' },
    NOTHING_TO_POST:               { ar:'لا توجد مبالغ في هذه التسوية لترحيلها.',           en:'This settlement has no amounts to post.' },
    ACCOUNTS_MISSING:              { ar:'حسابات دليل رف المطلوبة غير موجودة أو غير نشطة.',   en:'The required RAF chart accounts are missing or inactive.' },
    ACCOUNTING_SOURCE_INCOMPLETE:  { ar:'لا يوجد مصدر معتمد للطرف المدين (أموال العملاء)؛ لم يُرحَّل شيء.', en:'No authoritative source exists for the debit side (customer funds); nothing was posted.' },
    FUNDS_SOURCE_INVALID:          { ar:'مصدر الأموال أعاد أسطراً غير صالحة؛ لم يُرحَّل شيء.', en:'The funds source returned invalid lines; nothing was posted.' },
    FUNDS_SOURCE_EXISTS:           { ar:'مصدر الأموال مسجّل بالفعل.',                       en:'A funds source is already registered.' },
    INTEGRITY_CONFLICT:            { ar:'هذه التسوية مُرحّلة بقيد مختلف؛ لم يُرحَّل شيء.',  en:'This settlement was already posted with a different entry; nothing was posted.' },
    ACCOUNTING_REFUSED:            { ar:'رفض السجل المحاسبي القيد؛ لم يُرحَّل شيء.',         en:'The accounting record refused the entry; nothing was posted.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k];
    return r;
  }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function int(v){ return typeof v === 'number' && Number.isSafeInteger(v); }
  function percentText(bp){ return (bp / 100).toFixed(2).replace(/\.?0+$/, ''); }
  function AC(){ return global.RAFAccounting || null; }
  function ST(){ return global.RAFSettlement || null; }

  /* ══════════════════════ FUNDS SOURCE (the debit side) ══════════════════════
     One registration, never replaced. A source receives the frozen figures of
     one posting and answers where the money is:
       resolve(view) → { ok:true, lines:[{ accountId, amount, memo? }] }   amounts in
                       fils, positive, summing to |commissionable|
                     | { ok:false, missing:[...] }                          */
  var FUNDS = null;
  function registerFundsSource(src){
    if (FUNDS) return fail('FUNDS_SOURCE_EXISTS', { id:FUNDS.id });
    if (!src || typeof src.id !== 'string' || !src.id || typeof src.resolve !== 'function') return fail('FUNDS_SOURCE_INVALID');
    FUNDS = { id:src.id, resolve:src.resolve };
    return { ok:true, id:src.id };
  }
  function fundsSource(){ return FUNDS ? { registered:true, id:FUNDS.id } : { registered:false, id:null }; }
  /* what is missing when no source can answer — stated, never guessed. With
     RAFMoney (the money-evidence authority) loaded, the answer is per order:
     which orders have no payment record, and which have one but the money is
     not yet RAF's (pending, or COD cash still held by a driver). Even complete
     evidence cannot post on its own: how a customer payment (grand total, incl.
     delivery fee / tip) maps onto the commission base is an accounting
     decision RAF has not made — 'funds_mapping_decision'. */
  function evidenceOf(view){
    var M = global.RAFMoney; if (!M || !M.evidenceForOrders) return null;
    var ids = view.kind === 'adjustment' ? [view.orderId] : (view.orders || []);
    var r = null; try { r = M.evidenceForOrders(ids); } catch (e) { r = null; }
    if (!r || !r.ok) return null;
    return { source:'RAFMoney',
             noPaymentRecord:r.items.filter(function (x) { return !x.recorded; }).map(function (x) { return x.orderId; }),
             notReceivedByRaf:r.items.filter(function (x) { return x.recorded && !x.rafReceived; }).map(function (x) { return x.orderId; }),
             receivedByRaf:r.items.filter(function (x) { return x.rafReceived; }).map(function (x) { return x.orderId; }) };
  }
  function missingFor(view, ev){
    var m = [];
    if (!ev) m.push('customer_payment_record');
    else {
      if (ev.noPaymentRecord.length) m.push('customer_payment_record');
      if (ev.notReceivedByRaf.length) m.push('raf_receipt');
      m.push('funds_mapping_decision');
    }
    if (view.rafBorne > 0) m.push('raf_funded_discount_treatment');
    return m;
  }
  function resolveFunds(view){
    if (!FUNDS) { var ev = evidenceOf(view);
      return fail('ACCOUNTING_SOURCE_INCOMPLETE', { missing:missingFor(view, ev), amount:Math.abs(view.commissionable), moneyEvidence:ev }); }
    var r = null; try { r = FUNDS.resolve(copy(view)); } catch (e) { r = null; }
    if (r && r.ok === false) return fail('ACCOUNTING_SOURCE_INCOMPLETE', { missing:Array.isArray(r.missing) && r.missing.length ? r.missing.slice() : missingFor(view), source:FUNDS.id, amount:Math.abs(view.commissionable) });
    if (!r || !Array.isArray(r.lines) || !r.lines.length) return fail('FUNDS_SOURCE_INVALID', { source:FUNDS.id });
    var sum = 0, ok = r.lines.every(function (l) {
      if (!l || typeof l.accountId !== 'string' || !int(l.amount) || l.amount <= 0) return false;
      sum += l.amount; return true;
    });
    if (!ok || sum !== Math.abs(view.commissionable)) return fail('FUNDS_SOURCE_INVALID', { source:FUNDS.id, expected:Math.abs(view.commissionable), got:sum });
    return { ok:true, lines:r.lines.map(function (l) { return { accountId:l.accountId, amount:l.amount, memo:typeof l.memo === 'string' ? l.memo : null }; }) };
  }

  /* ══════════════════════ BUILD (read-only) ══════════════════════ */
  /* the settlement's own figures must agree with each other — checked, never recomputed */
  function consistent(s){
    var f = s.figures || {}, at = s.adjustmentsTotal || {}, adj = s.adjustments || [];
    if (!int(f.commissionable) || !int(f.commission) || !int(f.entitlement)) return false;
    if (f.commission + f.entitlement !== f.commissionable || f.commission < 0 || f.entitlement < 0) return false;
    var sc = 0, sk = 0, se = 0;
    for (var i = 0; i < adj.length; i++) {
      var a = adj[i];
      if (!a || !int(a.commissionable) || !int(a.commission) || !int(a.entitlement) || !int(a.rateBp)) return false;
      if (a.commission + a.entitlement !== a.commissionable) return false;
      sc += a.commissionable; sk += a.commission; se += a.entitlement;
    }
    if ((at.commissionable || 0) !== sc || (at.commission || 0) !== sk || (at.entitlement || 0) !== se) return false;
    return s.settlementAmount === f.entitlement + se;
  }
  /* ══════════════════════ SETTLEMENT FUNDS MAPPING (read-only) ══════════════════════
     Maps the customer money behind a CLOSED settlement onto the settlement's
     own frozen figures. Nothing is recomputed: commission base, commission and
     entitlement are RAFSettlement's; customer money and its components are the
     order's commercial snapshot; payment, receipt and custody are RAFMoney's.

     SOURCES (per settlement order)
       RAFSettlement  settlement.orders[orderId] — gross, merchantDiscount,
                      rafDiscount, removedValue, commissionable, rafBorne,
                      refundedToCustomer (frozen at close)
       snapshot       commercial.grandTotal (what the customer owes / paid),
                      deliveryFee, driverTip, tax
       RAFMoney       payment record, component status, custody
     IDENTITY CHECKED  grandTotal = (gross − merchantDiscount − rafDiscount)
                                  + deliveryFee + driverTip + tax
     (checkout: total = subtotal − discount + delivery + tip). An order whose
     record does not satisfy it cannot be classified and stays unresolved.

     WHAT HAS A DEFINED DESTINATION TODAY (the RAF chart, phase 2)
       goods money on a commissionable line → this journal: commission (4100)
                                              + merchant payable (2100)
       received money held by RAF as cash   → 1100 acc-cash-bank
       online money owed by the gateway     → 1200 acc-gateway-receivable
       the order's delivery fee             → 2500 acc-delivery-fees-payable
                                              (confirmed: collected by RAF, owed to
                                              the delivery company; custody unchanged)
     WHAT DOES NOT (each refuses the posting; nothing is guessed)
       driver tip, tax, RAF-funded discount, refunds / removed or
       replaced lines, late adjustments' money side, wallet-paid money, any
       money not received or not yet RAF's (COD still with the driver).
     Ready only when nothing is unresolved and the money RAF holds equals
     commission + entitlement + delivery fees exactly. */
  var DEST = { raf_cash:'acc-cash-bank', gateway_receivable:'acc-gateway-receivable' };
  /* the account a payment component's money sits in — where its tip slice leaves */
  var FUNDING_ACC = { online:'acc-gateway-receivable', wallet:'acc-customer-wallet', cod:'acc-cash-bank' };
  /* the destinations this mapping credits / debits besides commission and merchant entitlement */
  var MAPPED = { REFUNDS:'acc-customer-refunds', RAF_DISCOUNT:'acc-raf-funded-discounts', WALLET:'acc-customer-wallet', PASS_THROUGH:'acc-passthrough-clearing' };
  var TREATMENT_CODES = ['TAX_ACCOUNTING_UNRESOLVED', 'REFUND_INCONSISTENT', 'MIXED_REFUND_UNRESOLVED',
    'ADJUSTMENT_MONEY_MAPPING_UNRESOLVED', 'ADJUSTMENT_REFUND_UNRESOLVED', 'ORIGINAL_SETTLEMENT_NOT_POSTED',
    'WALLET_FUNDING_NOT_RECOGNIZED', 'DRIVER_TIP_CUSTODY_UNRESOLVED', 'COD_WALLET_REFUND_NOT_COLLECTED',
    'ORDER_TOTAL_INCONSISTENT', 'ORDER_MONEY_UNRECORDED', 'ORDER_RECORD_MISSING',
    'SETTLEMENT_ORDER_BREAKDOWN_MISSING', 'SETTLEMENT_HAS_UNRESOLVED_ORDERS', 'FUNDS_DO_NOT_RECONCILE'];
  var BREAKDOWN = ['gross', 'merchantDiscount', 'rafDiscount', 'removedValue', 'commissionable', 'rafBorne', 'refundedToCustomer'];
  /* the money side of ONE closed settlement, classified component by component.
     Per order (C = frozen commission base, rafBorne = frozen RAF-funded discount):
       customer goods money  = gross − merchantDiscount − rafDiscount
                             = C − rafBorne + refundedToCustomer          (checked)
       customer money        = goods + deliveryFee + driverTip + tax         (checked)
       COD: what was refunded to the ORIGINAL payment was never collected
            (RAFMoney's amount due); everything else refunded is owed (2300)
     The settlement journal (when ready):
       Dr custody (1100 cash / 1200 gateway)      what RAF holds
       Dr 4200 RAF-funded Discounts               rafBorne
       Cr 4100 commission · Cr 2100 entitlement   (= C, frozen)
       Cr 2500 delivery fees · Cr 2300 refunds owed
       Cr 2800 Pass-through Clearing             driver tips (not RAF money)
     Driver tips are NOT RAF money (confirmed: customer → driver). The tip's
     share of the payment stays in its funding component's debit and is
     credited to 2800 Pass-through Clearing — never revenue, expense, merchant
     payable or delivery fee. It clears when the handover to the driver is
     posted. RAFDriverTips keeps the operational record.
     Negative late adjustments post their own journal (Dr 4100 / Dr 2100 /
     Cr 2300) when the original settlement journal has posted and the refunded
     goods carried no RAF-funded discount (and, for a cancellation, no fee or tip). */
  function mapSettlement(s){
    var M = global.RAFMoney, SN = global.RAFOrderSnapshot, S = ST(), A = AC(), f = s.figures || {};
    var items = [], byCode = {};
    function add(code, amount, orderId){
      var it = byCode[code];
      if (!it) { it = byCode[code] = { code:code, amountFils:0, orders:[] }; items.push(it); }
      if (int(amount)) it.amountFils += amount;
      if (orderId && it.orders.indexOf(orderId) < 0) it.orders.push(orderId);
    }
    function filsOf(v){ return M && M.filsOf ? M.filsOf(v) : null; }
    var ids = Object.keys(s.orders || {}).sort();
    (s.unresolved || []).forEach(function (u) { add('SETTLEMENT_HAS_UNRESOLVED_ORDERS', null, u.orderId); });
    var evr = null; try { evr = M && M.evidenceForOrders ? M.evidenceForOrders(ids) : null; } catch (e) { evr = null; }
    var ev = {}; ((evr && evr.ok && evr.items) || []).forEach(function (x) { ev[x.orderId] = x; });
    /* wallet credits RAFOrderChanges issued for an order's removed products */
    function walletRefundFils(id){ var s = 0; try { (global.RAFOrderChanges ? RAFOrderChanges.historyOf(id) : []).forEach(function (c) { var r = c && c.refundResult; if (r && r.destination === 'wallet') { var v = filsOf(r.amount); if (v) s += v; } }); } catch (e) {} return s; }
    var money = { totalFils:0, goodsFils:0, deliveryFeeFils:0, driverTipFils:0, taxFils:0 };
    var custody = { raf_cash:0, gateway_receivable:0, raf_wallet:0, driver_cod:0, not_received:0, no_record:0 };
    var debit = {}, sumC = 0, rafBorne = 0, refundPayable = 0, walletFils = 0, tipItems = [];
    var orders = ids.map(function (id) {
      var po = s.orders[id] || {}, o = { orderId:id };
      if (!BREAKDOWN.every(function (k) { return int(po[k]); })) { add('SETTLEMENT_ORDER_BREAKDOWN_MISSING', null, id); return o; }
      sumC += po.commissionable;
      o.commissionableFils = po.commissionable; o.merchantDiscountFils = po.merchantDiscount;
      o.rafDiscountFils = po.rafDiscount; o.rafBorneFils = po.rafBorne; o.refundedToCustomerFils = po.refundedToCustomer;
      var sn = null; try { sn = SN ? SN.of(id) : null; } catch (e) { sn = null; }
      if (!sn) { add('ORDER_RECORD_MISSING', null, id); return o; }
      var c = sn.commercial || {};
      var gt = filsOf(c.grandTotal), fee = filsOf(c.deliveryFee), tip = filsOf(c.driverTip), tax = filsOf(c.tax);
      var due = null; try { due = M && M.amountDueFor ? M.amountDueFor(id) : null; } catch (e) { due = null; }
      if (gt === null || fee === null || tip === null || tax === null || !due || due.dueFils === null) { add('ORDER_MONEY_UNRECORDED', null, id); return o; }
      var goods = po.gross - po.merchantDiscount - po.rafDiscount;
      o.customerMoneyFils = gt; o.goodsPaidFils = goods; o.deliveryFeeFils = fee; o.driverTipFils = tip; o.taxFils = tax;
      money.totalFils += gt; money.goodsFils += goods; money.deliveryFeeFils += fee; money.driverTipFils += tip; money.taxFils += tax;
      if (gt !== goods + fee + tip + tax) add('ORDER_TOTAL_INCONSISTENT', gt, id);
      /* every goods fils the customer paid is either kept against the base or refunded */
      if (goods !== po.commissionable - po.rafBorne + po.refundedToCustomer) add('REFUND_INCONSISTENT', Math.abs(goods - (po.commissionable - po.rafBorne + po.refundedToCustomer)), id);
      if (tax > 0) add('TAX_ACCOUNTING_UNRESOLVED', tax, id);
      /* confirmed: the delivery fee is owed to the delivery company (2500) */
      if (fee > 0) o.deliveryFeePayableFils = fee;
      rafBorne += po.rafBorne;
      /* refunds. COD: the customer pays the CURRENT adjusted total (RAFMoney), so
         everything removed before collection was simply never collected; only
         the rest of what was refunded is owed. A wallet credit issued for such a
         never-collected COD amount has no money behind it and cannot be mapped. */
      var notCollected = due.method === 'cod' ? gt - due.dueFils : 0, owed;
      if (due.method === 'cod') {
        owed = po.refundedToCustomer - notCollected;
        var wl = walletRefundFils(id);
        if (wl > 0 && notCollected > 0) add('COD_WALLET_REFUND_NOT_COLLECTED', Math.min(wl, notCollected), id);
      }
      else if (due.method === 'mixed') { owed = 0; if (po.refundedToCustomer > 0) add('MIXED_REFUND_UNRESOLVED', po.refundedToCustomer, id); }
      else owed = po.refundedToCustomer;
      if (owed < 0) { add('REFUND_INCONSISTENT', -owed, id); owed = 0; }
      o.refundPayableFils = owed; o.notCollectedFils = notCollected;
      refundPayable += owed;
      var expectedPay = due.method === 'cod' ? due.dueFils : gt;
      var e = ev[id];
      if (!e || !e.recorded) { custody.no_record += expectedPay; add('PAYMENT_RECORD_MISSING', expectedPay, id); o.payment = null; return o; }
      if (e.totalAmountFils !== expectedPay) add('PAYMENT_AMOUNT_MISMATCH', e.totalAmountFils, id);
      o.payment = { paymentId:e.paymentId, status:e.status, components:copy(e.components) };
      var orderDebit = {};
      e.components.forEach(function (cp) {
        if (cp.status !== 'received') { custody.not_received += cp.amountFils; add('PAYMENT_NOT_RECEIVED', cp.amountFils, id); return; }
        if (cp.custody === 'driver_cod') { custody.driver_cod += cp.amountFils; add('RAF_RECEIPT_MISSING', cp.amountFils, id); return; }
        if (cp.custody === 'raf_wallet') {
          /* customer funds, not external cash and not RAF money: the spend
             reduces 2200 Customer Wallet Liability (Dr 2200) and is allocated
             to the order's own components below — never a cash receipt. It
             posts only when the value spent was itself recognised in the
             ledger (top-up / refund / compensation postings — RAFWallet
             .spendCoverage); otherwise it waits, never guessed */
          custody.raf_wallet += cp.amountFils; walletFils += cp.amountFils;
          var cov = null; try { cov = global.RAFWallet && RAFWallet.spendCoverage && cp.walletTransactionId ? RAFWallet.spendCoverage(cp.walletTransactionId) : null; } catch (e2) { cov = null; }
          if (!cov || !cov.ok || !cov.covered) { add('WALLET_FUNDING_NOT_RECOGNIZED', cp.amountFils, id); return; }
          orderDebit[MAPPED.WALLET] = (orderDebit[MAPPED.WALLET] || 0) + cp.amountFils;
          return;
        }
        var acc = DEST[cp.custody];
        if (!acc) { custody.not_received += cp.amountFils; add('RAF_RECEIPT_MISSING', cp.amountFils, id); return; }
        custody[cp.custody] += cp.amountFils;
        orderDebit[acc] = (orderDebit[acc] || 0) + cp.amountFils;
      });
      /* the tip passed through RAF's custody but is the driver's, not RAF's:
         its slice of each FUNDING component (RAFMoney's allocation — the only
         component, or for Wallet + K-Net the larger first, Wallet on a tie,
         spilling into the other) stays in that component's debit (1200 K-Net,
         2200 wallet, 1100 cash) and is credited to 2800 Pass-through Clearing:
           Customer payment / Wallet → Pass-through Clearing → Driver
         never revenue, expense, merchant payable or delivery fee. 2800 clears
         when Accounting posts the driver handover (RAFDriverTips). */
      if (tip > 0) {
        var held1 = Object.keys(orderDebit), dt = e.driverTip || null, parts = [], okT = !!(dt && dt.funding === 'resolved' && dt.allocation);
        if (okT) dt.allocation.forEach(function (al) {
          if (!al.tipFils) return;
          var acc0 = FUNDING_ACC[al.method];
          if (!acc0 || !(orderDebit[acc0] >= al.tipFils)) okT = false;
          else parts.push({ componentId:al.componentId, method:al.method, tipFils:al.tipFils, fromAccountId:acc0 });
        });
        if (okT && parts.reduce(function (t0, p0) { return t0 + p0.tipFils; }, 0) === tip) {
          o.driverTipPassThroughFils = tip;
          tipItems.push({ orderId:id, amountFils:tip, allocation:parts, passthroughRef:'TIP-' + id,
                          kind:parts.some(function (p0) { return p0.method === 'wallet'; }) ? 'wallet_funded' : 'custody' });
        } else if (held1.length) add('DRIVER_TIP_CUSTODY_UNRESOLVED', tip, id);
      }
      Object.keys(orderDebit).forEach(function (k) { debit[k] = (debit[k] || 0) + orderDebit[k]; });
      return o;
    });
    if (ids.length && sumC !== f.commissionable && !byCode.SETTLEMENT_ORDER_BREAKDOWN_MISSING) add('SETTLEMENT_ORDER_BREAKDOWN_MISSING', null, null);
    /* late adjustments — each its own journal, in the open period of THIS close */
    var adjustments = (s.adjustments || []).filter(function (a) { return a.commissionable; }).map(function (a) {
      var out = { orderId:a.orderId, fromPeriod:a.fromPeriod, rateBp:a.rateBp, reason:a.reason || null,
                  commissionableFils:a.commissionable, commissionFils:a.commission, entitlementFils:a.entitlement,
                  originalSettlementId:'STL-' + s.storeSlug + '-' + a.fromPeriod, money:null, unresolved:null };
      function no(code){ out.unresolved = code; add(code, Math.abs(a.commissionable), a.orderId); return out; }
      if (a.commissionable > 0) return no('ADJUSTMENT_MONEY_MAPPING_UNRESOLVED');
      var orig = null; try { orig = S && S.closedForAccounting ? S.closedForAccounting(out.originalSettlementId) : null; } catch (e) { orig = null; }
      var ob = orig && orig.ok && orig.settlement.orders ? orig.settlement.orders[a.orderId] : null;
      if (!ob) return no('ADJUSTMENT_REFUND_UNRESOLVED');
      var posted = null; try { posted = A ? A.journalBySource(SOURCE_SYSTEM, out.originalSettlementId) : null; } catch (e) { posted = null; }
      if (!posted || !posted.ok) return no('ORIGINAL_SETTLEMENT_NOT_POSTED');
      if (ob.rafBorne > 0) return no('ADJUSTMENT_REFUND_UNRESOLVED');
      if (a.reason === 'order_cancelled') {
        var sn2 = null; try { sn2 = SN ? SN.of(a.orderId) : null; } catch (e) { sn2 = null; }
        var c2 = (sn2 && sn2.commercial) || {};
        if (!sn2 || filsOf(c2.deliveryFee) !== 0 || filsOf(c2.driverTip) !== 0) return no('ADJUSTMENT_REFUND_UNRESOLVED');
      }
      out.money = { accountId:MAPPED.REFUNDS, amountFils:-a.commissionable, originalJournalId:posted.journal.journalId };
      return out;
    });
    var reconciles = int(f.commission) && int(f.entitlement) && f.commission + f.entitlement === f.commissionable;
    var held = Object.keys(debit).reduce(function (t, k) { return t + debit[k]; }, 0);
    var feeTotal = money.deliveryFeeFils, tipTotal = tipItems.reduce(function (t, x) { return t + x.amountFils; }, 0);
    /* what RAF holds + what RAF funded = what is owed and earned */
    if (!items.length && (!reconciles || held + rafBorne !== f.commission + f.entitlement + feeTotal + tipTotal + refundPayable)) add('FUNDS_DO_NOT_RECONCILE', held, null);
    var ready = !items.length;
    var legacy = { source:'RAFMoney',
      noPaymentRecord:ids.filter(function (id) { return !(ev[id] && ev[id].recorded); }),
      notReceivedByRaf:ids.filter(function (id) { return ev[id] && ev[id].recorded && !ev[id].rafReceived; }),
      receivedByRaf:ids.filter(function (id) { return ev[id] && ev[id].rafReceived; }) };
    var missing = [];
    if (legacy.noPaymentRecord.length) missing.push('customer_payment_record');
    if (legacy.notReceivedByRaf.length) missing.push('raf_receipt');
    if (items.some(function (i) { return TREATMENT_CODES.indexOf(i.code) > -1; })) missing.push('funds_mapping_decision');
    var dPlan = Object.keys(debit).sort().filter(function (k) { return debit[k] > 0; }).map(function (k) {
      return { accountId:k, amount:debit[k], memo:k === 'acc-cash-bank' ? 'Money held: RAF cash' : k === MAPPED.WALLET ? 'Paid from customer wallet funds (2200)' : 'Money held: gateway receivable' }; });
    if (rafBorne > 0) dPlan.push({ accountId:MAPPED.RAF_DISCOUNT, amount:rafBorne, memo:'RAF-funded discount (frozen settlement value)' });
    var cPlan = [{ accountId:ACC.COMMISSION, amount:f.commission }, { accountId:ACC.PAYABLES, amount:f.entitlement },
                 { accountId:ACC.DELIVERY_FEES, amount:feeTotal }, { accountId:MAPPED.PASS_THROUGH, amount:tipTotal },
                 { accountId:MAPPED.REFUNDS, amount:refundPayable }].filter(function (x) { return x.amount > 0; });
    return {
      settlementId:s.id, storeSlug:s.storeSlug, period:s.period, status:s.status, currency:s.currency || 'KWD', rateBp:s.rateBp,
      settlement:{ commissionableFils:f.commissionable, commissionFils:f.commission, entitlementFils:f.entitlement,
                   settlementAmountFils:s.settlementAmount, grossFils:f.gross, merchantDiscountFils:f.merchantDiscount,
                   rafDiscountFils:f.rafDiscount, rafBorneFils:f.rafBorne, removedValueFils:f.removedValue,
                   refundedToCustomerFils:f.refundedToCustomer, adjustmentsTotal:copy(s.adjustmentsTotal) },
      customerMoney:money,
      deliveryFeeMapping:{ amountFils:feeTotal, accountId:ACC.DELIVERY_FEES,
                           orders:orders.filter(function (o) { return o.deliveryFeePayableFils > 0; }).map(function (o) { return o.orderId; }) },
      /* not RAF money: credited to 2800 Pass-through Clearing (never revenue / expense) */
      driverTipMapping:{ amountFils:tipTotal, accountId:MAPPED.PASS_THROUGH, items:copy(tipItems) },
      rafFundedDiscountMapping:{ amountFils:rafBorne, accountId:MAPPED.RAF_DISCOUNT, source:'RAFSettlement frozen rafBorne' },
      merchantDiscountFils:f.merchantDiscount,
      refundMapping:{ amountFils:refundPayable, accountId:MAPPED.REFUNDS,
                      notCollectedCodFils:orders.reduce(function (t, o) { return t + (o.notCollectedFils || 0); }, 0) },
      walletMapping:{ amountFils:walletFils, accountId:MAPPED.WALLET, debitFils:debit[MAPPED.WALLET] || 0, fundingRecognized:walletFils > 0 && (debit[MAPPED.WALLET] || 0) === walletFils },
      taxMapping:{ amountFils:money.taxFils, applied:money.taxFils > 0 },
      commissionMapping:{ commissionableFils:f.commissionable, commissionFils:f.commission, entitlementFils:f.entitlement, reconciles:!!reconciles },
      moneyEvidence:{ custody:custody, rafHeldFils:held, debitByAccount:copy(debit) },
      orders:orders, adjustments:adjustments,
      unresolvedItems:items, readyForPosting:ready,
      debitPlan:ready ? dPlan : null, creditPlan:ready ? cPlan : null,
      missing:missing, legacyEvidence:legacy
    };
  }
  /* the mapping of one closed settlement — read-only, deterministic, repeatable */
  function mapFunds(settlementId){
    var A = AC(), S = ST(); if (!A || !S) return fail('UNAVAILABLE');
    var cap = A.capabilities(); if (!cap.ok) return cap;
    if (!cap.view) return { ok:false, code:'FORBIDDEN', message:T('لا تملك صلاحية تنفيذ هذا الإجراء.', 'You do not have permission for this action.') };
    var r = S.closedForAccounting(settlementId); if (!r.ok) return r;
    var s = r.settlement;
    if (s.status === 'empty') return fail('NOTHING_TO_POST', { settlementId:settlementId });
    if (!global.RAFMoney) return fail('ACCOUNTING_SOURCE_INCOMPLETE', { settlementId:settlementId, missing:['customer_payment_record'], unresolved:[{ code:'MONEY_AUTHORITY_UNAVAILABLE', amountFils:0, orders:[] }] });
    var m = mapSettlement(s); delete m.legacyEvidence;
    return { ok:true, mapping:m };
  }

  /* one journal: funds side + commission + merchant payable, mirrored when negative */
  /* a journal line; memo / ref are carried only when present (RAFAccounting
     accepts a missing field or text, never an explicit null) */
  function line(accountId, side, amount, memo, ref){
    var o = { accountId:accountId }; o[side] = amount;
    if (memo) o.memo = memo; if (ref) o.ref = ref;
    return o;
  }
  function journalFor(view, funds, date, description, memoRate, lineRef){
    var pos = view.commissionable > 0, lines = [];
    funds.forEach(function (l) { lines.push(line(l.accountId, pos ? 'debit' : 'credit', l.amount, l.memo, lineRef)); });
    var k = Math.abs(view.commission), e = Math.abs(view.entitlement);
    if (k) lines.push(line(ACC.COMMISSION, pos ? 'credit' : 'debit', k, memoRate, lineRef));
    if (e) lines.push(line(ACC.PAYABLES, pos ? 'credit' : 'debit', e, null, lineRef));
    return { date:date, description:description, lines:lines };
  }
  /* reads the frozen settlement and builds every journal it implies; writes nothing */
  function build(settlementId){
    var S = ST(), A = AC();
    if (!S || !S.closedForAccounting || !A) return fail('UNAVAILABLE');
    var r = S.closedForAccounting(settlementId); if (!r.ok) return r;
    var s = r.settlement;
    if (s.status === 'empty') return fail('NOTHING_TO_POST', { settlementId:settlementId });
    if (POSTABLE.indexOf(s.status) < 0) return fail('SETTLEMENT_INCONSISTENT', { settlementId:settlementId, status:s.status });
    if (s.rateBp === null || !s.figures || s.figures.commission === null) return fail('SETTLEMENT_INCOMPLETE', { settlementId:settlementId });
    if (!consistent(s)) return fail('SETTLEMENT_INCONSISTENT', { settlementId:settlementId });
    /* the two RAF accounts, by stable ID */
    var missingAcc = [ACC.COMMISSION, ACC.PAYABLES].filter(function (id) {
      var g = A.getAccount(id); return !(g && g.ok && g.account.status === 'active' && g.account.postable);
    });
    if (missingAcc.length) return fail('ACCOUNTS_MISSING', { accounts:missingAcc });

    var date = A.kuwaitDateOf(s.closedAt);
    var plan = [], f = s.figures;
    /* with the money authority present, the debit side comes ONLY from the
       funds mapping: every customer-money component mapped, every order's money
       received and RAF's, nothing unresolved — otherwise the whole settlement
       is refused with the exact unresolved items (no partial journal) */
    if (global.RAFMoney && (f.commissionable !== 0 || (s.adjustments || []).some(function (a) { return a.commissionable; }))) {
      var mp = mapSettlement(s);
      if (!mp.readyForPosting) return fail('ACCOUNTING_SOURCE_INCOMPLETE', { settlementId:s.id, kind:'settlement',
        missing:mp.missing, unresolved:mp.unresolvedItems, moneyEvidence:mp.legacyEvidence, amount:Math.abs(f.commissionable),
        mapping:(function () { var c = copy(mp); delete c.legacyEvidence; return c; })() });
      var desc = 'Settlement ' + s.id + ' · ' + s.storeSlug + ' · ' + s.period + ' | تسوية';
      var sref = 'store:' + s.storeSlug, memoK = 'Commission ' + percentText(s.rateBp) + '%';
      var MEMO = {}; MEMO[ACC.DELIVERY_FEES] = 'Delivery fees collected for delivery (payable)';
      MEMO[MAPPED.PASS_THROUGH] = 'Driver tips passing through to drivers (not RAF money)'; MEMO[MAPPED.REFUNDS] = 'Customer refunds owed';
      MEMO[ACC.COMMISSION] = memoK;
      if (f.commissionable !== 0) {
        var dl = mp.debitPlan.map(function (d) { return line(d.accountId, 'debit', d.amount, d.memo, sref); });
        var cl = mp.creditPlan.map(function (c) { return line(c.accountId, 'credit', c.amount, MEMO[c.accountId] || null, sref); });
        var dsum = mp.debitPlan.reduce(function (t, d) { return t + d.amount; }, 0), csum = mp.creditPlan.reduce(function (t, c) { return t + c.amount; }, 0);
        if (dsum !== csum) return fail('ACCOUNTING_SOURCE_INCOMPLETE', { settlementId:s.id, missing:['funds_mapping_decision'], unresolved:[{ code:'FUNDS_DO_NOT_RECONCILE', amountFils:dsum - csum, orders:[] }] });
        plan.push({ kind:'settlement', ref:s.id,
          view:{ kind:'settlement', settlementId:s.id, storeSlug:s.storeSlug, period:s.period, rateBp:s.rateBp,
                 commissionable:f.commissionable, commission:f.commission, entitlement:f.entitlement },
          entry:{ date:date, description:desc, lines:dl.concat(cl) } });
      }
      /* each mapped late adjustment: its own journal, never the old one */
      mp.adjustments.forEach(function (a) {
        var av = { kind:'adjustment', settlementId:s.id, storeSlug:s.storeSlug, period:s.period, orderId:a.orderId, fromPeriod:a.fromPeriod,
                   rateBp:a.rateBp, reason:a.reason, commissionable:a.commissionableFils, commission:a.commissionFils, entitlement:a.entitlementFils,
                   originalSettlementId:a.originalSettlementId };
        plan.push({ kind:'adjustment', ref:'adjustment:' + s.id + ':' + a.orderId + ':' + a.fromPeriod, view:av,
          entry:journalFor(av, [{ accountId:a.money.accountId, amount:a.money.amountFils, memo:'Customer refund owed (late adjustment of ' + a.originalSettlementId + ')' }], date,
            'Settlement adjustment ' + s.id + ' · order ' + a.orderId + ' (from ' + a.fromPeriod + ', original ' + a.originalSettlementId + ') | تعديل تسوية',
            'Commission ' + percentText(a.rateBp) + '% (rate of ' + a.fromPeriod + ')', 'order:' + a.orderId) });
      });
      if (!plan.length) return fail('NOTHING_TO_POST', { settlementId:s.id });
      /* every account the plan touches must exist, be active and postable */
      var need = {}; plan.forEach(function (p) { p.entry.lines.forEach(function (l) { need[l.accountId] = 1; }); });
      var bad = Object.keys(need).filter(function (id) { var g = A.getAccount(id); return !(g && g.ok && g.account.status === 'active' && g.account.postable); });
      if (bad.length) return fail('ACCOUNTS_MISSING', { accounts:bad });
      return { ok:true, settlement:s, date:date, plan:plan, mapping:mp };
    }
    if (f.commissionable !== 0) {
      var view = { kind:'settlement', settlementId:s.id, storeSlug:s.storeSlug, period:s.period, rateBp:s.rateBp,
                   commissionable:f.commissionable, commission:f.commission, entitlement:f.entitlement,
                   gross:f.gross, merchantDiscount:f.merchantDiscount, rafDiscount:f.rafDiscount, rafBorne:f.rafBorne,
                   refundedToCustomer:f.refundedToCustomer, orders:Object.keys(s.orders || {}).sort() };
      var fu = resolveFunds(view); if (!fu.ok) return Object.assign(fu, { settlementId:s.id, kind:'settlement' });
      plan.push({ kind:'settlement', ref:s.id, view:view,
        entry:journalFor(view, fu.lines, date,
          'Settlement ' + s.id + ' · ' + s.storeSlug + ' · ' + s.period + ' | تسوية',
          'Commission ' + percentText(s.rateBp) + '%', 'store:' + s.storeSlug) });
    }
    (s.adjustments || []).forEach(function (a) {
      if (!a.commissionable) return;
      var v = { kind:'adjustment', settlementId:s.id, storeSlug:s.storeSlug, period:s.period, orderId:a.orderId,
                fromPeriod:a.fromPeriod, rateBp:a.rateBp, reason:a.reason || null,
                commissionable:a.commissionable, commission:a.commission, entitlement:a.entitlement, rafBorne:0 };
      plan.push({ kind:'adjustment', ref:'adjustment:' + s.id + ':' + a.orderId + ':' + a.fromPeriod, view:v });
    });
    /* resolve every adjustment's funds before anything is posted */
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i]; if (p.entry) continue;
      var fa = resolveFunds(p.view); if (!fa.ok) return Object.assign(fa, { settlementId:s.id, kind:'adjustment', orderId:p.view.orderId });
      p.entry = journalFor(p.view, fa.lines, date,
        'Settlement adjustment ' + s.id + ' · order ' + p.view.orderId + ' (from ' + p.view.fromPeriod + ') | تعديل تسوية',
        'Commission ' + percentText(p.view.rateBp) + '% (rate of ' + p.view.fromPeriod + ')', 'order:' + p.view.orderId);
    }
    if (!plan.length) return fail('NOTHING_TO_POST', { settlementId:s.id });
    return { ok:true, settlement:s, date:date, plan:plan };
  }

  function audit(action, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try {
      var o = { action:action, source:'system' };
      var sid = global.RAFPerm && RAFPerm.sessionUserId ? RAFPerm.sessionUserId() : null;
      if (sid) o.actor = { id:sid };
      for (var k in (extra || {})) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return RAFAudit.record(o);
    } catch (e) { return null; }
  }
  var REFUSALS_AUDITED = ['ACCOUNTING_SOURCE_INCOMPLETE', 'FUNDS_SOURCE_INVALID', 'SETTLEMENT_INCONSISTENT', 'SETTLEMENT_INCOMPLETE',
                          'ACCOUNTS_MISSING', 'INTEGRITY_CONFLICT', 'ACCOUNTING_REFUSED'];
  function refused(settlementId, r){
    if (REFUSALS_AUDITED.indexOf(r.code) > -1) {
      var uc = (r.unresolved || []).map(function (u) { return u.code; });
      audit('accounting.settlement_posting_refused', { key:settlementId + '|' + r.code + '|' + (r.accountingCode || '') + '|' + (r.missing || []).join(',') + (uc.length ? '|' + uc.join(',') : ''),
        reason:r.code, metadata:{ settlementId:settlementId, code:r.code, accountingCode:r.accountingCode || null, missing:r.missing || null,
                                  unresolved:(r.unresolved || []).map(function (u) { return { code:u.code, amountFils:u.amountFils, orders:u.orders }; }) } });
    }
    return r;
  }

  /* ══════════════════════ POST ══════════════════════ */
  function post(settlementId){
    var A = AC(); if (!A || !ST()) return fail('UNAVAILABLE');
    /* the executor must be an account RAFAccounting itself authorises to post;
       nothing here is attempted (or audited) for anyone else */
    var cap = A.capabilities();
    if (!cap.ok) return cap;
    if (!cap.post) return { ok:false, code:'FORBIDDEN', message:T('لا تملك صلاحية تنفيذ هذا الإجراء.', 'You do not have permission for this action.') };
    var b = build(settlementId);
    if (!b.ok) return refused(settlementId, b);
    /* every journal is checked before the first is written */
    var checks = b.plan.map(function (p) {
      return A.validateJournal(Object.assign({}, p.entry, { source:{ system:SOURCE_SYSTEM, ref:p.ref } }));
    });
    for (var i = 0; i < checks.length; i++) {
      var c = checks[i];
      if (!c.ok) return refused(settlementId, c.code === 'SOURCE_CONFLICT'
        ? fail('INTEGRITY_CONFLICT', { settlementId:settlementId, ref:b.plan[i].ref, journalId:c.journalId })
        : fail('ACCOUNTING_REFUSED', { settlementId:settlementId, ref:b.plan[i].ref, accountingCode:c.code, accountingMessage:c.message, errors:c.errors || null }));
    }
    var out = [];
    for (var j = 0; j < b.plan.length; j++) {
      var p = b.plan[j];
      var w = A.postFromSource(SOURCE_SYSTEM, p.ref, p.entry);
      if (!w.ok) return refused(settlementId, fail(w.code === 'SOURCE_CONFLICT' ? 'INTEGRITY_CONFLICT' : 'ACCOUNTING_REFUSED',
        { settlementId:settlementId, ref:p.ref, accountingCode:w.code, posted:out }));
      out.push({ kind:p.kind, ref:p.ref, journalId:w.journal.journalId, duplicate:!!w.duplicate, orderId:p.view.orderId || null });
      if (!w.duplicate) audit('accounting.settlement_posted', { key:w.journal.journalId, newState:'posted',
        metadata:{ settlementId:settlementId, kind:p.kind, journalId:w.journal.journalId, storeSlug:b.settlement.storeSlug,
                   period:b.settlement.period, orderId:p.view.orderId || null, fromPeriod:p.view.fromPeriod || null,
                   commissionable:p.view.commissionable, commission:p.view.commission, entitlement:p.view.entitlement,
                   fundsSource:FUNDS ? FUNDS.id : null } });
    }
    return { ok:true, settlementId:settlementId, date:b.date, journals:out,
             duplicate:out.every(function (x) { return x.duplicate; }) };
  }

  /* ══════════════════════ READS ══════════════════════ */
  /* what posting this settlement would produce — no write, no audit */
  function preview(settlementId){
    var A = AC(); if (!A) return fail('UNAVAILABLE');
    var cap = A.capabilities(); if (!cap.ok) return cap;
    if (!cap.view) return { ok:false, code:'FORBIDDEN', message:T('لا تملك صلاحية تنفيذ هذا الإجراء.', 'You do not have permission for this action.') };
    var b = build(settlementId); if (!b.ok) return b;
    return { ok:true, settlementId:settlementId, date:b.date, journals:b.plan.map(function (p) { return { kind:p.kind, ref:p.ref, entry:copy(p.entry) }; }) };
  }
  /* which of the settlement's journals already exist in the accounting record */
  function status(settlementId){
    var A = AC(), S = ST(); if (!A || !S) return fail('UNAVAILABLE');
    var r = S.closedForAccounting(settlementId); if (!r.ok) return r;
    var s = r.settlement, refs = [s.id].concat((s.adjustments || []).filter(function (a) { return a.commissionable; })
      .map(function (a) { return 'adjustment:' + s.id + ':' + a.orderId + ':' + a.fromPeriod; }));
    var items = refs.map(function (ref) {
      var j = A.journalBySource(SOURCE_SYSTEM, ref);
      return { ref:ref, posted:!!(j && j.ok), journalId:j && j.ok ? j.journal.journalId : null };
    });
    if (!s.figures || !s.figures.commissionable) items = items.filter(function (x) { return x.ref !== s.id; });
    return { ok:true, settlementId:s.id, settlementStatus:s.status, items:items,
             posted:items.length > 0 && items.every(function (x) { return x.posted; }) };
  }
  /* every closed settlement and whether its journals are in the record */
  function pending(){
    var S = ST(); if (!S) return fail('UNAVAILABLE');
    var l = S.closedListForAccounting(); if (!l.ok) return l;
    return { ok:true, items:l.items.filter(function (x) { return POSTABLE.indexOf(x.status) > -1; }).map(function (x) {
      var st = status(x.settlementId);
      return { settlementId:x.settlementId, storeSlug:x.storeSlug, period:x.period, settlementStatus:x.status,
               posted:!!(st.ok && st.posted) };
    }) };
  }

  global.RAFSettlementPosting = {
    SOURCE_SYSTEM:SOURCE_SYSTEM, ACCOUNTS:copy(ACC), ERRORS:ERRORS,
    registerFundsSource:registerFundsSource, fundsSource:fundsSource,
    post:post, preview:preview, status:status, pending:pending,
    /* the settlement funds mapping (read-only) */
    mapFunds:mapFunds
  };
})(window);
