# RAF — Shared Foundations

> **Status (2026-09-20).** The Logistics / Delivery implementation this document
> originally described (Dispatch, Reassignment, Exceptions and SLA, Driver
> Availability, the Driver App, Driver Management, Driver Communications, Driver
> Rating, Driver Performance, the Reports Center and RAF-wide Performance) was
> **decommissioned and deleted**, to be rebuilt from zero in a later phase. Those
> sections were removed from this document; the numbering of the remaining
> sections is unchanged, so the gaps are deliberate. Nothing here describes a
> future replacement.

What remains below is the shared technical foundation the rest of RAF uses:
configuration, the event bus, notifications, canonical timestamps, the audit
registry, storage boundaries, security rules, Delay Compensation and Customer
Service.

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
`eta.promisedDurationMinutes` = **90** · `checkout.reservationHoldMinutes` = **15** ·
`storeOps.orderCutoffMinutes` = **30** · `compensation.customerMessage`.

**Approved** values: `eta.base` = merchant accepted time,
`compensation.excludedDelayMinutes` = 90, `compensation.stepMinutes` = 20,
`compensation.amountPerStepFils` = 1000, `compensation.couponExpiryDays` = 7,
`support.categories` (7 Customer Service categories, English labels).

**FUTURE CONFIGURATION** (value `null`): `compensation.enabled`,
`notifications.soundDefault`, `support.firstResponseMinutes`,
`support.resolutionMinutes`.

The delivery keys this registry used to hold (ETA offsets beyond the base, exception
SLA, pools, driver availability and overtime, exception categories and customer
delay messages, delivery proof, Logistics operation locks) were removed with the
deleted implementation.

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
`notification.created`, `notification.read`, `config.changed`;
Phase I: `compensation.issued|added_to_wallet|voided|reversed`;
Customer Service: `support.ticket.*` and `support.followup.*`.
Domains: `order`, `notification`, `audit`, `config`, `compensation`, `support`.
The delivery domains (`ownership`, `logistics`, `driver`, `communication`) and
their event types were removed with the deleted implementation.

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

## 6. Canonical operational timestamps — IMPLEMENTED

| Milestone | Authority / source |
|---|---|
| Merchant accepted | `RAFOrderEngine.acceptedAt(orderId)` → latest non-undone `order.accept` audit event (**approved Promised ETA base**) |
| Ready | `RAFOrderEngine.readyAt(orderId)` → latest non-undone `order.ready` audit event |
| Current owner since | `snapshot.fulfilment.assignedAt` |
| Picked up / delivered | `snapshot.fulfilment.pickedUpAt` / `deliveredAt` |

No timestamp is duplicated, no historical snapshot is back-filled, and no ETA is computed.

The `snapshot.fulfilment` fields above remain part of `RAFOrderSnapshot`. Nothing
writes them since the delivery implementation was deleted, so an order placed today
stops at Ready.

---

## 8. Audit registry (RAFAudit) — IMPLEMENTED

Active producers: `config.changed` (RAFConfig); Phase I: `compensation.issued|voided|reversed`
(RAFCompensation, §17) and `wallet.credited|debited` for compensation credit, expiry and reversal
(RAFWallet); Customer Service: `ticket.*` (§21). The order lifecycle keeps its own actions
(`order.*`, `driver.assigned|pickup|delivered|returned`, `lock.*`, `system.*`) recorded by
`RAFOrderEngine`; the `driver.*` order actions are currently produced by nothing, because the
delivery implementation that called those engine hooks was deleted.

The Logistics action labels (`logistics.lock.*`, `dispatch.*`, `reassignment.*`, `driver.skipped`,
`exception.*`, `eta.updated`, `delivery.*`, `otp.*`, `availability.*`, `schedule.changed`,
`overtime.changed`, `communication.*`, `rating.submitted`, `driver.created|updated|suspended|reactivated`)
were removed from the registry with that implementation. Audit records already written are untouched.

Actor attribution (new events): with RAFPerm loaded, the **session** account is the actor; a
different caller-supplied id is kept only as `metadata.actorClaimedId`; caller-supplied names and
roles are ignored. Existing events are not rewritten.

---

## 9. Storage boundaries (RAFRecordStore, `raf_record_store.js`)

