/* ============================================================
   RAF Catalog — ADAPTER over the central data authority.
   ------------------------------------------------------------
   This file used to own its own copy of the product list. It is now a thin
   translation layer on top of RAFSource, kept so that every page already
   calling RAFCatalog.get()/slugFor() keeps working unchanged while reading
   centralized data. New code should prefer RAFSource directly.

   Return shape is deliberately unchanged:
     { id, ar, en, price, old, disc, rate, rev, ic, stock, desc,
       store:{ar,en}, slug, variants }
   ============================================================ */
(function () {
  if (window.RAFCatalog) return;

  function src(){ return window.RAFSource || null; }
  function lang(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en' ? 'en' : 'ar'; }

  /* central product record → the legacy flat shape pages expect */
  function toLegacy(p) {
    if (!p) return null;
    var s = p.storeRef || (src() && src().store(p.store)) || null;
    return {
      id: p.id,
      ar: p.name.ar, en: p.name.en,
      price: p.price, old: p.old || '', disc: p.disc || 0,
      rate: p.rate || '', rev: p.rev || '', ic: p.ic || 'ti-box',
      img: p.img || '', images: p.images || [],
      stock: (p.stock == null ? 10 : p.stock),
      desc: p.desc || null,
      store: s ? { ar: s.name.ar, en: s.name.en } : null,
      slug: p.store || '',
      variants: p.variants || null,
      /* additive fields — safe for old callers, useful for new ones */
      cat: p.cat || '', status: p.status, sponsored: !!p.sponsored,
      /* a merchant-configured, product-specific size guide (null when none) */
      sizeGuide: p.sizeGuide || null
    };
  }

  /* Store display name (either language) → slug.
     Exact matches only. This used to fall back to 'casa-mode' for an empty
     name and to a slugified guess for an unknown one, which could route a
     customer into the wrong store. An unresolved name now returns '' so the
     caller can decline to navigate rather than land somewhere arbitrary. */
  function slugFor(name) {
    if (!name) return '';
    var S = src();
    if (!S) return '';
    var needle = String(name).trim().toLowerCase();
    var hit = S.allStores().find(function (s) {
      return s.name.ar.trim().toLowerCase() === needle ||
             s.name.en.trim().toLowerCase() === needle ||
             s.slug === needle;
    });
    return hit ? hit.slug : '';
  }

  window.RAFCatalog = {
    slugFor: slugFor,
    get: function (id) {
      var S = src();
      if (!S) return null;
      return toLegacy(S.product(id));
    },
    /* new: pass-throughs so migrated pages can drop their own arrays */
    list: function (opts) { var S = src(); return S ? S.products(opts).map(toLegacy) : []; },
    stores: function (opts) { var S = src(); return S ? S.stores(opts) : []; },
    categories: function (opts) { var S = src(); return S ? S.categories(opts) : []; },
    lang: lang,
    toLegacy: toLegacy
  };
})();
