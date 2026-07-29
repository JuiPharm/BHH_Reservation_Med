# Platform limitations and migration signals

Google Sheets is not a transactional database. Script locks, range batches, version checks, idempotency records, and compensating recovery reduce—but do not eliminate—concurrency, quota, formula, filtering, and manual-edit risks. Keep access to the backing Sheet tightly controlled; do not add ad hoc columns with expectations that application writes will use them.

Login throttling uses appended per-user columns plus one bounded JSON state value in the existing `Settings` sheet for unknown/inactive identities. The unknown bucket does not block known active users, and a dummy HMAC record reduces identity-dependent timing differences, but this remains application-level throttling rather than a distributed edge rate limiter. Sheet/lock outages fail login closed, and authorized operators must use the editor-only unlock helpers rather than editing counters or JSON by hand.

Sliding sessions trade write volume for a small bounded enforcement grace: with the default two-minute `SESSION_TOUCH_INTERVAL_MINUTES`, the durable server expiry may be up to two minutes beyond the configured idle timeout. Due touches are serialized and re-read under lock; the client deadline never exceeds the persisted expiry. A separate absolute maximum session lifetime is not currently configured.

Apps Script execution timing is quota-bound and time-based triggers run within a scheduled hour, not at a guaranteed exact minute. Trigger ownership and authorization are tied to the deployment owner. Mail sending is subject to account/domain quotas and consent; delivery failures must be inspected in `EmailLog` and do not guarantee recipient receipt.

MailApp cannot provide an atomic transaction with Sheets or definitive delivery receipts. Deterministic post-commit jobs make pending preparation failures replayable and prevent known duplicate sends. If a process stops after MailApp accepts a send but before terminal state is durable, the job is marked uncertain and is deliberately not sent again automatically; an operator must reconcile the logs and recipient evidence.

Cancellation request fingerprints apply to records created after this hardening release. Legacy successful `RequestLog` rows without a fingerprint retain the previous stored-result replay policy for compatibility; they are never re-executed, but the backend cannot retrospectively prove that an old caller payload matched.

Apps Script does not provide conventional control over CORS headers or redirect behavior. The frontend uses a simple request shape and follows the platform redirect, but browser CORS behavior is constrained by the platform. Do not depend on custom `Access-Control-*` headers, cookies as an authorization boundary, or arbitrary origin enforcement.

The static GitHub Pages artifact exposes its API URL by design. `APPS_SCRIPT_URL` is therefore a repository variable, not a secret. Script Properties, Sheet IDs, PIN hashes, raw PINs, session/action tokens, and patient information remain protected operational data.

Plan a migration from Sheets/Apps Script when sustained usage approaches execution, mail, trigger, or concurrent-write quotas; when exact-time scheduling, stronger database transactions, external identity integration, centralized observability, granular secret rotation, or high-volume audit reporting become mandatory. Export and reconcile logs before migration; preserve the additive schema mapping and audit trail.
