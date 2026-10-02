/* ============================================================
   RAF · CUSTOMER WALLET  (Group C · Phase 0)

   A shared financial authority. Nothing else in RAF keeps a
   wallet balance: the balance here is DERIVED from an
   append-only ledger, never stored as a mutable field.

       Customer UI  →  RAFWallet  →  wallet ledger

   Money is held as an integer number of fils (1 KWD = 1000
   fils). Every sum is integer arithmetic, so no balance can
   drift the way repeated float addition does.

   STORAGE HONESTY — this runs on localStorage. There is no
   server, no transaction, no lock, no cross-device sync. The
   ledger is append-only and every operation is idempotent by
   key, which makes replay safe; it does NOT make this
   production-grade financial storage. See storageLimits().

   EXPIRING CREDIT LOTS (Phase I) — a credit may create a LOT:
   value that stays identifiable and expires at a fixed instant
   (today only Compensation Credits). Ordinary balance never
   expires. Everything about a lot is DERIVED from the ledger:
       original  = its credit entry
       consumed  = debits that record { consumes:[{ lotId, amountMinor }] }
       expired   = its one COMPENSATION_EXPIRY debit (key per lot)
       reversed  = its one COMPENSATION_REVERSAL debit
       remaining = original − consumed − expired − reversed
   Approved rules:
     · spending order — unexpired lots first, soonest expiry
       first, then ordinary balance;
     · at expiresAt only the lot's unused remainder expires; a lot
       past expiresAt is excluded from the balance immediately, and
       its expiry entry is appended (idempotently) the next time the
       wallet is read or debited — no timer, no polling;
     · a reversal takes only the lot's unused remainder.
   A lot is credited only by its signed-in customer, only for a
   real, non-voided source record whose customer / amount / dates
   match exactly (read through RAFRecordStore), once per source.
   A reversal needs the source's existing management permission.
   ============================================================ */
