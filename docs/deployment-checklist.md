# Deployment checklist

## Backend and data

- [ ] Create a dedicated controlled Google Sheet and Apps Script project under the deployment owner.
- [ ] Copy `backend/.clasp.json.example` to ignored `backend/.clasp.json`; keep the actual project ID local.
- [ ] Push/review backend source with approved clasp procedures.
- [ ] Set `SPREADSHEET_ID` as its canonical 20+-character URL-safe ID; set `FRONTEND_BASE_URL` as the canonical HTTPS Pages URL (repository path allowed, no credentials/query/fragment); set `APP_SECRET` and `TOKEN_SIGNING_SECRET` as distinct CSPRNG-generated 32-byte Base64URL values (exactly 43 URL-safe characters, optionally followed by one `=`); set `DEPLOYMENT_ENV` exactly to `development`, `test`, `staging`, or `production`. Generate secrets outside the repository and do not record their output.
- [ ] Run `setupApplication()` explicitly. Confirm `initializeDatabase()` produced the fourteen additive schema tabs and `setupAppointmentReminderTrigger()` reports or retains one trigger.
- [ ] Create test users with 8–128-character PINs and salted `HMAC-SHA256$v2` hashes using `node scripts/hash-initial-pin.js`; enter the same `APP_SECRET` configured in Script Properties and do not retain either value in source, shell history, or logs.
- [ ] Review the seeded login throttle policy (`LOGIN_IDENTITY_FAILURE_LIMIT`, `LOGIN_GLOBAL_FAILURE_LIMIT`, `LOGIN_FAILURE_WINDOW_MINUTES`, `LOGIN_LOCKOUT_MINUTES`). Exercise a non-production lockout and confirm the generic `LOGIN_THROTTLED` response includes retry metadata without identifying a user.
- [ ] Verify the editor-only `unlockLoginIdentity(staffId)` and `unlockGlobalLoginThrottle()` recovery procedure with non-production evidence. Do not expose either helper as an HTTP route or manually edit `LOGIN_GLOBAL_THROTTLE_STATE`.
- [ ] Confirm `SESSION_TIMEOUT_MINUTES` is the required sliding idle limit and `SESSION_TOUCH_INTERVAL_MINUTES` is an approved bounded write/grace interval. Test protected read activity, terminal expiry, and explicit logout.
- [ ] Deploy a Web App version: **Execute as: Me (deployment owner)**; **Who has access: narrowest workforce/domain setting**. Record the approved exception if **Anyone** is selected.
- [ ] Copy only the deployed HTTPS `/exec` endpoint for the frontend; never use `/dev` in Pages.
- [ ] Authorize MailApp as the owner and send a controlled non-PHI test email. Inspect `EmailLog`.
- [ ] Inject or otherwise safely exercise post-commit notification failures in a disposable environment. Confirm create/update/cancel still return committed business success; inspect the deterministic `RequestLog` job, `EmailLog`, and `AuditLog`; confirm replay does not duplicate delivery.
- [ ] If `CANCELLATION_REQUIRES_ADMIN_APPROVAL` is enabled, exercise versioned/idempotent approve and reject controls. Confirm approval cancels all items, rejection restores the exact saved states through `CANCEL_REJECTED`, and only eligible request-owned tokens are restored.
- [ ] Verify `processAppointmentDueReminders` has exactly one owner-controlled daily trigger. Review `APPOINTMENT_REMINDER_HOUR` and `TIMEZONE`; schedule `scheduledSchemaCheck` and `expireActionTokens` only through the approved maintenance process.
- [ ] As an admin, verify read-only `getDatabaseHealth()` / `GET_DATABASE_HEALTH` reports healthy schema with no missing sheets or columns. Do not use an HTTP action to repair schema.

## Pages and release gate

- [ ] In GitHub repository settings, create the non-secret Actions variable `APPS_SCRIPT_URL` with the deployed HTTPS Apps Script `/exec` URL. Do not use a secret: it is written into the public frontend artifact.
- [ ] Enable GitHub Pages using GitHub Actions as the source and run `.github/workflows/pages.yml`. The workflow fails if the variable is empty or malformed and generates `frontend/js/config.js`; no deployment URL is committed.
- [ ] Verify the published frontend points to the expected endpoint and public appointment links use the configured `FRONTEND_BASE_URL`.
- [ ] Run `npm run verify` and retain the exact fresh result.
- [ ] Run the repository handoff secret-pattern grep; require no output.
- [ ] Run `git diff --check` and complete the UAT evidence checklist.

## Rollback

1. Stop new traffic by disabling Pages or restoring its previous approved deployment; preserve evidence and do not delete data.
2. Roll back the Apps Script Web App to the prior known-good version, or disable access if a security incident requires containment. Keep **Execute as: Me** ownership controlled.
3. Disable the appointment reminder trigger before any destructive investigation; record its prior configuration. Do not delete unrelated project triggers.
4. Restore only from a verified Sheet backup/snapshot under approved data-governance procedures. The schema tool is additive and cannot perform a destructive rollback.
5. Re-run `getDatabaseHealth()`, required test/UAT evidence, MailApp authorization checks, and the release gate before re-enabling Pages and the trigger.
