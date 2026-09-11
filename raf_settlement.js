/* ============================================================================
 * RAF Marketplace — COMMISSION & SETTLEMENT AUTHORITY  (shared, headless)
 * ----------------------------------------------------------------------------
 * The one place that decides how much of a store's sales RAF keeps and how
 * much RAF owes the merchant. Pages only read the answers.
 *
 *   Customer payment → RAF-held funds → sales → discount classification →
 *   commission → merchant entitlement → monthly settlement → (payout)
 *
 * WHAT IT OWNS
 *   · The commission-rate schedule — append-only. A new rate may only take
 *     effect from the start of a FUTURE Kuwait month, so no transaction that
 *     already exists — not even one from the current month — is ever priced
 *     at a rate it was not placed under.
 *   · The commission base of every order line.
 *   · Monthly accounting periods (Asia/Kuwait) and their close. A closed
 *     period is written once and never rewritten.
 *   · Adjustments: when an order of an already-closed month changes (a
 *     refund, a cancellation), the difference lands in the OPEN month, at the
 *     rate of the month the order belonged to. The closed month stays as it
 *     was closed.
 *
 * THE COMMISSION BASE (per order line, integer fils)
 *   gross G, captured discount D, funding of that discount:
 *     merchant-funded  → reduces the base         base = G − D
 *     RAF-funded       → does not reduce the base base = G
 *   Commission follows the goods: a removed line leaves the base entirely; a
 *   replaced line is settled at the replacement's recorded payable value.
 *   The month's commission is rounded ONCE, on the month's total base, so a
 *   merchant can verify it: commission = base × rate.
 *
 * WHAT IT DOES NOT DO
 *   · It never prices anything and never repriced history: every value is the
 *     one captured at checkout, or recorded by an approved change.
 *   · It never creates a payout. RAF has no payout system; payout status is
 *     reported as not configured, never simulated.
 *   · It never deletes. "A new month" means the previous one is closed.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFSettlement) return;

  var LS_RATES = 'raf_commission_rates';
  var LS_STL   = 'raf_settlements';
  var BP       = 10000;          /* rates are held in basis points: 1000 = 10% */
  /* the rate the schedule starts with. It is written into the schedule once;
     from then on the schedule — not this constant — is the authority. */
  var INITIAL_RATE_BP = 1000;

  /* open    — the current month, figures still moving
     settled — closed, and every order in it was settled
     closed  — closed, but some orders could not be settled from their
               records and are listed for review (never guessed)
     empty   — an ended month with no activity: kept internally so it is never
               reopened, never shown as a statement
     none    — no accounting period exists for that month */
  var STATUS = { OPEN:'open', SETTLED:'settled', CLOSED:'closed', EMPTY:'empty', NONE:'none' };
  var PAYOUT = { NOT_CONFIGURED:'not_configured' };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }

  var ERRORS = {
    FORBIDDEN:          { ar:'ليس لديك صلاحية لهذا الإجراء.',              en:'You do not have permission for this action.' },
    NO_STORE:           { ar:'لا يوجد متجر مرتبط بهذا الحساب.',             en:'This account is not linked to a store.' },
    STORE_NOT_FOUND:    { ar:'المتجر المرتبط غير موجود.',                   en:'The linked store could not be found.' },
    FIELD_NOT_ACCEPTED: { ar:'المتجر يُحدَّد تلقائياً من حسابك.',           en:'The store is taken from your account automatically.' },
    INVALID_PERIOD:     { ar:'الفترة المحاسبية غير صالحة.',                 en:'The accounting period is not valid.' },
    PERIOD_NOT_FUTURE:  { ar:'لا يمكن أن تسري النسبة إلا من بداية شهر قادم.', en:'A rate can only take effect from the start of a future month.' },
    INVALID_RATE:       { ar:'نسبة العمولة غير صالحة.',                     en:'The commission rate is not valid.' },
    PERSIST_FAILED:     { ar:'تعذّر الحفظ.',                                en:'Could not save.' },
    AUTHORITY_MISSING:  { ar:'تعذّر الوصول إلى بيانات رف.',                 en:'RAF data could not be reached.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  var NEEDS = ['RAFPerm', 'RAFOrderSnapshot', 'RAFOrderChanges', 'RAFMarketing', 'RAFWallet'];
  function missing(){ return NEEDS.filter(function (n) { return !global[n]; }); }

  /* ---------- money: integer fils, one rounding rule ---------- */
  function fils(v){
    if (v === null || v === undefined || v === '') return null;
    return RAFWallet.toMinor(v);
  }
  /* half away from zero, so a negative adjustment rounds like its positive twin */
  function roundDiv(n, d){ var s = n < 0 ? -1 : 1; return s * Math.round(Math.abs(n) / d); }
  function commissionOf(base, bp){ return roundDiv(base * bp, BP); }

  /* ---------- Kuwait accounting periods ('YYYY-MM') ---------- */
  function isPeriod(p){ return typeof p === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(p); }
  function currentPeriod(){ return RAFMarketing.todayISO().slice(0, 7); }
  function nextPeriod(p){
    var y = +p.slice(0, 4), m = +p.slice(5, 7) + 1;
    if (m > 12) { m = 1; y++; }
    return y + '-' + (m < 10 ? '0' : '') + m;
  }
  function lastDayOf(p){ return new Date(Date.UTC(+p.slice(0, 4), +p.slice(5, 7), 0)).getUTCDate(); }

  /* ---------- storage ---------- */
  function readJSON(k, d){ try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  /* a financial write that silently failed would be a lie, so this throws */
  function writeJSON(k, v){ localStorage.setItem(k, JSON.stringify(v)); }
  function emit(detail){
    try { document.dispatchEvent(new CustomEvent('raf:settlement', { detail:detail || {} })); } catch (e) {}
  }
  function audit(opts){
    if (!global.RAFAudit) return;
    try { RAFAudit.record(opts); } catch (e) {}
  }

  /* ══════════════════════════════════════════════════════════════
     SCOPE — the signed-in account and its store, never a caller's claim
     ══════════════════════════════════════════════════════════════ */
  function context(){
    var miss = missing();
    if (miss.length) return fail('AUTHORITY_MISSING', { missing:miss });
    var user = RAFPerm.currentUser();
    if (!user || !RAFPerm.can(user, 'reports.view')) return fail('FORBIDDEN');
    var link = RAFPerm.storeLinkOf(user);
    if (!link.ok) return fail(link.reason === 'store_not_found' ? 'STORE_NOT_FOUND' : 'NO_STORE');
    return { ok:true, userId:user.id, slug:link.slug, store:link.store,
             canExport:RAFPerm.can(user, 'reports.export') };
  }
  function scopeFieldSupplied(opts){
    if (!opts || typeof opts !== 'object') return false;
    return ['storeSlug', 'store', 'slug', 'actor', 'user', 'userId'].some(function (k) { return opts[k] !== undefined; });
  }

  /* ══════════════════════════════════════════════════════════════
     COMMISSION RATE SCHEDULE — append-only
     ══════════════════════════════════════════════════════════════ */
  function schedule(){
    var o = readJSON(LS_RATES, null);
    if (!o || !Array.isArray(o.schedule) || !o.schedule.length) {
      /* seeded once. `effectiveFrom: null` means "from the beginning". */
      o = { schedule:[ { id:'RATE-INITIAL', rateBp:INITIAL_RATE_BP, effectiveFrom:null,
                         createdAt:Date.now(), createdBy:null } ] };
      try { writeJSON(LS_RATES, o); } catch (e) {}
    }
    return o.schedule.slice();
  }
  /* the later effective month wins; within one month, the later entry */
  function supersedes(a, b){
    var af = a.effectiveFrom || '', bf = b.effectiveFrom || '';
    if (af !== bf) return af > bf;
    return (a.createdAt || 0) > (b.createdAt || 0);
  }
  function rateEntryFor(period){
    var best = null;
    schedule().forEach(function (e) {
      if ((e.effectiveFrom === null || e.effectiveFrom <= period) && (!best || supersedes(e, best))) best = e;
    });
    return best;
  }
  function percentText(bp){ return (bp / 100).toFixed(2).replace(/\.?0+$/, ''); }
  function publicRate(e){
    return e ? { id:e.id, rateBp:e.rateBp, percent:percentText(e.rateBp), effectiveFrom:e.effectiveFrom } : null;
  }
  function toBp(percent){
    var n = typeof percent === 'string' && percent.trim() !== '' ? Number(percent) : percent;
    if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > 100) return null;
    var bp = n * 100, r = Math.round(bp);
    return Math.abs(bp - r) > 1e-6 ? null : r;          /* at most two decimals */
  }
  /* RAF changes the rate. It takes effect from the first day of a future
     month and never touches a month that has already begun. */
  function scheduleRate(percent, effectiveFrom){
    var miss = missing(); if (miss.length) return fail('AUTHORITY_MISSING', { missing:miss });
    var user = RAFPerm.currentUser();
    if (!user || !RAFPerm.can(user, 'settings.edit')) return fail('FORBIDDEN');
    if (!isPeriod(effectiveFrom)) return fail('INVALID_PERIOD');
    if (effectiveFrom <= currentPeriod()) return fail('PERIOD_NOT_FUTURE', { current:currentPeriod() });
    var bp = toBp(percent); if (bp === null) return fail('INVALID_RATE');

    schedule();                                           /* make sure the seed exists */
    var o = readJSON(LS_RATES, { schedule:[] });
    var e = { id:'RATE-' + effectiveFrom + '-' + Date.now(), rateBp:bp, effectiveFrom:effectiveFrom,
              createdAt:Date.now(), createdBy:user.id };
    o.schedule.push(e);
    try { writeJSON(LS_RATES, o); } catch (x) { return fail('PERSIST_FAILED'); }
    audit({ action:'commission.rate_scheduled', key:e.id, source:'admin',
            actor:{ id:user.id, name:user.name || user.id },
            metadata:{ rateBp:bp, percent:percentText(bp), effectiveFrom:effectiveFrom } });
    emit({ kind:'rate' });
    return { ok:true, entry:publicRate(e) };
  }
  function rateSchedule(){
    return schedule().sort(function (a, b) { return supersedes(a, b) ? 1 : -1; }).map(publicRate);
  }

  /* ══════════════════════════════════════════════════════════════
     ONE ORDER — the commission base of every line
     ══════════════════════════════════════════════════════════════ */
  /* who funded a line's discount: captured at checkout; for orders placed
     before that was captured, the record the order itself points to */
  function fundingOfLine(o, s, live, it, day){
    var M = RAFMarketing;
    if (live && (live.discountFunding === 'merchant' || live.discountFunding === 'raf')) return live.discountFunding;
    var src = live && live.discountSource;
    if (src === 'coupon') {
      var code = (s.commercial && s.commercial.coupon) || o.coupon;
      var rec = code ? M.byCode(code) : null;
      return rec ? M.fundingOf(rec) : null;
    }
    if (src === 'promotion') {
      if (live.discountRef) { var r = M.byId(live.discountRef); if (r) return M.fundingOf(r); }
      /* RAF refuses overlapping promotions per store, so at most one can have
         applied; anything else stays unresolved rather than guessed */
      var hits = M.promotions({ storeSlug:s.storeSlug }).filter(function (p) {
        return p.startDate && p.endDate && p.startDate <= day && day <= p.endDate && M.promotionCovers(p, it.productId);
      });
      return hits.length === 1 ? M.fundingOf(hits[0]) : null;
    }
    return null;
  }

  var SUMS = ['gross', 'merchantDiscount', 'rafDiscount', 'removedValue', 'commissionable', 'rafBorne', 'refundedToCustomer'];
  function zeroSums(){ var z = {}; SUMS.forEach(function (k) { z[k] = 0; }); return z; }

  function economics(o){
    var s = o && o.snapshot;
    if (!s || !s.storeSlug) return null;
    var out = { id:o.id, storeSlug:s.storeSlug, cancelled:o.status === 'cancelled',
                day:null, period:null, lines:[], totals:zeroSums(), unresolved:[] };
    if (typeof s.checkoutAt !== 'number' || !s.items || !s.items.length) {
      out.unresolved.push('no_checkout_record');
      return out;
    }
    out.day = RAFMarketing.dateOfInstant(s.checkoutAt);
    out.period = out.day.slice(0, 7);
    var live = o.items || [];
    var changes = RAFOrderChanges.historyOf(o.id) || [];

    s.items.forEach(function (it, i) {
      if (it.storeSlug && it.storeSlug !== s.storeSlug) out.unresolved.push('line_store_mismatch');
      var qty = parseInt(it.qty, 10) || 0, unit = fils(it.unitPrice), D = fils(it.discount);
      if (unit === null || qty <= 0) { out.unresolved.push('line_money_unrecorded'); unit = 0; }
      if (D === null) { out.unresolved.push('line_money_unrecorded'); D = 0; }
      var G = unit * qty;

      var l = live[i];
      var same = !!(l && (l.replacedFrom || l.id) === it.productId);
      var f = D > 0 ? fundingOfLine(o, s, same ? l : null, it, out.day) : null;
      if (D > 0 && !f) out.unresolved.push('discount_funding_unrecorded');
      var Dm = f === 'merchant' ? D : 0, Dr = f === 'raf' ? D : 0;

      var removed = !!(same && l.removed), replaced = !!(same && l.replacedFrom);
      var refunded = 0, R = null;
      changes.forEach(function (c) {
        if (!c || c.lineIndex !== i || c.productId !== it.productId) return;
        if (c.refundDone && c.refundResult) {
          var a = fils(c.refundResult.amount);
          if (a === null) out.unresolved.push('refund_money_unrecorded'); else refunded += a;
        }
        if (c.kind === 'replacement' && c.invoiceDone) R = fils(c.replacementPayable);
      });
      if (replaced && R === null) out.unresolved.push('replacement_value_unrecorded');

      /* commission follows the goods */
      var C = removed ? 0 : replaced ? (R || 0) : (G - Dm);
      var line = {
        index:i, productId:it.productId,
        name:{ ar:it.nameAr || it.nameEn || it.productId, en:it.nameEn || it.nameAr || it.productId },
        qty:qty, gross:G, discount:D, funding:f,
        merchantDiscount:Dm, rafDiscount:Dr,
        removed:removed, replaced:replaced, replacementValue:R,
        removedValue:(G - Dm) - C,            /* goods value that left the base */
        commissionable:C,
        rafBorne:(removed || replaced) ? 0 : Dr,
        refundedToCustomer:refunded
      };
      out.lines.push(line);
      SUMS.forEach(function (k) { out.totals[k] += line[k]; });
    });
    out.unresolved = out.unresolved.filter(function (x, i, a) { return a.indexOf(x) === i; });
    return out;
  }
  /* what one order contributes to settlement right now */
  function contribution(e){ return (e.cancelled || e.unresolved.length) ? 0 : e.totals.commissionable; }

  /* ══════════════════════════════════════════════════════════════
     PERIODS
     ══════════════════════════════════════════════════════════════ */
  function storeEconomics(slug){
    return RAFOrderSnapshot.forStore(slug).map(economics).filter(function (e) { return e && e.storeSlug === slug; });
  }
  function readSettlements(){ var o = readJSON(LS_STL, {}); return (o && typeof o === 'object') ? o : {}; }

  /* what an already-settled order has been counted at so far: its closed
     month, plus every adjustment later months have already made to it */
  function baselineOf(orderId, fromPeriod, uptoExclusive, closed){
    var rec = closed[fromPeriod];
    var base = (rec && rec.orders && rec.orders[orderId]) ? rec.orders[orderId].commissionable : 0;
    Object.keys(closed).forEach(function (k) {
      if (k <= fromPeriod || k >= uptoExclusive) return;
      (closed[k].adjustments || []).forEach(function (a) { if (a.orderId === orderId) base += a.commissionable; });
    });
    return base;
  }

  function computePeriod(slug, P, econ, closed){
    var rateE = rateEntryFor(P);
    var bp = rateE ? rateE.rateBp : null;
    var f = zeroSums(); f.orders = 0;
    var perOrder = {}, unresolved = [], cancelled = 0;
    econ.forEach(function (e) {
      if (e.period !== P) return;
      if (e.cancelled) { cancelled++; return; }
      if (e.unresolved.length) { unresolved.push({ orderId:e.id, reasons:e.unresolved.slice() }); return; }
      f.orders++;
      SUMS.forEach(function (k) { f[k] += e.totals[k]; });
      var po = {}; SUMS.forEach(function (k) { po[k] = e.totals[k]; });
      perOrder[e.id] = po;
    });
    f.commission  = bp === null ? null : commissionOf(f.commissionable, bp);
    f.entitlement = f.commission === null ? null : f.commissionable - f.commission;

    /* orders of earlier, already-closed months that have changed since */
    var adj = [], at = { commissionable:0, commission:0, entitlement:0 };
    econ.forEach(function (e) {
      if (!e.period || e.period >= P || !closed[e.period]) return;
      var d = contribution(e) - baselineOf(e.id, e.period, P, closed);
      if (!d) return;
      var r = closed[e.period].rateBp;                 /* the rate that order was settled at */
      var dk = commissionOf(d, r);
      var a = { orderId:e.id, fromPeriod:e.period, rateBp:r, commissionable:d, commission:dk,
                entitlement:d - dk, reason:e.cancelled ? 'order_cancelled' : 'order_changed' };
      adj.push(a);
      at.commissionable += d; at.commission += dk; at.entitlement += d - dk;
    });

    return { period:P, rateBp:bp, figures:f, cancelledOrders:cancelled, orders:perOrder,
             adjustments:adj, adjustmentsTotal:at,
             settlementAmount:f.entitlement === null ? null : f.entitlement + at.entitlement,
             unresolved:unresolved };
  }

  /* Every month of the store's activity that has ended is closed, oldest
     first, exactly once. Idempotent: a closed month is never recomputed. */
  /* `preview` — compute the same closures in memory, persist nothing (no
     write, no audit, no event), for read-only surfaces */
  function ensureClosed(slug, preview){
    var cur = currentPeriod();
    var econ = storeEconomics(slug);
    var first = null;
    econ.forEach(function (e) { if (e.period && (!first || e.period < first)) first = e.period; });
    var mine = readSettlements()[slug] || {};
    if (!first || first >= cur) return { econ:econ, closed:mine, closedNow:[] };

    var closedNow = [];
    for (var P = first; P < cur; P = nextPeriod(P)) {
      if (mine[P]) continue;
      var c = computePeriod(slug, P, econ, mine);
      var hasData = c.figures.orders || c.cancelledOrders || c.adjustments.length || c.unresolved.length;
      mine[P] = {
        id:'STL-' + slug + '-' + P, storeSlug:slug, period:P,
        status:!hasData ? STATUS.EMPTY : (c.unresolved.length ? STATUS.CLOSED : STATUS.SETTLED),
        closedAt:Date.now(), closedBy:'system', currency:'KWD',
        rateBp:c.rateBp, figures:c.figures, cancelledOrders:c.cancelledOrders,
        orders:c.orders, adjustments:c.adjustments, adjustmentsTotal:c.adjustmentsTotal,
        settlementAmount:c.settlementAmount, unresolved:c.unresolved,
        payout:{ status:PAYOUT.NOT_CONFIGURED }
      };
      closedNow.push(P);
    }
    if (closedNow.length && !preview) {
      /* re-read just before writing: only this store's missing months are added */
      var all = readSettlements();
      var stored = all[slug] || {};
      closedNow = closedNow.filter(function (p) { return !stored[p]; });
      closedNow.forEach(function (p) { stored[p] = mine[p]; });
      all[slug] = stored;
      try { writeJSON(LS_STL, all); } catch (x) { return { econ:econ, closed:readSettlements()[slug] || {}, closedNow:[], error:'PERSIST_FAILED' }; }
      closedNow.forEach(function (p) {
        var r = stored[p];
        if (r.status === STATUS.EMPTY) return;          /* nothing happened that month */
        audit({ action:'settlement.closed', key:r.id, storeSlug:slug, source:'system',
                systemGenerated:true, automatic:true,
                metadata:{ settlementId:r.id, period:p, rateBp:r.rateBp,
                           commissionable:r.figures.commissionable, commission:r.figures.commission,
                           settlementAmount:r.settlementAmount } });
      });
      mine = stored;
      emit({ kind:'closed', periods:closedNow });
    }
    return { econ:econ, closed:mine, closedNow:closedNow };
  }

  /* ══════════════════════════════════════════════════════════════
     READ API — the signed-in merchant's own store only
     ══════════════════════════════════════════════════════════════ */
  function orderRows(perOrder, econ){
    var byId = {}; econ.forEach(function (e) { byId[e.id] = e; });
    return Object.keys(perOrder).map(function (id) {
      var row = { id:id, day:byId[id] ? byId[id].day : null };
      SUMS.forEach(function (k) { row[k] = perOrder[id][k]; });
      return row;
    }).sort(function (a, b) { return (b.day || '') < (a.day || '') ? -1 : 1; });
  }
  function shape(src, status, econ){
    return {
      period:src.period, status:status,
      from:src.period + '-01', to:src.period + '-' + lastDayOf(src.period),
      closedAt:src.closedAt || null, settlementId:src.id || null,
      rate:src.rateBp === null ? null : { rateBp:src.rateBp, percent:percentText(src.rateBp) },
      figures:src.figures, cancelledOrders:src.cancelledOrders,
      adjustments:src.adjustments, adjustmentsTotal:src.adjustmentsTotal,
      settlementAmount:src.settlementAmount, unresolved:src.unresolved,
      payout:{ status:PAYOUT.NOT_CONFIGURED },
      orders:orderRows(src.orders || {}, econ)
    };
  }

  /* every accounting month of the store: the open one live, the closed ones
     exactly as they were closed */
  function periods(opts){
    if (scopeFieldSupplied(opts)) return fail('FIELD_NOT_ACCEPTED');
    var ctx = context(); if (!ctx.ok) return ctx;
    var st = ensureClosed(ctx.slug);
    var cur = currentPeriod();
    var list = [ shape(computePeriod(ctx.slug, cur, st.econ, st.closed), STATUS.OPEN, st.econ) ];
    /* only months that actually had activity are statements */
    Object.keys(st.closed).sort().reverse().forEach(function (p) {
      var rec = st.closed[p];
      if (rec.status === STATUS.EMPTY) return;
      list.push(shape(rec, rec.status, st.econ));
    });
    return { ok:true, current:cur, periods:list, rate:publicRate(rateEntryFor(cur)),
             canExport:ctx.canExport, payoutSystem:false };
  }
  function statement(period, opts){
    if (scopeFieldSupplied(opts)) return fail('FIELD_NOT_ACCEPTED');
    var ctx = context(); if (!ctx.ok) return ctx;
    var cur = currentPeriod();
    if (!isPeriod(period) || period > cur) return fail('INVALID_PERIOD');
    var st = ensureClosed(ctx.slug);
    if (period === cur) return Object.assign({ ok:true, canExport:ctx.canExport },
      shape(computePeriod(ctx.slug, cur, st.econ, st.closed), STATUS.OPEN, st.econ));
    var rec = st.closed[period];
    if (rec && rec.status !== STATUS.EMPTY) return Object.assign({ ok:true, canExport:ctx.canExport },
      shape(rec, rec.status, st.econ));
    /* a month with no activity, or before the store's first order */
    return { ok:true, canExport:ctx.canExport, period:period, status:STATUS.NONE,
             from:period + '-01', to:period + '-' + lastDayOf(period), payout:{ status:PAYOUT.NOT_CONFIGURED } };
  }
  /* the line-level classification for the store's orders, for the reporting
     layer — keyed by order id, so no page classifies a discount itself */
  function orderEconomics(opts){
    if (scopeFieldSupplied(opts)) return fail('FIELD_NOT_ACCEPTED');
    var ctx = context(); if (!ctx.ok) return ctx;
    var byId = {};
    storeEconomics(ctx.slug).forEach(function (e) { byId[e.id] = e; });
    return { ok:true, byId:byId };
  }
  function currentRate(){ return publicRate(rateEntryFor(currentPeriod())); }
  /* RAF has no payout system. Nothing here is ever simulated. */
  function payouts(opts){
    if (scopeFieldSupplied(opts)) return fail('FIELD_NOT_ACCEPTED');
    var ctx = context(); if (!ctx.ok) return ctx;
    return { ok:true, available:false, reason:'PAYOUT_SYSTEM_NOT_CONFIGURED', records:[] };
  }
  /* The open month exactly as statement(currentPeriod()) reports it — same
     computation, same figures — but without closing any earlier month, so
     a read-only surface (the Dashboard) never creates a settlement record. */
  function currentPreview(opts){
    if (scopeFieldSupplied(opts)) return fail('FIELD_NOT_ACCEPTED');
    var ctx = context(); if (!ctx.ok) return ctx;
    var st = ensureClosed(ctx.slug, true), cur = currentPeriod();
    return Object.assign({ ok:true, preview:true, canExport:ctx.canExport },
      shape(computePeriod(ctx.slug, cur, st.econ, st.closed), STATUS.OPEN, st.econ));
  }

  global.RAFSettlement = {
    STATUS:STATUS, PAYOUT:PAYOUT, ERRORS:ERRORS,
    /* rate */
    currentRate:currentRate, rateSchedule:rateSchedule, scheduleRate:scheduleRate,
    /* periods */
    currentPeriod:currentPeriod, periods:periods, statement:statement, currentPreview:currentPreview,
    /* classification for reporting */
    orderEconomics:orderEconomics,
    /* payouts */
    payouts:payouts
  };
})(window);
