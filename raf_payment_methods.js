/* ============================================================================
 * RAF Marketplace — Payment methods (one list)
 * ----------------------------------------------------------------------------
 * The payment methods RAF offers, in one place: checkout reads it, and the
 * wallet top-up reads the ONLINE ones from it. Nothing here processes a
 * payment — RAF has no payment gateway yet; checkout and the wallet top-up
 * both treat an online payment as a prototype confirmation.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFPaymentMethods) return;
  var LIST = [
    { id:'cod',  ic:'ti-cash',        online:false, ar:'الدفع عند الاستلام', en:'Cash on delivery', sAr:'نقداً عند وصول الطلب', sEn:'Pay in cash on arrival' },
    { id:'knet', ic:'ti-credit-card', online:true,  ar:'كي-نت',              en:'K-Net',            sAr:'بطاقة الدفع الكويتية', sEn:'Kuwaiti debit card' },
    { id:'visa', ic:'ti-brand-visa',  online:true,  ar:'بطاقة ائتمانية',      en:'Credit card',      sAr:'فيزا / ماستركارد',     sEn:'Visa / Mastercard' }
  ];
  function copy(m){ var o = {}; for (var k in m) o[k] = m[k]; return o; }
  /* confirmed: a driver tip can be chosen only with an online-type payment —
     an online method above, RAF Wallet, or Wallet + K-Net ('mixed'). Never
     with cash on delivery. (Wallet / mixed are not offered at checkout yet;
     the rule covers orders that carry them.) */
  var TIP_TYPES = { wallet:true, mixed:true };
  function tipAllowed(id){
    if (TIP_TYPES[id]) return true;
    var m = LIST.filter(function (x) { return x.id === id; })[0];
    return !!(m && m.online);
  }
  global.RAFPaymentMethods = {
    /* every method, as checkout offers them */
    list: function(){ return LIST.map(copy); },
    /* methods that can be paid on the spot (no cash) — the wallet top-up's options */
    online: function(){ return LIST.filter(function(m){ return m.online; }).map(copy); },
    get: function(id){ var m = LIST.filter(function(x){ return x.id === id; })[0]; return m ? copy(m) : null; },
    /* may an order paid this way carry a driver tip? (never COD) */
    tipAllowed: tipAllowed
  };
})(window);
