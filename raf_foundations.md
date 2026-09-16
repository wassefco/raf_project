# RAF — Logistics Foundations (Phase B)

Shared technical foundations that later Logistics phases (Dispatch, Reassignment,
Exceptions, SLA, ETA, Communications, Availability, Performance, Compensation,
Reports) build on. **No Logistics feature is implemented here.**

Legend used below:

| Tag | Meaning |
|---|---|
| **IMPLEMENTED** | Working in the prototype today |
| **FOUNDATION ONLY** | API/authority exists; no UI or business flow uses it yet |
| **FUTURE CONFIGURATION** | A registered key with no approved value (`not_configured`) |
| **PRODUCTION REQUIRED** | Cannot be made safe in browser storage; needs a server |

---

## 1. Load order

Every page that loads an authority includes, right after `raf_features.js`:

```html
<script src="raf_config.js"></script>
<script src="raf_event_bus.js"></script>
<script src="raf_record_store.js"></script>
<script src="raf_notify_core.js"></script>
```

None of them renders UI. They resolve other authorities (RAFPerm, RAFAudit…) lazily at call time.

---

## 2. RAFConfig — configuration authority (`raf_config.js`) — IMPLEMENTED

Single source for business/system values that RAF Management will configure.

| API | Notes |
|---|---|
| `get(key)` | `{ ok, key, category, type, configured, status, value, source }` |
| `value(key)` | the value, or `null` when **not configured** (callers treat `null` as *capability unavailable*, never as a default) |
| `isConfigured(key)`, `keys(category)`, `describe(key)` | |
| `set(key, value)` | requires an active session with the existing `settings.edit` permission; validated by type; appends the change to `config_history` first (Phase I), then stores the override; audited (`config.changed`); published (`config.changed`) |
| `valueAt(key, at)` | Phase I — the value as it stood at instant `at`, derived from the append-only `config_history` (an older override without history applies from its own `at`; otherwise the registry default). Read-only, deterministic |

States: `approved` (from the approved logistics model) · `prototype_temporary` (no approved value; a clearly marked **TEMPORARY PROTOTYPE** value so a workflow can be exercised; `temporary:true`) · `overridden` (set via `set`) · `not_configured` (no approved value; `value:null`).

**TEMPORARY PROTOTYPE CONFIGURATION** (not approved business decisions; replace through `RAFConfig.set()` or an approved value — no code change):
`logistics.lock.heartbeatMs` = **15000** (15 s) · `logistics.lock.staleMs` = **45000** (45 s, three missed heartbeats) ·
`availability.unavailableReasons` = three temporary driver reasons (§13.8).

**Approved** values: `eta.base` = merchant accepted time, `eta.promisedDurationMinutes` = 90,
`sla.escalationTargetRole` = ops_manager, `pool.priorityAfterMinutes` = 5,
`pool.regularOrder` = oldest first, `pool.priorityOrder` = promised ETA closest first,
`pool.priorityLabel` (English only), `availability.autoOfflineMinutes` = 240,
`availability.basicWorkMinutes` = 480, `availability.defaultState` = available,
`availability.scheduleTimezone` = Asia/Kuwait, `availability.managementReasonRequired` = true,
`overtime.enabled` = true, `overtime.limitEnabled` = true, `overtime.limitMinutes` = 120 (Phase F final, §13.8),
`exceptions.categories` (8 categories, English labels),
`compensation.excludedDelayMinutes` = 90, `compensation.stepMinutes` = 20,
`compensation.amountPerStepFils` = 1000, `compensation.couponExpiryDays` = 7.

**FUTURE CONFIGURATION** (value `null`): `sla.exceptionDurationMinutes`,
`sla.approachingThresholdMinutes`, `exceptions.templates`,
`exceptions.customerUnreachableCallAttempts`, `customerMessages.delayTemplates`,
`otp.digits` (allowed 2 or 3), `otp.maxAttempts`, `compensation.enabled`,
`notifications.soundDefault`.

Not duplicated here: merchant-side timings (acceptance window, undo window,
merchant order lock) remain owned by `RAFOrderEngine`.

---

## 3. RAFEventBus — live event contract (`raf_event_bus.js`) — IMPLEMENTED

Propagation only; never a source of truth.

Envelope v1: `{ eventId, eventType, domain, version, timestamp, actor{type,id,name,roleId}, source, entityType, entityId, storeSlug, payload, remote }`.

* `publish(type, { entityType, entityId, storeSlug, source, payload, system })` — the type must be registered; the **actor is resolved from the session**, never passed (`system:true` → `{type:'system'}`).
* `subscribe(pattern, fn)` → `unsubscribe()`; patterns: exact type, `domain.*`, `*`.
* Same tab: synchronous delivery. Other tabs: one transient channel key (`raf_event_bus`) + the `storage` event. **No polling, no timers.** Each event is delivered at most once per tab (eventId de-duplication).
* Bridges (existing DOM events unchanged): `raf:order` → `order.changed`, `raf:snapshot` → `order.snapshot.updated`, `raf:audit` → `audit.appended`.

Registered types: `order.changed`, `order.snapshot.updated`, `audit.appended`,
`ownership.claimed`, `ownership.transferred`, `logistics.lock.acquired`,
`logistics.lock.released`, `logistics.lock.recovered`, `notification.created`,
`notification.read`, `notification.preference.changed`, `driver.account.changed`
(reserved), `config.changed`; Phase C: `logistics.delivery.assigned`, `driver.delivery.skipped`;
Phase D: `logistics.delivery.reassigned`, `logistics.delivery.returned_to_pool`,
`logistics.delivery.reassignment_request_decided`, `driver.delivery.reassignment_requested`,
`driver.delivery.reassignment_request_cancelled`.

Existing pages keep their existing listeners (storage events, `raf:order`, the merchant
workspace tick). Moving them onto the bus is a later migration.

**PRODUCTION REQUIRED:** cross-device live updates need a server push channel.

---

## 4. RAFNotify — single notification authority — IMPLEMENTED

`raf_notify_core.js` (data layer, loaded on every authority page) and `raf_notify.js`
(the header bell, a UI consumer) are the **same** `RAFNotify` object.

Record v1: `{ notificationId, recipientUserId, timestamp, eventType, title{ar,en}, message, entityType, entityId, href, source, metadata, dedupeKey, version }`.

| API | Scope |
|---|---|
| `create(n)` | producers only; recipient resolved by the producing authority |
| `notifyStore(eventType, orderId)` | one notification per active account of the store that owns the order (snapshot `storeSlug` + RAFPerm store link) |
| `forRecipient({audience, entityType})` | **signed-in account only** |
| `unreadCount`, `markRead(id)`, `markAllRead(opts)` | signed-in account only; reads are append-only receipts |
| `soundPreference(kind)`, `setSoundPreference(bool)` | per account; merchants delegate to `RAFMerchantPrefs` |

* Read state is per recipient (receipts), never written onto the notification.
* No severity hierarchy.
* Registered event types (real events only): `order.accepted`, `order.cancelled`, `order.delivered`, `order.change`, `merchant.order.new`, `merchant.order.acceptance_warning`, `merchant.change.approved|rejected|failed`.
* Producers: `RAFOrderEngine.notify` (customer), `RAFOrderChanges` (customer + store), merchant workspace detection (store).
* **Legacy bridge (read-only):** `raf_notif_extra` (customer) and `raf_merchant_notifs` (store inbox) are still shown to their rightful recipients; nothing writes them any more. Their old *shared* read flags seed initial read state only.
* No mock notifications exist.

---

## 5. Ownership transfer (RAFDriver) — FOUNDATION ONLY

* `claim()` now also appends a `claim` entry to the ownership history and publishes `ownership.claimed`. **IMPLEMENTED**
* `transferOwnership(orderId, { toDriverId, reason })` — Logistics staff only:
  * actor = signed-in account with Logistics access (`orders.view` + `drivers.view`, active) **and** the existing `orders.manage` key (*provisional* until granular Logistics permissions exist);
  * caller must hold the delivery's operation lock;
  * old owner read from the snapshot (never supplied); `toDriverId` must be an active driver account;
  * reason mandatory once picked up;
  * writes only `snapshot.fulfilment` (`driverId`, `assignedAt` = transfer time); engine state, commercial data, inventory, refunds untouched;
  * appends a `transfer` history entry, audits `ownership.transferred`, publishes `ownership.transferred`.
* `ownershipHistory(orderId)` — staff; `unrecordedOrigin:true` when the current owner predates the history.
* `milestones(orderId)` — staff; canonical timestamps with their sources.
* The driver "return delivery" action remains removed.

**PRODUCTION REQUIRED:** a server-side conditional write (compare-and-set on the current owner).

---

## 6. Canonical operational timestamps — IMPLEMENTED

