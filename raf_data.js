/* ============================================================
   RAFShop — single shared data layer for the whole marketplace
   Cart · Wishlist · Orders · Search catalog · badge sync
   Loaded before raf_card.js on every customer page.
   Storage keys: raf_cart · raf_wish · raf_orders  (all JSON)
   ============================================================ */
(function () {
  if (window.RAFShop) return;
  var LS = { cart: 'raf_cart', wish: 'raf_wish', orders: 'raf_orders' };

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

  /* ─────────── CART ─────────── */
  function vsig(v) { v = v || {}; return Object.keys(v).sort().map(function (k) { return k + ':' + v[k]; }).join(','); }
  function keyOf(id, v) { return id + '|' + vsig(v); }
  var Cart = {
    read: function () { var a = read(LS.cart, []); return Array.isArray(a) ? a : []; },
    write: function (a) { write(LS.cart, a); Cart.badge(); document.dispatchEvent(new CustomEvent('raf:cart')); },
    line: function (key) { return Cart.read().find(function (l) { return l.key === key; }); },
    firstForProduct: function (id) { return Cart.read().find(function (l) { return l.id === id; }); },
    add: function (p, variant) {
      var a = Cart.read(), key = keyOf(p.id, variant), ex = a.find(function (l) { return l.key === key; });
      if (ex) ex.qty++;
      else a.push({ key: key, id: p.id, name: { ar: p.ar, en: p.en }, price: p.price, qty: 1, variant: variant || {}, ic: p.ic || 'ti-box', store: p.store ? { ar: pick(p.store, 'ar'), en: pick(p.store, 'en') } : null });
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
      if (!Cart.conflicts(p)) { Cart.add(p, variant); return Promise.resolve({ added: true, cleared: false, cancelled: false }); }
      var cur = Cart.storeLabelForKey(Cart.currentStore()), next = Cart.storeLabel(p);
      return Cart.confirmSwitch(cur, next).then(function (ok) {
        if (!ok) return { added: false, cleared: false, cancelled: true };
        Cart.clear(); Cart.add(p, variant);
        return { added: true, cleared: true, cancelled: false };
      });
    },
    /* shared "different store" confirmation */
    confirmSwitch: function (cur, next) {
      var e = isEn();
      return confirmDialog({
        icon: 'ti-building-store',
        title: e ? 'Start a new cart?' : 'بدء سلة جديدة؟',
        msg: e
          ? 'Your cart contains products from “' + cur + '”. RAF supports one store per order, so adding from “' + next + '” will clear your current cart.'
          : 'سلتك تحتوي على منتجات من «' + cur + '». يدعم رف متجراً واحداً لكل طلب، لذا ستُفرَغ سلتك الحالية عند الإضافة من «' + next + '».',
        confirmText: e ? 'Clear cart & continue' : 'إفراغ السلة والمتابعة',
        cancelText: e ? 'Cancel' : 'إلغاء',
        danger: true
      });
    },
    setQty: function (key, q) { var a = Cart.read(), i = a.findIndex(function (l) { return l.key === key; }); if (i < 0) return; if (q <= 0) a.splice(i, 1); else a[i].qty = q; Cart.write(a); },
    remove: function (key) { Cart.setQty(key, 0); },
    clear: function () { Cart.write([]); },
    items: function () { return Cart.read(); },
    count: function () { return Cart.read().reduce(function (s, l) { return s + (l.qty || 0); }, 0); },
    subtotal: function () { return Cart.read().reduce(function (s, l) { return s + (parseFloat(l.price) || 0) * (l.qty || 0); }, 0); },
    badge: function () {
      var n = Cart.count();
      document.querySelectorAll('#cartBadge,.cart-badge,#rtbCartBadge,.rtb-badge').forEach(function (b) {
        if (n > 0) { b.textContent = n > 99 ? '99+' : n; b.style.display = 'flex'; } else { b.textContent = ''; b.style.display = 'none'; }
      });
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
      a.push({ id: p.id, ar: p.ar, en: p.en, price: p.price, old: p.old || '', disc: p.disc || 0, store: p.store || null, ic: p.ic || 'ti-box', rate: p.rate || '', rev: p.rev || '', variants: p.variants || null, stock: (p.stock === undefined ? null : p.stock), available: (p.available === undefined ? true : p.available) });
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
        return { name: l.name, meta: { ar: pre + 'الكمية ' + l.qty, en: pre + 'Qty ' + l.qty }, price: l.price, ic: l.ic || 'ti-box' };
      });
      var subtotal = Cart.subtotal(), ship = 1.000, total = subtotal + ship;
      var first = lines[0];
      var order = {
        id: 'RAF-' + Date.now().toString().slice(-7),
        store: first.store || { ar: 'RAF', en: 'RAF' }, ic: first.ic || 'ti-shopping-bag',
        date: nowStr(), total: total.toFixed(3), status: 'progress', items: items,
        pay: opts.pay || { ar: 'بطاقة فيزا •••• 4821', en: 'Visa card •••• 4821' },
        addr: opts.addr || { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' },
        driver: { ar: 'قيد التعيين', en: 'Assigning courier' }, ship: ship.toFixed(3),
        tl: [{ k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: nowStr(), s: 'done' },
             { k: 'prep', t: { ar: 'قيد التجهيز', en: 'Preparing' }, time: { ar: '—', en: '—' }, s: 'active' },
             { k: 'ship', t: { ar: 'مع مندوب التوصيل', en: 'Out for delivery' }, time: { ar: '—', en: '—' }, s: '' },
             { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '—', en: '—' }, s: '' }]
      };
      var all = Orders.all(); all.unshift(order); write(LS.orders, all);
      return order;
    }
  };

  /* ─────────── SEARCH CATALOG ─────────── */
  var CATALOG = [
    { sku: 'P-EARBUDS', ar: 'سماعات لاسلكية فاخرة', en: 'Premium Wireless Earbuds', store: { ar: 'تك هاوس', en: 'Tech House' }, price: '24.500', ic: 'ti-device-mobile' },
    { sku: 'P-PERFUME', ar: 'عطر شرقي فاخر', en: 'Luxury Oriental Perfume', store: { ar: 'دار العود', en: 'Dar Aloud' }, price: '42.000', ic: 'ti-spray' },
    { sku: 'P-WATCH', ar: 'ساعة كلاسيكية جلد', en: 'Classic Leather Watch', store: { ar: 'تايم بوكس', en: 'Time Box' }, price: '68.000', ic: 'ti-clock-hour-4' },
    { sku: 'P-JACKET', ar: 'جاكيت شتوي عصري', en: 'Modern Winter Jacket', store: { ar: 'كازا مود', en: 'Casa Mode' }, price: '29.900', ic: 'ti-hanger' },
    { sku: 'P-001', ar: 'قميص أوفرسايز كلاسيك', en: 'Classic Oversize Shirt', store: { ar: 'Casa Mode', en: 'Casa Mode' }, price: '12.000', ic: 'ti-shirt' },
    { sku: 'P-002', ar: 'حذاء رياضي Air Comfort', en: 'Air Comfort Sneakers', store: { ar: 'Sole & Co', en: 'Sole & Co' }, price: '28.500', ic: 'ti-shoe' },
    { sku: 'P-003', ar: 'iPhone 16 Pro', en: 'iPhone 16 Pro', store: { ar: 'TechZone', en: 'TechZone' }, price: '189.000', ic: 'ti-device-mobile' },
    { sku: 'P-004', ar: 'نظارة شمسية Ray Luxe', en: 'Ray Luxe Sunglasses', store: { ar: 'Luxe Accessories', en: 'Luxe Accessories' }, price: '35.000', ic: 'ti-sunglasses' },
    { sku: 'P-006', ar: 'ساعة ذكية Premium', en: 'Premium Smartwatch', store: { ar: 'Glam Store', en: 'Glam Store' }, price: '75.000', ic: 'ti-watch' },
    { sku: 'P-008', ar: 'سماعة Sony WH-1000XM5', en: 'Sony WH-1000XM5', store: { ar: 'TechZone', en: 'TechZone' }, price: '35.750', ic: 'ti-headphones' }
  ];
  var STORES = [
    { ar: 'تك هاوس', en: 'Tech House', cat: { ar: 'إلكترونيات', en: 'Electronics' }, ic: 'ti-device-mobile' },
    { ar: 'دار العود', en: 'Dar Aloud', cat: { ar: 'عطور', en: 'Perfume' }, ic: 'ti-spray' },
    { ar: 'كازا مود', en: 'Casa Mode', cat: { ar: 'أزياء', en: 'Fashion' }, ic: 'ti-hanger' },
    { ar: 'Sole & Co', en: 'Sole & Co', cat: { ar: 'أحذية', en: 'Shoes' }, ic: 'ti-shoe' },
    { ar: 'Glam Store', en: 'Glam Store', cat: { ar: 'إكسسوارات', en: 'Accessories' }, ic: 'ti-diamond' }
  ];
  function search(q) {
    q = (q || '').trim().toLowerCase();
    if (!q) return { q: q, products: [], stores: [] };
    var products = CATALOG.filter(function (p) { return (p.ar + ' ' + p.en + ' ' + p.sku + ' ' + p.store.ar + ' ' + p.store.en).toLowerCase().indexOf(q) > -1; });
    var stores = STORES.filter(function (s) { return (s.ar + ' ' + s.en).toLowerCase().indexOf(q) > -1; });
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
          '<div class="raf-dlg-row">' +
            '<button class="raf-dlg-no"></button>' +
            '<button class="raf-dlg-yes' + (o.danger ? ' danger' : '') + '"></button>' +
          '</div></div>';
      back.querySelector('h3').textContent = o.title || '';
      back.querySelector('p').textContent = o.msg || '';
      var no = back.querySelector('.raf-dlg-no'), yes = back.querySelector('.raf-dlg-yes');
      no.textContent = o.cancelText || (isEn() ? 'Cancel' : 'إلغاء');
      yes.textContent = o.confirmText || (isEn() ? 'Confirm' : 'تأكيد');
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

  window.RAFShop = { Cart: Cart, Wish: Wish, Orders: Orders, search: search, catalog: CATALOG, stores: STORES, L: L, nowStr: nowStr, toast: toast, isEn: isEn, confirm: confirmDialog };

  /* keep every tab / page in sync */
  window.addEventListener('storage', function (e) { if (e.key === LS.cart) Cart.badge(); if (e.key === LS.wish) Wish.badge(); });
  function boot() { Cart.badge(); Wish.badge(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
