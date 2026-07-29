# Apps Script backend operator guide

## Deploy backend first

1. Create a dedicated Google Sheet owned or administered by the same controlled account that will own the Apps Script deployment. Do not add production patient data yet.
2. Create a standalone Apps Script project under that account. From `backend/`, copy `.clasp.json.example` to the ignored `.clasp.json`, replace only its placeholder project ID locally, then use your approved clasp installation to push this directory. Do not commit `.clasp.json`.
3. In Apps Script **Project Settings → Script properties**, set all five required values. Paste values directly in the console; do not save them in source files, terminal history, issues, or workflow logs.

| Property | Value and handling |
| --- | --- |
| `SPREADSHEET_ID` | The canonical Google Sheet ID: at least 20 URL-safe characters (`A-Z`, `a-z`, `0-9`, `_`, `-`), with no spaces or URL wrapper. |
| `FRONTEND_BASE_URL` | Canonical HTTPS GitHub Pages base URL, including its repository path when applicable; no credentials, query, fragment, or whitespace. `setupApplication()` normalizes a final trailing slash away. |
| `APP_SECRET` | One distinct 32-byte random Base64URL value: exactly 43 URL-safe Base64 characters, optionally followed by one terminal `=`. Treat as a secret. |
| `TOKEN_SIGNING_SECRET` | A second, different 32-byte random Base64URL value in the same format. Treat as a secret. |
| `DEPLOYMENT_ENV` | Exactly one non-secret lower-case value: `development`, `test`, `staging`, or `production`. |

Generate the two distinct secrets in a private terminal with a CSPRNG, then paste each directly into Script Properties:

```bash
node -e "const c=require('node:crypto'); console.log(c.randomBytes(32).toString('base64url')); console.log(c.randomBytes(32).toString('base64url'))"
```

Treat the two output lines as secrets: do not commit, display in a ticket, copy into this guide, or retain in shell/session logs. A password manager’s 32-byte Base64URL generator is an equivalent approved source.

4. Run `setupApplication()` from the Apps Script editor once. It explicitly validates and normalizes the five Script Properties, initializes/repairs the schema, and installs the daily appointment reminder trigger idempotently. Invalid configuration returns safe field/code/message entries without echoing configured values or secrets. It is not an API action and is never called by `doGet` or `doPost`.
5. Open the configured Sheet and confirm the fourteen tabs and headers in [the schema reference](../docs/architecture.md). Initialization is additive: it creates missing tabs, appends missing headers, and seeds missing Settings/MasterData rows. It never removes, renames, reorders, or overwrites existing business columns or rows.

## Create initial users without exposing PINs

Run the repository helper in a private interactive terminal:

```bash
node scripts/hash-initial-pin.js
```

It accepts the PIN and `APP_SECRET` without echoing them and enforces the application PIN policy: 8–128 characters. It prints a salted `HMAC-SHA256$v2` record compatible with `createPinHash_`. Immediately paste that output only into the protected `Users.PINHash` cell for the intended `StaffID`; then clear the terminal according to local policy. Do not type a PIN or `APP_SECRET` into source code, a spreadsheet formula, a command-line argument, email, chat, or a commit. Add `FullName`, `Department`, `Email`, `Role` (`STAFF` or `ADMIN`), and `Active` according to the exact `Users` headers. Preserve leading zeroes in `StaffID`.

## Login throttle and session operation

`LOGIN_IDENTITY_FAILURE_LIMIT`, `LOGIN_GLOBAL_FAILURE_LIMIT`, `LOGIN_FAILURE_WINDOW_MINUTES`, and `LOGIN_LOCKOUT_MINUTES` define the durable throttling policy. Known active-user failures use only the appended `Users` login columns. Unknown or inactive identities use the single bounded `LOGIN_GLOBAL_THROTTLE_STATE` Settings row and cannot lock known active users. Both eligible and ineligible identities execute one bounded-work HMAC verification path before a generic invalid-credential response. Do not edit the runtime JSON manually. Login audits contain result/recovery evidence but never a raw PIN.

Temporary locks expire automatically. After verifying the operator request and investigating the associated audit records, an Apps Script editor may run `unlockLoginIdentity(staffId)` for one exact staff ID or `unlockGlobalLoginThrottle()` for the global guard. These editor-only helpers are deliberately absent from the HTTP action registry. Record the operator, reason, and timestamp under local incident/change-control policy.

