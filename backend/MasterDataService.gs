const MASTER_DATA_CACHE_KEY_ = 'MEDICATION_RESERVATION_' + 'MASTER_DATA_V1';
const MASTER_DATA_CACHE_SECONDS_ = 300;

function getMasterData_(types) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(MASTER_DATA_CACHE_KEY_);
  const allData = cached ? JSON.parse(cached) : loadActiveMasterData_();
  if (!cached) cache.put(MASTER_DATA_CACHE_KEY_, JSON.stringify(allData), MASTER_DATA_CACHE_SECONDS_);
  const requestedTypes = types == null ? Object.keys(allData) : (Array.isArray(types) ? types : [types]);
  return requestedTypes.reduce(function (result, type) {
    const name = String(type || '').trim();
    if (name) result[name] = allData[name] ? allData[name].slice() : [];
    return result;
  }, {});
}

function loadActiveMasterData_() {
  return readRecords_('MasterData').reduce(function (result, record) {
    const type = String(record.Type || '').trim();
    const code = String(record.Code || '').trim();
    const active = String(record.Active).toUpperCase() !== 'FALSE';
    if (!type || !code || !active) return result;
    if (!result[type]) result[type] = [];
    result[type].push({ Code: code, DisplayName: String(record.DisplayName || code), SortOrder: record.SortOrder, Active: true });
    return result;
  }, {});
}
