/* ============================================================================
 * RAF Marketplace — CUSTOMER ↔ DRIVER CONVERSATION WIDGET  (RAFCommUI, UI only)
 * ----------------------------------------------------------------------------
 * One rendering of the conversation, used by the customer's tracking page and
 * the Driver App. It decides nothing: every read, send, receipt and call goes
 * through RAFDriverCommunication, which enforces identity, ownership,
 * lifecycle and limits; translating a text message goes through
 * RAFMessageTranslation (the result is shown under the unchanged original).
 *
 *   RAFCommUI.mount(element, { orderId, title?:false, call?:false, onRender? })
 *
 * WHEN THE AUTHORITY REFUSES, THE WIDGET RENDERS NOTHING. There is no
 * conversation before a driver owns the delivery, while it is back in the
 * pool, for anyone who is not a participant, and — current decision — after
 * Delivered: no messages, composer, call or translation are shown then.
 *
 * STATUS — the recipient's page moves it: Delivered when the conversation is
 * rendered for them, Read only while the widget is actually on screen in a
 * visible tab. Opening a translation does neither.
 *
 * CALL — the authority counts the attempt and returns a dial link; the widget
 * opens it straight away. The number itself is never displayed.
 *
 * LIVE UPDATES come from RAFEventBus (no polling). The only timer is the one
 * auto-stop deadline of a voice recording.
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

  var CSS = '.rc{font-size:14px;color:var(--d-ink,var(--ink,#1c1606));}'
    + '.rc-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;}'
    + '.rc-h b{flex:1 1 150px;min-width:0;font-size:15px;font-weight:800;overflow-wrap:anywhere;}'
    + '.rc-sub{font-size:12.5px;color:var(--d-muted,var(--text3,#666));line-height:1.7;margin:0 0 6px;overflow-wrap:anywhere;}'
    + '.rc-thread{display:flex;flex-direction:column;gap:8px;max-height:380px;overflow-y:auto;padding:4px 2px;margin:6px 0 10px;}'
    + '.rc-msg{max-width:86%;align-self:flex-start;border-radius:14px;padding:8px 11px;border:1px solid var(--d-line,var(--border,#ddd));background:var(--d-card,var(--card,#fff));overflow-wrap:anywhere;}'
    + '.rc-msg.mine{align-self:flex-end;background:var(--d-soft,var(--gold-soft,#f5ecd3));border-color:var(--d-line2,var(--gold2,#b8912f));}'
    + '.rc-msg.prev{opacity:.8;border-style:dashed;}'
    + '.rc-meta{display:flex;gap:6px;flex-wrap:wrap;font-size:11.5px;color:var(--d-faint,var(--text3,#666));margin-top:4px;}'
    + '.rc-who{font-size:11.5px;font-weight:800;color:var(--d-muted,var(--text2,#444));margin-bottom:3px;}'
    + '.rc-imgs{display:flex;gap:6px;flex-wrap:wrap;}'
    + '.rc-imgs img{width:104px;height:104px;max-width:100%;object-fit:cover;border-radius:10px;border:1px solid var(--d-line,#ddd);display:block;}'
    + '.rc-msg audio,.rc-rec audio{width:100%;max-width:260px;display:block;}'
    + '.rc-comp{display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--d-line,var(--border,#ddd));padding-top:10px;}'
    + '.rc-row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;}'
    + '.rc-row textarea{flex:1 1 170px;min-width:0;min-height:48px;border-radius:12px;border:1px solid var(--d-line2,var(--border2,#ccc));background:var(--d-card,#fff);color:inherit;font-family:inherit;font-size:14px;padding:10px 12px;resize:vertical;box-sizing:border-box;}'
    + '.rc .rc-b{min-height:48px;padding:0 14px;border-radius:12px;border:1px solid var(--d-line2,var(--border2,#ccc));background:var(--d-card,#fff);color:inherit;font-family:inherit;font-size:13.5px;font-weight:800;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;max-width:100%;}'
    + '.rc .rc-b.pri{background:var(--d-accent,var(--gold,#d4a93c));border-color:var(--d-accent,var(--gold2,#b8912f));color:var(--rc-pri-ink,#fff);}'
    + '.rc .rc-b:disabled{opacity:.5;cursor:not-allowed;}'
    + '.rc .rc-b:focus-visible,.rc-row textarea:focus-visible{outline:2px solid var(--d-accent,var(--gold,#d4a93c));outline-offset:2px;}'
    + '.rc-thumbs{display:flex;gap:6px;flex-wrap:wrap;}'
    + '.rc-thumb{position:relative;}.rc-thumb img{width:64px;height:64px;object-fit:cover;border-radius:8px;display:block;}'
    + '.rc .rc-thumb button{position:absolute;inset-inline-end:-6px;top:-6px;min-width:28px;min-height:28px;border-radius:50%;border:1px solid var(--d-line2,#ccc);background:var(--d-card,#fff);cursor:pointer;}'
    + '.rc-err{color:var(--d-alert,#A63A36);font-size:12.5px;}'
    + '.rc-note{font-size:12.5px;line-height:1.7;color:var(--d-muted,#555);}'
    + '.rc-file{position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;}'
    + '.rc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);}'
    + '.rc-tr{margin-top:6px;display:flex;flex-direction:column;align-items:flex-start;gap:6px;}'
    + '.rc .rc-b.rc-mini{min-height:44px;padding:0 12px;font-size:12.5px;}'
    + '.rc-trbox{width:100%;box-sizing:border-box;border-inline-start:3px solid var(--d-accent,#d4a93c);padding:6px 10px;background:var(--d-bg,#f7f3ea);border-radius:8px;overflow-wrap:anywhere;}'
    + '.rc-trlab{font-size:11.5px;font-weight:800;color:var(--d-faint,#666);margin-bottom:2px;}';
  function injectCss(){
    if (document.getElementById('rcCss')) return;
    var s = document.createElement('style'); s.id = 'rcCss'; s.textContent = CSS; document.head.appendChild(s);
  }

  var STATE = {};                                 /* orderId → composer / recorder / call state (survives re-renders) */
  var MOUNTS = [];                                /* { el, orderId, onRender } */
  function stateOf(id){
    return STATE[id] || (STATE[id] = { draft:'', textId:newClientId(), images:[], imagesId:newClientId(), rec:{ state:'idle' },
                                       voiceId:newClientId(), busy:false, err:'', callMsg:null });
  }
  function statusLabel(s){
    return s.state === 'read' ? T('مقروءة', 'Read') : (s.state === 'delivered' ? T('وصلت', 'Delivered') : T('أُرسلت', 'Sent'));
  }

  /* ---------- translation (presentation only; RAFMessageTranslation decides) ---------- */
  var TRS = {};
  function targetLang(){ var r = document.getElementById('htmlRoot') || document.documentElement; return (r.lang || 'ar').toLowerCase(); }
  function trState(mid){ return TRS[mid + '|' + targetLang()] || { status:'idle' }; }
  function translationHTML(mid){
    var t = trState(mid), btn = function (act, icon, ar, en, dis) {
      return '<button type="button" class="rc-b rc-mini" data-rc="' + act + '" data-mid="' + esc(mid) + '"' + (dis ? ' disabled aria-busy="true"' : '') + '>'
        + '<i class="ti ' + icon + '" aria-hidden="true"></i>' + esc(T(ar, en)) + '</button>'; };
    if (t.status === 'idle') return btn('translate', 'ti-language', 'ترجمة', 'Translate');
    if (t.status === 'loading') return btn('translate', 'ti-loader-2', 'جارٍ الترجمة…', 'Translating…', true);
    var hide = btn('hideTranslation', 'ti-eye-off', 'إخفاء', 'Hide');
    if (t.status === 'TRANSLATED')
      return '<div class="rc-trbox" role="status"><div class="rc-trlab">' + esc(T('الترجمة', 'Translation')) + '</div>'
        + '<div dir="auto">' + esc(t.translatedText) + '</div></div>' + hide;
    return '<div class="rc-sub" role="status" style="margin:4px 0">' + esc(t.message || '') + '</div>' + hide;
  }
  function paintTranslation(mid){
    var sel = global.CSS && global.CSS.escape ? global.CSS.escape(mid) : String(mid).replace(/["\\]/g, '\\$&');
    Array.prototype.forEach.call(document.querySelectorAll('[data-tr-for="' + sel + '"]'), function (x) { x.innerHTML = translationHTML(mid); });
  }
  function requestTranslation(orderId, mid){
    var key = mid + '|' + targetLang(), cur = TRS[key];
    if (cur && cur.status === 'loading') return;
    TRS[key] = { status:'loading' }; paintTranslation(mid);
    global.RAFMessageTranslation.translate(orderId, mid, { targetLanguage:targetLang() }).then(function (r) {
      TRS[key] = { status:r.status, translatedText:r.translatedText, message:r.message };
      paintTranslation(mid);
    });
  }

  function messageHTML(m, role){
    var cls = 'rc-msg' + (m.mine ? ' mine' : '') + (m.earlierDriver && role === 'driver' ? ' prev' : '');
    var who = m.mine ? T('أنت', 'You') : (m.senderType === 'driver' ? T('السائق', 'Driver') : T('العميل', 'Customer'));
    if (m.earlierDriver && role === 'driver') who += ' · ' + T('قبل تعيينك (للاطلاع)', 'before you were assigned (read-only)');
    else if (m.earlierDriver && m.senderType === 'driver' && !m.mine) who += ' · ' + T('سائق سابق', 'previous driver');
    var body = '';
    if (m.type === 'text') body = '<div dir="auto">' + esc(m.text) + '</div>'
      /* translation is offered on the OTHER participant's messages only */
      + (global.RAFMessageTranslation && !m.mine ? '<div class="rc-tr" data-tr-for="' + esc(m.messageId) + '">' + translationHTML(m.messageId) + '</div>' : '');
    if (m.type === 'image') body = '<div class="rc-imgs">' + (m.images || []).map(function (x) {
      return x.dataUrl && /^data:image\//.test(x.dataUrl) ? '<img src="' + esc(x.dataUrl) + '" alt="' + esc(T('صورة مرسلة', 'Sent image')) + '" loading="lazy">'
        : '<span>' + esc(T('الصورة غير متاحة', 'Image unavailable')) + '</span>';
    }).join('') + '</div>';
    if (m.type === 'voice') body = m.voice && m.voice.dataUrl && /^data:audio\//.test(m.voice.dataUrl)
      ? '<audio controls preload="none" src="' + esc(m.voice.dataUrl) + '" aria-label="' + esc(T('رسالة صوتية', 'Voice message')) + '"></audio>'
        + '<div class="rc-meta"><bdi dir="ltr">' + Math.round((m.voice.durationMs || 0) / 1000) + 's</bdi></div>'
      : '<span>' + esc(T('الرسالة الصوتية غير متاحة', 'Voice message unavailable')) + '</span>';
    var meta = '<bdi>' + esc(when(m.at)) + '</bdi>';
    if (m.mine) meta += ' · <span data-status="' + esc(m.status.state) + '">' + esc(statusLabel(m.status)) + '</span>';
    return '<div class="' + cls + '" data-mid="' + esc(m.messageId) + '"><div class="rc-who">' + esc(who) + '</div>' + body + '<div class="rc-meta">' + meta + '</div></div>';
  }

  function composerHTML(id, s, conv){
    var lim = conv.limits || {}, h = '<div class="rc-comp">';
    if (s.err) h += '<div class="rc-err" role="alert">' + esc(s.err) + '</div>';
    h += '<div class="rc-row"><label class="rc-sr" for="rcText-' + esc(id) + '">' + esc(T('نص الرسالة', 'Message text')) + '</label>'
      + '<textarea id="rcText-' + esc(id) + '" data-rc="text" maxlength="' + (lim.maxTextLength || 2000) + '" placeholder="' + esc(T('اكتب رسالة…', 'Write a message…')) + '">' + esc(s.draft) + '</textarea>'
      + '<button type="button" class="rc-b pri" data-rc="sendText"' + (s.busy ? ' disabled' : '') + '><i class="ti ti-send" aria-hidden="true"></i>' + esc(T('إرسال', 'Send')) + '</button></div>';
    if (typeof lim.maxImagesPerMessage === 'number' && typeof lim.maxImageBytes === 'number') {
      h += '<div class="rc-row"><input class="rc-file" type="file" id="rcFile-' + esc(id) + '" data-rc="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple>'
        + '<label class="rc-b" for="rcFile-' + esc(id) + '" tabindex="0" data-rc="pick"><i class="ti ti-photo" aria-hidden="true"></i>' + esc(T('صور', 'Images'))
        + ' <span class="rc-sub" style="margin:0">(' + esc(T('حتى ', 'up to ')) + '<bdi>' + lim.maxImagesPerMessage + ' · ' + kb(lim.maxImageBytes) + '</bdi>)</span></label>';
      if (s.images.length) h += '<div class="rc-thumbs">' + s.images.map(function (x, i) {
          return '<span class="rc-thumb"><img src="' + esc(x.dataUrl) + '" alt=""><button type="button" data-rc="unpick" data-i="' + i + '" aria-label="' + esc(T('إزالة الصورة', 'Remove image')) + '">×</button></span>'; }).join('')
        + '</div><button type="button" class="rc-b pri" data-rc="sendImages"' + (s.busy ? ' disabled' : '') + '><i class="ti ti-send" aria-hidden="true"></i>' + esc(T('إرسال الصور', 'Send images')) + '</button>';
      h += '</div>';
    }
    if (typeof lim.maxVoiceBytes === 'number' && typeof lim.maxVoiceSeconds === 'number') {
      var r = s.rec;
      h += '<div class="rc-row rc-rec" aria-live="polite">';
      if (r.state === 'idle') h += '<button type="button" class="rc-b" data-rc="record"><i class="ti ti-microphone" aria-hidden="true"></i>' + esc(T('رسالة صوتية', 'Voice message'))
        + ' <span class="rc-sub" style="margin:0">(' + esc(T('حتى ', 'up to ')) + '<bdi>' + lim.maxVoiceSeconds + 's</bdi>)</span></button>';
      if (r.state === 'recording') h += '<span class="rc-note"><i class="ti ti-point-filled" aria-hidden="true"></i>' + esc(T('جارٍ التسجيل…', 'Recording…')) + '</span>'
        + '<button type="button" class="rc-b pri" data-rc="stop"><i class="ti ti-player-stop" aria-hidden="true"></i>' + esc(T('إيقاف', 'Stop')) + '</button>'
        + '<button type="button" class="rc-b" data-rc="cancelRec"><i class="ti ti-x" aria-hidden="true"></i>' + esc(T('إلغاء', 'Cancel')) + '</button>';
      if (r.state === 'preview') h += '<audio controls src="' + esc(r.dataUrl) + '" aria-label="' + esc(T('معاينة التسجيل', 'Recording preview')) + '"></audio>'
        + '<span class="rc-sub" style="margin:0"><bdi dir="ltr">' + Math.round(r.durationMs / 1000) + 's · ' + kb(r.bytes) + '</bdi></span>'
        + '<button type="button" class="rc-b pri" data-rc="sendVoice"' + (s.busy ? ' disabled' : '') + '><i class="ti ti-send" aria-hidden="true"></i>' + esc(T('إرسال', 'Send')) + '</button>'
        + '<button type="button" class="rc-b" data-rc="rerecord"><i class="ti ti-refresh" aria-hidden="true"></i>' + esc(T('إعادة التسجيل', 'Re-record')) + '</button>'
        + '<button type="button" class="rc-b" data-rc="cancelRec"><i class="ti ti-x" aria-hidden="true"></i>' + esc(T('إلغاء', 'Cancel')) + '</button>';
      h += '</div>';
    }
    return h + '</div>';
  }

  /* on screen: in the document, laid out, inside the viewport, tab visible */
  function onScreen(el){
    if (document.visibilityState !== 'visible') return false;
    if (!el || !document.contains(el)) return false;
    var r = el.getBoundingClientRect();
    var vw = global.innerWidth || document.documentElement.clientWidth, vh = global.innerHeight || document.documentElement.clientHeight;
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
  }

  /* receipts run AFTER the host has revealed (or hidden) the widget through
     onRender — a host panel starts hidden, so deciding "on screen" before
     that would never mark anything read on the first render */
  function render(m){
    var out = draw(m);
    if (m.onRender) { try { m.onRender(m.el); } catch (e) {} }
    if (m.pendingReceipt) { var id = m.pendingReceipt; m.pendingReceipt = null; receipts(m, id); }
    return out;
  }
  function receipts(m, id){
    var C = A(); if (!C) return;
    C.markDelivered(id);
    if (onScreen(m.el)) C.markRead(id);
  }
  function draw(m){
    var el = m.el, id = m.orderId, s = stateOf(id), C = A();
    if (!el || !document.contains(el)) return false;
    if (!C) { el.innerHTML = ''; return true; }
    var focused = document.activeElement && el.contains(document.activeElement) ? document.activeElement.getAttribute('data-rc') : null;
    injectCss();
    var r = C.conversation(id);
    /* no conversation for this viewer, right now: show nothing at all */
    if (!r.ok) { el.innerHTML = ''; return true; }
    var conv = r.conversation, role = conv.role, calls = conv.calls || {};
    /* a host that already titles the panel mounts with { title:false } */
    var h = '<div class="rc"><div class="rc-h"><b>' + (m.title === false ? '' : esc(role === 'customer' ? T('التواصل مع السائق', 'Contact your driver') : T('التواصل مع العميل', 'Contact the customer'))) + '</b>'
      /* a host that already offers Call (through this same authority) mounts with { call:false } */
      + (m.call === false ? '' : '<button type="button" class="rc-b" data-rc="call"' + (calls.remaining === 0 ? ' disabled' : '') + '><i class="ti ti-phone" aria-hidden="true"></i>' + esc(T('اتصال', 'Call')) + '</button>') + '</div>';
    if (role === 'customer' && conv.currentDriver) h += '<p class="rc-sub">' + esc(T('السائق: ', 'Driver: ')) + '<b><bdi>' + esc(conv.currentDriver.name || '') + '</bdi></b></p>';
    if (typeof calls.remaining === 'number')
      h += '<p class="rc-sub" data-rc-calls>' + (calls.remaining > 0
        ? esc(T('محاولات الاتصال المتبقية: ', 'Call attempts left: ')) + '<bdi>' + calls.remaining + ' / ' + calls.limit + '</bdi>'
        : esc(T('وصلت إلى الحد الأقصى لمحاولات الاتصال. يمكنك متابعة المراسلة.', 'You have reached the maximum number of call attempts. You can still send messages.'))) + '</p>';
    if (s.callMsg) h += '<p class="rc-err" role="alert">' + esc(s.callMsg) + '</p>';
    h += '<div class="rc-thread" data-rc="thread">' + (r.messages.length ? r.messages.map(function (x) { return messageHTML(x, role); }).join('')
      : '<p class="rc-sub">' + esc(T('لا توجد رسائل بعد.', 'No messages yet.')) + '</p>') + '</div>';
    if (conv.canSend) h += composerHTML(id, s, conv);
    el.innerHTML = h + '</div>';
    var th = el.querySelector('[data-rc="thread"]'); if (th) th.scrollTop = th.scrollHeight;
    if (focused) { var f = el.querySelector('[data-rc="' + focused + '"]'); if (f) { f.focus(); if (f.setSelectionRange && f.value != null) try { f.setSelectionRange(f.value.length, f.value.length); } catch (e) {} } }
    /* the recipient's own page moves the status */
    var hasIncoming = r.messages.some(function (x) { return !x.mine && x.status.state !== 'read'; });
    if (hasIncoming) m.pendingReceipt = id;
    return true;
  }

  /* ---------- interactions ---------- */
  function mountOf(el){ return MOUNTS.filter(function (m) { return m.el === el; })[0]; }
  function rerender(orderId){
    MOUNTS = MOUNTS.filter(function (m) { return document.contains(m.el); });
    MOUNTS.forEach(function (m) { if (!orderId || m.orderId === orderId) render(m); });
  }
  function settle(m, promise, reset){
    var s = stateOf(m.orderId);
    Promise.resolve(promise).then(function (res) {
      s.busy = false;
      if (!res || !res.ok) { s.err = (res && res.message) || T('تعذّر الإرسال.', 'Could not send.'); render(m); return; }
      s.err = ''; reset(s); render(m);
    });
  }
  function readFiles(files){
    return Promise.all(Array.prototype.map.call(files, function (file) {
      return new Promise(function (res) {
        var fr = new FileReader();                          /* the original bytes, unchanged */
        fr.onload = function () { res({ dataUrl:String(fr.result), bytes:file.size }); };
        fr.onerror = function () { res(null); };
        fr.readAsDataURL(file);
      });
    }));
  }
  function stopTracks(r){ try { (r.stream && r.stream.getTracks ? r.stream.getTracks() : []).forEach(function (t) { t.stop(); }); } catch (e) {} }
  function startRecording(m){
    var s = stateOf(m.orderId), cv = A().conversation(m.orderId), lim = (cv.ok && cv.conversation.limits) || {};
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
  /* the dial link is opened, not shown */
  function dial(href){
    var a = document.createElement('a'); a.href = href; a.rel = 'noopener'; a.style.display = 'none';
    document.body.appendChild(a); try { a.click(); } catch (e) {} a.remove();
  }
  function onClick(e){
    var btn = e.target.closest && e.target.closest('[data-rc]'); if (!btn) return;
    var root = btn.closest('[data-rc-mount]'); var m = root && mountOf(root); if (!m) return;
    var s = stateOf(m.orderId), C = A(), act = btn.getAttribute('data-rc');
    if (act === 'translate') { if (global.RAFMessageTranslation) requestTranslation(m.orderId, btn.getAttribute('data-mid')); return; }
    if (act === 'hideTranslation') { TRS[btn.getAttribute('data-mid') + '|' + targetLang()] = { status:'idle' }; paintTranslation(btn.getAttribute('data-mid')); return; }
    if (act === 'call') {
      if (s.busy) return; s.busy = true; s.callMsg = null;
      Promise.resolve(C.call(m.orderId)).then(function (r) {
        s.busy = false;
        if (r && r.ok) dial(r.dialHref);
        else s.callMsg = (r && r.message) || T('تعذّر الاتصال.', 'The call could not be placed.');
        render(m);
      });
      return;
    }
    if (act === 'sendText') {
      if (s.busy) return; s.busy = true;
      settle(m, C.send(m.orderId, { type:'text', text:s.draft, clientId:s.textId }), function (x) { x.draft = ''; x.textId = newClientId(); });
      return;
    }
    if (act === 'unpick') { s.images.splice(+btn.getAttribute('data-i'), 1); s.imagesId = newClientId(); render(m); return; }
    if (act === 'sendImages') {
      if (s.busy) return; s.busy = true;
      settle(m, C.send(m.orderId, { type:'image', images:s.images.map(function (x) { return x.dataUrl; }), clientId:s.imagesId }), function (x) { x.images = []; x.imagesId = newClientId(); });
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
      settle(m, C.send(m.orderId, { type:'voice', voice:{ dataUrl:s.rec.dataUrl, durationMs:s.rec.durationMs }, clientId:s.voiceId }), function (x) { x.rec = { state:'idle' }; x.voiceId = newClientId(); });
    }
  }
  function onInput(e){
    var t = e.target; if (!t.getAttribute || t.getAttribute('data-rc') !== 'text') return;
    var root = t.closest('[data-rc-mount]'); var m = root && mountOf(root); if (!m) return;
    stateOf(m.orderId).draft = t.value;
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
    /* an event is a reason to re-read the authority, never a permission */
    if (global.RAFEventBus) ['communication.*', 'order.*'].forEach(function (p) {
      RAFEventBus.subscribe(p, function (ev) { rerender(ev && ev.entityId ? ev.entityId : null); });
    });
  }

  function mount(el, opts){
    if (!el || !opts || !opts.orderId) return;
    wire();
    el.setAttribute('data-rc-mount', '');
    MOUNTS = MOUNTS.filter(function (m) { return m.el !== el && document.contains(m.el); });
    var m = { el:el, orderId:String(opts.orderId), title:opts.title === false ? false : true, call:opts.call === false ? false : true,
              onRender:typeof opts.onRender === 'function' ? opts.onRender : null };
    MOUNTS.push(m);
    /* a conversation scrolled into view later is read then, not before */
    if (global.IntersectionObserver && !el.__rcIO) {
      el.__rcIO = new IntersectionObserver(function (entries) {
        if (!entries.some(function (e) { return e.isIntersecting; })) return;
        var mm = mountOf(el), C = A(); if (!mm || !C || document.visibilityState !== 'visible') return;
        var r = C.conversation(mm.orderId);
        if (r.ok && r.messages.some(function (x) { return !x.mine && x.status.state !== 'read'; })) C.markRead(mm.orderId);
      });
      el.__rcIO.observe(el);
    }
    render(m);
  }

  global.RAFCommUI = { mount:mount, refresh:rerender };
})(window);
