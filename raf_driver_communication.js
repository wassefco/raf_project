/* ============================================================================
 * RAF Marketplace — DRIVER COMMUNICATION AUTHORITY  (shared, headless) — Phase H
 * ----------------------------------------------------------------------------
 * The single authority for the Customer ↔ Driver conversation of a delivery:
 * lifecycle, participants, messages (text / images / voice), message status
 * (sent / delivered / read), closure at Delivered, historical access and the
 * call abstraction. Pages render; every rule lives here.
 *
 * NOT A SOURCE OF TRUTH FOR DELIVERY. Who owns the delivery is read from the
 * order snapshot (RAFDriver's fulfilment owner) and from RAFDriver's
 * append-only ownership records; whether the order is delivered is read from
 * the order (RAFOrderEngine). The conversation reacts to those facts.
 *
 * APPROVED RULES
 *   · One conversation per order ('conv|<orderId>'), Customer ↔ the CURRENT
 *     driver only. Logistics / Support are never live participants.
 *   · Available as soon as a driver OWNS the delivery (claim or dispatch) —
 *     pickup is not required.
 *   · Reassignment: the new owner becomes the participant immediately and sees
 *     the earlier messages read-only; the previous driver loses access
 *     immediately. The same conversation continues; nothing is restarted.
 *   · Delivered closes it immediately: no message, media or call after that.
 *     The history is kept permanently (append-only, never edited or deleted).
 *   · Text, images (several per message, RAFConfig limit) and voice messages;
 *     originals are stored exactly as sent (no re-encoding, no editing).
 *   · Status Sent → Delivered → Read comes only from the recipient's own client
 *     (append-only receipts); nobody can set a status by hand.
 *   · Call: an abstraction with one provider today — the DIRECT-NUMBER FALLBACK
 *     (the other participant's existing phone number + a device dial link).
 *     Not masked, no telephony, and no call record is stored. A real/masked
 *     provider replaces `CALL_PROVIDER` without touching the conversation.
 *
 * LIFECYCLE RECORDS (append-only 'communication_events'), derived from the
 * authoritative ownership records with deterministic ids so any number of tabs
 * reconciling at once record each transition once:
 *   opened            first owner of the delivery        (per ownership record)
 *   driver_transferred reassignment from → to            (per ownership record)
 *   driver_released   returned to pool (no participant)  (per ownership record)
 *   driver_assigned   a new owner after a release        (per ownership record)
 *   closed            the order reached Delivered        (once per order)
 * Message sent / delivered / read are the 'communication_messages' and
 * 'communication_receipts' records.
 *
 * ACCESS (identity from the session only; caller identity fields refused)
 *   customer   the active customer who owns the order snapshot — live while the
 *              conversation is active; read-only history once it is closed
 *   driver     the active driver who is the CURRENT owner, while active
 *   management existing `drivers.suspend` (Operations Manager, Higher
 *              Management, Super Admin) — read-only history
 *   support    read-only history ONLY with an associated support complaint.
 *              RAF has no customer-support complaint record yet, so this path
 *              fails closed (SUPPORT_COMPLAINT_REQUIRED) — see complaintFor().
 *   merchant / merchant employee / finance / anonymous — refused.
 *
 * STORAGE — a message and its original media (data URLs) are ONE record in
 * 'communication_messages', written by a single append, so a failed write
 * leaves neither. Lifecycle: 'communication_events'; status: 'communication_receipts'.
 *
 * PROTOTYPE LIMITS — media lives in localStorage (small, configurable limits; a
 * full store refuses honestly with PERSIST_FAILED). Not transactional across
 * collections, no server push, no server authorisation, no durable media storage.
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFDriverCommunication) return;

  var PERM_MANAGE = 'drivers.suspend';
  var LIMITS = { text:2000 };                           /* technical guard, not a business rule */
  var IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  var VOICE_MIME = ['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav'];
  var CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    FORBIDDEN:                 { ar:'ليس لديك صلاحية على هذه المحادثة.',                 en:'You do not have access to this conversation.' },
    ACTOR_INACTIVE:            { ar:'حسابك غير نشط.',                                    en:'Your account is not active.' },
    FIELD_NOT_ACCEPTED:        { ar:'تحتوي البيانات على حقول غير مقبولة.',               en:'The request contains fields that are not accepted.' },
    ORDER_NOT_FOUND:           { ar:'الطلب غير موجود.',                                  en:'The order was not found.' },
    NOT_CURRENT_DRIVER:        { ar:'لم تعد مسؤولاً عن هذا التوصيل؛ المحادثة غير متاحة لك.', en:'You are no longer responsible for this delivery; the conversation is not available to you.' },
    NO_CONVERSATION:           { ar:'لا توجد محادثة لهذا الطلب بعد.',                    en:'There is no conversation for this order yet.' },
    NO_ACTIVE_DRIVER:          { ar:'لا يوجد سائق مسؤول عن التوصيل حاليًا.',              en:'No driver is currently responsible for this delivery.' },
    CONVERSATION_CLOSED:       { ar:'أُغلقت المحادثة بتسليم الطلب.',                      en:'The conversation closed when the order was delivered.' },
    NOT_ACTIVE:                { ar:'المحادثة غير نشطة.',                                en:'The conversation is not active.' },
    TYPE_INVALID:              { ar:'نوع الرسالة غير مدعوم.',                            en:'That message type is not supported.' },
    TEXT_REQUIRED:             { ar:'اكتب نص الرسالة.',                                  en:'Write the message text.' },
    TEXT_TOO_LONG:             { ar:'الرسالة طويلة جدًا.',                               en:'The message is too long.' },
    IMAGES_REQUIRED:           { ar:'اختر صورة واحدة على الأقل.',                         en:'Choose at least one image.' },
    TOO_MANY_IMAGES:           { ar:'عدد الصور أكبر من المسموح.',                         en:'Too many images.' },
    IMAGE_INVALID:             { ar:'صيغة الصورة غير مدعومة.',                            en:'That image format is not supported.' },
    IMAGE_TOO_LARGE:           { ar:'حجم الصورة أكبر من المسموح.',                        en:'The image is larger than allowed.' },
    VOICE_INVALID:             { ar:'التسجيل الصوتي غير صالح.',                           en:'The voice recording is not valid.' },
    VOICE_TOO_LARGE:           { ar:'التسجيل الصوتي أكبر من المسموح.',                    en:'The voice recording is larger than allowed.' },
    VOICE_TOO_LONG:            { ar:'التسجيل الصوتي أطول من المسموح.',                    en:'The voice recording is longer than allowed.' },
    NOT_CONFIGURED:            { ar:'حدود الوسائط غير مُهيّأة.',                          en:'Media limits are not configured.' },
    CLIENT_ID_REQUIRED:        { ar:'معرّف الإرسال مفقود.',                               en:'The send id is missing.' },
    NO_PHONE:                  { ar:'لا يوجد رقم هاتف مسجّل.',                            en:'No phone number is recorded.' },
    MESSAGE_NOT_FOUND:         { ar:'الرسالة غير موجودة في هذه المحادثة.',                en:'That message is not in this conversation.' },
    SUPPORT_COMPLAINT_REQUIRED:{ ar:'يحتاج الدعم إلى شكوى مرتبطة بهذا الطلب للاطلاع على المحادثة.', en:'Support needs a complaint associated with this order to view the conversation.' },
    PERSIST_FAILED:            { ar:'تعذّر حفظ الرسالة (قد تكون مساحة التخزين ممتلئة).',  en:'The message could not be saved (storage may be full).' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' }, r = { ok:false, code:code, message:T(m.ar, m.en) };
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }
  function onlyKeys(o, allowed){ return Object.keys(o || {}).every(function (k) { return allowed.indexOf(k) > -1; }); }
  function coll(n){ return global.RAFRecordStore ? RAFRecordStore.collection(n) : null; }
  function cfg(k){ return global.RAFConfig ? RAFConfig.value(k) : null; }
  function me(){ try { return global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null; } catch (e) { return null; } }
  function userOf(id){ try { return id && global.RAFPerm ? RAFPerm.getUser(id) : null; } catch (e) { return null; } }
  function orderOf(orderId){
    try { return (global.RAFShop ? RAFShop.Orders.all() : []).filter(function (o) { return o && o.id === orderId; })[0] || null; } catch (e) { return null; }
  }
  function convId(orderId){ return 'conv|' + orderId; }

  /* ---------- the delivery facts, read from their authorities ---------- */
  function stateOf(o){
    var s = o.snapshot || {}, f = s.fulfilment || {};
    var delivered = o.status === 'delivered' || !!f.deliveredAt;
    return { orderId:o.id, conversationId:convId(o.id), storeSlug:s.storeSlug || null,
             customerId:(s.customer && s.customer.id) || null, driverId:f.driverId || null,
             delivered:delivered, cancelled:o.status === 'cancelled',
             active:o.status === 'progress' && !!f.driverId && !delivered };
  }

  /* ---------- lifecycle, reconciled from RAFDriver's ownership records ---------- */
  function eventsOf(orderId){
    var c = coll('communication_events'); if (!c) return [];
    return c.filter(function (e) { return e.orderId === orderId; }).sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); });
  }
  function lifecycle(o, rec){
    var c = coll('communication_events'); if (!c) return;
    var a = c.append('eventId', rec);
    if (!a.ok || a.duplicate) return;                    /* recorded already (another tab / earlier read) */
    if (global.RAFAudit) {
      try { RAFAudit.record({ action:'communication.' + rec.type, orderId:rec.orderId, storeSlug:rec.storeSlug, systemGenerated:true, source:'automation',
              key:rec.eventId, metadata:{ conversationId:rec.conversationId, fromDriverId:rec.fromDriverId || null, toDriverId:rec.toDriverId || null,
              ownershipRecordId:rec.ownershipRecordId || null } }); } catch (e) {}
    }
    if (global.RAFEventBus) RAFEventBus.publish('communication.conversation.' + rec.type, { entityId:rec.orderId, system:true,
      storeSlug:rec.storeSlug, payload:{ conversationId:rec.conversationId } });
  }
  function sync(o){
    if (!o || !o.snapshot) return null;
    var st = stateOf(o), own = coll('ownership');
    var recs = own ? own.filter(function (r) { return r.orderId === o.id; }).sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); }) : [];
    var opened = false, participant = null;
    recs.forEach(function (r) {
      var base = { eventId:'cev|' + o.id + '|' + r.recordId, conversationId:st.conversationId, orderId:o.id, storeSlug:st.storeSlug,
                   at:r.at, ownershipRecordId:r.recordId, version:1 };
      if (r.kind === 'claim' || r.kind === 'dispatch') {
        lifecycle(o, Object.assign(base, { type:opened ? 'driver_assigned' : 'opened', fromDriverId:null, toDriverId:r.toDriverId }));
        opened = true; participant = r.toDriverId;
      } else if (r.kind === 'reassignment' && opened) {
        lifecycle(o, Object.assign(base, { type:'driver_transferred', fromDriverId:r.fromDriverId, toDriverId:r.toDriverId }));
        participant = r.toDriverId;
      } else if (r.kind === 'returned_to_pool' && opened) {
        lifecycle(o, Object.assign(base, { type:'driver_released', fromDriverId:r.fromDriverId, toDriverId:null }));
        participant = null;
      }
    });
    if (opened && st.delivered) {
      var f = o.snapshot.fulfilment || {};
      lifecycle(o, { eventId:'cev|' + o.id + '|closed', type:'closed', conversationId:st.conversationId, orderId:o.id, storeSlug:st.storeSlug,
                     at:f.deliveredAt || Date.now(), fromDriverId:f.driverId || participant, toDriverId:null, reason:'delivered', version:1 });
    }
    st.opened = opened;
    return st;
  }

  /* ---------- who is asking ----------
     ORDER: session identity → authorisation from a pure read of the delivery
     facts → only then any state disclosure (delivered / closed) and any
     reconciliation write. A refused caller learns nothing about the
     conversation's state and causes no communication write. */
  function authorise(o){
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var facts = stateOf(o);                                    /* read-only */
    if (u.roleId === 'customer') {
      if (!facts.customerId || facts.customerId !== u.id) return fail('FORBIDDEN');
      return { ok:true, role:'customer', id:u.id, name:u.name };
    }
    var d = global.RAFDriver && RAFDriver.scope ? RAFDriver.scope() : null;
    if (d && d.ok) {
      /* ownership first: a driver who is not the current owner never learns
         whether the delivery is closed */
      if (facts.driverId !== d.id) return fail('NOT_CURRENT_DRIVER');
      return { ok:true, role:'driver', id:d.id, name:d.name };
    }
    return fail('FORBIDDEN');
  }
  function participant(o, needActive){
    var a = authorise(o); if (!a.ok) return a;
    var st = sync(o);                                          /* authorised: reconciliation may write */
    if (a.role === 'customer') {
      if (!st.opened) return fail('NO_CONVERSATION');
      if (needActive) {
        if (st.delivered) return fail('CONVERSATION_CLOSED');
        if (!st.active) return fail(st.driverId ? 'NOT_ACTIVE' : 'NO_ACTIVE_DRIVER');
      }
      return { ok:true, role:'customer', id:a.id, name:a.name, st:st, counterpartId:st.driverId };
    }
    if (st.delivered) return fail('CONVERSATION_CLOSED');         /* the owner keeps no access after Delivered */
    if (!st.active) return fail('NOT_ACTIVE');
    return { ok:true, role:'driver', id:a.id, name:a.name, st:st, counterpartId:st.customerId };
  }
  function isManager(u){ try { return !!(u && u.status === 'active' && RAFPerm.can(u.id, PERM_MANAGE)); } catch (e) { return false; } }
  /* The support-complaint association. RAF has no customer-support complaint
     record today (Customer Issues belong to the store; Merchant Support is
     merchant ↔ RAF Management), so no complaint can be proven and support
     access fails closed. When a complaint authority exists, this is the one
     place that asks it. */
  function complaintFor(/* orderId, supportUserId */){ return null; }

  /* ---------- reads ---------- */
  function receiptsOf(orderId){ var c = coll('communication_receipts'); return c ? c.filter(function (r) { return r.orderId === orderId; }) : []; }
  function statusOf(msg, receipts){
    var mine = receipts.filter(function (r) { return r.messageId === msg.messageId && r.userId === msg.recipientId; });
    var read = mine.filter(function (r) { return r.type === 'read'; })[0], del = mine.filter(function (r) { return r.type === 'delivered'; })[0];
    return { state:read ? 'read' : (del ? 'delivered' : 'sent'), deliveredAt:del ? del.at : (read ? read.at : null), readAt:read ? read.at : null };
  }
  function nameOf(id){ var u = userOf(id); return u ? u.name : null; }
  function thread(o, viewer){
    var st = viewer.st, receipts = receiptsOf(o.id), c = coll('communication_messages');
    var msgs = (c ? c.filter(function (m) { return m.orderId === o.id; }) : []).sort(function (a, b) { return (a.at - b.at) || ((a.seq || 0) - (b.seq || 0)); });
    return msgs.map(function (m) {
      var out = { messageId:m.messageId, type:m.type, at:m.at, senderType:m.senderType,
                  senderName:m.senderType === 'driver' ? nameOf(m.senderId) : null,
                  mine:viewer.id === m.senderId,
                  /* for the current driver: messages exchanged with an earlier driver are history */
                  previousDriver:m.driverIdAtSend !== st.driverId,
                  status:statusOf(m, receipts), text:m.text || null };
      var media = m.media || [];
      if (m.type === 'image') out.images = media.map(function (x) { return { mediaId:x.mediaId, mime:x.mime, bytes:x.bytes, dataUrl:x.dataUrl }; });
      if (m.type === 'voice') { var v = media[0]; out.voice = v ? { mediaId:v.mediaId, mime:v.mime, bytes:v.bytes, durationMs:v.durationMs, dataUrl:v.dataUrl } : { missing:true }; }
      if (viewer.admin) { out.senderId = m.senderId; out.recipientId = m.recipientId; out.driverIdAtSend = m.driverIdAtSend; }
      return out;
    });
  }
  function header(st, viewer){
    return { orderId:st.orderId, conversationId:st.conversationId, active:st.active, closed:st.delivered,
             currentDriver:st.driverId ? { name:nameOf(st.driverId) } : null, role:viewer.role };
  }

  /* a participant's view (customer: active or closed history; driver: current owner, active) */
  function conversation(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var p = participant(o, false); if (!p.ok) return p;
    var lim = limits();
    return { ok:true, conversation:Object.assign(header(p.st, p), { canSend:p.st.active, canCall:p.st.active, limits:lim }),
             messages:thread(o, p) };
  }

  /* administrative, read-only */
  function history(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    /* authorise before reading the order or reconciling anything */
    var access = null;
    if (isManager(u)) access = 'management';
    else if (u.roleId === 'customer_service') { if (!complaintFor(orderId, u.id)) return fail('SUPPORT_COMPLAINT_REQUIRED'); access = 'support'; }
    else return fail('FORBIDDEN');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var st = sync(o); if (!st.opened) return fail('NO_CONVERSATION');
    var viewer = { id:u.id, role:access, st:st, admin:true };
    return { ok:true, readOnly:true, access:access,
             conversation:Object.assign(header(st, viewer), { canSend:false, canCall:false }),
             lifecycle:eventsOf(orderId).map(function (e) { return { type:e.type, at:e.at, from:e.fromDriverId ? nameOf(e.fromDriverId) : null, to:e.toDriverId ? nameOf(e.toDriverId) : null }; }),
             messages:thread(o, viewer) };
  }
  /* ONE message, for a caller entitled to see it — the same access boundary as
     conversation() (customer owner, current owner driver while undelivered)
     and history() (management; support only with a complaint). Authorisation
     comes first; it reads facts only and never reconciles, receipts, audits,
     publishes or notifies. Used by presentation features that act on a single
     message (e.g. RAFMessageTranslation); it returns nothing about state
     before access is granted. */
  function messageForView(orderId, messageId){
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    var viewer;
    if (isManager(u)) viewer = 'management';
    else if (u.roleId === 'customer_service') { if (!complaintFor(orderId, u.id)) return fail('SUPPORT_COMPLAINT_REQUIRED'); viewer = 'support'; }
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    if (!viewer) {
      var a = authorise(o); if (!a.ok) return a;               /* ownership before any state */
      var facts = stateOf(o);
      if (a.role === 'driver') {
        if (facts.delivered) return fail('CONVERSATION_CLOSED');
        if (!facts.active) return fail('NOT_ACTIVE');
      }
      viewer = a.role;
    }
    var c = coll('communication_messages');
    var m = c ? c.byId('messageId', messageId) : null;
    if (!m || m.orderId !== orderId) return fail('MESSAGE_NOT_FOUND');
    return { ok:true, viewer:viewer, message:{ messageId:m.messageId, orderId:m.orderId, type:m.type, text:m.text || null, at:m.at } };
  }
  function list(opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var u = me(); if (!u) return fail('FORBIDDEN');
    if (u.status !== 'active') return fail('ACTOR_INACTIVE');
    if (!isManager(u)) return fail(u.roleId === 'customer_service' ? 'SUPPORT_COMPLAINT_REQUIRED' : 'FORBIDDEN');
    var ids = {}; (coll('communication_events') ? coll('communication_events').all() : []).forEach(function (e) { ids[e.orderId] = true; });
    var msgs = coll('communication_messages') ? coll('communication_messages').all() : [];
    return { ok:true, conversations:Object.keys(ids).map(function (id) {
      var o = orderOf(id); var st = o ? stateOf(o) : null;
      var mine = msgs.filter(function (m) { return m.orderId === id; });
      return { orderId:id, active:!!(st && st.active), closed:!!(st && st.delivered), currentDriver:st && st.driverId ? nameOf(st.driverId) : null,
               messages:mine.length, lastAt:mine.length ? mine[mine.length - 1].at : null };
    }).sort(function (a, b) { return (b.lastAt || 0) - (a.lastAt || 0); }) };
  }

  /* ---------- sending ---------- */
  function limits(){
    return { maxImagesPerMessage:cfg('communication.maxImagesPerMessage'), maxImageBytes:cfg('communication.maxImageBytes'),
             maxVoiceBytes:cfg('communication.maxVoiceBytes'), maxVoiceSeconds:cfg('communication.maxVoiceSeconds'), maxTextLength:LIMITS.text };
  }
  function parseData(u){
    var m = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;codecs=[^;,]+)?;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(typeof u === 'string' ? u : '');
    if (!m) return null;
    var b64 = m[2], pad = b64.slice(-2) === '==' ? 2 : (b64.slice(-1) === '=' ? 1 : 0);
    return { mime:m[1].toLowerCase(), bytes:Math.floor(b64.length * 3 / 4) - pad };
  }
  function send(orderId, data){
    data = data || {};
    if (!onlyKeys(data, ['type', 'text', 'images', 'voice', 'clientId'])) return fail('FIELD_NOT_ACCEPTED');
    if (typeof data.clientId !== 'string' || !CLIENT_ID.test(data.clientId)) return fail('CLIENT_ID_REQUIRED');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var p = participant(o, true); if (!p.ok) return p;
    var lim = limits(), now = Date.now(), messageId = 'msg|' + orderId + '|' + p.id + '|' + data.clientId;
    var existing = coll('communication_messages').byId('messageId', messageId);
    if (existing) return { ok:true, duplicate:true, messageId:messageId };          /* the same send, repeated */
    var text = null, media = [];
    if (data.type === 'text') {
      if (!onlyKeys(data, ['type', 'text', 'clientId'])) return fail('FIELD_NOT_ACCEPTED');
      text = typeof data.text === 'string' ? data.text.trim() : '';
      if (!text) return fail('TEXT_REQUIRED');
      if (text.length > LIMITS.text) return fail('TEXT_TOO_LONG');
    } else if (data.type === 'image') {
      if (!onlyKeys(data, ['type', 'images', 'clientId'])) return fail('FIELD_NOT_ACCEPTED');
      if (typeof lim.maxImagesPerMessage !== 'number' || typeof lim.maxImageBytes !== 'number') return fail('NOT_CONFIGURED');
      if (!Array.isArray(data.images) || !data.images.length) return fail('IMAGES_REQUIRED');
      if (data.images.length > lim.maxImagesPerMessage) return fail('TOO_MANY_IMAGES', { max:lim.maxImagesPerMessage });
      for (var i = 0; i < data.images.length; i++) {
        var im = parseData(data.images[i]);
        if (!im || IMAGE_MIME.indexOf(im.mime) < 0) return fail('IMAGE_INVALID', { index:i });
        if (im.bytes > lim.maxImageBytes) return fail('IMAGE_TOO_LARGE', { index:i, max:lim.maxImageBytes });
        media.push({ kind:'image', mime:im.mime, bytes:im.bytes, dataUrl:data.images[i] });
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

    /* re-read the delivery facts right before writing (ownership or delivery may have moved) */
    var fresh = orderOf(orderId), again = fresh ? participant(fresh, true) : fail('ORDER_NOT_FOUND');
    if (!again.ok) return again;
    /* ONE append: the message and its original media travel in a single record,
       so the store either keeps the whole message or nothing (one localStorage
       write). No second collection can be left holding an orphan, and nothing
       append-only ever has to be rolled back. */
    var st = again.st;
    var rec = { messageId:messageId, conversationId:st.conversationId, orderId:orderId, storeSlug:st.storeSlug,
                senderId:p.id, senderType:p.role, recipientId:again.counterpartId, recipientType:p.role === 'customer' ? 'driver' : 'customer',
                driverIdAtSend:st.driverId, type:data.type, text:text,
                media:media.map(function (x, j) { return Object.assign({ mediaId:messageId + '|m' + j }, x); }), at:now, version:1 };
    var a = coll('communication_messages').append('messageId', rec);
    if (!a.ok) return fail('PERSIST_FAILED');
    if (a.duplicate) return { ok:true, duplicate:true, messageId:messageId };
    if (global.RAFAudit) {
      try { RAFAudit.record({ action:'communication.message', orderId:orderId, storeSlug:st.storeSlug, actor:{ id:p.id }, source:p.role === 'driver' ? 'driver' : 'customer',
              key:messageId, metadata:{ messageId:messageId, conversationId:st.conversationId, type:rec.type, senderType:rec.senderType,
              recipientType:rec.recipientType, mediaCount:rec.media.length } }); } catch (e) {}
    }
    notify(rec);
    if (global.RAFEventBus) RAFEventBus.publish('communication.message.sent', { entityId:orderId, source:p.role === 'driver' ? 'driver' : 'customer',
      storeSlug:st.storeSlug, payload:{ messageId:messageId } });
    return { ok:true, messageId:messageId };
  }
  function notify(rec){
    if (!global.RAFNotify || !RAFNotify.create || !rec.recipientId) return;
    var toCustomer = rec.recipientType === 'customer';
    var type = toCustomer ? 'communication.message.customer' : 'communication.message.driver';
    var def = (RAFNotify.EVENT_TYPES || {})[type] || {};
    var kind = rec.type === 'image' ? { ar:'صورة', en:'Image' } : (rec.type === 'voice' ? { ar:'رسالة صوتية', en:'Voice message' } : { ar:'رسالة', en:'Message' });
    try { RAFNotify.create({ recipientUserId:rec.recipientId, eventType:type, title:def.title,
            message:{ ar:kind.ar + ' — الطلب ' + rec.orderId, en:kind.en + ' — order ' + rec.orderId },
            entityType:'order', entityId:rec.orderId, href:toCustomer ? 'raf_tracking.html?id=' + encodeURIComponent(rec.orderId) : 'raf_driver.html',
            source:rec.senderType === 'driver' ? 'driver' : 'customer', dedupeKey:type + '|' + rec.messageId }); } catch (e) {}
  }

  /* ---------- status: only the recipient's own client moves it ---------- */
  function receipt(orderId, kind, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var p = participant(o, true); if (!p.ok) return p;
    var c = coll('communication_receipts'), msgs = coll('communication_messages').filter(function (m) { return m.orderId === orderId && m.recipientId === p.id; });
    var have = {}; receiptsOf(orderId).forEach(function (r) { have[r.receiptId] = true; });
    var now = Date.now(), added = [];
    msgs.forEach(function (m) {
      var types = kind === 'read' ? ['delivered', 'read'] : ['delivered'];
      types.forEach(function (t) {
        var id = 'rcp|' + m.messageId + '|' + t + '|' + p.id;
        if (have[id]) return;
        var a = c.append('receiptId', { receiptId:id, messageId:m.messageId, orderId:orderId, type:t, userId:p.id, at:now, version:1 });
        if (a.ok && !a.duplicate) { added.push({ messageId:m.messageId, type:t }); have[id] = true; }
      });
    });
    added.forEach(function (x) {
      if (global.RAFEventBus) RAFEventBus.publish('communication.message.' + x.type, { entityId:orderId, source:p.role === 'driver' ? 'driver' : 'customer',
        storeSlug:p.st.storeSlug, payload:{ messageId:x.messageId } });
    });
    return { ok:true, added:added.length };
  }

  /* ---------- call abstraction ----------
     UI → call() → CALL_PROVIDER. Today's only provider is the direct-number
     fallback: it resolves the other participant's EXISTING number (the
     driver's account phone; the customer's delivery phone on the order
     snapshot) and returns a device dial link. Nothing is recorded — no call
     is claimed to have happened. A masked/telephony provider replaces this
     object later; callers do not change. */
  var CALL_PROVIDER = {
    id:'direct_number_fallback', masked:false,
    resolve:function (p, o){
      var name, phone;
      if (p.role === 'customer') { var du = userOf(p.st.driverId); name = du ? du.name : null; phone = du ? du.phone : null; }
      else { var c = (o.snapshot && o.snapshot.customer) || {}; name = c.name || null; phone = c.phone || null; }
      if (!phone) return fail('NO_PHONE');
      return { ok:true, provider:this.id, masked:false, target:{ role:p.role === 'customer' ? 'driver' : 'customer', name:name, phone:phone },
               dialHref:'tel:' + String(phone).replace(/[^\d+]/g, '') };
    }
  };
  function call(orderId, opts){
    if (opts !== undefined && !onlyKeys(opts, [])) return fail('FIELD_NOT_ACCEPTED');
    var o = orderOf(orderId); if (!o || !o.snapshot) return fail('ORDER_NOT_FOUND');
    var p = participant(o, true); if (!p.ok) return p;
    return CALL_PROVIDER.resolve(p, o);
  }

  /* ---------- react to the authorities' own events (no polling) ---------- */
  if (global.RAFEventBus) {
    ['ownership.*', 'logistics.delivery.*', 'order.changed', 'order.snapshot.updated'].forEach(function (pat) {
      RAFEventBus.subscribe(pat, function (ev) {
        if (!ev || !ev.entityId) return;
        var o = orderOf(ev.entityId); if (!o || !o.snapshot) return;
        /* only a session entitled to this conversation reconciles it; any other
           tab (a former driver, a merchant, anonymous) writes nothing — the
           next authorised read records the same deterministic history */
        try {
          var u = me();
          if (authorise(o).ok || isManager(u)) sync(o);
        } catch (e) {}
      });
    });
  }

  global.RAFDriverCommunication = {
    ERRORS:ERRORS, conversation:conversation, send:send, markDelivered:function (id, o) { return receipt(id, 'delivered', o); },
    markRead:function (id, o) { return receipt(id, 'read', o); }, call:call, history:history, list:list, messageForView:messageForView,
    callProvider:function () { return { id:CALL_PROVIDER.id, masked:CALL_PROVIDER.masked }; }
  };
})(window);
