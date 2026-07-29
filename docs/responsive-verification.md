# Partial rendered-browser responsive evidence

**Evidence retained and rerun:** 2026-07-29.

## Provenance and scope

The matrix used the Task 12 local static-server browser harness with the bundled
Thai WOFF2 font. It ran a real headless browser against deterministic mock API
responses. No live application service, Sheet, mail system, account, or Pages
site was contacted. This is rendered frontend evidence only, not operator or
production acceptance.

The bounded result is
[task-14-responsive-results.json](evidence/task-14-responsive-results.json).
It contains measurements and aggregate operation counts only. Screenshots,
debug output, raw identifiers, and raw browser/API values were excluded before
tracking.

## Rerun results

Every listed width has zero horizontal overflow on login, dashboard, new-order,
detail, admin, appointment, and reschedule pages. Each run measured 44 px
brand and order-link targets; medication rows changed 1 → 3 → 2 and showed a
validation-error state; all three retained keyboard focus steps had a 3 px
outline; modal bounds/focus containment/focus return passed; print hid header
and footer; reduced-motion durations were 0.01 ms; and appointment/reschedule
flows completed against the mock service.

| CSS viewport | Orientation | Measured scroll / viewport | Result |
| --- | --- | --- | --- |
| 360 × 800 | mobile portrait | 360 / 360 | PASS |
| 390 × 844 | mobile portrait | 390 / 390 | PASS |
| 430 × 932 | mobile portrait | 430 / 430 | PASS |
| 800 × 360 | mobile landscape | 800 / 800 | PASS |
| 844 × 390 | mobile landscape | 844 / 844 | PASS |
| 932 × 430 | mobile landscape | 932 / 932 | PASS |
| 768 × 1024 | tablet portrait | 768 / 768 | PASS |
| 1024 × 768 | tablet landscape | 1024 / 1024 | PASS |
| 1280 × 800 | desktop | 1280 / 1280 | PASS |
| 1440 × 900 | desktop | 1440 / 1440 | PASS |

At the effective 200% zoom target (512 × 384 CSS pixels), the dashboard had no
horizontal overflow and retained visible keyboard focus. Aggregate operation
counts include 10 successful reschedule submissions, one for every viewport;
the dashboard count is 21 because the zoom check loads it once more.

This is partial rendered evidence only. It does not prove the full keyboard-only
end-to-end workflow required by AC-37, so AC-37 remains pending. Live
device/accessibility, service, and operator evidence remain required by UAT
`RM-01` and `AG-06`.
