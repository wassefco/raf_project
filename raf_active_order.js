/* ============================================================================
 * RAF Marketplace — ACTIVE ORDER BAR  (RAFActiveOrderBar · UI only)
 * ----------------------------------------------------------------------------
 * A compact bar at the bottom of the customer-facing pages: while the signed-in
 * customer has an order in progress, it names the order and its stage and
 * reopens that order's tracking screen. It appears whether or not tracking was
 * ever opened, and survives leaving and returning to the site, because it is
 * read from the order data itself — never from whether a page is open.
 *
 * NOTHING IS DECIDED OR STORED HERE.
 *   · which orders — RAFShop.Orders.mine(): the tab's own signed-in customer
 *     (RAFPerm session), ownership proved from each order's own record
 *   · active       — the order's own status: 'progress'. Delivered and
 *     cancelled orders (the lifecycle's final states) never show a bar
 *   · the stage    — the same facts tracking reads: the order's fulfilment
 *     record (driver, pickup, arrival) and the engine's audited Ready milestone
 * No second status, no copy of an order, no storage of its own.
 *
 * Updates: another tab changing an order arrives as a `raf_orders` storage
 * event; this tab's own changes as `raf:order` / `raf:snapshot`.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFActiveOrderBar) return;

  /* pages that ARE the order's own flow never carry the bar */
  var SKIP = /(?:^|\/)(raf_tracking|raf_order_chat|raf_delivery_rating|raf_checkout|raf_pending|raf_login)\.html$/i;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }

  var CSS = ''
    + '.aob{position:fixed;inset-inline:0;bottom:calc(var(--aob-off,0px) + 12px + env(safe-area-inset-bottom,0px));z-index:997;display:flex;justify-content:center;padding:0 12px;pointer-events:none;}'
    + '.aob a{pointer-events:auto;display:flex;align-items:center;gap:12px;width:100%;max-width:560px;min-height:62px;padding:9px 10px;padding-inline-start:12px;'
    + '  border-radius:20px;background:var(--ink,#1C1606);color:#fff;text-decoration:none;box-shadow:0 18px 38px -18px rgba(20,16,8,.65);'
    + '  font-family:var(--font,inherit);transition:transform .18s,box-shadow .18s;}'
    + '.aob a:hover{transform:translateY(-1px);box-shadow:0 22px 42px -18px rgba(20,16,8,.7);}'
    + '.aob a:focus-visible{outline:3px solid var(--gold,#C9A84C);outline-offset:3px;}'
    + '.aob-ic{width:42px;height:42px;flex:0 0 auto;border-radius:14px;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-size:21px;color:var(--gold,#C9A84C);position:relative;}'
    + '.aob-ic::after{content:"";position:absolute;top:6px;inset-inline-end:6px;width:8px;height:8px;border-radius:50%;background:#3FB26B;box-shadow:0 0 0 2px var(--ink,#1C1606);}'
    + '.aob-b{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;line-height:1.35;}'
    + '.aob-b b{font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.aob-b span{font-size:12px;color:rgba(255,255,255,.72);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.aob-cta{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 16px;border-radius:14px;'
    + '  background:linear-gradient(180deg,#D9B85C,var(--gold,#C9A84C));color:#1C1606;font-size:13.5px;font-weight:800;white-space:nowrap;}'
    + '.aob-cta .ti{font-size:17px;}'
    + '@media (max-width:420px){.aob-cta span{display:none;}.aob-cta{padding:0 13px;}}'
    + '@media (prefers-reduced-motion:reduce){.aob a{transition:none;}}';

  function injectCss(){
    if (document.getElementById('aobCss')) return;
    var s = document.createElement('style'); s.id = 'aobCss'; s.textContent = CSS; document.head.appendChild(s);
  }

  /* the customer's own orders still in progress, newest first (the order store's own order) */
  function activeOrders(){
    try {
      if (!global.RAFShop || !RAFShop.Orders || !RAFShop.Orders.mine) return [];
      return (RAFShop.Orders.mine() || []).filter(function (o) { return o && o.status === 'progress'; });
    } catch (e) { return []; }
  }
  /* the stage, projected from the order's own record — the facts tracking reads */
  function stageOf(o){
    var f = (o.snapshot && o.snapshot.fulfilment) || {};
    if (f.arrivedAt)  return { ar:'وصل السائق إلى موقعك', en:'Your driver has arrived', ic:'ti-map-pin-check' };
    if (f.pickedUpAt) return { ar:'قيد التوصيل', en:'Out for delivery', ic:'ti-truck-delivery' };
    var ready = false;
    try { var r = global.RAFOrderEngine && RAFOrderEngine.readyAt ? RAFOrderEngine.readyAt(o.id) : null; ready = !!(r && typeof r.at === 'number'); } catch (e) { ready = false; }
    if (f.driverId || ready) return { ar:'تم تجهيز طلبك', en:'Order prepared', ic:'ti-package' };
    return { ar:'جاري تجهيز طلبك', en:'Order being prepared', ic:'ti-package' };
  }

  /* keep it above the mobile bottom navigation when that is on screen */
  function offset(bar){
    var nav = document.querySelector('nav.app-bnav'), off = 0;
    if (nav) { var cs = getComputedStyle(nav); if (cs.display !== 'none' && cs.position === 'fixed') off = nav.getBoundingClientRect().height || 0; }
    bar.style.setProperty('--aob-off', off + 'px');
    /* the page can still be scrolled to its end: reserve the bar's height */
    var h = bar.firstChild ? bar.firstChild.getBoundingClientRect().height + 24 : 0;
    document.body.style.paddingBottom = '';
    var base = parseFloat(getComputedStyle(document.body).paddingBottom) || 0;
    document.body.style.paddingBottom = (base + h) + 'px';
  }

  var BAR = null;
  function remove(){
    if (BAR) { BAR.remove(); BAR = null; document.body.style.paddingBottom = ''; }
  }
  function render(){
    if (SKIP.test(location.pathname)) { remove(); return; }
    var list = activeOrders();
    if (!list.length) { remove(); return; }
    var o = list[0], st = stageOf(o), more = list.length - 1;
    injectCss();
    if (!BAR) { BAR = document.createElement('div'); BAR.className = 'aob'; BAR.id = 'rafActiveOrder'; document.body.appendChild(BAR); }
    var href = 'raf_tracking.html?id=' + encodeURIComponent(o.id);
    BAR.setAttribute('dir', isEn() ? 'ltr' : 'rtl');
    BAR.innerHTML = '<a href="' + esc(href) + '" data-order="' + esc(o.id) + '" aria-label="'
      + esc(T('تتبّع طلبك ' + o.id + ' — ' + st.ar, 'Track your order ' + o.id + ' — ' + st.en)) + '">'
      + '<span class="aob-ic" aria-hidden="true"><i class="ti ' + st.ic + '"></i></span>'
      + '<span class="aob-b"><b>' + esc(T(st.ar, st.en)) + '</b>'
      + '<span>' + T('طلبك ', 'Order ') + '<bdi dir="ltr">#' + esc(o.id) + '</bdi>'
      + (more > 0 ? ' · ' + esc(T('و' + more + ' طلب آخر جارٍ', '+' + more + ' more in progress')) : '') + '</span></span>'
      + '<span class="aob-cta"><i class="ti ti-map-pin" aria-hidden="true"></i><span>' + T('تتبّع الطلب', 'Track order') + '</span></span>'
      + '</a>';
    offset(BAR);
  }

  function boot(){
    render();
    global.addEventListener('storage', function (e) { if (!e.key || e.key === 'raf_orders' || e.key === 'raf_order_mstate') render(); });
    document.addEventListener('raf:order', render);
    document.addEventListener('raf:snapshot', render);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') render(); });
    global.addEventListener('resize', function () { if (BAR) offset(BAR); });
    var root = document.getElementById('htmlRoot');
    if (root && global.MutationObserver) new MutationObserver(render).observe(root, { attributes:true, attributeFilter:['lang'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  global.RAFActiveOrderBar = { refresh:render };
})(window);
