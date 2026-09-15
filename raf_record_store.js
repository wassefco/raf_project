/* ==========================================================================
 * RAF — RECORD STORE  (RAFRecordStore)
 * --------------------------------------------------------------------------
 * The storage BOUNDARY for operational records that must not live inside the
 * `raf_orders` blob. Every name is registered here with its purpose, so a new
 * module cannot quietly invent a key, and every write goes through one
 * adapter that a server-backed store can replace without touching the
 * authorities that use it.
 *
 * Two shapes, never mixed:
 *
 *   COLLECTIONS — APPEND-ONLY history. A record is added once, with a unique
 *   id, and is never modified, trimmed or deleted. Reading derives state
 *   (e.g. "read" from a read receipt) instead of editing a record.
 *
 *   STATE MAPS — explicitly NON-historical current state (e.g. who holds a
 *   lock right now, a user's sound preference). They may be overwritten.
 *   Anything that must be remembered about a state change is recorded
 *   separately in RAFAudit by the owning authority.
 *
 * This module owns NO business rule and decides nothing about who may write:
 * each authority proves identity and permission before it calls in here.
 *
 * PROTOTYPE STORAGE — localStorage is a DEVELOPMENT ADAPTER ONLY. It has no
 * transaction, no lock and no cross-device sync; two tabs can interleave a
 * read and a write. Appends re-read immediately before writing to narrow
 * that window, but it is NOT atomic and NOT production-safe for concurrent
 * multi-user writes. Production requires a server store with append
 * semantics and conditional writes (see raf_foundations.md).
 * ==========================================================================*/
