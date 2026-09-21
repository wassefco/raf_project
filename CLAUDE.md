# RAF Marketplace — Claude Instructions

## 1. Project Identity

- This project is RAF Marketplace only.
- Never confuse it with Tejartk / تجارتك or any other project.
- Arabic is the primary language.
- Support Arabic and English with correct RTL/LTR behavior.
- Preserve RAF's established visual identity and terminology.

## 2. Non-Negotiable Rules

- Never invent data, requirements, business rules, system behavior, permissions, IDs, users, statuses, timestamps, prices, ETAs, drivers, payments, tickets, or operational states.
- Use authoritative RAF data as the source of truth.
- If authoritative data does not exist, show `—` or an appropriate empty state.
- Never present calculated, inferred, fallback, or placeholder data as authoritative.
- Do not create fake actions, fake success states, or fake operational records.
- Inspect existing code and architecture before making changes.
- Reuse existing RAF authorities and sources of truth.
- Never create duplicate authorities, duplicate data sources, or duplicate business rules.
- If a requirement is ambiguous, ask rather than invent.

## 3. Architecture & Business Logic

- Respect the existing RAF authority architecture.
- Before creating a new module, authority, data source, permission, or business rule, check whether an existing RAF authority already owns that responsibility.
- Do not change core business logic unless explicitly required.
- Do not remove existing functionality unless explicitly requested.
- Do not restore functionality that was intentionally deleted.
- Preserve existing working behavior.
- Make the smallest appropriate change and keep changes scoped to the requested task.

## 4. Security & Permissions

- Use the existing RAF authentication and permission architecture.
- Never bypass RAF permissions.
- Do not replace authoritative permission checks with ad-hoc role checks.
- URL parameters must never bypass authorization.
- UI visibility is not authorization.
- Respect authoritative merchant store ownership through the existing RAF store helpers.
- Never expose protected data or actions to unauthorized users.
- Do not create new permission keys unless explicitly required by the architecture.

## 5. Orders, Products & Inventory

- Use existing authoritative order, product, variant, inventory, pricing, promotion, payment, refund, and availability authorities.
- Do not invent order states, inventory states, or payment states.
- Preserve RAF's Single Store Policy and existing order business rules.
- Delivery ETA and merchant Promised ETA are different values.
- Never present `promisedEtaAt` as a delivery ETA.
- Show delivery ETA only when an authoritative delivery ETA exists; otherwise show `—`.
- Never fabricate stock, availability, prices, promotions, refunds, or order information.

## 6. Audit

- `RAFAudit` is the authoritative historical audit source.
- Audit records are read-only historical records.
- Never delete or rewrite historical audit records to hide previous behavior.
- Do not create duplicate audit registries.
- Technical events belong in the appropriate Audit / التدقيق view when required.
- Normal Activity views should contain only operationally relevant activity.
- Audit data must remain correctly scoped to its related entity.

## 7. Central Tickets

- RAF uses one central ticket system shared across administrative departments.
- Problems and exceptions belong to Tickets; do not create a separate Exceptions system unless explicitly requested.
- Do not create separate departmental ticket stores.
- Logistics tickets remain in the central ticket system and must not be redirected to Customer Service.
- Preserve the same ticket and its history when responsibility changes.
- Use **تعيين** for assignment; never use **إسناد** or **تخصيص** for this concept.

## 8. Logistics

- The previously deleted Logistics/Delivery implementation must not be restored.
- Rebuild Logistics only according to the current approved architecture.
- Use **التدقيق** for Audit.
- Use **تنبيه** instead of "يحتاج انتباهك".
- Use **تعيين** for assignment.
- Do not revive deleted Driver, Delivery, Performance, Reports, or Communication implementations unless explicitly requested.
- Never invent driver assignments, driver identities, delivery states, or delivery ETAs.
- If no authoritative driver exists, show `—`.
- Do not expose driver phone numbers, emails, account IDs, or other private driver information without explicit authorization.

### Logistics Filtering

All Logistics pages use:

**Search → Filter Button → Filter Applet**

- Keep the main search visible.
- The Filter button opens one Filter Applet.
- Supported filters belong inside that applet.
- Do not create scattered filter dropdowns or separate filter toolbars.
- Scope tabs may remain outside the applet.
- Do not add filters based on unavailable or non-authoritative data.

## 9. UI / UX

- Preserve RAF's visual identity and established UX patterns.
- Prefer clear operational interfaces over unnecessary complexity.
- Do not introduce generic admin-dashboard patterns that conflict with RAF.
- Maintain responsive behavior on desktop, tablet, and mobile.
- Maintain correct Arabic RTL and English LTR.
- Keep terminology consistent.
- Do not add controls that imply functionality that does not actually exist.
- Preserve existing navigation unless explicitly changing it.

## 10. QA

- QA discovery and fixing are separate unless a correction phase is explicitly requested.
- During pure QA/discovery, report issues without silently fixing them.
- During an explicit correction phase, fixes may be implemented and then re-tested.
- Never claim something passed QA without actually verifying it.
- Verify relevant:
  - Arabic / English
  - RTL / LTR
  - Responsive behavior
  - Navigation
  - Permissions
  - Data loading
  - Business rules
  - Console/runtime errors
- Do not invent test results.
- Do not treat one successful test as proof of an entire workflow.
- Clean temporary QA data surgically.
- Never use global storage resets as a QA-cleanup shortcut.
- Never delete unrelated historical data during QA cleanup.

## 11. Change & Git Discipline

Before changing code:

1. Inspect the relevant implementation.
2. Identify the responsible authority.
3. Confirm the authoritative data source.
4. Confirm the applicable business rules.
5. Reuse existing patterns where possible.
6. Make the smallest appropriate change.
7. Verify unrelated functionality was not affected.
8. Run relevant QA.
9. Report exactly what changed and what was verified.

Git rules:

- Do not commit automatically.
- Do not push automatically.
- Do not modify Git history unless explicitly instructed.
- The user controls commits and pushes.
- Never claim a commit exists unless it actually exists.

## 12. Reporting

- Be factual and concise.
- Separate implemented changes, QA findings, fixes, and unresolved issues.
- Never claim work was completed when it was not.
- Never hide limitations or unresolved issues.
- Distinguish verified behavior from expected or unverified behavior.