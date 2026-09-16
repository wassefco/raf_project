/* ============================================================================
 * RAF Marketplace — DRIVER PERFORMANCE WIDGET  (RAFPerfUI) — Phase G
 * ----------------------------------------------------------------------------
 * Presentation only, for the MANAGEMENT surfaces (Logistics Management and
 * Driver Management). Every figure comes from RAFDriverPerformance (which
 * derives it from the existing authorities) and every rating detail from
 * RAFDriverRating. This file owns no record, stores nothing, counts nothing
 * and decides no permission — the authority refuses a caller who may not read.
 *
 *   RAFPerfUI.mount(el, { onRender })   management comparison + drill-down
 *
 * RULES IT RENDERS UNDER
 *   · factual reporting only — no score, percentage, tier, rank or leaderboard;
 *   · drivers are listed alphabetically by name, never ordered by a metric;
 *   · rating count / distribution / comments / history are MANAGEMENT-ONLY
 *     (the Driver App shows the total alone — it never mounts this widget);
 *   · Total Rating is all-time and does not change with the period;
 *   · periods are Today / Week / Month / Custom in RAF's configured timezone.
 *
 * Live refresh: RAFEventBus only (claims, skips, deliveries, reassignment,
 * exceptions, availability, overtime, ratings, config). No polling, no timers.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFPerfUI) return;

  var MOUNTS = [], SAVED = null, subscribed = false;
  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function when(ms){
    if (ms == null) return '—';
    try { return new Date(ms).toLocaleString(isEn() ? 'en-GB' : 'ar-KW-u-nu-latn', { timeZone:'Asia/Kuwait', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
    catch (e) { return new Date(ms).toISOString(); }
  }
  /* durations are shown as hours and minutes; "not available" is never 0 */
  function hm(ms){
    if (ms == null) return T('غير متاح', 'Not available');
    var m = Math.floor(ms / 60000);
    return T(Math.floor(m / 60) + ' س ' + (m % 60) + ' د', Math.floor(m / 60) + 'h ' + (m % 60) + 'm');
  }

  var COLS = [
    ['claims',               'السحب الناجح',            'Successful claims'],
    ['deliveries',           'التوصيلات المكتملة',       'Completed deliveries'],
    ['lostOwnership',        'نُقلت منه',                'Reassigned / lost ownership'],
    ['skips',                'التخطي',                   'Skips'],
    ['reassignmentRequests', 'طلبات إعادة الإسناد',      'Reassignment requests'],
    ['exceptions',           'الاستثناءات',              'Exceptions'],
    ['workingMs',            'ساعات العمل',              'Working hours'],
    ['basicMs',              'الساعات الأساسية',         'Basic hours'],
    ['overtimeMs',           'العمل الإضافي',            'Overtime'],
    ['rating',               'التقييم الكلي (كل الفترات)', 'Total rating (all time)']
  ];
  var STYLE = [
    '.pfu{font-size:13.5px;color:var(--ink,#1F1B14);line-height:1.6}',
    '.pfu *{box-sizing:border-box}',
    '.pfu-note{font-size:12.5px;color:var(--faint,#6B6457);margin:0 0 10px}',
    '.pfu-tools{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:10px}',
    '.pfu-periods{display:flex;flex-wrap:wrap;gap:6px}',
    '.pfu-b{min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit;font:inherit;font-weight:800;cursor:pointer}',
    '.pfu-b[aria-pressed="true"]{background:var(--ink,#1F1B14);border-color:var(--ink,#1F1B14);color:#F5F0E4}',
    '.pfu-b:focus-visible,.pfu input:focus-visible{outline:2px solid var(--accent,#C9A84C);outline-offset:2px}',
    '.pfu-f{display:flex;flex-direction:column;gap:4px;font-size:12px;font-weight:800;color:var(--faint,#6B6457);flex:1 1 150px;min-width:0}',
    '.pfu input[type="date"]{min-height:44px;border-radius:12px;border:1px solid var(--line,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit;font:inherit;padding:0 10px;width:100%}',
    '.pfu-pick{border:0;margin:0 0 10px;padding:0;display:flex;flex-wrap:wrap;gap:4px 14px}',
    '.pfu-pick legend{font-size:12.5px;font-weight:800;color:var(--faint,#6B6457);padding:0;margin-bottom:4px}',
    '.pfu-pick label{display:inline-flex;align-items:center;gap:8px;min-height:44px;cursor:pointer}',
    '.pfu-pick input{width:20px;height:20px}',
    '.pfu-wrap{overflow-x:auto;border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px}',
    '.pfu-wrap:focus-visible{outline:2px solid var(--accent,#C9A84C);outline-offset:2px}',
    '.pfu-t{border-collapse:collapse;width:100%;font-size:13px}',
    '.pfu-t th,.pfu-t td{padding:9px 12px;border-bottom:1px solid var(--line,rgba(0,0,0,.12));text-align:start;white-space:nowrap}',
    '.pfu-t thead th{background:var(--surface-2,#F6F5F1);font-weight:800}',
    '.pfu-t tbody th{color:var(--faint,#6B6457);font-weight:800}',
    '.pfu-t tbody tr:last-child th,.pfu-t tbody tr:last-child td{border-bottom:0}',
    '.pfu-mute{color:var(--faint,#6B6457);font-weight:600;font-size:12px}',
    '.pfu-card{border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px;padding:12px 14px;margin-top:12px;background:var(--surface,#fff)}',
    '.pfu-card h3{margin:0 0 8px;font-size:14.5px}',
    '.pfu-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px 16px;margin:0}',
    '.pfu-kv dt{font-size:11.5px;font-weight:800;color:var(--faint,#6B6457)}',
    '.pfu-kv dd{margin:0 0 6px;font-weight:700;overflow-wrap:anywhere}',
    '.pfu-hist{list-style:none;margin:8px 0 0;padding:0;font-size:12.5px;max-height:260px;overflow:auto}',
    '.pfu-hist li{padding:5px 0;border-top:1px dashed var(--line,rgba(0,0,0,.12));overflow-wrap:anywhere;white-space:normal}',
    '.pfu-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}',
    '.pfu-msg{padding:14px;border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px;color:var(--faint,#6B6457)}'
  ].join('');
  function injectStyle(){
    if (document.getElementById('rafPerfUIStyle')) return;
    var s = document.createElement('style'); s.id = 'rafPerfUIStyle'; s.textContent = STYLE; document.head.appendChild(s);
  }

  function spec(m){ return m.preset === 'custom' ? { preset:'custom', from:m.from, to:m.to } : { preset:m.preset }; }
  function cell(metrics, key){
    if (key === 'workingMs' || key === 'basicMs' || key === 'overtimeMs') return esc(hm(metrics[key]));
    if (key === 'rating') {
      var r = metrics.rating;
      return r && r.total != null
        ? '<bdi dir="ltr">' + esc(r.total.toFixed(1)) + ' / 5</bdi> <span class="pfu-mute">(<bdi>' + esc(r.count) + '</bdi>)</span>'
        : esc(T('لا يوجد', 'None'));
    }
    return '<bdi>' + esc(metrics[key]) + '</bdi>';
  }

  function paintManagement(m){
    var P = global.RAFDriverPerformance;
    if (!P) return '<div class="pfu"><div class="pfu-msg">' + esc(T('خدمة الأداء غير محمّلة.', 'The performance service is not loaded.')) + '</div></div>';
    var h = '<div class="pfu"><p class="pfu-note">' + esc(T('أرقام للاطلاع فقط من سجلات رف الفعلية بتوقيت الكويت. لا توجد درجة ولا ترتيب؛ السائقون مرتبون بالاسم. التقييم الكلي يشمل كل التقييمات السابقة ولا يتغيّر بتغيير الفترة.',
      'Read-only figures from RAF’s actual records in Kuwait time. No score and no ranking; drivers are listed by name. The total rating covers all past ratings and does not change with the period.')) + '</p>';
    h += '<div class="pfu-tools"><div class="pfu-periods" role="group" aria-label="' + esc(T('الفترة', 'Period')) + '">'
      + [['today', 'اليوم', 'Today'], ['week', 'الأسبوع', 'Week'], ['month', 'الشهر', 'Month'], ['custom', 'مخصصة', 'Custom']].map(function (x) {
          return '<button type="button" class="pfu-b" aria-pressed="' + (m.preset === x[0]) + '" data-act="preset" data-k="' + x[0] + '">' + esc(T(x[1], x[2])) + '</button>'; }).join('')
      + '</div></div>';
    if (m.preset === 'custom')
      h += '<div class="pfu-tools"><label class="pfu-f">' + esc(T('من', 'From')) + '<input type="date" dir="ltr" data-act="from" value="' + esc(m.from) + '"></label>'
        + '<label class="pfu-f">' + esc(T('إلى', 'To')) + '<input type="date" dir="ltr" data-act="to" value="' + esc(m.to) + '"></label></div>';
    if (m.preset === 'custom' && (!m.from || !m.to))
      return h + '<div class="pfu-msg">' + esc(T('اختر تاريخ البداية والنهاية.', 'Choose a start and end date.')) + '</div></div>';
    var r = P.compare({ period:spec(m) });
    if (!r.ok) return h + '<div class="pfu-msg" role="status">' + esc(r.message) + '</div></div>';
    /* alphabetical by name — a list, not a ranking */
    var all = r.drivers.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    if (!all.length) return h + '<div class="pfu-msg">' + esc(T('لا توجد حسابات سائقين.', 'There are no driver accounts.')) + '</div></div>';
    if (!m.selected) { m.selected = {}; all.forEach(function (d) { m.selected[d.driverId] = true; }); }
    h += '<fieldset class="pfu-pick"><legend>' + esc(T('السائقون في المقارنة', 'Drivers in the comparison')) + '</legend>'
      + all.map(function (d) {
          return '<label><input type="checkbox" data-act="pick" data-id="' + esc(d.driverId) + '" ' + (m.selected[d.driverId] ? 'checked' : '') + '> '
            + esc(d.name) + (d.accountStatus !== 'active' ? ' <span class="pfu-mute">(' + esc(T('موقوف', 'suspended')) + ')</span>' : '') + '</label>'; }).join('')
      + '</fieldset>';
    var list = all.filter(function (d) { return m.selected[d.driverId]; });
    if (!list.length) return h + '<div class="pfu-msg">' + esc(T('اختر سائقًا واحدًا على الأقل.', 'Select at least one driver.')) + '</div></div>';
    h += '<div class="pfu-wrap" role="region" tabindex="0" aria-label="' + esc(T('جدول المقارنة', 'Comparison table')) + '"><table class="pfu-t"><thead><tr><th scope="col">'
      + esc(T('المؤشر', 'Metric')) + '</th>' + list.map(function (d) { return '<th scope="col">' + esc(d.name) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + COLS.map(function (c) {
          return '<tr><th scope="row">' + esc(T(c[1], c[2])) + '</th>' + list.map(function (d) { return '<td>' + cell(d.metrics, c[0]) + '</td>'; }).join('') + '</tr>'; }).join('')
      + '<tr><th scope="row">' + esc(T('التفاصيل', 'Details')) + '</th>' + list.map(function (d) {
          return '<td><button type="button" class="pfu-b" data-act="open" data-id="' + esc(d.driverId) + '" aria-expanded="' + (m.open === d.driverId) + '">'
            + esc(T('عرض', 'View')) + '</button></td>'; }).join('') + '</tr></tbody></table></div>';
    if (list.some(function (d) { return d.metrics.openSession; }))
      h += '<p class="pfu-note" style="margin-top:8px">' + esc(T('الجلسات المفتوحة محسوبة حتى وقت العرض.', 'Open sessions are counted up to the time shown.')) + '</p>';
    if (m.open && m.selected[m.open]) h += detail(m, m.open);
    return h + '</div>';
  }
  /* management drill-down: breakdowns + the rating detail managers may see */
  function detail(m, id){
    var r = global.RAFDriverPerformance.detail(id, { period:spec(m) });
    if (!r.ok) return '<div class="pfu-card" role="status">' + esc(r.message) + '</div>';
    var b = r.metrics.breakdown, rt = r.metrics.rating;
    var h = '<div class="pfu-card"><div class="pfu-row"><h3>' + esc(r.name)
      + (r.accountStatus !== 'active' ? ' <span class="pfu-mute">(' + esc(T('موقوف', 'suspended')) + ')</span>' : '') + '</h3>'
      + '<button type="button" class="pfu-b" data-act="close">' + esc(T('إغلاق', 'Close')) + '</button></div>'
      + '<dl class="pfu-kv">'
      + '<div><dt>' + esc(T('نُقلت منه', 'Lost ownership')) + '</dt><dd>' + esc(T('إعادة إسناد: ', 'Reassigned: ')) + '<bdi>' + b.lostOwnership.reassigned + '</bdi> · '
        + esc(T('إرجاع للقائمة: ', 'Returned to pool: ')) + '<bdi>' + b.lostOwnership.returnedToPool + '</bdi></dd></div>'
      + '<div><dt>' + esc(T('طلبات إعادة الإسناد', 'Reassignment requests')) + '</dt><dd>'
        + esc(T('معلّقة ', 'Pending ')) + '<bdi>' + b.reassignmentRequests.pending + '</bdi> · ' + esc(T('ملغاة ', 'Cancelled ')) + '<bdi>' + b.reassignmentRequests.cancelled + '</bdi> · '
        + esc(T('مقبولة (إعادة إسناد) ', 'Approved (reassigned) ')) + '<bdi>' + b.reassignmentRequests.approved_reassigned + '</bdi> · '
        + esc(T('مقبولة (إرجاع) ', 'Approved (returned) ')) + '<bdi>' + b.reassignmentRequests.approved_returned_to_pool + '</bdi> · '
        + esc(T('مرفوضة ', 'Rejected ')) + '<bdi>' + b.reassignmentRequests.rejected + '</bdi></dd></div>'
      + '<div><dt>' + esc(T('الاستثناءات حسب من فتحها', 'Exceptions by opener')) + '</dt><dd>' + esc(T('السائق: ', 'Driver: ')) + '<bdi>' + b.exceptionsOpenedBy.driver + '</bdi> · '
        + esc(T('الفريق: ', 'Staff: ')) + '<bdi>' + b.exceptionsOpenedBy.staff + '</bdi></dd></div>'
      + '<div><dt>' + esc(T('جلسات العمل في الفترة', 'Work sessions in period')) + '</dt><dd><bdi>' + b.sessionsInPeriod + '</bdi>'
        + (b.sessionsWithoutRecordedEnd ? ' <span class="pfu-mute">(' + esc(T('بلا نهاية مسجّلة: ', 'without a recorded end: ')) + '<bdi>' + b.sessionsWithoutRecordedEnd + '</bdi>)</span>' : '') + '</dd></div>'
      + '</dl>';
    h += '<h3 style="margin-top:12px">' + esc(T('تقييم العملاء (كل الفترات)', 'Customer rating (all time)')) + '</h3>';
    if (!rt || rt.unavailable) h += '<p class="pfu-note">' + esc(T('خدمة التقييم غير متاحة.', 'The rating service is not available.')) + '</p>';
    else if (!rt.count) h += '<p class="pfu-note">' + esc(T('لا توجد تقييمات بعد.', 'No ratings yet.')) + '</p>';
    else {
      h += '<dl class="pfu-kv"><div><dt>' + esc(T('التقييم الكلي', 'Total')) + '</dt><dd><bdi dir="ltr">' + esc(rt.total.toFixed(1)) + ' / 5</bdi></dd></div>'
        + '<div><dt>' + esc(T('عدد التقييمات', 'Ratings')) + '</dt><dd><bdi>' + esc(rt.count) + '</bdi></dd></div>'
        + '<div><dt>' + esc(T('التوزيع', 'Distribution')) + '</dt><dd>' + [5, 4, 3, 2, 1].map(function (s) { return '<bdi dir="ltr">' + s + '★ ' + esc(rt.distribution[s]) + '</bdi>'; }).join(' · ') + '</dd></div>'
        + '</dl><ul class="pfu-hist" aria-label="' + esc(T('سجل التقييمات', 'Rating history')) + '">'
        + rt.history.map(function (x) {
            return '<li><bdi dir="ltr">' + esc(x.rating) + '★</bdi> · <bdi>' + esc(x.orderId) + '</bdi> · <bdi>' + esc(when(x.at)) + '</bdi>'
              + (x.comment ? ' · <bdi>' + esc(x.comment) + '</bdi>' : '') + '</li>'; }).join('') + '</ul>';
    }
    return h + '</div>';
  }

  function paint(m){
    if (!m.el.isConnected) return false;
    var a = document.activeElement;
    if (a && m.el.contains(a) && a.getAttribute && (a.getAttribute('data-act') === 'from' || a.getAttribute('data-act') === 'to')) return true;  /* never repaint under a date being typed */
    m.el.innerHTML = paintManagement(m);
    if (typeof m.onRender === 'function') { try { m.onRender(m.el); } catch (e) {} }
    return true;
  }
  function onClick(m, ev){
    var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b || !m.el.contains(b)) return;
    var act = b.getAttribute('data-act');
    if (act === 'preset') { m.preset = b.getAttribute('data-k'); m.open = null; }
    else if (act === 'pick') { if (!m.selected) m.selected = {}; var id = b.getAttribute('data-id'); m.selected[id] = b.checked; if (!b.checked && m.open === id) m.open = null; }
    else if (act === 'open') { var t = b.getAttribute('data-id'); m.open = m.open === t ? null : t; }
    else if (act === 'close') { m.open = null; }
    else return;
    paint(m);
  }
  function mount(el, opts){
    if (!el) return null;
    opts = opts || {};
    injectStyle();
    MOUNTS = MOUNTS.filter(function (x) { return x.el.isConnected && x.el !== el; });
    var prev = el.__perfMount || SAVED;
    var m = { el:el, onRender:opts.onRender, preset:'today', from:'', to:'', selected:null, open:null };
    if (prev) ['preset', 'from', 'to', 'selected', 'open'].forEach(function (k) { m[k] = prev[k]; });
    if (!el.__perfMount) {
      el.addEventListener('click', function (ev) { onClick(el.__perfMount, ev); });
      el.addEventListener('change', function (ev) {
        var x = el.__perfMount, act = ev.target.getAttribute && ev.target.getAttribute('data-act');
        if (act === 'from' || act === 'to') { x[act] = ev.target.value; paint(x); }
        else if (act === 'pick') onClick(x, ev);
      });
    }
    el.__perfMount = m; SAVED = m;
    MOUNTS.push(m);
    if (!subscribed && global.RAFEventBus) {
      subscribed = true;
      /* the operational facts behind every metric; the widget re-reads the
         authority, never the payload. No polling, no timers. */
      ['ownership.*', 'order.changed', 'driver.*', 'logistics.delivery.*', 'logistics.exception.*', 'config.changed'].forEach(function (p) {
        RAFEventBus.subscribe(p, refresh);
      });
    }
    paint(m);
    return m;
  }
  function refresh(){ MOUNTS = MOUNTS.filter(function (m) { return paint(m); }); }

  global.RAFPerfUI = { mount:mount, refresh:refresh };
})(window);
