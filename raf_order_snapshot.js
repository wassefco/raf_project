/* ============================================================
   RAF — ORDER SNAPSHOT ENGINE  (shared, headless, single owner)
   ------------------------------------------------------------
   The Order Snapshot is a legal and commercial record: exactly what
   the customer purchased and what the merchant accepted, at that
   moment. Once committed it is historical business data.

   Catalogue edits, price changes, renamed products, renamed stores,
   changed images, deleted SKUs — none of them may ever rewrite an
   existing order. Historical accuracy outranks catalogue consistency.

   THIS MODULE IS THE ONLY PLACE THAT MAY CREATE, VALIDATE, VERSION,
   MIGRATE, READ OR UPDATE A SNAPSHOT. Merchant, customer, driver and
   admin surfaces all consume it through here. No page may build or
   patch snapshot data itself.

   Reads are cheap on purpose: a committed snapshot is self-contained,
   so nothing after checkout needs a catalogue lookup to render an
   order.
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFOrderSnapshot) return;

  var VERSION = 'v1';
  var LS_ORDERS = 'raf_orders';
  var CURRENCY  = 'KWD';

  /* out-of-stock handling, exactly as the customer chose at checkout */
  var OOS = { CONTINUE:'continue', CANCEL:'cancel' };
  /* how the order reaches the customer */
  var DELIVERY = { DELIVERY:'delivery', PICKUP:'pickup' };
  var PAY_STATUS = { PAID:'paid', PENDING:'pending', COD:'cod', REFUNDED:'refunded' };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }
  function num(v, dflt){ var n = parseFloat(v); return isFinite(n) ? n : (dflt == null ? 0 : dflt); }
  function money(v){ return num(v).toFixed(3); }
  function str(v){ return v == null ? null : String(v); }

  /* ══════════════ 1 · BUILD ══════════════
     Called once, at checkout, with everything the checkout already knows.
     Nothing here is inferred: a field the caller cannot supply is stored
     as null and reported by validate(), never guessed. */
  function buildItem(line){
    var p = (global.RAFCatalog && line.id) ? RAFCatalog.get(line.id) : null;
    var variant = line.variant || {};
    var keys = Object.keys(variant);
    /* colour and size are named option groups; anything else stays in variant */
    function pick(re){
      for (var i = 0; i < keys.length; i++){ if (re.test(keys[i])) return variant[keys[i]]; }
      return null;
    }
    var unit = num(line.price);
    var qty  = num(line.qty, 1) || 1;
    return {
      productId:   str(line.id),
      variantId:   keys.length ? str(line.key || (line.id + '|' + keys.map(function(k){ return k+':'+variant[k]; }).sort().join(','))) : null,
      storeSlug:   p ? str(p.slug) : null,
      nameAr:      str(line.name && line.name.ar),
      nameEn:      str(line.name && line.name.en),
      sku:         p ? str(p.id) : str(line.id),      /* the product id is the SKU in this catalogue */
      barcode:     p && p.barcode ? str(p.barcode) : null,
      image:       str(line.img || (p && p.img) || ''),
      color:       pick(/لون|color/i),
      size:        pick(/مقاس|حجم|size/i),
      variant:     variant,
      qty:         qty,
      unitPrice:   money(unit),
      discount:    money(line.lineDiscount || 0),
      finalPrice:  money(unit * qty - num(line.lineDiscount)),
      customerNotes: str(line.notes) || null,
      merchantNotes: null,
      modified:    false
    };
  }

  /* ctx is supplied by checkout — see RAFShop.Orders.create */
  function build(ctx){
    ctx = ctx || {};
    var store = ctx.store || null;
    var addr  = ctx.address || null;
    var t     = ctx.totals || {};
    var lines = ctx.lines || [];

    return {
      v: VERSION,
      orderId:     str(ctx.orderId),
      storeId:     store ? str(store.num || store.slug) : null,
      storeSlug:   store ? str(store.slug) : null,
      storeNameAr: store ? str(store.name.ar) : null,
      storeNameEn: store ? str(store.name.en) : null,
      checkoutAt:  ctx.checkoutAt || Date.now(),

      customer: {
        id:    str(ctx.customerId),                  /* null when the shopper is not signed in */
        name:  str(addr && addr.name),
        phone: str(addr && addr.phone),
        notes: str(ctx.customerNotes) || null,
        lang:  isEn() ? 'en' : 'ar'
      },

      delivery: {
        type:         str(ctx.deliveryType) || DELIVERY.DELIVERY,
        address:      str(ctx.addressText),
        area:         str(addr && addr.area),
        block:        str(addr && addr.block),
        street:       str(addr && addr.street),
        building:     str(addr && addr.building),
        floor:        str(addr && addr.floor),
        apartment:    str(addr && addr.apartment),
        instructions: str(ctx.deliveryInstructions) || null
      },

      /* exactly what the customer selected — never defaulted */
      preference: {
        outOfStock: (ctx.oosPreference === OOS.CONTINUE || ctx.oosPreference === OOS.CANCEL)
                      ? ctx.oosPreference : null
      },

      merchant: {
        storeSlug:      store ? str(store.slug) : null,
        storeName:      store ? { ar:str(store.name.ar), en:str(store.name.en) } : null,
        prepTimeShown:  str(ctx.prepTimeShown) || null,
        storeStateAtCheckout: store ? str(store.status) : null
      },

      preparation: {
        startedAt: null, readyAt: null, notes: null, checklist: null
      },

      commercial: {
        currency:      CURRENCY,
        subtotal:      money(t.sub),
        discount:      money(t.disc),
        coupon:        t.coupon ? str(t.coupon.code) : null,
        deliveryFee:   money(t.ship),
        driverTip:     money(t.tip),
        tax:           money(t.tax),
        grandTotal:    money(t.total),
        paymentMethod: ctx.payment ? { ar:str(ctx.payment.ar), en:str(ctx.payment.en), id:str(ctx.payment.id) } : null,
        paymentStatus: str(ctx.paymentStatus) || null
      },

      items: lines.map(buildItem),

      /* ---- reserved sections ----
         Present from v1 so the modules that come later can fill them in
         without a schema change or a migration. */
      scheduled: null,        /* { at, window } — Scheduled Orders */
      fulfilment: { driverId:null, assignedAt:null, pickedUpAt:null, deliveredAt:null },
      returns: [],            /* Returns module */
      refunds: [],            /* Refunds module */
      audit: [],              /* Audit Log module */
      invoice: { number:null, issuedAt:null, printedAt:null },
      analytics: {},          /* Analytics module */

      migrated: false,
      legacyUnresolved: false,
      unresolved: []
    };
  }

  /* ══════════════ 2 · VALIDATE ══════════════
     A partially captured commercial record is never allowed to commit. */
  var REQUIRED = [
    ['orderId',              function(s){ return !!s.orderId; }],
    ['storeSlug',            function(s){ return !!s.storeSlug; }],
    ['storeId',              function(s){ return !!s.storeId; }],
    ['storeName',            function(s){ return !!(s.storeNameAr && s.storeNameEn); }],
    ['checkoutAt',           function(s){ return !!s.checkoutAt; }],
    ['customer.name',        function(s){ return !!(s.customer && s.customer.name); }],
    ['customer.phone',       function(s){ return !!(s.customer && s.customer.phone); }],
    ['delivery.type',        function(s){ return !!(s.delivery && s.delivery.type); }],
    ['delivery.address',     function(s){ return !!(s.delivery && s.delivery.address); }],
    ['preference.outOfStock',function(s){ return !!(s.preference && s.preference.outOfStock); }],
    ['commercial.currency',  function(s){ return !!(s.commercial && s.commercial.currency); }],
    ['commercial.subtotal',  function(s){ return !!(s.commercial && s.commercial.subtotal != null); }],
    ['commercial.grandTotal',function(s){ return !!(s.commercial && s.commercial.grandTotal != null); }],
    ['commercial.paymentMethod', function(s){ return !!(s.commercial && s.commercial.paymentMethod); }],
    ['commercial.paymentStatus', function(s){ return !!(s.commercial && s.commercial.paymentStatus); }],
    ['items',                function(s){ return !!(s.items && s.items.length); }]
  ];
  function validate(snap){
    if (!snap || typeof snap !== 'object') return { ok:false, missing:['snapshot'] };
    var missing = [];
    REQUIRED.forEach(function (r) { if (!r[1](snap)) missing.push(r[0]); });
    (snap.items || []).forEach(function (it, i) {
      if (!it.productId)                 missing.push('items['+i+'].productId');
      if (!it.storeSlug)                 missing.push('items['+i+'].storeSlug');
      if (!(it.nameAr || it.nameEn))     missing.push('items['+i+'].name');
      if (!it.qty)                       missing.push('items['+i+'].qty');
      if (it.unitPrice == null)          missing.push('items['+i+'].unitPrice');
      if (it.finalPrice == null)         missing.push('items['+i+'].finalPrice');
      if (it.storeSlug && snap.storeSlug && it.storeSlug !== snap.storeSlug)
        missing.push('items['+i+'].storeSlug≠order.storeSlug');
    });
    return { ok: missing.length === 0, missing: missing };
  }

  /* ══════════════ 3 · READ ══════════════
     Self-contained: no catalogue lookups, no joins, no name matching. */
  function orders(){
    if (!global.RAFShop) return [];
    try { return RAFShop.Orders.all(); } catch (e) { return []; }
  }
  function of(orderId){
    var o = orders().filter(function (x) { return x.id === orderId; })[0];
    return (o && o.snapshot) || null;
  }
  function has(orderId){ return !!of(orderId); }
  function storeSlugOf(orderId){
    var s = of(orderId);
    return s ? s.storeSlug : null;
  }
  function isLegacyUnresolved(orderId){
    var s = of(orderId);
    return !s || s.legacyUnresolved === true;
  }
  /* every order belonging to one store — the only supported scoping path */
  function forStore(slug){
    if (!slug) return [];
    return orders().filter(function (o) { return o.snapshot && o.snapshot.storeSlug === slug; });
  }
  function unresolvedOrders(){
    return orders().filter(function (o) { return !o.snapshot || o.snapshot.legacyUnresolved; });
  }

  /* ══════════════ 4 · COMMIT ══════════════ */
  function attach(order, snap){
    if (!order || !snap) return false;
    order.snapshot = snap;
    return true;
  }
  function persist(orderId, snap, note){
    var all = orders();
    var i = all.findIndex(function (o) { return o.id === orderId; });
    if (i < 0) return false;
    all[i].snapshot = snap;
    try { localStorage.setItem(LS_ORDERS, JSON.stringify(all)); } catch (e) { return false; }
    if (note) document.dispatchEvent(new CustomEvent('raf:snapshot', { detail:{ id:orderId, note:note } }));
    return true;
  }

  /* ══════════════ 5 · APPROVED UPDATES ══════════════
     The snapshot is immutable to the catalogue, never to an approved
     business workflow. Updates come through here only, they touch the
     snapshot alone — never catalogue data — and each one is written into
     the order timeline. */
  var ALLOWED_PATHS = [
    'items',                    /* merchant-approved customer modifications */
    'preparation',
    'fulfilment',
    'returns', 'refunds', 'audit', 'invoice', 'analytics', 'scheduled',
    'commercial.paymentStatus'
  ];
  function pathAllowed(path){
    return ALLOWED_PATHS.some(function (p) { return path === p || path.indexOf(p + '.') === 0; });
  }
  /* reason is the approved workflow that authorised the change */
  function update(orderId, path, value, reason, actor){
    if (!pathAllowed(path)) return { ok:false, reason:'path_not_updatable', path:path };
    if (!reason)            return { ok:false, reason:'approval_reason_required' };
    var snap = of(orderId);
    if (!snap) return { ok:false, reason:'no_snapshot' };

    var parts = path.split('.'), node = snap;
    for (var i = 0; i < parts.length - 1; i++){
      if (node[parts[i]] == null || typeof node[parts[i]] !== 'object') return { ok:false, reason:'bad_path' };
      node = node[parts[i]];
    }
    var leaf = parts[parts.length - 1];
    var before = node[leaf];
    node[leaf] = value;

    snap.audit.push({ at:Date.now(), path:path, reason:reason,
                      by:(actor && actor.id) || null, byName:(actor && actor.name) || null });
    persist(orderId, snap, reason);

    /* every snapshot modification is recorded on the order timeline */
    if (global.RAFOrderEngine && RAFOrderEngine.appendTimeline){
      RAFOrderEngine.appendTimeline(orderId, 'snap-' + Date.now(),
        'تم تعديل سجل الطلب (' + reason + ')', 'Order record updated (' + reason + ')');
    }
    /* the audit log records who changed what; the snapshot stays the
       commercial record and is never rewritten by the audit system */
    if (global.RAFAudit){
      var isApproved = reason === 'customer_approved_change';
      try {
        RAFAudit.record({
          action: isApproved ? 'modify.applied' : 'snapshot.updated',
          orderId: orderId, actor: actor, source: 'merchant',
          key: snap.audit[snap.audit.length - 1].at,
          reason: reason, metadata: { path: path },
          snapshotVersion: snap.v
        });
      } catch (e) {}
    }
    return { ok:true, path:path, before:before, after:value };
  }
  /* merchant-approved change to one ordered item; flags it as modified */
  function updateItem(orderId, productId, patch, reason, actor){
    var snap = of(orderId);
    if (!snap) return { ok:false, reason:'no_snapshot' };
    var idx = snap.items.findIndex(function (it) { return it.productId === productId; });
    if (idx < 0) return { ok:false, reason:'item_not_found' };
    var next = snap.items.slice();
    next[idx] = Object.assign({}, next[idx], patch, { modified:true });
    return update(orderId, 'items', next, reason, actor);
  }

  /* ══════════════ 6 · MIGRATION ══════════════
     Legacy orders are migrated only when the data genuinely supports it.
     Nothing is inferred, and a store is NEVER resolved from a display
     name. An order that cannot be migrated is marked Legacy Unresolved
     and left for manual migration — it is not hidden and not guessed at. */
  function legacyStub(order, missing){
    return {
      v: VERSION,
      orderId: str(order.id),
      storeId:null, storeSlug:null, storeNameAr:null, storeNameEn:null,
      checkoutAt:null,
      customer:{ id:null, name:null, phone:null, notes:null, lang:null },
      delivery:{ type:null, address:null, area:null, block:null, street:null,
                 building:null, floor:null, apartment:null, instructions:null },
      preference:{ outOfStock:null },
      merchant:{ storeSlug:null, storeName:null, prepTimeShown:null, storeStateAtCheckout:null },
      preparation:{ startedAt:null, readyAt:null, notes:null, checklist:null },
      commercial:{ currency:CURRENCY, subtotal:null, discount:null, coupon:null, deliveryFee:null,
                   driverTip:null, tax:null, grandTotal:str(order.total), paymentMethod:null, paymentStatus:null },
      items: [],
      scheduled:null,
      fulfilment:{ driverId:null, assignedAt:null, pickedUpAt:null, deliveredAt:null },
      returns:[], refunds:[], audit:[], invoice:{ number:null, issuedAt:null, printedAt:null }, analytics:{},
      migrated:false, legacyUnresolved:true, unresolved:missing
    };
  }
  /* the store is resolved only from real product ids, never from names */
  function storeFromItems(order){
    if (!global.RAFSource) return null;
    var lines = order.items || [];
    for (var i = 0; i < lines.length; i++){
      if (!lines[i].id) continue;
      var p = RAFSource.product(lines[i].id);
      if (p && p.store) return RAFSource.store(p.store) || null;
    }
    return null;
  }
  function migrateOne(order){
    if (!order) return { ok:false, reason:'no_order' };
    if (order.snapshot && !order.snapshot.legacyUnresolved) return { ok:true, already:true };

    var store = storeFromItems(order);
    var lines = order.items || [];
    var missing = [];
    if (!store) missing.push('storeSlug (no resolvable product id)');
    if (!lines.length) missing.push('items');
    lines.forEach(function (l, i) { if (!l.id) missing.push('items['+i+'].productId'); });
    /* identity was never captured on legacy orders */
    missing.push('customer.name', 'customer.phone', 'preference.outOfStock');

    if (!store || !lines.length || lines.some(function (l) { return !l.id; })){
      return { ok:false, reason:'insufficient_data', snapshot:legacyStub(order, missing), missing:missing };
    }

    /* enough real data to build a partial-but-honest historical record */
    var snap = build({
      orderId: order.id,
      store: store,
      checkoutAt: null,
      totals: { sub:num(order.subtotal), disc:num(order.discount), ship:num(order.ship),
                tip:num(order.tip), tax:num(order.tax), total:num(order.total),
                coupon: order.coupon ? { code:order.coupon } : null },
      lines: lines.map(function (l) {
        return { id:l.id, name:l.name, price:l.price, qty:l.qty, variant:l.variant, ic:l.ic,
                 img:(global.RAFCatalog && RAFCatalog.get(l.id) ? RAFCatalog.get(l.id).img : '') };
      }),
      payment: order.pay ? { ar:order.pay.ar, en:order.pay.en, id:null } : null,
      paymentStatus: null,
      addressText: order.addr ? (order.addr.ar || order.addr.en) : null,
      deliveryType: null
    });
    snap.migrated = true;
    snap.legacyUnresolved = true;   /* identity and preference still absent */
    snap.unresolved = missing;
    return { ok:true, partial:true, snapshot:snap, missing:missing };
  }
  /* migrate every order that can be migrated; returns a report */
  function migrateAll(){
    var all = orders(), report = { migrated:[], partial:[], unresolved:[], skipped:[] }, changed = false;
    all.forEach(function (o) {
      if (o.snapshot && !o.snapshot.legacyUnresolved){ report.skipped.push(o.id); return; }
      var r = migrateOne(o);
      if (r.already){ report.skipped.push(o.id); return; }
      o.snapshot = r.snapshot;
      changed = true;
      /* only a genuine migration is recorded; an order that stays unresolved
         receives no fabricated history */
      if (r.ok && r.partial && global.RAFAudit){
        try {
          RAFAudit.record({ action:'order.migrated', orderId:o.id, storeSlug:r.snapshot.storeSlug,
            automatic:true, systemGenerated:true, source:'system', key:'v' + r.snapshot.v,
            reason:'legacy_migration', snapshotVersion:r.snapshot.v,
            metadata:{ unresolved:r.missing } });
        } catch (e) {}
      }
      if (r.ok && r.partial) report.partial.push({ id:o.id, missing:r.missing });
      else                   report.unresolved.push({ id:o.id, missing:r.missing });
    });
    if (changed){ try { localStorage.setItem(LS_ORDERS, JSON.stringify(all)); } catch (e) {} }
    return report;
  }

  global.RAFOrderSnapshot = {
    VERSION: VERSION, OOS: OOS, DELIVERY: DELIVERY, PAY_STATUS: PAY_STATUS, CURRENCY: CURRENCY,
    /* create */
    build: build, buildItem: buildItem, validate: validate, attach: attach, persist: persist,
    /* read */
    of: of, has: has, storeSlugOf: storeSlugOf, isLegacyUnresolved: isLegacyUnresolved,
    forStore: forStore, unresolvedOrders: unresolvedOrders,
    /* approved updates */
    update: update, updateItem: updateItem, ALLOWED_PATHS: ALLOWED_PATHS,
    /* migration */
    migrateOne: migrateOne, migrateAll: migrateAll
  };
})(window);
