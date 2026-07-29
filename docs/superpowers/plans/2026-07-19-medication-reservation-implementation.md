# Medication Reservation System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a repository-ready medication reservation system whose static frontend deploys to GitHub Pages and whose secure backend deploys as a Google Apps Script Web App backed by Google Sheets.

**Architecture:** A monorepo contains an independently deployed JavaScript-module frontend and Apps Script backend. Shared pure CommonJS modules make critical validation, status transitions, diffs, token hashing, and responsive state behavior executable under Node's built-in test runner before Apps Script integration.

**Tech Stack:** HTML5, CSS3, JavaScript ES modules, Node.js 20+, `node:test`, Google Apps Script V8, Google Sheets, MailApp, CacheService, LockService, PropertiesService, GitHub Actions, and `clasp`.

## Global Constraints

- The frontend must deploy from `frontend/` to GitHub Pages and contain no secret values.
- The backend must read `SPREADSHEET_ID`, `FRONTEND_BASE_URL`, `APP_SECRET`, `TOKEN_SIGNING_SECRET`, and `DEPLOYMENT_ENV` from Script Properties.
- StaffID and HN are strings everywhere; code must never call `parseInt()` or `Number()` on StaffID.
- HN must match `^07-\d{2}-\d{6}$` in both frontend and backend.
- Backend role and department checks are mandatory before every protected read or write.
- Staff list queries must filter by department before response construction.
- Submitted orders and items are never deleted; cancellation preserves original rows and creates logs.
- Every mutation has a request ID, idempotency check, optimistic Version check where applicable, and audit record.
- GET requests never mutate appointment state. Raw session and action tokens are never stored in Sheets.
- Patient data must not be stored in localStorage, sessionStorage, URLs, repository configuration, or static assets.
- Apps Script locks are held only for ID generation and critical reads/writes, never during email delivery.
- All datetimes use ISO strings for transport/storage and display in `Asia/Bangkok`.
- Responsive acceptance widths are 360, 390, 430, 768, 1024, 1280, and 1440 CSS pixels, including mobile/tablet portrait and landscape.

---

## Locked file map

### Repository/tooling

- `package.json`: Node test scripts, lint-like checks, and local static preview.
- `.gitignore`: local config, clasp credentials, coverage, and OS/editor artifacts.
- `.github/workflows/pages.yml`: build-free GitHub Pages artifact deployment from `frontend/`.
- `scripts/check-secrets.mjs`: reject secret-like values, Spreadsheet IDs, and forbidden PHI storage APIs.
- `scripts/check-links.mjs`: verify local HTML asset and navigation targets.

### Shared testable backend logic

- `backend/shared/constants.js`: roles, status values, error codes, editable fields, and master-data defaults.
- `backend/shared/validation.js`: normalization and order/HN/item validators.
- `backend/shared/status.js`: order/item transition guards and receiving status aggregation.
- `backend/shared/security.js`: constant-time comparison helpers, formula neutralization, HTML escaping, masking, and digests.
- `backend/shared/diff.js`: deterministic order and item field differences.

### Apps Script backend

- `backend/Code.gs`: `doGet`, `doPost`, `setupApplication`, and documented public entry points.
- `backend/ApiRouter.gs`: action registry, request envelope parsing, and safe exception mapping.
- `backend/ConfigService.gs`, `ResponseService.gs`, `SecurityService.gs`, `ValidationService.gs`: platform adapters around shared behavior.
- `backend/SchemaService.gs`, `SheetRepository.gs`: additive schema repair and header-based batch access.
- `backend/AuthService.gs`, `SessionService.gs`, `UserService.gs`, `AuthorizationService.gs`: trusted identity lifecycle.
- `backend/OrderIdService.gs`, `OrderService.gs`, `OrderItemService.gs`: multi-item CRUD-without-delete.
- `backend/AuditService.gs`, `ChangeLogService.gs`: immutable records.
- `backend/MasterDataService.gs`: cached settings and dropdown sources.
- `backend/EmailService.gs`: HTML/plain-text templates and delivery logging.
- `backend/AppointmentService.gs`, `ActionTokenService.gs`, `ReminderService.gs`, `TriggerService.gs`: scanner-safe appointment workflows.
- `backend/Tests.gs`: manual/integration runner with service doubles where Apps Script permits.
- `backend/appsscript.json`, `backend/.clasp.json.example`, `backend/README.md`: deployment metadata and operator guide.

### Frontend

