/* ============================================================================
 * RAF Marketplace — STORE PROFILE AUTHORITY  (shared, headless)
 * ----------------------------------------------------------------------------
 * The one guarded way a store's public profile changes. The profile itself
 * is stored where it always was — the store record in RAFSource
 * (RAFSource.updateStore is only the storage layer and checks nothing).
 *
 * CONFIRMED RULE — nothing a merchant edits is live immediately:
 *   merchant edits → submitChange()  → ONE Store Profile Change Request
 *                    (RAFRequests type `store_profile_change`)
 *   RAF Management  → approve  → the requested fields are written to the
 *                                 store record, in one write
 *                   → reject (reason required) → the store is untouched
 * A pending request never touches the live profile. update() — the old
 * direct merchant write — is closed: it refuses and points to submitChange.
 *
 * FIELDS — each is a field the store record already has:
 *   name  { ar, en }   the store name (also what the cart shows)
 *   desc  { ar, en }   the storefront description
 *   cat   { ar, en }   the store's category LABEL as the record holds it —
 *                      free text, never mapped to a catalogue key
 *   logo, cover        MEDIA — see below
 * NOT profile fields, and never accepted: status (RAFStoreStatus), number,
 * schedule (RAFStoreSchedule), products, anything operational.
 *
 * MEDIA — this prototype has NO file storage. A logo / cover the merchant
 * chooses is recorded as the file's own metadata only (name, type, size),
 * storage:'metadata_only' — the same shape the merchant application uses.
 * No file content is read or stored, so there is nothing that could become
 * the live image: an approved media change is recorded as approved and NOT
 * applied, and every surface says so. The live logo / cover never change
 * through this authority until real file storage exists.
 *
 * PERMISSIONS
 *   read            stores.view  + own store (RAFPerm.storeSlugOf)
 *   submitChange    stores.edit  + own store — a caller can never name a store
 *   list / decide   stores.approve (the existing store-approval key), held by
 *                   an account that is NOT store-scoped (RAFPerm.isMerchant)
 *
 * STORAGE (RAFRecordStore, append-only — REQUESTS, not a profile source):
 *   store_profile_requests        the immutable change request
 *   store_profile_request_events  submitted / approved / rejected — one final
 *                                 outcome per request (fixed decision id)
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFStoreProfile) return;

  /* the text fields, each a { ar, en } text. Limits are technical guards
     against runaway input, not business rules. */
  var FIELDS = {
    name: { max:80,   multiline:false, label:{ ar:'اسم المتجر', en:'Store name' } },
    desc: { max:1000, multiline:true,  label:{ ar:'وصف المتجر', en:'Store description' } },
    cat:  { max:80,   multiline:false, label:{ ar:'فئة المتجر', en:'Store category' } }
  };
  var MEDIA = {
    logo:  { label:{ ar:'شعار المتجر', en:'Store logo' } },
    cover: { label:{ ar:'صورة الغلاف', en:'Cover image' } }
  };
  var LANGS = ['ar', 'en'];
  var P = { VIEW:'stores.view', EDIT:'stores.edit', DECIDE:'stores.approve' };
  var REQ = { PENDING:'pending', APPROVED:'approved', REJECTED:'rejected' };
  var REQ_TXT = {
    pending:  { ar:'قيد المراجعة', en:'Pending review' },
    approved: { ar:'مقبول',        en:'Approved' },
    rejected: { ar:'مرفوض',        en:'Rejected' }
  };
  var LIMITS = { reason:300, note:600, key:80 };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function str(v){ return v == null ? '' : String(v).trim(); }

  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية لهذا الإجراء.',            en:'You do not have permission for this action.' },
    UNAUTHENTICATED:    { ar:'يلزم تسجيل الدخول.',                         en:'Sign-in is required.' },
    NO_STORE:           { ar:'لا يوجد متجر مرتبط بهذا الحساب.',            en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:    { ar:'المتجر المرتبط غير موجود.',                  en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'هذا الحقل لا يمكن تعديله من هنا.',           en:'That field cannot be changed here.' },
    INVALID:            { ar:'البيانات غير صالحة.',                        en:'The details are not valid.' },
    STALE:              { ar:'تم تعديل ملف المتجر من جلسة أخرى. أعد التحميل ثم حاول مجددًا.',
                          en:'The store profile was changed in another session. Reload and try again.' },
    NO_CHANGES:         { ar:'لا توجد تغييرات لإرسالها.',                  en:'There are no changes to submit.' },
    PERSIST_FAILED:     { ar:'تعذّر الحفظ.',                               en:'Could not save.' },
    APPROVAL_REQUIRED:  { ar:'لا يُطبَّق أي تعديل على ملف المتجر مباشرة. أرسل التعديلات للموافقة من إدارة رف.',
                          en:'No store-profile change is applied directly. Submit the changes for RAF Management approval.' },
    UNAVAILABLE:        { ar:'تعذّر الوصول إلى سجل الطلبات.',             en:'The request record is unavailable.' },
    REQUEST_NOT_FOUND:  { ar:'الطلب غير موجود.',                          en:'The request could not be found.' },
    REQUEST_DECIDED:    { ar:'تم البت في هذا الطلب بالفعل.',               en:'This request has already been decided.' },
    REASON_REQUIRED:    { ar:'سبب الرفض مطلوب.',                          en:'A rejection reason is required.' },
    PROFILE_CHANGED:    { ar:'تغيّر ملف المتجر منذ تقديم الطلب في حقل يشمله الطلب؛ لا يُطبَّق فوق قيمة أحدث. ارفض الطلب ليُعاد تقديمه.',
                          en:'The store profile changed since this request was submitted, in a field it covers; it is not applied over a newer value. Reject it so it can be resubmitted.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* only ever the id — a role or store written onto an object is not trusted */
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  function scope(actor){
    var id = actorId(actor);
    if (!id || !global.RAFPerm || !global.RAFSource || !RAFPerm.getUser(id)) return fail('FORBIDDEN');
    var slug = null;
    try { slug = RAFPerm.storeSlugOf(id) || null; } catch (e) { slug = null; }
    if (!slug) return fail('NO_STORE');
    var store = RAFSource.store(slug);
    if (!store) return fail('STORE_NOT_FOUND');
    return { ok:true, id:id, slug:slug, store:store };
  }
  function can(key, actor){
    var id = actorId(actor);
    if (!id || !global.RAFPerm) return false;
    try { var u = RAFPerm.getUser(id); return !!(u && u.status === 'active' && RAFPerm.can(id, key)); } catch (e) { return false; }
  }
  function canView(actor){ return can(P.VIEW, actor); }
  function canEdit(actor){ return can(P.EDIT, actor); }
  function isMerchantAcc(id){ try { return !!(global.RAFPerm && RAFPerm.isMerchant(id)); } catch (e) { return false; } }
  /* this tab's signed-in session — decisions are never taken for a named actor */
  function sessionActor(){
    var R = global.RAFPerm; if (!R) return fail('UNAVAILABLE');
    var id = null; try { id = R.sessionUserId ? R.sessionUserId() : null; } catch (e) { id = null; }
    var u = null; if (id) { try { u = R.getUser(id); } catch (e) { u = null; } }
    if (!u) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('FORBIDDEN');
    return { ok:true, id:u.id, name:u.name || u.id };
  }
  function staff(){
    var a = sessionActor(); if (!a.ok) return a;
    if (!can(P.DECIDE, a.id) || isMerchantAcc(a.id)) return fail('FORBIDDEN', { required:P.DECIDE });
    return a;
  }
  function audit(action, a, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try { return RAFAudit.record(Object.assign({ action:action, actor:a ? { id:a.id } : undefined }, extra || {})); }
    catch (e) { return null; }
  }

  function versionOf(store){ return (store && store.profileUpdatedAt) || 0; }
  function text(v){ return typeof v === 'string' ? v : ''; }
  function pair(o){ o = (o && typeof o === 'object') ? o : {}; return { ar:text(o.ar), en:text(o.en) }; }
  function same(a, b){ a = pair(a); b = pair(b); return a.ar === b.ar && a.en === b.en; }

  /* the acting account's own store, as the profile editor needs it */
  function read(opts){
    opts = opts || {};
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!canView(sc.id)) return fail('FORBIDDEN');
    var s = sc.store;
    return {
      ok:true, slug:sc.slug, editable:canEdit(sc.id), version:versionOf(s),
      fields:{ name:pair(s.name), desc:pair(s.desc), cat:pair(s.cat) },
      media:{ logo:s.logo || '', cover:s.cover || '' },
      /* shown, never edited here */
      fixed:{ name:pair(s.name), num:s.num || null, cat:pair(s.cat), logo:s.logo || '', cover:s.cover || '',
              status:s.status || null, icon:s.ic || null },
      updatedAt:s.profileUpdatedAt || null
    };
  }

  function validate(patch){
    var errors = [];
    Object.keys(patch).forEach(function (f) {
      var rule = FIELDS[f], v = patch[f];
      if (!rule) { errors.push({ field:f, message:T('حقل غير مدعوم','Unsupported field') }); return; }
      if (!v || typeof v !== 'object') { errors.push({ field:f, message:T('قيمة غير صالحة','Invalid value') }); return; }
      Object.keys(v).forEach(function (l) {
        if (LANGS.indexOf(l) < 0) errors.push({ field:f + '.' + l, message:T('لغة غير مدعومة','Unsupported language') });
      });
      LANGS.forEach(function (l) {
        var t = v[l];
        if (typeof t !== 'string') { errors.push({ field:f + '.' + l, message:T('النص مطلوب','Text is required') }); return; }
        var s = t.trim();
        /* the storefront always shows both languages; a blank one would read as broken */
        if (!s) errors.push({ field:f + '.' + l, message:T('لا يمكن ترك هذا الحقل فارغًا','This field cannot be empty') });
        if (s.length > rule.max) errors.push({ field:f + '.' + l, message:T('النص أطول من المسموح (' + rule.max + ' حرف)',
                                                                      'Text is longer than allowed (' + rule.max + ' characters)') });
        if (!rule.multiline && /[\r\n]/.test(s)) errors.push({ field:f + '.' + l, message:T('سطر واحد فقط','Single line only') });
      });
    });
    return { ok:errors.length === 0, errors:errors };
  }
  /* a chosen file's own metadata only — no content is read or stored */
  function mediaMeta(d){
    if (!d || typeof d !== 'object') return null;
    var name = str(d.name); if (!name) return null;
    var size = (typeof d.size === 'number' && isFinite(d.size) && d.size >= 0) ? d.size : null;
    var type = str(d.type).slice(0, 80) || null;
    if (type && !/^image\//.test(type)) return { invalid:true };
    var dot = name.lastIndexOf('.');
    return { name:name.slice(0, 180), type:type, size:size, ext:dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 8) : null,
             storage:'metadata_only', at:Date.now() };
  }

  /* CLOSED — a merchant never writes the live profile directly */
  function update(){ return fail('APPROVAL_REQUIRED'); }

  /* ══════════ REQUESTS ══════════ */
  function coll(name){
    if (!global.RAFRecordStore) return null;
    try { return RAFRecordStore.collection(name); } catch (e) { return null; }
  }
  function reqRows(){ var c = coll('store_profile_requests'); return c ? c.all() : []; }
  function eventRows(id){
    var c = coll('store_profile_request_events'); if (!c) return [];
    return c.all().filter(function (e) { return e.requestId === id; }).sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); });
  }
  function derive(rec, events){
    var r = copy(rec);
    delete r.submissionKey;          /* an idempotency token, not request data */
    r.status = REQ.PENDING; r.decidedAt = null; r.decidedBy = null; r.decidedByName = null;
    r.rejectionReason = null; r.decisionNote = null; r.applied = null; r.history = [];
    events.forEach(function (e) {
      r.history.push({ kind:e.kind, at:e.at, actorId:e.actorId || null, actorName:e.actorName || null, note:e.note || null, reason:e.reason || null });
      if (e.kind === 'approved') { r.status = REQ.APPROVED; r.decidedAt = e.at; r.decidedBy = e.actorId; r.decidedByName = e.actorName; r.decisionNote = e.note || null; r.applied = e.applied || null; }
      if (e.kind === 'rejected') { r.status = REQ.REJECTED; r.decidedAt = e.at; r.decidedBy = e.actorId; r.decidedByName = e.actorName; r.rejectionReason = e.reason || null; }
    });
    r.statusText = REQ_TXT[r.status];
    return r;
  }
  function state(id){
    var rows = reqRows();
    for (var i = 0; i < rows.length; i++) if (rows[i].requestId === id) return derive(rows[i], eventRows(id));
    return null;
  }
  function nextRef(){
    var prefix = 'SP-' + new Date().getFullYear() + '-';
    var n = reqRows().filter(function (r) { return String(r.ref || '').indexOf(prefix) === 0; }).length + 1;
    return prefix + String(n).padStart(5, '0');
  }
  function appendEvent(id, kind, a, extra){
    var c = coll('store_profile_request_events'); if (!c) return { ok:false, reason:'store_unavailable' };
    /* submitted once, and ONE decision per request: its id is fixed, so a
       second approve / reject — any tab — is refused by the store itself */
    var rec = { eventId:'spr|' + id + '|' + (kind === 'submitted' ? 'submitted' : 'decision'), requestId:id, kind:kind,
                at:Date.now(), actorId:(a && a.id) || null, actorName:(a && a.name) || null };
    for (var k in (extra || {})) if (extra.hasOwnProperty(k)) rec[k] = extra[k];
    return c.append('eventId', rec);
  }

  /* MERCHANT — submit ONE change request for its own store.
     changes: { name?:{ar,en}, desc?:{ar,en}, cat?:{ar,en},
                logo?:{name,type,size}, cover?:{name,type,size} }
     opts:    { actor, baseVersion, key } — `key` is the form's one-time
     submission token: a double click or a retry returns the same request. */
  function submitChange(changes, opts){
    opts = opts || {}; changes = changes || {};
    var bad = Object.keys(changes).filter(function (k) { return !FIELDS[k] && !MEDIA[k]; });
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!canEdit(sc.id)) return fail('FORBIDDEN');
    var c = coll('store_profile_requests'); if (!c) return fail('UNAVAILABLE');
    var key = str(opts.key).slice(0, LIMITS.key);
    if (key) {
      var dupe = reqRows().filter(function (r) { return r.submissionKey === key && r.storeSlug === sc.slug; })[0];
      if (dupe) return { ok:true, duplicate:true, request:state(dupe.requestId) };
    }
    var textPatch = {}, media = {};
    Object.keys(changes).forEach(function (k) { if (FIELDS[k]) textPatch[k] = changes[k]; else media[k] = changes[k]; });
    var v = validate(textPatch);
    if (!v.ok) return fail('INVALID', { errors:v.errors });
    if (opts.baseVersion !== undefined && opts.baseVersion !== versionOf(sc.store))
      return fail('STALE', { currentVersion:versionOf(sc.store) });

    /* the field-level change set, each with the value at submission */
    var set = {};
    Object.keys(textPatch).forEach(function (f) {
      var to = { ar:textPatch[f].ar.trim(), en:textPatch[f].en.trim() }, from = pair(sc.store[f]);
      if (!same(to, from)) set[f] = { kind:'text', from:from, to:to };
    });
    var mediaErrors = [];
    Object.keys(media).forEach(function (m) {
      var meta = mediaMeta(media[m]);
      if (!meta) return;
      if (meta.invalid) { mediaErrors.push({ field:m, message:T('يجب أن يكون الملف صورة','The file must be an image') }); return; }
      set[m] = { kind:'media', from:sc.store[m] || null, to:meta };
    });
    if (mediaErrors.length) return fail('INVALID', { errors:mediaErrors });
    if (!Object.keys(set).length) return fail('NO_CHANGES');

    var u = RAFPerm.getUser(sc.id);
    var rec = { requestId:global.RAFRecordStore.makeId('sprof'), ref:nextRef(), storeSlug:sc.slug,
                accountId:sc.id, accountName:(u && u.name) || sc.id, createdAt:Date.now(),
                profileVersionAtRequest:versionOf(sc.store), changes:set, submissionKey:key || null };
    var w = c.append('requestId', rec);
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });
    var a = { id:sc.id, name:rec.accountName };
    appendEvent(rec.requestId, 'submitted', a, {});
    audit('store.profile_change_requested', a, { storeSlug:sc.slug, source:'merchant', key:rec.requestId, newState:REQ.PENDING,
      metadata:{ requestId:rec.requestId, ref:rec.ref, fields:Object.keys(set), accountId:sc.id } });
    return { ok:true, request:state(rec.requestId) };
  }
  /* the merchant's own store: its requests, newest first */
  function myRequests(opts){
    opts = opts || {};
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!canView(sc.id)) return fail('FORBIDDEN');
    var items = reqRows().filter(function (r) { return r.storeSlug === sc.slug; })
      .map(function (r) { return state(r.requestId); }).sort(function (x, y) { return y.createdAt - x.createdAt; });
    return { ok:true, items:items, canSubmit:canEdit(sc.id) };
  }

  /* MANAGEMENT — read and decide (stores.approve) */
  function listRequests(filters){
    filters = filters || {};
    var a = staff(); if (!a.ok) return a;
    var items = reqRows().map(function (r) { return state(r.requestId); })
      .filter(function (x) { return (!filters.status || x.status === filters.status) && (!filters.storeSlug || x.storeSlug === filters.storeSlug); })
      .sort(function (x, y) { return y.createdAt - x.createdAt; });
    return { ok:true, items:items };
  }
  function getRequest(id){
    var a = staff(); if (!a.ok) return a;
    var r = state(id); if (!r) return fail('REQUEST_NOT_FOUND');
    return { ok:true, request:r };
  }
  function approveRequest(id, input){
    input = input || {};
    var a = staff(); if (!a.ok) return a;
    var r = state(id); if (!r) return fail('REQUEST_NOT_FOUND');
    if (r.status !== REQ.PENDING) return fail('REQUEST_DECIDED', { status:r.status });
    var S = global.RAFSource, s = S ? S.store(r.storeSlug) : null;
    if (!s) return fail('STORE_NOT_FOUND');
    /* never applied over a newer value in a field the request covers */
    var textFields = Object.keys(r.changes).filter(function (f) { return r.changes[f].kind === 'text'; });
    var drift = textFields.filter(function (f) { return !same(s[f], r.changes[f].from); });
    if (drift.length) return fail('PROFILE_CHANGED', { fields:drift });
    var note = str(input.note).slice(0, LIMITS.note) || null, now = Date.now();
    /* ONE write: only the requested TEXT fields, plus the profile version.
       Media is metadata only — recorded as approved, never applied. */
    var patch = {}, undo = { profileUpdatedAt:s.profileUpdatedAt || null, profileUpdatedBy:s.profileUpdatedBy || null };
    textFields.forEach(function (f) { patch[f] = r.changes[f].to; undo[f] = s[f] == null ? null : s[f]; });
    var mediaFields = Object.keys(r.changes).filter(function (f) { return r.changes[f].kind === 'media'; });
    if (textFields.length) {
      patch.profileUpdatedAt = now; patch.profileUpdatedBy = a.id; patch.profileRequestId = id;
      if (!S.updateStore(r.storeSlug, patch)) return fail('PERSIST_FAILED');
      var after = S.store(r.storeSlug);
      if (!after || textFields.some(function (f) { return !same(after[f], r.changes[f].to); })) {
        S.updateStore(r.storeSlug, undo);
        return fail('PERSIST_FAILED');
      }
    }
    var d = appendEvent(id, 'approved', a, { note:note, applied:{ fields:textFields, mediaNotApplied:mediaFields } });
    if (!d.ok || d.duplicate) {
      var won = d.duplicate ? state(id) : null;
      if (textFields.length && (!won || won.status !== REQ.APPROVED)) S.updateStore(r.storeSlug, undo);
      return d.duplicate ? fail('REQUEST_DECIDED', { status:won ? won.status : null }) : fail('PERSIST_FAILED', { reason:d.reason });
    }
    audit('store.profile_change_approved', a, { storeSlug:r.storeSlug, source:'admin', key:id, previousState:REQ.PENDING, newState:REQ.APPROVED,
      metadata:{ requestId:id, ref:r.ref, appliedFields:textFields, mediaNotApplied:mediaFields, accountId:a.id, requestedBy:r.accountId, note:note } });
    return { ok:true, request:state(id) };
  }
  function rejectRequest(id, input){
    input = input || {};
    var a = staff(); if (!a.ok) return a;
    var r = state(id); if (!r) return fail('REQUEST_NOT_FOUND');
    if (r.status !== REQ.PENDING) return fail('REQUEST_DECIDED', { status:r.status });
    var reason = str(input.reason);
    if (!reason || reason.length > LIMITS.reason) return fail('REASON_REQUIRED');
    var d = appendEvent(id, 'rejected', a, { reason:reason });
    if (!d.ok) return fail('PERSIST_FAILED', { reason:d.reason });
    if (d.duplicate) return fail('REQUEST_DECIDED', { status:state(id).status });
    /* the store is not touched */
    audit('store.profile_change_rejected', a, { storeSlug:r.storeSlug, source:'admin', key:id, previousState:REQ.PENDING, newState:REQ.REJECTED,
      reason:reason, metadata:{ requestId:id, ref:r.ref, fields:Object.keys(r.changes), accountId:a.id, requestedBy:r.accountId } });
    return { ok:true, request:state(id) };
  }
  function capabilities(){
    var a = sessionActor(); if (!a.ok) return { ok:false, decide:false };
    return { ok:true, decide:can(P.DECIDE, a.id) && !isMerchantAcc(a.id) };
  }

  global.RAFStoreProfile = {
    FIELDS:FIELDS, MEDIA:MEDIA, ERRORS:ERRORS, PERMISSIONS:P, REQUEST_STATUS:REQ, REQUEST_STATUS_TXT:REQ_TXT,
    canView:canView, canEdit:canEdit,
    read:read, validate:validate, update:update,
    submitChange:submitChange, myRequests:myRequests,
    listRequests:listRequests, getRequest:getRequest, approveRequest:approveRequest, rejectRequest:rejectRequest,
    capabilities:capabilities
  };
})(window);
