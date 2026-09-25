/* ============================================================================
 * RAF Marketplace — Search Filters (one state, one rule)
 * ----------------------------------------------------------------------------
 * The search filter sheet and the search results page (raf_offers.html) share
 * this single definition, so what the sheet offers is exactly what the
 * results apply:
 *
 *   state (in the URL) ─ q · cat · store · pmin · pmax · rating · stock · sale
 *
 *   • cat    — RAF category key (RAFCatalog.categories)
 *   • store  — store slug (RAFCatalog.stores)
 *   • price  — the price the shopper sees on the card (live promotion first,
 *              RAFMarketing.displayPrice), in KWD
 *   • rating — the product's own rating (p.rate) ≥ the chosen threshold
 *   • stock  — availability through the shared Sold Out rule (RAFCard.isOOS)
 *   • sale   — a discount is shown on the card (promotion or catalogue)
 *
 * Nothing here is filtered on data RAF does not have (no brand, no delivery
 * speed, no arrival date), so no such control exists.
 * The products searched are RAF's listable products (RAFSource.isVisible).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFSearchFilters) return;

  var RATINGS = ['4.5', '4', '3.5'];

  function en(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, e){ return en() ? e : ar; }
  function L(o){ return (o && typeof o === 'object') ? (en() ? o.en : o.ar) : (o || ''); }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function cats(){ return global.RAFCatalog ? RAFCatalog.categories() : []; }
  function stores(){ return global.RAFCatalog ? RAFCatalog.stores() : []; }
  function num(v){ if (v == null || v === '') return null; var n = parseFloat(v); return isFinite(n) && n >= 0 ? n : null; }

  function empty(){ return { q:'', cat:'', store:'', pmin:null, pmax:null, rating:'', inStock:false, onSale:false }; }

  /* URL → state. Unknown or invalid values are dropped, never guessed. */
  function parse(search){
    var p = new URLSearchParams(search || ''), s = empty();
    s.q = (p.get('q') || '').trim();
    var c = (p.get('cat') || '').trim(); if (c && cats().some(function(x){ return x.k === c; })) s.cat = c;
    var st = (p.get('store') || '').trim(); if (st && stores().some(function(x){ return x.slug === st; })) s.store = st;
    s.pmin = num(p.get('pmin')); s.pmax = num(p.get('pmax'));
    if (s.pmin != null && s.pmax != null && s.pmin > s.pmax){ var t = s.pmin; s.pmin = s.pmax; s.pmax = t; }
    var r = p.get('rating'); if (RATINGS.indexOf(r) > -1) s.rating = r;
    s.inStock = p.get('stock') === '1';
    s.onSale = p.get('sale') === '1';
    return s;
  }
  /* state → URL query (only what is set) */
  function toQuery(s){
    var p = new URLSearchParams();
    if (s.q) p.set('q', s.q);
    if (s.cat) p.set('cat', s.cat);
    if (s.store) p.set('store', s.store);
    if (s.pmin != null) p.set('pmin', String(s.pmin));
    if (s.pmax != null) p.set('pmax', String(s.pmax));
    if (s.rating) p.set('rating', s.rating);
    if (s.inStock) p.set('stock', '1');
    if (s.onSale) p.set('sale', '1');
    return p.toString();
  }
  function activeCount(s){
    return (s.cat?1:0) + (s.store?1:0) + ((s.pmin != null || s.pmax != null)?1:0) + (s.rating?1:0) + (s.inStock?1:0) + (s.onSale?1:0);
  }

  /* what the shopper sees on the card */
  function shown(p){
    var d = (global.RAFMarketing && RAFMarketing.displayPrice) ? RAFMarketing.displayPrice(p) : null;
    return (d && d.promoted) ? { price: parseFloat(d.final) || 0, pct: parseInt(d.pct, 10) || 0 }
                             : { price: parseFloat(p.price) || 0, pct: parseInt(p.disc, 10) || 0 };
  }
  function isOOS(p){ return !!(global.RAFCard && RAFCard.isOOS && RAFCard.isOOS(p)); }

  /* the one predicate */
  function match(p, s){
    if (s.cat && p.cat !== s.cat) return false;
    if (s.store && p.slug !== s.store) return false;
    var v = shown(p);
    if (s.pmin != null && v.price < s.pmin) return false;
    if (s.pmax != null && v.price > s.pmax) return false;
    if (s.rating && !(parseFloat(p.rate) >= parseFloat(s.rating))) return false;
    if (s.inStock && isOOS(p)) return false;
    if (s.onSale && !(v.pct > 0)) return false;
    if (s.q){
      var hay = (p.ar + ' ' + p.en + ' ' + (p.store ? p.store.ar + ' ' + p.store.en : '') + ' ' + p.id).toLowerCase();
      if (hay.indexOf(s.q.toLowerCase()) < 0) return false;
    }
    return true;
  }
  function results(s){ return (global.RAFCatalog ? RAFCatalog.list({}) : []).filter(function(p){ return match(p, s); }); }

  /* ---------------- the sheet ---------------- */
  var cfg = null, draft = empty();
  function css(){
    if (document.getElementById('raf-sf-css')) return;
    var c =
      '.fs-backdrop{position:fixed;inset:0;z-index:3500;display:none;align-items:center;justify-content:center;padding:20px;background:rgba(20,16,8,.5);backdrop-filter:blur(3px);}' +
      '.fs-backdrop.show{display:flex;}' +
      '.fs-card{width:100%;max-width:520px;max-height:88vh;overflow:auto;background:#fff;border:1px solid #E2DBCC;border-radius:20px;box-shadow:0 30px 70px -22px rgba(20,16,8,.55);font-family:"Tajawal",sans-serif;}' +
      '.fs-head{position:sticky;top:0;background:#fff;display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid #E2DBCC;z-index:1;}' +
      '.fs-head h3{font-size:18px;font-weight:800;color:#15130F;}' +
      '.fs-x{width:36px;height:36px;min-height:36px;border-radius:50%;border:1px solid #E2DBCC;background:#F5F2EC;color:#5A5650;font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;}' +
      '.fs-x:hover{border-color:#D9534F;color:#D9534F;}' +
      '.fs-body{padding:16px 20px 4px;}' +
      '.fs-group{margin-bottom:18px;}' +
      '.fs-label{font-size:13.5px;font-weight:800;color:#15130F;margin-bottom:9px;display:flex;align-items:center;gap:6px;}' +
      '.fs-label i{color:#A07828;font-size:15px;}' +
      '.fs-chips{display:flex;flex-wrap:wrap;gap:8px;}' +
      '.fs-chip{min-height:38px;padding:7px 14px;border:1px solid #D8D3C8;border-radius:30px;background:#fff;color:#5A5650;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:all .15s;}' +
      '.fs-chip:hover{border-color:#C9A84C;}' +
      '.fs-chip.on{background:#15130F;color:#F5F0E4;border-color:#15130F;}' +
      '.fs-price{display:flex;align-items:center;gap:10px;}' +
      '.fs-price label{flex:1;display:flex;flex-direction:column;gap:4px;font-size:11.5px;color:#8A857C;font-weight:700;}' +
      '.fs-price input{height:42px;border:1px solid #D8D3C8;border-radius:10px;background:#FCFBF8;padding:0 12px;font-family:"DM Sans",sans-serif;font-size:14px;color:#0A0A0A;outline:none;width:100%;}' +
      '.fs-price input:focus{border-color:#C9A84C;}' +
      '.fs-price span{color:#8A857C;font-size:13px;padding-top:18px;}' +
      '.fs-foot{position:sticky;bottom:0;background:#fff;display:flex;gap:10px;padding:14px 20px;border-top:1px solid #E2DBCC;padding-bottom:calc(14px + env(safe-area-inset-bottom,0px));}' +
      '.fs-reset{flex:0 0 auto;height:46px;padding:0 18px;border:1px solid #D8D3C8;border-radius:30px;background:#fff;color:#5A5650;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;}' +
      '.fs-reset:hover{border-color:#C9A84C;color:#A07828;}' +
      '.fs-apply{flex:1;height:46px;border:none;border-radius:30px;background:#C9A84C;color:#1C1606;font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;}' +
      '.fs-apply:hover{background:#A07828;color:#fff;}' +
      '.fs-apply:disabled{background:#E7E1D4;color:#8A857C;cursor:not-allowed;}' +
      '@media(max-width:560px){.fs-backdrop{align-items:flex-end;padding:0;}.fs-card{max-width:100%;border-radius:22px 22px 0 0;max-height:90vh;}}';
    var s = document.createElement('style'); s.id = 'raf-sf-css'; s.textContent = c; document.head.appendChild(s);
  }
  function chip(on, label, act){ return '<button type="button" class="fs-chip' + (on ? ' on' : '') + '" aria-pressed="' + (on ? 'true' : 'false') + '" onclick="' + act + '">' + label + '</button>'; }
  function body(){
    var d = draft;
    return '<div class="fs-group"><div class="fs-label"><i class="ti ti-category"></i> ' + T('الفئة', 'Category') + '</div><div class="fs-chips" data-filter="cat">' +
        cats().map(function(c){ return chip(d.cat === c.k, esc(L(c)), "RAFSearchFilters._set('cat','" + c.k + "')"); }).join('') + '</div></div>' +
      '<div class="fs-group"><div class="fs-label"><i class="ti ti-building-store"></i> ' + T('المتجر', 'Store') + '</div><div class="fs-chips" data-filter="store">' +
        stores().map(function(s){ return chip(d.store === s.slug, esc(L(s.name)), "RAFSearchFilters._set('store','" + s.slug + "')"); }).join('') + '</div></div>' +
      '<div class="fs-group"><div class="fs-label"><i class="ti ti-coin"></i> ' + T('نطاق السعر (د.ك)', 'Price range (KWD)') + '</div><div class="fs-price">' +
        '<label>' + T('من', 'From') + '<input id="fPriceMin" type="number" min="0" step="any" inputmode="decimal" value="' + (d.pmin != null ? d.pmin : '') + '" oninput="RAFSearchFilters._price()"></label><span>—</span>' +
        '<label>' + T('إلى', 'To') + '<input id="fPriceMax" type="number" min="0" step="any" inputmode="decimal" value="' + (d.pmax != null ? d.pmax : '') + '" oninput="RAFSearchFilters._price()"></label></div></div>' +
      '<div class="fs-group"><div class="fs-label"><i class="ti ti-star"></i> ' + T('التقييم', 'Rating') + '</div><div class="fs-chips" data-filter="rating">' +
        RATINGS.map(function(r){ return chip(d.rating === r, '★ ' + r + (en() ? ' & up' : ' فأعلى'), "RAFSearchFilters._set('rating','" + r + "')"); }).join('') + '</div></div>' +
      '<div class="fs-group"><div class="fs-label"><i class="ti ti-package"></i> ' + T('التوفّر والعروض', 'Availability & offers') + '</div><div class="fs-chips">' +
        chip(d.inStock, T('متوفّر الآن', 'In stock'), "RAFSearchFilters._toggle('inStock')") +
        chip(d.onSale, T('عليها خصم', 'On sale'), "RAFSearchFilters._toggle('onSale')") + '</div></div>';
  }
  function paint(){
    var b = document.getElementById('fsBody'); if (!b) return;
    b.innerHTML = body();
    applyLabel();
  }
  function applyLabel(){
    var n = results(draft).length, btn = document.getElementById('fsApply'); if (!btn) return;
    btn.disabled = !n;
    btn.textContent = n ? T('عرض ' + n + ' منتج', 'Show ' + n + ' product' + (n === 1 ? '' : 's')) : T('لا توجد نتائج', 'No results');
  }
  function mount(opts){
    cfg = opts || {};
    css();
    if (!document.getElementById('filterSheet')){
      var el = document.createElement('div');
      el.className = 'fs-backdrop'; el.id = 'filterSheet';
      el.addEventListener('click', function(e){ if (e.target === el) close(); });
      el.innerHTML = '<div class="fs-card" role="dialog" aria-modal="true" aria-labelledby="fsTitle">' +
        '<div class="fs-head"><h3 id="fsTitle"></h3><button type="button" class="fs-x" onclick="RAFSearchFilters.close()"><i class="ti ti-x"></i></button></div>' +
        '<div class="fs-body" id="fsBody"></div>' +
        '<div class="fs-foot"><button type="button" class="fs-reset" id="fsReset" onclick="RAFSearchFilters._reset()"></button><button type="button" class="fs-apply" id="fsApply" onclick="RAFSearchFilters._apply()"></button></div></div>';
      document.body.appendChild(el);
      document.addEventListener('keydown', function(e){ if (e.key === 'Escape') close(); });
    }
    /* the shared header's Filter button opens this sheet on pages that mount it */
    global.openFilters = open;
    global.closeFilters = close;
  }
  function open(e){
    if (e && e.preventDefault){ e.preventDefault(); if (e.stopPropagation) e.stopPropagation(); }
    if (global.RAFSearch && RAFSearch.close) RAFSearch.close();
    var base = cfg && cfg.state ? cfg.state() : parse(location.search);
    draft = Object.assign(empty(), base);
    /* the search text typed in the header is part of the same state */
    var inp = document.getElementById('navSearch'), inpM = document.getElementById('navSearchM');
    var typed = ((inp && inp.offsetParent ? inp.value : '') || (inpM && inpM.offsetParent ? inpM.value : '') || '').trim();
    if (typed) draft.q = typed;
    document.getElementById('fsTitle').textContent = T('تصفية البحث', 'Filter search');
    document.querySelector('#filterSheet .fs-x').setAttribute('aria-label', T('إغلاق', 'Close'));
    document.getElementById('fsReset').textContent = T('إعادة تعيين', 'Reset');
    paint();
    document.getElementById('filterSheet').classList.add('show');
    return false;
  }
  function close(){ var el = document.getElementById('filterSheet'); if (el) el.classList.remove('show'); }

  global.RAFSearchFilters = {
    RATINGS: RATINGS, parse: parse, toQuery: toQuery, match: match, results: results, shown: shown,
    activeCount: activeCount, empty: empty, mount: mount, open: open, close: close,
    _set: function(k, v){ draft[k] = draft[k] === v ? '' : v; paint(); },
    _toggle: function(k){ draft[k] = !draft[k]; paint(); },
    _price: function(){ draft.pmin = num((document.getElementById('fPriceMin') || {}).value); draft.pmax = num((document.getElementById('fPriceMax') || {}).value); applyLabel(); },
    _reset: function(){ var q = draft.q; draft = empty(); draft.q = q; paint(); },
    _apply: function(){
      var s = Object.assign({}, draft);
      if (s.pmin != null && s.pmax != null && s.pmin > s.pmax){ var t = s.pmin; s.pmin = s.pmax; s.pmax = t; }
      close();
      if (cfg && typeof cfg.onApply === 'function') cfg.onApply(s);
      else global.location = 'raf_offers.html?' + (toQuery(s) || 'all=1');
    }
  };
})(window);