| Milestone | Authority / source |
|---|---|
| Merchant accepted | `RAFOrderEngine.acceptedAt(orderId)` → latest non-undone `order.accept` audit event (**approved Promised ETA base**) |
| Ready | `RAFOrderEngine.readyAt(orderId)` → latest non-undone `order.ready` audit event |
| First claim | ownership history (`claim` entry) |
| Current owner since | `snapshot.fulfilment.assignedAt` |
| Picked up / delivered | `snapshot.fulfilment.pickedUpAt` / `deliveredAt` |

No timestamp is duplicated, no historical snapshot is back-filled, and no ETA is computed.

---

## 7. Logistics operation locks (RAFDeliveryOps) — FOUNDATION ONLY

`lockPolicy()`, `lockOf(orderId)`, `acquireLock`, `heartbeatLock`, `releaseLock`, `recoverStaleLock`.

* Identity from the session; Logistics access required; owner name from the owner's account record.
* Lock: `{ lockId, entityType:'delivery', entityId, ownerUserId, ownerName, acquiredAt, heartbeatAt, state, stale, recoveredFrom, label }`; `label` = "جاري العمل عليها بواسطة [name]".
* Another staff member gets `LOCKED` + `readOnly:true`.
* Timing from `RAFConfig` (`logistics.lock.heartbeatMs`, `logistics.lock.staleMs`), read on every call. Both currently hold **TEMPORARY PROTOTYPE** values (15 s / 45 s, status `prototype_temporary`; `lockPolicy().temporary:true`, and the Assignment board says so). If both are unset, `acquireLock` returns `LOCK_POLICY_NOT_CONFIGURED`. No duration is coded in the lock implementation; merchant lock timings are not reused.
* Stale recovery is explicit (`recoverStaleLock`) and audited; no sweep timer. Management override is not implemented.

**PRODUCTION REQUIRED:** atomic acquire (conditional write) on a server.

---

## 8. Audit registry (RAFAudit) — IMPLEMENTED

Active producers: `ownership.transferred` (reserved path), `logistics.lock.acquired|released|recovered`, `config.changed`; Phase C: `dispatch.assigned`, `driver.skipped`; Phase D: `dispatch.reassigned`, `dispatch.returned_to_pool`, `reassignment.requested|cancelled|decided`; Phase G: `rating.submitted` (RAFDriverRating — a customer's final
rating of the driver who completed the delivery, §14); Phase H: `communication.message`, `communication.opened|driver_transferred|driver_released|driver_assigned|closed`
(RAFDriverCommunication, §15); Phase I: `compensation.issued|voided|reversed` (RAFCompensation, §17) and
`wallet.credited|debited` for compensation credit, expiry and reversal (RAFWallet).
Reserved (recorded only when a later phase performs them):
`exception.*` (incl. SLA approaching/breached, escalated, taken, returned),
`delivery.arrived`, `otp.*`, `eta.updated`, `availability.*`, `schedule.changed`,
`overtime.changed`, `communication.call` (no call record is kept in Phase H).

Actor attribution (new events): with RAFPerm loaded, the **session** account is the actor; a
different caller-supplied id is kept only as `metadata.actorClaimedId`; caller-supplied names and
roles are ignored. Existing events are not rewritten.

---

## 9. Storage boundaries (RAFRecordStore, `raf_record_store.js`)

| Name | Key | Kind | Owner |
|---|---|---|---|
| `ownership` | `raf_logistics_ownership` | append-only | RAFDriver |
| `driver_skips` | `raf_driver_skips` | append-only | RAFDriver (Phase C) |
| `reassignments` | `raf_logistics_reassignments` | append-only | RAFDriver (Phase D) |
| `pool_returns` | `raf_logistics_pool_returns` | append-only | RAFDriver (Phase D) |
| `reassignment_requests` | `raf_reassignment_requests` | append-only | RAFDriver (Phase D) |
| `driver_ratings` | `raf_driver_ratings` | append-only | RAFDriverRating (Phase G) |
| `communication_events` | `raf_communication_events` | append-only | RAFDriverCommunication (Phase H) |
| `communication_messages` | `raf_communication_messages` | append-only | RAFDriverCommunication (Phase H) |
| `communication_receipts` | `raf_communication_receipts` | append-only | RAFDriverCommunication (Phase H) |
| `compensations` | `raf_compensations` | append-only (immutable) | RAFCompensation (Phase I) |
| `compensation_events` | `raf_compensation_events` | append-only | RAFCompensation (Phase I) |
| `config_history` | `raf_config_history` | append-only | RAFConfig (Phase I) |
| `notifications` | `raf_notifications` | append-only | RAFNotify |
| `notification_reads` | `raf_notification_reads` | append-only | RAFNotify |
| `logistics_locks` | `raf_logistics_locks` | current state | RAFDeliveryOps |
| `notification_prefs` | `raf_notification_prefs` | current state | RAFNotify |
| `config` | `raf_config` | current state | RAFConfig |

Future modules add their own registered collections (exceptions, communication, ratings,
availability history, reassignment history, skips, compensation, SLA) — **not** fields inside
`raf_orders`.

**Prototype localStorage is a development adapter only.** It is not atomic, not transactional
and not safe for concurrent multi-user writes. `RAFRecordStore.setAdapter()` is the seam for a
server store.

---

## 10. Phase C — Dispatch & Operations core

Manual dispatch only: no automatic, proximity, capacity or sequential-offer logic exists.

### 10.1 Pool — IMPLEMENTED
* A delivery is dispatchable when its derived stage (RAFDriver) is `awaiting_driver`: engine state READY, no `fulfilment.driverId`, not closed. No second status model.
* `RAFDriver.dispatchPool()` (staff) returns `{ priority, regular }`, classified and ordered:
  * **first entry** → Regular; entered at the latest non-undone `order.ready` audit event;
  * **returned** (latest ownership record kind `returned_to_pool`) → Priority when the returning driver held it **more than** `pool.priorityAfterMinutes` (5), else Regular. *No Phase C action creates a return record — FOUNDATION ONLY for the Reassignment phase.*
  * Regular: oldest pool entry first. Priority: `RAFOrderEngine.promisedEtaAt()` closest first (accepted + `eta.promisedDurationMinutes`). Missing timestamps sort last and name the missing source; ties break by order id.
* `RAFOrderEngine.promisedEtaAt(orderId)` is the only ETA computation; used for ordering only (no ETA UI).

### 10.2 First assignment — IMPLEMENTED
`RAFDriver.transferOwnership(orderId, { kind:'first_assignment', toDriverId })`
* staff = Logistics access + `orders.manage`. **TEMPORARY PROTOTYPE AUTHORISATION BOUNDARY:** under the current shared permission model this also admits **Customer Service** and **Higher Management** (correction, Phase E: the Finance role holds neither `drivers.view` nor `orders.manage` and is refused; the account earlier reported as Finance, usr-005, is an Operations Manager). That is not the final Logistics permission model and not a business rule; future granular Logistics permissions replace it at `staffScope()`;
* refuses: `ALREADY_OWNED`, `NOT_DISPATCHABLE`, `DELIVERY_CLOSED`, `STORE_UNRESOLVED`, `LOCK_POLICY_NOT_CONFIGURED`, `LOCK_REQUIRED`, `TARGET_INVALID` (non-driver, suspended, unknown), `FIELD_NOT_ACCEPTED`;
* shares the claim race arbitration (`raf_driver_claims`), then re-reads order, engine state, driver status, lock and session before committing;
* commit: snapshot `fulfilment` → `RAFOrderEngine.driverAssigned(…, { via:'dispatch' })` (one audit `dispatch.assigned`, neutral timeline line) → ownership record `dispatch` → `RAFNotify` `driver.delivery.assigned` to the driver → `logistics.delivery.assigned` event. Engine refusal rolls the snapshot back.
* No customer notification, no financial, commercial or inventory change.
* `kind:'reassignment'` → `REASSIGNMENT_RESERVED`; missing kind → `KIND_REQUIRED`. The Phase B owned-transfer primitive is kept internally for the next phase.

`RAFDeliveryOps.assign(orderId, { toDriverId })` calls the above and releases the operation lock on success or on a terminal refusal. `RAFDeliveryOps.dispatchBoard()` projects pools, active drivers (`RAFDriver.eligibleDrivers()`), locks, deliveries with drivers and delivered today.

### 10.3 UI — IMPLEMENTED
Logistics Management → Dispatch & Operations → **Assignment**: Priority and Regular pools, active drivers, deliveries with drivers, delivered today. Opening a delivery acquires the lock; another employee sees "جاري العمل عليها بواسطة [name]" read-only; a stale lock can be recovered. Driver selection → confirmation summary → confirm. Heartbeat runs at the configured interval only while the lock is held. Live updates via RAFEventBus; no polling. **Live Operations** lists live deliveries. Manual Intervention, Exceptions and Reassignment remain Not Configured.

With lock timing **not configured** the board shows a Not Configured notice and nothing can be opened for work or assigned. With the temporary prototype timings (current state) it shows a "Temporary" notice.

