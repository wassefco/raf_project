/* ============================================================
   RAF Quick Order — bottom-sheet modal (replaces the standalone page)
   Opens instantly over any multi-store listing and warms the owning
   Store page in the background, so finishing the sheet lands the
   customer inside that store with no extra navigation delay.
   Single Store Shopping is still enforced by RAFShop.Cart.tryAdd.
   ============================================================ */
(function () {
  if (window.RAFQuick) return;

  function root(){ return document.getElementById('htmlRoot') || document.documentElement; }
  function en(){ return root().lang === 'en'; }
  function T(ar,e){ return en()?e:ar; }
  function L(o){ return (o&&typeof o==='object')?(en()?o.en:o.ar):(o||''); }
  function money(n){ return (Math.round(n*1000)/1000).toFixed(3); }

  var P=null, sel={}, qty=1, prefetched=null, busy=false;

  /* availability resolved by the shared rule (same as every listing card) */
  function isOOS(p){
    if(window.RAFShop && RAFShop.Stock) return RAFShop.Stock.isOOS(p);
    return !!p && (p.stock===0 || p.available===false);
  }

  /* ---------- styles ---------- */
  function css(){
    if(document.getElementById('rq-css')) return;
    var s=document.createElement('style'); s.id='rq-css';
    s.textContent = [
'.rq-back{position:fixed;inset:0;z-index:5400;display:flex;align-items:flex-end;justify-content:center;',
'  background:rgba(20,16,8,.55);backdrop-filter:blur(3px);opacity:0;transition:opacity .26s;font-family:var(--font,"Tajawal",sans-serif);}',
'.rq-back.show{opacity:1;}',
'@media(min-width:861px){.rq-back{align-items:center;padding:24px;}}',
'.rq{position:relative;width:100%;max-width:560px;max-height:92vh;overflow:hidden auto;background:var(--card,#fff);',
'  border:1px solid var(--border,#E2DBCC);border-bottom:none;border-radius:26px 26px 0 0;',
'  box-shadow:0 -18px 60px -20px rgba(20,16,8,.5);transform:translateY(100%);transition:transform .32s cubic-bezier(.22,1,.36,1);}',
'.rq-back.show .rq{transform:none;}',
'@media(min-width:861px){.rq{border-radius:26px;border-bottom:1px solid var(--border,#E2DBCC);transform:translateY(18px) scale(.98);}',
'  .rq-back.show .rq{transform:none;}}',
'@media(prefers-reduced-motion:reduce){.rq,.rq-back{transition:none;}}',
/* grabber + close */
'.rq-grab{position:sticky;top:0;z-index:3;background:var(--card,#fff);padding:10px 0 6px;display:flex;justify-content:center;}',
'.rq-grab i{width:44px;height:5px;border-radius:5px;background:var(--border2,#D8D0BE);display:block;}',
'.rq-x{position:absolute;top:12px;inset-inline-end:12px;z-index:4;width:36px;height:36px;border-radius:50%;border:1px solid var(--border,#E2DBCC);',
'  background:var(--bg,#F5F2EC);color:var(--text2,#5A5650);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;}',
'.rq-x:hover{border-color:var(--red,#D9534F);color:var(--red,#D9534F);}',
/* hero */
'.rq-hero{display:flex;gap:15px;padding:6px 20px 0;}',
'.rq-img{position:relative;width:112px;height:112px;flex-shrink:0;border-radius:18px;overflow:hidden;',
'  background:linear-gradient(150deg,var(--bg2,#EDE8DC),var(--bg3,#E7E1D4));display:flex;align-items:center;justify-content:center;',
'  font-size:46px;color:var(--gold2,#A07828);}',
'.rq-disc{position:absolute;top:7px;inset-inline-start:7px;background:var(--red,#D9534F);color:#fff;font-family:var(--fen,"DM Sans",sans-serif);',
'  font-size:11px;font-weight:800;padding:3px 8px;border-radius:20px;}',
'.rq-hb{flex:1;min-width:0;}',
'.rq-store{display:inline-flex;align-items:center;gap:6px;background:var(--gold-soft,rgba(201,168,76,.12));',
'  border:1px solid rgba(201,168,76,.3);border-radius:30px;padding:4px 11px;font-size:11.5px;font-weight:700;',
'  color:var(--gold2,#A07828);text-decoration:none;}',
'.rq-store i{font-size:14px;}',
'.rq-name{font-family:var(--fdisplay,"Playfair Display",serif);font-size:19px;font-weight:800;color:var(--ink,#15130F);line-height:1.35;margin:9px 0 6px;}',
'.rq-rate{display:flex;align-items:center;gap:5px;font-size:12.5px;color:var(--text2,#5A5650);}',
'.rq-rate i{color:var(--gold,#C9A84C);font-size:14px;}',
'.rq-price{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-top:9px;}',
'.rq-price b{font-family:var(--fen,"DM Sans",sans-serif);font-size:23px;font-weight:800;color:var(--ink,#15130F);}',
'.rq-price small{font-size:12px;color:var(--text3,#8A857C);font-weight:600;}',
'.rq-price del{font-family:var(--fen,"DM Sans",sans-serif);font-size:13px;color:var(--text3,#8A857C);}',
'.rq-stock{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:700;margin-top:8px;}',
'.rq-stock.ok{color:var(--green,#2E9E5B);}.rq-stock.low{color:#C8791E;}.rq-stock.out{color:var(--red,#D9534F);}',
/* body */
'.rq-b{padding:16px 20px 0;}',
'.rq-sec{margin-top:18px;}',
'.rq-l{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:var(--ink,#15130F);margin-bottom:9px;}',
'.rq-l .req{color:var(--red,#D9534F);}',
'.rq-l .pick{margin-inline-start:auto;font-size:11.5px;font-weight:600;color:var(--text3,#8A857C);}',
'.rq-opts{display:flex;flex-wrap:wrap;gap:8px;}',
'.rq-o{min-width:46px;padding:9px 15px;border:1.5px solid var(--border2,#D8D0BE);border-radius:11px;background:var(--card,#fff);',
'  color:var(--text2,#5A5650);font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;transition:all .18s;}',
'.rq-o:hover{border-color:var(--gold,#C9A84C);color:var(--gold2,#A07828);}',
'.rq-o.on{background:var(--ink,#15130F);color:#F5F0E4;border-color:var(--ink,#15130F);}',
'.rq-o:focus-visible,.rq-sw:focus-visible{outline:2px solid var(--gold,#C9A84C);outline-offset:2px;}',
'.rq-sw{display:inline-flex;align-items:center;gap:7px;padding:6px 13px 6px 7px;border:1.5px solid var(--border2,#D8D0BE);',
'  border-radius:30px;background:var(--card,#fff);color:var(--text2,#5A5650);font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;transition:all .18s;}',
'[dir="rtl"] .rq-sw{padding:6px 7px 6px 13px;}',
'.rq-sw:hover{border-color:var(--gold,#C9A84C);}',
'.rq-sw.on{border-color:var(--ink,#15130F);background:var(--bg2,#EDE8DC);color:var(--ink,#15130F);}',
'.rq-sw .dot{width:20px;height:20px;border-radius:50%;border:1px solid rgba(20,16,8,.18);flex-shrink:0;}',
'.rq-qty{display:inline-flex;align-items:center;border:1.5px solid var(--border2,#D8D0BE);border-radius:30px;overflow:hidden;background:var(--card,#fff);}',
'.rq-qty button{width:42px;height:42px;border:none;background:transparent;color:var(--text2,#5A5650);font-size:16px;cursor:pointer;',
'  display:flex;align-items:center;justify-content:center;transition:background .15s;}',
'.rq-qty button:hover:not(:disabled){background:var(--gold-soft,rgba(201,168,76,.12));color:var(--gold2,#A07828);}',
'.rq-qty button:disabled{opacity:.4;cursor:not-allowed;}',
'.rq-qty span{min-width:44px;text-align:center;font-family:var(--fen,"DM Sans",sans-serif);font-size:15px;font-weight:800;color:var(--ink,#15130F);}',
'.rq-notes{width:100%;min-height:58px;border:1.5px solid var(--border2,#D8D0BE);border-radius:11px;background:#FCFBF8;padding:10px 12px;',
'  font-family:inherit;font-size:13px;color:var(--text,#0A0A0A);outline:none;resize:vertical;line-height:1.7;}',
'.rq-notes:focus{border-color:var(--gold,#C9A84C);box-shadow:0 0 0 3px var(--gold-soft,rgba(201,168,76,.12));}',
'.rq-hint{display:none;align-items:center;gap:6px;font-size:12.5px;color:var(--red,#D9534F);margin-top:10px;}',
'.rq-hint.show{display:flex;}',
'.rq-full{display:inline-flex;align-items:center;gap:6px;margin-top:14px;font-size:12.5px;font-weight:700;',
'  color:var(--gold2,#A07828);text-decoration:none;}',
'.rq-full:hover{text-decoration:underline;}',
/* footer bar */
'.rq-f{position:sticky;bottom:0;background:var(--card,#fff);border-top:1px solid var(--border,#E2DBCC);',
'  padding:13px 20px;padding-bottom:calc(13px + env(safe-area-inset-bottom,0px));display:flex;align-items:center;gap:13px;margin-top:18px;}',
'.rq-tot small{display:block;font-size:10.5px;color:var(--text3,#8A857C);}',
'.rq-tot b{font-family:var(--fen,"DM Sans",sans-serif);font-size:19px;font-weight:800;color:var(--ink,#15130F);}',
'.rq-add{flex:1;height:52px;border:1px solid var(--gold2,#A07828);border-radius:30px;background:var(--gold,#C9A84C);color:#1C1606;',
'  font-family:inherit;font-size:15px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:8px;',
'  transition:all .2s;box-shadow:0 10px 22px -12px rgba(201,168,76,.8);}',
'.rq-add:hover:not(:disabled){background:var(--gold2,#A07828);color:#fff;}',
'.rq-add:disabled{background:var(--bg3,#E7E1D4);color:var(--text3,#8A857C);border-color:var(--border,#E2DBCC);box-shadow:none;cursor:not-allowed;}',
'.rq-add i{font-size:19px;}',
'body.rq-lock{overflow:hidden;}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------- background store warm-up ---------- */
  function storeUrl(){ return 'raf_store.html?store=' + encodeURIComponent((P && P.slug) || ''); }
  function warmStore(){
    var url = storeUrl();
    if (prefetched === url) return;
    prefetched = url;
    /* prefetch loads the Store page in the background so finishing the sheet
       lands there instantly, with no extra navigation delay */
    var l = document.createElement('link');
    l.rel = 'prefetch'; l.href = url; l.as = 'document';
    l.id = 'rq-prefetch';
    var old = document.getElementById('rq-prefetch'); if (old) old.remove();
    document.head.appendChild(l);
  }

  /* ---------- render ---------- */
  function html(){
    var out = isOOS(P);
    var saved = P.old ? (parseFloat(P.old) - parseFloat(P.price)) : 0;
    return '<div class="rq" role="dialog" aria-modal="true" aria-label="'+T('طلب سريع','Quick Order')+'">'
      + '<button class="rq-x" aria-label="'+T('إغلاق','Close')+'"><i class="ti ti-x"></i></button>'
      + '<div class="rq-grab"><i></i></div>'
      + '<div class="rq-hero">'
        + '<div class="rq-img"><i class="ti '+(P.ic||'ti-box')+'"></i>'
          + (P.disc?'<span class="rq-disc">-'+P.disc+'%</span>':'') + '</div>'
        + '<div class="rq-hb">'
          + '<a class="rq-store" href="'+storeUrl()+'"><i class="ti ti-building-store"></i> '+L(P.store)+'</a>'
          + '<div class="rq-name">'+L(P)+'</div>'
          + (P.rate?'<div class="rq-rate"><i class="ti ti-star-filled"></i> '+P.rate+(P.rev?' <span style="color:var(--text3)">('+P.rev+')</span>':'')+'</div>':'')
          + '<div class="rq-price"><b>'+P.price+'</b><small>'+T('د.ك','KWD')+'</small>'
            + (P.old?'<del>'+P.old+'</del>':'') + '</div>'
          + stockHTML()
        + '</div></div>'
      + '<div class="rq-b">'
        + optionsHTML()
        + '<div class="rq-sec"><div class="rq-l"><i class="ti ti-stack-2"></i> '+T('الكمية','Quantity')+'</div>'
          + '<div class="rq-qty"><button data-q="-1" '+(out?'disabled':'')+' aria-label="-"><i class="ti ti-minus"></i></button>'
          + '<span id="rqNum">'+qty+'</span>'
          + '<button data-q="1" '+(out?'disabled':'')+' aria-label="+"><i class="ti ti-plus"></i></button></div></div>'
        + '<div class="rq-sec"><div class="rq-l"><i class="ti ti-note"></i> '+T('ملاحظات','Notes')
          + '<span class="pick">'+T('اختياري','Optional')+'</span></div>'
          + '<textarea class="rq-notes" id="rqNotes" placeholder="'+T('أي طلب خاص لهذا المنتج…','Any special request for this item…')+'"></textarea></div>'
        + '<div class="rq-hint" id="rqHint"><i class="ti ti-alert-circle"></i><span></span></div>'
        + '<a class="rq-full" href="raf_product.html?id='+encodeURIComponent(P.id)+'"><i class="ti ti-list-details"></i> '+T('عرض التفاصيل الكاملة','View full details')+'</a>'
      + '</div>'
      + '<div class="rq-f"><div class="rq-tot"><small>'+T('الإجمالي','Total')+'</small><b id="rqTot">'+money(parseFloat(P.price)*qty)+'</b></div>'
        + '<button class="rq-add" id="rqAdd" '+(out?'disabled':'')+'><i class="ti ti-shopping-cart-plus"></i> <span>'
        + (out?T('نفدت الكمية','Sold Out'):T('أضف ومتابعة التسوق','Add & continue shopping'))+'</span></button></div>'
      + '</div>';
  }
  function stockHTML(){
    if(isOOS(P))    return '<div class="rq-stock out"><i class="ti ti-ban"></i> '+T('نفدت الكمية','Sold Out')+'</div>';
    if(P.stock<=5)  return '<div class="rq-stock low"><i class="ti ti-flame"></i> '+T('بقي '+P.stock+' قطع فقط','Only '+P.stock+' left')+'</div>';
    return '<div class="rq-stock ok"><i class="ti ti-circle-check"></i> '+T('متوفر','In stock')+'</div>';
  }
  function optionsHTML(){
    if(!P.variants||!P.variants.length) return '';
    return P.variants.map(function(g,gi){
      var isColor=/لون|خامة|color|material/i.test(L(g.label));
      var opts=g.options.map(function(o){
        var lbl=L(o.label||o), on=sel['g'+gi]===String(o.v);
        var v=String(o.v).replace(/"/g,'&quot;');
        if(isColor&&o.hex) return '<button class="rq-sw'+(on?' on':'')+'" data-g="'+gi+'" data-v="'+v+'"><i class="dot" style="background:'+o.hex+'"></i>'+lbl+'</button>';
        return '<button class="rq-o'+(on?' on':'')+'" data-g="'+gi+'" data-v="'+v+'">'+lbl+'</button>';
      }).join('');
      return '<div class="rq-sec" data-grp="'+gi+'"><div class="rq-l">'+L(g.label)+' <span class="req">*</span>'
        + '<span class="pick">'+T('مطلوب','Required')+'</span></div><div class="rq-opts">'+opts+'</div></div>';
    }).join('');
  }

  /* ---------- open / close ---------- */
  var backEl=null, lastFocus=null;
  function open(id){
    css();
    P = window.RAFCatalog ? RAFCatalog.get(id) : null;
    if(!P){ if(window.RAFShop&&RAFShop.toast) RAFShop.toast(T('المنتج غير متاح','Product unavailable'),{icon:'ti-package-off'}); return; }
    sel={}; qty=1; busy=false;
    lastFocus=document.activeElement;
    warmStore();                                  /* Store page loads in the background */

    backEl=document.createElement('div');
    backEl.className='rq-back';
    backEl.innerHTML=html();
    document.body.appendChild(backEl);
    document.body.classList.add('rq-lock');
    requestAnimationFrame(function(){ backEl.classList.add('show'); });
    setTimeout(function(){ backEl.classList.add('show'); },30);   /* hidden-tab safe */

    backEl.addEventListener('click',onClick);
    document.addEventListener('keydown',onKey);
    var x=backEl.querySelector('.rq-x'); if(x) x.focus();
    syncQtyBtns();                                   /* apply the stock ceiling on open */
  }
  function onKey(e){ if(e.key==='Escape') finish(); }
  function onClick(e){
    if(e.target===backEl) return finish();
    var t=e.target.closest('button,a'); if(!t) return;
    if(t.classList.contains('rq-x')) return finish();
    if(t.dataset.g!=null) return pick(t);
    if(t.dataset.q) return chQty(parseInt(t.dataset.q,10));
    if(t.id==='rqAdd'||t.closest('#rqAdd')) return addAndGo();
  }
  function pick(btn){
    sel['g'+btn.dataset.g]=btn.dataset.v;
    var grp=btn.closest('.rq-sec');
    grp.querySelectorAll('.rq-o,.rq-sw').forEach(function(b){ b.classList.remove('on'); });
    btn.classList.add('on');
    var p=grp.querySelector('.pick'); if(p) p.textContent=btn.textContent.trim();
    hint('');
  }
  function chQty(d){
    /* shared ceiling — identical to the product page and the cart */
    if(window.RAFRules){
      var c=RAFRules.clampQty(P.id, qty+d);
      qty=Math.max(1,c.qty||1);
      /* tell the customer why they cannot go higher, both when they hit the
         ceiling and when they try to pass it */
      if(d>0 && (c.capped||c.atMax)) hint(T('الحد الأقصى المتاح '+c.max,'Only '+c.max+' available'));
      else if(d<0) hint('');
    } else {
      qty=Math.max(1,Math.min(P.stock||99,qty+d));
    }
    backEl.querySelector('#rqNum').textContent=qty;
    backEl.querySelector('#rqTot').textContent=money(parseFloat(P.price)*qty);
    syncQtyBtns();
  }
  function syncQtyBtns(){
    if(!backEl) return;
    var max=window.RAFRules?RAFRules.maxQty(P.id):(P.stock||99);
    var minus=backEl.querySelector('[data-q="-1"]'), plus=backEl.querySelector('[data-q="1"]');
    if(minus) minus.disabled=isOOS(P)||qty<=1;
    if(plus)  plus.disabled=isOOS(P)||max<=0||qty>=max;
  }
  function hint(msg){
    var h=backEl&&backEl.querySelector('#rqHint'); if(!h) return;
    if(!msg){ h.classList.remove('show'); return; }
    h.querySelector('span').textContent=msg; h.classList.add('show');
  }

  function addAndGo(){
    if(busy||!P||isOOS(P)) return;
    var variant={};
    if(P.variants){
      for(var gi=0;gi<P.variants.length;gi++){
        var g=P.variants[gi], v=sel['g'+gi];
        if(v==null){ hint(T('اختر '+L(g.label)+' أولاً','Please select '+L(g.label)+' first')); return; }
        var opt=g.options.find(function(o){ return String(o.v)===String(v); });
        variant[L(g.label)]=L(opt.label||opt);
      }
    }
    var notes=(backEl.querySelector('#rqNotes')||{}).value||'';
    if(notes.trim()) variant[T('ملاحظات','Notes')]=notes.trim();

    busy=true;
    var btn=backEl.querySelector('#rqAdd'); if(btn) btn.disabled=true;
    /* Single Store Shopping is enforced centrally */
    RAFShop.Cart.tryAdd(P,variant).then(function(r){
      if(!r.added){ busy=false; if(btn) btn.disabled=false; return; }
      for(var i=1;i<qty;i++) RAFShop.Cart.add(P,variant);
      RAFShop.Cart.badge();
      RAFShop.toast(T('تمت الإضافة إلى السلة','Added to your cart'),{icon:'ti-circle-check'});
      finish(true);
    }).catch(function(){ busy=false; if(btn) btn.disabled=false; });
  }

  /* Whether the sheet was completed by adding or by closing, the customer
     continues inside the same store. The Store page is already the page
     underneath (opened at the same time as the sheet), so closing simply
     dismisses the sheet — no further navigation or loading. */
  function onStorePage(){ return /raf_store\.html$/i.test(location.pathname); }
  function finish(added){
    if(!backEl) return;
    var url=storeUrl();
    backEl.classList.remove('show');
    document.removeEventListener('keydown',onKey);
    document.body.classList.remove('rq-lock');
    var el=backEl; backEl=null;
    setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); },300);
    if(lastFocus&&lastFocus.focus) try{ lastFocus.focus(); }catch(e){}
    /* only navigate when the sheet was opened somewhere other than the store */
    if(!onStorePage()) setTimeout(function(){ location.href=url; }, added?600:180);
  }

  /* URL a multi-store product card navigates to: the Store page, with the
     sheet requested via ?quick= so both happen in one step. */
  function urlFor(p){
    var name=(p && p.store && (p.store.en||p.store.ar)) || (p && p.store) || '';
    var slug=(window.RAFCatalog&&RAFCatalog.slugFor)?RAFCatalog.slugFor(name):'';
    if(!slug && window.RAFCatalog){ var c=RAFCatalog.get(p.id); if(c) slug=c.slug||''; }
    return 'raf_store.html?store='+encodeURIComponent(slug)+'&quick='+encodeURIComponent(p.id);
  }

  /* Store page: open the sheet on top when arriving with ?quick=<id> */
  function autoOpen(){
    var id=new URLSearchParams(location.search).get('quick');
    if(!id) return;
    /* drop the param so a refresh doesn't reopen the sheet */
    try{
      var u=new URL(location.href); u.searchParams.delete('quick');
      history.replaceState({},'',u.pathname+(u.search||'')+u.hash);
    }catch(e){}
    var go=function(){ open(id); };
    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',go);
    else setTimeout(go,40);
  }

  window.RAFQuick={ open:open, close:function(){ finish(false); }, isOpen:function(){ return !!backEl; },
                    urlFor:urlFor, autoOpen:autoOpen };
  autoOpen();
})();
