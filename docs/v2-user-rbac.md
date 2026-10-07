# V2 user and role model

The Drug Reservation Database stores application users in **T_Users**.

## Canonical roles

| RoleCode | Purpose |
| --- | --- |
| REQUESTER | Create and track reservations for an authorized department |
| PHARMACY_OPERATOR | Review, source, receive, prepare and coordinate pickup |
| PHARMACY_MANAGER | Operator capabilities plus exception/cancellation approval and pharmacy oversight |
| SYSTEM_ADMIN | User, role, configuration and system-health administration |
| REPORT_VIEWER | Read-only aggregated/report access |

The Google Sheet contains an `M_Roles` master and data validation on `T_Users.Role`. Backend authorization remains authoritative; spreadsheet validation is not a security boundary.

## Account status

Allowed values:
- PENDING
- ACTIVE
- LOCKED
- DISABLED
- REJECTED

Only **ACTIVE** users should be allowed to authenticate.

## Initial UAT administrator

The bootstrap row uses:
- StaffID: `ADMIN01`
- Role: `SYSTEM_ADMIN`
- DepartmentID: `DEPT-PHARMACY`
- Initial status in the Sheet: `PENDING`

Do not put a plaintext password in `T_Users`.

Use the operator-only Apps Script function `provisionInitialV2Admin()`. Before running it, set these Script Properties:

- `SPREADSHEET_ID_V2` = Drug Reservation Database spreadsheet ID
- `V2_BOOTSTRAP_ENABLED` = `TRUE`
- `V2_BOOTSTRAP_ADMIN_STAFF_ID` = `ADMIN01` (optional; this is the default)
- `V2_BOOTSTRAP_ADMIN_NAME` = desired display name (optional)
- `V2_BOOTSTRAP_ADMIN_DEPARTMENT_ID` = `DEPT-PHARMACY` (optional; this is the default)
- `V2_BOOTSTRAP_ADMIN_PASSWORD` = a temporary 8–128 character password entered only in Script Properties

Run `provisionInitialV2Admin()` once from the Apps Script editor.

The function:
1. requires the explicit bootstrap enable flag,
2. validates the active department,
3. creates the credential with the existing server-side `HMAC-SHA256$v2` implementation and `APP_SECRET`,
4. activates the `SYSTEM_ADMIN`,
5. writes an audit row,
6. deletes the one-time password Script Property,
7. disables the bootstrap flag.

Never commit the temporary password or `APP_SECRET`.
