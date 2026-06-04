/* ============================================================================
 * RAF Marketplace — Shared Advertising Component (inter-section banners)
 * ----------------------------------------------------------------------------
 * One reusable, admin/DB-ready ad system. Drop <div class="ad-slot wrap"
 * data-ad-slot="ID"></div> anywhere and call RAFAds.mountAll(lang).
 *
 * EVERY slot is independently controllable and future-admin ready. A campaign
 * maps 1:1 to a DB row:
 *   campaigns(id, name, type, title_ar, title_en, sub_ar, sub_en, image, url,
 *             start_date, end_date, priority, status, enabled, clicks, impressions)
 *   ad_slots(id, position, campaign_id, show, override)
 *
 * Visibility resolution (so hidden slots collapse with NO empty space):
 *   visible = override!='hide'
 *             && (override=='show' OR slot.show)
 *             && campaign.enabled && campaign.status=='active'
 *             && now within [start_date, end_date]
 * Hidden slots are set display:none → layout auto-rebalances, no gaps.
 * ==========================================================================*/
(function (global) {
  'use strict';

  /* ---- CAMPAIGNS (admin/DB-ready records) -------------------------------- */
  var CAMPAIGNS = [
    { id:'cmp_seasonal', name:'Big Seasonal Sale', type:{ar:'حملة موسمية',en:'Seasonal Campaign'},
      title:{ar:'تخفيضات الموسم تصل إلى 70%',en:'Seasonal Sale — Up to 70% Off'},
      sub:{ar:'أفضل العروض من كل المحلات في مكان واحد.',en:'The best deals across all stores in one place.'},
      chips:[{ar:'كل الفئات',en:'All categories'},{ar:'حتى 70%',en:'Up to 70%'}], promo:'-70%',
      brand:{ar:'رف',en:'RAF',ic:'ti-discount'}, pic:'ti-confetti', image:'', url:'raf_offers.html',
      g:'radial-gradient(circle at 80% 35%,#3a1e5f,#0a0a0a)',
      startDate:'2026-01-01', endDate:'2026-12-31', priority:1, status:'active', enabled:true, clicks:0, impressions:0 },

    { id:'cmp_product', name:'Featured Gold Jewelry', type:{ar:'منتج مميّز',en:'Featured Product'},
      title:{ar:'مجوهرات ذهبية بتصاميم حصرية',en:'Exclusive Gold Jewelry'},
      sub:{ar:'تصاميم فاخرة عيار 21 مع ضمان رسمي.',en:'Premium 21K designs with official warranty.'},
      chips:[{ar:'عيار 21',en:'21K gold'},{ar:'ضمان',en:'Warranty'}], promo:'',
      brand:{ar:'لمسة ذهب',en:'Lamsa Gold',ic:'ti-diamond'}, pic:'ti-diamond', image:'', url:'raf_storespage.html?cat=jewelry',
      g:'radial-gradient(circle at 80% 35%,#1e5f3a,#0a0a0a)',
      startDate:'2026-01-01', endDate:'2026-12-31', priority:2, status:'active', enabled:true, clicks:0, impressions:0 },

    { id:'cmp_offer', name:'Perfume Flash Offer', type:{ar:'عرض خاص',en:'Special Offer'},
      title:{ar:'خصم 50% على العطور الشرقية',en:'50% Off Oriental Perfumes'},
      sub:{ar:'تشكيلة فاخرة لفترة محدودة فقط.',en:'A luxury collection, limited time only.'},
      chips:[{ar:'لفترة محدودة',en:'Limited time'},{ar:'أصلي 100%',en:'100% authentic'}], promo:'-50%',
      brand:{ar:'دار العود',en:'Dar Aloud',ic:'ti-spray'}, pic:'ti-spray', image:'', url:'raf_offers.html',
      g:'radial-gradient(circle at 80% 35%,#5f1e4a,#0a0a0a)',
      startDate:'2026-01-01', endDate:'2026-12-31', priority:3, status:'active', enabled:true, clicks:0, impressions:0 },

    { id:'cmp_store', name:'Tech House Spotlight', type:{ar:'متجر مميّز',en:'Featured Store'},
      title:{ar:'تك هاوس — وجهتك للإلكترونيات',en:'Tech House — Your Electronics Hub'},
      sub:{ar:'أحدث الأجهزة بأفضل الأسعار وتوصيل مجاني.',en:'Latest devices, best prices, free delivery.'},
      chips:[{ar:'توصيل مجاني',en:'Free delivery'},{ar:'+320 منتج',en:'320+ products'}], promo:'',
      brand:{ar:'تك هاوس',en:'Tech House',ic:'ti-building-store'}, pic:'ti-device-mobile', image:'', url:'raf_store.html',
      g:'radial-gradient(circle at 80% 35%,#1e3a5f,#0a0a0a)',
      startDate:'2026-01-01', endDate:'2026-12-31', priority:4, status:'active', enabled:true, clicks:0, impressions:0 },

    { id:'cmp_auction', name:'Watch Auction Promo', type:{ar:'مزاد مميّز',en:'Auction Promotion'},
      title:{ar:'ساعات فاخرة في المزاد الآن',en:'Luxury Watches Live Now'},
      sub:{ar:'زايد على قطع نادرة قبل انتهاء الوقت.',en:'Bid on rare pieces before time runs out.'},
      chips:[{ar:'مباشر',en:'Live'},{ar:'+40 مزايد',en:'40+ bidders'}], promo:'',
      brand:{ar:'تايم بوكس',en:'Time Box',ic:'ti-clock-hour-4'}, pic:'ti-clock-hour-4', image:'', url:'raf_auctions.html',
      g:'radial-gradient(circle at 80% 35%,#5f4a1e,#0a0a0a)',
      /* DEMO: paused → this slot collapses with no empty space */
      startDate:'2026-01-01', endDate:'2026-12-31', priority:5, status:'paused', enabled:true, clicks:0, impressions:0 }
  ];

  /* ---- SLOTS (placement → campaign + per-slot controls) ------------------- */
  var SLOTS = [
    { id:'after-offers',     position:'offers',     campaignId:'cmp_seasonal', show:true,  override:null, size:'tall'     },
    { id:'after-stores',     position:'stores',     campaignId:'cmp_product',  show:false, override:null, size:'standard' }, /* off by default */
    { id:'after-trending',   position:'trending',   campaignId:'cmp_offer',    show:false, override:null, size:'standard' }, /* off by default */
    { id:'after-auctions',   position:'auctions',   campaignId:'cmp_store',    show:true,  override:null, size:'standard' },
    { id:'after-categories', position:'categories', campaignId:'cmp_auction',  show:true,  override:null, size:'standard' }, /* paused campaign → collapses */
    /* listing-page placements (replace the removed legacy filter block) */
    { id:'filter-stores',    position:'stores-top',   campaignId:'cmp_seasonal', show:true, override:null, size:'standard' },
    { id:'filter-offers',    position:'offers-top',   campaignId:'cmp_store',    show:true, override:null, size:'standard' },
    { id:'filter-auctions',  position:'auctions-top', campaignId:'cmp_offer',    show:true, override:null, size:'standard' },
    { id:'filter-trending',  position:'trending-top', campaignId:'cmp_product',  show:true, override:null, size:'standard' },
    { id:'filter-used',      position:'used-top',     campaignId:'cmp_store',    show:true, override:null, size:'standard' }
  ];

  /* ---- CSS (injected once so the component is self-contained) ------------- */
  function injectCSS() {
    if (document.getElementById('raf-ads-css')) return;
    var css =
    '.ad-slot{display:block;}' +
    '.ad-banner{position:relative;display:flex;align-items:stretch;height:196px;border-radius:18px;overflow:hidden;color:#fff;cursor:pointer;box-shadow:0 8px 30px rgba(20,16,8,.08);margin:18px 0;text-decoration:none;}' +
    '.ad-banner.ad-tall{height:250px;}' +
    '.ad-banner .adb-glow{position:absolute;inset:0;z-index:0;}' +
    '.ad-banner .adb-ov{position:absolute;inset:0;z-index:1;background:linear-gradient(270deg,rgba(10,10,10,.85) 0%,rgba(10,10,10,.45) 50%,rgba(10,10,10,.06) 100%);}' +
    'html[dir="ltr"] .ad-banner .adb-ov{background:linear-gradient(90deg,rgba(10,10,10,.85) 0%,rgba(10,10,10,.45) 50%,rgba(10,10,10,.06) 100%);}' +
    '.adb-content{position:relative;z-index:2;flex:1;max-width:60%;padding:0 40px;display:flex;flex-direction:column;justify-content:center;}' +
    '.adb-type{display:inline-flex;align-items:center;gap:6px;background:#C9A84C;color:#0A0A0A;font-size:11px;font-weight:700;padding:5px 12px;border-radius:20px;margin-bottom:12px;letter-spacing:.5px;align-self:flex-start;}' +
    '.adb-title{font-family:"Playfair Display",serif;font-size:24px;font-weight:900;line-height:1.12;margin-bottom:7px;}' +
    '.adb-sub{font-size:13.5px;opacity:.92;font-weight:300;margin-bottom:14px;max-width:420px;}' +
    '.adb-chips{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:16px;}' +
    '.adb-chip{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);font-size:12px;font-weight:600;padding:5px 11px;border-radius:20px;}' +
    '.adb-chip i{color:#C9A84C;font-size:13px;}' +
    '.adb-cta{display:inline-flex;align-items:center;gap:7px;background:#fff;color:#15130F;height:42px;padding:0 22px;border-radius:30px;font-size:13.5px;font-weight:700;transition:all .2s;align-self:flex-start;}' +
    '.adb-cta:hover{background:#C9A84C;color:#0A0A0A;}' +
    '.adb-visual{position:relative;z-index:2;flex:0 0 40%;display:flex;align-items:center;justify-content:center;}' +
    '.adb-product{width:148px;height:148px;border-radius:22px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.13);display:flex;align-items:center;justify-content:center;font-size:70px;color:rgba(201,168,76,.95);box-shadow:0 16px 40px rgba(0,0,0,.4);}' +
    '.adb-promo{position:absolute;top:18px;left:18px;z-index:3;background:#D9534F;color:#fff;font-family:"DM Sans",sans-serif;font-weight:800;font-size:15px;width:54px;height:54px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px rgba(217,83,79,.5);transform:rotate(-8deg);}' +
    '.adb-brand{position:absolute;bottom:16px;left:18px;z-index:3;display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);padding:6px 13px 6px 7px;border-radius:30px;}' +
    '.adb-brand .bl{width:30px;height:30px;border-radius:50%;background:#C9A84C;color:#0A0A0A;display:flex;align-items:center;justify-content:center;font-size:16px;}' +
    '.adb-brand b{font-size:12.5px;font-weight:700;}' +
    '@media(max-width:1024px){.ad-banner{height:185px;}.ad-banner.ad-tall{height:218px;}.adb-product{width:120px;height:120px;font-size:58px;}.adb-content{padding:0 30px;}}' +
    '@media(max-width:860px){.ad-banner,.ad-banner.ad-tall{height:170px;}.adb-visual{display:none;}.adb-content{max-width:100%;padding:0 24px;}.ad-banner .adb-ov,html[dir="ltr"] .ad-banner .adb-ov{background:linear-gradient(0deg,rgba(10,10,10,.82) 0%,rgba(10,10,10,.34) 100%);}.adb-promo{top:14px;left:14px;width:46px;height:46px;font-size:13px;}.adb-brand{bottom:14px;left:14px;}}' +
    '@media(max-width:560px){.ad-banner,.ad-banner.ad-tall{height:156px;}.adb-title{font-size:19px;}.adb-sub{font-size:12.5px;margin-bottom:10px;}.adb-chips{margin-bottom:12px;}.adb-content{padding:0 18px;}}';
    var s = document.createElement('style');
    s.id = 'raf-ads-css';
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ---- logic ------------------------------------------------------------- */
  function campaign(id) { for (var i=0;i<CAMPAIGNS.length;i++) if (CAMPAIGNS[i].id===id) return CAMPAIGNS[i]; return null; }
  function slotById(id) { for (var i=0;i<SLOTS.length;i++) if (SLOTS[i].id===id) return SLOTS[i]; return null; }
  function inWindow(c) {
    var n = new Date();
    if (c.startDate && n < new Date(c.startDate)) return false;
    if (c.endDate && n > new Date(c.endDate + 'T23:59:59')) return false;
    return true;
  }
  function isVisible(slot) {
    if (!slot) return false;
    if (slot.override === 'hide') return false;
    var c = campaign(slot.campaignId);
    if (!c) return false;
    if (slot.override === 'show') return true;
    if (!slot.show) return false;
    if (!c.enabled || c.status !== 'active') return false;
    if (!inWindow(c)) return false;
    return true;
  }
  function L(o, lang) { return (lang === 'en') ? o.en : o.ar; }

  function bannerHTML(c, lang, size) {
    var en = lang === 'en';
    var chips = (c.chips || []).map(function (ch) {
      return '<span class="adb-chip"><i class="ti ti-check"></i> ' + L(ch, lang) + '</span>';
    }).join('');
    var visual = c.image
      ? '<div class="adb-visual"><div class="adb-product" style="background-image:url(\'' + c.image + '\');background-size:cover;border:none;"></div></div>'
      : '<div class="adb-visual"><div class="adb-product"><i class="ti ' + c.pic + '"></i></div></div>';
    return '<a class="ad-banner ad-' + (size || 'standard') + '" href="' + c.url + '" onclick="RAFAds.click(\'' + c.id + '\')">' +
      '<div class="adb-glow" style="background:' + c.g + '"></div><div class="adb-ov"></div>' +
      '<div class="adb-content">' +
        '<span class="adb-type"><i class="ti ' + c.brand.ic + '" style="font-size:12px"></i> ' + L(c.type, lang) + '</span>' +
        '<div class="adb-title">' + L(c.title, lang) + '</div>' +
        '<div class="adb-sub">' + L(c.sub, lang) + '</div>' +
        '<div class="adb-chips">' + chips + '</div>' +
        '<span class="adb-cta">' + (en ? 'Shop Now' : 'تسوّق الآن') + ' <i class="ti ti-arrow-left"></i></span>' +
      '</div>' + visual +
      (c.promo ? '<span class="adb-promo">' + c.promo + '</span>' : '') +
      '<div class="adb-brand"><span class="bl"><i class="ti ' + c.brand.ic + '"></i></span><b>' + L(c.brand, lang) + '</b></div>' +
    '</a>';
  }

  function mountAll(lang) {
    injectCSS();
    lang = lang || (document.getElementById('htmlRoot') && document.getElementById('htmlRoot').lang === 'en' ? 'en' : 'ar');
    SLOTS.forEach(function (slot) {
      var el = document.querySelector('[data-ad-slot="' + slot.id + '"]');
      if (!el) return;
      if (isVisible(slot)) {
        var c = campaign(slot.campaignId);
        c.impressions = (c.impressions || 0) + 1;        /* impression tracking */
        el.innerHTML = bannerHTML(c, lang, slot.size);
        el.style.display = '';
      } else {
        el.innerHTML = '';
        el.style.display = 'none';                        /* collapse → no gap */
      }
    });
  }

  /* ---- admin-style controls (ready for future panel) --------------------- */
  function click(id) { var c = campaign(id); if (c) c.clicks = (c.clicks || 0) + 1; }
  function setSlot(id, patch) { var s = slotById(id); if (s) { for (var k in patch) s[k] = patch[k]; } mountAll(); }
  function setOverride(id, val) { setSlot(id, { override: val }); }            /* 'show' | 'hide' | null */
  function showSlot(id, on) { setSlot(id, { show: !!on }); }
  function setStatus(id, status) { var s = slotById(id); if (s) { var c = campaign(s.campaignId); if (c) c.status = status; } mountAll(); }
  function disableAll() { SLOTS.forEach(function (s) { s.override = 'hide'; }); mountAll(); }
  function enableAll() { SLOTS.forEach(function (s) { s.override = null; }); mountAll(); }

  global.RAFAds = {
    CAMPAIGNS: CAMPAIGNS, SLOTS: SLOTS,
    isVisible: isVisible, bannerHTML: bannerHTML, mountAll: mountAll,
    click: click, setSlot: setSlot, setOverride: setOverride, showSlot: showSlot,
    setStatus: setStatus, disableAll: disableAll, enableAll: enableAll
  };

  /* auto-mount on load + re-mount on language change (page-agnostic, so any
     page that has [data-ad-slot] mounts get rendered with no extra wiring). */
  function boot(){ mountAll(); }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  try{
    var root = document.getElementById('htmlRoot') || document.documentElement;
    new MutationObserver(function(){ mountAll(); }).observe(root, {attributes:true, attributeFilter:['lang','dir']});
  }catch(e){}
})(window);
