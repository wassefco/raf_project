/* ============================================================================
 * RAF Marketplace — ANALYTICS & FINANCE READ LAYER  (shared, headless)
 * ----------------------------------------------------------------------------
 * A reporting layer. It reads the authorities that already own the business
 * data and sums what they recorded. It owns NOTHING and writes NOTHING:
 *
 *   orders + historical values → RAFOrderSnapshot (immutable commercial record)
 *   removals / replacements    → the live invoice lines on the order
 *   refunds actually issued    → RAFOrderChanges (change records)
 *   promotions, coupons, ads   → RAFMarketing
 *   stock                      → RAFInventory
 *   store + permission         → RAFPerm (from the signed-in session only)
 *   money conversion           → RAFWallet (integer fils)
 *   Kuwait business dates      → RAFMarketing (Asia/Kuwait, UTC+3)
 *
 * WHAT THIS MODULE DOES NOT DO — deliberately:
 *   · It never prices anything. Every discount is the line value the pricing
 *     engine captured at checkout; nothing is recomputed with today's prices,
 *     promotions or coupons.
 *   · It never calculates stock. Inventory figures are RAFInventory's own.
 *   · It never stores a result. Every call derives from current data, so there
 *     is no second source of truth to drift.
 *   · It never computes commission, entitlement or settlement, and never
 *     decides who funded a discount — those are RAFSettlement's. Payouts have
 *     no authority in RAF yet and are never simulated.
 *
 * OWNERSHIP. The store is resolved from the signed-in account through
 * RAFPerm.storeLinkOf(). A caller may not name a store, a user or an actor;
 * any attempt is refused. Orders are scoped by the snapshot's storeSlug —
 * never by a display name.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFAnalytics) return;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية لعرض التقارير.',          en:'You do not have permission to view reports.' },
    NO_STORE:           { ar:'لا يوجد متجر مرتبط بهذا الحساب.',          en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:    { ar:'المتجر المرتبط غير موجود.',                en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'المتجر يُحدَّد تلقائياً من حسابك.',        en:'The store is taken from your account automatically.' },
    INVALID_RANGE:      { ar:'نطاق التاريخ غير صالح.',                   en:'The date range is not valid.' },
    AUTHORITY_MISSING:  { ar:'تعذّر الوصول إلى بيانات رف.',              en:'RAF data could not be reached.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  /* the authorities this layer reads — if one is absent nothing is guessed */
  var NEEDS = ['RAFPerm', 'RAFOrderSnapshot', 'RAFOrderChanges', 'RAFMarketing',
               'RAFWallet', 'RAFCatalog', 'RAFInventory', 'RAFSettlement'];
  function missingAuthorities(){
    return NEEDS.filter(function (n) { return !global[n]; });
  }

  /* ---------- money ----------
     Integer fils through the wallet authority's own converter. A value that is
     not an exact fils amount comes back null and is reported, never rounded
     into existence. */
  function fils(v){
    if (v === null || v === undefined || v === '') return null;
    return RAFWallet.toMinor(v);
  }

  /* ══════════════════════════════════════════════════════════════
     SCOPE — the signed-in account, its permission, its store
     ══════════════════════════════════════════════════════════════ */
  function context(){
    var miss = missingAuthorities();
    if (miss.length) return fail('AUTHORITY_MISSING', { missing:miss });
    var user = RAFPerm.currentUser();
    if (!user || !RAFPerm.can(user, 'reports.view')) return fail('FORBIDDEN');
    var link = RAFPerm.storeLinkOf(user);
    if (!link.ok) return fail(link.reason === 'store_not_found' ? 'STORE_NOT_FOUND' : 'NO_STORE');
    return { ok:true, userId:user.id, slug:link.slug, store:link.store,
             canExport:RAFPerm.can(user, 'reports.export') };
  }
  /* a caller never chooses whose data it reads */
  function scopeFieldSupplied(opts){
    if (!opts) return false;
    return ['storeSlug', 'store', 'slug', 'actor', 'user', 'userId'].some(function (k) {
      return opts[k] !== undefined;
    });
  }

  /* ══════════════════════════════════════════════════════════════
     DATE RANGE — Kuwait calendar days, inclusive, 'YYYY-MM-DD'
     ══════════════════════════════════════════════════════════════ */
  var PRESET = { TODAY:'today', YESTERDAY:'yesterday', LAST7:'last7', LAST30:'last30',
                 THIS_MONTH:'thisMonth', LAST_MONTH:'lastMonth', CUSTOM:'custom' };
  function utcOf(iso){ return Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)); }
  function isDay(s){
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    return new Date(utcOf(s)).toISOString().slice(0, 10) === s;   /* rejects 2026-02-31 */
  }
  function shiftDay(iso, n){ return new Date(utcOf(iso) + n * 86400000).toISOString().slice(0, 10); }
  function resolveRange(r){
    r = r || {};
    var today = RAFMarketing.todayISO(), from, to;
    switch (r.preset) {
      case PRESET.TODAY:      from = to = today; break;
      case PRESET.YESTERDAY:  from = to = shiftDay(today, -1); break;
      case PRESET.LAST7:      from = shiftDay(today, -6);  to = today; break;
      case PRESET.LAST30:     from = shiftDay(today, -29); to = today; break;
      case PRESET.THIS_MONTH: from = today.slice(0, 8) + '01'; to = today; break;
      case PRESET.LAST_MONTH:
        to = shiftDay(today.slice(0, 8) + '01', -1);
        from = to.slice(0, 8) + '01';
        break;
      case PRESET.CUSTOM:
        if (!isDay(r.from) || !isDay(r.to) || r.from > r.to) return null;
        from = r.from; to = r.to;
        break;
      default: return null;
    }
    return { preset:r.preset, from:from, to:to, today:today,
             days:Math.round((utcOf(to) - utcOf(from)) / 86400000) + 1 };
  }

  /* ══════════════════════════════════════════════════════════════
     ONE ORDER — its captured lines, what left the order, what was refunded
     ══════════════════════════════════════════════════════════════ */
  function statusOf(o){
    if (o.status === 'cancelled') return 'cancelled';
    if (o.status === 'delivered') return 'delivered';
    var E = global.RAFOrderEngine;
    if (E && E.mstate && E.MSTATE && E.mstate(o.id) === E.MSTATE.PENDING) return 'awaiting';
    return 'progress';
  }

  function readOrder(o, slug, ec){
    var s = o.snapshot;
    if (!s || s.storeSlug !== slug) return null;                 /* defence in depth */
    if (typeof s.checkoutAt !== 'number' || !s.items || !s.items.length)
      return { excluded:true, id:o.id, reason:'no_checkout_record' };
    /* a line from another store would be someone else's data — never shown */
    for (var q = 0; q < s.items.length; q++)
      if (s.items[q].storeSlug && s.items[q].storeSlug !== slug)
        return { excluded:true, id:o.id, reason:'line_store_mismatch' };

    var issues = [];
    var live = o.items || [];
    var lines = s.items.map(function (it, i) {
      var qty  = parseInt(it.qty, 10) || 0;
      var unit = fils(it.unitPrice), disc = fils(it.discount), fin = fils(it.finalPrice);
      if (unit === null || fin === null || qty <= 0) issues.push('line_money_unrecorded');
      unit = unit || 0; disc = disc || 0;
      var gross = unit * qty;
      if (fin !== null && fin !== gross - disc) issues.push('line_final_mismatch');

      /* the live invoice line at the same position, proven to be the same
         product (a replaced line remembers what it replaced) */
      var l = live[i];
      var same = !!(l && (l.replacedFrom || l.id) === it.productId);
      var source = null;
      if (disc > 0) {
        source = (same && (l.discountSource === 'promotion' || l.discountSource === 'coupon'))
          ? l.discountSource : 'unattributed';
      }
      /* who funded the discount is the settlement authority's classification */
      var el = (ec && ec.lines && ec.lines[i] && ec.lines[i].productId === it.productId) ? ec.lines[i] : null;
      return {
        index:i, productId:it.productId,
        funding:el ? el.funding : null,
        merchantDiscount:el ? el.merchantDiscount : 0, rafDiscount:el ? el.rafDiscount : 0,
        name:{ ar:it.nameAr || it.nameEn || it.productId, en:it.nameEn || it.nameAr || it.productId },
        variant:it.variant || {}, qty:qty, unit:unit, gross:gross, discount:disc, source:source,
        refund:0,
        removed:!!(same && l.removed),
        replacement:(same && l.replacedFrom) ? { id:l.id, name:l.name || null } : null
      };
    });

    /* refunds that were actually issued — the change record holds the result */
    var refunds = [];
    (RAFOrderChanges.historyOf(o.id) || []).forEach(function (c) {
      if (!c || !c.refundDone || !c.refundResult) return;
      var line = lines[c.lineIndex];
      if (!line || line.productId !== c.productId) { issues.push('refund_line_unmatched'); return; }
      var amt = fils(c.refundResult.amount);
      if (amt === null) { issues.push('refund_money_unrecorded'); return; }
      line.refund += amt;
      refunds.push({ orderId:o.id, changeId:c.id, kind:c.kind, productId:c.productId, name:line.name,
                     amount:amt, destination:c.refundResult.destination || c.refundDestination || null,
                     at:c.appliedAt || c.decidedAt || null });
    });

    var t = { gross:0, discount:0, promotion:0, coupon:0, unattributed:0, refund:0, net:0, units:0,
              merchantDiscount:0, rafDiscount:0, fundingUnknown:0 };
    lines.forEach(function (l) {
      l.units = l.removed ? 0 : l.qty;            /* a removed line was never delivered */
      l.net = l.gross - l.discount - l.refund;
      t.gross += l.gross; t.discount += l.discount; t.refund += l.refund;
      if (l.source) t[l.source] += l.discount;
      t.merchantDiscount += l.merchantDiscount; t.rafDiscount += l.rafDiscount;
      if (l.discount > 0 && !l.funding) t.fundingUnknown += l.discount;
      t.units += l.units;
    });
    t.net = t.gross - t.discount - t.refund;

    var c0 = s.commercial || {};
    return {
      id:o.id, at:s.checkoutAt,
      day:RAFMarketing.dateOfInstant(s.checkoutAt), time:RAFMarketing.timeOfInstant(s.checkoutAt),
      status:statusOf(o),
      coupon:(c0.coupon || o.coupon || '').toString().toUpperCase() || null,
      payment:c0.paymentStatus || null,
      lines:lines, totals:t, refunds:refunds, issues:issues
    };
  }

  /* ══════════════════════════════════════════════════════════════
     AGGREGATION
     ══════════════════════════════════════════════════════════════ */
  function zero(){ return { orders:0, gross:0, discount:0, promotion:0, coupon:0, unattributed:0,
                            refund:0, net:0, units:0, merchantDiscount:0, rafDiscount:0, fundingUnknown:0 }; }
  function addTotals(into, t){
    into.merchantDiscount += t.merchantDiscount; into.rafDiscount += t.rafDiscount;
    into.fundingUnknown += t.fundingUnknown;
    into.gross += t.gross; into.discount += t.discount; into.promotion += t.promotion;
    into.coupon += t.coupon; into.unattributed += t.unattributed; into.refund += t.refund;
    into.net += t.net; into.units += t.units;
  }
  function addLine(into, l){
    into.gross += l.gross; into.discount += l.discount; into.refund += l.refund;
    into.net += l.net; into.units += l.units;
  }

  /* the trend's buckets: every day of the range, or every month when the
     range is too long for daily bars to stay readable */
  function buckets(range){
    var out = [], byKey = {};
    var monthly = range.days > 92;
    var d = range.from;
    while (d <= range.to) {
      var key = monthly ? d.slice(0, 7) : d;
      if (!byKey[key]) { byKey[key] = { key:key, monthly:monthly, orders:0, gross:0, discount:0, refund:0, net:0 };
                         out.push(byKey[key]); }
      d = shiftDay(d, 1);
    }
    return { list:out, of:function (day) { return byKey[monthly ? day.slice(0, 7) : day] || null; } };
  }

  function build(opts){
    opts = opts || {};
    if (scopeFieldSupplied(opts)) return fail('FIELD_NOT_ACCEPTED');
    var ctx = context(); if (!ctx.ok) return ctx;
    var range = resolveRange(opts.range); if (!range) return fail('INVALID_RANGE');
    var slug = ctx.slug;

    /* ---- the store's orders, read once ---- */
    var inRange = [], undated = 0, withIssues = 0;
    var EC = RAFSettlement.orderEconomics();
    var ecById = EC.ok ? EC.byId : {};
    RAFOrderSnapshot.forStore(slug).forEach(function (o) {
      var r = readOrder(o, slug, ecById[o.id]);
      if (!r) return;
      if (r.excluded) { undated++; return; }
      if (r.day < range.from || r.day > range.to) return;
      if (r.issues.length) withIssues++;
      inRange.push(r);
    });
    inRange.sort(function (a, b) { return b.at - a.at; });

    /* a cancelled order was never a sale: it is counted, not summed */
    var sales = inRange.filter(function (o) { return o.status !== 'cancelled'; });

    var sum = zero();
    sales.forEach(function (o) { addTotals(sum, o.totals); });
    sum.orders = sales.length;
    sum.aov = sum.orders ? Math.round(sum.net / sum.orders) : 0;

    /* ---- status of every order placed in the range ---- */
    var status = { awaiting:0, progress:0, delivered:0, cancelled:0, total:inRange.length };
    inRange.forEach(function (o) { status[o.status]++; });

    /* ---- trend ---- */
    var B = buckets(range);
    sales.forEach(function (o) {
      var b = B.of(o.day); if (!b) return;
      b.orders++; b.gross += o.totals.gross; b.discount += o.totals.discount;
      b.refund += o.totals.refund; b.net += o.totals.net;
    });

    /* ---- by product (historical: the name the order captured) ---- */
    var cats = {};
    RAFCatalog.categories({ populatedOnly:false }).forEach(function (c) { cats[c.k] = c; });
    function catOf(pid){
      var p = RAFCatalog.get(pid);
      return (p && p.cat && cats[p.cat]) ? p.cat : null;
    }
    var prod = {}, cat = {};
    sales.forEach(function (o) {
      o.lines.forEach(function (l) {
        var p = prod[l.productId];
        if (!p) {
          p = prod[l.productId] = { id:l.productId, name:l.name, category:catOf(l.productId),
                                    orders:0, _o:{}, gross:0, discount:0, refund:0, net:0, units:0 };
        }
        addLine(p, l);
        if (!p._o[o.id]) { p._o[o.id] = 1; p.orders++; }
        var ck = p.category || 'uncategorised';
        var c = cat[ck];
        if (!c) {
          c = cat[ck] = { key:ck, label:cats[ck] ? { ar:cats[ck].ar, en:cats[ck].en } : null,
                          icon:cats[ck] ? cats[ck].ic : 'ti-tag', orders:0, _o:{},
                          gross:0, discount:0, refund:0, net:0, units:0 };
        }
        addLine(c, l);
        if (!c._o[o.id]) { c._o[o.id] = 1; c.orders++; }
      });
    });
    function strip(m){ return Object.keys(m).map(function (k) { var x = m[k]; delete x._o; return x; }); }
    var byProduct  = strip(prod).sort(function (a, b) { return b.net - a.net || b.units - a.units; });
    var byCategory = strip(cat).sort(function (a, b) { return b.net - a.net; });

    /* ---- promotions ----
       The discount amount is the captured line value. Which promotion produced
       it is resolved from RAFMarketing: the store's promotion whose window
       contained the order's Kuwait date and which covers the product. RAF
       refuses overlapping promotions per store, so there is normally exactly
       one; anything else is reported as unattributed rather than guessed. */
    var promos = RAFMarketing.promotions({ storeSlug:slug });
    var promoRows = {}, promoUnattributed = { discount:0, orders:0, _o:{}, units:0 };
    promos.forEach(function (p) {
      if (p.startDate && p.endDate && p.startDate <= range.to && p.endDate >= range.from) {
        promoRows[p.id] = { id:p.id, name:p.name, value:p.value, startDate:p.startDate, endDate:p.endDate,
                            status:p.status, discount:0, orders:0, _o:{}, units:0, net:0 };
      }
    });
    sales.forEach(function (o) {
      o.lines.forEach(function (l) {
        if (l.source !== 'promotion') return;
        var hits = promos.filter(function (p) {
          return p.startDate && p.endDate && p.startDate <= o.day && o.day <= p.endDate
              && RAFMarketing.promotionCovers(p, l.productId);
        });
        var row = hits.length === 1 ? promoRows[hits[0].id] : null;
        if (hits.length === 1 && !row) {
          var h = hits[0];
          row = promoRows[h.id] = { id:h.id, name:h.name, value:h.value, startDate:h.startDate,
                                    endDate:h.endDate, status:h.status, discount:0, orders:0, _o:{}, units:0, net:0 };
        }
        var into = row || promoUnattributed;
        into.discount += l.discount; into.units += l.units;
        if (row) row.net += l.net;
        if (!into._o[o.id]) { into._o[o.id] = 1; into.orders++; }
      });
    });
    delete promoUnattributed._o;

    /* ---- coupons — attributed by the code the order captured ---- */
    var cpn = {};
    sales.forEach(function (o) {
      if (!o.coupon) return;
      var c = cpn[o.coupon];
      if (!c) {
        var rec = RAFMarketing.byCode(o.coupon);
        c = cpn[o.coupon] = { code:o.coupon, name:rec ? rec.name : null, platform:!!(rec && !rec.storeSlug),
                              orders:0, discount:0, net:0 };
      }
      c.orders++; c.discount += o.totals.coupon; c.net += o.totals.net;
    });

    /* ---- advertisements — the records exist; performance is not tracked ---- */
    var ads = RAFMarketing.ads({ storeSlug:slug }).map(function (a) {
      return { id:a.id, title:a.title, status:a.status, startDate:a.startDate, endDate:a.endDate };
    });

    /* ---- payment status, as the order captured it ---- */
    var pay = {};
    sales.forEach(function (o) {
      var k = o.payment || 'not_recorded';
      if (!pay[k]) pay[k] = { key:k, orders:0, net:0 };
      pay[k].orders++; pay[k].net += o.totals.net;
    });

    /* ---- refunds issued on this range's orders ---- */
    var refunds = [];
    sales.forEach(function (o) { refunds = refunds.concat(o.refunds); });
    refunds.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });

    return {
      ok:true,
      store:{ slug:slug, name:ctx.store.name, logo:ctx.store.logo || '' },
      canExport:ctx.canExport,
      range:range,
      generatedAt:Date.now(),
      summary:sum,
      status:status,
      trend:B.list,
      orders:inRange,
      byProduct:byProduct,
      byCategory:byCategory,
      marketing:{
        promotions:Object.keys(promoRows).map(function (k) { var r = promoRows[k]; delete r._o; return r; })
                     .sort(function (a, b) { return b.discount - a.discount; }),
        promotionUnattributed:promoUnattributed,
        coupons:Object.keys(cpn).map(function (k) { return cpn[k]; })
                  .sort(function (a, b) { return b.discount - a.discount; }),
        ads:ads,
        adTracking:false
      },
      payments:Object.keys(pay).map(function (k) { return pay[k]; }),
      refunds:refunds,
      /* commission, entitlement, settlement and payouts are RAFSettlement's */
      quality:{ undated:undated, withIssues:withIssues }
    };
  }

  /* ══════════════════════════════════════════════════════════════
     INVENTORY — current stock, straight from RAFInventory
     ══════════════════════════════════════════════════════════════ */
  function optionLabel(o){
    if (!o) return { ar:'', en:'' };
    if (o.label && typeof o.label === 'object') return { ar:o.label.ar || o.label.en || String(o.v), en:o.label.en || o.label.ar || String(o.v) };
    return { ar:String(o.v), en:String(o.v) };
  }
  function inventory(opts){
    if (scopeFieldSupplied(opts)) return fail('FIELD_NOT_ACCEPTED');
    var ctx = context(); if (!ctx.ok) return ctx;
    var rows = RAFCatalog.list({ visibleOnly:false, store:ctx.slug }).filter(function (p) {
      return p.slug === ctx.slug;                       /* the catalogue's own store link */
    }).map(function (p) {
      var name = { ar:p.ar || (p.name && p.name.ar) || p.id, en:p.en || (p.name && p.name.en) || p.id };
      if (RAFInventory.isCombinationMode(p.id)) {
        var combos = RAFInventory.combinationsOf(p.id).filter(function (c) { return c.configured; })
          .map(function (c) {
            var parts = (c.options || []).map(optionLabel);
            return { id:c.id,
                     label:{ ar:parts.map(function (x) { return x.ar; }).join(' / '),
                             en:parts.map(function (x) { return x.en; }).join(' / ') },
                     onHand:c.onHand, reserved:c.reserved, available:c.available };
          });
        return { id:p.id, name:name, mode:'combination', combos:combos,
                 onHand:combos.reduce(function (s, c) { return s + c.onHand; }, 0),
                 reserved:combos.reduce(function (s, c) { return s + c.reserved; }, 0),
                 available:combos.reduce(function (s, c) { return s + c.available; }, 0),
                 outCombos:combos.filter(function (c) { return c.available === 0; }).length };
      }
      return { id:p.id, name:name, mode:'product', combos:[],
               onHand:RAFInventory.onHand(p.id), reserved:RAFInventory.reserved(p.id),
               available:RAFInventory.available(p.id), outCombos:0 };
    });
    return { ok:true, canExport:ctx.canExport, rows:rows, generatedAt:Date.now() };
  }

  global.RAFAnalytics = {
    PRESET:PRESET, ERRORS:ERRORS,
    context:context, resolveRange:resolveRange,
    build:build, inventory:inventory
  };
})(window);
