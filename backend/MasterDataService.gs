const MASTER_DATA_CACHE_KEY_ = 'MEDICATION_RESERVATION_' + 'MASTER_DATA_V1';
const MASTER_DATA_CACHE_SECONDS_ = 300;

function getMasterData_(types) {
  let cache = null;
  try {
    if (typeof CacheService !== 'undefined' && CacheService && typeof CacheService.getScriptCache === 'function') {
      cache = CacheService.getScriptCache();
    }
  } catch (_e) {}
  const cached = cache ? cache.get(MASTER_DATA_CACHE_KEY_) : null;
  const allData = cached ? JSON.parse(cached) : loadActiveMasterData_();
  if (cache && !cached) {
    try { cache.put(MASTER_DATA_CACHE_KEY_, JSON.stringify(allData), MASTER_DATA_CACHE_SECONDS_); } catch (_e2) {}
  }
  const requestedTypes = types == null ? Object.keys(allData) : (Array.isArray(types) ? types : [types]);
  return requestedTypes.reduce(function (result, type) {
    const name = String(type || '').trim();
    if (name) result[name] = allData[name] ? allData[name].slice() : [];
    return result;
  }, {});
}

function loadActiveMasterData_() {
  let records = [];
  try {
    records = readRecords_('MasterData');
  } catch (_e) {
    records = [];
  }
  const result = (records || []).reduce(function (res, record) {
    const type = String(record.Type || '').trim();
    const code = String(record.Code || '').trim();
    const active = String(record.Active).toUpperCase() !== 'FALSE';
    if (!type || !code || !active) return res;
    if (!res[type]) res[type] = [];
    res[type].push({ Code: code, DisplayName: String(record.DisplayName || code), SortOrder: record.SortOrder, Active: true });
    return res;
  }, {});

  const defaultPriorities = [
    { Code: 'NORMAL', DisplayName: 'ปกติ (Normal)', SortOrder: 1, Active: true },
    { Code: 'URGENT', DisplayName: 'ด่วน (Urgent)', SortOrder: 2, Active: true },
    { Code: 'CRITICAL', DisplayName: 'ด่วนที่สุด (Critical)', SortOrder: 3, Active: true },
  ];
  if (!result.PRIORITY || result.PRIORITY.length === 0) {
    result.PRIORITY = defaultPriorities;
  }
  const defaultMasterData = typeof DEFAULT_MASTER_DATA_ !== 'undefined' ? DEFAULT_MASTER_DATA_ : {};
  if (!result.DOSAGE_FORM || result.DOSAGE_FORM.length === 0) {
    result.DOSAGE_FORM = (defaultMasterData.DOSAGE_FORM || []).map(function (c, idx) {
      return { Code: c, DisplayName: c, SortOrder: idx + 1, Active: true };
    });
  }
  if (!result.UNIT || result.UNIT.length === 0) {
    result.UNIT = (defaultMasterData.UNIT || []).map(function (c, idx) {
      return { Code: c, DisplayName: c, SortOrder: idx + 1, Active: true };
    });
  }
  return result;
}
