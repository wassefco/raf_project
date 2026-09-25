/* ============================================================================
 * RAF Marketplace — DRIVER COMMUNICATION AUTHORITY  (RAFDriverCommunication)
 * ----------------------------------------------------------------------------
 * The single authority for the Customer ↔ Driver conversation of a delivery:
 * who may take part, the messages (text / images / voice), their status
 * (sent → delivered → read), closure at Delivered, the call abstraction and
 * the call-attempt limit. Pages render; every rule lives here.
 *
 * REBUILT for the current architecture (the Phase H module was removed in
 * b6fc89e together with RAFDriver). The approved business rules are kept; the
 * plumbing is new:
 *   · OWNERSHIP IS NOT STORED HERE. The current driver is read, on every call,
 *     from the order's own record — RAFOrderSnapshot fulfilment.driverId —
 *     which RAFLogistics writes on claim, dispatch, return-to-pool and
 *     reassignment. Nothing here claims, assigns or moves a delivery.
 *   · NO LIFECYCLE STORE. The old module mirrored RAFDriver's ownership
 *     records into communication_events. Those records no longer exist, and
 *     claim / dispatch / return / delivery are already audited by the engine
 *     (driver.assigned, dispatch.assigned, dispatch.returned_to_pool,
 *     driver.delivered). A second record of the same facts is not kept.
 *
 * APPROVED RULES
 *   · One conversation per order ('conv|<orderId>'), derived — never accepted
 *     from a caller. Participants: the order's customer and the CURRENT driver.
 *   · It is available only while the order is in progress AND has a current
 *     driver. Before a driver owns it, and while it is back in the pool,
 *     there is no participant on the driver side and nobody can write.
 *   · Reassignment: the same conversation continues. The new driver reads the
 *     earlier messages (marked as earlier history) and writes new ones; the
 *     previous driver loses access at once, because access is re-derived from
 *     the order record on every call.
 *   · DELIVERED CLOSES IT FOR EVERYONE. Current decision: after delivery the
 *     customer sees NO previous conversation at all — no messages, composer,
 *     call or translation — and the driver has no access. The records stay
 *     stored (append-only); only access ends.
 *   · Messages are immutable: no edit, no delete. Status comes only from the
 *     recipient's own page (append-only receipts); nobody sets it by hand.
 *   · Call: a provider abstraction; today the DIRECT-NUMBER provider (the other
 *     participant's existing number as a device dial link). No phone number is
 *     stored or returned by any other operation, and no call record exists.
 *     Attempts are counted — only to enforce 'communication.callAttemptLimit'.
 *
 * ACCESS (identity from the session only)
 *   customer          the active customer who owns the order (snapshot customer.id)
 *   driver            the active driver who is the order's CURRENT driver
 *   everyone else     refused — merchant, merchant employee, Logistics,
 *                     management, finance, marketing, Customer Service,
 *                     anonymous. The Phase H read-only management history
 *                     was removed with the old module and no current access
 *                     model replaces it, so none is offered (fails closed).
 *
 * CALL-ATTEMPT SCOPE — one counter per conversation, per caller, per callee:
 * the customer's attempts to a given driver, and a given driver's attempts to
 * the customer. A new driver after reassignment is a different person and
 * starts at zero; the previous driver cannot call at all.
 *
 * SERIALIZATION — writes (send, receipts, call) run inside an exclusive Web
 * Lock per conversation, the pattern RAFCompensation and RAFLogistics.claim
 * use, so tabs of one browser never interleave a read-count-write. This is
 * NOT cross-device atomicity; production needs server-side conditional
 * writes (see RAFRecordStore's header).
 *
 * PROTOTYPE LIMITS — media lives in localStorage within the configured limits;
 * a full store refuses honestly with PERSIST_FAILED.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDriverCommunication) return;

  var TEXT_MAX = 2000;                                  /* technical guard, not a business rule */
  var IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  var VOICE_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
  var CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;
  var KB = 1024;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAUTHENTICATED:     { ar:'يلزم تسجيل الدخول.',                                       en:'Sign-in is required.' },
    FORBIDDEN:           { ar:'ليس لديك وصول إلى هذه المحادثة.',                           en:'You do not have access to this conversation.' },
    ACTOR_INACTIVE:      { ar:'حسابك غير نشط.',                                           en:'Your account is not active.' },
    FIELD_NOT_ACCEPTED:  { ar:'تحتوي البيانات على حقول غير مقبولة.',                       en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:     { ar:'الطلب غير موجود.',                                         en:'The order was not found.' },
    NOT_CURRENT_DRIVER:  { ar:'لم تعد مسؤولًا عن هذا التوصيل؛ المحادثة غير متاحة لك.',      en:'You are no longer responsible for this delivery; the conversation is not available to you.' },
    NO_ACTIVE_DRIVER:    { ar:'لا يوجد سائق مسؤول عن التوصيل حاليًا.',                      en:'No driver is currently responsible for this delivery.' },
    CONVERSATION_CLOSED: { ar:'انتهت المحادثة بتسليم الطلب.',                               en:'The conversation ended when the order was delivered.' },
    NOT_ACTIVE:          { ar:'المحادثة غير متاحة لهذا الطلب.',                            en:'The conversation is not available for this order.' },
    TYPE_INVALID:        { ar:'نوع الرسالة غير مدعوم.',                                    en:'That message type is not supported.' },
    TEXT_REQUIRED:       { ar:'اكتب نص الرسالة.',                                         en:'Write the message text.' },
    TEXT_TOO_LONG:       { ar:'الرسالة طويلة جدًا.',                                      en:'The message is too long.' },
    IMAGES_REQUIRED:     { ar:'اختر صورة واحدة على الأقل.',                                en:'Choose at least one image.' },
    TOO_MANY_IMAGES:     { ar:'عدد الصور أكبر من المسموح.',                                en:'Too many images.' },
    IMAGE_INVALID:       { ar:'صيغة الصورة غير مدعومة.',                                   en:'That image format is not supported.' },
    IMAGE_TOO_LARGE:     { ar:'حجم الصورة أكبر من المسموح.',                               en:'The image is larger than allowed.' },
    VOICE_INVALID:       { ar:'التسجيل الصوتي غير صالح.',                                  en:'The voice recording is not valid.' },
    VOICE_TOO_LARGE:     { ar:'التسجيل الصوتي أكبر من المسموح.',                           en:'The voice recording is larger than allowed.' },
    VOICE_TOO_LONG:      { ar:'التسجيل الصوتي أطول من المسموح.',                           en:'The voice recording is longer than allowed.' },
    NOT_CONFIGURED:      { ar:'هذه الخاصية غير مُهيّأة.',                                  en:'This capability is not configured.' },
    CLIENT_ID_REQUIRED:  { ar:'تعذّر إرسال الرسالة. حاول مرة أخرى.',                        en:'The message could not be sent. Try again.' },
    NO_PHONE:            { ar:'لا يوجد رقم هاتف مسجّل.',                                   en:'No phone number is recorded.' },
    CALL_LIMIT_REACHED:  { ar:'وصلت إلى الحد الأقصى لمحاولات الاتصال. يمكنك متابعة المراسلة.', en:'You have reached the maximum number of call attempts. You can still send messages.' },
    MESSAGE_NOT_FOUND:   { ar:'الرسالة غير موجودة في هذه المحادثة.',                       en:'That message is not in this conversation.' },
    PERSIST_FAILED:      { ar:'تعذّر الحفظ (قد تكون مساحة التخزين ممتلئة).',                en:'Could not save (storage may be full).' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' }, r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  function coll(n){ try { return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; } catch (e) { return null; } }
  function cfg(k){ try { return global.RAFConfig ? RAFConfig.value(k) : null; } catch (e) { return null; } }
  function me(){ try { return global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; } catch (e) { return null; } }
  function userOf(id){ try { return id && global.RAFPerm ? RAFPerm.getUser(id) : null; } catch (e) { return null; } }
  function convId(orderId){ return 'conv|' + orderId; }

  /* ---------- the delivery facts, read from the authorities that own them ---------- */
  function facts(orderId){
    if (typeof orderId !== 'string' || !orderId) return null;
    var o = null;
    try { o = global.RAFShop ? RAFShop.Orders.get(orderId) : null; } catch (e) { o = null; }
    if (!o) return null;
    var s = null;
    try { s = global.RAFOrderSnapshot ? RAFOrderSnapshot.of(orderId) : null; } catch (e) { s = null; }
    if (!s) return null;
    var f = s.fulfilment || {};
    var delivered = o.status === 'delivered' || !!f.deliveredAt;
    return { orderId:orderId, conversationId:convId(orderId), storeSlug:s.storeSlug || null,
             customerId:(s.customer && s.customer.id) || null, customerPhone:(s.customer && s.customer.phone) || null,
             driverId:f.driverId || null, delivered:delivered,
             active:o.status === 'progress' && !!f.driverId && !delivered };
  }

  /* ---------- who is asking ----------
     Identity from the session → ownership from the order record → only then
     state. A refused caller learns nothing about the conversation's state. */
  function authorise(ft){
    var u = me();
    if (!u || !u.id) return fail('UNAUTHENTICATED');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    if (u.roleId === 'customer') {
      if (!ft.customerId || ft.customerId !== u.id) return fail('FORBIDDEN');
      return { ok:true, role:'customer', id:u.id, name:u.name };
    }
    if (u.roleId === 'driver') {
      if (ft.driverId !== u.id) return fail('NOT_CURRENT_DRIVER');
      return { ok:true, role:'driver', id:u.id, name:u.name };
    }
    return fail('FORBIDDEN');
  }
  /* a participant of a LIVE conversation — the only kind that exists */
  function participant(orderId){
    var ft = facts(orderId); if (!ft) return fail('ORDER_NOT_FOUND');
    var a = authorise(ft); if (!a.ok) return a;
    if (ft.delivered) return fail('CONVERSATION_CLOSED');
    if (!ft.active) return fail(ft.driverId ? 'NOT_ACTIVE' : 'NO_ACTIVE_DRIVER');
    return { ok:true, role:a.role, id:a.id, name:a.name, ft:ft,
             counterpartId:a.role === 'customer' ? ft.driverId : ft.customerId };
  }

  /* ---------- limits, from RAFConfig ---------- */
  function limits(){
    var ik = cfg('communication.maxImageKB'), vk = cfg('communication.maxVoiceKB');
    return { maxTextLength:TEXT_MAX,
             maxImagesPerMessage:cfg('communication.maxImagesPerMessage'),
             maxImageBytes:typeof ik === 'number' ? ik * KB : null,
             maxVoiceBytes:typeof vk === 'number' ? vk * KB : null,
             maxVoiceSeconds:cfg('communication.maxVoiceSeconds'),
             callAttemptLimit:cfg('communication.callAttemptLimit') };
  }

  /* ---------- reads ---------- */
  function messagesOf(orderId){
    var c = coll('communication_messages');
    return (c ? c.filter(function (m) { return m.orderId === orderId; }) : [])
      .sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); });
  }
  function receiptsOf(orderId){ var c = coll('communication_receipts'); return c ? c.filter(function (r) { return r.orderId === orderId; }) : []; }
  function statusOf(msg, receipts){
    var mine = receipts.filter(function (r) { return r.messageId === msg.messageId && r.userId === msg.recipientId; });
    var read = mine.filter(function (r) { return r.type === 'read'; })[0], del = mine.filter(function (r) { return r.type === 'delivered'; })[0];
    return { state:read ? 'read' : (del ? 'delivered' : 'sent'), deliveredAt:del ? del.at : null, readAt:read ? read.at : null };
  }
  function attemptsOf(conversationId, callerId, calleeId){
    var c = coll('communication_call_attempts');
    return c ? c.filter(function (x) { return x.conversationId === conversationId && x.callerId === callerId && x.calleeId === calleeId; }).length : 0;
  }
  function callState(p){
    var lim = cfg('communication.callAttemptLimit');
    var used = attemptsOf(p.ft.conversationId, p.id, p.counterpartId);
    return { limit:typeof lim === 'number' ? lim : null, used:used,
             remaining:typeof lim === 'number' ? Math.max(0, lim - used) : null };
  }
  function thread(p){
    var receipts = receiptsOf(p.ft.orderId);
    return messagesOf(p.ft.orderId).map(function (m) {
      var out = { messageId:m.messageId, type:m.type, at:m.at, senderType:m.senderType,
                  mine:m.senderId === p.id,
                  /* for the current driver: messages from an earlier driver's time are read-only history */
                  earlierDriver:m.driverIdAtSend !== p.ft.driverId,
                  status:statusOf(m, receipts), text:m.text || null };
      var media = m.media || [];
      if (m.type === 'image') out.images = media.map(function (x) { return { mediaId:x.mediaId, mime:x.mime, bytes:x.bytes, dataUrl:x.dataUrl }; });
      if (m.type === 'voice') { var v = media[0]; out.voice = v ? { mediaId:v.mediaId, mime:v.mime, bytes:v.bytes, durationMs:v.durationMs, dataUrl:v.dataUrl } : { missing:true }; }
      return out;
    });
  }

  /* the participant's view. After Delivered it is refused like any other
     inaccessible conversation: no messages and no state beyond the refusal. */
  function conversation(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var p = participant(orderId); if (!p.ok) return p;
    var dn = p.role === 'customer' ? userOf(p.ft.driverId) : null;
    return { ok:true,
             conversation:{ conversationId:p.ft.conversationId, orderId:orderId, role:p.role, active:true,
                            currentDriver:dn ? { name:dn.name } : null,
                            canSend:true, canCall:true, limits:limits(), calls:callState(p) },
             messages:thread(p) };
  }
  /* ONE message for a participant, for presentation features (translation).
     Same boundary as conversation(); never writes anything. */
  function messageForView(orderId, messageId){
    var p = participant(orderId); if (!p.ok) return p;
    var c = coll('communication_messages');
    var m = c ? c.byId('messageId', messageId) : null;
    if (!m || m.orderId !== orderId) return fail('MESSAGE_NOT_FOUND');
    return { ok:true, viewer:p.role, message:{ messageId:m.messageId, orderId:m.orderId, type:m.type, text:m.text || null, at:m.at } };
  }

  /* ---------- serialization ---------- */
  function serialized(name, fn){
    var locks = null;
    try { locks = global.navigator && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null; } catch (e) { locks = null; }
    if (!locks) { try { return Promise.resolve(fn()); } catch (e) { return Promise.resolve(fail('PERSIST_FAILED')); } }
    return locks.request('raf-communication:' + name, { mode:'exclusive' }, function () {
      try { return fn(); } catch (e) { return fail('PERSIST_FAILED'); }
    }).catch(function () { return fail('PERSIST_FAILED'); });
  }
  function publish(type, p, payload){
    if (!global.RAFEventBus) return;
    try { RAFEventBus.publish(type, { entityId:p.ft.orderId, source:p.role, storeSlug:p.ft.storeSlug, payload:payload }); } catch (e) {}
  }

  /* ---------- sending ---------- */
  function parseData(u){
    var m = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;codecs=[^;,]+)?;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(typeof u === 'string' ? u : '');
    if (!m) return null;
    var b64 = m[2], pad = b64.slice(-2) === '==' ? 2 : (b64.slice(-1) === '=' ? 1 : 0);
    return { mime:m[1].toLowerCase(), bytes:Math.floor(b64.length * 3 / 4) - pad };
  }
  /* validation is pure: it reads nothing but the payload and the limits */
  function validate(data, lim){
    var text = null, media = [];
    if (data.type === 'text') {
      if (!onlyKeys(data, ['type', 'text', 'clientId'])) return fail('FIELD_NOT_ACCEPTED');
      if (typeof data.text !== 'string') return fail('TEXT_REQUIRED');
      text = data.text.trim();
      if (!text) return fail('TEXT_REQUIRED');
      if (text.length > TEXT_MAX) return fail('TEXT_TOO_LONG', { max:TEXT_MAX });
    } else if (data.type === 'image') {
      if (!onlyKeys(data, ['type', 'images', 'clientId'])) return fail('FIELD_NOT_ACCEPTED');
      if (typeof lim.maxImagesPerMessage !== 'number' || typeof lim.maxImageBytes !== 'number') return fail('NOT_CONFIGURED');
      if (!Array.isArray(data.images) || !data.images.length) return fail('IMAGES_REQUIRED');
      if (data.images.length > lim.maxImagesPerMessage) return fail('TOO_MANY_IMAGES', { max:lim.maxImagesPerMessage });
      for (var i = 0; i < data.images.length; i++) {
        var im = parseData(data.images[i]);
        if (!im || IMAGE_MIME.indexOf(im.mime) < 0) return fail('IMAGE_INVALID', { index:i });
        if (im.bytes > lim.maxImageBytes) return fail('IMAGE_TOO_LARGE', { index:i, max:lim.maxImageBytes });
        media.push({ kind:'image', mime:im.mime, bytes:im.bytes, dataUrl:data.images[i] });      /* the original, unchanged */
      }
    } else if (data.type === 'voice') {
      if (!onlyKeys(data, ['type', 'voice', 'clientId'])) return fail('FIELD_NOT_ACCEPTED');
      if (typeof lim.maxVoiceBytes !== 'number' || typeof lim.maxVoiceSeconds !== 'number') return fail('NOT_CONFIGURED');
      var v = data.voice;
      if (!v || typeof v !== 'object' || !onlyKeys(v, ['dataUrl', 'durationMs'])) return fail('VOICE_INVALID');
      var au = parseData(v.dataUrl);
      if (!au || VOICE_MIME.indexOf(au.mime) < 0 || typeof v.durationMs !== 'number' || !(v.durationMs > 0)) return fail('VOICE_INVALID');
      if (au.bytes > lim.maxVoiceBytes) return fail('VOICE_TOO_LARGE', { max:lim.maxVoiceBytes });
      if (v.durationMs > lim.maxVoiceSeconds * 1000) return fail('VOICE_TOO_LONG', { max:lim.maxVoiceSeconds });
      media.push({ kind:'voice', mime:au.mime, bytes:au.bytes, dataUrl:v.dataUrl, durationMs:Math.round(v.durationMs) });
    } else return fail('TYPE_INVALID');
    return { ok:true, text:text, media:media };
  }
  /* send(orderId, { type, text | images | voice, clientId }) → Promise.
     Sender, recipient, conversation and status are never accepted: they are
     derived. clientId makes a repeated send (double tap, retry) the same
     message rather than a second one. */
  function send(orderId, data){
    data = data || {};
    if (typeof data !== 'object' || !onlyKeys(data, ['type', 'text', 'images', 'voice', 'clientId'])) return Promise.resolve(fail('FIELD_NOT_ACCEPTED'));
    if (typeof data.clientId !== 'string' || !CLIENT_ID.test(data.clientId)) return Promise.resolve(fail('CLIENT_ID_REQUIRED'));
    var p0 = participant(orderId); if (!p0.ok) return Promise.resolve(p0);
    var v = validate(data, limits()); if (!v.ok) return Promise.resolve(v);
    return serialized(p0.ft.conversationId, function () {
      /* re-read everything inside the lock: ownership or delivery may have moved */
      var p = participant(orderId); if (!p.ok) return p;
      if (p.id !== p0.id) return fail('FORBIDDEN');
      var c = coll('communication_messages'); if (!c) return fail('PERSIST_FAILED');
      var messageId = 'msg|' + orderId + '|' + p.id + '|' + data.clientId;
      if (c.byId('messageId', messageId)) return { ok:true, duplicate:true, messageId:messageId };
      var rec = { messageId:messageId, conversationId:p.ft.conversationId, orderId:orderId,
                  senderId:p.id, senderType:p.role, recipientId:p.counterpartId,
                  recipientType:p.role === 'customer' ? 'driver' : 'customer',
                  /* who the current driver was at send time — immutable metadata, never used for access */
                  driverIdAtSend:p.ft.driverId, type:data.type, text:v.text,
                  media:v.media.map(function (x, j) { return Object.assign({ mediaId:messageId + '|m' + j }, x); }),
                  at:Date.now(), version:1 };
      /* ONE append: the message and its original media in one record */
      var a = c.append('messageId', rec);
      if (!a.ok) return fail('PERSIST_FAILED');
      if (a.duplicate) return { ok:true, duplicate:true, messageId:messageId };
      notify(rec);
      publish('communication.message.sent', p, { messageId:messageId });
      return { ok:true, messageId:messageId };
    });
  }
  /* exactly one notification per stored message, to the other participant only */
  function notify(rec){
    if (!global.RAFNotify || !RAFNotify.create || !rec.recipientId) return;
    var toCustomer = rec.recipientType === 'customer';
    var type = toCustomer ? 'communication.message.customer' : 'communication.message.driver';
    var def = (RAFNotify.EVENT_TYPES || {})[type] || {};
    var kind = rec.type === 'image' ? { ar:'صورة', en:'Image' } : (rec.type === 'voice' ? { ar:'رسالة صوتية', en:'Voice message' } : { ar:'رسالة', en:'Message' });
    try { RAFNotify.create({ recipientUserId:rec.recipientId, eventType:type, title:def.title,
            message:{ ar:kind.ar + ' — الطلب ' + rec.orderId, en:kind.en + ' — order ' + rec.orderId },
            entityType:'order', entityId:rec.orderId,
            href:toCustomer ? 'raf_tracking.html?id=' + encodeURIComponent(rec.orderId) : 'raf_driver.html',
            source:rec.senderType, dedupeKey:type + '|' + rec.messageId }); } catch (e) {}
  }

  /* ---------- status: only the recipient's own page moves it ----------
     Receipts are for messages addressed to the caller, with deterministic ids,
     so a repeated mark adds nothing. Read implies delivered. */
  function receipt(orderId, kind, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return Promise.resolve(fail('FIELD_NOT_ACCEPTED'));
    var p0 = participant(orderId); if (!p0.ok) return Promise.resolve(p0);
    return serialized(p0.ft.conversationId, function () {
      var p = participant(orderId); if (!p.ok) return p;
      var c = coll('communication_receipts'); if (!c) return fail('PERSIST_FAILED');
      var have = {}; receiptsOf(orderId).forEach(function (r) { have[r.receiptId] = true; });
      var now = Date.now(), added = [];
      messagesOf(orderId).filter(function (m) { return m.recipientId === p.id; }).forEach(function (m) {
        (kind === 'read' ? ['delivered', 'read'] : ['delivered']).forEach(function (t) {
          var id = 'rcp|' + m.messageId + '|' + t + '|' + p.id;
          if (have[id]) return;
          var a = c.append('receiptId', { receiptId:id, messageId:m.messageId, orderId:orderId, type:t, userId:p.id, at:now, version:1 });
          if (a.ok && !a.duplicate) { added.push({ messageId:m.messageId, type:t }); have[id] = true; }
        });
      });
      /* one event per kind per call, not one per receipt */
      if (added.some(function (x) { return x.type === 'delivered'; })) publish('communication.message.delivered', p, { count:added.filter(function (x) { return x.type === 'delivered'; }).length });
      if (added.some(function (x) { return x.type === 'read'; })) publish('communication.message.read', p, { count:added.filter(function (x) { return x.type === 'read'; }).length });
      return { ok:true, added:added.length };
    });
  }

  /* ---------- call abstraction ----------
     UI → call() → PROVIDER. Today's only provider is the direct-number one:
     the other participant's EXISTING number — the current driver's account
     phone, or the customer's delivery phone on the order record — as a dial
     link. It is resolved only here, only for a live participant, only after
     the attempt limit allowed it. A masked provider replaces this object
     later without changing callers. */
  var PROVIDER = {
    id:'direct_number', masked:false,
    resolve:function (p){
      var phone = null;
      if (p.role === 'customer') { var du = userOf(p.ft.driverId); phone = du ? du.phone : null; }
      else phone = p.ft.customerPhone;
      if (!phone) return null;
      return 'tel:' + String(phone).replace(/[^\d+]/g, '');
    }
  };
  function call(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return Promise.resolve(fail('FIELD_NOT_ACCEPTED'));
    var p0 = participant(orderId); if (!p0.ok) return Promise.resolve(p0);
    return serialized(p0.ft.conversationId + '|call|' + p0.id, function () {
      var p = participant(orderId); if (!p.ok) return p;
      if (p.id !== p0.id) return fail('FORBIDDEN');
      var lim = cfg('communication.callAttemptLimit');
      if (typeof lim !== 'number' || lim < 1) return fail('NOT_CONFIGURED');
      var used = attemptsOf(p.ft.conversationId, p.id, p.counterpartId);
      if (used >= lim) return fail('CALL_LIMIT_REACHED', { calls:{ limit:lim, used:used, remaining:0 } });
      var href = PROVIDER.resolve(p);
      if (!href) return fail('NO_PHONE');
      /* the attempt is counted BEFORE the dial link is handed out, so an
         uncounted call cannot happen; nothing about the number is stored */
      var c = coll('communication_call_attempts'); if (!c) return fail('PERSIST_FAILED');
      var a = c.append('attemptId', { attemptId:RAFRecordStore.makeId('cat'), conversationId:p.ft.conversationId, orderId:orderId,
                                      callerId:p.id, callerRole:p.role, calleeId:p.counterpartId, at:Date.now(), version:1 });
      if (!a.ok) return fail('PERSIST_FAILED');
      return { ok:true, provider:PROVIDER.id, masked:false, dialHref:href,
               calls:{ limit:lim, used:used + 1, remaining:Math.max(0, lim - used - 1) } };
    });
  }

  global.RAFDriverCommunication = {
    ERRORS:ERRORS, conversation:conversation, messageForView:messageForView, send:send,
    markDelivered:function (id, o) { return receipt(id, 'delivered', o); },
    markRead:function (id, o) { return receipt(id, 'read', o); },
    call:call,
    callProvider:function () { return { id:PROVIDER.id, masked:PROVIDER.masked }; }
  };
})(window);