(function (global) {
  if (global.RAFWallet) return;

  var LS_WALLETS = 'raf_wallets';
  var LS_LEDGER  = 'raf_wallet_ledger';

  var CURRENCY = 'KWD';
  var MINOR    = 1000;          /* fils per dinar — KWD has 3 decimal places */
  var DECIMALS = 3;

  var STATUS = { ACTIVE:'active', FROZEN:'frozen', CLOSED:'closed' };
  var TYPE   = { CREDIT:'credit', DEBIT:'debit' };
  var ACTOR  = { CUSTOMER:'customer', SYSTEM:'system', MERCHANT:'merchant' };

  /* why value moved. A closed list — the caller may not invent one. */
  var REASON = {
    PRODUCT_REMOVAL_REFUND:        'PRODUCT_REMOVAL_REFUND',
    PRODUCT_REPLACEMENT_DIFFERENCE:'PRODUCT_REPLACEMENT_DIFFERENCE',
    ORDER_ADJUSTMENT_REFUND:       'ORDER_ADJUSTMENT_REFUND',
    /* Phase I — lot operations; reserved: only the lot API below may use them */
    COMPENSATION_CREDIT:           'COMPENSATION_CREDIT',
    COMPENSATION_EXPIRY:           'COMPENSATION_EXPIRY',
    COMPENSATION_REVERSAL:         'COMPENSATION_REVERSAL',
    /* customer-initiated value — reserved: only topUp() and redeemGift() below may use them */
    WALLET_TOPUP:                  'WALLET_TOPUP',
    GIFT_REDEMPTION:               'GIFT_REDEMPTION',
    /* spending — the customer pays (part of) an order from the wallet */
    ORDER_PAYMENT:                 'ORDER_PAYMENT',
    /* reserved: the reversal of a wallet-funded driver tip (cancelled before delivery) */
    DRIVER_TIP_REVERSAL:           'DRIVER_TIP_REVERSAL'
  };
  var LOT_REASONS = { COMPENSATION_CREDIT:true, COMPENSATION_EXPIRY:true, COMPENSATION_REVERSAL:true };
  /* reasons that only one internal path may post (checked in post()) */
  var PATH_REASONS = { WALLET_TOPUP:'topup', GIFT_REDEMPTION:'gift', DRIVER_TIP_REVERSAL:'tipreversal' };
  var LOT_SOURCE = { COMPENSATION:'compensation' };
  /* customer-facing wording for each reason; the customer never sees the key */
  var REASON_TEXT = {
    PRODUCT_REMOVAL_REFUND:         { ar:'استرداد قيمة منتج غير متوفر',  en:'Refund for unavailable product' },
    PRODUCT_REPLACEMENT_DIFFERENCE: { ar:'فرق سعر بعد استبدال منتج',     en:'Price difference after a product replacement' },
    ORDER_ADJUSTMENT_REFUND:        { ar:'تعديل على الطلب',              en:'Order adjustment' },
    COMPENSATION_CREDIT:            { ar:'رصيد تعويض (ينتهي في موعد محدد)', en:'Compensation credit (expires on a set date)' },
    COMPENSATION_EXPIRY:            { ar:'انتهاء صلاحية رصيد تعويض غير مستخدم', en:'Unused compensation credit expired' },
    COMPENSATION_REVERSAL:          { ar:'إلغاء رصيد تعويض غير مستخدم',   en:'Unused compensation credit reversed' },
    WALLET_TOPUP:                   { ar:'إعادة تعبئة المحفظة',            en:'Wallet top-up' },
    GIFT_REDEMPTION:                { ar:'استخدام رمز هدية',              en:'Gift code redeemed' },
    ORDER_PAYMENT:                  { ar:'الدفع لطلب',                    en:'Order payment' },
    DRIVER_TIP_REVERSAL:            { ar:'إعادة إكرامية السائق (أُلغي الطلب قبل التسليم)', en:'Driver tip returned (order cancelled before delivery)' }
  };
  var SOURCE = { ORDER_CHANGE:'order_change', REFUND:'refund',
                 CUSTOMER_PAYMENT:'customer_payment', SYSTEM:'system', MANUAL:'manual', GIFT:'gift' };

  var ERRORS = {
    WALLET_FORBIDDEN:             { ar:'لا يمكنك الوصول إلى هذه المحفظة.',    en:'You cannot access this wallet.' },
    WALLET_NOT_FOUND:             { ar:'لا توجد محفظة لهذا العميل.',          en:'No wallet exists for this customer.' },
    WALLET_NOT_ACTIVE:            { ar:'المحفظة غير نشطة.',                   en:'This wallet is not active.' },
    INVALID_AMOUNT:               { ar:'المبلغ غير صالح.',                    en:'The amount is not valid.' },
    INVALID_CURRENCY:             { ar:'عملة غير مدعومة.',                    en:'Unsupported currency.' },
    INVALID_REASON:               { ar:'سبب العملية غير صالح.',               en:'The transaction reason is not valid.' },
    IDEMPOTENCY_KEY_REQUIRED:     { ar:'مفتاح العملية مطلوب.',                en:'An idempotency key is required.' },
    IDEMPOTENCY_CONFLICT:         { ar:'تم استخدام مفتاح العملية بقيم مختلفة.', en:'This transaction key was already used with different values.' },
    INSUFFICIENT_WALLET_BALANCE:  { ar:'رصيد المحفظة غير كافٍ.',              en:'Insufficient wallet balance.' },
    REASON_RESERVED:              { ar:'هذا السبب مخصص لعمليات رصيد التعويض.', en:'That reason is reserved for compensation credit operations.' },
    LOT_INVALID:                  { ar:'بيانات رصيد التعويض غير صالحة.',       en:'The compensation credit details are not valid.' },
    LOT_NOT_FOUND:                { ar:'رصيد التعويض غير موجود.',              en:'That compensation credit does not exist.' },
    LOT_EXPIRED:                  { ar:'انتهت صلاحية رصيد التعويض.',            en:'The compensation credit has expired.' },
    LOT_NOTHING_REMAINING:        { ar:'لا يوجد رصيد تعويض غير مستخدم.',       en:'No unused compensation credit remains.' },
    LEDGER_WRITE_FAILED:          { ar:'تعذّر حفظ عملية المحفظة.',            en:'The wallet transaction could not be saved.' },
    PAYMENT_METHOD_INVALID:       { ar:'طريقة الدفع غير متاحة لإعادة التعبئة.', en:'That payment method cannot be used for a top-up.' },
    GIFT_NOT_FOUND:               { ar:'رمز الهدية غير صحيح.',                en:'That gift code is not valid.' },
    GIFT_USED:                    { ar:'تم استخدام رمز الهدية من قبل.',        en:'That gift code has already been used.' },
    GIFT_EXPIRED:                 { ar:'انتهت صلاحية رمز الهدية.',             en:'That gift code has expired.' },
    GIFT_NOT_AVAILABLE:           { ar:'رمز الهدية غير متاح للاستخدام.',      en:'That gift code is not available.' },
    PAYMENT_UNAVAILABLE:          { ar:'تعذّر تسجيل الدفع.',                  en:'The payment could not be recorded.' },
    PAYMENT_NOT_RECEIVED:         { ar:'لم يُستلم الدفع بعد؛ لا يُضاف رصيد.',  en:'The payment has not been received; no value is added.' },
    PAYMENT_NOT_TOPUP:            { ar:'هذا الدفع ليس إعادة تعبئة للمحفظة.',   en:'That payment is not a wallet top-up.' },
    FORBIDDEN:                    { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',   en:'You do not have permission for this action.' },
    TRANSACTION_NOT_FOUND:        { ar:'عملية المحفظة غير موجودة.',           en:'The wallet transaction does not exist.' },
    NOT_A_CREDIT:                 { ar:'هذه العملية ليست إضافة رصيد.',         en:'That transaction is not a credit.' },
    RECOGNIZED_BY_REFUND:         { ar:'يُسجَّل هذا الرصيد محاسبياً مع الاسترداد (RAFRefunds).', en:'This credit is recognised by its refund posting (RAFRefunds).' },
    RECOGNIZED_BY_GIFT:           { ar:'يُسجَّل هذا الرصيد محاسبياً مع استخدام رمز الهدية (RAFGift).', en:'This credit is recognised by its gift code redemption posting (RAFGift).' },
    ACCOUNTING_UNRESOLVED:        { ar:'المعالجة المحاسبية لهذا المصدر غير محددة بعد.', en:'The accounting treatment for this source is not defined yet.' },
    SOURCE_NOT_VERIFIED:          { ar:'تعذّر التحقق من مصدر الرصيد.',         en:'The source of this credit could not be verified.' },
    ACCOUNTING_REFUSED:           { ar:'رفض السجل المحاسبي القيد.',            en:'The accounting record refused the journal.' }
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, reason:code, ar:m.ar, en:m.en, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* ---------- money ----------
     Callers speak in dinars; the ledger stores fils. A value that cannot be
     expressed exactly in fils is refused rather than rounded into existence. */
  function toMinor(amount){
    if (typeof amount === 'string' && amount.trim() !== '') amount = Number(amount);
    if (typeof amount !== 'number' || !isFinite(amount)) return null;
    var minor = amount * MINOR;
    /* tolerate binary float representation, refuse genuine sub-fils precision */
    var rounded = Math.round(minor);
    if (Math.abs(minor - rounded) > 1e-6) return null;
    return rounded;
  }
  function toMajor(minor){ return minor / MINOR; }
  function fmt(minor){ return (minor / MINOR).toFixed(DECIMALS); }

  /* ---------- storage ---------- */
  function readJSON(key, dflt){
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? dflt : v; }
    catch (e) { return dflt; }
  }
  /* a write that silently failed would be a lie about money, so it throws */
  function writeJSON(key, value){
    localStorage.setItem(key, JSON.stringify(value));
  }
  function wallets(){ var w = readJSON(LS_WALLETS, {}); return (w && typeof w === 'object') ? w : {}; }
  function ledger(){ var l = readJSON(LS_LEDGER, []); return Array.isArray(l) ? l : []; }

  function walletKey(customerId, currency){ return customerId + '|' + currency; }

  /* ---------- wallet ---------- */
  /* Lazily created: a customer gets a wallet the first time one is genuinely
     needed, and exactly one per currency. Calling this twice is not two
     wallets. */
  function ensureWallet(customerId, currency){
    currency = currency || CURRENCY;
    if (!customerId) return null;
    if (currency !== CURRENCY) return null;
    var all = wallets(), k = walletKey(customerId, currency);
    if (all[k]) return all[k];
    var w = {
      walletId: 'WLT-' + customerId + '-' + currency,
      customerId: customerId,
      currency: currency,
      status: STATUS.ACTIVE,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    all[k] = w;
    try { writeJSON(LS_WALLETS, all); } catch (e) { return null; }
    return w;
  }
  function walletOf(customerId, currency){
    return wallets()[walletKey(customerId, currency || CURRENCY)] || null;
  }
  function touch(walletId){
    var all = wallets();
    for (var k in all) if (all[k].walletId === walletId){ all[k].updatedAt = Date.now(); }
    try { writeJSON(LS_WALLETS, all); } catch (e) {}
  }

  /* ---------- ledger reads ---------- */
  function entriesOf(walletId){
    return ledger().filter(function (t) { return t.walletId === walletId; });
  }
  /* the plain sum of every entry — what has actually been written */
  function ledgerSumMinorOf(walletId){
    return entriesOf(walletId).reduce(function (sum, t) {
      return sum + (t.type === TYPE.CREDIT ? t.amountMinor : -t.amountMinor);
    }, 0);
  }

  /* ---------- lots (derived; see header) ---------- */
  function lotsOf(walletId, now){
    now = now == null ? Date.now() : now;
    var list = entriesOf(walletId), byId = {}, order = [];
    list.forEach(function (t) {
      if (t.type === TYPE.CREDIT && t.lot && t.lot.lotId && !byId[t.lot.lotId]) {
        byId[t.lot.lotId] = { lotId:t.lot.lotId, sourceType:t.lot.sourceType, sourceId:t.lot.sourceId,
          issuedAt:t.lot.issuedAt, expiresAt:t.lot.expiresAt, originalMinor:t.amountMinor, consumedMinor:0,
          expiredMinor:0, reversedMinor:0, creditTransactionId:t.transactionId, orderId:t.orderId || null,
          expiryTransactionId:null, reversalTransactionId:null, addedAt:t.timestamp, seq:order.length };
        order.push(t.lot.lotId);
      }
    });
    list.forEach(function (t) {
      if (t.type !== TYPE.DEBIT) return;
      (t.consumes || []).forEach(function (c) { if (byId[c.lotId]) byId[c.lotId].consumedMinor += c.amountMinor; });
      if (t.lotEvent && byId[t.lotEvent.lotId]) {
        var L = byId[t.lotEvent.lotId];
        if (t.lotEvent.kind === 'expiry') { L.expiredMinor += t.amountMinor; L.expiryTransactionId = t.transactionId; }
        if (t.lotEvent.kind === 'reversal') { L.reversedMinor += t.amountMinor; L.reversalTransactionId = t.transactionId; }
      }
    });
    return order.map(function (id) {
      var L = byId[id];
      L.remainingMinor = L.originalMinor - L.consumedMinor - L.expiredMinor - L.reversedMinor;
      /* past expiresAt with no expiry entry yet: the remainder is already expired */
      L.pendingExpiryMinor = (!L.expiryTransactionId && now >= L.expiresAt && L.remainingMinor > 0) ? L.remainingMinor : 0;
      L.availableMinor = L.remainingMinor - L.pendingExpiryMinor;
      L.status = L.reversedMinor > 0 ? 'reversed'
        : (L.expiredMinor > 0 || L.pendingExpiryMinor > 0) ? 'expired'
        : L.remainingMinor === 0 ? 'consumed'
        : L.consumedMinor > 0 ? 'partially_consumed' : 'active';
      return L;
    });
  }
  /* THE balance: derived every time, never cached into a mutable field. A lot
     already past its expiry is excluded even before its expiry entry exists. */
  function balanceMinorOf(walletId){
    var pending = lotsOf(walletId).reduce(function (s, L) { return s + L.pendingExpiryMinor; }, 0);
    return ledgerSumMinorOf(walletId) - pending;
  }
  function breakdownOf(walletId){
    var lots = lotsOf(walletId), lotMinor = lots.reduce(function (s, L) { return s + L.availableMinor; }, 0);
    var total = balanceMinorOf(walletId);
    return { totalMinor:total, compensationMinor:lotMinor, ordinaryMinor:total - lotMinor };
  }
  function findByKey(idempotencyKey){
    var l = ledger();
    for (var i = 0; i < l.length; i++) if (l[i].idempotencyKey === idempotencyKey) return l[i];
    return null;
  }

  /* ---------- ownership ----------
     A caller may only ever act on their own wallet. There is no "act on
     behalf of" path, and the merchant has none at all. */
  function ownershipOk(customerId, actor){
    if (!actor || !actor.id) return false;
    if (actor.type === ACTOR.SYSTEM) return true;      /* system-initiated refunds */
    if (actor.id !== customerId) return false;
    /* a caller claiming to BE the customer must actually be signed in as them:
       the actor object alone never proves identity (final hardening) */
    var sid = sessionUserId();
    return sid === null ? false : sid === customerId;
  }

  function audit(action, opts){
    if (!global.RAFAudit) return null;
    try { var o = opts || {}; o.action = action; return RAFAudit.record(o); }
    catch (e) { return null; }
  }

  /* ---------- the one write path ----------
     Every credit and every debit lands here. Validation happens before a
     single byte is written, and the entry is appended — never edited.
     `internal` carries lot data and may only come from this module. */
  function post(type, params, internal){
    var p = params || {};
    var customerId = p.customerId;
    var currency   = p.currency || CURRENCY;
    var actor      = p.actor || null;

    if (!customerId) return fail('WALLET_FORBIDDEN');
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    if (currency !== CURRENCY) return fail('INVALID_CURRENCY', { currency:currency });
    if (!p.reason || !REASON[p.reason]) return fail('INVALID_REASON', { reason:p.reason });
    if (LOT_REASONS[p.reason] && !internal) return fail('REASON_RESERVED', { reason:p.reason });
    if (PATH_REASONS[p.reason] && !(internal && internal.via === PATH_REASONS[p.reason])) return fail('REASON_RESERVED', { reason:p.reason });
    if (!p.idempotencyKey) return fail('IDEMPOTENCY_KEY_REQUIRED');

    var minor = toMinor(p.amount);
    if (minor === null || minor <= 0) return fail('INVALID_AMOUNT', { amount:p.amount });

    /* ---- idempotency: the same key is the same transaction ---- */
    var existing = findByKey(p.idempotencyKey);
    if (existing) {
      /* the same key must never mean two different things */
      if (existing.type !== type || existing.amountMinor !== minor ||
          existing.customerId !== customerId || existing.currency !== currency) {
        return fail('IDEMPOTENCY_CONFLICT', { transactionId:existing.transactionId });
      }
      return { ok:true, duplicate:true, transaction:publicTx(existing),
               balance:fmt(balanceMinorOf(existing.walletId)),
               balanceMinor:balanceMinorOf(existing.walletId) };
    }

    var w = ensureWallet(customerId, currency);
    if (!w) return fail('WALLET_NOT_FOUND', { customerId:customerId });
    if (w.status !== STATUS.ACTIVE) return fail('WALLET_NOT_ACTIVE', { status:w.status });

    /* a debit first settles any lot that is already due, so expired value can
       never be spent */
    if (type === TYPE.DEBIT && !(internal && internal.lotEvent)) expireDueOf(w, customerId);

    var consumes = null, before, after;
    if (internal && internal.lotEvent) {
      /* a lot's own expiry/reversal: exactly its remainder, never other funds */
      var target = lotsOf(w.walletId).filter(function (L) { return L.lotId === internal.lotEvent.lotId; })[0];
      if (!target) return fail('LOT_NOT_FOUND');
      var allowed = internal.lotEvent.kind === 'expiry' ? target.pendingExpiryMinor : target.availableMinor;
      if (minor !== allowed) return fail('LOT_INVALID', { detail:'amount_is_not_the_remainder' });
      before = ledgerSumMinorOf(w.walletId) - lotsOf(w.walletId).reduce(function (s, L) { return s + (L.lotId === target.lotId ? 0 : L.pendingExpiryMinor); }, 0);
      after = before - minor;
    } else {
      before = balanceMinorOf(w.walletId);
      /* a debit may never take a wallet below zero, and is never partial */
      if (type === TYPE.DEBIT && before - minor < 0) {
        return fail('INSUFFICIENT_WALLET_BALANCE',
                    { balance:fmt(before), requested:fmt(minor), shortfall:fmt(minor - before) });
      }
      after = type === TYPE.CREDIT ? before + minor : before - minor;
      /* approved spending order: unexpired lots first, soonest expiry first */
      if (type === TYPE.DEBIT) {
        var need = minor; consumes = [];
        lotsOf(w.walletId).filter(function (L) { return L.availableMinor > 0; })
          .sort(function (a, b) { return (a.expiresAt - b.expiresAt) || (a.seq - b.seq); })
          .forEach(function (L) { if (need <= 0) return; var take = Math.min(need, L.availableMinor); consumes.push({ lotId:L.lotId, amountMinor:take }); need -= take; });
        if (!consumes.length) consumes = null;
      }
    }

    var tx = {
      transactionId: 'WTX-' + Date.now() + '-' + (ledger().length + 1),
      walletId: w.walletId,
      customerId: customerId,
      type: type,
      amountMinor: minor,
      amount: fmt(minor),
      currency: currency,
      reason: p.reason,
      source: p.source || SOURCE.SYSTEM,
      orderId: p.orderId || null,
      relatedChangeId: p.relatedChangeId || null,
      idempotencyKey: p.idempotencyKey,
      actorType: (actor && actor.type) || ACTOR.CUSTOMER,
      actorId: (actor && actor.id) || null,
      timestamp: Date.now(),
      balanceAfterMinor: after,
      balanceAfter: fmt(after)
    };
    if (internal && internal.lot) tx.lot = internal.lot;
    if (internal && internal.meta) tx.meta = internal.meta;
    if (internal && internal.lotEvent) tx.lotEvent = internal.lotEvent;
    if (consumes) tx.consumes = consumes;

    /* append-only; a failed write reports failure rather than pretending.
       The key is re-checked in the list actually being written, so a second
       tab that wrote the same key meanwhile is not duplicated. */
    /* a lot credit is refused if its expiry passed while this write was being prepared */
    if (internal && internal.lot && Date.now() >= internal.lot.expiresAt) return fail('LOT_EXPIRED');
    var l = ledger();
    for (var i = l.length - 1; i >= 0; i--) {
      if (l[i].idempotencyKey === p.idempotencyKey)
        return { ok:true, duplicate:true, transaction:publicTx(l[i]), balance:fmt(balanceMinorOf(l[i].walletId)), balanceMinor:balanceMinorOf(l[i].walletId) };
    }
    l.push(tx);
    try { writeJSON(LS_LEDGER, l); }
    catch (e) { return fail('LEDGER_WRITE_FAILED', { detail:String(e && e.message || e) }); }

    /* prove the entry is actually readable back before reporting success */
    if (!findByKey(p.idempotencyKey)) return fail('LEDGER_WRITE_FAILED', { detail:'not_readable_after_write' });

    touch(w.walletId);
    audit(type === TYPE.CREDIT ? 'wallet.credited' : 'wallet.debited', {
      orderId: tx.orderId,
      actor: actor && actor.type === ACTOR.SYSTEM ? null : { id:tx.actorId, name:(actor && actor.name) || null },
      systemGenerated: !!(actor && actor.type === ACTOR.SYSTEM),
      automatic: !!(actor && actor.type === ACTOR.SYSTEM),
      source: 'customer',
      key: tx.transactionId,
      reason: tx.reason,
      metadata: { walletId:tx.walletId, transactionId:tx.transactionId, amount:tx.amount,
                  currency:tx.currency, reason:tx.reason, orderId:tx.orderId,
                  relatedChangeId:tx.relatedChangeId, idempotencyKey:tx.idempotencyKey,
                  lotId:(tx.lot && tx.lot.lotId) || (tx.lotEvent && tx.lotEvent.lotId) || null,
                  consumes:tx.consumes || null } }
    );

    return { ok:true, duplicate:false, transaction:publicTx(tx),
             balance:fmt(after), balanceMinor:after };
  }

  function credit(params){ return post(TYPE.CREDIT, params); }
  function debit(params){  return post(TYPE.DEBIT,  params); }

  /* ---------- lot operations ---------- */
  var SYSTEM_ACTOR = { id:'RAFWallet', type:ACTOR.SYSTEM };
  function lotIdFor(sourceType, sourceId){ return 'LOT-' + sourceType + '-' + sourceId; }
  /* append the one expiry entry of every lot that is due — deterministic key
     per lot, exactly the remainder at expiresAt; safe to call any number of times */
  function expireDueOf(w, customerId){
    var done = 0;
    lotsOf(w.walletId).forEach(function (L) {
      if (L.pendingExpiryMinor <= 0) return;
      var r = post(TYPE.DEBIT, { customerId:customerId, amount:toMajor(L.pendingExpiryMinor), reason:REASON.COMPENSATION_EXPIRY,
        source:SOURCE.SYSTEM, orderId:L.orderId, idempotencyKey:'wallet-lot-expiry|' + L.lotId, actor:SYSTEM_ACTOR },
        { lotEvent:{ lotId:L.lotId, kind:'expiry', effectiveAt:L.expiresAt } });
      if (r.ok && !r.duplicate) done++;
    });
    return done;
  }
  function expireDue(customerId, currency){
    var w = walletOf(customerId, currency); if (!w) return { ok:true, expired:0 };
    return { ok:true, expired:expireDueOf(w, customerId) };
  }
  /* the source's existing management permission for a reversal (no new key) */
  var LOT_POLICY = { compensation:{ reversePermission:'drivers.suspend' } };
  function sessionUserId(){
    try { var u = global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; return u && u.status === 'active' ? u.id : null; } catch (e) { return null; }
  }
  /* reads (never writes) the issuing authority's immutable record through
     RAFRecordStore; RAFWallet owns no compensation logic */
  function verifySource(src, p){
    var RS = global.RAFRecordStore;
    if (src.type !== LOT_SOURCE.COMPENSATION || !RS) return fail('LOT_INVALID', { detail:'source_unverifiable' });
    var rec = null, decision = null;
    try {
      rec = RS.collection('compensations').byId('compensationId', src.id);
      /* the source's single lifecycle decision (lowest seq wins) — see RAFCompensation */
      decision = RS.collection('compensation_events').filter(function (e) { return e.eventId === 'cme|' + src.id + '|decision'; })
                   .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); })[0] || null;
    } catch (e) { return fail('LOT_INVALID', { detail:'source_unverifiable' }); }
    if (!rec) return fail('LOT_INVALID', { detail:'source_not_found' });
    if (decision && decision.type === 'voided') return fail('LOT_INVALID', { detail:'source_voided' });
    /* value is created only for a coupon whose owner durably won "Add to RAF Wallet" */
    if (!decision || decision.type !== 'added_to_wallet' || !decision.actor || decision.actor.id !== p.customerId)
      return fail('LOT_INVALID', { detail:'source_not_claimed' });
    if (rec.customerId !== p.customerId || rec.amountFils !== toMinor(p.amount) || rec.issuedAt !== p.issuedAt || rec.expiresAt !== p.expiresAt ||
        (p.orderId && rec.orderId !== p.orderId))
      return fail('LOT_INVALID', { detail:'source_mismatch' });
    return { ok:true };
  }
  /* p: { customerId, amount, idempotencyKey, source:{ type, id }, issuedAt, expiresAt, orderId?, actor } */
  function creditLot(p){
    p = p || {};
    var src = p.source || {};
    if (src.type !== LOT_SOURCE.COMPENSATION || typeof src.id !== 'string' || !src.id) return fail('LOT_INVALID', { detail:'source' });
    if (typeof p.issuedAt !== 'number' || typeof p.expiresAt !== 'number' || !(p.expiresAt > p.issuedAt)) return fail('LOT_INVALID', { detail:'dates' });
    if (Date.now() >= p.expiresAt) return fail('LOT_EXPIRED');
    /* a lot is only ever the value of a real issued source: the immutable
       source record must exist and match exactly (customer, amount, dates),
       and must not be voided — the caller cannot mint value by passing numbers */
    /* only the customer themself adds a coupon (approved: "Customer adds it") */
    if (!p.actor || p.actor.type !== ACTOR.CUSTOMER || p.actor.id !== p.customerId || sessionUserId() !== p.customerId) return fail('WALLET_FORBIDDEN');
    var v = verifySource(src, p);
    if (!v.ok) return v;
    var lotId = lotIdFor(src.type, src.id);
    /* re-verified immediately before the ledger write path below (post re-reads
       the ledger and the key right before pushing) */
    var w0 = walletOf(p.customerId);
    if (w0) {
      var have = lotsOf(w0.walletId).filter(function (L) { return L.lotId === lotId; })[0];
      if (have) {
        var tx0 = ledger().filter(function (t) { return t.transactionId === have.creditTransactionId; })[0];
        return { ok:true, duplicate:true, transaction:publicTx(tx0), balance:fmt(balanceMinorOf(w0.walletId)), balanceMinor:balanceMinorOf(w0.walletId) };
      }
    }
    return post(TYPE.CREDIT, { customerId:p.customerId, amount:p.amount, reason:REASON.COMPENSATION_CREDIT, source:SOURCE.SYSTEM,
      orderId:p.orderId || null, idempotencyKey:p.idempotencyKey, actor:p.actor },
      { lot:{ lotId:lotId, sourceType:src.type, sourceId:src.id, issuedAt:p.issuedAt, expiresAt:p.expiresAt } });
  }
  /* p: { customerId, lotId, idempotencyKey, actor } — takes the unused remainder only */
  function reverseLot(p){
    p = p || {};
    if (!p.idempotencyKey) return fail('IDEMPOTENCY_KEY_REQUIRED');
    if (!ownershipOk(p.customerId, p.actor)) return fail('WALLET_FORBIDDEN');
    /* a reversal is a management act (approved: Admin/Management only) — the
       signed-in session must hold the source's existing management permission;
       a customer passing a "system" actor cannot take value back on their own */
    var sid = sessionUserId(), pol = LOT_POLICY[String(p.lotId || '').split('-')[1]];
    var can = false; try { can = !!(pol && sid && global.RAFPerm && RAFPerm.can(sid, pol.reversePermission)); } catch (e) { can = false; }
    if (!can) return fail('WALLET_FORBIDDEN');
    var done = findByKey(p.idempotencyKey);
    if (done) return { ok:true, duplicate:true, transaction:publicTx(done), balance:fmt(balanceMinorOf(done.walletId)), balanceMinor:balanceMinorOf(done.walletId) };
    var w = walletOf(p.customerId); if (!w) return fail('WALLET_NOT_FOUND');
    expireDueOf(w, p.customerId);
    var L = lotsOf(w.walletId).filter(function (x) { return x.lotId === p.lotId; })[0];
    if (!L) return fail('LOT_NOT_FOUND');
    if (L.status === 'expired') return fail('LOT_EXPIRED');
    if (L.availableMinor <= 0) return fail('LOT_NOTHING_REMAINING');
    return post(TYPE.DEBIT, { customerId:p.customerId, amount:toMajor(L.availableMinor), reason:REASON.COMPENSATION_REVERSAL,
      source:SOURCE.SYSTEM, orderId:L.orderId, idempotencyKey:p.idempotencyKey, actor:p.actor },
      { lotEvent:{ lotId:L.lotId, kind:'reversal' } });
  }
  function publicLot(L){
    return { lotId:L.lotId, sourceType:L.sourceType, sourceId:L.sourceId, orderId:L.orderId, issuedAt:L.issuedAt, expiresAt:L.expiresAt,
             addedAt:L.addedAt, status:L.status, original:fmt(L.originalMinor), originalMinor:L.originalMinor,
             consumed:fmt(L.consumedMinor), consumedMinor:L.consumedMinor, expired:fmt(L.expiredMinor + L.pendingExpiryMinor),
             expiredMinor:L.expiredMinor + L.pendingExpiryMinor, reversed:fmt(L.reversedMinor), reversedMinor:L.reversedMinor,
             remaining:fmt(L.availableMinor), remainingMinor:L.availableMinor,
             creditTransactionId:L.creditTransactionId, expiryTransactionId:L.expiryTransactionId, reversalTransactionId:L.reversalTransactionId };
  }
  function lots(customerId, actor, currency){
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    var w = walletOf(customerId, currency);
    if (!w) return { ok:true, lots:[] };
    try { expireDueOf(w, customerId); } catch (e) {}
    return { ok:true, lots:lotsOf(w.walletId).map(publicLot) };
  }
  function lotBySource(customerId, actor, sourceType, sourceId){
    var r = lots(customerId, actor); if (!r.ok) return r;
    var id = lotIdFor(sourceType, sourceId);
    return { ok:true, lot:r.lots.filter(function (L) { return L.lotId === id; })[0] || null };
  }

  /* what a customer surface may see — no keys, no actor ids, no wallet id */
  /* ---------- customer-initiated credits (reserved reasons) ----------
     TOP-UP (confirmed: K-Net → wallet; Dr 1200 / Cr 2200). A top-up is first
     a PENDING customer payment in RAFMoney (purpose wallet_topup). No wallet
     value exists until Accounting records the gateway's evidence (provider +
     reference) through RAFMoney.recordOnlineReceipt; RAFMoney then calls
     settleTopUp, which credits exactly once (key TOPUP-<paymentId>) with the
     payment reference on the entry. A failed payment never becomes value.
     (Ledger entries written before this rule carry prototypePayment:true and
     stay as history; they have no evidence and cannot be posted.)
     GIFT: a gift code from RAFGift — purchased (value paid by the purchaser,
     available only once that payment is received) or issued by management
     (the earlier path, kept). The wallet reads the record, credits its exact
     value once (key per code) and RAFGift records the redemption. */
  function topUp(p){
    p = p || {};
    var sid = sessionUserId();
    if (!sid) return fail('WALLET_FORBIDDEN');
    var PM = global.RAFPaymentMethods;
    var m = PM && PM.get(p.methodId);
    if (!m || !m.online) return fail('PAYMENT_METHOD_INVALID', { methodId:p.methodId });
    var minor = toMinor(p.amount);
    if (minor === null || minor <= 0) return fail('INVALID_AMOUNT', { amount:p.amount });
    if (!p.paymentRef) return fail('IDEMPOTENCY_KEY_REQUIRED');
    var M = global.RAFMoney; if (!M || !M.recordExternalPayment) return fail('PAYMENT_UNAVAILABLE');
    var r = M.recordExternalPayment({ purpose:'wallet_topup', purposeRef:'TOPUP-' + String(p.paymentRef), amountFils:minor, methodId:m.id });
    if (!r || !r.ok) return Object.assign(fail('PAYMENT_UNAVAILABLE'), { paymentCode:r && r.code });
    var w = walletOf(sid), bal = w ? balanceMinorOf(w.walletId) : 0;
    return { ok:true, pending:r.payment.status !== 'received', paymentId:r.payment.paymentId, paymentStatus:r.payment.status,
             amount:fmt(minor), amountMinor:minor, balance:fmt(bal), balanceMinor:bal, duplicate:!!r.duplicate };
  }
  /* the received top-up payment becomes wallet value — once. Any signed-in
     session may ask (RAFMoney calls it right after the evidence); the value,
     the customer and the evidence come only from the payment record. */
  function settleTopUp(paymentId){
    if (!sessionUserId()) return fail('WALLET_FORBIDDEN');
    var M = global.RAFMoney; if (!M || !M.getPayment) return fail('PAYMENT_UNAVAILABLE');
    var g = M.getPayment(paymentId); if (!g || !g.ok) return fail('PAYMENT_UNAVAILABLE', { paymentCode:g && g.code });
    var pay = g.payment;
    if (pay.purpose !== 'wallet_topup') return fail('PAYMENT_NOT_TOPUP');
    var c = pay.components[0] || {};
    if (pay.status !== 'received' || !c.evidence || c.evidence.type !== 'external') return fail('PAYMENT_NOT_RECEIVED', { paymentStatus:pay.status });
    return post(TYPE.CREDIT, { customerId:pay.customerId, actor:SYSTEM_ACTOR, amount:fmt(pay.totalAmountFils), reason:REASON.WALLET_TOPUP,
      source:SOURCE.CUSTOMER_PAYMENT, idempotencyKey:'TOPUP-' + paymentId },
      { via:'topup', meta:{ paymentId:paymentId, method:'online', provider:c.evidence.provider, paymentReference:c.evidence.reference, purposeRef:pay.purposeRef } });
  }
  /* DRIVER TIP REVERSAL (confirmed): a tip paid from the wallet, on an order
     cancelled before delivery, goes back by REVERSING the original wallet
     movement — exactly the wallet-funded tip, linked to the original wallet
     debit and to the cancellation refund, once (key TIPREV-<tipId>). Not new
     value, not revenue, not compensation. Everything is read from the
     records: the order must be cancelled, its payment's tip funding must be
     the wallet component, and that component's debit must exist. */
  function reverseTipFunding(orderId){
    if (!sessionUserId()) return fail('WALLET_FORBIDDEN');
    var o = null; try { o = global.RAFShop ? RAFShop.Orders.get(orderId) : null; } catch (e) { o = null; }
    if (!o || o.status !== 'cancelled') return fail('SOURCE_NOT_VERIFIED', { detail:'order_not_cancelled' });
    /* the ORIGINAL recorded allocation (RAFDriverTips 'funded' record, written
       when the payment was received) — never recalculated from balances */
    var tipId = 'TIP-' + orderId, fe = null;
    try { fe = RAFRecordStore.collection('driver_tip_events').all().filter(function (e) { return e.tipId === tipId && e.kind === 'funded'; })[0] || null; } catch (e0) { fe = null; }
    var wTip = fe ? (fe.walletTipFils != null ? fe.walletTipFils : (fe.allocation || []).filter(function (x) { return x.method === 'wallet'; }).reduce(function (s0, x) { return s0 + x.tipFils; }, 0)) : 0;
    if (!fe || !(wTip > 0) || !fe.walletTransactionId) return fail('SOURCE_NOT_VERIFIED', { detail:'no_wallet_funded_tip' });
    var orig = txById(fe.walletTransactionId);
    if (!orig || orig.type !== TYPE.DEBIT || orig.orderId !== orderId || orig.amountMinor < wTip) return fail('SOURCE_NOT_VERIFIED', { detail:'original_debit' });
    return post(TYPE.CREDIT, { customerId:orig.customerId, actor:SYSTEM_ACTOR, amount:fmt(wTip), reason:REASON.DRIVER_TIP_REVERSAL,
      source:SOURCE.REFUND, orderId:orderId, idempotencyKey:'TIPREV-' + tipId },
      { via:'tipreversal', meta:{ tipId:tipId, reversalOf:orig.transactionId, paymentId:fe.paymentId, fundedEventId:fe.eventId,
                                  cancellationReference:'order-cancel-refund:' + orderId } });
  }
  function redeemGift(code){
    var sid = sessionUserId();
    if (!sid) return fail('WALLET_FORBIDDEN');
    var G = global.RAFGift;
    if (!G || !G._record) return fail('GIFT_NOT_FOUND');
    var norm = String(code || '').trim().toUpperCase();
    var rec = G._record(norm);
    if (!rec) return fail('GIFT_NOT_FOUND');
    var key = 'GIFT-' + rec.code;
    var prior = findByKey(key);
    /* a code is used once, by one customer; the same customer asking again gets the same answer */
    if (prior) {
      if (prior.customerId !== sid) return fail('GIFT_USED');
      return { ok:true, duplicate:true, transaction:publicTx(prior), balance:fmt(balanceMinorOf(prior.walletId)), balanceMinor:balanceMinorOf(prior.walletId) };
    }
    if (rec.kind === 'purchased') {
      if (rec.status === 'expired') return fail('GIFT_EXPIRED');
      if (rec.status === 'redeemed') return fail('GIFT_USED');
      if (rec.status !== 'available') return fail('GIFT_NOT_AVAILABLE', { giftStatus:rec.status });
    } else if (rec.status !== 'active') return fail('GIFT_USED');
    if (rec.expiresAt && Date.now() >= rec.expiresAt) return fail('GIFT_EXPIRED');
    var r = post(TYPE.CREDIT, { customerId:sid, actor:{ id:sid, type:ACTOR.CUSTOMER }, amount:fmt(rec.amountMinor), reason:REASON.GIFT_REDEMPTION,
      source:SOURCE.GIFT, idempotencyKey:key }, { via:'gift', meta:{ giftCode:rec.code, giftId:rec.giftId || null, giftKind:rec.kind || 'issued',
        purchaserId:rec.purchaserId || null, paymentId:rec.paymentId || null } });
    if (r.ok && G._markUsed) G._markUsed(rec.code, sid, r.transaction.id);
    return r;
  }

  /* ══════════ ACCOUNTING VIEW of the wallet (customer funds — 2200) ══════════
     Every credit is classified by its confirmed SOURCE; each source has one
     recognition in the General Ledger, or is reported UNRESOLVED (never a
     guessed account):
       TOPUP         Dr 1200 Payment Gateway Receivable / Cr 2200   (postFunding)
       REFUND        Dr 2300 Customer Refund Payable / Cr 2200      (RAFRefunds.postRefund)
       COMPENSATION  Dr 5300 Customer Compensation / Cr 2200        (postFunding)
       GIFT          purchased: Dr 2700 Gift Code Liability / Cr 2200 (RAFGift.postRedemption);
                     management-issued: funding not defined (unresolved)
       TIP_REVERSAL  a wallet-funded tip given back (cancelled before delivery):
                     the order was cancelled before delivery, so neither its wallet
                     debit (Dr 2200) nor its clearing credit (Cr 2800) was ever
                     posted — the reversal restores the wallet; nothing to undo in GL
       TIP_RETURN    (earlier tip returns, history) unresolved
     Debits:
       ORDER_PAYMENT recognised by the order's settlement (Dr 2200); the slice
                     that funded a driver tip goes Cr 2800 Pass-through Clearing
                     (Customer Wallet → Clearing → Driver) — never RAF P&L
       COMPENSATION_EXPIRY / _REVERSAL  Dr 2200 / Cr 5300 (reverses the credit)
     Nothing here keeps a balance: it is all read from the ledger. */
  var WALLET_ACC = 'acc-customer-wallet', ACC_OF = { TOPUP:'acc-gateway-receivable', COMPENSATION:'acc-customer-compensation' };
  var REFUND_REASONS = { PRODUCT_REMOVAL_REFUND:true, PRODUCT_REPLACEMENT_DIFFERENCE:true };
  function staffWith(keys){
    var sid = sessionUserId(); if (!sid || !global.RAFPerm) return null;
    try {
      var u = RAFPerm.getUser(sid);
      if (!u || u.accountType !== 'staff' || RAFPerm.isMerchant(sid)) return null;
      return keys.some(function (k) { return RAFPerm.can(sid, k); }) ? { id:u.id, name:u.name || null } : null;
    } catch (e) { return null; }
  }
  function sourceOf(t){
    var m = t.meta || {};
    if (t.type === TYPE.CREDIT) {
      if (t.reason === REASON.WALLET_TOPUP) return m.paymentId ? { type:'TOPUP', reference:m.paymentId, evidence:{ provider:m.provider || null, reference:m.paymentReference || null } }
                                                                 : { type:'TOPUP', reference:m.paymentRef || null, unresolved:'TOPUP_EVIDENCE_MISSING' };
      if (t.reason === REASON.COMPENSATION_CREDIT) return { type:'COMPENSATION', reference:(t.lot && t.lot.sourceId) || null };
      /* purchased code: recognised by RAFGift's redemption journal (Dr 2700 / Cr 2200); a management-issued code is not customer money and its funding is not defined */
      if (t.reason === REASON.GIFT_REDEMPTION) return m.giftKind === 'purchased' ? { type:'GIFT', reference:m.giftId, giftKind:'purchased' }
                                                                       : { type:'GIFT_ISSUED', reference:m.giftId || m.giftCode || null, giftKind:'issued', unresolved:'GIFT_ISSUED_FUNDING_UNDEFINED' };
      if (REFUND_REASONS[t.reason] && (t.relatedChangeId || m.refundId)) return { type:'REFUND', reference:m.refundId || ('RF-' + t.relatedChangeId), orderId:t.orderId || null };
      /* the reversal of a wallet-funded tip: it undoes its own debit's tip slice,
         which never reached the ledger (pass-through) — nothing to post */
      if (t.reason === REASON.DRIVER_TIP_REVERSAL) return { type:'TIP_REVERSAL', reference:m.reversalOf || null, tipId:m.tipId || null, orderId:t.orderId || null, passThrough:true };
      /* earlier tip returns (before the reversal rule) — kept as history */
      if (/^tip-return\|/.test(t.idempotencyKey || '')) return { type:'TIP_RETURN', reference:t.idempotencyKey.split('|')[1], orderId:t.orderId || null, unresolved:'TIP_RETURN_ACCOUNTING_UNRESOLVED' };
      return { type:'UNCLASSIFIED', reference:null, unresolved:'FUNDING_SOURCE_UNRESOLVED' };
    }
    /* unused compensation expired / reversed: reverses its credit (Dr 2200 / Cr 5300) */
    if (t.reason === REASON.COMPENSATION_EXPIRY || t.reason === REASON.COMPENSATION_REVERSAL)
      return { type:t.reason, reference:(t.lotEvent && t.lotEvent.lotId) || null };
    return { type:t.orderId ? 'ORDER_PAYMENT' : 'UNCLASSIFIED_DEBIT', reference:t.orderId || null };
  }
  function journalOf(system, ref){
    var A = global.RAFAccounting; if (!A || !A.journalBySource) return null;
    try { var j = A.journalBySource(system, ref); return j && j.ok ? j.journal.journalId : null; } catch (e) { return null; }
  }
  /* the GL journal that recognised this credit, if any */
  function recognitionOf(t, src){
    if (src.type === 'TOPUP' || src.type === 'COMPENSATION') return journalOf('wallet', 'wallet-credit:' + t.transactionId);
    if (src.type === 'REFUND') return journalOf('refunds', 'refund:' + src.reference);
    if (src.type === REASON.COMPENSATION_EXPIRY || src.type === REASON.COMPENSATION_REVERSAL) return journalOf('wallet', 'wallet-debit:' + t.transactionId);
    if (src.type === 'GIFT' && src.giftKind === 'purchased') return journalOf('gifts', 'gift-redemption:' + src.reference);
    if (src.type === 'TIP_REVERSAL') return 'PASS_THROUGH';
    if (t.type === TYPE.DEBIT && src.type === 'ORDER_PAYMENT') return settlementJournalFor(t.orderId);
    return null;
  }
  /* the posted settlement journal that debited 2200 for this order, if any */
  function settlementJournalFor(orderId){
    var S = global.RAFSettlement, A = global.RAFAccounting; if (!S || !A || !orderId) return null;
    try {
      var l = S.closedListForAccounting(); if (!l || !l.ok) return null;
      for (var i = 0; i < l.items.length; i++) {
        var st = S.closedForAccounting(l.items[i].settlementId); if (!st.ok || !(st.settlement.orders || {})[orderId]) continue;
        var j = A.journalBySource('settlement', st.settlement.id);
        if (j && j.ok && j.journal.lines.some(function (x) { return x.accountId === WALLET_ACC && x.debit > 0; })) return j.journal.journalId;
      }
    } catch (e) { return null; }
    return null;
  }
  function txById(id){ return ledger().filter(function (t) { return t.transactionId === id; })[0] || null; }
  function accountingTx(t){
    var s = sourceOf(t);
    return { transactionId:t.transactionId, customerId:t.customerId, type:t.type, amountMinor:t.amountMinor, currency:t.currency,
             reason:t.reason, sourceType:s.type, sourceReference:s.reference, orderId:t.orderId || null, at:t.timestamp,
             actorType:t.actorType, actorId:t.actorId || null, status:'posted', evidence:s.evidence || null,
             unresolved:s.unresolved || null, recognizedBy:t.type === TYPE.CREDIT ? recognitionOf(t, s) : null };
  }
  /* Accounting reads one wallet transaction (accounting.view) */
  function transactionForAccounting(transactionId){
    if (!staffWith(['accounting.view'])) return fail('FORBIDDEN');
    var t = txById(transactionId); if (!t) return fail('TRANSACTION_NOT_FOUND');
    return { ok:true, transaction:accountingTx(t) };
  }
  function transactionByKey(idempotencyKey){
    if (!staffWith(['accounting.view', 'accounting.post'])) return fail('FORBIDDEN');
    var t = findByKey(idempotencyKey); return t ? { ok:true, transaction:accountingTx(t) } : fail('TRANSACTION_NOT_FOUND');
  }
  /* post the GL recognition of ONE credit (accounting.post) — idempotent by
     source reference wallet:wallet-credit:<transactionId>; the date is the
     posting date (an open period — closed periods are refused by RAFAccounting) */
  function postFunding(transactionId){
    var a = staffWith(['accounting.post']); if (!a) return fail('FORBIDDEN');
    var t = txById(transactionId); if (!t) return fail('TRANSACTION_NOT_FOUND');
    if (t.type !== TYPE.CREDIT) return postLotReversal(t);
    var s = sourceOf(t);
    if (s.type === 'TIP_REVERSAL') return fail('ACCOUNTING_UNRESOLVED', { unresolved:null, sourceType:s.type, passThrough:true, detail:'pass_through_no_journal' });
    if (s.type === 'REFUND') return fail('RECOGNIZED_BY_REFUND', { refundId:s.reference });
    if (s.type === 'GIFT' && s.giftKind === 'purchased') return fail('RECOGNIZED_BY_GIFT', { giftId:s.reference });
    if (s.unresolved) return fail('ACCOUNTING_UNRESOLVED', { unresolved:s.unresolved, sourceType:s.type });
    if (s.type === 'TOPUP') {
      var g = global.RAFMoney && RAFMoney.getPayment ? RAFMoney.getPayment(s.reference) : null;
      if (!g || !g.ok || g.payment.status !== 'received' || g.payment.purpose !== 'wallet_topup' || g.payment.customerId !== t.customerId || g.payment.totalAmountFils !== t.amountMinor)
        return fail('SOURCE_NOT_VERIFIED', { sourceType:'TOPUP' });
    } else if (s.type === 'COMPENSATION') {
      var rec = null; try { rec = RAFRecordStore.collection('compensations').byId('compensationId', s.reference); } catch (e) { rec = null; }
      if (!rec || rec.customerId !== t.customerId || rec.amountFils !== t.amountMinor) return fail('SOURCE_NOT_VERIFIED', { sourceType:'COMPENSATION' });
    }
    var A = global.RAFAccounting; if (!A) return fail('ACCOUNTING_REFUSED');
    var ref = 'wallet-credit:' + transactionId;
    var memo = s.type === 'TOPUP' ? 'Wallet top-up ' + s.reference + ' (' + (s.evidence.provider || '') + ' ' + (s.evidence.reference || '') + ')'
                                  : 'Compensation ' + s.reference + ' credited to the wallet';
    var w = A.postFromSource('wallet', ref, { date:A.todayKuwait(),
      description:'Wallet ' + s.type.toLowerCase() + ' · ' + t.customerId + ' · ' + transactionId + ' | محفظة العميل',
      lines:[{ accountId:ACC_OF[s.type], debit:t.amountMinor, memo:memo, ref:s.reference },
             { accountId:WALLET_ACC, credit:t.amountMinor, memo:'Customer wallet funds (' + t.customerId + ')', ref:transactionId }] });
    if (!w.ok) return fail('ACCOUNTING_REFUSED', { accountingCode:w.code, accountingMessage:w.message, errors:w.errors || null });
    return { ok:true, duplicate:!!w.duplicate, journalId:w.journal.journalId, sourceType:s.type, sourceReference:s.reference };
  }
  /* COMPENSATION EXPIRED / REVERSED (confirmed): the unused remainder RAF no
     longer owes reverses the original recognition — Dr 2200 / Cr 5300. The
     amount is exactly the lot's expiry / reversal debit, which RAFWallet only
     ever takes from the UNUSED remainder (spent value is never reversed). The
     original credit must itself have been posted; the reversal names it.
     Posted in the current open period (closed periods are refused). */
  function postLotReversal(t){
    if (t.reason !== REASON.COMPENSATION_EXPIRY && t.reason !== REASON.COMPENSATION_REVERSAL) return fail('NOT_A_CREDIT');
    var lotId = t.lotEvent && t.lotEvent.lotId, L = lotsOf(t.walletId).filter(function (x) { return x.lotId === lotId; })[0];
    if (!L || !L.creditTransactionId) return fail('SOURCE_NOT_VERIFIED', { detail:'lot_not_found' });
    var origJ = journalOf('wallet', 'wallet-credit:' + L.creditTransactionId);
    if (!origJ) return fail('SOURCE_NOT_VERIFIED', { detail:'original_compensation_not_posted', originalTransactionId:L.creditTransactionId });
    if (t.amountMinor > L.originalMinor - L.consumedMinor) return fail('SOURCE_NOT_VERIFIED', { detail:'exceeds_unused_remainder' });
    var A = global.RAFAccounting; if (!A) return fail('ACCOUNTING_REFUSED');
    var kind = t.reason === REASON.COMPENSATION_EXPIRY ? 'expired' : 'reversed';
    var w = A.postFromSource('wallet', 'wallet-debit:' + t.transactionId, { date:A.todayKuwait(),
      description:'Unused compensation ' + kind + ' · ' + L.sourceId + ' · ' + t.customerId + ' · reverses ' + origJ + ' | تعويض غير مستخدم',
      lines:[{ accountId:WALLET_ACC, debit:t.amountMinor, memo:'Unused compensation ' + kind + ' (' + L.sourceId + ')', ref:t.transactionId },
             { accountId:ACC_OF.COMPENSATION, credit:t.amountMinor, memo:'Reverses ' + origJ + ' (credit ' + L.creditTransactionId + ')', ref:L.sourceId }] });
    if (!w.ok) return fail('ACCOUNTING_REFUSED', { accountingCode:w.code, accountingMessage:w.message, errors:w.errors || null });
    return { ok:true, duplicate:!!w.duplicate, journalId:w.journal.journalId, sourceType:t.reason, sourceReference:L.sourceId,
             reversesJournalId:origJ, originalTransactionId:L.creditTransactionId };
  }
  /* is this wallet SPEND backed by recognised value? Recognised credits up to
     the debit, minus every debit up to and including it, must not be negative
     (ledger order). Used by the settlement mapping before it debits 2200. */
  function spendCoverage(transactionId){
    if (!staffWith(['accounting.view'])) return fail('FORBIDDEN');
    var all = ledger(), t = null, i;
    for (i = 0; i < all.length; i++) if (all[i].transactionId === transactionId) { t = all[i]; break; }
    if (!t) return fail('TRANSACTION_NOT_FOUND');
    if (t.type !== TYPE.DEBIT) return fail('NOT_A_CREDIT');
    var rec = 0, deb = 0, unrec = [];
    for (var k = 0; k <= i; k++) {
      var x = all[k]; if (x.walletId !== t.walletId) continue;
      if (x.type === TYPE.DEBIT) { deb += x.amountMinor; continue; }
      var s = sourceOf(x);
      if (recognitionOf(x, s)) rec += x.amountMinor; else unrec.push({ transactionId:x.transactionId, sourceType:s.type, amountMinor:x.amountMinor, unresolved:s.unresolved || 'NOT_POSTED' });
    }
    return { ok:true, covered:rec - deb >= 0, recognizedCreditsMinor:rec, debitsMinor:deb, unrecognized:unrec };
  }
  /* customer funds overview for Accounting: every wallet, by source, against 2200 */
  function accountingSummary(){
    if (!staffWith(['accounting.view'])) return fail('FORBIDDEN');
    var bySource = {}, totalBalance = 0, wl = wallets();
    Object.keys(wl).forEach(function (k) { totalBalance += balanceMinorOf(wl[k].walletId); });
    ledger().forEach(function (t) {
      var s = sourceOf(t), b = bySource[s.type] || (bySource[s.type] = { type:t.type, totalMinor:0, recognizedMinor:0, count:0, unresolved:s.unresolved || null });
      b.totalMinor += t.amountMinor; b.count++;
      if (recognitionOf(t, s)) b.recognizedMinor += t.amountMinor;
    });
    var gl = null; try { var L = global.RAFAccounting && RAFAccounting.ledger(WALLET_ACC); gl = L && L.ok ? L.closingBalance : null; } catch (e) { gl = null; }
    /* wallet value that went to a driver tip (pass-through, RAFDriverTips
       'funded' records) — it leaves the customers' wallets but no RAF ledger
       account receives it; reversals of such tips bring it back */
    var tipOut = 0; try { RAFRecordStore.collection('driver_tip_events').all().forEach(function (e) { if (e.kind === 'funded') tipOut += e.walletTipFils != null ? e.walletTipFils : (e.method === 'wallet' ? e.amountFils : 0); }); } catch (e3) { tipOut = 0; }
    /* 2200 as it should stand: every journal-backed credit less every
       journal-backed debit (a tip reversal and its cancelled order's payment
       were never posted — both stay outside, together) */
    var expected = 0;
    ledger().forEach(function (t) { var s = sourceOf(t), r = recognitionOf(t, s); if (!r || r === 'PASS_THROUGH') return; expected += t.type === TYPE.CREDIT ? t.amountMinor : -t.amountMinor; });
    return { ok:true, currency:CURRENCY, walletBalancesMinor:totalBalance, ledger2200Minor:gl, expected2200Minor:expected, reconciles2200:gl === expected,
             notYetPostedMinor:totalBalance - expected, bySource:bySource,
             passThrough:{ walletFundedTipsMinor:tipOut, tipReversalsMinor:(bySource.TIP_REVERSAL || { totalMinor:0 }).totalMinor, clearingAccountId:'acc-passthrough-clearing' },
             unresolved:Object.keys(bySource).filter(function (k) { return bySource[k].unresolved; }).map(function (k) { return { sourceType:k, code:bySource[k].unresolved, totalMinor:bySource[k].totalMinor }; }) };
  }
  /* a customer's balance for Accounting (read-only, derived) */
  function balanceFor(customerId){
    if (!staffWith(['accounting.view'])) return fail('FORBIDDEN');
    var w = walletOf(customerId); if (!w) return { ok:true, customerId:customerId, balanceMinor:0, exists:false };
    var b = breakdownOf(w.walletId);
    return { ok:true, customerId:customerId, exists:true, balanceMinor:b.totalMinor, ordinaryMinor:b.ordinaryMinor, compensationMinor:b.compensationMinor,
             creditsMinor:entriesOf(w.walletId).filter(function (t) { return t.type === TYPE.CREDIT; }).reduce(function (s, t) { return s + t.amountMinor; }, 0),
             debitsMinor:entriesOf(w.walletId).filter(function (t) { return t.type === TYPE.DEBIT; }).reduce(function (s, t) { return s + t.amountMinor; }, 0) };
  }

  function publicTx(t){
    var txt = REASON_TEXT[t.reason] || { ar:t.reason, en:t.reason };
    return {
      id: t.transactionId,
      type: t.type,
      amount: t.amount,
      currency: t.currency,
      descriptionAr: txt.ar,
      descriptionEn: txt.en,
      orderId: t.orderId,
      timestamp: t.timestamp,
      balanceAfter: t.balanceAfter,
      expiresAt: t.lot ? t.lot.expiresAt : null,
      reason: t.reason,
      source: t.source,
      meta: t.meta || null
    };
  }

  /* ---------- customer reads (a due lot is settled first) ---------- */
  function balance(customerId, actor, currency){
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    var w = walletOf(customerId, currency);
    if (!w) return { ok:true, exists:false, balance:fmt(0), balanceMinor:0, ordinaryBalance:fmt(0), compensationCredit:fmt(0), currency:currency || CURRENCY };
    try { expireDueOf(w, customerId); } catch (e) {}
    var b = breakdownOf(w.walletId);
    return { ok:true, exists:true, walletId:w.walletId, status:w.status,
             balance:fmt(b.totalMinor), balanceMinor:b.totalMinor,
             ordinaryBalance:fmt(b.ordinaryMinor), ordinaryBalanceMinor:b.ordinaryMinor,
             compensationCredit:fmt(b.compensationMinor), compensationCreditMinor:b.compensationMinor, currency:w.currency };
  }
  function history(customerId, actor, currency){
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    var w = walletOf(customerId, currency);
    if (!w) return { ok:true, transactions:[] };
    try { expireDueOf(w, customerId); } catch (e) {}
    var list = entriesOf(w.walletId).slice().sort(function (a, b) { return b.timestamp - a.timestamp; });
    return { ok:true, transactions:list.map(publicTx) };
  }
  /* the ledger exactly as stored, for verification — not a customer surface */
  function rawLedger(customerId, actor, currency){
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    var w = walletOf(customerId, currency);
    return { ok:true, entries:w ? entriesOf(w.walletId) : [] };
  }

  /* ---------- honest limits ---------- */
  function storageLimits(){
    return {
      backend: 'localStorage',
      appendOnly: true,
      derivedBalance: true,
      idempotent: true,
      crossDeviceGuarantee: false,   /* per-browser storage; no sync */
      serverSideLocking: false,      /* no lock; concurrent tabs interleave */
      transactionalPersistence: false, /* no atomic multi-key write */
      serverSideExpiry: false,       /* lot expiry is applied when the wallet is read or debited */
      productionGrade: false
    };
  }

  global.RAFWallet = {
    CURRENCY: CURRENCY, DECIMALS: DECIMALS, MINOR: MINOR,
    STATUS: STATUS, TYPE: TYPE, REASON: REASON, REASON_TEXT: REASON_TEXT,
    SOURCE: SOURCE, ACTOR: ACTOR, ERRORS: ERRORS, LOT_SOURCE: LOT_SOURCE,
    /* authority */
    ensureWallet: ensureWallet, walletOf: walletOf,
    credit: credit, debit: debit,
    /* expiring credit lots (Phase I) */
    creditLot: creditLot, reverseLot: reverseLot, expireDue: expireDue,
    topUp: topUp, settleTopUp: settleTopUp, redeemGift: redeemGift, reverseTipFunding: reverseTipFunding,
    /* accounting (customer funds — 2200; reads derived, postings by source) */
    postFunding: postFunding, spendCoverage: spendCoverage, accountingSummary: accountingSummary,
    transactionForAccounting: transactionForAccounting, transactionByKey: transactionByKey, balanceFor: balanceFor,
    /* reads */
    balance: balance, history: history, rawLedger: rawLedger, lots: lots, lotBySource: lotBySource,
    /* helpers */
    format: fmt, toMinor: toMinor, toMajor: toMajor,
    storageLimits: storageLimits
  };
})(window);