- HTML pages named by the master prompt under `frontend/`.
- `frontend/css/variables.css`, `main.css`, `auth.css`, `dashboard.css`, `forms.css`, `order.css`, `admin.css`: layered responsive styles.
- `frontend/js/config.example.js`: documented deployment URL template.
- `frontend/js/config.js`: safe empty default that produces a setup message until configured.
- `frontend/js/api.js`, `auth.js`, `session.js`, `validation.js`, `master-data.js`, `ui.js`: shared application infrastructure.
- `frontend/js/medication-items.js`, `order-form.js`, `order-detail.js`, `edit-order.js`, `dashboard.js`, `admin.js`, `reschedule.js`, `appointment-action.js`: page workflows.
- `frontend/assets/logo-placeholder.svg`: non-sensitive accessible placeholder.

### Tests and documentation

- `tests/backend/*.test.js`: pure service contract tests.
- `tests/frontend/*.test.js`: frontend validators, storage policy, DOM-safe rendering helpers, and responsive invariants.
- `docs/architecture.md`, `docs/api.md`, `docs/deployment-checklist.md`, `docs/uat-checklist.md`, `docs/limitations.md`: operator and reviewer documentation.
- `README.md`: monorepo quick start and deployment order.

---

### Task 1: Repository foundation and executable quality gates

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `scripts/check-secrets.mjs`
- Create: `scripts/check-links.mjs`
- Test: `tests/tooling/repository.test.js`

**Interfaces:**
- Consumes: none.
- Produces: `npm test`, `npm run check:secrets`, `npm run check:links`, and `npm run verify` commands used by every later task.

- [ ] **Step 1: Write a failing repository contract test**

```js
// tests/tooling/repository.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('repository exposes all verification commands', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test tests/**/*.test.js');
  assert.ok(pkg.scripts['check:secrets']);
  assert.ok(pkg.scripts['check:links']);
  assert.ok(pkg.scripts.verify);
});
```

- [ ] **Step 2: Run the test and confirm the missing-file failure**

Run: `node --test tests/tooling/repository.test.js`  
Expected: FAIL because `package.json` does not exist.

- [ ] **Step 3: Add the minimal tooling contract**

```json
{
  "name": "medication-reservation-system",
  "version": "1.0.0",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "node --test tests/**/*.test.js",
    "check:secrets": "node scripts/check-secrets.mjs",
    "check:links": "node scripts/check-links.mjs",
    "verify": "npm test && npm run check:secrets && npm run check:links"
  }
}
```

Implement the secret checker to recursively scan tracked source extensions while excluding `.git`, reject private keys, hard-coded Script Property values, `localStorage`, and StaffID numeric conversion. Implement the link checker to parse `href`, `src`, and module imports in `frontend/` and assert every relative target exists.

- [ ] **Step 4: Run the tooling tests and checks**

Run: `node --test tests/tooling/repository.test.js && npm run check:secrets`  
Expected: PASS with a zero exit code.

- [ ] **Step 5: Commit the foundation**

```bash
git add package.json .gitignore scripts tests/tooling
git commit -m "chore: add repository verification gates"
```

### Task 2: Shared validation, statuses, security, and diffs

**Files:**
- Create: `backend/shared/constants.js`
- Create: `backend/shared/validation.js`
- Create: `backend/shared/status.js`
- Create: `backend/shared/security.js`
- Create: `backend/shared/diff.js`
- Test: `tests/backend/validation.test.js`
- Test: `tests/backend/status.test.js`
- Test: `tests/backend/security.test.js`
- Test: `tests/backend/diff.test.js`

**Interfaces:**
- Produces: `validateHn(value)`, `validateOrderPayload(payload, masterData, options)`, `canTransitionOrder(from, to)`, `canTransitionItem(from, to)`, `deriveReceivingOrderStatus(items)`, `escapeHtml(value)`, `neutralizeFormula(value)`, `maskHn(value)`, `maskPatientName(value)`, and `buildOrderDiff(current, proposed)`.
- Returns: validators return `{ valid: boolean, errors: Array<{field:string,message:string}> }`; diff returns immutable `{ scope, itemId, field, oldValue, newValue }[]`.

- [ ] **Step 1: Write failing boundary tests**

```js
test('HN preserves zeroes and rejects malformed input', () => {
  assert.equal(validateHn('07-01-000001'), true);
  for (const value of ['0712123456', '07-1-123456', '07-AA-123456']) {
    assert.equal(validateHn(value), false);
  }
});

test('submitted item cannot transition backward or disappear', () => {
  assert.equal(canTransitionItem('SUBMITTED', 'ORDERED'), true);
  assert.equal(canTransitionItem('RECEIVED', 'SUBMITTED'), false);
});

test('sheet formulas and HTML are neutralized', () => {
  assert.equal(neutralizeFormula('=IMPORTXML("x")'), "'=IMPORTXML(\"x\")");
  assert.equal(escapeHtml('<img onerror=x>'), '&lt;img onerror=x&gt;');
});
```

