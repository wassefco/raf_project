/* ============================================================================
 * RAF Marketplace — Shared Mobile Navigation (Hamburger + Drawer)
 * ----------------------------------------------------------------------------
 * Problem this solves:
 *   On marketplace pages the desktop top‑nav links (.nav-links) are hidden at
 *   ≤900px and the Login / Create‑Account buttons are hidden at ≤768px, with NO
 *   replacement — so those primary actions become unreachable on mobile.
 *
 * This component injects, on every page it is included in:
 *   • a hamburger button (visible ≤900px) inside the existing header <nav>
 *   • a slide‑in drawer + overlay containing ALL primary navigation:
 *       Stores, Offers, Trending, Used, Auctions, Account, Wishlist, Cart,
 *       Login, Create Account  + a language toggle.
 *
 * Nothing is removed — the desktop nav is untouched; this only ADDS a mobile
 * affordance. Fully RTL/EN aware and self‑contained (no build step).
 * ==========================================================================*/
(function () {
  'use strict';
  if (window.__rafNavInit) return;
  window.__rafNavInit = true;

  /* ---- primary navigation model (single source of truth) ---------------- */
  var SECTIONS = [
    { labelAr: 'روابط سريعة', labelEn: 'Quick Links', items: [
      { href: 'raf_homepage.html',   icon: 'ti-home-2',         ar: 'الرئيسية', en: 'Home' },
      { href: 'raf_storespage.html', icon: 'ti-building-store', ar: 'المحلات',  en: 'Stores' },
      { href: 'raf_offers.html',     icon: 'ti-discount',       ar: 'العروض',   en: 'Offers' },
      { href: 'raf_trending.html',   icon: 'ti-flame',          ar: 'الترندات', en: 'Trends' },
      { href: 'raf_used.html',       icon: 'ti-recycle',        ar: 'المستعمل', en: 'Used Items' },
      { href: 'raf_auctions.html',   icon: 'ti-gavel',          ar: 'المزادات', en: 'Auctions' }
    ]},
    { labelAr: 'حسابي', labelEn: 'My Account', items: [
      { href: 'raf_account.html',  icon: 'ti-user-circle',   ar: 'حسابي',   en: 'Account' },
      { href: 'raf_wishlist.html', icon: 'ti-heart',         ar: 'المفضلة', en: 'Wishlist' },
      { href: 'raf_cart.html',     icon: 'ti-shopping-cart', ar: 'السلة',   en: 'Cart' }
    ]},
    { labelAr: 'المساعدة', labelEn: 'Help', items: [
      { href: 'raf_how_to_order.html', icon: 'ti-list-check',     ar: 'كيف أطلب',        en: 'How to Order' },
      { href: 'raf_tracking.html',     icon: 'ti-truck-delivery', ar: 'تتبع طلبك',       en: 'Track Your Order' },
      { href: 'raf_contact.html',      icon: 'ti-mail',           ar: 'تواصل معنا',      en: 'Contact Us' },
      { href: 'raf_faq.html',          icon: 'ti-help-circle',    ar: 'الأسئلة الشائعة', en: 'FAQ' },
      { href: 'raf_help.html',         icon: 'ti-lifebuoy',       ar: 'مركز المساعدة',   en: 'Help Center' }
    ]},
    { labelAr: 'السياسات', labelEn: 'Legal', items: [
      { href: 'raf_privacy.html', icon: 'ti-shield-lock',   ar: 'سياسة الخصوصية',  en: 'Privacy Policy' },
      { href: 'raf_terms.html',   icon: 'ti-file-text',     ar: 'الشروط والأحكام', en: 'Terms & Conditions' },
      { href: 'raf_returns.html', icon: 'ti-arrow-back-up', ar: 'سياسة الإرجاع',   en: 'Returns Policy' }
    ]},
    { labelAr: 'التجار والسائقون', labelEn: 'Merchants & Drivers', items: [
      { href: 'raf_seller.html',      icon: 'ti-building-store',    ar: 'افتح متجرك',     en: 'Open Your Store' },
      { href: 'raf_plans.html',       icon: 'ti-tag',              ar: 'الباقات والأسعار', en: 'Pricing & Plans' },
      { href: 'raf_merchant.html',    icon: 'ti-layout-dashboard', ar: 'لوحة التاجر',     en: 'Merchant Dashboard' },
      { href: 'raf_join_driver.html', icon: 'ti-motorbike',        ar: 'انضم كسائق',      en: 'Join as Driver' }
    ]}
  ];

  function lang() {
    var r = document.getElementById('htmlRoot') || document.documentElement;
    if (r && r.lang) return r.lang === 'en' ? 'en' : 'ar';
    return (localStorage.getItem('raf_lang') === 'en') ? 'en' : 'ar';
  }
  function isEn() { return lang() === 'en'; }

  /* ---- styles ----------------------------------------------------------- */
  var css = ''
    + '.raf-burger{display:none;width:40px;height:40px;align-items:center;justify-content:center;'
    + 'border:1px solid #D8D3C8;border-radius:8px;background:transparent;color:#555;cursor:pointer;'
    + 'font-size:20px;flex-shrink:0;transition:all .2s;}'
    + '.raf-burger:hover{border-color:#C9A84C;color:#C9A84C;}'
    + '@media(max-width:1024px){.raf-burger{display:inline-flex;}}'
    + '.raf-drawer-overlay{position:fixed;inset:0;background:rgba(10,10,10,.45);opacity:0;visibility:hidden;'
    + 'transition:opacity .25s;z-index:1400;}'
    + '.raf-drawer-overlay.open{opacity:1;visibility:visible;}'
    + 'body{overflow-x:hidden;}' /* clip the off‑canvas drawer so it never adds a scrollbar */
    + '.raf-drawer{position:fixed;top:0;bottom:0;width:290px;max-width:84vw;background:#FFFFFF;'
    + 'z-index:1401;display:flex;flex-direction:column;box-shadow:0 0 40px rgba(0,0,0,.25);'
    + 'transition:transform .28s ease;font-family:"Tajawal",sans-serif;will-change:transform;}'
    /* open/closed transform is driven by JS inline styles for deterministic behavior */
    + '.raf-drawer-head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;'
    + 'border-bottom:1px solid #EDE8DC;}'
    + '.raf-drawer-logo{font-family:"Playfair Display",serif;font-size:26px;font-weight:900;color:#C9A84C;'
    + 'text-decoration:none;line-height:1;}'
    + '.raf-drawer-logo span{display:block;font-family:"DM Sans",sans-serif;font-size:10px;font-weight:400;'
    + 'letter-spacing:3px;color:#888;margin-top:2px;}'
    + '.raf-drawer-close{width:36px;height:36px;border:1px solid #D8D3C8;border-radius:8px;background:transparent;'
    + 'color:#555;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;}'
    + '.raf-drawer-close:hover{border-color:#ef5350;color:#ef5350;}'
    + '.raf-drawer-body{flex:1;overflow-y:auto;padding:10px 0;}'
    + '.raf-drawer-section{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#A89E88;'
    + 'padding:14px 20px 6px;font-family:"DM Sans",sans-serif;}'
    + '.raf-drawer-link{display:flex;align-items:center;gap:12px;padding:11px 20px;color:#0A0A0A;'
    + 'text-decoration:none;font-size:15px;transition:background .15s,color .15s;border-right:3px solid transparent;}'
    + 'html[dir="ltr"] .raf-drawer-link{border-right:none;border-left:3px solid transparent;}'
    + '.raf-drawer-link i{font-size:20px;color:#A07828;width:22px;text-align:center;flex-shrink:0;}'
    + '.raf-drawer-link:hover{background:#F7F4EE;color:#A07828;}'
    + '.raf-drawer-link.active{background:rgba(201,168,76,.10);color:#A07828;border-color:#C9A84C;font-weight:700;}'
    + '.raf-drawer-link.active i{color:#C9A84C;}'
    + '.raf-drawer-auth{padding:16px 20px;border-top:1px solid #EDE8DC;display:flex;flex-direction:column;gap:10px;}'
    + '.raf-d-btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border-radius:8px;'
    + 'font-family:"Tajawal",sans-serif;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer;transition:all .2s;}'
    + '.raf-d-login{border:1px solid #D8D3C8;background:transparent;color:#0A0A0A;}'
    + '.raf-d-login:hover{border-color:#C9A84C;color:#A07828;}'
    + '.raf-d-signup{border:none;background:#C9A84C;color:#0A0A0A;}'
    + '.raf-d-signup:hover{background:#A07828;color:#fff;}'
    + '.raf-drawer-lang{margin:0 20px 18px;padding:10px;border:1px solid #D8D3C8;border-radius:8px;background:transparent;'
    + 'color:#555;font-family:"DM Sans",sans-serif;font-size:12px;font-weight:600;letter-spacing:1px;cursor:pointer;'
    + 'display:flex;align-items:center;justify-content:center;gap:8px;transition:all .2s;}'
    + '.raf-drawer-lang:hover{border-color:#C9A84C;color:#A07828;}';
  var st = document.createElement('style');
  st.id = 'raf-nav-styles';
  st.textContent = css;
  document.head.appendChild(st);

  /* ---- build drawer ----------------------------------------------------- */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  var here = (location.pathname.split('/').pop() || 'raf_homepage.html');

  var overlay = el('div', 'raf-drawer-overlay');
  overlay.id = 'rafDrawerOverlay';

  var drawer = el('aside', 'raf-drawer');
  drawer.id = 'rafDrawer';
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('role', 'dialog');

  var head = el('div', 'raf-drawer-head');
  head.innerHTML = '<a href="raf_homepage.html" class="raf-drawer-logo"><img src="assets/branding/logo.svg" alt="RAF Marketplace" style="height:46px;width:auto;display:block;"></a>'
    + '<button class="raf-drawer-close" id="rafDrawerClose" aria-label="Close menu"><i class="ti ti-x"></i></button>';
  drawer.appendChild(head);

  var body = el('div', 'raf-drawer-body');
  SECTIONS.forEach(function (sec) {
    var s = el('div', 'raf-drawer-section');
    s.setAttribute('data-ar', sec.labelAr);
    s.setAttribute('data-en', sec.labelEn);
    s.textContent = isEn() ? sec.labelEn : sec.labelAr;
    body.appendChild(s);
    sec.items.forEach(function (it) {
      var a = el('a', 'raf-drawer-link' + (it.href === here ? ' active' : ''));
      a.href = it.href;
      a.innerHTML = '<i class="ti ' + it.icon + '"></i><span data-ar="' + it.ar + '" data-en="' + it.en + '">'
        + (isEn() ? it.en : it.ar) + '</span>';
      body.appendChild(a);
    });
  });
  drawer.appendChild(body);

  var auth = el('div', 'raf-drawer-auth');
  auth.innerHTML =
      '<a class="raf-d-btn raf-d-login" href="raf_login.html"><i class="ti ti-login-2"></i>'
    + '<span data-ar="تسجيل الدخول" data-en="Login">' + (isEn() ? 'Login' : 'تسجيل الدخول') + '</span></a>'
    + '<a class="raf-d-btn raf-d-signup" href="raf_login.html"><i class="ti ti-user-plus"></i>'
    + '<span data-ar="إنشاء حساب" data-en="Create Account">' + (isEn() ? 'Create Account' : 'إنشاء حساب') + '</span></a>';
  drawer.appendChild(auth);

  var langBtn = el('button', 'raf-drawer-lang');
  langBtn.id = 'rafDrawerLang';
  langBtn.innerHTML = '<i class="ti ti-language"></i><span>' + (isEn() ? 'العربية' : 'English') + '</span>';
  drawer.appendChild(langBtn);

  document.body.appendChild(overlay);
  document.body.appendChild(drawer);

  /* ---- hamburger button into the header nav ----------------------------- */
  var headerNav = document.querySelector('nav:not(.app-bnav):not(.top)');
  var burger = el('button', 'raf-burger');
  burger.id = 'rafBurger';
  burger.setAttribute('aria-label', 'Open menu');
  burger.setAttribute('aria-expanded', 'false');
  burger.innerHTML = '<i class="ti ti-menu-2"></i>';
  if (headerNav) headerNav.insertBefore(burger, headerNav.firstChild);
  else { burger.style.position = 'fixed'; burger.style.top = '12px'; burger.style.insetInlineStart = '12px';
         burger.style.zIndex = '1300'; burger.style.background = '#fff'; document.body.appendChild(burger); }

  /* ---- open / close (deterministic inline transform) -------------------- */
  function isRtl() {
    var r = document.getElementById('htmlRoot') || document.documentElement;
    return (r.dir || 'rtl') !== 'ltr';
  }
  function place() {
    // anchor to the inline‑start side for the current direction
    var rtl = isRtl();
    drawer.style.right = rtl ? '0' : 'auto';
    drawer.style.left  = rtl ? 'auto' : '0';
    if (!drawer.classList.contains('open')) {
      drawer.style.transform = rtl ? 'translateX(110%)' : 'translateX(-110%)';
    }
  }
  function openDrawer() {
    place();
    overlay.classList.add('open');
    drawer.classList.add('open');
    drawer.style.transform = 'translateX(0)';
    drawer.setAttribute('aria-hidden', 'false');
    burger.setAttribute('aria-expanded', 'true');
    document.body.style.overflow = 'hidden';
  }
  function closeDrawer() {
    overlay.classList.remove('open');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    burger.setAttribute('aria-expanded', 'false');
    document.body.style.overflow = '';
    place(); // reset to off‑canvas for the current direction
  }
  place(); // initial off‑canvas position
  burger.addEventListener('click', openDrawer);
  overlay.addEventListener('click', closeDrawer);
  document.getElementById('rafDrawerClose').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  /* ---- language --------------------------------------------------------- */
  function applyDrawerLang() {
    var en = isEn();
    drawer.querySelectorAll('[data-ar]').forEach(function (n) { n.textContent = en ? n.dataset.en : n.dataset.ar; });
    langBtn.querySelector('span').textContent = en ? 'العربية' : 'English';
    place(); // direction may have changed → re‑anchor drawer side
  }
  langBtn.addEventListener('click', function () {
    if (typeof window.toggleLang === 'function') { window.toggleLang(); }
    else {
      var r = document.getElementById('htmlRoot') || document.documentElement;
      var en = r.lang === 'en';
      r.lang = en ? 'ar' : 'en'; r.dir = en ? 'rtl' : 'ltr';
      localStorage.setItem('raf_lang', en ? 'ar' : 'en');
    }
    applyDrawerLang();
  });
  // keep drawer text in sync if the page's own lang toggle is used while open
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[onclick*="toggleLang"]') && !e.target.closest('#rafDrawerLang')) {
      setTimeout(applyDrawerLang, 0);
    }
  });
})();