### 10.4 Skip — IMPLEMENTED
`RAFDriver.skip(orderId)` — **a Driver operation, not a Logistics operation**: the signed-in active driver acting for itself only (anonymous, customer, merchant, merchant employee, every staff role including ops manager and super admin, and suspended drivers are refused; `driverId`/`employeeId`/`actorId`/`storeSlug` fields are refused; an `actor` naming another driver is refused). Pool deliveries only. Appends to `driver_skips` (`raf_driver_skips`), audits `driver.skipped`, publishes `driver.delivery.skipped`. No ownership, order-state, customer notification or availability change. One skip per driver per pool entry (`ALREADY_SKIPPED`). The delivery stays visible and claimable for that driver (no rule hides it). Driver App: Skip button with confirmation.

### 10.5 Driver App
Notifications from `RAFNotify.forRecipient({ audience:'driver' })` on Home (unread) and Profile; opening one marks it read for that driver only. Sound: `notifications.soundDefault` is not configured and drivers have no alert sound asset, so no sound is played.

### 10.6 PRODUCTION REQUIRED
Atomic conditional writes for arbitration, lock acquisition and the assignment commit; server-side authorisation; durable append-only records; server push for cross-device live updates.

---

## 11. Phase D — Reassignment & Return to Pool

Manual only: no automatic reassignment, replacement, fallback, proximity or capacity logic.

### 11.1 Staff operations — IMPLEMENTED
`RAFDriver.transferOwnership(orderId, { kind, … })` is still the single staff ownership primitive:

| kind | Rule |
|---|---|
| `first_assignment` | Phase C, unowned pool delivery (owned → `ALREADY_OWNED`) |
| `reassignment` | owned, open delivery (stage with a driver) → another active driver; reason optional before pickup, **mandatory after pickup**; `SAME_DRIVER`, `TARGET_INVALID`, `NOT_OWNED` |
| `return_to_pool` | owned, open delivery → no owner, dispatchable again; **reason mandatory** |

Shared: temporary Logistics scope + `orders.manage` (TEMPORARY PROTOTYPE AUTHORISATION BOUNDARY), live operation lock (validated before and at commit), resolved store (`STORE_UNRESOLVED`), not closed (`DELIVERY_CLOSED`), optional `expectedDriverId` compare-and-set (`OWNERSHIP_CHANGED`), full re-read before commit (a pickup in between is detected). While the driver has a pending request both are refused with `REQUEST_PENDING`.

`RAFDeliveryOps.reassign / returnToPool / decideRequest / history` only call RAFDriver and release the lock afterwards.

* **Reassignment commit:** snapshot `fulfilment` (new owner, `assignedAt` = now, pickup kept exactly) → claim ledger → audit `dispatch.reassigned` → ownership record `reassignment` → `reassignments` record → notifications (old driver `driver.delivery.removed` or `driver.reassignment_request.approved`; new driver `driver.delivery.reassigned`) → event `logistics.delivery.reassigned`. Engine state unchanged.
* **Return commit:** snapshot `fulfilment` (no owner, **`pickedUpAt` kept**) → `RAFOrderEngine.driverUnassigned(…, { via:'return_to_pool' })` (READY, audit `dispatch.returned_to_pool`, neutral timeline line; snapshot rolled back if refused) → claim ledger cleared → ownership record `returned_to_pool` → `pool_returns` record → old driver notified → event `logistics.delivery.returned_to_pool`.
* Neither cancels, refunds, re-prices, re-stocks or closes anything, and neither notifies the customer or exposes the reason.

### 11.2 Pool classification — IMPLEMENTED
Decided at the moment of return and stored on the ownership and return records: `held = return time − fulfilment.assignedAt` (when the returning driver became the responsible owner). `held ≤ pool.priorityAfterMinutes (5) × 60 000 ms` → Regular; greater → Priority ("Priority — Reassigned Delivery"). First dispatch is always Regular. Priority ordering: `RAFOrderEngine.promisedEtaAt` closest first; Regular: oldest pool entry first.

A delivery returned **after pickup** keeps `pickedUpAt`: its derived stage is `awaiting_driver` while unowned, and the next owner (claim or dispatch) continues at `out_for_delivery` — no second pickup is required or recorded. The pool card and Driver App show "Already collected from the store".

### 11.3 Driver reassignment requests — IMPLEMENTED
* `RAFDriver.requestReassignment(orderId, { reason })` — the signed-in active driver who owns the open delivery; reason mandatory; one pending request at a time (`REQUEST_ALREADY_PENDING`). Audit `reassignment.requested`; Logistics staff (same temporary scope) notified `logistics.reassignment_request.submitted`; event `driver.delivery.reassignment_requested`.
* Pending ⇒ the driver's `confirmPickup` / `completeDelivery` return `REQUEST_PENDING`; the Driver App hides them.
* `RAFDriver.cancelReassignmentRequest(orderId)` — requester only; returns the approved wording **"تمت معالجة الطلب"** / "The request has been processed"; audit `reassignment.cancelled`; Logistics notified; event `driver.delivery.reassignment_request_cancelled`.
* `RAFDriver.decideReassignmentRequest(orderId, { requestId, decision, toDriverId, reason })` — staff + lock: `approve_reassign` (→ reassignment), `approve_return` (→ return to pool, reason required), `reject` (driver continues; `driver.reassignment_request.rejected`). The transfer runs first; the decision entry is appended only on success. Audit `reassignment.decided`; event `logistics.delivery.reassignment_request_decided`.
* Pending state is derived from append-only entries (`submitted | cancelled | approved | rejected`) and only while the requester still owns the open delivery.

### 11.4 Storage (append-only)
| Collection | Key |
|---|---|
| `reassignments` | `raf_logistics_reassignments` |
| `pool_returns` | `raf_logistics_pool_returns` |
| `reassignment_requests` | `raf_reassignment_requests` |

Ownership history (`raf_logistics_ownership`) gains kinds `reassignment` and `returned_to_pool`. Audit actions used are the Phase B reserved names; they are kept off the merchant store timeline (`tl:false`). `ownership.transferred` is no longer produced.

### 11.5 UI
Logistics Management → Dispatch & Operations: **Assignment** gains a requests card and a Manage action on deliveries with drivers; **Reassignment** lists pending requests and deliveries with drivers. The Manage panel shows delivery, current driver, pickup state, pending request and full history, and — only while holding the lock — Reassign / Return to pool, or Approve & reassign / Approve & return / Reject; every action has a form step (driver, reason) and a confirmation step. The header bell lists the account's Logistics notifications. Driver App: "Request reassignment" (reason dialog), pending state card with Cancel, operational toasts.

### 11.6 PRODUCTION REQUIRED
Atomic conditional writes spanning snapshot + engine + ledger + records; server-side authorisation; durable append-only storage; server push for cross-device updates.

---

## 12. Phase E — Exceptions + SLA + Escalation

### 12.1 Ownership decision
`RAFDeliveryOps.exceptions` (in `raf_delivery_management.js`) is the single owner. No separate engine. It reuses RAFDriver.scope (driver identity), the temporary Logistics staff boundary, the Phase C operation locks, `RAFOrderEngine.acceptedAt/promisedEtaAt`, RAFConfig, RAFRecordStore, RAFAudit, RAFNotify and RAFEventBus. It never reassigns, returns to pool, cancels, refunds, touches stock, wallet, price or order state. The Driver App now loads `raf_delivery_management.js` (authority only, no UI).

### 12.2 Identities
| Actor | Rule |
|---|---|
| Driver | `RAFDriver.scope()` + owns the live delivery (claimed / out for delivery) |
| Logistics employee | active + `orders.view` + `drivers.view` + `orders.manage` (TEMPORARY boundary; in demo data: Customer Service, Operations Manager, Higher Management, Super Admin) |
| Operations Management | Logistics employee whose role is RAFConfig `sla.escalationTargetRole` (`ops_manager`) or `super_admin` |
| Merchant / customer / Finance / suspended | no access (Finance lacks `drivers.view` and `orders.manage`) |

**Correction to the Phase C/D reports:** the account used there as "Finance" (usr-005) is an Operations Manager. The real Finance account (usr-008) is refused by the Logistics scope.

### 12.3 Model (append-only)
| Collection | Key | Content |
|---|---|---|
| `exceptions` | `raf_logistics_exceptions` | immutable creation record: order, store, **category snapshot**, description, opener, driver at open, Promised/Current ETA at open, **SLA durations snapshotted at open**, customer message outcome, audit ref |
| `exception_events` | `raf_logistics_exception_events` | action, escalated (manual/automatic), taken, returned, closed (manual/driver/auto), reopened, sla_approaching, sla_breached |
| `eta_updates` | `raf_logistics_eta_updates` | current-ETA updates (Promised ETA never changes) |
| `call_attempts` | `raf_logistics_call_attempts` | driver-declared CALL attempts |
| `penalty_risks` | `raf_logistics_penalty_risks` | penalty-RISK detections (no amount) |

State is derived: `open → escalated → in_management → open (returned)`, `→ closed → open (reopened)`. One active exception per delivery. Deterministic entry ids (`exe|<id>|<type>|<n>`) make duplicate resolutions, escalations, takes, returns, reopens and SLA transitions impossible.