- [ ] **Step 2: Run tests and confirm missing-module failures**

Run: `node --test tests/backend/{validation,status,security,diff}.test.js`  
Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Implement complete pure contracts**

Use frozen constants for every status and allowlist from the design. Normalize strings without converting StaffID/HN to numbers. Validate item quantity as a finite positive numeric value while preserving its input field identity. Compare only allowlisted editable fields; sort item diffs by `OrderItemID` then field name for deterministic email/log output. Reject omission of any persisted submitted item.

- [ ] **Step 4: Run all shared-logic tests**

Run: `node --test tests/backend/*.test.js`  
Expected: PASS, including transition matrix, cancellation, receiving aggregation, masking, formula injection, and diff ordering.

- [ ] **Step 5: Commit shared contracts**

```bash
git add backend/shared tests/backend
git commit -m "feat: add validated medication order domain contracts"
```

### Task 3: Additive Google Sheets schema and repositories

**Files:**
- Create: `backend/SchemaService.gs`
- Create: `backend/SheetRepository.gs`
- Create: `backend/ConfigService.gs`
- Create: `backend/MasterDataService.gs`
- Create: `backend/appsscript.json`
- Test: `backend/Tests.gs`
- Test: `tests/backend/schema-contract.test.js`

**Interfaces:**
- Produces: `initializeDatabase()`, `ensureApplicationReady_()`, `getDatabaseHealth()`, `scheduledSchemaCheck()`, `getHeaderMap_(sheet)`, `readRecords_(sheetName, options)`, `appendRecords_(sheetName, records)`, `updateRecordByKey_(sheetName, keyName, keyValue, updates)`, `getSettings_()`, and `getMasterData_(types)`.
- Guarantees: missing sheets are created; only missing columns are appended; existing data and column order are preserved.

- [ ] **Step 1: Write failing static schema contract tests**

Test that every required sheet and exact required column from the master prompt appears in `SchemaService.gs`, and that the file contains no fixed column-number access for business fields.

- [ ] **Step 2: Run schema contract tests**

Run: `node --test tests/backend/schema-contract.test.js`  
Expected: FAIL because Apps Script schema files are absent.

- [ ] **Step 3: Implement schema repair and repository batches**

Define a frozen `SCHEMA_` object containing all required sheets and columns. Under one script lock, open the Spreadsheet ID from Script Properties, create missing sheets, initialize empty header rows, append only missing headers, set StaffID/HN columns to `@`, freeze and bold row one, and seed only missing Settings keys and MasterData type/code pairs. Cache readiness after success. Repository functions build indexes from current header strings and use range-level `getValues`/`setValues` calls.

- [ ] **Step 4: Run Node contracts and Apps Script checklist**

Run: `node --test tests/backend/schema-contract.test.js`  
Expected: PASS. `runSchemaTests()` in `Tests.gs` must cover missing sheet, missing column, repeated initialization, text formats, and preservation of sentinel rows.

- [ ] **Step 5: Commit schema subsystem**

```bash
git add backend/SchemaService.gs backend/SheetRepository.gs backend/ConfigService.gs backend/MasterDataService.gs backend/appsscript.json backend/Tests.gs tests/backend/schema-contract.test.js
git commit -m "feat: add additive sheets schema management"
```

### Task 4: API envelope, authentication, session, and authorization

**Files:**
- Create: `backend/Code.gs`
- Create: `backend/ApiRouter.gs`
- Create: `backend/ResponseService.gs`
- Create: `backend/SecurityService.gs`
- Create: `backend/ValidationService.gs`
- Create: `backend/AuthService.gs`
- Create: `backend/SessionService.gs`
- Create: `backend/UserService.gs`
- Create: `backend/AuthorizationService.gs`
- Test: `tests/backend/api-contract.test.js`
- Test: extend `backend/Tests.gs`

**Interfaces:**
- Consumes: Task 2 pure contracts and Task 3 repositories.
- Produces: `doPost(e)`, non-mutating `doGet(e)`, `routeApiRequest_(request)`, `login_(payload, requestId)`, `logout_(context)`, `requireSession_(token)`, `requireRole_(context, roles)`, and `requireOrderAccess_(context, order)`.

- [ ] **Step 1: Write failing API/auth contract tests**

Assert that every protected action is registered with an authentication requirement, mutating appointment actions are absent from GET routing, PIN hash format is versioned, and error serialization excludes `stack` and secrets.

