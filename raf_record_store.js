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
    /* Merchant onboarding — owned by RAFMerchantApplications. A merchant join
       APPLICATION is not an account and not a store: a prospective merchant
       lives here until RAF Management decides. Same shape as the driver
       application: an immutable submission plus append-only decisions. */
    merchant_applications:       { key:'raf_merchant_applications',        owner:'RAFMerchantApplications',
                          purpose:'append-only merchant join applications — the immutable facts at submission (applicant, store, working hours, plan, document metadata, consent); never a password' },
    merchant_application_events: { key:'raf_merchant_application_events',  owner:'RAFMerchantApplications',
                          purpose:'append-only merchant application lifecycle (submitted / approved / rejected); the application status is derived from these' },
    /* Merchant account activation — owned by RAFMerchantAuth. One activation
       record per provisioned merchant account (issued), and a second append
       when it is used; the token's state is derived, never rewritten. */
    merchant_activations:        { key:'raf_merchant_activations',         owner:'RAFMerchantAuth',
                          purpose:'append-only merchant activation tokens (issued / used) — account id, created, expires, used; the state is derived' },
    /* Merchant FULL-CLOSURE requests — owned by RAFStoreStatus. The request
       never changes the store; RAF Management decides it (RAFRequests), and
       only an approval closes the store. One decision per request. */
    store_closure_requests:       { key:'raf_store_closure_requests',       owner:'RAFStoreStatus',
                          purpose:'append-only merchant full-closure and closure-extension requests (kind) — store, merchant account, number of days, reason, created; never rewritten' },
    store_closure_request_events: { key:'raf_store_closure_request_events', owner:'RAFStoreStatus',
                          purpose:'append-only request lifecycle (submitted / approved / rejected / cancelled — one final outcome per request); the status is derived' },
    /* Merchant STORE PROFILE change requests — owned by RAFStoreProfile. A
       request never changes the live profile; only RAF Management's approval
       writes the requested fields to the store record. These are REQUESTS,
       not a second profile source. */
    store_profile_requests:       { key:'raf_store_profile_requests',       owner:'RAFStoreProfile',
                          purpose:'append-only store profile change requests — store, merchant account, field-level change set (value at submission → requested value), media metadata only; never rewritten' },
    store_profile_request_events: { key:'raf_store_profile_request_events', owner:'RAFStoreProfile',
                          purpose:'append-only profile request lifecycle (submitted / approved / rejected — one decision per request); the status is derived' },
    /* Customer ↔ Driver communication — owned by RAFDriverCommunication.
       Who may take part is NEVER stored here: it is read, every time, from
       the order's own record (fulfilment.driverId, customer.id, status). */
    communication_messages:      { key:'raf_communication_messages',      owner:'RAFDriverCommunication',
                          purpose:'append-only, immutable Customer ↔ Driver messages (text / images / voice, original media embedded so one send is one write)' },
    communication_receipts:      { key:'raf_communication_receipts',      owner:'RAFDriverCommunication',
                          purpose:'append-only delivered / read receipts, written only by the recipient’s own page; message status is derived from these' },
    communication_call_attempts: { key:'raf_communication_call_attempts', owner:'RAFDriverCommunication',
                          purpose:'append-only call ATTEMPTS used only to enforce the configured attempt limit — caller, callee, time; no phone number, no outcome, not a call record' },
    /* Finance accounting record — owned by RAFAccounting. Every shape is
       append-only: an account, a period and a journal entry are written once
       and never edited; an account's active state and a period's open/closed
       state are DERIVED from their event collections. Balances, the General
       Ledger and the Trial Balance are never stored — always derived from
       accounting_journals. */
    accounting_accounts:         { key:'raf_accounting_accounts',         owner:'RAFAccounting',
                          purpose:'append-only chart of accounts — the immutable account at creation (id, code, bilingual name, type, normal balance, parent, postable, created, by)' },
    accounting_account_events:   { key:'raf_accounting_account_events',   owner:'RAFAccounting',
                          purpose:'append-only account status changes (activated / deactivated); the current status is derived' },
    accounting_periods:          { key:'raf_accounting_periods',          owner:'RAFAccounting',
                          purpose:'append-only accounting periods — start and end Kuwait business dates, created, by; never overlapping' },
    accounting_period_events:    { key:'raf_accounting_period_events',    owner:'RAFAccounting',
                          purpose:'append-only period closures (one per period, never reopened); open / closed is derived' },
    accounting_journals:         { key:'raf_accounting_journals',         owner:'RAFAccounting',
                          purpose:'append-only, immutable posted journal entries (header + balanced lines in integer fils); the ledger and trial balance are derived from these' },
    /* Money — owned by RAFMoney. Verified money EVIDENCE only; no balance is
       stored anywhere. A payment's status and custody, a driver's outstanding
       COD and a handover's state are all DERIVED from these records. */
    money_payments:              { key:'raf_money_payments',              owner:'RAFMoney',
                          purpose:'append-only customer payment records — one per order (source order:<orderId>): method, amount in fils, components, created; never a balance' },
    money_payment_events:        { key:'raf_money_payment_events',        owner:'RAFMoney',
                          purpose:'append-only payment evidence (received / failed / cancelled, per payment or component) — the status and custody are derived' },
    money_cod_collections:       { key:'raf_money_cod_collections',       owner:'RAFMoney',
                          purpose:'append-only COD cash collections — one per order: driver, expected and collected fils, time; the driver\'s custody starts here' },
    money_cod_handovers:         { key:'raf_money_cod_handovers',         owner:'RAFMoney',
                          purpose:'append-only COD cash handovers submitted by a driver — the exact collections handed in and their total' },
    money_cod_handover_events:   { key:'raf_money_cod_handover_events',   owner:'RAFMoney',
                          purpose:'append-only handover acceptance by Accounting (one per handover) — only this clears driver COD custody' },
    /* Driver tips — owned by RAFDriverTips. OPERATIONAL records of a direct
       customer → driver transaction: not RAF money, never in the General
       Ledger. A tip is the driver's the moment the delivery completes; it is
       completed when the driver confirms receipt of a handover (cash or bank
       transfer). Outstanding tips are DERIVED — never a balance field. */
    /* Purchased gift codes — owned by RAFGift. Customer value paid before it is
       the recipient's wallet balance (not RAF revenue). Status is DERIVED from
       these events and the purchase payment's evidence (RAFMoney). */
    gift_codes:                  { key:'raf_gift_code_records',           owner:'RAFGift',
                          purpose:'append-only purchased gift codes — one per purchase: code, value in fils, purchaser, purchase payment reference (RAFMoney)' },
    gift_code_events:            { key:'raf_gift_code_events',            owner:'RAFGift',
                          purpose:'append-only gift code events — activated (validity start + expiry), redeemed (recipient, wallet transaction), expired (recorded once); a code is redeemed once (there is no cancellation)' },
    driver_tip_passthrough:      { key:'raf_driver_tip_passthrough',      owner:'RAFDriverTips',
                          purpose:'append-only tip pass-through records — one per order (TIP-<orderId>), the tip as the customer paid it inside the grand total: order, customer, amount, payment method and reference, funding component (unresolved for Wallet + K-Net); not RAF money, never in the ledger' },
    driver_tip_events:           { key:'raf_driver_tip_events',           owner:'RAFDriverTips',
                          purpose:'append-only tip lifecycle events outside earn / hand / confirm — cancelled before delivery, returned to the customer (destination, reference), return unresolved' },
    driver_tip_earnings:         { key:'raf_driver_tip_earnings',         owner:'RAFDriverTips',
                          purpose:'append-only tip records — one per order (TIP-<orderId>), created when the delivery completes: order, driver, customer, amount in fils, delivery reference' },
    driver_tip_handovers:        { key:'raf_driver_tip_handovers',        owner:'RAFDriverTips',
                          purpose:'append-only tip handovers recorded by Accounting — method (CASH / BANK_TRANSFER), the exact tips handed, total, receipt number, reference, accountant; no journal; the receipt is reconstructed from these' },
    driver_tip_handover_events:  { key:'raf_driver_tip_handover_events',  owner:'RAFDriverTips',
                          purpose:'append-only driver confirmations of receipt (one per payout) — the tips are no longer outstanding once confirmed' },
    /* Customer refunds — owned by RAFRefunds. A refund record never edits the
       original payment; its completion is a separate event. */
    refunds:                     { key:'raf_refunds',                     owner:'RAFRefunds',
                          purpose:'append-only customer refunds — order, payment, amount in fils, reason / source (order change), destination CASH | BANK | WALLET, expected-by, actor' },
    refund_events:               { key:'raf_refund_events',               owner:'RAFRefunds',
                          purpose:'append-only refund completions (one per refund) with their evidence; the refund status is derived' },
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

    /* the MERCHANT sign-in credential set during activation — a salted
       PBKDF2 hash only, never a password. Isolated to merchant accounts; no
       other account type has a credential in this prototype. */
    merchant_credentials:{ key:'raf_merchant_credentials', owner:'RAFMerchantAuth',
                          purpose:'current salted password hash per activated merchant account (PBKDF2-SHA256); never a plaintext password' },

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
