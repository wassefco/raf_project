/* ============================================================================
 * RAF Marketplace — MERCHANT JOIN APPLICATION AUTHORITY  (RAFMerchantApplications)
 * ----------------------------------------------------------------------------
 * The ONE source of truth for a request to join RAF as a merchant, from the
 * public seller form (raf_seller.html) to RAF Management's decision.
 *
 * SHAPE — the same as the driver application in RAFLogistics:
 *   merchant_applications        the immutable submission (never rewritten)
 *   merchant_application_events  append-only decisions (submitted / approved /
 *                                rejected); the status is DERIVED from them
 * Both are registered in RAFRecordStore. Nothing else stores an application:
 * RAFRequests only presents it and hands decisions back here.
 *
 * WHAT IS STORED — exactly the fields the seller form collects. The form's
 * PASSWORD is never stored: an application is not an account, and a password
 * kept in a request record would be a credential in plain storage.
 * DOCUMENTS — this prototype has no file-storage service (see RAFLogistics
 * docMeta). Only each file's own metadata is kept, marked
 * storage:'metadata_only'; no file content is read, stored or served.
 *
 * PERMISSION — the existing catalogue key `stores.approve` (the Stores
 * module's approval action). It is required to READ applications (they hold a
 * prospective merchant's personal data) and to DECIDE them, and it is proved
 * here on every call from this tab's session — never from the caller.
 * Submitting needs no session: the public form is open to anyone.
 *
 * APPROVAL EFFECT — provisioning, by the authorities that own each part:
 *   the store (RAFSource.createStore, CLOSED), then the dedicated merchant
 *   account linked to it (RAFPerm.provisionMerchantAccount, PENDING
 *   ACTIVATION — no password, no sign-in until a real activation flow exists),
 *   then the decision. See approveApplication.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFMerchantApplications) return;

  var VERSION = 1;
  var STATUS = { PENDING:'pending', APPROVED:'approved', REJECTED:'rejected' };
  var STATUS_TXT = {
    pending:  { ar:'قيد المراجعة', en:'Pending review' },
    approved: { ar:'مقبول',        en:'Approved' },
    rejected: { ar:'مرفوض',        en:'Rejected' }
  };
  var P = { VIEW:'stores.approve', DECIDE:'stores.approve' };
  var LIMITS = { name:60, phone:24, email:120, civilId:16, text:80, storeName:80, description:1000, reason:300, note:600, key:80 };
  var DOC_KEYS = ['civilId', 'commercialRecord', 'logo', 'cover'];
  var DAYS = ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'];
  var PLANS = {
    free:    { ar:'مجاني',   en:'Free' },
    pro:     { ar:'مميز',    en:'Pro' },
    premium: { ar:'بريميوم', en:'Premium' }
  };

  function isEn(){ var r = (global.document && (document.getElementById('htmlRoot') || document.documentElement)); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  function text(v){ return v == null ? '' : String(v).trim(); }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }

  var ERRORS = {
    UNAVAILABLE:          { ar:'تعذّر الوصول إلى سجل الطلبات.',                en:'The application record is unavailable.' },
    UNAUTHENTICATED:      { ar:'يلزم تسجيل الدخول.',                          en:'Sign-in is required.' },
    ACTOR_INACTIVE:       { ar:'لا يمكن تنفيذ الإجراء بحساب موقوف.',           en:'A suspended account cannot perform this action.' },
    FORBIDDEN:            { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',            en:'You do not have permission for this action.' },
    FIELD_NOT_ACCEPTED:   { ar:'حقل غير مقبول.',                              en:'A field is not accepted.' },
    INVALID:              { ar:'بعض الحقول المطلوبة غير مكتملة.',              en:'Some required fields are incomplete.' },
    CONSENT_REQUIRED:     { ar:'الرجاء الموافقة على الشروط والأحكام.',         en:'Please accept the terms and conditions.' },
    DUPLICATE_APPLICATION:{ ar:'يوجد طلب قيد المراجعة بنفس البريد أو الرقم المدني.', en:'An application with this email or civil ID is already pending.' },
    PERSIST_FAILED:       { ar:'تعذّر حفظ الطلب.',                             en:'The application could not be saved.' },
    APPLICATION_NOT_FOUND:{ ar:'طلب الانضمام غير موجود.',                      en:'The application could not be found.' },
    APPLICATION_DECIDED:  { ar:'تم البت في هذا الطلب بالفعل.',                  en:'This application has already been decided.' },
    REASON_REQUIRED:      { ar:'سبب الرفض مطلوب.',                            en:'A rejection reason is required.' },
    PROVISIONING_FAILED:  { ar:'فشل إعداد حساب التاجر أو المتجر.',                en:'Merchant account or store provisioning failed.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function badKeys(o, allowed){ return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; }); }

  /* ---------- storage (RAFRecordStore) ---------- */
  function store(name){
    if (!global.RAFRecordStore) return null;
    try { return RAFRecordStore.collection(name); } catch (e) { return null; }
  }
  function appRows(){ var c = store('merchant_applications'); return c ? c.all() : []; }
  function eventRows(id){
    var c = store('merchant_application_events'); if (!c) return [];
    return c.all().filter(function (e) { return e.applicationId === id; }).sort(function (a, b) { return (a.seq || 0) - (b.seq || 0); });
  }
  function appendEvent(id, kind, a, extra){
    var c = store('merchant_application_events'); if (!c) return { ok:false, reason:'store_unavailable' };
    var n = eventRows(id).filter(function (e) { return e.kind === kind; }).length;
    var rec = { eventId:'mra|' + id + '|' + kind + '|' + n, applicationId:id, kind:kind, at:Date.now(),
                actorId:(a && a.id) || null, actorName:(a && a.name) || null };
    for (var k in (extra || {})) if (extra.hasOwnProperty(k)) rec[k] = extra[k];
    return c.append('eventId', rec);
  }
  /* the application as it stands now — derived from its events, never stored */
  function derive(rec, events){
    var a = copy(rec);
    a.status = STATUS.PENDING; a.decidedAt = null; a.decidedBy = null; a.decidedByName = null;
    a.rejectionReason = null; a.decisionNote = null; a.history = [];
    /* provisioning as the events record it: none | partial | failed | complete */
    a.provisioning = { state:'none', storeSlug:null, accountId:null, lastFailure:null };
    events.forEach(function (e) {
      a.history.push({ kind:e.kind, at:e.at, actorId:e.actorId || null, actorName:e.actorName || null,
                       note:e.note || null, reason:e.kind === 'provisioning_failed' ? failText(e.reason) : (e.reason || null), step:e.step || null });
      if (e.kind === 'store_provisioned') a.provisioning.storeSlug = e.storeSlug || null;
      if (e.kind === 'account_provisioned') { a.provisioning.accountId = e.accountId || null; a.provisioning.storeSlug = e.storeSlug || a.provisioning.storeSlug; }
      if (e.kind === 'provisioning_failed') a.provisioning.lastFailure = { step:e.step || null, reason:e.reason || null, at:e.at };
      if (e.kind === 'approved') { a.provisioning.storeSlug = e.storeSlug || a.provisioning.storeSlug; a.provisioning.accountId = e.accountId || a.provisioning.accountId; }
      if (e.kind === 'approved') { a.status = STATUS.APPROVED; a.decidedAt = e.at; a.decidedBy = e.actorId; a.decidedByName = e.actorName; a.decisionNote = e.note || null; }
      if (e.kind === 'rejected') { a.status = STATUS.REJECTED; a.decidedAt = e.at; a.decidedBy = e.actorId; a.decidedByName = e.actorName; a.rejectionReason = e.reason || null; }
    });
    var pv = a.provisioning;
    pv.state = a.status === STATUS.APPROVED ? 'complete'
             : (pv.lastFailure && !(pv.storeSlug && pv.accountId)) ? (pv.storeSlug ? 'partial' : 'failed')
             : (pv.storeSlug || pv.accountId) ? 'partial' : 'none';
    if (pv.lastFailure) pv.lastFailure.text = failText(pv.lastFailure.reason);
    a.statusText = STATUS_TXT[a.status];
    delete a.submissionKey;          /* an idempotency token, not application data */
    return a;
  }
  function state(id){
    var rows = appRows(), rec = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].applicationId === id) rec = rows[i];
    return rec ? derive(rec, eventRows(id)) : null;
  }
  /* the user-facing reference: MR-<year>-<5-digit sequence>, fixed at submission */
  function nextRef(){
    var year = new Date().getFullYear(), prefix = 'MR-' + year + '-';
    var n = appRows().filter(function (r) { return String(r.ref || '').indexOf(prefix) === 0; }).length + 1;
    return prefix + String(n).padStart(5, '0');
  }

  /* ---------- actor: this tab's signed-in session only ---------- */
  function actor(){
    var R = global.RAFPerm; if (!R) return fail('UNAVAILABLE');
    var id = null; try { id = R.sessionUserId ? R.sessionUserId() : null; } catch (e) { id = null; }
    var u = null; if (id) { try { u = R.getUser(id); } catch (e) { u = null; } }
    if (!u) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    return { ok:true, id:u.id, name:u.name || u.id, roleId:u.roleId || null };
  }
  function can(id, key){ try { return !!(global.RAFPerm && RAFPerm.can(id, key)); } catch (e) { return false; } }
  function staff(key){ var a = actor(); if (!a.ok) return a; if (!can(a.id, key)) return fail('FORBIDDEN', { required:key }); return a; }
  function audit(action, a, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try { return RAFAudit.record(Object.assign({ action:action, actor:a ? { id:a.id } : undefined, source:a ? 'admin' : 'system' }, extra || {})); }
    catch (e) { return null; }
  }

  /* ---------- validation: the seller form's own required fields ---------- */
  function errorsOf(input){
    var e = [], p = input.applicant || {}, s = input.store || {}, d = input.documents || {};
    ['firstName','lastName','phone','civilId','nationality'].forEach(function (k) { if (!text(p[k])) e.push({ field:k }); });
    var email = text(p.email);
    if (!email || email.indexOf('@') < 1 || email.length > LIMITS.email) e.push({ field:'email' });
    ['name','category','description','area'].forEach(function (k) { if (!text(s[k])) e.push({ field:'store.' + k }); });
    if (!PLANS[text(input.plan)]) e.push({ field:'plan' });
    if (!d.civilId) e.push({ field:'doc.civilId' });
    if (!d.commercialRecord) e.push({ field:'doc.commercialRecord' });
    return e;
  }
  function docMeta(d){
    if (!d) return null;
    var name = text(d.name); if (!name) return null;
    var size = (typeof d.size === 'number' && isFinite(d.size) && d.size >= 0) ? d.size : null;
    var dot = name.lastIndexOf('.');
    return { name:name.slice(0, 180), type:text(d.type).slice(0, 80) || null, size:size,
             ext:dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 8) : null,
             storage:'metadata_only', at:Date.now() };
  }
  function hoursOf(h){
    var out = {};
    DAYS.forEach(function (k) {
      var x = (h || {})[k] || {};
      out[k] = { open:!!x.open, from:x.open ? text(x.from).slice(0, 16) || null : null, to:x.open ? text(x.to).slice(0, 16) || null : null };
    });
    return out;
  }
  function liveDuplicate(email, civilId){
    var em = text(email).toLowerCase(), cid = text(civilId);
    return appRows().map(function (r) { return state(r.applicationId); }).filter(function (a) {
      return a && a.status === STATUS.PENDING && ((em && text(a.applicant.email).toLowerCase() === em) || (cid && a.applicant.civilId === cid));
    })[0] || null;
  }

  /* ══════════ 1 · SUBMIT — the public form; no session needed ══════════
     `key` is the form's one-time submission token: a double click or a retry
     with the same token returns the application already stored, never a
     second one. */
  function createApplication(input){
    input = input || {};
    var bad = badKeys(input, ['applicant', 'store', 'hours', 'plan', 'documents', 'consent', 'key']);
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var c = store('merchant_applications'); if (!c) return fail('UNAVAILABLE');

    var key = text(input.key).slice(0, LIMITS.key);
    if (key) {
      var same = appRows().filter(function (r) { return r.submissionKey === key; })[0];
      if (same) return { ok:true, duplicate:true, applicationId:same.applicationId, ref:same.ref, status:state(same.applicationId).status };
    }
    var errors = errorsOf(input);
    if (errors.length) return fail('INVALID', { errors:errors });
    if (!input.consent || input.consent.accepted !== true) return fail('CONSENT_REQUIRED');
    var p = input.applicant, s = input.store;
    var dupe = liveDuplicate(p.email, p.civilId);
    if (dupe) return fail('DUPLICATE_APPLICATION', { applicationId:dupe.applicationId, ref:dupe.ref });

    var docs = {}, given = input.documents || {};
    DOC_KEYS.forEach(function (k) { docs[k] = docMeta(given[k]); });
    var id = global.RAFRecordStore.makeId('mapp');
    var rec = {
      applicationId:id, ref:nextRef(), submittedAt:Date.now(), submissionKey:key || null, version:VERSION,
      applicant:{
        firstName:text(p.firstName).slice(0, LIMITS.name), lastName:text(p.lastName).slice(0, LIMITS.name),
        name:(text(p.firstName) + ' ' + text(p.lastName)).trim(),
        phone:text(p.phone).slice(0, LIMITS.phone), email:text(p.email).slice(0, LIMITS.email),
        civilId:text(p.civilId).slice(0, LIMITS.civilId), nationality:text(p.nationality).slice(0, LIMITS.text)
      },
      store:{
        name:text(s.name).slice(0, LIMITS.storeName), category:text(s.category).slice(0, LIMITS.text),
        description:text(s.description).slice(0, LIMITS.description), area:text(s.area).slice(0, LIMITS.text),
        expectedProducts:text(s.expectedProducts).slice(0, LIMITS.text) || null
      },
      hours:hoursOf(input.hours), plan:text(input.plan),
      documents:docs,
      consent:{ accepted:true, at:Date.now(), terms:text(input.consent.terms) || 'raf_terms.html' }
    };
    var w = c.append('applicationId', rec);
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });
    appendEvent(id, 'submitted', null, {});
    /* the applicant has no RAF session, so the audit actor is the system */
    audit('merchant.application_submitted', null, { key:id, newState:STATUS.PENDING, systemGenerated:true,
      metadata:{ applicationId:id, ref:rec.ref } });
    return { ok:true, applicationId:id, ref:rec.ref, status:STATUS.PENDING };
  }

  /* ══════════ 2 · READ — Management only (stores.approve) ══════════ */
  function listApplications(filters){
    filters = filters || {};
    var bad = badKeys(filters, ['status']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.VIEW); if (!a.ok) return a;
    var items = appRows().map(function (r) { return derive(r, eventRows(r.applicationId)); })
      .filter(function (x) { return !filters.status || x.status === filters.status; })
      .sort(function (x, y) { return y.submittedAt - x.submittedAt; });
    return { ok:true, items:items };
  }
  function getApplication(id){
    var a = staff(P.VIEW); if (!a.ok) return a;
    var s = state(id); if (!s) return fail('APPLICATION_NOT_FOUND');
    return { ok:true, application:s };
  }

  /* ══════════ 3 · DECIDE — Management only (stores.approve) ══════════ */
  /* ══════════ APPROVAL = PROVISIONING, then the decision ══════════
     Each step is performed by the authority that owns it, and each is
     idempotent on this application's id, so a retry after a failure — or a
     second click — never creates a second store or account:
       1. RAFSource.createStore            the store (CLOSED until the merchant opens it)
       2. RAFPerm.provisionMerchantAccount the dedicated merchant account,
                                           linked to that store, PENDING ACTIVATION
       3. the link is read back through RAFPerm.storeLinkOf
       4. only then is the approval recorded
     A failure is recorded against the application (provisioning_failed) and
     reported; the application stays PENDING, never "approved" with a missing
     account or store. Nothing already created is rolled back — there is no
     transaction here — but the partial state is recorded and the next attempt
     continues from it. */
  var FAIL_TXT = {
    email_in_use:         { ar:'البريد الإلكتروني مستخدم لحساب آخر في رف، ولا يُربط حساب التاجر بحساب قائم.', en:'The email already belongs to another RAF account; a merchant account is never attached to an existing one.' },
    store_already_linked: { ar:'المتجر مرتبط بحساب آخر.',            en:'The store is already linked to another account.' },
    store_not_found:      { ar:'المتجر غير موجود في سجل المتاجر.',    en:'The store does not exist in the store record.' },
    email_required:       { ar:'البريد الإلكتروني غير صالح.',         en:'The email is not valid.' },
    forbidden:            { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',   en:'You do not have permission for this action.' },
    FORBIDDEN:            { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',   en:'You do not have permission for this action.' },
    link_mismatch:        { ar:'تعذّر التحقق من ربط الحساب بالمتجر.', en:'The account ↔ store link could not be verified.' },
    unavailable:          { ar:'جهة الحسابات أو المتاجر غير متاحة.',  en:'The account or store authority is unavailable.' }
  };
  function failText(reason){ var m = FAIL_TXT[reason]; return m ? T(m.ar, m.en) : T('تعذّر الإعداد: ', 'Provisioning failed: ') + reason; }
  function provisioningFailed(id, a, step, reason, extra){
    var w = appendEvent(id, 'provisioning_failed', a, Object.assign({ step:step, reason:String(reason || 'unknown') }, extra || {}));
    audit('merchant.provisioning_failed', a, { key:w && w.record ? w.record.eventId : id + ':' + Date.now(),
      reason:String(reason || 'unknown'), metadata:Object.assign({ applicationId:id, step:step }, extra || {}) });
    var r = fail('PROVISIONING_FAILED', { step:step, reason:reason });
    r.message = T('فشل إعداد التاجر (', 'Merchant provisioning failed (') + T(step === 'store' ? 'المتجر' : step === 'account' ? 'الحساب' : 'الربط', step) + '): ' + failText(reason);
    return r;
  }
  function approveApplication(id, input){
    input = input || {};
    var bad = badKeys(input, ['note']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.DECIDE); if (!a.ok) return a;
    var s = state(id); if (!s) return fail('APPLICATION_NOT_FOUND');
    if (s.status !== STATUS.PENDING) return fail('APPLICATION_DECIDED', { status:s.status });
    var R = global.RAFPerm, SRC = global.RAFSource;
    if (!R || !R.provisionMerchantAccount || !SRC || !SRC.createStore) return provisioningFailed(id, a, 'store', 'unavailable');
    var note = text(input.note).slice(0, LIMITS.note) || null;

    /* 0 · preconditions that would stop the account step, checked BEFORE the
       store is created, so a known conflict leaves nothing half-made */
    var mine = null, users = [];
    try { users = R.getUsers() || []; } catch (e) { users = []; }
    mine = users.filter(function (x) { return x.provisionedFrom && x.provisionedFrom.applicationId === id; })[0] || null;
    if (!mine && users.some(function (x) { return text(x.email).toLowerCase() === text(s.applicant.email).toLowerCase(); }))
      return provisioningFailed(id, a, 'account', 'email_in_use');

    /* 1 · the store */
    var st = SRC.createStore({ name:s.store.name, categoryLabel:s.store.category, description:s.store.description,
      status:SRC.STORE_STATUS.CLOSED, origin:{ type:'merchant_application', applicationId:id, ref:s.ref } });
    if (!st || !st.ok) return provisioningFailed(id, a, 'store', (st && st.code) || 'unknown');
    if (!st.duplicate) {
      appendEvent(id, 'store_provisioned', a, { storeSlug:st.slug });
      audit('merchant.store_provisioned', a, { key:'store:' + id, newState:SRC.STORE_STATUS.CLOSED, metadata:{ applicationId:id, ref:s.ref, storeSlug:st.slug } });
    }

    /* 2 · the dedicated merchant account, linked to that store */
    var ac = R.provisionMerchantAccount({ name:s.applicant.name, email:s.applicant.email, phone:s.applicant.phone,
      storeSlug:st.slug, applicationId:id, applicationRef:s.ref });
    if (!ac || !ac.ok) return provisioningFailed(id, a, 'account', (ac && ac.reason) || 'unknown', { storeSlug:st.slug });
    if (!ac.duplicate) {
      appendEvent(id, 'account_provisioned', a, { accountId:ac.user.id, storeSlug:st.slug });
      audit('merchant.account_provisioned', a, { key:'account:' + id, newState:ac.user.status, metadata:{ applicationId:id, ref:s.ref, accountId:ac.user.id, storeSlug:st.slug } });
    }

    /* 3 · the relationship, read back through its authority */
    var link = null; try { link = R.storeLinkOf(ac.user.id); } catch (e) { link = null; }
    if (!link || !link.ok || link.slug !== st.slug) return provisioningFailed(id, a, 'link', 'link_mismatch', { storeSlug:st.slug, accountId:ac.user.id });

    /* 3b · the single-use activation token for that account (RAFMerchantAuth).
       Idempotent: a retry returns the token already issued. No email is sent. */
    var MAu = global.RAFMerchantAuth;
    if (!MAu || !MAu.issueActivation) return provisioningFailed(id, a, 'activation', 'unavailable', { storeSlug:st.slug, accountId:ac.user.id });
    var act = MAu.issueActivation(ac.user.id);
    if (!act || !act.ok) return provisioningFailed(id, a, 'activation', (act && act.code) || 'unknown', { storeSlug:st.slug, accountId:ac.user.id });
    if (!act.duplicate) appendEvent(id, 'activation_issued', a, { accountId:ac.user.id, activationId:act.activationId });

    /* 4 · the decision */
    var w = appendEvent(id, 'approved', a, { note:note, storeSlug:st.slug, accountId:ac.user.id });
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });
    audit('merchant.application_approved', a, { key:w.record.eventId, previousState:STATUS.PENDING, newState:STATUS.APPROVED,
      metadata:{ applicationId:id, ref:s.ref, storeSlug:st.slug, accountId:ac.user.id } });
    return { ok:true, application:state(id),
             provisioning:{ performed:true, storeSlug:st.slug, storeStatus:SRC.STORE_STATUS.CLOSED,
                            accountId:ac.user.id, accountStatus:ac.user.status, activation:'not_built' } };
  }
  function rejectApplication(id, input){
    input = input || {};
    var bad = badKeys(input, ['reason']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.DECIDE); if (!a.ok) return a;
    var s = state(id); if (!s) return fail('APPLICATION_NOT_FOUND');
    if (s.status !== STATUS.PENDING) return fail('APPLICATION_DECIDED', { status:s.status });
    var reason = text(input.reason);
    if (!reason || reason.length > LIMITS.reason) return fail('REASON_REQUIRED');
    var w = appendEvent(id, 'rejected', a, { reason:reason });
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });
    audit('merchant.application_rejected', a, { key:w.record.eventId, previousState:STATUS.PENDING, newState:STATUS.REJECTED,
      reason:reason, metadata:{ applicationId:id, ref:s.ref } });
    return { ok:true, application:state(id) };
  }

  /* what this account may do — a page asks, it never guesses; each
     operation above re-proves its own permission */
  function capabilities(){
    var a = actor(); if (!a.ok) return { ok:false, code:a.code, view:false, decide:false };
    return { ok:true, view:can(a.id, P.VIEW), decide:can(a.id, P.DECIDE) };
  }

  global.RAFMerchantApplications = {
    VERSION:VERSION, STATUS:STATUS, STATUS_TXT:STATUS_TXT, PERMISSIONS:P, PLANS:PLANS, DAYS:DAYS, DOC_KEYS:DOC_KEYS, ERRORS:ERRORS,
    createApplication:createApplication, listApplications:listApplications, getApplication:getApplication,
    approveApplication:approveApplication, rejectApplication:rejectApplication, capabilities:capabilities
  };
})(window);
