/* ============================================================================
 * RAF Marketplace — COMPENSATION WIDGET  (RAFCompUI) — Phase I
 * ----------------------------------------------------------------------------
 * Presentation only. Every figure, status and permission comes from
 * RAFCompensation (and, for wallet credit lots, RAFWallet). The widget does no
 * money arithmetic, decides no eligibility and never writes a record.
 *
 *   RAFCompUI.mount(el, { mode:'order', orderId })   customer order page
 *   RAFCompUI.mount(el, { mode:'wallet' })           customer RAF Wallet page
 *   RAFCompUI.mount(el, { mode:'admin' })            management review (no page mounts this today)
 *   opts.onRender(el) — called after each paint (e.g. to hide an empty panel)
 *
 * Live refresh: RAFEventBus 'compensation.*' (same tab and other tabs) and the
 * page language switch. No polling, no timers.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFCompUI) return;

  var MOUNTS = [], SAVED = {}, subscribed = false, uid = 0;
  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function when(ms){
    if (ms == null) return '—';
    try { return new Date(ms).toLocaleString(isEn() ? 'en-GB' : 'ar-KW-u-nu-latn', { timeZone:'Asia/Kuwait', day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
    catch (e) { return new Date(ms).toISOString(); }
  }
  var KWD = function(){ return T('د.ك', 'KWD'); };

  var STATUS = {
    issued:            { ar:'بانتظار الإضافة إلى المحفظة', en:'Ready to add to wallet', cls:'on' },
    add_pending:       { ar:'قيد الإضافة إلى المحفظة — أعد المحاولة', en:'Adding to wallet — try again', cls:'on' },
    in_wallet:         { ar:'في محفظة RAF',               en:'In RAF Wallet',           cls:'ok' },
    partially_consumed:{ ar:'مستخدم جزئيًا',               en:'Partly used',             cls:'ok' },
    consumed:          { ar:'مستخدم بالكامل',              en:'Fully used',              cls:'mute' },
    expired:           { ar:'منتهي الصلاحية',              en:'Expired',                 cls:'mute' },
    voided:            { ar:'مُبطل',                       en:'Voided',                  cls:'bad' },
    reversed:          { ar:'معكوس',                       en:'Reversed',                cls:'bad' },
    active:            { ar:'متاح',                        en:'Available',               cls:'ok' }
  };
  function chip(status){
    var s = STATUS[status] || { ar:status, en:status, cls:'mute' };
    return '<span class="cmp-chip ' + s.cls + '">' + esc(T(s.ar, s.en)) + '</span>';
  }
  var STYLE = [
    '.cmp{font-size:13.5px;line-height:1.6;color:var(--ink,#1F1B14)}',
    '.cmp *{box-sizing:border-box}',
    '.cmp-amt{font-family:"DM Sans",sans-serif;font-size:26px;font-weight:800;line-height:1.2}',
    '.cmp-amt small{font-size:13px;font-weight:700;margin-inline-start:6px;color:var(--text3,#6B6457)}',
    '.cmp-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 12px}',
    '.cmp-kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px 16px;margin:12px 0}',
    '.cmp-kv div{min-width:0}',
    '.cmp-kv span{display:block;font-size:11.5px;font-weight:700;color:var(--text3,#6B6457)}',
    '.cmp-kv b{display:block;font-weight:700;overflow-wrap:anywhere}',
    '.cmp-msg{background:var(--surface-2,rgba(201,168,76,.08));border:1px solid var(--border,rgba(0,0,0,.08));border-radius:12px;padding:10px 12px;margin:10px 0;overflow-wrap:anywhere}',
    '.cmp-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 10px;font-size:12px;font-weight:800;white-space:nowrap}',
    '.cmp-chip.on{background:rgba(201,168,76,.18);color:#7A5B12}',
    '.cmp-chip.ok{background:rgba(46,158,91,.13);color:#1F7A45}',
    '.cmp-chip.mute{background:rgba(0,0,0,.06);color:#5C574C}',
    '.cmp-chip.bad{background:rgba(217,83,79,.12);color:#A8322E}',
    '.cmp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:44px;padding:0 16px;border-radius:12px;border:1px solid var(--border2,rgba(0,0,0,.18));background:var(--card,#fff);color:inherit;font:inherit;font-weight:800;cursor:pointer}',
    '.cmp-btn.pri{background:var(--gold,#C9A84C);border-color:var(--gold,#C9A84C);color:#1F1B14}',
    '.cmp-btn.dng{color:#A8322E;border-color:rgba(217,83,79,.45)}',
    '.cmp-btn[disabled]{opacity:.55;cursor:not-allowed}',
    '.cmp-btn:focus-visible,.cmp textarea:focus-visible{outline:2px solid var(--gold,#C9A84C);outline-offset:2px}',
    '.cmp-err{color:#A8322E;font-weight:700;margin:8px 0 0}',
    '.cmp-ok{color:#1F7A45;font-weight:700;margin:8px 0 0}',
    '.cmp-item{border:1px solid var(--border,rgba(0,0,0,.08));border-radius:14px;padding:12px 14px;margin-bottom:10px;background:var(--card,#fff)}',
    '.cmp-h{font-weight:800;font-size:14.5px;margin:0 0 8px}',
    '.cmp-note{font-size:12px;color:var(--text3,#6B6457)}',
    '.cmp textarea{width:100%;min-height:72px;border-radius:10px;border:1px solid var(--border2,rgba(0,0,0,.18));padding:8px 10px;font:inherit;background:var(--card,#fff);color:inherit;resize:vertical}',
    '.cmp-acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
    '.cmp-acts .cmp-btn{flex:1 1 150px}',
    '.cmp-life{margin:8px 0 0;padding:0;list-style:none;font-size:12.5px}',
    '.cmp-life li{padding:3px 0;border-top:1px dashed var(--border,rgba(0,0,0,.08));overflow-wrap:anywhere}',
    '.cmp-tbl{width:100%;overflow-x:auto}'
  ].join('');
  function injectStyle(){
    if (document.getElementById('rafCompUIStyle')) return;
    var s = document.createElement('style'); s.id = 'rafCompUIStyle'; s.textContent = STYLE; document.head.appendChild(s);
  }

  /* ---------- shared pieces ---------- */
  function facts(c){
    return '<div class="cmp-kv">'
      + '<div><span>' + T('الوقت الموعود للتسليم', 'Promised delivery time') + '</span><b>' + esc(when(c.promisedEtaAt)) + '</b></div>'
      + '<div><span>' + T('وقت التسليم الفعلي', 'Delivered at') + '</span><b>' + esc(when(c.deliveredAt)) + '</b></div>'
      + '<div><span>' + T('بداية احتساب التعويض', 'Compensation starts at') + '</span><b>' + esc(when(c.compensationStartsAt)) + '</b></div>'
      + '<div><span>' + T('القاعدة', 'Rule') + '</span><b><bdi>' + esc(c.stepMinutes) + '</bdi> ' + T('دقيقة مكتملة', 'completed minutes') + ' = <bdi>' + esc(c.amountPerStep) + '</bdi> ' + KWD() + '</b></div>'
      + '<div><span>' + T('صدرت في', 'Issued') + '</span><b>' + esc(when(c.issuedAt)) + '</b></div>'
      + '<div><span>' + T('تنتهي صلاحيتها في', 'Expires') + '</span><b>' + esc(when(c.expiresAt)) + '</b></div>'
      + '</div>';
  }
  function walletFacts(c){
    if (!c.wallet || !c.wallet.added) return '';
    var w = c.wallet;
    return '<div class="cmp-kv">'
      + '<div><span>' + T('أُضيف إلى المحفظة', 'Added to wallet') + '</span><b>' + esc(when(w.addedAt)) + '</b></div>'
      + '<div><span>' + T('المستخدم', 'Used') + '</span><b><bdi>' + esc(w.consumed) + '</bdi> ' + KWD() + '</b></div>'
      + '<div><span>' + T('المتبقي', 'Remaining') + '</span><b><bdi>' + esc(w.remaining) + '</bdi> ' + KWD() + '</b></div>'
      + (parseFloat(w.expired) > 0 ? '<div><span>' + T('انتهت صلاحيته', 'Expired') + '</span><b><bdi>' + esc(w.expired) + '</bdi> ' + KWD() + '</b></div>' : '')
      + (parseFloat(w.reversed) > 0 ? '<div><span>' + T('معكوس', 'Reversed') + '</span><b><bdi>' + esc(w.reversed) + '</bdi> ' + KWD() + '</b></div>' : '')
      + '</div>';
  }
  function customerCard(c, m){
    var msg = c.message ? (isEn() ? c.message.en : c.message.ar) : '';
    return '<div class="cmp-item" data-cmp="' + esc(c.compensationId) + '">'
      + '<div class="cmp-row"><div class="cmp-amt"><bdi dir="ltr">' + esc(c.amount) + '</bdi><small>' + KWD() + '</small></div>' + chip(c.status) + '</div>'
      + (msg ? '<div class="cmp-msg">' + esc(msg) + '</div>' : '')
      + facts(c) + walletFacts(c)
      + '<p class="cmp-note">' + T('تُستخدم هذه القسيمة فقط بإضافتها إلى محفظة RAF، وتنتهي صلاحيتها في الموعد أعلاه حتى بعد إضافتها.',
                                    'This coupon can only be used by adding it to your RAF Wallet. It expires at the time above, even after it is added.') + '</p>'
      + (c.canAddToWallet ? '<div class="cmp-acts"><button type="button" class="cmp-btn pri" data-act="add" data-id="' + esc(c.compensationId) + '"' + (m.busy ? ' disabled' : '') + '>'
          + '<i class="ti ti-wallet" aria-hidden="true"></i>' + T('إضافة إلى محفظة RAF', 'Add to RAF Wallet') + '</button></div>' : '')
      + (m.err && m.errId === c.compensationId ? '<p class="cmp-err" role="alert">' + esc(m.err) + '</p>' : '')
      + (m.okMsg && m.errId === c.compensationId ? '<p class="cmp-ok" role="status">' + esc(m.okMsg) + '</p>' : '')
      + '</div>';
  }

  /* ---------- modes ---------- */
  function paintOrder(m){
    var C = global.RAFCompensation; if (!C) return '';
    var r = C.forOrder(m.orderId);
    if (!r.ok || !r.compensation) return '';           /* nothing issued, not the owner, or OFF with no record */
    return '<div class="cmp">' + customerCard(r.compensation, m) + '</div>';
  }
  function paintWallet(m){
    var C = global.RAFCompensation, W = global.RAFWallet; if (!C || !W) return '';
    var u = global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null;
    if (!u) return '';
    var mine = C.mine(), lots = W.lots(u.id, { id:u.id, name:u.name, type:'customer' });
    if (!mine.ok) return '';
    var toAdd = mine.compensations.filter(function (c) { return c.canAddToWallet; });
    var lotList = lots.ok ? lots.lots : [];
    if (!toAdd.length && !lotList.length) return '';
    var html = '<div class="cmp">';
    if (toAdd.length) {
      html += '<h3 class="cmp-h">' + T('قسائم تعويض بانتظار الإضافة', 'Compensation coupons to add') + '</h3>'
        + toAdd.map(function (c) { return customerCard(c, m); }).join('');
    }
    if (lotList.length) {
      html += '<h3 class="cmp-h">' + T('أرصدة التعويض (تنتهي صلاحيتها)', 'Compensation credits (expiring)') + '</h3>'
        + '<p class="cmp-note">' + T('يُستخدم رصيد التعويض غير المنتهي أولًا، الأقرب انتهاءً أولًا، ثم الرصيد العادي. الرصيد العادي لا تنتهي صلاحيته.',
                                     'Unexpired compensation credit is used first, soonest expiry first, then your ordinary balance. Ordinary balance does not expire.') + '</p>'
        + lotList.map(function (L) {
            return '<div class="cmp-item"><div class="cmp-row"><b>' + T('الطلب ', 'Order ') + '<bdi>' + esc(L.orderId || '—') + '</bdi></b>' + chip(L.status) + '</div>'
              + '<div class="cmp-kv">'
              + '<div><span>' + T('القيمة الأصلية', 'Original') + '</span><b><bdi>' + esc(L.original) + '</bdi> ' + KWD() + '</b></div>'
              + '<div><span>' + T('المستخدم', 'Used') + '</span><b><bdi>' + esc(L.consumed) + '</bdi> ' + KWD() + '</b></div>'
              + '<div><span>' + T('المتبقي', 'Remaining') + '</span><b><bdi>' + esc(L.remaining) + '</bdi> ' + KWD() + '</b></div>'
              + (L.expiredMinor > 0 ? '<div><span>' + T('انتهت صلاحيته', 'Expired') + '</span><b><bdi>' + esc(L.expired) + '</bdi> ' + KWD() + '</b></div>' : '')
              + (L.reversedMinor > 0 ? '<div><span>' + T('معكوس', 'Reversed') + '</span><b><bdi>' + esc(L.reversed) + '</bdi> ' + KWD() + '</b></div>' : '')
              + '<div><span>' + T('تنتهي صلاحيته في', 'Expires') + '</span><b>' + esc(when(L.expiresAt)) + '</b></div>'
              + '</div></div>';
          }).join('');
    }
    return html + '</div>';
  }
  function paintAdmin(m){
    var C = global.RAFCompensation;
    if (!C) return '<div class="cmp"><p class="cmp-err">' + T('خدمة التعويض غير محمّلة.', 'The compensation service is not loaded.') + '</p></div>';
    var r = C.list();
    if (!r.ok) return '<div class="cmp"><p class="cmp-err" role="alert">' + esc(r.message) + '</p></div>';
    if (!r.compensations.length) return '<div class="cmp"><p class="cmp-note">' + T('لا توجد تعويضات صادرة.', 'No compensations have been issued.') + '</p></div>';
    return '<div class="cmp">' + r.compensations.map(function (c) {
      var open = m.open === c.compensationId, form = m.form && m.form.id === c.compensationId ? m.form : null;
      var h = '<div class="cmp-item"><div class="cmp-row"><div><b>' + T('الطلب ', 'Order ') + '<bdi>' + esc(c.orderId) + '</bdi></b>'
        + ' <span class="cmp-note">· <bdi>' + esc(c.customerId) + '</bdi>' + (c.storeSlug ? ' · <bdi>' + esc(c.storeSlug) + '</bdi>' : '') + '</span></div>'
        + '<div class="cmp-row"><b><bdi dir="ltr">' + esc(c.amount) + '</bdi> ' + KWD() + '</b>' + chip(c.status) + '</div></div>'
        + '<div class="cmp-note">' + T('التأخير الفعلي', 'Actual delay') + ': <bdi>' + esc(c.actualDelayMinutes) + '</bdi> ' + T('د', 'min')
        + ' · ' + T('الخطوات المكتملة', 'Completed steps') + ': <bdi>' + esc(c.completedBlocks) + '</bdi>'
        + ' · ' + T('تنتهي', 'Expires') + ': ' + esc(when(c.expiresAt)) + '</div>'
        + '<div class="cmp-acts"><button type="button" class="cmp-btn" data-act="toggle" data-id="' + esc(c.compensationId) + '" aria-expanded="' + open + '">'
        + '<i class="ti ti-eye" aria-hidden="true"></i>' + T('عرض', 'View') + '</button>'
        + (c.canVoid ? '<button type="button" class="cmp-btn dng" data-act="form" data-kind="void" data-id="' + esc(c.compensationId) + '">' + T('إبطال', 'Void') + '</button>' : '')
        + (c.canReverse ? '<button type="button" class="cmp-btn dng" data-act="form" data-kind="reverse" data-id="' + esc(c.compensationId) + '">' + T('عكس', 'Reverse') + '</button>' : '')
        + '</div>';
      if (form) {
        var fid = 'cmpReason' + m.uid;
        h += '<div class="cmp-msg"><label for="' + fid + '" style="display:block;font-weight:800;margin-bottom:6px">'
          + (form.kind === 'void' ? T('سبب الإبطال (إلزامي)', 'Reason for voiding (required)') : T('سبب العكس (إلزامي) — يُسترد الرصيد غير المستخدم فقط', 'Reason for reversing (required) — only the unused remainder is taken back')) + '</label>'
          + '<textarea id="' + fid + '" maxlength="500" data-act="reason">' + esc(form.reason || '') + '</textarea>'
          + '<div class="cmp-acts"><button type="button" class="cmp-btn dng" data-act="confirm" data-id="' + esc(c.compensationId) + '"' + (m.busy ? ' disabled' : '') + '>'
          + (form.kind === 'void' ? T('تأكيد الإبطال', 'Confirm void') : T('تأكيد العكس', 'Confirm reverse')) + '</button>'
          + '<button type="button" class="cmp-btn" data-act="cancel">' + T('إلغاء', 'Cancel') + '</button></div></div>';
      }
      if (m.err && m.errId === c.compensationId) h += '<p class="cmp-err" role="alert">' + esc(m.err) + '</p>';
      if (m.okMsg && m.errId === c.compensationId) h += '<p class="cmp-ok" role="status">' + esc(m.okMsg) + '</p>';
      if (open) {
        h += facts(c) + walletFacts(c)
          + '<div class="cmp-kv"><div><span>' + T('التأخير المستثنى', 'Excluded delay') + '</span><b><bdi>' + esc(c.excludedDelayMinutes) + '</bdi> ' + T('د', 'min') + '</b></div>'
          + '<div><span>' + T('التأخير المؤهل', 'Eligible delay') + '</span><b><bdi>' + esc(c.eligibleDelayMinutes) + '</bdi> ' + T('د', 'min') + '</b></div>'
          + '<div><span>' + T('المرجع', 'Reference') + '</span><b><bdi>' + esc(c.compensationId) + '</bdi></b></div>'
          + (c.walletReference ? '<div><span>' + T('مرجع المحفظة', 'Wallet reference') + '</span><b><bdi>' + esc(c.walletReference.lotId) + '</bdi></b></div>' : '')
          + '</div>'
          + '<ul class="cmp-life"><li>' + esc(when(c.issuedAt)) + ' — ' + T('صدر تلقائيًا', 'Issued automatically') + '</li>'
          + (c.lifecycle || []).map(function (e) {
              var label = e.type === 'added_to_wallet' ? T('أضافه العميل إلى المحفظة', 'Added to wallet by the customer')
                : e.type === 'voided' ? T('أُبطل', 'Voided') : e.type === 'reversed' ? T('عُكس', 'Reversed') : e.type;
              return '<li>' + esc(when(e.at)) + ' — ' + esc(label) + (e.amount ? ' · <bdi>' + esc(e.amount) + '</bdi> ' + KWD() : '')
                + (e.actor && e.actor.name ? ' · ' + esc(e.actor.name) : '') + (e.reason ? ' · ' + esc(e.reason) : '') + '</li>';
            }).join('') + '</ul>';
      }
      return h + '</div>';
    }).join('') + '</div>';
  }

  function paint(m){
    if (!m.el.isConnected) return false;
    var focus = document.activeElement, keepReason = focus && focus.getAttribute && focus.getAttribute('data-act') === 'reason' && m.el.contains(focus);
    if (keepReason) return true;                       /* never repaint under a reason being typed */
    m.el.innerHTML = m.mode === 'order' ? paintOrder(m) : m.mode === 'wallet' ? paintWallet(m) : paintAdmin(m);
    if (typeof m.onRender === 'function') { try { m.onRender(m.el); } catch (e) {} }
    return true;
  }
  function onClick(m, ev){
    var b = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!b || !m.el.contains(b) || b.tagName === 'TEXTAREA') return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id'), C = global.RAFCompensation;
    if (m.busy && (act === 'add' || act === 'confirm')) return;          /* one request at a time per widget */
    m.err = ''; m.okMsg = ''; m.typing = false;
    /* lifecycle writes are serialized by the authority and resolve later */
    function settle(p, onOk){
      m.busy = true; m.errId = id; paint(m);
      Promise.resolve(p).then(function (r) {
        m.busy = false;
        if (!r || !r.ok) m.err = (r && r.message) || T('تعذّرت العملية.', 'The operation failed.'); else onOk(r);
        paint(m);
      });
    }
    if (act === 'add') {
      settle(C.addToWallet(id), function () { m.okMsg = T('أُضيفت القسيمة إلى محفظة RAF.', 'The coupon was added to your RAF Wallet.'); });
      return;
    } else if (act === 'toggle') { m.open = m.open === id ? null : id; }
    else if (act === 'form') { m.form = { id:id, kind:b.getAttribute('data-kind'), reason:'' }; }
    else if (act === 'cancel') { m.form = null; }
    else if (act === 'confirm' && m.form) {
      var kind = m.form.kind, reason = m.form.reason;
      if (document.activeElement && m.el.contains(document.activeElement)) document.activeElement.blur();
      settle(kind === 'void' ? C.void(id, { reason:reason }) : C.reverse(id, { reason:reason }), function (r) {
        m.form = null;
        m.okMsg = r.reversed ? T('عُكس رصيد التعويض غير المستخدم: ', 'Unused compensation credit reversed: ') + r.reversed + ' ' + KWD() : T('أُبطل التعويض.', 'The compensation was voided.');
      });
      return;
    }
    if (document.activeElement && m.el.contains(document.activeElement)) document.activeElement.blur();
    paint(m);
  }

  function mount(el, opts){
    if (!el) return null;
    opts = opts || {};
    injectStyle();
    MOUNTS = MOUNTS.filter(function (x) { return x.el.isConnected && x.el !== el; });
    var m = { el:el, mode:opts.mode === 'order' || opts.mode === 'wallet' ? opts.mode : 'admin', orderId:opts.orderId || null,
              onRender:opts.onRender, err:'', okMsg:'', errId:null, busy:false, open:null, form:null, uid:++uid };
    /* a host page that repaints replaces this element: the open detail, an
       unfinished reason and its focus survive through SAVED (per mode/order) */
    var key = m.mode + '|' + (m.orderId || ''), prev = el.__cmpMount || SAVED[key];
    if (prev) ['err', 'okMsg', 'errId', 'open', 'form', 'typing'].forEach(function (k) { m[k] = prev[k]; });
    if (!el.__cmpMount) {
      el.addEventListener('click', function (ev) { onClick(el.__cmpMount, ev); });
      el.addEventListener('input', function (ev) { var x = el.__cmpMount; if (ev.target.getAttribute('data-act') === 'reason' && x.form) { x.form.reason = ev.target.value; x.typing = true; } });
      el.addEventListener('focusout', function (ev) { var x = el.__cmpMount; if (ev.relatedTarget && x) x.typing = false; });
    }
    el.__cmpMount = m; SAVED[key] = m;
    MOUNTS.push(m);
    if (!subscribed && global.RAFEventBus) {
      subscribed = true;
      RAFEventBus.subscribe('compensation.*', refresh);
      RAFEventBus.subscribe('config.changed', refresh);
    }
    paint(m);
    if (m.form && m.typing) {
      var ta = el.querySelector('textarea[data-act="reason"]');
      if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {} }
    }
    return m;
  }
  function refresh(){ MOUNTS = MOUNTS.filter(function (m) { return paint(m); }); }

  global.RAFCompUI = { mount:mount, refresh:refresh };
})(window);
