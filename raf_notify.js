/* ============================================================
   RAF Notifications — shared header bell + dropdown
   ------------------------------------------------------------
   One source of truth for notification data and read state, used by
   both the header dropdown and the full Notifications page, so the
   two can never disagree.
     • injects the bell into the shared topbar beside Favorites/Cart
     • desktop · tablet · mobile
     • bilingual (ar/en) + RTL/LTR
   Read state persists in localStorage 'raf_notif_read'.
   ============================================================ */
(function (global) {
  if (global.RAFNotify) return;

  var LS_READ = 'raf_notif_read';
  function root(){ return document.getElementById('htmlRoot') || document.documentElement; }
  function en(){ return root().lang === 'en'; }
  function T(ar, e){ return en() ? e : ar; }
  function L(o){ return (o && typeof o === 'object') ? (en() ? o.en : o.ar) : (o || ''); }

  /* ---------- types ---------- */
  var TYPES = {
    order:     { ic:'ti-truck-delivery',  bg:'rgba(201,168,76,.14)',  fg:'#A07828', act:{ar:'تتبّع الطلب',en:'Track order'},   icon:'ti-map-pin', primary:true },
    promo:     { ic:'ti-discount-2',      bg:'rgba(217,83,79,.12)',   fg:'#D9534F', act:{ar:'تسوّق العرض',en:'Shop the offer'}, icon:'ti-shopping-bag' },
    coupon:    { ic:'ti-ticket',          bg:'rgba(46,158,91,.12)',   fg:'#2E9E5B', act:{ar:'عرض الكوبون',en:'View coupon'},   icon:'ti-ticket' },
    reward:    { ic:'ti-gift',            bg:'rgba(201,168,76,.14)',  fg:'#A07828', act:{ar:'عرض المكافآت',en:'View rewards'}, icon:'ti-gift', feature:'loyalty' },
    product:   { ic:'ti-package',         bg:'rgba(20,16,8,.08)',     fg:'#15130F', act:{ar:'عرض المنتج',en:'View product'},   icon:'ti-eye' },
    store:     { ic:'ti-building-store',  bg:'rgba(20,16,8,.08)',     fg:'#15130F', act:{ar:'تصفّح المتاجر',en:'Browse stores'}, icon:'ti-compass' },
    delivered: { ic:'ti-circle-check',    bg:'rgba(46,158,91,.12)',   fg:'#2E9E5B', act:{ar:'عرض الطلب',en:'View order'},      icon:'ti-receipt' }
  };

  /* ---------- data (stable ids so read state survives reordering) ---------- */
  var DATA = [
    { id:'n1', type:'order',     href:'raf_tracking.html?id=ORD-1284',
      t:{ar:'طلبك ‎#ORD-1284 في الطريق', en:'Order #ORD-1284 is on the way'},
      s:{ar:'منذ 10 دقائق', en:'10 minutes ago'} },
    { id:'n2', type:'promo',     href:'raf_store.html?store=casa-mode',
      t:{ar:'عرض حصري من Casa Mode — خصم 25%', en:'Exclusive 25% off from Casa Mode'},
      s:{ar:'منذ ساعة', en:'1 hour ago'} },
    { id:'n3', type:'coupon',    href:'raf_coupons.html',
      t:{ar:'كوبون جديد بانتظارك — خصم 20%', en:'A new coupon is waiting — 20% off'},
      s:{ar:'منذ 90 دقيقة', en:'90 minutes ago'} },
    { id:'n4', type:'reward',    href:'raf_rewards.html',
      t:{ar:'ربحت 120 نقطة مكافآت', en:'You earned 120 reward points'},
      s:{ar:'منذ ساعتين', en:'2 hours ago'} },
    { id:'n5', type:'product',   href:'raf_product.html?id=P-001',
      t:{ar:'عاد للمخزون: قميص أوفرسايز كلاسيك', en:'Back in stock: Classic Oversize Shirt'},
      s:{ar:'منذ 3 ساعات', en:'3 hours ago'} },
    { id:'n6', type:'store',     href:'raf_storespage.html',
      t:{ar:'متجر جديد انضم — Nova Shoes', en:'New store joined — Nova Shoes'},
      s:{ar:'منذ 4 ساعات', en:'4 hours ago'} },
    { id:'n7', type:'delivered', href:'raf_order_details.html?id=ORD-1280',
      t:{ar:'تم تسليم طلبك ‎#ORD-1280 بنجاح', en:'Order #ORD-1280 delivered successfully'},
      s:{ar:'أمس', en:'Yesterday'} }
  ];
  /* notifications seeded as already-read */
  var SEEN_BY_DEFAULT = ['n5','n6','n7'];

  function readIds(){
    try { var a = JSON.parse(localStorage.getItem(LS_READ)); return Array.isArray(a) ? a : SEEN_BY_DEFAULT.slice(); }
    catch(e){ return SEEN_BY_DEFAULT.slice(); }
  }
  function writeIds(a){ try { localStorage.setItem(LS_READ, JSON.stringify(a)); } catch(e){} }

  function loyaltyOn(){
    if (global.RAFFeatures && RAFFeatures.on) return RAFFeatures.on('loyalty');
    try { return (JSON.parse(localStorage.getItem('raf_features') || '{}')).loyalty === true; } catch(e){ return false; }
  }
  /* reward alerts stay hidden while the loyalty feature is off */
  function items(){
    var rd = readIds();
    return DATA.filter(function(n){
      var k = TYPES[n.type] || {};
      return !(k.feature === 'loyalty' && !loyaltyOn());
    }).map(function(n){
      return { id:n.id, type:n.type, href:n.href, t:n.t, s:n.s, unread: rd.indexOf(n.id) < 0 };
    });
  }
  function unreadCount(){ return items().filter(function(n){ return n.unread; }).length; }
  function markRead(id){ var a = readIds(); if (a.indexOf(id) < 0){ a.push(id); writeIds(a); sync(); } }
  function markAllRead(){ writeIds(DATA.map(function(n){ return n.id; })); sync(); }

  /* ---------- styles ---------- */
  function css(){
    if (document.getElementById('rn-css')) return;
    var s = document.createElement('style'); s.id = 'rn-css';
    s.textContent = [
      '.rn-wrap{position:relative;display:inline-flex;}',
      '.rn-bell{width:44px;height:44px;border:none;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      '  color:#15130F;cursor:pointer;background:transparent;position:relative;font-size:20px;transition:all .2s;}',
      '.rn-bell:hover{background:rgba(201,168,76,.12);color:#A07828;}',
      '.rn-bell.open{background:rgba(201,168,76,.16);color:#A07828;}',
      '.rn-badge{position:absolute;top:3px;inset-inline-end:3px;min-width:16px;height:16px;padding:0 4px;background:#D9534F;',
      '  color:#fff;border-radius:10px;font-size:10px;font-weight:700;font-family:"DM Sans",sans-serif;display:none;align-items:center;justify-content:center;}',
      '.rn-badge.show{display:flex;}',
      /* panel */
      '.rn-back{position:fixed;inset:0;z-index:1200;display:none;}',
      '.rn-back.open{display:block;}',
      /* the panel lives on <body>: header bars use backdrop-filter, which would
         otherwise become the containing block for a fixed-position child */
      '.rn-panel{position:fixed;top:0;inset-inline-start:0;z-index:1300;width:380px;max-width:calc(100vw - 24px);',
      '  background:#fff;border:1px solid #E2DBCC;border-radius:18px;box-shadow:0 26px 60px -24px rgba(20,16,8,.5);',
      '  overflow:hidden;font-family:"Tajawal",sans-serif;opacity:0;visibility:hidden;transform:translateY(-8px);',
      '  transition:opacity .2s,transform .2s,visibility .2s;}',
      '.rn-panel.open{opacity:1;visibility:visible;transform:none;}',
      '.rn-head{display:flex;align-items:center;gap:10px;padding:15px 17px;border-bottom:1px solid #E2DBCC;}',
      '.rn-head h4{flex:1;font-size:15.5px;font-weight:800;color:#15130F;margin:0;}',
      '.rn-head .rn-n{font-family:"DM Sans",sans-serif;font-size:11px;font-weight:800;color:#A07828;background:rgba(201,168,76,.14);',
      '  border:1px solid rgba(201,168,76,.3);border-radius:20px;padding:2px 8px;}',
      '.rn-mark{border:none;background:none;color:#A07828;font-family:"Tajawal",sans-serif;font-size:12px;font-weight:700;cursor:pointer;padding:4px;}',
      '.rn-mark:hover{text-decoration:underline;} .rn-mark:disabled{color:#8A857C;cursor:default;text-decoration:none;}',
      '.rn-list{max-height:min(60vh,420px);overflow-y:auto;}',
      '.rn-item{display:flex;gap:11px;padding:13px 17px;border-bottom:1px solid #F0EBE0;text-decoration:none;transition:background .15s;position:relative;}',
      '.rn-item:last-child{border-bottom:none;}',
      '.rn-item:hover{background:#FAF8F3;}',
      '.rn-item.unread{background:rgba(201,168,76,.05);}',
      '.rn-item.unread::before{content:"";position:absolute;top:18px;inset-inline-start:7px;width:6px;height:6px;border-radius:50%;background:#C9A84C;}',
      '.rn-ic{width:38px;height:38px;flex-shrink:0;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:18px;}',
      '.rn-b{flex:1;min-width:0;}',
      '.rn-t{font-size:13.5px;font-weight:700;color:#15130F;line-height:1.5;}',
      '.rn-s{font-size:11.5px;color:#8A857C;margin-top:3px;}',
      '.rn-empty{padding:34px 20px;text-align:center;color:#8A857C;font-size:13px;}',
      '.rn-empty i{font-size:34px;color:#D8D0BE;display:block;margin-bottom:10px;}',
      '.rn-foot{padding:11px 14px;border-top:1px solid #E2DBCC;background:#FCFAF6;}',
      '.rn-all{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;height:42px;border:1px solid #15130F;',
      '  border-radius:30px;background:#15130F;color:#F5F0E4;font-family:"Tajawal",sans-serif;font-size:13.5px;font-weight:800;',
      '  cursor:pointer;text-decoration:none;transition:background .2s;}',
      '.rn-all:hover{background:#A07828;border-color:#A07828;}',
      /* the bell stays in the header on tablet/mobile even though the other icons move to the bottom nav */
      '@media(max-width:1024px){.rtb-actions .rn-wrap{display:inline-flex!important;}.rn-bell{width:40px;height:40px;font-size:19px;}}',
      '@media(max-width:560px){',
      '  .rn-panel{top:auto!important;bottom:0!important;inset-inline:0!important;width:100%;max-width:100%;',
      '    border-radius:22px 22px 0 0;border-bottom:none;transform:translateY(100%);}',
      '  .rn-panel.open{transform:none;} .rn-list{max-height:56vh;}',
      '  .rn-foot{padding-bottom:calc(11px + env(safe-area-inset-bottom,0px));}}',
      '@media(prefers-reduced-motion:reduce){.rn-panel{transition:none;}}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------- markup ---------- */
  function listHTML(){
    var list = items().slice(0, 5);
    if (!list.length){
      return '<div class="rn-empty"><i class="ti ti-bell-off"></i>' + T('لا توجد إشعارات', 'No notifications') + '</div>';
    }
    return list.map(function(n){
      var k = TYPES[n.type] || TYPES.store;
      return '<a class="rn-item' + (n.unread ? ' unread' : '') + '" href="' + n.href + '" data-id="' + n.id + '">' +
        '<span class="rn-ic" style="background:' + k.bg + ';color:' + k.fg + '"><i class="ti ' + k.ic + '"></i></span>' +
        '<span class="rn-b"><span class="rn-t">' + L(n.t) + '</span><span class="rn-s">' + L(n.s) + '</span></span>' +
      '</a>';
    }).join('');
  }
  function panelHTML(){
    var n = unreadCount();
    return '<div class="rn-head">' +
        '<h4>' + T('الإشعارات', 'Notifications') + '</h4>' +
        (n ? '<span class="rn-n">' + n + ' ' + T('جديد', 'new') + '</span>' : '') +
        '<button class="rn-mark" ' + (n ? '' : 'disabled') + '>' + T('تعليم الكل كمقروء', 'Mark all read') + '</button>' +
      '</div>' +
      '<div class="rn-list">' + listHTML() + '</div>' +
      '<div class="rn-foot"><a class="rn-all" href="raf_notifications.html">' +
        '<i class="ti ti-bell"></i> ' + T('عرض كل الإشعارات', 'View All Notifications') + '</a></div>';
  }

  var wrap, bell, panel, back;
  /* The bell sits beside Favorites and Cart. Pages using the shared topbar
     expose .rtb-actions; pages with their own header are matched by locating
     their cart link, and the bell copies that link's classes so it inherits
     the host header's styling instead of duplicating it. */
  function findHost(){
    var actions = document.querySelector('.rtb-actions');
    if (actions) return { host:actions, cart:actions.querySelector('a[href="raf_cart.html"]'), inherit:false };
    /* anchor on the cart control, else the favourites control (the cart page
       itself has no cart link), else the header's action row */
    var sels = ['a[href="raf_cart.html"]', 'button[onclick*="raf_cart.html"]',
                'a[href="raf_wishlist.html"]', 'button[onclick*="raf_wishlist.html"]'];
    var navs = document.querySelectorAll('nav:not(.app-bnav), header');
    for (var i = 0; i < navs.length; i++){
      for (var j = 0; j < sels.length; j++){
        var el = navs[i].querySelector(sels[j]);
        if (el && el.parentNode) return { host:el.parentNode, cart:el, inherit:true };
      }
    }
    var row = document.querySelector('.nav-actions, .ahead-actions, .head-actions');
    if (row) return { host:row, cart:null, inherit:false };
    return null;
  }
  function build(){
    var found = findHost();
    if (!found || found.host.querySelector('.rn-wrap')) return;
    css();

    wrap = document.createElement('div');
    wrap.className = 'rn-wrap';
    var bellCls = 'rn-bell' + (found.inherit && found.cart ? ' ' + found.cart.className : '');
    wrap.innerHTML =
      '<button class="' + bellCls + '" aria-label="' + T('الإشعارات','Notifications') + '" aria-haspopup="true" aria-expanded="false">' +
        '<i class="ti ti-bell"></i><span class="rn-badge"></span></button>';

    if (found.cart) found.host.insertBefore(wrap, found.cart); else found.host.appendChild(wrap);

    back = document.createElement('div'); back.className = 'rn-back';
    document.body.appendChild(back);

    panel = document.createElement('div');
    panel.className = 'rn-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', T('الإشعارات','Notifications'));
    document.body.appendChild(panel);

    bell = wrap.querySelector('.rn-bell');

    bell.addEventListener('click', function(e){ e.stopPropagation(); toggle(); });
    back.addEventListener('click', close);
    panel.addEventListener('click', function(e){
      var mark = e.target.closest('.rn-mark');
      if (mark){ e.preventDefault(); markAllRead(); return; }
      var item = e.target.closest('.rn-item');
      if (item) markRead(item.getAttribute('data-id'));   /* follows the link afterwards */
    });
    document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
    window.addEventListener('resize', function(){ if (isOpen()) place(); });
    window.addEventListener('scroll', function(){ if (isOpen()) place(); }, true);
    sync();
  }

  function isOpen(){ return !!(panel && panel.classList.contains('open')); }
  /* anchor the panel under the bell (skipped on ≤560px, where CSS turns it
     into a full-width bottom sheet) */
  function place(){
    if (!panel || !bell) return;
    if (window.matchMedia('(max-width:560px)').matches){ panel.style.top = ''; panel.style.insetInlineStart = ''; return; }
    var b = bell.getBoundingClientRect();
    var w = panel.offsetWidth || 380;
    var rtl = (root().dir || 'rtl') === 'rtl';
    /* keep the panel edge aligned with the bell and inside the viewport */
    var left = rtl ? b.left : b.right - w;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    panel.style.top = Math.round(b.bottom + 10) + 'px';
    panel.style.insetInlineStart = 'auto';
    panel.style.left = Math.round(left) + 'px';
  }
  function open(){
    if (!panel) return;
    panel.innerHTML = panelHTML();
    panel.classList.add('open'); back.classList.add('open'); bell.classList.add('open');
    bell.setAttribute('aria-expanded', 'true');
    place();
  }
  function close(){
    if (!panel) return;
    panel.classList.remove('open'); back.classList.remove('open'); bell.classList.remove('open');
    bell.setAttribute('aria-expanded', 'false');
  }
  function toggle(){ isOpen() ? close() : open(); }

  /* refresh badge + panel contents (also after a language flip) */
  function sync(){
    var b = wrap && wrap.querySelector('.rn-badge');
    if (b){
      var n = unreadCount();
      b.textContent = n > 9 ? '9+' : n;
      b.classList.toggle('show', n > 0);
    }
    if (isOpen()) panel.innerHTML = panelHTML();
    document.dispatchEvent(new CustomEvent('raf:notify'));
  }

  global.RAFNotify = {
    items:items, unreadCount:unreadCount, markRead:markRead, markAllRead:markAllRead,
    TYPES:TYPES, open:open, close:close, sync:sync, build:build
  };

  function init(){
    build();
    /* the shared topbar builds the header after this script on some pages */
    if (!document.querySelector('.rn-wrap')) setTimeout(build, 0);
    var r = document.getElementById('htmlRoot');
    if (r) new MutationObserver(sync).observe(r, { attributes:true, attributeFilter:['lang'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
