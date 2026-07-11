/* ============================================================================
 * RAF Marketplace — Shared Premium Header (Top Bar)
 * ----------------------------------------------------------------------------
 * Replaces a customer page's legacy <nav> with the homepage's premium header:
 *   logo + unified search (#navSearch, picked up by raf_search.js) + actions
 *   (lang · wishlist · cart+badge · account) + a sticky category subnav.
 * Include AFTER the page scripts and BEFORE raf_search.js. Markup-only swap of
 * the header; the page body is untouched.
 * ==========================================================================*/
(function (global) {
  'use strict';

  function en(){ var r=document.getElementById('htmlRoot'); return (r?r.lang:document.documentElement.lang)==='en'; }
  function t(ar,e){ return en()?e:ar; }

  function injectCSS(){
    if(document.getElementById('raf-topbar-css')) return;
    var c=
    'nav:not(.app-bnav):not(.top){background:rgba(245,242,236,.9)!important;backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border-bottom:1px solid #E2DBCC!important;display:flex!important;align-items:center;justify-content:center;padding:0 28px!important;gap:0!important;z-index:200;}'+
    '.rtb-inner{width:100%;max-width:1300px;height:100%;display:flex;align-items:center;gap:24px;}'+
    '.rtb-logo{flex-shrink:0;display:inline-flex;align-items:center;}.rtb-logo img{height:56px;width:auto;display:block;}'+
    '.rtb-search{flex:1;max-width:1000px;position:relative;}'+
    '.rtb-search input{width:100%;height:52px;border:1.5px solid #D8D3C8;background:#fff;border-radius:14px;padding:0 54px 0 18px;font-family:"Tajawal",sans-serif;font-size:15px;color:#0A0A0A;outline:none;transition:border-color .2s,box-shadow .2s;box-shadow:0 4px 16px rgba(20,16,8,.06);}'+
    '.rtb-search input::placeholder{color:#8A857C;}'+
    '.rtb-search input:focus{border-color:#C9A84C;box-shadow:0 0 0 4px rgba(201,168,76,.12);}'+
    '.rtb-search>button{position:absolute;top:6px;right:6px;width:40px;height:40px;border:none;border-radius:11px;background:#C9A84C;color:#0A0A0A;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:20px;transition:background .2s;}'+
    '.rtb-search>button:hover{background:#A07828;}'+
    '.rtb-actions{display:flex;align-items:center;gap:8px;flex-shrink:0;}'+
    '.rtb-ico{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#15130F;cursor:pointer;background:transparent;position:relative;font-size:20px;transition:all .2s;text-decoration:none;}'+
    '.rtb-ico:hover{background:rgba(201,168,76,.12);color:#A07828;}'+
    '.rtb-badge{position:absolute;top:3px;right:3px;min-width:16px;height:16px;padding:0 4px;background:#C9A84C;color:#0A0A0A;border-radius:10px;font-size:10px;font-weight:700;font-family:"DM Sans",sans-serif;display:none;align-items:center;justify-content:center;}'+
    '.rtb-account{display:inline-flex;align-items:center;gap:7px;height:44px;padding:0 18px;border-radius:30px;background:#15130F;color:#F5F2EC;font-size:13px;font-weight:700;transition:background .2s;text-decoration:none;font-family:"Tajawal",sans-serif;}'+
    '.rtb-account:hover{background:#A07828;}'+
    '.rtb-lang{height:40px;padding:0 13px;border:1px solid #D8D3C8;border-radius:30px;background:transparent;color:#5A5650;font-family:"DM Sans",sans-serif;font-size:11px;font-weight:600;letter-spacing:1px;cursor:pointer;transition:all .2s;display:inline-flex;align-items:center;gap:5px;}'+
    '.rtb-lang:hover{border-color:#C9A84C;color:#A07828;}.rtb-lang .dot{width:5px;height:5px;border-radius:50%;background:#C9A84C;}'+
    '.rtb-subnav{position:sticky;top:72px;z-index:190;background:#fff;border-bottom:1px solid #E2DBCC;}'+
    '.rtb-sub-inner{max-width:1300px;margin:0 auto;display:flex;align-items:center;gap:4px;height:46px;overflow-x:auto;scrollbar-width:none;padding:0 28px;}'+
    '.rtb-sub-inner::-webkit-scrollbar{display:none;}'+
    '.rtb-sub-inner a{font-size:13.5px;font-weight:500;color:#5A5650;padding:8px 14px;border-radius:8px;white-space:nowrap;transition:all .2s;display:inline-flex;align-items:center;gap:6px;text-decoration:none;}'+
    '.rtb-sub-inner a i{font-size:16px;color:#A07828;}.rtb-sub-inner a:hover{background:#EDE8DC;color:#15130F;}'+
    '.rtb-msearch{display:none;}'+
    /* tablet-portrait + phones (≤860): app chrome (no inline search/subnav) + visible mobile search bar */
    '@media(max-width:860px){'+
      'nav:not(.app-bnav):not(.top){padding:0 14px!important;}.rtb-inner{gap:12px;}.rtb-search{display:none;}.rtb-subnav{display:none;}.rtb-account-l{display:none;}.rtb-account{padding:0 14px;}.rtb-logo img{height:42px;}'+
      '.rtb-msearch{display:block;background:rgba(245,242,236,.92);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border-bottom:1px solid #E2DBCC;padding:10px 14px;}'+
      '.rtb-msearch form{position:relative;max-width:680px;margin:0 auto;}'+
      '.rtb-msearch input{width:100%;height:46px;border:1.5px solid #D8D3C8;background:#fff;border-radius:13px;padding:0 48px 0 16px;font-family:"Tajawal",sans-serif;font-size:14.5px;color:#0A0A0A;outline:none;box-shadow:0 2px 10px rgba(20,16,8,.05);}'+
      '.rtb-msearch input:focus{border-color:#C9A84C;box-shadow:0 0 0 3px rgba(201,168,76,.12);}'+
      '.rtb-msearch button{position:absolute;top:5px;right:5px;width:36px;height:36px;border:none;border-radius:10px;background:#C9A84C;color:#0A0A0A;display:flex;align-items:center;justify-content:center;font-size:18px;cursor:pointer;}'+
    '}'+
    /* tablet + mobile (≤1024): language lives in the hamburger; cart/wishlist/account live in the bottom nav → remove from header */
    '@media(max-width:1024px){.rtb-lang{display:none!important;}.rtb-actions .rtb-ico,.rtb-actions .rtb-account{display:none!important;}}'+
    '@media(max-width:480px){.rtb-logo img{height:38px;}}';
    var s=document.createElement('style'); s.id='raf-topbar-css'; s.textContent=c; document.head.appendChild(s);
  }

  function cartCount(){ try{var a=JSON.parse(localStorage.getItem('raf_cart')||'[]');return Array.isArray(a)?a.reduce(function(s,i){return s+(i.qty||1);},0):0;}catch(e){return 0;} }

  function build(){
    var nav=document.querySelector('nav:not(.app-bnav):not(.top)');
    if(!nav || nav.getAttribute('data-rtb')) return;
    nav.setAttribute('data-rtb','1');
    var ph=t('ابحث عن منتجات، محلات، أو ماركات…','Search products, stores or brands…');
    nav.innerHTML =
      '<div class="rtb-inner">'+
        '<a href="raf_homepage.html" class="rtb-logo"><img src="assets/branding/logo.svg" alt="RAF Marketplace"></a>'+
        '<form class="rtb-search" onsubmit="return RAFTopbar.submit(event)"><input id="navSearch" type="text" autocomplete="off" placeholder="'+ph+'"><button type="submit" aria-label="search"><i class="ti ti-search"></i></button></form>'+
        '<div class="rtb-actions">'+
          '<button class="rtb-lang" onclick="RAFTopbar.lang()"><span class="dot"></span><span id="langLabel" class="rtb-lang-l">'+(en()?'ع':'EN')+'</span></button>'+
          '<a href="raf_wishlist.html" class="rtb-ico" title="'+t('المفضلة','Wishlist')+'"><i class="ti ti-heart"></i></a>'+
          '<a href="raf_cart.html" class="rtb-ico" title="'+t('السلة','Cart')+'"><i class="ti ti-shopping-cart"></i><span class="rtb-badge" id="rtbCartBadge"></span></a>'+
          '<a href="raf_account.html" class="rtb-account"><i class="ti ti-user"></i><span class="rtb-account-l" data-ar="حسابي" data-en="Account">'+t('حسابي','Account')+'</span></a>'+
        '</div>'+
      '</div>';
    var ms=document.createElement('div'); ms.className='rtb-msearch';
    ms.innerHTML='<form onsubmit="return RAFTopbar.submitM(event)"><input id="navSearchM" data-raf-search-input type="text" autocomplete="off" placeholder="'+ph+'"><button type="submit" aria-label="search"><i class="ti ti-search"></i></button></form>';
    if(nav.nextSibling) nav.parentNode.insertBefore(ms, nav.nextSibling); else nav.parentNode.appendChild(ms);
    var sub=document.createElement('div'); sub.className='rtb-subnav';
    sub.innerHTML='<div class="rtb-sub-inner">'+
      '<a href="raf_storespage.html"><i class="ti ti-building-store"></i> <span data-ar="المحلات" data-en="Stores">'+t('المحلات','Stores')+'</span></a>'+
      '<a href="raf_offers.html"><i class="ti ti-box"></i> <span data-ar="المنتجات" data-en="Products">'+t('المنتجات','Products')+'</span></a>'+
      '<a href="raf_offers.html"><i class="ti ti-discount"></i> <span data-ar="العروض" data-en="Offers">'+t('العروض','Offers')+'</span></a>'+
      '<a href="raf_auctions.html" data-feature="auctions"><i class="ti ti-gavel"></i> <span data-ar="المزادات" data-en="Auctions">'+t('المزادات','Auctions')+'</span></a>'+
      '<a href="raf_trending.html"><i class="ti ti-flame"></i> <span data-ar="الترندات" data-en="Trends">'+t('الترندات','Trends')+'</span></a>'+
      '<a href="raf_used.html" data-feature="used"><i class="ti ti-recycle"></i> <span data-ar="المستعمل" data-en="Used">'+t('المستعمل','Used')+'</span></a>'+
    '</div>';
    if(ms.nextSibling) nav.parentNode.insertBefore(sub, ms.nextSibling); else nav.parentNode.appendChild(sub);
    updateBadge();
  }
  function updateBadge(){ var b=document.getElementById('rtbCartBadge'); if(!b)return; var n=cartCount(); if(n>0){b.textContent=n>99?'99+':n;b.style.display='flex';} else b.style.display='none'; }

  var API={
    submit:function(e){ e.preventDefault(); var inp=document.getElementById('navSearch'); var q=(inp&&inp.value||'').trim(); if(window.RAFSearch&&RAFSearch.close)RAFSearch.close(); if(q){ try{var a=JSON.parse(localStorage.getItem('raf_recent_searches')||'[]');a=a.filter(function(x){return x!==q;});a.unshift(q);localStorage.setItem('raf_recent_searches',JSON.stringify(a.slice(0,6)));}catch(_){ } window.location='raf_offers.html?q='+encodeURIComponent(q); } return false; },
    submitM:function(e){ e.preventDefault(); var inp=document.getElementById('navSearchM'); var q=(inp&&inp.value||'').trim(); if(window.RAFSearch&&RAFSearch.close)RAFSearch.close(); if(q){ try{var a=JSON.parse(localStorage.getItem('raf_recent_searches')||'[]');a=a.filter(function(x){return x!==q;});a.unshift(q);localStorage.setItem('raf_recent_searches',JSON.stringify(a.slice(0,6)));}catch(_){ } window.location='raf_offers.html?q='+encodeURIComponent(q); } return false; },
    lang:function(){ if(window.toggleLang){ toggleLang(); } var l=document.querySelector('.rtb-lang-l'); if(l)l.textContent=en()?'ع':'EN'; },
    refresh:updateBadge
  };
  global.RAFTopbar=API;

  function init(){ injectCSS(); build(); }
  /* run immediately (script is at end of <body>, header nav already parsed) so
     this executes BEFORE raf_nav.js injects its hamburger into the new header. */
  init();
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',function(){ build(); updateBadge(); });
})(window);
