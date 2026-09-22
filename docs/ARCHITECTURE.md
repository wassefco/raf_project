# RAF Marketplace — Architecture Reference

## 1. Purpose

This document describes the permanent architectural structure and authoritative data boundaries of RAF Marketplace.

It is a reference for Claude Code and developers working on the project.

`CLAUDE.md` contains non-negotiable project rules.
This document contains deeper architectural details and authority boundaries.

---

## 2. Project Architecture

RAF is currently a 100% client-side static prototype.

Current characteristics:

- HTML
- CSS
- JavaScript
- Browser localStorage
- Client-side authentication/session handling
- Client-side authorization
- No application server
- No API server
- No database server
- No build system
- No package/runtime dependency requirement
- No CI/test runner

Production migration will require server-side:

- Authentication
- Authorization
- Transaction handling
- Durable database storage
- Server-side business rules
- Scheduling
- Realtime/event infrastructure
- Push notifications
- Payment integration
- Durable media storage
- Retention/encryption/erasure controls
- Production-grade audit persistence

Do not implement production infrastructure unless explicitly requested.

---

## 3. Authority Model

RAF uses layered authorities.

Do not create duplicate authorities for the same business concept.

Primary authority layers include:

- `RAFSource`
- `RAFShop`
- `RAFRules`
- `RAFPerm`
- `RAFOrderEngine`
- `RAFOrderSnapshot`
- `RAFStoreOps`
- `RAFInventory`
- `RAFAudit`
- `RAFWallet`
- `RAFCompensation`
- `RAFMerchantProducts`
- `RAFMerchantVariants`
- `RAFMerchantMedia`
- `RAFOrderChanges`
- `RAFMarketing`
- `RAFSettlement`
- `RAFConfig`
- `RAFStoreProfile`
- `RAFStoreSchedule`
- `RAFCustomerExperience`
- `RAFCustomerService`
- `RAFCustomerSupport`
- `RAFCO`
- `RAFMerchantPrefs`

Logistics/Delivery authorities are currently being rebuilt and must not be assumed to exist unless explicitly implemented and verified in the current codebase.

Communication channels are intentionally separate business domains:

- `RAFCustomerService` — Customer ↔ RAF ↔ administrative department; the central administrative ticket authority.
- `RAFCustomerSupport` — Merchant / Merchant Employee ↔ RAF Management; separate merchant support flow.
- `RAFCustomerExperience` — Customer ↔ Store; separate customer-experience flow for reviews and customer/store issues.

These three authorities must not be merged or treated as duplicate implementations of the same business concept.

Use the existing authority that owns the data or rule.

Do not create a second source of truth because existing data is inconvenient to access.

---

## 4. Authentication and Users

Current prototype authentication/session state is browser-based.

The current session is represented by:

`raf_current_user`

Canonical permission/session operations belong to `RAFPerm`.

Use:

- `RAFPerm.currentUser()`
- `RAFPerm.signOut()`
- `RAFSignOut()`
`RAFPerm.signOut()` ends the authenticated session. `RAFSignOut()` is the canonical shared UI action for signing out and returning to `raf_login.html` without allowing browser Back navigation to restore the signed-in page.
- existing permission helpers
- existing store helpers

Do not implement independent authentication logic inside individual pages.

Production authentication must move to a server-controlled identity system.

---

## 5. Store Model

RAF follows a single-store-per-merchant-account model.

The canonical merchant store identifier is:

`user.storeSlug`

Use:

- `RAFPerm.storeSlugOf(actorId)`
- `storeOf`
- `isMerchant`
- `storeLinkOf`

Always pass the actor's id when resolving store ownership. A store identity supplied by the caller, including a `storeSlug` written onto a user object, is never authoritative.

Do not infer a merchant's store from:

- page URL
- visible store name
- selected UI element
- localStorage value created by a page
- arbitrary query parameters

A merchant must only access data belonging to the merchant's authoritative `storeSlug`.

---

## 6. Authorization

Authorization is centralized through the existing RAF permission model.

Important rules:

- UI visibility is not authorization.
- URL manipulation must never bypass authorization.
- Pages must enforce authorization before exposing protected data.
- Do not create page-specific permission systems.
- Do not bypass existing permission helpers.
- Do not invent permission keys.
- Add a new permission key only when explicitly required.

Existing roles and permissions must be inspected before changing access rules.

---

## 7. Orders

Order authority is distributed across the existing order architecture.

Primary authorities include:

- `RAFOrderEngine`
- `RAFOrderSnapshot`
- `RAFStoreOps`
- `RAFOrderChanges`

Do not create another order state engine.

Order lifecycle states must come from authoritative RAF data.

Do not invent:

- order statuses
- timestamps
- payment states
- driver states
- ETAs
- merchant states
- fulfilment states

If authoritative information does not exist, display:

`—`

or the appropriate empty state.

---

## 8. Single Store Policy

RAF currently follows a Single Store Policy.

A customer cannot create a cart containing products from multiple stores.

