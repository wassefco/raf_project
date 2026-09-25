/* ============================================================================
 * RAF Marketplace — Shared Customer Header (Top Bar)
 * ----------------------------------------------------------------------------
 * Replaces a customer page's legacy <nav> with the shared RAF header:
 *   logo + unified search (#navSearch, picked up by raf_search.js) + actions
 *   (lang · wishlist · cart+badge · account; raf_notify.js adds its bell into
 *   .rtb-actions) + a sticky navigation row with the "All categories" menu.
 * Include AFTER the page scripts and BEFORE raf_search.js. Markup-only swap of
 * the header; the page body is untouched.
 * ==========================================================================*/
(function (global) {
  'use strict';

  function en(){ var r=document.getElementById('htmlRoot'); return (r?r.lang:document.documentElement.lang)==='en'; }
  function t(ar,e){ return en()?e:ar; }

  var NAV_H = 76;   /* header height — the sticky nav row sits right under it */

  function injectCSS(){
    if(document.getElementById('raf-topbar-css')) return;
    var c=
    /* position/top included so the header is self-contained and does not depend
       on each host page still declaring its own nav{} rule */
    'nav:not(.app-bnav):not(.top){position:sticky;top:0;height:'+NAV_H+'px!important;background:rgba(255,255,255,.96)!important;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-bottom:1px solid #EEE8DC!important;display:flex!important;align-items:center;justify-content:center;padding:0 var(--cx-gut,28px)!important;gap:0!important;z-index:200;}'+
    '.rtb-inner{width:100%;max-width:var(--rtb-inner-max,1320px);height:100%;display:flex;align-items:center;gap:28px;}'+
    /* colour set explicitly so the header never inherits host-page link styling */
    '.rtb-logo{flex-shrink:0;display:inline-flex;align-items:center;color:#15130F;text-decoration:none;}.rtb-logo img{height:52px;width:auto;display:block;}'+
    '.rtb-search{flex:1;max-width:780px;margin-inline:auto;position:relative;}'+
    /* logical padding: the text reserve is always on the same side as the
       buttons, in both RTL and LTR */
    '.rtb-search input{width:100%;height:50px;border:1px solid #E6E0D3;background:#F8F6F1;border-radius:999px;padding:0;padding-inline-start:22px;padding-inline-end:104px;font-family:"Tajawal",sans-serif;font-size:15px;color:#0A0A0A;outline:none;transition:border-color .2s,box-shadow .2s,background .2s;}'+
    '.rtb-search input::placeholder{color:#8A857C;}'+
    '.rtb-search input:focus{background:#fff;border-color:#C9A84C;box-shadow:0 0 0 4px rgba(201,168,76,.14);}'+
    /* both in-field buttons share one size and one vertical centre */
    '.rtb-search>button{position:absolute;top:50%;transform:translateY(-50%);inset-inline-end:5px;width:40px;height:40px;min-height:40px;flex-shrink:0;border:none;border-radius:50%;background:#15130F;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:18px;transition:background .2s;}'+
    '.rtb-search>button:hover{background:#A07828;}'+
    '.rtb-search>button.rtb-filter{inset-inline-end:50px;background:transparent;color:#5A5650;}'+
    '.rtb-search>button.rtb-filter:hover{background:rgba(201,168,76,.14);color:#A07828;}'+
    '.rtb-actions{display:flex;align-items:center;gap:4px;flex-shrink:0;}'+
    /* each action: icon over a short label */
    '.rtb-act{position:relative;min-width:58px;height:56px;padding:0 6px;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:#15130F;text-decoration:none;font-family:"Tajawal",sans-serif;font-size:11.5px;font-weight:700;line-height:1;transition:background .2s,color .2s;}'+
    '.rtb-act i{font-size:23px;line-height:1;}'+
    '.rtb-act:hover{background:rgba(201,168,76,.12);color:#A07828;}'+
    '.rtb-act.on{color:#A07828;}'+
    '.rtb-badge{position:absolute;top:5px;inset-inline-end:10px;min-width:17px;height:17px;padding:0 4px;background:#C9A84C;color:#0A0A0A;border:2px solid #fff;border-radius:10px;font-size:10px;font-weight:800;font-family:"DM Sans",sans-serif;display:none;align-items:center;justify-content:center;line-height:1;}'+
    /* the bell raf_notify.js places here takes the same icon-over-label shape */
    '.rtb-actions .rn-bell{width:auto!important;min-width:58px;height:56px!important;border-radius:14px!important;flex-direction:column;gap:3px;font-size:23px!important;color:#15130F;background:transparent;}'+
    '.rtb-actions .rn-bell::after{content:attr(aria-label);font-family:"Tajawal",sans-serif;font-size:11.5px;font-weight:700;line-height:1;}'+
    '.rtb-actions .rn-bell:hover{background:rgba(201,168,76,.12);color:#A07828;}'+
    '.rtb-lang{height:38px;min-height:38px;padding:0 13px;margin-inline-end:4px;border:1px solid #E2DBCC;border-radius:30px;background:#fff;color:#5A5650;font-family:"DM Sans",sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:6px;}'+
    '.rtb-lang:hover{border-color:#C9A84C;color:#A07828;}.rtb-lang .dot{width:5px;height:5px;border-radius:50%;background:#C9A84C;}'+
    /* navigation row */
    '.rtb-subnav{position:sticky;top:'+NAV_H+'px;z-index:190;background:#fff;border-bottom:1px solid #EEE8DC;}'+
    '.rtb-sub-inner{max-width:var(--rtb-sub-max,1320px);margin:0 auto;display:flex;align-items:center;gap:6px;height:50px;padding:0 var(--cx-gut,28px);}'+
    '.rtb-links{display:flex;align-items:center;gap:2px;overflow-x:auto;scrollbar-width:none;min-width:0;height:100%;}'+
    '.rtb-links::-webkit-scrollbar{display:none;}'+
    '.rtb-links a{position:relative;height:100%;font-size:14px;font-weight:600;color:#3F3B35;padding:0 14px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;text-decoration:none;transition:color .2s;}'+
    '.rtb-links a:hover{color:#A07828;}'+
    '.rtb-links a.on{color:#A07828;font-weight:800;}'+
    '.rtb-links a.on::after{content:"";position:absolute;inset-inline:12px;bottom:0;height:2px;border-radius:2px 2px 0 0;background:#C9A84C;}'+
    '.rtb-cats{position:relative;flex-shrink:0;}'+
    '.rtb-cats-btn{height:36px;min-height:36px;padding:0 14px;border:none;border-radius:10px;background:#F4F1EA;color:#15130F;font-family:"Tajawal",sans-serif;font-size:13.5px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;gap:8px;transition:background .2s;}'+
    '.rtb-cats-btn i{font-size:18px;}'+
    '.rtb-cats-btn:hover,.rtb-cats-btn[aria-expanded="true"]{background:#EDE6D6;}'+
    '.rtb-sep{width:1px;height:22px;background:#E6E0D3;margin:0 8px;flex-shrink:0;}'+
    '.rtb-cats-panel{position:absolute;top:calc(100% + 8px);inset-inline-start:0;width:340px;padding:10px;background:#fff;border:1px solid #E6E0D3;border-radius:16px;box-shadow:0 24px 50px -20px rgba(20,16,8,.35);display:none;grid-template-columns:1fr 1fr;gap:4px;z-index:220;}'+
    '.rtb-cats-panel.open{display:grid;}'+
    '.rtb-cats-panel a{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:11px;color:#15130F;text-decoration:none;font-size:13.5px;font-weight:700;}'+
    '.rtb-cats-panel a:hover{background:#F6F2E9;color:#A07828;}'+
    '.rtb-cats-panel a i{width:32px;height:32px;border-radius:10px;background:rgba(201,168,76,.13);color:#A07828;display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;}'+
    '.rtb-cats-panel a.all{grid-column:1/-1;border-top:1px solid #EEE8DC;border-radius:0 0 11px 11px;margin-top:4px;color:#A07828;}'+
    '.rtb-cats-panel a.all i{background:transparent;}'+
    '.rtb-msearch{display:none;}'+
    /* tablet-portrait + phones (≤860): app chrome (no inline search/subnav) + visible mobile search bar */
    '@media(max-width:860px){'+
      'nav:not(.app-bnav):not(.top){height:62px!important;padding:0 14px!important;}.rtb-inner{gap:12px;}.rtb-search{display:none;}.rtb-subnav{display:none;}.rtb-logo img{height:40px;}'+
      /* gutter matches the page content width so the field lines up with the
         sections below it */
      '.rtb-msearch{display:block;background:#fff;border-bottom:1px solid #EEE8DC;padding:8px 16px 12px;}'+
      '.rtb-msearch form{position:relative;max-width:680px;margin:0 auto;}'+
      '.rtb-msearch input{width:100%;height:46px;border:1px solid #E6E0D3;background:#F8F6F1;border-radius:999px;padding:0;padding-inline-start:18px;padding-inline-end:94px;font-family:"Tajawal",sans-serif;font-size:14.5px;color:#0A0A0A;outline:none;}'+
      '.rtb-msearch input:focus{background:#fff;border-color:#C9A84C;box-shadow:0 0 0 3px rgba(201,168,76,.14);}'+
      '.rtb-msearch button{position:absolute;top:50%;transform:translateY(-50%);inset-inline-end:4px;width:38px;height:38px;min-height:38px;flex-shrink:0;border:none;border-radius:50%;background:#15130F;color:#fff;display:flex;align-items:center;justify-content:center;font-size:17px;cursor:pointer;}'+
      '.rtb-msearch button.rtb-mfilter{inset-inline-end:46px;background:transparent;color:#5A5650;}'+
      '.rtb-msearch button.rtb-mfilter:hover{color:#A07828;}'+
    '}'+
    /* tablet + mobile (≤1024): language lives in the hamburger; cart/wishlist/account live in the bottom nav → remove from header */
    '@media(max-width:1024px){.rtb-lang{display:none!important;}.rtb-actions .rtb-act{display:none!important;}.rtb-actions .rn-bell::after{display:none;}.rtb-actions .rn-bell{min-width:40px;height:40px!important;}}'+
    '@media(max-width:1180px) and (min-width:861px){.rtb-inner{gap:18px;}.rtb-logo img{height:44px;}}';
    var s=document.createElement('style'); s.id='raf-topbar-css'; s.textContent=c; document.head.appendChild(s);
  }

  function cartCount(){ try{var a=JSON.parse(localStorage.getItem('raf_cart')||'[]');return Array.isArray(a)?a.reduce(function(s,i){return s+(i.qty||1);},0):0;}catch(e){return 0;} }

  /* the page this header is on, to mark its link as current */
  function here(){ return (location.pathname.split('/').pop() || '').toLowerCase(); }
  function onCls(file){ return here() === file ? ' class="on" aria-current="page"' : ''; }

  function linksHTML(){
    return '<a href="raf_homepage.html"'+onCls('raf_homepage.html')+'><span data-ar="الرئيسية" data-en="Home">'+t('الرئيسية','Home')+'</span></a>'+
      '<a href="raf_storespage.html"'+onCls('raf_storespage.html')+'><span data-ar="المحلات" data-en="Stores">'+t('المحلات','Stores')+'</span></a>'+
      '<a href="raf_offers.html?all=1"'+(here()==='raf_offers.html'&&location.search?' class="on" aria-current="page"':'')+'><span data-ar="المنتجات" data-en="Products">'+t('المنتجات','Products')+'</span></a>'+
      '<a href="raf_offers.html"'+(here()==='raf_offers.html'&&!location.search?' class="on" aria-current="page"':'')+'><span data-ar="العروض" data-en="Offers">'+t('العروض','Offers')+'</span></a>'+
      '<a href="raf_auctions.html" data-feature="auctions"'+onCls('raf_auctions.html')+'><span data-ar="المزادات" data-en="Auctions">'+t('المزادات','Auctions')+'</span></a>'+
      '<a href="raf_trending.html"'+onCls('raf_trending.html')+'><span data-ar="الترندات" data-en="Trends">'+t('الترندات','Trends')+'</span></a>'+
      '<a href="raf_used.html" data-feature="used"'+onCls('raf_used.html')+'><span data-ar="المستعمل" data-en="Used">'+t('المستعمل','Used')+'</span></a>';
  }

  /* "All categories" lists RAF's own categories (RAFCatalog) and opens the
     Products page filtered to one — the same routing the homepage uses. */
  function catsPanelHTML(){
    var cats = (global.RAFCatalog && RAFCatalog.categories) ? RAFCatalog.categories() : [];
    return cats.map(function(c){
      return '<a href="raf_offers.html?cat='+encodeURIComponent(c.k)+'"><i class="ti '+(c.ic||'ti-category')+'"></i><span>'+(en()?c.en:c.ar)+'</span></a>';
    }).join('') +
      '<a class="all" href="raf_offers.html"><i class="ti ti-layout-grid"></i><span>'+t('كل المنتجات','All products')+'</span></a>';
  }
  function closeCats(){
    var p=document.getElementById('rtbCatsPanel'), b=document.getElementById('rtbCatsBtn');
    if(p) p.classList.remove('open'); if(b) b.setAttribute('aria-expanded','false');
  }

  function build(){
    var nav=document.querySelector('nav:not(.app-bnav):not(.top)');
    if(!nav || nav.getAttribute('data-rtb')) return;
    nav.setAttribute('data-rtb','1');
    var ph=t('ابحث عن منتجات، محلات، أو ماركات…','Search products, stores or brands…');
    nav.innerHTML =
      '<div class="rtb-inner">'+
        '<a href="raf_homepage.html" class="rtb-logo" aria-label="RAF"><img src="assets/branding/logo.svg" alt="RAF Marketplace"></a>'+
        '<form class="rtb-search" role="search" onsubmit="return RAFTopbar.submit(event)"><input id="navSearch" type="text" autocomplete="off" placeholder="'+ph+'" aria-label="'+t('بحث','Search')+'">'+
          '<button type="button" class="rtb-filter" onclick="RAFTopbar.filters(event)" aria-label="'+t('تصفية','Filter')+'" title="'+t('تصفية','Filter')+'"><i class="ti ti-adjustments-horizontal"></i></button>'+
          '<button type="submit" aria-label="'+t('بحث','Search')+'"><i class="ti ti-search"></i></button></form>'+
        '<div class="rtb-actions">'+
          '<button class="rtb-lang" onclick="RAFTopbar.lang()"><span class="dot"></span><span id="langLabel" class="rtb-lang-l">'+(en()?'ع':'EN')+'</span></button>'+
          '<a href="raf_account.html" class="rtb-act rtb-account'+(here()==='raf_account.html'?' on':'')+'"><i class="ti ti-user"></i><span class="rtb-account-l" data-ar="حسابي" data-en="Account">'+t('حسابي','Account')+'</span></a>'+
          '<a href="raf_wishlist.html" class="rtb-act rtb-ico'+(here()==='raf_wishlist.html'?' on':'')+'" title="'+t('المفضلة','Wishlist')+'"><i class="ti ti-heart"></i><span data-ar="المفضلة" data-en="Wishlist">'+t('المفضلة','Wishlist')+'</span></a>'+
          '<a href="raf_cart.html" class="rtb-act rtb-ico" title="'+t('السلة','Cart')+'"><i class="ti ti-shopping-cart"></i><span data-ar="السلة" data-en="Cart">'+t('السلة','Cart')+'</span><span class="rtb-badge" id="rtbCartBadge"></span></a>'+
        '</div>'+
      '</div>';
    var ms=document.createElement('div'); ms.className='rtb-msearch';
    ms.innerHTML='<form role="search" onsubmit="return RAFTopbar.submitM(event)"><input id="navSearchM" data-raf-search-input type="text" autocomplete="off" placeholder="'+ph+'" aria-label="'+t('بحث','Search')+'">'+
      '<button type="button" class="rtb-mfilter" onclick="RAFTopbar.filters(event)" aria-label="'+t('تصفية','Filter')+'"><i class="ti ti-adjustments-horizontal"></i></button>'+
      '<button type="submit" aria-label="'+t('بحث','Search')+'"><i class="ti ti-search"></i></button></form>';
    if(nav.nextSibling) nav.parentNode.insertBefore(ms, nav.nextSibling); else nav.parentNode.appendChild(ms);
    var sub=document.createElement('div'); sub.className='rtb-subnav';
    sub.innerHTML='<div class="rtb-sub-inner">'+
      '<div class="rtb-cats"><button type="button" class="rtb-cats-btn" id="rtbCatsBtn" aria-haspopup="true" aria-expanded="false" aria-controls="rtbCatsPanel" onclick="RAFTopbar.cats(event)">'+
        '<i class="ti ti-menu-2"></i><span data-ar="جميع الأقسام" data-en="All categories">'+t('جميع الأقسام','All categories')+'</span></button>'+
        '<div class="rtb-cats-panel" id="rtbCatsPanel" role="menu"></div></div>'+
      '<span class="rtb-sep" aria-hidden="true"></span>'+
      '<div class="rtb-links">'+linksHTML()+'</div>'+
    '</div>';
    if(ms.nextSibling) nav.parentNode.insertBefore(sub, ms.nextSibling); else nav.parentNode.appendChild(sub);
    document.addEventListener('click', function(e){ if(!e.target.closest || !e.target.closest('.rtb-cats')) closeCats(); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape') closeCats(); });
    updateBadge();
  }
  function updateBadge(){ var b=document.getElementById('rtbCartBadge'); if(!b)return; var n=cartCount(); if(n>0){b.textContent=n>99?'99+':n;b.style.display='flex';} else b.style.display='none'; }

  var API={
    submit:function(e){ e.preventDefault(); var inp=document.getElementById('navSearch'); var q=(inp&&inp.value||'').trim(); if(window.RAFSearch&&RAFSearch.close)RAFSearch.close(); if(q){ try{var a=JSON.parse(localStorage.getItem('raf_recent_searches')||'[]');a=a.filter(function(x){return x!==q;});a.unshift(q);localStorage.setItem('raf_recent_searches',JSON.stringify(a.slice(0,6)));}catch(_){ } window.location='raf_offers.html?q='+encodeURIComponent(q); } return false; },
    submitM:function(e){ e.preventDefault(); var inp=document.getElementById('navSearchM'); var q=(inp&&inp.value||'').trim(); if(window.RAFSearch&&RAFSearch.close)RAFSearch.close(); if(q){ try{var a=JSON.parse(localStorage.getItem('raf_recent_searches')||'[]');a=a.filter(function(x){return x!==q;});a.unshift(q);localStorage.setItem('raf_recent_searches',JSON.stringify(a.slice(0,6)));}catch(_){ } window.location='raf_offers.html?q='+encodeURIComponent(q); } return false; },
    /* Filter control. Pages that own a filter sheet (homepage, store) open it
       in place; everywhere else it leads to the Products page, where the real
       category/price filtering lives. Same control on every page either way. */
    filters:function(e){
      if(e){ e.preventDefault(); e.stopPropagation(); }
      if(window.RAFSearch && RAFSearch.close) RAFSearch.close();
      if(typeof window.openFilters==='function' && !window.__rtbFilterRouting){ window.openFilters(e); return false; }
      window.location='raf_offers.html';
      return false;
    },
    /* the categories menu is filled when opened, so it always reflects the
       live category list and the current language */
    cats:function(e){
      if(e){ e.preventDefault(); e.stopPropagation(); }
      var p=document.getElementById('rtbCatsPanel'), b=document.getElementById('rtbCatsBtn');
      if(!p) return false;
      if(p.classList.contains('open')){ closeCats(); return false; }
      p.innerHTML=catsPanelHTML(); p.classList.add('open'); b.setAttribute('aria-expanded','true');
      return false;
    },
    lang:function(){ if(window.toggleLang){ toggleLang(); } API.retext(); },
    /* Placeholders, titles and aria-labels are baked in at build time, so they
       need re-translating whenever the language flips. */
    retext:function(){
      var ph=t('ابحث عن منتجات، محلات، أو ماركات…','Search products, stores or brands…');
      ['navSearch','navSearchM'].forEach(function(id){ var i=document.getElementById(id); if(i){ i.placeholder=ph; i.setAttribute('aria-label',t('بحث','Search')); } });
      document.querySelectorAll('.rtb-filter,.rtb-mfilter').forEach(function(b){
        b.setAttribute('aria-label',t('تصفية','Filter')); b.setAttribute('title',t('تصفية','Filter'));
      });
      document.querySelectorAll('.rtb-search>button[type="submit"],.rtb-msearch button[type="submit"]').forEach(function(b){
        b.setAttribute('aria-label',t('بحث','Search'));
      });
      var w=document.querySelector('.rtb-actions a[href="raf_wishlist.html"]'); if(w) w.title=t('المفضلة','Wishlist');
      var c=document.querySelector('.rtb-actions a[href="raf_cart.html"]');     if(c) c.title=t('السلة','Cart');
      document.querySelectorAll('.rtb-inner [data-ar], .rtb-subnav [data-ar]').forEach(function(n){ n.textContent=en()?n.getAttribute('data-en'):n.getAttribute('data-ar'); });
      var bell=document.querySelector('.rtb-actions .rn-bell'); if(bell) bell.setAttribute('aria-label',t('الإشعارات','Notifications'));
      var p=document.getElementById('rtbCatsPanel'); if(p && p.classList.contains('open')) p.innerHTML=catsPanelHTML();
      var l=document.querySelector('.rtb-lang-l'); if(l) l.textContent=en()?'ع':'EN';
    },
    refresh:updateBadge
  };
  global.RAFTopbar=API;

  function init(){
    injectCSS(); build();
    /* keep header text in the active language however the page switches it */
    var r=document.getElementById('htmlRoot')||document.documentElement;
    new MutationObserver(function(){ API.retext(); }).observe(r,{attributes:true,attributeFilter:['lang']});
  }
  /* run immediately (script is at end of <body>, header nav already parsed) so
     this executes BEFORE raf_nav.js injects its hamburger into the new header. */
  init();
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ build(); updateBadge(); });
})(window);
