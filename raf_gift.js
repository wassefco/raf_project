/* ============================================================================
 * RAF Marketplace — Gift codes (authority)
 * ----------------------------------------------------------------------------
 * The one owner of RAF gift codes. A gift code carries a fixed KWD value that
 * a customer adds to their RAF Wallet once.
 *
 *   create({ code, amount, expiresAt? })  management — permission 'orders.refund'
 *                                         (the existing permission for paying
 *                                         value out to customers — Finance / management)
 *   list()                                management — every code and its state
 *   redeem(code)                          the signed-in customer → RAFWallet.redeemGift
 *
 * RULES (approved with this module)
 *   · a code is used ONCE, by one customer; the wallet credit is idempotent
 *     per code, so a repeated or concurrent attempt cannot credit twice
 *   · a code may have an expiry; after it, it cannot be redeemed
 *   · value is held in fils (integer); the wallet does the crediting
 *
 * No codes exist until management creates them. Storage: localStorage
 * (prototype, like the rest of RAF's client-side records).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFGift) return;

  var LS = 'raf_gift_codes';
  /* gift value is paid by RAF into a customer's wallet: the existing key for
     paying value out to customers (Finance / management), never a merchant's */
  var PERM_CREATE = 'orders.refund';
  function T(ar, en){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en' ? en : ar; }
  var ERRORS = {
    FORBIDDEN:      { ar:'ليس لديك صلاحية لإنشاء رموز الهدايا.', en:'You are not allowed to create gift codes.' },
    INVALID_CODE:   { ar:'رمز الهدية غير صالح (4–24 حرفاً أو رقماً).', en:'The gift code is not valid (4–24 letters or digits).' },
    DUPLICATE_CODE: { ar:'هذا الرمز موجود مسبقاً.', en:'That code already exists.' },
    INVALID_AMOUNT: { ar:'قيمة الهدية غير صالحة.', en:'The gift value is not valid.' },
    INVALID_EXPIRY: { ar:'تاريخ الانتهاء غير صالح.', en:'The expiry is not valid.' }
  };
  function fail(code){ var e = ERRORS[code] || { ar:code, en:code }; return { ok:false, code:code, message:T(e.ar, e.en) }; }
  function read(){ try { var a = JSON.parse(localStorage.getItem(LS) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function write(a){ localStorage.setItem(LS, JSON.stringify(a)); }
  function me(){ try { return global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; } catch (e) { return null; } }
  function canCreate(){ var u = me(); return !!(u && global.RAFPerm && RAFPerm.can && RAFPerm.can(u.id, PERM_CREATE)); }
  function norm(c){ return String(c || '').trim().toUpperCase(); }
  function pub(r){ return { code:r.code, amount:(r.amountMinor / 1000).toFixed(3), amountMinor:r.amountMinor, status:r.status,
    expiresAt:r.expiresAt || null, createdAt:r.createdAt, redeemedAt:r.redeemedAt || null }; }

  function create(p){
    p = p || {};
    if (!canCreate()) return fail('FORBIDDEN');
    var code = norm(p.code);
    if (!/^[A-Z0-9-]{4,24}$/.test(code)) return fail('INVALID_CODE');
    var all = read();
    if (all.some(function (r) { return r.code === code; })) return fail('DUPLICATE_CODE');
    var minor = global.RAFWallet ? RAFWallet.toMinor(p.amount) : null;
    if (minor === null || minor <= 0) return fail('INVALID_AMOUNT');
    var exp = p.expiresAt != null ? Number(p.expiresAt) : null;
    if (exp !== null && !(exp > Date.now())) return fail('INVALID_EXPIRY');
    var rec = { code:code, amountMinor:minor, status:'active', expiresAt:exp, createdAt:Date.now(), createdBy:me().id };
    all.push(rec); write(all);
    if (global.RAFAudit) try { RAFAudit.record({ action:'gift.created', actor:{ id:rec.createdBy }, key:code, metadata:{ code:code, amountMinor:minor, expiresAt:exp } }); } catch (e) {}
    return { ok:true, gift:pub(rec) };
  }
  function list(){ if (!canCreate()) return fail('FORBIDDEN'); return { ok:true, gifts:read().map(pub) }; }
  /* the customer's path: the wallet credits, then marks the code used */
  function redeem(code){
    if (!global.RAFWallet || !RAFWallet.redeemGift) return { ok:false, code:'UNAVAILABLE', message:T('المحفظة غير متاحة.', 'The wallet is not available.') };
    return RAFWallet.redeemGift(code);
  }

  global.RAFGift = {
    create:create, list:list, redeem:redeem, canCreate:canCreate,
    /* read-only record lookup for RAFWallet (the wallet never trusts a caller's value) */
    _record: function (code) { var c = norm(code); var r = read().filter(function (x) { return x.code === c; })[0]; return r ? JSON.parse(JSON.stringify(r)) : null; },
    /* called by RAFWallet after the ledger credit succeeded */
    _markUsed: function (code, customerId, txId) {
      var all = read(), c = norm(code), changed = false;
      all.forEach(function (r) { if (r.code === c && r.status === 'active') { r.status = 'redeemed'; r.redeemedBy = customerId; r.redeemedAt = Date.now(); r.transactionId = txId; changed = true; } });
      if (changed) { write(all); if (global.RAFAudit) try { RAFAudit.record({ action:'gift.redeemed', actor:{ id:customerId }, key:c, metadata:{ code:c, transactionId:txId } }); } catch (e) {} }
    }
  };
})(window);