(function (global) {
  'use strict';
  if (global.RAFRecordStore) return;

  /* the registered boundaries — the only names that exist */
  var COLLECTIONS = {
    ownership:          { key:'raf_logistics_ownership',  owner:'RAFDriver',
                          purpose:'append-only delivery ownership history (claims, dispatch assignments, transfers)' },
    driver_skips:       { key:'raf_driver_skips',         owner:'RAFDriver',
                          purpose:'append-only record of drivers skipping an available pool delivery' },
    /* Phase D */
    reassignments:      { key:'raf_logistics_reassignments', owner:'RAFDriver',
                          purpose:'append-only history of Logistics reassignments (driver to driver)' },
    pool_returns:       { key:'raf_logistics_pool_returns',  owner:'RAFDriver',
                          purpose:'append-only history of deliveries returned to the pool, with pool classification' },
    reassignment_requests:{ key:'raf_reassignment_requests', owner:'RAFDriver',
                          purpose:'append-only lifecycle entries of driver reassignment requests (submitted, cancelled, approved, rejected)' },
    /* Phase E — owned by RAFDeliveryOps.exceptions */
    exceptions:         { key:'raf_logistics_exceptions',  owner:'RAFDeliveryOps',
                          purpose:'append-only exception creation records (immutable facts at open, incl. category snapshot)' },
    exception_events:   { key:'raf_logistics_exception_events', owner:'RAFDeliveryOps',
                          purpose:'append-only exception lifecycle entries (action, escalation, management, SLA, close, reopen); state is derived' },
    eta_updates:        { key:'raf_logistics_eta_updates', owner:'RAFDeliveryOps',
                          purpose:'append-only current-ETA updates per order (the Promised ETA is never changed)' },
    call_attempts:      { key:'raf_logistics_call_attempts', owner:'RAFDeliveryOps',
                          purpose:'append-only customer CALL attempts recorded by the delivering driver' },
    penalty_risks:      { key:'raf_logistics_penalty_risks', owner:'RAFDeliveryOps',
                          purpose:'append-only delay penalty-RISK detections (no amount, no charge)' },
    /* Phase F — owned by RAFDriverManagement.availability */
    availability_history:{ key:'raf_driver_availability_history', owner:'RAFDriverManagement',
                          purpose:'append-only driver availability transitions (who, when, why, session)' },
    schedule_history:   { key:'raf_driver_schedule_history', owner:'RAFDriverManagement',
                          purpose:'append-only structured schedule versions' },
    overtime_events:    { key:'raf_driver_overtime_events', owner:'RAFDriverManagement',
                          purpose:'append-only overtime transitions per availability session' },
    /* Phase G — owned by RAFDriverRating */
    driver_ratings:     { key:'raf_driver_ratings',       owner:'RAFDriverRating',
                          purpose:'append-only customer ratings of the driver who completed the delivery (one per order, final)' },
    /* Phase H — owned by RAFDriverCommunication */
    communication_events:  { key:'raf_communication_events',   owner:'RAFDriverCommunication',
                          purpose:'append-only conversation lifecycle (opened / driver transferred / released / assigned / closed), derived from ownership records' },
    communication_messages:{ key:'raf_communication_messages', owner:'RAFDriverCommunication',
                          purpose:'append-only customer ↔ driver messages (never edited or deleted)' },
    communication_receipts:{ key:'raf_communication_receipts', owner:'RAFDriverCommunication',
                          purpose:'append-only delivered / read receipts written by the recipient' },
    notifications:      { key:'raf_notifications',        owner:'RAFNotify',
                          purpose:'append-only per-recipient notifications' },
    notification_reads: { key:'raf_notification_reads',   owner:'RAFNotify',
                          purpose:'append-only per-recipient read receipts' }
  };
  var STATE_MAPS = {
    logistics_locks:    { key:'raf_logistics_locks',      owner:'RAFDeliveryOps',
                          purpose:'current Logistics operation locks (history lives in RAFAudit)' },
    notification_prefs: { key:'raf_notification_prefs',   owner:'RAFNotify',
                          purpose:'per-user notification sound preference (non-merchant accounts)' },
    driver_availability:{ key:'raf_driver_availability',  owner:'RAFDriverManagement',
                          purpose:'current operational availability per driver (history in availability_history)' },
    driver_schedules:   { key:'raf_driver_schedules',     owner:'RAFDriverManagement',
                          purpose:'current structured weekly schedule per driver (history in schedule_history)' },
    config:             { key:'raf_config',               owner:'RAFConfig',
                          purpose:'configured values that override the registry (history in RAFAudit)' }
  };

  var localAdapter = {
    name:'localStorage', durable:false, atomic:false,
    readList: function (key) {
      try { var a = JSON.parse(localStorage.getItem(key)); return Array.isArray(a) ? a : []; }
      catch (e) { return []; }
    },
    writeList: function (key, list) { localStorage.setItem(key, JSON.stringify(list)); },
    readMap: function (key) {
      try { var m = JSON.parse(localStorage.getItem(key)); return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {}; }
      catch (e) { return {}; }
    },
    writeMap: function (key, map) { localStorage.setItem(key, JSON.stringify(map)); }
  };
  var adapter = localAdapter;

  function setAdapter(a){
    var need = ['readList','writeList','readMap','writeMap'];
    if (!a || need.some(function (k) { return typeof a[k] !== 'function'; })) return { ok:false, reason:'invalid_adapter' };
    adapter = a;
    return { ok:true, name:a.name || 'custom', durable:!!a.durable, atomic:!!a.atomic };
  }
  function info(){
    return { adapter:adapter.name || 'custom', durable:!!adapter.durable, atomic:!!adapter.atomic,
             collections:Object.keys(COLLECTIONS).map(function (n) { return { name:n, key:COLLECTIONS[n].key, owner:COLLECTIONS[n].owner, purpose:COLLECTIONS[n].purpose, appendOnly:true }; }),
             stateMaps:Object.keys(STATE_MAPS).map(function (n) { return { name:n, key:STATE_MAPS[n].key, owner:STATE_MAPS[n].owner, purpose:STATE_MAPS[n].purpose, appendOnly:false }; }) };
  }

  /* ---------- append-only collection ---------- */
  function collection(name){
    var def = COLLECTIONS[name];
    if (!def) throw new Error('RAFRecordStore: unregistered collection "' + name + '"');
    function all(){ try { return adapter.readList(def.key); } catch (e) { return []; } }
    return {
      name:name, key:def.key, appendOnly:true,
      all: all,
      filter: function (fn) { return all().filter(fn); },
      byId: function (idField, id) { return all().filter(function (r) { return r && r[idField] === id; })[0] || null; },
      /* adds one record with a caller-built unique id. Refuses duplicates and
         never touches an existing record. Returns the stored record. */
      append: function (idField, record) {
        if (!record || !record[idField]) return { ok:false, reason:'record_id_required' };
        var list = all();                                   /* re-read right before writing */
        for (var i = list.length - 1; i >= 0; i--) {
          if (list[i] && list[i][idField] === record[idField]) return { ok:true, duplicate:true, record:list[i] };
        }
        var stored = Object.assign({}, record, { seq:(list.length ? ((list[list.length - 1].seq || 0) + 1) : 1) });
        list.push(stored);
        try { adapter.writeList(def.key, list); }
        catch (e) { return { ok:false, reason:'persist_failed', error:String((e && e.name) || e) }; }
        return { ok:true, record:stored };
      }
    };
  }

  /* ---------- non-historical state map ---------- */
  function stateMap(name){
    var def = STATE_MAPS[name];
    if (!def) throw new Error('RAFRecordStore: unregistered state map "' + name + '"');
    function all(){ try { return adapter.readMap(def.key); } catch (e) { return {}; } }
    function write(m){ try { adapter.writeMap(def.key, m); return true; } catch (e) { return false; } }
    return {
      name:name, key:def.key, appendOnly:false,
      all: all,
      get: function (k) { var m = all(); return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      set: function (k, v) { var m = all(); m[k] = v; return write(m); },
      remove: function (k) { var m = all(); if (!Object.prototype.hasOwnProperty.call(m, k)) return true; delete m[k]; return write(m); }
    };
  }

  function makeId(prefix){
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  global.RAFRecordStore = {
    collection:collection, stateMap:stateMap, setAdapter:setAdapter, info:info, makeId:makeId,
    COLLECTIONS:COLLECTIONS, STATE_MAPS:STATE_MAPS
  };
})(window);