### 12.4 Rules implemented
* **Categories** from RAFConfig `exceptions.categories` (8); "Other" requires a description; a driver cannot report "No Driver Available".
* **Customer Unreachable**: a driver needs RAFConfig `exceptions.customerUnreachableCallAttempts` recorded CALL attempts (since they became owner). Messages don't count; no telephony is simulated.
* **Customer delay message**: ONE `order.delay` notification per exception when its category is in `exceptions.customerDelayCategories`; wording from `customerMessages.delayTemplates`; category appended only when `customerMessages.showDelayReason` is ON. Never re-sent on resolve, auto-close or reopen.
* **Resolution** (lock required): Reassign Driver (decision only — reassignment stays Phase D), Driver Must Continue, Other Resolution (details required). While escalated or with management only Operations Management can resolve. The owning driver can close their own Customer Unreachable exception.
* **Escalation** (lock required): a configured reason (`exceptions.escalationReasons` — not configured) or a description. Operations Managers notified. **Take / Return** (management + lock); return requires a decision; an optional instruction is sent to the current driver.
* **SLA**: one clock from `openedAt` using the durations snapshotted at open; never paused or reset (verified across lock, escalate, take, return, reopen, pending reassignment request). Approaching when ≤ `sla.approachingThresholdMinutes` remain; breached at `sla.exceptionDurationMinutes`; breach **automatically escalates to Operations Management** (attention + notification only).
* **ETA update** (management + lock, reason required): current ETA only; customer (`customerMessages.etaUpdateTemplate`), current driver and Logistics notified; reason internal.
* **Auto-close on delivery**: `RAFDriver.completeDelivery` calls `autoCloseOnDelivery`; evaluation also reconciles an open exception on an already-delivered order. Reason "Auto-Closed — Order Delivered"; no customer message.
* **Reopen** (management + lock, reason required): appends a new cycle; original close stays in history; the CURRENT driver is notified.
* **Penalty risk**: (now or delivered time) − Promised ETA > `sla.penaltyRiskAfterMinutes` → one record, audit, notification, event, Attention. No amount, charge, refund or wallet change.

### 12.5 Evaluation & live updates
`evaluate()` is idempotent and runs on every authorised read or action. An open Logistics page sets ONE timer to the next threshold instant (a business deadline, not a sync poll). No `setInterval`. **PRODUCTION REQUIRED:** a server scheduler — nothing evaluates while no authorised page is open.

### 12.6 Events · audit · notifications
* Events: `logistics.exception.opened|updated|closed|reopened|escalated|management_action|sla_approaching|sla_breached`, `logistics.delivery.penalty_risk`, `logistics.delivery.eta_updated`, `driver.customer_unreachable_attempt`.
* Audit: `exception.opened|action|resolved|closed|auto_closed|reopened|escalated|taken|returned|sla_approaching|sla_breached|call_attempt`, `eta.updated`, `delivery.penalty_risk` (all off the merchant timeline).
* Notifications (RAFNotify, per recipient, dedupe keys): customer `order.delay`, `order.eta_updated`; Logistics `logistics.*`; management escalations; driver `driver.exception.*`, `driver.delivery.eta_updated`. Sound plays only for the recipient's own notification when their preference is ON (bell toggle in Logistics, Profile toggle in the Driver App).

### 12.7 Configuration (RAFConfig)
| Key | Value | Status |
|---|---|---|
| `eta.promisedDurationMinutes` | 90 | prototype_temporary |
| `sla.exceptionDurationMinutes` | 30 | prototype_temporary |
| `sla.approachingThresholdMinutes` | 10 (minutes before breach) | prototype_temporary |
| `sla.penaltyRiskAfterMinutes` | 15 | prototype_temporary |
| `sla.escalationTargetRole` | ops_manager | approved |
| `exceptions.customerUnreachableCallAttempts` | 3 | prototype_temporary |
| `exceptions.customerDelayCategories` | all except customer_unreachable | prototype_temporary |
| `exceptions.escalationReasons` | — | not_configured |
| `customerMessages.delayTemplates` | generic `*` template | prototype_temporary |
| `customerMessages.showDelayReason` | false | prototype_temporary |
| `customerMessages.etaUpdateTemplate` | generic template | prototype_temporary |

### 12.8 PRODUCTION REQUIRED
Server persistence with atomic transactions; server-side authorisation; a scheduler for SLA / penalty evaluation; durable event and notification delivery; multi-device consistency.

---

## 13. Phase F — Driver Availability + Scheduling + Auto-Offline (FINAL)

### 13.1 Ownership decision
`RAFDriverManagement.availability` (`raf_driver_management.js`) is the **only** authority for availability,
schedules, the availability (= work) session, overtime and Auto-Offline. `RAFDriver` only asks it
(`eligibleForNewWork`) before a claim (checked before arbitration **and again right before commit**), a first
assignment and a reassignment target (initial check and revalidation). No page or other module keeps an
availability state machine; the storage keys are written only through this module.

### 13.2 Two separate facts
* **Account status** (Active / Suspended) — RAFPerm, changed by `suspend` / `reactivate`.
* **Availability** (Available / Unavailable) — for NEW tasks only. Unavailable never removes, reassigns,
  cancels or refunds a delivery already held; the owner completes it.
* **Suspend:** Active + Available → Suspended + Unavailable (source `account_suspended`). Held deliveries stay with
  the driver (the Driver App requires an Active account, so completing them needs reactivation or a Logistics
  reassignment).
* **Reactivate:** Suspended → Active + **Available** (source `account_reactivated`) in a **new session**, with
  history, audit, driver notification and events. No second "Set Available" is needed. Held deliveries untouched.

### 13.3 Operations
| Operation | Who | Rules |
|---|---|---|
| `list` / `get` | `drivers.view` | view incl. working state, overtime, Auto-Offline evaluation time, history |
| `setAvailability(driverId,{state,reason})` | `drivers.suspend` | management reason required; suspended → Available refused |
| `setSchedule(driverId,{windows})` | `drivers.suspend` | `{day 0–6, start HH:MM, end HH:MM}`, end > start; history kept |
| `mine()` | the driver | state, source, reason, schedule, configured reasons — **no overtime counter** |
| `setSelfUnavailable({reasonKey, note})` | the driver | reason from RAFConfig; note required when the reason says so; the driver can never set themself Available |
| `evaluate()` / `nextDeadline()` | driver (self) or `drivers.view` | idempotent; one page timer to the next threshold, no polling |
| `eligibleForNewWork(id)` | driver (self) or `drivers.view` | others get `{eligible:false, reason:'forbidden'}` — no state leak |
| `claimSucceeded(id)` | the claiming driver's own session, within 60 s of a real `claim` record | announces the reset event only |

Caller-supplied `driverId` / `actorId` / `actorType` / `roleId` / `storeSlug` / `state` are refused
(`FIELD_NOT_ACCEPTED` / `OTHER_ACTOR`). No new roles or permission keys.

### 13.4 Final rules (approved)
* **Session:** availability session = work session. Starts when the driver becomes Available (management or
  reactivation); ends when Unavailable. Claims, skips, failed claims, dispatch and reassignment neither start nor end it.
* **Basic working time** 8 h. Overtime ON → the driver stays Available (overtime entry recorded); overtime OFF →
  Unavailable at the end of basic time (`work_duration_reached`).
* **Maximum overtime** 2 h → Unavailable (`max_overtime_reached`); held deliveries continue.
* **Auto-Offline** 4 h, evaluated **at the threshold**, counted from max(session start, the driver's last
  successful claim):
  * ≥1 eligible pool delivery at that instant → Unavailable (`auto_offline`), exactly one history entry, audit,
    notification set and event.
  * Pool empty at that instant → no Auto-Offline; the counter restarts from zero at that threshold. A delivery
    appearing later never applies the missed threshold retroactively.
  * Pool occupancy at the threshold is derived from existing durable records (engine `order.ready` milestone,
    ownership `claim` / `dispatch` / `returned_to_pool`); an interval with an unknown end is not counted.
  * **Only a successful driver Claim resets it.** Dispatch assignment, reassignment, return-to-pool, skips and failed
    claims do not. Not disciplinary; the account stays Active.
* **Schedule** is informational: working outside it is allowed; it never changes availability, blocks a claim or
  an assignment, or ends a session. Drivers see it read-only; management edits it.
* **Unavailable reasons** (driver): three temporary RAFConfig values; history stores the key, the label in force and
  the note, so later configuration changes never rewrite history.

### 13.5 Concurrency
Every transition re-reads the state version, then appends its history entry in the **version slot**
`avl|driver|v<n>`; the loser gets `STATE_CHANGED` and issues no audit / notification / event. The state write is
refused if the version moved after the append and is verified after it lands. Automatic transitions also carry a
deterministic idempotency key (`key`). **Known limitation:** localStorage is not transactional — a write landing
*inside* another tab's read-modify-write of the same list can still overwrite one history entry (observed only under
an injected storage hook). PRODUCTION REQUIRED: a transactional store.

