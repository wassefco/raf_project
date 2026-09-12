/* ==========================================================================
 * RAF — MERCHANT PERSONAL PREFERENCES  (RAFMerchantPrefs)
 * --------------------------------------------------------------------------
 * The one place that knows which primary pages the Merchant Dashboard has,
 * and the one place that stores a user's personal preferences:
 *
 *   · sidebar order      — the order the rail is drawn in
 *   · default landing    — the page the workspace opens on
 *   · alert sounds       — whether the two real merchant alerts make a sound
 *
 * The sound preference is PRESENTATION ONLY. It decides whether an existing
 * alert is audible; it never touches the acceptance window, a notification
 * record, a badge, a state transition or any other business behaviour.
 *
 * OWNERSHIP. A preference belongs to the SIGNED-IN ACCOUNT, never to a
 * store: the owner is RAFPerm's authoritative user id, resolved from the
 * session. A store slug, an email, a name or any caller-supplied identity is
 * never used, and one account's preferences can never be read or written
 * through another account.
 *
 * PERMISSIONS ARE NOT AFFECTED. This module decides presentation order only.
 * A page the account may not use is never offered as a landing page, and a
 * saved landing that later becomes unavailable falls back safely — but
 * nothing here grants, removes or bypasses a permission: every page keeps
 * its own gate exactly as before.
 *
 * VALIDATION. Only the canonical keys below are ever stored. Unknown,
 * duplicated or removed identifiers are refused, so no caller can inject a
 * route into the rail, and a stored order that predates a new page still
 * resolves against the canonical list.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFMerchantPrefs) return;

  var LS = 'raf_merchant_prefs';

  /* ---------- the canonical navigation, in the approved default order ----------
     `perm` is the EXISTING permission a page already requires; null means the
     page is available to any merchant account. No new permission key is
     introduced. Auctions is deliberately absent, Settings is not a primary
     item (it lives inside Store Management), and Customer Experience is the
     customers module — there is no separate Customers page. */
  var ITEMS = [
    { key:'dashboard', href:'raf_dashboard.html',           ic:'ti-layout-dashboard', ar:'الرئيسية', en:'Dashboard',
      fullAr:'الرئيسية',            fullEn:'Dashboard',             perm:null },
    { key:'orders',    href:'raf_merchant.html',            ic:'ti-clipboard-list',   ar:'الطلبات',  en:'Orders',
      fullAr:'الطلبات',             fullEn:'Orders',                perm:'orders.view' },
    { key:'products',  href:'raf_merchant_products.html',   ic:'ti-package',          ar:'المنتجات', en:'Products',
      fullAr:'المنتجات والمخزون',    fullEn:'Products & Inventory',  perm:'products.view' },
    { key:'marketing', href:'raf_marketing.html',           ic:'ti-speakerphone',     ar:'التسويق',  en:'Marketing',
      fullAr:'التسويق',             fullEn:'Marketing',             perm:'offers.view' },
    { key:'analytics', href:'raf_analytics.html',           ic:'ti-chart-line',       ar:'التحليلات', en:'Analytics',
      fullAr:'التحليلات والمالية',   fullEn:'Analytics & Finance',   perm:'reports.view' },
    { key:'store',     href:'raf_store_management.html',    ic:'ti-building-store',   ar:'المتجر',   en:'Store',
      fullAr:'إدارة المتجر',        fullEn:'Store Management',      perm:'stores.view' },
    { key:'customers', href:'raf_customer_experience.html', ic:'ti-mood-smile',       ar:'العملاء',  en:'Customers',
      fullAr:'تجربة العملاء',       fullEn:'Customer Experience',   perm:'stores.view' },
    { key:'support',   href:'raf_merchant_support.html',    ic:'ti-lifebuoy',         ar:'الدعم',    en:'Support',
      fullAr:'الدعم',               fullEn:'Support',               perm:null }
  ];
  var DEFAULT_ORDER = ITEMS.map(function (i) { return i.key; });
  var FALLBACK_LANDING = 'dashboard';

  /* ---------- the merchant alerts that actually exist ----------
     Exactly two sounds are produced by the workspace today: the new-order
     alert and the acceptance-window warning. Nothing else in RAF emits a
     merchant alert, so nothing else is offered as a preference. */
  var SOUND_KEYS = ['newOrder', 'warning'];
  var SOUND_DEFAULTS = { newOrder:true, warning:true };
  /* the workspace calls beep('new') / beep('warn') — both spellings resolve */
  var SOUND_ALIAS = { newOrder:'newOrder', 'new':'newOrder', warning:'warning', warn:'warning' };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'تفضيلات التنقل متاحة للتجار وموظفي المتاجر فقط.', en:'Navigation preferences are available to merchants and store employees only.' },
    OTHER_USER:         { ar:'لا يمكن تعديل تفضيلات حساب آخر.',                en:'Another account’s preferences cannot be changed.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',            en:'The request contains fields that are not accepted.' },
    INVALID_ORDER:      { ar:'ترتيب القائمة غير صالح.',                       en:'That sidebar order is not valid.' },
    INVALID_LANDING:    { ar:'الصفحة المختارة غير متاحة.',                    en:'That page is not available.' },
    INVALID_SOUNDS:     { ar:'إعداد التنبيه الصوتي غير صالح.',                en:'That alert sound setting is not valid.' },
    PERSIST_FAILED:     { ar:'تعذّر حفظ التفضيلات.',                          en:'The preferences could not be saved.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  function itemOf(key){
    for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].key === key) return ITEMS[i];
    return null;
  }
  /* the page a file name belongs to — used by the shared rail renderer */
  function itemForPage(file){
    var f = String(file || '').split('/').pop().split('?')[0].split('#')[0];
    for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].href === f) return ITEMS[i];
    return null;
  }
  function label(item, full){
    if (!item) return '';
    return full ? T(item.fullAr, item.fullEn) : T(item.ar, item.en);
  }

  /* ---------- identity: the signed-in account, by id ---------- */
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  function sessionId(){
    try { var u = global.RAFPerm && RAFPerm.currentUser(); return (u && u.id) || null; } catch (e) { return null; }
  }
  /* A preference is personal: it is only ever read or written for the
     account that is actually signed in. An id naming somebody else is
     refused rather than silently redirected. */
  function scope(actor){
    if (!global.RAFPerm) return fail('FORBIDDEN');
    var me = sessionId();
    if (!me) return fail('FORBIDDEN');
    var asked = actorId(actor);
    if (asked && asked !== me) return fail('OTHER_USER');
    var merchant = false;
    try { merchant = !!RAFPerm.isMerchant(me); } catch (e) { merchant = false; }
    if (!merchant) return fail('FORBIDDEN');
    return { ok:true, id:me };
  }
  function can(id, key){
    if (!key) return true;
    try { return !!(global.RAFPerm && RAFPerm.can(id, key)); } catch (e) { return false; }
  }
  /* the pages this account may actually open — the page's own existing gate */
  function allowedKeys(id){
    return ITEMS.filter(function (i) { return can(id, i.perm); }).map(function (i) { return i.key; });
  }

  /* ---------- storage: one module key, one record per user id ---------- */
  function readAll(){
    try {
      var v = JSON.parse(localStorage.getItem(LS) || 'null');
      if (v && typeof v === 'object' && v.users && typeof v.users === 'object') return v;
    } catch (e) {}
    return { users:{} };
  }
  function writeAll(db){
    try { localStorage.setItem(LS, JSON.stringify(db)); } catch (e) { return false; }
    try { document.dispatchEvent(new CustomEvent('raf:merchant-prefs')); } catch (e2) {}
    return true;
  }
  function recordOf(id){
    var r = readAll().users[id];
    return (r && typeof r === 'object') ? r : null;
  }

  /* ---------- validation ----------
     A stored order is never trusted: only canonical keys survive, duplicates
     are dropped, and anything the list does not mention is appended in the
     canonical order so the rail is always complete. */
  function sanitizeOrder(order){
    var seen = {}, out = [];
    (Array.isArray(order) ? order : []).forEach(function (k) {
      if (typeof k !== 'string' || seen[k] || !itemOf(k)) return;
      seen[k] = 1; out.push(k);
    });
    DEFAULT_ORDER.forEach(function (k) { if (!seen[k]) { seen[k] = 1; out.push(k); } });
    return out;
  }
  /* a submitted order must be exactly the canonical set, in some order */
  function validateOrder(order){
    if (!Array.isArray(order) || order.length !== DEFAULT_ORDER.length) return false;
    var seen = {};
    for (var i = 0; i < order.length; i++) {
      var k = order[i];
      if (typeof k !== 'string' || !itemOf(k) || seen[k]) return false;
      seen[k] = 1;
    }
    return true;
  }
  /* a stored sound setting is never trusted: only the two known alerts are
     read, only booleans count, and anything else falls back to "audible" so a
     damaged record can never silence an alert */
  function sanitizeSounds(v){
    var out = { newOrder:SOUND_DEFAULTS.newOrder, warning:SOUND_DEFAULTS.warning };
    if (v && typeof v === 'object')
      SOUND_KEYS.forEach(function (k) { if (typeof v[k] === 'boolean') out[k] = v[k]; });
    return out;
  }
  /* the landing page, proven against the account's permissions every time */
  function resolveLanding(id, stored){
    var allowed = allowedKeys(id);
    if (stored && allowed.indexOf(stored) > -1) return { key:stored, fellBack:false };
    if (allowed.indexOf(FALLBACK_LANDING) > -1) return { key:FALLBACK_LANDING, fellBack:!!stored };
    return { key:allowed[0] || null, fellBack:!!stored };
  }

  /* ══════════════════════ READ ══════════════════════ */
  function read(opts){
    opts = opts || {};
    if (Object.keys(opts).some(function (k) { return k !== 'actor'; })) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var rec = recordOf(sc.id) || {};
    var order = sanitizeOrder(rec.order);
    var allowed = allowedKeys(sc.id);
    var land = resolveLanding(sc.id, rec.landing || null);
    return { ok:true, userId:sc.id, order:order, allowed:allowed,
             landing:land.key, landingFellBack:land.fellBack,
             storedLanding:rec.landing || null,
             sounds:sanitizeSounds(rec.sounds), soundsCustomized:!!rec.sounds,
             customized:!!(rec.order || rec.landing), updatedAt:rec.updatedAt || null,
             defaultOrder:DEFAULT_ORDER.slice(), soundDefaults:{ newOrder:SOUND_DEFAULTS.newOrder, warning:SOUND_DEFAULTS.warning } };
  }
  /* Asked by the workspace right before it plays a sound. It answers for the
     signed-in account only, and it answers "audible" whenever it cannot be
     sure — a preference must never be able to swallow an alert by accident. */
  function soundEnabled(kind, actor){
    var key = SOUND_ALIAS[String(kind || '')];
    if (!key) return true;
    var sc = scope(actor); if (!sc.ok) return true;
    return sanitizeSounds((recordOf(sc.id) || {}).sounds)[key] !== false;
  }
  /* where the workspace should open for this account, as a page file name */
  function landingHref(actor){
    var r = read({ actor:actor });
    if (!r.ok || !r.landing) return null;
    var it = itemOf(r.landing);
    return it ? it.href : null;
  }

  /* ══════════════════════ WRITE ══════════════════════ */
  function save(input, opts){
    input = input || {}; opts = opts || {};
    if (Object.keys(input).some(function (k) { return k !== 'order' && k !== 'landing'; })) return fail('FIELD_NOT_ACCEPTED');
    if (Object.keys(opts).some(function (k) { return k !== 'actor'; })) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;

    var db = readAll(), rec = db.users[sc.id] && typeof db.users[sc.id] === 'object' ? db.users[sc.id] : {};
    if (input.order !== undefined) {
      if (!validateOrder(input.order)) return fail('INVALID_ORDER');
      rec.order = input.order.slice();
    }
    if (input.landing !== undefined) {
      if (input.landing === null) delete rec.landing;
      else {
        if (typeof input.landing !== 'string' || !itemOf(input.landing)) return fail('INVALID_LANDING');
        /* a page the account cannot open is never accepted as a landing page */
        if (allowedKeys(sc.id).indexOf(input.landing) < 0) return fail('INVALID_LANDING');
        rec.landing = input.landing;
      }
    }
    rec.updatedAt = Date.now();
    db.users[sc.id] = rec;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    return read({ actor:sc.id });
  }
  /* Alert sounds are saved on their own: saving them never rewrites the
     sidebar order or the landing page, and vice versa. */
  function saveSounds(input, opts){
    input = input || {}; opts = opts || {};
    var keys = Object.keys(input);
    if (keys.some(function (k) { return SOUND_KEYS.indexOf(k) < 0; })) return fail('FIELD_NOT_ACCEPTED');
    if (Object.keys(opts).some(function (k) { return k !== 'actor'; })) return fail('FIELD_NOT_ACCEPTED');
    if (keys.some(function (k) { return typeof input[k] !== 'boolean'; })) return fail('INVALID_SOUNDS');
    var sc = scope(opts.actor); if (!sc.ok) return sc;

    var db = readAll(), rec = db.users[sc.id] && typeof db.users[sc.id] === 'object' ? db.users[sc.id] : {};
    var next = sanitizeSounds(rec.sounds);
    keys.forEach(function (k) { next[k] = input[k]; });
    rec.sounds = next; rec.updatedAt = Date.now();
    db.users[sc.id] = rec;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    return read({ actor:sc.id });
  }
  /* Reset clears ONLY the navigation preferences of the signed-in account.
     Nothing else that account or its store owns is touched. */
  function reset(opts){
    opts = opts || {};
    if (Object.keys(opts).some(function (k) { return k !== 'actor'; })) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var db = readAll(), rec = db.users[sc.id];
    if (rec && typeof rec === 'object') {
      delete rec.order; delete rec.landing;
      if (Object.keys(rec).filter(function (k) { return k !== 'updatedAt'; }).length === 0) delete db.users[sc.id];
      else { rec.updatedAt = Date.now(); db.users[sc.id] = rec; }
      if (!writeAll(db)) return fail('PERSIST_FAILED');
    }
    return read({ actor:sc.id });
  }

  global.RAFMerchantPrefs = {
    ITEMS:ITEMS, DEFAULT_ORDER:DEFAULT_ORDER, FALLBACK_LANDING:FALLBACK_LANDING, ERRORS:ERRORS,
    itemOf:itemOf, itemForPage:itemForPage, label:label, allowedKeys:allowedKeys,
    validateOrder:validateOrder, sanitizeOrder:sanitizeOrder,
    SOUND_KEYS:SOUND_KEYS, SOUND_DEFAULTS:SOUND_DEFAULTS, sanitizeSounds:sanitizeSounds,
    read:read, landingHref:landingHref, soundEnabled:soundEnabled,
    save:save, saveSounds:saveSounds, reset:reset
  };
})(window);
