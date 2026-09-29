/* ============================================================================
 * RAF Marketplace — MERCHANT ACCOUNT ACTIVATION & CREDENTIAL  (RAFMerchantAuth)
 * ----------------------------------------------------------------------------
 * The one owner of a provisioned merchant account's ACTIVATION and of its
 * sign-in CREDENTIAL. Isolated on purpose: no customer, driver or staff
 * account has a credential here, and their sign-in is unchanged.
 *
 *   provisioned (pending_activation)
 *     → issueActivation   one single-use token, expires after TOKEN_DAYS
 *     → activate          the merchant sets a password on
 *                         raf_merchant_activate.html#token=…
 *     → RAFPerm.completeMerchantActivation  pending_activation → active
 *     → the token is consumed (a 'used' record); it can never work again
 *
 * STORAGE (RAFRecordStore)
 *   merchant_activations  append-only: one 'issued' record per token, one
 *                         'used' record when it succeeds. State is derived.
 *   merchant_credentials  state map: the salted PBKDF2-SHA256 hash per
 *                         activated merchant account — never a password.
 *
 * PROTOTYPE LIMITS — stated, not hidden:
 *   · No email service exists. Nothing is ever sent; RAF Management can read
 *     the prototype activation link (stores.approve) instead.
 *   · This is a client-side prototype. The hash is computed and stored in
 *     the browser; production needs a server-side authentication service,
 *     server-side hashing and a transport for the activation link.
 *   · The raw token is kept in its activation record so the prototype link
 *     can be shown to Management; production stores only a token hash.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFMerchantAuth) return;

  var TOKEN_DAYS = 7;
  var POLICY = { minLength:8, maxLength:128 };
  var KDF = { name:'PBKDF2', hash:'SHA-256', iterations:150000, saltBytes:16, bits:256 };

  function isEn(){ var r = (global.document && (document.getElementById('htmlRoot') || document.documentElement)); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAVAILABLE:      { ar:'تعذّر الوصول إلى سجل التفعيل.',                 en:'The activation record is unavailable.' },
    FORBIDDEN:        { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',             en:'You do not have permission for this action.' },
    NOT_PENDING:      { ar:'الحساب ليس بانتظار التفعيل.',                   en:'The account is not awaiting activation.' },
    INVALID_TOKEN:    { ar:'رابط التفعيل غير صالح.',                        en:'This activation link is not valid.' },
    TOKEN_USED:       { ar:'تم استخدام رابط التفعيل هذا من قبل.',            en:'This activation link has already been used.' },
    TOKEN_EXPIRED:    { ar:'انتهت صلاحية رابط التفعيل.',                    en:'This activation link has expired.' },
    PASSWORD_SHORT:   { ar:'كلمة المرور 8 أحرف على الأقل.',                  en:'The password must be at least 8 characters.' },
    PASSWORD_LONG:    { ar:'كلمة المرور أطول من المسموح.',                  en:'The password is too long.' },
    PASSWORD_MISMATCH:{ ar:'كلمتا المرور غير متطابقتين.',                   en:'The passwords do not match.' },
    CRYPTO_UNAVAILABLE:{ ar:'لا يدعم هذا المتصفح التشفير المطلوب.',          en:'This browser does not provide the required cryptography.' },
    PERSIST_FAILED:   { ar:'تعذّر حفظ التفعيل.',                             en:'The activation could not be saved.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* ---------- storage ---------- */
  function coll(){ try { return global.RAFRecordStore ? RAFRecordStore.collection('merchant_activations') : null; } catch (e) { return null; } }
  function creds(){ try { return global.RAFRecordStore ? RAFRecordStore.stateMap('merchant_credentials') : null; } catch (e) { return null; } }
  function rows(){ var c = coll(); return c ? c.all() : []; }
  /* every token, as it stands now — derived from its records */
  function tokens(){
    var used = {};
    rows().forEach(function (r) { if (r.kind === 'used') used[r.activationId] = r.at; });
    return rows().filter(function (r) { return r.kind === 'issued'; }).map(function (r) {
      var state = used[r.activationId] ? 'used' : (Date.now() > r.expiresAt ? 'expired' : 'valid');
      return { activationId:r.activationId, token:r.token, accountId:r.accountId, createdAt:r.createdAt,
               expiresAt:r.expiresAt, usedAt:used[r.activationId] || null, state:state };
    });
  }
  function byToken(token){
    var t = String(token || '');
    if (!/^[a-f0-9]{64}$/.test(t)) return null;
    return tokens().filter(function (x) { return x.token === t; })[0] || null;
  }
  function randomHex(n){
    var b = new Uint8Array(n); global.crypto.getRandomValues(b);
    return Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  function b64(buf){ var s = ''; new Uint8Array(buf).forEach(function (x) { s += String.fromCharCode(x); }); return btoa(s); }
  function unb64(s){ var bin = atob(s), out = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
  function audit(action, actorId, extra){
    if (!global.RAFAudit || !RAFAudit.record) return;
    try { RAFAudit.record(Object.assign({ action:action, actor:actorId ? { id:actorId } : undefined, source:'admin' }, extra || {})); } catch (e) {}
  }
  function account(id){ try { return global.RAFPerm ? RAFPerm.getUser(id) : null; } catch (e) { return null; } }
  function sessionCan(key){
    var R = global.RAFPerm; if (!R) return null;
    var sid = null; try { sid = R.sessionUserId ? R.sessionUserId() : null; } catch (e) { sid = null; }
    return sid && R.can(sid, key) ? sid : null;
  }

  /* ══════════ 1 · ISSUE — at provisioning, by the approving reviewer ══════════
     Idempotent: an account that already has a valid, unused token gets that
     same token back, never a second one. */
  function issueActivation(accountId){
    var by = sessionCan('stores.approve'); if (!by) return fail('FORBIDDEN');
    var acc = account(accountId);
    if (!acc || acc.roleId !== 'merchant' || acc.status !== (RAFPerm.PENDING_ACTIVATION || 'pending_activation')) return fail('NOT_PENDING');
    var live = tokens().filter(function (x) { return x.accountId === accountId && x.state === 'valid'; })[0];
    if (live) return { ok:true, duplicate:true, activationId:live.activationId, expiresAt:live.expiresAt };
    var c = coll(); if (!c) return fail('UNAVAILABLE');
    if (!global.crypto || !global.crypto.getRandomValues) return fail('CRYPTO_UNAVAILABLE');
    var now = Date.now();
    var rec = { recordId:'mact|' + randomHex(8), activationId:'act-' + randomHex(8), kind:'issued',
                token:randomHex(32), accountId:accountId, createdAt:now, expiresAt:now + TOKEN_DAYS * 86400000, by:by };
    var w = c.append('recordId', rec);
    if (!w.ok) return fail('PERSIST_FAILED');
    /* the token itself is never written to the audit log */
    audit('merchant.activation_issued', by, { key:rec.activationId, metadata:{ accountId:accountId, activationId:rec.activationId, expiresAt:rec.expiresAt } });
    return { ok:true, activationId:rec.activationId, expiresAt:rec.expiresAt };
  }

  /* ══════════ 2 · INSPECT — the activation page's read; writes nothing ══════════
     Account details are returned ONLY for a valid token. */
  function inspect(token){
    var t = byToken(token);
    if (!t) return { ok:true, state:'invalid' };
    if (t.state !== 'valid') return { ok:true, state:t.state };
    var acc = account(t.accountId);
    if (!acc || acc.status !== (RAFPerm.PENDING_ACTIVATION || 'pending_activation')) return { ok:true, state:'used' };
    var store = null; try { store = global.RAFSource && acc.storeSlug ? RAFSource.store(acc.storeSlug) : null; } catch (e) { store = null; }
    return { ok:true, state:'valid', merchantName:acc.name || null, storeName:store && store.name ? store.name : null,
             expiresAt:t.expiresAt, policy:{ minLength:POLICY.minLength } };
  }
  /* for RAFPerm.completeMerchantActivation only: the pending account a VALID token belongs to */
  function resolveActivationToken(token){
    var t = byToken(token);
    return t && t.state === 'valid' ? { accountId:t.accountId, activationId:t.activationId } : null;
  }

  /* ══════════ 3 · ACTIVATE — the merchant sets the password ══════════
     Nothing is consumed until everything has succeeded; the token is checked
     again right before the account changes, so two tabs cannot both win. */
  function derive(password, salt){
    var enc = new TextEncoder();
    return global.crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
      .then(function (key) { return global.crypto.subtle.deriveBits({ name:'PBKDF2', hash:KDF.hash, salt:salt, iterations:KDF.iterations }, key, KDF.bits); });
  }
  function activate(token, password, confirm){
    var t = byToken(token);
    if (!t) return Promise.resolve(fail('INVALID_TOKEN'));
    if (t.state === 'used') return Promise.resolve(fail('TOKEN_USED'));
    if (t.state === 'expired') return Promise.resolve(fail('TOKEN_EXPIRED'));
    var acc = account(t.accountId);
    if (!acc || acc.roleId !== 'merchant' || acc.status !== (RAFPerm.PENDING_ACTIVATION || 'pending_activation')) return Promise.resolve(fail('TOKEN_USED'));
    var pw = String(password == null ? '' : password);
    if (pw.length < POLICY.minLength) return Promise.resolve(fail('PASSWORD_SHORT'));
    if (pw.length > POLICY.maxLength) return Promise.resolve(fail('PASSWORD_LONG'));
    if (pw !== String(confirm == null ? '' : confirm)) return Promise.resolve(fail('PASSWORD_MISMATCH'));
    if (!global.crypto || !global.crypto.subtle || !global.TextEncoder) return Promise.resolve(fail('CRYPTO_UNAVAILABLE'));
    var salt = new Uint8Array(KDF.saltBytes); global.crypto.getRandomValues(salt);
    return derive(pw, salt).then(function (bits) {
      /* re-check: another tab may have finished while the hash was computed */
      var t2 = byToken(token);
      if (!t2 || t2.state !== 'valid') return fail('TOKEN_USED');
      var m = creds(), c = coll(); if (!m || !c) return fail('UNAVAILABLE');
      if (!m.set(t2.accountId, { alg:'PBKDF2-SHA256', iterations:KDF.iterations, salt:b64(salt), hash:b64(bits), setAt:Date.now() }))
        return fail('PERSIST_FAILED');
      var r = RAFPerm.completeMerchantActivation(token);
      if (!r || !r.ok) { m.remove(t2.accountId); return fail(r && r.reason === 'not_pending' ? 'TOKEN_USED' : 'PERSIST_FAILED'); }
      var w = c.append('recordId', { recordId:'mact-used|' + t2.activationId, activationId:t2.activationId, kind:'used', at:Date.now() });
      if (!w.ok) return fail('PERSIST_FAILED');
      audit('merchant.account_activated', t2.accountId, { key:t2.activationId, previousState:'pending_activation', newState:'active',
        metadata:{ accountId:t2.accountId, activationId:t2.activationId } });
      return { ok:true, accountId:t2.accountId };
    }, function () { return fail('CRYPTO_UNAVAILABLE'); });
  }

  /* ══════════ 4 · SIGN-IN — merchant accounts that have a credential ══════════ */
  function hasCredential(accountId){ var m = creds(); return !!(m && m.get(accountId)); }
  function verifyPassword(accountId, password){
    var m = creds(), c = m ? m.get(accountId) : null;
    if (!c || !global.crypto || !global.crypto.subtle) return Promise.resolve(false);
    return derive(String(password == null ? '' : password), unb64(c.salt)).then(function (bits) {
      var a = b64(bits), b = c.hash, diff = a.length ^ b.length;
      for (var i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return diff === 0;
    }, function () { return false; });
  }

  /* ══════════ 5 · PROTOTYPE LINK — RAF Management only ══════════
     There is no email service. A reviewer holding stores.approve can read the
     activation link to hand it over; it is never shown anywhere else. */
  function prototypeActivationLink(accountId){
    if (!sessionCan('stores.approve')) return fail('FORBIDDEN');
    var list = tokens().filter(function (x) { return x.accountId === accountId; }).sort(function (a, b) { return b.createdAt - a.createdAt; });
    var t = list[0];
    if (!t) return { ok:true, state:'none' };
    return { ok:true, state:t.state, expiresAt:t.expiresAt, usedAt:t.usedAt,
             href:t.state === 'valid' ? 'raf_merchant_activate.html#token=' + t.token : null };
  }

  global.RAFMerchantAuth = {
    TOKEN_DAYS:TOKEN_DAYS, POLICY:POLICY, ERRORS:ERRORS,
    issueActivation:issueActivation, inspect:inspect, activate:activate,
    hasCredential:hasCredential, verifyPassword:verifyPassword,
    prototypeActivationLink:prototypeActivationLink,
    resolveActivationToken:resolveActivationToken
  };
})(window);