- [ ] **Step 2: Confirm contract failures**

Run: `node --test tests/backend/api-contract.test.js`  
Expected: FAIL because API and auth files are absent.

- [ ] **Step 3: Implement trusted identity flow**

Parse POST bodies as JSON from a simple request body. Require action and requestId. Login must use `String(payload.staffId || '').trim()`, verify active user and PBKDF2 hash using constant-time comparison, create a random raw token, store only its SHA-256 hash, and return identity excluding PINHash. Protected routing derives identity from the stored session and active user on every request. Access denial uses one generic response for missing or foreign orders.

- [ ] **Step 4: Verify authentication and authorization**

Run: `node --test tests/backend/api-contract.test.js && npm run check:secrets`  
Expected: PASS. Apps Script `runAuthTests()` covers leading-zero StaffID, bad PIN, inactive user, expiry, logout, role tampering, and foreign-department denial.

- [ ] **Step 5: Commit identity subsystem**

```bash
git add backend/{Code,ApiRouter,ResponseService,SecurityService,ValidationService,AuthService,SessionService,UserService,AuthorizationService}.gs backend/Tests.gs tests/backend/api-contract.test.js
git commit -m "feat: add secure Apps Script authentication and routing"
```

### Task 5: Multi-item order creation, department lists, and detail reads

**Files:**
- Create: `backend/OrderIdService.gs`
- Create: `backend/OrderService.gs`
- Create: `backend/OrderItemService.gs`
- Create: `backend/AuditService.gs`
- Create: `backend/ChangeLogService.gs`
- Test: `tests/backend/order-contract.test.js`
- Test: extend `backend/Tests.gs`

**Interfaces:**
- Produces: `createOrder_(context, payload, requestId)`, `listDepartmentOrders_(context, query)`, `getOrderDetail_(context, orderId)`, `getStaffDashboard_(context, query)`, `generateOrderIds_(itemCount, now)`, `writeAudit_(entry)`, and `writeChanges_(entries)`.
- Idempotency key: authenticated StaffID plus `ClientRequestID`; repeated success returns the stored OrderID.

- [ ] **Step 1: Write failing order workflow tests**

Cover one item, multiple items, missing item, invalid master code, duplicate request, daily sequence formatting, unique item suffixes, staff department predicate, pagination cap, and detail lazy loading.

- [ ] **Step 2: Run and observe missing implementations**

Run: `node --test tests/backend/order-contract.test.js`  
Expected: FAIL for absent order services.

- [ ] **Step 3: Implement locked idempotent creation**

Validate before locking; under the lock recheck request log, allocate `MED-YYYYMMDD-NNNN`, create `-01` item suffixes, batch-append header and items, and record request/audit success. Roll back only append ranges whose exact rows and generated IDs still match; otherwise append a transaction-failure audit. Release the lock before new-order email. List queries filter trusted department before mapping summaries and never embed items.

- [ ] **Step 4: Verify creation and isolation**

Run: `node --test tests/backend/order-contract.test.js`  
Expected: PASS. Apps Script `runOrderTests()` includes two simulated sequential duplicate calls returning the same OrderID and a foreign department probe returning `ACCESS_DENIED`.

- [ ] **Step 5: Commit order creation**

```bash
git add backend/{OrderIdService,OrderService,OrderItemService,AuditService,ChangeLogService}.gs backend/Tests.gs tests/backend/order-contract.test.js
git commit -m "feat: add idempotent multi-item orders"
```

### Task 6: Versioned staff edits and cancellation

**Files:**
- Modify: `backend/OrderService.gs`
- Modify: `backend/OrderItemService.gs`
- Modify: `backend/ChangeLogService.gs`
- Modify: `backend/AuditService.gs`
- Test: `tests/backend/order-update-contract.test.js`
- Test: extend `backend/Tests.gs`

**Interfaces:**
- Produces: `updateOrderByStaff_(context, payload, requestId)`, `cancelOrderByStaff_(context, payload, requestId)`, `getOrderChangeLog_(context, orderId)`, and `getAppointmentHistory_(context, orderId)`.
- Requires: `payload.expectedVersion`; cancellation requires reason code and detail when code is `OTHER`.

- [ ] **Step 1: Write failing update tests**

Cover Version match/conflict, field allowlist, diff old/new values, submitted-item deletion rejection, new item ID allocation, invalid status, foreign department, cancellation without reason, `OTHER` without detail, and reminder exclusion after cancellation.

- [ ] **Step 2: Confirm failures before editing services**

Run: `node --test tests/backend/order-update-contract.test.js`  
Expected: FAIL because update/cancel handlers are not exported.

