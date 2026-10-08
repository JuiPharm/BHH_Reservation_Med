function requireRole_(context, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  const role = context && context.user ? String(context.user.Role || '').toUpperCase() : '';
  const isV2Admin = role === 'SYSTEM_ADMIN' || role === 'PHARMACY_MANAGER';
  const effectiveRoles = [role];
  if (isV2Admin) effectiveRoles.push('ADMIN');
  if (role === 'PHARMACY_OPERATOR') effectiveRoles.push('ADMIN', 'STAFF');
  if (role === 'WARD_STAFF') effectiveRoles.push('STAFF', 'REQUESTER');

  const allowedUpper = allowed.map(function (value) { return String(value).toUpperCase(); });
  const hasAccess = effectiveRoles.some(function (r) { return allowedUpper.indexOf(r) >= 0; });
  if (!hasAccess) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  return context;
}

function requireOrderAccess_(context, order) {
  const user = context && context.user;
  const role = user ? String(user.Role || '').toUpperCase() : '';
  const isStaffOrAdmin = role === 'ADMIN' || role === 'SYSTEM_ADMIN' || role === 'PHARMACY_MANAGER' || role === 'PHARMACY_OPERATOR';
  const requestedDepartment = order ? String(order.Department || '') : '';
  if (!user || !order) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  if (!isStaffOrAdmin && String(user.Department || '') !== requestedDepartment) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  return order;
}
