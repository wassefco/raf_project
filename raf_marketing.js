/* ============================================================================
 * RAF Marketplace — MARKETING AUTHORITY  (shared, headless)
 * ----------------------------------------------------------------------------
 * The single owner of merchant marketing records: coupons and merchant
 * advertisements. Nothing else creates, edits or judges them.
 *
 * WHAT THIS MODULE DOES NOT DO — deliberately:
 *
 *   · It does not compute discounts. Cart and checkout pricing stays in
 *     RAFCO.totals(), which remains the one pricing authority. This module
 *     answers "is this coupon usable, and at what percentage" and nothing
 *     more, so no second pricing model can appear.
 *   · It does not touch inventory. A marketing record never reserves stock.
 *   · It does not render advertisements. RAFAds owns ad rendering; this
 *     module supplies the record and calls RAFAds.bannerHTML().
 *   · It does not delete. Expired records move to history and stay there.
 *
 * OWNERSHIP. Every record carries the storeSlug resolved from the acting
 * account through RAFPerm. A caller may never supply or override it.
 *
 * TIME. The marketplace operates on Asia/Kuwait (UTC+3). A date is a plain
 * 'YYYY-MM-DD' as the merchant typed it, and it means that calendar day in
 * Kuwait — never in the viewer's own timezone. All window arithmetic goes
 * through this one place.
 *
 * EXTENSIBILITY. Every record carries `campaignId: null`. A Campaign entity
 * is NOT implemented in this phase; the field exists so grouping can be added
 * later without restructuring or migrating anything.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFMarketing) return;

  var LS = 'raf_marketing';

  /* ---------- vocabulary ---------- */
  var KIND   = { COUPON:'coupon', AD:'ad', PROMOTION:'promotion' };
  /* what a promotion applies to. Targets are stable ids, never display text. */
  var TARGET = { STORE:'store', PRODUCTS:'products', CATEGORY:'category' };
  var STATUS = { DRAFT:'draft', SCHEDULED:'scheduled', ACTIVE:'active',
                 EXPIRED:'expired', DISABLED:'disabled' };
  /* the only discount shape the pricing authority can express today */
  var DISCOUNT = { PERCENT:'percent' };
  /* §13 — a merchant may advertise on their own store page and nowhere else.
     Homepage and discovery placements stay RAF-managed. */
  var PLACEMENT = { STORE_PAGE:'store_page' };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }

  /* ══════════════════════════════════════════════════════════════
     TIME — Asia/Kuwait (UTC+3), one implementation
     ══════════════════════════════════════════════════════════════ */
  var TZ_OFFSET_MIN = 3 * 60;

  /* the current instant expressed as Kuwait wall-clock */
  function kuwaitNow(){
    var d = new Date();
    return new Date(d.getTime() + (d.getTimezoneOffset() + TZ_OFFSET_MIN) * 60000);
  }
  function todayISO(){
    var k = kuwaitNow();
    return k.getFullYear() + '-' + pad2(k.getMonth() + 1) + '-' + pad2(k.getDate());
  }
  function pad2(n){ return (n < 10 ? '0' : '') + n; }
  /* a stored instant (epoch ms) read as Kuwait wall-clock — the same offset
     arithmetic as kuwaitNow(), for records that were written earlier */
  function kuwaitAt(ms){
    var d = new Date(ms);
    return new Date(d.getTime() + (d.getTimezoneOffset() + TZ_OFFSET_MIN) * 60000);
  }
  function dateOfInstant(ms){
    if (typeof ms !== 'number' || !isFinite(ms)) return null;
    var k = kuwaitAt(ms);
    return k.getFullYear() + '-' + pad2(k.getMonth() + 1) + '-' + pad2(k.getDate());
  }
  function timeOfInstant(ms){
    if (typeof ms !== 'number' || !isFinite(ms)) return null;
    var k = kuwaitAt(ms);
    return pad2(k.getHours()) + ':' + pad2(k.getMinutes());
  }
  function isDateStr(s){ return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  /* 'YYYY-MM-DD' compares correctly as a string, which keeps every window
     check free of timezone drift: both sides are Kuwait calendar days */
  function beforeDay(a, b){ return a < b; }
  function afterDay(a, b){ return a > b; }

  /* the derived lifecycle state. Status is never stored as "active": it is
     computed, so an ended record can never linger in the wrong state. */
  function statusOf(rec){
    if (!rec) return null;
    if (rec.enabled === false) return STATUS.DISABLED;
    if (!rec.startDate || !rec.endDate) return STATUS.DRAFT;
    var today = todayISO();
    if (beforeDay(today, rec.startDate)) return STATUS.SCHEDULED;
    if (afterDay(today, rec.endDate))    return STATUS.EXPIRED;
    return STATUS.ACTIVE;
  }
  /* history is "finished with", not "deleted" */
  function isHistory(rec){ return statusOf(rec) === STATUS.EXPIRED; }
  function daysLeft(rec){
    if (!rec || !rec.endDate) return null;
    var k = kuwaitNow(), end = new Date(rec.endDate + 'T23:59:59');
    return Math.ceil((end - k) / 86400000);
  }
  function expiringSoon(rec, within){
    if (statusOf(rec) !== STATUS.ACTIVE) return false;
    var d = daysLeft(rec);
    return d !== null && d <= (within == null ? 7 : within);
  }

  /* ══════════════════════════════════════════════════════════════
     STORAGE
     ══════════════════════════════════════════════════════════════ */
  function readAll(){
    try {
      var o = JSON.parse(localStorage.getItem(LS));
      if (!o || typeof o !== 'object') o = {};
      if (!Array.isArray(o.coupons))    o.coupons = [];
      if (!Array.isArray(o.ads))        o.ads = [];
      if (!Array.isArray(o.promotions)) o.promotions = [];
      return o;
    } catch (e) { return { coupons:[], ads:[], promotions:[] }; }
  }
  function writeAll(o){
    try { localStorage.setItem(LS, JSON.stringify(o)); } catch (e) { return false; }
    try { document.dispatchEvent(new CustomEvent('raf:marketing')); } catch (e) {}
    return true;
  }
  function newId(prefix){
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,6);
  }

  /* ══════════════════════════════════════════════════════════════
     SEEDED COUPONS — migration, once
     The five codes that used to live hard-coded in RAFCO and again in
     raf_coupons.html are adopted here on first read so behaviour that
     already shipped keeps working, and so there is exactly one source of
     truth from that moment on. Their percentages are unchanged.
     ══════════════════════════════════════════════════════════════ */
  var SEED = [
    { code:'WELCOME20', pct:20, storeSlug:null, startDate:'2026-01-01', endDate:'2026-12-31',
      name:{ ar:'خصم ترحيبي', en:'Welcome discount' } },
    { code:'FLASH10',   pct:10, storeSlug:null, startDate:'2026-01-01', endDate:'2026-09-30',
      name:{ ar:'عروض الفلاش', en:'Flash deals' } },
    { code:'VIP30',     pct:30, storeSlug:null, startDate:'2026-01-01', endDate:'2026-08-15',
      name:{ ar:'كوبون كبار العملاء', en:'VIP coupon' } },
    { code:'RAMADAN25', pct:25, storeSlug:null, startDate:'2026-01-01', endDate:'2026-04-10',
      name:{ ar:'عرض رمضان', en:'Ramadan offer' } },
    { code:'SUMMER15',  pct:15, storeSlug:null, startDate:'2026-01-01', endDate:'2026-06-01',
      name:{ ar:'تخفيضات الصيف', en:'Summer sale' } }
  ];
  var seeded = false;
  function ensureSeed(){
    if (seeded) return;
    seeded = true;
    var all = readAll();
    if (all.coupons.length || all.seeded) return;
    SEED.forEach(function (s) {
      all.coupons.push({
        id:newId('cpn'), kind:KIND.COUPON, campaignId:null,
        storeSlug:s.storeSlug,               /* null = platform-wide, RAF-owned */
        origin:'platform',
        code:s.code, name:s.name,
        discountType:DISCOUNT.PERCENT, value:s.pct,
        startDate:s.startDate, endDate:s.endDate,
        enabled:true, createdAt:Date.now(), updatedAt:Date.now()
      });
    });
    all.seeded = true;
    writeAll(all);
  }

  /* ══════════════════════════════════════════════════════════════
     PERMISSION + OWNERSHIP
     The unified Marketing Center runs on the existing offers.* keys; no new
     permission key is introduced. The store is resolved from the acting
     account and never accepted from a caller.
     ══════════════════════════════════════════════════════════════ */
  function actorId(actor){ return (actor && actor.id) || null; }
  function can(key, who){
    if (!global.RAFPerm) return false;
    try {
      if (!who) return false;
      if (!RAFPerm.getUser(who)) return false;
      return RAFPerm.can(who, key);
    } catch (e) { return false; }
  }
  function canView(actor){   return can('offers.view',   actorId(actor)); }
  function canCreate(actor){ return can('offers.create', actorId(actor)); }
  function canEdit(actor){   return can('offers.edit',   actorId(actor)); }
  /* THE store resolution. Never from the page. */
  function storeOf(actor){
    var who = actorId(actor);
    if (!who || !global.RAFPerm) return null;
    try { return RAFPerm.storeSlugOf(who) || null; } catch (e) { return null; }
  }

  function fail(code, extra){
    var msgs = {
      FORBIDDEN:        { ar:'ليس لديك صلاحية لإدارة التسويق.', en:'You do not have permission to manage marketing.' },
      NO_STORE:         { ar:'لا يوجد متجر مرتبط بهذا الحساب.', en:'This account is not linked to a store.' },
      CROSS_STORE:      { ar:'هذا السجل لا يخص متجرك.',        en:'This record does not belong to your store.' },
      FIELD_NOT_ACCEPTED:{ ar:'المتجر يُحدَّد تلقائياً.',       en:'The store is assigned automatically.' },
      NOT_FOUND:        { ar:'السجل غير موجود.',               en:'Record not found.' },
      INVALID:          { ar:'البيانات غير صالحة.',            en:'The details are not valid.' },
      DUPLICATE_CODE:   { ar:'رمز الكوبون مستخدم بالفعل.',     en:'That coupon code is already in use.' },
      NOT_EDITABLE:     { ar:'لا يمكن تعديل سجل منتهٍ.',       en:'An expired record cannot be edited.' },
      PERSIST_FAILED:   { ar:'تعذّر الحفظ.',                   en:'Could not save.' }
    };
    var m = msgs[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function err(field, ar, en){ return { field:field, message:T(ar,en) }; }

  /* ══════════════════════════════════════════════════════════════
     VALIDATION — shared by create and edit
     ══════════════════════════════════════════════════════════════ */
  function validateWindow(d, errors){
    if (!isDateStr(d.startDate)) errors.push(err('startDate','تاريخ البداية مطلوب','A start date is required'));
    if (!isDateStr(d.endDate))   errors.push(err('endDate','تاريخ النهاية مطلوب','An end date is required'));
    if (isDateStr(d.startDate) && isDateStr(d.endDate) && afterDay(d.startDate, d.endDate))
      errors.push(err('endDate','تاريخ النهاية يجب أن يكون بعد تاريخ البداية','The end date must be on or after the start date'));
  }
  function normCode(c){ return String(c == null ? '' : c).trim().toUpperCase(); }

  function validateCouponDraft(d, opts){
    opts = opts || {};
    var errors = [];
    var code = normCode(d.code);
    if (!code) errors.push(err('code','رمز الكوبون مطلوب','A coupon code is required'));
    else if (!/^[A-Z0-9][A-Z0-9_-]{2,23}$/.test(code))
      errors.push(err('code','الرمز: 3–24 حرفاً أو رقماً إنجليزياً','Code: 3–24 letters, digits, - or _'));

    /* percentage is the only shape RAFCO.totals() can express today */
    if (d.discountType !== undefined && d.discountType !== DISCOUNT.PERCENT)
      errors.push(err('discountType','نوع الخصم غير مدعوم','That discount type is not supported'));
    var v = Number(d.value);
    if (!isFinite(v) || v % 1 !== 0) errors.push(err('value','قيمة الخصم غير صالحة','Invalid discount value'));
    else if (v < 1 || v > 90) errors.push(err('value','نسبة الخصم يجب أن تكون بين 1 و 90','The discount must be between 1 and 90'));

    if (!d.name || !String(d.name.ar || '').trim()) errors.push(err('name.ar','اسم الكوبون بالعربية مطلوب','An Arabic coupon name is required'));
    if (!d.name || !String(d.name.en || '').trim()) errors.push(err('name.en','اسم الكوبون بالإنجليزية مطلوب','An English coupon name is required'));

    validateWindow(d, errors);

    /* uniqueness is scoped across everything a shopper could type, because the
       cart looks a code up globally — two live records sharing a code would
       make the winner arbitrary */
    if (code) {
      var clash = byCode(code);
      if (clash && clash.id !== opts.ignoreId) errors.push(err('code','رمز الكوبون مستخدم بالفعل','That coupon code is already in use'));
    }
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------- promotions ----------
     A promotion is a percentage applied to the lines it targets. Targets are
     stable ids: product ids from the catalogue, or a category key. A display
     name is never used to decide eligibility. */
  function validatePromotionDraft(d, opts){
    opts = opts || {};
    var errors = [];
    if (!d.name || !String(d.name.ar || '').trim()) errors.push(err('name.ar','اسم العرض بالعربية مطلوب','An Arabic promotion name is required'));
    if (!d.name || !String(d.name.en || '').trim()) errors.push(err('name.en','اسم العرض بالإنجليزية مطلوب','An English promotion name is required'));

    var v = Number(d.value);
    if (!isFinite(v) || v % 1 !== 0) errors.push(err('value','قيمة الخصم غير صالحة','Invalid discount value'));
    else if (v < 1 || v > 90) errors.push(err('value','نسبة الخصم يجب أن تكون بين 1 و 90','The discount must be between 1 and 90'));

    var t = d.target || {};
    if (t.type !== TARGET.STORE && t.type !== TARGET.PRODUCTS && t.type !== TARGET.CATEGORY)
      errors.push(err('target','اختر ما ينطبق عليه العرض','Choose what the promotion applies to'));
    if (t.type === TARGET.PRODUCTS){
      var ids = t.productIds || [];
      if (!ids.length) errors.push(err('target','اختر منتجاً واحداً على الأقل','Select at least one product'));
      else if (opts.storeSlug && global.RAFCatalog) {
        /* every target must be a real product of THIS store */
        var bad = ids.filter(function (id) {
          var p = RAFCatalog.get(id);
          return !p || p.slug !== opts.storeSlug;
        });
        if (bad.length) errors.push(err('target','بعض المنتجات المحددة لا تخص متجرك','Some selected products do not belong to your store'));
      }
    }
    if (t.type === TARGET.CATEGORY){
      if (!t.categoryKey) errors.push(err('target','اختر فئة','Select a category'));
      else if (global.RAFCatalog) {
        var keys = (RAFCatalog.categories() || []).map(function (c) { return c.k; });
        if (keys.indexOf(t.categoryKey) < 0) errors.push(err('target','الفئة غير صالحة','Invalid category'));
      }
    }
    validateWindow(d, errors);

    /* ONE DISCOUNT PER ORDER is the approved rule, so a store may not run two
       promotions whose live windows overlap — that would force this module to
       invent a priority between them. Overlap is refused at the door instead. */
    if (opts.storeSlug && isDateStr(d.startDate) && isDateStr(d.endDate)) {
      var clash = readAll().promotions.filter(function (p) {
        if (p.storeSlug !== opts.storeSlug) return false;
        if (p.id === opts.ignoreId) return false;
        if (p.enabled === false) return false;
        return !(afterDay(d.startDate, p.endDate) || afterDay(p.startDate, d.endDate));
      })[0];
      if (clash) errors.push(err('startDate',
        'يوجد عرض آخر فعّال في هذه الفترة. أوقفه أو غيّر التواريخ.',
        'Another promotion is already live in this period. Disable it or change the dates.'));
    }
    return { ok: errors.length === 0, errors: errors };
  }

  function validateAdDraft(d){
    var errors = [];
    if (!d.title || !String(d.title.ar || '').trim()) errors.push(err('title.ar','العنوان بالعربية مطلوب','An Arabic title is required'));
    if (!d.title || !String(d.title.en || '').trim()) errors.push(err('title.en','العنوان بالإنجليزية مطلوب','An English title is required'));
    if (d.placement !== undefined && d.placement !== PLACEMENT.STORE_PAGE)
      errors.push(err('placement','هذا الموضع غير متاح للمتاجر','That placement is not available to stores'));
    validateWindow(d, errors);
    return { ok: errors.length === 0, errors: errors };
  }

  /* ══════════════════════════════════════════════════════════════
     READS
     ══════════════════════════════════════════════════════════════ */
  function decorate(rec){
    var out = {};
    for (var k in rec) if (rec.hasOwnProperty(k)) out[k] = rec[k];
    out.status = statusOf(rec);
    out.daysLeft = daysLeft(rec);
    out.expiringSoon = expiringSoon(rec);
    return out;
  }
  function coupons(opts){
    ensureSeed();
    opts = opts || {};
    return readAll().coupons
      .filter(function (c) { return opts.storeSlug === undefined || c.storeSlug === opts.storeSlug; })
      .map(decorate);
  }
  function ads(opts){
    opts = opts || {};
    return readAll().ads
      .filter(function (a) { return opts.storeSlug === undefined || a.storeSlug === opts.storeSlug; })
      .map(decorate);
  }
  function promotions(opts){
    opts = opts || {};
    return readAll().promotions
      .filter(function (p) { return opts.storeSlug === undefined || p.storeSlug === opts.storeSlug; })
      .map(decorate);
  }
  /* everything one store owns */
  function listFor(slug){
    return { coupons: coupons({ storeSlug:slug }), ads: ads({ storeSlug:slug }),
             promotions: promotions({ storeSlug:slug }) };
  }
  function byId(id){
    var all = readAll();
    var hit = all.coupons.filter(function (c) { return c.id === id; })[0]
           || all.ads.filter(function (a) { return a.id === id; })[0]
           || all.promotions.filter(function (p) { return p.id === id; })[0];
    return hit ? decorate(hit) : null;
  }

  /* ══════════════════════════════════════════════════════════════
     THE PROMOTION GATE — eligibility, decided in one place
     Pricing asks these two questions and nothing else. No page may
     re-implement them.
     ══════════════════════════════════════════════════════════════ */

  /* the single live promotion for a store, or null. Overlapping live
     promotions cannot exist (refused at creation), so there is never a
     priority to invent here. */
  function activePromotion(slug){
    if (!slug) return null;
    var live = promotions({ storeSlug:slug }).filter(function (p) { return p.status === STATUS.ACTIVE; });
    return live.length ? live[0] : null;
  }
  /* does this promotion cover this product? Stable ids only. */
  function promotionCovers(promo, productId){
    if (!promo || !productId) return false;
    var t = promo.target || {};
    if (t.type === TARGET.STORE) return true;
    if (t.type === TARGET.PRODUCTS) return (t.productIds || []).indexOf(productId) > -1;
    if (t.type === TARGET.CATEGORY) {
      if (!global.RAFCatalog) return false;
      var p = RAFCatalog.get(productId);
      return !!(p && p.cat && p.cat === t.categoryKey);
    }
    return false;
  }
  /* the percentage that applies to one product, or 0 */
  function promotionPctFor(productId, slug){
    var promo = activePromotion(slug);
    return (promo && promotionCovers(promo, productId)) ? promo.value : 0;
  }

  /* ---- read cache ----
     A listing renders dozens of cards and each one asks the same question.
     The answer changes only when marketing data changes, so it is resolved
     once per store and dropped the moment anything is written or another tab
     writes. No surface has to remember to refresh. */
  var promoCache = {};
  function cachedPromotion(slug){
    if (!slug) return null;
    if (!promoCache.hasOwnProperty(slug)) promoCache[slug] = activePromotion(slug);
    return promoCache[slug];
  }
  function clearCache(){ promoCache = {}; }
  try {
    document.addEventListener('raf:marketing', clearCache);
    global.addEventListener('storage', function (e) { if (e.key === LS) clearCache(); });
  } catch (e) {}

  /* ══════════════════════════════════════════════════════════════
     CUSTOMER DISPLAY — the one answer every surface uses
     ──────────────────────────────────────────────────────────────
     A PROMOTION is visible: the shopper sees the original price struck
     through, the promotional price, and the percentage. A COUPON is not
     shown per product — its allocation stays internal and only the cart
     total names it. This helper therefore knows about promotions only.

     It returns presentation values, never the promotion's id or any
     internal figure.
     ══════════════════════════════════════════════════════════════ */
  function displayPrice(product){
    var none = { promoted:false, pct:0, original:null, final:null, name:null };
    if (!product || !product.id) return none;
    /* the slug is a string; a legacy record's `store` is a bilingual display
       name, which must never be mistaken for a store reference */
    var slug = typeof product.slug === 'string' && product.slug ? product.slug
             : (typeof product.store === 'string' ? product.store : null);
    if (!slug) return none;
    var promo = cachedPromotion(slug);
    if (!promo || !promotionCovers(promo, product.id)) return none;

    var base = parseFloat(product.price);
    if (!isFinite(base) || base <= 0) return none;
    /* same rounding as the pricing engine: whole fils */
    var finalFils = Math.round(base * 1000) - Math.round(Math.round(base * 1000) * promo.value / 100);
    return {
      promoted: true,
      pct: promo.value,
      original: base.toFixed(3),
      final: (finalFils / 1000).toFixed(3),
      name: promo.name || null
    };
  }
  /* does this store have anything live worth showing a shopper? */
  function hasActivePromotion(slug){ return !!cachedPromotion(slug); }
  /* the products a live promotion covers, for a store's offers section */
  function promotedProducts(slug){
    var promo = cachedPromotion(slug);
    if (!promo || !global.RAFCatalog) return [];
    return RAFCatalog.list({ visibleOnly:true })
      .filter(function (p) { return p.slug === slug && promotionCovers(promo, p.id); });
  }
  function byCode(code){
    ensureSeed();
    var c = normCode(code);
    var hit = readAll().coupons.filter(function (x) { return x.code === c; })[0];
    return hit ? decorate(hit) : null;
  }

  /* ══════════════════════════════════════════════════════════════
     THE COUPON GATE — what cart and checkout ask
     Returns the usable percentage, or a typed reason it cannot be used.
     This is a validity question, not a pricing calculation: the discount
     itself is still computed by RAFCO.totals().
     ══════════════════════════════════════════════════════════════ */
  function checkCoupon(code, ctx){
    ctx = ctx || {};
    var c = byCode(code);
    if (!c) return { ok:false, code:'UNKNOWN_CODE',
                     message:T('رمز الكوبون غير صالح','Invalid coupon code') };
    var st = c.status;
    if (st === STATUS.DISABLED) return { ok:false, code:'DISABLED',
                     message:T('هذا الكوبون متوقف','This coupon is not active') };
    if (st === STATUS.SCHEDULED) return { ok:false, code:'NOT_STARTED',
                     message:T('لم يبدأ هذا الكوبون بعد','This coupon has not started yet') };
    if (st === STATUS.EXPIRED) return { ok:false, code:'EXPIRED',
                     message:T('انتهت صلاحية هذا الكوبون','This coupon has expired') };
    if (st !== STATUS.ACTIVE) return { ok:false, code:'NOT_ACTIVE',
                     message:T('هذا الكوبون غير متاح','This coupon is not available') };
    /* a store coupon only applies to a cart from that store */
    if (c.storeSlug && ctx.storeSlug && c.storeSlug !== ctx.storeSlug)
      return { ok:false, code:'WRONG_STORE',
               message:T('هذا الكوبون يخص متجراً آخر','This coupon belongs to a different store') };
    return { ok:true, coupon:c, code:c.code, pct:c.value };
  }

  /* ══════════════════════════════════════════════════════════════
     WRITES
     ══════════════════════════════════════════════════════════════ */
  function guard(actor, needCreate){
    var who = actorId(actor);
    if (!who) return fail('FORBIDDEN');
    if (!(needCreate ? canCreate(actor) : canEdit(actor))) return fail('FORBIDDEN');
    var slug = storeOf(actor);
    if (!slug) return fail('NO_STORE');
    return { ok:true, slug:slug, who:who };
  }
  function audit(action, slug, actor, meta){
    if (!global.RAFAudit) return;
    try {
      RAFAudit.record({ action:action, storeSlug:slug, actor:actor, source:'merchant',
                        key:(meta && meta.id ? meta.id : '') + ':' + Date.now(),
                        metadata:meta || {} });
    } catch (e) {}
  }

  function createCoupon(draft, opts){
    opts = opts || {};
    var g = guard(opts.actor, true); if (!g.ok) return g;
    var d = draft || {};
    if (d.storeSlug !== undefined || d.store !== undefined || d.id !== undefined)
      return fail('FIELD_NOT_ACCEPTED');

    var v = validateCouponDraft(d);
    if (!v.ok) return fail('INVALID', { errors:v.errors });

    var rec = {
      id:newId('cpn'), kind:KIND.COUPON, campaignId:null,
      storeSlug:g.slug, origin:'merchant',
      code:normCode(d.code),
      name:{ ar:String(d.name.ar).trim(), en:String(d.name.en).trim() },
      discountType:DISCOUNT.PERCENT, value:Number(d.value),
      startDate:d.startDate, endDate:d.endDate,
      enabled:true, createdAt:Date.now(), updatedAt:Date.now()
    };
    var all = readAll();
    /* re-check under the write, so two tabs cannot both mint the same code */
    if (all.coupons.some(function (c) { return c.code === rec.code; })) return fail('DUPLICATE_CODE');
    all.coupons.push(rec);
    if (!writeAll(all)) return fail('PERSIST_FAILED');

    audit('coupon.created', g.slug, opts.actor, { id:rec.id, code:rec.code, value:rec.value });
    return { ok:true, record:decorate(rec) };
  }

  function createPromotion(draft, opts){
    opts = opts || {};
    var g = guard(opts.actor, true); if (!g.ok) return g;
    var d = draft || {};
    if (d.storeSlug !== undefined || d.store !== undefined || d.id !== undefined)
      return fail('FIELD_NOT_ACCEPTED');

    var v = validatePromotionDraft(d, { storeSlug:g.slug });
    if (!v.ok) return fail('INVALID', { errors:v.errors });

    var t = d.target || {};
    var rec = {
      id:newId('pro'), kind:KIND.PROMOTION, campaignId:null,
      storeSlug:g.slug, origin:'merchant',
      name:{ ar:String(d.name.ar).trim(), en:String(d.name.en).trim() },
      discountType:DISCOUNT.PERCENT, value:Number(d.value),
      target:{ type:t.type,
               productIds: t.type === TARGET.PRODUCTS ? (t.productIds || []).slice() : [],
               categoryKey: t.type === TARGET.CATEGORY ? t.categoryKey : null },
      startDate:d.startDate, endDate:d.endDate,
      enabled:true, createdAt:Date.now(), updatedAt:Date.now()
    };
    var all = readAll();
    all.promotions.push(rec);
    if (!writeAll(all)) return fail('PERSIST_FAILED');

    audit('promotion.created', g.slug, opts.actor,
          { id:rec.id, value:rec.value, target:rec.target.type });
    return { ok:true, record:decorate(rec) };
  }

  function createAd(draft, opts){
    opts = opts || {};
    var g = guard(opts.actor, true); if (!g.ok) return g;
    var d = draft || {};
    if (d.storeSlug !== undefined || d.store !== undefined || d.id !== undefined)
      return fail('FIELD_NOT_ACCEPTED');

    var v = validateAdDraft(d);
    if (!v.ok) return fail('INVALID', { errors:v.errors });

    var rec = {
      id:newId('ad'), kind:KIND.AD, campaignId:null,
      storeSlug:g.slug, origin:'merchant',
      title:{ ar:String(d.title.ar).trim(), en:String(d.title.en).trim() },
      body:{ ar:String((d.body && d.body.ar) || '').trim(), en:String((d.body && d.body.en) || '').trim() },
      image:String(d.image || ''),
      /* the destination is always inside the merchant's own store */
      destination:String(d.destination || ''),
      placement:PLACEMENT.STORE_PAGE,
      startDate:d.startDate, endDate:d.endDate,
      enabled:true, createdAt:Date.now(), updatedAt:Date.now()
    };
    var all = readAll();
    all.ads.push(rec);
    if (!writeAll(all)) return fail('PERSIST_FAILED');

    audit('advertisement.created', g.slug, opts.actor, { id:rec.id, placement:rec.placement });
    return { ok:true, record:decorate(rec) };
  }

  /* one edit path for both kinds; only the owning store may write */
  function update(id, patch, opts){
    opts = opts || {};
    var g = guard(opts.actor, false); if (!g.ok) return g;
    var all = readAll();
    var list = all.coupons, ix = -1;
    for (var i = 0; i < all.coupons.length; i++) if (all.coupons[i].id === id) ix = i;
    if (ix < 0) {
      list = all.ads;
      for (var j = 0; j < all.ads.length; j++) if (all.ads[j].id === id) ix = j;
    }
    if (ix < 0) {
      list = all.promotions;
      for (var k2 = 0; k2 < all.promotions.length; k2++) if (all.promotions[k2].id === id) ix = k2;
    }
    if (ix < 0) return fail('NOT_FOUND');
    var rec = list[ix];
    if (rec.storeSlug !== g.slug) return fail('CROSS_STORE');
    /* §20 — history is a reference record, not an editing surface */
    if (statusOf(rec) === STATUS.EXPIRED) return fail('NOT_EDITABLE');

    var p = patch || {};
    if (p.storeSlug !== undefined || p.store !== undefined || p.id !== undefined || p.origin !== undefined)
      return fail('FIELD_NOT_ACCEPTED');

    var next = {};
    for (var k in rec) if (rec.hasOwnProperty(k)) next[k] = rec[k];
    ['name','title','body','image','destination','value','startDate','endDate','code','enabled','target']
      .forEach(function (f) { if (p[f] !== undefined) next[f] = p[f]; });
    if (next.code !== undefined) next.code = normCode(next.code);

    var v = rec.kind === KIND.COUPON     ? validateCouponDraft(next, { ignoreId:rec.id })
          : rec.kind === KIND.PROMOTION  ? validatePromotionDraft(next, { storeSlug:g.slug, ignoreId:rec.id })
          :                                validateAdDraft(next);
    if (!v.ok) return fail('INVALID', { errors:v.errors });

    next.updatedAt = Date.now();
    list[ix] = next;
    if (!writeAll(all)) return fail('PERSIST_FAILED');

    audit(rec.kind === KIND.COUPON    ? 'coupon.updated'
        : rec.kind === KIND.PROMOTION ? 'promotion.updated'
        :                               'advertisement.updated',
          g.slug, opts.actor, { id:rec.id, fields:Object.keys(p) });
    return { ok:true, record:decorate(next) };
  }

  /* enable / disable — the only lifecycle control a merchant has. There is no
     delete: an ended record becomes history and stays as a reference. */
  function setEnabled(id, on, opts){
    opts = opts || {};
    var g = guard(opts.actor, false); if (!g.ok) return g;
    var all = readAll();
    var rec = all.coupons.filter(function (c) { return c.id === id; })[0]
           || all.ads.filter(function (a) { return a.id === id; })[0]
           || all.promotions.filter(function (p) { return p.id === id; })[0];
    if (!rec) return fail('NOT_FOUND');
    if (rec.storeSlug !== g.slug) return fail('CROSS_STORE');
    if (statusOf(rec) === STATUS.EXPIRED) return fail('NOT_EDITABLE');

    rec.enabled = !!on;
    rec.updatedAt = Date.now();
    if (!writeAll(all)) return fail('PERSIST_FAILED');

    var a = rec.kind === KIND.COUPON    ? (on ? 'coupon.enabled' : 'coupon.disabled')
          : rec.kind === KIND.PROMOTION ? (on ? 'promotion.enabled' : 'promotion.disabled')
          :                               (on ? 'advertisement.enabled' : 'advertisement.disabled');
    audit(a, g.slug, opts.actor, { id:rec.id });
    return { ok:true, record:decorate(rec) };
  }

  /* ══════════════════════════════════════════════════════════════
     CUSTOMER SURFACE — the merchant ads that may show on a store page.
     Rendering itself belongs to RAFAds; this only decides what qualifies.
     ══════════════════════════════════════════════════════════════ */
  function storeAds(slug){
    if (!slug) return [];
    return ads({ storeSlug:slug })
      .filter(function (a) { return a.status === STATUS.ACTIVE && a.placement === PLACEMENT.STORE_PAGE; })
      .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  }

  /* ══════════════════════════════════════════════════════════════
     DISCOUNT FUNDING — who pays for a discount
     Read from the record's own `origin`, which is set at creation and can
     never be edited: RAF's platform records are RAF-funded, anything a
     merchant created is merchant-funded. Never inferred from an amount.
     ══════════════════════════════════════════════════════════════ */
  var FUNDING = { MERCHANT:'merchant', RAF:'raf' };
  function fundingOf(rec){
    if (!rec) return null;
    if (rec.origin === 'platform') return FUNDING.RAF;
    if (rec.origin === 'merchant') return FUNDING.MERCHANT;
    return null;
  }

  global.RAFMarketing = {
    KIND:KIND, STATUS:STATUS, DISCOUNT:DISCOUNT, PLACEMENT:PLACEMENT, TARGET:TARGET,
    /* promotions */
    promotions:promotions, createPromotion:createPromotion,
    validatePromotionDraft:validatePromotionDraft,
    activePromotion:activePromotion, promotionCovers:promotionCovers, promotionPctFor:promotionPctFor,
    /* customer presentation — one answer, reused by every surface */
    displayPrice:displayPrice, hasActivePromotion:hasActivePromotion, promotedProducts:promotedProducts,
    /* time */
    todayISO:todayISO, kuwaitNow:kuwaitNow, statusOf:statusOf,
    dateOfInstant:dateOfInstant, timeOfInstant:timeOfInstant,
    isHistory:isHistory, daysLeft:daysLeft, expiringSoon:expiringSoon,
    /* permission */
    canView:canView, canCreate:canCreate, canEdit:canEdit, storeOf:storeOf,
    /* read */
    coupons:coupons, ads:ads, listFor:listFor, byId:byId, byCode:byCode,
    /* the coupon gate used by cart + checkout */
    checkCoupon:checkCoupon,
    /* validation (UI may preview it; the authority still decides) */
    validateCouponDraft:validateCouponDraft, validateAdDraft:validateAdDraft,
    /* write */
    createCoupon:createCoupon, createAd:createAd, update:update, setEnabled:setEnabled,
    /* customer surface */
    storeAds:storeAds,
    /* who funds a discount */
    FUNDING:FUNDING, fundingOf:fundingOf
  };
})(window);
