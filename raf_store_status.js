/* ============================================================================
 * RAF Marketplace — STORE STATUS AUTHORITY  (RAFStoreStatus)
 * ----------------------------------------------------------------------------
 * The ONE place a store's operational status changes. The status itself is
 * still stored where it always was — the store record in RAFSource
 * (`status`: open | closed | suspended). This module is the guarded
 * operation layer in front of RAFSource.updateStore, which is only storage
 * and checks nothing.
 *
 * WHAT IS SEPARATE (and untouched here):
 *   · the weekly schedule           RAFStoreSchedule
 *   · the temporary closure         RAFStoreOps Busy Mode (1 / 2 / 4 / 8 h)
 *     — it pauses NEW orders and never changes `status`
 *   · the merchant account / login  RAFPerm, RAFMerchantAuth
 *
 * OPERATIONS
 *   open      closed → open         RAF Management (stores.manage), or the
 *                                   store's own merchant (see MERCHANT_OPERATE
 *                                   — a TEMPORARY permission dependency)
 *   close     open → closed         RAF Management ONLY (stores.manage). A
 *                                   merchant NEVER closes directly: its only way
 *                                   is requestClosure (days + reason) → approval
 *   suspend   open|closed → suspended           RAF Management only (stores.suspend)
 *   restore   suspended → open | closed, as Management CHOOSES   (stores.suspend)
 *
 *   FULL CLOSURE — requested by the store's merchant (stores.edit, own store):
 *     requestClosure(days, reason)   → RAFRequests type `store_closure`
 *       approve → the store becomes `closed` for an approved PERIOD
 *                 (closure.startsAt = approval, closure.endsAt = + days)
 *       reject  → the store is left exactly as it is
 *     requestExtension(days, reason) → RAFRequests type `store_closure_extension`
 *       only while an approved closure is active; nothing changes until
 *       approved. approve → closure.endsAt moves by the added days;
 *       reject → the approved closure stays exactly as it was
 *     cancelRequest(id) — the merchant withdraws its OWN pending request
 *       (either kind). The request stays in history, marked cancelled.
 *     A SUSPENDED store cannot submit a closure or an extension request.
 *     Deciding either kind needs stores.manage.
 *
 *   AUTOMATIC REOPENING — when an approved closure's period ends, the store is
 *     open again. RAFSource already reads it as open from that instant; the
 *     transition is persisted and audited here, once, by the system (never a
 *     person, never a new request) — sweepExpired(). A SUSPENDED store is never
 *     reopened by this: suspension is Management's, and only a `closed` store
 *     returns to `open`.
 *
 * SAFETY — every change states the status the caller saw (`expect`); if the
 * store moved meanwhile (a second click, another tab) nothing is written.
 * A request has ONE final outcome — approved, rejected or cancelled: that
 * event has a fixed id per request, so a second decision or cancellation (any
 * tab) is refused by the store itself. The automatic reopening is keyed on
 * the closure and its end, so it is recorded once however many tabs run it.
 *
 * STORAGE (RAFRecordStore, append-only):
 *   store_closure_requests        the immutable merchant request (kind:
 *                                 closure | extension)
 *   store_closure_request_events  submitted / approved / rejected / cancelled
 * Every real status change is recorded in RAFAudit (store.*).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFStoreStatus) return;

  var P = { MANAGE:'stores.manage', SUSPEND:'stores.suspend', REQUEST:'stores.edit', VIEW:'stores.view' };
  /* TEMPORARY — pending Store-level RBAC. A merchant's direct open / close is
     checked with the key the existing merchant operational controls already
     use (RAFStoreOps opsGuard). It is NOT the final Store Employee permission
     model: when store-level roles exist, this one constant and merchantMay()
     are what change — nothing else depends on it. */
  var MERCHANT_OPERATE = 'orders.manage';
  var REQ = { PENDING:'pending', APPROVED:'approved', REJECTED:'rejected', CANCELLED:'cancelled' };
  var REQ_TXT = {
    pending:   { ar:'قيد المراجعة', en:'Pending review' },
    approved:  { ar:'مقبول',        en:'Approved' },
    rejected:  { ar:'مرفوض',        en:'Rejected' },
    cancelled: { ar:'ملغى',         en:'Cancelled' }
  };
  var KIND = { CLOSURE:'closure', EXTENSION:'extension' };
  var DAY_MS = 86400000;
  var LIMITS = { reason:300, note:600, key:80 };

  function isEn(){ var r = (global.document && (document.getElementById('htmlRoot') || document.documentElement)); return !!(r && r.lang === 'en'); }
  function T(ar, en){ return isEn() ? en : ar; }
  function text(v){ return v == null ? '' : String(v).trim(); }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function SRC(){ return global.RAFSource || null; }
  function ST(){ var S = SRC(); return S ? S.STORE_STATUS : { OPEN:'open', CLOSED:'closed', SUSPENDED:'suspended', DELETED:'deleted' }; }

  var ERRORS = {
    UNAVAILABLE:       { ar:'تعذّر الوصول إلى سجل المتاجر.',                    en:'The store record is unavailable.' },
    UNAUTHENTICATED:   { ar:'يلزم تسجيل الدخول.',                               en:'Sign-in is required.' },
    ACTOR_INACTIVE:    { ar:'لا يمكن تنفيذ الإجراء بحساب غير نشط.',              en:'An inactive account cannot perform this action.' },
    FORBIDDEN:         { ar:'لا تملك صلاحية تنفيذ هذا الإجراء.',                 en:'You do not have permission for this action.' },
    CROSS_STORE:       { ar:'هذا المتجر لا يخصك.',                               en:'This store does not belong to you.' },
    STORE_NOT_FOUND:   { ar:'المتجر غير موجود.',                                 en:'The store could not be found.' },
    STATE_CHANGED:     { ar:'تغيّرت حالة المتجر للتو. حدّث الصفحة لرؤية الحالة الحالية.', en:'The store status has just changed. Refresh to see the current status.' },
    NOT_ALLOWED:       { ar:'هذا الإجراء غير متاح في حالة المتجر الحالية.',      en:'This action is not available in the store’s current status.' },
    MERCHANT_CLOSE_BY_REQUEST: { ar:'لا يمكن للتاجر إغلاق المتجر مباشرة. استخدم «إغلاق المتجر الآن» وأدخل عدد الأيام والسبب لإرسال طلب إغلاق إلى إدارة رف.', en:'A merchant cannot close the store directly. Use “Close store now” and enter the number of days and a reason to send a closure request to RAF Management.' },
    TARGET_REQUIRED:   { ar:'اختر الحالة التي يعود إليها المتجر (مفتوح أو مغلق).', en:'Choose the status the store returns to (open or closed).' },
    PERSIST_FAILED:    { ar:'تعذّر حفظ التغيير.',                                en:'The change could not be saved.' },
    FIELD_NOT_ACCEPTED:{ ar:'حقل غير مقبول.',                                   en:'A field is not accepted.' },
    DAYS_REQUIRED:     { ar:'عدد الأيام مطلوب (رقم صحيح أكبر من صفر).',          en:'The number of days is required (a whole number above zero).' },
    REASON_REQUIRED:   { ar:'السبب مطلوب.',                                     en:'A reason is required.' },
    REQUEST_NOT_FOUND: { ar:'الطلب غير موجود.',                                  en:'The request could not be found.' },
    REQUEST_DECIDED:   { ar:'هذا الطلب لم يعد قيد المراجعة (تم البت فيه أو إلغاؤه).', en:'This request is no longer pending (it was decided or cancelled).' },
    STORE_SUSPENDED_NO_REQUEST: { ar:'المتجر موقوف إدارياً؛ لا يمكن تقديم طلب إغلاق أو تمديد.', en:'The store is administratively suspended; a closure or extension request cannot be submitted.' },
    NO_ACTIVE_CLOSURE: { ar:'لا يوجد إغلاق معتمد نشط لتمديده.',                  en:'There is no active approved closure to extend.' },
    CLOSURE_CHANGED:   { ar:'الإغلاق المعتمد الذي طُلب تمديده لم يعد نشطاً؛ لا يمكن تطبيق التمديد.', en:'The approved closure this extension refers to is no longer active; the extension cannot be applied.' },
    EXTENSION_SUSPENDED:{ ar:'المتجر موقوف إدارياً؛ لا يُطبَّق التمديد على متجر موقوف.', en:'The store is administratively suspended; an extension is not applied to a suspended store.' },
    /* IMPLEMENTATION LIMITATION, not a business rule: a store has ONE status,
       and no rule says what approving a FULL CLOSURE (submitted before the
       store was suspended) does to a suspended store. It is not applied. */
    STORE_SUSPENDED:   { ar:'لا يمكن تطبيق هذا الإغلاق على متجر موقوف في التنفيذ الحالي: للمتجر حالة واحدة، ولم تُحدَّد بعد قاعدة لهذه الحالة.',
                         en:'This closure cannot be applied to a suspended store in the current implementation: a store has one status, and no rule is defined yet for this case.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function badKeys(o, allowed){ return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; }); }

  /* ---------- actor: this tab's signed-in session only ---------- */
  function actor(){
    var R = global.RAFPerm; if (!R) return fail('UNAVAILABLE');
    var id = null; try { id = R.sessionUserId ? R.sessionUserId() : null; } catch (e) { id = null; }
    var u = null; if (id) { try { u = R.getUser(id); } catch (e) { u = null; } }
    if (!u) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    return { ok:true, id:u.id, name:u.name || u.id };
  }
  function can(id, key){ try { return !!(global.RAFPerm && RAFPerm.can(id, key)); } catch (e) { return false; } }
  function isMerchantAcc(id){ try { return !!(global.RAFPerm && RAFPerm.isMerchant(id)); } catch (e) { return false; } }
  function storeSlugOfActor(id){ try { return (global.RAFPerm && RAFPerm.storeSlugOf(id)) || null; } catch (e) { return null; } }
  /* a Management operation: the key, held by an account that is NOT
     store-scoped (a merchant account never runs another store) */
  function staff(key){
    var a = actor(); if (!a.ok) return a;
    if (!can(a.id, key) || isMerchantAcc(a.id)) return fail('FORBIDDEN', { required:key });
    return a;
  }
  /* a merchant operation on its OWN store, resolved by RAFPerm by id */
  function merchant(key){
    var a = actor(); if (!a.ok) return a;
    if (!can(a.id, key)) return fail('FORBIDDEN', { required:key });
    var slug = storeSlugOfActor(a.id);
    if (!slug) return fail('CROSS_STORE');
    a.slug = slug; return a;
  }
  /* TEMPORARY (pending Store-level RBAC) — see MERCHANT_OPERATE */
  function merchantMay(id){ return can(id, MERCHANT_OPERATE); }
  function audit(action, a, extra){
    if (!global.RAFAudit || !RAFAudit.record) return null;
    try { return RAFAudit.record(Object.assign({ action:action, actor:a ? { id:a.id } : undefined }, extra || {})); }
    catch (e) { return null; }
  }

  /* ---------- the store's status, as the store record holds it ---------- */
  function storeOf(slug){
    var S = SRC(); if (!S || !slug) return null;
    var s = null; try { s = S.store(slug); } catch (e) { s = null; }
    return s && s.status !== ST().DELETED ? s : null;
  }
  /* read-only view of a store's operational status and what is recorded
     about it. Anything not recorded is null — never guessed. */
  function statusOf(slug){
    var s = storeOf(slug); if (!s) return null;
    return { slug:s.slug, status:s.status || null,
             closure:copy(s.closure || null), suspension:copy(s.suspension || null),
             lastChange:copy(s.statusChange || null), lastClosure:copy(s.lastClosure || null) };
  }
  function write(slug, from, to, a, op, extra){
    var S = SRC(); if (!S) return fail('UNAVAILABLE');
    var cur = storeOf(slug); if (!cur) return fail('STORE_NOT_FOUND');
    if (cur.status !== from) return fail('STATE_CHANGED', { status:cur.status });    /* re-read right before writing */
    var now = Date.now();
    var patch = Object.assign({ status:to,
      statusChange:{ op:op, from:from, to:to, at:now, by:a.id, byName:a.name, requestId:(extra && extra.requestId) || null } },
      (extra && extra.patch) || {});
    if (!S.updateStore(slug, patch)) return fail('PERSIST_FAILED');
    var after = storeOf(slug);
    if (!after || after.status !== to) return fail('PERSIST_FAILED');
    return { ok:true, at:now };
  }

  /* ══════════ AUTOMATIC REOPENING ══════════
     RAFSource reads a closed store whose approved period has ended as open
     (exposing the ended closure as `closureEnded`). This persists that and
     records it — the actor is the system. Idempotent: the store is re-read
     right before writing, and the audit key is the closure and its end, so a
     second run (another tab, a later sweep) records nothing new. */
  function sweepStore(slug){
    var s = storeOf(slug);
    if (!s || !s.closureEnded) return { ok:true, changed:false };
    var cl = s.closureEnded, S = SRC();
    var patch = { status:ST().OPEN, closure:null,
                  lastClosure:Object.assign({}, cl, { endedAt:cl.endsAt, ended:'period_elapsed' }),
                  statusChange:{ op:'closure_expired', from:ST().CLOSED, to:ST().OPEN, at:cl.endsAt, by:null, byName:null,
                                 automatic:true, requestId:cl.requestId || null } };
    if (!S || !S.updateStore(slug, patch)) return { ok:false, changed:false };
    audit('store.closure_expired', null, { storeSlug:slug, source:'automation', automatic:true, systemGenerated:true,
      key:(cl.requestId || slug) + ':' + cl.endsAt, timestamp:cl.endsAt, previousState:ST().CLOSED, newState:ST().OPEN,
      reason:'closure_period_ended',
      metadata:{ requestId:cl.requestId || null, ref:cl.ref || null, startsAt:cl.startsAt || null, endsAt:cl.endsAt, processedAt:Date.now() } });
    return { ok:true, changed:true };
  }
  function sweepExpired(){
    var S = SRC(); if (!S) return 0;
    var n = 0, list = [];
    try { list = S.allStores() || []; } catch (e) { list = []; }
    list.forEach(function (s) { if (s && s.closureEnded) { var r = sweepStore(s.slug); if (r.changed) n++; } });
    return n;
  }

  /* ══════════ OPEN / CLOSE / SUSPEND / RESTORE ══════════
     input: { expect } — the status the caller is acting on (restore also
     takes `to`). Who may act:
       open              RAF Management (stores.manage), or the store's own
                         merchant (TEMPORARY check — see MERCHANT_OPERATE)
       close             RAF Management only (stores.manage). A merchant is
                         refused here whatever its permissions: a full closure
                         is always a request (days + reason) that Management
                         approves — requestClosure
       suspend / restore RAF Management only (stores.suspend)
     A suspended store is changed only by suspend / restore: suspension is
     Management-only, so a merchant open / close never lifts it. */
  function operator(slug, key, op){
    var a = actor(); if (!a.ok) return a;
    if (isMerchantAcc(a.id)) {
      if (key !== P.MANAGE) return fail('FORBIDDEN', { required:key });
      /* the ONLY direct change a merchant may make is opening its store */
      if (op !== 'open') return fail('MERCHANT_CLOSE_BY_REQUEST');
      if (!merchantMay(a.id)) return fail('FORBIDDEN', { required:MERCHANT_OPERATE, temporary:true });
      var mine = storeSlugOfActor(a.id);
      if (!mine || mine !== slug) return fail('CROSS_STORE');
      a.source = 'merchant'; return a;
    }
    if (!can(a.id, key)) return fail('FORBIDDEN', { required:key });
    a.source = 'admin'; return a;
  }
  function change(slug, input, spec){
    input = input || {};
    var bad = badKeys(input, ['expect'].concat(spec.extra || [])); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = operator(slug, spec.key, spec.op); if (!a.ok) return a;
    sweepStore(slug);                     /* an ended closure is recorded first */
    var s = storeOf(slug); if (!s) return fail('STORE_NOT_FOUND');
    if (input.expect && input.expect !== s.status) return fail('STATE_CHANGED', { status:s.status });
    if (spec.from.indexOf(s.status) < 0) return fail('NOT_ALLOWED', { status:s.status });
    var to = spec.to(s, input); if (!to) return fail('TARGET_REQUIRED');
    var w = write(slug, s.status, to, a, spec.op, { patch:spec.patch ? spec.patch(s, a, to) : null });
    if (!w.ok) return w;
    audit(spec.action, a, { storeSlug:slug, source:a.source, key:slug + ':' + spec.op + ':' + w.at,
      previousState:s.status, newState:to, metadata:{ operation:spec.op, accountId:a.id } });
    return { ok:true, slug:slug, from:s.status, to:to, status:statusOf(slug) };
  }
  function endedEarly(s, how){
    return s.closure ? { lastClosure:Object.assign({}, s.closure, { endedAt:Date.now(), ended:how }) } : {};
  }
  function open(slug, input){
    return change(slug, input, { key:P.MANAGE, op:'open', action:'store.opened', from:[ST().CLOSED],
      to:function(){ return ST().OPEN; },
      /* opened before an approved period ended: that closure ends now */
      patch:function(s){ return Object.assign({ closure:null }, endedEarly(s, 'opened')); } });
  }
  function close(slug, input){
    return change(slug, input, { key:P.MANAGE, op:'close', action:'store.closed', from:[ST().OPEN],
      to:function(){ return ST().CLOSED; },
      /* a direct close has no period — it is not a request-based closure */
      patch:function(){ return { closure:null }; } });
  }
  function suspend(slug, input){
    return change(slug, input, { key:P.SUSPEND, op:'suspend', action:'store.suspended', from:[ST().OPEN, ST().CLOSED],
      to:function(){ return ST().SUSPENDED; },
      /* the status it was suspended from is kept for information only; an
         approved closure stays recorded, and nothing reopens a suspended store */
      patch:function(s, a){ return { suspension:{ at:Date.now(), by:a.id, byName:a.name, previousStatus:s.status } }; } });
  }
  /* restore: Management CHOOSES the status the store returns to (`to`:
     open | closed). A closure period that ended during the suspension is
     finished, so it is not left to reopen the store Management chose to
     close; one still running continues. */
  function restore(slug, input){
    return change(slug, input, { key:P.SUSPEND, op:'restore', action:'store.restored', from:[ST().SUSPENDED], extra:['to'],
      to:function(s, inp){ var t = inp && inp.to; return (t === ST().OPEN || t === ST().CLOSED) ? t : null; },
      patch:function(s, a, to){
        var p = { suspension:null }, cl = s.closure;
        if (cl && (to === ST().OPEN || (typeof cl.endsAt === 'number' && Date.now() >= cl.endsAt))) {
          p.closure = null;
          p.lastClosure = Object.assign({}, cl, { endedAt:Date.now(), ended:to === ST().OPEN ? 'restored_open' : 'period_elapsed_while_suspended' });
        }
        return p;
      } });
  }

  /* ══════════ CLOSURE & EXTENSION REQUESTS ══════════ */
  function coll(name){
    if (!global.RAFRecordStore) return null;
    try { return RAFRecordStore.collection(name); } catch (e) { return null; }
  }
  function reqRows(){ var c = coll('store_closure_requests'); return c ? c.all() : []; }
  function kindOf(r){ return r && r.kind === KIND.EXTENSION ? KIND.EXTENSION : KIND.CLOSURE; }
  function eventRows(id){
    var c = coll('store_closure_request_events'); if (!c) return [];
    return c.all().filter(function (e) { return e.requestId === id; }).sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); });
  }
  function derive(rec, events){
    var r = copy(rec);
    delete r.submissionKey;          /* an idempotency token, not request data */
    r.kind = kindOf(rec);
    r.status = REQ.PENDING; r.decidedAt = null; r.decidedBy = null; r.decidedByName = null;
    r.rejectionReason = null; r.decisionNote = null; r.appliedAt = null; r.history = [];
    events.forEach(function (e) {
      r.history.push({ kind:e.kind, at:e.at, actorId:e.actorId || null, actorName:e.actorName || null, note:e.note || null, reason:e.reason || null });
      if (e.kind === 'approved')  { r.status = REQ.APPROVED;  r.decidedAt = e.at; r.decidedBy = e.actorId; r.decidedByName = e.actorName; r.decisionNote = e.note || null; r.appliedAt = e.appliedAt || null; }
      if (e.kind === 'rejected')  { r.status = REQ.REJECTED;  r.decidedAt = e.at; r.decidedBy = e.actorId; r.decidedByName = e.actorName; r.rejectionReason = e.reason || null; }
      if (e.kind === 'cancelled') { r.status = REQ.CANCELLED; r.decidedAt = e.at; r.decidedBy = e.actorId; r.decidedByName = e.actorName; }
    });
    r.statusText = REQ_TXT[r.status];
    return r;
  }
  function state(id){
    var rows = reqRows();
    for (var i = 0; i < rows.length; i++) if (rows[i].requestId === id) return derive(rows[i], eventRows(id));
    return null;
  }
  function nextRef(kind){
    var prefix = (kind === KIND.EXTENSION ? 'SX-' : 'SC-') + new Date().getFullYear() + '-';
    var n = reqRows().filter(function (r) { return String(r.ref || '').indexOf(prefix) === 0; }).length + 1;
    return prefix + String(n).padStart(5, '0');
  }
  function appendEvent(id, kind, a, extra){
    var c = coll('store_closure_request_events'); if (!c) return { ok:false, reason:'store_unavailable' };
    /* submitted once, and ONE final outcome per request (approved, rejected
       or cancelled): its id is fixed, so a second one — any tab — is refused */
    var eventId = 'scr|' + id + '|' + (kind === 'submitted' ? 'submitted' : 'decision');
    var rec = { eventId:eventId, requestId:id, kind:kind, at:Date.now(), actorId:(a && a.id) || null, actorName:(a && a.name) || null };
    for (var k in (extra || {})) if (extra.hasOwnProperty(k)) rec[k] = extra[k];
    return c.append('eventId', rec);
  }
  function daysOf(v){
    var d = typeof v === 'number' ? v : (text(v) === '' ? NaN : Number(v));
    return (isFinite(d) && d >= 1 && Math.floor(d) === d && Number.isSafeInteger(d)) ? d : null;
  }
  var ACT = {
    closure:   { requested:'store.closure_requested',   approved:'store.closure_approved',   rejected:'store.closure_rejected',   cancelled:'store.closure_cancelled' },
    extension: { requested:'store.extension_requested', approved:'store.extension_approved', rejected:'store.extension_rejected', cancelled:'store.extension_cancelled' }
  };

  /* MERCHANT — a new request for its own store (either kind).
     input: { days, reason, key } — `key` is the form's one-time submission
     token: a double click, a refresh or a retry returns the same request. */
  function submit(kind, input){
    input = input || {};
    var bad = badKeys(input, ['days', 'reason', 'key']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = merchant(P.REQUEST); if (!a.ok) return a;
    var c = coll('store_closure_requests'); if (!c) return fail('UNAVAILABLE');
    var key = text(input.key).slice(0, LIMITS.key);
    if (key) {
      var same = reqRows().filter(function (r) { return r.submissionKey === key && r.storeSlug === a.slug && kindOf(r) === kind; })[0];
      if (same) return { ok:true, duplicate:true, request:state(same.requestId) };
    }
    var days = daysOf(input.days); if (!days) return fail('DAYS_REQUIRED');
    var reason = text(input.reason);
    if (!reason) return fail('REASON_REQUIRED');
    if (reason.length > LIMITS.reason) return fail('REASON_REQUIRED', { max:LIMITS.reason });
    sweepStore(a.slug);
    var s = storeOf(a.slug); if (!s) return fail('STORE_NOT_FOUND');
    if (s.status === ST().SUSPENDED) return fail('STORE_SUSPENDED_NO_REQUEST');
    var rec = { requestId:global.RAFRecordStore.makeId(kind === KIND.EXTENSION ? 'sext' : 'sclose'), kind:kind, ref:nextRef(kind),
                storeSlug:a.slug, accountId:a.id, accountName:a.name, days:days, reason:reason, createdAt:Date.now(),
                submissionKey:key || null, storeStatusAtRequest:s.status };
    if (kind === KIND.EXTENSION) {
      /* only an approved closure that is still running can be extended */
      if (s.status !== ST().CLOSED || !s.closure || typeof s.closure.endsAt !== 'number') return fail('NO_ACTIVE_CLOSURE');
      rec.closureRequestId = s.closure.requestId; rec.closureRef = s.closure.ref || null; rec.endsAtAtRequest = s.closure.endsAt;
    }
    var w = c.append('requestId', rec);
    if (!w.ok) return fail('PERSIST_FAILED', { reason:w.reason });
    appendEvent(rec.requestId, 'submitted', a, {});
    audit(ACT[kind].requested, a, { storeSlug:a.slug, source:'merchant', key:rec.requestId, newState:REQ.PENDING, reason:reason,
      metadata:{ requestId:rec.requestId, ref:rec.ref, days:days, accountId:a.id, closureRequestId:rec.closureRequestId || null } });
    return { ok:true, request:state(rec.requestId) };
  }
  function requestClosure(input){ return submit(KIND.CLOSURE, input); }
  function requestExtension(input){ return submit(KIND.EXTENSION, input); }

  /* MERCHANT — withdraw its own PENDING request. The request stays in
     history, marked cancelled; the store is not touched. */
  function cancelRequest(id, input){
    input = input || {};
    var bad = badKeys(input, []); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = merchant(P.REQUEST); if (!a.ok) return a;
    var r = state(id); if (!r) return fail('REQUEST_NOT_FOUND');
    if (r.storeSlug !== a.slug) return fail('CROSS_STORE');
    if (r.status !== REQ.PENDING) return fail('REQUEST_DECIDED', { status:r.status });
    var d = appendEvent(id, 'cancelled', a, {});
    if (!d.ok) return fail('PERSIST_FAILED', { reason:d.reason });
    if (d.duplicate) return fail('REQUEST_DECIDED', { status:state(id).status });
    audit(ACT[r.kind].cancelled, a, { storeSlug:r.storeSlug, source:'merchant', key:id, previousState:REQ.PENDING, newState:REQ.CANCELLED,
      metadata:{ requestId:id, ref:r.ref, days:r.days, accountId:a.id } });
    return { ok:true, request:state(id) };
  }

  /* the merchant's own store: every request, newest first */
  function myRequests(){
    var a = merchant(P.VIEW); if (!a.ok) return a;
    sweepStore(a.slug);
    var items = reqRows().filter(function (r) { return r.storeSlug === a.slug; })
      .map(function (r) { return state(r.requestId); }).sort(function (x, y) { return y.createdAt - x.createdAt; });
    var s = storeOf(a.slug);
    return { ok:true, slug:a.slug, items:items, canRequest:can(a.id, P.REQUEST),
             suspended:!!(s && s.status === ST().SUSPENDED),
             activeClosure:s && s.status === ST().CLOSED && s.closure && typeof s.closure.endsAt === 'number' ? copy(s.closure) : null };
  }

  /* MANAGEMENT — read and decide (stores.manage) */
  function listRequests(filters){
    filters = filters || {};
    var bad = badKeys(filters, ['status', 'storeSlug', 'kind']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.MANAGE); if (!a.ok) return a;
    var items = reqRows().map(function (r) { return state(r.requestId); })
      .filter(function (x) { return (!filters.status || x.status === filters.status) && (!filters.storeSlug || x.storeSlug === filters.storeSlug)
                                  && (!filters.kind || x.kind === filters.kind); })
      .sort(function (x, y) { return y.createdAt - x.createdAt; });
    return { ok:true, items:items };
  }
  function getRequest(id){
    var a = staff(P.MANAGE); if (!a.ok) return a;
    var s = state(id); if (!s) return fail('REQUEST_NOT_FOUND');
    return { ok:true, request:s };
  }
  /* the store change is applied BEFORE the decision is recorded, so a request
     never reads "approved" without its effect in place; if another tab
     decided or cancelled first, the store goes back as it was */
  function applyThenDecide(r, a, patch, undo, note, now){
    var S = SRC();
    if (!S || !S.updateStore(r.storeSlug, patch)) return fail('PERSIST_FAILED');
    var d = appendEvent(r.requestId, 'approved', a, { note:note, appliedAt:now });
    if (!d.ok || d.duplicate) {
      var won = d.duplicate ? state(r.requestId) : null;
      if (!won || won.status !== REQ.APPROVED) S.updateStore(r.storeSlug, undo);
      return d.duplicate ? fail('REQUEST_DECIDED', { status:won ? won.status : null }) : fail('PERSIST_FAILED', { reason:d.reason });
    }
    return { ok:true };
  }
  function approveRequest(id, input){
    input = input || {};
    var bad = badKeys(input, ['note']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.MANAGE); if (!a.ok) return a;
    var r = state(id); if (!r) return fail('REQUEST_NOT_FOUND');
    if (r.status !== REQ.PENDING) return fail('REQUEST_DECIDED', { status:r.status });
    sweepStore(r.storeSlug);
    var s = storeOf(r.storeSlug); if (!s) return fail('STORE_NOT_FOUND');
    var note = text(input.note).slice(0, LIMITS.note) || null, now = Date.now();
    var undo = { status:s.status, closure:s.closure || null, statusChange:s.statusChange || null };

    if (r.kind === KIND.EXTENSION) {
      if (s.status === ST().SUSPENDED) return fail('EXTENSION_SUSPENDED');
      var cl = s.closure;
      if (s.status !== ST().CLOSED || !cl || cl.requestId !== r.closureRequestId || typeof cl.endsAt !== 'number') return fail('CLOSURE_CHANGED');
      var next = Object.assign({}, cl, {
        endsAt:cl.endsAt + r.days * DAY_MS,
        totalDays:(cl.totalDays || cl.days || 0) + r.days,
        extensions:(cl.extensions || []).concat([{ requestId:id, ref:r.ref, days:r.days, reason:r.reason,
          previousEndsAt:cl.endsAt, approvedAt:now, approvedBy:a.id, approvedByName:a.name }])
      });
      var e = applyThenDecide(r, a, { closure:next }, undo, note, now); if (!e.ok) return e;
      audit(ACT.extension.approved, a, { storeSlug:r.storeSlug, source:'admin', key:id, previousState:String(cl.endsAt), newState:String(next.endsAt),
        reason:r.reason, metadata:{ requestId:id, ref:r.ref, days:r.days, closureRequestId:cl.requestId, previousEndsAt:cl.endsAt, endsAt:next.endsAt,
          accountId:a.id, requestedBy:r.accountId, note:note } });
      return { ok:true, request:state(id), status:statusOf(r.storeSlug) };
    }

    if (s.status === ST().SUSPENDED) return fail('STORE_SUSPENDED');
    var closure = { requestId:id, ref:r.ref, days:r.days, totalDays:r.days, reason:r.reason,
                    startsAt:now, endsAt:now + r.days * DAY_MS, extensions:[],
                    requestedBy:r.accountId, requestedByName:r.accountName, requestedAt:r.createdAt,
                    approvedAt:now, approvedBy:a.id, approvedByName:a.name };
    var patch = { status:ST().CLOSED, closure:closure,
                  statusChange:{ op:'closure_approved', from:s.status, to:ST().CLOSED, at:now, by:a.id, byName:a.name, requestId:id } };
    if (s.closure) patch.lastClosure = Object.assign({}, s.closure, { endedAt:now, ended:'replaced' });
    var c = applyThenDecide(r, a, patch, undo, note, now); if (!c.ok) return c;
    audit(ACT.closure.approved, a, { storeSlug:r.storeSlug, source:'admin', key:id, previousState:s.status, newState:ST().CLOSED,
      reason:r.reason, metadata:{ requestId:id, ref:r.ref, days:r.days, startsAt:closure.startsAt, endsAt:closure.endsAt,
        accountId:a.id, requestedBy:r.accountId, note:note } });
    return { ok:true, request:state(id), status:statusOf(r.storeSlug) };
  }
  function rejectRequest(id, input){
    input = input || {};
    var bad = badKeys(input, ['reason']); if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    var a = staff(P.MANAGE); if (!a.ok) return a;
    var r = state(id); if (!r) return fail('REQUEST_NOT_FOUND');
    if (r.status !== REQ.PENDING) return fail('REQUEST_DECIDED', { status:r.status });
    var reason = text(input.reason);
    if (!reason || reason.length > LIMITS.reason) return fail('REASON_REQUIRED');
    var d = appendEvent(id, 'rejected', a, { reason:reason });
    if (!d.ok) return fail('PERSIST_FAILED', { reason:d.reason });
    if (d.duplicate) return fail('REQUEST_DECIDED', { status:state(id).status });
    /* the store — and any approved closure — is not touched */
    audit(ACT[r.kind].rejected, a, { storeSlug:r.storeSlug, source:'admin', key:id, previousState:REQ.PENDING, newState:REQ.REJECTED,
      reason:reason, metadata:{ requestId:id, ref:r.ref, days:r.days, accountId:a.id, requestedBy:r.accountId } });
    return { ok:true, request:state(id) };
  }

  /* what this account may do — a page asks, it never guesses; every
     operation above re-proves its own permission */
  function capabilities(){
    var a = actor(); if (!a.ok) return { ok:false, code:a.code, manage:false, suspend:false, request:false, operate:false };
    var m = isMerchantAcc(a.id), mine = m ? storeSlugOfActor(a.id) : null;
    return { ok:true, manage:!m && can(a.id, P.MANAGE), suspend:!m && can(a.id, P.SUSPEND),
             request:m && !!mine && can(a.id, P.REQUEST),
             /* merchant OPENING its own store — TEMPORARY check (closing is by request only) */
             operate:m && !!mine && merchantMay(a.id), store:mine };
  }

  /* the automatic reopening runs wherever this authority is loaded: once on
     load and then on a timer. It writes only when a period has ended. */
  if (global.document) {
    var tick = function () { try { sweepExpired(); } catch (e) {} };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick); else tick();
    setInterval(tick, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  }

  global.RAFStoreStatus = {
    PERMISSIONS:P, MERCHANT_OPERATE_TEMPORARY:MERCHANT_OPERATE, REQUEST_STATUS:REQ, REQUEST_STATUS_TXT:REQ_TXT, KIND:KIND, DAY_MS:DAY_MS, ERRORS:ERRORS,
    statusOf:statusOf, capabilities:capabilities,
    open:open, close:close, suspend:suspend, restore:restore,
    requestClosure:requestClosure, requestExtension:requestExtension, cancelRequest:cancelRequest, myRequests:myRequests,
    listRequests:listRequests, getRequest:getRequest, approveRequest:approveRequest, rejectRequest:rejectRequest,
    sweepExpired:sweepExpired
  };
})(window);
