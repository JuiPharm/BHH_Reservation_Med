# Task 7 — Admin Receiving and Email Workflows

Implemented on `feature/medication-reservation`.

- Admin-only all-department dashboard/list endpoints filter by department, status, and order ID, with page limits and non-PHI list rows.
- Receiving validates request shape, exact `Version`, owned item IDs, calendar dates, quantities, units, and item status. It updates items, derives the order status, creates immutable change/audit/request rows, and releases the lock before mail delivery.
- Email delivery has exact named templates for new orders, updates, cancellation, medication received, appointment due, and rescheduling. It provides HTML plus plain text, masks HN/patient names, escapes HTML interpolations, logs recipient/CC/subject/actor/result/safe error/retry count, and supports failed-log retry.
- `runEmailTests()` is an Apps Script smoke test using a blank recipient as a delivery failure double; it proves a failed notification does not undo received quantities or status.

Verification: `npm run verify` passed (70 Node tests, secret scan, link scan). Apps Script tests require an operator to run `runEmailTests()` against a disposable Sheet after deployment.

## Review follow-up

- Delivery now traps template, recipient, MailApp, and EmailLog failures; an EmailLog storage failure audits and returns a failed result without fabricating a log ID.
- Explicit send requires `expectedVersion`, is idempotent, changes only `RECEIVED` orders to `NOTIFIED` under a lock, and delivers after unlocking.
- A retry preserves the failed source log and appends a new attempt with an incremented retry count. Retry content rebuilds change/appointment details from immutable history.
- Recipient parsing accepts one validated address per To/CC field; the notification helper resolves persisted requester/department recipients and wraps post-commit delivery safely.
- Receiving rejects terminal-state reopening, validates active unit codes where master data is available, and derives mixed cancelled orders as `PARTIALLY_CANCELLED`.

## Final delivery state-machine follow-up

- `SEND_ORDER_EMAIL` now reserves a `PENDING` EmailLog attempt and immutable `EMAIL_SNAPSHOT` under the lock, performs delivery unlocked, and only then finalizes `RECEIVED → NOTIFIED` on success. Failed delivery leaves the order received and marks notification failed.
- Repeated sends with the same request are terminal replays; a stranded pending request returns `EMAIL_DELIVERY_PENDING` rather than sending again. Retry rejects superseded attempts.
- Appointment links must be nonblank HTTPS URLs and provider failures are recorded with stable `EMAIL_DELIVERY_FAILED` codes only.

Verification: `npm test` passed 74 tests in the final review pass; `npm run verify` remains the release gate.

## Final blocker remediation

- Every email path now reserves a `PENDING` EmailLog plus an immutable `EMAIL_SNAPSHOT` before delivery. Snapshots preserve the original event actor, event time, order version, diffs, items, and template-specific fields; retries render from that stored snapshot rather than mutable order rows.
- Medication-received delivery uses a durable finalization request. A terminal `SUCCESS` EmailLog resumes `RECEIVED → NOTIFIED` under lock without another MailApp call, while `FAILED` preserves the committed receive state and exposes explicit retry eligibility. Header, change-log, audit, and request-log stages are idempotent, including recovery from a partial header write and a failed terminal EmailLog update.
- Retry chains are scoped by root EmailLog identity (with the specified ChangeSet/Order/EmailType fallback), so unrelated events of the same type cannot supersede one another. A successful medication-received retry sets `NotificationStatus=SUCCESS` and finalizes the order.
- Every retry re-resolves current managed recipients. `APPOINTMENT_DUE` routes to the active Departments email/CC, and resolver failures append a terminal FAILED EmailLog and operational audit.
- Template rendering now gates fields, diffs, item lists, and action links by EmailType. `ORDER_UPDATE` never renders a general item list; item changes appear only as diffs. Appointment links use strict HTTPS validation, and received units fail closed against active UNIT master data.

Executable regression coverage includes exact snapshot loading/fidelity, event-root chain grouping, successful received retry finalization, pending reconciliation with a delivery-call counter, every post-delivery finalization stage, partial header recovery, terminal EmailLog recovery, department routing/resolver audit, invalid HTTPS URLs, active unit validation, and cancellation transition enforcement.

Final verification on 2026-07-19:

- `node --test tests/backend/admin-contract.test.js tests/backend/email-contract.test.js` — 32 passed, 0 failed.
- `npm run verify` — 98 tests passed, 0 failed; secret scan passed; link scan passed.
- Apps Script integration harness remains operator-run: `runEmailTests()` now also validates the persisted snapshot's original version, actor, and items against a disposable Sheet.

## Crash, concurrency, and strict-contract remediation

- A fully received mutation reserves its durable `FINALIZE_RECEIVED_EMAIL` request, `PENDING` EmailLog, and immutable `EMAIL_SNAPSHOT` under the business lock before its RequestLog becomes successful. Email preparation failure is notification failure only: received quantities, status, version, and history remain committed while notification state and audit are marked failed best-effort.
- Delivery follows an at-most-once boundary: `PENDING` means not started, an exact attempt is claimed as `SENDING` under lock, and `MailApp` runs only after lock release. A stranded `PENDING` attempt may be claimed and sent once; `SENDING` is never auto-sent again.
- `SENDING` without terminal `SUCCESS`/`FAILED` evidence returns `EMAIL_DELIVERY_UNCERTAIN`. This deliberately requires manual administrator reconciliation because the system cannot distinguish a crash before the provider accepted mail from a crash after external success.
- Replay repairs a committed receiving mutation whose business RequestLog was interrupted. Incomplete finalizer/log/snapshot preparation is terminalized as `PREPARATION_FAILED` without sending or rolling back the received state. Cleanup keeps the full Action/StaffID/RequestID/OrderID composite identity and never falls back to RequestID-only updates.
- Retry validates the latest root attempt and current order version/status compatibility under lock before claiming `SENDING`; cancellation or another transition rejects the stale retry without a delivery call.
- Explicit send and resend preparation stores the immutable snapshot in the orchestration request, persists `EMAIL_SNAPSHOT` before EmailLog, and advances discoverable `REQUESTED → SNAPSHOT_READY → ATTEMPT_READY` phases through the full Action/StaffID/RequestID/OrderID key. Replay repairs interruption after any phase without creating another attempt or delivery.
- A business-success receiving replay always inspects its linked finalizer. If preparation-failure completion was interrupted, replay retries the exact composite completion and returns `EMAIL_DELIVERY_PENDING` until it is durable; it never silently reclassifies the failure or sends.
- A terminal successful or failed delivery followed by a legitimate concurrent order change completes the email RequestLog with an audited `DELIVERED_STATE_NOT_UPDATED` or `DELIVERY_FAILED_STATE_NOT_UPDATED` outcome. It preserves the newer status, version, change marker, and notification state.
- Managed Users and Departments are trusted only when normalized `Active` is exactly `TRUE`. Appointment-due emails contain only the six required fields and three actions, with no medication lines; cancellation emails retain `Cancelled by` and omit the extra actor field.
