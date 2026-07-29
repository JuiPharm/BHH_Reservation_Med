/** Append immutable audit records; callers supply only business-safe values. */
function writeAudit_(entry) {
  const value = entry && typeof entry === 'object' ? entry : {};
  const now = new Date().toISOString();
  return appendRecords_('AuditLog', [{
    AuditID: String(value.AuditID || ('AUD-' + Utilities.getUuid())),
    Timestamp: value.Timestamp || now,
    StaffID: String(value.StaffID || ''),
    Role: String(value.Role || ''),
    Department: String(value.Department || ''),
    Action: String(value.Action || ''),
    OrderID: String(value.OrderID || ''),
    OrderItemID: String(value.OrderItemID || ''),
    RequestID: String(value.RequestID || ''),
    OldValue: value.OldValue == null ? '' : JSON.stringify(value.OldValue),
    NewValue: value.NewValue == null ? '' : JSON.stringify(value.NewValue),
    Result: String(value.Result || 'SUCCESS'),
    Detail: String(value.Detail || ''),
  }]);
}