`SESSION_TIMEOUT_MINUTES` is a sliding idle limit, not an absolute lifetime. Successful protected reads and writes return a `sessionExpiresAt`; `SESSION_TOUCH_INTERVAL_MINUTES` bounds durable activity writes. A due touch re-reads the session under the script lock so an older request cannot overwrite newer activity. The returned deadline is capped by the persisted `ExpiresAt`; if the Sheet touch is not persisted, the response cannot advertise an extension beyond durable state. The default two-minute touch interval is also the maximum server-side grace beyond the configured idle limit. Explicit logout or terminal expiry clears both the browser session and an opaque reschedule handoff; a deliberate logged-out reschedule-to-login handoff is preserved.

## Deploy the Web App

Use **Deploy → New deployment → Web app** after the initial setup.

- **Execute as:** **Me (the deployment owner)**. This owner must retain access to the configured Sheet and authorization to send mail; executing as a visitor would not provide the necessary controlled service identity.
- **Who has access:** select the narrowest setting that includes all intended staff. For an internal deployment, choose the organization/domain option if available. Choose **Anyone** only after a documented security review confirms that the public appointment-link flows and your organization’s policy permit it. Do not use a personal-account access setting for a workforce deployment.
- Copy the resulting HTTPS `/exec` URL as the public API endpoint. Do not use a `/dev` URL in Pages or a production browser.

Update `FRONTEND_BASE_URL` once Pages has its final URL; run `setupApplication()` again only when configuration or schema/trigger setup requires reconciliation. It is explicit operator maintenance, never a per-request initializer. Deploy a new Web App version after backend changes and update the Pages repository variable if the `/exec` URL changes.

## Email, triggers, health, and tests

Run the following from the Apps Script editor under the deployment owner, first against a disposable test Sheet. The test runners create and trash their own temporary Sheets, but their Drive and Mail scopes still require owner authorization.

| Run order | Function | Expected result before production sign-off |
| --- | --- | --- |
| 1 | `runSchemaTests` | Returns `{ passed: true }` on an operator-run test Sheet. |
| 2 | `runAuthTests` | Returns `{ passed: true }` and uses only test users. |
| 3 | `runOrderTests` | Returns `{ passed: true }`; its email path intentionally uses a failed-delivery double. |
| 4 | `runOrderUpdateTests` | Returns `{ passed: true }`. |
| 5 | `runEmailTests` | Returns `{ passed: true }`; it verifies safe failed-delivery logging. |
| 6 | `runAppointmentTests` | Returns `{ passed: true }` and uses a disposable Sheet. |

These are expected outcomes, not recorded live results. The Apps Script suites remain pending until an operator runs them and attaches dated evidence in the UAT checklist.

Authorize MailApp deliberately: run a controlled test under the deployment owner, complete the Google consent prompts, and confirm the owner is permitted to send to the chosen test recipient. Verify one normal business email separately from the deliberately failing email suite, inspect `EmailLog`, and never use patient data in a pre-production test.

Create/update/cancel notifications are post-commit work. The business result and deterministic notification job are recorded together in `RequestLog`; `EmailLog` provides delivery state. First reservation and snapshot persistence are serialized under the script lock, while `MailApp` remains outside it. Terminal email and request-log outcomes are monotonic: a stale worker cannot replace a recorded terminal result with `FAILED` or `UNCERTAIN`, and a definitive `EmailLog` result upgrades an earlier uncertain request outcome. A replay may reconcile a pending preparation failure, but an existing `SENDING`/uncertain record must not be sent again automatically. Inspect `AuditLog`, `RequestLog`, and `EmailLog` together after any ambiguous delivery, and use only the explicit admin retry path for a terminal failed delivery.

When `CANCELLATION_REQUIRES_ADMIN_APPROVAL` is `TRUE`, a staff cancellation enters `CANCEL_REQUESTED`. An admin must use the order-detail approve/reject controls. Verify approval cancels every item and revokes its cancellation-owned tokens; verify rejection follows `CANCEL_REQUESTED → CANCEL_REJECTED →` the exact recorded prior order/item states and restores only unexpired live tokens owned by that request. New staff cancellation and admin decision request IDs are bound to SHA-256 fingerprints of their normalized payloads; reusing an ID after changing the reason or decision is rejected. Legacy successful rows created before fingerprints existed retain their stored replay behavior and must not be re-executed.

`setupApplication()` calls `setupAppointmentReminderTrigger()` for `processAppointmentDueReminders`. In Apps Script **Triggers**, verify exactly one daily handler for that function, its owner, the configured `APPOINTMENT_REMINDER_HOUR`, and `TIMEZONE`. `scheduledSchemaCheck` and `expireActionTokens` are maintenance jobs: schedule and evidence them only through the approved operational change process; they are not installed by `setupApplication()`.

As an authenticated admin, call `GET_DATABASE_HEALTH` through the application or invoke `getDatabaseHealth()` in the editor. The safe expected result has `healthy: true` with empty missing-sheet and missing-column collections. Do not expose health output publicly.
