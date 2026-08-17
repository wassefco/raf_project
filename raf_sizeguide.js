/* ============================================================
   RAF — SIZE GUIDE
   ------------------------------------------------------------
   A shared measurement panel for products that actually sell by
   size. It never appears for anything else: callers ask
   RAFSizeGuide.forProduct(product) and only render the trigger
   when a table comes back.

   Tables are per category (clothing, shoes, rings, kids), fully
   bilingual, and measured in cm / EU sizing as used in Kuwait.
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFSizeGuide) return;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar,en){ return isEn() ? en : ar; }

  /* ---------- the tables ---------- */
  var GUIDES = {
    clothing: {
      title:{ ar:'دليل مقاسات الملابس', en:'Clothing size guide' },
      note:{ ar:'القياسات بالسنتيمتر وتخص الجسم، لا الملبس. إذا كنت بين مقاسين اختر الأكبر.',
             en:'Measurements are in centimetres and refer to the body, not the garment. Between two sizes, take the larger one.' },
      cols:[ {ar:'المقاس',en:'Size'}, {ar:'الصدر',en:'Chest'}, {ar:'الخصر',en:'Waist'}, {ar:'الطول',en:'Length'} ],
      rows:[ ['XS','84–88','68–72','66'], ['S','89–94','73–78','68'], ['M','95–100','79–84','70'],
             ['L','101–107','85–91','72'], ['XL','108–114','92–98','74'], ['XXL','115–122','99–106','76'] ]
    },
    bottoms: {
      title:{ ar:'دليل مقاسات البناطيل', en:'Trouser size guide' },
      note:{ ar:'المقاس الرقمي يشير إلى محيط الخصر بالبوصة.', en:'Numeric sizes refer to the waist measurement in inches.' },
      cols:[ {ar:'المقاس',en:'Size'}, {ar:'الخصر (سم)',en:'Waist (cm)'}, {ar:'الورك (سم)',en:'Hip (cm)'}, {ar:'طول الساق',en:'Inseam'} ],
      rows:[ ['28','71–74','88–91','76'], ['30','76–79','93–96','78'], ['32','81–84','98–101','80'],
             ['34','86–89','103–106','82'], ['36','91–94','108–111','82'], ['38','96–99','113–116','84'] ]
    },
    shoes: {
      title:{ ar:'دليل مقاسات الأحذية', en:'Shoe size guide' },
      note:{ ar:'قِس طول القدم واقفاً في نهاية اليوم. المقاسات أوروبية.',
             en:'Measure your foot standing, at the end of the day. Sizes are EU.' },
      cols:[ {ar:'أوروبي',en:'EU'}, {ar:'بريطاني',en:'UK'}, {ar:'أمريكي',en:'US'}, {ar:'طول القدم (سم)',en:'Foot length (cm)'} ],
      rows:[ ['39','6','7','24.5'], ['40','6.5','7.5','25.0'], ['41','7.5','8.5','25.8'], ['42','8','9','26.5'],
             ['43','9','10','27.3'], ['44','9.5','10.5','28.0'], ['45','10.5','11.5','28.8'] ]
    },
    rings: {
      title:{ ar:'دليل مقاسات الخواتم', en:'Ring size guide' },
      note:{ ar:'لُف شريطاً حول الإصبع وقِس المحيط بالمليمتر.', en:'Wrap a strip of paper around your finger and measure the circumference in millimetres.' },
      cols:[ {ar:'المقاس',en:'Size'}, {ar:'المحيط (مم)',en:'Circumference (mm)'}, {ar:'القطر (مم)',en:'Diameter (mm)'} ],
      rows:[ ['6','46.8','14.9'], ['7','49.3','15.7'], ['8','51.9','16.5'], ['9','54.4','17.3'],
             ['10','57.0','18.1'], ['11','59.5','18.9'], ['12','62.1','19.8'] ]
    }
  };

  /* ---------- does this product sell by size? ---------- */
  var SIZE_LABEL = /(مقاس|المقاس|size)/i;
  var VOLUME     = /(حجم|الحجم|سعة|السعة|volume|capacity|ml|gb)/i;

  /* a variant group counts as sizing only when its label says so — "الحجم 50 مل"
     (perfume volume) and "السعة 256GB" (storage) are deliberately excluded */
  function sizeGroup(product){
    var vs = (product && product.variants) || [];
    for (var i = 0; i < vs.length; i++) {
      var lb = vs[i].label || {};
      var txt = ((lb.ar || '') + ' ' + (lb.en || lb || '')).toString();
      if (SIZE_LABEL.test(txt) && !VOLUME.test(txt)) return vs[i];
    }
    return null;
  }

  /* pick the table that matches the product's category and its size values */
  function keyFor(product){
    var g = sizeGroup(product);
    if (!g) return '';
    var cat = (product && (product.cat || product.category)) || '';
    if (cat === 'shoes') return 'shoes';
    if (cat === 'jewelry') return 'rings';
    var vals = (g.options || []).map(function (o) {
      var lb = o.label || o; return String((lb.en || lb.ar || lb)).trim();
    });
    /* numeric waist sizes (28, 30, 32 …) are trousers, letters are tops */
    var numeric = vals.length && vals.every(function (v) { return /^\d{2}$/.test(v); });
    if (numeric) {
      var n = parseInt(vals[0], 10);
      if (n >= 36) return 'shoes';                      /* EU shoe range */
      return 'bottoms';
    }
    if (cat === 'fashion' || vals.some(function (v) { return /^(XS|S|M|L|XL|XXL)$/i.test(v); })) return 'clothing';
    return '';
  }

  /* ---------- product-level guide ----------
     A merchant-configured guide on the product record always wins. Products
     without one keep the category-derived tables above. Registered under a
     per-product key so the existing open(key) contract is unchanged. */
  function productGuideOf(product){
    var g = product && product.sizeGuide;
    if (!g || !g.title || !(g.cols || []).length || !(g.rows || []).length) return null;
    return g;
  }
  function registerProductGuide(product){
    var g = productGuideOf(product);
    if (!g) return '';
    var key = 'product:' + (product.id || '');
    GUIDES[key] = g;
    return key;
  }

  /* the public test: returns a guide key, or '' when there is nothing to show */
  function forProduct(product){
    return registerProductGuide(product) || keyFor(product);
  }
  function hasSizes(product){ return !!forProduct(product); }

  /* ---------- panel ---------- */
  function css(){
    if (document.getElementById('raf-sg-style')) return;
    var s = document.createElement('style'); s.id = 'raf-sg-style';
    s.textContent = [
      /* Quiet secondary control: the same pill vocabulary as the option and
         quantity buttons, one step down in weight so it never competes with
         the product options it sits under. Logical properties throughout, so
         it mirrors correctly in RTL and LTR. */
      /* 40px keeps it inside the shared touch-target floor while still reading
         a step lighter than the 44px option buttons above it */
      '.sg-link{display:inline-flex;align-items:center;gap:7px;height:40px;padding:0 14px;cursor:pointer;',
      '  border:1px solid var(--border,#E2DBCC);border-radius:30px;background:var(--card,#fff);',
      '  font-family:inherit;font-size:12.5px;font-weight:700;line-height:1;color:var(--text2,#5A5650);',
      '  text-decoration:none;transition:border-color .18s,color .18s,background .18s;}',
      '.sg-link:hover{border-color:var(--gold,#C9A84C);background:var(--gold-soft,rgba(201,168,76,.12));color:var(--gold2,#A07828);}',
      '.sg-link:focus-visible{outline:2px solid var(--gold,#C9A84C);outline-offset:2px;}',
      '.sg-link i{font-size:16px;color:var(--text3,#8A857C);transition:color .18s;}',
      '.sg-link:hover i{color:var(--gold2,#A07828);}',
      /* compact variant for the Quick Order sheet, whose controls run smaller */
      '.rq-l .sg-link{height:28px;padding:0 11px;gap:5px;font-size:11.5px;font-weight:700;}',
      '.rq-l .sg-link i{font-size:14px;}',
      '.sg-back{position:fixed;inset:0;z-index:5400;display:flex;align-items:center;justify-content:center;padding:18px;',
      '  background:rgba(20,16,8,.55);backdrop-filter:blur(3px);opacity:0;transition:opacity .2s;',
      '  font-family:var(--font-ar,"Tajawal",sans-serif);}',
      '.sg-back.show{opacity:1;}',
      '.sg{width:100%;max-width:540px;max-height:88vh;display:flex;flex-direction:column;background:var(--card,#fff);',
      '  border:1px solid var(--border,#E2DBCC);border-radius:20px;overflow:hidden;',
      '  box-shadow:0 30px 70px -22px rgba(20,16,8,.55);transform:translateY(14px);transition:transform .24s;}',
      '.sg-back.show .sg{transform:none;}',
      '.sg-h{display:flex;align-items:center;gap:12px;padding:17px 20px;border-bottom:1px solid var(--border,#E2DBCC);}',
      '.sg-h h3{flex:1;font-family:var(--font-display,"Playfair Display",serif);font-size:18px;font-weight:800;color:var(--ink,#15130F);}',
      '.sg-x{width:34px;height:34px;flex:0 0 auto;border-radius:50%;border:1px solid var(--border,#E2DBCC);background:var(--bg,#F5F2EC);',
      '  color:var(--text3,#8A857C);font-size:17px;cursor:pointer;display:flex;align-items:center;justify-content:center;}',
      '.sg-x:hover{border-color:var(--red,#D9534F);color:var(--red,#D9534F);}',
      '.sg-b{padding:16px 20px 20px;overflow:auto;}',
      '.sg-tabs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px;}',
      '.sg-tab{padding:7px 14px;border:1px solid var(--border2,#D8D0BE);border-radius:20px;background:var(--card,#fff);',
      '  color:var(--text2,#5A5650);font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;}',
      '.sg-tab.on{background:var(--ink,#15130F);color:#F5F0E4;border-color:var(--ink,#15130F);}',
      '.sg-tbl{width:100%;border-collapse:collapse;font-size:13px;}',
      '.sg-tbl th{background:var(--bg2,#EDE8DC);color:var(--ink,#15130F);font-weight:700;font-size:12.5px;}',
      '.sg-tbl th,.sg-tbl td{padding:9px 10px;border:1px solid var(--border,#E2DBCC);text-align:center;color:var(--text2,#5A5650);}',
      '.sg-tbl td:first-child{font-weight:800;color:var(--ink,#15130F);}',
      '.sg-tbl tbody tr:nth-child(even) td{background:rgba(237,232,220,.35);}',
      '.sg-scroll{overflow-x:auto;}',
      '.sg-note{display:flex;gap:8px;margin-top:13px;font-size:12px;line-height:1.7;color:var(--text2,#5A5650);}',
      '.sg-note i{color:var(--gold2,#A07828);font-size:15px;flex:0 0 auto;margin-top:2px;}',
      '@media(max-width:560px){.sg-back{align-items:flex-end;padding:0;}',
      '  .sg{max-width:100%;border-radius:20px 20px 0 0;border-bottom:none;transform:translateY(100%);max-height:90vh;}',
      '  .sg-back.show .sg{transform:none;}}',
      '@media(prefers-reduced-motion:reduce){.sg-back,.sg{transition:none;}}'
    ].join('');
    document.head.appendChild(s);
  }

  var backEl = null;
  function tableHTML(key){
    var g = GUIDES[key];
    if (!g) return '';
    return '<div class="sg-scroll"><table class="sg-tbl"><thead><tr>'
      + g.cols.map(function (c) { return '<th>' + T(c.ar, c.en) + '</th>'; }).join('')
      + '</tr></thead><tbody>'
      + g.rows.map(function (r) {
          return '<tr>' + r.map(function (v) { return '<td>' + v + '</td>'; }).join('') + '</tr>';
        }).join('')
      + '</tbody></table></div>'
      + '<div class="sg-note"><i class="ti ti-ruler-measure"></i><span>' + T(g.note.ar, g.note.en) + '</span></div>';
  }

  function open(key){
    /* an unknown key must not silently show another product's table */
    if (!GUIDES[key]) return;
    css();
    close();
    backEl = document.createElement('div');
    backEl.className = 'sg-back';
    backEl.innerHTML =
      '<div class="sg" role="dialog" aria-modal="true" aria-label="' + T('دليل المقاسات','Size guide') + '">'
        + '<div class="sg-h"><h3>' + T(GUIDES[key].title.ar, GUIDES[key].title.en) + '</h3>'
          + '<button class="sg-x" aria-label="' + T('إغلاق','Close') + '"><i class="ti ti-x"></i></button></div>'
        + '<div class="sg-b" id="sgBody">' + tableHTML(key) + '</div>'
      + '</div>';
    backEl.addEventListener('click', function (e) {
      if (e.target === backEl || e.target.closest('.sg-x')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(backEl);
    /* A5 — the same swipe-to-close every RAF sheet uses; the button, the
       backdrop and Escape all keep working exactly as before */
    if (window.RAFSwipe) {
      var sheet = backEl.querySelector('.sg');
      if (sheet) RAFSwipe.attach(sheet, close);
    }
    requestAnimationFrame(function () { if (backEl) backEl.classList.add('show'); });
    setTimeout(function () { if (backEl) backEl.classList.add('show'); }, 30);   /* hidden-tab safe */
  }
  function onKey(e){ if (e.key === 'Escape') close(); }
  function close(){
    if (!backEl) return;
    var el = backEl; backEl = null;
    if (window.RAFSwipe) {
      var sheet = el.querySelector('.sg');
      if (sheet) RAFSwipe.detach(sheet);            /* listeners never outlive the sheet */
    }
    el.classList.remove('show');
    document.removeEventListener('keydown', onKey);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
  }

  /* trigger markup — callers drop this next to their size selector */
  function linkHTML(key){
    if (!GUIDES[key]) return '';
    return '<button type="button" class="sg-link" onclick="RAFSizeGuide.open(\'' + key + '\')">'
      + '<i class="ti ti-ruler-measure"></i>' + T('دليل المقاسات','Size guide') + '</button>';
  }

  global.RAFSizeGuide = {
    GUIDES: GUIDES,
    forProduct: forProduct, hasSizes: hasSizes, sizeGroup: sizeGroup,
    linkHTML: linkHTML, open: open, close: close
  };

  /* the trigger is rendered long before the panel is ever opened, so the
     stylesheet has to be in place from the start — not on first click */
  if (document.head) css();
  else document.addEventListener('DOMContentLoaded', css);
})(window);
