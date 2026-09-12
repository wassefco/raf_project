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
 * it never re-pools, reassigns, cancels or refunds a delivery they already
 * hold. An account decision must not silently mutate delivery ownership, so
 * the situation is surfaced to management instead.
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
  function sessionId(){
    try { var u = global.RAFPerm && RAFPerm.currentUser(); return (u && u.id) || null; } catch (e) { return null; }
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
    return { ok:true, driver:view(saved),
             /* deliveries left exactly as they were — no re-pooling, no
                reassignment, no cancellation, no refund */
             heldDeliveries:held };
  }
  function suspend(driverId, opts){ return setStatus(driverId, 'suspended', opts); }
  function reactivate(driverId, opts){ return setStatus(driverId, 'active', opts); }

  global.RAFDriverManagement = {
    PERM:PERM, ERRORS:ERRORS,
    list:list, get:get, capabilities:capabilities,
    createDriver:createDriver, updateDriver:updateDriver,
    suspend:suspend, reactivate:reactivate
  };
})(window);
