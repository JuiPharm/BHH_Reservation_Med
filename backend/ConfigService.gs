const SETTINGS_CACHE_KEY_ = 'MEDICATION_RESERVATION_SETTINGS_V1';
const SETTINGS_CACHE_SECONDS_ = 300;

function getSettings_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(SETTINGS_CACHE_KEY_);
  if (cached) return JSON.parse(cached);
  const settings = readRecords_('Settings').reduce(function (result, record) {
    const key = String(record.Key || '').trim();
    if (key) result[key] = String(record.Value == null ? '' : record.Value);
    return result;
  }, {});
  cache.put(SETTINGS_CACHE_KEY_, JSON.stringify(settings), SETTINGS_CACHE_SECONDS_);
  return settings;
}

function getSetting_(key, fallbackValue) {
  const settings = getSettings_();
  return Object.prototype.hasOwnProperty.call(settings, key) ? settings[key] : fallbackValue;
}

function clearConfigurationCaches_() {
  const cache = CacheService.getScriptCache();
  cache.remove(SETTINGS_CACHE_KEY_);
  cache.remove(MASTER_DATA_CACHE_KEY_);
}
