/* ==========================================================================
 * RAF — DRIVER EMPLOYEE MANAGEMENT  (RAFDriverManagement)
 * --------------------------------------------------------------------------
 * The authorisation and controlled-mutation layer over DRIVER EMPLOYEE
 * ACCOUNTS. It is NOT a user database and NOT an identity authority: RAFPerm
 * owns identity, holds the only user records, and performs every write. This
 * module decides who may ask, what may be asked, and nothing else.
 *
 * It is also strictly separate from the driver's own app. Nothing here is
 * reachable by a driver: a driver employee carries `orders.view` and no
 * management permission, so every operation below refuses them.
 *
 * PERMISSIONS — existing keys only, no new key invented:
 *   read                 drivers.view      (already used by this surface)
 *   suspend / reactivate drivers.suspend   (the drivers module's own status key)
 *   create               users.create      (creating an ACCOUNT is a users action)
 *   edit profile         users.edit
 * Roles that hold them today: super admin and higher management hold all
 * four; an operations manager holds drivers.* but not users.create/users.edit,
 * so an ops manager can suspend and reactivate a driver but cannot create or
 * edit one. That is what the existing registry says — it is reported, not
 * quietly widened.
 *
 * WHAT IS NEVER TOUCHED. A caller cannot reach id, accountType, roleId,
 * overrides, storeSlug or regDate through any operation here. Profile writes
 * go through RAFPerm.updateProfile (name/email/phone only) and status writes
 * through RAFPerm.setStatus (active/suspended only); neither can carry
 * anything else, whatever is passed in. Every write is read back before it is
 * reported as done.
 *
 * LIVE DELIVERIES ARE NOT TOUCHED EITHER. Suspending a driver removes their
 * access immediately — the driver authority requires an active account — but
 * it never automatically re-pools, reassigns, cancels or refunds a delivery
 * they already hold. An account decision must not silently mutate delivery
 * ownership, so the situation is surfaced to Logistics instead; moving the
 * delivery is a separate, explicit Logistics decision (not yet implemented).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDriverManagement) return;

  var DRIVER_ROLE = 'driver';
  var DRIVER_TYPE = 'driver';

  var PERM = {
    view:   'drivers.view',
    status: 'drivers.suspend',
    create: 'users.create',
    edit:   'users.edit'
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'لا تملك صلاحية إدارة السائقين.',            en:'You do not have permission to manage drivers.' },
    ACTOR_INACTIVE:     { ar:'حسابك موقوف.',                              en:'Your account is suspended.' },
    OTHER_ACTOR:        { ar:'لا يمكن العمل نيابة عن مستخدم آخر.',        en:'Another user’s identity cannot be used.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',       en:'The request contains fields that are not accepted.' },
    NOT_A_DRIVER:       { ar:'هذا الحساب ليس حساب سائق.',                 en:'That account is not a driver account.' },
    DRIVER_NOT_FOUND:   { ar:'حساب السائق غير موجود.',                    en:'That driver account does not exist.' },
    NAME_REQUIRED:      { ar:'الاسم مطلوب.',                              en:'A name is required.' },
    EMAIL_INVALID:      { ar:'صيغة البريد الإلكتروني غير صحيحة.',         en:'That email address is not valid.' },
    PHONE_INVALID:      { ar:'صيغة رقم الجوال غير صحيحة.',                en:'That phone number is not valid.' },
    EMAIL_TAKEN:        { ar:'البريد الإلكتروني مستخدم في حساب آخر.',     en:'That email already belongs to another account.' },
    PHONE_TAKEN:        { ar:'رقم الجوال مستخدم في حساب آخر.',            en:'That phone number already belongs to another account.' },
    NOTHING_CHANGED:    { ar:'لا توجد تغييرات لحفظها.',                   en:'There is nothing to save.' },
    ALREADY_SUSPENDED:  { ar:'الحساب موقوف بالفعل.',                      en:'That account is already suspended.' },
    ALREADY_ACTIVE:     { ar:'الحساب نشط بالفعل.',                        en:'That account is already active.' },
    PERSIST_FAILED:     { ar:'تعذّر حفظ التغيير.',                        en:'The change could not be saved.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){
    return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; });
  }

  /* ══════════════════ WHO IS ASKING ══════════════════
     The manager is the authenticated account. A supplied id naming somebody
     else is refused rather than honoured, a suspended manager is refused, and
     the permission is proved for every single operation — never once at page
     load and then trusted. */
  /* RAFPerm.currentUser() falls back to the first administrator when no
     session is stored — a demo convenience that predates this module. An
     administrative surface must not inherit it: with nobody signed in there
     is no actor, and every operation here refuses. */
  function sessionId(){
    try {
      var key = (global.RAFPerm && RAFPerm.LS && RAFPerm.LS.session) || 'raf_current_user';
      var raw = localStorage.getItem(key);
      if (raw == null || raw === '') return null;
      var id = null;
      try { id = JSON.parse(raw); } catch (e) { id = raw; }
      if (typeof id !== 'string' || !id) return null;
      var u = RAFPerm.getUser(id);
      return (u && u.id) || null;
    } catch (e) { return null; }
  }
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  function manager(actor, permKey){
    if (!global.RAFPerm) return fail('FORBIDDEN');
    var me = sessionId(); if (!me) return fail('FORBIDDEN');
    var asked = actorId(actor);
    if (asked && asked !== me) return fail('OTHER_ACTOR');
    var u = null; try { u = RAFPerm.getUser(me); } catch (e) {}
    if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var ok = false; try { ok = !!RAFPerm.can(u.id, permKey); } catch (e) { ok = false; }
    if (!ok) return fail('FORBIDDEN', { permission:permKey });
    return { ok:true, id:u.id, name:u.name, roleId:u.roleId };
  }
  function auditActor(sc){ return { id:sc.id, name:sc.name, roleId:sc.roleId }; }
  function audit(action, sc, driverId, extra){
    if (!global.RAFAudit) return null;
    try {
      var o = { action:action, actor:auditActor(sc), source:'admin',
                key:Date.now(), metadata:Object.assign({ driverId:driverId }, extra || {}) };
      return RAFAudit.record(o);
    } catch (e) { return null; }
  }

  /* ══════════════════ THE TARGET ══════════════════
     Every operation may only ever act on a DRIVER EMPLOYEE. Any other account
     — a merchant, a customer, an administrator — is refused as out of scope,
     so this surface can never become a general user editor. */
  function driverRecord(id){
    if (!id || !global.RAFPerm) return null;
    var u = null; try { u = RAFPerm.getUser(id); } catch (e) { return null; }
    if (!u) return null;
    if (u.accountType !== DRIVER_TYPE || u.roleId !== DRIVER_ROLE) return null;
    return u;
  }
  function target(driverId){
    if (!driverId || typeof driverId !== 'string') return fail('DRIVER_NOT_FOUND');
    var exists = null; try { exists = RAFPerm.getUser(driverId); } catch (e) {}
    if (!exists) return fail('DRIVER_NOT_FOUND');
    var d = driverRecord(driverId);
    if (!d) return fail('NOT_A_DRIVER');
    return { ok:true, user:d };
  }
  /* the shape this module hands out: account fields management needs, and no
     permission, override or store data */
  function view(u){
    var role = null; try { role = RAFPerm.getRole(u.roleId); } catch (e) {}
    return { id:u.id, name:u.name, email:u.email || null, phone:u.phone || null,
             role:role ? { ar:role.nameAr, en:role.nameEn } : null,
             status:u.status, since:u.regDate || null,
             live:liveDeliveryIds(u.id) };
  }
  /* Deliveries this driver is holding right now — order ids and stage only, so
     management can see the operational consequence of a status change without
     being handed any customer data. */
  function liveDeliveryIds(driverId){
    var D = global.RAFDriver;
    if (!D || !global.RAFShop) return [];
    var out = [];
    try {
      (RAFShop.Orders.all() || []).forEach(function (o) {
        var f = o.snapshot && o.snapshot.fulfilment;
        if (!f || f.driverId !== driverId) return;
        if (o.status === 'delivered' || o.status === 'cancelled') return;
        out.push({ orderId:o.id, pickedUp:!!f.pickedUpAt });
      });
    } catch (e) {}
    return out;
  }

  /* ══════════════════ VALIDATION ══════════════════
     Deliberately permissive about format and strict about identity: two
     accounts must never end up sharing an email or a phone, and nothing is
     silently normalised in a way that could merge two people. */
  function cleanName(v){ return String(v == null ? '' : v).trim().replace(/\s+/g, ' '); }
  function cleanContact(v){ return String(v == null ? '' : v).trim(); }
  function emailOk(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function phoneOk(v){ return (v.replace(/\D/g, '').length >= 6); }
  function takenBy(field, value, exceptId){
    var v = String(value || '').trim().toLowerCase();
    if (!v) return null;
    var hit = null;
    try {
      (RAFPerm.getUsers() || []).forEach(function (u) {
        if (u.id === exceptId) return;
        if (String(u[field] || '').trim().toLowerCase() === v) hit = u;
      });
    } catch (e) {}
    return hit;
  }
  function validateProfile(input, exceptId){
    var name = cleanName(input.name), email = cleanContact(input.email), phone = cleanContact(input.phone);
    if (input.name !== undefined && !name) return fail('NAME_REQUIRED');
    if (input.email !== undefined && email && !emailOk(email)) return fail('EMAIL_INVALID');
    if (input.phone !== undefined && phone && !phoneOk(phone)) return fail('PHONE_INVALID');
    if (input.email !== undefined && email && takenBy('email', email, exceptId)) return fail('EMAIL_TAKEN');
    if (input.phone !== undefined && phone && takenBy('phone', phone, exceptId)) return fail('PHONE_TAKEN');
    var out = {};
    if (input.name  !== undefined) out.name  = name;
    if (input.email !== undefined) out.email = email;
    if (input.phone !== undefined) out.phone = phone;
    return { ok:true, clean:out };
  }

  /* ══════════════════ READ ══════════════════ */
  function list(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.view); if (!sc.ok) return sc;
    var drivers = [];
    try {
      drivers = (RAFPerm.getUsers() || [])
        .filter(function (u) { return u.accountType === DRIVER_TYPE && u.roleId === DRIVER_ROLE; })
        .map(view);
    } catch (e) { drivers = []; }
    return { ok:true, drivers:drivers, can:capabilities(sc.id) };
  }
  function get(driverId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.view); if (!sc.ok) return sc;
    var t = target(driverId); if (!t.ok) return t;
    return { ok:true, driver:view(t.user) };
  }
  /* what THIS manager may actually do — the UI renders from this, so a
     control is never offered to somebody whose permission would refuse it */
  function capabilities(id){
    function can(k){ try { return !!RAFPerm.can(id, k); } catch (e) { return false; } }
    return { view:can(PERM.view), create:can(PERM.create), edit:can(PERM.edit), status:can(PERM.status),
             permissions:{ view:PERM.view, create:PERM.create, edit:PERM.edit, status:PERM.status } };
  }

  /* ══════════════════ CREATE ══════════════════
     One driver employee, with the driver role, an id generated by RAFPerm and
     no store link. The caller cannot choose the id, the role, the account
     type, an override or a store — those are not parameters of this
     operation at all.

     RAF has no password or credential store anywhere (sign-in never verifies
     one), so no credential is created and none is faked: a created driver
     signs in exactly the way a seeded driver does. */
  function createDriver(data, opts){
    data = data || {}; opts = opts || {};
    if (!onlyKeys(data, ['name', 'email', 'phone'])) return fail('FIELD_NOT_ACCEPTED');
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.create); if (!sc.ok) return sc;
    if (data.name === undefined) return fail('NAME_REQUIRED');
    var v = validateProfile({ name:data.name, email:data.email, phone:data.phone }, null);
    if (!v.ok) return v;
    if (typeof RAFPerm.createAccount !== 'function') return fail('PERSIST_FAILED');

    var res = RAFPerm.createAccount({ name:v.clean.name, email:v.clean.email || '', phone:v.clean.phone || '',
                                      accountType:DRIVER_TYPE, roleId:DRIVER_ROLE });
    if (!res.ok) return fail('PERSIST_FAILED', { detail:res.reason });
    /* readback before anything is reported as done */
    var saved = driverRecord(res.user.id);
    if (!saved) return fail('PERSIST_FAILED', { detail:'readback_failed' });
    audit('driver.created', sc, saved.id, { name:saved.name });
    return { ok:true, driver:view(saved) };
  }

  /* ══════════════════ EDIT ══════════════════ */
  function updateDriver(driverId, data, opts){
    data = data || {}; opts = opts || {};
    if (!onlyKeys(data, ['name', 'email', 'phone'])) return fail('FIELD_NOT_ACCEPTED');
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.edit); if (!sc.ok) return sc;
    var t = target(driverId); if (!t.ok) return t;

    var v = validateProfile(data, driverId); if (!v.ok) return v;
    var before = t.user, patch = {}, changed = [];
    Object.keys(v.clean).forEach(function (k) {
      if (String(before[k] || '') !== v.clean[k]) { patch[k] = v.clean[k]; changed.push(k); }
    });
    if (!changed.length) return fail('NOTHING_CHANGED');

    var res = RAFPerm.updateProfile(driverId, patch);
    if (!res.ok) return fail('PERSIST_FAILED', { detail:res.reason });
    var saved = driverRecord(driverId);
    /* the record must still be the same driver, with the same authorisation */
    if (!saved || saved.roleId !== before.roleId || saved.accountType !== before.accountType
        || saved.storeSlug !== before.storeSlug || saved.status !== before.status)
      return fail('PERSIST_FAILED', { detail:'readback_mismatch' });
    audit('driver.updated', sc, driverId, { fields:changed });
    return { ok:true, driver:view(saved) };
  }

  /* ══════════════════ STATUS ══════════════════
     A suspended driver loses the app immediately — RAFDriver requires an
     active account for every read and every operation. What suspension does
     NOT do is touch a delivery the driver already holds: that ownership stays
     exactly where it is, and is reported back here so a human can deal with
     it. Re-activating restores access and nothing else; claims and the pool
     stay governed by the order's own fulfilment state. */
  function setStatus(driverId, status, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.status); if (!sc.ok) return sc;
    var t = target(driverId); if (!t.ok) return t;
    if (t.user.status === status) return fail(status === 'suspended' ? 'ALREADY_SUSPENDED' : 'ALREADY_ACTIVE');

    var held = liveDeliveryIds(driverId);
    var res = RAFPerm.setStatus(driverId, status);
    if (!res.ok) return fail('PERSIST_FAILED', { detail:res.reason });
    var saved = driverRecord(driverId);
    if (!saved || saved.status !== status) return fail('PERSIST_FAILED', { detail:'readback_mismatch' });
    audit(status === 'suspended' ? 'driver.suspended' : 'driver.reactivated', sc, driverId,
          { heldDeliveries:held.map(function (h) { return h.orderId; }) });
    /* Phase F: a suspended driver is operationally Unavailable too (never the
       other way round — reactivation restores the account only; availability
       is a separate management decision). Deliveries are still not touched. */
    if (status === 'suspended' && global.RAFRecordStore) {
      var cur = materialize(driverId, Date.now());
      if (cur.state === 'available') {
        var tr = transition(driverId, 'unavailable', { source:'account_suspended', reason:null,
          actor:{ type:'staff', id:sc.id, name:sc.name, roleId:sc.roleId } });
        if (tr.ok) avAudit({ action:'availability.changed', actor:{ id:sc.id }, source:'admin', key:tr.entryId,
          previousState:'available', newState:'unavailable', reason:'account_suspended', metadata:{ driverId:driverId, entryId:tr.entryId } });
      }
    }
    if (global.RAFEventBus) RAFEventBus.publish('driver.account.changed', { entityId:driverId, source:'admin', payload:{ status:status } });
    return { ok:true, driver:view(saved),
             /* deliveries left exactly as they were — suspension never
                automatically re-pools, reassigns, cancels or refunds; moving a
                held delivery is a separate Logistics decision (not yet built) */
             heldDeliveries:held };
  }
  function suspend(driverId, opts){ return setStatus(driverId, 'suspended', opts); }
  function reactivate(driverId, opts){ return setStatus(driverId, 'active', opts); }

  /* ══════════════════ AVAILABILITY + SCHEDULE + AUTO-OFFLINE (Phase F) ══════════════════
     OWNERSHIP DECISION. Operational availability and the working schedule are
     management-controlled facts about a driver employee, so they live here
     (RAFDriverManagement.availability) next to account status — but as a
     SEPARATE state: ACCOUNT STATUS (active/suspended, RAFPerm) is never merged
     with OPERATIONAL AVAILABILITY (available/unavailable, this module).
     RAFDriver stays the identity/claim authority and asks this module whether a
     driver may take NEW work; nothing here touches a delivery a driver holds.

     STATE  — RAFRecordStore state map 'driver_availability' (current) +
              append-only 'availability_history' (every transition, with its
              availability SESSION: a session starts when a driver becomes
              Available). A driver with no record takes RAFConfig
              'availability.defaultState'; the record is materialised (with an
              'initial_default' history entry) the first time it is evaluated.
     SCHEDULE — state map 'driver_schedules' + append-only 'schedule_history'.
              Structured weekly windows { day 0–6, start 'HH:MM', end 'HH:MM' }
              in RAFConfig 'availability.scheduleTimezone'. The schedule is
              DISPLAYED and stored; no outside-schedule transition is applied
              because none is defined.
     WORK / OVERTIME — measured from the start of the current availability
              session. At RAFConfig 'availability.basicWorkMinutes': overtime
              OFF → Unavailable for NEW tasks; overtime ON → continues; with a
              limit ('overtime.limitEnabled' + 'overtime.limitMinutes') →
              Unavailable when the limit is reached. Not configured → nothing
              is forced.
     AUTO-OFFLINE — Available + at least one eligible pool delivery NOW + no
              SUCCESSFUL claim (RAFDriver ownership record kind 'claim') since
              max(session start, last successful claim) for
              'availability.autoOfflineMinutes' → Unavailable (not disciplinary,
              account untouched). Skip, failed claims, views and logins do not
              reset it.
     EVERY automatic transition is deterministic (history ids keyed by session
     and reference) so two evaluators cannot record it twice. Evaluation runs
     whenever an authorised surface reads or acts, and at the page's next
     deadline. PROTOTYPE LIMIT: nothing evaluates while no authorised client is
     open — production needs a server scheduler.
     Nothing here cancels, reassigns, returns to pool, refunds or re-stocks. */
  var AV_ERRORS = {
    AV_FORBIDDEN:        { ar:'لا تملك صلاحية على توفر السائقين.',             en:'You do not have permission for driver availability.' },
    STATE_INVALID:       { ar:'حالة التوفر غير صالحة.',                         en:'That availability state is not valid.' },
    ALREADY_AVAILABLE:   { ar:'السائق متاح بالفعل.',                            en:'The driver is already available.' },
    ALREADY_UNAVAILABLE: { ar:'السائق غير متاح بالفعل.',                        en:'The driver is already unavailable.' },
    ACCOUNT_SUSPENDED:   { ar:'حساب السائق موقوف ولا يمكن جعله متاحًا.',         en:'The driver account is suspended and cannot be made available.' },
    REASON_REQUIRED:     { ar:'السبب إلزامي.',                                  en:'A reason is required.' },
    SCHEDULE_INVALID:    { ar:'الجدول غير صالح.',                               en:'The schedule is not valid.' },
    STATE_CHANGED:       { ar:'تغيّرت حالة التوفر أثناء العملية. أعد المحاولة.',  en:'Availability changed during the operation. Try again.' }
  };
  Object.keys(AV_ERRORS).forEach(function (k) { ERRORS[k] = AV_ERRORS[k]; });

  function cfgV(k){ return global.RAFConfig ? RAFConfig.value(k) : null; }
  function cfgS(k){ var g = global.RAFConfig ? RAFConfig.get(k) : null; return g ? { value:g.value, status:g.status, configured:!!g.configured } : { value:null, status:'not_configured', configured:false }; }
  function avMap(){ return global.RAFRecordStore ? RAFRecordStore.stateMap('driver_availability') : null; }
  function schMap(){ return global.RAFRecordStore ? RAFRecordStore.stateMap('driver_schedules') : null; }
  function avColl(n){ return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; }
  function avAudit(o){ if (!global.RAFAudit) return null; try { var r = RAFAudit.record(o); return (r && r.event && r.event.eventId) || null; } catch (e) { return null; } }
  function avEvent(type, driverId, payload, system){
    if (global.RAFEventBus) RAFEventBus.publish(type, { entityId:driverId, source:system ? 'system' : 'admin', system:!!system, payload:payload || {} });
  }
  function fmt(ms, lang){
    try { return new Date(ms).toLocaleString(lang === 'en' ? 'en-GB' : 'ar-KW-u-nu-latn', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kuwait' }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }
  var STATE_LABEL = { available:{ ar:'متاح', en:'Available' }, unavailable:{ ar:'غير متاح', en:'Unavailable' } };
  var SOURCE_LABEL = {
    initial_default:      { ar:'الحالة الافتراضية', en:'Default state' },
    management:           { ar:'قرار الإدارة', en:'Management decision' },
    driver:               { ar:'السائق نفسه', en:'The driver' },
    auto_offline:         { ar:'تلقائي — لا سحب ناجح خلال المدة المحددة', en:'Automatic — no successful claim within the configured time' },
    work_duration_reached:{ ar:'تلقائي — انتهت مدة العمل الأساسية (العمل الإضافي غير مفعّل)', en:'Automatic — normal working duration reached (overtime off)' },
    max_overtime_reached: { ar:'تلقائي — بلغ الحد الأقصى للعمل الإضافي', en:'Automatic — maximum overtime reached' },
    account_suspended:    { ar:'إيقاف الحساب', en:'Account suspended' }
  };

  /* recipients: the accounts that may manage driver availability (existing drivers.suspend) */
  function availabilityManagers(){
    var users = []; try { users = RAFPerm.getUsers() || []; } catch (e) {}
    return users.filter(function (u) { try { return u && u.status === 'active' && RAFPerm.can(u.id, PERM.status); } catch (e) { return false; } })
      .map(function (u) { return u.id; });
  }
  function avNotify(recipients, type, driverId, tail, message, skipId){
    if (!global.RAFNotify || !RAFNotify.create) return;
    var def = (RAFNotify.EVENT_TYPES || {})[type] || {};
    (recipients || []).forEach(function (uid) {
      if (!uid || uid === skipId) return;
      RAFNotify.create({ recipientUserId:uid, eventType:type, title:def.title, message:message || null,
        entityType:'driver', entityId:driverId, href:def.audience === 'driver' ? 'raf_driver.html' : 'raf_driver_management.html',
        source:'system', dedupeKey:type + '|' + tail });
    });
  }

  /* ---------- reads of other authorities ---------- */
  function lastSuccessfulClaimAt(driverId){
    var c = avColl('ownership'); if (!c) return null;
    var at = null;
    c.filter(function (r) { return r.kind === 'claim' && r.toDriverId === driverId; }).forEach(function (r) { if (at == null || r.at > at) at = r.at; });
    return at;
  }
  function eligiblePoolCount(){
    if (!global.RAFShop || !global.RAFDriver || !RAFDriver.stageOfOrder) return 0;
    try { return (RAFShop.Orders.all() || []).filter(function (o) { return o.snapshot && RAFDriver.stageOfOrder(o) === 'awaiting_driver'; }).length; }
    catch (e) { return 0; }
  }

  /* ---------- state ---------- */
  function rawState(driverId){ var m = avMap(); return m ? m.get(driverId) : null; }
  function newSessionId(driverId, at){ return 'ses-' + driverId + '-' + at.toString(36); }
  function materialize(driverId, now){
    var cur = rawState(driverId); if (cur) return cur;
    var def = cfgV('availability.defaultState'); if (def !== 'available' && def !== 'unavailable') def = 'unavailable';
    /* a suspended account is never Available, whatever the default */
    var acct = driverRecord(driverId); if (acct && acct.status !== 'active') def = 'unavailable';
    var rec = { state:def, since:now, sessionId:def === 'available' ? newSessionId(driverId, now) : null, source:'initial_default',
                reason:null, changedBy:{ type:'system' }, version:1 };
    var h = avColl('availability_history');
    var a = h ? h.append('entryId', { entryId:'avl|' + driverId + '|initial', driverId:driverId, from:null, to:def, at:now,
      source:'initial_default', reason:null, actor:{ type:'system' }, sessionId:rec.sessionId, version:1 }) : { ok:false };
    if (a.ok && a.duplicate) return rawState(driverId) || rec;      /* another evaluator materialised it */
    var m = avMap(); if (m) m.set(driverId, rec);
    return rec;
  }
  /* the one write path for every availability transition */
  function transition(driverId, to, ctx){
    var now = Date.now(), cur = materialize(driverId, now);
    if (cur.state === to) return fail(to === 'available' ? 'ALREADY_AVAILABLE' : 'ALREADY_UNAVAILABLE');
    var sessionId = to === 'available' ? newSessionId(driverId, now) : cur.sessionId;
    /* the history id is the VERSION SLOT: two writers (driver + management,
       two managers, two tabs) that both read version n race for the same
       'v n+1' entry and only the first append wins — the other gets
       STATE_CHANGED. The caller's own idempotency key is kept as `key`. */
    var entryId = 'avl|' + driverId + '|v' + (cur.version + 1);
    var key = ctx.entryId || entryId;
    var again = rawState(driverId);                                    /* re-read right before writing */
    if (!again || again.version !== cur.version || again.state !== cur.state) return fail('STATE_CHANGED');
    var h = avColl('availability_history');
    var a = h.append('entryId', { entryId:entryId, key:key, driverId:driverId, from:cur.state, to:to, at:now, source:ctx.source,
      reason:ctx.reason || null, actor:ctx.actor, sessionId:sessionId, previousSessionId:cur.sessionId,
      previousSince:cur.since, automatic:!!ctx.automatic, version:cur.version + 1 });
    if (!a.ok) return fail('PERSIST_FAILED');
    if (a.duplicate) return fail('STATE_CHANGED', { duplicate:true });
    var next = { state:to, since:now, sessionId:sessionId, source:ctx.source, reason:ctx.reason || null, changedBy:ctx.actor, version:cur.version + 1, entryId:entryId };
    /* a writer that lost the slot between our append and this set must not
       be overwritten: only write the state if it is still the one we read */
    var beforeSet = rawState(driverId);
    if (!beforeSet || beforeSet.version !== cur.version) return fail('STATE_CHANGED', { conflict:true });
    if (!avMap().set(driverId, next)) return fail('PERSIST_FAILED');
    /* post-write verification: our slot entry and our state must both be the
       ones that persisted (a non-transactional store can still interleave) */
    var mineNow = rawState(driverId), slot = h.all().filter(function (e) { return e.entryId === entryId; });
    if (!mineNow || mineNow.entryId !== entryId || slot.length !== 1 || slot[0].key !== key || slot[0].at !== now)
      return fail('STATE_CHANGED', { conflict:true });
    var payload = { from:cur.state, to:to, source:ctx.source, entryId:entryId };
    avEvent('driver.availability.changed', driverId, payload, ctx.automatic);
    avEvent(to === 'available' ? 'driver.availability.available' : 'driver.availability.unavailable', driverId, payload, ctx.automatic);
    return { ok:true, from:cur.state, to:to, at:now, entryId:entryId, state:next };
  }

  /* ---------- work session / overtime / auto-offline evaluation ---------- */
  function workOf(st, now){
    var base = cfgV('availability.basicWorkMinutes'), otOn = cfgV('overtime.enabled'),
        limOn = cfgV('overtime.limitEnabled'), lim = cfgV('overtime.limitMinutes');
    if (!st || st.state !== 'available' || !st.since) return { active:false, baselineMinutes:typeof base === 'number' ? base : null };
    var elapsed = now - st.since, out = { active:true, sessionStart:st.since, elapsedMs:elapsed,
      baselineMinutes:typeof base === 'number' ? base : null, overtimeEnabled:otOn, limitEnabled:limOn, limitMinutes:typeof lim === 'number' ? lim : null };
    if (typeof base !== 'number') { out.state = 'not_configured'; return out; }
    var baseMs = base * 60000;
    out.baselineEndsAt = st.since + baseMs;
    if (elapsed < baseMs) { out.state = 'normal'; return out; }
    if (otOn === false) { out.state = 'baseline_reached'; return out; }
    if (otOn !== true) { out.state = 'baseline_reached_not_configured'; return out; }
    out.overtimeMs = elapsed - baseMs;
    if (limOn === true && typeof lim === 'number') { out.limitEndsAt = st.since + baseMs + lim * 60000; out.state = elapsed >= baseMs + lim * 60000 ? 'limit_reached' : 'overtime'; }
    else out.state = 'overtime';
    return out;
  }
  function autoOfflineOf(driverId, st, now){
    var thr = cfgV('availability.autoOfflineMinutes');
    if (typeof thr !== 'number' || !st || st.state !== 'available') return { configured:typeof thr === 'number', applies:false, thresholdMinutes:thr };
    var claim = lastSuccessfulClaimAt(driverId), ref = Math.max(st.since || 0, claim || 0);
    return { configured:true, applies:true, thresholdMinutes:thr, referenceAt:ref, lastSuccessfulClaimAt:claim, dueAt:ref + thr * 60000, poolEligible:eligiblePoolCount() };
  }
  var SYSTEM = { type:'system' };
  function evaluateDriver(driverId, now){
    now = now || Date.now();
    var u = driverRecord(driverId); if (!u) return null;
    var st = materialize(driverId, now);
    /* reconciliation: an Available record on a suspended account (e.g. suspended
       where this module was not loaded) becomes Unavailable once, deterministically */
    if (u.status !== 'active' && st.state === 'available') {
      var tr = transition(driverId, 'unavailable', { source:'account_suspended', reason:null, actor:SYSTEM, automatic:true,
        entryId:'avl|' + driverId + '|' + st.sessionId + '|account_suspended' });
      if (tr.ok) avAudit({ action:'availability.changed', systemGenerated:true, source:'automation', key:tr.entryId,
        previousState:'available', newState:'unavailable', reason:'account_suspended', metadata:{ driverId:driverId } });
      return rawState(driverId);
    }
    if (u.status !== 'active' || st.state !== 'available') return st;
    /* work duration / overtime */
    var w = workOf(st, now), ot = avColl('overtime_events');
    if (w.state === 'overtime' || w.state === 'limit_reached') {
      var e1 = ot.append('overtimeId', { overtimeId:'ot|' + st.sessionId + '|entered', driverId:driverId, sessionId:st.sessionId, type:'entered',
        at:now, baselineEndsAt:w.baselineEndsAt, version:1 });
      if (e1.ok && !e1.duplicate) {
        avAudit({ action:'overtime.changed', systemGenerated:true, source:'automation', key:'ot:' + st.sessionId + ':entered',
          metadata:{ driverId:driverId, sessionId:st.sessionId, state:'overtime' } });
        avEvent('driver.overtime.changed', driverId, { state:'overtime', sessionId:st.sessionId }, true);
      }
    }
    var autoSource = null;
    if (w.state === 'baseline_reached') autoSource = 'work_duration_reached';
    if (w.state === 'limit_reached') {
      var e2 = ot.append('overtimeId', { overtimeId:'ot|' + st.sessionId + '|limit_reached', driverId:driverId, sessionId:st.sessionId, type:'limit_reached', at:now, version:1 });
      if (e2.ok && !e2.duplicate) {
        avAudit({ action:'overtime.changed', systemGenerated:true, source:'automation', key:'ot:' + st.sessionId + ':limit',
          metadata:{ driverId:driverId, sessionId:st.sessionId, state:'limit_reached', limitMinutes:w.limitMinutes } });
        avEvent('driver.overtime.changed', driverId, { state:'limit_reached', sessionId:st.sessionId }, true);
      }
      autoSource = 'max_overtime_reached';
    }
    if (autoSource) return automaticUnavailable(driverId, st, autoSource, 'avl|' + driverId + '|' + st.sessionId + '|' + autoSource, null);
    /* auto-offline */
    var ao = autoOfflineOf(driverId, st, now);
    if (ao.applies && now >= ao.dueAt && ao.poolEligible > 0)
      return automaticUnavailable(driverId, st, 'auto_offline', 'avl|' + driverId + '|' + st.sessionId + '|auto_offline|' + ao.referenceAt, ao);
    return st;
  }
  function automaticUnavailable(driverId, st, source, entryId, ao){
    var thr = cfgV('availability.autoOfflineMinutes');
    var reason = SOURCE_LABEL[source];
    var t = transition(driverId, 'unavailable', { source:source, reason:reason.en, actor:SYSTEM, automatic:true, entryId:entryId });
    if (!t.ok) return rawState(driverId);
    var u = driverRecord(driverId);
    avAudit({ action:source === 'auto_offline' ? 'availability.auto_offline' : 'availability.changed', systemGenerated:true, source:'automation',
      key:entryId, previousState:'available', newState:'unavailable', reason:reason.en,
      metadata:{ driverId:driverId, sessionId:st.sessionId, source:source, thresholdMinutes:source === 'auto_offline' ? thr : null,
                 referenceAt:ao ? ao.referenceAt : null, eligiblePool:ao ? ao.poolEligible : null, accountStatus:u && u.status } });
    var when = { ar:fmt(t.at, 'ar'), en:fmt(t.at, 'en') };
    if (source === 'auto_offline') {
      var msg = { ar:'لم يُسجَّل سحب ناجح خلال ' + thr + ' دقيقة مع وجود طلبات متاحة، فأصبحت غير متاح تلقائيًا (' + when.ar + '). هذا ليس إجراءً تأديبيًا.',
                  en:'No successful claim for ' + thr + ' min while deliveries were available, so you were set Unavailable automatically (' + when.en + '). This is not disciplinary.' };
      avNotify([driverId], 'driver.availability.auto_offline', driverId, entryId, msg);
      avNotify(availabilityManagers(), 'logistics.driver.auto_offline', driverId, entryId,
        { ar:(u ? u.name : driverId) + ' — تلقائي: لا سحب ناجح خلال ' + thr + ' دقيقة (' + when.ar + ')', en:(u ? u.name : driverId) + ' — automatic: no successful claim for ' + thr + ' min (' + when.en + ')' });
      avEvent('driver.auto_offline', driverId, { entryId:entryId, thresholdMinutes:thr }, true);
    } else {
      avNotify([driverId], 'driver.availability.changed', driverId, entryId, { ar:'غير متاح لمهام جديدة — ' + reason.ar + ' (' + when.ar + ')', en:'Unavailable for new tasks — ' + reason.en + ' (' + when.en + ')' });
      avNotify(availabilityManagers(), 'logistics.driver.availability_changed', driverId, entryId, { ar:(u ? u.name : driverId) + ' — ' + reason.ar, en:(u ? u.name : driverId) + ' — ' + reason.en });
    }
    return rawState(driverId);
  }
  function allDriverIds(){
    try { return (RAFPerm.getUsers() || []).filter(function (u) { return u.accountType === DRIVER_TYPE && u.roleId === DRIVER_ROLE; }).map(function (u) { return u.id; }); }
    catch (e) { return []; }
  }
  function evaluateAll(){ var now = Date.now(); allDriverIds().forEach(function (id) { evaluateDriver(id, now); }); }

  /* ---------- schedule ---------- */
  var HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  function validWindows(ws){
    if (!Array.isArray(ws)) return false;
    return ws.every(function (w) {
      return w && onlyKeys(w, ['day', 'start', 'end']) && Number.isInteger(w.day) && w.day >= 0 && w.day <= 6
        && HHMM.test(w.start) && HHMM.test(w.end) && w.end > w.start;
    });
  }
  function scheduleOf(driverId){ var m = schMap(); var s = m ? m.get(driverId) : null; return s || null; }
  function withinSchedule(sched, now){
    if (!sched || !sched.windows || !sched.windows.length) return null;
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone:sched.timezone || 'Asia/Kuwait', weekday:'short', hour:'2-digit', minute:'2-digit', hour12:false }).formatToParts(new Date(now));
      var wd = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[parts.filter(function (p) { return p.type === 'weekday'; })[0].value];
      var hm = parts.filter(function (p) { return p.type === 'hour'; })[0].value + ':' + parts.filter(function (p) { return p.type === 'minute'; })[0].value;
      return sched.windows.some(function (w) { return w.day === wd && hm >= w.start && hm < w.end; });
    } catch (e) { return null; }
  }

  /* ---------- views ---------- */
  function historyOf(driverId, limit){
    var h = avColl('availability_history'); if (!h) return [];
    var list = h.filter(function (e) { return e.driverId === driverId; }).sort(function (a, b) { return (b.at - a.at) || ((b.seq || 0) - (a.seq || 0)); });
    return typeof limit === 'number' ? list.slice(0, limit) : list;
  }
  function managerView(u, now){
    var st = evaluateDriver(u.id, now) || rawState(u.id);
    var sched = scheduleOf(u.id);
    return { driverId:u.id, name:u.name, accountStatus:u.status,
      availability:st ? { state:st.state, since:st.since, source:st.source, reason:st.reason, changedBy:st.changedBy, version:st.version } : null,
      eligibleForNewWork:u.status === 'active' && !!st && st.state === 'available',
      schedule:sched, withinSchedule:withinSchedule(sched, now),
      work:workOf(st, now), autoOffline:autoOfflineOf(u.id, st, now),
      liveDeliveries:liveDeliveryIds(u.id), history:historyOf(u.id, 20) };
  }
  function availabilityList(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.view); if (!sc.ok) return sc;
    var now = Date.now();
    var drivers = (RAFPerm.getUsers() || []).filter(function (u) { return u.accountType === DRIVER_TYPE && u.roleId === DRIVER_ROLE; })
      .map(function (u) { return managerView(u, now); });
    return { ok:true, drivers:drivers, canManage:(function(){ try { return !!RAFPerm.can(sc.id, PERM.status); } catch (e) { return false; } })(),
             config:availabilityConfig(), eligiblePool:eligiblePoolCount() };
  }
  function availabilityGet(driverId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.view); if (!sc.ok) return sc;
    var t = target(driverId); if (!t.ok) return t;
    var v = managerView(t.user, Date.now()); v.history = historyOf(driverId);
    v.scheduleHistory = avColl('schedule_history') ? avColl('schedule_history').filter(function (s) { return s.driverId === driverId; }) : [];
    return { ok:true, driver:v };
  }
  function availabilityConfig(){
    return { basicWorkMinutes:cfgS('availability.basicWorkMinutes'), autoOfflineMinutes:cfgS('availability.autoOfflineMinutes'),
             overtimeEnabled:cfgS('overtime.enabled'), overtimeLimitEnabled:cfgS('overtime.limitEnabled'), overtimeLimitMinutes:cfgS('overtime.limitMinutes'),
             managementReasonRequired:cfgS('availability.managementReasonRequired'), defaultState:cfgS('availability.defaultState'),
             unavailableReasons:cfgS('availability.unavailableReasons'), scheduleTimezone:cfgS('availability.scheduleTimezone') };
  }

  /* ---------- management mutations (drivers.suspend) ---------- */
  function setAvailability(driverId, data, opts){
    data = data || {}; opts = opts || {};
    if (!onlyKeys(data, ['state', 'reason'])) return fail('FIELD_NOT_ACCEPTED');
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.status); if (!sc.ok) return sc;
    var t = target(driverId); if (!t.ok) return t;
    if (data.state !== 'available' && data.state !== 'unavailable') return fail('STATE_INVALID');
    var reason = String(data.reason == null ? '' : data.reason).trim();
    if (cfgV('availability.managementReasonRequired') === true && !reason) return fail('REASON_REQUIRED');
    if (data.state === 'available' && t.user.status !== 'active') return fail('ACCOUNT_SUSPENDED');
    evaluateDriver(driverId);
    var tr = transition(driverId, data.state, { source:'management', reason:reason || null, actor:{ type:'staff', id:sc.id, name:sc.name, roleId:sc.roleId } });
    if (!tr.ok) return tr;
    avAudit({ action:'availability.changed', actor:{ id:sc.id }, source:'admin', key:tr.entryId, previousState:tr.from, newState:tr.to,
      reason:reason || null, metadata:{ driverId:driverId, entryId:tr.entryId, liveDeliveries:liveDeliveryIds(driverId).map(function (x) { return x.orderId; }) } });
    var when = { ar:fmt(tr.at, 'ar'), en:fmt(tr.at, 'en') };
    avNotify([driverId], 'driver.availability.changed', driverId, tr.entryId,
      { ar:'حالتك الآن: ' + STATE_LABEL[tr.to].ar + ' — اعتبارًا من ' + when.ar + (reason ? ' — السبب: ' + reason : ''),
        en:'You are now ' + STATE_LABEL[tr.to].en + ' — effective ' + when.en + (reason ? ' — reason: ' + reason : '') });
    return { ok:true, driver:managerView(driverRecord(driverId), Date.now()), liveDeliveries:liveDeliveryIds(driverId) };
  }
  function setSchedule(driverId, data, opts){
    data = data || {}; opts = opts || {};
    if (!onlyKeys(data, ['windows'])) return fail('FIELD_NOT_ACCEPTED');
    if (!onlyKeys(opts, ['actor'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = manager(opts.actor, PERM.status); if (!sc.ok) return sc;
    var t = target(driverId); if (!t.ok) return t;
    if (!validWindows(data.windows)) return fail('SCHEDULE_INVALID');
    var tz = cfgV('availability.scheduleTimezone'); if (!tz) return fail('SCHEDULE_INVALID', { detail:'timezone_not_configured' });
    var prev = scheduleOf(driverId), now = Date.now(), id = RAFRecordStore.makeId('sch');
    var windows = data.windows.map(function (w) { return { day:w.day, start:w.start, end:w.end }; })
      .sort(function (a, b) { return (a.day - b.day) || (a.start < b.start ? -1 : 1); });
    var rec = { scheduleId:id, windows:windows, timezone:tz, updatedAt:now, updatedBy:{ id:sc.id, name:sc.name }, version:(prev ? prev.version : 0) + 1 };
    var h = avColl('schedule_history').append('scheduleId', Object.assign({ driverId:driverId, previousScheduleId:prev ? prev.scheduleId : null }, rec));
    if (!h.ok) return fail('PERSIST_FAILED');
    if (!schMap().set(driverId, rec)) return fail('PERSIST_FAILED');
    avAudit({ action:'schedule.changed', actor:{ id:sc.id }, source:'admin', key:id,
      metadata:{ driverId:driverId, scheduleId:id, windows:windows, previousScheduleId:prev ? prev.scheduleId : null } });
    avNotify([driverId], 'driver.schedule.changed', driverId, id);
    avEvent('driver.schedule.changed', driverId, { scheduleId:id });
    return { ok:true, schedule:rec };
  }

  /* ---------- the driver's own actions (RAFDriver identity) ---------- */
  function driverScope(){
    if (!global.RAFDriver || !RAFDriver.scope) return fail('AV_FORBIDDEN');
    var sc = RAFDriver.scope(); return sc.ok ? sc : fail('AV_FORBIDDEN');
  }
  function mine(){
    var sc = driverScope(); if (!sc.ok) return sc;
    var now = Date.now(), st = evaluateDriver(sc.id, now) || rawState(sc.id), sched = scheduleOf(sc.id);
    var mineHist = historyOf(sc.id, 1)[0] || null;
    /* no overtime counter, no management internals — state, why, schedule */
    return { ok:true, state:st ? st.state : null, since:st ? st.since : null, source:st ? st.source : null,
             sourceLabel:st && SOURCE_LABEL[st.source] ? SOURCE_LABEL[st.source] : null,
             reason:st && (st.source === 'driver' || st.source === 'management') ? st.reason : null,
             schedule:sched ? { windows:sched.windows, timezone:sched.timezone } : null,
             withinSchedule:withinSchedule(sched, now), canSetUnavailable:!!st && st.state === 'available',
             liveDeliveries:liveDeliveryIds(sc.id).length, lastChangeAt:mineHist ? mineHist.at : null };
  }
  function setSelfUnavailable(data){
    data = data || {};
    if (!onlyKeys(data, ['reason'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = driverScope(); if (!sc.ok) return sc;
    var reason = String(data.reason == null ? '' : data.reason).trim();
    if (!reason) return fail('REASON_REQUIRED');
    evaluateDriver(sc.id);
    var tr = transition(sc.id, 'unavailable', { source:'driver', reason:reason, actor:{ type:'driver', id:sc.id, name:sc.name, roleId:sc.roleId } });
    if (!tr.ok) return tr;
    avAudit({ action:'availability.self_unavailable', actor:{ id:sc.id }, source:'driver', key:tr.entryId, previousState:tr.from, newState:tr.to,
      reason:reason, metadata:{ driverId:sc.id, entryId:tr.entryId, liveDeliveries:liveDeliveryIds(sc.id).map(function (x) { return x.orderId; }) } });
    avNotify(availabilityManagers(), 'logistics.driver.availability_changed', sc.id, tr.entryId,
      { ar:sc.name + ' أصبح غير متاح — السبب: ' + reason, en:sc.name + ' is now Unavailable — reason: ' + reason });
    return { ok:true, availability:mine() };
  }

  /* ---------- used by RAFDriver (claim / dispatch targets) ---------- */
  function eligibleForNewWork(driverId){
    /* only the driver themself (claim) or staff who can see drivers (dispatch,
       reassignment, eligible-driver lists) may ask */
    var d = driverScope();
    if (!(d.ok && d.id === driverId) && !manager(null, PERM.view).ok) return { eligible:false, reason:'forbidden' };
    var u = driverRecord(driverId); if (!u) return { eligible:false, reason:'not_a_driver' };
    if (u.status !== 'active') return { eligible:false, reason:'account_suspended' };
    var st = evaluateDriver(driverId, Date.now());
    if (!st || st.state !== 'available') return { eligible:false, reason:'unavailable', source:st ? st.source : null };
    return { eligible:true };
  }
  /* a successful claim is the ONLY reset: the ownership record already exists;
     this only announces the new reference for live views */
  function claimSucceeded(driverId){
    var d = driverScope(); if (!d.ok || d.id !== driverId) return;      /* only the claiming driver's own session */
    var last = lastSuccessfulClaimAt(driverId); if (!last || Date.now() - last > 60000) return;
    avEvent('driver.auto_offline.reset', driverId, { lastSuccessfulClaimAt:lastSuccessfulClaimAt(driverId) });
  }
  function evaluatePublic(){
    var d = driverScope();
    if (d.ok) { evaluateDriver(d.id); return { ok:true }; }
    var sc = manager(null, PERM.view); if (!sc.ok) return fail('AV_FORBIDDEN');
    evaluateAll(); return { ok:true };
  }
  /* the next instant a work/overtime/auto-offline threshold falls due (for a
     page's single deadline timer; not a synchronisation poll) */
  function nextDeadline(){
    var now = Date.now(), next = null, d = driverScope(), ids;
    if (d.ok) ids = [d.id]; else { var sc = manager(null, PERM.view); if (!sc.ok) return null; ids = allDriverIds(); }
    function consider(t){ if (t && t > now && (next == null || t < next)) next = t; }
    ids.forEach(function (id) {
      var st = rawState(id); if (!st || st.state !== 'available') return;
      var w = workOf(st, now), ao = autoOfflineOf(id, st, now);
      consider(w.baselineEndsAt); consider(w.limitEndsAt); if (ao.applies) consider(ao.dueAt);
    });
    return next;
  }

  var AVAILABILITY = {
    STATE_LABEL:STATE_LABEL, SOURCE_LABEL:SOURCE_LABEL,
    list:availabilityList, get:availabilityGet, config:availabilityConfig,
    setAvailability:setAvailability, setSchedule:setSchedule,
    mine:mine, setSelfUnavailable:setSelfUnavailable,
    eligibleForNewWork:eligibleForNewWork, claimSucceeded:claimSucceeded,
    evaluate:evaluatePublic, nextDeadline:nextDeadline
  };

  global.RAFDriverManagement = {
    PERM:PERM, ERRORS:ERRORS,
    list:list, get:get, capabilities:capabilities,
    createDriver:createDriver, updateDriver:updateDriver,
    suspend:suspend, reactivate:reactivate,
    availability:AVAILABILITY
  };
})(window);
