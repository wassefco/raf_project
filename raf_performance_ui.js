/* ============================================================================
 * RAF Marketplace — RAF-WIDE PERFORMANCE WIDGET  (RAFPerfCenterUI) — Phase K
 * ----------------------------------------------------------------------------
 * Presentation only. It calls RAFPerformance and renders what comes back: the
 * view selector, the filter bar, the summary tiles, the measurement table, the
 * empty / NOT_AVAILABLE / NOT_CONFIGURED / error states, CSV export (through
 * the Reports Center's writer) and print. It reads no storage, writes nothing
 * and decides no permission — RAFPerformance refuses a caller it may not serve
 * and this widget renders that refusal.
 *
 *   RAFPerfCenterUI.mount(el, { onRender })
 *
 * It renders measurements only: no score, rank, tier, target, leaderboard,
 * colour judgement or evaluative label anywhere.
 *
 * Live refresh: RAFEventBus only. No polling, no setInterval, no timers.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFPerfCenterUI) return;

  var MOUNTS = [], SAVED = null, subscribed = false;
  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function when(ms){
    if (ms == null) return '—';
    try { return new Date(ms).toLocaleString(isEn() ? 'en-GB' : 'ar-KW-u-nu-latn', { timeZone:'Asia/Kuwait', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
    catch (e) { return String(ms); }
  }

  var STYLE = [
    '.pc{font-size:13.5px;color:var(--ink,#1F1B14);line-height:1.6}',
    '.pc *{box-sizing:border-box}',
    '.pc-tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}',
    '.pc-b{min-height:44px;padding:0 14px;border-radius:12px;border:1px solid var(--line,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit;font:inherit;font-weight:800;cursor:pointer}',
    '.pc-b[aria-pressed="true"]{background:var(--ink,#1F1B14);border-color:var(--ink,#1F1B14);color:#F5F0E4}',
    '.pc-b[disabled]{opacity:.5;cursor:not-allowed}',
    '.pc-b:focus-visible,.pc input:focus-visible,.pc select:focus-visible{outline:2px solid var(--accent,#C9A84C);outline-offset:2px}',
    '.pc-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:10px;padding:10px;border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px;background:var(--surface-2,#F6F5F1)}',
    '.pc-f{display:flex;flex-direction:column;gap:4px;font-size:11.5px;font-weight:800;color:var(--faint,#6B6457);flex:1 1 150px;min-width:0}',
    '.pc input,.pc select{min-height:44px;border-radius:12px;border:1px solid var(--line,rgba(0,0,0,.18));background:var(--surface,#fff);color:inherit;font:inherit;padding:0 10px;width:100%;max-width:100%}',
    '.pc-periods{display:flex;flex-wrap:wrap;gap:6px}',
    '.pc-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:8px;margin-bottom:10px}',
    '.pc-s{border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px;padding:10px 12px;background:var(--surface,#fff);min-width:0}',
    '.pc-s span{display:block;font-size:11.5px;font-weight:700;color:var(--faint,#6B6457)}',
    '.pc-s b{display:block;font-size:19px;font-weight:800;margin-top:2px;overflow-wrap:anywhere}',
    '.pc-s small{display:block;font-size:10.5px;color:var(--faint,#6B6457);margin-top:3px;overflow-wrap:anywhere}',
    '.pc-s.na b,.pc-s.nc b{font-size:13px;color:var(--faint,#6B6457)}',
    '.pc-wrap{overflow-x:auto;border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px}',
    '.pc-wrap:focus-visible{outline:2px solid var(--accent,#C9A84C);outline-offset:2px}',
    '.pc-t{border-collapse:collapse;width:100%;font-size:12.5px}',
    '.pc-t th,.pc-t td{padding:8px 11px;border-bottom:1px solid var(--line,rgba(0,0,0,.12));text-align:start;vertical-align:top}',
    '.pc-t thead th{background:var(--surface-2,#F6F5F1);font-weight:800;white-space:nowrap}',
    '.pc-t thead th button{background:none;border:0;font:inherit;font-weight:800;cursor:pointer;color:inherit;padding:0;min-height:32px}',
    '.pc-t td.metric{font-weight:700;min-width:170px}',
    '.pc-t td.value{font-weight:800;white-space:nowrap}',
    '.pc-t td.source,.pc-t td.denominator{color:var(--faint,#6B6457);font-size:11.5px;overflow-wrap:anywhere}',
    '.pc-t tbody tr:nth-child(2n) td{background:rgba(0,0,0,.02)}',
    '.pc-na{color:var(--faint,#6B6457);font-weight:800}',
    '.pc-msg{padding:18px;text-align:center;color:var(--faint,#6B6457);border:1px solid var(--line,rgba(0,0,0,.12));border-radius:14px}',
    '.pc-msg.err{color:#A8322E;border-color:rgba(217,83,79,.45)}',
    '.pc-note{font-size:12px;color:var(--faint,#6B6457);margin:8px 0 0}',
    '.pc-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:8px}',
    '@media print{.pc-tabs,.pc-bar,.pc-actions{display:none!important}.pc-wrap{overflow:visible;border:0}.pc-t th,.pc-t td{white-space:normal}}'
  ].join('');
  function injectStyle(){
    if (document.getElementById('rafPerfCenterStyle')) return;
    var s = document.createElement('style'); s.id = 'rafPerfCenterStyle'; s.textContent = STYLE; document.head.appendChild(s);
  }

  /* only filters the authority actually accepts for that view */
  var FILTERS_BY_VIEW = {
    overview:['storeSlug'], orders:['storeSlug', 'status', 'driverId', 'orderId'], merchants:['storeSlug'],
    logistics:['storeSlug', 'driverId', 'orderId'], drivers:['driverId'],
    exceptions:['storeSlug', 'category', 'status', 'sla', 'driverId', 'orderId'],
    reassignments:['storeSlug', 'driverId', 'orderId', 'reassignmentState'],
    communication:['storeSlug', 'orderId', 'communicationType'], customerExperience:['driverId'],
    compensation:['storeSlug', 'status', 'orderId', 'customerId']
  };
  var CHOICES = {
    status:{ orders:['progress', 'delivered', 'cancelled'], exceptions:['open', 'escalated', 'closed'],
             compensation:['issued', 'in_wallet', 'consumed', 'expired', 'voided', 'reversed'] },
    sla:{ exceptions:['on_track', 'approaching', 'breached'] },
    reassignmentState:{ reassignments:['reassignment', 'returned_to_pool', 'submitted', 'approved', 'rejected', 'cancelled'] },
    communicationType:{ communication:['text', 'image', 'voice', 'call'] }
  };
  var LABELS = { storeSlug:['المتجر', 'Store'], driverId:['السائق', 'Driver'], orderId:['رقم الطلب', 'Order'],
    status:['الحالة', 'Status'], category:['فئة الاستثناء', 'Exception category'], sla:['حالة SLA', 'SLA state'],
    reassignmentState:['حالة إعادة الإسناد', 'Reassignment state'], communicationType:['نوع التواصل', 'Communication type'],
    customerId:['العميل', 'Customer'] };
  function optionsFor(kind, viewId, m){
    if (kind === 'driverId') return (m.drivers || []).map(function (d) { return [d.id, d.name]; });
    if (kind === 'storeSlug') return (m.stores || []).map(function (s) { return [s, s]; });
    var set = (CHOICES[kind] || {})[viewId];
    return set ? set.map(function (s) { return [s, s]; }) : null;
  }
  function collectLists(m){
    try { m.drivers = RAFPerm.getUsers().filter(function (u) { return u.roleId === 'driver'; }).map(function (u) { return { id:u.id, name:u.name }; }); } catch (e) { m.drivers = []; }
    var seen = {}; m.stores = [];
    try { (global.RAFReports ? RAFReports.run('orders', { period:{ preset:'month' } }) : { rows:[] }).rows.forEach(function (r) {
      if (r.storeSlug && !seen[r.storeSlug]) { seen[r.storeSlug] = 1; m.stores.push(r.storeSlug); } }); } catch (e) {}
  }

  function filterBar(m){
    var h = '<div class="pc-bar"><div class="pc-f"><span>' + esc(T('الفترة', 'Period')) + '</span><div class="pc-periods">'
      + [['today', 'اليوم', 'Today'], ['week', 'الأسبوع', 'Week'], ['month', 'الشهر', 'Month'], ['custom', 'مخصصة', 'Custom']].map(function (x) {
          return '<button type="button" class="pc-b" aria-pressed="' + (m.preset === x[0]) + '" data-act="preset" data-k="' + x[0] + '">' + esc(T(x[1], x[2])) + '</button>'; }).join('')
      + '</div></div>';
    if (m.preset === 'custom')
      h += '<label class="pc-f"><span>' + esc(T('من', 'From')) + '</span><input type="date" dir="ltr" data-act="from" value="' + esc(m.from) + '"></label>'
        + '<label class="pc-f"><span>' + esc(T('إلى', 'To')) + '</span><input type="date" dir="ltr" data-act="to" value="' + esc(m.to) + '"></label>';
    (FILTERS_BY_VIEW[m.view] || []).forEach(function (k) {
      var opts = optionsFor(k, m.view, m), lab = LABELS[k] || [k, k];
      if (opts && opts.length)
        h += '<label class="pc-f"><span>' + esc(T(lab[0], lab[1])) + '</span><select data-act="filter" data-k="' + k + '"><option value="all">' + esc(T('الكل', 'All')) + '</option>'
          + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (m.filters[k] === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>';
      else if (!opts)
        h += '<label class="pc-f"><span>' + esc(T(lab[0], lab[1])) + '</span><input type="text" data-act="filtertext" data-k="' + k + '" value="' + esc(m.filters[k] || '') + '" placeholder="' + esc(T('اختياري', 'optional')) + '"></label>';
    });
    h += '<label class="pc-f"><span>' + esc(T('بحث', 'Search')) + '</span><input type="search" data-act="search" value="' + esc(m.search || '') + '" placeholder="' + esc(T('ابحث في المقاييس', 'search the measurements')) + '"></label>';
    return h + '</div>';
  }
  function tiles(res){
    if (!res.summary || !res.summary.length) return '';
    return '<div class="pc-sum">' + res.summary.map(function (s) {
      var v = s.value, state = s.state || (v && v.notAvailable ? 'NOT_AVAILABLE' : (v && v.notConfigured ? 'NOT_CONFIGURED' : null));
      var shown = state && (v == null || typeof v === 'object') ? state : v;
      return '<div class="pc-s' + (state === 'NOT_AVAILABLE' ? ' na' : state === 'NOT_CONFIGURED' ? ' nc' : '') + '">'
        + '<span>' + esc(T(s.ar, s.en)) + '</span><b><bdi>' + esc(shown) + '</bdi></b>'
        + (s.source ? '<small>' + esc(s.source) + '</small>' : '') + '</div>'; }).join('') + '</div>';
  }
  function table(m, res){
    var rows = res.rows.filter(function (r) {
      if (!m.search) return true;
      var t = String(m.search).toLowerCase();
      return Object.keys(r).some(function (k) { var v = r[k]; return v != null && typeof v !== 'object' && String(v).toLowerCase().indexOf(t) > -1; });
    });
    if (!rows.length)
      return '<div class="pc-msg">' + esc(m.search ? T('لا مقاييس مطابقة لبحثك.', 'No measurements match your search.')
        : T('لا توجد بيانات في هذه الفترة.', 'There is no data in this period.')) + '</div>';
    if (m.sort && res.columns.some(function (c) { return c.key === m.sort; })) {
      var dir = m.sortDir === 'desc' ? -1 : 1, k = m.sort;
      rows = rows.slice().sort(function (a, b) {
        var x = a[k], y = b[k];
        var nx = typeof x === 'number' ? x : parseFloat(x), ny = typeof y === 'number' ? y : parseFloat(y);
        if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
        return String(x == null ? '' : x).localeCompare(String(y == null ? '' : y)) * dir;
      });
    }
    return '<div class="pc-wrap" role="region" tabindex="0" aria-label="' + esc(T('جدول المقاييس', 'Measurements table')) + '"><table class="pc-t"><thead><tr>'
      + res.columns.map(function (c) { return '<th scope="col"><button type="button" data-act="sort" data-k="' + esc(c.key) + '">' + esc(T(c.ar, c.en))
          + (m.sort === c.key ? (m.sortDir === 'desc' ? ' ▾' : ' ▴') : '') + '</button></th>'; }).join('')
      + '</tr></thead><tbody>' + rows.map(function (r) {
          return '<tr>' + res.columns.map(function (c) {
            var v = r[c.key], na = v === 'NOT_AVAILABLE' || v === 'NOT_CONFIGURED';
            return '<td class="' + esc(c.key) + '">' + (na ? '<span class="pc-na">' + esc(v) + '</span>' : '<bdi>' + esc(v == null || v === '' ? '—' : v) + '</bdi>') + '</td>'; }).join('') + '</tr>'; }).join('')
      + '</tbody></table></div>';
  }
  function paintInner(m){
    var P = global.RAFPerformance;
    if (!P) return '<div class="pc"><div class="pc-msg err">' + esc(T('خدمة الأداء غير محمّلة.', 'The performance service is not loaded.')) + '</div></div>';
    var h = '<div class="pc"><div class="pc-tabs" role="group" aria-label="' + esc(T('أقسام الأداء', 'Performance sections')) + '">'
      + P.VIEWS.map(function (v) { return '<button type="button" class="pc-b" aria-pressed="' + (m.view === v.id) + '" data-act="view" data-k="' + v.id + '">' + esc(T(v.ar, v.en)) + '</button>'; }).join('')
      + '</div>';
    var spec = m.preset === 'custom' ? { preset:'custom', from:m.from, to:m.to } : { preset:m.preset };
    if (m.preset === 'custom' && (!m.from || !m.to)) {
      m.result = null; collectLists(m);
      return h + filterBar(m) + '<div class="pc-msg">' + esc(T('اختر تاريخ البداية والنهاية.', 'Choose a start and end date.')) + '</div></div>';
    }
    var args = { period:spec };
    (FILTERS_BY_VIEW[m.view] || []).forEach(function (k) { if (m.filters[k]) args[k] = m.filters[k]; });
    var res = P.run(m.view, args);
    m.result = res.ok ? res : null;
    collectLists(m);
    h += filterBar(m);
    if (!res.ok) return h + '<div class="pc-msg err" role="status"><b>' + esc(res.code) + '</b><br>' + esc(res.message) + '</div></div>';
    h += '<div class="pc-head"><span class="pc-note">' + esc(T('المقاييس: ', 'Measurements: ')) + '<bdi>' + res.count + '</bdi>'
      + (res.scope.storeBound ? ' · ' + esc(T('نطاق متجرك: ', 'Your store scope: ')) + '<bdi>' + esc(res.scope.storeSlug) + '</bdi>' : '') + '</span>'
      + '<span class="pc-actions"><button type="button" class="pc-b" data-act="csv"' + (res.canExport && res.rows.length ? '' : ' disabled') + '>'
      + esc(T('تصدير CSV', 'Export CSV')) + '</button> <button type="button" class="pc-b" data-act="print">' + esc(T('طباعة', 'Print')) + '</button></span></div>';
    h += tiles(res) + table(m, res);
    (res.notes || []).forEach(function (n) { h += '<p class="pc-note">' + esc(n) + '</p>'; });
    h += '<p class="pc-note">' + esc(T('الفترة بتوقيت الكويت: ', 'Period in Kuwait time: ')) + esc(when(res.period.start)) + ' → ' + esc(when(res.period.end)) + '</p>';
    if (m.notice) h += '<p class="pc-note" role="status"><b>' + esc(m.notice) + '</b></p>';
    return h + '</div>';
  }
  function paint(m, force){
    if (!m.el.isConnected) return false;
    var a = document.activeElement, act = a && a.getAttribute && a.getAttribute('data-act');
    if (!force && a && m.el.contains(a) && (act === 'search' || act === 'from' || act === 'to' || act === 'filtertext')) return true;
    m.el.innerHTML = paintInner(m);
    if (typeof m.onRender === 'function') { try { m.onRender(m.el); } catch (e) {} }
    return true;
  }
  function download(m){
    var r = global.RAFPerformance.csv(m.result);
    if (!r.ok) { m.notice = r.message; paint(m, true); return; }
    try {
      var blob = new Blob(['﻿' + r.csv], { type:'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = r.filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 0);   /* browser cleanup only */
      m.notice = T('تم تصدير ', 'Exported ') + r.rows + T(' صفًا.', ' rows.');
    } catch (e) { m.notice = T('تعذّر التصدير في هذا المتصفح.', 'Export is not possible in this browser.'); }
    paint(m, true);
  }
  function onClick(m, ev){
    var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b || !m.el.contains(b) || b.tagName === 'INPUT' || b.tagName === 'SELECT') return;
    var act = b.getAttribute('data-act');
    m.notice = '';
    if (act === 'view') { m.view = b.getAttribute('data-k'); m.filters = {}; m.sort = null; }
    else if (act === 'preset') m.preset = b.getAttribute('data-k');
    else if (act === 'sort') { var k = b.getAttribute('data-k'); if (m.sort === k) m.sortDir = m.sortDir === 'desc' ? 'asc' : 'desc'; else { m.sort = k; m.sortDir = 'asc'; } }
    else if (act === 'csv') { download(m); return; }
    else if (act === 'print') { try { global.print(); } catch (e) {} return; }
    else return;
    paint(m, true);
  }
  function onChange(m, ev){
    var t = ev.target, act = t.getAttribute && t.getAttribute('data-act');
    if (act === 'filter' || act === 'filtertext') { var k = t.getAttribute('data-k'), v = t.value;
      if (!v || v === 'all') delete m.filters[k]; else m.filters[k] = v; paint(m, true); }
    else if (act === 'from' || act === 'to') { m[act] = t.value; paint(m, true); }
  }
  function onInput(m, ev){
    var t = ev.target;
    if (!t.getAttribute || t.getAttribute('data-act') !== 'search' || !m.result) return;
    m.search = t.value;
    var wrap = m.el.querySelector('.pc-wrap'), msg = m.el.querySelector('.pc-msg:not(.err)');
    var html = table(m, m.result);
    if (wrap) wrap.outerHTML = html; else if (msg) msg.outerHTML = html;
  }

  function mount(el, opts){
    if (!el) return null;
    opts = opts || {};
    injectStyle();
    MOUNTS = MOUNTS.filter(function (x) { return x.el.isConnected && x.el !== el; });
    var prev = el.__pcMount || SAVED;
    var m = { el:el, onRender:opts.onRender, view:'overview', preset:'today', from:'', to:'', filters:{}, search:'',
              sort:null, sortDir:'asc', drivers:[], stores:[], result:null, notice:'' };
    if (prev) ['view', 'preset', 'from', 'to', 'filters', 'search', 'sort', 'sortDir'].forEach(function (k) { m[k] = prev[k]; });
    if (!el.__pcMount) {
      el.addEventListener('click', function (ev) { onClick(el.__pcMount, ev); });
      el.addEventListener('change', function (ev) { onChange(el.__pcMount, ev); });
      el.addEventListener('input', function (ev) { onInput(el.__pcMount, ev); });
    }
    el.__pcMount = m; SAVED = m; MOUNTS.push(m);
    if (!subscribed && global.RAFEventBus) {
      subscribed = true;
      ['order.*', 'ownership.*', 'logistics.*', 'driver.*', 'communication.*', 'compensation.*', 'audit.appended', 'config.changed']
        .forEach(function (p) { RAFEventBus.subscribe(p, refresh); });
    }
    paint(m, true);
    return m;
  }
  function refresh(){ MOUNTS = MOUNTS.filter(function (m) { return paint(m); }); }

  global.RAFPerfCenterUI = { mount:mount, refresh:refresh };
})(window);
