/* ============================================================================
 * RAF Marketplace — DRIVER PERFORMANCE PROJECTION  (shared, headless) — Phase G
 * ----------------------------------------------------------------------------
 * A READ-ONLY calculation layer. It owns no record and stores nothing: every
 * number is derived, at read time, from the authorities that already own the
 * facts. It never evaluates, materialises, notifies, audits or publishes.
 *
 *   Metric                 Source (authority → record)
 *   Successful Claims      RAFDriver → 'ownership' kind 'claim', toDriverId = the
 *                          driver AND actor {type:'driver', id:the driver}
 *   Completed Deliveries   RAFDriver/RAFOrderEngine → delivered orders whose
 *                          snapshot fulfilment.driverId is the driver (only the
 *                          current owner can complete) at fulfilment.deliveredAt
 *   Lost ownership         RAFDriver → 'ownership' kind 'reassignment' /
 *                          'returned_to_pool' with fromDriverId = the driver
 *   Skips                  RAFDriver → 'driver_skips'
 *   Reassignment Requests  RAFDriver → 'reassignment_requests' entries of type
 *                          'submitted' by the driver; status = the request's
 *                          latest lifecycle entry (approved decision action kept)
 *   Exceptions             RAFDeliveryOps.exceptions → 'exceptions' whose
 *                          driverIdAtOpen is the driver (whoever opened it)
 *   Working hours/Overtime  RAFDriverManagement.availability → 'availability_history'
 *                          sessions (session = availability session); the basic
 *                          time of a session is its 'overtime_events' entered
 *                          baseline when recorded, otherwise RAFConfig
 *                          'availability.basicWorkMinutes'. Time after an account
 *                          suspension (RAFAudit 'driver.suspended') is not counted.
 *   Customer Rating        RAFDriverRating (all history; not period-filtered)
 *
 * No score, rate, percentage, weighting or ranking is calculated.
 *
 * PERIODS — Today / Week (calendar week from Sunday 00:00) / Month / Custom
 * (inclusive dates), all in RAFConfig 'availability.scheduleTimezone'
 * (Asia/Kuwait), never the browser's timezone. A metric counts records whose
 * own timestamp falls in [start, end); working time is clipped to the period.
 *
 * ACCESS
 *   mine({period})               the signed-in active driver, own data only
 *   compare({period})            existing `drivers.suspend` (Operations Manager,
 *                                Higher Management, Super Admin)
 *   detail(driverId, {period})   existing `drivers.suspend`
 * Identity comes from the session; caller-supplied identity fields are refused.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDriverPerformance) return;

  var PERM = 'drivers.suspend';
  var DAY = 86400000;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية لعرض أداء السائقين.',  en:'You do not have permission to view driver performance.' },
    ACTOR_INACTIVE:     { ar:'حسابك غير نشط.',                       en:'Your account is not active.' },
    FIELD_NOT_ACCEPTED: { ar:'تحتوي البيانات على حقول غير مقبولة.',  en:'The request contains fields that are not accepted.' },
    PERIOD_INVALID:     { ar:'الفترة غير صالحة.',                    en:'The period is not valid.' },
    NOT_A_DRIVER:       { ar:'هذا الحساب ليس حساب سائق.',             en:'That account is not a driver account.' },
    NOT_CONFIGURED:     { ar:'المنطقة الزمنية غير مُهيّأة.',           en:'The timezone is not configured.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' }, r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  function coll(n){ return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; }
  function rows(n){ var c = coll(n); return c ? c.all() : []; }
  function cfg(k){ return global.RAFConfig ? RAFConfig.value(k) : null; }
  function users(){ try { return RAFPerm.getUsers() || []; } catch (e) { return []; } }
  function isDriver(u){ return !!(u && u.accountType === 'driver' && u.roleId === 'driver'); }
  function inRange(t, p){ return typeof t === 'number' && t >= p.start && t < p.end; }
  function overlap(a, b, p){ var s = Math.max(a, p.start), e = Math.min(b, p.end); return e > s ? e - s : 0; }

  /* ---------- periods in the RAF timezone ---------- */
  function partsIn(tz, t){
    var f = new Intl.DateTimeFormat('en-GB', { timeZone:tz, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23', weekday:'short' });
    var o = {}; f.formatToParts(new Date(t)).forEach(function (x) { o[x.type] = x.value; });
    return { y:+o.year, m:+o.month, d:+o.day, h:+o.hour, mi:+o.minute, s:+o.second,
             wd:{ Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[o.weekday] };
  }
  /* the instant of 00:00 on y-m-d in tz */
  function midnight(tz, y, m, d){
    var guess = Date.UTC(y, m - 1, d);
    for (var i = 0; i < 2; i++) {
      var p = partsIn(tz, guess), asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
      guess = guess - (asUtc - Date.UTC(y, m - 1, d));
    }
    return guess;
  }
  var DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
  function parseDate(s){
    var m = DATE.exec(s || ''); if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], chk = new Date(Date.UTC(y, mo - 1, d));
    return (chk.getUTCFullYear() === y && chk.getUTCMonth() === mo - 1 && chk.getUTCDate() === d) ? { y:y, m:mo, d:d } : null;
  }
  function periodOf(spec, now){
    spec = spec || { preset:'today' };
    if (typeof spec !== 'object' || !onlyKeys(spec, ['preset', 'from', 'to'])) return fail('PERIOD_INVALID');
    var tz = cfg('availability.scheduleTimezone'); if (!tz) return fail('NOT_CONFIGURED');
    var p = partsIn(tz, now), start, end = now;
    if (spec.preset === 'today') start = midnight(tz, p.y, p.m, p.d);
    else if (spec.preset === 'week') {
      var sunday = new Date(Date.UTC(p.y, p.m - 1, p.d) - p.wd * DAY);
      start = midnight(tz, sunday.getUTCFullYear(), sunday.getUTCMonth() + 1, sunday.getUTCDate());
    }
    else if (spec.preset === 'month') start = midnight(tz, p.y, p.m, 1);
    else if (spec.preset === 'custom') {
      var a = parseDate(spec.from), b = parseDate(spec.to);
      if (!a || !b) return fail('PERIOD_INVALID');
      start = midnight(tz, a.y, a.m, a.d);
      var nb = new Date(Date.UTC(b.y, b.m - 1, b.d) + DAY);
      end = midnight(tz, nb.getUTCFullYear(), nb.getUTCMonth() + 1, nb.getUTCDate());
      if (end <= start) return fail('PERIOD_INVALID');
    }
    else return fail('PERIOD_INVALID');
    if (spec.preset !== 'custom' && (spec.from !== undefined || spec.to !== undefined)) return fail('PERIOD_INVALID');
    return { ok:true, preset:spec.preset, timezone:tz, start:start, end:end, from:spec.from || null, to:spec.to || null };
  }

  /* ---------- working time from availability sessions ---------- */
  function sessionsOf(driverId, now){
    var hist = rows('availability_history').filter(function (e) { return e.driverId === driverId; })
      .sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); });
    var byId = {}, order = [];
    hist.forEach(function (e) {
      if (!e.sessionId) return;
      if (e.to === 'available') { if (!byId[e.sessionId]) { byId[e.sessionId] = { sessionId:e.sessionId, start:e.at, end:null }; order.push(e.sessionId); } }
      else if (e.to === 'unavailable' && byId[e.sessionId] && byId[e.sessionId].end == null) byId[e.sessionId].end = e.at;
    });
    var cur = null; try { cur = RAFRecordStore.stateMap('driver_availability').get(driverId); } catch (e) {}
    var suspensions = []; try {
      suspensions = (global.RAFAudit ? RAFAudit.all() : []).filter(function (a) { return a.action === 'driver.suspended' && a.metadata && a.metadata.driverId === driverId; })
        .map(function (a) { return a.timestamp; });
    } catch (e) {}
    var entered = {}; rows('overtime_events').forEach(function (o) { if (o.driverId === driverId && o.type === 'entered') entered[o.sessionId] = o.baselineEndsAt; });
    var basicMin = cfg('availability.basicWorkMinutes');
    var out = [], unresolved = 0;
    order.forEach(function (id) {
      var s = byId[id], end = s.end, open = false;
      if (end == null) {
        if (cur && cur.state === 'available' && cur.sessionId === id) { end = now; open = true; }
        else { unresolved++; return; }           /* no recorded end — not counted */
      }
      suspensions.forEach(function (t) { if (t > s.start && t < end) { end = t; open = false; } });
      var basicEnd = entered[id] != null ? entered[id] : (typeof basicMin === 'number' ? s.start + basicMin * 60000 : null);
      out.push({ sessionId:id, start:s.start, end:end, open:open, basicEnd:basicEnd, baselineSource:entered[id] != null ? 'overtime_record' : 'config' });
    });
    return { sessions:out, unresolved:unresolved };
  }

  /* ---------- one driver's metrics for a period ---------- */
  function metricsOf(driverId, p, now, detail){
    var own = rows('ownership');
    var claims = own.filter(function (r) { return r.kind === 'claim' && r.toDriverId === driverId && r.actor && r.actor.type === 'driver' && r.actor.id === driverId && inRange(r.at, p); });
    var lost = own.filter(function (r) { return (r.kind === 'reassignment' || r.kind === 'returned_to_pool') && r.fromDriverId === driverId && inRange(r.at, p); });
    var orders = []; try { orders = global.RAFShop ? RAFShop.Orders.all() : []; } catch (e) {}
    var deliveries = orders.filter(function (o) {
      var f = o && o.snapshot && o.snapshot.fulfilment;
      return o.status === 'delivered' && f && f.driverId === driverId && inRange(f.deliveredAt, p);
    });
    var skips = rows('driver_skips').filter(function (s) { return s.driverId === driverId && inRange(s.at, p); });
    var reqEntries = rows('reassignment_requests'), lastByReq = {};
    reqEntries.forEach(function (e) {
      var prev = lastByReq[e.requestId];
      if (!prev || e.at > prev.at || (e.at === prev.at && (e.seq || 0) > (prev.seq || 0))) lastByReq[e.requestId] = e;
    });
    var requests = reqEntries.filter(function (e) { return e.type === 'submitted' && e.driverId === driverId && inRange(e.at, p); });
    var reqStatus = { pending:0, cancelled:0, approved_reassigned:0, approved_returned_to_pool:0, rejected:0 };
    requests.forEach(function (e) {
      var l = lastByReq[e.requestId] || e, action = l.decision && l.decision.action;
      if (l.type === 'submitted') reqStatus.pending++;
      else if (l.type === 'cancelled') reqStatus.cancelled++;
      else if (l.type === 'rejected') reqStatus.rejected++;
      else if (l.type === 'approved' && action === 'returned_to_pool') reqStatus.approved_returned_to_pool++;
      else if (l.type === 'approved') reqStatus.approved_reassigned++;
    });
    var exceptions = rows('exceptions').filter(function (x) { return x.driverIdAtOpen === driverId && inRange(x.openedAt, p); });
    var exBy = { driver:0, staff:0 };
    exceptions.forEach(function (x) { if (x.openedBy && x.openedBy.type === 'driver') exBy.driver++; else exBy.staff++; });
    var ses = sessionsOf(driverId, now), workMs = 0, otMs = 0, overtimeKnown = true;
    ses.sessions.forEach(function (s) {
      workMs += overlap(s.start, s.end, p);
      if (s.basicEnd == null) overtimeKnown = false;
      else if (s.end > s.basicEnd) otMs += overlap(s.basicEnd, s.end, p);
    });
    var m = {
      claims:claims.length,
      deliveries:deliveries.length,
      lostOwnership:lost.length,
      skips:skips.length,
      reassignmentRequests:requests.length,
      exceptions:exceptions.length,
      workingMs:workMs,
      basicMs:overtimeKnown ? workMs - otMs : null,
      overtimeMs:overtimeKnown ? otMs : null,
      openSession:ses.sessions.some(function (s) { return s.open; })
    };
    if (detail) {
      m.breakdown = {
        lostOwnership:{ reassigned:lost.filter(function (r) { return r.kind === 'reassignment'; }).length,
                        returnedToPool:lost.filter(function (r) { return r.kind === 'returned_to_pool'; }).length },
        reassignmentRequests:reqStatus,
        exceptionsOpenedBy:exBy,
        sessionsInPeriod:ses.sessions.filter(function (s) { return overlap(s.start, s.end, p) > 0; }).length,
        sessionsWithoutRecordedEnd:ses.unresolved
      };
    }
    return m;
  }

  /* ---------- access ---------- */
  function driverScope(){
    if (!global.RAFDriver || !RAFDriver.scope) return fail('FORBIDDEN');
    var sc = RAFDriver.scope(); return sc.ok ? sc : fail('FORBIDDEN');
  }
  function managerScope(){
    var u = null; try { u = RAFPerm.currentUser(); } catch (e) {}
    if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    try { if (!RAFPerm.can(u.id, PERM)) return fail('FORBIDDEN'); } catch (e) { return fail('FORBIDDEN'); }
    return { ok:true, id:u.id };
  }

  function mine(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['period'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = driverScope(); if (!sc.ok) return sc;
    var now = Date.now(), p = periodOf(opts.period, now); if (!p.ok) return p;
    var m = metricsOf(sc.id, p, now, false);
    var r = global.RAFDriverRating ? RAFDriverRating.mine() : null;
    /* the driver: own metrics and total rating only — no count, no ratings, no comments */
    m.rating = r && r.ok ? { total:r.total, outOf:5 } : { total:null, outOf:5, unavailable:true };
    return { ok:true, period:p, metrics:m };
  }
  function compare(opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['period'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = managerScope(); if (!sc.ok) return sc;
    var now = Date.now(), p = periodOf(opts.period, now); if (!p.ok) return p;
    var list = users().filter(isDriver).map(function (u) {
      var m = metricsOf(u.id, p, now, false);
      var r = global.RAFDriverRating ? RAFDriverRating.forDriver(u.id) : null;
      m.rating = r && r.ok ? { total:r.total, outOf:5, count:r.count } : { total:null, outOf:5, count:null, unavailable:true };
      return { driverId:u.id, name:u.name, accountStatus:u.status, metrics:m };
    });
    return { ok:true, period:p, drivers:list };
  }
  function detail(driverId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['period'])) return fail('FIELD_NOT_ACCEPTED');
    var sc = managerScope(); if (!sc.ok) return sc;
    var u = null; try { u = RAFPerm.getUser(driverId); } catch (e) {}
    if (!isDriver(u)) return fail('NOT_A_DRIVER');
    var now = Date.now(), p = periodOf(opts.period, now); if (!p.ok) return p;
    var m = metricsOf(driverId, p, now, true);
    var r = global.RAFDriverRating ? RAFDriverRating.forDriver(driverId) : null;
    m.rating = r && r.ok ? r : { total:null, outOf:5, count:null, unavailable:true };
    return { ok:true, period:p, driverId:driverId, name:u.name, accountStatus:u.status, metrics:m };
  }

  global.RAFDriverPerformance = { ERRORS:ERRORS, mine:mine, compare:compare, detail:detail, periodOf:function (spec) { return periodOf(spec, Date.now()); } };
})(window);
