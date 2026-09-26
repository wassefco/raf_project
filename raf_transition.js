/* ============================================================================
 * RAF Marketplace — Page transition (customer pages)
 * ----------------------------------------------------------------------------
 * Load in <head> (before the body paints). Arriving: the page fades in.
 * Leaving through an ordinary link to another RAF page: a quick fade out,
 * then the navigation. Styles live in raf_cx.css (html.cx-pt-*).
 *
 *   • opacity only — no movement of fixed/sticky chrome, no zoom
 *   • full opacity is always restored by a timer, even if animation frames
 *     are paused (background tab, throttled preview), so a page can never be
 *     left faded
 *   • prefers-reduced-motion: nothing is animated and navigation is instant
 *   • links that open elsewhere, modified clicks, downloads, in-page anchors
 *     and anything a page handler already took (preventDefault) are left alone
 * ==========================================================================*/
(function () {
  'use strict';
  var root = document.documentElement;
  if (root.__rafPT) return; root.__rafPT = true;
  var reduce = false;
  try { reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
  if (reduce) return;

  /* ── arriving ── */
  function settle(){ root.classList.remove('cx-pt-in', 'cx-pt-go', 'cx-pt-out'); }
  root.classList.add('cx-pt-in');
  var go = function(){ root.classList.add('cx-pt-go'); };
  if (window.requestAnimationFrame) requestAnimationFrame(function(){ requestAnimationFrame(go); }); else go();
  setTimeout(go, 60);          /* frames may not run in a throttled tab */
  setTimeout(settle, 420);     /* always end fully visible */

  /* a page restored from the back/forward cache must come back visible */
  window.addEventListener('pageshow', function(){ root.classList.remove('cx-pt-out'); });

  /* ── leaving ── */
  function dir(p){ return p.replace(/[^\/]*$/, ''); }
  function sameSite(a){
    if (a.protocol !== location.protocol) return false;
    if (location.protocol !== 'file:' && a.host !== location.host) return false;
    return dir(a.pathname) === dir(location.pathname) && /\.html?$/i.test(a.pathname);
  }
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a || a.hasAttribute('download') || (a.target && a.target !== '_self')) return;
    var raw = a.getAttribute('href') || '';
    if (!raw || raw.charAt(0) === '#' || /^(javascript|mailto|tel):/i.test(raw)) return;
    if (!sameSite(a)) return;
    if (a.pathname === location.pathname && a.search === location.search && a.hash) return;   /* in-page */
    e.preventDefault();
    var href = a.href;
    root.classList.remove('cx-pt-in', 'cx-pt-go');
    root.classList.add('cx-pt-out');
    setTimeout(function(){ location.href = href; }, 130);
    setTimeout(function(){ root.classList.remove('cx-pt-out'); }, 1500);   /* if the navigation never happens */
  });
})();