### 13.6 Storage (RAFRecordStore)
`availability_history`, `schedule_history`, `overtime_events` (append-only); `driver_availability`,
`driver_schedules` (state maps).

### 13.7 Events · audit · notifications
Events: `driver.availability.changed|available|unavailable`, `driver.schedule.changed`, `driver.overtime.changed`,
`driver.auto_offline`, `driver.auto_offline.reset`, `driver.account.changed`.
Audit: `availability.changed`, `availability.self_unavailable`, `availability.auto_offline`, `schedule.changed`, `overtime.changed`.
Notifications (per-user sound preference): `driver.availability.changed`, `driver.availability.auto_offline`,
`driver.schedule.changed`, `logistics.driver.availability_changed`, `logistics.driver.auto_offline`.

### 13.8 Configuration (RAFConfig)
| Key | Value | Status |
|---|---|---|
| `availability.defaultState` | available | approved |
| `availability.basicWorkMinutes` | 480 | approved |
| `availability.autoOfflineMinutes` | 240 | approved |
| `overtime.enabled` | true | approved |
| `overtime.limitEnabled` | true | approved |
| `overtime.limitMinutes` | 120 | approved |
| `availability.scheduleTimezone` | Asia/Kuwait | approved |
| `availability.managementReasonRequired` | true | approved |
| `availability.unavailableReasons` | Personal Reason · Break / Rest · Other (note required) — Arabic labels not approved | prototype_temporary |

### 13.9 PRODUCTION REQUIRED
Server-side transactional storage, server-side permission enforcement, a server scheduler for thresholds (nothing
evaluates while no authorised client is open), and reliable event / notification delivery.

---

## 14. Phase G — Driver Performance

### 14.1 Authorities
* **`RAFDriverPerformance`** (`raf_driver_performance.js`) — a READ-ONLY projection. It stores nothing and never
  evaluates, audits, notifies or publishes. Every metric is derived at read time from the owning authority's records.
* **`RAFDriverRating`** (`raf_driver_rating.js`) — NEW, the single authority for customer ratings of drivers
  (approved during Phase G because no rating source existed). Append-only collection `driver_ratings`
  (`raf_driver_ratings`), one record per order (`drt|<orderId>`), audit `rating.submitted`, event `driver.rating.submitted`.
  No notification (the driver may not see individual ratings).

### 14.2 Metric sources
| Metric | Source |
|---|---|
| Successful Claims | ownership `claim` with `toDriverId` = driver and actor `{type:'driver', id:driver}` (failed claims, dispatch, reassignment and return-to-pool create no claim record) |
| Completed Deliveries | delivered orders whose snapshot `fulfilment.driverId` is the driver, at `deliveredAt` (only the current owner can complete) |
| Reassigned / Lost ownership | ownership `reassignment` / `returned_to_pool` with `fromDriverId` = driver |
| Skips | `driver_skips` |
| Reassignment Requests | `reassignment_requests` entries of type `submitted` by the driver; breakdown by each request's latest lifecycle entry (pending / cancelled / approved-reassigned / approved-returned / rejected) |
| Exceptions | `exceptions.driverIdAtOpen` = driver, whoever opened it; breakdown by opener type |
| Working hours | availability sessions from `availability_history` (session = availability session), clipped to the period; an open session counts up to now; time after a `driver.suspended` audit is excluded |
| Basic / Overtime | per session, basic time ends at the `overtime_events` `entered` baseline when recorded, otherwise at start + `availability.basicWorkMinutes` |
| Customer Rating | `RAFDriverRating` — average of ALL ratings (1 decimal), not period-filtered |

No score, rate, percentage, weighting or ranking exists. Drivers are compared by name order only.

### 14.3 Rating rules
Customer (active, `customer` role, owner of the order snapshot) rates once after delivery, 1–5, optional comment
(technical limit 1000 chars), final. Credited to the driver who completed the delivery. Driver sees total only;
management (`drivers.suspend`) sees total, count, 1–5 distribution, comments and history. UI: `raf_tracking.html`.

### 14.4 Periods
Today / Week (calendar week from **Sunday** 00:00, approved) / Month / Custom (inclusive dates) in RAFConfig
`availability.scheduleTimezone` (Asia/Kuwait), never the browser timezone.

### 14.5 Access
`mine({period})` — the active driver (RAFDriver.scope), own data only. `compare({period})` and
`detail(driverId,{period})` — existing `drivers.suspend` (Operations Managers, Higher Management, Super Admin;
approved). Customer Service, Finance, customers, merchants, merchant employees and suspended accounts have no
access. Caller-supplied identity fields are refused. No new roles or permission keys.

### 14.6 UI
Driver App Home "My performance" card (own metrics + Total Rating only — no count, no individual ratings, no
comments, no other driver). Management surfaces share ONE widget, **RAFPerfUI** (`raf_driver_performance_ui.js`):
period filter (Today / Week / Month / Custom), driver selection, the comparison table and the per-driver
drill-down with the management-only rating detail (count, distribution, comments, history). It is mounted by
**Logistics Management → Performance → Driver Performance** and by **Driver Management → Driver performance**, so
neither page holds its own copy. Presentation only: every figure and every access decision stays in
RAFDriverPerformance / RAFDriverRating. Drivers are listed alphabetically by name — no ranking, tier, leaderboard
or score anywhere. Live refresh via RAFEventBus (ownership, order, driver, logistics delivery/exception, config);
no polling, no timers. No print/export (Phase J).

### 14.7 Limitations / PRODUCTION REQUIRED
Basic/overtime split of a session that never had an `entered` overtime record uses the current basic-time
configuration. Open-session hours update on the next render/event (no ticking clock). Ratings share the
localStorage transactional limitation (§13.5). Server-side storage, permissions and aggregation are required.

---

## 15. Phase H — Driver Communications

### 15.1 Authority
`RAFDriverCommunication` (`raf_driver_communication.js`) is the single authority for the Customer ↔ Driver
conversation: lifecycle, participants, messages, message status, closure, historical access and the call
abstraction. `RAFCommUI` (`raf_driver_communication_ui.js`) only renders it (tracking page, Driver App,
Logistics Management history viewer). Delivery ownership stays with RAFDriver (snapshot fulfilment owner +
ownership records), the order lifecycle with RAFOrderEngine, reassignment with RAFDeliveryOps/RAFDriver;
the conversation reacts to their records and events and is never a source of truth for them.

### 15.2 Lifecycle
* One conversation per order (`conv|<orderId>`), Customer ↔ the CURRENT driver only; Logistics/Support are
  never live participants.
* Opens as soon as a driver owns the delivery (claim or dispatch) — pickup is not required.
* Reassignment (before or after pickup): the new owner becomes the participant immediately and sees the earlier
  messages as read-only history; the previous driver loses access immediately. Same conversation, nothing restarted.
* Return to pool: no driver participant until the next owner (customer cannot send meanwhile).
* Delivered: closed immediately — no message, media, receipt or call afterwards. The customer keeps a read-only view
  of the closed conversation on tracking; the driver keeps no access. History is kept permanently.
* Lifecycle records (`communication_events`, deterministic ids per ownership record, so concurrent tabs record each
  transition once): `opened`, `driver_transferred`, `driver_released`, `driver_assigned`, `closed`.
  A cancelled order simply has no active conversation (no rule beyond Delivered was approved).

### 15.3 Messages
* Types: `text` (technical limit 2000 chars), `image` (1…`communication.maxImagesPerMessage` images, each ≤
  `communication.maxImageBytes`; jpeg/png/webp/gif), `voice` (≤ `communication.maxVoiceBytes` and
  `communication.maxVoiceSeconds`; webm/ogg/mp4/mpeg/wav). Originals are stored exactly as sent — no
  re-encoding or editing; oversize media is refused, never compressed.
* Storage: a message and its original media are ONE record in `communication_messages`, written by a single append
  (one localStorage write), so a failed write (e.g. `PERSIST_FAILED` when storage is full) leaves neither a message
  nor an orphaned media payload, and nothing append-only is ever rolled back.
* Immutable: append-only, no edit/delete API.
* Each send carries a client-generated `clientId`; the message id is `msg|<order>|<sender>|<clientId>` so a
  repeated or concurrent send of the same message is stored once.
* Status Sent → Delivered → Read is derived from append-only receipts written only by the recipient's own client
  (delivered when the conversation is loaded, read when it is shown on a visible page). No manual status API.

### 15.4 Call abstraction
UI → `call(orderId)` → `CALL_PROVIDER`. The only provider today is the **direct-number fallback**
(`masked:false`): the customer gets the current driver's existing account phone, the driver gets the customer's
delivery phone from the order snapshot, plus a `tel:` link. No phone is copied into communication storage, no call
record is written, nothing claims a call happened. A masked/telephony provider replaces `CALL_PROVIDER` later.
Calling and messaging are independent.

