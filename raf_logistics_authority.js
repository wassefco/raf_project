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
    NOT_READY_FOR_PICKUP:{ ar:'المتجر لم يجهّز الطلب بعد. يمكنك استلامه عندما يصبح جاهزًا.', en:'The store has not finished preparing the order yet. You can pick it up once it is ready.' },
    ALREADY_ASSIGNED:  { ar:'الطلب معيَّن إلى سائق بالفعل.',               en:'The order is already assigned to a driver.' },
    NOT_ASSIGNED:      { ar:'الطلب غير معيَّن إلى سائق.',                  en:'The order is not assigned to a driver.' },
    /* the driver's own half of the domain */
    NOT_YOUR_DELIVERY: { ar:'هذا الطلب ليس ضمن توصيلاتك.',                 en:'That order is not one of your deliveries.' },
    NOT_IN_DELIVERY:   { ar:'الطلب ليس في مرحلة التوصيل.',                 en:'The order is not in the delivery stage.' },
    ALREADY_PICKED_UP: { ar:'تم تسجيل استلام هذا الطلب مسبقًا.',           en:'This order has already been picked up.' },
    NOT_PICKED_UP:     { ar:'سجّل استلام الطلب من المتجر أولًا.',           en:'Record the pickup from the store first.' },
    ALREADY_ARRIVED:   { ar:'تم تسجيل الوصول إلى العميل مسبقًا.',           en:'The arrival at the customer has already been recorded.' },
    NOT_ARRIVED:       { ar:'سجّل الوصول إلى العميل أولًا.',                en:'Record your arrival at the customer first.' },
    CODE_REQUIRED:     { ar:'أدخل رمز التسليم من العميل.',                  en:'Enter the customer’s delivery code.' },
    INCORRECT_CODE:    { ar:'رمز التسليم غير صحيح.',                        en:'Incorrect delivery code.' },
    NOT_YOUR_ORDER:    { ar:'هذا الطلب غير متاح لحسابك.',                   en:'This order is not available to your account.' },
    ALREADY_CLAIMED:   { ar:'سحب سائق آخر هذه التوصيلة.',                  en:'Another driver has already taken this delivery.' },
    ALREADY_YOURS:     { ar:'هذه التوصيلة ضمن توصيلاتك بالفعل.',           en:'This delivery is already yours.' },
    NOT_AVAILABLE:     { ar:'هذه التوصيلة لم تعد متاحة.',                  en:'This delivery is no longer available.' },
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
    /* assignable from the merchant's committed ACCEPT onward (the engine's own
       rule, RAFOrderEngine.assignableState): a driver can be on the order while
       the store is still preparing it; pickup still waits for Ready */
    var E = Engine();
    var m = null; try { m = E ? E.mstate(orderId) : null; } catch (e) { m = null; }
    var as = null; try { as = E && E.assignableState ? E.assignableState(orderId) : null; } catch (e) { as = null; }
    if (!as || !as.ok) return fail('NOT_READY', { mstate:m });
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
    /* an arrival (and the code it issued) belongs to the driver who arrived */
    f.arrivedAt = null; f.deliveryCode = null;
    var w = null;
    try { w = S.update(orderId, 'fulfilment', f, 'logistics_return_to_pool',
                       { id:a.id, name:a.name, roleId:a.roleId }); } catch (e) { w = null; }
    if (!w || !w.ok) return fail('PERSIST_FAILED', { reason:w && w.reason });
    return { ok:true, orderId:orderId, previousDriverId:previous };
  }

  /* ══════════════════════════════════════════════════════════════════════
   * THE DRIVER'S OWN HALF OF THE SAME DOMAIN
   * ----------------------------------------------------------------------
   * Logistics Management assigns a delivery; the driver carries it out. Both
   * are the same domain, so both live here. There is no RAFDriver: that module
   * was decommissioned and is not restored, and the Driver App calls these
   * operations instead of reaching into RAFOrderEngine or RAFOrderSnapshot.
   *
   * WHO — always the signed-in session, and only an ACTIVE account whose role
   * is `driver`. A driverId is never accepted from a caller, a URL or a page,
   * so one driver can never act as another however the call is made.
   *
   * WHICH ORDER — only one whose OWN record names this driver. The assignment
   * lives in the order's `fulfilment` block, written by assignOrder() above;
   * there is no second assignment store to consult and none is created here.
   * The moment Logistics returns an order to the pool or reassigns it, that
   * record changes and the previous driver's claim is gone.
   *
   * WHAT — exactly the two transitions RAFOrderEngine already implements:
   * driverPickedUp() and driverDelivered(). No state is invented, no state is
   * renamed, and the engine remains the only thing that moves an order.
   *
   * NO PERMISSION KEY IS INVENTED. A driver's authority over a delivery comes
   * from the assignment itself, exactly as a customer's authority over their
   * own compensation comes from owning it. The drivers.* keys stay what they
   * are: the keys Logistics MANAGEMENT runs on.
   * ==================================================================== */

  /* the acting DRIVER — the session, active, and actually a driver */
  function driverActor(){
    var a = actor(); if (!a.ok) return a;
    if (a.roleId !== DRIVER_ROLE) return fail('NOT_A_DRIVER');
    return a;
  }
  /* the delivery this driver is genuinely responsible for, proved from the
     order's own record rather than from anything the caller said */
  function ownDelivery(orderId, a){
    var o = orderOf(orderId); if (!o) return fail('ORDER_NOT_FOUND');
    if (o.status !== 'progress') return fail('ORDER_CLOSED');
    var S = Snap(); if (!S) return fail('UNAVAILABLE');
    var snap = null; try { snap = S.of(orderId); } catch (e) { snap = null; }
    if (!snap) return fail('NO_SNAPSHOT');
    var f = snap.fulfilment || {};
    if (!f.driverId) return fail('NOT_ASSIGNED');
    if (f.driverId !== a.id) return fail('NOT_YOUR_DELIVERY');
    return { ok:true, order:o, snapshot:snap, fulfilment:copy(f) };
  }
  /* what the driver is allowed to do next, decided from the order's own record
     and the engine's own state — never from a page */
  function deliveryStage(f){
    return f.arrivedAt ? 'arrived' : f.pickedUpAt ? 'picked_up' : 'assigned';
  }
  /* ONE delivery, as the driver carrying it needs to see it. Only the facts a
     delivery requires: where it is going, who receives it, what was promised.
     No commercial history, no other driver, no administrative data. */
  function deliveryView(orderId, f, forDriver){
    var S = Snap(), E = Engine();
    var snap = null; try { snap = S ? S.of(orderId) : null; } catch (e) { snap = null; }
    if (!snap) return null;
    var store = null;
    try { store = (global.RAFSource && snap.storeSlug) ? RAFSource.store(snap.storeSlug) : null; } catch (e) { store = null; }
    var promised = null;
    try { promised = E && E.promisedEtaAt ? E.promisedEtaAt(orderId) : null; } catch (e) { promised = null; }
    var d = snap.delivery || {}, c = snap.customer || {};
    /* can it be collected yet? The store's Ready (committed), read from the engine */
    var ms = null, ru = null;
    try { ms = E ? E.mstate(orderId) : null; ru = E && E.undoOf ? E.undoOf(orderId) : null; } catch (e) { ms = null; }
    var readyForPickup = ms === 'waiting_driver' || (ms === 'ready' && !(ru && ru.action === 'ready'));
    return {
      orderId:orderId,
      stage:deliveryStage(f),
      readyForPickup:!!(f.pickedUpAt || readyForPickup),
      assignedAt:f.assignedAt || null,
      pickedUpAt:f.pickedUpAt || null,
      /* the moment the driver reached the drop-off. The delivery code itself is
         NEVER in this view: the driver receives it from the customer at the door */
      arrivedAt:f.arrivedAt || null,
      /* the merchant's promise to the customer, read from the one authority
         that owns it. It is NOT a driver target and no driver SLA exists. */
      promisedEtaAt:promised ? promised.at : null,
      store:{ slug:snap.storeSlug || null, name:store ? copy(store.name) : null },
      /* the delivery destination and the person receiving it, exactly as the
         order recorded them at checkout for this delivery */
      /* the customer's phone is NOT here: calling goes through
         RAFDriverCommunication.call(), which counts attempts against the
         configured limit and is the only place the number is resolved */
      customer:forDriver ? { name:c.name || null, notes:c.notes || null } : null,
      delivery:forDriver ? {
        type:d.type || null, address:d.address || null, area:d.area || null,
        block:d.block || null, street:d.street || null, building:d.building || null,
        floor:d.floor || null, apartment:d.apartment || null, instructions:d.instructions || null
      } : null,
      items:(snap.items || []).length,
      payment:snap.commercial ? { method:copy(snap.commercial.paymentMethod), status:snap.commercial.paymentStatus || null,
                                  total:snap.commercial.grandTotal || null, currency:snap.commercial.currency || null } : null,
      canPickUp:!f.pickedUpAt && readyForPickup,
      canArrive:!!f.pickedUpAt && !f.arrivedAt,
      /* delivery is confirmed only at the door, with the customer's code */
      canDeliver:!!f.pickedUpAt && !!f.arrivedAt,
      codeRequired:!!f.arrivedAt
    };
  }
  /* EVERY delivery this driver is currently carrying. Read from the orders'
     own records through the same index Logistics Management reads. */
  function myDeliveries(){
    var a = driverActor(); if (!a.ok) return a;
    var list = assignmentIndex()[a.id] || [];
    var items = [];
    list.forEach(function (x) {
      var S = Snap(), snap = null;
      try { snap = S ? S.of(x.orderId) : null; } catch (e) { snap = null; }
      if (!snap) return;
      var v = deliveryView(x.orderId, snap.fulfilment || {}, true);
      if (v) items.push(v);
    });
    items.sort(function (p, q) { return (p.assignedAt || 0) - (q.assignedAt || 0); });
    return { ok:true, driver:{ driverId:a.id, name:a.name }, items:items };
  }
  /* ONE of them, for the detail view */
  function myDelivery(orderId){
    var a = driverActor(); if (!a.ok) return a;
    var m = ownDelivery(orderId, a); if (!m.ok) return m;
    return { ok:true, delivery:deliveryView(orderId, m.fulfilment, true) };
  }

  /* ---- THE AVAILABLE POOL ----
     The deliveries a driver may take right now. "Available" is not decided
     here: it is exactly the rule Logistics dispatch already uses
     (assignabilityOf — in progress, merchant marked it Ready, no driver on the
     order's record), so a driver's pool and the dispatcher's list can never
     disagree about what is free.

     No matching, distance, zone, priority or ranking exists in RAF and none is
     applied: the list is in the order the order store holds it.

     Before a driver owns a delivery they see only what they need to decide
     whether to take it — the store and the drop-off area. The recipient's
     name, phone and full address travel only once the delivery is theirs. */
  function poolView(orderId, snap){
    var store = null;
    try { store = (global.RAFSource && snap.storeSlug) ? RAFSource.store(snap.storeSlug) : null; } catch (e) { store = null; }
    var E = Engine(), promised = null;
    try { promised = E && E.promisedEtaAt ? E.promisedEtaAt(orderId) : null; } catch (e) { promised = null; }
    var d = snap.delivery || {};
    return {
      orderId:orderId,
      store:{ slug:snap.storeSlug || null, name:store ? copy(store.name) : null },
      area:d.area || null,
      items:(snap.items || []).length,
      promisedEtaAt:promised ? promised.at : null,
      /* offered from acceptance onward: is it collectable yet (the store's committed Ready)? */
      readyForPickup:(function () {
        var ms = null, ru = null;
        try { ms = E ? E.mstate(orderId) : null; ru = E && E.undoOf ? E.undoOf(orderId) : null; } catch (e) { ms = null; }
        return ms === 'ready' && !(ru && ru.action === 'ready');
      })()
    };
  }
  function availableDeliveries(){
    var a = driverActor(); if (!a.ok) return a;
    var SH = Shop(), orders = [];
    try { orders = (SH && SH.Orders) ? (SH.Orders.all() || []) : []; } catch (e) { orders = []; }
    var items = [];
    orders.forEach(function (o) {
      if (!o) return;
      var r = assignabilityOf(o.id);
      if (r.ok) items.push(poolView(o.id, r.snapshot));
    });
    return { ok:true, items:items };
  }

  /* ---- CLAIM ----
     The first eligible driver to take an available delivery owns it.

     WHO: the signed-in session, active, with the driver role — nothing the
     caller says. The operation takes the order id and nothing else; any other
     field (a driver id, a store, an actor) is refused rather than ignored.

     WHAT: the same assignability rule dispatch uses, re-read INSIDE the
     serialized section so a delivery taken a moment ago is refused.

     HOW: the engine already has the driver's own claim transition —
     driverAssigned without a dispatch context, audited as 'driver.assigned'
     ("Driver claimed the order"). Ownership is recorded where assignment
     already lives, fulfilment.driverId / assignedAt; no claim store is made.

     ORDERING follows pickUp: the reversible record write goes first and is
     read back, the engine transition (which writes the audit) goes last, and
     an engine refusal restores the record — so a failed claim leaves no audit
     event and no owner behind.

     SERIALIZATION: one exclusive Web Lock per order, the pattern
     RAFCompensation already uses. It makes two claims from tabs of the same
     browser strictly one-after-the-other. It is NOT cross-device atomicity:
     this prototype's storage is per-browser, and a real deployment needs the
     claim to be a server-side transaction (conditional write on "no driver"). */
  function serializedClaim(orderId, fn){
    var locks = null;
    try { locks = global.navigator && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null; } catch (e) { locks = null; }
    if (!locks) { try { return Promise.resolve(fn()); } catch (e) { return Promise.resolve(fail('PERSIST_FAILED')); } }
    return locks.request('raf-logistics-claim:' + String(orderId), { mode:'exclusive' }, function () {
      try { return fn(); } catch (e) { return fail('PERSIST_FAILED'); }
    }).catch(function () { return fail('PERSIST_FAILED'); });
  }
  function claimNow(orderId, a){
    /* re-read the claiming account inside the lock: a suspension (or a role
       change) that landed while the claim was waiting is honoured */
    var u = rawDriver(a.id);
    if (!u) return fail('NOT_A_DRIVER');
    if (u.status !== STATUS.ACTIVE) return fail('ACTOR_INACTIVE');

    var pre = assignabilityOf(orderId);
    if (!pre.ok) {
      if (pre.code === 'ALREADY_ASSIGNED')
        return fail(pre.driverId === a.id ? 'ALREADY_YOURS' : 'ALREADY_CLAIMED');   /* never names the other driver */
      if (pre.code === 'NOT_READY') return fail('NOT_AVAILABLE');
      return fail(pre.code);
    }
    var E = Engine(), S = Snap();
    if (!E || !S) return fail('UNAVAILABLE');
    var me = { id:a.id, name:a.name, roleId:a.roleId };

    /* 1) ownership on the order's own record */
    var was = copy(pre.snapshot.fulfilment);
    var f = copy(pre.snapshot.fulfilment) || {};
    f.driverId = a.id;
    f.assignedAt = Date.now();
    var w = null;
    try { w = S.update(orderId, 'fulfilment', f, 'driver_claim', me); } catch (e) { w = null; }
    if (!w || !w.ok) return fail('PERSIST_FAILED', { reason:w && w.reason });

    /* 2) proved to have survived the write */
    var back = null;
    try { back = S.of(orderId); } catch (e) { back = null; }
    if (!back || !back.fulfilment || back.fulfilment.driverId !== a.id || back.fulfilment.assignedAt !== f.assignedAt)
      return fail('PERSIST_FAILED', { reason:'not_readable_after_write' });

    /* 3) the engine's own driver-claim transition */
    var moved = null;
    try { moved = E.driverAssigned(orderId, me); } catch (e) { moved = null; }
    if (!moved || !moved.ok) {
      try { S.update(orderId, 'fulfilment', was || {}, 'driver_claim_rollback', me); } catch (e) {}
      return fail(moved && moved.reason === 'not_ready' ? 'NOT_AVAILABLE' : 'ENGINE_REFUSED');
    }
    return { ok:true, orderId:orderId, delivery:deliveryView(orderId, f, true) };
  }
  function claim(orderId, opts){
    if (arguments.length > 1 && opts !== undefined) return Promise.resolve(fail('FIELD_NOT_ACCEPTED'));
    if (typeof orderId !== 'string' || !orderId) return Promise.resolve(fail('ORDER_NOT_FOUND'));
    var a = driverActor(); if (!a.ok) return Promise.resolve(a);
    return serializedClaim(orderId, function () { return claimNow(orderId, a); });
  }

  /* ---- HISTORY ----
     The deliveries this driver completed, from the orders' own records: a
     delivered order whose fulfilment names this driver. An order that was
     returned to the pool or handed to someone else is not theirs and is not
     listed. After delivery the driver no longer needs the recipient's name,
     phone or address, so history carries none of them. */
  function myHistory(){
    var a = driverActor(); if (!a.ok) return a;
    var SH = Shop(), S = Snap(), orders = [];
    try { orders = (SH && SH.Orders) ? (SH.Orders.all() || []) : []; } catch (e) { orders = []; }
    var items = [];
    orders.forEach(function (o) {
      if (!o || o.status !== 'delivered') return;
      var snap = null; try { snap = S ? S.of(o.id) : null; } catch (e) { snap = null; }
      var f = (snap && snap.fulfilment) || {};
      if (f.driverId !== a.id) return;
      var store = null;
      try { store = (global.RAFSource && snap.storeSlug) ? RAFSource.store(snap.storeSlug) : null; } catch (e) { store = null; }
      items.push({ orderId:o.id, store:{ slug:snap.storeSlug || null, name:store ? copy(store.name) : null },
                   area:(snap.delivery && snap.delivery.area) || null,
                   pickedUpAt:f.pickedUpAt || null, deliveredAt:f.deliveredAt || null });
    });
    items.sort(function (p, q) { return (q.deliveredAt || 0) - (p.deliveredAt || 0); });
    return { ok:true, items:items };
  }

  /* ---- PICKED UP ----
     The driver has the order in hand. The engine owns the transition and
     writes 'driver.pickup'; this authority proves who may ask for it and then
     records the moment on the order's own record.

     ORDERING IS THE SAFETY MECHANISM HERE. The engine's transition writes an
     audit event, and audit history is never rewritten, so it is the one step
     that cannot be taken back. The fulfilment write can: it is a value on the
     order's own record, and `assignOrder` already restores one when a later
     step fails. So the reversible step goes FIRST and is proved to have
     landed, and only then is the irreversible one asked for. A failed save
     therefore ends the operation before any audit event exists, and an engine
     refusal restores the record. The two can no longer disagree. */
  function pickUp(orderId){
    var a = driverActor(); if (!a.ok) return a;
    var m = ownDelivery(orderId, a); if (!m.ok) return m;
    if (m.fulfilment.pickedUpAt) return fail('ALREADY_PICKED_UP');
    var E = Engine(), S = Snap();
    if (!E || !S) return fail('UNAVAILABLE');
    /* the engine recovers a missing Ready on pickup by design; that recovery
       is for a real pickup, so the state is proved HERE before asking */
    var st = null; try { st = E.mstate(orderId); } catch (e) { st = null; }
    /* a driver assigned early waits for the store: pickup needs Ready, and a
       Ready still inside its undo window is not final yet */
    if (st === 'accepted' || st === 'preparing') return fail('NOT_READY_FOR_PICKUP', { state:st });
    if (st === 'ready') { var u = null; try { u = E.undoOf ? E.undoOf(orderId) : null; } catch (e) { u = null; }
      if (u && u.action === 'ready') return fail('NOT_READY_FOR_PICKUP', { state:st }); }
    else if (st !== 'waiting_driver') return fail('NOT_IN_DELIVERY', { state:st });

    var me = { id:a.id, name:a.name, roleId:a.roleId };

    /* 1) the moment, recorded on the order's own record. The field already
          exists, and the order is already in delivery, so nothing written
          here claims a state the order is not already in. */
    var was = copy(m.fulfilment);
    var f = m.fulfilment;
    f.pickedUpAt = Date.now();
    var w = null;
    try { w = S.update(orderId, 'fulfilment', f, 'driver_pickup', me); } catch (e) { w = null; }
    if (!w || !w.ok) return fail('PERSIST_FAILED', { reason:w && w.reason });

    /* 2) and proved to have survived the write, because a storage failure
          inside the snapshot authority is not reported back to its caller */
    var back = null;
    try { back = S.of(orderId); } catch (e) { back = null; }
    if (!back || !back.fulfilment || back.fulfilment.pickedUpAt !== f.pickedUpAt)
      return fail('PERSIST_FAILED', { reason:'not_readable_after_write' });

    /* 3) the lifecycle move, performed by the engine that owns it */
    var moved = null;
    try { moved = E.driverPickedUp(orderId, me); } catch (e) { moved = null; }
    if (moved !== true && !(moved && moved.ok)) {
      /* never leave a pickup time on an order the engine did not move */
      try { S.update(orderId, 'fulfilment', was, 'driver_pickup_rollback', me); } catch (e) {}
      return fail('ENGINE_REFUSED');
    }
    /* the engine already wrote the audit event; no second record of one fact */
    return { ok:true, orderId:orderId, delivery:deliveryView(orderId, f, true) };
  }


  /* ---- ARRIVED AT THE CUSTOMER ----
     Between pickup and delivery: the driver is at the drop-off. This is the
     step that issues the DELIVERY VERIFICATION CODE — a two-digit number
     (10–99 inclusive) that the customer is shown and hands to the driver at
     the door. It lives on the order's own fulfilment record (shared order
     data), so the customer's tab and the driver's tab read the same value,
     and completeDelivery() checks what the driver types against that record
     and nothing else. The code is never returned to the driver.

     Same ordering as pickUp(): the reversible record write first, proved to
     have landed, then the engine milestone; an engine refusal restores the
     record. Arriving twice is refused, so the code never changes under the
     customer's eyes. */
  function deliveryCode(){
    var c = global.crypto || global.msCrypto;
    if (c && c.getRandomValues) {
      var b = new Uint8Array(1);
      /* 0–179 is an exact multiple of 90, so every code is equally likely */
      do { c.getRandomValues(b); } while (b[0] >= 180);
      return String(10 + (b[0] % 90));
    }
    return String(10 + Math.floor(Math.random() * 90));
  }
  function arrive(orderId){
    var a = driverActor(); if (!a.ok) return a;
    var m = ownDelivery(orderId, a); if (!m.ok) return m;
    if (!m.fulfilment.pickedUpAt) return fail('NOT_PICKED_UP');
    if (m.fulfilment.arrivedAt) return fail('ALREADY_ARRIVED');
    var E = Engine(), S = Snap();
    if (!E || !S || !E.driverArrived) return fail('UNAVAILABLE');
    var st = null; try { st = E.mstate(orderId); } catch (e) { st = null; }
    if (st !== 'waiting_driver') return fail('NOT_IN_DELIVERY', { state:st });

    var me = { id:a.id, name:a.name, roleId:a.roleId };
    var was = copy(m.fulfilment);
    var f = m.fulfilment;
    f.arrivedAt = Date.now();
    f.deliveryCode = deliveryCode();
    var w = null;
    try { w = S.update(orderId, 'fulfilment', f, 'driver_arrived', me); } catch (e) { w = null; }
    if (!w || !w.ok) return fail('PERSIST_FAILED', { reason:w && w.reason });
    var back = null;
    try { back = S.of(orderId); } catch (e) { back = null; }
    if (!back || !back.fulfilment || back.fulfilment.arrivedAt !== f.arrivedAt || back.fulfilment.deliveryCode !== f.deliveryCode)
      return fail('PERSIST_FAILED', { reason:'not_readable_after_write' });

    var moved = null;
    try { moved = E.driverArrived(orderId, me); } catch (e) { moved = null; }
    if (!moved || !moved.ok) {
      try { S.update(orderId, 'fulfilment', was, 'driver_arrived_rollback', me); } catch (e) {}
      return fail('ENGINE_REFUSED', { reason:moved && moved.reason });
    }
    return { ok:true, orderId:orderId, delivery:deliveryView(orderId, f, true) };
  }

  /* ---- THE CUSTOMER'S SIDE OF THE ARRIVAL ----
     The order's own customer (session identity, ownership from the order
     record — never from a caller) reads whether the driver has arrived and,
     while the order is still out for delivery, the verification code to hand
     over. Nobody else receives the code from here. */
  function customerArrival(orderId){
    var a = actor(); if (!a.ok) return a;
    if (a.roleId !== 'customer') return fail('NOT_YOUR_ORDER');
    var o = orderOf(orderId); if (!o) return fail('NOT_YOUR_ORDER');
    var S = Snap(); if (!S) return fail('UNAVAILABLE');
    var snap = null; try { snap = S.of(orderId); } catch (e) { snap = null; }
    if (!snap || !snap.customer || snap.customer.id !== a.id) return fail('NOT_YOUR_ORDER');
    var f = snap.fulfilment || {};
    var live = o.status === 'progress' && !!f.arrivedAt && !f.deliveredAt;
    return { ok:true, orderId:orderId, arrived:!!f.arrivedAt, arrivedAt:f.arrivedAt || null,
             code:live && f.deliveryCode ? String(f.deliveryCode) : null };
  }
  /* ---- DELIVERED ----
     The end of the delivery, and the point at which RAF decides whether the
     customer is owed a delay compensation.

     THE COMPENSATION TRIGGER LIVES HERE, not in the Driver App and not in the
     engine. This is the delivery-completion workflow: the engine records the
     delivery, and the workflow then hands the ORDER ID to RAFCompensation,
     which reads the promised time and the delivered time from the authorities
     that own them and applies its own approved rules. Nothing about the
     compensation is calculated, shaped, requested or decided here, and a
     compensation outcome never changes the delivery: the delivery is done. */
  /* opts: { code } — the two digits the customer handed over at the door.
     Delivery is confirmed only after the arrival, and only when the code
     matches the one on the order's own record. A wrong or missing code
     changes nothing. */
  function completeDelivery(orderId, opts){
    opts = opts || {};
    if (typeof opts !== 'object') return fail('FIELD_NOT_ACCEPTED');
    var bad = badKeys(opts, ['code']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = driverActor(); if (!a.ok) return a;
    var m = ownDelivery(orderId, a); if (!m.ok) return m;
    if (!m.fulfilment.pickedUpAt) return fail('NOT_PICKED_UP');
    if (!m.fulfilment.arrivedAt) return fail('NOT_ARRIVED');
    var entered = opts.code == null ? '' : String(opts.code).trim();
    if (!entered) return fail('CODE_REQUIRED');
    if (!/^\d{2}$/.test(entered) || !m.fulfilment.deliveryCode || entered !== String(m.fulfilment.deliveryCode))
      return fail('INCORRECT_CODE');
    var E = Engine(), S = Snap();
    if (!E || !S) return fail('UNAVAILABLE');

    var me = { id:a.id, name:a.name, roleId:a.roleId };
    var moved = null;
    try { moved = E.driverDelivered(orderId, me); } catch (e) { moved = null; }
    if (!moved || !moved.ok) return fail('ENGINE_REFUSED', { reason:moved && moved.reason });

    var f = m.fulfilment;
    f.deliveredAt = Date.now();
    try { S.update(orderId, 'fulfilment', f, 'driver_delivery', me); } catch (e) {}

    /* the trigger — one call, one authority, the order id it asks for */
    var compensation = { evaluated:false, issued:false, compensationId:null };
    if (global.RAFCompensation && RAFCompensation.processDelivered) {
      var c = null;
      try { c = RAFCompensation.processDelivered(orderId); } catch (e) { c = null; }
      if (c && c.ok) {
        compensation = { evaluated:true, issued:!!c.issued,
                         compensationId:c.compensationId || null, reason:c.reason || null };
      } else {
        compensation = { evaluated:true, issued:false, reason:(c && c.code) || 'unavailable' };
      }
    }
    /* the driver is told the delivery is complete. What RAF decided about a
       compensation is not a driver matter and is not returned to the app. */
    return { ok:true, orderId:orderId, delivered:true, compensation:compensation };
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
  /* customer ratings of ONE driver, for the driver profile. The ratings belong to
     RAFCustomerExperience (the one ratings authority); Logistics only presents
     them, behind its own drivers.view check. No customer identity is returned. */
  function driverRatings(driverId){
    var a = staff(P.VIEW); if (!a.ok) return a;
    if (!rawDriver(driverId)) return fail('DRIVER_NOT_FOUND');
    var CX = global.RAFCustomerExperience;
    if (!CX || !CX.driverRatings) return fail('UNAVAILABLE');
    var r = CX.driverRatings(driverId);
    if (!r || !r.ok) return r || fail('UNAVAILABLE');
    return { ok:true, driverId:driverId, summary:copy(r.summary),
             items:r.items.map(function (x) { return { ratingId:x.ratingId, orderId:x.orderId, rating:x.rating, comment:x.comment, createdAt:x.createdAt }; }) };
  }
  /* only the fields the application model defines — no availability, zone,
     rating or performance field is accepted into the profile (customer ratings
     live in RAFCustomerExperience, read above through driverRatings) */
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
    driverRatings:driverRatings,
    /* reads */
    capabilities:capabilities, listDrivers:listDrivers, getDriver:getDriver,
    assignmentsOf:assignmentsOf, assignableOrders:assignableOrders,
    assignabilityOf:assignabilityOf, approveSupported:approveSupported,
    /* driver administration */
    createDriver:createDriver, updateDriver:updateDriver,
    suspendDriver:suspendDriver, reactivateDriver:reactivateDriver,
    approveDriver:approveDriver,
    /* assignment — the one path, shared by Drivers and Dispatch */
    assignOrder:assignOrder, returnToPool:returnToPool,
    /* the driver's own half of the domain — the Driver App's only API */
    myDeliveries:myDeliveries, myDelivery:myDelivery,
    availableDeliveries:availableDeliveries, claim:claim, myHistory:myHistory,
    pickUp:pickUp, arrive:arrive, completeDelivery:completeDelivery,
    /* the order's own customer: arrival and the delivery verification code */
    customerArrival:customerArrival
  };
})(window);
