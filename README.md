# Medication Reservation System

This repository deploys two separate applications: a static frontend on GitHub Pages and a Google Apps Script Web App backed by Google Sheets. Deploy the backend first; the Pages build needs the public Web App URL.

## Operator path

1. Follow the [backend guide](backend/README.md) to create the Spreadsheet, configure Script Properties, deploy the Web App, run `setupApplication()`, create the initial users, and authorize email.
2. Complete [the deployment checklist](docs/deployment-checklist.md), including the admin health check and trigger verification.
3. Set the non-secret repository variable `APPS_SCRIPT_URL` to the deployed Web App `/exec` URL, enable GitHub Pages, and run the Pages workflow. The workflow validates the URL and generates `frontend/js/config.js`; do not commit a deployment URL there.
4. Execute the [UAT checklist](docs/uat-checklist.md) and retain the requested evidence before production use.

The frontend contains no credentials. The API URL is public configuration, but Spreadsheet IDs, Script Properties, raw PINs, hashes, action links, and patient information are not repository content.

## Verification

Run the local release gate before handoff:

```bash
npm run verify
git diff --check
```

Run the repository handoff secret-pattern grep separately and require no output. Node checks do not execute Apps Script services; an operator must run the six Apps Script suites against a disposable test Sheet as described in [backend/README.md](backend/README.md).

Current security/operations contracts include 8–128-character initial PINs, durable generic login throttling with editor-only recovery, sliding idle sessions, versioned admin cancellation decisions, and deterministic post-commit notification reconciliation. These features add columns and Settings rows to the existing fourteen-sheet schema; they do not introduce another sheet.

## Guides

- [Architecture and exact schema](docs/architecture.md)
- [API contract](docs/api.md)
- [Deployment checklist](docs/deployment-checklist.md)
- [UAT evidence checklist](docs/uat-checklist.md)
- [Platform limitations and migration signals](docs/limitations.md)
