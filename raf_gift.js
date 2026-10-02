/* ============================================================================
 * RAF Marketplace — Gift codes (authority)
 * ----------------------------------------------------------------------------
 * The one owner of RAF gift codes. A gift code carries a fixed KWD value that
 * a customer adds to their RAF Wallet once.
 *
 * TWO KINDS (both kept, never mixed):
 *   ISSUED     create({ code, amount, expiresAt? })  management — permission
 *              'orders.refund'. The earlier path, unchanged (localStorage
 *              raf_gift_codes).
 *   PURCHASED  purchase({ amount, methodId, reference })  a signed-in customer
 *              buys a code (confirmed rule: a person can buy a Gift Code and
 *              give it to another person; the recipient redeems it into their
 *              own RAF Wallet). Append-only records (RAFRecordStore gift_codes
 *              + gift_code_events); the purchase is a PENDING customer payment
 *              in RAFMoney (purpose gift_purchase) until Accounting records the
 *              gateway evidence. The status is DERIVED:
 *                purchased   payment pending — the code cannot be redeemed
 *                available   payment received — redeemable once
 *                assigned    reserved for the future gift flow (NOT built: how a
 *                            code reaches its recipient is not decided — no
 *                            email / SMS / WhatsApp / phone / auto-assignment)
 *                redeemed    the recipient's wallet was credited (the credit
 *                            references the code, its purchaser and payment)
 *                expired     not redeemed within 'gift.validityMonths' (RAFConfig,
 *                            default 6) of activation — never redeemable again;
 *                            the record is kept permanently
 *                payment_failed  the purchase payment failed — never redeemable
 *              There is NO cancellation (confirmed policy): no cancel API, no
 *              cancelled state, no refund-on-cancellation rule.
 *
 *   redeem(code)   the signed-in customer → RAFWallet.redeemGift
 *
 * ACCOUNTING (not RAF revenue): a purchased code is customer value held until
 * redemption — 2700 Gift Code Liability. Purchase paid: Dr 1200 / Cr 2700;
 * redeemed: Dr 2700 / Cr 2200 (postPurchase / postRedemption) — from then on
 * it is permanent wallet value, outside any gift expiry. Expired unredeemed:
 * Dr 2700 / Cr 4300 Gift Code Expiry (Breakage) — recordExpiry, explicit,
 * once. FREE (RAF-issued) codes are not customer money: no payment, no 2700,
 * nothing released at expiry; their funding is not defined (the wallet
 * reports GIFT_ISSUED_FUNDING_UNDEFINED) — never assumed to be compensation.
 *
 * RULES
 *   · a code is used ONCE, by one customer, for exactly its recorded value;
 *     the wallet credit is idempotent per code
 *   · a code may have an expiry (issued codes); after it, it cannot be redeemed
 *   · value is held in fils (integer); the wallet does the crediting
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFGift) return;

  var LS = 'raf_gift_codes';
  /* gift value is paid by RAF into a customer's wallet: the existing key for
     paying value out to customers (Finance / management), never a merchant's */
  var PERM_CREATE = 'orders.refund';
  var STATE = { PURCHASED:'purchased', AVAILABLE:'available', ASSIGNED:'assigned', REDEEMED:'redeemed', FAILED:'payment_failed', EXPIRED:'expired' };
  function T(ar, en){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en' ? en : ar; }
  var ERRORS = {
    FORBIDDEN:      { ar:'ليس لديك صلاحية لإنشاء رموز الهدايا.', en:'You are not allowed to create gift codes.' },
    INVALID_CODE:   { ar:'رمز الهدية غير صالح (4–24 حرفاً أو رقماً).', en:'The gift code is not valid (4–24 letters or digits).' },
    DUPLICATE_CODE: { ar:'هذا الرمز موجود مسبقاً.', en:'That code already exists.' },
    INVALID_AMOUNT: { ar:'قيمة الهدية غير صالحة.', en:'The gift value is not valid.' },
    INVALID_EXPIRY: { ar:'تاريخ الانتهاء غير صالح.', en:'The expiry is not valid.' },
    NOT_A_CUSTOMER: { ar:'شراء رمز الهدية متاح للعملاء فقط.', en:'Only customers can buy a gift code.' },
    REFERENCE_REQUIRED:{ ar:'مرجع الشراء مطلوب.', en:'A purchase reference is required.' },
    PAYMENT_FAILED: { ar:'تعذّر تسجيل الدفع.', en:'The payment could not be recorded.' },
    GIFT_NOT_FOUND: { ar:'رمز الهدية غير موجود.', en:'The gift code does not exist.' },
    PERSIST_FAILED: { ar:'تعذّر الحفظ.', en:'Could not save.' },
    UNAVAILABLE:    { ar:'سجل رموز الهدايا غير متاح.', en:'The gift code record is unavailable.' },
    NOT_REDEEMED:   { ar:'لم يُستخدم رمز الهدية بعد.', en:'The gift code has not been redeemed.' },
    NOT_EXPIRED:    { ar:'رمز الهدية لم تنتهِ صلاحيته.', en:'The gift code has not expired.' },
    PAYMENT_NOT_RECEIVED:{ ar:'لم يُستلم دفع رمز الهدية بعد.', en:'The gift code payment has not been received.' },
    VALIDITY_UNCONFIGURED:{ ar:'مدة صلاحية رموز الهدايا غير مضبوطة.', en:'The gift code validity period is not configured.' },
    PURCHASE_NOT_POSTED:{ ar:'لم يُسجَّل شراء رمز الهدية محاسبياً بعد.', en:'The gift code purchase has not been posted yet.' },
    ACCOUNTING_REFUSED:{ ar:'رفض السجل المحاسبي القيد.', en:'The accounting record refused the journal.' }
  };
  function fail(code, extra){ var e = ERRORS[code] || { ar:code, en:code }; var r = { ok:false, code:code, message:T(e.ar, e.en) };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) r[k] = extra[k]; return r; }
  function read(){ try { var a = JSON.parse(localStorage.getItem(LS) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function write(a){ localStorage.setItem(LS, JSON.stringify(a)); }
  function me(){ try { return global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; } catch (e) { return null; } }
  function canCreate(){ var u = me(); return !!(u && global.RAFPerm && RAFPerm.can && RAFPerm.can(u.id, PERM_CREATE)); }
  function norm(c){ return String(c || '').trim().toUpperCase(); }
  function audit(action, actorId, key, meta){ if (global.RAFAudit) try { RAFAudit.record({ action:action, actor:{ id:actorId }, key:key, metadata:meta }); } catch (e) {} }
  function pub(r){ return { code:r.code, amount:(r.amountMinor / 1000).toFixed(3), amountMinor:r.amountMinor, status:r.status,
    expiresAt:r.expiresAt || null, createdAt:r.createdAt, redeemedAt:r.redeemedAt || null }; }
  function coll(n){ try { return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; } catch (e) { return null; } }
  function rows(n){ var c = coll(n); return c ? c.all() : []; }
  function staffCan(keys){
    var u = me(); if (!u || u.status !== 'active' || u.accountType !== 'staff') return false;
    try { if (RAFPerm.isMerchant(u.id)) return false; return keys.some(function (k) { return RAFPerm.can(u.id, k); }); } catch (e) { return false; }
  }

  /* ══════════ ISSUED (management) — the earlier path, unchanged ══════════ */
  function create(p){
    p = p || {};
    if (!canCreate()) return fail('FORBIDDEN');
    var code = norm(p.code);
    if (!/^[A-Z0-9-]{4,24}$/.test(code)) return fail('INVALID_CODE');
    var all = read();
    if (all.some(function (r) { return r.code === code; }) || purchasedByCode(code)) return fail('DUPLICATE_CODE');
    var minor = global.RAFWallet ? RAFWallet.toMinor(p.amount) : null;
    if (minor === null || minor <= 0) return fail('INVALID_AMOUNT');
    var exp = p.expiresAt != null ? Number(p.expiresAt) : null;
    if (exp !== null && !(exp > Date.now())) return fail('INVALID_EXPIRY');
    var rec = { code:code, amountMinor:minor, status:'active', expiresAt:exp, createdAt:Date.now(), createdBy:me().id };
    all.push(rec); write(all);
    audit('gift.created', rec.createdBy, code, { code:code, amountMinor:minor, expiresAt:exp });
    return { ok:true, gift:pub(rec) };
  }
  function list(){ if (!canCreate()) return fail('FORBIDDEN'); return { ok:true, gifts:read().map(pub) }; }

  /* ══════════ PURCHASED (customer) — append-only ══════════ */
  function purchasedByCode(code){ return rows('gift_codes').filter(function (g) { return g.code === code; })[0] || null; }
  function purchasedById(id){ return rows('gift_codes').filter(function (g) { return g.giftId === id; })[0] || null; }
  function eventsOf(giftId){ return rows('gift_code_events').filter(function (e) { return e.giftId === giftId; }); }
  function paymentOf(g){
    /* status only — the recipient redeeming a code may not read the purchaser's payment */
    var M = global.RAFMoney; if (!M || !M.externalPaymentStatus) return null;
    try { return M.externalPaymentStatus(g.paymentId); } catch (e) { return null; }
  }
  /* VALIDITY (confirmed): a purchased code is valid RAFConfig 'gift.validityMonths'
     (default 6) calendar months from its ACTIVATION — the moment its purchase
     payment is received. The months in force at activation are recorded on an
     'activated' event, so a later configuration change never moves an existing
     code's expiry. */
  function validityMonths(){ try { var v = global.RAFConfig ? RAFConfig.value('gift.validityMonths') : null; return typeof v === 'number' && v > 0 ? v : null; } catch (e) { return null; } }
  function addMonths(ts, n){ var d = new Date(ts), day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
    var last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.getTime(); }
  function activationOf(g, pay){
    var a = eventsOf(g.giftId).filter(function (e) { return e.kind === 'activated'; })[0];
    if (a) return { at:a.at, months:a.validityMonths, expiresAt:a.expiresAt, recorded:true };
    if (pay && pay.status === 'received' && pay.receivedAt) { var m = g.validityMonths || validityMonths();   /* not yet recorded: derived the same way */
      return m ? { at:pay.receivedAt, months:m, expiresAt:addMonths(pay.receivedAt, m), recorded:false } : null; }
    return null;
  }
  /* the status, derived from the records + the payment's own evidence + the clock */
  function stateOf(g, pay){
    var ev = eventsOf(g.giftId), red = ev.filter(function (e) { return e.kind === 'redeemed'; })[0] || null;
    var asg = ev.filter(function (e) { return e.kind === 'assigned'; })[0] || null, act = activationOf(g, pay);
    var st;
    if (red) st = STATE.REDEEMED;
    else if (pay && pay.status === 'failed') st = STATE.FAILED;
    else if (pay && pay.status === 'received') st = act && Date.now() >= act.expiresAt ? STATE.EXPIRED : asg ? STATE.ASSIGNED : STATE.AVAILABLE;
    else st = STATE.PURCHASED;
    return { status:st, redeemed:red, activation:act };
  }
  function view(g, withCode){
    var pay = paymentOf(g), s = stateOf(g, pay);
    var v = { giftId:g.giftId, kind:'purchased', amountMinor:g.amountMinor, amount:(g.amountMinor / 1000).toFixed(3), currency:'KWD',
              status:s.status, purchaserId:g.purchaserId, paymentId:g.paymentId, paymentStatus:pay ? pay.status : null,
              purchasedAt:g.createdAt, sourceReference:g.sourceReference,
              activatedAt:s.activation ? s.activation.at : null, validityMonths:s.activation ? s.activation.months : null,
              expiresAt:s.activation ? s.activation.expiresAt : null,
              recipientId:s.redeemed ? s.redeemed.customerId : null, redeemedAt:s.redeemed ? s.redeemed.at : null,
              walletTransactionId:s.redeemed ? s.redeemed.walletTransactionId : null };
    if (withCode) v.code = g.code;
    return v;
  }
  /* a random code — never derived from the purchaser or the time */
  function newCode(){
    var A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', out = '', b = new Uint8Array(12);
    try { global.crypto.getRandomValues(b); } catch (e) { for (var i = 0; i < 12; i++) b[i] = Math.floor(Math.random() * 256); }
    for (var j = 0; j < 12; j++) { out += A[b[j] % A.length]; if (j === 3 || j === 7) out += '-'; }
    return 'G-' + out;
  }
  /* p: { amount (KWD), methodId (an online method), reference (the purchase's own idempotency reference) } */
  function purchase(p){
    p = p || {};
    var u = me(); if (!u || u.status !== 'active' || u.accountType !== 'customer') return fail('NOT_A_CUSTOMER');
    var minor = global.RAFWallet ? RAFWallet.toMinor(p.amount) : null;
    if (minor === null || minor <= 0) return fail('INVALID_AMOUNT');
    var ref = String(p.reference || '').trim();
    if (!/^[A-Za-z0-9_-]{3,60}$/.test(ref)) return fail('REFERENCE_REQUIRED');
    var giftId = 'GC-' + u.id + '-' + ref;
    var ex = purchasedById(giftId);
    if (ex) return ex.amountMinor === minor ? { ok:true, duplicate:true, gift:view(ex, true) } : fail('DUPLICATE_CODE');
    /* the validity in force AT PURCHASE is recorded with the code (a later setting change never moves it) */
    var months = validityMonths(); if (!months) return fail('VALIDITY_UNCONFIGURED');
    if (!global.RAFMoney || !RAFMoney.recordExternalPayment) return fail('PAYMENT_FAILED');
    var r = RAFMoney.recordExternalPayment({ purpose:'gift_purchase', purposeRef:giftId, amountFils:minor, methodId:p.methodId });
    if (!r || !r.ok) return fail('PAYMENT_FAILED', { paymentCode:r && r.code });
    var c = coll('gift_codes'); if (!c) return fail('UNAVAILABLE');
    var code; do { code = newCode(); } while (purchasedByCode(code) || read().some(function (x) { return x.code === code; }));
    var w = c.append('giftId', { giftId:giftId, code:code, kind:'purchased', amountMinor:minor, currency:'KWD', purchaserId:u.id,
      paymentId:r.payment.paymentId, sourceReference:'gift-purchase:' + giftId, validityMonths:months, createdAt:Date.now(), version:2 });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (w.duplicate) return { ok:true, duplicate:true, gift:view(w.record, true) };
    audit('gift.purchased', u.id, giftId, { giftId:giftId, amountMinor:minor, paymentId:r.payment.paymentId });
    return { ok:true, gift:view(w.record, true) };
  }
  /* the purchaser's own codes (with the code itself — the purchaser holds it) */
  function mine(){
    var u = me(); if (!u) return fail('FORBIDDEN');
    return { ok:true, gifts:rows('gift_codes').filter(function (g) { return g.purchaserId === u.id; }).map(function (g) { return view(g, true); }) };
  }
  /* Accounting / management read (never the code itself) */
  function purchasedList(){
    if (!staffCan(['accounting.view', PERM_CREATE])) return fail('FORBIDDEN');
    return { ok:true, gifts:rows('gift_codes').map(function (g) { return view(g, false); }) };
  }
  function getPurchased(giftId){
    var u = me(), g = purchasedById(giftId); if (!g) return fail('GIFT_NOT_FOUND');
    if (!(u && g.purchaserId === u.id) && !staffCan(['accounting.view', PERM_CREATE])) return fail('FORBIDDEN');
    return { ok:true, gift:view(g, !!(u && g.purchaserId === u.id)) };
  }
  /* CONFIRMED: there is no gift code cancellation — once purchased, a code is
     only ever pending payment, available, or redeemed (a failed payment keeps
     it from ever becoming available). */
  /* ══════════ ACCOUNTING (confirmed) ══════════
       purchase paid   Dr 1200 Payment Gateway Receivable / Cr 2700 Gift Code Liability
       redeemed        Dr 2700 Gift Code Liability / Cr 2200 Customer Wallet Liability
       expired         Dr 2700 Gift Code Liability / Cr 4300 Gift Code Expiry (Breakage)
                       (recordExpiry — explicit, once; the record is kept)
     Never revenue at purchase. Each posting is idempotent by its source
     reference (gifts:gift-purchase|redemption|expiry:<giftId>), dated in the current
     open period (a closed period is refused by RAFAccounting). Management-issued
     codes are NOT customer money: their funding is not defined (unresolved). */
  var LIAB = 'acc-gift-code-liability', GATEWAY = 'acc-gateway-receivable', WALLET = 'acc-customer-wallet';
  function journalOf(ref){
    var A = global.RAFAccounting; if (!A || !A.journalBySource) return null;
    try { var j = A.journalBySource('gifts', ref); return j && j.ok ? j.journal.journalId : null; } catch (e) { return null; }
  }
  function postJournal(ref, desc, lines){
    var A = global.RAFAccounting; if (!A) return fail('UNAVAILABLE');
    var w = A.postFromSource('gifts', ref, { date:A.todayKuwait(), description:desc, lines:lines });
    return w.ok ? { ok:true, duplicate:!!w.duplicate, journalId:w.journal.journalId } : fail('ACCOUNTING_REFUSED', { accountingCode:w.code, accountingMessage:w.message, errors:w.errors || null });
  }
  function postPurchase(giftId){
    if (!staffCan(['accounting.post'])) return fail('FORBIDDEN');
    var g = purchasedById(giftId); if (!g) return fail('GIFT_NOT_FOUND');
    var p = global.RAFMoney && RAFMoney.getPayment ? RAFMoney.getPayment(g.paymentId) : null;
    if (!p || !p.ok || p.payment.status !== 'received' || p.payment.purpose !== 'gift_purchase' || p.payment.totalAmountFils !== g.amountMinor) return fail('PAYMENT_NOT_RECEIVED');
    var ev = p.payment.components[0].evidence || {};
    return postJournal('gift-purchase:' + giftId, 'Gift code purchased · ' + giftId + ' · ' + g.purchaserId + ' | شراء رمز هدية',
      [{ accountId:GATEWAY, debit:g.amountMinor, memo:'Gift code payment ' + g.paymentId + ' (' + (ev.provider || '') + ' ' + (ev.reference || '') + ')', ref:g.paymentId },
       { accountId:LIAB, credit:g.amountMinor, memo:'Unredeemed gift code (purchaser ' + g.purchaserId + ') — not revenue', ref:giftId }]);
  }
  function postRedemption(giftId){
    if (!staffCan(['accounting.post'])) return fail('FORBIDDEN');
    var g = purchasedById(giftId); if (!g) return fail('GIFT_NOT_FOUND');
    var red = eventsOf(giftId).filter(function (e) { return e.kind === 'redeemed'; })[0];
    if (!red) return fail('NOT_REDEEMED');
    var pj = journalOf('gift-purchase:' + giftId); if (!pj) return fail('PURCHASE_NOT_POSTED');
    return postJournal('gift-redemption:' + giftId, 'Gift code redeemed · ' + giftId + ' · recipient ' + red.customerId + ' | استخدام رمز هدية',
      [{ accountId:LIAB, debit:g.amountMinor, memo:'Gift code ' + giftId + ' redeemed (purchase ' + pj + ', purchaser ' + g.purchaserId + ')', ref:giftId },
       { accountId:WALLET, credit:g.amountMinor, memo:'Recipient ' + red.customerId + ' wallet ' + red.walletTransactionId, ref:red.walletTransactionId }]);
  }
  /* an expired code: recorded (append-only, once, audited); its release from 2700
     cannot post — the destination account is not in the chart */
  /* EXPIRY (confirmed): a PAID code that reached its expiry unredeemed is no
     longer owed — its liability is released to RAF (not a refund, never the
     wallet):  Dr 2700 Gift Code Liability / Cr 4300 Gift Code Expiry (Breakage)
     Only this explicit Accounting action recognises it (a read never does);
     it names the original purchase journal, posts in the current open period
     (a closed period is refused — nothing is written) and can happen once
     (source gifts:gift-expiry:<giftId> + one 'expired' event). A FREE
     (RAF-issued) code has no purchased value: nothing to release. */
  var BREAKAGE = 'acc-gift-code-breakage';
  function recordExpiry(giftId){
    if (!staffCan(['accounting.post'])) return fail('FORBIDDEN');
    var g = purchasedById(giftId);
    if (!g) {
      var iss = read().filter(function (x) { return x.code === norm(giftId); })[0];
      if (iss) return { ok:true, kind:'issued', posted:false, reason:'FREE_CODE_NO_PURCHASED_VALUE', code:iss.code,
                        expired:!!(iss.expiresAt && Date.now() >= iss.expiresAt && iss.status === 'active') };
      return fail('GIFT_NOT_FOUND');
    }
    var s = stateOf(g, paymentOf(g)); if (s.status !== STATE.EXPIRED) return fail('NOT_EXPIRED', { giftStatus:s.status });
    var pj = journalOf('gift-purchase:' + giftId); if (!pj) return fail('PURCHASE_NOT_POSTED');
    var j = postJournal('gift-expiry:' + giftId, 'Gift code expired unredeemed · ' + giftId + ' · purchaser ' + g.purchaserId + ' · releases ' + pj + ' | انتهاء رمز هدية',
      [{ accountId:LIAB, debit:g.amountMinor, memo:'Liability released — code ' + giftId + ' expired ' + new Date(s.activation.expiresAt).toISOString().slice(0, 10) + ' (purchase ' + pj + ')', ref:giftId },
       { accountId:BREAKAGE, credit:g.amountMinor, memo:'Expired paid gift code value returning to RAF (not a refund)', ref:g.sourceReference }]);
    if (!j.ok) return j;
    var c = coll('gift_code_events'); if (!c) return fail('UNAVAILABLE');
    var w = c.append('eventId', { eventId:'GCE|' + giftId + '|expired', giftId:giftId, kind:'expired', expiresAt:s.activation.expiresAt, amountMinor:g.amountMinor,
      purchaseJournalId:pj, journalId:j.journalId, sourceReference:g.sourceReference, at:Date.now(), by:{ id:me().id } });
    if (!w.ok) return fail('PERSIST_FAILED');
    if (!w.duplicate) audit('gift.expired', me().id, giftId, { giftId:giftId, amountMinor:g.amountMinor, expiresAt:s.activation.expiresAt, journalId:j.journalId, purchaseJournalId:pj });
    return { ok:true, duplicate:!!(w.duplicate || j.duplicate), giftId:giftId, posted:true, journalId:j.journalId, purchaseJournalId:pj,
             entry:'Dr 2700 Gift Code Liability / Cr 4300 Gift Code Expiry (Breakage)' };
  }
  /* the purchased value by state — separately identifiable, never revenue —
     and 2700 reconciled against the records it was posted from */
  function outstanding(){
    if (!staffCan(['accounting.view'])) return fail('FORBIDDEN');
    var t = { pendingPaymentFils:0, availableFils:0, expiredFils:0, expiredReleasedFils:0, redeemedFils:0, failedFils:0 }, items = [], posted = 0;
    rows('gift_codes').forEach(function (g) {
      var v = view(g, false);
      if (v.status === STATE.PURCHASED) t.pendingPaymentFils += g.amountMinor;
      else if (v.status === STATE.AVAILABLE || v.status === STATE.ASSIGNED) { t.availableFils += g.amountMinor; items.push(v); }
      else if (v.status === STATE.EXPIRED) { t.expiredFils += g.amountMinor; if (journalOf('gift-expiry:' + g.giftId)) t.expiredReleasedFils += g.amountMinor; }
      else if (v.status === STATE.REDEEMED) t.redeemedFils += g.amountMinor;
      else if (v.status === STATE.FAILED) t.failedFils += g.amountMinor;
      /* what 2700 should hold: every posted purchase not yet released by a posted redemption */
      if (journalOf('gift-purchase:' + g.giftId) && !journalOf('gift-redemption:' + g.giftId) && !journalOf('gift-expiry:' + g.giftId)) posted += g.amountMinor;
    });
    var gl = null; try { var L = global.RAFAccounting && RAFAccounting.ledger(LIAB); gl = L && L.ok ? L.closingBalance : null; } catch (e) { gl = null; }
    return { ok:true, currency:'KWD', revenue:false, unredeemedLiabilityFils:t.availableFils, totals:t, unredeemed:items,
             ledger:{ accountId:LIAB, balanceFils:gl, expectedFils:posted, reconciles:gl === posted,
                      expiredReleasedFils:t.expiredReleasedFils, expiredAwaitingRecognitionFils:t.expiredFils - t.expiredReleasedFils } };
  }
  function accountingStatus(giftId){
    if (!staffCan(['accounting.view'])) return fail('FORBIDDEN');
    var g = purchasedById(giftId); if (!g) return fail('GIFT_NOT_FOUND');
    var v = view(g, false);
    return { ok:true, giftId:giftId, status:v.status, amountMinor:g.amountMinor, revenue:false,
             purchase:{ entry:'Dr 1200 / Cr 2700 Gift Code Liability', journalId:journalOf('gift-purchase:' + giftId) },
             redemption:{ entry:'Dr 2700 / Cr 2200 Customer Wallet Liability', journalId:journalOf('gift-redemption:' + giftId) },
             expiry:{ entry:'Dr 2700 / Cr 4300 Gift Code Expiry (Breakage)', journalId:journalOf('gift-expiry:' + giftId), applies:v.status === STATE.EXPIRED } };
  }

  /* the customer's path: the wallet credits, then the redemption is recorded */
  function redeem(code){
    if (!global.RAFWallet || !RAFWallet.redeemGift) return { ok:false, code:'UNAVAILABLE', message:T('المحفظة غير متاحة.', 'The wallet is not available.') };
    return RAFWallet.redeemGift(code);
  }

  global.RAFGift = {
    STATE:STATE,
    create:create, list:list, redeem:redeem, canCreate:canCreate,
    purchase:purchase, mine:mine, purchasedList:purchasedList, getPurchased:getPurchased, outstanding:outstanding, accountingStatus:accountingStatus,
    postPurchase:postPurchase, postRedemption:postRedemption, recordExpiry:recordExpiry,
    /* RAFMoney calls this once the purchase payment is received: the validity starts */
    _activate: function (giftId) {
      var g = purchasedById(giftId); if (!g) return;
      var pay = paymentOf(g); if (!pay || pay.status !== 'received') return;
      var m = g.validityMonths || validityMonths(); if (!m) return;   /* the months recorded at purchase (earlier records: the setting) */
      var at = pay.receivedAt || Date.now(), col = coll('gift_code_events'); if (!col) return;
      var w = col.append('eventId', { eventId:'GCE|' + giftId + '|activated', giftId:giftId, kind:'activated', at:at, validityMonths:m, expiresAt:addMonths(at, m) });
      if (w.ok && !w.duplicate) audit('gift.activated', g.purchaserId, giftId, { giftId:giftId, validityMonths:m, expiresAt:w.record.expiresAt });
    },
    /* read-only record lookup for RAFWallet (the wallet never trusts a caller's value) */
    _record: function (code) {
      var c = norm(code);
      var g = purchasedByCode(c);
      if (g) { var s = stateOf(g, paymentOf(g)).status;
        var st0 = stateOf(g, paymentOf(g));
        return { kind:'purchased', code:g.code, giftId:g.giftId, amountMinor:g.amountMinor, status:s, purchaserId:g.purchaserId, paymentId:g.paymentId, expiresAt:st0.activation ? st0.activation.expiresAt : null }; }
      var r = read().filter(function (x) { return x.code === c; })[0];
      return r ? Object.assign(JSON.parse(JSON.stringify(r)), { kind:'issued' }) : null;
    },
    /* called by RAFWallet after the ledger credit succeeded */
    _markUsed: function (code, customerId, txId) {
      var c = norm(code), g = purchasedByCode(c);
      if (g) {
        var col = coll('gift_code_events'); if (!col) return;
        var w = col.append('eventId', { eventId:'GCE|' + g.giftId + '|redeemed', giftId:g.giftId, kind:'redeemed', customerId:customerId, walletTransactionId:txId, at:Date.now() });
        if (w.ok && !w.duplicate) audit('gift.redeemed', customerId, c, { giftId:g.giftId, purchaserId:g.purchaserId, recipientId:customerId, transactionId:txId });
        return;
      }
      var all = read(), changed = false;
      all.forEach(function (r) { if (r.code === c && r.status === 'active') { r.status = 'redeemed'; r.redeemedBy = customerId; r.redeemedAt = Date.now(); r.transactionId = txId; changed = true; } });
      if (changed) { write(all); audit('gift.redeemed', customerId, c, { code:c, transactionId:txId }); }
    }
  };
})(window);