- [ ] **Step 3: Implement short-lock optimistic updates**

Authorize before lock, reload under lock, compare exact Version, compute backend diffs, reject submitted-item removal, write allowed changes and added items in batches, increment Version exactly once, append one change row per field and one audit summary, then release lock. Cancellation preserves every row, applies policy-driven `CANCEL_REQUESTED` or `CANCELLED`, records previous status, reason, actor, timestamp, and Version.

- [ ] **Step 4: Verify updates and immutable history**

Run: `node --test tests/backend/order-update-contract.test.js`  
Expected: PASS. Apps Script `runOrderUpdateTests()` confirms no email call occurs while a lock is held.

- [ ] **Step 5: Commit staff mutation workflows**

```bash
git add backend/OrderService.gs backend/OrderItemService.gs backend/ChangeLogService.gs backend/AuditService.gs backend/Tests.gs tests/backend/order-update-contract.test.js
git commit -m "feat: add versioned staff order updates"
```

### Task 7: Admin receiving and email workflows

**Files:**
- Create: `backend/EmailService.gs`
- Modify: `backend/OrderService.gs`
- Modify: `backend/ApiRouter.gs`
- Test: `tests/backend/email-contract.test.js`
- Test: `tests/backend/admin-contract.test.js`
- Test: extend `backend/Tests.gs`

**Interfaces:**
- Produces: `getAdminDashboard_(context, query)`, `listAllOrders_(context, query)`, `updateReceivedItems_(context, payload, requestId)`, `sendOrderEmail_(context, payload, requestId)`, `resendFailedEmail_(context, emailLogId, requestId)`, and `sendTemplatedEmail_(templateName, model, recipients)`.
- Email result: `{ result: 'SUCCESS'|'FAILED', sentAt, errorMessage }`; failures are logged and not thrown into completed business writes.

- [ ] **Step 1: Write failing admin/email tests**

Assert receiving aggregation, quantity/date/unit validation, staff rejection, admin department filtering, masked patient data, HTML escaping, plain-text fallback, changed-fields-only update email, failed delivery logging, and retry count increment.

- [ ] **Step 2: Run tests and confirm failures**

Run: `node --test tests/backend/{email,admin}-contract.test.js`  
Expected: FAIL because email/admin functions are absent.

- [ ] **Step 3: Implement independent delivery outcomes**

Update items and derived order status under Version protection. Deliver only after the mutation lock is released. Build new-order, updated, cancelled, medication-received, appointment-due, and rescheduled templates in both HTML and plain text; escape every interpolated value and mask configured patient identifiers. Log recipient, CC, subject, actor, result, safe error text, and retry count.

- [ ] **Step 4: Verify admin and email behavior**

Run: `node --test tests/backend/{email,admin}-contract.test.js`  
Expected: PASS. Apps Script `runEmailTests()` uses a delivery double and proves failed email does not revert received quantities.

- [ ] **Step 5: Commit admin workflows**

```bash
git add backend/EmailService.gs backend/OrderService.gs backend/ApiRouter.gs backend/Tests.gs tests/backend/email-contract.test.js tests/backend/admin-contract.test.js
git commit -m "feat: add admin receiving and email delivery"
```

### Task 8: Appointment tokens, confirmations, rescheduling, and triggers

**Files:**
- Create: `backend/ActionTokenService.gs`
- Create: `backend/AppointmentService.gs`
- Create: `backend/ReminderService.gs`
- Create: `backend/TriggerService.gs`
- Modify: `backend/Code.gs`
- Modify: `backend/ApiRouter.gs`
- Modify: `backend/EmailService.gs`
- Test: `tests/backend/appointment-contract.test.js`
- Test: extend `backend/Tests.gs`

**Interfaces:**
- Produces: `getAppointmentAction_(opaqueToken)`, `confirmPatientReceived_(payload, requestId)`, `submitPatientNoShow_(payload, requestId)`, `getRescheduleReference_(opaqueToken)`, `getRescheduleOrder_(context, reference)`, `submitAppointmentReschedule_(context, payload, requestId)`, `processAppointmentDueReminders()`, `retryFailedAppointmentReminders()`, `expireActionTokens()`, and `setupAppointmentReminderTrigger()`.

- [ ] **Step 1: Write failing appointment security tests**

Cover no GET mutation, token hash-only storage, expiry, replay, latest sequence, reminder tuple uniqueness, received confirmation, no-show reason rules, login-required reschedule, department mismatch, Version conflict, different non-past date, sequence increment, old-token revocation, and reminder eligibility for the new date.

- [ ] **Step 2: Run tests and confirm missing workflows**

