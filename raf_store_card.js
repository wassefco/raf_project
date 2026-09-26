/* ============================================================================
 * RAF Marketplace — Store card (shared)
 * ----------------------------------------------------------------------------
 * One store card for every customer listing (Homepage featured stores, the
 * Stores page). Everything on it is the store's own data:
 *   • identity, cover, logo, category, rating — the store record (RAFSource)
 *   • product count — the store's public products (RAFSource publicOnly),
 *     the same rule its Store page lists by
 *   • follow — the shared follow list (RAFShop.Follow), same record shape the
 *     Store page writes
 * No follower figure is shown: RAF has no follower count.
 * Styles: raf_cx.css (.cx-store*).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFStoreCard) return;

  function en(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, e){ return en() ? e : ar; }
  function L(o){ return (o && typeof o === 'object') ? (en() ? o.en : o.ar) : (o || ''); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }

  /* store record → card model */
  function model(s){
    var n = global.RAFCatalog ? RAFCatalog.list({ store:s.slug, visibleOnly:false, publicOnly:true }).length : 0;
    return { slug:s.slug, ic:s.ic, ar:s.name.ar, en:s.name.en, rate:s.rating, prod:String(n), prodN:n,
             cat:s.cat, desc:s.desc, sponsored:!!s.sponsored, open:s.status === 'open' };
  }
  function following(slug){ return !!(global.RAFShop && RAFShop.Follow && RAFShop.Follow.has(slug)); }

  function html(m, opts){
    opts = opts || {};
    var src = (global.RAFSource && RAFSource.store(m.slug)) || {}, on = following(m.slug);
    var href = 'raf_store.html?store=' + encodeURIComponent(m.slug);
    var cover = src.cover ? ' style="background-image:url(\'' + src.cover + '\')"' : '';
    var logo = src.logo ? '<img src="' + src.logo + '" alt="">' : '<i class="ti ' + (m.ic || 'ti-building-store') + '"></i>';
    var tag = opts.promo ? '<span class="cx-store-promo"><i class="ti ti-discount"></i> -' + opts.promo + '%</span>'
            : (opts.showStatus && m.open === false) ? '<span class="cx-store-tag closed">' + T('مغلق حالياً', 'Closed now') + '</span>'
            : (opts.showPremium && m.sponsored) ? '<span class="cx-store-tag">' + T('بريميوم', 'Premium') + '</span>' : '';
    return '<article class="cx-store" data-slug="' + esc(m.slug) + '" onclick="window.location=\'' + href + '\'">' +
      '<div class="cx-store-cover"' + cover + '>' + tag + '</div>' +
      '<div class="cx-store-logo">' + logo + '</div>' +
      '<div class="cx-store-b">' +
        '<a class="cx-store-name" href="' + href + '" onclick="event.stopPropagation()">' + esc(L(m)) + '</a>' +
        '<div class="cx-store-cat">' + esc(L(m.cat)) + '</div>' +
        '<div class="cx-store-meta">' + (m.rate ? '<span><i class="ti ti-star-filled"></i> <b>' + esc(m.rate) + '</b></span><span class="dot"></span>' : '') +
          '<span><b>' + m.prodN + '</b> ' + T('منتج', m.prodN === 1 ? 'product' : 'products') + '</span></div>' +
        '<div class="cx-store-act">' +
          '<button type="button" class="cx-follow' + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" onclick="RAFStoreCard.follow(event,\'' + esc(m.slug) + '\')">' +
            '<i class="ti ' + (on ? 'ti-check' : 'ti-plus') + '"></i> <span>' + (on ? T('تتابعه', 'Following') : T('متابعة', 'Follow')) + '</span></button>' +
          '<a class="cx-visit" href="' + href + '" onclick="event.stopPropagation()" aria-label="' + T('زيارة المتجر', 'Visit store') + '"><i class="ti ti-arrow-left"></i></a>' +
        '</div>' +
      '</div></article>';
  }

  /* the same record the Store page writes, so Favorites shows one shape */
  function follow(e, slug){
    if (e){ e.preventDefault(); e.stopPropagation(); }
    if (!global.RAFShop || !RAFShop.Follow) return;
    var s = global.RAFSource && RAFSource.store(slug); if (!s) return;
    var m = model(s);
    var on = RAFShop.Follow.toggle({ slug:m.slug, name:L(m), cat:m.cat, ic:m.ic, products:m.prodN, rating:m.rate });
    document.querySelectorAll('.cx-store[data-slug="' + slug + '"] .cx-follow').forEach(function(b){
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.querySelector('i').className = 'ti ' + (on ? 'ti-check' : 'ti-plus');
      b.querySelector('span').textContent = on ? T('تتابعه', 'Following') : T('متابعة', 'Follow');
    });
    if (RAFShop.toast) RAFShop.toast(on ? T('تتابع ' + L(m) + ' الآن', 'Now following ' + L(m)) : T('تم إلغاء المتابعة', 'Unfollowed'), { icon: on ? 'ti-heart-filled' : 'ti-heart-off' });
  }

  global.RAFStoreCard = { model: model, html: html, follow: follow, following: following };
})(window);
