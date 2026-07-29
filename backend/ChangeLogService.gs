/** Append immutable change entries in a single batch. */
function writeChanges_(entries) {
  const changes = Array.isArray(entries) ? entries : [];
  if (!changes.length) return { startRow: null, rowCount: 0 };
  const now = new Date().toISOString();
  return appendRecords_('OrderChangeLog', changes.map(function (entry) {
    entry = entry || {};
    return {
      ChangeLogID: String(entry.ChangeLogID || ('CHG-' + Utilities.getUuid())),
      ChangeSetID: String(entry.ChangeSetID || ''),
      OrderID: String(entry.OrderID || ''),
      OrderItemID: String(entry.OrderItemID || ''),
      ChangedAt: entry.ChangedAt || now,
      ChangedByStaffID: String(entry.ChangedByStaffID || ''),
      ChangedByName: String(entry.ChangedByName || ''),
      Department: String(entry.Department || ''),
      ChangedByRole: String(entry.ChangedByRole || ''),
      ActionType: String(entry.ActionType || ''),
      FieldName: String(entry.FieldName || ''),
      FieldLabel: String(entry.FieldLabel || ''),
      OldValue: entry.OldValue == null ? '' : JSON.stringify(entry.OldValue),
      NewValue: entry.NewValue == null ? '' : JSON.stringify(entry.NewValue),
      ChangeReason: String(entry.ChangeReason || ''),
      OrderVersionBefore: entry.OrderVersionBefore == null ? '' : entry.OrderVersionBefore,
      OrderVersionAfter: entry.OrderVersionAfter == null ? '' : entry.OrderVersionAfter,
      RequestID: String(entry.RequestID || ''),
      Source: String(entry.Source || 'WEB'),
      Result: String(entry.Result || 'SUCCESS'),
    };
  }));
}
