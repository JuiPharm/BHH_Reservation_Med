import { apiRequest } from './api.js';

const cache = new Map();

function cleanTypes(types) {
  return [...new Set((Array.isArray(types) ? types : [types]).map((type) => String(type || '').trim()).filter(Boolean))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function loadMasterData(types, request = apiRequest) {
  const wanted = cleanTypes(types);
  const missing = wanted.filter((type) => !cache.has(type));
  if (missing.length) {
    const response = await request('GET_MASTER_DATA', { types: missing });
    const data = response && response.data && typeof response.data === 'object' ? response.data : {};
    missing.forEach((type) => cache.set(type, Array.isArray(data[type]) ? data[type] : []));
  }
  return wanted.reduce((result, type) => ({ ...result, [type]: clone(cache.get(type) || []) }), {});
}

export function clearMasterDataCache() {
  cache.clear();
}
