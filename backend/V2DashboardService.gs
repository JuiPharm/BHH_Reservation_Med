/**
 * Initial v2 dashboard backed by T_Reservations / T_ReservationItems.
 * This provides a coherent post-login UAT surface before the full reservation
 * mutation workflow is migrated.
 */
function getV2Dashboard_(context, payload) {
  const user = context && context.user;
  if (!user) throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');

  const role = String(user.Role || '').toUpperCase();
  const departmentId = String(user.DepartmentID || '');
  const canViewAll = ['SYSTEM_ADMIN', 'PHARMACY_MANAGER', 'PHARMACY_OPERATOR'].indexOf(role) >= 0;
  const reportOnly = role === 'REPORT_VIEWER';

  payload = payload && typeof payload === 'object' ? payload : {};
  const filters = payload.filters && typeof payload.filters === 'object' ? payload.filters : {};
  const search = String(payload.search || '').trim().toLowerCase();
  const requestedPage = Math.max(1, Number(payload.page) || 1);
  const pageSize = Math.max(1, Math.min(100, Number(payload.pageSize) || 25));

  let reservations = readV2Records_('T_Reservations');
  if (!canViewAll && role !== 'REPORT_VIEWER') {
    reservations = reservations.filter(function (row) {
      return String(row.DepartmentID || '') === departmentId;
    });
  }

  if (filters.Status) {
    const status = String(filters.Status).toUpperCase();
    reservations = reservations.filter(function (row) {
      return String(row.OverallStatus || '').toUpperCase() === status;
    });
  }

  if (search) {
    reservations = reservations.filter(function (row) {
      return String(row.ReservationID || '').toLowerCase().indexOf(search) >= 0;
    });
  }

  reservations.sort(function (left, right) {
    return String(right.CreatedAt || '').localeCompare(String(left.CreatedAt || ''));
  });

  const statusCounts = reservations.reduce(function (counts, row) {
    const status = String(row.OverallStatus || 'UNKNOWN').toUpperCase();
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});

  const total = reservations.length;
  const start = (requestedPage - 1) * pageSize;
  const pageRows = reservations.slice(start, start + pageSize);
  const itemCounts = {};
  if (pageRows.length > 0) {
    const itemsSheet = getV2SheetOrThrow_('T_ReservationItems');
    if (itemsSheet.getLastRow() >= 2) {
      const pageIds = {};
      pageRows.forEach(function (r) { pageIds[String(r.ReservationID || '')] = true; });
      const items = readV2Records_('T_ReservationItems', {
        predicate: function (item) { return Boolean(pageIds[String(item.ReservationID || '')]); },
      });
      items.forEach(function (item) {
        const id = String(item.ReservationID || '');
        if (id) itemCounts[id] = (itemCounts[id] || 0) + 1;
      });
    }
  }

  const recentOrders = reportOnly ? [] : pageRows.map(function (row) {
    const id = String(row.ReservationID || '');
    return {
      OrderID: id,
      ReservationID: id,
      PatientName: String(row.PatientName || ''),
      WardClinic: String(row.DepartmentNameSnapshot || ''),
      DepartmentID: String(row.DepartmentID || ''),
      Status: String(row.OverallStatus || ''),
      RequiredDate: String(row.RequiredDate || ''),
      Priority: '',
      ItemCount: Number(itemCounts[id] || 0),
      CreatedAt: String(row.CreatedAt || ''),
      Version: Number(row.Version || 0),
    };
  });

  return {
    apiVersion: 'v2',
    statusCounts: statusCounts,
    recentOrders: recentOrders,
    page: requestedPage,
    pageSize: pageSize,
    total: total,
    totalOrders: total,
  };
}
