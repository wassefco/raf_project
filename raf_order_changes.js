/* ============================================================
   RAF · CUSTOMER APPROVED CHANGES  (Group C)

   The merchant may PROPOSE a change to an accepted order.
   Nothing about the order moves until the CUSTOMER approves it.

   This module owns exactly one thing: the proposal lifecycle
   (propose → customer decides → apply). Everything else is
   delegated to the authority that already owns it:

     order state / locks / notify → RAFOrderEngine
     permissions                  → RAFPerm
     order items & commercial rec → RAFOrderSnapshot
     events                       → RAFAudit
     stock                        → RAFInventory

   SCOPE NOTE — this module implements variant / size / colour
   changes only. Product removal and product replacement are NOT
   implemented: both change what the customer owes, and this
   codebase has no way to represent that (see the report). They
   are absent rather than approximated.
   ============================================================ */
(function (global) {
  if (global.RAFOrderChanges) return;

  var LS = 'raf_order_changes';

  var STATE = { PENDING:'pending', APPROVED:'approved', REJECTED:'rejected',
                APPLIED:'applied', FAILED:'failed' };

  /* the three kinds the order engine already declares as approval-gated;
     size and colour are variant groups, so they share one code path.
     REMOVAL and REPLACEMENT are the two that can move money. */
  var KIND  = { VARIANT:'variant', SIZE:'size', COLOR:'color',
                REMOVAL:'removal', REPLACEMENT:'replacement' };

  /* buildItem() in the snapshot classifies option groups with these exact
     patterns; reusing them keeps merchant and snapshot in agreement */
  var RE_SIZE  = /مقاس|حجم|size/i;
  var RE_COLOR = /لون|color/i;

  /* why the merchant is asking. A closed list: the customer must never be
     shown free merchant text, and the merchant must not have to write one. */
  var REASONS = [
    { id:'option_unavailable', ar:'الخيار المطلوب غير متوفر',        en:'The requested option is unavailable' },
    { id:'option_sold_out',    ar:'نفدت الكمية من الخيار المطلوب',    en:'The requested option is out of stock' },
    { id:'option_quality',     ar:'مشكلة في جودة الخيار المطلوب',     en:'Quality issue with the requested option' }
  ];

  /* ---------- refund destination (W14) ----------
     One shared concept, chosen by the CUSTOMER and nobody else. There is no
     default: a price-affecting change may not commit until the customer has
     said where the money goes.

     Nothing consumes this yet. The two change types that can produce money —
     product removal and product replacement — are not implemented, because
     neither can complete its inventory transition through RAFInventory as it
     stands (see the report). The vocabulary lives here so the wallet and the
     change engine already agree when those land. */
  var REFUND_DESTINATION = { ORIGINAL_PAYMENT:'original_payment', WALLET:'wallet' };
  var REFUND_DESTINATION_TEXT = {
    original_payment: { ar:'إرجاع المبلغ إلى طريقة الدفع الأصلية', en:'Refund to the original payment method' },
    wallet:           { ar:'إضافة المبلغ إلى محفظة RAF',           en:'Add the amount to my RAF Wallet' }
  };
  function isRefundDestination(d){
    return d === REFUND_DESTINATION.ORIGINAL_PAYMENT || d === REFUND_DESTINATION.WALLET;
  }

  var ERRORS = {
    CHANGE_REQUIRED:            { ar:'لم يتم اقتراح أي تغيير.',                  en:'No change has been proposed.' },
    REFUND_DESTINATION_REQUIRED:{ ar:'يرجى اختيار وجهة استرداد المبلغ.',         en:'Please choose where the refund should go.' },
    INVALID_CHANGE_ITEM:        { ar:'المنتج المحدد ليس ضمن هذا الطلب.',         en:'The selected product is not part of this order.' },
    INVALID_REPLACEMENT:        { ar:'المنتج البديل غير صالح.',                  en:'The replacement product is not valid.' },
    CROSS_STORE:                { ar:'هذا الطلب لا يخص متجرك.',                  en:'This order does not belong to your store.' },
    PRODUCT_NOT_AVAILABLE:      { ar:'المنتج لم يعد متاحًا.',                    en:'The product is no longer available.' },
    OPTION_NOT_AVAILABLE:       { ar:'الخيار المحدد لم يعد متاحًا.',             en:'The selected option is no longer available.' },
    REPLACEMENT_PRICE_TOO_HIGH: { ar:'لا يمكن استبدال المنتج بمنتج أعلى سعرًا.', en:'The replacement product cannot cost more than the original product.' },
    REPLACEMENT_PRICE_EXCEEDS_ORIGINAL:{ ar:'لا يمكن استبدال المنتج بمنتج أعلى قيمة من المنتج المستبدل.',
                                         en:'Replacement cannot exceed the value of the original product.' },
    PAID_AMOUNT_UNAVAILABLE:    { ar:'لا يمكن تحديد المبلغ المدفوع لهذا المنتج بدقة.',
                                  en:'The amount paid for this product cannot be determined precisely.' },
    REFUND_FAILED:              { ar:'تعذّر تنفيذ الاسترداد. لم يتم تغيير طلبك.',
                                  en:'The refund could not be completed. Your order has not been changed.' },
    INVENTORY_FAILED:           { ar:'تعذّر تحديث المخزون. لم يتم تغيير طلبك.',
                                  en:'Inventory could not be updated. Your order has not been changed.' },
    STALE_CHANGE:              { ar:'تغيّرت بيانات الطلب، ولم يعد هذا التعديل صالحًا.', en:'The order has changed and this modification is no longer valid.' },
    CHANGE_ALREADY_DECIDED:     { ar:'تم البت في هذا التعديل بالفعل.',           en:'This modification has already been decided.' },
    CHANGE_ALREADY_APPLIED:     { ar:'تم تطبيق هذا التعديل بالفعل.',             en:'This modification has already been applied.' },
    CHANGE_ALREADY_PENDING:     { ar:'يوجد تعديل بانتظار موافقة العميل.',        en:'A modification is already awaiting customer approval.' },
    CHANGE_NOT_ALLOWED_NOW:     { ar:'لا يمكن طلب تعديل في حالة الطلب الحالية.', en:'A modification cannot be requested in the order’s current state.' },
    PRICE_IMPACT_UNSUPPORTED:   { ar:'لا يمكن تنفيذ تعديل يغيّر قيمة الطلب.',    en:'A modification that changes the order value cannot be processed.' },
    FORBIDDEN:                  { ar:'ليس لديك صلاحية لهذا الإجراء.',            en:'You do not have permission for this action.' },
    LOCKED:                     { ar:'موظف آخر يعالج هذا الطلب حالياً.',         en:'Another employee is processing this order.' }
  };

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    var r = { ok:false, code:code, reason:code, ar:m.ar, en:m.en, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function reasonById(id){
    for (var i = 0; i < REASONS.length; i++) if (REASONS[i].id === id) return REASONS[i];
    return null;
  }

  /* ---------- storage ---------- */
  function readAll(){
    try { var a = JSON.parse(localStorage.getItem(LS)); return (a && typeof a === 'object') ? a : {}; }
    catch (e) { return {}; }
  }
  function writeAll(map){ try { localStorage.setItem(LS, JSON.stringify(map)); } catch (e) {} }
  /* every proposal an order has ever had, oldest first */
  function historyOf(orderId){ return readAll()[orderId] || []; }
  /* The one proposal that is not finished with. APPROVED counts as
     unresolved: the customer said yes but a step did not complete, so the
     order still owes that work and Ready must stay blocked until it does. */
  function activeOf(orderId){
    var h = historyOf(orderId);
    for (var i = h.length - 1; i >= 0; i--)
      if (h[i].state === STATE.PENDING || h[i].state === STATE.APPROVED) return h[i];
    return null;
  }
  function changeById(orderId, changeId){
    var h = historyOf(orderId);
    for (var i = 0; i < h.length; i++) if (h[i].id === changeId) return h[i];
    return null;
  }
  function put(orderId, change){
    var all = readAll(), h = all[orderId] || [], found = false;
    for (var i = 0; i < h.length; i++) if (h[i].id === change.id) { h[i] = change; found = true; }
    if (!found) h.push(change);
    all[orderId] = h; writeAll(all);
  }

  /* ---------- authorities ---------- */
  function E(){ return global.RAFOrderEngine || null; }
  function snapOf(orderId){
    if (!global.RAFOrderSnapshot) return null;
    try { return RAFOrderSnapshot.of(orderId); } catch (e) { return null; }
  }
  function slugOf(orderId){
    if (!global.RAFOrderSnapshot) return null;
    try { return RAFOrderSnapshot.storeSlugOf(orderId) || null; } catch (e) { return null; }
  }
  function productOf(id){
    if (!global.RAFCatalog || !id) return null;
    try { return RAFCatalog.get(id) || null; } catch (e) { return null; }
  }
  function audit(action, orderId, opts){
    if (!global.RAFAudit) return null;
    try { var o = opts || {}; o.action = action; o.orderId = orderId; return RAFAudit.record(o); }
    catch (e) { return null; }
  }
  /* the customer inbox the order engine already owns */
  function notifyCustomer(orderId, text, href){
    if (!E() || !E().notify) return;
    try { E().notify(orderId, text, href); } catch (e) {}
  }
  /* the merchant inbox the workspace already reads, same key and record
     shape, deduped by (type, orderId) exactly as the workspace does */
  var MNKEY = 'raf_merchant_notifs';
  function notifyMerchant(type, orderId){
    var a = [];
    try { a = JSON.parse(localStorage.getItem(MNKEY)) || []; } catch (e) { a = []; }
    if (a.some(function (n) { return n.type === type && n.orderId === orderId; })) return false;
    a.unshift({ id:type + '-' + orderId + '-' + Date.now(), type:type, orderId:orderId, ts:Date.now(), read:false });
    try { localStorage.setItem(MNKEY, JSON.stringify(a.slice(0, 60))); } catch (e) {}
    return true;
  }

  /* ---------- option resolution ----------
     A group has no id of its own, so its identity is its position in the
     product's variant list. The stored label is carried alongside purely as
     a tripwire: if the group at that position is no longer the same group,
     the proposal is stale rather than silently retargeted. */
  function groupAt(product, groupIndex){
    var gs = (product && product.variants) || [];
    if (typeof groupIndex !== 'number' || groupIndex < 0 || groupIndex >= gs.length) return null;
    return gs[groupIndex];
  }
  function optionByV(group, v){
    var os = (group && group.options) || [];
    for (var i = 0; i < os.length; i++) if (os[i].v === v) return os[i];
    return null;   /* identity is `v`; a renamed option is still the same option */
  }
  function kindOfGroup(group){
    var ar = (group && group.label && group.label.ar) || '';
    var en = (group && group.label && group.label.en) || '';
    if (RE_SIZE.test(ar) || RE_SIZE.test(en))  return KIND.SIZE;
    if (RE_COLOR.test(ar) || RE_COLOR.test(en)) return KIND.COLOR;
    return KIND.VARIANT;
  }
  /* an option that carried its own price would change what the customer
     owes; this catalogue has no such field and this module refuses to
     guess one into existence */
  function optionIsPriceNeutral(option){
    return !(option && (option.price != null || option.extra != null || option.delta != null));
  }
  /* which key of the snapshot item's variant map this group wrote into */
  function variantKeyFor(item, group){
    var v = (item && item.variant) || {};
    var ar = (group && group.label && group.label.ar) || null;
    var en = (group && group.label && group.label.en) || null;
    if (ar && Object.prototype.hasOwnProperty.call(v, ar)) return ar;
    if (en && Object.prototype.hasOwnProperty.call(v, en)) return en;
    return null;
  }

  /* ══════════════ MONEY ══════════════
     What the customer actually paid for one order line.

     The order snapshot records, per line, `unitPrice`, `discount` (the line's
     own discount) and `finalPrice = unitPrice*qty - discount`. That is the
     authoritative paid amount for the line — PROVIDED no order-level coupon
     was applied, because an order-level discount is never allocated to lines
     anywhere in this codebase. When one exists, the per-line paid amount is
     genuinely unrecorded and this module refuses rather than apportioning a
     rule nobody has approved. */
  function orderRecord(orderId){
    try {
      var all = JSON.parse(localStorage.getItem('raf_orders') || '[]');
      for (var i = 0; i < all.length; i++) if (all[i].id === orderId) return all[i];
    } catch (e) {}
    return null;
  }
  function num(v){ var n = parseFloat(v); return isFinite(n) ? n : 0; }

  /* the refundable amount for one snapshot line, or a typed refusal */
  function paidAmountOf(orderId, lineIndex){
    var snap = snapOf(orderId);
    var item = (snap && snap.items && snap.items[lineIndex]) || null;
    if (!item) return fail('INVALID_CHANGE_ITEM', { index:lineIndex });

    var ord = orderRecord(orderId);
    /* an order-level discount is not attributable to any single line */
    var orderDiscount = ord ? num(ord.discount) : 0;
    if (orderDiscount > 0) {
      return fail('PAID_AMOUNT_UNAVAILABLE',
                  { reason:'order_level_discount_not_allocated_per_line', orderDiscount:ord.discount });
    }
    if (item.finalPrice == null) return fail('PAID_AMOUNT_UNAVAILABLE', { reason:'line_final_price_missing' });

    var paid = num(item.finalPrice);
    if (!(paid > 0)) return fail('PAID_AMOUNT_UNAVAILABLE', { reason:'line_final_price_not_positive' });
    return { ok:true, paid:paid, qty:item.qty || 1, unitPrice:num(item.unitPrice) };
  }
  function money(n){ return (Math.round(n * 1000) / 1000).toFixed(3); }

  /* ---------- the active invoice ----------
     The live order carries the current commercial state. The snapshot's
     `commercial` block is the historical record and is never touched here.
     Delivery, coupon, discount, tip and tax are copied forward untouched —
     only the goods total moves. */
  function applyInvoice(orderId, mutate){
    var all;
    try { all = JSON.parse(localStorage.getItem('raf_orders') || '[]'); } catch (e) { return false; }
    var ix = -1;
    for (var i = 0; i < all.length; i++) if (all[i].id === orderId) ix = i;
    if (ix < 0) return false;

    var ord = all[ix];
    if (!mutate(ord)) return false;

    /* recompute ONLY the goods subtotal from the surviving lines */
    var sub = (ord.items || []).reduce(function (s, l) {
      if (l.removed) return s;
      return s + num(l.price) * (l.qty || 1);
    }, 0);
    ord.subtotal = money(sub);
    ord.total = money(Math.max(0, sub - num(ord.discount)) + num(ord.ship) + num(ord.tip) + num(ord.tax));

    all[ix] = ord;
    try { localStorage.setItem('raf_orders', JSON.stringify(all)); return true; }
    catch (e) { return false; }
  }

  /* ---------- the one refund path ----------
     Two destinations, one entry point. Wallet goes through RAFWallet;
     original payment is recorded against the order and audited through the
     existing refund vocabulary. Neither branch invents a payment engine. */
  function issueRefund(change, amount, actor){
    var key = 'chg-' + change.id + '-refund';
    var reason = change.kind === KIND.REMOVAL
      ? 'PRODUCT_REMOVAL_REFUND' : 'PRODUCT_REPLACEMENT_DIFFERENCE';

    if (change.refundDestination === REFUND_DESTINATION.WALLET) {
      if (!global.RAFWallet) return fail('REFUND_FAILED', { reason:'wallet_unavailable' });
      var r = RAFWallet.credit({
        customerId: actor.id, amount: amount, currency: 'KWD',
        reason: reason, source: 'order_change', orderId: change.orderId,
        relatedChangeId: change.id, idempotencyKey: key,
        actor: { id:actor.id, name:actor.name, type:'customer' }
      });
      if (!r.ok) return fail('REFUND_FAILED', { reason:r.code, detail:r.message });
      return { ok:true, destination:'wallet', amount:money(amount),
               duplicate:!!r.duplicate, balance:r.balance };
    }

    /* original payment — recorded on the live order, wording owned by the
       order engine so there is one refund-timing statement in the product */
    var recorded = applyInvoice(change.orderId, function (ord) {
      ord.refunds = ord.refunds || [];
      for (var i = 0; i < ord.refunds.length; i++) if (ord.refunds[i].key === key) return true; /* replay */
      ord.refunds.push({ key:key, amount:money(amount), destination:'original_payment',
                         reason:reason, changeId:change.id, at:Date.now() });
      return true;
    });
    if (!recorded) return fail('REFUND_FAILED', { reason:'order_write_failed' });
    return { ok:true, destination:'original_payment', amount:money(amount) };
  }

  /* ---------- shared guards ---------- */
  function merchantGuard(orderId, actor){
    if (!actor || !actor.id) return fail('FORBIDDEN');
    var allowed = false;
    try { allowed = !!(global.RAFPerm && RAFPerm.can(actor.id, 'orders.manage')); } catch (e) { allowed = false; }
    if (!allowed) return fail('FORBIDDEN');

    var mine = actor.storeSlug || null, theirs = slugOf(orderId);
    if (!mine || !theirs || mine !== theirs) return fail('CROSS_STORE', { actorStore:mine, orderStore:theirs });

    var eng = E();
    if (eng) {
      var l = eng.lockOf(orderId);
      if (l && l.userId !== actor.id) return fail('LOCKED', { lockedBy:l.name || l.userId });
    }
    return { ok:true };
  }
  /* a change may only be proposed while the merchant is actually working
     the order: after acceptance, before the store's work is finished */
  function stateAllowsChange(orderId){
    var eng = E(); if (!eng) return false;
    if (eng.merchantDone(orderId)) return false;
    if (eng.undoOf(orderId)) return false;          /* a decision is mid-flight */
    var m = eng.mstate(orderId);
    return m === eng.MSTATE.ACCEPTED || m === eng.MSTATE.PREPARING;
  }

  /* ══════════════ MERCHANT · propose ══════════════ */
  function validateProposal(orderId, draft, actor){
    var g = merchantGuard(orderId, actor); if (!g.ok) return g;
    if (!stateAllowsChange(orderId)) return fail('CHANGE_NOT_ALLOWED_NOW', { mstate:E() ? E().mstate(orderId) : null });
    if (activeOf(orderId))           return fail('CHANGE_ALREADY_PENDING');

    var d = draft || {};
    var snap = snapOf(orderId);
    var items = (snap && snap.items) || null;
    if (!items || !items.length) return fail('INVALID_CHANGE_ITEM', { reason:'order_items_unavailable' });

    var ix = d.lineIndex;
    if (typeof ix !== 'number' || ix !== Math.floor(ix) || ix < 0 || ix >= items.length)
      return fail('INVALID_CHANGE_ITEM', { index:ix });
    var item = items[ix];

    var product = productOf(item.productId);
    if (!product) return fail('PRODUCT_NOT_AVAILABLE', { productId:item.productId });
    if (product.status && product.status !== 'active') return fail('PRODUCT_NOT_AVAILABLE', { status:product.status });
    if (product.slug !== slugOf(orderId)) return fail('CROSS_STORE', { productStore:product.slug });

    /* nothing picked yet is "no change proposed", not "the option vanished" */
    if (d.groupIndex == null || d.optionV == null) return fail('CHANGE_REQUIRED', { reason:'option_required' });

    var group = groupAt(product, d.groupIndex);
    if (!group) return fail('OPTION_NOT_AVAILABLE', { groupIndex:d.groupIndex });

    var option = optionByV(group, d.optionV);
    if (!option) return fail('OPTION_NOT_AVAILABLE', { optionV:d.optionV });
    if (!optionIsPriceNeutral(option)) return fail('PRICE_IMPACT_UNSUPPORTED', { optionV:d.optionV });

    var key = variantKeyFor(item, group);
    if (!key) return fail('STALE_CHANGE', { reason:'group_not_on_order_item' });

    var current = item.variant[key];
    /* proposing what the customer already chose is not a change */
    if (current === option.label.ar || current === option.label.en) return fail('CHANGE_REQUIRED');

    var reason = reasonById(d.reasonId);
    if (!reason) return fail('CHANGE_REQUIRED', { reason:'reason_required' });

    /* §30 — refuse at proposal time too, so the merchant is told straight
       away rather than after the customer has agreed to something the store
       cannot actually deliver */
    var move0 = combinationMove(orderId, item.productId, group, option, item.qty || 1, ix);
    if (move0 && !move0.ok) return move0;

    return { ok:true, resolved:{
      item:item, lineIndex:ix, product:product, group:group, option:option,
      variantKey:key, currentLabel:current, reason:reason, kind:kindOfGroup(group)
    } };
  }

  /* ══════════════ REMOVAL / REPLACEMENT · validation ══════════════ */
  function validateLineChange(orderId, draft, actor){
    var g = merchantGuard(orderId, actor); if (!g.ok) return g;
    if (!stateAllowsChange(orderId)) return fail('CHANGE_NOT_ALLOWED_NOW', { mstate:E() ? E().mstate(orderId) : null });
    if (activeOf(orderId))           return fail('CHANGE_ALREADY_PENDING');

    var d = draft || {};
    var snap = snapOf(orderId);
    var items = (snap && snap.items) || null;
    if (!items || !items.length) return fail('INVALID_CHANGE_ITEM', { reason:'order_items_unavailable' });

    var ix = d.lineIndex;
    if (typeof ix !== 'number' || ix !== Math.floor(ix) || ix < 0 || ix >= items.length)
      return fail('INVALID_CHANGE_ITEM', { index:ix });
    var item = items[ix];
    if (item.removed) return fail('INVALID_CHANGE_ITEM', { reason:'line_already_removed' });

    /* the reason for a removal is the approved rejection reason, not a new one */
    if (d.reasonId !== 'product_unavailable')
      return fail('CHANGE_REQUIRED', { reason:'reason_must_be_product_unavailable' });

    /* what the customer actually paid for this line */
    var pay = paidAmountOf(orderId, ix); if (!pay.ok) return pay;

    /* the line must still be genuinely held by the reservation */
    if (global.RAFInventory) {
      var res = RAFInventory.reservationFor(orderId);
      var held = res && res.items ? res.items[item.productId] : 0;
      if (!res || res.status !== 'active' || !held || held < pay.qty)
        return fail('STALE_CHANGE', { reason:'reservation_line_unavailable', held:held || 0, need:pay.qty });
    }

    if (d.kind === KIND.REMOVAL) {
      return { ok:true, resolved:{ kind:KIND.REMOVAL, item:item, lineIndex:ix,
        paid:pay.paid, qty:pay.qty, refund:pay.paid, replacement:null } };
    }

    if (d.kind === KIND.REPLACEMENT) {
      var rep = productOf(d.replacementProductId);
      if (!rep) return fail('INVALID_REPLACEMENT', { productId:d.replacementProductId });
      if (rep.id === item.productId) return fail('INVALID_REPLACEMENT', { reason:'same_product' });
      if (rep.status && rep.status !== 'active') return fail('PRODUCT_NOT_AVAILABLE', { status:rep.status });
      if (rep.slug !== slugOf(orderId)) return fail('CROSS_STORE', { productStore:rep.slug });

      /* the replacement's payable value is its current approved price — it
         was never part of this order, so there is no historical value to use */
      var repUnit = num(rep.price);
      if (!(repUnit > 0)) return fail('INVALID_REPLACEMENT', { reason:'no_price' });
      var repPayable = repUnit * pay.qty;
      if (repPayable > pay.paid + 1e-9)
        return fail('REPLACEMENT_PRICE_EXCEEDS_ORIGINAL',
                    { original:money(pay.paid), replacement:money(repPayable) });

      /* it must also be genuinely in stock right now */
      if (global.RAFInventory && RAFInventory.available(rep.id) < pay.qty)
        return fail('PRODUCT_NOT_AVAILABLE', { reason:'insufficient_stock',
                    available:RAFInventory.available(rep.id), need:pay.qty });

      return { ok:true, resolved:{ kind:KIND.REPLACEMENT, item:item, lineIndex:ix,
        paid:pay.paid, qty:pay.qty, replacement:rep, replacementPayable:repPayable,
        refund:Math.max(0, pay.paid - repPayable) } };
    }

    return fail('CHANGE_REQUIRED', { reason:'unknown_kind' });
  }

  function proposeLineChange(orderId, draft, actor){
    var v = validateLineChange(orderId, draft, actor); if (!v.ok) return v;
    var r = v.resolved;
    var rep = r.replacement;

    var change = {
      id: 'CHG-' + orderId + '-' + Date.now(),
      orderId: orderId, storeSlug: slugOf(orderId), kind: r.kind,
      lineIndex: r.lineIndex, productId: r.item.productId,
      variantId: r.item.variantId || null, qty: r.qty,
      nameAr: r.item.nameAr, nameEn: r.item.nameEn,
      size: r.item.size || null, color: r.item.color || null, image: r.item.image || '',
      /* --- money, fixed at proposal time and re-proved at approval --- */
      paidAmount: money(r.paid),
      replacementProductId: rep ? rep.id : null,
      replacementNameAr:    rep ? (rep.ar || rep.name && rep.name.ar) : null,
      replacementNameEn:    rep ? (rep.en || rep.name && rep.name.en) : null,
      replacementImage:     rep ? (rep.img || '') : null,
      replacementUnitPrice: rep ? money(num(rep.price)) : null,
      replacementPayable:   rep ? money(r.replacementPayable) : null,
      refundAmount: money(r.refund),
      refundDestination: null,          /* the customer's choice, never preset */
      /* --- why / who --- */
      reasonId: 'product_unavailable',
      reasonAr: 'المنتج غير متوفر', reasonEn: 'Product unavailable',
      state: STATE.PENDING, createdAt: Date.now(),
      createdBy: { id:actor.id, name:actor.name || actor.id },
      decidedAt: null, decidedBy: null, appliedAt: null, failure: null,
      inventoryDone: false, invoiceDone: false, refundDone: false, refundResult: null
    };
    put(orderId, change);

    audit(r.kind === KIND.REMOVAL ? 'product_removal.requested' : 'product_replacement.requested',
      orderId, { actor:actor, source:'merchant', key:change.createdAt, reason:'product_unavailable',
        metadata:{ changeId:change.id, kind:change.kind, lineIndex:change.lineIndex,
                   productId:change.productId, qty:change.qty, paidAmount:change.paidAmount,
                   replacementProductId:change.replacementProductId,
                   replacementPayable:change.replacementPayable, refundAmount:change.refundAmount } });
    if (E() && E().appendTimeline) {
      E().appendTimeline(orderId, 'chg-req-' + change.createdAt,
        'بانتظار موافقتك على تعديل', 'Waiting for your approval of a change');
    }
    notifyCustomer(orderId,
      r.kind === KIND.REMOVAL
        ? T('تم طلب تعديل على طلبك ' + orderId + ' بسبب عدم توفر أحد المنتجات.',
            'A change to order ' + orderId + ' was requested because a product is unavailable.')
        : T('طلب المتجر استبدال أحد المنتجات في طلبك ' + orderId + '.',
            'The store has asked to replace a product in order ' + orderId + '.'),
      'raf_tracking.html?id=' + encodeURIComponent(orderId));

    return { ok:true, change:change };
  }

  function propose(orderId, draft, actor){
    /* removal and replacement take their own validated path */
    if (draft && (draft.kind === KIND.REMOVAL || draft.kind === KIND.REPLACEMENT))
      return proposeLineChange(orderId, draft, actor);
    var v = validateProposal(orderId, draft, actor); if (!v.ok) return v;
    var r = v.resolved;

    var change = {
      id: 'CHG-' + orderId + '-' + Date.now(),
      orderId: orderId,
      storeSlug: slugOf(orderId),
      kind: r.kind,
      /* --- what is being changed, by authoritative identity --- */
      lineIndex: r.lineIndex,
      productId: r.item.productId,
      variantId: r.item.variantId || null,
      qty: r.item.qty || null,
      groupIndex: draft.groupIndex,
      groupLabelAr: (r.group.label && r.group.label.ar) || null,
      groupLabelEn: (r.group.label && r.group.label.en) || null,
      variantKey: r.variantKey,
      fromLabel: r.currentLabel,                 /* display only, never identity */
      toV: r.option.v,                           /* THE identity of the new option */
      toLabelAr: (r.option.label && r.option.label.ar) || null,
      toLabelEn: (r.option.label && r.option.label.en) || null,
      /* --- commercial --- */
      priceImpact: 0,                            /* variant options carry no price */
      unitPrice: r.item.unitPrice != null ? r.item.unitPrice : null,
      /* --- why / who / when --- */
      reasonId: r.reason.id, reasonAr: r.reason.ar, reasonEn: r.reason.en,
      state: STATE.PENDING,
      createdAt: Date.now(),
      createdBy: { id:actor.id, name:actor.name || actor.id },
      decidedAt: null, decidedBy: null, appliedAt: null, failure: null
    };
    put(orderId, change);

    audit('modify.requested', orderId, {
      actor:actor, source:'merchant', key:change.createdAt,
      reason:change.reasonId,
      metadata:{ change:publicChange(change) }
    });
    if (E() && E().appendTimeline) {
      E().appendTimeline(orderId, 'chg-req-' + change.createdAt,
        'بانتظار موافقتك على تعديل', 'Waiting for your approval of a change');
    }
    notifyCustomer(orderId,
      T('يطلب المتجر تعديلاً على طلبك ' + orderId + ' — بانتظار موافقتك.',
        'The store has requested a change to order ' + orderId + ' — your approval is needed.'),
      'raf_tracking.html?id=' + encodeURIComponent(orderId));

    return { ok:true, change:change };
  }

  /* the proposal as the customer may see it: no ids, no slugs, no actors */
  function publicChange(c){
    if (!c) return null;
    return {
      id: c.id, kind: c.kind, state: c.state,
      groupAr: c.groupLabelAr, groupEn: c.groupLabelEn,
      fromLabel: c.fromLabel,
      toLabelAr: c.toLabelAr, toLabelEn: c.toLabelEn,
      productNameAr: null, productNameEn: null,   /* filled by describe() */
      reasonAr: c.reasonAr, reasonEn: c.reasonEn,
      priceImpact: c.priceImpact,
      createdAt: c.createdAt
    };
  }
  /* everything a customer surface needs, and nothing it must not have */
  function describe(orderId){
    var c = activeOf(orderId); if (!c) return null;
    var snap = snapOf(orderId);
    var item = (snap && snap.items && snap.items[c.lineIndex]) || null;

    if (c.kind === KIND.REMOVAL || c.kind === KIND.REPLACEMENT) {
      /* everything the customer needs to decide, and nothing internal */
      return {
        id: c.id, kind: c.kind, state: c.state,
        /* an approval that was cut off mid-way: the choice is already made,
           so the surface asks to finish rather than to decide again */
        resuming: c.state === STATE.APPROVED,
        chosenDestination: c.refundDestination || null,
        productNameAr: c.nameAr, productNameEn: c.nameEn,
        image: c.image, qty: c.qty, size: c.size, color: c.color,
        paidAmount: c.paidAmount,
        replacementNameAr: c.replacementNameAr, replacementNameEn: c.replacementNameEn,
        replacementImage: c.replacementImage, replacementPayable: c.replacementPayable,
        refundAmount: c.refundAmount,
        needsDestination: num(c.refundAmount) > 0,
        reasonAr: c.reasonAr, reasonEn: c.reasonEn,
        createdAt: c.createdAt
      };
    }

    var p = publicChange(c);
    p.productNameAr = item ? item.nameAr : null;
    p.productNameEn = item ? item.nameEn : null;
    p.image = item ? item.image : null;
    p.qty = c.qty;
    p.unitPrice = c.unitPrice;
    return p;
  }

  /* ══════════════ CUSTOMER · decide ══════════════ */
  /* only the person who placed the order may answer for it; an order whose
     customer was never recorded cannot be answered by anyone */
  function customerGuard(orderId, actor){
    if (!actor || !actor.id) return fail('FORBIDDEN');
    var snap = snapOf(orderId);
    var owner = (snap && snap.customer && snap.customer.id) || null;
    if (!owner || owner !== actor.id) return fail('FORBIDDEN', { orderCustomer:owner ? true : false });
    return { ok:true };
  }
  function decisionGuard(orderId, changeId, actor){
    var g = customerGuard(orderId, actor); if (!g.ok) return g;
    var c = changeById(orderId, changeId);
    if (!c) return fail('STALE_CHANGE', { reason:'change_not_found' });
    if (c.state === STATE.APPLIED)  return fail('CHANGE_ALREADY_APPLIED');
    if (c.state !== STATE.PENDING)  return fail('CHANGE_ALREADY_DECIDED', { state:c.state });
    return { ok:true, change:c };
  }

  /* Re-prove the whole proposal against the world as it is NOW. A proposal
     is never trusted because it was valid when it was written. */
  function revalidate(c){
    if (!stateAllowsChange(c.orderId)) return fail('STALE_CHANGE', { reason:'order_state_changed' });

    var snap = snapOf(c.orderId);
    var items = (snap && snap.items) || null;
    if (!items || c.lineIndex >= items.length) return fail('STALE_CHANGE', { reason:'order_items_changed' });
    var item = items[c.lineIndex];
    if (item.productId !== c.productId) return fail('STALE_CHANGE', { reason:'order_line_changed' });

    var product = productOf(c.productId);
    if (!product) return fail('PRODUCT_NOT_AVAILABLE', { productId:c.productId });
    if (product.status && product.status !== 'active') return fail('PRODUCT_NOT_AVAILABLE', { status:product.status });
    if (product.slug !== c.storeSlug) return fail('CROSS_STORE', { productStore:product.slug });

    var group = groupAt(product, c.groupIndex);
    if (!group) return fail('OPTION_NOT_AVAILABLE', { groupIndex:c.groupIndex });
    /* the group at that position must still be the same group */
    var sameGroup = ((group.label && group.label.ar) === c.groupLabelAr)
                 && ((group.label && group.label.en) === c.groupLabelEn);
    if (!sameGroup) return fail('STALE_CHANGE', { reason:'option_group_changed' });

    /* identity is `v` — a renamed option is still the same option, and its
       CURRENT label is what gets written to the order */
    var option = optionByV(group, c.toV);
    if (!option) return fail('OPTION_NOT_AVAILABLE', { optionV:c.toV });
    if (!optionIsPriceNeutral(option)) return fail('PRICE_IMPACT_UNSUPPORTED');

    var key = variantKeyFor(item, group);
    if (!key) return fail('STALE_CHANGE', { reason:'group_not_on_order_item' });

    /* §30 — on a combination-stocked product the option the customer is
       being moved TO must actually be buyable. The combination is only
       reserved when the change commits, never while it is a proposal. */
    var move = combinationMove(c.orderId, c.productId, group, option, c.qty || 1, c.lineIndex);
    if (move && !move.ok) return move;
    if (move) return { ok:true, item:item, items:items, group:group, option:option, variantKey:key,
                       fromCombinationId:move.from, toCombinationId:move.to };

    return { ok:true, item:item, items:items, group:group, option:option, variantKey:key };
  }

  /* Work out which combination an approved option change would move the
     order's held units to, and whether that combination can be bought.
     Returns null for a product that is not on combination stock. */
  function combinationMove(orderId, productId, group, option, qty, lineIndex){
    if (!global.RAFInventory || !RAFInventory.isCombinationMode(productId)) return null;
    /* The line records the exact combination it bought, so an order holding
       two lines of the same product in different colours stays unambiguous.
       Falling back to scanning the reservation would guess between them. */
    var ord = orderRecord(orderId);
    var line = (ord && ord.items && lineIndex != null) ? ord.items[lineIndex] : null;
    var held = (line && line.id === productId) ? (line.combinationId || null) : null;
    if (!held) {
      var res = RAFInventory.reservationFor(orderId);
      if (res && res.combos) {
        var owned = Object.keys(res.combos).filter(function (x) {
          var pp = RAFInventory.partsOf(x); return pp && pp.productId === productId; });
        if (owned.length === 1) held = owned[0];   /* only when it cannot be ambiguous */
      }
    }
    if (!held) return fail('STALE_CHANGE', { reason:'combination_not_identifiable' });

    var cur = RAFInventory.partsOf(held).vs.slice(), oldV = null;
    (group.options || []).forEach(function (o) {
      if (cur.indexOf(String(o.v)) > -1) oldV = String(o.v);
    });
    if (!oldV) return fail('STALE_CHANGE', { reason:'combination_dimension_missing' });

    var nextVs = cur.map(function (x) { return x === oldV ? String(option.v) : x; });
    var targetId = RAFInventory.combinationIdFor(productId, nextVs);
    if (!targetId) return fail('OPTION_NOT_AVAILABLE', { optionV:option.v });
    if (RAFInventory.comboAvailable(targetId) < (qty || 1))
      return fail('OPTION_NOT_AVAILABLE', { reason:'insufficient_stock', combinationId:targetId,
                  available:RAFInventory.comboAvailable(targetId) });
    return { ok:true, from:held, to:targetId };
  }

  /* ══════════════ REMOVAL / REPLACEMENT · approval ══════════════
     Re-proves everything, then runs the effects as separately-guarded steps.
     Each step records that it happened, and each underlying operation is
     idempotent by key, so a replay after an interruption resumes rather than
     repeating. localStorage cannot give a single atomic commit; this is the
     strongest guarantee available, and the flags make it honest. */
  function revalidateLineChange(c){
    if (!stateAllowsChange(c.orderId)) return fail('STALE_CHANGE', { reason:'order_state_changed' });

    var snap = snapOf(c.orderId);
    var items = (snap && snap.items) || null;
    if (!items || c.lineIndex >= items.length) return fail('STALE_CHANGE', { reason:'order_items_changed' });
    var item = items[c.lineIndex];
    if (item.productId !== c.productId) return fail('STALE_CHANGE', { reason:'order_line_changed' });

    /* the paid amount must still resolve to exactly what was proposed */
    var pay = paidAmountOf(c.orderId, c.lineIndex); if (!pay.ok) return pay;
    if (money(pay.paid) !== c.paidAmount)
      return fail('STALE_CHANGE', { reason:'paid_amount_changed', was:c.paidAmount, now:money(pay.paid) });

    if (c.kind === KIND.REPLACEMENT) {
      var rep = productOf(c.replacementProductId);
      if (!rep) return fail('INVALID_REPLACEMENT', { productId:c.replacementProductId });
      if (rep.status && rep.status !== 'active') return fail('PRODUCT_NOT_AVAILABLE', { status:rep.status });
      if (rep.slug !== c.storeSlug) return fail('CROSS_STORE', { productStore:rep.slug });
      /* the price rule is re-checked against today's price, not the frozen one */
      var payable = num(rep.price) * c.qty;
      if (payable > pay.paid + 1e-9)
        return fail('REPLACEMENT_PRICE_EXCEEDS_ORIGINAL',
                    { original:money(pay.paid), replacement:money(payable) });
      if (money(payable) !== c.replacementPayable)
        return fail('STALE_CHANGE', { reason:'replacement_price_changed',
                    was:c.replacementPayable, now:money(payable) });
      if (global.RAFInventory && !c.inventoryDone && RAFInventory.available(rep.id) < c.qty)
        return fail('PRODUCT_NOT_AVAILABLE', { reason:'insufficient_stock' });
    }
    return { ok:true, item:item };
  }

  function applyLineChange(c, actor){
    var opKey = 'chg-' + c.id;

    /* ---- 1 · inventory ---- */
    if (!c.inventoryDone) {
      if (!global.RAFInventory) return fail('INVENTORY_FAILED', { reason:'inventory_unavailable' });
      var inv = c.kind === KIND.REMOVAL
        ? RAFInventory.releaseLine(c.orderId, c.productId, c.qty,
            { opKey:opKey, reason:'order_line_removed', actor:{ id:actor.id, name:actor.name, type:'customer' } })
        : RAFInventory.replaceLine(c.orderId, c.productId, c.replacementProductId, c.qty,
            { opKey:opKey, reason:'order_line_replaced', actor:{ id:actor.id, name:actor.name, type:'customer' } });
      if (!inv.ok) return fail('INVENTORY_FAILED', { reason:inv.code, shortages:inv.shortages || null });
      c.inventoryDone = true; put(c.orderId, c);
    }

    /* ---- 2 · active invoice ---- */
    if (!c.invoiceDone) {
      var ok = applyInvoice(c.orderId, function (ord) {
        var line = (ord.items || [])[c.lineIndex];
        /* address the line by position and prove it is the same product */
        if (!line || line.id !== c.productId) return false;
        if (c.kind === KIND.REMOVAL) {
          line.removed = true;
          line.removedAt = Date.now();
          line.refundedAmount = c.refundAmount;
        } else {
          line.replacedFrom = line.id;
          line.id = c.replacementProductId;
          line.name = { ar:c.replacementNameAr, en:c.replacementNameEn };
          line.price = c.replacementUnitPrice;
          line.variant = {};                 /* the replacement carries no prior options */
          line.replacedAt = Date.now();
          if (num(c.refundAmount) > 0) line.refundedAmount = c.refundAmount;
        }
        return true;
      });
      if (!ok) return fail('STALE_CHANGE', { reason:'active_invoice_write_failed' });
      c.invoiceDone = true; put(c.orderId, c);
    }

    /* ---- 3 · refund (last: money moves only once everything else holds) ---- */
    if (!c.refundDone) {
      var amt = num(c.refundAmount);
      if (amt > 0) {
        var r = issueRefund(c, amt, actor);
        if (!r.ok) return r;                    /* stays resumable; nothing claimed */
        c.refundResult = { destination:r.destination, amount:r.amount };
        audit('refund.created', c.orderId, {
          automatic:true, systemGenerated:true, source:'automation', key:'refund:' + c.id,
          reason: c.kind === KIND.REMOVAL ? 'product_removal' : 'replacement_difference',
          metadata:{ changeId:c.id, amount:r.amount, currency:'KWD',
                     destination:r.destination, productId:c.productId, lineIndex:c.lineIndex } });
      }
      c.refundDone = true; put(c.orderId, c);
    }
    return { ok:true };
  }

  function approveLineChange(orderId, changeId, actor, options){
    var own = customerGuard(orderId, actor); if (!own.ok) return own;
    var c = changeById(orderId, changeId);
    if (!c) return fail('STALE_CHANGE', { reason:'change_not_found' });
    if (c.state === STATE.APPLIED)  return fail('CHANGE_ALREADY_APPLIED');
    if (c.state === STATE.REJECTED) return fail('CHANGE_ALREADY_DECIDED', { state:c.state });
    if (c.state === STATE.FAILED)   return fail('CHANGE_ALREADY_DECIDED', { state:c.state });
    /* PENDING starts the decision; APPROVED means a previous run was cut off
       part-way, so this call RESUMES it rather than starting a second one */
    var opts = options || {};

    /* the destination is the customer's, is required when money moves, and
       has no default anywhere in this file */
    if (num(c.refundAmount) > 0) {
      /* An explicit choice always wins while the money has not moved: if a
         first attempt failed (wallet unavailable, say) the customer must be
         able to pick the other destination. Once the refund IS done the
         stored destination is final and cannot be switched. */
      var dest = c.refundDone
        ? c.refundDestination
        : (isRefundDestination(opts.refundDestination) ? opts.refundDestination : c.refundDestination);
      if (!isRefundDestination(dest)) return fail('REFUND_DESTINATION_REQUIRED');
      c.refundDestination = dest;
    }

    var v = revalidateLineChange(c);
    if (!v.ok) {
      c.state = STATE.FAILED; c.decidedAt = Date.now();
      c.decidedBy = { id:actor.id, name:actor.name || actor.id };
      c.failure = v.code; put(orderId, c);
      audit('modify.failed', orderId, { automatic:true, systemGenerated:true, source:'automation',
        key:c.decidedAt, reason:v.code, metadata:{ changeId:c.id } });
      notifyMerchant('change_failed', orderId);
      return v;
    }

    /* the decision is recorded BEFORE any effect, so an interrupted run
       resumes with the same intent instead of starting over */
    c.decidedAt = c.decidedAt || Date.now();
    c.decidedBy = { id:actor.id, name:actor.name || actor.id };
    c.state = STATE.APPROVED;
    put(orderId, c);

    audit(c.kind === KIND.REMOVAL ? 'product_removal.approved' : 'product_replacement.approved',
      orderId, { actor:{ id:actor.id, name:actor.name }, source:'customer', key:c.decidedAt,
        metadata:{ changeId:c.id, refundAmount:c.refundAmount,
                   refundDestination:c.refundDestination || null } });

    var applied = applyLineChange(c, actor);
    if (!applied.ok) { put(orderId, c); return applied; }

    c.state = STATE.APPLIED; c.appliedAt = Date.now();
    put(orderId, c);

    audit(c.kind === KIND.REMOVAL ? 'product_removal.applied' : 'product_replacement.applied',
      orderId, { automatic:true, systemGenerated:true, source:'automation', key:c.appliedAt,
        metadata:{ changeId:c.id, productId:c.productId,
                   replacementProductId:c.replacementProductId || null,
                   qty:c.qty, refundAmount:c.refundAmount,
                   refundDestination:c.refundDestination || null } });
    if (E() && E().appendTimeline) {
      E().appendTimeline(orderId, 'chg-ok-' + c.appliedAt,
        'وافقت على التعديل وتم تطبيقه', 'You approved the change and it was applied');
    }
    notifyMerchant('change_approved', orderId);
    notifyCustomer(orderId,
      c.kind === KIND.REMOVAL
        ? T('تم تعديل طلبك ' + orderId + ' وإزالة المنتج غير المتوفر.',
            'Order ' + orderId + ' was updated and the unavailable product removed.')
        : T('تم استبدال المنتج في طلبك ' + orderId + '.',
            'The product in order ' + orderId + ' has been replaced.'),
      'raf_tracking.html?id=' + encodeURIComponent(orderId));

    return { ok:true, change:c, refund:c.refundResult || null };
  }

  function approve(orderId, changeId, actor, options){
    var pre = changeById(orderId, changeId);
    if (pre && (pre.kind === KIND.REMOVAL || pre.kind === KIND.REPLACEMENT))
      return approveLineChange(orderId, changeId, actor, options);

    var g = decisionGuard(orderId, changeId, actor); if (!g.ok) return g;
    var c = g.change;

    var v = revalidate(c);
    if (!v.ok) {
      /* a proposal that no longer holds is closed, not applied — and the
         failure is recorded rather than silently swallowed */
      c.state = STATE.FAILED; c.decidedAt = Date.now();
      c.decidedBy = { id:actor.id, name:actor.name || actor.id };
      c.failure = v.code; put(orderId, c);
      audit('modify.failed', orderId, { automatic:true, systemGenerated:true, source:'automation',
        key:c.decidedAt, reason:v.code, metadata:{ changeId:c.id } });
      notifyMerchant('change_failed', orderId);
      notifyCustomer(orderId,
        T('تعذّر تطبيق التعديل على الطلب ' + orderId + '. لم يتم تغيير طلبك ولم يتم خصم أي مبلغ.',
          'The change to order ' + orderId + ' could not be applied. Your order is unchanged and you have not been charged.'),
        'raf_tracking.html?id=' + encodeURIComponent(orderId));
      return v;
    }

    /* ---- apply: one write, or none ----
       The whole items array is rebuilt and handed to the snapshot's own
       approved-change mechanism. The line is addressed by index, so an
       order holding the same product twice under different options can
       never have the wrong line rewritten. */
    var next = v.items.slice();
    var patched = {};
    for (var k in v.item) if (v.item.hasOwnProperty(k)) patched[k] = v.item[k];

    var newVariant = {};
    for (var vk in v.item.variant) if (v.item.variant.hasOwnProperty(vk)) newVariant[vk] = v.item.variant[vk];
    var label = isEn() ? (v.option.label.en || v.option.label.ar) : (v.option.label.ar || v.option.label.en);
    newVariant[v.variantKey] = label;
    patched.variant = newVariant;
    if (c.kind === KIND.SIZE)  patched.size  = label;
    if (c.kind === KIND.COLOR) patched.color = label;
    patched.modified = true;
    next[c.lineIndex] = patched;

    var res = null;
    try {
      res = RAFOrderSnapshot.update(orderId, 'items', next, 'customer_approved_change',
                                    { id:actor.id, name:actor.name || actor.id });
    } catch (e) { res = { ok:false, reason:'update_threw' }; }

    if (!res || !res.ok) {
      c.state = STATE.FAILED; c.decidedAt = Date.now();
      c.decidedBy = { id:actor.id, name:actor.name || actor.id };
      c.failure = (res && res.reason) || 'update_failed'; put(orderId, c);
      audit('modify.failed', orderId, { automatic:true, systemGenerated:true, source:'automation',
        key:c.decidedAt, reason:c.failure, metadata:{ changeId:c.id } });
      notifyMerchant('change_failed', orderId);
      return fail('STALE_CHANGE', { reason:c.failure });
    }

    /* the write landed — only now is the proposal closed as applied */
    c.state = STATE.APPLIED;
    c.decidedAt = Date.now(); c.appliedAt = c.decidedAt;
    c.decidedBy = { id:actor.id, name:actor.name || actor.id };
    c.appliedLabel = label;
    put(orderId, c);

    /* §30 — the held combination moves with the approved option, so the
       store now holds Black/L instead of Black/M. Keyed by the change id,
       so replaying an approval cannot move stock twice. */
    if (v.fromCombinationId && v.toCombinationId && global.RAFInventory) {
      var mv = RAFInventory.replaceLine(orderId, c.productId, c.productId, c.qty || 1,
        { opKey:'chgv-' + c.id, reason:'customer_approved_variant_change',
          fromCombinationId:v.fromCombinationId, toCombinationId:v.toCombinationId,
          actor:{ id:actor.id, name:actor.name, type:'customer' } });
      if (!mv.ok && !mv.alreadyApplied) {
        /* the option is no longer buyable: close the change as failed rather
           than leave the order saying one thing and inventory another */
        c.state = STATE.FAILED; c.decidedAt = Date.now();
        c.decidedBy = { id:actor.id, name:actor.name || actor.id };
        c.failure = mv.code || 'inventory_failed'; put(orderId, c);
        audit('modify.failed', orderId, { automatic:true, systemGenerated:true, source:'automation',
          key:c.decidedAt, reason:c.failure, metadata:{ changeId:c.id } });
        notifyMerchant('change_failed', orderId);
        return fail('OPTION_NOT_AVAILABLE', { reason:mv.code });
      }
    }

    /* the snapshot's own update already emitted modify.applied */
    audit('modify.approved', orderId, {
      actor:{ id:actor.id, name:actor.name || actor.id }, source:'customer',
      key:c.decidedAt, reason:c.reasonId,
      metadata:{ changeId:c.id, kind:c.kind, lineIndex:c.lineIndex, productId:c.productId,
                 groupIndex:c.groupIndex, fromLabel:c.fromLabel, toV:c.toV, appliedLabel:label,
                 priceImpact:0 }
    });
    if (E() && E().appendTimeline) {
      E().appendTimeline(orderId, 'chg-ok-' + c.decidedAt,
        'وافقت على التعديل وتم تطبيقه', 'You approved the change and it was applied');
    }
    notifyMerchant('change_approved', orderId);
    return { ok:true, change:c, appliedLabel:label };
  }

  function reject(orderId, changeId, actor){
    var g = decisionGuard(orderId, changeId, actor); if (!g.ok) return g;
    var c = g.change;

    /* nothing is validated, because nothing is applied */
    c.state = STATE.REJECTED;
    c.decidedAt = Date.now();
    c.decidedBy = { id:actor.id, name:actor.name || actor.id };
    put(orderId, c);

    var rejectAction = c.kind === KIND.REMOVAL      ? 'product_removal.rejected'
                     : c.kind === KIND.REPLACEMENT  ? 'product_replacement.rejected'
                     : 'modify.rejected';
    audit(rejectAction, orderId, {
      actor:{ id:actor.id, name:actor.name || actor.id }, source:'customer',
      key:c.decidedAt, reason:c.reasonId,
      metadata:{ changeId:c.id, kind:c.kind, lineIndex:c.lineIndex, productId:c.productId,
                 toV:c.toV || null, refundAmount:c.refundAmount || null }
    });
    if (E() && E().appendTimeline) {
      E().appendTimeline(orderId, 'chg-no-' + c.decidedAt,
        'رفضت التعديل المقترح', 'You declined the proposed change');
    }
    notifyMerchant('change_rejected', orderId);
    return { ok:true, change:c };
  }

  /* ---------- read helpers for the surfaces ---------- */
  function hasPending(orderId){ return !!activeOf(orderId); }
  /* the option list a merchant may propose from: the product's own current
     options, never free text */
  function optionsFor(orderId, lineIndex){
    var snap = snapOf(orderId);
    var item = (snap && snap.items && snap.items[lineIndex]) || null;
    if (!item) return null;
    var p = productOf(item.productId);
    if (!p || !p.variants) return null;
    return p.variants.map(function (g, gi) {
      var key = variantKeyFor(item, g);
      return {
        groupIndex: gi,
        labelAr: g.label && g.label.ar, labelEn: g.label && g.label.en,
        kind: kindOfGroup(g),
        onOrder: !!key,
        current: key ? item.variant[key] : null,
        options: (g.options || []).map(function (o) {
          return { v:o.v, ar:o.label && o.label.ar, en:o.label && o.label.en,
                   hex:o.hex || null, priceNeutral:optionIsPriceNeutral(o) };
        })
      };
    });
  }

  /* products the merchant may offer as a replacement: their own store, active,
     in stock, and at or below what the customer already paid for the line */
  function replacementCandidates(orderId, lineIndex){
    var pay = paidAmountOf(orderId, lineIndex);
    if (!pay.ok) return { ok:false, code:pay.code, message:pay.message };
    var slug = slugOf(orderId);
    var snap = snapOf(orderId);
    var item = (snap && snap.items && snap.items[lineIndex]) || null;
    if (!slug || !item || !global.RAFSource) return { ok:true, candidates:[] };

    var out = [];
    (RAFSource.products() || []).forEach(function (p) {
      var cat = productOf(p.id);
      if (!cat || cat.slug !== slug) return;
      if (cat.id === item.productId) return;
      if (cat.status && cat.status !== 'active') return;
      var payable = num(cat.price) * pay.qty;
      if (payable > pay.paid + 1e-9) return;
      if (global.RAFInventory && RAFInventory.available(cat.id) < pay.qty) return;
      out.push({ id:cat.id, ar:cat.ar, en:cat.en, img:cat.img || '',
                 unitPrice:money(num(cat.price)), payable:money(payable),
                 refund:money(Math.max(0, pay.paid - payable)),
                 available:global.RAFInventory ? RAFInventory.available(cat.id) : null });
    });
    out.sort(function (a, b) { return num(b.payable) - num(a.payable); });
    return { ok:true, candidates:out, paidAmount:money(pay.paid), qty:pay.qty };
  }

  global.RAFOrderChanges = {
    STATE: STATE, KIND: KIND, REASONS: REASONS, ERRORS: ERRORS,
    REFUND_DESTINATION: REFUND_DESTINATION, REFUND_DESTINATION_TEXT: REFUND_DESTINATION_TEXT,
    isRefundDestination: isRefundDestination,
    reasonById: reasonById,
    /* merchant */
    validateProposal: validateProposal, propose: propose, optionsFor: optionsFor,
    validateLineChange: validateLineChange, paidAmountOf: paidAmountOf,
    replacementCandidates: replacementCandidates,
    /* customer */
    describe: describe, approve: approve, reject: reject,
    /* read */
    activeOf: activeOf, hasPending: hasPending, historyOf: historyOf, changeById: changeById
  };
})(window);