Run: `node --test tests/backend/appointment-contract.test.js`  
Expected: FAIL because appointment services are absent.

- [ ] **Step 3: Implement scanner-safe appointment lifecycle**

Generate 256-bit opaque tokens and persist only SHA-256 hashes with token metadata. Public GET returns a minimal display model and never updates rows. POST rechecks token, status, sequence, expiry, and use state under a short lock. Reschedule resolves the reference only after login and same-department authorization, increments sequence and Version, revokes prior tokens, logs old/new dates and reason, and sends email after lock release. Trigger setup removes no unrelated triggers and creates its named handler only when absent.

- [ ] **Step 4: Verify appointment workflows**

Run: `node --test tests/backend/appointment-contract.test.js`  
Expected: PASS. Apps Script `runAppointmentTests()` verifies repeated GET leaves all business sheets unchanged and repeated POST is rejected or returns the stored idempotent result.

- [ ] **Step 5: Commit appointment subsystem**

```bash
git add backend/{ActionTokenService,AppointmentService,ReminderService,TriggerService,Code,ApiRouter,EmailService}.gs backend/Tests.gs tests/backend/appointment-contract.test.js
git commit -m "feat: add secure appointment reminder actions"
```

### Task 9: Frontend shell, API client, authentication, and accessibility base

**Files:**
- Create: all required `frontend/*.html` pages
- Create: `frontend/assets/logo-placeholder.svg`
- Create: `frontend/css/variables.css`
- Create: `frontend/css/main.css`
- Create: `frontend/css/auth.css`
- Create: `frontend/js/config.js`
- Create: `frontend/js/config.example.js`
- Create: `frontend/js/api.js`
- Create: `frontend/js/session.js`
- Create: `frontend/js/auth.js`
- Create: `frontend/js/ui.js`
- Test: `tests/frontend/page-contract.test.js`
- Test: `tests/frontend/storage-policy.test.js`

**Interfaces:**
- Produces: `apiRequest(action, payload, options)`, `createRequestId()`, `getSession()`, `saveSession(authResult)`, `clearSession()`, `requireAuth(options)`, `setLoading(element, active)`, `showFieldErrors(errors)`, `showToast(message, type)`, and `confirmAction(options)`.

- [ ] **Step 1: Write failing page and storage tests**

Assert every required page exists, all scripts use modules or defer, labels and landmarks exist, logo alt/fallback exists, no PHI/localStorage usage exists, StaffID input is type text with username autocomplete, and navigation identity placeholders are present.

- [ ] **Step 2: Confirm page contract failures**

Run: `node --test tests/frontend/{page-contract,storage-policy}.test.js`  
Expected: FAIL because frontend files are absent.

- [ ] **Step 3: Implement shell and authentication flow**

Create semantic page shells sharing skip link, header, nav, main, loading/error regions, and safe footer. API calls generate/reuse request IDs, submit a simple request body, normalize Apps Script redirect responses, handle timeouts, and redirect on `SESSION_EXPIRED`. Session storage contains only token, expiry, and non-PHI identity display values; logout clears it. If API URL is empty, show a Thai setup error instead of attempting a request.

- [ ] **Step 4: Run frontend base checks**

Run: `node --test tests/frontend/{page-contract,storage-policy}.test.js && npm run check:links`  
Expected: PASS with all page assets resolved.

- [ ] **Step 5: Commit frontend shell**

```bash
git add frontend tests/frontend/page-contract.test.js tests/frontend/storage-policy.test.js
git commit -m "feat: add accessible frontend shell and authentication"
```

### Task 10: Staff dashboard and medication order interfaces

**Files:**
- Create: `frontend/css/dashboard.css`
- Create: `frontend/css/forms.css`
- Create: `frontend/css/order.css`
- Create: `frontend/js/validation.js`
- Create: `frontend/js/master-data.js`
- Create: `frontend/js/medication-items.js`
- Create: `frontend/js/dashboard.js`
- Create: `frontend/js/order-form.js`
- Create: `frontend/js/order-detail.js`
- Create: `frontend/js/edit-order.js`
- Modify: `frontend/dashboard.html`
- Modify: `frontend/new-order.html`
- Modify: `frontend/order-detail.html`
- Modify: `frontend/edit-order.html`
- Test: `tests/frontend/order-ui.test.js`
- Test: `tests/frontend/dashboard-ui.test.js`

**Interfaces:**
- Produces: `formatHnInput(value)`, `validateOrderForm(model)`, `createMedicationItem(initial)`, `serializeMedicationItems(container)`, `loadDashboard(filters)`, `renderOrderSummary(order)`, and `submitOrder(model, clientRequestId)`.

