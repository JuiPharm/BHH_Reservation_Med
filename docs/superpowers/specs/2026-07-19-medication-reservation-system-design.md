# Medication Reservation System — Design Specification

Date: 2026-07-19  
Status: Approved design sections, pending final specification review by the user

## 1. Purpose

Build a production-oriented medication reservation web application for individually ordered medicines. The frontend is a static GitHub Pages application. The backend is a Google Apps Script Web App using Google Sheets as the datastore, Apps Script email services for notifications, and time-driven triggers for appointment reminders.

The system must preserve leading zeroes in StaffID and HN, enforce department isolation at the backend, support multi-item orders, prohibit deletion after submission, and provide versioned changes, immutable logs, idempotency, and auditable appointment actions.

## 2. Repository and deployment architecture

The project uses one repository with separate deployable applications:

```text
/
├── frontend/                 # GitHub Pages static application
├── backend/                  # Google Apps Script project
├── tests/                    # Cross-cutting automated tests
├── docs/                     # Architecture, API, deployment, and UAT
├── .github/workflows/        # GitHub Pages deployment
├── package.json
└── README.md
```

The frontend is deployed from `frontend/` through GitHub Actions. The backend is deployed independently using `clasp` or the documented manual Apps Script process. Repository files never contain credentials, Spreadsheet IDs, deployment IDs, session secrets, or signing secrets.

The frontend backend URL is public configuration, not a secret. It is set after backend deployment. All transport uses HTTPS.

## 3. Platform constraints and assumptions

### Non-negotiable requirements

- GitHub Pages hosts the frontend.
- Google Apps Script Web App hosts the API.
- Google Sheets stores application data.
- `SPREADSHEET_ID` is read only from Script Properties.
- StaffID and HN remain strings and Sheet columns use plain-text formatting.
- HN must match `^07-\d{2}-\d{6}$`.
- Backend authorization precedes every protected read or write.
- Staff list APIs query only their department; they never return all departments for client-side filtering.
- Submitted orders and items are never deleted.
- GET requests never change appointment status.
- Every important mutation is idempotent and version-aware.

### Operational assumptions

- The Apps Script deployment owner has permission to access the configured Sheet and send email.
- A department has a unique `DepartmentCode` and a managed recipient in `Departments`.
- Initial administrators and users are seeded or imported by an authorized operator after schema initialization.
- Apps Script daily triggers run within the configured hour, not at an exact minute.
- Google Sheets is not a transactional database. Critical writes use script locks, batch operations, compensating rollback where safe, and explicit failure logs.
- PINs use a versioned salted HMAC-SHA256 representation with `APP_SECRET` as a server-side pepper so verification performs bounded work within Apps Script runtime limits.

## 4. Frontend design

The frontend uses HTML5, CSS3, and JavaScript modules. Pages include login, staff dashboard, new order, order detail, edit order, reschedule, public appointment action, admin dashboard, admin order detail, unauthorized, and error pages.

Shared modules provide API calls, authentication guards, session handling, validation, master-data caching, medication item editing, UI state, dialogs, notifications, and safe DOM rendering. Patient data is held only in memory for the active page and is never persisted to localStorage or sessionStorage. Session storage may contain only the session token, expiry hints, and non-PHI master data.

Requests use a body compatible with Apps Script and avoid unnecessary CORS preflight. JSON is serialized under a simple content type and parsed by the backend. Every request, including public GET appointment links, includes a unique request ID; protected calls include a session token. Public links are minted with an opaque action token and a separate request ID query parameter. The frontend does not supply trusted role, department, requester email, or staff identity claims.

## 5. Responsive and accessibility requirements

Responsive behavior is a release requirement, not a visual enhancement.

