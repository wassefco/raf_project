/* ==========================================================================
 * RAF — MERCHANT DASHBOARD  (RAFDashboard)
 * --------------------------------------------------------------------------
 * A READ-ONLY aggregation layer over the existing RAF authorities. It owns
 * no data, stores nothing and writes nothing. Every figure is read from the
 * module that owns it, through that module's own API:
 *
 *   store status   → RAFStoreOps (manual status, Busy, prep time, schedule,
 *                    Instant Delivery, next opening) + RAFStoreSchedule
 *   orders         → RAFOrderEngine.queueOf — the same placement the Orders
 *                    page uses, over RAFOrderSnapshot.forStore
 *   products/stock → RAFMerchantProducts.list + summarize (RAFInventory)
 *   sales/finance  → RAFAnalytics.build (last 30 days, the Analytics
 *                    default) · RAFSettlement.currentPreview · payouts
 *   marketing      → RAFMarketing (status as the module decorates it)
 *   customer exp.  → RAFCustomerExperience.ratingSummary + issues
 *   support        → RAFCustomerSupport.summary
 *   activity       → RAFAudit (full log with reports.view, else the
 *                    merchant timeline events)
 *
 * Scope: the acting account's own store, resolved by RAFPerm.storeSlugOf
 * (actor id). A caller-supplied store is refused, never honoured. Merchant
 * and merchant employee only.
 *
 * Each section is read independently: one module failing (or being
 * unavailable to the account's permissions) never breaks the others, and
 * "unavailable" is always distinguishable from a real zero.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDashboard) return;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'لوحة التحكم متاحة للتجار وموظفي المتاجر فقط.', en:'The dashboard is available to merchants and store employees only.' },
    NO_STORE:           { ar:'لا يوجد متجر مرتبط بهذا الحساب.',             en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:    { ar:'المتجر المرتبط غير موجود.',                   en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',         en:'The request contains fields that are not accepted.' },
    NOT_PERMITTED:      { ar:'غير متاح لصلاحيات حسابك.',                    en:'Not available for your account’s permissions.' },
    SESSION_MISMATCH:   { ar:'متاح للحساب المسجّل دخوله فقط.',              en:'Available to the signed-in account only.' },
    MODULE_MISSING:     { ar:'هذا القسم غير متاح حالياً.',                  en:'This section is not available right now.' },
    SECTION_FAILED:     { ar:'تعذّر تحميل هذا القسم.',                     en:'This section could not be loaded.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }
  function can(id, key){ try { return !!(global.RAFPerm && RAFPerm.can(id, key)); } catch (e) { return false; } }

  /* ---------- scope: the acting account's own store, by id ---------- */
  function scope(opts){
    if (opts == null) opts = {};
    if (typeof opts !== 'object' || Array.isArray(opts)) return fail('FIELD_NOT_ACCEPTED');
    /* only the actor is accepted — a store, slug or user is never taken from the caller */
    if (Object.keys(opts).some(function (k) { return k !== 'actor'; })) return fail('FIELD_NOT_ACCEPTED');
    var id = actorId(opts.actor);
    if (!id || !global.RAFPerm) return fail('FORBIDDEN');
    var u = null; try { u = RAFPerm.getUser(id); } catch (e) { u = null; }
    if (!u) return fail('FORBIDDEN');
    var merchant = false; try { merchant = !!RAFPerm.isMerchant(id); } catch (e) { merchant = false; }
    if (!merchant) return fail('FORBIDDEN');
    var slug = null; try { slug = RAFPerm.storeSlugOf(id) || null; } catch (e) { slug = null; }
    if (!slug) return fail('NO_STORE');
    var store = global.RAFSource ? RAFSource.store(slug) : null;
    if (!store) return fail('STORE_NOT_FOUND');
    var cu = null; try { cu = RAFPerm.currentUser(); } catch (e) { cu = null; }
    return { ok:true, id:id, user:u, slug:slug, store:store, session:!!(cu && cu.id === id) };
  }
  function canAccess(actor){ return scope({ actor:actor }).ok; }

  /* one section, isolated: a missing module or a thrown error stays inside it */
  function run(mods, fn){
    var miss = mods.filter(function (n) { return !global[n]; });
    if (miss.length) return fail('MODULE_MISSING', { missing:miss });
    try { return fn(); } catch (e) { return fail('SECTION_FAILED', { detail:String((e && e.message) || e) }); }
  }

  /* ══════════════════════ SECTIONS ══════════════════════ */

  /* Store status. The manual status and the schedule are reported side by
     side and never collapsed: being outside the opening hours is not
     "Closed" (RAFStoreOps' rule). */
  function storeSection(sc){
    return run(['RAFStoreOps'], function () {
      var OPS = RAFStoreOps, s = OPS.snapshot(sc.slug), av = OPS.deliveryAvailability(sc.slug);
      return { ok:true, status:sc.store.status || null, accepting:!!s.acceptingOrders,
               busy:!!s.busy, busyUntil:s.busyUntil || null,
               prep:{ state:s.state, manual:!!s.manual, range:s.range || null },
               configured:!!av.configured, schedule:av.schedule, instant:av.instant,
               nextOpening:av.nextOpening, scheduled:{ available:!!av.scheduled.available, reason:av.scheduled.reason } };
    });
  }

  /* Orders, grouped exactly as the Orders page groups them */
  var QUEUE_KEYS = ['pending', 'preparing', 'ready', 'driver', 'scheduled', 'done', 'cancelled'];
  function ordersSection(sc){
    if (!can(sc.id, 'orders.view')) return fail('NOT_PERMITTED');
    return run(['RAFOrderSnapshot', 'RAFOrderEngine'], function () {
      var c = {}; QUEUE_KEYS.forEach(function (k) { c[k] = 0; });
      var list = RAFOrderSnapshot.forStore(sc.slug);
      list.forEach(function (o) { var q = RAFOrderEngine.queueOf(o) || 'preparing'; c[q]++; });
      return { ok:true, counts:c, total:list.length };
    });
  }

  /* Products & inventory — the Product Workspace summary, from its module */
  function productsSection(sc){
    return run(['RAFMerchantProducts', 'RAFInventory', 'RAFSource'], function () {
      var MP = RAFMerchantProducts;
      if (!MP.canView(sc.id)) return fail('NOT_PERMITTED');
      var s = MP.summarize(MP.list({ user:sc.id }));
      s.ok = true; s.lowAt = MP.LOW_STOCK_AT;
      return s;
    });
  }

  /* Sales & finance. RAFAnalytics and RAFSettlement read the signed-in
     session (reports.view), so they are only asked for that account. */
  function financeSection(sc){
    if (!can(sc.id, 'reports.view')) return fail('NOT_PERMITTED');
    if (!sc.session) return fail('SESSION_MISMATCH');
    var sales = run(['RAFAnalytics'], function () {
      var r = RAFAnalytics.build({ range:{ preset:'last30' } });
      if (!r.ok) return r;
      return { ok:true, range:r.range, net:r.summary.net, orders:r.summary.orders, aov:r.summary.aov };
    });
    var settlement = run(['RAFSettlement'], function () {
      var r = RAFSettlement.currentPreview();
      if (!r.ok) return r;
      return { ok:true, period:r.period, status:r.status, amount:r.settlementAmount,
               rate:r.rate, unresolved:(r.unresolved || []).length };
    });
    var payout = run(['RAFSettlement'], function () {
      var r = RAFSettlement.payouts();
      if (!r.ok) return r;
      return { ok:true, available:!!r.available, reason:r.reason || null };
    });
    return { ok:true, preset:'last30', sales:sales, settlement:settlement, payout:payout };
  }

  /* Marketing — counted by the status RAFMarketing assigns */
  function marketingSection(sc){
    return run(['RAFMarketing'], function () {
      var M = RAFMarketing;
      /* RAFMarketing reads the actor as an object ({ id }) */
      if (!M.canView({ id:sc.id })) return fail('NOT_PERMITTED');
      function tally(list){
        var t = { total:list.length, active:0, scheduled:0, expiringSoon:0 };
        list.forEach(function (x) {
          if (x.status === M.STATUS.ACTIVE) { t.active++; if (x.expiringSoon) t.expiringSoon++; }
          else if (x.status === M.STATUS.SCHEDULED) t.scheduled++;
        });
        return t;
      }
      return { ok:true, promotions:tally(M.promotions({ storeSlug:sc.slug })),
               coupons:tally(M.coupons({ storeSlug:sc.slug })), ads:tally(M.ads({ storeSlug:sc.slug })) };
    });
  }

  /* Customer experience — the module's own summary; open issues are the
     unresolved ones (open + in progress + waiting for customer) */
  function cxSection(sc){
    return run(['RAFCustomerExperience'], function () {
      var CX = RAFCustomerExperience;
      var rs = CX.ratingSummary({ actor:sc.id }); if (!rs.ok) return rs;
      var is = CX.issues({ actor:sc.id });       if (!is.ok) return is;
      var by = {}; Object.keys(CX.STATUS_TXT).forEach(function (k) { by[k] = 0; });
      is.items.forEach(function (x) { if (by[x.status] != null) by[x.status]++; });
      return { ok:true,
               reviews:{ total:rs.total, average:rs.average, positivePct:rs.positivePct },
               issues:{ total:is.items.length, active:is.items.length - (by.resolved || 0), byStatus:by } };
    });
  }

  function supportSection(sc){
    return run(['RAFCustomerSupport'], function () {
      var s = RAFCustomerSupport.summary({ actor:sc.id }); if (!s.ok) return s;
      return { ok:true, total:s.total, open:s.open, in_progress:s.in_progress,
               waiting_merchant:s.waiting_merchant, resolved:s.resolved };
    });
  }

  /* Recent activity. The detailed audit log is gated by RAFAudit's own
     rule (reports.view); without it only the merchant timeline events —
     what the Orders page already shows every store user — are listed. */
  var ACTIVITY_MAX = 8;
  function activitySection(sc){
    return run(['RAFAudit'], function () {
      var full = RAFAudit.canViewAudit(sc.id), A = RAFAudit.ACTIONS || {};
      var list = RAFAudit.forStore(sc.slug).filter(function (e) { return full || (A[e.action] && A[e.action].tl); });
      var items = list.slice(-ACTIVITY_MAX).reverse().map(function (e) {
        return { eventId:e.eventId, timestamp:e.timestamp, action:e.action, orderId:e.orderId || null,
                 actorType:e.actorType, automatic:!!(e.automatic || e.systemGenerated), undone:!!e.undone };
      });
      return { ok:true, scope:full ? 'audit' : 'timeline', total:list.length, items:items };
    });
  }

  /* Needs attention — only facts the sections above already report */
  function attention(r){
    var out = [];
    function add(key, n, target){ if (n > 0) out.push({ key:key, count:n, target:target }); }
    var s = r.status, o = r.orders, p = r.products, cx = r.cx, su = r.support;
    if (o && o.ok) add('orders_pending', o.counts.pending, 'orders');
    if (s && s.ok) {
      if (s.status && s.status !== 'open') out.push({ key:'store_not_open', count:null, target:'store', status:s.status });
      else if (s.busy) out.push({ key:'store_busy', count:null, target:'store', until:s.busyUntil });
      if (!s.configured) out.push({ key:'schedule_unconfigured', count:null, target:'store' });
    }
    if (p && p.ok) { add('out_of_stock', p.zero, 'products'); add('low_stock', p.low, 'products'); add('no_inventory', p.none, 'products'); }
    if (cx && cx.ok) add('cx_open', cx.issues.byStatus.open || 0, 'customers');
    if (su && su.ok) add('support_waiting', su.waiting_merchant, 'support');
    return out;
  }

  /* ══════════════════════ THE ONE READ ══════════════════════ */
  function overview(opts){
    var sc = scope(opts); if (!sc.ok) return sc;
    var r = { ok:true, generatedAt:Date.now(), role:sc.user.roleId,
              store:{ slug:sc.slug, name:sc.store.name, logo:sc.store.logo || '' } };
    r.status    = storeSection(sc);
    r.orders    = ordersSection(sc);
    r.products  = productsSection(sc);
    r.finance   = financeSection(sc);
    r.marketing = marketingSection(sc);
    r.cx        = cxSection(sc);
    r.support   = supportSection(sc);
    r.activity  = activitySection(sc);
    r.attention = attention(r);
    return r;
  }

  global.RAFDashboard = {
    ERRORS:ERRORS, QUEUE_KEYS:QUEUE_KEYS, ACTIVITY_MAX:ACTIVITY_MAX,
    canAccess:canAccess, overview:overview
  };
})(window);
