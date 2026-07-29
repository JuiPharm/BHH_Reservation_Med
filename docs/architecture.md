# Architecture and schema

The frontend is a static GitHub Pages application. It sends HTTPS requests to a separately deployed Apps Script Web App, which applies authentication and role/department authorization before protected work. The backend owner accesses Google Sheets, sends mail, and runs time-based jobs. `PropertiesService` holds configuration; Sheets holds operational data; Locks, cache, audit/change/request/email logs provide limited consistency controls.

The deployment order is backend-first: configure Script Properties, run `setupApplication()`, deploy the Web App, then configure GitHub Pages with the public endpoint. `setupApplication()` is an operator-only action, never a request-time action.

## Exact additive schema

`initializeDatabase()` owns the following fourteen sheet names and headers. The count is fourteen because `Departments` is a distinct operational tab. It is an additive migration: missing tabs and headers are created or appended; existing tabs, headers, order, formulas, and rows are never deleted, renamed, reordered, or overwritten. `StaffID` and `HN` are formatted as text to preserve leading zeroes.

| Sheet | Exact headers |
| --- | --- |
| `Users` | `StaffID`, `FullName`, `Department`, `Email`, `Role`, `PINHash`, `Active`, `CreatedAt`, `UpdatedAt`, `FailedLoginWindowStartedAt`, `FailedLoginCount`, `LoginLockedUntil`, `LastFailedLoginAt` |
| `Departments` | `DepartmentCode`, `DepartmentName`, `DepartmentEmail`, `CCEmail`, `Active`, `UpdatedAt`, `UpdatedBy` |
| `OrderHeaders` | `OrderID`, `ClientRequestID`, `CreatedAt`, `CreatedByStaffID`, `CreatedByName`, `Department`, `RequesterEmail`, `RequesterPhone`, `HN`, `PatientName`, `WardClinic`, `RequiredDate`, `Priority`, `Status`, `ItemCount`, `Version`, `CreatedSource`, `UpdatedAt`, `UpdatedBy`, `LastChangeSetID`, `LastChangeType`, `LastChangeReason`, `LastChangedAt`, `LastChangedBy`, `CancelledAt`, `CancelledBy`, `CancelReason`, `NotificationStatus`, `LastEmailSentAt`, `LastEmailSentBy`, `UpdateNotificationStatus`, `LastUpdateEmailSentAt`, `AppointmentSequence`, `LastAppointmentReminderAt`, `LastAppointmentReminderSequence`, `AppointmentResponseStatus`, `AppointmentRespondedAt`, `AppointmentRespondedBy`, `PatientReceivedAt`, `NoShowReasonCode`, `NoShowReasonDetail`, `NoShowRecordedAt`, `NoShowCount`, `LastRequiredDate`, `LastRescheduledAt`, `LastRescheduledBy`, `LastRescheduleReason`, `CancellationPreviousStatus`, `CancellationRequestID`, `CancellationRequestedAt`, `CancellationRequestedBy`, `CancellationDecision`, `CancellationDecisionAt`, `CancellationDecisionBy`, `CancellationDecisionReason` |
| `OrderItems` | `OrderItemID`, `OrderID`, `ItemNo`, `GenericName`, `BrandName`, `Strength`, `DosageForm`, `RequestedQuantity`, `Unit`, `Prescriber`, `ItemStatus`, `ReceivedDate`, `ReceivedQuantity`, `ReceivedUnit`, `AdminNote`, `CreatedAt`, `CreatedBy`, `UpdatedAt`, `UpdatedBy`, `Active`, `CancellationPreviousStatus` |
| `OrderChangeLog` | `ChangeLogID`, `ChangeSetID`, `OrderID`, `OrderItemID`, `ChangedAt`, `ChangedByStaffID`, `ChangedByName`, `Department`, `ChangedByRole`, `ActionType`, `FieldName`, `FieldLabel`, `OldValue`, `NewValue`, `ChangeReason`, `OrderVersionBefore`, `OrderVersionAfter`, `RequestID`, `Source`, `Result` |
| `EmailLog` | `EmailLogID`, `OrderID`, `ChangeSetID`, `EmailType`, `Recipient`, `CC`, `Subject`, `SentAt`, `SentBy`, `Result`, `ErrorMessage`, `RetryCount` |
| `AuditLog` | `AuditID`, `Timestamp`, `StaffID`, `Role`, `Department`, `Action`, `OrderID`, `OrderItemID`, `RequestID`, `OldValue`, `NewValue`, `Result`, `Detail` |
| `Settings` | `Key`, `Value`, `Description`, `UpdatedAt`, `UpdatedBy` |
| `MasterData` | `Type`, `Code`, `DisplayName`, `SortOrder`, `Active`, `UpdatedAt` |
| `Sessions` | `SessionTokenHash`, `StaffID`, `CreatedAt`, `ExpiresAt`, `LastActiveAt`, `Active` |
| `RequestLog` | `RequestID`, `Action`, `OrderID`, `StaffID`, `CreatedAt`, `Result`, `ResponseData` |
| `AppointmentResponseLog` | `ResponseLogID`, `OrderID`, `AppointmentSequence`, `AppointmentDate`, `ActionType`, `ResponseAt`, `ResponseSource`, `RespondedByStaffID`, `RespondedByName`, `Department`, `ReasonCode`, `ReasonDetail`, `OldRequiredDate`, `NewRequiredDate`, `ActionTokenID`, `ChangeSetID`, `OrderVersionBefore`, `OrderVersionAfter`, `RequestID`, `Result`, `ErrorMessage` |
| `AppointmentReminderLog` | `ReminderLogID`, `OrderID`, `AppointmentSequence`, `AppointmentDate`, `ReminderType`, `Recipient`, `CC`, `SentAt`, `Result`, `ErrorMessage`, `ActionTokenGroupID`, `RetryCount` |
| `ActionTokens` | `TokenID`, `TokenHash`, `OrderID`, `AppointmentSequence`, `ActionType`, `Department`, `CreatedAt`, `ExpiresAt`, `UsedAt`, `UsedBy`, `Status`, `ReminderLogID`, `RequestID`, `CancellationRequestID`, `CancellationPreviousStatus` |

`setupApplication()` runs `initializeDatabase()` and idempotently calls `setupAppointmentReminderTrigger()`. `getDatabaseHealth()` reports missing schema safely to authenticated admins. Scheduled maintenance functions are `processAppointmentDueReminders`, `scheduledSchemaCheck`, and `expireActionTokens`.

Runtime policy remains in the existing `Settings` sheet. Final hardening adds the sliding-idle touch interval, four login-throttle policy rows, a single bounded global-throttle state row, and the admin-cancellation policy row; it does not add a fifteenth sheet. Per-identity throttle state and cancellation state are appended to their owning business rows so additive repair remains safe for existing deployments.
