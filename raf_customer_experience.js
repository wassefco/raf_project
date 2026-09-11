/* ============================================================================
 * RAF Marketplace — CUSTOMER EXPERIENCE AUTHORITY  (shared, headless)
 * ----------------------------------------------------------------------------
 * One domain authority for the customer's experience with a store:
 *   · Reviews          — a customer rates a product they bought in an order
 *   · Customer Issues  — a customer raises a problem about their own order
 *   · Rating summary   — always calculated from the actual reviews
 *
 * It is not Order Management, Inventory, Marketing, Finance or Merchant
 * Support. Orders are only READ, through the immutable Order Snapshot.
 *
 * IDENTITY — every relationship is proven, never taken from the caller:
 *   · customer  = the acting account, which must hold the `customer` role
 *   · order     = RAFOrderSnapshot.of(orderId); its customer.id must be the
 *                 acting customer
 *   · store     = the order snapshot's storeSlug (customer side), or
 *                 RAFPerm.storeSlugOf(actorId) (merchant side)
 *   · product   = must be a line of that order's snapshot
 * A storeSlug, customerId or merchant identity supplied by a caller is
 * refused. Orders without a recorded customer (legacy orders) cannot be
 * reviewed or raised — their ownership cannot be proven.
 *
 * PERMISSIONS — no new keys. Reading uses the existing `stores.view`,
 * writing (reply, status change) uses `stores.edit`; a merchant employee
 * therefore reads but does not write.
 *
 * IMMUTABILITY — a customer's rating and comment are never changed after
 * submission, by anyone. There is no delete for reviews, issues or
 * messages. A merchant reply is kept apart from the review; when a reply is
 * edited the previous text is kept in replyHistory, and edits are
 * stale-protected.
 *
 * Text limits below are technical guards against runaway input, not
 * business rules.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFCustomerExperience) return;

  var LS = 'raf_customer_experience';
  var LIMITS = { comment:2000, reply:1000, subject:150, description:3000, message:2000 };

  var CATEGORIES = [
    { key:'product_quality',  ar:'جودة المنتج',            en:'Product quality' },
    { key:'not_as_described', ar:'المنتج لا يطابق الوصف',  en:'Product not as described' },
    { key:'missing_item',     ar:'منتج ناقص',              en:'Missing item' },
    { key:'delivery_issue',   ar:'مشكلة في التوصيل',       en:'Delivery issue' },
    { key:'order_issue',      ar:'مشكلة في الطلب',         en:'Order issue' },
    { key:'other',            ar:'أخرى',                   en:'Other' }
  ];
  var STATUS = { OPEN:'open', IN_PROGRESS:'in_progress', WAITING_CUSTOMER:'waiting_customer', RESOLVED:'resolved' };
  var STATUS_TXT = {
    open:             { ar:'مفتوحة',          en:'Open' },
    in_progress:      { ar:'قيد المعالجة',     en:'In progress' },
    waiting_customer: { ar:'بانتظار العميل',   en:'Waiting for customer' },
    resolved:         { ar:'تم الحل',          en:'Resolved' }
  };
  /* The merchant's moves along the approved flow
       Open → In Progress → Waiting for Customer → Resolved
     A resolved issue is reopened only by its customer (→ Open). */
  var TRANSITIONS = {
    open:             ['in_progress'],
    in_progress:      ['waiting_customer', 'resolved'],
    waiting_customer: ['in_progress', 'resolved'],
    resolved:         []
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:            { ar:'ليس لديك صلاحية لهذا الإجراء.',                 en:'You do not have permission for this action.' },
    NO_STORE:             { ar:'لا يوجد متجر مرتبط بهذا الحساب.',               en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:      { ar:'المتجر المرتبط غير موجود.',                     en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED:   { ar:'تحتوي البيانات على حقول غير مقبولة.',           en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:      { ar:'الطلب غير موجود.',                             en:'The order could not be found.' },
    ORDER_NOT_YOURS:      { ar:'هذا الطلب لا يخصك.',                           en:'This order does not belong to you.' },
    PRODUCT_NOT_IN_ORDER: { ar:'هذا المنتج ليس ضمن الطلب.',                    en:'This product is not part of the order.' },
    INVALID_RATING:       { ar:'التقييم يجب أن يكون من 1 إلى 5 نجوم.',          en:'The rating must be from 1 to 5 stars.' },
    ALREADY_REVIEWED:     { ar:'قيّمت هذا المنتج في هذا الطلب من قبل.',          en:'You have already reviewed this product for this order.' },
    INVALID:              { ar:'البيانات غير صالحة.',                          en:'The details are not valid.' },
    NOT_FOUND:            { ar:'العنصر غير موجود.',                            en:'The item could not be found.' },
    CROSS_STORE:          { ar:'هذا العنصر لا يخص متجرك.',                     en:'This item does not belong to your store.' },
    STALE:                { ar:'تم التعديل من جلسة أخرى. أعد التحميل ثم حاول مجدداً.',
                            en:'This was changed in another session. Reload and try again.' },
    NO_CHANGES:           { ar:'لا توجد تغييرات لحفظها.',                     en:'There are no changes to save.' },
    INVALID_TRANSITION:   { ar:'لا يمكن الانتقال إلى هذه الحالة.',              en:'The issue cannot move to that status.' },
    ISSUE_RESOLVED:       { ar:'تم حل هذه المشكلة. يمكن للعميل إعادة فتحها.',   en:'This issue is resolved. The customer can reopen it.' },
    NOT_RESOLVED:         { ar:'لا يمكن إعادة فتح مشكلة لم تُحل.',              en:'Only a resolved issue can be reopened.' },
    PERSIST_FAILED:       { ar:'تعذّر الحفظ.',                                 en:'Could not save.' }
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

  /* ---------- storage (existing RAF convention: one module key) ---------- */
  function readAll(){
    try {
      var v = JSON.parse(localStorage.getItem(LS) || 'null');
      if (v && typeof v === 'object') return { reviews:Array.isArray(v.reviews) ? v.reviews : [], issues:Array.isArray(v.issues) ? v.issues : [] };
    } catch (e) {}
    return { reviews:[], issues:[] };
  }
  function writeAll(db){
    try { localStorage.setItem(LS, JSON.stringify(db)); } catch (e) { return false; }
    try { document.dispatchEvent(new CustomEvent('raf:cx')); } catch (e2) {}
    return true;
  }

  /* ---------- identity ---------- */
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  function userOf(id){ try { return (id && global.RAFPerm) ? RAFPerm.getUser(id) : null; } catch (e) { return null; } }
  function can(id, key){ try { return !!(global.RAFPerm && RAFPerm.can(id, key)); } catch (e) { return false; } }
  /* the merchant side: the acting account's own store, by id */
  function merchantScope(actor, perm){
    var id = actorId(actor), u = userOf(id);
    if (!u) return fail('FORBIDDEN');
    var slug = null;
    try { slug = RAFPerm.storeSlugOf(id) || null; } catch (e) { slug = null; }
    if (!slug) return fail('NO_STORE');
    if (!can(id, perm)) return fail('FORBIDDEN');
    if (global.RAFSource && !RAFSource.store(slug)) return fail('STORE_NOT_FOUND');
    return { ok:true, id:id, user:u, slug:slug };
  }
  /* the customer side: an account holding the customer role */
  function customerScope(actor){
    var id = actorId(actor), u = userOf(id);
    if (!u || u.roleId !== 'customer') return fail('FORBIDDEN');
    return { ok:true, id:id, user:u };
  }
  function canView(actor){ return merchantScope(actor, 'stores.view').ok; }
  function canManage(actor){ return merchantScope(actor, 'stores.edit').ok; }

  /* ---------- the order, proven from its snapshot ---------- */
  function snapOf(orderId){
    if (!orderId || !global.RAFOrderSnapshot) return null;
    try { return RAFOrderSnapshot.of(orderId) || null; } catch (e) { return null; }
  }
  function ownedOrder(orderId, customerId){
    var s = snapOf(orderId);
    if (!s || !s.storeSlug) return fail('ORDER_NOT_FOUND');
    /* an order with no recorded customer cannot be proven to be anyone's */
    if (!s.customer || !s.customer.id || s.customer.id !== customerId) return fail('ORDER_NOT_YOURS');
    return { ok:true, snap:s };
  }
  /* display data for an order-linked record, from the historical snapshot —
     stays readable if the product later changes or disappears */
  function productOf(orderId, productId){
    var s = snapOf(orderId), it = s && (s.items || []).filter(function (x) { return x.productId === productId; })[0];
    return it ? { ar:it.nameAr || it.nameEn || productId, en:it.nameEn || it.nameAr || productId } : { ar:productId, en:productId };
  }
  function customerNameOf(orderId){ var s = snapOf(orderId); return (s && s.customer && s.customer.name) || null; }

  function onlyKeys(o, allowed){
    return Object.keys(o || {}).filter(function (k) { return allowed.indexOf(k) < 0; });
  }
  function audit(action, rec, extra){
    if (!global.RAFAudit) return;
    try {
      var o = { action:action, orderId:rec.orderId || null, storeSlug:rec.storeSlug || null };
      for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k];
      RAFAudit.record(o);
    } catch (e) {}
  }
  /* the existing customer notification path (RAFOrderEngine.notify) — its
     recipient is the customer on the order's own snapshot */
  function notifyCustomer(orderId, msg){
    if (!global.RAFOrderEngine || !RAFOrderEngine.notify) return false;
    try { RAFOrderEngine.notify(orderId, msg, 'raf_tracking.html?id=' + encodeURIComponent(orderId)); return true; } catch (e) { return false; }
  }

  /* ══════════════════════ REVIEWS ══════════════════════ */
  /* opts.actor: a merchant (own store) or a customer (own reviews) */
  function reviews(opts){
    opts = opts || {};
    var id = actorId(opts.actor), u = userOf(id);
    if (u && u.roleId === 'customer')
      return { ok:true, items:readAll().reviews.filter(function (r) { return r.customerId === id; }).map(copy) };
    var sc = merchantScope(opts.actor, 'stores.view'); if (!sc.ok) return sc;
    return { ok:true, slug:sc.slug, editable:can(sc.id, 'stores.edit'),
             items:readAll().reviews.filter(function (r) { return r.storeSlug === sc.slug; }).map(copy) };
  }

  function createReview(input, opts){
    input = input || {}; opts = opts || {};
    if (onlyKeys(input, ['orderId','productId','rating','comment']).length) return fail('FIELD_NOT_ACCEPTED');
    var sc = customerScope(opts.actor); if (!sc.ok) return sc;
    var o = ownedOrder(input.orderId, sc.id); if (!o.ok) return o;
    if (!(o.snap.items || []).some(function (it) { return it.productId === input.productId; })) return fail('PRODUCT_NOT_IN_ORDER');
    if (typeof input.rating !== 'number' || input.rating % 1 !== 0 || input.rating < 1 || input.rating > 5) return fail('INVALID_RATING');
    var comment = input.comment == null ? '' : (typeof input.comment === 'string' ? input.comment.trim() : null);
    if (comment === null || comment.length > LIMITS.comment) return fail('INVALID', { errors:[{ field:'comment' }] });

    var db = readAll();
    /* approved rule: one review per customer + order + product */
    if (db.reviews.some(function (r) { return r.customerId === sc.id && r.orderId === input.orderId && r.productId === input.productId; }))
      return fail('ALREADY_REVIEWED');

    var now = Date.now();
    var rec = { reviewId:newId('RV'), orderId:input.orderId, storeSlug:o.snap.storeSlug, customerId:sc.id,
                productId:input.productId, rating:input.rating, comment:comment,
                createdAt:now, updatedAt:now,
                merchantReply:null, merchantReplyAt:null, merchantReplyBy:null, replyHistory:[] };
    db.reviews.push(rec);
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('customer_experience.review_created', rec, { source:'customer', key:rec.reviewId,
      actor:{ id:sc.id, name:sc.user.name }, metadata:{ reviewId:rec.reviewId, rating:rec.rating } });
    return { ok:true, review:copy(rec) };
  }

  /* add or edit the merchant's reply — the review itself is never touched */
  function replyReview(reviewId, reply, opts){
    opts = opts || {};
    if (onlyKeys(opts, ['actor','baseVersion']).length) return fail('FIELD_NOT_ACCEPTED');
    var sc = merchantScope(opts.actor, 'stores.edit'); if (!sc.ok) return sc;
    var db = readAll(), rec = db.reviews.filter(function (r) { return r.reviewId === reviewId; })[0];
    if (!rec) return fail('NOT_FOUND');
    if (rec.storeSlug !== sc.slug) return fail('CROSS_STORE');
    var body = text(reply);
    if (!body || body.length > LIMITS.reply) return fail('INVALID', { errors:[{ field:'reply' }] });
    var version = rec.merchantReplyAt || 0;
    if (opts.baseVersion !== undefined && opts.baseVersion !== version) return fail('STALE', { currentVersion:version });
    if (rec.merchantReply === body) return fail('NO_CHANGES');

    var now = Date.now(), edited = !!rec.merchantReply;
    if (edited) rec.replyHistory.push({ text:rec.merchantReply, at:rec.merchantReplyAt, by:rec.merchantReplyBy });
    rec.merchantReply = body; rec.merchantReplyAt = now; rec.merchantReplyBy = sc.id; rec.updatedAt = now;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    /* keyed on the reply's position in its history, so two replies in the
       same millisecond are still two recorded facts */
    audit('customer_experience.review_replied', rec, { source:'merchant', key:rec.reviewId + ':reply:' + rec.replyHistory.length + ':' + now,
      actor:{ id:sc.id, name:sc.user.name }, metadata:{ reviewId:rec.reviewId, edited:edited } });
    notifyCustomer(rec.orderId, { ar:'ردّ المتجر على تقييمك للطلب ' + rec.orderId + '.',
                                  en:'The store replied to your review of order ' + rec.orderId + '.' });
    return { ok:true, review:copy(rec), version:now };
  }

  /* calculated from the reviews every time — nothing is stored */
  function summarize(list){
    var counts = { 1:0, 2:0, 3:0, 4:0, 5:0 }, stars = 0;
    list.forEach(function (r) { if (counts[r.rating] != null) { counts[r.rating]++; stars += r.rating; } });
    var total = list.length, positive = counts[4] + counts[5];
    return { total:total, counts:counts, average:total ? stars / total : null,
             positive:positive, positivePct:total ? (positive / total) * 100 : null };
  }
  function ratingSummary(opts){
    var r = reviews(opts); if (!r.ok) return r;
    var s = summarize(r.items); s.ok = true; return s;
  }

  /* ══════════════════════ CUSTOMER ISSUES ══════════════════════ */
  function issues(opts){
    opts = opts || {};
    var id = actorId(opts.actor), u = userOf(id);
    if (u && u.roleId === 'customer')
      return { ok:true, items:readAll().issues.filter(function (x) { return x.customerId === id; }).map(copy) };
    var sc = merchantScope(opts.actor, 'stores.view'); if (!sc.ok) return sc;
    return { ok:true, slug:sc.slug, editable:can(sc.id, 'stores.edit'),
             items:readAll().issues.filter(function (x) { return x.storeSlug === sc.slug; }).map(copy) };
  }
  function categoryOf(key){ return CATEGORIES.filter(function (c) { return c.key === key; })[0] || null; }

  function createIssue(input, opts){
    input = input || {}; opts = opts || {};
    if (onlyKeys(input, ['orderId','category','subject','description']).length) return fail('FIELD_NOT_ACCEPTED');
    var sc = customerScope(opts.actor); if (!sc.ok) return sc;
    var o = ownedOrder(input.orderId, sc.id); if (!o.ok) return o;
    var errors = [];
    if (!categoryOf(input.category)) errors.push({ field:'category' });
    var subject = text(input.subject), description = text(input.description);
    if (!subject || subject.length > LIMITS.subject) errors.push({ field:'subject' });
    if (!description || description.length > LIMITS.description) errors.push({ field:'description' });
    if (errors.length) return fail('INVALID', { errors:errors });

    var now = Date.now();
    var rec = { issueId:newId('CI'), orderId:input.orderId, storeSlug:o.snap.storeSlug, customerId:sc.id,
                category:input.category, subject:subject, description:description,
                status:STATUS.OPEN, createdAt:now, updatedAt:now, messages:[], resolvedAt:null, reopenedAt:null };
    var db = readAll(); db.issues.push(rec);
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('customer_experience.issue_created', rec, { source:'customer', key:rec.issueId,
      actor:{ id:sc.id, name:sc.user.name }, newState:STATUS.OPEN, metadata:{ issueId:rec.issueId, category:rec.category } });
    return { ok:true, issue:copy(rec) };
  }

  /* who may act on this issue: its store's merchant (stores.edit) or its customer */
  function issueActor(rec, actor){
    var id = actorId(actor), u = userOf(id);
    if (u && u.roleId === 'customer') return rec.customerId === id ? { ok:true, type:'customer', id:id, user:u } : fail('NOT_FOUND');
    var sc = merchantScope(actor, 'stores.edit'); if (!sc.ok) return sc;
    if (rec.storeSlug !== sc.slug) return fail('CROSS_STORE');
    return { ok:true, type:'merchant', id:sc.id, user:sc.user };
  }
  function findIssue(db, issueId){ return db.issues.filter(function (x) { return x.issueId === issueId; })[0] || null; }

  function replyIssue(issueId, body, opts){
    opts = opts || {};
    if (onlyKeys(opts, ['actor']).length) return fail('FIELD_NOT_ACCEPTED');
    var db = readAll(), rec = findIssue(db, issueId);
    if (!rec) return fail('NOT_FOUND');
    var who = issueActor(rec, opts.actor); if (!who.ok) return who;
    if (rec.status === STATUS.RESOLVED) return fail('ISSUE_RESOLVED');
    var msg = text(body);
    if (!msg || msg.length > LIMITS.message) return fail('INVALID', { errors:[{ field:'message' }] });
    var now = Date.now();
    var m = { messageId:newId('M'), actorType:who.type, actorId:who.id, actorName:who.user.name || who.id, body:msg, createdAt:now };
    rec.messages.push(m); rec.updatedAt = now;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('customer_experience.issue_message_added', rec, { source:who.type, key:m.messageId,
      actor:{ id:who.id, name:who.user.name }, metadata:{ issueId:rec.issueId, messageId:m.messageId } });
    if (who.type === 'merchant')
      notifyCustomer(rec.orderId, { ar:'ردّ المتجر على مشكلتك «' + rec.subject + '».', en:'The store replied to your issue "' + rec.subject + '".' });
    return { ok:true, issue:copy(rec), message:copy(m) };
  }

  function changeIssueStatus(issueId, status, opts){
    opts = opts || {};
    if (onlyKeys(opts, ['actor','baseVersion']).length) return fail('FIELD_NOT_ACCEPTED');
    var db = readAll(), rec = findIssue(db, issueId);
    if (!rec) return fail('NOT_FOUND');
    var who = issueActor(rec, opts.actor); if (!who.ok) return who;
    if (who.type !== 'merchant') return fail('FORBIDDEN');
    if (opts.baseVersion !== undefined && opts.baseVersion !== rec.updatedAt) return fail('STALE', { currentVersion:rec.updatedAt });
    if ((TRANSITIONS[rec.status] || []).indexOf(status) < 0) return fail('INVALID_TRANSITION', { from:rec.status, to:status });
    var prev = rec.status, now = Date.now();
    rec.status = status; rec.updatedAt = now;
    if (status === STATUS.RESOLVED) rec.resolvedAt = now;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('customer_experience.issue_status_changed', rec, { source:'merchant', key:rec.issueId + ':' + prev + '>' + status + ':' + now,
      actor:{ id:who.id, name:who.user.name }, previousState:prev, newState:status, metadata:{ issueId:rec.issueId } });
    var s = STATUS_TXT[status];
    notifyCustomer(rec.orderId, { ar:'تم تحديث حالة مشكلتك «' + rec.subject + '»: ' + s.ar + '.',
                                  en:'Your issue "' + rec.subject + '" is now: ' + s.en + '.' });
    return { ok:true, issue:copy(rec), version:now };
  }

  /* the customer reopens their own resolved issue — same issue, full history */
  function reopenIssue(issueId, opts){
    opts = opts || {};
    if (onlyKeys(opts, ['actor']).length) return fail('FIELD_NOT_ACCEPTED');
    var db = readAll(), rec = findIssue(db, issueId);
    if (!rec) return fail('NOT_FOUND');
    var who = issueActor(rec, opts.actor); if (!who.ok) return who;
    if (who.type !== 'customer') return fail('FORBIDDEN');
    if (rec.status !== STATUS.RESOLVED) return fail('NOT_RESOLVED');
    var now = Date.now();
    rec.status = STATUS.OPEN; rec.reopenedAt = now; rec.updatedAt = now;
    if (!writeAll(db)) return fail('PERSIST_FAILED');
    audit('customer_experience.issue_reopened', rec, { source:'customer', key:rec.issueId + ':reopen:' + now,
      actor:{ id:who.id, name:who.user.name }, previousState:STATUS.RESOLVED, newState:STATUS.OPEN,
      metadata:{ issueId:rec.issueId } });
    return { ok:true, issue:copy(rec) };
  }

  global.RAFCustomerExperience = {
    CATEGORIES:CATEGORIES, STATUS:STATUS, STATUS_TXT:STATUS_TXT, TRANSITIONS:TRANSITIONS, LIMITS:LIMITS, ERRORS:ERRORS,
    canView:canView, canManage:canManage,
    /* reviews */
    reviews:reviews, createReview:createReview, replyReview:replyReview,
    ratingSummary:ratingSummary, summarize:summarize,
    /* issues */
    issues:issues, createIssue:createIssue, replyIssue:replyIssue,
    changeIssueStatus:changeIssueStatus, reopenIssue:reopenIssue, categoryOf:categoryOf,
    /* read-only display helpers — from the historical order snapshot */
    productOf:productOf, customerNameOf:customerNameOf
  };
})(window);
