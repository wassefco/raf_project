/* ============================================================================
 * RAF Marketplace — REPORTS CENTER  (RAFReports, shared, headless) — Phase J
 * ----------------------------------------------------------------------------
 * A READ-ONLY projection over the authorities that already own the facts. It
 * owns no record, writes nothing (no storage, no audit, no notification, no
 * event), calculates no business rule of its own and never re-implements a
 * calculation an authority already performs. Viewing, filtering, sorting,
 * searching, exporting or printing a report changes nothing.
 *
 *   RAFReports.run(reportId, filters)  → the report (also per-report methods)
 *   RAFReports.csv(result)             → CSV of exactly the authorized rows
 *   RAFReports.REPORTS                 → the report catalogue
 *
 * REPORTS AND THEIR SOURCES
 *   overview        every figure below, each labelled with its own source
 *   orders          RAFShop.Orders (snapshot) + RAFOrderEngine milestones
 *   deliveries      snapshot fulfilment + RAFOrderEngine + RAFDriver ownership
 *                   history + RAFDeliveryOps.exceptions + penalty risk
 *   drivers         RAFDriverPerformance.compare (the only performance maths)
 *   exceptions      RAFDeliveryOps.exceptions.list (SLA, escalation, penalty)
 *   reassignments   RAFRecordStore 'reassignments' / 'pool_returns' /
 *                   'reassignment_requests' (RAFDriver's own history)
 *   performance     RAFDriverPerformance.compare + .detail (same numbers)
 *   communication   RAFDriverCommunication.list (counts only, never content)
 *   compensation    RAFCompensation.list + the wallet lot each record carries
 *   audit           RAFAudit.query (append-only; never rewritten here)
 *
 * AUTHORISATION — existing keys only, no new role and no new permission.
 *   · every report needs the existing `reports.view` (the key RAFAudit already
 *     uses for audit visibility);
 *   · a report over data another authority guards ALSO delegates to that
 *     authority, so its own gate decides: drivers/performance →
 *     RAFDriverPerformance (`drivers.suspend`), exceptions → RAFDeliveryOps
 *     (`orders.manage` staff scope), communication → RAFDriverCommunication
 *     and compensation → RAFCompensation (`drivers.suspend`), audit →
 *     RAFAudit.canViewAudit;
 *   · STORE SCOPE: an account linked to a store (merchant) is restricted to
 *     that store's rows, and driver identity is not disclosed to it. The link
 *     comes from RAFPerm.storeSlugOf(session) — never from a name, never
 *     guessed, and an unlinked merchant account gets no rows;
 *   · identity is the session; caller-supplied identity fields are refused.
 *
 * DATES — periods (Today / Week / Month / Custom) come from
 * RAFDriverPerformance.periodOf, so RAF keeps ONE period implementation in the
 * configured timezone ('availability.scheduleTimezone', Asia/Kuwait). Each
 * report states WHICH timestamp it filters on and never substitutes another:
 * orders → placed (snapshot checkoutAt) · deliveries → delivered, else the
 * assignment/claim · exceptions → opened · reassignments → the move itself ·
 * compensation → issued · audit → the event. Historical rows are read as
 * stored; nothing is recalculated with today's configuration.
 *
 * NOT_CONFIGURED / NOT_AVAILABLE is reported where a value genuinely cannot be
 * derived (no approved configuration, or the owning authority refuses) — never
 * a zero, an estimate or a placeholder.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFReports) return;

  var PERM_VIEW = 'reports.view', PERM_EXPORT = 'reports.export', PERM_ORDERS = 'orders.view', PERM_DRIVERS = 'drivers.view';

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية على التقارير.',              en:'You do not have access to reports.' },
    ACTOR_INACTIVE:     { ar:'حسابك غير نشط.',                             en:'Your account is not active.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',        en:'The request contains fields that are not accepted.' },
    UNKNOWN_REPORT:     { ar:'التقرير غير معروف.',                         en:'Unknown report.' },
    PERIOD_INVALID:     { ar:'الفترة غير صالحة.',                          en:'The period is not valid.' },
    NO_STORE_LINK:      { ar:'حسابك غير مرتبط بمتجر، فلا توجد بيانات ضمن نطاقك.', en:'Your account is not linked to a store, so no data is in your scope.' },
    SOURCE_UNAVAILABLE: { ar:'مصدر البيانات غير متاح.',                    en:'The data source is not available.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' }, r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  function rows(n){ try { return RAFRecordStore.collection(n).all(); } catch (e) { return []; } }
  function orders(){ try { return (global.RAFShop ? RAFShop.Orders.all() : []).filter(function (o) { return o && o.snapshot; }); } catch (e) { return []; } }
  function userName(id){ try { var u = id ? RAFPerm.getUser(id) : null; return u ? u.name : null; } catch (e) { return null; } }
  function eng(){ return global.RAFOrderEngine || null; }
  function at(fn, orderId){ var E = eng(); if (!E || !E[fn]) return null; var m = E[fn](orderId); return m ? m.at : null; }
  function inP(t, p){ return typeof t === 'number' && t >= p.start && t < p.end; }
  var NA = { notAvailable:true }, NC = { notConfigured:true };

  /* ---------- the session, its permissions and its store scope ---------- */
  function viewer(){
    var u = null; try { u = RAFPerm.currentUser(); } catch (e) {}
    if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var can = function (k) { try { return !!RAFPerm.can(u.id, k); } catch (e) { return false; } };
    if (!can(PERM_VIEW)) return fail('FORBIDDEN', { needs:[PERM_VIEW] });
    /* a store-linked account sees only its own store, and no driver identity */
    var linked = null; try { linked = RAFPerm.storeSlugOf(u.id) || null; } catch (e) {}
    var storeBound = u.accountType === 'merchant';
    if (storeBound && !linked) return fail('NO_STORE_LINK');
    return { ok:true, id:u.id, name:u.name, roleId:u.roleId, accountType:u.accountType,
             storeSlug:storeBound ? linked : null, storeBound:storeBound,
             canExport:can(PERM_EXPORT), can:can };
  }
  /* OPERATIONAL REPORTS — `reports.view` alone never grants them. A caller is
     either
       · Logistics/management: the SAME existing pair the Logistics surfaces
         already require (`orders.view` + `drivers.view`, RAFDeliveryOps' own
         scope), which Operations Manager, Higher Management and Super Admin
         hold and Finance (no `drivers.view`) and Marketing (neither) do not; or
       · a store-linked merchant account, limited to its own store AND to the
         reports already approved for merchant visibility (its own orders and
         their deliveries — never drivers, exceptions, reassignments,
         communication or compensation).
     No new role, no new permission key, and `reports.view` keeps its existing
     meaning everywhere else (RAFAudit still decides audit visibility). */
  var MERCHANT_REPORTS = ['overview', 'orders', 'deliveries', 'audit'];   /* audit stays store-scoped, as RAFAudit.forStore already allows a store to see its own history */
  function needsOperational(v, reportId){
    if (v.can(PERM_ORDERS) && v.can(PERM_DRIVERS)) return { ok:true, logistics:true };
    if (v.storeBound && v.can(PERM_ORDERS) && MERCHANT_REPORTS.indexOf(reportId) > -1) return { ok:true, logistics:false };
    return fail('FORBIDDEN', { needs:[PERM_VIEW, PERM_ORDERS, PERM_DRIVERS], reportId:reportId });
  }
  /* the period authority — one implementation for all of RAF */
  function periodOf(spec){
    var P = global.RAFDriverPerformance;
    if (!P || !P.periodOf) return fail('SOURCE_UNAVAILABLE', { source:'RAFDriverPerformance.periodOf' });
    var p = P.periodOf(spec || { preset:'today' });
    return p.ok ? p : fail('PERIOD_INVALID');
  }

  /* ---------- filters ---------- */
  var FILTER_KEYS = ['period', 'storeSlug', 'driverId', 'orderId', 'status', 'category', 'sla', 'reassignmentState', 'communicationType', 'customerId', 'employeeId', 'action', 'search'];
  function normalise(f, allowed){
    f = f || {};
    if (!onlyKeys(f, allowed)) return fail('FIELD_NOT_ACCEPTED');
    var out = {};
    allowed.forEach(function (k) { if (k !== 'period' && f[k] != null && f[k] !== '' && f[k] !== 'all') out[k] = String(f[k]); });
    return { ok:true, filters:out };
  }
  function matchSearch(row, term){
    if (!term) return true;
    var t = String(term).toLowerCase();
    return Object.keys(row).some(function (k) {
      var v = row[k];
      return v != null && typeof v !== 'object' && String(v).toLowerCase().indexOf(t) > -1;
    });
  }
  function finish(reportId, v, p, filters, columns, list, summary, notes){
    var rowsOut = list.filter(function (r) { return matchSearch(r, filters.search); });
    return { ok:true, reportId:reportId, period:p, filters:filters, scope:{ storeSlug:v.storeSlug, storeBound:v.storeBound },
             columns:columns, rows:rowsOut, count:rowsOut.length, summary:summary || [], notes:notes || [],
             canExport:v.canExport, generatedAt:Date.now() };
  }
  function col(key, ar, en){ return { key:key, ar:ar, en:en }; }
  function stat(key, ar, en, value, source, state){ return { key:key, ar:ar, en:en, value:value, source:source, state:state || null }; }

  /* ---------- shared order facts (each timestamp kept distinct) ---------- */
  function orderFacts(o){
    var s = o.snapshot || {}, f = s.fulfilment || {};
    return { orderId:o.id, storeSlug:s.storeSlug || null, status:o.status,
             customerId:(s.customer && s.customer.id) || null, customerName:(s.customer && s.customer.name) || null,
             placedAt:s.checkoutAt || null,
             acceptedAt:at('acceptedAt', o.id), readyAt:at('readyAt', o.id),
             /* only a RECORDED promise is reported; never derived from today's config */
             promisedEtaAt:(function (e) { return e ? e.at : null; })(storedEta(o.id)),
             assignedAt:f.assignedAt || null, pickedUpAt:f.pickedUpAt || null, deliveredAt:at('deliveredAt', o.id) || f.deliveredAt || null,
             driverId:f.driverId || null, total:o.total || null };
  }
  function scoped(v, list, slugOf){
    if (!v.storeBound) return list;
    return list.filter(function (x) { return slugOf(x) === v.storeSlug; });
  }
  function fmtMs(ms){ if (ms == null) return null; var m = Math.round(ms / 60000); return m; }
  /* THE HISTORICAL PROMISED ETA — only a value an authority RECORDED at the
     time is reported. Reports never derives one from today's configuration and
     never backfills: an order with nothing recorded reads NOT_AVAILABLE. */
  function storedEta(orderId){
    var E = eng();
    var p = E && E.promisedEtaAt ? E.promisedEtaAt(orderId) : null;   /* snapshot.promise when recorded */
    if (p && p.recorded) return { at:p.at, source:'RAFOrderSnapshot.promise (recorded at acceptance)' };
    var c = rows('compensations').filter(function (r) { return r.orderId === orderId && r.promisedEtaAt != null; })[0];
    if (c) return { at:c.promisedEtaAt, source:'RAFCompensation (recorded at issue)' };
    var e = rows('exceptions').filter(function (r) { return r.orderId === orderId && r.promisedEtaAtOpen != null; })
      .sort(function (a, b) { return a.openedAt - b.openedAt; })[0];
    if (e) return { at:e.promisedEtaAtOpen, source:'RAFDeliveryOps (recorded at exception open)' };
    return null;
  }

  /* ═════════════════ ORDERS ═════════════════ */
  function ordersReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var g = needsOperational(v, 'orders'); if (!g.ok) return g;
    var n = normalise(filters, ['period', 'storeSlug', 'status', 'orderId', 'customerId', 'driverId', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    var f = n.filters;
    var list = scoped(v, orders().map(orderFacts), function (x) { return x.storeSlug; })
      .filter(function (x) { return inP(x.placedAt, p); })                       /* PLACED time */
      .filter(function (x) { return (!f.storeSlug || x.storeSlug === f.storeSlug) && (!f.status || x.status === f.status)
                                  && (!f.orderId || x.orderId === f.orderId) && (!f.customerId || x.customerId === f.customerId)
                                  && (!f.driverId || x.driverId === f.driverId); })
      .sort(function (a, b) { return (b.placedAt || 0) - (a.placedAt || 0); })
      .map(function (x) {
        var dur = (x.deliveredAt && x.placedAt) ? fmtMs(x.deliveredAt - x.placedAt) : null;
        var r = { orderId:x.orderId, storeSlug:x.storeSlug, customer:x.customerName, status:x.status,
                  placedAt:x.placedAt, acceptedAt:x.acceptedAt, readyAt:x.readyAt,
                  pickedUpAt:x.pickedUpAt, deliveredAt:x.deliveredAt, promisedEtaAt:x.promisedEtaAt,
                  durationMinutes:dur, total:x.total };
        if (!v.storeBound) r.driver = x.driverId ? userName(x.driverId) : null;   /* driver identity: logistics only */
        return r;
      });
    var cols = [col('orderId', 'رقم الطلب', 'Order'), col('storeSlug', 'المتجر', 'Store'), col('customer', 'العميل', 'Customer'),
      col('status', 'الحالة', 'Status'), col('placedAt', 'وقت الطلب', 'Placed'), col('acceptedAt', 'قبول المتجر', 'Merchant accepted'),
      col('readyAt', 'جاهز', 'Ready')].concat(v.storeBound ? [] : [col('driver', 'السائق', 'Driver')],
      [col('pickedUpAt', 'الاستلام', 'Picked up'), col('deliveredAt', 'التسليم', 'Delivered'),
       col('promisedEtaAt', 'الوقت الموعود', 'Promised ETA'), col('durationMinutes', 'المدة (د)', 'Duration (min)'), col('total', 'الإجمالي', 'Total')]);
    var byStatus = {}; list.forEach(function (r) { byStatus[r.status] = (byStatus[r.status] || 0) + 1; });
    var summary = [stat('orders', 'الطلبات', 'Orders', list.length, 'RAFShop.Orders (snapshot checkoutAt)'),
      stat('delivered', 'تم التسليم', 'Delivered', byStatus.delivered || 0, 'order.status'),
      stat('cancelled', 'ملغاة', 'Cancelled', byStatus.cancelled || 0, 'order.status'),
      stat('inProgress', 'قيد التنفيذ', 'In progress', list.length - (byStatus.delivered || 0) - (byStatus.cancelled || 0), 'order.status')];
    return finish('orders', v, p, f, cols, list, summary,
      [T('الفترة تُطبَّق على وقت إنشاء الطلب.', 'The period filters on the order’s placed time.')]);
  }

  /* ═════════════════ DELIVERIES ═════════════════ */
  function deliveriesReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var g = needsOperational(v, 'deliveries'); if (!g.ok) return g;
    var n = normalise(filters, ['period', 'storeSlug', 'driverId', 'orderId', 'status', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    var f = n.filters;
    var own = rows('ownership'), ex = rows('exceptions');
    var exList = null, exErr = null;
    try { var r = global.RAFDeliveryOps ? RAFDeliveryOps.exceptions.list({}) : null; if (r && r.ok) exList = r.exceptions; else exErr = r && r.code; } catch (e) { exErr = 'SOURCE_UNAVAILABLE'; }
    var list = scoped(v, orders().map(orderFacts), function (x) { return x.storeSlug; })
      /* a delivery belongs to the period by its DELIVERED time, or — while it is
         still running — by its assignment/claim time. The two are never mixed. */
      .map(function (x) {
        var reass = own.filter(function (r) { return r.orderId === x.orderId && r.kind === 'reassignment'; });
        var pool = own.filter(function (r) { return r.orderId === x.orderId && r.kind === 'returned_to_pool'; });
        var claim = own.filter(function (r) { return r.orderId === x.orderId && (r.kind === 'claim' || r.kind === 'assignment' || r.kind === 'dispatch'); })[0];
        var exFor = (exList || ex).filter(function (e) { return e.orderId === x.orderId; });
        var basis = x.deliveredAt != null ? x.deliveredAt : (x.assignedAt || (claim ? claim.at : null));
        return { order:x, basis:basis, reassignments:reass.length, poolReturns:pool.length, exceptions:exFor.length,
                 penalty:exFor.length && exList ? (exFor.some(function (e) { return e.penalty && e.penalty.atRisk; }) ? true : false) : null };
      })
      .filter(function (d) { return inP(d.basis, p); })
      .filter(function (d) { return (!f.storeSlug || d.order.storeSlug === f.storeSlug) && (!f.driverId || d.order.driverId === f.driverId)
                                  && (!f.orderId || d.order.orderId === f.orderId) && (!f.status || d.order.status === f.status); })
      .sort(function (a, b) { return (b.basis || 0) - (a.basis || 0); })
      .map(function (d) {
        var x = d.order;
        /* HISTORY FIRST: if an authority stored the Promised ETA as it stood at
           the time (a compensation record, an exception at opening), that stored
           instant is reported. Only when nothing stored it does RAFOrderEngine
           derive it — which, being derived, follows the current configuration. */
        var stored = storedEta(x.orderId), eta = stored ? stored.at : null;
        var delay = (x.deliveredAt != null && eta != null) ? fmtMs(x.deliveredAt - eta) : null;
        x = Object.assign({}, x, { promisedEtaAt:eta, etaSource:stored ? stored.source : 'NOT_AVAILABLE (not recorded)' });
        var row = { orderId:x.orderId, storeSlug:x.storeSlug, state:x.status,
                    assignedAt:x.assignedAt, pickedUpAt:x.pickedUpAt, promisedEtaAt:x.promisedEtaAt, deliveredAt:x.deliveredAt,
                    etaSource:x.etaSource, delayMinutes:delay, penaltyRisk:d.penalty == null ? null : (d.penalty ? 'yes' : 'no'),
                    reassignments:d.reassignments, poolReturns:d.poolReturns, exceptions:d.exceptions };
        if (!v.storeBound) row.driver = x.driverId ? userName(x.driverId) : null;
        return row;
      });
    var cols = [col('orderId', 'رقم الطلب', 'Order'), col('storeSlug', 'المتجر', 'Store')].concat(v.storeBound ? [] : [col('driver', 'السائق الحالي', 'Current driver')],
      [col('state', 'الحالة', 'State'), col('assignedAt', 'الإسناد', 'Assigned'), col('pickedUpAt', 'الاستلام', 'Picked up'),
       col('promisedEtaAt', 'الوقت الموعود', 'Promised ETA'), col('etaSource', 'مصدر الوقت الموعود', 'ETA source'),
       col('deliveredAt', 'التسليم', 'Delivered'), col('delayMinutes', 'التأخير (د)', 'Delay (min)'),
       col('penaltyRisk', 'خطر الغرامة', 'Penalty risk'), col('reassignments', 'إعادة الإسناد', 'Reassignments'),
       col('poolReturns', 'إرجاع للقائمة', 'Returns to pool'), col('exceptions', 'الاستثناءات', 'Exceptions')]);
    var delivered = list.filter(function (r) { return r.deliveredAt != null; });
    var late = delivered.filter(function (r) { return r.delayMinutes != null && r.delayMinutes > 0; });
    var etaMin = global.RAFConfig ? RAFConfig.value('eta.promisedDurationMinutes') : null;
    var summary = [stat('deliveries', 'التوصيلات', 'Deliveries', list.length, 'snapshot fulfilment + RAFOrderEngine'),
      stat('completed', 'مكتملة', 'Completed', delivered.length, 'RAFOrderEngine.deliveredAt'),
      stat('late', 'متأخرة عن الوقت الموعود', 'Later than the Promised ETA', late.length, 'deliveredAt − promisedEtaAt'),
      stat('promisedEta', 'مدة الوقت الموعود', 'Promised ETA offset', etaMin == null ? NC : etaMin + ' ' + T('دقيقة', 'min'), "RAFConfig 'eta.promisedDurationMinutes'", etaMin == null ? 'NOT_CONFIGURED' : null)];
    var notes = [T('التأخير = وقت التسليم − الوقت الموعود (قبول المتجر + المدة المُهيّأة).', 'Delay = delivered time − Promised ETA (merchant accepted + the configured duration).'),
      T('الوقت الموعود يُقرأ كما سُجّل تاريخيًا فقط؛ الطلبات التي لم يُسجَّل لها وقت موعود تظهر NOT_AVAILABLE ولا يُشتق لها أي وقت.',
        'The Promised ETA is read only as it was recorded; an order with none recorded shows NOT_AVAILABLE and no ETA is derived for it.')];
    if (exErr) notes.push(T('أعداد الاستثناءات وخطر الغرامة غير متاحة لحسابك (' + exErr + ').', 'Exception counts and penalty risk are not available to your account (' + exErr + ').'));
    return finish('deliveries', v, p, f, cols, list, summary, notes);
  }

  /* ═════════════════ DRIVERS / PERFORMANCE (RAFDriverPerformance only) ═════════════════ */
  function driverRows(filters, reportId){
    var v = viewer(); if (!v.ok) return v;
    var n = normalise(filters, ['period', 'driverId', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    var P = global.RAFDriverPerformance;
    if (!P) return fail('SOURCE_UNAVAILABLE', { source:'RAFDriverPerformance' });
    /* RAFDriverPerformance decides who may read this and does every calculation */
    var r = P.compare({ period:(filters || {}).period || { preset:'today' } });
    if (!r.ok) return r;
    var f = n.filters;
    var list = r.drivers.filter(function (d) { return !f.driverId || d.driverId === f.driverId; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); })      /* by name — never a ranking */
      .map(function (d) {
        var m = d.metrics;
        return { driver:d.name, accountStatus:d.accountStatus, claims:m.claims, deliveries:m.deliveries,
                 lostOwnership:m.lostOwnership, skips:m.skips, reassignmentRequests:m.reassignmentRequests, exceptions:m.exceptions,
                 workingMinutes:fmtMs(m.workingMs), overtimeMinutes:m.overtimeMs == null ? null : fmtMs(m.overtimeMs),
                 totalRating:m.rating && m.rating.total != null ? m.rating.total.toFixed(1) : null,
                 ratings:m.rating ? m.rating.count : null };
      });
    var cols = [col('driver', 'السائق', 'Driver'), col('accountStatus', 'حالة الحساب', 'Account'), col('claims', 'السحب الناجح', 'Claims'),
      col('deliveries', 'التوصيلات المكتملة', 'Deliveries'), col('lostOwnership', 'نُقلت منه', 'Lost ownership'), col('skips', 'التخطي', 'Skips'),
      col('reassignmentRequests', 'طلبات إعادة الإسناد', 'Reassignment requests'), col('exceptions', 'الاستثناءات', 'Exceptions'),
      col('workingMinutes', 'ساعات العمل (د)', 'Working (min)'), col('overtimeMinutes', 'العمل الإضافي (د)', 'Overtime (min)'),
      col('totalRating', 'التقييم الكلي', 'Total rating'), col('ratings', 'عدد التقييمات', 'Ratings')];
    var sum = function (k) { return list.reduce(function (a, x) { return a + (x[k] || 0); }, 0); };
    var summary = [stat('drivers', 'السائقون', 'Drivers', list.length, 'RAFPerm driver accounts'),
      stat('claims', 'السحب الناجح', 'Claims', sum('claims'), 'RAFDriverPerformance'),
      stat('deliveries', 'التوصيلات المكتملة', 'Deliveries', sum('deliveries'), 'RAFDriverPerformance'),
      stat('exceptions', 'الاستثناءات', 'Exceptions', sum('exceptions'), 'RAFDriverPerformance')];
    return finish(reportId, v, p, f, cols, list, summary,
      [T('كل الأرقام من RAFDriverPerformance. التقييم الكلي يشمل كل الفترات ولا يتغيّر بتغيير الفترة. لا توجد درجة ولا ترتيب.',
         'Every figure comes from RAFDriverPerformance. The total rating is all-time and does not change with the period. No score and no ranking.')]);
  }

  /* ═════════════════ EXCEPTIONS & SLA ═════════════════ */
  function exceptionsReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var n = normalise(filters, ['period', 'storeSlug', 'category', 'status', 'sla', 'driverId', 'orderId', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    if (!global.RAFDeliveryOps) return fail('SOURCE_UNAVAILABLE', { source:'RAFDeliveryOps' });
    var r = RAFDeliveryOps.exceptions.list({});                    /* its own staff gate decides */
    if (!r.ok) return r;
    var f = n.filters;
    var list = scoped(v, r.exceptions, function (x) { return x.storeSlug; })
      .filter(function (x) { return inP(x.openedAt, p); })          /* OPENED time */
      .filter(function (x) { return (!f.storeSlug || x.storeSlug === f.storeSlug)
        && (!f.category || (x.category && (x.category.key || x.category) === f.category))
        && (!f.status || x.status === f.status)
        && (!f.sla || (x.sla && x.sla.state === f.sla))
        && (!f.driverId || (x.driver && x.driver.id === f.driverId))
        && (!f.orderId || x.orderId === f.orderId); })
      .map(function (x) {
        var closed = x.closedAt || null;
        return { exceptionId:x.exceptionId, orderId:x.orderId, storeSlug:x.storeSlug,
                 category:(x.category && (x.category.en || x.category.key)) || x.category || null,
                 openedAt:x.openedAt, openedBy:x.openedBy ? x.openedBy.type : null,
                 driverAtOpen:x.driver ? x.driver.name : null, status:x.status,
                 escalation:x.escalation || null, escalatedBy:x.escalatedBy ? (x.escalatedBy.name || x.escalatedBy.id) : null,
                 slaState:x.sla ? (x.sla.state || (x.sla.configured === false ? 'NOT_CONFIGURED' : null)) : null,
                 slaDeadline:x.sla ? x.sla.deadlineAt || null : null,
                 resolution:x.resolutionType || null, autoClosed:x.autoClosed ? 'yes' : (closed ? 'no' : null),
                 closedAt:closed, reopenCount:x.reopenCount || 0,
                 penaltyRisk:x.penalty ? (x.penalty.atRisk ? 'yes' : 'no') : null,
                 resolutionMinutes:closed ? fmtMs(closed - x.openedAt) : null };
      })
      .sort(function (a, b) { return b.openedAt - a.openedAt; });
    var cols = [col('exceptionId', 'رقم الاستثناء', 'Exception'), col('orderId', 'الطلب', 'Order'), col('storeSlug', 'المتجر', 'Store'),
      col('category', 'الفئة', 'Category'), col('openedAt', 'وقت الفتح', 'Opened'), col('openedBy', 'فتحه', 'Opened by'),
      col('driverAtOpen', 'السائق عند الفتح', 'Driver at opening'), col('status', 'الحالة', 'Status'),
      col('escalation', 'التصعيد', 'Escalation'), col('escalatedBy', 'الموظف', 'Employee'),
      col('slaState', 'حالة SLA', 'SLA state'), col('slaDeadline', 'موعد SLA', 'SLA deadline'),
      col('resolution', 'المعالجة', 'Resolution'), col('autoClosed', 'إغلاق تلقائي', 'Auto-closed'),
      col('closedAt', 'وقت الإغلاق', 'Closed'), col('reopenCount', 'إعادة الفتح', 'Reopened'),
      col('penaltyRisk', 'خطر الغرامة', 'Penalty risk'), col('resolutionMinutes', 'زمن المعالجة (د)', 'Resolution (min)')];
    var open = list.filter(function (x) { return x.status !== 'closed'; });
    var closedRows = list.filter(function (x) { return x.resolutionMinutes != null; });
    var avg = closedRows.length ? Math.round(closedRows.reduce(function (a, x) { return a + x.resolutionMinutes; }, 0) / closedRows.length) : null;
    var cats = {}; list.forEach(function (x) { if (x.category) cats[x.category] = (cats[x.category] || 0) + 1; });
    var top = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })[0] || null;
    var slaCfg = r.config && r.config.slaMinutes != null ? r.config.slaMinutes : (global.RAFConfig ? RAFConfig.value('sla.exceptionDurationMinutes') : null);
    var summary = [stat('total', 'الاستثناءات', 'Exceptions', list.length, 'RAFDeliveryOps.exceptions'),
      stat('open', 'مفتوحة', 'Open', open.length, 'exception status'),
      stat('approaching', 'SLA يقترب', 'SLA approaching', list.filter(function (x) { return x.slaState === 'approaching'; }).length, 'RAFDeliveryOps SLA'),
      stat('breached', 'SLA مُخترق', 'SLA breached', list.filter(function (x) { return x.slaState === 'breached'; }).length, 'RAFDeliveryOps SLA'),
      stat('avgResolution', 'متوسط زمن المعالجة (د)', 'Average resolution (min)', avg == null ? NA : avg, 'closedAt − openedAt', avg == null ? 'NOT_AVAILABLE' : null),
      stat('withReassignment', 'انتهت بإعادة إسناد', 'Resolved with reassignment', list.filter(function (x) { return x.resolution === 'reassign_driver' || x.resolution === 'return_to_pool'; }).length, 'resolutionType'),
      stat('withoutReassignment', 'بدون إعادة إسناد', 'Resolved without reassignment', closedRows.filter(function (x) { return x.resolution && x.resolution !== 'reassign_driver' && x.resolution !== 'return_to_pool'; }).length, 'resolutionType'),
      stat('topCategory', 'الفئة الأكثر تكرارًا', 'Most frequent category', top || NA, 'category counts', top ? null : 'NOT_AVAILABLE'),
      stat('slaMinutes', 'مدة SLA', 'SLA duration', slaCfg == null ? NC : slaCfg + ' ' + T('دقيقة', 'min'), "RAFConfig 'sla.exceptionDurationMinutes'", slaCfg == null ? 'NOT_CONFIGURED' : null)];
    return finish('exceptions', v, p, f, cols, list, summary,
      [T('الفترة تُطبَّق على وقت فتح الاستثناء. حالة SLA كما تحسبها RAFDeliveryOps ولا تتوقف بالتصعيد أو القفل.',
         'The period filters on the exception’s opened time. The SLA state is RAFDeliveryOps’ own and never pauses for escalation or a lock.')]);
  }

  /* ═════════════════ REASSIGNMENTS & POOL RETURNS ═════════════════ */
  function reassignmentsReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var n = normalise(filters, ['period', 'storeSlug', 'driverId', 'orderId', 'reassignmentState', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    if (!global.RAFDeliveryOps || !RAFDeliveryOps.canAccess()) return fail('FORBIDDEN');   /* logistics staff scope */
    var f = n.filters;
    var byOrder = {}; orders().forEach(function (o) { byOrder[o.id] = orderFacts(o); });
    var reqEntries = rows('reassignment_requests'), lastByReq = {};
    reqEntries.forEach(function (e) { var prev = lastByReq[e.requestId];
      if (!prev || e.at > prev.at || (e.at === prev.at && (e.seq || 0) > (prev.seq || 0))) lastByReq[e.requestId] = e; });
    var moves = rows('ownership').filter(function (r) { return r.kind === 'reassignment' || r.kind === 'returned_to_pool'; })
      .map(function (r) {
        var o = byOrder[r.orderId] || {};
        var req = r.requestId ? lastByReq[r.requestId] : null;
        return { orderId:r.orderId, storeSlug:o.storeSlug || null, kind:r.kind,
                 previousDriver:r.fromDriverId ? userName(r.fromDriverId) : null,
                 newDriver:r.toDriverId ? userName(r.toDriverId) : null,
                 reason:r.reason || null,
                 beforeOrAfterPickup:o.pickedUpAt != null && r.at >= o.pickedUpAt ? 'after_pickup' : 'before_pickup',
                 reassignedAt:r.kind === 'reassignment' ? r.at : null,
                 returnedToPoolAt:r.kind === 'returned_to_pool' ? r.at : null,
                 /* the ownership record stores the classification as 'pool' (regular|priority) */
                 poolClass:r.pool || r.poolClass || r.priority || null,
                 requestState:req ? req.type : null, decisionAt:req && req.type !== 'submitted' ? req.at : null,
                 at:r.at, driverIds:[r.fromDriverId, r.toDriverId] };
      });
    var list = scoped(v, moves, function (x) { return x.storeSlug; })
      .filter(function (x) { return inP(x.at, p); })                 /* the MOVE's own time */
      .filter(function (x) { return (!f.storeSlug || x.storeSlug === f.storeSlug) && (!f.orderId || x.orderId === f.orderId)
        && (!f.driverId || x.driverIds.indexOf(f.driverId) > -1)
        && (!f.reassignmentState || x.kind === f.reassignmentState || x.requestState === f.reassignmentState); })
      .sort(function (a, b) { return b.at - a.at; })
      .map(function (x) { delete x.driverIds; delete x.at; return x; });
    var cols = [col('orderId', 'الطلب', 'Order'), col('storeSlug', 'المتجر', 'Store'), col('kind', 'النوع', 'Type'),
      col('previousDriver', 'السائق السابق', 'Previous driver'), col('newDriver', 'السائق الجديد', 'New driver'),
      col('reason', 'السبب', 'Reason'), col('beforeOrAfterPickup', 'قبل/بعد الاستلام', 'Before / after pickup'),
      col('reassignedAt', 'وقت إعادة الإسناد', 'Reassigned at'), col('returnedToPoolAt', 'وقت الإرجاع للقائمة', 'Returned to pool at'),
      col('poolClass', 'تصنيف القائمة', 'Pool class'), col('requestState', 'حالة الطلب', 'Request state'), col('decisionAt', 'وقت القرار', 'Decision at')];
    var requests = reqEntries.filter(function (e) { return e.type === 'submitted' && inP(e.at, p); });
    var st = { pending:0, cancelled:0, approved:0, rejected:0 };
    requests.forEach(function (e) { var l = lastByReq[e.requestId] || e;
      if (l.type === 'submitted') st.pending++; else if (l.type === 'cancelled') st.cancelled++; else if (l.type === 'rejected') st.rejected++; else if (l.type === 'approved') st.approved++; });
    var summary = [stat('reassignments', 'إعادة الإسناد', 'Reassignments', list.filter(function (x) { return x.kind === 'reassignment'; }).length, "RAFDriver ownership 'reassignment'"),
      stat('poolReturns', 'إرجاع للقائمة', 'Returns to pool', list.filter(function (x) { return x.kind === 'returned_to_pool'; }).length, "RAFDriver ownership 'returned_to_pool'"),
      stat('afterPickup', 'بعد الاستلام', 'After pickup', list.filter(function (x) { return x.beforeOrAfterPickup === 'after_pickup'; }).length, 'snapshot fulfilment.pickedUpAt'),
      stat('requests', 'طلبات السائقين', 'Driver requests', requests.length, "'reassignment_requests' submitted"),
      stat('requestStates', 'حالات الطلبات', 'Request states', st.pending + ' / ' + st.cancelled + ' / ' + st.approved + ' / ' + st.rejected, 'pending / cancelled / approved / rejected')];
    return finish('reassignments', v, p, f, cols, list, summary,
      [T('الاستلام يبقى مكتملًا بعد إعادة الإسناد؛ السائق التالي يكمل مباشرة.', 'A completed pickup stays completed after a reassignment; the next driver continues directly.')]);
  }

  /* ═════════════════ COMMUNICATION (counts only, never content) ═════════════════ */
  function communicationReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var n = normalise(filters, ['period', 'storeSlug', 'orderId', 'communicationType', 'driverId', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    if (!global.RAFDriverCommunication) return fail('SOURCE_UNAVAILABLE', { source:'RAFDriverCommunication' });
    var r = RAFDriverCommunication.list();                          /* its own management gate decides */
    if (!r.ok) return r;
    var f = n.filters;
    var msgs = rows('communication_messages'), events = rows('communication_events');
    var byOrder = {}; orders().forEach(function (o) { byOrder[o.id] = orderFacts(o); });
    var list = r.conversations.map(function (cv) {
      var mine = msgs.filter(function (m) { return m.orderId === cv.orderId; });
      var kinds = {}; mine.forEach(function (m) { kinds[m.type || 'text'] = (kinds[m.type || 'text'] || 0) + 1; });
      var ev = events.filter(function (e) { return e.orderId === cv.orderId; });
      var opened = ev.filter(function (e) { return e.type === 'opened'; })[0];
      var closed = ev.filter(function (e) { return e.type === 'closed'; })[0];
      var o = byOrder[cv.orderId] || {};
      return { orderId:cv.orderId, storeSlug:o.storeSlug || null, currentDriver:cv.currentDriver || null,
               participants:(o.customerName ? 1 : 0) + (cv.currentDriver ? 1 : 0),
               messages:cv.messages, text:kinds.text || 0, image:kinds.image || 0, voice:kinds.voice || 0,
               calls:ev.filter(function (e) { return e.type === 'call'; }).length,
               driverChanges:ev.filter(function (e) { return e.type === 'driver_transferred' || e.type === 'driver_assigned' || e.type === 'driver_released'; }).length,
               openedAt:opened ? opened.at : null, lastAt:cv.lastAt, closedAt:closed ? closed.at : null,
               state:cv.closed ? 'closed' : (cv.active ? 'active' : 'no_driver') };
    })
      .filter(function (x) { return inP(x.lastAt != null ? x.lastAt : x.openedAt, p); })
      .filter(function (x) { return (!f.storeSlug || x.storeSlug === f.storeSlug) && (!f.orderId || x.orderId === f.orderId)
        && (!f.communicationType || (f.communicationType === 'call' ? x.calls > 0 : (x[f.communicationType] || 0) > 0)); })
      .sort(function (a, b) { return (b.lastAt || 0) - (a.lastAt || 0); });
    var scopedList = scoped(v, list, function (x) { return x.storeSlug; });
    var cols = [col('orderId', 'الطلب', 'Order'), col('storeSlug', 'المتجر', 'Store'), col('currentDriver', 'السائق الحالي', 'Current driver'),
      col('participants', 'المشاركون', 'Participants'), col('messages', 'الرسائل', 'Messages'), col('text', 'نصية', 'Text'),
      col('image', 'صور', 'Images'), col('voice', 'صوتية', 'Voice'), col('calls', 'المكالمات', 'Calls'),
      col('driverChanges', 'تغيّر السائق', 'Driver changes'), col('openedAt', 'بدأت', 'Opened'), col('lastAt', 'آخر رسالة', 'Last message'),
      col('closedAt', 'أُغلقت', 'Closed'), col('state', 'الحالة', 'State')];
    var sum = function (k) { return scopedList.reduce(function (a, x) { return a + (x[k] || 0); }, 0); };
    var summary = [stat('conversations', 'المحادثات', 'Conversations', scopedList.length, 'RAFDriverCommunication.list'),
      stat('messages', 'الرسائل', 'Messages', sum('messages'), "'communication_messages' counts"),
      stat('calls', 'المكالمات', 'Calls', sum('calls'), "'communication_events'"),
      stat('active', 'نشطة', 'Active', scopedList.filter(function (x) { return x.state === 'active'; }).length, 'conversation state')];
    return finish('communication', v, p, f, cols, scopedList, summary,
      [T('أعداد فقط — لا يعرض هذا التقرير نص أي رسالة.', 'Counts only — this report never shows any message content.')]);
  }

  /* ═════════════════ COMPENSATION / FINANCIAL OPERATIONS ═════════════════ */
  function compensationReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var n = normalise(filters, ['period', 'storeSlug', 'orderId', 'customerId', 'status', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    if (!global.RAFCompensation) return fail('SOURCE_UNAVAILABLE', { source:'RAFCompensation' });
    var r = RAFCompensation.list();                                  /* its own management gate decides */
    if (!r.ok) return r;
    var f = n.filters;
    var list = scoped(v, r.compensations, function (x) { return x.storeSlug; })
      .filter(function (x) { return inP(x.issuedAt, p); })            /* ISSUED time */
      .filter(function (x) { return (!f.storeSlug || x.storeSlug === f.storeSlug) && (!f.orderId || x.orderId === f.orderId)
        && (!f.customerId || x.customerId === f.customerId) && (!f.status || x.status === f.status); })
      .sort(function (a, b) { return b.issuedAt - a.issuedAt; })
      .map(function (x) {
        return { compensationId:x.compensationId, orderId:x.orderId, storeSlug:x.storeSlug, customerId:x.customerId,
                 promisedEtaAt:x.promisedEtaAt, deliveredAt:x.deliveredAt,
                 actualDelayMinutes:x.actualDelayMinutes, eligibleDelayMinutes:x.eligibleDelayMinutes,
                 blocks:x.completedBlocks, amount:x.amount, status:x.status,
                 inWallet:x.wallet && x.wallet.added ? 'yes' : 'no',
                 walletRemaining:x.wallet && x.wallet.added ? x.wallet.remaining : null,
                 issuedAt:x.issuedAt, expiresAt:x.expiresAt };
      });
    var cols = [col('compensationId', 'رقم التعويض', 'Compensation'), col('orderId', 'الطلب', 'Order'), col('storeSlug', 'المتجر', 'Store'),
      col('customerId', 'العميل', 'Customer'), col('promisedEtaAt', 'الوقت الموعود', 'Promised ETA'), col('deliveredAt', 'التسليم', 'Delivered'),
      col('actualDelayMinutes', 'التأخير الفعلي (د)', 'Actual delay (min)'), col('eligibleDelayMinutes', 'التأخير المؤهل (د)', 'Eligible delay (min)'),
      col('blocks', 'الخطوات', 'Completed steps'), col('amount', 'القيمة (د.ك)', 'Amount (KWD)'), col('status', 'الحالة', 'Status'),
      col('inWallet', 'في المحفظة', 'In wallet'), col('walletRemaining', 'المتبقي', 'Remaining'),
      col('issuedAt', 'وقت الإصدار', 'Issued'), col('expiresAt', 'انتهاء الصلاحية', 'Expires')];
    var fils = function (s) { return Math.round(parseFloat(s || '0') * 1000); };
    var total = list.reduce(function (a, x) { return a + fils(x.amount); }, 0);
    var enabled = global.RAFConfig ? RAFConfig.value('compensation.enabled') : null;
    var byStatus = {}; list.forEach(function (x) { byStatus[x.status] = (byStatus[x.status] || 0) + 1; });
    var summary = [stat('issued', 'تعويضات صادرة', 'Compensations issued', list.length, 'RAFCompensation records'),
      stat('amount', 'إجمالي القيمة (د.ك)', 'Total amount (KWD)', (total / 1000).toFixed(3), 'sum of the issued amounts'),
      stat('inWallet', 'أُضيفت للمحفظة', 'Added to wallet', list.filter(function (x) { return x.inWallet === 'yes'; }).length, 'RAFWallet lot via RAFCompensation'),
      stat('voided', 'مُبطلة', 'Voided', byStatus.voided || 0, 'compensation status'),
      stat('reversed', 'معكوسة', 'Reversed', byStatus.reversed || 0, 'compensation status'),
      stat('expired', 'منتهية', 'Expired', byStatus.expired || 0, 'compensation status'),
      stat('feature', 'حالة الميزة', 'Feature state', enabled === true ? 'ON' : (enabled === false ? 'OFF' : NC), "RAFConfig 'compensation.enabled'", enabled == null ? 'NOT_CONFIGURED' : null)];
    return finish('compensation', v, p, f, cols, list, summary,
      [T('الفترة تُطبَّق على وقت إصدار التعويض. القيم كما أصدرتها RAFCompensation ولا تُعاد حسابتها هنا.',
         'The period filters on the issue time. Amounts are as RAFCompensation issued them and are never recalculated here.')]);
  }

  /* ═════════════════ AUDIT / ACTIVITY ═════════════════ */
  function auditReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var n = normalise(filters, ['period', 'storeSlug', 'orderId', 'action', 'employeeId', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    /* both gates: the Reports Center operational gate AND RAFAudit's own rule.
       RAFAudit.canViewAudit keeps its existing meaning for every other surface. */
    var g = needsOperational(v, 'audit'); if (!g.ok) return g;
    if (!global.RAFAudit || !RAFAudit.canViewAudit || !RAFAudit.canViewAudit()) return fail('FORBIDDEN');
    var f = n.filters;
    var q = { since:p.start };
    if (v.storeBound) q.storeSlug = v.storeSlug; else if (f.storeSlug) q.storeSlug = f.storeSlug;
    if (f.orderId) q.orderId = f.orderId;
    if (f.action) q.action = f.action;
    var list = RAFAudit.query(q)
      .filter(function (e) { return inP(e.timestamp, p); })          /* the EVENT's own time */
      .filter(function (e) { return !f.employeeId || e.actorId === f.employeeId; })
      .map(function (e) {
        return { timestamp:e.timestamp, action:e.action, actor:e.actorName || e.actorId || null, actorType:e.actorType,
                 orderId:e.orderId || null, storeSlug:e.storeSlug || null,
                 previousState:e.previousState == null ? null : String(e.previousState), newState:e.newState == null ? null : String(e.newState),
                 reason:e.reason || null, source:e.source || null,
                 automatic:e.automatic ? 'yes' : 'no', systemGenerated:e.systemGenerated ? 'yes' : 'no',
                 reversible:e.reversible == null ? null : (e.reversible ? 'yes' : 'no'),
                 undoOf:(e.metadata && e.metadata.of) || null, undone:e.undone ? 'yes' : 'no' };
      })
      .sort(function (a, b) { return b.timestamp - a.timestamp; });
    var cols = [col('timestamp', 'الوقت', 'Timestamp'), col('action', 'الإجراء', 'Action'), col('actor', 'المنفّذ', 'Actor'),
      col('actorType', 'نوع المنفّذ', 'Actor type'), col('orderId', 'الطلب', 'Order'), col('storeSlug', 'المتجر', 'Store'),
      col('previousState', 'الحالة السابقة', 'Previous state'), col('newState', 'الحالة الجديدة', 'New state'),
      col('reason', 'السبب', 'Reason'), col('source', 'المصدر', 'Source'), col('automatic', 'تلقائي', 'Automatic'),
      col('systemGenerated', 'من النظام', 'System generated'), col('reversible', 'قابل للتراجع', 'Reversible'),
      col('undoOf', 'تراجع عن', 'Undo of'), col('undone', 'تم التراجع', 'Undone')];
    var byType = {}; list.forEach(function (e) { byType[e.actorType] = (byType[e.actorType] || 0) + 1; });
    var summary = [stat('events', 'الأحداث', 'Events', list.length, 'RAFAudit.query'),
      stat('automatic', 'تلقائية', 'Automatic', list.filter(function (e) { return e.automatic === 'yes'; }).length, 'audit.automatic'),
      stat('actors', 'أنواع المنفّذين', 'Actor types', Object.keys(byType).map(function (k) { return k + ': ' + byType[k]; }).join(' · ') || NA, 'audit.actorType'),
      stat('orders', 'طلبات متأثرة', 'Orders touched', Object.keys(list.reduce(function (a, e) { if (e.orderId) a[e.orderId] = 1; return a; }, {})).length, 'audit.orderId')];
    return finish('audit', v, p, f, cols, list, summary,
      [T('سجل غير قابل للتعديل؛ هذا التقرير يقرأ فقط.', 'An append-only log; this report only reads it.')]);
  }

  /* ═════════════════ OVERVIEW ═════════════════ */
  function overviewReport(filters){
    var v = viewer(); if (!v.ok) return v;
    var g = needsOperational(v, 'overview'); if (!g.ok) return g;
    var n = normalise(filters, ['period', 'storeSlug', 'search']); if (!n.ok) return n;
    var p = periodOf((filters || {}).period); if (!p.ok) return p;
    var f = n.filters;
    var ords = scoped(v, orders().map(orderFacts), function (x) { return x.storeSlug; })
      .filter(function (x) { return !f.storeSlug || x.storeSlug === f.storeSlug; });
    var placed = ords.filter(function (x) { return inP(x.placedAt, p); });
    var delivered = ords.filter(function (x) { return inP(x.deliveredAt, p); });
    var cancelled = placed.filter(function (x) { return x.status === 'cancelled'; });
    var live = ords.filter(function (x) { return x.status !== 'delivered' && x.status !== 'cancelled' && (x.readyAt || x.assignedAt); });
    var moves = rows('ownership').filter(function (r) { return inP(r.at, p); });
    var lines = [
      stat('orders', 'الطلبات (أُنشئت في الفترة)', 'Orders placed', placed.length, 'RAFShop.Orders snapshot checkoutAt'),
      stat('delivered', 'تم تسليمها في الفترة', 'Delivered in period', delivered.length, 'RAFOrderEngine.deliveredAt'),
      stat('cancelled', 'ملغاة', 'Cancelled', cancelled.length, 'order.status'),
      stat('activeDeliveries', 'توصيلات جارية', 'Active deliveries', live.length, 'order status + fulfilment'),
      stat('unassigned', 'بانتظار سائق', 'Unassigned', live.filter(function (x) { return !x.driverId; }).length, 'fulfilment.driverId'),
      stat('assigned', 'لدى سائق', 'Assigned', live.filter(function (x) { return !!x.driverId; }).length, 'fulfilment.driverId'),
      stat('reassignments', 'إعادة الإسناد', 'Reassignments', moves.filter(function (r) { return r.kind === 'reassignment'; }).length, "ownership 'reassignment'"),
      stat('poolReturns', 'إرجاع للقائمة', 'Returns to pool', moves.filter(function (r) { return r.kind === 'returned_to_pool'; }).length, "ownership 'returned_to_pool'")
    ];
    /* each remaining block is asked of its own authority; a refusal is reported,
       never replaced by a number */
    var exR = null; try { exR = global.RAFDeliveryOps ? RAFDeliveryOps.exceptions.list({}) : null; } catch (e) {}
    if (exR && exR.ok) {
      var exs = scoped(v, exR.exceptions, function (x) { return x.storeSlug; }).filter(function (x) { return inP(x.openedAt, p); });
      lines.push(stat('exceptions', 'الاستثناءات (فُتحت في الفترة)', 'Exceptions opened', exs.length, 'RAFDeliveryOps.exceptions'),
        stat('openExceptions', 'مفتوحة الآن', 'Open now', exs.filter(function (x) { return x.status !== 'closed'; }).length, 'exception status'),
        stat('slaApproaching', 'SLA يقترب', 'SLA approaching', exs.filter(function (x) { return x.sla && x.sla.state === 'approaching'; }).length, 'RAFDeliveryOps SLA'),
        stat('slaBreached', 'SLA مُخترق', 'SLA breached', exs.filter(function (x) { return x.sla && x.sla.state === 'breached'; }).length, 'RAFDeliveryOps SLA'));
    } else lines.push(stat('exceptions', 'الاستثناءات', 'Exceptions', NA, 'RAFDeliveryOps.exceptions', 'NOT_AVAILABLE'));
    var avR = null; try { avR = global.RAFDriverManagement ? RAFDriverManagement.availability.list() : null; } catch (e) {}
    if (avR && avR.ok) {
      var ds = avR.drivers || [];
      lines.push(stat('driversAvailable', 'سائقون متاحون', 'Drivers available', ds.filter(function (d) { return d.availability && d.availability.state === 'available'; }).length, 'RAFDriverManagement.availability'),
        stat('driversUnavailable', 'غير متاحين', 'Unavailable', ds.filter(function (d) { return d.availability && d.availability.state !== 'available'; }).length, 'RAFDriverManagement.availability'));
    } else lines.push(stat('driverAvailability', 'توفر السائقين', 'Driver availability', NA, 'RAFDriverManagement.availability', 'NOT_AVAILABLE'));
    var cmpR = null; try { cmpR = global.RAFCompensation ? RAFCompensation.list() : null; } catch (e) {}
    if (cmpR && cmpR.ok) {
      var cs = scoped(v, cmpR.compensations, function (x) { return x.storeSlug; }).filter(function (x) { return inP(x.issuedAt, p); });
      var fils = cs.reduce(function (a, x) { return a + Math.round(parseFloat(x.amount || '0') * 1000); }, 0);
      lines.push(stat('compensations', 'تعويضات صادرة', 'Compensations issued', cs.length, 'RAFCompensation'),
        stat('compensationAmount', 'قيمة التعويضات (د.ك)', 'Compensation amount (KWD)', (fils / 1000).toFixed(3), 'RAFCompensation amounts'));
    } else {
      var enabled = global.RAFConfig ? RAFConfig.value('compensation.enabled') : null;
      lines.push(stat('compensations', 'تعويضات صادرة', 'Compensations issued', enabled === false ? 'OFF' : NA, 'RAFCompensation', enabled === false ? 'OFF' : 'NOT_AVAILABLE'));
    }
    var cols = [col('metric', 'المؤشر', 'Metric'), col('value', 'القيمة', 'Value'), col('source', 'المصدر', 'Source')];
    var list = lines.map(function (s) {
      return { metric:T(s.ar, s.en), value:s.state ? s.state : (s.value && s.value.notAvailable ? 'NOT_AVAILABLE' : (s.value && s.value.notConfigured ? 'NOT_CONFIGURED' : s.value)), source:s.source };
    });
    return finish('overview', v, p, f, cols, list, lines, [T('كل رقم مذكور مصدره. ما لا يمكن اشتقاقه يظهر كـ NOT_AVAILABLE أو NOT_CONFIGURED.',
      'Every figure names its source. What cannot be derived is shown as NOT_AVAILABLE or NOT_CONFIGURED.')]);
  }

  /* ---------- catalogue + dispatcher ---------- */
  var REPORTS = [
    { id:'overview',      ar:'نظرة عامة',           en:'Overview',              fn:overviewReport },
    { id:'orders',        ar:'الطلبات',             en:'Orders',                fn:ordersReport },
    { id:'deliveries',    ar:'التوصيلات',           en:'Deliveries',            fn:deliveriesReport },
    { id:'drivers',       ar:'السائقون',            en:'Drivers',               fn:function (f) { return driverRows(f, 'drivers'); } },
    { id:'exceptions',    ar:'الاستثناءات و SLA',   en:'Exceptions & SLA',      fn:exceptionsReport },
    { id:'reassignments', ar:'إعادة الإسناد',       en:'Reassignments',         fn:reassignmentsReport },
    { id:'performance',   ar:'الأداء',              en:'Performance',           fn:function (f) { return driverRows(f, 'performance'); } },
    { id:'communication', ar:'التواصل',             en:'Communication',         fn:communicationReport },
    { id:'compensation',  ar:'التعويضات',           en:'Compensation',          fn:compensationReport },
    { id:'audit',         ar:'السجل والنشاط',       en:'Audit / Activity',      fn:auditReport }
  ];
  function run(reportId, filters){
    var d = REPORTS.filter(function (r) { return r.id === reportId; })[0];
    if (!d) return fail('UNKNOWN_REPORT', { reportId:reportId });
    return d.fn(filters);
  }
  /* CSV of exactly the rows and columns the caller was allowed to read */
  function csv(result){
    if (!result || !result.ok) return fail('FORBIDDEN');
    if (!result.canExport) return fail('FORBIDDEN', { needs:[PERM_EXPORT] });
    var en = isEn();
    var cell = function (x) {
      if (x == null) return '';
      var s = String(x);
      return /[",\n;]/.test(s) ? '"' + s.split('"').join('""') + '"' : s;
    };
    var head = result.columns.map(function (c) { return cell(en ? c.en : c.ar); }).join(',');
    var body = result.rows.map(function (r) { return result.columns.map(function (c) { return cell(r[c.key]); }).join(','); });
    return { ok:true, filename:'raf-' + result.reportId + '-' + new Date(result.generatedAt).toISOString().slice(0, 10) + '.csv',
             csv: [head].concat(body).join('\r\n'), rows:result.rows.length };
  }

  global.RAFReports = {
    ERRORS:ERRORS, FILTER_KEYS:FILTER_KEYS.slice(),
    REPORTS:REPORTS.map(function (r) { return { id:r.id, ar:r.ar, en:r.en }; }),
    viewer:function () { var v = viewer(); return v.ok ? { ok:true, storeSlug:v.storeSlug, storeBound:v.storeBound, canExport:v.canExport } : v; },
    run:run, csv:csv,
    overview:overviewReport, orders:ordersReport, deliveries:deliveriesReport,
    drivers:function (f) { return driverRows(f, 'drivers'); }, exceptions:exceptionsReport,
    reassignments:reassignmentsReport, performance:function (f) { return driverRows(f, 'performance'); },
    communication:communicationReport, compensation:compensationReport, audit:auditReport
  };
})(window);
