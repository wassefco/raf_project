/* ============================================================
   RAFShop — single shared data layer for the whole marketplace
   Cart · Wishlist · Orders · Search catalog · badge sync
   Loaded before raf_card.js on every customer page.
   Storage keys: raf_cart · raf_wish · raf_orders  (all JSON)
   ============================================================ */
(function () {
  if (window.RAFShop) return;
  var LS = { cart: 'raf_cart', carts: 'raf_carts', wish: 'raf_wish', orders: 'raf_orders', follow: 'raf_follow' };

  function read(k, def) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? def : v; } catch (e) { return def; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function root() { return document.getElementById('htmlRoot') || document.documentElement; }
  function isEn() { return root().lang === 'en'; }
  function L(o) { return (o && typeof o === 'object') ? (isEn() ? o.en : o.ar) : (o || ''); }
  function pick(o, l) { return (o && typeof o === 'object') ? o[l] : o; }
  function nowStr() {
    var d = new Date();
    var mAr = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];
    var mEn = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var hh = d.getHours(), mm = ('0' + d.getMinutes()).slice(-2), ap = hh < 12 ? 'ص' : 'م', apE = hh < 12 ? 'AM' : 'PM', h12 = ((hh + 11) % 12 + 1);
    return { ar: d.getDate() + ' ' + mAr[d.getMonth()] + '، ' + h12 + ':' + mm + ap, en: mEn[d.getMonth()] + ' ' + d.getDate() + ', ' + h12 + ':' + mm + ' ' + apE };
  }

  /* ─────────── AVAILABILITY (single source of truth) ───────────
     Product objects reach the UI from many places — listings, search results
     and the wishlist — and some of them carry no stock field, or a snapshot
     taken when the item was favourited. Resolving against the live catalog by
     id keeps every surface (Home · Store · Categories · Search · Favorites)
     showing the same Sold Out state from one rule. */
  var Stock = {
    /* live stock for a product, or null when genuinely unknown */
    of: function (p) {
      if (!p) return null;
      var live = window.RAFCatalog && RAFCatalog.get ? RAFCatalog.get(p.id) : null;
      if (live && live.stock != null) return live.stock;
      return (p.stock == null ? null : p.stock);
    },
    /* Sold out when any source says so — availability fails closed, so a
       product is never offered for sale while one source still calls it
       unavailable. A missing/null stock field is "unknown", not "in stock". */
    isOOS: function (p) {
      if (!p) return false;
      if (p.available === false || p.outOfStock === true) return true;
      if (p.stock === 0) return true;          /* the caller's own figure */
      return Stock.of(p) === 0;                /* the live catalog */
    },
    /* merge the live availability back onto a product object (non-mutating) */
    sync: function (p) {
      if (!p) return p;
      var s = Stock.of(p);
      p.stock = s;
      p.available = !Stock.isOOS(p);
      return p;
    },
    label: function (p) { return Stock.isOOS(p) ? (isEn() ? 'Sold Out' : 'نفدت الكمية') : ''; }
  };

  /* ─────────── CART ─────────── */
  function vsig(v) { v = v || {}; return Object.keys(v).sort().map(function (k) { return k + ':' + v[k]; }).join(','); }
  function keyOf(id, v) { return id + '|' + vsig(v); }
  var Cart = {
    read: function () { var a = read(LS.cart, []); return Array.isArray(a) ? a : []; },
    write: function (a) { write(LS.cart, a); Cart.badge(); document.dispatchEvent(new CustomEvent('raf:cart')); },
    line: function (key) { return Cart.read().find(function (l) { return l.key === key; }); },
    firstForProduct: function (id) { return Cart.read().find(function (l) { return l.id === id; }); },
    add: function (p, variant) {
      /* safety net: a sold-out product can never enter the cart, whichever
         path calls this (listing, Quick Order, Favorites, Add All) */
      if (Stock.isOOS(p)) return null;
      var a = Cart.read(), key = keyOf(p.id, variant), ex = a.find(function (l) { return l.key === key; });
      if (ex) ex.qty++;
      else a.push({ key: key, id: p.id, name: { ar: p.ar, en: p.en }, price: p.price, qty: 1, variant: variant || {}, ic: p.ic || 'ti-box', img: p.img || '', store: p.store ? { ar: pick(p.store, 'ar'), en: pick(p.store, 'en') } : null });
      Cart.write(a); return key;
    },

    /* ─── ONE STORE PER ORDER (central rule — used by every add-to-cart path) ─── */
    /* stable comparison key — always the same regardless of UI language */
    storeOf: function (x) {
      var s = x && x.store;
      if (!s) return '';
      return String((typeof s === 'object' ? (s.ar || s.en) : s) || '').trim();
    },
    /* localized display name for the same store */
    storeLabel: function (x) {
      var s = x && x.store;
      if (!s) return '';
      return String((typeof s === 'object' ? (isEn() ? (s.en || s.ar) : (s.ar || s.en)) : s) || '').trim();
    },
    /* display name for a store key already present in the cart */
    storeLabelForKey: function (key) {
      var hit = Cart.read().find(function (l) { return Cart.storeOf(l) === key; });
      return hit ? Cart.storeLabel(hit) : key;
    },
    /* the store the cart currently belongs to, or '' when the cart is empty */
    currentStore: function () {
      var items = Cart.read();
      for (var i = 0; i < items.length; i++) { var s = Cart.storeOf(items[i]); if (s) return s; }
      return '';
    },
    /* true when adding this product would mix stores in one order */
    conflicts: function (p) {
      var cur = Cart.currentStore(), next = Cart.storeOf(p);
      return !!(cur && next && cur !== next);
    },
    /* Guarded add. Never clears the cart silently — asks first.
       Resolves { added, cleared, cancelled }. Use this everywhere instead of add(). */
    tryAdd: function (p, variant) {
      /* availability is checked before the store rule — a sold-out product must
         never trigger a "clear your cart" prompt */
      if (Stock.isOOS(p)) return Promise.resolve({ added: false, cleared: false, cancelled: false, oos: true });
      if (!Cart.conflicts(p)) { Cart.add(p, variant); return Promise.resolve({ added: true, cleared: false, cancelled: false }); }
      var cur = Cart.storeLabelForKey(Cart.currentStore()), next = Cart.storeLabel(p);
      return Cart.confirmSwitch(cur, next).then(function (choice) {
        /* 'separate' → park the current cart and open a fresh one for this store */
        if (choice === 'separate') {
          Carts.startSeparate(p, variant);
          return { added: true, cleared: false, cancelled: false, separate: true };
        }
        if (!choice) return { added: false, cleared: false, cancelled: true };
        Cart.clear(); Cart.add(p, variant);
        return { added: true, cleared: true, cancelled: false };
      });
    },
    /* shared "different store" choice — empty the current cart, cancel, or keep
       both by starting a separate cart for the new store */
    confirmSwitch: function (cur, next) {
      var e = isEn();
      return confirmDialog({
        icon: 'ti-building-store',
        title: e ? 'Products from another store' : 'منتجات من متجر آخر',
        msg: e
          ? 'Your current cart belongs to “' + cur + '”. You can empty it and continue with “' + next + '”, or keep both by starting a separate cart. Every store is checked out as its own order, with its own delivery fee and store policies.'
          : 'سلتك الحالية تخص «' + cur + '». يمكنك إفراغها والمتابعة مع «' + next + '»، أو الاحتفاظ بالسلتين عبر إنشاء سلة منفصلة. كل متجر يُطلب بشكل منفصل، برسوم توصيل وسياسات خاصة به.',
        confirmText: e ? 'Empty current cart' : 'إفراغ السلة الحالية',
        cancelText: e ? 'Cancel' : 'إلغاء',
        altText: e ? 'Create a separate cart' : 'إنشاء سلة منفصلة',
        danger: true
      }).then(function (v) { return v === 'alt' ? 'separate' : v; });
    },
    setQty: function (key, q) { var a = Cart.read(), i = a.findIndex(function (l) { return l.key === key; }); if (i < 0) return; if (q <= 0) a.splice(i, 1); else a[i].qty = q; Cart.write(a); },
    remove: function (key) { Cart.setQty(key, 0); },
    clear: function () { Cart.write([]); },
    items: function () { return Cart.read(); },
    count: function () { return Cart.read().reduce(function (s, l) { return s + (l.qty || 0); }, 0); },
    subtotal: function () { return Cart.read().reduce(function (s, l) { return s + (parseFloat(l.price) || 0) * (l.qty || 0); }, 0); },
    badge: function () {
      /* the badge counts every cart the customer has, not just the active one,
         so a parked store cart never looks like it disappeared */
      var n = Carts.totalCount();
      document.querySelectorAll('#cartBadge,.cart-badge,#rtbCartBadge,.rtb-badge').forEach(function (b) {
        if (n > 0) { b.textContent = n > 99 ? '99+' : n; b.style.display = 'flex'; } else { b.textContent = ''; b.style.display = 'none'; }
      });
    }
  };

  /* ─────────── MULTIPLE CARTS (one cart per store) ───────────
     `raf_cart` stays the ACTIVE cart, so every existing consumer (checkout,
     badge, rules, cart page) keeps reading exactly what it read before.
     The other carts are parked in `raf_carts` as { store, items, state } and
     are swapped in when the customer switches. Each cart keeps its own coupon,
     tip and notes, so all cart rules apply to it independently. Checkout always
     runs on the active cart alone — one store, one order. */
  var CART_STATE = ['raf_coupon', 'raf_tip', 'raf_order_notes'];
  var Carts = {
    read: function () { var a = read(LS.carts, []); return Array.isArray(a) ? a : []; },
    write: function (a) {
      write(LS.carts, a.filter(function (c) { return c && c.items && c.items.length; }));
      Cart.badge();
      document.dispatchEvent(new CustomEvent('raf:carts'));
    },
    /* cart-scoped checkout state travels with the cart it belongs to */
    grabState: function () {
      var s = {};
      CART_STATE.forEach(function (k) { try { var v = localStorage.getItem(k); if (v != null) s[k] = v; } catch (e) {} });
      return s;
    },
    putState: function (s) {
      CART_STATE.forEach(function (k) {
        try { if (s && s[k] != null) localStorage.setItem(k, s[k]); else localStorage.removeItem(k); } catch (e) {}
      });
    },
    /* every cart the customer currently has — the active one first */
    list: function () {
      var out = [], act = Cart.read();
      if (act.length) out.push({ store: Cart.currentStore(), items: act, active: true });
      Carts.read().forEach(function (c) { out.push({ store: c.store, items: c.items, active: false }); });
      return out.map(function (c) {
        return {
          store: c.store,
          label: Cart.storeLabel(c.items[0]) || c.store,
          items: c.items,
          active: c.active,
          count: c.items.reduce(function (s, l) { return s + (l.qty || 0); }, 0),
          subtotal: c.items.reduce(function (s, l) { return s + (parseFloat(l.price) || 0) * (l.qty || 0); }, 0)
        };
      });
    },
    count: function () { return Carts.list().length; },
    /* total units across every cart — used by the header badge */
    totalCount: function () { return Carts.list().reduce(function (s, c) { return s + c.count; }, 0); },
    has: function (storeKey) { return Carts.list().some(function (c) { return c.store === storeKey; }); },
    /* move the active cart aside without losing it */
    park: function () {
      var act = Cart.read();
      if (!act.length) return false;
      var key = Cart.currentStore(), parked = Carts.read().filter(function (c) { return c.store !== key; });
      /* `at` records when this cart was last active, so the cart page can
         deterministically reopen the most recently used one */
      parked.push({ store: key, items: act, state: Carts.grabState(), at: Date.now() });
      Carts.write(parked);
      Carts.putState(null);
      Cart.write([]);
      return true;
    },
    /* make another store's cart the active one; the current cart is parked */
    switchTo: function (storeKey) {
      if (!storeKey || Cart.currentStore() === storeKey) return false;
      var parked = Carts.read(), i = -1;
      for (var n = 0; n < parked.length; n++) { if (parked[n].store === storeKey) { i = n; break; } }
      if (i < 0) return false;
      var target = parked.splice(i, 1)[0];
      var act = Cart.read();
      if (act.length) parked.push({ store: Cart.currentStore(), items: act, state: Carts.grabState(), at: Date.now() });
      Carts.write(parked);
      Carts.putState(target.state);
      Cart.write(target.items);
      return true;
    },
    /* park the current cart and start a fresh one for this product's store */
    startSeparate: function (p, variant) {
      Carts.park();
      Cart.add(p, variant);
      return true;
    },
    /* discard one cart entirely — active or parked */
    drop: function (storeKey) {
      if (Cart.currentStore() === storeKey) {
        Carts.putState(null);
        Cart.clear();
        return true;
      }
      Carts.write(Carts.read().filter(function (c) { return c.store !== storeKey; }));
      return true;
    },
    clear: function () { Carts.write([]); },
    /* A8 — the parked cart to reopen when the active one is empty: the most
       recently active, falling back to the first available. Deterministic,
       never random, and it neither merges nor deletes anything. */
    nextActive: function () {
      var parked = Carts.read().filter(function (c) { return c.items && c.items.length; });
      if (!parked.length) return null;
      var best = parked[0];
      parked.forEach(function (c) { if ((c.at || 0) > (best.at || 0)) best = c; });
      return best.store;
    }
  };

  /* ─────────── WISHLIST ─────────── */
  var Wish = {
    read: function () { var a = read(LS.wish, []); return Array.isArray(a) ? a : []; },
    write: function (a) { write(LS.wish, a); Wish.badge(); document.dispatchEvent(new CustomEvent('raf:wish')); },
    has: function (id) { return Wish.read().some(function (w) { return w.id === id; }); },
    toggle: function (p) {
      var a = Wish.read(), i = a.findIndex(function (w) { return w.id === p.id; });
      if (i > -1) { a.splice(i, 1); Wish.write(a); return false; }
      a.push({ id: p.id, ar: p.ar, en: p.en, price: p.price, old: p.old || '', disc: p.disc || 0, store: p.store || null, ic: p.ic || 'ti-box', img: p.img || '', rate: p.rate || '', rev: p.rev || '', variants: p.variants || null, stock: (p.stock === undefined ? null : p.stock), available: (p.available === undefined ? true : p.available) });
      Wish.write(a); return true;
    },
    remove: function (id) { Wish.write(Wish.read().filter(function (w) { return w.id !== id; })); },
    clear: function () { Wish.write([]); },
    items: function () { return Wish.read(); },
    count: function () { return Wish.read().length; },
    /* number of distinct stores represented in the wishlist */
    storeCount: function () {
      var seen = {}, n = 0;
      Wish.read().forEach(function (w) { var s = w.store ? (w.store.ar || w.store.en || w.store) : null; if (s && !seen[s]) { seen[s] = 1; n++; } });
      return n;
    },
    badge: function () {
      var n = Wish.count();
      document.querySelectorAll('#wishBadge,.wish-badge').forEach(function (b) { if (n > 0) { b.textContent = n; b.style.display = 'flex'; } else b.style.display = 'none'; });
    }
  };

  /* ─────────── FOLLOWED STORES ───────────
     Followed stores are managed from the Favorites page only. One list keyed
     by store slug, so any page can follow/unfollow without its own storage. */
  var Follow = {
    read: function () { var a = read(LS.follow, []); return Array.isArray(a) ? a : []; },
    write: function (a) { write(LS.follow, a); Follow.badge(); document.dispatchEvent(new CustomEvent('raf:follow')); },
    has: function (slug) { return Follow.read().some(function (s) { return s.slug === slug; }); },
    get: function (slug) { return Follow.read().find(function (s) { return s.slug === slug; }); },
    /* store = { slug, name:{ar,en}|string, cat:{ar,en}, ic, products, rating } */
    add: function (store) {
      if (!store || !store.slug || Follow.has(store.slug)) return false;
      var a = Follow.read();
      a.push({
        slug: store.slug,
        name: store.name || store.slug,
        cat: store.cat || null,
        ic: store.ic || 'ti-building-store',
        products: store.products == null ? null : store.products,
        rating: store.rating || ''
      });
      Follow.write(a);
      return true;
    },
    remove: function (slug) { Follow.write(Follow.read().filter(function (s) { return s.slug !== slug; })); },
    toggle: function (store) {
      if (!store || !store.slug) return false;
      if (Follow.has(store.slug)) { Follow.remove(store.slug); return false; }
      Follow.add(store); return true;
    },
    clear: function () { Follow.write([]); },
    items: function () { return Follow.read(); },
    count: function () { return Follow.read().length; },
    badge: function () {
      var n = Follow.count();
      document.querySelectorAll('#followBadge,.follow-badge').forEach(function (b) {
        if (n > 0) { b.textContent = n; b.style.display = 'flex'; } else b.style.display = 'none';
      });
    }
  };

  /* ─────────── ORDERS ─────────── */
  var SEED = [
    { id: 'ORD-1284', store: { ar: 'Casa Mode', en: 'Casa Mode' }, ic: 'ti-shirt', date: { ar: '4 يونيو 2026، 2:30م', en: 'Jun 4, 2026, 2:30 PM' }, total: '24.500', status: 'progress',
      items: [{ name: { ar: 'قميص أوفرسايز كلاسيك', en: 'Classic Oversize Shirt' }, meta: { ar: 'مقاس M · أبيض · الكمية 1', en: 'Size M · White · Qty 1' }, price: '12.000', ic: 'ti-shirt' },
              { name: { ar: 'بنطلون كاجوال', en: 'Casual Trousers' }, meta: { ar: 'مقاس 32 · كحلي · الكمية 1', en: 'Size 32 · Navy · Qty 1' }, price: '12.500', ic: 'ti-hanger' }],
      pay: { ar: 'بطاقة فيزا •••• 4821', en: 'Visa card •••• 4821' }, addr: { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' }, driver: { ar: 'خالد — يصل خلال ~20 دقيقة', en: 'Khaled — arriving in ~20 min' }, ship: '1.000',
      tl: [{ k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '2:30م', en: '2:30 PM' }, s: 'done' }, { k: 'prep', t: { ar: 'قيد التجهيز', en: 'Preparing' }, time: { ar: '2:45م', en: '2:45 PM' }, s: 'done' }, { k: 'ship', t: { ar: 'مع مندوب التوصيل', en: 'Out for delivery' }, time: { ar: '3:10م', en: '3:10 PM' }, s: 'active' }, { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '—', en: '—' }, s: '' }] },
    { id: 'ORD-1280', store: { ar: 'TechZone', en: 'TechZone' }, ic: 'ti-device-mobile', date: { ar: '3 يونيو 2026، 4:00م', en: 'Jun 3, 2026, 4:00 PM' }, total: '189.000', status: 'delivered',
      items: [{ name: { ar: 'iPhone 16 Pro — 256GB', en: 'iPhone 16 Pro — 256GB' }, meta: { ar: 'تيتانيوم · الكمية 1', en: 'Titanium · Qty 1' }, price: '189.000', ic: 'ti-device-mobile' }],
      pay: { ar: 'بطاقة فيزا •••• 4821', en: 'Visa card •••• 4821' }, addr: { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' }, ship: '0.000',
      tl: [{ k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '3 يونيو 4:00م', en: 'Jun 3, 4:00 PM' }, s: 'done' }, { k: 'prep', t: { ar: 'قيد التجهيز', en: 'Preparing' }, time: { ar: '3 يونيو 4:20م', en: 'Jun 3, 4:20 PM' }, s: 'done' }, { k: 'ship', t: { ar: 'مع مندوب التوصيل', en: 'Out for delivery' }, time: { ar: '3 يونيو 6:00م', en: 'Jun 3, 6:00 PM' }, s: 'done' }, { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '3 يونيو 7:15م', en: 'Jun 3, 7:15 PM' }, s: 'done' }] },
    { id: 'ORD-1275', store: { ar: 'Sole & Co', en: 'Sole & Co' }, ic: 'ti-shoe', date: { ar: '1 يونيو 2026، 11:00ص', en: 'Jun 1, 2026, 11:00 AM' }, total: '56.000', status: 'cancelled',
      items: [{ name: { ar: 'حذاء رياضي Air Comfort', en: 'Air Comfort Sneakers' }, meta: { ar: 'مقاس 42 · أسود · الكمية 1', en: 'Size 42 · Black · Qty 1' }, price: '56.000', ic: 'ti-shoe' }],
      pay: { ar: 'الدفع عند الاستلام', en: 'Cash on delivery' }, addr: { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' }, ship: '1.000',
      tl: [{ k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '1 يونيو 11:00ص', en: 'Jun 1, 11:00 AM' }, s: 'done' }, { k: 'cancel', t: { ar: 'تم إلغاء الطلب', en: 'Order cancelled' }, time: { ar: '1 يونيو 11:20ص', en: 'Jun 1, 11:20 AM' }, s: 'cancel' }] },
    { id: 'ORD-1268', store: { ar: 'Glam Store', en: 'Glam Store' }, ic: 'ti-watch', date: { ar: '28 مايو 2026، 6:10م', en: 'May 28, 2026, 6:10 PM' }, total: '75.000', status: 'delivered',
      items: [{ name: { ar: 'ساعة ذكية Premium', en: 'Premium Smartwatch' }, meta: { ar: 'فضي · الكمية 1', en: 'Silver · Qty 1' }, price: '75.000', ic: 'ti-watch' }],
      pay: { ar: 'بطاقة ماستركارد •••• 9035', en: 'Mastercard •••• 9035' }, addr: { ar: 'شرق، برج X، الطابق 8', en: 'Sharq, Tower X, Floor 8' }, ship: '0.000',
      tl: [{ k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '28 مايو', en: 'May 28' }, s: 'done' }, { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '29 مايو', en: 'May 29' }, s: 'done' }] }
  ];
  var Orders = {
    all: function () { var o = read(LS.orders, null); if (o == null) { write(LS.orders, SEED); return SEED.slice(); } return o; },
    get: function (id) { return Orders.all().find(function (o) { return o.id === id; }); },
    create: function (opts) {
      opts = opts || {};
      var lines = Cart.items();
      if (!lines.length) return null;
      var items = lines.map(function (l) {
        var vparts = Object.keys(l.variant || {}).map(function (k) { return l.variant[k]; });
        var pre = vparts.length ? vparts.join(' · ') + ' · ' : '';
        /* keep the readable meta string AND the structured fields the
           Order Details view needs (store / variant / qty) */
        return {
          /* the product id travels with the order line so cancellations can
             put the stock back and re-orders can resolve the product */
          id: l.id,
          name: l.name, meta: { ar: pre + 'الكمية ' + l.qty, en: pre + 'Qty ' + l.qty },
          price: l.price, ic: l.ic || 'ti-box',
          store: l.store || null, variant: l.variant || {}, qty: l.qty || 1
        };
      });
      var subtotal = Cart.subtotal();
      var ship = (opts.totals && typeof opts.totals.ship === 'number') ? opts.totals.ship : 1.000;
      var discount = (opts.totals && opts.totals.disc) || 0;
      var tip = (opts.totals && opts.totals.tip) || 0;
      var tax = (opts.totals && opts.totals.tax) || 0;
      var total = Math.max(0, subtotal - discount) + ship + tip + tax;
      var first = lines[0];
      var order = {
        id: 'RAF-' + Date.now().toString().slice(-7),
        store: first.store || { ar: 'RAF', en: 'RAF' }, ic: first.ic || 'ti-shopping-bag',
        date: nowStr(), total: total.toFixed(3), status: 'progress', items: items,
        /* invoice breakdown persisted with the order */
        subtotal: subtotal.toFixed(3), discount: discount.toFixed(3), tax: tax.toFixed(3), tip: tip.toFixed(3),
        coupon: (opts.totals && opts.totals.coupon) ? opts.totals.coupon.code : '',
        pay: opts.pay || { ar: 'بطاقة فيزا •••• 4821', en: 'Visa card •••• 4821' },
        addr: opts.addr || { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' },
        driver: { ar: 'قيد التعيين', en: 'Assigning courier' }, ship: ship.toFixed(3),
        tl: [{ k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: nowStr(), s: 'done' },
             { k: 'prep', t: { ar: 'قيد التجهيز', en: 'Preparing' }, time: { ar: '—', en: '—' }, s: 'active' },
             { k: 'ship', t: { ar: 'مع مندوب التوصيل', en: 'Out for delivery' }, time: { ar: '—', en: '—' }, s: '' },
             { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '—', en: '—' }, s: '' }]
      };

      /* ---- ORDER SNAPSHOT ----
         The immutable commercial record is built and validated by its own
         engine; this module never assembles snapshot data itself. A snapshot
         that is not complete blocks the order rather than committing a
         partially captured commercial record. */
      if (window.RAFOrderSnapshot) {
        var store = (window.RAFSource && opts.storeSlug) ? RAFSource.store(opts.storeSlug) : null;
        var snap = RAFOrderSnapshot.build({
          orderId: order.id,
          store: store,
          checkoutAt: Date.now(),
          customerId: opts.customerId || null,
          customerNotes: opts.customerNotes || null,
          address: opts.address || null,
          addressText: opts.addr ? (opts.addr.ar || opts.addr.en) : null,
          deliveryType: opts.deliveryType || null,
          deliveryInstructions: opts.deliveryInstructions || null,
          oosPreference: opts.oosPreference || null,
          prepTimeShown: opts.prepTimeShown || null,
          totals: opts.totals || {},
          lines: lines,
          payment: opts.payment || null,
          paymentStatus: opts.paymentStatus || null
        });
        var check = RAFOrderSnapshot.validate(snap);
        if (!check.ok) return { error: 'INCOMPLETE_SNAPSHOT', missing: check.missing };
        RAFOrderSnapshot.attach(order, snap);
      }

      var all = Orders.all(); all.unshift(order); write(LS.orders, all);
      return order;
    }
  };

  /* ─────────── SEARCH CATALOG ───────────
     Now derived from the central authority instead of a local copy, so search
     results, prices and store names can never drift from the rest of the site.
     Shape is unchanged (`sku` + flat fields) for existing callers. */
  function catalogList() {
    if (!window.RAFSource) return [];
    return RAFSource.products({}).map(function (p) {
      var s = p.storeRef || RAFSource.store(p.store);
      return {
        sku: p.id, id: p.id, ar: p.name.ar, en: p.name.en,
        store: s ? { ar: s.name.ar, en: s.name.en } : null,
        slug: p.store, price: p.price, old: p.old || '', disc: p.disc || 0,
        ic: p.ic || 'ti-box', img: p.img || '', rate: p.rate || '', rev: p.rev || '',
        stock: p.stock, cat: p.cat, sponsored: !!p.sponsored
      };
    });
  }
  function storeList() {
    if (!window.RAFSource) return [];
    return RAFSource.stores({}).map(function (s) {
      return { slug: s.slug, ar: s.name.ar, en: s.name.en, cat: s.cat, ic: s.ic,
               logo: s.logo || '', cover: s.cover || '',
               rate: s.rating, prod: s.productCount, sponsored: !!s.sponsored };
    });
  }
  function search(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return { q: q, products: [], stores: [] };
    var products = catalogList().filter(function (p) {
      return (p.ar + ' ' + p.en + ' ' + p.sku + ' ' + (p.store ? p.store.ar + ' ' + p.store.en : '')).toLowerCase().indexOf(q) > -1;
    });
    var stores = storeList().filter(function (s) { return (s.ar + ' ' + s.en).toLowerCase().indexOf(q) > -1; });
    return { q: q, products: products, stores: stores };
  }

  /* ─────────── TOAST (shared feedback + optional Undo) ─────────── */
  function toast(msg, opts) {
    opts = opts || {};
    if (!document.getElementById('raf-toast-style')) {
      var st = document.createElement('style'); st.id = 'raf-toast-style';
      st.textContent =
        '.raf-toast-wrap{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(90px + env(safe-area-inset-bottom,0px));z-index:5000;display:flex;flex-direction:column;gap:10px;align-items:center;pointer-events:none;width:calc(100% - 32px);max-width:440px;}' +
        '.raf-toast{pointer-events:auto;display:flex;align-items:center;gap:12px;width:100%;background:#15130F;color:#F3EFE5;border:1px solid rgba(201,168,76,.35);border-radius:14px;padding:13px 16px;font-family:"Tajawal",sans-serif;font-size:14px;box-shadow:0 18px 40px -18px rgba(0,0,0,.7);opacity:0;transform:translateY(10px);transition:opacity .22s,transform .22s;}' +
        '.raf-toast.show{opacity:1;transform:none;}' +
        '.raf-toast i.lead{font-size:19px;color:#C9A84C;flex-shrink:0;}' +
        '.raf-toast span.msg{flex:1;line-height:1.5;}' +
        '.raf-toast button.undo{flex-shrink:0;background:#C9A84C;color:#1C1606;border:none;border-radius:20px;padding:7px 15px;font-family:"Tajawal",sans-serif;font-weight:700;font-size:13px;cursor:pointer;}' +
        '.raf-toast button.undo:hover{background:#e0c069;}';
      document.head.appendChild(st);
    }
    var wrap = document.querySelector('.raf-toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'raf-toast-wrap'; document.body.appendChild(wrap); }
    var el = document.createElement('div'); el.className = 'raf-toast';
    el.innerHTML = '<i class="ti ' + (opts.icon || 'ti-circle-check') + ' lead"></i><span class="msg"></span>';
    el.querySelector('.msg').textContent = msg;
    if (opts.undo) {
      var b = document.createElement('button'); b.className = 'undo';
      b.textContent = isEn() ? 'Undo' : 'تراجع';
      b.onclick = function () { try { opts.undo(); } catch (e) {} close(); };
      el.appendChild(b);
    }
    wrap.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    var t = setTimeout(close, opts.duration || (opts.undo ? 6000 : 3000));
    function close() { clearTimeout(t); el.classList.remove('show'); setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240); }
    return close;
  }

  /* ─────────── CONFIRM DIALOG (shared, promise-based) ─────────── */
  function confirmDialog(o) {
    o = o || {};
    if (!document.getElementById('raf-dlg-style')) {
      var st = document.createElement('style'); st.id = 'raf-dlg-style';
      st.textContent =
        '.raf-dlg-back{position:fixed;inset:0;z-index:5200;display:flex;align-items:center;justify-content:center;padding:18px;background:rgba(20,16,8,.55);backdrop-filter:blur(3px);opacity:0;transition:opacity .2s;font-family:"Tajawal",sans-serif;}' +
        '.raf-dlg-back.show{opacity:1;}' +
        '.raf-dlg{width:100%;max-width:420px;background:#fff;border:1px solid #E2DBCC;border-radius:20px;padding:28px 24px 22px;text-align:center;box-shadow:0 30px 70px -22px rgba(20,16,8,.55);transform:translateY(14px);transition:transform .24s;}' +
        '.raf-dlg-back.show .raf-dlg{transform:none;}' +
        '.raf-dlg-ic{width:62px;height:62px;margin:0 auto 16px;border-radius:18px;background:rgba(201,168,76,.12);display:flex;align-items:center;justify-content:center;font-size:29px;color:#A07828;}' +
        '.raf-dlg-ic.danger{background:rgba(217,83,79,.12);color:#D9534F;}' +
        '.raf-dlg h3{font-family:"Playfair Display",serif;font-size:21px;font-weight:800;color:#15130F;margin-bottom:10px;}' +
        '.raf-dlg p{font-size:14px;line-height:1.75;color:#5A5650;margin-bottom:22px;}' +
        '.raf-dlg-row{display:flex;gap:10px;}' +
        '.raf-dlg-row.stack{flex-direction:column;}' +
        '.raf-dlg-alt{background:rgba(201,168,76,.12);color:#7A5C1B;border-color:#D8CBA4;}' +
        '.raf-dlg-alt:hover{background:rgba(201,168,76,.22);}' +
        '.raf-dlg-row button{flex:1;height:48px;border-radius:30px;font-family:"Tajawal",sans-serif;font-size:14.5px;font-weight:700;cursor:pointer;border:1px solid transparent;transition:all .2s;}' +
        '.raf-dlg-no{background:#fff;color:#5A5650;border-color:#D8D0BE;}' +
        '.raf-dlg-no:hover{border-color:#8A857C;}' +
        '.raf-dlg-yes{background:#C9A84C;color:#1C1606;border-color:#A07828;}' +
        '.raf-dlg-yes:hover{background:#A07828;color:#fff;}' +
        '.raf-dlg-yes.danger{background:#D9534F;border-color:#B8433F;color:#fff;}' +
        '.raf-dlg-yes.danger:hover{background:#B8433F;}';
      document.head.appendChild(st);
    }
    return new Promise(function (resolve) {
      var back = document.createElement('div'); back.className = 'raf-dlg-back';
      back.innerHTML =
        '<div class="raf-dlg" role="dialog" aria-modal="true">' +
          '<div class="raf-dlg-ic' + (o.danger ? ' danger' : '') + '"><i class="ti ' + (o.icon || 'ti-alert-circle') + '"></i></div>' +
          '<h3></h3><p></p>' +
          /* a third action stacks the buttons so all three stay readable */
          '<div class="raf-dlg-row' + (o.altText ? ' stack' : '') + '">' +
            (o.altText
              ? '<button class="raf-dlg-yes' + (o.danger ? ' danger' : '') + '"></button>' +
                '<button class="raf-dlg-no"></button>' +
                '<button class="raf-dlg-alt"></button>'
              : '<button class="raf-dlg-no"></button>' +
                '<button class="raf-dlg-yes' + (o.danger ? ' danger' : '') + '"></button>') +
          '</div></div>';
      back.querySelector('h3').textContent = o.title || '';
      back.querySelector('p').textContent = o.msg || '';
      var no = back.querySelector('.raf-dlg-no'), yes = back.querySelector('.raf-dlg-yes');
      var alt = back.querySelector('.raf-dlg-alt');
      no.textContent = o.cancelText || (isEn() ? 'Cancel' : 'إلغاء');
      yes.textContent = o.confirmText || (isEn() ? 'Confirm' : 'تأكيد');
      if (alt) { alt.textContent = o.altText; alt.onclick = function () { close('alt'); }; }
      function close(v) {
        back.classList.remove('show');
        document.removeEventListener('keydown', onKey);
        setTimeout(function () { if (back.parentNode) back.parentNode.removeChild(back); }, 220);
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') close(false); }
      no.onclick = function () { close(false); };
      yes.onclick = function () { close(true); };
      back.onclick = function (e) { if (e.target === back) close(false); };
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      requestAnimationFrame(function () { back.classList.add('show'); });
    });
  }

  window.RAFShop = { Cart: Cart, Carts: Carts, Wish: Wish, Follow: Follow, Stock: Stock, Orders: Orders, search: search, L: L, nowStr: nowStr, toast: toast, isEn: isEn, confirm: confirmDialog };
  /* `catalog` and `stores` stay readable as arrays for existing callers, but are
     now live views over the central authority rather than stored copies */
  Object.defineProperty(window.RAFShop, 'catalog', { get: catalogList, enumerable: true });
  Object.defineProperty(window.RAFShop, 'stores',  { get: storeList,  enumerable: true });

  /* keep every tab / page in sync */
  window.addEventListener('storage', function (e) { if (e.key === LS.cart) Cart.badge(); if (e.key === LS.wish) Wish.badge(); if (e.key === LS.follow) Follow.badge(); });
  function boot() { Cart.badge(); Wish.badge(); Follow.badge(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