Cross-store cart behavior must use the existing cart/business-rule implementation.

Do not implement alternative multi-store cart behavior inside individual pages.

---

## 9. Product and Inventory Authority

Product information must come from the existing product/catalog authorities.

Relevant authorities include:

- `RAFCatalog`
- `RAFMerchantProducts`
- `RAFMerchantVariants`
- `RAFMerchantMedia`
- `RAFInventory`

Do not hardcode product information into UI pages.

Do not duplicate product records into page-local data structures.

Important rules:

- Variant selection must use authoritative variants.
- Out-of-stock products must use authoritative inventory state.
- Sold-out products must not be addable.
- Closed-store products must not be presented as orderable.
- Promotion and price changes must use current authoritative values.

---

## 10. ETA and Time Concepts

RAF distinguishes between different time concepts.

### Merchant Promised ETA

This represents the merchant's promised preparation/fulfilment timing.

It is not the same as customer delivery ETA.

### Delivery ETA

This represents authoritative delivery timing when such delivery data exists.

Never display:

`promisedEtaAt`

as a delivery ETA.

Never calculate or fabricate a delivery ETA when authoritative delivery ETA data does not exist.

Use:

`—`

when delivery ETA is unavailable.

---

## 11. Audit Architecture

`RAFAudit` is the authoritative audit system.

Audit records are read-only historical records.

Rules:

- Never rewrite historical audit records.
- Never delete audit records as part of normal feature work.
- Do not create duplicate audit registries.
- Use existing audit APIs.
- Preserve actor, action, timestamp, source, reason, and metadata when available.

Technical/system events may exist in the audit record even when they are not appropriate for normal operational Activity views.

### Activity vs Audit

Normal Activity is an operational view.

Audit is the technical and historical record.

Examples of technical events that may belong in Audit rather than normal Activity:

- lock acquisition
- lock release
- lock expiry
- snapshot updates
- internal migration/system events
- technical inventory events

Do not delete these records merely because they are hidden from Activity.

---

## 12. Communication and Ticket Architecture

RAF has three intentionally separate communication domains. They are not duplicate implementations of the same business concept.

### RAFCustomerService

`RAFCustomerService` is the central administrative Customer Service ticket authority.

It represents:

`Customer ↔ RAF ↔ Responsible Administrative Department`

It coordinates customer-service tickets across administrative departments such as:

- Customer Service
- Logistics
- Finance
- Management
- Other administrative departments when explicitly implemented

The central ticket system owns the administrative ticket record and its related activities, tasks, follow-ups, escalations, and relations.

Rules:

- Issues and operational exceptions handled through the administrative support channel are Tickets.
- Do not create a separate Exceptions system.
- Do not create separate departmental ticket stores.
- Logistics tickets remain in the central ticket system.
- Logistics must not redirect its tickets to Customer Service.
- Ticket responsibility may change while preserving the same ticket and its history.
- Ticket transfer does not create a replacement ticket.
- Multiple tickets may exist for different problems.
- General tickets are allowed.
- The central ticket authority does not directly perform the business operation represented by a ticket.

Use:

`تعيين`

Do not use:

`إسناد`
`تخصيص`

### RAFCustomerSupport

`RAFCustomerSupport` is a separate merchant-support communication channel.

It represents:

`Merchant / Merchant Employee ↔ RAF Management`

It is **not** the central customer-service ticket system and is **not** Customer ↔ Store support.

Its records, storage, status model, permissions, and communication flow remain separate from `RAFCustomerService`.

Do not merge it into the central administrative ticket system unless explicitly requested.

### RAFCustomerExperience

`RAFCustomerExperience` is a separate customer-experience communication channel.

It represents:

`Customer ↔ Store`

It covers customer/store experience records such as:

- Reviews
- Customer issues related to their own order
- Merchant responses and related customer-experience history

It is not the central administrative ticket system.

It is not Merchant Support.

It does not represent Customer ↔ RAF administrative support.

Its records, storage, status model, permissions, and communication flow remain separate from `RAFCustomerService`.

### Separation Rule

The three authorities are intentionally separate:

- `RAFCustomerService` — Customer ↔ RAF ↔ administrative department
- `RAFCustomerSupport` — Merchant / Merchant Employee ↔ RAF Management
- `RAFCustomerExperience` — Customer ↔ Store

Do not merge these authorities, duplicate their responsibilities, or treat their separate storage and records as one shared ticket store.

The central administrative ticket system is owned by `RAFCustomerService`.

## 13. Logistics Architecture

The previous Logistics/Delivery prototype implementation was intentionally decommissioned.

Do not restore the deleted implementation unless explicitly requested.

Logistics is being rebuilt as a clean system using the current RAF architecture and authoritative data.

The Logistics area includes concepts such as:

- Logistics Management
- Orders
- Dispatch and Assignment
- Drivers
- Tickets
- operational reporting/settings when explicitly implemented

Do not revive deleted legacy modules simply because old code exists in Git history.