| Name | Key | Kind | Owner |
|---|---|---|---|
| `compensations` | `raf_compensations` | append-only (immutable) | RAFCompensation (Phase I) |
| `compensation_events` | `raf_compensation_events` | append-only | RAFCompensation (Phase I) |
| `config_history` | `raf_config_history` | append-only | RAFConfig (Phase I) |
| `notifications` | `raf_notifications` | append-only | RAFNotify |
| `notification_reads` | `raf_notification_reads` | append-only | RAFNotify |
| `support_tickets`, `support_activities`, `support_tasks`, `support_followups`, `support_relations`, `support_escalations` | `raf_support_*` | append-only | RAFCustomerService (§21) |
| `notification_prefs` | `raf_notification_prefs` | current state | RAFNotify |
| `config` | `raf_config` | current state | RAFConfig |

The delivery collections and state maps (ownership, skips, reassignments, pool returns,
reassignment requests, exceptions and their events, ETA updates, call attempts, penalty risks,
availability and schedule history, overtime events, driver ratings, conversation events, messages
and receipts, and the Logistics operation locks) were removed with the deleted implementation.

A new module registers its own collections — **not** fields inside `raf_orders`.

**Prototype localStorage is a development adapter only.** It is not atomic, not transactional
and not safe for concurrent multi-user writes. `RAFRecordStore.setAdapter()` is the seam for a
server store.

---

## 16. Security & identity rules

* Every new authority resolves identity from the session (RAFPerm); none accepts a caller-supplied
  user id, driver id, employee id, store slug or actor name as authority.
* No new roles; no new permission keys.
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
* **RAFCompUI** (`raf_compensation_ui.js`) — presentation only: tracking page card and RAF Wallet page section.
  (Its `mode:'admin'` review view was mounted by the deleted Logistics console; no page mounts it today.)
* RAFMarketing coupons (merchant percentage discounts) and RAFSettlement were inspected and are **not** used: a
  compensation coupon is RAF's own, wallet-only value. **No merchant settlement liability is created.** `storeSlug` is
  preserved on the record for reporting only.

### 17.2 Final rules (approved)
| Rule | Implementation |
|---|---|
| ON/OFF | `compensation.enabled` (boolean, `not_configured` ⇒ OFF). Only `true` is ON. |
| Evaluate after Delivered | `RAFCompensation.processDelivered(orderId)`; re-checks `status === 'delivered'` + the `driver.delivered` milestone. **Its only caller was the deleted delivery implementation, so nothing triggers it today.** |
| ActualDelay | `RAFOrderEngine.deliveredAt` (audit `driver.delivered`) − `RAFOrderEngine.promisedEtaAt` (Merchant Accepted + `eta.promisedDurationMinutes`) |
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

## 20. Final integration & hardening pass (Phases B–K)

A system-level audit of the completed phases. No feature was added, no authority rebuilt, no business rule,
role, permission, status or threshold invented. Two genuine integration defects were found and fixed:

### 20.1 Fixed — wallet reads were authorised by a caller-supplied actor
`RAFWallet.ownershipOk` accepted any `{ id, type:'customer' }` object as proof of identity, so
`balance / history / rawLedger / lots` could be read for ANY customer id by an anonymous or unrelated caller.
A caller claiming to BE the customer must now also be signed in as them (session check); the `system` actor path
(used internally by RAFCompensation and by refunds) is unchanged, so no authority behaviour moved. Verified:
anonymous, another customer, a driver and management are refused; the customer's own wallet, the compensation
views, refund credits and system refunds all still work.

### 20.3 Audit findings kept as-is (pre-existing, outside the phase scope)
* `raf_orders` has several writers (RAFShop.Orders, RAFOrderEngine, RAFOrderSnapshot, RAFOrderChanges, RAFRules) —
  a read-modify-write list and therefore a lost-update risk under true concurrency. Prototype limitation.
* `raf_store_management.html` polls `OPS.isBusy` every 15 s (a pre-event-bus surface) and `raf_order_engine.js`
  runs a 1 s ticker for the merchant acceptance countdown/sweep. Both predate the event bus; migrating them is a
  product/architecture decision, not a defect fix.
* `raf_rules.js` (`RESERVE_MS` 15 min) and `raf_store_ops.js` (`CUTOFF_MS` 30 min) hold pre-existing commerce
  constants outside RAFConfig. Moving them needs approval, since they are approved Phase-A behaviour.

