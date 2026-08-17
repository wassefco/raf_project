/* ============================================================
   RAF · SWIPE-TO-CLOSE  (Group A · A5)

   One gesture, one implementation. Every mobile bottom sheet in
   RAF — Quick Order, the cart-conflict sheet, the size guide,
   the store filter sheet — attaches the SAME handler here
   instead of growing its own copy.

   The behaviour is the one already approved for Quick Order:

     · a short drag springs back, it never closes
     · a drag that starts on a control is left alone
     · upward movement is a scroll, not a dismissal
     · the sheet only follows the finger once the gesture is
       clearly downward, and only from the grab handle or the
       top of a scrolled body
     · every listener is removed on detach, so repeated
       open/close cycles cannot leak handlers

   attach() is idempotent: attaching twice to the same element
   replaces the first binding rather than stacking a second.
   ============================================================ */
(function (global) {
  if (global.RAFSwipe) return;

  var CLOSE_PX  = 90;   /* far enough that a small nudge never closes */
  var START_SLOP = 6;   /* movement below this is not yet a direction */

  /* every live binding, keyed by the element it belongs to */
  var bound = typeof Map === 'function' ? new Map() : null;
  var fallback = [];    /* environments without Map keep a small list */

  function get(el){
    if (bound) return bound.get(el) || null;
    for (var i = 0; i < fallback.length; i++) if (fallback[i].el === el) return fallback[i].b;
    return null;
  }
  function set(el, b){
    if (bound) { bound.set(el, b); return; }
    for (var i = 0; i < fallback.length; i++) if (fallback[i].el === el) { fallback[i].b = b; return; }
    fallback.push({ el:el, b:b });
  }
  function del(el){
    if (bound) { bound['delete'](el); return; }
    for (var i = 0; i < fallback.length; i++) if (fallback[i].el === el) { fallback.splice(i, 1); return; }
  }

  /* sheet   — the element that slides
     onClose — called when the drag passes the threshold
     opts.grab    — selector for the drag handle (defaults to any .rq-grab / [data-grab])
     opts.ignore  — selector for controls the gesture must not start on
     opts.closePx — override the distance, for a sheet that needs it */
  function attach(sheet, onClose, opts){
    if (!sheet || typeof onClose !== 'function') return false;
    detach(sheet);                                   /* never stack two bindings */

    opts = opts || {};
    var grabSel   = opts.grab   || '.rq-grab,[data-grab]';
    var ignoreSel = opts.ignore || 'button,a,input,textarea,select,[role="button"]';
    var closePx   = opts.closePx || CLOSE_PX;

    var s = { startY:0, dy:0, active:false, tracking:false };

    s.onStart = function (e) {
      if (e.touches && e.touches.length !== 1) return;   /* a pinch is not a swipe */
      var t = e.touches ? e.touches[0] : e;
      /* a control keeps its own behaviour */
      if (e.target.closest && e.target.closest(ignoreSel)) return;
      var onGrab = !!(e.target.closest && e.target.closest(grabSel));
      /* mid-scroll the body owns the gesture, unless it started on the handle */
      if (!onGrab && sheet.scrollTop > 0) return;
      s.startY = t.clientY; s.dy = 0;
      s.tracking = true; s.active = false;
    };
    s.onMove = function (e) {
      if (!s.tracking) return;
      var t = e.touches ? e.touches[0] : e;
      var dy = t.clientY - s.startY;
      if (!s.active) {
        if (dy < START_SLOP) {
          /* upward means the customer is scrolling; hand the gesture back */
          if (dy < -START_SLOP) s.tracking = false;
          return;
        }
        s.active = true;
        sheet.style.transition = 'none';
      }
      if (dy < 0) dy = 0;
      s.dy = dy;
      sheet.style.transform = 'translateY(' + dy + 'px)';
      if (e.cancelable) e.preventDefault();          /* we own the gesture now */
    };
    s.onEnd = function () {
      if (!s.tracking) return;
      var dy = s.dy;
      s.tracking = false; s.active = false;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy >= closePx) onClose();                  /* past the threshold: close */
    };

    sheet.addEventListener('touchstart', s.onStart, { passive:true });
    sheet.addEventListener('touchmove',  s.onMove,  { passive:false });
    sheet.addEventListener('touchend',   s.onEnd);
    sheet.addEventListener('touchcancel',s.onEnd);
    set(sheet, s);
    return true;
  }

  function detach(sheet){
    if (!sheet) return false;
    var s = get(sheet);
    if (!s) return false;
    sheet.removeEventListener('touchstart', s.onStart);
    sheet.removeEventListener('touchmove',  s.onMove);
    sheet.removeEventListener('touchend',   s.onEnd);
    sheet.removeEventListener('touchcancel',s.onEnd);
    sheet.style.transform = ''; sheet.style.transition = '';
    del(sheet);
    return true;
  }

  /* how many bindings are live — used by the tests to prove nothing leaks */
  function count(){ return bound ? bound.size : fallback.length; }

  global.RAFSwipe = { attach: attach, detach: detach, count: count,
                      CLOSE_PX: CLOSE_PX, START_SLOP: START_SLOP };
})(window);
