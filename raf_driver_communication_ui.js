/* ============================================================================
 * RAF Marketplace — CUSTOMER ↔ DRIVER CONVERSATION WIDGET (UI only) — Phase H
 * ----------------------------------------------------------------------------
 * One rendering of the conversation, used by the customer's tracking page,
 * the Driver App and the Logistics Management history viewer. It decides
 * nothing: every read, send, receipt and call goes through
 * RAFDriverCommunication, which enforces identity, ownership, lifecycle and
 * limits; translating a text message goes through RAFMessageTranslation (the
 * widget only shows its result under the unchanged original). Live updates
 * come from RAFEventBus (no polling). The only timer is
 * the single auto-stop deadline of a voice recording.
 *
 *   RAFCommUI.mount(element, { orderId, mode:'participant' | 'admin' })
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFCommUI) return;

  function A(){ return global.RAFDriverCommunication; }
  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]; }); }
  function when(t){ try { return new Date(t).toLocaleString(isEn() ? 'en-GB' : 'ar-KW-u-nu-latn', { timeZone:'Asia/Kuwait', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }); } catch (e) { return ''; } }
  function newClientId(){
    var r = '';
    try { var a = new Uint8Array(12); global.crypto.getRandomValues(a); for (var i = 0; i < a.length; i++) r += ('0' + a[i].toString(16)).slice(-2); }
    catch (e) { r = Date.now().toString(36) + Math.random().toString(36).slice(2, 12); }
    return 'c' + r;
  }
  function kb(n){ return n == null ? '' : Math.round(n / 1024) + ' KB'; }

  var CSS = '.rc{font-size:14px;color:var(--ink,#1c1606);}'
    + '.rc-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;}'
    + '.rc-h b{flex:1 1 160px;min-width:0;font-size:15px;font-weight:800;}'
    + '.rc-tag{display:inline-flex;align-items:center;gap:5px;min-height:26px;padding:0 10px;border-radius:20px;font-size:12px;font-weight:800;background:var(--bg3,#eee);color:var(--text2,#444);}'
    + '.rc-tag.on{background:rgba(46,158,91,.14);color:#1F7A45;}'
    + '.rc-sub{font-size:12.5px;color:var(--text3,#666);line-height:1.7;margin:0 0 8px;}'
    + '.rc-thread{display:flex;flex-direction:column;gap:8px;max-height:420px;overflow-y:auto;padding:4px 2px;margin:6px 0 10px;}'
    + '.rc-msg{max-width:86%;border-radius:14px;padding:8px 11px;border:1px solid var(--border,#ddd);background:var(--card,#fff);overflow-wrap:anywhere;}'
    + '.rc-msg.mine{align-self:flex-end;background:var(--gold-soft,#f5ecd3);border-color:var(--gold2,#b8912f);}'
    + '.rc-msg.prev{opacity:.78;border-style:dashed;}'
    + '.rc-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--text3,#666);margin-top:4px;}'
    + '.rc-who{font-size:11.5px;font-weight:800;color:var(--text2,#444);margin-bottom:3px;}'
    + '.rc-imgs{display:flex;gap:6px;flex-wrap:wrap;}'
    + '.rc-imgs img{width:110px;height:110px;object-fit:cover;border-radius:10px;border:1px solid var(--border,#ddd);display:block;}'
    + '.rc-msg audio,.rc-rec audio{width:100%;max-width:260px;display:block;}'
    + '.rc-life{font-size:11.5px;color:var(--text3,#666);text-align:center;margin:2px 0;}'
    + '.rc-comp{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border,#ddd);padding-top:10px;}'
    + '.rc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;}'
    + '.rc-row textarea{flex:1 1 180px;min-width:0;min-height:48px;border-radius:12px;border:1px solid var(--border2,#ccc);background:var(--card,#fff);color:var(--ink,#111);font-family:inherit;font-size:14px;padding:10px 12px;resize:vertical;box-sizing:border-box;}'
    + '.rc .rc-b{min-height:48px;padding:0 14px;border-radius:12px;border:1px solid var(--border2,#ccc);background:var(--card,#fff);color:var(--ink,#111);font-family:inherit;font-size:13.5px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;}'
    + '.rc .rc-b.pri{background:var(--gold,#d4a93c);border-color:var(--gold2,#b8912f);color:#1C1606;}'
    + '.rc .rc-b:disabled{opacity:.5;cursor:not-allowed;}'
    + '.rc .rc-b:focus-visible,.rc-row textarea:focus-visible{outline:2px solid var(--gold,#d4a93c);outline-offset:2px;}'
    + '.rc-thumbs{display:flex;gap:6px;flex-wrap:wrap;}'
    + '.rc-thumb{position:relative;}.rc-thumb img{width:64px;height:64px;object-fit:cover;border-radius:8px;display:block;}'
    + '.rc-thumb button{position:absolute;inset-inline-end:-6px;top:-6px;min-width:28px;min-height:28px;border-radius:50%;border:1px solid var(--border2,#ccc);background:var(--card,#fff);cursor:pointer;}'
    + '.rc-err{color:#A63A36;font-size:12.5px;}'
    + '.rc-call{border:1px solid var(--border,#ddd);border-radius:12px;padding:10px 12px;font-size:13px;line-height:1.7;}'
    + '.rc-call a{font-weight:800;}'
    + '.rc-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;}'
    + '.rc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}'
    + '.rc-tr{margin-top:6px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;}'
    + '.rc .rc-b.rc-mini{min-height:44px;padding:0 12px;font-size:12.5px;}'
    + '.rc-trbox{width:100%;box-sizing:border-box;border-inline-start:3px solid var(--gold,#d4a93c);padding:6px 10px;background:var(--bg,#f7f3ea);border-radius:8px;overflow-wrap:anywhere;}'
    + '.rc-trlab{font-size:11.5px;font-weight:800;color:var(--text3,#666);margin-bottom:2px;}'
    + '.rc-orig[data-shown-with-translation="1"]::before{content:attr(data-orig-label);display:block;font-size:11.5px;font-weight:800;color:var(--text3,#666);}';
  function injectCss(){
    if (document.getElementById('rcCss')) return;
    var s = document.createElement('style'); s.id = 'rcCss'; s.textContent = CSS; document.head.appendChild(s);
  }

  var STATE = {};                                 /* orderId → composer / recorder / call state (survives re-mounts) */
  var MOUNTS = [];                                /* { el, orderId, mode } */
  function stateOf(id){
    return STATE[id] || (STATE[id] = { draft:'', textId:newClientId(), images:[], imagesId:newClientId(), rec:{ state:'idle' },
                                       voiceId:newClientId(), busy:false, err:'', call:null });
  }
  function statusLabel(s){
    return s.state === 'read' ? T('مقروءة', 'Read') : (s.state === 'delivered' ? T('وصلت', 'Delivered') : T('أُرسلت', 'Sent'));
  }
  var LIFE = {
    opened:            ['بدأت المحادثة مع ', 'Conversation opened with '],
    driver_assigned:   ['انضم السائق ', 'Driver joined: '],
    driver_transferred:['انتقلت المحادثة إلى ', 'Conversation moved to '],
    driver_released:   ['أُعيد الطلب للقائمة — لا يوجد سائق', 'Returned to pool — no driver'],
    closed:            ['أُغلقت المحادثة — تم التسليم', 'Conversation closed — delivered']
  };

  /* ---------- translation (presentation only; RAFMessageTranslation decides) ----------
     State is per message + target language, in memory. The original text is
     never replaced: the translation appears underneath it. The target is the
     page's existing RAF language (htmlRoot lang). */
  var TRS = {};
  function targetLang(){ var r = document.getElementById('htmlRoot') || document.documentElement; return (r.lang || 'ar').toLowerCase(); }
  function trState(mid){ return TRS[mid + '|' + targetLang()] || { status:'idle' }; }
  function translationHTML(mid){
    var t = trState(mid), btn = function (act, icon, ar, en, dis) {
      return '<button type="button" class="rc-b rc-mini" data-rc="' + act + '" data-mid="' + esc(mid) + '"' + (dis ? ' disabled aria-busy="true"' : '') + '>'
        + '<i class="ti ' + icon + '" aria-hidden="true"></i>' + esc(T(ar, en)) + '</button>'; };
    if (t.status === 'idle' || t.hidden) return btn('translate', 'ti-language', 'ترجمة', 'Translate');
    if (t.status === 'loading') return btn('translate', 'ti-loader-2', 'جارٍ الترجمة…', 'Translating…', true);
    var hide = btn('hideTranslation', 'ti-eye-off', 'إخفاء الترجمة', 'Hide translation');
    if (t.status === 'TRANSLATED')
      return '<div class="rc-trbox" role="status"><div class="rc-trlab">' + esc(T('الترجمة', 'Translation'))
        + (t.sourceLanguage ? ' <bdi dir="ltr">(' + esc(t.sourceLanguage) + ' → ' + esc(t.targetLanguage) + ')</bdi>' : '') + '</div>'
        + '<div dir="auto">' + esc(t.translatedText) + '</div></div>' + hide;
    if (t.status === 'TRANSLATION_FAILED')
      return '<div class="rc-sub" role="status" style="margin:4px 0">' + esc(t.message) + '</div>' + btn('translate', 'ti-refresh', 'حاول مرة أخرى', 'Try again') + hide;
    return '<div class="rc-sub" role="status" style="margin:4px 0">' + esc(t.message || '') + '</div>' + hide;
  }
  function paintTranslation(mid){
    var sel = global.CSS && global.CSS.escape ? global.CSS.escape(mid) : String(mid).replace(/["\\]/g, '\\$&');
    Array.prototype.forEach.call(document.querySelectorAll('[data-tr-for="' + sel + '"]'), function (x) {
      x.innerHTML = translationHTML(mid);
      var t = trState(mid), o = x.parentNode.querySelector('[data-orig-for]');
      if (o) o.setAttribute('data-shown-with-translation', t.status === 'TRANSLATED' && !t.hidden ? '1' : '0');
    });
  }
  function requestTranslation(m, mid){
    var key = mid + '|' + targetLang(), cur = TRS[key];
    if (cur && cur.status === 'loading') return;                   /* one request per message at a time */
    TRS[key] = { status:'loading' }; paintTranslation(mid);
    RAFMessageTranslation.translate(m.orderId, mid, { targetLanguage:targetLang() }).then(function (r) {
      TRS[key] = { status:r.status, translatedText:r.translatedText, sourceLanguage:r.sourceLanguage, targetLanguage:r.targetLanguage, message:r.message };
      paintTranslation(mid);
    });
  }

  function messageHTML(m, viewerRole, admin){
    var cls = 'rc-msg' + (m.mine ? ' mine' : '') + (m.previousDriver && viewerRole === 'driver' ? ' prev' : '');
    var who = m.mine ? T('أنت', 'You')
      : (m.senderType === 'driver' ? T('السائق', 'Driver') + (m.senderName ? ' · ' + m.senderName : '') : T('العميل', 'Customer'));
    if (m.previousDriver && m.senderType === 'driver' && !m.mine) who += ' · ' + T('سائق سابق', 'previous driver');
    if (m.previousDriver && viewerRole === 'driver') who += ' · ' + T('سجل سابق (للاطلاع)', 'earlier history (read-only)');
    var body = '';
    var trNow = trState(m.messageId);
    if (m.type === 'text') body = '<div class="rc-orig" data-orig-for="' + esc(m.messageId) + '" data-orig-label="' + esc(T('النص الأصلي', 'Original')) + '"'
        + ' data-shown-with-translation="' + (trNow.status === 'TRANSLATED' && !trNow.hidden ? '1' : '0') + '">' + esc(m.text) + '</div>'
      + (global.RAFMessageTranslation ? '<div class="rc-tr" data-tr-for="' + esc(m.messageId) + '">' + translationHTML(m.messageId) + '</div>' : '');
    if (m.type === 'image') body = '<div class="rc-imgs">' + (m.images || []).map(function (x) {
      return x.dataUrl && /^data:image\//.test(x.dataUrl) ? '<img src="' + esc(x.dataUrl) + '" alt="' + esc(T('صورة مرسلة', 'Sent image')) + '" loading="lazy">' : '<span>' + esc(T('الصورة غير متاحة', 'Image unavailable')) + '</span>';
    }).join('') + '</div>';
    if (m.type === 'voice') body = m.voice && m.voice.dataUrl && /^data:audio\//.test(m.voice.dataUrl)
      ? '<audio controls preload="none" src="' + esc(m.voice.dataUrl) + '" aria-label="' + esc(T('رسالة صوتية', 'Voice message')) + '"></audio>'
        + '<div class="rc-meta"><bdi dir="ltr">' + Math.round((m.voice.durationMs || 0) / 1000) + 's</bdi></div>'
      : '<span>' + esc(T('الرسالة الصوتية غير متاحة', 'Voice message unavailable')) + '</span>';
    var meta = '<bdi>' + esc(when(m.at)) + '</bdi>';
    if (m.mine || admin) meta += ' · <span data-status="' + esc(m.status.state) + '">' + esc(statusLabel(m.status)) + '</span>';
    return '<div class="' + cls + '" data-mid="' + esc(m.messageId) + '"><div class="rc-who">' + esc(who) + '</div>' + body + '<div class="rc-meta">' + meta + '</div></div>';
  }

  function composerHTML(id, s, conv){
    var lim = conv.limits || {}, h = '<div class="rc-comp">';
    if (s.err) h += '<div class="rc-err" role="alert">' + esc(s.err) + '</div>';
    /* text */
    h += '<div class="rc-row"><label class="rc-sr" for="rcText-' + esc(id) + '">' + esc(T('نص الرسالة', 'Message text')) + '</label>'
      + '<textarea id="rcText-' + esc(id) + '" data-rc="text" maxlength="' + (lim.maxTextLength || 2000) + '" placeholder="' + esc(T('اكتب رسالة…', 'Write a message…')) + '">' + esc(s.draft) + '</textarea>'
      + '<button type="button" class="rc-b pri" data-rc="sendText"' + (s.busy ? ' disabled' : '') + '><i class="ti ti-send" aria-hidden="true"></i>' + esc(T('إرسال', 'Send')) + '</button></div>';
    /* images */
    h += '<div class="rc-row"><input class="rc-file" type="file" id="rcFile-' + esc(id) + '" data-rc="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple>'
      + '<label class="rc-b" for="rcFile-' + esc(id) + '" tabindex="0" data-rc="pick"><i class="ti ti-photo" aria-hidden="true"></i>' + esc(T('صور', 'Images'))
      + (lim.maxImagesPerMessage ? ' <span class="rc-sub" style="margin:0">(' + esc(T('حتى ', 'up to ')) + lim.maxImagesPerMessage + ' · ' + kb(lim.maxImageBytes) + ')</span>' : '') + '</label>';
    if (s.images.length) h += '<div class="rc-thumbs">' + s.images.map(function (x, i) {
        return '<span class="rc-thumb"><img src="' + esc(x.dataUrl) + '" alt=""><button type="button" data-rc="unpick" data-i="' + i + '" aria-label="' + esc(T('إزالة الصورة', 'Remove image')) + '">×</button></span>'; }).join('')
      + '</div><button type="button" class="rc-b pri" data-rc="sendImages"' + (s.busy ? ' disabled' : '') + '><i class="ti ti-send" aria-hidden="true"></i>' + esc(T('إرسال الصور', 'Send images')) + '</button>';
    h += '</div>';
    /* voice */
    var r = s.rec;
    h += '<div class="rc-row rc-rec" aria-live="polite">';
    if (r.state === 'idle') h += '<button type="button" class="rc-b" data-rc="record"><i class="ti ti-microphone" aria-hidden="true"></i>' + esc(T('تسجيل صوتي', 'Record voice')) + '</button>';
    if (r.state === 'recording') h += '<span class="rc-tag on"><i class="ti ti-point-filled" aria-hidden="true"></i>' + esc(T('جارٍ التسجيل…', 'Recording…')) + '</span>'
      + '<button type="button" class="rc-b pri" data-rc="stop"><i class="ti ti-player-stop" aria-hidden="true"></i>' + esc(T('إيقاف', 'Stop')) + '</button>'
      + '<button type="button" class="rc-b" data-rc="cancelRec"><i class="ti ti-x" aria-hidden="true"></i>' + esc(T('إلغاء', 'Cancel')) + '</button>';
    if (r.state === 'preview') h += '<audio controls src="' + esc(r.dataUrl) + '" aria-label="' + esc(T('معاينة التسجيل', 'Recording preview')) + '"></audio>'
      + '<span class="rc-sub" style="margin:0"><bdi dir="ltr">' + Math.round(r.durationMs / 1000) + 's · ' + kb(r.bytes) + '</bdi></span>'
      + '<button type="button" class="rc-b pri" data-rc="sendVoice"' + (s.busy ? ' disabled' : '') + '><i class="ti ti-send" aria-hidden="true"></i>' + esc(T('إرسال', 'Send')) + '</button>'
      + '<button type="button" class="rc-b" data-rc="rerecord"><i class="ti ti-refresh" aria-hidden="true"></i>' + esc(T('إعادة التسجيل', 'Re-record')) + '</button>'
      + '<button type="button" class="rc-b" data-rc="cancelRec"><i class="ti ti-x" aria-hidden="true"></i>' + esc(T('إلغاء', 'Cancel')) + '</button>';
    return h + '</div></div>';
  }

  function render(m){
    var out = draw(m);
    if (out !== false && m.onRender) { try { m.onRender(m.el); } catch (e) {} }
    return out;
  }
  function draw(m){
    var el = m.el, id = m.orderId, s = stateOf(id), C = A();
    if (!el || !document.contains(el)) return false;
    if (!C) { el.innerHTML = ''; return true; }
    var focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.getAttribute('data-rc') : null;
    injectCss();
    if (m.mode === 'admin') {
      var hr = C.history(id);
      if (!hr.ok) { el.innerHTML = '<div class="rc"><p class="rc-sub" role="status">' + esc(hr.message) + '</p></div>'; return true; }
      var hh = '<div class="rc"><div class="rc-h"><b>' + esc(T('محادثة العميل والسائق — ', 'Customer ↔ driver conversation — ')) + '<bdi>' + esc(id) + '</bdi></b>'
        + '<span class="rc-tag' + (hr.conversation.active ? ' on' : '') + '">' + esc(hr.conversation.closed ? T('مغلقة', 'Closed') : (hr.conversation.active ? T('نشطة', 'Active') : T('بلا سائق', 'No driver'))) + '</span>'
        + '<span class="rc-tag">' + esc(T('للاطلاع فقط', 'Read-only')) + '</span></div>'
        + '<p class="rc-sub">' + esc(T('سجل إداري ثابت لا يمكن تعديله أو حذفه.', 'Administrative, immutable record — cannot be edited or deleted.')) + '</p>'
        + '<div class="rc-thread">' + mergeTimeline(hr.lifecycle, hr.messages, 'admin') + '</div></div>';
      el.innerHTML = hh; return true;
    }
    var r = C.conversation(id);
    if (!r.ok) {
      el.innerHTML = r.code === 'NO_CONVERSATION' || r.code === 'FORBIDDEN' || r.code === 'ORDER_NOT_FOUND' ? ''
        : '<div class="rc"><p class="rc-sub" role="status">' + esc(r.message) + '</p></div>';
      return true;
    }
    var conv = r.conversation, role = conv.role;
    var h = '<div class="rc"><div class="rc-h"><b>' + esc(role === 'customer' ? T('المحادثة مع السائق', 'Chat with your driver') : T('المحادثة مع العميل', 'Chat with the customer')) + '</b>'
      + '<span class="rc-tag' + (conv.active ? ' on' : '') + '">' + esc(conv.closed ? T('مغلقة', 'Closed') : (conv.active ? T('نشطة', 'Active') : T('بانتظار سائق', 'Waiting for a driver'))) + '</span>';
    if (conv.canCall) h += '<button type="button" class="rc-b" data-rc="call"><i class="ti ti-phone" aria-hidden="true"></i>' + esc(T('اتصال', 'Call')) + '</button>';
    h += '</div>';
    if (role === 'customer' && conv.currentDriver) h += '<p class="rc-sub">' + esc(T('السائق الحالي: ', 'Current driver: ')) + '<b>' + esc(conv.currentDriver.name || '') + '</b></p>';
    if (conv.closed) h += '<p class="rc-sub">' + esc(T('أُغلقت المحادثة بتسليم الطلب. لا يمكن إرسال رسائل جديدة.', 'The conversation closed when the order was delivered. No new messages can be sent.')) + '</p>';
    if (s.call && conv.canCall) {
      h += '<div class="rc-call" role="status">' + (s.call.ok
        ? esc(s.call.target.name || '') + ' · <bdi dir="ltr">' + esc(s.call.target.phone) + '</bdi><br><a class="rc-b pri" href="' + esc(s.call.dialHref) + '"><i class="ti ti-phone-call" aria-hidden="true"></i>' + esc(T('اتصال من الجهاز', 'Call from device')) + '</a>'
          + '<div class="rc-sub" style="margin:6px 0 0">' + esc(T('اتصال مباشر بالرقم المسجّل. الاتصال المخفي الرقم غير مُهيّأ بعد.', 'Direct call to the recorded number. Masked calling is not configured yet.')) + '</div>'
        : esc(s.call.message)) + '</div>';
    }
    h += '<div class="rc-thread" data-rc="thread">' + (r.messages.length ? r.messages.map(function (x) { return messageHTML(x, role, false); }).join('')
      : '<p class="rc-sub">' + esc(T('لا توجد رسائل بعد.', 'No messages yet.')) + '</p>') + '</div>';
    if (conv.canSend) h += composerHTML(id, s, conv);
    el.innerHTML = h + '</div>';
    var th = el.querySelector('[data-rc="thread"]'); if (th) th.scrollTop = th.scrollHeight;
    if (focused) { var f = el.querySelector('[data-rc="' + focused + '"]'); if (f) { f.focus(); if (f.setSelectionRange && f.value != null) try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) {} } }
    /* the recipient's own client moves the status: delivered on arrival, read when shown */
    if (conv.active) {
      C.markDelivered(id);
      if (document.visibilityState === 'visible') C.markRead(id);
    }
    return true;
  }
  function mergeTimeline(life, msgs, role){
    var items = life.map(function (e) { return { at:e.at, html:'<div class="rc-life">' + esc(T(LIFE[e.type][0], LIFE[e.type][1])) + (e.to ? esc(e.to) : '') + ' · <bdi>' + esc(when(e.at)) + '</bdi></div>' }; })
      .concat(msgs.map(function (m) { return { at:m.at, html:messageHTML(m, role, true) }; }));
    items.sort(function (a, b) { return a.at - b.at; });
    return items.length ? items.map(function (i) { return i.html; }).join('') : '<p class="rc-sub">' + esc(T('لا توجد رسائل.', 'No messages.')) + '</p>';
  }

  /* ---------- interactions ---------- */
  function mountOf(el){ return MOUNTS.filter(function (m) { return m.el === el; })[0]; }
  function rerender(orderId){
    MOUNTS = MOUNTS.filter(function (m) { return document.contains(m.el); });
    MOUNTS.forEach(function (m) { if (!orderId || m.orderId === orderId) render(m); });
  }
  function result(m, res, reset){
    var s = stateOf(m.orderId); s.busy = false;
    if (!res.ok) { s.err = res.message; render(m); return; }
    s.err = ''; reset(s); render(m);
  }
  function readFiles(files){
    return Promise.all(Array.prototype.map.call(files, function (file) {
      return new Promise(function (res) {
        var fr = new FileReader();                          /* the original bytes, unchanged */
        fr.onload = function () { res({ dataUrl:String(fr.result), bytes:file.size, name:file.name }); };
        fr.onerror = function () { res(null); };
        fr.readAsDataURL(file);
      });
    }));
  }
  function stopTracks(r){ try { (r.stream && r.stream.getTracks ? r.stream.getTracks() : []).forEach(function (t) { t.stop(); }); } catch (e) {} }
  function startRecording(m){
    var s = stateOf(m.orderId), lim = (A().conversation(m.orderId).conversation || {}).limits || {};
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !global.MediaRecorder) { s.err = T('التسجيل الصوتي غير مدعوم في هذا المتصفح.', 'Voice recording is not supported in this browser.'); render(m); return; }
    navigator.mediaDevices.getUserMedia({ audio:true }).then(function (stream) {
      var rec = new MediaRecorder(stream), chunks = [], token = {};
      s.rec = { state:'recording', recorder:rec, stream:stream, startedAt:Date.now(), token:token };
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function () {
        stopTracks(s.rec);
        if (s.rec.token !== token || s.rec.discard) { if (s.rec.token === token) s.rec = { state:'idle' }; render(m); return; }
        var dur = Date.now() - s.rec.startedAt, blob = new Blob(chunks, { type:rec.mimeType || 'audio/webm' });
        var fr = new FileReader();
        fr.onload = function () { s.rec = { state:'preview', dataUrl:String(fr.result), bytes:blob.size, durationMs:dur }; s.voiceId = newClientId(); render(m); };
        fr.readAsDataURL(blob);
      };
      rec.start();
      /* the one deadline: stop at the configured maximum length */
      if (typeof lim.maxVoiceSeconds === 'number') setTimeout(function () { if (s.rec.token === token && s.rec.state === 'recording') try { rec.stop(); } catch (e) {} }, lim.maxVoiceSeconds * 1000);
      s.err = ''; render(m);
    }).catch(function () { s.err = T('لم يُسمح بالوصول إلى الميكروفون.', 'Microphone access was not allowed.'); render(m); });
  }
  function onClick(e){
    var btn = e.target.closest('[data-rc]'); if (!btn) return;
    var root = btn.closest('[data-rc-mount]'); var m = root && mountOf(root); if (!m) return;
    var s = stateOf(m.orderId), C = A(), act = btn.getAttribute('data-rc');
    if (act === 'translate') { if (global.RAFMessageTranslation) requestTranslation(m, btn.getAttribute('data-mid')); return; }
    if (act === 'hideTranslation') { var hk = btn.getAttribute('data-mid') + '|' + targetLang(); TRS[hk] = { status:'idle' }; paintTranslation(btn.getAttribute('data-mid')); return; }
    if (act === 'call') { s.call = C.call(m.orderId); render(m); return; }
    if (act === 'sendText') {
      if (s.busy) return; s.busy = true;
      result(m, C.send(m.orderId, { type:'text', text:s.draft, clientId:s.textId }), function (x) { x.draft = ''; x.textId = newClientId(); });
      return;
    }
    if (act === 'unpick') { s.images.splice(+btn.getAttribute('data-i'), 1); s.imagesId = newClientId(); render(m); return; }
    if (act === 'sendImages') {
      if (s.busy) return; s.busy = true;
      result(m, C.send(m.orderId, { type:'image', images:s.images.map(function (x) { return x.dataUrl; }), clientId:s.imagesId }), function (x) { x.images = []; x.imagesId = newClientId(); });
      return;
    }
    if (act === 'record') { startRecording(m); return; }
    if (act === 'stop') { if (s.rec.recorder) try { s.rec.recorder.stop(); } catch (x) {} return; }
    if (act === 'cancelRec') {
      if (s.rec.state === 'recording') { s.rec.discard = true; try { s.rec.recorder.stop(); } catch (x) {} stopTracks(s.rec); }
      s.rec = { state:'idle' }; render(m); return;
    }
    if (act === 'rerecord') { s.rec = { state:'idle' }; startRecording(m); return; }
    if (act === 'sendVoice') {
      if (s.busy || s.rec.state !== 'preview') return; s.busy = true;
      result(m, C.send(m.orderId, { type:'voice', voice:{ dataUrl:s.rec.dataUrl, durationMs:s.rec.durationMs }, clientId:s.voiceId }), function (x) { x.rec = { state:'idle' }; x.voiceId = newClientId(); });
    }
  }
  function onInput(e){
    var t = e.target; if (!t.getAttribute) return;
    var root = t.closest('[data-rc-mount]'); var m = root && mountOf(root); if (!m) return;
    var s = stateOf(m.orderId);
    if (t.getAttribute('data-rc') === 'text') { if (t.value !== s.draft) { s.draft = t.value; } }
  }
  function onChange(e){
    var t = e.target; if (!t.getAttribute || t.getAttribute('data-rc') !== 'file') return;
    var root = t.closest('[data-rc-mount]'); var m = root && mountOf(root); if (!m) return;
    var s = stateOf(m.orderId);
    readFiles(t.files || []).then(function (list) {
      list.filter(Boolean).forEach(function (x) { s.images.push(x); });
      s.imagesId = newClientId(); s.err = ''; render(m);
    });
  }
  var wired = false;
  function wire(){
    if (wired) return; wired = true;
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var l = e.target.closest && e.target.closest('label[data-rc="pick"]'); if (l) { e.preventDefault(); var f = document.getElementById(l.getAttribute('for')); if (f) f.click(); }
    });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') rerender(null); });
    if (global.RAFEventBus) ['communication.*', 'ownership.*', 'logistics.delivery.*', 'order.changed'].forEach(function (p) {
      RAFEventBus.subscribe(p, function (ev) { rerender(ev && ev.entityId ? ev.entityId : null); });
    });
  }

  function mount(el, opts){
    if (!el || !opts || !opts.orderId) return;
    wire();
    el.setAttribute('data-rc-mount', '');
    MOUNTS = MOUNTS.filter(function (m) { return m.el !== el && document.contains(m.el); });
    var m = { el:el, orderId:String(opts.orderId), mode:opts.mode === 'admin' ? 'admin' : 'participant',
              onRender:typeof opts.onRender === 'function' ? opts.onRender : null };
    MOUNTS.push(m);
    render(m);
  }

  global.RAFCommUI = { mount:mount, refresh:rerender };
})(window);