Do not recreate old Driver Performance, Delivery, Communication, or Reports implementations unless explicitly requested.

---

## 14. Logistics Data Rules

Logistics must never invent:

- driver assignments
- driver identity
- delivery ETA
- delivery milestones
- delivery zones
- GPS/proximity data
- distance
- SLA state
- operational state

If authoritative data is unavailable, show:

`—`

or an appropriate empty state.

Merchants must not receive driver private information.

When driver identity is legitimately available to an authorized operational surface, use only the required display identity.

Do not expose:

- private phone numbers
- email addresses
- account IDs
- unnecessary personal information

---

## 15. Logistics Filtering Architecture

All Logistics pages use the same filtering model.

### Standard pattern

`Search → Filter Button → Filter Applet`

The main search field remains visible.

The Filter button is attached to or integrated with the search area.

Clicking Filter opens one Filter Applet containing supported filters.

Do not create scattered filter dropdowns across the page.

Page-level scope tabs may remain outside the Filter Applet.

Only expose filters supported by authoritative data.

Examples of valid filters when data exists:

- status
- store
- payment
- from date
- to date

Do not invent filters for:

- driver
- zone
- distance
- SLA
- GPS
- proximity

unless authoritative data exists.

---

## 16. Navigation and Shared UI

Shared navigation should use the existing RAF navigation architecture.

Do not duplicate navigation logic unnecessarily.

Use existing:

- language handling
- authentication/session handling
- permission checks
- sign-out behavior
- navigation helpers
- shared styles where appropriate

Navigation must support:

- Arabic
- English
- RTL
- LTR
- responsive layouts

---

## 17. Configuration

Permanent configurable business values belong to RAFConfig, the existing RAF configuration authority.

Examples include:

- checkout reservation hold
- order cutoff
- ETA configuration
- temporary prototype locks

Do not scatter business constants throughout page files.

Current prototype values must not automatically be treated as production policy.

---

## 18. Event and State Updates

RAF currently uses browser-based storage/event mechanisms for cross-page updates.

Use existing event/storage infrastructure when available.

Do not introduce polling or timers merely to simulate realtime behavior unless explicitly required.

Production realtime behavior will require a server-side/event-driven architecture.

---

## 19. Storage Rules

Browser storage is part of the current prototype architecture.

RAFRecordStore is a storage boundary, not a business authority. It must not become a source of business rules.

Do not globally reset localStorage during QA or feature development.

Do not delete unrelated records to make a test pass.

When test data must be removed:

- identify the exact records
- remove only test records
- preserve seeded/demo data
- preserve historical audit data unless explicitly instructed otherwise

Storage keys should not be duplicated across modules.

---

## 20. Demo and Seed Data

RAF contains intentional demo/seed identities and data.

Important permanent driver identities currently include:

- `usr-014` — active Driver
- `usr-015` — suspended Driver

Merchant seed:

- `usr-010` → `casa-mode`

Do not invent additional permanent identities.

Do not change seeded business identities or assignments unless explicitly requested.

---

## 21. Legacy Code

Legacy code may contain historical authorities or unreachable branches.

Do not automatically restore, reuse, or expose legacy functionality.

Before modifying legacy code:

1. Determine whether it is still reachable.
2. Identify its current authority.
3. Check whether a newer authority replaced it.
4. Determine whether deleting/changing it affects active functionality.
5. Make the smallest required change.

Historical code is not automatically current architecture.

---

## 22. Production Migration Boundary

The prototype intentionally leaves several production concerns for later migration.

Known production migration areas include:

- server authentication
- server authorization
- transactional database operations
- durable audit storage
- scheduler
- realtime/event infrastructure
- push notifications
- durable notification storage
- payment gateway
- media storage
- retention
- encryption
- erasure
- multi-store relationship handling
- customer-support complaint authority
- OTP configuration
- escalation configuration
- telephony
- RAF Management interfaces
- event-driven operational updates
- translation provider
- build/test/CI infrastructure

Do not implement these as fake client-side versions merely to make the prototype appear production-ready.

---

## 23. Change Boundary

Before changing architecture:

1. Inspect the existing implementation.
2. Identify the authoritative source.
3. Check dependencies and consumers.
4. Check permissions.
5. Check storage keys.
6. Check navigation.
7. Check AR/EN behavior.
8. Check responsive behavior.
9. Make the smallest scoped change.
10. Verify affected surfaces.

Do not change unrelated architecture during a feature task.

If an architectural requirement is ambiguous, stop and ask rather than inventing a rule.

---

## 24. Architectural Principle

The core RAF principle is:

**One authoritative source for each business concept.**

UI pages consume authoritative data.

UI pages do not become authorities.

Business rules belong to the appropriate RAF authority.

Permissions belong to the authorization layer.

Audit history belongs to `RAFAudit`.

Administrative tickets belong to `RAFCustomerService`.

Orders belong to the order architecture.

Products and inventory belong to their respective authorities.

Logistics consumes authoritative operational data and must not invent unavailable operational facts.