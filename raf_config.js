/* ==========================================================================
 * RAF — CONFIGURATION AUTHORITY  (RAFConfig)
 * --------------------------------------------------------------------------
 * The single authoritative source for business/system values that RAF
 * Management will configure. Business logic READS values from here; it never
 * carries its own copy of a threshold, and no page decides one.
 *
 * STATES, NEVER BLURRED
 *   · approved        — a value approved in the RAF logistics model; it holds
 *                       until RAF Management changes it;
 *   · prototype_temporary — no approved value exists, but a clearly marked
 *                       TEMPORARY PROTOTYPE value lets a workflow be exercised.
 *                       It is never
 *                       reported as approved and set() replaces it;
 *   · overridden      — a value set through set() by an authorised account;
 *   · not_configured  — no value has been approved. value is null and the
 *                       caller MUST treat the capability as unavailable. No
 *                       arbitrary default is ever substituted.
 *
 * WRITES — set() requires an active signed-in account holding the existing
 * `settings.edit` permission (no new key). Every change is audited
 * ('config.changed') and published on RAFEventBus. The administrative UI for
 * this is RAF Management, which is not built yet; this phase provides the
 * authority only.
 *
 * SCOPE — logistics, order-lifecycle, communication and notification policy. The order
 * acceptance window and undo window are registered here and READ from here by
 * RAFOrderEngine: one configurable value, every consumer on it. The merchant
 * order-processing LOCK (heartbeat, stale threshold) stays inside the engine —
 * it is concurrency mechanics, not a business value anyone configures.
 *
 * PROTOTYPE — overrides persist through RAFRecordStore's 'config' state map
 * (localStorage). Production requires a server-side configuration store with
 * versioning and access control.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFConfig) return;

  var VERSION = 1;
  var APPROVED_SOURCE = 'RAF logistics model (approved 2026-09-14)';

  var CATEGORIES = {
    eta:           { ar:'قواعد الوقت المتوقع للوصول', en:'ETA rules' },
    compensation:  { ar:'التعويض',                   en:'Compensation' },
    notifications: { ar:'الإشعارات',                 en:'Notifications' },
    checkout:      { ar:'إتمام الشراء',              en:'Checkout' },
    orders:        { ar:'الطلبات',                   en:'Orders' },
    store_ops:     { ar:'تشغيل المتجر',              en:'Store operations' },
    support:       { ar:'خدمة العملاء',              en:'Customer Service' },
    communication: { ar:'التواصل مع السائق',         en:'Driver communication' }
  };

  /* ---------- the registry ----------
     type: minutes | seconds | ms | integer | fils | boolean | enum | text | list
     approved: the approved value, or null when none has been approved */
  function k(key, category, type, approved, extra){
    return Object.assign({ key:key, category:category, type:type, approved:approved === undefined ? null : approved }, extra || {});
  }
  var REGISTRY = [
    /* ETA */
    k('eta.base',                         'eta', 'enum', 'merchant_accepted_at',
      { allowed:['merchant_accepted_at'], note:'Promised ETA starts from the actual Merchant Accept time.' }),
    /* Phase E: the offset is configurable prototype configuration (90 minutes) */
    k('eta.promisedDurationMinutes',      'eta', 'minutes', null,
      { prototype:90, note:'Promised ETA = Merchant Accepted Time + this offset. TEMPORARY PROTOTYPE CONFIGURATION.' }),

    /* orders — the two order-lifecycle timings Operations is responsible for.
       They lived as constants inside RAFOrderEngine; the values here are the
       ones the engine has always applied (5 minutes / 10 seconds), moved, not
       changed and not duplicated: RAFOrderEngine now READS them from here, so
       there is one configurable value and every consumer uses it. The order
       LOCK heartbeat and stale threshold stay inside the engine — they are
       concurrency mechanics, not a business policy anyone configures. */
    k('orders.acceptanceWindowMinutes',   'orders', 'minutes', 5,
      { note:'How long a store has to accept or reject an order before the window closes.' }),
    k('orders.undoWindowSeconds',         'orders', 'seconds', 10,
      { note:'How long a merchant may undo the action just taken on an order.' }),

    /* checkout — the stock hold a checkout session keeps (RAFRules.Reserve).
       Moved here from a constant in raf_rules.js; the value is unchanged. */
    k('checkout.reservationHoldMinutes',  'checkout', 'minutes', null,
      { prototype:15, note:'A checkout session holds the cart’s units for this long. TEMPORARY PROTOTYPE CONFIGURATION — the 15 minutes RAFRules already applied, not an approved business value.' }),

    /* store operations — how long before closing a store stops taking orders
       (RAFStoreOps). Moved here from a constant in raf_store_ops.js; unchanged. */
    k('storeOps.orderCutoffMinutes',      'store_ops', 'minutes', null,
      { prototype:30, note:'Same-day ordering stops this long before the store’s closing time, and Instant Delivery stops this long before the end of the day’s final period. TEMPORARY PROTOTYPE CONFIGURATION — the 30 minutes RAFStoreOps already applied.' }),

    /* compensation */
    /* ON/OFF carries a real value — `false`, the state RAF has always operated
       under and the one RAFCompensation already applies (anything but true is
       OFF). It is recorded as a value rather than left unconfigured so the
       responsible manager sees the state the business is actually in and can
       change it. OFF affects new issuance only. */
    k('compensation.enabled',             'compensation', 'boolean', false, { note:'When off, no new compensation is issued. Coupons already issued stay valid (RAFCompensation).' }),
    k('compensation.excludedDelayMinutes','compensation', 'minutes', 90),
    k('compensation.stepMinutes',         'compensation', 'minutes', 20),
    k('compensation.amountPerStepFils',   'compensation', 'fils', 1000, { note:'1 KD per completed step.' }),
    k('compensation.couponExpiryDays',    'compensation', 'integer', 7),
    /* Phase I — the customer-facing wording is configurable; no wording is approved */
    k('compensation.customerMessage',     'compensation', 'text', null,
      { prototype:{
          ar:'تأخر تسليم طلبك {orderId}. الوقت الموعود كان {promisedEta}، ويبدأ احتساب التعويض بعد {excludedMinutes} دقيقة منه ({startAt}). لكل {stepMinutes} دقيقة مكتملة بعد ذلك {amountPerStep} د.ك. تعويضك قسيمة بقيمة {amount} د.ك صالحة لمدة {validityDays} أيام حتى {expiresAt}، وتُستخدم فقط بإضافتها إلى محفظة RAF.',
          en:'Your order {orderId} was delivered late. The promised time was {promisedEta}; compensation starts {excludedMinutes} minutes after it ({startAt}). Each completed {stepMinutes} minutes after that earns {amountPerStep} KWD. Your compensation is a {amount} KWD coupon valid for {validityDays} days, until {expiresAt}, usable only by adding it to your RAF Wallet.' },
        note:'TEMPORARY PROTOTYPE CONFIGURATION. Placeholders: {orderId} {promisedEta} {startAt} {excludedMinutes} {stepMinutes} {amountPerStep} {amount} {validityDays} {expiresAt}.' }),

    /* Customer Service (RAFCustomerService).
       The two SLA durations are NOT CONFIGURED: no first-response or
       resolution target is approved, so nothing may show a countdown, a
       "near SLA" figure or a breach. A ticket records the SLA state that
       applied when it was opened and that snapshot is never rewritten. */
    k('support.firstResponseMinutes',     'support', 'minutes', null,
      { note:'Minutes from ticket creation to the first customer-visible response. NOT CONFIGURED — no target is approved. No prototype value: Near SLA / Breached stay unavailable until RAF approves one.' }),
    k('support.resolutionMinutes',        'support', 'minutes', null,
      { note:'Minutes from ticket creation to resolution. NOT CONFIGURED — no target is approved. No prototype value.' }),
    /* the ticket categories the Customer Service UI offers. Configurable from
       here so no page carries its own list. */
    k('support.categories',               'support', 'list', [
        { key:'orders',    ar:'الطلبات',        en:'Orders' },
        { key:'payments',  ar:'المدفوعات',      en:'Payments' },
        { key:'wallet',    ar:'المحفظة',        en:'Wallet' },
        { key:'delivery',  ar:'التوصيل',        en:'Delivery' },
        { key:'account',   ar:'الحساب',         en:'Account' },
        { key:'technical', ar:'مشكلة تقنية',    en:'Technical' },
        { key:'general',   ar:'عام',            en:'General' }
      ], { note:'Initial Customer Service categories approved; Arabic labels not approved yet.' }),

    /* Customer ↔ Driver communication (RAFDriverCommunication). Each key has
       exactly one consumer: that authority, which enforces it on every send and
       call. No value is approved; these are the TEMPORARY PROTOTYPE values the
       business set for the prototype, and every one can be changed here. */
    k('communication.callAttemptLimit',     'communication', 'integer', null,
      { prototype:15, note:'Maximum call attempts per caller to the other participant in one conversation, counted separately for Customer → Driver and Driver → Customer. Messaging is never limited by it. TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('communication.maxImagesPerMessage',  'communication', 'integer', null,
      { prototype:3, note:'Maximum images in one message. TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('communication.maxImageKB',           'communication', 'integer', null,
      { prototype:200, note:'Maximum size of one image as sent, in KB (1 KB = 1024 bytes). Originals are never re-compressed. TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('communication.maxVoiceKB',           'communication', 'integer', null,
      { prototype:300, note:'Maximum size of one voice message as recorded, in KB (1 KB = 1024 bytes). TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('communication.maxVoiceSeconds',      'communication', 'seconds', null,
      { prototype:60, note:'Maximum voice message length. TEMPORARY PROTOTYPE CONFIGURATION.' }),

    /* notifications */
    k('notifications.soundDefault',       'notifications', 'boolean', null,
      { note:'Default sound state for non-merchant accounts is not approved. Merchant alert defaults stay owned by RAFMerchantPrefs.' }),

  ];
  var BY_KEY = {};
  REGISTRY.forEach(function (r) { BY_KEY[r.key] = r; });

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNKNOWN_KEY:   { ar:'مفتاح إعداد غير معروف.',             en:'Unknown configuration key.' },
    FORBIDDEN:     { ar:'لا تملك صلاحية تعديل الإعدادات.',     en:'You do not have permission to change settings.' },
    ACTOR_INACTIVE:{ ar:'حسابك موقوف.',                        en:'Your account is suspended.' },
    INVALID_VALUE: { ar:'قيمة الإعداد غير صالحة.',             en:'That configuration value is not valid.' },
    PERSIST_FAILED:{ ar:'تعذّر حفظ الإعداد.',                  en:'The setting could not be saved.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    return Object.assign({ ok:false, code:code, message:T(m.ar, m.en) }, extra || {});
  }

  function store(){ return global.RAFRecordStore ? RAFRecordStore.stateMap('config') : null; }
  function overrideOf(key){ var s = store(); return s ? s.get(key) : null; }
  function history(){ return global.RAFRecordStore ? RAFRecordStore.collection('config_history') : null; }
  function defaultOf(def){ return def.approved !== null ? def.approved : (def.prototype != null ? def.prototype : null); }
  /* the value as it stood at instant `at` (null = not configured then). Derived
     from the append-only change history; an override older than the history
     (set before Phase I) applies from its own `at`. Deterministic, read-only. */
  function valueAt(key, at){
    var def = BY_KEY[key]; if (!def || typeof at !== 'number') return null;
    var h = history(), last = null;
    (h ? h.filter(function (e) { return e.key === key && e.at <= at; }) : []).forEach(function (e) {
      if (!last || e.at > last.at || (e.at === last.at && (e.seq || 0) > (last.seq || 0))) last = e; });
    if (last) return last.value;
    var o = overrideOf(key);
    var anyHistory = h ? h.filter(function (e) { return e.key === key; }).length > 0 : false;
    if (o && o.value != null && !anyHistory && typeof o.at === 'number' && o.at <= at) return o.value;
    return defaultOf(def);
  }

  /* ---------- reads ---------- */
  function get(key){
    var def = BY_KEY[key];
    if (!def) return fail('UNKNOWN_KEY', { key:key });
    var o = overrideOf(key);
    if (o && o.value !== undefined && o.value !== null) {
      return { ok:true, key:key, category:def.category, type:def.type, configured:true, status:'overridden',
               value:o.value, source:'RAF configuration (set ' + new Date(o.at).toISOString() + ')', setBy:o.by || null };
    }
    if (def.approved !== null) {
      return { ok:true, key:key, category:def.category, type:def.type, configured:true, status:'approved',
               value:def.approved, source:APPROVED_SOURCE };
    }
    if (def.prototype != null) {
      return { ok:true, key:key, category:def.category, type:def.type, configured:true, status:'prototype_temporary',
               temporary:true, value:def.prototype, source:'TEMPORARY PROTOTYPE CONFIGURATION (not approved)' };
    }
    return { ok:true, key:key, category:def.category, type:def.type, configured:false, status:'not_configured',
             value:null, source:null };
  }
  /* the value, or null when not configured — callers must treat null as
     "capability unavailable", never as zero or as a default */
  function value(key){ var g = get(key); return g.ok && g.configured ? g.value : null; }
  function isConfigured(key){ var g = get(key); return !!(g.ok && g.configured); }
  function keys(category){
    return REGISTRY.filter(function (r) { return !category || r.category === category; }).map(function (r) { return r.key; });
  }
  function describe(key){
    var d = BY_KEY[key]; if (!d) return null;
    return { key:d.key, category:d.category, type:d.type, allowed:d.allowed || null, note:d.note || null,
             approved:d.approved !== null, prototypeTemporary:d.approved === null && d.prototype != null };
  }

  /* ---------- validation ---------- */
  function valid(def, v){
    switch (def.type) {
      case 'minutes': case 'seconds': case 'ms': case 'integer': case 'fils':
        return typeof v === 'number' && isFinite(v) && Math.floor(v) === v && v > 0;
      case 'boolean': return typeof v === 'boolean';
      case 'enum':    return (def.allowed || []).indexOf(v) > -1;
      case 'text':    return !!v && typeof v === 'object' && (typeof v.ar === 'string' || typeof v.en === 'string');
      case 'list':    return Array.isArray(v);
      default:        return false;
    }
  }

  /* ---------- writes (authorised, audited, published) ---------- */
  function set(key, v){
    var def = BY_KEY[key];
    if (!def) return fail('UNKNOWN_KEY', { key:key });
    var u = null;
    try { u = global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; } catch (e) {}
    if (!u || !u.id) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var allowed = false;
    try { allowed = !!RAFPerm.can(u.id, 'settings.edit'); } catch (e) { allowed = false; }
    if (!allowed) return fail('FORBIDDEN');
    if (!valid(def, v)) return fail('INVALID_VALUE', { key:key });
    var s = store(); if (!s) return fail('PERSIST_FAILED');
    var before = get(key);
    var at = Date.now();
    /* the change history is appended FIRST: an override never exists without it */
    var h = history(); if (!h) return fail('PERSIST_FAILED');
    var ha = h.append('historyId', { historyId:key + '|' + at + '|' + u.id, key:key, value:v, at:at, by:u.id, previousStatus:before.status, version:1 });
    if (!ha.ok) return fail('PERSIST_FAILED');
    if (!s.set(key, { value:v, at:at, by:u.id })) return fail('PERSIST_FAILED');
    if (global.RAFAudit) {
      try {
        RAFAudit.record({ action:'config.changed', actor:{ id:u.id }, source:'admin', key:key + ':' + at,
          previousState:before.configured ? JSON.stringify(before.value) : null, newState:JSON.stringify(v),
          metadata:{ configKey:key, previousStatus:before.status } });
      } catch (e) {}
    }
    if (global.RAFEventBus) RAFEventBus.publish('config.changed', { entityId:key, source:'admin', payload:{ key:key } });
    return get(key);
  }

  global.RAFConfig = {
    VERSION:VERSION, CATEGORIES:CATEGORIES, ERRORS:ERRORS,
    get:get, value:value, valueAt:valueAt, isConfigured:isConfigured, keys:keys, describe:describe, set:set
  };
})(window);
