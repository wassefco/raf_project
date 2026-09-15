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
| `set(key, value)` | requires an active session with the existing `settings.edit` permission; validated by type; audited (`config.changed`); published (`config.changed`) |

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

Active producers: `ownership.transferred` (reserved path), `logistics.lock.acquired|released|recovered`, `config.changed`; Phase C: `dispatch.assigned`, `driver.skipped`; Phase D: `dispatch.reassigned`, `dispatch.returned_to_pool`, `reassignment.requested|cancelled|decided`.
Reserved (recorded only when a later phase performs them):
`exception.*` (incl. SLA approaching/breached, escalated, taken, returned),
`delivery.arrived`, `otp.*`, `eta.updated`, `availability.*`, `schedule.changed`,
`overtime.changed`, `communication.*`, `rating.submitted`, `compensation.*`.

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

## 14. Security & identity rules

* Every new authority resolves identity from the session (RAFPerm); none accepts a caller-supplied
  user id, driver id, employee id, store slug or actor name as authority.
* No new roles; no new permission keys. "Dispatcher" is a capability inside Logistics, not a role.
* Drivers are not Logistics Operations employees.
* **PRODUCTION REQUIRED:** all browser-side checks are advisory; real enforcement needs server-side
  authentication, sessions and authorisation.
