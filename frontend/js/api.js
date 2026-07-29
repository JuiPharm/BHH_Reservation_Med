import { API_URL } from './config.js';
import { clearSession, getSession, refreshSessionExpiry } from './session.js';
const DEFAULT_TIMEOUT_MS = 30000;
export class ApiRequestError extends Error {
  constructor(message, errorCode = 'NETWORK_ERROR', details = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.errorCode = errorCode;
    Object.assign(this, details);
  }
}

export function createRequestId() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function parseBody(text) {
  const trimmed = String(text || '').trim();
  const candidates = [trimmed];
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_error) {
      // Apps Script can redirect once before returning the JSON text.
    }
  }
  throw new ApiRequestError('การตอบกลับจากบริการไม่อยู่ในรูปแบบที่รองรับ', 'INVALID_RESPONSE');
}

function expiredSession(error) {
  if (error && error.errorCode === 'SESSION_EXPIRED') {
    clearSession();
    if (typeof window !== 'undefined' && !window.location.pathname.endsWith('/login.html')) {
      window.location.replace('login.html');
    }
  }
  return error;
}

export async function apiRequest(action, payload = {}, options = {}) {
  const endpoint = String(API_URL || '').trim();
  if (!endpoint) {
    throw new ApiRequestError('ยังไม่ได้ตั้งค่า URL ของบริการ กรุณาตั้งค่า config.js ก่อนใช้งาน', 'SETUP_REQUIRED');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const savedSession = getSession();
  const requestId = options.requestId || createRequestId();
  const method = options.method === 'GET' ? 'GET' : 'POST';
  const envelope = {
    action,
    requestId,
    payload: payload && typeof payload === 'object' ? payload : {},
  };
  const sessionToken = options.sessionToken || (savedSession && savedSession.sessionToken);
  if (sessionToken) envelope.sessionToken = sessionToken;
  const requestUrl = method === 'GET'
    ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}${new URLSearchParams({ action, requestId, payload: JSON.stringify(envelope.payload) }).toString()}`
    : endpoint;
  try {
    const requestOptions = {
      method,
      mode: 'cors',
      redirect: 'follow',
      signal: controller.signal,
    };
    if (method === 'POST') {
      requestOptions.headers = { 'Content-Type': 'text/plain;charset=utf-8' };
      requestOptions.body = JSON.stringify(envelope);
    }
    const response = await fetch(requestUrl, requestOptions);
    const body = parseBody(await response.text());
    if (!response.ok && body.success !== false) {
      throw new ApiRequestError('ไม่สามารถติดต่อบริการได้ในขณะนี้', 'HTTP_ERROR', { status: response.status, requestId });
    }
    if (!body.success) {
      throw expiredSession(new ApiRequestError(body.message || 'ไม่สามารถดำเนินการได้', body.errorCode || 'REQUEST_FAILED', {
        errors: Array.isArray(body.errors) ? body.errors : [],
        retryAfterSeconds: Number.isFinite(Number(body.retryAfterSeconds)) ? Number(body.retryAfterSeconds) : undefined,
        requestId: body.requestId || requestId,
      }));
    }
    if (body.sessionExpiresAt) refreshSessionExpiry(body.sessionExpiresAt);
    return { ...body, requestId: body.requestId || requestId };
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new ApiRequestError('การเชื่อมต่อใช้เวลานานเกินกำหนด กรุณาลองใหม่', 'REQUEST_TIMEOUT', { requestId });
    }
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError('ไม่สามารถเชื่อมต่อบริการได้ กรุณาตรวจสอบเครือข่ายแล้วลองใหม่', 'NETWORK_ERROR', { requestId });
  } finally {
    clearTimeout(timeout);
  }
}
