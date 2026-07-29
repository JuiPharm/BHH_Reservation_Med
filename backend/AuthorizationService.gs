function requireRole_(context, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  const role = context && context.user ? String(context.user.Role || '').toUpperCase() : '';
  if (allowed.map(function (value) { return String(value).toUpperCase(); }).indexOf(role) < 0) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  return context;
}

function requireOrderAccess_(context, order) {
  const user = context && context.user;
  const role = user ? String(user.Role || '').toUpperCase() : '';
  const requestedDepartment = order ? String(order.Department || '') : '';
  if (!user || !order || (role !== 'ADMIN' && String(user.Department || '') !== requestedDepartment)) throw new ApiError_('ACCESS_DENIED', 'Access denied.');
  return order;
}
