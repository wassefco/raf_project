/* ============================================================
   RAF Feature Flags — admin-controlled toggles for marketplace modules.
   Auctions & Used Marketplace are hidden from the customer UI by default
   and can be re-enabled later from the Admin Panel.

   Storage: localStorage 'raf_features' = {"auctions":true,"used":true}
   Admin:   RAFFeatures.enable('auctions') / RAFFeatures.disable('used')

   Usage in markup: add  data-feature="auctions"  to any link/section;
   it is hidden automatically while that feature is OFF.
   ============================================================ */
(function () {
  var KEY = 'raf_features';
  var DEFAULTS = { auctions: false, used: false };
  function read() { try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return Object.assign({}, DEFAULTS); } }
  var flags = read();

  window.RAFFeatures = {
    on: function (k) { return flags[k] === true; },
    all: function () { return Object.assign({}, flags); },
    set: function (k, v) { flags[k] = !!v; try { localStorage.setItem(KEY, JSON.stringify(flags)); } catch (e) {} apply(); },
    enable: function (k) { this.set(k, true); },
    disable: function (k) { this.set(k, false); }
  };

  /* guard: block direct navigation to a disabled feature page */
  var page = (location.pathname.split('/').pop() || '').toLowerCase();
  var GUARDED = { 'raf_auctions.html': 'auctions', 'raf_used.html': 'used' };
  if (GUARDED[page] && flags[GUARDED[page]] !== true) { location.replace('raf_homepage.html'); return; }

  /* hide every element flagged for a currently-disabled feature */
  function apply() {
    document.querySelectorAll('[data-feature]').forEach(function (el) {
      var f = el.getAttribute('data-feature');
      if (f && flags[f] !== true) el.style.display = 'none';
      else if (f && el.style.display === 'none') el.style.display = '';
    });
  }
  window.RAFFeatures.apply = apply;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
  else apply();
})();
