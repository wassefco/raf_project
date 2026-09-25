/* ============================================================================
 * RAF Marketplace — MESSAGE TRANSLATION AUTHORITY  (RAFMessageTranslation)
 * ----------------------------------------------------------------------------
 * The single authority for translating a Customer ↔ Driver TEXT message for
 * presentation. Translation is a READ: the original message stays the
 * canonical, immutable record and nothing about the conversation changes.
 *
 *   RAFMessageTranslation.translate(orderId, messageId, { targetLanguage })
 *     → Promise<{ ok, status, translatedText, sourceLanguage, targetLanguage, ... }>
 *
 * ORDER (every call)
 *   1. identity + access — RAFDriverCommunication.messageForView(): the same
 *      boundary as viewing the conversation (the order's customer and its
 *      CURRENT driver, only while the delivery is live; closed at Delivered).
 *      A refused caller gets the conversation's own refusal
 *      and learns nothing about the message, the language or the state.
 *   2. only text messages; empty text is never sent to a provider.
 *   3. a provider must be installed — otherwise NOT_CONFIGURED (no fake output).
 *   4. provider capability limits (e.g. maxChars) are respected — the text is
 *      never truncated or altered.
 *   5. same language as the target → SAME_LANGUAGE (no translation).
 *   6. translate; results are cached IN MEMORY per page for
 *      messageId + text hash + target + provider id/version; identical
 *      in-flight requests share one provider call.
 *
 * ZERO SIDE EFFECTS — no communication record, receipt, lifecycle entry,
 * audit, event or notification is written, and message status is not touched.
 * Nothing is persisted.
 *
 * PROVIDER — an adapter installed by integration code through setProvider():
 *   { id, version, capabilities:{ maxChars?, languages? },
 *     detectLanguage(text) → Promise<'xx'|null>   (optional),
 *     translate(text, targetLanguage) → Promise<{ translatedText, sourceLanguage? }> }
 * No provider (and no provider setting) is approved in RAF, so none is
 * installed and no RAFConfig key is invented: translation is NOT_CONFIGURED.
 * A real provider/backend is connected here later without touching the
 * communication system or the pages.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFMessageTranslation) return;

  var LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;          /* BCP-47 style code, e.g. "ar", "en", "en-GB" */

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    FIELD_NOT_ACCEPTED:  { ar:'تحتوي البيانات على حقول غير مقبولة.',      en:'The request contains fields that are not accepted.' },
    NOT_TRANSLATABLE:    { ar:'يمكن ترجمة الرسائل النصية فقط.',            en:'Only text messages can be translated.' },
    NOTHING_TO_TRANSLATE:{ ar:'لا يوجد نص للترجمة.',                       en:'There is no text to translate.' },
    TARGET_INVALID:      { ar:'لغة الترجمة غير صالحة.',                   en:'The translation language is not valid.' },
    NOT_CONFIGURED:      { ar:'الترجمة غير مُهيّأة بعد.',                   en:'Translation is not configured yet.' },
    LANGUAGE_UNSUPPORTED:{ ar:'لغة الترجمة غير مدعومة.',                  en:'That translation language is not supported.' },
    TOO_LONG:            { ar:'الرسالة أطول مما تدعمه خدمة الترجمة.',        en:'The message is longer than the translation service supports.' },
    SAME_LANGUAGE:       { ar:'الرسالة بلغتك المختارة بالفعل.',             en:'The message is already in the selected language.' },
    TRANSLATION_FAILED:  { ar:'الترجمة غير متاحة. حاول مرة أخرى.',          en:'Translation unavailable. Try again.' },
    SERVICE_UNAVAILABLE: { ar:'خدمة المحادثات غير محمّلة.',                en:'The conversation service is not loaded.' }
  };
  function result(status, extra){
    var m = ERRORS[status];
    var r = { ok:status === 'TRANSLATED', status:status, code:status === 'TRANSLATED' ? null : status,
              message:m ? T(m.ar, m.en) : null, translatedText:null, sourceLanguage:null, targetLanguage:null };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  function base(tag){ return String(tag || '').toLowerCase().split('-')[0]; }
  function hash(s){ var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + ':' + s.length; }

  /* ---------- provider seam ---------- */
  var provider = null;
  function setProvider(adapter){
    if (adapter === null) { provider = null; CACHE = {}; return { ok:true, installed:false }; }
    if (!adapter || typeof adapter.id !== 'string' || !adapter.id || typeof adapter.translate !== 'function'
        || (adapter.detectLanguage != null && typeof adapter.detectLanguage !== 'function')) return { ok:false, reason:'invalid_provider' };
    provider = adapter; CACHE = {}; INFLIGHT = {};
    return { ok:true, installed:true, id:adapter.id };
  }
  function providerStatus(){
    return provider ? { configured:true, id:provider.id, version:provider.version || null, capabilities:provider.capabilities || {} }
                    : { configured:false, id:null, version:null, capabilities:{} };
  }

  var CACHE = {}, INFLIGHT = {};
  function translate(orderId, messageId, opts){
    opts = opts || {};
    if (!onlyKeys(opts, ['targetLanguage'])) return Promise.resolve(result('FIELD_NOT_ACCEPTED'));
    var C = global.RAFDriverCommunication;
    if (!C || !C.messageForView) return Promise.resolve(result('SERVICE_UNAVAILABLE'));
    /* 1 — access, before anything else is looked at or returned */
    var v = C.messageForView(orderId, messageId);
    if (!v.ok) return Promise.resolve({ ok:false, status:v.code, code:v.code, message:v.message, translatedText:null, sourceLanguage:null, targetLanguage:null });
    var msg = v.message, target = opts.targetLanguage;
    if (typeof target !== 'string' || !LANG.test(target)) return Promise.resolve(result('TARGET_INVALID'));
    /* 2 */
    if (msg.type !== 'text') return Promise.resolve(result('NOT_TRANSLATABLE', { targetLanguage:target }));
    var text = typeof msg.text === 'string' ? msg.text : '';
    if (!text.trim()) return Promise.resolve(result('NOTHING_TO_TRANSLATE', { targetLanguage:target }));
    /* 3 */
    var p = provider;
    if (!p) return Promise.resolve(result('NOT_CONFIGURED', { targetLanguage:target }));
    var caps = p.capabilities || {};
    if (Array.isArray(caps.languages) && caps.languages.length && caps.languages.map(base).indexOf(base(target)) < 0)
      return Promise.resolve(result('LANGUAGE_UNSUPPORTED', { targetLanguage:target }));
    /* 4 */
    if (typeof caps.maxChars === 'number' && text.length > caps.maxChars)
      return Promise.resolve(result('TOO_LONG', { targetLanguage:target, maxChars:caps.maxChars }));
    /* 6 — cache / de-duplicate */
    var key = [msg.messageId, hash(text), base(target), p.id, p.version || ''].join('|');
    if (CACHE[key]) return Promise.resolve(Object.assign({}, CACHE[key], { cached:true }));
    if (INFLIGHT[key]) return INFLIGHT[key];
    var run = Promise.resolve()
      .then(function () { return typeof p.detectLanguage === 'function' ? p.detectLanguage(text) : null; })
      .then(function (detected) {
        /* 5 */
        if (detected && base(detected) === base(target)) return result('SAME_LANGUAGE', { sourceLanguage:base(detected), targetLanguage:target });
        return Promise.resolve(p.translate(text, target)).then(function (out) {
          var src = (out && out.sourceLanguage) || detected || null;
          if (src && base(src) === base(target)) return result('SAME_LANGUAGE', { sourceLanguage:base(src), targetLanguage:target });
          if (!out || typeof out.translatedText !== 'string' || !out.translatedText.trim()) return result('TRANSLATION_FAILED', { targetLanguage:target });
          return result('TRANSLATED', { translatedText:out.translatedText, sourceLanguage:src ? base(src) : null, targetLanguage:target, provider:p.id });
        });
      })
      .catch(function () { return result('TRANSLATION_FAILED', { targetLanguage:target }); })
      .then(function (r) {
        delete INFLIGHT[key];
        if (r.status === 'TRANSLATED' || r.status === 'SAME_LANGUAGE') CACHE[key] = r;   /* failures are retried */
        return r;
      });
    INFLIGHT[key] = run;
    return run;
  }

  global.RAFMessageTranslation = { ERRORS:ERRORS, translate:translate, setProvider:setProvider, providerStatus:providerStatus };
})(window);
