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
  /* CANCELLED — withdrawn by the requester while pending (store closure and
     extension requests). Final: not decidable, kept in history. */
  var STATUS = { PENDING:'pending', APPROVED:'approved', REJECTED:'rejected', CANCELLED:'cancelled' };
  var STATUS_TXT = {
    pending:   { ar:'قيد المراجعة', en:'Pending' },
    approved:  { ar:'مقبول',        en:'Approved' },
    rejected:  { ar:'مرفوض',        en:'Rejected' },
    cancelled: { ar:'ملغى',         en:'Cancelled' }
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
    var a = all(), c = { all:a.items.length, pending:0, approved:0, rejected:0, cancelled:0, byType:{} };
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

  /* ══════════════════ TYPES · STORE FULL CLOSURE / CLOSURE EXTENSION ══════════════════
     Owner: RAFStoreStatus. Two DISTINCT request types:
       store_closure            a merchant asks to close its store for N days
       store_closure_extension  a merchant asks to extend an ACTIVE approved
                                closure by N more days
     Permission: stores.manage, to read and to decide — enforced inside
     RAFStoreStatus. Approving applies the request; rejecting leaves the store
     and any approved closure as they are. A merchant may cancel its own
     pending request: it then reads `cancelled` here, final and not decidable.
     The requester IS a RAF merchant account, so its id is shown. */
  var C_STORE = { open:{ ar:'مفتوح', en:'Open' }, closed:{ ar:'مغلق', en:'Closed' }, suspended:{ ar:'موقوف', en:'Suspended' } };
  function SS(){ return global.RAFStoreStatus || null; }
  function ssCaps(){ var S = SS(); if (!S) return null; try { var c = S.capabilities(); return c && c.ok ? c : null; } catch (e) { return null; } }
  function when(ms){
    if (!ms) return null;
    try { return new Date(ms).toLocaleString(isEn() ? 'en-GB' : 'ar-KW-u-nu-latn', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kuwait' }); }
    catch (e) { return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); }
  }
  function storeClosureType(spec){
    var kind = spec.kind, type = spec.type;
    register({
      key:type, label:copy(spec.label),
      owner:{ key:'stores', ar:'إدارة رف — المتاجر', en:'RAF Management — Stores' },
      icon:spec.icon,
      canView:function(){ var c = ssCaps(); return !!(c && c.manage); },
      canDecide:function(){ var c = ssCaps(); return !!(c && c.manage); },
      records:function(){ var S = SS(); return S ? S.listRequests({ kind:kind }) : fail('UNAVAILABLE'); },
      record:function(id){
        var S = SS(); if (!S) return fail('UNAVAILABLE');
        var r = S.getRequest(id);
        if (r && r.ok && r.request.kind !== kind) return fail('NOT_FOUND');
        return r && r.ok ? { ok:true, item:r.request } : (r && r.code === 'REQUEST_NOT_FOUND' ? fail('NOT_FOUND') : r);
      },
      present:function(q){
        var st = null; try { st = global.RAFSource ? RAFSource.store(q.storeSlug) : null; } catch (e) { st = null; }
        var name = st && st.name ? T(st.name.ar || st.name.en, st.name.en || st.name.ar) : null;
        var status = q.status === 'approved' ? STATUS.APPROVED : q.status === 'rejected' ? STATUS.REJECTED
                   : q.status === 'cancelled' ? STATUS.CANCELLED : STATUS.PENDING;
        var cl = st && st.closure ? st.closure : null;
        var fields = [
          f('رقم الطلب', 'Reference', q.ref, { mono:true }),
          f(kind === 'extension' ? 'الأيام الإضافية' : 'عدد الأيام', kind === 'extension' ? 'Additional days' : 'Number of days', q.days, { mono:true }),
          f('السبب', 'Reason', q.reason),
          f('حساب التاجر', 'Merchant account', (q.accountName || '—') + ' (' + (q.accountId || '—') + ')') ];
        if (kind === 'extension') fields.push(
          f('الإغلاق المعتمد', 'Approved closure', q.closureRef, { mono:true }),
          f('نهاية الإغلاق عند الطلب', 'Closure end when requested', when(q.endsAtAtRequest)));
        return {
          id:type + ':' + q.requestId, type:type, typeLabel:copy(spec.label),
          owner:{ key:'stores', authority:'RAFStoreStatus', ar:'إدارة رف — المتاجر', en:'RAF Management — Stores' },
          origin:{ record:q.requestId, ref:q.ref || null, href:'raf_admin_stores.html#store=' + encodeURIComponent(q.storeSlug) },
          reference:q.ref || null,
          status:status, statusText:copy(q.statusText || STATUS_TXT[status]),
          submittedAt:q.createdAt || null,
          approveEffect:spec.effect(q),
          requester:{ name:q.accountName || null, accountId:q.accountId || null },
          summary:[name, q.days + ' ' + T('يوم', 'day(s)')].filter(Boolean).join(' · '),
          sections:[
            { key:'store', title:{ ar:'المتجر', en:'Store' }, fields:[
              f('المتجر', 'Store', name), f('معرّف المتجر', 'Store ID', q.storeSlug, { mono:true, dir:'ltr' }),
              f('الحالة الحالية', 'Current status', st && C_STORE[st.status] ? T(C_STORE[st.status].ar, C_STORE[st.status].en) : (st ? st.status : null)),
              f('الحالة عند الطلب', 'Status when requested', C_STORE[q.storeStatusAtRequest] ? T(C_STORE[q.storeStatusAtRequest].ar, C_STORE[q.storeStatusAtRequest].en) : null),
              f('نهاية الإغلاق المعتمد الحالي', 'Current approved closure ends', cl && cl.endsAt ? when(cl.endsAt) : null) ] },
            { key:'closure', title:copy(spec.section), fields:fields }
          ],
          attachments:[], missingAttachments:[],
          history:(q.history || []).map(function (e) {
            return { kind:e.kind, label:copy(spec.events[e.kind] || { ar:e.kind, en:e.kind }), at:e.at || null,
                     actorName:e.actorName || null, note:e.note || null, reason:e.reason || null };
          }),
          decision:status === STATUS.PENDING ? null : {
            status:status, at:q.decidedAt || null, byName:q.decidedByName || null,
            reason:q.rejectionReason || null, note:q.decisionNote || null,
            result:status === STATUS.APPROVED ? spec.result(q) : status === STATUS.CANCELLED
              ? { ar:'ألغى التاجر الطلب قبل البت فيه؛ لم تتغير حالة المتجر.', en:'The merchant cancelled the request before a decision; the store was not changed.' }
              : spec.rejected
          },
          notices:status === STATUS.PENDING ? spec.notices(q, st) : [],
          searchText:[q.requestId, type + ':' + q.requestId, q.ref, q.closureRef, q.accountName, q.storeSlug, name,
                      spec.label.ar, spec.label.en, q.reason].filter(Boolean).join(' ').toLowerCase()
        };
      },
      decide:function(id, decision, input){
        var S = SS(); if (!S) return fail('UNAVAILABLE');
        var r = decision === DECISION.APPROVE
          ? S.approveRequest(id, input.note ? { note:input.note } : {})
          : S.rejectRequest(id, { reason:input.reason });
        return r && r.ok ? { ok:true, result:null } : r;
      }
    });
  }
  storeClosureType({
    kind:'closure', type:'store_closure', icon:'ti-building-store',
    label:{ ar:'طلب إغلاق متجر', en:'Store closure request' },
    section:{ ar:'طلب الإغلاق', en:'Closure request' },
    events:{ submitted:{ ar:'قدّم التاجر طلب الإغلاق', en:'Closure requested by the merchant' },
             approved:{ ar:'تم قبول الطلب وإغلاق المتجر', en:'Request approved — store closed' },
             rejected:{ ar:'تم رفض الطلب', en:'Request rejected' },
             cancelled:{ ar:'ألغى التاجر الطلب', en:'Cancelled by the merchant' } },
    effect:function(q){ return { ar:'إغلاق المتجر (الحالة: مغلق) لمدة ' + q.days + ' يوم تبدأ عند الاعتماد، ثم يعود مفتوحاً تلقائياً عند انتهائها',
                                 en:'the store is closed (status: closed) for ' + q.days + ' day(s) from approval, then returns to open automatically when that period ends' }; },
    result:function(q){ return { ar:'أُغلق المتجر (' + q.storeSlug + ') لمدة ' + q.days + ' يوم.', en:'Store (' + q.storeSlug + ') closed for ' + q.days + ' day(s).' }; },
    rejected:{ ar:'لم تتغير حالة المتجر.', en:'The store status was not changed.' },
    notices:function(q, st){ return st && st.status === 'suspended' ? [{ tone:'hot',
      ar:'المتجر موقوف حالياً. قيد في التنفيذ الحالي: لا يُطبَّق اعتماد الإغلاق على متجر موقوف لأن قاعدة هذه الحالة لم تُحدَّد بعد.',
      en:'The store is currently suspended. Current implementation limitation: a closure approval is not applied to a suspended store, because the rule for this case is not defined yet.' }] : []; }
  });
  storeClosureType({
    kind:'extension', type:'store_closure_extension', icon:'ti-calendar-plus',
    label:{ ar:'طلب تمديد إغلاق متجر', en:'Store closure extension' },
    section:{ ar:'طلب التمديد', en:'Extension request' },
    events:{ submitted:{ ar:'قدّم التاجر طلب التمديد', en:'Extension requested by the merchant' },
             approved:{ ar:'تم قبول التمديد', en:'Extension approved' },
             rejected:{ ar:'تم رفض التمديد', en:'Extension rejected' },
             cancelled:{ ar:'ألغى التاجر الطلب', en:'Cancelled by the merchant' } },
    effect:function(q){ return { ar:'تمديد الإغلاق المعتمد (' + (q.closureRef || '—') + ') ' + q.days + ' يوم إضافي',
                                 en:'the approved closure (' + (q.closureRef || '—') + ') is extended by ' + q.days + ' more day(s)' }; },
    result:function(q){ return { ar:'مُدِّد الإغلاق المعتمد ' + q.days + ' يوم.', en:'The approved closure was extended by ' + q.days + ' day(s).' }; },
    rejected:{ ar:'بقي الإغلاق المعتمد كما هو.', en:'The approved closure was left unchanged.' },
    notices:function(q, st){
      if (st && st.status === 'suspended') return [{ tone:'hot', ar:'المتجر موقوف إدارياً؛ لا يُطبَّق التمديد على متجر موقوف.', en:'The store is administratively suspended; an extension is not applied to a suspended store.' }];
      if (!st || st.status !== 'closed' || !st.closure || st.closure.requestId !== q.closureRequestId)
        return [{ tone:'hot', ar:'الإغلاق المعتمد الذي يشير إليه هذا الطلب لم يعد نشطاً؛ لا يمكن تطبيق التمديد.', en:'The approved closure this request refers to is no longer active; the extension cannot be applied.' }];
      return [];
    }
  });

  /* ══════════════════════ TYPE · STORE PROFILE CHANGE ══════════════════════
     Owner: RAFStoreProfile. A merchant's submitted change set for its own
     store's profile; nothing is live until approved. Permission:
     stores.approve, to read and to decide — enforced inside RAFStoreProfile.
     Approving writes the requested TEXT fields to the store record; media is
     metadata only (no file storage exists) and is never applied. */
  var SP_EVENT = {
    submitted: { ar:'قدّم التاجر طلب تعديل الملف', en:'Profile change submitted by the merchant' },
    approved:  { ar:'تم قبول التعديل وتطبيقه',      en:'Change approved and applied' },
    rejected:  { ar:'تم رفض الطلب',                en:'Request rejected' }
  };
  function SPA(){ return global.RAFStoreProfile || null; }
  function spCaps(){ var A = SPA(); if (!A) return null; try { var c = A.capabilities(); return c && c.ok ? c : null; } catch (e) { return null; } }
  function spLabel(f){ var A = SPA(), d = A && (A.FIELDS[f] || A.MEDIA[f]); return d ? d.label : { ar:f, en:f }; }
  function spSize(b){ return typeof b === 'number' ? (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : (b / 1048576).toFixed(1) + ' MB') : null; }
  register({
    key:'store_profile_change',
    label:{ ar:'تعديل ملف متجر', en:'Store profile change' },
    owner:{ key:'stores', ar:'إدارة رف — المتاجر', en:'RAF Management — Stores' },
    icon:'ti-id-badge-2',
    canView:function(){ var c = spCaps(); return !!(c && c.decide); },
    canDecide:function(){ var c = spCaps(); return !!(c && c.decide); },
    records:function(){ var A = SPA(); return A ? A.listRequests({}) : fail('UNAVAILABLE'); },
    record:function(id){
      var A = SPA(); if (!A) return fail('UNAVAILABLE');
      var r = A.getRequest(id);
      return r && r.ok ? { ok:true, item:r.request } : (r && r.code === 'REQUEST_NOT_FOUND' ? fail('NOT_FOUND') : r);
    },
    present:function(q){
      var st = null; try { st = global.RAFSource ? RAFSource.store(q.storeSlug) : null; } catch (e) { st = null; }
      var liveName = st && st.name ? T(st.name.ar || st.name.en, st.name.en || st.name.ar) : null;
      var status = q.status === 'approved' ? STATUS.APPROVED : q.status === 'rejected' ? STATUS.REJECTED : STATUS.PENDING;
      var ch = q.changes || {}, keys = Object.keys(ch);
      var textKeys = keys.filter(function (k) { return ch[k].kind === 'text'; }), mediaKeys = keys.filter(function (k) { return ch[k].kind === 'media'; });
      /* field by field: the value when the request was submitted → the value requested */
      var diff = [];
      textKeys.forEach(function (k) {
        var lb = spLabel(k), c = ch[k];
        diff.push(f(lb.ar + ' (عربي) — الحالي', lb.en + ' (Arabic) — current', c.from.ar, { dir:'rtl' }));
        diff.push(f(lb.ar + ' (عربي) — المطلوب', lb.en + ' (Arabic) — requested', c.to.ar, { dir:'rtl' }));
        diff.push(f(lb.ar + ' (إنجليزي) — الحالي', lb.en + ' (English) — current', c.from.en, { dir:'ltr' }));
        diff.push(f(lb.ar + ' (إنجليزي) — المطلوب', lb.en + ' (English) — requested', c.to.en, { dir:'ltr' }));
      });
      mediaKeys.forEach(function (k) {
        var lb = spLabel(k), c = ch[k];
        diff.push(f(lb.ar + ' — الحالي', lb.en + ' — current', c.from ? T('صورة حالية على المتجر', 'An image is set on the store') : null));
        diff.push(f(lb.ar + ' — المطلوب', lb.en + ' — requested',
          (c.to.name || '—') + (c.to.type ? ' · ' + c.to.type : '') + (spSize(c.to.size) ? ' · ' + spSize(c.to.size) : '') + T(' (بيانات الملف فقط)', ' (file details only)')));
      });
      /* live values that moved since submission — the approval refuses them */
      var drift = textKeys.filter(function (k) {
        var cur = (st && st[k]) || {}, fr = ch[k].from || {};
        return (cur.ar || '') !== (fr.ar || '') || (cur.en || '') !== (fr.en || '');
      });
      var notices = [];
      if (status === STATUS.PENDING && drift.length) notices.push({ tone:'hot',
        ar:'تغيّر ملف المتجر منذ تقديم الطلب في: ' + drift.map(function (k) { return spLabel(k).ar; }).join('، ') + '. لا يُطبَّق الاعتماد فوق قيمة أحدث؛ ارفض الطلب ليُعاد تقديمه.',
        en:'The store profile changed since submission in: ' + drift.map(function (k) { return spLabel(k).en; }).join(', ') + '. An approval is not applied over a newer value; reject it so it can be resubmitted.' });
      if (status === STATUS.PENDING && mediaKeys.length) notices.push({ tone:'hot',
        ar:'لا يوجد تخزين ملفات في هذا النموذج: تُحفظ بيانات الصورة المختارة فقط، ولا تُطبَّق على المتجر حتى عند الموافقة.',
        en:'This prototype has no file storage: only the chosen image’s details are kept, and it is not applied to the store even when approved.' });
      return {
        id:'store_profile_change:' + q.requestId, type:'store_profile_change',
        typeLabel:{ ar:'تعديل ملف متجر', en:'Store profile change' },
        owner:{ key:'stores', authority:'RAFStoreProfile', ar:'إدارة رف — المتاجر', en:'RAF Management — Stores' },
        origin:{ record:q.requestId, ref:q.ref || null, href:'raf_admin_stores.html#store=' + encodeURIComponent(q.storeSlug) },
        reference:q.ref || null,
        status:status, statusText:copy(q.statusText || STATUS_TXT[status]),
        submittedAt:q.createdAt || null,
        approveEffect:{ ar:'تطبيق التعديلات النصية المطلوبة (' + textKeys.map(function (k) { return spLabel(k).ar; }).join('، ') + ') على ملف المتجر' + (mediaKeys.length ? '؛ الصور لا تُطبَّق (لا يوجد تخزين ملفات)' : ''),
                        en:'the requested text changes (' + textKeys.map(function (k) { return spLabel(k).en; }).join(', ') + ') are applied to the store profile' + (mediaKeys.length ? '; images are not applied (no file storage)' : '') },
        requester:{ name:q.accountName || null, accountId:q.accountId || null },
        summary:[liveName, keys.map(function (k) { return T(spLabel(k).ar, spLabel(k).en); }).join(T('، ', ', '))].filter(Boolean).join(' · '),
        sections:[
          { key:'store', title:{ ar:'المتجر', en:'Store' }, fields:[
            f('المتجر (الاسم الحالي)', 'Store (current name)', liveName), f('معرّف المتجر', 'Store ID', q.storeSlug, { mono:true, dir:'ltr' }),
            f('حساب التاجر', 'Merchant account', (q.accountName || '—') + ' (' + (q.accountId || '—') + ')') ] },
          { key:'changes', title:{ ar:'التعديلات المطلوبة', en:'Requested changes' }, fields:diff }
        ],
        attachments:mediaKeys.map(function (k) {
          var m = ch[k].to;
          return { slot:k, label:copy(spLabel(k)), name:m.name || null, type:m.type || null, size:typeof m.size === 'number' ? m.size : null,
                   ext:m.ext || null, at:m.at || null, storage:m.storage || 'metadata_only', url:null, image:!!(m.type && /^image\//.test(m.type)) };
        }),
        missingAttachments:[],
        history:(q.history || []).map(function (e) {
          return { kind:e.kind, label:copy(SP_EVENT[e.kind] || { ar:e.kind, en:e.kind }), at:e.at || null,
                   actorName:e.actorName || null, note:e.note || null, reason:e.reason || null };
        }),
        decision:status === STATUS.PENDING ? null : {
          status:status, at:q.decidedAt || null, byName:q.decidedByName || null,
          reason:q.rejectionReason || null, note:q.decisionNote || null,
          result:status === STATUS.APPROVED
            ? { ar:'طُبّقت على ملف المتجر: ' + ((q.applied && q.applied.fields || []).map(function (k) { return spLabel(k).ar; }).join('، ') || '—')
                  + ((q.applied && q.applied.mediaNotApplied || []).length ? '. لم تُطبَّق الصور (لا يوجد تخزين ملفات).' : '.'),
                en:'Applied to the store profile: ' + ((q.applied && q.applied.fields || []).map(function (k) { return spLabel(k).en; }).join(', ') || '—')
                  + ((q.applied && q.applied.mediaNotApplied || []).length ? '. Images were not applied (no file storage).' : '.') }
            : { ar:'لم يتغير ملف المتجر.', en:'The store profile was not changed.' }
        },
        notices:notices,
        searchText:[q.requestId, 'store_profile_change:' + q.requestId, q.ref, q.accountName, q.storeSlug, liveName,
                    'تعديل ملف متجر', 'store profile change'].filter(Boolean).join(' ').toLowerCase()
      };
    },
    decide:function(id, decision, input){
      var A = SPA(); if (!A) return fail('UNAVAILABLE');
      var r = decision === DECISION.APPROVE
        ? A.approveRequest(id, input.note ? { note:input.note } : {})
        : A.rejectRequest(id, { reason:input.reason });
      return r && r.ok ? { ok:true, result:null } : r;
    }
  });

  global.RAFRequests = {
    STATUS:STATUS, STATUS_TXT:STATUS_TXT, DECISION:DECISION, ERRORS:ERRORS,
    register:register, canAccess:canAccess, types:types,
    list:list, counts:counts, get:get, decide:decide, parseId:parseId
  };
})(window);
