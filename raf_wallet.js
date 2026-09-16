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
    COMPENSATION_REVERSAL:         'COMPENSATION_REVERSAL'
  };
  var LOT_REASONS = { COMPENSATION_CREDIT:true, COMPENSATION_EXPIRY:true, COMPENSATION_REVERSAL:true };
  var LOT_SOURCE = { COMPENSATION:'compensation' };
  /* customer-facing wording for each reason; the customer never sees the key */
  var REASON_TEXT = {
    PRODUCT_REMOVAL_REFUND:         { ar:'استرداد قيمة منتج غير متوفر',  en:'Refund for unavailable product' },
    PRODUCT_REPLACEMENT_DIFFERENCE: { ar:'فرق سعر بعد استبدال منتج',     en:'Price difference after a product replacement' },
    ORDER_ADJUSTMENT_REFUND:        { ar:'تعديل على الطلب',              en:'Order adjustment' },
    COMPENSATION_CREDIT:            { ar:'رصيد تعويض (ينتهي في موعد محدد)', en:'Compensation credit (expires on a set date)' },
    COMPENSATION_EXPIRY:            { ar:'انتهاء صلاحية رصيد تعويض غير مستخدم', en:'Unused compensation credit expired' },
    COMPENSATION_REVERSAL:          { ar:'إلغاء رصيد تعويض غير مستخدم',   en:'Unused compensation credit reversed' }
  };
  var SOURCE = { ORDER_CHANGE:'order_change', REFUND:'refund',
                 CUSTOMER_PAYMENT:'customer_payment', SYSTEM:'system', MANUAL:'manual' };

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
    LEDGER_WRITE_FAILED:          { ar:'تعذّر حفظ عملية المحفظة.',            en:'The wallet transaction could not be saved.' }
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
    return actor.id === customerId;
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
      expiresAt: t.lot ? t.lot.expiresAt : null
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
    /* reads */
    balance: balance, history: history, rawLedger: rawLedger, lots: lots, lotBySource: lotBySource,
    /* helpers */
    format: fmt, toMinor: toMinor, toMajor: toMajor,
    storageLimits: storageLimits
  };
})(window);