---

## 21. Customer Service (tickets, tasks, follow-ups, escalation, Customer 360)

### 21.1 Authority and naming
`RAFCustomerService` (`raf_customer_service.js`) is the single authority for the Customer Service ticket domain:
**customer ↔ RAF Customer Service ↔ the responsible department**.

RAF already had two other support channels and neither is this one, so neither was renamed or reused:

| Channel | Authority | Direction |
|---|---|---|
| Merchant Support | `RAFCustomerSupport` (`raf_customer_support.js`) | merchant ↔ RAF Management |
| Customer Issues | `RAFCustomerExperience` | customer ↔ the store |
| **Customer Service** | **`RAFCustomerService`** | **customer ↔ RAF** |

The phase specification named the new global `RAFCustomerSupport`; that name was already taken by the merchant
channel that `raf_merchant_support.html` consumes, so taking it would have broken a shipped surface. The authority
is `RAFCustomerService`, its console is `raf_customer_service.html`, and the views live in that page (no widget
module: nothing else mounts them).

**It coordinates work; it does not own the business operation.** Orders stay with `RAFOrderEngine` and money with
`RAFWallet`/`RAFCompensation`/`RAFSettlement`. Nothing here cancels an order, moves money or changes an address.
(Its delivery, driver and driver-conversation reads were removed with the deleted implementation.)

### 21.2 Departments (existing roles, chosen by the employee)
A department IS an existing RAF role, so no role was created and a department's members are that role's active
accounts: `customer_service` → customer_service, `logistics` → ops_manager, `finance` → finance,
`management` → higher_mgmt. super_admin belongs to no department and may act on any ticket.

**No automatic routing, round robin, load balancing or automatic assignment.** The employee chooses the responsible
department; any authorised employee of that department may work the ticket.

### 21.3 State is derived, never a mutable field
`support_tickets` holds the immutable facts at open. Status, priority, responsible department, assignment,
resolution and every timestamp are DERIVED from the append-only `support_activities` entries. Nothing is deleted;
an unlink is an append, not a removal.

Lifecycle (exactly these transitions): `new → open`, `open → pending`, `pending → open`, `open → resolved`,
`resolved → closed`, `closed → reopened`, `reopened → open`. Resolve requires a description, close requires a
resolved ticket, reopen requires a reason. **TRANSFERRED IS NOT A STATUS**: a transfer keeps the same ticketId,
customer, conversation, activities, tasks, follow-ups, relations and history, and records from/to department,
from/to employee, reason, actor and time.

### 21.4 Visibility is enforced by the read layer
Every activity carries `internal` or `customer_visible`. The customer read path returns customer-visible messages
only, and strips employee identity, department, reasons, tasks, escalations and field changes. Verified: with an
internal note, a Logistics note, a transfer reason, an escalation description and two tasks on a ticket, none of
those strings appears anywhere in the customer's own view of it.

### 21.5 Duplicate prevention (authority level)
A duplicate is the same PROBLEM, not the same customer and department: the key is
`customerId | responsibleDepartment | category | orderId`, and only an ACTIVE ticket blocks. Two different Finance
problems are two tickets; the same Finance problem reuses the existing one and the result carries its ticketId.
The race is closed by a deterministic guard entry `cs|new|<key>|<n>` appended before the ticket itself.

### 21.6 Tasks, follow-ups, escalation
Tasks are child records of one ticket (`support_tasks`), never a second ticket, and they perform no business
operation of their own. Follow-ups (`support_followups`) never resolve or close a ticket; a due follow-up is
noticed when the list is read and produces one idempotent notification — no timer, no polling. Escalation
(`support_escalations`) records a management-attention request on the SAME ticket; RAF approves no escalation
reason list, so the description carries the case.

### 21.7 SLA — NOT CONFIGURED
`support.firstResponseMinutes` and `support.resolutionMinutes` are registered with no approved and no prototype
value, so both report `not_configured`. Nothing produces a countdown, a "Near SLA" count or a breach; the dashboard
shows the NOT_CONFIGURED state instead of a number. Every ticket records the SLA state that applied at open, and a
later configuration change never rewrites that snapshot. `support.categories` holds the seven approved categories
(Arabic labels not approved yet).

