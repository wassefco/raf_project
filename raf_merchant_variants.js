/* ============================================================
   RAF — MERCHANT VARIANT & SIZE-GUIDE AUTHORITY  (shared, headless)
   ------------------------------------------------------------
   The one path by which a merchant may change a product's options
   or its size guide:

     Merchant UI → RAFMerchantVariants → RAFSource → RAFCatalog → Customer UI

   WHAT RAF ACTUALLY MODELS (established by inspection, not assumed):
   a product carries option GROUPS, not purchasable combinations —

     variants: [
       { label:{ar,en}, options:[ {v:'m', label:{ar:'M',en:'M'}}, … ] },
       { label:{ar:'اللون',en:'Color'}, options:[ {v:'black', label:{…}, hex:'#1A1A1A'} ] }
     ]

   A combination such as "M / Black" is never stored as a record. It
   materialises only at cart and order time, as the signature
   `productId|Label:Value,…`. There is therefore no per-combination
   price, availability, image or id in RAF today, and this module does
   not invent any of them.

   Stable identity is the option's `v`. Renaming a label, changing a
   swatch or reordering never changes it.

   Writes are atomic: the whole option set is validated and then saved
   in one call, so a rejected member can never leave a partial state.
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFMerchantVariants) return;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }
  function src(){ return global.RAFSource || null; }
  function MP(){ return global.RAFMerchantProducts || null; }

  var SIZE_LABEL  = /مقاس|قياس|size/i;
  var COLOR_LABEL = /لون|color|colour/i;
  var HEX = /^#[0-9a-fA-F]{6}$/;

  /* ---------- scope + permission ----------
     Both delegate to the authorities that already own them; no second
     ownership rule and no second permission system. */
  function owns(productId, userOrId){
    var m = MP();
    return m ? m.owns(productId, userOrId) : false;
  }
  function canEdit(userOrId){
    var m = MP();
    return m ? m.canEdit(userOrId) : false;
  }

  /* ---------- read ---------- */
  function groups(productId){
    var S = src(); if (!S) return [];
    var p = S.product(productId);
    return (p && p.variants) ? JSON.parse(JSON.stringify(p.variants)) : [];
  }
  function isSizeGroup(g){
    var l = (g && g.label) || {};
    return SIZE_LABEL.test(((l.ar||'') + ' ' + (l.en||'')));
  }
  function isColorGroup(g){
    var l = (g && g.label) || {};
    return COLOR_LABEL.test(((l.ar||'') + ' ' + (l.en||'')));
  }
  function sizeGroupOf(productId){
    return groups(productId).filter(isSizeGroup)[0] || null;
  }
  function colorGroupOf(productId){
    return groups(productId).filter(isColorGroup)[0] || null;
  }

  /* ---------- stable option ids ----------
     Derived from the label once, then never regenerated. Collisions get a
     numeric suffix so an id is unique within its group forever. */
  function slugify(text){
    var s = String(text || '').trim().toLowerCase()
      .replace(/[^\w؀-ۿ]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return s || 'opt';
  }
  function newOptionId(group, label){
    var base = slugify(label), taken = {}, i = 2;
    (group.options || []).forEach(function (o) { taken[o.v] = 1; });
    if (!taken[base]) return base;
    while (taken[base + '-' + i]) i++;
    return base + '-' + i;
  }

  /* ---------- historical references ----------
     There is deliberately no reference lookup here. The order snapshot stores
     option LABELS, not stable option ids, so any check would have to match on
     display strings — which are not authoritative and break the moment an
     option is renamed. Rather than rely on that, option removal is refused
     outright (see OPTION_REMOVAL_DEFERRED in save). A future, explicitly
     approved schema phase will add option ids to the snapshot, at which point
     a real reference check becomes possible. */

  /* ---------- validation: option groups ---------- */
  function validateGroups(list){
    var errors = [];
    function bad(where, ar, en){ errors.push({ field:where, message:T(ar,en) }); }
    if (!Array.isArray(list)) { bad('variants','بنية الخيارات غير صالحة','Invalid options structure'); return { ok:false, errors:errors }; }

    var seenLabels = {};
    list.forEach(function (g, gi) {
      var l = (g && g.label) || {};
      if (!l.ar || !String(l.ar).trim()) bad('g'+gi+'.label.ar','اسم المجموعة بالعربية مطلوب','Group name in Arabic is required');
      if (!l.en || !String(l.en).trim()) bad('g'+gi+'.label.en','اسم المجموعة بالإنجليزية مطلوب','Group name in English is required');
      var key = String(l.en || l.ar).trim().toLowerCase();
      if (seenLabels[key]) bad('g'+gi+'.label','لا يمكن تكرار مجموعة الخيارات','Duplicate option group');
      seenLabels[key] = 1;

      var opts = (g && g.options) || [];
      if (!opts.length) bad('g'+gi+'.options','يجب أن تحتوي المجموعة على خيار واحد على الأقل','A group needs at least one option');

      var seenV = {}, seenLabel = {};
      opts.forEach(function (o, oi) {
        var at = 'g'+gi+'.o'+oi;
        if (!o || !o.v || !String(o.v).trim()) bad(at+'.v','معرّف الخيار مفقود','Option identifier is missing');
        else if (seenV[o.v]) bad(at+'.v','معرّف الخيار مكرر','Duplicate option identifier');
        else seenV[o.v] = 1;

        var ol = (o && o.label) || {};
        if (!ol.ar || !String(ol.ar).trim()) bad(at+'.label.ar','قيمة الخيار بالعربية مطلوبة','Option value in Arabic is required');
        if (!ol.en || !String(ol.en).trim()) bad(at+'.label.en','قيمة الخيار بالإنجليزية مطلوبة','Option value in English is required');

        /* a duplicate display value would make two cart signatures identical */
        var dk = String(ol.en || ol.ar).trim().toLowerCase();
        if (seenLabel[dk]) bad(at+'.label','لا يمكن تكرار نفس القيمة داخل المجموعة','The same value cannot appear twice in a group');
        seenLabel[dk] = 1;

        if (o && o.hex != null && o.hex !== '' && !HEX.test(o.hex))
          bad(at+'.hex','رمز اللون غير صالح (#RRGGBB)','Invalid colour code (#RRGGBB)');
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------- validation: size guide ----------
     Shape mirrors the existing customer guide: title, note, cols[], rows[]. */
  function validateGuide(guide){
    var errors = [];
    function bad(where, ar, en){ errors.push({ field:where, message:T(ar,en) }); }
    if (guide == null) return { ok:true, errors:[] };            /* clearing is valid */

    var t = guide.title || {};
    if (!t.ar || !String(t.ar).trim()) bad('guide.title.ar','عنوان الدليل بالعربية مطلوب','Guide title in Arabic is required');
    if (!t.en || !String(t.en).trim()) bad('guide.title.en','عنوان الدليل بالإنجليزية مطلوب','Guide title in English is required');

    var cols = guide.cols || [];
    if (cols.length < 2) bad('guide.cols','يجب وجود عمودين على الأقل','At least two columns are required');
    cols.forEach(function (c, i) {
      if (!c || !c.ar || !String(c.ar).trim()) bad('guide.col'+i+'.ar','اسم العمود بالعربية مطلوب','Column name in Arabic is required');
      if (!c || !c.en || !String(c.en).trim()) bad('guide.col'+i+'.en','اسم العمود بالإنجليزية مطلوب','Column name in English is required');
    });

    var rows = guide.rows || [];
    if (!rows.length) bad('guide.rows','يجب إضافة صف واحد على الأقل','At least one row is required');
    var seen = {};
    rows.forEach(function (r, i) {
      if (!Array.isArray(r) || r.length !== cols.length)
        bad('guide.row'+i,'عدد الخانات لا يطابق عدد الأعمدة','Row does not match the number of columns');
      var label = String((r && r[0]) || '').trim();
      if (!label) bad('guide.row'+i+'.0','اسم المقاس مطلوب','Size label is required');
      else if (seen[label.toLowerCase()]) bad('guide.row'+i+'.0','مقاس مكرر','Duplicate size row');
      else seen[label.toLowerCase()] = 1;
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------- the one write path ----------
     Atomic: options and guide are validated together and written once. */
  function save(productId, payload, opts){
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

    var patch = {}, errors = [];
    var nextGroups = payload.variants !== undefined ? payload.variants : undefined;
    var nextGuide  = payload.sizeGuide !== undefined ? payload.sizeGuide : undefined;

    if (nextGroups !== undefined) {
      var gv = validateGroups(nextGroups);
      if (!gv.ok) errors = errors.concat(gv.errors);
      /* OPTION REMOVAL IS DEFERRED.
         The order snapshot records option LABELS, not stable option ids, so
         once an option is renamed there is no authoritative way to tell
         whether history still references it. Matching on labels or any other
         display string would not be authoritative, so removal is refused
         outright until the snapshot captures option ids.

         Identity is the option's `v`. Renaming, reordering, recolouring and
         adding all keep every existing `v` present, so they pass freely; only
         a `v` that disappears is a removal — including one that disappears
         because its whole group was dropped. */
      if (gv.ok) {
        var survivingIds = {};
        nextGroups.forEach(function (g) {
          (g.options || []).forEach(function (o) { survivingIds[o.v] = 1; });
        });
        var removed = [];
        (before.variants || []).forEach(function (g) {
          (g.options || []).forEach(function (o) {
            if (!survivingIds[o.v]) removed.push(o.v);
          });
        });
        if (removed.length) {
          return { ok:false, code:'OPTION_REMOVAL_DEFERRED', removed:removed,
                   errors:[{ field:'variants',
                     message:T('حذف الخيارات غير متاح حاليًا لحماية الخيارات المرتبطة بالطلبات السابقة.',
                               'Option removal is temporarily unavailable to protect options referenced by historical orders.') }] };
        }
      }
      patch.variants = nextGroups.length ? nextGroups : null;
    }
    if (nextGuide !== undefined) {
      var sv = validateGuide(nextGuide);
      if (!sv.ok) errors = errors.concat(sv.errors);
      patch.sizeGuide = nextGuide;
    }
    if (errors.length) return { ok:false, code:'INVALID', errors:errors };
    if (!Object.keys(patch).length) {
      return { ok:false, code:'NO_CHANGES',
               errors:[{ field:'payload', message:T('لا توجد تغييرات','No changes to save') }] };
    }

    /* nothing actually different? do not write, do not audit */
    var changed = {};
    Object.keys(patch).forEach(function (k) {
      if (JSON.stringify(before[k] == null ? null : before[k]) !== JSON.stringify(patch[k] == null ? null : patch[k])) {
        changed[k] = true;
      }
    });
    if (!Object.keys(changed).length) {
      return { ok:false, code:'NO_CHANGES',
               errors:[{ field:'payload', message:T('لا توجد تغييرات','No changes to save') }] };
    }

    var stamp = Date.now();
    patch.updatedAt = stamp;
    if (!S.updateProduct(productId, patch)) {
      return { ok:false, code:'WRITE_FAILED',
               errors:[{ field:'engine', message:T('تعذّر حفظ التغييرات','Could not save the changes') }] };
    }
    try { document.dispatchEvent(new CustomEvent('raf:source')); } catch (e) {}

    /* audit — successes only, one event per concern */
    if (global.RAFAudit) {
      var slug = m ? m.productSlug(productId) : null;
      try {
        if (changed.variants) {
          var beforeCount = countOptions(before.variants), afterCount = countOptions(patch.variants);
          RAFAudit.record({
            action: afterCount > beforeCount ? 'variant.created' : (afterCount < beforeCount ? 'variant.removed' : 'variant.updated'),
            storeSlug:slug, actor:actor, source:'merchant', key:productId + ':variants:' + stamp,
            reason:opts.reason || 'merchant_variant_edit',
            metadata:{ productId:productId, groups:(patch.variants||[]).length,
                       optionsBefore:beforeCount, optionsAfter:afterCount }
          });
        }
        if (changed.sizeGuide) {
          RAFAudit.record({
            action:'size_guide.updated', storeSlug:slug, actor:actor, source:'merchant',
            key:productId + ':guide:' + stamp, reason:opts.reason || 'merchant_size_guide_edit',
            metadata:{ productId:productId, cleared:patch.sizeGuide === null,
                       rows:(patch.sizeGuide && patch.sizeGuide.rows || []).length }
          });
        }
      } catch (e) {}
    }
    return { ok:true, productId:productId, version:stamp, changed:Object.keys(changed) };
  }
  function countOptions(list){
    return (list || []).reduce(function (n, g) { return n + ((g.options || []).length); }, 0);
  }

  /* ---------- size guide read ----------
     A product-level guide, when the merchant has configured one. Products
     without one keep the existing category-derived guide behaviour that the
     customer UI already implements. */
  function guideOf(productId){
    var S = src(); if (!S) return null;
    var p = S.product(productId);
    return (p && p.sizeGuide) || null;
  }
  function hasGuide(productId){ return !!guideOf(productId); }

  global.RAFMerchantVariants = {
    /* read */
    groups: groups, sizeGroupOf: sizeGroupOf, colorGroupOf: colorGroupOf,
    isSizeGroup: isSizeGroup, isColorGroup: isColorGroup,
    guideOf: guideOf, hasGuide: hasGuide,
    /* identity */
    newOptionId: newOptionId, slugify: slugify,
    /* validation */
    validateGroups: validateGroups, validateGuide: validateGuide,
    /* write */
    save: save,
    /* scope */
    owns: owns, canEdit: canEdit
  };
})(window);
