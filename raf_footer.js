/* ============================================================================
 * RAF Marketplace — SHARED SITE FOOTER
 * ----------------------------------------------------------------------------
 * The marketing/listing pages each carried their own copy of the same footer,
 * and those copies had drifted (some were missing FAQ, Help Center, How to Sell
 * or Contact Sales). This renders one canonical footer for all of them.
 *
 * Opt in with:  <footer data-raf-footer></footer>
 * Pages with a deliberately minimal footer (cart, checkout, tracking, product,
 * store) simply don't carry the attribute and are left untouched.
 *
 * Bilingual, RTL/LTR safe, and respects the auctions/used feature flags.
 * Styling comes from each page's existing .footer-* classes, harmonised by
 * raf_theme.css — so this changes structure, not the visual language.
 * ==========================================================================*/
(function (global) {
  if (global.RAFFooter) return;

  function root(){ return document.getElementById('htmlRoot') || document.documentElement; }
  function en(){ return root().lang === 'en'; }
  function t(ar, e){ return en() ? e : ar; }

  /* one canonical link map — the union of what the pages used to show */
  var COLS = [
    { title:{ar:'روابط سريعة',en:'Quick Links'}, links:[
      { href:'raf_homepage.html',   ar:'الرئيسية',   en:'Home' },
      { href:'raf_storespage.html', ar:'المحلات',    en:'Stores' },
      { href:'raf_offers.html',     ar:'العروض',     en:'Offers' },
      { href:'raf_trending.html',   ar:'الترندات',   en:'Trends' },
      { href:'raf_used.html',       ar:'المستعملات', en:'Used', feature:'used' },
      { href:'raf_auctions.html',   ar:'المزادات',   en:'Auctions', feature:'auctions' }
    ]},
    { title:{ar:'المساعدة',en:'Help'}, links:[
      { href:'raf_about.html',        ar:'من نحن',           en:'About Us' },
      { href:'raf_how_to_order.html', ar:'كيف تطلب',         en:'How to Order' },
      { href:'raf_returns.html',      ar:'سياسة الإرجاع',    en:'Returns Policy' },
      { href:'raf_faq.html',          ar:'الأسئلة الشائعة',  en:'FAQ' },
      { href:'raf_help.html',         ar:'مركز المساعدة',    en:'Help Center' },
      { href:'raf_contact.html',      ar:'تواصل معنا',       en:'Contact Us' }
    ]},
    { title:{ar:'الأعمال',en:'Business'}, links:[
      { href:'raf_seller.html',        ar:'افتح متجرك',              en:'Open Your Store' },
      { href:'raf_plans.html',         ar:'الباقات والأسعار',        en:'Plans & Pricing' },
      { href:'raf_how_to_sell.html',   ar:'كيف تبيع',                en:'How to Sell' },
      { href:'raf_contact_sales.html', ar:'تحدث مع فريق المبيعات',   en:'Contact Sales' },
      { href:'raf_join_driver.html',   ar:'انضم كسائق',              en:'Become a Driver' }
    ]}
  ];
  var BOTTOM = [
    { href:'raf_privacy.html', ar:'سياسة الخصوصية', en:'Privacy Policy' },
    { href:'raf_terms.html',   ar:'الشروط والأحكام', en:'Terms' }
  ];
  var TAGLINE = { ar:'منصة التسوق المحلي الأولى في الكويت — أفضل العروض من أفضل المحلات.',
                  en:'Kuwait’s first local shopping platform — the best deals from the best stores.' };

  function link(l){
    return '<a href="' + l.href + '" class="footer-link"'
      + (l.feature ? ' data-feature="' + l.feature + '"' : '')
      + ' data-ar="' + l.ar + '" data-en="' + l.en + '">' + t(l.ar, l.en) + '</a>';
  }

  function build(){
    var hosts = document.querySelectorAll('footer[data-raf-footer]');
    if (!hosts.length) return;
    var markup =
      '<div class="footer-grid">'
        + '<div>'
          + '<a href="raf_homepage.html" class="footer-logo">'
          + '<img src="assets/branding/logo-light.svg" alt="RAF Marketplace" class="brand-logo-foot"></a>'
          + '<div class="footer-desc" data-ar="' + TAGLINE.ar + '" data-en="' + TAGLINE.en + '">'
          + t(TAGLINE.ar, TAGLINE.en) + '</div>'
        + '</div>'
        + COLS.map(function (c) {
            return '<div><div class="footer-col-title" data-ar="' + c.title.ar + '" data-en="' + c.title.en + '">'
              + t(c.title.ar, c.title.en) + '</div>'
              + c.links.map(link).join('') + '</div>';
          }).join('')
      + '</div>'
      + '<div class="footer-bottom">'
        + '<div data-ar="جميع الحقوق محفوظة © 2026 رف" data-en="All rights reserved © 2026 RAF">'
        + t('جميع الحقوق محفوظة © 2026 رف', 'All rights reserved © 2026 RAF') + '</div>'
        + '<div style="display:flex;gap:16px;flex-wrap:wrap;">'
        + BOTTOM.map(function (l) {
            return '<a href="' + l.href + '" class="footer-link" style="margin:0;" data-ar="' + l.ar
              + '" data-en="' + l.en + '">' + t(l.ar, l.en) + '</a>';
          }).join('')
        + '</div>'
      + '</div>';

    hosts.forEach(function (f) { f.innerHTML = markup; });
    /* re-apply feature flags to the freshly injected links */
    if (global.RAFFeatures && RAFFeatures.apply) RAFFeatures.apply();
    else document.querySelectorAll('footer [data-feature]').forEach(function (el) {
      var k = el.getAttribute('data-feature'), on = false;
      try { on = (JSON.parse(localStorage.getItem('raf_features') || '{}'))[k] === true; } catch (e) {}
      if (!on) el.style.display = 'none';
    });
  }

  global.RAFFooter = { build: build, COLS: COLS };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
  /* keep the footer in the active language */
  var r = document.getElementById('htmlRoot');
  if (r) new MutationObserver(build).observe(r, { attributes:true, attributeFilter:['lang'] });
})(window);
