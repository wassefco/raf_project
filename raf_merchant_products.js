/* ============================================================
   RAF — MERCHANT PRODUCT AUTHORITY  (shared, headless)
   ------------------------------------------------------------
   The one path by which a merchant may change a product:

     Merchant UI → RAFMerchantProducts → RAFSource → Customer UI

   No page may write to RAFSource directly. Everything a merchant
   submits passes through here, where it is checked for ownership,
   permission, validity and staleness before a single field moves.

   There is exactly one product record — RAFSource. This module holds
   no product database of its own and stores no merchant-side copy.

   What it deliberately does NOT do:
     · delete products (no destructive lifecycle in this phase)
     · touch order snapshots — historical orders are immutable
     · create categories, variants, size guides or media
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFMerchantProducts) return;

  var STATUS = { ACTIVE:'active', HIDDEN:'hidden' };   /* 'deleted' is not offered here */

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }
  function src(){ return global.RAFSource || null; }

  /* ---------- currency: the existing RAF configuration, never invented ---------- */
  function currency(){
    return (global.RAFOrderSnapshot && RAFOrderSnapshot.CURRENCY) || 'KWD';
  }

  /* ---------- ownership ----------
     A product belongs to a merchant only when the product's authoritative
     storeSlug equals the authenticated merchant's storeSlug. Nothing else
     is consulted — not names, not emails, not usernames. */
  /* by id only: RAFPerm returns a passed object as-is, so an object's own
     storeSlug / roleId fields would otherwise be trusted */
  function idOf(userOrId){
    return (userOrId && typeof userOrId === 'object') ? userOrId.id : userOrId;
  }
  function merchantSlug(userOrId){
    if (!global.RAFPerm) return null;
    try { return RAFPerm.storeSlugOf(idOf(userOrId)) || null; } catch (e) { return null; }
  }
  function productSlug(productId){
    var S = src(); if (!S) return null;
    var p = S.product(productId);
    return (p && p.store) || null;
  }
  function owns(productId, userOrId){
    var ms = merchantSlug(userOrId), ps = productSlug(productId);
    return !!(ms && ps && ms === ps);
  }

  /* ---------- permission ----------
     RAFPerm stays the only authority; no second permission system. */
  function can(key, userOrId){
    if (!global.RAFPerm) return false;
    try {
      var who = idOf(userOrId);
      if (!who) { var cu = RAFPerm.currentUser(); who = cu && cu.id; }
      if (!who) return false;
      return RAFPerm.can(who, key);
    } catch (e) { return false; }
  }
  function canEdit(userOrId){ return can('products.edit', userOrId); }
  function canView(userOrId){ return can('products.view', userOrId); }
  /* creation is its own approved permission; it is never inferred from edit */
  function canCreate(userOrId){ return can('products.create', userOrId); }
  /* products.delete is deliberately NOT surfaced by this module. Deletion,
     soft deletion and any status change to `deleted` are unavailable in this
     phase; product lifecycle will be specified separately. */

  /* ---------- listing, always scoped to the merchant's own store ---------- */
  function list(opts){
    opts = opts || {};
    var S = src(); if (!S) return [];
    /* the scope is the account's own store, resolved by RAFPerm. A supplied
       storeSlug is only a consistency check: naming another store refuses
       the read, it is never honoured (this list includes hidden products) */
    var slug = merchantSlug(opts.user);
    if (!slug) return [];
    if (opts.storeSlug !== undefined && opts.storeSlug !== slug) return [];
    /* visibleOnly:false so the merchant also sees hidden / out-of-stock items */
    return S.products({ visibleOnly:false }).filter(function (p) {
      return p.store === slug && p.status !== 'deleted';
    });
  }
  function get(productId, userOrId){
    if (!owns(productId, userOrId)) return null;
    var S = src(); if (!S) return null;
    return S.product(productId) || null;
  }
  /* the categories a merchant may assign — existing ones only */
  function categories(){
    var S = src();
    return S ? S.categories({ populatedOnly:false }) : [];
  }

  /* ---------- concurrency ----------
     Each successful save stamps `updatedAt`. An editor captures that value
     when it opens; a save carrying a stale stamp is rejected rather than
     silently overwriting whatever another session wrote in the meantime. */
  function versionOf(productId){
    var S = src(); if (!S) return null;
    var p = S.product(productId);
    return (p && p.updatedAt) || null;
  }

  /* ---------- validation ----------
     Nothing partially valid is ever saved. Messages are bilingual. */
  function num(v){
    if (v === '' || v == null) return NaN;
    var n = Number(String(v).trim());
    return isFinite(n) ? n : NaN;
  }
  function validate(productId, patch, userOrId){
    var S = src();
    if (!S) return { ok:false, errors:[{ field:'engine', message:T('مصدر البيانات غير متاح','Data source unavailable') }] };
    var current = S.product(productId);
    if (!current) return { ok:false, errors:[{ field:'product', message:T('المنتج غير موجود','Product not found') }] };
    return runRules(current, patch);
  }
  /* The SAME rules, applied to a product that does not exist yet. A draft is
     judged against an empty baseline, so creation and editing can never drift
     apart: there is one rule body and both callers run it. */
  function validateNew(draft){
    var baseline = { price:0, old:null, disc:0, status:STATUS.ACTIVE, cat:'' };
    /* an empty field is "missing", not "invalid" — reporting both for the same
       box would tell the merchant off twice for one omission */
    var present = {};
    Object.keys(draft).forEach(function (k) {
      if (draft[k] !== '' && draft[k] !== undefined) present[k] = draft[k];
    });
    var r = runRules(baseline, present);
    var errors = r.errors.slice();
    function bad(field, ar, en){ errors.push({ field:field, message:T(ar, en) }); }
    /* on creation these are required rather than optional-if-present */
    if (!draft.name || !draft.name.ar || !String(draft.name.ar).trim())
      bad('name.ar','اسم المنتج بالعربية مطلوب','Arabic product name is required');
    if (!draft.name || !draft.name.en || !String(draft.name.en).trim())
      bad('name.en','اسم المنتج بالإنجليزية مطلوب','English product name is required');
    if (draft.price === undefined || draft.price === '')
      bad('price','السعر مطلوب','Price is required');
    if (!draft.cat) bad('cat','الفئة مطلوبة','Category is required');
    /* de-duplicate: runRules may already have flagged the same field */
    var seen = {}, out = [];
    errors.forEach(function (e) { var k = e.field+'|'+e.message; if (!seen[k]) { seen[k]=1; out.push(e); } });
    return { ok: out.length === 0, errors: out };
  }
  function runRules(current, patch){
    var errors = [];
    function bad(field, ar, en){ errors.push({ field:field, message:T(ar, en) }); }

    /* name — both languages are displayed to customers, so both are required */
    if (patch.name){
      if (!patch.name.ar || !String(patch.name.ar).trim()) bad('name.ar','اسم المنتج بالعربية مطلوب','Arabic product name is required');
      if (!patch.name.en || !String(patch.name.en).trim()) bad('name.en','اسم المنتج بالإنجليزية مطلوب','English product name is required');
    }

    /* pricing */
    var price = patch.price !== undefined ? num(patch.price) : num(current.price);
    var old   = patch.old   !== undefined ? (patch.old === '' ? null : num(patch.old))
                                          : (current.old ? num(current.old) : null);
    var disc  = patch.disc  !== undefined ? num(patch.disc) : num(current.disc || 0);

    if (patch.price !== undefined){
      if (isNaN(price))   bad('price','السعر غير صالح','Invalid price');
      else if (price < 0) bad('price','لا يمكن أن يكون السعر سالباً','Price cannot be negative');
      else if (price === 0) bad('price','يجب أن يكون السعر أكبر من صفر','Price must be greater than zero');
    }
    if (patch.old !== undefined && patch.old !== '' && old !== null){
      if (isNaN(old))   bad('old','السعر الأصلي غير صالح','Invalid original price');
      else if (old < 0) bad('old','لا يمكن أن يكون السعر الأصلي سالباً','Original price cannot be negative');
    }
    if (patch.disc !== undefined){
      if (isNaN(disc) || disc % 1 !== 0) bad('disc','نسبة الخصم غير صالحة','Invalid discount');
      else if (disc < 0 || disc > 99)    bad('disc','نسبة الخصم يجب أن تكون بين 0 و 99','Discount must be between 0 and 99');
    }
    /* impossible discount states */
    if (!isNaN(price) && old !== null && !isNaN(old) && old > 0 && old <= price && disc > 0){
      bad('old','السعر الأصلي يجب أن يكون أعلى من السعر الحالي عند وجود خصم',
                'Original price must be higher than the current price when a discount is set');
    }
    if (disc > 0 && (old === null || isNaN(old) || old === 0)){
      bad('disc','لا يمكن تحديد خصم بدون سعر أصلي','A discount needs an original price');
    }

    /* stock is never accepted here — numeric inventory is a later phase */
    if (patch.stock !== undefined){
      bad('stock','لا يمكن تعديل الكمية في هذه المرحلة','Stock quantity cannot be edited in this phase');
    }

    /* status — active or hidden only. `deleted` is never settable from this
       workspace: product lifecycle and deletion are specified separately. */
    if (patch.status !== undefined && patch.status !== STATUS.ACTIVE && patch.status !== STATUS.HIDDEN){
      bad('status','حالة المنتج غير صالحة','Invalid product status');
    }

    /* category — must be one that already exists */
    if (patch.cat !== undefined){
      var keys = categories().map(function (c) { return c.k; });
      if (!patch.cat || keys.indexOf(patch.cat) < 0) bad('cat','الفئة غير صالحة','Invalid category');
    }

    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------- the one write path ----------
     `stock` is deliberately absent: numeric inventory belongs to a dedicated
     Inventory phase. The field stays in RAFSource and its behaviour is
     unchanged — this module simply refuses to write it. */
  var EDITABLE = ['name','desc','price','old','disc','cat','status'];
  /* fields a merchant may see but not change in this phase */
  var READ_ONLY = ['stock','sku','barcode','variants','images','img','rate','rev','sponsored'];

  function update(productId, patch, opts){
    opts = opts || {};
    var actor = opts.actor || null;
    var who = (actor && actor.id) || null;

    /* 1 — permission, enforced in the engine and not merely hidden in the UI */
    if (!canEdit(who)) {
      return { ok:false, code:'FORBIDDEN',
               errors:[{ field:'permission', message:T('لا تملك صلاحية تعديل المنتجات','You do not have permission to edit products') }] };
    }
    /* 2 — ownership by authoritative storeSlug */
    if (!owns(productId, who)) {
      return { ok:false, code:'CROSS_STORE',
               errors:[{ field:'store', message:T('هذا المنتج لا يخص متجرك','This product does not belong to your store') }] };
    }
    /* 3 — an attempt to write a read-only field is refused outright rather
       than silently dropped, so a caller is never misled about what was saved */
    var blocked = READ_ONLY.filter(function (k) { return patch[k] !== undefined; });
    if (blocked.length) {
      return { ok:false, code:'FIELD_NOT_EDITABLE', fields:blocked,
               errors:[{ field:blocked[0],
                         message:T('هذا الحقل غير قابل للتعديل في هذه المرحلة',
                                   'This field cannot be edited in this phase') }] };
    }
    /* only known editable fields ever reach the source */
    var clean = {};
    EDITABLE.forEach(function (k) { if (patch[k] !== undefined) clean[k] = patch[k]; });
    if (!Object.keys(clean).length) {
      return { ok:false, code:'NO_CHANGES',
               errors:[{ field:'patch', message:T('لا توجد تغييرات','No changes to save') }] };
    }
    /* 4 — staleness is a precondition: it is checked before the field values,
       so a merchant editing an out-of-date copy is told to reload rather than
       being sent to fix fields against data that has already moved on. */
    var currentVersion = versionOf(productId);
    if (opts.baseVersion !== undefined && opts.baseVersion !== currentVersion) {
      return { ok:false, code:'STALE', currentVersion:currentVersion,
               errors:[{ field:'conflict',
                         message:T('تم تعديل هذا المنتج في جلسة أخرى. أعد تحميل المنتج ثم احفظ من جديد.',
                                   'This product was changed in another session. Reload it and save again.') }] };
    }

    /* 5 — validation; nothing partially valid is written */
    var v = validate(productId, clean, who);
    if (!v.ok) return { ok:false, code:'INVALID', errors:v.errors };

    /* 6 — capture only what actually changes, for the audit record */
    var S = src(), before = S.product(productId);
    var changed = {};
    Object.keys(clean).forEach(function (k) {
      var from = before[k], to = clean[k];
      if (JSON.stringify(from) !== JSON.stringify(to)) changed[k] = { from:from, to:to };
    });
    if (!Object.keys(changed).length) {
      return { ok:false, code:'NO_CHANGES',
               errors:[{ field:'patch', message:T('لا توجد تغييرات','No changes to save') }] };
    }

    /* 7 — write. Unrelated fields are untouched: RAFSource merges the patch
       over the record, so nothing outside `clean` moves. */
    var stamp = Date.now();
    clean.updatedAt = stamp;
    var ok = S.updateProduct(productId, clean);
    if (!ok) {
      return { ok:false, code:'WRITE_FAILED',
               errors:[{ field:'engine', message:T('تعذّر حفظ التغييرات','Could not save the changes') }] };
    }
    /* the existing source event is what customer surfaces already listen to */
    try { document.dispatchEvent(new CustomEvent('raf:source')); } catch (e) {}

    /* 8 — audit the successful change only. A rejected attempt above never
       reaches this point, so a failure can never be logged as a success. */
    if (global.RAFAudit) {
      try {
        RAFAudit.record({
          action:'product.updated', storeSlug:productSlug(productId),
          actor:actor, source:'merchant', key:productId + ':' + stamp,
          reason:opts.reason || 'merchant_edit',
          metadata:{ productId:productId, fields:Object.keys(changed), changes:changed }
        });
      } catch (e) {}
    }
    return { ok:true, productId:productId, version:stamp, changed:Object.keys(changed) };
  }

  /* ══════════════ CREATE ══════════════
     The one supported way a product comes into existence.

     The store is resolved from the acting user's own record through
     RAFPerm, never from anything the caller sends. A caller may therefore
     ask to create a product, but never to create one somewhere else: a
     supplied `store` or `storeSlug` is refused outright rather than
     ignored, so nobody is misled about where their product landed. */
  var CREATABLE = ['name','desc','price','old','disc','cat','status','sku','barcode','variants','sizeGuide','images','img','ic'];

  function create(productData, opts){
    opts = opts || {};
    var actor = opts.actor || null;
    var who = (actor && actor.id) || null;

    /* 1 — a real, identifiable actor */
    if (!who) {
      return { ok:false, code:'FORBIDDEN',
               errors:[{ field:'permission', message:T('لا تملك صلاحية إضافة منتجات','You do not have permission to add products') }] };
    }
    if (global.RAFPerm && !RAFPerm.getUser(who)) {
      return { ok:false, code:'FORBIDDEN',
               errors:[{ field:'permission', message:T('الحساب غير معروف','Unknown account') }] };
    }
    /* 2 — the approved creation permission, checked in the engine */
    if (!canCreate(who)) {
      return { ok:false, code:'FORBIDDEN',
               errors:[{ field:'permission', message:T('لا تملك صلاحية إضافة منتجات','You do not have permission to add products') }] };
    }
    /* 3 — the store comes from the account, and only from the account */
    var slug = merchantSlug(who);
    if (!slug) {
      return { ok:false, code:'NO_STORE',
               errors:[{ field:'store', message:T('لا يوجد متجر مرتبط بهذا الحساب','This account is not linked to a store') }] };
    }
    var data = productData || {};
    if (data.store !== undefined || data.storeSlug !== undefined || data.id !== undefined) {
      return { ok:false, code:'FIELD_NOT_ACCEPTED', fields:['store','storeSlug','id'],
               errors:[{ field:'store',
                         message:T('المتجر ومعرّف المنتج يُحدَّدان تلقائياً','Store and product id are assigned automatically') }] };
    }
    /* 4 — only known fields ever reach the catalogue */
    var clean = {};
    CREATABLE.forEach(function (k) { if (data[k] !== undefined) clean[k] = data[k]; });
    /* stock is never accepted here: inventory is its own authority and its
       own workspace, exactly as in update() */
    if (data.stock !== undefined) {
      return { ok:false, code:'INVALID',
               errors:[{ field:'stock', message:T('لا يمكن تحديد الكمية أثناء إنشاء المنتج',
                                                  'Stock quantity is not set while creating a product') }] };
    }
    if (clean.status === undefined) clean.status = STATUS.ACTIVE;

    /* 5 — the shared rules. `stock` is not part of the draft, and the shared
       rules reject it, so the baseline below is applied only after validation. */
    var v = validateNew(clean);
    if (!v.ok) return { ok:false, code:'INVALID', errors:v.errors };

    /* A new product owns no units yet. Zero is the empty baseline, not an
       invented quantity: it keeps the product in the valid minimal state the
       inventory authority already understands, and the merchant sets real
       quantities afterwards in Products → Inventory. Without it the product
       would read as "no inventory record" and be unusable on both sides. */
    clean.stock = 0;

    /* 6 — persist through the catalogue authority, which owns the identity */
    var S = src();
    if (!S || !S.addProduct) {
      return { ok:false, code:'ENGINE_UNAVAILABLE',
               errors:[{ field:'engine', message:T('تعذّر إنشاء المنتج','The product could not be created') }] };
    }
    clean.store = slug;
    var stamp = Date.now();
    clean.updatedAt = stamp;
    var res = S.addProduct(clean);
    if (!res.ok) {
      return { ok:false, code:res.code || 'WRITE_FAILED',
               errors:[{ field:'engine', message:T('تعذّر إنشاء المنتج','The product could not be created') }] };
    }

    try { document.dispatchEvent(new CustomEvent('raf:source')); } catch (e) {}

    /* 7 — audit the successful creation only, after it is readable */
    if (global.RAFAudit) {
      try {
        RAFAudit.record({
          action:'product.created', storeSlug:slug,
          actor:actor, source:'merchant', key:res.id + ':' + stamp,
          reason:opts.reason || 'merchant_create',
          metadata:{ productId:res.id, fields:Object.keys(clean) }
        });
      } catch (e) {}
    }
    return { ok:true, productId:res.id, version:stamp, product:res.product };
  }

  global.RAFMerchantProducts = {
    STATUS: STATUS, EDITABLE: EDITABLE, READ_ONLY: READ_ONLY, currency: currency,
    /* scope */
    merchantSlug: merchantSlug, productSlug: productSlug, owns: owns,
    /* permission — no delete capability is exposed */
    canView: canView, canEdit: canEdit, canCreate: canCreate,
    /* read */
    list: list, get: get, categories: categories, versionOf: versionOf,
    /* write */
    validate: validate, validateNew: validateNew, update: update, create: create
  };
})(window);
