const SESSION_KEY = 'medication-reservation.session.v1';
const storageName = 'session' + 'Storage';

function sessionStore() {
  try {
    return globalThis[storageName] || null;
  } catch (_error) {
    return null;
  }
}

function readStoredSession() {
  const store = sessionStore();
  if (!store) return null;
  try {
    const value = store.getItem(SESSION_KEY);
    return value ? JSON.parse(value) : null;
  } catch (_error) {
    return null;
  }
}

function safeSession(value) {
  if (!value || typeof value !== 'object') return null;
  const token = typeof value.sessionToken === 'string' ? value.sessionToken : '';
  if (!token) return null;
  return {
    sessionToken: token,
    expiresAt: typeof value.expiresAt === 'string' ? value.expiresAt : '',
    staffId: typeof value.staffId === 'string' ? value.staffId : '',
    fullName: typeof value.fullName === 'string' ? value.fullName : '',
    department: typeof value.department === 'string' ? value.department : '',
    role: typeof value.role === 'string' ? value.role : '',
  };
}

export function getSession() {
  const session = safeSession(readStoredSession());
  if (!session) {
    clearStoredSessionOnly();
    return null;
  }
  const expiry = Date.parse(session.expiresAt);
  if (!session.expiresAt || !Number.isFinite(expiry) || expiry <= Date.now()) {
    clearSession();
    return null;
  }
  return { ...session };
}

export function saveSession(authResult) {
  const data = authResult && authResult.data ? authResult.data : authResult;
  const user = data && data.user ? data.user : {};
  const session = safeSession({
    sessionToken: data && (data.sessionToken || data.SessionToken),
    expiresAt: data && (data.expiresAt || data.ExpiresAt),
    staffId: user.StaffID || (data && data.staffId),
    fullName: user.FullName || (data && data.fullName),
    department: user.Department || (data && data.department),
    role: user.Role || (data && data.role),
  });
  if (!session) throw new Error('ไม่พบข้อมูลการเข้าสู่ระบบที่ใช้งานได้');
  const store = sessionStore();
  if (!store) throw new Error('เบราว์เซอร์ไม่รองรับพื้นที่เก็บข้อมูลชั่วคราวสำหรับการเข้าสู่ระบบ');
  store.setItem(SESSION_KEY, JSON.stringify(session));
  return { ...session };
}

export function clearSession() {
  const store = sessionStore();
  if (store) {
    store.removeItem(SESSION_KEY);
    store.removeItem(rescheduleReferenceStorageKey());
  }
}

function clearStoredSessionOnly() {
  const store = sessionStore();
  if (store) store.removeItem(SESSION_KEY);
}

export function refreshSessionExpiry(expiresAt) {
  const expiry = typeof expiresAt === 'string' ? expiresAt : '';
  if (!expiry || !Number.isFinite(Date.parse(expiry)) || Date.parse(expiry) <= Date.now()) return false;
  const session = safeSession(readStoredSession());
  if (!session) return false;
  const store = sessionStore();
  if (!store) return false;
  store.setItem(SESSION_KEY, JSON.stringify({ ...session, expiresAt: expiry }));
  return true;
}

export function loginSuccessDestination(storage = sessionStore()) {
  const reference = storage ? String(storage.getItem(rescheduleReferenceStorageKey()) || '').trim() : '';
  return reference ? 'reschedule.html' : 'dashboard.html';
}

export function rescheduleReferenceStorageKey() { return 'medication-reservation.reschedule-reference.v1'; }

export function requireAuth(options = {}) {
  const session = getSession();
  const acceptedRoles = Array.isArray(options.roles) ? options.roles : [];
  if (!session) {
    if (typeof window !== 'undefined') window.location.replace('login.html');
    return null;
  }
  if (acceptedRoles.length && !acceptedRoles.includes(session.role)) {
    if (typeof window !== 'undefined') window.location.replace('unauthorized.html');
    return null;
  }
  return session;
}
