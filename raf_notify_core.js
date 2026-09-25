/* ==========================================================================
 * RAF — NOTIFICATION AUTHORITY  (RAFNotify — data layer)
 * --------------------------------------------------------------------------
 * The ONE notification authority. Producers call create(); every surface
 * reads through forRecipient(). No page stores notification state of its own.
 * The header bell (raf_notify.js) is a consumer of this layer, not a second
 * engine; both live on the same RAFNotify object.
 *
 * MODEL (version 1) — one record per recipient:
 *   { notificationId, recipientUserId, timestamp, eventType, title{ar,en},
 *     message{ar,en}|null, entityType, entityId, href, source, metadata,
 *     dedupeKey, version }
 *
 *   · READ STATE IS PER RECIPIENT and is never written onto the record: a
 *     read is an append-only receipt { receiptId, notificationId,
 *     recipientUserId, at }. Reading a notification can never mark it read
 *     for anybody else.
 *   · There is NO severity hierarchy.
 *   · eventType is registered below; only events that actually happen in
 *     RAF today are registered. Future logistics notification types are
 *     added by the phases that implement those events — none is fabricated.
 *   · SOUND is per account and affects sound only: a notification with sound
 *     off is still created and still listed. Merchant accounts keep their
 *     existing alert preferences in RAFMerchantPrefs (delegated, not copied).
 *
 * IDENTITY — every read and every read-receipt is scoped to the signed-in
 * account resolved here; no caller can pass a recipient to read or mark
 * somebody else's notifications. Recipients of create() are resolved by the
 * PRODUCING authority from authoritative records (the order snapshot's
 * customer, the store's own accounts) — never from page input.
 *
 * LEGACY BRIDGE (read-only) — records written before this authority existed
 * are still shown to their rightful recipient and are never rewritten:
 *   · 'raf_notif_extra'      customer order notifications (recipient =
 *                            the record's customerId); legacy global read ids
 *                            'raf_notif_read' seed their initial read state;
 *   · 'raf_merchant_notifs'  the old store inbox, shown to the accounts of the
 *                            store that owns each order (snapshot.storeSlug);
 *                            its old shared read flag seeds initial state.
 * Nothing writes those keys any more. Per-recipient receipts override them.
 *
 * STORAGE — RAFRecordStore collections 'notifications' and
 * 'notification_reads' (append-only) and state map 'notification_prefs'.
 * Prototype localStorage only; not production-safe for concurrency.
 * ==========================================================================*/
