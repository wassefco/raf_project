/* ============================================================================
 * RAF Marketplace — CENTRAL REQUESTS & APPROVALS MODEL  (shared, headless)
 * ----------------------------------------------------------------------------
 * ONE model for every request that waits for a RAF Management decision.
 *
 *   originating authority → (this model) → RAF Management reviews and decides
 *                         ← decision is executed by the originating authority
 *
 * WHAT IT IS
 *   · A registry of request TYPES. Each type is an adapter over the authority
 *     that already owns the records: it reads them, presents each one in the
 *     central shape, and hands a decision back to that authority.
 *   · A read API (types / list / get / counts) and a decision API (decide).
 *
 * WHAT IT IS NOT
 *   · It stores NOTHING. There is no request table, no copy of an application,
 *     no second status and no approval database: every read goes to the
 *     originating authority, and the status is the authority's own.
 *   · It is not a permission system. Each type declares the EXISTING RAFPerm
 *     keys its authority already enforces (a driver application: drivers.view
 *     to read, drivers.approve to decide) and the authority re-proves them on
 *     every call — the checks here only shape what a page offers.
 *   · It writes no audit of its own: the authority records its decision in
 *     RAFAudit and in its own history, exactly as it always has.
 *
 * REQUEST ID  '<type>:<originating record id>' — stable and deep-linkable.
 *
 * TYPES TODAY  driver_application (RAFLogistics). A store application, an
 * advertisement approval or any other type joins by calling register() with
 * its own adapter; no page and no second approval system is needed.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFRequests) return;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function text(v){ return v == null ? '' : String(v).trim(); }

  /* the central lifecycle. A type maps its authority's states onto these and
     keeps its own label, so an authority with more states is never flattened */
  var STATUS = { PENDING:'pending', APPROVED:'approved', REJECTED:'rejected' };
  var STATUS_TXT = {
    pending:  { ar:'قيد المراجعة', en:'Pending' },
    approved: { ar:'مقبول',        en:'Approved' },
    rejected: { ar:'مرفوض',        en:'Rejected' }
  };
  var DECISION = { APPROVE:'approve', REJECT:'reject' };

  var ERRORS = {
    UNKNOWN_TYPE:     { ar:'نوع الطلب غير معروف.',                 en:'Unknown request type.' },
    NOT_FOUND:        { ar:'الطلب غير موجود.',                     en:'The request could not be found.' },
    FORBIDDEN:        { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',     en:'You do not have permission for this action.' },
    INVALID_DECISION: { ar:'القرار غير صالح.',                     en:'The decision is not valid.' },
    REASON_REQUIRED:  { ar:'سبب الرفض مطلوب.',                     en:'A rejection reason is required.' },
    NOT_PENDING:      { ar:'تم البت في هذا الطلب بالفعل.',          en:'This request has already been decided.' },
    UNAVAILABLE:      { ar:'تعذّر الوصول إلى الجهة المسؤولة عن الطلب.', en:'The request’s owning authority is unavailable.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* ══════════════════════ REGISTRY ══════════════════════ */
  var TYPES = {}, ORDER = [];
  /* adapter: { key, label{ar,en}, owner{key,ar,en}, icon,
               canView(), canDecide(),
               records() → { ok, items:[originRecord] },
               record(originId) → { ok, item },
               present(originRecord) → central request,
               decide(originId, decision, input) → authority result } */
  function register(adapter){
    if (!adapter || !adapter.key || TYPES[adapter.key]) return false;
    TYPES[adapter.key] = adapter; ORDER.push(adapter.key);
    return true;
  }
  function typeOf(key){ return TYPES[key] || null; }
  function viewable(){ return ORDER.map(typeOf).filter(function (t) { try { return !!t.canView(); } catch (e) { return false; } }); }
  function parseId(requestId){
    var s = text(requestId), i = s.indexOf(':');
    if (i < 1) return null;
    return { type:s.slice(0, i), originId:s.slice(i + 1) };
  }

  /* ══════════════════════ READS — never write ══════════════════════ */
  function canAccess(){ return viewable().length > 0; }
  function types(){
    return viewable().map(function (t) {
      return { key:t.key, label:copy(t.label), owner:copy(t.owner), icon:t.icon,
               canDecide:(function(){ try { return !!t.canDecide(); } catch (e) { return false; } })() };
    });
  }
  function all(){
    var out = [], errors = [];
    viewable().forEach(function (t) {
      var r = null; try { r = t.records(); } catch (e) { r = null; }
      if (!r || !r.ok) { errors.push({ type:t.key, message:(r && r.message) || null }); return; }
      r.items.forEach(function (rec) { try { out.push(t.present(rec)); } catch (e) {} });
    });
    return { items:out, errors:errors };
  }
  /* filters: { status, type, q } — q matches the request id, its reference,
     the requester, the type and the type's own searchable fields */
  function list(filters){
    filters = filters || {};
    if (!canAccess()) return fail('FORBIDDEN');
    var a = all(), q = text(filters.q).toLowerCase();
    var items = a.items.filter(function (r) {
      if (filters.status && r.status !== filters.status) return false;
      if (filters.type && r.type !== filters.type) return false;
      if (q && r.searchText.indexOf(q) < 0) return false;
      return true;
    }).sort(function (x, y) {
      /* waiting first, oldest waiting at the top; decided ones newest first */
      var px = x.status === STATUS.PENDING ? 0 : 1, py = y.status === STATUS.PENDING ? 0 : 1;
      if (px !== py) return px - py;
      return px === 0 ? (x.submittedAt || 0) - (y.submittedAt || 0) : (y.submittedAt || 0) - (x.submittedAt || 0);
    });
    return { ok:true, items:items.map(strip), errors:a.errors };
  }
  function counts(){
    if (!canAccess()) return fail('FORBIDDEN');
    var a = all(), c = { all:a.items.length, pending:0, approved:0, rejected:0, byType:{} };
    a.items.forEach(function (r) {
      if (c.hasOwnProperty(r.status)) c[r.status]++;
      c.byType[r.type] = (c.byType[r.type] || 0) + 1;
    });
    return { ok:true, counts:c };
  }
  function get(requestId){
    var p = parseId(requestId); if (!p) return fail('NOT_FOUND');
    var t = typeOf(p.type); if (!t) return fail('UNKNOWN_TYPE');
    var ok = false; try { ok = !!t.canView(); } catch (e) { ok = false; }
    if (!ok) return fail('FORBIDDEN');
    var r = null; try { r = t.record(p.originId); } catch (e) { r = null; }
    if (!r) return fail('UNAVAILABLE');
    if (!r.ok) return r.code === 'APPLICATION_NOT_FOUND' || r.code === 'NOT_FOUND' ? fail('NOT_FOUND') : r;
    var req = t.present(r.item);
    req.canDecide = req.status === STATUS.PENDING && (function(){ try { return !!t.canDecide(); } catch (e) { return false; } })();
    return { ok:true, request:strip(req) };
  }
  function strip(r){ var o = copy(r); delete o.searchText; return o; }

  /* ══════════════════════ DECISION — the one write path ══════════════════════
     The decision is executed by the originating authority, which enforces its
     own permission, records its own history and audit, and produces the
     operational result (for a driver application: the driver account). */
  function decide(requestId, decision, input){
    input = input || {};
    var p = parseId(requestId); if (!p) return fail('NOT_FOUND');
    var t = typeOf(p.type); if (!t) return fail('UNKNOWN_TYPE');
    if (decision !== DECISION.APPROVE && decision !== DECISION.REJECT) return fail('INVALID_DECISION');
    if (decision === DECISION.REJECT && !text(input.reason)) return fail('REASON_REQUIRED');
    var cur = get(requestId); if (!cur.ok) return cur;
    if (cur.request.status !== STATUS.PENDING) return fail('NOT_PENDING');
    var r = null;
    try { r = t.decide(p.originId, decision, { note:text(input.note) || null, reason:text(input.reason) || null }); } catch (e) { r = null; }
    if (!r) return fail('UNAVAILABLE');
    if (!r.ok) return r;                      /* the authority's own refusal, unchanged */
    var after = get(requestId);
    return { ok:true, request:after.ok ? after.request : null, result:copy(r.result || null) };
  }

  /* ══════════════════════ TYPE · DRIVER JOIN APPLICATION ══════════════════════
     Owner: RAFLogistics. Records: its join applications (immutable submission +
     append-only events; status derived there). Permissions: drivers.view to
     read, drivers.approve to decide — both enforced inside RAFLogistics. */
  var DOC_LABEL = {
    civilId:      { ar:'البطاقة المدنية',   en:'Civil ID' },
    license:      { ar:'رخصة القيادة',     en:'Driving licence' },
    registration: { ar:'دفتر المركبة',     en:'Vehicle registration' },
    photo:        { ar:'الصورة الشخصية',   en:'Personal photo' }
  };
  var EVENT_LABEL = {
    submitted: { ar:'تم تقديم الطلب',          en:'Application submitted' },
    review:    { ar:'ملاحظة مراجعة',           en:'Review note' },
    approved:  { ar:'تم قبول الطلب',           en:'Application approved' },
    rejected:  { ar:'تم رفض الطلب',            en:'Application rejected' }
  };
  var SOURCE_LABEL = {
    'public':    { ar:'طلب عام عبر موقع رف',      en:'Public application on the RAF site' },
    'logistics': { ar:'أنشأته إدارة اللوجستيات',  en:'Created by Logistics' }
  };
  function LG(){ return global.RAFLogistics || null; }
  function lgCaps(){ var L = LG(); if (!L) return null; try { var c = L.capabilities(); return c && c.ok ? c : null; } catch (e) { return null; } }
  function f(ar, en, value, opts){ opts = opts || {}; return { label:{ ar:ar, en:en }, value:value == null || value === '' ? null : value, dir:opts.dir || null, mono:!!opts.mono }; }

  register({
    key:'driver_application',
    label:{ ar:'طلب انضمام سائق', en:'Driver application' },
    owner:{ key:'logistics', ar:'اللوجستيات', en:'Logistics' },
    icon:'ti-user-plus',
    canView:function(){ var c = lgCaps(); return !!(c && c.view); },
    canDecide:function(){ var c = lgCaps(); return !!(c && c.approve); },
    records:function(){ var L = LG(); return L ? L.listApplications({}) : fail('UNAVAILABLE'); },
    record:function(id){
      var L = LG(); if (!L) return fail('UNAVAILABLE');
      var r = L.getApplication(id);
      return r && r.ok ? { ok:true, item:r.application } : r;
    },
    present:function(a){
      var p = a.applicant || {}, v = a.vehicle || {}, docs = a.documents || {};
      var attachments = [], missing = [];
      Object.keys(DOC_LABEL).forEach(function (k) {
        var d = docs[k];
        if (!d) { missing.push(copy(DOC_LABEL[k])); return; }
        attachments.push({ slot:k, label:copy(DOC_LABEL[k]), name:d.name || null, type:d.type || null,
          size:typeof d.size === 'number' ? d.size : null, ext:d.ext || null, at:d.at || null,
          /* the authority keeps file METADATA only (no file storage exists in
             this prototype); content is never invented */
          storage:d.storage || null, url:d.url || null,
          image:!!(d.type && /^image\//.test(d.type)) });
      });
      var status = a.status === 'approved' ? STATUS.APPROVED : a.status === 'rejected' ? STATUS.REJECTED : STATUS.PENDING;
      return {
        id:'driver_application:' + a.applicationId, type:'driver_application',
        typeLabel:{ ar:'طلب انضمام سائق', en:'Driver application' },
        owner:{ key:'logistics', authority:'RAFLogistics', ar:'اللوجستيات', en:'Logistics' },
        origin:{ record:a.applicationId, ref:a.ref || null,
                 href:'raf_logistics_drivers.html#mode=applications&app=' + encodeURIComponent(a.applicationId) },
        approveEffect:{ ar:'إنشاء حساب السائق أو تفعيله', en:'the driver account is created or activated' },
        reference:a.ref || null,
        status:status, statusText:copy(a.statusText || STATUS_TXT[status]),
        submittedAt:a.submittedAt || null,
        /* the applicant has no RAF account until the application is approved */
        requester:{ name:p.name || null, accountId:null },
        summary:[v.type, v.make, v.model].filter(Boolean).join(' · ') || null,
        sections:[
          { key:'applicant', title:{ ar:'بيانات المتقدم', en:'Applicant' }, fields:[
            f('الاسم الأول', 'First name', p.firstName), f('اسم العائلة', 'Last name', p.lastName),
            f('رقم الهاتف', 'Phone', p.phone, { dir:'ltr', mono:true }), f('البريد الإلكتروني', 'Email', p.email, { dir:'ltr' }),
            f('الرقم المدني', 'Civil ID', p.civilId, { dir:'ltr', mono:true }),
            f('الجنسية', 'Nationality', p.nationality), f('المنطقة', 'Area', p.area) ] },
          { key:'vehicle', title:{ ar:'المركبة', en:'Vehicle' }, fields:[
            f('النوع', 'Type', v.type), f('الشركة المصنّعة', 'Make', v.make), f('الطراز', 'Model', v.model),
            f('سنة الصنع', 'Year', v.year, { mono:true }), f('اللون', 'Colour', v.color),
            f('رقم اللوحة', 'Plate', v.plate, { dir:'ltr', mono:true }) ] },
          { key:'submission', title:{ ar:'التقديم', en:'Submission' }, fields:[
            f('رقم الطلب', 'Reference', a.ref, { mono:true }),
            f('مصدر الطلب', 'Source', SOURCE_LABEL[a.source] ? T(SOURCE_LABEL[a.source].ar, SOURCE_LABEL[a.source].en) : a.source),
            f('الموافقة على الشروط', 'Terms accepted', a.consent && a.consent.accepted ? { at:a.consent.at, terms:a.consent.terms || null } : null) ] }
        ],
        attachments:attachments, missingAttachments:missing,
        history:(a.history || []).map(function (e) {
          return { kind:e.kind, label:copy(EVENT_LABEL[e.kind] || { ar:e.kind, en:e.kind }), at:e.at || null,
                   actorName:e.actorName || null, note:e.note || null, reason:e.reason || null };
        }),
        decision:status === STATUS.PENDING ? null : {
          status:status, at:a.decidedAt || null, byName:a.decidedByName || null,
          reason:a.rejectionReason || null,
          note:(function(){ var n = null; (a.history || []).forEach(function (e) { if (e.kind === 'approved' && e.note) n = e.note; }); return n; })(),
          /* the operational result the authority produced — never its account id */
          result:status === STATUS.APPROVED && a.driverId ? { ar:'تم إنشاء حساب السائق أو تفعيله في اللوجستيات', en:'The driver account was created or activated in Logistics' } : null
        },
        searchText:[a.applicationId, 'driver_application:' + a.applicationId, a.ref, p.name, p.firstName, p.lastName,
                    'طلب انضمام سائق', 'driver application', p.area, v.type, v.plate].filter(Boolean).join(' ').toLowerCase()
      };
    },
    decide:function(id, decision, input){
      var L = LG(); if (!L) return fail('UNAVAILABLE');
      var r = decision === DECISION.APPROVE
        ? L.approveApplication(id, input.note ? { note:input.note } : {})
        : L.rejectApplication(id, { reason:input.reason });
      return r && r.ok ? { ok:true, result:decision === DECISION.APPROVE ? { accountCreated:!!r.accountCreated } : null } : r;
    }
  });

  /* ══════════════════════ TYPE · MERCHANT JOIN APPLICATION ══════════════════════
     Owner: RAFMerchantApplications (the public seller form's submissions).
     Permission: stores.approve, to read and to decide — enforced inside
     RAFMerchantApplications. The applicant is a PROSPECTIVE merchant: there is
     no RAF account behind the request, so no account id is shown. */
  var M_DOC = {
    civilId:          { ar:'البطاقة المدنية',          en:'Civil ID' },
    commercialRecord: { ar:'السجل التجاري / الترخيص',  en:'Commercial record / licence' },
    logo:             { ar:'شعار المتجر',             en:'Store logo' },
    cover:            { ar:'صورة غلاف المتجر',        en:'Store cover image' }
  };
  var M_EVENT = {
    submitted:           { ar:'تم تقديم الطلب',                     en:'Application submitted' },
    store_provisioned:   { ar:'تم إنشاء المتجر (مغلق)',             en:'Store provisioned (closed)' },
    account_provisioned: { ar:'تم إنشاء حساب التاجر (بانتظار التفعيل)', en:'Merchant account provisioned (pending activation)' },
    provisioning_failed: { ar:'فشل الإعداد',                         en:'Provisioning failed' },
    activation_issued:   { ar:'تم إصدار رابط التفعيل (بدون بريد إلكتروني)', en:'Activation link issued (no email sent)' },
    approved:            { ar:'تم قبول الطلب',                       en:'Application approved' },
    rejected:            { ar:'تم رفض الطلب',                        en:'Application rejected' }
  };
  var M_DAY = { sat:{ ar:'السبت', en:'Saturday' }, sun:{ ar:'الأحد', en:'Sunday' }, mon:{ ar:'الاثنين', en:'Monday' },
                tue:{ ar:'الثلاثاء', en:'Tuesday' }, wed:{ ar:'الأربعاء', en:'Wednesday' }, thu:{ ar:'الخميس', en:'Thursday' },
                fri:{ ar:'الجمعة', en:'Friday' } };
  function MA(){ return global.RAFMerchantApplications || null; }
  function maCaps(){ var M = MA(); if (!M) return null; try { var c = M.capabilities(); return c && c.ok ? c : null; } catch (e) { return null; } }

  register({
    key:'merchant_join',
    label:{ ar:'طلب انضمام تاجر', en:'Merchant application' },
    owner:{ key:'stores', ar:'إدارة رف — المتاجر', en:'RAF Management — Stores' },
    icon:'ti-building-store',
    canView:function(){ var c = maCaps(); return !!(c && c.view); },
    canDecide:function(){ var c = maCaps(); return !!(c && c.decide); },
    records:function(){ var M = MA(); return M ? M.listApplications({}) : fail('UNAVAILABLE'); },
    record:function(id){
      var M = MA(); if (!M) return fail('UNAVAILABLE');
      var r = M.getApplication(id);
      return r && r.ok ? { ok:true, item:r.application } : r;
    },
    present:function(a){
      var p = a.applicant || {}, s = a.store || {}, docs = a.documents || {}, h = a.hours || {};
      var attachments = [], missing = [];
      Object.keys(M_DOC).forEach(function (k) {
        var d = docs[k];
        if (!d) { missing.push(copy(M_DOC[k])); return; }
        attachments.push({ slot:k, label:copy(M_DOC[k]), name:d.name || null, type:d.type || null,
          size:typeof d.size === 'number' ? d.size : null, ext:d.ext || null, at:d.at || null,
          storage:d.storage || null, url:d.url || null, image:!!(d.type && /^image\//.test(d.type)) });
      });
      var plan = MA() && MA().PLANS[a.plan];
      var status = a.status === 'approved' ? STATUS.APPROVED : a.status === 'rejected' ? STATUS.REJECTED : STATUS.PENDING;
      return {
        id:'merchant_join:' + a.applicationId, type:'merchant_join',
        typeLabel:{ ar:'طلب انضمام تاجر', en:'Merchant application' },
        owner:{ key:'stores', authority:'RAFMerchantApplications', ar:'إدارة رف — المتاجر', en:'RAF Management — Stores' },
        /* no separate operational surface owns merchant applications — this page is where they are decided */
        origin:{ record:a.applicationId, ref:a.ref || null, href:null },
        reference:a.ref || null,
        status:status, statusText:copy(a.statusText || STATUS_TXT[status]),
        submittedAt:a.submittedAt || null,
        approveEffect:{ ar:'إنشاء المتجر مغلقاً وحساب تاجر مستقل مرتبط به وبانتظار التفعيل', en:'the store is created closed, with a dedicated merchant account linked to it, pending activation' },
        requester:{ name:p.name || null, accountId:null },
        summary:[s.name, s.category].filter(Boolean).join(' · ') || null,
        sections:[
          { key:'applicant', title:{ ar:'بيانات مقدّم الطلب', en:'Applicant' }, fields:[
            f('الاسم الأول', 'First name', p.firstName), f('الاسم الأخير', 'Last name', p.lastName),
            f('رقم الهاتف', 'Phone', p.phone, { dir:'ltr', mono:true }), f('البريد الإلكتروني', 'Email', p.email, { dir:'ltr' }),
            f('الرقم المدني', 'Civil ID', p.civilId, { dir:'ltr', mono:true }), f('الجنسية', 'Nationality', p.nationality) ] },
          { key:'store', title:{ ar:'بيانات المتجر', en:'Store' }, fields:[
            f('اسم المتجر', 'Store name', s.name), f('فئة المتجر', 'Store category', s.category),
            f('منطقة التشغيل', 'Operating area', s.area), f('عدد المنتجات المتوقعة', 'Expected products', s.expectedProducts),
            f('باقة الاشتراك', 'Plan', plan ? T(plan.ar, plan.en) : a.plan),
            f('وصف المتجر', 'Store description', s.description) ] },
          { key:'hours', title:{ ar:'ساعات العمل', en:'Working hours' }, fields:Object.keys(M_DAY).map(function (k) {
            var d = h[k] || {};
            return f(M_DAY[k].ar, M_DAY[k].en, d.open ? (d.from || '—') + ' – ' + (d.to || '—') : T('مغلق', 'Closed'));
          }) },
          { key:'submission', title:{ ar:'التقديم', en:'Submission' }, fields:[
            f('رقم الطلب', 'Reference', a.ref, { mono:true }),
            f('الموافقة على الشروط', 'Terms accepted', a.consent && a.consent.accepted ? { at:a.consent.at, terms:a.consent.terms || null } : null) ] }
        ],
        attachments:attachments, missingAttachments:missing,
        history:(a.history || []).map(function (e) {
          return { kind:e.kind, label:copy(M_EVENT[e.kind] || { ar:e.kind, en:e.kind }), at:e.at || null,
                   actorName:e.actorName || null, note:e.note || null, reason:e.reason || null };
        }),
        decision:status === STATUS.PENDING ? null : {
          status:status, at:a.decidedAt || null, byName:a.decidedByName || null,
          reason:a.rejectionReason || null, note:a.decisionNote || null,
          /* the provisioning the authorities actually performed */
          result:status === STATUS.APPROVED && a.provisioning && a.provisioning.state === 'complete'
            ? { ar:'تم إنشاء المتجر (' + (a.provisioning.storeSlug || '—') + ') مغلقاً، وحساب تاجر مستقل (' + (a.provisioning.accountId || '—') + ') مرتبطاً به.',
                en:'Store (' + (a.provisioning.storeSlug || '—') + ') created closed, with a dedicated merchant account (' + (a.provisioning.accountId || '—') + ') linked to it.' }
            : null,
          /* the account's activation as it stands now (RAFPerm + RAFMerchantAuth) */
          activation:status === STATUS.APPROVED && a.provisioning && a.provisioning.accountId ? (function(){
            var acc = null; try { acc = global.RAFPerm ? RAFPerm.getUser(a.provisioning.accountId) : null; } catch (e) { acc = null; }
            var link = null; try { link = global.RAFMerchantAuth ? RAFMerchantAuth.prototypeActivationLink(a.provisioning.accountId) : null; } catch (e) { link = null; }
            return { accountStatus:acc ? acc.status : null, linkState:link && link.ok ? link.state : null,
                     href:link && link.ok ? link.href || null : null, expiresAt:link && link.ok ? link.expiresAt || null : null };
          })() : null
        },
        /* shown while the request is still pending: a failed or partial
           provisioning attempt, stated with its real reason */
        notices:status === STATUS.PENDING && a.provisioning && a.provisioning.lastFailure ? [{
          tone:'hot',
          ar:'فشلت محاولة الإعداد السابقة: ' + (a.provisioning.lastFailure.text || a.provisioning.lastFailure.reason)
             + (a.provisioning.storeSlug ? ' — المتجر ' + a.provisioning.storeSlug + ' أُنشئ ويُعاد استخدامه عند إعادة المحاولة.' : ''),
          en:'The previous provisioning attempt failed: ' + (a.provisioning.lastFailure.text || a.provisioning.lastFailure.reason)
             + (a.provisioning.storeSlug ? ' — store ' + a.provisioning.storeSlug + ' was created and is reused on retry.' : '')
        }] : [],
        searchText:[a.applicationId, 'merchant_join:' + a.applicationId, a.ref, p.name, p.firstName, p.lastName,
                    'طلب انضمام تاجر', 'merchant application', s.name, s.category, s.area].filter(Boolean).join(' ').toLowerCase()
      };
    },
    decide:function(id, decision, input){
      var M = MA(); if (!M) return fail('UNAVAILABLE');
      var r = decision === DECISION.APPROVE
        ? M.approveApplication(id, input.note ? { note:input.note } : {})
        : M.rejectApplication(id, { reason:input.reason });
      return r && r.ok ? { ok:true, result:r.provisioning ? copy(r.provisioning) : null } : r;
    }
  });

  global.RAFRequests = {
    STATUS:STATUS, STATUS_TXT:STATUS_TXT, DECISION:DECISION, ERRORS:ERRORS,
    register:register, canAccess:canAccess, types:types,
    list:list, counts:counts, get:get, decide:decide, parseId:parseId
  };
})(window);
