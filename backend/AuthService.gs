/**
 * LOGIN is exempt from business-mutation idempotent replay: a raw session
 * token is returned once and cannot be safely persisted for replay.
 */
function login_(payload, requestId) {
  payload = payload && typeof payload === 'object' ? payload : {};
  const staffId = String(payload.staffId || '').trim();
  const pin = typeof payload.pin === 'string' ? payload.pin : '';
  const user = findUserByStaffId_(staffId);
  const activeUser = userIsActive_(user) ? user : null;
  assertLoginAttemptAllowed_(activeUser, requestId);
  // PIN verification is intentionally outside every Apps Script lock.
  const hashMatches = verifyPinHash_(pin, activeUser ? activeUser.PINHash : loginDummyPinHash_());
  const verified = Boolean(activeUser) && hashMatches;
  const outcome = recordLoginAttempt_(activeUser, verified, requestId);
  if (outcome.throttled) throw loginThrottleError_(outcome.retryAfterSeconds);
  if (!verified) throw new ApiError_('INVALID_CREDENTIALS', 'Invalid staff ID or PIN.');
  const created = createSession_(staffId);
  const identity = trustedIdentity_(user);
  delete identity.PINHash;
  return { sessionToken: created.rawToken, expiresAt: created.expiresAt, user: identity, requestId: requestId };
}

function assertLoginAttemptAllowed_(user, requestId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date();
    const globalState = readGlobalLoginThrottleState_();
    const identityState = user ? loginThrottleStateFromUser_(user) : null;
    const retryAfter = user ? loginRetryAfterSeconds_(identityState, now) : loginRetryAfterSeconds_(globalState, now);
    if (retryAfter > 0) {
      writeLoginAuditSafe_(user, requestId, 'THROTTLED', { retryAfterSeconds: retryAfter });
      throw loginThrottleError_(retryAfter);
    }
  } catch (error) {
    if (error && error.name === 'ApiError') throw error;
    throw loginThrottleError_(60);
  } finally {
    lock.releaseLock();
  }
}

function recordLoginAttempt_(user, verified, requestId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const now = new Date();
    const globalState = readGlobalLoginThrottleState_();
    const identityState = user ? loginThrottleStateFromUser_(findUserByStaffId_(user.StaffID) || user) : null;
    const concurrentRetry = user ? loginRetryAfterSeconds_(identityState, now) : loginRetryAfterSeconds_(globalState, now);
    if (concurrentRetry > 0) {
      writeLoginAuditSafe_(user, requestId, 'THROTTLED', { retryAfterSeconds: concurrentRetry });
      return { throttled: true, retryAfterSeconds: concurrentRetry };
    }
    if (verified) {
      if (user) updateRecordByKey_('Users', 'StaffID', user.StaffID, {
        FailedLoginWindowStartedAt: '', FailedLoginCount: 0, LoginLockedUntil: '', LastFailedLoginAt: '',
      });
      writeLoginAuditSafe_(user, requestId, 'SUCCESS', {});
      return { throttled: false, retryAfterSeconds: 0 };
    }

    let nextGlobal = globalState;
    if (user) {
      const nextIdentity = incrementLoginThrottleState_(identityState, loginIdentityFailureLimit_(), now);
      updateRecordByKey_('Users', 'StaffID', user.StaffID, {
        FailedLoginWindowStartedAt: nextIdentity.windowStartedAt,
        FailedLoginCount: nextIdentity.failureCount,
        LoginLockedUntil: nextIdentity.lockedUntil,
        LastFailedLoginAt: nextIdentity.lastFailureAt,
      });
    } else {
      nextGlobal = incrementLoginThrottleState_(globalState, loginGlobalFailureLimit_(), now);
      writeGlobalLoginThrottleState_(nextGlobal, now);
    }
    writeLoginAuditSafe_(user, requestId, 'FAILURE', {
      identityKnown: Boolean(user),
      globalFailureCount: nextGlobal.failureCount,
    });
    return { throttled: false, retryAfterSeconds: 0 };
  } catch (error) {
    if (error && error.name === 'ApiError') throw error;
    throw loginThrottleError_(60);
  } finally {
    lock.releaseLock();
  }
}

function readGlobalLoginThrottleState_() {
  const rows = readRecords_('Settings', { predicate: function (row) {
    return String(row.Key || '') === 'LOGIN_GLOBAL_THROTTLE_STATE';
  }, limit: 1 });
  if (!rows.length || !String(rows[0].Value || '').trim()) return emptyLoginThrottleState_();
  try {
    const parsed = JSON.parse(String(rows[0].Value));
    return normalizeLoginThrottleState_(parsed);
  } catch (_ignored) {
    throw new Error('Global login throttle state is invalid.');
  }
}

function writeGlobalLoginThrottleState_(state, now) {
  const value = JSON.stringify(normalizeLoginThrottleState_(state));
  const updated = updateRecordByKey_('Settings', 'Key', 'LOGIN_GLOBAL_THROTTLE_STATE', {
    Value: value, UpdatedAt: (now || new Date()).toISOString(), UpdatedBy: 'SYSTEM',
  });
  if (!updated) {
    appendRecords_('Settings', [{
      Key: 'LOGIN_GLOBAL_THROTTLE_STATE', Value: value,
      Description: 'Runtime global login throttle state; operator managed through recovery helpers only',
      UpdatedAt: (now || new Date()).toISOString(), UpdatedBy: 'SYSTEM',
    }]);
  }
}

