/* ============================================================================
 * RAF Marketplace — Shared Search Experience (unified across all pages)
 * ----------------------------------------------------------------------------
 * Drop-in: include <script src="raf_search.js"></script> on any page.
 * It auto-attaches the unified search overlay to the page's existing search
 * input(s) WITHOUT removing their on-page filtering. Same bar feel, overlay,
 * animations, behavior and responsive logic as the homepage.
 *
 * Overlay: Quick Actions · Recently Searched · Popular Right Now ·
 *          Browsing History · Live Suggestions (Products/Stores/Categories).
 * Behaviour: opens on focus, live suggestions on type, closes on outside
 *            click / Esc / after search. Desktop, tablet, mobile.
 *
 * Future admin/DB-ready: replace CATALOG with an API response — no redesign.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* inputs to upgrade (by id) + any [data-raf-search-input] */
  var INPUT_IDS = ['prodSearch','storeSearch','auctSearch','trendSearch','usedSearch','navSearch','siteSearch'];

  /* shared catalog for live suggestions (admin/API-ready) */
  var CATEGORIES = [
    {id:'electronics',ar:'إلكترونيات',en:'Electronics',icon:'ti-device-mobile'},
    {id:'fashion',ar:'أزياء',en:'Fashion',icon:'ti-hanger'},
    {id:'perfume',ar:'عطور',en:'Perfume',icon:'ti-spray'},
    {id:'watches',ar:'ساعات',en:'Watches',icon:'ti-clock-hour-4'},
    {id:'jewelry',ar:'مجوهرات',en:'Jewelry',icon:'ti-diamond'},
    {id:'kids',ar:'أطفال',en:'Kids',icon:'ti-baby-carriage'},
    {id:'home',ar:'المنزل والمطبخ',en:'Home & Kitchen',icon:'ti-home'},
    {id:'sports',ar:'رياضة',en:'Sports',icon:'ti-ball-football'}
  ];
  /* sku links a suggestion to the shared catalog so it can open Quick Order */
  var PRODUCTS = [
    {sku:'P-EARBUDS',ic:'ti-device-mobile',ar:'سماعات لاسلكية فاخرة',en:'Premium Wireless Earbuds',store:{ar:'تك هاوس',en:'Tech House'},price:'24.500'},
    {sku:'P-PERFUME',ic:'ti-spray',ar:'عطر شرقي فاخر',en:'Luxury Oriental Perfume',store:{ar:'دار العود',en:'Dar Aloud'},price:'42.000'},
    {sku:'P-WATCH',ic:'ti-clock-hour-4',ar:'ساعة كلاسيكية جلد',en:'Classic Leather Watch',store:{ar:'تايم بوكس',en:'Time Box'},price:'68.000'},
    {sku:'P-JACKET',ic:'ti-hanger',ar:'جاكيت شتوي عصري',en:'Modern Winter Jacket',store:{ar:'كازا مود',en:'Casa Mode'},price:'29.900'},
    {sku:'P-HEADPHONES',ic:'ti-headphones',ar:'سماعة رأس احترافية',en:'Pro Headphones',store:{ar:'تك هاوس',en:'Tech House'},price:'38.000'},
    {sku:'P-006',ic:'ti-diamond',ar:'خاتم فضة مرصّع',en:'Studded Silver Ring',store:{ar:'لمسة ذهب',en:'Lamsa Gold'},price:'33.000'},
    {sku:'P-002',ic:'ti-shoe',ar:'حذاء رياضي خفيف',en:'Lightweight Sneakers',store:{ar:'ستيب',en:'Step'},price:'19.500'},
    {sku:'P-005',ic:'ti-briefcase',ar:'حقيبة يد جلدية',en:'Leather Handbag',store:{ar:'مود',en:'Mood'},price:'55.000'}
  ];
  /* multi-store search results open the lightweight Quick Order page */
  function prodHref(p){ return p.sku ? 'raf_quick.html?id='+encodeURIComponent(p.sku) : 'raf_quick.html'; }
  /* availability from the shared rule, so search agrees with every listing */
  function isOOS(p){ return !!(window.RAFShop && RAFShop.Stock && RAFShop.Stock.isOOS({ id:p.sku, stock:p.stock })); }
  function oosTag(p){ return isOOS(p) ? '<span class="rs-oos">'+(en()?'Sold Out':'نفدت الكمية')+'</span>' : ''; }
  var STORES = [
    {ic:'ti-device-mobile',ar:'تك هاوس',en:'Tech House',rate:'4.8',prod:'320'},
    {ic:'ti-spray',ar:'دار العود',en:'Dar Aloud',rate:'4.9',prod:'180'},
    {ic:'ti-hanger',ar:'كازا مود',en:'Casa Mode',rate:'4.7',prod:'450'},
    {ic:'ti-diamond',ar:'لمسة ذهب',en:'Lamsa Gold',rate:'5.0',prod:'95'},
    {ic:'ti-clock-hour-4',ar:'تايم بوكس',en:'Time Box',rate:'4.7',prod:'140'}
  ];
  var POPULAR = [{ar:'آيفون',en:'iPhone'},{ar:'عطر',en:'Perfume'},{ar:'ساعة ذكية',en:'Smart Watch'},{ar:'حذاء رياضي',en:'Sneakers'},{ar:'حقيبة',en:'Bag'},{ar:'سماعات',en:'Earbuds'}];
  var QUICK = [
    {ar:'المنتجات',en:'Products',ic:'ti-box',href:'raf_offers.html'},
    {ar:'المحلات',en:'Stores',ic:'ti-building-store',href:'raf_storespage.html'},
    {ar:'العروض',en:'Offers',ic:'ti-discount',href:'raf_offers.html'},
    {ar:'المزادات',en:'Auctions',ic:'ti-gavel',href:'raf_auctions.html'},
    {ar:'الترندات',en:'Trends',ic:'ti-flame',href:'raf_trending.html'}
  ];

  function en(){ var r=document.getElementById('htmlRoot'); return (r?r.lang:document.documentElement.lang)==='en'; }
  function L(o){ return en()?o.en:o.ar; }
  function lsGet(k,f){ try{return JSON.parse(localStorage.getItem(k))||f;}catch(e){return f;} }
  function lsSet(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch(e){} }

  var ov, backdrop, activeInput=null;

  function injectCSS(){
    if(document.getElementById('raf-search-css')) return;
    var c=
    '.rs-overlay{position:fixed;background:#fff;border:1px solid #E2DBCC;border-radius:16px;box-shadow:0 18px 50px rgba(20,16,8,.16);padding:16px;z-index:5000;max-height:74vh;overflow-y:auto;opacity:0;visibility:hidden;transform:translateY(-8px);transition:opacity .2s,transform .2s,visibility .2s;pointer-events:none;font-family:"Tajawal",sans-serif;}'+
    '.rs-overlay.open{opacity:1;visibility:visible;transform:translateY(0);pointer-events:auto;}'+
    '.rs-backdrop{position:fixed;inset:0;z-index:4999;display:none;}.rs-backdrop.open{display:block;}'+
    '.rs-actions{display:flex;gap:8px;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #E2DBCC;}'+
    '.rs-action{flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:6px;padding:11px 4px;border:1px solid #E2DBCC;border-radius:12px;background:#EDE8DC;cursor:pointer;transition:all .15s;color:#5A5650;font-size:11.5px;font-weight:600;text-align:center;text-decoration:none;}'+
    '.rs-action:hover{border-color:#C9A84C;color:#A07828;background:rgba(201,168,76,.12);}'+
    '.rs-action i{font-size:20px;color:#A07828;}'+
    '.rs-block{margin-bottom:16px;}.rs-block:last-child{margin-bottom:0;}'+
    '.rs-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;}'+
    '.rs-head h4{font-size:12px;letter-spacing:1px;text-transform:uppercase;color:#8A857C;font-family:"DM Sans",sans-serif;font-weight:700;display:flex;align-items:center;gap:6px;margin:0;}'+
    '.rs-head h4 i{color:#A07828;font-size:15px;}'+
    '.rs-clear{font-size:11px;color:#8A857C;background:none;border:none;cursor:pointer;font-family:"Tajawal",sans-serif;}.rs-clear:hover{color:#D9534F;}'+
    '.rs-recent{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:8px;cursor:pointer;transition:background .15s;}'+
    '.rs-recent:hover{background:#EDE8DC;}.rs-recent span{display:flex;align-items:center;gap:9px;font-size:13.5px;color:#0A0A0A;}.rs-recent span i{color:#8A857C;font-size:16px;}'+
    '.rs-recent .x{color:#8A857C;font-size:16px;padding:2px;}.rs-recent .x:hover{color:#D9534F;}'+
    '.rs-tags{display:flex;flex-wrap:wrap;gap:8px;}'+
    '.rs-tag{padding:7px 13px;background:#EDE8DC;border:1px solid #E2DBCC;border-radius:20px;font-size:12.5px;color:#5A5650;cursor:pointer;transition:all .15s;display:inline-flex;align-items:center;gap:5px;}'+
    '.rs-tag:hover{border-color:#C9A84C;color:#A07828;background:rgba(201,168,76,.12);}.rs-tag i{font-size:13px;color:#A07828;}'+
    '.rs-hist{display:flex;gap:12px;overflow-x:auto;padding-bottom:4px;}.rs-hist::-webkit-scrollbar{display:none;}'+
    '.rs-hcard{flex:0 0 auto;width:110px;cursor:pointer;text-decoration:none;}'+
    '.rs-hthumb{width:110px;height:80px;border-radius:10px;background:linear-gradient(150deg,#EDE8DC,#E7E1D4);display:flex;align-items:center;justify-content:center;font-size:30px;color:#A07828;margin-bottom:6px;}'+
    '.rs-hcard.store .rs-hthumb{border-radius:50%;width:60px;height:60px;margin:0 auto 6px;}'+
    '.rs-hname{font-size:12px;color:#0A0A0A;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'+
    '.rs-item{display:flex;align-items:center;gap:11px;padding:8px 10px;border-radius:9px;cursor:pointer;transition:background .15s;text-decoration:none;}'+
    '.rs-item:hover{background:#EDE8DC;}'+
    '.rs-thumb{width:42px;height:42px;border-radius:10px;background:linear-gradient(150deg,#EDE8DC,#E7E1D4);display:flex;align-items:center;justify-content:center;font-size:21px;color:#A07828;flex-shrink:0;}'+
    '.rs-thumb.store{border-radius:50%;}.rs-thumb.cat{border-radius:50%;background:rgba(201,168,76,.12);}'+
    '.rs-info{flex:1;min-width:0;}.rs-name{font-size:13.5px;font-weight:600;color:#0A0A0A;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'+
    '.rs-item.is-oos .rs-thumb{filter:grayscale(1);opacity:.6;}'+
    '.rs-oos{display:inline-block;margin-inline-start:7px;background:#15130F;color:#F3EFE5;font-size:10px;font-weight:700;padding:2px 7px;border-radius:20px;vertical-align:middle;}'+
    '.rs-meta{font-size:11.5px;color:#8A857C;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.rs-go{color:#8A857C;font-size:16px;flex-shrink:0;}'+
    '.rs-none{text-align:center;color:#8A857C;font-size:13px;padding:16px;}';
    var s=document.createElement('style'); s.id='raf-search-css'; s.textContent=c; document.head.appendChild(s);
  }

  function quickHTML(){ return '<div class="rs-actions">'+QUICK.map(function(a){return '<a class="rs-action" href="'+a.href+'"><i class="ti '+a.ic+'"></i> '+L(a)+'</a>';}).join('')+'</div>'; }

  function renderDefault(){
    var recents=lsGet('raf_recent_searches',[]), views=lsGet('raf_recent_views',[]);
    var html=quickHTML();
    if(recents.length){
      html+='<div class="rs-block"><div class="rs-head"><h4><i class="ti ti-history"></i> '+(en()?'Recently Searched':'عمليات بحث سابقة')+'</h4><button class="rs-clear" onclick="RAFSearch.clearAll()">'+(en()?'Clear all':'مسح الكل')+'</button></div>';
      html+=recents.map(function(q,i){return '<div class="rs-recent" onclick="RAFSearch.run(\''+encodeURIComponent(q)+'\')"><span><i class="ti ti-search"></i> '+q+'</span><i class="ti ti-x x" onclick="RAFSearch.del('+i+',event)"></i></div>';}).join('')+'</div>';
    }
    html+='<div class="rs-block"><div class="rs-head"><h4><i class="ti ti-trending-up"></i> '+(en()?'Popular Right Now':'الأكثر بحثاً الآن')+'</h4></div><div class="rs-tags">';
    html+=POPULAR.map(function(p){return '<span class="rs-tag" onclick="RAFSearch.run(\''+encodeURIComponent(L(p))+'\')"><i class="ti ti-flame"></i> '+L(p)+'</span>';}).join('')+'</div></div>';
    if(views.length){
      html+='<div class="rs-block"><div class="rs-head"><h4><i class="ti ti-eye"></i> '+(en()?'Browsing History':'شاهدت مؤخراً')+'</h4></div><div class="rs-hist">';
      html+=views.map(function(v){return '<a class="rs-hcard '+v.type+'" href="'+(v.type==='store'?'raf_store.html':prodHref(v))+'"><div class="rs-hthumb"><i class="ti '+v.ic+'"></i></div><div class="rs-hname">'+L(v)+'</div></a>';}).join('')+'</div></div>';
    }
    ov.innerHTML=html;
  }
  function renderSuggestions(q){
    var ql=q.toLowerCase();
    var m=function(o){return ((o.ar||'')+' '+(o.en||'')).toLowerCase().indexOf(ql)!==-1;};
    var cats=CATEGORIES.filter(m).slice(0,4), prods=PRODUCTS.filter(m).slice(0,4), stores=STORES.filter(m).slice(0,3);
    var grp=function(t,ic,items){return items.length?'<div class="rs-block"><div class="rs-head"><h4><i class="ti '+ic+'"></i> '+t+'</h4></div>'+items.join('')+'</div>':'';};
    var html=quickHTML();
    html+=grp(en()?'Categories':'الفئات','ti-category',cats.map(function(c){return '<a class="rs-item" href="raf_storespage.html?cat='+c.id+'"><div class="rs-thumb cat"><i class="ti '+c.icon+'"></i></div><div class="rs-info"><div class="rs-name">'+L(c)+'</div><div class="rs-meta">'+(en()?'Category':'فئة')+'</div></div><i class="ti ti-arrow-left rs-go"></i></a>';}));
    html+=grp(en()?'Products':'المنتجات','ti-box',prods.map(function(p){return '<a class="rs-item'+(isOOS(p)?' is-oos':'')+'" href="'+prodHref(p)+'"><div class="rs-thumb"><i class="ti '+p.ic+'"></i></div><div class="rs-info"><div class="rs-name">'+L(p)+oosTag(p)+'</div><div class="rs-meta">'+L(p.store)+' · '+p.price+' KWD</div></div><i class="ti ti-arrow-left rs-go"></i></a>';}));
    html+=grp(en()?'Stores':'المحلات','ti-building-store',stores.map(function(s){return '<a class="rs-item" href="raf_store.html"><div class="rs-thumb store"><i class="ti '+s.ic+'"></i></div><div class="rs-info"><div class="rs-name">'+L(s)+'</div><div class="rs-meta">'+s.prod+' '+(en()?'products':'منتج')+' · ★ '+s.rate+'</div></div><i class="ti ti-arrow-left rs-go"></i></a>';}));
    if(!cats.length&&!prods.length&&!stores.length) html+='<div class="rs-none">'+(en()?'No matches found':'لا نتائج مطابقة')+'</div>';
    html+='<div class="rs-recent" style="background:rgba(201,168,76,.12);border:1px solid rgba(201,168,76,.3);margin-top:6px;" onclick="RAFSearch.run(\''+encodeURIComponent(q)+'\')"><span><i class="ti ti-search" style="color:#A07828"></i> '+(en()?'Search for':'ابحث عن')+' &quot;'+q+'&quot;</span><i class="ti ti-arrow-left" style="color:#A07828"></i></div>';
    ov.innerHTML=html;
  }
  function renderPanel(){ var q=activeInput?activeInput.value.trim():''; if(q.length>=1)renderSuggestions(q); else renderDefault(); }

  function position(){
    if(!activeInput) return;
    var r=activeInput.getBoundingClientRect();
    var w=Math.max(r.width, 300);
    var vw=document.documentElement.clientWidth;
    if(vw<=600){ ov.style.left='8px'; ov.style.right='8px'; ov.style.width='auto'; }
    else { var left=Math.min(r.left, vw-w-12); ov.style.left=Math.max(8,left)+'px'; ov.style.right='auto'; ov.style.width=w+'px'; }
    ov.style.top=(r.bottom+8)+'px';
  }
  function open(input){ activeInput=input; renderPanel(); position(); ov.classList.add('open'); backdrop.classList.add('open'); }
  function close(){ ov.classList.remove('open'); backdrop.classList.remove('open'); }
  function save(q){ if(!q)return; var a=lsGet('raf_recent_searches',[]); a=a.filter(function(x){return x!==q;}); a.unshift(q); a=a.slice(0,6); lsSet('raf_recent_searches',a); }

  var API = {
    run:function(q){ q=decodeURIComponent(q); save(q); window.location='raf_offers.html?q='+encodeURIComponent(q); },
    del:function(i,e){ e.stopPropagation(); var a=lsGet('raf_recent_searches',[]); a.splice(i,1); lsSet('raf_recent_searches',a); renderPanel(); },
    clearAll:function(){ lsSet('raf_recent_searches',[]); renderPanel(); },
    close:close, open:open
  };

  function attach(input){
    if(!input||input.__rafSearch) return; input.__rafSearch=true;
    input.setAttribute('autocomplete','off');
    input.addEventListener('focus',function(){ open(input); });
    input.addEventListener('input',function(){ activeInput=input; if(!ov.classList.contains('open')){ov.classList.add('open');backdrop.classList.add('open');} renderPanel(); position(); });
    input.addEventListener('keydown',function(e){ if(e.key==='Enter'){ e.preventDefault(); var q=input.value.trim(); if(q){ save(q); window.location='raf_offers.html?q='+encodeURIComponent(q); } } if(e.key==='Escape'){ close(); } });
  }

  function init(){
    injectCSS();
    ov=document.createElement('div'); ov.className='rs-overlay'; document.body.appendChild(ov);
    backdrop=document.createElement('div'); backdrop.className='rs-backdrop'; backdrop.addEventListener('click',close); document.body.appendChild(backdrop);
    window.addEventListener('scroll',function(){ if(ov.classList.contains('open')) position(); },true);
    window.addEventListener('resize',function(){ if(ov.classList.contains('open')) position(); });
    INPUT_IDS.forEach(function(id){ var el=document.getElementById(id); if(el) attach(el); });
    Array.prototype.forEach.call(document.querySelectorAll('[data-raf-search-input]'),attach);
  }

  API.attach=attach;
  global.RAFSearch=API;
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init); else init();
})(window);
