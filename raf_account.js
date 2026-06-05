/* ============================================================
   RAF ID — Account Center shared script
   Language toggle + shared Orders dataset & renderers
   ============================================================ */
(function () {
  /* ---------- LANGUAGE ---------- */
  function root() { return document.getElementById('htmlRoot') || document.documentElement; }
  window.curLang = function () { return root().lang === 'en' ? 'en' : 'ar'; };
  window.applyLang = function () {
    var en = curLang() === 'en';
    var lbl = document.getElementById('langLabel'); if (lbl) lbl.textContent = en ? 'ع' : 'EN';
    document.querySelectorAll('[data-ar]').forEach(function (el) {
      var t = el.getAttribute('data-' + (en ? 'en' : 'ar')); if (t !== null) el.textContent = t;
    });
  };
  window.toggleLang = function () {
    var r = root(), en = r.lang === 'en';
    r.lang = en ? 'ar' : 'en'; r.dir = en ? 'rtl' : 'ltr';
    localStorage.setItem('raf_lang', r.lang);
    applyLang();
    if (typeof window.onLangChange === 'function') window.onLangChange();
  };
  (function () {
    var l = localStorage.getItem('raf_lang');
    if (l) { var r = root(); r.lang = l; r.dir = l === 'en' ? 'ltr' : 'rtl'; }
    if (document.readyState !== 'loading') applyLang();
    else document.addEventListener('DOMContentLoaded', applyLang);
  })();

  /* ---------- BACK (real navigation history) ----------
     Returns to the actual previous page. Falls back only when there is
     no in-tab history (e.g. opened directly via a deep link). */
  window.goBack = function (fallback) {
    if (window.history.length > 1) { window.history.back(); }
    else { window.location.href = fallback || 'raf_homepage.html'; }
    return false;
  };

  /* ---------- RAF ID PROFILE (from sign-up) ---------- */
  window.rafProfile = function () {
    var acc = {};
    try { acc = JSON.parse(localStorage.getItem('raf_account') || '{}') || {}; } catch (e) {}
    return {
      name: (acc.name || 'محمد العنزي'),
      email: (acc.email || 'mohammed@example.com'),
      phone: (acc.phone || '+965 9XXX XXXX'),
      id: 'RAF-2026-04871'
    };
  };

  /* ---------- ORDERS DATASET ---------- */
  window.RAF_ORDERS = [
    { id: 'ORD-1284', store: { ar: 'Casa Mode', en: 'Casa Mode' }, ic: 'ti-shirt', date: { ar: '4 يونيو 2026، 2:30م', en: 'Jun 4, 2026, 2:30 PM' },
      total: '24.500', status: 'progress',
      items: [{ name: { ar: 'قميص أوفرسايز كلاسيك', en: 'Classic Oversize Shirt' }, meta: { ar: 'مقاس M · أبيض · الكمية 1', en: 'Size M · White · Qty 1' }, price: '12.000', ic: 'ti-shirt' },
              { name: { ar: 'بنطلون كاجوال', en: 'Casual Trousers' }, meta: { ar: 'مقاس 32 · كحلي · الكمية 1', en: 'Size 32 · Navy · Qty 1' }, price: '12.500', ic: 'ti-hanger' }],
      pay: { ar: 'بطاقة فيزا •••• 4821', en: 'Visa card •••• 4821' },
      addr: { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' },
      driver: { ar: 'خالد — يصل خلال ~20 دقيقة', en: 'Khaled — arriving in ~20 min' },
      ship: '1.000',
      tl: [ { k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '2:30م', en: '2:30 PM' }, s: 'done' },
            { k: 'prep', t: { ar: 'قيد التجهيز', en: 'Preparing' }, time: { ar: '2:45م', en: '2:45 PM' }, s: 'done' },
            { k: 'ship', t: { ar: 'مع مندوب التوصيل', en: 'Out for delivery' }, time: { ar: '3:10م', en: '3:10 PM' }, s: 'active' },
            { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '—', en: '—' }, s: '' } ] },

    { id: 'ORD-1280', store: { ar: 'TechZone', en: 'TechZone' }, ic: 'ti-device-mobile', date: { ar: '3 يونيو 2026، 4:00م', en: 'Jun 3, 2026, 4:00 PM' },
      total: '189.000', status: 'delivered',
      items: [{ name: { ar: 'iPhone 16 Pro — 256GB', en: 'iPhone 16 Pro — 256GB' }, meta: { ar: 'تيتانيوم · الكمية 1', en: 'Titanium · Qty 1' }, price: '189.000', ic: 'ti-device-mobile' }],
      pay: { ar: 'بطاقة فيزا •••• 4821', en: 'Visa card •••• 4821' },
      addr: { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' },
      ship: '0.000',
      tl: [ { k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '3 يونيو 4:00م', en: 'Jun 3, 4:00 PM' }, s: 'done' },
            { k: 'prep', t: { ar: 'قيد التجهيز', en: 'Preparing' }, time: { ar: '3 يونيو 4:20م', en: 'Jun 3, 4:20 PM' }, s: 'done' },
            { k: 'ship', t: { ar: 'مع مندوب التوصيل', en: 'Out for delivery' }, time: { ar: '3 يونيو 6:00م', en: 'Jun 3, 6:00 PM' }, s: 'done' },
            { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '3 يونيو 7:15م', en: 'Jun 3, 7:15 PM' }, s: 'done' } ] },

    { id: 'ORD-1275', store: { ar: 'Sole & Co', en: 'Sole & Co' }, ic: 'ti-shoe', date: { ar: '1 يونيو 2026، 11:00ص', en: 'Jun 1, 2026, 11:00 AM' },
      total: '56.000', status: 'cancelled',
      items: [{ name: { ar: 'حذاء رياضي Air Comfort', en: 'Air Comfort Sneakers' }, meta: { ar: 'مقاس 42 · أسود · الكمية 1', en: 'Size 42 · Black · Qty 1' }, price: '56.000', ic: 'ti-shoe' }],
      pay: { ar: 'الدفع عند الاستلام', en: 'Cash on delivery' },
      addr: { ar: 'حولي، شارع الأمير، بناية 12، شقة 4', en: 'Hawally, Prince St, Bldg 12, Apt 4' },
      ship: '1.000',
      tl: [ { k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '1 يونيو 11:00ص', en: 'Jun 1, 11:00 AM' }, s: 'done' },
            { k: 'cancel', t: { ar: 'تم إلغاء الطلب', en: 'Order cancelled' }, time: { ar: '1 يونيو 11:20ص', en: 'Jun 1, 11:20 AM' }, s: 'cancel' } ] },

    { id: 'ORD-1268', store: { ar: 'Glam Store', en: 'Glam Store' }, ic: 'ti-watch', date: { ar: '28 مايو 2026، 6:10م', en: 'May 28, 2026, 6:10 PM' },
      total: '75.000', status: 'delivered',
      items: [{ name: { ar: 'ساعة ذكية Premium', en: 'Premium Smartwatch' }, meta: { ar: 'فضي · الكمية 1', en: 'Silver · Qty 1' }, price: '75.000', ic: 'ti-watch' }],
      pay: { ar: 'بطاقة ماستركارد •••• 9035', en: 'Mastercard •••• 9035' },
      addr: { ar: 'شرق، برج X، الطابق 8', en: 'Sharq, Tower X, Floor 8' },
      ship: '0.000',
      tl: [ { k: 'placed', t: { ar: 'تم استلام الطلب', en: 'Order placed' }, time: { ar: '28 مايو', en: 'May 28' }, s: 'done' },
            { k: 'done', t: { ar: 'تم التسليم', en: 'Delivered' }, time: { ar: '29 مايو', en: 'May 29' }, s: 'done' } ] }
  ];

  window.orderById = function (id) { return (window.RAF_ORDERS || []).find(function (o) { return o.id === id; }); };

  window.statusMeta = function (st) {
    var en = curLang() === 'en';
    if (st === 'progress') return { cls: 'b-progress', ic: 'ti-truck-delivery', label: en ? 'In Progress' : 'قيد التوصيل' };
    if (st === 'delivered') return { cls: 'b-delivered', ic: 'ti-circle-check', label: en ? 'Delivered' : 'تم التسليم' };
    return { cls: 'b-cancelled', ic: 'ti-circle-x', label: en ? 'Cancelled' : 'ملغى' };
  };

  /* ---------- ORDER CARD (orders list) ---------- */
  window.orderCardHTML = function (o) {
    var en = curLang() === 'en', sm = statusMeta(o.status);
    var act = '';
    if (o.status === 'progress')
      /* one click straight to the live tracking screen — no intermediate page */
      act = '<a class="btn btn-gold btn-sm ord-act" href="raf_tracking.html?id=' + o.id + '" onclick="event.stopPropagation()"><i class="ti ti-map-pin"></i> ' + (en ? 'Track Order' : 'تتبّع الطلب') + '</a>';
    else if (o.status === 'delivered')
      act = '<a class="btn btn-ghost btn-sm ord-act" href="raf_order_details.html?id=' + o.id + '" onclick="event.stopPropagation()"><i class="ti ti-eye"></i> ' + (en ? 'View Details' : 'عرض التفاصيل') + '</a>';
    else
      act = '<span class="badge b-cancelled ord-act"><i class="ti ti-circle-x"></i> ' + (en ? 'Cancelled' : 'ملغى') + '</span>';
    return '<article class="ord-card" data-status="' + o.status + '" onclick="location=\'raf_order_details.html?id=' + o.id + '\'">' +
      '<div class="ord-top"><div class="ord-store-ic"><i class="ti ' + o.ic + '"></i></div>' +
        '<div><div class="ord-num">#' + o.id + '</div><div class="ord-store"><i class="ti ti-building-store" style="font-size:12px"></i> ' + o.store[en ? 'en' : 'ar'] + '</div></div>' +
        '<span class="badge ' + sm.cls + '"><i class="ti ' + sm.ic + '"></i> ' + sm.label + '</span></div>' +
      '<div class="ord-bot"><div class="ord-meta"><div class="ord-date"><i class="ti ti-calendar" style="font-size:12px"></i> ' + o.date[en ? 'en' : 'ar'] + '</div>' +
        '<div class="ord-total">' + o.total + ' <small>' + (en ? 'KWD' : 'د.ك') + '</small></div></div>' + act + '</div></article>';
  };
})();
