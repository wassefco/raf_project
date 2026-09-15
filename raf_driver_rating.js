/* ============================================================================
 * RAF Marketplace — DRIVER RATING AUTHORITY  (shared, headless) — Phase G
 * ----------------------------------------------------------------------------
 * The single source of truth for a customer's rating of the driver who
 * delivered their order. Nothing else stores driver ratings.
 *
 * APPROVED RULES
 *   · The customer rates the driver after a COMPLETED delivery.
 *   · Rating is an integer 1–5; the comment is optional.
 *   · A rating is FINAL: one per order, never edited or deleted, by anyone.
 *   · The rating belongs to the driver who actually COMPLETED the delivery —
 *     the order snapshot's fulfilment owner at delivery (RAFDriver only lets
 *     the current owner complete). A driver who lost ownership earlier never
 *     receives it.
 *   · Driver visibility: their TOTAL rating only (average of all historical
 *     ratings) — no count, no individual ratings, no comments.
 *   · Management visibility (existing `drivers.suspend`): total, count, 1–5
 *     distribution, comments and the historical ratings.
 *   · The total is always computed from all records; no threshold, no weight,
 *     no age exclusion.
 *
 * IDENTITY — from the session only. The customer must be the active account
 * holding the `customer` role whose id is the order snapshot's customer.id.
 * A driverId, customerId, storeSlug or actor supplied by a caller is refused.
 *
 * STORAGE — RAFRecordStore append-only collection 'driver_ratings'
 * (ratingId = 'drt|<orderId>' → a second rating for the same order is a
 * duplicate and is refused). No notification is sent: the driver may not see
 * individual ratings.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDriverRating) return;

  var LIMITS = { comment:1000 };          /* technical guard, not a business rule */
  var PERM_MANAGE = 'drivers.suspend';

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية لهذا الإجراء.',                    en:'You do not have permission for this action.' },
    ACTOR_INACTIVE:     { ar:'حسابك غير نشط.',                                   en:'Your account is not active.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',              en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:    { ar:'الطلب غير موجود.',                                 en:'The order was not found.' },
    ORDER_NOT_YOURS:    { ar:'هذا الطلب ليس لك.',                                en:'This order is not yours.' },
    NOT_DELIVERED:      { ar:'يمكن تقييم السائق بعد تسليم الطلب فقط.',            en:'The driver can be rated only after the order is delivered.' },
    NO_DRIVER:          { ar:'لا يوجد سائق مسجّل لتسليم هذا الطلب.',              en:'No driver is recorded for this delivery.' },
    INVALID_RATING:     { ar:'التقييم يجب أن يكون من 1 إلى 5 نجوم.',              en:'The rating must be from 1 to 5 stars.' },
    COMMENT_TOO_LONG:   { ar:'التعليق طويل جدًا.',                               en:'The comment is too long.' },
    ALREADY_RATED:      { ar:'تم تقييم السائق لهذا الطلب مسبقًا، والتقييم نهائي.', en:'The driver was already rated for this order; the rating is final.' },
    NOT_A_DRIVER:       { ar:'هذا الحساب ليس حساب سائق.',                         en:'That account is not a driver account.' },
    PERSIST_FAILED:     { ar:'تعذّر حفظ التقييم.',                                en:'The rating could not be saved.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' }, r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  function coll(){ return global.RAFRecordStore ? RAFRecordStore.collection('driver_ratings') : null; }
  function me(){ try { return global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; } catch (e) { return null; } }
  function orderOf(orderId){
    try { return (global.RAFShop ? RAFShop.Orders.all() : []).filter(function (o) { return o && o.id === orderId; })[0] || null; } catch (e) { return null; }
  }
  function isDriverAccount(id){
    try { var u = RAFPerm.getUser(id); return !!(u && u.accountType === 'driver' && u.roleId === 'driver'); } catch (e) { return false; }
  }

  /* the customer side: the signed-in, active customer who owns the order */
  function customerOrder(orderId){
    var u = me();
    if (!u || u.roleId !== 'customer') return fail('FORBIDDEN');
    if (u.status && u.status !== 'active') return fail('ACTOR_INACTIVE');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var s = o.snapshot;
    if (!s.customer || !s.customer.id || s.customer.id !== u.id) return fail('ORDER_NOT_YOURS');
    return { ok:true, user:u, order:o, snap:s };
  }
  function ratingOfOrder(orderId){ var c = coll(); return c ? c.byId('ratingId', 'drt|' + orderId) : null; }

  /* what the customer may do on their own delivered order */
  function statusFor(orderId){
    var c = customerOrder(orderId); if (!c.ok) return c;
    var f = c.snap.fulfilment || {}, delivered = c.order.status === 'delivered' && !!f.deliveredAt;
    var mine = ratingOfOrder(orderId), name = null;
    try { var du = f.driverId ? RAFPerm.getUser(f.driverId) : null; name = du ? du.name : null; } catch (e) {}
    return { ok:true, orderId:orderId, delivered:delivered, driverName:name,
             canRate:delivered && !!f.driverId && !mine,
             /* the customer sees their own final rating, nothing else */
             myRating:mine ? { rating:mine.rating, comment:mine.comment, at:mine.at } : null };
  }

  function submit(orderId, data){
    data = data || {};
    if (!onlyKeys(data, ['rating', 'comment'])) return fail('FIELD_NOT_ACCEPTED');
    var c = customerOrder(orderId); if (!c.ok) return c;
    var f = c.snap.fulfilment || {};
    if (c.order.status !== 'delivered' || !f.deliveredAt) return fail('NOT_DELIVERED');
    if (!f.driverId || !isDriverAccount(f.driverId)) return fail('NO_DRIVER');
    var r = data.rating;
    if (typeof r !== 'number' || r % 1 !== 0 || r < 1 || r > 5) return fail('INVALID_RATING');
    var comment = data.comment == null ? '' : (typeof data.comment === 'string' ? data.comment.trim() : null);
    if (comment === null) return fail('FIELD_NOT_ACCEPTED');
    if (comment.length > LIMITS.comment) return fail('COMMENT_TOO_LONG');
    var col = coll(); if (!col) return fail('PERSIST_FAILED');
    var ratingId = 'drt|' + orderId;
    if (col.byId('ratingId', ratingId)) return fail('ALREADY_RATED');
    var now = Date.now();
    var rec = { ratingId:ratingId, orderId:orderId, driverId:f.driverId, customerId:c.user.id,
                storeSlug:c.snap.storeSlug || null, rating:r, comment:comment || null,
                deliveredAt:f.deliveredAt, at:now, version:1 };
    var a = col.append('ratingId', rec);
    if (!a.ok) return fail('PERSIST_FAILED');
    if (a.duplicate) return fail('ALREADY_RATED');
    if (global.RAFAudit) {
      try { RAFAudit.record({ action:'rating.submitted', orderId:orderId, storeSlug:rec.storeSlug, actor:{ id:c.user.id }, source:'customer',
              key:ratingId, metadata:{ ratingId:ratingId, driverId:rec.driverId, rating:r, hasComment:!!rec.comment } }); } catch (e) {}
    }
    if (global.RAFEventBus) RAFEventBus.publish('driver.rating.submitted', { entityId:orderId, source:'customer',
      storeSlug:rec.storeSlug, payload:{ ratingId:ratingId } });
    return { ok:true, rating:{ rating:rec.rating, comment:rec.comment, at:rec.at } };
  }

  /* ---------- reads ---------- */
  function recordsFor(driverId){ var c = coll(); return c ? c.filter(function (x) { return x.driverId === driverId; }) : []; }
  function average(list){
    if (!list.length) return null;
    var sum = list.reduce(function (n, x) { return n + x.rating; }, 0);
    return Math.round((sum / list.length) * 10) / 10;
  }
  function driverScope(){
    if (!global.RAFDriver || !RAFDriver.scope) return fail('FORBIDDEN');
    var sc = RAFDriver.scope(); return sc.ok ? sc : fail('FORBIDDEN');
  }
  function managerScope(){
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    try { if (!RAFPerm.can(u.id, PERM_MANAGE)) return fail('FORBIDDEN'); } catch (e) { return fail('FORBIDDEN'); }
    return { ok:true, id:u.id };
  }
  /* the driver: their own TOTAL only */
  function mine(opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var sc = driverScope(); if (!sc.ok) return sc;
    return { ok:true, total:average(recordsFor(sc.id)), outOf:5 };
  }
  /* management: total, count, distribution, comments, history */
  function forDriver(driverId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var sc = managerScope(); if (!sc.ok) return sc;
    if (!isDriverAccount(driverId)) return fail('NOT_A_DRIVER');
    var list = recordsFor(driverId).slice().sort(function (a, b) { return b.at - a.at; });
    var dist = { 1:0, 2:0, 3:0, 4:0, 5:0 };
    list.forEach(function (x) { dist[x.rating]++; });
    return { ok:true, driverId:driverId, total:average(list), outOf:5, count:list.length, distribution:dist,
             history:list.map(function (x) { return { orderId:x.orderId, rating:x.rating, comment:x.comment, at:x.at }; }) };
  }

  global.RAFDriverRating = { ERRORS:ERRORS, statusFor:statusFor, submit:submit, mine:mine, forDriver:forDriver };
})(window);