- Target viewports: mobile at 360–430 px, tablet at 768–1024 px, and desktop at 1280 px and wider.
- Navigation collapses without hiding identity, department, or logout access.
- Dashboard tables become labeled cards on narrow screens; no patient field depends on horizontal scrolling.
- Medication item rows stack into field groups on mobile while preserving client-key identity and validation messages.
- Dialogs and forms fit within the viewport and remain keyboard usable.
- Interactive controls have a minimum 44 by 44 CSS-pixel touch target where practical.
- Focus indicators are visible. Labels are programmatically associated with inputs.
- Status is communicated through text and icons in addition to color.
- Zoom to 200 percent must not cause loss of content or function.
- Long names, medication text, IDs, and error messages wrap safely without layout breakage.
- Loading, empty, error, and offline/retry states are verified at all target widths.

Automated checks cover HTML and selected responsive invariants. Manual verification uses the target viewport matrix and covers navigation, tables/cards, order item editing, modals, validation, and admin workflows.

## 6. Backend component boundaries

Backend files are organized by responsibility:

- `Code.gs` exposes deployment entry points and application setup.
- `ApiRouter.gs` validates envelopes and dispatches actions.
- Authentication, session, user, and authorization services establish trusted identity.
- Order, item, ID, appointment, and reminder services implement business workflows.
- Validation and security services normalize and validate inputs, escape output, prevent formula injection, hash tokens, and redact errors.
- Sheet repository and schema services use header maps and batch reads/writes.
- Email, audit, change-log, request-log, response, configuration, cache, and trigger services provide infrastructure behavior.

Each service exposes a small documented interface and does not access frontend-provided role or department as an authority.

## 7. Authentication and authorization flow

Login receives StaffID as a trimmed string and verifies an active user. PIN verification uses the stored versioned salted hash. On success, the backend creates a cryptographically random token, stores only its hash, and returns the raw token once. Sessions record creation, expiry, last activity, and revocation state.

Each protected request hashes its presented token, checks active and idle expiry, reloads the user, and derives StaffID, role, email, and department from backend records. Logout revokes the session. Failed authorization returns a generic denial that does not confirm whether another department's order exists.

Admins may query all departments only through admin-authorized endpoints. Staff order retrieval always applies department criteria before the response is built.

## 8. Order write flow

### Create

1. Authenticate and derive the trusted user context.
2. Validate HN, required fields, item count, lengths, quantities, dates, and active master-data codes.
3. Check `ClientRequestID`/request log for an earlier successful response.
4. Enter a short script lock.
5. Recheck idempotency, generate the daily Order ID and item IDs, and batch-write one header plus all items.
6. Write request and audit records. If a later write fails, roll back appended rows when their exact ownership is proven; otherwise mark an explicit transaction failure.
7. Release the lock.
8. Send email and write its independent outcome to EmailLog.
9. Return the original Order ID for a repeated successful request.

### Update

1. Authenticate, load the order through an authorized repository query, and enforce role, department, status, and editable-field policy.
2. Enter a short lock and compare `expectedVersion` with the latest row.
3. Backend computes field differences and rejects deletion or disappearance of submitted items.
4. Batch-write allowed changes, increment Version, and append change and audit records.
5. Release the lock, invalidate caches, and send a change email containing only actual differences.

Email failure never reverses a successful business update. It creates a failed EmailLog entry eligible for controlled retry.

## 9. Status model

Backend transition functions are the only authority for status changes. Unsupported transitions return `INVALID_STATUS_TRANSITION`.

### Order transition matrix

