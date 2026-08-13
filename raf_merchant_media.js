/* ============================================================
   RAF — MERCHANT MEDIA AUTHORITY  (shared, headless)
   ------------------------------------------------------------
   The one path by which a merchant may change product imagery:

     Merchant UI → RAFMerchantMedia → RAFSource → RAFCatalog → Customer UI

   WHAT RAF ACTUALLY STORES (established by inspection, not assumed):

     img      — a single image reference, the MAIN image
     images[] — an ordered list of image references

   Both live on the product record. In RAFSource neither is purely
   authoritative: at flatten time `img` falls back to the conventional
   asset path `assets/products/<id>.jpg`, and `images` falls back to
   `[img]`. Once a merchant saves, this module writes BOTH so they can
   never disagree, with the rule the customer UI already implies:

     images[0] IS the main image, and img mirrors it.

   Image identity is the reference string itself — RAF has never given
   images ids, and inventing one would mean rewriting every existing
   product. Reordering therefore preserves identity; replacing content
   creates a new identity, because it is a different reference.

   No second media database, no duplicate copies, no generated imagery.
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFMerchantMedia) return;

  /* Only representations that survive a refresh through the existing
     storage layer. A blob:/object URL dies with the page, so it is refused
     rather than saved as a reference that would silently break. */
  var ASSET_RE  = /^assets\/[\w\-./]+\.(jpe?g|png|webp|gif|avif)$/i;
  var REMOTE_RE = /^https?:\/\/[^\s]+$/i;
  var DATA_RE   = /^data:image\/(jpeg|jpg|png|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i;
  var BLOB_RE   = /^(blob:|object:)/i;

  /* A data URL is held in localStorage alongside the rest of the catalogue.
     The ceiling is a storage limit, not a business rule. */
  var MAX_DATA_URL_BYTES = 400 * 1024;
  var MAX_IMAGES = 8;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }
  function src(){ return global.RAFSource || null; }
  function MP(){ return global.RAFMerchantProducts || null; }

  /* ---------- scope + permission (delegated, never duplicated) ---------- */
  function owns(productId, userOrId){ var m = MP(); return m ? m.owns(productId, userOrId) : false; }
  function canEdit(userOrId){ var m = MP(); return m ? m.canEdit(userOrId) : false; }

  /* ---------- read ---------- */
  function list(productId){
    var S = src(); if (!S) return [];
    var p = S.product(productId);
    if (!p) return [];
    if (p.images && p.images.length) return p.images.slice();
    return p.img ? [p.img] : [];
  }
  /* the main image is the first one — the rule the customer UI already uses */
  function mainOf(productId){
    var l = list(productId);
    return l.length ? l[0] : null;
  }
  function kindOf(ref){
    if (!ref || typeof ref !== 'string') return 'invalid';
    if (BLOB_RE.test(ref))   return 'ephemeral';
    if (DATA_RE.test(ref))   return 'data';
    if (REMOTE_RE.test(ref)) return 'remote';
    if (ASSET_RE.test(ref))  return 'asset';
    return 'invalid';
  }
  function byteLength(dataUrl){
    var i = dataUrl.indexOf(',');
    if (i < 0) return 0;
    return Math.floor((dataUrl.length - i - 1) * 3 / 4);
  }

  /* ---------- validation ---------- */
  function validate(images){
    var errors = [];
    function bad(where, ar, en){ errors.push({ field:where, message:T(ar,en) }); }
    if (!Array.isArray(images)) { bad('images','بنية الصور غير صالحة','Invalid image structure'); return { ok:false, errors:errors }; }
    if (!images.length)         bad('images','يجب أن يحتوي المنتج على صورة واحدة على الأقل','A product needs at least one image');
    if (images.length > MAX_IMAGES)
      bad('images', 'الحد الأقصى ' + MAX_IMAGES + ' صور', 'A maximum of ' + MAX_IMAGES + ' images is allowed');

    var seen = {};
    images.forEach(function (ref, i) {
      var at = 'images.' + i;
      if (!ref || !String(ref).trim()) { bad(at,'مرجع الصورة مفقود','Image reference is missing'); return; }
      var kind = kindOf(ref);
      if (kind === 'ephemeral')
        bad(at,'هذا المرجع مؤقت ولن يبقى بعد التحديث. استخدم ملفاً أو رابطاً دائماً.',
               'This reference is temporary and would not survive a refresh. Use a file or a permanent link.');
      else if (kind === 'invalid')
        bad(at,'صيغة الصورة غير مدعومة','Unsupported image format');
      else if (kind === 'data' && byteLength(ref) > MAX_DATA_URL_BYTES)
        bad(at,'حجم الصورة يتجاوز ' + Math.round(MAX_DATA_URL_BYTES/1024) + ' كيلوبايت',
               'Image exceeds ' + Math.round(MAX_DATA_URL_BYTES/1024) + ' KB');
      /* the same reference twice conveys nothing to a customer */
      var k = String(ref);
      if (seen[k]) bad(at,'لا يمكن تكرار نفس الصورة','The same image cannot appear twice');
      seen[k] = 1;
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* Confirms a reference actually resolves before it is saved, so a broken
     image is never stored silently. Resolves true/false, never throws. */
  function probe(ref){
    return new Promise(function (resolve) {
      if (kindOf(ref) === 'invalid' || kindOf(ref) === 'ephemeral') return resolve(false);
      var im = new Image();
      var done = false;
      function finish(ok){ if (!done) { done = true; resolve(ok); } }
      im.onload = function () { finish(true); };
      im.onerror = function () { finish(false); };
      im.src = ref;
      setTimeout(function () { finish(false); }, 8000);
    });
  }
  /* reads a chosen file into a persistable data URL — the only upload path a
     static prototype can honestly offer */
  function fileToDataUrl(file){
    return new Promise(function (resolve, reject) {
      if (!file) return reject(new Error('no_file'));
      if (!/^image\//.test(file.type)) return reject(new Error('unsupported_type'));
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result)); };
      r.onerror = function () { reject(new Error('read_failed')); };
      r.readAsDataURL(file);
    });
  }

  /* ---------- the one write path ----------
     Atomic: the whole list is validated, then written once. `img` and
     `images` are always written together so the two can never diverge. */
  function save(productId, images, opts){
    opts = opts || {};
    var actor = opts.actor || null;
    var who = (actor && actor.id) || null;

    if (!canEdit(who)) {
      return { ok:false, code:'FORBIDDEN',
               errors:[{ field:'permission', message:T('لا تملك صلاحية تعديل المنتجات','You do not have permission to edit products') }] };
    }
    if (!owns(productId, who)) {
      return { ok:false, code:'CROSS_STORE',
               errors:[{ field:'store', message:T('هذا المنتج لا يخص متجرك','This product does not belong to your store') }] };
    }
    var S = src(), before = S && S.product(productId);
    if (!before) {
      return { ok:false, code:'NOT_FOUND',
               errors:[{ field:'product', message:T('المنتج غير موجود','Product not found') }] };
    }
    /* the same stale-write protection established in Phase 3.1 */
    var m = MP(), currentVersion = m ? m.versionOf(productId) : null;
    if (opts.baseVersion !== undefined && opts.baseVersion !== currentVersion) {
      return { ok:false, code:'STALE', currentVersion:currentVersion,
               errors:[{ field:'conflict',
                         message:T('تم تعديل هذا المنتج في جلسة أخرى. أعد تحميل المنتج ثم احفظ من جديد.',
                                   'This product was changed in another session. Reload it and save again.') }] };
    }

    var v = validate(images);
    if (!v.ok) return { ok:false, code:'INVALID', errors:v.errors };

    var prev = list(productId);
    var next = images.slice();
    if (JSON.stringify(prev) === JSON.stringify(next)) {
      return { ok:false, code:'NO_CHANGES',
               errors:[{ field:'images', message:T('لا توجد تغييرات','No changes to save') }] };
    }

    var stamp = Date.now();
    /* images[0] is the main image; img mirrors it so no consumer disagrees */
    var ok = S.updateProduct(productId, { images: next, img: next[0], updatedAt: stamp });
    if (!ok) {
      return { ok:false, code:'WRITE_FAILED',
               errors:[{ field:'engine', message:T('تعذّر حفظ الصور','Could not save the images') }] };
    }
    try { document.dispatchEvent(new CustomEvent('raf:source')); } catch (e) {}

    /* ---- audit: one event per real change, successes only ---- */
    var events = [];
    if (global.RAFAudit) {
      var slug = m ? m.productSlug(productId) : null;
      var added   = next.filter(function (r) { return prev.indexOf(r) < 0; });
      var removed = prev.filter(function (r) { return next.indexOf(r) < 0; });
      var reordered = !added.length && !removed.length &&
                      JSON.stringify(prev) !== JSON.stringify(next);
      var mainChanged = prev[0] !== next[0];

      function rec(action, meta){
        try {
          RAFAudit.record({ action:action, storeSlug:slug, actor:actor, source:'merchant',
            key:productId + ':' + action + ':' + stamp, reason:opts.reason || 'merchant_media_edit',
            metadata: Object.assign({ productId:productId, count:next.length }, meta || {}) });
          events.push(action);
        } catch (e) {}
      }
      /* a replacement is an add and a removal in the same save */
      if (added.length && removed.length) rec('image.updated', { added:added.length, removed:removed.length });
      else if (added.length)              rec('image.added',   { added:added.length });
      else if (removed.length)            rec('image.removed', { removed:removed.length });
      if (reordered)   rec('image.reordered', { order:next.length });
      if (mainChanged) rec('main_image.changed', {});
    }
    return { ok:true, productId:productId, version:stamp, images:next, events:events };
  }

  global.RAFMerchantMedia = {
    MAX_IMAGES: MAX_IMAGES, MAX_DATA_URL_BYTES: MAX_DATA_URL_BYTES,
    /* read */
    list: list, mainOf: mainOf, kindOf: kindOf, byteLength: byteLength,
    /* input */
    probe: probe, fileToDataUrl: fileToDataUrl,
    /* validation + write */
    validate: validate, save: save,
    /* scope */
    owns: owns, canEdit: canEdit
  };
})(window);