### 15.5 Access
| Who | Access |
|---|---|
| Customer (active, owns the order snapshot) | live while active; read-only closed history |
| Driver (active, CURRENT owner, undelivered) | live |
| Management — existing `drivers.suspend` (Operations Manager, Higher Management, Super Admin) | read-only history + list |
| Customer Service / Support | read-only history ONLY with an associated support complaint — **no customer-support complaint record exists in RAF yet**, so this is refused (`SUPPORT_COMPLAINT_REQUIRED`); `complaintFor()` is the single place to connect one |
| Previous drivers, other customers, merchants, merchant employees, Finance, suspended accounts, anonymous | refused |

Identity comes from the session; caller-supplied `customerId`, `driverId`, `storeSlug`, `actor`, `roleId`,
`conversationId`, sender/recipient/status fields are refused. No new roles or permission keys.

### 15.6 Events · audit · notifications · config
* Events (ids only): `communication.conversation.opened|driver_transferred|driver_released|driver_assigned|closed`,
  `communication.message.sent|delivered|read`. Pages re-read through the authority, so a former driver's open page
  receives nothing it may not see. No polling; the only timer is the voice-recording auto-stop deadline.
* Audit: `communication.message` (no content), `communication.opened|driver_transferred|driver_released|driver_assigned|closed`.
* RAFNotify: `communication.message.customer` (to the customer) and `communication.message.driver` (to the current
  driver only), one per message; no merchant, staff or former-driver notification.
* RAFConfig (TEMPORARY PROTOTYPE): `communication.maxImagesPerMessage` 3, `communication.maxImageBytes` 200000,
  `communication.maxVoiceBytes` 300000, `communication.maxVoiceSeconds` 60.

### 15.7 Message translation (presentation only)
* `RAFMessageTranslation` (`raf_message_translation.js`) is the single translation authority:
  `translate(orderId, messageId, { targetLanguage })` → Promise of `{ status, translatedText, sourceLanguage, targetLanguage }`.
* **Access first:** it calls `RAFDriverCommunication.messageForView()`, which applies exactly the conversation's
  access boundary (customer owner; current owner driver while undelivered — a non-owner driver gets
  `NOT_CURRENT_DRIVER` before any closed-state disclosure; management via `drivers.suspend`; support only with a
  complaint) and reads facts only — no reconciliation, receipt, audit, event or notification. A refused caller gets
  the conversation's own refusal and nothing about the message, language or state.
* **Text only:** images, voice, lifecycle entries and notifications are not translated.
* **Immutable original:** translation never changes, replaces or re-sends the message, its status or the lifecycle;
  it creates no communication record, receipt, audit, event or notification, and nothing is persisted. Results are
  cached in memory per page (message id + text hash + target + provider id/version); identical in-flight requests
  share one provider call; failures are not cached.
* **Target language:** the page's existing RAF language (`htmlRoot` lang / `raf_lang`). If the provider reports the
  source language equals the target → `SAME_LANGUAGE`, no translation.
* **Provider seam:** an adapter `{ id, version, capabilities:{ maxChars?, languages? }, detectLanguage?(text),
  translate(text, target) }` installed by integration code with `setProvider()` (like `RAFRecordStore.setAdapter`).
  **No provider or provider setting is approved, so none is installed and no RAFConfig key exists** — every request
  resolves to `NOT_CONFIGURED` ("Translation is not configured yet."). No fake, dictionary or generated translation.
  Provider limits are honoured without truncating (`TOO_LONG`, `LANGUAGE_UNSUPPORTED`); provider errors →
  `TRANSLATION_FAILED` ("Translation unavailable. Try again.").
* UI (`RAFCommUI`, tracking / Driver App / Logistics history): Translate → translation under the original (labelled)
  → Hide translation; loading, same-language, not-configured and failure states; the message's block is updated in
  place, so translating never triggers read/delivered receipts.
* PRODUCTION REQUIRED: a real translation provider/backend (server-side, with its own key management).

### 15.8 PRODUCTION REQUIRED / prototype limits
Media is stored inside message records as data URLs in localStorage (a full store refuses with `PERSIST_FAILED`);
production needs a binary media store. The single-record write is all-or-nothing only because it is one localStorage
write — there are no transactions across collections (lifecycle, receipts, audit, notifications are separate writes),
and two tabs can still interleave a read-modify-write of the same list. No server push (cross-tab `storage` events
only), no server-side authorisation, no real or masked telephony, no durable server history, and no
support-complaint authority.

Access order: session identity → authorisation from a read-only look at the delivery facts (customer owner / current
owner driver / management / support-with-complaint) → only then closed/delivered disclosure and lifecycle
reconciliation writes. Refused callers — and tabs of sessions not entitled to the conversation reacting to events —
write nothing.

---

## 16. Security & identity rules

* Every new authority resolves identity from the session (RAFPerm); none accepts a caller-supplied
  user id, driver id, employee id, store slug or actor name as authority.
* No new roles; no new permission keys. "Dispatcher" is a capability inside Logistics, not a role.
* Drivers are not Logistics Operations employees.
* **PRODUCTION REQUIRED:** all browser-side checks are advisory; real enforcement needs server-side
  authentication, sessions and authorisation.

---

## 17. Phase I — Delay Compensation

### 17.1 Authorities
* **RAFCompensation** (`raf_compensation.js`) — the single owner of eligibility, the delay calculation, one-time
  issuance, the coupon lifecycle, Void / Reverse and the compensation records.
* It does **not** own wallet balances, consumption or expiry (RAFWallet), order state / Promised ETA / delivered time
  (RAFOrderEngine), notification transport (RAFNotify), audit (RAFAudit), events (RAFEventBus), configuration
  (RAFConfig) or storage (RAFRecordStore). It never writes a wallet key.
* **RAFWallet** (`raf_wallet.js`) is extended — not duplicated — with **expiring credit lots** (§17.4).
* **RAFCompUI** (`raf_compensation_ui.js`) — presentation only: tracking page card, RAF Wallet page section, Logistics
  Management → Dispatch & Operations → Delivery Compensation.
* RAFMarketing coupons (merchant percentage discounts) and RAFSettlement were inspected and are **not** used: a
  compensation coupon is RAF's own, wallet-only value. **No merchant settlement liability is created.** `storeSlug` is
  preserved on the record for reporting only.

### 17.2 Final rules (approved)
| Rule | Implementation |
|---|---|
| ON/OFF | `compensation.enabled` (boolean, `not_configured` ⇒ OFF). Only `true` is ON. |
| Evaluate after Delivered | `RAFDriver.completeDelivery` → `RAFCompensation.processDelivered(orderId)` (like the Phase E exception auto-close); re-checks `status === 'delivered'` + the `driver.delivered` milestone |
| ActualDelay | `RAFOrderEngine.deliveredAt` (audit `driver.delivered`) − `RAFOrderEngine.promisedEtaAt` (Merchant Accepted + `eta.promisedDurationMinutes`, the Phase E ETA) |
| First 90 min excluded | `compensation.excludedDelayMinutes` = 90 |
| 20 min = 1 KWD | `blocks = floor(max(0, delayMs − 90·60000) / (20·60000))`, `amount = blocks × 1000 fils` — integer ms/fils, no rounding up, no proration (109→0, 110→1, 129→1, 130→2, 150→3) |
| Once, automatic | deterministic id `CMP-<orderId>`; append-only `append('compensationId')` refuses a second record; no reissue path exists |
| Coupon, wallet only, 7 days | `expiresAt = issuedAt + couponExpiryDays·86400000`; stored once, never recomputed |
| Adding never extends | the wallet lot copies the record's `expiresAt`; RAFWallet refuses any other value |
| Management Void / Reverse | existing `drivers.suspend` (Ops Manager, Higher Management, Super Admin); reason required |
| Customer notification | `compensation.issued` via RAFNotify, text from `compensation.customerMessage` (placeholders `{orderId} {promisedEta} {startAt} {excludedMinutes} {stepMinutes} {amountPerStep} {amount} {validityDays} {expiresAt}`) — **TEMPORARY PROTOTYPE wording** |
| OFF (affects NEW issuance only — final decision) | Checked once, at Delivered, in `processDelivered`: OFF returns before any calculation or write (no record, coupon, credit, notification, audit or event; `evaluate` returns `{ enabled:false }`). A coupon issued while ON is untouched by OFF: still addable to RAF Wallet until its original `expiresAt`, never voided / reversed / altered by the switch, and expires normally. Switching back ON issues nothing retroactively. Default: `compensation.enabled` has no approved value ⇒ OFF until a Super Admin (`settings.edit`) enables it through RAFConfig. |

Record (immutable): orderId, customerId, storeSlug, promisedEtaAt (+source), deliveredAt (+source), delayMs,
actual / excluded / eligible minutes, stepMinutes, completedBlocks, amountPerStepFils, amountFils, issuedAt,
validityDays, expiresAt, createdBy `system`, and a snapshot of each config value with its status.

