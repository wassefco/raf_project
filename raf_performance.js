/* ============================================================================
 * RAF Marketplace — RAF-WIDE PERFORMANCE  (RAFPerformance, shared) — Phase K
 * ----------------------------------------------------------------------------
 * A READ-ONLY measurement layer over the authorities that already own the
 * facts. It owns no record, writes nothing of its own, defines no business
 * rule, and never re-implements a calculation an authority already performs.
 *
 *   RAFPerformance.run(viewId, filters)   → the view (also per-view methods)
 *   RAFPerformance.VIEWS                  → the catalogue
 *   RAFPerformance.csv(result)            → delegates to RAFReports.csv
 *
 * WHAT IT IS NOT
 *   · not a second driver-performance engine — driver claims, deliveries,
 *     skips, reassignment requests, exceptions, working hours, overtime and
 *     total rating all come from RAFDriverPerformance, unchanged;
 *   · not an SLA engine — RAFDeliveryOps owns exception lifecycle and SLA;
 *   · not a compensation engine — RAFCompensation owns every amount;
 *   · not a ranking system — there is no score, rank, tier, target, leaderboard
 *     or evaluative label anywhere. Rows are ordered by name or by time only,
 *     and every figure is a descriptive measurement of recorded events.
 *
 * SOURCES — read through the authorities, not raw storage:
 *   RAFReports (the Phase J projection: orders, deliveries, exceptions,
 *   reassignments, communication, compensation, drivers) · RAFDriverPerformance
 *   (all driver metrics) · RAFDeliveryOps.exceptions · RAFDriverManagement
 *   .availability · RAFDriverRating · RAFCompensation · RAFOrderEngine
 *   milestones · RAFOrderSnapshot (incl. the immutable recorded `promise`).
 *
 * AUTHORISATION — existing keys only, no new key and no new role. A caller
 * must hold the SAME existing management set the Logistics surfaces and the
 * Reports Center already require: `reports.view` + `orders.view` +
 * `drivers.view` (Operations Manager, Higher Management, Super Admin). Finance,
 * Marketing, Customer Service, merchants, merchant employees, drivers,
 * customers and anonymous callers are refused by the authority itself — not by
 * hiding navigation — and a refused call returns no rows at all. A store-bound
 * account never reaches data: it lacks `drivers.view`, so store isolation holds
 * by construction (and any scoped caller is still filtered to its own store).
 *
 * TIME — periods (Today / Week / Month / Custom) come from
 * RAFDriverPerformance.periodOf, so RAF keeps ONE period implementation in the
 * configured timezone. Every metric states the timestamp it measures and never
 * substitutes another. The Promised ETA is the IMMUTABLE value recorded on the
 * snapshot at merchant acceptance; an order without a recorded promise is
 * excluded from ETA-based rates and counted separately as "not recorded" —
 * never derived from today's configuration, never backfilled.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFPerformance) return;

  var PERM_VIEW = 'reports.view', PERM_ORDERS = 'orders.view', PERM_DRIVERS = 'drivers.view', PERM_EXPORT = 'reports.export';

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية على أداء رف.',        en:'You do not have access to RAF performance.' },
    ACTOR_INACTIVE:     { ar:'حسابك غير نشط.',                       en:'Your account is not active.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',  en:'The request contains fields that are not accepted.' },
    UNKNOWN_VIEW:       { ar:'العرض غير معروف.',                     en:'Unknown view.' },
    PERIOD_INVALID:     { ar:'الفترة غير صالحة.',                    en:'The period is not valid.' },
    SOURCE_UNAVAILABLE: { ar:'مصدر البيانات غير متاح.',              en:'The data source is not available.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' }, r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  var NA = { notAvailable:true }, NC = { notConfigured:true };

  /* ---------- access: the existing management set, nothing new ---------- */
  function viewer(){
    var u = null; try { u = RAFPerm.currentUser(); } catch (e) {}
    if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var can = function (k) { try { return !!RAFPerm.can(u.id, k); } catch (e) { return false; } };
    if (!(can(PERM_VIEW) && can(PERM_ORDERS) && can(PERM_DRIVERS)))
      return fail('FORBIDDEN', { needs:[PERM_VIEW, PERM_ORDERS, PERM_DRIVERS] });
    var linked = null; try { linked = RAFPerm.storeSlugOf(u.id) || null; } catch (e) {}
    var storeBound = u.accountType === 'merchant';
    return { ok:true, id:u.id, name:u.name, roleId:u.roleId,
             storeSlug:storeBound ? linked : null, storeBound:storeBound, canExport:can(PERM_EXPORT) };
  }
  function periodOf(spec){
    var P = global.RAFDriverPerformance;
    if (!P || !P.periodOf) return fail('SOURCE_UNAVAILABLE', { source:'RAFDriverPerformance.periodOf' });
    var p = P.periodOf(spec || { preset:'today' });
    return p.ok ? p : fail('PERIOD_INVALID');
  }
  /* the Phase J projection does the authorised row reading for us */
  function report(id, filters){
    if (!global.RAFReports) return fail('SOURCE_UNAVAILABLE', { source:'RAFReports' });
    return RAFReports.run(id, filters);
  }

  /* ---------- descriptive statistics (mathematics, not business rules) ---------- */
  function mins(ms){ return ms == null ? null : Math.round(ms / 60000); }
  function stats(values){
    var v = values.filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (a, b) { return a - b; });
    if (!v.length) return { count:0, average:null, median:null, min:null, max:null };
    var sum = v.reduce(function (a, b) { return a + b; }, 0), mid = Math.floor(v.length / 2);
    return { count:v.length, average:Math.round(sum / v.length), median:v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2),
             min:v[0], max:v[v.length - 1] };
  }
  function pct(n, d){ return (typeof n === 'number' && typeof d === 'number' && d > 0) ? Math.round((n / d) * 1000) / 10 : null; }
  function col(key, ar, en){ return { key:key, ar:ar, en:en }; }
  function stat(key, ar, en, value, source, state){ return { key:key, ar:ar, en:en, value:value, source:source, state:state || null }; }
  function metricRow(ar, en, value, source, denominator){
    return { metric:T(ar, en), value:value == null ? 'NOT_AVAILABLE' : (value && value.notAvailable ? 'NOT_AVAILABLE' : (value && value.notConfigured ? 'NOT_CONFIGURED' : value)),
             source:source, denominator:denominator || '—' };
  }
  var METRIC_COLS = [col('metric', 'المقياس', 'Measurement'), col('value', 'القيمة', 'Value'),
                     col('source', 'المصدر', 'Source'), col('denominator', 'المقام', 'Denominator')];
  function finish(viewId, v, p, filters, columns, rows, summary, notes){
    return { ok:true, reportId:'performance-' + viewId, viewId:viewId, period:p, filters:filters || {},
             scope:{ storeSlug:v.storeSlug, storeBound:v.storeBound },
             columns:columns, rows:rows, count:rows.length, summary:summary || [], notes:notes || [],
             canExport:v.canExport, generatedAt:Date.now() };
  }
  function prep(filters, allowed){
    var v = viewer(); if (!v.ok) return v;
    filters = filters || {};
    if (!onlyKeys(filters, ['period'].concat(allowed))) return fail('FIELD_NOT_ACCEPTED');
    var p = periodOf(filters.period); if (!p.ok) return p;
    var f = {}; allowed.forEach(function (k) { if (filters[k] != null && filters[k] !== '' && filters[k] !== 'all') f[k] = String(filters[k]); });
    return { ok:true, v:v, p:p, f:f, period:filters.period || { preset:'today' } };
  }
  /* pass only the filters a given report accepts */
  function pick(f, keys, period){
    var out = { period:period };
    keys.forEach(function (k) { if (f[k]) out[k] = f[k]; });
    return out;
  }

  /* ═══════════ ORDER FLOW (every duration from its own two timestamps) ═══════════ */
  function flowOf(rows){
    var d = { placedToAccepted:[], acceptedToReady:[], readyToAssigned:[], assignedToPickup:[], pickupToDelivered:[], placedToDelivered:[] };
    rows.forEach(function (r) {
      if (r.placedAt && r.acceptedAt) d.placedToAccepted.push(r.acceptedAt - r.placedAt);
      if (r.acceptedAt && r.readyAt) d.acceptedToReady.push(r.readyAt - r.acceptedAt);
      if (r.readyAt && r.assignedAt) d.readyToAssigned.push(r.assignedAt - r.readyAt);
      if (r.assignedAt && r.pickedUpAt) d.assignedToPickup.push(r.pickedUpAt - r.assignedAt);
      if (r.pickedUpAt && r.deliveredAt) d.pickupToDelivered.push(r.deliveredAt - r.pickedUpAt);
      if (r.placedAt && r.deliveredAt) d.placedToDelivered.push(r.deliveredAt - r.placedAt);
    });
    return d;
  }
  function ordersView(filters){
    var s = prep(filters, ['storeSlug', 'status', 'driverId', 'orderId']); if (!s.ok) return s;
    var ord = report('orders', pick(s.f, ['storeSlug', 'status', 'driverId', 'orderId'], s.period)); if (!ord.ok) return ord;
    var del = report('deliveries', pick(s.f, ['storeSlug', 'driverId', 'orderId'], s.period));
    var rows = ord.rows;
    /* the deliveries projection carries the IMMUTABLE recorded promise and the
       delay measured against it; orders are matched to it by id */
    var byId = {}; if (del.ok) del.rows.forEach(function (r) { byId[r.orderId] = r; });
    var enriched = rows.map(function (r) {
      var d = byId[r.orderId] || {};
      return { placedAt:r.placedAt, acceptedAt:r.acceptedAt, readyAt:r.readyAt, assignedAt:d.assignedAt || null,
               pickedUpAt:r.pickedUpAt, deliveredAt:r.deliveredAt, status:r.status,
               promisedEtaAt:d.promisedEtaAt != null ? d.promisedEtaAt : r.promisedEtaAt,
               delayMinutes:d.delayMinutes };
    });
    var delivered = enriched.filter(function (r) { return r.deliveredAt != null; });
    var withPromise = delivered.filter(function (r) { return r.promisedEtaAt != null; });
    var noPromise = delivered.length - withPromise.length;
    var onTime = withPromise.filter(function (r) { return r.deliveredAt <= r.promisedEtaAt; }).length;
    var late = withPromise.length - onTime;
    var accepted = enriched.filter(function (r) { return r.acceptedAt != null; }).length;
    var cancelled = enriched.filter(function (r) { return r.status === 'cancelled'; }).length;
    var f = flowOf(enriched);
    var st = function (k) { return stats(f[k].map(mins)); };
    var line = function (ar, en, key, src) {
      var x = st(key);
      return metricRow(ar, en, x.count ? T('وسيط ', 'median ') + x.median + T(' د · متوسط ', ' min · average ') + x.average + T(' د', ' min') : NA,
        src, x.count + T(' طلب لهما الطابعان الزمنيان', ' orders with both timestamps'));
    };
    var rowsOut = [
      metricRow('حجم الطلبات (أُنشئت في الفترة)', 'Order volume (placed in period)', enriched.length, 'RAFReports.orders → RAFShop snapshot checkoutAt', T('كل الطلبات في الفترة', 'all orders in the period')),
      metricRow('طلبات قبِلها المتجر', 'Orders accepted by the merchant', accepted, 'RAFOrderEngine order.accept milestone', T('كل الطلبات في الفترة', 'all orders in the period')),
      metricRow('نسبة القبول', 'Acceptance rate', pct(accepted, enriched.length) == null ? NA : pct(accepted, enriched.length) + '%', 'accepted ÷ placed', T('الطلبات المُنشأة في الفترة = ', 'orders placed in the period = ') + enriched.length),
      metricRow('طلبات مُلغاة', 'Cancelled orders', cancelled, 'order.status', T('كل الطلبات في الفترة', 'all orders in the period')),
      metricRow('نسبة الإلغاء', 'Cancellation rate', pct(cancelled, enriched.length) == null ? NA : pct(cancelled, enriched.length) + '%', 'cancelled ÷ placed', T('الطلبات المُنشأة في الفترة = ', 'orders placed in the period = ') + enriched.length),
      line('من الإنشاء إلى القبول', 'Placed → accepted', 'placedToAccepted', 'checkoutAt → order.accept'),
      line('من القبول إلى الجاهزية', 'Accepted → ready', 'acceptedToReady', 'order.accept → order.ready'),
      line('من الجاهزية إلى الإسناد', 'Ready → assignment', 'readyToAssigned', 'order.ready → fulfilment.assignedAt'),
      line('من الإسناد إلى الاستلام', 'Assignment → pickup', 'assignedToPickup', 'assignedAt → pickedUpAt'),
      line('من الاستلام إلى التسليم', 'Pickup → delivered', 'pickupToDelivered', 'pickedUpAt → driver.delivered'),
      line('من الإنشاء إلى التسليم', 'Placed → delivered', 'placedToDelivered', 'checkoutAt → driver.delivered'),
      metricRow('سُلّمت ضمن الوقت الموعود', 'Delivered within the Promised ETA', onTime, 'deliveredAt ≤ recorded promise', T('التوصيلات المسلَّمة ولها وقت موعود مسجَّل = ', 'delivered orders WITH a recorded promise = ') + withPromise.length),
      metricRow('سُلّمت متأخرة', 'Delivered late', late, 'deliveredAt > recorded promise', T('التوصيلات المسلَّمة ولها وقت موعود مسجَّل = ', 'delivered orders WITH a recorded promise = ') + withPromise.length),
      metricRow('نسبة الالتزام بالوقت الموعود', 'On-time rate', pct(onTime, withPromise.length) == null ? NA : pct(onTime, withPromise.length) + '%', 'on time ÷ delivered with a recorded promise', T('التوصيلات المسلَّمة ولها وقت موعود مسجَّل = ', 'delivered orders WITH a recorded promise = ') + withPromise.length),
      metricRow('مسلَّمة بلا وقت موعود مسجَّل (مستثناة)', 'Delivered without a recorded promise (excluded)', noPromise, 'RAFOrderSnapshot.promise absent', T('مستثناة من نِسب الوقت الموعود', 'excluded from every ETA rate'))
    ];
    var summary = [stat('orders', 'الطلبات', 'Orders', enriched.length, 'RAFReports.orders'),
      stat('delivered', 'مسلَّمة', 'Delivered', delivered.length, 'driver.delivered'),
      stat('onTimeRate', 'الالتزام بالوقت الموعود', 'On-time rate', pct(onTime, withPromise.length) == null ? NA : pct(onTime, withPromise.length) + '%', 'recorded promise only', pct(onTime, withPromise.length) == null ? 'NOT_AVAILABLE' : null),
      stat('cancelled', 'ملغاة', 'Cancelled', cancelled, 'order.status')];
    return finish('orders', s.v, s.p, s.f, METRIC_COLS, rowsOut, summary,
      [T('كل مدة تُقاس بين طابعيها الزمنيين فقط. نِسب الوقت الموعود تستخدم القيمة المسجَّلة غير القابلة للتغيير، وتستثني الطلبات التي لا وقت موعود مسجَّلًا لها.',
         'Each duration is measured between its own two timestamps only. ETA rates use the immutable recorded promise and exclude orders that have none recorded.')]);
  }

  /* ═══════════ MERCHANT OPERATIONS (descriptive, per store, by name) ═══════════ */
  function merchantsView(filters){
    var s = prep(filters, ['storeSlug']); if (!s.ok) return s;
    var ord = report('orders', pick(s.f, ['storeSlug'], s.period)); if (!ord.ok) return ord;
    var byStore = {};
    ord.rows.forEach(function (r) {
      var k = r.storeSlug || '—';
      var b = byStore[k] || (byStore[k] = { storeSlug:k, received:0, accepted:0, ready:0, cancelled:0, acceptMs:[], prepMs:[] });
      b.received++;
      if (r.acceptedAt) { b.accepted++; if (r.placedAt) b.acceptMs.push(r.acceptedAt - r.placedAt); }
      if (r.readyAt) { b.ready++; if (r.acceptedAt) b.prepMs.push(r.readyAt - r.acceptedAt); }
      if (r.status === 'cancelled') b.cancelled++;
    });
    var rows = Object.keys(byStore).sort().map(function (k) {      /* by store name — never a ranking */
      var b = byStore[k], a = stats(b.acceptMs.map(mins)), pr = stats(b.prepMs.map(mins));
      return { storeSlug:b.storeSlug, received:b.received, accepted:b.accepted,
               notAccepted:b.received - b.accepted, cancelled:b.cancelled,
               acceptanceRate:pct(b.accepted, b.received) == null ? 'NOT_AVAILABLE' : pct(b.accepted, b.received) + '%',
               medianAcceptMinutes:a.median == null ? 'NOT_AVAILABLE' : a.median,
               readyCount:b.ready, medianPrepMinutes:pr.median == null ? 'NOT_AVAILABLE' : pr.median };
    });
    var cols = [col('storeSlug', 'المتجر', 'Store'), col('received', 'طلبات مستلمة', 'Orders received'),
      col('accepted', 'مقبولة', 'Accepted'), col('notAccepted', 'غير مقبولة بعد', 'Not accepted'),
      col('acceptanceRate', 'نسبة القبول', 'Acceptance rate'), col('medianAcceptMinutes', 'وسيط زمن القبول (د)', 'Median accept (min)'),
      col('readyCount', 'أصبحت جاهزة', 'Became ready'), col('medianPrepMinutes', 'وسيط زمن التجهيز (د)', 'Median preparation (min)'),
      col('cancelled', 'ملغاة', 'Cancelled')];
    var summary = [stat('stores', 'المتاجر في الفترة', 'Stores in period', rows.length, 'snapshot storeSlug'),
      stat('orders', 'الطلبات', 'Orders', ord.rows.length, 'RAFReports.orders'),
      stat('rejections', 'أسباب الرفض', 'Rejection reasons', NA, 'no authoritative per-order rejection record is read here', 'NOT_AVAILABLE'),
      stat('outOfStock', 'نفاد المخزون', 'Out-of-stock events', NA, 'no operational out-of-stock record exists', 'NOT_AVAILABLE')];
    return finish('merchants', s.v, s.p, s.f, cols, rows, summary,
      [T('قياسات وصفية لكل متجر، مرتبة بالاسم. لا يوجد تقييم ولا ترتيب ولا درجة للمتجر. «غير مقبولة بعد» تشمل الطلبات التي لم تُقبل حتى الآن ولا تُنسب إلى المتجر كرفض.',
         'Descriptive per-store measurements, ordered by name. No merchant score, rating or ranking. “Not accepted” counts orders with no acceptance milestone and is not attributed to the merchant as a rejection.'),
       T('زمن التجهيز يُقاس من القبول إلى الجاهزية؛ لا يوجد وقت جاهزية متوقّع معتمد، فلا تُحسب أي نسبة «جاهز في الوقت».',
         'Preparation time is accepted → ready; no approved expected-ready time exists, so no “ready on time” rate is calculated.')]);
  }

  /* ═══════════ LOGISTICS ═══════════ */
  function logisticsView(filters){
    var s = prep(filters, ['storeSlug', 'driverId', 'orderId']); if (!s.ok) return s;
    var del = report('deliveries', pick(s.f, ['storeSlug', 'driverId', 'orderId'], s.period)); if (!del.ok) return del;
    var re = report('reassignments', pick(s.f, ['storeSlug', 'driverId', 'orderId'], s.period));
    var ex = report('exceptions', pick(s.f, ['storeSlug', 'driverId', 'orderId'], s.period));
    var rows = del.rows;
    var assigned = rows.filter(function (r) { return r.assignedAt != null; }).length;
    var pickedUp = rows.filter(function (r) { return r.pickedUpAt != null; }).length;
    var delivered = rows.filter(function (r) { return r.deliveredAt != null; }).length;
    var late = rows.filter(function (r) { return r.delayMinutes != null && r.delayMinutes > 0; });
    var delayStats = stats(late.map(function (r) { return r.delayMinutes; }));
    var penalty = rows.filter(function (r) { return r.penaltyRisk === 'yes'; }).length;
    var out = [
      metricRow('توصيلات في الفترة', 'Deliveries in period', rows.length, 'RAFReports.deliveries (delivered time, else assignment)', T('كل التوصيلات في الفترة', 'all deliveries in the period')),
      metricRow('أُسندت', 'Assigned', assigned, 'fulfilment.assignedAt', T('التوصيلات في الفترة = ', 'deliveries in the period = ') + rows.length),
      metricRow('بانتظار سائق', 'Waiting for a driver', rows.filter(function (r) { return r.assignedAt == null && r.deliveredAt == null; }).length, 'no assignedAt yet', T('التوصيلات في الفترة = ', 'deliveries in the period = ') + rows.length),
      metricRow('تم الاستلام', 'Picked up', pickedUp, 'fulfilment.pickedUpAt', T('التوصيلات في الفترة = ', 'deliveries in the period = ') + rows.length),
      metricRow('سُلّمت', 'Delivered', delivered, 'driver.delivered', T('التوصيلات في الفترة = ', 'deliveries in the period = ') + rows.length),
      metricRow('متأخرة عن الوقت الموعود', 'Later than the recorded promise', late.length, 'deliveredAt − recorded promise', T('المسلَّمة ولها وقت موعود مسجَّل', 'delivered with a recorded promise')),
      metricRow('مدة التأخير', 'Delay duration', delayStats.count ? T('وسيط ', 'median ') + delayStats.median + T(' د · أقصى ', ' min · max ') + delayStats.max + T(' د', ' min') : NA, 'delay minutes of late deliveries', delayStats.count + T(' توصيلة متأخرة', ' late deliveries')),
      metricRow('خطر الغرامة', 'Penalty-risk deliveries', ex.ok ? penalty : NA, 'RAFDeliveryOps penalty evaluation', T('التوصيلات في الفترة = ', 'deliveries in the period = ') + rows.length)
    ];
    if (re.ok) {
      var reass = re.rows.filter(function (r) { return r.kind === 'reassignment'; });
      var pool = re.rows.filter(function (r) { return r.kind === 'returned_to_pool'; });
      out.push(metricRow('إعادة إسناد', 'Reassignments', reass.length, "RAFDriver ownership 'reassignment'", T('أحداث إعادة الإسناد في الفترة', 'reassignment events in the period')),
        metricRow('إرجاع للقائمة', 'Returns to pool', pool.length, "ownership 'returned_to_pool'", T('أحداث الإرجاع في الفترة', 'pool-return events in the period')),
        metricRow('إرجاع بتصنيف أولوية', 'Returns classified Priority', pool.filter(function (r) { return String(r.poolClass || '').toLowerCase().indexOf('prior') > -1; }).length, 'pool classification on the record', T('أحداث الإرجاع = ', 'pool-return events = ') + pool.length));
    } else out.push(metricRow('إعادة الإسناد والإرجاع', 'Reassignments and pool returns', NA, 'RAFReports.reassignments: ' + re.code, '—'));
    if (ex.ok) {
      var open = ex.rows.filter(function (r) { return r.status !== 'closed'; }).length;
      out.push(metricRow('استثناءات فُتحت', 'Exceptions opened', ex.rows.length, 'RAFDeliveryOps.exceptions (opened time)', T('كل الاستثناءات في الفترة', 'all exceptions in the period')),
        metricRow('ما زالت مفتوحة', 'Still open', open, 'exception status', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + ex.rows.length),
        metricRow('SLA يقترب', 'SLA approaching', ex.rows.filter(function (r) { return r.slaState === 'approaching'; }).length, 'RAFDeliveryOps SLA state', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + ex.rows.length),
        metricRow('SLA مُخترق', 'SLA breached', ex.rows.filter(function (r) { return String(r.slaState || '').indexOf('breach') > -1; }).length, 'RAFDeliveryOps SLA state', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + ex.rows.length),
        metricRow('تصعيدات', 'Escalations', ex.rows.filter(function (r) { return !!r.escalation; }).length, 'exception escalation state', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + ex.rows.length));
    } else out.push(metricRow('الاستثناءات', 'Exceptions', NA, 'RAFReports.exceptions: ' + ex.code, '—'));
    var summary = [stat('deliveries', 'التوصيلات', 'Deliveries', rows.length, 'RAFReports.deliveries'),
      stat('delivered', 'سُلّمت', 'Delivered', delivered, 'driver.delivered'),
      stat('late', 'متأخرة', 'Late', late.length, 'vs the recorded promise'),
      stat('exceptions', 'استثناءات', 'Exceptions', ex.ok ? ex.rows.length : NA, 'RAFDeliveryOps', ex.ok ? null : 'NOT_AVAILABLE')];
    return finish('logistics', s.v, s.p, s.f, METRIC_COLS, out, summary,
      [T('الإسناد يدوي ومعتمد؛ لا يفترض هذا العرض أي إسناد تلقائي. الاستلام المكتمل يبقى مكتملًا بعد إعادة الإسناد ولا يُحتسب استلام ثانٍ.',
         'Dispatch is manual and approved; this view assumes no automatic assignment. A completed pickup stays completed after a reassignment and no second pickup is counted.')]);
  }

  /* ═══════════ DRIVERS (aggregate of RAFDriverPerformance, never recalculated) ═══════════ */
  function driversView(filters){
    var s = prep(filters, ['driverId']); if (!s.ok) return s;
    var d = report('drivers', pick(s.f, ['driverId'], s.period)); if (!d.ok) return d;
    var av = null; try { av = global.RAFDriverManagement ? RAFDriverManagement.availability.list() : null; } catch (e) {}
    var sum = function (k) { return d.rows.reduce(function (a, r) { return a + (typeof r[k] === 'number' ? r[k] : 0); }, 0); };
    var ratings = d.rows.filter(function (r) { return r.totalRating != null; });
    var rows = [
      metricRow('حسابات السائقين', 'Driver accounts', d.rows.length, 'RAFPerm driver accounts', T('كل حسابات السائقين', 'all driver accounts')),
      metricRow('نشطة', 'Active accounts', d.rows.filter(function (r) { return r.accountStatus === 'active'; }).length, 'account status', T('حسابات السائقين = ', 'driver accounts = ') + d.rows.length),
      metricRow('موقوفة', 'Suspended accounts', d.rows.filter(function (r) { return r.accountStatus !== 'active'; }).length, 'account status', T('حسابات السائقين = ', 'driver accounts = ') + d.rows.length),
      metricRow('متاحون الآن', 'Available now', av && av.ok ? (av.drivers || []).filter(function (x) { return x.availability && x.availability.state === 'available'; }).length : NA, 'RAFDriverManagement.availability', T('حالة لحظية، ليست خاصة بالفترة', 'a live state, not period-bound')),
      metricRow('غير متاحين الآن', 'Unavailable now', av && av.ok ? (av.drivers || []).filter(function (x) { return x.availability && x.availability.state !== 'available'; }).length : NA, 'RAFDriverManagement.availability', T('حالة لحظية، ليست خاصة بالفترة', 'a live state, not period-bound')),
      metricRow('السحب الناجح', 'Successful claims', sum('claims'), 'RAFDriverPerformance', T('مجموع كل السائقين في الفترة', 'sum over all drivers in the period')),
      metricRow('التوصيلات المكتملة', 'Completed deliveries', sum('deliveries'), 'RAFDriverPerformance', T('مجموع كل السائقين في الفترة', 'sum over all drivers in the period')),
      metricRow('التخطي', 'Skips', sum('skips'), 'RAFDriverPerformance', T('مجموع كل السائقين في الفترة', 'sum over all drivers in the period')),
      metricRow('طلبات إعادة الإسناد', 'Reassignment requests', sum('reassignmentRequests'), 'RAFDriverPerformance', T('مجموع كل السائقين في الفترة', 'sum over all drivers in the period')),
      metricRow('الاستثناءات المنسوبة للسائقين', 'Exceptions attributed to drivers', sum('exceptions'), 'RAFDriverPerformance', T('مجموع كل السائقين في الفترة', 'sum over all drivers in the period')),
      metricRow('ساعات العمل', 'Working time', sum('workingMinutes') + T(' د', ' min'), 'RAFDriverPerformance (availability sessions)', T('مجموع كل السائقين في الفترة', 'sum over all drivers in the period')),
      metricRow('العمل الإضافي', 'Overtime', sum('overtimeMinutes') + T(' د', ' min'), 'RAFDriverPerformance (overtime records)', T('مجموع كل السائقين في الفترة', 'sum over all drivers in the period')),
      metricRow('سائقون لديهم تقييم', 'Drivers with a rating', ratings.length, 'RAFDriverRating via RAFDriverPerformance', T('حسابات السائقين = ', 'driver accounts = ') + d.rows.length)
    ];
    var summary = [stat('drivers', 'السائقون', 'Drivers', d.rows.length, 'RAFPerm'),
      stat('claims', 'السحب', 'Claims', sum('claims'), 'RAFDriverPerformance'),
      stat('deliveries', 'التوصيلات', 'Deliveries', sum('deliveries'), 'RAFDriverPerformance'),
      stat('ratings', 'تقييمات', 'Ratings', sum('ratings'), 'RAFDriverRating')];
    return finish('drivers', s.v, s.p, s.f, METRIC_COLS, rows, summary,
      [T('كل أرقام السائقين من RAFDriverPerformance كما هي. لا يوجد ترتيب ولا درجة ولا هدف. التقييم الكلي يشمل كل الفترات لكل سائق.',
         'Every driver figure comes from RAFDriverPerformance unchanged. No ranking, score or target. A driver’s total rating is all-time.')]);
  }

  /* ═══════════ EXCEPTIONS & SLA ═══════════ */
  function exceptionsView(filters){
    var s = prep(filters, ['storeSlug', 'category', 'status', 'sla', 'driverId', 'orderId']); if (!s.ok) return s;
    var ex = report('exceptions', pick(s.f, ['storeSlug', 'category', 'status', 'sla', 'driverId', 'orderId'], s.period)); if (!ex.ok) return ex;
    var rows = ex.rows, resolution = stats(rows.map(function (r) { return r.resolutionMinutes; }));
    var by = function (key) { var m = {}; rows.forEach(function (r) { var k = r[key] == null ? '—' : String(r[key]); m[k] = (m[k] || 0) + 1; }); return m; };
    var fmtMap = function (m) { return Object.keys(m).sort().map(function (k) { return k + ': ' + m[k]; }).join(' · ') || '—'; };
    var out = [
      metricRow('إجمالي الاستثناءات', 'Total exceptions', rows.length, 'RAFDeliveryOps.exceptions (opened in period)', T('كل الاستثناءات في الفترة', 'all exceptions in the period')),
      metricRow('حسب الفئة', 'By category', fmtMap(by('category')), 'exception category', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + rows.length),
      metricRow('حسب الحالة', 'By status', fmtMap(by('status')), 'exception status', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + rows.length),
      metricRow('حسب المعالجة', 'By resolution', fmtMap(by('resolution')), 'resolutionType', T('الاستثناءات المغلقة', 'closed exceptions')),
      metricRow('SLA يقترب', 'SLA approaching', rows.filter(function (r) { return r.slaState === 'approaching'; }).length, 'RAFDeliveryOps SLA', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + rows.length),
      metricRow('SLA مُخترق', 'SLA breached', rows.filter(function (r) { return String(r.slaState || '').indexOf('breach') > -1; }).length, 'RAFDeliveryOps SLA', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + rows.length),
      metricRow('تصعيدات', 'Escalations', rows.filter(function (r) { return !!r.escalation; }).length, 'escalation state', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + rows.length),
      metricRow('أُعيد فتحها', 'Reopened', rows.filter(function (r) { return (r.reopenCount || 0) > 0; }).length, 'reopen count', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + rows.length),
      metricRow('أُغلقت تلقائيًا', 'Auto-closed', rows.filter(function (r) { return r.autoClosed === 'yes'; }).length, 'autoClosed flag', T('الاستثناءات المغلقة', 'closed exceptions')),
      metricRow('خطر الغرامة', 'Penalty risk', rows.filter(function (r) { return r.penaltyRisk === 'yes'; }).length, 'RAFDeliveryOps penalty evaluation', T('الاستثناءات في الفترة = ', 'exceptions in the period = ') + rows.length),
      metricRow('زمن المعالجة', 'Resolution time', resolution.count ? T('وسيط ', 'median ') + resolution.median + T(' د · متوسط ', ' min · average ') + resolution.average + T(' د', ' min') : NA,
        'closedAt − openedAt', resolution.count + T(' استثناء مغلق له طابعان زمنيان', ' closed exceptions with both timestamps')),
      metricRow('انتهت بإعادة إسناد', 'Resolved with a reassignment', rows.filter(function (r) { return r.resolution === 'reassign_driver' || r.resolution === 'return_to_pool'; }).length, 'resolutionType', T('الاستثناءات المغلقة', 'closed exceptions'))
    ];
    var summary = [stat('total', 'الاستثناءات', 'Exceptions', rows.length, 'RAFDeliveryOps'),
      stat('open', 'مفتوحة', 'Open', rows.filter(function (r) { return r.status !== 'closed'; }).length, 'exception status'),
      stat('breached', 'SLA مُخترق', 'SLA breached', rows.filter(function (r) { return String(r.slaState || '').indexOf('breach') > -1; }).length, 'RAFDeliveryOps SLA'),
      stat('resolution', 'وسيط المعالجة', 'Median resolution', resolution.median == null ? NA : resolution.median + T(' د', ' min'), 'closedAt − openedAt', resolution.median == null ? 'NOT_AVAILABLE' : null)];
    return finish('exceptions', s.v, s.p, s.f, METRIC_COLS, out, summary,
      [T('دورة حياة الاستثناء و SLA مملوكة لـ RAFDeliveryOps؛ هذا العرض يقرأ حالتها فقط. الأخذ أو القفل أو التصعيد لا يوقف عدّاد SLA.',
         'The exception lifecycle and SLA belong to RAFDeliveryOps; this view only reads their state. Taking, locking or escalating never pauses the SLA clock.')]);
  }

  /* ═══════════ REASSIGNMENTS ═══════════ */
  function reassignmentsView(filters){
    var s = prep(filters, ['storeSlug', 'driverId', 'orderId', 'reassignmentState']); if (!s.ok) return s;
    var re = report('reassignments', pick(s.f, ['storeSlug', 'driverId', 'orderId', 'reassignmentState'], s.period)); if (!re.ok) return re;
    var rows = re.rows;
    var reass = rows.filter(function (r) { return r.kind === 'reassignment'; });
    var pool = rows.filter(function (r) { return r.kind === 'returned_to_pool'; });
    var priority = pool.filter(function (r) { return String(r.poolClass || '').toLowerCase().indexOf('prior') > -1; }).length;
    var states = {}; rows.forEach(function (r) { if (r.requestState) states[r.requestState] = (states[r.requestState] || 0) + 1; });
    var decisionMs = rows.filter(function (r) { return r.decisionAt && (r.reassignedAt || r.returnedToPoolAt); })
      .map(function (r) { return Math.abs(r.decisionAt - (r.reassignedAt || r.returnedToPoolAt)); });
    var dstat = stats(decisionMs.map(mins));
    var reqSummary = re.summary.filter(function (x) { return x.key === 'requests' || x.key === 'requestStates'; });
    var out = [
      metricRow('إجمالي الأحداث', 'Total movement events', rows.length, "RAFDriver ownership history", T('أحداث إعادة الإسناد والإرجاع في الفترة', 'reassignment and pool-return events in the period')),
      metricRow('إعادة إسناد', 'Reassignments', reass.length, "ownership 'reassignment'", T('أحداث الحركة = ', 'movement events = ') + rows.length),
      metricRow('قبل الاستلام', 'Before pickup', rows.filter(function (r) { return r.beforeOrAfterPickup === 'before_pickup'; }).length, 'compared with fulfilment.pickedUpAt', T('أحداث الحركة = ', 'movement events = ') + rows.length),
      metricRow('بعد الاستلام', 'After pickup', rows.filter(function (r) { return r.beforeOrAfterPickup === 'after_pickup'; }).length, 'compared with fulfilment.pickedUpAt', T('أحداث الحركة = ', 'movement events = ') + rows.length),
      metricRow('إرجاع للقائمة', 'Returns to pool', pool.length, "ownership 'returned_to_pool'", T('أحداث الحركة = ', 'movement events = ') + rows.length),
      metricRow('إرجاع بتصنيف أولوية', 'Returns classified Priority', priority, 'pool classification on the record', T('أحداث الإرجاع = ', 'pool-return events = ') + pool.length),
      metricRow('إرجاع بتصنيف عادي', 'Returns classified Regular', pool.length - priority, 'pool classification on the record', T('أحداث الإرجاع = ', 'pool-return events = ') + pool.length),
      metricRow('طلبات السائقين', 'Driver requests', (reqSummary[0] && reqSummary[0].value) != null ? reqSummary[0].value : NA, "'reassignment_requests' submitted", T('الطلبات المقدَّمة في الفترة', 'requests submitted in the period')),
      metricRow('حالات الطلبات', 'Request outcomes', (reqSummary[1] && reqSummary[1].value) != null ? reqSummary[1].value + ' (' + T('معلّقة/ملغاة/مقبولة/مرفوضة', 'pending/cancelled/approved/rejected') + ')' : NA, 'request lifecycle', T('الطلبات المقدَّمة في الفترة', 'requests submitted in the period')),
      metricRow('من الطلب إلى القرار', 'Request → decision', dstat.count ? T('وسيط ', 'median ') + dstat.median + T(' د', ' min') : NA, 'decision time − movement time', dstat.count + T(' حركة لها قرار مسجَّل', ' movements with a recorded decision'))
    ];
    var summary = [stat('events', 'الأحداث', 'Events', rows.length, 'ownership history'),
      stat('reassignments', 'إعادة إسناد', 'Reassignments', reass.length, "ownership 'reassignment'"),
      stat('pool', 'إرجاع', 'Pool returns', pool.length, "ownership 'returned_to_pool'"),
      stat('afterPickup', 'بعد الاستلام', 'After pickup', rows.filter(function (r) { return r.beforeOrAfterPickup === 'after_pickup'; }).length, 'fulfilment.pickedUpAt')];
    return finish('reassignments', s.v, s.p, s.f, METRIC_COLS, out, summary,
      [T('الاستلام المكتمل يبقى مكتملًا: لا يُحتسب استلام ثانٍ بعد إعادة الإسناد، ويكمل السائق التالي مباشرة.',
         'A completed pickup stays completed: no second pickup is counted after a reassignment and the next driver continues directly.')]);
  }

  /* ═══════════ COMMUNICATION (metadata only) ═══════════ */
  function communicationView(filters){
    var s = prep(filters, ['storeSlug', 'orderId', 'communicationType']); if (!s.ok) return s;
    var cm = report('communication', pick(s.f, ['storeSlug', 'orderId', 'communicationType'], s.period)); if (!cm.ok) return cm;
    var rows = cm.rows, sum = function (k) { return rows.reduce(function (a, r) { return a + (r[k] || 0); }, 0); };
    var msgStats = stats(rows.map(function (r) { return r.messages; }));
    var spans = rows.filter(function (r) { return r.openedAt && r.lastAt; }).map(function (r) { return r.lastAt - r.openedAt; });
    var span = stats(spans.map(mins));
    var out = [
      metricRow('المحادثات', 'Conversations', rows.length, 'RAFDriverCommunication.list', T('المحادثات النشطة في الفترة', 'conversations active in the period')),
      metricRow('الرسائل', 'Messages', sum('messages'), 'communication message records (count only)', T('كل المحادثات في الفترة', 'all conversations in the period')),
      metricRow('نصية / صور / صوتية', 'Text / image / voice', sum('text') + ' / ' + sum('image') + ' / ' + sum('voice'), 'message type counts', T('كل الرسائل في الفترة', 'all messages in the period')),
      metricRow('المكالمات', 'Calls', sum('calls'), 'communication events', T('كل المحادثات في الفترة', 'all conversations in the period')),
      metricRow('رسائل لكل محادثة', 'Messages per conversation', msgStats.count ? T('وسيط ', 'median ') + msgStats.median + T(' · متوسط ', ' · average ') + msgStats.average : NA, 'message counts', rows.length + T(' محادثة', ' conversations')),
      metricRow('مدة المحادثة (أول→آخر رسالة)', 'Conversation span (first → last message)', span.count ? T('وسيط ', 'median ') + span.median + T(' د', ' min') : NA, 'openedAt → last message', span.count + T(' محادثة لها رسالتان على الأقل', ' conversations with recorded first and last messages')),
      metricRow('محادثات أُغلقت بعد التسليم', 'Conversations closed after delivery', rows.filter(function (r) { return r.state === 'closed'; }).length, 'conversation closed event (delivery closes it)', T('كل المحادثات في الفترة', 'all conversations in the period')),
      metricRow('استمرارية بعد تغيّر السائق', 'Continuity across driver changes', rows.filter(function (r) { return (r.driverChanges || 0) > 0; }).length, 'driver transferred / assigned / released events', T('كل المحادثات في الفترة', 'all conversations in the period')),
      metricRow('مدة المكالمات', 'Call duration', NA, 'no call duration is recorded in RAF', '—')
    ];
    var summary = [stat('conversations', 'المحادثات', 'Conversations', rows.length, 'RAFDriverCommunication'),
      stat('messages', 'الرسائل', 'Messages', sum('messages'), 'message counts'),
      stat('calls', 'المكالمات', 'Calls', sum('calls'), 'communication events'),
      stat('continuity', 'تغيّر السائق', 'Driver changes', sum('driverChanges'), 'conversation lifecycle')];
    return finish('communication', s.v, s.p, s.f, METRIC_COLS, out, summary,
      [T('بيانات وصفية فقط: لا يعرض هذا العرض نص أي رسالة ولا هوية العميل.', 'Metadata only: this view shows no message content and no customer identity.')]);
  }

  /* ═══════════ CUSTOMER EXPERIENCE (recorded facts only) ═══════════ */
  function customerExperienceView(filters){
    var s = prep(filters, ['driverId']); if (!s.ok) return s;
    var d = report('drivers', pick(s.f, ['driverId'], s.period)); if (!d.ok) return d;
    var del = report('deliveries', { period:s.period });
    var dist = { 1:0, 2:0, 3:0, 4:0, 5:0 }, total = 0, count = 0, missing = false;
    if (global.RAFDriverRating) {
      d.rows.forEach(function (r) { /* per-driver rating detail is management-only and comes from the rating authority */ });
    }
    (function () {
      try {
        var ids = RAFPerm.getUsers().filter(function (u) { return u.roleId === 'driver'; }).map(function (u) { return u.id; });
        ids.forEach(function (id) {
          var r = global.RAFDriverRating ? RAFDriverRating.forDriver(id) : null;
          if (!r || !r.ok) { missing = true; return; }
          count += r.count || 0; total += (r.total || 0) * (r.count || 0);
          [1, 2, 3, 4, 5].forEach(function (k) { dist[k] += (r.distribution && r.distribution[k]) || 0; });
        });
      } catch (e) { missing = true; }
    })();
    var deliveredCount = del.ok ? del.rows.filter(function (r) { return r.deliveredAt != null; }).length : null;
    var cm = report('communication', { period:s.period });
    var out = [
      metricRow('تقييمات مسجَّلة (كل الفترات)', 'Ratings recorded (all time)', missing ? NA : count, 'RAFDriverRating', T('كل التقييمات التاريخية', 'all historical ratings')),
      metricRow('متوسط التقييم (كل الفترات)', 'Average rating (all time)', missing || !count ? NA : Math.round((total / count) * 10) / 10 + ' / 5', 'RAFDriverRating totals', count + T(' تقييم', ' ratings')),
      metricRow('توزيع التقييمات', 'Rating distribution', missing || !count ? NA : [5, 4, 3, 2, 1].map(function (k) { return k + '★ ' + dist[k]; }).join(' · '), 'RAFDriverRating distribution', count + T(' تقييم', ' ratings')),
      metricRow('توصيلات مسلَّمة في الفترة', 'Deliveries completed in the period', deliveredCount == null ? NA : deliveredCount, 'RAFReports.deliveries', T('التوصيلات في الفترة', 'deliveries in the period')),
      metricRow('محادثات مع العملاء في الفترة', 'Customer conversations in the period', cm.ok ? cm.rows.length : NA, 'RAFDriverCommunication', T('المحادثات في الفترة', 'conversations in the period')),
      metricRow('شكاوى الدعم', 'Support complaints', NA, 'RAF has no complaint authority yet (open gap since Phase H)', '—'),
      metricRow('مؤشرات الرضا (NPS/CSAT)', 'Satisfaction indices (NPS/CSAT)', NA, 'not approved and not recorded — never inferred', '—')
    ];
    var summary = [stat('ratings', 'التقييمات', 'Ratings', missing ? NA : count, 'RAFDriverRating', missing ? 'NOT_AVAILABLE' : null),
      stat('average', 'المتوسط', 'Average', missing || !count ? NA : Math.round((total / count) * 10) / 10 + ' / 5', 'RAFDriverRating', missing || !count ? 'NOT_AVAILABLE' : null),
      stat('delivered', 'مسلَّمة', 'Delivered', deliveredCount == null ? NA : deliveredCount, 'RAFReports.deliveries'),
      stat('complaints', 'الشكاوى', 'Complaints', NA, 'no complaint authority', 'NOT_AVAILABLE')];
    return finish('customerExperience', s.v, s.p, s.f, METRIC_COLS, out, summary,
      [T('لا تُستنتج مشاعر العميل من نص الرسائل، ولا تُحسب مؤشرات رضا غير معتمدة. التقييم الكلي لكل سائق يشمل كل الفترات.',
         'Customer sentiment is never inferred from message text and no unapproved satisfaction index is calculated. A driver’s total rating is all-time.')]);
  }

  /* ═══════════ COMPENSATION ═══════════ */
  function compensationView(filters){
    var s = prep(filters, ['storeSlug', 'status', 'orderId', 'customerId']); if (!s.ok) return s;
    var cp = report('compensation', pick(s.f, ['storeSlug', 'status', 'orderId', 'customerId'], s.period)); if (!cp.ok) return cp;
    var rows = cp.rows;
    var by = function (st) { return rows.filter(function (r) { return r.status === st; }).length; };
    var fils = rows.reduce(function (a, r) { return a + Math.round(parseFloat(r.amount || '0') * 1000); }, 0);
    var delay = stats(rows.map(function (r) { return r.actualDelayMinutes; }));
    var enabled = global.RAFConfig ? RAFConfig.value('compensation.enabled') : null;
    var out = [
      metricRow('تعويضات صادرة', 'Compensations issued', rows.length, 'RAFCompensation records (issued time)', T('كل التعويضات في الفترة', 'all compensations in the period')),
      metricRow('إجمالي القيمة', 'Total value issued', (fils / 1000).toFixed(3) + ' KWD', 'sum of the amounts RAFCompensation issued', T('التعويضات في الفترة = ', 'compensations in the period = ') + rows.length),
      metricRow('أُضيفت إلى المحفظة', 'Added to RAF Wallet', rows.filter(function (r) { return r.inWallet === 'yes'; }).length, 'RAFWallet lot via RAFCompensation', T('التعويضات في الفترة = ', 'compensations in the period = ') + rows.length),
      metricRow('مُبطلة', 'Voided', by('voided'), 'compensation status', T('التعويضات في الفترة = ', 'compensations in the period = ') + rows.length),
      metricRow('معكوسة', 'Reversed', by('reversed'), 'compensation status', T('التعويضات في الفترة = ', 'compensations in the period = ') + rows.length),
      metricRow('منتهية الصلاحية', 'Expired', by('expired'), 'compensation status', T('التعويضات في الفترة = ', 'compensations in the period = ') + rows.length),
      metricRow('التأخير الذي أدّى إليها', 'Delay behind them', delay.count ? T('وسيط ', 'median ') + delay.median + T(' د · أقصى ', ' min · max ') + delay.max + T(' د', ' min') : NA, 'RAFCompensation actualDelayMinutes', delay.count + T(' تعويض', ' compensations')),
      metricRow('حالة الميزة', 'Feature state', enabled === true ? 'ON' : (enabled === false ? 'OFF' : NC), "RAFConfig 'compensation.enabled'", '—')
    ];
    var summary = [stat('issued', 'صادرة', 'Issued', rows.length, 'RAFCompensation'),
      stat('value', 'القيمة', 'Value', (fils / 1000).toFixed(3) + ' KWD', 'issued amounts'),
      stat('wallet', 'في المحفظة', 'In wallet', rows.filter(function (r) { return r.inWallet === 'yes'; }).length, 'RAFWallet lot'),
      stat('reversed', 'معكوسة', 'Reversed', by('reversed'), 'compensation status')];
    return finish('compensation', s.v, s.p, s.f, METRIC_COLS, out, summary,
      [T('القيم كما أصدرتها RAFCompensation ولا يُعاد حسابها هنا؛ قاعدة الاستحقاق تبقى ملكها.',
         'Amounts are exactly as RAFCompensation issued them and are never recalculated here; the eligibility rule stays its own.')]);
  }

  /* ═══════════ RAF-WIDE OVERVIEW ═══════════ */
  function overviewView(filters){
    var s = prep(filters, ['storeSlug']); if (!s.ok) return s;
    var period = s.period, f = s.f;
    var ord = report('orders', pick(f, ['storeSlug'], period));
    var del = report('deliveries', pick(f, ['storeSlug'], period));
    var ex = report('exceptions', pick(f, ['storeSlug'], period));
    var re = report('reassignments', pick(f, ['storeSlug'], period));
    var cm = report('communication', pick(f, ['storeSlug'], period));
    var cp = report('compensation', pick(f, ['storeSlug'], period));
    var dr = report('drivers', { period:period });
    var rows = [];
    var add = function (ar, en, value, source, denom) { rows.push(metricRow(ar, en, value, source, denom)); };
    var group = T('كل الطلبات في الفترة', 'all orders in the period');
    if (ord.ok) {
      var o = ord.rows, status = function (st) { return o.filter(function (r) { return r.status === st; }).length; };
      add('الطلبات', 'Orders', o.length, 'RAFReports.orders (placed time)', group);
      add('قبِلها المتجر', 'Accepted by the merchant', o.filter(function (r) { return r.acceptedAt != null; }).length, 'order.accept milestone', group);
      add('أصبحت جاهزة', 'Became ready', o.filter(function (r) { return r.readyAt != null; }).length, 'order.ready milestone', group);
      add('تم تسليمها', 'Delivered', status('delivered'), 'order.status + driver.delivered', group);
      add('ملغاة', 'Cancelled', status('cancelled'), 'order.status', group);
      add('قيد التنفيذ', 'In progress', o.length - status('delivered') - status('cancelled'), 'order.status', group);
    } else add('الطلبات', 'Orders', NA, 'RAFReports.orders: ' + ord.code, '—');
    if (del.ok) {
      var d = del.rows, live = d.filter(function (r) { return r.deliveredAt == null; });
      add('توصيلات في الفترة', 'Deliveries in period', d.length, 'RAFReports.deliveries', T('التوصيلات في الفترة', 'deliveries in the period'));
      add('بانتظار سائق', 'Waiting for a driver', live.filter(function (r) { return r.assignedAt == null; }).length, 'no assignedAt', T('التوصيلات غير المسلَّمة', 'undelivered deliveries'));
      add('لدى سائق', 'Assigned to a driver', live.filter(function (r) { return r.assignedAt != null; }).length, 'fulfilment.assignedAt', T('التوصيلات غير المسلَّمة', 'undelivered deliveries'));
      add('تم الاستلام', 'Picked up', d.filter(function (r) { return r.pickedUpAt != null; }).length, 'fulfilment.pickedUpAt', T('التوصيلات في الفترة', 'deliveries in the period'));
      add('سُلّمت', 'Completed deliveries', d.filter(function (r) { return r.deliveredAt != null; }).length, 'driver.delivered', T('التوصيلات في الفترة', 'deliveries in the period'));
      add('متأخرة عن الوقت الموعود المسجَّل', 'Later than the recorded promise', d.filter(function (r) { return r.delayMinutes != null && r.delayMinutes > 0; }).length, 'deliveredAt − recorded promise', T('المسلَّمة ولها وقت موعود مسجَّل', 'delivered with a recorded promise'));
    } else add('التوصيلات', 'Deliveries', NA, 'RAFReports.deliveries: ' + del.code, '—');
    if (re.ok) {
      add('إعادة إسناد', 'Reassignments', re.rows.filter(function (r) { return r.kind === 'reassignment'; }).length, "ownership 'reassignment'", T('أحداث الحركة في الفترة', 'movement events in the period'));
      add('إرجاع للقائمة', 'Returns to pool', re.rows.filter(function (r) { return r.kind === 'returned_to_pool'; }).length, "ownership 'returned_to_pool'", T('أحداث الحركة في الفترة', 'movement events in the period'));
    } else add('إعادة الإسناد', 'Reassignments', NA, 'RAFReports.reassignments: ' + re.code, '—');
    if (ex.ok) {
      var e = ex.rows;
      add('استثناءات فُتحت', 'Exceptions opened', e.length, 'RAFDeliveryOps.exceptions', T('الاستثناءات في الفترة', 'exceptions in the period'));
      add('مفتوحة الآن', 'Open now', e.filter(function (r) { return r.status !== 'closed'; }).length, 'exception status', T('الاستثناءات في الفترة', 'exceptions in the period'));
      add('أُغلقت', 'Closed', e.filter(function (r) { return r.status === 'closed'; }).length, 'exception status', T('الاستثناءات في الفترة', 'exceptions in the period'));
      add('SLA يقترب', 'SLA approaching', e.filter(function (r) { return r.slaState === 'approaching'; }).length, 'RAFDeliveryOps SLA', T('الاستثناءات في الفترة', 'exceptions in the period'));
      add('SLA مُخترق', 'SLA breached', e.filter(function (r) { return String(r.slaState || '').indexOf('breach') > -1; }).length, 'RAFDeliveryOps SLA', T('الاستثناءات في الفترة', 'exceptions in the period'));
      add('تصعيدات', 'Escalated', e.filter(function (r) { return !!r.escalation; }).length, 'escalation state', T('الاستثناءات في الفترة', 'exceptions in the period'));
      add('خطر الغرامة', 'Penalty risk', e.filter(function (r) { return r.penaltyRisk === 'yes'; }).length, 'RAFDeliveryOps penalty evaluation', T('الاستثناءات في الفترة', 'exceptions in the period'));
    } else add('الاستثناءات', 'Exceptions', NA, 'RAFReports.exceptions: ' + ex.code, '—');
    if (dr.ok) {
      var sum = function (k) { return dr.rows.reduce(function (a, r) { return a + (typeof r[k] === 'number' ? r[k] : 0); }, 0); };
      add('حسابات سائقين نشطة', 'Active driver accounts', dr.rows.filter(function (r) { return r.accountStatus === 'active'; }).length, 'RAFPerm account status', T('كل حسابات السائقين', 'all driver accounts'));
      add('حسابات موقوفة', 'Suspended driver accounts', dr.rows.filter(function (r) { return r.accountStatus !== 'active'; }).length, 'RAFPerm account status', T('كل حسابات السائقين', 'all driver accounts'));
      add('السحب الناجح', 'Successful claims', sum('claims'), 'RAFDriverPerformance', T('مجموع السائقين في الفترة', 'sum over drivers in the period'));
      add('توصيلات مكتملة (السائقون)', 'Completed deliveries (drivers)', sum('deliveries'), 'RAFDriverPerformance', T('مجموع السائقين في الفترة', 'sum over drivers in the period'));
      add('التخطي', 'Skips', sum('skips'), 'RAFDriverPerformance', T('مجموع السائقين في الفترة', 'sum over drivers in the period'));
      add('العمل الإضافي', 'Overtime', sum('overtimeMinutes') + T(' د', ' min'), 'RAFDriverPerformance', T('مجموع السائقين في الفترة', 'sum over drivers in the period'));
    } else add('السائقون', 'Drivers', NA, 'RAFReports.drivers: ' + dr.code, '—');
    var av = null; try { av = global.RAFDriverManagement ? RAFDriverManagement.availability.list() : null; } catch (e2) {}
    if (av && av.ok) {
      add('متاحون الآن', 'Available now', (av.drivers || []).filter(function (x) { return x.availability && x.availability.state === 'available'; }).length, 'RAFDriverManagement.availability', T('حالة لحظية', 'a live state'));
      add('غير متاحين الآن', 'Unavailable now', (av.drivers || []).filter(function (x) { return x.availability && x.availability.state !== 'available'; }).length, 'RAFDriverManagement.availability', T('حالة لحظية', 'a live state'));
    } else add('توفر السائقين', 'Driver availability', NA, 'RAFDriverManagement.availability', '—');
    if (cm.ok) {
      add('المحادثات', 'Conversations', cm.rows.length, 'RAFDriverCommunication', T('المحادثات في الفترة', 'conversations in the period'));
      add('الرسائل', 'Messages', cm.rows.reduce(function (a, r) { return a + (r.messages || 0); }, 0), 'message counts', T('المحادثات في الفترة', 'conversations in the period'));
      add('المكالمات', 'Calls', cm.rows.reduce(function (a, r) { return a + (r.calls || 0); }, 0), 'communication events', T('المحادثات في الفترة', 'conversations in the period'));
      add('محادثات مغلقة', 'Closed conversations', cm.rows.filter(function (r) { return r.state === 'closed'; }).length, 'conversation lifecycle', T('المحادثات في الفترة', 'conversations in the period'));
      add('استمرارية بعد تغيّر السائق', 'Continuity across driver changes', cm.rows.filter(function (r) { return (r.driverChanges || 0) > 0; }).length, 'conversation lifecycle', T('المحادثات في الفترة', 'conversations in the period'));
    } else add('التواصل', 'Communication', NA, 'RAFReports.communication: ' + cm.code, '—');
    if (cp.ok) {
      var fils2 = cp.rows.reduce(function (a, r) { return a + Math.round(parseFloat(r.amount || '0') * 1000); }, 0);
      add('تعويضات صادرة', 'Compensations issued', cp.rows.length, 'RAFCompensation', T('التعويضات في الفترة', 'compensations in the period'));
      add('قيمة التعويضات', 'Compensation value', (fils2 / 1000).toFixed(3) + ' KWD', 'RAFCompensation amounts', T('التعويضات في الفترة', 'compensations in the period'));
      add('أُضيفت للمحفظة', 'Added to wallet', cp.rows.filter(function (r) { return r.inWallet === 'yes'; }).length, 'RAFWallet lot', T('التعويضات في الفترة', 'compensations in the period'));
      add('مُبطلة / معكوسة / منتهية', 'Voided / reversed / expired',
        cp.rows.filter(function (r) { return r.status === 'voided'; }).length + ' / ' + cp.rows.filter(function (r) { return r.status === 'reversed'; }).length + ' / ' + cp.rows.filter(function (r) { return r.status === 'expired'; }).length,
        'compensation status', T('التعويضات في الفترة', 'compensations in the period'));
    } else {
      var en2 = global.RAFConfig ? RAFConfig.value('compensation.enabled') : null;
      add('التعويضات', 'Compensation', en2 === false ? 'OFF' : NA, 'RAFReports.compensation: ' + cp.code, '—');
    }
    var summary = [stat('orders', 'الطلبات', 'Orders', ord.ok ? ord.rows.length : NA, 'RAFReports.orders', ord.ok ? null : 'NOT_AVAILABLE'),
      stat('delivered', 'مسلَّمة', 'Delivered', del.ok ? del.rows.filter(function (r) { return r.deliveredAt != null; }).length : NA, 'driver.delivered', del.ok ? null : 'NOT_AVAILABLE'),
      stat('exceptions', 'استثناءات', 'Exceptions', ex.ok ? ex.rows.length : NA, 'RAFDeliveryOps', ex.ok ? null : 'NOT_AVAILABLE'),
      stat('compensation', 'تعويضات', 'Compensations', cp.ok ? cp.rows.length : NA, 'RAFCompensation', cp.ok ? null : 'NOT_AVAILABLE')];
    return finish('overview', s.v, s.p, f, METRIC_COLS, rows, summary,
      [T('كل رقم مذكور مصدره ومقامه. ما لا يمكن قياسه من سجل حقيقي يظهر NOT_AVAILABLE أو NOT_CONFIGURED — ولا يُخمَّن.',
         'Every figure names its source and its denominator. Anything that cannot be measured from a real record shows NOT_AVAILABLE or NOT_CONFIGURED — never a guess.')]);
  }

  /* ---------- catalogue ---------- */
  var VIEWS = [
    { id:'overview',           ar:'نظرة عامة',          en:'Overview',            fn:overviewView },
    { id:'orders',             ar:'أداء الطلبات',       en:'Orders',              fn:ordersView },
    { id:'merchants',          ar:'أداء المتاجر',       en:'Merchants',           fn:merchantsView },
    { id:'logistics',          ar:'أداء اللوجستيات',    en:'Logistics',           fn:logisticsView },
    { id:'drivers',            ar:'أداء السائقين',      en:'Drivers',             fn:driversView },
    { id:'exceptions',         ar:'الاستثناءات و SLA',  en:'Exceptions & SLA',    fn:exceptionsView },
    { id:'reassignments',      ar:'إعادة الإسناد',      en:'Reassignments',       fn:reassignmentsView },
    { id:'communication',      ar:'التواصل',            en:'Communication',       fn:communicationView },
    { id:'customerExperience', ar:'تجربة العميل',       en:'Customer Experience', fn:customerExperienceView },
    { id:'compensation',       ar:'التعويضات',          en:'Compensation',        fn:compensationView }
  ];
  function run(viewId, filters){
    var d = VIEWS.filter(function (x) { return x.id === viewId; })[0];
    if (!d) return fail('UNKNOWN_VIEW', { viewId:viewId });
    return d.fn(filters);
  }
  /* export reuses the Reports Center's CSV writer — one export implementation */
  function csv(result){
    if (!global.RAFReports || !RAFReports.csv) return fail('SOURCE_UNAVAILABLE', { source:'RAFReports.csv' });
    return RAFReports.csv(result);
  }

  global.RAFPerformance = {
    ERRORS:ERRORS, VIEWS:VIEWS.map(function (v) { return { id:v.id, ar:v.ar, en:v.en }; }),
    viewer:function () { var v = viewer(); return v.ok ? { ok:true, storeSlug:v.storeSlug, storeBound:v.storeBound, canExport:v.canExport } : v; },
    run:run, csv:csv,
    overview:overviewView, orders:ordersView, merchants:merchantsView, logistics:logisticsView,
    drivers:driversView, exceptions:exceptionsView, reassignments:reassignmentsView,
    communication:communicationView, customerExperience:customerExperienceView, compensation:compensationView
  };
})(window);
