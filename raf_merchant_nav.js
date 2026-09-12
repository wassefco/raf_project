/* ==========================================================================
 * RAF — MERCHANT RAIL RENDERER  (RAFMerchantNav)
 * --------------------------------------------------------------------------
 * The single renderer for the Merchant Dashboard sidebar. Every merchant
 * page declares which page it is (`data-nav` on its own <aside class="mw-rail">)
 * and this module draws the rail from RAFMerchantPrefs: the same markup and
 * classes the pages used before, in the signed-in account's own order, with
 * the current page marked.
 *
 * No page keeps navigation or ordering logic of its own, so a customised
 * order applies everywhere at once and active-page highlighting cannot drift.
 * This is presentation only: it never changes a permission, a route's own
 * gate, or any business behaviour.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFMerchantNav) return;

  var LANDED = 'raf_nav_landed';           /* per tab: the entry redirect runs once */

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function esc(s){
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c];
    });
  }
  function railEl(){ return document.querySelector('aside.mw-rail'); }
  function currentFile(){ return location.pathname.split('/').pop() || 'raf_dashboard.html'; }
  function currentKey(el){
    var d = el && el.getAttribute('data-nav');
    if (d) return d;
    var it = global.RAFMerchantPrefs && RAFMerchantPrefs.itemForPage(currentFile());
    return it ? it.key : null;
  }

  /* the order to draw: the account's own when it can be read, else canonical */
  function orderFor(){
    var P = global.RAFMerchantPrefs;
    if (!P) return [];
    var r = P.read({});
    return r.ok ? r.order : P.DEFAULT_ORDER.slice();
  }

  function itemHTML(item, isCurrent){
    var P = global.RAFMerchantPrefs, en = isEn();
    var text = en ? item.en : item.ar;
    return '<a class="mw-rail-b' + (isCurrent ? ' on' : '') + '" href="' + esc(item.href) + '"'
      + (isCurrent ? ' aria-current="page"' : '')
      + ' title="' + esc(P.label(item, true)) + '" data-nav-key="' + esc(item.key) + '" style="text-decoration:none;">'
      + '<i class="ti ' + esc(item.ic) + '"></i>'
      + '<span data-ar="' + esc(item.ar) + '" data-en="' + esc(item.en) + '">' + esc(text) + '</span></a>';
  }

  /* Draws the rail in place. Safe to call again after a preference change or
     a language toggle — the page's own [data-ar]/[data-en] pass still works,
     because the spans carry both languages exactly as the static markup did. */
  function render(opts){
    opts = opts || {};
    var el = opts.el || railEl();
    if (!el || !global.RAFMerchantPrefs) return false;
    var P = global.RAFMerchantPrefs, cur = opts.current || currentKey(el);
    var html = '<a class="mw-rail-logo" href="raf_homepage.html" aria-label="RAF">رف</a>';
    orderFor().forEach(function (k) {
      var item = P.itemOf(k);
      if (item) html += itemHTML(item, item.key === cur);
    });
    html += '<div class="mw-rail-sp"></div>';
    el.innerHTML = html;
    return true;
  }

  /* ---------- the default landing page ----------
     Applies when the workspace is ENTERED — arriving from outside the
     merchant pages — and at most once per tab, so moving between merchant
     pages afterwards is never redirected. The page's own permission gate
     still runs on arrival; this only chooses which page opens first. */
  function isMerchantReferrer(){
    var P = global.RAFMerchantPrefs;
    if (!P || !document.referrer) return false;
    try {
      var u = new URL(document.referrer);
      if (u.origin !== location.origin) return false;
      return !!P.itemForPage(u.pathname.split('/').pop());
    } catch (e) { return false; }
  }
  function applyLanding(){
    var P = global.RAFMerchantPrefs;
    if (!P) return false;
    try { if (sessionStorage.getItem(LANDED)) return false; } catch (e) { return false; }
    if (isMerchantReferrer()) { try { sessionStorage.setItem(LANDED, '1'); } catch (e) {} return false; }
    var r = P.read({});
    if (!r.ok) return false;
    try { sessionStorage.setItem(LANDED, '1'); } catch (e) {}
    var here = currentKey(railEl());
    if (!r.landing || r.landing === here) return false;
    var item = P.itemOf(r.landing);
    if (!item) return false;
    location.replace(item.href);
    return true;
  }

  function init(){
    render();
    applyLanding();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.RAFMerchantNav = { render:render, applyLanding:applyLanding, init:init };
})(window);
