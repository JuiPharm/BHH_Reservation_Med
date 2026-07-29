# UAT evidence checklist

Record the operator, date/time, test Sheet identity under local evidence controls, result, and any issue reference. Do not place patient information, raw PINs, tokens, Sheet IDs, or production URLs in this document. All Apps Script rows below are **expected PASS / pending operator run**, not claims that live integration suites have passed.

| Suite | Expected result | Current evidence status |
| --- | --- | --- |
| AS-01 `runSchemaTests` | PASS on its disposable test Sheet | Pending operator run |
| AS-02 `runAuthTests` | PASS with test users only | Pending operator run |
| AS-03 `runOrderTests` | PASS; intentional email failure is logged safely | Pending operator run |
| AS-04 `runOrderUpdateTests` | PASS | Pending operator run |
| AS-05 `runEmailTests` | PASS; failed-delivery behavior is verified safely | Pending operator run |
| AS-06 `runAppointmentTests` | PASS on its disposable test Sheet | Pending operator run |

## Responsive, zoom, and keyboard matrix

**RM-01:** For both portrait and landscape where applicable, test logged-out, staff, and admin screens at 360, 390, 430, 768, 1024, 1280, and 1440 CSS-pixel widths. At every width verify loading, empty, error/retry, long Thai/English text, navigation, forms, order items, tables/cards, dialogs, and no horizontal loss of controls. At 200% zoom verify reflow and readable controls. Complete keyboard-only navigation: visible focus, logical tab order, form errors, dialog open/close, submit/cancel, and no keyboard trap. The retained [partial rendered-browser record](responsive-verification.md) covers mocked local frontend behavior only and does not prove the full keyboard-only flow; this live UAT row remains required.

## Role and action flows

- **FL-01 Staff:** sign in with a test account; confirm protected read activity slides the browser/server idle deadline and inactivity expires it; create a multi-item order; view detail; make an unrelated edit and prove a non-empty requester phone is preserved; submit both a normal and bounded `OTHER` cancellation; verify department isolation with a separate department test account. Confirm explicit logout/terminal expiry clear any opaque reschedule handoff, while the deliberate immediate login handoff still works.
- **FL-02 Admin:** sign in; review cross-department dashboard/list; record received items; enable admin cancellation approval in the test environment and exercise both versioned/idempotent approve and reject controls; verify rejection restores exact prior order/item state and only eligible request-owned tokens. Verify version/conflict feedback, change history, health access, and non-admin denial.
- **FL-03 Email:** authorize the deployment owner, send a controlled non-PHI notification, inspect `RequestLog`, `EmailLog`, and `AuditLog`, and prove preparation/delivery/finalization failures do not reverse or misreport a committed create/update/cancel. Replay pending preparation failures and prove no duplicate delivery; retain an uncertain send for manual reconciliation.
- **FL-04 Reminder:** verify one `processAppointmentDueReminders` trigger, configured local hour/timezone, duplicate-reminder protection, action-link expiry, and trigger failure evidence.
- **FL-05 Reschedule:** use a test appointment action link; require staff sign-in; verify department authorization, reason handling, idempotent retry behavior, and history/audit entries.

## Acceptance evidence

- [x] AG-01 Node release gate (`npm run verify`) captured in the Task 14 repository review; it is not live deployment evidence.
- [x] AG-02 Secret grep and `git diff --check` captured with no violations in the Task 14 repository review; it is not live deployment evidence.
- [ ] AG-03 Six Apps Script suite results captured from a test Sheet.
- [ ] AG-04 Web App identity/access configuration reviewed.
- [ ] AG-05 Pages `APPS_SCRIPT_URL` validation and generated configuration observed.
- [ ] AG-06 Responsive matrix, 200% zoom, and keyboard-only checks completed.
- [ ] AG-07 Staff, admin, email, reminder, and reschedule action flows signed off.
- [ ] AG-08 Rollback rehearsal or approved rollback review recorded.
- [ ] AG-09 Login throttling and editor-only identity/global unlock recovery exercised with generic safe responses.
