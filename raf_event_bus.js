/* ==========================================================================
 * RAF — LIVE EVENT BUS  (RAFEventBus)
 * --------------------------------------------------------------------------
 * The one live-propagation contract for RAF. It carries NEWS about changes
 * that an authority has already made; it is never a source of truth and never
 * stores state. A subscriber that needs data asks the owning authority.
 *
 * ENVELOPE (every event, version 1):
 *   { eventId, eventType, domain, version, timestamp,
 *     actor:{ type, id, name, roleId }, source,
 *     entityType, entityId, storeSlug, payload, remote }
 *
 *   · eventType is REGISTERED below — an unknown type is refused, so names
 *     stay deterministic and cannot drift page by page;
 *   · actor is resolved HERE from the signed-in session (RAFPerm), never from
 *     anything the publisher passes; an authority marks an automatic event
 *     with { system:true } and the actor becomes { type:'system' };
 *   · payload carries ids and small facts, never private records.
 *
 * DELIVERY
 *   · same tab: synchronous delivery to matching subscribers ('order.changed',
 *     'order.*' or '*'), each in its own try/catch so one bad subscriber can
 *     never break another or the publisher;
 *   · other tabs: the event is written to a single TRANSIENT channel key and
 *     delivered there by the browser's storage event — no polling, no timer;
 *   · every event is delivered at most once per tab (eventId de-duplication).
 *
 * BRIDGES — existing authorities keep their DOM events unchanged
 * ('raf:order', 'raf:snapshot', 'raf:audit'); this bus republishes them as
 * 'order.changed', 'order.snapshot.updated' and 'audit.appended'. Existing
 * listeners continue to work exactly as before.
 *
 * PROTOTYPE LIMIT — storage events reach other tabs of the same browser only.
 * Cross-device live updates require a server push channel (see
 * raf_foundations.md).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFEventBus) return;

  var VERSION = 1;
  var CHANNEL = 'raf_event_bus';            /* transient channel, not a store */

  var DOMAINS = ['order', 'notification', 'audit', 'config', 'compensation', 'support', 'communication'];

  /* the registered event types — the only names that can be published */
  var TYPES = {
    /* order (bridged from existing authorities) */
    'order.changed':                 { domain:'order',        entityType:'order' },
    'order.snapshot.updated':        { domain:'order',        entityType:'order' },
    /* audit (bridged) */
    'audit.appended':                { domain:'audit',        entityType:'audit_event' },
    /* Phase I — delay compensation (RAFCompensation); payloads carry ids only */
    'compensation.issued':           { domain:'compensation', entityType:'order' },
    'compensation.added_to_wallet':  { domain:'compensation', entityType:'order' },
    'compensation.voided':           { domain:'compensation', entityType:'order' },
    'compensation.reversed':         { domain:'compensation', entityType:'order' },
    /* Customer Service tickets (RAFCustomerService). Payloads carry ids only;
       every surface re-reads through the authority's access checks, so an
       internal note never travels on the bus. */
    'support.ticket.created':        { domain:'support', entityType:'ticket' },
    'support.ticket.claimed':        { domain:'support', entityType:'ticket' },
    'support.ticket.updated':        { domain:'support', entityType:'ticket' },
    'support.ticket.transferred':    { domain:'support', entityType:'ticket' },
    'support.ticket.escalated':      { domain:'support', entityType:'ticket' },
    'support.ticket.resolved':       { domain:'support', entityType:'ticket' },
    'support.ticket.closed':         { domain:'support', entityType:'ticket' },
    'support.ticket.reopened':       { domain:'support', entityType:'ticket' },
    'support.followup.created':      { domain:'support', entityType:'ticket' },
    'support.followup.completed':    { domain:'support', entityType:'ticket' },
    /* notifications */
    'notification.created':          { domain:'notification', entityType:'notification' },
    'notification.read':             { domain:'notification', entityType:'notification' },
    'notification.preference.changed':{ domain:'notification', entityType:'user' },
    /* Customer ↔ Driver communication (RAFDriverCommunication). Payloads carry
       ids only; a receiving page re-reads the authority, which re-checks access,
       so an event is never treated as permission to see anything. */
    'communication.message.sent':      { domain:'communication', entityType:'order' },
    'communication.message.delivered': { domain:'communication', entityType:'order' },
    'communication.message.read':      { domain:'communication', entityType:'order' },
    /* configuration */
    'config.changed':                { domain:'config',       entityType:'config_key' }
  };

  var SOURCES = ['customer', 'merchant', 'driver', 'admin', 'system', 'automation'];

  var subs = [];                 /* { pattern, fn } */
  var seen = [];                 /* recent eventIds, bounded */
  var SEEN_MAX = 500;

  function remember(id){
    if (seen.indexOf(id) > -1) return false;
    seen.push(id); if (seen.length > SEEN_MAX) seen.splice(0, seen.length - SEEN_MAX);
    return true;
  }
  function makeId(type){
    return 'ev-' + type.replace(/\./g, '_') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  /* the actor is whoever is signed in — resolved from RAFPerm, never supplied */
  function sessionActor(){
    try {
      var u = global.RAFPerm && RAFPerm.currentUser ? RAFPerm.currentUser() : null;
      if (u && u.id) return { type:actorType(u.roleId), id:u.id, name:u.name || null, roleId:u.roleId || null };
    } catch (e) {}
    return { type:'anonymous', id:null, name:null, roleId:null };
  }
  function actorType(roleId){
    if (roleId === 'driver') return 'driver';
    if (roleId === 'merchant' || roleId === 'merchant_employee') return 'merchant';
    if (roleId === 'customer') return 'customer';
    if (roleId) return 'staff';
    return 'anonymous';
  }

  function matches(pattern, type){
    if (pattern === '*') return true;
    if (pattern === type) return true;
    if (pattern.slice(-2) === '.*') return type.indexOf(pattern.slice(0, -1)) === 0;
    return false;
  }
  function deliver(ev){
    if (!ev || !ev.eventId || !remember(ev.eventId)) return 0;
    var n = 0;
    subs.slice().forEach(function (s) {
      if (!matches(s.pattern, ev.eventType)) return;
      try { s.fn(ev); n++; } catch (e) { /* a subscriber may never break delivery */ }
    });
    return n;
  }

  function publish(type, opts){
    opts = opts || {};
    var def = TYPES[type];
    if (!def) return { ok:false, reason:'unregistered_event_type', eventType:type };
    var src = opts.source && SOURCES.indexOf(opts.source) > -1 ? opts.source : (opts.system ? 'system' : null);
    var ev = {
      eventId:    makeId(type),
      eventType:  type,
      domain:     def.domain,
      version:    VERSION,
      timestamp:  Date.now(),
      actor:      opts.system ? { type:'system', id:null, name:null, roleId:null } : sessionActor(),
      source:     src,
      entityType: opts.entityType || def.entityType,
      entityId:   opts.entityId != null ? String(opts.entityId) : null,
      storeSlug:  opts.storeSlug || null,
      payload:    opts.payload && typeof opts.payload === 'object' ? opts.payload : {},
      remote:     false
    };
    deliver(ev);
    /* hand it to the other tabs of this browser */
    if (!opts.localOnly) {
      try { localStorage.setItem(CHANNEL, JSON.stringify(ev)); } catch (e) {}
    }
    return { ok:true, event:ev };
  }

  function subscribe(pattern, fn){
    if (typeof fn !== 'function' || typeof pattern !== 'string') return function () {};
    var s = { pattern:pattern, fn:fn };
    subs.push(s);
    return function unsubscribe(){ subs = subs.filter(function (x) { return x !== s; }); };
  }

  /* another tab published */
  global.addEventListener('storage', function (e) {
    if (e.key !== CHANNEL || !e.newValue) return;
    var ev = null;
    try { ev = JSON.parse(e.newValue); } catch (x) { return; }
    if (!ev || !TYPES[ev.eventType]) return;
    ev.remote = true;
    deliver(ev);
  });

  /* bridges from the existing authorities' DOM events (same tab). Each carries
     the authority's own detail as payload; the authority stays the owner. */
  function bridge(domEvent, type, map){
    document.addEventListener(domEvent, function (e) {
      var d = e && e.detail;
      var o = map(d);
      if (o) publish(type, o);
    });
  }
  bridge('raf:order', 'order.changed', function (d) {
    if (!d || !d.id) return null;
    return { entityId:d.id, payload:{ kind:d.kind || null } };
  });
  bridge('raf:snapshot', 'order.snapshot.updated', function (d) {
    if (!d || !d.id) return null;
    return { entityId:d.id, payload:{ note:d.note || null } };
  });
  bridge('raf:audit', 'audit.appended', function (d) {
    if (!d || !d.eventId) return null;              /* a remote append arrives as null — skip */
    return { entityId:d.eventId, storeSlug:d.storeSlug || null, source:d.source || null,
             payload:{ action:d.action, orderId:d.orderId || null } };
  });

  global.RAFEventBus = {
    VERSION:VERSION, DOMAINS:DOMAINS.slice(), TYPES:TYPES, SOURCES:SOURCES.slice(),
    publish:publish, subscribe:subscribe,
    /* test / diagnostics: how many subscribers are attached */
    subscriberCount:function(){ return subs.length; }
  };
})(window);