(function (global) {
  'use strict';
  var N = global.RAFNotify = global.RAFNotify || {};
  if (N.__core) return;

  var VERSION = 1;
  var LEGACY_CUSTOMER = 'raf_notif_extra';
  var LEGACY_CUSTOMER_READ = 'raf_notif_read';
  var LEGACY_MERCHANT = 'raf_merchant_notifs';

  /* the registered notification types — only events RAF performs today */
  var TYPES = {
    /* customer, produced by RAFOrderEngine / RAFOrderChanges */
    'order.accepted':                    { audience:'customer' },
    'order.cancelled':                   { audience:'customer' },
    'order.delivered':                   { audience:'customer' },
    /* the driver reached the drop-off (RAFOrderEngine.driverArrived) */
    'order.driver_arrived':              { audience:'customer' },
    'order.change':                      { audience:'customer' },
    /* merchant store accounts — titles are the workspace's existing wording */
    'merchant.order.new':                { audience:'merchant', legacyType:'new',
                                           title:{ ar:'طلب جديد', en:'New order' } },
    'merchant.order.acceptance_warning': { audience:'merchant', legacyType:'timeout',
                                           title:{ ar:'تحذير: قارب وقت القبول على الانتهاء', en:'Acceptance window almost over' } },
    'merchant.change.approved':          { audience:'merchant', legacyType:'change_approved',
                                           title:{ ar:'وافق العميل على التعديل', en:'Customer approved the change' } },
    'merchant.change.rejected':          { audience:'merchant', legacyType:'change_rejected',
                                           title:{ ar:'رفض العميل التعديل', en:'Customer declined the change' } },
    'merchant.change.failed':            { audience:'merchant', legacyType:'change_failed',
                                           title:{ ar:'تعذّر تطبيق التعديل', en:'The change could not be applied' } },
    /* Phase I — a delay compensation coupon was issued (RAFCompensation) */
    'compensation.issued':               { audience:'customer', title:{ ar:'حصلت على قسيمة تعويض', en:'You received a compensation coupon' } },
    /* Customer Service (RAFCustomerService). The 'support' audience is the
       responsible department's own employees; nothing internal is ever sent to
       a customer, and no notification carries an internal note's text. */
    'support.ticket.created':            { audience:'support', title:{ ar:'تذكرة جديدة لقسمك', en:'New ticket for your department' } },
    'support.ticket.claimed':            { audience:'support', title:{ ar:'تم استلام تذكرة', en:'A ticket was claimed' } },
    'support.ticket.transferred':        { audience:'support', title:{ ar:'تم تحويل تذكرة إلى قسمك', en:'A ticket was transferred to your department' } },
    'support.ticket.escalated':          { audience:'support', title:{ ar:'تصعيد تذكرة — يتطلب انتباه الإدارة', en:'Ticket escalated — requires management attention' } },
    'support.ticket.reopened':           { audience:'support', title:{ ar:'أُعيد فتح تذكرة', en:'A ticket was reopened' } },
    'support.followup.created':          { audience:'support', title:{ ar:'أُسندت إليك متابعة', en:'A follow-up was assigned to you' } },
    'support.followup.due':              { audience:'support', title:{ ar:'حان موعد متابعة', en:'A follow-up is due' } },
    /* the two the CUSTOMER sees — outcome and reply only */
    'support.ticket.message':            { audience:'customer', title:{ ar:'رد جديد على تذكرة الدعم', en:'New reply on your support ticket' } },
    'support.ticket.resolved':           { audience:'customer', title:{ ar:'تم حل تذكرة الدعم', en:'Your support ticket was resolved' } },
    /* Customer ↔ Driver communication (RAFDriverCommunication): one per stored
       message, to the other participant only */
    'communication.message.customer':    { audience:'customer', title:{ ar:'رسالة جديدة من السائق', en:'New message from your driver' } },
    'communication.message.driver':      { audience:'driver',   title:{ ar:'رسالة جديدة من العميل', en:'New message from the customer' } }
  };
  var LEGACY_MERCHANT_TYPE = {
    'new':'merchant.order.new', 'timeout':'merchant.order.acceptance_warning',
    'change_approved':'merchant.change.approved', 'change_rejected':'merchant.change.rejected',
    'change_failed':'merchant.change.failed'
  };
  var SOURCES = ['customer', 'merchant', 'driver', 'admin', 'system', 'automation'];

  function isEn(){ var r = document.getElementById('htmlRoot') || document.documentElement; return r.lang === 'en'; }
  function T(ar, en){ return isEn() ? en : ar; }
  var ERRORS = {
    UNAUTHENTICATED:   { ar:'يجب تسجيل الدخول.',                  en:'You need to be signed in.' },
    NOT_FOUND:         { ar:'الإشعار غير موجود.',                 en:'That notification does not exist.' },
    NOT_RECIPIENT:     { ar:'هذا الإشعار ليس لك.',                en:'That notification is not yours.' },
    UNKNOWN_TYPE:      { ar:'نوع الإشعار غير معروف.',             en:'Unknown notification type.' },
    RECIPIENT_INVALID: { ar:'مستلم الإشعار غير صالح.',            en:'The notification recipient is not valid.' },
    FIELDS_REQUIRED:   { ar:'بيانات الإشعار غير مكتملة.',         en:'The notification is incomplete.' },
    USE_MERCHANT_PREFS:{ ar:'تنبيهات التاجر الصوتية تُدار من إعدادات التاجر.', en:'Merchant alert sounds are managed in the merchant settings.' },
    PERSIST_FAILED:    { ar:'تعذّر حفظ الإشعار.',                 en:'The notification could not be saved.' }
  };
  function fail(code, extra){
    var m = ERRORS[code] || { ar:'', en:'' };
    return Object.assign({ ok:false, code:code, message:T(m.ar, m.en) }, extra || {});
  }

  function coll(name){ return global.RAFRecordStore ? RAFRecordStore.collection(name) : null; }
  function prefs(){ return global.RAFRecordStore ? RAFRecordStore.stateMap('notification_prefs') : null; }

  /* ---------- who is asking ----------
     RAFPerm's signed-in account when RAFPerm is loaded; on storefront pages
     that load it lazily, the stored session id (the prototype session). */
  function me(){
    try {
      if (global.RAFPerm && RAFPerm.currentUser) {
        var u = RAFPerm.currentUser();
        return u && u.id ? { id:u.id, roleId:u.roleId || null, status:u.status || null, verified:true } : null;
      }
      /* the session is tab-scoped (RAFPerm keeps it in sessionStorage) */
      var raw = sessionStorage.getItem('raf_current_user');
      if (!raw) return null;
      var id = null; try { id = JSON.parse(raw); } catch (e) { id = raw; }
      return typeof id === 'string' && id ? { id:id, roleId:null, status:null, verified:false } : null;
    } catch (e) { return null; }
  }
  function isMerchantRole(r){ return r === 'merchant' || r === 'merchant_employee'; }

  /* ---------- produce ---------- */
  function create(n){
    n = n || {};
    if (!TYPES[n.eventType]) return fail('UNKNOWN_TYPE', { eventType:n.eventType });
    if (!n.recipientUserId || typeof n.recipientUserId !== 'string') return fail('RECIPIENT_INVALID');
    if (global.RAFPerm && RAFPerm.getUser) {
      var ru = null; try { ru = RAFPerm.getUser(n.recipientUserId); } catch (e) { ru = null; }
      if (!ru) return fail('RECIPIENT_INVALID');
    }
    if (!n.title || typeof n.title !== 'object') return fail('FIELDS_REQUIRED');
    var c = coll('notifications'); if (!c) return fail('PERSIST_FAILED');
    if (n.dedupeKey) {
      var dup = c.filter(function (r) { return r.recipientUserId === n.recipientUserId && r.dedupeKey === n.dedupeKey; })[0];
      if (dup) return { ok:true, duplicate:true, notification:dup };
    }
    var rec = {
      notificationId:  RAFRecordStore.makeId('ntf'),
      recipientUserId: n.recipientUserId,
      timestamp:       Date.now(),
      eventType:       n.eventType,
      title:           { ar:String(n.title.ar || n.title.en || ''), en:String(n.title.en || n.title.ar || '') },
      message:         n.message && typeof n.message === 'object' ? { ar:String(n.message.ar || ''), en:String(n.message.en || '') } : null,
      entityType:      n.entityType || null,
      entityId:        n.entityId != null ? String(n.entityId) : null,
      href:            n.href || null,
      source:          SOURCES.indexOf(n.source) > -1 ? n.source : 'system',
      metadata:        n.metadata && typeof n.metadata === 'object' ? n.metadata : null,
      dedupeKey:       n.dedupeKey || null,
      version:         VERSION
    };
    var r = c.append('notificationId', rec);
    if (!r.ok) return fail('PERSIST_FAILED', { reason:r.reason });
    if (global.RAFEventBus) RAFEventBus.publish('notification.created', { entityId:rec.notificationId, source:rec.source,
      payload:{ recipientUserId:rec.recipientUserId, eventType:rec.eventType } });
    return { ok:true, notification:r.record };
  }

  /* ---------- store recipients ----------
     The accounts that work for the store that owns an order: resolved from the
     order's immutable snapshot (storeSlug) and RAFPerm's store link by account
     id — never from a store slug or recipient list a caller supplies. Only
     active merchant and merchant-employee accounts are recipients. */
  function storeRecipients(orderId){
    if (!global.RAFOrderSnapshot || !global.RAFPerm) return [];
    var slug = null; try { slug = RAFOrderSnapshot.storeSlugOf(orderId); } catch (e) { slug = null; }
    if (!slug) return [];
    var users = []; try { users = RAFPerm.getUsers() || []; } catch (e) { users = []; }
    return users.filter(function (u) {
      if (!u || u.status !== 'active' || !isMerchantRole(u.roleId)) return false;
      var s = null; try { s = RAFPerm.storeSlugOf(u.id); } catch (e) { s = null; }
      return s === slug;
    }).map(function (u) { return u.id; });
  }
  /* one notification per store account, de-duplicated per recipient by
     (eventType, orderId) — the rule the old shared inbox applied */
  function notifyStore(eventType, orderId, opts){
    opts = opts || {};
    var def = TYPES[eventType];
    if (!def || def.audience !== 'merchant') return fail('UNKNOWN_TYPE', { eventType:eventType });
    var ids = storeRecipients(orderId);
    var created = 0, existing = 0;
    ids.forEach(function (rid) {
      var r = create({ recipientUserId:rid, eventType:eventType, title:def.title, entityType:'order', entityId:orderId,
                       source:opts.source || 'system', metadata:{ legacyType:def.legacyType }, dedupeKey:eventType + '|' + orderId });
      if (r.ok && r.duplicate) existing++; else if (r.ok) created++;
    });
    return { ok:true, recipients:ids.length, created:created, existing:existing };
  }

  /* ---------- legacy (read-only) ---------- */
  function readJSON(key, dflt){ try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? dflt : v; } catch (e) { return dflt; } }
  function legacyFor(u){
    var out = [];
    var cust = readJSON(LEGACY_CUSTOMER, []);
    var custRead = readJSON(LEGACY_CUSTOMER_READ, []);
    (Array.isArray(cust) ? cust : []).forEach(function (x) {
      if (!x || !x.id || !x.t || x.customerId !== u.id) return;
      out.push({ notificationId:x.id, recipientUserId:u.id, timestamp:x.ts || 0, eventType:'order.change',
        title:{ ar:String(x.t.ar || ''), en:String(x.t.en || '') }, message:null, entityType:'order',
        entityId:x.orderId || null, href:x.href || null, source:'system', metadata:null, dedupeKey:null,
        version:0, legacy:true, legacyRead:Array.isArray(custRead) && custRead.indexOf(x.id) > -1 });
    });
    /* the old store inbox belongs to the accounts of the store that owns each order */
    if (isMerchantRole(u.roleId) && global.RAFPerm && global.RAFOrderSnapshot) {
      var slug = null; try { slug = RAFPerm.storeSlugOf(u.id); } catch (e) { slug = null; }
      if (slug) {
        (readJSON(LEGACY_MERCHANT, []) || []).forEach(function (x) {
          if (!x || !x.id || !x.orderId) return;
          var s = null; try { s = RAFOrderSnapshot.storeSlugOf(x.orderId); } catch (e) { s = null; }
          if (s !== slug) return;
          out.push({ notificationId:x.id, recipientUserId:u.id, timestamp:x.ts || 0,
            eventType:LEGACY_MERCHANT_TYPE[x.type] || 'merchant.order.new', title:{ ar:'', en:'' }, message:null,
            entityType:'order', entityId:x.orderId, href:null, source:'system', metadata:{ legacyType:x.type },
            dedupeKey:null, version:0, legacy:true, legacyRead:!!x.read });
        });
      }
    }
    return out;
  }

  /* ---------- read (always the signed-in recipient) ---------- */
  function receiptsFor(uid){
    var c = coll('notification_reads');
    var set = {};
    if (c) c.filter(function (r) { return r.recipientUserId === uid; }).forEach(function (r) { set[r.notificationId] = r.at; });
    return set;
  }
  function forRecipient(opts){
    opts = opts || {};
    var u = me(); if (!u) return [];
    var c = coll('notifications');
    var own = c ? c.filter(function (r) { return r.recipientUserId === u.id; }) : [];
    var reads = receiptsFor(u.id);
    var list = own.concat(legacyFor(u)).map(function (r) {
      var out = Object.assign({}, r);
      out.read = !!reads[r.notificationId] || !!r.legacyRead;
      out.readAt = reads[r.notificationId] || null;
      delete out.legacyRead;
      return out;
    });
    if (opts.entityType) list = list.filter(function (r) { return r.entityType === opts.entityType; });
    if (opts.audience) list = list.filter(function (r) { return (TYPES[r.eventType] || {}).audience === opts.audience; });
    return list.sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
  }
  function unreadCount(opts){ return forRecipient(opts).filter(function (r) { return !r.read; }).length; }

  function markRead(notificationId){
    var u = me(); if (!u) return fail('UNAUTHENTICATED');
    var mine = forRecipient().filter(function (r) { return r.notificationId === notificationId; })[0];
    if (!mine) {
      var c = coll('notifications');
      var exists = c && c.byId('notificationId', notificationId);
      return fail(exists ? 'NOT_RECIPIENT' : 'NOT_FOUND');
    }
    if (mine.read) return { ok:true, already:true };
    var rc = coll('notification_reads'); if (!rc) return fail('PERSIST_FAILED');
    var r = rc.append('receiptId', { receiptId:u.id + '|' + notificationId, notificationId:notificationId,
                                     recipientUserId:u.id, at:Date.now() });
    if (!r.ok) return fail('PERSIST_FAILED');
    if (global.RAFEventBus) RAFEventBus.publish('notification.read', { entityId:notificationId, payload:{ recipientUserId:u.id } });
    return { ok:true };
  }
  function markAllRead(opts){
    var u = me(); if (!u) return fail('UNAUTHENTICATED');
    var n = 0;
    forRecipient(opts).forEach(function (r) { if (!r.read && markRead(r.notificationId).ok) n++; });
    return { ok:true, marked:n };
  }

  /* ---------- sound (per account; sound only) ---------- */
  function soundPreference(kind){
    var u = me(); if (!u) return { ok:false, code:'UNAUTHENTICATED' };
    if (isMerchantRole(u.roleId) && global.RAFMerchantPrefs && RAFMerchantPrefs.soundEnabled) {
      var on = null; try { on = RAFMerchantPrefs.soundEnabled(kind || 'newOrder'); } catch (e) { on = null; }
      return { ok:true, configured:on !== null, enabled:on, via:'RAFMerchantPrefs' };
    }
    var p = prefs(); var rec = p ? p.get(u.id) : null;
    if (rec && typeof rec.sound === 'boolean') return { ok:true, configured:true, enabled:rec.sound, via:'RAFNotify' };
    var dflt = global.RAFConfig ? RAFConfig.value('notifications.soundDefault') : null;
    return { ok:true, configured:dflt !== null, enabled:dflt, via:dflt !== null ? 'RAFConfig' : null };
  }
  function setSoundPreference(enabled){
    var u = me(); if (!u) return fail('UNAUTHENTICATED');
    if (isMerchantRole(u.roleId)) return fail('USE_MERCHANT_PREFS');
    if (typeof enabled !== 'boolean') return fail('FIELDS_REQUIRED');
    var p = prefs(); if (!p || !p.set(u.id, { sound:enabled, at:Date.now() })) return fail('PERSIST_FAILED');
    if (global.RAFEventBus) RAFEventBus.publish('notification.preference.changed', { entityId:u.id, payload:{ sound:enabled } });
    return { ok:true, enabled:enabled };
  }

  Object.assign(N, {
    __core:true, VERSION:VERSION, EVENT_TYPES:TYPES, ERRORS:ERRORS,
    create:create, notifyStore:notifyStore, forRecipient:forRecipient, unreadCount:unreadCount,
    markRead:markRead, markAllRead:markAllRead,
    soundPreference:soundPreference, setSoundPreference:setSoundPreference
  });
})(window);