### 17.3 Lifecycle (derived, never a mutable status field)
`issued` → (customer **Add to RAF Wallet** before expiry) `in_wallet` → `partially_consumed` / `consumed` / `expired` /
`reversed`; `issued` → `expired` (never added: no value is ever created) or `voided` (management, before adding).
Status = record + `compensation_events` + RAFWallet's own lot. Void is refused once the coupon is in the wallet;
Reverse is refused before it.

**The lifecycle decision (financial concurrency).** Add to RAF Wallet and Void are mutually exclusive outcomes of an
issued coupon, so both must first win **one** record with the same deterministic id `cme|<compensationId>|decision`
(type `added_to_wallet` by the owning customer, or `voided` by management with its reason). The winner is decided by
the append-only store (`append` refuses a second record with that id) and then **read back**: a caller proceeds only
when the stored decision is its own. Only then does Add ask RAFWallet for the credit, and RAFWallet independently
re-checks that decision before creating value (§17.4) — so a coupon that is durably VOIDED can never be credited, by
any caller. `reversed` stays a separate event (`cme|<id>|reversed`), because it follows a winning Add.

Add, Void and Reverse run inside an exclusive **Web Lock** (`raf-compensation:<compensationId>`), which is shared by
every same-origin tab, window and frame, so the three never interleave across the browser; they therefore return a
**Promise** (`RAFCompensation.addToWallet / void / reverse`). Where the Web Locks API is missing, the operation runs
directly — a single JS thread is already atomic for this synchronous code — and the decision record still decides.
If a credit write fails after Add won the decision, the coupon reads `add_pending`: no value exists, the customer may
retry, and Void stays refused (management uses Reverse once the credit exists).

### 17.4 RAFWallet expiring credit lots
* `creditLot` appends a `COMPENSATION_CREDIT` credit carrying `lot:{ lotId, sourceType, sourceId, issuedAt, expiresAt }`.
  It verifies the **source record** through RAFRecordStore (exists, same customer, amount, issuedAt, expiresAt), that
  the source's lifecycle decision is `added_to_wallet` **by that customer** (§17.3) — never `voided` and never absent —
  requires the signed-in customer to be the wallet owner, allows one lot per source, and re-checks `expiresAt`
  immediately before the ledger write, so a credit can never land after expiry.
* Spending (generic `debit`) consumes **unexpired lots first, soonest expiry first, then ordinary balance**, recorded
  on the debit as `consumes:[{ lotId, amountMinor }]`.
* **Expiry**: a lot past `expiresAt` is excluded from the balance immediately (derived), and exactly one
  `COMPENSATION_EXPIRY` debit for the **unused remainder only** is appended with key `wallet-lot-expiry|<lotId>` and
  `lotEvent:{ kind:'expiry', effectiveAt:expiresAt }` whenever the wallet is read or debited (`balance`, `history`,
  `lots`, `debit`, `reverseLot`, `expireDue`). The amount must equal the remainder or the write is refused. Consumed
  value stays consumed; ordinary balance and other lots are untouched; repeated / concurrent evaluation writes nothing
  twice (key re-checked in the list being written).
* **Reverse**: `reverseLot` appends one `COMPENSATION_REVERSAL` debit of the lot's unused remainder only
  (`LOT_NOTHING_REMAINING` when fully consumed; `LOT_EXPIRED` when expired). It requires the signed-in session to hold
  the source's existing management permission (`drivers.suspend`).
* `COMPENSATION_*` reasons are reserved: `credit` / `debit` refuse them (`REASON_RESERVED`).
* Lot fields exposed: original, consumed, expired, reversed, remaining, status, issuedAt, expiresAt, addedAt,
  credit / expiry / reversal transaction ids, wallet reference (lotId) and compensation reference (sourceId).
* `balance()` also returns `ordinaryBalance` and `compensationCredit`.
* RAF has **no wallet-spend caller yet** (checkout does not pay from the wallet); the spend order lives in the
  authority's debit path and applies to any future caller.

### 17.5 Access
| Account | View own | View all | Add to wallet | Void | Reverse |
|---|---|---|---|---|---|
| Customer (owner) | ✓ | — | ✓ | — | — |
| Other customer | — | — | — | — | — |
| Ops Manager / Higher Management / Super Admin (`drivers.suspend`) | ✓ | ✓ | — | ✓ | ✓ |
| Customer Service, Finance, Marketing, Logistics employee without `drivers.suspend` | — | — | — | — | — |
| Merchant, Merchant employee, Driver, anonymous, inactive accounts | — | — | — | — | — |

Forged fields (`actorId`, `customerId`, `amountFils`, …) are refused with `FIELD_NOT_ACCEPTED`.

### 17.6 Events · audit · notifications · config
* Events: `compensation.issued`, `compensation.added_to_wallet`, `compensation.voided`, `compensation.reversed`
  (payload: ids only).
* Audit: `compensation.issued` (system/automation), `compensation.voided`, `compensation.reversed` (session actor,
  reason, amounts); `wallet.credited` / `wallet.debited` with `lotId` / `consumes`.
* Notification type `compensation.issued` (audience customer), dedupe key `compensation.issued|<compensationId>`.
* Config: `compensation.enabled` (not approved ⇒ default OFF; switched through RAFConfig by `settings.edit`; applied as it stood at Delivered via `RAFConfig.valueAt`),
  approved 90 / 20 / 1000 fils / 7 days, `compensation.customerMessage` (prototype).

### 17.7 PRODUCTION REQUIRED / prototype limits
* Issuance runs in the delivering driver's browser inside `completeDelivery`; if that page lacks the module or the
  call fails, nothing retries. Production: a server-side, idempotent post-delivery consumer.
* Expiry is applied on access (no timer, no polling). Production: a server-side scheduled/queued expiry job writing
  the same ledger transition at `expiresAt`, and server-side reads that exclude due lots.
* No transactions across the compensation record, events, wallet ledger, audit and notification. The Add/Void race is
  closed by the decision record + Web Lock above (a VOIDED coupon with a wallet credit is not reachable), but the
  remaining localStorage weakness is unchanged: two processes writing the *same* list at the same instant can still
  lose one append (for example a wallet expiry entry in another tab racing an unrelated ledger write). Production needs
  one server-side transaction across the coupon decision and the wallet ledger.
* RAFWallet's pre-existing `system` actor for refunds is trusted by parameter (unchanged); lot credit and reversal
  are additionally session-checked. All browser checks are advisory.

---

## 18. Phase J — Reports Center

### 18.1 Authority
**RAFReports** (`raf_reports.js`) — a READ-ONLY projection. It owns no record and writes nothing: no storage, no
audit, no notification, no event. It re-implements no business rule; where an authority already calculates
something, RAFReports asks that authority. **RAFReportsUI** (`raf_reports_ui.js`) is the presentation widget
(report selector, filter bar, summary tiles, table, empty / NOT_CONFIGURED / error states, CSV, print), mounted by
**Logistics Management → Reports → Reports Center**. No second management shell, no new business-data authority.

API: `run(reportId, filters)`, the ten per-report methods, `csv(result)`, `viewer()`, `REPORTS`, `FILTER_KEYS`.

### 18.2 Reports and their sources
| Report | Source of every figure |
|---|---|
| overview | each line labelled with its own source (orders, engine milestones, ownership, exceptions, availability, compensation) |
| orders | `RAFShop.Orders` snapshots + `RAFOrderEngine` milestones (accepted / ready / delivered / promised ETA) |
| deliveries | snapshot `fulfilment` + engine milestones + ownership history + `RAFDeliveryOps.exceptions` (count, penalty risk) |
| drivers, performance | `RAFDriverPerformance.compare` — the only driver-performance maths in RAF |
| exceptions | `RAFDeliveryOps.exceptions.list` (status, SLA state and deadline, escalation, resolution, penalty) |
| reassignments | ownership `reassignment` / `returned_to_pool` + `reassignment_requests` lifecycle |
| communication | `RAFDriverCommunication.list` + message/event **counts** — never message content |
| compensation | `RAFCompensation.list` (amounts exactly as issued) + the wallet lot each record carries |
| audit | `RAFAudit.query` — append-only, never rewritten or normalised here |

### 18.3 Authorisation (existing keys only — no new role, no new permission)
* Every report requires the existing **`reports.view`** (the key `RAFAudit.canViewAudit` already uses).
* **Operational reports never follow from `reports.view` alone.** A caller must be either Logistics/management —
  holding the SAME existing pair the Logistics surfaces already require, **`orders.view` + `drivers.view`** — or a
  store-linked merchant account, which is limited to its own store AND to the reports already approved for merchant
  visibility (overview, orders, deliveries, audit). Operations Manager, Higher Management and Super Admin hold the
  pair; **Finance** (no `drivers.view`) and **Marketing** (neither) do not, so both are refused every report,
  including audit, inside Reports Center. `RAFAudit.canViewAudit` keeps its existing meaning for every other
  surface — no approved permission contract was changed, and no key or role was added.
