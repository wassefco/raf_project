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
    ORDER_ADJUSTMENT_REFUND:       'ORDER_ADJUSTMENT_REFUND'
  };
  /* customer-facing wording for each reason; the customer never sees the key */
  var REASON_TEXT = {
    PRODUCT_REMOVAL_REFUND:         { ar:'استرداد قيمة منتج غير متوفر',  en:'Refund for unavailable product' },
    PRODUCT_REPLACEMENT_DIFFERENCE: { ar:'فرق سعر بعد استبدال منتج',     en:'Price difference after a product replacement' },
    ORDER_ADJUSTMENT_REFUND:        { ar:'تعديل على الطلب',              en:'Order adjustment' }
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
  /* THE balance: derived every time, never cached into a mutable field */
  function balanceMinorOf(walletId){
    return entriesOf(walletId).reduce(function (sum, t) {
      return sum + (t.type === TYPE.CREDIT ? t.amountMinor : -t.amountMinor);
    }, 0);
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
     single byte is written, and the entry is appended — never edited. */
  function post(type, params){
    var p = params || {};
    var customerId = p.customerId;
    var currency   = p.currency || CURRENCY;
    var actor      = p.actor || null;

    if (!customerId) return fail('WALLET_FORBIDDEN');
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    if (currency !== CURRENCY) return fail('INVALID_CURRENCY', { currency:currency });
    if (!p.reason || !REASON[p.reason]) return fail('INVALID_REASON', { reason:p.reason });
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

    var before = balanceMinorOf(w.walletId);
    /* a debit may never take a wallet below zero, and is never partial */
    if (type === TYPE.DEBIT && before - minor < 0) {
      return fail('INSUFFICIENT_WALLET_BALANCE',
                  { balance:fmt(before), requested:fmt(minor), shortfall:fmt(minor - before) });
    }
    var after = type === TYPE.CREDIT ? before + minor : before - minor;

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

    /* append-only; a failed write reports failure rather than pretending */
    var l = ledger();
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
                  relatedChangeId:tx.relatedChangeId, idempotencyKey:tx.idempotencyKey }
    });

    return { ok:true, duplicate:false, transaction:publicTx(tx),
             balance:fmt(after), balanceMinor:after };
  }

  function credit(params){ return post(TYPE.CREDIT, params); }
  function debit(params){  return post(TYPE.DEBIT,  params); }

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
      balanceAfter: t.balanceAfter
    };
  }

  /* ---------- customer reads ---------- */
  function balance(customerId, actor, currency){
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    var w = walletOf(customerId, currency);
    if (!w) return { ok:true, exists:false, balance:fmt(0), balanceMinor:0, currency:currency || CURRENCY };
    var b = balanceMinorOf(w.walletId);
    return { ok:true, exists:true, walletId:w.walletId, status:w.status,
             balance:fmt(b), balanceMinor:b, currency:w.currency };
  }
  function history(customerId, actor, currency){
    if (!ownershipOk(customerId, actor)) return fail('WALLET_FORBIDDEN');
    var w = walletOf(customerId, currency);
    if (!w) return { ok:true, transactions:[] };
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
      productionGrade: false
    };
  }

  global.RAFWallet = {
    CURRENCY: CURRENCY, DECIMALS: DECIMALS, MINOR: MINOR,
    STATUS: STATUS, TYPE: TYPE, REASON: REASON, REASON_TEXT: REASON_TEXT,
    SOURCE: SOURCE, ACTOR: ACTOR, ERRORS: ERRORS,
    /* authority */
    ensureWallet: ensureWallet, walletOf: walletOf,
    credit: credit, debit: debit,
    /* reads */
    balance: balance, history: history, rawLedger: rawLedger,
    /* helpers */
    format: fmt, toMinor: toMinor, toMajor: toMajor,
    storageLimits: storageLimits
  };
})(window);
