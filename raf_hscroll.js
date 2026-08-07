/* ============================================================
   RAF — HORIZONTAL DRAG SCROLL
   Mouse users can grab a horizontal rail and drag it the way
   touch users already swipe it. Touch is left completely alone:
   the browser's own momentum scrolling stays in charge.

   Usage: <div class="…-track" data-hscroll> … </div>
   Rails are also picked up automatically when they are rendered
   later (the observer below watches for new ones).
   ============================================================ */
(function (global) {
  'use strict';
  if (global.RAFHScroll) return;

  var SEL = '[data-hscroll]';
  var DRAG_SLOP = 4;                       /* px before a press becomes a drag */

  function attach(el) {
    if (!el || el.__rafHScroll) return;
    el.__rafHScroll = true;
    el.classList.add('rafx-hscroll');

    var down = false, moved = false, startX = 0, startScroll = 0, prevSnap = '';

    el.addEventListener('pointerdown', function (e) {
      /* mouse only — touch and pen keep native scrolling */
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      /* let real controls (buttons, inputs) handle their own press */
      if (e.target.closest('input,textarea,select')) return;
      if (el.scrollWidth <= el.clientWidth) return;
      down = true; moved = false;
      startX = e.clientX;
      startScroll = el.scrollLeft;
      el.classList.add('is-grabbing');
    });

    el.addEventListener('pointermove', function (e) {
      if (!down) return;
      var dx = e.clientX - startX;
      if (!moved) {
        if (Math.abs(dx) < DRAG_SLOP) return;
        moved = true;
        /* snapping and smooth behaviour fight a live drag — suspend both */
        prevSnap = el.style.scrollSnapType;
        el.style.scrollSnapType = 'none';
        el.style.scrollBehavior = 'auto';
        if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) {} }
      }
      /* RTL and LTR both work: scrollLeft simply moves in its own direction */
      el.scrollLeft = startScroll - dx;
      e.preventDefault();
    });

    function end(e) {
      if (!down) return;
      down = false;
      el.classList.remove('is-grabbing');
      if (!moved) return;
      el.style.scrollSnapType = prevSnap;
      el.style.scrollBehavior = '';
      if (e && e.pointerId != null && el.releasePointerCapture) {
        try { el.releasePointerCapture(e.pointerId); } catch (err) {}
      }
      /* a drag must never also open the card it finished on */
      el.addEventListener('click', swallow, true);
      setTimeout(function () { el.removeEventListener('click', swallow, true); }, 0);
    }
    function swallow(e) { e.preventDefault(); e.stopPropagation(); }

    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('pointerleave', end);
    /* native image/link dragging would hijack the gesture */
    el.addEventListener('dragstart', function (e) { if (down) e.preventDefault(); });
  }

  function scan(root) {
    (root || document).querySelectorAll(SEL).forEach(attach);
  }

  function style() {
    if (document.getElementById('raf-hscroll-style')) return;
    var s = document.createElement('style');
    s.id = 'raf-hscroll-style';
    s.textContent =
      '.rafx-hscroll{cursor:grab;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;}' +
      '.rafx-hscroll.is-grabbing{cursor:grabbing;user-select:none;-webkit-user-select:none;}' +
      '.rafx-hscroll.is-grabbing a,.rafx-hscroll.is-grabbing img{pointer-events:none;}';
    document.head.appendChild(s);
  }

  function init() {
    style();
    scan();
    /* rails built by JS after load (carousels, cross-sell) attach themselves.
       Coalesced into one pass per frame so re-renders stay cheap. */
    if (global.MutationObserver && document.body) {
      var queued = false;
      new MutationObserver(function () {
        if (queued) return;
        queued = true;
        /* setTimeout, not rAF: a background tab never paints, and rails
           rendered there must still be draggable when it comes forward */
        setTimeout(function () { queued = false; scan(); }, 16);
      }).observe(document.body, { childList: true, subtree: true });
    }
  }

  global.RAFHScroll = { attach: attach, scan: scan };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
