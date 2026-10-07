# Frontend v2 workflow refresh

## Purpose

This change refreshes the BHH Reservation Med frontend so it is visually and operationally consistent with other Bangkok Hospital Hat Yai web applications while keeping the existing Apps Script API contract intact.

## Implemented in this change

- BHH navy / blue / white / gray visual system with red accent.
- Shared BHH Medication Reservation & Fulfillment brand asset.
- Operational staff work queue instead of a technical-status-first dashboard.
- User-facing Thai status labels mapped from the existing backend status values.
- Shared workflow stages: request, sourcing, ready, pickup, closed.
- Role-aware navigation that hides the pharmacy operations link from non-admin sessions.
- Redesigned login, request creation/editing, case detail, pharmacy operations, receiving, reschedule, appointment response, error, and access-denied pages.
- Responsive tables that become labelled cards on narrow screens.
- Improved loading, empty, error, focus, and touch-target states.
- Frontend pull-request contract checks using the existing Node test suite.

## Compatibility boundary

This refresh intentionally does not change the current Apps Script action names, request envelopes, OrderHeaders schema, or status values. Existing IDs and DOM hooks used by the JavaScript modules are retained.

## Deferred domain changes

1. Split RequiredDate into NeedByDate / ExpectedArrivalDate / ReadyDate / PickupAppointmentDate / ActualPickupAt.
2. Introduce medication master identifiers and search/autocomplete instead of relying only on free-text medication names.
3. Introduce a reservation/allocation model: requested quantity, reserved quantity, fulfilled quantity, source, and ETA.
4. Separate case, fulfillment, pickup, notification, and cancellation states instead of expanding one status field.
5. Separate pharmacy operational roles from system administration roles.
6. Refactor the large backend services around the approved v2 domain model rather than splitting the current God service mechanically.

## Release approach

The work is isolated on feature/frontend-v2-workflow-refresh. Merge only after frontend contract checks and manual UAT at mobile, tablet, and desktop widths.