function loginThrottleStateFromUser_(user) {
  return normalizeLoginThrottleState_({
    windowStartedAt: user && user.FailedLoginWindowStartedAt,
    failureCount: user && user.FailedLoginCount,
    lockedUntil: user && user.LoginLockedUntil,
    lastFailureAt: user && user.LastFailedLoginAt,
  });
}

function emptyLoginThrottleState_() {
  return { windowStartedAt: '', failureCount: 0, lockedUntil: '', lastFailureAt: '' };
}

function normalizeLoginThrottleState_(value) {
  const state = value && typeof value === 'object' ? value : {};
  const count = Number(state.failureCount || 0);
  return {
    windowStartedAt: String(state.windowStartedAt || ''),
    failureCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
    lockedUntil: String(state.lockedUntil || ''),
    lastFailureAt: String(state.lastFailureAt || ''),
  };
}

function incrementLoginThrottleState_(state, limit, now) {
  const current = normalizeLoginThrottleState_(state);
  const windowMs = loginFailureWindowMinutes_() * 60 * 1000;
  const started = new Date(current.windowStartedAt).getTime();
  const reset = !isFinite(started) || now.getTime() - started >= windowMs;
  const failureCount = (reset ? 0 : current.failureCount) + 1;
  return {
    windowStartedAt: reset ? now.toISOString() : current.windowStartedAt,
    failureCount: failureCount,
    lockedUntil: failureCount >= limit ? new Date(now.getTime() + loginLockoutMinutes_() * 60 * 1000).toISOString() : '',
    lastFailureAt: now.toISOString(),
  };
}

function loginRetryAfterSeconds_(state, now) {
  if (!state) return 0;
  const until = new Date(state.lockedUntil).getTime();
  return isFinite(until) && until > now.getTime() ? Math.max(1, Math.ceil((until - now.getTime()) / 1000)) : 0;
}

function boundedLoginSetting_(key, fallback, minimum, maximum) {
  const value = Number(getSetting_(key, String(fallback)));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? Math.floor(value) : fallback;
}

function loginIdentityFailureLimit_() { return boundedLoginSetting_('LOGIN_IDENTITY_FAILURE_LIMIT', 5, 2, 20); }
function loginGlobalFailureLimit_() { return boundedLoginSetting_('LOGIN_GLOBAL_FAILURE_LIMIT', 50, 10, 1000); }
function loginFailureWindowMinutes_() { return boundedLoginSetting_('LOGIN_FAILURE_WINDOW_MINUTES', 15, 1, 1440); }
function loginLockoutMinutes_() { return boundedLoginSetting_('LOGIN_LOCKOUT_MINUTES', 15, 1, 1440); }

function loginDummyPinHash_() {
  return ['HMAC-SHA256$v2$', new Array(23).join('A'), '$', new Array(44).join('A')].join('');
}

function loginThrottleError_(retryAfterSeconds) {
  const error = new ApiError_('LOGIN_THROTTLED', 'Invalid staff ID or PIN.');
  error.retryAfterSeconds = Math.max(1, Math.min(86400, Math.ceil(Number(retryAfterSeconds) || 60)));
  return error;
}

function writeLoginAuditSafe_(user, requestId, result, detail) {
  try {
    writeAudit_({
      StaffID: user ? String(user.StaffID || '') : '',
      Role: user ? String(user.Role || '') : '',
      Department: user ? String(user.Department || '') : '',
      Action: 'LOGIN', RequestID: String(requestId || ''), Result: result,
      Detail: JSON.stringify(detail || {}),
    });
  } catch (_ignored) {}
}

/** Operator-only recovery helper. This function is intentionally not an API action. */
function unlockLoginIdentity(staffId) {
  const normalized = String(staffId || '').trim();
  if (!normalized) throw new Error('StaffID is required.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const user = findUserByStaffId_(normalized);
    if (!user) return { unlocked: false };
    const updated = updateRecordByKey_('Users', 'StaffID', normalized, {
      FailedLoginWindowStartedAt: '', FailedLoginCount: 0, LoginLockedUntil: '', LastFailedLoginAt: '',
    });
    if (!updated) throw new Error('Login identity could not be unlocked.');
    try {
      writeAudit_({ StaffID: normalized, Role: 'SYSTEM', Department: String(user.Department || ''), Action: 'UNLOCK_LOGIN_IDENTITY', Result: 'SUCCESS', Detail: 'Operator recovery helper' });
    } catch (_ignored) {}
    return { unlocked: true };
  } finally {
    lock.releaseLock();
  }
}

/** Operator-only recovery helper for a global denial-of-service lockout. */
function unlockGlobalLoginThrottle() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    writeGlobalLoginThrottleState_(emptyLoginThrottleState_(), new Date());
    try { writeAudit_({ StaffID: 'SYSTEM', Role: 'SYSTEM', Action: 'UNLOCK_GLOBAL_LOGIN_THROTTLE', Result: 'SUCCESS', Detail: 'Operator recovery helper' }); } catch (_ignored) {}
    return { unlocked: true };
  } finally {
    lock.releaseLock();
  }
}