* Reports over guarded data delegate to the owning authority, which decides: drivers/performance →
  RAFDriverPerformance (`drivers.suspend`), exceptions → RAFDeliveryOps staff scope, reassignments →
  `RAFDeliveryOps.canAccess()`, communication → RAFDriverCommunication, compensation → RAFCompensation,
  audit → `RAFAudit.canViewAudit`.
* **Export** requires the existing `reports.export`; a viewer without it gets `canExport:false` and `csv()` refuses.
* Identity is the session; caller-supplied identity/filter keys are refused (`FIELD_NOT_ACCEPTED`).

### 18.4 Store scope
An account whose `accountType` is `merchant` is bound to `RAFPerm.storeSlugOf(session)`: rows outside that store are
removed, **driver identity is not disclosed** (the driver column is absent from the view and the CSV), and an
unlinked merchant account receives `NO_STORE_LINK` instead of any rows. The link is never taken from a name and
never guessed.

### 18.5 Filters and date semantics
Today / Week / Month / Custom come from `RAFDriverPerformance.periodOf`, so RAF keeps ONE period implementation in
`availability.scheduleTimezone` (Asia/Kuwait). Custom requires a valid start and end; a reversed or malformed range
is `PERIOD_INVALID`. Each report filters on its own timestamp and never substitutes another: orders → placed
(snapshot `checkoutAt`), deliveries → delivered else assignment/claim, exceptions → opened, reassignments → the move
itself, compensation → issued, audit → the event. Other filters (store, driver, order, status, category, SLA state,
reassignment state, communication type, customer, employee, action) are offered only where real data backs them,
plus a client-side search over the rows already returned.

### 18.6 Export and print
CSV contains exactly the filtered, searched and authorised rows and columns (UTF-8 BOM for spreadsheet software),
named `raf-<report>-<date>.csv`; an empty report exports a header only. Print uses the page's own print stylesheet
(selector, filter bar and action buttons hidden; the table expands instead of scrolling). No XLSX or PDF dependency
was invented. Export and print write nothing.

### 18.7 Live updates
`RAFEventBus` only — `order.*`, `ownership.*`, `logistics.*`, `driver.*`, `communication.*`, `compensation.*`,
`audit.appended`, `config.changed`. No polling, no `setInterval`, no refresh timer (the one `setTimeout(…, 0)` in
the widget only revokes a CSV object URL after the download starts). An event-driven repaint never lands under a
field being typed in; a repaint the user asked for always does.

### 18.8 Known limitations
* **Promised ETA is historical fact (approved).** `RAFOrderSnapshot` carries a write-once `promise` section
  { promisedEtaAt, acceptedAt, durationMinutes, base, recordedAt }. `RAFOrderEngine.merchantAccept` records it at the
  acceptance itself with the configuration as it stood then, and `RAFOrderSnapshot.update` refuses any later write to
  it (`promise_immutable`), so no surface, caller or configuration change can restate it. `RAFOrderEngine.promisedEtaAt`
  returns the recorded value (`recorded:true`) when one exists and only derives when none was recorded. Reports Center
  reports ONLY recorded values — snapshot promise, else a compensation record, else an exception `promisedEtaAtOpen`;
  an order with nothing recorded shows NOT_AVAILABLE and no ETA or delay is derived or backfilled for it. Existing
  records are never modified; a later RAFConfig change affects later acceptances only.
* **Cancellation detail.** Only `order.status === 'cancelled'` is reported; RAF has no separate cancellation-time or
  reason record to read, so no cancellation timestamp is shown.
* **Multi-store: PARTIAL.** Only `usr-010` → `casa-mode` is genuinely linked, so cross-store isolation is proven for
  one store plus the unlinked-account case; no second store was fabricated.
* Search is client-side over the rows already returned (no server-side or full-text search is claimed); all figures
  are as accurate as the localStorage prototype beneath them, and every browser-side check is advisory.
* **Reading can still trigger an owning authority's own evaluation.** RAFReports itself never writes, and eight of
  the ten reports write nothing at all. Two delegate to read APIs that perform their own idempotent evaluation —
  `RAFDeliveryOps.exceptions.list` (Phase E SLA / penalty-risk evaluation) and, through the overview,
  `RAFDriverManagement.availability.list` (Phase F auto-offline) — exactly as the Logistics screens do when opened.
  The writes belong to those authorities, are idempotent (a repeated report run writes nothing) and are unchanged by
  Phase J.

---

## 19. Phase K — RAF-wide Performance

### 19.1 Authority
**RAFPerformance** (`raf_performance.js`) — a READ-ONLY measurement layer. It owns no record, writes nothing, defines
no business rule and re-implements no calculation an authority already performs. **RAFPerfCenterUI**
(`raf_performance_ui.js`) renders it inside the existing Logistics Management shell at **Performance → RAF
Performance**. Export reuses the Reports Center writer (`RAFReports.csv`); there is no second export architecture.

API: `run(viewId, filters)`, the ten per-view methods, `csv(result)`, `viewer()`, `VIEWS`.

### 19.2 Views and sources of truth
| View | Every figure comes from |
|---|---|
| overview | RAFReports (orders, deliveries, exceptions, reassignments, communication, compensation, drivers) + RAFDriverManagement.availability |
| orders | RAFReports.orders/deliveries — milestones from RAFOrderEngine, promise from the snapshot |
| merchants | RAFReports.orders grouped by `storeSlug` (descriptive only) |
| logistics | RAFReports.deliveries + reassignments + exceptions |
| drivers | **RAFDriverPerformance** only — claims, deliveries, skips, requests, exceptions, working time, overtime, rating |
| exceptions | RAFDeliveryOps.exceptions (status, SLA, escalation, resolution, penalty) |
| reassignments | RAFDriver ownership history + reassignment requests |
| communication | RAFDriverCommunication (metadata counts only, never content) |
| customerExperience | RAFDriverRating + RAFReports.deliveries/communication |
| compensation | RAFCompensation (amounts exactly as issued) + the wallet lot |

### 19.3 Authorisation
The existing management set only: **`reports.view` + `orders.view` + `drivers.view`** — Operations Manager, Higher
Management and Super Admin. Finance, Marketing, Customer Service, merchants, merchant employees, drivers, customers
and anonymous callers are refused **by the authority**, and a refused call returns no `rows` at all. Export needs the
existing `reports.export`. **No new permission key and no new role.** Suspended accounts → `ACTOR_INACTIVE`.

### 19.4 Store scope
A store-bound (merchant) account cannot hold `drivers.view`, so it never reaches RAF-wide data; store isolation holds
by construction, and any scoped caller is still filtered to its own store. Management may filter by store
(`storeSlug`). **Multi-store remains PARTIAL**: only `usr-010` → `casa-mode` is genuinely linked, so cross-store
separation between two real stores cannot be proven and no store was fabricated.

### 19.5 Time and denominators
Periods (Today / Week / Month / Custom) come from `RAFDriverPerformance.periodOf` — one implementation, Asia/Kuwait.
Every duration is measured between its own two timestamps (placed → accepted → ready → assigned → picked up →
delivered) and never substitutes another. **Every rate states its denominator in its own row**, e.g. acceptance rate
= accepted ÷ orders placed in the period; on-time rate = on time ÷ delivered orders **with a recorded promise**.

### 19.6 Historical integrity
The Promised ETA is the immutable value recorded on the snapshot at merchant acceptance (§18.8). Orders with no
recorded promise are counted separately as "delivered without a recorded promise (excluded)" and are excluded from
every ETA rate — never derived from today's configuration and never backfilled. Verified: changing
`eta.promisedDurationMinutes` left the orders, logistics, compensation and exception measurements byte-identical,
while a new order recorded the new duration.

### 19.7 Live updates and read-only behaviour
RAFEventBus only (`order.*`, `ownership.*`, `logistics.*`, `driver.*`, `communication.*`, `compensation.*`,
`audit.appended`, `config.changed`). No polling, no `setInterval`, no refresh timer; the one `setTimeout(…, 0)`
only revokes a CSV object URL after the download starts. RAFPerformance writes nothing: a full sweep of all ten
views plus filters and CSV left storage byte-identical. (As in Phase J, two of the underlying authorities may
perform their own idempotent evaluation when read — RAFDeliveryOps SLA and RAFDriverManagement auto-offline.)

### 19.8 No rankings, no scores
There is no leaderboard, rank, score, composite index, tier, target, colour judgement or evaluative label anywhere.
Drivers and stores are listed alphabetically; measurements are facts with a source and a denominator. A driver's
total rating remains RAFDriverRating's all-time value.

### 19.9 Known limitations
* Merchant rejection reasons and out-of-stock events: **NOT_AVAILABLE** — no authoritative per-order record exists
  to read, so no merchant-attributed rejection metric is calculated.
* No approved expected-ready time exists, so no "ready on time" rate is produced.
* Call duration, support complaints and any satisfaction index (NPS/CSAT): **NOT_AVAILABLE** — not recorded, never
  inferred from message text.
* Cancellation reasons are not reported; only `order.status === 'cancelled'` is counted.
* Multi-store: PARTIAL (see §19.4). Everything remains browser-side and advisory until there is a server.
