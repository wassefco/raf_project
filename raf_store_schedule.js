/* ============================================================================
 * RAF Marketplace — STORE OPENING SCHEDULE AUTHORITY  (shared, headless)
 * ----------------------------------------------------------------------------
 * The single source of a store's opening hours: the structured `schedule`
 * field on the store record. This authority is the one way to read,
 * validate, save and format it. RAFStoreOps evaluates it at runtime
 * (Kuwait time); every customer-facing hours text is generated here.
 *
 * STORED SHAPE
 *   schedule: {
 *     saturday: { periods:[ { open:'10:00', close:'14:00' },
 *                           { open:'17:00', close:'23:00' } ] },
 *     sunday:   { periods:[ { open:'10:00', close:'23:00' } ] },
 *     …
 *     friday:   { closed:true }
 *   }
 * 24-hour 'HH:MM', Kuwait wall-clock. Stable English day keys; all seven days
 * are explicit. An earlier single-period day { open, close } still reads
 * correctly and is written back in the `periods` shape on the next save —
 * stored data is never rewritten on its own.
 *
 * The merchant never sees 24-hour time: to24 / from24 / format12 convert in
 * exactly one place (12 AM → 00:00, 12 PM → 12:00).
 *
 * RULES
 *   · a closed day carries no periods; an open day has one or two
 *   · each period closes later than it opens on the same day (no overnight)
 *   · two periods are in order, do not overlap and do not touch
 *   · an invalid schedule is refused whole — nothing is partly saved
 *
 * The legacy free-text `hours` { ar, en } on the store record is never read,
 * parsed or shown as hours. A store with no schedule has no hours to show.
 *
 * PERMISSION + OWNERSHIP. The existing `stores.edit` key through RAFPerm, by
 * account id; the store is always the acting account's own, resolved with
 * RAFPerm.storeSlugOf(actorId). A caller can never name a store.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFStoreSchedule) return;

  /* display order: the Kuwait week starts on Saturday */
  var DAYS = ['saturday','sunday','monday','tuesday','wednesday','thursday','friday'];
  var MAX_PERIODS = 2;
  var HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
  var DAY_NAMES = {
    saturday:{ ar:'السبت',    en:'Saturday',  ab:'Sat' },
    sunday:{   ar:'الأحد',     en:'Sunday',    ab:'Sun' },
    monday:{   ar:'الاثنين',   en:'Monday',    ab:'Mon' },
    tuesday:{  ar:'الثلاثاء',  en:'Tuesday',   ab:'Tue' },
    wednesday:{ar:'الأربعاء',  en:'Wednesday', ab:'Wed' },
    thursday:{ ar:'الخميس',    en:'Thursday',  ab:'Thu' },
    friday:{   ar:'الجمعة',    en:'Friday',    ab:'Fri' }
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية لتعديل جدول العمل.',          en:'You do not have permission to edit the opening schedule.' },
    NO_STORE:           { ar:'لا يوجد متجر مرتبط بهذا الحساب.',             en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:    { ar:'المتجر المرتبط غير موجود.',                   en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'المتجر يُحدَّد تلقائياً من حسابك.',           en:'The store is taken from your account automatically.' },
    INVALID:            { ar:'راجع الأيام المحددة.',                        en:'Check the highlighted days.' },
    STALE:              { ar:'تم تعديل جدول العمل من جلسة أخرى. أعد التحميل ثم حاول مجددًا.',
                          en:'The opening schedule was changed in another session. Reload and try again.' },
    NO_CHANGES:         { ar:'لا توجد تغييرات لحفظها.',                    en:'There are no changes to save.' },
    PERSIST_FAILED:     { ar:'تعذّر الحفظ.',                                en:'Could not save.' }
  };
  var DAY_ERRORS = {
    STRUCTURE:          { ar:'بيانات الجدول غير صالحة.',                    en:'The schedule is not valid.' },
    MISSING_DAY:        { ar:'حدد إن كان هذا اليوم مفتوحًا أو مغلقًا.',     en:'Choose whether this day is open or closed.' },
    CLOSED_HAS_PERIODS: { ar:'اليوم المغلق لا يحتوي على فترات عمل.',        en:'A closed day cannot have opening periods.' },
    PERIODS_REQUIRED:   { ar:'أضف فترة عمل واحدة على الأقل.',               en:'Add at least one opening period.' },
    TOO_MANY_PERIODS:   { ar:'فترتان كحد أقصى في اليوم.',                   en:'A day can have at most two periods.' },
    OPEN_REQUIRED:      { ar:'اختر وقت الفتح.',                             en:'Choose an opening time.' },
    CLOSE_REQUIRED:     { ar:'اختر وقت الإغلاق.',                           en:'Choose a closing time.' },
    INVALID_TIME:       { ar:'وقت غير صالح.',                               en:'That time is not valid.' },
    SAME_TIME:          { ar:'وقت الفتح ووقت الإغلاق متطابقان.',            en:'Opening and closing times are the same.' },
    CLOSE_BEFORE_OPEN:  { ar:'يجب أن يكون الإغلاق بعد الفتح في اليوم نفسه — الدوام بعد منتصف الليل غير مدعوم.',
                          en:'Closing must be later than opening on the same day — hours past midnight are not supported.' },
    PERIOD_ORDER:       { ar:'يجب أن تبدأ الفترة الثانية بعد انتهاء الأولى.', en:'The second period must start after the first one ends.' },
    PERIOD_OVERLAP:     { ar:'الفترتان متداخلتان.',                         en:'The two periods overlap.' },
    PERIOD_TOUCH:       { ar:'اترك فاصلًا بين نهاية الفترة الأولى وبداية الثانية.',
                          en:'Leave a gap between the end of the first period and the start of the second.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  /* period: 0 or 1 when the problem belongs to one period, else null */
  function dayErr(day, code, period){
    var m = DAY_ERRORS[code];
    return { day:day, period:(period === undefined ? null : period), code:code, message:T(m.ar, m.en) };
  }

  /* ---------- 12-hour ↔ 24-hour, in one place ---------- */
  function pad(n){ return (n < 10 ? '0' : '') + n; }
  function isInt(v){ return typeof v === 'number' ? v % 1 === 0 : /^\d+$/.test(String(v)); }
  /* (h 1–12, m 0–59, 'am'|'pm') → 'HH:MM', or null. 12 AM is 00:00, 12 PM is 12:00. */
  function to24(h, m, period){
    if (!isInt(h) || !isInt(m)) return null;
    h = Number(h); m = Number(m);
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (period !== 'am' && period !== 'pm') return null;
    return pad((h % 12) + (period === 'pm' ? 12 : 0)) + ':' + pad(m);
  }
  /* 'HH:MM' → { h 1–12, m, period }, or null */
  function from24(s){
    if (typeof s !== 'string' || !HHMM.test(s)) return null;
    var H = Number(s.slice(0, 2)), m = Number(s.slice(3));
    return { h:(H % 12 === 0 ? 12 : H % 12), m:m, period:(H < 12 ? 'am' : 'pm') };
  }
  function langOf(l){ return l === 'en' ? 'en' : 'ar'; }
  /* display only: '10:00 PM' / '10:00 م' — never stored */
  function format12(s, lang){
    var t = from24(s); if (!t) return null;
    var p = langOf(lang) === 'en' ? (t.period === 'am' ? 'AM' : 'PM') : (t.period === 'am' ? 'ص' : 'م');
    return t.h + ':' + pad(t.m) + ' ' + p;
  }
  function minutes(s){ return (typeof s === 'string' && HHMM.test(s)) ? Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) : null; }

  /* ---------- validation, shared by the editor and the write ---------- */
  function blank(v){ return v === undefined || v === null || v === ''; }
  function onlyKeys(o, allowed){ return Object.keys(o).every(function (k) { return allowed.indexOf(k) >= 0; }); }
  /* the periods a day entry states, in either stored shape; null when it has none */
  function statedPeriods(e){
    if ('periods' in e) return e.periods;
    if ('open' in e || 'close' in e) return [{ open:e.open, close:e.close }];   /* earlier single-period day */
    return null;
  }
  function checkPeriod(d, i, p, errors){
    if (!p || typeof p !== 'object' || Array.isArray(p) || !onlyKeys(p, ['open','close'])) { errors.push(dayErr(d, 'STRUCTURE', i)); return null; }
    if (blank(p.open))  { errors.push(dayErr(d, 'OPEN_REQUIRED', i)); return null; }
    if (blank(p.close)) { errors.push(dayErr(d, 'CLOSE_REQUIRED', i)); return null; }
    var o = minutes(p.open), c = minutes(p.close);
    if (o === null || c === null) { errors.push(dayErr(d, 'INVALID_TIME', i)); return null; }
    if (o === c) { errors.push(dayErr(d, 'SAME_TIME', i)); return null; }
    if (c < o)   { errors.push(dayErr(d, 'CLOSE_BEFORE_OPEN', i)); return null; }
    return { o:o, c:c };
  }
  function checkDay(d, e, errors){
    if (!e || typeof e !== 'object' || Array.isArray(e)) { errors.push(dayErr(d, 'MISSING_DAY')); return; }
    if (e.closed === true) {
      if (Array.isArray(e.periods) && e.periods.length) { errors.push(dayErr(d, 'CLOSED_HAS_PERIODS')); return; }
      if (!onlyKeys(e, ['closed','periods']) || ('periods' in e && !Array.isArray(e.periods))) errors.push(dayErr(d, 'STRUCTURE'));
      return;
    }
    if ('closed' in e && e.closed !== false) { errors.push(dayErr(d, 'STRUCTURE')); return; }
    var shapeOk = 'periods' in e ? onlyKeys(e, ['closed','periods']) && Array.isArray(e.periods)
                                 : onlyKeys(e, ['closed','open','close']);
    if (!shapeOk) { errors.push(dayErr(d, 'STRUCTURE')); return; }
    var list = statedPeriods(e);
    if (!list || !list.length) { errors.push(dayErr(d, 'PERIODS_REQUIRED')); return; }
    if (list.length > MAX_PERIODS) { errors.push(dayErr(d, 'TOO_MANY_PERIODS')); return; }
    var ok = list.map(function (p, i) { return checkPeriod(d, i, p, errors); });
    if (ok.length === 2 && ok[0] && ok[1]) {
      if (ok[1].o < ok[0].o)       errors.push(dayErr(d, 'PERIOD_ORDER', 1));
      else if (ok[1].o < ok[0].c)  errors.push(dayErr(d, 'PERIOD_OVERLAP', 1));
      else if (ok[1].o === ok[0].c) errors.push(dayErr(d, 'PERIOD_TOUCH', 1));
    }
  }
  function validate(schedule){
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return { ok:false, errors:[dayErr(null, 'STRUCTURE')] };
    var errors = [];
    if (Object.keys(schedule).some(function (k) { return DAYS.indexOf(k) < 0; })) errors.push(dayErr(null, 'STRUCTURE'));
    DAYS.forEach(function (d) { checkDay(d, schedule[d], errors); });
    return { ok:errors.length === 0, errors:errors };
  }
  /* a validated schedule in the current `periods` shape; null when invalid */
  function normalize(schedule){
    if (!validate(schedule).ok) return null;
    var out = {};
    DAYS.forEach(function (d) {
      var e = schedule[d];
      out[d] = e.closed === true ? { closed:true }
             : { periods:statedPeriods(e).map(function (p) { return { open:p.open, close:p.close }; }) };
    });
    return out;
  }

  /* ---------- the one hours formatter (Arabic + English) ---------- */
  function formatPeriod(p, lang){ return format12(p.open, lang) + ' – ' + format12(p.close, lang); }
  /* one normalized day: 'Closed' or '10:00 AM – 2:00 PM, 5:00 PM – 11:00 PM' */
  function formatDay(entry, lang){
    lang = langOf(lang);
    if (!entry || entry.closed === true) return lang === 'en' ? 'Closed' : 'مغلق';
    return entry.periods.map(function (p) { return formatPeriod(p, lang); }).join(lang === 'en' ? ', ' : '، ');
  }
  function dayLabel(d, lang){ return langOf(lang) === 'en' ? DAY_NAMES[d].ab : DAY_NAMES[d].ar; }
  /* consecutive days (Saturday → Friday) whose complete schedules are identical */
  function groups(schedule){
    var n = normalize(schedule); if (!n) return null;
    var out = [];
    DAYS.forEach(function (d) {
      var key = JSON.stringify(n[d]), last = out[out.length - 1];
      if (last && last.key === key) { last.to = d; last.days.push(d); }
      else out.push({ key:key, from:d, to:d, days:[d], entry:n[d] });
    });
    return out.map(function (g) { return { from:g.from, to:g.to, days:g.days, entry:g.entry }; });
  }
  /* 'Sat–Thu: 10:00 AM – 2:00 PM, 5:00 PM – 11:00 PM · Fri: 2:00 PM – 11:00 PM' */
  function formatWeek(schedule, lang){
    var g = groups(schedule); if (!g) return null;
    lang = langOf(lang);
    return g.map(function (x) {
      var label = x.from === x.to ? dayLabel(x.from, lang) : dayLabel(x.from, lang) + '–' + dayLabel(x.to, lang);
      return label + ': ' + formatDay(x.entry, lang);
    }).join(' · ');
  }
  /* A store's customer-facing hours, generated from its schedule only.
     Public data — no actor needed. Unconfigured means no hours to show. */
  function publicHours(slug, lang){
    var s = (global.RAFSource && slug) ? RAFSource.store(slug) : null;
    var n = s && s.schedule ? normalize(s.schedule) : null;
    if (!n) return { configured:false, text:null };
    return { configured:true, text:formatWeek(n, lang), schedule:n };
  }

  /* ---------- calendar, next opening & delivery windows ----------
     Pure schedule knowledge. The caller supplies the Kuwait wall-clock
     (RAFStoreOps.kuwaitNow()); nothing here reads the viewer's clock. */
  var ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
  var WEEK = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];   /* Date#getDay order */
  function parseISO(s){
    var m = ISO.exec(typeof s === 'string' ? s : '');
    if (!m) return null;
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return (d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]) ? d : null;
  }
  function isoOf(wall){ return wall.getFullYear() + '-' + pad(wall.getMonth() + 1) + '-' + pad(wall.getDate()); }
  function addDays(iso, n){
    var d = parseISO(iso); if (!d) return null;
    d.setUTCDate(d.getUTCDate() + n);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }
  function dayKeyOf(iso){ var d = parseISO(iso); return d ? WEEK[d.getUTCDay()] : null; }
  function hhmm(t){ return pad(Math.floor(t / 60)) + ':' + pad(t % 60); }
  function wallMin(wall){ return wall.getHours() * 60 + wall.getMinutes(); }
  /* a calendar date's periods: [] when closed, null when unreadable */
  function periodsOn(schedule, iso){
    var n = normalize(schedule), k = dayKeyOf(iso);
    if (!n || !k) return null;
    return n[k].closed === true ? [] : n[k].periods;
  }
  /* the next period start strictly after `wall` — today, or on a later day of the week */
  function nextOpening(schedule, wall){
    var n = normalize(schedule);
    if (!n || !(wall instanceof Date)) return null;
    var today = isoOf(wall), m = wallMin(wall);
    for (var i = 0; i <= 7; i++) {
      var iso = addDays(today, i), e = n[dayKeyOf(iso)];
      if (e.closed === true) continue;
      for (var j = 0; j < e.periods.length; j++) {
        if (i === 0 && minutes(e.periods[j].open) <= m) continue;
        return { date:iso, day:dayKeyOf(iso), time:e.periods[j].open, daysAhead:i };
      }
    }
    return null;
  }
  /* A delivery-slot policy — { slotMinutes, horizonDays } — is NOT defined by
     RAF. Scheduling takes one as input and never assumes a value. */
  function validSlotPolicy(p){
    return !!(p && typeof p === 'object' && isInt(p.slotMinutes) && Number(p.slotMinutes) > 0 && Number(p.slotMinutes) <= 1440
              && isInt(p.horizonDays) && Number(p.horizonDays) > 0);
  }
  /* windows of exactly policy.slotMinutes lying wholly inside one period of
     that date — never across a gap, never past the close; for the current
     day only windows that have not started yet */
  function slotsFor(schedule, iso, policy, wall){
    if (!validSlotPolicy(policy)) return null;
    var list = periodsOn(schedule, iso);
    if (list === null) return null;
    var step = Number(policy.slotMinutes), out = [];
    var today = wall instanceof Date ? isoOf(wall) : null, m = wall instanceof Date ? wallMin(wall) : -1;
    if (today && iso < today) return [];
    list.forEach(function (p) {
      for (var s = minutes(p.open); s + step <= minutes(p.close); s += step) {
        if (iso === today && s <= m) continue;
        out.push({ start:hhmm(s), end:hhmm(s + step) });
      }
    });
    return out;
  }
  /* the dates a customer may choose: from today, within the policy's
     horizon, each with at least one window left — closed days never appear */
  function deliveryDates(schedule, policy, wall){
    if (!validSlotPolicy(policy) || !normalize(schedule) || !(wall instanceof Date)) return null;
    var today = isoOf(wall), out = [];
    for (var i = 0; i < Number(policy.horizonDays); i++) {
      var iso = addDays(today, i), s = slotsFor(schedule, iso, policy, wall);
      if (s && s.length) out.push({ date:iso, day:dayKeyOf(iso), slots:s });
    }
    return out;
  }
  function isValidWindow(schedule, iso, start, end, policy, wall){
    var d = deliveryDates(schedule, policy, wall);
    if (!d) return false;
    var day = d.filter(function (x) { return x.date === iso; })[0];
    return !!(day && day.slots.some(function (w) { return w.start === start && w.end === end; }));
  }

  /* ---------- delivery wording (Arabic + English, one place) ---------- */
  function formatDate(iso, lang){
    var d = parseISO(iso); if (!d) return null;
    try { return d.toLocaleDateString(langOf(lang) === 'en' ? 'en-GB' : 'ar-KW-u-nu-latn', { weekday:'long', day:'numeric', month:'long', timeZone:'UTC' }); }
    catch (e) { return iso; }
  }
  function formatWindow(w, lang){ return w ? formatPeriod({ open:w.start, close:w.end }, lang) : null; }
  function whenText(next, lang){
    lang = langOf(lang);
    var t = format12(next.time, lang);
    if (next.daysAhead === 0) return lang === 'en' ? 'today at ' + t : 'اليوم الساعة ' + t;
    if (next.daysAhead === 1) return lang === 'en' ? 'tomorrow at ' + t : 'غداً الساعة ' + t;
    return lang === 'en' ? 'on ' + DAY_NAMES[next.day].en + ' at ' + t : 'يوم ' + DAY_NAMES[next.day].ar + ' الساعة ' + t;
  }
  /* 'يفتح اليوم الساعة 5:00 م' · 'Opens tomorrow at 10:00 AM' */
  function formatNextOpening(next, lang){
    if (!next) return null;
    return (langOf(lang) === 'en' ? 'Opens ' : 'يفتح ') + whenText(next, lang);
  }
  /* what happens to an order placed while Instant Delivery is unavailable */
  function formatReceive(next, lang){
    lang = langOf(lang);
    if (!next) return lang === 'en' ? 'Your order will be received when the store next opens.' : 'سيتم استلام طلبك عند فتح المتجر القادم.';
    return lang === 'en' ? 'Your order will be received when the store opens ' + whenText(next, lang) + '.'
                         : 'سيتم استلام طلبك عند فتح المتجر ' + whenText(next, lang) + '.';
  }
  /* the delivery commitment frozen in an order snapshot — absolute dates,
     never re-derived from the store's current schedule */
  function formatCommitment(snap, lang){
    lang = langOf(lang);
    var d = snap && snap.delivery, t = d && d.timing;
    if (t === 'instant') return lang === 'en' ? 'Instant delivery' : 'توصيل فوري';
    if (t === 'scheduled' && snap.scheduled && snap.scheduled.date)
      return (lang === 'en' ? 'Scheduled delivery: ' : 'توصيل مجدول: ') + formatDate(snap.scheduled.date, lang)
        + ' · ' + formatWindow({ start:snap.scheduled.from, end:snap.scheduled.to }, lang);
    if (t === 'next_opening')
      return d.receiveAt && d.receiveAt.date
        ? (lang === 'en' ? 'Received when the store opens: ' : 'يُستلم عند فتح المتجر: ') + formatDate(d.receiveAt.date, lang) + ' · ' + format12(d.receiveAt.time, lang)
        : (lang === 'en' ? 'Received when the store next opens' : 'يُستلم عند فتح المتجر القادم');
    return null;
  }

  /* ---------- scope: the acting account's own store ---------- */
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
    try { return !!(RAFPerm.getUser(id) && RAFPerm.can(id, key)); } catch (e) { return false; }
  }
  function canView(actor){ return can('stores.view', actor); }
  function canEdit(actor){ return can('stores.edit', actor); }
  function versionOf(store){ return (store && store.scheduleUpdatedAt) || 0; }

  /* the store's schedule as the editor needs it, in the `periods` shape.
     A null or unreadable schedule is reported as not configured — never filled in. */
  function read(opts){
    opts = opts || {};
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!canView(sc.id)) return fail('FORBIDDEN');
    var n = sc.store.schedule ? normalize(sc.store.schedule) : null;
    return { ok:true, slug:sc.slug, editable:canEdit(sc.id), version:versionOf(sc.store),
             configured:!!n, schedule:n, updatedAt:sc.store.scheduleUpdatedAt || null };
  }

  function update(schedule, opts){
    opts = opts || {};
    if (['storeSlug', 'store', 'slug'].some(function (k) { return opts[k] !== undefined; })) return fail('FIELD_NOT_ACCEPTED');
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!canEdit(sc.id)) return fail('FORBIDDEN');

    /* the whole schedule is judged before anything is written */
    var v = validate(schedule);
    if (!v.ok) return fail('INVALID', { errors:v.errors });

    /* an edit made against an out-of-date reading is refused, never merged */
    if (opts.baseVersion !== undefined && opts.baseVersion !== versionOf(sc.store))
      return fail('STALE', { currentVersion:versionOf(sc.store) });

    var clean = normalize(schedule);
    var cur = sc.store.schedule ? normalize(sc.store.schedule) : null;
    var changed = DAYS.filter(function (d) { return !cur || JSON.stringify(cur[d]) !== JSON.stringify(clean[d]); });
    if (!changed.length) return fail('NO_CHANGES');

    var now = Date.now();
    if (!RAFSource.updateStore(sc.slug, { schedule:clean, scheduleUpdatedAt:now, scheduleUpdatedBy:sc.id }))
      return fail('PERSIST_FAILED');

    if (global.RAFAudit) {
      try {
        var u = RAFPerm.getUser(sc.id);
        RAFAudit.record({ action:'store.schedule_updated', storeSlug:sc.slug, source:'merchant',
          key:sc.slug + ':schedule:' + now, actor:{ id:sc.id, name:(u && u.name) || sc.id },
          metadata:{ days:changed, firstSetup:!cur } });
      } catch (e) {}
    }
    return { ok:true, changed:changed, version:now };
  }

  global.RAFStoreSchedule = {
    DAYS:DAYS, MAX_PERIODS:MAX_PERIODS, ERRORS:ERRORS,
    to24:to24, from24:from24, format12:format12, minutes:minutes,
    formatPeriod:formatPeriod, formatDay:formatDay, formatWeek:formatWeek, groups:groups, publicHours:publicHours,
    /* calendar, next opening & delivery windows */
    isoOf:isoOf, addDays:addDays, dayKeyOf:dayKeyOf, periodsOn:periodsOn, nextOpening:nextOpening,
    validSlotPolicy:validSlotPolicy, slotsFor:slotsFor, deliveryDates:deliveryDates, isValidWindow:isValidWindow,
    formatDate:formatDate, formatWindow:formatWindow, formatNextOpening:formatNextOpening,
    formatReceive:formatReceive, formatCommitment:formatCommitment,
    canView:canView, canEdit:canEdit,
    validate:validate, normalize:normalize, read:read, update:update
  };
})(window);
