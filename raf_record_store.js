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
    /* Phase I — owned by RAFCompensation */
    compensations:      { key:'raf_compensations',        owner:'RAFCompensation',
                          purpose:'append-only, immutable delay compensation records (one per order: calculation, promised ETA, delivered time, issuedAt, expiresAt)' },
    compensation_events:{ key:'raf_compensation_events',  owner:'RAFCompensation',
                          purpose:'append-only compensation lifecycle (added_to_wallet / voided / reversed), at most one of each per compensation' },
    /* Phase I — owned by RAFConfig: lets a rule be applied as it stood at a past instant (RAFConfig.valueAt) */
    config_history:     { key:'raf_config_history',       owner:'RAFConfig',
                          purpose:'append-only configuration changes (key, value, at, by) — written before the override itself' },
    /* Customer Service — owned by RAFCustomerService. A ticket's CREATION
       record is immutable; its current state (status, priority, department,
       assignment, resolution) is DERIVED from the activity entries. */
    support_tickets:    { key:'raf_support_tickets',      owner:'RAFCustomerService',
                          purpose:'append-only customer service tickets — the immutable facts at open (customer, type, source, context, category, subject, description, SLA snapshot)' },
    support_activities: { key:'raf_support_activities',   owner:'RAFCustomerService',
                          purpose:'append-only ticket activity (claim, transfer, status, internal note, customer message, priority, link) — current ticket state is derived from these' },
    support_tasks:      { key:'raf_support_tasks',        owner:'RAFCustomerService',
                          purpose:'append-only child-task entries of a ticket (created / updated / completed); task state is derived' },
    support_followups:  { key:'raf_support_followups',    owner:'RAFCustomerService',
                          purpose:'append-only follow-up entries of a ticket (created / completed / cancelled); follow-up state is derived' },
    support_relations:  { key:'raf_support_relations',    owner:'RAFCustomerService',
                          purpose:'append-only links between a ticket and an existing RAF record (link / unlink); references only, never copies' },
    support_escalations:{ key:'raf_support_escalations',  owner:'RAFCustomerService',
                          purpose:'append-only ticket escalations raised for management attention (never a second ticket)' },
    /* Logistics Management — owned by RAFLogistics. A driver APPLICATION is
       not an account: applicants live here until Logistics approves them, and
       an approved or rejected application is kept forever. The submission is
       immutable; the decisions are separate events, so the status is derived
       and no record is ever rewritten. */
    logistics_applications:      { key:'raf_logistics_applications',       owner:'RAFLogistics',
                          purpose:'append-only driver join applications — the immutable facts at submission (applicant, vehicle, document metadata, consent, source)' },
    logistics_application_events:{ key:'raf_logistics_application_events', owner:'RAFLogistics',
                          purpose:'append-only application lifecycle (submitted / review note / approved / rejected); the application status is derived from these' },
    notifications:      { key:'raf_notifications',        owner:'RAFNotify',
                          purpose:'append-only per-recipient notifications' },
    notification_reads: { key:'raf_notification_reads',   owner:'RAFNotify',
                          purpose:'append-only per-recipient read receipts' }
  };
  var STATE_MAPS = {

    notification_prefs: { key:'raf_notification_prefs',   owner:'RAFNotify',
                          purpose:'per-user notification sound preference (non-merchant accounts)' },

    /* the editable Logistics profile of a driver ACCOUNT: what the application
       carries that the RAF account model has no field for (civil id,
       nationality, area, vehicle, document metadata, application link). The
       identity itself is never copied here — it stays on the account. */
    logistics_driver_profiles:{ key:'raf_logistics_driver_profiles', owner:'RAFLogistics',
                          purpose:'current Logistics profile per driver account; identity stays in RAFPerm and is not duplicated' },

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
