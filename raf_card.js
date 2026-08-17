/* ============================================================
   RAF Product Card — single global component
   One card used across every customer-facing listing.
   Pages render with RAFCard.product(productObj, opts).
   Handles: discount badge, wishlist, store, pricing,
            add-to-cart, REQUIRED variant selector, qty controls.
   Self-contained: injects its own CSS once.
   ============================================================ */
(function () {
  if (window.RAFCard) return;

  /* ---------- language ---------- */
  function root() { return document.getElementById('htmlRoot') || document.documentElement; }
  function en() { return root().lang === 'en'; }
  function L(o) { if (o == null) return ''; return (typeof o === 'object') ? (en() ? o.en : o.ar) : o; }
  function T(ar, eng) { return en() ? eng : ar; }
  function kwd() { return en() ? 'KWD' : 'د.ك'; }

  /* ---------- product registry (so handlers can resolve variants) ---------- */
  var REG = {};
  var _uid = 0;

  /* ---------- cart (single schema in localStorage 'raf_cart') ---------- */
  function vsig(v) { v = v || {}; return Object.keys(v).sort().map(function (k) { return k + ':' + v[k]; }).join(','); }
  function keyOf(id, v) { return id + '|' + vsig(v); }
  /* use the shared RAFShop cart authority when present (single source of truth) */
  var Cart = (window.RAFShop && window.RAFShop.Cart) || {
    read: function () { try { var c = JSON.parse(localStorage.getItem('raf_cart') || '[]'); return Array.isArray(c) ? c : []; } catch (e) { return []; } },
    write: function (a) { try { localStorage.setItem('raf_cart', JSON.stringify(a)); } catch (e) {} Cart.badge(); },
    line: function (key) { return Cart.read().find(function (l) { return l.key === key; }); },
    firstForProduct: function (id) { return Cart.read().find(function (l) { return l.id === id; }); },
    add: function (p, variant) {
      var a = Cart.read(), key = keyOf(p.id, variant), ex = a.find(function (l) { return l.key === key; });
      if (ex) ex.qty++;
      else a.push({ key: key, id: p.id, name: { ar: p.ar, en: p.en }, price: p.price, qty: 1, variant: variant || {} });
      Cart.write(a); return key;
    },
    setQty: function (key, q) {
      var a = Cart.read(), i = a.findIndex(function (l) { return l.key === key; });
      if (i < 0) return;
      if (q <= 0) a.splice(i, 1); else a[i].qty = q;
      Cart.write(a);
    },
    count: function () { return Cart.read().reduce(function (s, l) { return s + (l.qty || 0); }, 0); },
    badge: function () {
      var n = Cart.count();
      document.querySelectorAll('#cartBadge, .cart-badge').forEach(function (b) {
        if (n > 0) { b.textContent = n > 99 ? '99+' : n; b.style.display = 'flex'; }
        else { b.style.display = 'none'; }
      });
    }
  };

  /* ---------- CSS (injected once, token-fallbacks so it works on any page) ---------- */
  function injectCSS() {
    if (document.getElementById('rc-style')) return;
    var css = `
    /* self-contained design tokens so the card looks identical on ANY page
       (including pages that redefine --card/--ink/etc., e.g. the inverted product page) */
    .rc-card,.rcv-back,.rcv{
      --card:#FFFFFF;--bg:#F5F2EC;--bg2:#EDE8DC;--bg3:#E7E1D4;
      --gold:#C9A84C;--gold2:#A07828;--gold-soft:rgba(201,168,76,.12);
      --ink:#15130F;--text:#0A0A0A;--text2:#5A5650;--text3:#8A857C;
      --border:#E2DBCC;--border2:#D8D0BE;--red:#D9534F;--green:#2E9E5B;
      --font-ar:'Tajawal',sans-serif;--font-en:'DM Sans',sans-serif;
      --sh:0 12px 30px -14px rgba(20,16,8,.28);--sh-sm:0 2px 8px rgba(20,16,8,.12);
    }
    .rc-card{width:100%;height:100%;background:var(--card,#fff);border:1px solid var(--border,#E2DBCC);border-radius:var(--rl,16px);overflow:hidden;display:flex;flex-direction:column;cursor:pointer;transition:transform .22s,box-shadow .22s;font-family:var(--font-ar,'Tajawal',sans-serif);}
    .rc-card:hover{transform:translateY(-5px);box-shadow:var(--sh,0 12px 30px -14px rgba(20,16,8,.28));}
    .rc-img{aspect-ratio:1/1;background:linear-gradient(150deg,var(--bg2,#EDE8DC),var(--bg3,#E7E1D4));display:flex;align-items:center;justify-content:center;font-size:58px;color:var(--gold2,#A07828);position:relative;background-size:cover;background-position:center;}
    .rc-img>i{line-height:1;}
    .rc-disc{position:absolute;top:12px;inset-inline-end:12px;background:var(--red,#D9534F);color:#fff;font-family:var(--font-en,'DM Sans',sans-serif);font-size:12px;font-weight:700;padding:4px 9px;border-radius:8px;}
    .rc-wish{position:absolute;top:10px;inset-inline-start:10px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.92);border:none;display:flex;align-items:center;justify-content:center;font-size:18px;color:var(--text2,#5A5650);cursor:pointer;transition:all .2s;box-shadow:var(--sh-sm,0 2px 8px rgba(20,16,8,.12));}
    .rc-wish:hover,.rc-wish.on{color:var(--red,#D9534F);}
    .rc-body{padding:13px;display:flex;flex-direction:column;gap:6px;flex:1;}
    /* fixed row heights so cards stay identical whatever the content length */
    .rc-store{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--text3,#8A857C);height:17px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
    .rc-store i{color:var(--gold2,#A07828);font-size:13px;flex-shrink:0;}
    .rc-name{font-size:14px;font-weight:700;color:var(--ink,#15130F);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;height:39px;}
    .rc-rate{display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text2,#5A5650);height:18px;}
    .rc-rate i{color:var(--gold,#C9A84C);font-size:14px;}
    .rc-rate span{color:var(--text3,#8A857C);}
    .rc-foot{display:flex;align-items:baseline;gap:8px;margin-top:auto;height:26px;flex-wrap:nowrap;overflow:hidden;}
    .rc-price{font-family:var(--font-en,'DM Sans',sans-serif);font-size:18px;font-weight:700;color:var(--ink,#15130F);}
    .rc-price small{font-size:11px;font-weight:600;color:var(--text3,#8A857C);}
    .rc-old{font-family:var(--font-en,'DM Sans',sans-serif);font-size:13px;color:var(--text3,#8A857C);text-decoration:line-through;}
    .rc-cartwrap{margin-top:11px;}
    .rc-cart{width:100%;height:38px;border:1px solid var(--border,#E2DBCC);background:var(--bg2,#EDE8DC);color:var(--ink,#15130F);border-radius:30px;font-family:var(--font-ar,'Tajawal',sans-serif);font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;transition:all .2s;}
    .rc-cart:hover{background:var(--gold,#C9A84C);color:#1C1606;border-color:var(--gold,#C9A84C);}
    .rc-cart:active{transform:scale(.97);}
    .rc-cart i{font-size:16px;}
    .rc-cart.rc-oos{background:var(--bg3,#E7E1D4);color:var(--text3,#8A857C);border-color:var(--border,#E2DBCC);cursor:not-allowed;}
    .rc-cart.rc-oos:hover{background:var(--bg3,#E7E1D4);color:var(--text3,#8A857C);border-color:var(--border,#E2DBCC);}
    .rc-card.is-oos .rc-img{filter:grayscale(1);opacity:.62;}
    .rc-oos-tag{position:absolute;top:12px;inset-inline-end:12px;display:inline-flex;align-items:center;gap:5px;background:var(--ink,#15130F);color:#F3EFE5;font-size:11.5px;font-weight:700;padding:5px 11px;border-radius:20px;box-shadow:0 4px 12px -4px rgba(20,16,8,.5);}
    .rc-oos-tag i{font-size:13px;}
    .rc-qty{width:100%;height:38px;border:1px solid var(--gold,#C9A84C);background:var(--gold-soft,rgba(201,168,76,.12));border-radius:30px;display:flex;align-items:center;justify-content:space-between;padding:0 4px;gap:4px;}
    .rc-qty .qb{width:30px;height:30px;flex:0 0 30px;border:none;border-radius:50%;background:var(--gold,#C9A84C);color:#1C1606;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;}
    .rc-qty .qb:hover{background:var(--gold2,#A07828);color:#fff;}
    .rc-qty .qb:active{transform:scale(.88);}
    .rc-qty .qb i{font-size:15px;}
    .rc-qty .qb.trash{background:transparent;border:1px solid var(--border,#E2DBCC);}
    .rc-qty .qb.trash i{color:var(--red,#D9534F);}
    .rc-qty .qb.trash:hover{background:var(--red,#D9534F);border-color:var(--red,#D9534F);}
    .rc-qty .qb.trash:hover i{color:#fff;}
    .rc-qn{font-family:var(--font-en,'DM Sans',sans-serif);font-size:15px;font-weight:800;color:var(--ink,#15130F);flex:1;text-align:center;}
    /* grid helper for listing pages */
    .rc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px;}
    @media(max-width:560px){.rc-grid{grid-template-columns:1fr 1fr;gap:12px;}.rc-img{font-size:46px;}.rc-name{font-size:13px;}}

    /* ===== VARIANT SELECTOR (modal / bottom sheet) ===== */
    .rcv-back{position:fixed;inset:0;background:rgba(20,16,8,.5);backdrop-filter:blur(2px);z-index:3000;display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .2s;}
    .rcv-back.show{opacity:1;}
    .rcv{width:100%;max-width:420px;background:var(--card,#fff);border:1px solid var(--border,#E2DBCC);border-radius:20px;box-shadow:0 30px 70px -20px rgba(20,16,8,.5);font-family:var(--font-ar,'Tajawal',sans-serif);transform:translateY(12px);transition:transform .22s;max-height:92vh;overflow:auto;}
    .rcv-back.show .rcv{transform:none;}
    .rcv-head{display:flex;gap:14px;align-items:center;padding:18px;border-bottom:1px solid var(--border,#E2DBCC);}
    .rcv-img{width:62px;height:62px;border-radius:12px;background:linear-gradient(150deg,var(--bg2,#EDE8DC),var(--bg3,#E7E1D4));display:flex;align-items:center;justify-content:center;font-size:28px;color:var(--gold2,#A07828);flex-shrink:0;background-size:cover;background-position:center;}
    .rcv-name{font-size:15px;font-weight:700;color:var(--ink,#15130F);line-height:1.3;}
    .rcv-price{font-family:var(--font-en,'DM Sans',sans-serif);font-weight:700;color:var(--gold2,#A07828);margin-top:4px;}
    .rcv-x{margin-inline-start:auto;width:34px;height:34px;border-radius:50%;border:1px solid var(--border,#E2DBCC);background:var(--bg,#F5F2EC);color:var(--text2,#5A5650);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
    .rcv-x:hover{border-color:var(--red,#D9534F);color:var(--red,#D9534F);}
    .rcv-body{padding:18px;}
    .rcv-grp{margin-bottom:18px;}
    .rcv-glabel{font-size:13px;font-weight:700;color:var(--ink,#15130F);margin-bottom:10px;display:flex;align-items:center;gap:6px;}
    .rcv-glabel .req{color:var(--red,#D9534F);}
    .rcv-glabel .pick{margin-inline-start:auto;font-size:11.5px;font-weight:500;color:var(--text3,#8A857C);}
    .rcv-opts{display:flex;flex-wrap:wrap;gap:8px;}
    .rcv-opt{min-width:46px;padding:9px 14px;border:1px solid var(--border2,#D8D0BE);border-radius:30px;background:var(--card,#fff);color:var(--text,#0A0A0A);font-family:var(--font-ar,'Tajawal',sans-serif);font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;}
    .rcv-opt:hover{border-color:var(--gold,#C9A84C);}
    .rcv-opt.on{background:var(--ink,#15130F);color:#F5F0E4;border-color:var(--ink,#15130F);}
    .rcv-foot{padding:0 18px 18px;}
    .rcv-add{width:100%;height:50px;border:none;border-radius:30px;background:var(--gold,#C9A84C);color:#1C1606;font-family:var(--font-ar,'Tajawal',sans-serif);font-size:15px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:all .2s;box-shadow:0 8px 20px -10px rgba(201,168,76,.7);}
    .rcv-add:hover{background:var(--gold2,#A07828);color:#fff;}
    .rcv-add:disabled{background:var(--bg3,#E7E1D4);color:var(--text3,#8A857C);box-shadow:none;cursor:not-allowed;}
    .rcv-hint{text-align:center;font-size:12px;color:var(--red,#D9534F);margin-top:10px;min-height:16px;}
    @media(max-width:560px){
      .rcv-back{align-items:flex-end;padding:0;}
      .rcv{max-width:100%;border-radius:22px 22px 0 0;transform:translateY(100%);}
      .rcv-back.show .rcv{transform:none;}
    }
    `;
    var s = document.createElement('style'); s.id = 'rc-style'; s.textContent = css; document.head.appendChild(s);
  }

  /* ---------- card cart control (Add button OR qty stepper) ---------- */
  function cartCtrlHTML(p) {
    var line = Cart.firstForProduct(p.id);
    if (line) {
      var trash = line.qty <= 1, ic = trash ? 'ti-trash' : 'ti-minus';
      return '<div class="rc-qty" data-key="' + line.key + '">' +
        '<button class="qb qminus' + (trash ? ' trash' : '') + '" onclick="RAFCard.dec(event,this)" aria-label="decrease"><i class="ti ' + ic + '"></i></button>' +
        '<span class="rc-qn">' + line.qty + '</span>' +
        '<button class="qb qplus" onclick="RAFCard.inc(event,this)" aria-label="increase"><i class="ti ti-plus"></i></button></div>';
    }
    if (isOOS(p)) {
      return '<button class="rc-cart rc-oos" disabled aria-disabled="true"><i class="ti ti-ban"></i> ' +
        '<span>' + T('نفدت الكمية', 'Sold Out') + '</span></button>';
    }
    var hasV = p.variants && p.variants.length;
    return '<button class="rc-cart" onclick="RAFCard.addClick(event,this)"><i class="ti ' + (hasV ? 'ti-adjustments-horizontal' : 'ti-shopping-cart-plus') + '"></i> ' +
      '<span>' + T('أضف للسلة', 'Add to Cart') + '</span></button>';
  }

  /* Availability comes from the shared resolver so a stale wishlist/search
     snapshot can never disagree with the live catalog. Standalone fallback
     kept for pages that render cards without the data layer. */
  function isOOS(p) {
    if (window.RAFShop && RAFShop.Stock) return RAFShop.Stock.isOOS(p);
    return !!p && (p.stock === 0 || p.available === false || p.outOfStock === true);
  }

  /* ---------- render one card ---------- */
  function product(p, opts) {
    opts = opts || {};
    if (!p.id) p.id = 'rc' + (++_uid);
    REG[p.id] = p;
    var o = {
      wish: opts.wish !== false, store: opts.store !== false,
      rating: opts.rating !== false, cart: opts.cart !== false,
      /* Multi-store listings open the lightweight Quick Order page.
         Single-store contexts (e.g. the Store page) pass opts.href or
         opts.hrefFor(p) to go straight to full Product Details instead. */
      href: (typeof opts.hrefFor === 'function' ? opts.hrefFor(p) : null) ||
            opts.href || p.href || 'raf_quick.html?id=' + encodeURIComponent(p.id)
    };
    var imgStyle = p.img ? ' style="background-image:url(\'' + p.img + '\')"' : '';
    var imgInner = p.img ? '' : '<i class="ti ' + (p.ic || 'ti-box') + '"></i>';
    return '<article class="rc-card' + (isOOS(p) ? ' is-oos' : '') + '" data-id="' + p.id + '" data-href="' + o.href + '" onclick="RAFCard.go(this)">' +
      '<div class="rc-img"' + imgStyle + '>' + imgInner +
        (isOOS(p) ? '<span class="rc-oos-tag"><i class="ti ti-ban"></i> ' + T('نفدت الكمية', 'Sold Out') + '</span>' : '') +
        (p.disc && !isOOS(p) ? '<span class="rc-disc">-' + p.disc + '%</span>' : '') +
        (o.wish ? (function(){ var w = (window.RAFShop && RAFShop.Wish.has(p.id)); return '<button class="rc-wish' + (w ? ' on' : '') + '" onclick="RAFCard.wish(event,this)" aria-label="wishlist"><i class="ti ' + (w ? 'ti-heart-filled' : 'ti-heart') + '"></i></button>'; })() : '') +
      '</div>' +
      '<div class="rc-body">' +
        (o.store && p.store ? '<div class="rc-store"><i class="ti ti-building-store"></i> ' + L(p.store) + '</div>' : '') +
        '<div class="rc-name">' + L(p) + '</div>' +
        (o.rating && p.rate ? '<div class="rc-rate"><i class="ti ti-star-filled"></i> ' + p.rate + (p.rev ? ' <span>(' + p.rev + ')</span>' : '') + '</div>' : '') +
        '<div class="rc-foot"><span class="rc-price">' + p.price + ' <small>' + kwd() + '</small></span>' + (p.old ? '<span class="rc-old">' + p.old + '</span>' : '') + '</div>' +
        (o.cart ? '<div class="rc-cartwrap" onclick="event.stopPropagation()">' + cartCtrlHTML(p) + '</div>' : '') +
      '</div></article>';
  }

  /* ---------- re-render every card of a product (keep in sync) ---------- */
  function refresh(id) {
    var p = REG[id]; if (!p) return;
    document.querySelectorAll('.rc-card[data-id="' + id + '"] .rc-cartwrap').forEach(function (w) { w.innerHTML = cartCtrlHTML(p); });
  }

  /* ---------- interactions ---------- */
  /* Multi-store cards target raf_quick.* → go straight to the owning Store
     page and request the Quick Order sheet in the same step, so the store is
     already the page behind the sheet. Single-store cards target
     raf_product.html and navigate normally. */
  function isQuickTarget(h) { return /raf_quick\.(html|js)?/.test(h || ''); }
  /* actually open the sheet / navigate to the owning store */
  function openQuick(p) {
    /* already inside the store → just open the sheet, no navigation */
    if (/raf_store\.html$/i.test(location.pathname)) { RAFQuick.open(p.id); return; }
    window.location = RAFQuick.urlFor(p);
  }
  /* ONE CART PER STORE — when the cart belongs to another store the customer
     is asked BEFORE anything opens or navigates: empty the current cart, cancel,
     or keep both by starting a separate cart. Cancelling leaves them exactly
     where they are: no Quick Order sheet, no store change, cart untouched. */
  function quickFlow(p) {
    if (!window.RAFQuick || !p) return false;
    if (window.RAFQuick.isOpen && RAFQuick.isOpen()) return true;
    var Sh = window.RAFShop;
    /* a sold-out product can't be added, so it must never prompt to clear the
       cart — browsing it is still allowed */
    if (Sh && Sh.Cart.conflicts && !isOOS(p) && Sh.Cart.conflicts(p)) {
      var cur = Sh.Cart.storeLabelForKey(Sh.Cart.currentStore()), next = Sh.Cart.storeLabel(p);
      Sh.Cart.confirmSwitch(cur, next).then(function (choice) {
        if (!choice) return;                   /* cancelled → stay put, nothing opens */
        /* separate → keep the old cart aside; empty → discard it */
        if (choice === 'separate') Sh.Carts.park();
        else Sh.Cart.clear();
        refreshAll();
        openQuick(p);
      });
      return true;                             /* handled — never fall through to navigation */
    }
    openQuick(p);
    return true;
  }
  /* re-render every card's cart control (after the cart is cleared) */
  function refreshAll() {
    document.querySelectorAll('.rc-card').forEach(function (c) {
      var w = c.querySelector('.rc-cartwrap');
      if (w && REG[c.dataset.id]) w.innerHTML = cartCtrlHTML(REG[c.dataset.id]);
    });
  }
  function go(card) {
    var h = card.getAttribute('data-href');
    if (isQuickTarget(h) && quickFlow(REG[card.dataset.id])) return;
    if (h) window.location = h;
  }
  function wish(e, btn) {
    e.preventDefault(); e.stopPropagation();
    var p = prodFromEl(btn), on;
    if (window.RAFShop && p) { on = RAFShop.Wish.toggle(p); }
    else { on = !btn.classList.contains('on'); }
    btn.classList.toggle('on', on);
    btn.querySelector('i').className = 'ti ' + (on ? 'ti-heart-filled' : 'ti-heart');
  }

  function prodFromEl(el) { var c = el.closest('.rc-card'); return c ? REG[c.dataset.id] : null; }

  function addClick(e, btn) {
    e.preventDefault(); e.stopPropagation();
    var p = prodFromEl(btn); if (!p || isOOS(p)) return;   /* never add unavailable products */
    /* on multi-store listings "Add to Cart" follows the same flow: land on the
       Store page with Quick Order open on top */
    var card = btn.closest('.rc-card');
    if (card && isQuickTarget(card.getAttribute('data-href')) && quickFlow(p)) return;
    if (p.variants && p.variants.length) openVariants(p);  /* variants are required before adding */
    else guardedAdd(p, {});
  }

  /* single funnel for every add — enforces availability + one-store-per-order */
  function guardedAdd(p, variant) {
    if (isOOS(p)) {
      if (window.RAFShop && RAFShop.toast) RAFShop.toast(T('نفدت كمية هذا المنتج', 'This product is sold out'), { icon: 'ti-ban' });
      refresh(p.id);
      return Promise.resolve({ added: false, oos: true });
    }
    if (Cart.tryAdd) {
      return Cart.tryAdd(p, variant).then(function (r) {
        if (r.cleared || r.separate) refreshAll(); else refresh(p.id);
        if (r.separate && window.RAFShop && RAFShop.toast) {
          RAFShop.toast(T('تم إنشاء سلة منفصلة لهذا المتجر', 'A separate cart was created for this store'), { icon: 'ti-shopping-cart-plus' });
        }
        return r;
      });
    }
    Cart.add(p, variant); refresh(p.id);
    return Promise.resolve({ added: true });
  }
  function inc(e, btn) {
    e.preventDefault(); e.stopPropagation();
    var key = btn.closest('.rc-qty').dataset.key, l = Cart.line(key);
    if (!l) return;
    /* one shared ceiling: never take more units than are actually available */
    if (window.RAFRules) {
      var c = RAFRules.clampQty(l.id, l.qty + 1);
      if (c.capped) {
        if (window.RAFShop && RAFShop.toast) RAFShop.toast(c.reason, { icon: 'ti-alert-circle' });
        if (c.qty !== l.qty) { Cart.setQty(key, c.qty); refresh(l.id); }
        return;
      }
    }
    Cart.setQty(key, l.qty + 1); refresh(l.id);
  }
  function dec(e, btn) { e.preventDefault(); e.stopPropagation(); var key = btn.closest('.rc-qty').dataset.key, l = Cart.line(key); if (l) { var id = l.id; Cart.setQty(key, l.qty - 1); refresh(id); } }

  /* ---------- variant selector ---------- */
  var sel = {}, curP = null;
  function openVariants(p) {
    injectCSS();
    curP = p; sel = {};
    var imgStyle = p.img ? ' style="background-image:url(\'' + p.img + '\')"' : '';
    var imgInner = p.img ? '' : '<i class="ti ' + (p.ic || 'ti-box') + '"></i>';
    var groups = p.variants.map(function (g, gi) {
      var opts = g.options.map(function (op) {
        return '<button class="rcv-opt" data-g="' + gi + '" data-v="' + op.v + '" onclick="RAFCard._pick(this)">' + L(op.label || op) + '</button>';
      }).join('');
      return '<div class="rcv-grp"><div class="rcv-glabel">' + L(g.label) + ' <span class="req">*</span>' +
        '<span class="pick">' + T('مطلوب', 'Required') + '</span></div><div class="rcv-opts">' + opts + '</div></div>';
    }).join('');
    var html = '<div class="rcv-back" id="rcvBack" onclick="if(event.target===this)RAFCard.closeV()">' +
      '<div class="rcv" role="dialog" aria-modal="true">' +
        '<div class="rcv-head"><div class="rcv-img"' + imgStyle + '>' + imgInner + '</div>' +
          '<div><div class="rcv-name">' + L(p) + '</div><div class="rcv-price">' + p.price + ' ' + kwd() + '</div></div>' +
          '<button class="rcv-x" onclick="RAFCard.closeV()" aria-label="close"><i class="ti ti-x"></i></button></div>' +
        '<div class="rcv-body">' + groups + '</div>' +
        '<div class="rcv-foot"><button class="rcv-add" id="rcvAdd" disabled onclick="RAFCard._confirm()"><i class="ti ti-shopping-cart-plus"></i> ' +
          '<span>' + T('اختر الخيارات المطلوبة', 'Select required options') + '</span></button>' +
          '<div class="rcv-hint" id="rcvHint"></div></div>' +
      '</div></div>';
    var wrap = document.createElement('div'); wrap.innerHTML = html; document.body.appendChild(wrap.firstChild);
    requestAnimationFrame(function () { document.getElementById('rcvBack').classList.add('show'); });
    document.documentElement.style.overflow = 'hidden';
    /* A5 — this variant picker is part of the Quick Add flow, so it closes
       with the same downward swipe as every other RAF sheet */
    if (window.RAFSwipe) {
      var sheet = document.querySelector('#rcvBack .rcv');
      if (sheet) RAFSwipe.attach(sheet, closeV);
    }
  }
  function _pick(btn) {
    var g = btn.dataset.g;
    btn.parentElement.querySelectorAll('.rcv-opt').forEach(function (b) { b.classList.remove('on'); });
    btn.classList.add('on');
    sel['g' + g] = btn.dataset.v;
    var complete = curP.variants.every(function (_, gi) { return sel['g' + gi] != null; });
    var add = document.getElementById('rcvAdd');
    add.disabled = !complete;
    add.querySelector('span').textContent = complete ? T('أضف إلى السلة', 'Add to Cart') : T('اختر الخيارات المطلوبة', 'Select required options');
  }
  function _confirm() {
    var variant = {};
    curP.variants.forEach(function (g, gi) {
      var v = sel['g' + gi];
      // store readable label for the chosen value
      var opt = g.options.find(function (o) { return String(o.v) === String(v); });
      variant[L(g.label)] = opt ? L(opt.label || opt) : v;
    });
    var prod = curP;
    closeV();
    guardedAdd(prod, variant);
  }
  function closeV() {
    var b = document.getElementById('rcvBack'); if (!b) return;
    if (window.RAFSwipe) {
      var sheet = b.querySelector('.rcv');
      if (sheet) RAFSwipe.detach(sheet);            /* listeners never outlive the sheet */
    }
    b.classList.remove('show');
    document.documentElement.style.overflow = '';
    setTimeout(function () { if (b.parentNode) b.parentNode.removeChild(b); }, 220);
  }

  /* ---------- variant inference for legacy cards (by category / name) ---------- */
  function guessVariants(cat, name) {
    var c = (cat || '') + ' ' + (name || ''); var has = function (re) { return re.test(c); };
    var size = function (arr) { return { label: { ar: 'المقاس', en: 'Size' }, options: arr.map(function (v) { return { v: ('' + v).toLowerCase(), label: { ar: '' + v, en: '' + v } }; }) }; };
    var color = function () { return { label: { ar: 'اللون', en: 'Color' }, options: [{ v: 'black', label: { ar: 'أسود', en: 'Black' } }, { v: 'white', label: { ar: 'أبيض', en: 'White' } }, { v: 'navy', label: { ar: 'كحلي', en: 'Navy' } }] }; };
    if (has(/حذاء|أحذية|shoe|sneak|boot/i)) return [size([40, 41, 42, 43, 44])];
    if (has(/قميص|فستان|جاكيت|تيشيرت|تيشرت|هودي|ملابس|أزياء|بنطلون|شورت|بولو|shirt|dress|jacket|hoodie|trouser|short|polo|fashion/i)) return [size(['S', 'M', 'L', 'XL']), color()];
    if (has(/عطر|perfume|fragrance|عود/i)) return [{ label: { ar: 'الحجم', en: 'Volume' }, options: [{ v: '50', label: { ar: '50 مل', en: '50 ml' } }, { v: '100', label: { ar: '100 مل', en: '100 ml' } }] }];
    if (has(/iphone|آيفون|هاتف|جوال|phone|laptop|حاسب|تابلت|tablet/i)) return [{ label: { ar: 'السعة', en: 'Storage' }, options: [{ v: '128', label: { ar: '128GB', en: '128GB' } }, { v: '256', label: { ar: '256GB', en: '256GB' } }] }, color()];
    if (has(/سماع|earbud|headphone|ساعة|watch|إلكترون|electronic|كاميرا|camera|نظار|sunglass/i)) return [color()];
    if (has(/حقيب|bag|backpack/i)) return [{ label: { ar: 'اللون', en: 'Color' }, options: [{ v: 'brown', label: { ar: 'بني', en: 'Brown' } }, { v: 'black', label: { ar: 'أسود', en: 'Black' } }] }];
    return null;
  }

  /* ---------- audit & replace any legacy card in-place with the global card ---------- */
  function upgradeAll(cfg) {
    cfg = cfg || {}; injectCSS();
    var nodes = [].slice.call(document.querySelectorAll(cfg.selector || '.prod-card'));
    nodes.forEach(function (el) {
      var q = function (s) { try { return el.querySelector(s); } catch (e) { return null; } };
      var txt = function (s) { var n = q(s); return n ? n.textContent.replace(/\s+/g, ' ').trim() : ''; };
      var num = function (s) { var m = txt(s).match(/\d[\d.,]*/); return m ? m[0] : ''; };
      var name = txt(cfg.name || '.prod-name,.product-name,.wish-name,.listing-name,.card-name,.p-name');
      if (!name) return;
      var price = num(cfg.price || '.price-new,.product-price,.wish-price,.price,.card-price');
      var old = num(cfg.old || '.price-old,.product-price-old,.old-price');
      var store = cfg.storeName || el.getAttribute('data-store') || txt('.prod-store,.product-store,.wish-store,.card-store');
      var rt = txt(cfg.rate || '.prod-rating,.product-rating,.rating,.card-rating');
      var rate = (rt.match(/\d+(\.\d+)?/) || [''])[0]; var rev = (rt.match(/\((\d+)\)/) || ['', ''])[1] || '';
      var disc = el.getAttribute('data-disc') || (txt('.disc-badge,.product-sale,.disc-pct').match(/\d+/) || [''])[0];
      var ie = q('.prod-img i,.product-img i,.wish-img i,.listing-img i,.img i,i.ti');
      var ic = ie ? ((ie.className.match(/ti-[\w-]+/) || ['ti-box'])[0]) : 'ti-box';
      var cat = el.getAttribute('data-cat') || '';
      var id = el.getAttribute('data-pid') || txt('.prod-num') || (cfg.idPrefix || 'U') + (++_uid);
      var p = { id: id, ar: name, en: name, store: store ? { ar: store, en: store } : null, price: price || '', old: old || '', disc: disc ? parseInt(disc) : 0, rate: rate, rev: rev, ic: ic, cat: cat };
      p.variants = cfg.variantsFn ? cfg.variantsFn(p) : (cfg.variants === false ? null : guessVariants(cat, name));
      el.insertAdjacentHTML('beforebegin', product(p, cfg.opts || {}));
      el.parentNode.removeChild(el);
    });
    Cart.badge();
  }

  /* ---------- public API ---------- */
  window.RAFCard = {
    upgradeAll: upgradeAll, guessVariants: guessVariants, isOOS: isOOS,
    product: product, refresh: refresh, go: go, wish: wish,
    addClick: addClick, inc: inc, dec: dec,
    openVariants: openVariants, closeV: closeV, _pick: _pick, _confirm: _confirm,
    register: function (p) { if (p && p.id) REG[p.id] = p; },
    badge: function () { Cart.badge(); }
  };
  window.RAFCart = Cart;

  injectCSS();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', Cart.badge);
  else Cart.badge();
  // keep cards in sync when language flips
  new MutationObserver(function () {
    document.querySelectorAll('.rc-card').forEach(function (c) { if (REG[c.dataset.id]) { /* labels re-render on next render; refresh cart control text */ } });
  }).observe(root(), { attributes: true, attributeFilter: ['lang'] });
})();
