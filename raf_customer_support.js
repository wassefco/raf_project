/* ============================================================================
 * RAF Marketplace — MERCHANT SUPPORT AUTHORITY  (shared, headless)
 * ----------------------------------------------------------------------------
 * RAFCustomerSupport owns the Support channel:
 *
 *     Merchant / Merchant Employee  ↔  RAF Management
 *
 * It is NOT customer support. Customer → Store communication belongs to
 * RAFCustomerExperience (Customer Issues) and is never mixed in here.
 *
 * STORE OWNERSHIP — always RAFPerm.storeSlugOf(actorId). A storeSlug, store
 * object, creator or actor type supplied by a caller is refused. A related
 * order is accepted only when its immutable snapshot belongs to the same
 * store (RAFOrderSnapshot.storeSlugOf).
 *
 * ACCESS — the existing RAFPerm.isMerchant() (merchant or merchant employee)
 * plus a store link. No new permission key. Customers, drivers, unknown and
 * unassigned accounts are refused.
 *
 * HISTORY — ticket id and createdAt never change; messages and attachment
 * metadata are append-only; a resolved ticket reopened keeps its resolvedAt.
 * There is no delete and no edit of a message.
 *
 * ATTACHMENTS — this prototype has no file-storage service. Only the
 * attachment's metadata (name, type, size, extension) is recorded, marked
 * storage:'metadata_only'. File content is never read, stored or executed,
 * and no path from the user's machine is kept. No size or count limit is
 * applied because RAF defines none.
 *
 * RAF SIDE — the model accepts messages from actorType 'raf', but no RAF
 * Support actor or backend exists yet, so nothing here creates one.
 *
 * Text limits are technical guards against runaway input, not business rules.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFCustomerSupport) return;

  var LS = 'raf_customer_support';
  var LIMITS = { subject:150, message:4000, fileName:255 };

  var CATEGORIES = [
    { key:'order_issue',        ar:'مشكلة في طلب',       en:'Order issue' },
    { key:'payment_settlement', ar:'الدفع / التسويات',   en:'Payment / Settlement' },
    { key:'store_issue',        ar:'مشكلة في المتجر',    en:'Store issue' },
    { key:'technical_issue',    ar:'مشكلة تقنية',        en:'Technical issue' },
    { key:'general_inquiry',    ar:'استفسار عام',        en:'General inquiry' }
  ];
  var STATUS = { OPEN:'open', IN_PROGRESS:'in_progress', WAITING_MERCHANT:'waiting_merchant', RESOLVED:'resolved' };
  var STATUS_TXT = {
    open:             { ar:'مفتوحة',          en:'Open' },
    in_progress:      { ar:'قيد المعالجة',     en:'In Progress' },
    waiting_merchant: { ar:'بانتظار التاجر',   en:'Waiting for Merchant' },
    resolved:         { ar:'تم الحل',          en:'Resolved' }
  };
  /* the approved workflow. Resolved → Open happens only through reopenTicket. */
  var TRANSITIONS = {
    open:             ['in_progress'],
    in_progress:      ['waiting_merchant', 'resolved'],
    waiting_merchant: ['in_progress', 'resolved'],
    resolved:         []
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'لا تملك صلاحية الوصول إلى الدعم.',                en:'You do not have access to Support.' },
    NO_STORE:           { ar:'لا يوجد متجر مرتبط بهذا الحساب.',                 en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:    { ar:'المتجر المرتبط غير موجود.',                       en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',             en:'The request contains fields that are not accepted.' },
    INVALID:            { ar:'راجع الحقول المطلوبة.',                           en:'Check the required fields.' },
    INVALID_ORDER:      { ar:'الطلب المرتبط غير موجود.',                        en:'The related order could not be found.' },
    CROSS_STORE:        { ar:'هذا العنصر لا يخص متجرك.',                        en:'This does not belong to your store.' },
    NOT_FOUND:          { ar:'التذكرة غير موجودة.',                             en:'The ticket could not be found.' },
    STALE:              { ar:'تم تحديث التذكرة من جلسة أخرى. أعد التحميل ثم حاول مجدداً.',
                          en:'This ticket was updated in another session. Reload and try again.' },
    INVALID_TRANSITION: { ar:'لا يمكن نقل التذكرة إلى هذه الحالة.',              en:'The ticket cannot move to that status.' },
    TICKET_RESOLVED:    { ar:'تم حل هذه التذكرة. أعد فتحها لإضافة رسالة.',      en:'This ticket is resolved. Reopen it to add a message.' },
    NOT_RESOLVED:       { ar:'لا يمكن إعادة فتح تذكرة لم تُحل.',                en:'Only a resolved ticket can be reopened.' },
    INVALID_ATTACHMENT: { ar:'أحد المرفقات غير صالح.',                          en:'One of the attachments is not valid.' },
    PERSIST_FAILED:     { ar:'تعذّر الحفظ.',                                    en:'Could not save.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function copy(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
  function newId(prefix){
    return prefix + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  }
  function text(v){ return typeof v === 'string' ? v.trim() : ''; }
  function badKeys(o, allowed){ return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; }); }

  /* ---------- storage: one namespaced key, only this module writes it ---------- */
  function readAll(){
    try { var v = JSON.parse(localStorage.getItem(LS) || 'null');
          if (v && Array.isArray(v.tickets)) return v; } catch (e) {}
    return { tickets:[] };
  }
  function writeAll(db){
    try { localStorage.setItem(LS, JSON.stringify(db)); } catch (e) { return false; }
    try { document.dispatchEvent(new CustomEvent('raf:support')); } catch (e2) {}
    return true;
  }

  /* ---------- scope: the acting account's own store, by id ---------- */
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  function scope(actor){
    var id = actorId(actor);
    if (!id || !global.RAFPerm) return fail('FORBIDDEN');
    var u = null; try { u = RAFPerm.getUser(id); } catch (e) { u = null; }
    if (!u) return fail('FORBIDDEN');
    var merchant = false; try { merchant = !!RAFPerm.isMerchant(id); } catch (e) { merchant = false; }
    if (!merchant) return fail('FORBIDDEN');
    var slug = null; try { slug = RAFPerm.storeSlugOf(id) || null; } catch (e) { slug = null; }
    if (!slug) return fail('NO_STORE');
    if (global.RAFSource && !RAFSource.store(slug)) return fail('STORE_NOT_FOUND');
    return { ok:true, id:id, slug:slug,
             who:{ actorType:(u.roleId === 'merchant' ? 'merchant' : 'merchant_employee'), actorId:id, actorName:u.name || id } };
  }
  function canAccess(actor){ return scope(actor).ok; }

  /* ---------- attachments: metadata only ---------- */
  function cleanAttachments(list, who, now){
    if (list == null) return { ok:true, items:[] };
    if (!Array.isArray(list)) return fail('INVALID_ATTACHMENT', { errors:[{ index:null, reason:'structure' }] });
    var items = [], errors = [];
    list.forEach(function (a, i) {
      if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push({ index:i, reason:'missing' }); return; }
      if (badKeys(a, ['name','size','type','lastModified']).length) { errors.push({ index:i, reason:'structure' }); return; }
      /* only the base name is kept — never a path from the user's machine */
      var name = typeof a.name === 'string' ? a.name.split(/[\\/]/).pop().trim() : '';
      if (!name || name.length > LIMITS.fileName || /[\u0000-\u001f\u007f]/.test(name)) { errors.push({ index:i, reason:'name' }); return; }
      if (typeof a.size !== 'number' || a.size % 1 !== 0 || a.size <= 0) { errors.push({ index:i, reason:'size', name:name }); return; }
      var dot = name.lastIndexOf('.');
      items.push({ attachmentId:newId('ATT'), name:name, size:a.size,
                   type:(typeof a.type === 'string' ? a.type.slice(0, 120) : ''),
                   ext:(dot > 0 ? name.slice(dot + 1).toLowerCase().slice(0, 16) : ''),
                   storage:'metadata_only', addedAt:now,
                   addedBy:{ actorType:who.actorType, actorId:who.actorId, actorName:who.actorName } });
    });
    return errors.length ? fail('INVALID_ATTACHMENT', { errors:errors }) : { ok:true, items:items };
  }

  function audit(action, t, sc, extra){
    if (!global.RAFAudit) return;
    try {
      var o = { action:action, storeSlug:t.storeSlug, source:'merchant',
                actor:{ id:sc.id, name:sc.who.actorName }, orderId:t.relatedOrderId || null };
      for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
      o.metadata = Object.assign({ ticketId:t.ticketId }, o.metadata || {});
      RAFAudit.record(o);
    } catch (e) {}
  }
  function findIn(db, id){ return db.tickets.filter(function (t) { return t.ticketId === id; })[0] || null; }
  function owned(db, ticketId, sc){
    var t = findIn(db, ticketId);
    if (!t) return fail('NOT_FOUND');
    if (t.storeSlug !== sc.slug) return fail('CROSS_STORE');
    return { ok:true, t:t };
  }
  function categoryOf(key){ return CATEGORIES.filter(function (c) { return c.key === key; })[0] || null; }

  /* ══════════════════════ READ ══════════════════════ */
  function tickets(opts){
    opts = opts || {};
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    return { ok:true, slug:sc.slug, items:readAll().tickets.filter(function (t) { return t.storeSlug === sc.slug; }).map(copy) };
  }
  function ticket(ticketId, opts){
    opts = opts || {};
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var o = owned(readAll(), ticketId, sc); if (!o.ok) return o;
    return { ok:true, ticket:copy(o.t) };
  }
  /* every attachment on a ticket, derived from its messages — one source */
  function attachmentsOf(t){
    var out = [];
    ((t && t.messages) || []).forEach(function (m) { (m.attachments || []).forEach(function (a) { out.push(a); }); });
    return out;
  }
  function summary(opts){
    var r = tickets(opts); if (!r.ok) return r;
    var s = { ok:true, total:r.items.length, open:0, in_progress:0, waiting_merchant:0, resolved:0 };
    r.items.forEach(function (t) { if (s[t.status] != null) s[t.status]++; });
    return s;
  }

  /* ══════════════════════ WRITE ══════════════════════ */
  function createTicket(input, opts){
    input = input || {}; opts = opts || {};
    if (badKeys(input, ['category','subject','message','relatedOrderId','attachments']).length) return fail('FIELD_NOT_ACCEPTED');
    if (badKeys(opts, ['actor']).length) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;

    var errors = [];
    if (!categoryOf(input.category)) errors.push({ field:'category' });
    var subject = text(input.subject), body = text(input.message);
    if (!subject || subject.length > LIMITS.subject) errors.push({ field:'subject' });
    if (!body || body.length > LIMITS.message) errors.push({ field:'message' });
    if (errors.length) return fail('INVALID', { errors:errors });

    /* a related order must be this store's, proven from its snapshot */
    var orderId = input.relatedOrderId == null || input.relatedOrderId === '' ? null : String(input.relatedOrderId);
    if (orderId) {
      var oslug = null;
      try { oslug = global.RAFOrderSnapshot ? RAFOrderSnapshot.storeSlugOf(orderId) : null; } catch (e) { oslug = null; }
      if (!oslug) return fail('INVALID_ORDER');
      if (oslug !== sc.slug) return fail('CROSS_STORE');
    }
    var now = Date.now();
    var att = cleanAttachments(input.attachments, sc.who, now); if (!att.ok) return att;

    var first = { messageId:newId('MSG'), actorType:sc.who.actorType, actorId:sc.id, actorName:sc.who.actorName,
                  body:body, createdAt:now, attachments:att.items };
    var t = { ticketId:newId('SUP'), storeSlug:sc.slug,
              createdBy:{ actorType:sc.who.actorType, actorId:sc.id, actorName:sc.who.actorName },
              category:input.category, subject:subject, relatedOrderId:orderId,
              status:STATUS.OPEN, createdAt:now, updatedAt:now, resolvedAt:null, reopenedAt:null,
              messages:[first] };
    var db = readAll(); db.tickets.push(t);
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('support.ticket_created', t, sc, { key:t.ticketId, newState:STATUS.OPEN,
      metadata:{ category:t.category, relatedOrderId:orderId, attachments:att.items.length } });
    return { ok:true, ticket:copy(t) };
  }

  function addMessage(ticketId, input, opts){
    input = input || {}; opts = opts || {};
    if (badKeys(input, ['body','attachments']).length) return fail('FIELD_NOT_ACCEPTED');
    if (badKeys(opts, ['actor']).length) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var db = readAll(), o = owned(db, ticketId, sc); if (!o.ok) return o;
    var t = o.t;
    if (t.status === STATUS.RESOLVED) return fail('TICKET_RESOLVED');
    var body = text(input.body);
    if (!body || body.length > LIMITS.message) return fail('INVALID', { errors:[{ field:'body' }] });
    var now = Date.now();
    var att = cleanAttachments(input.attachments, sc.who, now); if (!att.ok) return att;
    var m = { messageId:newId('MSG'), actorType:sc.who.actorType, actorId:sc.id, actorName:sc.who.actorName,
              body:body, createdAt:now, attachments:att.items };
    t.messages.push(m); t.updatedAt = now;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('support.message_added', t, sc, { key:m.messageId, metadata:{ messageId:m.messageId, attachments:att.items.length } });
    return { ok:true, ticket:copy(t), message:copy(m) };
  }

  function changeStatus(ticketId, status, opts){
    opts = opts || {};
    if (badKeys(opts, ['actor','baseVersion']).length) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var db = readAll(), o = owned(db, ticketId, sc); if (!o.ok) return o;
    var t = o.t;
    if (opts.baseVersion !== undefined && opts.baseVersion !== t.updatedAt) return fail('STALE', { currentVersion:t.updatedAt });
    if ((TRANSITIONS[t.status] || []).indexOf(status) < 0) return fail('INVALID_TRANSITION', { from:t.status, to:status });
    var prev = t.status, now = Date.now();
    t.status = status; t.updatedAt = now;
    if (status === STATUS.RESOLVED) t.resolvedAt = now;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('support.status_changed', t, sc, { key:t.ticketId + ':' + prev + '>' + status + ':' + now,
      previousState:prev, newState:status });
    return { ok:true, ticket:copy(t), version:now };
  }

  /* resolved → open: the same ticket, its whole history and previous
     resolvedAt kept, reopenedAt recorded */
  function reopenTicket(ticketId, opts){
    opts = opts || {};
    if (badKeys(opts, ['actor','baseVersion']).length) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    var db = readAll(), o = owned(db, ticketId, sc); if (!o.ok) return o;
    var t = o.t;
    if (opts.baseVersion !== undefined && opts.baseVersion !== t.updatedAt) return fail('STALE', { currentVersion:t.updatedAt });
    if (t.status !== STATUS.RESOLVED) return fail('NOT_RESOLVED');
    var now = Date.now();
    t.status = STATUS.OPEN; t.reopenedAt = now; t.updatedAt = now;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('support.ticket_reopened', t, sc, { key:t.ticketId + ':reopen:' + now,
      previousState:STATUS.RESOLVED, newState:STATUS.OPEN, metadata:{ previousResolvedAt:t.resolvedAt } });
    return { ok:true, ticket:copy(t), version:now };
  }

  global.RAFCustomerSupport = {
    CATEGORIES:CATEGORIES, STATUS:STATUS, STATUS_TXT:STATUS_TXT, TRANSITIONS:TRANSITIONS, LIMITS:LIMITS, ERRORS:ERRORS,
    canAccess:canAccess, categoryOf:categoryOf,
    tickets:tickets, ticket:ticket, summary:summary, attachmentsOf:attachmentsOf,
    createTicket:createTicket, addMessage:addMessage, changeStatus:changeStatus, reopenTicket:reopenTicket
  };
})(window);
