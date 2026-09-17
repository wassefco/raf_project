/* ============================================================================
 * RAF Marketplace — CUSTOMER SERVICE AUTHORITY  (RAFCustomerService)
 * ----------------------------------------------------------------------------
 * The single authority for the Customer Service TICKET domain:
 *
 *     Customer  ↔  RAF Customer Service  ↔  the responsible department
 *
 * NAMING — the global `RAFCustomerSupport` was already taken, by the MERCHANT
 * support channel (raf_customer_support.js: merchant ↔ RAF Management), and
 * `RAFCustomerExperience` owns customer ↔ STORE issues. Neither is this
 * channel, and neither was renamed, so this authority is RAFCustomerService.
 * Three separate channels, three separate authorities, no duplication.
 *
 * IT COORDINATES WORK; IT DOES NOT OWN THE BUSINESS OPERATION
 *   orders → RAFOrderEngine · delivery → RAFDeliveryOps · drivers → RAFDriver /
 *   RAFDriverManagement · driver conversation → RAFDriverCommunication ·
 *   wallet → RAFWallet · compensation → RAFCompensation · audit → RAFAudit ·
 *   notifications → RAFNotify · live updates → RAFEventBus · permissions →
 *   RAFPerm · configuration → RAFConfig.
 * Nothing here cancels an order, moves money, reassigns a driver or changes an
 * address. A ticket coordinates that work and records what was decided; the
 * owning authority performs it, from its own surface, under its own rules.
 *
 * IDENTITY — the actor is ALWAYS the signed-in session (RAFPerm.currentUser).
 * A caller-supplied actorId, customerId, employeeId or department is never
 * trusted; a suspended account is refused.
 *
 * DEPARTMENTS — a department IS an existing RAF role. No new role is created,
 * and there is no automatic routing, round robin, load balancing or automatic
 * assignment: the employee chooses the responsible department, and any
 * authorised employee of that department may work the ticket.
 *
 * STATE IS DERIVED, NEVER A MUTABLE FIELD — the ticket record holds the facts
 * at open and is never rewritten. Status, priority, responsible department,
 * assignment, resolution and every timestamp are derived from the append-only
 * activity entries, the same way an exception's state is derived from its
 * events. Nothing is ever deleted.
 *
 * VISIBILITY IS ENFORCED HERE, NOT IN CSS — every activity carries
 * 'internal' or 'customer_visible'. A customer read path can only ever
 * return customer-visible entries; internal notes, routing, department names,
 * escalations, tasks and employee identity never cross that line.
 *
 * SLA — NOT CONFIGURED. RAF has approved no first-response or resolution
 * target, so no countdown, "near SLA" count or breach is produced. Each ticket
 * records the SLA state that applied at open and that snapshot is never
 * rewritten by a later configuration change.
 *
 * CONCURRENCY — each racing transition is ONE append-only entry with a
 * deterministic id, so a duplicate append loses and the winner is whatever the
 * store read back; per-ticket work is additionally serialised with an
 * exclusive Web Lock where the browser has one. Lifecycle writes therefore
 * return a Promise. This is as safe as this prototype's architecture allows:
 * localStorage has no transaction, so two tabs writing the SAME list at the
 * same instant can still lose an append. Production needs a server store with
 * conditional writes (see raf_foundations.md).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFCustomerService) return;

  var VERSION = 1;
  var LIMITS = { subject:150, description:4000, body:4000, title:150, reason:500, resolution:2000 };

  /* ---------- vocabulary (values are lowercase, RAF's existing convention) ---------- */
  var TYPE       = { ORDER_LINKED:'order_linked', GENERAL:'general' };
  var SOURCE     = { CUSTOMER:'customer', ACTIVE_ORDER:'active_order', OLD_ORDER:'old_order',
                     CUSTOMER_SERVICE:'customer_service', ORDER:'order' };
  var PRIORITY   = { LOW:'low', NORMAL:'normal', HIGH:'high', CRITICAL:'critical' };
  var PRIORITIES = [PRIORITY.LOW, PRIORITY.NORMAL, PRIORITY.HIGH, PRIORITY.CRITICAL];
  var STATUS     = { NEW:'new', OPEN:'open', PENDING:'pending',
                     RESOLVED:'resolved', CLOSED:'closed', REOPENED:'reopened' };
  var VIS        = { INTERNAL:'internal', CUSTOMER:'customer_visible' };
  var TASK       = { OPEN:'open', COMPLETED:'completed' };
  var FOLLOWUP   = { OPEN:'open', COMPLETED:'completed', CANCELLED:'cancelled' };
  var ESCALATION = { OPEN:'open' };

  /* Transfer is an ACTION, never a status: the ticket keeps its id, customer,
     conversation, activities, tasks, follow-ups, history and relations. */
  var TRANSITIONS = {
    'new':      [STATUS.OPEN],
    'open':     [STATUS.PENDING, STATUS.RESOLVED],
    'pending':  [STATUS.OPEN],
    'resolved': [STATUS.CLOSED],
    'closed':   [STATUS.REOPENED],
    'reopened': [STATUS.OPEN]
  };
  var ACTIVE = [STATUS.NEW, STATUS.OPEN, STATUS.PENDING, STATUS.REOPENED];

  var STATUS_TXT = {
    'new':      { ar:'جديدة',        en:'New' },
    'open':     { ar:'مفتوحة',       en:'Open' },
    'pending':  { ar:'معلّقة',       en:'Pending' },
    'resolved': { ar:'تم الحل',      en:'Resolved' },
    'closed':   { ar:'مغلقة',        en:'Closed' },
    'reopened': { ar:'أُعيد فتحها',  en:'Reopened' }
  };
  var PRIORITY_TXT = {
    'low':      { ar:'منخفضة', en:'Low' },
    'normal':   { ar:'عادية',  en:'Normal' },
    'high':     { ar:'مرتفعة', en:'High' },
    'critical': { ar:'حرجة',   en:'Critical' }
  };

  /* ---------- departments = existing RAF roles ----------
     Nothing is invented: each department IS a role that already exists in
     RAFPerm, so a department's members are simply that role's active
     accounts. super_admin belongs to no department and may act anywhere. */
  var DEPARTMENTS = {
    customer_service: { key:'customer_service', roleId:'customer_service', ar:'خدمة العملاء',        en:'Customer Service' },
    logistics:        { key:'logistics',        roleId:'ops_manager',      ar:'العمليات واللوجستيات', en:'Operations & Logistics' },
    finance:          { key:'finance',          roleId:'finance',          ar:'المالية',              en:'Finance' },
    management:       { key:'management',       roleId:'higher_mgmt',      ar:'الإدارة العليا',       en:'Higher Management' }
  };
  var DEPARTMENT_KEYS = Object.keys(DEPARTMENTS);
  var MANAGEMENT_ROLES = ['super_admin', 'higher_mgmt'];

  /* permission keys — the five in the `support` module, no other key is used */
  var P = { VIEW:'support.view', CREATE:'support.create', MANAGE:'support.manage',
            RESOLVE:'support.resolve', ESCALATE:'support.escalate' };

  var RELATION_TYPES = ['customer', 'order', 'payment', 'wallet_transaction',
                        'delivery', 'compensation', 'driver', 'ticket'];

  /* ---------- language / errors ---------- */
  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    UNAUTHENTICATED:    { ar:'يجب تسجيل الدخول.',                              en:'You need to be signed in.' },
    ACTOR_INACTIVE:     { ar:'حسابك موقوف.',                                    en:'Your account is suspended.' },
    FORBIDDEN:          { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',               en:'You do not have permission to do that.' },
    WRONG_DEPARTMENT:   { ar:'هذه التذكرة تخص قسماً آخر.',                      en:'This ticket belongs to another department.' },
    NOT_FOUND:          { ar:'التذكرة غير موجودة.',                             en:'The ticket could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',             en:'The request contains fields that are not accepted.' },
    INVALID:            { ar:'راجع الحقول المطلوبة.',                           en:'Check the required fields.' },
    INVALID_CUSTOMER:   { ar:'العميل غير موجود.',                               en:'That customer does not exist.' },
    INVALID_ORDER:      { ar:'الطلب غير موجود.',                                en:'That order could not be found.' },
    ORDER_NOT_CUSTOMER: { ar:'هذا الطلب لا يخص هذا العميل.',                    en:'That order does not belong to this customer.' },
    ORDER_REQUIRED:     { ar:'تذكرة مرتبطة بطلب تتطلب رقم الطلب.',              en:'An order-linked ticket needs an order.' },
    DUPLICATE:          { ar:'توجد تذكرة مفتوحة لنفس المشكلة.',                 en:'An active ticket already exists for the same problem.' },
    INVALID_TRANSITION: { ar:'لا يمكن نقل التذكرة إلى هذه الحالة.',             en:'The ticket cannot move to that status.' },
    RESOLUTION_REQUIRED:{ ar:'يلزم وصف الحل.',                                  en:'A resolution description is required.' },
    REASON_REQUIRED:    { ar:'يلزم ذكر السبب.',                                 en:'A reason is required.' },
    NOT_RESOLVED:       { ar:'لا يمكن إغلاق تذكرة لم تُحل.',                    en:'Only a resolved ticket can be closed.' },
    ALREADY_CLAIMED:    { ar:'استلم التذكرة موظف آخر.',                         en:'Another employee already claimed this ticket.' },
    NOT_ASSIGNED:       { ar:'التذكرة غير مُستلمة.',                            en:'This ticket is not claimed.' },
    STATE_CHANGED:      { ar:'تغيّرت حالة التذكرة من جلسة أخرى. أعد التحميل.',  en:'This ticket changed in another session. Reload and try again.' },
    SAME_DEPARTMENT:    { ar:'التذكرة في هذا القسم بالفعل.',                    en:'The ticket is already in that department.' },
    UNKNOWN_DEPARTMENT: { ar:'قسم غير معروف.',                                  en:'Unknown department.' },
    UNKNOWN_EMPLOYEE:   { ar:'الموظف غير موجود أو لا يخص هذا القسم.',           en:'That employee does not exist in that department.' },
    TASK_NOT_FOUND:     { ar:'المهمة غير موجودة.',                              en:'That task could not be found.' },
    TASK_DONE:          { ar:'المهمة منجزة بالفعل.',                            en:'That task is already completed.' },
    FOLLOWUP_NOT_FOUND: { ar:'المتابعة غير موجودة.',                            en:'That follow-up could not be found.' },
    FOLLOWUP_CLOSED:    { ar:'المتابعة منتهية بالفعل.',                         en:'That follow-up is already finished.' },
    RELATION_INVALID:   { ar:'المرجع المرتبط غير صالح.',                        en:'That related record is not valid.' },
    RELATION_FORBIDDEN: { ar:'لا تملك صلاحية ربط هذا السجل.',                   en:'You may not link that record.' },
    NOT_LINKED:         { ar:'هذا الارتباط غير موجود.',                         en:'That link does not exist.' },
    TICKET_CLOSED:      { ar:'التذكرة مغلقة. أعد فتحها أولاً.',                 en:'This ticket is closed. Reopen it first.' },
    PERSIST_FAILED:     { ar:'تعذّر الحفظ.',                                    en:'Could not save.' },
    STORE_UNAVAILABLE:  { ar:'تعذّر الوصول إلى التخزين.',                       en:'The record store is unavailable.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    return Object.assign({ ok:false, code:code, message:T(m.ar, m.en) }, extra || {});
  }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function text(v){ return typeof v === 'string' ? v.trim() : ''; }
  function badKeys(o, allowed){ return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; }); }
  function within(s, max){ return !!s && s.length <= max; }

  /* ---------- storage ---------- */
  function coll(name){
    if (!global.RAFRecordStore) return null;
    try { return RAFRecordStore.collection(name); } catch (e) { return null; }
  }
  function rows(name){ var c = coll(name); return c ? c.all() : []; }
  function newId(prefix){
    return global.RAFRecordStore ? RAFRecordStore.makeId(prefix)
      : prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function bySeq(a, b){
    if ((a.at || 0) !== (b.at || 0)) return (a.at || 0) - (b.at || 0);
    return (a.seq || 0) - (b.seq || 0);
  }
  /* APPEND, THEN READ BACK — a racing transition is only reported as done when
     the store hands the entry back. It narrows, and never closes, the window in
     which localStorage loses one of two simultaneous writes to the same list:
     without a transaction the loser can still be overwritten afterwards. The
     deterministic entry id is what keeps the OUTCOME single-valued. */
  function appendChecked(collName, idField, rec){
    var c = coll(collName); if (!c) return { ok:false, reason:'store_unavailable' };
    var r = c.append(idField, rec);
    if (!r.ok) return r;
    var back = c.byId(idField, rec[idField]);
    if (!back) return { ok:false, reason:'append_lost' };
    return { ok:true, duplicate:!!r.duplicate, record:back };
  }

  /* ---------- serialisation ----------
     Same approach as RAFCompensation: an exclusive Web Lock narrows the window
     in which two tabs interleave a read and a write. It is an optimisation on
     top of the deterministic append ids, never the correctness argument. */
  var locks = null;
  try { locks = global.navigator && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null; }
  catch (e) { locks = null; }
  function serialized(name, fn){
    if (!locks) { try { return Promise.resolve(fn()); } catch (e) { return Promise.resolve(fail('PERSIST_FAILED')); } }
    return locks.request('raf-support:' + name, { mode:'exclusive' }, function () { return fn(); })
                .catch(function () { return fail('PERSIST_FAILED'); });
  }

  /* ══════════════════════ IDENTITY ══════════════════════
     Never the caller's word. The session, or nobody. */
  function session(){
    try {
      if (!global.RAFPerm || !RAFPerm.currentUser) return null;
      var u = RAFPerm.currentUser();
      return u && u.id ? u : null;
    } catch (e) { return null; }
  }
  function departmentOfRole(roleId){
    for (var i = 0; i < DEPARTMENT_KEYS.length; i++) {
      if (DEPARTMENTS[DEPARTMENT_KEYS[i]].roleId === roleId) return DEPARTMENT_KEYS[i];
    }
    return null;
  }
  function can(userId, key){
    try { return !!RAFPerm.can(userId, key); } catch (e) { return false; }
  }
  /* the acting account, with everything this module is allowed to know */
  function actor(){
    var u = session();
    if (!u) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var isMgmt = MANAGEMENT_ROLES.indexOf(u.roleId) > -1;
    return {
      ok:true, id:u.id, name:u.name || u.id, roleId:u.roleId || null,
      isCustomer: u.roleId === 'customer',
      isManagement: isMgmt,
      department: departmentOfRole(u.roleId),
      /* super_admin holds every key but sits in no department */
      crossDepartment: isMgmt
    };
  }
  /* an employee of the Customer Service domain: holds at least support.view */
  function staff(key){
    var a = actor(); if (!a.ok) return a;
    if (a.isCustomer) return fail('FORBIDDEN');
    if (!can(a.id, key || P.VIEW)) return fail('FORBIDDEN');
    return a;
  }
  function departmentMembers(depKey){
    var d = DEPARTMENTS[depKey]; if (!d || !global.RAFPerm) return [];
    var users = []; try { users = RAFPerm.getUsers() || []; } catch (e) { users = []; }
    return users.filter(function (u) { return u && u.status === 'active' && u.roleId === d.roleId; })
                .map(function (u) { return u.id; });
  }
  function employeeName(id){
    if (!id) return null;
    try { var u = RAFPerm.getUser(id); return u ? (u.name || id) : id; } catch (e) { return id; }
  }

  /* ══════════════════════ DERIVED STATE ══════════════════════ */
  function ticketRecord(ticketId){
    var c = coll('support_tickets');
    return c ? c.byId('ticketId', ticketId) : null;
  }
  function activitiesOf(ticketId){
    return rows('support_activities').filter(function (r) { return r.ticketId === ticketId; }).sort(bySeq);
  }
  function tasksRowsOf(ticketId){
    return rows('support_tasks').filter(function (r) { return r.ticketId === ticketId; }).sort(bySeq);
  }
  function followupRowsOf(ticketId){
    return rows('support_followups').filter(function (r) { return r.ticketId === ticketId; }).sort(bySeq);
  }
  function relationRowsOf(ticketId){
    return rows('support_relations').filter(function (r) { return r.ticketId === ticketId; }).sort(bySeq);
  }
  function escalationsOf(ticketId){
    return rows('support_escalations').filter(function (r) { return r.ticketId === ticketId; }).sort(bySeq);
  }

  /* the ticket as it stands now — computed, never stored */
  function derive(rec, acts){
    var t = {
      ticketId:rec.ticketId, customerId:rec.customerId, type:rec.type, source:rec.source,
      context:copy(rec.context) || { orderId:null, previousTicketId:null },
      category:rec.category, subject:rec.subject, description:rec.description,
      priority:rec.priority, status:STATUS.NEW,
      responsibleDepartment:rec.responsibleDepartment, assignedEmployeeId:null,
      createdAt:rec.createdAt, createdBy:copy(rec.createdBy), updatedAt:rec.createdAt,
      claimedAt:null, resolvedAt:null, closedAt:null, reopenedAt:null, firstResponseAt:null,
      sla:copy(rec.sla), resolution:{ code:null, description:null },
      statusChanges:0, version:rec.version || VERSION
    };
    acts.forEach(function (a) {
      t.updatedAt = Math.max(t.updatedAt, a.at || 0);
      switch (a.kind) {
        case 'status':
          t.status = a.to; t.statusChanges++;
          if (a.to === STATUS.RESOLVED) { t.resolvedAt = a.at; t.resolution = { code:a.resolutionCode || null, description:a.resolution || null }; }
          if (a.to === STATUS.CLOSED)   t.closedAt = a.at;
          if (a.to === STATUS.REOPENED) t.reopenedAt = a.at;
          break;
        case 'claim':
          t.assignedEmployeeId = a.toEmployeeId; t.claimedAt = a.at;
          break;
        case 'transfer':
          t.responsibleDepartment = a.toDepartment;
          t.assignedEmployeeId = a.toEmployeeId || null;
          break;
        case 'priority':
          t.priority = a.to;
          break;
        case 'update':
          if (a.fields && a.fields.category) t.category = a.fields.category;
          if (a.fields && a.fields.subject)  t.subject  = a.fields.subject;
          break;
        case 'message':
          if (!t.firstResponseAt && a.direction === 'outbound') t.firstResponseAt = a.at;
          break;
      }
    });
    return t;
  }
  function stateOf(ticketId){
    var rec = ticketRecord(ticketId);
    return rec ? derive(rec, activitiesOf(ticketId)) : null;
  }
  function isActive(status){ return ACTIVE.indexOf(status) > -1; }

  function deriveTask(entries){
    var first = entries[0], t = {
      taskId:first.taskId, ticketId:first.ticketId, title:first.title, description:first.description,
      department:first.department, assignedEmployeeId:first.assignedEmployeeId || null,
      priority:first.priority, status:TASK.OPEN, createdAt:first.at, createdBy:first.actorId,
      completedAt:null, completedBy:null
    };
    entries.slice(1).forEach(function (e) {
      if (e.kind === 'updated') {
        if (e.title) t.title = e.title;
        if (e.description != null) t.description = e.description;
        if (e.priority) t.priority = e.priority;
        if (e.assignedEmployeeId !== undefined) t.assignedEmployeeId = e.assignedEmployeeId;
      }
      if (e.kind === 'completed') { t.status = TASK.COMPLETED; t.completedAt = e.at; t.completedBy = e.actorId; }
    });
    return t;
  }
  function tasksOf(ticketId){
    var byId = {};
    tasksRowsOf(ticketId).forEach(function (r) { (byId[r.taskId] = byId[r.taskId] || []).push(r); });
    return Object.keys(byId).map(function (id) { return deriveTask(byId[id]); })
                 .sort(function (a, b) { return a.createdAt - b.createdAt; });
  }
  function deriveFollowUp(entries){
    var first = entries[0], f = {
      followUpId:first.followUpId, ticketId:first.ticketId, customerId:first.customerId,
      dueAt:first.dueAt, reason:first.reason, assignedEmployeeId:first.assignedEmployeeId,
      status:FOLLOWUP.OPEN, createdAt:first.at, completedAt:null, cancelledAt:null, closedBy:null
    };
    entries.slice(1).forEach(function (e) {
      if (e.kind === 'completed') { f.status = FOLLOWUP.COMPLETED; f.completedAt = e.at; f.closedBy = e.actorId; }
      if (e.kind === 'cancelled') { f.status = FOLLOWUP.CANCELLED; f.cancelledAt = e.at; f.closedBy = e.actorId; }
    });
    return f;
  }
  function followUpsOf(ticketId){
    var byId = {};
    followupRowsOf(ticketId).forEach(function (r) { (byId[r.followUpId] = byId[r.followUpId] || []).push(r); });
    return Object.keys(byId).map(function (id) { return deriveFollowUp(byId[id]); })
                 .sort(function (a, b) { return a.dueAt - b.dueAt; });
  }
  function relationsOf(ticketId){
    var live = {};
    relationRowsOf(ticketId).forEach(function (r) {
      var k = r.recordType + '|' + r.recordId;
      if (r.kind === 'link') live[k] = { recordType:r.recordType, recordId:r.recordId, verified:!!r.verified, linkedAt:r.at, linkedBy:r.actorId };
      else delete live[k];
    });
    return Object.keys(live).map(function (k) { return live[k]; });
  }

  /* ══════════════════════ ACCESS ══════════════════════ */
  /* an employee may act on a ticket when they hold the key AND the ticket is
     their department's — management crosses departments by role design */
  function reach(a, t){
    if (a.crossDepartment) return true;
    return a.department != null && a.department === t.responsibleDepartment;
  }
  function employeeOn(ticketId, key){
    var a = staff(key); if (!a.ok) return a;
    var t = stateOf(ticketId); if (!t) return fail('NOT_FOUND');
    if (!reach(a, t)) return fail('WRONG_DEPARTMENT');
    return { ok:true, a:a, t:t };
  }
  /* the customer's own ticket, proven from the record — never from input */
  function customerOn(ticketId){
    var a = actor(); if (!a.ok) return a;
    if (!a.isCustomer) return fail('FORBIDDEN');
    var t = stateOf(ticketId); if (!t) return fail('NOT_FOUND');
    if (t.customerId !== a.id) return fail('FORBIDDEN');
    return { ok:true, a:a, t:t };
  }

  /* ══════════════════════ SLA (not configured) ══════════════════════
     The snapshot written at open. A later configuration change never rewrites
     it, and nothing derives a historical target from the current value. */
  function slaSnapshot(at){
    function one(key){
      var g = null;
      try { g = global.RAFConfig ? RAFConfig.get(key) : null; } catch (e) { g = null; }
      if (!g || !g.ok) return { configured:false, status:'not_configured', minutes:null, dueAt:null };
      return { configured:!!g.configured, status:g.status, minutes:g.configured ? g.value : null,
               dueAt:g.configured ? at + (g.value * 60000) : null };
    }
    return { firstResponse:one('support.firstResponseMinutes'),
             resolution:one('support.resolutionMinutes'), recordedAt:at };
  }
  function slaConfigured(){
    return { firstResponse:!!(global.RAFConfig && RAFConfig.isConfigured('support.firstResponseMinutes')),
             resolution:!!(global.RAFConfig && RAFConfig.isConfigured('support.resolutionMinutes')) };
  }
  function categories(){
    var list = null;
    try { list = global.RAFConfig ? RAFConfig.value('support.categories') : null; } catch (e) { list = null; }
    return Array.isArray(list) ? list : [];
  }
  function categoryOf(key){
    return categories().filter(function (c) { return c.key === key; })[0] || null;
  }

  /* ══════════════════════ AUDIT · EVENTS · NOTIFY ══════════════════════ */
  function audit(action, t, a, extra){
    if (!global.RAFAudit) return;
    try {
      var o = Object.assign({
        action:action, actor:{ id:a.id }, source:a.isCustomer ? 'customer' : 'admin',
        orderId:(t && t.context && t.context.orderId) || null
      }, extra || {});
      o.metadata = Object.assign({ ticketId:t ? t.ticketId : null, customerId:t ? t.customerId : null },
                                 o.metadata || {});
      RAFAudit.record(o);
    } catch (e) {}
  }
  function emit(type, t, payload){
    if (!global.RAFEventBus) return;
    try {
      RAFEventBus.publish(type, { entityId:t.ticketId, entityType:'ticket',
        payload:Object.assign({ ticketId:t.ticketId, department:t.responsibleDepartment }, payload || {}) });
    } catch (e) {}
  }
  /* department members, minus whoever just acted — an employee is not told
     about their own action. Nothing internal travels in the text. */
  function notifyDepartment(eventType, depKey, t, actorId, extra){
    if (!global.RAFNotify || !RAFNotify.create) return 0;
    var def = (RAFNotify.EVENT_TYPES || {})[eventType];
    if (!def) return 0;
    var n = 0;
    departmentMembers(depKey).forEach(function (uid) {
      if (uid === actorId) return;
      var r = RAFNotify.create(Object.assign({
        recipientUserId:uid, eventType:eventType, title:def.title, entityType:'ticket',
        entityId:t.ticketId, source:'admin', href:'raf_customer_service.html#/tickets/all?t=' + t.ticketId,
        metadata:{ ticketId:t.ticketId }
      }, extra || {}));
      if (r && r.ok && !r.duplicate) n++;
    });
    return n;
  }
  function notifyCustomer(eventType, t, extra){
    if (!global.RAFNotify || !RAFNotify.create || !t.customerId) return false;
    var def = (RAFNotify.EVENT_TYPES || {})[eventType];
    if (!def) return false;
    var r = RAFNotify.create(Object.assign({
      recipientUserId:t.customerId, eventType:eventType, title:def.title, entityType:'ticket',
      entityId:t.ticketId, source:'admin', href:'raf_support.html?ticket=' + t.ticketId,
      metadata:{ ticketId:t.ticketId }
    }, extra || {}));
    return !!(r && r.ok);
  }

  /* ══════════════════════ RELATED RECORDS ══════════════════════
     A reference is stored, never a copy. Existence is proven through the
     owning authority where this prototype exposes a read that does not need
     to impersonate somebody; otherwise the link is kept with verified:false
     and says so. */
  function orderSnapshot(orderId){
    try { return global.RAFOrderSnapshot ? RAFOrderSnapshot.of(orderId) : null; } catch (e) { return null; }
  }
  function orderCustomerId(orderId){
    var s = orderSnapshot(orderId);
    return s && s.customer ? (s.customer.id || null) : null;
  }
  function verifyRelation(type, id, customerId){
    switch (type) {
      case 'customer': {
        var u = null; try { u = RAFPerm.getUser(id); } catch (e) { u = null; }
        if (!u) return { ok:false };
        return { ok:true, verified:true };
      }
      case 'order':
      case 'delivery': {
        var s = orderSnapshot(id);
        if (!s) return { ok:false };
        var oc = s.customer ? s.customer.id : null;
        /* a ticket never links an order belonging to a different customer */
        if (customerId && oc && oc !== customerId) return { ok:false, cross:true };
        return { ok:true, verified:true };
      }
      case 'driver': {
        var d = null; try { d = RAFPerm.getUser(id); } catch (e) { d = null; }
        if (!d || d.roleId !== 'driver') return { ok:false };
        return { ok:true, verified:true };
      }
      case 'compensation': {
        var c = null;
        try { c = global.RAFCompensation ? (RAFCompensation.get(id) || RAFCompensation.forOrder(id)) : null; } catch (e) { c = null; }
        return c ? { ok:true, verified:true } : { ok:true, verified:false };
      }
      case 'ticket': {
        return ticketRecord(id) ? { ok:true, verified:true } : { ok:false };
      }
      case 'payment':
      case 'wallet_transaction':
        /* RAF exposes no read for either that an employee may perform: the
           wallet is readable only by its own signed-in customer. The
           reference is kept and honestly marked unverified. */
        return { ok:true, verified:false };
      default:
        return { ok:false };
    }
  }

  /* ══════════════════════ READS ══════════════════════ */
  function visibleActivities(t, forCustomer){
    return activitiesOf(t.ticketId).filter(function (a) {
      return forCustomer ? a.visibility === VIS.CUSTOMER : true;
    }).map(function (a) {
      if (!forCustomer) {
        return { activityId:a.activityId, kind:a.kind, at:a.at, visibility:a.visibility,
                 actorId:a.actorId, actorName:employeeName(a.actorId), actorRole:a.actorRole,
                 body:a.body || null, from:a.from || null, to:a.to || null,
                 fromDepartment:a.fromDepartment || null, toDepartment:a.toDepartment || null,
                 toEmployeeId:a.toEmployeeId || null, reason:a.reason || null,
                 resolution:a.resolution || null, direction:a.direction || null, fields:a.fields || null };
      }
      /* the customer sees the conversation and nothing else: no employee
         identity, no department, no reason, no internal field change */
      return { activityId:a.activityId, kind:a.kind, at:a.at, body:a.body || null,
               direction:a.direction || null, fromCustomer:a.direction === 'inbound' };
    });
  }
  function present(t, opts){
    opts = opts || {};
    var out = copy(t);
    out.statusText = STATUS_TXT[t.status] || null;
    out.priorityText = PRIORITY_TXT[t.priority] || null;
    out.departmentText = DEPARTMENTS[t.responsibleDepartment]
      ? { ar:DEPARTMENTS[t.responsibleDepartment].ar, en:DEPARTMENTS[t.responsibleDepartment].en } : null;
    out.assignedEmployeeName = employeeName(t.assignedEmployeeId);
    out.active = isActive(t.status);
    if (opts.full) {
      out.activities  = visibleActivities(t, false);
      out.tasks       = tasksOf(t.ticketId);
      out.followUps   = followUpsOf(t.ticketId);
      out.relations   = relationsOf(t.ticketId);
      out.escalations = escalationsOf(t.ticketId).map(function (e) {
        return { escalationId:e.escalationId, actorId:e.actorId, actorName:employeeName(e.actorId),
                 reason:e.reason, description:e.description, createdAt:e.at, status:e.status };
      });
    }
    return out;
  }
  /* what a CUSTOMER is allowed to see of their own ticket */
  function presentForCustomer(t){
    return {
      ticketId:t.ticketId, type:t.type, source:t.source,
      context:{ orderId:t.context ? t.context.orderId : null },
      category:t.category, subject:t.subject, description:t.description,
      status:t.status, statusText:STATUS_TXT[t.status] || null,
      active:isActive(t.status),
      createdAt:t.createdAt, updatedAt:t.updatedAt, resolvedAt:t.resolvedAt, closedAt:t.closedAt,
      resolution:{ description:t.resolution ? t.resolution.description : null },
      messages:visibleActivities(t, true)
    };
  }

  function getTicket(ticketId, opts){
    opts = opts || {};
    var a = actor(); if (!a.ok) return a;
    var t = stateOf(ticketId); if (!t) return fail('NOT_FOUND');
    if (a.isCustomer) {
      if (t.customerId !== a.id) return fail('FORBIDDEN');
      return { ok:true, audience:'customer', ticket:presentForCustomer(t) };
    }
    if (!can(a.id, P.VIEW)) return fail('FORBIDDEN');
    if (!reach(a, t)) return fail('WRONG_DEPARTMENT');
    return { ok:true, audience:'employee', ticket:present(t, { full:opts.full !== false }) };
  }

  /* every ticket this account may see: its own department's, or — for a
     customer — only their own */
  function scopeTickets(a){
    var all = rows('support_tickets').map(function (rec) { return derive(rec, activitiesOf(rec.ticketId)); });
    if (a.isCustomer) return all.filter(function (t) { return t.customerId === a.id; });
    if (a.crossDepartment) return all;
    return all.filter(function (t) { return t.responsibleDepartment === a.department; });
  }
  function listTickets(filters){
    filters = filters || {};
    var bad = badKeys(filters, ['status', 'statuses', 'department', 'category', 'priority',
                                'assignedEmployeeId', 'customerId', 'orderId', 'type', 'source',
                                'active', 'unassigned', 'escalated', 'from', 'to', 'limit']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = actor(); if (!a.ok) return a;
    if (!a.isCustomer && !can(a.id, P.VIEW)) return fail('FORBIDDEN');

    var escalated = {};
    rows('support_escalations').forEach(function (e) { escalated[e.ticketId] = true; });

    var list = scopeTickets(a).filter(function (t) {
      if (filters.status && t.status !== filters.status) return false;
      if (filters.statuses && filters.statuses.indexOf(t.status) < 0) return false;
      if (filters.department && t.responsibleDepartment !== filters.department) return false;
      if (filters.category && t.category !== filters.category) return false;
      if (filters.priority && t.priority !== filters.priority) return false;
      if (filters.type && t.type !== filters.type) return false;
      if (filters.source && t.source !== filters.source) return false;
      if (filters.customerId && t.customerId !== filters.customerId) return false;
      if (filters.orderId && (!t.context || t.context.orderId !== filters.orderId)) return false;
      if (filters.assignedEmployeeId && t.assignedEmployeeId !== filters.assignedEmployeeId) return false;
      if (filters.unassigned && t.assignedEmployeeId) return false;
      if (filters.active != null && isActive(t.status) !== !!filters.active) return false;
      if (filters.escalated && !escalated[t.ticketId]) return false;
      if (filters.from && t.createdAt < filters.from) return false;
      if (filters.to && t.createdAt > filters.to) return false;
      return true;
    }).sort(function (x, y) { return y.updatedAt - x.updatedAt; });

    if (filters.limit) list = list.slice(0, filters.limit);
    if (a.isCustomer) return { ok:true, audience:'customer', items:list.map(presentForCustomer) };
    return { ok:true, audience:'employee', items:list.map(function (t) {
      var o = present(t); o.escalated = !!escalated[t.ticketId]; return o; }) };
  }

  /* free-text search over the fields this account may already read. It filters
     the SAME scoped list, so it can never surface a ticket the actor could not
     open. Customer name / phone / email are matched through RAFPerm for staff
     only, because a customer searching their own tickets needs neither. */
  function searchTickets(query, filters){
    var q = text(query).toLowerCase();
    var base = listTickets(filters || {});
    if (!base.ok || !q) return base;
    var matchIds = {};
    if (base.audience === 'employee' && global.RAFPerm) {
      var users = []; try { users = RAFPerm.getUsers() || []; } catch (e) { users = []; }
      users.forEach(function (u) {
        var hay = [u.id, u.name, u.email, u.phone].filter(Boolean).join(' ').toLowerCase();
        if (hay.indexOf(q) > -1) matchIds[u.id] = true;
      });
    }
    return { ok:true, audience:base.audience, query:q, items:base.items.filter(function (t) {
      var hay = [t.ticketId, t.subject, t.description, t.category,
                 (t.context && t.context.orderId) || ''].join(' ').toLowerCase();
      if (hay.indexOf(q) > -1) return true;
      return !!(t.customerId && matchIds[t.customerId]);
    }) };
  }

  /* ══════════════════════ DUPLICATE PREVENTION ══════════════════════
     The same customer may absolutely have several distinct problems with the
     same department. A duplicate is the same PROBLEM: same customer, same
     responsible department, same category and same order context, while a
     ticket for it is still active. */
  function dupKey(customerId, department, category, orderId){
    return [customerId, department, category, orderId || 'none'].join('|');
  }
  function activeDuplicate(key){
    var hit = null;
    rows('support_tickets').forEach(function (rec) {
      if (dupKey(rec.customerId, rec.responsibleDepartment, rec.category,
                 rec.context && rec.context.orderId) !== key) return;
      var t = derive(rec, activitiesOf(rec.ticketId));
      /* the department can be transferred away; the guard follows the ticket
         as it was opened, and only an ACTIVE one blocks */
      if (isActive(t.status) && !hit) hit = t;
    });
    return hit;
  }
  function duplicateCheck(input){
    input = input || {};
    var bad = badKeys(input, ['customerId', 'department', 'category', 'orderId']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = actor(); if (!a.ok) return a;
    var customerId = a.isCustomer ? a.id : text(input.customerId);
    if (!a.isCustomer && !can(a.id, P.VIEW)) return fail('FORBIDDEN');
    if (!customerId) return fail('INVALID', { errors:[{ field:'customerId' }] });
    var dep = text(input.department) || 'customer_service';
    if (!DEPARTMENTS[dep]) return fail('UNKNOWN_DEPARTMENT');
    var key = dupKey(customerId, dep, text(input.category), text(input.orderId) || null);
    var hit = activeDuplicate(key);
    return { ok:true, duplicate:!!hit, key:key,
             ticketId:hit ? hit.ticketId : null, status:hit ? hit.status : null };
  }

  /* ══════════════════════ CREATE ══════════════════════ */
  function createTicket(input){
    input = input || {};
    var bad = badKeys(input, ['customerId', 'type', 'source', 'orderId', 'previousTicketId',
                              'category', 'subject', 'description', 'priority', 'department']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));

    var a = actor(); if (!a.ok) return Promise.resolve(a);
    /* a customer opens their own ticket; an employee needs support.create */
    if (!a.isCustomer && !can(a.id, P.CREATE)) return Promise.resolve(fail('FORBIDDEN'));

    var customerId = a.isCustomer ? a.id : text(input.customerId);
    if (!customerId) return Promise.resolve(fail('INVALID', { errors:[{ field:'customerId' }] }));
    var cu = null; try { cu = RAFPerm.getUser(customerId); } catch (e) { cu = null; }
    if (!cu || cu.roleId !== 'customer') return Promise.resolve(fail('INVALID_CUSTOMER'));

    var type = text(input.type) || TYPE.GENERAL;
    if (type !== TYPE.ORDER_LINKED && type !== TYPE.GENERAL) return Promise.resolve(fail('INVALID', { errors:[{ field:'type' }] }));
    var source = text(input.source) || (a.isCustomer ? SOURCE.CUSTOMER : SOURCE.CUSTOMER_SERVICE);
    var okSource = false;
    for (var s in SOURCE) if (SOURCE[s] === source) okSource = true;
    if (!okSource) return Promise.resolve(fail('INVALID', { errors:[{ field:'source' }] }));

    var orderId = text(input.orderId) || null;
    if (type === TYPE.ORDER_LINKED && !orderId) return Promise.resolve(fail('ORDER_REQUIRED'));
    if (orderId) {
      var snap = orderSnapshot(orderId);
      if (!snap) return Promise.resolve(fail('INVALID_ORDER'));
      var oc = snap.customer ? snap.customer.id : null;
      if (oc && oc !== customerId) return Promise.resolve(fail('ORDER_NOT_CUSTOMER'));
      if (!oc && a.isCustomer) return Promise.resolve(fail('ORDER_NOT_CUSTOMER'));
    }
    var prev = text(input.previousTicketId) || null;
    if (prev && !ticketRecord(prev)) return Promise.resolve(fail('INVALID', { errors:[{ field:'previousTicketId' }] }));

    var category = text(input.category);
    if (!categoryOf(category)) return Promise.resolve(fail('INVALID', { errors:[{ field:'category' }] }));
    var subject = text(input.subject), description = text(input.description);
    var errors = [];
    if (!within(subject, LIMITS.subject)) errors.push({ field:'subject' });
    if (!within(description, LIMITS.description)) errors.push({ field:'description' });
    var priority = text(input.priority) || PRIORITY.NORMAL;
    if (PRIORITIES.indexOf(priority) < 0) errors.push({ field:'priority' });
    if (errors.length) return Promise.resolve(fail('INVALID', { errors:errors }));

    /* the employee chooses the department; a customer's ticket always starts
       with Customer Service, which owns the customer relationship */
    var department = a.isCustomer ? 'customer_service' : (text(input.department) || 'customer_service');
    if (!DEPARTMENTS[department]) return Promise.resolve(fail('UNKNOWN_DEPARTMENT'));

    var key = dupKey(customerId, department, category, orderId);
    return serialized('new:' + key, function () {
      var existing = activeDuplicate(key);
      if (existing) return fail('DUPLICATE', { ticketId:existing.ticketId, status:existing.status });

      var acts = coll('support_activities'), tix = coll('support_tickets');
      if (!acts || !tix) return fail('STORE_UNAVAILABLE');

      /* first-writer-wins: both racers compute the same guard id, so the
         second append comes back as a duplicate and loses */
      var seq = rows('support_tickets').filter(function (r) {
        return dupKey(r.customerId, r.responsibleDepartment, r.category, r.context && r.context.orderId) === key;
      }).length;
      var ticketId = newId('tkt');
      var guard = appendChecked('support_activities', 'activityId', {
        activityId:'cs|new|' + key + '|' + seq, ticketId:ticketId, kind:'guard',
        visibility:VIS.INTERNAL, at:Date.now(), actorId:a.id, actorRole:a.roleId, dupKey:key
      });
      if (!guard.ok) return fail('PERSIST_FAILED', { reason:guard.reason });   /* the guard is written BEFORE the ticket, so a lost guard never leaves an orphan ticket */
      if (guard.duplicate) {
        var winner = guard.record.ticketId;
        var w = stateOf(winner);
        return fail('DUPLICATE', { ticketId:winner, status:w ? w.status : null, race:true });
      }
      var now = Date.now();
      var rec = {
        ticketId:ticketId, customerId:customerId, type:type, source:source,
        context:{ orderId:orderId, previousTicketId:prev },
        category:category, subject:subject, description:description,
        priority:priority, responsibleDepartment:department,
        createdAt:now, createdBy:{ id:a.id, roleId:a.roleId, isCustomer:a.isCustomer },
        sla:slaSnapshot(now), version:VERSION
      };
      var w2 = appendChecked('support_tickets', 'ticketId', rec);
      if (!w2.ok) return fail('PERSIST_FAILED', { reason:w2.reason });

      var t = derive(w2.record, activitiesOf(ticketId));
      audit('ticket.created', t, a, { key:ticketId, newState:STATUS.NEW,
        metadata:{ type:type, source:source, category:category, department:department, priority:priority } });
      emit('support.ticket.created', t, { category:category, priority:priority });
      notifyDepartment('support.ticket.created', department, t, a.id);
      return { ok:true, ticket:present(t, { full:true }) };
    });
  }

  /* ══════════════════════ CLAIM ══════════════════════ */
  function claimTicket(ticketId){
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);
    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      if (!isActive(t.status)) return fail('TICKET_CLOSED');
      if (t.assignedEmployeeId) {
        return t.assignedEmployeeId === a.id ? { ok:true, already:true, ticket:present(t, { full:true }) }
                                             : fail('ALREADY_CLAIMED', { assignedEmployeeId:t.assignedEmployeeId });
      }
      var n = activitiesOf(ticketId).filter(function (x) { return x.kind === 'claim'; }).length;
      var r = appendChecked('support_activities', 'activityId', {
        activityId:'cs|' + ticketId + '|claim|' + n, ticketId:ticketId, kind:'claim',
        visibility:VIS.INTERNAL, at:Date.now(), actorId:a.id, actorRole:a.roleId,
        toEmployeeId:a.id, department:t.responsibleDepartment
      });
      if (!r.ok) return fail(r.reason === 'append_lost' ? 'STATE_CHANGED' : 'PERSIST_FAILED', { reason:r.reason });
      if (r.duplicate) {
        /* somebody else's claim already occupies this slot */
        return r.record.toEmployeeId === a.id ? { ok:true, already:true, ticket:present(stateOf(ticketId), { full:true }) }
                                              : fail('ALREADY_CLAIMED', { assignedEmployeeId:r.record.toEmployeeId });
      }
      var t2 = stateOf(ticketId);
      audit('ticket.claimed', t2, a, { key:r.record.activityId, newState:'assigned:' + a.id });
      emit('support.ticket.claimed', t2, { assignedEmployeeId:a.id });
      notifyDepartment('support.ticket.claimed', t2.responsibleDepartment, t2, a.id);
      return { ok:true, ticket:present(t2, { full:true }) };
    });
  }

  /* ══════════════════════ TRANSFER ══════════════════════
     The SAME ticket moves to another department. Never a replacement. */
  function transferTicket(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['toDepartment', 'toEmployeeId', 'reason']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);
    var to = text(input.toDepartment);
    if (!DEPARTMENTS[to]) return Promise.resolve(fail('UNKNOWN_DEPARTMENT'));
    var reason = text(input.reason);
    if (!within(reason, LIMITS.reason)) return Promise.resolve(fail('REASON_REQUIRED'));

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      if (!isActive(t.status)) return fail('TICKET_CLOSED');
      if (t.responsibleDepartment === to) return fail('SAME_DEPARTMENT');
      var toEmp = text(input.toEmployeeId) || null;
      if (toEmp && departmentMembers(to).indexOf(toEmp) < 0) return fail('UNKNOWN_EMPLOYEE');

      var n = activitiesOf(ticketId).filter(function (x) { return x.kind === 'transfer'; }).length;
      var r = appendChecked('support_activities', 'activityId', {
        activityId:'cs|' + ticketId + '|transfer|' + n, ticketId:ticketId, kind:'transfer',
        visibility:VIS.INTERNAL, at:Date.now(), actorId:a.id, actorRole:a.roleId,
        fromDepartment:t.responsibleDepartment, toDepartment:to,
        fromEmployeeId:t.assignedEmployeeId || null, toEmployeeId:toEmp, reason:reason
      });
      if (!r.ok) return fail(r.reason === 'append_lost' ? 'STATE_CHANGED' : 'PERSIST_FAILED', { reason:r.reason });
      if (r.duplicate) return fail('STATE_CHANGED', { toDepartment:r.record.toDepartment });

      var t2 = stateOf(ticketId);
      audit('ticket.transferred', t2, a, { key:r.record.activityId, reason:reason,
        previousState:'dept:' + t.responsibleDepartment, newState:'dept:' + to,
        metadata:{ fromEmployeeId:t.assignedEmployeeId || null, toEmployeeId:toEmp } });
      emit('support.ticket.transferred', t2, { fromDepartment:t.responsibleDepartment, toDepartment:to });
      notifyDepartment('support.ticket.transferred', to, t2, a.id);
      return { ok:true, ticket:present(t2, { full:true }) };
    });
  }

  /* ══════════════════════ UPDATE (fields + non-terminal status) ══════════════════════ */
  function updateTicket(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['priority', 'category', 'subject', 'status', 'reason']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      var acts = coll('support_activities'); if (!acts) return fail('STORE_UNAVAILABLE');
      var now = Date.now(), wrote = [];

      if (input.priority !== undefined) {
        var p = text(input.priority);
        if (PRIORITIES.indexOf(p) < 0) return fail('INVALID', { errors:[{ field:'priority' }] });
        if (p !== t.priority) {
          var rp = acts.append('activityId', {
            activityId:newId('act'), ticketId:ticketId, kind:'priority', visibility:VIS.INTERNAL,
            at:now, actorId:a.id, actorRole:a.roleId, from:t.priority, to:p });
          if (!rp.ok) return fail('PERSIST_FAILED');
          wrote.push('priority');
        }
      }
      var fields = {};
      if (input.category !== undefined) {
        var c = text(input.category);
        if (!categoryOf(c)) return fail('INVALID', { errors:[{ field:'category' }] });
        if (c !== t.category) fields.category = c;
      }
      if (input.subject !== undefined) {
        var sj = text(input.subject);
        if (!within(sj, LIMITS.subject)) return fail('INVALID', { errors:[{ field:'subject' }] });
        if (sj !== t.subject) fields.subject = sj;
      }
      if (Object.keys(fields).length) {
        var rf = acts.append('activityId', {
          activityId:newId('act'), ticketId:ticketId, kind:'update', visibility:VIS.INTERNAL,
          at:now, actorId:a.id, actorRole:a.roleId, fields:fields });
        if (!rf.ok) return fail('PERSIST_FAILED');
        wrote.push('fields');
      }
      if (input.status !== undefined) {
        var to = text(input.status);
        /* the terminal moves have their own authorised operations */
        if (to === STATUS.RESOLVED || to === STATUS.CLOSED || to === STATUS.REOPENED) {
          return fail('INVALID_TRANSITION', { from:t.status, to:to, use:'resolveTicket / closeTicket / reopenTicket' });
        }
        if ((TRANSITIONS[t.status] || []).indexOf(to) < 0) return fail('INVALID_TRANSITION', { from:t.status, to:to });
        var rs = appendChecked('support_activities', 'activityId', {
          activityId:'cs|' + ticketId + '|status|' + t.statusChanges, ticketId:ticketId, kind:'status',
          visibility:VIS.INTERNAL, at:now, actorId:a.id, actorRole:a.roleId,
          from:t.status, to:to, reason:text(input.reason) || null });
        if (!rs.ok) return fail(rs.reason === 'append_lost' ? 'STATE_CHANGED' : 'PERSIST_FAILED', { reason:rs.reason });
        if (rs.duplicate) return fail('STATE_CHANGED', { status:stateOf(ticketId).status });
        wrote.push('status');
      }
      if (!wrote.length) return { ok:true, unchanged:true, ticket:present(t, { full:true }) };

      var t2 = stateOf(ticketId);
      audit('ticket.updated', t2, a, { key:ticketId + ':update:' + now,
        previousState:t.status, newState:t2.status, metadata:{ changed:wrote } });
      emit('support.ticket.updated', t2, { changed:wrote, status:t2.status });
      return { ok:true, changed:wrote, ticket:present(t2, { full:true }) };
    });
  }

  /* ══════════════════════ COMMUNICATION ══════════════════════ */
  function addInternalNote(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['body']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);
    var body = text(input.body);
    if (!within(body, LIMITS.body)) return Promise.resolve(fail('INVALID', { errors:[{ field:'body' }] }));

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      var acts = coll('support_activities'); if (!acts) return fail('STORE_UNAVAILABLE');
      var r = acts.append('activityId', {
        activityId:newId('act'), ticketId:ticketId, kind:'note', visibility:VIS.INTERNAL,
        at:Date.now(), actorId:a.id, actorRole:a.roleId, body:body });
      if (!r.ok) return fail('PERSIST_FAILED');
      var t2 = stateOf(ticketId);
      audit('ticket.note_added', t2, a, { key:r.record.activityId });
      emit('support.ticket.updated', t2, { changed:['note'] });
      /* an internal note is never notified to the customer */
      return { ok:true, activityId:r.record.activityId, ticket:present(t2, { full:true }) };
    });
  }

  /* a reply the customer reads. An employee writes outbound; the customer
     writes inbound on their own ticket. */
  function addCustomerMessage(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['body']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var a0 = actor(); if (!a0.ok) return Promise.resolve(a0);
    var body = text(input.body);
    if (!within(body, LIMITS.body)) return Promise.resolve(fail('INVALID', { errors:[{ field:'body' }] }));

    return serialized(ticketId, function () {
      var g = a0.isCustomer ? customerOn(ticketId) : employeeOn(ticketId, P.MANAGE);
      if (!g.ok) return g;
      var a = g.a, t = g.t;
      if (t.status === STATUS.CLOSED) return fail('TICKET_CLOSED');
      var acts = coll('support_activities'); if (!acts) return fail('STORE_UNAVAILABLE');
      var r = acts.append('activityId', {
        activityId:newId('act'), ticketId:ticketId, kind:'message', visibility:VIS.CUSTOMER,
        at:Date.now(), actorId:a.id, actorRole:a.roleId, body:body,
        direction:a.isCustomer ? 'inbound' : 'outbound' });
      if (!r.ok) return fail('PERSIST_FAILED');
      var t2 = stateOf(ticketId);
      audit('ticket.message_added', t2, a, { key:r.record.activityId, metadata:{ direction:r.record.direction } });
      emit('support.ticket.updated', t2, { changed:['message'] });
      if (!a.isCustomer) notifyCustomer('support.ticket.message', t2);
      return { ok:true, activityId:r.record.activityId,
               ticket:a.isCustomer ? presentForCustomer(t2) : present(t2, { full:true }) };
    });
  }

  /* ══════════════════════ TASKS (child records of ONE ticket) ══════════════════════ */
  function createTask(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['title', 'description', 'department', 'assignedEmployeeId', 'priority']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);
    var title = text(input.title);
    if (!within(title, LIMITS.title)) return Promise.resolve(fail('INVALID', { errors:[{ field:'title' }] }));
    var dep = text(input.department) || pre.t.responsibleDepartment;
    if (!DEPARTMENTS[dep]) return Promise.resolve(fail('UNKNOWN_DEPARTMENT'));
    var emp = text(input.assignedEmployeeId) || null;
    if (emp && departmentMembers(dep).indexOf(emp) < 0) return Promise.resolve(fail('UNKNOWN_EMPLOYEE'));
    var priority = text(input.priority) || PRIORITY.NORMAL;
    if (PRIORITIES.indexOf(priority) < 0) return Promise.resolve(fail('INVALID', { errors:[{ field:'priority' }] }));
    var desc = text(input.description);
    if (desc && desc.length > LIMITS.description) return Promise.resolve(fail('INVALID', { errors:[{ field:'description' }] }));

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      if (!isActive(t.status)) return fail('TICKET_CLOSED');
      var c = coll('support_tasks'); if (!c) return fail('STORE_UNAVAILABLE');
      var taskId = newId('tsk');
      var r = c.append('entryId', {
        entryId:taskId + '|created', taskId:taskId, ticketId:ticketId, kind:'created',
        at:Date.now(), actorId:a.id, title:title, description:desc || null,
        department:dep, assignedEmployeeId:emp, priority:priority });
      if (!r.ok) return fail('PERSIST_FAILED');
      var t2 = stateOf(ticketId);
      audit('ticket.task_created', t2, a, { key:taskId, metadata:{ taskId:taskId, department:dep } });
      emit('support.ticket.updated', t2, { changed:['task'], taskId:taskId });
      return { ok:true, taskId:taskId, task:tasksOf(ticketId).filter(function (x) { return x.taskId === taskId; })[0],
               ticket:present(t2, { full:true }) };
    });
  }
  function findTask(taskId){
    var rws = rows('support_tasks').filter(function (r) { return r.taskId === taskId; }).sort(bySeq);
    return rws.length ? deriveTask(rws) : null;
  }
  function updateTask(taskId, input){
    input = input || {};
    var bad = badKeys(input, ['title', 'description', 'priority', 'assignedEmployeeId']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var task = findTask(taskId);
    if (!task) return Promise.resolve(fail('TASK_NOT_FOUND'));
    var pre = employeeOn(task.ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);

    return serialized(task.ticketId, function () {
      var g = employeeOn(task.ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, cur = findTask(taskId);
      if (!cur) return fail('TASK_NOT_FOUND');
      if (cur.status === TASK.COMPLETED) return fail('TASK_DONE');
      var patch = { }, errors = [];
      if (input.title !== undefined) { var ti = text(input.title); if (!within(ti, LIMITS.title)) errors.push({ field:'title' }); else patch.title = ti; }
      if (input.description !== undefined) { var d = text(input.description); if (d.length > LIMITS.description) errors.push({ field:'description' }); else patch.description = d || null; }
      if (input.priority !== undefined) { var p = text(input.priority); if (PRIORITIES.indexOf(p) < 0) errors.push({ field:'priority' }); else patch.priority = p; }
      if (input.assignedEmployeeId !== undefined) {
        var e = text(input.assignedEmployeeId) || null;
        if (e && departmentMembers(cur.department).indexOf(e) < 0) return fail('UNKNOWN_EMPLOYEE');
        patch.assignedEmployeeId = e;
      }
      if (errors.length) return fail('INVALID', { errors:errors });
      if (!Object.keys(patch).length) return { ok:true, unchanged:true, task:cur };

      var c = coll('support_tasks'); if (!c) return fail('STORE_UNAVAILABLE');
      var n = rows('support_tasks').filter(function (r) { return r.taskId === taskId && r.kind === 'updated'; }).length;
      var r2 = c.append('entryId', Object.assign({
        entryId:taskId + '|updated|' + n, taskId:taskId, ticketId:cur.ticketId, kind:'updated',
        at:Date.now(), actorId:a.id }, patch));
      if (!r2.ok) return fail('PERSIST_FAILED');
      var t2 = stateOf(cur.ticketId);
      audit('ticket.updated', t2, a, { key:r2.record.entryId, metadata:{ taskId:taskId, changed:Object.keys(patch) } });
      emit('support.ticket.updated', t2, { changed:['task'], taskId:taskId });
      return { ok:true, task:findTask(taskId) };
    });
  }
  function completeTask(taskId, input){
    input = input || {};
    var bad = badKeys(input, ['note']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var task = findTask(taskId);
    if (!task) return Promise.resolve(fail('TASK_NOT_FOUND'));
    var pre = employeeOn(task.ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);

    return serialized(task.ticketId, function () {
      var g = employeeOn(task.ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, cur = findTask(taskId);
      if (!cur) return fail('TASK_NOT_FOUND');
      if (cur.status === TASK.COMPLETED) return fail('TASK_DONE', { completedAt:cur.completedAt });
      var r = appendChecked('support_tasks', 'entryId', {
        entryId:taskId + '|completed', taskId:taskId, ticketId:cur.ticketId, kind:'completed',
        at:Date.now(), actorId:a.id, note:text(input.note) || null });
      if (!r.ok) return fail(r.reason === 'append_lost' ? 'STATE_CHANGED' : 'PERSIST_FAILED', { reason:r.reason });
      if (r.duplicate && r.record.actorId !== a.id) return fail('TASK_DONE', { completedBy:r.record.actorId });
      var t2 = stateOf(cur.ticketId);
      audit('ticket.task_completed', t2, a, { key:r.record.entryId, metadata:{ taskId:taskId } });
      emit('support.ticket.updated', t2, { changed:['task'], taskId:taskId });
      return { ok:true, task:findTask(taskId) };
    });
  }

  /* ══════════════════════ FOLLOW-UPS ══════════════════════
     A follow-up never resolves or closes a ticket by itself. There is no
     timer: a due follow-up is noticed when the list is read, exactly like the
     wallet's expiring lots. */
  function createFollowUp(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['dueAt', 'reason', 'assignedEmployeeId']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);
    var dueAt = typeof input.dueAt === 'number' ? Math.round(input.dueAt) : null;
    if (!dueAt || dueAt <= 0) return Promise.resolve(fail('INVALID', { errors:[{ field:'dueAt' }] }));
    var reason = text(input.reason);
    if (!within(reason, LIMITS.reason)) return Promise.resolve(fail('REASON_REQUIRED'));

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      var emp = text(input.assignedEmployeeId) || a.id;
      if (departmentMembers(t.responsibleDepartment).indexOf(emp) < 0 && emp !== a.id) return fail('UNKNOWN_EMPLOYEE');
      var c = coll('support_followups'); if (!c) return fail('STORE_UNAVAILABLE');
      var followUpId = newId('fup');
      var r = c.append('entryId', {
        entryId:followUpId + '|created', followUpId:followUpId, ticketId:ticketId, kind:'created',
        customerId:t.customerId, at:Date.now(), actorId:a.id,
        dueAt:dueAt, reason:reason, assignedEmployeeId:emp });
      if (!r.ok) return fail('PERSIST_FAILED');
      var t2 = stateOf(ticketId);
      audit('ticket.followup_created', t2, a, { key:followUpId, metadata:{ followUpId:followUpId, dueAt:dueAt } });
      emit('support.followup.created', t2, { followUpId:followUpId, dueAt:dueAt });
      if (emp !== a.id && global.RAFNotify) {
        var def = (RAFNotify.EVENT_TYPES || {})['support.followup.created'];
        if (def) RAFNotify.create({ recipientUserId:emp, eventType:'support.followup.created', title:def.title,
          entityType:'ticket', entityId:ticketId, source:'admin', metadata:{ followUpId:followUpId },
          dedupeKey:'followup.created|' + followUpId });
      }
      return { ok:true, followUpId:followUpId, followUp:findFollowUp(followUpId) };
    });
  }
  function findFollowUp(followUpId){
    var rws = rows('support_followups').filter(function (r) { return r.followUpId === followUpId; }).sort(bySeq);
    return rws.length ? deriveFollowUp(rws) : null;
  }
  function endFollowUp(followUpId, kind, input, auditAction, eventType){
    input = input || {};
    var bad = badKeys(input, ['reason']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var f = findFollowUp(followUpId);
    if (!f) return Promise.resolve(fail('FOLLOWUP_NOT_FOUND'));
    var pre = employeeOn(f.ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);

    return serialized(f.ticketId, function () {
      var g = employeeOn(f.ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, cur = findFollowUp(followUpId);
      if (!cur) return fail('FOLLOWUP_NOT_FOUND');
      if (cur.status !== FOLLOWUP.OPEN) return fail('FOLLOWUP_CLOSED', { status:cur.status });
      /* one terminal entry per follow-up: the second writer loses */
      var r = appendChecked('support_followups', 'entryId', {
        entryId:followUpId + '|end', followUpId:followUpId, ticketId:cur.ticketId, kind:kind,
        at:Date.now(), actorId:a.id, reason:text(input.reason) || null });
      if (!r.ok) return fail(r.reason === 'append_lost' ? 'STATE_CHANGED' : 'PERSIST_FAILED', { reason:r.reason });
      if (r.duplicate) {
        return fail('FOLLOWUP_CLOSED', { status:findFollowUp(followUpId).status, closedBy:r.record.actorId, race:true });
      }
      var t2 = stateOf(cur.ticketId);
      if (auditAction) audit(auditAction, t2, a, { key:r.record.entryId, metadata:{ followUpId:followUpId } });
      if (eventType) emit(eventType, t2, { followUpId:followUpId });
      return { ok:true, followUp:findFollowUp(followUpId) };
    });
  }
  function completeFollowUp(followUpId, input){
    return endFollowUp(followUpId, 'completed', input, 'ticket.followup_completed', 'support.followup.completed');
  }
  function cancelFollowUp(followUpId, input){
    return endFollowUp(followUpId, 'cancelled', input, 'ticket.followup_completed', 'support.followup.completed');
  }
  /* every follow-up this account may see. Reading is also when a due
     follow-up produces its notification — idempotently, no timer, no poll. */
  function listFollowUps(filters){
    filters = filters || {};
    var bad = badKeys(filters, ['status', 'assignedEmployeeId', 'ticketId', 'dueBefore', 'mine']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.VIEW); if (!a.ok) return a;
    var allowed = {};
    scopeTickets(a).forEach(function (t) { allowed[t.ticketId] = t; });
    var out = [];
    var byId = {};
    rows('support_followups').forEach(function (r) { (byId[r.followUpId] = byId[r.followUpId] || []).push(r); });
    Object.keys(byId).forEach(function (id) {
      var f = deriveFollowUp(byId[id].sort(bySeq));
      if (!allowed[f.ticketId]) return;
      if (filters.ticketId && f.ticketId !== filters.ticketId) return;
      if (filters.status && f.status !== filters.status) return;
      if (filters.mine && f.assignedEmployeeId !== a.id) return;
      if (filters.assignedEmployeeId && f.assignedEmployeeId !== filters.assignedEmployeeId) return;
      if (filters.dueBefore && f.dueAt > filters.dueBefore) return;
      var t = allowed[f.ticketId];
      f.ticketSubject = t.subject; f.customerId = t.customerId;
      f.due = f.status === FOLLOWUP.OPEN && f.dueAt <= Date.now();
      f.assignedEmployeeName = employeeName(f.assignedEmployeeId);
      out.push(f);
      if (f.due && global.RAFNotify && RAFNotify.create) {
        var def = (RAFNotify.EVENT_TYPES || {})['support.followup.due'];
        if (def) RAFNotify.create({ recipientUserId:f.assignedEmployeeId, eventType:'support.followup.due',
          title:def.title, entityType:'ticket', entityId:f.ticketId, source:'admin',
          metadata:{ followUpId:f.followUpId }, dedupeKey:'followup.due|' + f.followUpId });
      }
    });
    return { ok:true, items:out.sort(function (x, y) { return x.dueAt - y.dueAt; }) };
  }

  /* ══════════════════════ ESCALATION ══════════════════════
     Never a second ticket: an escalation record points at this one and puts it
     in front of management. */
  function escalateTicket(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['reason', 'description']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.ESCALATE);
    if (!pre.ok) return Promise.resolve(pre);
    var reason = text(input.reason);
    var description = text(input.description);
    /* RAF approves no escalation reason list (RAFConfig: exceptions.escalationReasons
       is not_configured), so a description is what carries the case — the same
       rule Phase E applies to delivery exceptions. */
    if (!within(description, LIMITS.resolution)) return Promise.resolve(fail('REASON_REQUIRED'));

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.ESCALATE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      if (!isActive(t.status)) return fail('TICKET_CLOSED');
      var c = coll('support_escalations'); if (!c) return fail('STORE_UNAVAILABLE');
      var n = escalationsOf(ticketId).length;
      var escalationId = 'esc|' + ticketId + '|' + n;
      var r = appendChecked('support_escalations', 'escalationId', {
        escalationId:escalationId, ticketId:ticketId, actorId:a.id, at:Date.now(),
        reason:reason || null, description:description, status:ESCALATION.OPEN,
        department:t.responsibleDepartment });
      if (!r.ok) return fail(r.reason === 'append_lost' ? 'STATE_CHANGED' : 'PERSIST_FAILED', { reason:r.reason });
      if (r.duplicate && r.record.actorId !== a.id) return fail('STATE_CHANGED', { escalatedBy:r.record.actorId });
      var acts = coll('support_activities');
      if (acts) acts.append('activityId', {
        activityId:'cs|' + ticketId + '|escalate|' + n, ticketId:ticketId, kind:'escalate',
        visibility:VIS.INTERNAL, at:r.record.at, actorId:a.id, actorRole:a.roleId,
        reason:reason || null, body:description });
      var t2 = stateOf(ticketId);
      audit('ticket.escalated', t2, a, { key:escalationId, reason:reason || null,
        metadata:{ escalationId:escalationId, description:description } });
      emit('support.ticket.escalated', t2, { escalationId:escalationId });
      notifyDepartment('support.ticket.escalated', 'management', t2, a.id);
      return { ok:true, escalationId:escalationId, ticket:present(t2, { full:true }) };
    });
  }

  /* ══════════════════════ RESOLVE · CLOSE · REOPEN ══════════════════════ */
  function statusMove(ticketId, to, key, input, auditAction, eventType, guard){
    input = input || {};
    var bad = badKeys(input, ['description', 'code', 'reason']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, key);
    if (!pre.ok) return Promise.resolve(pre);
    var pre2 = guard(pre.t, input);
    if (pre2) return Promise.resolve(pre2);

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, key); if (!g.ok) return g;
      var a = g.a, t = g.t;
      var g2 = guard(t, input); if (g2) return g2;
      if ((TRANSITIONS[t.status] || []).indexOf(to) < 0) return fail('INVALID_TRANSITION', { from:t.status, to:to });
      var r = appendChecked('support_activities', 'activityId', {
        activityId:'cs|' + ticketId + '|status|' + t.statusChanges, ticketId:ticketId, kind:'status',
        visibility:VIS.INTERNAL, at:Date.now(), actorId:a.id, actorRole:a.roleId,
        from:t.status, to:to, reason:text(input.reason) || null,
        resolution:text(input.description) || null, resolutionCode:text(input.code) || null });
      if (!r.ok) return fail(r.reason === 'append_lost' ? 'STATE_CHANGED' : 'PERSIST_FAILED', { reason:r.reason });
      if (r.duplicate) {
        var now = stateOf(ticketId);
        return r.record.to === to && r.record.actorId === a.id
          ? { ok:true, already:true, ticket:present(now, { full:true }) }
          : fail('STATE_CHANGED', { status:now.status, by:r.record.actorId, race:true });
      }
      var t2 = stateOf(ticketId);
      audit(auditAction, t2, a, { key:r.record.activityId, previousState:t.status, newState:to,
        reason:text(input.reason) || null,
        metadata:{ resolution:text(input.description) || null, resolutionCode:text(input.code) || null } });
      emit(eventType, t2, { status:to });
      return { ok:true, ticket:present(t2, { full:true }) };
    });
  }
  function resolveTicket(ticketId, input){
    return statusMove(ticketId, STATUS.RESOLVED, P.RESOLVE, input, 'ticket.resolved', 'support.ticket.resolved',
      function (t, i) {
        if (!within(text(i.description), LIMITS.resolution)) return fail('RESOLUTION_REQUIRED');
        return null;
      }).then(function (r) {
        /* the customer is told the outcome — never the internal route to it */
        if (r.ok && !r.already) { var t = stateOf(ticketId); if (t) notifyCustomer('support.ticket.resolved', t); }
        return r;
      });
  }
  function closeTicket(ticketId, input){
    return statusMove(ticketId, STATUS.CLOSED, P.RESOLVE, input, 'ticket.closed', 'support.ticket.closed',
      function (t) { return t.status === STATUS.RESOLVED ? null : fail('NOT_RESOLVED', { status:t.status }); });
  }
  function reopenTicket(ticketId, input){
    return statusMove(ticketId, STATUS.REOPENED, P.RESOLVE, input, 'ticket.reopened', 'support.ticket.reopened',
      function (t, i) { return within(text(i.reason), LIMITS.reason) ? null : fail('REASON_REQUIRED'); })
      .then(function (r) {
        if (r.ok && !r.already) {
          var t = stateOf(ticketId);
          if (t) notifyDepartment('support.ticket.reopened', t.responsibleDepartment, t, null);
        }
        return r;
      });
  }

  /* ══════════════════════ RELATED RECORDS ══════════════════════ */
  function linkRecord(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['recordType', 'recordId', 'note']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);
    var type = text(input.recordType), id = text(input.recordId);
    if (RELATION_TYPES.indexOf(type) < 0 || !id) return Promise.resolve(fail('RELATION_INVALID'));

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a, t = g.t;
      var v = verifyRelation(type, id, t.customerId);
      if (!v.ok) return v.cross ? fail('RELATION_FORBIDDEN') : fail('RELATION_INVALID');
      if (relationsOf(ticketId).some(function (r) { return r.recordType === type && r.recordId === id; })) {
        return { ok:true, already:true, relations:relationsOf(ticketId) };
      }
      var c = coll('support_relations'); if (!c) return fail('STORE_UNAVAILABLE');
      var n = relationRowsOf(ticketId).length;
      var r = c.append('entryId', {
        entryId:ticketId + '|' + type + '|' + id + '|' + n, ticketId:ticketId, kind:'link',
        recordType:type, recordId:id, verified:!!v.verified, at:Date.now(), actorId:a.id,
        note:text(input.note) || null });
      if (!r.ok) return fail('PERSIST_FAILED');
      var t2 = stateOf(ticketId);
      audit('ticket.updated', t2, a, { key:r.record.entryId, metadata:{ linked:type + ':' + id } });
      emit('support.ticket.updated', t2, { changed:['relation'] });
      return { ok:true, relations:relationsOf(ticketId) };
    });
  }
  function unlinkRecord(ticketId, input){
    input = input || {};
    var bad = badKeys(input, ['recordType', 'recordId', 'reason']);
    if (bad.length) return Promise.resolve(fail('FIELD_NOT_ACCEPTED', { fields:bad }));
    var pre = employeeOn(ticketId, P.MANAGE);
    if (!pre.ok) return Promise.resolve(pre);
    var type = text(input.recordType), id = text(input.recordId);

    return serialized(ticketId, function () {
      var g = employeeOn(ticketId, P.MANAGE); if (!g.ok) return g;
      var a = g.a;
      if (!relationsOf(ticketId).some(function (r) { return r.recordType === type && r.recordId === id; })) {
        return fail('NOT_LINKED');
      }
      var c = coll('support_relations'); if (!c) return fail('STORE_UNAVAILABLE');
      var n = relationRowsOf(ticketId).length;
      /* unlink is an APPEND, never a delete: the link's history stays */
      var r = c.append('entryId', {
        entryId:ticketId + '|' + type + '|' + id + '|' + n, ticketId:ticketId, kind:'unlink',
        recordType:type, recordId:id, at:Date.now(), actorId:a.id, reason:text(input.reason) || null });
      if (!r.ok) return fail('PERSIST_FAILED');
      var t2 = stateOf(ticketId);
      audit('ticket.updated', t2, a, { key:r.record.entryId, metadata:{ unlinked:type + ':' + id } });
      emit('support.ticket.updated', t2, { changed:['relation'] });
      return { ok:true, relations:relationsOf(ticketId) };
    });
  }

  /* ══════════════════════ CUSTOMER 360 ══════════════════════
     A READ-ONLY projection. Every section names the authority it came from and
     copies nothing: no balance, no order state and no compensation value is
     stored here. A section RAF cannot read from this account says so instead
     of guessing. */
  function ordersOfCustomer(customerId){
    var list = [];
    try { list = (global.RAFShop && RAFShop.Orders ? RAFShop.Orders.all() : []) || []; } catch (e) { list = []; }
    return list.filter(function (o) {
      if (!o) return false;
      var s = o.snapshot || orderSnapshot(o.id);
      return !!(s && s.customer && s.customer.id === customerId);
    });
  }
  function customer360(customerId){
    var a = actor(); if (!a.ok) return a;
    var target = a.isCustomer ? a.id : text(customerId);
    if (!a.isCustomer && !can(a.id, P.VIEW)) return fail('FORBIDDEN');
    if (a.isCustomer && customerId && customerId !== a.id) return fail('FORBIDDEN');
    if (!target) return fail('INVALID', { errors:[{ field:'customerId' }] });
    var u = null; try { u = RAFPerm.getUser(target); } catch (e) { u = null; }
    if (!u || u.roleId !== 'customer') return fail('INVALID_CUSTOMER');

    var orders = ordersOfCustomer(target).map(function (o) {
      var s = o.snapshot || orderSnapshot(o.id) || null;
      var out = { orderId:o.id, status:o.status || null, checkoutAt:s ? s.checkoutAt : null,
                  createdAt:(s ? s.checkoutAt : null) || o.createdAt || null,
                  storeSlug:s ? s.storeSlug : null,
                  total:s && s.commercial ? s.commercial.grandTotal : null,
                  currency:s && s.commercial ? s.commercial.currency : null,
                  source:'RAFOrderSnapshot / RAFShop.Orders' };
      /* READS ONLY. RAFOrderEngine.driverPickedUp() and its siblings RECORD a
         milestone — Customer Service never performs a delivery operation, so
         only the two genuine read functions are called here. */
      if (global.RAFOrderEngine) {
        try {
          out.deliveredAt = RAFOrderEngine.deliveredAt(o.id) || null;
          var pe = RAFOrderEngine.promisedEtaAt(o.id);
          out.promisedEtaAt = pe && pe.at ? pe.at : (typeof pe === 'number' ? pe : null);
          out.promisedEtaRecorded = !!(pe && pe.recorded);
        } catch (e) {}
      }
      out.active = !out.deliveredAt;
      return out;
    }).sort(function (x, y) { return (y.createdAt || 0) - (x.createdAt || 0); });

    /* the wallet answers only its own signed-in customer (RAFWallet ownership
       rule, unchanged here): an employee's 360 reports that honestly */
    var wallet = { available:false, reason:'NOT_AVAILABLE', source:'RAFWallet' };
    if (global.RAFWallet) {
      try {
        var b = RAFWallet.balance(target, { id:a.id });
        wallet = b && b.ok
          ? { available:true, balance:b.balance, ordinaryBalance:b.ordinaryBalance,
              compensationCredit:b.compensationCredit, currency:b.currency, source:'RAFWallet' }
          : { available:false, reason:(b && b.code) || 'NOT_AVAILABLE', source:'RAFWallet' };
      } catch (e) { wallet = { available:false, reason:'NOT_AVAILABLE', source:'RAFWallet' }; }
    }

    /* compensation answers only the customer it belongs to or an account
       holding its management permission (RAFCompensation, unchanged here), so
       a Customer Service employee is refused and 360 reports that refusal
       rather than an empty list that would read as "no compensation" */
    var compensation = { available:false, reason:'NOT_AVAILABLE', source:'RAFCompensation', items:[] };
    if (global.RAFCompensation) {
      var comps = [], refused = null;
      orders.forEach(function (o) {
        try {
          var c = RAFCompensation.forOrder(o.orderId);
          if (c && !c.ok) { refused = refused || c.code; return; }
          var rec = c ? (c.compensation || c.record || null) : null;
          if (rec) comps.push({ orderId:o.orderId, compensationId:rec.compensationId || null,
                                amount:rec.amount || null, status:c.status || rec.status || null });
        } catch (e) {}
      });
      compensation = refused
        ? { available:false, reason:refused, source:'RAFCompensation', items:[] }
        : { available:true, source:'RAFCompensation', items:comps };
    }

    var tickets = scopeTickets(a).filter(function (t) { return t.customerId === target; })
                                 .sort(function (x, y) { return y.updatedAt - x.updatedAt; });

    var communication = { available:false, reason:'NOT_AVAILABLE', source:'RAFDriverCommunication' };
    if (global.RAFDriverCommunication) {
      /* the conversation authority authorises from the delivery's own facts;
         Customer Service is not one of its parties, so 360 links to it rather
         than reproducing any message here */
      communication = { available:true, source:'RAFDriverCommunication', readable:false,
                        note:'Conversations are read in Logistics Management; RAFDriverCommunication authorises each read from the delivery.',
                        orders:orders.filter(function (o) { return !!o.pickedUpAt; }).map(function (o) { return o.orderId; }) };
    }

    return { ok:true, readOnly:true, generatedAt:Date.now(),
      customer:{ id:u.id, name:u.name, email:u.email, phone:u.phone, status:u.status,
                 regDate:u.regDate, source:'RAFPerm' },
      orders:orders,
      activeDeliveries:orders.filter(function (o) { return o.active; }),
      tickets:a.isCustomer ? tickets.map(presentForCustomer) : tickets.map(function (t) { return present(t); }),
      supportHistory:{ total:tickets.length,
                       open:tickets.filter(function (t) { return isActive(t.status); }).length,
                       closed:tickets.filter(function (t) { return !isActive(t.status); }).length },
      wallet:wallet, compensation:compensation, communication:communication };
  }

  /* ══════════════════════ DASHBOARD (real counts only) ══════════════════════ */
  function dashboard(){
    var a = staff(P.VIEW); if (!a.ok) return a;
    var escalated = {};
    rows('support_escalations').forEach(function (e) { escalated[e.ticketId] = true; });
    var mine = scopeTickets(a);
    var fu = listFollowUps({});
    var sla = slaConfigured();
    return { ok:true, department:a.department, isManagement:a.crossDepartment,
      myOpen:       mine.filter(function (t) { return t.assignedEmployeeId === a.id && isActive(t.status); }).length,
      unassigned:   mine.filter(function (t) { return !t.assignedEmployeeId && isActive(t.status); }).length,
      pending:      mine.filter(function (t) { return t.status === STATUS.PENDING; }).length,
      recentlyUpdated: mine.slice().sort(function (x, y) { return y.updatedAt - x.updatedAt; }).slice(0, 10)
                           .map(function (t) { return present(t); }),
      escalatedCount: mine.filter(function (t) { return escalated[t.ticketId] && isActive(t.status); }).length,
      followUpsOpen:  fu.ok ? fu.items.filter(function (f) { return f.status === FOLLOWUP.OPEN; }).length : 0,
      followUpsDue:   fu.ok ? fu.items.filter(function (f) { return f.due; }).length : 0,
      /* no target is approved, so no number is produced for either */
      sla:{ configured:sla, nearSla:sla.resolution ? 0 : null, breached:sla.resolution ? 0 : null,
            status:'not_configured' } };
  }

  /* what this account may do — the UI asks, it never guesses */
  function capabilities(){
    var a = actor();
    if (!a.ok) return { ok:false, code:a.code, view:false };
    if (a.isCustomer) return { ok:true, audience:'customer', view:true, create:true, message:true };
    return { ok:true, audience:'employee', department:a.department, isManagement:a.crossDepartment,
             view:can(a.id, P.VIEW), create:can(a.id, P.CREATE), manage:can(a.id, P.MANAGE),
             resolve:can(a.id, P.RESOLVE), escalate:can(a.id, P.ESCALATE),
             me:{ id:a.id, name:a.name, roleId:a.roleId } };
  }

  global.RAFCustomerService = {
    VERSION:VERSION, TYPE:TYPE, SOURCE:SOURCE, STATUS:STATUS, STATUS_TXT:STATUS_TXT,
    PRIORITY:PRIORITY, PRIORITIES:PRIORITIES, PRIORITY_TXT:PRIORITY_TXT,
    VISIBILITY:VIS, TRANSITIONS:TRANSITIONS, DEPARTMENTS:DEPARTMENTS, LIMITS:LIMITS,
    ERRORS:ERRORS, RELATION_TYPES:RELATION_TYPES, PERMISSIONS:P,
    /* reads (synchronous) */
    capabilities:capabilities, categories:categories, categoryOf:categoryOf,
    departments:function(){ return copy(DEPARTMENTS); }, departmentMembers:departmentMembers,
    getTicket:getTicket, listTickets:listTickets, searchTickets:searchTickets,
    listFollowUps:listFollowUps, duplicateCheck:duplicateCheck,
    customer360:customer360, dashboard:dashboard, slaConfigured:slaConfigured,
    /* writes — serialized per ticket, so each returns a Promise */
    createTicket:createTicket, claimTicket:claimTicket, transferTicket:transferTicket,
    updateTicket:updateTicket, addInternalNote:addInternalNote, addCustomerMessage:addCustomerMessage,
    createTask:createTask, updateTask:updateTask, completeTask:completeTask,
    createFollowUp:createFollowUp, completeFollowUp:completeFollowUp, cancelFollowUp:cancelFollowUp,
    resolveTicket:resolveTicket, closeTicket:closeTicket, reopenTicket:reopenTicket,
    escalateTicket:escalateTicket, linkRecord:linkRecord, unlinkRecord:unlinkRecord
  };
})(window);
