function buildOrderItems_(orderId, itemIds, payloadItems, context, now) {
  return payloadItems.map(function (item, index) {
    return {
      OrderItemID: itemIds[index],
      OrderID: orderId,
      ItemNo: index + 1,
      GenericName: cleanOrderText_(item.GenericName),
      BrandName: cleanOrderText_(item.BrandName),
      Strength: cleanOrderText_(item.Strength),
      DosageForm: cleanOrderText_(item.DosageForm).toUpperCase(),
      RequestedQuantity: Number(item.RequestedQuantity),
      Unit: cleanOrderText_(item.Unit).toUpperCase(),
      Prescriber: cleanOrderText_(item.Prescriber),
      ItemStatus: 'SUBMITTED',
      CreatedAt: now.toISOString(),
      CreatedBy: String(context.user.StaffID),
      UpdatedAt: now.toISOString(),
      UpdatedBy: String(context.user.StaffID),
      Active: 'TRUE',
    };
  });
}

function getOrderItems_(orderId) {
  return readRecords_('OrderItems', {
    predicate: function (item) { return String(item.OrderID || '') === String(orderId); },
  }).sort(function (left, right) { return Number(left.ItemNo) - Number(right.ItemNo); });
}