### 21.8 Permissions (one new module, five keys)
No existing key expresses "may work a support case" — `orders.manage` is held by merchants, so reusing it would
have handed every store global Customer Service access. The `support` module adds
`support.view`, `support.create`, `support.manage`, `support.resolve`, `support.escalate` (35 → 40 catalogue keys).
Seeded roles reach them through `ROLE_MIGRATIONS`, the existing once-only mechanism:

| Role | Keys |
|---|---|
| customer_service | view · create · manage · resolve · escalate |
| ops_manager (Logistics) | view · manage |
| finance | view · manage |
| higher_mgmt, super_admin | all five |
| merchant, merchant_employee, marketing, driver, customer | none |

Ending the case and talking to the customer stay with Customer Service, which owns the customer relationship; a
destination department reads and works the case it receives. A customer needs no key at all: they reach their own
tickets through the session, proven from the record.

### 21.9 Storage, events, audit, notifications
Six registered `RAFRecordStore` collections, all append-only: `support_tickets`, `support_activities`,
`support_tasks`, `support_followups`, `support_relations`, `support_escalations`.
Ten registered `RAFEventBus` types in the new `support` domain (payloads carry ids only, never a message body).
Fourteen registered `RAFAudit` actions `ticket.*` (never on the merchant Timeline — a support case is RAF-internal,
not store history). Nine `RAFNotify` types: seven for the `support` audience (the department's own employees) and
two the customer sees, `support.ticket.message` and `support.ticket.resolved`.

### 21.10 Concurrency
Every racing transition is ONE append-only entry with a deterministic id (`cs|<ticketId>|claim|<n>`,
`cs|<ticketId>|status|<n>`, `cs|<ticketId>|transfer|<n>`, `esc|<ticketId>|<n>`, `<taskId>|completed`,
`<followUpId>|end`), so a second writer's append is refused as a duplicate. Each append is then READ BACK: a writer
is never told it succeeded when its entry is not in the store. Per-ticket work is additionally serialised with an
exclusive Web Lock (`raf-support:<id>`) where the browser has one, so the lifecycle writes return Promises.
Measured with Web Locks disabled and one frame's view of the store frozen (84 forced races): exactly one
authoritative outcome every time.

### 21.11 Customer 360
`customer360()` is a read-only projection. Each section names the authority it came from and stores nothing:
profile from `RAFPerm`, orders from `RAFShop.Orders` + `RAFOrderSnapshot` (recorded Promised ETA only), tickets from
this authority. A section RAF cannot read from the acting account says so rather than guessing — an employee sees
`WALLET_FORBIDDEN` for the wallet and `FORBIDDEN` for compensation, because `RAFWallet` answers only its own
signed-in customer and `RAFCompensation` requires its management permission. Proven read-only: every `raf_*` key is
byte-identical after a 360 read, a list, a search, a dashboard and a follow-up read. Only genuine read functions of
`RAFOrderEngine` are called (`deliveredAt`, `promisedEtaAt`); `driverPickedUp` RECORDS a milestone and is never
called from here.

### 21.12 Customer entry
`raf_support.html` is the customer surface for the three approved contexts: the customer's own context (their open
orders, order history and existing tickets), an ACTIVE order (`?order=<id>&ctx=active`) and an OLD order
(`?order=<id>&ctx=old`, which also lists the tickets previously opened for that order). `raf_tracking.html` and
`raf_order_details.html` carry the order into that page. The page's previously hardcoded sample ticket is gone.

### 21.13 PRODUCTION REQUIRED / prototype limits
* No transactions across the ticket, its activities, audit and notifications; the deterministic ids keep the
  OUTCOME single-valued, but two processes writing the same list at the same instant can still lose an append.
  Production needs a server store with conditional writes.
* Follow-up due times are evaluated on access, not by a scheduler: nothing fires while no authorised client is open.
* Knowledge is NOT_CONFIGURED — the navigation entry states that and shows no placeholder article.
* No attachment support: RAF has no media store for support cases, and none was invented.
* Customer 360 cannot show a wallet balance or compensation to an employee (§21.11). Opening either to Customer
  Service is a business decision that would change an approved rule in RAFWallet / RAFCompensation.
* Access is advisory, like every other RAF authority in this prototype: it is enforced in the browser.
