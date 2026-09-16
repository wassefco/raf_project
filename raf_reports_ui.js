/* ============================================================================
 * RAF Marketplace — REPORTS CENTER WIDGET  (RAFReportsUI) — Phase J
 * ----------------------------------------------------------------------------
 * Presentation only. It calls RAFReports and renders what comes back: the
 * report selector, the filter bar, the summary tiles, the table, the empty /
 * NOT_CONFIGURED / error states, CSV export and print. It reads no storage,
 * writes nothing and makes no authorisation decision — RAFReports refuses a
 * caller it may not serve, and this widget renders that refusal.
 *
 *   RAFReportsUI.mount(el, { onRender })
 *
 * Live refresh: RAFEventBus only (order, ownership, logistics, driver,
 * communication, compensation, audit, config). No polling, no setInterval.
 * Search, sort, filter, export and print never write.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFReportsUI) return;

  var MOUNTS = [], SAVED = null, subscribed = false;
  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  var TIME_KEYS = /(At|Deadline|timestamp)$/;
  function when(ms){
    if (ms == null || ms === '') return '—';
    try { return new Date(ms).toLocaleString(isEn() ? 'en-GB' : 'ar-KW-u-nu-latn', { timeZone:'Asia/Kuwait', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
    catch (e) { return String(ms); }
  }
  function val(row, key){
    var x = row[key];
    if (x == null || x === '') return '—';
    if (TIME_KEYS.test(key) && typeof x === 'number') return when(x);
    return x;
  }

  var STYLE = [
    '.rp{font-size:13.5px;color:var(--ink,#1F1B14);line-height:1.6}',
    '.rp *{box-sizing:border-box}',
    '.rp-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}',
    '.rp-b{min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit;font:inherit;font-weight:800;cursor:pointer}',
    '.rp-b[aria-pressed="true"],.rp-b.on{background:var(--ink,#1F1B14);border-color:var(--ink,#1F1B14);color:#F5F0E4}',
    '.rp-b[disabled]{opacity:.5;cursor:not-allowed}',
    '.rp-b:focus-visible,.rp input:focus-visible,.rp select:focus-visible{outline:2px solid var(--accent,#C9A84C);outline-offset:2px}',
    '.rp-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:10px;padding:10px;border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px;background:var(--surface-2,#F6F5F1)}',
    '.rp-f{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:800;color:var(--faint,#6B6457);flex:1 1 150px;min-width:0}',
    '.rp input,.rp select{min-height:44px;border-radius:12px;border:1px solid var(--line,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit;font:inherit;padding:0 10px;width:100%;max-width:100%}',
    '.rp-periods{display:flex;flex-wrap:wrap;gap:6px}',
    '.rp-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;margin-bottom:10px}',
    '.rp-s{border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px;padding:10px 12px;background:var(--surface,#fff);min-width:0}',
    '.rp-s span{display:block;font-size:11.5px;font-weight:700;color:var(--faint,#6B6457)}',
    '.rp-s b{display:block;font-size:19px;font-weight:800;margin-top:2px;overflow-wrap:anywhere}',
    '.rp-s small{display:block;font-size:10.5px;color:var(--faint,#6B6457);margin-top:3px;overflow-wrap:anywhere}',
    '.rp-s.na b,.rp-s.nc b{font-size:13px;color:var(--faint,#6B6457)}',
    '.rp-wrap{overflow-x:auto;border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px}',
    '.rp-wrap:focus-visible{outline:2px solid var(--accent,#C9A84C);outline-offset:2px}',
    '.rp-t{border-collapse:collapse;width:100%;font-size:12.5px}',
    '.rp-t th,.rp-t td{padding:8px 11px;border-bottom:1px solid var(--line,rgba(0,0,0,.12));text-align:start;white-space:nowrap}',
    '.rp-t thead th{background:var(--surface-2,#F6F5F1);font-weight:800;position:sticky;top:0}',
    '.rp-t thead th button{background:none;border:0;font:inherit;font-weight:800;cursor:pointer;color:inherit;padding:0;min-height:32px}',
    '.rp-t tbody tr:nth-child(2n) td{background:rgba(0,0,0,.02)}',
    '.rp-msg{padding:18px;text-align:center;color:var(--faint,#6B6457);border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px}',
    '.rp-msg.err{color:#A8322E;border-color:rgba(217,83,79,.45)}',
    '.rp-note{font-size:12px;color:var(--faint,#6B6457);margin:8px 0 0}',
    '.rp-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px}',
    '.rp-count{font-size:12.5px;font-weight:800;color:var(--faint,#6B6457)}',
    '@media print{.rp-tabs,.rp-bar,.rp-actions{display:none!important}.rp-wrap{overflow:visible;border:0}.rp-t th,.rp-t td{white-space:normal}.rp-t thead th{position:static}}'
  ].join('');
  function injectStyle(){
    if (document.getElementById('rafReportsUIStyle')) return;
    var s = document.createElement('style'); s.id = 'rafReportsUIStyle'; s.textContent = STYLE; document.head.appendChild(s);
  }

  /* the filters each report actually supports — never offered without data behind them */
  var FILTERS_BY_REPORT = {
    overview:      ['storeSlug'],
    orders:        ['storeSlug', 'status', 'driverId', 'customerId', 'orderId'],
    deliveries:    ['storeSlug', 'status', 'driverId', 'orderId'],
    drivers:       ['driverId'],
    performance:   ['driverId'],
    exceptions:    ['storeSlug', 'category', 'status', 'sla', 'driverId', 'orderId'],
    reassignments: ['storeSlug', 'driverId', 'orderId', 'reassignmentState'],
    communication: ['storeSlug', 'communicationType', 'orderId'],
    compensation:  ['storeSlug', 'status', 'customerId', 'orderId'],
    audit:         ['storeSlug', 'action', 'orderId', 'employeeId']
  };
  var CHOICES = {
    status: { orders:['progress', 'delivered', 'cancelled'], deliveries:['progress', 'delivered', 'cancelled'],
              exceptions:['open', 'escalated', 'closed'], compensation:['issued', 'in_wallet', 'consumed', 'expired', 'voided', 'reversed'] },
    sla: { exceptions:['on_track', 'approaching', 'breached'] },
    reassignmentState: { reassignments:['reassignment', 'returned_to_pool', 'submitted', 'approved', 'rejected', 'cancelled'] },
    communicationType: { communication:['text', 'image', 'voice', 'call'] }
  };
  function optionsFor(kind, reportId, m){
    if (kind === 'driverId') return (m.lists.drivers || []).map(function (d) { return [d.id, d.name]; });
    if (kind === 'storeSlug') return (m.lists.stores || []).map(function (s) { return [s, s]; });
    if (kind === 'action') return (m.lists.actions || []).map(function (a) { return [a, a]; });
    var set = (CHOICES[kind] || {})[reportId];
    return set ? set.map(function (s) { return [s, s]; }) : null;
  }
  var LABELS = { storeSlug:['المتجر', 'Store'], driverId:['السائق', 'Driver'], orderId:['رقم الطلب', 'Order'],
    status:['الحالة', 'Status'], category:['فئة الاستثناء', 'Exception category'], sla:['حالة SLA', 'SLA state'],
    reassignmentState:['حالة إعادة الإسناد', 'Reassignment state'], communicationType:['نوع التواصل', 'Communication type'],
    customerId:['العميل', 'Customer'], employeeId:['الموظف', 'Employee'], action:['الإجراء', 'Action'] };

  function collectLists(m){
    /* the option lists come from what the authority already returned, plus the
       driver accounts RAFPerm exposes — never invented values */
    var lists = { drivers:[], stores:[], actions:[] };
    try { lists.drivers = RAFPerm.getUsers().filter(function (u) { return u.roleId === 'driver'; }).map(function (u) { return { id:u.id, name:u.name }; }); } catch (e) {}
    var seenStore = {}, seenAction = {};
    (m.result && m.result.rows || []).forEach(function (r) {
      if (r.storeSlug && !seenStore[r.storeSlug]) { seenStore[r.storeSlug] = 1; lists.stores.push(r.storeSlug); }
      if (r.action && !seenAction[r.action]) { seenAction[r.action] = 1; lists.actions.push(r.action); }
    });
    lists.actions.sort();
    m.lists = lists;
  }

  function filterBar(m, reportId){
    var h = '<div class="rp-bar">';
    h += '<div class="rp-f"><span>' + esc(T('الفترة', 'Period')) + '</span><div class="rp-periods">'
      + [['today', 'اليوم', 'Today'], ['week', 'الأسبوع', 'Week'], ['month', 'الشهر', 'Month'], ['custom', 'مخصصة', 'Custom']].map(function (x) {
          return '<button type="button" class="rp-b" aria-pressed="' + (m.preset === x[0]) + '" data-act="preset" data-k="' + x[0] + '">' + esc(T(x[1], x[2])) + '</button>'; }).join('')
      + '</div></div>';
    if (m.preset === 'custom')
      h += '<label class="rp-f"><span>' + esc(T('من', 'From')) + '</span><input type="date" dir="ltr" data-act="from" value="' + esc(m.from) + '"></label>'
        + '<label class="rp-f"><span>' + esc(T('إلى', 'To')) + '</span><input type="date" dir="ltr" data-act="to" value="' + esc(m.to) + '"></label>';
    (FILTERS_BY_REPORT[reportId] || []).forEach(function (k) {
      var opts = optionsFor(k, reportId, m), lab = LABELS[k] || [k, k];
      if (opts && opts.length) {
        h += '<label class="rp-f"><span>' + esc(T(lab[0], lab[1])) + '</span><select data-act="filter" data-k="' + k + '"><option value="all">' + esc(T('الكل', 'All')) + '</option>'
          + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (m.filters[k] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
      } else if (!opts) {
        h += '<label class="rp-f"><span>' + esc(T(lab[0], lab[1])) + '</span><input type="text" data-act="filtertext" data-k="' + k + '" value="' + esc(m.filters[k] || '') + '" placeholder="' + esc(T('اختياري', 'optional')) + '"></label>';
      }
    });
    h += '<label class="rp-f"><span>' + esc(T('بحث', 'Search')) + '</span><input type="search" data-act="search" value="' + esc(m.filters.search || '') + '" placeholder="' + esc(T('ابحث في النتائج', 'search the results')) + '"></label>';
    return h + '</div>';
  }
  function summaryTiles(result){
    if (!result.summary || !result.summary.length) return '';
    return '<div class="rp-sum">' + result.summary.map(function (s) {
      var v = s.value, state = s.state || (v && v.notAvailable ? 'NOT_AVAILABLE' : (v && v.notConfigured ? 'NOT_CONFIGURED' : null));
      var shown = state && (v == null || typeof v === 'object') ? state : v;
      return '<div class="rp-s' + (state === 'NOT_AVAILABLE' ? ' na' : state === 'NOT_CONFIGURED' ? ' nc' : '') + '">'
        + '<span>' + esc(T(s.ar, s.en)) + '</span><b><bdi>' + esc(shown) + '</bdi></b>'
        + (s.source ? '<small>' + esc(s.source) + '</small>' : '') + '</div>'; }).join('') + '</div>';
  }
  function table(m, result){
    if (!result.rows.length)
      return '<div class="rp-msg">' + esc(m.filters.search
        ? T('لا نتائج مطابقة لبحثك ضمن هذه الفترة.', 'No results match your search in this period.')
        : T('لا توجد بيانات في هذه الفترة.', 'There is no data in this period.')) + '</div>';
    var rows = result.rows.slice();
    if (m.sort && result.columns.some(function (c) { return c.key === m.sort; })) {
      var dir = m.sortDir === 'desc' ? -1 : 1, k = m.sort;
      rows.sort(function (a, b) {
        var x = a[k], y = b[k];
        if (x == null) return 1; if (y == null) return -1;
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y)) * dir;
      });
    }
    return '<div class="rp-wrap" role="region" tabindex="0" aria-label="' + esc(T('جدول التقرير', 'Report table')) + '"><table class="rp-t"><thead><tr>'
      + result.columns.map(function (c) {
          return '<th scope="col"><button type="button" data-act="sort" data-k="' + esc(c.key) + '">' + esc(T(c.ar, c.en))
            + (m.sort === c.key ? (m.sortDir === 'desc' ? ' ▾' : ' ▴') : '') + '</button></th>'; }).join('')
      + '</tr></thead><tbody>' + rows.map(function (r) {
          return '<tr>' + result.columns.map(function (c) { return '<td><bdi>' + esc(val(r, c.key)) + '</bdi></td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table></div>';
  }

  function paintInner(m){
    var R = global.RAFReports;
    if (!R) return '<div class="rp"><div class="rp-msg err">' + esc(T('خدمة التقارير غير محمّلة.', 'The reports service is not loaded.')) + '</div></div>';
    var h = '<div class="rp"><div class="rp-tabs" role="group" aria-label="' + esc(T('التقارير', 'Reports')) + '">'
      + R.REPORTS.map(function (r) { return '<button type="button" class="rp-b" aria-pressed="' + (m.report === r.id) + '" data-act="report" data-k="' + r.id + '">' + esc(T(r.ar, r.en)) + '</button>'; }).join('')
      + '</div>';
    var spec = m.preset === 'custom' ? { preset:'custom', from:m.from, to:m.to } : { preset:m.preset };
    var args = { period:spec };
    (FILTERS_BY_REPORT[m.report] || []).forEach(function (k) { if (m.filters[k]) args[k] = m.filters[k]; });
    if (m.filters.search) args.search = m.filters.search;
    if (m.preset === 'custom' && (!m.from || !m.to)) {
      m.result = null; collectLists(m);
      return h + filterBar(m, m.report) + '<div class="rp-msg">' + esc(T('اختر تاريخ البداية والنهاية.', 'Choose a start and end date.')) + '</div></div>';
    }
    var res = R.run(m.report, args);
    m.result = res.ok ? res : null;
    collectLists(m);
    h += filterBar(m, m.report);
    if (!res.ok) {
      var nc = res.code === 'NO_STORE_LINK';
      return h + '<div class="rp-msg ' + (nc ? '' : 'err') + '" role="status"><b>' + esc(nc ? 'NOT_AVAILABLE' : res.code) + '</b><br>' + esc(res.message) + '</div></div>';
    }
    h += '<div class="rp-head"><span class="rp-count">' + esc(T('النتائج: ', 'Results: ')) + '<bdi>' + res.count + '</bdi>'
      + (res.scope.storeBound ? ' · ' + esc(T('نطاق متجرك: ', 'Your store scope: ')) + '<bdi>' + esc(res.scope.storeSlug) + '</bdi>' : '') + '</span>'
      + '<span class="rp-actions">'
      + '<button type="button" class="rp-b" data-act="csv"' + (res.canExport && res.rows.length ? '' : ' disabled') + '>' + esc(T('تصدير CSV', 'Export CSV')) + '</button> '
      + '<button type="button" class="rp-b" data-act="print">' + esc(T('طباعة', 'Print')) + '</button></span></div>';
    h += summaryTiles(res) + table(m, res);
    (res.notes || []).forEach(function (n) { h += '<p class="rp-note">' + esc(n) + '</p>'; });
    h += '<p class="rp-note">' + esc(T('الفترة بتوقيت الكويت: ', 'Period in Kuwait time: ')) + esc(when(res.period.start)) + ' → ' + esc(when(res.period.end)) + '</p>';
    if (m.notice) h += '<p class="rp-note" role="status"><b>' + esc(m.notice) + '</b></p>';
    return h + '</div>';
  }
  function paint(m, force){
    if (!m.el.isConnected) return false;
    var a = document.activeElement, act = a && a.getAttribute && a.getAttribute('data-act');
    /* an EVENT-driven repaint never lands under a field being typed in; a repaint
       the user asked for (a click on a report, period, filter or column) always does */
    if (!force && a && m.el.contains(a) && (act === 'search' || act === 'from' || act === 'to' || act === 'filtertext')) return true;
    m.el.innerHTML = paintInner(m);
    if (typeof m.onRender === 'function') { try { m.onRender(m.el); } catch (e) {} }
    return true;
  }

  function download(m){
    var r = global.RAFReports.csv(m.result);
    if (!r.ok) { m.notice = r.message; paint(m); return; }
    try {
      var blob = new Blob(['﻿' + r.csv], { type:'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = r.filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);
      m.notice = T('تم تصدير ', 'Exported ') + r.rows + T(' صفًا.', ' rows.');
    } catch (e) { m.notice = T('تعذّر التصدير في هذا المتصفح.', 'Export is not possible in this browser.'); }
    paint(m);
  }
  function onClick(m, ev){
    var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b || !m.el.contains(b) || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
    var act = b.getAttribute('data-act');
    m.notice = '';
    if (act === 'report') { m.report = b.getAttribute('data-k'); m.filters = { search:m.filters.search || '' }; m.sort = null; }
    else if (act === 'preset') { m.preset = b.getAttribute('data-k'); }
    else if (act === 'sort') { var k = b.getAttribute('data-k'); if (m.sort === k) m.sortDir = m.sortDir === 'desc' ? 'asc' : 'desc'; else { m.sort = k; m.sortDir = 'asc'; } }
    else if (act === 'csv') { download(m); return; }
    else if (act === 'print') { try { global.print(); } catch (e) {} return; }
    else return;
    paint(m, true);
  }
  function onChange(m, ev){
    var t = ev.target, act = t.getAttribute && t.getAttribute('data-act');
    if (!act) return;
    if (act === 'filter' || act === 'filtertext') { var k = t.getAttribute('data-k'); var v = t.value;
      if (!v || v === 'all') delete m.filters[k]; else m.filters[k] = v; paint(m, true); }
    else if (act === 'from' || act === 'to') { m[act] = t.value; paint(m, true); }
  }
  function onInput(m, ev){
    var t = ev.target;
    if (!t.getAttribute || t.getAttribute('data-act') !== 'search') return;
    m.filters.search = t.value;
    /* re-render only the results, so the search box keeps focus and caret */
    var R = global.RAFReports, spec = m.preset === 'custom' ? { preset:'custom', from:m.from, to:m.to } : { preset:m.preset };
    var args = { period:spec };
    (FILTERS_BY_REPORT[m.report] || []).forEach(function (k) { if (m.filters[k]) args[k] = m.filters[k]; });
    if (m.filters.search) args.search = m.filters.search;
    var res = R.run(m.report, args);
    if (!res.ok) return;
    m.result = res;
    var head = m.el.querySelector('.rp-count'), wrap = m.el.querySelector('.rp-wrap'), msg = m.el.querySelector('.rp-msg');
    if (head) head.innerHTML = T('النتائج: ', 'Results: ') + '<bdi>' + res.count + '</bdi>'
      + (res.scope.storeBound ? ' · ' + T('نطاق متجرك: ', 'Your store scope: ') + '<bdi>' + esc(res.scope.storeSlug) + '</bdi>' : '');
    var html = table(m, res);
    if (wrap) wrap.outerHTML = html; else if (msg && msg !== m.el.querySelector('.rp-msg.err')) msg.outerHTML = html;
  }

  function mount(el, opts){
    if (!el) return null;
    opts = opts || {};
    injectStyle();
    MOUNTS = MOUNTS.filter(function (x) { return x.el.isConnected && x.el !== el; });
    var prev = el.__rpMount || SAVED;
    var m = { el:el, onRender:opts.onRender, report:'overview', preset:'today', from:'', to:'', filters:{}, sort:null, sortDir:'asc', lists:{ drivers:[], stores:[], actions:[] }, result:null, notice:'' };
    if (prev) ['report', 'preset', 'from', 'to', 'filters', 'sort', 'sortDir'].forEach(function (k) { m[k] = prev[k]; });
    if (!el.__rpMount) {
      el.addEventListener('click', function (ev) { onClick(el.__rpMount, ev); });
      el.addEventListener('change', function (ev) { onChange(el.__rpMount, ev); });
      el.addEventListener('input', function (ev) { onInput(el.__rpMount, ev); });
    }
    el.__rpMount = m; SAVED = m; MOUNTS.push(m);
    if (!subscribed && global.RAFEventBus) {
      subscribed = true;
      ['order.*', 'ownership.*', 'logistics.*', 'driver.*', 'communication.*', 'compensation.*', 'audit.appended', 'config.changed'].forEach(function (p) {
        RAFEventBus.subscribe(p, refresh);
      });
    }
    paint(m);
    return m;
  }
  function refresh(){ MOUNTS = MOUNTS.filter(function (m) { return paint(m); }); }

  global.RAFReportsUI = { mount:mount, refresh:refresh };
})(window);
