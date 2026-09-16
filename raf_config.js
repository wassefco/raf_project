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
 *                       TEMPORARY PROTOTYPE value lets a workflow be exercised
 *                       (today: the Logistics lock timings only). It is never
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
 * SCOPE — logistics and notification policy. Existing merchant-side timings
 * (acceptance window, undo window, merchant order lock) stay owned by
 * RAFOrderEngine and are deliberately NOT duplicated here.
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
    sla:           { ar:'مستوى خدمة الاستثناءات',   en:'Exception SLA' },
    pool:          { ar:'قواعد قائمة التوصيلات',     en:'Pool rules' },
    availability:  { ar:'التوفر والجداول',           en:'Availability & schedules' },
    overtime:      { ar:'العمل الإضافي',             en:'Overtime' },
    exceptions:    { ar:'الاستثناءات',               en:'Exceptions' },
    customer_msg:  { ar:'رسائل العملاء',             en:'Customer messages' },
    delivery_proof:{ ar:'إثبات التسليم',             en:'Delivery proof' },
    compensation:  { ar:'التعويض',                   en:'Compensation' },
    notifications: { ar:'الإشعارات',                 en:'Notifications' },
    locks:         { ar:'أقفال العمليات',            en:'Operation locks' }
  };

  /* ---------- the registry ----------
     type: minutes | ms | integer | fils | boolean | enum | text | list
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

    /* exception SLA — ONE clock per exception: opened → closed; never paused or reset.
       No duration is approved: executable TEMPORARY PROTOTYPE values only. */
    k('sla.exceptionDurationMinutes',     'sla', 'minutes', null,
      { prototype:30, note:'Minutes from exception open to SLA breach. TEMPORARY PROTOTYPE CONFIGURATION — not approved.' }),
    k('sla.approachingThresholdMinutes',  'sla', 'minutes', null,
      { prototype:10, note:'SLA Approaching when this many minutes (or fewer) remain before breach. TEMPORARY PROTOTYPE CONFIGURATION — not approved.' }),
    k('sla.escalationTargetRole',         'sla', 'enum', 'ops_manager', { allowed:['ops_manager'] }),
    /* delay penalty RISK only (no amount, no charge): the delivery is later than the Promised ETA by MORE than this */
    k('sla.penaltyRiskAfterMinutes',      'sla', 'minutes', null,
      { prototype:15, note:'Penalty Risk when now/delivered time exceeds the Promised ETA by more than this. TEMPORARY PROTOTYPE CONFIGURATION.' }),

    /* pools */
    k('pool.priorityAfterMinutes',        'pool', 'minutes', 5,
      { note:'A delivery returned to the pool becomes Priority after MORE than this many minutes.' }),
    k('pool.regularOrder',                'pool', 'enum', 'oldest_first', { allowed:['oldest_first'] }),
    k('pool.priorityOrder',               'pool', 'enum', 'promised_eta_closest_first', { allowed:['promised_eta_closest_first'] }),
    k('pool.priorityLabel',               'pool', 'text', { en:'Priority — Reassigned Delivery', ar:null },
      { note:'Arabic wording not approved yet.' }),

    /* availability & schedules */
    /* Phase F — Driver availability. The values below were APPROVED by the owner
       (final Phase F decisions) as prototype values; they stay RAFConfig-controlled. */
    k('availability.autoOfflineMinutes',  'availability', 'minutes', 240,
      { note:'Evaluated at the threshold of the availability session: no SUCCESSFUL claim for this long and ≥1 eligible pool delivery at that instant → Unavailable. Empty pool at the threshold → counter restarts from zero (never retroactive).' }),
    k('availability.basicWorkMinutes',    'availability', 'minutes', 480,
      { note:'Basic working time of one availability (= work) session (8 h).' }),
    k('availability.unavailableReasons',  'availability', 'list', null,
      { prototype:[
          { key:'personal_reason', en:'Personal Reason', ar:null },
          { key:'break_rest',      en:'Break / Rest',    ar:null },
          { key:'other',           en:'Other',           ar:null, requiresDescription:true }
        ],
        note:'Reasons a driver chooses when setting themself Unavailable. THREE TEMPORARY PROTOTYPE VALUES — Arabic labels not approved. History keeps the key and label used at the time.' }),
    k('availability.managementReasonRequired', 'availability', 'boolean', true,
      { note:'A management availability change requires a reason.' }),
    k('availability.defaultState',        'availability', 'enum', 'available',
      { allowed:['available', 'unavailable'], note:'State of a driver with no availability record yet.' }),
    k('availability.scheduleTimezone',    'availability', 'enum', 'Asia/Kuwait',
      { allowed:['Asia/Kuwait'], note:'Timezone of structured weekly schedule windows. The schedule is informational — it never changes availability.' }),

    /* overtime — continuation after the basic working time */
    k('overtime.enabled',                 'overtime', 'boolean', true,
      { note:'Continuation beyond the basic working time is allowed. OFF → Unavailable for NEW tasks at the end of basic working time.' }),
    k('overtime.limitEnabled',            'overtime', 'boolean', true,
      { note:'A maximum overtime applies.' }),
    k('overtime.limitMinutes',            'overtime', 'minutes', 120,
      { note:'Maximum overtime after the basic working time (2 h) → Unavailable for NEW tasks.' }),

    /* exceptions */
    k('exceptions.categories',            'exceptions', 'list', [
        { key:'driver_delayed',           en:'Driver Delayed',                  ar:null },
        { key:'vehicle_breakdown',        en:'Vehicle Breakdown',               ar:null },
        { key:'driver_emergency',         en:'Driver Emergency',                ar:null },
        { key:'driver_unable_to_continue',en:'Driver Unable to Continue',       ar:null },
        { key:'no_driver_available',      en:'No Driver Available',             ar:null },
        { key:'customer_unreachable',     en:'Customer Unreachable',            ar:null },
        { key:'wrong_address',            en:'Wrong / Incomplete Address',      ar:null },
        { key:'other',                    en:'Other', ar:null, requiresDescription:true }
      ], { note:'Initial categories approved; Arabic labels not approved yet.' }),
    k('exceptions.templates',             'exceptions', 'list', null),

    /* Phase H — Customer ↔ Driver communication media limits. No business limit is
       approved: TEMPORARY PROTOTYPE values sized for browser storage. */
    k('communication.maxImagesPerMessage', 'communication', 'integer', null,
      { prototype:3, note:'Maximum images in one message. TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('communication.maxImageBytes',       'communication', 'integer', null,
      { prototype:200000, note:'Maximum size of one image as sent (bytes). Originals are never re-compressed. TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('communication.maxVoiceBytes',       'communication', 'integer', null,
      { prototype:300000, note:'Maximum size of one voice message as recorded (bytes). TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('communication.maxVoiceSeconds',     'communication', 'integer', null,
      { prototype:60, note:'Maximum voice message length (seconds). TEMPORARY PROTOTYPE CONFIGURATION.' }),
    k('exceptions.customerUnreachableCallAttempts', 'exceptions', 'integer', null,
      { prototype:3, note:'Recorded CALL attempts (messages do not count) required before a driver can open Customer Unreachable. TEMPORARY PROTOTYPE CONFIGURATION.' }),
    /* selectable manual-escalation reasons: none approved, so escalation needs a description */
    k('exceptions.escalationReasons',     'exceptions', 'list', null,
      { note:'No escalation reason list is approved; a description is required instead.' }),
    /* which categories are delay-related (one customer delay notification on open) */
    k('exceptions.customerDelayCategories','exceptions', 'list', null,
      { prototype:['driver_delayed', 'vehicle_breakdown', 'driver_emergency', 'driver_unable_to_continue',
                   'no_driver_available', 'wrong_address', 'other'],
        note:'TEMPORARY PROTOTYPE CONFIGURATION — Customer Unreachable sends no delay message.' }),

    /* customer messages — safe wording only; {orderId} {eta} {reason} placeholders */
    k('customerMessages.delayTemplates',  'customer_msg', 'list', null,
      { prototype:[ { category:'*',
          ar:'قد يتأخر طلبك {orderId}. الوقت المتوقع للتسليم: {eta}.{reason}',
          en:'Your order {orderId} may be delayed. Expected delivery: {eta}.{reason}' } ],
        note:'TEMPORARY PROTOTYPE CONFIGURATION — per-category entries may be added; "*" is the fallback.' }),
    k('customerMessages.showDelayReason', 'customer_msg', 'boolean', null,
      { prototype:false, note:'Show Delay Reason — when ON the category label is appended to the customer message. TEMPORARY PROTOTYPE CONFIGURATION (OFF).' }),
    k('customerMessages.etaUpdateTemplate','customer_msg', 'text', null,
      { prototype:{ ar:'تم تحديث الوقت المتوقع لتسليم طلبك {orderId}: {eta}.', en:'The expected delivery time for your order {orderId} was updated: {eta}.' },
        note:'TEMPORARY PROTOTYPE CONFIGURATION.' }),

    /* delivery proof */
    k('otp.digits',                       'delivery_proof', 'enum', null, { allowed:[2, 3] }),
    k('otp.maxAttempts',                  'delivery_proof', 'integer', null),

    /* compensation */
    k('compensation.enabled',             'compensation', 'boolean', null, { note:'Feature is ON/OFF configurable. No approved value ⇒ OFF by default until a Super Admin enables it. OFF affects new issuance only (RAFCompensation).' }),
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

    /* notifications */
    k('notifications.soundDefault',       'notifications', 'boolean', null,
      { note:'Default sound state for non-merchant accounts is not approved. Merchant alert defaults stay owned by RAFMerchantPrefs.' }),

    /* Logistics operation locks — separate from the merchant order lock.
       TEMPORARY PROTOTYPE CONFIGURATION: no business value is approved. These
       prototype values exist only so the lock, heartbeat, stale recovery and
       dispatch workflows can be exercised; they are reported with status
       'prototype_temporary' (never 'approved') and are replaced through
       RAFConfig.set() or by an approved value, without code changes.
       15 s heartbeat; a lock is stale after 45 s of silence (three missed
       heartbeats). The merchant order lock timings are NOT reused. */
    k('logistics.lock.heartbeatMs',       'locks', 'ms', null,
      { prototype:15000, note:'TEMPORARY PROTOTYPE CONFIGURATION — not an approved business value.' }),
    k('logistics.lock.staleMs',           'locks', 'ms', null,
      { prototype:45000, note:'TEMPORARY PROTOTYPE CONFIGURATION — not an approved business value.' })
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
      case 'minutes': case 'ms': case 'integer': case 'fils':
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
