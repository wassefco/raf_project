---
name: raf-qa
description: Use for QA, verification, regression testing, and defect discovery in RAF Marketplace. Keep QA separate from fixing unless a correction phase is explicitly requested.
---

# RAF QA

## Purpose

Perform structured QA of RAF Marketplace features, pages, workflows, permissions, data integrity, and responsive behavior.

## QA Rules

- Inspect the existing implementation before testing.
- Test the actual current implementation; do not assume behavior from requirements alone.
- Do not invent test results.
- Do not claim a workflow passed unless it was actually verified.
- QA discovery is read-only unless a correction phase is explicitly requested.
- During discovery, report defects instead of silently fixing them.
- If a correction phase is requested, fix only the identified defects and re-test them.
- Never use global storage resets as a QA shortcut.
- Clean temporary QA data surgically and preserve unrelated or historical data.

## Test Coverage

When applicable, verify:

1. Functional behavior
2. Business rules
3. Data integrity
4. Permissions and authorization
5. Navigation and routing
6. Arabic and English
7. RTL and LTR
8. Desktop, tablet, and mobile responsiveness
9. Browser console/runtime errors
10. Empty states and unavailable data
11. Existing functionality affected by the change
12. Security boundaries and unauthorized access

## Data Integrity

- Use authoritative RAF data.
- Never create fake production-like records to make a test pass.
- If test data is required, create it through the existing authoritative mechanism when possible.
- Clearly distinguish seeded data, QA data, and real application data.
- Remove only the temporary records created for the QA run.
- Never delete unrelated historical audit, order, ticket, or user data.

## Permissions

For protected pages and actions:

- Test an authorized identity.
- Test an unauthorized identity when relevant.
- Verify that direct URL access cannot bypass authorization.
- Verify that protected data is not rendered before authorization is established.
- Verify that UI visibility and actual authorization are consistent.

## Responsive QA

When relevant, test representative widths across:

- Mobile
- Tablet
- Desktop

Check for:

- Horizontal overflow
- Clipped content
- Broken wrapping
- Hidden controls
- Unusable touch targets
- RTL/LTR alignment problems
- Modal, sheet, applet, and table behavior

## Regression

After a change:

- Verify the requested feature.
- Verify closely related functionality.
- Verify that shared authorities and components were not unintentionally affected.
- Do not expand the regression scope unnecessarily.

## Reporting

Report:

- What was tested
- What passed
- What failed
- Exact reproduction conditions
- Severity when objectively justified
- What was fixed, if a correction phase occurred
- What was re-tested
- What remains unverified

Clearly separate:

- Verified behavior
- Defects
- Expected but unverified behavior
- Limitations

Never hide unresolved issues.