- [ ] **Step 1: Write failing UI-state tests**

Cover HN auto-format/preservation, stable client keys, at least one item, dropdown code requirements, positive quantity, required prescriber, double-submit guard, 300 ms debounced search, card click filters, pagination, lazy detail load, and Version conflict presentation.

- [ ] **Step 2: Confirm UI module failures**

Run: `node --test tests/frontend/{order-ui,dashboard-ui}.test.js`  
Expected: FAIL because workflow modules are absent.

- [ ] **Step 3: Implement staff workflows without full reloads**

Load and cache only non-PHI master data. Render medication editors from safe DOM nodes keyed by generated client UUIDs. Disable submit during requests and reuse the same client request ID on network retry. Dashboard sends search/filter/sort/page to backend and renders only returned department summaries. Detail requests load items and logs only when opened. Edit submits expected Version and offers reload on conflict.

- [ ] **Step 4: Verify staff UI logic and links**

Run: `node --test tests/frontend/{order-ui,dashboard-ui}.test.js && npm run check:links`  
Expected: PASS.

- [ ] **Step 5: Commit staff frontend**

```bash
git add frontend/css frontend/js frontend/{dashboard,new-order,order-detail,edit-order}.html tests/frontend/{order-ui,dashboard-ui}.test.js
git commit -m "feat: add responsive staff reservation workflows"
```

### Task 11: Admin and appointment frontend workflows

**Files:**
- Create: `frontend/css/admin.css`
- Create: `frontend/js/admin.js`
- Create: `frontend/js/reschedule.js`
- Create: `frontend/js/appointment-action.js`
- Modify: `frontend/admin.html`
- Modify: `frontend/admin-order-detail.html`
- Modify: `frontend/reschedule.html`
- Modify: `frontend/appointment-action.html`
- Test: `tests/frontend/admin-appointment-ui.test.js`

**Interfaces:**
- Produces: `loadAdminDashboard(filters)`, `submitReceivedItems(model)`, `confirmAndSendOrderEmail(orderId)`, `loadAppointmentAction(token)`, `confirmAppointmentAction(model)`, `beginReschedule(reference)`, and `submitReschedule(model)`.

- [ ] **Step 1: Write failing admin/appointment UI tests**

Cover admin role guard, department filter, received quantity validation, send confirmation, failed-email retry state, token-only URL parsing, no action on page load, no-show conditional detail, reschedule login redirect, old date read-only display, required reason, and expected Version submission.

- [ ] **Step 2: Confirm missing workflow failures**

Run: `node --test tests/frontend/admin-appointment-ui.test.js`  
Expected: FAIL because admin and appointment modules are absent.

- [ ] **Step 3: Implement guarded workflows**

Admin pages require backend-confirmed ADMIN identity and send no trusted role claims. Appointment page loads a safe reference model and requires explicit confirmation before POST. Reschedule stores only the opaque reference across login, clears it after resolution, displays no PHI in URL, and submits expected Version plus reason. All destructive-looking actions use an accessible confirmation dialog and loading guard.

- [ ] **Step 4: Verify admin and appointment UI**

Run: `node --test tests/frontend/admin-appointment-ui.test.js && npm run check:links`  
Expected: PASS.

- [ ] **Step 5: Commit frontend completion**

```bash
git add frontend tests/frontend/admin-appointment-ui.test.js
git commit -m "feat: add admin and appointment web workflows"
```

### Task 12: Responsive verification and GitHub Pages deployment

**Files:**
- Create: `.github/workflows/pages.yml`
- Create: `tests/frontend/responsive-contract.test.js`
- Modify: all `frontend/css/*.css` as findings require
- Modify: all affected frontend HTML as findings require

**Interfaces:**
- Consumes: complete frontend from Tasks 9–11.
- Produces: deployable Pages artifact and verified viewport behavior.

- [ ] **Step 1: Write failing responsive and workflow contracts**

Assert viewport metadata, mobile-first media queries at 48rem and 64rem, table-to-card selectors, safe wrapping, 44 px control minimums, modal viewport bounds, visible focus, reduced-motion handling, and print-safe hiding. The Pages workflow must upload only `frontend/` and use official Pages actions pinned to major versions.

- [ ] **Step 2: Run responsive contracts before final CSS**

Run: `node --test tests/frontend/responsive-contract.test.js`  
Expected: FAIL for incomplete responsive selectors/workflow.

- [ ] **Step 3: Complete responsive layouts and workflow**

Implement stacked mobile navigation, labeled card rows using `data-label`, single-column medication fields below 48rem, two-column tablet forms, constrained desktop content, scroll-safe dialogs, touch targets, focus-visible outlines, and reduced motion. Configure GitHub Pages permissions, artifact upload from `frontend/`, and deploy on pushes to `main` plus manual dispatch.

