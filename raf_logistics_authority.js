/* ============================================================================
 * RAF Marketplace — LOGISTICS AUTHORITY  (RAFLogistics · shared, headless)
 * ----------------------------------------------------------------------------
 * The ONE business authority for Logistics Management. Logistics is a single
 * administrative domain: driver administration and order-to-driver assignment
 * are two responsibilities of that one domain, not separate systems. There is
 * no RAFDriver and no RAFDriverManagement — those were decommissioned and are
 * not restored; this authority is the rebuilt home for those decisions.
 *
 * IT OWNS THE DECISIONS; IT OWNS NO STORAGE
 *   identity / accounts → RAFPerm  ·  order lifecycle → RAFOrderEngine
 *   the order's own record → RAFOrderSnapshot  ·  history → RAFAudit
 * A driver IS an ordinary RAF account whose role is `driver`. There is no
 * second driver database and no Logistics copy of a user or an order. The
 * assignment itself lives where the order already keeps it — the snapshot's
 * `fulfilment` record — so no dedicated assignment store is invented either.
 *
 * WHY THIS LAYER EXISTS — RAFPerm.setStatus/updateProfile/createAccount are
 * deliberately narrow storage primitives that state, in their own header, that
 * "authorisation itself is NOT decided here: the calling authority proves the
 * actor may do this first". This module is that authority. A page must never
 * call those primitives directly.
 *
 * IDENTITY — the actor is ALWAYS the signed-in session (RAFPerm.currentUser).
 * A caller-supplied actorId, driverId-as-actor or role claim is never trusted,
 * and a suspended account is refused before anything else is checked.
 *
 * AUTHORISATION IS ENFORCED HERE, NOT IN THE PAGE. Every operation below
 * re-proves the permission at the moment it runs, so a page that renders a
 * button it should not have rendered still cannot perform the action.
 *
 * WHAT RAF CANNOT REPRESENT, THIS MODULE DOES NOT INVENT
 *   · APPROVAL — the account model's status vocabulary is exactly
 *     ['active','suspended']. There is no pending/approved state, so a driver
 *     cannot be "approved" independently of being active. `drivers.approve`
 *     exists as a key but has no state to act on; approveSupported() reports
 *     false and no approval operation is offered.
 *   · availability, shifts, location, zones, distance, ratings, performance,
 *     vehicle or licence data — none exists in the account model. None is
 *     stored, derived, displayed or filtered on.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFLogistics) return;

  var VERSION = 1;

  /* the existing permission keys this domain runs on — no key is invented here;
     `drivers.create`, `drivers.edit` and `drivers.assign` are registered in the
     central permission catalogue (raf_permissions.js), like every other key */
  var P = {
    VIEW:    'drivers.view',
    CREATE:  'drivers.create',
    EDIT:    'drivers.edit',
    SUSPEND: 'drivers.suspend',
    APPROVE: 'drivers.approve',
    ASSIGN:  'drivers.assign'
  };

  var DRIVER_ROLE = 'driver';
  var ACCOUNT_TYPE = 'driver';
  /* RAFPerm's own account statuses. This module adds none. */
  var STATUS = { ACTIVE: 'active', SUSPENDED: 'suspended' };
  /* the only profile fields the account model holds and this domain may edit */
  var PROFILE_FIELDS = ['name', 'email', 'phone'];
  var LIMITS = { name: 80, email: 120, phone: 24, reason: 300 };

  function isEn(){
    var r = (global.document && (document.getElementById('htmlRoot') || document.documentElement));
    return !!(r && r.lang === 'en');
  }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    UNAUTHENTICATED:   { ar:'يلزم تسجيل الدخول.',                         en:'Sign-in is required.' },
    ACTOR_INACTIVE:    { ar:'لا يمكن تنفيذ الإجراء بحساب موقوف.',          en:'A suspended account cannot perform this action.' },
    FORBIDDEN:         { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',           en:'You do not have permission for this action.' },
    FIELD_NOT_ACCEPTED:{ ar:'تحتوي البيانات على حقول غير مقبولة.',         en:'The request contains fields that are not accepted.' },
    INVALID:           { ar:'راجع الحقول المطلوبة.',                       en:'Check the required fields.' },
    NAME_REQUIRED:     { ar:'اسم السائق مطلوب.',                           en:'The driver name is required.' },
    EMAIL_TAKEN:       { ar:'هذا البريد مستخدم في حساب آخر.',              en:'That email already belongs to another account.' },
    DRIVER_NOT_FOUND:  { ar:'السائق غير موجود.',                           en:'The driver could not be found.' },
    NOT_A_DRIVER:      { ar:'هذا الحساب ليس حساب سائق.',                   en:'That account is not a driver account.' },
    ALREADY_ACTIVE:    { ar:'حساب السائق نشط بالفعل.',                     en:'The driver account is already active.' },
    ALREADY_SUSPENDED: { ar:'حساب السائق موقوف بالفعل.',                   en:'The driver account is already suspended.' },
    DRIVER_SUSPENDED:  { ar:'لا يمكن التعيين إلى سائق موقوف.',             en:'A suspended driver cannot be assigned an order.' },
    HAS_ACTIVE_ORDERS: { ar:'لا يمكن إيقاف السائق وهو مسؤول عن طلبات جارية.',
                         en:'The driver cannot be suspended while responsible for orders in progress.' },
    ORDER_NOT_FOUND:   { ar:'الطلب غير موجود.',                            en:'The order could not be found.' },
    NO_SNAPSHOT:       { ar:'سجل الطلب غير مكتمل، لا يمكن التعيين.',        en:'The order record is incomplete; it cannot be assigned.' },
    ORDER_CLOSED:      { ar:'الطلب غير جارٍ.',                             en:'The order is not in progress.' },
    NOT_READY:         { ar:'الطلب غير جاهز للتعيين بعد.',                 en:'The order is not ready for assignment yet.' },
    ALREADY_ASSIGNED:  { ar:'الطلب معيَّن إلى سائق بالفعل.',               en:'The order is already assigned to a driver.' },
    NOT_ASSIGNED:      { ar:'الطلب غير معيَّن إلى سائق.',                  en:'The order is not assigned to a driver.' },
    REASON_REQUIRED:   { ar:'السبب مطلوب.',                                en:'A reason is required.' },
    APPROVAL_UNSUPPORTED:{ ar:'اعتماد السائق غير مدعوم في نموذج الحسابات الحالي.',
                           en:'Driver approval is not supported by the current account model.' },
    ENGINE_REFUSED:    { ar:'رفض سجل الطلب هذا الإجراء.',                  en:'The order record refused this operation.' },
    /* driver applications */
    CONSENT_REQUIRED:  { ar:'يجب الموافقة على شروط وأحكام رف قبل الإرسال.',  en:'RAF’s terms must be accepted before submitting.' },
    DUPLICATE_APPLICATION:{ ar:'يوجد طلب انضمام قيد المراجعة بنفس البيانات.', en:'An application with these details is already under review.' },
    APPLICATION_NOT_FOUND:{ ar:'طلب الانضمام غير موجود.',                   en:'The application could not be found.' },
    APPLICATION_DECIDED:{ ar:'تم البت في هذا الطلب بالفعل.',                en:'This application has already been decided.' },
    ALREADY_APPROVED:  { ar:'تم قبول هذا الطلب بالفعل.',                    en:'This application has already been approved.' },
    ACCOUNT_CONFLICT:  { ar:'يوجد حساب رف بنفس البريد لكنه ليس حساب سائق.',  en:'A RAF account with this email exists but is not a driver account.' },
    NOTE_REQUIRED:     { ar:'اكتب ملاحظة المراجعة.',                        en:'A review note is required.' },
    PERSIST_FAILED:    { ar:'تعذّر الحفظ.',                                en:'Could not save.' },
    UNAVAILABLE:       { ar:'وحدات رف المطلوبة غير متاحة.',                en:'The required RAF modules are unavailable.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function text(v){ return typeof v === 'string' ? v.trim() : ''; }
  function badKeys(o, allowed){
    return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; });
  }

  function Perm(){ return global.RAFPerm || null; }
  function Engine(){ return global.RAFOrderEngine || null; }
  function Snap(){ return global.RAFOrderSnapshot || null; }
  function Shop(){ return global.RAFShop || null; }

  /* ══════════════════════ IDENTITY ══════════════════════
     Never the caller's word. The session, or nobody. */
  function actor(){
    var P0 = Perm();
    if (!P0) return fail('UNAVAILABLE');
    var u = null;
    try { u = P0.currentUser ? P0.currentUser() : null; } catch (e) { u = null; }
    if (!u || !u.id) return fail('UNAUTHENTICATED');
    if (u.status !== STATUS.ACTIVE) return fail('ACTOR_INACTIVE');
    return { ok:true, id:u.id, name:u.name || u.id, roleId:u.roleId || null };
  }
  function can(userId, key){
    try { return !!(Perm() && Perm().can(userId, key)); } catch (e) { return false; }
  }
  /* an actor who holds a specific Logistics permission, proved here and now */
  function staff(key){
    var a = actor(); if (!a.ok) return a;
    if (!can(a.id, key)) return fail('FORBIDDEN', { required:key });
    return a;
  }

  /* ══════════════════════ AUDIT ══════════════════════
     The existing RAFAudit, through its one write path. This module keeps no
     history of its own and never edits an existing record. */
  function audit(action, a, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try {
      var o = { action:action, actor:{ id:a.id }, source:'admin' };
      for (var k in (extra || {})) if (extra.hasOwnProperty(k)) o[k] = extra[k];
      return RAFAudit.record(o);
    } catch (e) { return null; }
  }

  /* ══════════════════════ DRIVER READS ══════════════════════ */
  function rawDriver(driverId){
    var P0 = Perm(); if (!P0) return null;
    var u = null; try { u = P0.getUser(driverId); } catch (e) { u = null; }
    return (u && u.roleId === DRIVER_ROLE) ? u : null;
  }
  /* every order this driver is currently responsible for, read from the order's
     OWN record. Logistics keeps no driver-owned order list. */
  function assignmentIndex(){
    var idx = {}, S = Snap(), SH = Shop();
    if (!SH || !SH.Orders) return idx;
    var orders = [];
    try { orders = SH.Orders.all() || []; } catch (e) { orders = []; }
    orders.forEach(function (o) {
      if (!o || o.status !== 'progress') return;         /* closed orders are history */
      var snap = null;
      try { snap = S ? S.of(o.id) : null; } catch (e) { snap = null; }
      var f = (snap && snap.fulfilment) || {};
      if (!f.driverId) return;
      (idx[f.driverId] = idx[f.driverId] || []).push({
        orderId:o.id, assignedAt:f.assignedAt || null, pickedUpAt:f.pickedUpAt || null,
        storeSlug:snap.storeSlug || null
      });
    });
    return idx;
  }
  function assignmentsOf(driverId){
    var a = staff(P.VIEW); if (!a.ok) return a;
    if (!rawDriver(driverId)) return fail('DRIVER_NOT_FOUND');
    return { ok:true, items:(assignmentIndex()[driverId] || []) };
  }
  /* the presented driver — the display identity and the account state.
     Contact fields travel only when the caller holds the edit permission, so a
     read-only surface can never show a driver's phone or email. */
  function present(u, idx, withContact){
    var list = idx[u.id] || [];
    var out = {
      driverId:u.id, name:u.name || '', status:u.status || null,
      regDate:u.regDate || null,
      activeOrders:list.length, orders:copy(list),
      assignable:(u.status === STATUS.ACTIVE)
    };
    if (withContact) { out.email = u.email || ''; out.phone = u.phone || ''; }
    /* the Logistics profile, when this driver has one. It is never the
       identity — that stays on the account above. */
    var pr = profileOf(u.id);
    out.profile = pr ? copy(pr) : null;
    out.applicationId = pr ? (pr.applicationId || null) : null;
    out.origin = pr ? (pr.source || null) : null;
    return out;
  }
  function listDrivers(filters){
    filters = filters || {};
    var bad = badKeys(filters, ['status', 'q', 'from', 'to', 'assignableOnly']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.VIEW); if (!a.ok) return a;
    var P0 = Perm(), users = [];
    try { users = P0.getUsers() || []; } catch (e) { users = []; }
    var idx = assignmentIndex();
    var withContact = can(a.id, P.EDIT);
    var q = text(filters.q).toLowerCase();

    var items = users.filter(function (u) { return u && u.roleId === DRIVER_ROLE; })
      .filter(function (u) {
        if (filters.status && u.status !== filters.status) return false;
        if (filters.assignableOnly && u.status !== STATUS.ACTIVE) return false;
        if (filters.from && (!u.regDate || String(u.regDate) < filters.from)) return false;
        if (filters.to && (!u.regDate || String(u.regDate) > filters.to)) return false;
        /* the name is the only searchable field: a driver must not be findable
           by a private contact detail */
        if (q && String(u.name || '').toLowerCase().indexOf(q) < 0) return false;
        return true;
      })
      .map(function (u) { return present(u, idx, withContact); })
      .sort(function (x, y) { return String(x.name).localeCompare(String(y.name)); });
    return { ok:true, items:items, contactVisible:withContact };
  }
  function getDriver(driverId){
    var a = staff(P.VIEW); if (!a.ok) return a;
    var u = rawDriver(driverId);
    if (!u) return fail(Perm() && Perm().getUser(driverId) ? 'NOT_A_DRIVER' : 'DRIVER_NOT_FOUND');
    return { ok:true, driver:present(u, assignmentIndex(), can(a.id, P.EDIT)) };
  }

  /* ══════════════════════ DRIVER ADMINISTRATION ══════════════════════ */
  function validProfile(patch, required){
    var errors = [];
    var name = text(patch.name), email = text(patch.email), phone = text(patch.phone);
    if (required && !name) errors.push({ field:'name' });
    if (name && name.length > LIMITS.name) errors.push({ field:'name' });
    if (email && (email.length > LIMITS.email || email.indexOf('@') < 1)) errors.push({ field:'email' });
    if (phone && phone.length > LIMITS.phone) errors.push({ field:'phone' });
    return errors;
  }
  function emailTaken(email, exceptId){
    if (!email) return false;
    var users = [];
    try { users = Perm().getUsers() || []; } catch (e) { users = []; }
    return users.some(function (u) {
      return u && u.id !== exceptId && text(u.email).toLowerCase() === email.toLowerCase();
    });
  }
  /* A driver account is an ordinary RAF account. This module decides that it
     may be created and with which role; RAFPerm creates and stores it.

     DIRECT LOGISTICS CREATION carries the same profile an approved application
     would leave behind — civil id, nationality, area, vehicle and document
     metadata — so an administratively created driver is not a thinner record
     than a recruited one. It creates NO application and asks for NO consent:
     consent belongs to the public website application alone.

     REQUIRED IS WHAT WAS ALWAYS REQUIRED. The account model needs a name and
     nothing else, so only the name is mandatory here; every profile field is
     validated when given and simply absent when not. No new mandatory field is
     introduced for a path that never had one. */
  var CREATE_KEYS = ['name', 'firstName', 'lastName', 'email', 'phone',
                     'civilId', 'nationality', 'area', 'vehicle', 'documents'];
  function composedName(input){
    var first = text(input.firstName), last = text(input.lastName);
    if (first || last) return (first + ' ' + last).trim();
    return text(input.name);
  }
  /* the vehicle block, validated with the same limits the application uses.
     Nothing outside the application's own vehicle shape is accepted. */
  function normaliseVehicle(v){
    if (v === undefined) return { ok:true, value:undefined };
    v = v || {};
    var bad = badKeys(v, ['type', 'make', 'model', 'year', 'color', 'plate']);
    if (bad.length) return { ok:false, fields:bad };
    var any = false, out = {};
    ['type','make','model','color'].forEach(function (k) {
      out[k] = text(v[k]).slice(0, APP_LIMITS.text) || null; if (out[k]) any = true; });
    out.year = text(v.year).slice(0, 8) || null; if (out.year) any = true;
    out.plate = text(v.plate).slice(0, APP_LIMITS.plate) || null; if (out.plate) any = true;
    return { ok:true, value:any ? out : undefined };
  }
  function createDriver(input){
    input = input || {};
    var bad = badKeys(input, CREATE_KEYS);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.CREATE); if (!a.ok) return a;

    var name = composedName(input);
    /* the one genuine requirement, unchanged */
    var errors = validProfile({ name:name, email:input.email, phone:input.phone }, true);
    if (errors.length) return fail(name ? 'INVALID' : 'NAME_REQUIRED', { errors:errors });
    var email = text(input.email);
    if (emailTaken(email, null)) return fail('EMAIL_TAKEN');

    var veh = normaliseVehicle(input.vehicle);
    if (!veh.ok) return fail('FIELD_NOT_ACCEPTED', { fields:veh.fields });

    var r = null;
    try {
      r = Perm().createAccount({
        name:name, email:email, phone:text(input.phone),
        /* the role and account type are chosen HERE, by the authority, and are
           never forwarded from a caller */
        accountType:ACCOUNT_TYPE, roleId:DRIVER_ROLE
      });
    } catch (e) { r = null; }
    if (!r || !r.ok) return fail('PERSIST_FAILED', { reason:r && r.reason });

    /* the Logistics profile, when anything was given for it. Document metadata
       goes through the SAME docMeta() the public application uses, so this path
       stores no more and no less than that one. */
    var docs = null, given = input.documents || {}, anyDoc = false;
    DOC_KEYS.forEach(function (k) {
      var m = docMeta(given[k]);
      if (m) anyDoc = true;
      (docs = docs || {})[k] = m;
    });
    var prof = {
      source:APP_SOURCE.LOGISTICS,
      /* a directly created driver has no application, and none is faked */
      applicationId:null, applicationRef:null, consent:null
    };
    if (text(input.civilId))     prof.civilId = text(input.civilId).slice(0, APP_LIMITS.civilId);
    if (text(input.nationality)) prof.nationality = text(input.nationality).slice(0, APP_LIMITS.text);
    if (text(input.area))        prof.area = text(input.area).slice(0, APP_LIMITS.text);
    if (veh.value !== undefined) prof.vehicle = veh.value;
    if (anyDoc)                  prof.documents = docs;
    writeProfile(r.user.id, prof);

    audit('logistics.driver_created', a, {
      key:r.user.id, newState:r.user.status,
      metadata:{ driverId:r.user.id, roleId:DRIVER_ROLE, source:APP_SOURCE.LOGISTICS }
    });
    return { ok:true, driver:present(r.user, assignmentIndex(), true) };
  }
  /* Only the three fields the account model actually holds. Role, permissions,
     status, store link and identity are unreachable through here — RAFPerm's
     updateProfile refuses every other field by construction. */
  function updateDriver(driverId, patch){
    patch = patch || {};
    var bad = badKeys(patch, PROFILE_FIELDS);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.EDIT); if (!a.ok) return a;
    var u = rawDriver(driverId); if (!u) return fail('DRIVER_NOT_FOUND');

    var errors = validProfile(patch, false);
    if (errors.length) return fail('INVALID', { errors:errors });
    var email = text(patch.email);
    if (email && emailTaken(email, driverId)) return fail('EMAIL_TAKEN');

    var changed = {}, before = {};
    PROFILE_FIELDS.forEach(function (f) {
      if (patch[f] === undefined) return;
      var v = text(patch[f]);
      if (v !== text(u[f])) { changed[f] = v; before[f] = text(u[f]); }
    });
    if (!Object.keys(changed).length) return { ok:true, unchanged:true, driver:present(u, assignmentIndex(), true) };

    var r = null;
    try { r = Perm().updateProfile(driverId, changed); } catch (e) { r = null; }
    if (!r || !r.ok) return fail('PERSIST_FAILED', { reason:r && r.reason });

    audit('logistics.driver_updated', a, {
      key:driverId + ':' + Date.now(),
      metadata:{ driverId:driverId, changed:Object.keys(changed).join(',') }
    });
    return { ok:true, changed:Object.keys(changed), driver:present(r.user, assignmentIndex(), true) };
  }
  /* SUSPENSION SAFETY — a driver carrying orders in progress is not suspended
     out from under them. This is decidable from authoritative data: the orders
     name the driver in their own fulfilment record. */
  function suspendDriver(driverId, input){
    input = input || {};
    var bad = badKeys(input, ['reason']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.SUSPEND); if (!a.ok) return a;
    var u = rawDriver(driverId); if (!u) return fail('DRIVER_NOT_FOUND');
    if (u.status === STATUS.SUSPENDED) return fail('ALREADY_SUSPENDED');

    var held = assignmentIndex()[driverId] || [];
    if (held.length) return fail('HAS_ACTIVE_ORDERS', {
      activeOrders:held.length, orders:held.map(function (x) { return x.orderId; }) });

    var reason = text(input.reason);
    var r = null;
    try { r = Perm().setStatus(driverId, STATUS.SUSPENDED); } catch (e) { r = null; }
    if (!r || !r.ok) return fail('PERSIST_FAILED', { reason:r && r.reason });

    audit('logistics.driver_suspended', a, {
      key:driverId + ':suspended:' + Date.now(),
      previousState:STATUS.ACTIVE, newState:STATUS.SUSPENDED,
      reason:reason || null, metadata:{ driverId:driverId }
    });
    return { ok:true, driver:present(r.user, assignmentIndex(), can(a.id, P.EDIT)) };
  }
  function reactivateDriver(driverId){
    var a = staff(P.SUSPEND); if (!a.ok) return a;
    var u = rawDriver(driverId); if (!u) return fail('DRIVER_NOT_FOUND');
    if (u.status === STATUS.ACTIVE) return fail('ALREADY_ACTIVE');

    var r = null;
    try { r = Perm().setStatus(driverId, STATUS.ACTIVE); } catch (e) { r = null; }
    if (!r || !r.ok) return fail('PERSIST_FAILED', { reason:r && r.reason });

    audit('logistics.driver_reactivated', a, {
      key:driverId + ':active:' + Date.now(),
      previousState:STATUS.SUSPENDED, newState:STATUS.ACTIVE,
      metadata:{ driverId:driverId }
    });
    return { ok:true, driver:present(r.user, assignmentIndex(), can(a.id, P.EDIT)) };
  }
  /* APPROVAL — approving a driver APPLICATION is real and lives below. What is
     still not representable is approving an existing ACCOUNT: the account
     status vocabulary is ['active','suspended'] with no pending state, so an
     already-created account has nothing for an approval to move. */
  function approveSupported(){
    return { supported:true, scope:'application',
      reason:T('الاعتماد يتم على طلب الانضمام، لا على حساب قائم — نموذج الحسابات لا يحتوي حالة "بانتظار الاعتماد".',
               'Approval applies to a join application, not to an existing account — the account model has no "pending approval" state.') };
  }
  function approveDriver(){
    return fail('APPROVAL_UNSUPPORTED');
  }

  /* ══════════════════════ ORDER ASSIGNMENT ══════════════════════
     The one assignment path in RAF. Dispatch and Drivers both call this; no
     surface writes an assignment of its own.

     It does not invent an order state: RAFOrderEngine.driverAssigned performs
     the READY → WAITING_DRIVER transition that already exists, and refuses
     anything else. The driver's identity is then recorded where the order
     already keeps it — the snapshot's fulfilment record — through
     RAFOrderSnapshot.update, the approved update path. If that write fails the
     lifecycle move is rolled back, so an order is never left in a delivery
     state with no driver behind it. */
  function orderOf(orderId){
    var SH = Shop();
    if (!SH || !SH.Orders) return null;
    try { return SH.Orders.get(orderId) || null; } catch (e) { return null; }
  }
  function assignabilityOf(orderId){
    var o = orderOf(orderId);
    if (!o) return fail('ORDER_NOT_FOUND');
    if (o.status !== 'progress') return fail('ORDER_CLOSED');
    var S = Snap();
    var snap = null; try { snap = S ? S.of(orderId) : null; } catch (e) { snap = null; }
    if (!snap) return fail('NO_SNAPSHOT');
    var f = snap.fulfilment || {};
    if (f.driverId) return fail('ALREADY_ASSIGNED', { driverId:f.driverId });
    var E = Engine();
    var m = null; try { m = E ? E.mstate(orderId) : null; } catch (e) { m = null; }
    if (m !== (E && E.MSTATE ? E.MSTATE.READY : 'ready')) return fail('NOT_READY', { mstate:m });
    return { ok:true, order:o, snapshot:snap };
  }
  /* the orders Logistics may hand to a driver right now — the authority's own
     answer, so no page decides eligibility for itself */
  function assignableOrders(){
    var a = staff(P.VIEW); if (!a.ok) return a;
    var SH = Shop(), out = [];
    var orders = [];
    try { orders = (SH && SH.Orders) ? (SH.Orders.all() || []) : []; } catch (e) { orders = []; }
    orders.forEach(function (o) {
      if (!o) return;
      var r = assignabilityOf(o.id);
      if (!r.ok) return;
      out.push({ orderId:o.id, storeSlug:r.snapshot.storeSlug || null,
                 area:(r.snapshot.delivery && r.snapshot.delivery.area) || null });
    });
    return { ok:true, items:out };
  }
  function assignOrder(orderId, driverId){
    var a = staff(P.ASSIGN); if (!a.ok) return a;

    var u = rawDriver(driverId);
    if (!u) return fail(Perm() && Perm().getUser(driverId) ? 'NOT_A_DRIVER' : 'DRIVER_NOT_FOUND');
    if (u.status !== STATUS.ACTIVE) return fail('DRIVER_SUSPENDED');

    var pre = assignabilityOf(orderId);
    if (!pre.ok) return pre;

    var E = Engine(), S = Snap();
    if (!E || !S) return fail('UNAVAILABLE');

    /* 1) the lifecycle move, performed by the engine that owns it */
    var moved = null;
    try {
      moved = E.driverAssigned(orderId, { id:a.id, name:a.name, roleId:a.roleId },
                               { via:'dispatch', metadata:{ driverId:driverId } });
    } catch (e) { moved = null; }
    if (!moved || !moved.ok) return fail('ENGINE_REFUSED', { reason:moved && moved.reason });

    /* 2) the driver's identity, recorded on the order's own record */
    var f = copy(pre.snapshot.fulfilment) || {};
    f.driverId = driverId;
    f.assignedAt = Date.now();          /* the field already exists on the record */
    var w = null;
    try { w = S.update(orderId, 'fulfilment', f, 'logistics_assignment',
                       { id:a.id, name:a.name, roleId:a.roleId }); } catch (e) { w = null; }
    if (!w || !w.ok) {
      /* never leave the order in a delivery state with no driver */
      try { E.driverUnassigned(orderId, { id:a.id, name:a.name, roleId:a.roleId },
                               { via:'return_to_pool', reason:'assignment_rollback' }); } catch (e) {}
      return fail('PERSIST_FAILED', { reason:w && w.reason });
    }
    /* the engine already wrote `dispatch.assigned`; this module adds no second
       record of the same fact */
    return { ok:true, orderId:orderId, driverId:driverId,
             driver:present(rawDriver(driverId), assignmentIndex(), can(a.id, P.EDIT)) };
  }
  /* the reverse: the order goes back to the pool, keeping its history */
  function returnToPool(orderId, input){
    input = input || {};
    var bad = badKeys(input, ['reason']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.ASSIGN); if (!a.ok) return a;
    var reason = text(input.reason);
    if (!reason || reason.length > LIMITS.reason) return fail('REASON_REQUIRED');

    var o = orderOf(orderId); if (!o) return fail('ORDER_NOT_FOUND');
    var S = Snap(), E = Engine();
    if (!S || !E) return fail('UNAVAILABLE');
    var snap = null; try { snap = S.of(orderId); } catch (e) { snap = null; }
    if (!snap) return fail('NO_SNAPSHOT');
    var f = copy(snap.fulfilment) || {};
    if (!f.driverId) return fail('NOT_ASSIGNED');

    var moved = null;
    try {
      moved = E.driverUnassigned(orderId, { id:a.id, name:a.name, roleId:a.roleId },
                                 { via:'return_to_pool', reason:reason, metadata:{ driverId:f.driverId } });
    } catch (e) { moved = null; }
    if (!moved || !moved.ok) return fail('ENGINE_REFUSED', { reason:moved && moved.reason });

    var previous = f.driverId;
    f.driverId = null; f.assignedAt = null;
    var w = null;
    try { w = S.update(orderId, 'fulfilment', f, 'logistics_return_to_pool',
                       { id:a.id, name:a.name, roleId:a.roleId }); } catch (e) { w = null; }
    if (!w || !w.ok) return fail('PERSIST_FAILED', { reason:w && w.reason });
    return { ok:true, orderId:orderId, previousDriverId:previous };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * DRIVER APPLICATIONS — the recruitment half of the same domain
   * ----------------------------------------------------------------------
   * The lifecycle is one line, and it belongs to this authority end to end:
   *
   *   public application → pending → Logistics review → approve / reject
   *                                                   → driver account
   *
   * AN APPLICATION IS NOT AN ACCOUNT. Applicants are never written into
   * `raf_users`: they live in their own append-only records until Logistics
   * approves them, and only then does an RAF account exist. Rejected and
   * approved applications are both kept forever.
   *
   * STORAGE is the registered RAFRecordStore boundary, never a key invented
   * here: `logistics_applications` holds the immutable submission and
   * `logistics_application_events` the append-only decisions, so the status is
   * DERIVED and no record is ever rewritten. The editable driver profile —
   * the vehicle and identity facts the RAF account model has no field for —
   * is the `logistics_driver_profiles` state map, keyed by the driver account.
   * ════════════════════════════════════════════════════════════════════════*/
  var APP_STATUS = { PENDING:'pending', APPROVED:'approved', REJECTED:'rejected' };
  var APP_STATUS_TXT = {
    pending:  { ar:'قيد المراجعة', en:'Pending review' },
    approved: { ar:'مقبول',        en:'Approved' },
    rejected: { ar:'مرفوض',        en:'Rejected' }
  };
  /* where the application came from. Public applicants accept RAF's terms;
     an administrator creating a driver directly does not, and is never asked. */
  var APP_SOURCE = { PUBLIC:'public', LOGISTICS:'logistics' };
  var APP_LIMITS = { name:60, phone:24, email:120, civilId:16, text:60, plate:16, reason:300, note:600 };
  var DOC_KEYS = ['civilId', 'license', 'registration', 'photo'];

  function store(name){
    if (!global.RAFRecordStore) return null;
    try { return RAFRecordStore.collection(name); } catch (e) { return null; }
  }
  function profileMap(){
    if (!global.RAFRecordStore) return null;
    try { return RAFRecordStore.stateMap('logistics_driver_profiles'); } catch (e) { return null; }
  }
  function newId(prefix){
    return global.RAFRecordStore ? RAFRecordStore.makeId(prefix)
                                 : prefix + '-' + Date.now().toString(36);
  }
  function appRows(){ var c = store('logistics_applications'); return c ? c.all() : []; }
  function eventRows(id){
    var c = store('logistics_application_events');
    if (!c) return [];
    return c.all().filter(function (e) { return e.applicationId === id; })
            .sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  }
  /* the application as it stands now — computed from the events, never stored */
  function deriveApp(rec, events){
    var a = copy(rec);
    a.status = APP_STATUS.PENDING;
    a.reviewedAt = null; a.reviewedBy = null; a.reviewedByName = null;
    a.decidedAt = null; a.decidedBy = null; a.decidedByName = null;
    a.rejectionReason = null; a.driverId = null;
    a.history = [];
    events.forEach(function (e) {
      a.history.push({ eventId:e.eventId, kind:e.kind, at:e.at, actorId:e.actorId || null,
                       actorName:e.actorName || null, note:e.note || null, reason:e.reason || null,
                       driverId:e.driverId || null });
      if (e.kind === 'review') { a.reviewedAt = e.at; a.reviewedBy = e.actorId; a.reviewedByName = e.actorName; }
      if (e.kind === 'approved') { a.status = APP_STATUS.APPROVED; a.decidedAt = e.at;
                                   a.decidedBy = e.actorId; a.decidedByName = e.actorName; a.driverId = e.driverId || null; }
      if (e.kind === 'rejected') { a.status = APP_STATUS.REJECTED; a.decidedAt = e.at;
                                   a.decidedBy = e.actorId; a.decidedByName = e.actorName; a.rejectionReason = e.reason || null; }
    });
    a.statusText = APP_STATUS_TXT[a.status] || null;
    a.active = a.status === APP_STATUS.PENDING;
    return a;
  }
  function appState(id){
    var rec = null, rows = appRows();
    for (var i = 0; i < rows.length; i++) if (rows[i].applicationId === id) rec = rows[i];
    return rec ? deriveApp(rec, eventRows(id)) : null;
  }
  function appendEvent(applicationId, kind, a, extra){
    var c = store('logistics_application_events');
    if (!c) return { ok:false, reason:'store_unavailable' };
    var n = eventRows(applicationId).filter(function (e) { return e.kind === kind; }).length;
    var rec = {
      eventId:'lga|' + applicationId + '|' + kind + '|' + n,
      applicationId:applicationId, kind:kind, at:Date.now(),
      actorId:(a && a.id) || null, actorName:(a && a.name) || null
    };
    for (var k in (extra || {})) if (extra.hasOwnProperty(k)) rec[k] = extra[k];
    return c.append('eventId', rec);
  }
  /* the human-facing reference an applicant is shown and quotes back */
  function nextRef(){
    var year = new Date().getFullYear();
    var n = appRows().filter(function (r) { return String(r.ref || '').indexOf('DR-' + year + '-') === 0; }).length + 1;
    return 'DR-' + year + '-' + String(n).padStart(5, '0');
  }
  /* DOCUMENTS — this prototype has no file-storage service. Only the file's
     own metadata is recorded, marked storage:'metadata_only', exactly as
     RAFCustomerSupport already does for ticket attachments. No file content is
     read, stored or served, and no path from the applicant's machine is kept.
     Production needs real durable, access-controlled document storage. */
  function docMeta(d){
    if (!d) return null;
    var name = text(d.name), type = text(d.type);
    var size = (typeof d.size === 'number' && isFinite(d.size) && d.size >= 0) ? d.size : null;
    if (!name) return null;
    var dot = name.lastIndexOf('.');
    return { name:name.slice(0, 180), type:type.slice(0, 80) || null, size:size,
             ext:dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 8) : null,
             storage:'metadata_only', at:Date.now() };
  }

  function appErrors(input){
    var e = [], p = input.applicant || {}, v = input.vehicle || {};
    if (!text(p.firstName)) e.push({ field:'firstName' });
    if (!text(p.lastName))  e.push({ field:'lastName' });
    if (!text(p.phone))     e.push({ field:'phone' });
    var email = text(p.email);
    if (!email || email.indexOf('@') < 1 || email.length > APP_LIMITS.email) e.push({ field:'email' });
    if (!text(p.civilId))    e.push({ field:'civilId' });
    if (!text(p.nationality))e.push({ field:'nationality' });
    if (!text(p.area))       e.push({ field:'area' });
    if (!text(v.type))  e.push({ field:'vehicleType' });
    if (!text(v.make))  e.push({ field:'vehicleMake' });
    if (!text(v.model)) e.push({ field:'vehicleModel' });
    if (!text(v.year))  e.push({ field:'vehicleYear' });
    if (!text(v.plate)) e.push({ field:'vehiclePlate' });
    return e;
  }
  /* an applicant may not queue two live applications for the same identity */
  function liveDuplicate(civilId, email){
    var c = text(civilId).toLowerCase(), m = text(email).toLowerCase();
    var hit = null;
    appRows().forEach(function (r) {
      if (hit) return;
      var s = appState(r.applicationId);
      if (!s || s.status !== APP_STATUS.PENDING) return;
      var rc = text(r.applicant && r.applicant.civilId).toLowerCase();
      var rm = text(r.applicant && r.applicant.email).toLowerCase();
      if ((c && rc === c) || (m && rm === m)) hit = s;
    });
    return hit;
  }

  /* ---- 1 · SUBMIT (public, or recorded alongside a direct creation) ----
     This is the ONE operation that does not require a session: the public
     driver application is open to anyone. It creates no account, grants
     nothing, and produces a record whose status is pending until Logistics
     decides. Consent is required for a public submission and is stored with
     the application; it is never treated as an approval. */
  function createApplication(input){
    input = input || {};
    var bad = badKeys(input, ['applicant', 'vehicle', 'documents', 'consent', 'source']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    if (!global.RAFRecordStore) return fail('UNAVAILABLE');

    var source = text(input.source) || APP_SOURCE.PUBLIC;
    if (source !== APP_SOURCE.PUBLIC && source !== APP_SOURCE.LOGISTICS) return fail('INVALID', { errors:[{ field:'source' }] });

    var errors = appErrors(input);
    if (errors.length) return fail('INVALID', { errors:errors });

    /* CONSENT — required for a public application, never asked of an
       administrator creating a driver directly under the Logistics workflow */
    var consent = null;
    if (source === APP_SOURCE.PUBLIC) {
      var c = input.consent || {};
      if (c.accepted !== true) return fail('CONSENT_REQUIRED');
      consent = { accepted:true, at:Date.now(), terms:text(c.terms) || 'raf_terms.html' };
    }

    var p = input.applicant, v = input.vehicle;
    var dupe = liveDuplicate(p.civilId, p.email);
    if (dupe) return fail('DUPLICATE_APPLICATION', { applicationId:dupe.applicationId, ref:dupe.ref });

    var docs = {}, given = input.documents || {};
    DOC_KEYS.forEach(function (k) { docs[k] = docMeta(given[k]); });

    var id = newId('app');
    var rec = {
      applicationId:id, ref:nextRef(), source:source, submittedAt:Date.now(),
      applicant:{
        firstName:text(p.firstName).slice(0, APP_LIMITS.name),
        lastName:text(p.lastName).slice(0, APP_LIMITS.name),
        name:(text(p.firstName) + ' ' + text(p.lastName)).trim(),
        phone:text(p.phone).slice(0, APP_LIMITS.phone),
        email:text(p.email).slice(0, APP_LIMITS.email),
        civilId:text(p.civilId).slice(0, APP_LIMITS.civilId),
        nationality:text(p.nationality).slice(0, APP_LIMITS.text),
        area:text(p.area).slice(0, APP_LIMITS.text)
      },
      vehicle:{
        type:text(v.type).slice(0, APP_LIMITS.text), make:text(v.make).slice(0, APP_LIMITS.text),
        model:text(v.model).slice(0, APP_LIMITS.text), year:text(v.year).slice(0, 8),
        color:text(v.color).slice(0, APP_LIMITS.text) || null, plate:text(v.plate).slice(0, APP_LIMITS.plate)
      },
      documents:docs, consent:consent, version:VERSION
    };
    var c2 = store('logistics_applications');
    if (!c2) return fail('UNAVAILABLE');
    var w = c2.append('applicationId', rec);
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });

    appendEvent(id, 'submitted', null, { source:source });
    /* the applicant has no RAF session, so the actor is unknown by design */
    if (global.RAFAudit && RAFAudit.record) {
      try {
        RAFAudit.record({ action:'logistics.application_submitted',
          source:source === APP_SOURCE.PUBLIC ? 'system' : 'admin',
          key:id, newState:APP_STATUS.PENDING,
          metadata:{ applicationId:id, ref:rec.ref, source:source } });
      } catch (e) {}
    }
    return { ok:true, applicationId:id, ref:rec.ref, status:APP_STATUS.PENDING,
             application:deriveApp(rec, eventRows(id)) };
  }

  /* ---- 2 · READ ---- */
  function listApplications(filters){
    filters = filters || {};
    var bad = badKeys(filters, ['status', 'q', 'from', 'to', 'nationality', 'area', 'vehicleType', 'source']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.VIEW); if (!a.ok) return a;
    var q = text(filters.q).toLowerCase();
    var items = appRows().map(function (r) { return deriveApp(r, eventRows(r.applicationId)); })
      .filter(function (x) {
        if (filters.status && x.status !== filters.status) return false;
        if (filters.source && x.source !== filters.source) return false;
        if (filters.nationality && x.applicant.nationality !== filters.nationality) return false;
        if (filters.area && x.applicant.area !== filters.area) return false;
        if (filters.vehicleType && x.vehicle.type !== filters.vehicleType) return false;
        if (filters.from){ var f = Date.parse(filters.from + 'T00:00:00'); if (isNaN(f) || x.submittedAt < f) return false; }
        if (filters.to){ var t = Date.parse(filters.to + 'T23:59:59'); if (isNaN(t) || x.submittedAt > t) return false; }
        if (q){
          var hay = [x.ref, x.applicant.name, x.applicant.area, x.vehicle.type, x.vehicle.plate]
            .filter(Boolean).join(' ').toLowerCase();
          if (hay.indexOf(q) < 0) return false;
        }
        return true;
      })
      .sort(function (x, y) { return y.submittedAt - x.submittedAt; });
    return { ok:true, items:items };
  }
  function getApplication(applicationId){
    var a = staff(P.VIEW); if (!a.ok) return a;
    var s = appState(applicationId);
    if (!s) return fail('APPLICATION_NOT_FOUND');
    return { ok:true, application:s };
  }
  /* the distinct values actually present, for the filter applet — so a filter
     can never offer a value no application carries */
  function applicationFacets(){
    var a = staff(P.VIEW); if (!a.ok) return a;
    var nat = {}, area = {}, veh = {};
    appRows().forEach(function (r) {
      if (r.applicant && r.applicant.nationality) nat[r.applicant.nationality] = 1;
      if (r.applicant && r.applicant.area) area[r.applicant.area] = 1;
      if (r.vehicle && r.vehicle.type) veh[r.vehicle.type] = 1;
    });
    return { ok:true, nationalities:Object.keys(nat).sort(), areas:Object.keys(area).sort(),
             vehicleTypes:Object.keys(veh).sort() };
  }

  /* ---- 3 · REVIEW ----
     A reviewer's note on a pending application. It records who looked and what
     they said; it is not a decision, so the status stays pending. */
  function reviewApplication(applicationId, input){
    input = input || {};
    var bad = badKeys(input, ['note']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.APPROVE); if (!a.ok) return a;
    var s = appState(applicationId); if (!s) return fail('APPLICATION_NOT_FOUND');
    if (s.status !== APP_STATUS.PENDING) return fail('APPLICATION_DECIDED', { status:s.status });
    var note = text(input.note);
    if (!note || note.length > APP_LIMITS.note) return fail('NOTE_REQUIRED');

    var w = appendEvent(applicationId, 'review', a, { note:note });
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });
    audit('logistics.application_reviewed', a, {
      key:w.record.eventId, metadata:{ applicationId:applicationId, ref:s.ref } });
    return { ok:true, application:appState(applicationId) };
  }

  /* ---- 4 · APPROVE → DRIVER ACCOUNT ----
     The approval decision and the account it produces are one operation, so an
     approved application can never end up without the account it promised. */
  function approveApplication(applicationId, input){
    input = input || {};
    var bad = badKeys(input, ['note']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.APPROVE); if (!a.ok) return a;
    var s = appState(applicationId); if (!s) return fail('APPLICATION_NOT_FOUND');
    if (s.status === APP_STATUS.APPROVED) return fail('ALREADY_APPROVED', { driverId:s.driverId });
    if (s.status === APP_STATUS.REJECTED) return fail('APPLICATION_DECIDED', { status:s.status });
    var errors = appErrors({ applicant:s.applicant, vehicle:s.vehicle });
    if (errors.length) return fail('INVALID', { errors:errors });

    /* AN EXISTING ACCOUNT IS NEVER DUPLICATED. A driver account with this
       email becomes the operational account; any other kind of account is a
       conflict this module refuses rather than guesses at. */
    var existing = null;
    try {
      existing = (Perm().getUsers() || []).filter(function (u) {
        return u && text(u.email).toLowerCase() === text(s.applicant.email).toLowerCase(); })[0] || null;
    } catch (e) { existing = null; }
    if (existing && existing.roleId !== DRIVER_ROLE)
      return fail('ACCOUNT_CONFLICT', { accountRole:existing.roleId });

    var driver = existing, created = false;
    if (driver) {
      /* an approved applicant's account is active */
      if (driver.status !== STATUS.ACTIVE) {
        var act = null;
        try { act = Perm().setStatus(driver.id, STATUS.ACTIVE); } catch (e) { act = null; }
        if (!act || !act.ok) return fail('PERSIST_FAILED', { reason:act && act.reason });
        driver = act.user;
      }
    } else {
      var r = null;
      try {
        r = Perm().createAccount({ name:s.applicant.name, email:s.applicant.email,
                                   phone:s.applicant.phone, accountType:ACCOUNT_TYPE, roleId:DRIVER_ROLE });
      } catch (e) { r = null; }
      if (!r || !r.ok) return fail('PERSIST_FAILED', { reason:r && r.reason });
      driver = r.user; created = true;
    }

    /* the decision, recorded against the application and linked to the account */
    var w = appendEvent(applicationId, 'approved', a, { driverId:driver.id, note:text(input.note) || null });
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });

    /* the Logistics profile — everything the application carries that the RAF
       account model has no field for. The identity itself is not duplicated. */
    writeProfile(driver.id, {
      applicationId:applicationId, applicationRef:s.ref, source:s.source,
      civilId:s.applicant.civilId, nationality:s.applicant.nationality, area:s.applicant.area,
      vehicle:copy(s.vehicle), documents:copy(s.documents),
      consent:s.consent ? { accepted:true, at:s.consent.at } : null
    });

    audit('logistics.application_approved', a, {
      key:w.record.eventId, previousState:APP_STATUS.PENDING, newState:APP_STATUS.APPROVED,
      metadata:{ applicationId:applicationId, ref:s.ref, driverId:driver.id, accountCreated:created } });
    if (created) audit('logistics.driver_created', a, {
      key:driver.id, newState:driver.status,
      metadata:{ driverId:driver.id, roleId:DRIVER_ROLE, applicationId:applicationId } });

    return { ok:true, application:appState(applicationId), driverId:driver.id, accountCreated:created,
             driver:present(rawDriver(driver.id), assignmentIndex(), can(a.id, P.EDIT)) };
  }

  /* ---- 5 · REJECT ----
     The application is kept in full, with the reason and the whole review
     history. Nothing is deleted and no account is created. */
  function rejectApplication(applicationId, input){
    input = input || {};
    var bad = badKeys(input, ['reason']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.APPROVE); if (!a.ok) return a;
    var s = appState(applicationId); if (!s) return fail('APPLICATION_NOT_FOUND');
    if (s.status !== APP_STATUS.PENDING) return fail('APPLICATION_DECIDED', { status:s.status });
    var reason = text(input.reason);
    if (!reason || reason.length > APP_LIMITS.reason) return fail('REASON_REQUIRED');

    var w = appendEvent(applicationId, 'rejected', a, { reason:reason });
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });
    audit('logistics.application_rejected', a, {
      key:w.record.eventId, previousState:APP_STATUS.PENDING, newState:APP_STATUS.REJECTED,
      reason:reason, metadata:{ applicationId:applicationId, ref:s.ref } });
    return { ok:true, application:appState(applicationId) };
  }

  /* ---- 6 · THE LOGISTICS DRIVER PROFILE ----
     Current state, not history: an operator may correct a plate or an area
     later. The RAF identity (name, email, phone, role, status) is NOT copied
     here — it stays in the account, and this holds only what the account model
     cannot express. */
  var PROFILE_KEYS = ['civilId', 'nationality', 'area', 'vehicle', 'documents',
                      'applicationId', 'applicationRef', 'source', 'consent'];
  function writeProfile(driverId, data){
    var m = profileMap(); if (!m) return false;
    var cur = m.get(driverId) || {};
    var next = Object.assign({}, cur);
    PROFILE_KEYS.forEach(function (k) { if (data[k] !== undefined) next[k] = data[k]; });
    next.updatedAt = Date.now();
    return m.set(driverId, next);
  }
  function profileOf(driverId){
    var m = profileMap(); if (!m) return null;
    return m.get(driverId) || null;
  }
  function driverProfile(driverId){
    var a = staff(P.VIEW); if (!a.ok) return a;
    if (!rawDriver(driverId)) return fail('DRIVER_NOT_FOUND');
    return { ok:true, profile:copy(profileOf(driverId)) };
  }
  /* only the fields the application model defines — no availability, zone,
     rating or performance field is accepted, because none exists */
  function updateDriverProfile(driverId, patch){
    patch = patch || {};
    var allowed = ['civilId', 'nationality', 'area', 'vehicle'];
    var bad = badKeys(patch, allowed);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.EDIT); if (!a.ok) return a;
    if (!rawDriver(driverId)) return fail('DRIVER_NOT_FOUND');
    var data = {};
    if (patch.civilId !== undefined)     data.civilId = text(patch.civilId).slice(0, APP_LIMITS.civilId);
    if (patch.nationality !== undefined) data.nationality = text(patch.nationality).slice(0, APP_LIMITS.text);
    if (patch.area !== undefined)        data.area = text(patch.area).slice(0, APP_LIMITS.text);
    if (patch.vehicle !== undefined){
      var v = patch.vehicle || {}, vb = badKeys(v, ['type','make','model','year','color','plate']);
      if (vb.length) return fail('FIELD_NOT_ACCEPTED', { fields:vb });
      var cur = (profileOf(driverId) || {}).vehicle || {};
      data.vehicle = {
        type:v.type !== undefined ? text(v.type).slice(0, APP_LIMITS.text) : (cur.type || null),
        make:v.make !== undefined ? text(v.make).slice(0, APP_LIMITS.text) : (cur.make || null),
        model:v.model !== undefined ? text(v.model).slice(0, APP_LIMITS.text) : (cur.model || null),
        year:v.year !== undefined ? text(v.year).slice(0, 8) : (cur.year || null),
        color:v.color !== undefined ? (text(v.color).slice(0, APP_LIMITS.text) || null) : (cur.color || null),
        plate:v.plate !== undefined ? text(v.plate).slice(0, APP_LIMITS.plate) : (cur.plate || null)
      };
    }
    if (!Object.keys(data).length) return { ok:true, unchanged:true, profile:copy(profileOf(driverId)) };
    if (!writeProfile(driverId, data)) return fail('PERSIST_FAILED');
    audit('logistics.driver_profile_updated', a, {
      key:driverId + ':profile:' + Date.now(),
      metadata:{ driverId:driverId, changed:Object.keys(data).join(',') } });
    return { ok:true, profile:copy(profileOf(driverId)) };
  }

  /* ══════════════════════ CAPABILITIES ══════════════════════
     What this account may actually do. A surface asks; it never guesses, and
     the answer here is never the security boundary — each operation re-proves
     its own permission when it runs. */
  function capabilities(){
    var a = actor();
    if (!a.ok) return { ok:false, code:a.code, message:a.message, view:false };
    return {
      ok:true,
      me:{ id:a.id, name:a.name, roleId:a.roleId },
      view:    can(a.id, P.VIEW),
      create:  can(a.id, P.CREATE),
      edit:    can(a.id, P.EDIT),
      suspend: can(a.id, P.SUSPEND),
      assign:  can(a.id, P.ASSIGN),
      /* the key exists; the account model has no state for it to act on */
      approve: can(a.id, P.APPROVE),
      approval: approveSupported()
    };
  }

  global.RAFLogistics = {
    VERSION:VERSION, PERMISSIONS:P, STATUS:STATUS, PROFILE_FIELDS:PROFILE_FIELDS,
    LIMITS:LIMITS, ERRORS:ERRORS,
    APP_STATUS:APP_STATUS, APP_STATUS_TXT:APP_STATUS_TXT, APP_SOURCE:APP_SOURCE,
    APP_LIMITS:APP_LIMITS, DOC_KEYS:DOC_KEYS,
    /* driver applications — the recruitment half of the same domain */
    createApplication:createApplication, listApplications:listApplications,
    getApplication:getApplication, applicationFacets:applicationFacets,
    reviewApplication:reviewApplication, approveApplication:approveApplication,
    rejectApplication:rejectApplication,
    driverProfile:driverProfile, updateDriverProfile:updateDriverProfile,
    /* reads */
    capabilities:capabilities, listDrivers:listDrivers, getDriver:getDriver,
    assignmentsOf:assignmentsOf, assignableOrders:assignableOrders,
    assignabilityOf:assignabilityOf, approveSupported:approveSupported,
    /* driver administration */
    createDriver:createDriver, updateDriver:updateDriver,
    suspendDriver:suspendDriver, reactivateDriver:reactivateDriver,
    approveDriver:approveDriver,
    /* assignment — the one path, shared by Drivers and Dispatch */
    assignOrder:assignOrder, returnToPool:returnToPool
  };
})(window);
