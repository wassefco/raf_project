/* ============================================================================
 * RAF Marketplace — STORE PROFILE AUTHORITY  (shared, headless)
 * ----------------------------------------------------------------------------
 * The one guarded way for a merchant to change their store's public profile.
 * RAFSource.updateStore() stays the storage layer; it has no permission or
 * ownership check of its own, so no page calls it directly for a merchant.
 *
 * WHAT A MERCHANT MAY EDIT — only fields the store record already has:
 *   · desc   { ar, en }   the store description shown on the storefront
 *
 * OPENING HOURS ARE NOT EDITED HERE. The structured schedule is their single
 * source (RAFStoreSchedule), and every hours text customers see is generated
 * from it. The legacy free-text `hours` on the store record is left as it is
 * for backward compatibility, but it is no longer editable or shown.
 *
 * WHAT IS DELIBERATELY NOT EDITABLE HERE (each needs a RAF decision):
 *   name (also the one-store-per-cart key), logo / cover (no store-media
 *   authority), category (marketplace taxonomy), status (open / closed /
 *   suspended — no merchant path exists), contact details (not in the model).
 *
 * PERMISSION + OWNERSHIP. The existing `stores.edit` key, checked through
 * RAFPerm by account id. The store is always the acting account's own store,
 * resolved with RAFPerm.storeSlugOf(actorId). A caller can never name a store,
 * and any store written onto an actor object is ignored.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFStoreProfile) return;

  /* the editable fields, each a { ar, en } text. Limits are technical guards
     against runaway input, not business rules. */
  var FIELDS = { desc:{ max:1000, multiline:true } };
  var LANGS = ['ar', 'en'];

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية لتعديل ملف المتجر.',        en:'You do not have permission to edit the store profile.' },
    NO_STORE:           { ar:'لا يوجد متجر مرتبط بهذا الحساب.',            en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:    { ar:'المتجر المرتبط غير موجود.',                  en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'هذا الحقل لا يمكن تعديله من هنا.',           en:'That field cannot be changed here.' },
    INVALID:            { ar:'البيانات غير صالحة.',                        en:'The details are not valid.' },
    STALE:              { ar:'تم تعديل ملف المتجر من جلسة أخرى. أعد التحميل ثم حاول مجددًا.',
                          en:'The store profile was changed in another session. Reload and try again.' },
    NO_CHANGES:         { ar:'لا توجد تغييرات لحفظها.',                   en:'There are no changes to save.' },
    PERSIST_FAILED:     { ar:'تعذّر الحفظ.',                               en:'Could not save.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* only ever the id — a role or store written onto an object is not trusted */
  function actorId(a){ return typeof a === 'string' ? a : ((a && a.id) || null); }

  function scope(actor){
    var id = actorId(actor);
    if (!id || !global.RAFPerm || !global.RAFSource || !RAFPerm.getUser(id)) return fail('FORBIDDEN');
    var slug = null;
    try { slug = RAFPerm.storeSlugOf(id) || null; } catch (e) { slug = null; }
    if (!slug) return fail('NO_STORE');
    var store = RAFSource.store(slug);
    if (!store) return fail('STORE_NOT_FOUND');
    return { ok:true, id:id, slug:slug, store:store };
  }
  function can(key, actor){
    var id = actorId(actor);
    if (!id || !global.RAFPerm) return false;
    try { return !!(RAFPerm.getUser(id) && RAFPerm.can(id, key)); } catch (e) { return false; }
  }
  function canView(actor){ return can('stores.view', actor); }
  function canEdit(actor){ return can('stores.edit', actor); }

  function versionOf(store){ return (store && store.profileUpdatedAt) || 0; }
  function text(v){ return typeof v === 'string' ? v : ''; }
  function pair(o){ o = (o && typeof o === 'object') ? o : {}; return { ar:text(o.ar), en:text(o.en) }; }

  /* the acting account's own store, as the profile editor needs it */
  function read(opts){
    opts = opts || {};
    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!canView(sc.id)) return fail('FORBIDDEN');
    var s = sc.store;
    return {
      ok:true, slug:sc.slug, editable:canEdit(sc.id), version:versionOf(s),
      fields:{ desc:pair(s.desc) },
      /* shown, never edited here */
      fixed:{ name:pair(s.name), num:s.num || null, cat:pair(s.cat), logo:s.logo || '', cover:s.cover || '',
              status:s.status || null, icon:s.ic || null },
      updatedAt:s.profileUpdatedAt || null
    };
  }

  function validate(patch){
    var errors = [];
    Object.keys(patch).forEach(function (f) {
      var rule = FIELDS[f], v = patch[f];
      if (!rule) { errors.push({ field:f, message:T('حقل غير مدعوم','Unsupported field') }); return; }
      if (!v || typeof v !== 'object') { errors.push({ field:f, message:T('قيمة غير صالحة','Invalid value') }); return; }
      Object.keys(v).forEach(function (l) {
        if (LANGS.indexOf(l) < 0) errors.push({ field:f + '.' + l, message:T('لغة غير مدعومة','Unsupported language') });
      });
      LANGS.forEach(function (l) {
        var t = v[l];
        if (typeof t !== 'string') { errors.push({ field:f + '.' + l, message:T('النص مطلوب','Text is required') }); return; }
        var s = t.trim();
        /* the storefront always shows both languages; a blank one would read as broken */
        if (!s) errors.push({ field:f + '.' + l, message:T('لا يمكن ترك هذا الحقل فارغًا','This field cannot be empty') });
        if (s.length > rule.max) errors.push({ field:f + '.' + l, message:T('النص أطول من المسموح (' + rule.max + ' حرف)',
                                                                      'Text is longer than allowed (' + rule.max + ' characters)') });
        if (!rule.multiline && /[\r\n]/.test(s)) errors.push({ field:f + '.' + l, message:T('سطر واحد فقط','Single line only') });
      });
    });
    return { ok:errors.length === 0, errors:errors };
  }

  function update(patch, opts){
    opts = opts || {};
    patch = patch || {};
    /* nothing but the editable fields — a store, slug or id is never accepted */
    var bad = Object.keys(patch).filter(function (k) { return !FIELDS[k]; });
    if (bad.length) return fail('FIELD_NOT_ACCEPTED', { fields:bad });
    if (!Object.keys(patch).length) return fail('NO_CHANGES');

    var sc = scope(opts.actor); if (!sc.ok) return sc;
    if (!canEdit(sc.id)) return fail('FORBIDDEN');

    var v = validate(patch);
    if (!v.ok) return fail('INVALID', { errors:v.errors });

    /* an edit made against an out-of-date reading is refused, never merged */
    if (opts.baseVersion !== undefined && opts.baseVersion !== versionOf(sc.store))
      return fail('STALE', { currentVersion:versionOf(sc.store) });

    var next = {}, changed = [];
    Object.keys(patch).forEach(function (f) {
      var cur = pair(sc.store[f]);
      var val = { ar:patch[f].ar.trim(), en:patch[f].en.trim() };
      if (val.ar !== cur.ar || val.en !== cur.en) { next[f] = val; changed.push(f); }
    });
    if (!changed.length) return fail('NO_CHANGES');

    var now = Date.now();
    next.profileUpdatedAt = now;
    next.profileUpdatedBy = sc.id;
    if (!RAFSource.updateStore(sc.slug, next)) return fail('PERSIST_FAILED');

    if (global.RAFAudit) {
      try {
        var u = RAFPerm.getUser(sc.id);
        RAFAudit.record({ action:'store.profile_updated', storeSlug:sc.slug, source:'merchant',
          key:sc.slug + ':' + now, actor:{ id:sc.id, name:(u && u.name) || sc.id },
          metadata:{ fields:changed } });
      } catch (e) {}
    }
    return { ok:true, changed:changed, version:now };
  }

  global.RAFStoreProfile = {
    FIELDS:FIELDS, ERRORS:ERRORS,
    canView:canView, canEdit:canEdit,
    read:read, validate:validate, update:update
  };
})(window);