| Current | Allowed next states | Principal workflow |
|---|---|---|
| SUBMITTED | UNDER_REVIEW, ORDERED, CANCEL_REQUESTED, CANCELLED, REJECTED | Review or cancel |
| UNDER_REVIEW | ORDERED, PARTIALLY_RECEIVED, RECEIVED, CANCEL_REQUESTED, CANCELLED, REJECTED | Admin processing |
| ORDERED | PARTIALLY_RECEIVED, RECEIVED, CANCEL_REQUESTED, CANCELLED | Receiving or cancel |
| PARTIALLY_RECEIVED | RECEIVED, PARTIALLY_CANCELLED, CANCEL_REQUESTED, CANCELLED | Remaining items |
| RECEIVED | NOTIFIED, CANCEL_REQUESTED, CANCELLED | Notify department |
| NOTIFIED | PATIENT_RECEIVED, PATIENT_NO_SHOW, APPOINTMENT_RESCHEDULED, CANCEL_REQUESTED | Appointment response |
| PATIENT_NO_SHOW | APPOINTMENT_RESCHEDULED, PATIENT_RECEIVED, CANCEL_REQUESTED | Follow-up |
| APPOINTMENT_RESCHEDULED | NOTIFIED, PATIENT_RECEIVED, PATIENT_NO_SHOW, CANCEL_REQUESTED | New appointment cycle |
| CANCEL_REQUESTED | CANCELLED, CANCEL_REJECTED | Cancellation decision |
| CANCEL_REJECTED | UNDER_REVIEW, ORDERED, PARTIALLY_RECEIVED, RECEIVED, NOTIFIED | Resume prior eligible workflow |
| PARTIALLY_CANCELLED | RECEIVED, NOTIFIED, COMPLETED | Continue remaining items |
| PATIENT_RECEIVED | COMPLETED | Completion policy |
| CANCELLED | none | Terminal |
| COMPLETED | none | Terminal |
| REJECTED | none | Terminal |

The service records the prior active status when entering `CANCEL_REQUESTED`, allowing `CANCEL_REJECTED` to resume only a valid prior state. Settings may permit direct staff cancellation; otherwise the request waits for admin approval.

### Item transition matrix

| Current | Allowed next states |
|---|---|
| SUBMITTED | UNDER_REVIEW, ORDERED, PARTIALLY_RECEIVED, RECEIVED, CANCEL_REQUESTED, CANCELLED |
| UNDER_REVIEW | ORDERED, PARTIALLY_RECEIVED, RECEIVED, CANCEL_REQUESTED, CANCELLED |
| ORDERED | PARTIALLY_RECEIVED, RECEIVED, CANCEL_REQUESTED, CANCELLED |
| PARTIALLY_RECEIVED | RECEIVED, CANCEL_REQUESTED, CANCELLED |
| RECEIVED | COMPLETED, CANCEL_REQUESTED, CANCELLED |
| CANCEL_REQUESTED | CANCELLED, previous valid state after rejection |
| CANCELLED | none |
| COMPLETED | none |

Order status is recalculated from item states for receiving workflows. No item row is removed or hidden as a substitute for cancellation.

## 10. Appointment workflow

The daily reminder job selects due orders that are eligible and have not logged the tuple `OrderID + AppointmentSequence + ReminderType`. It creates opaque random tokens, stores only hashes, and sends received, no-show, and reschedule links without PHI in URLs.

GET validates enough token metadata to render a confirmation or form but performs no mutation. Confirmation POST revalidates token, latest status, sequence, expiry, and replay state before changing data and marking the token used.

Reschedule always redirects to GitHub Pages login with only an opaque reference. After login, backend authorization requires the same department, loads the order, enforces expected Version, validates a different non-past date for staff, increments AppointmentSequence, revokes old tokens, records old/new dates and reason, and sends a reschedule email. The new sequence receives a new reminder on its due date.

## 11. Data model and schema behavior

Required sheets and columns follow the master prompt exactly: Users, Departments, OrderHeaders, OrderItems, OrderChangeLog, EmailLog, AuditLog, Settings, MasterData, Sessions, RequestLog, AppointmentResponseLog, AppointmentReminderLog, and ActionTokens.

Schema initialization reads `SPREADSHEET_ID` from Script Properties, uses a lock, creates missing sheets, writes headers only to empty sheets, and appends missing columns to the right. It never removes, renames, reorders, or overwrites an existing column. StaffID and HN columns receive plain-text number formats. Header rows are frozen and styled. Settings and master data are seeded by missing key/code only. Full schema validation runs during setup and scheduled checks, not on every API call.

Repositories resolve indexes from current header names for every batch and never depend on fixed numeric positions.

## 12. API contract