- [ ] **Step 4: Perform viewport matrix verification**

Run automated command: `node --test tests/frontend/responsive-contract.test.js && npm run check:links`  
Expected: PASS.

Manual browser matrix: 360×800, 390×844, 430×932, 768×1024, 1024×768, 1280×800, and 1440×900. At each size verify login, collapsed navigation, dashboard cards/tables, multi-item add/remove and errors, order detail, modal focus/overflow, admin received-item form, appointment confirmation, and reschedule. Repeat core pages at 200% zoom and keyboard-only navigation; record results in UAT.

- [ ] **Step 5: Commit deployment and responsive completion**

```bash
git add .github/workflows/pages.yml frontend tests/frontend/responsive-contract.test.js
git commit -m "feat: deploy responsive app with GitHub Pages"
```

### Task 13: Documentation, deployment, UAT, and final verification

**Files:**
- Create: `README.md`
- Create: `backend/README.md`
- Create: `backend/.clasp.json.example`
- Create: `docs/architecture.md`
- Create: `docs/api.md`
- Create: `docs/deployment-checklist.md`
- Create: `docs/uat-checklist.md`
- Create: `docs/limitations.md`
- Modify: `backend/Tests.gs`

**Interfaces:**
- Produces: reproducible operator steps for Sheet creation, Script Properties, schema setup, initial user hashing, Web App deployment, frontend URL configuration, trigger setup, test execution, rollback, and GitHub Pages activation.

- [ ] **Step 1: Write a failing documentation contract test**

Add `tests/tooling/documentation.test.js` asserting that documentation names every required Script Property, all sheets, setup functions, scheduled jobs, deploy-as/access settings, CORS limitations, responsive matrix, manual UAT roles, known Sheets/Apps Script limitations, and rollback procedure.

- [ ] **Step 2: Confirm documentation gaps**

Run: `node --test tests/tooling/documentation.test.js`  
Expected: FAIL because handoff documents are absent.

- [ ] **Step 3: Write exact setup and operational guides**

Document backend-first deployment, `SPREADSHEET_ID` creation, random secret generation without committing output, Apps Script Web App execution identity and access choice, `setupApplication()`, initial user PIN hash generation, frontend API URL configuration, Pages workflow activation, trigger verification, email authorization, health check, test runner, UAT evidence, limitations, and future migration signals. State that Apps Script execution timing and CORS headers are constrained by the platform.

- [ ] **Step 4: Run the complete release gate**

Run: `npm run verify`  
Expected: all Node tests, secret scan, and link checks PASS.

Run: `git grep -nE 'SPREADSHEET_ID\s*[:=]\s*["'"'][A-Za-z0-9_-]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|localStorage' -- ':!docs/superpowers/**'`  
Expected: no output.

Run the Apps Script suites documented in `backend/README.md`: `runSchemaTests`, `runAuthTests`, `runOrderTests`, `runOrderUpdateTests`, `runEmailTests`, and `runAppointmentTests`. Record expected PASS rows in `docs/uat-checklist.md`; do not claim live integration success until an operator runs them against a test Sheet.

- [ ] **Step 5: Commit final documentation**

```bash
git add README.md backend/README.md backend/.clasp.json.example backend/Tests.gs docs tests/tooling/documentation.test.js
git commit -m "docs: add deployment and UAT handoff"
```

### Task 14: Final review and repository handoff

**Files:**
- Modify: only files required by verified findings.

**Interfaces:**
- Produces: clean `main` branch ready for a user-selected GitHub remote.

- [ ] **Step 1: Review acceptance-criteria traceability**

Map all 44 acceptance criteria from the master prompt to automated test names, Apps Script test functions, or exact UAT checklist rows. Add a missing test/check before marking any criterion covered.

- [ ] **Step 2: Run final verification from a clean state**

Run: `npm run verify && git status --short`  
Expected: verification PASS and no uncommitted files.

- [ ] **Step 3: Review commit history and deploy inputs**

Run: `git log --oneline --decorate --reverse`  
Expected: focused commits for design, plan, tooling, domain, schema, auth, order, update, admin/email, appointment, frontend, responsive deployment, and documentation.

- [ ] **Step 4: Provide push instructions without inventing a remote**

```bash
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

Do not execute these commands until the user supplies or authorizes the exact GitHub repository.

- [ ] **Step 5: Create a final review commit only if verification required changes**

```bash
git add <only-verified-fix-files>
git commit -m "fix: address final verification findings"
```
