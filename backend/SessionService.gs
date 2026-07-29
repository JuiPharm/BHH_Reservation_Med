function createSession_(staffId) {
  const rawToken = generateRandomToken_();
  const now = new Date();
  const timeoutMinutes = Math.max(1, Number(getSetting_('SESSION_TIMEOUT_MINUTES', '30')) || 30);
  const touchIntervalMinutes = sessionTouchIntervalMinutes_();
  const expiresAt = new Date(now.getTime() + timeoutMinutes * 60 * 1000).toISOString();
  const durableExpiresAt = new Date(now.getTime() + (timeoutMinutes + touchIntervalMinutes) * 60 * 1000).toISOString();
  appendRecords_('Sessions', [{
    SessionTokenHash: sha256Hex_(rawToken),
    StaffID: String(staffId),
    CreatedAt: now.toISOString(),
    ExpiresAt: durableExpiresAt,
    LastActiveAt: now.toISOString(),
    Active: 'TRUE',
  }]);
  return { rawToken: rawToken, expiresAt: expiresAt };
}

function requireSession_(token, options) {
  const rawToken = typeof token === 'string' ? token.trim() : '';
  if (!rawToken) throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  const tokenHash = sha256Hex_(rawToken);
  const sessions = readRecords_('Sessions', { predicate: function (session) { return String(session.SessionTokenHash || '') === tokenHash; }, limit: 1 });
  const session = sessions.length ? sessions[0] : null;
  const now = new Date();
  const timeoutMinutes = Math.max(1, Number(getSetting_('SESSION_TIMEOUT_MINUTES', '30')) || 30);
  const touchIntervalMinutes = sessionTouchIntervalMinutes_();
  const lastActiveAt = session ? new Date(session.LastActiveAt) : new Date(0);
  const expiresAt = session ? new Date(session.ExpiresAt) : new Date(0);
  const expired = !session || String(session.Active || '').toUpperCase() !== 'TRUE' || !isFinite(expiresAt.getTime()) || !isFinite(lastActiveAt.getTime()) || expiresAt <= now || now.getTime() - lastActiveAt.getTime() > (timeoutMinutes + touchIntervalMinutes) * 60 * 1000;
  if (expired) {
    if (session && String(session.Active || '').toUpperCase() === 'TRUE') updateRecordByKey_('Sessions', 'SessionTokenHash', tokenHash, { Active: 'FALSE' });
    throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  }
  const user = findUserByStaffId_(session.StaffID);
  if (!userIsActive_(user)) throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
  const touchRequested = !options || options.touch !== false;
  let activityAccepted = touchRequested && now.getTime() - lastActiveAt.getTime() < touchIntervalMinutes * 60 * 1000;
  let effectiveLastActiveAt = lastActiveAt;
  let effectiveDurableExpiresAt = expiresAt;
  const shouldTouch = touchRequested && !activityAccepted;
  if (shouldTouch) {
    const lock = LockService.getScriptLock();
    lock.waitLock(30000);
    try {
      const currentRows = readRecords_('Sessions', { predicate: function (current) {
        return String(current.SessionTokenHash || '') === tokenHash;
      }, limit: 1 });
      const current = currentRows.length ? currentRows[0] : null;
      const currentLastActiveAt = current ? new Date(current.LastActiveAt) : new Date(0);
      const currentExpiresAt = current ? new Date(current.ExpiresAt) : new Date(0);
      if (!current || String(current.Active || '').toUpperCase() !== 'TRUE'
        || !isFinite(currentLastActiveAt.getTime()) || !isFinite(currentExpiresAt.getTime())
        || currentExpiresAt <= now
        || now.getTime() - currentLastActiveAt.getTime() > (timeoutMinutes + touchIntervalMinutes) * 60 * 1000) {
        throw new ApiError_('SESSION_EXPIRED', 'Your session has expired.');
      }
      effectiveLastActiveAt = currentLastActiveAt;
      effectiveDurableExpiresAt = currentExpiresAt;
      if (now.getTime() - currentLastActiveAt.getTime() < touchIntervalMinutes * 60 * 1000) {
        activityAccepted = true;
      } else {
        const nextDurableExpiresAt = new Date(now.getTime() + (timeoutMinutes + touchIntervalMinutes) * 60 * 1000);
        const updated = updateRecordByKey_('Sessions', 'SessionTokenHash', tokenHash, {
          LastActiveAt: now.toISOString(),
          ExpiresAt: nextDurableExpiresAt.toISOString(),
        });
        if (updated) {
          activityAccepted = true;
          effectiveLastActiveAt = now;
          effectiveDurableExpiresAt = nextDurableExpiresAt;
        }
      }
    } finally {
      lock.releaseLock();
    }
  }
  const calculatedClientExpiresAt = activityAccepted
    ? new Date(now.getTime() + timeoutMinutes * 60 * 1000)
    : new Date(effectiveLastActiveAt.getTime() + timeoutMinutes * 60 * 1000);
  const clientExpiresAt = new Date(Math.min(calculatedClientExpiresAt.getTime(), effectiveDurableExpiresAt.getTime()));
  return {
    sessionTokenHash: tokenHash, session: session, user: trustedIdentity_(user),
    expiresAt: clientExpiresAt.toISOString(),
  };
}

function sessionTouchIntervalMinutes_() {
  const configured = Number(getSetting_('SESSION_TOUCH_INTERVAL_MINUTES', '2'));
  return Number.isFinite(configured) && configured >= 1 && configured <= 10 ? Math.floor(configured) : 2;
}

function logout_(context) {
  if (context && context.sessionTokenHash) updateRecordByKey_('Sessions', 'SessionTokenHash', context.sessionTokenHash, { Active: 'FALSE' });
  return { loggedOut: true };
}
