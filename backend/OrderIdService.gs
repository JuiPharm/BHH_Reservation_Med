/** Allocate order and item identifiers while the caller owns the script lock. */
function generateOrderIds_(itemCount, now) {
  const count = Number(itemCount);
  if (!Number.isInteger(count) || count < 1 || count > 99) throw new ApiError_('VALIDATION_ERROR', 'Invalid medication items.');
  const generatedAt = now instanceof Date ? now : new Date();
  if (!isFinite(generatedAt.getTime())) throw new ApiError_('VALIDATION_ERROR', 'Invalid creation time.');
  const prefix = String(getSetting_('ORDER_PREFIX', 'MED') || 'MED').trim() || 'MED';
  const datePart = Utilities.formatDate(generatedAt, Session.getScriptTimeZone(), 'yyyyMMdd');
  const expression = new RegExp('^' + escapeOrderIdPart_(prefix) + '-' + datePart + '-(\\d{4})$');
  const sequence = readRecords_('OrderHeaders').reduce(function (maximum, record) {
    const match = String(record.OrderID || '').match(expression);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0) + 1;
  if (sequence > 9999) throw new ApiError_('ORDER_ID_EXHAUSTED', 'Unable to allocate an order ID.');
  const orderId = prefix + '-' + datePart + '-' + ('0000' + sequence).slice(-4);
  return {
    orderId: orderId,
    itemIds: Array.from({ length: count }, function (_unused, index) {
      return orderId + '-' + ('00' + (index + 1)).slice(-2);
    }),
  };
}

function escapeOrderIdPart_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