`doPost` accepts an envelope containing `action`, `requestId`, optional `sessionToken`, and `payload`. Actions match the master prompt: authentication, master data, staff and admin dashboards, order CRUD-without-delete, change/history reads, received item updates, email sending/retry, public appointment confirmation, authenticated reschedule, and database health. Initialization is not an HTTP action.

`doGet` accepts only explicitly registered non-mutating public actions and requires `action` plus `requestId` query parameters. Database setup and schema repair are explicit operator maintenance in the Apps Script editor or scheduled operations; they are not HTTP actions, and request entry points never initialize or repair Sheets. LOGIN intentionally creates a new session for each successful request and is exempt from business-mutation replay because raw session tokens are returned only once and are never stored for replay.

Responses use one standard shape:

- Success: `success`, `message`, `data`, `requestId`.
- Failure: `success: false`, safe `message`, stable `errorCode`, optional field `errors`, and `requestId`.

List endpoints paginate, cap page size, return only summary fields, and load items only from the authorized detail endpoint. Search parameters are normalized and length-limited.

## 13. Security controls

- Salted HMAC PIN records and one-time raw session token return.
- SHA-256 hashes for stored session and opaque action tokens.
- Backend role and department derivation on every protected request.
- Strict field allowlists and server-side validation.
- Safe DOM creation and HTML escaping for web and email templates.
- Formula-injection neutralization for Sheet-bound user strings beginning with `=`, `+`, `-`, or `@` while preserving StaffID and HN as text.
- Request size, page size, field length, and retry limits.
- Version checks plus short locks for concurrent writes.
- RequestLog-based idempotency for important operations.
- No PHI in URLs, browser persistence, deployment configuration, or unnecessary list responses.
- Safe errors without stack traces or secret values.
- Audit, change, email, request, reminder, and appointment response logging.

Apps Script cannot expose arbitrary CORS behavior like a conventional server. The implementation uses simple cross-origin requests that Apps Script can receive, documents redirect behavior, and validates the configured frontend origin/reference where platform signals permit. Origin checks are defense in depth, not a replacement for session and authorization checks.

## 14. Error handling

- Field failures return `VALIDATION_ERROR` with field paths.
- Expired or revoked sessions return `SESSION_EXPIRED`; frontend clears storage and redirects to login.
- Version mismatches return `ORDER_VERSION_CONFLICT` and never overwrite newer data.
- Cross-department requests return `ACCESS_DENIED` without existence disclosure.
- Invalid state changes return `INVALID_STATUS_TRANSITION`.
- Duplicate successful mutations return the stored result for the same request ID.
- Email failure is logged and retryable without rolling back business state.
- Network retry reuses the same request ID.

## 15. Testing and release verification

Node's test runner validates pure validation, formatting, transition, diff, security, and frontend state logic. An Apps Script test harness validates integrations with Sheets, properties, locks, caches, and email substitutes.

Coverage includes leading-zero StaffID, HN formats, inactive users, session expiry, department isolation, multi-item creation, request replay, ID uniqueness, field requirements, active master codes, item deletion rejection, Version conflict, change diffs, cancellation reasons, reminder uniqueness, token replay, scanner-safe GET, reschedule authorization, sequence increment, schema repair, and data preservation.

Release verification includes:

1. Syntax and unit tests.
2. Apps Script test harness instructions and results checklist.
3. Secret and hard-coded Spreadsheet ID scan.
4. Internal link and static asset verification.
5. Responsive checks at 360, 390, 430, 768, 1024, 1280, and 1440 CSS pixels.
6. Portrait and landscape checks for mobile/tablet.
7. Keyboard-only navigation and 200-percent zoom checks.
8. Manual UAT for staff, admin, email, reminder, and reschedule flows.

## 16. Deliverables

The repository will include complete frontend and Apps Script source, GitHub Pages workflow, schema initialization, email templates, trigger functions, automated tests, Apps Script test harness, architecture/API documentation, frontend and backend setup instructions, deployment checklist, manual UAT checklist, limitations, and future recommendations.

The first implementation targets the complete required workflow. Optional enhancements not needed by the acceptance criteria are deferred to avoid expanding the initial security and operational surface.
